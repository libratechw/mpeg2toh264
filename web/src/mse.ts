/**
 * Feeding Media Source Extensions, from wherever the `MediaSource` lives.
 *
 * This module compiles into both programs: on the page it uses the DOM's MSE
 * declarations, in the worker the ones in worker-mse.d.ts. Nothing here
 * touches a media element -- the two things that need one, moving the playhead
 * and reading it, go through `seek` and `setCurrentTime` -- so the same buffer
 * management runs whether MSE is on the page or in the worker.
 */

/** Where a producer hands fragments, and how it learns to slow down. */
export interface FragmentSink {
  /** Resolves once there is room for more fragments. */
  ready(): Promise<void>;
  /** Take the initialization segment and open the stream for `mimeCodec`. */
  open(mimeCodec: string, data: ArrayBuffer): Promise<void>;
  push(data: ArrayBuffer, start: number, randomAccess: boolean): void;
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
  /** Stop taking fragments above this many bytes waiting to be appended. */
  queueHighWaterMark: number;
  /** Seconds of played media to keep behind the playhead when evicting. */
  keepBehindSeconds: number;
  /** Move the playhead, which only whoever holds the media element can do. */
  seek(time: number): void;
  /** Whether there is room for more fragments. */
  onReadyChange?(ready: boolean): void;
  /** Whether the media buffer is full and conversion has to wait. */
  onBlocked?(blocked: boolean): void;
  onError?(error: Error): void;
}

interface Pending {
  data: ArrayBuffer;
  /** The initialization segment buffers no media, so it places no playhead. */
  init: boolean;
}

export class MseSink implements FragmentSink {
  /**
   * Made here rather than in `open`, because a caller needs something to
   * attach before the codec is known: the worker sends `mediaSource.handle`
   * across the moment a load starts, and `sourceopen` does not fire until the
   * page has put it on the element -- long before the first init fragment.
   */
  readonly mediaSource: MediaSource = new MediaSource();

  readonly #options: MseSinkOptions;
  readonly #opened: Promise<void>;
  #sourceBuffer: SourceBuffer | null = null;
  #queue: Pending[] = [];
  #queuedBytes = 0;
  #operation: "append" | "remove" | null = null;
  #quotaBlocked = false;
  /** Media times a decoder can start from, in order; see #relieveQuota. */
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
    this.#opened = new Promise((resolve) => {
      this.mediaSource.addEventListener("sourceopen", () => resolve(), {
        once: true,
      });
    });
  }

  ready(): Promise<void> {
    return this.#room.wait();
  }

  async open(mimeCodec: string, data: ArrayBuffer): Promise<void> {
    if (!MediaSource.isTypeSupported(mimeCodec))
      throw new Error(`unsupported codec: ${mimeCodec}`);
    await this.#opened;
    if (this.#closed) return;
    const sourceBuffer = this.mediaSource.addSourceBuffer(mimeCodec);
    sourceBuffer.mode = "segments";
    sourceBuffer.addEventListener("updateend", this.#onUpdateEnd);
    sourceBuffer.addEventListener("error", this.#onSourceBufferError);
    this.#sourceBuffer = sourceBuffer;
    this.#enqueue({ data, init: true });
  }

  push(data: ArrayBuffer, start: number, randomAccess: boolean): void {
    if (this.#closed) return;
    if (randomAccess) this.#randomAccessPoints.push(start);
    this.#enqueue({ data, init: false });
  }

  async finish(): Promise<void> {
    this.#ending = true;
    // Nothing was ever opened, so there is nothing to drain and no stream to
    // end -- an input we could make no track out of takes this path.
    if (this.#closed || !this.#sourceBuffer) return;
    await new Promise<void>((resolve) => {
      this.#drained.push(resolve);
      this.#pump();
    });
    if (!this.#closed && this.mediaSource.readyState === "open")
      this.mediaSource.endOfStream();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
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
    this.#relieveQuota();
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
      this.#operation ||
      this.#quotaBlocked
    ) {
      return;
    }
    const next = this.#queue[0];
    if (!next) {
      this.#settleDrain(false);
      return;
    }
    this.#operation = "append";
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
        this.#options.onBlocked?.(true);
        // Try at once rather than waiting for playback to raise an event: if
        // the buffer ahead runs out first, nothing will raise one.
        this.#relieveQuota();
      } else this.#fail(error);
    }
  }

  #onUpdateEnd = (): void => {
    if (this.#operation === "append") {
      const appended = this.#queue.shift();
      if (appended) {
        this.#queuedBytes -= appended.data.byteLength;
        if (!appended.init) this.#startAtMedia();
      }
    } else if (this.#operation === "remove") {
      this.#quotaBlocked = false;
      this.#options.onBlocked?.(false);
    }
    this.#operation = null;
    this.#updateRoom();
    this.#pump();
  };

  #onSourceBufferError = (): void => {
    this.#fail(new Error("the SourceBuffer rejected what was appended"));
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
    this.#options.seek(buffered.start(0));
  }

  #relieveQuota(): void {
    const sourceBuffer = this.#sourceBuffer;
    if (
      !this.#quotaBlocked ||
      !sourceBuffer ||
      sourceBuffer.updating ||
      this.#operation
    )
      return;
    if (sourceBuffer.buffered.length === 0) return;
    const removeStart = sourceBuffer.buffered.start(0);
    // Removing a range takes the frames after it as well, up to the next random
    // access point, so that nothing is left behind depending on what went away.
    // Restart points here are several times further apart than the margin kept
    // behind the playhead, so ending a removal at currentTime - keepBehind
    // regularly reaches past the playhead and deletes the frames about to be
    // shown -- playback then stalls until the viewer seeks over the hole. Ending
    // exactly on a restart point removes nothing beyond it.
    const limit = this.#currentTime - this.#options.keepBehindSeconds;
    let removeEnd = 0;
    for (const at of this.#randomAccessPoints) {
      if (at > limit) break;
      removeEnd = at;
    }
    if (removeEnd <= removeStart) return;
    while (
      this.#randomAccessPoints.length > 0 &&
      this.#randomAccessPoints[0]! < removeEnd
    ) {
      this.#randomAccessPoints.shift();
    }
    this.#operation = "remove";
    sourceBuffer.remove(removeStart, removeEnd);
  }

  #updateRoom(): void {
    const room =
      !this.#quotaBlocked &&
      this.#queuedBytes < this.#options.queueHighWaterMark;
    if (this.#room.set(room)) this.#options.onReadyChange?.(room);
  }

  /** Wake `finish`, either because everything is appended or because we gave up. */
  #settleDrain(force: boolean): void {
    if (!force && (!this.#ending || this.#queue.length > 0 || this.#operation))
      return;
    const waiting = this.#drained;
    this.#drained = [];
    for (const resolve of waiting) resolve();
  }

  #fail(error: unknown): void {
    this.#options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
