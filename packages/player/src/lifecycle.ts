/** A primitive value safe to copy between realms and serialize in an error. */
export type LifecycleTraceValue = string | number | boolean | null;

/** Extra state recorded beside one lifecycle event. */
export type LifecycleTraceDetail = Readonly<
  Record<string, LifecycleTraceValue>
>;

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
export function lifecycleNow(): number {
  return performance.timeOrigin + performance.now();
}

export const LIFECYCLE_TRACE_CAPACITY = 48;
const MAX_MESSAGE_SUFFIX_LENGTH = 240;
/** Longest event ID emitted by safe-integer clock/counter components. */
export const LIFECYCLE_EVENT_ID_MAX_LENGTH = 51;
const LIFECYCLE_EVENT_ID = /^m2h-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/;
const INVALID_LIFECYCLE_EVENT_ID_CHARACTER = /[^0-9a-z-]/;
const MAX_COMPACT_EVENT_LENGTH = 32;
const MAX_COMPACT_TAIL_EVENT_LENGTH = 24;
const MAX_MESSAGE_TAIL_EVENTS = 8;
const DIAGNOSTIC_EVENT_START = /^[A-Za-z0-9]/;
const INVALID_DIAGNOSTIC_EVENT_CHARACTER = /[^A-Za-z0-9_.:-]/;
const MAX_DIAGNOSTIC_EVENT_LENGTH = 64;
const MAX_DIAGNOSTIC_DETAIL_FIELDS = 16;
const MAX_DIAGNOSTIC_DETAIL_KEY_LENGTH = 64;
const MAX_DIAGNOSTIC_DETAIL_STRING_LENGTH = 256;

function isTraceValue(value: unknown): value is LifecycleTraceValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * Copy an integration-owned detail object into the trace's serializable value
 * contract. A malformed value rejects that diagnostic event as a whole.
 */
export function sanitizeLifecycleDetail(
  detail: unknown,
): LifecycleTraceDetail | null {
  try {
    if (typeof detail !== "object" || detail === null || Array.isArray(detail))
      return null;
    const entries = Object.entries(detail);
    if (
      entries.length > MAX_DIAGNOSTIC_DETAIL_FIELDS ||
      !entries.every(
        ([key, value]) =>
          key.length > 0 &&
          key.length <= MAX_DIAGNOSTIC_DETAIL_KEY_LENGTH &&
          isTraceValue(value) &&
          (typeof value !== "string" ||
            value.length <= MAX_DIAGNOSTIC_DETAIL_STRING_LENGTH),
      )
    )
      return null;
    return Object.freeze(Object.fromEntries(entries));
  } catch {
    // Diagnostics called by an integration must never alter playback control.
    return null;
  }
}

/** Validate the complete integration-owned record without trusting its realm. */
export function sanitizeDiagnosticLifecycleInput(
  event: unknown,
  detail: unknown,
  options: unknown,
): {
  readonly event: string;
  readonly detail: LifecycleTraceDetail;
  readonly at: number | undefined;
  readonly critical: boolean;
} | null {
  try {
    if (
      typeof event !== "string" ||
      event.length === 0 ||
      event.length > MAX_DIAGNOSTIC_EVENT_LENGTH ||
      !DIAGNOSTIC_EVENT_START.test(event) ||
      INVALID_DIAGNOSTIC_EVENT_CHARACTER.test(event) ||
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    )
      return null;
    const normalizedDetail = sanitizeLifecycleDetail(detail);
    if (normalizedDetail === null) return null;
    const { at, critical } = options as {
      readonly at?: unknown;
      readonly critical?: unknown;
    };
    if (at !== undefined && !Number.isFinite(at)) return null;
    if (critical !== undefined && typeof critical !== "boolean") return null;
    return Object.freeze({
      event,
      detail: normalizedDetail,
      at: at as number | undefined,
      critical: critical === true,
    });
  } catch {
    return null;
  }
}

function isFrozenEntry(value: unknown): value is LifecycleTraceEntry {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value))
    return false;
  const entry = value as Partial<LifecycleTraceEntry>;
  return (
    Number.isInteger(entry.sequence) &&
    Number.isFinite(entry.at) &&
    (entry.scope === "main" ||
      entry.scope === "worker" ||
      entry.scope === "external") &&
    typeof entry.event === "string" &&
    Number.isInteger(entry.playerInstance) &&
    Number.isInteger(entry.generation) &&
    Number.isInteger(entry.videoId) &&
    (entry.mediaSourceOwner === "main" ||
      entry.mediaSourceOwner === "worker") &&
    (entry.mediaSourceClass === null ||
      entry.mediaSourceClass === "MediaSource" ||
      entry.mediaSourceClass === "ManagedMediaSource") &&
    typeof entry.detail === "object" &&
    entry.detail !== null &&
    Object.isFrozen(entry.detail) &&
    Object.values(entry.detail).every(isTraceValue)
  );
}

