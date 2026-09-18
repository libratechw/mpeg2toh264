/**
 * How the filter is getting on, and where it is being let down.
 *
 * A deinterlacer is only as good as the frames it is given. yadif reads the
 * frame either side of the one it is filtering, and every count here that is
 * not `filtered` is a way of not having them: a frame the callback never saw
 * leaves the two neighbours two frames apart, and one filtered against a copy
 * of itself has no motion to measure at all. Both show up as combing that
 * comes and goes, which is worth being able to point at rather than guess at.
 */
export interface DeinterlaceStats {
    /** Frames filtered with a real frame on either side: the good case. */
    filtered: number;
    /**
     * Frames the element presented that the filter never saw, counted from the
     * gaps in `presentedFrames`. The neighbours of the frames either side of a
     * gap are further apart in time than the filter believes, so its idea of
     * what moved is wrong. A page that sees this climbing is asking the filter
     * to keep up with more than it can.
     */
    missed: number;
    /**
     * Frames the browser decoded and threw away without presenting, as the
     * element itself counts them. This is the machine being behind rather than
     * this filter: it happens with the deinterlacer off as well.
     */
    dropped: number;
    /**
     * Frames filtered with a copy of themselves standing in for a neighbour,
     * which is the start of a stream, the frame a seek lands on, and the last
     * frame before playback stops. Expected in ones and twos; a stream of them
     * means the held frames keep being thrown away.
     */
    degraded: number;
    /** Times the held frames were dropped as stale: seeks, and stream changes. */
    discontinuities: number;
    /** 表示機会を過ぎたか、表示時計と予定時刻が食い違ったために描画されなかったフィールド数。 */
    late: number;
    /** Reserved for stats compatibility; queue resets are not used for recovery. */
    queueResetted: number;
    /** Frames presented per second over the last report. */
    fps: number;
    /** 直近区間で入力1枚のアップロード、フィルター、表示に費やした描画スレッド上の平均時間。GPU の実行時間と Worker 描画時のメインスレッド占有時間は含まない。 */
    frameMs: number;
    /**
     * The largest number of pictures queued during the last reporting interval,
     * across both the field-rate and film scheduling paths.
     */
    maxQueuedFields: number;
    /** The render path currently selected by automatic cadence detection. */
    mode: "film" | "video";
    /** The field match selected for the most recently analysed frame. */
    match: "p" | "c" | "n";
    /** Largest 16 by 16 block count of vertically adjacent combed pixels. */
    combScore: number;
    /** Pictures actually copied to the canvas per second. */
    outputFps: number;
    /** Smallest block difference in the most recently completed decimate cycle. */
    duplicateScore: number;
    /** Next-smallest block difference in the most recently completed cycle. */
    duplicateRunnerUp: number;
}
/**
 * YADIF/film の加工画素だけを識別する診断 hook の出力元。
 *
 * `yadif-first` は保持フィールド、`yadif-second` は doubleRate のもう一枚、
 * `yadif-flush` は pause/ended/seeked/ratechange 後に直接出す最終静止画、
 * `film` は IVTC で再構成したコマ。progressive/raw の直接表示は含まない。
 */
export type DiagnosticPictureSource = "yadif-first" | "yadif-second" | "yadif-flush" | "film";
/**
 * 1枚の加工出力の診断 meta。画素の輸送はしない: 将来 VideoFrame/Generator
 * へ接続する側が frameId/generation/mediaTimestampUs で突き合わせる。
 */
export interface DiagnosticPictureMeta {
    /** 加工経路。progressive/raw は通知しない。 */
    source: DiagnosticPictureSource;
    /** 取り込み時の mediaTime をマイクロ秒化したもの。 */
    mediaTimestampUs: number;
    /**
     * pause/seek/emptied/ratechange/scan変更/stop/destroy/Worker交代で単調に進む世代。
     * main と Worker の描画エンジンが独立に数える通番であり、両経路が同時に
     * 発火することはない（workerState が排他）。
     */
    generation: number;
    /** 通知ごとの単調な通番。世代と組で古い画素を捨てる。 */
    frameId: number;
    /** doubleRate の2枚目かどうか。 */
    second: boolean;
    /** その時点の coded size。 */
    width: number;
    height: number;
}
/**
 * Meta accompanying a VideoFrame made at the real canvas presentation point.
 * `presentationTimeMs` uses the producing context's clock (main or Worker),
 * and the callback owns and must close the VideoFrame.
 */
