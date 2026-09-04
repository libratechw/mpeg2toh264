import type { DeinterlaceStats, Scan, VideoState } from "./deinterlace.js";
import type { RenderTraceBatch } from "./render-trace.js";
/** ページ側で観測した1枚の復号フレームに付随する情報。 */
interface WorkerFrameObservation {
    mediaTime: number;
    presentedFrames: number;
    width: number;
    height: number;
}
/** Worker 内の描画エンジンへ渡せるデインタレーサー設定。 */
export interface WorkerRenderingOptions {
    doubleRate: boolean;
    autoFilm: boolean;
    filmCombThreshold: number;
    spatialCheck: boolean;
}
/** DOM を参照できない Worker へ複製する media element の状態。 */
export interface WorkerVideoState {
    currentTime: number;
    playbackRate: number;
    seeking: boolean;
    paused: boolean;
    ended: boolean;
    readyState: number;
    videoWidth: number;
    videoHeight: number;
    buffered: Array<{
        start: number;
        end: number;
    }>;
}
export type WorkerCommand = {
    type: "initialize";
    canvas: OffscreenCanvas;
    options: WorkerRenderingOptions;
    scan: Scan | null;
    videoTimeline: readonly VideoState[];
    enabled: boolean;
    video: WorkerVideoState;
} | {
    type: "frame";
    id: number;
    frame: VideoFrame;
    now: number;
    metadata: WorkerFrameObservation;
    video: WorkerVideoState;
} | {
    type: "settings";
    options: WorkerRenderingOptions;
} | {
    type: "scan";
    scan: Scan | null;
} | {
    type: "timeline";
    videoTimeline: readonly VideoState[];
} | {
    type: "enabled";
    enabled: boolean;
} | {
    type: "event";
    name: "emptied" | "pause" | "ended" | "seeking" | "seeked" | "ratechange";
    video: WorkerVideoState;
} | {
    type: "capture";
    id: number;
    width: number;
    height: number;
} | {
    type: "destroy";
};
export type WorkerNotification = {
    type: "ready";
} | {
    type: "failed";
    message: string;
} | {
    type: "consumed";
    id: number;
} | {
    type: "visibility";
    visible: boolean;
} | {
    type: "stats";
    stats: Omit<DeinterlaceStats, "dropped">;
} | {
    type: "diagnostic-batch";
    batch: RenderTraceBatch;
} | {
    type: "capture";
    id: number;
    image: ImageBitmap | null;
};
export {};
//# sourceMappingURL=worker-protocol.d.ts.map