/**
 * Page-side owner of one bounded diagnostic window.
 *
 * The rotating portion keeps the events nearest a failure. The first event an
 * owner marks critical is held separately, so a close/error that starts the
 * failure cannot disappear when SourceBuffer updates fill the buffer.
 */
export class LifecycleTrace {
  readonly #capacity: number;
  #sequence = 0;
  #recent: LifecycleTraceEntry[] = [];
  #firstCritical: LifecycleTraceEntry | null = null;
  readonly #criticalEntries = new Set<LifecycleTraceEntry>();
  #dropped = 0;
  #snapshot: LifecycleTraceSnapshot | null = null;

  constructor(capacity = LIFECYCLE_TRACE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError("lifecycle trace capacity must be an integer >= 1");
    this.#capacity = capacity;
  }

  record(input: LifecycleTraceEntryInput): LifecycleTraceEntry | null {
    if (this.#snapshot) return null;
    const entry = Object.freeze({
      sequence: ++this.#sequence,
      at: input.at,
      scope: input.scope,
      event: input.event,
      playerInstance: input.playerInstance,
      generation: input.generation,
      videoId: input.videoId,
      mediaSourceOwner: input.mediaSourceOwner,
      mediaSourceClass: input.mediaSourceClass,
      detail: Object.freeze({ ...(input.detail ?? {}) }),
    }) satisfies LifecycleTraceEntry;

    if (input.critical === true) this.#criticalEntries.add(entry);
    if (input.critical === true && this.#firstCritical === null) {
      this.#firstCritical = entry;
    } else {
      this.#recent.push(entry);
    }
    const recentCapacity =
      this.#capacity - (this.#firstCritical === null ? 0 : 1);
    while (this.#recent.length > recentCapacity) {
      this.#criticalEntries.delete(this.#recent.shift()!);
      this.#dropped++;
    }
    return this.#firstCritical === entry ? entry : null;
  }

  /** Return exactly the held entry to normal ring rotation once it resolves. */
  resolveCritical(entry: LifecycleTraceEntry): boolean {
    if (this.#snapshot || this.#firstCritical !== entry) return false;
    const following = this.#recent.findIndex(
      (candidate) => candidate.sequence > entry.sequence,
    );
    if (following === -1) this.#recent.push(entry);
    else this.#recent.splice(following, 0, entry);
    this.#criticalEntries.delete(entry);
    this.#firstCritical = null;
    const nextCritical = this.#recent.find((candidate) =>
      this.#criticalEntries.has(candidate),
    );
    if (nextCritical !== undefined) {
      this.#recent.splice(this.#recent.indexOf(nextCritical), 1);
      this.#firstCritical = nextCritical;
    }
    const recentCapacity =
      this.#capacity - (this.#firstCritical === null ? 0 : 1);
    while (this.#recent.length > recentCapacity) {
      this.#criticalEntries.delete(this.#recent.shift()!);
      this.#dropped++;
    }
    return true;
  }

  freeze(eventId: string, frozenAt = lifecycleNow()): LifecycleTraceSnapshot {
    if (this.#snapshot) return this.#snapshot;
    const entries = [
      ...(this.#firstCritical === null ? [] : [this.#firstCritical]),
      ...this.#recent,
    ].sort(
      (left, right) => left.at - right.at || left.sequence - right.sequence,
    );
    this.#snapshot = Object.freeze({
      eventId,
      frozenAt,
      dropped: this.#dropped,
      firstCritical: this.#firstCritical,
      entries: Object.freeze(entries),
    });
    return this.#snapshot;
  }
}

function compactEvent(event: string, limit = MAX_COMPACT_EVENT_LENGTH): string {
  return event.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, limit);
}

function compactTailEvent(event: string): string {
  return compactEvent(
    event
      .replace(/^mediasource-/, "ms.")
      .replace(/^sourcebuffer-/, "sb.")
      .replace(/^dplayer-/, "dp.")
      .replace(/^player-/, "p.")
      .replace(/^worker-/, "w.")
      .replace(/^video-/, "v.")
      .replace(/^object-url-/, "url.")
      .replace(/^source-element-/, "source."),
    MAX_COMPACT_TAIL_EVENT_LENGTH,
  );
}

function lifecycleMessageSuffix(snapshot: LifecycleTraceSnapshot): string {
  const first = snapshot.firstCritical?.event ?? "none";
  const last = snapshot.entries.at(-1)?.event ?? "none";
  const summary = [
    `lifecycle=${snapshot.eventId}`,
    `first=${compactEvent(first)}`,
    `last=${compactEvent(last)}`,
    `entries=${snapshot.entries.length}`,
    `dropped=${snapshot.dropped}`,
  ].join(" ");
  const tailBudget = MAX_MESSAGE_SUFFIX_LENGTH - 2 - summary.length - 6;
  let tail: string[] = [];
  for (
    let index = snapshot.entries.length - 1;
    index >= 0 && tail.length < MAX_MESSAGE_TAIL_EVENTS;
    index--
  ) {
    const candidate = [
      compactTailEvent(snapshot.entries[index]!.event),
      ...tail,
    ];
    if (candidate.join(">").length > tailBudget) break;
    tail = candidate;
  }
  return `[${summary}${tail.length === 0 ? "" : ` tail=${tail.join(">")}`}]`;
}

