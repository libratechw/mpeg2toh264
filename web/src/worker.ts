/**
 * Everything between a URL and a fragment: fetching, converting, and -- where
 * the browser allows it -- Media Source Extensions as well.
 *
 * The page holds nothing but the media element. Reading the input drives the
 * whole thing: the loop below pulls a slice only once the sink says it has
 * somewhere to put the result, so backpressure needs no messages of its own.
 *
 * A load is a series of legs. The first one reads the file from the beginning;
 * a seek abandons whatever leg is running and opens another one partway in,
 * with a session anchored to the same timeline, so what it produces belongs
 * where the viewer asked to be. See `Playback`.
 */
import { MseSink, ReadyGate, type FragmentSink } from "./mse.js";
import {
  SEEK_ATTEMPTS,
  SEEK_OVERSHOOT_TOLERANCE_SECONDS,
  SEEK_RETRY_MARGIN_SECONDS,
  TAIL_PROBE_BYTES,
  type Command,
  type LoadCommand,
  type Notification,
  type TimingMark,
} from "./protocol.js";
import { openSource, readTail, type Source } from "./source.js";
import {
  detach,
  lastTimestamp,
  loadWasm,
  Transcoder,
  type Fragment,
} from "./transcoder.js";

/** The presentation clock the timestamps in a transport stream are counted in. */
const TICKS_PER_SECOND = 90_000;

/**
 * How much of the file a seek always leaves ahead of where it opens.
 *
 * Dropped at the very end of the timeline, the bitrate points past the last
 * packet, and what comes back is either a refusal or too few bytes to find a
 * single picture in. Landing a moment earlier is what a viewer dragging to the
 * end wants anyway.
 */
const MINIMUM_SEEK_TAIL_BYTES = 1 << 20;

/** The PES timestamp field is 33 bits, so distances along it are modular. */
const PTS_MODULUS = 2 ** 33;

/** The load we are on, or -1 when idle. See protocol.ts on ids. */
let current = -1;
let playback: Playback | null = null;
/** Whether the page's sink has room. Main-sink loads only; see RemoteSink. */
const flow = new ReadyGate();

