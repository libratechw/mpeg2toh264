/**
 * The page's half: a media element, a worker, and the wiring between them.
 *
 * Everything expensive happens in the worker -- fetching, converting, and on
 * browsers that allow it Media Source Extensions too. What is left here is
 * attaching the source to the element, moving the playhead, and telling the
 * worker where playback has got to.
 */
import {
  mediaSourceConstructsInWorker,
  mediaSourceSupports,
  MseSink,
} from "./mse.js";
import {
  DEFAULT_KEEP_BEHIND_SECONDS,
  DEFAULT_MAX_AHEAD_SECONDS,
  DEFAULT_QUEUE_HIGH_WATER_MARK,
  PLAYHEAD_REPORT_INTERVAL_MS,
  type AudioTracks,
  type Command,
  type Notification,
  type PlayerState,
  type PrivateStream,
  type Progress,
  type Scan,
  type Services,
  type SinkKind,
  type Stats,
  type Timing,
  type TimingMark,
} from "./protocol.js";

/**
 * How far from the edge of a buffered range still counts as being at it.
 *
 * A media element stops a little before the last sample it holds -- it will not
 * start a frame it cannot finish -- and the ranges are reported to whatever
 * precision the buffer keeps them in. Both are well inside a frame.
 */
const GAP_EPSILON = 0.1;

/**
 * The media element events worth timing, in the order they normally arrive.
 *
 * These are the second half of the picture: everything before `opened` is what
 * this library did, and these are what the browser made of it. `waiting` is
 * the odd one out -- it says playback ran dry, which is the same measurement
 * read from the other end.
 */
const TIMED_EVENTS: TimingMark[] = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "playing",
  "waiting",
];

/** A replaceable deinterlacer controlled by the player's scan notifications. */
export interface PlayerDeinterlacer {
  readonly running: boolean;
  enabled: boolean;
  scan: Scan | null;
  codedSize?: { width: number; height: number; start: number } | null;
  destroy(): void;
}

export type PlayerDeinterlacerFactory = (
  video: HTMLVideoElement,
) => PlayerDeinterlacer;

