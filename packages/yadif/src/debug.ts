import { createProgram } from "./utils.js";

const DEBUG_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
in vec2 vTextureCoord;
uniform vec3 uTextColor;
uniform vec3 uBackColor;
out vec4 fragColor;

void main() {
  float a = texture(uTexture, vTextureCoord)[3];
  fragColor = vec4(uTextColor * a + uBackColor * (1.0 - a), 1.0);
}
`;

const DEBUG_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec4 aVertexPosition;
in vec2 aTextureCoord;
uniform mat4 uMatrix;
uniform mat3 uUvMatrix;
out vec2 vTextureCoord;
out vec3 vTextColor;

void main() {
  gl_Position = uMatrix * aVertexPosition;
  vTextureCoord = vec2(uUvMatrix * vec3(aTextureCoord, 1.0));
}
`;

type CharData = {
  x: number;
  y: number;
  width: number;
  height: number;
  metrics: TextMetrics;
};

export type DebugRenderState = {
  gl: WebGL2RenderingContext;
  fontTexture: WebGLTexture;
  chars: Map<string, CharData>;
  textureSize: { width: number; height: number };
  program: WebGLProgram;
  programUniforms: {
    vertex: number;
    textureCoord: number;
    texture: WebGLUniformLocation;
    matrix: WebGLUniformLocation;
    uvMatrix: WebGLUniformLocation;
    textColor: WebGLUniformLocation;
    backColor: WebGLUniformLocation;
  };
  positionBuffer: WebGLBuffer;
  textureBuffer: WebGLBuffer;
};

export function initDebugRenderState(
  gl: WebGL2RenderingContext,
  font: string,
): DebugRenderState {
  const program = createProgram(gl, DEBUG_FRAGMENT_SHADER, DEBUG_VERTEX_SHADER);
  const vertex = gl.getAttribLocation(program, "aVertexPosition");
  const textureCoord = gl.getAttribLocation(program, "aTextureCoord");
  const texture = gl.getUniformLocation(program, "uTexture");
  const matrix = gl.getUniformLocation(program, "uMatrix");
  const uvMatrix = gl.getUniformLocation(program, "uUvMatrix");
  const textColor = gl.getUniformLocation(program, "uTextColor");
  const backColor = gl.getUniformLocation(program, "uBackColor");
  if (
    texture == null ||
    matrix == null ||
    uvMatrix == null ||
    textColor == null ||
    backColor == null
  ) {
    throw new Error(
      "failed to initialize DEBUG_FRAGMENT_SHADER, DEBUG_VERTEX_SHADER",
    );
  }
  const positionBuffer = gl.createBuffer();
  const textureBuffer = gl.createBuffer();
  return {
    gl,
    ...prepareDebugFontTexture(gl, font),
    program,
    programUniforms: {
      vertex,
      textureCoord,
      texture,
      matrix,
      uvMatrix,
      textColor,
      backColor,
    },
    positionBuffer,
    textureBuffer,
  };
}

function prepareDebugFontTexture(
  gl: WebGL2RenderingContext,
  font: string,
): Pick<DebugRenderState, "fontTexture" | "chars" | "textureSize"> {
  const canvas = new OffscreenCanvas(0, 0);
  const ctx = canvas.getContext("2d")!;
  const chars = new Map<string, CharData>();
  let x = 0;
  const y = 0;
  let height = 1;
  ctx.font = font;
  ctx.fillStyle = "white";
  for (let code = 32; code < 128; code++) {
    const char = String.fromCharCode(code);
    const metrics = ctx.measureText(char);
    const charHeight = Math.ceil(
      metrics.actualBoundingBoxDescent + metrics.actualBoundingBoxAscent + 1,
    );
    const charWidth = Math.ceil(
      metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight + 1,
    );
    chars.set(char, {
      x,
      y,
      width: charWidth,
      height: charHeight,
      metrics,
    });
    height = Math.max(height, charHeight);
    x += charWidth;
  }
  canvas.width = x;
  canvas.height = height;
  ctx.font = font;
  ctx.fillStyle = "white";
  for (const [char, data] of chars) {
    ctx.fillText(
      char,
      Math.floor(data.x + data.metrics.actualBoundingBoxLeft + 1),
      Math.floor(data.metrics.actualBoundingBoxAscent + 1),
    );
  }
  const fontTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fontTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  return { fontTexture, chars, textureSize: { width: x, height } };
}

