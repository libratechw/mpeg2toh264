const Ce = "" + new URL("assets/worker-DqNgmEDp.js", import.meta.url).href, ie = `#version 300 es
void main() {
  // From the vertex index alone. There is no geometry here worth a buffer.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;
function Z(o, e, t) {
  const i = o.createProgram(), s = de(o, o.VERTEX_SHADER, t), r = de(o, o.FRAGMENT_SHADER, e);
  if (o.attachShader(i, s), o.attachShader(i, r), o.linkProgram(i), o.deleteShader(s), o.deleteShader(r), !o.getProgramParameter(i, o.LINK_STATUS)) {
    const n = o.getProgramInfoLog(i);
    throw o.deleteProgram(i), new Error(
      `the deinterlacer failed to link: ${n ?? "no reason given"}`
    );
  }
  return i;
}
function de(o, e, t) {
  const i = o.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (o.shaderSource(i, t), o.compileShader(i), !o.getShaderParameter(i, o.COMPILE_STATUS)) {
    const s = o.getShaderInfoLog(i);
    throw o.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return i;
}
const Pe = `#version 300 es
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
`, Le = `#version 300 es
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
function Be(o, e) {
  const t = Z(o, Pe, Le), i = o.getAttribLocation(t, "aVertexPosition"), s = o.getAttribLocation(t, "aTextureCoord"), r = o.getUniformLocation(t, "uTexture"), n = o.getUniformLocation(t, "uMatrix"), a = o.getUniformLocation(t, "uUvMatrix"), A = o.getUniformLocation(t, "uTextColor"), l = o.getUniformLocation(t, "uBackColor");
  if (r == null || n == null || a == null || A == null || l == null)
    throw new Error(
      "failed to initialize DEBUG_FRAGMENT_SHADER, DEBUG_VERTEX_SHADER"
    );
  const h = o.createBuffer(), d = o.createBuffer();
  return {
    gl: o,
    ...ke(o, e),
    program: t,
    programUniforms: {
      vertex: i,
      textureCoord: s,
      texture: r,
      matrix: n,
      uvMatrix: a,
      textColor: A,
      backColor: l
    },
    positionBuffer: h,
    textureBuffer: d
  };
}
function ke(o, e) {
  const t = new OffscreenCanvas(0, 0), i = t.getContext("2d"), s = /* @__PURE__ */ new Map();
  let r = 0;
  const n = 0;
  let a = 1;
  i.font = e, i.fillStyle = "white";
  for (let l = 32; l < 128; l++) {
    const h = String.fromCharCode(l), d = i.measureText(h), u = Math.ceil(
      d.actualBoundingBoxDescent + d.actualBoundingBoxAscent + 1
    ), c = Math.ceil(
      d.actualBoundingBoxLeft + d.actualBoundingBoxRight + 1
    );
    s.set(h, {
      x: r,
      y: n,
      width: c,
      height: u,
      metrics: d
    }), a = Math.max(a, u), r += c;
  }
  t.width = r, t.height = a, i.font = e, i.fillStyle = "white";
  for (const [l, h] of s)
    i.fillText(
      l,
      Math.floor(h.x + h.metrics.actualBoundingBoxLeft + 1),
      Math.floor(h.metrics.actualBoundingBoxAscent + 1)
    );
  const A = o.createTexture();
  return o.bindTexture(o.TEXTURE_2D, A), o.texParameteri(o.TEXTURE_2D, o.TEXTURE_MIN_FILTER, o.LINEAR), o.texParameteri(o.TEXTURE_2D, o.TEXTURE_MAG_FILTER, o.LINEAR), o.texParameteri(o.TEXTURE_2D, o.TEXTURE_WRAP_S, o.CLAMP_TO_EDGE), o.texParameteri(o.TEXTURE_2D, o.TEXTURE_WRAP_T, o.CLAMP_TO_EDGE), o.texImage2D(o.TEXTURE_2D, 0, o.RGBA, o.RGBA, o.UNSIGNED_BYTE, t), { fontTexture: A, chars: s, textureSize: { width: r, height: a } };
}
function Ie(o) {
  const e = o.gl;
  e.deleteBuffer(o.positionBuffer), e.deleteBuffer(o.textureBuffer), e.deleteTexture(o.fontTexture), e.deleteProgram(o.program);
}
function Ue(o, e, t, i, s, r, n) {
  const a = [], A = [], l = t;
  for (const u of e) {
    if (u === `
`) {
      t = l, i += n;
      continue;
    }
    const c = o.chars.get(u);
    if (c == null)
      continue;
    if (c.width === 1) {
      t += c.metrics.width;
      continue;
    }
    const m = Math.floor(t - c.metrics.actualBoundingBoxLeft), E = Math.floor(i - c.metrics.actualBoundingBoxAscent), x = m + c.width, v = E + c.height;
    a.push(m, E), A.push(c.x, c.y), a.push(m, v), A.push(c.x, c.y + c.height), a.push(m + c.width, v), A.push(c.x + c.width, c.y + c.height), a.push(x, v), A.push(c.x + c.width, c.y + c.height), a.push(m, E), A.push(c.x, c.y), a.push(x, E), A.push(c.x + c.width, c.y), t += c.metrics.width;
  }
  const h = o.gl;
  h.useProgram(o.program), h.bindBuffer(h.ARRAY_BUFFER, o.positionBuffer), h.bufferData(h.ARRAY_BUFFER, new Float32Array(a), h.STATIC_DRAW), h.vertexAttribPointer(
    o.programUniforms.vertex,
    2,
    h.FLOAT,
    !1,
    0,
    0
  ), h.enableVertexAttribArray(o.programUniforms.vertex), h.bindBuffer(h.ARRAY_BUFFER, o.textureBuffer), h.bufferData(
    h.ARRAY_BUFFER,
    new Float32Array(A),
    h.STATIC_DRAW
  ), h.vertexAttribPointer(
    o.programUniforms.textureCoord,
    2,
    h.FLOAT,
    !1,
    0,
    0
  ), h.enableVertexAttribArray(o.programUniforms.textureCoord), h.activeTexture(h.TEXTURE0), h.bindTexture(h.TEXTURE_2D, o.fontTexture), h.uniform1i(o.programUniforms.texture, 0), h.uniform3fv(o.programUniforms.textColor, [1, 1, 1]), h.uniform3fv(o.programUniforms.backColor, [0, 0, 0]);
  function d(u, c, m) {
    const E = [];
    for (let x = 0; x < c; x++)
      for (let v = 0; v < u; v++)
        E.push(m[v * u + x]);
    return E;
  }
  h.uniformMatrix4fv(o.programUniforms.matrix, !1, d(4, 4, [
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
  ])), h.uniformMatrix3fv(o.programUniforms.uvMatrix, !1, d(3, 3, [
    1 / o.textureSize.width,
    0,
    0,
    0,
    1 / o.textureSize.height,
    0,
    0,
    0,
    1
  ])), h.viewport(0, 0, s, r), h.enable(h.BLEND), h.blendFunc(h.SRC_ALPHA, h.ONE_MINUS_SRC_ALPHA), h.drawArrays(h.TRIANGLES, 0, a.length / 2), h.disable(h.BLEND);
}
const b = {
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
}, k = 7, Fe = 2, ae = 1, Ne = 2, le = 5, Oe = {
  a: "uA",
  b: "uB",
  fieldMetrics: "uFieldMetrics",
  first: "uFirst",
  size: "uSize"
}, De = 16, Re = 8, Ge = `#version 300 es

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
  const int BLOCK_W = ${De};
  const int BLOCK_H = ${Re};

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

  float run = texelFetch(uFieldMetrics, ivec2(${b.phase}, 0), 0)[1];
  float threshold = run == 0.0 ? 0.025 : (run <= 10.0 ? 0.11 : 0.15);

  vec4 even = measure(diffEven, float(totalEven), threshold);
  vec4 odd = measure(diffOdd, float(totalOdd), threshold);
  outFirst = uFirst == 0 ? even : odd;
  outSecond = uFirst == 0 ? odd : even;
}
`, ze = {
  second: "uSecond",
  first: "uFirst",
  size: "uSize"
}, V = 8, Xe = `#version 300 es
precision highp float;

uniform sampler2D uSecond;
uniform sampler2D uFirst;

uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

void main()
{
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 base = dst * ${V};

  vec4 second = vec4(0.0);
  vec4 first = vec4(0.0);

  for (int y = 0; y < ${V}; ++y) {
    for (int x = 0; x < ${V}; ++x) {
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
`, He = {
  previous: "uPrevious",
  second: "uSecond",
  first: "uFirst",
  size: "uSize"
}, We = `#version 300 es
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
  return differing <= ${Fe}.0;
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
  bool believed = run >= ${le}.0;
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
  if (metric == ${b.firstRepeatsPrevious}) {
    outValue = previous(${b.firstRepeatsNext});
  } else if (metric == ${b.secondRepeatsNext}) {
    outValue = fold(uSecond);
  } else if (metric == ${b.secondRepeatsPrevious}) {
    outValue = previous(${b.secondRepeatsNext});
  } else if (metric == ${b.previousSecondRepeated}) {
    outValue = previous(${b.secondRepeatsPrevious});
  } else if (metric == ${b.firstRepeatsNext}) {
    outValue = fold(uFirst);
  } else if (metric == ${b.previousFirstRepeated}) {
    outValue = previous(${b.firstRepeatsPrevious});
  } else {
    outValue = decide(
      previous(${b.phase}),
      previous(${b.firstRepeatsNext}),
      fold(uSecond),
      previous(${b.secondRepeatsNext}),
      previous(${b.secondRepeatsPrevious}),
      fold(uFirst),
      previous(${b.firstRepeatsPrevious})
    );
  }
}
`, Ve = {
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
}, Ye = `#version 300 es
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
  return texelFetch(uFieldMetrics, ivec2(metric, 0), 0)[1] <= ${Fe}.0;
}

/** The pulldown phase the detection gave this frame, or 0. See film-shader.ts. */
int detectedPhase() {
  vec4 phase = texelFetch(uFieldMetrics, ivec2(${b.phase}, 0), 0);
  // Deinterlace each field normally until the cadence is confirmed.
  return phase[1] >= ${le}.0 ? int(phase[0]) : 0;
}

bool isMixedPhase(int phase) {
  return phase == ${ae} || phase == ${Ne};
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
`, se = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  topFieldFirst: "uTopFieldFirst",
  match: "uMatch"
}, S = 288, _ = 162, $e = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uNext;
uniform ivec2 uSize;
out vec4 fragColor;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

int sourceY(int targetY, int targetHeight) {
  // Scale both fields independently so every adjacent target row still
  // alternates parity. A direct full-frame scale can select only one parity
  // when the source-to-target ratio is even, erasing the borrowed field.
  int parity = targetY & 1;
  int sourceFieldHeight = uSize.y / 2;
  int targetFieldHeight = targetHeight / 2;
  int fieldY = (targetY / 2) * sourceFieldHeight / targetFieldHeight;
  return clamp(fieldY * 2 + parity, 0, uSize.y - 1);
}

void main() {
  ivec2 targetSize = ivec2(${S}, ${_});
  ivec2 target = ivec2(gl_FragCoord.xy);
  // readPixels returns the framebuffer's bottom row first, so writing the
  // source's top row there gives JavaScript a conventional top-origin image.
  int y = target.y;
  int sourceX = clamp(target.x * uSize.x / targetSize.x, 0, uSize.x - 1);
  int sourceRow = sourceY(y, targetSize.y);
  ivec2 source = ivec2(sourceX, sourceRow);
  fragColor = vec4(
    luma(texelFetch(uPrev, source, 0).rgb),
    luma(texelFetch(uCur, source, 0).rgb),
    luma(texelFetch(uNext, source, 0).rgb),
    1.0
  );
}
`, Qe = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uNext;
uniform ivec2 uSize;
uniform int uTopFieldFirst;
uniform int uMatch;

out vec4 fragColor;

void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  int y = uSize.y - 1 - at.y;
  // p/n borrow the matched field from a neighbour after converting the
  // framebuffer's bottom-origin coordinate to the frame's top-origin row.
  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;
  if ((y & 1) != borrowedParity || uMatch == 1) {
    fragColor = texelFetch(uCur, ivec2(at.x, y), 0);
  } else if (uMatch == 0) {
    fragColor = texelFetch(uPrev, ivec2(at.x, y), 0);
  } else {
    fragColor = texelFetch(uNext, ivec2(at.x, y), 0);
  }
}
`, Ze = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uNext;
uniform ivec2 uSize;
uniform int uTopFieldFirst;
uniform int uMatch;

out vec4 fragColor;

