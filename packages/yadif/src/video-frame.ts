export interface FrameMetadata {
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  expectedDisplayTime: number;
  /**
   * `performance.timeOrigin` of the realm `now` and `expectedDisplayTime` were
   * measured against.
   *
   * There is more than one candidate. requestVideoFrameCallback() reports on
   * the clock of the window that owns the video node, which a document
   * picture-in-picture move replaces; the counter path below times its own
   * polling, on this module's realm. A consumer on a third clock -- the
   * rendering Worker -- cannot tell them apart, so each acquisition says which
   * it used and the timestamps stay convertible.
   */
  timeOrigin: number;
  /** The frame for this notification, valid only until the callback returns. */
  frame?: VideoFrame;
  /** Firefox counters supply identity and wall-clock cadence, not a frame PTS. */
  mozTiming?: { periodMs: number; discontinuity: boolean };
}

/** What requestVideoFrameCallback() itself reports; it supplies more. */
type NativeFrameMetadata = Omit<FrameMetadata, "timeOrigin" | "mozTiming">;

type FrameCallback = (now: number, metadata: FrameMetadata) => void;

interface MozVideo extends HTMLVideoElement {
  readonly mozParsedFrames: number;
  readonly mozDecodedFrames: number;
  readonly mozPresentedFrames: number;
  readonly mozPaintedFrames: number;
}

const COUNTERS = [
  "mozParsedFrames",
  "mozDecodedFrames",
  "mozPresentedFrames",
  "mozPaintedFrames",
] as const;

function hasMozFrames(video: HTMLVideoElement): video is MozVideo {
  return COUNTERS.every((name) => name in video);
}

/**
 * The clock requestVideoFrameCallback() reports on: the one belonging to the
 * window that owns the video node, which is not this module's realm once a
 * document picture-in-picture window has adopted the element.
 */
function acquisitionTimeOrigin(video: HTMLVideoElement): number {
  return (
    video.ownerDocument?.defaultView?.performance.timeOrigin ??
    performance.timeOrigin
  );
}

export function supportsVideoFrames(): boolean {
  return (
    typeof HTMLVideoElement !== "undefined" &&
    (hasMozFrames(HTMLVideoElement.prototype) ||
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback ===
        "function")
  );
}

/** Average across several refreshes instead of mistaking 60 Hz jitter for 60p. */
const MEASURE_MS = 250;
const STALL_MS = 500;

/**
 * One outstanding, cancellable frame request. Prefer Firefox's counters even
 * when native rVFC exists: its notifications/mediaTime can advance in 40 ms
 * steps. Parsed/decoded frames include read-ahead, and presented frames are
 * accounted by the media sink separately from painting. Only painted advances
 * the texture ring; OR-ing the counters would ingest one picture repeatedly.
 *
 * https://searchfox.org/firefox-main/source/dom/media/mediaelement/HTMLVideoElement.cpp
 */
export class VideoFrames {
  readonly #video: HTMLVideoElement;
  readonly #takeFrame: (() => VideoFrame | null | undefined) | undefined;
  readonly #moz: MozVideo | null;
  #handle: number | null = null;
  #callback: FrameCallback | null = null;
  #counters: number[] | null = null;
  #painted: number | null = null;
  #delivered = false;
  #discontinuity = true;
  #lastAt: number | null = null;
  #sample: { at: number; frames: number } | null = null;
  #periodMs = 0;
  readonly #canCapture: boolean;
  #capture: boolean;
  #captureTimer: (() => void) | null = null;
  #captureDocument: Document | null = null;
  #nativeHandle: number | null = null;
  #capturedTimestamp: number | null = null;
  #captureCount = 0;
  #captureDeltas: number[] = [];
  #pending: { frame: VideoFrame; at: number; count: number }[] = [];

