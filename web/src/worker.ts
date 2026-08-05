/**
 * Everything between a URL and a fragment: fetching, converting, and -- where
 * the browser allows it -- Media Source Extensions as well.
 *
 * The page holds nothing but the media element. Reading the input drives the
 * whole thing: the loop below pulls a slice only once the sink says it has
 * somewhere to put the result, so backpressure needs no messages of its own.
 */
import { MseSink, ReadyGate, type FragmentSink } from "./mse.js";
import type { Command, LoadCommand, Notification } from "./protocol.js";
import { openSource, type Source } from "./source.js";
import { detach, loadWasm, Transcoder, type Fragment } from "./transcoder.js";

/** The load we are on, or -1 when idle. See protocol.ts on ids. */
let current = -1;
let abort: AbortController | null = null;
let sink: FragmentSink | null = null;
/** The same sink, when this worker owns the MediaSource. For playhead reports. */
let mseSink: MseSink | null = null;
let transcoder: Transcoder | null = null;
/** Whether the page's sink has room. Main-sink loads only; see RemoteSink. */
const flow = new ReadyGate();

function post(notification: Notification, transfer: Transferable[] = []): void {
  if (notification.id === current) self.postMessage(notification, transfer);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    onBlocked: (blocked) => post({ type: "blocked", id, blocked }),
    onError: (error) => post({ type: "error", id, message: error.message }),
  });
  const handle = created.mediaSource.handle;
  post({ type: "handle", id, handle }, [handle]);
  return created;
}

/** Drop whatever the current load is holding. */
function abandon(): void {
  current = -1;
  abort?.abort();
  abort = null;
  sink?.close();
  sink = null;
  mseSink = null;
  transcoder?.free();
  transcoder = null;
}

async function run(command: LoadCommand): Promise<void> {
  abandon();
  const id = command.id;
  current = id;
  const controller = new AbortController();
  abort = controller;
  try {
    await loadWasm(command.wasmUrl);
    if (id !== current) return;
    const source = await openSource(command.url, controller.signal);
    if (id !== current) return;
    post({ type: "progress", id, bytesRead: 0, totalBytes: source.totalBytes });

    flow.set(true);
    const target =
      command.sink === "worker"
        ? createWorkerSink(command)
        : new RemoteSink(id);
    sink = target;
    mseSink = target instanceof MseSink ? target : null;
    const converter = new Transcoder(command.oversample);
    transcoder = converter;
    await convert(id, source, converter, target);
  } catch (error) {
    if (id !== current || controller.signal.aborted) return;
    post({ type: "error", id, message: describe(error) });
    abandon();
  }
}

async function convert(
  id: number,
  source: Source,
  converter: Transcoder,
  target: FragmentSink,
): Promise<void> {
  const reader = source.stream.getReader();
  let bytesRead = 0;
  for (;;) {
    await target.ready();
    if (id !== current) return;
    const result = await reader.read();
    if (id !== current) return;
    if (result.done) break;
    bytesRead += result.value.byteLength;
    post({ type: "progress", id, bytesRead, totalBytes: source.totalBytes });
    if (!(await deliver(id, converter.push(result.value), target))) return;
    report(id, converter);
  }
  if (!(await deliver(id, converter.finish(), target))) return;
  report(id, converter);
  await target.finish();
  if (id !== current) return;
  post({ type: "completed", id });
  converter.free();
  transcoder = null;
}

/**
 * Hand a batch to the sink, opening the stream when the init segment shows up.
 *
 * Returns false when the load was abandoned while opening, which is the only
 * await in here and so the only place the caller can be overtaken.
 */
async function deliver(
  id: number,
  fragments: Fragment[],
  target: FragmentSink,
): Promise<boolean> {
  for (const fragment of fragments) {
    if (fragment.kind === "init") {
      await target.open(fragment.mimeCodec, detach(fragment));
      if (id !== current) return false;
      post({ type: "opened", id });
    } else {
      target.push(detach(fragment), fragment.start, fragment.randomAccess);
    }
  }
  return true;
}

function report(id: number, converter: Transcoder): void {
  const stats = converter.takeStats();
  if (stats) post({ type: "stats", id, stats });
}

self.onmessage = (event: MessageEvent<Command>) => {
  const command = event.data;
  if (command.type === "load") {
    void run(command);
    return;
  }
  if (command.id !== current) return;
  if (command.type === "stop") abandon();
  else if (command.type === "time")
    mseSink?.setCurrentTime(command.currentTime);
  else flow.set(command.ready);
};
