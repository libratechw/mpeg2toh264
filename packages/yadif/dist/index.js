const oe = "" + new URL("assets/worker-jHqATno8.js", import.meta.url).href, C = `#version 300 es
void main() {
  // From the vertex index alone. There is no geometry here worth a buffer.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;
function M(A, e, t) {
  const i = A.createProgram(), s = W(A, A.VERTEX_SHADER, t), r = W(A, A.FRAGMENT_SHADER, e);
  if (A.attachShader(i, s), A.attachShader(i, r), A.linkProgram(i), A.deleteShader(s), A.deleteShader(r), !A.getProgramParameter(i, A.LINK_STATUS)) {
    const n = A.getProgramInfoLog(i);
    throw A.deleteProgram(i), new Error(
      `the deinterlacer failed to link: ${n ?? "no reason given"}`
    );
  }
  return i;
}
function W(A, e, t) {
  const i = A.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (A.shaderSource(i, t), A.compileShader(i), !A.getShaderParameter(i, A.COMPILE_STATUS)) {
    const s = A.getShaderInfoLog(i);
    throw A.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return i;
}
const he = `#version 300 es
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
`, ae = `#version 300 es
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
function ce(A, e) {
  const t = M(A, he, ae), i = A.getAttribLocation(t, "aVertexPosition"), s = A.getAttribLocation(t, "aTextureCoord"), r = A.getUniformLocation(t, "uTexture"), n = A.getUniformLocation(t, "uMatrix"), o = A.getUniformLocation(t, "uUvMatrix"), a = A.getUniformLocation(t, "uTextColor"), c = A.getUniformLocation(t, "uBackColor");
  if (r == null || n == null || o == null || a == null || c == null)
    throw new Error(
      "failed to initialize DEBUG_FRAGMENT_SHADER, DEBUG_VERTEX_SHADER"
    );
  const h = A.createBuffer(), f = A.createBuffer();
  return {
    gl: A,
    ...le(A, e),
    program: t,
    programUniforms: {
      vertex: i,
      textureCoord: s,
      texture: r,
      matrix: n,
      uvMatrix: o,
      textColor: a,
      backColor: c
    },
    positionBuffer: h,
    textureBuffer: f
  };
}
function le(A, e) {
  const t = new OffscreenCanvas(0, 0), i = t.getContext("2d"), s = /* @__PURE__ */ new Map();
  let r = 0;
  const n = 0;
  let o = 1;
  i.font = e, i.fillStyle = "white";
  for (let c = 32; c < 128; c++) {
    const h = String.fromCharCode(c), f = i.measureText(h), d = Math.ceil(
      f.actualBoundingBoxDescent + f.actualBoundingBoxAscent + 1
    ), u = Math.ceil(
      f.actualBoundingBoxLeft + f.actualBoundingBoxRight + 1
    );
    s.set(h, {
      x: r,
      y: n,
      width: u,
      height: d,
      metrics: f
    }), o = Math.max(o, d), r += u;
  }
  t.width = r, t.height = o, i.font = e, i.fillStyle = "white";
  for (const [c, h] of s)
    i.fillText(
      c,
      Math.floor(h.x + h.metrics.actualBoundingBoxLeft + 1),
      Math.floor(h.metrics.actualBoundingBoxAscent + 1)
    );
  const a = A.createTexture();
  return A.bindTexture(A.TEXTURE_2D, a), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_MIN_FILTER, A.LINEAR), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_MAG_FILTER, A.LINEAR), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_WRAP_S, A.CLAMP_TO_EDGE), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_WRAP_T, A.CLAMP_TO_EDGE), A.texImage2D(A.TEXTURE_2D, 0, A.RGBA, A.RGBA, A.UNSIGNED_BYTE, t), { fontTexture: a, chars: s, textureSize: { width: r, height: o } };
}
function ue(A) {
  const e = A.gl;
  e.deleteBuffer(A.positionBuffer), e.deleteBuffer(A.textureBuffer), e.deleteTexture(A.fontTexture), e.deleteProgram(A.program);
}
function fe(A, e, t, i, s, r, n) {
  const o = [], a = [], c = t;
  for (const d of e) {
    if (d === `
`) {
      t = c, i += n;
      continue;
    }
    const u = A.chars.get(d);
    if (u == null)
      continue;
    if (u.width === 1) {
      t += u.metrics.width;
      continue;
    }
    const l = Math.floor(t - u.metrics.actualBoundingBoxLeft), m = Math.floor(i - u.metrics.actualBoundingBoxAscent), v = l + u.width, E = m + u.height;
    o.push(l, m), a.push(u.x, u.y), o.push(l, E), a.push(u.x, u.y + u.height), o.push(l + u.width, E), a.push(u.x + u.width, u.y + u.height), o.push(v, E), a.push(u.x + u.width, u.y + u.height), o.push(l, m), a.push(u.x, u.y), o.push(v, m), a.push(u.x + u.width, u.y), t += u.metrics.width;
  }
  const h = A.gl;
  h.useProgram(A.program), h.bindBuffer(h.ARRAY_BUFFER, A.positionBuffer), h.bufferData(h.ARRAY_BUFFER, new Float32Array(o), h.STATIC_DRAW), h.vertexAttribPointer(
    A.programUniforms.vertex,
    2,
    h.FLOAT,
    !1,
    0,
    0
  ), h.enableVertexAttribArray(A.programUniforms.vertex), h.bindBuffer(h.ARRAY_BUFFER, A.textureBuffer), h.bufferData(
    h.ARRAY_BUFFER,
    new Float32Array(a),
    h.STATIC_DRAW
  ), h.vertexAttribPointer(
    A.programUniforms.textureCoord,
    2,
    h.FLOAT,
    !1,
    0,
    0
  ), h.enableVertexAttribArray(A.programUniforms.textureCoord), h.activeTexture(h.TEXTURE0), h.bindTexture(h.TEXTURE_2D, A.fontTexture), h.uniform1i(A.programUniforms.texture, 0), h.uniform3fv(A.programUniforms.textColor, [1, 1, 1]), h.uniform3fv(A.programUniforms.backColor, [0, 0, 0]);
  function f(d, u, l) {
    const m = [];
    for (let v = 0; v < u; v++)
      for (let E = 0; E < d; E++)
        m.push(l[E * d + v]);
    return m;
  }
  h.uniformMatrix4fv(A.programUniforms.matrix, !1, f(4, 4, [
    1 / (s / 2),
    0,
    0,
    -1,
    0,
    -2 / r,
    0,
    1,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1
  ])), h.uniformMatrix3fv(A.programUniforms.uvMatrix, !1, f(3, 3, [
    1 / A.textureSize.width,
    0,
    0,
    0,
    1 / A.textureSize.height,
    0,
    0,
    0,
    1
  ])), h.viewport(0, 0, s, r), h.enable(h.BLEND), h.blendFunc(h.SRC_ALPHA, h.ONE_MINUS_SRC_ALPHA), h.drawArrays(h.TRIANGLES, 0, o.length / 2), h.disable(h.BLEND);
}
const p = {
  /** This frame's first field is the previous frame's first field. */
  firstRepeatsPrevious: 0,
  /** This frame's second field is the next frame's second field. */
  secondRepeatsNext: 1,
  /** This frame's second field is the previous frame's second field. */
  secondRepeatsPrevious: 2,
  /** The previous frame's second field was the one before's. */
  previousSecondRepeated: 3,
  /** This frame's first field is the next frame's first field. */
  firstRepeatsNext: 4,
  /** The previous frame's first field was the one before's. */
  previousFirstRepeated: 5,
  phase: 6
}, g = 7, ee = 2, N = 1, de = 2, z = 10, me = {
  a: "uA",
  b: "uB",
  fieldMetrics: "uFieldMetrics",
  first: "uFirst",
  size: "uSize"
}, te = 16, ie = 8, pe = `#version 300 es

precision highp float;

uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFieldMetrics;

/** The parity of the field captured first. */
uniform int uFirst;
uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

float luma(vec3 c)
{
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec4 measure(float diff, float total, float threshold)
{
  diff /= total;
  return vec4(diff, diff > threshold ? 1.0 : 0.0, diff, 1.0);
}

void main()
{
  const int BLOCK_W = ${te};
  const int BLOCK_H = ${ie};

  ivec2 block = ivec2(gl_FragCoord.xy);
  ivec2 base = ivec2(block.x * BLOCK_W, block.y * BLOCK_H * 2);

  // Even and odd frame lines, summed apart.
  float diffEven = 0.0;
  float diffOdd = 0.0;
  int totalEven = 0;
  int totalOdd = 0;

  for (int y = 0; y < BLOCK_H; ++y) {
    for (int x = 0; x < BLOCK_W; ++x) {
      ivec2 p = base + ivec2(x, y * 2);

      if (p.x < uSize.x && p.y < uSize.y) {
        float a = luma(texelFetch(uA, p, 0).rgb);
        float b = luma(texelFetch(uB, p, 0).rgb);

        // Ignore small compression artifacts when accumulating differences at moving edges.
        diffEven += max(abs(a - b) - 8.0 / 255.0, 0.0);
        totalEven += 1;
      }
      p.y += 1;
      if (p.x < uSize.x && p.y < uSize.y) {
        float a = luma(texelFetch(uA, p, 0).rgb);
        float b = luma(texelFetch(uB, p, 0).rgb);

        diffOdd += max(abs(a - b) - 8.0 / 255.0, 0.0);
        totalOdd += 1;
      }
    }
  }

  float run = texelFetch(uFieldMetrics, ivec2(${p.phase}, 0), 0)[1];
  float threshold = run == 0.0 ? 0.025 : (run <= 10.0 ? 0.11 : 0.15);

  vec4 even = measure(diffEven, float(totalEven), threshold);
  vec4 odd = measure(diffOdd, float(totalOdd), threshold);
  outFirst = uFirst == 0 ? even : odd;
  outSecond = uFirst == 0 ? odd : even;
}
`, ve = {
  second: "uSecond",
  first: "uFirst",
  size: "uSize"
}, F = 8, Ee = `#version 300 es
precision highp float;

uniform sampler2D uSecond;
uniform sampler2D uFirst;

uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

void main()
{
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 base = dst * ${F};

  vec4 second = vec4(0.0);
  vec4 first = vec4(0.0);

  for (int y = 0; y < ${F}; ++y) {
    for (int x = 0; x < ${F}; ++x) {
      ivec2 p = base + ivec2(x, y);

      if (p.x < uSize.x && p.y < uSize.y) {
        vec4 value = texelFetch(uSecond, p, 0);
        second[0] = max(second[0], value[0]);
        second.yzw += value.yzw;
        value = texelFetch(uFirst, p, 0);
        first[0] = max(first[0], value[0]);
        first.yzw += value.yzw;
      }
    }
  }

  outSecond = second;
  outFirst = first;
}
`, we = {
  previous: "uPrevious",
  second: "uSecond",
  first: "uFirst",
  size: "uSize"
}, ge = `#version 300 es
precision highp float;

uniform sampler2D uPrevious;
uniform sampler2D uSecond;
uniform sampler2D uFirst;

/** The size of the reduced comparisons. */
uniform ivec2 uSize;

out vec4 outValue;

vec4 previous(int metric) {
  return texelFetch(uPrevious, ivec2(metric, 0), 0);
}

/** Fold what REDUCTION left into one texel. */
vec4 fold(sampler2D reduced) {
  vec4 sum = vec4(0.0);
  for (int y = 0; y < uSize.y; ++y) {
    for (int x = 0; x < uSize.x; ++x) {
      vec4 value = texelFetch(reduced, ivec2(x, y), 0);
      sum[0] = max(sum[0], value[0]);
      sum.yzw += value.yzw;
    }
  }
  return vec4(sum[0], sum[1], sum[2] / max(sum[3], 1.0), sum[3]);
}

bool same(float differing) {
  return differing <= ${ee}.0;
}

// A repeated field changes less than the opposite field.
// Distinguish motion shared by both fields from a still image with small absolute differences.
bool repeats(vec4 field, vec4 other) {
  return same(field[1]) &&
    (max(field[0], other[0]) < 0.025 || field[2] < other[2] * 0.75);
}

/** The phase texel, (phase, run), from the six comparisons' differing counts. */
vec4 decide(vec4 last, vec4 dFirstRepeatsPrevious, vec4 dSecondRepeatsNext,
            vec4 dSecondRepeatsPrevious, vec4 dPreviousSecondRepeated,
            vec4 dFirstRepeatsNext, vec4 dPreviousFirstRepeated)
{
  bool firstRepeatsPrevious = repeats(dFirstRepeatsPrevious, dSecondRepeatsPrevious);
  bool secondRepeatsNext = repeats(dSecondRepeatsNext, dFirstRepeatsNext);
  bool secondRepeatsPrevious = repeats(dSecondRepeatsPrevious, dFirstRepeatsPrevious);
  bool previousSecondRepeated = repeats(dPreviousSecondRepeated, dPreviousFirstRepeated);
  bool firstRepeatsNext = repeats(dFirstRepeatsNext, dSecondRepeatsNext);
  bool previousFirstRepeated = repeats(dPreviousFirstRepeated, dPreviousSecondRepeated);
  bool still = (firstRepeatsPrevious && secondRepeatsPrevious) || (secondRepeatsNext && firstRepeatsNext);

  int previous = int(last[0]);
  float run = last[1];
  // What each phase looks like: one field repeats, the other plainly does not.
  bool looks1 = firstRepeatsPrevious && !secondRepeatsPrevious;
  bool looks2 = secondRepeatsNext && !firstRepeatsNext;
  bool looks3 = secondRepeatsPrevious && !firstRepeatsPrevious;
  bool looks4 = previousSecondRepeated && !previousFirstRepeated;
  bool looks5 = firstRepeatsNext && !secondRepeatsNext;

  int expected = previous == 0 ? 0 : (previous == 5 ? 1 : previous + 1);
  bool expectedRepeat =
    expected == 1 ? firstRepeatsPrevious :
    expected == 2 ? secondRepeatsNext :
    expected == 3 ? secondRepeatsPrevious :
    expected == 4 ? previousSecondRepeated :
    expected == 5 ? firstRepeatsNext : false;
  bool expectedLooks =
    expected == 1 ? looks1 :
    expected == 2 ? looks2 :
    expected == 3 ? looks3 :
    expected == 4 ? looks4 :
    expected == 5 ? looks5 : false;
  bool believed = run >= ${z}.0;
  bool carried = believed ? expectedRepeat : expectedLooks;

  int phase = 0;
  if (expected != 0 && carried) {
    phase = expected;
    run += 1.0;
  } else if (expected != 0 && (still || expectedRepeat)) {
    // Uninformative: keeps the cycle's place, counts only once believed.
    phase = expected;
    if (believed) run += 1.0;
  } else if (looks1) {
    phase = 1;
  } else if (looks2) {
    phase = 2;
  } else if (looks3) {
    phase = 3;
  } else if (looks4) {
    phase = 4;
  } else if (looks5) {
    phase = 5;
  }
  if (phase != expected) run = phase != 0 ? 1.0 : 0.0;
  return vec4(float(phase), run, 0.0, 0.0);
}

void main()
{
  int metric = int(gl_FragCoord.x);
  // The comparisons against the next frame become, a frame later, the ones
  // against the previous frame, and those the ones before.
  if (metric == ${p.firstRepeatsPrevious}) {
    outValue = previous(${p.firstRepeatsNext});
  } else if (metric == ${p.secondRepeatsNext}) {
    outValue = fold(uSecond);
  } else if (metric == ${p.secondRepeatsPrevious}) {
    outValue = previous(${p.secondRepeatsNext});
  } else if (metric == ${p.previousSecondRepeated}) {
    outValue = previous(${p.secondRepeatsPrevious});
  } else if (metric == ${p.firstRepeatsNext}) {
    outValue = fold(uFirst);
  } else if (metric == ${p.previousFirstRepeated}) {
    outValue = previous(${p.firstRepeatsPrevious});
  } else {
    outValue = decide(
      previous(${p.phase}),
      previous(${p.firstRepeatsNext}),
      fold(uSecond),
      previous(${p.secondRepeatsNext}),
      previous(${p.secondRepeatsPrevious}),
      fold(uFirst),
      previous(${p.firstRepeatsPrevious})
    );
  }
}
`, xe = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck",
  debug: "uDebug",
  film: "uFilm",
  second: "uSecond",
  phase: "uPhase",
  fieldMetrics: "uFieldMetrics"
}, be = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uNext;
uniform sampler2D uFieldMetrics;
/** The size of a frame in texels. */
uniform ivec2 uSize;
/** The parity of the lines that are kept; the others are interpolated. */
uniform int uParity;
/** Whether the first field of a frame is its top field. */
uniform int uTff;
/** Whether the temporal bound is widened by the local vertical range. */
uniform bool uSpatialCheck;
uniform bool uDebug;
uniform bool uFilm;
uniform bool uSecond;
uniform int uPhase;