  constructor(
    video: HTMLVideoElement,
    takeFrame?: () => VideoFrame | null | undefined,
  ) {
    this.#video = video;
    this.#takeFrame = takeFrame;
    this.#moz = hasMozFrames(video) ? video : null;
    this.#canCapture = typeof VideoFrame !== "undefined";
    this.#capture = this.#canCapture && video.playbackRate > 1;
    if (this.#moz) {
      for (const event of ["emptied", "seeking", "seeked"])
        video.addEventListener(event, this.#reset);
      for (const event of ["pause", "playing", "waiting", "ratechange"])
        video.addEventListener(event, this.#resetTiming);
    }
    if (this.#canCapture) {
      // Suspend acquisition while paused and request fresh frames after seeking or resuming.
      for (const event of [
        "loadeddata",
        "playing",
        "pause",
        "ended",
        "seeking",
        "seeked",
        "emptied",
        "ratechange",
      ])
        video.addEventListener(event, this.#captureChanged);
    }
  }

  /** Whether acquisition runs off the Firefox counters. */
  get mozDriven(): boolean {
    return this.#moz !== null && !this.#capture;
  }

  /** Whether frequent capture is active, excluding fallback notifications based on video.currentTime. */
  get captureDriven(): boolean {
    return this.#capture;
  }

  /** Whether any frame has been delivered yet (counters proven live). */
  get hasDelivered(): boolean {
    return this.#delivered;
  }

  request(callback: FrameCallback): void {
    if (this.#callback !== null) return;
    this.#callback = callback;
    if (this.#capture) {
      this.#armCapture();
      return;
    }
    this.#handle = this.#moz
      ? requestAnimationFrame(this.#poll)
      : this.#video.requestVideoFrameCallback(this.#present);
  }

  cancel(): void {
    if (this.#handle !== null) {
      if (this.#moz) cancelAnimationFrame(this.#handle);
      else this.#video.cancelVideoFrameCallback(this.#handle);
    }
    this.#handle = null;
    this.#callback = null;
    this.#captureTimer?.();
    this.#captureTimer = null;
    if (this.#nativeHandle !== null)
      this.#video.cancelVideoFrameCallback(this.#nativeHandle);
    this.#nativeHandle = null;
    this.#clearCaptured();
    this.#capturedTimestamp = null;
    this.#captureDeltas = [];
    this.#reset();
  }

  destroy(): void {
    this.cancel();
    for (const event of ["emptied", "seeking", "seeked"])
      this.#video.removeEventListener(event, this.#reset);
    for (const event of ["pause", "playing", "waiting", "ratechange"])
      this.#video.removeEventListener(event, this.#resetTiming);
    for (const event of [
      "loadeddata",
      "playing",
      "pause",
      "ended",
      "seeking",
      "seeked",
      "emptied",
      "ratechange",
    ])
      this.#video.removeEventListener(event, this.#captureChanged);
  }

  /** Deliver pending input on the rendering window's refresh, before drawing. */
  flush(now: number): void {
    if (!this.#capture) return;
    if (this.#video.ownerDocument !== this.#captureDocument) {
      this.#captureTimer?.();
      this.#captureTimer = null;
      this.#armCapture();
    }
    while (this.#pending.length > 0 && this.#callback !== null) {
      const captured = this.#pending.shift()!;
      const frame = captured.frame;
      try {
        this.#deliver(now, {
          width: frame.visibleRect?.width ?? frame.codedWidth,
          height: frame.visibleRect?.height ?? frame.codedHeight,
          mediaTime: frame.timestamp / 1e6,
          presentedFrames: captured.count,
          expectedDisplayTime: captured.at,
          timeOrigin: performance.timeOrigin,
          frame,
        });
      } finally {
        // The receiver has cloned any frame sent to a Worker, so the original can now be closed.
        frame.close();
      }
    }
  }

  #clearCaptured(): void {
    for (const captured of this.#pending) captured.frame.close();
    this.#pending = [];
  }

  #captureChanged = (event: Event): void => {
    const capture = this.#canCapture && this.#video.playbackRate > 1;
    if (capture !== this.#capture) {
      const callback = this.#callback;
      this.cancel();
      this.#capture = capture;
      if (callback !== null) this.request(callback);
      return;
    }
    if (!this.#capture) return;
    if (event.type === "pause" || event.type === "ended")
      this.flush(performance.now());
    this.#clearCaptured();
    if (["seeking", "seeked", "emptied", "ratechange"].includes(event.type)) {
      this.#capturedTimestamp = null;
      this.#captureDeltas = [];
    }
    this.#captureTimer?.();
    this.#captureTimer = null;
    if (this.#callback !== null) this.#armCapture();
  };

  #armCapture(): void {
    if (this.#captureTimer !== null || this.#callback === null) return;
    if (
      (this.#video.paused || this.#video.ended) &&
      this.#capturedTimestamp !== null
    )
      return;
    if (
      this.#nativeHandle === null &&
      typeof this.#video.requestVideoFrameCallback === "function"
    )
      this.#nativeHandle = this.#video.requestVideoFrameCallback(
        this.#capturePresented,
      );
    // At up to 1.25x, capture the video element frequently enough to retain briefly available frames.
    const interval = Math.max(4, 8 / Math.max(1, this.#video.playbackRate));
    // After a picture-in-picture move, use the new window's timer to continue acquisition.
    // Cancel through the same window to avoid inheriting throttling from the hidden original window.
    const owner = this.#video.ownerDocument?.defaultView;
    this.#captureDocument = this.#video.ownerDocument;
    if (owner) {
      const handle = owner.setTimeout(this.#captureFrame, interval);
      this.#captureTimer = () => owner.clearTimeout(handle);
    } else {
      const handle = setTimeout(this.#captureFrame, interval);
      this.#captureTimer = () => clearTimeout(handle);
    }
  }

  #capturePresented = (): void => {
    this.#nativeHandle = null;
    this.#captureTimer?.();
    this.#captureTimer = null;
    this.#captureFrame();
  };

  #captureFrame = (): void => {
    this.#captureTimer = null;
    const video = this.#video;
    if (this.#callback === null) return;
    if (video.readyState < 2 || video.seeking) {
      this.#armCapture();
      return;
    }
    let frame: VideoFrame;
    let decoded = false;
    try {
      const captured = this.#takeFrame?.();
      if (captured === null) {
        this.#armCapture();
        return;
      }
      decoded = captured !== undefined;
      frame = captured ?? new VideoFrame(video);
    } catch (error) {
      // Immediately after loading, a frame may become available later than readyState indicates.
      if (
        !(error instanceof DOMException) ||
        error.name !== "InvalidStateError"
      )
        throw error;
      this.#armCapture();
      return;
    }
    if (frame.timestamp === this.#capturedTimestamp) {
      frame.close();
    } else {
      let steps = 1;
      if (this.#capturedTimestamp !== null) {
        const delta = frame.timestamp - this.#capturedTimestamp;
        if (delta > 1000 && delta < 250000) {
          // Count missing input from the median timestamp delta, independently of playback speed.
          this.#captureDeltas.push(delta);
          if (this.#captureDeltas.length > 7) this.#captureDeltas.shift();
          const ordered = [...this.#captureDeltas].sort((a, b) => a - b);
          const period = ordered[Math.floor(ordered.length / 2)]!;
          steps = Math.max(1, Math.round(delta / period));
        }
      }
      this.#capturedTimestamp = frame.timestamp;
      this.#captureCount += steps;
      // Schedule decoded frames by media time to keep acquisition timer jitter out of presentation.
      const at =
        performance.now() +
        (decoded
          ? ((frame.timestamp / 1e6 - video.currentTime) * 1000) /
            video.playbackRate
          : 0);
      this.#pending.push({ frame, at, count: this.#captureCount });
      // After a long rendering stall, retain the newest frames and signal losses through the counter gap.
      while (this.#pending.length > 4) this.#pending.shift()!.frame.close();
    }
    this.#armCapture();
  };

  #resetTiming = (): void => {
    this.#lastAt = null;
    this.#sample = null;
    this.#periodMs = 0;
  };

  #reset = (): void => {
    this.#counters = null;
    this.#painted = null;
    this.#discontinuity = true;
    this.#resetTiming();
  };

  /** Native acquisition: pass the report on, with the clock it was made on. */
  #present = (now: number, metadata: NativeFrameMetadata): void => {
    this.#deliver(now, {
      width: metadata.width,
      height: metadata.height,
      mediaTime: metadata.mediaTime,
      presentedFrames: metadata.presentedFrames,
      expectedDisplayTime: metadata.expectedDisplayTime,
      timeOrigin: acquisitionTimeOrigin(this.#video),
    });
  };

  #deliver = (now: number, metadata: FrameMetadata): void => {
    const callback = this.#callback;
    this.#handle = null;
    this.#callback = null;
    this.#delivered = true;
    callback?.(now, metadata);
  };

  #poll = (now: number): void => {
    const video = this.#moz!;
    const counters = COUNTERS.map((name) => video[name]);
    if (this.#counters?.some((value, i) => counters[i]! < value)) this.#reset();
    this.#counters = counters;
    const painted = video.mozPaintedFrames;
    const ready =
      !video.seeking &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;
    // A paused first/seeked frame may be drawable before it has been painted.
    // Accept it once; decode read-ahead alone never drives ongoing playback.
    const first =
      this.#painted === null &&
      (painted > 0 ||
        (video.paused &&
          (video.mozPresentedFrames > 0 || video.mozDecodedFrames > 0)));
    if (
      ready &&
      (first || (this.#painted !== null && painted !== this.#painted))
    ) {
      if (this.#lastAt !== null && now - this.#lastAt > STALL_MS) {
        this.#resetTiming();
        this.#discontinuity = true;
      }
      if (!video.paused && !video.ended) {
        const sample = this.#sample;
        if (sample && now - sample.at >= MEASURE_MS) {
          const frames = painted - sample.frames;
          if (frames > 0) {
            const period = (now - sample.at) / frames;
            if (period >= 4 && period <= 200) {
              this.#periodMs = this.#periodMs
                ? this.#periodMs + (period - this.#periodMs) * 0.25
                : period;
            }
          }
          this.#sample = null;
        }
        this.#sample ??= { at: now, frames: painted };
      }
      this.#lastAt = now;
      this.#painted = painted;
      const discontinuity = this.#discontinuity;
      this.#discontinuity = false;
      this.#deliver(now, {
        width: video.videoWidth,
        height: video.videoHeight,
        // Used only to select source scan/size metadata on the media timeline.
        // It is deliberately NOT used as the frame identity or field clock.
        mediaTime: video.currentTime,
        presentedFrames: painted,
        // The counters report no display time. The poll that found the frame
        // is the best stand-in, and it was taken on this module's clock --
        // not the video node's window, which may be a different one.
        expectedDisplayTime: now,
        timeOrigin: performance.timeOrigin,
        mozTiming: { periodMs: this.#periodMs, discontinuity },
      });
    } else {
      this.#handle = requestAnimationFrame(this.#poll);
    }
  };
}
