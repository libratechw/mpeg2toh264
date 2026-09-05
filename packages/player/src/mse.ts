/**
 * Feeding Media Source Extensions, from wherever the `MediaSource` lives.
 *
 * This module compiles into both programs: on the page it uses the DOM's MSE
 * declarations, in the worker the ones in worker-mse.d.ts. Nothing here
 * touches a media element -- the two things that need one, moving the playhead
 * and reading it, go through `seek` and `setCurrentTime` -- so the same buffer
 * management runs whether MSE is on the page or in the worker.
 */
import { QUEUE_HIGH_WATER_FRAGMENTS } from "./protocol.js";

/**
 * How far short of a restart point a removal stops, in seconds.
 *
 * `remove` takes seconds as a double and the browser rounds them into its own
 * time base, so asking it to stop exactly on a frame is asking it to agree
 * about the last bit of a repeating fraction. It does not always: 68540 ticks
 * of 90 kHz is 0.7615555555555555 either way round, and one unit in the last
 * place on the wrong side puts that frame inside the range. That frame is the
 * random access point, and removing one takes everything after it as well, as
 * far as the *next* random access point -- twelve seconds of media, gone,
 * including whatever was about to be shown.
 *
 * Stopping a little short leaves the point safely outside. It has to be less
 * than one frame, or the frame before the point survives instead, and being no
 * random access point itself it carries the removal onward just the same.
 */
const REMOVE_MARGIN_SECONDS = 0.001;

/** Whatever this browser calls the thing a `SourceBuffer` is appended to. */
type MediaSourceConstructor = {
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
  /**
   * Whether a worker may own one. Optional because the managed one is reached
   * through `globalThis`, where nothing guarantees it answers at all.
   */
  readonly canConstructInDedicatedWorker?: boolean;
};

/**
 * Managed Media Source, where there is one.
 *
 * An iPhone has no `MediaSource` at all -- Safari gives iOS this instead, and
 * a page that only knows the older name plays nothing there. It is the same
 * API with the user agent in charge of the buffer: it says through
 * `startstreaming` and `endstreaming` when it wants data and when it has
 * enough, and it may hand memory back on its own rather than waiting to be
 * asked. Both are things a producer should listen to, which is what `#streaming`
 * below is for.
 *
 * Reached through `globalThis` because neither lib.dom.d.ts nor
 * lib.webworker.d.ts declares it (checked against TypeScript 5.9), and typed
 * as its unmanaged twin because everything used here is common to the two.
 */
const managedMediaSource = (
  globalThis as { ManagedMediaSource?: MediaSourceConstructor }
).ManagedMediaSource;

/**
 * Which of the two to open, given whether the managed one is preferred.
 *
 * Where a browser has both -- Safari on a Mac or an iPad -- the plain one is
 * taken by default: it is the one whose eviction this file was written
 * against, and the buffer stays the page's own business. `preferManaged`
 * asks for the other, which is worth doing to see on a desktop what an iPhone
 * will do. Null where the browser has neither.
 */
function mediaSourceClass(
  preferManaged = false,
): MediaSourceConstructor | null {
  const plain: MediaSourceConstructor | null =
    typeof MediaSource === "undefined" ? null : MediaSource;
  if (preferManaged && managedMediaSource) return managedMediaSource;
  return plain ?? managedMediaSource ?? null;
}

/**
 * Whether Media Source Extensions here will take this codec.
 *
 * Asking the constructor that would be opened rather than `MediaSource`, which
 * on an iPhone is not there to be asked.
 */
export function mediaSourceSupports(mimeCodec: string, preferManaged = false) {
  return mediaSourceClass(preferManaged)?.isTypeSupported(mimeCodec) ?? false;
}

/**
 * Whether a worker may own the one that would be opened.
 *
 * The two answer for themselves: MSE in Workers is Chromium's, and Chromium
 * has no managed source, so the managed answer is no everywhere today. It is
 * asked rather than assumed because the exposure is the specification's to
 * widen, not this player's to decide.
 */
