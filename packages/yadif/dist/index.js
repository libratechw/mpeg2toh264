const ce = "" + new URL("assets/worker-BT6pr8SK.js", import.meta.url).href, ue = {
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
`, Q = {
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
class D {
  static CYCLE = 5;
  static COMB_THRESHOLD = 9;
  static COMBED_PIXEL_LIMIT = 80;
  static DECIMATE_BLOCK = 32;
  static DUPLICATE_PERCENT = 1.1;
  #n;
  #t;
  #e;
  #s = 0;
  #d = null;
  #A = [];
  #w = null;
  #T = 1 / 0;
  #x = 1 / 0;
  constructor(e, t) {
    this.#n = e, this.#t = t, this.#e = 255 * D.DECIMATE_BLOCK ** 2 * D.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, s, A = D.COMBED_PIXEL_LIMIT) {
    const r = s ? 1 : 0, o = { p: e, c: t, n: i };
    let n = this.#E("c", "p", r, o);
    const a = /* @__PURE__ */ new Map(), h = (g) => {
      const w = a.get(g);
      if (w !== void 0) return w;
      const p = D.#v(
        this.weave(e, t, i, g, s),
        this.#n,
        this.#t
      );
      return a.set(g, p), p;
    }, d = h(n), u = h("n");
    (u * 3 < d || u * 2 < d && d > A) && Math.abs(u - d) >= 30 && u < A && (n = "n");
    const f = h(n), c = f >= A;
    return c && (n = "c"), {
      match: n,
      combScore: f,
      isCombed: c,
      luma: this.weave(e, t, i, n, s)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#s, i = this.#w ? D.#L(
      this.#w,
      e,
      this.#n,
      this.#t
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#A.push(i);
    const s = this.#d === t, A = s && i.maxBlockDifference < this.#e;
    s && !A && (this.#d = null);
    const r = this.#d;
    this.#w = e.slice(), this.#s++;
    let o = this.#d;
    if (this.#s === D.CYCLE) {
      let n = 0, a = null;
      for (let h = 1; h < this.#A.length; h++)
        (this.#A[h]?.maxBlockDifference ?? 1 / 0) < (this.#A[n]?.maxBlockDifference ?? 1 / 0) ? (a = n, n = h) : (a === null || (this.#A[h]?.maxBlockDifference ?? 1 / 0) < (this.#A[a]?.maxBlockDifference ?? 1 / 0)) && (a = h);
      this.#T = this.#A[n]?.maxBlockDifference ?? 1 / 0, this.#x = a === null ? 1 / 0 : this.#A[a]?.maxBlockDifference ?? 1 / 0, o = (this.#A[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#d = o, this.#A = [], this.#s = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: A,
      dropIndex: r,
      nextDropIndex: o,
      lowestCycleDifference: this.#T,
      runnerUpCycleDifference: this.#x
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, s, A) {
    if (s === "c") return t.slice();
    const r = t.slice(), o = s === "p" ? e : i, n = r.length / this.#t, a = A ? 1 : 0;
    for (let h = a; h < this.#t; h += 2)
      r.set(
        o.subarray(h * n, (h + 1) * n),
        h * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#s = 0, this.#d = null, this.#A = [], this.#w = null, this.#T = 1 / 0, this.#x = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #E(e, t, i, s) {
    const A = this.#n, r = this.#t, o = 2 - i, n = 2 - i, a = s[e], h = s[t], d = D.#M(
      a,
      h,
      A,
      r,
      i
    );
    let u = 0, f = 0, c = 0, g = 0, w = 0, p = 0;
    for (let S = 2; S < r - 2; S += 2) {
      const y = (S - 2) / 2, X = o - 1 + y * 2, Y = o + 1 + y * 2, Z = o + 3 + y * 2, z = o + y * 2, G = z + 2, L = n + y * 2, R = L + 2, $ = o + y * 2;
      for (let T = 8; T < A - 8; T++) {
        const k = (d[$ * A + T] ?? 0) | (d[($ + 2) * A + T] ?? 0);
        if (k === 0) continue;
        const ee = (s.c[X * A + T] ?? 0) + ((s.c[Y * A + T] ?? 0) << 2) + (s.c[Z * A + T] ?? 0), P = Math.abs(
          3 * ((a[z * A + T] ?? 0) + (a[G * A + T] ?? 0)) - ee
        ), B = Math.abs(
          3 * ((h[L * A + T] ?? 0) + (h[R * A + T] ?? 0)) - ee
        );
        P > 23 && (k & 1) !== 0 && (u += P), B > 23 && (k & 1) !== 0 && (g += B), P > 42 && (k & 2) !== 0 && (f += P), B > 42 && (k & 2) !== 0 && (w += B), P > 42 && (k & 4) !== 0 && (c += P), B > 42 && (k & 4) !== 0 && (p += B);
      }
    }
    f < 500 && w < 500 && (c >= 500 || p >= 500) && Math.max(c, p) > 3 * Math.min(c, p) && (f = c, w = p);
    const v = Math.floor(u / 6 + 0.5), F = Math.floor(g / 6 + 0.5), E = Math.floor(f / 6 + 0.5), m = Math.floor(w / 6 + 0.5), _ = Math.max(v, F) / Math.max(Math.min(v, F), 1), U = Math.max(E, m) / Math.max(Math.min(E, m), 1), N = Math.max(E, m) / Math.max(Math.max(v, F), 1);
    return (E >= 500 || m >= 500) && (E * 2 < m || m * 2 < E) || (E >= 1e3 || m >= 1e3) && (E * 3 < m * 2 || m * 3 < E * 2) || (E >= 2e3 || m >= 2e3) && (E * 5 < m * 4 || m * 5 < E * 4) || (E >= 4e3 || m >= 4e3) && U > _ || N > 5e-3 && Math.max(E, m) > 150 && (E * 2 < m || m * 2 < E) ? E > m ? t : e : v > F ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #M(e, t, i, s, A) {
    const r = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(i)
    ), o = A === 1 ? 1 : 0;
    for (let h = 0; h < r.length; h++) {
      const d = Math.min(s - 1, o + h * 2), u = r[h];
      if (u)
        for (let f = 0; f < i; f++)
          u[f] = Math.abs(
            (e[d * i + f] ?? 0) - (t[d * i + f] ?? 0)
          );
    }
    const n = new Uint8Array(i * s), a = A === 1 ? 3 : 2;
    for (let h = 1; h < r.length - 1; h++) {
      const d = a + (h - 1) * 2;
      if (d >= s) break;
      const u = r[h];
      if (u)
        for (let f = 1; f < i - 1; f++) {
          const c = u[f] ?? 0;
          if (c <= 3) continue;
          let g = 0;
          for (let m = f - 1; m <= f + 1; m++)
            g += (r[h - 1]?.[m] ?? 0) > 3 ? 1 : 0, g += (r[h]?.[m] ?? 0) > 3 ? 1 : 0, g += (r[h + 1]?.[m] ?? 0) > 3 ? 1 : 0;
          if (g <= 1) continue;
          const w = d * i + f;
          if (n[w] = 1, c <= 19) continue;
          g = 0;
          let p = !1, v = !1;
          for (let m = f - 1; m <= f + 1; m++)
            (r[h - 1]?.[m] ?? 0) > 19 && (g++, p = !0), (r[h]?.[m] ?? 0) > 19 && g++, (r[h + 1]?.[m] ?? 0) > 19 && (g++, v = !0);
          if (g <= 3) continue;
          if (p && v) {
            n[w] |= 2;
            continue;
          }
          let F = !1, E = !1;
          for (let m = Math.max(f - 4, 0); m < Math.min(f + 5, i); m++)
            h !== 1 && (r[h - 2]?.[m] ?? 0) > 19 && (F = !0), (r[h - 1]?.[m] ?? 0) > 19 && (p = !0), (r[h + 1]?.[m] ?? 0) > 19 && (v = !0), h !== r.length - 2 && (r[h + 2]?.[m] ?? 0) > 19 && (E = !0);
          p && (v || F) || v && (p || E) ? n[w] |= 2 : g > 5 && (n[w] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #v(e, t, i) {
    const s = new Uint8Array(t * i), A = (o, n) => e[Math.max(0, Math.min(i - 1, n)) * t + o] ?? 0;
    for (let o = 0; o < i; o++)
      for (let n = 0; n < t; n++) {
        const a = A(n, o), h = A(n, o === 0 ? 1 : o - 1), d = A(n, o === i - 1 ? i - 2 : o + 1), u = o < 2 ? A(n, o === 0 ? 2 : 3) : A(n, o - 2), f = o + 2 >= i ? A(n, o === i - 1 ? i - 3 : i - 4) : A(n, o + 2);
        (o === 0 ? Math.abs(a - d) > D.COMB_THRESHOLD : o === i - 1 ? Math.abs(a - h) > D.COMB_THRESHOLD : Math.abs(a - h) > D.COMB_THRESHOLD && Math.abs(a - d) > D.COMB_THRESHOLD) && Math.abs(
          4 * a - 3 * (h + d) + u + f
        ) > D.COMB_THRESHOLD * 6 && (s[o * t + n] = 255);
      }
    let r = 0;
    for (const o of [0, 8])
      for (const n of [0, 8])
        for (let a = o; a < i; a += 16)
          for (let h = n; h < t; h += 16) {
            let d = 0;
            for (let u = Math.max(1, a); u < Math.min(i - 1, a + 16); u++)
              for (let f = h; f < Math.min(t, h + 16); f++) {
                const c = u * t + f;
                s[c - t] === 255 && s[c] === 255 && s[c + t] === 255 && d++;
              }
            r = Math.max(r, d);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #L(e, t, i, s) {
    const A = D.DECIMATE_BLOCK / 2, r = Math.ceil(i / A), o = Math.ceil(s / A), n = new Float64Array(r * o), a = e.length / (i * s);
    for (let u = 0; u < s; u++) {
      const f = Math.floor(u / A);
      for (let c = 0; c < i; c++) {
        const g = Math.floor(c / A), w = f * r + g, p = (u * i + c) * a;
        if (a === 1) {
          n[w] = (n[w] ?? 0) + Math.abs((e[p] ?? 0) - (t[p] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[p] ?? 0) * 0.2126 + (e[p + 1] ?? 0) * 0.7152 + (e[p + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (t[p] ?? 0) * 0.2126 + (t[p + 1] ?? 0) * 0.7152 + (t[p + 2] ?? 0) * 0.0722
        );
        if (n[w] = (n[w] ?? 0) + Math.abs(v - F), (c & 1) !== 0 || (u & 1) !== 0) continue;
        let E = 0, m = 0, _ = 0, U = 0, N = 0, S = 0, y = 0;
        for (let G = u; G < Math.min(u + 2, s); G++)
          for (let L = c; L < Math.min(c + 2, i); L++) {
            const R = (G * i + L) * a;
            E += e[R] ?? 0, m += e[R + 1] ?? 0, _ += e[R + 2] ?? 0, U += t[R] ?? 0, N += t[R + 1] ?? 0, S += t[R + 2] ?? 0, y++;
          }
        const X = Math.round(
          (-0.114572 * E - 0.385428 * m + 0.5 * _) / y
        ), Y = Math.round(
          (-0.114572 * U - 0.385428 * N + 0.5 * S) / y
        ), Z = Math.round(
          (0.5 * E - 0.454153 * m - 0.045847 * _) / y
        ), z = Math.round(
          (0.5 * U - 0.454153 * N - 0.045847 * S) / y
        );
        n[w] = (n[w] ?? 0) + Math.abs(X - Y) + Math.abs(Z - z);
      }
    }
    let h = -1;
    for (let u = 0; u < o - 1; u++)
      for (let f = 0; f < r - 1; f++)
        h = Math.max(
          h,
          (n[u * r + f] ?? 0) + (n[u * r + f + 1] ?? 0) + (n[(u + 1) * r + f] ?? 0) + (n[(u + 1) * r + f + 1] ?? 0)
        );
    let d = 0;
    for (const u of n) d += u;
    return { maxBlockDifference: h, totalDifference: d };
  }
}
const oe = [
  "mozParsedFrames",
  "mozDecodedFrames",
  "mozPresentedFrames",
  "mozPaintedFrames"
];
function ae(l) {
  return oe.every((e) => e in l);
}
function we() {
  return typeof HTMLVideoElement < "u" && (ae(HTMLVideoElement.prototype) || typeof HTMLVideoElement.prototype.requestVideoFrameCallback == "function");
}
const ge = 250, Ee = 500;
class ve {
  #n;
  #t;
  #e = null;
  #s = null;
  #d = null;
  #A = null;
  #w = !1;
  #T = !0;
  #x = null;
  #E = null;
  #M = 0;
  constructor(e) {
    if (this.#n = e, this.#t = ae(e) ? e : null, this.#t) {
      for (const t of ["emptied", "seeking", "seeked"])
        e.addEventListener(t, this.#L);
      for (const t of ["pause", "playing", "waiting", "ratechange"])
        e.addEventListener(t, this.#v);
    }
  }
  /** Whether acquisition runs off the Firefox counters. */
  get mozDriven() {
    return this.#t !== null;
  }
  /** Whether any frame has been delivered yet (counters proven live). */
  get hasDelivered() {
    return this.#w;
  }
  request(e) {
    this.#e === null && (this.#s = e, this.#e = this.#t ? requestAnimationFrame(this.#ee) : this.#n.requestVideoFrameCallback(this.#P));
  }
  cancel() {
    this.#e !== null && (this.#t ? cancelAnimationFrame(this.#e) : this.#n.cancelVideoFrameCallback(this.#e)), this.#e = null, this.#s = null, this.#L();
  }
  destroy() {
    this.cancel();
    for (const e of ["emptied", "seeking", "seeked"])
      this.#n.removeEventListener(e, this.#L);
    for (const e of ["pause", "playing", "waiting", "ratechange"])
      this.#n.removeEventListener(e, this.#v);
  }
  #v = () => {
    this.#x = null, this.#E = null, this.#M = 0;
  };
  #L = () => {
    this.#d = null, this.#A = null, this.#T = !0, this.#v();
  };
  #P = (e, t) => {
    const i = this.#s;
    this.#e = null, this.#s = null, this.#w = !0, i?.(e, t);
  };
  #ee = (e) => {
    const t = this.#t, i = oe.map((o) => t[o]);
    this.#d?.some((o, n) => i[n] < o) && this.#L(), this.#d = i;
    const s = t.mozPaintedFrames, A = !t.seeking && t.readyState >= 2 && t.videoWidth > 0 && t.videoHeight > 0, r = this.#A === null && (s > 0 || t.paused && (t.mozPresentedFrames > 0 || t.mozDecodedFrames > 0));
    if (A && (r || this.#A !== null && s !== this.#A)) {
      if (this.#x !== null && e - this.#x > Ee && (this.#v(), this.#T = !0), !t.paused && !t.ended) {
        const n = this.#E;
        if (n && e - n.at >= ge) {
          const a = s - n.frames;
          if (a > 0) {
            const h = (e - n.at) / a;
            h >= 4 && h <= 200 && (this.#M = this.#M ? this.#M + (h - this.#M) * 0.25 : h);
          }
          this.#E = null;
        }
        this.#E ??= { at: e, frames: s };
      }
      this.#x = e, this.#A = s;
      const o = this.#T;
      this.#T = !1, this.#P(e, {
        width: t.videoWidth,
        height: t.videoHeight,
        // Used only to select source scan/size metadata on the media timeline.
        // It is deliberately NOT used as the frame identity or field clock.
        mediaTime: t.currentTime,
        presentedFrames: s,
        expectedDisplayTime: e,
        mozTiming: { periodMs: this.#M, discontinuity: o }
      });
    } else
      this.#e = requestAnimationFrame(this.#ee);
  };
}
let le = null;
function De(l) {
  le = l;
}
const te = 0.5, b = 3, q = 5, C = q + 1, ie = 1e3, j = 4, V = 200, be = 0.25, ye = 1e3 / 60, Te = 0.02, xe = 250, Me = 1e3 / 30;
function se(l) {
  if (!Number.isFinite(l) || l < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return l;
}
const Fe = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, Re = `#version 300 es
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
function Ue() {
  return we() && typeof WebGL2RenderingContext < "u";
}
class Ne extends EventTarget {
  #n;
  #t;
  #e;
  #s;
  #d;
  #A;
  /** The program that copies a filtered picture onto the canvas. */
  #w;
  #T;
  #x;
  /** The reduced pass that reads previous, current and next luma together. */
  #E = null;
  #M = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #v = null;
  #L = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #P = null;
  #ee = null;
  #N = null;
  #R = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #D = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #te = C - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #f = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #i = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #G = null;
  #de = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #W = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #X = ye;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #Y = null;
  #Me;
  #S;
  #m;
  #Z;
  #Fe;
  #B = "video";
  #ie = "c";
  #Re = 0;
  #Se = !0;
  #ke = new D(x, M);
  #Ce = 1 / 0;
  #Le = 1 / 0;
  #z = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #c = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #p = 0;
  #F = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #g = b - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #o = 0;
  #se = 0;
  /** presentedFrames at the last ingested frame; pairs with #lastMediaTime. */
  #Pe = 0;
  #me = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #Ae = !1;
  #Q;
  /** 最終通知時刻。rVFC と Firefox カウンターのどちらの取得経路でも更新する。 */
  #pe = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #j = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #Be = 0;
  #u = !1;
  #we = !1;
  #Ie = !1;
  #a = null;
  #V = [];
  #k = !1;
  #_e;
  #l;
  #ge;
  #I;
  #Ue;
  #h = null;
  #r;
  #re = !1;
  #Ne = 0;
  #Ge = !1;
  #Et = 0;
  #ne = !1;
  #Ee = !1;
  #J = null;
  #vt = 0;
  #he = /* @__PURE__ */ new Map();
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #b = {
    filtered: 0,
    missed: 0,
    degraded: 0,
    discontinuities: 0,
    late: 0,
    queueResetted: 0
  };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #H = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #We = 0;
  #ve = 0;
  #O = 0;
  #oe = 0;
  #ae = 0;
  #le = 0;
  #q = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#S = t.doubleRate ?? !1, this.#m = t.autoFilm ?? !1, this.#Z = se(
      t.filmCombThreshold ?? D.COMBED_PIXEL_LIMIT
    ), this.#Fe = t.spatialCheck ?? !0, this.#_e = t.onStats, this.#l = i, this.#I = i ? "main" : t.rendering ?? "auto", this.#Ue = t.workerUrl ?? le, this.#r = this.#I === "main" ? "main" : "idle", this.#t = i ? i.canvas : document.createElement("canvas"), this.#n = i?.canvas ?? (this.#I === "main" ? this.#t : document.createElement("canvas")), this.#ge = e, i || (this.#t.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const s = this.#n.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!s) throw new Error("this browser has no WebGL2");
    this.#s = s, this.#d = W(s, fe);
    const A = this.#d;
    this.#A = Object.fromEntries(
      Object.entries(ue).map(([r, o]) => [
        r,
        s.getUniformLocation(A, o)
      ])
    ), this.#w = W(s, Re), this.#T = s.getUniformLocation(this.#w, "uField"), this.#x = s.getUniformLocation(this.#w, "uFlip"), this.#m && this.#At(), this.#n.addEventListener(
      "webglcontextlost",
      this.#gt
    ), this.#Me = i ? null : new ResizeObserver(() => this.#xe()), this.#Q = new ve(e), e.addEventListener("emptied", this.#mt), e.addEventListener("resize", this.#dt), e.addEventListener("pause", this.#U), e.addEventListener("ended", this.#U), e.addEventListener("seeking", this.#wt), e.addEventListener("seeked", this.#U), e.addEventListener("ratechange", this.#U);
  }
  get running() {
    return this.#u && (this.#a?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#t;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #De() {
    return this.#a?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #Ke() {
    return {
      doubleRate: this.#S,
      autoFilm: this.#m,
      filmCombThreshold: this.#Z,
      spatialCheck: this.#Fe
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#we;
  }
  set enabled(e) {
    this.#we = e, this.#He(), this.#h?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#a?.interlaced !== e?.interlaced, i = t || this.#a?.topFieldFirst !== e?.topFieldFirst;
    this.#a = e, this.#h?.postMessage({ type: "scan", scan: e }), i && (this.#o = 0, this.#y(), t && (this.#c = 0), this.#f = null, this.#C(!1)), this.#He(), i && ((e?.interlaced ?? !0) && (this.#l || this.#r === "main") ? this.#K() : this.#Ze());
  }
  get scan() {
    return this.#a;
  }
  set videoTimeline(e) {
    this.#V = e, this.#h?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#a = null), this.#He();
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
    return this.#Y ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#S;
  }
  set doubleRate(e) {
    e !== this.#S && (this.#S = e, this.#ze(), this.#i.length = 0, e ? (this.#p > 0 && this.#Je(), (this.#a?.interlaced ?? !0) && (this.#l || this.#r === "main") && this.#K()) : this.#m || (this.#f = null, this.#C(!1), this.#$()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#m;
  }
  set autoFilm(e) {
    e !== this.#m && (this.#m = e, this.#ze(), this.#y(), e ? (this.#At(), this.#p > 0 && (this.#ft(), this.#Je()), (this.#a?.interlaced ?? !0) && (this.#l || this.#r === "main") && this.#K()) : (this.#Ve(), this.#S || (this.#f = null, this.#C(!1), this.#$())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#Z;
  }
  set filmCombThreshold(e) {
    const t = se(e);
    t !== this.#Z && (this.#Z = t, this.#ze(), this.#m && this.#y());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #ze() {
    this.#h?.postMessage({
      type: "settings",
      options: this.#Ke()
    });
  }
  #He() {
    this.#we && (this.#V.length > 0 || (this.#a?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #Dt() {
    return this.#l || this.#I === "main" ? !1 : this.#r === "starting" || this.#r === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Ue !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#$e(), !0) : this.#I === "auto" ? (this.#be(), !1) : (this.#r = "failed", this.#u = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #$e() {
    this.#_(), this.#h?.terminate(), this.#h = null, this.#ne = !1, this.#Ee = !1;
    let e = this.#t;
    if (this.#Ge) {
      e = document.createElement("canvas"), e.className = this.#t.className;
      const A = this.#t.getAttribute("style");
      A === null ? e.removeAttribute("style") : e.setAttribute("style", A), e.style.visibility = "hidden", this.#t.parentElement && this.#t.replaceWith(e), this.#t = e;
    }
    const t = ++this.#Ne;
    this.#r = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#Ge = !0, i = new Worker(this.#Ue, { type: "module" });
    } catch (A) {
      this.#ce(
        A instanceof Error ? A.message : String(A)
      );
      return;
    }
    this.#h = i, i.onmessage = (A) => {
      t === this.#Ne && this.#bt(A.data);
    }, i.onerror = (A) => {
      t === this.#Ne && (A.preventDefault(), this.#ce(A.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#Ke(),
        scan: this.#a,
        videoTimeline: this.#V,
        enabled: this.#u,
        video: this.#Oe()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #bt(e) {
    switch (e.type) {
      case "ready":
        this.#r = "active", this.#u && (this.#ue(), this.#Qe());
        break;
      case "failed":
        this.#ce(e.message);
        break;
      case "consumed": {
        this.#ne = !1, this.#Ee = !0;
        const t = this.#J;
        this.#J = null, t && this.#tt(t);
        break;
      }
      case "visibility":
        this.#t.style.visibility = e.visible ? "visible" : "hidden";
        break;
      case "stats": {
        const t = {
          ...e.stats,
          dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0
        };
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#_e?.(t);
        break;
      }
      case "capture": {
        const t = this.#he.get(e.id);
        if (this.#he.delete(e.id), !t) {
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
  #ce(e) {
    if (this.#r === "starting" && this.#I === "auto" && !this.#re) {
      this.#be();
      return;
    }
    if (this.#et(e), !this.#re) {
      this.#re = !0, this.#$e();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#r = "failed", this.#h?.terminate(), this.#h = null, this.#_(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #be() {
    const e = this.#n;
    e.className = this.#t.className;
    const t = this.#t.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#t.parentElement && this.#t.replaceWith(e), this.#t = e, this.#Ge = !1, this.#h?.terminate(), this.#h = null, this.#r = "main", this.#_(), this.#u && (this.#ue(), this.#Qe(), (this.#a?.interlaced ?? !0) && this.#K());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #_() {
    this.#J?.frame.close(), this.#J = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #et(e) {
    for (const t of this.#he.values())
      t.reject(new Error(e));
    this.#he.clear();
  }
  start() {
    if (!(this.#u || this.#Ie || this.#k)) {
      if (this.#u = !0, this.#pt(), this.#y(), this.#pe = performance.now(), this.#Be = this.#pe, this.#me = Number.NaN, this.#j = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#It(), this.#Qe(), this.#Dt()) {
        this.#h?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#r === "active" && this.#ue();
        return;
      }
      this.#ue(), (this.#a?.interlaced ?? !0) && this.#K();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#u && (this.#u = !1, this.#Q.cancel(), this.#St(), this.#Ze(), this.#o = 0, this.#f = null, this.#C(!1), this.#_(), this.#h?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#Ie) {
      this.#Ie = !0, this.#we = !1, this.stop(), this.#Q.destroy(), this.#h?.postMessage({ type: "destroy" }), this.#h?.terminate(), this.#h = null, this.#_(), this.#et("the deinterlacer was destroyed"), this.#n.removeEventListener(
        "webglcontextlost",
        this.#gt
      ), this.#e.removeEventListener("emptied", this.#mt), this.#e.removeEventListener("resize", this.#dt), this.#e.removeEventListener("pause", this.#U), this.#e.removeEventListener("ended", this.#U), this.#e.removeEventListener("seeking", this.#wt), this.#e.removeEventListener("seeked", this.#U), this.#e.removeEventListener("ratechange", this.#U), this.#_t();
      for (const e of this.#R) this.#s.deleteTexture(e);
      this.#R = [], this.#$(), this.#Ve(), this.#s.deleteProgram(this.#d), this.#s.deleteProgram(this.#w), this.#E && this.#s.deleteProgram(this.#E), this.#v && this.#s.deleteProgram(this.#v), this.#P && this.#s.deleteProgram(this.#P), this.#s.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#r === "active" && this.#t.style.visibility === "visible" && this.#h) {
      const s = ++this.#vt, A = new Promise((r, o) => {
        this.#he.set(s, { resolve: r, reject: o });
      });
      return this.#h.postMessage({
        type: "capture",
        id: s,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), A;
    }
    if (this.#r === "starting" || this.#r === "failed")
      return createImageBitmap(this.#e);
    const e = this.#f;
    if (this.#l && (!this.#u || this.#k || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#u || this.#k || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#je(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#fe(e.flush, e.second, null, !1) : this.#Xe(null, !1);
    const t = this.#e.videoWidth, i = this.#e.videoHeight;
    return t > 0 && i > 0 && (t !== this.#n.width || i !== this.#n.height) ? createImageBitmap(this.#n, {
      resizeWidth: t,
      resizeHeight: i,
      resizeQuality: "high"
    }) : createImageBitmap(this.#n);
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #ue() {
    this.#l || !this.#u || this.#Q.request(this.#Tt);
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
  #yt(e, t) {
    let i;
    try {
      i = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (A) {
      const r = A instanceof Error ? A.message : String(A);
      this.#I === "auto" && !this.#Ee && !this.#re ? (this.#be(), this.#ye(e, t)) : this.#ce(r);
      return;
    }
    const s = {
      id: ++this.#Et,
      frame: i,
      now: e,
      metadata: t,
      video: this.#Oe()
    };
    if (this.#ne) {
      this.#J?.frame.close(), this.#J = s;
      return;
    }
    this.#tt(s);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #tt(e) {
    const t = this.#h;
    if (!t || this.#r !== "active") {
      e.frame.close();
      return;
    }
    this.#ne = !0;
    const i = { type: "frame", ...e };
    try {
      t.postMessage(i, [e.frame]);
    } catch (s) {
      this.#ne = !1, e.frame.close();
      const A = s instanceof Error ? s.message : String(s);
      this.#I === "auto" && !this.#Ee && !this.#re ? (this.#be(), this.#ye(e.now, e.metadata)) : this.#ce(A);
    }
  }
  #Tt = (e, t) => {
    !this.#u || this.#k || (this.#pe = e, this.#j = Math.max(
      this.#j,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#it(e, t), this.#ue());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #it(e, t) {
    if (this.#me = t.mediaTime, this.#r === "active") {
      this.#yt(e, t);
      return;
    }
    this.#r !== "starting" && this.#ye(e, t);
  }
  /** @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。 */
  ingestExternalFrame(e, t, i) {
    this.#ge = i;
    try {
      this.#ye(e, t);
    } finally {
      this.#ge = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #ye(e, t) {
    if (this.#xt(t.mediaTime), t.width > 0 && t.height > 0) {
      let i = !1;
      if (!this.#Ae && this.#e.seeking) {
        const c = this.#e.buffered, g = this.#c >= j ? this.#c / 1e3 : V / 1e3;
        for (let w = 0; w < c.length; w++)
          if (t.mediaTime >= c.start(w) && t.mediaTime < c.end(w) && Math.abs(t.mediaTime - this.#e.currentTime) <= g) {
            i = !0;
            break;
          }
      }
      if (i && (this.#Ae = !0), (this.#p === 0 || this.#F === 0) && this.#ut(t.width, t.height), this.#a && !this.#a.interlaced) {
        this.#Lt();
        return;
      }
      const s = t.mediaTime - this.#se, A = t.mozTiming, r = i || (A ? A.discontinuity || s < 0 || s > te : s < 0 || s > te);
      r && (this.#o = 0, this.#c = 0, this.#b.discontinuities++, this.#i.length = 0, this.#y());
      const o = this.#m && this.#H !== 0 && t.presentedFrames - this.#H > 1;
      if (this.#Pt(t.presentedFrames, r), !r && o && (this.#o = 0, this.#y()), this.#o > 0 && t.mediaTime === this.#se && (!t.mozTiming || t.presentedFrames === this.#Pe))
        return;
      if (!r) {
        const c = A?.periodMs ?? 0;
        c > 0 ? this.#st(
          c * (this.#e.playbackRate || 1) / 1e3
        ) : s > 0 && this.#st(s);
      }
      this.#se = t.mediaTime, this.#Pe = t.presentedFrames;
      const n = performance.now();
      n - this.#We > ie && (this.#ve = n, this.#O = 0, this.#oe = 0, this.#ae = 0, this.#le = 0, this.#q = 0, this.#z = 0), this.#We = n;
      const a = performance.now();
      this.#ct();
      const h = this.#B, d = this.#m && this.#o === b && this.#Mt();
      if (h !== this.#B && (this.#i.length = 0), !(d && this.#Te())) if (this.#m && !this.#Se && this.#B === "film")
        if (this.#Te()) {
          const c = this.#c * 5 / 4, g = this.#nt(1, e, c), w = this.#i.at(-1), p = g ? e : w == null ? e + c : w.at + w.duration;
          this.#Ft(p, c);
        } else
          this.#Xe(null);
      else if (this.#S && this.#Te()) {
        const c = this.#c / 2, g = this.#nt(2, e, c), w = this.#i.at(-1), p = g ? e : w == null ? e + c * 2 : w.at + w.duration;
        this.#rt(!1, p, c), this.#rt(!0, p + c, c);
      } else
        this.#b.late += this.#i.length, this.#i.length = 0, this.#fe(!1, !1, null);
      this.#q = Math.max(
        this.#q,
        this.#i.length
      ), this.#oe += performance.now() - a, this.#O++, this.#Bt(n);
    }
  }
  #xt(e) {
    let t;
    for (let A = this.#V.length - 1; A >= 0; A--) {
      const r = this.#V[A];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#p || t.codedSize.height !== this.#F) && this.#ut(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#a?.interlaced === i.interlaced && this.#a.topFieldFirst === i.topFieldFirst)
      return;
    const s = this.#a?.interlaced;
    this.#a = i, this.#o = 0, this.#i.length = 0, this.#y(), s !== i.interlaced && (this.#c = 0), i.interlaced && (this.#l || this.#r === "main") ? this.#K() : this.#Ze();
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #Te() {
    return (this.#S || this.#m) && this.#c > 0 && this.#D.length === C;
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
  #st(e) {
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#c > 0 ? Math.max(1, Math.round(t / this.#c)) : 1, s = t / i;
    s < j || s > V || (this.#c = this.#c > 0 ? this.#c + (s - this.#c) * be : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #At() {
    if (this.#E && this.#v && this.#P) return;
    const e = this.#s, t = W(e, de), i = W(e, me), s = W(e, pe);
    this.#E = t, this.#M = Object.fromEntries(
      Object.entries(Q).filter(([A]) => A !== "match" && A !== "topFieldFirst").map(([A, r]) => [A, e.getUniformLocation(t, r)])
    ), this.#v = i, this.#L = Object.fromEntries(
      Object.entries(Q).map(([A, r]) => [
        A,
        e.getUniformLocation(i, r)
      ])
    ), this.#P = s, this.#ee = Object.fromEntries(
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
  #Mt() {
    const e = this.#N, t = this.#E, i = this.#M, s = this.#P, A = this.#ee;
    if (!e || !t || !i || !s || !A)
      return !1;
    const r = this.#s, o = this.#g, n = (this.#g + b - 1) % b, a = (this.#g + 1) % b, h = this.#De;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [p, v] of [a, n, o].entries())
      r.activeTexture(r.TEXTURE0 + p), r.bindTexture(r.TEXTURE_2D, this.#R[v] ?? null);
    r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#p, this.#F), r.viewport(0, 0, x, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      x,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: d, currentLuma: u, nextLuma: f } = e;
    for (let p = 0; p < d.length; p++) {
      const v = p * 4;
      d[p] = e.pixels[v] ?? 0, u[p] = e.pixels[v + 1] ?? 0, f[p] = e.pixels[v + 2] ?? 0;
    }
    const c = this.#ke.fieldMatch(
      d,
      u,
      f,
      h,
      this.#Z
    );
    r.useProgram(s), r.uniform1i(A.prev, 0), r.uniform1i(A.cur, 1), r.uniform1i(A.next, 2), r.uniform2i(A.size, this.#p, this.#F), r.uniform1i(A.topFieldFirst, h ? 1 : 0), r.uniform1i(
      A.match,
      c.match === "p" ? 0 : c.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      x,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const g = this.#ke.decimate(e.pixels);
    this.#ie = c.match, this.#Re = c.combScore, this.#Se = c.isCombed, this.#Ce = g.lowestCycleDifference, this.#Le = g.runnerUpCycleDifference;
    const w = g.dropIndex !== null && !c.isCombed;
    return (w ? "film" : "video") !== this.#B && (this.#B = w ? "film" : "video"), g.shouldDrop && !c.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Ft(e, t) {
    const i = this.#Ye();
    if (i === null) return;
    const s = this.#D[i];
    if (s) {
      for (this.#te = i; this.#i.length > 0 && this.#i[0]?.slot === i; )
        this.#i.shift(), this.#b.late++;
      this.#Xe(s.framebuffer), this.#i.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Xe(e, t = !0) {
    const i = this.#v, s = this.#L;
    if (!i || !s) return;
    const A = this.#s, r = this.#g, o = (this.#g + b - 1) % b, n = (this.#g + 1) % b, a = this.#De;
    A.bindFramebuffer(A.FRAMEBUFFER, e), A.useProgram(i);
    for (const [h, d] of [n, o, r].entries())
      A.activeTexture(A.TEXTURE0 + h), A.bindTexture(A.TEXTURE_2D, this.#R[d] ?? null);
    A.uniform1i(s.prev, 0), A.uniform1i(s.cur, 1), A.uniform1i(s.next, 2), A.uniform2i(s.size, this.#p, this.#F), A.uniform1i(s.topFieldFirst, a ? 1 : 0), A.uniform1i(
      s.match,
      this.#ie === "p" ? 0 : this.#ie === "c" ? 1 : 2
    ), A.viewport(0, 0, this.#p, this.#F), A.drawArrays(A.TRIANGLES, 0, 3), e === null && (this.#f = { kind: "film" }, this.#C(!0), t && this.#z++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #rt(e, t, i) {
    const s = this.#Ye();
    if (s === null) return;
    const A = this.#D[s];
    if (A) {
      for (this.#te = s; this.#i.length > 0 && this.#i[0]?.slot === s; )
        this.#i.shift(), this.#b.late++;
      this.#fe(!1, e, A.framebuffer), this.#i.push({ slot: s, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #nt(e, t, i) {
    const s = this.#i.at(-1), A = (q + 1) * Math.max(this.#X, i);
    if (s && s.at - t > A)
      return this.#i.length = 0, this.#b.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#i.length + e - q
    );
    let o = 0, n = 0;
    for (; n < r; ) {
      const a = this.#i.shift();
      if (!a) break;
      o += a.duration, n++;
    }
    for (const a of this.#i) a.at -= o;
    return this.#b.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Ye() {
    const e = this.#f?.kind === "texture" ? this.#f.texture : null, t = new Set(this.#i.map(({ slot: s }) => s));
    for (let s = 1; s <= C; s++) {
      const A = (this.#te + s) % C, r = this.#D[A];
      if (r && r.texture !== e && !t.has(A))
        return A;
    }
    const i = this.#i[0];
    if (i) {
      const s = this.#D[i.slot];
      if (s && s.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #K() {
    this.#G === null && (!this.#u || this.#k || (this.#de = 0, this.#G = this.#ot(this.#ht)));
  }
  #Ze() {
    this.#G !== null && this.#Rt(this.#G), this.#G = null, this.#i.length = 0;
  }
  #ht = (e) => {
    if (this.#G = null, !(!this.#u || this.#k)) {
      if (this.#de > 0) {
        const t = e - this.#de;
        t >= 1 && t <= V && (this.#X = t < this.#X ? t : this.#X + (t - this.#X) * Te);
      }
      this.#de = e, this.#r === "main" && this.#Ct(e), this.#G = this.#ot(this.#ht);
    }
  };
  /** ページと Worker のそれぞれが所有する requestAnimationFrame() へ表示ループを委ねる。 */
  #ot(e) {
    return this.#l ? this.#l.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #Rt(e) {
    this.#l ? this.#l.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #Qe() {
    this.#l || this.#W !== null || !this.#u || this.#k || (this.#W = requestAnimationFrame(this.#at));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #St() {
    this.#W !== null && cancelAnimationFrame(this.#W), this.#W = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #at = (e) => {
    this.#W = null, !(!this.#u || this.#k) && (this.#kt(e), this.#W = requestAnimationFrame(this.#at));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #kt(e) {
    if (this.#l || this.#Q.mozDriven && this.#Q.hasDelivered || e - this.#pe < xe || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#c >= j ? this.#c : Me, A = i > this.#j, r = t !== this.#me && e - this.#Be >= s * 0.75;
    !A && !r || (this.#j = Math.max(
      this.#j,
      i
    ), this.#Be = e, this.#it(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#H + 1, i),
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
    const t = e + this.#X * 1.5;
    for (; this.#i[1] && this.#i[1].at <= t; )
      this.#b.late++, this.#i.shift();
    let i = this.#i[0];
    if (!i || i.at > t)
      return;
    this.#i.shift();
    const s = performance.now();
    this.#lt(i.slot), this.#le += performance.now() - s, this.#ae++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #lt(e) {
    const t = this.#D[e];
    t && this.#je(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Lt() {
    this.#ct();
    const e = this.#R[this.#g];
    e && this.#je(e, !0), this.#o = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #C(e) {
    if (this.#l) {
      this.#l.onVisibility(e);
      return;
    }
    this.#t.style.visibility = e ? "visible" : "hidden";
  }
  #je(e, t = !1, i = !0) {
    const s = this.#s;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#w), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#T, 0), s.uniform1i(this.#x, t ? 1 : 0), s.viewport(0, 0, this.#p, this.#F), s.drawArrays(s.TRIANGLES, 0, 3), this.#f = { kind: "texture", texture: e, flip: t }, this.#C(!0), i && this.#z++;
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
  #Pt(e, t) {
    this.#H !== 0 && !t && (this.#b.missed += Math.max(0, e - this.#H - 1)), this.#H = e;
  }
  #Bt(e) {
    const t = e - this.#ve;
    if (t < ie) return;
    const i = this.#Te() && (this.#S || this.#B === "film") ? this.#ae : this.#O, s = {
      ...this.#b,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#O === 0 ? 0 : (this.#oe + this.#le) / this.#O,
      maxQueuedFields: this.#q,
      mode: this.#B,
      match: this.#ie,
      combScore: this.#Re,
      outputFps: this.#z * 1e3 / t,
      duplicateScore: this.#Ce,
      duplicateRunnerUp: this.#Le
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#_e?.(s), this.#ve = e, this.#O = 0, this.#oe = 0, this.#ae = 0, this.#le = 0, this.#q = 0, this.#z = 0;
  }
  /** Take the newest frame into the ring. */
  #ct() {
    const e = this.#s;
    this.#g = (this.#g + 1) % b, e.bindTexture(e.TEXTURE_2D, this.#R[this.#g] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#ge
    ), this.#o = Math.min(this.#o + 1, b);
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
  #fe(e, t, i, s = !0) {
    if (this.#o === 0 || this.#k) return;
    s && (this.#o === b && !e ? this.#b.filtered++ : this.#b.degraded++);
    const A = this.#s, r = this.#g, o = (this.#g + b - 1) % b, n = (this.#g + 1) % b;
    let a, h, d;
    this.#o === 1 ? a = h = d = r : e ? (a = o, h = d = r) : this.#o === 2 ? (a = h = o, d = r) : (a = n, h = o, d = r), A.bindFramebuffer(A.FRAMEBUFFER, i), A.useProgram(this.#d);
    for (const [f, c] of [a, h, d].entries())
      A.activeTexture(A.TEXTURE0 + f), A.bindTexture(A.TEXTURE_2D, this.#R[c] ?? null);
    A.uniform1i(this.#A.prev, 0), A.uniform1i(this.#A.cur, 1), A.uniform1i(this.#A.next, 2), A.uniform2i(this.#A.size, this.#p, this.#F);
    const u = this.#De ? 0 : 1;
    A.uniform1i(this.#A.parity, t ? 1 - u : u), A.uniform1i(this.#A.tff, this.#De ? 1 : 0), A.uniform1i(this.#A.spatialCheck, this.#Fe ? 1 : 0), A.viewport(0, 0, this.#p, this.#F), A.drawArrays(A.TRIANGLES, 0, 3), i === null && (this.#f = { kind: "yadif", flush: e, second: t }, this.#C(!0), s && this.#z++);
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
  #xe() {
    if (!this.#Y) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const s = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), A = t * s, r = i * s;
    this.#t.style.left = `${e.offsetLeft + (e.offsetWidth - A) / 2}px`, this.#t.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#t.style.width = `${A}px`, this.#t.style.height = `${r}px`;
  }
  #ut(e, t) {
    const i = this.#s;
    this.#n.width = e, this.#n.height = t, this.#p = e, this.#F = t, this.#o = 0, this.#f = null, this.#y(), this.#xe();
    for (const s of this.#R) i.deleteTexture(s);
    this.#R = [];
    for (let s = 0; s < b; s++) {
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
      ), this.#R.push(A);
    }
    this.#$(), this.#Ve(), this.#m && this.#ft(), (this.#S || this.#m) && this.#Je();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #ft() {
    if (this.#N) return;
    const e = this.#s, t = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
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
    this.#N = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(x * M * 4),
      previousLuma: new Uint8Array(x * M),
      currentLuma: new Uint8Array(x * M),
      nextLuma: new Uint8Array(x * M)
    };
  }
  #Ve() {
    this.#N && (this.#s.deleteFramebuffer(this.#N.framebuffer), this.#s.deleteTexture(this.#N.texture), this.#N = null);
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
  #Je() {
    const e = this.#s;
    if (!(this.#D.length === C || this.#p === 0)) {
      this.#$();
      for (let t = 0; t < C; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#p,
          this.#F,
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
          e.deleteFramebuffer(s), e.deleteTexture(i), this.#$();
          return;
        }
        this.#D.push({ texture: i, framebuffer: s });
      }
      this.#te = C - 1;
    }
  }
  #$() {
    const e = this.#s, t = this.#f?.kind === "texture" ? this.#f.texture : null;
    this.#D.some((i) => i.texture === t) && (this.#f = null);
    for (const { texture: i, framebuffer: s } of this.#D)
      e.deleteFramebuffer(s), e.deleteTexture(i);
    this.#D = [], this.#i.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #It() {
    if (this.#Y) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#t), this.#Y = t, this.#Me?.observe(this.#e), this.#xe();
  }
  #_t() {
    if (this.#l) return;
    const e = this.#Y;
    this.#Y = null, this.#Me?.disconnect(), this.#t.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #dt = () => this.#xe();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #qe(e) {
    return !this.#h || this.#r === "main" ? !1 : (this.#h.postMessage({
      type: "event",
      name: e,
      video: this.#Oe()
    }), !0);
  }
  #mt = () => {
    if (this.#me = Number.NaN, this.#qe("emptied")) {
      this.#_(), this.#C(!1);
      return;
    }
    this.#o = 0, this.#se = 0, this.#Pe = 0, this.#i.length = 0, this.#c = 0, this.#pt(), this.#y(), this.#f = null, this.#C(!1);
  };
  #pt() {
    this.#b = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#H = 0, this.#ve = 0, this.#We = 0, this.#O = 0, this.#oe = 0, this.#ae = 0, this.#le = 0, this.#q = 0, this.#z = 0, this.#y();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #y() {
    this.#i.length = 0, this.#B = "video", this.#ie = "c", this.#Re = 0, this.#Se = !0, this.#ke.reset(), this.#Ce = 1 / 0, this.#Le = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #wt = () => {
    if (this.#qe("seeking")) {
      this.#_();
      return;
    }
    this.#Ae = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #U = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#qe(e.type)) {
      this.#_();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#Ae;
      if (this.#Ae = !1, i) return;
      this.#o = 0, this.#y(), this.#f = null, this.#C(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#c = 0, this.#se = this.#e.currentTime), this.#i.length = 0, this.#u && this.#o > 0) {
      const i = this.#Ye(), s = i === null ? void 0 : this.#D[i];
      i !== null && s ? (this.#te = i, this.#fe(!0, !1, s.framebuffer), this.#lt(i)) : this.#fe(!0, !1, null);
    }
    t && (this.#o = 0, this.#y());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #gt = (e) => {
    if (e.preventDefault(), this.#l) {
      this.#l.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#r !== "active" && (this.#k = !0, this.stop());
  };
}
function W(l, e) {
  const t = l.createProgram(), i = Ae(l, l.VERTEX_SHADER, Fe), s = Ae(l, l.FRAGMENT_SHADER, e);
  if (l.attachShader(t, i), l.attachShader(t, s), l.linkProgram(t), l.deleteShader(i), l.deleteShader(s), !l.getProgramParameter(t, l.LINK_STATUS)) {
    const A = l.getProgramInfoLog(t);
    throw l.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${A ?? "no reason given"}`
    );
  }
  return t;
}
function Ae(l, e, t) {
  const i = l.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (l.shaderSource(i, t), l.compileShader(i), !l.getShaderParameter(i, l.COMPILE_STATUS)) {
    const s = l.getShaderInfoLog(i);
    throw l.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return i;
}
const re = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Se = 0.5, ke = 3e3, ne = 0.1, I = 16, he = 'video/mp4; codecs="avc1.640029"';
let K = null;
function Ce(l = {}) {
  return K ??= Le(l), K;
}
async function Ge(l = {}) {
  return (await Ce(l)).deinterlaces;
}
function We() {
  K = null;
}
async function Le(l) {
  const e = l.tolerance ?? Se, t = l.timeoutMs ?? ke, i = performance.now(), s = (o) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: o instanceof Error ? o.message : String(o)
  });
  if (typeof document > "u")
    return s(new Error("there is no document to decode in"));
  const A = document.createElement("video");
  A.muted = !0, A.defaultMuted = !0, A.playsInline = !0, A.preload = "auto";
  let r = null;
  try {
    r = Be(A, t);
    const o = O(H(A, "loadeddata"), t), n = A.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await o, await Ie(A, t, await n), A.videoWidth === 0 || A.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const a = _e(A);
    return {
      deinterlaces: a < 1 - e,
      survives: a,
      tookMs: performance.now() - i
    };
  } catch (o) {
    return s(o);
  } finally {
    A.pause(), A.removeAttribute("src"), A.replaceChildren(), A.load(), r && URL.revokeObjectURL(r.url);
  }
}
const J = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Pe = typeof MediaSource > "u";
function Be(l, e) {
  if (!J || !J.isTypeSupported(he))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = re.indexOf(","), i = atob(re.slice(t + 1)), s = new Uint8Array(i.length);
  for (let n = 0; n < i.length; n++) s[n] = i.charCodeAt(n);
  const A = new J(), r = URL.createObjectURL(A);
  if (Pe) {
    l.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, l.append(n), l.load();
  } else
    l.src = r;
  const o = (async () => {
    await O(H(A, "sourceopen"), e);
    const n = A.addSourceBuffer(he), a = O(H(n, "updateend"), e);
    n.appendBuffer(s), await a, A.endOfStream();
  })();
  return { url: r, ready: o };
}
async function Ie(l, e, t) {
  if (t) {
    const i = performance.now();
    for (; l.currentTime < ne && performance.now() - i < e; )
      await new Promise((s) => requestAnimationFrame(s));
    l.pause();
  } else
    l.currentTime = ne, await O(H(l, "seeked"), e);
}
function _e(l) {
  const e = l.videoHeight, t = document.createElement("canvas");
  t.width = I, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(l, 0, 0, I, e);
  const s = i.getImageData(0, 0, I, e).data, A = (h) => {
    let d = 0;
    for (let u = 0; u < I; u++)
      d += s[(h * I + u) * 4 + 1] ?? 0;
    return d / I;
  };
  let r = 0;
  const o = 2, n = e - 3;
  let a = A(o);
  for (let h = o + 1; h <= n; h++) {
    const d = A(h);
    r += Math.abs(d - a), a = d;
  }
  return r / (n - o) / 255;
}
function H(l, e) {
  return new Promise((t, i) => {
    l.addEventListener(e, () => t(), { once: !0 }), l.addEventListener(
      "error",
      () => {
        const s = l instanceof HTMLMediaElement ? l.error : null, A = s ? ` (MediaError ${s.code}${s.message ? `: ${s.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${A}`));
      },
      { once: !0 }
    );
  });
}
function O(l, e) {
  return Promise.race([
    l,
    new Promise(
      (t, i) => setTimeout(
        () => i(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
De(ce);
export {
  Ne as Deinterlacer,
  de as FILM_ANALYSIS_FRAGMENT_SHADER,
  pe as FILM_SAMPLE_FRAGMENT_SHADER,
  Q as FILM_UNIFORMS,
  me as FILM_WEAVE_FRAGMENT_SHADER,
  fe as YADIF_FRAGMENT_SHADER,
  ue as YADIF_UNIFORMS,
  Ge as decoderDeinterlaces,
  We as forgetDecoderProbe,
  Ce as probeDecoder,
  Ue as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
