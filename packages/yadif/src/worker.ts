/// <reference lib="webworker" />

import {
  createWorkerDeinterlacer,
  type DeinterlaceStats,
  type Deinterlacer,
} from "./deinterlace.js";
import type {
  WorkerCommand,
  WorkerNotification,
  WorkerRenderingOptions,
  WorkerVideoState,
} from "./worker-protocol.js";
import type {
  DiagnosticPictureMeta,
  PresentedPictureMeta,
  PresentationQueueMeta,
  QueuedPictureMeta,
} from "./deinterlace.js";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

/** 共通描画エンジンが読む media element の状態だけを再現する。 */
class WorkerVideo extends EventTarget {
  currentTime = 0;
  playbackRate = 1;
  seeking = false;
  paused = true;
  ended = false;
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  parentElement: HTMLElement | null = null;
  offsetWidth = 0;
  offsetHeight = 0;
  offsetLeft = 0;
  offsetTop = 0;
  #buffered: Array<{ start: number; end: number }> = [];

  /** フレームや media event を処理する前に、ページ側の状態を反映する。 */
  update(state: WorkerVideoState): void {
    this.currentTime = state.currentTime;
    this.playbackRate = state.playbackRate;
    this.seeking = state.seeking;
    this.paused = state.paused;
    this.ended = state.ended;
    this.readyState = state.readyState;
    this.videoWidth = state.videoWidth;
    this.videoHeight = state.videoHeight;
    this.#buffered = state.buffered;
  }

  get buffered(): TimeRanges {
    return {
      length: this.#buffered.length,
      start: (index: number) => {
        const range = this.#buffered[index];
        if (!range)
          throw new DOMException("Invalid range index", "IndexSizeError");
        return range.start;
      },
      end: (index: number) => {
        const range = this.#buffered[index];
        if (!range)
          throw new DOMException("Invalid range index", "IndexSizeError");
        return range.end;
      },
    };
  }

  getVideoPlaybackQuality(): VideoPlaybackQuality {
    return {
      creationTime: performance.now(),
      droppedVideoFrames: 0,
      totalVideoFrames: 0,
      corruptedVideoFrames: 0,
    };
  }

  requestVideoFrameCallback(): number {
    return 0;
  }

  cancelVideoFrameCallback(): void {}
}

let video: WorkerVideo | null = null;
let deinterlacer: Deinterlacer | null = null;
let destroying = false;
let queuedFrameWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;
let sinkChain: Promise<void> = Promise.resolve();
let sinkAnchorPerf: number | null = null;
let sinkAnchorMediaUs: number | null = null;
let sinkGeneration: number | null = null;

/** Worker 側で media-timeline pacing してから sink へ書込む。main-thread を介さない。 */
function sinkWrite(frame: VideoFrame, meta: QueuedPictureMeta, reportMeta: boolean): void {
  sinkChain = sinkChain
    .then(async () => {
      const writer = queuedFrameWriter;
      if (!writer) {
        frame.close();
        return;
      }
      const timestamp = Number.isFinite(frame.timestamp)
        ? Number(frame.timestamp)
        : Number(meta.mediaTimestampUs);
      if (sinkGeneration !== meta.generation) {
        sinkGeneration = meta.generation;
        sinkAnchorPerf = null;
        sinkAnchorMediaUs = null;
      }
      if (sinkAnchorPerf === null || sinkAnchorMediaUs === null) {
        sinkAnchorPerf = performance.now();
        sinkAnchorMediaUs = timestamp;
      }
      const due = sinkAnchorPerf + (timestamp - sinkAnchorMediaUs) / 1000;
      const wait = Math.max(0, due - performance.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        await writer.write(frame);
      } catch {
        try {
          frame.close();
        } catch {
          /* already closed */
        }
      }
      if (reportMeta) post({ type: "queuedMeta", meta });
    })
    .catch(() => {});
}

/** Worker が所有する requestAnimationFrame() へ共通描画エンジンの表示ループを接続する。 */
function requestWorkerAnimationFrame(callback: FrameRequestCallback): number {
  return workerScope.requestAnimationFrame(callback);
}

/** Worker 側で予約した表示機会を取り消す。 */
function cancelWorkerAnimationFrame(handle: number): void {
  workerScope.cancelAnimationFrame(handle);
}

/** このモジュールが所有する Worker 境界を通して通知を転送する。 */
function post(
  notification: WorkerNotification,
  transfer: Transferable[] = [],
): void {
  workerScope.postMessage(notification, transfer);
}

/** 初期化後にも変更できる設定を公開 setter 経由で反映する。 */
function applySettings(
  renderer: Deinterlacer,
  options: WorkerRenderingOptions,
): void {
  // diagnostic 要求は initialize 時の静的指定で、途中で切り替えない。
  renderer.doubleRate = options.doubleRate;
  renderer.autoFilm = options.autoFilm;
  renderer.filmCombThreshold = options.filmCombThreshold;
}