export function mediaSourceConstructsInWorker(preferManaged = false): boolean {
  return (
    mediaSourceClass(preferManaged)?.canConstructInDedicatedWorker === true
  );
}

/** Whether this browser has a Managed Media Source to open at all. */
export function supportsManagedMediaSource(): boolean {
  return managedMediaSource !== undefined;
}

/**
 * Whether the managed one is all there is, as it is on an iPhone. A player
 * there opens one whatever it was asked for, which is worth showing a viewer
 * who is being offered the choice.
 */
export function requiresManagedMediaSource(): boolean {
  return typeof MediaSource === "undefined" && managedMediaSource !== undefined;
}

/** Where a producer hands fragments, and how it learns to slow down. */
export interface FragmentSink {
  /** Resolves once there is room for more fragments. */
  ready(): Promise<void>;
  /** Take the initialization segment and open the stream for `mimeCodec`. */
  open(mimeCodec: string, data: ArrayBuffer): Promise<void>;
  push(data: ArrayBuffer, start: number, randomAccess: boolean): void;
  /**
   * Throw away everything buffered and everything queued, and expect the
   * fragments after this to belong somewhere else on the timeline.
   */
  reset(): void;
  /** No more fragments: drain what is queued and end the stream. */
  finish(): Promise<void>;
  /** Give up, releasing anyone waiting on `ready` or `finish`. */
  close(): void;
}

/** A latch a producer can await, so backpressure costs no polling. */
export class ReadyGate {
  #open = true;
  #waiting: (() => void)[] = [];

  get open(): boolean {
    return this.#open;
  }