void main() {
  ivec2 targetSize = ivec2(${S}, ${_});
  ivec2 target = ivec2(gl_FragCoord.xy);
  int x = clamp(target.x * uSize.x / targetSize.x, 0, uSize.x - 1);
  // The bottom framebuffer row becomes the first readPixels row, so it holds
  // the source's top row for the CPU's top-origin decimate blocks.
  int targetY = target.y;
  int parity = targetY & 1;
  int fieldY = (targetY / 2) * (uSize.y / 2) / (targetSize.y / 2);
  int y = clamp(fieldY * 2 + parity, 0, uSize.y - 1);
  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;
  if ((y & 1) != borrowedParity || uMatch == 1) {
    fragColor = texelFetch(uCur, ivec2(x, y), 0);
  } else if (uMatch == 0) {
    fragColor = texelFetch(uPrev, ivec2(x, y), 0);
  } else {
    fragColor = texelFetch(uNext, ivec2(x, y), 0);
  }
}
`;
class F {
  static CYCLE = 5;
  static COMB_THRESHOLD = 9;
  static COMBED_PIXEL_LIMIT = 80;
  static DECIMATE_BLOCK = 32;
  static DUPLICATE_PERCENT = 1.1;
  #s;
  #r;
  #e;
  #n = 0;
  #t = null;
  #i = [];
  #a = null;
  #o = 1 / 0;
  #l = 1 / 0;
  constructor(e, t) {
    this.#s = e, this.#r = t, this.#e = 255 * F.DECIMATE_BLOCK ** 2 * F.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, s, r = F.COMBED_PIXEL_LIMIT) {
    const n = s ? 1 : 0, a = { p: e, c: t, n: i };
    let A = this.#u("c", "p", n, a);
    const l = /* @__PURE__ */ new Map(), h = (E) => {
      const x = l.get(E);
      if (x !== void 0) return x;
      const v = F.#h(
        this.weave(e, t, i, E, s),
        this.#s,
        this.#r
      );
      return l.set(E, v), v;
    }, d = h(A), u = h("n");
    (u * 3 < d || u * 2 < d && d > r) && Math.abs(u - d) >= 30 && u < r && (A = "n");
    const c = h(A), m = c >= r;
    return m && (A = "c"), {
      match: A,
      combScore: c,
      isCombed: m,
      luma: this.weave(e, t, i, A, s)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#n, i = this.#a ? F.#p(
      this.#a,
      e,
      this.#s,
      this.#r
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#i.push(i);
    const s = this.#t === t, r = s && i.maxBlockDifference < this.#e;
    s && !r && (this.#t = null);
    const n = this.#t;
    this.#a = e.slice(), this.#n++;
    let a = this.#t;
    if (this.#n === F.CYCLE) {
      let A = 0, l = null;
      for (let h = 1; h < this.#i.length; h++)
        (this.#i[h]?.maxBlockDifference ?? 1 / 0) < (this.#i[A]?.maxBlockDifference ?? 1 / 0) ? (l = A, A = h) : (l === null || (this.#i[h]?.maxBlockDifference ?? 1 / 0) < (this.#i[l]?.maxBlockDifference ?? 1 / 0)) && (l = h);
      this.#o = this.#i[A]?.maxBlockDifference ?? 1 / 0, this.#l = l === null ? 1 / 0 : this.#i[l]?.maxBlockDifference ?? 1 / 0, a = (this.#i[A]?.maxBlockDifference ?? 1 / 0) < this.#e ? A : null, this.#t = a, this.#i = [], this.#n = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: r,
      dropIndex: n,
      nextDropIndex: a,
      lowestCycleDifference: this.#o,
      runnerUpCycleDifference: this.#l
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, s, r) {
    if (s === "c") return t.slice();
    const n = t.slice(), a = s === "p" ? e : i, A = n.length / this.#r, l = r ? 1 : 0;
    for (let h = l; h < this.#r; h += 2)
      n.set(
        a.subarray(h * A, (h + 1) * A),
        h * A
      );
    return n;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#n = 0, this.#t = null, this.#i = [], this.#a = null, this.#o = 1 / 0, this.#l = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #u(e, t, i, s) {
    const r = this.#s, n = this.#r, a = 2 - i, A = 2 - i, l = s[e], h = s[t], d = F.#E(
      l,
      h,
      r,
      n,
      i
    );
    let u = 0, c = 0, m = 0, E = 0, x = 0, v = 0;
    for (let L = 2; L < n - 2; L += 2) {
      const D = (L - 2) / 2, J = a - 1 + D * 2, ee = a + 1 + D * 2, te = a + 3 + D * 2, Y = a + D * 2, H = Y + 2, O = A + D * 2, C = O + 2, ue = a + D * 2;
      for (let M = 8; M < r - 8; M++) {
        const B = (d[ue * r + M] ?? 0) | (d[(ue + 2) * r + M] ?? 0);
        if (B === 0) continue;
        const fe = (s.c[J * r + M] ?? 0) + ((s.c[ee * r + M] ?? 0) << 2) + (s.c[te * r + M] ?? 0), G = Math.abs(
          3 * ((l[Y * r + M] ?? 0) + (l[H * r + M] ?? 0)) - fe
        ), z = Math.abs(
          3 * ((h[O * r + M] ?? 0) + (h[C * r + M] ?? 0)) - fe
        );
        G > 23 && (B & 1) !== 0 && (u += G), z > 23 && (B & 1) !== 0 && (E += z), G > 42 && (B & 2) !== 0 && (c += G), z > 42 && (B & 2) !== 0 && (x += z), G > 42 && (B & 4) !== 0 && (m += G), z > 42 && (B & 4) !== 0 && (v += z);
      }
    }
    c < 500 && x < 500 && (m >= 500 || v >= 500) && Math.max(m, v) > 3 * Math.min(m, v) && (c = m, x = v);
    const g = Math.floor(u / 6 + 0.5), w = Math.floor(E / 6 + 0.5), f = Math.floor(c / 6 + 0.5), p = Math.floor(x / 6 + 0.5), y = Math.max(g, w) / Math.max(Math.min(g, w), 1), R = Math.max(f, p) / Math.max(Math.min(f, p), 1), P = Math.max(f, p) / Math.max(Math.max(g, w), 1);
    return (f >= 500 || p >= 500) && (f * 2 < p || p * 2 < f) || (f >= 1e3 || p >= 1e3) && (f * 3 < p * 2 || p * 3 < f * 2) || (f >= 2e3 || p >= 2e3) && (f * 5 < p * 4 || p * 5 < f * 4) || (f >= 4e3 || p >= 4e3) && R > y || P > 5e-3 && Math.max(f, p) > 150 && (f * 2 < p || p * 2 < f) ? f > p ? t : e : g > w ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #E(e, t, i, s, r) {
    const n = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(i)
    ), a = r === 1 ? 1 : 0;
    for (let h = 0; h < n.length; h++) {
      const d = Math.min(s - 1, a + h * 2), u = n[h];
      if (u)
        for (let c = 0; c < i; c++)
          u[c] = Math.abs(
            (e[d * i + c] ?? 0) - (t[d * i + c] ?? 0)
          );
    }
    const A = new Uint8Array(i * s), l = r === 1 ? 3 : 2;
    for (let h = 1; h < n.length - 1; h++) {
      const d = l + (h - 1) * 2;
      if (d >= s) break;
      const u = n[h];
      if (u)
        for (let c = 1; c < i - 1; c++) {
          const m = u[c] ?? 0;
          if (m <= 3) continue;
          let E = 0;
          for (let p = c - 1; p <= c + 1; p++)
            E += (n[h - 1]?.[p] ?? 0) > 3 ? 1 : 0, E += (n[h]?.[p] ?? 0) > 3 ? 1 : 0, E += (n[h + 1]?.[p] ?? 0) > 3 ? 1 : 0;
          if (E <= 1) continue;
          const x = d * i + c;
          if (A[x] = 1, m <= 19) continue;
          E = 0;
          let v = !1, g = !1;
          for (let p = c - 1; p <= c + 1; p++)
            (n[h - 1]?.[p] ?? 0) > 19 && (E++, v = !0), (n[h]?.[p] ?? 0) > 19 && E++, (n[h + 1]?.[p] ?? 0) > 19 && (E++, g = !0);
          if (E <= 3) continue;
          if (v && g) {
            A[x] |= 2;
            continue;
          }
          let w = !1, f = !1;
          for (let p = Math.max(c - 4, 0); p < Math.min(c + 5, i); p++)
            h !== 1 && (n[h - 2]?.[p] ?? 0) > 19 && (w = !0), (n[h - 1]?.[p] ?? 0) > 19 && (v = !0), (n[h + 1]?.[p] ?? 0) > 19 && (g = !0), h !== n.length - 2 && (n[h + 2]?.[p] ?? 0) > 19 && (f = !0);
          v && (g || w) || g && (v || f) ? A[x] |= 2 : E > 5 && (A[x] |= 4);
        }
    }
    return A;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #h(e, t, i) {
    const s = new Uint8Array(t * i);
    for (let n = 0; n < i; n++) {
      const a = n * t, A = Math.max(0, Math.min(i - 1, n === 0 ? 1 : n - 1)) * t, l = Math.max(
        0,
        Math.min(i - 1, n === i - 1 ? i - 2 : n + 1)
      ) * t, h = Math.max(0, Math.min(i - 1, n < 2 ? n === 0 ? 2 : 3 : n - 2)) * t, d = Math.max(
        0,
        Math.min(
          i - 1,
          n + 2 >= i ? n === i - 1 ? i - 3 : i - 4 : n + 2
        )
      ) * t;
      for (let u = 0; u < t; u++) {
        const c = e[a + u] ?? 0, m = e[A + u] ?? 0, E = e[l + u] ?? 0, x = e[h + u] ?? 0, v = e[d + u] ?? 0;
        (n === 0 ? Math.abs(c - E) > F.COMB_THRESHOLD : n === i - 1 ? Math.abs(c - m) > F.COMB_THRESHOLD : Math.abs(c - m) > F.COMB_THRESHOLD && Math.abs(c - E) > F.COMB_THRESHOLD) && Math.abs(
          4 * c - 3 * (m + E) + x + v
        ) > F.COMB_THRESHOLD * 6 && (s[a + u] = 255);
      }
    }
    let r = 0;
    for (const n of [0, 8])
      for (const a of [0, 8])
        for (let A = n; A < i; A += 16)
          for (let l = a; l < t; l += 16) {
            let h = 0;
            for (let d = Math.max(1, A); d < Math.min(i - 1, A + 16); d++)
              for (let u = l; u < Math.min(t, l + 16); u++) {
                const c = d * t + u;
                s[c - t] === 255 && s[c] === 255 && s[c + t] === 255 && h++;
              }
            r = Math.max(r, h);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #p(e, t, i, s) {
    const r = F.DECIMATE_BLOCK / 2, n = Math.ceil(i / r), a = Math.ceil(s / r), A = new Float64Array(n * a), l = e.length / (i * s);
    for (let u = 0; u < s; u++) {
      const c = Math.floor(u / r);
      for (let m = 0; m < i; m++) {
        const E = Math.floor(m / r), x = c * n + E, v = (u * i + m) * l;
        if (l === 1) {
          A[x] = (A[x] ?? 0) + Math.abs((e[v] ?? 0) - (t[v] ?? 0));
          continue;
        }
        const g = Math.round(
          (e[v] ?? 0) * 0.2126 + (e[v + 1] ?? 0) * 0.7152 + (e[v + 2] ?? 0) * 0.0722
        ), w = Math.round(
          (t[v] ?? 0) * 0.2126 + (t[v + 1] ?? 0) * 0.7152 + (t[v + 2] ?? 0) * 0.0722
        );
        if (A[x] = (A[x] ?? 0) + Math.abs(g - w), (m & 1) !== 0 || (u & 1) !== 0) continue;
        let f = 0, p = 0, y = 0, R = 0, P = 0, L = 0, D = 0;
        for (let H = u; H < Math.min(u + 2, s); H++)
          for (let O = m; O < Math.min(m + 2, i); O++) {
            const C = (H * i + O) * l;
            f += e[C] ?? 0, p += e[C + 1] ?? 0, y += e[C + 2] ?? 0, R += t[C] ?? 0, P += t[C + 1] ?? 0, L += t[C + 2] ?? 0, D++;
          }
        const J = Math.round(
          (-0.114572 * f - 0.385428 * p + 0.5 * y) / D
        ), ee = Math.round(
          (-0.114572 * R - 0.385428 * P + 0.5 * L) / D
        ), te = Math.round(
          (0.5 * f - 0.454153 * p - 0.045847 * y) / D
        ), Y = Math.round(
          (0.5 * R - 0.454153 * P - 0.045847 * L) / D
        );
        A[x] = (A[x] ?? 0) + Math.abs(J - ee) + Math.abs(te - Y);
      }
    }
    let h = -1;
    for (let u = 0; u < a - 1; u++)
      for (let c = 0; c < n - 1; c++)
        h = Math.max(
          h,
          (A[u * n + c] ?? 0) + (A[u * n + c + 1] ?? 0) + (A[(u + 1) * n + c] ?? 0) + (A[(u + 1) * n + c + 1] ?? 0)
        );
    let d = 0;
    for (const u of A) d += u;
    return { maxBlockDifference: h, totalDifference: d };
  }
}
const I = { phase: 0, run: 0 };
function re(o, e, t) {
  return Object.fromEntries(
    Object.entries(t).map(([i, s]) => [
      i,
      o.getUniformLocation(e, s)
    ])
  );
}
class me {
  #s;
  #r;
  #e;
  #n;
  #t;
  #i;
  #a;
  /** The block comparisons of both fields, and the same folded most of the way. */
  #o = null;
  #l = null;
  /** The field metrics (see FIELD_METRICS) of this frame and the one before. */
  #u = null;
  /** Which of the two holds the newest metrics. */
  #E = 0;
  /** The metrics being read back asynchronously. */
  #h = null;
  #p = null;
  #x = 0;
  #F = 0;
  /** The last metrics read back, laid out as FIELD_METRICS says. */
  metrics = new Float32Array(k * 4);
  #f = 0;
  #g = 0;
  constructor(e) {
    this.#s = e, this.#r = Z(
      e,
      Ge,
      ie
    ), this.#e = re(
      e,
      this.#r,
      Oe
    ), this.#n = Z(
      e,
      Xe,
      ie
    ), this.#t = re(
      e,
      this.#n,
      ze
    ), this.#i = Z(
      e,
      We,
      ie
    ), this.#a = re(e, this.#i, He);
  }
  /** The newest measurements, or null before any frame has been measured. */
  get texture() {
    return this.#u?.[this.#E]?.textures[0] ?? null;
  }
  /** The size of the frames to be measured, which sizes the block grid. */
  resize(e, t) {
    e === this.#f && t === this.#g || (this.#f = e, this.#g = t, this.#D());
  }
  /** Forget every measurement: the next frame starts a cycle from nothing. */
  reset() {
    const e = this.#s;
    e.deleteSync(this.#p), this.#p = null, this.#x = 0;
    const t = this.#u?.[this.#E];
    if (!t) return;
    const i = new Float32Array(k * 4);
    for (let s = 0; s < b.phase; s++)
      i[s * 4 + 1] = 1;
    e.bindTexture(e.TEXTURE_2D, t.textures[0] ?? null), e.texSubImage2D(
      e.TEXTURE_2D,
      0,
      0,
      0,
      k,
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
    const s = this.#s;
    if (this.#f === 0 || this.#g === 0) return;
    this.#w();
    const r = this.#o, n = this.#l, a = this.#u;
    if (r === null || n === null || a === null) return;
    const A = a[this.#E], l = a[1 - this.#E];
    if (s.bindFramebuffer(s.FRAMEBUFFER, r.framebuffer), s.useProgram(this.#r), this.#d(0, e, this.#e.a), this.#d(1, t, this.#e.b), this.#d(2, A.textures[0], this.#e.fieldMetrics), s.uniform1i(this.#e.first, i), s.uniform2i(this.#e.size, this.#f, this.#g), s.viewport(0, 0, r.width, r.height), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, n.framebuffer), s.useProgram(this.#n), this.#d(0, r.textures[0], this.#t.second), this.#d(1, r.textures[1], this.#t.first), s.uniform2i(this.#t.size, r.width, r.height), s.viewport(0, 0, n.width, n.height), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, l.framebuffer), s.useProgram(this.#i), this.#d(0, A.textures[0], this.#a.previous), this.#d(1, n.textures[0], this.#a.second), this.#d(2, n.textures[1], this.#a.first), s.uniform2i(this.#a.size, n.width, n.height), s.viewport(0, 0, k, 1), s.drawArrays(s.TRIANGLES, 0, 3), this.#E = 1 - this.#E, this.#x++, this.#p !== null) {
      s.bindFramebuffer(s.FRAMEBUFFER, null);
      return;
    }
    this.#F = this.#x, s.bindBuffer(s.PIXEL_PACK_BUFFER, this.#h), s.readPixels(0, 0, k, 1, s.RGBA, s.FLOAT, 0), s.bindBuffer(s.PIXEL_PACK_BUFFER, null), s.bindFramebuffer(s.FRAMEBUFFER, null), this.#p = s.fenceSync(s.SYNC_GPU_COMMANDS_COMPLETE, 0), s.flush();
  }
  /**
   * The phase of the last frame measured, once the GPU has handed it back,
   * and null while it is still on its way. It is handed back once.
   */
  poll() {
    const e = this.#s, t = this.#p;
    if (t === null || this.#h === null) return null;
    switch (e.clientWaitSync(t, 0, 0)) {
      case e.ALREADY_SIGNALED:
      case e.CONDITION_SATISFIED:
        return e.bindBuffer(e.PIXEL_PACK_BUFFER, this.#h), e.getBufferSubData(e.PIXEL_PACK_BUFFER, 0, this.metrics), e.bindBuffer(e.PIXEL_PACK_BUFFER, null), e.deleteSync(t), this.#p = null, {
          phase: this.metrics[b.phase * 4] ?? 0,
          run: this.metrics[b.phase * 4 + 1] ?? 0,
          age: this.#x - this.#F
        };
      default:
        return null;
    }
  }
  destroy() {
    const e = this.#s;
    if (this.#D(), this.#u !== null) {
      for (const t of this.#u) j(e, t);
      this.#u = null;
    }
    e.deleteSync(this.#p), this.#p = null, e.deleteBuffer(this.#h), this.#h = null, e.deleteProgram(this.#r), e.deleteProgram(this.#n), e.deleteProgram(this.#i);
  }
  #d(e, t, i) {
    const s = this.#s;
    s.activeTexture(s.TEXTURE0 + e), s.bindTexture(s.TEXTURE_2D, t ?? null), s.uniform1i(i, e);
  }
  #D() {
    const e = this.#s;
    this.#o !== null && j(e, this.#o), this.#l !== null && j(e, this.#l), this.#o = null, this.#l = null;
  }
  /** Everything detect needs that is not there yet. */
  #w() {
    const e = this.#s;
    if (this.#o === null || this.#l === null) {
      this.#D();
      const t = Math.ceil(this.#f / De), i = Math.ceil(this.#g / (Re * 2));
      this.#o = $(e, t, i, 2), this.#l = $(
        e,
        Math.ceil(t / V),
        Math.ceil(i / V),
        2
      );
    }
    this.#u === null && (this.#u = [
      $(e, k, 1, 1),
      $(e, k, 1, 1)
    ], this.#E = 0, this.reset()), this.#h === null && (this.#h = e.createBuffer(), e.bindBuffer(e.PIXEL_PACK_BUFFER, this.#h), e.bufferData(
      e.PIXEL_PACK_BUFFER,
      this.metrics.byteLength,
      e.STREAM_READ
    ), e.bindBuffer(e.PIXEL_PACK_BUFFER, null));
  }
}
function $(o, e, t, i) {
  const s = o.createFramebuffer();
  o.bindFramebuffer(o.FRAMEBUFFER, s);
  const r = [];
  for (let A = 0; A < i; A++) {
    const l = o.createTexture();
    o.bindTexture(o.TEXTURE_2D, l), o.texParameteri(o.TEXTURE_2D, o.TEXTURE_MIN_FILTER, o.NEAREST), o.texParameteri(o.TEXTURE_2D, o.TEXTURE_MAG_FILTER, o.NEAREST), o.texImage2D(
      o.TEXTURE_2D,
      0,
      o.RGBA32F,
      e,
      t,
      0,
      o.RGBA,
      o.FLOAT,
      null
    ), o.framebufferTexture2D(
      o.FRAMEBUFFER,
      o.COLOR_ATTACHMENT0 + A,
      o.TEXTURE_2D,
      l,
      0
    ), r.push(l);
  }
  o.drawBuffers(r.map((A, l) => o.COLOR_ATTACHMENT0 + l));
  const n = o.checkFramebufferStatus(o.FRAMEBUFFER) === o.FRAMEBUFFER_COMPLETE;
  o.bindFramebuffer(o.FRAMEBUFFER, null);
  const a = { framebuffer: s, textures: r, width: e, height: t };
  if (!n)
    throw j(o, a), new Error("failed to allocate framebuffer");
  return a;
}
function j(o, { framebuffer: e, textures: t }) {
  o.deleteFramebuffer(e);
  for (const i of t) o.deleteTexture(i);
}
function N(o, e = 0, t = o.length) {
  const i = new DataView(o.buffer, o.byteOffset, o.byteLength), s = [];
  for (let r = e; r < t; ) {
    if (r + 8 > t) throw new Error("Incomplete MP4 box");
    const n = i.getUint32(r);
    if (n < 8 || r + n > t) throw new Error("Invalid MP4 box size");
    s.push({
      type: String.fromCharCode(...o.subarray(r + 4, r + 8)),
      start: r,
      body: r + 8,
      end: r + n
    }), r += n;
  }
  return s;
}
function je(o, e) {
  for (const t of N(o, e.body, e.end).filter(
    (i) => i.type === "trak"
  )) {
    let i = t;
    for (const s of ["mdia", "minf", "stbl", "stsd"]) {
      const r = N(o, i.body, i.end).find(
        (n) => n.type === s
      );
      if (!r) break;
      i = r;
    }
    if (i.type === "stsd")
      for (const s of N(o, i.body + 8, i.end)) {
        if (s.type !== "avc1") continue;
        const r = N(o, s.body + 78, s.end).find(
          (A) => A.type === "avcC"
        );
        if (!r) throw new Error("AVC sample entry has no avcC");
        const n = o.slice(r.body, r.end);
        return { codec: "avc1." + Array.from(n.subarray(1, 4)).map((A) => A.toString(16).padStart(2, "0")).join(""), description: n };
      }
  }
  return null;
}
class qe {
  #s;
  #r = null;
  #e = null;
  /** Compressed frames within the MSE buffer, retained at normal speed for seeks and later accelerated playback. */
  #n = [];
  #t = 0;
  #i = null;
  #a = [];
  /** Timestamps of one-tick duplicate pictures needed only as open-GOP decoding references. */
  #o = /* @__PURE__ */ new Set();
  #l = !1;
  #u = !1;
  #E = !1;
  #h = !1;
  #p = !1;
  #x = /* @__PURE__ */ new WeakMap();
  constructor(e) {
    this.#s = e, e.addEventListener("seeking", this.#f), e.addEventListener("ratechange", this.#f);
  }
  get active() {
    return this.#h;
  }
  /** Receive input in MSE append order; the caller retains ownership of the original ArrayBuffer. */
  append(e) {
    if (this.#E) return;
    const t = new Uint8Array(e), i = new DataView(e);
    try {
      for (const r of N(t)) {
        if (r.type === "moov") {
          this.#r = je(t, r);
          const n = this.#r;
          n && VideoDecoder.isConfigSupported(n).then((a) => {
            this.#x.set(n, a.supported === !0);
          }).catch((a) => this.#g(a));
        }
        if (!(r.type !== "moof" || this.#r === null))
          for (const n of N(t, r.body, r.end).filter(
            (a) => a.type === "traf"
          )) {
            const a = N(t, n.body, n.end), A = a.find((m) => m.type === "tfhd");
            if (!A || i.getUint32(A.body + 4) !== 1) continue;
            const l = a.find((m) => m.type === "tfdt"), h = a.find((m) => m.type === "trun");
            if (!l || !h || i.getUint32(l.body) !== 16777216 || i.getUint32(h.body) !== 16781057)
              throw new Error("Unexpected mpeg2toh264 video fragment layout");
            let d = Number(i.getBigUint64(l.body + 4)), u = r.start + i.getInt32(h.body + 8);
            const c = i.getUint32(h.body + 4);
            if (h.body + 12 + c * 16 > h.end)
              throw new Error("Incomplete video samples");
            for (let m = 0; m < c; m++) {
              const E = h.body + 12 + m * 16, x = i.getUint32(E), v = i.getUint32(E + 4), g = i.getUint32(E + 8), w = i.getInt32(E + 12);
              if (u < 0 || u + v > t.length)
                throw new Error("Video sample outside fragment");
              this.#n.push({
                config: this.#r,
                decodeTime: d / 9e4,
                timestamp: Math.round((d + w) * 1e6 / 9e4),
                duration: Math.round(x * 1e6 / 9e4),
                type: g & 65536 ? "delta" : "key",
                data: t.subarray(u, u + v)
              }), d += x, u += v;
            }
          }
      }
      const s = this.#s.buffered;
      if (s.length > 0) {
        let r = 0;
        for (let n = 0; n < (this.#h ? this.#t : this.#n.length); n++) {
          const a = this.#n[n];
          a.type === "key" && a.timestamp / 1e6 <= s.start(0) && (r = n);
        }
        r > 0 && (this.#n.splice(0, r), this.#t = Math.max(0, this.#t - r));
      }
    } catch (s) {
      this.#g(s);
    }
  }
  /** Return undefined to use the video element, or null to wait for the next decoded frame. */
  take() {
    if (this.#E || this.#s.playbackRate <= 1.25 || this.#r === null || this.#x.get(this.#r) !== !0) {
      this.#h && this.#f();
      return;
    }
    this.#h || (this.#f(), this.#h = !0);
    const e = this.#s.currentTime;
    try {
      for (; this.#t < this.#n.length && (this.#i?.decodeQueueSize ?? 0) < 6 && this.#a.length < 12; ) {
        const i = this.#n[this.#t];
        if (i.decodeTime > e + 0.25) break;
        if (this.#e !== i.config) {
          if (this.#i) {
            if (!this.#u) {
              this.#u = !0;
              const r = this.#i;
              r.flush().then(() => {
                this.#i === r && (r.close(), this.#i = null, this.#e = null, this.#u = !1);
              }).catch((n) => {
                this.#i === r && this.#g(n);
              });
            }
            break;
          }
          const s = new VideoDecoder({
            output: (r) => {
              this.#i !== s ? r.close() : this.#F(r);
            },
            error: (r) => {
              this.#i === s && this.#g(r);
            }
          });
          this.#i = s, this.#i.configure(i.config), this.#e = i.config;
        }
        (i.duration ?? 0) < 1e3 && this.#o.add(i.timestamp), this.#i.decode(new EncodedVideoChunk(i)), this.#t++;
      }
      if (this.#l && this.#t === this.#n.length && this.#i && !this.#u) {
        this.#u = !0;
        const i = this.#i;
        i.flush().catch((s) => {
          this.#i === i && this.#g(s);
        });
      }
    } catch (i) {
      this.#g(i);
      return;
    }
    const t = this.#a[0];
    return !t || t.timestamp / 1e6 > e + 3e-3 * this.#s.playbackRate ? this.#p ? null : void 0 : (this.#p = !0, this.#a.shift());
  }
  #F = (e) => {
    this.#o.delete(e.timestamp) || e.timestamp / 1e6 < this.#s.currentTime - (this.#p ? 0.1 : 0.04) ? e.close() : this.#a.push(e);
  };
  #f = () => {
    this.#i && this.#i.state !== "closed" && this.#i.close(), this.#i = null, this.#e = null;
    for (const e of this.#a) e.close();
    this.#a = [], this.#o.clear(), this.#u = !1, this.#h = !1, this.#p = !1, this.#t = 0;
    for (let e = 0; e < this.#n.length; e++) {
      const t = this.#n[e];
      t.type === "key" && t.timestamp / 1e6 <= this.#s.currentTime && (this.#t = e);
    }
  };
  finish() {
    this.#l = !0;
  }
  /** Release the decoder and undisplayed frames while the filter is stopped. */
  suspend() {
    this.#f();
  }
  reset() {
    this.#f(), this.#n = [], this.#t = 0, this.#r = null, this.#l = !1, this.#E = !1;
  }
  destroy() {
    this.reset(), this.#s.removeEventListener("seeking", this.#f), this.#s.removeEventListener("ratechange", this.#f);
  }
  #g(e) {
    this.#f(), this.#E = !0, console.warn("mpeg2toh264: decoded video input unavailable", e);
  }
}
const Me = [
  "mozParsedFrames",
  "mozDecodedFrames",
  "mozPresentedFrames",
  "mozPaintedFrames"
];
function Se(o) {
  return Me.every((e) => e in o);
}
function Ke(o) {
  return o.ownerDocument?.defaultView?.performance.timeOrigin ?? performance.timeOrigin;
}
function Je() {
  return typeof HTMLVideoElement < "u" && (Se(HTMLVideoElement.prototype) || typeof HTMLVideoElement.prototype.requestVideoFrameCallback == "function");
}
const et = 250, tt = 500;
class it {
  #s;
  #r;
  #e;
  #n = null;
  #t = null;
  #i = null;
  #a = null;
  #o = !1;
  #l = !0;
  #u = null;
  #E = null;
  #h = 0;
  #p;
  #x;
  #F = null;
  #f = null;
  #g = null;
  #d = null;
  #D = 0;
  #w = [];
  #N = [];
  constructor(e, t) {
    if (this.#s = e, this.#r = t, this.#e = Se(e) ? e : null, this.#p = typeof VideoFrame < "u", this.#x = this.#p && e.playbackRate > 1, this.#e) {
      for (const i of ["emptied", "seeking", "seeked"])
        e.addEventListener(i, this.#B);
      for (const i of ["pause", "playing", "waiting", "ratechange"])
        e.addEventListener(i, this.#H);
    }
    if (this.#p)
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
        e.addEventListener(i, this.#A);
  }
  /** Whether acquisition runs off the Firefox counters. */
  get mozDriven() {
    return this.#e !== null && !this.#x;
  }
  /** Whether frequent capture is active, excluding fallback notifications based on video.currentTime. */
  get captureDriven() {
    return this.#x;
  }
  /** Whether any frame has been delivered yet (counters proven live). */
  get hasDelivered() {
    return this.#o;
  }
  request(e) {
    if (this.#t === null) {
      if (this.#t = e, this.#x) {
        this.#_();
        return;
      }
      this.#n = this.#e ? requestAnimationFrame(this.#de) : this.#s.requestVideoFrameCallback(this.#he);
    }
  }
  cancel() {
    this.#n !== null && (this.#e ? cancelAnimationFrame(this.#n) : this.#s.cancelVideoFrameCallback(this.#n)), this.#n = null, this.#t = null, this.#F?.(), this.#F = null, this.#g !== null && this.#s.cancelVideoFrameCallback(this.#g), this.#g = null, this.#S(), this.#d = null, this.#w = [], this.#B();
  }
  destroy() {
    this.cancel();
    for (const e of ["emptied", "seeking", "seeked"])
      this.#s.removeEventListener(e, this.#B);
    for (const e of ["pause", "playing", "waiting", "ratechange"])
      this.#s.removeEventListener(e, this.#H);
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
      this.#s.removeEventListener(e, this.#A);
  }
  /** Deliver pending input on the rendering window's refresh, before drawing. */
  flush(e) {
    if (this.#x)
      for (this.#s.ownerDocument !== this.#f && (this.#F?.(), this.#F = null, this.#_()); this.#N.length > 0 && this.#t !== null; ) {
        const t = this.#N.shift(), i = t.frame;
        try {
          this.#fe(e, {
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
  #S() {
    for (const e of this.#N) e.frame.close();
    this.#N = [];
  }
  #A = (e) => {
    const t = this.#p && this.#s.playbackRate > 1;
    if (t !== this.#x) {
      const i = this.#t;
      this.cancel(), this.#x = t, i !== null && this.request(i);
      return;
    }
    this.#x && ((e.type === "pause" || e.type === "ended") && this.flush(performance.now()), this.#S(), ["seeking", "seeked", "emptied", "ratechange"].includes(e.type) && (this.#d = null, this.#w = []), this.#F?.(), this.#F = null, this.#t !== null && this.#_());
  };
  #_() {
    if (this.#F !== null || this.#t === null || (this.#s.paused || this.#s.ended) && this.#d !== null)
      return;
    this.#g === null && typeof this.#s.requestVideoFrameCallback == "function" && (this.#g = this.#s.requestVideoFrameCallback(
      this.#ue
    ));
    const e = Math.max(4, 8 / Math.max(1, this.#s.playbackRate)), t = this.#s.ownerDocument?.defaultView;
    if (this.#f = this.#s.ownerDocument, t) {
      const i = t.setTimeout(this.#I, e);
      this.#F = () => t.clearTimeout(i);
    } else {
      const i = setTimeout(this.#I, e);
      this.#F = () => clearTimeout(i);
    }
  }
  #ue = () => {
    this.#g = null, this.#F?.(), this.#F = null, this.#I();
  };
  #I = () => {
    this.#F = null;
    const e = this.#s;
    if (this.#t === null) return;
    if (e.readyState < 2 || e.seeking) {
      this.#_();
      return;
    }
    let t, i = !1;
    try {
      const s = this.#r?.();
      if (s === null) {
        this.#_();
        return;
      }
      i = s !== void 0, t = s ?? new VideoFrame(e);
    } catch (s) {
      if (!(s instanceof DOMException) || s.name !== "InvalidStateError")
        throw s;
      this.#_();
      return;
    }
    if (t.timestamp === this.#d)
      t.close();
    else {
      let s = 1;
      if (this.#d !== null) {
        const n = t.timestamp - this.#d;
        if (n > 1e3 && n < 25e4) {
          this.#w.push(n), this.#w.length > 7 && this.#w.shift();
          const a = [...this.#w].sort((l, h) => l - h), A = a[Math.floor(a.length / 2)];
          s = Math.max(1, Math.round(n / A));
        }
      }
      this.#d = t.timestamp, this.#D += s;
      const r = performance.now() + (i ? (t.timestamp / 1e6 - e.currentTime) * 1e3 / e.playbackRate : 0);
      for (this.#N.push({ frame: t, at: r, count: this.#D }); this.#N.length > 4; ) this.#N.shift().frame.close();
    }
    this.#_();
  };
  #H = () => {
    this.#u = null, this.#E = null, this.#h = 0;
  };
  #B = () => {
    this.#i = null, this.#a = null, this.#l = !0, this.#H();
  };
  /** Native acquisition: pass the report on, with the clock it was made on. */
  #he = (e, t) => {
    this.#fe(e, {
      width: t.width,
      height: t.height,
      mediaTime: t.mediaTime,
      presentedFrames: t.presentedFrames,
      expectedDisplayTime: t.expectedDisplayTime,
      timeOrigin: Ke(this.#s)
    });
  };
  #fe = (e, t) => {
    const i = this.#t;
    this.#n = null, this.#t = null, this.#o = !0, i?.(e, t);
  };
  #de = (e) => {
    const t = this.#e, i = Me.map((a) => t[a]);
    this.#i?.some((a, A) => i[A] < a) && this.#B(), this.#i = i;
    const s = t.mozPaintedFrames, r = !t.seeking && t.readyState >= 2 && t.videoWidth > 0 && t.videoHeight > 0, n = this.#a === null && (s > 0 || t.paused && (t.mozPresentedFrames > 0 || t.mozDecodedFrames > 0));
    if (r && (n || this.#a !== null && s !== this.#a)) {
      if (this.#u !== null && e - this.#u > tt && (this.#H(), this.#l = !0), !t.paused && !t.ended) {
        const A = this.#E;
        if (A && e - A.at >= et) {
          const l = s - A.frames;
          if (l > 0) {
            const h = (e - A.at) / l;
            h >= 4 && h <= 200 && (this.#h = this.#h ? this.#h + (h - this.#h) * 0.25 : h);
          }
          this.#E = null;
        }
        this.#E ??= { at: e, frames: s };
      }
      this.#u = e, this.#a = s;
      const a = this.#l;
      this.#l = !1, this.#fe(e, {
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
        mozTiming: { periodMs: this.#h, discontinuity: a }
      });
    } else
      this.#n = requestAnimationFrame(this.#de);
  };
}
let _e = null;
function st(o) {
  _e = o;
}
const pe = 0.5, T = 4, Ae = 5, U = Ae + 1, ve = 1e3, ne = 4, Q = 200, rt = 0.25, nt = 1e3 / 60, ot = 250, ht = 1e3 / 30;
function Ee(o) {
  if (!Number.isFinite(o) || o < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return o;
}
const at = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, At = 0.75, ct = 0.1, xe = 1, lt = 0.02, ut = 0.1, ge = 1, ft = 4, oe = 5, dt = 4, mt = {
  2: 0,
  3: 0.25,
  4: 0.5,
  5: 0.75
}, pt = 3, vt = `#version 300 es
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
function Rt() {
  return Je() && typeof WebGL2RenderingContext < "u";
}
const Et = {
  requestAnimationFrame: (o) => requestAnimationFrame(o),
  cancelAnimationFrame: (o) => cancelAnimationFrame(o)
};
class Mt extends EventTarget {
  /** Receive fMP4 from the player and decode supplemental input only above 1.25x playback speed. */
  encodedVideo;
  #s;
  #r;
  #e;
  #n;
  #t;
  /** The pulldown detection, built only while the `film` option needs it. */
  #i = null;
  #a;
  #o;
  /** The program that copies a filtered picture onto the canvas. */
  #l;
  #u;
  #E;
  /** The reduced pass that reads previous, current and next luma together. */
  #h = null;
  #p = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #x = null;
  #F = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #f = null;
  #g = null;
  #d = null;
  #D = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #w = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #N = U - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #S = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #A = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #_ = null;
  #ue = 0;
  /** ページ側で frame callback の停止を監視する requestAnimationFrame()。 */
  #I = null;
  /** The document the owner-change listener is on, if any. */
  #H = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #B = nt;
  /** Where the refresh grid fitted to the animation frames stands. (otya) */
  #he = 0;
  /** How far ahead of its animation frame the last picture shown stood. (otya) */
  #fe = 0;
  #de = 0;
  #ae = 0;
  /** The last picture chained onto the schedule; a break restarts it. (otya) */
  #ee = null;
  /**
   * Drop the presentation queue and restart the schedule from the clock.
   * Every schedule restart goes through here (otya nulls #lastScheduled at
   * each queue clear): the old chain's clock no longer applies, so keeping
   * it would either count a phantom resync or pop freshly queued pictures
   * as late. Restart accounting for cadence changes lives in #schedule.
   */
  #z() {
    this.#A.length = 0, this.#ee = null, this.#ae = 0;
  }
  /** The `<div>` this put around the element, so it can be taken away again. */
  #me = null;
  #ut;
  #W;
  #m;
  #pe;
  #ve;
  #te = "video";
  #Pe = "c";
  #ft = 0;
  #dt = !0;
  #mt = new F(S, _);
  #pt = 1 / 0;
  #vt = 1 / 0;
  #Ae = 0;
  /** otya GPU pulldown path: enabled by the `film` option (see below). */
  #j;
  #L;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #b = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #C = 0;
  #O = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #P = T - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #y = 0;
  #Le = 0;
  /** presentedFrames at the last ingested frame; pairs with #lastMediaTime. */
  #Et = 0;
  #Ze = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #Be = !1;
  /** 最終通知時刻。rVFC と Firefox カウンターのどちらの取得経路でも更新する。 */
  #je = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #Ee = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #xt = 0;
  #R = !1;
  /** Cancels work suspended inside a synchronous owner callback. */
  #q = 0;
  #qe = !1;
  #X = !1;
  #T = null;
  #xe = [];
  #V = !1;
  #gt;
  #bt;
  #M;
  #ge;
  #ie;
  #wt;
  #c = null;
  #v;
  #ke = !1;
  #yt = 0;
  #Tt = !1;
  #ui = 0;
  #Ie = !1;
  #Ke = !1;
  #be = null;
  #fi = 0;
  #Ue = /* @__PURE__ */ new Map();
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #k = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    resynced: 0,
    late: 0,
    queueResetted: 0
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #se = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #Ft = 0;
  #Je = 0;
  #ce = 0;
  #Ne = 0;
  #Oe = 0;
  #Ge = 0;
  #we = 0;
  #ye;
  #et = [];
  #Te = [];
  #ze = 0;
  #Fe = 0;
  #Xe = 0;
  #De = 0;
  /** The last phase read back from the GPU, and how many frames ago it was for. */
  #He = I;
  #Re = 0;
  /** The phase of the frame being filtered: #known advanced by #knownAge. */
  #U = I;
  #K = !1;
  #Me = null;
  #Vt = "";
  /** Debug only: frames given each phase (0 for none), and repeats dropped. */
  #tt = [0, 0, 0, 0, 0, 0];
  #Dt = 0;
  /**
   * Why requested film reconstruction is currently degraded, or null while
   * healthy. The `film` / `autoFilm` options stay as the caller set them;
   * only the engine stands down, so this is never a silent option change.
   */
  #Y = null;
  /** Consecutive autoFilm analyses with no usable target or programs. */
  #it = 0;
  /** Last worker-reported filmError, to derive the page-side failure event. */
  #st = null;
  #Rt = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#W = t.doubleRate ?? !1, this.#m = t.autoFilm ?? !1, this.#pe = Ee(
      t.filmCombThreshold ?? F.COMBED_PIXEL_LIMIT
    ), this.#ve = t.spatialCheck ?? !0, this.#j = t.debug ?? !1, this.#L = t.film ?? !1, this.#gt = t.onStats, this.#bt = t.onFailure, this.#M = i, this.#ie = i ? "main" : t.rendering ?? "main", this.#wt = t.workerUrl ?? _e, this.#v = this.#ie === "main" ? "main" : "idle", this.#r = i ? i.canvas : document.createElement("canvas"), this.#s = i?.canvas ?? (this.#ie === "main" ? this.#r : document.createElement("canvas")), this.#ge = e, i || (this.#r.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const s = this.#s.getContext("webgl2", {
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
    this.#t = s, this.#L && !this.#m && (this.#$t(), this.#i = new me(s)), this.#a = W(s, Ye);
    const r = this.#a;
    this.#o = Object.fromEntries(
      Object.entries(Ve).map(([n, a]) => [
        n,
        s.getUniformLocation(r, a)
      ])
    ), this.#l = W(s, vt), this.#u = s.getUniformLocation(this.#l, "uField"), this.#E = s.getUniformLocation(this.#l, "uFlip"), this.#m && this.#ti(), this.#ye = s.getExtension(
      "EXT_disjoint_timer_query_webgl2"
    ), this.#s.addEventListener(
      "webglcontextlost",
      this.#li
    ), this.#ut = i ? null : new ResizeObserver(() => this.#lt()), this.encodedVideo = !i && typeof VideoDecoder < "u" ? new qe(e) : null, this.#n = new it(e, () => this.encodedVideo?.take()), e.addEventListener("emptied", this.#ai), e.addEventListener("resize", this.#hi), e.addEventListener("pause", this.#oe), e.addEventListener("ended", this.#oe), e.addEventListener("seeking", this.#ci), e.addEventListener("seeked", this.#oe), e.addEventListener("ratechange", this.#oe);
  }
  get running() {
    return this.#R && (this.#T?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#r;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #rt() {
    return this.#T?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #Yt() {
    return {
      doubleRate: this.#W,
      autoFilm: this.#m,
      filmCombThreshold: this.#pe,
      spatialCheck: this.#ve,
      film: this.#L,
      debug: this.#j
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#qe;
  }
  set enabled(e) {
    this.#qe = e, this.#St(), this.#c?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#T?.interlaced !== e?.interlaced, i = t || this.#T?.topFieldFirst !== e?.topFieldFirst;
    this.#T = e, !(i && (!this.#re() || this.#T !== e)) && (this.#c?.postMessage({ type: "scan", scan: e }), i && (this.#y = 0, this.#G(), this.#Q(), t && (this.#b = 0), this.#S = null, this.#J(!1)), this.#St(), i && ((e?.interlaced ?? !0) && (this.#M || this.#v === "main") ? this.#_e() : this.#kt()));
  }
  get scan() {
    return this.#T;
  }
  set videoTimeline(e) {
    this.#xe = e, this.#c?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#T = null), this.#St();
  }
  get videoTimeline() {
    return this.#xe;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#me ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#W;
  }
  set doubleRate(e) {
    e !== this.#W && (this.#W = e, this.#$(), this.#z(), this.#Mt());
  }
  get spatialCheck() {
    return this.#ve;
  }
  set spatialCheck(e) {
    e !== this.#ve && (this.#ve = e, this.#$());
  }
  get film() {
    return this.#L;
  }
  set film(e) {
    if (this.#m) {
      this.#L = e, this.#$();
      return;
    }
    const t = this.#c ? this.#st : this.#Y;
    if (!(e === this.#L && (e === !1 || t === null))) {
      if (this.#c) {
        this.#L = e, this.#$(e ? "film" : void 0);
        return;
      }
      if (e) {
        if (!this.#re()) return;
        try {
          this.#Qt();
        } catch (i) {
          this.#L = !0, this.#$(), this.#We(
            `film detector unavailable: ${i instanceof Error ? i.message : String(i)}`
          );
          return;
        }
      }
      if (this.#L = e, this.#$(), !e) {
        if (!this.#re()) return;
        this.#K = !1, this.#U = I, this.#Q(), this.#i?.destroy(), this.#i = null;
      }
      this.#Mt();
    }
  }
  get debug() {
    return this.#j;
  }
  set debug(e) {
    e !== this.#j && (this.#j = e, this.#$());
  }
  /** Whether pictures are queued and put up by the loop rather than drawn on arrival.
   * autoFilm joins the otya condition so the CPU film path keeps its loop.
   */
  get #di() {
    return this.#W || this.#L || this.#m;
  }
  #Mt() {
    this.#X || (this.#di ? (this.#C > 0 && this.#Ht(), (this.#T?.interlaced ?? !0) && (this.#M || this.#v === "main") && this.#_e()) : !this.#m && !this.#L && (this.#S = null, this.#J(!1), this.#Qe()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#m;
  }
  set autoFilm(e) {
    const t = this.#c ? this.#st : this.#Y;
    if (!(e === this.#m && (!e || t === null))) {
      if (this.#m = e, this.#c) {
        this.#$(e ? "autoFilm" : void 0);
        return;
      }
      if (this.#$(), this.#G(), e) {
        if (this.#Q(), this.#i?.destroy(), this.#i = null, !this.#re() || this.#m !== e) return;
        this.#C > 0 && this.#Ht(), (this.#T?.interlaced ?? !0) && (this.#M || this.#v === "main") && this.#_e();
      } else {
        if (!this.#re() || this.#m !== e) return;
        this.#Xt(), this.#Mt();
      }
    }
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#pe;
  }
  set filmCombThreshold(e) {
    const t = Ee(e);
    t !== this.#pe && (this.#pe = t, this.#$(), this.#m && this.#G());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #$(e) {
    this.#c?.postMessage({
      type: "settings",
      options: this.#Yt(),
      retryFilm: e
    });
  }
  #$t() {
    if (this.#t.getExtension("EXT_color_buffer_float") === null)
      throw new Error("film needs EXT_color_buffer_float");
  }
  /** Build the GPU pulldown detector the `film` option needs, or throw. */
  #Qt() {
    this.#$t(), this.#i ??= new me(this.#t), this.#C > 0 && this.#i.resize(this.#C, this.#O);
  }
  #St() {
    this.#qe && (this.#xe.length > 0 || (this.#T?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #mi() {
    return this.#M || this.#ie === "main" ? !1 : this.#v === "starting" || this.#v === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#wt !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Zt(), !0) : this.#ie === "auto" ? (this.#nt(), !1) : (this.#v = "failed", this.#R = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #Zt() {
    this.#ne(), this.#c?.terminate(), this.#c = null, this.#Ie = !1, this.#Ke = !1, this.#st = null, this.#Rt = 0;
    let e = this.#r;
    if (this.#Tt) {
      e = document.createElement("canvas"), e.className = this.#r.className;
      const r = this.#r.getAttribute("style");
      r === null ? e.removeAttribute("style") : e.setAttribute("style", r), e.style.visibility = "hidden", this.#r.parentElement && this.#r.replaceWith(e), this.#r = e;
    }
    const t = ++this.#yt;
    this.#v = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#Tt = !0, i = new Worker(this.#wt, { type: "module" });
    } catch (r) {
      this.#Ve(
        r instanceof Error ? r.message : String(r)
      );
      return;
    }
    this.#c = i, i.onmessage = (r) => {
      t === this.#yt && this.#pi(r.data);
    }, i.onerror = (r) => {
      t === this.#yt && (r.preventDefault(), this.#Ve(r.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#Yt(),
        scan: this.#T,
        videoTimeline: this.#xe,
        enabled: this.#R,
        video: this.#Ct()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #pi(e) {
    switch (e.type) {
      case "ready":
        this.#v = "active", this.#R && (this.#Ye(), this.#Ot());
        break;
      case "failed":
        this.#Ve(e.message);
        break;
      case "consumed": {
        this.#Ie = !1, this.#Ke = !0;
        const t = this.#be;
        this.#be = null, t && this.#qt(t);
        break;
      }
      case "visibility":
        this.#r.style.visibility = e.visible ? "visible" : "hidden";
        break;
      case "stats": {
        const t = {
          ...e.stats,
          dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0
        }, i = t.filmError ?? null, s = this.#Rt;
        if (this.#st = i, this.#Rt = e.filmFailure, i !== null && e.filmFailure !== s) {
          this.dispatchEvent(
            new CustomEvent("failure", { detail: i })
          );
          try {
            this.#bt?.(i);
          } catch {
          }
        }
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#gt?.(t);
        break;
      }
      case "capture": {
        const t = this.#Ue.get(e.id);
        if (this.#Ue.delete(e.id), !t) {
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
  #_t(e) {
    if (this.dispatchEvent(new CustomEvent("failure", { detail: e })), !this.#M)
      try {
        this.#bt?.(e);
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
   *
   * NOTE: the reason prefixes below (`film detector unavailable`,
   * `film detection failed`, `autoFilm analysis unavailable`) are
   * load-bearing for the KonomiTV caller, which matches on them to decide
   * the explicit autoFilm recovery (G6). Rewording them silently drops that
   * recovery to a log line; prefer a typed detail if this grows further.
   */
  #We(e) {
    this.#Y !== e && (this.#Y = e, this.#K = !1, this.#U = I, this.#Q(), this.#it = 0, this.#i?.destroy(), this.#i = null, this.#_t(e));
  }
  /**
   * Re-arm film reconstruction at a resource-reallocation point (start, scan
   * change, resize, or re-setting the option). The next frame retries; a
   * repeated failure degrades again and notifies as a new episode.
   */
  #re() {
    if (this.#X) return !1;
    if (this.#c) return !0;
    const e = this.#q;
    if (this.#Y = null, this.#it = 0, this.#m)
      try {
        this.#ti(), this.#C > 0 && this.#Ii();
      } catch (t) {
        this.#We(
          `autoFilm programs unavailable: ${t instanceof Error ? t.message : String(t)}`
        );
      }
    return !this.#X && e === this.#q;
  }
  /** 一時的な Worker 障害を1回だけ復旧し、再失敗時は media element 自体を表示する。 */
  #Ve(e) {
    if (this.#v === "starting" && this.#ie === "auto" && !this.#ke) {
      this.#nt();
      return;
    }
    if (this.#jt(e), !this.#ke) {
      this.#ke = !0, this.#Zt();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#v = "failed", this.#c?.terminate(), this.#c = null, this.#ne(), this.#_t(`deinterlacer worker stopped: ${e}`), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #nt() {
    const e = this.#s;
    e.className = this.#r.className;
    const t = this.#r.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#r.parentElement && this.#r.replaceWith(e), this.#r = e, this.#Tt = !1, this.#c?.terminate(), this.#c = null, this.#v = "main", this.#ne(), this.#R && (this.#Ye(), this.#Ot(), (this.#T?.interlaced ?? !0) && this.#_e());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #ne() {
    this.#be?.frame.close(), this.#be = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #jt(e) {
    for (const t of this.#Ue.values())
      t.reject(new Error(e));
    this.#Ue.clear();
  }
  start() {
    if (!(this.#R || this.#X || this.#V) && (this.#q++, this.#R = !0, this.#Ai(), this.#G(), !!this.#re())) {
      if (this.#je = performance.now(), this.#xt = this.#je, this.#Ze = Number.NaN, this.#Ee = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#Ui(), this.#Ot(), this.#mi()) {
        this.#c?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#v === "active" && this.#Ye();
        return;
      }
      this.#Ye(), (this.#T?.interlaced ?? !0) && this.#_e();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#q++, this.#R && (this.#R = !1, this.#n.cancel(), this.encodedVideo?.suspend(), this.#Si(), this.#kt(), this.#y = 0, this.#S = null, this.#J(!1), this.#ne(), this.#c?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#X) {
      this.#X = !0, this.#qe = !1, this.stop(), this.#c?.postMessage({ type: "destroy" }), this.#c?.terminate(), this.#c = null, this.#ne(), this.#jt("the deinterlacer was destroyed"), this.#H?.removeEventListener(
        "visibilitychange",
        this.#Nt
      ), this.#H = null, this.#s.removeEventListener(
        "webglcontextlost",
        this.#li
      ), this.#n.destroy(), this.encodedVideo?.destroy(), this.#e.removeEventListener("emptied", this.#ai), this.#e.removeEventListener("resize", this.#hi), this.#e.removeEventListener("pause", this.#oe), this.#e.removeEventListener("ended", this.#oe), this.#e.removeEventListener("seeking", this.#ci), this.#e.removeEventListener("seeked", this.#oe), this.#e.removeEventListener("ratechange", this.#oe), this.#Ni();
      for (const e of this.#D) this.#t.deleteTexture(e);
      this.#D = [], this.#Qe(), this.#Xt();
      for (const e of [
        ...this.#et,
        ...this.#Te.map(({ q: t }) => t)
      ])
        this.#t.deleteQuery(e);
      this.#et.length = 0, this.#Te.length = 0, this.#i?.destroy(), this.#i = null, this.#Me !== null && (Ie(this.#Me), this.#Me = null), this.#t.deleteProgram(this.#a), this.#t.deleteProgram(this.#l), this.#h && this.#t.deleteProgram(this.#h), this.#x && this.#t.deleteProgram(this.#x), this.#f && this.#t.deleteProgram(this.#f), this.#t.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#v === "active" && this.#r.style.visibility === "visible" && this.#c) {
      const s = ++this.#fi, r = new Promise((n, a) => {
        this.#Ue.set(s, { resolve: n, reject: a });
      });
      return this.#c.postMessage({
        type: "capture",
        id: s,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), r;
    }
    if (this.#v === "starting" || this.#v === "failed")
      return createImageBitmap(this.#e);
    const e = this.#S;
    if (this.#M && (!this.#R || this.#V || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#R || this.#V || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#zt(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#le(e.flush, e.second, null, !1) : this.#Lt(null, !1);
    const t = this.#e.videoWidth, i = this.#e.videoHeight;
    return t > 0 && i > 0 && (t !== this.#s.width || i !== this.#s.height) ? createImageBitmap(this.#s, {
      resizeWidth: t,
      resizeHeight: i,
      resizeQuality: "high"
    }) : createImageBitmap(this.#s);
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #Ye() {
    this.#M || !this.#R || this.#n.request(this.#yi);
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #Ct() {
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
  #vi(e, t, i) {
    let s;
    try {
      s = i?.clone() ?? new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (n) {
      const a = n instanceof Error ? n.message : String(n);
      this.#ie === "auto" && !this.#Ke && !this.#ke ? (this.#nt(), this.#ot(e, t)) : this.#Ve(a);
      return;
    }
    const r = {
      id: ++this.#ui,
      frame: s,
      now: e,
      metadata: t,
      video: this.#Ct()
    };
    if (this.#Ie) {
      this.#be?.frame.close(), this.#be = r;
      return;
    }
    this.#qt(r);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #qt(e) {
    const t = this.#c;
    if (!t || this.#v !== "active") {
      e.frame.close();
      return;
    }
    this.#Ie = !0;
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
      this.#Ie = !1, e.frame.close();
      const r = s instanceof Error ? s.message : String(s);
      this.#ie === "auto" && !this.#Ke && !this.#ke ? (this.#nt(), this.#ot(e.now, e.metadata)) : this.#Ve(r);
    }
  }
  #Ei(e, t, i) {
    this.#Me == null && (this.#Me = Be(this.#t, "20px monospace")), Ue(this.#Me, e, t, i, this.#C, this.#O, 20);
  }
  #Kt(e) {
    if (this.#ye == null || this.#Te.length > 30)
      return;
    const t = this.#et.pop() ?? this.#t.createQuery();
    return this.#t.beginQuery(this.#ye.TIME_ELAPSED_EXT, t), this.#Te.push({ q: t, isField: e }), t;
  }
  #$e(e) {
    this.#ye != null && (e != null && this.#t.endQuery(this.#ye.TIME_ELAPSED_EXT), this.#Te = this.#Te.filter(
      ({ q: t, isField: i }) => {
        if (this.#t.getQueryParameter(t, this.#t.QUERY_RESULT_AVAILABLE)) {
          const s = this.#t.getQueryParameter(t, this.#t.QUERY_RESULT);
          return i ? (this.#Xe += s, this.#De++) : (this.#ze += s, this.#Fe++), this.#et.push(t), !1;
        }
        return !0;
      }
    ));
  }
  #Q() {
    this.#U = I, this.#He = I, this.#Re = 0, this.#K = !1, this.#i?.reset();
  }
  /** Detect the pulldown phase of the frame being filtered on the GPU. */
  #xi() {
    const { cur: e, next: t } = this.#ni(!1), i = this.#D[e], s = this.#D[t];
    if (!i || !s) return;
    const r = this.#T?.topFieldFirst !== !1 ? 0 : 1;
    this.#i?.detect(i, s, r);
  }
  /**
   * Read back the previous frame's phase if it has arrived, and advance it
   * to the frame being filtered. The run is not advanced: only the GPU
   * counts observed frames.
   */
  #gi() {
    const e = this.#i?.poll() ?? null;
    e !== null && (this.#He = e, this.#Re = e.age), this.#Re++;
    const { phase: t, run: i } = this.#He;
    t === 0 || this.#Re > Math.ceil(oe * Math.max(1, this.#e.playbackRate)) ? this.#U = I : this.#U = {
      phase: (t - 1 + this.#Re) % oe + 1,
      run: i
    };
  }
  #bi(e) {
    const t = [], i = this.#i?.metrics ?? new Float32Array(0);
    for (let r = 0; r < b.phase; r++) {
      const n = i[r * 4] ?? 0, a = i[r * 4 + 1] ?? 0, A = i[r * 4 + 2] ?? 0;
      t.push(
        `${n.toFixed(3)},${a.toString().padStart(4)},${A.toFixed(3)}`
      );
    }
    const s = this.#tt.map((r, n) => `${n === 0 ? "-" : n}:${r}`).join(" ");
    return `frame=${e} phase=${this.#U.phase} run=${this.#U.run} known=${this.#He.phase}/${this.#He.run} age=${this.#Re} ${this.#K ? "film" : "video"} period=${this.#b.toFixed(3)}
${t.join(" ")}
${s} dropped:${this.#Dt}`;
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
  #Pt(e, t) {
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
  #wi(e, t) {
    const i = e.expectedDisplayTime;
    if (!Number.isFinite(i) || i <= 0 || !Number.isFinite(e.timeOrigin)) return t;
    const s = this.#Pt(i, e.timeOrigin), r = ft * Math.max(this.#B, this.#b);
    return s < t - r || s > t + r ? t : s;
  }
  #yi = (e, t) => {
    if (!this.#R || this.#V) return;
    this.#Ut();
    const i = this.#Pt(e, t.timeOrigin);
    this.#je = i, this.#Ee = Math.max(
      this.#Ee,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    );
    const { frame: s, ...r } = t;
    this.#ge = s ?? this.#e;
    try {
      this.#Jt(i, r, s);
    } finally {
      this.#ge = this.#e;
    }
    this.#Ye();
  };
  /**
   * どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。
   * `now` はこの realm の時計で測った取込み時刻。
   */
  #Jt(e, t, i) {
    if (this.#Ze = t.mediaTime, this.#v === "active") {
      this.#vi(e, t, i);
      return;
    }
    this.#v !== "starting" && this.#ot(e, t);
  }
  /**
   * @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。
   * `now` はこの Worker の時計で測った取込み時刻を渡す。metadata の表示予定
   * 時刻はページ側の時計のままでよく、同梱の timeOrigin から変換する。
   */
  ingestExternalFrame(e, t, i) {
    this.#ge = i;
    try {
      this.#ot(e, t);
    } finally {
      this.#ge = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #ot(e, t) {
    const i = this.#q;
    if (this.#Z(i) && (this.#Ti(t.mediaTime), !!this.#Z(i) && t.width > 0 && t.height > 0)) {
      let s = !1;
      if (!this.#Be && this.#e.seeking) {
        const f = this.#e.buffered, p = this.#b >= ne ? this.#b / 1e3 : Q / 1e3;
        for (let y = 0; y < f.length; y++)
          if (t.mediaTime >= f.start(y) && t.mediaTime < f.end(y) && Math.abs(t.mediaTime - this.#e.currentTime) <= p) {
            s = !0;
            break;
          }
      }
      if (s && (this.#Be = !0), (this.#C === 0 || this.#O === 0) && this.#oi(t.width, t.height), !this.#Z(i)) return;
      if (this.#T && !this.#T.interlaced) {
        this.#Li();
        return;
      }
      const r = t.mediaTime - this.#Le, n = t.mozTiming, a = s || (n ? n.discontinuity || r < 0 || r > pe : r < 0 || r > pe);
      a && (this.#y = 0, this.#b = 0, this.#k.discontinuities++, this.#z(), this.#G(), this.#Q());
      const A = this.#m && this.#se !== 0 && t.presentedFrames - this.#se > 1, l = this.#Bi(t.presentedFrames, a);
      if (!a && A && (this.#y = 0, this.#G()), this.#y > 0 && t.mediaTime === this.#Le && (!n || t.presentedFrames === this.#Et))
        return;
      if (!a) {
        const f = n?.periodMs ?? 0;
        f > 0 ? this.#ei(
          f * (this.#e.playbackRate || 1) / 1e3,
          1
        ) : this.#y > 0 && r > 0 && this.#ei(r, l + 1);
      }
      this.#Le = t.mediaTime, this.#Et = t.presentedFrames;
      const h = performance.now();
      h - this.#Ft > ve && (this.#Je = h, this.#ce = 0, this.#Ne = 0, this.#Oe = 0, this.#Ge = 0, this.#we = 0, this.#Ae = 0, this.#ze = 0, this.#Fe = 0, this.#Xe = 0, this.#De = 0), this.#Ft = h;
      const d = performance.now(), u = this.#Kt(!1);
      this.#ri();
      const c = this.#te, m = this.#m && !this.#Y && this.#y === T ? this.#Fi() : !1;
      if (m === "unavailable" ? ++this.#it >= pt && this.#We(
        "autoFilm analysis unavailable: the GPU analysis target or programs would not allocate"
      ) : this.#it = 0, !this.#Z(i)) {
        this.#X || this.#$e(u);
        return;
      }
      const E = m === !0;
      c !== this.#te && this.#z();
      const v = E && this.#Se();
      if (this.#L && !this.#m && !this.#Y && !this.#i)
        try {
          this.#Qt();
        } catch (f) {
          this.#We(
            `film detector unavailable: ${f instanceof Error ? f.message : String(f)}`
          );
        }
      if (!this.#Z(i)) {
        this.#X || this.#$e(u);
        return;
      }
      if (this.#L && !this.#m && !this.#Y) {
        if (this.#y === T && l === 0)
          try {
            this.#gi(), this.#xi();
          } catch (f) {
            this.#We(
              `film detection failed: ${f instanceof Error ? f.message : String(f)}`
            );
          }
        else
          this.#Q();
        this.#tt[this.#U.phase] = (this.#tt[this.#U.phase] ?? 0) + 1, this.#K = this.#U.phase !== 0 && this.#U.run >= le, this.#j && (this.#Vt = this.#bi(t.presentedFrames));
      }
      if (!this.#Z(i)) {
        this.#X || this.#$e(u);
        return;
      }
      const w = this.#wi(t, e) + this.#B;
      if (v)
        this.#ae++;
      else if (this.#m && !this.#Y && !this.#dt && this.#te === "film")
        if (this.#Se()) {
          const f = this.#b * 5 / 4, y = this.#At(1, e, f) || this.#ee === null ? w + f : w;
          this.#Di(this.#at("film", y, f), f);
        } else
          this.#Lt(null);
      else if (this.#K && !this.#m)
        if (this.#Se()) {
          const f = this.#U.phase;
          if (f === ae)
            this.#Dt++, this.#ae++;
          else {
            const p = this.#b * oe / dt, y = this.#At(1, e, p), R = mt[f] ?? 0, P = y || this.#ee === null ? w + p : w + R * this.#b;
            this.#ht(
              "film",
              !1,
              this.#at("film", P, p),
              p
            );
          }
        } else
          this.#le(!1, !1, null);
      else if (this.#W && this.#Se()) {
        const f = this.#b / 2, y = this.#At(2, e, f) || this.#ee === null ? w + f * 2 : w, R = this.#at("field", y, f);
        this.#ht("field", !1, R, f), this.#ht("field", !0, R + f, f);
      } else if (this.#Se()) {
        const f = this.#b, y = this.#At(1, e, f) || this.#ee === null ? w + f : w;
        this.#ht(
          "frame",
          !1,
          this.#at("frame", y, f),
          f
        ) || (this.#k.late++, this.#le(!1, !1, null));
      } else
        this.#k.late += this.#A.length, this.#z(), this.#le(!1, !1, null);
      this.#we = Math.max(
        this.#we,
        this.#A.length
      ), this.#$e(u), this.#Ne += performance.now() - d, this.#ce++, this.#ki(h);
    }
  }
  #Z(e) {
    return !this.#X && this.#R && e === this.#q;
  }
  #Ti(e) {
    const t = this.#q;
    let i;
    for (let n = this.#xe.length - 1; n >= 0; n--) {
      const a = this.#xe[n];
      if (a.start <= e + 1e-6) {
        i = a;
        break;
      }
    }
    if (i?.codedSize && (i.codedSize.width !== this.#C || i.codedSize.height !== this.#O) && this.#oi(i.codedSize.width, i.codedSize.height), !this.#Z(t)) return;
    const s = i?.scan;
    if (!s || this.#T?.interlaced === s.interlaced && this.#T.topFieldFirst === s.topFieldFirst)
      return;
    const r = this.#T?.interlaced;
    this.#T = s, this.#y = 0, this.#z(), this.#G(), this.#re() && (r !== s.interlaced && (this.#b = 0), s.interlaced && (this.#M || this.#v === "main") ? this.#_e() : this.#kt(), this.#Q());
  }
  /**
   * Whether pictures are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #Se() {
    return (this.#W || this.#m || this.#L) && this.#b > 0 && this.#w.length === U;
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
  #ei(e, t) {
    const s = e * 1e3 / (this.#e.playbackRate || 1) / t;
    s < ne || s > Q || (this.#b = this.#b > 0 && s > this.#b * At ? this.#b + (s - this.#b) * rt : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #ti() {
    if (this.#h && this.#x && this.#f) return;
    const e = this.#t, t = [];
    let i, s, r;
    try {
      i = W(e, $e), t.push(i), s = W(e, Qe), t.push(s), r = W(e, Ze), t.push(r);
    } catch (n) {
      for (const a of t) e.deleteProgram(a);
      throw n;
    }
    this.#h = i, this.#p = Object.fromEntries(
      Object.entries(se).filter(([n]) => n !== "match" && n !== "topFieldFirst").map(([n, a]) => [n, e.getUniformLocation(i, a)])
    ), this.#x = s, this.#F = Object.fromEntries(
      Object.entries(se).map(([n, a]) => [
        n,
        e.getUniformLocation(s, a)
      ])
    ), this.#f = r, this.#g = Object.fromEntries(
      Object.entries(se).map(([n, a]) => [
        n,
        e.getUniformLocation(r, a)
      ])
    );
  }
  /**
   * Run FFmpeg's fieldmatch and live decimate decisions on reduced luma.
   * Full decoded frames remain in GPU textures, while the first readback packs
   * the previous, current and next luma proxies into RGB. A second readback
   * supplies the selected RGB weave to its chroma-sensitive decimate metric.
   *
   * Returns whether the frame is a pulldown duplicate, or `"unavailable"`
   * when the analysis target or programs never allocated: allocation either
   * works or it does not, so the caller treats a short run of those as a
   * persistent failure rather than a startup race.
   */
  #Fi() {
    const e = this.#d, t = this.#h, i = this.#p, s = this.#f, r = this.#g;
    if (!e || !t || !i || !s || !r)
      return "unavailable";
    const n = this.#t, a = this.#P, A = (this.#P + T - 1) % T, l = (this.#P + T - 2) % T, h = this.#rt;
    n.bindFramebuffer(n.FRAMEBUFFER, e.framebuffer), n.useProgram(t);
    for (const [v, g] of [l, A, a].entries())
      n.activeTexture(n.TEXTURE0 + v), n.bindTexture(n.TEXTURE_2D, this.#D[g] ?? null);
    n.uniform1i(i.prev, 0), n.uniform1i(i.cur, 1), n.uniform1i(i.next, 2), n.uniform2i(i.size, this.#C, this.#O), n.viewport(0, 0, S, _), n.drawArrays(n.TRIANGLES, 0, 3), n.readPixels(
      0,
      0,
      S,
      _,
      n.RGBA,
      n.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: d, currentLuma: u, nextLuma: c } = e;
    for (let v = 0; v < d.length; v++) {
      const g = v * 4;
      d[v] = e.pixels[g] ?? 0, u[v] = e.pixels[g + 1] ?? 0, c[v] = e.pixels[g + 2] ?? 0;
    }
    const m = this.#mt.fieldMatch(
      d,
      u,
      c,
      h,
      this.#pe
    );
    n.useProgram(s), n.uniform1i(r.prev, 0), n.uniform1i(r.cur, 1), n.uniform1i(r.next, 2), n.uniform2i(r.size, this.#C, this.#O), n.uniform1i(r.topFieldFirst, h ? 1 : 0), n.uniform1i(
      r.match,
      m.match === "p" ? 0 : m.match === "c" ? 1 : 2
    ), n.drawArrays(n.TRIANGLES, 0, 3), n.readPixels(
      0,
      0,
      S,
      _,
      n.RGBA,
      n.UNSIGNED_BYTE,
      e.pixels
    );
    const E = this.#mt.decimate(e.pixels);
    this.#Pe = m.match, this.#ft = m.combScore, this.#dt = m.isCombed, this.#pt = E.lowestCycleDifference, this.#vt = E.runnerUpCycleDifference;
    const x = E.dropIndex !== null && !m.isCombed;
    return (x ? "film" : "video") !== this.#te && (this.#te = x ? "film" : "video"), E.shouldDrop && !m.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Di(e, t) {
    const i = this.#Bt();
    if (i === null) return;
    const s = this.#w[i];
    if (!s) return;
    for (this.#N = i; this.#A.length > 0 && this.#A[0]?.slot === i; )
      this.#A.shift(), this.#k.late++;
    this.#Lt(s.framebuffer);
    const r = {
      slot: i,
      at: e,
      duration: t,
      cadence: "film",
      phase: 0,
      droppedBefore: this.#ae
    };
    this.#ae = 0, this.#A.push(r), this.#ee = r;
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Lt(e, t = !0) {
    const i = this.#x, s = this.#F;
    if (!i || !s) return;
    const r = this.#t, n = this.#P, a = (this.#P + T - 1) % T, A = (this.#P + T - 2) % T, l = this.#rt;
    r.bindFramebuffer(r.FRAMEBUFFER, e), r.useProgram(i);
    for (const [h, d] of [A, a, n].entries())
      r.activeTexture(r.TEXTURE0 + h), r.bindTexture(r.TEXTURE_2D, this.#D[d] ?? null);
    r.uniform1i(s.prev, 0), r.uniform1i(s.cur, 1), r.uniform1i(s.next, 2), r.uniform2i(s.size, this.#C, this.#O), r.uniform1i(s.topFieldFirst, l ? 1 : 0), r.uniform1i(
      s.match,
      this.#Pe === "p" ? 0 : this.#Pe === "c" ? 1 : 2
    ), r.viewport(0, 0, this.#C, this.#O), r.drawArrays(r.TRIANGLES, 0, 3), e === null && (this.#S = { kind: "film" }, this.#J(!0), t && this.#Ae++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #ht(e, t, i, s) {
    const r = this.#Bt();
    if (r === null) return !1;
    const n = this.#w[r];
    if (!n) return !1;
    for (this.#N = r; this.#A.length > 0 && this.#A[0]?.slot === r; )
      this.#A.shift(), this.#k.late++;
    this.#le(!1, t, n.framebuffer);
    const a = {
      slot: r,
      at: i,
      duration: s,
      cadence: e,
      phase: e === "film" ? this.#U.phase : e === "field" ? t ? 2 : 1 : 0,
      droppedBefore: this.#ae
    };
    return this.#ae = 0, this.#A.push(a), this.#ee = a, !0;
  }
  /**
   * When a picture goes up: one duration after the last one of its cadence,
   * nudged towards `ideal` by a fraction of the gap so that the schedule
   * follows the clock without a picture ever moving across a refresh. It
   * restarts from `ideal` when the gap has grown to a whole picture or the
   * cadence has changed. (otya)
   */
  #at(e, t, i) {
    if (!(i > 0)) return t;
    const s = this.#ee;
    if (s !== null && s.cadence === e) {
      const r = s.at + s.duration, n = t - r;
      if (Math.abs(n) < i) {
        const a = Math.max(
          -xe,
          Math.min(xe, n * ct)
        );
        return r + a;
      }
    }
    s !== null && this.#k.resynced++;
    for (let r = this.#A.at(-1); r && r.at >= t; )
      this.#A.pop(), this.#k.late++, r = this.#A.at(-1);
    return t;
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #At(e, t, i) {
    const s = this.#A.at(-1), r = (Ae + 1) * Math.max(this.#B, i);
    if (s && s.at - t > r)
      return this.#z(), this.#k.queueResetted++, !0;
    const n = Math.max(
      0,
      this.#A.length + e - Ae
    );
    let a = 0, A = 0;
    for (; A < n; ) {
      const l = this.#A.shift();
      if (!l) break;
      a += l.duration, A++;
    }
    for (const l of this.#A) l.at -= a;
    return this.#k.late += A, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Bt() {
    const e = this.#S?.kind === "texture" ? this.#S.texture : null, t = new Set(this.#A.map(({ slot: s }) => s));
    for (let s = 1; s <= U; s++) {
      const r = (this.#N + s) % U, n = this.#w[r];
      if (n && n.texture !== e && !t.has(r))
        return r;
    }
    const i = this.#A[0];
    if (i) {
      const s = this.#w[i.slot];
      if (s && s.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #_e() {
    this.#_ === null && (!this.#R || this.#V || (this.#ue = 0, this.#_ = this.#Ce(this.#It)));
  }
  #kt() {
    this.#ct(this.#_), this.#_ = null, this.#z();
  }
  #It = (e) => {
    if (this.#_ = null, !this.#R || this.#V) return;
    this.#Ri(e);
    const t = this.#q;
    this.#n.flush(e), this.#Z(t) && (this.#v === "main" && this.#Ci(this.#he, e), this.#_ = this.#Ce(this.#It));
  };
  /**
   * Fit a grid of refreshes (period and phase) to the animation frames. rAF
   * timestamps wander by a millisecond or so, which is more than the
   * nearest-refresh decision in #present can take; the grid is what it
   * compares against. A frame far off the grid restarts it. (otya)
   */
  #Ri(e) {
    const t = e - this.#ue;
    this.#ue = e;
    const i = Math.max(1, Math.round(t / this.#B)), s = this.#he + i * this.#B, r = e - s;
    if (this.#he === 0 || t <= 0 || t > Q || Math.abs(r) > this.#B / 4) {
      t > 0 && t <= Q && (this.#B = t), this.#he = e;
      return;
    }
    this.#B += r / i * lt, this.#he = s + r * ut;
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
  #ii() {
    const e = this.#M;
    if (e)
      return { frames: e, origin: performance.timeOrigin };
    const t = this.#r.ownerDocument?.defaultView ?? this.#e.ownerDocument?.defaultView ?? null;
    return t === null ? { frames: Et, origin: performance.timeOrigin } : { frames: t, origin: t.performance.timeOrigin };
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
  #Ce(e) {
    const { frames: t, origin: i } = this.#ii(), s = t.requestAnimationFrame(
      (r) => e(this.#Pt(r, i))
    );
    return { frames: t, handle: s };
  }
  /** 予約した表示機会を、それを発行した window 自身で取り消す。 */
  #ct(e) {
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
  #Ut() {
    if (this.#M) return;
    this.#Mi();
    const { frames: e } = this.#ii(), t = this.#_ !== null && this.#_.frames !== e, i = this.#I !== null && this.#I.frames !== e;
    !t && !i || (this.#ue = 0, t && (this.#ct(this.#_), this.#_ = this.#Ce(this.#It)), i && (this.#ct(this.#I), this.#I = this.#Ce(this.#Gt)));
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
  #Mi() {
    const e = this.#M ? null : this.#r.ownerDocument ?? null;
    e !== this.#H && (this.#H?.removeEventListener(
      "visibilitychange",
      this.#Nt
    ), this.#H = e, e?.addEventListener("visibilitychange", this.#Nt));
  }
  #Nt = () => {
    this.#X || this.#Ut();
  };
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #Ot() {
    this.#M || this.#I !== null || !this.#R || this.#V || (this.#I = this.#Ce(this.#Gt));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Si() {
    this.#ct(this.#I), this.#I = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #Gt = (e) => {
    if (this.#I = null, !this.#R || this.#V) return;
    const t = this.#q;
    this.#n.flush(e), this.#Z(t) && (this.#_i(e), this.#Z(t) && (this.#I = this.#Ce(this.#Gt)));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #_i(e) {
    if (this.#M || this.#n.captureDriven || this.#n.mozDriven && this.#n.hasDelivered || e - this.#je < ot || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#b >= ne ? this.#b : ht, r = i > this.#Ee, n = t !== this.#Ze && e - this.#xt >= s * 0.75;
    !r && !n || (this.#Ee = Math.max(
      this.#Ee,
      i
    ), this.#xt = e, this.#Jt(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#se + 1, i),
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
  #Ci(e, t) {
    const i = this.#B / 2, s = (A) => {
      const l = A.at - e;
      return l <= i - ge ? !0 : l > i + ge ? !1 : this.#fe > 0;
    };
    for (; this.#A[1] && s(this.#A[1]); )
      this.#k.late++, this.#A.shift();
    const r = this.#A[0];
    if (!r || !s(r)) return;
    this.#A.shift(), this.#fe = r.at - e;
    const n = performance.now(), a = this.#Kt(!0);
    this.#si(r.slot), this.#$e(a), this.#Ge += performance.now() - n, this.#Oe++, this.#j && this.#Pi(r, t), this.#de = t;
  }
  /** Preserve upstream's opt-in presentation timing log in either renderer. */
  #Pi(e, t) {
    const i = this.#de === 0 ? 0 : t - this.#de, s = i / this.#B, r = e.cadence === "film" ? e.phase === 0 ? "CPU film" : `phase ${e.phase}` : e.cadence === "field" ? `field ${e.phase}` : "frame", n = e.phase === 0 ? "duplicate" : `phase ${ae}`, a = e.droppedBefore > 0 ? `, ${n} dropped before it` + (e.droppedBefore > 1 ? ` (${e.droppedBefore})` : "") : "";
    console.log(
      `yadif: +${i.toFixed(2)} ms (${s.toFixed(2)} refreshes) ${e.cadence} ${r}, due ${(e.at - t).toFixed(2)} ms${a}`
    );
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #si(e) {
    const t = this.#w[e];
    t && this.#zt(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Li() {
    this.#ri();
    const e = this.#D[this.#P];
    e && this.#zt(e, !0), this.#y = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #J(e) {
    if (this.#M) {
      this.#M.onVisibility(e);
      return;
    }
    this.#r.style.visibility = e ? "visible" : "hidden";
  }
  #zt(e, t = !1, i = !0) {
    const s = this.#t;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#l), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#u, 0), s.uniform1i(this.#E, t ? 1 : 0), s.viewport(0, 0, this.#C, this.#O), s.drawArrays(s.TRIANGLES, 0, 3), this.#S = { kind: "texture", texture: e, flip: t }, this.#J(!0), i && this.#Ae++;
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
  #Bi(e, t) {
    let i = 0;
    return this.#se !== 0 && !t && (i = Math.max(0, e - this.#se - 1), this.#k.missed += i), this.#se = e, i;
  }
  #ki(e) {
    const t = e - this.#Je;
    if (t < ve) return;
    const i = this.#Se() && (this.#W || this.#te === "film" || this.#K) ? this.#Oe : this.#ce, s = this.#ce ? (this.#Ne + this.#Ge) / this.#ce : 0;
    let r;
    this.#ye != null && (r = 0, this.#Fe !== 0 && (r += this.#ze / 1e6 / this.#Fe), this.#De !== 0 && (r += this.#Xe / 1e6 / this.#De / 2));
    const n = {
      ...this.#k,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: s,
      maxQueuedFields: this.#we,
      mode: this.#m ? this.#te : this.#K ? "film" : "video",
      match: this.#Pe,
      combScore: this.#ft,
      outputFps: this.#Ae * 1e3 / t,
      duplicateScore: this.#pt,
      duplicateRunnerUp: this.#vt,
      gpuMs: r,
      film: this.#K,
      filmError: this.#Y
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: n })), this.#gt?.(n), this.#Je = e, this.#ce = 0, this.#Ne = 0, this.#Oe = 0, this.#Ge = 0, this.#we = 0, this.#Ae = 0, this.#ze = 0, this.#Fe = 0, this.#Xe = 0, this.#De = 0;
  }
  /** Take the newest frame into the ring. */
  #ri() {
    const e = this.#t;
    this.#P = (this.#P + 1) % T, e.bindTexture(e.TEXTURE_2D, this.#D[this.#P] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#ge
    ), this.#y = Math.min(this.#y + 1, T);
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
  #le(e, t, i, s = !0) {
    if (this.#y === 0 || this.#V) return;
    s && (this.#y === T && !e ? this.#k.filtered++ : this.#k.degraded++);
    const r = this.#t, { prev: n, cur: a, next: A } = this.#ni(e);
    r.bindFramebuffer(r.FRAMEBUFFER, i), r.useProgram(this.#a);
    for (const [u, c] of [n, a, A].entries())
      r.activeTexture(r.TEXTURE0 + u), r.bindTexture(r.TEXTURE_2D, this.#D[c] ?? null);
    r.uniform1i(this.#o.prev, 0), r.uniform1i(this.#o.cur, 1), r.uniform1i(this.#o.next, 2);
    const l = this.#L && !this.#m ? this.#i?.texture ?? null : null, h = l !== null;
    l !== null && (r.activeTexture(r.TEXTURE0 + 3), r.bindTexture(r.TEXTURE_2D, l), r.uniform1i(this.#o.fieldMetrics, 3)), r.uniform2i(this.#o.size, this.#C, this.#O);
    const d = this.#rt ? 0 : 1;
    r.uniform1i(this.#o.parity, t ? 1 - d : d), r.uniform1i(this.#o.tff, this.#rt ? 1 : 0), r.uniform1i(this.#o.second, t ? 1 : 0), r.uniform1i(this.#o.spatialCheck, this.#ve ? 1 : 0), r.uniform1i(this.#o.debug, this.#j ? 1 : 0), r.uniform1i(this.#o.film, h ? 1 : 0), r.uniform1i(this.#o.phase, this.#U.phase), r.viewport(0, 0, this.#C, this.#O), r.drawArrays(r.TRIANGLES, 0, 3), this.#j && h && this.#Ei(this.#Vt, 0, 90), i === null && (this.#S = { kind: "yadif", flush: e, second: t }, this.#J(!0), s && this.#Ae++);
  }
  #ni(e) {
    const t = (i) => (this.#P + T - i) % T;
    return this.#y === 1 ? { prev: this.#P, cur: this.#P, next: this.#P } : e ? { prev: t(1), cur: this.#P, next: this.#P } : this.#y === 2 ? { prev: t(1), cur: t(1), next: this.#P } : { prev: t(2), cur: t(1), next: this.#P };
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
  #lt() {
    if (this.#Ut(), !this.#me) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const s = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), r = t * s, n = i * s;
    this.#r.style.left = `${e.offsetLeft + (e.offsetWidth - r) / 2}px`, this.#r.style.top = `${e.offsetTop + (e.offsetHeight - n) / 2}px`, this.#r.style.width = `${r}px`, this.#r.style.height = `${n}px`;
  }
  #oi(e, t) {
    const i = this.#t;
    this.#s.width = e, this.#s.height = t, this.#C = e, this.#O = t, this.#y = 0, this.#S = null, this.#G(), this.#lt();
    for (const s of this.#D) i.deleteTexture(s);
    this.#D = [];
    for (let s = 0; s < T; s++) {
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
      ), this.#D.push(r);
    }
    this.#Qe(), this.#Xt(), (this.#W || this.#m || this.#L) && this.#Ht(), this.#i?.resize(e, t), this.#re();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Ii() {
    if (this.#d) return;
    const e = this.#t, t = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      S,
      _,
      0,
      e.RGBA,
      e.UNSIGNED_BYTE,
      null
    );
    const i = e.createFramebuffer();
    e.bindFramebuffer(e.FRAMEBUFFER, i), e.framebufferTexture2D(
      e.FRAMEBUFFER,
      e.COLOR_ATTACHMENT0,
      e.TEXTURE_2D,
      t,
      0
    );
    const s = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
    if (e.bindFramebuffer(e.FRAMEBUFFER, null), !s) {
      e.deleteFramebuffer(i), e.deleteTexture(t);
      return;
    }
    this.#d = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(S * _ * 4),
      previousLuma: new Uint8Array(S * _),
      currentLuma: new Uint8Array(S * _),
      nextLuma: new Uint8Array(S * _)
    };
  }
  #Xt() {
    this.#d && (this.#t.deleteFramebuffer(this.#d.framebuffer), this.#t.deleteTexture(this.#d.texture), this.#d = null);
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
  #Ht() {
    const e = this.#t;
    if (!(this.#w.length === U || this.#C === 0)) {
      this.#Qe();
      for (let t = 0; t < U; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#C,
          this.#O,
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
          e.deleteFramebuffer(s), e.deleteTexture(i), this.#Qe();
          return;
        }
        this.#w.push({ texture: i, framebuffer: s });
      }
      this.#N = U - 1;
    }
  }
  #Qe() {
    const e = this.#t, t = this.#S?.kind === "texture" ? this.#S.texture : null;
    this.#w.some((i) => i.texture === t) && (this.#S = null);
    for (const { texture: i, framebuffer: s } of this.#w)
      e.deleteFramebuffer(s), e.deleteTexture(i);
    this.#w = [], this.#z();
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #Ui() {
    if (this.#me) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#r), this.#me = t, this.#ut?.observe(this.#e), this.#lt();
  }
  #Ni() {
    if (this.#M) return;
    const e = this.#me;
    this.#me = null, this.#ut?.disconnect(), this.#r.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #hi = () => this.#lt();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #Wt(e) {
    return !this.#c || this.#v === "main" ? !1 : (this.#c.postMessage({
      type: "event",
      name: e,
      video: this.#Ct()
    }), !0);
  }
  #ai = () => {
    if (this.#Ze = Number.NaN, this.#Wt("emptied")) {
      this.#ne(), this.#J(!1);
      return;
    }
    this.#y = 0, this.#Le = 0, this.#Et = 0, this.#z(), this.#Q(), this.#b = 0, this.#Ai(), this.#G(), this.#S = null, this.#J(!1);
  };
  #Ai() {
    this.#k = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      resynced: 0,
      late: 0,
      queueResetted: 0
    }, this.#tt.fill(0), this.#Dt = 0, this.#se = 0, this.#Je = 0, this.#Ft = 0, this.#ce = 0, this.#Ne = 0, this.#Oe = 0, this.#Ge = 0, this.#we = 0, this.#Ae = 0, this.#G(), this.#ze = 0, this.#Fe = 0, this.#Xe = 0, this.#De = 0;
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #G() {
    this.#z(), this.#te = "video", this.#Pe = "c", this.#ft = 0, this.#dt = !0, this.#mt.reset(), this.#pt = 1 / 0, this.#vt = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #ci = () => {
    if (this.#Wt("seeking")) {
      this.#ne();
      return;
    }
    this.#Be = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #oe = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#Wt(e.type)) {
      this.#ne();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#Be;
      if (this.#Be = !1, i) return;
      this.#y = 0, this.#G(), this.#Q(), this.#S = null, this.#J(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#b = 0, this.#Le = this.#e.currentTime), this.#z(), this.#R && this.#y > 0) {
      const i = this.#Bt(), s = i === null ? void 0 : this.#w[i];
      i !== null && s ? (this.#N = i, this.#le(!0, !1, s.framebuffer), this.#si(i)) : this.#le(!0, !1, null);
    }
    t && (this.#y = 0, this.#se = 0, this.#G(), this.#Q());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #li = (e) => {
    if (e.preventDefault(), this.#M) {
      this.#M.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#v !== "active" && (this.#V = !0, this.#_t("the deinterlacer WebGL context was lost"), this.stop());
  };
}
function W(o, e) {
  const t = o.createProgram(), i = be(o, o.VERTEX_SHADER, at), s = be(o, o.FRAGMENT_SHADER, e);
  if (o.attachShader(t, i), o.attachShader(t, s), o.linkProgram(t), o.deleteShader(i), o.deleteShader(s), !o.getProgramParameter(t, o.LINK_STATUS)) {
    const r = o.getProgramInfoLog(t);
    throw o.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${r ?? "no reason given"}`
    );
  }
  return t;
}
function be(o, e, t) {
  const i = o.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (o.shaderSource(i, t), o.compileShader(i), !o.getShaderParameter(i, o.COMPILE_STATUS)) {
    const s = o.getShaderInfoLog(i);
    throw o.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return i;
}
const we = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", xt = 0.5, gt = 3e3, ye = 0.1, X = 16, Te = 'video/mp4; codecs="avc1.640029"';
let ce = null;
function bt(o = {}) {
  return ce ??= wt(o), ce;
}
async function St(o = {}) {
  return (await bt(o)).deinterlaces;
}
function _t() {
  ce = null;
}
async function wt(o) {
  const e = o.tolerance ?? xt, t = o.timeoutMs ?? gt, i = performance.now(), s = (a) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: a instanceof Error ? a.message : String(a)
  });
  if (typeof document > "u")
    return s(new Error("there is no document to decode in"));
  const r = document.createElement("video");
  r.muted = !0, r.defaultMuted = !0, r.playsInline = !0, r.preload = "auto";
  let n = null;
  try {
    n = Tt(r, t);
    const a = K(q(r, "loadeddata"), t), A = r.play().then(
      () => !0,
      () => !1
    );
    if (await n.ready, await a, await Ft(r, t, await A), r.videoWidth === 0 || r.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const l = Dt(r);
    return {
      deinterlaces: l < 1 - e,
      survives: l,
      tookMs: performance.now() - i
    };
  } catch (a) {
    return s(a);
  } finally {
    r.pause(), r.removeAttribute("src"), r.replaceChildren(), r.load(), n && URL.revokeObjectURL(n.url);
  }
}
const he = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, yt = typeof MediaSource > "u";
function Tt(o, e) {
  if (!he || !he.isTypeSupported(Te))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = we.indexOf(","), i = atob(we.slice(t + 1)), s = new Uint8Array(i.length);
  for (let A = 0; A < i.length; A++) s[A] = i.charCodeAt(A);
  const r = new he(), n = URL.createObjectURL(r);
  if (yt) {
    o.disableRemotePlayback = !0;
    const A = document.createElement("source");
    A.type = "video/mp4", A.src = n, o.append(A), o.load();
  } else
    o.src = n;
  const a = (async () => {
    await K(q(r, "sourceopen"), e);
    const A = r.addSourceBuffer(Te), l = K(q(A, "updateend"), e);
    A.appendBuffer(s), await l, r.endOfStream();
  })();
  return { url: n, ready: a };
}
async function Ft(o, e, t) {
  if (t) {
    const i = performance.now();
    for (; o.currentTime < ye && performance.now() - i < e; )
      await new Promise((s) => requestAnimationFrame(s));
    o.pause();
  } else
    o.currentTime = ye, await K(q(o, "seeked"), e);
}
function Dt(o) {
  const e = o.videoHeight, t = document.createElement("canvas");
  t.width = X, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(o, 0, 0, X, e);
  const s = i.getImageData(0, 0, X, e).data, r = (h) => {
    let d = 0;
    for (let u = 0; u < X; u++)
      d += s[(h * X + u) * 4 + 1] ?? 0;
    return d / X;
  };
  let n = 0;
  const a = 2, A = e - 3;
  let l = r(a);
  for (let h = a + 1; h <= A; h++) {
    const d = r(h);
    n += Math.abs(d - l), l = d;
  }
  return n / (A - a) / 255;
}
function q(o, e) {
  return new Promise((t, i) => {
    o.addEventListener(e, () => t(), { once: !0 }), o.addEventListener(
      "error",
      () => {
        const s = o instanceof HTMLMediaElement ? o.error : null, r = s ? ` (MediaError ${s.code}${s.message ? `: ${s.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${r}`));
      },
      { once: !0 }
    );
  });
}
function K(o, e) {
  return Promise.race([
    o,
    new Promise(
      (t, i) => setTimeout(
        () => i(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
st(Ce);
export {
  Mt as Deinterlacer,
  $e as FILM_ANALYSIS_FRAGMENT_SHADER,
  Ze as FILM_SAMPLE_FRAGMENT_SHADER,
  se as FILM_UNIFORMS,
  Qe as FILM_WEAVE_FRAGMENT_SHADER,
  Ye as YADIF_FRAGMENT_SHADER,
  Ve as YADIF_UNIFORMS,
  St as decoderDeinterlaces,
  _t as forgetDecoderProbe,
  bt as probeDecoder,
  Rt as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
