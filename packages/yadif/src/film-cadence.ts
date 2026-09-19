/**
 * The cadence the deinterlacer puts film up at.
 *
 * A 2:3 pulldown carries 24 film frames a second in 30 broadcast frames: each
 * five-frame cycle holds four film frames, one of them repeated. The detector
 * reports which phase of that cycle a frame is; these functions turn a phase
 * into what the loop does with the frame, so the promise the `film` option
 * makes -- one repeated frame dropped and the rest evenly spaced -- can be
 * checked without a display.
 */
import { FILM_DUPLICATE_PHASE } from "./film-shader.js";

/** Broadcast frames in a pulldown cycle, and the film frames they hold. */
export const PULLDOWN_FRAMES = 5;
export const FILM_FRAMES = 4;

/**
 * How long after its frame arrives a film frame of each phase is shown, in
 * frame periods, so that the film frames come out 1.25 periods apart. Phase
 * 2 is whole only once the frame after it has arrived, so it goes up at
 * once and the others are held back to match. Phase 1 is the repeat.
 */
export const FILM_LEAD: Record<number, number> = {
  2: 0,
  3: 0.25,
  4: 0.5,
  5: 0.75,
};

/** Which cadence a frame goes up at: one film frame, two fields, or one frame. */
export type Cadence = "film" | "field" | "frame";

/**
 * The cadence a frame is put up at.
 *
 * A locked film phase wins. Otherwise the mode is what it always was, so
 * turning `film` off, or never locking, leaves interlaced and progressive
 * playback exactly as they were.
 */
export function schedulingCadence(
  filmLocked: boolean,
  doubleRate: boolean,
): Cadence {
  if (filmLocked) return "film";
  return doubleRate ? "field" : "frame";
}

/** A pulldown phase, and how many frames the detector has held it for. */
export interface PulldownPhase {
  phase: number;
  run: number;
}

/**
 * The phase of the frame being filtered, from the last phase read back and
 * how many frames ago it was for.
 *
 * Returns null when the detector has no phase yet, or when the reading is
 * older than a cycle and so says nothing about this frame.
 */
export function advancePulldownPhase(
  known: PulldownPhase,
  age: number,
): PulldownPhase | null {
  if (known.phase === 0 || age > PULLDOWN_FRAMES) return null;
  return {
    phase: ((known.phase - 1 + age) % PULLDOWN_FRAMES) + 1,
    run: known.run,
  };
}

/** Whether the frame at this phase repeats the one before it, and is dropped. */
export function isRepeatedFilmPhase(phase: number): boolean {
  return phase === FILM_DUPLICATE_PHASE;
}

/**
 * When a film frame of this phase goes up, and how long it stands for.
 *
 * `shown` is the moment the frame reached the screen. The lead is what makes
 * four film frames in five broadcast frames come out evenly: at 30 frames a
 * second they land 1.25 frame periods apart, which is 24 a second.
 */
export function filmFrameTiming(
  phase: number,
  shown: number,
  periodMs: number,
): { at: number; duration: number } {
  const duration = (periodMs * PULLDOWN_FRAMES) / FILM_FRAMES;
  const lead = FILM_LEAD[phase] ?? 0;
  return { at: shown + lead * periodMs, duration };
}
