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
    mozTiming?: {
        periodMs: number;
        discontinuity: boolean;
    };
}
type FrameCallback = (now: number, metadata: FrameMetadata) => void;
export declare function supportsVideoFrames(): boolean;
/**
 * One outstanding, cancellable frame request. Prefer Firefox's counters even
 * when native rVFC exists: its notifications/mediaTime can advance in 40 ms
 * steps. Parsed/decoded frames include read-ahead, and presented frames are
 * accounted by the media sink separately from painting. Only painted advances
 * the texture ring; OR-ing the counters would ingest one picture repeatedly.
 *
 * https://searchfox.org/firefox-main/source/dom/media/mediaelement/HTMLVideoElement.cpp
 */
export declare class VideoFrames {
    #private;
    constructor(video: HTMLVideoElement);
    /** Whether acquisition runs off the Firefox counters. */
    get mozDriven(): boolean;
    /** Whether any frame has been delivered yet (counters proven live). */
    get hasDelivered(): boolean;
    request(callback: FrameCallback): void;
    cancel(): void;
    destroy(): void;
}
export {};
//# sourceMappingURL=video-frame.d.ts.map