export interface PresentedPictureMeta extends DiagnosticPictureMeta {
    presentationTimeMs: number;
    durationUs: number | null;
}
/** Meta accompanying a processed picture copied before the display queue. */
export interface QueuedPictureMeta extends DiagnosticPictureMeta {
    /** Renderer-clock time at which the processed framebuffer was captured. */
    queuedAtMs: number;
    durationUs: number | null;
    /** Dimensions of the frame delivered to the queue callback. */
    captureWidth: number;
    captureHeight: number;
}
/** presenter が受け取る最小 meta。診断用の語彙は含めない。 */
export interface PresenterFrameMeta {
    mediaTimestampUs: number;
    durationUs: number | null;
}
/** Metadata-only observation of the legacy display queue decision. */
export interface PresentationQueueMeta {
    /** Renderer-clock time of the animation/display opportunity. */
    atMs: number;
    /** Deadline used to decide which queued field is eligible. */
    deadlineMs: number;
    /** Queue length before retiring fields for this opportunity. */
    queueLengthBefore: number;
    /** Number of older fields retired as late at this opportunity. */
    retired: number;
    /** Queue length after retirement and before selecting the next field. */
    queueLengthAfter: number;
    /** Selected field identity, or null when no field was eligible. */
    selectedFrameId: number | null;
    /** Selected field deadline, or null when no field was eligible. */
    selectedAtMs: number | null;
    /** Renderer-clock enqueue time for the selected field, or null. */
    selectedEnqueuedAtMs: number | null;
    /** Identity and timing of fields retired at this deadline opportunity. */
    retiredFields: Array<{
        frameId: number | null;
        generation: number | null;
        mediaTimestampUs: number | null;
        plannedAtMs: number;
        enqueuedAtMs: number | null;
        reason: "deadline";
    }>;
}
/** 診断 hook の明示 option。未指定時は処理・stats・Canvas は既存と同じ。 */
export interface DeinterlacerDiagnosticOptions {
    /**
     * YADIF field/film の出力を source tag 付きで受ける。progressive/raw
     * video は通知しない。main 描画では描画エンジンが直接呼び、Worker 描画では
     * Worker 側の通番のまま `diagnostic` 通知で届く。いずれも filter 時の
     * 選択/queue 出力記録であり、物理表示の報告ではない。
     */
    onFilteredPicture?: (meta: DiagnosticPictureMeta) => void;
    /**
     * queueを通過して実際にcanvasへ描かれた加工出力をVideoFrameで渡す。
     * late破棄された出力やcapture()の再描画は通知しない。
     */
    onPresentedFrame?: (frame: VideoFrame, meta: PresentedPictureMeta) => void;
    /**
     * Copy each processed queued field to a small VideoFrame before #queue.push.
     * The callback owns and must close the frame.  This is a diagnostic transport
     * probe; it neither replaces the display queue nor claims physical display.
     */
    onQueuedFrame?: (frame: VideoFrame, meta: QueuedPictureMeta) => void;
    /**
     * Diagnostic-only: called after a queued frame was written to a worker-owned
     * sink, so the page keeps its counters without receiving the pixel frame.
     */
    onQueuedMeta?: (meta: QueuedPictureMeta) => void;
    /** Metadata-only observation of the legacy queue decision; no pixel copy. */
    onPresentationQueue?: (meta: PresentationQueueMeta) => void;
    /**
     * Diagnostic-only direct-transport trial: do not retain the processed field
     * in the legacy display queue after onQueuedFrame receives it. This is only
     * valid with onQueuedFrame and is never enabled by normal player options.
     */
    bypassDisplayQueue?: boolean;
    /**
     * Diagnostic-only full-size transport. The processed texture is drawn to
     * the renderer's existing canvas and wrapped in a VideoFrame, avoiding the
     * fixed 160x90 readback/copy path. It requires both onQueuedFrame and
     * bypassDisplayQueue; it is never enabled by normal player options.
     */
    captureQueuedFrameFullSize?: boolean;
}
/** mediaTime(秒)を診断 meta 用のマイクロ秒へ丸める。 */
export declare function toDiagnosticTimestampUs(mediaTimeSeconds: number): number;
/**
 * 診断世代と通番の純粋な所有者。DOM/WebGL を持たないため offline で検証できる。
 *
 * Deinterlacer は YADIF/film の出力点でのみ `emit` し、再生状態の境界では
 * `invalidate` する。sink 側は generation の不一致を古い画素の破棄に使う。
 */
