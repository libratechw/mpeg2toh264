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
import { drainEngineTrace } from "./render-trace.js";

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
let traceTimer: number | null = null;

function flushRenderTrace(): void {
  const batch = drainEngineTrace();
  if (batch.events.length > 0 || batch.droppedEvents > 0)
    post({ type: "diagnostic-batch", batch });
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
      video = new WorkerVideo();
      video.update(command.video);
      deinterlacer = createWorkerDeinterlacer(
        video as unknown as HTMLVideoElement,
        command.canvas,
        command.options,
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
      traceTimer = workerScope.setInterval(flushRenderTrace, 250);
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
        if (traceTimer !== null) workerScope.clearInterval(traceTimer);
        traceTimer = null;
        flushRenderTrace();
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
