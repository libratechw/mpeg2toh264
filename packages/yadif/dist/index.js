const se = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, re = `#version 300 es
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
}, y = 160, M = 90, ne = `#version 300 es
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
  ivec2 targetSize = ivec2(${y}, ${M});
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
`, oe = `#version 300 es
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
`, ae = `#version 300 es
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
  ivec2 targetSize = ivec2(${y}, ${M});
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
class x {
  static CYCLE = 5;
  static COMB_THRESHOLD = 9;
  static COMBED_PIXEL_LIMIT = 80;
  static DECIMATE_BLOCK = 32;
  static DUPLICATE_PERCENT = 1.1;
  #e;
  #t;
  #b;
  #n = 0;
  #u = null;
  #o = [];
  #y = null;
  #v = 1 / 0;
  #L = 1 / 0;
  constructor(e, A) {
    this.#e = e, this.#t = A, this.#b = 255 * x.DECIMATE_BLOCK ** 2 * x.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the exact
   * matching arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, A, t, s, i = x.COMBED_PIXEL_LIMIT) {
    const r = s ? 1 : 0, a = { p: e, c: A, n: t };
    let n = this.#M("c", "p", r, a);
    const h = /* @__PURE__ */ new Map(), o = (v) => {
      const w = h.get(v);
      if (w !== void 0) return w;
      const p = x.#F(
        this.weave(e, A, t, v, s),
        this.#e,
        this.#t
      );
      return h.set(v, p), p;
    }, d = o(n), f = o("n");
    (f * 3 < d || f * 2 < d && d > i) && Math.abs(f - d) >= 30 && f < i && (n = "n");
    const l = o(n), m = l >= i;
    return m && (n = "c"), {
      match: n,
      combScore: l,
      isCombed: m,
      luma: this.weave(e, A, t, n, s)
    };
  }
  /** Apply `decimate=cycle=5:mixed=1` metrics without delaying live audio. */
  decimate(e) {
    const A = this.#n, t = this.#y ? x.#J(
      this.#y,
      e,
      this.#e,
      this.#t
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#o.push(t);
    const s = this.#u === A, i = s && t.maxBlockDifference < this.#b;
    s && !i && (this.#u = null);
    const r = this.#u;
    this.#y = e.slice(), this.#n++;
    let a = this.#u;
    if (this.#n === x.CYCLE) {
      let n = 0, h = null;
      for (let o = 1; o < this.#o.length; o++)
        (this.#o[o]?.maxBlockDifference ?? 1 / 0) < (this.#o[n]?.maxBlockDifference ?? 1 / 0) ? (h = n, n = o) : (h === null || (this.#o[o]?.maxBlockDifference ?? 1 / 0) < (this.#o[h]?.maxBlockDifference ?? 1 / 0)) && (h = o);
      this.#v = this.#o[n]?.maxBlockDifference ?? 1 / 0, this.#L = h === null ? 1 / 0 : this.#o[h]?.maxBlockDifference ?? 1 / 0, a = (this.#o[n]?.maxBlockDifference ?? 1 / 0) < this.#b ? n : null, this.#u = a, this.#o = [], this.#n = 0;
    }
    return {
      cycleIndex: A,
      maxBlockDifference: t.maxBlockDifference,
      totalDifference: t.totalDifference,
      shouldDrop: i,
      dropIndex: r,
      nextDropIndex: a,
      lowestCycleDifference: this.#v,
      runnerUpCycleDifference: this.#L
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, A, t, s, i) {
    if (s === "c") return A.slice();
    const r = A.slice(), a = s === "p" ? e : t, n = r.length / this.#t, h = i ? 1 : 0;
    for (let o = h; o < this.#t; o += 2)
      r.set(
        a.subarray(o * n, (o + 1) * n),
        o * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#n = 0, this.#u = null, this.#o = [], this.#y = null, this.#v = 1 / 0, this.#L = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #M(e, A, t, s) {
    const i = this.#e, r = this.#t, a = 2 - t, n = 2 - t, h = s[e], o = s[A], d = x.#j(
      h,
      o,
      i,
      r,
      t
    );
    let f = 0, l = 0, m = 0, v = 0, w = 0, p = 0;
    for (let C = 2; C < r - 2; C += 2) {
      const b = (C - 2) / 2, W = a - 1 + b * 2, Y = a + 1 + b * 2, Z = a + 3 + b * 2, X = a + b * 2, N = X + 2, L = n + b * 2, R = L + 2, V = a + b * 2;
      for (let T = 8; T < i - 8; T++) {
        const B = (d[V * i + T] ?? 0) | (d[(V + 2) * i + T] ?? 0);
        if (B === 0) continue;
        const K = (s.c[W * i + T] ?? 0) + ((s.c[Y * i + T] ?? 0) << 2) + (s.c[Z * i + T] ?? 0), P = Math.abs(
          3 * ((h[X * i + T] ?? 0) + (h[N * i + T] ?? 0)) - K
        ), I = Math.abs(
          3 * ((o[L * i + T] ?? 0) + (o[R * i + T] ?? 0)) - K
        );
        P > 23 && (B & 1) !== 0 && (f += P), I > 23 && (B & 1) !== 0 && (v += I), P > 42 && (B & 2) !== 0 && (l += P), I > 42 && (B & 2) !== 0 && (w += I), P > 42 && (B & 4) !== 0 && (m += P), I > 42 && (B & 4) !== 0 && (p += I);
      }
    }
    l < 500 && w < 500 && (m >= 500 || p >= 500) && Math.max(m, p) > 3 * Math.min(m, p) && (l = m, w = p);
    const g = Math.floor(f / 6 + 0.5), F = Math.floor(v / 6 + 0.5), E = Math.floor(l / 6 + 0.5), u = Math.floor(w / 6 + 0.5), k = Math.max(g, F) / Math.max(Math.min(g, F), 1), U = Math.max(E, u) / Math.max(Math.min(E, u), 1), G = Math.max(E, u) / Math.max(Math.max(g, F), 1);
    return (E >= 500 || u >= 500) && (E * 2 < u || u * 2 < E) || (E >= 1e3 || u >= 1e3) && (E * 3 < u * 2 || u * 3 < E * 2) || (E >= 2e3 || u >= 2e3) && (E * 5 < u * 4 || u * 5 < E * 4) || (E >= 4e3 || u >= 4e3) && U > k || G > 5e-3 && Math.max(E, u) > 150 && (E * 2 < u || u * 2 < E) ? E > u ? A : e : g > F ? A : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #j(e, A, t, s, i) {
    const r = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(t)
    ), a = i === 1 ? 1 : 0;
    for (let o = 0; o < r.length; o++) {
      const d = Math.min(s - 1, a + o * 2), f = r[o];
      if (f)
        for (let l = 0; l < t; l++)
          f[l] = Math.abs(
            (e[d * t + l] ?? 0) - (A[d * t + l] ?? 0)
          );
    }
    const n = new Uint8Array(t * s), h = i === 1 ? 3 : 2;
    for (let o = 1; o < r.length - 1; o++) {
      const d = h + (o - 1) * 2;
      if (d >= s) break;
      const f = r[o];
      if (f)
        for (let l = 1; l < t - 1; l++) {
          const m = f[l] ?? 0;
          if (m <= 3) continue;
          let v = 0;
          for (let u = l - 1; u <= l + 1; u++)
            v += (r[o - 1]?.[u] ?? 0) > 3 ? 1 : 0, v += (r[o]?.[u] ?? 0) > 3 ? 1 : 0, v += (r[o + 1]?.[u] ?? 0) > 3 ? 1 : 0;
          if (v <= 1) continue;
          const w = d * t + l;
          if (n[w] = 1, m <= 19) continue;
          v = 0;
          let p = !1, g = !1;
          for (let u = l - 1; u <= l + 1; u++)
            (r[o - 1]?.[u] ?? 0) > 19 && (v++, p = !0), (r[o]?.[u] ?? 0) > 19 && v++, (r[o + 1]?.[u] ?? 0) > 19 && (v++, g = !0);
          if (v <= 3) continue;
          if (p && g) {
            n[w] |= 2;
            continue;
          }
          let F = !1, E = !1;
          for (let u = Math.max(l - 4, 0); u < Math.min(l + 5, t); u++)
            o !== 1 && (r[o - 2]?.[u] ?? 0) > 19 && (F = !0), (r[o - 1]?.[u] ?? 0) > 19 && (p = !0), (r[o + 1]?.[u] ?? 0) > 19 && (g = !0), o !== r.length - 2 && (r[o + 2]?.[u] ?? 0) > 19 && (E = !0);
          p && (g || F) || g && (p || E) ? n[w] |= 2 : v > 5 && (n[w] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #F(e, A, t) {
    const s = new Uint8Array(A * t), i = (a, n) => e[Math.max(0, Math.min(t - 1, n)) * A + a] ?? 0;
    for (let a = 0; a < t; a++)
      for (let n = 0; n < A; n++) {
        const h = i(n, a), o = i(n, a === 0 ? 1 : a - 1), d = i(n, a === t - 1 ? t - 2 : a + 1), f = a < 2 ? i(n, a === 0 ? 2 : 3) : i(n, a - 2), l = a + 2 >= t ? i(n, a === t - 1 ? t - 3 : t - 4) : i(n, a + 2);
        (a === 0 ? Math.abs(h - d) > x.COMB_THRESHOLD : a === t - 1 ? Math.abs(h - o) > x.COMB_THRESHOLD : Math.abs(h - o) > x.COMB_THRESHOLD && Math.abs(h - d) > x.COMB_THRESHOLD) && Math.abs(
          4 * h - 3 * (o + d) + f + l
        ) > x.COMB_THRESHOLD * 6 && (s[a * A + n] = 255);
      }
    let r = 0;
    for (const a of [0, 8])
      for (const n of [0, 8])
        for (let h = a; h < t; h += 16)
          for (let o = n; o < A; o += 16) {
            let d = 0;
            for (let f = Math.max(1, h); f < Math.min(t - 1, h + 16); f++)
              for (let l = o; l < Math.min(A, o + 16); l++) {
                const m = f * A + l;
                s[m - A] === 255 && s[m] === 255 && s[m + A] === 255 && d++;
              }
            r = Math.max(r, d);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #J(e, A, t, s) {
    const i = x.DECIMATE_BLOCK / 2, r = Math.ceil(t / i), a = Math.ceil(s / i), n = new Float64Array(r * a), h = e.length / (t * s);
    for (let f = 0; f < s; f++) {
      const l = Math.floor(f / i);
      for (let m = 0; m < t; m++) {
        const v = Math.floor(m / i), w = l * r + v, p = (f * t + m) * h;
        if (h === 1) {
          n[w] = (n[w] ?? 0) + Math.abs((e[p] ?? 0) - (A[p] ?? 0));
          continue;
        }
        const g = Math.round(
          (e[p] ?? 0) * 0.2126 + (e[p + 1] ?? 0) * 0.7152 + (e[p + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (A[p] ?? 0) * 0.2126 + (A[p + 1] ?? 0) * 0.7152 + (A[p + 2] ?? 0) * 0.0722
        );
        if (n[w] = (n[w] ?? 0) + Math.abs(g - F), (m & 1) !== 0 || (f & 1) !== 0) continue;
        let E = 0, u = 0, k = 0, U = 0, G = 0, C = 0, b = 0;
        for (let N = f; N < Math.min(f + 2, s); N++)
          for (let L = m; L < Math.min(m + 2, t); L++) {
            const R = (N * t + L) * h;
            E += e[R] ?? 0, u += e[R + 1] ?? 0, k += e[R + 2] ?? 0, U += A[R] ?? 0, G += A[R + 1] ?? 0, C += A[R + 2] ?? 0, b++;
          }
        const W = Math.round(
          (-0.114572 * E - 0.385428 * u + 0.5 * k) / b
        ), Y = Math.round(
          (-0.114572 * U - 0.385428 * G + 0.5 * C) / b
        ), Z = Math.round(
          (0.5 * E - 0.454153 * u - 0.045847 * k) / b
        ), X = Math.round(
          (0.5 * U - 0.454153 * G - 0.045847 * C) / b
        );
        n[w] = (n[w] ?? 0) + Math.abs(W - Y) + Math.abs(Z - X);
      }
    }
    let o = -1;
    for (let f = 0; f < a - 1; f++)
      for (let l = 0; l < r - 1; l++)
        o = Math.max(
          o,
          (n[f * r + l] ?? 0) + (n[f * r + l + 1] ?? 0) + (n[(f + 1) * r + l] ?? 0) + (n[(f + 1) * r + l + 1] ?? 0)
        );
    let d = 0;
    for (const f of n) d += f;
    return { maxBlockDifference: o, totalDifference: d };
  }
}
const he = 0.5, D = 3, S = 5, ce = 80, $ = 1e3, le = 4, q = 200, fe = 0.25, ue = 0.2, de = 1e3 / 60, me = 0.02, pe = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, we = `#version 300 es
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
function Me() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class Fe extends EventTarget {
  canvas;
  #e;
  #t;
  #b;
  #n;
  /** The program that copies a filtered picture onto the canvas. */
  #u;
  #o;
  #y;
  /** The reduced pass that reads previous, current and next luma together. */
  #v = null;
  #L = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #M = null;
  #j = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #F = null;
  #J = null;
  #R = null;
  #E = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #a = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #S = S - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #h = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #A = [];
  /** The rAF loop that puts them up, which is all that draws on the canvas. */
  #C = null;
  #V = 0;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #X = de;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #P = null;
  #ne;
  #d;
  #m;
  #s;
  #K;
  #z;
  #De;
  #O = "video";
  #W = "c";
  #oe = 0;
  #ae = !0;
  #he = new x(y, M);
  #ce = 1 / 0;
  #le = 1 / 0;
  #T = 0;
  #I = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #c = 0;
  /** Where the media timeline was last pinned to the wall clock, and when. */
  #fe = 0;
  #ue = 0;
  #D = !1;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #l = 0;
  #p = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #f = D - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #i = 0;
  #$ = 0;
  #_ = null;
  #w = !1;
  #de = !1;
  #r = null;
  #Y = [];
  #B = !1;
  #xe;
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #x = { filtered: 0, missed: 0, degraded: 0, discontinuities: 0, late: 0 };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #k = 0;
  #q = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #me = 0;
  #Z = 0;
  #U = 0;
  constructor(e, A = {}) {
    super(), this.#e = e, this.#d = A.topFieldFirst ?? !0, this.#m = A.doubleRate ?? !1, this.#s = A.autoFilm ?? !1, this.#K = Math.max(
      0,
      A.filmCombThreshold ?? ce
    ), this.#z = Math.max(0, A.bufferFields ?? 1), this.#De = A.spatialCheck ?? !0, this.#xe = A.onStats, this.canvas = document.createElement("canvas"), this.canvas.style.cssText = "position:absolute;pointer-events:none;visibility:hidden";
    const t = this.canvas.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!t) throw new Error("this browser has no WebGL2");
    this.#t = t, this.#b = H(t, re);
    const s = this.#b;
    this.#n = Object.fromEntries(
      Object.entries(se).map(([i, r]) => [
        i,
        t.getUniformLocation(s, r)
      ])
    ), this.#u = H(t, we), this.#o = t.getUniformLocation(this.#u, "uField"), this.#y = t.getUniformLocation(this.#u, "uFlip"), this.#s && this.#Te(), this.canvas.addEventListener("webglcontextlost", this.#Ie), this.#ne = new ResizeObserver(() => this.#re()), e.addEventListener("emptied", this.#Le), e.addEventListener("resize", this.#Be), e.addEventListener("pause", this.#H), e.addEventListener("ended", this.#H), e.addEventListener("seeked", this.#H);
  }
  get running() {
    return this.#w && (this.#r?.interlaced ?? !0);
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#de;
  }
  set enabled(e) {
    this.#de = e, this.#pe();
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const A = this.#r?.interlaced !== e?.interlaced || this.#r?.topFieldFirst !== e?.topFieldFirst;
    this.#r = e, e && (this.#d = e.topFieldFirst), A && (this.#i = 0, this.#g(), this.#h = null, this.canvas.style.visibility = "hidden"), this.#pe();
  }
  get scan() {
    return this.#r;
  }
  set videoTimeline(e) {
    this.#Y = e, e.length === 0 && (this.#r = null), this.#pe();
  }
  get videoTimeline() {
    return this.#Y;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#P ?? this.#e;
  }
  /** Whether the top field of a frame is the one captured first. */
  get topFieldFirst() {
    return this.#d;
  }
  set topFieldFirst(e) {
    e !== this.#d && (this.#d = e, this.#i = 0, this.#g(), this.#h = null, this.canvas.style.visibility = "hidden");
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#m;
  }
  set doubleRate(e) {
    e !== this.#m && (this.#m = e, this.#A.length = 0, this.#D = !1, e ? (this.#l > 0 && this.#ve(), (this.#r?.interlaced ?? !0) && this.#Ae()) : this.#s || (this.#ie(), this.#N()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#s;
  }
  set autoFilm(e) {
    e !== this.#s && (this.#s = e, this.#g(), e ? (this.#Te(), this.#l > 0 && (this.#Ce(), this.#ve()), (this.#r?.interlaced ?? !0) && this.#Ae()) : (this.#Ee(), this.#m || (this.#ie(), this.#N())));
  }
  /** The combed-pixel boundary between clean field matches and field motion. */
  get filmCombThreshold() {
    return this.#K;
  }
  set filmCombThreshold(e) {
    this.#K = Math.max(0, e), this.#s && this.#g();
  }
  /** How many field intervals of slack the field schedule is held back by. */
  get bufferFields() {
    return this.#z;
  }
  set bufferFields(e) {
    this.#z = Math.max(0, e);
  }
  #pe() {
    this.#de && (this.#Y.length > 0 || (this.#r?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  start() {
    this.#w || this.#B || (this.#w = !0, this.#Pe(), this.#We(), this.#ee(), (this.#r?.interlaced ?? !0) && this.#Ae());
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#w && (this.#w = !1, this.#_ !== null && this.#e.cancelVideoFrameCallback(this.#_), this.#_ = null, this.#ie(), this.#i = 0, this.#D = !1, this.#h = null, this.canvas.style.visibility = "hidden");
  }
  /**
   * Copy the picture currently represented by the deinterlacer.
   * The WebGL drawing buffer is deliberately not preserved between browser
   * composites. Repeating the exact draw path of the presented picture before
   * `createImageBitmap` makes a snapshot reliable without imposing the
   * permanent cost of `preserveDrawingBuffer` on ordinary playback.
   * The video's natural dimensions apply its sample aspect ratio to the coded
   * canvas, giving the bitmap the same display aspect ratio as the element.
   */
  capture() {
    const e = this.#h;
    if (!this.#w || this.#B || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#we(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#G(e.flush, e.second, null, !1) : this.#te(null, !1);
    const A = this.#e.videoWidth, t = this.#e.videoHeight;
    return A > 0 && t > 0 && (A !== this.canvas.width || t !== this.canvas.height) ? createImageBitmap(this.canvas, {
      resizeWidth: A,
      resizeHeight: t,
      resizeQuality: "high"
    }) : createImageBitmap(this.canvas);
  }
  destroy() {
    this.stop(), this.canvas.removeEventListener("webglcontextlost", this.#Ie), this.#e.removeEventListener("emptied", this.#Le), this.#e.removeEventListener("resize", this.#Be), this.#e.removeEventListener("pause", this.#H), this.#e.removeEventListener("ended", this.#H), this.#e.removeEventListener("seeked", this.#H), this.#Ye();
    for (const e of this.#E) this.#t.deleteTexture(e);
    this.#E = [], this.#N(), this.#Ee(), this.#t.deleteProgram(this.#b), this.#t.deleteProgram(this.#u), this.#v && this.#t.deleteProgram(this.#v), this.#M && this.#t.deleteProgram(this.#M), this.#F && this.#t.deleteProgram(this.#F), this.#t.getExtension("WEBGL_lose_context")?.loseContext();
  }
  addEventListener(e, A, t) {
    super.addEventListener(e, A, t);
  }
  removeEventListener(e, A, t) {
    super.removeEventListener(e, A, t);
  }
  #ee() {
    !this.#w || this.#_ !== null || (this.#_ = this.#e.requestVideoFrameCallback(this.#_e));
  }
  #_e = (e, A) => {
    if (this.#_ = null, !(!this.#w || this.#B)) {
      if (this.#ke(A.mediaTime), A.width > 0 && A.height > 0) {
        if ((this.#l === 0 || this.#p === 0) && this.#Se(A.width, A.height), this.#r && !this.#r.interlaced) {
          this.#Xe(), this.#ee();
          return;
        }
        const t = A.mediaTime - this.#$, s = t < 0 || t > he;
        s && (this.#i = 0, this.#x.discontinuities++, this.#A.length = 0, this.#D = !1, this.#g());
        const i = this.#s && this.#k !== 0 && A.presentedFrames - this.#k > 1;
        if (this.#ze(A.presentedFrames, s), !s && i && (this.#i = 0, this.#g()), this.#i > 0 && A.mediaTime === this.#$) {
          this.#ee();
          return;
        }
        !s && t > 0 && this.#Ue(t), this.#$ = A.mediaTime;
        const r = performance.now();
        if (r - this.#me > $ && (this.#q = r, this.#Z = 0, this.#U = 0), this.#me = r, this.#Re(), !(this.#s && this.#i === D && this.#Ge() && this.#a.length === S)) if (this.#s && !this.#ae && this.#i === D && this.#O === "film")
          if (this.#ge()) {
            const n = this.#be(A.mediaTime, A.expectedDisplayTime) + this.#c * (1 + this.#z / 2), h = this.#c / 2;
            (this.#T === 0 || this.#T < n - h || this.#T > n + this.#c + h) && (this.#T = n), this.#Ne(this.#T), this.#T += this.#c * 5 / 4;
          } else {
            const n = this.#Q(), h = n === null ? void 0 : this.#a[n];
            n !== null && h ? (this.#S = n, this.#te(h.framebuffer), this.#se(n)) : this.#te(null);
          }
        else if (this.#m && this.#ge()) {
          const n = this.#c / 2, h = this.#be(A.mediaTime, A.expectedDisplayTime) + (1 + this.#z) * n;
          this.#ye(!1, h), this.#ye(!0, h + n);
        } else {
          const n = this.#s ? this.#Q() : null, h = n === null ? void 0 : this.#a[n];
          n !== null && h ? (this.#S = n, this.#G(!1, !1, h.framebuffer), this.#se(n)) : this.#G(!1, !1, null);
        }
        this.#U += performance.now() - r, this.#Z++, this.#Oe(r);
      }
      this.#ee();
    }
  };
  #ke(e) {
    let A;
    for (let s = this.#Y.length - 1; s >= 0; s--) {
      const i = this.#Y[s];
      if (i.start <= e + 1e-6) {
        A = i;
        break;
      }
    }
    A?.codedSize && (A.codedSize.width !== this.#l || A.codedSize.height !== this.#p) && this.#Se(A.codedSize.width, A.codedSize.height);
    const t = A?.scan;
    !t || this.#r?.interlaced === t.interlaced && this.#r.topFieldFirst === t.topFieldFirst || (this.#r = t, this.#d = t.topFieldFirst, this.#i = 0, this.#A.length = 0, this.#D = !1, this.#g(), t.interlaced ? (this.#m || this.#s) && this.#Ae() : this.#ie());
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #ge() {
    return (this.#m || this.#s) && this.#c > 0 && this.#a.length === S;
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
  #Ue(e) {
    const A = e * 1e3 / (this.#e.playbackRate || 1), t = this.#c > 0 ? Math.max(1, Math.round(A / this.#c)) : 1, s = A / t;
    s < le || s > q || (this.#c = this.#c > 0 ? this.#c + (s - this.#c) * fe : s);
  }
  /**
   * When this frame reaches the screen, from a clock that is pulled towards
   * what each frame says rather than set by it.
   *
   * `expectedDisplayTime` is an estimate, and it moves about by a refresh or
   * so either way even while playback is perfectly steady. Hanging two fields
   * off it directly passes that movement to the screen, which is exactly the
   * unevenness a picture for every field is meant to remove; running a clock
   * of the media timeline and correcting a fifth of the error each frame
   * keeps the fields evenly spaced while still following the element. An
   * error of more than a whole frame is not drift -- the element is
   * presenting from somewhere else, or at a rate it was not at before -- and
   * the clock goes straight there, taking the fields timed by the old one
   * with it.
   */
  #be(e, A) {
    if (!this.#D)
      return this.#D = !0, this.#fe = e, this.#ue = A, A;
    const t = this.#e.playbackRate || 1, s = this.#ue + (e - this.#fe) * 1e3 / t, i = A - s;
    let r;
    return Math.abs(i) > this.#c ? (r = A, this.#x.late += this.#A.length, this.#A.length = 0) : r = s + i * ue, this.#fe = e, this.#ue = r, r;
  }
  /** Build the optional film passes only for callers that enable them. */
  #Te() {
    if (this.#v && this.#M && this.#F) return;
    const e = this.#t, A = H(e, ne), t = H(e, oe), s = H(e, ae);
    this.#v = A, this.#L = Object.fromEntries(
      Object.entries(Q).filter(([i]) => i !== "match" && i !== "topFieldFirst").map(([i, r]) => [i, e.getUniformLocation(A, r)])
    ), this.#M = t, this.#j = Object.fromEntries(
      Object.entries(Q).map(([i, r]) => [
        i,
        e.getUniformLocation(t, r)
      ])
    ), this.#F = s, this.#J = Object.fromEntries(
      Object.entries(Q).map(([i, r]) => [
        i,
        e.getUniformLocation(s, r)
      ])
    );
  }
  /**
   * Run FFmpeg's fieldmatch and mixed decimate decisions on reduced luma.
   * Full decoded frames remain in GPU textures, while the first readback packs
   * the previous, current and next luma proxies into RGB. The CPU stage is a
   * direct port of the 8-bit FFmpeg arithmetic, and a second readback supplies
   * the selected RGB weave to its chroma-sensitive decimate metric.
   */
  #Ge() {
    const e = this.#R, A = this.#v, t = this.#L, s = this.#F, i = this.#J;
    if (!e || !A || !t || !s || !i)
      return !1;
    const r = this.#t, a = this.#f, n = (this.#f + D - 1) % D, h = (this.#f + 1) % D;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(A);
    for (const [w, p] of [h, n, a].entries())
      r.activeTexture(r.TEXTURE0 + w), r.bindTexture(r.TEXTURE_2D, this.#E[p] ?? null);
    r.uniform1i(t.prev, 0), r.uniform1i(t.cur, 1), r.uniform1i(t.next, 2), r.uniform2i(t.size, this.#l, this.#p), r.viewport(0, 0, y, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      y,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const o = new Uint8Array(
      y * M
    ), d = new Uint8Array(
      y * M
    ), f = new Uint8Array(y * M);
    for (let w = 0; w < o.length; w++) {
      const p = w * 4;
      o[w] = e.pixels[p] ?? 0, d[w] = e.pixels[p + 1] ?? 0, f[w] = e.pixels[p + 2] ?? 0;
    }
    const l = this.#he.fieldMatch(
      o,
      d,
      f,
      this.#d,
      this.#K
    );
    r.useProgram(s), r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#l, this.#p), r.uniform1i(i.topFieldFirst, this.#d ? 1 : 0), r.uniform1i(
      i.match,
      l.match === "p" ? 0 : l.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      y,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const m = this.#he.decimate(e.pixels);
    this.#W = l.match, this.#oe = l.combScore, this.#ae = l.isCombed, this.#ce = m.lowestCycleDifference, this.#le = m.runnerUpCycleDifference;
    const v = m.dropIndex !== null && !l.isCombed;
    return (v ? "film" : "video") !== this.#O && (this.#O = v ? "film" : "video", this.#T = 0), m.shouldDrop && !l.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Ne(e) {
    const A = this.#Q();
    if (A === null) return;
    const t = this.#a[A];
    t && (this.#S = A, this.#te(t.framebuffer), this.#Me(A, e));
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #te(e, A = !0) {
    const t = this.#M, s = this.#j;
    if (!t || !s) return;
    const i = this.#t, r = this.#f, a = (this.#f + D - 1) % D, n = (this.#f + 1) % D;
    i.bindFramebuffer(i.FRAMEBUFFER, e), i.useProgram(t);
    for (const [h, o] of [n, a, r].entries())
      i.activeTexture(i.TEXTURE0 + h), i.bindTexture(i.TEXTURE_2D, this.#E[o] ?? null);
    i.uniform1i(s.prev, 0), i.uniform1i(s.cur, 1), i.uniform1i(s.next, 2), i.uniform2i(s.size, this.#l, this.#p), i.uniform1i(s.topFieldFirst, this.#d ? 1 : 0), i.uniform1i(
      s.match,
      this.#W === "p" ? 0 : this.#W === "c" ? 1 : 2
    ), i.viewport(0, 0, this.#l, this.#p), i.drawArrays(i.TRIANGLES, 0, 3), e === null && (this.#h = { kind: "film" }, this.canvas.style.visibility = "visible", A && this.#I++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #ye(e, A) {
    const t = this.#Q();
    if (t === null) return;
    const s = this.#a[t];
    s && (this.#S = t, this.#G(!1, e, s.framebuffer), this.#Me(t, A));
  }
  /** Select an output whose pixels are not still represented by the canvas. */
  #Q() {
    const e = this.#h?.kind === "texture" ? this.#h.texture : null;
    for (let A = 1; A <= S; A++) {
      const t = (this.#S + A) % S, s = this.#a[t];
      if (s && s.texture !== e) return t;
    }
    return null;
  }
  /** Add a completed picture to the shared film and field-rate schedule. */
  #Me(e, A) {
    const t = this.#A.findIndex((i) => i.slot === e);
    t !== -1 && (this.#A.splice(t, 1), this.#x.late++);
    const s = this.#A.findIndex((i) => i.at > A);
    s === -1 ? this.#A.push({ slot: e, at: A }) : this.#A.splice(s, 0, { slot: e, at: A });
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #Ae() {
    this.#C === null && (!this.#w || this.#B || !this.#m && !this.#s || (this.#V = 0, this.#C = requestAnimationFrame(this.#Fe)));
  }
  #ie() {
    this.#C !== null && cancelAnimationFrame(this.#C), this.#C = null, this.#A.length = 0;
  }
  #Fe = (e) => {
    if (this.#C = null, !(!this.#w || this.#B || !this.#m && !this.#s)) {
      if (this.#V > 0) {
        const A = e - this.#V;
        A >= 1 && A <= q && (this.#X = A < this.#X ? A : this.#X + (A - this.#X) * me);
      }
      this.#V = e, this.#He(e), this.#C = requestAnimationFrame(this.#Fe);
    }
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
  #He(e) {
    const A = e + this.#X * 1.5;
    if ((this.#A[0]?.at ?? 1 / 0) > A) return;
    let t = this.#A.shift();
    for (; (this.#A[0]?.at ?? 1 / 0) <= A; )
      this.#x.late++, t = this.#A.shift();
    if (!t) return;
    const s = performance.now();
    this.#se(t.slot), this.#U += performance.now() - s;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #se(e) {
    const A = this.#a[e];
    A && this.#we(A.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Xe() {
    this.#Re();
    const e = this.#E[this.#f];
    e && this.#we(e, !0), this.#i = 0;
  }
  #we(e, A = !1, t = !0) {
    const s = this.#t;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#u), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#o, 0), s.uniform1i(this.#y, A ? 1 : 0), s.viewport(0, 0, this.#l, this.#p), s.drawArrays(s.TRIANGLES, 0, 3), this.#h = { kind: "texture", texture: e, flip: A }, this.canvas.style.visibility = "visible", t && this.#I++;
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
  #ze(e, A) {
    this.#k !== 0 && !A && (this.#x.missed += Math.max(0, e - this.#k - 1)), this.#k = e;
  }
  #Oe(e) {
    const A = e - this.#q;
    if (A < $) return;
    const t = this.#Z, s = {
      ...this.#x,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: t * 1e3 / A,
      frameMs: t === 0 ? 0 : this.#U / t,
      mode: this.#O,
      match: this.#W,
      combScore: this.#oe,
      outputFps: this.#I * 1e3 / A,
      duplicateScore: this.#ce,
      duplicateRunnerUp: this.#le
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#xe?.(s), this.#q = e, this.#Z = 0, this.#U = 0, this.#I = 0;
  }
  /** Take the newest frame into the ring. */
  #Re() {
    const e = this.#t;
    this.#f = (this.#f + 1) % D, e.bindTexture(e.TEXTURE_2D, this.#E[this.#f] ?? null), e.texSubImage2D(
      e.TEXTURE_2D,
      0,
      0,
      0,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#e
    ), this.#i = Math.min(this.#i + 1, D);
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
  #G(e, A, t, s = !0) {
    if (this.#i === 0 || this.#B) return;
    s && (this.#i === D && !e ? this.#x.filtered++ : this.#x.degraded++);
    const i = this.#t, r = this.#f, a = (this.#f + D - 1) % D, n = (this.#f + 1) % D;
    let h, o, d;
    this.#i === 1 ? h = o = d = r : e ? (h = a, o = d = r) : this.#i === 2 ? (h = o = a, d = r) : (h = n, o = a, d = r), i.bindFramebuffer(i.FRAMEBUFFER, t), i.useProgram(this.#b);
    for (const [l, m] of [h, o, d].entries())
      i.activeTexture(i.TEXTURE0 + l), i.bindTexture(i.TEXTURE_2D, this.#E[m] ?? null);
    i.uniform1i(this.#n.prev, 0), i.uniform1i(this.#n.cur, 1), i.uniform1i(this.#n.next, 2), i.uniform2i(this.#n.size, this.#l, this.#p);
    const f = this.#d ? 0 : 1;
    i.uniform1i(this.#n.parity, A ? 1 - f : f), i.uniform1i(this.#n.tff, this.#d ? 1 : 0), i.uniform1i(this.#n.spatialCheck, this.#De ? 1 : 0), i.viewport(0, 0, this.#l, this.#p), i.drawArrays(i.TRIANGLES, 0, 3), t === null && (this.#h = { kind: "yadif", flush: e, second: A }, this.canvas.style.visibility = "visible", s && this.#I++);
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
  #re() {
    if (!this.#P) return;
    const e = this.#e, A = e.videoWidth, t = e.videoHeight;
    if (A === 0 || t === 0) return;
    const s = Math.min(
      e.offsetWidth / A,
      e.offsetHeight / t
    ), i = A * s, r = t * s;
    this.canvas.style.left = `${e.offsetLeft + (e.offsetWidth - i) / 2}px`, this.canvas.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.canvas.style.width = `${i}px`, this.canvas.style.height = `${r}px`;
  }
  #Se(e, A) {
    const t = this.#t;
    this.canvas.width = e, this.canvas.height = A, this.#l = e, this.#p = A, this.#h = null, this.#i = 0, this.#g(), this.#re();
    for (const s of this.#E) t.deleteTexture(s);
    this.#E = [];
    for (let s = 0; s < D; s++) {
      const i = t.createTexture();
      t.bindTexture(t.TEXTURE_2D, i), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MIN_FILTER, t.NEAREST), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MAG_FILTER, t.NEAREST), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_S, t.CLAMP_TO_EDGE), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_T, t.CLAMP_TO_EDGE), t.texImage2D(
        t.TEXTURE_2D,
        0,
        t.RGBA,
        e,
        A,
        0,
        t.RGBA,
        t.UNSIGNED_BYTE,
        null
      ), this.#E.push(i);
    }
    this.#N(), this.#Ee(), this.#s && this.#Ce(), (this.#m || this.#s) && this.#ve();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Ce() {
    if (this.#R) return;
    const e = this.#t, A = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, A), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      y,
      M,
      0,
      e.RGBA,
      e.UNSIGNED_BYTE,
      null
    );
    const t = e.createFramebuffer();
    e.bindFramebuffer(e.FRAMEBUFFER, t), e.framebufferTexture2D(
      e.FRAMEBUFFER,
      e.COLOR_ATTACHMENT0,
      e.TEXTURE_2D,
      A,
      0
    );
    const s = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
    if (e.bindFramebuffer(e.FRAMEBUFFER, null), !s) {
      e.deleteFramebuffer(t), e.deleteTexture(A);
      return;
    }
    this.#R = {
      texture: A,
      framebuffer: t,
      pixels: new Uint8Array(y * M * 4)
    };
  }
  #Ee() {
    this.#R && (this.#t.deleteFramebuffer(this.#R.framebuffer), this.#t.deleteTexture(this.#R.texture), this.#R = null);
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
  #ve() {
    const e = this.#t;
    if (!(this.#a.length === S || this.#l === 0)) {
      this.#N();
      for (let A = 0; A < S; A++) {
        const t = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#l,
          this.#p,
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
          t,
          0
        );
        const i = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
        if (e.bindFramebuffer(e.FRAMEBUFFER, null), !i) {
          e.deleteFramebuffer(s), e.deleteTexture(t), this.#N();
          return;
        }
        this.#a.push({ texture: t, framebuffer: s });
      }
      this.#S = S - 1;
    }
  }
  #N() {
    const e = this.#t, A = this.#h?.kind === "texture" ? this.#h.texture : null;
    this.#a.some((t) => t.texture === A) && (this.#h = null);
    for (const { texture: t, framebuffer: s } of this.#a)
      e.deleteFramebuffer(s), e.deleteTexture(t);
    this.#a = [], this.#A.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #We() {
    if (this.#P) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const A = document.createElement("div");
    A.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(A, this.#e), A.appendChild(this.#e), A.appendChild(this.canvas), this.#P = A, this.#ne.observe(this.#e), this.#re();
  }
  #Ye() {
    const e = this.#P;
    this.#P = null, this.#ne.disconnect(), this.canvas.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #Be = () => this.#re();
  #Le = () => {
    this.#i = 0, this.#$ = 0, this.#A.length = 0, this.#D = !1, this.#c = 0, this.#g(), this.#Pe(), this.#h = null, this.canvas.style.visibility = "hidden";
  };
  #Pe() {
    this.#x = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0
    }, this.#k = 0, this.#q = 0, this.#me = 0, this.#Z = 0, this.#U = 0, this.#I = 0;
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #g() {
    this.#A.length = 0, this.#D = !1, this.#O = "video", this.#W = "c", this.#oe = 0, this.#ae = !0, this.#T = 0, this.#he.reset(), this.#ce = 1 / 0, this.#le = 1 / 0;
  }
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #H = () => {
    if (this.#A.length = 0, this.#D = !1, !this.#w || this.#i === 0) return;
    const e = this.#Q(), A = e === null ? void 0 : this.#a[e];
    e !== null && A ? (this.#S = e, this.#G(!0, !1, A.framebuffer), this.#se(e)) : this.#G(!0, !1, null);
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Ie = (e) => {
    e.preventDefault(), this.#B = !0, this.stop();
  };
}
function H(c, e) {
  const A = c.createProgram(), t = ee(c, c.VERTEX_SHADER, pe), s = ee(c, c.FRAGMENT_SHADER, e);
  if (c.attachShader(A, t), c.attachShader(A, s), c.linkProgram(A), c.deleteShader(t), c.deleteShader(s), !c.getProgramParameter(A, c.LINK_STATUS)) {
    const i = c.getProgramInfoLog(A);
    throw c.deleteProgram(A), new Error(
      `the deinterlacer failed to link: ${i ?? "no reason given"}`
    );
  }
  return A;
}
function ee(c, e, A) {
  const t = c.createShader(e);
  if (!t) throw new Error("the deinterlacer could not create a shader");
  if (c.shaderSource(t, A), c.compileShader(t), !c.getShaderParameter(t, c.COMPILE_STATUS)) {
    const s = c.getShaderInfoLog(t);
    throw c.deleteShader(t), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return t;
}
const te = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Ee = 0.5, ve = 3e3, Ae = 0.1, _ = 16, ie = 'video/mp4; codecs="avc1.640029"';
let J = null;
function De(c = {}) {
  return J ??= xe(c), J;
}
async function Re(c = {}) {
  return (await De(c)).deinterlaces;
}
function Se() {
  J = null;
}
async function xe(c) {
  const e = c.tolerance ?? Ee, A = c.timeoutMs ?? ve, t = performance.now(), s = (a) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - t,
    error: a instanceof Error ? a.message : String(a)
  });
  if (typeof document > "u")
    return s(new Error("there is no document to decode in"));
  const i = document.createElement("video");
  i.muted = !0, i.defaultMuted = !0, i.playsInline = !0, i.preload = "auto";
  let r = null;
  try {
    r = be(i, A);
    const a = O(z(i, "loadeddata"), A), n = i.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await a, await Te(i, A, await n), i.videoWidth === 0 || i.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const h = ye(i);
    return {
      deinterlaces: h < 1 - e,
      survives: h,
      tookMs: performance.now() - t
    };
  } catch (a) {
    return s(a);
  } finally {
    i.pause(), i.removeAttribute("src"), i.replaceChildren(), i.load(), r && URL.revokeObjectURL(r.url);
  }
}
const j = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, ge = typeof MediaSource > "u";
function be(c, e) {
  if (!j || !j.isTypeSupported(ie))
    throw new Error("the probe clip needs Media Source Extensions");
  const A = te.indexOf(","), t = atob(te.slice(A + 1)), s = new Uint8Array(t.length);
  for (let n = 0; n < t.length; n++) s[n] = t.charCodeAt(n);
  const i = new j(), r = URL.createObjectURL(i);
  if (ge) {
    c.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, c.append(n), c.load();
  } else
    c.src = r;
  const a = (async () => {
    await O(z(i, "sourceopen"), e);
    const n = i.addSourceBuffer(ie), h = O(z(n, "updateend"), e);
    n.appendBuffer(s), await h, i.endOfStream();
  })();
  return { url: r, ready: a };
}
async function Te(c, e, A) {
  if (A) {
    const t = performance.now();
    for (; c.currentTime < Ae && performance.now() - t < e; )
      await new Promise((s) => requestAnimationFrame(s));
    c.pause();
  } else
    c.currentTime = Ae, await O(z(c, "seeked"), e);
}
function ye(c) {
  const e = c.videoHeight, A = document.createElement("canvas");
  A.width = _, A.height = e;
  const t = A.getContext("2d", { willReadFrequently: !0 });
  if (!t) throw new Error("there is no 2d context to read the clip with");
  t.imageSmoothingEnabled = !1, t.drawImage(c, 0, 0, _, e);
  const s = t.getImageData(0, 0, _, e).data, i = (o) => {
    let d = 0;
    for (let f = 0; f < _; f++)
      d += s[(o * _ + f) * 4 + 1] ?? 0;
    return d / _;
  };
  let r = 0;
  const a = 2, n = e - 3;
  let h = i(a);
  for (let o = a + 1; o <= n; o++) {
    const d = i(o);
    r += Math.abs(d - h), h = d;
  }
  return r / (n - a) / 255;
}
function z(c, e) {
  return new Promise((A, t) => {
    c.addEventListener(e, () => A(), { once: !0 }), c.addEventListener(
      "error",
      () => {
        const s = c instanceof HTMLMediaElement ? c.error : null, i = s ? ` (MediaError ${s.code}${s.message ? `: ${s.message}` : ""})` : "";
        t(new Error(`the probe clip ${e} failed${i}`));
      },
      { once: !0 }
    );
  });
}
function O(c, e) {
  return Promise.race([
    c,
    new Promise(
      (A, t) => setTimeout(
        () => t(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
export {
  Fe as Deinterlacer,
  ne as FILM_ANALYSIS_FRAGMENT_SHADER,
  ae as FILM_SAMPLE_FRAGMENT_SHADER,
  Q as FILM_UNIFORMS,
  oe as FILM_WEAVE_FRAGMENT_SHADER,
  re as YADIF_FRAGMENT_SHADER,
  se as YADIF_UNIFORMS,
  Re as decoderDeinterlaces,
  Se as forgetDecoderProbe,
  De as probeDecoder,
  Me as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
