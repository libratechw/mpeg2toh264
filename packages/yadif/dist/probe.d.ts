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
export declare function probeDecoder(options?: DecoderProbeOptions): Promise<DecoderProbe>;
/** The verdict on its own, for a caller that wants nothing else. */
export declare function decoderDeinterlaces(options?: DecoderProbeOptions): Promise<boolean>;
/** Forget the answer, for a page that wants it asked again. */
export declare function forgetDecoderProbe(): void;
//# sourceMappingURL=probe.d.ts.map