function post(notification: Notification, transfer: Transferable[] = []): void {
  if (notification.id === current) self.postMessage(notification, transfer);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Say that a step of the load has happened, and when.
 *
 * The page cannot read this worker's clock -- `performance.now()` counts from
 * whenever each context was created -- so the moment goes over as an epoch
 * milliseconds, which is the one reading both sides agree on.
 */
function mark(id: number, name: TimingMark): void {
  post({
    type: "mark",
    id,
    name,
    at: performance.timeOrigin + performance.now(),
  });
}

/** Ticks from `origin` to `ticks`, across however many wraps lie between. */
function ticksSince(origin: number, ticks: number): number {
  return (((ticks - origin) % PTS_MODULUS) + PTS_MODULUS) % PTS_MODULUS;
}

/**
 * One channel for `breathe`, rather than one per slice of input.
 *
 * A message to oneself is the shortest task there is: no clamping, unlike a
 * zero timeout, and it goes behind everything already queued, which is the
 * whole point.
 */
const breather = new MessageChannel();
let breathing: (() => void)[] = [];
breather.port1.onmessage = () => {
  const waiting = breathing;
  breathing = [];
  for (const resume of waiting) resume();
};

/**
 * Let the event loop run the tasks waiting on it.
 *
 * The read loop is made of promises, and awaiting one that is already settled
 * resumes on the microtask queue -- which runs to exhaustion before a single
 * task does. An input that arrives faster than it converts settles every read
 * immediately, so the loop can spin from beginning to end of the file without
 * the worker ever reaching its task queue.
 *
 * Where this worker also holds the MediaSource, that starves exactly what the
 * conversion is waiting for: `updateend`, which is what appends the fragment
 * after the one just appended, and the playhead the page posts over, which is
 * what lets a full buffer evict. One task per slice keeps both moving, and it
 * costs nothing on the path where the page holds the MediaSource instead.
 */
function breathe(): Promise<void> {
  return new Promise((resolve) => {
    breathing.push(resolve);
    breather.port2.postMessage(0);
  });
}

/**
 * A sink for when the page owns the MediaSource.
 *
 * Fragments go over the wire and the page's own `MseSink` decides when there
 * is room, which it reports as `flow`. This is the path for browsers without
 * MSE in Workers.
 */
class RemoteSink implements FragmentSink {
  readonly #id: number;

  constructor(id: number) {
    this.#id = id;
  }

  ready(): Promise<void> {
    return flow.wait();
  }

  open(mimeCodec: string, data: ArrayBuffer): Promise<void> {
    // The page answers a successful open by opening the flow, and a failed one
    // by stopping the load, which abandons the gate.
    flow.set(false);
    post({ type: "open", id: this.#id, mimeCodec, data }, [data]);
    return flow.wait();
  }

  push(data: ArrayBuffer, start: number, randomAccess: boolean): void {
    post({ type: "fragment", id: this.#id, data, start, randomAccess }, [data]);
  }

  reset(): void {
    // The page's queue is emptied by the same message, so the flow it last
    // reported no longer describes anything.
    flow.set(true);
    post({ type: "reset", id: this.#id });
  }

  finish(): Promise<void> {
    // The page drains its own queue and ends the stream; nothing to wait for.
    post({ type: "finish", id: this.#id });
    return Promise.resolve();
  }

  close(): void {
    flow.abandon();
  }
}

/** A sink for when this worker owns the MediaSource, and hands out a proxy. */
function createWorkerSink(command: LoadCommand): MseSink {
  const id = command.id;
  const created = new MseSink({
    queueHighWaterMark: command.queueHighWaterMark,
    keepBehindSeconds: command.keepBehindSeconds,
    seek: (time) => post({ type: "seek", id, time }),
    onMark: (name) => mark(id, name),
    onBlocked: (blocked) => post({ type: "blocked", id, blocked }),
    onError: (error) => post({ type: "error", id, message: error.message }),
  });
  const handle = created.mediaSource.handle;
  post({ type: "handle", id, handle }, [handle]);
  return created;
}

/** How a leg of the conversion ended. */
type Outcome =
  /** The input ran out: this leg reached the end of the file. */
  | { kind: "done" }
  /** Something newer took over -- a seek, a stop, another load. */
  | { kind: "stale" }
  /** The leg opened later than the seek asked for, and has appended nothing. */
  | { kind: "overshoot"; start: number };

/**
 * One load: the input, the sink, and whichever leg of it is being read now.
 */
class Playback {
  readonly #command: LoadCommand;
  readonly #sink: FragmentSink;
  /** The same sink, when this worker owns the MediaSource. */
  readonly #mseSink: MseSink | null;
  /** Aborted when the load is abandoned, which the tail probe rides on. */
  readonly #life = new AbortController();
  /** Aborted when this leg is superseded, without disturbing the load. */
  #leg: AbortController | null = null;
  /** Which leg is current. Anything from an older one is dropped. */
  #legNumber = 0;
  #transcoder: Transcoder | null = null;
  /** Wall time the read loop spent on each of the two things it waits for. */
  #readingMs = 0;
  #waitingMs = 0;

  #totalBytes: number | null = null;
  /** Whether the end of the file has been asked for; see `#measure`. */
  #measured = false;
  /** The PES timestamp presentation time zero stands for. */
  #origin: number | null = null;
  /** The last timestamp in the file, once the tail has been read. */
  #endTicks: number | null = null;
  #duration: number | null = null;

  constructor(command: LoadCommand) {
    this.#command = command;
    const sink =
      command.sink === "worker"
        ? createWorkerSink(command)
        : new RemoteSink(command.id);
    this.#sink = sink;
    this.#mseSink = sink instanceof MseSink ? sink : null;
  }

  get id(): number {
    return this.#command.id;
  }

  /** Read the file from the beginning. */
  async start(): Promise<void> {
    flow.set(true);
    await this.#run(0, null);
  }

  /**
   * Play from `time` instead.
   *
   * Where that is in bytes is the average bitrate and nothing else -- a
   * transport stream carries no index -- so a variable bitrate lands either
   * side of the mark. Landing early is left alone, since playback simply
   * begins a little before what was asked for; landing late is measured and
   * tried again from further back.
   */
  async seek(time: number): Promise<void> {
    const bytesPerSecond = this.#bytesPerSecond();
    if (bytesPerSecond === null || this.#totalBytes === null) return;
    mark(this.#command.id, "seek");
    this.#sink.reset();
    const last = Math.max(0, this.#totalBytes - MINIMUM_SEEK_TAIL_BYTES);
    let offset = Math.min(Math.round(Math.max(0, time) * bytesPerSecond), last);
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.#run(
        offset,
        attempt < SEEK_ATTEMPTS ? time : null,
      );
      if (outcome.kind !== "overshoot") return;
      const overshot = outcome.start - time + SEEK_RETRY_MARGIN_SECONDS;
      offset = Math.max(0, offset - Math.ceil(overshot * bytesPerSecond));
    }
  }

  setCurrentTime(currentTime: number): void {
    this.#mseSink?.setCurrentTime(currentTime);
  }

  /** Drop everything this load holds. */
  stop(): void {
    this.#life.abort();
    this.#leg?.abort();
    this.#leg = null;
    this.#legNumber++;
    this.#transcoder?.free();
    this.#transcoder = null;
    this.#sink.close();
  }

  /**
   * Read the end of the file, which is where its length comes from.
   *
   * Everything about this is allowed to come to nothing: a server that will
   * not serve a range, a tail with no timestamp in it. The load then plays as
   * it arrives, which is what it did before any of this existed.
   */
  async #measure(): Promise<void> {
    try {
      const tail = await readTail(
        this.#command.url,
        TAIL_PROBE_BYTES,
        this.#life.signal,
      );
      if (!tail || this.#command.id !== current) return;
      this.#totalBytes = tail.totalBytes;
      this.#endTicks = lastTimestamp(tail.data);
      mark(this.#command.id, "measured");
      this.#announceDuration();
    } catch {
      // An input that cannot be measured is one to play as it comes.
    }
  }

  /** Announce the length, once both ends of it are known. */
  #announceDuration(): void {
    if (this.#duration !== null) return;
    if (
      this.#origin === null ||
      this.#endTicks === null ||
      this.#totalBytes === null
    )
      return;
    const duration =
      ticksSince(this.#origin, this.#endTicks) / TICKS_PER_SECOND;
    if (!(duration > 0)) return;
    this.#duration = duration;
    // The page is told whichever side holds the MediaSource: this is what
    // turns the element into something a viewer can seek in, and only the page
    // can answer for what the viewer then does.
    post({ type: "seekable", id: this.#command.id, duration });
    this.#mseSink?.setDuration(duration);
  }

  /** Bytes per second of presentation, or null while a seek is not possible. */
  #bytesPerSecond(): number | null {
    if (this.#duration === null || this.#totalBytes === null) return null;
    return this.#totalBytes / this.#duration;
  }

  /** Abandon the running leg and take the next number. */
  #nextLeg(): number {
    this.#leg?.abort();
    this.#leg = new AbortController();
    this.#transcoder?.free();
    this.#transcoder = null;
    return ++this.#legNumber;
  }

  #running(leg: number): boolean {
    return leg === this.#legNumber && this.#command.id === current;
  }

  /**
   * Read the input from `offset` to the end of the file.
   *
   * `target` is the time a seek asked for, when overshooting it is still worth
   * another request; a leg with none delivers whatever it finds.
   */
  async #run(offset: number, target: number | null): Promise<Outcome> {
    const leg = this.#nextLeg();
    const signal = this.#leg!.signal;
    const id = this.#command.id;
    try {
      await loadWasm(this.#command.wasmUrl);
      if (!this.#running(leg)) return { kind: "stale" };
      mark(id, "wasm");
      const source = await openSource(this.#command.url, signal, offset);
      if (!this.#running(leg)) return { kind: "stale" };
      mark(id, "response");
      this.#totalBytes ??= source.totalBytes;
      // An input whose length the server will not state is a live one: it has
      // no end to read, and nothing to work a seek out of.
      if (this.#totalBytes !== null && !this.#measured) {
        this.#measured = true;
        void this.#measure();
      }
      post({
        type: "progress",
        id: this.#command.id,
        bytesRead: offset,
        totalBytes: this.#totalBytes,
      });
      const converter = new Transcoder(this.#command.oversample, this.#origin);
      this.#transcoder = converter;
      return await this.#convert(leg, source, converter, target);
    } catch (error) {
      if (!this.#running(leg) || signal.aborted) return { kind: "stale" };
      post({ type: "error", id: this.#command.id, message: describe(error) });
      abandon();
      return { kind: "stale" };
    }
  }

  async #convert(
    leg: number,
    source: Source,
    converter: Transcoder,
    target: number | null,
  ): Promise<Outcome> {
    const id = this.#command.id;
    const reader = source.stream.getReader();
    let bytesRead = source.offset;
    /** Whether this leg has yet to decide that it landed where it should. */
    let placing = target !== null;
    let read = 0;
    let converted = false;
    for (;;) {
      // What the loop is doing when it is not converting: letting the events
      // it depends on through, waiting for the sink to take more, and waiting
      // for the input to arrive. Reported with the conversion time so that one
      // line accounts for all of the wall clock.
      const waitStarted = performance.now();
      await breathe();
      await this.#sink.ready();
      this.#waitingMs += performance.now() - waitStarted;
      if (!this.#running(leg)) return { kind: "stale" };
      const readStarted = performance.now();
      const result = await reader.read();
      this.#readingMs += performance.now() - readStarted;
      if (!this.#running(leg)) return { kind: "stale" };
      if (result.done) break;
      if (read++ === 0) mark(id, "first-byte");
      bytesRead += result.value.byteLength;
      post({ type: "progress", id, bytesRead, totalBytes: this.#totalBytes });
      const fragments = converter.push(result.value);
      if (!converted && fragments.length > 0) {
        converted = true;
        mark(id, "first-fragment");
      }
      if (placing) {
        const first = fragments.find((fragment) => fragment.kind === "media");
        if (first) {
          placing = false;
          if (first.start > target! + SEEK_OVERSHOOT_TOLERANCE_SECONDS) {
            // Nothing has been appended yet, so this leg can be forgotten
            // whole and asked for again from further back.
            await reader.cancel().catch(() => {});
            return { kind: "overshoot", start: first.start };
          }
        }
      }
      if (!(await this.#deliver(leg, fragments))) return { kind: "stale" };
      this.#place(converter);
      this.#report(converter);
    }
    if (!(await this.#deliver(leg, converter.finish())))
      return { kind: "stale" };
    this.#place(converter);
    this.#report(converter);
    await this.#sink.finish();
    if (!this.#running(leg)) return { kind: "stale" };
    post({ type: "completed", id });
    converter.free();
    this.#transcoder = null;
    return { kind: "done" };
  }

  /**
   * Hand a batch to the sink, opening the stream when the init segment shows
   * up. Returns false when the leg was abandoned while opening, which is the
   * only await in here and so the only place the caller can be overtaken.
   */
  async #deliver(leg: number, fragments: Fragment[]): Promise<boolean> {
    for (const fragment of fragments) {
      if (fragment.kind === "init") {
        await this.#sink.open(fragment.mimeCodec, detach(fragment));
        if (!this.#running(leg)) return false;
        mark(this.#command.id, "opened");
        post({ type: "opened", id: this.#command.id });
      } else {
        this.#sink.push(
          detach(fragment),
          fragment.start,
          fragment.randomAccess,
        );
      }
    }
    return true;
  }

  /**
   * Take the origin the first session settled on, which every later one is
   * anchored to and the duration is measured from.
   */
  #place(converter: Transcoder): void {
    if (this.#origin !== null) return;
    const origin = converter.originTicks;
    if (origin === null) return;
    this.#origin = origin;
    this.#announceDuration();
  }

  #report(converter: Transcoder): void {
    const stats = converter.takeStats({
      readingMs: this.#readingMs,
      waitingMs: this.#waitingMs,
    });
    if (!stats) return;
    this.#readingMs = 0;
    this.#waitingMs = 0;
    post({ type: "stats", id: this.#command.id, stats });
  }
}

/** Drop whatever the current load is holding. */
function abandon(): void {
  current = -1;
  playback?.stop();
  playback = null;
}

function load(command: LoadCommand): void {
  abandon();
  current = command.id;
  mark(command.id, "load");
  const started = new Playback(command);
  playback = started;
  void started.start();
}

self.onmessage = (event: MessageEvent<Command>) => {
  const command = event.data;
  if (command.type === "load") {
    load(command);
    return;
  }
  if (command.id !== current) return;
  switch (command.type) {
    case "stop":
      abandon();
      break;
    case "time":
      playback?.setCurrentTime(command.currentTime);
      break;
    case "flow":
      flow.set(command.ready);
      break;
    case "seek":
      void playback?.seek(command.time);
      break;
  }
};
