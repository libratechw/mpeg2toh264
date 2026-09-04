const ae = "" + new URL("assets/worker-BePPooRk.js", import.meta.url).href, he = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, le = `#version 300 es
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
}, F = 288, R = 162, ce = `#version 300 es
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
  ivec2 targetSize = ivec2(${F}, ${R});
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
  ivec2 targetSize = ivec2(${F}, ${R});
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
class v {
  static CYCLE = 5;
  static COMB_THRESHOLD = 9;
  static COMBED_PIXEL_LIMIT = 80;
  static DECIMATE_BLOCK = 32;
  static DUPLICATE_PERCENT = 1.1;
  #u;
  #i;
  #e;
  #A = 0;
  #v = null;
  #n = [];
  #D = null;
  #G = 1 / 0;
  #W = 1 / 0;
  constructor(e, t) {
    this.#u = e, this.#i = t, this.#e = 255 * v.DECIMATE_BLOCK ** 2 * v.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, s, A = v.COMBED_PIXEL_LIMIT) {
    const r = s ? 1 : 0, a = { p: e, c: t, n: i };
    let n = this.#C("c", "p", r, a);
    const l = /* @__PURE__ */ new Map(), o = (p) => {
      const g = l.get(p);
      if (g !== void 0) return g;
      const E = v.#L(
        this.weave(e, t, i, p, s),
        this.#u,
        this.#i
      );
      return l.set(p, E), E;
    }, d = o(n), u = o("n");
    (u * 3 < d || u * 2 < d && d > A) && Math.abs(u - d) >= 30 && u < A && (n = "n");
    const h = o(n), m = h >= A;
    return m && (n = "c"), {
      match: n,
      combScore: h,
      isCombed: m,
      luma: this.weave(e, t, i, n, s)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#A, i = this.#D ? v.#ue(
      this.#D,
      e,
      this.#u,
      this.#i
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#n.push(i);
    const s = this.#v === t, A = s && i.maxBlockDifference < this.#e;
    s && !A && (this.#v = null);
    const r = this.#v;
    this.#D = e.slice(), this.#A++;
    let a = this.#v;
    if (this.#A === v.CYCLE) {
      let n = 0, l = null;
      for (let o = 1; o < this.#n.length; o++)
        (this.#n[o]?.maxBlockDifference ?? 1 / 0) < (this.#n[n]?.maxBlockDifference ?? 1 / 0) ? (l = n, n = o) : (l === null || (this.#n[o]?.maxBlockDifference ?? 1 / 0) < (this.#n[l]?.maxBlockDifference ?? 1 / 0)) && (l = o);
      this.#G = this.#n[n]?.maxBlockDifference ?? 1 / 0, this.#W = l === null ? 1 / 0 : this.#n[l]?.maxBlockDifference ?? 1 / 0, a = (this.#n[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#v = a, this.#n = [], this.#A = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: A,
      dropIndex: r,
      nextDropIndex: a,
      lowestCycleDifference: this.#G,
      runnerUpCycleDifference: this.#W
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, s, A) {
    if (s === "c") return t.slice();
    const r = t.slice(), a = s === "p" ? e : i, n = r.length / this.#i, l = A ? 1 : 0;
    for (let o = l; o < this.#i; o += 2)
      r.set(
        a.subarray(o * n, (o + 1) * n),
        o * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#A = 0, this.#v = null, this.#n = [], this.#D = null, this.#G = 1 / 0, this.#W = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #C(e, t, i, s) {
    const A = this.#u, r = this.#i, a = 2 - i, n = 2 - i, l = s[e], o = s[t], d = v.#ce(
      l,
      o,
      A,
      r,
      i
    );
    let u = 0, h = 0, m = 0, p = 0, g = 0, E = 0;
    for (let k = 2; k < r - 2; k += 2) {
      const D = (k - 2) / 2, x = a - 1 + D * 2, C = a + 1 + D * 2, Z = a + 3 + D * 2, X = a + D * 2, H = X + 2, U = n + D * 2, P = U + 2, $ = a + D * 2;
      for (let M = 8; M < A - 8; M++) {
        const I = (d[$ * A + M] ?? 0) | (d[($ + 2) * A + M] ?? 0);
        if (I === 0) continue;
        const ee = (s.c[x * A + M] ?? 0) + ((s.c[C * A + M] ?? 0) << 2) + (s.c[Z * A + M] ?? 0), N = Math.abs(
          3 * ((l[X * A + M] ?? 0) + (l[H * A + M] ?? 0)) - ee
        ), G = Math.abs(
          3 * ((o[U * A + M] ?? 0) + (o[P * A + M] ?? 0)) - ee
        );
        N > 23 && (I & 1) !== 0 && (u += N), G > 23 && (I & 1) !== 0 && (p += G), N > 42 && (I & 2) !== 0 && (h += N), G > 42 && (I & 2) !== 0 && (g += G), N > 42 && (I & 4) !== 0 && (m += N), G > 42 && (I & 4) !== 0 && (E += G);
      }
    }
    h < 500 && g < 500 && (m >= 500 || E >= 500) && Math.max(m, E) > 3 * Math.min(m, E) && (h = m, g = E);
    const b = Math.floor(u / 6 + 0.5), T = Math.floor(p / 6 + 0.5), w = Math.floor(h / 6 + 0.5), f = Math.floor(g / 6 + 0.5), L = Math.max(b, T) / Math.max(Math.min(b, T), 1), B = Math.max(w, f) / Math.max(Math.min(w, f), 1), S = Math.max(w, f) / Math.max(Math.max(b, T), 1);
    return (w >= 500 || f >= 500) && (w * 2 < f || f * 2 < w) || (w >= 1e3 || f >= 1e3) && (w * 3 < f * 2 || f * 3 < w * 2) || (w >= 2e3 || f >= 2e3) && (w * 5 < f * 4 || f * 5 < w * 4) || (w >= 4e3 || f >= 4e3) && B > L || S > 5e-3 && Math.max(w, f) > 150 && (w * 2 < f || f * 2 < w) ? w > f ? t : e : b > T ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #ce(e, t, i, s, A) {
    const r = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(i)
    ), a = A === 1 ? 1 : 0;
    for (let o = 0; o < r.length; o++) {
      const d = Math.min(s - 1, a + o * 2), u = r[o];
      if (u)
        for (let h = 0; h < i; h++)
          u[h] = Math.abs(
            (e[d * i + h] ?? 0) - (t[d * i + h] ?? 0)
          );
    }
    const n = new Uint8Array(i * s), l = A === 1 ? 3 : 2;
    for (let o = 1; o < r.length - 1; o++) {
      const d = l + (o - 1) * 2;
      if (d >= s) break;
      const u = r[o];
      if (u)
        for (let h = 1; h < i - 1; h++) {
          const m = u[h] ?? 0;
          if (m <= 3) continue;
          let p = 0;
          for (let f = h - 1; f <= h + 1; f++)
            p += (r[o - 1]?.[f] ?? 0) > 3 ? 1 : 0, p += (r[o]?.[f] ?? 0) > 3 ? 1 : 0, p += (r[o + 1]?.[f] ?? 0) > 3 ? 1 : 0;
          if (p <= 1) continue;
          const g = d * i + h;
          if (n[g] = 1, m <= 19) continue;
          p = 0;
          let E = !1, b = !1;
          for (let f = h - 1; f <= h + 1; f++)
            (r[o - 1]?.[f] ?? 0) > 19 && (p++, E = !0), (r[o]?.[f] ?? 0) > 19 && p++, (r[o + 1]?.[f] ?? 0) > 19 && (p++, b = !0);
          if (p <= 3) continue;
          if (E && b) {
            n[g] |= 2;
            continue;
          }
          let T = !1, w = !1;
          for (let f = Math.max(h - 4, 0); f < Math.min(h + 5, i); f++)
            o !== 1 && (r[o - 2]?.[f] ?? 0) > 19 && (T = !0), (r[o - 1]?.[f] ?? 0) > 19 && (E = !0), (r[o + 1]?.[f] ?? 0) > 19 && (b = !0), o !== r.length - 2 && (r[o + 2]?.[f] ?? 0) > 19 && (w = !0);
          E && (b || T) || b && (E || w) ? n[g] |= 2 : p > 5 && (n[g] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #L(e, t, i) {
    const s = new Uint8Array(t * i), A = (a, n) => e[Math.max(0, Math.min(i - 1, n)) * t + a] ?? 0;
    for (let a = 0; a < i; a++)
      for (let n = 0; n < t; n++) {
        const l = A(n, a), o = A(n, a === 0 ? 1 : a - 1), d = A(n, a === i - 1 ? i - 2 : a + 1), u = a < 2 ? A(n, a === 0 ? 2 : 3) : A(n, a - 2), h = a + 2 >= i ? A(n, a === i - 1 ? i - 3 : i - 4) : A(n, a + 2);
        (a === 0 ? Math.abs(l - d) > v.COMB_THRESHOLD : a === i - 1 ? Math.abs(l - o) > v.COMB_THRESHOLD : Math.abs(l - o) > v.COMB_THRESHOLD && Math.abs(l - d) > v.COMB_THRESHOLD) && Math.abs(
          4 * l - 3 * (o + d) + u + h
        ) > v.COMB_THRESHOLD * 6 && (s[a * t + n] = 255);
      }
    let r = 0;
    for (const a of [0, 8])
      for (const n of [0, 8])
        for (let l = a; l < i; l += 16)
          for (let o = n; o < t; o += 16) {
            let d = 0;
            for (let u = Math.max(1, l); u < Math.min(i - 1, l + 16); u++)
              for (let h = o; h < Math.min(t, o + 16); h++) {
                const m = u * t + h;
                s[m - t] === 255 && s[m] === 255 && s[m + t] === 255 && d++;
              }
            r = Math.max(r, d);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #ue(e, t, i, s) {
    const A = v.DECIMATE_BLOCK / 2, r = Math.ceil(i / A), a = Math.ceil(s / A), n = new Float64Array(r * a), l = e.length / (i * s);
    for (let u = 0; u < s; u++) {
      const h = Math.floor(u / A);
      for (let m = 0; m < i; m++) {
        const p = Math.floor(m / A), g = h * r + p, E = (u * i + m) * l;
        if (l === 1) {
          n[g] = (n[g] ?? 0) + Math.abs((e[E] ?? 0) - (t[E] ?? 0));
          continue;
        }
        const b = Math.round(
          (e[E] ?? 0) * 0.2126 + (e[E + 1] ?? 0) * 0.7152 + (e[E + 2] ?? 0) * 0.0722
        ), T = Math.round(
          (t[E] ?? 0) * 0.2126 + (t[E + 1] ?? 0) * 0.7152 + (t[E + 2] ?? 0) * 0.0722
        );
        if (n[g] = (n[g] ?? 0) + Math.abs(b - T), (m & 1) !== 0 || (u & 1) !== 0) continue;
        let w = 0, f = 0, L = 0, B = 0, S = 0, k = 0, D = 0;
        for (let H = u; H < Math.min(u + 2, s); H++)
          for (let U = m; U < Math.min(m + 2, i); U++) {
            const P = (H * i + U) * l;
            w += e[P] ?? 0, f += e[P + 1] ?? 0, L += e[P + 2] ?? 0, B += t[P] ?? 0, S += t[P + 1] ?? 0, k += t[P + 2] ?? 0, D++;
          }
        const x = Math.round(
          (-0.114572 * w - 0.385428 * f + 0.5 * L) / D
        ), C = Math.round(
          (-0.114572 * B - 0.385428 * S + 0.5 * k) / D
        ), Z = Math.round(
          (0.5 * w - 0.454153 * f - 0.045847 * L) / D
        ), X = Math.round(
          (0.5 * B - 0.454153 * S - 0.045847 * k) / D
        );
        n[g] = (n[g] ?? 0) + Math.abs(x - C) + Math.abs(Z - X);
      }
    }
    let o = -1;
    for (let u = 0; u < a - 1; u++)
      for (let h = 0; h < r - 1; h++)
        o = Math.max(
          o,
          (n[u * r + h] ?? 0) + (n[u * r + h + 1] ?? 0) + (n[(u + 1) * r + h] ?? 0) + (n[(u + 1) * r + h + 1] ?? 0)
        );
    let d = 0;
    for (const u of n) d += u;
    return { maxBlockDifference: o, totalDifference: d };
  }
}
let oe = null;
function de(c) {
  oe = c;
}
const me = 0.5, y = 3, q = 5, _ = q + 1, te = 1e3, j = 4, V = 200, pe = 0.25, we = 1e3 / 60, ge = 0.02, Ee = 250, ve = 1e3 / 30;
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
function Ce() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class Le extends EventTarget {
  #u;
  #i;
  #e;
  #A;
  #v;
  #n;
  /** The program that copies a filtered picture onto the canvas. */
  #D;
  #G;
  #W;
  /** The reduced pass that reads previous, current and next luma together. */
  #C = null;
  #ce = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #L = null;
  #ue = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #q = null;
  #Je = null;
  #B = null;
  #y = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #w = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #K = _ - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #f = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #t = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #P = null;
  #fe = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #I = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #H = we;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #O = null;
  #xe;
  #T;
  #d;
  #X;
  #Me;
  #F = "video";
  #$ = "c";
  #Fe = 0;
  #Re = !0;
  #Se = new v(F, R);
  #ke = 1 / 0;
  #Ce = 1 / 0;
  #_ = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #l = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #m = 0;
  #b = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #p = y - 1;
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
  #c = !1;
  #pe = !1;
  #Be = !1;
  #a = null;
  #Z = [];
  #x = !1;
  #Pe;
  #h;
  #we;
  #R;
  #Ie;
  #r = null;
  #s;
  #ie = !1;
  #_e = 0;
  #Ue = !1;
  #wt = 0;
  #Ae = !1;
  #ge = !1;
  #Q = null;
  #gt = 0;
  #se = /* @__PURE__ */ new Map();
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
      t.filmCombThreshold ?? v.COMBED_PIXEL_LIMIT
    ), this.#Me = t.spatialCheck ?? !0, this.#Pe = t.onStats, this.#h = i, this.#R = i ? "main" : t.rendering ?? "auto", this.#Ie = t.workerUrl ?? oe, this.#s = this.#R === "main" ? "main" : "idle", this.#i = i ? i.canvas : document.createElement("canvas"), this.#u = i?.canvas ?? (this.#R === "main" ? this.#i : document.createElement("canvas")), this.#we = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const s = this.#u.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!s) throw new Error("this browser has no WebGL2");
    this.#A = s, this.#v = O(s, le);
    const A = this.#v;
    this.#n = Object.fromEntries(
      Object.entries(he).map(([r, a]) => [
        r,
        s.getUniformLocation(A, a)
      ])
    ), this.#D = O(s, De), this.#G = s.getUniformLocation(this.#D, "uField"), this.#W = s.getUniformLocation(this.#D, "uFlip"), this.#d && this.#it(), this.#u.addEventListener(
      "webglcontextlost",
      this.#pt
    ), this.#xe = i ? null : new ResizeObserver(() => this.#Te()), e.addEventListener("emptied", this.#ft), e.addEventListener("resize", this.#ut), e.addEventListener("pause", this.#k), e.addEventListener("ended", this.#k), e.addEventListener("seeking", this.#mt), e.addEventListener("seeked", this.#k), e.addEventListener("ratechange", this.#k);
  }
  get running() {
    return this.#c && (this.#a?.interlaced ?? !0);
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
    this.#a = e, this.#r?.postMessage({ type: "scan", scan: e }), i && (this.#o = 0, this.#E(), t && (this.#l = 0), this.#f = null, this.#M(!1)), this.#We(), i && ((e?.interlaced ?? !0) && (this.#h || this.#s === "main") ? this.#V() : this.#ze());
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
    return this.#O ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#T;
  }
  set doubleRate(e) {
    e !== this.#T && (this.#T = e, this.#Ge(), this.#t.length = 0, e ? (this.#m > 0 && this.#je(), (this.#a?.interlaced ?? !0) && (this.#h || this.#s === "main") && this.#V()) : this.#d || (this.#f = null, this.#M(!1), this.#J()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#d;
  }
  set autoFilm(e) {
    e !== this.#d && (this.#d = e, this.#Ge(), this.#E(), e ? (this.#it(), this.#m > 0 && (this.#ct(), this.#je()), (this.#a?.interlaced ?? !0) && (this.#h || this.#s === "main") && this.#V()) : (this.#Qe(), this.#T || (this.#f = null, this.#M(!1), this.#J())));
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
    return this.#h || this.#R === "main" ? !1 : this.#s === "starting" || this.#s === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Ie !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Ke(), !0) : this.#R === "auto" ? (this.#be(), !1) : (this.#s = "failed", this.#c = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #Ke() {
    this.#S(), this.#r?.terminate(), this.#r = null, this.#Ae = !1, this.#ge = !1;
    let e = this.#i;
    if (this.#Ue) {
      e = document.createElement("canvas"), e.className = this.#i.className;
      const A = this.#i.getAttribute("style");
      A === null ? e.removeAttribute("style") : e.setAttribute("style", A), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e;
    }
    const t = ++this.#_e;
    this.#s = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#Ue = !0, i = new Worker(this.#Ie, { type: "module" });
    } catch (A) {
      this.#ae(
        A instanceof Error ? A.message : String(A)
      );
      return;
    }
    this.#r = i, i.onmessage = (A) => {
      t === this.#_e && this.#vt(A.data);
    }, i.onerror = (A) => {
      t === this.#_e && (A.preventDefault(), this.#ae(A.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#qe(),
        scan: this.#a,
        videoTimeline: this.#Z,
        enabled: this.#c,
        video: this.#He()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #vt(e) {
    switch (e.type) {
      case "ready":
        this.#s = "active", this.#c && (this.#he(), this.#Ye());
        break;
      case "failed":
        this.#ae(e.message);
        break;
      case "consumed": {
        this.#Ae = !1, this.#ge = !0;
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
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#Pe?.(t);
        break;
      }
      case "capture": {
        const t = this.#se.get(e.id);
        if (this.#se.delete(e.id), !t) {
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
    if (this.#s === "starting" && this.#R === "auto" && !this.#ie) {
      this.#be();
      return;
    }
    if (this.#$e(e), !this.#ie) {
      this.#ie = !0, this.#Ke();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#s = "failed", this.#r?.terminate(), this.#r = null, this.#S(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #be() {
    const e = this.#u;
    e.className = this.#i.className;
    const t = this.#i.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e, this.#Ue = !1, this.#r?.terminate(), this.#r = null, this.#s = "main", this.#S(), this.#c && (this.#he(), this.#Ye(), (this.#a?.interlaced ?? !0) && this.#V());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #S() {
    this.#Q?.frame.close(), this.#Q = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #$e(e) {
    for (const t of this.#se.values())
      t.reject(new Error(e));
    this.#se.clear();
  }
  start() {
    if (!(this.#c || this.#Be || this.#x)) {
      if (this.#c = !0, this.#dt(), this.#E(), this.#me = performance.now(), this.#Le = this.#me, this.#de = Number.NaN, this.#Y = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#Pt(), this.#Ye(), this.#Et()) {
        this.#r?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#s === "active" && this.#he();
        return;
      }
      this.#he(), (this.#a?.interlaced ?? !0) && this.#V();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#c && (this.#c = !1, this.#z !== null && this.#e.cancelVideoFrameCallback(this.#z), this.#z = null, this.#Rt(), this.#ze(), this.#o = 0, this.#f = null, this.#M(!1), this.#S(), this.#r?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#Be) {
      this.#Be = !0, this.#pe = !1, this.stop(), this.#r?.postMessage({ type: "destroy" }), this.#r?.terminate(), this.#r = null, this.#S(), this.#$e("the deinterlacer was destroyed"), this.#u.removeEventListener(
        "webglcontextlost",
        this.#pt
      ), this.#e.removeEventListener("emptied", this.#ft), this.#e.removeEventListener("resize", this.#ut), this.#e.removeEventListener("pause", this.#k), this.#e.removeEventListener("ended", this.#k), this.#e.removeEventListener("seeking", this.#mt), this.#e.removeEventListener("seeked", this.#k), this.#e.removeEventListener("ratechange", this.#k), this.#It();
      for (const e of this.#y) this.#A.deleteTexture(e);
      this.#y = [], this.#J(), this.#Qe(), this.#A.deleteProgram(this.#v), this.#A.deleteProgram(this.#D), this.#C && this.#A.deleteProgram(this.#C), this.#L && this.#A.deleteProgram(this.#L), this.#q && this.#A.deleteProgram(this.#q), this.#A.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#s === "active" && this.#i.style.visibility === "visible" && this.#r) {
      const s = ++this.#gt, A = new Promise((r, a) => {
        this.#se.set(s, { resolve: r, reject: a });
      });
      return this.#r.postMessage({
        type: "capture",
        id: s,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), A;
    }
    if (this.#s === "starting" || this.#s === "failed")
      return createImageBitmap(this.#e);
    const e = this.#f;
    if (this.#h && (!this.#c || this.#x || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#c || this.#x || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#Ze(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#le(e.flush, e.second, null, !1) : this.#Oe(null, !1);
    const t = this.#e.videoWidth, i = this.#e.videoHeight;
    return t > 0 && i > 0 && (t !== this.#u.width || i !== this.#u.height) ? createImageBitmap(this.#u, {
      resizeWidth: t,
      resizeHeight: i,
      resizeQuality: "high"
    }) : createImageBitmap(this.#u);
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #he() {
    this.#h || !this.#c || this.#z !== null || (this.#z = this.#e.requestVideoFrameCallback(this.#Dt));
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #He() {
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
    } catch (A) {
      const r = A instanceof Error ? A.message : String(A);
      this.#R === "auto" && !this.#ge && !this.#ie ? (this.#be(), this.#De(e, t)) : this.#ae(r);
      return;
    }
    const s = {
      id: ++this.#wt,
      frame: i,
      now: e,
      metadata: t,
      video: this.#He()
    };
    if (this.#Ae) {
      this.#Q?.frame.close(), this.#Q = s;
      return;
    }
    this.#et(s);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #et(e) {
    const t = this.#r;
    if (!t || this.#s !== "active") {
      e.frame.close();
      return;
    }
    this.#Ae = !0;
    const i = { type: "frame", ...e };
    try {
      t.postMessage(i, [e.frame]);
    } catch (s) {
      this.#Ae = !1, e.frame.close();
      const A = s instanceof Error ? s.message : String(s);
      this.#R === "auto" && !this.#ge && !this.#ie ? (this.#be(), this.#De(e.now, e.metadata)) : this.#ae(A);
    }
  }
  #Dt = (e, t) => {
    this.#z = null, !(!this.#c || this.#x) && (this.#me = e, this.#Y = Math.max(
      this.#Y,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#tt(e, t), this.#he());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #tt(e, t) {
    if (this.#de = t.mediaTime, this.#s === "active") {
      this.#bt(e, t);
      return;
    }
    this.#s !== "starting" && this.#De(e, t);
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
        const h = this.#e.buffered, m = this.#l >= j ? this.#l / 1e3 : V / 1e3;
        for (let p = 0; p < h.length; p++)
          if (t.mediaTime >= h.start(p) && t.mediaTime < h.end(p) && Math.abs(t.mediaTime - this.#e.currentTime) <= m) {
            i = !0;
            break;
          }
      }
      if (i && (this.#te = !0), (this.#m === 0 || this.#b === 0) && this.#lt(t.width, t.height), this.#a && !this.#a.interlaced) {
        this.#Ct();
        return;
      }
      const s = t.mediaTime - this.#ee, A = i || s < 0 || s > me;
      A && (this.#o = 0, this.#l = 0, this.#g.discontinuities++, this.#t.length = 0, this.#E());
      const r = this.#d && this.#U !== 0 && t.presentedFrames - this.#U > 1;
      if (this.#Lt(t.presentedFrames, A), !A && r && (this.#o = 0, this.#E()), this.#o > 0 && t.mediaTime === this.#ee)
        return;
      !A && s > 0 && this.#Tt(s), this.#ee = t.mediaTime;
      const a = performance.now();
      a - this.#Ne > te && (this.#Ee = a, this.#N = 0, this.#re = 0, this.#ne = 0, this.#oe = 0, this.#j = 0, this.#_ = 0), this.#Ne = a;
      const n = performance.now();
      this.#ht();
      const l = this.#F, o = this.#d && this.#o === y && this.#xt();
      if (l !== this.#F && (this.#t.length = 0), !(o && this.#ye())) if (this.#d && !this.#Re && this.#F === "film")
        if (this.#ye()) {
          const h = this.#l * 5 / 4, m = this.#st(1, e, h), p = this.#t.at(-1), g = m ? e : p == null ? e + h : p.at + p.duration;
          this.#Mt(g, h);
        } else
          this.#Oe(null);
      else if (this.#T && this.#ye()) {
        const h = this.#l / 2, m = this.#st(2, e, h), p = this.#t.at(-1), g = m ? e : p == null ? e + h * 2 : p.at + p.duration;
        this.#At(!1, g, h), this.#At(!0, g + h, h);
      } else
        this.#g.late += this.#t.length, this.#t.length = 0, this.#le(!1, !1, null);
      this.#j = Math.max(
        this.#j,
        this.#t.length
      ), this.#re += performance.now() - n, this.#N++, this.#Bt(a);
    }
  }
  #yt(e) {
    let t;
    for (let A = this.#Z.length - 1; A >= 0; A--) {
      const r = this.#Z[A];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#m || t.codedSize.height !== this.#b) && this.#lt(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#a?.interlaced === i.interlaced && this.#a.topFieldFirst === i.topFieldFirst)
      return;
    const s = this.#a?.interlaced;
    this.#a = i, this.#o = 0, this.#t.length = 0, this.#E(), s !== i.interlaced && (this.#l = 0), i.interlaced && (this.#h || this.#s === "main") ? this.#V() : this.#ze();
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
    return (this.#T || this.#d) && this.#l > 0 && this.#w.length === _;
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
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#l > 0 ? Math.max(1, Math.round(t / this.#l)) : 1, s = t / i;
    s < j || s > V || (this.#l = this.#l > 0 ? this.#l + (s - this.#l) * pe : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #it() {
    if (this.#C && this.#L && this.#q) return;
    const e = this.#A, t = O(e, ce), i = O(e, ue), s = O(e, fe);
    this.#C = t, this.#ce = Object.fromEntries(
      Object.entries(Q).filter(([A]) => A !== "match" && A !== "topFieldFirst").map(([A, r]) => [A, e.getUniformLocation(t, r)])
    ), this.#L = i, this.#ue = Object.fromEntries(
      Object.entries(Q).map(([A, r]) => [
        A,
        e.getUniformLocation(i, r)
      ])
    ), this.#q = s, this.#Je = Object.fromEntries(
      Object.entries(Q).map(([A, r]) => [
        A,
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
  #xt() {
    const e = this.#B, t = this.#C, i = this.#ce, s = this.#q, A = this.#Je;
    if (!e || !t || !i || !s || !A)
      return !1;
    const r = this.#A, a = this.#p, n = (this.#p + y - 1) % y, l = (this.#p + 1) % y, o = this.#ve, d = globalThis.__YADIF_AUTOFILM_ANALYSIS_DIAGNOSTIC__, u = d?.enabled === !0, h = u ? performance.now() : 0;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [x, C] of [l, n, a].entries())
      r.activeTexture(r.TEXTURE0 + x), r.bindTexture(r.TEXTURE_2D, this.#y[C] ?? null);
    r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#m, this.#b), r.viewport(0, 0, F, R), r.drawArrays(r.TRIANGLES, 0, 3);
    const m = u ? performance.now() : 0;
    r.readPixels(
      0,
      0,
      F,
      R,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const p = u ? performance.now() : 0, { previousLuma: g, currentLuma: E, nextLuma: b } = e;
    for (let x = 0; x < g.length; x++) {
      const C = x * 4;
      g[x] = e.pixels[C] ?? 0, E[x] = e.pixels[C + 1] ?? 0, b[x] = e.pixels[C + 2] ?? 0;
    }
    const T = u ? performance.now() : 0, w = this.#Se.fieldMatch(
      g,
      E,
      b,
      o,
      this.#X
    ), f = u ? performance.now() : 0;
    r.useProgram(s), r.uniform1i(A.prev, 0), r.uniform1i(A.cur, 1), r.uniform1i(A.next, 2), r.uniform2i(A.size, this.#m, this.#b), r.uniform1i(A.topFieldFirst, o ? 1 : 0), r.uniform1i(
      A.match,
      w.match === "p" ? 0 : w.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3);
    const L = u ? performance.now() : 0;
    r.readPixels(
      0,
      0,
      F,
      R,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const B = u ? performance.now() : 0, S = this.#Se.decimate(e.pixels), k = u ? performance.now() : 0;
    u && d.samples.push({
      atMs: h,
      analysisDrawSubmitMs: m - h,
      analysisReadbackMs: p - m,
      unpackLumaMs: T - p,
      fieldMatchMs: f - T,
      sampleDrawSubmitMs: L - f,
      sampleReadbackMs: B - L,
      decimateMs: k - B,
      totalMs: k - h
    }), this.#$ = w.match, this.#Fe = w.combScore, this.#Re = w.isCombed, this.#ke = S.lowestCycleDifference, this.#Ce = S.runnerUpCycleDifference;
    const D = S.dropIndex !== null && !w.isCombed;
    return (D ? "film" : "video") !== this.#F && (this.#F = D ? "film" : "video"), S.shouldDrop && !w.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Mt(e, t) {
    const i = this.#Xe();
    if (i === null) return;
    const s = this.#w[i];
    if (s) {
      for (this.#K = i; this.#t.length > 0 && this.#t[0]?.slot === i; )
        this.#t.shift(), this.#g.late++;
      this.#Oe(s.framebuffer), this.#t.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Oe(e, t = !0) {
    const i = this.#L, s = this.#ue;
    if (!i || !s) return;
    const A = this.#A, r = this.#p, a = (this.#p + y - 1) % y, n = (this.#p + 1) % y, l = this.#ve;
    A.bindFramebuffer(A.FRAMEBUFFER, e), A.useProgram(i);
    for (const [o, d] of [n, a, r].entries())
      A.activeTexture(A.TEXTURE0 + o), A.bindTexture(A.TEXTURE_2D, this.#y[d] ?? null);
    A.uniform1i(s.prev, 0), A.uniform1i(s.cur, 1), A.uniform1i(s.next, 2), A.uniform2i(s.size, this.#m, this.#b), A.uniform1i(s.topFieldFirst, l ? 1 : 0), A.uniform1i(
      s.match,
      this.#$ === "p" ? 0 : this.#$ === "c" ? 1 : 2
    ), A.viewport(0, 0, this.#m, this.#b), A.drawArrays(A.TRIANGLES, 0, 3), e === null && (this.#f = { kind: "film" }, this.#M(!0), t && this.#_++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #At(e, t, i) {
    const s = this.#Xe();
    if (s === null) return;
    const A = this.#w[s];
    if (A) {
      for (this.#K = s; this.#t.length > 0 && this.#t[0]?.slot === s; )
        this.#t.shift(), this.#g.late++;
      this.#le(!1, e, A.framebuffer), this.#t.push({ slot: s, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #st(e, t, i) {
    const s = this.#t.at(-1), A = (q + 1) * Math.max(this.#H, i);
    if (s && s.at - t > A)
      return this.#t.length = 0, this.#g.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#t.length + e - q
    );
    let a = 0, n = 0;
    for (; n < r; ) {
      const l = this.#t.shift();
      if (!l) break;
      a += l.duration, n++;
    }
    for (const l of this.#t) l.at -= a;
    return this.#g.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Xe() {
    const e = this.#f?.kind === "texture" ? this.#f.texture : null, t = new Set(this.#t.map(({ slot: s }) => s));
    for (let s = 1; s <= _; s++) {
      const A = (this.#K + s) % _, r = this.#w[A];
      if (r && r.texture !== e && !t.has(A))
        return A;
    }
    const i = this.#t[0];
    if (i) {
      const s = this.#w[i.slot];
      if (s && s.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #V() {
    this.#P === null && (!this.#c || this.#x || (this.#fe = 0, this.#P = this.#nt(this.#rt)));
  }
  #ze() {
    this.#P !== null && this.#Ft(this.#P), this.#P = null, this.#t.length = 0;
  }
  #rt = (e) => {
    if (this.#P = null, !(!this.#c || this.#x)) {
      if (this.#fe > 0) {
        const t = e - this.#fe;
        t >= 1 && t <= V && (this.#H = t < this.#H ? t : this.#H + (t - this.#H) * ge);
      }
      this.#fe = e, this.#s === "main" && this.#kt(e), this.#P = this.#nt(this.#rt);
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
    this.#h || this.#I !== null || !this.#c || this.#x || (this.#I = requestAnimationFrame(this.#ot));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Rt() {
    this.#I !== null && cancelAnimationFrame(this.#I), this.#I = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #ot = (e) => {
    this.#I = null, !(!this.#c || this.#x) && (this.#St(e), this.#I = requestAnimationFrame(this.#ot));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #St(e) {
    if (this.#h || e - this.#me < Ee || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#l >= j ? this.#l : ve, A = i > this.#Y, r = t !== this.#de && e - this.#Le >= s * 0.75;
    !A && !r || (this.#Y = Math.max(
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
  #kt(e) {
    const t = e + this.#H * 1.5;
    for (; this.#t[1] && this.#t[1].at <= t; )
      this.#g.late++, this.#t.shift();
    let i = this.#t[0];
    if (!i || i.at > t)
      return;
    this.#t.shift();
    const s = performance.now();
    this.#at(i.slot), this.#oe += performance.now() - s, this.#ne++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #at(e) {
    const t = this.#w[e];
    t && this.#Ze(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Ct() {
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
    const s = this.#A;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#D), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#G, 0), s.uniform1i(this.#W, t ? 1 : 0), s.viewport(0, 0, this.#m, this.#b), s.drawArrays(s.TRIANGLES, 0, 3), this.#f = { kind: "texture", texture: e, flip: t }, this.#M(!0), i && this.#_++;
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
  #Bt(e) {
    const t = e - this.#Ee;
    if (t < te) return;
    const i = this.#ye() && (this.#T || this.#F === "film") ? this.#ne : this.#N, s = {
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
      outputFps: this.#_ * 1e3 / t,
      duplicateScore: this.#ke,
      duplicateRunnerUp: this.#Ce
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#Pe?.(s), this.#Ee = e, this.#N = 0, this.#re = 0, this.#ne = 0, this.#oe = 0, this.#j = 0, this.#_ = 0;
  }
  /** Take the newest frame into the ring. */
  #ht() {
    const e = this.#A;
    this.#p = (this.#p + 1) % y, e.bindTexture(e.TEXTURE_2D, this.#y[this.#p] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#we
    ), this.#o = Math.min(this.#o + 1, y);
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
  #le(e, t, i, s = !0) {
    if (this.#o === 0 || this.#x) return;
    s && (this.#o === y && !e ? this.#g.filtered++ : this.#g.degraded++);
    const A = this.#A, r = this.#p, a = (this.#p + y - 1) % y, n = (this.#p + 1) % y;
    let l, o, d;
    this.#o === 1 ? l = o = d = r : e ? (l = a, o = d = r) : this.#o === 2 ? (l = o = a, d = r) : (l = n, o = a, d = r), A.bindFramebuffer(A.FRAMEBUFFER, i), A.useProgram(this.#v);
    for (const [h, m] of [l, o, d].entries())
      A.activeTexture(A.TEXTURE0 + h), A.bindTexture(A.TEXTURE_2D, this.#y[m] ?? null);
    A.uniform1i(this.#n.prev, 0), A.uniform1i(this.#n.cur, 1), A.uniform1i(this.#n.next, 2), A.uniform2i(this.#n.size, this.#m, this.#b);
    const u = this.#ve ? 0 : 1;
    A.uniform1i(this.#n.parity, t ? 1 - u : u), A.uniform1i(this.#n.tff, this.#ve ? 1 : 0), A.uniform1i(this.#n.spatialCheck, this.#Me ? 1 : 0), A.viewport(0, 0, this.#m, this.#b), A.drawArrays(A.TRIANGLES, 0, 3), i === null && (this.#f = { kind: "yadif", flush: e, second: t }, this.#M(!0), s && this.#_++);
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
    if (!this.#O) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const s = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), A = t * s, r = i * s;
    this.#i.style.left = `${e.offsetLeft + (e.offsetWidth - A) / 2}px`, this.#i.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#i.style.width = `${A}px`, this.#i.style.height = `${r}px`;
  }
  #lt(e, t) {
    const i = this.#A;
    this.#u.width = e, this.#u.height = t, this.#m = e, this.#b = t, this.#o = 0, this.#f = null, this.#E(), this.#Te();
    for (const s of this.#y) i.deleteTexture(s);
    this.#y = [];
    for (let s = 0; s < y; s++) {
      const A = i.createTexture();
      i.bindTexture(i.TEXTURE_2D, A), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MIN_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MAG_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_S, i.CLAMP_TO_EDGE), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_T, i.CLAMP_TO_EDGE), i.texImage2D(
        i.TEXTURE_2D,
        0,
        i.RGBA,
        e,
        t,
        0,
        i.RGBA,
        i.UNSIGNED_BYTE,
        null
      ), this.#y.push(A);
    }
    this.#J(), this.#Qe(), this.#d && this.#ct(), (this.#T || this.#d) && this.#je();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #ct() {
    if (this.#B) return;
    const e = this.#A, t = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      F,
      R,
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
    this.#B = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(F * R * 4),
      previousLuma: new Uint8Array(F * R),
      currentLuma: new Uint8Array(F * R),
      nextLuma: new Uint8Array(F * R)
    };
  }
  #Qe() {
    this.#B && (this.#A.deleteFramebuffer(this.#B.framebuffer), this.#A.deleteTexture(this.#B.texture), this.#B = null);
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
    const e = this.#A;
    if (!(this.#w.length === _ || this.#m === 0)) {
      this.#J();
      for (let t = 0; t < _; t++) {
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
        const s = e.createFramebuffer();
        e.bindFramebuffer(e.FRAMEBUFFER, s), e.framebufferTexture2D(
          e.FRAMEBUFFER,
          e.COLOR_ATTACHMENT0,
          e.TEXTURE_2D,
          i,
          0
        );
        const A = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
        if (e.bindFramebuffer(e.FRAMEBUFFER, null), !A) {
          e.deleteFramebuffer(s), e.deleteTexture(i), this.#J();
          return;
        }
        this.#w.push({ texture: i, framebuffer: s });
      }
      this.#K = _ - 1;
    }
  }
  #J() {
    const e = this.#A, t = this.#f?.kind === "texture" ? this.#f.texture : null;
    this.#w.some((i) => i.texture === t) && (this.#f = null);
    for (const { texture: i, framebuffer: s } of this.#w)
      e.deleteFramebuffer(s), e.deleteTexture(i);
    this.#w = [], this.#t.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #Pt() {
    if (this.#O) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#O = t, this.#xe?.observe(this.#e), this.#Te();
  }
  #It() {
    if (this.#h) return;
    const e = this.#O;
    this.#O = null, this.#xe?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #ut = () => this.#Te();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #Ve(e) {
    return !this.#r || this.#s === "main" ? !1 : (this.#r.postMessage({
      type: "event",
      name: e,
      video: this.#He()
    }), !0);
  }
  #ft = () => {
    if (this.#de = Number.NaN, this.#Ve("emptied")) {
      this.#S(), this.#M(!1);
      return;
    }
    this.#o = 0, this.#ee = 0, this.#t.length = 0, this.#l = 0, this.#dt(), this.#E(), this.#f = null, this.#M(!1);
  };
  #dt() {
    this.#g = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#U = 0, this.#Ee = 0, this.#Ne = 0, this.#N = 0, this.#re = 0, this.#ne = 0, this.#oe = 0, this.#j = 0, this.#_ = 0, this.#E();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #E() {
    this.#t.length = 0, this.#F = "video", this.#$ = "c", this.#Fe = 0, this.#Re = !0, this.#Se.reset(), this.#ke = 1 / 0, this.#Ce = 1 / 0;
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
  #k = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#Ve(e.type)) {
      this.#S();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#te;
      if (this.#te = !1, i) return;
      this.#o = 0, this.#E(), this.#f = null, this.#M(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#l = 0, this.#ee = this.#e.currentTime), this.#t.length = 0, this.#c && this.#o > 0) {
      const i = this.#Xe(), s = i === null ? void 0 : this.#w[i];
      i !== null && s ? (this.#K = i, this.#le(!0, !1, s.framebuffer), this.#at(i)) : this.#le(!0, !1, null);
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
    this.#s !== "active" && (this.#x = !0, this.stop());
  };
}
function O(c, e) {
  const t = c.createProgram(), i = Ae(c, c.VERTEX_SHADER, be), s = Ae(c, c.FRAGMENT_SHADER, e);
  if (c.attachShader(t, i), c.attachShader(t, s), c.linkProgram(t), c.deleteShader(i), c.deleteShader(s), !c.getProgramParameter(t, c.LINK_STATUS)) {
    const A = c.getProgramInfoLog(t);
    throw c.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${A ?? "no reason given"}`
    );
  }
  return t;
}
function Ae(c, e, t) {
  const i = c.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (c.shaderSource(i, t), c.compileShader(i), !c.getShaderParameter(i, c.COMPILE_STATUS)) {
    const s = c.getShaderInfoLog(i);
    throw c.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return i;
}
const se = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", ye = 0.5, Te = 3e3, re = 0.1, W = 16, ne = 'video/mp4; codecs="avc1.640029"';
let K = null;
function xe(c = {}) {
  return K ??= Me(c), K;
}
async function Be(c = {}) {
  return (await xe(c)).deinterlaces;
}
function Pe() {
  K = null;
}
async function Me(c) {
  const e = c.tolerance ?? ye, t = c.timeoutMs ?? Te, i = performance.now(), s = (a) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: a instanceof Error ? a.message : String(a)
  });
  if (typeof document > "u")
    return s(new Error("there is no document to decode in"));
  const A = document.createElement("video");
  A.muted = !0, A.defaultMuted = !0, A.playsInline = !0, A.preload = "auto";
  let r = null;
  try {
    r = Re(A, t);
    const a = Y(z(A, "loadeddata"), t), n = A.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await a, await Se(A, t, await n), A.videoWidth === 0 || A.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const l = ke(A);
    return {
      deinterlaces: l < 1 - e,
      survives: l,
      tookMs: performance.now() - i
    };
  } catch (a) {
    return s(a);
  } finally {
    A.pause(), A.removeAttribute("src"), A.replaceChildren(), A.load(), r && URL.revokeObjectURL(r.url);
  }
}
const J = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Fe = typeof MediaSource > "u";
function Re(c, e) {
  if (!J || !J.isTypeSupported(ne))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = se.indexOf(","), i = atob(se.slice(t + 1)), s = new Uint8Array(i.length);
  for (let n = 0; n < i.length; n++) s[n] = i.charCodeAt(n);
  const A = new J(), r = URL.createObjectURL(A);
  if (Fe) {
    c.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, c.append(n), c.load();
  } else
    c.src = r;
  const a = (async () => {
    await Y(z(A, "sourceopen"), e);
    const n = A.addSourceBuffer(ne), l = Y(z(n, "updateend"), e);
    n.appendBuffer(s), await l, A.endOfStream();
  })();
  return { url: r, ready: a };
}
async function Se(c, e, t) {
  if (t) {
    const i = performance.now();
    for (; c.currentTime < re && performance.now() - i < e; )
      await new Promise((s) => requestAnimationFrame(s));
    c.pause();
  } else
    c.currentTime = re, await Y(z(c, "seeked"), e);
}
function ke(c) {
  const e = c.videoHeight, t = document.createElement("canvas");
  t.width = W, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(c, 0, 0, W, e);
  const s = i.getImageData(0, 0, W, e).data, A = (o) => {
    let d = 0;
    for (let u = 0; u < W; u++)
      d += s[(o * W + u) * 4 + 1] ?? 0;
    return d / W;
  };
  let r = 0;
  const a = 2, n = e - 3;
  let l = A(a);
  for (let o = a + 1; o <= n; o++) {
    const d = A(o);
    r += Math.abs(d - l), l = d;
  }
  return r / (n - a) / 255;
}
function z(c, e) {
  return new Promise((t, i) => {
    c.addEventListener(e, () => t(), { once: !0 }), c.addEventListener(
      "error",
      () => {
        const s = c instanceof HTMLMediaElement ? c.error : null, A = s ? ` (MediaError ${s.code}${s.message ? `: ${s.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${A}`));
      },
      { once: !0 }
    );
  });
}
function Y(c, e) {
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
  ce as FILM_ANALYSIS_FRAGMENT_SHADER,
  fe as FILM_SAMPLE_FRAGMENT_SHADER,
  Q as FILM_UNIFORMS,
  ue as FILM_WEAVE_FRAGMENT_SHADER,
  le as YADIF_FRAGMENT_SHADER,
  he as YADIF_UNIFORMS,
  Be as decoderDeinterlaces,
  Pe as forgetDecoderProbe,
  xe as probeDecoder,
  Ce as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
