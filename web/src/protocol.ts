/**
 * What the page and the worker say to each other.
 *
 * Every message carries the `id` of the load it belongs to. The page hands out
 * those ids and both sides drop anything that does not match the load they are
 * on, which is how a `load()` over a running conversion leaves no stragglers.
 */

/** Stop handing fragments to the sink above this many bytes waiting to append. */
export const DEFAULT_QUEUE_HIGH_WATER_MARK = 32 * 1024 * 1024;

/** Seconds of played media kept behind the playhead when evicting. */
export const DEFAULT_KEEP_BEHIND_SECONDS = 10;

/**
 * How often the page tells the worker where the playhead is, in milliseconds.
 *
 * Eviction cannot run without it, and eviction is what unblocks a full buffer,
 * so this cannot wait on `timeupdate`: that event stops firing exactly when
 * playback stalls. It only runs while a conversion is in flight.
 */
export const PLAYHEAD_REPORT_INTERVAL_MS = 200;

/** Which side of the wire owns the `MediaSource`. */
export type SinkKind = "worker" | "main";

export type PlayerState =
  | "idle"
  | "loading"
  | "converting"
  /** The MSE buffer is full; conversion is paused until playback frees room. */
  | "buffer-full"
  /** The input has been converted in full. Playback may still be running. */
  | "completed"
  | "error";

export interface LoadCommand {
  type: "load";
  id: number;
  url: string;
  /** Where the `.wasm` is, or null to take the copy next to the worker. */
  wasmUrl: string | null;
  oversample: number | undefined;
  sink: SinkKind;
  queueHighWaterMark: number;
  keepBehindSeconds: number;
}

export type Command =
  | LoadCommand
  /** Where the playhead is now, in seconds. Worker-sink loads only. */
  | { type: "time"; id: number; currentTime: number }
  /** Whether the page's sink has room for more. Main-sink loads only. */
  | { type: "flow"; id: number; ready: boolean }
  | { type: "stop"; id: number };

export type Notification =
  /** Attach this to the media element. Worker-sink loads only. */
  | { type: "handle"; id: number; handle: MediaSourceHandle }
  /** Open a `SourceBuffer` and append this. Main-sink loads only. */
  | { type: "open"; id: number; mimeCodec: string; data: ArrayBuffer }
  /** Append this. Main-sink loads only. */
  | {
      type: "fragment";
      id: number;
      data: ArrayBuffer;
      start: number;
      randomAccess: boolean;
    }
  /** The source is attached and the first bytes are in: the load is playable. */
  | { type: "opened"; id: number }
  /** Put the playhead here; the media does not begin at zero. See MseSink. */
  | { type: "seek"; id: number; time: number }
  | {
      type: "progress";
      id: number;
      bytesRead: number;
      totalBytes: number | null;
    }
  | { type: "stats"; id: number; stats: Stats }
  /** The MSE buffer filled up, or made room again. Worker-sink loads only. */
  | { type: "blocked"; id: number; blocked: boolean }
  /** No more fragments are coming. Main-sink loads only. */
  | { type: "finish"; id: number }
  /** The whole input has been converted. */
  | { type: "completed"; id: number }
  | { type: "error"; id: number; message: string };

export interface Stats {
  /** Conversion rate over the last slice of input, in frames per second. */
  instantFps: number;
  /** Conversion rate over the whole load so far. */
  totalFps: number;
  videoFrames: number;
  audioFrames: number;
}

export interface Progress {
  bytesRead: number;
  /** The size of the input, when the server said what it was. */
  totalBytes: number | null;
}
