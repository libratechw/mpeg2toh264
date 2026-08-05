/**
 * The page's half: a media element, a worker, and the wiring between them.
 *
 * Everything expensive happens in the worker -- fetching, converting, and on
 * browsers that allow it Media Source Extensions too. What is left here is
 * attaching the source to the element, moving the playhead, and telling the
 * worker where playback has got to.
 */
import {
  Deinterlacer,
  supportsDeinterlace,
  type DeinterlacerOptions,
  type DeinterlaceStats,
} from "./deinterlace.js";
import { MseSink } from "./mse.js";
import {
  DEFAULT_KEEP_BEHIND_SECONDS,
  DEFAULT_QUEUE_HIGH_WATER_MARK,
  PLAYHEAD_REPORT_INTERVAL_MS,
  type Command,
  type Notification,
  type PlayerState,
  type Progress,
  type SinkKind,
  type Stats,
  type Timing,
  type TimingMark,
} from "./protocol.js";

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

export interface Mpeg2TsPlayerOptions {
  /** Where the `.wasm` is. Defaults to the copy sitting beside the worker. */
  wasmUrl?: string | URL;
  /**
   * Which side runs MediaSource. `'auto'` takes the worker wherever the
   * browser has MSE in Workers, and the page otherwise.
   */
  mediaSource?: "auto" | "worker" | "main";
  /** The quantiser search factor. Higher is slower and closer to the source. */
  oversample?: number;
  /** Pause conversion above this many bytes waiting to be appended. */
  queueHighWaterMark?: number;
  /** Seconds of played media to keep behind the playhead when evicting. */
  keepBehindSeconds?: number;
  /**
   * Whether to deinterlace what the element shows, and how. A transport stream
   * off the air is interlaced and stays that way through the conversion, so
   * without this the picture is combed wherever anything moved.
   *
   * The deinterlacer covers the element with a canvas of its own, which means
   * covering the element's own controls; see `Deinterlacer`. Off by default
   * for that reason. It can be turned on and off while playing.
   */
  deinterlace?: boolean | DeinterlacerOptions;
}

export interface Mpeg2TsPlayerEventMap {
  statechange: CustomEvent<{ state: PlayerState }>;
  progress: CustomEvent<Progress>;
  stats: CustomEvent<Stats>;
  /**
   * How the deinterlacer is getting on, about once a second while frames are
   * arriving. Only while it is on, and only on a browser that can run it.
   */
  deinterlace: CustomEvent<DeinterlaceStats>;
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
 */
export function supportsWorkerMediaSource(): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    MediaSource.canConstructInDedicatedWorker === true
  );
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
  #playhead: ReturnType<typeof setInterval> | null = null;
  #pending: { resolve: () => void; reject: (error: Error) => void } | null =
    null;
  /** How long the input is, when it turned out to be one that can be seeked. */
  #duration: number | null = null;
  /** When `load()` was called, as epoch milliseconds; every mark counts from it. */
  #loadedAt = 0;
  /** When the last mark was, so each one can say what it cost on its own. */
  #markedAt = 0;
  /** Built the first time deinterlacing is turned on, and kept after that. */
  #deinterlacer: Deinterlacer | null = null;
  #destroyed = false;

  constructor(video: HTMLVideoElement, options: Mpeg2TsPlayerOptions = {}) {
    super();
    this.video = video;
    this.#options = options;
    const preference = options.mediaSource ?? "auto";
    this.#sinkKind =
      preference === "auto"
        ? supportsWorkerMediaSource()
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

  /** Which side of the wire ended up owning the MediaSource. */
  get mediaSourceOwner(): SinkKind {
    return this.#sinkKind;
  }

  /**
   * Whether the picture is being deinterlaced. Assigning to it turns the
   * deinterlacer on or off where it stands, so the two can be compared on the
   * frame; a browser that cannot run it stays false.
   */
  get deinterlace(): boolean {
    return this.#deinterlacer?.running ?? false;
  }

  set deinterlace(enabled: boolean) {
    if (!enabled) {
      this.#deinterlacer?.stop();
      return;
    }
    if (this.#destroyed || !supportsDeinterlace()) return;
    const options =
      typeof this.#options.deinterlace === "object"
        ? this.#options.deinterlace
        : {};
    try {
      this.#deinterlacer ??= new Deinterlacer(this.video, {
        ...options,
        onStats: (stats) => {
          options.onStats?.(stats);
          this.#emit("deinterlace", stats);
        },
      });
      this.#deinterlacer.start();
    } catch (error) {
      // Without it the element shows its own picture, which is worth saying
      // and is not worth failing a load over.
      this.#emit("error", { error: toError(error) });
    }
  }

  load(url: string | URL): Promise<void> {
    if (this.#destroyed)
      return Promise.reject(new Error("the player has been destroyed"));
    if (this.#sinkKind === "worker" && !supportsWorkerMediaSource()) {
      return Promise.reject(
        new Error("this browser cannot construct a MediaSource in a worker"),
      );
    }
    this.stop();
    const id = this.#generation;
    this.#duration = null;
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
      sink: this.#sinkKind,
      queueHighWaterMark:
        this.#options.queueHighWaterMark ?? DEFAULT_QUEUE_HIGH_WATER_MARK,
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
        // MediaProvider was last widened before MSE in Workers shipped, so it
        // still does not list MediaSourceHandle. This assignment is the entire
        // point of the handle.
        this.video.srcObject = notification.handle as unknown as MediaProvider;
        this.#mark("attached", now());
        break;
      case "open":
        this.#openSink(notification.mimeCodec, notification.data);
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
    const sink = this.#sink ?? this.#createSink(id);
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
      queueHighWaterMark:
        this.#options.queueHighWaterMark ?? DEFAULT_QUEUE_HIGH_WATER_MARK,
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
    this.video.src = this.#objectUrl;
    this.#mark("attached", now());
    if (this.#duration !== null) sink.setDuration(this.#duration);
    return sink;
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
  };

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