out vec4 fragColor;

/**
 * A texel, with the edges of the frame mirrored.
 *
 * The reference reflects its line offsets on the first and last line rather
 * than reading outside the frame, and this is the same thing said once.
 */
vec3 fetch(sampler2D image, int x, int y) {
  int line = y < 0 ? -y : (y >= uSize.y ? 2 * (uSize.y - 1) - y : y);
  return texelFetch(image, ivec2(clamp(x, 0, uSize.x - 1), clamp(line, 0, uSize.y - 1)), 0).rgb;
}

/**
 * Interpolate the missing line along whichever direction the picture runs in.
 *
 * a..g are the seven texels of the line above and h..n those of the line
 * below, both centred on the pixel being built. The straight vertical average
 * is the starting point, and each candidate direction is taken only if the
 * three differences across it are smaller than the best so far; the steeper
 * pair of directions is only considered when the shallower one was an
 * improvement, which is what keeps a busy picture from finding an edge that is
 * not there.
 */
vec3 spatialPredictor(vec3 a, vec3 b, vec3 c, vec3 d, vec3 e, vec3 f, vec3 g,
                      vec3 h, vec3 i, vec3 j, vec3 k, vec3 l, vec3 m, vec3 n) {
  vec3 pred = (d + k) * 0.5;
  vec3 best = abs(c - j) + abs(d - k) + abs(e - l);

  vec3 score = abs(b - k) + abs(c - l) + abs(d - m);
  vec3 taken = vec3(lessThan(score, best));
  pred = mix(pred, (c + l) * 0.5, taken);
  best = mix(best, score, taken);

  score = abs(a - l) + abs(b - m) + abs(c - n);
  taken *= vec3(lessThan(score, best));
  pred = mix(pred, (b + m) * 0.5, taken);
  best = mix(best, score, taken);

  score = abs(d - i) + abs(e - j) + abs(f - k);
  taken = vec3(lessThan(score, best));
  pred = mix(pred, (e + j) * 0.5, taken);
  best = mix(best, score, taken);

  score = abs(e - h) + abs(f - i) + abs(g - j);
  taken *= vec3(lessThan(score, best));
  pred = mix(pred, (f + i) * 0.5, taken);

  return pred;
}

/**
 * Hold the spatial guess to what the moving picture allows.
 *
 * p2 is where the line would be if nothing moved -- the average of the same
 * line in the two frames that bracket this moment -- and the three temporal
 * differences say how much did move. The spatial guess is then clamped to that
 * distance from p2: still picture, and the answer is the line that is really
 * there; motion, and the interpolation is free to take over.
 */
vec3 temporalPredictor(vec3 A, vec3 B, vec3 C, vec3 D, vec3 E, vec3 F,
                       vec3 G, vec3 H, vec3 I, vec3 J, vec3 K, vec3 L,
                       vec3 spatialPred, bool skipCheck) {
  vec3 p0 = (C + H) * 0.5;
  vec3 p1 = F;
  vec3 p2 = (D + I) * 0.5;
  vec3 p3 = G;
  vec3 p4 = (E + J) * 0.5;

  vec3 tdiff0 = abs(D - I) * 0.5;
  vec3 tdiff1 = (abs(A - F) + abs(B - G)) * 0.5;
  vec3 tdiff2 = (abs(K - F) + abs(G - L)) * 0.5;

  vec3 diff = max(tdiff0, max(tdiff1, tdiff2));

  if (!skipCheck) {
    vec3 hi = max(p2 - p3, max(p2 - p1, min(p0 - p1, p4 - p3)));
    vec3 lo = min(p2 - p3, min(p2 - p1, max(p0 - p1, p4 - p3)));
    diff = max(diff, max(lo, -hi));
  }

  return clamp(spatialPred, p2 - diff, p2 + diff);
}

/**
 * Build one interpolated pixel.
 *
 * prev2 and next2 are the frames the missing line is bracketed by, which is
 * not the same pair as prev and next: the field being rebuilt is half a frame
 * from one of its neighbours and one and a half from the other, and it is the
 * near pair that says what the picture looked like around this moment. prev
 * and next themselves are still read, for the two motion measurements.
 */
vec3 filterPixel(sampler2D prev2, sampler2D next2, int x, int y) {
  vec3 a = fetch(uCur, x - 3, y - 1);
  vec3 b = fetch(uCur, x - 2, y - 1);
  vec3 c = fetch(uCur, x - 1, y - 1);
  vec3 d = fetch(uCur, x, y - 1);
  vec3 e = fetch(uCur, x + 1, y - 1);
  vec3 f = fetch(uCur, x + 2, y - 1);
  vec3 g = fetch(uCur, x + 3, y - 1);

  vec3 h = fetch(uCur, x - 3, y + 1);
  vec3 i = fetch(uCur, x - 2, y + 1);
  vec3 j = fetch(uCur, x - 1, y + 1);
  vec3 k = fetch(uCur, x, y + 1);
  vec3 l = fetch(uCur, x + 1, y + 1);
  vec3 m = fetch(uCur, x + 2, y + 1);
  vec3 n = fetch(uCur, x + 3, y + 1);

  // Within three texels of either side there is no room to look along an edge,
  // so the reference takes the vertical average there and so does this.
  bool interior = x >= 3 && x + 3 < uSize.x;
  vec3 spatialPred = interior ? spatialPredictor(a, b, c, d, e, f, g, h, i, j, k, l, m, n)
                              : (d + k) * 0.5;

  vec3 A = fetch(uPrev, x, y - 1);
  vec3 B = fetch(uPrev, x, y + 1);
  vec3 C = fetch(prev2, x, y - 2);
  vec3 D = fetch(prev2, x, y);
  vec3 E = fetch(prev2, x, y + 2);
  vec3 F = d;
  vec3 G = k;
  vec3 H = fetch(next2, x, y - 2);
  vec3 I = fetch(next2, x, y);
  vec3 J = fetch(next2, x, y + 2);
  vec3 K = fetch(uNext, x, y - 1);
  vec3 L = fetch(uNext, x, y + 1);

  // The first and last line the filter builds have only one line of picture
  // outside them, so the range the spatial check would be measured over is not
  // there. The reference drops the check on those two lines.
  bool skipCheck = !uSpatialCheck || y < 2 || y + 2 >= uSize.y;
  return temporalPredictor(A, B, C, D, E, F, G, H, I, J, K, L, spatialPred, skipCheck);
}

int firstParity() {
  return uTff != 0 ? 0 : 1;
}

bool same(int metric) {
  return texelFetch(uFieldMetrics, ivec2(metric, 0), 0)[1] <= ${ee}.0;
}

/** The pulldown phase the detection gave this frame, or 0. See film-shader.ts. */
int detectedPhase() {
  vec4 phase = texelFetch(uFieldMetrics, ivec2(${p.phase}, 0), 0);
  // Deinterlace each field normally until the cadence is confirmed.
  return phase[1] >= ${z}.0 ? int(phase[0]) : 0;
}

bool isMixedPhase(int phase) {
  return phase == ${N} || phase == ${de};
}

/** Detect new combing in phase 4, whose cadence is inferred from previous repeats. */
bool movingComb(vec3 pixel, int x, int y) {
  vec3 above = fetch(uCur, x, y - 1);
  vec3 below = fetch(uCur, x, y + 1);
  vec3 comb = max(min(above, below) - pixel, pixel - max(above, below));
  // Phase 3 is a complete film frame, so use its vertical detail as the reference.
  // Preserve existing horizontal lines and interpolate only pixels with new combing.
  vec3 previous = fetch(uPrev, x, y);
  vec3 previousAbove = fetch(uPrev, x, y - 1);
  vec3 previousBelow = fetch(uPrev, x, y + 1);
  vec3 previousComb = max(min(previousAbove, previousBelow) - previous,
                          previous - max(previousAbove, previousBelow));
  return any(greaterThan(comb, max(previousComb, vec3(0.0)) + vec3(8.0 / 255.0)));
}

const int DEBUG_BAR_CELL = 32;
const int DEBUG_BAR_WIDTH = DEBUG_BAR_CELL * 7;
const int DEBUG_BAR_HEIGHT = 16;

vec3 debugBar(int x) {
  int cell = x / DEBUG_BAR_CELL;
  bool lit = x % DEBUG_BAR_CELL >= DEBUG_BAR_CELL - 4;
  if (cell == 6) return lit || uSecond ? vec3(1.0, 0.0, 0.0) : vec3(0.0);
  return lit || same(cell) ? vec3(1.0) : vec3(0.0);
}

const int DIGIT_WIDTH = 24;
const int DIGIT_HEIGHT = 60;

bool digitLit(int digit, int x, int y) {
  bool a = y < 20;
  bool b = x >= 20 && y < 40;
  bool c = x >= 20 && y >= 40;
  bool d = y >= 56;
  bool e = x < 4 && y >= 40;
  bool f = x < 4 && y < 40;
  bool g = y >= 36 && y < 40;
  switch (digit) {
    case 1: return b || c;
    case 2: return a || b || d || e || g;
    case 3: return a || b || c || d || g;
    case 4: return b || c || f || g;
    case 5: return a || c || d || f || g;
    default: return false;
  }
}

