/**
 * What the page and the worker say to each other.
 *
 * Every message carries the `id` of the load it belongs to. The page hands out
 * those ids and both sides drop anything that does not match the load they are
 * on, which is how a `load()` over a running conversion leaves no stragglers.
 */

/** Stop handing fragments to the sink above this many bytes waiting to append. */
export const DEFAULT_QUEUE_HIGH_WATER_MARK = 32 * 1024 * 1024;

/**
 * How many fragments may wait to be appended before conversion pauses.
 *
 * This is what bounds the delay, where the byte mark bounds the memory. There
 * is nothing to gain by converting further ahead than this: a fragment waiting
 * in a queue is a fragment the viewer cannot watch, and where the MediaSource
 * lives in the worker it is worse than nothing -- appending is a task on the
 * same event loop as the conversion, so a queue that never fills is a queue
 * that never drains either, and the buffer stays empty for as long as there is
 * input left to read. Two is one being appended and one ready to follow it.
 */
export const QUEUE_HIGH_WATER_FRAGMENTS = 2;

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

/**
 * How much of the end of the input to read when looking for its length.
 *
 * The answer is in the last PES header the slice holds, and a transport stream
 * carries one per picture, so this is orders of magnitude more than it takes.
 * It is sized instead so that a file ending in padding still has a timestamp
 * somewhere inside it.
 */
export const TAIL_PROBE_BYTES = 1 << 20;

/**
 * How far past the requested time a seek may land before it is tried again.
 *
 * Where the bytes are is worked out from the average bitrate, so a variable
 * bitrate lands somewhere either side of the mark. Undershooting is free --
 * playback simply starts a little early -- but overshooting loses what the
 * viewer asked to see, so only that is worth another request.
 */
export const SEEK_OVERSHOOT_TOLERANCE_SECONDS = 1;

/** How far back beyond the overshoot to aim when trying again. */
export const SEEK_RETRY_MARGIN_SECONDS = 2;

/** How many range requests one seek may spend before taking what it gets. */
export const SEEK_ATTEMPTS = 3;

/** Which side of the wire owns the `MediaSource`. */
export type SinkKind = "worker" | "main";

export type PlayerState =
  | "idle"
  | "loading"
  | "converting"
  /** The MSE buffer is full; conversion is paused until playback frees room. */
  | "buffer-full"
  /** Playback moved outside the buffer; the input is being read again. */
  | "seeking"
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
  /** Play from here instead; the buffer does not reach it. See `seekable`. */
  | { type: "seek"; id: number; time: number }
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
  /**
   * The input turned out to be one that can be seeked in, and this is how long
   * it is, in seconds. A live stream, or a server that will not serve byte
   * ranges, never sends this.
   */
  | { type: "seekable"; id: number; duration: number }
  /** Throw away everything buffered; a seek is about to refill it. */
  | { type: "reset"; id: number }
  /** A step of the load happened, for whoever is measuring. See `TimingMark`. */
  | { type: "mark"; id: number; name: TimingMark; at: number }
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

/**
 * The steps of getting from a URL to a picture, in the order they happen.
 *
 * Between a load and the first frame there are two machines -- this one and
 * the browser's -- and either can be the slow one, so the names cover both:
 * everything up to `opened` is the worker's, and the rest is the media
 * element saying what it made of what it was given. A seek starts the sequence
 * again from `seek`.
 */
export type TimingMark =
  /** The worker took the load. */
  | "load"
  /** The WebAssembly module is instantiated. Only the first load pays this. */
  | "wasm"
  /** The response headers are in: the server has started answering. */
  | "response"
  /** The first slice of the input has been read. */
  | "first-byte"
  /** The transcoder has produced a fragment: the first picture is converted. */
  | "first-fragment"
  /** The initialization segment has reached the sink; the stream is open. */
  | "opened"
  /** The page has put the source on the media element. */
  | "attached"
  /** The media element has taken the MediaSource and opened it. */
  | "sourceopen"
  /** The first media segment is in the buffer: MSE has everything it needs. */
  | "appended"
  /** The end of the file has been read, so its length is known. */
  | "measured"
  /** A seek was taken, and the marks after it belong to reading it again. */
  | "seek"
  /** The element has the metadata of what it is playing. */
  | "loadedmetadata"
  /** The element has a frame at the playhead. */
  | "loadeddata"
  /** The element could start playing: as early as playback can begin. */
  | "canplay"
  /** The element is showing frames. */
  | "playing"
  /** The element ran out of buffered media and stopped. */
  | "waiting";

/** One step of a load, and how long it took to get there. */
export interface Timing {
  name: TimingMark;
  /** Milliseconds since `load()` was called. */
  sinceLoad: number;
  /** Milliseconds since the step before it, whatever that was. */
  sincePrevious: number;
}

export interface Stats {
  /** Conversion rate over the last slice of input, in frames per second. */
  instantFps: number;
  /** Conversion rate over the whole load so far. */
  totalFps: number;
  videoFrames: number;
  audioFrames: number;
  /**
   * Where the read loop's wall time went since the last report, in
   * milliseconds. The three cover everything it does, so which one is large
   * says which machine is the slow one: `converting` is this transcoder,
   * `reading` is the network or the disk behind the URL, and `waiting` is Media
   * Source Extensions refusing more until it has appended what it has.
   *
   * `waiting` is the one that separates the two MediaSource placements. With
   * the buffer in this worker, appending competes for the same thread as the
   * conversion; with it on the page, the two run at once.
   */
  convertingMs: number;
  readingMs: number;
  waitingMs: number;
}

export interface Progress {
  /** How far into the input reading has got, which a seek moves. */
  bytesRead: number;
  /** The size of the input, when the server said what it was. */
  totalBytes: number | null;
}
