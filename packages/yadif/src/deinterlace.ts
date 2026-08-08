/**
 * Deinterlacing what the media element shows, on the GPU.
 *
 * A transport stream off the air is interlaced, and the converted H.264 keeps
 * it that way: the browser decodes each pair of fields into one frame, so what
 * a `<video>` puts on screen is combed wherever anything moved. Nothing in the
 * platform will undo that, and doing it on the CPU at 1080i is out of the
 * question, so this takes the frames the element presents and filters them in
 * WebGL, on a canvas laid over the element.
 *
 * The filter is supplied by the separate @mpeg2toh264/yadif package because it
 * is derived from FFmpeg and licensed differently. Everything here
 * is the machinery around it: three frames' worth of textures, a program, and
 * `requestVideoFrameCallback` to say when a frame is worth uploading.
 *
 * Frames are filtered one behind the element. yadif wants the frame either
 * side of the one it is working on, and the only way to hold the next one is
 * to wait for it, so the canvas is one frame -- around 33 ms -- behind the
 * audio. That is well inside what a viewer can tell, and the alternative is a
 * filter with half its motion measurements missing.
 *
 * A picture for every field wants two of them shown in the time one frame
 * arrives, and the callback saying a frame arrived is not a clock: it runs
 * when the page gets its turn, a refresh or so either side of the moment the
 * frame reaches the screen. Hanging the second field off that callback spaces
 * the two of them by however late it was, and loses the second one outright
 * whenever the next frame beats it -- which is motion that stops and starts
 * for no reason a viewer can see. So filtering and showing are separated
 * here: both fields of a frame are filtered into textures of their own as
 * soon as it arrives, given the moment they belong to by a clock run off the
 * media timeline, and put up by an animation frame loop that is the only
 * thing drawing on the canvas. The queue between the two is what a late
 * callback is absorbed by, and `bufferFields` is how much of it there is.
 */
import { YADIF_FRAGMENT_SHADER, YADIF_UNIFORMS } from "./shader.js";

/** How far the presentation time may jump before the held frames are stale. */
const CONTINUOUS_SECONDS = 0.5;

/** prev, cur and next: everything the filter reads. */
const HISTORY = 3;

/**
 * Filtered pictures held ready to go up.
 *
 * Two frames' worth of fields, because the pair of a frame is filtered while
 * the second field of the frame before it is still waiting for its moment.
 * Anything less and the picture would have to be filtered again at the point
 * of showing it, which is back to having the two tied together.
 */
const OUTPUTS = 4;

/** How often the filter says how it is getting on, in milliseconds. */
const STATS_INTERVAL_MS = 1000;

/** What a frame period has to be within to be believed, in milliseconds. */
const MIN_PERIOD_MS = 4;
const MAX_PERIOD_MS = 200;

/** How much of each measurement the smoothed frame period takes. */
const PERIOD_SMOOTHING = 0.25;

/**
 * How much of the error in the predicted display time is taken each frame.
 *
 * Low enough that a refresh of noise in one frame's estimate moves the fields
 * by a fraction of it, high enough to follow a clock that really is drifting
 * within a second or so.
 */
const CLOCK_SMOOTHING = 0.2;

/** The screen's refresh interval until animation frames have said otherwise. */
const DEFAULT_REFRESH_MS = 1000 / 60;

/** How fast the refresh estimate is allowed to climb back towards a long gap. */
const REFRESH_DECAY = 0.02;

const VERTEX_SHADER = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Putting a picture that has already been filtered onto the canvas.
 *
 * Both the texture it reads and the canvas it writes are held the way a
 * framebuffer is, rows from the bottom, so there is nothing to turn over
 * between them and the copy is texel for texel.
 */
