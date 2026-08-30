const re = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, ne = `#version 300 es
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
}, y = 288, M = 162, oe = `#version 300 es
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
`, he = `#version 300 es
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
class g {
  static CYCLE = 5;
  static COMB_THRESHOLD = 9;
  static COMBED_PIXEL_LIMIT = 80;
  static DECIMATE_BLOCK = 32;
  static DUPLICATE_PERCENT = 1.1;
  #t;
  #A;
  #g;
  #o = 0;
  #f = null;
  #a = [];
  #T = null;
  #D = 1 / 0;
  #L = 1 / 0;
  constructor(e, A) {
    this.#t = e, this.#A = A, this.#g = 255 * g.DECIMATE_BLOCK ** 2 * g.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, A, t, s, i = g.COMBED_PIXEL_LIMIT) {
    const r = s ? 1 : 0, a = { p: e, c: A, n: t };
    let n = this.#y("c", "p", r, a);
    const l = /* @__PURE__ */ new Map(), o = (w) => {
      const v = l.get(w);
      if (v !== void 0) return v;
      const p = g.#M(
        this.weave(e, A, t, w, s),
        this.#t,
        this.#A
      );
      return l.set(w, p), p;
    }, u = o(n), c = o("n");
    (c * 3 < u || c * 2 < u && u > i) && Math.abs(c - u) >= 30 && c < i && (n = "n");
    const f = o(n), m = f >= i;
    return m && (n = "c"), {
      match: n,
      combScore: f,
      isCombed: m,
      luma: this.weave(e, A, t, n, s)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const A = this.#o, t = this.#T ? g.#K(
      this.#T,
      e,
      this.#t,
      this.#A
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#a.push(t);
    const s = this.#f === A, i = s && t.maxBlockDifference < this.#g;
    s && !i && (this.#f = null);
    const r = this.#f;
    this.#T = e.slice(), this.#o++;
    let a = this.#f;
    if (this.#o === g.CYCLE) {
      let n = 0, l = null;
      for (let o = 1; o < this.#a.length; o++)
        (this.#a[o]?.maxBlockDifference ?? 1 / 0) < (this.#a[n]?.maxBlockDifference ?? 1 / 0) ? (l = n, n = o) : (l === null || (this.#a[o]?.maxBlockDifference ?? 1 / 0) < (this.#a[l]?.maxBlockDifference ?? 1 / 0)) && (l = o);
      this.#D = this.#a[n]?.maxBlockDifference ?? 1 / 0, this.#L = l === null ? 1 / 0 : this.#a[l]?.maxBlockDifference ?? 1 / 0, a = (this.#a[n]?.maxBlockDifference ?? 1 / 0) < this.#g ? n : null, this.#f = a, this.#a = [], this.#o = 0;
    }
    return {
      cycleIndex: A,
      maxBlockDifference: t.maxBlockDifference,
      totalDifference: t.totalDifference,
      shouldDrop: i,
      dropIndex: r,
      nextDropIndex: a,
      lowestCycleDifference: this.#D,
      runnerUpCycleDifference: this.#L
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, A, t, s, i) {
    if (s === "c") return A.slice();
    const r = A.slice(), a = s === "p" ? e : t, n = r.length / this.#A, l = i ? 1 : 0;
    for (let o = l; o < this.#A; o += 2)
      r.set(
        a.subarray(o * n, (o + 1) * n),
        o * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#o = 0, this.#f = null, this.#a = [], this.#T = null, this.#D = 1 / 0, this.#L = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #y(e, A, t, s) {
    const i = this.#t, r = this.#A, a = 2 - t, n = 2 - t, l = s[e], o = s[A], u = g.#V(
      l,
      o,
      i,
      r,
      t
    );
    let c = 0, f = 0, m = 0, w = 0, v = 0, p = 0;
    for (let S = 2; S < r - 2; S += 2) {
      const b = (S - 2) / 2, W = a - 1 + b * 2, Y = a + 1 + b * 2, Z = a + 3 + b * 2, X = a + b * 2, N = X + 2, B = n + b * 2, R = B + 2, V = a + b * 2;
      for (let T = 8; T < i - 8; T++) {
        const C = (u[V * i + T] ?? 0) | (u[(V + 2) * i + T] ?? 0);
        if (C === 0) continue;
        const K = (s.c[W * i + T] ?? 0) + ((s.c[Y * i + T] ?? 0) << 2) + (s.c[Z * i + T] ?? 0), P = Math.abs(
          3 * ((l[X * i + T] ?? 0) + (l[N * i + T] ?? 0)) - K
        ), I = Math.abs(
          3 * ((o[B * i + T] ?? 0) + (o[R * i + T] ?? 0)) - K
        );
        P > 23 && (C & 1) !== 0 && (c += P), I > 23 && (C & 1) !== 0 && (w += I), P > 42 && (C & 2) !== 0 && (f += P), I > 42 && (C & 2) !== 0 && (v += I), P > 42 && (C & 4) !== 0 && (m += P), I > 42 && (C & 4) !== 0 && (p += I);
      }
    }
    f < 500 && v < 500 && (m >= 500 || p >= 500) && Math.max(m, p) > 3 * Math.min(m, p) && (f = m, v = p);
    const D = Math.floor(c / 6 + 0.5), F = Math.floor(w / 6 + 0.5), E = Math.floor(f / 6 + 0.5), d = Math.floor(v / 6 + 0.5), k = Math.max(D, F) / Math.max(Math.min(D, F), 1), U = Math.max(E, d) / Math.max(Math.min(E, d), 1), G = Math.max(E, d) / Math.max(Math.max(D, F), 1);
    return (E >= 500 || d >= 500) && (E * 2 < d || d * 2 < E) || (E >= 1e3 || d >= 1e3) && (E * 3 < d * 2 || d * 3 < E * 2) || (E >= 2e3 || d >= 2e3) && (E * 5 < d * 4 || d * 5 < E * 4) || (E >= 4e3 || d >= 4e3) && U > k || G > 5e-3 && Math.max(E, d) > 150 && (E * 2 < d || d * 2 < E) ? E > d ? A : e : D > F ? A : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #V(e, A, t, s, i) {
    const r = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(t)
    ), a = i === 1 ? 1 : 0;
    for (let o = 0; o < r.length; o++) {
      const u = Math.min(s - 1, a + o * 2), c = r[o];
      if (c)
        for (let f = 0; f < t; f++)
          c[f] = Math.abs(
            (e[u * t + f] ?? 0) - (A[u * t + f] ?? 0)
          );
    }
    const n = new Uint8Array(t * s), l = i === 1 ? 3 : 2;
    for (let o = 1; o < r.length - 1; o++) {
      const u = l + (o - 1) * 2;
      if (u >= s) break;
      const c = r[o];
      if (c)
        for (let f = 1; f < t - 1; f++) {
          const m = c[f] ?? 0;
          if (m <= 3) continue;
          let w = 0;
          for (let d = f - 1; d <= f + 1; d++)
            w += (r[o - 1]?.[d] ?? 0) > 3 ? 1 : 0, w += (r[o]?.[d] ?? 0) > 3 ? 1 : 0, w += (r[o + 1]?.[d] ?? 0) > 3 ? 1 : 0;
          if (w <= 1) continue;
          const v = u * t + f;
          if (n[v] = 1, m <= 19) continue;
          w = 0;
          let p = !1, D = !1;
          for (let d = f - 1; d <= f + 1; d++)
            (r[o - 1]?.[d] ?? 0) > 19 && (w++, p = !0), (r[o]?.[d] ?? 0) > 19 && w++, (r[o + 1]?.[d] ?? 0) > 19 && (w++, D = !0);
          if (w <= 3) continue;
          if (p && D) {
            n[v] |= 2;
            continue;
          }
          let F = !1, E = !1;
          for (let d = Math.max(f - 4, 0); d < Math.min(f + 5, t); d++)
            o !== 1 && (r[o - 2]?.[d] ?? 0) > 19 && (F = !0), (r[o - 1]?.[d] ?? 0) > 19 && (p = !0), (r[o + 1]?.[d] ?? 0) > 19 && (D = !0), o !== r.length - 2 && (r[o + 2]?.[d] ?? 0) > 19 && (E = !0);
          p && (D || F) || D && (p || E) ? n[v] |= 2 : w > 5 && (n[v] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #M(e, A, t) {
    const s = new Uint8Array(A * t), i = (a, n) => e[Math.max(0, Math.min(t - 1, n)) * A + a] ?? 0;
    for (let a = 0; a < t; a++)
      for (let n = 0; n < A; n++) {
        const l = i(n, a), o = i(n, a === 0 ? 1 : a - 1), u = i(n, a === t - 1 ? t - 2 : a + 1), c = a < 2 ? i(n, a === 0 ? 2 : 3) : i(n, a - 2), f = a + 2 >= t ? i(n, a === t - 1 ? t - 3 : t - 4) : i(n, a + 2);
        (a === 0 ? Math.abs(l - u) > g.COMB_THRESHOLD : a === t - 1 ? Math.abs(l - o) > g.COMB_THRESHOLD : Math.abs(l - o) > g.COMB_THRESHOLD && Math.abs(l - u) > g.COMB_THRESHOLD) && Math.abs(
          4 * l - 3 * (o + u) + c + f
        ) > g.COMB_THRESHOLD * 6 && (s[a * A + n] = 255);
      }
    let r = 0;
    for (const a of [0, 8])
      for (const n of [0, 8])
        for (let l = a; l < t; l += 16)
          for (let o = n; o < A; o += 16) {
            let u = 0;
            for (let c = Math.max(1, l); c < Math.min(t - 1, l + 16); c++)
              for (let f = o; f < Math.min(A, o + 16); f++) {
                const m = c * A + f;
                s[m - A] === 255 && s[m] === 255 && s[m + A] === 255 && u++;
              }
            r = Math.max(r, u);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #K(e, A, t, s) {
    const i = g.DECIMATE_BLOCK / 2, r = Math.ceil(t / i), a = Math.ceil(s / i), n = new Float64Array(r * a), l = e.length / (t * s);
    for (let c = 0; c < s; c++) {
      const f = Math.floor(c / i);
      for (let m = 0; m < t; m++) {
        const w = Math.floor(m / i), v = f * r + w, p = (c * t + m) * l;
        if (l === 1) {
          n[v] = (n[v] ?? 0) + Math.abs((e[p] ?? 0) - (A[p] ?? 0));
          continue;
        }
        const D = Math.round(
          (e[p] ?? 0) * 0.2126 + (e[p + 1] ?? 0) * 0.7152 + (e[p + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (A[p] ?? 0) * 0.2126 + (A[p + 1] ?? 0) * 0.7152 + (A[p + 2] ?? 0) * 0.0722
        );
        if (n[v] = (n[v] ?? 0) + Math.abs(D - F), (m & 1) !== 0 || (c & 1) !== 0) continue;
        let E = 0, d = 0, k = 0, U = 0, G = 0, S = 0, b = 0;
        for (let N = c; N < Math.min(c + 2, s); N++)
          for (let B = m; B < Math.min(m + 2, t); B++) {
            const R = (N * t + B) * l;
            E += e[R] ?? 0, d += e[R + 1] ?? 0, k += e[R + 2] ?? 0, U += A[R] ?? 0, G += A[R + 1] ?? 0, S += A[R + 2] ?? 0, b++;
          }
        const W = Math.round(
          (-0.114572 * E - 0.385428 * d + 0.5 * k) / b
        ), Y = Math.round(
          (-0.114572 * U - 0.385428 * G + 0.5 * S) / b
        ), Z = Math.round(
          (0.5 * E - 0.454153 * d - 0.045847 * k) / b
        ), X = Math.round(
          (0.5 * U - 0.454153 * G - 0.045847 * S) / b
        );
        n[v] = (n[v] ?? 0) + Math.abs(W - Y) + Math.abs(Z - X);
      }
    }
    let o = -1;
    for (let c = 0; c < a - 1; c++)
      for (let f = 0; f < r - 1; f++)
        o = Math.max(
          o,
          (n[c * r + f] ?? 0) + (n[c * r + f + 1] ?? 0) + (n[(c + 1) * r + f] ?? 0) + (n[(c + 1) * r + f + 1] ?? 0)
        );
    let u = 0;
    for (const c of n) u += c;
    return { maxBlockDifference: o, totalDifference: u };
  }
}
const ce = 0.5, x = 3, le = 5, L = le + 1, q = 1e3, fe = 4, $ = 200, ue = 0.25, de = 1e3 / 60, me = 0.02;
function ee(h) {
  if (!Number.isFinite(h) || h < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return h;
}
const pe = `#version 300 es
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
  #t;
  #A;
  #g;
  #o;
  /** The program that copies a filtered picture onto the canvas. */
  #f;
  #a;
  #T;
  /** The reduced pass that reads previous, current and next luma together. */
  #D = null;
  #L = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #y = null;
  #V = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #M = null;
  #K = null;
  #F = null;
  #E = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #u = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #G = L - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #r = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #e = [];
  /** The rAF loop that puts them up, which is all that draws on the canvas. */
  #R = null;
  #q = 0;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #N = de;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #B = null;
  #se;
  #d;
  #n;
  #H;
  #Ee;
  #x = "video";
  #X = "c";
  #re = 0;
  #ne = !0;
  #oe = new g(y, M);
  #ae = 1 / 0;
  #he = 1 / 0;
  #P = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #h = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #c = 0;
  #m = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #l = x - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #i = 0;
  #z = 0;
  #I = null;
  #p = !1;
  #ce = !1;
  #s = null;
  #O = [];
  #S = !1;
  #ve;
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #v = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    late: 0,
    queueResetted: 0
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #_ = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #le = 0;
  #$ = 0;
  #C = 0;
  #W = 0;
  #Y = 0;
  #Z = 0;
  #k = 0;
  constructor(e, A = {}) {
    super(), this.#t = e, this.#d = A.doubleRate ?? !1, this.#n = A.autoFilm ?? !1, this.#H = ee(
      A.filmCombThreshold ?? g.COMBED_PIXEL_LIMIT
    ), this.#Ee = A.spatialCheck ?? !0, this.#ve = A.onStats, this.canvas = document.createElement("canvas"), this.canvas.style.cssText = "position:absolute;pointer-events:none;visibility:hidden";
    const t = this.canvas.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!t) throw new Error("this browser has no WebGL2");
    this.#A = t, this.#g = H(t, ne);
    const s = this.#g;
    this.#o = Object.fromEntries(
      Object.entries(re).map(([i, r]) => [
        i,
        t.getUniformLocation(s, r)
      ])
    ), this.#f = H(t, we), this.#a = t.getUniformLocation(this.#f, "uField"), this.#T = t.getUniformLocation(this.#f, "uFlip"), this.#n && this.#De(), this.canvas.addEventListener("webglcontextlost", this.#Ce), this.#se = new ResizeObserver(() => this.#ie()), e.addEventListener("emptied", this.#Re), e.addEventListener("resize", this.#Fe), e.addEventListener("pause", this.#b), e.addEventListener("ended", this.#b), e.addEventListener("seeked", this.#b), e.addEventListener("ratechange", this.#b);
  }
  get running() {
    return this.#p && (this.#s?.interlaced ?? !0);
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #ee() {
    return this.#s?.topFieldFirst !== !1;
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#ce;
  }
  set enabled(e) {
    this.#ce = e, this.#fe();
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const A = this.#s?.interlaced !== e?.interlaced, t = A || this.#s?.topFieldFirst !== e?.topFieldFirst;
    this.#s = e, t && (this.#i = 0, this.#w(), A && (this.#h = 0), this.#r = null, this.canvas.style.visibility = "hidden"), this.#fe(), t && (e?.interlaced ?? !0 ? this.#Q() : this.#j());
  }
  get scan() {
    return this.#s;
  }
  set videoTimeline(e) {
    this.#O = e, e.length === 0 && (this.#s = null), this.#fe();
  }
  get videoTimeline() {
    return this.#O;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#B ?? this.#t;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#d;
  }
  set doubleRate(e) {
    e !== this.#d && (this.#d = e, this.#e.length = 0, e ? (this.#c > 0 && this.#we(), (this.#s?.interlaced ?? !0) && this.#Q()) : this.#n || (this.#j(), this.#r = null, this.canvas.style.visibility = "hidden", this.#U()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#n;
  }
  set autoFilm(e) {
    e !== this.#n && (this.#n = e, this.#w(), e ? (this.#De(), this.#c > 0 && (this.#Me(), this.#we()), (this.#s?.interlaced ?? !0) && this.#Q()) : (this.#pe(), this.#d || (this.#j(), this.#r = null, this.canvas.style.visibility = "hidden", this.#U())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#H;
  }
  set filmCombThreshold(e) {
    const A = ee(e);
    A !== this.#H && (this.#H = A, this.#n && this.#w());
  }
  #fe() {
    this.#ce && (this.#O.length > 0 || (this.#s?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  start() {
    this.#p || this.#S || (this.#p = !0, this.#Se(), this.#w(), this.#He(), this.#te(), (this.#s?.interlaced ?? !0) && this.#Q());
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#p && (this.#p = !1, this.#I !== null && this.#t.cancelVideoFrameCallback(this.#I), this.#I = null, this.#j(), this.#i = 0, this.#r = null, this.canvas.style.visibility = "hidden");
  }
  destroy() {
    this.stop(), this.canvas.removeEventListener("webglcontextlost", this.#Ce), this.#t.removeEventListener("emptied", this.#Re), this.#t.removeEventListener("resize", this.#Fe), this.#t.removeEventListener("pause", this.#b), this.#t.removeEventListener("ended", this.#b), this.#t.removeEventListener("seeked", this.#b), this.#t.removeEventListener("ratechange", this.#b), this.#Xe();
    for (const e of this.#E) this.#A.deleteTexture(e);
    this.#E = [], this.#U(), this.#pe(), this.#A.deleteProgram(this.#g), this.#A.deleteProgram(this.#f), this.#D && this.#A.deleteProgram(this.#D), this.#y && this.#A.deleteProgram(this.#y), this.#M && this.#A.deleteProgram(this.#M), this.#A.getExtension("WEBGL_lose_context")?.loseContext();
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
    const e = this.#r;
    if (!this.#p || this.#S || !e)
      return createImageBitmap(this.#t);
    e.kind === "texture" ? this.#me(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#J(e.flush, e.second, null, !1) : this.#ue(null, !1);
    const A = this.#t.videoWidth, t = this.#t.videoHeight;
    return A > 0 && t > 0 && (A !== this.canvas.width || t !== this.canvas.height) ? createImageBitmap(this.canvas, {
      resizeWidth: A,
      resizeHeight: t,
      resizeQuality: "high"
    }) : createImageBitmap(this.canvas);
  }
  addEventListener(e, A, t) {
    super.addEventListener(e, A, t);
  }
  removeEventListener(e, A, t) {
    super.removeEventListener(e, A, t);
  }
  #te() {
    !this.#p || this.#I !== null || (this.#I = this.#t.requestVideoFrameCallback(this.#Le));
  }
  #Le = (e, A) => {
    if (this.#I = null, !(!this.#p || this.#S)) {
      if (this.#Be(A.mediaTime), A.width > 0 && A.height > 0) {
        if ((this.#c === 0 || this.#m === 0) && this.#ye(A.width, A.height), this.#s && !this.#s.interlaced) {
          this.#Ue(), this.#te();
          return;
        }
        const t = A.mediaTime - this.#z, s = t < 0 || t > ce;
        s && (this.#i = 0, this.#h = 0, this.#v.discontinuities++, this.#e.length = 0, this.#w());
        const i = this.#n && this.#_ !== 0 && A.presentedFrames - this.#_ > 1;
        if (this.#Ge(A.presentedFrames, s), !s && i && (this.#i = 0, this.#w()), this.#i > 0 && A.mediaTime === this.#z) {
          this.#te();
          return;
        }
        !s && t > 0 && this.#Pe(t), this.#z = A.mediaTime;
        const r = performance.now();
        r - this.#le > q && (this.#$ = r, this.#C = 0, this.#W = 0, this.#Y = 0, this.#Z = 0, this.#k = 0), this.#le = r;
        const a = performance.now();
        this.#Te();
        const n = this.#x, l = this.#n && this.#i === x && this.#Ie();
        if (n !== this.#x && (this.#e.length = 0), !(l && this.#Ae())) if (this.#n && !this.#ne && this.#x === "film")
          if (this.#Ae()) {
            const c = this.#h * 5 / 4, f = this.#e.at(-1), m = f == null ? e + c : f.at + f.duration;
            this.#_e(m, c);
          } else
            this.#ue(null);
        else if (this.#d && this.#Ae()) {
          const c = this.#h / 2, f = this.#e.at(-1), m = f == null ? e + c : f.at + f.duration;
          this.#ge(!1, m, c), this.#ge(!0, m + c, c);
        } else
          this.#v.late += this.#e.length, this.#e.length = 0, this.#J(!1, !1, null);
        this.#k = Math.max(
          this.#k,
          this.#e.length
        ), this.#W += performance.now() - a, this.#C++, this.#Ne(r);
      }
      this.#te();
    }
  };
  #Be(e) {
    let A;
    for (let i = this.#O.length - 1; i >= 0; i--) {
      const r = this.#O[i];
      if (r.start <= e + 1e-6) {
        A = r;
        break;
      }
    }
    A?.codedSize && (A.codedSize.width !== this.#c || A.codedSize.height !== this.#m) && this.#ye(A.codedSize.width, A.codedSize.height);
    const t = A?.scan;
    if (!t || this.#s?.interlaced === t.interlaced && this.#s.topFieldFirst === t.topFieldFirst)
      return;
    const s = this.#s?.interlaced;
    this.#s = t, this.#i = 0, this.#e.length = 0, this.#w(), s !== t.interlaced && (this.#h = 0), t.interlaced ? (this.#d || this.#n) && this.#Q() : this.#j();
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #Ae() {
    return (this.#d || this.#n) && this.#h > 0 && this.#u.length === L;
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
  #Pe(e) {
    const A = e * 1e3 / (this.#t.playbackRate || 1), t = this.#h > 0 ? Math.max(1, Math.round(A / this.#h)) : 1, s = A / t;
    s < fe || s > $ || (this.#h = this.#h > 0 ? this.#h + (s - this.#h) * ue : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #De() {
    if (this.#D && this.#y && this.#M) return;
    const e = this.#A, A = H(e, oe), t = H(e, ae), s = H(e, he);
    this.#D = A, this.#L = Object.fromEntries(
      Object.entries(Q).filter(([i]) => i !== "match" && i !== "topFieldFirst").map(([i, r]) => [i, e.getUniformLocation(A, r)])
    ), this.#y = t, this.#V = Object.fromEntries(
      Object.entries(Q).map(([i, r]) => [
        i,
        e.getUniformLocation(t, r)
      ])
    ), this.#M = s, this.#K = Object.fromEntries(
      Object.entries(Q).map(([i, r]) => [
        i,
        e.getUniformLocation(s, r)
      ])
    );
  }
  /**
   * Run FFmpeg's fieldmatch and live decimate decisions on reduced luma.
   * Full decoded frames remain in GPU textures, while the first readback packs
   * the previous, current and next luma proxies into RGB. A second readback
   * supplies the selected RGB weave to its chroma-sensitive decimate metric.
   */
  #Ie() {
    const e = this.#F, A = this.#D, t = this.#L, s = this.#M, i = this.#K;
    if (!e || !A || !t || !s || !i)
      return !1;
    const r = this.#A, a = this.#l, n = (this.#l + x - 1) % x, l = (this.#l + 1) % x, o = this.#ee;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(A);
    for (const [p, D] of [l, n, a].entries())
      r.activeTexture(r.TEXTURE0 + p), r.bindTexture(r.TEXTURE_2D, this.#E[D] ?? null);
    r.uniform1i(t.prev, 0), r.uniform1i(t.cur, 1), r.uniform1i(t.next, 2), r.uniform2i(t.size, this.#c, this.#m), r.viewport(0, 0, y, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      y,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: u, currentLuma: c, nextLuma: f } = e;
    for (let p = 0; p < u.length; p++) {
      const D = p * 4;
      u[p] = e.pixels[D] ?? 0, c[p] = e.pixels[D + 1] ?? 0, f[p] = e.pixels[D + 2] ?? 0;
    }
    const m = this.#oe.fieldMatch(
      u,
      c,
      f,
      o,
      this.#H
    );
    r.useProgram(s), r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#c, this.#m), r.uniform1i(i.topFieldFirst, o ? 1 : 0), r.uniform1i(
      i.match,
      m.match === "p" ? 0 : m.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      y,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const w = this.#oe.decimate(e.pixels);
    this.#X = m.match, this.#re = m.combScore, this.#ne = m.isCombed, this.#ae = w.lowestCycleDifference, this.#he = w.runnerUpCycleDifference;
    const v = w.dropIndex !== null && !m.isCombed;
    return (v ? "film" : "video") !== this.#x && (this.#x = v ? "film" : "video"), w.shouldDrop && !m.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #_e(e, A) {
    const t = this.#de();
    if (t === null) return;
    const s = this.#u[t];
    if (s) {
      for (this.#G = t; this.#e.length > 0 && this.#e[0]?.slot === t; )
        this.#e.shift(), this.#v.late++;
      this.#ue(s.framebuffer), this.#e.push({ slot: t, at: e, duration: A });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #ue(e, A = !0) {
    const t = this.#y, s = this.#V;
    if (!t || !s) return;
    const i = this.#A, r = this.#l, a = (this.#l + x - 1) % x, n = (this.#l + 1) % x, l = this.#ee;
    i.bindFramebuffer(i.FRAMEBUFFER, e), i.useProgram(t);
    for (const [o, u] of [n, a, r].entries())
      i.activeTexture(i.TEXTURE0 + o), i.bindTexture(i.TEXTURE_2D, this.#E[u] ?? null);
    i.uniform1i(s.prev, 0), i.uniform1i(s.cur, 1), i.uniform1i(s.next, 2), i.uniform2i(s.size, this.#c, this.#m), i.uniform1i(s.topFieldFirst, l ? 1 : 0), i.uniform1i(
      s.match,
      this.#X === "p" ? 0 : this.#X === "c" ? 1 : 2
    ), i.viewport(0, 0, this.#c, this.#m), i.drawArrays(i.TRIANGLES, 0, 3), e === null && (this.#r = { kind: "film" }, this.canvas.style.visibility = "visible", A && this.#P++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #ge(e, A, t) {
    const s = this.#de();
    if (s === null) return;
    const i = this.#u[s];
    if (i) {
      for (this.#G = s; this.#e.length > 0 && this.#e[0]?.slot === s; )
        this.#e.shift(), this.#v.late++;
      this.#J(!1, e, i.framebuffer), this.#e.push({ slot: s, at: A, duration: t });
    }
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #de() {
    const e = this.#r?.kind === "texture" ? this.#r.texture : null, A = new Set(this.#e.map(({ slot: s }) => s));
    for (let s = 1; s <= L; s++) {
      const i = (this.#G + s) % L, r = this.#u[i];
      if (r && r.texture !== e && !A.has(i))
        return i;
    }
    const t = this.#e[0];
    if (t) {
      const s = this.#u[t.slot];
      if (s && s.texture !== e) return t.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #Q() {
    this.#R === null && (!this.#p || this.#S || !this.#d && !this.#n || (this.#q = 0, this.#R = requestAnimationFrame(this.#xe)));
  }
  #j() {
    this.#R !== null && cancelAnimationFrame(this.#R), this.#R = null, this.#e.length = 0;
  }
  #xe = (e) => {
    if (this.#R = null, !(!this.#p || this.#S || !this.#d && !this.#n)) {
      if (this.#q > 0) {
        const A = e - this.#q;
        A >= 1 && A <= $ && (this.#N = A < this.#N ? A : this.#N + (A - this.#N) * me);
      }
      this.#q = e, this.#ke(e), this.#R = requestAnimationFrame(this.#xe);
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
  #ke(e) {
    const A = e + this.#N * 1.5;
    for (; this.#e[1] && this.#e[1].at <= A; )
      this.#v.late++, this.#e.shift();
    let t = this.#e[0];
    if (!t || t.at > A)
      return;
    this.#e.shift();
    const s = performance.now();
    this.#be(t.slot), this.#Z += performance.now() - s, this.#Y++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #be(e) {
    const A = this.#u[e];
    A && this.#me(A.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Ue() {
    this.#Te();
    const e = this.#E[this.#l];
    e && this.#me(e, !0), this.#i = 0;
  }
  #me(e, A = !1, t = !0) {
    const s = this.#A;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#f), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#a, 0), s.uniform1i(this.#T, A ? 1 : 0), s.viewport(0, 0, this.#c, this.#m), s.drawArrays(s.TRIANGLES, 0, 3), this.#r = { kind: "texture", texture: e, flip: A }, this.canvas.style.visibility = "visible", t && this.#P++;
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
  #Ge(e, A) {
    this.#_ !== 0 && !A && (this.#v.missed += Math.max(0, e - this.#_ - 1)), this.#_ = e;
  }
  #Ne(e) {
    const A = e - this.#$;
    if (A < q) return;
    const t = this.#Ae() && (this.#d || this.#x === "film") ? this.#Y : this.#C, s = {
      ...this.#v,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#t.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: t * 1e3 / A,
      frameMs: this.#C === 0 ? 0 : (this.#W + this.#Z) / this.#C,
      maxQueuedFields: this.#k,
      mode: this.#x,
      match: this.#X,
      combScore: this.#re,
      outputFps: this.#P * 1e3 / A,
      duplicateScore: this.#ae,
      duplicateRunnerUp: this.#he
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#ve?.(s), this.#$ = e, this.#C = 0, this.#W = 0, this.#Y = 0, this.#Z = 0, this.#k = 0, this.#P = 0;
  }
  /** Take the newest frame into the ring. */
  #Te() {
    const e = this.#A;
    this.#l = (this.#l + 1) % x, e.bindTexture(e.TEXTURE_2D, this.#E[this.#l] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#t
    ), this.#i = Math.min(this.#i + 1, x);
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
  #J(e, A, t, s = !0) {
    if (this.#i === 0 || this.#S) return;
    s && (this.#i === x && !e ? this.#v.filtered++ : this.#v.degraded++);
    const i = this.#A, r = this.#l, a = (this.#l + x - 1) % x, n = (this.#l + 1) % x;
    let l, o, u;
    this.#i === 1 ? l = o = u = r : e ? (l = a, o = u = r) : this.#i === 2 ? (l = o = a, u = r) : (l = n, o = a, u = r), i.bindFramebuffer(i.FRAMEBUFFER, t), i.useProgram(this.#g);
    for (const [f, m] of [l, o, u].entries())
      i.activeTexture(i.TEXTURE0 + f), i.bindTexture(i.TEXTURE_2D, this.#E[m] ?? null);
    i.uniform1i(this.#o.prev, 0), i.uniform1i(this.#o.cur, 1), i.uniform1i(this.#o.next, 2), i.uniform2i(this.#o.size, this.#c, this.#m);
    const c = this.#ee ? 0 : 1;
    i.uniform1i(this.#o.parity, A ? 1 - c : c), i.uniform1i(this.#o.tff, this.#ee ? 1 : 0), i.uniform1i(this.#o.spatialCheck, this.#Ee ? 1 : 0), i.viewport(0, 0, this.#c, this.#m), i.drawArrays(i.TRIANGLES, 0, 3), t === null && (this.#r = { kind: "yadif", flush: e, second: A }, this.canvas.style.visibility = "visible", s && this.#P++);
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
  #ie() {
    if (!this.#B) return;
    const e = this.#t, A = e.videoWidth, t = e.videoHeight;
    if (A === 0 || t === 0) return;
    const s = Math.min(
      e.offsetWidth / A,
      e.offsetHeight / t
    ), i = A * s, r = t * s;
    this.canvas.style.left = `${e.offsetLeft + (e.offsetWidth - i) / 2}px`, this.canvas.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.canvas.style.width = `${i}px`, this.canvas.style.height = `${r}px`;
  }
  #ye(e, A) {
    const t = this.#A;
    this.canvas.width = e, this.canvas.height = A, this.#c = e, this.#m = A, this.#i = 0, this.#r = null, this.#w(), this.#ie();
    for (const s of this.#E) t.deleteTexture(s);
    this.#E = [];
    for (let s = 0; s < x; s++) {
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
    this.#U(), this.#pe(), this.#n && this.#Me(), (this.#d || this.#n) && this.#we();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Me() {
    if (this.#F) return;
    const e = this.#A, A = e.createTexture();
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
    this.#F = {
      texture: A,
      framebuffer: t,
      pixels: new Uint8Array(y * M * 4),
      previousLuma: new Uint8Array(y * M),
      currentLuma: new Uint8Array(y * M),
      nextLuma: new Uint8Array(y * M)
    };
  }
  #pe() {
    this.#F && (this.#A.deleteFramebuffer(this.#F.framebuffer), this.#A.deleteTexture(this.#F.texture), this.#F = null);
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
  #we() {
    const e = this.#A;
    if (!(this.#u.length === L || this.#c === 0)) {
      this.#U();
      for (let A = 0; A < L; A++) {
        const t = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#c,
          this.#m,
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
          e.deleteFramebuffer(s), e.deleteTexture(t), this.#U();
          return;
        }
        this.#u.push({ texture: t, framebuffer: s });
      }
      this.#G = L - 1;
    }
  }
  #U() {
    const e = this.#A, A = this.#r?.kind === "texture" ? this.#r.texture : null;
    this.#u.some((t) => t.texture === A) && (this.#r = null);
    for (const { texture: t, framebuffer: s } of this.#u)
      e.deleteFramebuffer(s), e.deleteTexture(t);
    this.#u = [], this.#e.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #He() {
    if (this.#B) return;
    const e = this.#t.parentElement;
    if (!e) return;
    const A = document.createElement("div");
    A.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(A, this.#t), A.appendChild(this.#t), A.appendChild(this.canvas), this.#B = A, this.#se.observe(this.#t), this.#ie();
  }
  #Xe() {
    const e = this.#B;
    this.#B = null, this.#se.disconnect(), this.canvas.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#t, e), e.remove());
  }
  #Fe = () => this.#ie();
  #Re = () => {
    this.#i = 0, this.#z = 0, this.#e.length = 0, this.#h = 0, this.#Se(), this.#w(), this.#r = null, this.canvas.style.visibility = "hidden";
  };
  #Se() {
    this.#v = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#_ = 0, this.#$ = 0, this.#le = 0, this.#C = 0, this.#W = 0, this.#Y = 0, this.#Z = 0, this.#k = 0, this.#P = 0, this.#w();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #w() {
    this.#e.length = 0, this.#x = "video", this.#X = "c", this.#re = 0, this.#ne = !0, this.#oe.reset(), this.#ae = 1 / 0, this.#he = 1 / 0;
  }
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #b = (e) => {
    if (e.type === "seeked") {
      this.#i = 0, this.#w(), this.#r = null, this.canvas.style.visibility = "hidden";
      return;
    }
    if (e.type === "ratechange" && (this.#h = 0, this.#z = this.#t.currentTime), this.#e.length = 0, !this.#p || this.#i === 0) return;
    const A = this.#de(), t = A === null ? void 0 : this.#u[A];
    A !== null && t ? (this.#G = A, this.#J(!0, !1, t.framebuffer), this.#be(A)) : this.#J(!0, !1, null);
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Ce = (e) => {
    e.preventDefault(), this.#S = !0, this.stop();
  };
}
function H(h, e) {
  const A = h.createProgram(), t = te(h, h.VERTEX_SHADER, pe), s = te(h, h.FRAGMENT_SHADER, e);
  if (h.attachShader(A, t), h.attachShader(A, s), h.linkProgram(A), h.deleteShader(t), h.deleteShader(s), !h.getProgramParameter(A, h.LINK_STATUS)) {
    const i = h.getProgramInfoLog(A);
    throw h.deleteProgram(A), new Error(
      `the deinterlacer failed to link: ${i ?? "no reason given"}`
    );
  }
  return A;
}
function te(h, e, A) {
  const t = h.createShader(e);
  if (!t) throw new Error("the deinterlacer could not create a shader");
  if (h.shaderSource(t, A), h.compileShader(t), !h.getShaderParameter(t, h.COMPILE_STATUS)) {
    const s = h.getShaderInfoLog(t);
    throw h.deleteShader(t), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return t;
}
const Ae = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Ee = 0.5, ve = 3e3, ie = 0.1, _ = 16, se = 'video/mp4; codecs="avc1.640029"';
let J = null;
function De(h = {}) {
  return J ??= ge(h), J;
}
async function Re(h = {}) {
  return (await De(h)).deinterlaces;
}
function Se() {
  J = null;
}
async function ge(h) {
  const e = h.tolerance ?? Ee, A = h.timeoutMs ?? ve, t = performance.now(), s = (a) => ({
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
    const l = ye(i);
    return {
      deinterlaces: l < 1 - e,
      survives: l,
      tookMs: performance.now() - t
    };
  } catch (a) {
    return s(a);
  } finally {
    i.pause(), i.removeAttribute("src"), i.replaceChildren(), i.load(), r && URL.revokeObjectURL(r.url);
  }
}
const j = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, xe = typeof MediaSource > "u";
function be(h, e) {
  if (!j || !j.isTypeSupported(se))
    throw new Error("the probe clip needs Media Source Extensions");
  const A = Ae.indexOf(","), t = atob(Ae.slice(A + 1)), s = new Uint8Array(t.length);
  for (let n = 0; n < t.length; n++) s[n] = t.charCodeAt(n);
  const i = new j(), r = URL.createObjectURL(i);
  if (xe) {
    h.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, h.append(n), h.load();
  } else
    h.src = r;
  const a = (async () => {
    await O(z(i, "sourceopen"), e);
    const n = i.addSourceBuffer(se), l = O(z(n, "updateend"), e);
    n.appendBuffer(s), await l, i.endOfStream();
  })();
  return { url: r, ready: a };
}
async function Te(h, e, A) {
  if (A) {
    const t = performance.now();
    for (; h.currentTime < ie && performance.now() - t < e; )
      await new Promise((s) => requestAnimationFrame(s));
    h.pause();
  } else
    h.currentTime = ie, await O(z(h, "seeked"), e);
}
function ye(h) {
  const e = h.videoHeight, A = document.createElement("canvas");
  A.width = _, A.height = e;
  const t = A.getContext("2d", { willReadFrequently: !0 });
  if (!t) throw new Error("there is no 2d context to read the clip with");
  t.imageSmoothingEnabled = !1, t.drawImage(h, 0, 0, _, e);
  const s = t.getImageData(0, 0, _, e).data, i = (o) => {
    let u = 0;
    for (let c = 0; c < _; c++)
      u += s[(o * _ + c) * 4 + 1] ?? 0;
    return u / _;
  };
  let r = 0;
  const a = 2, n = e - 3;
  let l = i(a);
  for (let o = a + 1; o <= n; o++) {
    const u = i(o);
    r += Math.abs(u - l), l = u;
  }
  return r / (n - a) / 255;
}
function z(h, e) {
  return new Promise((A, t) => {
    h.addEventListener(e, () => A(), { once: !0 }), h.addEventListener(
      "error",
      () => {
        const s = h instanceof HTMLMediaElement ? h.error : null, i = s ? ` (MediaError ${s.code}${s.message ? `: ${s.message}` : ""})` : "";
        t(new Error(`the probe clip ${e} failed${i}`));
      },
      { once: !0 }
    );
  });
}
function O(h, e) {
  return Promise.race([
    h,
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
  oe as FILM_ANALYSIS_FRAGMENT_SHADER,
  he as FILM_SAMPLE_FRAGMENT_SHADER,
  Q as FILM_UNIFORMS,
  ae as FILM_WEAVE_FRAGMENT_SHADER,
  ne as YADIF_FRAGMENT_SHADER,
  re as YADIF_UNIFORMS,
  Re as decoderDeinterlaces,
  Se as forgetDecoderProbe,
  De as probeDecoder,
  Me as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
