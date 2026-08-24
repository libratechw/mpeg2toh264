import { type AudioTracks, type PlayerState, type PrivateStream, type Progress, type Scan, type VideoState, type Services, type SinkKind, type Stats, type Timing } from "./protocol.js";
/** A replaceable deinterlacer controlled by the source picture timeline. */
export interface PlayerDeinterlacer {
    readonly running: boolean;
    /** Field information selected for the picture most recently presented. */
    readonly scan: Scan | null;
    enabled: boolean;
    videoTimeline: readonly VideoState[];
    destroy(): void;
}
export type PlayerDeinterlacerFactory = (video: HTMLVideoElement) => PlayerDeinterlacer;
export interface Mpeg2TsPlayerOptions {
    /** Where the `.wasm` is. Defaults to the copy sitting beside the worker. */
    wasmUrl?: string | URL;
    /** Where the module Worker is. Defaults to the copy emitted beside this package. */
    workerUrl?: string | URL;
    /**
     * Which side runs MediaSource. `'auto'` takes the worker wherever the
     * browser has MSE in Workers, and the page otherwise.
     */
    mediaSource?: "auto" | "worker" | "main";
    /**
     * Open a Managed Media Source where the browser has both.
     *
     * An iPhone has only the managed one and gets it whatever this says -- that
     * is what makes the player work there at all. Everywhere both exist the
     * plain one is used by default; setting this asks for the managed one, which
     * is how to see on a desktop what an iPhone will do with a stream.
     */
    preferManagedMediaSource?: boolean;
    /** The quantiser search factor. Higher is slower and closer to the source. */
    oversample?: number;
    /** Number of MPEG-2 GOPs between recovery points. */
    recoveryInterval?: number;
    /**
     * How an open GOP becomes independently decodable. `idr` preserves leading
     * pictures and follows them with a real IDR; `recovery-point` preserves them
     * and uses a non-IDR recovery point; `discard` drops them and starts at an
     * IDR.
     */
    openGopRecovery?: "idr" | "recovery-point" | "discard";
    /**
     * Give each field of a complementary pair its own MP4 sample. On by default,
     * because both break where frame pictures give way to field pictures:
     * Firefox on Windows freezes, and a pair sharing one sample decodes to an
     * image of `CVFieldCount` 2 where a frame picture gives 1, which Safari fails
     * on because WebKit reuses the format description it cached from the first
     * decoded image. Only a sample boundary moves; the elementary stream is the
     * same either way.
     */
    splitFieldSamples?: boolean;
    /**
     * Carry the MPEG-2 video into the MP4 as it stands instead of converting it,
     * for a browser whose decoder takes MPEG-2 -- Safari on Apple platforms is
     * the one that does. Nothing is requantised, so the picture is the
     * broadcast's own and the conversion costs almost nothing.
     *
     * A browser without an MPEG-2 decoder plays none of it, and says so by
     * failing the load rather than by showing anything, so this is worth
     * checking with `supportsPassthrough()` before setting it.
     */
    passthrough?: boolean;
    /**
     * How many workers convert pictures alongside the one running the
     * conversion.
     *
     * A group of pictures divides into frames that have nothing to say to each
     * other, so several can be converted at once; what cannot be divided --
     * demuxing, the plan, the muxing -- is under a tenth of the work. Left
     * unset, this follows `hardwareConcurrency` up to a small cap; 1 converts
     * every picture in the one worker, as before there was a pool.
     *
     * The output does not depend on it, and neither does playback: where a
     * worker cannot spawn workers there is simply no pool. The `workers` event
     * says what was settled on. Each worker costs its own scratch, which at an
     * HD macroblock count is tens of megabytes, so this is worth turning down
     * where memory matters more than speed.
     */
    pictureWorkers?: number;
    /**
     * Which service to convert, out of a transport stream carrying more than
     * one. Left unset, the first that turns up with a picture in it. The
     * `services` event says what a given input is offering.
     */
    serviceId?: number;
    /** Pause conversion above this many bytes waiting to be appended. */
    queueHighWaterMark?: number;
    /** Pause conversion while the buffer already reaches this far past the playhead. */
    maxAheadSeconds?: number;
    /** Seconds of played media to keep behind the playhead when evicting. */
    keepBehindSeconds?: number;
    /**
     * Whether to deinterlace what the element shows, and how. A transport stream
     * off the air is interlaced and stays that way through the conversion, so
     * without this the picture is combed wherever anything moved.
     *
     * The implementation is supplied separately through `deinterlacer`, so yadif,
     * bob, or another implementation can be selected without changing player.
     */
    deinterlace?: boolean;
    /** Construct the deinterlacer attached to this player's video element. */
    deinterlacer?: PlayerDeinterlacerFactory;
}
export interface Mpeg2TsPlayerEventMap {
    statechange: CustomEvent<{
        state: PlayerState;
    }>;
    progress: CustomEvent<Progress>;
    stats: CustomEvent<Stats>;
    /**
     * What services the transport stream announced, and which of them is being
     * converted. A recording of one programme announces one and there is nothing
     * to decide; one that carries a broadcaster's sub-channel as well leaves a
     * choice, which `serviceId` makes on the next `load()`. See `Services`.
     */
    services: CustomEvent<Services>;
    /**
     * What sound the programme is carrying and which of it is being taken.
     * Arrives once the program map has been read and again whenever either
     * changes -- a programme boundary that offers different streams, a broadcast
     * that turns dual mono on mid-programme, or a viewer's own choice taking
     * effect. `selectAudio` and `selectDualMono` are what act on it. See
     * `AudioTracks`.
     */
    audio: CustomEvent<AudioTracks>;
    /**
     * How many workers ended up converting pictures alongside the conversion,
     * which is zero where this browser would not have them and the pictures are
     * converted in the one worker as before. Arrives once per load.
     */
    workers: CustomEvent<{
        pictureWorkers: number;
    }>;
    /** A private_stream_1 (stream_id 0xbd) PES payload from the selected service. */
    private_stream_1: CustomEvent<PrivateStream>;
    /** A private_stream_2 (stream_id 0xbf) PES payload from the selected service. */
    private_stream_2: CustomEvent<PrivateStream>;
    /**
     * The input turned out to be one that can be seeked in, and this is how long
     * it is. Until this arrives -- and for a live stream it never does -- the
     * element has only what has been converted so far to offer a viewer.
     */
    seekable: CustomEvent<{
        duration: number;
    }>;
    /**
     * A step of the load happened, and this is how long it took to get there.
     * Every mark of one load is measured from the `load()` that started it, so
     * listening to this is enough to see where the time before the first frame
     * went. See `TimingMark` for the steps.
     */
    timing: CustomEvent<Timing>;
    /** Every failure, including the one that rejects a pending `load`. */
    error: CustomEvent<{
        error: Error;
    }>;
}
/**
 * Whether a worker can own the MediaSource.
 *
 * `canConstructInDedicatedWorker` is the feature detection the specification
 * provides, and it ships alongside the `srcObject` support a transferred
 * handle needs. Without it the page keeps the MediaSource, which is where
 * Firefox and Safari are today.
 *
 * The two implementations are asked separately, since a browser may expose one
 * to a worker and not the other: pass the same `preferManagedMediaSource` the
 * player will be given, or the answer is about the wrong one.
 */
