import type { DeinterlaceStats, Scan, VideoState } from "./deinterlace.js";
/** ページ側で観測した1枚の復号フレームに付随する情報。 */
interface WorkerFrameObservation {
    mediaTime: number;
    presentedFrames: number;
    /**
     * requestVideoFrameCallback() が報告した表示予定時刻。測ったのは取得側の
     * 時計なので、Worker は `timeOrigin` との差で自分の時計へ変換してから
     * 表示スケジュールの起点に使う。
     */
    expectedDisplayTime: number;
    /**
     * `expectedDisplayTime` を測った realm の performance.timeOrigin。
     *
     * フレームごとに送る。取得した realm はフレームごとに変わりうる
     * (document picture-in-picture が video ノードを別ウィンドウへ移す) ため
     * initialize の一度きりでは古くなる。ACK 待ちで保留したフレームは取得
     * 時点の原点をそのまま保持する。
     */
    timeOrigin: number;
    width: number;
    height: number;
    /**
     * Firefox カウンター計時。spread と structured clone で線を越えるため
     * 宣言にも載せ、将来のリテラル化で moz 配線が外れないようにする。
     */
    mozTiming?: {
        periodMs: number;
        discontinuity: boolean;
    };
}
/** Worker 内の描画エンジンへ渡せるデインタレーサー設定。 */
export interface WorkerRenderingOptions {
    doubleRate: boolean;
    autoFilm: boolean;
    filmCombThreshold: number;
    spatialCheck: boolean;
    film: boolean;
    debug: boolean;
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
    metadata: WorkerFrameObservation;
    video: WorkerVideoState;
} | {
    type: "settings";
    options: WorkerRenderingOptions;
    retryFilm?: "film" | "autoFilm";
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
    /** Failed film attempts, including identical reasons between reports. */
    filmFailure: number;
} | {
    type: "capture";
    id: number;
    image: ImageBitmap | null;
};
export {};
//# sourceMappingURL=worker-protocol.d.ts.map