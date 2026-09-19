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
    /**
     * Times the schedule was restarted from the clock instead of following on
     * from the last picture: a seek, a stall, a cadence change, or a missed
     * frame. Climbing during steady playback means the cadence is not holding.
     */
    resynced: number;
    /** The number of times the field queue was reset when doubleRate is true. */
    queueResetted: number;
    /** The number of fields queued when doubleRate is true. */
    maxQueuedFields: number;
    /**
     * GPU processing time, supported only in Chrome. On ANGLE's Metal backend
     * it spans command buffers rather than the work in them, so it overstates
     * anything split into many small passes; a change is best judged by its
     * direction here and by a synchronous readback in isolation.
     */
    gpuMs: number | undefined;
    /** Whether 2:3 pulldown has been detected and the frames are shown at 24p. */
    film: boolean;
}
export interface DeinterlacerOptions {
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
    /**
     * Whether to detect 2:3 pulldown and show film at 24 frames a second.
     * Frames that are not film are filtered as usual. Needs
     * `EXT_color_buffer_float`.
     */
    film?: boolean;
    /**
     * Whether to draw the pulldown detection over the picture and log every
     * picture shown to the console.
     */
    debug?: boolean;
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
    /** Whether a picture goes up for every field rather than every frame. */
    get doubleRate(): boolean;
    set doubleRate(doubleRate: boolean);
    get film(): boolean;
    set film(film: boolean);
    get debug(): boolean;
    set debug(debug: boolean);
    start(): void;
    /** Take the deinterlaced picture away, leaving the element's own showing. */
    stop(): void;
    destroy(): void;
    /**
     * The picture currently on the canvas, as an image.
     *
     * The drawing buffer is not preserved, so the texture is blitted again here
     * and the canvas read in the same task: a read from outside a draw would
     * find the buffer already cleared. The picture comes back at the element's
     * own display shape so a saved image keeps the ratio the viewer sees.
     */
    capture(): Promise<ImageBitmap>;
}
//# sourceMappingURL=deinterlace.d.ts.map