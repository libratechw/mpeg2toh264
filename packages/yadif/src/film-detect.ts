/**
 * The GPU side of 2:3 pulldown detection: the passes that measure two frames
 * against each other, the texture the measurements live in, and the readback
 * that tells the page what was decided. See film-shader.ts for the shaders
 * and what the measurements mean.
 */
import {
  FIELD_COMPARE_BLOCK_H,
  FIELD_COMPARE_BLOCK_W,
  FIELD_COMPARE_FRAGMENT_SHADER,
  FIELD_COMPARE_UNIFORMS,
  FIELD_METRICS,
  FIELD_METRICS_SIZE,
  METRICS_FRAGMENT_SHADER,
  METRICS_UNIFORMS,
  REDUCTION_FACTOR,
  REDUCTION_FRAGMENT_SHADER,
  REDUCTION_UNIFORMS,
} from "./film-shader.js";
import { createProgram, VERTEX_SHADER } from "./utils.js";

/** What the pulldown detection said about a frame. */
export interface Phase {
  /** Which frame of the cycle it is, 1 to 5, or 0 for none. */
  phase: number;
  /** How many frames in a row have had a phase. See film-shader.ts. */
  run: number;
}

export const NO_PHASE: Phase = { phase: 0, run: 0 };

/** RGBA32F textures of one size, drawn together as one framebuffer. */
interface RenderTarget {
  framebuffer: WebGLFramebuffer;
  textures: WebGLTexture[];
  width: number;
  height: number;
}

type Locations<T extends Record<string, string>> = Record<
  keyof T,
  WebGLUniformLocation | null
>;

function locate<T extends Record<string, string>>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  uniforms: T,
): Locations<T> {
  return Object.fromEntries(
    Object.entries(uniforms).map(([key, name]) => [
      key,
      gl.getUniformLocation(program, name),
    ]),
  ) as Locations<T>;
}

/**
 * Detects the pulldown phase of frames on the GPU.
 *
 * `detect` measures the frame being filtered against the one after it, moves
 * the earlier measurements along, decides the phase, and starts reading the
 * result back; `poll` collects it once it has arrived, a frame or so later.
 * `texture` is the newest measurements, for the filter to read the phase
 * from without waiting for the page.
 *
 * The measurements of one frame are written from those of the frame before
 * in a single pass, so they live in two textures taken in turns; nothing is
 * copied between passes, and the frame costs three draws and a readback.
 */
