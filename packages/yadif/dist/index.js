const ce = "" + new URL("assets/worker-CRbacN6K.js", import.meta.url).href, ue = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, fe = `#version 300 es
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
`, V = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  topFieldFirst: "uTopFieldFirst",
  match: "uMatch"
}, x = 288, M = 162, de = `#version 300 es
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
  ivec2 targetSize = ivec2(${x}, ${M});
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
`, me = `#version 300 es
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
`, pe = `#version 300 es
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
  ivec2 targetSize = ivec2(${x}, ${M});
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
class b {
  static CYCLE = 5;
  static COMB_THRESHOLD = 9;
  static COMBED_PIXEL_LIMIT = 80;
  static DECIMATE_BLOCK = 32;
  static DUPLICATE_PERCENT = 1.1;
  #r;
  #t;
  #e;
  #i = 0;
  #v = null;
  #o = [];
  #b = null;
  #_ = 1 / 0;
  #U = 1 / 0;
  constructor(e, i) {
    this.#r = e, this.#t = i, this.#e = 255 * b.DECIMATE_BLOCK ** 2 * b.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, i, t, A, r = b.COMBED_PIXEL_LIMIT) {
    const s = A ? 1 : 0, n = { p: e, c: i, n: t };
    let a = this.#I("c", "p", s, n);
    const f = /* @__PURE__ */ new Map(), o = (m) => {
      const w = f.get(m);
      if (w !== void 0) return w;
      const E = b.#N(
        this.weave(e, i, t, m, A),
        this.#r,
        this.#t
      );
      return f.set(m, E), E;
    }, u = o(a), l = o("n");
    (l * 3 < u || l * 2 < u && u > r) && Math.abs(l - u) >= 30 && l < r && (a = "n");
    const h = o(a), d = h >= r;
    return d && (a = "c"), {
      match: a,
      combScore: h,
      isCombed: d,
      luma: this.weave(e, i, t, a, A)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const i = this.#i, t = this.#b ? b.#ye(
      this.#b,
      e,
      this.#r,
      this.#t
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#o.push(t);
    const A = this.#v === i, r = A && t.maxBlockDifference < this.#e;
    A && !r && (this.#v = null);
    const s = this.#v;
    this.#b = e.slice(), this.#i++;
    let n = this.#v;
    if (this.#i === b.CYCLE) {
      let a = 0, f = null;
      for (let o = 1; o < this.#o.length; o++)
        (this.#o[o]?.maxBlockDifference ?? 1 / 0) < (this.#o[a]?.maxBlockDifference ?? 1 / 0) ? (f = a, a = o) : (f === null || (this.#o[o]?.maxBlockDifference ?? 1 / 0) < (this.#o[f]?.maxBlockDifference ?? 1 / 0)) && (f = o);
      this.#_ = this.#o[a]?.maxBlockDifference ?? 1 / 0, this.#U = f === null ? 1 / 0 : this.#o[f]?.maxBlockDifference ?? 1 / 0, n = (this.#o[a]?.maxBlockDifference ?? 1 / 0) < this.#e ? a : null, this.#v = n, this.#o = [], this.#i = 0;
    }
    return {
      cycleIndex: i,
      maxBlockDifference: t.maxBlockDifference,
      totalDifference: t.totalDifference,
      shouldDrop: r,
      dropIndex: s,
      nextDropIndex: n,
      lowestCycleDifference: this.#_,
      runnerUpCycleDifference: this.#U
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, i, t, A, r) {
    if (A === "c") return i.slice();
    const s = i.slice(), n = A === "p" ? e : t, a = s.length / this.#t, f = r ? 1 : 0;
    for (let o = f; o < this.#t; o += 2)
      s.set(
        n.subarray(o * a, (o + 1) * a),
        o * a
      );
    return s;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#i = 0, this.#v = null, this.#o = [], this.#b = null, this.#_ = 1 / 0, this.#U = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #I(e, i, t, A) {
    const r = this.#r, s = this.#t, n = 2 - t, a = 2 - t, f = A[e], o = A[i], u = b.#Te(
      f,
      o,
      r,
      s,
      t
    );
    let l = 0, h = 0, d = 0, m = 0, w = 0, E = 0;
    for (let C = 2; C < s - 2; C += 2) {
      const y = (C - 2) / 2, Y = n - 1 + y * 2, Z = n + 1 + y * 2, j = n + 3 + y * 2, O = n + y * 2, X = O + 2, B = a + y * 2, S = B + 2, ee = n + y * 2;
      for (let D = 8; D < r - 8; D++) {
        const P = (u[ee * r + D] ?? 0) | (u[(ee + 2) * r + D] ?? 0);
        if (P === 0) continue;
        const te = (A.c[Y * r + D] ?? 0) + ((A.c[Z * r + D] ?? 0) << 2) + (A.c[j * r + D] ?? 0), _ = Math.abs(
          3 * ((f[O * r + D] ?? 0) + (f[X * r + D] ?? 0)) - te
        ), U = Math.abs(
          3 * ((o[B * r + D] ?? 0) + (o[S * r + D] ?? 0)) - te
        );
        _ > 23 && (P & 1) !== 0 && (l += _), U > 23 && (P & 1) !== 0 && (m += U), _ > 42 && (P & 2) !== 0 && (h += _), U > 42 && (P & 2) !== 0 && (w += U), _ > 42 && (P & 4) !== 0 && (d += _), U > 42 && (P & 4) !== 0 && (E += U);
      }
    }
    h < 500 && w < 500 && (d >= 500 || E >= 500) && Math.max(d, E) > 3 * Math.min(d, E) && (h = d, w = E);
    const v = Math.floor(l / 6 + 0.5), k = Math.floor(m / 6 + 0.5), g = Math.floor(h / 6 + 0.5), p = Math.floor(w / 6 + 0.5), N = Math.max(v, k) / Math.max(Math.min(v, k), 1), G = Math.max(g, p) / Math.max(Math.min(g, p), 1), W = Math.max(g, p) / Math.max(Math.max(v, k), 1);
    return (g >= 500 || p >= 500) && (g * 2 < p || p * 2 < g) || (g >= 1e3 || p >= 1e3) && (g * 3 < p * 2 || p * 3 < g * 2) || (g >= 2e3 || p >= 2e3) && (g * 5 < p * 4 || p * 5 < g * 4) || (g >= 4e3 || p >= 4e3) && G > N || W > 5e-3 && Math.max(g, p) > 150 && (g * 2 < p || p * 2 < g) ? g > p ? i : e : v > k ? i : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #Te(e, i, t, A, r) {
    const s = Array.from(
      { length: Math.ceil(A / 2) },
      () => new Uint8Array(t)
    ), n = r === 1 ? 1 : 0;
    for (let o = 0; o < s.length; o++) {
      const u = Math.min(A - 1, n + o * 2), l = s[o];
      if (l)
        for (let h = 0; h < t; h++)
          l[h] = Math.abs(
            (e[u * t + h] ?? 0) - (i[u * t + h] ?? 0)
          );
    }
    const a = new Uint8Array(t * A), f = r === 1 ? 3 : 2;
    for (let o = 1; o < s.length - 1; o++) {
      const u = f + (o - 1) * 2;
      if (u >= A) break;
      const l = s[o];
      if (l)
        for (let h = 1; h < t - 1; h++) {
          const d = l[h] ?? 0;
          if (d <= 3) continue;
          let m = 0;
          for (let p = h - 1; p <= h + 1; p++)
            m += (s[o - 1]?.[p] ?? 0) > 3 ? 1 : 0, m += (s[o]?.[p] ?? 0) > 3 ? 1 : 0, m += (s[o + 1]?.[p] ?? 0) > 3 ? 1 : 0;
          if (m <= 1) continue;
          const w = u * t + h;
          if (a[w] = 1, d <= 19) continue;
          m = 0;
          let E = !1, v = !1;
          for (let p = h - 1; p <= h + 1; p++)
            (s[o - 1]?.[p] ?? 0) > 19 && (m++, E = !0), (s[o]?.[p] ?? 0) > 19 && m++, (s[o + 1]?.[p] ?? 0) > 19 && (m++, v = !0);
          if (m <= 3) continue;
          if (E && v) {
            a[w] |= 2;
            continue;
          }
          let k = !1, g = !1;
          for (let p = Math.max(h - 4, 0); p < Math.min(h + 5, t); p++)
            o !== 1 && (s[o - 2]?.[p] ?? 0) > 19 && (k = !0), (s[o - 1]?.[p] ?? 0) > 19 && (E = !0), (s[o + 1]?.[p] ?? 0) > 19 && (v = !0), o !== s.length - 2 && (s[o + 2]?.[p] ?? 0) > 19 && (g = !0);
          E && (v || k) || v && (E || g) ? a[w] |= 2 : m > 5 && (a[w] |= 4);
        }
    }
    return a;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #N(e, i, t) {
    const A = new Uint8Array(i * t);
    for (let s = 0; s < t; s++) {
      const n = s * i, a = Math.max(0, Math.min(t - 1, s === 0 ? 1 : s - 1)) * i, f = Math.max(
        0,
        Math.min(t - 1, s === t - 1 ? t - 2 : s + 1)
      ) * i, o = Math.max(0, Math.min(t - 1, s < 2 ? s === 0 ? 2 : 3 : s - 2)) * i, u = Math.max(
        0,
        Math.min(
          t - 1,
          s + 2 >= t ? s === t - 1 ? t - 3 : t - 4 : s + 2
        )
      ) * i;
      for (let l = 0; l < i; l++) {
        const h = e[n + l] ?? 0, d = e[a + l] ?? 0, m = e[f + l] ?? 0, w = e[o + l] ?? 0, E = e[u + l] ?? 0;
        (s === 0 ? Math.abs(h - m) > b.COMB_THRESHOLD : s === t - 1 ? Math.abs(h - d) > b.COMB_THRESHOLD : Math.abs(h - d) > b.COMB_THRESHOLD && Math.abs(h - m) > b.COMB_THRESHOLD) && Math.abs(
          4 * h - 3 * (d + m) + w + E
        ) > b.COMB_THRESHOLD * 6 && (A[s * i + l] = 255);
      }
    }
    let r = 0;
    for (const s of [0, 8])
      for (const n of [0, 8])
        for (let a = s; a < t; a += 16)
          for (let f = n; f < i; f += 16) {
            let o = 0;
            for (let u = Math.max(1, a); u < Math.min(t - 1, a + 16); u++)
              for (let l = f; l < Math.min(i, f + 16); l++) {
                const h = u * i + l;
                A[h - i] === 255 && A[h] === 255 && A[h + i] === 255 && o++;
              }
            r = Math.max(r, o);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #ye(e, i, t, A) {
    const r = b.DECIMATE_BLOCK / 2, s = Math.ceil(t / r), n = Math.ceil(A / r), a = new Float64Array(s * n), f = e.length / (t * A);
    for (let l = 0; l < A; l++) {
      const h = Math.floor(l / r);
      for (let d = 0; d < t; d++) {
        const m = Math.floor(d / r), w = h * s + m, E = (l * t + d) * f;
        if (f === 1) {
          a[w] = (a[w] ?? 0) + Math.abs((e[E] ?? 0) - (i[E] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[E] ?? 0) * 0.2126 + (e[E + 1] ?? 0) * 0.7152 + (e[E + 2] ?? 0) * 0.0722
        ), k = Math.round(
          (i[E] ?? 0) * 0.2126 + (i[E + 1] ?? 0) * 0.7152 + (i[E + 2] ?? 0) * 0.0722
        );
        if (a[w] = (a[w] ?? 0) + Math.abs(v - k), (d & 1) !== 0 || (l & 1) !== 0) continue;
        let g = 0, p = 0, N = 0, G = 0, W = 0, C = 0, y = 0;
        for (let X = l; X < Math.min(l + 2, A); X++)
          for (let B = d; B < Math.min(d + 2, t); B++) {
            const S = (X * t + B) * f;
            g += e[S] ?? 0, p += e[S + 1] ?? 0, N += e[S + 2] ?? 0, G += i[S] ?? 0, W += i[S + 1] ?? 0, C += i[S + 2] ?? 0, y++;
          }
        const Y = Math.round(
          (-0.114572 * g - 0.385428 * p + 0.5 * N) / y
        ), Z = Math.round(
          (-0.114572 * G - 0.385428 * W + 0.5 * C) / y
        ), j = Math.round(
          (0.5 * g - 0.454153 * p - 0.045847 * N) / y
        ), O = Math.round(
          (0.5 * G - 0.454153 * W - 0.045847 * C) / y
        );
        a[w] = (a[w] ?? 0) + Math.abs(Y - Z) + Math.abs(j - O);
      }
    }
    let o = -1;
    for (let l = 0; l < n - 1; l++)
      for (let h = 0; h < s - 1; h++)
        o = Math.max(
          o,
          (a[l * s + h] ?? 0) + (a[l * s + h + 1] ?? 0) + (a[(l + 1) * s + h] ?? 0) + (a[(l + 1) * s + h + 1] ?? 0)
        );
    let u = 0;
    for (const l of a) u += l;
    return { maxBlockDifference: o, totalDifference: u };
  }
}
let oe = null;
function Ee(c) {
  oe = c;
}
const we = 0.5, T = 3, le = 5, L = le + 1, ie = 1e3, q = 4, J = 200, ge = 0.25, ve = 1e3 / 60, be = 0.02, se = 500, Te = 250, ye = 1e3 / 30, R = 160, F = 90;
function Ae(c) {
  if (!Number.isFinite(c) || c < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return c;
}
const De = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, Fe = `#version 300 es
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
function xe(c) {
  return Math.max(0, Math.round(c * 1e6));
}
class Me {
  #r;
  #t = !1;
  #e = 0;
  #i = 0;
  constructor(e, i = !1) {
    this.#r = e, this.#t = i;
  }
  /** sink または表示点captureが有効なら真。 */
  get enabled() {
    return this.#r !== void 0 || this.#t;
  }
  /** 現在の世代。 */
  get generation() {
    return this.#e;
  }
  /** 最後に発行した通番。 */
  get frameId() {
    return this.#i;
  }
  /** 古い世代を捨てる。境界ごとに1回だけ呼ぶ。 */
  invalidate() {
    return this.#e += 1, this.#e;
  }
  /** sink を離す。以後の emit は何もしない。 */
  destroy() {
    this.#r = void 0, this.#t = !1;
  }
  /**
   * Worker 境界を越えた meta を通番のまま sink へ渡す。Worker 側の
   * generation/frameId を付け替えず、到着順（＝Worker の送出順）を保つ。
   */
  deliver(e) {
    this.#r?.(e);
  }
  /**
   * 1枚の加工出力を通知する。sink/captureともなければnullを返す。
   * progressive/raw 用の source は型に存在しないため混ざらない。
   */
  emit(e, i, t, A, r) {
    const s = this.#r;
    if (!s && !this.#t) return null;
    this.#i += 1;
    const n = {
      source: e,
      mediaTimestampUs: i,
      generation: this.#e,
      frameId: this.#i,
      second: t,
      width: A,
      height: r
    };
    return s?.(n), n;
  }
}
function Ue() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class Ie extends EventTarget {
  #r;
  #t;
  #e;
  #i;
  #v;
  #o;
  /** The program that copies a filtered picture onto the canvas. */
  #b;
  #_;
  #U;
  /** The reduced pass that reads previous, current and next luma together. */
  #I = null;
  #Te = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #N = null;
  #ye = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #se = null;
  #ft = null;
  #G = null;
  #y = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #T = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #Ae = L - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #d = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #A = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #W = null;
  #De = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #X = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #re = ve;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #Q = null;
  #Ge;
  #D;
  #p;
  #Y;
  #We;
  #S = "video";
  #ne = "c";
  #Xe = 0;
  #He = !0;
  #Oe = new b(x, M);
  #ze = 1 / 0;
  #Qe = 1 / 0;
  #H = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #a = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #u = 0;
  #m = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #E = T - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #l = 0;
  #ae = 0;
  #Fe = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #he = !1;
  #Z = null;
  /** requestVideoFrameCallback() の停止を検出するために保持する最終通知時刻。 */
  #xe = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #j = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #Ye = 0;
  #f = !1;
  #Me = !1;
  #Re = !1;
  #c = null;
  #V = [];
  #F = !1;
  #Ze;
  #ke;
  #q;
  #M;
  #C;
  #oe = 0;
  /**
   * A presenter frame delivery is recent: the presenter owns the picture and the
   * built-in canvas must stay hidden so a stale still cannot cover it. The window
   * expires so progressive pictures, which the presenter never receives, are
   * still shown through the fork's own canvas.
   */
  #je = 0;
  #le;
  #Se;
  #Ve = !1;
  #P;
  /** Diagnostic-only; the normal Canvas queue remains unchanged by default. */
  #ce;
  /** Diagnostic-only full-size queued-frame transport. */
  #J;
  /** Optional 160x90 framebuffer/canvas used by the bounded transport. */
  #ue = null;
  /** 診断 hook の世代管理。option 未指定時は null で一切動かない。 */
  #K;
  #n;
  #Ce;
  #R;
  #qe;
  #h = null;
  #s;
  #fe = !1;
  #Je = 0;
  #Ke = !1;
  #Nt = 0;
  #de = !1;
  #Pe = !1;
  #$ = null;
  #Gt = 0;
  #me = /* @__PURE__ */ new Map();
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #k = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    late: 0,
    queueResetted: 0
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #O = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #$e = 0;
  #Le = 0;
  #z = 0;
  #pe = 0;
  #Ee = 0;
  #we = 0;
  #ee = 0;
  constructor(e, i = {}, t = null) {
    if (super(), this.#e = e, this.#D = i.doubleRate ?? !1, this.#p = i.autoFilm ?? !1, this.#Y = Ae(
      i.filmCombThreshold ?? b.COMBED_PIXEL_LIMIT
    ), this.#We = i.spatialCheck ?? !0, this.#Ze = i.onStats, this.#ke = i.diagnostic?.onFilteredPicture, this.#q = i.diagnostic?.onPresentedFrame, i.presenter !== void 0) {
      if (i.diagnostic?.onQueuedFrame !== void 0 || i.diagnostic?.onQueuedMeta !== void 0 || i.queuedFrameSink !== void 0)
        throw new TypeError(
          "presenter cannot be combined with diagnostic frame transport"
        );
      if (typeof VideoFrame > "u")
        throw new TypeError("presenter requires VideoFrame");
    }
    if (this.#C = i.presenter ?? null, this.#M = i.presenter ? (s, n) => i.presenter(s, {
      mediaTimestampUs: n.mediaTimestampUs,
      durationUs: n.durationUs
    }) : i.diagnostic?.onQueuedFrame, this.#le = i.diagnostic?.onQueuedMeta, this.#Se = i.queuedFrameSink ?? null, this.#P = i.diagnostic?.onPresentationQueue, this.#ce = (this.#M !== void 0 || this.#le !== void 0) && (i.presenter !== void 0 || i.diagnostic?.bypassDisplayQueue === !0), this.#J = i.presenter !== void 0 || i.diagnostic?.captureQueuedFrameFullSize === !0, this.#J && this.#M === void 0 && this.#le === void 0)
      throw new TypeError(
        "captureQueuedFrameFullSize requires onQueuedFrame or onQueuedMeta"
      );
    if (this.#J && !this.#ce)
      throw new TypeError(
        "captureQueuedFrameFullSize requires bypassDisplayQueue"
      );
    this.#K = this.#ke || this.#q || this.#M || this.#P ? new Me(
      this.#ke,
      this.#q !== void 0 || this.#M !== void 0 || this.#P !== void 0
    ) : null, this.#n = t, this.#R = t ? "main" : i.rendering ?? "auto", this.#qe = i.workerUrl ?? oe, this.#s = this.#R === "main" ? "main" : "idle", this.#t = t ? t.canvas : document.createElement("canvas"), this.#r = t?.canvas ?? (this.#R === "main" ? this.#t : document.createElement("canvas")), this.#Ce = e, t || (this.#t.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const A = this.#r.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!A) throw new Error("this browser has no WebGL2");
    this.#i = A, this.#v = H(A, fe);
    const r = this.#v;
    this.#o = Object.fromEntries(
      Object.entries(ue).map(([s, n]) => [
        s,
        A.getUniformLocation(r, n)
      ])
    ), this.#b = H(A, Fe), this.#_ = A.getUniformLocation(this.#b, "uField"), this.#U = A.getUniformLocation(this.#b, "uFlip"), this.#Wt(), this.#p && this.#Tt(), this.#r.addEventListener(
      "webglcontextlost",
      this.#It
    ), this.#Ge = t ? null : new ResizeObserver(() => this.#Ne()), e.addEventListener("emptied", this.#Bt), e.addEventListener("resize", this.#Lt), e.addEventListener("pause", this.#B), e.addEventListener("ended", this.#B), e.addEventListener("seeking", this.#Ut), e.addEventListener("seeked", this.#B), e.addEventListener("ratechange", this.#B);
  }
  get running() {
    return this.#f && (this.#c?.interlaced ?? !0);
  }
  /**
   * @internal Diagnostic: the effective render path of THIS (main-side)
   * instance. Stats relayed from the worker engine describe that engine
   * instead, so this getter is the authority for "is the main thread
   * rendering or the worker".
   */
  get renderPath() {
    return {
      rendering: this.#R,
      workerState: this.#s,
      externalHost: this.#n !== null,
      // presenter 指定時に frame を配送できなかった回数。0 以外は表示欠落を
      // 意味するため、無言で握りつぶさず観測できるようにする。
      presenterFailures: this.#oe
    };
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#t;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #Be() {
    return this.#c?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #dt() {
    return {
      doubleRate: this.#D,
      autoFilm: this.#p,
      filmCombThreshold: this.#Y,
      spatialCheck: this.#We,
      diagnostic: this.#ke !== void 0,
      capturePresentedFrames: this.#q !== void 0,
      captureQueuedFrames: this.#M !== void 0,
      captureQueuedFrameFullSize: this.#J,
      capturePresentationQueue: this.#P !== void 0,
      bypassDisplayQueue: this.#ce,
      captureQueuedMeta: this.#le !== void 0
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#Me;
  }
  set enabled(e) {
    this.#Me = e, this.#st(), this.#h?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const i = this.#c?.interlaced !== e?.interlaced, t = i || this.#c?.topFieldFirst !== e?.topFieldFirst;
    this.#c = e, this.#h?.postMessage({ type: "scan", scan: e }), t && (this.#l = 0, this.#g(), this.#w(), i && (this.#a = 0), this.#d = null, this.#x(!1)), this.#st(), t && ((e?.interlaced ?? !0) && (this.#n || this.#s === "main") ? this.#te() : this.#at());
  }
  get scan() {
    return this.#c;
  }
  set videoTimeline(e) {
    this.#V = e, this.#h?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#c = null), this.#st();
  }
  get videoTimeline() {
    return this.#V;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#Q ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#D;
  }
  set doubleRate(e) {
    e !== this.#D && (this.#D = e, this.#it(), this.#A.length = 0, this.#w(), e ? (this.#u > 0 && this.#ct(), (this.#c?.interlaced ?? !0) && (this.#n || this.#s === "main") && this.#te()) : this.#p || (this.#d = null, this.#x(!1), this.#ie()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#p;
  }
  set autoFilm(e) {
    e !== this.#p && (this.#p = e, this.#it(), this.#g(), this.#w(), e ? (this.#Tt(), this.#u > 0 && (this.#Pt(), this.#ct()), (this.#c?.interlaced ?? !0) && (this.#n || this.#s === "main") && this.#te()) : (this.#lt(), this.#D || (this.#d = null, this.#x(!1), this.#ie())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#Y;
  }
  set filmCombThreshold(e) {
    const i = Ae(e);
    i !== this.#Y && (this.#Y = i, this.#it(), this.#p && this.#g());
  }
  /** 診断 hook の現在世代。未指定時は 0。 */
  get diagnosticGeneration() {
    return this.#K?.generation ?? 0;
  }
  /**
   * YADIF/film の1出力を診断 sink へ通知する。main 側の描画エンジンと
   * Worker 側の描画エンジン（externalHost 付きは workerState が "main"）が
   * 同じここを通る。progressive/raw の表示経路と capture() の再描画
   * (`countOutput === false`) からは呼ばない。
   */
  #mt(e, i, t) {
    const A = this.#K;
    return !A || this.#s !== "main" || !Number.isFinite(i) ? null : A.emit(
      e,
      xe(i),
      t,
      this.#u,
      this.#m
    );
  }
  /**
   * Preserve the media element's display geometry when a processed canvas is
   * wrapped in a VideoFrame.  The WebGL canvas remains coded-size pixels;
   * displayWidth/displayHeight are metadata only and therefore do not resample
   * or alter the processed picture.
   */
  #et(e, i) {
    const t = { timestamp: e };
    Number.isFinite(i) && i > 0 && (t.duration = Math.max(1, Math.round(i * 1e3)));
    const A = this.#e.videoWidth, r = this.#e.videoHeight;
    return A > 0 && r > 0 && (t.displayWidth = A, t.displayHeight = r), t;
  }
  /**
   * 描画済みcanvasを同じ描画タスク内でVideoFrameへ取り込み、所有権を
   * callbackへ移す。表示点より前のproducer通知やcapture()再描画では呼ばない。
   */
  #tt(e, i) {
    const t = this.#q;
    if (!t || !e || typeof VideoFrame > "u") return;
    const A = this.#et(e.mediaTimestampUs, i), r = A.duration ?? null;
    let s;
    try {
      s = new VideoFrame(this.#r, A);
    } catch {
      return;
    }
    try {
      t(s, {
        ...e,
        presentationTimeMs: performance.now(),
        durationUs: r
      });
    } catch {
      s.close();
    }
  }
  /** Draw a processed texture into the renderer's existing output canvas. */
  #pt(e, i = !1) {
    const t = this.#i;
    t.bindFramebuffer(t.FRAMEBUFFER, null), t.useProgram(this.#b), t.activeTexture(t.TEXTURE0), t.bindTexture(t.TEXTURE_2D, e), t.uniform1i(this.#_, 0), t.uniform1i(this.#U, i ? 1 : 0), t.viewport(0, 0, this.#u, this.#m), t.drawArrays(t.TRIANGLES, 0, 3);
  }
  /**
   * Copy a processed output before it enters the old display queue.
   *
   * The default diagnostic path renders a bounded 160x90 copy and reads it
   * back for a small transport probe. The full-size path is a separate,
   * explicit direct-transport trial: it draws the processed texture into the
   * existing renderer canvas with the same GL context and creates a VideoFrame
   * from that canvas, without a JavaScript pixel readback. It is only valid
   * while the legacy display queue is bypassed, so no second display is kept.
   */
  #Et(e, i, t) {
    const A = this.#M;
    if (!A || !i || typeof VideoFrame > "u") {
      this.#C && (this.#oe += 1);
      return;
    }
    this.#kt();
    const r = performance.now();
    if (this.#J) {
      try {
        this.#pt(e);
      } catch {
        this.#C && (this.#oe += 1);
        return;
      }
      const u = this.#et(i.mediaTimestampUs, t), l = u.duration ?? null;
      let h;
      try {
        h = new VideoFrame(this.#r, u);
      } catch {
        this.#C && (this.#oe += 1);
        return;
      }
      try {
        A(h, {
          ...i,
          queuedAtMs: r,
          durationUs: l,
          captureWidth: this.#u,
          captureHeight: this.#m
        });
      } catch {
        this.#C && (this.#oe += 1), h.close();
      }
      return;
    }
    const s = this.#ue;
    if (!s) return;
    const n = this.#i;
    try {
      n.bindFramebuffer(n.FRAMEBUFFER, s.framebuffer), n.useProgram(this.#b), n.activeTexture(n.TEXTURE0), n.bindTexture(n.TEXTURE_2D, e), n.uniform1i(this.#_, 0), n.uniform1i(this.#U, 0), n.viewport(0, 0, R, F), n.drawArrays(n.TRIANGLES, 0, 3), n.readPixels(
        0,
        0,
        R,
        F,
        n.RGBA,
        n.UNSIGNED_BYTE,
        s.pixels
      );
      const u = R * 4;
      for (let h = 0; h < F; h++) {
        const d = (F - 1 - h) * u;
        s.flipped.set(
          s.pixels.subarray(d, d + u),
          h * u
        );
      }
      const l = s.context.createImageData(
        R,
        F
      );
      l.data.set(s.flipped), s.context.putImageData(l, 0, 0);
    } catch {
      n.bindFramebuffer(n.FRAMEBUFFER, null), n.viewport(0, 0, this.#u, this.#m);
      return;
    }
    n.bindFramebuffer(n.FRAMEBUFFER, null), n.viewport(0, 0, this.#u, this.#m);
    const a = this.#et(i.mediaTimestampUs, t), f = a.duration ?? null;
    let o;
    try {
      o = new VideoFrame(s.canvas, a);
    } catch {
      return;
    }
    try {
      A(o, {
        ...i,
        queuedAtMs: r,
        durationUs: f,
        captureWidth: R,
        captureHeight: F
      });
    } catch {
      o.close();
    }
  }
  /** Allocate the fixed diagnostic copy only when the pre-queue hook is used. */
  #Wt() {
    if (!this.#M || this.#J || this.#ue)
      return;
    let e = null;
    if (typeof OffscreenCanvas < "u")
      e = new OffscreenCanvas(
        R,
        F
      );
    else if (typeof document < "u") {
      const n = document.createElement("canvas");
      n.width = R, n.height = F, e = n;
    }
    if (!e) return;
    const i = e.getContext("2d", {
      willReadFrequently: !0
    });
    if (!i) return;
    const t = this.#i, A = t.createTexture();
    if (!A) return;
    t.bindTexture(t.TEXTURE_2D, A), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MIN_FILTER, t.NEAREST), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MAG_FILTER, t.NEAREST), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_S, t.CLAMP_TO_EDGE), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_T, t.CLAMP_TO_EDGE), t.texImage2D(
      t.TEXTURE_2D,
      0,
      t.RGBA,
      R,
      F,
      0,
      t.RGBA,
      t.UNSIGNED_BYTE,
      null
    );
    const r = t.createFramebuffer();
    if (!r) {
      t.deleteTexture(A);
      return;
    }
    t.bindFramebuffer(t.FRAMEBUFFER, r), t.framebufferTexture2D(
      t.FRAMEBUFFER,
      t.COLOR_ATTACHMENT0,
      t.TEXTURE_2D,
      A,
      0
    );
    const s = t.checkFramebufferStatus(t.FRAMEBUFFER) === t.FRAMEBUFFER_COMPLETE;
    if (t.bindFramebuffer(t.FRAMEBUFFER, null), !s) {
      t.deleteFramebuffer(r), t.deleteTexture(A);
      return;
    }
    this.#ue = {
      texture: A,
      framebuffer: r,
      canvas: e,
      context: i,
      pixels: new Uint8Array(
        R * F * 4
      ),
      flipped: new Uint8ClampedArray(
        R * F * 4
      )
    };
  }
  #Xt() {
    const e = this.#ue;
    e && (this.#i.deleteFramebuffer(e.framebuffer), this.#i.deleteTexture(e.texture), this.#ue = null);
  }
  /** 古い世代の診断画素を捨てる境界で世代を進める。 */
  #w() {
    this.#K?.invalidate();
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #it() {
    this.#h?.postMessage({
      type: "settings",
      options: this.#dt()
    });
  }
  #st() {
    this.#Me && (this.#V.length > 0 || (this.#c?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #Ht() {
    return this.#n || this.#R === "main" ? !1 : this.#s === "starting" || this.#s === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#qe !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#wt(), !0) : this.#R === "auto" ? (this.#_e(), !1) : (this.#s = "failed", this.#f = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #wt() {
    this.#L(), this.#h?.terminate(), this.#h = null, this.#de = !1, this.#Pe = !1;
    let e = this.#t;
    if (this.#Ke) {
      e = document.createElement("canvas"), e.className = this.#t.className;
      const s = this.#t.getAttribute("style");
      s === null ? e.removeAttribute("style") : e.setAttribute("style", s), e.style.visibility = "hidden", this.#t.parentElement && this.#t.replaceWith(e), this.#t = e;
    }
    const i = ++this.#Je;
    this.#w(), this.#s = "starting";
    let t, A;
    try {
      A = e.transferControlToOffscreen(), this.#Ke = !0, t = new Worker(this.#qe, { type: "module" });
    } catch (s) {
      this.#ge(
        s instanceof Error ? s.message : String(s)
      );
      return;
    }
    this.#h = t, t.onmessage = (s) => {
      i === this.#Je && !this.#Re ? this.#Ot(s.data) : (s.data.type === "presented" || s.data.type === "queued") && s.data.frame.close();
    }, t.onerror = (s) => {
      i === this.#Je && (s.preventDefault(), this.#ge(s.message || "the deinterlacer worker failed"));
    };
    const r = [A];
    this.#Se && !this.#Ve && (r.push(this.#Se), this.#Ve = !0), t.postMessage(
      {
        type: "initialize",
        canvas: A,
        options: this.#dt(),
        queuedFrameSink: this.#Ve ? this.#Se : null,
        scan: this.#c,
        videoTimeline: this.#V,
        enabled: this.#f,
        video: this.#At()
      },
      r
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #Ot(e) {
    switch (e.type) {
      case "ready":
        this.#s = "active", this.#f && (this.#ve(), this.#ht());
        break;
      case "failed":
        this.#ge(e.message);
        break;
      case "consumed": {
        this.#de = !1, this.#Pe = !0;
        const i = this.#$;
        this.#$ = null, i && this.#vt(i);
        break;
      }
      case "visibility":
        this.#t.style.visibility = this.#C !== null && performance.now() - this.#je < se ? "hidden" : e.visible ? "visible" : "hidden";
        break;
      case "diagnostic": {
        if (this.#s !== "active") break;
        this.#K?.deliver(e.meta);
        break;
      }
      case "queuedMeta": {
        if (this.#s !== "active") break;
        try {
          this.#le?.(e.meta);
        } catch {
        }
        break;
      }
      case "presented": {
        if (this.#s !== "active") {
          e.frame.close();
          break;
        }
        const i = this.#q;
        if (!i) {
          e.frame.close();
          break;
        }
        try {
          i(e.frame, e.meta);
        } catch {
          e.frame.close();
        }
        break;
      }
      case "queued": {
        if (this.#s !== "active") {
          e.frame.close();
          break;
        }
        const i = this.#M;
        if (!i) {
          e.frame.close();
          break;
        }
        this.#kt();
        try {
          i(e.frame, e.meta);
        } catch {
          e.frame.close();
        }
        break;
      }
      case "presentationQueue":
        this.#s === "active" && this.#P?.(e.meta);
        break;
      case "stats": {
        const i = {
          ...e.stats,
          dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0
        };
        this.dispatchEvent(new CustomEvent("stats", { detail: i })), this.#Ze?.(i);
        break;
      }
      case "capture": {
        const i = this.#me.get(e.id);
        if (this.#me.delete(e.id), !i) {
          e.image?.close();
          break;
        }
        e.image ? i.resolve(e.image) : createImageBitmap(this.#e).then(
          i.resolve,
          i.reject
        );
        break;
      }
    }
  }
  /** 一時的な Worker 障害を1回だけ復旧し、再失敗時は media element 自体を表示する。 */
  #ge(e) {
    if (this.#s === "starting" && this.#R === "auto" && !this.#fe) {
      this.#_e();
      return;
    }
    if (this.#gt(e), !this.#fe) {
      this.#fe = !0, this.#wt();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#s = "failed", this.#h?.terminate(), this.#h = null, this.#L(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #_e() {
    const e = this.#r;
    e.className = this.#t.className;
    const i = this.#t.getAttribute("style");
    i === null ? e.removeAttribute("style") : e.setAttribute("style", i), e.style.visibility = "hidden", this.#t.parentElement && this.#t.replaceWith(e), this.#t = e, this.#Ke = !1, this.#h?.terminate(), this.#h = null, this.#s = "main", this.#w(), this.#L(), this.#f && (this.#ve(), this.#ht(), (this.#c?.interlaced ?? !0) && this.#te());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #L() {
    this.#$?.frame.close(), this.#$ = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #gt(e) {
    for (const i of this.#me.values())
      i.reject(new Error(e));
    this.#me.clear();
  }
  start() {
    if (!(this.#f || this.#Re || this.#F)) {
      if (this.#f = !0, this.#_t(), this.#g(), this.#xe = performance.now(), this.#Ye = this.#xe, this.#Fe = Number.NaN, this.#j = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#si(), this.#ht(), this.#Ht()) {
        this.#h?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#s === "active" && this.#ve();
        return;
      }
      this.#ve(), (this.#c?.interlaced ?? !0) && this.#te();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#f && (this.#f = !1, this.#Z !== null && this.#e.cancelVideoFrameCallback(this.#Z), this.#Z = null, this.#Jt(), this.#at(), this.#l = 0, this.#d = null, this.#x(!1), this.#w(), this.#L(), this.#h?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#Re) {
      this.#Re = !0, this.#Me = !1, this.stop(), this.#h?.postMessage({ type: "destroy" }), this.#h?.terminate(), this.#h = null, this.#w(), this.#K?.destroy(), this.#L(), this.#gt("the deinterlacer was destroyed"), this.#r.removeEventListener(
        "webglcontextlost",
        this.#It
      ), this.#e.removeEventListener("emptied", this.#Bt), this.#e.removeEventListener("resize", this.#Lt), this.#e.removeEventListener("pause", this.#B), this.#e.removeEventListener("ended", this.#B), this.#e.removeEventListener("seeking", this.#Ut), this.#e.removeEventListener("seeked", this.#B), this.#e.removeEventListener("ratechange", this.#B), this.#Ai();
      for (const e of this.#y) this.#i.deleteTexture(e);
      this.#y = [], this.#Xt(), this.#ie(), this.#lt(), this.#i.deleteProgram(this.#v), this.#i.deleteProgram(this.#b), this.#I && this.#i.deleteProgram(this.#I), this.#N && this.#i.deleteProgram(this.#N), this.#se && this.#i.deleteProgram(this.#se), this.#i.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#s === "active" && this.#t.style.visibility === "visible" && this.#h) {
      const A = ++this.#Gt, r = new Promise((s, n) => {
        this.#me.set(A, { resolve: s, reject: n });
      });
      return this.#h.postMessage({
        type: "capture",
        id: A,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), r;
    }
    if (this.#s === "starting" || this.#s === "failed")
      return createImageBitmap(this.#e);
    const e = this.#d;
    if (this.#n && (!this.#f || this.#F || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#f || this.#F || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#ot(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#be(e.flush, e.second, null, !1) : this.#rt(null, !1);
    const i = this.#e.videoWidth, t = this.#e.videoHeight;
    return i > 0 && t > 0 && (i !== this.#r.width || t !== this.#r.height) ? createImageBitmap(this.#r, {
      resizeWidth: i,
      resizeHeight: t,
      resizeQuality: "high"
    }) : createImageBitmap(this.#r);
  }
  addEventListener(e, i, t) {
    super.addEventListener(e, i, t);
  }
  removeEventListener(e, i, t) {
    super.removeEventListener(e, i, t);
  }
  #ve() {
    this.#n || !this.#f || this.#Z !== null || (this.#Z = this.#e.requestVideoFrameCallback(this.#Qt));
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #At() {
    const e = [];
    for (let i = 0; i < this.#e.buffered.length; i++)
      e.push({
        start: this.#e.buffered.start(i),
        end: this.#e.buffered.end(i)
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
  #zt(e, i) {
    let t;
    try {
      t = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(i.mediaTime * 1e6))
      });
    } catch (r) {
      const s = r instanceof Error ? r.message : String(r);
      this.#R === "auto" && !this.#Pe && !this.#fe ? (this.#_e(), this.#Ue(e, i)) : this.#ge(s);
      return;
    }
    const A = {
      id: ++this.#Nt,
      frame: t,
      now: e,
      metadata: i,
      video: this.#At()
    };
    if (this.#de) {
      this.#$?.frame.close(), this.#$ = A;
      return;
    }
    this.#vt(A);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #vt(e) {
    const i = this.#h;
    if (!i || this.#s !== "active") {
      e.frame.close();
      return;
    }
    this.#de = !0;
    const t = { type: "frame", ...e };
    try {
      i.postMessage(t, [e.frame]);
    } catch (A) {
      this.#de = !1, e.frame.close();
      const r = A instanceof Error ? A.message : String(A);
      this.#R === "auto" && !this.#Pe && !this.#fe ? (this.#_e(), this.#Ue(e.now, e.metadata)) : this.#ge(r);
    }
  }
  #Qt = (e, i) => {
    this.#Z = null, !(!this.#f || this.#F) && (this.#xe = e, this.#j = Math.max(
      this.#j,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#bt(e, i), this.#ve());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #bt(e, i) {
    if (this.#Fe = i.mediaTime, this.#s === "active") {
      this.#zt(e, i);
      return;
    }
    this.#s !== "starting" && this.#Ue(e, i);
  }
  /** @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。 */
  ingestExternalFrame(e, i, t) {
    this.#Ce = t;
    try {
      this.#Ue(e, i);
    } finally {
      this.#Ce = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #Ue(e, i) {
    if (this.#Yt(i.mediaTime), i.width > 0 && i.height > 0) {
      let t = !1;
      if (!this.#he && this.#e.seeking) {
        const h = this.#e.buffered, d = this.#a >= q ? this.#a / 1e3 : J / 1e3;
        for (let m = 0; m < h.length; m++)
          if (i.mediaTime >= h.start(m) && i.mediaTime < h.end(m) && Math.abs(i.mediaTime - this.#e.currentTime) <= d) {
            t = !0;
            break;
          }
      }
      if (t && (this.#he = !0), (this.#u === 0 || this.#m === 0) && this.#Ct(i.width, i.height), this.#c && !this.#c.interlaced) {
        this.#ei();
        return;
      }
      const A = i.mediaTime - this.#ae, r = t || A < 0 || A > we;
      r && (this.#l = 0, this.#a = 0, this.#k.discontinuities++, this.#w(), this.#A.length = 0, this.#g());
      const s = this.#p && this.#O !== 0 && i.presentedFrames - this.#O > 1;
      if (this.#ti(i.presentedFrames, r), !r && s && (this.#l = 0, this.#g()), this.#l > 0 && i.mediaTime === this.#ae)
        return;
      !r && A > 0 && this.#Zt(A), this.#ae = i.mediaTime;
      const n = performance.now();
      n - this.#$e > ie && (this.#Le = n, this.#z = 0, this.#pe = 0, this.#Ee = 0, this.#we = 0, this.#ee = 0, this.#H = 0), this.#$e = n;
      const a = performance.now();
      this.#St();
      const f = this.#S, o = this.#p && this.#l === T && this.#jt();
      if (f !== this.#S && (this.#A.length = 0), !(o && this.#Ie())) if (this.#p && !this.#He && this.#S === "film")
        if (this.#Ie()) {
          const h = this.#a * 5 / 4;
          this.#Dt(1);
          const d = this.#A.at(-1), m = d == null ? e + h : d.at + d.duration;
          this.#Vt(m, h, i.mediaTime);
        } else
          this.#rt(null, !0, i.mediaTime);
      else if (this.#D && this.#Ie()) {
        const h = this.#a / 2;
        this.#Dt(2);
        const d = this.#A.at(-1), m = d == null ? e + h * 2 : d.at + d.duration;
        this.#yt(!1, m, h, i.mediaTime), this.#yt(
          !0,
          m + h,
          h,
          i.mediaTime + h / 1e3
        );
      } else
        this.#k.late += this.#A.length, this.#A.length = 0, this.#be(!1, !1, null, !0, i.mediaTime);
      this.#ee = Math.max(
        this.#ee,
        this.#A.length
      ), this.#pe += performance.now() - a, this.#z++, this.#ii(n);
    }
  }
  #Yt(e) {
    let i;
    for (let r = this.#V.length - 1; r >= 0; r--) {
      const s = this.#V[r];
      if (s.start <= e + 1e-6) {
        i = s;
        break;
      }
    }
    i?.codedSize && (i.codedSize.width !== this.#u || i.codedSize.height !== this.#m) && this.#Ct(i.codedSize.width, i.codedSize.height);
    const t = i?.scan;
    if (!t || this.#c?.interlaced === t.interlaced && this.#c.topFieldFirst === t.topFieldFirst)
      return;
    const A = this.#c?.interlaced;
    this.#c = t, this.#l = 0, this.#A.length = 0, this.#g(), this.#w(), A !== t.interlaced && (this.#a = 0), t.interlaced && (this.#n || this.#s === "main") ? this.#te() : this.#at();
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #Ie() {
    return (this.#D || this.#p) && this.#a > 0 && this.#T.length === L;
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
  #Zt(e) {
    const i = e * 1e3 / (this.#e.playbackRate || 1), t = this.#a > 0 ? Math.max(1, Math.round(i / this.#a)) : 1, A = i / t;
    A < q || A > J || (this.#a = this.#a > 0 ? this.#a + (A - this.#a) * ge : A);
  }
  /** Build the optional film passes only for callers that enable them. */
  #Tt() {
    if (this.#I && this.#N && this.#se) return;
    const e = this.#i, i = H(e, de), t = H(e, me), A = H(e, pe);
    this.#I = i, this.#Te = Object.fromEntries(
      Object.entries(V).filter(([r]) => r !== "match" && r !== "topFieldFirst").map(([r, s]) => [r, e.getUniformLocation(i, s)])
    ), this.#N = t, this.#ye = Object.fromEntries(
      Object.entries(V).map(([r, s]) => [
        r,
        e.getUniformLocation(t, s)
      ])
    ), this.#se = A, this.#ft = Object.fromEntries(
      Object.entries(V).map(([r, s]) => [
        r,
        e.getUniformLocation(A, s)
      ])
    );
  }
  /**
   * Run FFmpeg's fieldmatch and live decimate decisions on reduced luma.
   * Full decoded frames remain in GPU textures, while the first readback packs
   * the previous, current and next luma proxies into RGB. A second readback
   * supplies the selected RGB weave to its chroma-sensitive decimate metric.
   */
  #jt() {
    const e = this.#G, i = this.#I, t = this.#Te, A = this.#se, r = this.#ft;
    if (!e || !i || !t || !A || !r)
      return !1;
    const s = this.#i, n = this.#E, a = (this.#E + T - 1) % T, f = (this.#E + 1) % T, o = this.#Be;
    s.bindFramebuffer(s.FRAMEBUFFER, e.framebuffer), s.useProgram(i);
    for (const [E, v] of [f, a, n].entries())
      s.activeTexture(s.TEXTURE0 + E), s.bindTexture(s.TEXTURE_2D, this.#y[v] ?? null);
    s.uniform1i(t.prev, 0), s.uniform1i(t.cur, 1), s.uniform1i(t.next, 2), s.uniform2i(t.size, this.#u, this.#m), s.viewport(0, 0, x, M), s.drawArrays(s.TRIANGLES, 0, 3), s.readPixels(
      0,
      0,
      x,
      M,
      s.RGBA,
      s.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: u, currentLuma: l, nextLuma: h } = e;
    for (let E = 0; E < u.length; E++) {
      const v = E * 4;
      u[E] = e.pixels[v] ?? 0, l[E] = e.pixels[v + 1] ?? 0, h[E] = e.pixels[v + 2] ?? 0;
    }
    const d = this.#Oe.fieldMatch(
      u,
      l,
      h,
      o,
      this.#Y
    );
    s.useProgram(A), s.uniform1i(r.prev, 0), s.uniform1i(r.cur, 1), s.uniform1i(r.next, 2), s.uniform2i(r.size, this.#u, this.#m), s.uniform1i(r.topFieldFirst, o ? 1 : 0), s.uniform1i(
      r.match,
      d.match === "p" ? 0 : d.match === "c" ? 1 : 2
    ), s.drawArrays(s.TRIANGLES, 0, 3), s.readPixels(
      0,
      0,
      x,
      M,
      s.RGBA,
      s.UNSIGNED_BYTE,
      e.pixels
    );
    const m = this.#Oe.decimate(e.pixels);
    this.#ne = d.match, this.#Xe = d.combScore, this.#He = d.isCombed, this.#ze = m.lowestCycleDifference, this.#Qe = m.runnerUpCycleDifference;
    const w = m.dropIndex !== null && !d.isCombed;
    return (w ? "film" : "video") !== this.#S && (this.#S = w ? "film" : "video"), m.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Vt(e, i, t) {
    const A = this.#nt();
    if (A === null) return;
    const r = this.#T[A];
    if (!r) return;
    this.#Ae = A;
    const s = this.#rt(
      r.framebuffer,
      !0,
      t
    );
    this.#Et(r.texture, s, i), this.#ce || this.#A.push({
      slot: A,
      at: e,
      enqueuedAtMs: this.#P ? performance.now() : null,
      duration: i,
      diagnosticMeta: s
    });
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #rt(e, i = !0, t = Number.NaN) {
    const A = this.#N, r = this.#ye;
    if (!A || !r) return null;
    const s = this.#i, n = this.#E, a = (this.#E + T - 1) % T, f = (this.#E + 1) % T, o = this.#Be;
    s.bindFramebuffer(s.FRAMEBUFFER, e), s.useProgram(A);
    for (const [l, h] of [f, a, n].entries())
      s.activeTexture(s.TEXTURE0 + l), s.bindTexture(s.TEXTURE_2D, this.#y[h] ?? null);
    s.uniform1i(r.prev, 0), s.uniform1i(r.cur, 1), s.uniform1i(r.next, 2), s.uniform2i(r.size, this.#u, this.#m), s.uniform1i(r.topFieldFirst, o ? 1 : 0), s.uniform1i(
      r.match,
      this.#ne === "p" ? 0 : this.#ne === "c" ? 1 : 2
    ), s.viewport(0, 0, this.#u, this.#m), s.drawArrays(s.TRIANGLES, 0, 3);
    const u = i ? this.#mt("film", t, !1) : null;
    return e === null && (this.#d = { kind: "film" }, this.#x(!0), i && (this.#H++, this.#tt(u, this.#a))), u;
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #yt(e, i, t, A) {
    const r = this.#nt();
    if (r === null) return;
    const s = this.#T[r];
    if (!s) return;
    this.#Ae = r;
    const n = this.#be(
      !1,
      e,
      s.framebuffer,
      !0,
      A
    );
    this.#Et(s.texture, n, t), this.#ce || this.#A.push({
      slot: r,
      at: i,
      enqueuedAtMs: this.#P ? performance.now() : null,
      duration: t,
      diagnosticMeta: n
    });
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #Dt(e) {
    const i = Math.max(
      0,
      this.#A.length + e - le
    );
    let t = 0, A = 0;
    for (; A < i; ) {
      const r = this.#A.shift();
      if (!r) break;
      t += r.duration, A++;
    }
    for (const r of this.#A) r.at -= t;
    this.#k.late += A;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #nt() {
    const e = this.#d?.kind === "texture" ? this.#d.texture : null, i = new Set(this.#A.map(({ slot: t }) => t));
    for (let t = 1; t <= L; t++) {
      const A = (this.#Ae + t) % L, r = this.#T[A];
      if (r && r.texture !== e && !i.has(A))
        return A;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #te() {
    this.#W === null && (!this.#f || this.#F || (this.#De = 0, this.#W = this.#xt(this.#Ft)));
  }
  #at() {
    this.#W !== null && this.#qt(this.#W), this.#W = null, this.#A.length = 0;
  }
  #Ft = (e) => {
    if (this.#W = null, !(!this.#f || this.#F)) {
      if (this.#De > 0) {
        const i = e - this.#De;
        i >= 1 && i <= J && (this.#re = i < this.#re ? i : this.#re + (i - this.#re) * be);
      }
      this.#De = e, this.#s === "main" && this.#$t(e), this.#W = this.#xt(this.#Ft);
    }
  };
  /** ページと Worker のそれぞれが所有する requestAnimationFrame() へ表示ループを委ねる。 */
  #xt(e) {
    return this.#n ? this.#n.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #qt(e) {
    this.#n ? this.#n.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #ht() {
    this.#n || this.#X !== null || !this.#f || this.#F || (this.#X = requestAnimationFrame(this.#Mt));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Jt() {
    this.#X !== null && cancelAnimationFrame(this.#X), this.#X = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #Mt = (e) => {
    this.#X = null, !(!this.#f || this.#F) && (this.#Kt(e), this.#X = requestAnimationFrame(this.#Mt));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #Kt(e) {
    if (this.#n || e - this.#xe < Te || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const i = this.#e.currentTime, t = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, A = this.#a >= q ? this.#a : ye, r = t > this.#j, s = i !== this.#Fe && e - this.#Ye >= A * 0.75;
    !r && !s || (this.#j = Math.max(
      this.#j,
      t
    ), this.#Ye = e, this.#bt(e, {
      mediaTime: i,
      presentedFrames: Math.max(this.#O + 1, t),
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
  #$t(e) {
    const i = e + this.#re * 1.5, t = this.#A.length;
    let A = 0;
    const r = [];
    for (; this.#A[1] && this.#A[1].at <= i; ) {
      this.#k.late++;
      const a = this.#A.shift();
      a && r.push({
        frameId: a.diagnosticMeta?.frameId ?? null,
        generation: a.diagnosticMeta?.generation ?? null,
        mediaTimestampUs: a.diagnosticMeta?.mediaTimestampUs ?? null,
        plannedAtMs: a.at,
        enqueuedAtMs: a.enqueuedAtMs,
        reason: "deadline"
      }), A++;
    }
    let s = this.#A[0];
    if (this.#P?.({
      atMs: e,
      deadlineMs: i,
      queueLengthBefore: t,
      retired: A,
      queueLengthAfter: this.#A.length,
      selectedFrameId: s?.diagnosticMeta?.frameId ?? null,
      selectedAtMs: s?.at ?? null,
      selectedEnqueuedAtMs: s?.enqueuedAtMs ?? null,
      retiredFields: r
    }), !s || s.at > i)
      return;
    this.#A.shift();
    const n = performance.now();
    this.#Rt(s.slot, s.diagnosticMeta, s.duration), this.#we += performance.now() - n, this.#Ee++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #Rt(e, i = null, t = 0) {
    const A = this.#T[e];
    A && this.#ot(A.texture, !1, !0, i, t);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #ei() {
    this.#St();
    const e = this.#y[this.#E];
    e && this.#ot(e, !0), this.#l = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #x(e) {
    const t = this.#C !== null && performance.now() - this.#je < se ? !1 : e;
    if (this.#n) {
      this.#n.onVisibility(t);
      return;
    }
    this.#t.style.visibility = t ? "visible" : "hidden";
  }
  /** presenter が 1 枚提示したことを記録し、内蔵 canvas を隠す。 */
  #kt() {
    if (this.#C !== null) {
      if (this.#je = performance.now(), this.#n) {
        this.#n.onVisibility(!1);
        return;
      }
      this.#t.style.visibility = "hidden";
    }
  }
  #ot(e, i = !1, t = !0, A = null, r = 0) {
    this.#pt(e, i), this.#d = { kind: "texture", texture: e, flip: i }, this.#x(!0), t && (this.#H++, this.#tt(A, r));
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
  #ti(e, i) {
    this.#O !== 0 && !i && (this.#k.missed += Math.max(0, e - this.#O - 1)), this.#O = e;
  }
  #ii(e) {
    const i = e - this.#Le;
    if (i < ie) return;
    const t = this.#Ie() && (this.#D || this.#S === "film") ? this.#Ee : this.#z, A = {
      ...this.#k,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: t * 1e3 / i,
      frameMs: this.#z === 0 ? 0 : (this.#pe + this.#we) / this.#z,
      maxQueuedFields: this.#ee,
      mode: this.#S,
      match: this.#ne,
      combScore: this.#Xe,
      outputFps: this.#H * 1e3 / i,
      duplicateScore: this.#ze,
      duplicateRunnerUp: this.#Qe
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: A })), this.#Ze?.(A), this.#Le = e, this.#z = 0, this.#pe = 0, this.#Ee = 0, this.#we = 0, this.#ee = 0, this.#H = 0;
  }
  /** Take the newest frame into the ring. */
  #St() {
    const e = this.#i;
    this.#E = (this.#E + 1) % T, e.bindTexture(e.TEXTURE_2D, this.#y[this.#E] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#Ce
    ), this.#l = Math.min(this.#l + 1, T);
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
  #be(e, i, t, A = !0, r = Number.NaN) {
    if (this.#l === 0 || this.#F) return null;
    let s = null;
    A && (this.#l === T && !e ? this.#k.filtered++ : this.#k.degraded++, s = this.#mt(
      e ? "yadif-flush" : i ? "yadif-second" : "yadif-first",
      r,
      i
    ));
    const n = this.#i, a = this.#E, f = (this.#E + T - 1) % T, o = (this.#E + 1) % T;
    let u, l, h;
    this.#l === 1 ? u = l = h = a : e ? (u = f, l = h = a) : this.#l === 2 ? (u = l = f, h = a) : (u = o, l = f, h = a), n.bindFramebuffer(n.FRAMEBUFFER, t), n.useProgram(this.#v);
    for (const [m, w] of [u, l, h].entries())
      n.activeTexture(n.TEXTURE0 + m), n.bindTexture(n.TEXTURE_2D, this.#y[w] ?? null);
    n.uniform1i(this.#o.prev, 0), n.uniform1i(this.#o.cur, 1), n.uniform1i(this.#o.next, 2), n.uniform2i(this.#o.size, this.#u, this.#m);
    const d = this.#Be ? 0 : 1;
    return n.uniform1i(this.#o.parity, i ? 1 - d : d), n.uniform1i(this.#o.tff, this.#Be ? 1 : 0), n.uniform1i(this.#o.spatialCheck, this.#We ? 1 : 0), n.viewport(0, 0, this.#u, this.#m), n.drawArrays(n.TRIANGLES, 0, 3), t === null && (this.#d = { kind: "yadif", flush: e, second: i }, this.#x(!0), A && (this.#H++, this.#tt(s, this.#a))), s;
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
  #Ne() {
    if (!this.#Q) return;
    const e = this.#e, i = e.videoWidth, t = e.videoHeight;
    if (i === 0 || t === 0) return;
    const A = Math.min(
      e.offsetWidth / i,
      e.offsetHeight / t
    ), r = i * A, s = t * A;
    this.#t.style.left = `${e.offsetLeft + (e.offsetWidth - r) / 2}px`, this.#t.style.top = `${e.offsetTop + (e.offsetHeight - s) / 2}px`, this.#t.style.width = `${r}px`, this.#t.style.height = `${s}px`;
  }
  #Ct(e, i) {
    const t = this.#i;
    this.#r.width = e, this.#r.height = i, this.#u = e, this.#m = i, this.#l = 0, this.#d = null, this.#g(), this.#w(), this.#Ne();
    for (const A of this.#y) t.deleteTexture(A);
    this.#y = [];
    for (let A = 0; A < T; A++) {
      const r = t.createTexture();
      t.bindTexture(t.TEXTURE_2D, r), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MIN_FILTER, t.NEAREST), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MAG_FILTER, t.NEAREST), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_S, t.CLAMP_TO_EDGE), t.texParameteri(t.TEXTURE_2D, t.TEXTURE_WRAP_T, t.CLAMP_TO_EDGE), t.texImage2D(
        t.TEXTURE_2D,
        0,
        t.RGBA,
        e,
        i,
        0,
        t.RGBA,
        t.UNSIGNED_BYTE,
        null
      ), this.#y.push(r);
    }
    this.#ie(), this.#lt(), this.#p && this.#Pt(), (this.#D || this.#p) && this.#ct();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Pt() {
    if (this.#G) return;
    const e = this.#i, i = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      x,
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
      i,
      0
    );
    const A = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
    if (e.bindFramebuffer(e.FRAMEBUFFER, null), !A) {
      e.deleteFramebuffer(t), e.deleteTexture(i);
      return;
    }
    this.#G = {
      texture: i,
      framebuffer: t,
      pixels: new Uint8Array(x * M * 4),
      previousLuma: new Uint8Array(x * M),
      currentLuma: new Uint8Array(x * M),
      nextLuma: new Uint8Array(x * M)
    };
  }
  #lt() {
    this.#G && (this.#i.deleteFramebuffer(this.#G.framebuffer), this.#i.deleteTexture(this.#G.texture), this.#G = null);
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
  #ct() {
    const e = this.#i;
    if (!(this.#T.length === L || this.#u === 0)) {
      this.#ie();
      for (let i = 0; i < L; i++) {
        const t = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#u,
          this.#m,
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
          t,
          0
        );
        const r = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
        if (e.bindFramebuffer(e.FRAMEBUFFER, null), !r) {
          e.deleteFramebuffer(A), e.deleteTexture(t), this.#ie();
          return;
        }
        this.#T.push({ texture: t, framebuffer: A });
      }
      this.#Ae = L - 1;
    }
  }
  #ie() {
    const e = this.#i, i = this.#d?.kind === "texture" ? this.#d.texture : null;
    this.#T.some((t) => t.texture === i) && (this.#d = null);
    for (const { texture: t, framebuffer: A } of this.#T)
      e.deleteFramebuffer(A), e.deleteTexture(t);
    this.#T = [], this.#A.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #si() {
    if (this.#Q) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const i = document.createElement("div");
    i.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(i, this.#e), i.appendChild(this.#e), i.appendChild(this.#t), this.#Q = i, this.#Ge?.observe(this.#e), this.#Ne();
  }
  #Ai() {
    if (this.#n) return;
    const e = this.#Q;
    this.#Q = null, this.#Ge?.disconnect(), this.#t.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #Lt = () => this.#Ne();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #ut(e) {
    return !this.#h || this.#s === "main" ? !1 : (this.#h.postMessage({
      type: "event",
      name: e,
      video: this.#At()
    }), !0);
  }
  #Bt = () => {
    if (this.#w(), this.#Fe = Number.NaN, this.#ut("emptied")) {
      this.#L(), this.#x(!1);
      return;
    }
    this.#l = 0, this.#ae = 0, this.#A.length = 0, this.#a = 0, this.#_t(), this.#g(), this.#d = null, this.#x(!1);
  };
  #_t() {
    this.#k = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#O = 0, this.#Le = 0, this.#$e = 0, this.#z = 0, this.#pe = 0, this.#Ee = 0, this.#we = 0, this.#ee = 0, this.#H = 0, this.#g();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #g() {
    this.#A.length = 0, this.#S = "video", this.#ne = "c", this.#Xe = 0, this.#He = !0, this.#Oe.reset(), this.#ze = 1 / 0, this.#Qe = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #Ut = () => {
    if (this.#w(), this.#ut("seeking")) {
      this.#L();
      return;
    }
    this.#he = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #B = (e) => {
    if (this.#w(), (e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#ut(e.type)) {
      this.#L();
      return;
    }
    if (e.type === "seeked") {
      const t = this.#he;
      if (this.#he = !1, t) return;
      this.#l = 0, this.#g(), this.#d = null, this.#x(!1);
      return;
    }
    const i = e.type === "ratechange";
    if (i && (this.#a = 0, this.#ae = this.#e.currentTime), this.#A.length = 0, this.#f && this.#l > 0) {
      const t = this.#nt(), A = t === null ? void 0 : this.#T[t];
      if (t !== null && A) {
        this.#Ae = t;
        const r = this.#be(
          !0,
          !1,
          A.framebuffer,
          !0,
          this.#e.currentTime
        );
        this.#Rt(t, r, this.#a);
      } else
        this.#be(!0, !1, null, !0, this.#e.currentTime);
    }
    i && (this.#l = 0, this.#g());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #It = (e) => {
    if (e.preventDefault(), this.#n) {
      this.#n.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#s !== "active" && (this.#F = !0, this.stop());
  };
}
function H(c, e) {
  const i = c.createProgram(), t = re(c, c.VERTEX_SHADER, De), A = re(c, c.FRAGMENT_SHADER, e);
  if (c.attachShader(i, t), c.attachShader(i, A), c.linkProgram(i), c.deleteShader(t), c.deleteShader(A), !c.getProgramParameter(i, c.LINK_STATUS)) {
    const r = c.getProgramInfoLog(i);
    throw c.deleteProgram(i), new Error(
      `the deinterlacer failed to link: ${r ?? "no reason given"}`
    );
  }
  return i;
}
function re(c, e, i) {
  const t = c.createShader(e);
  if (!t) throw new Error("the deinterlacer could not create a shader");
  if (c.shaderSource(t, i), c.compileShader(t), !c.getShaderParameter(t, c.COMPILE_STATUS)) {
    const A = c.getShaderInfoLog(t);
    throw c.deleteShader(t), new Error(
      `the deinterlacer failed to compile: ${A ?? "no reason given"}`
    );
  }
  return t;
}
const ne = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Re = 0.5, ke = 3e3, ae = 0.1, I = 16, he = 'video/mp4; codecs="avc1.640029"';
let $ = null;
function Se(c = {}) {
  return $ ??= Ce(c), $;
}
async function Ne(c = {}) {
  return (await Se(c)).deinterlaces;
}
function Ge() {
  $ = null;
}
async function Ce(c) {
  const e = c.tolerance ?? Re, i = c.timeoutMs ?? ke, t = performance.now(), A = (n) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - t,
    error: n instanceof Error ? n.message : String(n)
  });
  if (typeof document > "u")
    return A(new Error("there is no document to decode in"));
  const r = document.createElement("video");
  r.muted = !0, r.defaultMuted = !0, r.playsInline = !0, r.preload = "auto";
  let s = null;
  try {
    s = Le(r, i);
    const n = Q(z(r, "loadeddata"), i), a = r.play().then(
      () => !0,
      () => !1
    );
    if (await s.ready, await n, await Be(r, i, await a), r.videoWidth === 0 || r.videoHeight === 0)
      return A(new Error("the probe clip decoded to nothing"));
    const f = _e(r);
    return {
      deinterlaces: f < 1 - e,
      survives: f,
      tookMs: performance.now() - t
    };
  } catch (n) {
    return A(n);
  } finally {
    r.pause(), r.removeAttribute("src"), r.replaceChildren(), r.load(), s && URL.revokeObjectURL(s.url);
  }
}
const K = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Pe = typeof MediaSource > "u";
function Le(c, e) {
  if (!K || !K.isTypeSupported(he))
    throw new Error("the probe clip needs Media Source Extensions");
  const i = ne.indexOf(","), t = atob(ne.slice(i + 1)), A = new Uint8Array(t.length);
  for (let a = 0; a < t.length; a++) A[a] = t.charCodeAt(a);
  const r = new K(), s = URL.createObjectURL(r);
  if (Pe) {
    c.disableRemotePlayback = !0;
    const a = document.createElement("source");
    a.type = "video/mp4", a.src = s, c.append(a), c.load();
  } else
    c.src = s;
  const n = (async () => {
    await Q(z(r, "sourceopen"), e);
    const a = r.addSourceBuffer(he), f = Q(z(a, "updateend"), e);
    a.appendBuffer(A), await f, r.endOfStream();
  })();
  return { url: s, ready: n };
}
async function Be(c, e, i) {
  if (i) {
    const t = performance.now();
    for (; c.currentTime < ae && performance.now() - t < e; )
      await new Promise((A) => requestAnimationFrame(A));
    c.pause();
  } else
    c.currentTime = ae, await Q(z(c, "seeked"), e);
}
function _e(c) {
  const e = c.videoHeight, i = document.createElement("canvas");
  i.width = I, i.height = e;
  const t = i.getContext("2d", { willReadFrequently: !0 });
  if (!t) throw new Error("there is no 2d context to read the clip with");
  t.imageSmoothingEnabled = !1, t.drawImage(c, 0, 0, I, e);
  const A = t.getImageData(0, 0, I, e).data, r = (o) => {
    let u = 0;
    for (let l = 0; l < I; l++)
      u += A[(o * I + l) * 4 + 1] ?? 0;
    return u / I;
  };
  let s = 0;
  const n = 2, a = e - 3;
  let f = r(n);
  for (let o = n + 1; o <= a; o++) {
    const u = r(o);
    s += Math.abs(u - f), f = u;
  }
  return s / (a - n) / 255;
}
function z(c, e) {
  return new Promise((i, t) => {
    c.addEventListener(e, () => i(), { once: !0 }), c.addEventListener(
      "error",
      () => {
        const A = c instanceof HTMLMediaElement ? c.error : null, r = A ? ` (MediaError ${A.code}${A.message ? `: ${A.message}` : ""})` : "";
        t(new Error(`the probe clip ${e} failed${r}`));
      },
      { once: !0 }
    );
  });
}
function Q(c, e) {
  return Promise.race([
    c,
    new Promise(
      (i, t) => setTimeout(
        () => t(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
Ee(ce);
export {
  Ie as Deinterlacer,
  Me as DiagnosticPictureGate,
  de as FILM_ANALYSIS_FRAGMENT_SHADER,
  pe as FILM_SAMPLE_FRAGMENT_SHADER,
  V as FILM_UNIFORMS,
  me as FILM_WEAVE_FRAGMENT_SHADER,
  fe as YADIF_FRAGMENT_SHADER,
  ue as YADIF_UNIFORMS,
  Ne as decoderDeinterlaces,
  Ge as forgetDecoderProbe,
  Se as probeDecoder,
  Ue as supportsDeinterlace,
  xe as toDiagnosticTimestampUs
};
//# sourceMappingURL=index.js.map
