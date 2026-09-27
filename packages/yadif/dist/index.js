const he = "" + new URL("assets/worker-CtAAwC8Z.js", import.meta.url).href, S = `#version 300 es
void main() {
  // From the vertex index alone. There is no geometry here worth a buffer.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;
function R(n, e, t) {
  const i = n.createProgram(), s = W(n, n.VERTEX_SHADER, t), r = W(n, n.FRAGMENT_SHADER, e);
  if (n.attachShader(i, s), n.attachShader(i, r), n.linkProgram(i), n.deleteShader(s), n.deleteShader(r), !n.getProgramParameter(i, n.LINK_STATUS)) {
    const A = n.getProgramInfoLog(i);
    throw n.deleteProgram(i), new Error(
      `the deinterlacer failed to link: ${A ?? "no reason given"}`
    );
  }
  return i;
}
function W(n, e, t) {
  const i = n.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (n.shaderSource(i, t), n.compileShader(i), !n.getShaderParameter(i, n.COMPILE_STATUS)) {
    const s = n.getShaderInfoLog(i);
    throw n.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return i;
}
const ae = `#version 300 es
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
`, le = `#version 300 es
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
function ce(n, e) {
  const t = R(n, ae, le), i = n.getAttribLocation(t, "aVertexPosition"), s = n.getAttribLocation(t, "aTextureCoord"), r = n.getUniformLocation(t, "uTexture"), A = n.getUniformLocation(t, "uMatrix"), o = n.getUniformLocation(t, "uUvMatrix"), a = n.getUniformLocation(t, "uTextColor"), c = n.getUniformLocation(t, "uBackColor");
  if (r == null || A == null || o == null || a == null || c == null)
    throw new Error(
      "failed to initialize DEBUG_FRAGMENT_SHADER, DEBUG_VERTEX_SHADER"
    );
  const h = n.createBuffer(), f = n.createBuffer();
  return {
    gl: n,
    ...ue(n, e),
    program: t,
    programUniforms: {
      vertex: i,
      textureCoord: s,
      texture: r,
      matrix: A,
      uvMatrix: o,
      textColor: a,
      backColor: c
    },
    positionBuffer: h,
    textureBuffer: f
  };
}
function ue(n, e) {
  const t = new OffscreenCanvas(0, 0), i = t.getContext("2d"), s = /* @__PURE__ */ new Map();
  let r = 0;
  const A = 0;
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
      y: A,
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
  const a = n.createTexture();
  return n.bindTexture(n.TEXTURE_2D, a), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MIN_FILTER, n.LINEAR), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MAG_FILTER, n.LINEAR), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_WRAP_S, n.CLAMP_TO_EDGE), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_WRAP_T, n.CLAMP_TO_EDGE), n.texImage2D(n.TEXTURE_2D, 0, n.RGBA, n.RGBA, n.UNSIGNED_BYTE, t), { fontTexture: a, chars: s, textureSize: { width: r, height: o } };
}
function fe(n) {
  const e = n.gl;
  e.deleteBuffer(n.positionBuffer), e.deleteBuffer(n.textureBuffer), e.deleteTexture(n.fontTexture), e.deleteProgram(n.program);
}
function de(n, e, t, i, s, r, A) {
  const o = [], a = [], c = t;
  for (const d of e) {
    if (d === `
`) {
      t = c, i += A;
      continue;
    }
    const u = n.chars.get(d);
    if (u == null)
      continue;
    if (u.width === 1) {
      t += u.metrics.width;
      continue;
    }
    const l = Math.floor(t - u.metrics.actualBoundingBoxLeft), m = Math.floor(i - u.metrics.actualBoundingBoxAscent), v = l + u.width, E = m + u.height;
    o.push(l, m), a.push(u.x, u.y), o.push(l, E), a.push(u.x, u.y + u.height), o.push(l + u.width, E), a.push(u.x + u.width, u.y + u.height), o.push(v, E), a.push(u.x + u.width, u.y + u.height), o.push(l, m), a.push(u.x, u.y), o.push(v, m), a.push(u.x + u.width, u.y), t += u.metrics.width;
  }
  const h = n.gl;
  h.useProgram(n.program), h.bindBuffer(h.ARRAY_BUFFER, n.positionBuffer), h.bufferData(h.ARRAY_BUFFER, new Float32Array(o), h.STATIC_DRAW), h.vertexAttribPointer(
    n.programUniforms.vertex,
    2,
    h.FLOAT,
    !1,
    0,
    0
  ), h.enableVertexAttribArray(n.programUniforms.vertex), h.bindBuffer(h.ARRAY_BUFFER, n.textureBuffer), h.bufferData(
    h.ARRAY_BUFFER,
    new Float32Array(a),
    h.STATIC_DRAW
  ), h.vertexAttribPointer(
    n.programUniforms.textureCoord,
    2,
    h.FLOAT,
    !1,
    0,
    0
  ), h.enableVertexAttribArray(n.programUniforms.textureCoord), h.activeTexture(h.TEXTURE0), h.bindTexture(h.TEXTURE_2D, n.fontTexture), h.uniform1i(n.programUniforms.texture, 0), h.uniform3fv(n.programUniforms.textColor, [1, 1, 1]), h.uniform3fv(n.programUniforms.backColor, [0, 0, 0]);
  function f(d, u, l) {
    const m = [];
    for (let v = 0; v < u; v++)
      for (let E = 0; E < d; E++)
        m.push(l[E * d + v]);
    return m;
  }
  h.uniformMatrix4fv(n.programUniforms.matrix, !1, f(4, 4, [
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
  ])), h.uniformMatrix3fv(n.programUniforms.uvMatrix, !1, f(3, 3, [
    1 / n.textureSize.width,
    0,
    0,
    0,
    1 / n.textureSize.height,
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
}, b = 7, te = 2, O = 1, me = 2, X = 10, pe = {
  a: "uA",
  b: "uB",
  fieldMetrics: "uFieldMetrics",
  first: "uFirst",
  size: "uSize"
}, ie = 16, se = 8, ve = `#version 300 es

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
  const int BLOCK_W = ${ie};
  const int BLOCK_H = ${se};

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
`, Ee = {
  second: "uSecond",
  first: "uFirst",
  size: "uSize"
}, _ = 8, we = `#version 300 es
precision highp float;

uniform sampler2D uSecond;
uniform sampler2D uFirst;

uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

void main()
{
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 base = dst * ${_};

  vec4 second = vec4(0.0);
  vec4 first = vec4(0.0);

  for (int y = 0; y < ${_}; ++y) {
    for (int x = 0; x < ${_}; ++x) {
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
`, be = {
  previous: "uPrevious",
  second: "uSecond",
  first: "uFirst",
  size: "uSize"
}, xe = `#version 300 es
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
  return differing <= ${te}.0;
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
  bool believed = run >= ${X}.0;
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
`, T = 16, ge = 8, ye = {
  prev: "uPrev",
  cur: "uCur",
  first: "uFirst",
  size: "uSize"
}, Te = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
/** The parity of the lines of the field captured first. */
uniform int uFirst;
uniform ivec2 uSize;

out vec4 outValue;

const float COMB = 8.0 / 255.0;

float luma(sampler2D image, int x, int y) {
  int line = y < 0 ? -y : (y >= uSize.y ? 2 * (uSize.y - 1) - y : y);
  vec3 c = texelFetch(image, ivec2(x, clamp(line, 0, uSize.y - 1)), 0).rgb;
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

bool combed(float above2, float above, float pixel, float below, float below2) {
  float d1 = pixel - above;
  float d2 = pixel - below;
  return ((d1 > COMB && d2 > COMB) || (d1 < -COMB && d2 < -COMB)) &&
    abs(above2 + 4.0 * pixel + below2 - 3.0 * (above + below)) > 6.0 * COMB;
}

void main() {
  // Block rows count from the top of the frame, as the filter reads them.
  ivec2 block = ivec2(gl_FragCoord.xy);
  ivec2 base = block * ${T};
  float standing = 0.0;
  float woven = 0.0;
  for (int dy = 0; dy < ${T}; ++dy) {
    int y = base.y + dy;
    if (y >= uSize.y || (y & 1) == uFirst) continue;
    for (int dx = 0; dx < ${T}; ++dx) {
      int x = base.x + dx;
      if (x >= uSize.x) break;
      float current = luma(uCur, x, y);
      float previous = luma(uPrev, x, y);
      if (abs(current - previous) <= COMB) continue;
      // The first field's lines either side are the same whichever second
      // field is woven between them.
      float above = luma(uCur, x, y - 1);
      float below = luma(uCur, x, y + 1);
      if (combed(luma(uCur, x, y - 2), above, current, below, luma(uCur, x, y + 2)))
        standing += 1.0;
      if (combed(luma(uPrev, x, y - 2), above, previous, below, luma(uPrev, x, y + 2)))
        woven += 1.0;
    }
  }
  outValue = vec4(standing, woven, 0.0, 0.0);
}
`, Fe = {
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
  fieldMetrics: "uFieldMetrics",
  comb: "uComb"
}, De = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uNext;
uniform sampler2D uFieldMetrics;
uniform sampler2D uComb;
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
  return texelFetch(uFieldMetrics, ivec2(metric, 0), 0)[1] <= ${te}.0;
}

/** The pulldown phase the detection gave this frame, or 0. See film-shader.ts. */
int detectedPhase() {
  vec4 phase = texelFetch(uFieldMetrics, ivec2(${p.phase}, 0), 0);
  // Deinterlace each field normally until the cadence is confirmed.
  return phase[1] >= ${X}.0 ? int(phase[0]) : 0;
}

bool isMixedPhase(int phase) {
  return phase == ${O} || phase == ${me};
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
    // A block the weave would leave combed -- a cut, a fade or a telop that
    // does not follow the cadence -- is filtered like video instead.
    vec4 comb = texelFetch(uComb, ivec2(x / ${T}, y / ${T}), 0);
    bool combedBlock = (mixed ? comb[1] : comb[0]) > ${ge}.0;
    if ((y & 1) != uParity &&
        (combedBlock || (detectedPhase() == 4 && movingComb(rgb, x, y))))
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
function C(n, e, t) {
  return Object.fromEntries(
    Object.entries(t).map(([i, s]) => [
      i,
      n.getUniformLocation(e, s)
    ])
  );
}
class V {
  #t;
  #n;
  #e;
  #o;
  #i;
  #s;
  #m;
  #u;
  #x;
  /** The block comparisons of both fields, and the same folded most of the way. */
  #E = null;
  #y = null;
  /** Combed pixels per block of the frame being filtered, both ways of weaving it. */
  #h = null;
  /** The field metrics (see FIELD_METRICS) of this frame and the one before. */
  #a = null;
  /** Which of the two holds the newest metrics. */
  #f = 0;
  /** The metrics being read back asynchronously. */
  #A = null;
  #r = null;
  #l = 0;
  #_ = 0;
  /** The last metrics read back, laid out as FIELD_METRICS says. */
  metrics = new Float32Array(b * 4);
  #p = 0;
  #w = 0;
  constructor(e) {
    this.#t = e, this.#n = R(
      e,
      ve,
      S
    ), this.#e = C(
      e,
      this.#n,
      pe
    ), this.#o = R(
      e,
      we,
      S
    ), this.#i = C(
      e,
      this.#o,
      Ee
    ), this.#s = R(
      e,
      xe,
      S
    ), this.#m = C(e, this.#s, be), this.#u = R(e, Te, S), this.#x = C(e, this.#u, ye);
  }
  /** The newest measurements, or null before any frame has been measured. */
  get texture() {
    return this.#a?.[this.#f]?.textures[0] ?? null;
  }
  /**
   * Combed pixels per block of the frame last measured by `measureComb`, or
   * null before one has been. See COMB_FRAGMENT_SHADER.
   */
  get combTexture() {
    return this.#h?.textures[0] ?? null;
  }
  /** The size of the frames to be measured, which sizes the block grid. */
  resize(e, t) {
    e === this.#p && t === this.#w || (this.#p = e, this.#w = t, this.#k());
  }
  /** Forget every measurement: the next frame starts a cycle from nothing. */
  reset() {
    const e = this.#t;
    e.deleteSync(this.#r), this.#r = null, this.#l = 0;
    const t = this.#a?.[this.#f];
    if (!t) return;
    const i = new Float32Array(b * 4);
    for (let s = 0; s < p.phase; s++)
      i[s * 4 + 1] = 1;
    e.bindTexture(e.TEXTURE_2D, t.textures[0] ?? null), e.texSubImage2D(
      e.TEXTURE_2D,
      0,
      0,
      0,
      b,
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
    if (this.#p === 0 || this.#w === 0) return;
    this.#$();
    const r = this.#E, A = this.#y, o = this.#a;
    if (r === null || A === null || o === null) return;
    const a = o[this.#f], c = o[1 - this.#f];
    if (s.bindFramebuffer(s.FRAMEBUFFER, r.framebuffer), s.useProgram(this.#n), this.#c(0, e, this.#e.a), this.#c(1, t, this.#e.b), this.#c(2, a.textures[0], this.#e.fieldMetrics), s.uniform1i(this.#e.first, i), s.uniform2i(this.#e.size, this.#p, this.#w), s.viewport(0, 0, r.width, r.height), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, A.framebuffer), s.useProgram(this.#o), this.#c(0, r.textures[0], this.#i.second), this.#c(1, r.textures[1], this.#i.first), s.uniform2i(this.#i.size, r.width, r.height), s.viewport(0, 0, A.width, A.height), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, c.framebuffer), s.useProgram(this.#s), this.#c(0, a.textures[0], this.#m.previous), this.#c(1, A.textures[0], this.#m.second), this.#c(2, A.textures[1], this.#m.first), s.uniform2i(this.#m.size, A.width, A.height), s.viewport(0, 0, b, 1), s.drawArrays(s.TRIANGLES, 0, 3), this.#f = 1 - this.#f, this.#l++, this.#r !== null) {
      s.bindFramebuffer(s.FRAMEBUFFER, null);
      return;
    }
    this.#_ = this.#l, s.bindBuffer(s.PIXEL_PACK_BUFFER, this.#A), s.readPixels(0, 0, b, 1, s.RGBA, s.FLOAT, 0), s.bindBuffer(s.PIXEL_PACK_BUFFER, null), s.bindFramebuffer(s.FRAMEBUFFER, null), this.#r = s.fenceSync(s.SYNC_GPU_COMMANDS_COMPLETE, 0), s.flush();
  }
  /**
   * Count the combing each way of weaving `cur`, the frame being filtered,
   * would leave: as it stands, and with `prev`'s second field. `first` is the
   * parity of the field that was captured first.
   */
  measureComb(e, t, i) {
    const s = this.#t;
    if (this.#p === 0 || this.#w === 0) return;
    this.#$();
    const r = this.#h;
    r !== null && (s.bindFramebuffer(s.FRAMEBUFFER, r.framebuffer), s.useProgram(this.#u), this.#c(0, e, this.#x.prev), this.#c(1, t, this.#x.cur), s.uniform1i(this.#x.first, i), s.uniform2i(this.#x.size, this.#p, this.#w), s.viewport(0, 0, r.width, r.height), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, null));
  }
  /**
   * The phase of the last frame measured, once the GPU has handed it back,
   * and null while it is still on its way. It is handed back once.
   */
  poll() {
    const e = this.#t, t = this.#r;
    if (t === null || this.#A === null) return null;
    switch (e.clientWaitSync(t, 0, 0)) {
      case e.ALREADY_SIGNALED:
      case e.CONDITION_SATISFIED:
        return e.bindBuffer(e.PIXEL_PACK_BUFFER, this.#A), e.getBufferSubData(e.PIXEL_PACK_BUFFER, 0, this.metrics), e.bindBuffer(e.PIXEL_PACK_BUFFER, null), e.deleteSync(t), this.#r = null, {
          phase: this.metrics[p.phase * 4] ?? 0,
          run: this.metrics[p.phase * 4 + 1] ?? 0,
          age: this.#l - this.#_
        };
      default:
        return null;
    }
  }
  destroy() {
    const e = this.#t;
    if (this.#k(), this.#a !== null) {
      for (const t of this.#a) M(e, t);
      this.#a = null;
    }
    e.deleteSync(this.#r), this.#r = null, e.deleteBuffer(this.#A), this.#A = null, e.deleteProgram(this.#n), e.deleteProgram(this.#o), e.deleteProgram(this.#s), e.deleteProgram(this.#u);
  }
  #c(e, t, i) {
    const s = this.#t;
    s.activeTexture(s.TEXTURE0 + e), s.bindTexture(s.TEXTURE_2D, t ?? null), s.uniform1i(i, e);
  }
  #k() {
    const e = this.#t;
    this.#E !== null && M(e, this.#E), this.#y !== null && M(e, this.#y), this.#h !== null && M(e, this.#h), this.#E = null, this.#y = null, this.#h = null;
  }
  /** Everything detect needs that is not there yet. */
  #$() {
    const e = this.#t;
    if (this.#E === null || this.#y === null || this.#h === null) {
      this.#k();
      const t = Math.ceil(this.#p / ie), i = Math.ceil(this.#w / (se * 2));
      this.#E = D(e, t, i, 2), this.#y = D(
        e,
        Math.ceil(t / _),
        Math.ceil(i / _),
        2
      ), this.#h = D(
        e,
        Math.ceil(this.#p / T),
        Math.ceil(this.#w / T),
        1
      );
    }
    this.#a === null && (this.#a = [
      D(e, b, 1, 1),
      D(e, b, 1, 1)
    ], this.#f = 0, this.reset()), this.#A === null && (this.#A = e.createBuffer(), e.bindBuffer(e.PIXEL_PACK_BUFFER, this.#A), e.bufferData(
      e.PIXEL_PACK_BUFFER,
      this.metrics.byteLength,
      e.STREAM_COPY
    ), e.bindBuffer(e.PIXEL_PACK_BUFFER, null));
  }
}
function D(n, e, t, i) {
  const s = n.createFramebuffer();
  n.bindFramebuffer(n.FRAMEBUFFER, s);
  const r = [];
  for (let a = 0; a < i; a++) {
    const c = n.createTexture();
    n.bindTexture(n.TEXTURE_2D, c), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MIN_FILTER, n.NEAREST), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MAG_FILTER, n.NEAREST), n.texImage2D(
      n.TEXTURE_2D,
      0,
      n.RGBA32F,
      e,
      t,
      0,
      n.RGBA,
      n.FLOAT,
      null
    ), n.framebufferTexture2D(
      n.FRAMEBUFFER,
      n.COLOR_ATTACHMENT0 + a,
      n.TEXTURE_2D,
      c,
      0
    ), r.push(c);
  }
  n.drawBuffers(r.map((a, c) => n.COLOR_ATTACHMENT0 + c));
  const A = n.checkFramebufferStatus(n.FRAMEBUFFER) === n.FRAMEBUFFER_COMPLETE;
  n.bindFramebuffer(n.FRAMEBUFFER, null);
  const o = { framebuffer: s, textures: r, width: e, height: t };
  if (!A)
    throw M(n, o), new Error("failed to allocate framebuffer");
  return o;
}
function M(n, { framebuffer: e, textures: t }) {
  n.deleteFramebuffer(e);
  for (const i of t) n.deleteTexture(i);
}
function y(n, e = 0, t = n.length) {
  const i = new DataView(n.buffer, n.byteOffset, n.byteLength), s = [];
  for (let r = e; r < t; ) {
    if (r + 8 > t) throw new Error("Incomplete MP4 box");
    const A = i.getUint32(r);
    if (A < 8 || r + A > t) throw new Error("Invalid MP4 box size");
    s.push({
      type: String.fromCharCode(...n.subarray(r + 4, r + 8)),
      start: r,
      body: r + 8,
      end: r + A
    }), r += A;
  }
  return s;
}
function Re(n, e) {
  for (const t of y(n, e.body, e.end).filter(
    (i) => i.type === "trak"
  )) {
    let i = t;
    for (const s of ["mdia", "minf", "stbl", "stsd"]) {
      const r = y(n, i.body, i.end).find(
        (A) => A.type === s
      );
      if (!r) break;
      i = r;
    }
    if (i.type === "stsd")
      for (const s of y(n, i.body + 8, i.end)) {
        if (s.type !== "avc1") continue;
        const r = y(n, s.body + 78, s.end).find(
          (a) => a.type === "avcC"
        );
        if (!r) throw new Error("AVC sample entry has no avcC");
        const A = n.slice(r.body, r.end);
        return { codec: "avc1." + Array.from(A.subarray(1, 4)).map((a) => a.toString(16).padStart(2, "0")).join(""), description: A };
      }
  }
  return null;
}
class Me {
  #t;
  #n = null;
  #e = null;
  /** Compressed frames within the MSE buffer, retained at normal speed for seeks and later accelerated playback. */
  #o = [];
  #i = 0;
  #s = null;
  #m = [];
  /** Timestamps of one-tick duplicate pictures needed only as open-GOP decoding references. */
  #u = /* @__PURE__ */ new Set();
  #x = !1;
  #E = !1;
  #y = !1;
  #h = !1;
  #a = !1;
  #f = /* @__PURE__ */ new WeakMap();
  constructor(e) {
    this.#t = e, e.addEventListener("seeking", this.#r), e.addEventListener("ratechange", this.#r);
  }
  get active() {
    return this.#h;
  }
  /** Receive input in MSE append order; the caller retains ownership of the original ArrayBuffer. */
  append(e) {
    if (this.#y) return;
    const t = new Uint8Array(e), i = new DataView(e);
    try {
      for (const r of y(t)) {
        if (r.type === "moov") {
          this.#n = Re(t, r);
          const A = this.#n;
          A && VideoDecoder.isConfigSupported(A).then((o) => {
            this.#f.set(A, o.supported === !0);
          }).catch((o) => this.#l(o));
        }
        if (!(r.type !== "moof" || this.#n === null))
          for (const A of y(t, r.body, r.end).filter(
            (o) => o.type === "traf"
          )) {
            const o = y(t, A.body, A.end), a = o.find((l) => l.type === "tfhd");
            if (!a || i.getUint32(a.body + 4) !== 1) continue;
            const c = o.find((l) => l.type === "tfdt"), h = o.find((l) => l.type === "trun");
            if (!c || !h || i.getUint32(c.body) !== 16777216 || i.getUint32(h.body) !== 16781057)
              throw new Error("Unexpected mpeg2toh264 video fragment layout");
            let f = Number(i.getBigUint64(c.body + 4)), d = r.start + i.getInt32(h.body + 8);
            const u = i.getUint32(h.body + 4);
            if (h.body + 12 + u * 16 > h.end)
              throw new Error("Incomplete video samples");
            for (let l = 0; l < u; l++) {
              const m = h.body + 12 + l * 16, v = i.getUint32(m), E = i.getUint32(m + 4), L = i.getUint32(m + 8), oe = i.getInt32(m + 12);
              if (d < 0 || d + E > t.length)
                throw new Error("Video sample outside fragment");
              this.#o.push({
                config: this.#n,
                decodeTime: f / 9e4,
                timestamp: Math.round((f + oe) * 1e6 / 9e4),
                duration: Math.round(v * 1e6 / 9e4),
                type: L & 65536 ? "delta" : "key",
                data: t.subarray(d, d + E)
              }), f += v, d += E;
            }
          }
      }
      const s = this.#t.buffered;
      if (s.length > 0) {
        let r = 0;
        for (let A = 0; A < (this.#h ? this.#i : this.#o.length); A++) {
          const o = this.#o[A];
          o.type === "key" && o.timestamp / 1e6 <= s.start(0) && (r = A);
        }
        r > 0 && (this.#o.splice(0, r), this.#i = Math.max(0, this.#i - r));
      }
    } catch (s) {
      this.#l(s);
    }
  }
  /** Return undefined to use the video element, or null to wait for the next decoded frame. */
  take() {
    if (this.#y || this.#t.playbackRate <= 1.25 || this.#n === null || this.#f.get(this.#n) !== !0) {
      this.#h && this.#r();
      return;
    }
    this.#h || (this.#r(), this.#h = !0);
    const e = this.#t.currentTime;
    try {
      for (; this.#i < this.#o.length && (this.#s?.decodeQueueSize ?? 0) < 6 && this.#m.length < 12; ) {
        const i = this.#o[this.#i];
        if (i.decodeTime > e + 0.25) break;
        if (this.#e !== i.config) {
          if (this.#s) {
            if (!this.#E) {
              this.#E = !0;
              const r = this.#s;
              r.flush().then(() => {
                this.#s === r && (r.close(), this.#s = null, this.#e = null, this.#E = !1);
              }).catch((A) => {
                this.#s === r && this.#l(A);
              });
            }
            break;
          }
          const s = new VideoDecoder({
            output: (r) => {
              this.#s !== s ? r.close() : this.#A(r);
            },
            error: (r) => {
              this.#s === s && this.#l(r);
            }
          });
          this.#s = s, this.#s.configure(i.config), this.#e = i.config;
        }
        (i.duration ?? 0) < 1e3 && this.#u.add(i.timestamp), this.#s.decode(new EncodedVideoChunk(i)), this.#i++;
      }
      if (this.#x && this.#i === this.#o.length && this.#s && !this.#E) {
        this.#E = !0;
        const i = this.#s;
        i.flush().catch((s) => {
          this.#s === i && this.#l(s);
        });
      }
    } catch (i) {
      this.#l(i);
      return;
    }
    const t = this.#m[0];
    return !t || t.timestamp / 1e6 > e + 3e-3 * this.#t.playbackRate ? this.#a ? null : void 0 : (this.#a = !0, this.#m.shift());
  }
  #A = (e) => {
    this.#u.delete(e.timestamp) || e.timestamp / 1e6 < this.#t.currentTime - (this.#a ? 0.1 : 0.04) ? e.close() : this.#m.push(e);
  };
  #r = () => {
    this.#s && this.#s.state !== "closed" && this.#s.close(), this.#s = null, this.#e = null;
    for (const e of this.#m) e.close();
    this.#m = [], this.#u.clear(), this.#E = !1, this.#h = !1, this.#a = !1, this.#i = 0;
    for (let e = 0; e < this.#o.length; e++) {
      const t = this.#o[e];
      t.type === "key" && t.timestamp / 1e6 <= this.#t.currentTime && (this.#i = e);
    }
  };
  finish() {
    this.#x = !0;
  }
  /** Release the decoder and undisplayed frames while the filter is stopped. */
  suspend() {
    this.#r();
  }
  reset() {
    this.#r(), this.#o = [], this.#i = 0, this.#n = null, this.#x = !1, this.#y = !1;
  }
  destroy() {
    this.reset(), this.#t.removeEventListener("seeking", this.#r), this.#t.removeEventListener("ratechange", this.#r);
  }
  #l(e) {
    this.#r(), this.#y = !0, console.warn("mpeg2toh264: decoded video input unavailable", e);
  }
}
const re = [
  "mozParsedFrames",
  "mozDecodedFrames",
  "mozPresentedFrames",
  "mozPaintedFrames"
];
function ne(n) {
  return re.every((e) => e in n);
}
function _e(n) {
  return n.ownerDocument?.defaultView?.performance.timeOrigin ?? performance.timeOrigin;
}
function Se() {
  return typeof HTMLVideoElement < "u" && (ne(HTMLVideoElement.prototype) || typeof HTMLVideoElement.prototype.requestVideoFrameCallback == "function");
}
const Ce = 250, Pe = 500;
class ke {
  #t;
  #n;
  #e;
  #o = null;
  #i = null;
  #s = null;
  #m = null;
  #u = !1;
  #x = !0;
  #E = null;
  #y = null;
  #h = 0;
  #a;
  #f;
  #A = null;
  #r = null;
  #l = null;
  #_ = null;
  #p = 0;
  #w = [];
  #c = [];
  constructor(e, t) {
    if (this.#t = e, this.#n = t, this.#e = ne(e) ? e : null, this.#a = this.#e === null && typeof VideoFrame < "u", this.#f = this.#a && e.playbackRate > 1, this.#e) {
      for (const i of ["emptied", "seeking", "seeked"])
        e.addEventListener(i, this.#U);
      for (const i of ["pause", "playing", "waiting", "ratechange"])
        e.addEventListener(i, this.#D);
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
        e.addEventListener(i, this.#$);
  }
  /** Whether acquisition runs off the Firefox counters. */
  get mozDriven() {
    return this.#e !== null && !this.#f;
  }
  /** Whether frequent capture is active, excluding fallback notifications based on video.currentTime. */
  get captureDriven() {
    return this.#f;
  }
  /** Whether any frame has been delivered yet (counters proven live). */
  get hasDelivered() {
    return this.#u;
  }
  request(e) {
    if (this.#i === null) {
      if (this.#i = e, this.#f) {
        this.#I();
        return;
      }
      this.#o = this.#e ? requestAnimationFrame(this.#G) : this.#t.requestVideoFrameCallback(this.#ge);
    }
  }
  cancel() {
    this.#o !== null && (this.#e ? cancelAnimationFrame(this.#o) : this.#t.cancelVideoFrameCallback(this.#o)), this.#o = null, this.#i = null, this.#A?.(), this.#A = null, this.#l !== null && this.#t.cancelVideoFrameCallback(this.#l), this.#l = null, this.#k(), this.#_ = null, this.#w = [], this.#U();
  }
  destroy() {
    this.cancel();
    for (const e of ["emptied", "seeking", "seeked"])
      this.#t.removeEventListener(e, this.#U);
    for (const e of ["pause", "playing", "waiting", "ratechange"])
      this.#t.removeEventListener(e, this.#D);
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
      this.#t.removeEventListener(e, this.#$);
  }
  /** Deliver pending input on the rendering window's refresh, before drawing. */
  flush(e) {
    if (this.#f)
      for (this.#t.ownerDocument !== this.#r && (this.#A?.(), this.#A = null, this.#I()); this.#c.length > 0 && this.#i !== null; ) {
        const t = this.#c.shift(), i = t.frame;
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
  #k() {
    for (const e of this.#c) e.frame.close();
    this.#c = [];
  }
  #$ = (e) => {
    const t = this.#a && this.#t.playbackRate > 1;
    if (t !== this.#f) {
      const i = this.#i;
      this.cancel(), this.#f = t, i !== null && this.request(i);
      return;
    }
    this.#f && ((e.type === "pause" || e.type === "ended") && this.flush(performance.now()), this.#k(), ["seeking", "seeked", "emptied", "ratechange"].includes(e.type) && (this.#_ = null, this.#w = []), this.#A?.(), this.#A = null, this.#i !== null && this.#I());
  };
  #I() {
    if (this.#A !== null || this.#i === null || (this.#t.paused || this.#t.ended) && this.#_ !== null)
      return;
    this.#l === null && typeof this.#t.requestVideoFrameCallback == "function" && (this.#l = this.#t.requestVideoFrameCallback(
      this.#ie
    ));
    const e = Math.max(4, 8 / Math.max(1, this.#t.playbackRate)), t = this.#t.ownerDocument?.defaultView;
    if (this.#r = this.#t.ownerDocument, t) {
      const i = t.setTimeout(this.#N, e);
      this.#A = () => t.clearTimeout(i);
    } else {
      const i = setTimeout(this.#N, e);
      this.#A = () => clearTimeout(i);
    }
  }
  #ie = () => {
    this.#l = null, this.#A?.(), this.#A = null, this.#N();
  };
  #N = () => {
    this.#A = null;
    const e = this.#t;
    if (this.#i === null) return;
    if (e.readyState < 2 || e.seeking) {
      this.#I();
      return;
    }
    let t, i = !1;
    try {
      const s = this.#n?.();
      if (s === null) {
        this.#I();
        return;
      }
      i = s !== void 0, t = s ?? new VideoFrame(e);
    } catch (s) {
      if (!(s instanceof DOMException) || s.name !== "InvalidStateError")
        throw s;
      this.#I();
      return;
    }
    if (t.timestamp === this.#_)
      t.close();
    else {
      let s = 1;
      if (this.#_ !== null) {
        const A = t.timestamp - this.#_;
        if (A > 1e3 && A < 25e4) {
          this.#w.push(A), this.#w.length > 7 && this.#w.shift();
          const o = [...this.#w].sort((c, h) => c - h), a = o[Math.floor(o.length / 2)];
          s = Math.max(1, Math.round(A / a));
        }
      }
      this.#_ = t.timestamp, this.#p += s;
      const r = performance.now() + (i ? (t.timestamp / 1e6 - e.currentTime) * 1e3 / e.playbackRate : 0);
      for (this.#c.push({ frame: t, at: r, count: this.#p }); this.#c.length > 4; ) this.#c.shift().frame.close();
    }
    this.#I();
  };
  #D = () => {
    this.#E = null, this.#y = null, this.#h = 0;
  };
  #U = () => {
    this.#s = null, this.#m = null, this.#x = !0, this.#D();
  };
  /** Native acquisition: pass the report on, with the clock it was made on. */
  #ge = (e, t) => {
    this.#S(e, {
      width: t.width,
      height: t.height,
      mediaTime: t.mediaTime,
      presentedFrames: t.presentedFrames,
      expectedDisplayTime: t.expectedDisplayTime,
      timeOrigin: _e(this.#t)
    });
  };
  #S = (e, t) => {
    const i = this.#i;
    this.#o = null, this.#i = null, this.#u = !0, i?.(e, t);
  };
  #G = (e) => {
    const t = this.#e, i = re.map((o) => t[o]);
    this.#s?.some((o, a) => i[a] < o) && this.#U(), this.#s = i;
    const s = t.mozPaintedFrames, r = !t.seeking && t.readyState >= 2 && t.videoWidth > 0 && t.videoHeight > 0, A = this.#m === null && (s > 0 || t.paused && (t.mozPresentedFrames > 0 || t.mozDecodedFrames > 0));
    if (r && (A || this.#m !== null && s !== this.#m)) {
      if (this.#E !== null && e - this.#E > Pe && (this.#D(), this.#x = !0), !t.paused && !t.ended) {
        const a = this.#y;
        if (a && e - a.at >= Ce) {
          const c = s - a.frames;
          if (c > 0) {
            const h = (e - a.at) / c;
            h >= 4 && h <= 200 && (this.#h = this.#h ? this.#h + (h - this.#h) * 0.25 : h);
          }
          this.#y = null;
        }
        this.#y ??= { at: e, frames: s };
      }
      this.#E = e, this.#m = s;
      const o = this.#x;
      this.#x = !1, this.#S(e, {
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
        mozTiming: { periodMs: this.#h, discontinuity: o }
      });
    } else
      this.#o = requestAnimationFrame(this.#G);
  };
}
let Ae = null;
function Be(n) {
  Ae = n;
}
const H = 0.5, w = 4, G = 5, g = G + 1, $ = 1e3, I = 4, P = 200, Le = 0.25, Ie = 1e3 / 60, Q = 250, Ue = 1e3 / 30, Ne = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, Oe = 0.75, Ge = 0.1, Z = 1, ze = 0.02, Xe = 0.1, Y = 1, We = 4, U = 5, Ve = 4, He = {
  2: 0,
  3: 0.25,
  4: 0.5,
  5: 0.75
}, $e = `#version 300 es
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
function it() {
  return Se() && typeof WebGL2RenderingContext < "u";
}
const Qe = {
  requestAnimationFrame: (n) => requestAnimationFrame(n),
  cancelAnimationFrame: (n) => cancelAnimationFrame(n)
};
class st extends EventTarget {
  /** Receive fMP4 from the player and decode supplemental input only above 1.25x playback speed. */
  encodedVideo;
  #t;
  #n;
  #e;
  #o;
  #i;
  /** The pulldown detection, built only while the `film` option needs it. */
  #s = null;
  #m;
  #u;
  /** The program that copies a filtered picture onto the canvas. */
  #x;
  #E;
  #y;
  #h = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #a = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #f = g - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #A = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #r = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #l = null;
  #_ = 0;
  /** ページ側で frame callback の停止を監視する requestAnimationFrame()。 */
  #p = null;
  /** The document the owner-change listener is on, if any. */
  #w = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #c = Ie;
  /** Where the refresh grid fitted to the animation frames stands. (otya) */
  #k = 0;
  /** How far ahead of its animation frame the last picture shown stood. (otya) */
  #$ = 0;
  #I = 0;
  #ie = 0;
  /** The last picture chained onto the schedule; a break restarts it. (otya) */
  #N = null;
  /**
   * Drop the presentation queue and restart the schedule from the clock.
   * Every schedule restart goes through here (otya nulls #lastScheduled at
   * each queue clear): the old chain's clock no longer applies, so keeping
   * it would either count a phantom resync or pop freshly queued pictures
   * as late. Restart accounting for cadence changes lives in #schedule.
   */
  #D() {
    this.#r.length = 0, this.#N = null, this.#ie = 0;
  }
  /** The `<div>` this put around the element, so it can be taken away again. */
  #U = null;
  #ge;
  #S;
  #G;
  #se = 0;
  /** otya GPU pulldown path: enabled by the `film` option (see below). */
  #z;
  #M;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #b = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #B = 0;
  #X = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #L = w - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #T = 0;
  #ye = 0;
  /** presentedFrames at the last ingested frame; pairs with #lastMediaTime. */
  #je = 0;
  #Le = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #Te = !1;
  /** 最終通知時刻。rVFC と Firefox カウンターのどちらの取得経路でも更新する。 */
  #Ie = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #re = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #qe = 0;
  /** 代替経路が requestVideoFrameCallback() を最後に予約し直した時刻。 */
  #xt = 0;
  #F = !1;
  /** Cancels work suspended inside a synchronous owner callback. */
  #J = 0;
  #Ue = !1;
  #W = !1;
  #g = null;
  #ne = [];
  #O = !1;
  #Ke;
  #Je;
  #R;
  #Ae;
  #Q;
  #et;
  #d = null;
  #v;
  #Fe = !1;
  #tt = 0;
  #it = !1;
  #Zt = 0;
  #De = !1;
  #Ne = !1;
  #oe = null;
  #Yt = 0;
  #Re = /* @__PURE__ */ new Map();
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #C = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    resynced: 0,
    late: 0,
    queueResetted: 0
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #he = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #Oe = 0;
  #Ge = 0;
  #Z = 0;
  #ae = 0;
  #le = 0;
  #Me = 0;
  #ce = 0;
  #ue;
  #ze = [];
  #fe = [];
  #_e = 0;
  #de = 0;
  #Se = 0;
  #me = 0;
  /** The last phase read back from the GPU, and how many frames ago it was for. */
  #Ce = x;
  #pe = 0;
  /** The phase of the frame being filtered: #known advanced by #knownAge. */
  #P = x;
  #Y = !1;
  #ve = null;
  #gt = "";
  /** Debug only: frames given each phase (0 for none), and repeats dropped. */
  #Xe = [0, 0, 0, 0, 0, 0];
  #st = 0;
  /**
   * Why requested film reconstruction is currently degraded, or null while
   * healthy. The `film` option stays as the caller set it;
   * only the engine stands down, so this is never a silent option change.
   */
  #ee = null;
  /** Last worker-reported filmError, to derive the page-side failure event. */
  #rt = null;
  #nt = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#S = t.doubleRate ?? !1, this.#G = t.spatialCheck ?? !0, this.#z = t.debug ?? !1, this.#M = t.film ?? !1, this.#Ke = t.onStats, this.#Je = t.onFailure, this.#R = i, this.#Q = i ? "main" : t.rendering ?? "main", this.#et = t.workerUrl ?? Ae, this.#v = this.#Q === "main" ? "main" : "idle", this.#n = i ? i.canvas : document.createElement("canvas"), this.#t = i?.canvas ?? (this.#Q === "main" ? this.#n : document.createElement("canvas")), this.#Ae = e, i || (this.#n.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
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
    this.#i = s, this.#M && (this.#Dt(), this.#s = new V(s)), this.#m = j(s, De);
    const r = this.#m;
    this.#u = Object.fromEntries(
      Object.entries(Fe).map(([A, o]) => [
        A,
        s.getUniformLocation(r, o)
      ])
    ), this.#x = j(s, $e), this.#E = s.getUniformLocation(this.#x, "uField"), this.#y = s.getUniformLocation(this.#x, "uFlip"), this.#ue = s.getExtension(
      "EXT_disjoint_timer_query_webgl2"
    ), this.#t.addEventListener(
      "webglcontextlost",
      this.#Qt
    ), this.#ge = i ? null : new ResizeObserver(() => this.#Ye()), this.encodedVideo = !i && typeof VideoDecoder < "u" ? new Me(e) : null, this.#o = new ke(e, () => this.encodedVideo?.take()), e.addEventListener("emptied", this.#Vt), e.addEventListener("resize", this.#Wt), e.addEventListener("pause", this.#K), e.addEventListener("ended", this.#K), e.addEventListener("seeking", this.#$t), e.addEventListener("seeked", this.#K), e.addEventListener("ratechange", this.#K);
  }
  get running() {
    return this.#F && (this.#g?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#n;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #yt() {
    return this.#g?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #Tt() {
    return {
      doubleRate: this.#S,
      spatialCheck: this.#G,
      film: this.#M,
      debug: this.#z
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#Ue;
  }
  set enabled(e) {
    this.#Ue = e, this.#At(), this.#d?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#g?.interlaced !== e?.interlaced, i = t || this.#g?.topFieldFirst !== e?.topFieldFirst;
    this.#g = e, !(i && (!this.#we() || this.#g !== e)) && (this.#d?.postMessage({ type: "scan", scan: e }), i && (this.#T = 0, this.#D(), this.#V(), t && (this.#b = 0), this.#A = null, this.#q(!1)), this.#At(), i && ((e?.interlaced ?? !0) && (this.#R || this.#v === "main") ? this.#ke() : this.#ft()));
  }
  get scan() {
    return this.#g;
  }
  set videoTimeline(e) {
    this.#ne = e, this.#d?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#g = null), this.#At();
  }
  get videoTimeline() {
    return this.#ne;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#U ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#S;
  }
  set doubleRate(e) {
    e !== this.#S && (this.#S = e, this.#Ee(), this.#D(), this.#Ft());
  }
  get spatialCheck() {
    return this.#G;
  }
  set spatialCheck(e) {
    e !== this.#G && (this.#G = e, this.#Ee());
  }
  get film() {
    return this.#M;
  }
  set film(e) {
    const t = this.#d ? this.#rt : this.#ee;
    if (!(e === this.#M && (e === !1 || t === null))) {
      if (this.#d) {
        this.#M = e, this.#Ee(e ? "film" : void 0);
        return;
      }
      if (e) {
        if (!this.#we()) return;
        try {
          this.#Rt();
        } catch (i) {
          this.#M = !0, this.#Ee(), this.#ht(
            `film detector unavailable: ${i instanceof Error ? i.message : String(i)}`
          );
          return;
        }
      }
      if (this.#M = e, this.#Ee(), !e) {
        if (!this.#we()) return;
        this.#Y = !1, this.#P = x, this.#V(), this.#s?.destroy(), this.#s = null;
      }
      this.#Ft();
    }
  }
  get debug() {
    return this.#z;
  }
  set debug(e) {
    e !== this.#z && (this.#z = e, this.#Ee());
  }
  /** Whether pictures are queued for presentation by the frame loop. */
  get #jt() {
    return this.#S || this.#M;
  }
  #Ft() {
    this.#W || (this.#jt ? (this.#B > 0 && this.#Xt(), (this.#g?.interlaced ?? !0) && (this.#R || this.#v === "main") && this.#ke()) : this.#M || (this.#A = null, this.#q(!1), this.#Be()));
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Ee(e) {
    this.#d?.postMessage({
      type: "settings",
      options: this.#Tt(),
      retryFilm: e
    });
  }
  #Dt() {
    if (this.#i.getExtension("EXT_color_buffer_float") === null)
      throw new Error("film needs EXT_color_buffer_float");
  }
  /** Build the GPU pulldown detector the `film` option needs, or throw. */
  #Rt() {
    this.#Dt(), this.#s ??= new V(this.#i), this.#B > 0 && this.#s.resize(this.#B, this.#X);
  }
  #At() {
    this.#Ue && (this.#ne.length > 0 || (this.#g?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #qt() {
    return this.#R || this.#Q === "main" ? !1 : this.#v === "starting" || this.#v === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#et !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Mt(), !0) : this.#Q === "auto" ? (this.#We(), !1) : (this.#v = "failed", this.#F = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #Mt() {
    this.#j(), this.#d?.terminate(), this.#d = null, this.#De = !1, this.#Ne = !1, this.#rt = null, this.#nt = 0;
    let e = this.#n;
    if (this.#it) {
      e = document.createElement("canvas"), e.className = this.#n.className;
      const r = this.#n.getAttribute("style");
      r === null ? e.removeAttribute("style") : e.setAttribute("style", r), e.style.visibility = "hidden", this.#n.parentElement && this.#n.replaceWith(e), this.#n = e;
    }
    const t = ++this.#tt;
    this.#v = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#it = !0, i = new Worker(this.#et, { type: "module" });
    } catch (r) {
      this.#Pe(
        r instanceof Error ? r.message : String(r)
      );
      return;
    }
    this.#d = i, i.onmessage = (r) => {
      t === this.#tt && this.#Kt(r.data);
    }, i.onerror = (r) => {
      t === this.#tt && (r.preventDefault(), this.#Pe(r.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#Tt(),
        scan: this.#g,
        videoTimeline: this.#ne,
        enabled: this.#F,
        video: this.#at()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #Kt(e) {
    switch (e.type) {
      case "ready":
        this.#v = "active", this.#F && (this.#be(), this.#vt());
        break;
      case "failed":
        this.#Pe(e.message);
        break;
      case "consumed": {
        this.#De = !1, this.#Ne = !0;
        const t = this.#oe;
        this.#oe = null, t && this.#St(t);
        break;
      }
      case "visibility":
        this.#n.style.visibility = e.visible ? "visible" : "hidden";
        break;
      case "stats": {
        const t = {
          ...e.stats,
          dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0
        }, i = t.filmError ?? null, s = this.#nt;
        if (this.#rt = i, this.#nt = e.filmFailure, i !== null && e.filmFailure !== s) {
          this.dispatchEvent(
            new CustomEvent("failure", { detail: i })
          );
          try {
            this.#Je?.(i);
          } catch {
          }
        }
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#Ke?.(t);
        break;
      }
      case "capture": {
        const t = this.#Re.get(e.id);
        if (this.#Re.delete(e.id), !t) {
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
    if (this.dispatchEvent(new CustomEvent("failure", { detail: e })), !this.#R)
      try {
        this.#Je?.(e);
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
    this.#ee !== e && (this.#ee = e, this.#Y = !1, this.#P = x, this.#V(), this.#s?.destroy(), this.#s = null, this.#ot(e));
  }
  /**
   * Re-arm film reconstruction at a resource-reallocation point (start, scan
   * change, resize, or re-setting the option). The next frame retries; a
   * repeated failure degrades again and notifies as a new episode.
   */
  #we() {
    return this.#W ? !1 : (this.#d || (this.#ee = null), !0);
  }
  /** 一時的な Worker 障害を1回だけ復旧し、再失敗時は media element 自体を表示する。 */
  #Pe(e) {
    if (this.#v === "starting" && this.#Q === "auto" && !this.#Fe) {
      this.#We();
      return;
    }
    if (this.#_t(e), !this.#Fe) {
      this.#Fe = !0, this.#Mt();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#v = "failed", this.#d?.terminate(), this.#d = null, this.#j(), this.#ot(`deinterlacer worker stopped: ${e}`), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #We() {
    const e = this.#t;
    e.className = this.#n.className;
    const t = this.#n.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#n.parentElement && this.#n.replaceWith(e), this.#n = e, this.#it = !1, this.#d?.terminate(), this.#d = null, this.#v = "main", this.#j(), this.#F && (this.#be(), this.#vt(), (this.#g?.interlaced ?? !0) && this.#ke());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #j() {
    this.#oe?.frame.close(), this.#oe = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #_t(e) {
    for (const t of this.#Re.values())
      t.reject(new Error(e));
    this.#Re.clear();
  }
  start() {
    if (!(this.#F || this.#W || this.#O) && (this.#J++, this.#F = !0, this.#Ht(), !!this.#we())) {
      if (this.#Ie = performance.now(), this.#qe = this.#Ie, this.#Le = Number.NaN, this.#re = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#mi(), this.#vt(), this.#qt()) {
        this.#d?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#v === "active" && this.#be();
        return;
      }
      this.#be(), (this.#g?.interlaced ?? !0) && this.#ke();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#J++, this.#F && (this.#F = !1, this.#o.cancel(), this.encodedVideo?.suspend(), this.#ai(), this.#ft(), this.#T = 0, this.#A = null, this.#q(!1), this.#j(), this.#d?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#W) {
      this.#W = !0, this.#Ue = !1, this.stop(), this.#d?.postMessage({ type: "destroy" }), this.#d?.terminate(), this.#d = null, this.#j(), this.#_t("the deinterlacer was destroyed"), this.#w?.removeEventListener(
        "visibilitychange",
        this.#pt
      ), this.#w = null, this.#t.removeEventListener(
        "webglcontextlost",
        this.#Qt
      ), this.#o.destroy(), this.encodedVideo?.destroy(), this.#e.removeEventListener("emptied", this.#Vt), this.#e.removeEventListener("resize", this.#Wt), this.#e.removeEventListener("pause", this.#K), this.#e.removeEventListener("ended", this.#K), this.#e.removeEventListener("seeking", this.#$t), this.#e.removeEventListener("seeked", this.#K), this.#e.removeEventListener("ratechange", this.#K), this.#pi();
      for (const e of this.#h) this.#i.deleteTexture(e);
      this.#h = [], this.#Be();
      for (const e of [
        ...this.#ze,
        ...this.#fe.map(({ q: t }) => t)
      ])
        this.#i.deleteQuery(e);
      this.#ze.length = 0, this.#fe.length = 0, this.#s?.destroy(), this.#s = null, this.#ve !== null && (fe(this.#ve), this.#ve = null), this.#i.deleteProgram(this.#m), this.#i.deleteProgram(this.#x), this.#i.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#v === "active" && this.#n.style.visibility === "visible" && this.#d) {
      const s = ++this.#Yt, r = new Promise((A, o) => {
        this.#Re.set(s, { resolve: A, reject: o });
      });
      return this.#d.postMessage({
        type: "capture",
        id: s,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), r;
    }
    if (this.#v === "starting" || this.#v === "failed")
      return createImageBitmap(this.#e);
    const e = this.#A;
    if (this.#R && (!this.#F || this.#O || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#F || this.#O || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#wt(e.texture, e.flip, !1) : this.#te(e.flush, e.second, null, !1);
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
  #be() {
    this.#R || !this.#F || this.#o.request(this.#ni);
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
  #Jt(e, t, i) {
    let s;
    try {
      s = i?.clone() ?? new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (A) {
      const o = A instanceof Error ? A.message : String(A);
      this.#Q === "auto" && !this.#Ne && !this.#Fe ? (this.#We(), this.#He(e, t)) : this.#Pe(o);
      return;
    }
    const r = {
      id: ++this.#Zt,
      frame: s,
      now: e,
      metadata: t,
      video: this.#at()
    };
    if (this.#De) {
      this.#oe?.frame.close(), this.#oe = r;
      return;
    }
    this.#St(r);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #St(e) {
    const t = this.#d;
    if (!t || this.#v !== "active") {
      e.frame.close();
      return;
    }
    this.#De = !0;
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
      this.#De = !1, e.frame.close();
      const r = s instanceof Error ? s.message : String(s);
      this.#Q === "auto" && !this.#Ne && !this.#Fe ? (this.#We(), this.#He(e.now, e.metadata)) : this.#Pe(r);
    }
  }
  #ei(e, t, i) {
    this.#ve == null && (this.#ve = ce(this.#i, "20px monospace")), de(this.#ve, e, t, i, this.#B, this.#X, 20);
  }
  #Ct(e) {
    if (this.#ue == null || this.#fe.length > 30)
      return;
    const t = this.#ze.pop() ?? this.#i.createQuery();
    return this.#i.beginQuery(this.#ue.TIME_ELAPSED_EXT, t), this.#fe.push({ q: t, isField: e }), t;
  }
  #Ve(e) {
    this.#ue != null && (e != null && this.#i.endQuery(this.#ue.TIME_ELAPSED_EXT), this.#fe = this.#fe.filter(
      ({ q: t, isField: i }) => {
        if (this.#i.getQueryParameter(t, this.#i.QUERY_RESULT_AVAILABLE)) {
          const s = this.#i.getQueryParameter(t, this.#i.QUERY_RESULT);
          return i ? (this.#Se += s, this.#me++) : (this.#_e += s, this.#de++), this.#ze.push(t), !1;
        }
        return !0;
      }
    ));
  }
  #V() {
    this.#P = x, this.#Ce = x, this.#pe = 0, this.#Y = !1, this.#s?.reset();
  }
  /** Detect the pulldown phase of the frame being filtered on the GPU. */
  #ti() {
    const { prev: e, cur: t, next: i } = this.#Gt(!1), s = this.#h[e], r = this.#h[t], A = this.#h[i];
    if (!s || !r || !A) return;
    const o = this.#g?.topFieldFirst !== !1 ? 0 : 1;
    this.#s?.detect(r, A, o), this.#s?.measureComb(s, r, o);
  }
  /**
   * Read back the previous frame's phase if it has arrived, and advance it
   * to the frame being filtered. The run is not advanced: only the GPU
   * counts observed frames.
   */
  #ii() {
    const e = this.#s?.poll() ?? null;
    e !== null && (this.#Ce = e, this.#pe = e.age), this.#pe++;
    const { phase: t, run: i } = this.#Ce;
    t === 0 || this.#pe > Math.ceil(U * Math.max(1, this.#e.playbackRate)) ? this.#P = x : this.#P = {
      phase: (t - 1 + this.#pe) % U + 1,
      run: i
    };
  }
  #si(e) {
    const t = [], i = this.#s?.metrics ?? new Float32Array(0);
    for (let r = 0; r < p.phase; r++) {
      const A = i[r * 4] ?? 0, o = i[r * 4 + 1] ?? 0, a = i[r * 4 + 2] ?? 0;
      t.push(
        `${A.toFixed(3)},${o.toString().padStart(4)},${a.toFixed(3)}`
      );
    }
    const s = this.#Xe.map((r, A) => `${A === 0 ? "-" : A}:${r}`).join(" ");
    return `frame=${e} phase=${this.#P.phase} run=${this.#P.run} known=${this.#Ce.phase}/${this.#Ce.run} age=${this.#pe} ${this.#Y ? "film" : "video"} period=${this.#b.toFixed(3)}
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
  #lt(e, t) {
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
  #ri(e, t) {
    const i = e.expectedDisplayTime;
    if (!Number.isFinite(i) || i <= 0 || !Number.isFinite(e.timeOrigin)) return t;
    const s = this.#lt(i, e.timeOrigin), r = We * Math.max(this.#c, this.#b);
    return s < t - r || s > t + r ? t : s;
  }
  #ni = (e, t) => {
    if (!this.#F || this.#O) return;
    this.#mt();
    const i = this.#lt(e, t.timeOrigin);
    this.#Ie = i, this.#re = Math.max(
      this.#re,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    );
    const { frame: s, ...r } = t;
    this.#Ae = s ?? this.#e;
    try {
      this.#Pt(i, r, s);
    } finally {
      this.#Ae = this.#e;
    }
    this.#be();
  };
  /**
   * どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。
   * `now` はこの realm の時計で測った取込み時刻。
   */
  #Pt(e, t, i) {
    if (this.#Le = t.mediaTime, this.#v === "active") {
      this.#Jt(e, t, i);
      return;
    }
    this.#v !== "starting" && this.#He(e, t);
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
    const i = this.#J;
    if (this.#H(i) && (this.#Ai(t.mediaTime), !!this.#H(i) && t.width > 0 && t.height > 0)) {
      let s = !1;
      if (!this.#Te && this.#e.seeking) {
        const l = this.#e.buffered, m = this.#b >= I ? this.#b / 1e3 : P / 1e3;
        for (let v = 0; v < l.length; v++)
          if (t.mediaTime >= l.start(v) && t.mediaTime < l.end(v) && Math.abs(t.mediaTime - this.#e.currentTime) <= m) {
            s = !0;
            break;
          }
      }
      if (s && (this.#Te = !0), (this.#B === 0 || this.#X === 0) && this.#zt(t.width, t.height), !this.#H(i)) return;
      if (this.#g && !this.#g.interlaced) {
        const l = performance.now();
        this.#Ut(l), this.#Oe = l, this.#fi(), this.#ae += performance.now() - l, this.#Z++, this.#le++, this.#Nt(l);
        return;
      }
      const r = t.mediaTime - this.#ye, A = t.mozTiming, o = s || (A ? A.discontinuity || r < 0 || r > H : r < 0 || r > H);
      o && (this.#T = 0, this.#b = 0, this.#C.discontinuities++, this.#D(), this.#V());
      const a = this.#di(t.presentedFrames, o);
      if (this.#T > 0 && t.mediaTime === this.#ye && (!A || t.presentedFrames === this.#je))
        return;
      if (!o) {
        const l = A?.periodMs ?? 0;
        l > 0 ? this.#kt(
          l * (this.#e.playbackRate || 1) / 1e3,
          1
        ) : this.#T > 0 && r > 0 && this.#kt(r, a + 1);
      }
      this.#ye = t.mediaTime, this.#je = t.presentedFrames;
      const c = performance.now();
      this.#Ut(c), this.#Oe = c;
      const h = performance.now(), f = this.#Ct(!1);
      if (this.#Ot(), this.#M && !this.#ee && !this.#s)
        try {
          this.#Rt();
        } catch (l) {
          this.#ht(
            `film detector unavailable: ${l instanceof Error ? l.message : String(l)}`
          );
        }
      if (!this.#H(i)) {
        this.#W || this.#Ve(f);
        return;
      }
      if (this.#M && !this.#ee) {
        if (this.#T === w && a === 0)
          try {
            this.#ii(), this.#ti();
          } catch (l) {
            this.#ht(
              `film detection failed: ${l instanceof Error ? l.message : String(l)}`
            );
          }
        else
          this.#V();
        this.#Xe[this.#P.phase] = (this.#Xe[this.#P.phase] ?? 0) + 1, this.#Y = this.#P.phase !== 0 && this.#P.run >= X, this.#z && (this.#gt = this.#si(t.presentedFrames));
      }
      if (!this.#H(i)) {
        this.#W || this.#Ve(f);
        return;
      }
      const u = this.#ri(t, e) + this.#c;
      if (this.#Y)
        if (this.#$e()) {
          const l = this.#P.phase;
          if (l === O)
            this.#st++, this.#ie++;
          else {
            const m = this.#b * U / Ve, v = this.#ut(1, e, m), E = He[l] ?? 0, L = v || this.#N === null ? u + m : u + E * this.#b;
            this.#Qe(
              "film",
              !1,
              this.#ct("film", L, m),
              m
            );
          }
        } else
          this.#te(!1, !1, null);
      else if (this.#S && this.#$e()) {
        const l = this.#b / 2, v = this.#ut(2, e, l) || this.#N === null ? u + l * 2 : u, E = this.#ct("field", v, l);
        this.#Qe("field", !1, E, l), this.#Qe("field", !0, E + l, l);
      } else if (this.#$e()) {
        const l = this.#b, v = this.#ut(1, e, l) || this.#N === null ? u + l : u;
        this.#Qe(
          "frame",
          !1,
          this.#ct("frame", v, l),
          l
        ) || (this.#C.late++, this.#te(!1, !1, null));
      } else
        this.#C.late += this.#r.length, this.#D(), this.#te(!1, !1, null);
      this.#ce = Math.max(
        this.#ce,
        this.#r.length
      ), this.#Ve(f), this.#ae += performance.now() - h, this.#Z++, this.#Nt(c);
    }
  }
  #H(e) {
    return !this.#W && this.#F && e === this.#J;
  }
  #Ai(e) {
    const t = this.#J;
    let i;
    for (let A = this.#ne.length - 1; A >= 0; A--) {
      const o = this.#ne[A];
      if (o.start <= e + 1e-6) {
        i = o;
        break;
      }
    }
    if (i?.codedSize && (i.codedSize.width !== this.#B || i.codedSize.height !== this.#X) && this.#zt(i.codedSize.width, i.codedSize.height), !this.#H(t)) return;
    const s = i?.scan;
    if (!s || this.#g?.interlaced === s.interlaced && this.#g.topFieldFirst === s.topFieldFirst)
      return;
    const r = this.#g?.interlaced;
    this.#g = s, this.#T = 0, this.#D(), this.#we() && (r !== s.interlaced && (this.#b = 0), s.interlaced && (this.#R || this.#v === "main") ? this.#ke() : this.#ft(), this.#V());
  }
  /**
   * Whether pictures are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #$e() {
    return (this.#S || this.#M) && this.#b > 0 && this.#a.length === g;
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
  #kt(e, t) {
    const s = e * 1e3 / (this.#e.playbackRate || 1) / t;
    s < I || s > P || (this.#b = this.#b > 0 && s > this.#b * Oe ? this.#b + (s - this.#b) * Le : s);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #Qe(e, t, i, s) {
    const r = this.#Bt();
    if (r === null) return !1;
    const A = this.#a[r];
    if (!A) return !1;
    for (this.#f = r; this.#r.length > 0 && this.#r[0]?.slot === r; )
      this.#r.shift(), this.#C.late++;
    this.#te(!1, t, A.framebuffer);
    const o = {
      slot: r,
      at: i,
      duration: s,
      cadence: e,
      phase: e === "film" ? this.#P.phase : e === "field" ? t ? 2 : 1 : 0,
      droppedBefore: this.#ie
    };
    return this.#ie = 0, this.#r.push(o), this.#N = o, !0;
  }
  /**
   * When a picture goes up: one duration after the last one of its cadence,
   * nudged towards `ideal` by a fraction of the gap so that the schedule
   * follows the clock without a picture ever moving across a refresh. It
   * restarts from `ideal` when the gap has grown to a whole picture or the
   * cadence has changed. (otya)
   */
  #ct(e, t, i) {
    if (!(i > 0)) return t;
    const s = this.#N;
    if (s !== null && s.cadence === e) {
      const r = s.at + s.duration, A = t - r;
      if (Math.abs(A) < i) {
        const o = Math.max(
          -Z,
          Math.min(Z, A * Ge)
        );
        return r + o;
      }
    }
    s !== null && this.#C.resynced++;
    for (let r = this.#r.at(-1); r && r.at >= t; )
      this.#r.pop(), this.#C.late++, r = this.#r.at(-1);
    return t;
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #ut(e, t, i) {
    const s = this.#r.at(-1), r = (G + 1) * Math.max(this.#c, i);
    if (s && s.at - t > r)
      return this.#D(), this.#C.queueResetted++, !0;
    const A = Math.max(
      0,
      this.#r.length + e - G
    );
    let o = 0, a = 0;
    for (; a < A; ) {
      const c = this.#r.shift();
      if (!c) break;
      o += c.duration, a++;
    }
    for (const c of this.#r) c.at -= o;
    return this.#C.late += a, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Bt() {
    const e = this.#A?.kind === "texture" ? this.#A.texture : null, t = new Set(this.#r.map(({ slot: s }) => s));
    for (let s = 1; s <= g; s++) {
      const r = (this.#f + s) % g, A = this.#a[r];
      if (A && A.texture !== e && !t.has(r))
        return r;
    }
    const i = this.#r[0];
    if (i) {
      const s = this.#a[i.slot];
      if (s && s.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #ke() {
    this.#l === null && (!this.#F || this.#O || (this.#_ = 0, this.#l = this.#xe(this.#dt)));
  }
  #ft() {
    this.#Ze(this.#l), this.#l = null, this.#D();
  }
  #dt = (e) => {
    if (this.#l = null, !this.#F || this.#O) return;
    this.#oi(e);
    const t = this.#J;
    this.#o.flush(e), this.#H(t) && (this.#v === "main" && this.#ci(this.#k, e), this.#l = this.#xe(this.#dt));
  };
  /**
   * Fit a grid of refreshes (period and phase) to the animation frames. rAF
   * timestamps wander by a millisecond or so, which is more than the
   * nearest-refresh decision in #present can take; the grid is what it
   * compares against. A frame far off the grid restarts it. (otya)
   */
  #oi(e) {
    const t = e - this.#_;
    this.#_ = e;
    const i = Math.max(1, Math.round(t / this.#c)), s = this.#k + i * this.#c, r = e - s;
    if (this.#k === 0 || t <= 0 || t > P || Math.abs(r) > this.#c / 4) {
      t >= 1 && t <= P && (this.#c = t), this.#k = e;
      return;
    }
    this.#c += r / i * ze, this.#k = s + r * Xe;
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
    const e = this.#R;
    if (e)
      return { frames: e, origin: performance.timeOrigin };
    const t = this.#n.ownerDocument?.defaultView ?? this.#e.ownerDocument?.defaultView ?? null;
    return t === null ? { frames: Qe, origin: performance.timeOrigin } : { frames: t, origin: t.performance.timeOrigin };
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
  #xe(e) {
    const { frames: t, origin: i } = this.#Lt(), s = t.requestAnimationFrame(
      (r) => e(this.#lt(r, i))
    );
    return { frames: t, handle: s };
  }
  /** 予約した表示機会を、それを発行した window 自身で取り消す。 */
  #Ze(e) {
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
    if (this.#R) return;
    this.#hi();
    const { frames: e } = this.#Lt(), t = this.#l !== null && this.#l.frames !== e, i = this.#p !== null && this.#p.frames !== e;
    !t && !i || (this.#_ = 0, t && (this.#Ze(this.#l), this.#l = this.#xe(this.#dt)), i && (this.#Ze(this.#p), this.#p = this.#xe(this.#Et)));
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
  #hi() {
    const e = this.#R ? null : this.#n.ownerDocument ?? null;
    e !== this.#w && (this.#w?.removeEventListener(
      "visibilitychange",
      this.#pt
    ), this.#w = e, e?.addEventListener("visibilitychange", this.#pt));
  }
  #pt = () => {
    this.#W || this.#mt();
  };
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #vt() {
    this.#R || this.#p !== null || !this.#F || this.#O || (this.#p = this.#xe(this.#Et));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #ai() {
    this.#Ze(this.#p), this.#p = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #Et = (e) => {
    if (this.#p = null, !this.#F || this.#O) return;
    const t = this.#J;
    this.#o.flush(e), this.#H(t) && (this.#li(e), this.#H(t) && (this.#p = this.#xe(this.#Et)));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #li(e) {
    if (this.#R || this.#o.captureDriven || this.#o.mozDriven && this.#o.hasDelivered || e - this.#Ie < Q || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#b >= I ? this.#b : Ue;
    (i > 0 ? i > this.#re : t !== this.#Le && e - this.#qe >= s * 0.75) && (e - this.#xt >= Q && (this.#xt = e, this.#o.cancel(), this.#be()), this.#re = Math.max(
      this.#re,
      i
    ), this.#qe = e, this.#Pt(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#he + 1, i),
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
  #ci(e, t) {
    const i = this.#c / 2, s = (a) => {
      const c = a.at - e;
      return c <= i - Y ? !0 : c > i + Y ? !1 : this.#$ > 0;
    };
    for (; this.#r[1] && s(this.#r[1]); )
      this.#C.late++, this.#r.shift();
    const r = this.#r[0];
    if (!r || !s(r)) return;
    this.#r.shift(), this.#$ = r.at - e;
    const A = performance.now(), o = this.#Ct(!0);
    this.#It(r.slot), this.#Ve(o), this.#Me += performance.now() - A, this.#le++, this.#z && this.#ui(r, t), this.#I = t;
  }
  /** Preserve upstream's opt-in presentation timing log in either renderer. */
  #ui(e, t) {
    const i = this.#I === 0 ? 0 : t - this.#I, s = i / this.#c, r = e.cadence === "film" ? `phase ${e.phase}` : e.cadence === "field" ? `field ${e.phase}` : "frame", A = e.phase === 0 ? "duplicate" : `phase ${O}`, o = e.droppedBefore > 0 ? `, ${A} dropped before it` + (e.droppedBefore > 1 ? ` (${e.droppedBefore})` : "") : "";
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
  #fi() {
    this.#Ot();
    const e = this.#h[this.#L];
    e && this.#wt(e, !0), this.#T = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #q(e) {
    if (this.#R) {
      this.#R.onVisibility(e);
      return;
    }
    this.#n.style.visibility = e ? "visible" : "hidden";
  }
  #wt(e, t = !1, i = !0) {
    const s = this.#i;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#x), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#E, 0), s.uniform1i(this.#y, t ? 1 : 0), s.viewport(0, 0, this.#B, this.#X), s.drawArrays(s.TRIANGLES, 0, 3), this.#A = { kind: "texture", texture: e, flip: t }, this.#q(!0), i && this.#se++;
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
  #di(e, t) {
    let i = 0;
    return this.#he !== 0 && !t && (i = Math.max(0, e - this.#he - 1), this.#C.missed += i), this.#he = e, i;
  }
  /**
   * Frames stopped arriving for a while -- a pause, a stall, a tab in the
   * background -- and a rate averaged over time nothing was asked of the
   * filter says nothing about it. Begin the interval at this frame.
   */
  #Ut(e) {
    e - this.#Oe <= $ || (this.#Ge = e, this.#Z = 0, this.#ae = 0, this.#le = 0, this.#Me = 0, this.#ce = 0, this.#se = 0, this.#_e = 0, this.#de = 0, this.#Se = 0, this.#me = 0);
  }
  #Nt(e) {
    const t = e - this.#Ge;
    if (t < $) return;
    const i = this.#$e() && (this.#S || this.#Y) ? this.#le : this.#Z, s = this.#Z ? (this.#ae + this.#Me) / this.#Z : 0;
    let r;
    this.#ue != null && (r = 0, this.#de !== 0 && (r += this.#_e / 1e6 / this.#de), this.#me !== 0 && (r += this.#Se / 1e6 / this.#me / 2));
    const A = {
      ...this.#C,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: s,
      maxQueuedFields: this.#ce,
      outputFps: this.#se * 1e3 / t,
      gpuMs: r,
      film: this.#Y,
      filmError: this.#ee
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: A })), this.#Ke?.(A), this.#Ge = e, this.#Z = 0, this.#ae = 0, this.#le = 0, this.#Me = 0, this.#ce = 0, this.#se = 0, this.#_e = 0, this.#de = 0, this.#Se = 0, this.#me = 0;
  }
  /** Take the newest frame into the ring. */
  #Ot() {
    const e = this.#i;
    this.#L = (this.#L + 1) % w, e.bindTexture(e.TEXTURE_2D, this.#h[this.#L] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#Ae
    ), this.#T = Math.min(this.#T + 1, w);
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
  #te(e, t, i, s = !0) {
    if (this.#T === 0 || this.#O) return;
    s && (this.#T === w && !e ? this.#C.filtered++ : this.#C.degraded++);
    const r = this.#i, { prev: A, cur: o, next: a } = this.#Gt(e);
    r.bindFramebuffer(r.FRAMEBUFFER, i), r.useProgram(this.#m);
    for (const [u, l] of [A, o, a].entries())
      r.activeTexture(r.TEXTURE0 + u), r.bindTexture(r.TEXTURE_2D, this.#h[l] ?? null);
    r.uniform1i(this.#u.prev, 0), r.uniform1i(this.#u.cur, 1), r.uniform1i(this.#u.next, 2);
    const c = this.#M ? this.#s?.texture ?? null : null, h = this.#M ? this.#s?.combTexture ?? null : null, f = c !== null && h !== null;
    c !== null && h !== null && (r.activeTexture(r.TEXTURE0 + 3), r.bindTexture(r.TEXTURE_2D, c), r.uniform1i(this.#u.fieldMetrics, 3), r.activeTexture(r.TEXTURE0 + 4), r.bindTexture(r.TEXTURE_2D, h), r.uniform1i(this.#u.comb, 4)), r.uniform2i(this.#u.size, this.#B, this.#X);
    const d = this.#yt ? 0 : 1;
    r.uniform1i(this.#u.parity, t ? 1 - d : d), r.uniform1i(this.#u.tff, this.#yt ? 1 : 0), r.uniform1i(this.#u.second, t ? 1 : 0), r.uniform1i(this.#u.spatialCheck, this.#G ? 1 : 0), r.uniform1i(this.#u.debug, this.#z ? 1 : 0), r.uniform1i(this.#u.film, f ? 1 : 0), r.uniform1i(this.#u.phase, this.#P.phase), r.viewport(0, 0, this.#B, this.#X), r.drawArrays(r.TRIANGLES, 0, 3), this.#z && f && this.#ei(this.#gt, 0, 90), i === null && (this.#A = { kind: "yadif", flush: e, second: t }, this.#q(!0), s && this.#se++);
  }
  #Gt(e) {
    const t = (i) => (this.#L + w - i) % w;
    return this.#T === 1 ? { prev: this.#L, cur: this.#L, next: this.#L } : e ? { prev: t(1), cur: this.#L, next: this.#L } : this.#T === 2 ? { prev: t(1), cur: t(1), next: this.#L } : { prev: t(2), cur: t(1), next: this.#L };
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
  #Ye() {
    if (this.#mt(), !this.#U) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const s = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), r = t * s, A = i * s;
    this.#n.style.left = `${e.offsetLeft + (e.offsetWidth - r) / 2}px`, this.#n.style.top = `${e.offsetTop + (e.offsetHeight - A) / 2}px`, this.#n.style.width = `${r}px`, this.#n.style.height = `${A}px`;
  }
  #zt(e, t) {
    const i = this.#i;
    this.#t.width = e, this.#t.height = t, this.#B = e, this.#X = t, this.#T = 0, this.#A = null, this.#D(), this.#Ye();
    for (const s of this.#h) i.deleteTexture(s);
    this.#h = [];
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
      ), this.#h.push(r);
    }
    this.#Be(), (this.#S || this.#M) && this.#Xt(), this.#s?.resize(e, t), this.#we();
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
  #Xt() {
    const e = this.#i;
    if (!(this.#a.length === g || this.#B === 0)) {
      this.#Be();
      for (let t = 0; t < g; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#B,
          this.#X,
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
      this.#f = g - 1;
    }
  }
  #Be() {
    const e = this.#i, t = this.#A?.kind === "texture" ? this.#A.texture : null;
    this.#a.some((i) => i.texture === t) && (this.#A = null);
    for (const { texture: i, framebuffer: s } of this.#a)
      e.deleteFramebuffer(s), e.deleteTexture(i);
    this.#a = [], this.#D();
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #mi() {
    if (this.#U) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#n), this.#U = t, this.#ge?.observe(this.#e), this.#Ye();
  }
  #pi() {
    if (this.#R) return;
    const e = this.#U;
    this.#U = null, this.#ge?.disconnect(), this.#n.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #Wt = () => this.#Ye();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #bt(e) {
    return !this.#d || this.#v === "main" ? !1 : (this.#d.postMessage({
      type: "event",
      name: e,
      video: this.#at()
    }), !0);
  }
  #Vt = () => {
    if (this.#Le = Number.NaN, this.#bt("emptied")) {
      this.#j(), this.#q(!1);
      return;
    }
    this.#T = 0, this.#ye = 0, this.#je = 0, this.#D(), this.#V(), this.#b = 0, this.#Ht(), this.#A = null, this.#q(!1);
  };
  #Ht() {
    this.#C = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      resynced: 0,
      late: 0,
      queueResetted: 0
    }, this.#Xe.fill(0), this.#st = 0, this.#he = 0, this.#Ge = 0, this.#Oe = 0, this.#Z = 0, this.#ae = 0, this.#le = 0, this.#Me = 0, this.#ce = 0, this.#se = 0, this.#D(), this.#_e = 0, this.#de = 0, this.#Se = 0, this.#me = 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #$t = () => {
    if (this.#bt("seeking")) {
      this.#j();
      return;
    }
    this.#Te = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #K = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#bt(e.type)) {
      this.#j();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#Te;
      if (this.#Te = !1, i) return;
      this.#T = 0, this.#D(), this.#V(), this.#A = null, this.#q(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#b = 0, this.#ye = this.#e.currentTime), this.#D(), this.#F && this.#T > 0) {
      const i = this.#Bt(), s = i === null ? void 0 : this.#a[i];
      i !== null && s ? (this.#f = i, this.#te(!0, !1, s.framebuffer), this.#It(i)) : this.#te(!0, !1, null);
    }
    t && (this.#T = 0, this.#he = 0, this.#V());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Qt = (e) => {
    if (e.preventDefault(), this.#R) {
      this.#R.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#v !== "active" && (this.#O = !0, this.#ot("the deinterlacer WebGL context was lost"), this.stop());
  };
}
function j(n, e) {
  const t = n.createProgram(), i = q(n, n.VERTEX_SHADER, Ne), s = q(n, n.FRAGMENT_SHADER, e);
  if (n.attachShader(t, i), n.attachShader(t, s), n.linkProgram(t), n.deleteShader(i), n.deleteShader(s), !n.getProgramParameter(t, n.LINK_STATUS)) {
    const r = n.getProgramInfoLog(t);
    throw n.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${r ?? "no reason given"}`
    );
  }
  return t;
}
function q(n, e, t) {
  const i = n.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (n.shaderSource(i, t), n.compileShader(i), !n.getShaderParameter(i, n.COMPILE_STATUS)) {
    const s = n.getShaderInfoLog(i);
    throw n.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return i;
}
const K = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Ze = 0.5, Ye = 3e3, J = 0.1, F = 16, ee = 'video/mp4; codecs="avc1.640029"';
let z = null;
function je(n = {}) {
  return z ??= qe(n), z;
}
async function rt(n = {}) {
  return (await je(n)).deinterlaces;
}
function nt() {
  z = null;
}
async function qe(n) {
  const e = n.tolerance ?? Ze, t = n.timeoutMs ?? Ye, i = performance.now(), s = (o) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: o instanceof Error ? o.message : String(o)
  });
  if (typeof document > "u")
    return s(new Error("there is no document to decode in"));
  const r = document.createElement("video");
  r.muted = !0, r.defaultMuted = !0, r.playsInline = !0, r.preload = "auto";
  let A = null;
  try {
    A = Je(r, t);
    const o = B(k(r, "loadeddata"), t), a = r.play().then(
      () => !0,
      () => !1
    );
    if (await A.ready, await o, await et(r, t, await a), r.videoWidth === 0 || r.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const c = tt(r);
    return {
      deinterlaces: c < 1 - e,
      survives: c,
      tookMs: performance.now() - i
    };
  } catch (o) {
    return s(o);
  } finally {
    r.pause(), r.removeAttribute("src"), r.replaceChildren(), r.load(), A && URL.revokeObjectURL(A.url);
  }
}
const N = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Ke = typeof MediaSource > "u";
function Je(n, e) {
  if (!N || !N.isTypeSupported(ee))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = K.indexOf(","), i = atob(K.slice(t + 1)), s = new Uint8Array(i.length);
  for (let a = 0; a < i.length; a++) s[a] = i.charCodeAt(a);
  const r = new N(), A = URL.createObjectURL(r);
  if (Ke) {
    n.disableRemotePlayback = !0;
    const a = document.createElement("source");
    a.type = "video/mp4", a.src = A, n.append(a), n.load();
  } else
    n.src = A;
  const o = (async () => {
    await B(k(r, "sourceopen"), e);
    const a = r.addSourceBuffer(ee), c = B(k(a, "updateend"), e);
    a.appendBuffer(s), await c, r.endOfStream();
  })();
  return { url: A, ready: o };
}
async function et(n, e, t) {
  if (t) {
    const i = performance.now();
    for (; n.currentTime < J && performance.now() - i < e; )
      await new Promise((s) => requestAnimationFrame(s));
    n.pause();
  } else
    n.currentTime = J, await B(k(n, "seeked"), e);
}
function tt(n) {
  const e = n.videoHeight, t = document.createElement("canvas");
  t.width = F, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(n, 0, 0, F, e);
  const s = i.getImageData(0, 0, F, e).data, r = (h) => {
    let f = 0;
    for (let d = 0; d < F; d++)
      f += s[(h * F + d) * 4 + 1] ?? 0;
    return f / F;
  };
  let A = 0;
  const o = 2, a = e - 3;
  let c = r(o);
  for (let h = o + 1; h <= a; h++) {
    const f = r(h);
    A += Math.abs(f - c), c = f;
  }
  return A / (a - o) / 255;
}
function k(n, e) {
  return new Promise((t, i) => {
    n.addEventListener(e, () => t(), { once: !0 }), n.addEventListener(
      "error",
      () => {
        const s = n instanceof HTMLMediaElement ? n.error : null, r = s ? ` (MediaError ${s.code}${s.message ? `: ${s.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${r}`));
      },
      { once: !0 }
    );
  });
}
function B(n, e) {
  return Promise.race([
    n,
    new Promise(
      (t, i) => setTimeout(
        () => i(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
Be(he);
export {
  st as Deinterlacer,
  De as YADIF_FRAGMENT_SHADER,
  Fe as YADIF_UNIFORMS,
  rt as decoderDeinterlaces,
  nt as forgetDecoderProbe,
  je as probeDecoder,
  it as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
