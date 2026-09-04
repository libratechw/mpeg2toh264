const TRACE_LIMIT = 8192;

export type TraceBackend = "starting" | "worker" | "main" | "failed";
export type TraceRequestedBackend = "auto" | "worker" | "main";

export interface TraceBackendState {
  requested: TraceRequestedBackend;
  active: TraceBackend;
  generation: number;
  reason: string;
}

export type EngineRenderTraceEvent =
  | {
      kind: "raf";
      sequence: number;
      atMs: number;
      gapMs: number | null;
      queueDepth: number;
      refreshMs: number;
      outputPoolLength: number;
      initializedOutputs: number;
      outputHead: number;
      shownSlot: number | null;
      queue: Array<{ slot: number; atMs: number; durationMs: number }>;
    }
  | {
      kind: "draw-submit";
      sequence: number;
      atMs: number;
      rafAtMs: number | null;
      scheduledAtMs: number | null;
      queueDepthAfter: number;
      path:
        "scheduled" | "film-direct" | "yadif-direct" | "progressive" | "flush";
    }
  | {
      kind: "frame-ingest";
      sequence: number;
      atMs: number;
      mediaTime: number;
      presentedFrames: number;
      path: "callback" | "watchdog" | "worker-transfer";
    }
  | {
      kind: "slot-pressure";
      sequence: number;
      atMs: number;
      outcome: "oldest" | "none";
      resultSlot: number | null;
      outputPoolLength: number;
      initializedOutputs: number;
      outputHead: number;
      shownSlot: number | null;
      queuedSlots: number[];
    };

type EngineRenderTraceInput =
  | Omit<Extract<EngineRenderTraceEvent, { kind: "raf" }>, "sequence">
  | Omit<Extract<EngineRenderTraceEvent, { kind: "draw-submit" }>, "sequence">
  | Omit<Extract<EngineRenderTraceEvent, { kind: "frame-ingest" }>, "sequence">
  | Omit<
      Extract<EngineRenderTraceEvent, { kind: "slot-pressure" }>,
      "sequence"
    >;

export type RenderTraceEvent =
  | (EngineRenderTraceEvent & {
      realm: "worker" | "main";
      generation: number;
      timeOriginMs: number;
    })
  | {
      kind: "backend";
      sequence: number;
      realm: "main";
      generation: number;
      timeOriginMs: number;
      atMs: number;
      requested: TraceRequestedBackend;
      active: TraceBackend;
      reason: string;
    };

export interface RenderTraceBatch {
  timeOriginMs: number;
  events: EngineRenderTraceEvent[];
  droppedEvents: number;
}

interface PageRenderTrace {
  readonly schemaVersion: 2;
  readonly backend: TraceBackendState;
  readonly droppedEvents: number;
  drain(): { events: RenderTraceEvent[]; droppedEvents: number };
}

declare global {
  // This global exists only in the diagnostic build and is intentionally not
  // part of the package API.
  var __YADIF_RENDER_TRACE__: PageRenderTrace | undefined;
}

let sequence = 0;
let droppedEvents = 0;
let engineEvents: EngineRenderTraceEvent[] = [];
let pageEvents: RenderTraceEvent[] = [];
const backend: TraceBackendState = {
  requested: "auto",
  active: "starting",
  generation: 0,
  reason: "module-loaded",
};

function appendPageEvent(event: RenderTraceEvent): void {
  if (pageEvents.length === TRACE_LIMIT) {
    pageEvents.shift();
    droppedEvents++;
  }
  pageEvents.push(event);
}

export function recordEngineTrace(event: EngineRenderTraceInput): void {
  const value = { ...event, sequence: ++sequence } as EngineRenderTraceEvent;
  if (typeof document !== "undefined") {
    appendPageEvent({
      ...value,
      realm: "main",
      generation: backend.generation,
      timeOriginMs: performance.timeOrigin,
    });
    return;
  }
  if (engineEvents.length === TRACE_LIMIT) {
    engineEvents.shift();
    droppedEvents++;
  }
  engineEvents.push(value);
}

export function drainEngineTrace(): RenderTraceBatch {
  const result = {
    timeOriginMs: performance.timeOrigin,
    events: engineEvents,
    droppedEvents,
  };
  engineEvents = [];
  droppedEvents = 0;
  return result;
}

export function appendWorkerTrace(
  batch: RenderTraceBatch,
  generation: number,
): void {
  for (const event of batch.events) {
    appendPageEvent({
      ...event,
      realm: "worker",
      generation,
      timeOriginMs: batch.timeOriginMs,
    });
  }
  droppedEvents += batch.droppedEvents;
}

export function setTraceBackend(
  requested: TraceRequestedBackend,
  active: TraceBackend,
  generation: number,
  reason: string,
): void {
  backend.requested = requested;
  backend.active = active;
  backend.generation = generation;
  backend.reason = reason;
  if (typeof document !== "undefined") {
    appendPageEvent({
      kind: "backend",
      sequence: ++sequence,
      realm: "main",
      generation,
      timeOriginMs: performance.timeOrigin,
      atMs: performance.now(),
      requested,
      active,
      reason,
    });
  }
}

if (typeof document !== "undefined") {
  globalThis.__YADIF_RENDER_TRACE__ = {
    schemaVersion: 2,
    get backend() {
      return { ...backend };
    },
    get droppedEvents() {
      return droppedEvents;
    },
    drain() {
      const result = { events: pageEvents, droppedEvents };
      pageEvents = [];
      droppedEvents = 0;
      return result;
    },
  };
}
