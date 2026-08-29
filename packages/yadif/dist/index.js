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
}, y = 160, M = 90, oe = `#version 300 es
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
  #n = 0;
  #l = null;
  #o = [];
  #b = null;
  #D = 1 / 0;
  #C = 1 / 0;
  constructor(e, A) {
    this.#t = e, this.#A = A, this.#g = 255 * g.DECIMATE_BLOCK ** 2 * g.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the exact
   * matching arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, A, t, s, i = g.COMBED_PIXEL_LIMIT) {
    const r = s ? 1 : 0, a = { p: e, c: A, n: t };
    let o = this.#T("c", "p", r, a);
    const c = /* @__PURE__ */ new Map(), n = (w) => {
      const v = c.get(w);
      if (v !== void 0) return v;
      const p = g.#y(
        this.weave(e, A, t, w, s),
        this.#t,
        this.#A
      );
      return c.set(w, p), p;
    }, f = n(o), l = n("n");
    (l * 3 < f || l * 2 < f && f > i) && Math.abs(l - f) >= 30 && l < i && (o = "n");
    const u = n(o), m = u >= i;
    return m && (o = "c"), {
      match: o,
      combScore: u,
      isCombed: m,
      luma: this.weave(e, A, t, o, s)
    };
  }
  /** Apply `decimate=cycle=5:mixed=1` metrics without delaying live audio. */
  decimate(e) {
    const A = this.#n, t = this.#b ? g.#J(
      this.#b,
      e,
      this.#t,
      this.#A
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#o.push(t);
    const s = this.#l === A, i = s && t.maxBlockDifference < this.#g;
    s && !i && (this.#l = null);
    const r = this.#l;
    this.#b = e.slice(), this.#n++;
    let a = this.#l;
    if (this.#n === g.CYCLE) {
      let o = 0, c = null;
      for (let n = 1; n < this.#o.length; n++)
        (this.#o[n]?.maxBlockDifference ?? 1 / 0) < (this.#o[o]?.maxBlockDifference ?? 1 / 0) ? (c = o, o = n) : (c === null || (this.#o[n]?.maxBlockDifference ?? 1 / 0) < (this.#o[c]?.maxBlockDifference ?? 1 / 0)) && (c = n);
      this.#D = this.#o[o]?.maxBlockDifference ?? 1 / 0, this.#C = c === null ? 1 / 0 : this.#o[c]?.maxBlockDifference ?? 1 / 0, a = (this.#o[o]?.maxBlockDifference ?? 1 / 0) < this.#g ? o : null, this.#l = a, this.#o = [], this.#n = 0;
    }
    return {
      cycleIndex: A,
      maxBlockDifference: t.maxBlockDifference,
      totalDifference: t.totalDifference,
      shouldDrop: i,
      dropIndex: r,
      nextDropIndex: a,
      lowestCycleDifference: this.#D,
      runnerUpCycleDifference: this.#C
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, A, t, s, i) {
    if (s === "c") return A.slice();
    const r = A.slice(), a = s === "p" ? e : t, o = r.length / this.#A, c = i ? 1 : 0;
    for (let n = c; n < this.#A; n += 2)
      r.set(
        a.subarray(n * o, (n + 1) * o),
        n * o
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#n = 0, this.#l = null, this.#o = [], this.#b = null, this.#D = 1 / 0, this.#C = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #T(e, A, t, s) {
    const i = this.#t, r = this.#A, a = 2 - t, o = 2 - t, c = s[e], n = s[A], f = g.#j(
      c,
      n,
      i,
      r,
      t
    );
    let l = 0, u = 0, m = 0, w = 0, v = 0, p = 0;
    for (let S = 2; S < r - 2; S += 2) {
      const b = (S - 2) / 2, W = a - 1 + b * 2, Y = a + 1 + b * 2, Z = a + 3 + b * 2, H = a + b * 2, N = H + 2, L = o + b * 2, R = L + 2, q = a + b * 2;
      for (let T = 8; T < i - 8; T++) {
        const C = (f[q * i + T] ?? 0) | (f[(q + 2) * i + T] ?? 0);
        if (C === 0) continue;
        const K = (s.c[W * i + T] ?? 0) + ((s.c[Y * i + T] ?? 0) << 2) + (s.c[Z * i + T] ?? 0), P = Math.abs(
          3 * ((c[H * i + T] ?? 0) + (c[N * i + T] ?? 0)) - K
        ), I = Math.abs(
          3 * ((n[L * i + T] ?? 0) + (n[R * i + T] ?? 0)) - K
        );
        P > 23 && (C & 1) !== 0 && (l += P), I > 23 && (C & 1) !== 0 && (w += I), P > 42 && (C & 2) !== 0 && (u += P), I > 42 && (C & 2) !== 0 && (v += I), P > 42 && (C & 4) !== 0 && (m += P), I > 42 && (C & 4) !== 0 && (p += I);
      }
    }
    u < 500 && v < 500 && (m >= 500 || p >= 500) && Math.max(m, p) > 3 * Math.min(m, p) && (u = m, v = p);
    const D = Math.floor(l / 6 + 0.5), F = Math.floor(w / 6 + 0.5), E = Math.floor(u / 6 + 0.5), d = Math.floor(v / 6 + 0.5), k = Math.max(D, F) / Math.max(Math.min(D, F), 1), U = Math.max(E, d) / Math.max(Math.min(E, d), 1), G = Math.max(E, d) / Math.max(Math.max(D, F), 1);
    return (E >= 500 || d >= 500) && (E * 2 < d || d * 2 < E) || (E >= 1e3 || d >= 1e3) && (E * 3 < d * 2 || d * 3 < E * 2) || (E >= 2e3 || d >= 2e3) && (E * 5 < d * 4 || d * 5 < E * 4) || (E >= 4e3 || d >= 4e3) && U > k || G > 5e-3 && Math.max(E, d) > 150 && (E * 2 < d || d * 2 < E) ? E > d ? A : e : D > F ? A : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #j(e, A, t, s, i) {
    const r = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(t)
    ), a = i === 1 ? 1 : 0;
    for (let n = 0; n < r.length; n++) {
      const f = Math.min(s - 1, a + n * 2), l = r[n];
      if (l)
        for (let u = 0; u < t; u++)
          l[u] = Math.abs(
            (e[f * t + u] ?? 0) - (A[f * t + u] ?? 0)
          );
    }
    const o = new Uint8Array(t * s), c = i === 1 ? 3 : 2;
    for (let n = 1; n < r.length - 1; n++) {
      const f = c + (n - 1) * 2;
      if (f >= s) break;
      const l = r[n];
      if (l)
        for (let u = 1; u < t - 1; u++) {
          const m = l[u] ?? 0;
          if (m <= 3) continue;
          let w = 0;
          for (let d = u - 1; d <= u + 1; d++)
            w += (r[n - 1]?.[d] ?? 0) > 3 ? 1 : 0, w += (r[n]?.[d] ?? 0) > 3 ? 1 : 0, w += (r[n + 1]?.[d] ?? 0) > 3 ? 1 : 0;
          if (w <= 1) continue;
          const v = f * t + u;
          if (o[v] = 1, m <= 19) continue;
          w = 0;
          let p = !1, D = !1;
          for (let d = u - 1; d <= u + 1; d++)
            (r[n - 1]?.[d] ?? 0) > 19 && (w++, p = !0), (r[n]?.[d] ?? 0) > 19 && w++, (r[n + 1]?.[d] ?? 0) > 19 && (w++, D = !0);
          if (w <= 3) continue;
          if (p && D) {
            o[v] |= 2;
            continue;
          }
          let F = !1, E = !1;
          for (let d = Math.max(u - 4, 0); d < Math.min(u + 5, t); d++)
            n !== 1 && (r[n - 2]?.[d] ?? 0) > 19 && (F = !0), (r[n - 1]?.[d] ?? 0) > 19 && (p = !0), (r[n + 1]?.[d] ?? 0) > 19 && (D = !0), n !== r.length - 2 && (r[n + 2]?.[d] ?? 0) > 19 && (E = !0);
          p && (D || F) || D && (p || E) ? o[v] |= 2 : w > 5 && (o[v] |= 4);
        }
    }
    return o;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #y(e, A, t) {
    const s = new Uint8Array(A * t), i = (a, o) => e[Math.max(0, Math.min(t - 1, o)) * A + a] ?? 0;
    for (let a = 0; a < t; a++)
      for (let o = 0; o < A; o++) {
        const c = i(o, a), n = i(o, a === 0 ? 1 : a - 1), f = i(o, a === t - 1 ? t - 2 : a + 1), l = a < 2 ? i(o, a === 0 ? 2 : 3) : i(o, a - 2), u = a + 2 >= t ? i(o, a === t - 1 ? t - 3 : t - 4) : i(o, a + 2);
        (a === 0 ? Math.abs(c - f) > g.COMB_THRESHOLD : a === t - 1 ? Math.abs(c - n) > g.COMB_THRESHOLD : Math.abs(c - n) > g.COMB_THRESHOLD && Math.abs(c - f) > g.COMB_THRESHOLD) && Math.abs(
          4 * c - 3 * (n + f) + l + u
        ) > g.COMB_THRESHOLD * 6 && (s[a * A + o] = 255);
      }
    let r = 0;
    for (const a of [0, 8])
      for (const o of [0, 8])
        for (let c = a; c < t; c += 16)
          for (let n = o; n < A; n += 16) {
            let f = 0;
            for (let l = Math.max(1, c); l < Math.min(t - 1, c + 16); l++)
              for (let u = n; u < Math.min(A, n + 16); u++) {
                const m = l * A + u;
                s[m - A] === 255 && s[m] === 255 && s[m + A] === 255 && f++;
              }
            r = Math.max(r, f);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #J(e, A, t, s) {
    const i = g.DECIMATE_BLOCK / 2, r = Math.ceil(t / i), a = Math.ceil(s / i), o = new Float64Array(r * a), c = e.length / (t * s);
    for (let l = 0; l < s; l++) {
      const u = Math.floor(l / i);
      for (let m = 0; m < t; m++) {
        const w = Math.floor(m / i), v = u * r + w, p = (l * t + m) * c;
        if (c === 1) {
          o[v] = (o[v] ?? 0) + Math.abs((e[p] ?? 0) - (A[p] ?? 0));
          continue;
        }
        const D = Math.round(
          (e[p] ?? 0) * 0.2126 + (e[p + 1] ?? 0) * 0.7152 + (e[p + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (A[p] ?? 0) * 0.2126 + (A[p + 1] ?? 0) * 0.7152 + (A[p + 2] ?? 0) * 0.0722
        );
        if (o[v] = (o[v] ?? 0) + Math.abs(D - F), (m & 1) !== 0 || (l & 1) !== 0) continue;
        let E = 0, d = 0, k = 0, U = 0, G = 0, S = 0, b = 0;
        for (let N = l; N < Math.min(l + 2, s); N++)
          for (let L = m; L < Math.min(m + 2, t); L++) {
            const R = (N * t + L) * c;
            E += e[R] ?? 0, d += e[R + 1] ?? 0, k += e[R + 2] ?? 0, U += A[R] ?? 0, G += A[R + 1] ?? 0, S += A[R + 2] ?? 0, b++;
          }
        const W = Math.round(
          (-0.114572 * E - 0.385428 * d + 0.5 * k) / b
        ), Y = Math.round(
          (-0.114572 * U - 0.385428 * G + 0.5 * S) / b
        ), Z = Math.round(
          (0.5 * E - 0.454153 * d - 0.045847 * k) / b
        ), H = Math.round(
          (0.5 * U - 0.454153 * G - 0.045847 * S) / b
        );
        o[v] = (o[v] ?? 0) + Math.abs(W - Y) + Math.abs(Z - H);
      }
    }
    let n = -1;
    for (let l = 0; l < a - 1; l++)
      for (let u = 0; u < r - 1; u++)
        n = Math.max(
          n,
          (o[l * r + u] ?? 0) + (o[l * r + u + 1] ?? 0) + (o[(l + 1) * r + u] ?? 0) + (o[(l + 1) * r + u + 1] ?? 0)
        );
    let f = 0;
    for (const l of o) f += l;
    return { maxBlockDifference: n, totalDifference: f };
  }
}
const ce = 0.5, x = 3, J = 5, B = J + 1, $ = 1e3, le = 4, fe = 200, ue = 0.25;
function ee(h) {
  if (!Number.isFinite(h) || h < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return h;
}
const de = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, me = `#version 300 es
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
function Te() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class ye extends EventTarget {
  canvas;
  #t;
  #A;
  #g;
  #n;
  /** The program that copies a filtered picture onto the canvas. */
  #l;
  #o;
  #b;
  /** The reduced pass that reads previous, current and next luma together. */
  #D = null;
  #C = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #T = null;
  #j = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #y = null;
  #J = null;
  #M = null;
  #w = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #f = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #G = B - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #h = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #e = [];
  /** The rAF loop that puts them up, which is all that draws on the canvas. */
  #F = null;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #B = null;
  #se;
  #u;
  #i;
  #N;
  #pe;
  #L = "video";
  #X = "c";
  #re = 0;
  #V = !0;
  #ne = new g(y, M);
  #oe = 1 / 0;
  #ae = 1 / 0;
  #P = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #E = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #a = 0;
  #d = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #c = x - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #s = 0;
  #q = 0;
  #I = null;
  #m = !1;
  #he = !1;
  #r = null;
  #H = [];
  #R = !1;
  #we;
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #p = {
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
  #ce = 0;
  #K = 0;
  #S = 0;
  #z = 0;
  #O = 0;
  #W = 0;
  #k = 0;
  constructor(e, A = {}) {
    super(), this.#t = e, this.#u = A.doubleRate ?? !1, this.#i = A.autoFilm ?? !1, this.#N = ee(
      A.filmCombThreshold ?? g.COMBED_PIXEL_LIMIT
    ), this.#pe = A.spatialCheck ?? !0, this.#we = A.onStats, this.canvas = document.createElement("canvas"), this.canvas.style.cssText = "position:absolute;pointer-events:none;visibility:hidden";
    const t = this.canvas.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!t) throw new Error("this browser has no WebGL2");
    this.#A = t, this.#g = X(t, ne);
    const s = this.#g;
    this.#n = Object.fromEntries(
      Object.entries(re).map(([i, r]) => [
        i,
        t.getUniformLocation(s, r)
      ])
    ), this.#l = X(t, me), this.#o = t.getUniformLocation(this.#l, "uField"), this.#b = t.getUniformLocation(this.#l, "uFlip"), this.#i && this.#Ee(), this.canvas.addEventListener("webglcontextlost", this.#Re), this.#se = new ResizeObserver(() => this.#ie()), e.addEventListener("emptied", this.#Me), e.addEventListener("resize", this.#ye), e.addEventListener("pause", this.#x), e.addEventListener("ended", this.#x), e.addEventListener("seeked", this.#x), e.addEventListener("ratechange", this.#x);
  }
  get running() {
    return this.#m && (this.#r?.interlaced ?? !0);
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #$() {
    return this.#r?.topFieldFirst !== !1;
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#he;
  }
  set enabled(e) {
    this.#he = e, this.#le();
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const A = this.#r?.interlaced !== e?.interlaced || this.#r?.topFieldFirst !== e?.topFieldFirst;
    this.#r = e, A && (this.#s = 0, this.#v(), this.#h = null, this.canvas.style.visibility = "hidden"), this.#le(), A && (e?.interlaced ?? !0 ? this.#Y() : this.#Z());
  }
  get scan() {
    return this.#r;
  }
  set videoTimeline(e) {
    this.#H = e, e.length === 0 && (this.#r = null), this.#le();
  }
  get videoTimeline() {
    return this.#H;
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
    return this.#u;
  }
  set doubleRate(e) {
    e !== this.#u && (this.#u = e, e ? (this.#a > 0 && this.#me(), this.#Y()) : this.#i || (this.#Z(), this.#U()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#i;
  }
  set autoFilm(e) {
    e !== this.#i && (this.#i = e, this.#v(), e ? (this.#Ee(), this.#a > 0 && (this.#Te(), this.#me()), (this.#r?.interlaced ?? !0) && this.#Y()) : (this.#de(), this.#u || (this.#Z(), this.#U())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#N;
  }
  set filmCombThreshold(e) {
    const A = ee(e);
    A !== this.#N && (this.#N = A, this.#i && this.#v());
  }
  #le() {
    this.#he && (this.#H.length > 0 || (this.#r?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  start() {
    this.#m || this.#R || (this.#m = !0, this.#Fe(), this.#v(), this.#Ge(), this.#ee(), (this.#r?.interlaced ?? !0) && this.#Y());
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#m && (this.#m = !1, this.#I !== null && this.#t.cancelVideoFrameCallback(this.#I), this.#I = null, this.#Z(), this.#s = 0, this.#h = null, this.canvas.style.visibility = "hidden");
  }
  destroy() {
    this.stop(), this.canvas.removeEventListener("webglcontextlost", this.#Re), this.#t.removeEventListener("emptied", this.#Me), this.#t.removeEventListener("resize", this.#ye), this.#t.removeEventListener("pause", this.#x), this.#t.removeEventListener("ended", this.#x), this.#t.removeEventListener("seeked", this.#x), this.#t.removeEventListener("ratechange", this.#x), this.#Ne();
    for (const e of this.#w) this.#A.deleteTexture(e);
    this.#w = [], this.#U(), this.#de(), this.#A.deleteProgram(this.#g), this.#A.deleteProgram(this.#l), this.#D && this.#A.deleteProgram(this.#D), this.#T && this.#A.deleteProgram(this.#T), this.#y && this.#A.deleteProgram(this.#y), this.#A.getExtension("WEBGL_lose_context")?.loseContext();
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
    const e = this.#h;
    if (!this.#m || this.#R || !e)
      return createImageBitmap(this.#t);
    e.kind === "texture" ? this.#ue(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#Q(e.flush, e.second, null, !1) : this.#Ae(null, !1);
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
  #ee() {
    !this.#m || this.#I !== null || (this.#I = this.#t.requestVideoFrameCallback(this.#Se));
  }
  #Se = (e, A) => {
    if (this.#I = null, !(!this.#m || this.#R)) {
      if (this.#Ce(A.mediaTime), A.width > 0 && A.height > 0) {
        if ((this.#a === 0 || this.#d === 0) && this.#be(A.width, A.height), this.#r && !this.#r.interlaced) {
          this.#_e(), this.#ee();
          return;
        }
        const t = A.mediaTime - this.#q, s = t < 0 || t > ce;
        s && (this.#s = 0, this.#p.discontinuities++, this.#e.length = 0, this.#v());
        const i = this.#i && this.#_ !== 0 && A.presentedFrames - this.#_ > 1;
        if (this.#ke(A.presentedFrames, s), !s && i && (this.#s = 0, this.#v()), this.#s > 0 && A.mediaTime === this.#q) {
          this.#ee();
          return;
        }
        !s && t > 0 && this.#Be(t), this.#q = A.mediaTime;
        const r = performance.now();
        r - this.#ce > $ && (this.#K = r, this.#S = 0, this.#z = 0, this.#O = 0, this.#W = 0, this.#k = 0), this.#ce = r;
        const a = performance.now();
        if (this.#xe(), this.#k = Math.max(
          this.#k,
          this.#e.length
        ), !(this.#i && this.#s === x && this.#Le() && this.#te())) if (this.#i && !this.#V && this.#L === "film")
          if (this.#te()) {
            const n = this.#E * 5 / 4;
            this.#e.length >= J && (this.#e.length = 0, this.#p.queueResetted += 1);
            const f = this.#e.at(-1), l = f != null ? f.at + f.duration : e;
            this.#Pe(l, n);
          } else
            this.#Ae(null);
        else if (this.#u && this.#te()) {
          const n = this.#E / 2;
          this.#e.length >= J && (this.#e.length = 0, this.#p.queueResetted += 1);
          const f = this.#e.at(-1), l = f != null ? f.at + f.duration : e;
          this.#ve(!1, l, n), this.#ve(!0, l + n, n);
        } else
          this.#Q(!1, !1, null);
        this.#z += performance.now() - a, this.#S++, this.#Ue(r);
      }
      this.#ee();
    }
  };
  #Ce(e) {
    let A;
    for (let s = this.#H.length - 1; s >= 0; s--) {
      const i = this.#H[s];
      if (i.start <= e + 1e-6) {
        A = i;
        break;
      }
    }
    A?.codedSize && (A.codedSize.width !== this.#a || A.codedSize.height !== this.#d) && this.#be(A.codedSize.width, A.codedSize.height);
    const t = A?.scan;
    !t || this.#r?.interlaced === t.interlaced && this.#r.topFieldFirst === t.topFieldFirst || (this.#r = t, this.#s = 0, this.#e.length = 0, this.#v(), t.interlaced ? (this.#u || this.#i) && this.#Y() : this.#Z());
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #te() {
    return (this.#u || this.#i) && this.#E > 0 && this.#f.length === B;
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
  #Be(e) {
    const A = e * 1e3 / (this.#t.playbackRate || 1), t = this.#E > 0 ? Math.max(1, Math.round(A / this.#E)) : 1, s = A / t;
    s < le || s > fe || (this.#E = this.#E > 0 ? this.#E + (s - this.#E) * ue : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #Ee() {
    if (this.#D && this.#T && this.#y) return;
    const e = this.#A, A = X(e, oe), t = X(e, ae), s = X(e, he);
    this.#D = A, this.#C = Object.fromEntries(
      Object.entries(Q).filter(([i]) => i !== "match" && i !== "topFieldFirst").map(([i, r]) => [i, e.getUniformLocation(A, r)])
    ), this.#T = t, this.#j = Object.fromEntries(
      Object.entries(Q).map(([i, r]) => [
        i,
        e.getUniformLocation(t, r)
      ])
    ), this.#y = s, this.#J = Object.fromEntries(
      Object.entries(Q).map(([i, r]) => [
        i,
        e.getUniformLocation(s, r)
      ])
    );
  }
  /**
   * Run FFmpeg's fieldmatch and mixed decimate decisions on reduced luma.
   * Full decoded frames remain in GPU textures, while the first readback packs
   * the previous, current and next luma proxies into RGB. A second readback
   * supplies the selected RGB weave to its chroma-sensitive decimate metric.
   */
  #Le() {
    const e = this.#M, A = this.#D, t = this.#C, s = this.#y, i = this.#J;
    if (!e || !A || !t || !s || !i)
      return !1;
    const r = this.#A, a = this.#c, o = (this.#c + x - 1) % x, c = (this.#c + 1) % x, n = this.#$;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(A);
    for (const [p, D] of [c, o, a].entries())
      r.activeTexture(r.TEXTURE0 + p), r.bindTexture(r.TEXTURE_2D, this.#w[D] ?? null);
    r.uniform1i(t.prev, 0), r.uniform1i(t.cur, 1), r.uniform1i(t.next, 2), r.uniform2i(t.size, this.#a, this.#d), r.viewport(0, 0, y, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      y,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const f = new Uint8Array(
      y * M
    ), l = new Uint8Array(
      y * M
    ), u = new Uint8Array(y * M);
    for (let p = 0; p < f.length; p++) {
      const D = p * 4;
      f[p] = e.pixels[D] ?? 0, l[p] = e.pixels[D + 1] ?? 0, u[p] = e.pixels[D + 2] ?? 0;
    }
    const m = this.#ne.fieldMatch(
      f,
      l,
      u,
      n,
      this.#N
    );
    r.useProgram(s), r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#a, this.#d), r.uniform1i(i.topFieldFirst, n ? 1 : 0), r.uniform1i(
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
    const w = this.#ne.decimate(e.pixels);
    this.#X = m.match, this.#re = m.combScore, this.#V = m.isCombed, this.#oe = w.lowestCycleDifference, this.#ae = w.runnerUpCycleDifference;
    const v = w.dropIndex !== null && !m.isCombed;
    return (v ? "film" : "video") !== this.#L && (this.#L = v ? "film" : "video"), w.shouldDrop && !m.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Pe(e, A) {
    const t = this.#fe();
    if (t === null) return;
    const s = this.#f[t];
    if (s) {
      for (this.#G = t; this.#e.length > 0 && this.#e[0]?.slot === t; )
        this.#e.shift(), this.#p.late++;
      this.#Ae(s.framebuffer), this.#e.push({ slot: t, at: e, duration: A });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Ae(e, A = !0) {
    const t = this.#T, s = this.#j;
    if (!t || !s) return;
    const i = this.#A, r = this.#c, a = (this.#c + x - 1) % x, o = (this.#c + 1) % x, c = this.#$;
    i.bindFramebuffer(i.FRAMEBUFFER, e), i.useProgram(t);
    for (const [n, f] of [o, a, r].entries())
      i.activeTexture(i.TEXTURE0 + n), i.bindTexture(i.TEXTURE_2D, this.#w[f] ?? null);
    i.uniform1i(s.prev, 0), i.uniform1i(s.cur, 1), i.uniform1i(s.next, 2), i.uniform2i(s.size, this.#a, this.#d), i.uniform1i(s.topFieldFirst, c ? 1 : 0), i.uniform1i(
      s.match,
      this.#X === "p" ? 0 : this.#X === "c" ? 1 : 2
    ), i.viewport(0, 0, this.#a, this.#d), i.drawArrays(i.TRIANGLES, 0, 3), e === null && (this.#h = { kind: "film" }, this.canvas.style.visibility = "visible", A && this.#P++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #ve(e, A, t) {
    const s = this.#fe();
    if (s === null) return;
    const i = this.#f[s];
    if (i) {
      for (this.#G = s; this.#e.length > 0 && this.#e[0]?.slot === s; )
        this.#e.shift(), this.#p.late++;
      this.#Q(!1, e, i.framebuffer), this.#e.push({ slot: s, at: A, duration: t });
    }
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #fe() {
    const e = this.#h?.kind === "texture" ? this.#h.texture : null, A = new Set(this.#e.map(({ slot: s }) => s));
    for (let s = 1; s <= B; s++) {
      const i = (this.#G + s) % B, r = this.#f[i];
      if (r && r.texture !== e && !A.has(i))
        return i;
    }
    const t = this.#e[0];
    if (t) {
      const s = this.#f[t.slot];
      if (s && s.texture !== e) return t.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #Y() {
    this.#F === null && (!this.#m || this.#R || !this.#u && !this.#i || (this.#F = requestAnimationFrame(this.#De)));
  }
  #Z() {
    this.#F !== null && cancelAnimationFrame(this.#F), this.#F = null, this.#e.length = 0;
  }
  #De = (e) => {
    this.#F = null, !(!this.#m || this.#R || !this.#u && !this.#i) && (this.#Ie(e), this.#F = requestAnimationFrame(this.#De));
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
  #Ie(e) {
    for (; this.#e[1] && this.#e[1].at - e <= 3; )
      this.#p.late++, this.#e.shift();
    let t = this.#e[0];
    if (!t || t.at - e > 3)
      return;
    this.#e.shift();
    const s = performance.now();
    this.#ge(t.slot), this.#W += performance.now() - s, this.#O++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #ge(e) {
    const A = this.#f[e];
    A && this.#ue(A.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #_e() {
    this.#xe();
    const e = this.#w[this.#c];
    e && this.#ue(e, !0), this.#s = 0;
  }
  #ue(e, A = !1, t = !0) {
    const s = this.#A;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#l), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#o, 0), s.uniform1i(this.#b, A ? 1 : 0), s.viewport(0, 0, this.#a, this.#d), s.drawArrays(s.TRIANGLES, 0, 3), this.#h = { kind: "texture", texture: e, flip: A }, this.canvas.style.visibility = "visible", t && this.#P++;
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
  #ke(e, A) {
    this.#_ !== 0 && !A && (this.#p.missed += Math.max(0, e - this.#_ - 1)), this.#_ = e;
  }
  #Ue(e) {
    const A = e - this.#K;
    if (A < $) return;
    const t = this.#te() ? this.#O : this.#S, s = {
      ...this.#p,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#t.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: t * 1e3 / A,
      frameMs: this.#S === 0 ? 0 : (this.#z + this.#W) / this.#S,
      maxQueuedFields: this.#k,
      mode: this.#L,
      match: this.#X,
      combScore: this.#re,
      outputFps: this.#P * 1e3 / A,
      duplicateScore: this.#oe,
      duplicateRunnerUp: this.#ae
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#we?.(s), this.#K = e, this.#S = 0, this.#z = 0, this.#O = 0, this.#W = 0, this.#k = 0, this.#P = 0;
  }
  /** Take the newest frame into the ring. */
  #xe() {
    const e = this.#A;
    this.#c = (this.#c + 1) % x, e.bindTexture(e.TEXTURE_2D, this.#w[this.#c] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#t
    ), this.#s = Math.min(this.#s + 1, x);
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
  #Q(e, A, t, s = !0) {
    if (this.#s === 0 || this.#R) return;
    s && (this.#s === x && !e ? this.#p.filtered++ : this.#p.degraded++);
    const i = this.#A, r = this.#c, a = (this.#c + x - 1) % x, o = (this.#c + 1) % x;
    let c, n, f;
    this.#s === 1 ? c = n = f = r : e ? (c = a, n = f = r) : this.#s === 2 ? (c = n = a, f = r) : (c = o, n = a, f = r), i.bindFramebuffer(i.FRAMEBUFFER, t), i.useProgram(this.#g);
    for (const [u, m] of [c, n, f].entries())
      i.activeTexture(i.TEXTURE0 + u), i.bindTexture(i.TEXTURE_2D, this.#w[m] ?? null);
    i.uniform1i(this.#n.prev, 0), i.uniform1i(this.#n.cur, 1), i.uniform1i(this.#n.next, 2), i.uniform2i(this.#n.size, this.#a, this.#d);
    const l = this.#$ ? 0 : 1;
    i.uniform1i(this.#n.parity, A ? 1 - l : l), i.uniform1i(this.#n.tff, this.#$ ? 1 : 0), i.uniform1i(this.#n.spatialCheck, this.#pe ? 1 : 0), i.viewport(0, 0, this.#a, this.#d), i.drawArrays(i.TRIANGLES, 0, 3), t === null && (this.#h = { kind: "yadif", flush: e, second: A }, this.canvas.style.visibility = "visible", s && this.#P++);
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
  #be(e, A) {
    const t = this.#A;
    this.canvas.width = e, this.canvas.height = A, this.#a = e, this.#d = A, this.#s = 0, this.#h = null, this.#v(), this.#ie();
    for (const s of this.#w) t.deleteTexture(s);
    this.#w = [];
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
      ), this.#w.push(i);
    }
    this.#U(), this.#de(), this.#i && this.#Te(), (this.#u || this.#i) && this.#me();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Te() {
    if (this.#M) return;
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
    this.#M = {
      texture: A,
      framebuffer: t,
      pixels: new Uint8Array(y * M * 4)
    };
  }
  #de() {
    this.#M && (this.#A.deleteFramebuffer(this.#M.framebuffer), this.#A.deleteTexture(this.#M.texture), this.#M = null);
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
    const e = this.#A;
    if (!(this.#f.length === B || this.#a === 0)) {
      this.#U();
      for (let A = 0; A < B; A++) {
        const t = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#a,
          this.#d,
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
        this.#f.push({ texture: t, framebuffer: s });
      }
      this.#G = B - 1;
    }
  }
  #U() {
    const e = this.#A, A = this.#h?.kind === "texture" ? this.#h.texture : null;
    this.#f.some((t) => t.texture === A) && (this.#h = null);
    for (const { texture: t, framebuffer: s } of this.#f)
      e.deleteFramebuffer(s), e.deleteTexture(t);
    this.#f = [], this.#e.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #Ge() {
    if (this.#B) return;
    const e = this.#t.parentElement;
    if (!e) return;
    const A = document.createElement("div");
    A.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(A, this.#t), A.appendChild(this.#t), A.appendChild(this.canvas), this.#B = A, this.#se.observe(this.#t), this.#ie();
  }
  #Ne() {
    const e = this.#B;
    this.#B = null, this.#se.disconnect(), this.canvas.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#t, e), e.remove());
  }
  #ye = () => this.#ie();
  #Me = () => {
    this.#s = 0, this.#q = 0, this.#e.length = 0, this.#E = 0, this.#Fe(), this.#v(), this.#h = null, this.canvas.style.visibility = "hidden";
  };
  #Fe() {
    this.#p = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#_ = 0, this.#K = 0, this.#ce = 0, this.#S = 0, this.#z = 0, this.#O = 0, this.#W = 0, this.#k = 0, this.#P = 0, this.#v();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #v() {
    this.#e.length = 0, this.#L = "video", this.#X = "c", this.#re = 0, this.#V = !0, this.#ne.reset(), this.#oe = 1 / 0, this.#ae = 1 / 0;
  }
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #x = () => {
    if (this.#e.length = 0, !this.#m || this.#s === 0) return;
    if (this.#i && !this.#V && this.#L === "film") {
      this.#Ae(null);
      return;
    }
    const e = this.#fe(), A = e === null ? void 0 : this.#f[e];
    e !== null && A ? (this.#G = e, this.#Q(!0, !1, A.framebuffer), this.#ge(e)) : this.#Q(!0, !1, null);
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Re = (e) => {
    e.preventDefault(), this.#R = !0, this.stop();
  };
}
function X(h, e) {
  const A = h.createProgram(), t = te(h, h.VERTEX_SHADER, de), s = te(h, h.FRAGMENT_SHADER, e);
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
const Ae = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", pe = 0.5, we = 3e3, ie = 0.1, _ = 16, se = 'video/mp4; codecs="avc1.640029"';
let V = null;
function Ee(h = {}) {
  return V ??= ve(h), V;
}
async function Me(h = {}) {
  return (await Ee(h)).deinterlaces;
}
function Fe() {
  V = null;
}
async function ve(h) {
  const e = h.tolerance ?? pe, A = h.timeoutMs ?? we, t = performance.now(), s = (a) => ({
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
    r = ge(i, A);
    const a = O(z(i, "loadeddata"), A), o = i.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await a, await xe(i, A, await o), i.videoWidth === 0 || i.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const c = be(i);
    return {
      deinterlaces: c < 1 - e,
      survives: c,
      tookMs: performance.now() - t
    };
  } catch (a) {
    return s(a);
  } finally {
    i.pause(), i.removeAttribute("src"), i.replaceChildren(), i.load(), r && URL.revokeObjectURL(r.url);
  }
}
const j = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, De = typeof MediaSource > "u";
function ge(h, e) {
  if (!j || !j.isTypeSupported(se))
    throw new Error("the probe clip needs Media Source Extensions");
  const A = Ae.indexOf(","), t = atob(Ae.slice(A + 1)), s = new Uint8Array(t.length);
  for (let o = 0; o < t.length; o++) s[o] = t.charCodeAt(o);
  const i = new j(), r = URL.createObjectURL(i);
  if (De) {
    h.disableRemotePlayback = !0;
    const o = document.createElement("source");
    o.type = "video/mp4", o.src = r, h.append(o), h.load();
  } else
    h.src = r;
  const a = (async () => {
    await O(z(i, "sourceopen"), e);
    const o = i.addSourceBuffer(se), c = O(z(o, "updateend"), e);
    o.appendBuffer(s), await c, i.endOfStream();
  })();
  return { url: r, ready: a };
}
async function xe(h, e, A) {
  if (A) {
    const t = performance.now();
    for (; h.currentTime < ie && performance.now() - t < e; )
      await new Promise((s) => requestAnimationFrame(s));
    h.pause();
  } else
    h.currentTime = ie, await O(z(h, "seeked"), e);
}
function be(h) {
  const e = h.videoHeight, A = document.createElement("canvas");
  A.width = _, A.height = e;
  const t = A.getContext("2d", { willReadFrequently: !0 });
  if (!t) throw new Error("there is no 2d context to read the clip with");
  t.imageSmoothingEnabled = !1, t.drawImage(h, 0, 0, _, e);
  const s = t.getImageData(0, 0, _, e).data, i = (n) => {
    let f = 0;
    for (let l = 0; l < _; l++)
      f += s[(n * _ + l) * 4 + 1] ?? 0;
    return f / _;
  };
  let r = 0;
  const a = 2, o = e - 3;
  let c = i(a);
  for (let n = a + 1; n <= o; n++) {
    const f = i(n);
    r += Math.abs(f - c), c = f;
  }
  return r / (o - a) / 255;
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
  ye as Deinterlacer,
  oe as FILM_ANALYSIS_FRAGMENT_SHADER,
  he as FILM_SAMPLE_FRAGMENT_SHADER,
  Q as FILM_UNIFORMS,
  ae as FILM_WEAVE_FRAGMENT_SHADER,
  ne as YADIF_FRAGMENT_SHADER,
  re as YADIF_UNIFORMS,
  Me as decoderDeinterlaces,
  Fe as forgetDecoderProbe,
  Ee as probeDecoder,
  Te as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