  /** Returns whether this changed anything. */
  set(open: boolean): boolean {
    if (open === this.#open) return false;
    this.#open = open;
    if (open) this.#release();
    return true;
  }

  wait(): Promise<void> {
    if (this.#open) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  /** Let everyone through whatever the state is, for teardown. */
  abandon(): void {
    this.#release();
  }

  #release(): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const resolve of waiting) resolve();
  }
}

export interface MseSinkOptions {
  /**
   * Open a Managed Media Source where the browser has both. An iPhone has only
   * the managed one and gets it either way. See `mediaSourceClass`.
   */
  preferManaged?: boolean;
  /** Stop taking fragments above this many bytes waiting to be appended. */
  queueHighWaterMark: number;
  /** Stop taking fragments while the buffer reaches this far past the playhead. */
  maxAheadSeconds: number;
  /** Seconds of played media to keep behind the playhead when evicting. */
  keepBehindSeconds: number;
  /** Move the playhead, which only whoever holds the media element can do. */
  seek(time: number): void;
  /** Whether there is room for more fragments. */
  onReadyChange?(ready: boolean): void;
  /** Whether the media buffer is full and conversion has to wait. */
  onBlocked?(blocked: boolean): void;
  /**
   * A step worth timing: `sourceopen` when the media element has taken the
   * MediaSource, and `appended` when the first media segment is in the buffer.
   * The two bracket everything MSE does before playback can begin.
   */
  onMark?(name: "sourceopen" | "appended"): void;
  onError?(error: Error): void;
}

interface Pending {
  data: ArrayBuffer;
  /** The initialization segment buffers no media, so it places no playhead. */
  init: boolean;
}

type Operation =
  // An updateend belongs to the entry and timeline that started it. A reset
  // may replace the queue before the browser finishes the old append.
  | { type: "append"; pending: Pending; epoch: number }
  | { type: "remove" | "clear" };

export class MseSink implements FragmentSink {
  /**
   * Made in the constructor rather than in `open`, because a caller needs
   * something to attach before the codec is known: the worker sends
   * `mediaSource.handle` across the moment a load starts, and `sourceopen`
   * does not fire until the page has put it on the element -- long before the
   * first init fragment.
   */
  readonly mediaSource: MediaSource;

  /**
   * Whether that is a Managed Media Source, which a media element takes in its
   * own way. See the player's `#createSink`.
   */
  readonly managed: boolean;

  /** The one the source was made from, and the one that answers for codecs. */
  readonly #class: MediaSourceConstructor;
  readonly #options: MseSinkOptions;
  readonly #opened: Promise<void>;
  #sourceBuffer: SourceBuffer | null = null;
  /** What the `SourceBuffer` was opened with, or last changed to. */
  #mimeCodec = "";
  /** A codec to move the `SourceBuffer` to before the next append. */
  #retype: string | null = null;
  #queue: Pending[] = [];
  #queuedBytes = 0;
  #operation: Operation | null = null;
  #quotaBlocked = false;
  /**
   * Whether a managed source wants data at the moment.
   *
   * True until told otherwise, and always true for an unmanaged source, which
   * takes whatever it is given. A managed one starts out not streaming and
   * asks once it is attached and playing, so waiting for permission before the
   * initialization segment would mean waiting for a player that never starts:
   * this holds the door open until `endstreaming` closes it.
   */
  #streaming = true;
  /** The last thing said about there being no room, so it is said once. */
  #blocked = false;
  /** Whether everything buffered is waiting to be thrown away; see `reset`. */
  #clearing = false;
  /** Which stretch of timeline is being filled. Bumped by every `reset`. */
  #epoch = 0;
  /** A duration to put on the MediaSource as soon as it will take one. */
  #pendingDuration: number | null = null;
  /** Media times a decoder can start from, in order; see #evict. */
  #randomAccessPoints: number[] = [];
  /** Whether the playhead has been put where the media starts; see #startAtMedia. */
  #playheadPlaced = false;
  #currentTime = 0;
  #closed = false;
  #ending = false;
  readonly #room = new ReadyGate();
  #drained: (() => void)[] = [];

  constructor(options: MseSinkOptions) {
    this.#options = options;
    const source = mediaSourceClass(options.preferManaged);
    if (!source) throw new Error("this browser has no Media Source Extensions");
    this.#class = source;
    this.mediaSource = new source();
    this.managed = source === managedMediaSource;
    if (this.managed) {
      this.mediaSource.addEventListener(
        "startstreaming",
        this.#onStartStreaming,
      );
      this.mediaSource.addEventListener("endstreaming", this.#onEndStreaming);
    }
    this.#opened = new Promise((resolve) => {
      this.mediaSource.addEventListener(
        "sourceopen",
        () => {
          options.onMark?.("sourceopen");
          resolve();
        },
        { once: true },
      );
    });
  }

  ready(): Promise<void> {
    return this.#room.wait();
  }

  /**
   * Open the stream, or -- for the initialization segment a seek brings with
   * it -- re-open the one already running.
   */
  async open(mimeCodec: string, data: ArrayBuffer): Promise<void> {
    if (!this.#class.isTypeSupported(mimeCodec))
      throw new Error(`unsupported codec: ${mimeCodec}`);
    await this.#opened;
    if (this.#closed) return;
    if (!this.#sourceBuffer) {
      try {
        const sourceBuffer = this.mediaSource.addSourceBuffer(mimeCodec);
        sourceBuffer.mode = "segments";
        sourceBuffer.addEventListener("updateend", this.#onUpdateEnd);
        sourceBuffer.addEventListener("error", this.#onSourceBufferError);
        this.#sourceBuffer = sourceBuffer;
        this.#mimeCodec = mimeCodec;
      } catch (error) {
        throw this.#error("add or configure SourceBuffer", error);
      }
    } else if (mimeCodec !== this.#mimeCodec) {
      // Resuming elsewhere in the same file can turn up a different profile,
      // and only changeType lets a SourceBuffer accept one. It cannot run
      // while an append is in flight, so it waits with the segment it belongs
      // to; see #pump.
      this.#retype = mimeCodec;
    }
    this.#enqueue({ data, init: true });
    this.#applyDuration();
  }

  push(data: ArrayBuffer, start: number, randomAccess: boolean): void {
    if (this.#closed) return;
    if (randomAccess) this.#randomAccessPoints.push(start);
    this.#enqueue({ data, init: false });
  }

  /**
   * How long the whole presentation is.
   *
   * Without this the media element has no timeline to offer a viewer: it is
   * what turns `seekable` into the length of the file rather than the length
   * of what has been converted so far.
   */
  setDuration(seconds: number): void {
    this.#pendingDuration = seconds;
    this.#applyDuration();
  }

  /**
   * Throw away everything buffered and everything queued.
   *
   * A seek lands somewhere the buffer does not reach, and what follows it is
   * a different part of the file: keeping the old media would leave the
   * timeline with a hole in the middle and the eviction bookkeeping describing
   * bytes that are no longer there.
   */
  reset(): void {
    if (this.#closed) return;
    this.#epoch++;
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#randomAccessPoints = [];
    this.#playheadPlaced = false;
    this.#ending = false;
    this.#quotaBlocked = false;
    this.#updateBlocked();
    if (this.#sourceBuffer) this.#clearing = true;
    // Whoever was waiting on the drain is waiting for a stream that is not
    // being ended after all.
    this.#settleDrain(true);
    this.#updateRoom();
    this.#pump();
  }

  async finish(): Promise<void> {
    this.#ending = true;
    // Nothing was ever opened, so there is nothing to drain and no stream to
    // end -- an input we could make no track out of takes this path.
    if (this.#closed || !this.#sourceBuffer) return;
    const epoch = this.#epoch;
    await new Promise<void>((resolve) => {
      this.#drained.push(resolve);
      this.#pump();
    });
    // A seek during the drain releases this without the queue having emptied,
    // and what follows is a stream that is not ending after all.
    if (this.#closed || this.#epoch !== epoch) return;
    if (this.mediaSource.readyState === "open") {
      try {
        this.mediaSource.endOfStream();
      } catch (error) {
        throw this.#error("end MediaSource", error);
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.managed) {
      this.mediaSource.removeEventListener(
        "startstreaming",
        this.#onStartStreaming,
      );
      this.mediaSource.removeEventListener(
        "endstreaming",
        this.#onEndStreaming,
      );
    }
    this.#sourceBuffer?.removeEventListener("updateend", this.#onUpdateEnd);
    this.#sourceBuffer?.removeEventListener("error", this.#onSourceBufferError);
    this.#sourceBuffer = null;
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#randomAccessPoints = [];
    this.#room.abandon();
    this.#settleDrain(true);
  }

  /** Tell the sink where playback has got to, so it can evict what is behind. */
  setCurrentTime(time: number): void {
    this.#currentTime = time;
    this.#evict();
    this.#updateRoom();
    this.#pump();
  }

  #enqueue(pending: Pending): void {
    this.#queue.push(pending);
    this.#queuedBytes += pending.data.byteLength;
    this.#updateRoom();
    this.#pump();
  }

  #pump(): void {
    const sourceBuffer = this.#sourceBuffer;
    if (
      this.#closed ||
      !sourceBuffer ||
      sourceBuffer.updating ||
      this.#operation
    )
      return;
    // Emptying the buffer comes before anything queued behind it, and settles
    // the quota on its own.
    if (this.#clearing) {
      this.#operation = { type: "clear" };
      try {
        sourceBuffer.remove(0, Number.POSITIVE_INFINITY);
      } catch (error) {
        this.#operation = null;
        this.#clearing = false;
        this.#fail("clear SourceBuffer", error);
      }
      return;
    }
    if (this.#quotaBlocked) return;
    const next = this.#queue[0];
    if (!next) {
      this.#settleDrain(false);
      return;
    }
    if (this.#retype !== null) {
      const mimeCodec = this.#retype;
      this.#retype = null;
      try {
        sourceBuffer.changeType(mimeCodec);
        this.#mimeCodec = mimeCodec;
      } catch (error) {
        this.#fail("change SourceBuffer type", error);
        return;
      }
    }
    this.#operation = { type: "append", pending: next, epoch: this.#epoch };
    try {
      sourceBuffer.appendBuffer(next.data);
    } catch (error) {
      this.#operation = null;
      if (
        error instanceof DOMException &&
        error.name === "QuotaExceededError"
      ) {
        this.#quotaBlocked = true;
        this.#updateRoom();
        this.#updateBlocked();
        // Try at once rather than waiting for playback to raise an event: if
        // the buffer ahead runs out first, nothing will raise one.
        this.#evict();
      } else this.#fail("append SourceBuffer", error);
    }
  }

  #onUpdateEnd = (): void => {
    const operation = this.#operation;
    if (operation?.type === "append") {
      if (
        operation.epoch === this.#epoch &&
        this.#queue[0] === operation.pending
      ) {
        const appended = this.#queue.shift()!;
        this.#queuedBytes -= appended.data.byteLength;
        if (!appended.init) this.#startAtMedia();
      }
    } else if (operation?.type === "remove") {
      this.#quotaBlocked = false;
      this.#updateBlocked();
    } else if (operation?.type === "clear") {
      this.#clearing = false;
    }
    this.#operation = null;
    this.#applyDuration();
    this.#evict();
    this.#updateRoom();
    this.#pump();
  };

  /**
   * The managed source asking for data again, which is the only thing that
   * reopens the door `endstreaming` closed.
   */
  #onStartStreaming = (): void => {
    this.#streaming = true;
    this.#updateRoom();
    this.#updateBlocked();
  };

  /**
   * The managed source saying it has enough.
   *
   * What is already queued still goes in -- it was converted, and a few
   * fragments are cheaper to append than to convert again -- but nothing more
   * is taken until it asks. This is the whole point of the managed source: it
   * knows what the radio and the battery are doing and the page does not.
   */
  #onEndStreaming = (): void => {
    this.#streaming = false;
    this.#updateRoom();
    this.#updateBlocked();
  };

  #onSourceBufferError = (): void => {
    this.#fail(
      "complete SourceBuffer update",
      new Error("the SourceBuffer rejected what was appended"),
    );
  };

  /**
   * Put the playhead where the media begins, which is not zero.
   *
   * The timeline keeps the distance the transport stream put between the two
   * tracks, so it opens with only the earlier one on it -- audio alone for over
   * 0.7 s where a recording starts mid-GOP, and at least one frame even when
   * they start together, because the muxer needs somewhere to put the first
   * decode time. buffered is the intersection of the two track buffers, so it
   * begins after that, and nothing is ever appended at zero. Chrome moves the
   * playhead into the first buffered range by itself; Firefox waits at zero for
   * data that is not coming.
   */
  #startAtMedia(): void {
    const buffered = this.#sourceBuffer?.buffered;
    if (this.#playheadPlaced || !buffered || buffered.length === 0) return;
    this.#playheadPlaced = true;
    this.#options.onMark?.("appended");
    this.#options.seek(buffered.start(0));
  }

  /**
   * Put the length of the file on the MediaSource, once it will take one.
   *
   * The setter only exists while the stream is open and nothing is updating,
   * so this runs again after every operation until it finds its moment. A
   * duration shorter than what is already buffered would evict the difference,
   * so what is buffered wins: it is the file speaking for itself.
   */
  #applyDuration(): void {
    const duration = this.#pendingDuration;
    if (duration === null || this.#closed) return;
    if (this.mediaSource.readyState !== "open") return;
    if (this.#operation || this.#sourceBuffer?.updating) return;
    const buffered = this.#sourceBuffer?.buffered;
    const end =
      buffered && buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
    this.#pendingDuration = null;
    try {
      this.mediaSource.duration = Math.max(duration, end);
    } catch (error) {
      this.#fail("set MediaSource duration", error);
    }
  }

  /**
   * Drop what is behind the playhead, once a browser has said it is out of
   * room.
   *
   * Only some of them say so. Chrome and Safari throw `QuotaExceededError` and
   * hand the decision back; Firefox keeps its own ceiling and evicts by itself,
   * from its own bookkeeping, and does not need help. Removing anyway would
   * only be another chance to remove the wrong thing.
   */
  #evict(): void {
    const sourceBuffer = this.#sourceBuffer;
    if (
      !this.#quotaBlocked ||
      !sourceBuffer ||
      sourceBuffer.updating ||
      this.#operation
    )
      return;
    if (this.#clearing || sourceBuffer.buffered.length === 0) return;
    // Removing a range takes the frames after it as well, up to the next random
    // access point, so that nothing is left behind depending on what went away.
    // Restart points here are several times further apart than the margin kept
    // behind the playhead, so ending a removal at currentTime - keepBehind
    // regularly reaches past the playhead and deletes the frames about to be
    // shown -- playback then stalls until the viewer seeks over the hole. So a
    // removal ends just short of a restart point, and the frames after it
    // depend on nothing that went.
    const limit = this.#currentTime - this.#options.keepBehindSeconds;
    let stopAt = 0;
    for (const at of this.#randomAccessPoints) {
      if (at > limit) break;
      stopAt = at;
    }
    const removeEnd = stopAt - REMOVE_MARGIN_SECONDS;
    if (removeEnd <= 0) return;
    while (
      this.#randomAccessPoints.length > 0 &&
      this.#randomAccessPoints[0]! < stopAt
    ) {
      this.#randomAccessPoints.shift();
    }
    this.#operation = { type: "remove" };
    try {
      sourceBuffer.remove(0, removeEnd);
    } catch (error) {
      this.#operation = null;
      this.#fail("evict SourceBuffer range", error);
    }
  }

  /** How far past the playhead the buffer reaches, in seconds. */
  #ahead(): number {
    const buffered = this.#sourceBuffer?.buffered;
    if (!buffered || buffered.length === 0) return 0;
    return buffered.end(buffered.length - 1) - this.#currentTime;
  }

  #updateRoom(): void {
    const room =
      !this.#quotaBlocked &&
      this.#streaming &&
      this.#ahead() < this.#options.maxAheadSeconds &&
      this.#queuedBytes < this.#options.queueHighWaterMark &&
      this.#queue.length < QUEUE_HIGH_WATER_FRAGMENTS;
    if (this.#room.set(room)) this.#options.onReadyChange?.(room);
  }

  /**
   * Say whether conversion is waiting on the buffer, whichever of the two
   * reasons it is: no room left, or a managed source that wants nothing for
   * now. Both look the same from where the conversion sits.
   */
  #updateBlocked(): void {
    const blocked = this.#quotaBlocked || !this.#streaming;
    if (blocked === this.#blocked) return;
    this.#blocked = blocked;
    this.#options.onBlocked?.(blocked);
  }

  /** Wake `finish`, either because everything is appended or because we gave up. */
  #settleDrain(force: boolean): void {
    if (!force && (!this.#ending || this.#queue.length > 0 || this.#operation))
      return;
    const waiting = this.#drained;
    this.#drained = [];
    for (const resolve of waiting) resolve();
  }

  #error(operation: string, error: unknown): Error {
    const cause = error instanceof Error ? error : new Error(String(error));
    const sourceBuffer = this.#sourceBuffer;
    const detail = [
      `mediaSource=${this.mediaSource.readyState}`,
      `closed=${this.#closed}`,
      `sourceBuffer=${sourceBuffer ? "present" : "absent"}`,
      `updating=${sourceBuffer?.updating ?? false}`,
      `operation=${this.#operation?.type ?? "none"}`,
      `queue=${this.#queue.length}`,
      `epoch=${this.#epoch}`,
    ].join(", ");
    const contextual = new Error(
      `MSE ${operation} failed (${detail}): ${cause.name}: ${cause.message}`,
    );
    contextual.name = cause.name;
    contextual.stack += `\nCaused by: ${cause.stack ?? cause.message}`;
    return contextual;
  }

  #fail(operation: string, error: unknown): void {
    this.#options.onError?.(this.#error(operation, error));
  }
}
