/**
 * Whether Media Source Extensions here will take this codec.
 *
 * Asking the constructor that would be opened rather than `MediaSource`, which
 * on an iPhone is not there to be asked.
 */
export declare function mediaSourceSupports(mimeCodec: string, preferManaged?: boolean): boolean;
/**
 * Whether a worker may own the one that would be opened.
 *
 * The two answer for themselves: MSE in Workers is Chromium's, and Chromium
 * has no managed source, so the managed answer is no everywhere today. It is
 * asked rather than assumed because the exposure is the specification's to
 * widen, not this player's to decide.
 */
export declare function mediaSourceConstructsInWorker(preferManaged?: boolean): boolean;
/** Whether this browser has a Managed Media Source to open at all. */
export declare function supportsManagedMediaSource(): boolean;
/**
 * Whether the managed one is all there is, as it is on an iPhone. A player
 * there opens one whatever it was asked for, which is worth showing a viewer
 * who is being offered the choice.
 */
export declare function requiresManagedMediaSource(): boolean;
/** Where a producer hands fragments, and how it learns to slow down. */
export interface FragmentSink {
    /** Resolves once there is room for more fragments. */
    ready(): Promise<void>;
    /** Take the initialization segment and open the stream for `mimeCodec`. */
    open(mimeCodec: string, data: ArrayBuffer): Promise<void>;
    push(data: ArrayBuffer, start: number, randomAccess: boolean): void;
    /**
     * Throw away everything buffered and everything queued, and expect the
     * fragments after this to belong somewhere else on the timeline.
     */
    reset(): void;
    /** No more fragments: drain what is queued and end the stream. */
    finish(): Promise<void>;
    /** Give up, releasing anyone waiting on `ready` or `finish`. */
    close(): void;
}
/** A latch a producer can await, so backpressure costs no polling. */
export declare class ReadyGate {
    #private;
    get open(): boolean;
    /** Returns whether this changed anything. */
    set(open: boolean): boolean;
    wait(): Promise<void>;
    /** Let everyone through whatever the state is, for teardown. */
    abandon(): void;
}
export interface MseSinkOptions {
    /**
     * Open a Managed Media Source where the browser has both. An iPhone has only
     * the managed one and gets it either way. See `mediaSourceClass`.
     */
    preferManaged?: boolean;
    /** Stop taking fragments above this many bytes waiting to be appended. */
    queueHighWaterMark: number;
    /** Stop taking fragments while the buffer reaches this far past the playhead. */
    maxAheadSeconds: number;
    /** Seconds of played media to keep behind the playhead when evicting. */
    keepBehindSeconds: number;
    /** Move the playhead, which only whoever holds the media element can do. */
    seek(time: number): void;
    /** Whether there is room for more fragments. */
    onReadyChange?(ready: boolean): void;
    /** Whether the media buffer is full and conversion has to wait. */
    onBlocked?(blocked: boolean): void;
    /**
     * A step worth timing: `sourceopen` when the media element has taken the
     * MediaSource, and `appended` when the first media segment is in the buffer.
     * The two bracket everything MSE does before playback can begin.
     */
    onMark?(name: "sourceopen" | "appended"): void;
    onError?(error: Error): void;
}
export declare class MseSink implements FragmentSink {
    #private;
    /**
     * Made in the constructor rather than in `open`, because a caller needs
     * something to attach before the codec is known: the worker sends
     * `mediaSource.handle` across the moment a load starts, and `sourceopen`
     * does not fire until the page has put it on the element -- long before the
     * first init fragment.
     */
    readonly mediaSource: MediaSource;
    /**
     * Whether that is a Managed Media Source, which a media element takes in its
     * own way. See the player's `#createSink`.
     */
    readonly managed: boolean;
    constructor(options: MseSinkOptions);
    ready(): Promise<void>;
    /**
     * Open the stream, or -- for the initialization segment a seek brings with
     * it -- re-open the one already running.
     */
    open(mimeCodec: string, data: ArrayBuffer): Promise<void>;
    push(data: ArrayBuffer, start: number, randomAccess: boolean): void;
    /**
     * How long the whole presentation is.
     *
     * Without this the media element has no timeline to offer a viewer: it is
     * what turns `seekable` into the length of the file rather than the length
     * of what has been converted so far.
     */
    setDuration(seconds: number): void;
    /**
     * Throw away everything buffered and everything queued.
     *
     * A seek lands somewhere the buffer does not reach, and what follows it is
     * a different part of the file: keeping the old media would leave the
     * timeline with a hole in the middle and the eviction bookkeeping describing
     * bytes that are no longer there.
     */
    reset(): void;
    finish(): Promise<void>;
    close(): void;
    /** Tell the sink where playback has got to, so it can evict what is behind. */
    setCurrentTime(time: number): void;
}
//# sourceMappingURL=mse.d.ts.map