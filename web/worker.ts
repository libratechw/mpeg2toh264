/**
 * Runs the transcoder off the page's main thread.
 *
 * There is no pipeline here any more: demux, GOP splitting, transcoding,
 * muxing and the two-track timeline all live inside the WebAssembly `Session`.
 * What is left is the message protocol -- pull a slice, hand back whatever
 * fragments it completed -- and moving buffers to the page without copying.
 */
import init, { Session, type Fragment } from "./wasm/mpeg2toh264_wasm.js";

type Request =
  { type: "start" } | { type: "chunk"; data: ArrayBuffer } | { type: "end" };

/**
 * Message handling, queued behind loading the module.
 *
 * Messages can arrive before the WebAssembly is instantiated, and they have to
 * be answered in the order they came in, so each one waits on the last.
 */
let pending: Promise<unknown> = init({
  module_or_path: new URL("./wasm/mpeg2toh264_wasm_bg.wasm", import.meta.url),
});

let session: Session | null = null;

/**
 * The fragment's bytes are a copy wasm-bindgen made for us, so no one else
 * holds the buffer and it can be transferred to the page rather than copied a
 * second time.
 */
function send(fragment: Fragment) {
  const data = fragment.data.buffer as ArrayBuffer;
  if (fragment.kind === "init") {
    self.postMessage({ type: "init", data, mimeCodec: fragment.mimeCodec }, [
      data,
    ]);
  } else {
    self.postMessage(
      {
        type: "fragment",
        data,
        videoSamples: fragment.videoSamples,
        audioSamples: fragment.audioSamples,
        // Where this fragment starts, and whether it can be decoded from. The
        // page needs both to evict buffered media without cutting into what is
        // about to be played; see relieveQuota in main.ts.
        start: fragment.start,
        randomAccess: fragment.randomAccess,
      },
      [data],
    );
  }
}

function handle(request: Request) {
  if (request.type === "start") {
    // Rust memory, so dropping the reference would not be enough.
    session?.free();
    session = new Session();
    self.postMessage({ type: "pull" });
    return;
  }
  // Only reachable when the module failed to load, which was reported already.
  if (!session) return;
  if (request.type === "chunk") {
    for (const fragment of session.push(new Uint8Array(request.data)))
      send(fragment);
    self.postMessage({ type: "pull" });
  } else {
    for (const fragment of session.finish()) send(fragment);
    session.free();
    session = null;
    self.postMessage({ type: "done" });
  }
}

self.onmessage = (event: MessageEvent<Request>) => {
  pending = pending
    .then(() => handle(event.data))
    .catch((error: unknown) => {
      self.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
};
