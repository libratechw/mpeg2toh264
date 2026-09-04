export type TraceBackend = "starting" | "worker" | "main" | "failed";
export type TraceRequestedBackend = "auto" | "worker" | "main";
export interface TraceBackendState {
    requested: TraceRequestedBackend;
    active: TraceBackend;
    generation: number;
    reason: string;
}
export type EngineRenderTraceEvent = {
    kind: "raf";
    sequence: number;
    atMs: number;
    gapMs: number | null;
    queueDepth: number;
} | {
    kind: "draw-submit";
    sequence: number;
    atMs: number;
    rafAtMs: number | null;
    scheduledAtMs: number | null;
    queueDepthAfter: number;
    path: "scheduled" | "film-direct" | "yadif-direct" | "progressive" | "flush";
};
type EngineRenderTraceInput = Omit<Extract<EngineRenderTraceEvent, {
    kind: "raf";
}>, "sequence"> | Omit<Extract<EngineRenderTraceEvent, {
    kind: "draw-submit";
}>, "sequence">;
export type RenderTraceEvent = (EngineRenderTraceEvent & {
    realm: "worker" | "main";
    generation: number;
    timeOriginMs: number;
}) | {
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
    readonly schemaVersion: 1;
    readonly backend: TraceBackendState;
    readonly droppedEvents: number;
    drain(): {
        events: RenderTraceEvent[];
        droppedEvents: number;
    };
}
declare global {
    var __YADIF_RENDER_TRACE__: PageRenderTrace | undefined;
}
export declare function recordEngineTrace(event: EngineRenderTraceInput): void;
export declare function drainEngineTrace(): RenderTraceBatch;
export declare function appendWorkerTrace(batch: RenderTraceBatch, generation: number): void;
export declare function setTraceBackend(requested: TraceRequestedBackend, active: TraceBackend, generation: number, reason: string): void;
export {};
//# sourceMappingURL=render-trace.d.ts.map