function readableErrorString(
  error: Error,
  property: "message" | "name" | "stack",
  fallback: string | null,
): string | null {
  try {
    const value = error[property];
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

function canDefineValue(
  error: Error,
  property: "message" | "lifecycleEventId" | "lifecycleTrace",
  enumerable?: boolean,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(error, property);
  if (descriptor === undefined) return Object.isExtensible(error);
  if (descriptor.configurable) return true;
  return (
    "writable" in descriptor &&
    descriptor.writable === true &&
    (enumerable === undefined || descriptor.enumerable === enumerable)
  );
}

function canDecorateInPlace(error: Error): boolean {
  try {
    return (
      canDefineValue(error, "message") &&
      canDefineValue(error, "lifecycleEventId", true) &&
      canDefineValue(error, "lifecycleTrace", true)
    );
  } catch {
    return false;
  }
}

function defineValue(
  error: Error,
  property: "message" | "lifecycleEventId" | "lifecycleTrace",
  value: unknown,
  enumerable: boolean,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(error, property);
  if (descriptor !== undefined && !descriptor.configurable) {
    Object.defineProperty(error, property, { value });
    return;
  }
  Object.defineProperty(error, property, {
    value,
    writable: property === "message",
    enumerable,
    configurable: property === "message",
  });
}

function decorateError(
  error: Error,
  message: string,
  snapshot: LifecycleTraceSnapshot,
): LifecycleError {
  defineValue(error, "message", message, false);
  defineValue(error, "lifecycleEventId", snapshot.eventId, true);
  defineValue(error, "lifecycleTrace", snapshot, true);
  return error as LifecycleError;
}

/**
 * Decorate the same Error instance when its own properties permit it. A
 * readonly or non-extensible error is retained as the cause of a traced Error.
 *
 * The full trace is intentionally kept out of `message`: DPlayer displays that
 * string directly. Consumers that want the chronology read `lifecycleTrace`.
 */
export function withLifecycleTrace(
  error: Error,
  snapshot: LifecycleTraceSnapshot,
): LifecycleError {
  const suffix = lifecycleMessageSuffix(snapshot);
  const originalMessage = readableErrorString(
    error,
    "message",
    "the original error message was unavailable",
  )!;
  const message = `${originalMessage}\n${suffix}`;

  if (canDecorateInPlace(error)) {
    try {
      return decorateError(error, message, snapshot);
    } catch {
      // Host errors and proxies can still reject a definition after preflight.
    }
  }

  const fallback = new Error(message, { cause: error });
  fallback.name = readableErrorString(error, "name", "Error")!;
  const originalStack = readableErrorString(error, "stack", null);
  if (originalStack !== null) {
    fallback.stack = `${fallback.name}: ${fallback.message}\nCaused by original error:\n${originalStack}`;
  }
  return decorateError(fallback, message, snapshot);
}

export function isLifecycleError(error: unknown): error is LifecycleError {
  try {
    if (typeof error !== "object" || error === null) return false;
    const candidate = error as Partial<LifecycleError>;
    const eventId = candidate.lifecycleEventId;
    const trace = candidate.lifecycleTrace;
    return (
      typeof candidate.name === "string" &&
      typeof candidate.message === "string" &&
      typeof eventId === "string" &&
      eventId.length <= LIFECYCLE_EVENT_ID_MAX_LENGTH &&
      LIFECYCLE_EVENT_ID.test(eventId) &&
      !INVALID_LIFECYCLE_EVENT_ID_CHARACTER.test(eventId) &&
      trace?.eventId === eventId &&
      Number.isFinite(trace.frozenAt) &&
      Number.isInteger(trace.dropped) &&
      trace.dropped >= 0 &&
      Object.isFrozen(trace) &&
      Array.isArray(trace.entries) &&
      trace.entries.length > 0 &&
      trace.entries.length <= LIFECYCLE_TRACE_CAPACITY &&
      Object.isFrozen(trace.entries) &&
      trace.entries.every(isFrozenEntry) &&
      trace.entries.every(
        (entry, index) =>
          index === 0 ||
          entry.at > trace.entries[index - 1]!.at ||
          (entry.at === trace.entries[index - 1]!.at &&
            entry.sequence > trace.entries[index - 1]!.sequence),
      ) &&
      (trace.firstCritical === null ||
        (isFrozenEntry(trace.firstCritical) &&
          trace.entries.includes(trace.firstCritical)))
    );
  } catch {
    return false;
  }
}