export class FilmDetector {
  readonly #gl: WebGL2RenderingContext;
  readonly #compareProgram: WebGLProgram;
  readonly #compareLocation: Locations<typeof FIELD_COMPARE_UNIFORMS>;
  readonly #reductionProgram: WebGLProgram;
  readonly #reductionLocation: Locations<typeof REDUCTION_UNIFORMS>;
  readonly #metricsProgram: WebGLProgram;
  readonly #metricsLocation: Locations<typeof METRICS_UNIFORMS>;
  /** The block comparisons of both fields, and the same folded most of the way. */
  #blocks: RenderTarget | null = null;
  #reduced: RenderTarget | null = null;
  /** The field metrics (see FIELD_METRICS) of this frame and the one before. */
  #metrics: [RenderTarget, RenderTarget] | null = null;
  /** Which of the two holds the newest metrics. */
  #head = 0;
  /** The metrics being read back asynchronously. */
  #pixelBuffer: WebGLBuffer | null = null;
  #fence: WebGLSync | null = null;
  /** The last metrics read back, laid out as FIELD_METRICS says. */
  readonly metrics = new Float32Array(FIELD_METRICS_SIZE * 4);
  #width = 0;
  #height = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
    this.#compareProgram = createProgram(
      gl,
      FIELD_COMPARE_FRAGMENT_SHADER,
      VERTEX_SHADER,
    );
    this.#compareLocation = locate(
      gl,
      this.#compareProgram,
      FIELD_COMPARE_UNIFORMS,
    );
    this.#reductionProgram = createProgram(
      gl,
      REDUCTION_FRAGMENT_SHADER,
      VERTEX_SHADER,
    );
    this.#reductionLocation = locate(
      gl,
      this.#reductionProgram,
      REDUCTION_UNIFORMS,
    );
    this.#metricsProgram = createProgram(
      gl,
      METRICS_FRAGMENT_SHADER,
      VERTEX_SHADER,
    );
    this.#metricsLocation = locate(gl, this.#metricsProgram, METRICS_UNIFORMS);
  }

  /** The newest measurements, or null before any frame has been measured. */
  get texture(): WebGLTexture | null {
    return this.#metrics?.[this.#head]?.textures[0] ?? null;
  }

  /** The size of the frames to be measured, which sizes the block grid. */
  resize(width: number, height: number): void {
    if (width === this.#width && height === this.#height) return;
    this.#width = width;
    this.#height = height;
    this.#freeBlocks();
  }

  /** Forget every measurement: the next frame starts a cycle from nothing. */
  reset(): void {
    const gl = this.#gl;
    gl.deleteSync(this.#fence);
    this.#fence = null;
    const newest = this.#metrics?.[this.#head];
    if (!newest) return;
    const metrics = new Float32Array(FIELD_METRICS_SIZE * 4);
    for (let index = 0; index < FIELD_METRICS.phase; index++)
      metrics[index * 4 + 1] = 1;
    gl.bindTexture(gl.TEXTURE_2D, newest.textures[0] ?? null);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      FIELD_METRICS_SIZE,
      1,
      gl.RGBA,
      gl.FLOAT,
      metrics,
    );
  }

  /**
   * Detect the pulldown phase of `cur`, the frame being filtered, against
   * `next`, and start reading it back. Only the two comparisons against the
   * next frame are measured; the rest are earlier ones moved along a frame.
   * `first` is the parity of the field that was captured first.
   */
  detect(cur: WebGLTexture, next: WebGLTexture, first: number): void {
    const gl = this.#gl;
    if (this.#width === 0 || this.#height === 0) return;
    this.#allocate();
    const blocks = this.#blocks;
    const reduced = this.#reduced;
    const metrics = this.#metrics;
    if (blocks === null || reduced === null || metrics === null) return;
    const previous = metrics[this.#head]!;
    const current = metrics[1 - this.#head]!;

    // Both fields of the two frames, block by block.
    gl.bindFramebuffer(gl.FRAMEBUFFER, blocks.framebuffer);
    gl.useProgram(this.#compareProgram);
    this.#bind(0, cur, this.#compareLocation.a);
    this.#bind(1, next, this.#compareLocation.b);
    this.#bind(2, previous.textures[0], this.#compareLocation.fieldMetrics);
    gl.uniform1i(this.#compareLocation.first, first);
    gl.uniform2i(this.#compareLocation.size, this.#width, this.#height);
    gl.viewport(0, 0, blocks.width, blocks.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // The blocks folded most of the way down.
    gl.bindFramebuffer(gl.FRAMEBUFFER, reduced.framebuffer);
    gl.useProgram(this.#reductionProgram);
    this.#bind(0, blocks.textures[0], this.#reductionLocation.second);
    this.#bind(1, blocks.textures[1], this.#reductionLocation.first);
    gl.uniform2i(this.#reductionLocation.size, blocks.width, blocks.height);
    gl.viewport(0, 0, reduced.width, reduced.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // The rest of the way, the earlier comparisons moved along, and the phase.
    gl.bindFramebuffer(gl.FRAMEBUFFER, current.framebuffer);
    gl.useProgram(this.#metricsProgram);
    this.#bind(0, previous.textures[0], this.#metricsLocation.previous);
    this.#bind(1, reduced.textures[0], this.#metricsLocation.second);
    this.#bind(2, reduced.textures[1], this.#metricsLocation.first);
    gl.uniform2i(this.#metricsLocation.size, reduced.width, reduced.height);
    gl.viewport(0, 0, FIELD_METRICS_SIZE, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.#head = 1 - this.#head;

    gl.deleteSync(this.#fence);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pixelBuffer);
    gl.readPixels(0, 0, FIELD_METRICS_SIZE, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  /**
   * The phase of the last frame measured, once the GPU has handed it back,
   * and null while it is still on its way. It is handed back once.
   */
  poll(): Phase | null {
    const gl = this.#gl;
    const fence = this.#fence;
    if (fence === null || this.#pixelBuffer === null) return null;
    switch (gl.clientWaitSync(fence, 0, 0)) {
      case gl.ALREADY_SIGNALED:
      case gl.CONDITION_SATISFIED:
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pixelBuffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.metrics);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(fence);
        this.#fence = null;
        return {
          phase: this.metrics[FIELD_METRICS.phase * 4] ?? 0,
          run: this.metrics[FIELD_METRICS.phase * 4 + 1] ?? 0,
        };
      default:
        return null;
    }
  }

  destroy(): void {
    const gl = this.#gl;
    this.#freeBlocks();
    if (this.#metrics !== null) {
      for (const target of this.#metrics) freeRenderTarget(gl, target);
      this.#metrics = null;
    }
    gl.deleteSync(this.#fence);
    this.#fence = null;
    gl.deleteBuffer(this.#pixelBuffer);
    this.#pixelBuffer = null;
    gl.deleteProgram(this.#compareProgram);
    gl.deleteProgram(this.#reductionProgram);
    gl.deleteProgram(this.#metricsProgram);
  }

  #bind(
    unit: number,
    texture: WebGLTexture | undefined,
    location: WebGLUniformLocation | null,
  ): void {
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture ?? null);
    gl.uniform1i(location, unit);
  }

  #freeBlocks(): void {
    const gl = this.#gl;
    if (this.#blocks !== null) freeRenderTarget(gl, this.#blocks);
    if (this.#reduced !== null) freeRenderTarget(gl, this.#reduced);
    this.#blocks = null;
    this.#reduced = null;
  }

  /** Everything detect needs that is not there yet. */
  #allocate(): void {
    const gl = this.#gl;
    if (this.#blocks === null || this.#reduced === null) {
      this.#freeBlocks();
      const width = Math.ceil(this.#width / FIELD_COMPARE_BLOCK_W);
      const height = Math.ceil(this.#height / (FIELD_COMPARE_BLOCK_H * 2));
      this.#blocks = allocateRenderTarget(gl, width, height, 2);
      this.#reduced = allocateRenderTarget(
        gl,
        Math.ceil(width / REDUCTION_FACTOR),
        Math.ceil(height / REDUCTION_FACTOR),
        2,
      );
    }
    if (this.#metrics === null) {
      this.#metrics = [
        allocateRenderTarget(gl, FIELD_METRICS_SIZE, 1, 1),
        allocateRenderTarget(gl, FIELD_METRICS_SIZE, 1, 1),
      ];
      this.#head = 0;
      this.reset();
    }
    if (this.#pixelBuffer === null) {
      this.#pixelBuffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pixelBuffer);
      gl.bufferData(
        gl.PIXEL_PACK_BUFFER,
        this.metrics.byteLength,
        gl.STREAM_READ,
      );
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
  }
}

function allocateRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  count: number,
): RenderTarget {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  const textures: WebGLTexture[] = [];
  for (let index = 0; index < count; index++) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      width,
      height,
      0,
      gl.RGBA,
      gl.FLOAT,
      null,
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0 + index,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    textures.push(texture);
  }
  gl.drawBuffers(textures.map((_, index) => gl.COLOR_ATTACHMENT0 + index));
  const complete =
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const target = { framebuffer, textures, width, height };
  if (!complete) {
    freeRenderTarget(gl, target);
    throw new Error("failed to allocate framebuffer");
  }
  return target;
}

function freeRenderTarget(
  gl: WebGL2RenderingContext,
  { framebuffer, textures }: RenderTarget,
): void {
  gl.deleteFramebuffer(framebuffer);
  for (const texture of textures) gl.deleteTexture(texture);
}
