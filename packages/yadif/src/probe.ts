/**
 * Asking the machine whether it deinterlaces on its own.
 *
 * Some devices -- Android ones in particular, where the hardware decoder is
 * doing the work -- hand back frames that have already been deinterlaced.
 * Filtering those again is worse than not filtering at all: yadif would be
 * looking for combing in a picture that has none and softening what it finds.
 * There is nothing to ask about it, no capability to query, so this asks by
 * decoding: a clip of the worst combing a frame can hold goes in, and what
 * comes out either still has it or does not.
 *
 * What makes the answer trustworthy is that it is read back the same way the
 * deinterlacer reads its frames. Wherever the machine does its filtering --
 * in the decoder, or later on the way to the screen -- this sees exactly the
 * pixels the filter would be given. If they are woven, filtering them is the
 * right thing to do whatever the screen is showing; if they are not, there is
 * nothing left to filter.
 */
import { PROBE_CLIP } from "./probe-clip.js";

/**
 * How much of the woven pattern may be lost before the picture counts as
 * already deinterlaced. Halfway: a decoder that leaves the clip alone keeps
 * very nearly all of it, and anything that filters it takes very nearly all
 * of it away, so the answer is nowhere near this line.
 */
const DEFAULT_TOLERANCE = 0.5;

/** Long enough to decode six frames of it on anything worth playing video on. */
const DEFAULT_TIMEOUT_MS = 3000;

/** How far into the clip to look, so the frames either side of it exist. */
const SAMPLE_TIME = 0.1;

/** How many columns of the frame to read. The pattern is in the rows. */
const COLUMNS = 16;

export interface DecoderProbeOptions {
  /** See DEFAULT_TOLERANCE. Between 0 and 1. */
  tolerance?: number;
  /** How long to wait for the clip to decode before giving up on the answer. */
  timeoutMs?: number;
}

/** What came back from asking, measurement and all. */
export interface DecoderProbe {
  /** Whether this machine deinterlaces before a page sees the frames. */
  deinterlaces: boolean;
  /**
   * How much of the clip's alternating pattern was still there, from 0 to 1.
   * A machine that leaves the frames alone is at 1 and one that filters them
   * is at 0, so this says how far the answer was from being a close call.
   * Null where the probe could not be run at all.
   */
  survives: number | null;
  /** How long the asking took, in milliseconds. */
  tookMs: number;
  /** Why there is no measurement, where there is none. */
  error?: string;
}

let asked: Promise<DecoderProbe> | null = null;

/**
 * Ask whether this machine deinterlaces video before a page ever sees it.
 *
 * Asked once and remembered: the answer is a property of the machine, and the
 * decode behind it is not worth repeating. A page should ask before turning
 * the deinterlacer on. Applications can use this before enabling a filter.
 *
 * Anything that goes wrong comes back as `deinterlaces` false with the reason
 * in `error`, which is the safe way round: the picture then gets filtered,
 * which is what would have happened anyway. A page showing the result should
 * show the reason too -- an answer that could not be measured is worth knowing
 * about, and there is no other sign of one.
 */
export function probeDecoder(
  options: DecoderProbeOptions = {},
): Promise<DecoderProbe> {
  asked ??= measure(options);
  return asked;
}

/** The verdict on its own, for a caller that wants nothing else. */
export async function decoderDeinterlaces(
  options: DecoderProbeOptions = {},
): Promise<boolean> {
  return (await probeDecoder(options)).deinterlaces;
}

/** Forget the answer, for a page that wants it asked again. */
export function forgetDecoderProbe(): void {
  asked = null;
}

async function measure(options: DecoderProbeOptions): Promise<DecoderProbe> {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = performance.now();
  const failed = (error: unknown): DecoderProbe => ({
    deinterlaces: false,
    survives: null,
    tookMs: performance.now() - started,
    error: error instanceof Error ? error.message : String(error),
  });
  if (typeof document === "undefined") {
    return failed(new Error("there is no document to decode in"));
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = PROBE_CLIP;
  try {
    await deadline(event(video, "loadeddata"), timeoutMs);
    await settle(video, timeoutMs);
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      return failed(new Error("the probe clip decoded to nothing"));
    }
    const left = survives(video);
    return {
      deinterlaces: left < 1 - tolerance,
      survives: left,
      tookMs: performance.now() - started,
    };
  } catch (error) {
    return failed(error);
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * Get a frame from the middle of the clip on screen.
 *
 * Playing it is what a filter in the machine expects to be given -- a motion
 * adaptive one wants the frames either side of the one it is working on, and
 * a still it was seeked to may be woven back together untouched. Where
 * playback is not allowed to start, a seek is better than nothing.
 */
async function settle(
  video: HTMLVideoElement,
  timeoutMs: number,
): Promise<void> {
  try {
    await video.play();
    const started = performance.now();
    while (
      video.currentTime < SAMPLE_TIME &&
      performance.now() - started < timeoutMs
    ) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    video.pause();
  } catch {
    video.currentTime = SAMPLE_TIME;
    await deadline(event(video, "seeked"), timeoutMs);
  }
}

/**
 * How much of the alternating pattern is left, from 0 to 1.
 *
 * Only the rows matter, so the frame is drawn a few columns wide and full
 * height: no filtering touches it vertically, and the read back is a hundredth
 * of what a whole frame would be. Weaving leaves neighbouring rows as far
 * apart as the format allows; deinterlacing of any kind -- blending the two
 * fields, or throwing one away and doubling the other -- brings them together.
 */
function survives(video: HTMLVideoElement): number {
  const height = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = COLUMNS;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("there is no 2d context to read the clip with");
  context.imageSmoothingEnabled = false;
  context.drawImage(video, 0, 0, COLUMNS, height);
  // A tainted canvas throws here, and that comes back as a probe that could
  // not be run, which leaves the filter running.
  const pixels = context.getImageData(0, 0, COLUMNS, height).data;
  const row = (y: number): number => {
    let sum = 0;
    for (let x = 0; x < COLUMNS; x++)
      sum += pixels[(y * COLUMNS + x) * 4 + 1] ?? 0;
    return sum / COLUMNS;
  };
  let total = 0;
  // The first and last rows of a frame are where a filter has least to work
  // with and where a decoder's own edges land, so they are left out of it.
  const first = 2;
  const last = height - 3;
  let previous = row(first);
  for (let y = first + 1; y <= last; y++) {
    const current = row(y);
    total += Math.abs(current - previous);
    previous = current;
  }
  return total / (last - first) / 255;
}

function event(target: EventTarget, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener(name, () => resolve(), { once: true });
    target.addEventListener(
      "error",
      () => reject(new Error(`the probe clip ${name} failed`)),
      {
        once: true,
      },
    );
  });
}

function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error("the probe clip took too long")),
        timeoutMs,
      ),
    ),
  ]);
}
