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

  constructor(video: HTMLVideoElement) {
    this.#video = video;
    this.#moz = hasMozFrames(video) ? video : null;
    if (this.#moz) {
      for (const event of ["emptied", "seeking", "seeked"])
        video.addEventListener(event, this.#reset);
      for (const event of ["pause", "playing", "waiting", "ratechange"])
        video.addEventListener(event, this.#resetTiming);
    }
  }

  /** Whether acquisition runs off the Firefox counters. */
  get mozDriven(): boolean {
    return this.#moz !== null;
  }

  /** Whether any frame has been delivered yet (counters proven live). */
  get hasDelivered(): boolean {
    return this.#delivered;
  }

  request(callback: FrameCallback): void {
    if (this.#handle !== null) return;
    this.#callback = callback;
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
    this.#reset();
  }

  destroy(): void {
    this.cancel();
    for (const event of ["emptied", "seeking", "seeked"])
      this.#video.removeEventListener(event, this.#reset);
    for (const event of ["pause", "playing", "waiting", "ratechange"])
      this.#video.removeEventListener(event, this.#resetTiming);
  }

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