workerScope.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  try {
    if (command.type === "initialize") {
      if (typeof workerScope.requestAnimationFrame !== "function")
        throw new Error("requestAnimationFrame is unavailable in this Worker");
      queuedFrameWriter = command.queuedFrameSink
        ? command.queuedFrameSink.getWriter()
        : null;
      video = new WorkerVideo();
      video.update(command.video);
      // 診断要求がある場合だけ gate を作る。表示点または queue 前の要求では
      // 加工済み VideoFrame を transfer し、filter-only 要求では meta のみを送る。
      const diagnosticSink =
        command.options.diagnostic ||
        command.options.capturePresentedFrames ||
        command.options.captureQueuedFrames ||
        command.options.captureQueuedFrameFullSize ||
        command.options.capturePresentationQueue
          ? {
              onFilteredPicture: command.options.diagnostic
                ? (meta: DiagnosticPictureMeta) => {
                    if (!destroying) post({ type: "diagnostic", meta });
                  }
                : undefined,
              onPresentedFrame: command.options.capturePresentedFrames
                ? (frame: VideoFrame, meta: PresentedPictureMeta) => {
                    if (destroying) {
                      frame.close();
                      return;
                    }
                    try {
                      post({ type: "presented", frame, meta }, [frame]);
                    } catch {
                      frame.close();
                    }
                  }
                : undefined,
              onQueuedFrame: command.options.captureQueuedFrames || queuedFrameWriter
                ? (frame: VideoFrame, meta: QueuedPictureMeta) => {
                    if (destroying) {
                      frame.close();
                      return;
                    }
                    if (queuedFrameWriter) {
                      // Pace on the worker's own clock and write straight to the
                      // sink: no main-thread timer or frame transfer.
                      sinkWrite(frame, meta, command.options.captureQueuedMeta);
                      return;
                    }
                    try {
                      post({ type: "queued", frame, meta }, [frame]);
                    } catch {
                      frame.close();
                    }
                  }
                : undefined,
              onPresentationQueue: command.options.capturePresentationQueue
                ? (meta: PresentationQueueMeta) => {
                    if (!destroying) post({ type: "presentationQueue", meta });
                  }
                : undefined,
            }
          : undefined;
      deinterlacer = createWorkerDeinterlacer(
        video as unknown as HTMLVideoElement,
        command.canvas,
        {
          ...command.options,
          diagnostic: {
            ...diagnosticSink,
            bypassDisplayQueue: command.options.bypassDisplayQueue,
            captureQueuedFrameFullSize:
              command.options.captureQueuedFrameFullSize,
          },
        },
        (message) => {
          if (!destroying) post({ type: "failed", message });
        },
        (visible) => post({ type: "visibility", visible }),
        requestWorkerAnimationFrame,
        cancelWorkerAnimationFrame,
      );
      deinterlacer.addEventListener("stats", (statsEvent) => {
        const { dropped: _dropped, ...stats } = statsEvent.detail;
        post({ type: "stats", stats });
      });
      deinterlacer.scan = command.scan;
      deinterlacer.videoTimeline = command.videoTimeline;
      deinterlacer.enabled = command.enabled;
      post({ type: "ready" });
      return;
    }
    if (!video || !deinterlacer) return;
    switch (command.type) {
      case "frame":
        video.update(command.video);
        try {
          // ページと Worker の performance は時刻原点が一致する保証がないため、表示予定は描画ループと同じ Worker の時計で作る。
          deinterlacer.ingestExternalFrame(
            performance.now(),
            command.metadata,
            command.frame,
          );
        } finally {
          command.frame.close();
          post({ type: "consumed", id: command.id });
        }
        break;
      case "settings":
        applySettings(deinterlacer, command.options);
        break;
      case "scan":
        deinterlacer.scan = command.scan;
        break;
      case "timeline":
        deinterlacer.videoTimeline = command.videoTimeline;
        break;
      case "enabled":
        deinterlacer.enabled = command.enabled;
        break;
      case "event":
        video.update(command.video);
        video.dispatchEvent(new Event(command.name));
        break;
      case "capture":
        video.videoWidth = command.width;
        video.videoHeight = command.height;
        // seek 直後など再描画できる画像がない期間は null を返し、ページ側の実 video を capture する。
        void deinterlacer
          .capture()
          .then((image) =>
            post({ type: "capture", id: command.id, image }, [image]),
          )
          .catch(() => post({ type: "capture", id: command.id, image: null }));
        break;
      case "destroy":
        destroying = true;
        deinterlacer.destroy();
        deinterlacer = null;
        video = null;
        workerScope.close();
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "failed", message });
  }
};
