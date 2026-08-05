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

/**
 * How far ahead of the playhead the buffer may run before conversion pauses.
 *
 * Converting is several times faster than watching, so without a limit the
 * buffer fills with everything between the playhead and the end of the file.
 * Every browser puts a ceiling on a SourceBuffer, and they do not agree on
 * what happens at it: Chrome throws `QuotaExceededError` and hands the
 * decision back, Firefox evicts by itself. What Firefox evicts has to leave
 * the rest decodable, so it goes as far as the next random access point --
 * which at a restart every twenty-four groups of pictures can be seconds in
 * front of the playhead. Playback then stops on media that is gone, and no
 * `seeking` event fires to say so.
 *
 * There is nothing to gain from a longer lead anyway: the conversion refills
 * this in a fraction of the time it takes to watch it.
 */
export const DEFAULT_MAX_AHEAD_SECONDS = 8;

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
 * How much of the input to read when asking what time it is at a byte.
 *
 * A transport stream carries a PES header every picture, so the answer is in
 * the first few kilobytes; this is sized for the gap between them in a stream
 * whose video has stopped for a moment, and it is small enough that spending
 * several of them still costs less than transcoding a second of video.
 */
export const SEEK_PROBE_BYTES = 128 * 1024;

/** How many of those a seek may read before it takes the best offset it has. */
export const SEEK_PROBE_ATTEMPTS = 4;

/** How near the mark a probe has to land for the search to stop. */
export const SEEK_PROBE_TOLERANCE_SECONDS = 0.5;

/**
 * How far before the requested time a seek aims to open the input.
 *
 * Landing after it would lose what the viewer asked to see, and reading is
 * cheap next to converting, so the search aims a little early on purpose. The
 * conversion then starts at the first group of pictures after that, which is
 * itself up to a group later.
 */
export const SEEK_LEAD_SECONDS = 1;

/** Which side of the wire owns the `MediaSource`. */
export type SinkKind = "worker" | "main";

/**
 * How the source pictures were captured, as the MPEG-2 headers said.
 *
 * This is the one thing about the picture that the conversion cannot carry:
 * H.264 is decoded into frames, and a frame holding two moments is not
 * distinguishable from one holding a single moment once it has been decoded.
 * A player that deinterlaces has to be told, and this is the telling -- which
 * lines to keep, and whether to filter at all.
 *
 * A broadcast can change it mid-stream, where a station cuts between film and
 * a live camera, so it arrives whenever it changes rather than once.
 */
export interface Scan {
  /** Whether the pictures hold two moments each. */
  interlaced: boolean;
  /** Which of the two came first. Only meaningful with `interlaced`. */
  topFieldFirst: boolean;
}

/** A private PES payload from the selected service. */
export interface PrivateStream {
  /** Elementary stream PID from the program map. */
  pid: number;
  /** Payload after the PES header. Ownership belongs to the event receiver. */
  data: ArrayBuffer;
  /** Presentation time in media seconds, or null when the PES form has no PTS. */
  pts: number | null;
}

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
  /**
   * Which service to convert, out of a transport stream that carries more than
   * one. Null takes the first that turns up with a picture in it, which is
   * what a recording of a single programme has anyway.
   */
  serviceId: number | null;
  sink: SinkKind;
  queueHighWaterMark: number;
  maxAheadSeconds: number;
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
  /**
   * What the source said about its fields, when it first says it and whenever
   * it changes. See `Scan`.
   */
  | { type: "scan"; id: number; scan: Scan }
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
  /**
   * What services the transport stream announced and which of them is being
   * converted. Sent once the program tables have been read, and again after a
   * seek re-reads them.
   */
  | { type: "services"; id: number; services: Services }
  | { type: "private_stream_1"; id: number; stream: PrivateStream }
  | { type: "private_stream_2"; id: number; stream: PrivateStream }
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
  dropped: number;
  scrambled: number;
  errors: number;
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

/** What a transport stream is carrying, and which of it is being watched. */
export interface Services {
  /** Every service the program association table announced, in its order. */
  available: number[];
  /** The one the fragments are being made from, or null before it is known. */
  current: number | null;
}

export interface Progress {
  /** How far into the input reading has got, which a seek moves. */
  bytesRead: number;
  /** The size of the input, when the server said what it was. */
  totalBytes: number | null;
}