export interface Mpeg2TsPlayerOptions {
  /** Where the `.wasm` is. Defaults to the copy sitting beside the worker. */
  wasmUrl?: string | URL;
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
  statechange: CustomEvent<{ state: PlayerState }>;
  progress: CustomEvent<Progress>;
  stats: CustomEvent<Stats>;
  /**
   * What the source said about its fields: whether the pictures are
   * interlaced, and which field came first. Arrives with the first fragment
   * converted and again whenever it changes. See `Scan`.
   */
  scan: CustomEvent<Scan>;
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
  workers: CustomEvent<{ pictureWorkers: number }>;
  /** A private_stream_1 (stream_id 0xbd) PES payload from the selected service. */
  private_stream_1: CustomEvent<PrivateStream>;
  /** A private_stream_2 (stream_id 0xbf) PES payload from the selected service. */
  private_stream_2: CustomEvent<PrivateStream>;
  /**
   * The input turned out to be one that can be seeked in, and this is how long
   * it is. Until this arrives -- and for a live stream it never does -- the
   * element has only what has been converted so far to offer a viewer.
   */
  seekable: CustomEvent<{ duration: number }>;
  /**
   * A step of the load happened, and this is how long it took to get there.
   * Every mark of one load is measured from the `load()` that started it, so
   * listening to this is enough to see where the time before the first frame
   * went. See `TimingMark` for the steps.
   */
  timing: CustomEvent<Timing>;
  /** Every failure, including the one that rejects a pending `load`. */
  error: CustomEvent<{ error: Error }>;
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
export function supportsWorkerMediaSource(
  preferManagedMediaSource = false,
): boolean {
  return mediaSourceConstructsInWorker(preferManagedMediaSource);
}

/** What a passthrough load opens its SourceBuffer with. */
const PASSTHROUGH_MIME = 'video/mp4; codecs="mp4v.61"';

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
export function supportsPassthrough(preferManagedMediaSource = false): boolean {
  return mediaSourceSupports(PASSTHROUGH_MIME, preferManagedMediaSource);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The one clock reading the page and the worker both understand. */
function now(): number {
  return performance.timeOrigin + performance.now();
}

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
export class Mpeg2TsPlayer extends EventTarget {
  readonly video: HTMLVideoElement;

  readonly #options: Mpeg2TsPlayerOptions;
  readonly #sinkKind: SinkKind;
  #worker: Worker | null = null;
  /** Which load messages belong to. Bumped by every load and every stop. */
  #generation = 0;
  #state: PlayerState = "idle";
  /** The sink, when the page owns the MediaSource. */
  #sink: MseSink | null = null;
  #objectUrl: string | null = null;
  /** The `<source>` child a Managed Media Source needs; see #attachManaged. */
  #source: HTMLSourceElement | null = null;
  /** Whether remote playback was turned off here, and so is ours to turn back. */
  #disabledRemotePlayback = false;
  #playhead: ReturnType<typeof setInterval> | null = null;
  #pending: { resolve: () => void; reject: (error: Error) => void } | null =
    null;
  /** How long the input is, when it turned out to be one that can be seeked. */
  #duration: number | null = null;
  /** What the source last said about its fields. See `Scan`. */
  #scan: Scan | null = null;
  /** What sound the programme last said it was carrying. See `AudioTracks`. */
  #audio: AudioTracks | null = null;
  /** When `load()` was called, as epoch milliseconds; every mark counts from it. */
  #loadedAt = 0;
  /** When the last mark was, so each one can say what it cost on its own. */
  #markedAt = 0;
  /** Built the first time deinterlacing is turned on, and kept after that. */
  #deinterlacer: PlayerDeinterlacer | null = null;
  #codedSize: { width: number; height: number; start: number } | null = null;
  /** Whether deinterlacing was asked for; whether it runs also needs `#scan`. */
  #wanted = false;
  #destroyed = false;

  constructor(video: HTMLVideoElement, options: Mpeg2TsPlayerOptions = {}) {
    super();
    this.video = video;
    this.#options = options;
    const preference = options.mediaSource ?? "auto";
    this.#sinkKind =
      preference === "auto"
        ? supportsWorkerMediaSource(options.preferManagedMediaSource)
          ? "worker"
          : "main"
        : preference;
    this.video.addEventListener("seeking", this.#onSeeking);
    for (const name of TIMED_EVENTS)
      this.video.addEventListener(name, this.#onTimedEvent);
    if (options.deinterlace) this.deinterlace = true;
  }

  get state(): PlayerState {
    return this.#state;
  }

  /**
   * How long the input is, or null while it is a stream that plays as it
   * arrives. The same number reaches the media element as its duration.
   */
  get duration(): number | null {
    return this.#duration;
  }

  /**
   * What the source last said about its fields, or null before the first
   * fragment of a load has been converted. See `Scan`.
   */
  get scan(): Scan | null {
    return this.#scan;
  }

  /**
   * What sound the programme is carrying and which of it is being taken, or
   * null before its program map has been read. See `AudioTracks`.
   */
  get audio(): AudioTracks | null {
    return this.#audio;
  }

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
  selectAudio(pid: number): void {
    this.#worker?.postMessage({
      type: "audio",
      id: this.#generation,
      pid,
      dualMonoSub: null,
    } satisfies Command);
  }

  /**
   * The same choice inside a dual-mono stream, where the two services are the
   * two channels of one stream rather than two streams.
   *
   * A bilingual broadcast in Japan is carried either way, and which way is not
   * the viewer's business: `audio.dualMono` says which control to offer. This
   * one describes nothing anew, so the change costs no restart point.
   */
  selectDualMono(sub: boolean): void {
    this.#worker?.postMessage({
      type: "audio",
      id: this.#generation,
      pid: null,
      dualMonoSub: sub,
    } satisfies Command);
  }

  /** Which side of the wire ended up owning the MediaSource. */
  get mediaSourceOwner(): SinkKind {
    return this.#sinkKind;
  }

  /**
   * Whether the picture is being deinterlaced, which is not quite the same as
   * having asked for it: a source that says it is progressive is left alone,
   * and starts being filtered again the moment it says otherwise. Assigning
   * turns it on or off where it stands, so the two can be compared on the
   * frame; a browser that cannot run it stays false.
   */
  get deinterlace(): boolean {
    return this.#deinterlacer?.running ?? false;
  }

  /** Whether deinterlacing was asked for, whatever the source turned out to be. */
  get deinterlaceWanted(): boolean {
    return this.#wanted;
  }

