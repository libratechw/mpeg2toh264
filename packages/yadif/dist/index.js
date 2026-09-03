const oe = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, ae = `#version 300 es
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
}, y = 288, M = 162, he = `#version 300 es
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
`, ce = `#version 300 es
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
`, le = `#version 300 es
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
  #e;
  #A;
  #g;
  #o = 0;
  #f = null;
  #a = [];
  #T = null;
  #v = 1 / 0;
  #P = 1 / 0;
  constructor(e, A) {
    this.#e = e, this.#A = A, this.#g = 255 * g.DECIMATE_BLOCK ** 2 * g.DUPLICATE_PERCENT / 100;
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
    const c = /* @__PURE__ */ new Map(), o = (p) => {
      const E = c.get(p);
      if (E !== void 0) return E;
      const w = g.#M(
        this.weave(e, A, t, p, s),
        this.#e,
        this.#A
      );
      return c.set(p, w), w;
    }, u = o(n), f = o("n");
    (f * 3 < u || f * 2 < u && u > i) && Math.abs(f - u) >= 30 && f < i && (n = "n");
    const h = o(n), d = h >= i;
    return d && (n = "c"), {
      match: n,
      combScore: h,
      isCombed: d,
      luma: this.weave(e, A, t, n, s)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const A = this.#o, t = this.#T ? g.#q(
      this.#T,
      e,
      this.#e,
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
      let n = 0, c = null;
      for (let o = 1; o < this.#a.length; o++)
        (this.#a[o]?.maxBlockDifference ?? 1 / 0) < (this.#a[n]?.maxBlockDifference ?? 1 / 0) ? (c = n, n = o) : (c === null || (this.#a[o]?.maxBlockDifference ?? 1 / 0) < (this.#a[c]?.maxBlockDifference ?? 1 / 0)) && (c = o);
      this.#v = this.#a[n]?.maxBlockDifference ?? 1 / 0, this.#P = c === null ? 1 / 0 : this.#a[c]?.maxBlockDifference ?? 1 / 0, a = (this.#a[n]?.maxBlockDifference ?? 1 / 0) < this.#g ? n : null, this.#f = a, this.#a = [], this.#o = 0;
    }
    return {
      cycleIndex: A,
      maxBlockDifference: t.maxBlockDifference,
      totalDifference: t.totalDifference,
      shouldDrop: i,
      dropIndex: r,
      nextDropIndex: a,
      lowestCycleDifference: this.#v,
      runnerUpCycleDifference: this.#P
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, A, t, s, i) {
    if (s === "c") return A.slice();
    const r = A.slice(), a = s === "p" ? e : t, n = r.length / this.#A, c = i ? 1 : 0;
    for (let o = c; o < this.#A; o += 2)
      r.set(
        a.subarray(o * n, (o + 1) * n),
        o * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#o = 0, this.#f = null, this.#a = [], this.#T = null, this.#v = 1 / 0, this.#P = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #y(e, A, t, s) {
    const i = this.#e, r = this.#A, a = 2 - t, n = 2 - t, c = s[e], o = s[A], u = g.#K(
      c,
      o,
      i,
      r,
      t
    );
    let f = 0, h = 0, d = 0, p = 0, E = 0, w = 0;
    for (let S = 2; S < r - 2; S += 2) {
      const b = (S - 2) / 2, W = a - 1 + b * 2, Y = a + 1 + b * 2, Z = a + 3 + b * 2, X = a + b * 2, N = X + 2, B = n + b * 2, R = B + 2, $ = a + b * 2;
      for (let T = 8; T < i - 8; T++) {
        const C = (u[$ * i + T] ?? 0) | (u[($ + 2) * i + T] ?? 0);
        if (C === 0) continue;
        const ee = (s.c[W * i + T] ?? 0) + ((s.c[Y * i + T] ?? 0) << 2) + (s.c[Z * i + T] ?? 0), P = Math.abs(
          3 * ((c[X * i + T] ?? 0) + (c[N * i + T] ?? 0)) - ee
        ), k = Math.abs(
          3 * ((o[B * i + T] ?? 0) + (o[R * i + T] ?? 0)) - ee
        );
        P > 23 && (C & 1) !== 0 && (f += P), k > 23 && (C & 1) !== 0 && (p += k), P > 42 && (C & 2) !== 0 && (h += P), k > 42 && (C & 2) !== 0 && (E += k), P > 42 && (C & 4) !== 0 && (d += P), k > 42 && (C & 4) !== 0 && (w += k);
      }
    }
    h < 500 && E < 500 && (d >= 500 || w >= 500) && Math.max(d, w) > 3 * Math.min(d, w) && (h = d, E = w);
    const D = Math.floor(f / 6 + 0.5), F = Math.floor(p / 6 + 0.5), v = Math.floor(h / 6 + 0.5), m = Math.floor(E / 6 + 0.5), I = Math.max(D, F) / Math.max(Math.min(D, F), 1), U = Math.max(v, m) / Math.max(Math.min(v, m), 1), G = Math.max(v, m) / Math.max(Math.max(D, F), 1);
    return (v >= 500 || m >= 500) && (v * 2 < m || m * 2 < v) || (v >= 1e3 || m >= 1e3) && (v * 3 < m * 2 || m * 3 < v * 2) || (v >= 2e3 || m >= 2e3) && (v * 5 < m * 4 || m * 5 < v * 4) || (v >= 4e3 || m >= 4e3) && U > I || G > 5e-3 && Math.max(v, m) > 150 && (v * 2 < m || m * 2 < v) ? v > m ? A : e : D > F ? A : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #K(e, A, t, s, i) {
    const r = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(t)
    ), a = i === 1 ? 1 : 0;
    for (let o = 0; o < r.length; o++) {
      const u = Math.min(s - 1, a + o * 2), f = r[o];
      if (f)
        for (let h = 0; h < t; h++)
          f[h] = Math.abs(
            (e[u * t + h] ?? 0) - (A[u * t + h] ?? 0)
          );
    }
    const n = new Uint8Array(t * s), c = i === 1 ? 3 : 2;
    for (let o = 1; o < r.length - 1; o++) {
      const u = c + (o - 1) * 2;
      if (u >= s) break;
      const f = r[o];
      if (f)
        for (let h = 1; h < t - 1; h++) {
          const d = f[h] ?? 0;
          if (d <= 3) continue;
          let p = 0;
          for (let m = h - 1; m <= h + 1; m++)
            p += (r[o - 1]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[o]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[o + 1]?.[m] ?? 0) > 3 ? 1 : 0;
          if (p <= 1) continue;
          const E = u * t + h;
          if (n[E] = 1, d <= 19) continue;
          p = 0;
          let w = !1, D = !1;
          for (let m = h - 1; m <= h + 1; m++)
            (r[o - 1]?.[m] ?? 0) > 19 && (p++, w = !0), (r[o]?.[m] ?? 0) > 19 && p++, (r[o + 1]?.[m] ?? 0) > 19 && (p++, D = !0);
          if (p <= 3) continue;
          if (w && D) {
            n[E] |= 2;
            continue;
          }
          let F = !1, v = !1;
          for (let m = Math.max(h - 4, 0); m < Math.min(h + 5, t); m++)
            o !== 1 && (r[o - 2]?.[m] ?? 0) > 19 && (F = !0), (r[o - 1]?.[m] ?? 0) > 19 && (w = !0), (r[o + 1]?.[m] ?? 0) > 19 && (D = !0), o !== r.length - 2 && (r[o + 2]?.[m] ?? 0) > 19 && (v = !0);
          w && (D || F) || D && (w || v) ? n[E] |= 2 : p > 5 && (n[E] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #M(e, A, t) {
    const s = new Uint8Array(A * t), i = (a, n) => e[Math.max(0, Math.min(t - 1, n)) * A + a] ?? 0;
    for (let a = 0; a < t; a++)
      for (let n = 0; n < A; n++) {
        const c = i(n, a), o = i(n, a === 0 ? 1 : a - 1), u = i(n, a === t - 1 ? t - 2 : a + 1), f = a < 2 ? i(n, a === 0 ? 2 : 3) : i(n, a - 2), h = a + 2 >= t ? i(n, a === t - 1 ? t - 3 : t - 4) : i(n, a + 2);
        (a === 0 ? Math.abs(c - u) > g.COMB_THRESHOLD : a === t - 1 ? Math.abs(c - o) > g.COMB_THRESHOLD : Math.abs(c - o) > g.COMB_THRESHOLD && Math.abs(c - u) > g.COMB_THRESHOLD) && Math.abs(
          4 * c - 3 * (o + u) + f + h
        ) > g.COMB_THRESHOLD * 6 && (s[a * A + n] = 255);
      }
    let r = 0;
    for (const a of [0, 8])
      for (const n of [0, 8])
        for (let c = a; c < t; c += 16)
          for (let o = n; o < A; o += 16) {
            let u = 0;
            for (let f = Math.max(1, c); f < Math.min(t - 1, c + 16); f++)
              for (let h = o; h < Math.min(A, o + 16); h++) {
                const d = f * A + h;
                s[d - A] === 255 && s[d] === 255 && s[d + A] === 255 && u++;
              }
            r = Math.max(r, u);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #q(e, A, t, s) {
    const i = g.DECIMATE_BLOCK / 2, r = Math.ceil(t / i), a = Math.ceil(s / i), n = new Float64Array(r * a), c = e.length / (t * s);
    for (let f = 0; f < s; f++) {
      const h = Math.floor(f / i);
      for (let d = 0; d < t; d++) {
        const p = Math.floor(d / i), E = h * r + p, w = (f * t + d) * c;
        if (c === 1) {
          n[E] = (n[E] ?? 0) + Math.abs((e[w] ?? 0) - (A[w] ?? 0));
          continue;
        }
        const D = Math.round(
          (e[w] ?? 0) * 0.2126 + (e[w + 1] ?? 0) * 0.7152 + (e[w + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (A[w] ?? 0) * 0.2126 + (A[w + 1] ?? 0) * 0.7152 + (A[w + 2] ?? 0) * 0.0722
        );
        if (n[E] = (n[E] ?? 0) + Math.abs(D - F), (d & 1) !== 0 || (f & 1) !== 0) continue;
        let v = 0, m = 0, I = 0, U = 0, G = 0, S = 0, b = 0;
        for (let N = f; N < Math.min(f + 2, s); N++)
          for (let B = d; B < Math.min(d + 2, t); B++) {
            const R = (N * t + B) * c;
            v += e[R] ?? 0, m += e[R + 1] ?? 0, I += e[R + 2] ?? 0, U += A[R] ?? 0, G += A[R + 1] ?? 0, S += A[R + 2] ?? 0, b++;
          }
        const W = Math.round(
          (-0.114572 * v - 0.385428 * m + 0.5 * I) / b
        ), Y = Math.round(
          (-0.114572 * U - 0.385428 * G + 0.5 * S) / b
        ), Z = Math.round(
          (0.5 * v - 0.454153 * m - 0.045847 * I) / b
        ), X = Math.round(
          (0.5 * U - 0.454153 * G - 0.045847 * S) / b
        );
        n[E] = (n[E] ?? 0) + Math.abs(W - Y) + Math.abs(Z - X);
      }
    }
    let o = -1;
    for (let f = 0; f < a - 1; f++)
      for (let h = 0; h < r - 1; h++)
        o = Math.max(
          o,
          (n[f * r + h] ?? 0) + (n[f * r + h + 1] ?? 0) + (n[(f + 1) * r + h] ?? 0) + (n[(f + 1) * r + h + 1] ?? 0)
        );
    let u = 0;
    for (const f of n) u += f;
    return { maxBlockDifference: o, totalDifference: u };
  }
}
const fe = 0.5, x = 3, K = 5, L = K + 1, te = 1e3, j = 4, V = 200, ue = 0.25, de = 1e3 / 60, me = 0.02, pe = 250, we = 1e3 / 30;
function Ae(l) {
  if (!Number.isFinite(l) || l < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return l;
}
const Ee = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, ve = `#version 300 es
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
function Re() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class Se extends EventTarget {
  canvas;
  #e;
  #A;
  #g;
  #o;
  /** The program that copies a filtered picture onto the canvas. */
  #f;
  #a;
  #T;
  /** The reduced pass that reads previous, current and next luma together. */
  #v = null;
  #P = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #y = null;
  #K = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #M = null;
  #q = null;
  #F = null;
  #E = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #u = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #X = L - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #n = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #t = [];
  /** The rAF loop that puts them up, which is all that draws on the canvas. */
  #R = null;
  #$ = 0;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #k = de;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #_ = null;
  #re;
  #D;
  #c;
  #O;
  #ge;
  #x = "video";
  #z = "c";
  #ne = 0;
  #oe = !0;
  #ae = new g(y, M);
  #he = 1 / 0;
  #ce = 1 / 0;
  #S = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #s = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #h = 0;
  #p = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #l = x - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #i = 0;
  #I = 0;
  /** A destination frame that arrived before the browser finished seeking. */
  #W = !1;
  #U = null;
  /** callback の停止を animation loop で検出するために保持する最終通知時刻。 */
  #ee = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #G = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #le = 0;
  #w = !1;
  #fe = !1;
  #r = null;
  #Y = [];
  #C = !1;
  #xe;
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #d = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    late: 0,
    queueResetted: 0
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #L = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #ue = 0;
  #te = 0;
  #B = 0;
  #Z = 0;
  #Q = 0;
  #j = 0;
  #N = 0;
  constructor(e, A = {}) {
    super(), this.#e = e, this.#D = A.doubleRate ?? !1, this.#c = A.autoFilm ?? !1, this.#O = Ae(
      A.filmCombThreshold ?? g.COMBED_PIXEL_LIMIT
    ), this.#ge = A.spatialCheck ?? !0, this.#xe = A.onStats, this.canvas = document.createElement("canvas"), this.canvas.style.cssText = "position:absolute;pointer-events:none;visibility:hidden";
    const t = this.canvas.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!t) throw new Error("this browser has no WebGL2");
    this.#A = t, this.#g = H(t, ae);
    const s = this.#g;
    this.#o = Object.fromEntries(
      Object.entries(oe).map(([i, r]) => [
        i,
        t.getUniformLocation(s, r)
      ])
    ), this.#f = H(t, ve), this.#a = t.getUniformLocation(this.#f, "uField"), this.#T = t.getUniformLocation(this.#f, "uFlip"), this.#c && this.#ye(), this.canvas.addEventListener("webglcontextlost", this.#Ue), this.#re = new ResizeObserver(() => this.#se()), e.addEventListener("emptied", this.#ke), e.addEventListener("resize", this.#Pe), e.addEventListener("pause", this.#b), e.addEventListener("ended", this.#b), e.addEventListener("seeking", this.#Ie), e.addEventListener("seeked", this.#b), e.addEventListener("ratechange", this.#b);
  }
  get running() {
    return this.#w && (this.#r?.interlaced ?? !0);
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #Ae() {
    return this.#r?.topFieldFirst !== !1;
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#fe;
  }
  set enabled(e) {
    this.#fe = e, this.#de();
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const A = this.#r?.interlaced !== e?.interlaced, t = A || this.#r?.topFieldFirst !== e?.topFieldFirst;
    this.#r = e, t && (this.#i = 0, this.#m(), A && (this.#s = 0), this.#n = null, this.canvas.style.visibility = "hidden"), this.#de(), t && (e?.interlaced ?? !0 ? this.#V() : this.#we());
  }
  get scan() {
    return this.#r;
  }
  set videoTimeline(e) {
    this.#Y = e, e.length === 0 && (this.#r = null), this.#de();
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
    return this.#_ ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#D;
  }
  set doubleRate(e) {
    e !== this.#D && (this.#D = e, this.#t.length = 0, e ? (this.#h > 0 && this.#De(), (this.#r?.interlaced ?? !0) && this.#V()) : this.#c || (this.#n = null, this.canvas.style.visibility = "hidden", this.#H()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#c;
  }
  set autoFilm(e) {
    e !== this.#c && (this.#c = e, this.#m(), e ? (this.#ye(), this.#h > 0 && (this.#Be(), this.#De()), (this.#r?.interlaced ?? !0) && this.#V()) : (this.#ve(), this.#D || (this.#n = null, this.canvas.style.visibility = "hidden", this.#H())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#O;
  }
  set filmCombThreshold(e) {
    const A = Ae(e);
    A !== this.#O && (this.#O = A, this.#c && this.#m());
  }
  #de() {
    this.#fe && (this.#Y.length > 0 || (this.#r?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  start() {
    this.#w || this.#C || (this.#w = !0, this.#_e(), this.#m(), this.#ee = performance.now(), this.#le = this.#ee, this.#G = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#je(), this.#be(), (this.#r?.interlaced ?? !0) && this.#V());
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#w && (this.#w = !1, this.#U !== null && this.#e.cancelVideoFrameCallback(this.#U), this.#U = null, this.#we(), this.#i = 0, this.#n = null, this.canvas.style.visibility = "hidden");
  }
  destroy() {
    this.stop(), this.canvas.removeEventListener("webglcontextlost", this.#Ue), this.#e.removeEventListener("emptied", this.#ke), this.#e.removeEventListener("resize", this.#Pe), this.#e.removeEventListener("pause", this.#b), this.#e.removeEventListener("ended", this.#b), this.#e.removeEventListener("seeking", this.#Ie), this.#e.removeEventListener("seeked", this.#b), this.#e.removeEventListener("ratechange", this.#b), this.#Ve();
    for (const e of this.#E) this.#A.deleteTexture(e);
    this.#E = [], this.#H(), this.#ve(), this.#A.deleteProgram(this.#g), this.#A.deleteProgram(this.#f), this.#v && this.#A.deleteProgram(this.#v), this.#y && this.#A.deleteProgram(this.#y), this.#M && this.#A.deleteProgram(this.#M), this.#A.getExtension("WEBGL_lose_context")?.loseContext();
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
    const e = this.#n;
    if (!this.#w || this.#C || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#Ee(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#J(e.flush, e.second, null, !1) : this.#me(null, !1);
    const A = this.#e.videoWidth, t = this.#e.videoHeight;
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
  #be() {
    !this.#w || this.#U !== null || (this.#U = this.#e.requestVideoFrameCallback(this.#Ge));
  }
  #Ge = (e, A) => {
    this.#U = null, !(!this.#w || this.#C) && (this.#ee = e, this.#G = Math.max(
      this.#G,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#Te(e, A), this.#be());
  };
  /** どちらの通知経路で見つけたフレームも同じ履歴へ取り込んでフィルターする。 */
  #Te(e, A) {
    if (this.#Ne(A.mediaTime), A.width > 0 && A.height > 0) {
      let t = !1;
      if (!this.#W && this.#e.seeking) {
        const h = this.#e.buffered, d = this.#s >= j ? this.#s / 1e3 : V / 1e3;
        for (let p = 0; p < h.length; p++)
          if (A.mediaTime >= h.start(p) && A.mediaTime < h.end(p) && Math.abs(A.mediaTime - this.#e.currentTime) <= d) {
            t = !0;
            break;
          }
      }
      if (t && (this.#W = !0), (this.#h === 0 || this.#p === 0) && this.#Le(A.width, A.height), this.#r && !this.#r.interlaced) {
        this.#Ye();
        return;
      }
      const s = A.mediaTime - this.#I, i = t || s < 0 || s > fe;
      i && (this.#i = 0, this.#s = 0, this.#d.discontinuities++, this.#t.length = 0, this.#m());
      const r = this.#c && this.#L !== 0 && A.presentedFrames - this.#L > 1;
      if (this.#Ze(A.presentedFrames, i), !i && r && (this.#i = 0, this.#m()), this.#i > 0 && A.mediaTime === this.#I)
        return;
      !i && s > 0 && this.#He(s), this.#I = A.mediaTime;
      const a = performance.now();
      a - this.#ue > te && (this.#te = a, this.#B = 0, this.#Z = 0, this.#Q = 0, this.#j = 0, this.#N = 0, this.#S = 0), this.#ue = a;
      const n = performance.now();
      this.#Ce();
      const c = this.#x, o = this.#c && this.#i === x && this.#Xe();
      if (c !== this.#x && (this.#t.length = 0), !(o && this.#ie())) if (this.#c && !this.#oe && this.#x === "film")
        if (this.#ie()) {
          const h = this.#s * 5 / 4, d = this.#Fe(1, e, h), p = this.#t.at(-1), E = d ? e : p == null ? e + h : p.at + p.duration;
          this.#Oe(E, h);
        } else
          this.#me(null);
      else if (this.#D && this.#ie()) {
        const h = this.#s / 2, d = this.#Fe(2, e, h), p = this.#t.at(-1), E = d ? e : p == null ? e + h * 2 : p.at + p.duration;
        this.#Me(!1, E, h), this.#Me(!0, E + h, h);
      } else
        this.#d.late += this.#t.length, this.#t.length = 0, this.#J(!1, !1, null);
      this.#N = Math.max(
        this.#N,
        this.#t.length
      ), this.#Z += performance.now() - n, this.#B++, this.#Qe(a);
    }
  }
  #Ne(e) {
    let A;
    for (let i = this.#Y.length - 1; i >= 0; i--) {
      const r = this.#Y[i];
      if (r.start <= e + 1e-6) {
        A = r;
        break;
      }
    }
    A?.codedSize && (A.codedSize.width !== this.#h || A.codedSize.height !== this.#p) && this.#Le(A.codedSize.width, A.codedSize.height);
    const t = A?.scan;
    if (!t || this.#r?.interlaced === t.interlaced && this.#r.topFieldFirst === t.topFieldFirst)
      return;
    const s = this.#r?.interlaced;
    this.#r = t, this.#i = 0, this.#t.length = 0, this.#m(), s !== t.interlaced && (this.#s = 0), t.interlaced ? this.#V() : this.#we();
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #ie() {
    return (this.#D || this.#c) && this.#s > 0 && this.#u.length === L;
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
  #He(e) {
    const A = e * 1e3 / (this.#e.playbackRate || 1), t = this.#s > 0 ? Math.max(1, Math.round(A / this.#s)) : 1, s = A / t;
    s < j || s > V || (this.#s = this.#s > 0 ? this.#s + (s - this.#s) * ue : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #ye() {
    if (this.#v && this.#y && this.#M) return;
    const e = this.#A, A = H(e, he), t = H(e, ce), s = H(e, le);
    this.#v = A, this.#P = Object.fromEntries(
      Object.entries(Q).filter(([i]) => i !== "match" && i !== "topFieldFirst").map(([i, r]) => [i, e.getUniformLocation(A, r)])
    ), this.#y = t, this.#K = Object.fromEntries(
      Object.entries(Q).map(([i, r]) => [
        i,
        e.getUniformLocation(t, r)
      ])
    ), this.#M = s, this.#q = Object.fromEntries(
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
  #Xe() {
    const e = this.#F, A = this.#v, t = this.#P, s = this.#M, i = this.#q;
    if (!e || !A || !t || !s || !i)
      return !1;
    const r = this.#A, a = this.#l, n = (this.#l + x - 1) % x, c = (this.#l + 1) % x, o = this.#Ae;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(A);
    for (const [w, D] of [c, n, a].entries())
      r.activeTexture(r.TEXTURE0 + w), r.bindTexture(r.TEXTURE_2D, this.#E[D] ?? null);
    r.uniform1i(t.prev, 0), r.uniform1i(t.cur, 1), r.uniform1i(t.next, 2), r.uniform2i(t.size, this.#h, this.#p), r.viewport(0, 0, y, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      y,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: u, currentLuma: f, nextLuma: h } = e;
    for (let w = 0; w < u.length; w++) {
      const D = w * 4;
      u[w] = e.pixels[D] ?? 0, f[w] = e.pixels[D + 1] ?? 0, h[w] = e.pixels[D + 2] ?? 0;
    }
    const d = this.#ae.fieldMatch(
      u,
      f,
      h,
      o,
      this.#O
    );
    r.useProgram(s), r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#h, this.#p), r.uniform1i(i.topFieldFirst, o ? 1 : 0), r.uniform1i(
      i.match,
      d.match === "p" ? 0 : d.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      y,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const p = this.#ae.decimate(e.pixels);
    this.#z = d.match, this.#ne = d.combScore, this.#oe = d.isCombed, this.#he = p.lowestCycleDifference, this.#ce = p.runnerUpCycleDifference;
    const E = p.dropIndex !== null && !d.isCombed;
    return (E ? "film" : "video") !== this.#x && (this.#x = E ? "film" : "video"), p.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Oe(e, A) {
    const t = this.#pe();
    if (t === null) return;
    const s = this.#u[t];
    if (s) {
      for (this.#X = t; this.#t.length > 0 && this.#t[0]?.slot === t; )
        this.#t.shift(), this.#d.late++;
      this.#me(s.framebuffer), this.#t.push({ slot: t, at: e, duration: A });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #me(e, A = !0) {
    const t = this.#y, s = this.#K;
    if (!t || !s) return;
    const i = this.#A, r = this.#l, a = (this.#l + x - 1) % x, n = (this.#l + 1) % x, c = this.#Ae;
    i.bindFramebuffer(i.FRAMEBUFFER, e), i.useProgram(t);
    for (const [o, u] of [n, a, r].entries())
      i.activeTexture(i.TEXTURE0 + o), i.bindTexture(i.TEXTURE_2D, this.#E[u] ?? null);
    i.uniform1i(s.prev, 0), i.uniform1i(s.cur, 1), i.uniform1i(s.next, 2), i.uniform2i(s.size, this.#h, this.#p), i.uniform1i(s.topFieldFirst, c ? 1 : 0), i.uniform1i(
      s.match,
      this.#z === "p" ? 0 : this.#z === "c" ? 1 : 2
    ), i.viewport(0, 0, this.#h, this.#p), i.drawArrays(i.TRIANGLES, 0, 3), e === null && (this.#n = { kind: "film" }, this.canvas.style.visibility = "visible", A && this.#S++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #Me(e, A, t) {
    const s = this.#pe();
    if (s === null) return;
    const i = this.#u[s];
    if (i) {
      for (this.#X = s; this.#t.length > 0 && this.#t[0]?.slot === s; )
        this.#t.shift(), this.#d.late++;
      this.#J(!1, e, i.framebuffer), this.#t.push({ slot: s, at: A, duration: t });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #Fe(e, A, t) {
    const s = this.#t.at(-1), i = (K + 1) * Math.max(this.#k, t);
    if (s && s.at - A > i)
      return this.#t.length = 0, this.#d.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#t.length + e - K
    );
    let a = 0, n = 0;
    for (; n < r; ) {
      const c = this.#t.shift();
      if (!c) break;
      a += c.duration, n++;
    }
    for (const c of this.#t) c.at -= a;
    return this.#d.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #pe() {
    const e = this.#n?.kind === "texture" ? this.#n.texture : null, A = new Set(this.#t.map(({ slot: s }) => s));
    for (let s = 1; s <= L; s++) {
      const i = (this.#X + s) % L, r = this.#u[i];
      if (r && r.texture !== e && !A.has(i))
        return i;
    }
    const t = this.#t[0];
    if (t) {
      const s = this.#u[t.slot];
      if (s && s.texture !== e) return t.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #V() {
    this.#R === null && (!this.#w || this.#C || (this.#$ = 0, this.#R = requestAnimationFrame(this.#Re)));
  }
  #we() {
    this.#R !== null && cancelAnimationFrame(this.#R), this.#R = null, this.#t.length = 0;
  }
  #Re = (e) => {
    if (this.#R = null, !(!this.#w || this.#C)) {
      if (this.#$ > 0) {
        const A = e - this.#$;
        A >= 1 && A <= V && (this.#k = A < this.#k ? A : this.#k + (A - this.#k) * me);
      }
      this.#$ = e, this.#ze(e), this.#We(e), this.#R = requestAnimationFrame(this.#Re);
    }
  };
  /** ブラウザから callback が来ない間も animation loop から復号フレームを取り込む。 */
  #ze(e) {
    if (e - this.#ee < pe || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const A = this.#e.currentTime, t = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#s >= j ? this.#s : we, i = t > this.#G, r = A > this.#I && e - this.#le >= s * 0.75;
    !i && !r || (this.#G = Math.max(
      this.#G,
      t
    ), this.#le = e, this.#Te(e, {
      mediaTime: A,
      presentedFrames: Math.max(this.#L + 1, t),
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
  #We(e) {
    const A = e + this.#k * 1.5;
    for (; this.#t[1] && this.#t[1].at <= A; )
      this.#d.late++, this.#t.shift();
    let t = this.#t[0];
    if (!t || t.at > A)
      return;
    this.#t.shift();
    const s = performance.now();
    this.#Se(t.slot), this.#j += performance.now() - s, this.#Q++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #Se(e) {
    const A = this.#u[e];
    A && this.#Ee(A.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Ye() {
    this.#Ce();
    const e = this.#E[this.#l];
    e && this.#Ee(e, !0), this.#i = 0;
  }
  #Ee(e, A = !1, t = !0) {
    const s = this.#A;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#f), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#a, 0), s.uniform1i(this.#T, A ? 1 : 0), s.viewport(0, 0, this.#h, this.#p), s.drawArrays(s.TRIANGLES, 0, 3), this.#n = { kind: "texture", texture: e, flip: A }, this.canvas.style.visibility = "visible", t && this.#S++;
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
  #Ze(e, A) {
    this.#L !== 0 && !A && (this.#d.missed += Math.max(0, e - this.#L - 1)), this.#L = e;
  }
  #Qe(e) {
    const A = e - this.#te;
    if (A < te) return;
    const t = this.#ie() && (this.#D || this.#x === "film") ? this.#Q : this.#B, s = {
      ...this.#d,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: t * 1e3 / A,
      frameMs: this.#B === 0 ? 0 : (this.#Z + this.#j) / this.#B,
      maxQueuedFields: this.#N,
      mode: this.#x,
      match: this.#z,
      combScore: this.#ne,
      outputFps: this.#S * 1e3 / A,
      duplicateScore: this.#he,
      duplicateRunnerUp: this.#ce
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#xe?.(s), this.#te = e, this.#B = 0, this.#Z = 0, this.#Q = 0, this.#j = 0, this.#N = 0, this.#S = 0;
  }
  /** Take the newest frame into the ring. */
  #Ce() {
    const e = this.#A;
    this.#l = (this.#l + 1) % x, e.bindTexture(e.TEXTURE_2D, this.#E[this.#l] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#e
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
    if (this.#i === 0 || this.#C) return;
    s && (this.#i === x && !e ? this.#d.filtered++ : this.#d.degraded++);
    const i = this.#A, r = this.#l, a = (this.#l + x - 1) % x, n = (this.#l + 1) % x;
    let c, o, u;
    this.#i === 1 ? c = o = u = r : e ? (c = a, o = u = r) : this.#i === 2 ? (c = o = a, u = r) : (c = n, o = a, u = r), i.bindFramebuffer(i.FRAMEBUFFER, t), i.useProgram(this.#g);
    for (const [h, d] of [c, o, u].entries())
      i.activeTexture(i.TEXTURE0 + h), i.bindTexture(i.TEXTURE_2D, this.#E[d] ?? null);
    i.uniform1i(this.#o.prev, 0), i.uniform1i(this.#o.cur, 1), i.uniform1i(this.#o.next, 2), i.uniform2i(this.#o.size, this.#h, this.#p);
    const f = this.#Ae ? 0 : 1;
    i.uniform1i(this.#o.parity, A ? 1 - f : f), i.uniform1i(this.#o.tff, this.#Ae ? 1 : 0), i.uniform1i(this.#o.spatialCheck, this.#ge ? 1 : 0), i.viewport(0, 0, this.#h, this.#p), i.drawArrays(i.TRIANGLES, 0, 3), t === null && (this.#n = { kind: "yadif", flush: e, second: A }, this.canvas.style.visibility = "visible", s && this.#S++);
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
  #se() {
    if (!this.#_) return;
    const e = this.#e, A = e.videoWidth, t = e.videoHeight;
    if (A === 0 || t === 0) return;
    const s = Math.min(
      e.offsetWidth / A,
      e.offsetHeight / t
    ), i = A * s, r = t * s;
    this.canvas.style.left = `${e.offsetLeft + (e.offsetWidth - i) / 2}px`, this.canvas.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.canvas.style.width = `${i}px`, this.canvas.style.height = `${r}px`;
  }
  #Le(e, A) {
    const t = this.#A;
    this.canvas.width = e, this.canvas.height = A, this.#h = e, this.#p = A, this.#i = 0, this.#n = null, this.#m(), this.#se();
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
    this.#H(), this.#ve(), this.#c && this.#Be(), (this.#D || this.#c) && this.#De();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Be() {
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
  #ve() {
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
  #De() {
    const e = this.#A;
    if (!(this.#u.length === L || this.#h === 0)) {
      this.#H();
      for (let A = 0; A < L; A++) {
        const t = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#h,
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
          e.deleteFramebuffer(s), e.deleteTexture(t), this.#H();
          return;
        }
        this.#u.push({ texture: t, framebuffer: s });
      }
      this.#X = L - 1;
    }
  }
  #H() {
    const e = this.#A, A = this.#n?.kind === "texture" ? this.#n.texture : null;
    this.#u.some((t) => t.texture === A) && (this.#n = null);
    for (const { texture: t, framebuffer: s } of this.#u)
      e.deleteFramebuffer(s), e.deleteTexture(t);
    this.#u = [], this.#t.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #je() {
    if (this.#_) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const A = document.createElement("div");
    A.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(A, this.#e), A.appendChild(this.#e), A.appendChild(this.canvas), this.#_ = A, this.#re.observe(this.#e), this.#se();
  }
  #Ve() {
    const e = this.#_;
    this.#_ = null, this.#re.disconnect(), this.canvas.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #Pe = () => this.#se();
  #ke = () => {
    this.#i = 0, this.#I = 0, this.#t.length = 0, this.#s = 0, this.#_e(), this.#m(), this.#n = null, this.canvas.style.visibility = "hidden";
  };
  #_e() {
    this.#d = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#L = 0, this.#te = 0, this.#ue = 0, this.#B = 0, this.#Z = 0, this.#Q = 0, this.#j = 0, this.#N = 0, this.#S = 0, this.#m();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #m() {
    this.#t.length = 0, this.#x = "video", this.#z = "c", this.#ne = 0, this.#oe = !0, this.#ae.reset(), this.#he = 1 / 0, this.#ce = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #Ie = () => {
    this.#W = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #b = (e) => {
    if (e.type === "seeked") {
      const t = this.#W;
      if (this.#W = !1, t) return;
      this.#i = 0, this.#m(), this.#n = null, this.canvas.style.visibility = "hidden";
      return;
    }
    const A = e.type === "ratechange";
    if (A && (this.#s = 0, this.#I = this.#e.currentTime), this.#t.length = 0, this.#w && this.#i > 0) {
      const t = this.#pe(), s = t === null ? void 0 : this.#u[t];
      t !== null && s ? (this.#X = t, this.#J(!0, !1, s.framebuffer), this.#Se(t)) : this.#J(!0, !1, null);
    }
    A && (this.#i = 0, this.#m());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Ue = (e) => {
    e.preventDefault(), this.#C = !0, this.stop();
  };
}
function H(l, e) {
  const A = l.createProgram(), t = ie(l, l.VERTEX_SHADER, Ee), s = ie(l, l.FRAGMENT_SHADER, e);
  if (l.attachShader(A, t), l.attachShader(A, s), l.linkProgram(A), l.deleteShader(t), l.deleteShader(s), !l.getProgramParameter(A, l.LINK_STATUS)) {
    const i = l.getProgramInfoLog(A);
    throw l.deleteProgram(A), new Error(
      `the deinterlacer failed to link: ${i ?? "no reason given"}`
    );
  }
  return A;
}
function ie(l, e, A) {
  const t = l.createShader(e);
  if (!t) throw new Error("the deinterlacer could not create a shader");
  if (l.shaderSource(t, A), l.compileShader(t), !l.getShaderParameter(t, l.COMPILE_STATUS)) {
    const s = l.getShaderInfoLog(t);
    throw l.deleteShader(t), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return t;
}
const se = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", De = 0.5, ge = 3e3, re = 0.1, _ = 16, ne = 'video/mp4; codecs="avc1.640029"';
let q = null;
function xe(l = {}) {
  return q ??= be(l), q;
}
async function Ce(l = {}) {
  return (await xe(l)).deinterlaces;
}
function Le() {
  q = null;
}
async function be(l) {
  const e = l.tolerance ?? De, A = l.timeoutMs ?? ge, t = performance.now(), s = (a) => ({
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
    r = ye(i, A);
    const a = z(O(i, "loadeddata"), A), n = i.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await a, await Me(i, A, await n), i.videoWidth === 0 || i.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const c = Fe(i);
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
const J = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Te = typeof MediaSource > "u";
function ye(l, e) {
  if (!J || !J.isTypeSupported(ne))
    throw new Error("the probe clip needs Media Source Extensions");
  const A = se.indexOf(","), t = atob(se.slice(A + 1)), s = new Uint8Array(t.length);
  for (let n = 0; n < t.length; n++) s[n] = t.charCodeAt(n);
  const i = new J(), r = URL.createObjectURL(i);
  if (Te) {
    l.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, l.append(n), l.load();
  } else
    l.src = r;
  const a = (async () => {
    await z(O(i, "sourceopen"), e);
    const n = i.addSourceBuffer(ne), c = z(O(n, "updateend"), e);
    n.appendBuffer(s), await c, i.endOfStream();
  })();
  return { url: r, ready: a };
}
async function Me(l, e, A) {
  if (A) {
    const t = performance.now();
    for (; l.currentTime < re && performance.now() - t < e; )
      await new Promise((s) => requestAnimationFrame(s));
    l.pause();
  } else
    l.currentTime = re, await z(O(l, "seeked"), e);
}
function Fe(l) {
  const e = l.videoHeight, A = document.createElement("canvas");
  A.width = _, A.height = e;
  const t = A.getContext("2d", { willReadFrequently: !0 });
  if (!t) throw new Error("there is no 2d context to read the clip with");
  t.imageSmoothingEnabled = !1, t.drawImage(l, 0, 0, _, e);
  const s = t.getImageData(0, 0, _, e).data, i = (o) => {
    let u = 0;
    for (let f = 0; f < _; f++)
      u += s[(o * _ + f) * 4 + 1] ?? 0;
    return u / _;
  };
  let r = 0;
  const a = 2, n = e - 3;
  let c = i(a);
  for (let o = a + 1; o <= n; o++) {
    const u = i(o);
    r += Math.abs(u - c), c = u;
  }
  return r / (n - a) / 255;
}
function O(l, e) {
  return new Promise((A, t) => {
    l.addEventListener(e, () => A(), { once: !0 }), l.addEventListener(
      "error",
      () => {
        const s = l instanceof HTMLMediaElement ? l.error : null, i = s ? ` (MediaError ${s.code}${s.message ? `: ${s.message}` : ""})` : "";
        t(new Error(`the probe clip ${e} failed${i}`));
      },
      { once: !0 }
    );
  });
}
function z(l, e) {
  return Promise.race([
    l,
    new Promise(
      (A, t) => setTimeout(
        () => t(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
export {
  Se as Deinterlacer,
  he as FILM_ANALYSIS_FRAGMENT_SHADER,
  le as FILM_SAMPLE_FRAGMENT_SHADER,
  Q as FILM_UNIFORMS,
  ce as FILM_WEAVE_FRAGMENT_SHADER,
  ae as YADIF_FRAGMENT_SHADER,
  oe as YADIF_UNIFORMS,
  Ce as decoderDeinterlaces,
  Le as forgetDecoderProbe,
  xe as probeDecoder,
  Re as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
