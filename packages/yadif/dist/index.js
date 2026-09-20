const Se = "" + new URL("assets/worker-CM3qGCuk.js", import.meta.url).href, te = `#version 300 es
void main() {
  // From the vertex index alone. There is no geometry here worth a buffer.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;
function Q(n, e, t) {
  const i = n.createProgram(), s = ue(n, n.VERTEX_SHADER, t), r = ue(n, n.FRAGMENT_SHADER, e);
  if (n.attachShader(i, s), n.attachShader(i, r), n.linkProgram(i), n.deleteShader(s), n.deleteShader(r), !n.getProgramParameter(i, n.LINK_STATUS)) {
    const o = n.getProgramInfoLog(i);
    throw n.deleteProgram(i), new Error(
      `the deinterlacer failed to link: ${o ?? "no reason given"}`
    );
  }
  return i;
}
function ue(n, e, t) {
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
const Ce = `#version 300 es
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
function Pe(n, e) {
  const t = Q(n, Ce, Le), i = n.getAttribLocation(t, "aVertexPosition"), s = n.getAttribLocation(t, "aTextureCoord"), r = n.getUniformLocation(t, "uTexture"), o = n.getUniformLocation(t, "uMatrix"), h = n.getUniformLocation(t, "uUvMatrix"), a = n.getUniformLocation(t, "uTextColor"), c = n.getUniformLocation(t, "uBackColor");
  if (r == null || o == null || h == null || a == null || c == null)
    throw new Error(
      "failed to initialize DEBUG_FRAGMENT_SHADER, DEBUG_VERTEX_SHADER"
    );
  const A = n.createBuffer(), d = n.createBuffer();
  return {
    gl: n,
    ...Be(n, e),
    program: t,
    programUniforms: {
      vertex: i,
      textureCoord: s,
      texture: r,
      matrix: o,
      uvMatrix: h,
      textColor: a,
      backColor: c
    },
    positionBuffer: A,
    textureBuffer: d
  };
}
function Be(n, e) {
  const t = new OffscreenCanvas(0, 0), i = t.getContext("2d"), s = /* @__PURE__ */ new Map();
  let r = 0;
  const o = 0;
  let h = 1;
  i.font = e, i.fillStyle = "white";
  for (let c = 32; c < 128; c++) {
    const A = String.fromCharCode(c), d = i.measureText(A), u = Math.ceil(
      d.actualBoundingBoxDescent + d.actualBoundingBoxAscent + 1
    ), l = Math.ceil(
      d.actualBoundingBoxLeft + d.actualBoundingBoxRight + 1
    );
    s.set(A, {
      x: r,
      y: o,
      width: l,
      height: u,
      metrics: d
    }), h = Math.max(h, u), r += l;
  }
  t.width = r, t.height = h, i.font = e, i.fillStyle = "white";
  for (const [c, A] of s)
    i.fillText(
      c,
      Math.floor(A.x + A.metrics.actualBoundingBoxLeft + 1),
      Math.floor(A.metrics.actualBoundingBoxAscent + 1)
    );
  const a = n.createTexture();
  return n.bindTexture(n.TEXTURE_2D, a), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MIN_FILTER, n.LINEAR), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MAG_FILTER, n.LINEAR), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_WRAP_S, n.CLAMP_TO_EDGE), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_WRAP_T, n.CLAMP_TO_EDGE), n.texImage2D(n.TEXTURE_2D, 0, n.RGBA, n.RGBA, n.UNSIGNED_BYTE, t), { fontTexture: a, chars: s, textureSize: { width: r, height: h } };
}
function Ie(n) {
  const e = n.gl;
  e.deleteBuffer(n.positionBuffer), e.deleteBuffer(n.textureBuffer), e.deleteTexture(n.fontTexture), e.deleteProgram(n.program);
}
function ke(n, e, t, i, s, r, o) {
  const h = [], a = [], c = t;
  for (const u of e) {
    if (u === `
`) {
      t = c, i += o;
      continue;
    }
    const l = n.chars.get(u);
    if (l == null)
      continue;
    if (l.width === 1) {
      t += l.metrics.width;
      continue;
    }
    const p = Math.floor(t - l.metrics.actualBoundingBoxLeft), v = Math.floor(i - l.metrics.actualBoundingBoxAscent), x = p + l.width, E = v + l.height;
    h.push(p, v), a.push(l.x, l.y), h.push(p, E), a.push(l.x, l.y + l.height), h.push(p + l.width, E), a.push(l.x + l.width, l.y + l.height), h.push(x, E), a.push(l.x + l.width, l.y + l.height), h.push(p, v), a.push(l.x, l.y), h.push(x, v), a.push(l.x + l.width, l.y), t += l.metrics.width;
  }
  const A = n.gl;
  A.useProgram(n.program), A.bindBuffer(A.ARRAY_BUFFER, n.positionBuffer), A.bufferData(A.ARRAY_BUFFER, new Float32Array(h), A.STATIC_DRAW), A.vertexAttribPointer(
    n.programUniforms.vertex,
    2,
    A.FLOAT,
    !1,
    0,
    0
  ), A.enableVertexAttribArray(n.programUniforms.vertex), A.bindBuffer(A.ARRAY_BUFFER, n.textureBuffer), A.bufferData(
    A.ARRAY_BUFFER,
    new Float32Array(a),
    A.STATIC_DRAW
  ), A.vertexAttribPointer(
    n.programUniforms.textureCoord,
    2,
    A.FLOAT,
    !1,
    0,
    0
  ), A.enableVertexAttribArray(n.programUniforms.textureCoord), A.activeTexture(A.TEXTURE0), A.bindTexture(A.TEXTURE_2D, n.fontTexture), A.uniform1i(n.programUniforms.texture, 0), A.uniform3fv(n.programUniforms.textColor, [1, 1, 1]), A.uniform3fv(n.programUniforms.backColor, [0, 0, 0]);
  function d(u, l, p) {
    const v = [];
    for (let x = 0; x < l; x++)
      for (let E = 0; E < u; E++)
        v.push(p[E * u + x]);
    return v;
  }
  A.uniformMatrix4fv(n.programUniforms.matrix, !1, d(4, 4, [
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
  ])), A.uniformMatrix3fv(n.programUniforms.uvMatrix, !1, d(3, 3, [
    1 / n.textureSize.width,
    0,
    0,
    0,
    1 / n.textureSize.height,
    0,
    0,
    0,
    1
  ])), A.viewport(0, 0, s, r), A.enable(A.BLEND), A.blendFunc(A.SRC_ALPHA, A.ONE_MINUS_SRC_ALPHA), A.drawArrays(A.TRIANGLES, 0, h.length / 2), A.disable(A.BLEND);
}
const T = {
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
}, I = 7, be = 2, Ue = 16, Ae = 1, Ne = 2, Fe = 5, Oe = {
  a: "uA",
  b: "uB",
  fieldMetrics: "uFieldMetrics",
  first: "uFirst",
  size: "uSize"
}, De = 16, ye = 8, Ge = `#version 300 es

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
  const int BLOCK_H = ${ye};

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

        diffEven += abs(a - b);
        totalEven += 1;
      }
      p.y += 1;
      if (p.x < uSize.x && p.y < uSize.y) {
        float a = luma(texelFetch(uA, p, 0).rgb);
        float b = luma(texelFetch(uB, p, 0).rgb);

        diffOdd += abs(a - b);
        totalOdd += 1;
      }
    }
  }

  float run = texelFetch(uFieldMetrics, ivec2(${T.phase}, 0), 0)[1];
  float threshold = run == 0.0 ? 0.025 : (run <= 10.0 ? 0.11 : 0.15);

  vec4 even = measure(diffEven, float(totalEven), threshold);
  vec4 odd = measure(diffOdd, float(totalOdd), threshold);
  outFirst = uFirst == 0 ? even : odd;
  outSecond = uFirst == 0 ? odd : even;
}
`, Xe = {
  second: "uSecond",
  first: "uFirst",
  size: "uSize"
}, W = 8, ze = `#version 300 es
precision highp float;

uniform sampler2D uSecond;
uniform sampler2D uFirst;

uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

void main()
{
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 base = dst * ${W};

  vec4 second = vec4(0.0);
  vec4 first = vec4(0.0);

  for (int y = 0; y < ${W}; ++y) {
    for (int x = 0; x < ${W}; ++x) {
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
  return differing <= ${be}.0;
}

bool differs(float differing) {
  return differing >= ${Ue}.0;
}

/** The phase texel, (phase, run), from the six comparisons' differing counts. */
vec4 decide(vec4 last, float dFirstRepeatsPrevious, float dSecondRepeatsNext,
            float dSecondRepeatsPrevious, float dPreviousSecondRepeated,
            float dFirstRepeatsNext, float dPreviousFirstRepeated)
{
  bool firstRepeatsPrevious = same(dFirstRepeatsPrevious);
  bool secondRepeatsNext = same(dSecondRepeatsNext);
  bool secondRepeatsPrevious = same(dSecondRepeatsPrevious);
  bool previousSecondRepeated = same(dPreviousSecondRepeated);
  bool firstRepeatsNext = same(dFirstRepeatsNext);
  bool previousFirstRepeated = same(dPreviousFirstRepeated);
  bool still = (firstRepeatsPrevious && secondRepeatsPrevious) || (secondRepeatsNext && firstRepeatsNext);

  int previous = int(last[0]);
  float run = last[1];
  // What each phase looks like: one field repeats, the other plainly does not.
  bool looks1 = firstRepeatsPrevious && differs(dSecondRepeatsPrevious);
  bool looks2 = secondRepeatsNext && differs(dFirstRepeatsNext);
  bool looks3 = secondRepeatsPrevious && differs(dFirstRepeatsPrevious);
  bool looks4 = previousSecondRepeated && differs(dPreviousFirstRepeated);
  bool looks5 = firstRepeatsNext && differs(dSecondRepeatsNext);

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
  bool believed = run >= ${Fe}.0;
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
  if (metric == ${T.firstRepeatsPrevious}) {
    outValue = previous(${T.firstRepeatsNext});
  } else if (metric == ${T.secondRepeatsNext}) {
    outValue = fold(uSecond);
  } else if (metric == ${T.secondRepeatsPrevious}) {
    outValue = previous(${T.secondRepeatsNext});
  } else if (metric == ${T.previousSecondRepeated}) {
    outValue = previous(${T.secondRepeatsPrevious});
  } else if (metric == ${T.firstRepeatsNext}) {
    outValue = fold(uFirst);
  } else if (metric == ${T.previousFirstRepeated}) {
    outValue = previous(${T.firstRepeatsPrevious});
  } else {
    outValue = decide(
      previous(${T.phase}),
      previous(${T.firstRepeatsNext})[1],
      fold(uSecond)[1],
      previous(${T.secondRepeatsNext})[1],
      previous(${T.secondRepeatsPrevious})[1],
      fold(uFirst)[1],
      previous(${T.firstRepeatsPrevious})[1]
    );
  }
}
`, Ye = {
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
}, $e = `#version 300 es
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
  return texelFetch(uFieldMetrics, ivec2(metric, 0), 0)[1] <= ${be}.0;
}

/** The pulldown phase the detection gave this frame, or 0. See film-shader.ts. */
int detectedPhase() {
  return int(texelFetch(uFieldMetrics, ivec2(${T.phase}, 0), 0)[0]);
}

bool isMixedPhase(int phase) {
  return phase == ${Ae} || phase == ${Ne};
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
  } else if (uFilm && !uSecond && isMixedPhase(detectedPhase())) {
    rgb = (y & 1) == firstParity() ? texelFetch(uCur, ivec2(x, y), 0).rgb
                                   : texelFetch(uPrev, ivec2(x, y), 0).rgb;
  } else if (uFilm && !uSecond && detectedPhase() != 0) {
    // One film frame, whole.
    rgb = texelFetch(uCur, ivec2(x, y), 0).rgb;
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
`, ie = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  topFieldFirst: "uTopFieldFirst",
  match: "uMatch"
}, _ = 288, S = 162, Ve = `#version 300 es
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
  ivec2 targetSize = ivec2(${_}, ${S});
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
  ivec2 targetSize = ivec2(${_}, ${S});
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
class D {
  static CYCLE = 5;
  static COMB_THRESHOLD = 9;
  static COMBED_PIXEL_LIMIT = 80;
  static DECIMATE_BLOCK = 32;
  static DUPLICATE_PERCENT = 1.1;
  #r;
  #i;
  #e;
  #l = 0;
  #t = null;
  #s = [];
  #x = null;
  #n = 1 / 0;
  #u = 1 / 0;
  constructor(e, t) {
    this.#r = e, this.#i = t, this.#e = 255 * D.DECIMATE_BLOCK ** 2 * D.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, s, r = D.COMBED_PIXEL_LIMIT) {
    const o = s ? 1 : 0, h = { p: e, c: t, n: i };
    let a = this.#T("c", "p", o, h);
    const c = /* @__PURE__ */ new Map(), A = (v) => {
      const x = c.get(v);
      if (x !== void 0) return x;
      const E = D.#f(
        this.weave(e, t, i, v, s),
        this.#r,
        this.#i
      );
      return c.set(v, E), E;
    }, d = A(a), u = A("n");
    (u * 3 < d || u * 2 < d && d > r) && Math.abs(u - d) >= 30 && u < r && (a = "n");
    const l = A(a), p = l >= r;
    return p && (a = "c"), {
      match: a,
      combScore: l,
      isCombed: p,
      luma: this.weave(e, t, i, a, s)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#l, i = this.#x ? D.#g(
      this.#x,
      e,
      this.#r,
      this.#i
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#s.push(i);
    const s = this.#t === t, r = s && i.maxBlockDifference < this.#e;
    s && !r && (this.#t = null);
    const o = this.#t;
    this.#x = e.slice(), this.#l++;
    let h = this.#t;
    if (this.#l === D.CYCLE) {
      let a = 0, c = null;
      for (let A = 1; A < this.#s.length; A++)
        (this.#s[A]?.maxBlockDifference ?? 1 / 0) < (this.#s[a]?.maxBlockDifference ?? 1 / 0) ? (c = a, a = A) : (c === null || (this.#s[A]?.maxBlockDifference ?? 1 / 0) < (this.#s[c]?.maxBlockDifference ?? 1 / 0)) && (c = A);
      this.#n = this.#s[a]?.maxBlockDifference ?? 1 / 0, this.#u = c === null ? 1 / 0 : this.#s[c]?.maxBlockDifference ?? 1 / 0, h = (this.#s[a]?.maxBlockDifference ?? 1 / 0) < this.#e ? a : null, this.#t = h, this.#s = [], this.#l = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: r,
      dropIndex: o,
      nextDropIndex: h,
      lowestCycleDifference: this.#n,
      runnerUpCycleDifference: this.#u
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, s, r) {
    if (s === "c") return t.slice();
    const o = t.slice(), h = s === "p" ? e : i, a = o.length / this.#i, c = r ? 1 : 0;
    for (let A = c; A < this.#i; A += 2)
      o.set(
        h.subarray(A * a, (A + 1) * a),
        A * a
      );
    return o;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#l = 0, this.#t = null, this.#s = [], this.#x = null, this.#n = 1 / 0, this.#u = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #T(e, t, i, s) {
    const r = this.#r, o = this.#i, h = 2 - i, a = 2 - i, c = s[e], A = s[t], d = D.#p(
      c,
      A,
      r,
      o,
      i
    );
    let u = 0, l = 0, p = 0, v = 0, x = 0, E = 0;
    for (let P = 2; P < o - 2; P += 2) {
      const y = (P - 2) / 2, K = h - 1 + y * 2, J = h + 1 + y * 2, ee = h + 3 + y * 2, Y = h + y * 2, z = Y + 2, N = a + y * 2, C = N + 2, ce = h + y * 2;
      for (let M = 8; M < r - 8; M++) {
        const B = (d[ce * r + M] ?? 0) | (d[(ce + 2) * r + M] ?? 0);
        if (B === 0) continue;
        const le = (s.c[K * r + M] ?? 0) + ((s.c[J * r + M] ?? 0) << 2) + (s.c[ee * r + M] ?? 0), O = Math.abs(
          3 * ((c[Y * r + M] ?? 0) + (c[z * r + M] ?? 0)) - le
        ), G = Math.abs(
          3 * ((A[N * r + M] ?? 0) + (A[C * r + M] ?? 0)) - le
        );
        O > 23 && (B & 1) !== 0 && (u += O), G > 23 && (B & 1) !== 0 && (v += G), O > 42 && (B & 2) !== 0 && (l += O), G > 42 && (B & 2) !== 0 && (x += G), O > 42 && (B & 4) !== 0 && (p += O), G > 42 && (B & 4) !== 0 && (E += G);
      }
    }
    l < 500 && x < 500 && (p >= 500 || E >= 500) && Math.max(p, E) > 3 * Math.min(p, E) && (l = p, x = E);
    const g = Math.floor(u / 6 + 0.5), w = Math.floor(v / 6 + 0.5), f = Math.floor(l / 6 + 0.5), m = Math.floor(x / 6 + 0.5), b = Math.max(g, w) / Math.max(Math.min(g, w), 1), R = Math.max(f, m) / Math.max(Math.min(f, m), 1), L = Math.max(f, m) / Math.max(Math.max(g, w), 1);
    return (f >= 500 || m >= 500) && (f * 2 < m || m * 2 < f) || (f >= 1e3 || m >= 1e3) && (f * 3 < m * 2 || m * 3 < f * 2) || (f >= 2e3 || m >= 2e3) && (f * 5 < m * 4 || m * 5 < f * 4) || (f >= 4e3 || m >= 4e3) && R > b || L > 5e-3 && Math.max(f, m) > 150 && (f * 2 < m || m * 2 < f) ? f > m ? t : e : g > w ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #p(e, t, i, s, r) {
    const o = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(i)
    ), h = r === 1 ? 1 : 0;
    for (let A = 0; A < o.length; A++) {
      const d = Math.min(s - 1, h + A * 2), u = o[A];
      if (u)
        for (let l = 0; l < i; l++)
          u[l] = Math.abs(
            (e[d * i + l] ?? 0) - (t[d * i + l] ?? 0)
          );
    }
    const a = new Uint8Array(i * s), c = r === 1 ? 3 : 2;
    for (let A = 1; A < o.length - 1; A++) {
      const d = c + (A - 1) * 2;
      if (d >= s) break;
      const u = o[A];
      if (u)
        for (let l = 1; l < i - 1; l++) {
          const p = u[l] ?? 0;
          if (p <= 3) continue;
          let v = 0;
          for (let m = l - 1; m <= l + 1; m++)
            v += (o[A - 1]?.[m] ?? 0) > 3 ? 1 : 0, v += (o[A]?.[m] ?? 0) > 3 ? 1 : 0, v += (o[A + 1]?.[m] ?? 0) > 3 ? 1 : 0;
          if (v <= 1) continue;
          const x = d * i + l;
          if (a[x] = 1, p <= 19) continue;
          v = 0;
          let E = !1, g = !1;
          for (let m = l - 1; m <= l + 1; m++)
            (o[A - 1]?.[m] ?? 0) > 19 && (v++, E = !0), (o[A]?.[m] ?? 0) > 19 && v++, (o[A + 1]?.[m] ?? 0) > 19 && (v++, g = !0);
          if (v <= 3) continue;
          if (E && g) {
            a[x] |= 2;
            continue;
          }
          let w = !1, f = !1;
          for (let m = Math.max(l - 4, 0); m < Math.min(l + 5, i); m++)
            A !== 1 && (o[A - 2]?.[m] ?? 0) > 19 && (w = !0), (o[A - 1]?.[m] ?? 0) > 19 && (E = !0), (o[A + 1]?.[m] ?? 0) > 19 && (g = !0), A !== o.length - 2 && (o[A + 2]?.[m] ?? 0) > 19 && (f = !0);
          E && (g || w) || g && (E || f) ? a[x] |= 2 : v > 5 && (a[x] |= 4);
        }
    }
    return a;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #f(e, t, i) {
    const s = new Uint8Array(t * i), r = (h, a) => e[Math.max(0, Math.min(i - 1, a)) * t + h] ?? 0;
    for (let h = 0; h < i; h++)
      for (let a = 0; a < t; a++) {
        const c = r(a, h), A = r(a, h === 0 ? 1 : h - 1), d = r(a, h === i - 1 ? i - 2 : h + 1), u = h < 2 ? r(a, h === 0 ? 2 : 3) : r(a, h - 2), l = h + 2 >= i ? r(a, h === i - 1 ? i - 3 : i - 4) : r(a, h + 2);
        (h === 0 ? Math.abs(c - d) > D.COMB_THRESHOLD : h === i - 1 ? Math.abs(c - A) > D.COMB_THRESHOLD : Math.abs(c - A) > D.COMB_THRESHOLD && Math.abs(c - d) > D.COMB_THRESHOLD) && Math.abs(
          4 * c - 3 * (A + d) + u + l
        ) > D.COMB_THRESHOLD * 6 && (s[h * t + a] = 255);
      }
    let o = 0;
    for (const h of [0, 8])
      for (const a of [0, 8])
        for (let c = h; c < i; c += 16)
          for (let A = a; A < t; A += 16) {
            let d = 0;
            for (let u = Math.max(1, c); u < Math.min(i - 1, c + 16); u++)
              for (let l = A; l < Math.min(t, A + 16); l++) {
                const p = u * t + l;
                s[p - t] === 255 && s[p] === 255 && s[p + t] === 255 && d++;
              }
            o = Math.max(o, d);
          }
    return o;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #g(e, t, i, s) {
    const r = D.DECIMATE_BLOCK / 2, o = Math.ceil(i / r), h = Math.ceil(s / r), a = new Float64Array(o * h), c = e.length / (i * s);
    for (let u = 0; u < s; u++) {
      const l = Math.floor(u / r);
      for (let p = 0; p < i; p++) {
        const v = Math.floor(p / r), x = l * o + v, E = (u * i + p) * c;
        if (c === 1) {
          a[x] = (a[x] ?? 0) + Math.abs((e[E] ?? 0) - (t[E] ?? 0));
          continue;
        }
        const g = Math.round(
          (e[E] ?? 0) * 0.2126 + (e[E + 1] ?? 0) * 0.7152 + (e[E + 2] ?? 0) * 0.0722
        ), w = Math.round(
          (t[E] ?? 0) * 0.2126 + (t[E + 1] ?? 0) * 0.7152 + (t[E + 2] ?? 0) * 0.0722
        );
        if (a[x] = (a[x] ?? 0) + Math.abs(g - w), (p & 1) !== 0 || (u & 1) !== 0) continue;
        let f = 0, m = 0, b = 0, R = 0, L = 0, P = 0, y = 0;
        for (let z = u; z < Math.min(u + 2, s); z++)
          for (let N = p; N < Math.min(p + 2, i); N++) {
            const C = (z * i + N) * c;
            f += e[C] ?? 0, m += e[C + 1] ?? 0, b += e[C + 2] ?? 0, R += t[C] ?? 0, L += t[C + 1] ?? 0, P += t[C + 2] ?? 0, y++;
          }
        const K = Math.round(
          (-0.114572 * f - 0.385428 * m + 0.5 * b) / y
        ), J = Math.round(
          (-0.114572 * R - 0.385428 * L + 0.5 * P) / y
        ), ee = Math.round(
          (0.5 * f - 0.454153 * m - 0.045847 * b) / y
        ), Y = Math.round(
          (0.5 * R - 0.454153 * L - 0.045847 * P) / y
        );
        a[x] = (a[x] ?? 0) + Math.abs(K - J) + Math.abs(ee - Y);
      }
    }
    let A = -1;
    for (let u = 0; u < h - 1; u++)
      for (let l = 0; l < o - 1; l++)
        A = Math.max(
          A,
          (a[u * o + l] ?? 0) + (a[u * o + l + 1] ?? 0) + (a[(u + 1) * o + l] ?? 0) + (a[(u + 1) * o + l + 1] ?? 0)
        );
    let d = 0;
    for (const u of a) d += u;
    return { maxBlockDifference: A, totalDifference: d };
  }
}
const k = { phase: 0, run: 0 };
function se(n, e, t) {
  return Object.fromEntries(
    Object.entries(t).map(([i, s]) => [
      i,
      n.getUniformLocation(e, s)
    ])
  );
}
class fe {
  #r;
  #i;
  #e;
  #l;
  #t;
  #s;
  #x;
  /** The block comparisons of both fields, and the same folded most of the way. */
  #n = null;
  #u = null;
  /** The field metrics (see FIELD_METRICS) of this frame and the one before. */
  #T = null;
  /** Which of the two holds the newest metrics. */
  #p = 0;
  /** The metrics being read back asynchronously. */
  #f = null;
  #g = null;
  /** The last metrics read back, laid out as FIELD_METRICS says. */
  metrics = new Float32Array(I * 4);
  #_ = 0;
  #B = 0;
  constructor(e) {
    this.#r = e, this.#i = Q(
      e,
      Ge,
      te
    ), this.#e = se(
      e,
      this.#i,
      Oe
    ), this.#l = Q(
      e,
      ze,
      te
    ), this.#t = se(
      e,
      this.#l,
      Xe
    ), this.#s = Q(
      e,
      We,
      te
    ), this.#x = se(e, this.#s, He);
  }
  /** The newest measurements, or null before any frame has been measured. */
  get texture() {
    return this.#T?.[this.#p]?.textures[0] ?? null;
  }
  /** The size of the frames to be measured, which sizes the block grid. */
  resize(e, t) {
    e === this.#_ && t === this.#B || (this.#_ = e, this.#B = t, this.#he());
  }
  /** Forget every measurement: the next frame starts a cycle from nothing. */
  reset() {
    const e = this.#r;
    e.deleteSync(this.#g), this.#g = null;
    const t = this.#T?.[this.#p];
    if (!t) return;
    const i = new Float32Array(I * 4);
    for (let s = 0; s < T.phase; s++)
      i[s * 4 + 1] = 1;
    e.bindTexture(e.TEXTURE_2D, t.textures[0] ?? null), e.texSubImage2D(
      e.TEXTURE_2D,
      0,
      0,
      0,
      I,
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
    const s = this.#r;
    if (this.#_ === 0 || this.#B === 0) return;
    this.#Y();
    const r = this.#n, o = this.#u, h = this.#T;
    if (r === null || o === null || h === null) return;
    const a = h[this.#p], c = h[1 - this.#p];
    s.bindFramebuffer(s.FRAMEBUFFER, r.framebuffer), s.useProgram(this.#i), this.#F(0, e, this.#e.a), this.#F(1, t, this.#e.b), this.#F(2, a.textures[0], this.#e.fieldMetrics), s.uniform1i(this.#e.first, i), s.uniform2i(this.#e.size, this.#_, this.#B), s.viewport(0, 0, r.width, r.height), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, o.framebuffer), s.useProgram(this.#l), this.#F(0, r.textures[0], this.#t.second), this.#F(1, r.textures[1], this.#t.first), s.uniform2i(this.#t.size, r.width, r.height), s.viewport(0, 0, o.width, o.height), s.drawArrays(s.TRIANGLES, 0, 3), s.bindFramebuffer(s.FRAMEBUFFER, c.framebuffer), s.useProgram(this.#s), this.#F(0, a.textures[0], this.#x.previous), this.#F(1, o.textures[0], this.#x.second), this.#F(2, o.textures[1], this.#x.first), s.uniform2i(this.#x.size, o.width, o.height), s.viewport(0, 0, I, 1), s.drawArrays(s.TRIANGLES, 0, 3), this.#p = 1 - this.#p, s.deleteSync(this.#g), s.bindBuffer(s.PIXEL_PACK_BUFFER, this.#f), s.readPixels(0, 0, I, 1, s.RGBA, s.FLOAT, 0), s.bindBuffer(s.PIXEL_PACK_BUFFER, null), s.bindFramebuffer(s.FRAMEBUFFER, null), this.#g = s.fenceSync(s.SYNC_GPU_COMMANDS_COMPLETE, 0), s.flush();
  }
  /**
   * The phase of the last frame measured, once the GPU has handed it back,
   * and null while it is still on its way. It is handed back once.
   */
  poll() {
    const e = this.#r, t = this.#g;
    if (t === null || this.#f === null) return null;
    switch (e.clientWaitSync(t, 0, 0)) {
      case e.ALREADY_SIGNALED:
      case e.CONDITION_SATISFIED:
        return e.bindBuffer(e.PIXEL_PACK_BUFFER, this.#f), e.getBufferSubData(e.PIXEL_PACK_BUFFER, 0, this.metrics), e.bindBuffer(e.PIXEL_PACK_BUFFER, null), e.deleteSync(t), this.#g = null, {
          phase: this.metrics[T.phase * 4] ?? 0,
          run: this.metrics[T.phase * 4 + 1] ?? 0
        };
      default:
        return null;
    }
  }
  destroy() {
    const e = this.#r;
    if (this.#he(), this.#T !== null) {
      for (const t of this.#T) Z(e, t);
      this.#T = null;
    }
    e.deleteSync(this.#g), this.#g = null, e.deleteBuffer(this.#f), this.#f = null, e.deleteProgram(this.#i), e.deleteProgram(this.#l), e.deleteProgram(this.#s);
  }
  #F(e, t, i) {
    const s = this.#r;
    s.activeTexture(s.TEXTURE0 + e), s.bindTexture(s.TEXTURE_2D, t ?? null), s.uniform1i(i, e);
  }
  #he() {
    const e = this.#r;
    this.#n !== null && Z(e, this.#n), this.#u !== null && Z(e, this.#u), this.#n = null, this.#u = null;
  }
  /** Everything detect needs that is not there yet. */
  #Y() {
    const e = this.#r;
    if (this.#n === null || this.#u === null) {
      this.#he();
      const t = Math.ceil(this.#_ / De), i = Math.ceil(this.#B / (ye * 2));
      this.#n = $(e, t, i, 2), this.#u = $(
        e,
        Math.ceil(t / W),
        Math.ceil(i / W),
        2
      );
    }
    this.#T === null && (this.#T = [
      $(e, I, 1, 1),
      $(e, I, 1, 1)
    ], this.#p = 0, this.reset()), this.#f === null && (this.#f = e.createBuffer(), e.bindBuffer(e.PIXEL_PACK_BUFFER, this.#f), e.bufferData(
      e.PIXEL_PACK_BUFFER,
      this.metrics.byteLength,
      e.STREAM_READ
    ), e.bindBuffer(e.PIXEL_PACK_BUFFER, null));
  }
}
function $(n, e, t, i) {
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
  const o = n.checkFramebufferStatus(n.FRAMEBUFFER) === n.FRAMEBUFFER_COMPLETE;
  n.bindFramebuffer(n.FRAMEBUFFER, null);
  const h = { framebuffer: s, textures: r, width: e, height: t };
  if (!o)
    throw Z(n, h), new Error("failed to allocate framebuffer");
  return h;
}
function Z(n, { framebuffer: e, textures: t }) {
  n.deleteFramebuffer(e);
  for (const i of t) n.deleteTexture(i);
}
const Re = [
  "mozParsedFrames",
  "mozDecodedFrames",
  "mozPresentedFrames",
  "mozPaintedFrames"
];
function Me(n) {
  return Re.every((e) => e in n);
}
function je(n) {
  return n.ownerDocument?.defaultView?.performance.timeOrigin ?? performance.timeOrigin;
}
function qe() {
  return typeof HTMLVideoElement < "u" && (Me(HTMLVideoElement.prototype) || typeof HTMLVideoElement.prototype.requestVideoFrameCallback == "function");
}
const Ke = 250, Je = 500;
class et {
  #r;
  #i;
  #e = null;
  #l = null;
  #t = null;
  #s = null;
  #x = !1;
  #n = !0;
  #u = null;
  #T = null;
  #p = 0;
  constructor(e) {
    if (this.#r = e, this.#i = Me(e) ? e : null, this.#i) {
      for (const t of ["emptied", "seeking", "seeked"])
        e.addEventListener(t, this.#g);
      for (const t of ["pause", "playing", "waiting", "ratechange"])
        e.addEventListener(t, this.#f);
    }
  }
  /** Whether acquisition runs off the Firefox counters. */
  get mozDriven() {
    return this.#i !== null;
  }
  /** Whether any frame has been delivered yet (counters proven live). */
  get hasDelivered() {
    return this.#x;
  }
  request(e) {
    this.#e === null && (this.#l = e, this.#e = this.#i ? requestAnimationFrame(this.#F) : this.#r.requestVideoFrameCallback(this.#_));
  }
  cancel() {
    this.#e !== null && (this.#i ? cancelAnimationFrame(this.#e) : this.#r.cancelVideoFrameCallback(this.#e)), this.#e = null, this.#l = null, this.#g();
  }
  destroy() {
    this.cancel();
    for (const e of ["emptied", "seeking", "seeked"])
      this.#r.removeEventListener(e, this.#g);
    for (const e of ["pause", "playing", "waiting", "ratechange"])
      this.#r.removeEventListener(e, this.#f);
  }
  #f = () => {
    this.#u = null, this.#T = null, this.#p = 0;
  };
  #g = () => {
    this.#t = null, this.#s = null, this.#n = !0, this.#f();
  };
  /** Native acquisition: pass the report on, with the clock it was made on. */
  #_ = (e, t) => {
    this.#B(e, {
      width: t.width,
      height: t.height,
      mediaTime: t.mediaTime,
      presentedFrames: t.presentedFrames,
      expectedDisplayTime: t.expectedDisplayTime,
      timeOrigin: je(this.#r)
    });
  };
  #B = (e, t) => {
    const i = this.#l;
    this.#e = null, this.#l = null, this.#x = !0, i?.(e, t);
  };
  #F = (e) => {
    const t = this.#i, i = Re.map((h) => t[h]);
    this.#t?.some((h, a) => i[a] < h) && this.#g(), this.#t = i;
    const s = t.mozPaintedFrames, r = !t.seeking && t.readyState >= 2 && t.videoWidth > 0 && t.videoHeight > 0, o = this.#s === null && (s > 0 || t.paused && (t.mozPresentedFrames > 0 || t.mozDecodedFrames > 0));
    if (r && (o || this.#s !== null && s !== this.#s)) {
      if (this.#u !== null && e - this.#u > Je && (this.#f(), this.#n = !0), !t.paused && !t.ended) {
        const a = this.#T;
        if (a && e - a.at >= Ke) {
          const c = s - a.frames;
          if (c > 0) {
            const A = (e - a.at) / c;
            A >= 4 && A <= 200 && (this.#p = this.#p ? this.#p + (A - this.#p) * 0.25 : A);
          }
          this.#T = null;
        }
        this.#T ??= { at: e, frames: s };
      }
      this.#u = e, this.#s = s;
      const h = this.#n;
      this.#n = !1, this.#B(e, {
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
        mozTiming: { periodMs: this.#p, discontinuity: h }
      });
    } else
      this.#e = requestAnimationFrame(this.#F);
  };
}
let _e = null;
function tt(n) {
  _e = n;
}
const de = 0.5, F = 4, he = 5, U = he + 1, me = 1e3, re = 4, V = 200, it = 0.25, st = 1e3 / 60, rt = 250, nt = 1e3 / 30;
function pe(n) {
  if (!Number.isFinite(n) || n < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return n;
}
const ot = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, At = 0.75, ht = 0.1, Ee = 1, at = 0.02, ct = 0.1, ve = 1, lt = 4, ne = 5, ut = 4, ft = {
  2: 0,
  3: 0.25,
  4: 0.5,
  5: 0.75
}, dt = 3, mt = `#version 300 es
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
function Dt() {
  return qe() && typeof WebGL2RenderingContext < "u";
}
const pt = {
  requestAnimationFrame: (n) => requestAnimationFrame(n),
  cancelAnimationFrame: (n) => cancelAnimationFrame(n)
};
class yt extends EventTarget {
  #r;
  #i;
  #e;
  #l;
  #t;
  /** The pulldown detection, built only while the `film` option needs it. */
  #s = null;
  #x;
  #n;
  /** The program that copies a filtered picture onto the canvas. */
  #u;
  #T;
  #p;
  /** The reduced pass that reads previous, current and next luma together. */
  #f = null;
  #g = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #_ = null;
  #B = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #F = null;
  #he = null;
  #Y = null;
  #C = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #L = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #De = U - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #y = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #A = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #U = null;
  #Ye = 0;
  /** ページ側で frame callback の停止を監視する requestAnimationFrame()。 */
  #N = null;
  /** The document the owner-change listener is on, if any. */
  #ye = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #O = st;
  /** Where the refresh grid fitted to the animation frames stands. (otya) */
  #Re = 0;
  /** How far ahead of its animation frame the last picture shown stood. (otya) */
  #Wt = 0;
  #ct = 0;
  #se = 0;
  /** The last picture chained onto the schedule; a break restarts it. (otya) */
  #Q = null;
  /**
   * Drop the presentation queue and restart the schedule from the clock.
   * Every schedule restart goes through here (otya nulls #lastScheduled at
   * each queue clear): the old chain's clock no longer applies, so keeping
   * it would either count a phantom resync or pop freshly queued pictures
   * as late. Restart accounting for cadence changes lives in #schedule.
   */
  #I() {
    this.#A.length = 0, this.#Q = null, this.#se = 0;
  }
  /** The `<div>` this put around the element, so it can be taken away again. */
  #ae = null;
  #lt;
  #G;
  #a;
  #ce;
  #le;
  #Z = "video";
  #Me = "c";
  #ut = 0;
  #ft = !0;
  #dt = new D(_, S);
  #mt = 1 / 0;
  #pt = 1 / 0;
  #re = 0;
  /** otya GPU pulldown path: enabled by the `film` option (see below). */
  #$;
  #D;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #h = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #w = 0;
  #S = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #b = F - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #m = 0;
  #_e = 0;
  /** presentedFrames at the last ingested frame; pairs with #lastMediaTime. */
  #Et = 0;
  #$e = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #Se = !1;
  /** 最終通知時刻。rVFC と Firefox カウンターのどちらの取得経路でも更新する。 */
  #Ve = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #ue = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #vt = 0;
  #E = !1;
  /** Cancels work suspended inside a synchronous owner callback. */
  #j = 0;
  #Qe = !1;
  #k = !1;
  #d = null;
  #fe = [];
  #X = !1;
  #xt;
  #Tt;
  #v;
  #Ze;
  #q;
  #gt;
  #o = null;
  #c;
  #Ce = !1;
  #wt = 0;
  #bt = !1;
  #ui = 0;
  #Le = !1;
  #je = !1;
  #de = null;
  #fi = 0;
  #Pe = /* @__PURE__ */ new Map();
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #R = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    resynced: 0,
    late: 0,
    queueResetted: 0
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #ne = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #Ft = 0;
  #qe = 0;
  #oe = 0;
  #Be = 0;
  #Ie = 0;
  #ke = 0;
  #me = 0;
  #pe;
  #Ke = [];
  #Ee = [];
  #Ue = 0;
  #ve = 0;
  #Ne = 0;
  #xe = 0;
  /** The last phase read back from the GPU, and how many frames ago it was for. */
  #Oe = k;
  #Te = 0;
  /** The phase of the frame being filtered: #known advanced by #knownAge. */
  #M = k;
  #K = !1;
  #ge = null;
  #Yt = "";
  /** Debug only: frames given each phase (0 for none), and repeats dropped. */
  #Je = [0, 0, 0, 0, 0, 0];
  #Dt = 0;
  /**
   * Why requested film reconstruction is currently degraded, or null while
   * healthy. The `film` / `autoFilm` options stay as the caller set them;
   * only the engine stands down, so this is never a silent option change.
   */
  #z = null;
  /** Consecutive autoFilm analyses with no usable target or programs. */
  #et = 0;
  /** Last worker-reported filmError, to derive the page-side failure event. */
  #tt = null;
  #yt = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#G = t.doubleRate ?? !1, this.#a = t.autoFilm ?? !1, this.#ce = pe(
      t.filmCombThreshold ?? D.COMBED_PIXEL_LIMIT
    ), this.#le = t.spatialCheck ?? !0, this.#$ = t.debug ?? !1, this.#D = t.film ?? !1, this.#xt = t.onStats, this.#Tt = t.onFailure, this.#v = i, this.#q = i ? "main" : t.rendering ?? "auto", this.#gt = t.workerUrl ?? _e, this.#c = this.#q === "main" ? "main" : "idle", this.#i = i ? i.canvas : document.createElement("canvas"), this.#r = i?.canvas ?? (this.#q === "main" ? this.#i : document.createElement("canvas")), this.#Ze = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const s = this.#r.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!(s instanceof WebGL2RenderingContext))
      throw new Error("this browser has no WebGL2");
    this.#t = s, this.#D && !this.#a && (this.#Vt(), this.#s = new fe(s)), this.#x = H(s, $e);
    const r = this.#x;
    this.#n = Object.fromEntries(
      Object.entries(Ye).map(([o, h]) => [
        o,
        s.getUniformLocation(r, h)
      ])
    ), this.#u = H(s, mt), this.#T = s.getUniformLocation(this.#u, "uField"), this.#p = s.getUniformLocation(this.#u, "uFlip"), this.#a && this.#ti(), this.#pe = s.getExtension(
      "EXT_disjoint_timer_query_webgl2"
    ), this.#r.addEventListener(
      "webglcontextlost",
      this.#li
    ), this.#lt = i ? null : new ResizeObserver(() => this.#at()), this.#l = new et(e), e.addEventListener("emptied", this.#hi), e.addEventListener("resize", this.#Ai), e.addEventListener("pause", this.#ie), e.addEventListener("ended", this.#ie), e.addEventListener("seeking", this.#ci), e.addEventListener("seeked", this.#ie), e.addEventListener("ratechange", this.#ie);
  }
  get running() {
    return this.#E && (this.#d?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#i;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #it() {
    return this.#d?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #$t() {
    return {
      doubleRate: this.#G,
      autoFilm: this.#a,
      filmCombThreshold: this.#ce,
      spatialCheck: this.#le,
      film: this.#D,
      debug: this.#$
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#Qe;
  }
  set enabled(e) {
    this.#Qe = e, this.#Mt(), this.#o?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#d?.interlaced !== e?.interlaced, i = t || this.#d?.topFieldFirst !== e?.topFieldFirst;
    this.#d = e, !(i && (!this.#J() || this.#d !== e)) && (this.#o?.postMessage({ type: "scan", scan: e }), i && (this.#m = 0, this.#P(), this.#W(), t && (this.#h = 0), this.#y = null, this.#V(!1)), this.#Mt(), i && ((e?.interlaced ?? !0) && (this.#v || this.#c === "main") ? this.#be() : this.#Bt()));
  }
  get scan() {
    return this.#d;
  }
  set videoTimeline(e) {
    this.#fe = e, this.#o?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#d = null), this.#Mt();
  }
  get videoTimeline() {
    return this.#fe;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#ae ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#G;
  }
  set doubleRate(e) {
    e !== this.#G && (this.#G = e, this.#H(), this.#I(), this.#Rt());
  }
  get spatialCheck() {
    return this.#le;
  }
  set spatialCheck(e) {
    e !== this.#le && (this.#le = e, this.#H());
  }
  get film() {
    return this.#D;
  }
  set film(e) {
    if (this.#a) {
      this.#D = e, this.#H();
      return;
    }
    const t = this.#o ? this.#tt : this.#z;
    if (!(e === this.#D && (e === !1 || t === null))) {
      if (this.#o) {
        this.#D = e, this.#H(e ? "film" : void 0);
        return;
      }
      if (e) {
        if (!this.#J()) return;
        try {
          this.#Qt();
        } catch (i) {
          this.#D = !0, this.#H(), this.#Ge(
            `film detector unavailable: ${i instanceof Error ? i.message : String(i)}`
          );
          return;
        }
      }
      if (this.#D = e, this.#H(), !e) {
        if (!this.#J()) return;
        this.#K = !1, this.#M = k, this.#W(), this.#s?.destroy(), this.#s = null;
      }
      this.#Rt();
    }
  }
  get debug() {
    return this.#$;
  }
  set debug(e) {
    e !== this.#$ && (this.#$ = e, this.#H());
  }
  /** Whether pictures are queued and put up by the loop rather than drawn on arrival.
   * autoFilm joins the otya condition so the CPU film path keeps its loop.
   */
  get #di() {
    return this.#G || this.#D || this.#a;
  }
  #Rt() {
    this.#k || (this.#di ? (this.#w > 0 && this.#zt(), (this.#d?.interlaced ?? !0) && (this.#v || this.#c === "main") && this.#be()) : !this.#a && !this.#D && (this.#y = null, this.#V(!1), this.#We()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#a;
  }
  set autoFilm(e) {
    const t = this.#o ? this.#tt : this.#z;
    if (!(e === this.#a && (!e || t === null))) {
      if (this.#a = e, this.#o) {
        this.#H(e ? "autoFilm" : void 0);
        return;
      }
      if (this.#H(), this.#P(), e) {
        if (this.#W(), this.#s?.destroy(), this.#s = null, !this.#J() || this.#a !== e) return;
        this.#w > 0 && this.#zt(), (this.#d?.interlaced ?? !0) && (this.#v || this.#c === "main") && this.#be();
      } else {
        if (!this.#J() || this.#a !== e) return;
        this.#Xt(), this.#Rt();
      }
    }
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#ce;
  }
  set filmCombThreshold(e) {
    const t = pe(e);
    t !== this.#ce && (this.#ce = t, this.#H(), this.#a && this.#P());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #H(e) {
    this.#o?.postMessage({
      type: "settings",
      options: this.#$t(),
      retryFilm: e
    });
  }
  #Vt() {
    if (this.#t.getExtension("EXT_color_buffer_float") === null)
      throw new Error("film needs EXT_color_buffer_float");
  }
  /** Build the GPU pulldown detector the `film` option needs, or throw. */
  #Qt() {
    this.#Vt(), this.#s ??= new fe(this.#t), this.#w > 0 && this.#s.resize(this.#w, this.#S);
  }
  #Mt() {
    this.#Qe && (this.#fe.length > 0 || (this.#d?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #mi() {
    return this.#v || this.#q === "main" ? !1 : this.#c === "starting" || this.#c === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#gt !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Zt(), !0) : this.#q === "auto" ? (this.#st(), !1) : (this.#c = "failed", this.#E = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #Zt() {
    this.#ee(), this.#o?.terminate(), this.#o = null, this.#Le = !1, this.#je = !1, this.#tt = null, this.#yt = 0;
    let e = this.#i;
    if (this.#bt) {
      e = document.createElement("canvas"), e.className = this.#i.className;
      const r = this.#i.getAttribute("style");
      r === null ? e.removeAttribute("style") : e.setAttribute("style", r), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e;
    }
    const t = ++this.#wt;
    this.#c = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#bt = !0, i = new Worker(this.#gt, { type: "module" });
    } catch (r) {
      this.#Xe(
        r instanceof Error ? r.message : String(r)
      );
      return;
    }
    this.#o = i, i.onmessage = (r) => {
      t === this.#wt && this.#pi(r.data);
    }, i.onerror = (r) => {
      t === this.#wt && (r.preventDefault(), this.#Xe(r.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#$t(),
        scan: this.#d,
        videoTimeline: this.#fe,
        enabled: this.#E,
        video: this.#St()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #pi(e) {
    switch (e.type) {
      case "ready":
        this.#c = "active", this.#E && (this.#ze(), this.#Nt());
        break;
      case "failed":
        this.#Xe(e.message);
        break;
      case "consumed": {
        this.#Le = !1, this.#je = !0;
        const t = this.#de;
        this.#de = null, t && this.#qt(t);
        break;
      }
      case "visibility":
        this.#i.style.visibility = e.visible ? "visible" : "hidden";
        break;
      case "stats": {
        const t = {
          ...e.stats,
          dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0
        }, i = t.filmError ?? null, s = this.#yt;
        if (this.#tt = i, this.#yt = e.filmFailure, i !== null && e.filmFailure !== s) {
          this.dispatchEvent(
            new CustomEvent("failure", { detail: i })
          );
          try {
            this.#Tt?.(i);
          } catch {
          }
        }
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#xt?.(t);
        break;
      }
      case "capture": {
        const t = this.#Pe.get(e.id);
        if (this.#Pe.delete(e.id), !t) {
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
    if (this.dispatchEvent(new CustomEvent("failure", { detail: e })), !this.#v)
      try {
        this.#Tt?.(e);
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
  #Ge(e) {
    this.#z !== e && (this.#z = e, this.#K = !1, this.#M = k, this.#W(), this.#et = 0, this.#s?.destroy(), this.#s = null, this.#_t(e));
  }
  /**
   * Re-arm film reconstruction at a resource-reallocation point (start, scan
   * change, resize, or re-setting the option). The next frame retries; a
   * repeated failure degrades again and notifies as a new episode.
   */
  #J() {
    if (this.#k) return !1;
    if (this.#o) return !0;
    const e = this.#j;
    if (this.#z = null, this.#et = 0, this.#a)
      try {
        this.#ti(), this.#w > 0 && this.#ki();
      } catch (t) {
        this.#Ge(
          `autoFilm programs unavailable: ${t instanceof Error ? t.message : String(t)}`
        );
      }
    return !this.#k && e === this.#j;
  }
  /** 一時的な Worker 障害を1回だけ復旧し、再失敗時は media element 自体を表示する。 */
  #Xe(e) {
    if (this.#c === "starting" && this.#q === "auto" && !this.#Ce) {
      this.#st();
      return;
    }
    if (this.#jt(e), !this.#Ce) {
      this.#Ce = !0, this.#Zt();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#c = "failed", this.#o?.terminate(), this.#o = null, this.#ee(), this.#_t(`deinterlacer worker stopped: ${e}`), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #st() {
    const e = this.#r;
    e.className = this.#i.className;
    const t = this.#i.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e, this.#bt = !1, this.#o?.terminate(), this.#o = null, this.#c = "main", this.#ee(), this.#E && (this.#ze(), this.#Nt(), (this.#d?.interlaced ?? !0) && this.#be());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #ee() {
    this.#de?.frame.close(), this.#de = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #jt(e) {
    for (const t of this.#Pe.values())
      t.reject(new Error(e));
    this.#Pe.clear();
  }
  start() {
    if (!(this.#E || this.#k || this.#X) && (this.#j++, this.#E = !0, this.#ai(), this.#P(), !!this.#J())) {
      if (this.#Ve = performance.now(), this.#vt = this.#Ve, this.#$e = Number.NaN, this.#ue = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#Ui(), this.#Nt(), this.#mi()) {
        this.#o?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#c === "active" && this.#ze();
        return;
      }
      this.#ze(), (this.#d?.interlaced ?? !0) && this.#be();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#j++, this.#E && (this.#E = !1, this.#l.cancel(), this.#_i(), this.#Bt(), this.#m = 0, this.#y = null, this.#V(!1), this.#ee(), this.#o?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#k) {
      this.#k = !0, this.#Qe = !1, this.stop(), this.#o?.postMessage({ type: "destroy" }), this.#o?.terminate(), this.#o = null, this.#ee(), this.#jt("the deinterlacer was destroyed"), this.#ye?.removeEventListener(
        "visibilitychange",
        this.#Ut
      ), this.#ye = null, this.#r.removeEventListener(
        "webglcontextlost",
        this.#li
      ), this.#l.destroy(), this.#e.removeEventListener("emptied", this.#hi), this.#e.removeEventListener("resize", this.#Ai), this.#e.removeEventListener("pause", this.#ie), this.#e.removeEventListener("ended", this.#ie), this.#e.removeEventListener("seeking", this.#ci), this.#e.removeEventListener("seeked", this.#ie), this.#e.removeEventListener("ratechange", this.#ie), this.#Ni();
      for (const e of this.#C) this.#t.deleteTexture(e);
      this.#C = [], this.#We(), this.#Xt();
      for (const e of [
        ...this.#Ke,
        ...this.#Ee.map(({ q: t }) => t)
      ])
        this.#t.deleteQuery(e);
      this.#Ke.length = 0, this.#Ee.length = 0, this.#s?.destroy(), this.#s = null, this.#ge !== null && (Ie(this.#ge), this.#ge = null), this.#t.deleteProgram(this.#x), this.#t.deleteProgram(this.#u), this.#f && this.#t.deleteProgram(this.#f), this.#_ && this.#t.deleteProgram(this.#_), this.#F && this.#t.deleteProgram(this.#F), this.#t.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#c === "active" && this.#i.style.visibility === "visible" && this.#o) {
      const s = ++this.#fi, r = new Promise((o, h) => {
        this.#Pe.set(s, { resolve: o, reject: h });
      });
      return this.#o.postMessage({
        type: "capture",
        id: s,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), r;
    }
    if (this.#c === "starting" || this.#c === "failed")
      return createImageBitmap(this.#e);
    const e = this.#y;
    if (this.#v && (!this.#E || this.#X || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#E || this.#X || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#Gt(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#Ae(e.flush, e.second, null, !1) : this.#Lt(null, !1);
    const t = this.#e.videoWidth, i = this.#e.videoHeight;
    return t > 0 && i > 0 && (t !== this.#r.width || i !== this.#r.height) ? createImageBitmap(this.#r, {
      resizeWidth: t,
      resizeHeight: i,
      resizeQuality: "high"
    }) : createImageBitmap(this.#r);
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #ze() {
    this.#v || !this.#E || this.#l.request(this.#bi);
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #St() {
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
  #Ei(e, t) {
    let i;
    try {
      i = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (r) {
      const o = r instanceof Error ? r.message : String(r);
      this.#q === "auto" && !this.#je && !this.#Ce ? (this.#st(), this.#rt(e, t)) : this.#Xe(o);
      return;
    }
    const s = {
      id: ++this.#ui,
      frame: i,
      now: e,
      metadata: t,
      video: this.#St()
    };
    if (this.#Le) {
      this.#de?.frame.close(), this.#de = s;
      return;
    }
    this.#qt(s);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #qt(e) {
    const t = this.#o;
    if (!t || this.#c !== "active") {
      e.frame.close();
      return;
    }
    this.#Le = !0;
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
      this.#Le = !1, e.frame.close();
      const r = s instanceof Error ? s.message : String(s);
      this.#q === "auto" && !this.#je && !this.#Ce ? (this.#st(), this.#rt(e.now, e.metadata)) : this.#Xe(r);
    }
  }
  #vi(e, t, i) {
    this.#ge == null && (this.#ge = Pe(this.#t, "20px monospace")), ke(this.#ge, e, t, i, this.#w, this.#S, 20);
  }
  #Kt(e) {
    if (this.#pe == null || this.#Ee.length > 30)
      return;
    const t = this.#Ke.pop() ?? this.#t.createQuery();
    return this.#t.beginQuery(this.#pe.TIME_ELAPSED_EXT, t), this.#Ee.push({ q: t, isField: e }), t;
  }
  #He(e) {
    this.#pe != null && (e != null && this.#t.endQuery(this.#pe.TIME_ELAPSED_EXT), this.#Ee = this.#Ee.filter(
      ({ q: t, isField: i }) => {
        if (this.#t.getQueryParameter(t, this.#t.QUERY_RESULT_AVAILABLE)) {
          const s = this.#t.getQueryParameter(t, this.#t.QUERY_RESULT);
          return i ? (this.#Ne += s, this.#xe++) : (this.#Ue += s, this.#ve++), this.#Ke.push(t), !1;
        }
        return !0;
      }
    ));
  }
  #W() {
    this.#M = k, this.#Oe = k, this.#Te = 0, this.#K = !1, this.#s?.reset();
  }
  /** Detect the pulldown phase of the frame being filtered on the GPU. */
  #xi() {
    const { cur: e, next: t } = this.#ni(!1), i = this.#C[e], s = this.#C[t];
    if (!i || !s) return;
    const r = this.#d?.topFieldFirst !== !1 ? 0 : 1;
    this.#s?.detect(i, s, r);
  }
  /**
   * Read back the previous frame's phase if it has arrived, and advance it
   * to the frame being filtered. The run is not advanced: only the GPU
   * counts observed frames.
   */
  #Ti() {
    const e = this.#s?.poll() ?? null;
    e !== null && (this.#Oe = e, this.#Te = 0), this.#Te++;
    const { phase: t, run: i } = this.#Oe;
    t === 0 || this.#Te > ne ? this.#M = k : this.#M = {
      phase: (t - 1 + this.#Te) % ne + 1,
      run: i
    };
  }
  #gi(e) {
    const t = [], i = this.#s?.metrics ?? new Float32Array(0);
    for (let r = 0; r < T.phase; r++) {
      const o = i[r * 4] ?? 0, h = i[r * 4 + 1] ?? 0, a = i[r * 4 + 2] ?? 0;
      t.push(
        `${o.toFixed(3)},${h.toString().padStart(4)},${a.toFixed(3)}`
      );
    }
    const s = this.#Je.map((r, o) => `${o === 0 ? "-" : o}:${r}`).join(" ");
    return `frame=${e} phase=${this.#M.phase} run=${this.#M.run} known=${this.#Oe.phase}/${this.#Oe.run} age=${this.#Te} ${this.#K ? "film" : "video"} period=${this.#h.toFixed(3)}
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
  #Ct(e, t) {
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
    const s = this.#Ct(i, e.timeOrigin), r = lt * Math.max(this.#O, this.#h);
    return s < t - r || s > t + r ? t : s;
  }
  #bi = (e, t) => {
    if (!this.#E || this.#X) return;
    this.#kt();
    const i = this.#Ct(e, t.timeOrigin);
    this.#Ve = i, this.#ue = Math.max(
      this.#ue,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#Jt(i, t), this.#ze();
  };
  /**
   * どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。
   * `now` はこの realm の時計で測った取込み時刻。
   */
  #Jt(e, t) {
    if (this.#$e = t.mediaTime, this.#c === "active") {
      this.#Ei(e, t);
      return;
    }
    this.#c !== "starting" && this.#rt(e, t);
  }
  /**
   * @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。
   * `now` はこの Worker の時計で測った取込み時刻を渡す。metadata の表示予定
   * 時刻はページ側の時計のままでよく、同梱の timeOrigin から変換する。
   */
  ingestExternalFrame(e, t, i) {
    this.#Ze = i;
    try {
      this.#rt(e, t);
    } finally {
      this.#Ze = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #rt(e, t) {
    const i = this.#j;
    if (this.#te(i) && (this.#Fi(t.mediaTime), !!this.#te(i) && t.width > 0 && t.height > 0)) {
      let s = !1;
      if (!this.#Se && this.#e.seeking) {
        const f = this.#e.buffered, m = this.#h >= re ? this.#h / 1e3 : V / 1e3;
        for (let b = 0; b < f.length; b++)
          if (t.mediaTime >= f.start(b) && t.mediaTime < f.end(b) && Math.abs(t.mediaTime - this.#e.currentTime) <= m) {
            s = !0;
            break;
          }
      }
      if (s && (this.#Se = !0), (this.#w === 0 || this.#S === 0) && this.#oi(t.width, t.height), !this.#te(i)) return;
      if (this.#d && !this.#d.interlaced) {
        this.#Pi();
        return;
      }
      const r = t.mediaTime - this.#_e, o = t.mozTiming, h = s || (o ? o.discontinuity || r < 0 || r > de : r < 0 || r > de);
      h && (this.#m = 0, this.#h = 0, this.#R.discontinuities++, this.#I(), this.#P(), this.#W());
      const a = this.#a && this.#ne !== 0 && t.presentedFrames - this.#ne > 1, c = this.#Bi(t.presentedFrames, h);
      if (!h && a && (this.#m = 0, this.#P()), this.#m > 0 && t.mediaTime === this.#_e && (!o || t.presentedFrames === this.#Et))
        return;
      if (!h) {
        const f = o?.periodMs ?? 0;
        f > 0 ? this.#ei(f * (this.#e.playbackRate || 1) / 1e3) : r > 0 && this.#ei(r);
      }
      this.#_e = t.mediaTime, this.#Et = t.presentedFrames;
      const A = performance.now();
      A - this.#Ft > me && (this.#qe = A, this.#oe = 0, this.#Be = 0, this.#Ie = 0, this.#ke = 0, this.#me = 0, this.#re = 0, this.#Ue = 0, this.#ve = 0, this.#Ne = 0, this.#xe = 0), this.#Ft = A;
      const d = performance.now(), u = this.#Kt(!1);
      this.#ri();
      const l = this.#Z, p = this.#a && !this.#z && this.#m === F ? this.#Di() : !1;
      if (p === "unavailable" ? ++this.#et >= dt && this.#Ge(
        "autoFilm analysis unavailable: the GPU analysis target or programs would not allocate"
      ) : this.#et = 0, !this.#te(i)) {
        this.#k || this.#He(u);
        return;
      }
      const v = p === !0;
      l !== this.#Z && this.#I();
      const E = v && this.#we();
      if (this.#D && !this.#a && !this.#z && !this.#s)
        try {
          this.#Qt();
        } catch (f) {
          this.#Ge(
            `film detector unavailable: ${f instanceof Error ? f.message : String(f)}`
          );
        }
      if (!this.#te(i)) {
        this.#k || this.#He(u);
        return;
      }
      if (this.#D && !this.#a && !this.#z) {
        if (this.#m === F && c === 0)
          try {
            this.#Ti(), this.#xi();
          } catch (f) {
            this.#Ge(
              `film detection failed: ${f instanceof Error ? f.message : String(f)}`
            );
          }
        else
          this.#W();
        this.#Je[this.#M.phase] = (this.#Je[this.#M.phase] ?? 0) + 1, this.#K = this.#M.phase !== 0 && this.#M.run >= Fe, this.#$ && (this.#Yt = this.#gi(t.presentedFrames));
      }
      if (!this.#te(i)) {
        this.#k || this.#He(u);
        return;
      }
      const w = this.#wi(t, e) + this.#O;
      if (E)
        this.#se++;
      else if (this.#a && !this.#z && !this.#ft && this.#Z === "film")
        if (this.#we()) {
          const f = this.#h * 5 / 4, b = this.#At(1, e, f) || this.#Q === null ? w + f : w;
          this.#yi(this.#ot("film", b, f), f);
        } else
          this.#Lt(null);
      else if (this.#K && !this.#a)
        if (this.#we()) {
          const f = this.#M.phase;
          if (f === Ae)
            this.#Dt++, this.#se++;
          else {
            const m = this.#h * ne / ut, b = this.#At(1, e, m), R = ft[f] ?? 0, L = b || this.#Q === null ? w + m : w + R * this.#h;
            this.#nt(
              "film",
              !1,
              this.#ot("film", L, m),
              m
            );
          }
        } else
          this.#Ae(!1, !1, null);
      else if (this.#G && this.#we()) {
        const f = this.#h / 2, b = this.#At(2, e, f) || this.#Q === null ? w + f * 2 : w, R = this.#ot("field", b, f);
        this.#nt("field", !1, R, f), this.#nt("field", !0, R + f, f);
      } else if (this.#we()) {
        const f = this.#h, b = this.#At(1, e, f) || this.#Q === null ? w + f : w;
        this.#nt(
          "frame",
          !1,
          this.#ot("frame", b, f),
          f
        ) || (this.#R.late++, this.#Ae(!1, !1, null));
      } else
        this.#R.late += this.#A.length, this.#I(), this.#Ae(!1, !1, null);
      this.#me = Math.max(
        this.#me,
        this.#A.length
      ), this.#He(u), this.#Be += performance.now() - d, this.#oe++, this.#Ii(A);
    }
  }
  #te(e) {
    return !this.#k && this.#E && e === this.#j;
  }
  #Fi(e) {
    const t = this.#j;
    let i;
    for (let o = this.#fe.length - 1; o >= 0; o--) {
      const h = this.#fe[o];
      if (h.start <= e + 1e-6) {
        i = h;
        break;
      }
    }
    if (i?.codedSize && (i.codedSize.width !== this.#w || i.codedSize.height !== this.#S) && this.#oi(i.codedSize.width, i.codedSize.height), !this.#te(t)) return;
    const s = i?.scan;
    if (!s || this.#d?.interlaced === s.interlaced && this.#d.topFieldFirst === s.topFieldFirst)
      return;
    const r = this.#d?.interlaced;
    this.#d = s, this.#m = 0, this.#I(), this.#P(), this.#J() && (r !== s.interlaced && (this.#h = 0), s.interlaced && (this.#v || this.#c === "main") ? this.#be() : this.#Bt(), this.#W());
  }
  /**
   * Whether pictures are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #we() {
    return (this.#G || this.#a || this.#D) && this.#h > 0 && this.#L.length === U;
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
  #ei(e) {
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#h > 0 ? Math.max(1, Math.round(t / this.#h)) : 1, s = t / i;
    s < re || s > V || (this.#h = this.#h > 0 && s > this.#h * At ? this.#h + (s - this.#h) * it : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #ti() {
    if (this.#f && this.#_ && this.#F) return;
    const e = this.#t, t = [];
    let i, s, r;
    try {
      i = H(e, Ve), t.push(i), s = H(e, Qe), t.push(s), r = H(e, Ze), t.push(r);
    } catch (o) {
      for (const h of t) e.deleteProgram(h);
      throw o;
    }
    this.#f = i, this.#g = Object.fromEntries(
      Object.entries(ie).filter(([o]) => o !== "match" && o !== "topFieldFirst").map(([o, h]) => [o, e.getUniformLocation(i, h)])
    ), this.#_ = s, this.#B = Object.fromEntries(
      Object.entries(ie).map(([o, h]) => [
        o,
        e.getUniformLocation(s, h)
      ])
    ), this.#F = r, this.#he = Object.fromEntries(
      Object.entries(ie).map(([o, h]) => [
        o,
        e.getUniformLocation(r, h)
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
  #Di() {
    const e = this.#Y, t = this.#f, i = this.#g, s = this.#F, r = this.#he;
    if (!e || !t || !i || !s || !r)
      return "unavailable";
    const o = this.#t, h = this.#b, a = (this.#b + F - 1) % F, c = (this.#b + F - 2) % F, A = this.#it;
    o.bindFramebuffer(o.FRAMEBUFFER, e.framebuffer), o.useProgram(t);
    for (const [E, g] of [c, a, h].entries())
      o.activeTexture(o.TEXTURE0 + E), o.bindTexture(o.TEXTURE_2D, this.#C[g] ?? null);
    o.uniform1i(i.prev, 0), o.uniform1i(i.cur, 1), o.uniform1i(i.next, 2), o.uniform2i(i.size, this.#w, this.#S), o.viewport(0, 0, _, S), o.drawArrays(o.TRIANGLES, 0, 3), o.readPixels(
      0,
      0,
      _,
      S,
      o.RGBA,
      o.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: d, currentLuma: u, nextLuma: l } = e;
    for (let E = 0; E < d.length; E++) {
      const g = E * 4;
      d[E] = e.pixels[g] ?? 0, u[E] = e.pixels[g + 1] ?? 0, l[E] = e.pixels[g + 2] ?? 0;
    }
    const p = this.#dt.fieldMatch(
      d,
      u,
      l,
      A,
      this.#ce
    );
    o.useProgram(s), o.uniform1i(r.prev, 0), o.uniform1i(r.cur, 1), o.uniform1i(r.next, 2), o.uniform2i(r.size, this.#w, this.#S), o.uniform1i(r.topFieldFirst, A ? 1 : 0), o.uniform1i(
      r.match,
      p.match === "p" ? 0 : p.match === "c" ? 1 : 2
    ), o.drawArrays(o.TRIANGLES, 0, 3), o.readPixels(
      0,
      0,
      _,
      S,
      o.RGBA,
      o.UNSIGNED_BYTE,
      e.pixels
    );
    const v = this.#dt.decimate(e.pixels);
    this.#Me = p.match, this.#ut = p.combScore, this.#ft = p.isCombed, this.#mt = v.lowestCycleDifference, this.#pt = v.runnerUpCycleDifference;
    const x = v.dropIndex !== null && !p.isCombed;
    return (x ? "film" : "video") !== this.#Z && (this.#Z = x ? "film" : "video"), v.shouldDrop && !p.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #yi(e, t) {
    const i = this.#Pt();
    if (i === null) return;
    const s = this.#L[i];
    if (!s) return;
    for (this.#De = i; this.#A.length > 0 && this.#A[0]?.slot === i; )
      this.#A.shift(), this.#R.late++;
    this.#Lt(s.framebuffer);
    const r = {
      slot: i,
      at: e,
      duration: t,
      cadence: "film",
      phase: 0,
      droppedBefore: this.#se
    };
    this.#se = 0, this.#A.push(r), this.#Q = r;
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Lt(e, t = !0) {
    const i = this.#_, s = this.#B;
    if (!i || !s) return;
    const r = this.#t, o = this.#b, h = (this.#b + F - 1) % F, a = (this.#b + F - 2) % F, c = this.#it;
    r.bindFramebuffer(r.FRAMEBUFFER, e), r.useProgram(i);
    for (const [A, d] of [a, h, o].entries())
      r.activeTexture(r.TEXTURE0 + A), r.bindTexture(r.TEXTURE_2D, this.#C[d] ?? null);
    r.uniform1i(s.prev, 0), r.uniform1i(s.cur, 1), r.uniform1i(s.next, 2), r.uniform2i(s.size, this.#w, this.#S), r.uniform1i(s.topFieldFirst, c ? 1 : 0), r.uniform1i(
      s.match,
      this.#Me === "p" ? 0 : this.#Me === "c" ? 1 : 2
    ), r.viewport(0, 0, this.#w, this.#S), r.drawArrays(r.TRIANGLES, 0, 3), e === null && (this.#y = { kind: "film" }, this.#V(!0), t && this.#re++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #nt(e, t, i, s) {
    const r = this.#Pt();
    if (r === null) return !1;
    const o = this.#L[r];
    if (!o) return !1;
    for (this.#De = r; this.#A.length > 0 && this.#A[0]?.slot === r; )
      this.#A.shift(), this.#R.late++;
    this.#Ae(!1, t, o.framebuffer);
    const h = {
      slot: r,
      at: i,
      duration: s,
      cadence: e,
      phase: e === "film" ? this.#M.phase : e === "field" ? t ? 2 : 1 : 0,
      droppedBefore: this.#se
    };
    return this.#se = 0, this.#A.push(h), this.#Q = h, !0;
  }
  /**
   * When a picture goes up: one duration after the last one of its cadence,
   * nudged towards `ideal` by a fraction of the gap so that the schedule
   * follows the clock without a picture ever moving across a refresh. It
   * restarts from `ideal` when the gap has grown to a whole picture or the
   * cadence has changed. (otya)
   */
  #ot(e, t, i) {
    if (!(i > 0)) return t;
    const s = this.#Q;
    if (s !== null && s.cadence === e) {
      const r = s.at + s.duration, o = t - r;
      if (Math.abs(o) < i) {
        const h = Math.max(
          -Ee,
          Math.min(Ee, o * ht)
        );
        return r + h;
      }
    }
    s !== null && this.#R.resynced++;
    for (let r = this.#A.at(-1); r && r.at >= t; )
      this.#A.pop(), this.#R.late++, r = this.#A.at(-1);
    return t;
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #At(e, t, i) {
    const s = this.#A.at(-1), r = (he + 1) * Math.max(this.#O, i);
    if (s && s.at - t > r)
      return this.#I(), this.#R.queueResetted++, !0;
    const o = Math.max(
      0,
      this.#A.length + e - he
    );
    let h = 0, a = 0;
    for (; a < o; ) {
      const c = this.#A.shift();
      if (!c) break;
      h += c.duration, a++;
    }
    for (const c of this.#A) c.at -= h;
    return this.#R.late += a, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Pt() {
    const e = this.#y?.kind === "texture" ? this.#y.texture : null, t = new Set(this.#A.map(({ slot: s }) => s));
    for (let s = 1; s <= U; s++) {
      const r = (this.#De + s) % U, o = this.#L[r];
      if (o && o.texture !== e && !t.has(r))
        return r;
    }
    const i = this.#A[0];
    if (i) {
      const s = this.#L[i.slot];
      if (s && s.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #be() {
    this.#U === null && (!this.#E || this.#X || (this.#Ye = 0, this.#U = this.#Fe(this.#It)));
  }
  #Bt() {
    this.#ht(this.#U), this.#U = null, this.#I();
  }
  #It = (e) => {
    this.#U = null, !(!this.#E || this.#X) && (this.#Ri(e), this.#c === "main" && this.#Ci(this.#Re, e), this.#U = this.#Fe(this.#It));
  };
  /**
   * Fit a grid of refreshes (period and phase) to the animation frames. rAF
   * timestamps wander by a millisecond or so, which is more than the
   * nearest-refresh decision in #present can take; the grid is what it
   * compares against. A frame far off the grid restarts it. (otya)
   */
  #Ri(e) {
    const t = e - this.#Ye;
    this.#Ye = e;
    const i = Math.max(1, Math.round(t / this.#O)), s = this.#Re + i * this.#O, r = e - s;
    if (this.#Re === 0 || t <= 0 || t > V || Math.abs(r) > this.#O / 4) {
      t > 0 && t <= V && (this.#O = t), this.#Re = e;
      return;
    }
    this.#O += r / i * at, this.#Re = s + r * ct;
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
    const e = this.#v;
    if (e)
      return { frames: e, origin: performance.timeOrigin };
    const t = this.#i.ownerDocument?.defaultView ?? this.#e.ownerDocument?.defaultView ?? null;
    return t === null ? { frames: pt, origin: performance.timeOrigin } : { frames: t, origin: t.performance.timeOrigin };
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
  #Fe(e) {
    const { frames: t, origin: i } = this.#ii(), s = t.requestAnimationFrame(
      (r) => e(this.#Ct(r, i))
    );
    return { frames: t, handle: s };
  }
  /** 予約した表示機会を、それを発行した window 自身で取り消す。 */
  #ht(e) {
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
  #kt() {
    if (this.#v) return;
    this.#Mi();
    const { frames: e } = this.#ii(), t = this.#U !== null && this.#U.frames !== e, i = this.#N !== null && this.#N.frames !== e;
    !t && !i || (this.#Ye = 0, t && (this.#ht(this.#U), this.#U = this.#Fe(this.#It)), i && (this.#ht(this.#N), this.#N = this.#Fe(this.#Ot)));
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
    const e = this.#v ? null : this.#i.ownerDocument ?? null;
    e !== this.#ye && (this.#ye?.removeEventListener(
      "visibilitychange",
      this.#Ut
    ), this.#ye = e, e?.addEventListener("visibilitychange", this.#Ut));
  }
  #Ut = () => {
    this.#k || this.#kt();
  };
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #Nt() {
    this.#v || this.#N !== null || !this.#E || this.#X || (this.#N = this.#Fe(this.#Ot));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #_i() {
    this.#ht(this.#N), this.#N = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #Ot = (e) => {
    if (this.#N = null, !this.#E || this.#X) return;
    const t = this.#j;
    this.#Si(e), this.#te(t) && (this.#N = this.#Fe(this.#Ot));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #Si(e) {
    if (this.#v || this.#l.mozDriven && this.#l.hasDelivered || e - this.#Ve < rt || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#h >= re ? this.#h : nt, r = i > this.#ue, o = t !== this.#$e && e - this.#vt >= s * 0.75;
    !r && !o || (this.#ue = Math.max(
      this.#ue,
      i
    ), this.#vt = e, this.#Jt(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#ne + 1, i),
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
    const i = this.#O / 2, s = (a) => {
      const c = a.at - e;
      return c <= i - ve ? !0 : c > i + ve ? !1 : this.#Wt > 0;
    };
    for (; this.#A[1] && s(this.#A[1]); )
      this.#R.late++, this.#A.shift();
    const r = this.#A[0];
    if (!r || !s(r)) return;
    this.#A.shift(), this.#Wt = r.at - e;
    const o = performance.now(), h = this.#Kt(!0);
    this.#si(r.slot), this.#He(h), this.#ke += performance.now() - o, this.#Ie++, this.#$ && this.#Li(r, t), this.#ct = t;
  }
  /** Preserve upstream's opt-in presentation timing log in either renderer. */
  #Li(e, t) {
    const i = this.#ct === 0 ? 0 : t - this.#ct, s = i / this.#O, r = e.cadence === "film" ? e.phase === 0 ? "CPU film" : `phase ${e.phase}` : e.cadence === "field" ? `field ${e.phase}` : "frame", o = e.phase === 0 ? "duplicate" : `phase ${Ae}`, h = e.droppedBefore > 0 ? `, ${o} dropped before it` + (e.droppedBefore > 1 ? ` (${e.droppedBefore})` : "") : "";
    console.log(
      `yadif: +${i.toFixed(2)} ms (${s.toFixed(2)} refreshes) ${e.cadence} ${r}, due ${(e.at - t).toFixed(2)} ms${h}`
    );
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #si(e) {
    const t = this.#L[e];
    t && this.#Gt(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Pi() {
    this.#ri();
    const e = this.#C[this.#b];
    e && this.#Gt(e, !0), this.#m = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #V(e) {
    if (this.#v) {
      this.#v.onVisibility(e);
      return;
    }
    this.#i.style.visibility = e ? "visible" : "hidden";
  }
  #Gt(e, t = !1, i = !0) {
    const s = this.#t;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#u), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#T, 0), s.uniform1i(this.#p, t ? 1 : 0), s.viewport(0, 0, this.#w, this.#S), s.drawArrays(s.TRIANGLES, 0, 3), this.#y = { kind: "texture", texture: e, flip: t }, this.#V(!0), i && this.#re++;
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
    return this.#ne !== 0 && !t && (i = Math.max(0, e - this.#ne - 1), this.#R.missed += i), this.#ne = e, i;
  }
  #Ii(e) {
    const t = e - this.#qe;
    if (t < me) return;
    const i = this.#we() && (this.#G || this.#Z === "film" || this.#K) ? this.#Ie : this.#oe, s = this.#oe ? (this.#Be + this.#ke) / this.#oe : 0;
    let r;
    this.#pe != null && (r = 0, this.#ve !== 0 && (r += this.#Ue / 1e6 / this.#ve), this.#xe !== 0 && (r += this.#Ne / 1e6 / this.#xe / 2));
    const o = {
      ...this.#R,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: s,
      maxQueuedFields: this.#me,
      mode: this.#Z,
      match: this.#Me,
      combScore: this.#ut,
      outputFps: this.#re * 1e3 / t,
      duplicateScore: this.#mt,
      duplicateRunnerUp: this.#pt,
      gpuMs: r,
      film: this.#K,
      filmError: this.#z
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: o })), this.#xt?.(o), this.#qe = e, this.#oe = 0, this.#Be = 0, this.#Ie = 0, this.#ke = 0, this.#me = 0, this.#re = 0, this.#Ue = 0, this.#ve = 0, this.#Ne = 0, this.#xe = 0;
  }
  /** Take the newest frame into the ring. */
  #ri() {
    const e = this.#t;
    this.#b = (this.#b + 1) % F, e.bindTexture(e.TEXTURE_2D, this.#C[this.#b] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#Ze
    ), this.#m = Math.min(this.#m + 1, F);
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
  #Ae(e, t, i, s = !0) {
    if (this.#m === 0 || this.#X) return;
    s && (this.#m === F && !e ? this.#R.filtered++ : this.#R.degraded++);
    const r = this.#t, { prev: o, cur: h, next: a } = this.#ni(e);
    r.bindFramebuffer(r.FRAMEBUFFER, i), r.useProgram(this.#x);
    for (const [u, l] of [o, h, a].entries())
      r.activeTexture(r.TEXTURE0 + u), r.bindTexture(r.TEXTURE_2D, this.#C[l] ?? null);
    r.uniform1i(this.#n.prev, 0), r.uniform1i(this.#n.cur, 1), r.uniform1i(this.#n.next, 2);
    const c = this.#D && !this.#a ? this.#s?.texture ?? null : null, A = c !== null;
    c !== null && (r.activeTexture(r.TEXTURE0 + 3), r.bindTexture(r.TEXTURE_2D, c), r.uniform1i(this.#n.fieldMetrics, 3)), r.uniform2i(this.#n.size, this.#w, this.#S);
    const d = this.#it ? 0 : 1;
    r.uniform1i(this.#n.parity, t ? 1 - d : d), r.uniform1i(this.#n.tff, this.#it ? 1 : 0), r.uniform1i(this.#n.second, t ? 1 : 0), r.uniform1i(this.#n.spatialCheck, this.#le ? 1 : 0), r.uniform1i(this.#n.debug, this.#$ ? 1 : 0), r.uniform1i(this.#n.film, A ? 1 : 0), r.uniform1i(this.#n.phase, this.#M.phase), r.viewport(0, 0, this.#w, this.#S), r.drawArrays(r.TRIANGLES, 0, 3), this.#$ && A && this.#vi(this.#Yt, 0, 90), i === null && (this.#y = { kind: "yadif", flush: e, second: t }, this.#V(!0), s && this.#re++);
  }
  #ni(e) {
    const t = (i) => (this.#b + F - i) % F;
    return this.#m === 1 ? { prev: this.#b, cur: this.#b, next: this.#b } : e ? { prev: t(1), cur: this.#b, next: this.#b } : this.#m === 2 ? { prev: t(1), cur: t(1), next: this.#b } : { prev: t(2), cur: t(1), next: this.#b };
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
  #at() {
    if (this.#kt(), !this.#ae) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const s = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), r = t * s, o = i * s;
    this.#i.style.left = `${e.offsetLeft + (e.offsetWidth - r) / 2}px`, this.#i.style.top = `${e.offsetTop + (e.offsetHeight - o) / 2}px`, this.#i.style.width = `${r}px`, this.#i.style.height = `${o}px`;
  }
  #oi(e, t) {
    const i = this.#t;
    this.#r.width = e, this.#r.height = t, this.#w = e, this.#S = t, this.#m = 0, this.#y = null, this.#P(), this.#at();
    for (const s of this.#C) i.deleteTexture(s);
    this.#C = [];
    for (let s = 0; s < F; s++) {
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
      ), this.#C.push(r);
    }
    this.#We(), this.#Xt(), (this.#G || this.#a || this.#D) && this.#zt(), this.#s?.resize(e, t), this.#J();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #ki() {
    if (this.#Y) return;
    const e = this.#t, t = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      _,
      S,
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
    this.#Y = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(_ * S * 4),
      previousLuma: new Uint8Array(_ * S),
      currentLuma: new Uint8Array(_ * S),
      nextLuma: new Uint8Array(_ * S)
    };
  }
  #Xt() {
    this.#Y && (this.#t.deleteFramebuffer(this.#Y.framebuffer), this.#t.deleteTexture(this.#Y.texture), this.#Y = null);
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
  #zt() {
    const e = this.#t;
    if (!(this.#L.length === U || this.#w === 0)) {
      this.#We();
      for (let t = 0; t < U; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#w,
          this.#S,
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
          e.deleteFramebuffer(s), e.deleteTexture(i), this.#We();
          return;
        }
        this.#L.push({ texture: i, framebuffer: s });
      }
      this.#De = U - 1;
    }
  }
  #We() {
    const e = this.#t, t = this.#y?.kind === "texture" ? this.#y.texture : null;
    this.#L.some((i) => i.texture === t) && (this.#y = null);
    for (const { texture: i, framebuffer: s } of this.#L)
      e.deleteFramebuffer(s), e.deleteTexture(i);
    this.#L = [], this.#I();
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #Ui() {
    if (this.#ae) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#ae = t, this.#lt?.observe(this.#e), this.#at();
  }
  #Ni() {
    if (this.#v) return;
    const e = this.#ae;
    this.#ae = null, this.#lt?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #Ai = () => this.#at();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #Ht(e) {
    return !this.#o || this.#c === "main" ? !1 : (this.#o.postMessage({
      type: "event",
      name: e,
      video: this.#St()
    }), !0);
  }
  #hi = () => {
    if (this.#$e = Number.NaN, this.#Ht("emptied")) {
      this.#ee(), this.#V(!1);
      return;
    }
    this.#m = 0, this.#_e = 0, this.#Et = 0, this.#I(), this.#W(), this.#h = 0, this.#ai(), this.#P(), this.#y = null, this.#V(!1);
  };
  #ai() {
    this.#R = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      resynced: 0,
      late: 0,
      queueResetted: 0
    }, this.#Je.fill(0), this.#Dt = 0, this.#ne = 0, this.#qe = 0, this.#Ft = 0, this.#oe = 0, this.#Be = 0, this.#Ie = 0, this.#ke = 0, this.#me = 0, this.#re = 0, this.#P(), this.#Ue = 0, this.#ve = 0, this.#Ne = 0, this.#xe = 0;
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #P() {
    this.#I(), this.#Z = "video", this.#Me = "c", this.#ut = 0, this.#ft = !0, this.#dt.reset(), this.#mt = 1 / 0, this.#pt = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #ci = () => {
    if (this.#Ht("seeking")) {
      this.#ee();
      return;
    }
    this.#Se = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #ie = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#Ht(e.type)) {
      this.#ee();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#Se;
      if (this.#Se = !1, i) return;
      this.#m = 0, this.#P(), this.#W(), this.#y = null, this.#V(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#h = 0, this.#_e = this.#e.currentTime), this.#I(), this.#E && this.#m > 0) {
      const i = this.#Pt(), s = i === null ? void 0 : this.#L[i];
      i !== null && s ? (this.#De = i, this.#Ae(!0, !1, s.framebuffer), this.#si(i)) : this.#Ae(!0, !1, null);
    }
    t && (this.#m = 0, this.#P(), this.#W());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #li = (e) => {
    if (e.preventDefault(), this.#v) {
      this.#v.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#c !== "active" && (this.#X = !0, this.#_t("the deinterlacer WebGL context was lost"), this.stop());
  };
}
function H(n, e) {
  const t = n.createProgram(), i = xe(n, n.VERTEX_SHADER, ot), s = xe(n, n.FRAGMENT_SHADER, e);
  if (n.attachShader(t, i), n.attachShader(t, s), n.linkProgram(t), n.deleteShader(i), n.deleteShader(s), !n.getProgramParameter(t, n.LINK_STATUS)) {
    const r = n.getProgramInfoLog(t);
    throw n.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${r ?? "no reason given"}`
    );
  }
  return t;
}
function xe(n, e, t) {
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
const Te = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Et = 0.5, vt = 3e3, ge = 0.1, X = 16, we = 'video/mp4; codecs="avc1.640029"';
let ae = null;
function xt(n = {}) {
  return ae ??= Tt(n), ae;
}
async function Rt(n = {}) {
  return (await xt(n)).deinterlaces;
}
function Mt() {
  ae = null;
}
async function Tt(n) {
  const e = n.tolerance ?? Et, t = n.timeoutMs ?? vt, i = performance.now(), s = (h) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: h instanceof Error ? h.message : String(h)
  });
  if (typeof document > "u")
    return s(new Error("there is no document to decode in"));
  const r = document.createElement("video");
  r.muted = !0, r.defaultMuted = !0, r.playsInline = !0, r.preload = "auto";
  let o = null;
  try {
    o = wt(r, t);
    const h = q(j(r, "loadeddata"), t), a = r.play().then(
      () => !0,
      () => !1
    );
    if (await o.ready, await h, await bt(r, t, await a), r.videoWidth === 0 || r.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const c = Ft(r);
    return {
      deinterlaces: c < 1 - e,
      survives: c,
      tookMs: performance.now() - i
    };
  } catch (h) {
    return s(h);
  } finally {
    r.pause(), r.removeAttribute("src"), r.replaceChildren(), r.load(), o && URL.revokeObjectURL(o.url);
  }
}
const oe = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, gt = typeof MediaSource > "u";
function wt(n, e) {
  if (!oe || !oe.isTypeSupported(we))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = Te.indexOf(","), i = atob(Te.slice(t + 1)), s = new Uint8Array(i.length);
  for (let a = 0; a < i.length; a++) s[a] = i.charCodeAt(a);
  const r = new oe(), o = URL.createObjectURL(r);
  if (gt) {
    n.disableRemotePlayback = !0;
    const a = document.createElement("source");
    a.type = "video/mp4", a.src = o, n.append(a), n.load();
  } else
    n.src = o;
  const h = (async () => {
    await q(j(r, "sourceopen"), e);
    const a = r.addSourceBuffer(we), c = q(j(a, "updateend"), e);
    a.appendBuffer(s), await c, r.endOfStream();
  })();
  return { url: o, ready: h };
}
async function bt(n, e, t) {
  if (t) {
    const i = performance.now();
    for (; n.currentTime < ge && performance.now() - i < e; )
      await new Promise((s) => requestAnimationFrame(s));
    n.pause();
  } else
    n.currentTime = ge, await q(j(n, "seeked"), e);
}
function Ft(n) {
  const e = n.videoHeight, t = document.createElement("canvas");
  t.width = X, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(n, 0, 0, X, e);
  const s = i.getImageData(0, 0, X, e).data, r = (A) => {
    let d = 0;
    for (let u = 0; u < X; u++)
      d += s[(A * X + u) * 4 + 1] ?? 0;
    return d / X;
  };
  let o = 0;
  const h = 2, a = e - 3;
  let c = r(h);
  for (let A = h + 1; A <= a; A++) {
    const d = r(A);
    o += Math.abs(d - c), c = d;
  }
  return o / (a - h) / 255;
}
function j(n, e) {
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
function q(n, e) {
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
tt(Se);
export {
  yt as Deinterlacer,
  Ve as FILM_ANALYSIS_FRAGMENT_SHADER,
  Ze as FILM_SAMPLE_FRAGMENT_SHADER,
  ie as FILM_UNIFORMS,
  Qe as FILM_WEAVE_FRAGMENT_SHADER,
  $e as YADIF_FRAGMENT_SHADER,
  Ye as YADIF_UNIFORMS,
  Rt as decoderDeinterlaces,
  Mt as forgetDecoderProbe,
  xt as probeDecoder,
  Dt as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
