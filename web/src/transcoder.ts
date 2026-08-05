/**
 * The WebAssembly `Session`, plus the arithmetic for reporting how fast it is.
 *
 * There is no pipeline here: demux, GOP splitting, transcoding, muxing and the
 * two-track timeline all live inside the `Session`. This is the bookkeeping
 * around it.
 */
import init, { Session, type Fragment } from "../wasm/mpeg2toh264_wasm.js";
import type { Stats } from "./protocol.js";

export type { Fragment };

/** Where the `.wasm` sits relative to this module, when no caller says. */
const DEFAULT_WASM_URL = new URL(
  "../wasm/mpeg2toh264_wasm_bg.wasm",
  import.meta.url,
);

let loaded: { url: string; module: Promise<unknown> } | null = null;

/** Instantiate the module once per worker, however many loads run through it. */
export function loadWasm(wasmUrl: string | null): Promise<unknown> {
  const url = wasmUrl ?? DEFAULT_WASM_URL.href;
  if (loaded?.url !== url)
    loaded = { url, module: init({ module_or_path: url }) };
  return loaded.module;
}

export class Transcoder {
  #session: Session;
  #totalMs = 0;
  #totalFrames = 0;
  #intervalMs = 0;
  #intervalFrames = 0;
  #videoFrames = 0;
  #audioFrames = 0;

  constructor(oversample: number | undefined) {
    this.#session = new Session(oversample);
  }

  push(chunk: Uint8Array): Fragment[] {
    return this.#timed(() => this.#session.push(chunk));
  }

  finish(): Fragment[] {
    return this.#timed(() => this.#session.finish());
  }

  /** Rust memory, so dropping the reference would not be enough. */
  free(): void {
    this.#session.free();
  }

  /**
   * The rate since the last call, and overall. Null until a frame has been
   * converted, because before that there is nothing to divide by.
   */
  takeStats(): Stats | null {
    if (this.#intervalFrames === 0 || this.#totalMs === 0) return null;
    const stats: Stats = {
      instantFps: (this.#intervalFrames * 1000) / this.#intervalMs,
      totalFps: (this.#totalFrames * 1000) / this.#totalMs,
      videoFrames: this.#videoFrames,
      audioFrames: this.#audioFrames,
    };
    this.#intervalMs = 0;
    this.#intervalFrames = 0;
    return stats;
  }

  #timed(run: () => Fragment[]): Fragment[] {
    const started = performance.now();
    const fragments = run();
    const elapsed = performance.now() - started;
    let videoFrames = 0;
    for (const fragment of fragments) {
      if (fragment.kind !== "media") continue;
      videoFrames += fragment.videoSamples;
      this.#audioFrames += fragment.audioSamples;
    }
    this.#videoFrames += videoFrames;
    this.#totalMs += elapsed;
    this.#totalFrames += videoFrames;
    this.#intervalMs += elapsed;
    this.#intervalFrames += videoFrames;
    return fragments;
  }
}

/**
 * The fragment's bytes are a copy wasm-bindgen made for us, so no one else
 * holds the buffer: it can be transferred rather than copied a second time.
 */
export function detach(fragment: Fragment): ArrayBuffer {
  return fragment.data.buffer as ArrayBuffer;
}
