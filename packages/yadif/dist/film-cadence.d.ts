/** Broadcast frames in a pulldown cycle, and the film frames they hold. */
export declare const PULLDOWN_FRAMES = 5;
export declare const FILM_FRAMES = 4;
/**
 * How long after its frame arrives a film frame of each phase is shown, in
 * frame periods, so that the film frames come out 1.25 periods apart. Phase
 * 2 is whole only once the frame after it has arrived, so it goes up at
 * once and the others are held back to match. Phase 1 is the repeat.
 */
export declare const FILM_LEAD: Record<number, number>;
/** Which cadence a frame goes up at: one film frame, two fields, or one frame. */
export type Cadence = "film" | "field" | "frame";
/**
 * The cadence a frame is put up at.
 *
 * A locked film phase wins. Otherwise the mode is what it always was, so
 * turning `film` off, or never locking, leaves interlaced and progressive
 * playback exactly as they were.
 */
export declare function schedulingCadence(filmLocked: boolean, doubleRate: boolean): Cadence;
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
export declare function advancePulldownPhase(known: PulldownPhase, age: number): PulldownPhase | null;
/** Whether the frame at this phase repeats the one before it, and is dropped. */
export declare function isRepeatedFilmPhase(phase: number): boolean;
/**
 * When a film frame of this phase goes up, and how long it stands for.
 *
 * `shown` is the moment the frame reached the screen. The lead is what makes
 * four film frames in five broadcast frames come out evenly: at 30 frames a
 * second they land 1.25 frame periods apart, which is 24 a second.
 */
export declare function filmFrameTiming(phase: number, shown: number, periodMs: number): {
    at: number;
    duration: number;
};
//# sourceMappingURL=film-cadence.d.ts.map