const BLIT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uField;
out vec4 fragColor;
void main() {
  fragColor = texelFetch(uField, ivec2(gl_FragCoord.xy), 0);
}
`;

/** A filtered picture waiting for the moment it stands for. */
interface Ready {
  /** Which of the output textures holds it. */
  slot: number;
  /** When it belongs on the screen, on `performance.now()`'s clock. */
  at: number;
}

/**
 * How the filter is getting on, and where it is being let down.
 *
 * A deinterlacer is only as good as the frames it is given. yadif reads the
 * frame either side of the one it is filtering, and every count here that is
 * not `filtered` is a way of not having them: a frame the callback never saw
 * leaves the two neighbours two frames apart, and one filtered against a copy
 * of itself has no motion to measure at all. Both show up as combing that
 * comes and goes, which is worth being able to point at rather than guess at.
 */
export interface DeinterlaceStats {
  /** Frames filtered with a real frame on either side: the good case. */
  filtered: number;
  /**
   * Frames the element presented that the filter never saw, counted from the
   * gaps in `presentedFrames`. The neighbours of the frames either side of a
   * gap are further apart in time than the filter believes, so its idea of
   * what moved is wrong. A page that sees this climbing is asking the filter
   * to keep up with more than it can.
   */
  missed: number;
  /**
   * Frames the browser decoded and threw away without presenting, as the
   * element itself counts them. This is the machine being behind rather than
   * this filter: it happens with the deinterlacer off as well.
   */
  dropped: number;
  /**
   * Frames filtered with a copy of themselves standing in for a neighbour,
   * which is the start of a stream, the frame a seek lands on, and the last
   * frame before playback stops. Expected in ones and twos; a stream of them
   * means the held frames keep being thrown away.
   */
  degraded: number;
  /** Times the held frames were dropped as stale: seeks, and stream changes. */
  discontinuities: number;
  /**
   * Filtered pictures that were never shown, because an animation frame did
   * not come round while their moment was still ahead, or because the clock
   * they were timed by turned out to be somewhere else.
   *
   * Only a picture for every field can have these -- a picture for every frame
   * goes up as its frame arrives -- and they are the page being too busy to
   * keep a field rate rather than anything the filter did. A few are a hiccup,
   * and one every few seconds is a display whose refresh rate the field rate
   * does not divide into. A steady stream of them is a machine that cannot
   * show fields at all, and turning `doubleRate` off is the answer.
   */
  late: number;
  /** Frames presented per second over the last report. */
  fps: number;
  /**
   * What one frame costs, in milliseconds, averaged over the last report:
   * uploading it, filtering the picture or pair of pictures built from it, and
   * putting them up. This is the time on the page's own thread -- the GPU's
   * part of the draw is not in it -- so it is the measure of what the
   * deinterlacer takes away from everything else.
   */
  frameMs: number;
}

export interface DeinterlacerOptions {
  /**
   * Whether the top field of a frame is the one captured first. True for every
   * MPEG-2 broadcast format worth the name, which is why it is the default;
   * getting it wrong makes motion jerk back and forth by a field.
   */
  topFieldFirst?: boolean;
  /**
   * Whether to show a picture for every field rather than for every frame.
   *
   * Interlaced video carries two moments in each frame, and one output frame
   * per input frame throws the second one away: motion that was captured
   * fifty or sixty times a second is shown twenty-five or thirty. With this
   * on, each frame is filtered twice -- once keeping the field that came
   * first and once keeping the other -- and the second picture is put up half
   * a frame after the first, which is the moment it was taken at. Motion is
   * as smooth as the broadcast was, at twice the filtering.
   *
   * It needs a display that can show them: at 59.94 fields a second there is
   * one refresh of a 60 Hz screen for each, and nothing to spare.
   *
   * With `spatialCheck`, this is which of yadif's four modes runs: off/on is
   * `send_frame`, on/on is `send_field`, and the two with `spatialCheck` off
   * are the `nospatial` pair.
   */
  doubleRate?: boolean;
  /**
   * How many field intervals of slack to hold a picture for every field back
   * by, on top of the half a frame the second field is late by anyway.
   *
   * Every filtered field waits in a queue for the animation frame nearest the
   * moment it stands for. This is how much of the wait is spare: how late the
   * callback announcing a frame may be before the fields built from it have
   * already missed their turn. One field interval -- around 17 ms of a 1080i
   * broadcast -- covers a callback that slipped a refresh, which is what a
   * page under any load at all does now and again, and it is the default.
   *
   * Zero shows each field at the earliest moment it could be shown at, which
   * is the least delay and the least tolerance. Raising it past one or two
   * buys nothing a viewer will see and costs delay a viewer might.
   *
   * It has no effect at all without `doubleRate`, where a frame's one picture
   * goes up as the frame after it arrives and there is nothing to schedule.
   */
  bufferFields?: number;
  /**
   * Whether to let the local vertical range widen what the temporal check
   * allows. This is yadif's default and its `nospatial` mode turns it off.
   */
  spatialCheck?: boolean;
  /**
   * Called about once a second while frames are arriving, and not at all while
   * nothing is playing -- there is nothing to say about a filter that is not
   * being asked for anything.
   */
  onStats?(stats: DeinterlaceStats): void;
}

/** Field information supplied by a player or another video source. */
export interface Scan {
  interlaced: boolean;
  topFieldFirst: boolean;
}

/** Whether this browser has the two things the deinterlacer is built on. */
export function supportsDeinterlace(): boolean {
  return (
    typeof HTMLVideoElement !== "undefined" &&
    "requestVideoFrameCallback" in HTMLVideoElement.prototype &&
    typeof WebGL2RenderingContext !== "undefined"
  );
}

/**
 * Puts a deinterlaced copy of a `<video>` over the top of it.
 *
 * ```ts
 * const deinterlacer = new Deinterlacer(video);
 * deinterlacer.start();
 * ```
 *
 * `start()` wraps the element in a positioned `<div>` and adds a canvas over
 * it. The canvas takes no pointer events, so anything the page put on the
 * element still works, but it does cover the element's own controls; a page
 * that wants controls with this on has to draw them itself. `stop()` hides the
 * canvas again, which is all it takes to compare the two.
 */
export class Deinterlacer {
  readonly canvas: HTMLCanvasElement;

  readonly #video: HTMLVideoElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #location: Record<
    keyof typeof YADIF_UNIFORMS,
    WebGLUniformLocation | null
  >;
  /** The program that copies a filtered picture onto the canvas. */
  readonly #blit: WebGLProgram;
  readonly #blitField: WebGLUniformLocation | null;
  #textures: WebGLTexture[] = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #outputs: { texture: WebGLTexture; framebuffer: WebGLFramebuffer }[] = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #outputHead = OUTPUTS - 1;
  /** Filtered fields waiting for their moment, oldest first. */
  #queue: Ready[] = [];
  /** The rAF loop that puts them up, which is all that draws on the canvas. */
  #loopHandle: number | null = null;
  #lastLoopAt = 0;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #refreshMs = DEFAULT_REFRESH_MS;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #wrapper: HTMLElement | null = null;
  readonly #resizes: ResizeObserver;
  #topFieldFirst: boolean;
  #doubleRate: boolean;
  #bufferFields: number;
  #spatialCheck: boolean;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #periodMs = 0;
  /** Where the media timeline was last pinned to the wall clock, and when. */
  #clockMedia = 0;
  #clockWall = 0;
  #clocked = false;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #width = 0;
  #height = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #head = HISTORY - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #frames = 0;
  #lastMediaTime = 0;
  #handle: number | null = null;
  #running = false;
  #enabled = false;
  #scan: Scan | null = null;
  #lost = false;
  /** Coded sizes waiting for the media time at which their init takes effect. */
  #codedSizes: { width: number; height: number; start: number }[] = [];
  readonly #onStats: ((stats: DeinterlaceStats) => void) | undefined;
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #stats = { filtered: 0, missed: 0, degraded: 0, discontinuities: 0, late: 0 };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #lastPresented = 0;
  #reportedAt = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #lastFrameAt = 0;
  #framesSinceReport = 0;
  #msSinceReport = 0;

  constructor(video: HTMLVideoElement, options: DeinterlacerOptions = {}) {
    this.#video = video;
    this.#topFieldFirst = options.topFieldFirst ?? true;
    this.#doubleRate = options.doubleRate ?? false;
    this.#bufferFields = Math.max(0, options.bufferFields ?? 1);
    this.#spatialCheck = options.spatialCheck ?? true;
    this.#onStats = options.onStats;
    this.canvas = document.createElement("canvas");
    // Where it goes is worked out in #layout; the element underneath keeps
    // every click, since all this does is cover it.
    this.canvas.style.cssText =
      "position:absolute;pointer-events:none;visibility:hidden";
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("this browser has no WebGL2");
    this.#gl = gl;
    this.#program = createProgram(gl, YADIF_FRAGMENT_SHADER);
    const program = this.#program;
    this.#location = Object.fromEntries(
      Object.entries(YADIF_UNIFORMS).map(([key, name]) => [
        key,
        gl.getUniformLocation(program, name),
      ]),
    ) as Record<keyof typeof YADIF_UNIFORMS, WebGLUniformLocation | null>;
    this.#blit = createProgram(gl, BLIT_FRAGMENT_SHADER);
    this.#blitField = gl.getUniformLocation(this.#blit, "uField");
    this.canvas.addEventListener("webglcontextlost", this.#onContextLost);
    // The canvas is placed in pixels rather than in percentages, because where
    // the picture sits inside the element is arithmetic the browser does not
    // hand out. Anything that moves the element has to move it too.
    this.#resizes = new ResizeObserver(() => this.#layout());
    // A frame the filter has not seen the neighbours of is not worth holding:
    // whatever is next will have been somewhere else entirely.
    video.addEventListener("emptied", this.#onEmptied);
    // The picture changed shape without the element's box changing, which a
    // ResizeObserver has nothing to say about.
    video.addEventListener("resize", this.#onResize);
    // Nothing more is coming, so the frame being held back has to go out now
    // or the last thing a viewer sees is the one before it.
    video.addEventListener("pause", this.#onFlush);
    video.addEventListener("ended", this.#onFlush);
    video.addEventListener("seeked", this.#onFlush);
  }

  get running(): boolean {
    return this.#running;
  }

  set codedSize(size: { width: number; height: number; start: number } | null) {
    if (!size) {
      this.#codedSizes = [];
      return;
    }
    if (size.width <= 0 || size.height <= 0 || !Number.isFinite(size.start))
      return;
    const at = this.#codedSizes.findIndex((item) => item.start >= size.start);
    if (at >= 0 && this.#codedSizes[at]!.start === size.start)
      this.#codedSizes[at] = size;
    else
      this.#codedSizes.splice(at < 0 ? this.#codedSizes.length : at, 0, size);
  }

  /** Whether the caller wants filtering, independently of the current source. */
  get enabled(): boolean {
    return this.#enabled;
  }

  set enabled(enabled: boolean) {
    this.#enabled = enabled;
    this.#apply();
  }

  /** Update whether the source needs filtering and which field comes first. */
  set scan(scan: Scan | null) {
    this.#scan = scan;
    if (scan) this.#topFieldFirst = scan.topFieldFirst;
    this.#apply();
  }

  get scan(): Scan | null {
    return this.#scan;
  }

  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container(): HTMLElement {
    return this.#wrapper ?? this.#video;
  }

  /** Whether the top field of a frame is the one captured first. */
  get topFieldFirst(): boolean {
    return this.#topFieldFirst;
  }

  set topFieldFirst(topFieldFirst: boolean) {
    this.#topFieldFirst = topFieldFirst;
  }

  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate(): boolean {
    return this.#doubleRate;
  }

  set doubleRate(doubleRate: boolean) {
    if (doubleRate === this.#doubleRate) return;
    this.#doubleRate = doubleRate;
    if (doubleRate) {
      if (this.#width > 0) this.#allocateOutputs();
      this.#startLoop();
    } else {
      // Turning it off leaves fields on their way to a canvas that is about to
      // stop expecting them, and a frame's worth of texture each behind them.
      this.#stopLoop();
      this.#freeOutputs();
    }
  }

  /** How many field intervals of slack the field schedule is held back by. */
  get bufferFields(): number {
    return this.#bufferFields;
  }

  set bufferFields(fields: number) {
    this.#bufferFields = Math.max(0, fields);
  }

  #apply(): void {
    if (this.#enabled && (this.#scan?.interlaced ?? true)) this.start();
    else this.stop();
  }

  start(): void {
    if (this.#running || this.#lost) return;
    this.#running = true;
    this.#resetStats();
    this.#mount();
    this.#request();
    this.#startLoop();
  }

  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#handle !== null)
      this.#video.cancelVideoFrameCallback(this.#handle);
    this.#handle = null;
    this.#stopLoop();
    this.#frames = 0;
    this.#clocked = false;
    this.canvas.style.visibility = "hidden";
  }

  destroy(): void {
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    this.#video.removeEventListener("emptied", this.#onEmptied);
    this.#video.removeEventListener("resize", this.#onResize);
    this.#video.removeEventListener("pause", this.#onFlush);
    this.#video.removeEventListener("ended", this.#onFlush);
    this.#video.removeEventListener("seeked", this.#onFlush);
    this.#unmount();
    for (const texture of this.#textures) this.#gl.deleteTexture(texture);
    this.#textures = [];
    this.#freeOutputs();
    this.#gl.deleteProgram(this.#program);
    this.#gl.deleteProgram(this.#blit);
    this.#gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  #request(): void {
    if (!this.#running || this.#handle !== null) return;
    this.#handle = this.#video.requestVideoFrameCallback(this.#onFrame);
  }

  #onFrame = (
    _now: DOMHighResTimeStamp,
    metadata: VideoFrameCallbackMetadata,
  ): void => {
    this.#handle = null;
    if (!this.#running || this.#lost) return;
    if (metadata.width > 0 && metadata.height > 0) {
      // An init segment reaches the SourceBuffer before the sample it
      // describes. Do not resize on that notification: the element may still
      // be presenting the old resolution. Switch on the first callback at or
      // beyond the media boundary instead, so the texture and its source move
      // together even when the display dimensions happen to stay unchanged.
      let coded: { width: number; height: number; start: number } | undefined;
      while (
        this.#codedSizes.length > 0 &&
        this.#codedSizes[0]!.start <= metadata.mediaTime + 1e-6
      )
        coded = this.#codedSizes.shift();
      if (
        coded &&
        (coded.width !== this.#width || coded.height !== this.#height)
      )
        this.#resize(coded.width, coded.height);
      // Standalone users do not have a container feeding coded sizes. Their
      // callback dimensions remain the best available fallback.
      if (this.#width === 0 || this.#height === 0)
        this.#resize(metadata.width, metadata.height);
      // A seek, or a stream that starts again somewhere else, leaves the held
      // frames belonging to a different moment. Timing says so before any
      // event does, and playback that merely dropped a frame is left alone:
      // the neighbours are then further apart than they should be, which is
      // worth less than filtering nothing at all.
      const elapsed = metadata.mediaTime - this.#lastMediaTime;
      const stale = elapsed < 0 || elapsed > CONTINUOUS_SECONDS;
      if (stale) {
        this.#frames = 0;
        this.#stats.discontinuities++;
        // The fields still waiting stand for moments the element has left
        // behind, and the clock they were timed by is pinned to the same
        // place. Both start again from where playback actually is.
        this.#queue.length = 0;
        this.#clocked = false;
      }
      this.#count(metadata.presentedFrames, stale);
      // The same picture presented again, which the compositor does whenever
      // nothing new has been decoded: paused, stalled, or stopped at the end
      // of a stream, and at the display's rate rather than the video's.
      // Filtering it again would spend a frame's work on a canvas that
      // already holds the answer, and taking it into the ring would leave the
      // filter holding one moment twice over and calling it motion.
      if (this.#frames > 0 && metadata.mediaTime === this.#lastMediaTime) {
        this.#request();
        return;
      }
      if (!stale && elapsed > 0) this.#measure(elapsed);
      this.#lastMediaTime = metadata.mediaTime;
      const at = performance.now();
      // Frames stopped arriving for a while -- a pause, a stall, a tab in the
      // background -- and a rate averaged over time nothing was asked of the
      // filter says nothing about it. Begin the interval at this frame.
      if (at - this.#lastFrameAt > STATS_INTERVAL_MS) {
        this.#reportedAt = at;
        this.#framesSinceReport = 0;
        this.#msSinceReport = 0;
      }
      this.#lastFrameAt = at;
      this.#push();
      if (this.#scheduling()) {
        // The moment this frame reaches the screen is the moment the frame
        // before it stops standing for, so both of that one's fields hang off
        // it: the first half a frame later, and the second half a frame after
        // that, plus whatever slack the queue is being given.
        const half = this.#periodMs / 2;
        const first =
          this.#clock(metadata.mediaTime, metadata.expectedDisplayTime) +
          (1 + this.#bufferFields) * half;
        this.#filter(false, first);
        this.#filter(true, first + half);
      } else {
        this.#render(false, false, null);
      }
      this.#msSinceReport += performance.now() - at;
      this.#framesSinceReport++;
      this.#report(at);
    }
    this.#request();
  };

  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #scheduling(): boolean {
    return (
      this.#doubleRate && this.#periodMs > 0 && this.#outputs.length === OUTPUTS
    );
  }

  /**
   * How long a frame lasts in wall time, kept as a smoothed estimate.
   *
   * Taken from the frames themselves rather than from a frame rate nobody
   * reports, and in wall time, so a rate other than 1 moves the fields with
   * it. A frame the callback never saw makes the step between two of them a
   * whole multiple of the period, and dividing that back out matters: taken
   * at face value, one missed frame would put every field of the next one
   * half a frame late and hold the picture through a refresh it should have
   * moved in.
   */
  #measure(elapsed: number): void {
    const step = (elapsed * 1000) / (this.#video.playbackRate || 1);
    const frames =
      this.#periodMs > 0 ? Math.max(1, Math.round(step / this.#periodMs)) : 1;
    const period = step / frames;
    if (period < MIN_PERIOD_MS || period > MAX_PERIOD_MS) return;
    this.#periodMs =
      this.#periodMs > 0
        ? this.#periodMs + (period - this.#periodMs) * PERIOD_SMOOTHING
        : period;
  }

  /**
   * When this frame reaches the screen, from a clock that is pulled towards
   * what each frame says rather than set by it.
   *
   * `expectedDisplayTime` is an estimate, and it moves about by a refresh or
   * so either way even while playback is perfectly steady. Hanging two fields
   * off it directly passes that movement to the screen, which is exactly the
   * unevenness a picture for every field is meant to remove; running a clock
   * of the media timeline and correcting a fifth of the error each frame
   * keeps the fields evenly spaced while still following the element. An
   * error of more than a whole frame is not drift -- the element is
   * presenting from somewhere else, or at a rate it was not at before -- and
   * the clock goes straight there, taking the fields timed by the old one
   * with it.
   */
  #clock(mediaTime: number, displayAt: number): number {
    if (!this.#clocked) {
      this.#clocked = true;
      this.#clockMedia = mediaTime;
      this.#clockWall = displayAt;
      return displayAt;
    }
    const rate = this.#video.playbackRate || 1;
    const predicted =
      this.#clockWall + ((mediaTime - this.#clockMedia) * 1000) / rate;
    const error = displayAt - predicted;
    let at: number;
    if (Math.abs(error) > this.#periodMs) {
      at = displayAt;
      this.#stats.late += this.#queue.length;
      this.#queue.length = 0;
    } else {
      at = predicted + error * CLOCK_SMOOTHING;
    }
    this.#clockMedia = mediaTime;
    this.#clockWall = at;
    return at;
  }

  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #filter(second: boolean, at: number): void {
    const slot = (this.#outputHead + 1) % OUTPUTS;
    const output = this.#outputs[slot];
    if (!output) return;
    this.#outputHead = slot;
    // Whatever this slot held has been waiting two frames for a turn it never
    // got, and its moment is far enough past that showing it now would be a
    // step backwards. Slots are taken in order, so it can only be the oldest.
    while (this.#queue.length > 0 && this.#queue[0]?.slot === slot) {
      this.#queue.shift();
      this.#stats.late++;
    }
    this.#render(false, second, output.framebuffer);
    this.#queue.push({ slot, at });
  }

  /** The loop that puts filtered fields up, and the only thing that draws. */
  #startLoop(): void {
    if (this.#loopHandle !== null) return;
    if (!this.#running || this.#lost || !this.#doubleRate) return;
    this.#lastLoopAt = 0;
    this.#loopHandle = requestAnimationFrame(this.#onLoop);
  }

  #stopLoop(): void {
    if (this.#loopHandle !== null) cancelAnimationFrame(this.#loopHandle);
    this.#loopHandle = null;
    this.#queue.length = 0;
  }

  #onLoop = (now: DOMHighResTimeStamp): void => {
    this.#loopHandle = null;
    if (!this.#running || this.#lost || !this.#doubleRate) return;
    // Animation frames are as near as a page gets to seeing the screen, and
    // the gap between two of them is a refresh whenever neither was late.
    // Taking the shortest gap seen and letting it climb back slowly finds the
    // refresh interval from either side: a hitch pulls the estimate up by a
    // fiftieth, and the very next ordinary frame pulls it back down.
    if (this.#lastLoopAt > 0) {
      const gap = now - this.#lastLoopAt;
      if (gap >= 1 && gap <= MAX_PERIOD_MS) {
        this.#refreshMs =
          gap < this.#refreshMs
            ? gap
            : this.#refreshMs + (gap - this.#refreshMs) * REFRESH_DECAY;
      }
    }
    this.#lastLoopAt = now;
    this.#present(now);
    this.#loopHandle = requestAnimationFrame(this.#onLoop);
  };

  /**
   * Put up whichever filtered field belongs on the screen next.
   *
   * What is drawn during an animation frame reaches the screen at the composite
   * after it, so that is the moment being filled, and a field goes up at
   * whichever composite falls nearest the moment it stands for -- half a
   * refresh either side of it. Where two of them have come due since the last
   * one, only the newer is shown: a screen has one picture per refresh, and
   * the older of the two is a moment the viewer should already be past.
   */
  #present(now: number): void {
    const deadline = now + this.#refreshMs * 1.5;
    if ((this.#queue[0]?.at ?? Infinity) > deadline) return;
    let ready = this.#queue.shift();
    while ((this.#queue[0]?.at ?? Infinity) <= deadline) {
      this.#stats.late++;
      ready = this.#queue.shift();
    }
    if (!ready) return;
    const at = performance.now();
    this.#show(ready.slot);
    // Counted in the cost of the frame the field came from rather than as a
    // frame of its own, so `frameMs` stays the price of one frame of video.
    this.#msSinceReport += performance.now() - at;
  }

  /** Copy one of the filtered pictures onto the canvas. */
  #show(slot: number): void {
    const output = this.#outputs[slot];
    if (!output) return;
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.#blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, output.texture);
    gl.uniform1i(this.#blitField, 0);
    gl.viewport(0, 0, this.#width, this.#height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.canvas.style.visibility = "visible";
  }

  /**
   * Account for the frames between this one and the last one seen.
   *
   * There is no event for a frame the callback was not run for; the only sign
   * of one is that the count of frames the compositor has taken went up by
   * more than one. Frames thrown away either side of a discontinuity are not
   * counted: the held frames were being dropped anyway, and a seek presents
   * what it passes over.
   */
  #count(presented: number, stale: boolean): void {
    if (this.#lastPresented !== 0 && !stale) {
      this.#stats.missed += Math.max(0, presented - this.#lastPresented - 1);
    }
    this.#lastPresented = presented;
  }

  #report(at: number): void {
    if (!this.#onStats) return;
    const elapsed = at - this.#reportedAt;
    if (elapsed < STATS_INTERVAL_MS) return;
    const frames = this.#framesSinceReport;
    this.#onStats({
      ...this.#stats,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#video.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: (frames * 1000) / elapsed,
      frameMs: frames === 0 ? 0 : this.#msSinceReport / frames,
    });
    this.#reportedAt = at;
    this.#framesSinceReport = 0;
    this.#msSinceReport = 0;
  }

  /** Take the newest frame into the ring. */
  #push(): void {
    const gl = this.#gl;
    this.#head = (this.#head + 1) % HISTORY;
    gl.bindTexture(gl.TEXTURE_2D, this.#textures[this.#head] ?? null);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.#video,
    );
    this.#frames = Math.min(this.#frames + 1, HISTORY);
  }

  /**
   * Filter one frame, onto the canvas or into an output texture.
   *
   * A null `target` is the canvas itself, which is where the picture goes when
   * there is one per frame and nothing to schedule. An output framebuffer is a
   * field being kept for its moment.
   *
   * Which of the held frames is the one being filtered depends on how many
   * there are. In flight it is the middle one, with the newest waiting its
   * turn; where there is nothing on one side -- the start of a stream, or a
   * `flush` because the last frame has been presented and no more are coming
   * -- that side is the frame itself, which is what the reference filter does
   * at the ends of its input.
   *
   * `second` asks for the frame's other field: the same three frames filtered
   * the other way round, keeping the field that came second and rebuilding
   * the first. The shader takes the pair of frames the missing line sits
   * between from the parity, so this is the whole of it.
   */
  #render(
    flush: boolean,
    second: boolean,
    target: WebGLFramebuffer | null,
  ): void {
    if (this.#frames === 0 || this.#lost) return;
    if (this.#frames === HISTORY && !flush) this.#stats.filtered++;
    else this.#stats.degraded++;
    const gl = this.#gl;
    const newest = this.#head;
    const older = (this.#head + HISTORY - 1) % HISTORY;
    const oldest = (this.#head + 1) % HISTORY;
    let prev: number;
    let cur: number;
    let next: number;
    if (this.#frames === 1) {
      // One frame, standing in for its own neighbours, which is what the
      // reference does where its input ends. Nothing moved as far as the
      // filter can tell, so what comes back is very nearly the frame itself.
      prev = cur = next = newest;
    } else if (flush) {
      // The newest frame is the last there will be, so it stands in for the
      // one that would have come after it.
      prev = older;
      cur = next = newest;
    } else if (this.#frames === 2) {
      // The start of a stream: the older of the two is being filtered, and it
      // stands in for the frame before itself.
      prev = cur = older;
      next = newest;
    } else {
      prev = oldest;
      cur = older;
      next = newest;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.useProgram(this.#program);
    for (const [unit, texture] of [prev, cur, next].entries()) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.#textures[texture] ?? null);
    }
    gl.uniform1i(this.#location.prev, 0);
    gl.uniform1i(this.#location.cur, 1);
    gl.uniform1i(this.#location.next, 2);
    gl.uniform2i(this.#location.size, this.#width, this.#height);
    // The lines that survive are the ones of the field being shown: the first
    // field is the top one when the top field leads, and the second is the
    // other. A frame at a time is always the first.
    const first = this.#topFieldFirst ? 0 : 1;
    gl.uniform1i(this.#location.parity, second ? 1 - first : first);
    gl.uniform1i(this.#location.tff, this.#topFieldFirst ? 1 : 0);
    gl.uniform1i(this.#location.spatialCheck, this.#spatialCheck ? 1 : 0);
    gl.viewport(0, 0, this.#width, this.#height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // A picture filtered into a texture is not on the screen yet, and showing
    // the canvas for it would put up whatever was drawn on it last.
    if (target === null) this.canvas.style.visibility = "visible";
  }

  /**
   * Put the canvas exactly where the element's picture is.
   *
   * The buffer holds coded pixels and is stretched across a box of the shape
   * the picture is meant to be seen in, which is what applies the sample
   * aspect ratio -- the same stretch the element does with its own picture.
   * The box itself is the picture's, not the element's: a media element fits
   * its picture inside its box and this has to land on top of that, so the fit
   * is worked out again here. It assumes the element's `object-fit` is the
   * `contain` it is by default.
   */
  #layout(): void {
    if (!this.#wrapper) return;
    const video = this.#video;
    // The size the picture is to be seen at, sample aspect ratio and all.
    const displayWidth = video.videoWidth;
    const displayHeight = video.videoHeight;
    if (displayWidth === 0 || displayHeight === 0) return;
    const scale = Math.min(
      video.offsetWidth / displayWidth,
      video.offsetHeight / displayHeight,
    );
    const width = displayWidth * scale;
    const height = displayHeight * scale;
    this.canvas.style.left = `${video.offsetLeft + (video.offsetWidth - width) / 2}px`;
    this.canvas.style.top = `${video.offsetTop + (video.offsetHeight - height) / 2}px`;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  #resize(width: number, height: number): void {
    const gl = this.#gl;
    this.canvas.width = width;
    this.canvas.height = height;
    this.#width = width;
    this.#height = height;
    this.#frames = 0;
    this.#layout();
    for (const texture of this.#textures) gl.deleteTexture(texture);
    this.#textures = [];
    for (let index = 0; index < HISTORY; index++) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // Every read is a texelFetch at an integer coordinate, so there is
      // nothing for a filter or a mipmap to do.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // Allocated once and written with texSubImage2D after this, which is a
      // frame's worth of upload rather than a fresh allocation each time.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      this.#textures.push(texture);
    }
    this.#freeOutputs();
    if (this.#doubleRate) this.#allocateOutputs();
  }

  /**
   * Somewhere to keep a filtered field until its moment comes.
   *
   * A frame's worth of texture each, so they exist only while a picture is
   * being shown for every field. Where a framebuffer will not take one -- an
   * implementation that will not render to RGBA8, or memory it will not find
   * -- the whole lot goes and the fields are drawn as their frames arrive,
   * which is the timing this replaces but is still a picture.
   */
  #allocateOutputs(): void {
    const gl = this.#gl;
    if (this.#outputs.length === OUTPUTS || this.#width === 0) return;
    this.#freeOutputs();
    for (let index = 0; index < OUTPUTS; index++) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.#width,
        this.#height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      const complete =
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!complete) {
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(texture);
        this.#freeOutputs();
        return;
      }
      this.#outputs.push({ texture, framebuffer });
    }
    this.#outputHead = OUTPUTS - 1;
  }

  #freeOutputs(): void {
    const gl = this.#gl;
    for (const { texture, framebuffer } of this.#outputs) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
    }
    this.#outputs = [];
    this.#queue.length = 0;
  }

  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #mount(): void {
    if (this.#wrapper) return;
    const parent = this.#video.parentElement;
    if (!parent) return;
    const wrapper = document.createElement("div");
    wrapper.style.cssText =
      "position:relative;display:inline-block;line-height:0;max-width:100%";
    parent.insertBefore(wrapper, this.#video);
    wrapper.appendChild(this.#video);
    wrapper.appendChild(this.canvas);
    this.#wrapper = wrapper;
    this.#resizes.observe(this.#video);
    this.#layout();
  }

  #unmount(): void {
    const wrapper = this.#wrapper;
    this.#wrapper = null;
    this.#resizes.disconnect();
    this.canvas.remove();
    if (!wrapper?.parentElement) return;
    wrapper.parentElement.insertBefore(this.#video, wrapper);
    wrapper.remove();
  }

  #onResize = (): void => this.#layout();

  #onEmptied = (): void => {
    this.#frames = 0;
    this.#lastMediaTime = 0;
    this.#queue.length = 0;
    this.#clocked = false;
    this.#periodMs = 0;
    // The counts belong to the stream that has just gone; the next one starts
    // its own. The element resets its own dropped count for the same reason.
    this.#resetStats();
    this.canvas.style.visibility = "hidden";
  };

  #resetStats(): void {
    this.#stats = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
    };
    this.#lastPresented = 0;
    this.#reportedAt = 0;
    this.#lastFrameAt = 0;
    this.#framesSinceReport = 0;
    this.#msSinceReport = 0;
  }

  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #onFlush = (): void => {
    // The fields still queued stand for moments after this one and nothing is
    // coming to make sense of them, so the picture goes straight to the canvas
    // rather than through a schedule that has nothing left to keep to.
    this.#queue.length = 0;
    this.#clocked = false;
    if (this.#running) this.#render(true, false, null);
  };

  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #onContextLost = (event: Event): void => {
    event.preventDefault();
    this.#lost = true;
    this.stop();
  };
}

function createProgram(
  gl: WebGL2RenderingContext,
  source: string,
): WebGLProgram {
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, source);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // Attached shaders live as long as the program needs them, and it is the
  // program that holds them now.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(
      `the deinterlacer failed to link: ${log ?? "no reason given"}`,
    );
  }
  return program;
}

function compile(
  gl: WebGL2RenderingContext,
  kind: GLenum,
  source: string,
): WebGLShader {
  const shader = gl.createShader(kind);
  if (!shader) throw new Error("the deinterlacer could not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(
      `the deinterlacer failed to compile: ${log ?? "no reason given"}`,
    );
  }
  return shader;
}
