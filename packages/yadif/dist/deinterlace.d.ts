/**
 * How the filter is getting on, and where it is being let down.
 *
 * A deinterlacer is only as good as the frames it is given. yadif reads the
 * frame either side of the one it is filtering, and every count here that is
 * not `filtered` is a way of not having them: a frame the callback never saw
 * leaves the two neighbours two frames apart, and one filtered against a copy
 * of itself has no motion to measure at all. Both show up as combing that
 * comes and goes, which is worth being able to point at rather than guess at.
 */
export interface DeinterlaceStats {
    /** Frames filtered with a real frame on either side: the good case. */
    filtered: number;
    /**
     * Frames the element presented that the filter never saw, counted from the
     * gaps in `presentedFrames`. The neighbours of the frames either side of a
     * gap are further apart in time than the filter believes, so its idea of
     * what moved is wrong. A page that sees this climbing is asking the filter
     * to keep up with more than it can.
     */
    missed: number;
    /**
     * Frames the browser decoded and threw away without presenting, as the
     * element itself counts them. This is the machine being behind rather than
     * this filter: it happens with the deinterlacer off as well.
     */
    dropped: number;
    /**
     * Frames filtered with a copy of themselves standing in for a neighbour,
     * which is the start of a stream, the frame a seek lands on, and the last
     * frame before playback stops. Expected in ones and twos; a stream of them
     * means the held frames keep being thrown away.
     */
    degraded: number;
    /** Times the held frames were dropped as stale: seeks, and stream changes. */
    discontinuities: number;
    /**
     * Filtered pictures that were never shown, because an animation frame did
     * not come round while their moment was still ahead, or because the clock
     * they were timed by turned out to be somewhere else.
     *
     * Only a picture for every field can have these -- a picture for every frame
     * goes up as its frame arrives -- and they are the page being too busy to
     * keep a field rate rather than anything the filter did. A few are a hiccup,
     * and one every few seconds is a display whose refresh rate the field rate
     * does not divide into. A steady stream of them is a machine that cannot
     * show fields at all, and turning `doubleRate` off is the answer.
     */
    late: number;
    /** Frames presented per second over the last report. */
    fps: number;
    /**
     * What one frame costs, in milliseconds, averaged over the last report:
     * uploading it, filtering the picture or pair of pictures built from it, and
     * putting them up. This is the time on the page's own thread -- the GPU's
     * part of the draw is not in it -- so it is the measure of what the
     * deinterlacer takes away from everything else.
     */
    frameMs: number;
    /** The render path currently selected by automatic cadence detection. */
    mode: "film" | "video";
    /** The field match selected for the most recently analysed frame. */
    match: "p" | "c" | "n";
    /** Largest 16 by 16 block count of vertically adjacent combed pixels. */
    combScore: number;
    /** Pictures actually copied to the canvas per second. */
    outputFps: number;
    /** Mean 8-bit sample difference of the strongest duplicate phase. */
    duplicateScore: number;
    /** Mean 8-bit sample difference of the next-best duplicate phase. */
    duplicateRunnerUp: number;
}
export interface DeinterlacerOptions {
    /**
     * Whether the top field of a frame is the one captured first. True for every
     * MPEG-2 broadcast format worth the name, which is why it is the default;
     * getting it wrong makes motion jerk back and forth by a field.
     */
    topFieldFirst?: boolean;
    /**
     * Whether to show a picture for every field rather than for every frame.
     *
     * Interlaced video carries two moments in each frame, and one output frame
     * per input frame throws the second one away: motion that was captured
     * fifty or sixty times a second is shown twenty-five or thirty. With this
     * on, each frame is filtered twice -- once keeping the field that came
     * first and once keeping the other -- and the second picture is put up half
     * a frame after the first, which is the moment it was taken at. Motion is
     * as smooth as the broadcast was, at twice the filtering.
     *
     * It needs a display that can show them: at 59.94 fields a second there is
     * one refresh of a 60 Hz screen for each, and nothing to spare.
     *
     * With `spatialCheck`, this is which of yadif's four modes runs: off/on is
     * `send_frame`, on/on is `send_field`, and the two with `spatialCheck` off
     * are the `nospatial` pair.
     */
    doubleRate?: boolean;
    /**
     * Whether hard-telecined film is reconstructed and shown at its native
     * 24000/1001 cadence. Two clean p/c/n field-match cycles must contain one
     * stable duplicate phase before film mode starts. A high-comb frame returns
     * to yadif so live action and commercial breaks retain field-rate motion.
     */
    autoFilm?: boolean;
    /**
     * Largest combed-pixel block count accepted as a clean film field match.
     * The default 80 matches FFmpeg fieldmatch's `combpel` default. Duplicate
     * cadence must still be established independently before film mode starts.
     */
    filmCombThreshold?: number;
    /**
     * How many field intervals of slack to hold a picture for every field back
     * by, on top of the half a frame the second field is late by anyway.
     *
     * Every filtered field waits in a queue for the animation frame nearest the
     * moment it stands for. This is how much of the wait is spare: how late the
     * callback announcing a frame may be before the fields built from it have
     * already missed their turn. One field interval -- around 17 ms of a 1080i
     * broadcast -- covers a callback that slipped a refresh, which is what a
     * page under any load at all does now and again, and it is the default.
     *
     * Zero shows each field at the earliest moment it could be shown at, which
     * is the least delay and the least tolerance. Raising it past one or two
     * buys nothing a viewer will see and costs delay a viewer might.
     *
     * It affects the queued field-rate output from `doubleRate` and the queued
     * native-cadence output from `autoFilm`. With both features off, a frame's
     * one picture goes up as the frame after it arrives and nothing is queued.
     */
    bufferFields?: number;
    /**
     * Whether to let the local vertical range widen what the temporal check
     * allows. This is yadif's default and its `nospatial` mode turns it off.
     */
    spatialCheck?: boolean;
    /**
     * Called about once a second while frames are arriving, and not at all while
     * nothing is playing -- there is nothing to say about a filter that is not
     * being asked for anything.
     */
    onStats?(stats: DeinterlaceStats): void;
}
/** Field information supplied by a player or another video source. */
export interface Scan {
    interlaced: boolean;
    topFieldFirst: boolean;
}
export interface VideoState {
    start: number;
    codedSize?: {
        width: number;
        height: number;
    };
    scan?: Scan;
}
/** Whether this browser has the two things the deinterlacer is built on. */
export declare function supportsDeinterlace(): boolean;
/**
 * Puts a deinterlaced copy of a `<video>` over the top of it.
 *
 * ```ts
 * const deinterlacer = new Deinterlacer(video);
 * deinterlacer.start();
 * ```
 *
 * `start()` wraps the element in a positioned `<div>` and adds a canvas over
 * it. The canvas takes no pointer events, so anything the page put on the
 * element still works, but it does cover the element's own controls; a page
 * that wants controls with this on has to draw them itself. `stop()` hides the
 * canvas again, which is all it takes to compare the two.
 */
