/**
 * The GPU side of 2:3 pulldown detection: the passes that measure two frames
 * against each other, the texture the measurements live in, and the readback
 * that tells the page what was decided. See film-shader.ts for the shaders
 * and what the measurements mean.
 */
import {
  DETECT_FRAGMENT_SHADER,
  DETECT_UNIFORMS,
  FIELD_COMPARE_BLOCK_H,
  FIELD_COMPARE_BLOCK_W,
  FIELD_COMPARE_FRAGMENT_SHADER,
  FIELD_COMPARE_UNIFORMS,
  FIELD_METRICS,
  FIELD_METRICS_SIZE,
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

type RenderTarget = {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
};

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
 */
export class FilmDetector {
  readonly #gl: WebGL2RenderingContext;
  readonly #fieldCompareProgram: WebGLProgram;
  readonly #fieldCompareLocation: Locations<typeof FIELD_COMPARE_UNIFORMS>;
  readonly #reductionProgram: WebGLProgram;
  readonly #reductionLocation: Locations<typeof REDUCTION_UNIFORMS>;
  readonly #detectProgram: WebGLProgram;
  readonly #detectLocation: Locations<typeof DETECT_UNIFORMS>;
  #reductionTargets: [RenderTarget, RenderTarget] | null = null;
  #detectResult: RenderTarget | null = null;
  /** The field metrics (see FIELD_METRICS) and a copy from the frame before. */
  #fieldMetrics: [RenderTarget, RenderTarget] | null = null;
  /** The metrics being read back asynchronously. */
  #pixelBuffer: WebGLBuffer | null = null;
  #fence: WebGLSync | null = null;
  /** The last metrics read back, laid out as FIELD_METRICS says. */
  readonly metrics = new Float32Array(FIELD_METRICS_SIZE * 4);
  #width = 0;
  #height = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
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
    this.#fieldCompareProgram = createProgram(
      gl,
      FIELD_COMPARE_FRAGMENT_SHADER,
      VERTEX_SHADER,
    );
    this.#fieldCompareLocation = locate(
      gl,
      this.#fieldCompareProgram,
      FIELD_COMPARE_UNIFORMS,
    );
    this.#detectProgram = createProgram(
      gl,
      DETECT_FRAGMENT_SHADER,
      VERTEX_SHADER,
    );
    this.#detectLocation = locate(gl, this.#detectProgram, DETECT_UNIFORMS);
  }

  /** The newest measurements, or null before any frame has been measured. */
  get texture(): WebGLTexture | null {
    return this.#fieldMetrics?.[0].texture ?? null;
  }

  /** The size of the frames to be measured, which sizes the block grid. */
  resize(width: number, height: number): void {
    if (width === this.#width && height === this.#height) return;
    this.#width = width;
    this.#height = height;
    this.#freeReductionTargets();
  }

  /** Forget every measurement: the next frame starts a cycle from nothing. */
  reset(): void {
    const gl = this.#gl;
    gl.deleteSync(this.#fence);
    this.#fence = null;
    if (this.#fieldMetrics === null) return;
    const metrics = new Float32Array(FIELD_METRICS_SIZE * 4);
    for (let index = 0; index < FIELD_METRICS.phase; index++)
      metrics[index * 4 + 1] = 1;
    gl.bindTexture(gl.TEXTURE_2D, this.#fieldMetrics[0].texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      FIELD_METRICS_SIZE,
      1,
      0,
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
    this.#allocateFieldMetrics();
    this.#allocateReductionTargets();
    const metrics = this.#fieldMetrics;
    const targets = this.#reductionTargets;
    if (metrics === null || targets === null) return;
    const [current, previous] = metrics;

    gl.bindFramebuffer(gl.FRAMEBUFFER, current.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, previous.texture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, FIELD_METRICS.phase, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, current.texture);
    const carry: [from: number, to: number][] = [
      [
        FIELD_METRICS.secondRepeatsPrevious,
        FIELD_METRICS.previousSecondRepeated,
      ],
      [FIELD_METRICS.firstRepeatsPrevious, FIELD_METRICS.previousFirstRepeated],
      [FIELD_METRICS.secondRepeatsNext, FIELD_METRICS.secondRepeatsPrevious],
      [FIELD_METRICS.firstRepeatsNext, FIELD_METRICS.firstRepeatsPrevious],
    ];
    for (const [from, to] of carry)
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, to, 0, from, 0, 1, 1);

    this.#compareField(
      targets,
      cur,
      next,
      current.texture,
      FIELD_METRICS.secondRepeatsNext,
      1 - first,
    );
    this.#compareField(
      targets,
      cur,
      next,
      current.texture,
      FIELD_METRICS.firstRepeatsNext,
      first,
    );

    this.#detectResult ??= allocateRenderTarget(gl, 1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#detectResult.framebuffer);
    gl.useProgram(this.#detectProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, current.texture);
    gl.uniform1i(this.#detectLocation.fieldMetrics, 0);
    gl.viewport(0, 0, 1, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, current.texture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, FIELD_METRICS.phase, 0, 0, 0, 1, 1);

    this.#pixelBuffer ??= gl.createBuffer();
    gl.deleteSync(this.#fence);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.#pixelBuffer);
    gl.bufferData(
      gl.PIXEL_PACK_BUFFER,
      this.metrics.byteLength,
      gl.STREAM_READ,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, current.framebuffer);
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
    this.#freeReductionTargets();
    this.#freeFieldMetrics();
    gl.deleteSync(this.#fence);
    this.#fence = null;
    gl.deleteBuffer(this.#pixelBuffer);
    this.#pixelBuffer = null;
    if (this.#detectResult !== null) {
      freeRenderTarget(gl, this.#detectResult);
      this.#detectResult = null;
    }
    gl.deleteProgram(this.#reductionProgram);
    gl.deleteProgram(this.#fieldCompareProgram);
    gl.deleteProgram(this.#detectProgram);
  }

  #freeReductionTargets(): void {
    if (this.#reductionTargets === null) return;
    for (const target of this.#reductionTargets)
      freeRenderTarget(this.#gl, target);
    this.#reductionTargets = null;
  }

  #allocateReductionTargets(): void {
    if (this.#reductionTargets !== null) return;
    const width = Math.ceil(this.#width / FIELD_COMPARE_BLOCK_W);
    const height = Math.ceil(this.#height / FIELD_COMPARE_BLOCK_H);
    this.#reductionTargets = [
      allocateRenderTarget(this.#gl, width, height),
      allocateRenderTarget(this.#gl, width, height),
    ];
  }

  #freeFieldMetrics(): void {
    if (this.#fieldMetrics === null) return;
    for (const target of this.#fieldMetrics) freeRenderTarget(this.#gl, target);
    this.#fieldMetrics = null;
  }

  #allocateFieldMetrics(): void {
    if (this.#fieldMetrics !== null) return;
    this.#fieldMetrics = [
      allocateRenderTarget(this.#gl, FIELD_METRICS_SIZE, 1),
      allocateRenderTarget(this.#gl, FIELD_METRICS_SIZE, 1),
    ];
    this.reset();
  }

  /** Compare one field of two frames block by block, reduce to one texel, and store it in the metrics. */
  #compareField(
    reductionTargets: [RenderTarget, RenderTarget],
    frameA: WebGLTexture,
    frameB: WebGLTexture,
    metrics: WebGLTexture,
    metric: number,
    parity: number,
  ): void {
    const gl = this.#gl;
    let target: 0 | 1 = 0;
    let width = Math.ceil(this.#width / FIELD_COMPARE_BLOCK_W);
    let height = Math.ceil(this.#height / 2 / FIELD_COMPARE_BLOCK_H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, reductionTargets[target].framebuffer);
    gl.useProgram(this.#fieldCompareProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameA);
    gl.uniform1i(this.#fieldCompareLocation.a, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, frameB);
    gl.uniform1i(this.#fieldCompareLocation.b, 1);
    gl.uniform1i(this.#fieldCompareLocation.parity, parity);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, metrics);
    gl.uniform1i(this.#fieldCompareLocation.fieldMetrics, 2);
    gl.uniform2i(this.#fieldCompareLocation.size, this.#width, this.#height);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    while (width > 1 || height > 1) {
      const source = target;
      target = target === 0 ? 1 : 0;
      const reducedWidth = Math.ceil(width / REDUCTION_FACTOR);
      const reducedHeight = Math.ceil(height / REDUCTION_FACTOR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, reductionTargets[target].framebuffer);
      gl.useProgram(this.#reductionProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, reductionTargets[source].texture);
      gl.uniform1i(this.#reductionLocation.input, 0);
      gl.uniform2i(this.#reductionLocation.size, width, height);
      gl.viewport(0, 0, reducedWidth, reducedHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      width = reducedWidth;
      height = reducedHeight;
    }
    gl.bindTexture(gl.TEXTURE_2D, metrics);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, metric, 0, 0, 0, 1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}

function allocateRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): RenderTarget {
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
    throw new Error("failed to allocate framebuffer");
  }
  return { texture, framebuffer };
}

function freeRenderTarget(
  gl: WebGL2RenderingContext,
  { texture, framebuffer }: RenderTarget,
): void {
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(texture);
}
