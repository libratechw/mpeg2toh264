const ae = "" + new URL("assets/worker-DNXQ_lAz.js", import.meta.url).href, he = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, ce = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uNext;
/** The size of a frame in texels. */
uniform ivec2 uSize;
/** The parity of the lines that are kept; the others are interpolated. */
uniform int uParity;
/** Whether the first field of a frame is its top field. */
uniform int uTff;
/** Whether the temporal bound is widened by the local vertical range. */
uniform bool uSpatialCheck;

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

void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  int x = at.x;
  // The framebuffer counts its rows from the bottom and a frame from the top.
  int y = uSize.y - 1 - at.y;

  vec3 rgb;
  if ((y & 1) == uParity) {
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
`, Q = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  topFieldFirst: "uTopFieldFirst",
  match: "uMatch"
}, k = 288, L = 162, le = `#version 300 es
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
  ivec2 targetSize = ivec2(${k}, ${L});
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
`, fe = `#version 300 es
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
`, ue = `#version 300 es
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
  ivec2 targetSize = ivec2(${k}, ${L});
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
  #f;
  #i;
  #e;
  #s = 0;
  #v = null;
  #n = [];
  #D = null;
  #G = 1 / 0;
  #W = 1 / 0;
  constructor(e, t) {
    this.#f = e, this.#i = t, this.#e = 255 * D.DECIMATE_BLOCK ** 2 * D.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, A, s = D.COMBED_PIXEL_LIMIT) {
    const r = globalThis.__YADIF_AUTOFILM_ANALYSIS_DIAGNOSTIC__, n = r?.enabled === !0, o = n ? performance.now() : 0, f = A ? 1 : 0, a = { p: e, c: t, n: i };
    let u = this.#k("c", "p", f, a);
    const l = n ? performance.now() : 0, h = /* @__PURE__ */ new Map();
    let p = 0, m = 0;
    const w = (x) => {
      const F = h.get(x);
      if (F !== void 0) return F;
      const b = n ? performance.now() : 0, M = this.weave(
        e,
        t,
        i,
        x,
        A
      ), R = n ? performance.now() : 0, U = D.#L(M, this.#f, this.#i), N = n ? performance.now() : 0;
      return n && (p += R - b, m += N - R), h.set(x, U), U;
    }, g = w(u), v = w("n");
    (v * 3 < g || v * 2 < g && g > s) && Math.abs(v - g) >= 30 && v < s && (u = "n");
    const y = w(u), E = y >= s;
    E && (u = "c");
    const d = n ? performance.now() : 0, _ = this.weave(e, t, i, u, A), S = n ? performance.now() : 0;
    return n && r.fieldMatchSamples.push({
      atMs: o,
      compareFieldsMs: l - o,
      scoreWeaveMs: p,
      combScoreMs: m,
      resultWeaveMs: S - d,
      totalMs: S - o
    }), {
      match: u,
      combScore: y,
      isCombed: E,
      luma: _
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = globalThis.__YADIF_AUTOFILM_ANALYSIS_DIAGNOSTIC__, i = t?.enabled === !0, A = i ? performance.now() : 0, s = this.#s, r = this.#D ? D.#fe(
      this.#D,
      e,
      this.#f,
      this.#i
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    }, n = i ? performance.now() : 0;
    this.#n.push(r);
    const o = this.#v === s, f = o && r.maxBlockDifference < this.#e;
    o && !f && (this.#v = null);
    const a = this.#v, u = i ? performance.now() : 0;
    this.#D = e.slice();
    const l = i ? performance.now() : 0;
    this.#s++;
    let h = this.#v;
    if (this.#s === D.CYCLE) {
      let m = 0, w = null;
      for (let g = 1; g < this.#n.length; g++)
        (this.#n[g]?.maxBlockDifference ?? 1 / 0) < (this.#n[m]?.maxBlockDifference ?? 1 / 0) ? (w = m, m = g) : (w === null || (this.#n[g]?.maxBlockDifference ?? 1 / 0) < (this.#n[w]?.maxBlockDifference ?? 1 / 0)) && (w = g);
      this.#G = this.#n[m]?.maxBlockDifference ?? 1 / 0, this.#W = w === null ? 1 / 0 : this.#n[w]?.maxBlockDifference ?? 1 / 0, h = (this.#n[m]?.maxBlockDifference ?? 1 / 0) < this.#e ? m : null, this.#v = h, this.#n = [], this.#s = 0;
    }
    const p = i ? performance.now() : 0;
    return i && t.decimateSamples.push({
      atMs: A,
      differenceMs: n - A,
      sampleCopyMs: l - u,
      cycleDecisionMs: u - n + p - l,
      totalMs: p - A
    }), {
      cycleIndex: s,
      maxBlockDifference: r.maxBlockDifference,
      totalDifference: r.totalDifference,
      shouldDrop: f,
      dropIndex: a,
      nextDropIndex: h,
      lowestCycleDifference: this.#G,
      runnerUpCycleDifference: this.#W
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, A, s) {
    if (A === "c") return t.slice();
    const r = t.slice(), n = A === "p" ? e : i, o = r.length / this.#i, f = s ? 1 : 0;
    for (let a = f; a < this.#i; a += 2)
      r.set(
        n.subarray(a * o, (a + 1) * o),
        a * o
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#s = 0, this.#v = null, this.#n = [], this.#D = null, this.#G = 1 / 0, this.#W = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #k(e, t, i, A) {
    const s = this.#f, r = this.#i, n = 2 - i, o = 2 - i, f = A[e], a = A[t], u = D.#le(
      f,
      a,
      s,
      r,
      i
    );
    let l = 0, h = 0, p = 0, m = 0, w = 0, g = 0;
    for (let F = 2; F < r - 2; F += 2) {
      const b = (F - 2) / 2, M = n - 1 + b * 2, R = n + 1 + b * 2, U = n + 3 + b * 2, N = n + b * 2, X = N + 2, G = o + b * 2, I = G + 2, $ = n + b * 2;
      for (let C = 8; C < s - 8; C++) {
        const B = (u[$ * s + C] ?? 0) | (u[($ + 2) * s + C] ?? 0);
        if (B === 0) continue;
        const ee = (A.c[M * s + C] ?? 0) + ((A.c[R * s + C] ?? 0) << 2) + (A.c[U * s + C] ?? 0), W = Math.abs(
          3 * ((f[N * s + C] ?? 0) + (f[X * s + C] ?? 0)) - ee
        ), O = Math.abs(
          3 * ((a[G * s + C] ?? 0) + (a[I * s + C] ?? 0)) - ee
        );
        W > 23 && (B & 1) !== 0 && (l += W), O > 23 && (B & 1) !== 0 && (m += O), W > 42 && (B & 2) !== 0 && (h += W), O > 42 && (B & 2) !== 0 && (w += O), W > 42 && (B & 4) !== 0 && (p += W), O > 42 && (B & 4) !== 0 && (g += O);
      }
    }
    h < 500 && w < 500 && (p >= 500 || g >= 500) && Math.max(p, g) > 3 * Math.min(p, g) && (h = p, w = g);
    const v = Math.floor(l / 6 + 0.5), y = Math.floor(m / 6 + 0.5), E = Math.floor(h / 6 + 0.5), d = Math.floor(w / 6 + 0.5), _ = Math.max(v, y) / Math.max(Math.min(v, y), 1), S = Math.max(E, d) / Math.max(Math.min(E, d), 1), x = Math.max(E, d) / Math.max(Math.max(v, y), 1);
    return (E >= 500 || d >= 500) && (E * 2 < d || d * 2 < E) || (E >= 1e3 || d >= 1e3) && (E * 3 < d * 2 || d * 3 < E * 2) || (E >= 2e3 || d >= 2e3) && (E * 5 < d * 4 || d * 5 < E * 4) || (E >= 4e3 || d >= 4e3) && S > _ || x > 5e-3 && Math.max(E, d) > 150 && (E * 2 < d || d * 2 < E) ? E > d ? t : e : v > y ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #le(e, t, i, A, s) {
    const r = Array.from(
      { length: Math.ceil(A / 2) },
      () => new Uint8Array(i)
    ), n = s === 1 ? 1 : 0;
    for (let a = 0; a < r.length; a++) {
      const u = Math.min(A - 1, n + a * 2), l = r[a];
      if (l)
        for (let h = 0; h < i; h++)
          l[h] = Math.abs(
            (e[u * i + h] ?? 0) - (t[u * i + h] ?? 0)
          );
    }
    const o = new Uint8Array(i * A), f = s === 1 ? 3 : 2;
    for (let a = 1; a < r.length - 1; a++) {
      const u = f + (a - 1) * 2;
      if (u >= A) break;
      const l = r[a];
      if (l)
        for (let h = 1; h < i - 1; h++) {
          const p = l[h] ?? 0;
          if (p <= 3) continue;
          let m = 0;
          for (let d = h - 1; d <= h + 1; d++)
            m += (r[a - 1]?.[d] ?? 0) > 3 ? 1 : 0, m += (r[a]?.[d] ?? 0) > 3 ? 1 : 0, m += (r[a + 1]?.[d] ?? 0) > 3 ? 1 : 0;
          if (m <= 1) continue;
          const w = u * i + h;
          if (o[w] = 1, p <= 19) continue;
          m = 0;
          let g = !1, v = !1;
          for (let d = h - 1; d <= h + 1; d++)
            (r[a - 1]?.[d] ?? 0) > 19 && (m++, g = !0), (r[a]?.[d] ?? 0) > 19 && m++, (r[a + 1]?.[d] ?? 0) > 19 && (m++, v = !0);
          if (m <= 3) continue;
          if (g && v) {
            o[w] |= 2;
            continue;
          }
          let y = !1, E = !1;
          for (let d = Math.max(h - 4, 0); d < Math.min(h + 5, i); d++)
            a !== 1 && (r[a - 2]?.[d] ?? 0) > 19 && (y = !0), (r[a - 1]?.[d] ?? 0) > 19 && (g = !0), (r[a + 1]?.[d] ?? 0) > 19 && (v = !0), a !== r.length - 2 && (r[a + 2]?.[d] ?? 0) > 19 && (E = !0);
          g && (v || y) || v && (g || E) ? o[w] |= 2 : m > 5 && (o[w] |= 4);
        }
    }
    return o;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #L(e, t, i) {
    const A = new Uint8Array(t * i), s = (n, o) => e[Math.max(0, Math.min(i - 1, o)) * t + n] ?? 0;
    for (let n = 0; n < i; n++)
      for (let o = 0; o < t; o++) {
        const f = s(o, n), a = s(o, n === 0 ? 1 : n - 1), u = s(o, n === i - 1 ? i - 2 : n + 1), l = n < 2 ? s(o, n === 0 ? 2 : 3) : s(o, n - 2), h = n + 2 >= i ? s(o, n === i - 1 ? i - 3 : i - 4) : s(o, n + 2);
        (n === 0 ? Math.abs(f - u) > D.COMB_THRESHOLD : n === i - 1 ? Math.abs(f - a) > D.COMB_THRESHOLD : Math.abs(f - a) > D.COMB_THRESHOLD && Math.abs(f - u) > D.COMB_THRESHOLD) && Math.abs(
          4 * f - 3 * (a + u) + l + h
        ) > D.COMB_THRESHOLD * 6 && (A[n * t + o] = 255);
      }
    let r = 0;
    for (const n of [0, 8])
      for (const o of [0, 8])
        for (let f = n; f < i; f += 16)
          for (let a = o; a < t; a += 16) {
            let u = 0;
            for (let l = Math.max(1, f); l < Math.min(i - 1, f + 16); l++)
              for (let h = a; h < Math.min(t, a + 16); h++) {
                const p = l * t + h;
                A[p - t] === 255 && A[p] === 255 && A[p + t] === 255 && u++;
              }
            r = Math.max(r, u);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #fe(e, t, i, A) {
    const s = D.DECIMATE_BLOCK / 2, r = Math.ceil(i / s), n = Math.ceil(A / s), o = new Float64Array(r * n), f = e.length / (i * A);
    for (let l = 0; l < A; l++) {
      const h = Math.floor(l / s);
      for (let p = 0; p < i; p++) {
        const m = Math.floor(p / s), w = h * r + m, g = (l * i + p) * f;
        if (f === 1) {
          o[w] = (o[w] ?? 0) + Math.abs((e[g] ?? 0) - (t[g] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[g] ?? 0) * 0.2126 + (e[g + 1] ?? 0) * 0.7152 + (e[g + 2] ?? 0) * 0.0722
        ), y = Math.round(
          (t[g] ?? 0) * 0.2126 + (t[g + 1] ?? 0) * 0.7152 + (t[g + 2] ?? 0) * 0.0722
        );
        if (o[w] = (o[w] ?? 0) + Math.abs(v - y), (p & 1) !== 0 || (l & 1) !== 0) continue;
        let E = 0, d = 0, _ = 0, S = 0, x = 0, F = 0, b = 0;
        for (let X = l; X < Math.min(l + 2, A); X++)
          for (let G = p; G < Math.min(p + 2, i); G++) {
            const I = (X * i + G) * f;
            E += e[I] ?? 0, d += e[I + 1] ?? 0, _ += e[I + 2] ?? 0, S += t[I] ?? 0, x += t[I + 1] ?? 0, F += t[I + 2] ?? 0, b++;
          }
        const M = Math.round(
          (-0.114572 * E - 0.385428 * d + 0.5 * _) / b
        ), R = Math.round(
          (-0.114572 * S - 0.385428 * x + 0.5 * F) / b
        ), U = Math.round(
          (0.5 * E - 0.454153 * d - 0.045847 * _) / b
        ), N = Math.round(
          (0.5 * S - 0.454153 * x - 0.045847 * F) / b
        );
        o[w] = (o[w] ?? 0) + Math.abs(M - R) + Math.abs(U - N);
      }
    }
    let a = -1;
    for (let l = 0; l < n - 1; l++)
      for (let h = 0; h < r - 1; h++)
        a = Math.max(
          a,
          (o[l * r + h] ?? 0) + (o[l * r + h + 1] ?? 0) + (o[(l + 1) * r + h] ?? 0) + (o[(l + 1) * r + h + 1] ?? 0)
        );
    let u = 0;
    for (const l of o) u += l;
    return { maxBlockDifference: a, totalDifference: u };
  }
}
let oe = null;
function de(c) {
  oe = c;
}
const me = 0.5, T = 3, q = 5, P = q + 1, te = 1e3, j = 4, V = 200, pe = 0.25, we = 1e3 / 60, ge = 0.02, Ee = 250, ve = 1e3 / 30;
function ie(c) {
  if (!Number.isFinite(c) || c < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return c;
}
const be = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, De = `#version 300 es
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
function ke() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class Le extends EventTarget {
  #f;
  #i;
  #e;
  #s;
  #v;
  #n;
  /** The program that copies a filtered picture onto the canvas. */
  #D;
  #G;
  #W;
  /** The reduced pass that reads previous, current and next luma together. */
  #k = null;
  #le = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #L = null;
  #fe = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #q = null;
  #Je = null;
  #_ = null;
  #y = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #w = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #K = P - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #u = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #t = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #I = null;
  #ue = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #B = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #O = we;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #H = null;
  #xe;
  #T;
  #d;
  #X;
  #Me;
  #F = "video";
  #$ = "c";
  #Fe = 0;
  #Re = !0;
  #Se = new D(k, L);
  #Ce = 1 / 0;
  #ke = 1 / 0;
  #P = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #c = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #m = 0;
  #b = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #p = T - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #o = 0;
  #ee = 0;
  #de = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #te = !1;
  #z = null;
  /** requestVideoFrameCallback() の停止を検出するために保持する最終通知時刻。 */
  #me = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #Y = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #Le = 0;
  #l = !1;
  #pe = !1;
  #_e = !1;
  #a = null;
  #Z = [];
  #x = !1;
  #Ie;
  #h;
  #we;
  #R;
  #Be;
  #r = null;
  #A;
  #ie = !1;
  #Pe = 0;
  #Ue = !1;
  #wt = 0;
  #se = !1;
  #ge = !1;
  #Q = null;
  #gt = 0;
  #Ae = /* @__PURE__ */ new Map();
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #g = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    late: 0,
    queueResetted: 0
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #U = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #Ne = 0;
  #Ee = 0;
  #N = 0;
  #re = 0;
  #ne = 0;
  #oe = 0;
  #j = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#T = t.doubleRate ?? !1, this.#d = t.autoFilm ?? !1, this.#X = ie(
      t.filmCombThreshold ?? D.COMBED_PIXEL_LIMIT
    ), this.#Me = t.spatialCheck ?? !0, this.#Ie = t.onStats, this.#h = i, this.#R = i ? "main" : t.rendering ?? "auto", this.#Be = t.workerUrl ?? oe, this.#A = this.#R === "main" ? "main" : "idle", this.#i = i ? i.canvas : document.createElement("canvas"), this.#f = i?.canvas ?? (this.#R === "main" ? this.#i : document.createElement("canvas")), this.#we = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const A = this.#f.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!A) throw new Error("this browser has no WebGL2");
    this.#s = A, this.#v = z(A, ce);
    const s = this.#v;
    this.#n = Object.fromEntries(
      Object.entries(he).map(([r, n]) => [
        r,
        A.getUniformLocation(s, n)
      ])
    ), this.#D = z(A, De), this.#G = A.getUniformLocation(this.#D, "uField"), this.#W = A.getUniformLocation(this.#D, "uFlip"), this.#d && this.#it(), this.#f.addEventListener(
      "webglcontextlost",
      this.#pt
    ), this.#xe = i ? null : new ResizeObserver(() => this.#Te()), e.addEventListener("emptied", this.#ut), e.addEventListener("resize", this.#ft), e.addEventListener("pause", this.#C), e.addEventListener("ended", this.#C), e.addEventListener("seeking", this.#mt), e.addEventListener("seeked", this.#C), e.addEventListener("ratechange", this.#C);
  }
  get running() {
    return this.#l && (this.#a?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#i;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #ve() {
    return this.#a?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #qe() {
    return {
      doubleRate: this.#T,
      autoFilm: this.#d,
      filmCombThreshold: this.#X,
      spatialCheck: this.#Me
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#pe;
  }
  set enabled(e) {
    this.#pe = e, this.#We(), this.#r?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#a?.interlaced !== e?.interlaced, i = t || this.#a?.topFieldFirst !== e?.topFieldFirst;
    this.#a = e, this.#r?.postMessage({ type: "scan", scan: e }), i && (this.#o = 0, this.#E(), t && (this.#c = 0), this.#u = null, this.#M(!1)), this.#We(), i && ((e?.interlaced ?? !0) && (this.#h || this.#A === "main") ? this.#V() : this.#ze());
  }
  get scan() {
    return this.#a;
  }
  set videoTimeline(e) {
    this.#Z = e, this.#r?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#a = null), this.#We();
  }
  get videoTimeline() {
    return this.#Z;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#H ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#T;
  }
  set doubleRate(e) {
    e !== this.#T && (this.#T = e, this.#Ge(), this.#t.length = 0, e ? (this.#m > 0 && this.#je(), (this.#a?.interlaced ?? !0) && (this.#h || this.#A === "main") && this.#V()) : this.#d || (this.#u = null, this.#M(!1), this.#J()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#d;
  }
  set autoFilm(e) {
    e !== this.#d && (this.#d = e, this.#Ge(), this.#E(), e ? (this.#it(), this.#m > 0 && (this.#lt(), this.#je()), (this.#a?.interlaced ?? !0) && (this.#h || this.#A === "main") && this.#V()) : (this.#Qe(), this.#T || (this.#u = null, this.#M(!1), this.#J())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#X;
  }
  set filmCombThreshold(e) {
    const t = ie(e);
    t !== this.#X && (this.#X = t, this.#Ge(), this.#d && this.#E());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Ge() {
    this.#r?.postMessage({
      type: "settings",
      options: this.#qe()
    });
  }
  #We() {
    this.#pe && (this.#Z.length > 0 || (this.#a?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #Et() {
    return this.#h || this.#R === "main" ? !1 : this.#A === "starting" || this.#A === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Be !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Ke(), !0) : this.#R === "auto" ? (this.#be(), !1) : (this.#A = "failed", this.#l = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #Ke() {
    this.#S(), this.#r?.terminate(), this.#r = null, this.#se = !1, this.#ge = !1;
    let e = this.#i;
    if (this.#Ue) {
      e = document.createElement("canvas"), e.className = this.#i.className;
      const s = this.#i.getAttribute("style");
      s === null ? e.removeAttribute("style") : e.setAttribute("style", s), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e;
    }
    const t = ++this.#Pe;
    this.#A = "starting";
    let i, A;
    try {
      A = e.transferControlToOffscreen(), this.#Ue = !0, i = new Worker(this.#Be, { type: "module" });
    } catch (s) {
      this.#ae(
        s instanceof Error ? s.message : String(s)
      );
      return;
    }
    this.#r = i, i.onmessage = (s) => {
      t === this.#Pe && this.#vt(s.data);
    }, i.onerror = (s) => {
      t === this.#Pe && (s.preventDefault(), this.#ae(s.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: A,
        options: this.#qe(),
        scan: this.#a,
        videoTimeline: this.#Z,
        enabled: this.#l,
        video: this.#Oe()
      },
      [A]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #vt(e) {
    switch (e.type) {
      case "ready":
        this.#A = "active", this.#l && (this.#he(), this.#Ye());
        break;
      case "failed":
        this.#ae(e.message);
        break;
      case "consumed": {
        this.#se = !1, this.#ge = !0;
        const t = this.#Q;
        this.#Q = null, t && this.#et(t);
        break;
      }
      case "visibility":
        this.#i.style.visibility = e.visible ? "visible" : "hidden";
        break;
      case "stats": {
        const t = {
          ...e.stats,
          dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0
        };
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#Ie?.(t);
        break;
      }
      case "capture": {
        const t = this.#Ae.get(e.id);
        if (this.#Ae.delete(e.id), !t) {
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
  /** 一時的な Worker 障害を1回だけ復旧し、再失敗時は media element 自体を表示する。 */
  #ae(e) {
    if (this.#A === "starting" && this.#R === "auto" && !this.#ie) {
      this.#be();
      return;
    }
    if (this.#$e(e), !this.#ie) {
      this.#ie = !0, this.#Ke();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#A = "failed", this.#r?.terminate(), this.#r = null, this.#S(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #be() {
    const e = this.#f;
    e.className = this.#i.className;
    const t = this.#i.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e, this.#Ue = !1, this.#r?.terminate(), this.#r = null, this.#A = "main", this.#S(), this.#l && (this.#he(), this.#Ye(), (this.#a?.interlaced ?? !0) && this.#V());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #S() {
    this.#Q?.frame.close(), this.#Q = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #$e(e) {
    for (const t of this.#Ae.values())
      t.reject(new Error(e));
    this.#Ae.clear();
  }
  start() {
    if (!(this.#l || this.#_e || this.#x)) {
      if (this.#l = !0, this.#dt(), this.#E(), this.#me = performance.now(), this.#Le = this.#me, this.#de = Number.NaN, this.#Y = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#It(), this.#Ye(), this.#Et()) {
        this.#r?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#A === "active" && this.#he();
        return;
      }
      this.#he(), (this.#a?.interlaced ?? !0) && this.#V();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#l && (this.#l = !1, this.#z !== null && this.#e.cancelVideoFrameCallback(this.#z), this.#z = null, this.#Rt(), this.#ze(), this.#o = 0, this.#u = null, this.#M(!1), this.#S(), this.#r?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#_e) {
      this.#_e = !0, this.#pe = !1, this.stop(), this.#r?.postMessage({ type: "destroy" }), this.#r?.terminate(), this.#r = null, this.#S(), this.#$e("the deinterlacer was destroyed"), this.#f.removeEventListener(
        "webglcontextlost",
        this.#pt
      ), this.#e.removeEventListener("emptied", this.#ut), this.#e.removeEventListener("resize", this.#ft), this.#e.removeEventListener("pause", this.#C), this.#e.removeEventListener("ended", this.#C), this.#e.removeEventListener("seeking", this.#mt), this.#e.removeEventListener("seeked", this.#C), this.#e.removeEventListener("ratechange", this.#C), this.#Bt();
      for (const e of this.#y) this.#s.deleteTexture(e);
      this.#y = [], this.#J(), this.#Qe(), this.#s.deleteProgram(this.#v), this.#s.deleteProgram(this.#D), this.#k && this.#s.deleteProgram(this.#k), this.#L && this.#s.deleteProgram(this.#L), this.#q && this.#s.deleteProgram(this.#q), this.#s.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#A === "active" && this.#i.style.visibility === "visible" && this.#r) {
      const A = ++this.#gt, s = new Promise((r, n) => {
        this.#Ae.set(A, { resolve: r, reject: n });
      });
      return this.#r.postMessage({
        type: "capture",
        id: A,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), s;
    }
    if (this.#A === "starting" || this.#A === "failed")
      return createImageBitmap(this.#e);
    const e = this.#u;
    if (this.#h && (!this.#l || this.#x || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#l || this.#x || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#Ze(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#ce(e.flush, e.second, null, !1) : this.#He(null, !1);
    const t = this.#e.videoWidth, i = this.#e.videoHeight;
    return t > 0 && i > 0 && (t !== this.#f.width || i !== this.#f.height) ? createImageBitmap(this.#f, {
      resizeWidth: t,
      resizeHeight: i,
      resizeQuality: "high"
    }) : createImageBitmap(this.#f);
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #he() {
    this.#h || !this.#l || this.#z !== null || (this.#z = this.#e.requestVideoFrameCallback(this.#Dt));
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #Oe() {
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
  #bt(e, t) {
    let i;
    try {
      i = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (s) {
      const r = s instanceof Error ? s.message : String(s);
      this.#R === "auto" && !this.#ge && !this.#ie ? (this.#be(), this.#De(e, t)) : this.#ae(r);
      return;
    }
    const A = {
      id: ++this.#wt,
      frame: i,
      now: e,
      metadata: t,
      video: this.#Oe()
    };
    if (this.#se) {
      this.#Q?.frame.close(), this.#Q = A;
      return;
    }
    this.#et(A);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #et(e) {
    const t = this.#r;
    if (!t || this.#A !== "active") {
      e.frame.close();
      return;
    }
    this.#se = !0;
    const i = { type: "frame", ...e };
    try {
      t.postMessage(i, [e.frame]);
    } catch (A) {
      this.#se = !1, e.frame.close();
      const s = A instanceof Error ? A.message : String(A);
      this.#R === "auto" && !this.#ge && !this.#ie ? (this.#be(), this.#De(e.now, e.metadata)) : this.#ae(s);
    }
  }
  #Dt = (e, t) => {
    this.#z = null, !(!this.#l || this.#x) && (this.#me = e, this.#Y = Math.max(
      this.#Y,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#tt(e, t), this.#he());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #tt(e, t) {
    if (this.#de = t.mediaTime, this.#A === "active") {
      this.#bt(e, t);
      return;
    }
    this.#A !== "starting" && this.#De(e, t);
  }
  /** @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。 */
  ingestExternalFrame(e, t, i) {
    this.#we = i;
    try {
      this.#De(e, t);
    } finally {
      this.#we = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #De(e, t) {
    if (this.#yt(t.mediaTime), t.width > 0 && t.height > 0) {
      let i = !1;
      if (!this.#te && this.#e.seeking) {
        const h = this.#e.buffered, p = this.#c >= j ? this.#c / 1e3 : V / 1e3;
        for (let m = 0; m < h.length; m++)
          if (t.mediaTime >= h.start(m) && t.mediaTime < h.end(m) && Math.abs(t.mediaTime - this.#e.currentTime) <= p) {
            i = !0;
            break;
          }
      }
      if (i && (this.#te = !0), (this.#m === 0 || this.#b === 0) && this.#ct(t.width, t.height), this.#a && !this.#a.interlaced) {
        this.#kt();
        return;
      }
      const A = t.mediaTime - this.#ee, s = i || A < 0 || A > me;
      s && (this.#o = 0, this.#c = 0, this.#g.discontinuities++, this.#t.length = 0, this.#E());
      const r = this.#d && this.#U !== 0 && t.presentedFrames - this.#U > 1;
      if (this.#Lt(t.presentedFrames, s), !s && r && (this.#o = 0, this.#E()), this.#o > 0 && t.mediaTime === this.#ee)
        return;
      !s && A > 0 && this.#Tt(A), this.#ee = t.mediaTime;
      const n = performance.now();
      n - this.#Ne > te && (this.#Ee = n, this.#N = 0, this.#re = 0, this.#ne = 0, this.#oe = 0, this.#j = 0, this.#P = 0), this.#Ne = n;
      const o = performance.now();
      this.#ht();
      const f = this.#F, a = this.#d && this.#o === T && this.#xt();
      if (f !== this.#F && (this.#t.length = 0), !(a && this.#ye())) if (this.#d && !this.#Re && this.#F === "film")
        if (this.#ye()) {
          const h = this.#c * 5 / 4, p = this.#At(1, e, h), m = this.#t.at(-1), w = p ? e : m == null ? e + h : m.at + m.duration;
          this.#Mt(w, h);
        } else
          this.#He(null);
      else if (this.#T && this.#ye()) {
        const h = this.#c / 2, p = this.#At(2, e, h), m = this.#t.at(-1), w = p ? e : m == null ? e + h * 2 : m.at + m.duration;
        this.#st(!1, w, h), this.#st(!0, w + h, h);
      } else
        this.#g.late += this.#t.length, this.#t.length = 0, this.#ce(!1, !1, null);
      this.#j = Math.max(
        this.#j,
        this.#t.length
      ), this.#re += performance.now() - o, this.#N++, this.#_t(n);
    }
  }
  #yt(e) {
    let t;
    for (let s = this.#Z.length - 1; s >= 0; s--) {
      const r = this.#Z[s];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#m || t.codedSize.height !== this.#b) && this.#ct(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#a?.interlaced === i.interlaced && this.#a.topFieldFirst === i.topFieldFirst)
      return;
    const A = this.#a?.interlaced;
    this.#a = i, this.#o = 0, this.#t.length = 0, this.#E(), A !== i.interlaced && (this.#c = 0), i.interlaced && (this.#h || this.#A === "main") ? this.#V() : this.#ze();
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #ye() {
    return (this.#T || this.#d) && this.#c > 0 && this.#w.length === P;
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
  #Tt(e) {
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#c > 0 ? Math.max(1, Math.round(t / this.#c)) : 1, A = t / i;
    A < j || A > V || (this.#c = this.#c > 0 ? this.#c + (A - this.#c) * pe : A);
  }
  /** Build the optional film passes only for callers that enable them. */
  #it() {
    if (this.#k && this.#L && this.#q) return;
    const e = this.#s, t = z(e, le), i = z(e, fe), A = z(e, ue);
    this.#k = t, this.#le = Object.fromEntries(
      Object.entries(Q).filter(([s]) => s !== "match" && s !== "topFieldFirst").map(([s, r]) => [s, e.getUniformLocation(t, r)])
    ), this.#L = i, this.#fe = Object.fromEntries(
      Object.entries(Q).map(([s, r]) => [
        s,
        e.getUniformLocation(i, r)
      ])
    ), this.#q = A, this.#Je = Object.fromEntries(
      Object.entries(Q).map(([s, r]) => [
        s,
        e.getUniformLocation(A, r)
      ])
    );
  }
  /**
   * Run FFmpeg's fieldmatch and live decimate decisions on reduced luma.
   * Full decoded frames remain in GPU textures, while the first readback packs
   * the previous, current and next luma proxies into RGB. A second readback
   * supplies the selected RGB weave to its chroma-sensitive decimate metric.
   */
  #xt() {
    const e = this.#_, t = this.#k, i = this.#le, A = this.#q, s = this.#Je;
    if (!e || !t || !i || !A || !s)
      return !1;
    const r = this.#s, n = this.#p, o = (this.#p + T - 1) % T, f = (this.#p + 1) % T, a = this.#ve, u = globalThis.__YADIF_AUTOFILM_ANALYSIS_DIAGNOSTIC__, l = u?.enabled === !0, h = l ? performance.now() : 0;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [M, R] of [f, o, n].entries())
      r.activeTexture(r.TEXTURE0 + M), r.bindTexture(r.TEXTURE_2D, this.#y[R] ?? null);
    r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#m, this.#b), r.viewport(0, 0, k, L), r.drawArrays(r.TRIANGLES, 0, 3);
    const p = l ? performance.now() : 0;
    r.readPixels(
      0,
      0,
      k,
      L,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const m = l ? performance.now() : 0, { previousLuma: w, currentLuma: g, nextLuma: v } = e;
    for (let M = 0; M < w.length; M++) {
      const R = M * 4;
      w[M] = e.pixels[R] ?? 0, g[M] = e.pixels[R + 1] ?? 0, v[M] = e.pixels[R + 2] ?? 0;
    }
    const y = l ? performance.now() : 0, E = this.#Se.fieldMatch(
      w,
      g,
      v,
      a,
      this.#X
    ), d = l ? performance.now() : 0;
    r.useProgram(A), r.uniform1i(s.prev, 0), r.uniform1i(s.cur, 1), r.uniform1i(s.next, 2), r.uniform2i(s.size, this.#m, this.#b), r.uniform1i(s.topFieldFirst, a ? 1 : 0), r.uniform1i(
      s.match,
      E.match === "p" ? 0 : E.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3);
    const _ = l ? performance.now() : 0;
    r.readPixels(
      0,
      0,
      k,
      L,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const S = l ? performance.now() : 0, x = this.#Se.decimate(e.pixels), F = l ? performance.now() : 0;
    l && u.samples.push({
      atMs: h,
      analysisDrawSubmitMs: p - h,
      analysisReadbackMs: m - p,
      unpackLumaMs: y - m,
      fieldMatchMs: d - y,
      sampleDrawSubmitMs: _ - d,
      sampleReadbackMs: S - _,
      decimateMs: F - S,
      totalMs: F - h
    }), this.#$ = E.match, this.#Fe = E.combScore, this.#Re = E.isCombed, this.#Ce = x.lowestCycleDifference, this.#ke = x.runnerUpCycleDifference;
    const b = x.dropIndex !== null && !E.isCombed;
    return (b ? "film" : "video") !== this.#F && (this.#F = b ? "film" : "video"), x.shouldDrop && !E.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Mt(e, t) {
    const i = this.#Xe();
    if (i === null) return;
    const A = this.#w[i];
    if (A) {
      for (this.#K = i; this.#t.length > 0 && this.#t[0]?.slot === i; )
        this.#t.shift(), this.#g.late++;
      this.#He(A.framebuffer), this.#t.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #He(e, t = !0) {
    const i = this.#L, A = this.#fe;
    if (!i || !A) return;
    const s = this.#s, r = this.#p, n = (this.#p + T - 1) % T, o = (this.#p + 1) % T, f = this.#ve;
    s.bindFramebuffer(s.FRAMEBUFFER, e), s.useProgram(i);
    for (const [a, u] of [o, n, r].entries())
      s.activeTexture(s.TEXTURE0 + a), s.bindTexture(s.TEXTURE_2D, this.#y[u] ?? null);
    s.uniform1i(A.prev, 0), s.uniform1i(A.cur, 1), s.uniform1i(A.next, 2), s.uniform2i(A.size, this.#m, this.#b), s.uniform1i(A.topFieldFirst, f ? 1 : 0), s.uniform1i(
      A.match,
      this.#$ === "p" ? 0 : this.#$ === "c" ? 1 : 2
    ), s.viewport(0, 0, this.#m, this.#b), s.drawArrays(s.TRIANGLES, 0, 3), e === null && (this.#u = { kind: "film" }, this.#M(!0), t && this.#P++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #st(e, t, i) {
    const A = this.#Xe();
    if (A === null) return;
    const s = this.#w[A];
    if (s) {
      for (this.#K = A; this.#t.length > 0 && this.#t[0]?.slot === A; )
        this.#t.shift(), this.#g.late++;
      this.#ce(!1, e, s.framebuffer), this.#t.push({ slot: A, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #At(e, t, i) {
    const A = this.#t.at(-1), s = (q + 1) * Math.max(this.#O, i);
    if (A && A.at - t > s)
      return this.#t.length = 0, this.#g.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#t.length + e - q
    );
    let n = 0, o = 0;
    for (; o < r; ) {
      const f = this.#t.shift();
      if (!f) break;
      n += f.duration, o++;
    }
    for (const f of this.#t) f.at -= n;
    return this.#g.late += o, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Xe() {
    const e = this.#u?.kind === "texture" ? this.#u.texture : null, t = new Set(this.#t.map(({ slot: A }) => A));
    for (let A = 1; A <= P; A++) {
      const s = (this.#K + A) % P, r = this.#w[s];
      if (r && r.texture !== e && !t.has(s))
        return s;
    }
    const i = this.#t[0];
    if (i) {
      const A = this.#w[i.slot];
      if (A && A.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #V() {
    this.#I === null && (!this.#l || this.#x || (this.#ue = 0, this.#I = this.#nt(this.#rt)));
  }
  #ze() {
    this.#I !== null && this.#Ft(this.#I), this.#I = null, this.#t.length = 0;
  }
  #rt = (e) => {
    if (this.#I = null, !(!this.#l || this.#x)) {
      if (this.#ue > 0) {
        const t = e - this.#ue;
        t >= 1 && t <= V && (this.#O = t < this.#O ? t : this.#O + (t - this.#O) * ge);
      }
      this.#ue = e, this.#A === "main" && this.#Ct(e), this.#I = this.#nt(this.#rt);
    }
  };
  /** ページと Worker のそれぞれが所有する requestAnimationFrame() へ表示ループを委ねる。 */
  #nt(e) {
    return this.#h ? this.#h.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #Ft(e) {
    this.#h ? this.#h.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #Ye() {
    this.#h || this.#B !== null || !this.#l || this.#x || (this.#B = requestAnimationFrame(this.#ot));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Rt() {
    this.#B !== null && cancelAnimationFrame(this.#B), this.#B = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #ot = (e) => {
    this.#B = null, !(!this.#l || this.#x) && (this.#St(e), this.#B = requestAnimationFrame(this.#ot));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #St(e) {
    if (this.#h || e - this.#me < Ee || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, A = this.#c >= j ? this.#c : ve, s = i > this.#Y, r = t !== this.#de && e - this.#Le >= A * 0.75;
    !s && !r || (this.#Y = Math.max(
      this.#Y,
      i
    ), this.#Le = e, this.#tt(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#U + 1, i),
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
   */
  #Ct(e) {
    const t = e + this.#O * 1.5;
    for (; this.#t[1] && this.#t[1].at <= t; )
      this.#g.late++, this.#t.shift();
    let i = this.#t[0];
    if (!i || i.at > t)
      return;
    this.#t.shift();
    const A = performance.now();
    this.#at(i.slot), this.#oe += performance.now() - A, this.#ne++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #at(e) {
    const t = this.#w[e];
    t && this.#Ze(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #kt() {
    this.#ht();
    const e = this.#y[this.#p];
    e && this.#Ze(e, !0), this.#o = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #M(e) {
    if (this.#h) {
      this.#h.onVisibility(e);
      return;
    }
    this.#i.style.visibility = e ? "visible" : "hidden";
  }
  #Ze(e, t = !1, i = !0) {
    const A = this.#s;
    A.bindFramebuffer(A.FRAMEBUFFER, null), A.useProgram(this.#D), A.activeTexture(A.TEXTURE0), A.bindTexture(A.TEXTURE_2D, e), A.uniform1i(this.#G, 0), A.uniform1i(this.#W, t ? 1 : 0), A.viewport(0, 0, this.#m, this.#b), A.drawArrays(A.TRIANGLES, 0, 3), this.#u = { kind: "texture", texture: e, flip: t }, this.#M(!0), i && this.#P++;
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
  #Lt(e, t) {
    this.#U !== 0 && !t && (this.#g.missed += Math.max(0, e - this.#U - 1)), this.#U = e;
  }
  #_t(e) {
    const t = e - this.#Ee;
    if (t < te) return;
    const i = this.#ye() && (this.#T || this.#F === "film") ? this.#ne : this.#N, A = {
      ...this.#g,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#N === 0 ? 0 : (this.#re + this.#oe) / this.#N,
      maxQueuedFields: this.#j,
      mode: this.#F,
      match: this.#$,
      combScore: this.#Fe,
      outputFps: this.#P * 1e3 / t,
      duplicateScore: this.#Ce,
      duplicateRunnerUp: this.#ke
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: A })), this.#Ie?.(A), this.#Ee = e, this.#N = 0, this.#re = 0, this.#ne = 0, this.#oe = 0, this.#j = 0, this.#P = 0;
  }
  /** Take the newest frame into the ring. */
  #ht() {
    const e = this.#s;
    this.#p = (this.#p + 1) % T, e.bindTexture(e.TEXTURE_2D, this.#y[this.#p] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#we
    ), this.#o = Math.min(this.#o + 1, T);
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
  #ce(e, t, i, A = !0) {
    if (this.#o === 0 || this.#x) return;
    A && (this.#o === T && !e ? this.#g.filtered++ : this.#g.degraded++);
    const s = this.#s, r = this.#p, n = (this.#p + T - 1) % T, o = (this.#p + 1) % T;
    let f, a, u;
    this.#o === 1 ? f = a = u = r : e ? (f = n, a = u = r) : this.#o === 2 ? (f = a = n, u = r) : (f = o, a = n, u = r), s.bindFramebuffer(s.FRAMEBUFFER, i), s.useProgram(this.#v);
    for (const [h, p] of [f, a, u].entries())
      s.activeTexture(s.TEXTURE0 + h), s.bindTexture(s.TEXTURE_2D, this.#y[p] ?? null);
    s.uniform1i(this.#n.prev, 0), s.uniform1i(this.#n.cur, 1), s.uniform1i(this.#n.next, 2), s.uniform2i(this.#n.size, this.#m, this.#b);
    const l = this.#ve ? 0 : 1;
    s.uniform1i(this.#n.parity, t ? 1 - l : l), s.uniform1i(this.#n.tff, this.#ve ? 1 : 0), s.uniform1i(this.#n.spatialCheck, this.#Me ? 1 : 0), s.viewport(0, 0, this.#m, this.#b), s.drawArrays(s.TRIANGLES, 0, 3), i === null && (this.#u = { kind: "yadif", flush: e, second: t }, this.#M(!0), A && this.#P++);
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
  #Te() {
    if (!this.#H) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const A = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), s = t * A, r = i * A;
    this.#i.style.left = `${e.offsetLeft + (e.offsetWidth - s) / 2}px`, this.#i.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#i.style.width = `${s}px`, this.#i.style.height = `${r}px`;
  }
  #ct(e, t) {
    const i = this.#s;
    this.#f.width = e, this.#f.height = t, this.#m = e, this.#b = t, this.#o = 0, this.#u = null, this.#E(), this.#Te();
    for (const A of this.#y) i.deleteTexture(A);
    this.#y = [];
    for (let A = 0; A < T; A++) {
      const s = i.createTexture();
      i.bindTexture(i.TEXTURE_2D, s), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MIN_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MAG_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_S, i.CLAMP_TO_EDGE), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_T, i.CLAMP_TO_EDGE), i.texImage2D(
        i.TEXTURE_2D,
        0,
        i.RGBA,
        e,
        t,
        0,
        i.RGBA,
        i.UNSIGNED_BYTE,
        null
      ), this.#y.push(s);
    }
    this.#J(), this.#Qe(), this.#d && this.#lt(), (this.#T || this.#d) && this.#je();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #lt() {
    if (this.#_) return;
    const e = this.#s, t = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      k,
      L,
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
    const A = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
    if (e.bindFramebuffer(e.FRAMEBUFFER, null), !A) {
      e.deleteFramebuffer(i), e.deleteTexture(t);
      return;
    }
    this.#_ = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(k * L * 4),
      previousLuma: new Uint8Array(k * L),
      currentLuma: new Uint8Array(k * L),
      nextLuma: new Uint8Array(k * L)
    };
  }
  #Qe() {
    this.#_ && (this.#s.deleteFramebuffer(this.#_.framebuffer), this.#s.deleteTexture(this.#_.texture), this.#_ = null);
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
  #je() {
    const e = this.#s;
    if (!(this.#w.length === P || this.#m === 0)) {
      this.#J();
      for (let t = 0; t < P; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#m,
          this.#b,
          0,
          e.RGBA,
          e.UNSIGNED_BYTE,
          null
        );
        const A = e.createFramebuffer();
        e.bindFramebuffer(e.FRAMEBUFFER, A), e.framebufferTexture2D(
          e.FRAMEBUFFER,
          e.COLOR_ATTACHMENT0,
          e.TEXTURE_2D,
          i,
          0
        );
        const s = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
        if (e.bindFramebuffer(e.FRAMEBUFFER, null), !s) {
          e.deleteFramebuffer(A), e.deleteTexture(i), this.#J();
          return;
        }
        this.#w.push({ texture: i, framebuffer: A });
      }
      this.#K = P - 1;
    }
  }
  #J() {
    const e = this.#s, t = this.#u?.kind === "texture" ? this.#u.texture : null;
    this.#w.some((i) => i.texture === t) && (this.#u = null);
    for (const { texture: i, framebuffer: A } of this.#w)
      e.deleteFramebuffer(A), e.deleteTexture(i);
    this.#w = [], this.#t.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #It() {
    if (this.#H) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#H = t, this.#xe?.observe(this.#e), this.#Te();
  }
  #Bt() {
    if (this.#h) return;
    const e = this.#H;
    this.#H = null, this.#xe?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #ft = () => this.#Te();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #Ve(e) {
    return !this.#r || this.#A === "main" ? !1 : (this.#r.postMessage({
      type: "event",
      name: e,
      video: this.#Oe()
    }), !0);
  }
  #ut = () => {
    if (this.#de = Number.NaN, this.#Ve("emptied")) {
      this.#S(), this.#M(!1);
      return;
    }
    this.#o = 0, this.#ee = 0, this.#t.length = 0, this.#c = 0, this.#dt(), this.#E(), this.#u = null, this.#M(!1);
  };
  #dt() {
    this.#g = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#U = 0, this.#Ee = 0, this.#Ne = 0, this.#N = 0, this.#re = 0, this.#ne = 0, this.#oe = 0, this.#j = 0, this.#P = 0, this.#E();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #E() {
    this.#t.length = 0, this.#F = "video", this.#$ = "c", this.#Fe = 0, this.#Re = !0, this.#Se.reset(), this.#Ce = 1 / 0, this.#ke = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #mt = () => {
    if (this.#Ve("seeking")) {
      this.#S();
      return;
    }
    this.#te = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #C = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#Ve(e.type)) {
      this.#S();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#te;
      if (this.#te = !1, i) return;
      this.#o = 0, this.#E(), this.#u = null, this.#M(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#c = 0, this.#ee = this.#e.currentTime), this.#t.length = 0, this.#l && this.#o > 0) {
      const i = this.#Xe(), A = i === null ? void 0 : this.#w[i];
      i !== null && A ? (this.#K = i, this.#ce(!0, !1, A.framebuffer), this.#at(i)) : this.#ce(!0, !1, null);
    }
    t && (this.#o = 0, this.#E());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #pt = (e) => {
    if (e.preventDefault(), this.#h) {
      this.#h.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#A !== "active" && (this.#x = !0, this.stop());
  };
}
function z(c, e) {
  const t = c.createProgram(), i = se(c, c.VERTEX_SHADER, be), A = se(c, c.FRAGMENT_SHADER, e);
  if (c.attachShader(t, i), c.attachShader(t, A), c.linkProgram(t), c.deleteShader(i), c.deleteShader(A), !c.getProgramParameter(t, c.LINK_STATUS)) {
    const s = c.getProgramInfoLog(t);
    throw c.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${s ?? "no reason given"}`
    );
  }
  return t;
}
function se(c, e, t) {
  const i = c.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (c.shaderSource(i, t), c.compileShader(i), !c.getShaderParameter(i, c.COMPILE_STATUS)) {
    const A = c.getShaderInfoLog(i);
    throw c.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${A ?? "no reason given"}`
    );
  }
  return i;
}
const Ae = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", ye = 0.5, Te = 3e3, re = 0.1, H = 16, ne = 'video/mp4; codecs="avc1.640029"';
let K = null;
function xe(c = {}) {
  return K ??= Me(c), K;
}
async function _e(c = {}) {
  return (await xe(c)).deinterlaces;
}
function Ie() {
  K = null;
}
async function Me(c) {
  const e = c.tolerance ?? ye, t = c.timeoutMs ?? Te, i = performance.now(), A = (n) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: n instanceof Error ? n.message : String(n)
  });
  if (typeof document > "u")
    return A(new Error("there is no document to decode in"));
  const s = document.createElement("video");
  s.muted = !0, s.defaultMuted = !0, s.playsInline = !0, s.preload = "auto";
  let r = null;
  try {
    r = Re(s, t);
    const n = Z(Y(s, "loadeddata"), t), o = s.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await n, await Se(s, t, await o), s.videoWidth === 0 || s.videoHeight === 0)
      return A(new Error("the probe clip decoded to nothing"));
    const f = Ce(s);
    return {
      deinterlaces: f < 1 - e,
      survives: f,
      tookMs: performance.now() - i
    };
  } catch (n) {
    return A(n);
  } finally {
    s.pause(), s.removeAttribute("src"), s.replaceChildren(), s.load(), r && URL.revokeObjectURL(r.url);
  }
}
const J = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Fe = typeof MediaSource > "u";
function Re(c, e) {
  if (!J || !J.isTypeSupported(ne))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = Ae.indexOf(","), i = atob(Ae.slice(t + 1)), A = new Uint8Array(i.length);
  for (let o = 0; o < i.length; o++) A[o] = i.charCodeAt(o);
  const s = new J(), r = URL.createObjectURL(s);
  if (Fe) {
    c.disableRemotePlayback = !0;
    const o = document.createElement("source");
    o.type = "video/mp4", o.src = r, c.append(o), c.load();
  } else
    c.src = r;
  const n = (async () => {
    await Z(Y(s, "sourceopen"), e);
    const o = s.addSourceBuffer(ne), f = Z(Y(o, "updateend"), e);
    o.appendBuffer(A), await f, s.endOfStream();
  })();
  return { url: r, ready: n };
}
async function Se(c, e, t) {
  if (t) {
    const i = performance.now();
    for (; c.currentTime < re && performance.now() - i < e; )
      await new Promise((A) => requestAnimationFrame(A));
    c.pause();
  } else
    c.currentTime = re, await Z(Y(c, "seeked"), e);
}
function Ce(c) {
  const e = c.videoHeight, t = document.createElement("canvas");
  t.width = H, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(c, 0, 0, H, e);
  const A = i.getImageData(0, 0, H, e).data, s = (a) => {
    let u = 0;
    for (let l = 0; l < H; l++)
      u += A[(a * H + l) * 4 + 1] ?? 0;
    return u / H;
  };
  let r = 0;
  const n = 2, o = e - 3;
  let f = s(n);
  for (let a = n + 1; a <= o; a++) {
    const u = s(a);
    r += Math.abs(u - f), f = u;
  }
  return r / (o - n) / 255;
}
function Y(c, e) {
  return new Promise((t, i) => {
    c.addEventListener(e, () => t(), { once: !0 }), c.addEventListener(
      "error",
      () => {
        const A = c instanceof HTMLMediaElement ? c.error : null, s = A ? ` (MediaError ${A.code}${A.message ? `: ${A.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${s}`));
      },
      { once: !0 }
    );
  });
}
function Z(c, e) {
  return Promise.race([
    c,
    new Promise(
      (t, i) => setTimeout(
        () => i(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
de(ae);
export {
  Le as Deinterlacer,
  le as FILM_ANALYSIS_FRAGMENT_SHADER,
  ue as FILM_SAMPLE_FRAGMENT_SHADER,
  Q as FILM_UNIFORMS,
  fe as FILM_WEAVE_FRAGMENT_SHADER,
  ce as YADIF_FRAGMENT_SHADER,
  he as YADIF_UNIFORMS,
  _e as decoderDeinterlaces,
  Ie as forgetDecoderProbe,
  xe as probeDecoder,
  ke as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