export declare class Deinterlacer {
    #private;
    readonly canvas: HTMLCanvasElement;
    constructor(video: HTMLVideoElement, options?: DeinterlacerOptions);
    get running(): boolean;
    /** Whether the caller wants filtering, independently of the current source. */
    get enabled(): boolean;
    set enabled(enabled: boolean);
    /** Update whether the source needs filtering and which field comes first. */
    set scan(scan: Scan | null);
    get scan(): Scan | null;
    set videoTimeline(timeline: readonly VideoState[]);
    get videoTimeline(): readonly VideoState[];
    /**
     * What to put on the screen for fullscreen: the `<div>` holding both the
     * element and the canvas once there is one, and the element itself before
     * that. Fullscreening the element alone would leave the canvas behind in
     * the page, and with it the only deinterlaced picture there is.
     */
    get container(): HTMLElement;
    /** Whether the top field of a frame is the one captured first. */
    get topFieldFirst(): boolean;
    set topFieldFirst(topFieldFirst: boolean);
    /** Whether a picture goes up for every field rather than every frame. */
    get doubleRate(): boolean;
    set doubleRate(doubleRate: boolean);
    /** Whether hard-telecined material is reconstructed at film cadence. */
    get autoFilm(): boolean;
    set autoFilm(autoFilm: boolean);
    /** The combed-pixel boundary between clean field matches and field motion. */
    get filmCombThreshold(): number;
    set filmCombThreshold(filmCombThreshold: number);
    /** How many field intervals of slack the field schedule is held back by. */
    get bufferFields(): number;
    set bufferFields(fields: number);
    start(): void;
    /** Take the deinterlaced picture away, leaving the element's own showing. */
    stop(): void;
    destroy(): void;
}
//# sourceMappingURL=deinterlace.d.ts.map