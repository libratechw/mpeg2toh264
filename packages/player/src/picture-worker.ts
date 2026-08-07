/**
 * One picture at a time, and nothing else.
 *
 * This is the whole of what a picture worker does: take an opaque job, hand
 * back an opaque result. It knows nothing of the stream, the timeline or the
 * MediaSource -- everything a picture is coded against travels with it, which
 * is what lets several of these convert one group of pictures at once without
 * sharing any memory. There is none to share: without cross-origin isolation
 * there is no `SharedArrayBuffer`, so each of these is a WebAssembly instance
 * of its own and its work reaches it as bytes.
 *
 * The module arrives compiled, from the worker that spawned this one, so the
 * bytes are fetched and compiled once however many of these there are.
 */
// Named imports only: the default export is the asynchronous initialiser, and
// it is what carries a reference to the `.wasm` beside it. Leaving it out
// keeps the bundler from putting a second copy of the module in this worker,
// which would be a copy nothing here ever loads.
import { initSync, PictureEncoder } from "../wasm/mpeg2toh264_wasm.js";

/** What the pool sends. */
export type PictureWorkerRequest =
  | { type: "start"; module: WebAssembly.Module }
  | { type: "encode"; index: number; job: Uint8Array };

/** What comes back. */
export type PictureWorkerResponse =
  | { type: "ready" }
  | { type: "encoded"; index: number; output: Uint8Array }
  | { type: "failed"; index: number; message: string };

let encoder: PictureEncoder | null = null;

self.onmessage = ({ data }: MessageEvent<PictureWorkerRequest>) => {
  if (data.type === "start") {
    // Synchronous, so this worker is ready for the encode that may already be
    // queued behind this message; there is nothing to wait for.
    initSync({ module: data.module });
    encoder = new PictureEncoder();
    const ready: PictureWorkerResponse = { type: "ready" };
    self.postMessage(ready);
    return;
  }
  const { index, job } = data;
  if (!encoder) {
    const failed: PictureWorkerResponse = {
      type: "failed",
      index,
      message: "the picture worker was given work before its module",
    };
    self.postMessage(failed);
    return;
  }
  try {
    const output = encoder.encode(job);
    const encoded: PictureWorkerResponse = { type: "encoded", index, output };
    // The bytes are a copy wasm-bindgen made on the way out, so nobody else
    // holds the buffer and it can be moved rather than copied a second time.
    self.postMessage(encoded, [output.buffer as ArrayBuffer]);
  } catch (error) {
    const failed: PictureWorkerResponse = {
      type: "failed",
      index,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(failed);
  }
};
