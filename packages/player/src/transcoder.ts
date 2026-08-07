/**
 * The WebAssembly `Session`, plus the arithmetic for reporting how fast it is.
 *
 * There is no pipeline here: demux, GOP splitting, transcoding, muxing and the
 * two-track timeline all live inside the `Session`. This is the bookkeeping
 * around it.
 */
import init, {
  firstTimestamp as wasmFirstTimestamp,
  lastTimestamp as wasmLastTimestamp,
  Session,
  type Fragment,
} from "../wasm/mpeg2toh264_wasm.js";
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

/**
 * The last presentation timestamp in a slice of transport stream, in 90 kHz
 * ticks, or null when it holds none. Read from the end of a file, this is
 * where the file ends. Needs `loadWasm` first, like everything else here.
 */
export function lastTimestamp(data: Uint8Array): number | null {
  return wasmLastTimestamp(data) ?? null;
}

/**
 * The first presentation timestamp in a slice, in 90 kHz ticks, or null when
 * it holds none. This is what time it is at the byte the slice was read from.
 */
export function firstTimestamp(data: Uint8Array): number | null {
  return wasmFirstTimestamp(data) ?? null;
}

export class Transcoder {
  #session: Session;
  #totalMs = 0;
  #totalFrames = 0;
  #intervalMs = 0;
  #intervalFrames = 0;
  #videoFrames = 0;
  #audioFrames = 0;

  /**
   * `originTicks` measures the timeline from a timestamp the caller names,
   * rather than from wherever this input opens, which is what lets a stream
   * that starts mid-file be appended where it belongs.
   *
   * `serviceId` takes one named service out of a transport stream carrying
   * several; null takes the first that turns up with a picture in it.
   *
   * `passthrough` carries the MPEG-2 video into the MP4 as it stands rather
   * than converting it, for a browser whose decoder takes MPEG-2.
   */
  constructor(
    oversample: number | undefined,
    recoveryInterval: number | undefined,
    originTicks: number | null,
    serviceId: number | null,
    splitFieldSamples: boolean | undefined,
    passthrough = false,
  ) {
    this.#session = new Session(
      oversample,
      originTicks,
      serviceId,
      recoveryInterval,
      splitFieldSamples,
      passthrough,
    );
  }

  /** The timestamp presentation time zero stands for, once a fragment fixed it. */
  get originTicks(): number | null {
    return this.#session.originTicks ?? null;
  }

  /** The service being converted, once a program map has named it. */
  get serviceId(): number | null {
    return this.#session.serviceId ?? null;
  }

  /** Every service this transport stream announced, in the order it did. */
  get serviceIds(): number[] {
    return Array.from(this.#session.serviceIds);
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
   *
   * `loop` is the caller's own account of the time it spent around the calls
   * to this object, which goes out with the rate so that one report says where
   * all of the wall time went.
   */
  takeStats(loop: { readingMs: number; waitingMs: number }): Stats | null {
    if (this.#intervalFrames === 0 || this.#totalMs === 0) return null;
    const stats: Stats = {
      instantFps: (this.#intervalFrames * 1000) / this.#intervalMs,
      totalFps: (this.#totalFrames * 1000) / this.#totalMs,
      videoFrames: this.#videoFrames,
      audioFrames: this.#audioFrames,
      convertingMs: this.#intervalMs,
      readingMs: loop.readingMs,
      waitingMs: loop.waitingMs,
      dropped: this.#session.dropped,
      scrambled: this.#session.scrambled,
      errors: this.#session.errors,
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
