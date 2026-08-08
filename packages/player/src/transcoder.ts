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
  type AudioStream,
  type Fragment,
  type Progress,
} from "../wasm/mpeg2toh264_wasm.js";
import type { PicturePool } from "./pool.js";
import type { Stats } from "./protocol.js";

export type { AudioStream, Fragment };

/** Where the `.wasm` sits relative to this module, when no caller says. */
const DEFAULT_WASM_URL = new URL(
  "../wasm/mpeg2toh264_wasm_bg.wasm",
  import.meta.url,
);

let loaded: { url: string; module: Promise<WebAssembly.Module> } | null = null;

/**
 * Instantiate the module once per worker, however many loads run through it,
 * and keep what it was compiled from.
 *
 * The compiled module is what the picture workers are started with: a
 * `WebAssembly.Module` goes over `postMessage` as it stands, so the bytes are
 * fetched and compiled here and nowhere else however many workers there are.
 */
export function loadWasm(wasmUrl: string | null): Promise<WebAssembly.Module> {
  const url = wasmUrl ?? DEFAULT_WASM_URL.href;
  if (loaded?.url !== url) loaded = { url, module: compileAndInit(url) };
  return loaded.module;
}

async function compileAndInit(url: string): Promise<WebAssembly.Module> {
  const module = await compile(url);
  await init({ module_or_path: module });
  return module;
}

async function compile(url: string): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    // Streaming compilation insists on an `application/wasm` content type, and
    // not every way of serving this sets one. Reading the bytes first works
    // whatever the server says they are.
    const response = await fetch(url);
    return WebAssembly.compile(await response.arrayBuffer());
  }
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
  #pool: PicturePool | null = null;
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

  /** Every sound stream the chosen service offers, as its map describes them. */
  get audioStreams(): AudioStream[] {
    return Array.from(this.#session.audioStreams);
  }

  /** Which of them the fragments are being made from. */
  get audioPid(): number | null {
    return this.#session.audioPid ?? null;
  }

  /**
   * Whether the sound being read carries two services in one stream rather
   * than a stereo pair, as the frames read so far had it.
   */
  get audioIsDualMono(): boolean {
    return this.#session.audioIsDualMono;
  }

  /**
   * Take the sound from another of the service's streams, from the next
   * fragment on. What is already converted keeps the sound it was made with.
   */
  selectAudio(pid: number): void {
    this.#session.selectAudio(pid);
  }

  /** The same within a dual-mono stream, where the choice is the other channel. */
  selectDualMono(sub: boolean): void {
    this.#session.selectDualMono(sub);
  }

  /**
   * Convert the pictures of every unit in a pool rather than here.
   *
   * Null puts them back on this thread, which is what happens where a worker
   * cannot spawn workers. The output is the same either way; only where the
   * coding runs changes.
   */
  usePool(pool: PicturePool | null): void {
    this.#pool = pool;
  }

  async push(chunk: Uint8Array): Promise<Fragment[]> {
    if (!this.#pool) return this.#timed(() => this.#session.push(chunk));
    return this.#deferred(() => this.#session.pushDeferred(chunk));
  }

  async finish(): Promise<Fragment[]> {
    if (!this.#pool) return this.#timed(() => this.#session.finish());
    return this.#deferred(() => this.#session.finishDeferred());
  }

  /**
   * Run one step of the session and satisfy whatever it asks for, until it
   * asks for nothing.
   *
   * Completing a unit lets the session reach the one behind it, so this runs
   * down everything that is ready rather than one unit per call.
   *
   * The time counted is the wall clock across the whole of it, pool included,
   * which is what the rate on screen should mean: how fast the conversion is
   * going, rather than how busy this thread was while it went.
   */
  async #deferred(step: () => Progress): Promise<Fragment[]> {
    const started = performance.now();
    const fragments: Fragment[] = [];
    let progress = step();
    for (;;) {
      fragments.push(...progress.fragments);
      if (progress.jobs.length === 0) break;
      progress = this.#session.complete(await this.#pool!.run(progress.jobs));
    }
    const elapsed = performance.now() - started;
    this.#totalMs += elapsed;
    this.#intervalMs += elapsed;
    this.#account(fragments);
    return fragments;
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
    this.#totalMs += elapsed;
    this.#intervalMs += elapsed;
    this.#account(fragments);
    return fragments;
  }

  /** Count what a batch of fragments carried, however it was converted. */
  #account(fragments: Fragment[]): void {
    let videoFrames = 0;
    for (const fragment of fragments) {
      if (fragment.kind !== "media") continue;
      videoFrames += fragment.videoSamples;
      this.#audioFrames += fragment.audioSamples;
    }
    this.#videoFrames += videoFrames;
    this.#totalFrames += videoFrames;
    this.#intervalFrames += videoFrames;
  }
}

/**
 * The fragment's bytes are a copy wasm-bindgen made for us, so no one else
 * holds the buffer: it can be transferred rather than copied a second time.
 */
export function detach(fragment: Fragment): ArrayBuffer {
  return fragment.data.buffer as ArrayBuffer;
}