export declare function supportsWorkerMediaSource(preferManagedMediaSource?: boolean): boolean;
/**
 * Whether this browser decodes the MPEG-2 the `passthrough` option hands it.
 *
 * Passing the video through costs almost nothing and leaves the picture
 * exactly as it was broadcast, but it is only playable where the browser has
 * an MPEG-2 decoder, which is not something to assume: ask here first and
 * convert to H.264 wherever the answer is no.
 *
 * The two implementations of Media Source Extensions answer for themselves, so
 * this takes the same `preferManagedMediaSource` the player will be given.
 */
export declare function supportsPassthrough(preferManagedMediaSource?: boolean): boolean;
/**
 * Plays an MPEG-2 transport stream in a `<video>` by converting it to H.264.
 *
 * ```ts
 * const player = new Mpeg2TsPlayer(video);
 * player.addEventListener('stats', (event) => show(event.detail.instantFps));
 * await player.load('https://example.com/video.ts');
 * ```
 *
 * `load` resolves once the source is attached and the first bytes are in, so
 * the element is playable; the conversion runs on past that and reports itself
 * through `progress`, `stats` and `statechange`. Failures always raise `error`,
 * and additionally reject a `load` that has not resolved yet.
 *
 * Seeking looks after itself: where the input is a file whose length and whose
 * middle a server will serve, the element gets a duration and the player
 * answers a seek outside the buffer by reading the input again from there.
 * Where it is not -- a live stream, a server that refuses byte ranges -- the
 * viewer has what has been converted so far, as before.
 */
