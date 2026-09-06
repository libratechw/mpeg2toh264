/** A primitive value safe to copy between realms and serialize in an error. */
export type LifecycleTraceValue = string | number | boolean | null;
/** Extra state recorded beside one lifecycle event. */
export type LifecycleTraceDetail = Readonly<Record<string, LifecycleTraceValue>>;
export type LifecycleTraceScope = "main" | "worker" | "external";
export type MediaSourceClassName = "MediaSource" | "ManagedMediaSource";
/** One event on the page/worker clock shared by a page diagnostic window. */
export interface LifecycleTraceEntry {
    /** Arrival order at the page-side trace owner. */
    readonly sequence: number;
    /** `performance.timeOrigin + performance.now()`, comparable across realms. */
    readonly at: number;
    readonly scope: LifecycleTraceScope;
    readonly event: string;
    readonly playerInstance: number;
    readonly generation: number;
    /** Internal element identity. This is never a recording or programme ID. */
    readonly videoId: number;
    readonly mediaSourceOwner: "main" | "worker";
    readonly mediaSourceClass: MediaSourceClassName | null;
    readonly detail: LifecycleTraceDetail;
}
export interface LifecycleTraceSnapshot {
    readonly eventId: string;
    /** Uses the same cross-realm-comparable clock as every entry's `at`. */
    readonly frozenAt: number;
    readonly dropped: number;
    /** The first event marked as a possible cause, retained even when full. */
    readonly firstCritical: LifecycleTraceEntry | null;
    /** Bounded and sorted by `at`, then by page-side arrival order. */
    readonly entries: readonly LifecycleTraceEntry[];
}
/** The error shape received through `Mpeg2TsPlayer`'s `error` event. */
export interface LifecycleError extends Error {
    readonly lifecycleEventId: string;
    readonly lifecycleTrace: LifecycleTraceSnapshot;
}
declare const diagnosticLifecycleTokenBrand: unique symbol;
/** Opaque identity for an integration-owned critical entry held by the ring. */
export interface DiagnosticLifecycleToken {
    readonly [diagnosticLifecycleTokenBrand]: true;
}
export interface LifecycleTraceEntryInput {
    readonly at: number;
    readonly scope: LifecycleTraceScope;
    readonly event: string;
    readonly playerInstance: number;
    readonly generation: number;
    readonly videoId: number;
    readonly mediaSourceOwner: "main" | "worker";
    readonly mediaSourceClass: MediaSourceClassName | null;
    readonly detail?: LifecycleTraceDetail;
    /** Preserve the first such event outside the rotating part of the buffer. */
    readonly critical?: boolean;
}
/** A MediaSource-owned event before the page adds player and video identity. */
export interface MseLifecycleTrace {
    readonly at: number;
    readonly event: string;
    readonly mediaSourceClass: MediaSourceClassName;
    readonly detail: LifecycleTraceDetail;
    readonly critical: boolean;
}
/** The one monotonic clock coordinate shared by Window and Worker realms. */
export declare function lifecycleNow(): number;
export declare const LIFECYCLE_TRACE_CAPACITY = 48;
/** Longest event ID emitted by safe-integer clock/counter components. */
export declare const LIFECYCLE_EVENT_ID_MAX_LENGTH = 51;
/**
 * Copy an integration-owned detail object into the trace's serializable value
 * contract. A malformed value rejects that diagnostic event as a whole.
 */
export declare function sanitizeLifecycleDetail(detail: unknown): LifecycleTraceDetail | null;
/** Validate the complete integration-owned record without trusting its realm. */
export declare function sanitizeDiagnosticLifecycleInput(event: unknown, detail: unknown, options: unknown): {
    readonly event: string;
    readonly detail: LifecycleTraceDetail;
    readonly at: number | undefined;
    readonly critical: boolean;
} | null;
/**
 * Page-side owner of one bounded diagnostic window.
 *
 * The rotating portion keeps the events nearest a failure. The first event an
 * owner marks critical is held separately, so a close/error that starts the
 * failure cannot disappear when SourceBuffer updates fill the buffer.
 */
export declare class LifecycleTrace {
    #private;
    constructor(capacity?: number);
    record(input: LifecycleTraceEntryInput): LifecycleTraceEntry | null;
    /** Return exactly the held entry to normal ring rotation once it resolves. */
    resolveCritical(entry: LifecycleTraceEntry): boolean;
    freeze(eventId: string, frozenAt?: number): LifecycleTraceSnapshot;
}
/**
 * Decorate the same Error instance when its own properties permit it. A
 * readonly or non-extensible error is retained as the cause of a traced Error.
 *
 * The full trace is intentionally kept out of `message`: DPlayer displays that
 * string directly. Consumers that want the chronology read `lifecycleTrace`.
 */
export declare function withLifecycleTrace(error: Error, snapshot: LifecycleTraceSnapshot): LifecycleError;
export declare function isLifecycleError(error: unknown): error is LifecycleError;
export {};
//# sourceMappingURL=lifecycle.d.ts.map