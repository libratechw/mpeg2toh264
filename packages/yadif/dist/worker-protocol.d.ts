import type { DeinterlaceStats, DiagnosticPictureMeta, PresentedPictureMeta, QueuedPictureMeta, PresentationQueueMeta, Scan, VideoState } from "./deinterlace.js";
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
    /**
     * 診断 hook の要求。真の場合だけ Worker 側の描画エンジンが加工出力の
     * meta を `diagnostic` 通知で送る。画素は送らない。偽では通知自体がなく、
     * 既存の描画・stats と同じになる。
     */
    diagnostic: boolean;
    /** Worker の実表示点で VideoFrame を作り、ページ側の診断 sink へ渡す。 */
    capturePresentedFrames: boolean;
    /** 旧表示 queue へ入る直前の加工画素を VideoFrame で渡す。 */
    captureQueuedFrames: boolean;
    /** 同じGL出力canvasから実解像度VideoFrameを作る診断専用経路。 */
    captureQueuedFrameFullSize: boolean;
    /** 診断専用: queued frame を旧表示 queue へ保持せず外部 sink へ直結する。 */
    bypassDisplayQueue: boolean;
    /** 旧表示 queue の期限判定をメタデータだけで記録する。 */
    capturePresentationQueue: boolean;
    /** sink 併用時に、queued frame の meta だけを通知する。 */
    captureQueuedMeta: boolean;
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
    queuedFrameSink: WritableStream<VideoFrame> | null;
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
}
/** presenter が現在の映像の表示を所有しているかの変化。 */
 | {
    type: "presenterOwnsDisplay";
    owns: boolean;
} | {
    type: "stats";
    stats: Omit<DeinterlaceStats, "dropped">;
} | {
    type: "capture";
    id: number;
    image: ImageBitmap | null;
}
/**
 * Worker 描画エンジンの選択/queue 出力記録。filter 時の生産報告であり、
 * 物理表示の報告ではない: queue から late で落ちた分も報告されるため、
 * 表示との突き合わせは stats の late/outputFps を使う。meta の
 * generation/frameId は Worker 側通番のまま越境する。
 */
 | {
    type: "diagnostic";
    meta: DiagnosticPictureMeta;
}
/** queueを通過して実際にcanvasへ描かれた加工出力。frameはtransferable。 */
 | {
    type: "presented";
    frame: VideoFrame;
    meta: PresentedPictureMeta;
}
/** 旧表示 queue の間引き前に取り出した加工画素。frameはtransferable。 */
 | {
    type: "queued";
    frame: VideoFrame;
    meta: QueuedPictureMeta;
}
/** sink へ直接書込んだ queued frame の meta（画素は含まない）。 */
 | {
    type: "queuedMeta";
    meta: QueuedPictureMeta;
}
/** 旧表示 queue の期限判定。画素・物理表示は含まない。 */
 | {
    type: "presentationQueue";
    meta: PresentationQueueMeta;
};
export {};
//# sourceMappingURL=worker-protocol.d.ts.map