export declare class Mpeg2TsPlayer extends EventTarget {
    #private;
    readonly video: HTMLVideoElement;
    constructor(video: HTMLVideoElement, options?: Mpeg2TsPlayerOptions);
    get state(): PlayerState;
    /**
     * How long the input is, or null while it is a stream that plays as it
     * arrives. The same number reaches the media element as its duration.
     */
    get duration(): number | null;
    /**
     * What sound the programme is carrying and which of it is being taken, or
     * null before its program map has been read. See `AudioTracks`.
     */
    get audio(): AudioTracks | null;
    /**
     * Take the sound from another of the service's streams from here on.
     *
     * From here on, and no further back: the fragments already converted carry
     * the sound they were made with and are in the buffer being played, so the
     * change arrives when the playhead reaches what is being converted now --
     * a few seconds on a live stream, and however far ahead the buffer has run
     * on a recording. Emptying the buffer to make it immediate would take the
     * picture with it.
     *
     * The PID is one of `audio.available`. One the program map has yet to name
     * is remembered until it does, so a page restoring a viewer's choice may
     * call this before the map arrives.
     */
    selectAudio(pid: number): void;
    /**
     * The same choice inside a dual-mono stream, where the two services are the
     * two channels of one stream rather than two streams.
     *
     * A bilingual broadcast in Japan is carried either way, and which way is not
     * the viewer's business: `audio.dualMono` says which control to offer. This
     * one describes nothing anew, so the change costs no restart point.
     */
    selectDualMono(sub: boolean): void;
    /** Which side of the wire ended up owning the MediaSource. */
    get mediaSourceOwner(): SinkKind;
    /**
     * Whether the picture is being deinterlaced, which is not quite the same as
     * having asked for it: a source that says it is progressive is left alone,
     * and starts being filtered again the moment it says otherwise. Assigning
     * turns it on or off where it stands, so the two can be compared on the
     * frame; a browser that cannot run it stays false.
     */
    get deinterlace(): boolean;
    /** Whether deinterlacing was asked for, whatever the source turned out to be. */
    get deinterlaceWanted(): boolean;
    /**
     * The deinterlacer itself, once there has been one, for the settings that
     * are its own -- the field order, and whether a picture goes up per field
     * or per frame. Null until `deinterlace` has been turned on.
     */
    get deinterlacer(): PlayerDeinterlacer | null;
    set deinterlace(enabled: boolean);
    load(url: string | URL): Promise<void>;
    /** Abandon the current load. The player stays usable. */
    stop(): void;
    /** Stop, and give up the worker. The player cannot be loaded again. */
    destroy(): void;
    addEventListener<K extends keyof Mpeg2TsPlayerEventMap>(type: K, listener: (event: Mpeg2TsPlayerEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
    removeEventListener<K extends keyof Mpeg2TsPlayerEventMap>(type: K, listener: (event: Mpeg2TsPlayerEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
}
//# sourceMappingURL=player.d.ts.map