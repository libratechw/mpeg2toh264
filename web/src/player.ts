/**
 * The page's half: a media element, a worker, and the wiring between them.
 *
 * Everything expensive happens in the worker -- fetching, converting, and on
 * browsers that allow it Media Source Extensions too. What is left here is
 * attaching the source to the element, moving the playhead, and telling the
 * worker where playback has got to.
 */
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
} from "./protocol.js";

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
}

export interface Mpeg2TsPlayerEventMap {
  statechange: CustomEvent<{ state: PlayerState }>;
  progress: CustomEvent<Progress>;
  stats: CustomEvent<Stats>;
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
  }

  get state(): PlayerState {
    return this.#state;
  }

  /** Which side of the wire ended up owning the MediaSource. */
  get mediaSourceOwner(): SinkKind {
    return this.#sinkKind;
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
    this.#playhead = setInterval(
      this.#reportPlayhead,
      PLAYHEAD_REPORT_INTERVAL_MS,
    );
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
    const sink = new MseSink({
      queueHighWaterMark:
        this.#options.queueHighWaterMark ?? DEFAULT_QUEUE_HIGH_WATER_MARK,
      keepBehindSeconds:
        this.#options.keepBehindSeconds ?? DEFAULT_KEEP_BEHIND_SECONDS,
      seek: (time) => {
        if (this.video.currentTime < time) this.video.currentTime = time;
      },
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