  /**
   * The deinterlacer itself, once there has been one, for the settings that
   * are its own -- the field order, and whether a picture goes up per field
   * or per frame. Null until `deinterlace` has been turned on.
   */
  get deinterlacer(): PlayerDeinterlacer | null {
    return this.#deinterlacer;
  }

  set deinterlace(enabled: boolean) {
    this.#wanted = enabled;
    this.#applyDeinterlace();
  }

  /**
   * Run the filter where it is both wanted and called for.
   *
   * A progressive source has one moment per frame and nothing to rebuild, so
   * filtering it can only soften it. Until the source has said which it is --
   * before the first fragment of a load -- what was asked for is what happens,
   * since an interlaced picture left unfiltered is the more visible mistake of
   * the two.
   */
  #applyDeinterlace(): void {
    if (this.#destroyed) return;
    try {
      if (this.#wanted && !this.#deinterlacer && this.#options.deinterlacer) {
        this.#deinterlacer = this.#options.deinterlacer(this.video);
      }
      if (this.#deinterlacer) {
        if (this.#codedSize) this.#deinterlacer.codedSize = this.#codedSize;
        this.#deinterlacer.scan = this.#scan;
        this.#deinterlacer.enabled = this.#wanted;
      }
    } catch (error) {
      // Without it the element shows its own picture, which is worth saying
      // and is not worth failing a load over.
      this.#emit("error", { error: toError(error) });
    }
  }

  #setCodedSize(width: number, height: number, start: number): void {
    if (width <= 0 || height <= 0) return;
    this.#codedSize = { width, height, start };
    if (this.#deinterlacer) this.#deinterlacer.codedSize = this.#codedSize;
  }

  load(url: string | URL): Promise<void> {
    if (this.#destroyed)
      return Promise.reject(new Error("the player has been destroyed"));
    this.#codedSize = null;
    if (this.#deinterlacer) this.#deinterlacer.codedSize = null;
    if (
      this.#sinkKind === "worker" &&
      !supportsWorkerMediaSource(this.#options.preferManagedMediaSource)
    ) {
      return Promise.reject(
        new Error("this browser cannot construct a MediaSource in a worker"),
      );
    }
    this.stop();
    const id = this.#generation;
    this.#duration = null;
    // Nothing is known about this source yet, so it gets whatever was asked
    // for until its first fragment says what it is.
    this.#scan = null;
    this.#applyDeinterlace();
    this.#loadedAt = now();
    this.#markedAt = this.#loadedAt;
    const worker = this.#ensureWorker();
    const promise = new Promise<void>((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
    this.#setState("loading");
    worker.postMessage({
      type: "load",
      id,
      url: String(url),
      wasmUrl:
        this.#options.wasmUrl === undefined
          ? null
          : String(this.#options.wasmUrl),
      oversample: this.#options.oversample,
      recoveryInterval: this.#options.recoveryInterval,
      openGopRecovery: this.#options.openGopRecovery,
      splitFieldSamples: this.#options.splitFieldSamples,
      passthrough: this.#options.passthrough ?? false,
      pictureWorkers: this.#options.pictureWorkers,
      serviceId: this.#options.serviceId ?? null,
      sink: this.#sinkKind,
      preferManagedMediaSource: this.#options.preferManagedMediaSource ?? false,
      queueHighWaterMark:
        this.#options.queueHighWaterMark ?? DEFAULT_QUEUE_HIGH_WATER_MARK,
      maxAheadSeconds:
        this.#options.maxAheadSeconds ?? DEFAULT_MAX_AHEAD_SECONDS,
      keepBehindSeconds:
        this.#options.keepBehindSeconds ?? DEFAULT_KEEP_BEHIND_SECONDS,
    } satisfies Command);
    this.#startPlayhead();
    return promise;
  }

  /** Abandon the current load. The player stays usable. */
  stop(): void {
    const id = this.#generation;
    this.#generation++;
    this.#worker?.postMessage({ type: "stop", id } satisfies Command);
    this.#teardown();
    this.#settle(new Error("the load was stopped"));
    this.#setState("idle");
  }

  /** Stop, and give up the worker. The player cannot be loaded again. */
  destroy(): void {
    if (this.#destroyed) return;
    this.stop();
    this.#destroyed = true;
    this.video.removeEventListener("seeking", this.#onSeeking);
    for (const name of TIMED_EVENTS)
      this.video.removeEventListener(name, this.#onTimedEvent);
    this.#deinterlacer?.destroy();
    this.#deinterlacer = null;
    this.#worker?.terminate();
    this.#worker = null;
  }

  override addEventListener<K extends keyof Mpeg2TsPlayerEventMap>(
    type: K,
    listener: (event: Mpeg2TsPlayerEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
  }

  override removeEventListener<K extends keyof Mpeg2TsPlayerEventMap>(
    type: K,
    listener: (event: Mpeg2TsPlayerEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
  }

  #ensureWorker(): Worker {
    if (!this.#worker) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = this.#onMessage;
      worker.onerror = (event) =>
        this.#fail(new Error(event.message || "the worker failed"));
      this.#worker = worker;
    }
    return this.#worker;
  }

  #onMessage = (event: MessageEvent<Notification>): void => {
    const notification = event.data;
    if (notification.id !== this.#generation) return;
    switch (notification.type) {
      case "handle":
        // A handle is attached the one way it can be, so the `<source>` child
        // #attachManaged uses is not on offer here; what a managed source
        // still needs is the element to have given up remote playback.
        if (notification.managed) this.#disableRemotePlayback();
        // MediaProvider was last widened before MSE in Workers shipped, so it
        // still does not list MediaSourceHandle. This assignment is the entire
        // point of the handle.
        this.video.srcObject = notification.handle as unknown as MediaProvider;
        this.#mark("attached", now());
        break;
      case "open":
        this.#openSink(notification.mimeCodec, notification.data);
        break;
      case "video-config":
        this.#setCodedSize(
          notification.width,
          notification.height,
          notification.start,
        );
        break;
      case "fragment":
        this.#sink?.push(
          notification.data,
          notification.start,
          notification.randomAccess,
        );
        break;
      case "opened":
        this.#setState("converting");
        this.#settle(null);
        break;
      case "seekable":
        this.#duration = notification.duration;
        this.#sink?.setDuration(notification.duration);
        this.#emit("seekable", { duration: notification.duration });
        break;
      case "reset":
        this.#sink?.reset();
        break;
      case "scan":
        this.#scan = notification.scan;
        // The one setting the filter cannot guess at. Everything else about it
        // is a preference; this is a fact about the picture, and getting it
        // wrong moves every other line half a field the wrong way.
        this.#applyDeinterlace();
        this.#emit("scan", notification.scan);
        break;
      case "workers":
        this.#emit("workers", {
          pictureWorkers: notification.pictureWorkers,
        });
        break;
      case "services":
        this.#emit("services", notification.services);
        break;
      case "audio":
        this.#audio = notification.audio;
        this.#emit("audio", notification.audio);
        break;
      case "private_stream_1":
      case "private_stream_2":
        this.#emit(notification.type, notification.stream);
        break;
      case "mark":
        this.#mark(notification.name, notification.at);
        break;
      case "seek":
        if (this.video.currentTime < notification.time)
          this.video.currentTime = notification.time;
        break;
      case "progress":
        this.#emit("progress", {
          bytesRead: notification.bytesRead,
          totalBytes: notification.totalBytes,
        });
        break;
      case "stats":
        this.#emit("stats", notification.stats);
        break;
      case "blocked":
        this.#setState(notification.blocked ? "buffer-full" : "converting");
        break;
      case "finish":
        this.#drainSink();
        break;
      case "completed":
        this.#setState("completed");
        // Nothing more will be appended, so the buffer cannot fill again and
        // the worker has no further use for the playhead. The page path waits
        // for its own queue to drain instead; see #drainSink.
        if (this.#sinkKind === "worker") this.#stopPlayhead();
        break;
      case "error":
        this.#fail(new Error(notification.message));
        break;
    }
  };

  /** Open a MediaSource here, for browsers that cannot have one in a worker. */
  #openSink(mimeCodec: string, data: ArrayBuffer): void {
    const id = this.#generation;
    // A seek opens the stream again, with the initialization segment of
    // wherever it landed. The MediaSource behind it is the same one: rebuilding
    // it would take the element's playback state with it.
    let sink: MseSink;
    try {
      // Making one is where a browser with no Media Source Extensions at all
      // says so, and the load is what has to hear it.
      sink = this.#sink ?? this.#createSink(id);
    } catch (error) {
      this.#fail(toError(error));
      return;
    }
    sink.open(mimeCodec, data).then(
      // The worker is waiting on flow to know the open succeeded. Going
      // through ready() rather than saying true covers the case where the
      // append filled the queue on its own.
      () =>
        sink
          .ready()
          .then(() => this.#report(id, { type: "flow", id, ready: true })),
      (error: unknown) => {
        if (id === this.#generation) this.#fail(toError(error));
      },
    );
  }

  #createSink(id: number): MseSink {
    const sink = new MseSink({
      preferManaged: this.#options.preferManagedMediaSource,
      queueHighWaterMark:
        this.#options.queueHighWaterMark ?? DEFAULT_QUEUE_HIGH_WATER_MARK,
      maxAheadSeconds:
        this.#options.maxAheadSeconds ?? DEFAULT_MAX_AHEAD_SECONDS,
      keepBehindSeconds:
        this.#options.keepBehindSeconds ?? DEFAULT_KEEP_BEHIND_SECONDS,
      seek: (time) => {
        if (this.video.currentTime < time) this.video.currentTime = time;
      },
      onMark: (name) => this.#mark(name, now()),
      onReadyChange: (ready) => this.#report(id, { type: "flow", id, ready }),
      onBlocked: (blocked) => {
        if (id === this.#generation)
          this.#setState(blocked ? "buffer-full" : "converting");
      },
      onError: (error) => {
        if (id === this.#generation) this.#fail(error);
      },
    });
    this.#sink = sink;
    this.#objectUrl = URL.createObjectURL(sink.mediaSource);
    if (sink.managed) this.#attachManaged(this.#objectUrl);
    else this.video.src = this.#objectUrl;
    this.#mark("attached", now());
    if (this.#duration !== null) sink.setDuration(this.#duration);
    return sink;
  }

  /**
   * Put a Managed Media Source on the element, which takes more than a `src`.
   *
   * Safari leaves one closed until the element has given up remote playback --
   * AirPlay has nowhere to send a source the page is feeding, so the two are
   * mutually exclusive -- and until the URL is on a `<source>` child rather
   * than the attribute. Neither is optional: miss one and `sourceopen` never
   * arrives and the load waits for a stream that has not begun.
   */
  #attachManaged(url: string): void {
    this.video.removeAttribute("src");
    this.#disableRemotePlayback();
    const source = document.createElement("source");
    source.type = "video/mp4";
    source.src = url;
    this.video.append(source);
    this.#source = source;
    // A source child is not a src: nothing is loaded until the element is told
    // to look at what it has been given.
    this.video.load();
  }

  /**
   * Rule out AirPlay, which a managed source cannot be sent over and which
   * Safari will not open one until the element has given up. The element
   * belongs to whoever made it, so it is put back on the way out -- unless it
   * was already off, and theirs to keep.
   */
  #disableRemotePlayback(): void {
    if (this.video.disableRemotePlayback) return;
    this.video.disableRemotePlayback = true;
    this.#disabledRemotePlayback = true;
  }

  #drainSink(): void {
    const id = this.#generation;
    const sink = this.#sink;
    if (!sink) return;
    sink.finish().then(
      () => {
        if (id === this.#generation) this.#stopPlayhead();
      },
      (error: unknown) => {
        if (id === this.#generation) this.#fail(toError(error));
      },
    );
  }

  /**
   * Answer the viewer moving the playhead somewhere the buffer does not reach.
   *
   * Everything inside a buffered range is Media Source Extensions' own affair,
   * including the correction #startAtMedia asks for, so those go no further.
   * What is left is a real seek: the worker throws the buffer away and reads
   * the input again from where the viewer asked to be.
   */
  #onSeeking = (): void => {
    if (this.#duration === null) return;
    if (this.#state === "idle" || this.#state === "error") return;
    const time = this.video.currentTime;
    if (this.#isBuffered(time)) return;
    this.#setState("seeking");
    // A load that had run to the end stopped reporting the playhead, and the
    // buffer it left behind is about to start filling again.
    this.#startPlayhead();
    this.#worker?.postMessage({
      type: "seek",
      id: this.#generation,
      time,
    } satisfies Command);
  };

  #onTimedEvent = (event: Event): void => {
    if (this.#state === "idle") return;
    this.#mark(event.type as TimingMark, now());
    if (event.type === "waiting") this.#crossGap();
  };

  /**
   * Move the playhead over a hole in the media, where playback has stopped at
   * one.
   *
   * The conversion leaves the media where the source put it, so a recording
   * joined from two takes has a real gap between them rather than one closed up
   * -- closing it would move everything after it, and the captions, which carry
   * the source's own timestamps, would be out by the length of the gap for the
   * rest of the stream. A browser stops at a gap and waits, so somebody has to
   * step over it, and it is this side: it is the one that knows the playhead.
   *
   * Only where media is already buffered past the hole, which is what
   * distinguishes a hole from the ordinary wait for the converter to catch up.
   *
   * Read from the media element rather than from the sink: what stops playback
   * is the element's own view, which is the tracks' ranges taken together, and
   * it is the one reading available whether the `MediaSource` is here or in the
   * worker.
   */
  #crossGap(): void {
    if (this.video.seeking) return;
    const time = this.video.currentTime;
    const buffered = this.video.buffered;
    let next: number | null = null;
    for (let index = 0; index < buffered.length; index++) {
      const start = buffered.start(index);
      // Inside a range with media still ahead: whatever the wait is, it is not
      // a hole.
      if (
        time >= start - GAP_EPSILON &&
        time < buffered.end(index) - GAP_EPSILON
      )
        return;
      if (start > time + GAP_EPSILON && (next === null || start < next))
        next = start;
    }
    if (next !== null) this.video.currentTime = next;
  }

  /**
   * Report where a step of the load fell on the clock `load()` started.
   *
   * The worker's marks arrive as epoch milliseconds because that is the only
   * reading the two contexts share; what a caller wants is how long it waited,
   * which is measured from here.
   */
  #mark(name: TimingMark, at: number): void {
    if (this.#loadedAt === 0) return;
    const sinceLoad = at - this.#loadedAt;
    // A mark can only be behind the one before it when the two clocks disagree
    // over the last fraction of a millisecond, which is not worth reporting.
    const sincePrevious = Math.max(0, at - this.#markedAt);
    this.#markedAt = Math.max(this.#markedAt, at);
    this.#emit("timing", { name, sinceLoad, sincePrevious });
  }

  #isBuffered(time: number): boolean {
    const buffered = this.video.buffered;
    for (let index = 0; index < buffered.length; index++) {
      if (time >= buffered.start(index) && time < buffered.end(index))
        return true;
    }
    return false;
  }

  /**
   * Tell whoever holds the buffer where playback is, so it can drop what is
   * behind. This cannot ride on `timeupdate`: that event stops firing exactly
   * when playback stalls, which is when eviction matters most.
   */
  #reportPlayhead = (): void => {
    const currentTime = this.video.currentTime;
    if (this.#sinkKind === "main") this.#sink?.setCurrentTime(currentTime);
    else
      this.#worker?.postMessage({
        type: "time",
        id: this.#generation,
        currentTime,
      });
  };

  #report(id: number, command: Command): void {
    if (id === this.#generation) this.#worker?.postMessage(command);
  }

  #startPlayhead(): void {
    if (this.#playhead !== null) return;
    this.#playhead = setInterval(
      this.#reportPlayhead,
      PLAYHEAD_REPORT_INTERVAL_MS,
    );
  }

  #stopPlayhead(): void {
    if (this.#playhead === null) return;
    clearInterval(this.#playhead);
    this.#playhead = null;
  }

  #teardown(): void {
    this.#stopPlayhead();
    this.#sink?.close();
    this.#sink = null;
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = null;
    this.#source?.remove();
    this.#source = null;
    if (this.#disabledRemotePlayback) {
      this.video.disableRemotePlayback = false;
      this.#disabledRemotePlayback = false;
    }
    this.video.removeAttribute("src");
    this.video.srcObject = null;
    this.video.load();
  }

  #fail(error: Error): void {
    this.#teardown();
    this.#setState("error");
    this.#settle(error);
    this.#emit("error", { error });
  }

  #settle(error: Error | null): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    if (error) pending.reject(error);
    else pending.resolve();
  }

  #setState(state: PlayerState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit("statechange", { state });
  }

  #emit<K extends keyof Mpeg2TsPlayerEventMap>(
    type: K,
    detail: Mpeg2TsPlayerEventMap[K]["detail"],
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
