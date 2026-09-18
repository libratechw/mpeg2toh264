const le = "" + new URL("assets/worker-BLVRkXMY.js", import.meta.url).href, ce = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, ue = `#version 300 es
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
}, F = 288, M = 162, fe = `#version 300 es
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
  ivec2 targetSize = ivec2(${F}, ${M});
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
`, de = `#version 300 es
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
  ivec2 targetSize = ivec2(${F}, ${M});
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
  #B = 1 / 0;
  #U = 1 / 0;
  constructor(e, t) {
    this.#r = e, this.#t = t, this.#e = 255 * b.DECIMATE_BLOCK ** 2 * b.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, A, r = b.COMBED_PIXEL_LIMIT) {
    const s = A ? 1 : 0, n = { p: e, c: t, n: i };
    let a = this.#_("c", "p", s, n);
    const f = /* @__PURE__ */ new Map(), o = (m) => {
      const E = f.get(m);
      if (E !== void 0) return E;
      const w = b.#I(
        this.weave(e, t, i, m, A),
        this.#r,
        this.#t
      );
      return f.set(m, w), w;
    }, u = o(a), l = o("n");
    (l * 3 < u || l * 2 < u && u > r) && Math.abs(l - u) >= 30 && l < r && (a = "n");
    const h = o(a), d = h >= r;
    return d && (a = "c"), {
      match: a,
      combScore: h,
      isCombed: d,
      luma: this.weave(e, t, i, a, A)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#i, i = this.#b ? b.#De(
      this.#b,
      e,
      this.#r,
      this.#t
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#o.push(i);
    const A = this.#v === t, r = A && i.maxBlockDifference < this.#e;
    A && !r && (this.#v = null);
    const s = this.#v;
    this.#b = e.slice(), this.#i++;
    let n = this.#v;
    if (this.#i === b.CYCLE) {
      let a = 0, f = null;
      for (let o = 1; o < this.#o.length; o++)
        (this.#o[o]?.maxBlockDifference ?? 1 / 0) < (this.#o[a]?.maxBlockDifference ?? 1 / 0) ? (f = a, a = o) : (f === null || (this.#o[o]?.maxBlockDifference ?? 1 / 0) < (this.#o[f]?.maxBlockDifference ?? 1 / 0)) && (f = o);
      this.#B = this.#o[a]?.maxBlockDifference ?? 1 / 0, this.#U = f === null ? 1 / 0 : this.#o[f]?.maxBlockDifference ?? 1 / 0, n = (this.#o[a]?.maxBlockDifference ?? 1 / 0) < this.#e ? a : null, this.#v = n, this.#o = [], this.#i = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: r,
      dropIndex: s,
      nextDropIndex: n,
      lowestCycleDifference: this.#B,
      runnerUpCycleDifference: this.#U
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, A, r) {
    if (A === "c") return t.slice();
    const s = t.slice(), n = A === "p" ? e : i, a = s.length / this.#t, f = r ? 1 : 0;
    for (let o = f; o < this.#t; o += 2)
      s.set(
        n.subarray(o * a, (o + 1) * a),
        o * a
      );
    return s;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#i = 0, this.#v = null, this.#o = [], this.#b = null, this.#B = 1 / 0, this.#U = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #_(e, t, i, A) {
    const r = this.#r, s = this.#t, n = 2 - i, a = 2 - i, f = A[e], o = A[t], u = b.#ye(
      f,
      o,
      r,
      s,
      i
    );
    let l = 0, h = 0, d = 0, m = 0, E = 0, w = 0;
    for (let C = 2; C < s - 2; C += 2) {
      const y = (C - 2) / 2, Y = n - 1 + y * 2, Z = n + 1 + y * 2, j = n + 3 + y * 2, H = n + y * 2, O = H + 2, B = a + y * 2, S = B + 2, ee = n + y * 2;
      for (let D = 8; D < r - 8; D++) {
        const P = (u[ee * r + D] ?? 0) | (u[(ee + 2) * r + D] ?? 0);
        if (P === 0) continue;
        const te = (A.c[Y * r + D] ?? 0) + ((A.c[Z * r + D] ?? 0) << 2) + (A.c[j * r + D] ?? 0), U = Math.abs(
          3 * ((f[H * r + D] ?? 0) + (f[O * r + D] ?? 0)) - te
        ), _ = Math.abs(
          3 * ((o[B * r + D] ?? 0) + (o[S * r + D] ?? 0)) - te
        );
        U > 23 && (P & 1) !== 0 && (l += U), _ > 23 && (P & 1) !== 0 && (m += _), U > 42 && (P & 2) !== 0 && (h += U), _ > 42 && (P & 2) !== 0 && (E += _), U > 42 && (P & 4) !== 0 && (d += U), _ > 42 && (P & 4) !== 0 && (w += _);
      }
    }
    h < 500 && E < 500 && (d >= 500 || w >= 500) && Math.max(d, w) > 3 * Math.min(d, w) && (h = d, E = w);
    const v = Math.floor(l / 6 + 0.5), k = Math.floor(m / 6 + 0.5), g = Math.floor(h / 6 + 0.5), p = Math.floor(E / 6 + 0.5), N = Math.max(v, k) / Math.max(Math.min(v, k), 1), G = Math.max(g, p) / Math.max(Math.min(g, p), 1), W = Math.max(g, p) / Math.max(Math.max(v, k), 1);
    return (g >= 500 || p >= 500) && (g * 2 < p || p * 2 < g) || (g >= 1e3 || p >= 1e3) && (g * 3 < p * 2 || p * 3 < g * 2) || (g >= 2e3 || p >= 2e3) && (g * 5 < p * 4 || p * 5 < g * 4) || (g >= 4e3 || p >= 4e3) && G > N || W > 5e-3 && Math.max(g, p) > 150 && (g * 2 < p || p * 2 < g) ? g > p ? t : e : v > k ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #ye(e, t, i, A, r) {
    const s = Array.from(
      { length: Math.ceil(A / 2) },
      () => new Uint8Array(i)
    ), n = r === 1 ? 1 : 0;
    for (let o = 0; o < s.length; o++) {
      const u = Math.min(A - 1, n + o * 2), l = s[o];
      if (l)
        for (let h = 0; h < i; h++)
          l[h] = Math.abs(
            (e[u * i + h] ?? 0) - (t[u * i + h] ?? 0)
          );
    }
    const a = new Uint8Array(i * A), f = r === 1 ? 3 : 2;
    for (let o = 1; o < s.length - 1; o++) {
      const u = f + (o - 1) * 2;
      if (u >= A) break;
      const l = s[o];
      if (l)
        for (let h = 1; h < i - 1; h++) {
          const d = l[h] ?? 0;
          if (d <= 3) continue;
          let m = 0;
          for (let p = h - 1; p <= h + 1; p++)
            m += (s[o - 1]?.[p] ?? 0) > 3 ? 1 : 0, m += (s[o]?.[p] ?? 0) > 3 ? 1 : 0, m += (s[o + 1]?.[p] ?? 0) > 3 ? 1 : 0;
          if (m <= 1) continue;
          const E = u * i + h;
          if (a[E] = 1, d <= 19) continue;
          m = 0;
          let w = !1, v = !1;
          for (let p = h - 1; p <= h + 1; p++)
            (s[o - 1]?.[p] ?? 0) > 19 && (m++, w = !0), (s[o]?.[p] ?? 0) > 19 && m++, (s[o + 1]?.[p] ?? 0) > 19 && (m++, v = !0);
          if (m <= 3) continue;
          if (w && v) {
            a[E] |= 2;
            continue;
          }
          let k = !1, g = !1;
          for (let p = Math.max(h - 4, 0); p < Math.min(h + 5, i); p++)
            o !== 1 && (s[o - 2]?.[p] ?? 0) > 19 && (k = !0), (s[o - 1]?.[p] ?? 0) > 19 && (w = !0), (s[o + 1]?.[p] ?? 0) > 19 && (v = !0), o !== s.length - 2 && (s[o + 2]?.[p] ?? 0) > 19 && (g = !0);
          w && (v || k) || v && (w || g) ? a[E] |= 2 : m > 5 && (a[E] |= 4);
        }
    }
    return a;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #I(e, t, i) {
    const A = new Uint8Array(t * i);
    for (let s = 0; s < i; s++) {
      const n = s * t, a = Math.max(0, Math.min(i - 1, s === 0 ? 1 : s - 1)) * t, f = Math.max(
        0,
        Math.min(i - 1, s === i - 1 ? i - 2 : s + 1)
      ) * t, o = Math.max(0, Math.min(i - 1, s < 2 ? s === 0 ? 2 : 3 : s - 2)) * t, u = Math.max(
        0,
        Math.min(
          i - 1,
          s + 2 >= i ? s === i - 1 ? i - 3 : i - 4 : s + 2
        )
      ) * t;
      for (let l = 0; l < t; l++) {
        const h = e[n + l] ?? 0, d = e[a + l] ?? 0, m = e[f + l] ?? 0, E = e[o + l] ?? 0, w = e[u + l] ?? 0;
        (s === 0 ? Math.abs(h - m) > b.COMB_THRESHOLD : s === i - 1 ? Math.abs(h - d) > b.COMB_THRESHOLD : Math.abs(h - d) > b.COMB_THRESHOLD && Math.abs(h - m) > b.COMB_THRESHOLD) && Math.abs(
          4 * h - 3 * (d + m) + E + w
        ) > b.COMB_THRESHOLD * 6 && (A[s * t + l] = 255);
      }
    }
    let r = 0;
    for (const s of [0, 8])
      for (const n of [0, 8])
        for (let a = s; a < i; a += 16)
          for (let f = n; f < t; f += 16) {
            let o = 0;
            for (let u = Math.max(1, a); u < Math.min(i - 1, a + 16); u++)
              for (let l = f; l < Math.min(t, f + 16); l++) {
                const h = u * t + l;
                A[h - t] === 255 && A[h] === 255 && A[h + t] === 255 && o++;
              }
            r = Math.max(r, o);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #De(e, t, i, A) {
    const r = b.DECIMATE_BLOCK / 2, s = Math.ceil(i / r), n = Math.ceil(A / r), a = new Float64Array(s * n), f = e.length / (i * A);
    for (let l = 0; l < A; l++) {
      const h = Math.floor(l / r);
      for (let d = 0; d < i; d++) {
        const m = Math.floor(d / r), E = h * s + m, w = (l * i + d) * f;
        if (f === 1) {
          a[E] = (a[E] ?? 0) + Math.abs((e[w] ?? 0) - (t[w] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[w] ?? 0) * 0.2126 + (e[w + 1] ?? 0) * 0.7152 + (e[w + 2] ?? 0) * 0.0722
        ), k = Math.round(
          (t[w] ?? 0) * 0.2126 + (t[w + 1] ?? 0) * 0.7152 + (t[w + 2] ?? 0) * 0.0722
        );
        if (a[E] = (a[E] ?? 0) + Math.abs(v - k), (d & 1) !== 0 || (l & 1) !== 0) continue;
        let g = 0, p = 0, N = 0, G = 0, W = 0, C = 0, y = 0;
        for (let O = l; O < Math.min(l + 2, A); O++)
          for (let B = d; B < Math.min(d + 2, i); B++) {
            const S = (O * i + B) * f;
            g += e[S] ?? 0, p += e[S + 1] ?? 0, N += e[S + 2] ?? 0, G += t[S] ?? 0, W += t[S + 1] ?? 0, C += t[S + 2] ?? 0, y++;
          }
        const Y = Math.round(
          (-0.114572 * g - 0.385428 * p + 0.5 * N) / y
        ), Z = Math.round(
          (-0.114572 * G - 0.385428 * W + 0.5 * C) / y
        ), j = Math.round(
          (0.5 * g - 0.454153 * p - 0.045847 * N) / y
        ), H = Math.round(
          (0.5 * G - 0.454153 * W - 0.045847 * C) / y
        );
        a[E] = (a[E] ?? 0) + Math.abs(Y - Z) + Math.abs(j - H);
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
let he = null;
function pe(c) {
  he = c;
}
const we = 0.5, T = 3, oe = 5, L = oe + 1, ie = 1e3, q = 4, J = 200, Ee = 0.25, ge = 1e3 / 60, ve = 0.02, be = 250, Te = 1e3 / 30, R = 160, x = 90;
function se(c) {
  if (!Number.isFinite(c) || c < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return c;
}
const ye = `#version 300 es
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
function xe(c) {
  return Math.max(0, Math.round(c * 1e6));
}
class Fe {
  #r;
  #t = !1;
  #e = 0;
  #i = 0;
  constructor(e, t = !1) {
    this.#r = e, this.#t = t;
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
  emit(e, t, i, A, r) {
    const s = this.#r;
    if (!s && !this.#t) return null;
    this.#i += 1;
    const n = {
      source: e,
      mediaTimestampUs: t,
      generation: this.#e,
      frameId: this.#i,
      second: i,
      width: A,
      height: r
    };
    return s?.(n), n;
  }
}
function Ue() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class _e extends EventTarget {
  #r;
  #t;
  #e;
  #i;
  #v;
  #o;
  /** The program that copies a filtered picture onto the canvas. */
  #b;
  #B;
  #U;
  /** The reduced pass that reads previous, current and next luma together. */
  #_ = null;
  #ye = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #I = null;
  #De = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #Ae = null;
  #pt = null;
  #N = null;
  #y = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #T = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #re = L - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #d = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #A = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #G = null;
  #xe = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #W = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #ne = ge;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #Y = null;
  #Ge;
  #D;
  #p;
  #Z;
  #We;
  #S = "video";
  #ae = "c";
  #Oe = 0;
  #Xe = !0;
  #He = new b(F, M);
  #ze = 1 / 0;
  #Qe = 1 / 0;
  #O = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #h = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #u = 0;
  #m = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #w = T - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #c = 0;
  #he = 0;
  #Fe = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #oe = !1;
  #j = null;
  /** requestVideoFrameCallback() の停止を検出するために保持する最終通知時刻。 */
  #Me = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #V = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #Ye = 0;
  #f = !1;
  #Re = !1;
  #ke = !1;
  #l = null;
  #q = [];
  #x = !1;
  #Ze;
  #Se;
  #J;
  #M;
  #X;
  #le = 0;
  /** Worker から通知された表示所有のミラー。ページ側 getter が参照する。 */
  #je = !1;
  #Ve = !1;
  #ce;
  #Ce;
  #qe = !1;
  #C;
  /** Diagnostic-only; the normal Canvas queue remains unchanged by default. */
  #H;
  /** Diagnostic-only full-size queued-frame transport. */
  #K;
  /** Optional 160x90 framebuffer/canvas used by the bounded transport. */
  #ue = null;
  /** 診断 hook の世代管理。option 未指定時は null で一切動かない。 */
  #$;
  #n;
  #Pe;
  #R;
  #Je;
  #a = null;
  #s;
  #fe = !1;
  #Ke = 0;
  #$e = !1;
  #Ot = 0;
  #de = !1;
  #Le = !1;
  #ee = null;
  #Xt = 0;
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
  #z = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #et = 0;
  #Be = 0;
  #Q = 0;
  #pe = 0;
  #we = 0;
  #Ee = 0;
  #te = 0;
  constructor(e, t = {}, i = null) {
    if (super(), this.#e = e, this.#D = t.doubleRate ?? !1, this.#p = t.autoFilm ?? !1, this.#Z = se(
      t.filmCombThreshold ?? b.COMBED_PIXEL_LIMIT
    ), this.#We = t.spatialCheck ?? !0, this.#Ze = t.onStats, this.#Se = t.diagnostic?.onFilteredPicture, this.#J = t.diagnostic?.onPresentedFrame, t.presenter !== void 0) {
      if (t.diagnostic?.onQueuedFrame !== void 0 || t.diagnostic?.onQueuedMeta !== void 0 || t.queuedFrameSink !== void 0)
        throw new TypeError(
          "presenter cannot be combined with diagnostic frame transport"
        );
      if (typeof VideoFrame > "u")
        throw new TypeError("presenter requires VideoFrame");
    }
    if (this.#X = t.presenter ?? null, this.#M = t.presenter ? (s, n) => t.presenter(s, {
      mediaTimestampUs: n.mediaTimestampUs,
      durationUs: n.durationUs
    }) : t.diagnostic?.onQueuedFrame, this.#ce = t.diagnostic?.onQueuedMeta, this.#Ce = t.queuedFrameSink ?? null, this.#C = t.diagnostic?.onPresentationQueue, this.#H = (this.#M !== void 0 || this.#ce !== void 0) && (t.presenter !== void 0 || t.diagnostic?.bypassDisplayQueue === !0), this.#K = t.presenter !== void 0 || t.diagnostic?.captureQueuedFrameFullSize === !0, this.#K && this.#M === void 0 && this.#ce === void 0)
      throw new TypeError(
        "captureQueuedFrameFullSize requires onQueuedFrame or onQueuedMeta"
      );
    if (this.#K && !this.#H)
      throw new TypeError(
        "captureQueuedFrameFullSize requires bypassDisplayQueue"
      );
    this.#$ = this.#Se || this.#J || this.#M || this.#C ? new Fe(
      this.#Se,
      this.#J !== void 0 || this.#M !== void 0 || this.#C !== void 0
    ) : null, this.#n = i, this.#R = i ? "main" : t.rendering ?? "auto", this.#Je = t.workerUrl ?? he, this.#s = this.#R === "main" ? "main" : "idle", this.#t = i ? i.canvas : document.createElement("canvas"), this.#r = i?.canvas ?? (this.#R === "main" ? this.#t : document.createElement("canvas")), this.#Pe = e, i || (this.#t.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const A = this.#r.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!A) throw new Error("this browser has no WebGL2");
    this.#i = A, this.#v = X(A, ue);
    const r = this.#v;
    this.#o = Object.fromEntries(
      Object.entries(ce).map(([s, n]) => [
        s,
        A.getUniformLocation(r, n)
      ])
    ), this.#b = X(A, De), this.#B = A.getUniformLocation(this.#b, "uField"), this.#U = A.getUniformLocation(this.#b, "uFlip"), this.#Ht(), this.#p && this.#xt(), this.#r.addEventListener(
      "webglcontextlost",
      this.#Wt
    ), this.#Ge = i ? null : new ResizeObserver(() => this.#Ne()), e.addEventListener("emptied", this.#It), e.addEventListener("resize", this.#_t), e.addEventListener("pause", this.#L), e.addEventListener("ended", this.#L), e.addEventListener("seeking", this.#Gt), e.addEventListener("seeked", this.#L), e.addEventListener("ratechange", this.#L);
  }
  get running() {
    return this.#f && (this.#l?.interlaced ?? !0);
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
      presenterFailures: this.#le
    };
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#t;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #Ue() {
    return this.#l?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #wt() {
    return {
      doubleRate: this.#D,
      autoFilm: this.#p,
      filmCombThreshold: this.#Z,
      spatialCheck: this.#We,
      diagnostic: this.#Se !== void 0,
      capturePresentedFrames: this.#J !== void 0,
      captureQueuedFrames: this.#M !== void 0,
      captureQueuedFrameFullSize: this.#K,
      capturePresentationQueue: this.#C !== void 0,
      bypassDisplayQueue: this.#H,
      captureQueuedMeta: this.#ce !== void 0
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#Re;
  }
  set enabled(e) {
    this.#Re = e, this.#At(), this.#a?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#l?.interlaced !== e?.interlaced, i = t || this.#l?.topFieldFirst !== e?.topFieldFirst;
    this.#l = e, this.#a?.postMessage({ type: "scan", scan: e }), i && (this.#c = 0, this.#g(), this.#E(), t && (this.#h = 0), this.#d = null, this.#F(!1)), this.#At(), i && ((e?.interlaced ?? !0) && (this.#n || this.#s === "main") ? this.#ie() : this.#ht());
  }
  get scan() {
    return this.#l;
  }
  set videoTimeline(e) {
    this.#q = e, this.#a?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#l = null), this.#At();
  }
  get videoTimeline() {
    return this.#q;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#Y ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#D;
  }
  set doubleRate(e) {
    e !== this.#D && (this.#D = e, this.#st(), this.#A.length = 0, this.#E(), e ? (this.#u > 0 && this.#dt(), (this.#l?.interlaced ?? !0) && (this.#n || this.#s === "main") && this.#ie()) : this.#p || (this.#d = null, this.#F(!1), this.#se()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#p;
  }
  set autoFilm(e) {
    e !== this.#p && (this.#p = e, this.#st(), this.#g(), this.#E(), e ? (this.#xt(), this.#u > 0 && (this.#Ut(), this.#dt()), (this.#l?.interlaced ?? !0) && (this.#n || this.#s === "main") && this.#ie()) : (this.#ft(), this.#D || (this.#d = null, this.#F(!1), this.#se())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#Z;
  }
  set filmCombThreshold(e) {
    const t = se(e);
    t !== this.#Z && (this.#Z = t, this.#st(), this.#p && this.#g());
  }
  /** 診断 hook の現在世代。未指定時は 0。 */
  get diagnosticGeneration() {
    return this.#$?.generation ?? 0;
  }
  /**
   * YADIF/film の1出力を診断 sink へ通知する。main 側の描画エンジンと
   * Worker 側の描画エンジン（externalHost 付きは workerState が "main"）が
   * 同じここを通る。progressive/raw の表示経路と capture() の再描画
   * (`countOutput === false`) からは呼ばない。
   */
  #Et(e, t, i) {
    const A = this.#$;
    return !A || this.#s !== "main" || !Number.isFinite(t) ? null : A.emit(
      e,
      xe(t),
      i,
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
  #tt(e, t) {
    const i = { timestamp: e };
    Number.isFinite(t) && t > 0 && (i.duration = Math.max(1, Math.round(t * 1e3)));
    const A = this.#e.videoWidth, r = this.#e.videoHeight;
    return A > 0 && r > 0 && (i.displayWidth = A, i.displayHeight = r), i;
  }
  /**
   * 描画済みcanvasを同じ描画タスク内でVideoFrameへ取り込み、所有権を
   * callbackへ移す。表示点より前のproducer通知やcapture()再描画では呼ばない。
   */
  #it(e, t) {
    const i = this.#J;
    if (!i || !e || typeof VideoFrame > "u") return;
    const A = this.#tt(e.mediaTimestampUs, t), r = A.duration ?? null;
    let s;
    try {
      s = new VideoFrame(this.#r, A);
    } catch {
      return;
    }
    try {
      i(s, {
        ...e,
        presentationTimeMs: performance.now(),
        durationUs: r
      });
    } catch {
      s.close();
    }
  }
  /** Draw a processed texture into the renderer's existing output canvas. */
  #gt(e, t = !1) {
    const i = this.#i;
    i.bindFramebuffer(i.FRAMEBUFFER, null), i.useProgram(this.#b), i.activeTexture(i.TEXTURE0), i.bindTexture(i.TEXTURE_2D, e), i.uniform1i(this.#B, 0), i.uniform1i(this.#U, t ? 1 : 0), i.viewport(0, 0, this.#u, this.#m), i.drawArrays(i.TRIANGLES, 0, 3);
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
  #vt(e, t, i) {
    const A = this.#M;
    if (!A || !t || typeof VideoFrame > "u") {
      this.#X && (this.#le += 1);
      return;
    }
    this.#Pt();
    const r = performance.now();
    if (this.#K) {
      try {
        this.#gt(e);
      } catch {
        this.#X && (this.#le += 1);
        return;
      }
      const u = this.#tt(t.mediaTimestampUs, i), l = u.duration ?? null;
      let h;
      try {
        h = new VideoFrame(this.#r, u);
      } catch {
        this.#X && (this.#le += 1);
        return;
      }
      try {
        A(h, {
          ...t,
          queuedAtMs: r,
          durationUs: l,
          captureWidth: this.#u,
          captureHeight: this.#m
        });
      } catch {
        this.#X && (this.#le += 1), h.close();
      }
      return;
    }
    const s = this.#ue;
    if (!s) return;
    const n = this.#i;
    try {
      n.bindFramebuffer(n.FRAMEBUFFER, s.framebuffer), n.useProgram(this.#b), n.activeTexture(n.TEXTURE0), n.bindTexture(n.TEXTURE_2D, e), n.uniform1i(this.#B, 0), n.uniform1i(this.#U, 0), n.viewport(0, 0, R, x), n.drawArrays(n.TRIANGLES, 0, 3), n.readPixels(
        0,
        0,
        R,
        x,
        n.RGBA,
        n.UNSIGNED_BYTE,
        s.pixels
      );
      const u = R * 4;
      for (let h = 0; h < x; h++) {
        const d = (x - 1 - h) * u;
        s.flipped.set(
          s.pixels.subarray(d, d + u),
          h * u
        );
      }
      const l = s.context.createImageData(
        R,
        x
      );
      l.data.set(s.flipped), s.context.putImageData(l, 0, 0);
    } catch {
      n.bindFramebuffer(n.FRAMEBUFFER, null), n.viewport(0, 0, this.#u, this.#m);
      return;
    }
    n.bindFramebuffer(n.FRAMEBUFFER, null), n.viewport(0, 0, this.#u, this.#m);
    const a = this.#tt(t.mediaTimestampUs, i), f = a.duration ?? null;
    let o;
    try {
      o = new VideoFrame(s.canvas, a);
    } catch {
      return;
    }
    try {
      A(o, {
        ...t,
        queuedAtMs: r,
        durationUs: f,
        captureWidth: R,
        captureHeight: x
      });
    } catch {
      o.close();
    }
  }
  /** Allocate the fixed diagnostic copy only when the pre-queue hook is used. */
  #Ht() {
    if (!this.#M || this.#K || this.#ue)
      return;
    let e = null;
    if (typeof OffscreenCanvas < "u")
      e = new OffscreenCanvas(
        R,
        x
      );
    else if (typeof document < "u") {
      const n = document.createElement("canvas");
      n.width = R, n.height = x, e = n;
    }
    if (!e) return;
    const t = e.getContext("2d", {
      willReadFrequently: !0
    });
    if (!t) return;
    const i = this.#i, A = i.createTexture();
    if (!A) return;
    i.bindTexture(i.TEXTURE_2D, A), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MIN_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MAG_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_S, i.CLAMP_TO_EDGE), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_T, i.CLAMP_TO_EDGE), i.texImage2D(
      i.TEXTURE_2D,
      0,
      i.RGBA,
      R,
      x,
      0,
      i.RGBA,
      i.UNSIGNED_BYTE,
      null
    );
    const r = i.createFramebuffer();
    if (!r) {
      i.deleteTexture(A);
      return;
    }
    i.bindFramebuffer(i.FRAMEBUFFER, r), i.framebufferTexture2D(
      i.FRAMEBUFFER,
      i.COLOR_ATTACHMENT0,
      i.TEXTURE_2D,
      A,
      0
    );
    const s = i.checkFramebufferStatus(i.FRAMEBUFFER) === i.FRAMEBUFFER_COMPLETE;
    if (i.bindFramebuffer(i.FRAMEBUFFER, null), !s) {
      i.deleteFramebuffer(r), i.deleteTexture(A);
      return;
    }
    this.#ue = {
      texture: A,
      framebuffer: r,
      canvas: e,
      context: t,
      pixels: new Uint8Array(
        R * x * 4
      ),
      flipped: new Uint8ClampedArray(
        R * x * 4
      )
    };
  }
  #zt() {
    const e = this.#ue;
    e && (this.#i.deleteFramebuffer(e.framebuffer), this.#i.deleteTexture(e.texture), this.#ue = null);
  }
  /** 古い世代の診断画素を捨てる境界で世代を進める。 */
  #E() {
    this.#$?.invalidate();
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #st() {
    this.#a?.postMessage({
      type: "settings",
      options: this.#wt()
    });
  }
  #At() {
    this.#Re && (this.#q.length > 0 || (this.#l?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #Qt() {
    return this.#n || this.#R === "main" ? !1 : this.#s === "starting" || this.#s === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Je !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#bt(), !0) : this.#R === "auto" ? (this.#_e(), !1) : (this.#s = "failed", this.#f = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #bt() {
    this.#P(), this.#a?.terminate(), this.#a = null, this.#de = !1, this.#Le = !1;
    let e = this.#t;
    if (this.#$e) {
      e = document.createElement("canvas"), e.className = this.#t.className;
      const s = this.#t.getAttribute("style");
      s === null ? e.removeAttribute("style") : e.setAttribute("style", s), e.style.visibility = "hidden", this.#t.parentElement && this.#t.replaceWith(e), this.#t = e;
    }
    const t = ++this.#Ke;
    this.#je = !1, this.#Ve = !1, this.#E(), this.#s = "starting";
    let i, A;
    try {
      A = e.transferControlToOffscreen(), this.#$e = !0, i = new Worker(this.#Je, { type: "module" });
    } catch (s) {
      this.#ge(
        s instanceof Error ? s.message : String(s)
      );
      return;
    }
    this.#a = i, i.onmessage = (s) => {
      t === this.#Ke && !this.#ke ? this.#Yt(s.data) : (s.data.type === "presented" || s.data.type === "queued") && s.data.frame.close();
    }, i.onerror = (s) => {
      t === this.#Ke && (s.preventDefault(), this.#ge(s.message || "the deinterlacer worker failed"));
    };
    const r = [A];
    this.#Ce && !this.#qe && (r.push(this.#Ce), this.#qe = !0), i.postMessage(
      {
        type: "initialize",
        canvas: A,
        options: this.#wt(),
        queuedFrameSink: this.#qe ? this.#Ce : null,
        scan: this.#l,
        videoTimeline: this.#q,
        enabled: this.#f,
        video: this.#rt()
      },
      r
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #Yt(e) {
    switch (e.type) {
      case "ready":
        this.#s = "active", this.#f && (this.#ve(), this.#ot());
        break;
      case "failed":
        this.#ge(e.message);
        break;
      case "consumed": {
        this.#de = !1, this.#Le = !0;
        const t = this.#ee;
        this.#ee = null, t && this.#yt(t);
        break;
      }
      case "visibility":
        this.#t.style.visibility = e.visible ? "visible" : "hidden";
        break;
      case "presenterOwnsDisplay":
        this.#je = e.owns;
        break;
      case "diagnostic": {
        if (this.#s !== "active") break;
        this.#$?.deliver(e.meta);
        break;
      }
      case "queuedMeta": {
        if (this.#s !== "active") break;
        try {
          this.#ce?.(e.meta);
        } catch {
        }
        break;
      }
      case "presented": {
        if (this.#s !== "active") {
          e.frame.close();
          break;
        }
        const t = this.#J;
        if (!t) {
          e.frame.close();
          break;
        }
        try {
          t(e.frame, e.meta);
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
        const t = this.#M;
        if (!t) {
          e.frame.close();
          break;
        }
        this.#Pt(), this.#ct();
        try {
          t(e.frame, e.meta);
        } catch {
          e.frame.close();
        }
        break;
      }
      case "presentationQueue":
        this.#s === "active" && this.#C?.(e.meta);
        break;
      case "stats": {
        const t = {
          ...e.stats,
          dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0
        };
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#Ze?.(t);
        break;
      }
      case "capture": {
        const t = this.#me.get(e.id);
        if (this.#me.delete(e.id), !t) {
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
  #ge(e) {
    if (this.#s === "starting" && this.#R === "auto" && !this.#fe) {
      this.#_e();
      return;
    }
    if (this.#Tt(e), !this.#fe) {
      this.#fe = !0, this.#bt();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#s = "failed", this.#a?.terminate(), this.#a = null, this.#P(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #_e() {
    const e = this.#r;
    e.className = this.#t.className;
    const t = this.#t.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#t.parentElement && this.#t.replaceWith(e), this.#t = e, this.#$e = !1, this.#a?.terminate(), this.#a = null, this.#s = "main", this.#E(), this.#P(), this.#f && (this.#ve(), this.#ot(), (this.#l?.interlaced ?? !0) && this.#ie());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #P() {
    this.#ee?.frame.close(), this.#ee = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #Tt(e) {
    for (const t of this.#me.values())
      t.reject(new Error(e));
    this.#me.clear();
  }
  start() {
    if (!(this.#f || this.#ke || this.#x)) {
      if (this.#f = !0, this.#Nt(), this.#g(), this.#Me = performance.now(), this.#Ye = this.#Me, this.#Fe = Number.NaN, this.#V = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#ai(), this.#ot(), this.#Qt()) {
        this.#a?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#s === "active" && this.#ve();
        return;
      }
      this.#ve(), (this.#l?.interlaced ?? !0) && this.#ie();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#f && (this.#f = !1, this.#j !== null && this.#e.cancelVideoFrameCallback(this.#j), this.#j = null, this.#ei(), this.#ht(), this.#c = 0, this.#d = null, this.#F(!1), this.#E(), this.#P(), this.#a?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#ke) {
      this.#ke = !0, this.#Re = !1, this.stop(), this.#a?.postMessage({ type: "destroy" }), this.#a?.terminate(), this.#a = null, this.#E(), this.#$?.destroy(), this.#P(), this.#Tt("the deinterlacer was destroyed"), this.#r.removeEventListener(
        "webglcontextlost",
        this.#Wt
      ), this.#e.removeEventListener("emptied", this.#It), this.#e.removeEventListener("resize", this.#_t), this.#e.removeEventListener("pause", this.#L), this.#e.removeEventListener("ended", this.#L), this.#e.removeEventListener("seeking", this.#Gt), this.#e.removeEventListener("seeked", this.#L), this.#e.removeEventListener("ratechange", this.#L), this.#hi();
      for (const e of this.#y) this.#i.deleteTexture(e);
      this.#y = [], this.#zt(), this.#se(), this.#ft(), this.#i.deleteProgram(this.#v), this.#i.deleteProgram(this.#b), this.#_ && this.#i.deleteProgram(this.#_), this.#I && this.#i.deleteProgram(this.#I), this.#Ae && this.#i.deleteProgram(this.#Ae), this.#i.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#s === "active" && this.#t.style.visibility === "visible" && this.#a) {
      const A = ++this.#Xt, r = new Promise((s, n) => {
        this.#me.set(A, { resolve: s, reject: n });
      });
      return this.#a.postMessage({
        type: "capture",
        id: A,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), r;
    }
    if (this.#s === "starting" || this.#s === "failed")
      return createImageBitmap(this.#e);
    const e = this.#d;
    if (this.#n && (!this.#f || this.#x || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#f || this.#x || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#ut(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#Te(e.flush, e.second, null, !1) : this.#nt(null, !1);
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
  #ve() {
    this.#n || !this.#f || this.#j !== null || (this.#j = this.#e.requestVideoFrameCallback(this.#jt));
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #rt() {
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
  #Zt(e, t) {
    let i;
    try {
      i = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (r) {
      const s = r instanceof Error ? r.message : String(r);
      this.#R === "auto" && !this.#Le && !this.#fe ? (this.#_e(), this.#Ie(e, t)) : this.#ge(s);
      return;
    }
    const A = {
      id: ++this.#Ot,
      frame: i,
      now: e,
      metadata: t,
      video: this.#rt()
    };
    if (this.#de) {
      this.#ee?.frame.close(), this.#ee = A;
      return;
    }
    this.#yt(A);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #yt(e) {
    const t = this.#a;
    if (!t || this.#s !== "active") {
      e.frame.close();
      return;
    }
    this.#de = !0;
    const i = { type: "frame", ...e };
    try {
      t.postMessage(i, [e.frame]);
    } catch (A) {
      this.#de = !1, e.frame.close();
      const r = A instanceof Error ? A.message : String(A);
      this.#R === "auto" && !this.#Le && !this.#fe ? (this.#_e(), this.#Ie(e.now, e.metadata)) : this.#ge(r);
    }
  }
  #jt = (e, t) => {
    this.#j = null, !(!this.#f || this.#x) && (this.#Me = e, this.#V = Math.max(
      this.#V,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#Dt(e, t), this.#ve());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #Dt(e, t) {
    if (this.#Fe = t.mediaTime, this.#s === "active") {
      this.#Zt(e, t);
      return;
    }
    this.#s !== "starting" && this.#Ie(e, t);
  }
  /** @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。 */
  ingestExternalFrame(e, t, i) {
    this.#Pe = i;
    try {
      this.#Ie(e, t);
    } finally {
      this.#Pe = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #Ie(e, t) {
    if (this.#Vt(t.mediaTime), t.width > 0 && t.height > 0) {
      let i = !1;
      if (!this.#oe && this.#e.seeking) {
        const h = this.#e.buffered, d = this.#h >= q ? this.#h / 1e3 : J / 1e3;
        for (let m = 0; m < h.length; m++)
          if (t.mediaTime >= h.start(m) && t.mediaTime < h.end(m) && Math.abs(t.mediaTime - this.#e.currentTime) <= d) {
            i = !0;
            break;
          }
      }
      if (i && (this.#oe = !0), (this.#u === 0 || this.#m === 0) && this.#Bt(t.width, t.height), this.#l && !this.#l.interlaced) {
        this.#si();
        return;
      }
      const A = t.mediaTime - this.#he, r = i || A < 0 || A > we;
      r && (this.#c = 0, this.#h = 0, this.#k.discontinuities++, this.#E(), this.#A.length = 0, this.#g());
      const s = this.#p && this.#z !== 0 && t.presentedFrames - this.#z > 1;
      if (this.#ri(t.presentedFrames, r), !r && s && (this.#c = 0, this.#g()), this.#c > 0 && t.mediaTime === this.#he)
        return;
      !r && A > 0 && this.#qt(A), this.#he = t.mediaTime;
      const n = performance.now();
      n - this.#et > ie && (this.#Be = n, this.#Q = 0, this.#pe = 0, this.#we = 0, this.#Ee = 0, this.#te = 0, this.#O = 0), this.#et = n;
      const a = performance.now();
      this.#Lt();
      const f = this.#S, o = this.#p && this.#c === T && this.#Jt();
      if (f !== this.#S && (this.#A.length = 0), !(o && this.#be())) if (this.#p && !this.#Xe && this.#S === "film")
        if (this.#be()) {
          const h = this.#h * 5 / 4;
          this.#Mt(1);
          const d = this.#A.at(-1), m = d == null ? e + h : d.at + d.duration;
          this.#Kt(m, h, t.mediaTime);
        } else
          this.#nt(null, !0, t.mediaTime);
      else if (this.#D && this.#be()) {
        const h = this.#h / 2;
        this.#Mt(2);
        const d = this.#A.at(-1), m = d == null ? e + h * 2 : d.at + d.duration;
        this.#Ft(!1, m, h, t.mediaTime), this.#Ft(
          !0,
          m + h,
          h,
          t.mediaTime + h / 1e3
        );
      } else
        this.#k.late += this.#A.length, this.#A.length = 0, this.#Te(!1, !1, null, !0, t.mediaTime);
      this.#te = Math.max(
        this.#te,
        this.#A.length
      ), this.#pe += performance.now() - a, this.#Q++, this.#ni(n);
    }
  }
  #Vt(e) {
    let t;
    for (let r = this.#q.length - 1; r >= 0; r--) {
      const s = this.#q[r];
      if (s.start <= e + 1e-6) {
        t = s;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#u || t.codedSize.height !== this.#m) && this.#Bt(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#l?.interlaced === i.interlaced && this.#l.topFieldFirst === i.topFieldFirst)
      return;
    const A = this.#l?.interlaced;
    this.#l = i, this.#c = 0, this.#A.length = 0, this.#g(), this.#E(), A !== i.interlaced && (this.#h = 0), i.interlaced && (this.#n || this.#s === "main") ? this.#ie() : this.#ht();
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #be() {
    return (this.#D || this.#p) && this.#h > 0 && this.#T.length === L;
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
  #qt(e) {
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#h > 0 ? Math.max(1, Math.round(t / this.#h)) : 1, A = t / i;
    A < q || A > J || (this.#h = this.#h > 0 ? this.#h + (A - this.#h) * Ee : A);
  }
  /** Build the optional film passes only for callers that enable them. */
  #xt() {
    if (this.#_ && this.#I && this.#Ae) return;
    const e = this.#i, t = X(e, fe), i = X(e, de), A = X(e, me);
    this.#_ = t, this.#ye = Object.fromEntries(
      Object.entries(V).filter(([r]) => r !== "match" && r !== "topFieldFirst").map(([r, s]) => [r, e.getUniformLocation(t, s)])
    ), this.#I = i, this.#De = Object.fromEntries(
      Object.entries(V).map(([r, s]) => [
        r,
        e.getUniformLocation(i, s)
      ])
    ), this.#Ae = A, this.#pt = Object.fromEntries(
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
  #Jt() {
    const e = this.#N, t = this.#_, i = this.#ye, A = this.#Ae, r = this.#pt;
    if (!e || !t || !i || !A || !r)
      return !1;
    const s = this.#i, n = this.#w, a = (this.#w + T - 1) % T, f = (this.#w + 1) % T, o = this.#Ue;
    s.bindFramebuffer(s.FRAMEBUFFER, e.framebuffer), s.useProgram(t);
    for (const [w, v] of [f, a, n].entries())
      s.activeTexture(s.TEXTURE0 + w), s.bindTexture(s.TEXTURE_2D, this.#y[v] ?? null);
    s.uniform1i(i.prev, 0), s.uniform1i(i.cur, 1), s.uniform1i(i.next, 2), s.uniform2i(i.size, this.#u, this.#m), s.viewport(0, 0, F, M), s.drawArrays(s.TRIANGLES, 0, 3), s.readPixels(
      0,
      0,
      F,
      M,
      s.RGBA,
      s.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: u, currentLuma: l, nextLuma: h } = e;
    for (let w = 0; w < u.length; w++) {
      const v = w * 4;
      u[w] = e.pixels[v] ?? 0, l[w] = e.pixels[v + 1] ?? 0, h[w] = e.pixels[v + 2] ?? 0;
    }
    const d = this.#He.fieldMatch(
      u,
      l,
      h,
      o,
      this.#Z
    );
    s.useProgram(A), s.uniform1i(r.prev, 0), s.uniform1i(r.cur, 1), s.uniform1i(r.next, 2), s.uniform2i(r.size, this.#u, this.#m), s.uniform1i(r.topFieldFirst, o ? 1 : 0), s.uniform1i(
      r.match,
      d.match === "p" ? 0 : d.match === "c" ? 1 : 2
    ), s.drawArrays(s.TRIANGLES, 0, 3), s.readPixels(
      0,
      0,
      F,
      M,
      s.RGBA,
      s.UNSIGNED_BYTE,
      e.pixels
    );
    const m = this.#He.decimate(e.pixels);
    this.#ae = d.match, this.#Oe = d.combScore, this.#Xe = d.isCombed, this.#ze = m.lowestCycleDifference, this.#Qe = m.runnerUpCycleDifference;
    const E = m.dropIndex !== null && !d.isCombed;
    return (E ? "film" : "video") !== this.#S && (this.#S = E ? "film" : "video"), m.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Kt(e, t, i) {
    const A = this.#at();
    if (A === null) return;
    const r = this.#T[A];
    if (!r) return;
    this.#re = A;
    const s = this.#nt(
      r.framebuffer,
      !0,
      i
    );
    this.#vt(r.texture, s, t), this.#H || this.#A.push({
      slot: A,
      at: e,
      enqueuedAtMs: this.#C ? performance.now() : null,
      duration: t,
      diagnosticMeta: s
    });
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #nt(e, t = !0, i = Number.NaN) {
    const A = this.#I, r = this.#De;
    if (!A || !r) return null;
    const s = this.#i, n = this.#w, a = (this.#w + T - 1) % T, f = (this.#w + 1) % T, o = this.#Ue;
    s.bindFramebuffer(s.FRAMEBUFFER, e), s.useProgram(A);
    for (const [l, h] of [f, a, n].entries())
      s.activeTexture(s.TEXTURE0 + l), s.bindTexture(s.TEXTURE_2D, this.#y[h] ?? null);
    s.uniform1i(r.prev, 0), s.uniform1i(r.cur, 1), s.uniform1i(r.next, 2), s.uniform2i(r.size, this.#u, this.#m), s.uniform1i(r.topFieldFirst, o ? 1 : 0), s.uniform1i(
      r.match,
      this.#ae === "p" ? 0 : this.#ae === "c" ? 1 : 2
    ), s.viewport(0, 0, this.#u, this.#m), s.drawArrays(s.TRIANGLES, 0, 3);
    const u = t ? this.#Et("film", i, !1) : null;
    return e === null && (this.#d = { kind: "film" }, this.#F(!0), t && (this.#O++, this.#it(u, this.#h))), u;
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #Ft(e, t, i, A) {
    const r = this.#at();
    if (r === null) return;
    const s = this.#T[r];
    if (!s) return;
    this.#re = r;
    const n = this.#Te(
      !1,
      e,
      s.framebuffer,
      !0,
      A
    );
    this.#vt(s.texture, n, i), this.#H || this.#A.push({
      slot: r,
      at: t,
      enqueuedAtMs: this.#C ? performance.now() : null,
      duration: i,
      diagnosticMeta: n
    });
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #Mt(e) {
    const t = Math.max(
      0,
      this.#A.length + e - oe
    );
    let i = 0, A = 0;
    for (; A < t; ) {
      const r = this.#A.shift();
      if (!r) break;
      i += r.duration, A++;
    }
    for (const r of this.#A) r.at -= i;
    this.#k.late += A;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #at() {
    const e = this.#d?.kind === "texture" ? this.#d.texture : null, t = new Set(this.#A.map(({ slot: i }) => i));
    for (let i = 1; i <= L; i++) {
      const A = (this.#re + i) % L, r = this.#T[A];
      if (r && r.texture !== e && !t.has(A))
        return A;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #ie() {
    this.#G === null && (!this.#f || this.#x || (this.#xe = 0, this.#G = this.#kt(this.#Rt)));
  }
  #ht() {
    this.#G !== null && this.#$t(this.#G), this.#G = null, this.#A.length = 0;
  }
  #Rt = (e) => {
    if (this.#G = null, !(!this.#f || this.#x)) {
      if (this.#xe > 0) {
        const t = e - this.#xe;
        t >= 1 && t <= J && (this.#ne = t < this.#ne ? t : this.#ne + (t - this.#ne) * ve);
      }
      this.#xe = e, this.#s === "main" && this.#ii(e), this.#G = this.#kt(this.#Rt);
    }
  };
  /** ページと Worker のそれぞれが所有する requestAnimationFrame() へ表示ループを委ねる。 */
  #kt(e) {
    return this.#n ? this.#n.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #$t(e) {
    this.#n ? this.#n.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #ot() {
    this.#n || this.#W !== null || !this.#f || this.#x || (this.#W = requestAnimationFrame(this.#St));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #ei() {
    this.#W !== null && cancelAnimationFrame(this.#W), this.#W = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #St = (e) => {
    this.#W = null, !(!this.#f || this.#x) && (this.#ti(e), this.#W = requestAnimationFrame(this.#St));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #ti(e) {
    if (this.#n || e - this.#Me < be || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, A = this.#h >= q ? this.#h : Te, r = i > this.#V, s = t !== this.#Fe && e - this.#Ye >= A * 0.75;
    !r && !s || (this.#V = Math.max(
      this.#V,
      i
    ), this.#Ye = e, this.#Dt(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#z + 1, i),
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
  #ii(e) {
    const t = e + this.#ne * 1.5, i = this.#A.length;
    let A = 0;
    const r = [];
    for (; this.#A[1] && this.#A[1].at <= t; ) {
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
    if (this.#C?.({
      atMs: e,
      deadlineMs: t,
      queueLengthBefore: i,
      retired: A,
      queueLengthAfter: this.#A.length,
      selectedFrameId: s?.diagnosticMeta?.frameId ?? null,
      selectedAtMs: s?.at ?? null,
      selectedEnqueuedAtMs: s?.enqueuedAtMs ?? null,
      retiredFields: r
    }), !s || s.at > t)
      return;
    this.#A.shift();
    const n = performance.now();
    this.#Ct(s.slot, s.diagnosticMeta, s.duration), this.#Ee += performance.now() - n, this.#we++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #Ct(e, t = null, i = 0) {
    const A = this.#T[e];
    A && this.#ut(A.texture, !1, !0, t, i);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #si() {
    this.#Lt();
    const e = this.#y[this.#w];
    e && this.#ut(e, !0), this.#c = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #F(e) {
    const t = this.#Ai ? !1 : e;
    if (this.#n) {
      this.#n.onVisibility(t), this.#ct();
      return;
    }
    this.#t.style.visibility = t ? "visible" : "hidden", this.#ct();
  }
  /**
   * presenter に表示を任せている間か。presenter へ frame が渡るのは先読み queue を
   * 使う経路だけなので、queue が動いている間だけ任せる。動いていない間は内蔵 canvas が
   * 実表示であり、隠すと何も見えなくなる。scan 未確定の間は queue も動かないため、
   * ここは false 側に倒れる。Worker 内では presenter callback が渡らないため、
   * presenter 指定時に必ず立つ bypassDisplayQueue を併せて見る。
   */
  get #Ai() {
    return this.#lt();
  }
  /** presenter が現在の映像の表示を所有しているか。Worker では通知値をそのまま返す。 */
  get presenterOwnsDisplay() {
    return this.#a !== null ? this.#je : this.#lt();
  }
  #lt() {
    return (this.#X !== null || this.#H) && this.#l?.interlaced !== !1 && this.#be();
  }
  /** 表示所有の変化をページ側へ通知する。変化が無ければ何もしない。 */
  #ct() {
    const e = this.#lt();
    e !== this.#Ve && (this.#Ve = e, this.#n?.onPresenterOwnsDisplay?.(e));
  }
  /**
   * presenter へ 1 枚渡した時点で内蔵 canvas を隠す。pause/seek の flush が canvas を
   * 見せたままでも、再生が再開して queue が presenter を供給し始めたら必ず隠す
   * (P1-1)。presenter が表示を所有しない構成では何もしない。
   */
  #Pt() {
    if (!(this.#X === null && !this.#H)) {
      if (this.#n) {
        this.#n.onVisibility(!1);
        return;
      }
      this.#t.style.visibility = "hidden";
    }
  }
  #ut(e, t = !1, i = !0, A = null, r = 0) {
    this.#gt(e, t), this.#d = { kind: "texture", texture: e, flip: t }, this.#F(!0), i && (this.#O++, this.#it(A, r));
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
  #ri(e, t) {
    this.#z !== 0 && !t && (this.#k.missed += Math.max(0, e - this.#z - 1)), this.#z = e;
  }
  #ni(e) {
    const t = e - this.#Be;
    if (t < ie) return;
    const i = this.#be() && (this.#D || this.#S === "film") ? this.#we : this.#Q, A = {
      ...this.#k,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#Q === 0 ? 0 : (this.#pe + this.#Ee) / this.#Q,
      maxQueuedFields: this.#te,
      mode: this.#S,
      match: this.#ae,
      combScore: this.#Oe,
      outputFps: this.#O * 1e3 / t,
      duplicateScore: this.#ze,
      duplicateRunnerUp: this.#Qe
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: A })), this.#Ze?.(A), this.#Be = e, this.#Q = 0, this.#pe = 0, this.#we = 0, this.#Ee = 0, this.#te = 0, this.#O = 0;
  }
  /** Take the newest frame into the ring. */
  #Lt() {
    const e = this.#i;
    this.#w = (this.#w + 1) % T, e.bindTexture(e.TEXTURE_2D, this.#y[this.#w] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#Pe
    ), this.#c = Math.min(this.#c + 1, T);
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
  #Te(e, t, i, A = !0, r = Number.NaN) {
    if (this.#c === 0 || this.#x) return null;
    let s = null;
    A && (this.#c === T && !e ? this.#k.filtered++ : this.#k.degraded++, s = this.#Et(
      e ? "yadif-flush" : t ? "yadif-second" : "yadif-first",
      r,
      t
    ));
    const n = this.#i, a = this.#w, f = (this.#w + T - 1) % T, o = (this.#w + 1) % T;
    let u, l, h;
    this.#c === 1 ? u = l = h = a : e ? (u = f, l = h = a) : this.#c === 2 ? (u = l = f, h = a) : (u = o, l = f, h = a), n.bindFramebuffer(n.FRAMEBUFFER, i), n.useProgram(this.#v);
    for (const [m, E] of [u, l, h].entries())
      n.activeTexture(n.TEXTURE0 + m), n.bindTexture(n.TEXTURE_2D, this.#y[E] ?? null);
    n.uniform1i(this.#o.prev, 0), n.uniform1i(this.#o.cur, 1), n.uniform1i(this.#o.next, 2), n.uniform2i(this.#o.size, this.#u, this.#m);
    const d = this.#Ue ? 0 : 1;
    return n.uniform1i(this.#o.parity, t ? 1 - d : d), n.uniform1i(this.#o.tff, this.#Ue ? 1 : 0), n.uniform1i(this.#o.spatialCheck, this.#We ? 1 : 0), n.viewport(0, 0, this.#u, this.#m), n.drawArrays(n.TRIANGLES, 0, 3), i === null && (this.#d = { kind: "yadif", flush: e, second: t }, this.#F(!0), A && (this.#O++, this.#it(s, this.#h))), s;
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
    if (!this.#Y) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const A = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), r = t * A, s = i * A;
    this.#t.style.left = `${e.offsetLeft + (e.offsetWidth - r) / 2}px`, this.#t.style.top = `${e.offsetTop + (e.offsetHeight - s) / 2}px`, this.#t.style.width = `${r}px`, this.#t.style.height = `${s}px`;
  }
  #Bt(e, t) {
    const i = this.#i;
    this.#r.width = e, this.#r.height = t, this.#u = e, this.#m = t, this.#c = 0, this.#d = null, this.#g(), this.#E(), this.#Ne();
    for (const A of this.#y) i.deleteTexture(A);
    this.#y = [];
    for (let A = 0; A < T; A++) {
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
      ), this.#y.push(r);
    }
    this.#se(), this.#ft(), this.#p && this.#Ut(), (this.#D || this.#p) && this.#dt();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Ut() {
    if (this.#N) return;
    const e = this.#i, t = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      F,
      M,
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
    this.#N = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(F * M * 4),
      previousLuma: new Uint8Array(F * M),
      currentLuma: new Uint8Array(F * M),
      nextLuma: new Uint8Array(F * M)
    };
  }
  #ft() {
    this.#N && (this.#i.deleteFramebuffer(this.#N.framebuffer), this.#i.deleteTexture(this.#N.texture), this.#N = null);
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
  #dt() {
    const e = this.#i;
    if (!(this.#T.length === L || this.#u === 0)) {
      this.#se();
      for (let t = 0; t < L; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
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
          i,
          0
        );
        const r = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
        if (e.bindFramebuffer(e.FRAMEBUFFER, null), !r) {
          e.deleteFramebuffer(A), e.deleteTexture(i), this.#se();
          return;
        }
        this.#T.push({ texture: i, framebuffer: A });
      }
      this.#re = L - 1;
    }
  }
  #se() {
    const e = this.#i, t = this.#d?.kind === "texture" ? this.#d.texture : null;
    this.#T.some((i) => i.texture === t) && (this.#d = null);
    for (const { texture: i, framebuffer: A } of this.#T)
      e.deleteFramebuffer(A), e.deleteTexture(i);
    this.#T = [], this.#A.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #ai() {
    if (this.#Y) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#t), this.#Y = t, this.#Ge?.observe(this.#e), this.#Ne();
  }
  #hi() {
    if (this.#n) return;
    const e = this.#Y;
    this.#Y = null, this.#Ge?.disconnect(), this.#t.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #_t = () => this.#Ne();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #mt(e) {
    return !this.#a || this.#s === "main" ? !1 : (this.#a.postMessage({
      type: "event",
      name: e,
      video: this.#rt()
    }), !0);
  }
  #It = () => {
    if (this.#E(), this.#Fe = Number.NaN, this.#mt("emptied")) {
      this.#P(), this.#F(!1);
      return;
    }
    this.#c = 0, this.#he = 0, this.#A.length = 0, this.#h = 0, this.#Nt(), this.#g(), this.#d = null, this.#F(!1);
  };
  #Nt() {
    this.#k = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#z = 0, this.#Be = 0, this.#et = 0, this.#Q = 0, this.#pe = 0, this.#we = 0, this.#Ee = 0, this.#te = 0, this.#O = 0, this.#g();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #g() {
    this.#A.length = 0, this.#S = "video", this.#ae = "c", this.#Oe = 0, this.#Xe = !0, this.#He.reset(), this.#ze = 1 / 0, this.#Qe = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #Gt = () => {
    if (this.#E(), this.#mt("seeking")) {
      this.#P();
      return;
    }
    this.#oe = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #L = (e) => {
    if (this.#E(), (e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#mt(e.type)) {
      this.#P();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#oe;
      if (this.#oe = !1, i) return;
      this.#c = 0, this.#g(), this.#d = null, this.#F(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#h = 0, this.#he = this.#e.currentTime), this.#A.length = 0, this.#f && this.#c > 0) {
      const i = this.#at(), A = i === null ? void 0 : this.#T[i];
      if (i !== null && A) {
        this.#re = i;
        const r = this.#Te(
          !0,
          !1,
          A.framebuffer,
          !0,
          this.#e.currentTime
        );
        this.#Ct(i, r, this.#h);
      } else
        this.#Te(!0, !1, null, !0, this.#e.currentTime);
    }
    t && (this.#c = 0, this.#g());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Wt = (e) => {
    if (e.preventDefault(), this.#n) {
      this.#n.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#s !== "active" && (this.#x = !0, this.stop());
  };
}
function X(c, e) {
  const t = c.createProgram(), i = Ae(c, c.VERTEX_SHADER, ye), A = Ae(c, c.FRAGMENT_SHADER, e);
  if (c.attachShader(t, i), c.attachShader(t, A), c.linkProgram(t), c.deleteShader(i), c.deleteShader(A), !c.getProgramParameter(t, c.LINK_STATUS)) {
    const r = c.getProgramInfoLog(t);
    throw c.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${r ?? "no reason given"}`
    );
  }
  return t;
}
function Ae(c, e, t) {
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
const re = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Me = 0.5, Re = 3e3, ne = 0.1, I = 16, ae = 'video/mp4; codecs="avc1.640029"';
let $ = null;
function ke(c = {}) {
  return $ ??= Se(c), $;
}
async function Ie(c = {}) {
  return (await ke(c)).deinterlaces;
}
function Ne() {
  $ = null;
}
async function Se(c) {
  const e = c.tolerance ?? Me, t = c.timeoutMs ?? Re, i = performance.now(), A = (n) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: n instanceof Error ? n.message : String(n)
  });
  if (typeof document > "u")
    return A(new Error("there is no document to decode in"));
  const r = document.createElement("video");
  r.muted = !0, r.defaultMuted = !0, r.playsInline = !0, r.preload = "auto";
  let s = null;
  try {
    s = Pe(r, t);
    const n = Q(z(r, "loadeddata"), t), a = r.play().then(
      () => !0,
      () => !1
    );
    if (await s.ready, await n, await Le(r, t, await a), r.videoWidth === 0 || r.videoHeight === 0)
      return A(new Error("the probe clip decoded to nothing"));
    const f = Be(r);
    return {
      deinterlaces: f < 1 - e,
      survives: f,
      tookMs: performance.now() - i
    };
  } catch (n) {
    return A(n);
  } finally {
    r.pause(), r.removeAttribute("src"), r.replaceChildren(), r.load(), s && URL.revokeObjectURL(s.url);
  }
}
const K = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Ce = typeof MediaSource > "u";
function Pe(c, e) {
  if (!K || !K.isTypeSupported(ae))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = re.indexOf(","), i = atob(re.slice(t + 1)), A = new Uint8Array(i.length);
  for (let a = 0; a < i.length; a++) A[a] = i.charCodeAt(a);
  const r = new K(), s = URL.createObjectURL(r);
  if (Ce) {
    c.disableRemotePlayback = !0;
    const a = document.createElement("source");
    a.type = "video/mp4", a.src = s, c.append(a), c.load();
  } else
    c.src = s;
  const n = (async () => {
    await Q(z(r, "sourceopen"), e);
    const a = r.addSourceBuffer(ae), f = Q(z(a, "updateend"), e);
    a.appendBuffer(A), await f, r.endOfStream();
  })();
  return { url: s, ready: n };
}
async function Le(c, e, t) {
  if (t) {
    const i = performance.now();
    for (; c.currentTime < ne && performance.now() - i < e; )
      await new Promise((A) => requestAnimationFrame(A));
    c.pause();
  } else
    c.currentTime = ne, await Q(z(c, "seeked"), e);
}
function Be(c) {
  const e = c.videoHeight, t = document.createElement("canvas");
  t.width = I, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(c, 0, 0, I, e);
  const A = i.getImageData(0, 0, I, e).data, r = (o) => {
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
  return new Promise((t, i) => {
    c.addEventListener(e, () => t(), { once: !0 }), c.addEventListener(
      "error",
      () => {
        const A = c instanceof HTMLMediaElement ? c.error : null, r = A ? ` (MediaError ${A.code}${A.message ? `: ${A.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${r}`));
      },
      { once: !0 }
    );
  });
}
function Q(c, e) {
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
pe(le);
export {
  _e as Deinterlacer,
  Fe as DiagnosticPictureGate,
  fe as FILM_ANALYSIS_FRAGMENT_SHADER,
  me as FILM_SAMPLE_FRAGMENT_SHADER,
  V as FILM_UNIFORMS,
  de as FILM_WEAVE_FRAGMENT_SHADER,
  ue as YADIF_FRAGMENT_SHADER,
  ce as YADIF_UNIFORMS,
  Ie as decoderDeinterlaces,
  Ne as forgetDecoderProbe,
  ke as probeDecoder,
  Ue as supportsDeinterlace,
  xe as toDiagnosticTimestampUs
};
//# sourceMappingURL=index.js.map