void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  int x = at.x;
  // The framebuffer counts its rows from the bottom and a frame from the top.
  int y = uSize.y - 1 - at.y;

  vec3 rgb;
  if (uFilm && uDebug && y < DEBUG_BAR_HEIGHT && x < DEBUG_BAR_WIDTH) {
    rgb = debugBar(x);
  } else if (uFilm && uDebug && x < DIGIT_WIDTH && y < DIGIT_HEIGHT && uPhase > 0) {
    rgb = digitLit(uPhase, x, y) ? vec3(1.0, 0.0, 0.0) : vec3(0.0);
  } else if (uFilm && !uSecond && detectedPhase() != 0) {
    bool mixed = isMixedPhase(detectedPhase());
    rgb = mixed && (y & 1) != firstParity()
      ? texelFetch(uPrev, ivec2(x, y), 0).rgb
      : texelFetch(uCur, ivec2(x, y), 0).rgb;
    if (detectedPhase() == 4 && (y & 1) != uParity && movingComb(rgb, x, y))
      rgb = filterPixel(uPrev, uCur, x, y);
  } else if ((y & 1) == uParity) {
    rgb = texelFetch(uCur, ivec2(x, y), 0).rgb;
  } else if ((uParity ^ uTff) != 0) {
    // The first field of the frame: the moment it holds sits between the
    // previous frame and the second field of this one.
    rgb = filterPixel(uPrev, uCur, x, y);
  } else {
    rgb = filterPixel(uCur, uNext, x, y);
  }
  fragColor = vec4(rgb, 1.0);
}
`, x = { phase: 0, run: 0 };
function B(A, e, t) {
  return Object.fromEntries(
    Object.entries(t).map(([i, s]) => [
      i,
      A.getUniformLocation(e, s)
    ])
  );
}
class X {
  #t;
  #r;
  #e;
  #n;
  #i;
  #s;
  #f;
  /** The block comparisons of both fields, and the same folded most of the way. */
  #l = null;
  #p = null;
  /** The field metrics (see FIELD_METRICS) of this frame and the one before. */
  #d = null;
  /** Which of the two holds the newest metrics. */
  #g = 0;
  /** The metrics being read back asynchronously. */
  #o = null;
  #a = null;
  #v = 0;
  #h = 0;
  /** The last metrics read back, laid out as FIELD_METRICS says. */
  metrics = new Float32Array(g * 4);
  #A = 0;
  #c = 0;
  constructor(e) {
    this.#t = e, this.#r = M(
      e,
      pe,
      C
    ), this.#e = B(
      e,
      this.#r,
      me
    ), this.#n = M(
      e,
      Ee,
      C
    ), this.#i = B(
      e,
      this.#n,
      ve
    ), this.#s = M(
      e,
      ge,
      C
    ), this.#f = B(e, this.#s, we);
  }
  /** The newest measurements, or null before any frame has been measured. */
  get texture() {
    return this.#d?.[this.#g]?.textures[0] ?? null;
  }
  /** The size of the frames to be measured, which sizes the block grid. */
  resize(e, t) {
    e === this.#A && t === this.#c || (this.#A = e, this.#c = t, this.#R());
  }
  /** Forget every measurement: the next frame starts a cycle from nothing. */
  reset() {
    const e = this.#t;
    e.deleteSync(this.#a), this.#a = null, this.#v = 0;
    const t = this.#d?.[this.#g];
    if (!t) return;
    const i = new Float32Array(g * 4);
    for (let s = 0; s < p.phase; s++)
      i[s * 4 + 1] = 1;
    e.bindTexture(e.TEXTURE_2D, t.textures[0] ?? null), e.texSubImage2D(
      e.TEXTURE_2D,
      0,
      0,
      0,
      g,
      1,
      e.RGBA,
      e.FLOAT,
      i
    );
  }
  /**
   * Detect the pulldown phase of `cur`, the frame being filtered, against
   * `next`, and start reading it back. Only the two comparisons against the
   * next frame are measured; the rest are earlier ones moved along a frame.
   * `first` is the parity of the field that was captured first.
   */
  detect(e, t, i) {
    const s = this.#t;
    if (this.#A === 0 || this.#c === 0) return;
    this.#_();
    const r = this.#l, n = this.#p, o = this.#d;
    if (r === null || n === null || o === null) return;
    const a = o[this.#g], c = o[1 - this.#g];
    if (s.bindFramebuffer(s.FRAMEBUFFER, r.framebuffer), s.useProgram(this.#r), this.#E(0, e, this.#e.a), this.#E(1, t, this.#e.b), this.#E(2, a.textures[0], this.#e.fieldMetrics), s.uniform1i(this.#e.first, i), s.uniform2i(this.#e.size, this.#A, this.#c), s.viewport(0, 0, r.width, r.height), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, n.framebuffer), s.useProgram(this.#n), this.#E(0, r.textures[0], this.#i.second), this.#E(1, r.textures[1], this.#i.first), s.uniform2i(this.#i.size, r.width, r.height), s.viewport(0, 0, n.width, n.height), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, c.framebuffer), s.useProgram(this.#s), this.#E(0, a.textures[0], this.#f.previous), this.#E(1, n.textures[0], this.#f.second), this.#E(2, n.textures[1], this.#f.first), s.uniform2i(this.#f.size, n.width, n.height), s.viewport(0, 0, g, 1), s.drawArrays(s.TRIANGLES, 0, 3), this.#g = 1 - this.#g, this.#v++, this.#a !== null) {
      s.bindFramebuffer(s.FRAMEBUFFER, null);
      return;
    }
    this.#h = this.#v, s.bindBuffer(s.PIXEL_PACK_BUFFER, this.#o), s.readPixels(0, 0, g, 1, s.RGBA, s.FLOAT, 0), s.bindBuffer(s.PIXEL_PACK_BUFFER, null), s.bindFramebuffer(s.FRAMEBUFFER, null), this.#a = s.fenceSync(s.SYNC_GPU_COMMANDS_COMPLETE, 0), s.flush();
  }
  /**
   * The phase of the last frame measured, once the GPU has handed it back,
   * and null while it is still on its way. It is handed back once.
   */
  poll() {
    const e = this.#t, t = this.#a;
    if (t === null || this.#o === null) return null;
    switch (e.clientWaitSync(t, 0, 0)) {
      case e.ALREADY_SIGNALED:
      case e.CONDITION_SATISFIED:
        return e.bindBuffer(e.PIXEL_PACK_BUFFER, this.#o), e.getBufferSubData(e.PIXEL_PACK_BUFFER, 0, this.metrics), e.bindBuffer(e.PIXEL_PACK_BUFFER, null), e.deleteSync(t), this.#a = null, {
          phase: this.metrics[p.phase * 4] ?? 0,
          run: this.metrics[p.phase * 4 + 1] ?? 0,
          age: this.#v - this.#h
        };
      default:
        return null;
    }
  }
  destroy() {
    const e = this.#t;
    if (this.#R(), this.#d !== null) {
      for (const t of this.#d) _(e, t);
      this.#d = null;
    }
    e.deleteSync(this.#a), this.#a = null, e.deleteBuffer(this.#o), this.#o = null, e.deleteProgram(this.#r), e.deleteProgram(this.#n), e.deleteProgram(this.#s);
  }
  #E(e, t, i) {
    const s = this.#t;
    s.activeTexture(s.TEXTURE0 + e), s.bindTexture(s.TEXTURE_2D, t ?? null), s.uniform1i(i, e);
  }
  #R() {
    const e = this.#t;
    this.#l !== null && _(e, this.#l), this.#p !== null && _(e, this.#p), this.#l = null, this.#p = null;
  }
  /** Everything detect needs that is not there yet. */
  #_() {
    const e = this.#t;
    if (this.#l === null || this.#p === null) {
      this.#R();
      const t = Math.ceil(this.#A / te), i = Math.ceil(this.#c / (ie * 2));
      this.#l = D(e, t, i, 2), this.#p = D(
        e,
        Math.ceil(t / F),
        Math.ceil(i / F),
        2
      );
    }
    this.#d === null && (this.#d = [
      D(e, g, 1, 1),
      D(e, g, 1, 1)
    ], this.#g = 0, this.reset()), this.#o === null && (this.#o = e.createBuffer(), e.bindBuffer(e.PIXEL_PACK_BUFFER, this.#o), e.bufferData(
      e.PIXEL_PACK_BUFFER,
      this.metrics.byteLength,
      e.STREAM_COPY
    ), e.bindBuffer(e.PIXEL_PACK_BUFFER, null));
  }
}
function D(A, e, t, i) {
  const s = A.createFramebuffer();
  A.bindFramebuffer(A.FRAMEBUFFER, s);
  const r = [];
  for (let a = 0; a < i; a++) {
    const c = A.createTexture();
    A.bindTexture(A.TEXTURE_2D, c), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_MIN_FILTER, A.NEAREST), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_MAG_FILTER, A.NEAREST), A.texImage2D(
      A.TEXTURE_2D,
      0,
      A.RGBA32F,
      e,
      t,
      0,
      A.RGBA,
      A.FLOAT,
      null
    ), A.framebufferTexture2D(
      A.FRAMEBUFFER,
      A.COLOR_ATTACHMENT0 + a,
      A.TEXTURE_2D,
      c,
      0
    ), r.push(c);
  }
  A.drawBuffers(r.map((a, c) => A.COLOR_ATTACHMENT0 + c));
  const n = A.checkFramebufferStatus(A.FRAMEBUFFER) === A.FRAMEBUFFER_COMPLETE;
  A.bindFramebuffer(A.FRAMEBUFFER, null);
  const o = { framebuffer: s, textures: r, width: e, height: t };
  if (!n)
    throw _(A, o), new Error("failed to allocate framebuffer");
  return o;
}
function _(A, { framebuffer: e, textures: t }) {
  A.deleteFramebuffer(e);
  for (const i of t) A.deleteTexture(i);
}
function T(A, e = 0, t = A.length) {
  const i = new DataView(A.buffer, A.byteOffset, A.byteLength), s = [];
  for (let r = e; r < t; ) {
    if (r + 8 > t) throw new Error("Incomplete MP4 box");
    const n = i.getUint32(r);
    if (n < 8 || r + n > t) throw new Error("Invalid MP4 box size");
    s.push({
      type: String.fromCharCode(...A.subarray(r + 4, r + 8)),
      start: r,
      body: r + 8,
      end: r + n
    }), r += n;
  }
  return s;
}
function Te(A, e) {
  for (const t of T(A, e.body, e.end).filter(
    (i) => i.type === "trak"
  )) {
    let i = t;
    for (const s of ["mdia", "minf", "stbl", "stsd"]) {
      const r = T(A, i.body, i.end).find(
        (n) => n.type === s
      );
      if (!r) break;
      i = r;
    }
    if (i.type === "stsd")
      for (const s of T(A, i.body + 8, i.end)) {
        if (s.type !== "avc1") continue;
        const r = T(A, s.body + 78, s.end).find(
          (a) => a.type === "avcC"
        );
        if (!r) throw new Error("AVC sample entry has no avcC");
        const n = A.slice(r.body, r.end);
        return { codec: "avc1." + Array.from(n.subarray(1, 4)).map((a) => a.toString(16).padStart(2, "0")).join(""), description: n };
      }
  }
  return null;
}
class ye {
  #t;
  #r = null;
  #e = null;
  /** Compressed frames within the MSE buffer, retained at normal speed for seeks and later accelerated playback. */
  #n = [];
  #i = 0;
  #s = null;
  #f = [];
  /** Timestamps of one-tick duplicate pictures needed only as open-GOP decoding references. */
  #l = /* @__PURE__ */ new Set();
  #p = !1;
  #d = !1;
  #g = !1;
  #o = !1;
  #a = !1;
  #v = /* @__PURE__ */ new WeakMap();
  constructor(e) {
    this.#t = e, e.addEventListener("seeking", this.#A), e.addEventListener("ratechange", this.#A);
  }
  get active() {
    return this.#o;
  }
  /** Receive input in MSE append order; the caller retains ownership of the original ArrayBuffer. */
  append(e) {
    if (this.#g) return;
    const t = new Uint8Array(e), i = new DataView(e);
    try {
      for (const r of T(t)) {
        if (r.type === "moov") {
          this.#r = Te(t, r);
          const n = this.#r;
          n && VideoDecoder.isConfigSupported(n).then((o) => {
            this.#v.set(n, o.supported === !0);
          }).catch((o) => this.#c(o));
        }
        if (!(r.type !== "moof" || this.#r === null))
          for (const n of T(t, r.body, r.end).filter(
            (o) => o.type === "traf"
          )) {
            const o = T(t, n.body, n.end), a = o.find((l) => l.type === "tfhd");
            if (!a || i.getUint32(a.body + 4) !== 1) continue;
            const c = o.find((l) => l.type === "tfdt"), h = o.find((l) => l.type === "trun");
            if (!c || !h || i.getUint32(c.body) !== 16777216 || i.getUint32(h.body) !== 16781057)
              throw new Error("Unexpected mpeg2toh264 video fragment layout");
            let f = Number(i.getBigUint64(c.body + 4)), d = r.start + i.getInt32(h.body + 8);
            const u = i.getUint32(h.body + 4);
            if (h.body + 12 + u * 16 > h.end)
              throw new Error("Incomplete video samples");
            for (let l = 0; l < u; l++) {
              const m = h.body + 12 + l * 16, v = i.getUint32(m), E = i.getUint32(m + 4), k = i.getUint32(m + 8), ne = i.getInt32(m + 12);
              if (d < 0 || d + E > t.length)
                throw new Error("Video sample outside fragment");
              this.#n.push({
                config: this.#r,
                decodeTime: f / 9e4,
                timestamp: Math.round((f + ne) * 1e6 / 9e4),
                duration: Math.round(v * 1e6 / 9e4),
                type: k & 65536 ? "delta" : "key",
                data: t.subarray(d, d + E)
              }), f += v, d += E;
            }
          }
      }
      const s = this.#t.buffered;
      if (s.length > 0) {
        let r = 0;
        for (let n = 0; n < (this.#o ? this.#i : this.#n.length); n++) {
          const o = this.#n[n];
          o.type === "key" && o.timestamp / 1e6 <= s.start(0) && (r = n);
        }
        r > 0 && (this.#n.splice(0, r), this.#i = Math.max(0, this.#i - r));
      }
    } catch (s) {
      this.#c(s);
    }
  }
  /** Return undefined to use the video element, or null to wait for the next decoded frame. */
  take() {
    if (this.#g || this.#t.playbackRate <= 1.25 || this.#r === null || this.#v.get(this.#r) !== !0) {
      this.#o && this.#A();
      return;
    }
    this.#o || (this.#A(), this.#o = !0);
    const e = this.#t.currentTime;
    try {
      for (; this.#i < this.#n.length && (this.#s?.decodeQueueSize ?? 0) < 6 && this.#f.length < 12; ) {
        const i = this.#n[this.#i];
        if (i.decodeTime > e + 0.25) break;
        if (this.#e !== i.config) {
          if (this.#s) {
            if (!this.#d) {
              this.#d = !0;
              const r = this.#s;
              r.flush().then(() => {
                this.#s === r && (r.close(), this.#s = null, this.#e = null, this.#d = !1);
              }).catch((n) => {
                this.#s === r && this.#c(n);
              });
            }
            break;
          }
          const s = new VideoDecoder({
            output: (r) => {
              this.#s !== s ? r.close() : this.#h(r);
            },
            error: (r) => {
              this.#s === s && this.#c(r);
            }
          });
          this.#s = s, this.#s.configure(i.config), this.#e = i.config;
        }
        (i.duration ?? 0) < 1e3 && this.#l.add(i.timestamp), this.#s.decode(new EncodedVideoChunk(i)), this.#i++;
      }
      if (this.#p && this.#i === this.#n.length && this.#s && !this.#d) {
        this.#d = !0;
        const i = this.#s;
        i.flush().catch((s) => {
          this.#s === i && this.#c(s);
        });
      }
    } catch (i) {
      this.#c(i);
      return;
    }
    const t = this.#f[0];
    return !t || t.timestamp / 1e6 > e + 3e-3 * this.#t.playbackRate ? this.#a ? null : void 0 : (this.#a = !0, this.#f.shift());
  }
  #h = (e) => {
    this.#l.delete(e.timestamp) || e.timestamp / 1e6 < this.#t.currentTime - (this.#a ? 0.1 : 0.04) ? e.close() : this.#f.push(e);
  };
  #A = () => {
    this.#s && this.#s.state !== "closed" && this.#s.close(), this.#s = null, this.#e = null;
    for (const e of this.#f) e.close();
    this.#f = [], this.#l.clear(), this.#d = !1, this.#o = !1, this.#a = !1, this.#i = 0;
    for (let e = 0; e < this.#n.length; e++) {
      const t = this.#n[e];
      t.type === "key" && t.timestamp / 1e6 <= this.#t.currentTime && (this.#i = e);
    }
  };
  finish() {
    this.#p = !0;
  }
  /** Release the decoder and undisplayed frames while the filter is stopped. */
  suspend() {
    this.#A();
  }
  reset() {
    this.#A(), this.#n = [], this.#i = 0, this.#r = null, this.#p = !1, this.#g = !1;
  }
  destroy() {
    this.reset(), this.#t.removeEventListener("seeking", this.#A), this.#t.removeEventListener("ratechange", this.#A);
  }
  #c(e) {
    this.#A(), this.#g = !0, console.warn("mpeg2toh264: decoded video input unavailable", e);
  }
}
const se = [
  "mozParsedFrames",
  "mozDecodedFrames",
  "mozPresentedFrames",
  "mozPaintedFrames"
];
function re(A) {
  return se.every((e) => e in A);
}
function Fe(A) {
  return A.ownerDocument?.defaultView?.performance.timeOrigin ?? performance.timeOrigin;
}
function De() {
  return typeof HTMLVideoElement < "u" && (re(HTMLVideoElement.prototype) || typeof HTMLVideoElement.prototype.requestVideoFrameCallback == "function");
}
const Re = 250, Me = 500;
class _e {
  #t;
  #r;
  #e;
  #n = null;
  #i = null;
  #s = null;
  #f = null;
  #l = !1;
  #p = !0;
  #d = null;
  #g = null;
  #o = 0;
  #a;
  #v;
  #h = null;
  #A = null;
  #c = null;
  #E = null;
  #R = 0;
  #_ = [];
  #y = [];
  constructor(e, t) {
    if (this.#t = e, this.#r = t, this.#e = re(e) ? e : null, this.#a = this.#e === null && typeof VideoFrame < "u", this.#v = this.#a && e.playbackRate > 1, this.#e) {
      for (const i of ["emptied", "seeking", "seeked"])
        e.addEventListener(i, this.#I);
      for (const i of ["pause", "playing", "waiting", "ratechange"])
        e.addEventListener(i, this.#F);
    }
    if (this.#a)
      for (const i of [
        "loadeddata",
        "playing",
        "pause",
        "ended",
        "seeking",
        "seeked",
        "emptied",
        "ratechange"
      ])
        e.addEventListener(i, this.#we);
  }
  /** Whether acquisition runs off the Firefox counters. */
  get mozDriven() {
    return this.#e !== null && !this.#v;
  }
  /** Whether frequent capture is active, excluding fallback notifications based on video.currentTime. */
  get captureDriven() {
    return this.#v;
  }
  /** Whether any frame has been delivered yet (counters proven live). */
  get hasDelivered() {
    return this.#l;
  }
  request(e) {
    if (this.#i === null) {
      if (this.#i = e, this.#v) {
        this.#L();
        return;
      }
      this.#n = this.#e ? requestAnimationFrame(this.#G) : this.#t.requestVideoFrameCallback(this.#ge);
    }
  }
  cancel() {
    this.#n !== null && (this.#e ? cancelAnimationFrame(this.#n) : this.#t.cancelVideoFrameCallback(this.#n)), this.#n = null, this.#i = null, this.#h?.(), this.#h = null, this.#c !== null && this.#t.cancelVideoFrameCallback(this.#c), this.#c = null, this.#V(), this.#E = null, this.#_ = [], this.#I();
  }
  destroy() {
    this.cancel();
    for (const e of ["emptied", "seeking", "seeked"])
      this.#t.removeEventListener(e, this.#I);
    for (const e of ["pause", "playing", "waiting", "ratechange"])
      this.#t.removeEventListener(e, this.#F);
    for (const e of [
      "loadeddata",
      "playing",
      "pause",
      "ended",
      "seeking",
      "seeked",
      "emptied",
      "ratechange"
    ])
      this.#t.removeEventListener(e, this.#we);
  }
  /** Deliver pending input on the rendering window's refresh, before drawing. */
  flush(e) {
    if (this.#v)
      for (this.#t.ownerDocument !== this.#A && (this.#h?.(), this.#h = null, this.#L()); this.#y.length > 0 && this.#i !== null; ) {
        const t = this.#y.shift(), i = t.frame;
        try {
          this.#S(e, {
            width: i.visibleRect?.width ?? i.codedWidth,
            height: i.visibleRect?.height ?? i.codedHeight,
            mediaTime: i.timestamp / 1e6,
            presentedFrames: t.count,
            expectedDisplayTime: t.at,
            timeOrigin: performance.timeOrigin,
            frame: i
          });
        } finally {
          i.close();
        }
      }
  }
  #V() {
    for (const e of this.#y) e.frame.close();
    this.#y = [];
  }
  #we = (e) => {
    const t = this.#a && this.#t.playbackRate > 1;
    if (t !== this.#v) {
      const i = this.#i;
      this.cancel(), this.#v = t, i !== null && this.request(i);
      return;
    }
    this.#v && ((e.type === "pause" || e.type === "ended") && this.flush(performance.now()), this.#V(), ["seeking", "seeked", "emptied", "ratechange"].includes(e.type) && (this.#E = null, this.#_ = []), this.#h?.(), this.#h = null, this.#i !== null && this.#L());
  };
  #L() {
    if (this.#h !== null || this.#i === null || (this.#t.paused || this.#t.ended) && this.#E !== null)
      return;
    this.#c === null && typeof this.#t.requestVideoFrameCallback == "function" && (this.#c = this.#t.requestVideoFrameCallback(
      this.#te
    ));
    const e = Math.max(4, 8 / Math.max(1, this.#t.playbackRate)), t = this.#t.ownerDocument?.defaultView;
    if (this.#A = this.#t.ownerDocument, t) {
      const i = t.setTimeout(this.#U, e);
      this.#h = () => t.clearTimeout(i);
    } else {
      const i = setTimeout(this.#U, e);
      this.#h = () => clearTimeout(i);
    }
  }
  #te = () => {
    this.#c = null, this.#h?.(), this.#h = null, this.#U();
  };
  #U = () => {
    this.#h = null;
    const e = this.#t;
    if (this.#i === null) return;
    if (e.readyState < 2 || e.seeking) {
      this.#L();
      return;
    }
    let t, i = !1;
    try {
      const s = this.#r?.();
      if (s === null) {
        this.#L();
        return;
      }
      i = s !== void 0, t = s ?? new VideoFrame(e);
    } catch (s) {
      if (!(s instanceof DOMException) || s.name !== "InvalidStateError")
        throw s;
      this.#L();
      return;
    }
    if (t.timestamp === this.#E)
      t.close();
    else {
      let s = 1;
      if (this.#E !== null) {
        const n = t.timestamp - this.#E;
        if (n > 1e3 && n < 25e4) {
          this.#_.push(n), this.#_.length > 7 && this.#_.shift();
          const o = [...this.#_].sort((c, h) => c - h), a = o[Math.floor(o.length / 2)];
          s = Math.max(1, Math.round(n / a));
        }
      }
      this.#E = t.timestamp, this.#R += s;
      const r = performance.now() + (i ? (t.timestamp / 1e6 - e.currentTime) * 1e3 / e.playbackRate : 0);
      for (this.#y.push({ frame: t, at: r, count: this.#R }); this.#y.length > 4; ) this.#y.shift().frame.close();
    }
    this.#L();
  };
  #F = () => {
    this.#d = null, this.#g = null, this.#o = 0;
  };
  #I = () => {
    this.#s = null, this.#f = null, this.#p = !0, this.#F();
  };
  /** Native acquisition: pass the report on, with the clock it was made on. */
  #ge = (e, t) => {
    this.#S(e, {
      width: t.width,
      height: t.height,
      mediaTime: t.mediaTime,
      presentedFrames: t.presentedFrames,
      expectedDisplayTime: t.expectedDisplayTime,
      timeOrigin: Fe(this.#t)
    });
  };
  #S = (e, t) => {
    const i = this.#i;
    this.#n = null, this.#i = null, this.#l = !0, i?.(e, t);
  };
  #G = (e) => {
    const t = this.#e, i = se.map((o) => t[o]);
    this.#s?.some((o, a) => i[a] < o) && this.#I(), this.#s = i;
    const s = t.mozPaintedFrames, r = !t.seeking && t.readyState >= 2 && t.videoWidth > 0 && t.videoHeight > 0, n = this.#f === null && (s > 0 || t.paused && (t.mozPresentedFrames > 0 || t.mozDecodedFrames > 0));
    if (r && (n || this.#f !== null && s !== this.#f)) {
      if (this.#d !== null && e - this.#d > Me && (this.#F(), this.#p = !0), !t.paused && !t.ended) {
        const a = this.#g;
        if (a && e - a.at >= Re) {
          const c = s - a.frames;
          if (c > 0) {
            const h = (e - a.at) / c;
            h >= 4 && h <= 200 && (this.#o = this.#o ? this.#o + (h - this.#o) * 0.25 : h);
          }
          this.#g = null;
        }
        this.#g ??= { at: e, frames: s };
      }
      this.#d = e, this.#f = s;
      const o = this.#p;
      this.#p = !1, this.#S(e, {
        width: t.videoWidth,
        height: t.videoHeight,
        // Used only to select source scan/size metadata on the media timeline.
        // It is deliberately NOT used as the frame identity or field clock.
        mediaTime: t.currentTime,
        presentedFrames: s,
        // The counters report no display time. The poll that found the frame
        // is the best stand-in, and it was taken on this module's clock --
        // not the video node's window, which may be a different one.
        expectedDisplayTime: e,
        timeOrigin: performance.timeOrigin,
        mozTiming: { periodMs: this.#o, discontinuity: o }
      });
    } else
      this.#n = requestAnimationFrame(this.#G);
  };
}
let Ae = null;
function Se(A) {
  Ae = A;
}
const H = 0.5, w = 4, G = 5, b = G + 1, V = 1e3, L = 4, R = 200, Pe = 0.25, ke = 1e3 / 60, $ = 250, Ce = 1e3 / 30, Be = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, Le = 0.75, Ie = 0.1, Q = 1, Ue = 0.02, Ne = 0.1, Z = 1, Ge = 4, I = 5, Oe = 4, ze = {
  2: 0,
  3: 0.25,
  4: 0.5,
  5: 0.75
}, We = `#version 300 es
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
function Ke() {
  return De() && typeof WebGL2RenderingContext < "u";
}
const Xe = {
  requestAnimationFrame: (A) => requestAnimationFrame(A),
  cancelAnimationFrame: (A) => cancelAnimationFrame(A)
};
class Je extends EventTarget {
  /** Receive fMP4 from the player and decode supplemental input only above 1.25x playback speed. */
  encodedVideo;
  #t;
  #r;
  #e;
  #n;
  #i;
  /** The pulldown detection, built only while the `film` option needs it. */
  #s = null;
  #f;
  #l;
  /** The program that copies a filtered picture onto the canvas. */
  #p;
  #d;
  #g;
  #o = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #a = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #v = b - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #h = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #A = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #c = null;
  #E = 0;
  /** ページ側で frame callback の停止を監視する requestAnimationFrame()。 */
  #R = null;
  /** The document the owner-change listener is on, if any. */
  #_ = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #y = ke;
  /** Where the refresh grid fitted to the animation frames stands. (otya) */
  #V = 0;
  /** How far ahead of its animation frame the last picture shown stood. (otya) */
  #we = 0;
  #L = 0;
  #te = 0;
  /** The last picture chained onto the schedule; a break restarts it. (otya) */
  #U = null;
  /**
   * Drop the presentation queue and restart the schedule from the clock.
   * Every schedule restart goes through here (otya nulls #lastScheduled at
   * each queue clear): the old chain's clock no longer applies, so keeping
   * it would either count a phantom resync or pop freshly queued pictures
   * as late. Restart accounting for cadence changes lives in #schedule.
   */
  #F() {
    this.#A.length = 0, this.#U = null, this.#te = 0;
  }
  /** The `<div>` this put around the element, so it can be taken away again. */
  #I = null;
  #ge;
  #S;
  #G;
  #ie = 0;
  /** otya GPU pulldown path: enabled by the `film` option (see below). */
  #O;
  #M;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #w = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #C = 0;
  #z = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #B = w - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #b = 0;
  #xe = 0;
  /** presentedFrames at the last ingested frame; pairs with #lastMediaTime. */
  #Ye = 0;
  #Le = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #be = !1;
  /** 最終通知時刻。rVFC と Firefox カウンターのどちらの取得経路でも更新する。 */
  #Ie = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #se = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #je = 0;
  /** 代替経路が requestVideoFrameCallback() を最後に予約し直した時刻。 */
  #xt = 0;
  #T = !1;
  /** Cancels work suspended inside a synchronous owner callback. */
  #q = 0;
  #Ue = !1;
  #W = !1;
  #x = null;
  #re = [];
  #N = !1;
  #qe;
  #Ke;
  #D;
  #Ae;
  #$;
  #Je;
  #u = null;
  #m;
  #Te = !1;
  #et = 0;
  #tt = !1;
  #$t = 0;
  #ye = !1;
  #Ne = !1;
  #ne = null;
  #Qt = 0;
  #Fe = /* @__PURE__ */ new Map();
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #P = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    resynced: 0,
    late: 0,
    queueResetted: 0
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #oe = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #it = 0;
  #Ge = 0;
  #K = 0;
  #De = 0;
  #Re = 0;
  #Me = 0;
  #he = 0;
  #ae;
  #Oe = [];
  #ce = [];
  #_e = 0;
  #le = 0;
  #Se = 0;
  #ue = 0;
  /** The last phase read back from the GPU, and how many frames ago it was for. */
  #Pe = x;
  #fe = 0;
  /** The phase of the frame being filtered: #known advanced by #knownAge. */
  #k = x;
  #Q = !1;
  #de = null;
  #bt = "";
  /** Debug only: frames given each phase (0 for none), and repeats dropped. */
  #ze = [0, 0, 0, 0, 0, 0];
  #st = 0;
  /**
   * Why requested film reconstruction is currently degraded, or null while
   * healthy. The `film` option stays as the caller set it;
   * only the engine stands down, so this is never a silent option change.
   */
  #J = null;
  /** Last worker-reported filmError, to derive the page-side failure event. */
  #rt = null;
  #At = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#S = t.doubleRate ?? !1, this.#G = t.spatialCheck ?? !0, this.#O = t.debug ?? !1, this.#M = t.film ?? !1, this.#qe = t.onStats, this.#Ke = t.onFailure, this.#D = i, this.#$ = i ? "main" : t.rendering ?? "main", this.#Je = t.workerUrl ?? Ae, this.#m = this.#$ === "main" ? "main" : "idle", this.#r = i ? i.canvas : document.createElement("canvas"), this.#t = i?.canvas ?? (this.#$ === "main" ? this.#r : document.createElement("canvas")), this.#Ae = e, i || (this.#r.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const s = this.#t.getContext("webgl2", {
      // Keep the underlying video in Chromium's compositor to receive frame notifications at the source rate.
      alpha: !0,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!(s instanceof WebGL2RenderingContext))
      throw new Error("this browser has no WebGL2");
    this.#i = s, this.#M && (this.#Dt(), this.#s = new X(s)), this.#f = Y(s, be);
    const r = this.#f;
    this.#l = Object.fromEntries(
      Object.entries(xe).map(([n, o]) => [
        n,
        s.getUniformLocation(r, o)
      ])
    ), this.#p = Y(s, We), this.#d = s.getUniformLocation(this.#p, "uField"), this.#g = s.getUniformLocation(this.#p, "uFlip"), this.#ae = s.getExtension(
      "EXT_disjoint_timer_query_webgl2"
    ), this.#t.addEventListener(
      "webglcontextlost",
      this.#Vt
    ), this.#ge = i ? null : new ResizeObserver(() => this.#Ze()), this.encodedVideo = !i && typeof VideoDecoder < "u" ? new ye(e) : null, this.#n = new _e(e, () => this.encodedVideo?.take()), e.addEventListener("emptied", this.#Wt), e.addEventListener("resize", this.#zt), e.addEventListener("pause", this.#j), e.addEventListener("ended", this.#j), e.addEventListener("seeking", this.#Ht), e.addEventListener("seeked", this.#j), e.addEventListener("ratechange", this.#j);
  }
  get running() {
    return this.#T && (this.#x?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#r;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #Tt() {
    return this.#x?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #yt() {
    return {
      doubleRate: this.#S,
      spatialCheck: this.#G,
      film: this.#M,
      debug: this.#O
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#Ue;
  }
  set enabled(e) {
    this.#Ue = e, this.#nt(), this.#u?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#x?.interlaced !== e?.interlaced, i = t || this.#x?.topFieldFirst !== e?.topFieldFirst;
    this.#x = e, !(i && (!this.#pe() || this.#x !== e)) && (this.#u?.postMessage({ type: "scan", scan: e }), i && (this.#b = 0, this.#F(), this.#X(), t && (this.#w = 0), this.#h = null, this.#Y(!1)), this.#nt(), i && ((e?.interlaced ?? !0) && (this.#D || this.#m === "main") ? this.#Ce() : this.#ft()));
  }
  get scan() {
    return this.#x;
  }
  set videoTimeline(e) {
    this.#re = e, this.#u?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#x = null), this.#nt();
  }
  get videoTimeline() {
    return this.#re;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#I ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#S;
  }
  set doubleRate(e) {
    e !== this.#S && (this.#S = e, this.#me(), this.#F(), this.#Ft());
  }
  get spatialCheck() {
    return this.#G;
  }
  set spatialCheck(e) {
    e !== this.#G && (this.#G = e, this.#me());
  }
  get film() {
    return this.#M;
  }
  set film(e) {
    const t = this.#u ? this.#rt : this.#J;
    if (!(e === this.#M && (e === !1 || t === null))) {
      if (this.#u) {
        this.#M = e, this.#me(e ? "film" : void 0);
        return;
      }
      if (e) {
        if (!this.#pe()) return;
        try {
          this.#Rt();
        } catch (i) {
          this.#M = !0, this.#me(), this.#ht(
            `film detector unavailable: ${i instanceof Error ? i.message : String(i)}`
          );
          return;
        }
      }
      if (this.#M = e, this.#me(), !e) {
        if (!this.#pe()) return;
        this.#Q = !1, this.#k = x, this.#X(), this.#s?.destroy(), this.#s = null;
      }
      this.#Ft();
    }
  }
  get debug() {
    return this.#O;
  }
  set debug(e) {
    e !== this.#O && (this.#O = e, this.#me());
  }
  /** Whether pictures are queued for presentation by the frame loop. */
  get #Zt() {
    return this.#S || this.#M;
  }
  #Ft() {
    this.#W || (this.#Zt ? (this.#C > 0 && this.#Ot(), (this.#x?.interlaced ?? !0) && (this.#D || this.#m === "main") && this.#Ce()) : this.#M || (this.#h = null, this.#Y(!1), this.#Be()));
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #me(e) {
    this.#u?.postMessage({
      type: "settings",
      options: this.#yt(),
      retryFilm: e
    });
  }
  #Dt() {
    if (this.#i.getExtension("EXT_color_buffer_float") === null)
      throw new Error("film needs EXT_color_buffer_float");
  }
  /** Build the GPU pulldown detector the `film` option needs, or throw. */
  #Rt() {
    this.#Dt(), this.#s ??= new X(this.#i), this.#C > 0 && this.#s.resize(this.#C, this.#z);
  }
  #nt() {
    this.#Ue && (this.#re.length > 0 || (this.#x?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #Yt() {
    return this.#D || this.#$ === "main" ? !1 : this.#m === "starting" || this.#m === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Je !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Mt(), !0) : this.#$ === "auto" ? (this.#We(), !1) : (this.#m = "failed", this.#T = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #Mt() {
    this.#Z(), this.#u?.terminate(), this.#u = null, this.#ye = !1, this.#Ne = !1, this.#rt = null, this.#At = 0;
    let e = this.#r;
    if (this.#tt) {
      e = document.createElement("canvas"), e.className = this.#r.className;
      const r = this.#r.getAttribute("style");
      r === null ? e.removeAttribute("style") : e.setAttribute("style", r), e.style.visibility = "hidden", this.#r.parentElement && this.#r.replaceWith(e), this.#r = e;
    }
    const t = ++this.#et;
    this.#m = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#tt = !0, i = new Worker(this.#Je, { type: "module" });
    } catch (r) {
      this.#ke(
        r instanceof Error ? r.message : String(r)
      );
      return;
    }
    this.#u = i, i.onmessage = (r) => {
      t === this.#et && this.#jt(r.data);
    }, i.onerror = (r) => {
      t === this.#et && (r.preventDefault(), this.#ke(r.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#yt(),
        scan: this.#x,
        videoTimeline: this.#re,
        enabled: this.#T,
        video: this.#at()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #jt(e) {
    switch (e.type) {
      case "ready":
        this.#m = "active", this.#T && (this.#ve(), this.#vt());
        break;
      case "failed":
        this.#ke(e.message);
        break;
      case "consumed": {
        this.#ye = !1, this.#Ne = !0;
        const t = this.#ne;
        this.#ne = null, t && this.#St(t);
        break;
      }
      case "visibility":
        this.#r.style.visibility = e.visible ? "visible" : "hidden";
        break;
      case "stats": {
        const t = {
          ...e.stats,
          dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0
        }, i = t.filmError ?? null, s = this.#At;
        if (this.#rt = i, this.#At = e.filmFailure, i !== null && e.filmFailure !== s) {
          this.dispatchEvent(
            new CustomEvent("failure", { detail: i })
          );
          try {
            this.#Ke?.(i);
          } catch {
          }
        }
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#qe?.(t);
        break;
      }
      case "capture": {
        const t = this.#Fe.get(e.id);
        if (this.#Fe.delete(e.id), !t) {
          e.image?.close();
          break;
        }
        e.image ? t.resolve(e.image) : createImageBitmap(this.#e).then(
          t.resolve,
          t.reject
        );
        break;
      }
    }
  }
  /**
   * Tell the owner that a rendering resource failed after construction.
   * In the worker domain the boundary counts episodes: the reason travels in
   * `stats.filmError` and the page derives the event from the episode count,
   * so a film degradation is never mistaken for worker death.
   */
  #ot(e) {
    if (this.dispatchEvent(new CustomEvent("failure", { detail: e })), !this.#D)
      try {
        this.#Ke?.(e);
      } catch {
      }
  }
  /**
   * Stand down film reconstruction without touching the caller's options.
   * Pictures keep flowing through plain YADIF; the reason is reported once
   * per episode through the failure event/option and `stats.filmError`.
   * Silently turning the `film` option off is not a fallback -- it would
   * rewrite the caller's 24fps intent -- so the option stays on and only
   * the engine stands down.
   */
  #ht(e) {
    this.#J !== e && (this.#J = e, this.#Q = !1, this.#k = x, this.#X(), this.#s?.destroy(), this.#s = null, this.#ot(e));
  }
  /**
   * Re-arm film reconstruction at a resource-reallocation point (start, scan
   * change, resize, or re-setting the option). The next frame retries; a
   * repeated failure degrades again and notifies as a new episode.
   */
  #pe() {
    return this.#W ? !1 : (this.#u || (this.#J = null), !0);
  }
  /** 一時的な Worker 障害を1回だけ復旧し、再失敗時は media element 自体を表示する。 */
  #ke(e) {
    if (this.#m === "starting" && this.#$ === "auto" && !this.#Te) {
      this.#We();
      return;
    }
    if (this.#_t(e), !this.#Te) {
      this.#Te = !0, this.#Mt();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#m = "failed", this.#u?.terminate(), this.#u = null, this.#Z(), this.#ot(`deinterlacer worker stopped: ${e}`), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #We() {
    const e = this.#t;
    e.className = this.#r.className;
    const t = this.#r.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#r.parentElement && this.#r.replaceWith(e), this.#r = e, this.#tt = !1, this.#u?.terminate(), this.#u = null, this.#m = "main", this.#Z(), this.#T && (this.#ve(), this.#vt(), (this.#x?.interlaced ?? !0) && this.#Ce());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #Z() {
    this.#ne?.frame.close(), this.#ne = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #_t(e) {
    for (const t of this.#Fe.values())
      t.reject(new Error(e));
    this.#Fe.clear();
  }
  start() {
    if (!(this.#T || this.#W || this.#N) && (this.#q++, this.#T = !0, this.#Xt(), !!this.#pe())) {
      if (this.#Ie = performance.now(), this.#je = this.#Ie, this.#Le = Number.NaN, this.#se = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#di(), this.#vt(), this.#Yt()) {
        this.#u?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#m === "active" && this.#ve();
        return;
      }
      this.#ve(), (this.#x?.interlaced ?? !0) && this.#Ce();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#q++, this.#T && (this.#T = !1, this.#n.cancel(), this.encodedVideo?.suspend(), this.#oi(), this.#ft(), this.#b = 0, this.#h = null, this.#Y(!1), this.#Z(), this.#u?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#W) {
      this.#W = !0, this.#Ue = !1, this.stop(), this.#u?.postMessage({ type: "destroy" }), this.#u?.terminate(), this.#u = null, this.#Z(), this.#_t("the deinterlacer was destroyed"), this.#_?.removeEventListener(
        "visibilitychange",
        this.#pt
      ), this.#_ = null, this.#t.removeEventListener(
        "webglcontextlost",
        this.#Vt
      ), this.#n.destroy(), this.encodedVideo?.destroy(), this.#e.removeEventListener("emptied", this.#Wt), this.#e.removeEventListener("resize", this.#zt), this.#e.removeEventListener("pause", this.#j), this.#e.removeEventListener("ended", this.#j), this.#e.removeEventListener("seeking", this.#Ht), this.#e.removeEventListener("seeked", this.#j), this.#e.removeEventListener("ratechange", this.#j), this.#mi();
      for (const e of this.#o) this.#i.deleteTexture(e);
      this.#o = [], this.#Be();
      for (const e of [
        ...this.#Oe,
        ...this.#ce.map(({ q: t }) => t)
      ])
        this.#i.deleteQuery(e);
      this.#Oe.length = 0, this.#ce.length = 0, this.#s?.destroy(), this.#s = null, this.#de !== null && (ue(this.#de), this.#de = null), this.#i.deleteProgram(this.#f), this.#i.deleteProgram(this.#p), this.#i.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
  /**
   * Copy the picture currently represented by the deinterlacer.
   *
   * The WebGL drawing buffer is deliberately not preserved between browser
   * composites. Repeating the exact draw path of the presented picture before
   * `createImageBitmap` makes a snapshot reliable without imposing the
   * permanent cost of `preserveDrawingBuffer` on ordinary playback.
   */
  capture() {
    if (this.#m === "active" && this.#r.style.visibility === "visible" && this.#u) {
      const s = ++this.#Qt, r = new Promise((n, o) => {
        this.#Fe.set(s, { resolve: n, reject: o });
      });
      return this.#u.postMessage({
        type: "capture",
        id: s,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), r;
    }
    if (this.#m === "starting" || this.#m === "failed")
      return createImageBitmap(this.#e);
    const e = this.#h;
    if (this.#D && (!this.#T || this.#N || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#T || this.#N || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#wt(e.texture, e.flip, !1) : this.#ee(e.flush, e.second, null, !1);
    const t = this.#e.videoWidth, i = this.#e.videoHeight;
    return t > 0 && i > 0 && (t !== this.#t.width || i !== this.#t.height) ? createImageBitmap(this.#t, {
      resizeWidth: t,
      resizeHeight: i,
      resizeQuality: "high"
    }) : createImageBitmap(this.#t);
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #ve() {
    this.#D || !this.#T || this.#n.request(this.#si);
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #at() {
    const e = [];
    for (let t = 0; t < this.#e.buffered.length; t++)
      e.push({
        start: this.#e.buffered.start(t),
        end: this.#e.buffered.end(t)
      });
    return {
      currentTime: this.#e.currentTime,
      playbackRate: this.#e.playbackRate,
      seeking: this.#e.seeking,
      paused: this.#e.paused,
      ended: this.#e.ended,
      readyState: this.#e.readyState,
      videoWidth: this.#e.videoWidth,
      videoHeight: this.#e.videoHeight,
      buffered: e
    };
  }
  /** 転送中1枚と最新の待機1枚だけを保持し、音声時計からの遅延蓄積を防ぐ。 */
  #qt(e, t, i) {
    let s;
    try {
      s = i?.clone() ?? new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (n) {
      const o = n instanceof Error ? n.message : String(n);
      this.#$ === "auto" && !this.#Ne && !this.#Te ? (this.#We(), this.#He(e, t)) : this.#ke(o);
      return;
    }
    const r = {
      id: ++this.#$t,
      frame: s,
      now: e,
      metadata: t,
      video: this.#at()
    };
    if (this.#ye) {
      this.#ne?.frame.close(), this.#ne = r;
      return;
    }
    this.#St(r);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #St(e) {
    const t = this.#u;
    if (!t || this.#m !== "active") {
      e.frame.close();
      return;
    }
    this.#ye = !0;
    const i = {
      type: "frame",
      id: e.id,
      frame: e.frame,
      metadata: e.metadata,
      video: e.video
    };
    try {
      t.postMessage(i, [e.frame]);
    } catch (s) {
      this.#ye = !1, e.frame.close();
      const r = s instanceof Error ? s.message : String(s);
      this.#$ === "auto" && !this.#Ne && !this.#Te ? (this.#We(), this.#He(e.now, e.metadata)) : this.#ke(r);
    }
  }
  #Kt(e, t, i) {
    this.#de == null && (this.#de = ce(this.#i, "20px monospace")), fe(this.#de, e, t, i, this.#C, this.#z, 20);
  }
  #Pt(e) {
    if (this.#ae == null || this.#ce.length > 30)
      return;
    const t = this.#Oe.pop() ?? this.#i.createQuery();
    return this.#i.beginQuery(this.#ae.TIME_ELAPSED_EXT, t), this.#ce.push({ q: t, isField: e }), t;
  }
  #Xe(e) {
    this.#ae != null && (e != null && this.#i.endQuery(this.#ae.TIME_ELAPSED_EXT), this.#ce = this.#ce.filter(
      ({ q: t, isField: i }) => {
        if (this.#i.getQueryParameter(t, this.#i.QUERY_RESULT_AVAILABLE)) {
          const s = this.#i.getQueryParameter(t, this.#i.QUERY_RESULT);
          return i ? (this.#Se += s, this.#ue++) : (this.#_e += s, this.#le++), this.#Oe.push(t), !1;
        }
        return !0;
      }
    ));
  }
  #X() {
    this.#k = x, this.#Pe = x, this.#fe = 0, this.#Q = !1, this.#s?.reset();
  }
  /** Detect the pulldown phase of the frame being filtered on the GPU. */
  #Jt() {
    const { cur: e, next: t } = this.#Nt(!1), i = this.#o[e], s = this.#o[t];
    if (!i || !s) return;
    const r = this.#x?.topFieldFirst !== !1 ? 0 : 1;
    this.#s?.detect(i, s, r);
  }
  /**
   * Read back the previous frame's phase if it has arrived, and advance it
   * to the frame being filtered. The run is not advanced: only the GPU
   * counts observed frames.
   */
  #ei() {
    const e = this.#s?.poll() ?? null;
    e !== null && (this.#Pe = e, this.#fe = e.age), this.#fe++;
    const { phase: t, run: i } = this.#Pe;
    t === 0 || this.#fe > Math.ceil(I * Math.max(1, this.#e.playbackRate)) ? this.#k = x : this.#k = {
      phase: (t - 1 + this.#fe) % I + 1,
      run: i
    };
  }
  #ti(e) {
    const t = [], i = this.#s?.metrics ?? new Float32Array(0);
    for (let r = 0; r < p.phase; r++) {
      const n = i[r * 4] ?? 0, o = i[r * 4 + 1] ?? 0, a = i[r * 4 + 2] ?? 0;
      t.push(
        `${n.toFixed(3)},${o.toString().padStart(4)},${a.toFixed(3)}`
      );
    }
    const s = this.#ze.map((r, n) => `${n === 0 ? "-" : n}:${r}`).join(" ");
    return `frame=${e} phase=${this.#k.phase} run=${this.#k.run} known=${this.#Pe.phase}/${this.#Pe.run} age=${this.#fe} ${this.#Q ? "film" : "video"} period=${this.#w.toFixed(3)}
${t.join(" ")}
${s} dropped:${this.#st}`;
  }
  /**
   * A timestamp taken on `origin`'s clock, expressed on this realm's.
   *
   * `performance.timeOrigin` is defined against the same moment in every
   * realm, so the difference between two origins is the whole of the
   * conversion between their clocks (W3C HR-Time 1.2). The origins are
   * subtracted from one another before the timestamp is added: they are the
   * large numbers, their difference is not, and doing it the other way round
   * would spend the precision the schedule is measured in.
   */
  #ct(e, t) {
    const i = t - performance.timeOrigin;
    return Number.isFinite(i) && i !== 0 ? e + i : e;
  }
  /**
   * When this frame reaches the screen, on the clock this renderer draws by.
   *
   * requestVideoFrameCallback()'s display time is what holds the schedule on
   * the refresh grid, so it is preferred wherever it is usable -- including
   * across realms, since #localTime converts it exactly. It is not always
   * usable: 0 and NaN have both been reported, an origin may be missing, and
   * a time that cannot belong to this frame is worse than no time at all.
   * Those fall back to the moment the frame was taken in hand, which is this
   * renderer's own clock and always valid.
   */
  #ii(e, t) {
    const i = e.expectedDisplayTime;
    if (!Number.isFinite(i) || i <= 0 || !Number.isFinite(e.timeOrigin)) return t;
    const s = this.#ct(i, e.timeOrigin), r = Ge * Math.max(this.#y, this.#w);
    return s < t - r || s > t + r ? t : s;
  }
  #si = (e, t) => {
    if (!this.#T || this.#N) return;
    this.#mt();
    const i = this.#ct(e, t.timeOrigin);
    this.#Ie = i, this.#se = Math.max(
      this.#se,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    );
    const { frame: s, ...r } = t;
    this.#Ae = s ?? this.#e;
    try {
      this.#kt(i, r, s);
    } finally {
      this.#Ae = this.#e;
    }
    this.#ve();
  };
  /**
   * どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。
   * `now` はこの realm の時計で測った取込み時刻。
   */
  #kt(e, t, i) {
    if (this.#Le = t.mediaTime, this.#m === "active") {
      this.#qt(e, t, i);
      return;
    }
    this.#m !== "starting" && this.#He(e, t);
  }
  /**
   * @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。
   * `now` はこの Worker の時計で測った取込み時刻を渡す。metadata の表示予定
   * 時刻はページ側の時計のままでよく、同梱の timeOrigin から変換する。
   */
  ingestExternalFrame(e, t, i) {
    this.#Ae = i;
    try {
      this.#He(e, t);
    } finally {
      this.#Ae = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #He(e, t) {
    const i = this.#q;
    if (this.#H(i) && (this.#ri(t.mediaTime), !!this.#H(i) && t.width > 0 && t.height > 0)) {
      let s = !1;
      if (!this.#be && this.#e.seeking) {
        const l = this.#e.buffered, m = this.#w >= L ? this.#w / 1e3 : R / 1e3;
        for (let v = 0; v < l.length; v++)
          if (t.mediaTime >= l.start(v) && t.mediaTime < l.end(v) && Math.abs(t.mediaTime - this.#e.currentTime) <= m) {
            s = !0;
            break;
          }
      }
      if (s && (this.#be = !0), (this.#C === 0 || this.#z === 0) && this.#Gt(t.width, t.height), !this.#H(i)) return;
      if (this.#x && !this.#x.interlaced) {
        this.#li();
        return;
      }
      const r = t.mediaTime - this.#xe, n = t.mozTiming, o = s || (n ? n.discontinuity || r < 0 || r > H : r < 0 || r > H);
      o && (this.#b = 0, this.#w = 0, this.#P.discontinuities++, this.#F(), this.#X());
      const a = this.#ui(t.presentedFrames, o);
      if (this.#b > 0 && t.mediaTime === this.#xe && (!n || t.presentedFrames === this.#Ye))
        return;
      if (!o) {
        const l = n?.periodMs ?? 0;
        l > 0 ? this.#Ct(
          l * (this.#e.playbackRate || 1) / 1e3,
          1
        ) : this.#b > 0 && r > 0 && this.#Ct(r, a + 1);
      }
      this.#xe = t.mediaTime, this.#Ye = t.presentedFrames;
      const c = performance.now();
      c - this.#it > V && (this.#Ge = c, this.#K = 0, this.#De = 0, this.#Re = 0, this.#Me = 0, this.#he = 0, this.#ie = 0, this.#_e = 0, this.#le = 0, this.#Se = 0, this.#ue = 0), this.#it = c;
      const h = performance.now(), f = this.#Pt(!1);
      if (this.#Ut(), this.#M && !this.#J && !this.#s)
        try {
          this.#Rt();
        } catch (l) {
          this.#ht(
            `film detector unavailable: ${l instanceof Error ? l.message : String(l)}`
          );
        }
      if (!this.#H(i)) {
        this.#W || this.#Xe(f);
        return;
      }
      if (this.#M && !this.#J) {
        if (this.#b === w && a === 0)
          try {
            this.#ei(), this.#Jt();
          } catch (l) {
            this.#ht(
              `film detection failed: ${l instanceof Error ? l.message : String(l)}`
            );
          }
        else
          this.#X();
        this.#ze[this.#k.phase] = (this.#ze[this.#k.phase] ?? 0) + 1, this.#Q = this.#k.phase !== 0 && this.#k.run >= z, this.#O && (this.#bt = this.#ti(t.presentedFrames));
      }
      if (!this.#H(i)) {
        this.#W || this.#Xe(f);
        return;
      }
      const u = this.#ii(t, e) + this.#y;
      if (this.#Q)
        if (this.#Ve()) {
          const l = this.#k.phase;
          if (l === N)
            this.#st++, this.#te++;
          else {
            const m = this.#w * I / Oe, v = this.#ut(1, e, m), E = ze[l] ?? 0, k = v || this.#U === null ? u + m : u + E * this.#w;
            this.#$e(
              "film",
              !1,
              this.#lt("film", k, m),
              m
            );
          }
        } else
          this.#ee(!1, !1, null);
      else if (this.#S && this.#Ve()) {
        const l = this.#w / 2, v = this.#ut(2, e, l) || this.#U === null ? u + l * 2 : u, E = this.#lt("field", v, l);
        this.#$e("field", !1, E, l), this.#$e("field", !0, E + l, l);
      } else if (this.#Ve()) {
        const l = this.#w, v = this.#ut(1, e, l) || this.#U === null ? u + l : u;
        this.#$e(
          "frame",
          !1,
          this.#lt("frame", v, l),
          l
        ) || (this.#P.late++, this.#ee(!1, !1, null));
      } else
        this.#P.late += this.#A.length, this.#F(), this.#ee(!1, !1, null);
      this.#he = Math.max(
        this.#he,
        this.#A.length
      ), this.#Xe(f), this.#De += performance.now() - h, this.#K++, this.#fi(c);
    }
  }
  #H(e) {
    return !this.#W && this.#T && e === this.#q;
  }
  #ri(e) {
    const t = this.#q;
    let i;
    for (let n = this.#re.length - 1; n >= 0; n--) {
      const o = this.#re[n];
      if (o.start <= e + 1e-6) {
        i = o;
        break;
      }
    }
    if (i?.codedSize && (i.codedSize.width !== this.#C || i.codedSize.height !== this.#z) && this.#Gt(i.codedSize.width, i.codedSize.height), !this.#H(t)) return;
    const s = i?.scan;
    if (!s || this.#x?.interlaced === s.interlaced && this.#x.topFieldFirst === s.topFieldFirst)
      return;
    const r = this.#x?.interlaced;
    this.#x = s, this.#b = 0, this.#F(), this.#pe() && (r !== s.interlaced && (this.#w = 0), s.interlaced && (this.#D || this.#m === "main") ? this.#Ce() : this.#ft(), this.#X());
  }
  /**
   * Whether pictures are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #Ve() {
    return (this.#S || this.#M) && this.#w > 0 && this.#a.length === b;
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
  #Ct(e, t) {
    const s = e * 1e3 / (this.#e.playbackRate || 1) / t;
    s < L || s > R || (this.#w = this.#w > 0 && s > this.#w * Le ? this.#w + (s - this.#w) * Pe : s);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #$e(e, t, i, s) {
    const r = this.#Bt();
    if (r === null) return !1;
    const n = this.#a[r];
    if (!n) return !1;
    for (this.#v = r; this.#A.length > 0 && this.#A[0]?.slot === r; )
      this.#A.shift(), this.#P.late++;
    this.#ee(!1, t, n.framebuffer);
    const o = {
      slot: r,
      at: i,
      duration: s,
      cadence: e,
      phase: e === "film" ? this.#k.phase : e === "field" ? t ? 2 : 1 : 0,
      droppedBefore: this.#te
    };
    return this.#te = 0, this.#A.push(o), this.#U = o, !0;
  }
  /**
   * When a picture goes up: one duration after the last one of its cadence,
   * nudged towards `ideal` by a fraction of the gap so that the schedule
   * follows the clock without a picture ever moving across a refresh. It
   * restarts from `ideal` when the gap has grown to a whole picture or the
   * cadence has changed. (otya)
   */
  #lt(e, t, i) {
    if (!(i > 0)) return t;
    const s = this.#U;
    if (s !== null && s.cadence === e) {
      const r = s.at + s.duration, n = t - r;
      if (Math.abs(n) < i) {
        const o = Math.max(
          -Q,
          Math.min(Q, n * Ie)
        );
        return r + o;
      }
    }
    s !== null && this.#P.resynced++;
    for (let r = this.#A.at(-1); r && r.at >= t; )
      this.#A.pop(), this.#P.late++, r = this.#A.at(-1);
    return t;
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #ut(e, t, i) {
    const s = this.#A.at(-1), r = (G + 1) * Math.max(this.#y, i);
    if (s && s.at - t > r)
      return this.#F(), this.#P.queueResetted++, !0;
    const n = Math.max(
      0,
      this.#A.length + e - G
    );
    let o = 0, a = 0;
    for (; a < n; ) {
      const c = this.#A.shift();
      if (!c) break;
      o += c.duration, a++;
    }
    for (const c of this.#A) c.at -= o;
    return this.#P.late += a, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Bt() {
    const e = this.#h?.kind === "texture" ? this.#h.texture : null, t = new Set(this.#A.map(({ slot: s }) => s));
    for (let s = 1; s <= b; s++) {
      const r = (this.#v + s) % b, n = this.#a[r];
      if (n && n.texture !== e && !t.has(r))
        return r;
    }
    const i = this.#A[0];
    if (i) {
      const s = this.#a[i.slot];
      if (s && s.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #Ce() {
    this.#c === null && (!this.#T || this.#N || (this.#E = 0, this.#c = this.#Ee(this.#dt)));
  }
  #ft() {
    this.#Qe(this.#c), this.#c = null, this.#F();
  }
  #dt = (e) => {
    if (this.#c = null, !this.#T || this.#N) return;
    this.#Ai(e);
    const t = this.#q;
    this.#n.flush(e), this.#H(t) && (this.#m === "main" && this.#ai(this.#V, e), this.#c = this.#Ee(this.#dt));
  };
  /**
   * Fit a grid of refreshes (period and phase) to the animation frames. rAF
   * timestamps wander by a millisecond or so, which is more than the
   * nearest-refresh decision in #present can take; the grid is what it
   * compares against. A frame far off the grid restarts it. (otya)
   */
  #Ai(e) {
    const t = e - this.#E;
    this.#E = e;
    const i = Math.max(1, Math.round(t / this.#y)), s = this.#V + i * this.#y, r = e - s;
    if (this.#V === 0 || t <= 0 || t > R || Math.abs(r) > this.#y / 4) {
      t >= 1 && t <= R && (this.#y = t), this.#V = e;
      return;
    }
    this.#y += r / i * Ue, this.#V = s + r * Ne;
  }
  /**
   * Where animation frames come from, and the clock their timestamps carry.
   *
   * For Worker rendering it is the host the Worker entry supplied, whose
   * frames are already this realm's. Otherwise it is the window of the
   * document the canvas is in, which is the window that composites it -- and
   * which a document picture-in-picture window becomes by adopting the
   * element. The element is consulted as well, because the two move together
   * and either may be read first while a move is in progress.
   */
  #Lt() {
    const e = this.#D;
    if (e)
      return { frames: e, origin: performance.timeOrigin };
    const t = this.#r.ownerDocument?.defaultView ?? this.#e.ownerDocument?.defaultView ?? null;
    return t === null ? { frames: Xe, origin: performance.timeOrigin } : { frames: t, origin: t.performance.timeOrigin };
  }
  /**
   * Ask the current source for one frame, on this module's clock.
   *
   * An animation frame is timestamped against the clock of the window that
   * served it, and after an adoption that is not the clock the presentation
   * deadlines are on. The conversion belongs to the request rather than to
   * the callback: the source that was asked is the source that answers, so
   * the origin captured here is the right one however often the owner moves.
   */
  #Ee(e) {
    const { frames: t, origin: i } = this.#Lt(), s = t.requestAnimationFrame(
      (r) => e(this.#ct(r, i))
    );
    return { frames: t, handle: s };
  }
  /** 予約した表示機会を、それを発行した window 自身で取り消す。 */
  #Qe(e) {
    e?.frames.cancelAnimationFrame(e.handle);
  }
  /**
   * Follow the window that composites the canvas.
   *
   * A request already outstanding on the previous window is not merely late.
   * A window that has gone hidden serves no animation frames at all, so
   * waiting for that callback to notice the move waits for something that
   * will not happen; and cancelling it anywhere but on that same window
   * leaves it outstanding. Every other thing still being observed -- a frame
   * arriving, a layout, the old window saying it is going away -- re-points
   * both requests instead.
   *
   * Nothing queued moves: presentation deadlines are on this module's clock,
   * which no adoption changes. Only the refresh grid starts again, because a
   * grid describes one compositor and this is a different one.
   */
  #mt() {
    if (this.#D) return;
    this.#ni();
    const { frames: e } = this.#Lt(), t = this.#c !== null && this.#c.frames !== e, i = this.#R !== null && this.#R.frames !== e;
    !t && !i || (this.#E = 0, t && (this.#Qe(this.#c), this.#c = this.#Ee(this.#dt)), i && (this.#Qe(this.#R), this.#R = this.#Ee(this.#Et)));
  }
  /**
   * The one owner-change signal that does not need an animation frame.
   *
   * On Firefox the frames themselves are found by this module's own animation
   * frames (see VideoFrames), so a hidden window stops the acquisition that
   * would otherwise notice the move. A document going hidden is exactly when
   * its frames stop, and it is delivered as an ordinary task, so it arrives.
   * One listener, moved with the owner and dropped with the deinterlacer.
   */
  #ni() {
    const e = this.#D ? null : this.#r.ownerDocument ?? null;
    e !== this.#_ && (this.#_?.removeEventListener(
      "visibilitychange",
      this.#pt
    ), this.#_ = e, e?.addEventListener("visibilitychange", this.#pt));
  }
  #pt = () => {
    this.#W || this.#mt();
  };
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #vt() {
    this.#D || this.#R !== null || !this.#T || this.#N || (this.#R = this.#Ee(this.#Et));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #oi() {
    this.#Qe(this.#R), this.#R = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #Et = (e) => {
    if (this.#R = null, !this.#T || this.#N) return;
    const t = this.#q;
    this.#n.flush(e), this.#H(t) && (this.#hi(e), this.#H(t) && (this.#R = this.#Ee(this.#Et)));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #hi(e) {
    if (this.#D || this.#n.captureDriven || this.#n.mozDriven && this.#n.hasDelivered || e - this.#Ie < $ || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#w >= L ? this.#w : Ce;
    (i > 0 ? i > this.#se : t !== this.#Le && e - this.#je >= s * 0.75) && (e - this.#xt >= $ && (this.#xt = e, this.#n.cancel(), this.#ve()), this.#se = Math.max(
      this.#se,
      i
    ), this.#je = e, this.#kt(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#oe + 1, i),
      // The fallback has no compositor timestamp. The animation frame that
      // found the picture is the best stand-in, and it was taken on this
      // realm's clock -- the same one #displayTime converts towards, so it
      // passes through unchanged.
      expectedDisplayTime: e,
      timeOrigin: performance.timeOrigin,
      width: this.#e.videoWidth,
      height: this.#e.videoHeight
    }));
  }
  /**
   * Put up whichever filtered field belongs on the screen next.
   *
   * What is drawn during an animation frame reaches the screen at the composite
   * after it, so that is the moment being filled, and a field goes up at
   * whichever composite falls nearest the moment it stands for -- half a
   * refresh either side of it. Where two of them have come due since the last
   * one, only the newer is shown: a screen has one picture per refresh, and
   * the older of the two is a moment the viewer should already be past.
   *
   * Near the half-refresh boundary a picture goes the way the last one went,
   * so that the slip a cadence the refresh does not divide into must make
   * every so often happens once rather than flapping.
   */
  #ai(e, t) {
    const i = this.#y / 2, s = (a) => {
      const c = a.at - e;
      return c <= i - Z ? !0 : c > i + Z ? !1 : this.#we > 0;
    };
    for (; this.#A[1] && s(this.#A[1]); )
      this.#P.late++, this.#A.shift();
    const r = this.#A[0];
    if (!r || !s(r)) return;
    this.#A.shift(), this.#we = r.at - e;
    const n = performance.now(), o = this.#Pt(!0);
    this.#It(r.slot), this.#Xe(o), this.#Me += performance.now() - n, this.#Re++, this.#O && this.#ci(r, t), this.#L = t;
  }
  /** Preserve upstream's opt-in presentation timing log in either renderer. */
  #ci(e, t) {
    const i = this.#L === 0 ? 0 : t - this.#L, s = i / this.#y, r = e.cadence === "film" ? `phase ${e.phase}` : e.cadence === "field" ? `field ${e.phase}` : "frame", n = e.phase === 0 ? "duplicate" : `phase ${N}`, o = e.droppedBefore > 0 ? `, ${n} dropped before it` + (e.droppedBefore > 1 ? ` (${e.droppedBefore})` : "") : "";
    console.log(
      `yadif: +${i.toFixed(2)} ms (${s.toFixed(2)} refreshes) ${e.cadence} ${r}, due ${(e.at - t).toFixed(2)} ms${o}`
    );
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #It(e) {
    const t = this.#a[e];
    t && this.#wt(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #li() {
    this.#Ut();
    const e = this.#o[this.#B];
    e && this.#wt(e, !0), this.#b = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #Y(e) {
    if (this.#D) {
      this.#D.onVisibility(e);
      return;
    }
    this.#r.style.visibility = e ? "visible" : "hidden";
  }
  #wt(e, t = !1, i = !0) {
    const s = this.#i;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#p), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#d, 0), s.uniform1i(this.#g, t ? 1 : 0), s.viewport(0, 0, this.#C, this.#z), s.drawArrays(s.TRIANGLES, 0, 3), this.#h = { kind: "texture", texture: e, flip: t }, this.#Y(!0), i && this.#ie++;
  }
  /**
   * Account for the frames between this one and the last one seen.
   *
   * There is no event for a frame the callback was not run for; the only sign
   * of one is that the count of frames the compositor has taken went up by
   * more than one. Frames thrown away either side of a discontinuity are not
   * counted: the held frames were being dropped anyway, and a seek presents
   * what it passes over.
   *
   * Returns how many frames were missed between the last one and this one.
   */
  #ui(e, t) {
    let i = 0;
    return this.#oe !== 0 && !t && (i = Math.max(0, e - this.#oe - 1), this.#P.missed += i), this.#oe = e, i;
  }
  #fi(e) {
    const t = e - this.#Ge;
    if (t < V) return;
    const i = this.#Ve() && (this.#S || this.#Q) ? this.#Re : this.#K, s = this.#K ? (this.#De + this.#Me) / this.#K : 0;
    let r;
    this.#ae != null && (r = 0, this.#le !== 0 && (r += this.#_e / 1e6 / this.#le), this.#ue !== 0 && (r += this.#Se / 1e6 / this.#ue / 2));
    const n = {
      ...this.#P,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: s,
      maxQueuedFields: this.#he,
      outputFps: this.#ie * 1e3 / t,
      gpuMs: r,
      film: this.#Q,
      filmError: this.#J
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: n })), this.#qe?.(n), this.#Ge = e, this.#K = 0, this.#De = 0, this.#Re = 0, this.#Me = 0, this.#he = 0, this.#ie = 0, this.#_e = 0, this.#le = 0, this.#Se = 0, this.#ue = 0;
  }
  /** Take the newest frame into the ring. */
  #Ut() {
    const e = this.#i;
    this.#B = (this.#B + 1) % w, e.bindTexture(e.TEXTURE_2D, this.#o[this.#B] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#Ae
    ), this.#b = Math.min(this.#b + 1, w);
  }
  /**
   * Filter one frame, onto the canvas or into an output texture.
   *
   * A null `target` is the canvas itself, which is where the picture goes when
   * there is one per frame and nothing to schedule. An output framebuffer is a
   * field being kept for its moment.
   *
   * `second` asks for the frame's other field: the same three frames filtered
   * the other way round, keeping the field that came second and rebuilding
   * the first. The shader takes the pair of frames the missing line sits
   * between from the parity, so this is the whole of it.
   *
   * With `film` on, the shader is also given the field metrics, and puts a
   * film frame back together rather than filtering it.
   */
  #ee(e, t, i, s = !0) {
    if (this.#b === 0 || this.#N) return;
    s && (this.#b === w && !e ? this.#P.filtered++ : this.#P.degraded++);
    const r = this.#i, { prev: n, cur: o, next: a } = this.#Nt(e);
    r.bindFramebuffer(r.FRAMEBUFFER, i), r.useProgram(this.#f);
    for (const [d, u] of [n, o, a].entries())
      r.activeTexture(r.TEXTURE0 + d), r.bindTexture(r.TEXTURE_2D, this.#o[u] ?? null);
    r.uniform1i(this.#l.prev, 0), r.uniform1i(this.#l.cur, 1), r.uniform1i(this.#l.next, 2);
    const c = this.#M ? this.#s?.texture ?? null : null, h = c !== null;
    c !== null && (r.activeTexture(r.TEXTURE0 + 3), r.bindTexture(r.TEXTURE_2D, c), r.uniform1i(this.#l.fieldMetrics, 3)), r.uniform2i(this.#l.size, this.#C, this.#z);
    const f = this.#Tt ? 0 : 1;
    r.uniform1i(this.#l.parity, t ? 1 - f : f), r.uniform1i(this.#l.tff, this.#Tt ? 1 : 0), r.uniform1i(this.#l.second, t ? 1 : 0), r.uniform1i(this.#l.spatialCheck, this.#G ? 1 : 0), r.uniform1i(this.#l.debug, this.#O ? 1 : 0), r.uniform1i(this.#l.film, h ? 1 : 0), r.uniform1i(this.#l.phase, this.#k.phase), r.viewport(0, 0, this.#C, this.#z), r.drawArrays(r.TRIANGLES, 0, 3), this.#O && h && this.#Kt(this.#bt, 0, 90), i === null && (this.#h = { kind: "yadif", flush: e, second: t }, this.#Y(!0), s && this.#ie++);
  }
  #Nt(e) {
    const t = (i) => (this.#B + w - i) % w;
    return this.#b === 1 ? { prev: this.#B, cur: this.#B, next: this.#B } : e ? { prev: t(1), cur: this.#B, next: this.#B } : this.#b === 2 ? { prev: t(1), cur: t(1), next: this.#B } : { prev: t(2), cur: t(1), next: this.#B };
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
  #Ze() {
    if (this.#mt(), !this.#I) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const s = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), r = t * s, n = i * s;
    this.#r.style.left = `${e.offsetLeft + (e.offsetWidth - r) / 2}px`, this.#r.style.top = `${e.offsetTop + (e.offsetHeight - n) / 2}px`, this.#r.style.width = `${r}px`, this.#r.style.height = `${n}px`;
  }
  #Gt(e, t) {
    const i = this.#i;
    this.#t.width = e, this.#t.height = t, this.#C = e, this.#z = t, this.#b = 0, this.#h = null, this.#F(), this.#Ze();
    for (const s of this.#o) i.deleteTexture(s);
    this.#o = [];
    for (let s = 0; s < w; s++) {
      const r = i.createTexture();
      i.bindTexture(i.TEXTURE_2D, r), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MIN_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MAG_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_S, i.CLAMP_TO_EDGE), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_T, i.CLAMP_TO_EDGE), i.texImage2D(
        i.TEXTURE_2D,
        0,
        i.RGBA,
        e,
        t,
        0,
        i.RGBA,
        i.UNSIGNED_BYTE,
        null
      ), this.#o.push(r);
    }
    this.#Be(), (this.#S || this.#M) && this.#Ot(), this.#s?.resize(e, t), this.#pe();
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
  #Ot() {
    const e = this.#i;
    if (!(this.#a.length === b || this.#C === 0)) {
      this.#Be();
      for (let t = 0; t < b; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#C,
          this.#z,
          0,
          e.RGBA,
          e.UNSIGNED_BYTE,
          null
        );
        const s = e.createFramebuffer();
        e.bindFramebuffer(e.FRAMEBUFFER, s), e.framebufferTexture2D(
          e.FRAMEBUFFER,
          e.COLOR_ATTACHMENT0,
          e.TEXTURE_2D,
          i,
          0
        );
        const r = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
        if (e.bindFramebuffer(e.FRAMEBUFFER, null), !r) {
          e.deleteFramebuffer(s), e.deleteTexture(i), this.#Be();
          return;
        }
        this.#a.push({ texture: i, framebuffer: s });
      }
      this.#v = b - 1;
    }
  }
  #Be() {
    const e = this.#i, t = this.#h?.kind === "texture" ? this.#h.texture : null;
    this.#a.some((i) => i.texture === t) && (this.#h = null);
    for (const { texture: i, framebuffer: s } of this.#a)
      e.deleteFramebuffer(s), e.deleteTexture(i);
    this.#a = [], this.#F();
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #di() {
    if (this.#I) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#r), this.#I = t, this.#ge?.observe(this.#e), this.#Ze();
  }
  #mi() {
    if (this.#D) return;
    const e = this.#I;
    this.#I = null, this.#ge?.disconnect(), this.#r.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #zt = () => this.#Ze();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #gt(e) {
    return !this.#u || this.#m === "main" ? !1 : (this.#u.postMessage({
      type: "event",
      name: e,
      video: this.#at()
    }), !0);
  }
  #Wt = () => {
    if (this.#Le = Number.NaN, this.#gt("emptied")) {
      this.#Z(), this.#Y(!1);
      return;
    }
    this.#b = 0, this.#xe = 0, this.#Ye = 0, this.#F(), this.#X(), this.#w = 0, this.#Xt(), this.#h = null, this.#Y(!1);
  };
  #Xt() {
    this.#P = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      resynced: 0,
      late: 0,
      queueResetted: 0
    }, this.#ze.fill(0), this.#st = 0, this.#oe = 0, this.#Ge = 0, this.#it = 0, this.#K = 0, this.#De = 0, this.#Re = 0, this.#Me = 0, this.#he = 0, this.#ie = 0, this.#F(), this.#_e = 0, this.#le = 0, this.#Se = 0, this.#ue = 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #Ht = () => {
    if (this.#gt("seeking")) {
      this.#Z();
      return;
    }
    this.#be = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #j = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#gt(e.type)) {
      this.#Z();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#be;
      if (this.#be = !1, i) return;
      this.#b = 0, this.#F(), this.#X(), this.#h = null, this.#Y(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#w = 0, this.#xe = this.#e.currentTime), this.#F(), this.#T && this.#b > 0) {
      const i = this.#Bt(), s = i === null ? void 0 : this.#a[i];
      i !== null && s ? (this.#v = i, this.#ee(!0, !1, s.framebuffer), this.#It(i)) : this.#ee(!0, !1, null);
    }
    t && (this.#b = 0, this.#oe = 0, this.#X());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Vt = (e) => {
    if (e.preventDefault(), this.#D) {
      this.#D.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#m !== "active" && (this.#N = !0, this.#ot("the deinterlacer WebGL context was lost"), this.stop());
  };
}
function Y(A, e) {
  const t = A.createProgram(), i = j(A, A.VERTEX_SHADER, Be), s = j(A, A.FRAGMENT_SHADER, e);
  if (A.attachShader(t, i), A.attachShader(t, s), A.linkProgram(t), A.deleteShader(i), A.deleteShader(s), !A.getProgramParameter(t, A.LINK_STATUS)) {
    const r = A.getProgramInfoLog(t);
    throw A.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${r ?? "no reason given"}`
    );
  }
  return t;
}
function j(A, e, t) {
  const i = A.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (A.shaderSource(i, t), A.compileShader(i), !A.getShaderParameter(i, A.COMPILE_STATUS)) {
    const s = A.getShaderInfoLog(i);
    throw A.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return i;
}
const q = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", He = 0.5, Ve = 3e3, K = 0.1, y = 16, J = 'video/mp4; codecs="avc1.640029"';
let O = null;
function $e(A = {}) {
  return O ??= Qe(A), O;
}
async function et(A = {}) {
  return (await $e(A)).deinterlaces;
}
function tt() {
  O = null;
}
async function Qe(A) {
  const e = A.tolerance ?? He, t = A.timeoutMs ?? Ve, i = performance.now(), s = (o) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: o instanceof Error ? o.message : String(o)
  });
  if (typeof document > "u")
    return s(new Error("there is no document to decode in"));
  const r = document.createElement("video");
  r.muted = !0, r.defaultMuted = !0, r.playsInline = !0, r.preload = "auto";
  let n = null;
  try {
    n = Ye(r, t);
    const o = P(S(r, "loadeddata"), t), a = r.play().then(
      () => !0,
      () => !1
    );
    if (await n.ready, await o, await je(r, t, await a), r.videoWidth === 0 || r.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const c = qe(r);
    return {
      deinterlaces: c < 1 - e,
      survives: c,
      tookMs: performance.now() - i
    };
  } catch (o) {
    return s(o);
  } finally {
    r.pause(), r.removeAttribute("src"), r.replaceChildren(), r.load(), n && URL.revokeObjectURL(n.url);
  }
}
const U = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Ze = typeof MediaSource > "u";
function Ye(A, e) {
  if (!U || !U.isTypeSupported(J))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = q.indexOf(","), i = atob(q.slice(t + 1)), s = new Uint8Array(i.length);
  for (let a = 0; a < i.length; a++) s[a] = i.charCodeAt(a);
  const r = new U(), n = URL.createObjectURL(r);
  if (Ze) {
    A.disableRemotePlayback = !0;
    const a = document.createElement("source");
    a.type = "video/mp4", a.src = n, A.append(a), A.load();
  } else
    A.src = n;
  const o = (async () => {
    await P(S(r, "sourceopen"), e);
    const a = r.addSourceBuffer(J), c = P(S(a, "updateend"), e);
    a.appendBuffer(s), await c, r.endOfStream();
  })();
  return { url: n, ready: o };
}
async function je(A, e, t) {
  if (t) {
    const i = performance.now();
    for (; A.currentTime < K && performance.now() - i < e; )
      await new Promise((s) => requestAnimationFrame(s));
    A.pause();
  } else
    A.currentTime = K, await P(S(A, "seeked"), e);
}
function qe(A) {
  const e = A.videoHeight, t = document.createElement("canvas");
  t.width = y, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(A, 0, 0, y, e);
  const s = i.getImageData(0, 0, y, e).data, r = (h) => {
    let f = 0;
    for (let d = 0; d < y; d++)
      f += s[(h * y + d) * 4 + 1] ?? 0;
    return f / y;
  };
  let n = 0;
  const o = 2, a = e - 3;
  let c = r(o);
  for (let h = o + 1; h <= a; h++) {
    const f = r(h);
    n += Math.abs(f - c), c = f;
  }
  return n / (a - o) / 255;
}
function S(A, e) {
  return new Promise((t, i) => {
    A.addEventListener(e, () => t(), { once: !0 }), A.addEventListener(
      "error",
      () => {
        const s = A instanceof HTMLMediaElement ? A.error : null, r = s ? ` (MediaError ${s.code}${s.message ? `: ${s.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${r}`));
      },
      { once: !0 }
    );
  });
}
function P(A, e) {
  return Promise.race([
    A,
    new Promise(
      (t, i) => setTimeout(
        () => i(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
Se(oe);
export {
  Je as Deinterlacer,
  be as YADIF_FRAGMENT_SHADER,
  xe as YADIF_UNIFORMS,
  et as decoderDeinterlaces,
  tt as forgetDecoderProbe,
  $e as probeDecoder,
  Ke as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
