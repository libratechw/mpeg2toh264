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
 * The filter is yadif, which lives in yadif/shader.ts because it is derived
 * from FFmpeg and is licensed differently to the rest of this. Everything here
 * is the machinery around it: three frames' worth of textures, a program, and
 * `requestVideoFrameCallback` to say when a frame is worth uploading.
 *
 * Frames are filtered one behind the element. yadif wants the frame either
 * side of the one it is working on, and the only way to hold the next one is
 * to wait for it, so the canvas is one frame -- around 33 ms -- behind the
 * audio. That is well inside what a viewer can tell, and the alternative is a
 * filter with half its motion measurements missing.
 */
import { YADIF_FRAGMENT_SHADER, YADIF_UNIFORMS } from "./yadif/shader.js";

/** How far the presentation time may jump before the held frames are stale. */
const CONTINUOUS_SECONDS = 0.5;

/** prev, cur and next: everything the filter reads. */
const HISTORY = 3;

const VERTEX_SHADER = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

export interface DeinterlacerOptions {
  /**
   * Whether the top field of a frame is the one captured first. True for every
   * MPEG-2 broadcast format worth the name, which is why it is the default;
   * getting it wrong makes motion jerk back and forth by a field.
   */
  topFieldFirst?: boolean;
  /**
   * Whether to let the local vertical range widen what the temporal check
   * allows. This is yadif's default and its `nospatial` mode turns it off.
   */
  spatialCheck?: boolean;
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
  #textures: WebGLTexture[] = [];
  /** The `<div>` this put around the element, so it can be taken away again. */
  #wrapper: HTMLElement | null = null;
  readonly #resizes: ResizeObserver;
  #topFieldFirst: boolean;
  #spatialCheck: boolean;
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
  #lost = false;

  constructor(video: HTMLVideoElement, options: DeinterlacerOptions = {}) {
    this.#video = video;
    this.#topFieldFirst = options.topFieldFirst ?? true;
    this.#spatialCheck = options.spatialCheck ?? true;
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
    this.#program = createProgram(gl);
    const program = this.#program;
    this.#location = Object.fromEntries(
      Object.entries(YADIF_UNIFORMS).map(([key, name]) => [
        key,
        gl.getUniformLocation(program, name),
      ]),
    ) as Record<keyof typeof YADIF_UNIFORMS, WebGLUniformLocation | null>;
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

  /** Whether the top field of a frame is the one captured first. */
  get topFieldFirst(): boolean {
    return this.#topFieldFirst;
  }

  set topFieldFirst(topFieldFirst: boolean) {
    this.#topFieldFirst = topFieldFirst;
  }

  start(): void {
    if (this.#running || this.#lost) return;
    this.#running = true;
    this.#mount();
    this.#request();
  }

  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#handle !== null)
      this.#video.cancelVideoFrameCallback(this.#handle);
    this.#handle = null;
    this.#frames = 0;
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
    this.#gl.deleteProgram(this.#program);
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
    // The size of the frame as it is coded, which is what the upload carries
    // and what the filter has to work in. It is not `videoWidth`: that is the
    // size the frame is meant to be seen at, which for anamorphic video --
    // 1440x1080 broadcast at 16:9, say -- is wider than the frame really is.
    // Sizing the texture by it would leave a quarter of every row unwritten.
    const width = metadata.width;
    const height = metadata.height;
    if (width > 0 && height > 0) {
      if (width !== this.#width || height !== this.#height)
        this.#resize(width, height);
      // A seek, or a stream that starts again somewhere else, leaves the held
      // frames belonging to a different moment. Timing says so before any
      // event does, and playback that merely dropped a frame is left alone:
      // the neighbours are then further apart than they should be, which is
      // worth less than filtering nothing at all.
      const elapsed = metadata.mediaTime - this.#lastMediaTime;
      if (elapsed < 0 || elapsed > CONTINUOUS_SECONDS) this.#frames = 0;
      this.#lastMediaTime = metadata.mediaTime;
      this.#push();
      this.#render(false);
    }
    this.#request();
  };

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
   * Filter one frame onto the canvas.
   *
   * Which of the held frames is the one being filtered depends on how many
   * there are. In flight it is the middle one, with the newest waiting its
   * turn; where there is nothing on one side -- the start of a stream, or a
   * `flush` because the last frame has been presented and no more are coming
   * -- that side is the frame itself, which is what the reference filter does
   * at the ends of its input.
   */
  #render(flush: boolean): void {
    if (this.#frames === 0 || this.#lost) return;
    const gl = this.#gl;
    const newest = this.#head;
    const older = (this.#head + HISTORY - 1) % HISTORY;
    const oldest = (this.#head + 1) % HISTORY;
    let prev: number;
    let cur: number;
    let next: number;
    if (this.#frames === 1) {
      // One frame and nothing to compare it to. See `uTemporal`.
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

    gl.useProgram(this.#program);
    for (const [unit, texture] of [prev, cur, next].entries()) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.#textures[texture] ?? null);
    }
    gl.uniform1i(this.#location.prev, 0);
    gl.uniform1i(this.#location.cur, 1);
    gl.uniform1i(this.#location.next, 2);
    gl.uniform2i(this.#location.size, this.#width, this.#height);
    // One output frame per input frame keeps the field that came first, so the
    // lines that survive are the top ones when the top field leads.
    gl.uniform1i(this.#location.parity, this.#topFieldFirst ? 0 : 1);
    gl.uniform1i(this.#location.tff, this.#topFieldFirst ? 1 : 0);
    gl.uniform1i(this.#location.spatialCheck, this.#spatialCheck ? 1 : 0);
    gl.uniform1i(this.#location.temporal, this.#frames > 1 ? 1 : 0);
    gl.viewport(0, 0, this.#width, this.#height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.canvas.style.visibility = "visible";
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
    this.canvas.style.visibility = "hidden";
  };

  #onFlush = (): void => {
    if (this.#running) this.#render(true);
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

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, YADIF_FRAGMENT_SHADER);
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
