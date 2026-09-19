/** What the pulldown detection said about a frame. */
export interface Phase {
    /** Which frame of the cycle it is, 1 to 5, or 0 for none. */
    phase: number;
    /** How many frames in a row have had a phase. See film-shader.ts. */
    run: number;
}
export declare const NO_PHASE: Phase;
/**
 * Detects the pulldown phase of frames on the GPU.
 *
 * `detect` measures the frame being filtered against the one after it, moves
 * the earlier measurements along, decides the phase, and starts reading the
 * result back; `poll` collects it once it has arrived, a frame or so later.
 * `texture` is the newest measurements, for the filter to read the phase
 * from without waiting for the page.
 *
 * The measurements of one frame are written from those of the frame before
 * in a single pass, so they live in two textures taken in turns; nothing is
 * copied between passes, and the frame costs three draws and a readback.
 */
export declare class FilmDetector {
    #private;
    /** The last metrics read back, laid out as FIELD_METRICS says. */
    readonly metrics: Float32Array<ArrayBuffer>;
    constructor(gl: WebGL2RenderingContext);
    /** The newest measurements, or null before any frame has been measured. */
    get texture(): WebGLTexture | null;
    /** The size of the frames to be measured, which sizes the block grid. */
    resize(width: number, height: number): void;
    /** Forget every measurement: the next frame starts a cycle from nothing. */
    reset(): void;
    /**
     * Detect the pulldown phase of `cur`, the frame being filtered, against
     * `next`, and start reading it back. Only the two comparisons against the
     * next frame are measured; the rest are earlier ones moved along a frame.
     * `first` is the parity of the field that was captured first.
     */
    detect(cur: WebGLTexture, next: WebGLTexture, first: number): void;
    /**
     * The phase of the last frame measured, once the GPU has handed it back,
     * and null while it is still on its way. It is handed back once.
     */
    poll(): Phase | null;
    destroy(): void;
}
//# sourceMappingURL=film-detect.d.ts.map