export declare class DiagnosticPictureGate {
    #private;
    constructor(sink?: (meta: DiagnosticPictureMeta) => void, capture?: boolean);
    /** sink または表示点captureが有効なら真。 */
    get enabled(): boolean;
    /** 現在の世代。 */
    get generation(): number;
    /** 最後に発行した通番。 */
    get frameId(): number;
    /** 古い世代を捨てる。境界ごとに1回だけ呼ぶ。 */
    invalidate(): number;
    /** sink を離す。以後の emit は何もしない。 */
    destroy(): void;
    /**
     * Worker 境界を越えた meta を通番のまま sink へ渡す。Worker 側の
     * generation/frameId を付け替えず、到着順（＝Worker の送出順）を保つ。
     */
    deliver(meta: DiagnosticPictureMeta): void;
    /**
     * 1枚の加工出力を通知する。sink/captureともなければnullを返す。
     * progressive/raw 用の source は型に存在しないため混ざらない。
     */
    emit(source: DiagnosticPictureSource, mediaTimestampUs: number, second: boolean, width: number, height: number): DiagnosticPictureMeta | null;
}
export interface DeinterlacerOptions {
    /** 描画先。`auto` は同梱 Worker を優先し、初期化できない場合はメインスレッドへ戻る。 */
    rendering?: "auto" | "worker" | "main";
    /** module Worker の URL。省略時はパッケージへ同梱したファイルを使う。 */
    workerUrl?: string | URL;
    /**
     * Whether to show a picture for every field rather than for every frame.
     *
     * Interlaced video carries two moments in each frame, and one output frame
     * per input frame throws the second one away: motion that was captured
     * fifty or sixty times a second is shown twenty-five or thirty. With this
     * on, each frame is filtered twice -- once keeping the field that came
     * first and once keeping the other -- and the second picture is put up half
     * a frame after the first, which is the moment it was taken at. Motion is
     * as smooth as the broadcast was, at twice the filtering.
     *
     * It needs a display that can show them: at 59.94 fields a second there is
     * one refresh of a 60 Hz screen for each, and nothing to spare.
     *
     * With `spatialCheck`, this is which of yadif's four modes runs: off/on is
     * `send_frame`, on/on is `send_field`, and the two with `spatialCheck` off
     * are the `nospatial` pair.
     */
    doubleRate?: boolean;
    /**
     * Whether hard-telecined film is reconstructed and shown at its native
     * 24000/1001 cadence. Matching follows FFmpeg's
     * `fieldmatch=mode=pc_n:combmatch=full:mchroma=0`, and duplicate decisions
     * follow `decimate=cycle=5:mixed=1`. Frames that do not form a clean film
     * cadence continue through YADIF.
     */
    autoFilm?: boolean;
    /**
     * The combed-pixel threshold for a 16 by 16 block. A fieldmatch result with
     * a score at or above this value is considered combed. This is the browser
     * equivalent of FFmpeg fieldmatch's `combpel` threshold.
     */
    filmCombThreshold?: number;
    /**
     * Whether to let the local vertical range widen what the temporal check
     * allows. This is yadif's default and its `nospatial` mode turns it off.
     */
    spatialCheck?: boolean;
    /**
     * Called about once a second while frames are arriving, and not at all while
     * nothing is playing -- there is nothing to say about a filter that is not
     * being asked for anything.
     */
    onStats?(stats: DeinterlaceStats): void;
    /**
     * 対応する表示 hook。加工済みの各 picture を full-size の VideoFrame として
     * この callback へ渡し、内蔵 canvas へは描かない。呼び出し側が frame を所有して
     * close し、表示 (例: MediaStreamTrackGenerator への書込) を担う。presenter を
     * 指定すると内蔵 canvas は更新されない。
     */
    presenter?: (frame: VideoFrame, meta: PresenterFrameMeta) => void;
    /**
     * Diagnostic-only: a WritableStream that the Worker writes queued frames to
     * directly, so the main thread neither receives nor writes the VideoFrame.
     * Worker rendering path only.
     */
    queuedFrameSink?: WritableStream<VideoFrame>;
    /**
     * YADIF の加工画素だけを識別する診断 hook。未指定時は既存と同じ。
     * Worker 描画中は Worker 側通番のまま `diagnostic` 通知で届く。
     */
    diagnostic?: DeinterlacerDiagnosticOptions;
}
/** Field information supplied by a player or another video source. */
export interface Scan {
    interlaced: boolean;
    topFieldFirst: boolean;
}
export interface VideoState {
    start: number;
    codedSize?: {
        width: number;
        height: number;
    };
    scan?: Scan;
}
export interface DeinterlacerEventMap {
    stats: CustomEvent<DeinterlaceStats>;
}
/** Whether this browser has the two things the deinterlacer is built on. */
export declare function supportsDeinterlace(): boolean;
/**
 * Puts a deinterlaced copy of a `<video>` over the top of it.
 *
 * ```ts
 * const deinterlacer = new Deinterlacer(video);
 * deinterlacer.start();
 * ```
 *
 * `start()` wraps the element in a positioned `<div>` and adds a canvas over
 * it. The canvas takes no pointer events, so anything the page put on the
 * element still works, but it does cover the element's own controls; a page
 * that wants controls with this on has to draw them itself. `stop()` hides the
 * canvas again, which is all it takes to compare the two.
 *
 * While frames are arriving, the current counters are also dispatched as a
 * `stats` event about once a second. The optional `onStats` callback receives
 * the same snapshot for callers that prefer a constructor option.
 */
