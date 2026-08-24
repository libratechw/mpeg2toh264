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
`, j = {
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
  #t;
  #e;
  #x;
  #n = 0;
  #l = null;
  #o = [];
  #T = null;
  #w = 1 / 0;
  #S = 1 / 0;
  constructor(e, A) {
    this.#t = e, this.#e = A, this.#x = 255 * x.DECIMATE_BLOCK ** 2 * x.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the exact
   * matching arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, A, t, i, s = x.COMBED_PIXEL_LIMIT) {
    const r = i ? 1 : 0, a = { p: e, c: A, n: t };
    let n = this.#y("c", "p", r, a);
    const h = /* @__PURE__ */ new Map(), o = (D) => {
      const w = h.get(D);
      if (w !== void 0) return w;
      const p = x.#M(
        this.weave(e, A, t, D, i),
        this.#t,
        this.#e
      );
      return h.set(D, p), p;
    }, d = o(n), f = o("n");
    (f * 3 < d || f * 2 < d && d > s) && Math.abs(f - d) >= 30 && f < s && (n = "n");
    const l = o(n), m = l >= s;
    return m && (n = "c"), {
      match: n,
      combScore: l,
      isCombed: m,
      luma: this.weave(e, A, t, n, i)
    };
  }
  /** Apply `decimate=cycle=5:mixed=1` metrics without delaying live audio. */
  decimate(e) {
    const A = this.#n, t = this.#T ? x.#Z(
      this.#T,
      e,
      this.#t,
      this.#e
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#o.push(t);
    const i = this.#l === A, s = i && t.maxBlockDifference < this.#x;
    i && !s && (this.#l = null);
    const r = this.#l;
    this.#T = e.slice(), this.#n++;
    let a = this.#l;
    if (this.#n === x.CYCLE) {
      let n = 0, h = null;
      for (let o = 1; o < this.#o.length; o++)
        (this.#o[o]?.maxBlockDifference ?? 1 / 0) < (this.#o[n]?.maxBlockDifference ?? 1 / 0) ? (h = n, n = o) : (h === null || (this.#o[o]?.maxBlockDifference ?? 1 / 0) < (this.#o[h]?.maxBlockDifference ?? 1 / 0)) && (h = o);
      this.#w = this.#o[n]?.maxBlockDifference ?? 1 / 0, this.#S = h === null ? 1 / 0 : this.#o[h]?.maxBlockDifference ?? 1 / 0, a = (this.#o[n]?.maxBlockDifference ?? 1 / 0) < this.#x ? n : null, this.#l = a, this.#o = [], this.#n = 0;
    }
    return {
      cycleIndex: A,
      maxBlockDifference: t.maxBlockDifference,
      totalDifference: t.totalDifference,
      shouldDrop: s,
      dropIndex: r,
      nextDropIndex: a,
      lowestCycleDifference: this.#w,
      runnerUpCycleDifference: this.#S
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, A, t, i, s) {
    if (i === "c") return A.slice();
    const r = A.slice(), a = i === "p" ? e : t, n = r.length / this.#e, h = s ? 1 : 0;
    for (let o = h; o < this.#e; o += 2)
      r.set(
        a.subarray(o * n, (o + 1) * n),
        o * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#n = 0, this.#l = null, this.#o = [], this.#T = null, this.#w = 1 / 0, this.#S = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #y(e, A, t, i) {
    const s = this.#t, r = this.#e, a = 2 - t, n = 2 - t, h = i[e], o = i[A], d = x.#Y(
      h,
      o,
      s,
      r,
      t
    );
    let f = 0, l = 0, m = 0, D = 0, w = 0, p = 0;
    for (let S = 2; S < r - 2; S += 2) {
      const b = (S - 2) / 2, W = a - 1 + b * 2, Y = a + 1 + b * 2, Z = a + 3 + b * 2, X = a + b * 2, N = X + 2, L = n + b * 2, R = L + 2, V = a + b * 2;
      for (let T = 8; T < s - 8; T++) {
        const C = (d[V * s + T] ?? 0) | (d[(V + 2) * s + T] ?? 0);
        if (C === 0) continue;
        const K = (i.c[W * s + T] ?? 0) + ((i.c[Y * s + T] ?? 0) << 2) + (i.c[Z * s + T] ?? 0), P = Math.abs(
          3 * ((h[X * s + T] ?? 0) + (h[N * s + T] ?? 0)) - K
        ), I = Math.abs(
          3 * ((o[L * s + T] ?? 0) + (o[R * s + T] ?? 0)) - K
        );
        P > 23 && (C & 1) !== 0 && (f += P), I > 23 && (C & 1) !== 0 && (D += I), P > 42 && (C & 2) !== 0 && (l += P), I > 42 && (C & 2) !== 0 && (w += I), P > 42 && (C & 4) !== 0 && (m += P), I > 42 && (C & 4) !== 0 && (p += I);
      }
    }
    l < 500 && w < 500 && (m >= 500 || p >= 500) && Math.max(m, p) > 3 * Math.min(m, p) && (l = m, w = p);
    const g = Math.floor(f / 6 + 0.5), F = Math.floor(D / 6 + 0.5), E = Math.floor(l / 6 + 0.5), u = Math.floor(w / 6 + 0.5), k = Math.max(g, F) / Math.max(Math.min(g, F), 1), U = Math.max(E, u) / Math.max(Math.min(E, u), 1), G = Math.max(E, u) / Math.max(Math.max(g, F), 1);
    return (E >= 500 || u >= 500) && (E * 2 < u || u * 2 < E) || (E >= 1e3 || u >= 1e3) && (E * 3 < u * 2 || u * 3 < E * 2) || (E >= 2e3 || u >= 2e3) && (E * 5 < u * 4 || u * 5 < E * 4) || (E >= 4e3 || u >= 4e3) && U > k || G > 5e-3 && Math.max(E, u) > 150 && (E * 2 < u || u * 2 < E) ? E > u ? A : e : g > F ? A : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #Y(e, A, t, i, s) {
    const r = Array.from(
      { length: Math.ceil(i / 2) },
      () => new Uint8Array(t)
    ), a = s === 1 ? 1 : 0;
    for (let o = 0; o < r.length; o++) {
      const d = Math.min(i - 1, a + o * 2), f = r[o];
      if (f)
        for (let l = 0; l < t; l++)
          f[l] = Math.abs(
            (e[d * t + l] ?? 0) - (A[d * t + l] ?? 0)
          );
    }
    const n = new Uint8Array(t * i), h = s === 1 ? 3 : 2;
    for (let o = 1; o < r.length - 1; o++) {
      const d = h + (o - 1) * 2;
      if (d >= i) break;
      const f = r[o];
      if (f)
        for (let l = 1; l < t - 1; l++) {
          const m = f[l] ?? 0;
          if (m <= 3) continue;
          let D = 0;
          for (let u = l - 1; u <= l + 1; u++)
            D += (r[o - 1]?.[u] ?? 0) > 3 ? 1 : 0, D += (r[o]?.[u] ?? 0) > 3 ? 1 : 0, D += (r[o + 1]?.[u] ?? 0) > 3 ? 1 : 0;
          if (D <= 1) continue;
          const w = d * t + l;
          if (n[w] = 1, m <= 19) continue;
          D = 0;
          let p = !1, g = !1;
          for (let u = l - 1; u <= l + 1; u++)
            (r[o - 1]?.[u] ?? 0) > 19 && (D++, p = !0), (r[o]?.[u] ?? 0) > 19 && D++, (r[o + 1]?.[u] ?? 0) > 19 && (D++, g = !0);
          if (D <= 3) continue;
          if (p && g) {
            n[w] |= 2;
            continue;
          }
          let F = !1, E = !1;
          for (let u = Math.max(l - 4, 0); u < Math.min(l + 5, t); u++)
            o !== 1 && (r[o - 2]?.[u] ?? 0) > 19 && (F = !0), (r[o - 1]?.[u] ?? 0) > 19 && (p = !0), (r[o + 1]?.[u] ?? 0) > 19 && (g = !0), o !== r.length - 2 && (r[o + 2]?.[u] ?? 0) > 19 && (E = !0);
          p && (g || F) || g && (p || E) ? n[w] |= 2 : D > 5 && (n[w] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #M(e, A, t) {
    const i = new Uint8Array(A * t), s = (a, n) => e[Math.max(0, Math.min(t - 1, n)) * A + a] ?? 0;
    for (let a = 0; a < t; a++)
      for (let n = 0; n < A; n++) {
        const h = s(n, a), o = s(n, a === 0 ? 1 : a - 1), d = s(n, a === t - 1 ? t - 2 : a + 1), f = a < 2 ? s(n, a === 0 ? 2 : 3) : s(n, a - 2), l = a + 2 >= t ? s(n, a === t - 1 ? t - 3 : t - 4) : s(n, a + 2);
        (a === 0 ? Math.abs(h - d) > x.COMB_THRESHOLD : a === t - 1 ? Math.abs(h - o) > x.COMB_THRESHOLD : Math.abs(h - o) > x.COMB_THRESHOLD && Math.abs(h - d) > x.COMB_THRESHOLD) && Math.abs(
          4 * h - 3 * (o + d) + f + l
        ) > x.COMB_THRESHOLD * 6 && (i[a * A + n] = 255);
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
                i[m - A] === 255 && i[m] === 255 && i[m + A] === 255 && d++;
              }
            r = Math.max(r, d);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #Z(e, A, t, i) {
    const s = x.DECIMATE_BLOCK / 2, r = Math.ceil(t / s), a = Math.ceil(i / s), n = new Float64Array(r * a), h = e.length / (t * i);
    for (let f = 0; f < i; f++) {
      const l = Math.floor(f / s);
      for (let m = 0; m < t; m++) {
        const D = Math.floor(m / s), w = l * r + D, p = (f * t + m) * h;
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
        let E = 0, u = 0, k = 0, U = 0, G = 0, S = 0, b = 0;
        for (let N = f; N < Math.min(f + 2, i); N++)
          for (let L = m; L < Math.min(m + 2, t); L++) {
            const R = (N * t + L) * h;
            E += e[R] ?? 0, u += e[R + 1] ?? 0, k += e[R + 2] ?? 0, U += A[R] ?? 0, G += A[R + 1] ?? 0, S += A[R + 2] ?? 0, b++;
          }
        const W = Math.round(
          (-0.114572 * E - 0.385428 * u + 0.5 * k) / b
        ), Y = Math.round(
          (-0.114572 * U - 0.385428 * G + 0.5 * S) / b
        ), Z = Math.round(
          (0.5 * E - 0.454153 * u - 0.045847 * k) / b
        ), X = Math.round(
          (0.5 * U - 0.454153 * G - 0.045847 * S) / b
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
const he = 0.5, v = 3, B = 4, ce = 80, $ = 1e3, le = 4, q = 200, fe = 0.25, ue = 0.2, de = 1e3 / 60, me = 0.02, pe = `#version 300 es
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
class Fe {
  canvas;
  #t;
  #e;
  #x;
  #n;
  /** The program that copies a filtered picture onto the canvas. */
  #l;
  #o;
  #T;
  /** The reduced pass that reads previous, current and next luma together. */
  #w = null;
  #S = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #y = null;
  #Y = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #M = null;
  #Z = null;
  #F = null;
  #m = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #g = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #G = B - 1;
  /** Filtered fields waiting for their moment, oldest first. */
  #A = [];
  /** The rAF loop that puts them up, which is all that draws on the canvas. */
  #R = null;
  #j = 0;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #N = de;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #C = null;
  #te;
  #f;
  #u;
  #s;
  #Q;
  #H;
  #pe;
  #X = "video";
  #O = "c";
  #Ae = 0;
  #ie = !0;
  #se = new x(y, M);
  #re = 1 / 0;
  #ne = 1 / 0;
  #b = 0;
  #B = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #a = 0;
  /** Where the media timeline was last pinned to the wall clock, and when. */
  #oe = 0;
  #ae = 0;
  #E = !1;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #h = 0;
  #d = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #c = v - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #i = 0;
  #J = 0;
  #L = null;
  #p = !1;
  #he = !1;
  #r = null;
  #z = [];
  #P = !1;
  #ce;
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #D = { filtered: 0, missed: 0, degraded: 0, discontinuities: 0, late: 0 };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #I = 0;
  #V = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #le = 0;
  #W = 0;
  #_ = 0;
  constructor(e, A = {}) {
    this.#t = e, this.#f = A.topFieldFirst ?? !0, this.#u = A.doubleRate ?? !1, this.#s = A.autoFilm ?? !1, this.#Q = Math.max(
      0,
      A.filmCombThreshold ?? ce
    ), this.#H = Math.max(0, A.bufferFields ?? 1), this.#pe = A.spatialCheck ?? !0, this.#ce = A.onStats, this.canvas = document.createElement("canvas"), this.canvas.style.cssText = "position:absolute;pointer-events:none;visibility:hidden";
    const t = this.canvas.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!t) throw new Error("this browser has no WebGL2");
    this.#e = t, this.#x = H(t, re);
    const i = this.#x;
    this.#n = Object.fromEntries(
      Object.entries(se).map(([s, r]) => [
        s,
        t.getUniformLocation(i, r)
      ])
    ), this.#l = H(t, we), this.#o = t.getUniformLocation(this.#l, "uField"), this.#T = t.getUniformLocation(this.#l, "uFlip"), this.#s && this.#De(), this.canvas.addEventListener("webglcontextlost", this.#Be), this.#te = new ResizeObserver(() => this.#ee()), e.addEventListener("emptied", this.#Se), e.addEventListener("resize", this.#Re), e.addEventListener("pause", this.#U), e.addEventListener("ended", this.#U), e.addEventListener("seeked", this.#U);
  }
  get running() {
    return this.#p && (this.#r?.interlaced ?? !0);
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#he;
  }
  set enabled(e) {
    this.#he = e, this.#fe();
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const A = this.#r?.interlaced !== e?.interlaced || this.#r?.topFieldFirst !== e?.topFieldFirst;
    this.#r = e, e && (this.#f = e.topFieldFirst), A && (this.#i = 0, this.#v()), this.#fe();
  }
  get scan() {
    return this.#r;
  }
  set videoTimeline(e) {
    this.#z = e, e.length === 0 && (this.#r = null), this.#fe();
  }
  get videoTimeline() {
    return this.#z;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#C ?? this.#t;
  }
  /** Whether the top field of a frame is the one captured first. */
  get topFieldFirst() {
    return this.#f;
  }
  set topFieldFirst(e) {
    e !== this.#f && (this.#f = e, this.#i = 0, this.#v());
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#u;
  }
  set doubleRate(e) {
    e !== this.#u && (this.#u = e, this.#A.length = 0, this.#E = !1, e ? (this.#h > 0 && this.#me(), (this.#r?.interlaced ?? !0) && this.#$()) : this.#s || (this.#q(), this.#k()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#s;
  }
  set autoFilm(e) {
    e !== this.#s && (this.#s = e, this.#v(), e ? (this.#De(), this.#h > 0 && (this.#Fe(), this.#me()), (this.#r?.interlaced ?? !0) && this.#$()) : (this.#de(), this.#u || (this.#q(), this.#k())));
  }
  /** The combed-pixel boundary between clean field matches and field motion. */
  get filmCombThreshold() {
    return this.#Q;
  }
  set filmCombThreshold(e) {
    this.#Q = Math.max(0, e), this.#s && this.#v();
  }
  /** How many field intervals of slack the field schedule is held back by. */
  get bufferFields() {
    return this.#H;
  }
  set bufferFields(e) {
    this.#H = Math.max(0, e);
  }
  #fe() {
    this.#he && (this.#z.length > 0 || (this.#r?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  start() {
    this.#p || this.#P || (this.#p = !0, this.#Ce(), this.#Oe(), this.#K(), (this.#r?.interlaced ?? !0) && this.#$());
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#p && (this.#p = !1, this.#L !== null && this.#t.cancelVideoFrameCallback(this.#L), this.#L = null, this.#q(), this.#i = 0, this.#E = !1, this.canvas.style.visibility = "hidden");
  }
  destroy() {
    this.stop(), this.canvas.removeEventListener("webglcontextlost", this.#Be), this.#t.removeEventListener("emptied", this.#Se), this.#t.removeEventListener("resize", this.#Re), this.#t.removeEventListener("pause", this.#U), this.#t.removeEventListener("ended", this.#U), this.#t.removeEventListener("seeked", this.#U), this.#ze();
    for (const e of this.#m) this.#e.deleteTexture(e);
    this.#m = [], this.#k(), this.#de(), this.#e.deleteProgram(this.#x), this.#e.deleteProgram(this.#l), this.#w && this.#e.deleteProgram(this.#w), this.#y && this.#e.deleteProgram(this.#y), this.#M && this.#e.deleteProgram(this.#M), this.#e.getExtension("WEBGL_lose_context")?.loseContext();
  }
  #K() {
    !this.#p || this.#L !== null || (this.#L = this.#t.requestVideoFrameCallback(this.#Le));
  }
  #Le = (e, A) => {
    if (this.#L = null, !(!this.#p || this.#P)) {
      if (this.#Pe(A.mediaTime), A.width > 0 && A.height > 0) {
        if ((this.#h === 0 || this.#d === 0) && this.#Me(A.width, A.height), this.#r && !this.#r.interlaced) {
          this.#Ne(), this.#K();
          return;
        }
        const t = A.mediaTime - this.#J, i = t < 0 || t > he;
        i && (this.#i = 0, this.#D.discontinuities++, this.#A.length = 0, this.#E = !1, this.#v());
        const s = this.#s && this.#I !== 0 && A.presentedFrames - this.#I > 1;
        if (this.#He(A.presentedFrames, i), !i && s && (this.#i = 0, this.#v()), this.#i > 0 && A.mediaTime === this.#J) {
          this.#K();
          return;
        }
        !i && t > 0 && this.#Ie(t), this.#J = A.mediaTime;
        const r = performance.now();
        if (r - this.#le > $ && (this.#V = r, this.#W = 0, this.#_ = 0), this.#le = r, this.#ye(), !(this.#s && this.#i === v && this.#_e())) if (this.#s && !this.#ie && this.#i === v && this.#X === "film")
          if (!this.#we())
            this.#ve(null);
          else {
            const n = this.#Ee(A.mediaTime, A.expectedDisplayTime) + this.#a * (1 + this.#H / 2), h = this.#a / 2;
            (this.#b === 0 || this.#b < n - h || this.#b > n + this.#a + h) && (this.#b = n), this.#ke(this.#b), this.#b += this.#a * 5 / 4;
          }
        else if (this.#u && this.#we()) {
          const n = this.#a / 2, h = this.#Ee(A.mediaTime, A.expectedDisplayTime) + (1 + this.#H) * n;
          this.#xe(!1, h), this.#xe(!0, h + n);
        } else
          this.#ue(!1, !1, null);
        this.#_ += performance.now() - r, this.#W++, this.#Xe(r);
      }
      this.#K();
    }
  };
  #Pe(e) {
    let A;
    for (let i = this.#z.length - 1; i >= 0; i--) {
      const s = this.#z[i];
      if (s.start <= e + 1e-6) {
        A = s;
        break;
      }
    }
    A?.codedSize && (A.codedSize.width !== this.#h || A.codedSize.height !== this.#d) && this.#Me(A.codedSize.width, A.codedSize.height);
    const t = A?.scan;
    !t || this.#r?.interlaced === t.interlaced && this.#r.topFieldFirst === t.topFieldFirst || (this.#r = t, this.#f = t.topFieldFirst, this.#i = 0, this.#A.length = 0, this.#E = !1, this.#v(), t.interlaced ? (this.#u || this.#s) && this.#$() : this.#q());
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #we() {
    return (this.#u || this.#s) && this.#a > 0 && this.#g.length === B;
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
  #Ie(e) {
    const A = e * 1e3 / (this.#t.playbackRate || 1), t = this.#a > 0 ? Math.max(1, Math.round(A / this.#a)) : 1, i = A / t;
    i < le || i > q || (this.#a = this.#a > 0 ? this.#a + (i - this.#a) * fe : i);
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
  #Ee(e, A) {
    if (!this.#E)
      return this.#E = !0, this.#oe = e, this.#ae = A, A;
    const t = this.#t.playbackRate || 1, i = this.#ae + (e - this.#oe) * 1e3 / t, s = A - i;
    let r;
    return Math.abs(s) > this.#a ? (r = A, this.#D.late += this.#A.length, this.#A.length = 0) : r = i + s * ue, this.#oe = e, this.#ae = r, r;
  }
  /** Build the optional film passes only for callers that enable them. */
  #De() {
    if (this.#w && this.#y && this.#M) return;
    const e = this.#e, A = H(e, ne), t = H(e, oe), i = H(e, ae);
    this.#w = A, this.#S = Object.fromEntries(
      Object.entries(j).filter(([s]) => s !== "match" && s !== "topFieldFirst").map(([s, r]) => [s, e.getUniformLocation(A, r)])
    ), this.#y = t, this.#Y = Object.fromEntries(
      Object.entries(j).map(([s, r]) => [
        s,
        e.getUniformLocation(t, r)
      ])
    ), this.#M = i, this.#Z = Object.fromEntries(
      Object.entries(j).map(([s, r]) => [
        s,
        e.getUniformLocation(i, r)
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
  #_e() {
    const e = this.#F, A = this.#w, t = this.#S, i = this.#M, s = this.#Z;
    if (!e || !A || !t || !i || !s)
      return !1;
    const r = this.#e, a = this.#c, n = (this.#c + v - 1) % v, h = (this.#c + 1) % v;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(A);
    for (const [w, p] of [h, n, a].entries())
      r.activeTexture(r.TEXTURE0 + w), r.bindTexture(r.TEXTURE_2D, this.#m[p] ?? null);
    r.uniform1i(t.prev, 0), r.uniform1i(t.cur, 1), r.uniform1i(t.next, 2), r.uniform2i(t.size, this.#h, this.#d), r.viewport(0, 0, y, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
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
    const l = this.#se.fieldMatch(
      o,
      d,
      f,
      this.#f,
      this.#Q
    );
    r.useProgram(i), r.uniform1i(s.prev, 0), r.uniform1i(s.cur, 1), r.uniform1i(s.next, 2), r.uniform2i(s.size, this.#h, this.#d), r.uniform1i(s.topFieldFirst, this.#f ? 1 : 0), r.uniform1i(
      s.match,
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
    const m = this.#se.decimate(e.pixels);
    this.#O = l.match, this.#Ae = l.combScore, this.#ie = l.isCombed, this.#re = m.lowestCycleDifference, this.#ne = m.runnerUpCycleDifference;
    const D = m.dropIndex !== null && !l.isCombed;
    return (D ? "film" : "video") !== this.#X && (this.#X = D ? "film" : "video", this.#b = 0), m.shouldDrop && !l.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #ke(e) {
    const A = (this.#G + 1) % B, t = this.#g[A];
    t && (this.#G = A, this.#ve(t.framebuffer), this.#ge(A, e));
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #ve(e) {
    const A = this.#y, t = this.#Y;
    if (!A || !t) return;
    const i = this.#e, s = this.#c, r = (this.#c + v - 1) % v, a = (this.#c + 1) % v;
    i.bindFramebuffer(i.FRAMEBUFFER, e), i.useProgram(A);
    for (const [n, h] of [a, r, s].entries())
      i.activeTexture(i.TEXTURE0 + n), i.bindTexture(i.TEXTURE_2D, this.#m[h] ?? null);
    i.uniform1i(t.prev, 0), i.uniform1i(t.cur, 1), i.uniform1i(t.next, 2), i.uniform2i(t.size, this.#h, this.#d), i.uniform1i(t.topFieldFirst, this.#f ? 1 : 0), i.uniform1i(
      t.match,
      this.#O === "p" ? 0 : this.#O === "c" ? 1 : 2
    ), i.viewport(0, 0, this.#h, this.#d), i.drawArrays(i.TRIANGLES, 0, 3), e === null && (this.canvas.style.visibility = "visible", this.#B++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #xe(e, A) {
    const t = (this.#G + 1) % B, i = this.#g[t];
    i && (this.#G = t, this.#ue(!1, e, i.framebuffer), this.#ge(t, A));
  }
  /** Add a completed picture to the shared film and field-rate schedule. */
  #ge(e, A) {
    const t = this.#A.findIndex((s) => s.slot === e);
    t !== -1 && (this.#A.splice(t, 1), this.#D.late++);
    const i = this.#A.findIndex((s) => s.at > A);
    i === -1 ? this.#A.push({ slot: e, at: A }) : this.#A.splice(i, 0, { slot: e, at: A });
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #$() {
    this.#R === null && (!this.#p || this.#P || !this.#u && !this.#s || (this.#j = 0, this.#R = requestAnimationFrame(this.#be)));
  }
  #q() {
    this.#R !== null && cancelAnimationFrame(this.#R), this.#R = null, this.#A.length = 0;
  }
  #be = (e) => {
    if (this.#R = null, !(!this.#p || this.#P || !this.#u && !this.#s)) {
      if (this.#j > 0) {
        const A = e - this.#j;
        A >= 1 && A <= q && (this.#N = A < this.#N ? A : this.#N + (A - this.#N) * me);
      }
      this.#j = e, this.#Ue(e), this.#R = requestAnimationFrame(this.#be);
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
  #Ue(e) {
    const A = e + this.#N * 1.5;
    if ((this.#A[0]?.at ?? 1 / 0) > A) return;
    let t = this.#A.shift();
    for (; (this.#A[0]?.at ?? 1 / 0) <= A; )
      this.#D.late++, t = this.#A.shift();
    if (!t) return;
    const i = performance.now();
    this.#Ge(t.slot), this.#_ += performance.now() - i;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #Ge(e) {
    const A = this.#g[e];
    A && this.#Te(A.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Ne() {
    this.#ye();
    const e = this.#m[this.#c];
    e && this.#Te(e, !0), this.#i = 0;
  }
  #Te(e, A = !1) {
    const t = this.#e;
    t.bindFramebuffer(t.FRAMEBUFFER, null), t.useProgram(this.#l), t.activeTexture(t.TEXTURE0), t.bindTexture(t.TEXTURE_2D, e), t.uniform1i(this.#o, 0), t.uniform1i(this.#T, A ? 1 : 0), t.viewport(0, 0, this.#h, this.#d), t.drawArrays(t.TRIANGLES, 0, 3), this.canvas.style.visibility = "visible", this.#B++;
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
  #He(e, A) {
    this.#I !== 0 && !A && (this.#D.missed += Math.max(0, e - this.#I - 1)), this.#I = e;
  }
  #Xe(e) {
    if (!this.#ce) return;
    const A = e - this.#V;
    if (A < $) return;
    const t = this.#W;
    this.#ce({
      ...this.#D,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#t.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: t * 1e3 / A,
      frameMs: t === 0 ? 0 : this.#_ / t,
      mode: this.#X,
      match: this.#O,
      combScore: this.#Ae,
      outputFps: this.#B * 1e3 / A,
      duplicateScore: this.#re,
      duplicateRunnerUp: this.#ne
    }), this.#V = e, this.#W = 0, this.#_ = 0, this.#B = 0;
  }
  /** Take the newest frame into the ring. */
  #ye() {
    const e = this.#e;
    this.#c = (this.#c + 1) % v, e.bindTexture(e.TEXTURE_2D, this.#m[this.#c] ?? null), e.texSubImage2D(
      e.TEXTURE_2D,
      0,
      0,
      0,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#t
    ), this.#i = Math.min(this.#i + 1, v);
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
  #ue(e, A, t) {
    if (this.#i === 0 || this.#P) return;
    this.#i === v && !e ? this.#D.filtered++ : this.#D.degraded++;
    const i = this.#e, s = this.#c, r = (this.#c + v - 1) % v, a = (this.#c + 1) % v;
    let n, h, o;
    this.#i === 1 ? n = h = o = s : e ? (n = r, h = o = s) : this.#i === 2 ? (n = h = r, o = s) : (n = a, h = r, o = s), i.bindFramebuffer(i.FRAMEBUFFER, t), i.useProgram(this.#x);
    for (const [f, l] of [n, h, o].entries())
      i.activeTexture(i.TEXTURE0 + f), i.bindTexture(i.TEXTURE_2D, this.#m[l] ?? null);
    i.uniform1i(this.#n.prev, 0), i.uniform1i(this.#n.cur, 1), i.uniform1i(this.#n.next, 2), i.uniform2i(this.#n.size, this.#h, this.#d);
    const d = this.#f ? 0 : 1;
    i.uniform1i(this.#n.parity, A ? 1 - d : d), i.uniform1i(this.#n.tff, this.#f ? 1 : 0), i.uniform1i(this.#n.spatialCheck, this.#pe ? 1 : 0), i.viewport(0, 0, this.#h, this.#d), i.drawArrays(i.TRIANGLES, 0, 3), t === null && (this.canvas.style.visibility = "visible", this.#B++);
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
  #ee() {
    if (!this.#C) return;
    const e = this.#t, A = e.videoWidth, t = e.videoHeight;
    if (A === 0 || t === 0) return;
    const i = Math.min(
      e.offsetWidth / A,
      e.offsetHeight / t
    ), s = A * i, r = t * i;
    this.canvas.style.left = `${e.offsetLeft + (e.offsetWidth - s) / 2}px`, this.canvas.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.canvas.style.width = `${s}px`, this.canvas.style.height = `${r}px`;
  }
  #Me(e, A) {
    const t = this.#e;
    this.canvas.width = e, this.canvas.height = A, this.#h = e, this.#d = A, this.#i = 0, this.#v(), this.#ee();
    for (const i of this.#m) t.deleteTexture(i);
    this.#m = [];
    for (let i = 0; i < v; i++) {
      const s = t.createTexture();
      t.bindTexture(t.TEXTURE_2D, s), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MIN_FILTER, t.NEAREST), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MAG_FILTER, t.NEAREST), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_S, t.CLAMP_TO_EDGE), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_T, t.CLAMP_TO_EDGE), t.texImage2D(
        t.TEXTURE_2D,
        0,
        t.RGBA,
        e,
        A,
        0,
        t.RGBA,
        t.UNSIGNED_BYTE,
        null
      ), this.#m.push(s);
    }
    this.#k(), this.#de(), this.#s && this.#Fe(), (this.#u || this.#s) && this.#me();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Fe() {
    if (this.#F) return;
    const e = this.#e, A = e.createTexture();
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
    const i = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
    if (e.bindFramebuffer(e.FRAMEBUFFER, null), !i) {
      e.deleteFramebuffer(t), e.deleteTexture(A);
      return;
    }
    this.#F = {
      texture: A,
      framebuffer: t,
      pixels: new Uint8Array(y * M * 4)
    };
  }
  #de() {
    this.#F && (this.#e.deleteFramebuffer(this.#F.framebuffer), this.#e.deleteTexture(this.#F.texture), this.#F = null);
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
  #me() {
    const e = this.#e;
    if (!(this.#g.length === B || this.#h === 0)) {
      this.#k();
      for (let A = 0; A < B; A++) {
        const t = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#h,
          this.#d,
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
          e.deleteFramebuffer(i), e.deleteTexture(t), this.#k();
          return;
        }
        this.#g.push({ texture: t, framebuffer: i });
      }
      this.#G = B - 1;
    }
  }
  #k() {
    const e = this.#e;
    for (const { texture: A, framebuffer: t } of this.#g)
      e.deleteFramebuffer(t), e.deleteTexture(A);
    this.#g = [], this.#A.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #Oe() {
    if (this.#C) return;
    const e = this.#t.parentElement;
    if (!e) return;
    const A = document.createElement("div");
    A.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(A, this.#t), A.appendChild(this.#t), A.appendChild(this.canvas), this.#C = A, this.#te.observe(this.#t), this.#ee();
  }
  #ze() {
    const e = this.#C;
    this.#C = null, this.#te.disconnect(), this.canvas.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#t, e), e.remove());
  }
  #Re = () => this.#ee();
  #Se = () => {
    this.#i = 0, this.#J = 0, this.#A.length = 0, this.#E = !1, this.#a = 0, this.#v(), this.#Ce(), this.canvas.style.visibility = "hidden";
  };
  #Ce() {
    this.#D = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0
    }, this.#I = 0, this.#V = 0, this.#le = 0, this.#W = 0, this.#_ = 0, this.#B = 0;
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #v() {
    this.#A.length = 0, this.#E = !1, this.#X = "video", this.#O = "c", this.#Ae = 0, this.#ie = !0, this.#b = 0, this.#se.reset(), this.#re = 1 / 0, this.#ne = 1 / 0;
  }
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #U = () => {
    this.#A.length = 0, this.#E = !1, this.#p && this.#ue(!0, !1, null);
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Be = (e) => {
    e.preventDefault(), this.#P = !0, this.stop();
  };
}
function H(c, e) {
  const A = c.createProgram(), t = ee(c, c.VERTEX_SHADER, pe), i = ee(c, c.FRAGMENT_SHADER, e);
  if (c.attachShader(A, t), c.attachShader(A, i), c.linkProgram(A), c.deleteShader(t), c.deleteShader(i), !c.getProgramParameter(A, c.LINK_STATUS)) {
    const s = c.getProgramInfoLog(A);
    throw c.deleteProgram(A), new Error(
      `the deinterlacer failed to link: ${s ?? "no reason given"}`
    );
  }
  return A;
}
function ee(c, e, A) {
  const t = c.createShader(e);
  if (!t) throw new Error("the deinterlacer could not create a shader");
  if (c.shaderSource(t, A), c.compileShader(t), !c.getShaderParameter(t, c.COMPILE_STATUS)) {
    const i = c.getShaderInfoLog(t);
    throw c.deleteShader(t), new Error(
      `the deinterlacer failed to compile: ${i ?? "no reason given"}`
    );
  }
  return t;
}
const te = "data:video/mp4;base64,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AwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Ee = 0.5, De = 3e3, Ae = 0.1, _ = 16, ie = 'video/mp4; codecs="avc1.640029"';
let J = null;
function ve(c = {}) {
  return J ??= xe(c), J;
}
async function Re(c = {}) {
  return (await ve(c)).deinterlaces;
}
function Se() {
  J = null;
}
async function xe(c) {
  const e = c.tolerance ?? Ee, A = c.timeoutMs ?? De, t = performance.now(), i = (a) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - t,
    error: a instanceof Error ? a.message : String(a)
  });
  if (typeof document > "u")
    return i(new Error("there is no document to decode in"));
  const s = document.createElement("video");
  s.muted = !0, s.defaultMuted = !0, s.playsInline = !0, s.preload = "auto";
  let r = null;
  try {
    r = be(s, A);
    const a = z(O(s, "loadeddata"), A), n = s.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await a, await Te(s, A, await n), s.videoWidth === 0 || s.videoHeight === 0)
      return i(new Error("the probe clip decoded to nothing"));
    const h = ye(s);
    return {
      deinterlaces: h < 1 - e,
      survives: h,
      tookMs: performance.now() - t
    };
  } catch (a) {
    return i(a);
  } finally {
    s.pause(), s.removeAttribute("src"), s.replaceChildren(), s.load(), r && URL.revokeObjectURL(r.url);
  }
}
const Q = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, ge = typeof MediaSource > "u";
function be(c, e) {
  if (!Q || !Q.isTypeSupported(ie))
    throw new Error("the probe clip needs Media Source Extensions");
  const A = te.indexOf(","), t = atob(te.slice(A + 1)), i = new Uint8Array(t.length);
  for (let n = 0; n < t.length; n++) i[n] = t.charCodeAt(n);
  const s = new Q(), r = URL.createObjectURL(s);
  if (ge) {
    c.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, c.append(n), c.load();
  } else
    c.src = r;
  const a = (async () => {
    await z(O(s, "sourceopen"), e);
    const n = s.addSourceBuffer(ie), h = z(O(n, "updateend"), e);
    n.appendBuffer(i), await h, s.endOfStream();
  })();
  return { url: r, ready: a };
}
async function Te(c, e, A) {
  if (A) {
    const t = performance.now();
    for (; c.currentTime < Ae && performance.now() - t < e; )
      await new Promise((i) => requestAnimationFrame(i));
    c.pause();
  } else
    c.currentTime = Ae, await z(O(c, "seeked"), e);
}
function ye(c) {
  const e = c.videoHeight, A = document.createElement("canvas");
  A.width = _, A.height = e;
  const t = A.getContext("2d", { willReadFrequently: !0 });
  if (!t) throw new Error("there is no 2d context to read the clip with");
  t.imageSmoothingEnabled = !1, t.drawImage(c, 0, 0, _, e);
  const i = t.getImageData(0, 0, _, e).data, s = (o) => {
    let d = 0;
    for (let f = 0; f < _; f++)
      d += i[(o * _ + f) * 4 + 1] ?? 0;
    return d / _;
  };
  let r = 0;
  const a = 2, n = e - 3;
  let h = s(a);
  for (let o = a + 1; o <= n; o++) {
    const d = s(o);
    r += Math.abs(d - h), h = d;
  }
  return r / (n - a) / 255;
}
function O(c, e) {
  return new Promise((A, t) => {
    c.addEventListener(e, () => A(), { once: !0 }), c.addEventListener(
      "error",
      () => {
        const i = c instanceof HTMLMediaElement ? c.error : null, s = i ? ` (MediaError ${i.code}${i.message ? `: ${i.message}` : ""})` : "";
        t(new Error(`the probe clip ${e} failed${s}`));
      },
      { once: !0 }
    );
  });
}
function z(c, e) {
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
  j as FILM_UNIFORMS,
  oe as FILM_WEAVE_FRAGMENT_SHADER,
  re as YADIF_FRAGMENT_SHADER,
  se as YADIF_UNIFORMS,
  Re as decoderDeinterlaces,
  Se as forgetDecoderProbe,
  ve as probeDecoder,
  Me as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
