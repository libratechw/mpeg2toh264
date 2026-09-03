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
 */
import {
  FILM_ANALYSIS_HEIGHT,
  FILM_ANALYSIS_FRAGMENT_SHADER,
  FILM_ANALYSIS_WIDTH,
  FILM_SAMPLE_FRAGMENT_SHADER,
  FILM_UNIFORMS,
  FILM_WEAVE_FRAGMENT_SHADER,
  YADIF_FRAGMENT_SHADER,
  YADIF_UNIFORMS,
} from "./shader.js";
import { FFmpegIVTC } from "./ivtc.js";

/** How far the presentation time may jump before the held frames are stale. */
const CONTINUOUS_SECONDS = 0.5;

/** prev, cur and next: everything the filter reads. */
const HISTORY = 3;

const FIELD_QUEUE_LENGTH = 5;

/**
 * One output remains reserved while its picture is represented by the canvas,
 * so `capture()` can reproduce it without preserving the drawing buffer.
 */
const OUTPUT_POOL_LENGTH = FIELD_QUEUE_LENGTH + 1;

/** How often the filter says how it is getting on, in milliseconds. */
const STATS_INTERVAL_MS = 1000;

/** What a frame period has to be within to be believed, in milliseconds. */
const MIN_PERIOD_MS = 4;
const MAX_PERIOD_MS = 200;

/** How much of each measurement the smoothed frame period takes. */
const PERIOD_SMOOTHING = 0.25;

/** The screen's refresh interval until animation frames have said otherwise. */
const DEFAULT_REFRESH_MS = 1000 / 60;

/** How fast the refresh estimate is allowed to climb back towards a long gap. */
const REFRESH_DECAY = 0.02;

function validateFilmCombThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0",
    );
  return value;
}

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
uniform bool uFlip;
out vec4 fragColor;
void main() {
  ivec2 position = ivec2(gl_FragCoord.xy);
  if (uFlip) position.y = textureSize(uField, 0).y - 1 - position.y;
  fragColor = texelFetch(uField, position, 0);
}
`;

/** A filtered picture waiting for the moment it stands for. */
interface Ready {
  /** Which of the output textures holds it. */
  slot: number;
  /** When it belongs on the screen, on `performance.now()`'s clock. */
  at: number;
  duration: number;
}

/** The draw path that produced the picture still represented by the canvas. */
type PresentedPicture =
  | { kind: "texture"; texture: WebGLTexture; flip: boolean }
  | { kind: "yadif"; flush: boolean; second: boolean }
  | { kind: "film" };

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
  /**
   * Retained for compatibility with existing statistics consumers.
   * Late pictures are discarded individually, so this counter remains zero.
   */
  queueResetted: number;
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
  /**
   * The largest number of pictures queued during the last reporting interval,
   * across both the field-rate and film scheduling paths.
   */
  maxQueuedFields: number;
  /** The render path currently selected by automatic cadence detection. */
  mode: "film" | "video";
  /** The field match selected for the most recently analysed frame. */
  match: "p" | "c" | "n";
  /** Largest 16 by 16 block count of vertically adjacent combed pixels. */
  combScore: number;
  /** Pictures actually copied to the canvas per second. */
  outputFps: number;
  /** Smallest block difference in the most recently completed decimate cycle. */
  duplicateScore: number;
  /** Next-smallest block difference in the most recently completed cycle. */
  duplicateRunnerUp: number;
}

export interface DeinterlacerOptions {
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
   * Whether hard-telecined film is reconstructed and shown at its native
   * 24000/1001 cadence. Matching follows FFmpeg's
   * `fieldmatch=mode=pc_n:combmatch=full:mchroma=0`, and duplicate decisions
   * follow `decimate=cycle=5:mixed=1`. Frames that do not form a clean film
   * cadence continue through YADIF.
   */
  autoFilm?: boolean;
  /**
   * The combed-pixel threshold for a 16 by 16 block. A fieldmatch result with
   * a score at or above this value is considered combed. This is the browser
   * equivalent of FFmpeg fieldmatch's `combpel` threshold.
   */
  filmCombThreshold?: number;
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

export interface VideoState {
  start: number;
  codedSize?: { width: number; height: number };
  scan?: Scan;
}

export interface DeinterlacerEventMap {
  stats: CustomEvent<DeinterlaceStats>;
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
 *
 * While frames are arriving, the current counters are also dispatched as a
 * `stats` event about once a second. The optional `onStats` callback receives
 * the same snapshot for callers that prefer a constructor option.
 */
export class Deinterlacer extends EventTarget {
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
  readonly #blitFlip: WebGLUniformLocation | null;
  /** The reduced pass that reads previous, current and next luma together. */
  #filmAnalysis: WebGLProgram | null = null;
  #filmAnalysisLocation: Record<
    Exclude<keyof typeof FILM_UNIFORMS, "match" | "topFieldFirst">,
    WebGLUniformLocation | null
  > | null = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #filmWeave: WebGLProgram | null = null;
  #filmWeaveLocation: Record<
    keyof typeof FILM_UNIFORMS,
    WebGLUniformLocation | null
  > | null = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #filmSample: WebGLProgram | null = null;
  #filmSampleLocation: Record<
    keyof typeof FILM_UNIFORMS,
    WebGLUniformLocation | null
  > | null = null;
  #analysisTarget: {
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    pixels: Uint8Array;
    previousLuma: Uint8Array;
    currentLuma: Uint8Array;
    nextLuma: Uint8Array;
  } | null = null;
  #textures: WebGLTexture[] = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #outputs: { texture: WebGLTexture; framebuffer: WebGLFramebuffer }[] = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #outputHead = OUTPUT_POOL_LENGTH - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #presentedPicture: PresentedPicture | null = null;
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
  #doubleRate: boolean;
  #autoFilm: boolean;
  #filmCombThreshold: number;
  #spatialCheck: boolean;
  #mode: "film" | "video" = "video";
  #match: "p" | "c" | "n" = "c";
  #combScore = 0;
  #isCombed = true;
  readonly #ivtc = new FFmpegIVTC(FILM_ANALYSIS_WIDTH, FILM_ANALYSIS_HEIGHT);
  #duplicateScore = Infinity;
  #duplicateRunnerUp = Infinity;
  #outputSinceReport = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #periodMs = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #width = 0;
  #height = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #head = HISTORY - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #frames = 0;
  #lastMediaTime = 0;
  /** A destination frame that arrived before the browser finished seeking. */
  #seekFrameReady = false;
  #handle: number | null = null;
  #running = false;
  #enabled = false;
  #scan: Scan | null = null;
  #videoTimeline: readonly VideoState[] = [];
  #lost = false;
  readonly #onStats: ((stats: DeinterlaceStats) => void) | undefined;
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #stats = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    late: 0,
    queueResetted: 0,
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #lastPresented = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #lastFrameAt = 0;
  #reportedAt = 0;
  #renderFramesSinceReport = 0;
  #renderMsSinceReport = 0;
  #showFramesSinceReport = 0;
  #showMsSinceReport = 0;
  #reportMaxQueuedFields = 0;

  constructor(video: HTMLVideoElement, options: DeinterlacerOptions = {}) {
    super();
    this.#video = video;
    this.#doubleRate = options.doubleRate ?? false;
    this.#autoFilm = options.autoFilm ?? false;
    this.#filmCombThreshold = validateFilmCombThreshold(
      options.filmCombThreshold ?? FFmpegIVTC.COMBED_PIXEL_LIMIT,
    );
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
    this.#blitFlip = gl.getUniformLocation(this.#blit, "uFlip");
    if (this.#autoFilm) this.#ensureFilmPrograms();
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
    video.addEventListener("seeking", this.#onSeeking);
    video.addEventListener("seeked", this.#onFlush);
    video.addEventListener("ratechange", this.#onFlush);
  }

  get running(): boolean {
    return this.#running && (this.#scan?.interlaced ?? true);
  }

  /** Field order for the current scan state, defaulting to top-field-first. */
  get #topFieldFirst(): boolean {
    return this.#scan?.topFieldFirst !== false;
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
    const interlacingChanged = this.#scan?.interlaced !== scan?.interlaced;
    const changed =
      interlacingChanged || this.#scan?.topFieldFirst !== scan?.topFieldFirst;
    this.#scan = scan;
    if (changed) {
      // A standalone caller may update scan metadata without a timeline entry.
      // Do not let history or queued fields measured under the old parity cross
      // the new source state.
      this.#frames = 0;
      this.#resetFilm();
      // Progressive video carries no cadence measurement, so schedule fields
      // only after measuring the first complete interlaced interval
      if (interlacingChanged) this.#periodMs = 0;
      this.#presentedPicture = null;
      this.canvas.style.visibility = "hidden";
    }
    this.#apply();
    if (changed) {
      if (scan?.interlaced ?? true) this.#startLoop();
      else this.#stopLoop();
    }
  }

  get scan(): Scan | null {
    return this.#scan;
  }

  set videoTimeline(timeline: readonly VideoState[]) {
    this.#videoTimeline = timeline;
    if (timeline.length === 0) this.#scan = null;
    this.#apply();
  }

  get videoTimeline(): readonly VideoState[] {
    return this.#videoTimeline;
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

  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate(): boolean {
    return this.#doubleRate;
  }

  set doubleRate(doubleRate: boolean) {
    if (doubleRate === this.#doubleRate) return;
    this.#doubleRate = doubleRate;
    // A rate change gives every queued field a different presentation cadence,
    // so the next decoded frame starts a new schedule on the current timeline.
    this.#queue.length = 0;
    if (doubleRate) {
      if (this.#width > 0) this.#allocateOutputs();
      if (this.#scan?.interlaced ?? true) this.#startLoop();
    } else if (!this.#autoFilm) {
      // Turning it off leaves fields on their way to a canvas that is about to
      // stop expecting them, and a frame's worth of texture each behind them.
      this.#stopLoop();
      this.#presentedPicture = null;
      this.canvas.style.visibility = "hidden";
      this.#freeOutputs();
    }
  }

  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm(): boolean {
    return this.#autoFilm;
  }

  set autoFilm(autoFilm: boolean) {
    if (autoFilm === this.#autoFilm) return;
    this.#autoFilm = autoFilm;
    this.#resetFilm();
    if (autoFilm) {
      this.#ensureFilmPrograms();
      if (this.#width > 0) {
        this.#allocateAnalysisTarget();
        this.#allocateOutputs();
      }
      if (this.#scan?.interlaced ?? true) this.#startLoop();
    } else {
      this.#freeAnalysisTarget();
      if (!this.#doubleRate) {
        this.#stopLoop();
        this.#presentedPicture = null;
        this.canvas.style.visibility = "hidden";
        this.#freeOutputs();
      }
    }
  }

  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold(): number {
    return this.#filmCombThreshold;
  }

  set filmCombThreshold(value: number) {
    const validated = validateFilmCombThreshold(value);
    if (validated === this.#filmCombThreshold) return;
    this.#filmCombThreshold = validated;
    if (this.#autoFilm) this.#resetFilm();
  }

  #apply(): void {
    if (
      this.#enabled &&
      (this.#videoTimeline.length > 0 || (this.#scan?.interlaced ?? true))
    )
      this.start();
    else this.stop();
  }

  start(): void {
    if (this.#running || this.#lost) return;
    this.#running = true;
    this.#resetStats();
    this.#resetFilm();
    this.#mount();
    this.#request();
    if (this.#scan?.interlaced ?? true) this.#startLoop();
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
    this.#presentedPicture = null;
    this.canvas.style.visibility = "hidden";
  }

  destroy(): void {
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    this.#video.removeEventListener("emptied", this.#onEmptied);
    this.#video.removeEventListener("resize", this.#onResize);
    this.#video.removeEventListener("pause", this.#onFlush);
    this.#video.removeEventListener("ended", this.#onFlush);
    this.#video.removeEventListener("seeking", this.#onSeeking);
    this.#video.removeEventListener("seeked", this.#onFlush);
    this.#video.removeEventListener("ratechange", this.#onFlush);
    this.#unmount();
    for (const texture of this.#textures) this.#gl.deleteTexture(texture);
    this.#textures = [];
    this.#freeOutputs();
    this.#freeAnalysisTarget();
    this.#gl.deleteProgram(this.#program);
    this.#gl.deleteProgram(this.#blit);
    if (this.#filmAnalysis) this.#gl.deleteProgram(this.#filmAnalysis);
    if (this.#filmWeave) this.#gl.deleteProgram(this.#filmWeave);
    if (this.#filmSample) this.#gl.deleteProgram(this.#filmSample);
    this.#gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /**
   * Copy the picture currently represented by the deinterlacer.
   *
   * The WebGL drawing buffer is deliberately not preserved between browser
   * composites. Repeating the exact draw path of the presented picture before
   * `createImageBitmap` makes a snapshot reliable without imposing the
   * permanent cost of `preserveDrawingBuffer` on ordinary playback.
   */
  capture(): Promise<ImageBitmap> {
    const picture = this.#presentedPicture;
    if (!this.#running || this.#lost || !picture)
      return createImageBitmap(this.#video);
    if (picture.kind === "texture")
      this.#showTexture(picture.texture, picture.flip, false);
    else if (picture.kind === "yadif")
      this.#render(picture.flush, picture.second, null, false);
    else this.#renderFilm(null, false);
    const width = this.#video.videoWidth;
    const height = this.#video.videoHeight;
    if (
      width > 0 &&
      height > 0 &&
      (width !== this.canvas.width || height !== this.canvas.height)
    )
      return createImageBitmap(this.canvas, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: "high",
      });
    return createImageBitmap(this.canvas);
  }

  override addEventListener<K extends keyof DeinterlacerEventMap>(
    type: K,
    listener: (event: DeinterlacerEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
  }

  override removeEventListener<K extends keyof DeinterlacerEventMap>(
    type: K,
    listener: (event: DeinterlacerEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
  }

  #request(): void {
    if (!this.#running || this.#handle !== null) return;
    this.#handle = this.#video.requestVideoFrameCallback(this.#onFrame);
  }

  #onFrame = (
    now: DOMHighResTimeStamp,
    metadata: VideoFrameCallbackMetadata,
  ): void => {
    this.#handle = null;
    if (!this.#running || this.#lost) return;
    this.#selectVideoState(metadata.mediaTime);
    if (metadata.width > 0 && metadata.height > 0) {
      // Chromium can submit the destination frame while `seeking` is still
      // true, immediately before `seeked`. Remember that this frame already
      // belongs to the new playhead so the event does not hide it again.
      let seekFrame = false;
      if (!this.#seekFrameReady && this.#video.seeking) {
        const buffered = this.#video.buffered;
        // mediaTime is the start of the frame containing the playhead, so it
        // may precede currentTime by one measured frame period.
        const frameSeconds =
          this.#periodMs >= MIN_PERIOD_MS
            ? this.#periodMs / 1000
            : MAX_PERIOD_MS / 1000;
        for (let index = 0; index < buffered.length; index++) {
          if (
            metadata.mediaTime >= buffered.start(index) &&
            metadata.mediaTime < buffered.end(index) &&
            Math.abs(metadata.mediaTime - this.#video.currentTime) <=
              frameSeconds
          ) {
            seekFrame = true;
            break;
          }
        }
      }
      if (seekFrame) this.#seekFrameReady = true;
      // Standalone users do not have a container feeding coded sizes. Their
      // callback dimensions remain the best available fallback.
      if (this.#width === 0 || this.#height === 0)
        this.#resize(metadata.width, metadata.height);
      if (this.#scan && !this.#scan.interlaced) {
        this.#showVideo();
        this.#request();
        return;
      }
      // A seek, or a stream that starts again somewhere else, leaves the held
      // frames belonging to a different moment. Timing says so before any
      // event does, and playback that merely dropped a frame is left alone:
      // the neighbours are then further apart than they should be, which is
      // worth less than filtering nothing at all.
      const elapsed = metadata.mediaTime - this.#lastMediaTime;
      const stale = seekFrame || elapsed < 0 || elapsed > CONTINUOUS_SECONDS;
      if (stale) {
        this.#frames = 0;
        this.#periodMs = 0;
        this.#stats.discontinuities++;
        // The fields still waiting stand for moments the element has left
        // behind, and the clock they were timed by is pinned to the same
        // place. Both start again from where playback actually is.
        this.#queue.length = 0;
        this.#resetFilm();
      }
      const skippedFilmFrame =
        this.#autoFilm &&
        this.#lastPresented !== 0 &&
        metadata.presentedFrames - this.#lastPresented > 1;
      this.#count(metadata.presentedFrames, stale);
      if (!stale && skippedFilmFrame) {
        // A cadence decision cannot span a picture the callback did not see.
        // Refill the three-frame history before matching fields again.
        this.#frames = 0;
        this.#resetFilm();
      }
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
        this.#renderFramesSinceReport = 0;
        this.#renderMsSinceReport = 0;
        this.#showFramesSinceReport = 0;
        this.#showMsSinceReport = 0;
        this.#reportMaxQueuedFields = 0;
        this.#outputSinceReport = 0;
      }
      this.#lastFrameAt = at;
      const begin = performance.now();
      this.#push();
      const previousMode = this.#mode;
      const filmFrameShouldBeDropped =
        this.#autoFilm && this.#frames === HISTORY && this.#analyseFilm();
      const cadenceChanged = previousMode !== this.#mode;
      // A duplicate that confirms film cadence adds no output, but stale field
      // deadlines from the old mode still need discarding at the transition
      if (cadenceChanged) this.#queue.length = 0;
      // Decimation is only safe when the output schedule can retain the
      // selected film picture. If allocation or timing is not ready, keep the
      // frame on the direct path rather than silently dropping it.
      const shouldDropFilmFrame =
        filmFrameShouldBeDropped && this.#scheduling();
      if (shouldDropFilmFrame) {
        // decimate removes this duplicate before YADIF, so it contributes no
        // output picture to the reconstructed film cadence.
      } else if (this.#autoFilm && !this.#isCombed && this.#mode === "film") {
        if (this.#scheduling()) {
          // Five input frames become four film pictures. The interval between
          // them is therefore five quarters of the measured input period.
          const duration = (this.#periodMs * 5) / 4;
          const queueResetted = this.#prepareQueue(1, now, duration);
          // The first picture needs one output interval of presentation slack;
          // otherwise an ordinary callback-to-rAF gap can consume its turn.
          const last = this.#queue.at(-1);
          const at = queueResetted
            ? now
            : last == null
              ? now + duration
              : last.at + last.duration;
          this.#filterFilm(at, duration);
        } else {
          // Until a period and output pool exist, keep the direct film draw
          // path rather than inventing a second presentation scheduler.
          this.#renderFilm(null);
        }
      } else if (this.#doubleRate && this.#scheduling()) {
        const duration = this.#periodMs / 2;
        const queueResetted = this.#prepareQueue(2, now, duration);
        // One field interval of slack lets the first output survive when the
        // video callback runs just after the animation callback for the same
        // composite. Without it, both fields are due at the next animation
        // callback and the scheduler retires the first one before drawing it.
        const last = this.#queue.at(-1);
        const at = queueResetted
          ? now
          : last == null
            ? now + duration * 2
            : last.at + last.duration;
        this.#filter(false, at, duration);
        this.#filter(true, at + duration, duration);
      } else {
        // Direct video output supersedes any older film pictures that still
        // have future deadlines in the shared presentation queue.
        this.#stats.late += this.#queue.length;
        this.#queue.length = 0;
        this.#render(false, false, null);
      }
      this.#reportMaxQueuedFields = Math.max(
        this.#reportMaxQueuedFields,
        this.#queue.length,
      );
      this.#renderMsSinceReport += performance.now() - begin;
      this.#renderFramesSinceReport++;
      this.#report(at);
    }
    this.#request();
  };

  #selectVideoState(mediaTime: number): void {
    let selected: VideoState | undefined;
    for (let index = this.#videoTimeline.length - 1; index >= 0; index--) {
      const state = this.#videoTimeline[index]!;
      if (state.start <= mediaTime + 1e-6) {
        selected = state;
        break;
      }
    }
    // An init reaches the SourceBuffer before its first sample. Applying the
    // size here keeps the texture change on that sample's frame callback.
    if (
      selected?.codedSize &&
      (selected.codedSize.width !== this.#width ||
        selected.codedSize.height !== this.#height)
    )
      this.#resize(selected.codedSize.width, selected.codedSize.height);
    const scan = selected?.scan;
    if (
      !scan ||
      (this.#scan?.interlaced === scan.interlaced &&
        this.#scan.topFieldFirst === scan.topFieldFirst)
    )
      return;
    const previousInterlaced = this.#scan?.interlaced;
    this.#scan = scan;
    this.#frames = 0;
    this.#queue.length = 0;
    this.#resetFilm();
    // Progressive sections provide no cadence measurement, and a discontinuity
    // may change the input rate, so remeasure the next interlaced section
    if (previousInterlaced !== scan.interlaced) this.#periodMs = 0;
    if (scan.interlaced) {
      if (this.#doubleRate || this.#autoFilm) this.#startLoop();
    } else {
      this.#stopLoop();
    }
  }

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
      (this.#doubleRate || this.#autoFilm) &&
      this.#periodMs > 0 &&
      this.#outputs.length === OUTPUT_POOL_LENGTH
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

  /** Build the optional film passes only for callers that enable them. */
  #ensureFilmPrograms(): void {
    if (this.#filmAnalysis && this.#filmWeave && this.#filmSample) return;
    const gl = this.#gl;
    const filmAnalysis = createProgram(gl, FILM_ANALYSIS_FRAGMENT_SHADER);
    const filmWeave = createProgram(gl, FILM_WEAVE_FRAGMENT_SHADER);
    const filmSample = createProgram(gl, FILM_SAMPLE_FRAGMENT_SHADER);
    this.#filmAnalysis = filmAnalysis;
    this.#filmAnalysisLocation = Object.fromEntries(
      Object.entries(FILM_UNIFORMS)
        .filter(([key]) => key !== "match" && key !== "topFieldFirst")
        .map(([key, name]) => [key, gl.getUniformLocation(filmAnalysis, name)]),
    ) as Record<
      Exclude<keyof typeof FILM_UNIFORMS, "match" | "topFieldFirst">,
      WebGLUniformLocation | null
    >;
    this.#filmWeave = filmWeave;
    this.#filmWeaveLocation = Object.fromEntries(
      Object.entries(FILM_UNIFORMS).map(([key, name]) => [
        key,
        gl.getUniformLocation(filmWeave, name),
      ]),
    ) as Record<keyof typeof FILM_UNIFORMS, WebGLUniformLocation | null>;
    this.#filmSample = filmSample;
    this.#filmSampleLocation = Object.fromEntries(
      Object.entries(FILM_UNIFORMS).map(([key, name]) => [
        key,
        gl.getUniformLocation(filmSample, name),
      ]),
    ) as Record<keyof typeof FILM_UNIFORMS, WebGLUniformLocation | null>;
  }

  /**
   * Run FFmpeg's fieldmatch and live decimate decisions on reduced luma.
   * Full decoded frames remain in GPU textures, while the first readback packs
   * the previous, current and next luma proxies into RGB. A second readback
   * supplies the selected RGB weave to its chroma-sensitive decimate metric.
   */
  #analyseFilm(): boolean {
    const target = this.#analysisTarget;
    const analysis = this.#filmAnalysis;
    const analysisLocation = this.#filmAnalysisLocation;
    const sampleProgram = this.#filmSample;
    const sampleLocation = this.#filmSampleLocation;
    if (
      !target ||
      !analysis ||
      !analysisLocation ||
      !sampleProgram ||
      !sampleLocation
    )
      return false;
    const gl = this.#gl;
    const newest = this.#head;
    const cur = (this.#head + HISTORY - 1) % HISTORY;
    const prev = (this.#head + 1) % HISTORY;
    const isTopFieldFirst = this.#topFieldFirst;

    // One GPU draw and readback supplies the three luma frames without moving
    // full-resolution RGBA pictures through JavaScript.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.useProgram(analysis);
    for (const [unit, texture] of [prev, cur, newest].entries()) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.#textures[texture] ?? null);
    }
    gl.uniform1i(analysisLocation.prev, 0);
    gl.uniform1i(analysisLocation.cur, 1);
    gl.uniform1i(analysisLocation.next, 2);
    gl.uniform2i(analysisLocation.size, this.#width, this.#height);
    gl.viewport(0, 0, FILM_ANALYSIS_WIDTH, FILM_ANALYSIS_HEIGHT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(
      0,
      0,
      FILM_ANALYSIS_WIDTH,
      FILM_ANALYSIS_HEIGHT,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      target.pixels,
    );
    const { previousLuma, currentLuma, nextLuma } = target;
    for (let pixel = 0; pixel < previousLuma.length; pixel++) {
      const offset = pixel * 4;
      previousLuma[pixel] = target.pixels[offset] ?? 0;
      currentLuma[pixel] = target.pixels[offset + 1] ?? 0;
      nextLuma[pixel] = target.pixels[offset + 2] ?? 0;
    }
    const fieldMatch = this.#ivtc.fieldMatch(
      previousLuma,
      currentLuma,
      nextLuma,
      isTopFieldFirst,
      this.#filmCombThreshold,
    );

    // Decimate returns the selected RGB weave to YUV 4:2:0 sample density, so
    // brightness noise and colour-only changes share FFmpeg's metric scale.
    gl.useProgram(sampleProgram);
    gl.uniform1i(sampleLocation.prev, 0);
    gl.uniform1i(sampleLocation.cur, 1);
    gl.uniform1i(sampleLocation.next, 2);
    gl.uniform2i(sampleLocation.size, this.#width, this.#height);
    gl.uniform1i(sampleLocation.topFieldFirst, isTopFieldFirst ? 1 : 0);
    gl.uniform1i(
      sampleLocation.match,
      fieldMatch.match === "p" ? 0 : fieldMatch.match === "c" ? 1 : 2,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(
      0,
      0,
      FILM_ANALYSIS_WIDTH,
      FILM_ANALYSIS_HEIGHT,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      target.pixels,
    );
    const decimate = this.#ivtc.decimate(target.pixels);
    this.#match = fieldMatch.match;
    this.#combScore = fieldMatch.combScore;
    this.#isCombed = fieldMatch.isCombed;
    this.#duplicateScore = decimate.lowestCycleDifference;
    this.#duplicateRunnerUp = decimate.runnerUpCycleDifference;

    // Only a clean match inside a decimated cycle enters film mode. Every
    // non-decimated cycle retains the original YADIF path.
    const isFilmCycle = decimate.dropIndex !== null && !fieldMatch.isCombed;
    if ((isFilmCycle ? "film" : "video") !== this.#mode) {
      // Queued deadlines belong to their originating cadence, so anchor the
      // first picture of the new cadence to this frame callback
      this.#mode = isFilmCycle ? "film" : "video";
    }
    return decimate.shouldDrop && !fieldMatch.isCombed;
  }

  /** Weave the selected film fields into an output texture and queue it. */
  #filterFilm(at: number, duration: number): void {
    const slot = this.#nextOutputSlot();
    if (slot === null) return;
    const output = this.#outputs[slot];
    if (!output) return;
    this.#outputHead = slot;
    // Reusing a framebuffer retires the picture whose pixels it replaces.
    while (this.#queue.length > 0 && this.#queue[0]?.slot === slot) {
      this.#queue.shift();
      this.#stats.late++;
    }
    this.#renderFilm(output.framebuffer);
    this.#queue.push({ slot, at, duration });
  }

  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #renderFilm(target: WebGLFramebuffer | null, countOutput = true): void {
    const program = this.#filmWeave;
    const location = this.#filmWeaveLocation;
    if (!program || !location) return;
    const gl = this.#gl;
    const newest = this.#head;
    const cur = (this.#head + HISTORY - 1) % HISTORY;
    const prev = (this.#head + 1) % HISTORY;
    const isTopFieldFirst = this.#topFieldFirst;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.useProgram(program);
    for (const [unit, texture] of [prev, cur, newest].entries()) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.#textures[texture] ?? null);
    }
    gl.uniform1i(location.prev, 0);
    gl.uniform1i(location.cur, 1);
    gl.uniform1i(location.next, 2);
    gl.uniform2i(location.size, this.#width, this.#height);
    gl.uniform1i(location.topFieldFirst, isTopFieldFirst ? 1 : 0);
    gl.uniform1i(
      location.match,
      this.#match === "p" ? 0 : this.#match === "c" ? 1 : 2,
    );
    gl.viewport(0, 0, this.#width, this.#height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (target === null) {
      this.#presentedPicture = { kind: "film" };
      this.canvas.style.visibility = "visible";
      if (countOutput) this.#outputSinceReport++;
    }
  }

  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #filter(second: boolean, at: number, duration: number): void {
    const slot = this.#nextOutputSlot();
    if (slot === null) return;
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
    this.#queue.push({ slot, at, duration });
  }

  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #prepareQueue(
    requiredOutputs: number,
    now: number,
    outputDuration: number,
  ): boolean {
    const last = this.#queue.at(-1);
    const maximumUsefulLead =
      (FIELD_QUEUE_LENGTH + 1) * Math.max(this.#refreshMs, outputDuration);
    if (last && last.at - now > maximumUsefulLead) {
      this.#queue.length = 0;
      this.#stats.queueResetted++;
      return true;
    }

    const overflow = Math.max(
      0,
      this.#queue.length + requiredOutputs - FIELD_QUEUE_LENGTH,
    );
    let retiredDuration = 0;
    let retired = 0;
    while (retired < overflow) {
      const ready = this.#queue.shift();
      if (!ready) break;
      retiredDuration += ready.duration;
      retired++;
    }
    // The retired pictures no longer occupy presentation moments. Close those
    // holes as well as freeing their slots, so the remaining queue stays on the
    // current presentation opportunity under sustained capacity pressure.
    for (const ready of this.#queue) ready.at -= retiredDuration;
    this.#stats.late += retired;
    return false;
  }

  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #nextOutputSlot(): number | null {
    const shownTexture =
      this.#presentedPicture?.kind === "texture"
        ? this.#presentedPicture.texture
        : null;
    const queuedSlots = new Set(this.#queue.map(({ slot }) => slot));
    for (let offset = 1; offset <= OUTPUT_POOL_LENGTH; offset++) {
      const slot = (this.#outputHead + offset) % OUTPUT_POOL_LENGTH;
      const output = this.#outputs[slot];
      if (output && output.texture !== shownTexture && !queuedSlots.has(slot))
        return slot;
    }

    // The pool is saturated: keep the picture represented by the canvas for
    // capture, but retire the oldest queued picture for this newer field. The
    // caller's existing overflow handling accounts for that picture as late.
    const oldest = this.#queue[0];
    if (oldest) {
      const output = this.#outputs[oldest.slot];
      if (output && output.texture !== shownTexture) return oldest.slot;
    }
    return null;
  }

  /** The loop that puts filtered fields up, and the only thing that draws. */
  #startLoop(): void {
    if (this.#loopHandle !== null) return;
    if (!this.#running || this.#lost || (!this.#doubleRate && !this.#autoFilm))
      return;
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
    if (!this.#running || this.#lost || (!this.#doubleRate && !this.#autoFilm))
      return;
    // Short ordinary gaps identify the refresh interval, while a long task
    // only moves the estimate gradually until regular animation resumes.
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
    // A draw requested now reaches the upcoming composite, so select the
    // newest picture whose deadline belongs to that presentation opportunity.
    const deadline = now + this.#refreshMs * 1.5;
    while (this.#queue[1] && this.#queue[1].at <= deadline) {
      this.#stats.late++;
      this.#queue.shift();
    }
    let ready = this.#queue[0];
    if (!ready) {
      return;
    }
    if (ready.at > deadline) {
      return;
    }
    this.#queue.shift();
    const begin = performance.now();
    this.#show(ready.slot);
    this.#showMsSinceReport += performance.now() - begin;
    this.#showFramesSinceReport++;
  }

  /** Copy one of the filtered pictures onto the canvas. */
  #show(slot: number): void {
    const output = this.#outputs[slot];
    if (!output) return;
    this.#showTexture(output.texture);
  }

  /** Put a progressive frame through unchanged, keeping one display surface. */
  #showVideo(): void {
    this.#push();
    const texture = this.#textures[this.#head];
    if (texture) this.#showTexture(texture, true);
    // Progressive frames are not neighbours of the next interlaced frame.
    this.#frames = 0;
  }

  #showTexture(texture: WebGLTexture, flip = false, countOutput = true): void {
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.#blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.#blitField, 0);
    gl.uniform1i(this.#blitFlip, flip ? 1 : 0);
    gl.viewport(0, 0, this.#width, this.#height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.#presentedPicture = { kind: "texture", texture, flip };
    this.canvas.style.visibility = "visible";
    if (countOutput) this.#outputSinceReport++;
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
    const elapsed = at - this.#reportedAt;
    if (elapsed < STATS_INTERVAL_MS) return;
    const frames =
      this.#scheduling() && (this.#doubleRate || this.#mode === "film")
        ? this.#showFramesSinceReport
        : this.#renderFramesSinceReport;
    const stats: DeinterlaceStats = {
      ...this.#stats,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#video.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: (frames * 1000) / elapsed,
      frameMs:
        this.#renderFramesSinceReport === 0
          ? 0
          : (this.#renderMsSinceReport + this.#showMsSinceReport) /
            this.#renderFramesSinceReport,
      maxQueuedFields: this.#reportMaxQueuedFields,
      mode: this.#mode,
      match: this.#match,
      combScore: this.#combScore,
      outputFps: (this.#outputSinceReport * 1000) / elapsed,
      duplicateScore: this.#duplicateScore,
      duplicateRunnerUp: this.#duplicateRunnerUp,
    };
    // A single snapshot is the canonical value for both public observation
    // paths: DPlayer listens to the event, while standalone callers can use
    // the callback supplied at construction time.
    this.dispatchEvent(new CustomEvent("stats", { detail: stats }));
    this.#onStats?.(stats);
    this.#reportedAt = at;
    this.#renderFramesSinceReport = 0;
    this.#renderMsSinceReport = 0;
    this.#showFramesSinceReport = 0;
    this.#showMsSinceReport = 0;
    this.#reportMaxQueuedFields = 0;
    this.#outputSinceReport = 0;
  }

  /** Take the newest frame into the ring. */
  #push(): void {
    const gl = this.#gl;
    this.#head = (this.#head + 1) % HISTORY;
    gl.bindTexture(gl.TEXTURE_2D, this.#textures[this.#head] ?? null);
    // texSubImage2D is very slow in WebKit (~7 ms), so use texImage2D instead (~1 ms).
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
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
    countOutput = true,
  ): void {
    if (this.#frames === 0 || this.#lost) return;
    if (countOutput) {
      if (this.#frames === HISTORY && !flush) this.#stats.filtered++;
      else this.#stats.degraded++;
    }
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
    if (target === null) {
      this.#presentedPicture = { kind: "yadif", flush, second };
      this.canvas.style.visibility = "visible";
      if (countOutput) this.#outputSinceReport++;
    }
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
    this.#presentedPicture = null;
    this.#resetFilm();
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
    this.#freeAnalysisTarget();
    if (this.#autoFilm) this.#allocateAnalysisTarget();
    if (this.#doubleRate || this.#autoFilm) this.#allocateOutputs();
  }

  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #allocateAnalysisTarget(): void {
    if (this.#analysisTarget) return;
    const gl = this.#gl;
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
      FILM_ANALYSIS_WIDTH,
      FILM_ANALYSIS_HEIGHT,
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
      return;
    }
    this.#analysisTarget = {
      texture,
      framebuffer,
      pixels: new Uint8Array(FILM_ANALYSIS_WIDTH * FILM_ANALYSIS_HEIGHT * 4),
      previousLuma: new Uint8Array(FILM_ANALYSIS_WIDTH * FILM_ANALYSIS_HEIGHT),
      currentLuma: new Uint8Array(FILM_ANALYSIS_WIDTH * FILM_ANALYSIS_HEIGHT),
      nextLuma: new Uint8Array(FILM_ANALYSIS_WIDTH * FILM_ANALYSIS_HEIGHT),
    };
  }

  #freeAnalysisTarget(): void {
    if (!this.#analysisTarget) return;
    this.#gl.deleteFramebuffer(this.#analysisTarget.framebuffer);
    this.#gl.deleteTexture(this.#analysisTarget.texture);
    this.#analysisTarget = null;
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
    if (this.#outputs.length === OUTPUT_POOL_LENGTH || this.#width === 0)
      return;
    this.#freeOutputs();
    for (let index = 0; index < OUTPUT_POOL_LENGTH; index++) {
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
    this.#outputHead = OUTPUT_POOL_LENGTH - 1;
  }

  #freeOutputs(): void {
    const gl = this.#gl;
    const shownTexture =
      this.#presentedPicture?.kind === "texture"
        ? this.#presentedPicture.texture
        : null;
    // Direct draws and history textures remain reproducible when this pool is
    // released. Do not leave a snapshot pointing at a deleted output texture.
    if (this.#outputs.some((output) => output.texture === shownTexture))
      this.#presentedPicture = null;
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
    this.#periodMs = 0;
    // The counts belong to the stream that has just gone; the next one starts
    // its own. The element resets its own dropped count for the same reason.
    this.#resetStats();
    this.#resetFilm();
    this.#presentedPicture = null;
    this.canvas.style.visibility = "hidden";
  };

  #resetStats(): void {
    this.#stats = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0,
    };
    this.#lastPresented = 0;
    this.#reportedAt = 0;
    this.#lastFrameAt = 0;
    this.#renderFramesSinceReport = 0;
    this.#renderMsSinceReport = 0;
    this.#showFramesSinceReport = 0;
    this.#showMsSinceReport = 0;
    this.#reportMaxQueuedFields = 0;
    this.#outputSinceReport = 0;
    this.#resetFilm();
  }

  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #resetFilm(): void {
    this.#queue.length = 0;
    this.#mode = "video";
    this.#match = "c";
    this.#combScore = 0;
    this.#isCombed = true;
    this.#ivtc.reset();
    this.#duplicateScore = Infinity;
    this.#duplicateRunnerUp = Infinity;
  }

  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #onSeeking = (): void => {
    this.#seekFrameReady = false;
  };

  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #onFlush = (event: Event): void => {
    if (event.type === "seeked") {
      // A destination frame may have reached requestVideoFrameCallback while
      // the element still reported `seeking`. #onFrame has already discarded
      // the old history and drawn that frame, so clearing it here would turn a
      // completed seek back into a blank canvas until another frame arrives.
      const seekFrameReady = this.#seekFrameReady;
      this.#seekFrameReady = false;
      if (seekFrameReady) return;
      // A seek completes with the video on its destination frame. History still
      // belongs to the former position, so expose the video until the callback
      // refills every texture from the new timeline.
      this.#frames = 0;
      this.#resetFilm();
      this.#presentedPicture = null;
      this.canvas.style.visibility = "hidden";
      return;
    }
    if (event.type === "ratechange") {
      // The measured wall-time period includes playback rate, so the next
      // callback establishes a fresh cadence from the new rate.
      this.#periodMs = 0;
      this.#lastMediaTime = this.#video.currentTime;
    }
    // The fields still queued stand for moments after this one and nothing is
    // coming to make sense of them, so the picture goes straight to the canvas
    // rather than through a schedule that has nothing left to keep to.
    this.#queue.length = 0;
    if (!this.#running || this.#frames === 0) return;
    const slot = this.#nextOutputSlot();
    const output = slot === null ? undefined : this.#outputs[slot];
    if (slot !== null && output) {
      // Keep the flushed picture in its own texture so capture can reproduce
      // it even though the next video frame will upload into history.
      this.#outputHead = slot;
      this.#render(true, false, output.framebuffer);
      this.#show(slot);
    } else {
      this.#render(true, false, null);
    }
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