export function destroyDebugRenderState(debugRenderState: DebugRenderState) {
  const gl = debugRenderState.gl;
  gl.deleteBuffer(debugRenderState.positionBuffer);
  gl.deleteBuffer(debugRenderState.textureBuffer);
  gl.deleteTexture(debugRenderState.fontTexture);
  gl.deleteProgram(debugRenderState.program);
}

export function drawText(
  debugRenderState: DebugRenderState,
  text: string,
  x: number,
  y: number,
  viewportWidth: number,
  viewPortHeight: number,
  lineHeight: number,
): void {
  const positions: number[] = [];
  const texturePositions: number[] = [];
  const startX = x;

  for (const c of text) {
    if (c === "\n") {
      x = startX;
      y += lineHeight;
      continue;
    }
    const data = debugRenderState.chars.get(c);
    if (data == null) {
      continue;
    } else if (data.width === 1) {
      x += data.metrics.width;
      continue;
    }
    const dx = Math.floor(x - data.metrics.actualBoundingBoxLeft);
    const dy = Math.floor(y - data.metrics.actualBoundingBoxAscent);
    const dx2 = dx + data.width;
    const dy2 = dy + data.height;
    positions.push(dx, dy);
    texturePositions.push(data.x, data.y);
    positions.push(dx, dy2);
    texturePositions.push(data.x, data.y + data.height);
    positions.push(dx + data.width, dy2);
    texturePositions.push(data.x + data.width, data.y + data.height);

    positions.push(dx2, dy2);
    texturePositions.push(data.x + data.width, data.y + data.height);
    positions.push(dx, dy);
    texturePositions.push(data.x, data.y);
    positions.push(dx2, dy);
    texturePositions.push(data.x + data.width, data.y);

    x += data.metrics.width;
  }
  const gl = debugRenderState.gl;
  gl.useProgram(debugRenderState.program);

  gl.bindBuffer(gl.ARRAY_BUFFER, debugRenderState.positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  gl.vertexAttribPointer(
    debugRenderState.programUniforms.vertex,
    2,
    gl.FLOAT,
    false,
    0,
    0,
  );
  gl.enableVertexAttribArray(debugRenderState.programUniforms.vertex);

  gl.bindBuffer(gl.ARRAY_BUFFER, debugRenderState.textureBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array(texturePositions),
    gl.STATIC_DRAW,
  );
  gl.vertexAttribPointer(
    debugRenderState.programUniforms.textureCoord,
    2,
    gl.FLOAT,
    false,
    0,
    0,
  );
  gl.enableVertexAttribArray(debugRenderState.programUniforms.textureCoord);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, debugRenderState.fontTexture);
  gl.uniform1i(debugRenderState.programUniforms.texture, 0);
  gl.uniform3fv(debugRenderState.programUniforms.textColor, [1.0, 1.0, 1.0]);
  gl.uniform3fv(debugRenderState.programUniforms.backColor, [0.0, 0.0, 0.0]);
  function mat(rows: number, cols: number, matrix: number[]): number[] {
    const result: number[] = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        result.push(matrix[r * rows + c]!);
      }
    }
    return result;
  }
  // prettier-ignore
  gl.uniformMatrix4fv(debugRenderState.programUniforms.matrix, false, mat(4, 4, [
      1 / (viewportWidth / 2), 0, 0, -1,
      0, -2 / viewPortHeight, 0, 1,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]));
  // prettier-ignore
  gl.uniformMatrix3fv(debugRenderState.programUniforms.uvMatrix, false, mat(3, 3, [
      1 / debugRenderState.textureSize.width, 0, 0,
      0, 1 / debugRenderState.textureSize.height, 0,
      0, 0, 1,
    ]));
  gl.viewport(0, 0, viewportWidth, viewPortHeight);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLES, 0, positions.length / 2);
  gl.disable(gl.BLEND);
}