export declare class Deinterlacer extends EventTarget {
    #private;
    constructor(video: HTMLVideoElement, options?: DeinterlacerOptions);
    get running(): boolean;
    /** 現在 media element の上に配置している HTML canvas。 */
    get canvas(): HTMLCanvasElement;
    /** Whether the caller wants filtering, independently of the current source. */
    get enabled(): boolean;
    set enabled(enabled: boolean);
    /** Update whether the source needs filtering and which field comes first. */
    set scan(scan: Scan | null);
    get scan(): Scan | null;
    set videoTimeline(timeline: readonly VideoState[]);
    get videoTimeline(): readonly VideoState[];
    /**
     * What to put on the screen for fullscreen: the `<div>` holding both the
     * element and the canvas once there is one, and the element itself before
     * that. Fullscreening the element alone would leave the canvas behind in
     * the page, and with it the only deinterlaced picture there is.
     */
    get container(): HTMLElement;
    /** Whether a picture goes up for every field rather than every frame. */
    get doubleRate(): boolean;
    set doubleRate(doubleRate: boolean);
    /** Whether hard-telecined material is reconstructed at film cadence. */
    get autoFilm(): boolean;
    set autoFilm(autoFilm: boolean);
    /** The combed-pixel limit used by automatic film detection. */
    get filmCombThreshold(): number;
    set filmCombThreshold(value: number);
    /** 診断 hook の現在世代。未指定時は 0。 */
    get diagnosticGeneration(): number;
    start(): void;
    /** Take the deinterlaced picture away, leaving the element's own showing. */
    stop(): void;
    destroy(): void;
    /**
     * Copy the picture currently represented by the deinterlacer.
     *
     * The WebGL drawing buffer is deliberately not preserved between browser
     * composites. Repeating the exact draw path of the presented picture before
     * `createImageBitmap` makes a snapshot reliable without imposing the
     * permanent cost of `preserveDrawingBuffer` on ordinary playback.
     */
    capture(): Promise<ImageBitmap>;
    addEventListener<K extends keyof DeinterlacerEventMap>(type: K, listener: (event: DeinterlacerEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
    removeEventListener<K extends keyof DeinterlacerEventMap>(type: K, listener: (event: DeinterlacerEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
    /** presenter が現在の映像の表示を所有しているか。Worker では通知値をそのまま返す。 */
    get presenterOwnsDisplay(): boolean;
}
//# sourceMappingURL=deinterlace.d.ts.map