const le = "" + new URL("assets/worker-3fixTBSc.js", import.meta.url).href, ce = {
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
`, Q = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  topFieldFirst: "uTopFieldFirst",
  match: "uMatch"
}, x = 288, M = 162, fe = `#version 300 es
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
  #n;
  #t;
  #e;
  #s = 0;
  #d = null;
  #A = [];
  #m = null;
  #T = 1 / 0;
  #x = 1 / 0;
  constructor(e, t) {
    this.#n = e, this.#t = t, this.#e = 255 * b.DECIMATE_BLOCK ** 2 * b.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, s, A = b.COMBED_PIXEL_LIMIT) {
    const r = s ? 1 : 0, h = { p: e, c: t, n: i };
    let n = this.#p("c", "p", r, h);
    const a = /* @__PURE__ */ new Map(), o = (p) => {
      const g = a.get(p);
      if (g !== void 0) return g;
      const w = b.#v(
        this.weave(e, t, i, p, s),
        this.#n,
        this.#t
      );
      return a.set(p, w), w;
    }, f = o(n), u = o("n");
    (u * 3 < f || u * 2 < f && f > A) && Math.abs(u - f) >= 30 && u < A && (n = "n");
    const c = o(n), d = c >= A;
    return d && (n = "c"), {
      match: n,
      combScore: c,
      isCombed: d,
      luma: this.weave(e, t, i, n, s)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#s, i = this.#m ? b.#U(
      this.#m,
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
    this.#m = e.slice(), this.#s++;
    let h = this.#d;
    if (this.#s === b.CYCLE) {
      let n = 0, a = null;
      for (let o = 1; o < this.#A.length; o++)
        (this.#A[o]?.maxBlockDifference ?? 1 / 0) < (this.#A[n]?.maxBlockDifference ?? 1 / 0) ? (a = n, n = o) : (a === null || (this.#A[o]?.maxBlockDifference ?? 1 / 0) < (this.#A[a]?.maxBlockDifference ?? 1 / 0)) && (a = o);
      this.#T = this.#A[n]?.maxBlockDifference ?? 1 / 0, this.#x = a === null ? 1 / 0 : this.#A[a]?.maxBlockDifference ?? 1 / 0, h = (this.#A[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#d = h, this.#A = [], this.#s = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: A,
      dropIndex: r,
      nextDropIndex: h,
      lowestCycleDifference: this.#T,
      runnerUpCycleDifference: this.#x
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, s, A) {
    if (s === "c") return t.slice();
    const r = t.slice(), h = s === "p" ? e : i, n = r.length / this.#t, a = A ? 1 : 0;
    for (let o = a; o < this.#t; o += 2)
      r.set(
        h.subarray(o * n, (o + 1) * n),
        o * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#s = 0, this.#d = null, this.#A = [], this.#m = null, this.#T = 1 / 0, this.#x = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #p(e, t, i, s) {
    const A = this.#n, r = this.#t, h = 2 - i, n = 2 - i, a = s[e], o = s[t], f = b.#C(
      a,
      o,
      A,
      r,
      i
    );
    let u = 0, c = 0, d = 0, p = 0, g = 0, w = 0;
    for (let S = 2; S < r - 2; S += 2) {
      const y = (S - 2) / 2, X = h - 1 + y * 2, Y = h + 1 + y * 2, Z = h + 3 + y * 2, z = h + y * 2, G = z + 2, L = n + y * 2, R = L + 2, $ = h + y * 2;
      for (let T = 8; T < A - 8; T++) {
        const k = (f[$ * A + T] ?? 0) | (f[($ + 2) * A + T] ?? 0);
        if (k === 0) continue;
        const ee = (s.c[X * A + T] ?? 0) + ((s.c[Y * A + T] ?? 0) << 2) + (s.c[Z * A + T] ?? 0), B = Math.abs(
          3 * ((a[z * A + T] ?? 0) + (a[G * A + T] ?? 0)) - ee
        ), P = Math.abs(
          3 * ((o[L * A + T] ?? 0) + (o[R * A + T] ?? 0)) - ee
        );
        B > 23 && (k & 1) !== 0 && (u += B), P > 23 && (k & 1) !== 0 && (p += P), B > 42 && (k & 2) !== 0 && (c += B), P > 42 && (k & 2) !== 0 && (g += P), B > 42 && (k & 4) !== 0 && (d += B), P > 42 && (k & 4) !== 0 && (w += P);
      }
    }
    c < 500 && g < 500 && (d >= 500 || w >= 500) && Math.max(d, w) > 3 * Math.min(d, w) && (c = d, g = w);
    const v = Math.floor(u / 6 + 0.5), F = Math.floor(p / 6 + 0.5), E = Math.floor(c / 6 + 0.5), m = Math.floor(g / 6 + 0.5), _ = Math.max(v, F) / Math.max(Math.min(v, F), 1), U = Math.max(E, m) / Math.max(Math.min(E, m), 1), N = Math.max(E, m) / Math.max(Math.max(v, F), 1);
    return (E >= 500 || m >= 500) && (E * 2 < m || m * 2 < E) || (E >= 1e3 || m >= 1e3) && (E * 3 < m * 2 || m * 3 < E * 2) || (E >= 2e3 || m >= 2e3) && (E * 5 < m * 4 || m * 5 < E * 4) || (E >= 4e3 || m >= 4e3) && U > _ || N > 5e-3 && Math.max(E, m) > 150 && (E * 2 < m || m * 2 < E) ? E > m ? t : e : v > F ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #C(e, t, i, s, A) {
    const r = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(i)
    ), h = A === 1 ? 1 : 0;
    for (let o = 0; o < r.length; o++) {
      const f = Math.min(s - 1, h + o * 2), u = r[o];
      if (u)
        for (let c = 0; c < i; c++)
          u[c] = Math.abs(
            (e[f * i + c] ?? 0) - (t[f * i + c] ?? 0)
          );
    }
    const n = new Uint8Array(i * s), a = A === 1 ? 3 : 2;
    for (let o = 1; o < r.length - 1; o++) {
      const f = a + (o - 1) * 2;
      if (f >= s) break;
      const u = r[o];
      if (u)
        for (let c = 1; c < i - 1; c++) {
          const d = u[c] ?? 0;
          if (d <= 3) continue;
          let p = 0;
          for (let m = c - 1; m <= c + 1; m++)
            p += (r[o - 1]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[o]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[o + 1]?.[m] ?? 0) > 3 ? 1 : 0;
          if (p <= 1) continue;
          const g = f * i + c;
          if (n[g] = 1, d <= 19) continue;
          p = 0;
          let w = !1, v = !1;
          for (let m = c - 1; m <= c + 1; m++)
            (r[o - 1]?.[m] ?? 0) > 19 && (p++, w = !0), (r[o]?.[m] ?? 0) > 19 && p++, (r[o + 1]?.[m] ?? 0) > 19 && (p++, v = !0);
          if (p <= 3) continue;
          if (w && v) {
            n[g] |= 2;
            continue;
          }
          let F = !1, E = !1;
          for (let m = Math.max(c - 4, 0); m < Math.min(c + 5, i); m++)
            o !== 1 && (r[o - 2]?.[m] ?? 0) > 19 && (F = !0), (r[o - 1]?.[m] ?? 0) > 19 && (w = !0), (r[o + 1]?.[m] ?? 0) > 19 && (v = !0), o !== r.length - 2 && (r[o + 2]?.[m] ?? 0) > 19 && (E = !0);
          w && (v || F) || v && (w || E) ? n[g] |= 2 : p > 5 && (n[g] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #v(e, t, i) {
    const s = new Uint8Array(t * i), A = (h, n) => e[Math.max(0, Math.min(i - 1, n)) * t + h] ?? 0;
    for (let h = 0; h < i; h++)
      for (let n = 0; n < t; n++) {
        const a = A(n, h), o = A(n, h === 0 ? 1 : h - 1), f = A(n, h === i - 1 ? i - 2 : h + 1), u = h < 2 ? A(n, h === 0 ? 2 : 3) : A(n, h - 2), c = h + 2 >= i ? A(n, h === i - 1 ? i - 3 : i - 4) : A(n, h + 2);
        (h === 0 ? Math.abs(a - f) > b.COMB_THRESHOLD : h === i - 1 ? Math.abs(a - o) > b.COMB_THRESHOLD : Math.abs(a - o) > b.COMB_THRESHOLD && Math.abs(a - f) > b.COMB_THRESHOLD) && Math.abs(
          4 * a - 3 * (o + f) + u + c
        ) > b.COMB_THRESHOLD * 6 && (s[h * t + n] = 255);
      }
    let r = 0;
    for (const h of [0, 8])
      for (const n of [0, 8])
        for (let a = h; a < i; a += 16)
          for (let o = n; o < t; o += 16) {
            let f = 0;
            for (let u = Math.max(1, a); u < Math.min(i - 1, a + 16); u++)
              for (let c = o; c < Math.min(t, o + 16); c++) {
                const d = u * t + c;
                s[d - t] === 255 && s[d] === 255 && s[d + t] === 255 && f++;
              }
            r = Math.max(r, f);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #U(e, t, i, s) {
    const A = b.DECIMATE_BLOCK / 2, r = Math.ceil(i / A), h = Math.ceil(s / A), n = new Float64Array(r * h), a = e.length / (i * s);
    for (let u = 0; u < s; u++) {
      const c = Math.floor(u / A);
      for (let d = 0; d < i; d++) {
        const p = Math.floor(d / A), g = c * r + p, w = (u * i + d) * a;
        if (a === 1) {
          n[g] = (n[g] ?? 0) + Math.abs((e[w] ?? 0) - (t[w] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[w] ?? 0) * 0.2126 + (e[w + 1] ?? 0) * 0.7152 + (e[w + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (t[w] ?? 0) * 0.2126 + (t[w + 1] ?? 0) * 0.7152 + (t[w + 2] ?? 0) * 0.0722
        );
        if (n[g] = (n[g] ?? 0) + Math.abs(v - F), (d & 1) !== 0 || (u & 1) !== 0) continue;
        let E = 0, m = 0, _ = 0, U = 0, N = 0, S = 0, y = 0;
        for (let G = u; G < Math.min(u + 2, s); G++)
          for (let L = d; L < Math.min(d + 2, i); L++) {
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
        n[g] = (n[g] ?? 0) + Math.abs(X - Y) + Math.abs(Z - z);
      }
    }
    let o = -1;
    for (let u = 0; u < h - 1; u++)
      for (let c = 0; c < r - 1; c++)
        o = Math.max(
          o,
          (n[u * r + c] ?? 0) + (n[u * r + c + 1] ?? 0) + (n[(u + 1) * r + c] ?? 0) + (n[(u + 1) * r + c + 1] ?? 0)
        );
    let f = 0;
    for (const u of n) f += u;
    return { maxBlockDifference: o, totalDifference: f };
  }
}
const he = [
  "mozParsedFrames",
  "mozDecodedFrames",
  "mozPresentedFrames",
  "mozPaintedFrames"
];
function oe(l) {
  return he.every((e) => e in l);
}
function pe() {
  return typeof HTMLVideoElement < "u" && (oe(HTMLVideoElement.prototype) || typeof HTMLVideoElement.prototype.requestVideoFrameCallback == "function");
}
const we = 250, ge = 500;
class Ee {
  #n;
  #t;
  #e = null;
  #s = null;
  #d = null;
  #A = null;
  #m = !0;
  #T = null;
  #x = null;
  #p = 0;
  constructor(e) {
    if (this.#n = e, this.#t = oe(e) ? e : null, this.#t) {
      for (const t of ["emptied", "seeking", "seeked"])
        e.addEventListener(t, this.#v);
      for (const t of ["pause", "playing", "waiting", "ratechange"])
        e.addEventListener(t, this.#C);
    }
  }
  request(e) {
    this.#e === null && (this.#s = e, this.#e = this.#t ? requestAnimationFrame(this.#L) : this.#n.requestVideoFrameCallback(this.#U));
  }
  cancel() {
    this.#e !== null && (this.#t ? cancelAnimationFrame(this.#e) : this.#n.cancelVideoFrameCallback(this.#e)), this.#e = null, this.#s = null, this.#v();
  }
  destroy() {
    this.cancel();
    for (const e of ["emptied", "seeking", "seeked"])
      this.#n.removeEventListener(e, this.#v);
    for (const e of ["pause", "playing", "waiting", "ratechange"])
      this.#n.removeEventListener(e, this.#C);
  }
  #C = () => {
    this.#T = null, this.#x = null, this.#p = 0;
  };
  #v = () => {
    this.#d = null, this.#A = null, this.#m = !0, this.#C();
  };
  #U = (e, t) => {
    const i = this.#s;
    this.#e = null, this.#s = null, i?.(e, t);
  };
  #L = (e) => {
    const t = this.#t, i = he.map((h) => t[h]);
    this.#d?.some((h, n) => i[n] < h) && this.#v(), this.#d = i;
    const s = t.mozPaintedFrames, A = !t.seeking && t.readyState >= 2 && t.videoWidth > 0 && t.videoHeight > 0, r = this.#A === null && (s > 0 || t.paused && (t.mozPresentedFrames > 0 || t.mozDecodedFrames > 0));
    if (A && (r || this.#A !== null && s !== this.#A)) {
      if (this.#T !== null && e - this.#T > ge && (this.#C(), this.#m = !0), !t.paused && !t.ended) {
        const n = this.#x;
        if (n && e - n.at >= we) {
          const a = s - n.frames, o = (e - n.at) / a;
          a > 0 && o >= 4 && o <= 200 && (this.#p = this.#p ? this.#p + (o - this.#p) * 0.25 : o), this.#x = null;
        }
        this.#x ??= { at: e, frames: s };
      }
      this.#T = e, this.#A = s;
      const h = this.#m;
      this.#m = !1, this.#U(e, {
        width: t.videoWidth,
        height: t.videoHeight,
        // Used only to select source scan/size metadata on the media timeline.
        // It is deliberately NOT used as the frame identity or field clock.
        mediaTime: t.currentTime,
        presentedFrames: s,
        expectedDisplayTime: e,
        mozTiming: { periodMs: this.#p, discontinuity: h }
      });
    } else
      this.#e = requestAnimationFrame(this.#L);
  };
}
let ae = null;
function ve(l) {
  ae = l;
}
const be = 0.5, D = 3, q = 5, C = q + 1, te = 1e3, j = 4, V = 200, De = 0.25, ye = 1e3 / 60, Te = 0.02, xe = 250, Me = 1e3 / 30;
function ie(l) {
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
  return pe() && typeof WebGL2RenderingContext < "u";
}
class Ne extends EventTarget {
  #n;
  #t;
  #e;
  #s;
  #d;
  #A;
  /** The program that copies a filtered picture onto the canvas. */
  #m;
  #T;
  #x;
  /** The reduced pass that reads previous, current and next luma together. */
  #p = null;
  #C = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #v = null;
  #U = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #L = null;
  #Je = null;
  #N = null;
  #F = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #b = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #$ = C - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #f = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #i = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #G = null;
  #ue = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #W = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #X = ye;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #Y = null;
  #xe;
  #R;
  #w;
  #Z;
  #Me;
  #B = "video";
  #ee = "c";
  #Fe = 0;
  #Re = !0;
  #Se = new b(x, M);
  #ke = 1 / 0;
  #Ce = 1 / 0;
  #z = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #c = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #g = 0;
  #M = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #E = D - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #o = 0;
  #te = 0;
  #fe = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #ie = !1;
  #de;
  /** 最終通知時刻。rVFC と Firefox カウンターのどちらの取得経路でも更新する。 */
  #me = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #Q = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #Le = 0;
  #u = !1;
  #pe = !1;
  #Be = !1;
  #a = null;
  #j = [];
  #S = !1;
  #Pe;
  #l;
  #we;
  #P;
  #Ie;
  #h = null;
  #r;
  #se = !1;
  #_e = 0;
  #Ue = !1;
  #wt = 0;
  #Ae = !1;
  #ge = !1;
  #V = null;
  #gt = 0;
  #re = /* @__PURE__ */ new Map();
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #D = {
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
  #Ne = 0;
  #Ee = 0;
  #O = 0;
  #ne = 0;
  #he = 0;
  #oe = 0;
  #J = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#R = t.doubleRate ?? !1, this.#w = t.autoFilm ?? !1, this.#Z = ie(
      t.filmCombThreshold ?? b.COMBED_PIXEL_LIMIT
    ), this.#Me = t.spatialCheck ?? !0, this.#Pe = t.onStats, this.#l = i, this.#P = i ? "main" : t.rendering ?? "auto", this.#Ie = t.workerUrl ?? ae, this.#r = this.#P === "main" ? "main" : "idle", this.#t = i ? i.canvas : document.createElement("canvas"), this.#n = i?.canvas ?? (this.#P === "main" ? this.#t : document.createElement("canvas")), this.#we = e, i || (this.#t.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const s = this.#n.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!s) throw new Error("this browser has no WebGL2");
    this.#s = s, this.#d = W(s, ue);
    const A = this.#d;
    this.#A = Object.fromEntries(
      Object.entries(ce).map(([r, h]) => [
        r,
        s.getUniformLocation(A, h)
      ])
    ), this.#m = W(s, Re), this.#T = s.getUniformLocation(this.#m, "uField"), this.#x = s.getUniformLocation(this.#m, "uFlip"), this.#w && this.#it(), this.#n.addEventListener(
      "webglcontextlost",
      this.#pt
    ), this.#xe = i ? null : new ResizeObserver(() => this.#Te()), this.#de = new Ee(e), e.addEventListener("emptied", this.#ft), e.addEventListener("resize", this.#ut), e.addEventListener("pause", this.#_), e.addEventListener("ended", this.#_), e.addEventListener("seeking", this.#mt), e.addEventListener("seeked", this.#_), e.addEventListener("ratechange", this.#_);
  }
  get running() {
    return this.#u && (this.#a?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#t;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #ve() {
    return this.#a?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #qe() {
    return {
      doubleRate: this.#R,
      autoFilm: this.#w,
      filmCombThreshold: this.#Z,
      spatialCheck: this.#Me
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#pe;
  }
  set enabled(e) {
    this.#pe = e, this.#We(), this.#h?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#a?.interlaced !== e?.interlaced, i = t || this.#a?.topFieldFirst !== e?.topFieldFirst;
    this.#a = e, this.#h?.postMessage({ type: "scan", scan: e }), i && (this.#o = 0, this.#y(), t && (this.#c = 0), this.#f = null, this.#k(!1)), this.#We(), i && ((e?.interlaced ?? !0) && (this.#l || this.#r === "main") ? this.#q() : this.#Xe());
  }
  get scan() {
    return this.#a;
  }
  set videoTimeline(e) {
    this.#j = e, this.#h?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#a = null), this.#We();
  }
  get videoTimeline() {
    return this.#j;
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
    return this.#R;
  }
  set doubleRate(e) {
    e !== this.#R && (this.#R = e, this.#Ge(), this.#i.length = 0, e ? (this.#g > 0 && this.#je(), (this.#a?.interlaced ?? !0) && (this.#l || this.#r === "main") && this.#q()) : this.#w || (this.#f = null, this.#k(!1), this.#K()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#w;
  }
  set autoFilm(e) {
    e !== this.#w && (this.#w = e, this.#Ge(), this.#y(), e ? (this.#it(), this.#g > 0 && (this.#ct(), this.#je()), (this.#a?.interlaced ?? !0) && (this.#l || this.#r === "main") && this.#q()) : (this.#Qe(), this.#R || (this.#f = null, this.#k(!1), this.#K())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#Z;
  }
  set filmCombThreshold(e) {
    const t = ie(e);
    t !== this.#Z && (this.#Z = t, this.#Ge(), this.#w && this.#y());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Ge() {
    this.#h?.postMessage({
      type: "settings",
      options: this.#qe()
    });
  }
  #We() {
    this.#pe && (this.#j.length > 0 || (this.#a?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #Et() {
    return this.#l || this.#P === "main" ? !1 : this.#r === "starting" || this.#r === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Ie !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Ke(), !0) : this.#P === "auto" ? (this.#be(), !1) : (this.#r = "failed", this.#u = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #Ke() {
    this.#I(), this.#h?.terminate(), this.#h = null, this.#Ae = !1, this.#ge = !1;
    let e = this.#t;
    if (this.#Ue) {
      e = document.createElement("canvas"), e.className = this.#t.className;
      const A = this.#t.getAttribute("style");
      A === null ? e.removeAttribute("style") : e.setAttribute("style", A), e.style.visibility = "hidden", this.#t.parentElement && this.#t.replaceWith(e), this.#t = e;
    }
    const t = ++this.#_e;
    this.#r = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#Ue = !0, i = new Worker(this.#Ie, { type: "module" });
    } catch (A) {
      this.#ae(
        A instanceof Error ? A.message : String(A)
      );
      return;
    }
    this.#h = i, i.onmessage = (A) => {
      t === this.#_e && this.#vt(A.data);
    }, i.onerror = (A) => {
      t === this.#_e && (A.preventDefault(), this.#ae(A.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#qe(),
        scan: this.#a,
        videoTimeline: this.#j,
        enabled: this.#u,
        video: this.#ze()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #vt(e) {
    switch (e.type) {
      case "ready":
        this.#r = "active", this.#u && (this.#le(), this.#Ye());
        break;
      case "failed":
        this.#ae(e.message);
        break;
      case "consumed": {
        this.#Ae = !1, this.#ge = !0;
        const t = this.#V;
        this.#V = null, t && this.#et(t);
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
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#Pe?.(t);
        break;
      }
      case "capture": {
        const t = this.#re.get(e.id);
        if (this.#re.delete(e.id), !t) {
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
    if (this.#r === "starting" && this.#P === "auto" && !this.#se) {
      this.#be();
      return;
    }
    if (this.#$e(e), !this.#se) {
      this.#se = !0, this.#Ke();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#r = "failed", this.#h?.terminate(), this.#h = null, this.#I(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #be() {
    const e = this.#n;
    e.className = this.#t.className;
    const t = this.#t.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#t.parentElement && this.#t.replaceWith(e), this.#t = e, this.#Ue = !1, this.#h?.terminate(), this.#h = null, this.#r = "main", this.#I(), this.#u && (this.#le(), this.#Ye(), (this.#a?.interlaced ?? !0) && this.#q());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #I() {
    this.#V?.frame.close(), this.#V = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #$e(e) {
    for (const t of this.#re.values())
      t.reject(new Error(e));
    this.#re.clear();
  }
  start() {
    if (!(this.#u || this.#Be || this.#S)) {
      if (this.#u = !0, this.#dt(), this.#y(), this.#me = performance.now(), this.#Le = this.#me, this.#fe = Number.NaN, this.#Q = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#Pt(), this.#Ye(), this.#Et()) {
        this.#h?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#r === "active" && this.#le();
        return;
      }
      this.#le(), (this.#a?.interlaced ?? !0) && this.#q();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#u && (this.#u = !1, this.#de.cancel(), this.#Rt(), this.#Xe(), this.#o = 0, this.#f = null, this.#k(!1), this.#I(), this.#h?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#Be) {
      this.#Be = !0, this.#pe = !1, this.stop(), this.#de.destroy(), this.#h?.postMessage({ type: "destroy" }), this.#h?.terminate(), this.#h = null, this.#I(), this.#$e("the deinterlacer was destroyed"), this.#n.removeEventListener(
        "webglcontextlost",
        this.#pt
      ), this.#e.removeEventListener("emptied", this.#ft), this.#e.removeEventListener("resize", this.#ut), this.#e.removeEventListener("pause", this.#_), this.#e.removeEventListener("ended", this.#_), this.#e.removeEventListener("seeking", this.#mt), this.#e.removeEventListener("seeked", this.#_), this.#e.removeEventListener("ratechange", this.#_), this.#It();
      for (const e of this.#F) this.#s.deleteTexture(e);
      this.#F = [], this.#K(), this.#Qe(), this.#s.deleteProgram(this.#d), this.#s.deleteProgram(this.#m), this.#p && this.#s.deleteProgram(this.#p), this.#v && this.#s.deleteProgram(this.#v), this.#L && this.#s.deleteProgram(this.#L), this.#s.getExtension("WEBGL_lose_context")?.loseContext();
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
      const s = ++this.#gt, A = new Promise((r, h) => {
        this.#re.set(s, { resolve: r, reject: h });
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
    if (this.#l && (!this.#u || this.#S || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#u || this.#S || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#Ze(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#ce(e.flush, e.second, null, !1) : this.#He(null, !1);
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
  #le() {
    this.#l || !this.#u || this.#de.request(this.#Dt);
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #ze() {
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
      this.#P === "auto" && !this.#ge && !this.#se ? (this.#be(), this.#De(e, t)) : this.#ae(r);
      return;
    }
    const s = {
      id: ++this.#wt,
      frame: i,
      now: e,
      metadata: t,
      video: this.#ze()
    };
    if (this.#Ae) {
      this.#V?.frame.close(), this.#V = s;
      return;
    }
    this.#et(s);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #et(e) {
    const t = this.#h;
    if (!t || this.#r !== "active") {
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
      this.#P === "auto" && !this.#ge && !this.#se ? (this.#be(), this.#De(e.now, e.metadata)) : this.#ae(A);
    }
  }
  #Dt = (e, t) => {
    !this.#u || this.#S || (this.#me = e, this.#Q = Math.max(
      this.#Q,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#tt(e, t), this.#le());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #tt(e, t) {
    if (this.#fe = t.mediaTime, this.#r === "active") {
      this.#bt(e, t);
      return;
    }
    this.#r !== "starting" && this.#De(e, t);
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
      if (!this.#ie && this.#e.seeking) {
        const c = this.#e.buffered, d = this.#c >= j ? this.#c / 1e3 : V / 1e3;
        for (let p = 0; p < c.length; p++)
          if (t.mediaTime >= c.start(p) && t.mediaTime < c.end(p) && Math.abs(t.mediaTime - this.#e.currentTime) <= d) {
            i = !0;
            break;
          }
      }
      if (i && (this.#ie = !0), (this.#g === 0 || this.#M === 0) && this.#lt(t.width, t.height), this.#a && !this.#a.interlaced) {
        this.#Ct();
        return;
      }
      const s = t.mediaTime - this.#te, A = i || s < 0 || s > be;
      A && (this.#o = 0, this.#c = 0, this.#D.discontinuities++, this.#i.length = 0, this.#y());
      const r = this.#w && this.#H !== 0 && t.presentedFrames - this.#H > 1;
      if (this.#Lt(t.presentedFrames, A), !A && r && (this.#o = 0, this.#y()), this.#o > 0 && t.mediaTime === this.#te)
        return;
      !A && s > 0 && this.#Tt(s), this.#te = t.mediaTime;
      const h = performance.now();
      h - this.#Ne > te && (this.#Ee = h, this.#O = 0, this.#ne = 0, this.#he = 0, this.#oe = 0, this.#J = 0, this.#z = 0), this.#Ne = h;
      const n = performance.now();
      this.#at();
      const a = this.#B, o = this.#w && this.#o === D && this.#xt();
      if (a !== this.#B && (this.#i.length = 0), !(o && this.#ye())) if (this.#w && !this.#Re && this.#B === "film")
        if (this.#ye()) {
          const c = this.#c * 5 / 4, d = this.#At(1, e, c), p = this.#i.at(-1), g = d ? e : p == null ? e + c : p.at + p.duration;
          this.#Mt(g, c);
        } else
          this.#He(null);
      else if (this.#R && this.#ye()) {
        const c = this.#c / 2, d = this.#At(2, e, c), p = this.#i.at(-1), g = d ? e : p == null ? e + c * 2 : p.at + p.duration;
        this.#st(!1, g, c), this.#st(!0, g + c, c);
      } else
        this.#D.late += this.#i.length, this.#i.length = 0, this.#ce(!1, !1, null);
      this.#J = Math.max(
        this.#J,
        this.#i.length
      ), this.#ne += performance.now() - n, this.#O++, this.#Bt(h);
    }
  }
  #yt(e) {
    let t;
    for (let A = this.#j.length - 1; A >= 0; A--) {
      const r = this.#j[A];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#g || t.codedSize.height !== this.#M) && this.#lt(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#a?.interlaced === i.interlaced && this.#a.topFieldFirst === i.topFieldFirst)
      return;
    const s = this.#a?.interlaced;
    this.#a = i, this.#o = 0, this.#i.length = 0, this.#y(), s !== i.interlaced && (this.#c = 0), i.interlaced && (this.#l || this.#r === "main") ? this.#q() : this.#Xe();
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
    return (this.#R || this.#w) && this.#c > 0 && this.#b.length === C;
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
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#c > 0 ? Math.max(1, Math.round(t / this.#c)) : 1, s = t / i;
    s < j || s > V || (this.#c = this.#c > 0 ? this.#c + (s - this.#c) * De : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #it() {
    if (this.#p && this.#v && this.#L) return;
    const e = this.#s, t = W(e, fe), i = W(e, de), s = W(e, me);
    this.#p = t, this.#C = Object.fromEntries(
      Object.entries(Q).filter(([A]) => A !== "match" && A !== "topFieldFirst").map(([A, r]) => [A, e.getUniformLocation(t, r)])
    ), this.#v = i, this.#U = Object.fromEntries(
      Object.entries(Q).map(([A, r]) => [
        A,
        e.getUniformLocation(i, r)
      ])
    ), this.#L = s, this.#Je = Object.fromEntries(
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
    const e = this.#N, t = this.#p, i = this.#C, s = this.#L, A = this.#Je;
    if (!e || !t || !i || !s || !A)
      return !1;
    const r = this.#s, h = this.#E, n = (this.#E + D - 1) % D, a = (this.#E + 1) % D, o = this.#ve;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [w, v] of [a, n, h].entries())
      r.activeTexture(r.TEXTURE0 + w), r.bindTexture(r.TEXTURE_2D, this.#F[v] ?? null);
    r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#g, this.#M), r.viewport(0, 0, x, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      x,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: f, currentLuma: u, nextLuma: c } = e;
    for (let w = 0; w < f.length; w++) {
      const v = w * 4;
      f[w] = e.pixels[v] ?? 0, u[w] = e.pixels[v + 1] ?? 0, c[w] = e.pixels[v + 2] ?? 0;
    }
    const d = this.#Se.fieldMatch(
      f,
      u,
      c,
      o,
      this.#Z
    );
    r.useProgram(s), r.uniform1i(A.prev, 0), r.uniform1i(A.cur, 1), r.uniform1i(A.next, 2), r.uniform2i(A.size, this.#g, this.#M), r.uniform1i(A.topFieldFirst, o ? 1 : 0), r.uniform1i(
      A.match,
      d.match === "p" ? 0 : d.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      x,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const p = this.#Se.decimate(e.pixels);
    this.#ee = d.match, this.#Fe = d.combScore, this.#Re = d.isCombed, this.#ke = p.lowestCycleDifference, this.#Ce = p.runnerUpCycleDifference;
    const g = p.dropIndex !== null && !d.isCombed;
    return (g ? "film" : "video") !== this.#B && (this.#B = g ? "film" : "video"), p.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Mt(e, t) {
    const i = this.#Oe();
    if (i === null) return;
    const s = this.#b[i];
    if (s) {
      for (this.#$ = i; this.#i.length > 0 && this.#i[0]?.slot === i; )
        this.#i.shift(), this.#D.late++;
      this.#He(s.framebuffer), this.#i.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #He(e, t = !0) {
    const i = this.#v, s = this.#U;
    if (!i || !s) return;
    const A = this.#s, r = this.#E, h = (this.#E + D - 1) % D, n = (this.#E + 1) % D, a = this.#ve;
    A.bindFramebuffer(A.FRAMEBUFFER, e), A.useProgram(i);
    for (const [o, f] of [n, h, r].entries())
      A.activeTexture(A.TEXTURE0 + o), A.bindTexture(A.TEXTURE_2D, this.#F[f] ?? null);
    A.uniform1i(s.prev, 0), A.uniform1i(s.cur, 1), A.uniform1i(s.next, 2), A.uniform2i(s.size, this.#g, this.#M), A.uniform1i(s.topFieldFirst, a ? 1 : 0), A.uniform1i(
      s.match,
      this.#ee === "p" ? 0 : this.#ee === "c" ? 1 : 2
    ), A.viewport(0, 0, this.#g, this.#M), A.drawArrays(A.TRIANGLES, 0, 3), e === null && (this.#f = { kind: "film" }, this.#k(!0), t && this.#z++);
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
    const s = this.#Oe();
    if (s === null) return;
    const A = this.#b[s];
    if (A) {
      for (this.#$ = s; this.#i.length > 0 && this.#i[0]?.slot === s; )
        this.#i.shift(), this.#D.late++;
      this.#ce(!1, e, A.framebuffer), this.#i.push({ slot: s, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #At(e, t, i) {
    const s = this.#i.at(-1), A = (q + 1) * Math.max(this.#X, i);
    if (s && s.at - t > A)
      return this.#i.length = 0, this.#D.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#i.length + e - q
    );
    let h = 0, n = 0;
    for (; n < r; ) {
      const a = this.#i.shift();
      if (!a) break;
      h += a.duration, n++;
    }
    for (const a of this.#i) a.at -= h;
    return this.#D.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Oe() {
    const e = this.#f?.kind === "texture" ? this.#f.texture : null, t = new Set(this.#i.map(({ slot: s }) => s));
    for (let s = 1; s <= C; s++) {
      const A = (this.#$ + s) % C, r = this.#b[A];
      if (r && r.texture !== e && !t.has(A))
        return A;
    }
    const i = this.#i[0];
    if (i) {
      const s = this.#b[i.slot];
      if (s && s.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #q() {
    this.#G === null && (!this.#u || this.#S || (this.#ue = 0, this.#G = this.#nt(this.#rt)));
  }
  #Xe() {
    this.#G !== null && this.#Ft(this.#G), this.#G = null, this.#i.length = 0;
  }
  #rt = (e) => {
    if (this.#G = null, !(!this.#u || this.#S)) {
      if (this.#ue > 0) {
        const t = e - this.#ue;
        t >= 1 && t <= V && (this.#X = t < this.#X ? t : this.#X + (t - this.#X) * Te);
      }
      this.#ue = e, this.#r === "main" && this.#kt(e), this.#G = this.#nt(this.#rt);
    }
  };
  /** ページと Worker のそれぞれが所有する requestAnimationFrame() へ表示ループを委ねる。 */
  #nt(e) {
    return this.#l ? this.#l.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #Ft(e) {
    this.#l ? this.#l.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #Ye() {
    this.#l || this.#W !== null || !this.#u || this.#S || (this.#W = requestAnimationFrame(this.#ht));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Rt() {
    this.#W !== null && cancelAnimationFrame(this.#W), this.#W = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #ht = (e) => {
    this.#W = null, !(!this.#u || this.#S) && (this.#St(e), this.#W = requestAnimationFrame(this.#ht));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #St(e) {
    if (this.#l || e - this.#me < xe || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#c >= j ? this.#c : Me, A = i > this.#Q, r = t !== this.#fe && e - this.#Le >= s * 0.75;
    !A && !r || (this.#Q = Math.max(
      this.#Q,
      i
    ), this.#Le = e, this.#tt(e, {
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
  #kt(e) {
    const t = e + this.#X * 1.5;
    for (; this.#i[1] && this.#i[1].at <= t; )
      this.#D.late++, this.#i.shift();
    let i = this.#i[0];
    if (!i || i.at > t)
      return;
    this.#i.shift();
    const s = performance.now();
    this.#ot(i.slot), this.#oe += performance.now() - s, this.#he++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #ot(e) {
    const t = this.#b[e];
    t && this.#Ze(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Ct() {
    this.#at();
    const e = this.#F[this.#E];
    e && this.#Ze(e, !0), this.#o = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #k(e) {
    if (this.#l) {
      this.#l.onVisibility(e);
      return;
    }
    this.#t.style.visibility = e ? "visible" : "hidden";
  }
  #Ze(e, t = !1, i = !0) {
    const s = this.#s;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#m), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#T, 0), s.uniform1i(this.#x, t ? 1 : 0), s.viewport(0, 0, this.#g, this.#M), s.drawArrays(s.TRIANGLES, 0, 3), this.#f = { kind: "texture", texture: e, flip: t }, this.#k(!0), i && this.#z++;
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
    this.#H !== 0 && !t && (this.#D.missed += Math.max(0, e - this.#H - 1)), this.#H = e;
  }
  #Bt(e) {
    const t = e - this.#Ee;
    if (t < te) return;
    const i = this.#ye() && (this.#R || this.#B === "film") ? this.#he : this.#O, s = {
      ...this.#D,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#O === 0 ? 0 : (this.#ne + this.#oe) / this.#O,
      maxQueuedFields: this.#J,
      mode: this.#B,
      match: this.#ee,
      combScore: this.#Fe,
      outputFps: this.#z * 1e3 / t,
      duplicateScore: this.#ke,
      duplicateRunnerUp: this.#Ce
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#Pe?.(s), this.#Ee = e, this.#O = 0, this.#ne = 0, this.#he = 0, this.#oe = 0, this.#J = 0, this.#z = 0;
  }
  /** Take the newest frame into the ring. */
  #at() {
    const e = this.#s;
    this.#E = (this.#E + 1) % D, e.bindTexture(e.TEXTURE_2D, this.#F[this.#E] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#we
    ), this.#o = Math.min(this.#o + 1, D);
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
  #ce(e, t, i, s = !0) {
    if (this.#o === 0 || this.#S) return;
    s && (this.#o === D && !e ? this.#D.filtered++ : this.#D.degraded++);
    const A = this.#s, r = this.#E, h = (this.#E + D - 1) % D, n = (this.#E + 1) % D;
    let a, o, f;
    this.#o === 1 ? a = o = f = r : e ? (a = h, o = f = r) : this.#o === 2 ? (a = o = h, f = r) : (a = n, o = h, f = r), A.bindFramebuffer(A.FRAMEBUFFER, i), A.useProgram(this.#d);
    for (const [c, d] of [a, o, f].entries())
      A.activeTexture(A.TEXTURE0 + c), A.bindTexture(A.TEXTURE_2D, this.#F[d] ?? null);
    A.uniform1i(this.#A.prev, 0), A.uniform1i(this.#A.cur, 1), A.uniform1i(this.#A.next, 2), A.uniform2i(this.#A.size, this.#g, this.#M);
    const u = this.#ve ? 0 : 1;
    A.uniform1i(this.#A.parity, t ? 1 - u : u), A.uniform1i(this.#A.tff, this.#ve ? 1 : 0), A.uniform1i(this.#A.spatialCheck, this.#Me ? 1 : 0), A.viewport(0, 0, this.#g, this.#M), A.drawArrays(A.TRIANGLES, 0, 3), i === null && (this.#f = { kind: "yadif", flush: e, second: t }, this.#k(!0), s && this.#z++);
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
    if (!this.#Y) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const s = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), A = t * s, r = i * s;
    this.#t.style.left = `${e.offsetLeft + (e.offsetWidth - A) / 2}px`, this.#t.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#t.style.width = `${A}px`, this.#t.style.height = `${r}px`;
  }
  #lt(e, t) {
    const i = this.#s;
    this.#n.width = e, this.#n.height = t, this.#g = e, this.#M = t, this.#o = 0, this.#f = null, this.#y(), this.#Te();
    for (const s of this.#F) i.deleteTexture(s);
    this.#F = [];
    for (let s = 0; s < D; s++) {
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
      ), this.#F.push(A);
    }
    this.#K(), this.#Qe(), this.#w && this.#ct(), (this.#R || this.#w) && this.#je();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #ct() {
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
  #Qe() {
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
  #je() {
    const e = this.#s;
    if (!(this.#b.length === C || this.#g === 0)) {
      this.#K();
      for (let t = 0; t < C; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#g,
          this.#M,
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
          e.deleteFramebuffer(s), e.deleteTexture(i), this.#K();
          return;
        }
        this.#b.push({ texture: i, framebuffer: s });
      }
      this.#$ = C - 1;
    }
  }
  #K() {
    const e = this.#s, t = this.#f?.kind === "texture" ? this.#f.texture : null;
    this.#b.some((i) => i.texture === t) && (this.#f = null);
    for (const { texture: i, framebuffer: s } of this.#b)
      e.deleteFramebuffer(s), e.deleteTexture(i);
    this.#b = [], this.#i.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #Pt() {
    if (this.#Y) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#t), this.#Y = t, this.#xe?.observe(this.#e), this.#Te();
  }
  #It() {
    if (this.#l) return;
    const e = this.#Y;
    this.#Y = null, this.#xe?.disconnect(), this.#t.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #ut = () => this.#Te();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #Ve(e) {
    return !this.#h || this.#r === "main" ? !1 : (this.#h.postMessage({
      type: "event",
      name: e,
      video: this.#ze()
    }), !0);
  }
  #ft = () => {
    if (this.#fe = Number.NaN, this.#Ve("emptied")) {
      this.#I(), this.#k(!1);
      return;
    }
    this.#o = 0, this.#te = 0, this.#i.length = 0, this.#c = 0, this.#dt(), this.#y(), this.#f = null, this.#k(!1);
  };
  #dt() {
    this.#D = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#H = 0, this.#Ee = 0, this.#Ne = 0, this.#O = 0, this.#ne = 0, this.#he = 0, this.#oe = 0, this.#J = 0, this.#z = 0, this.#y();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #y() {
    this.#i.length = 0, this.#B = "video", this.#ee = "c", this.#Fe = 0, this.#Re = !0, this.#Se.reset(), this.#ke = 1 / 0, this.#Ce = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #mt = () => {
    if (this.#Ve("seeking")) {
      this.#I();
      return;
    }
    this.#ie = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #_ = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#Ve(e.type)) {
      this.#I();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#ie;
      if (this.#ie = !1, i) return;
      this.#o = 0, this.#y(), this.#f = null, this.#k(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#c = 0, this.#te = this.#e.currentTime), this.#i.length = 0, this.#u && this.#o > 0) {
      const i = this.#Oe(), s = i === null ? void 0 : this.#b[i];
      i !== null && s ? (this.#$ = i, this.#ce(!0, !1, s.framebuffer), this.#ot(i)) : this.#ce(!0, !1, null);
    }
    t && (this.#o = 0, this.#y());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #pt = (e) => {
    if (e.preventDefault(), this.#l) {
      this.#l.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#r !== "active" && (this.#S = !0, this.stop());
  };
}
function W(l, e) {
  const t = l.createProgram(), i = se(l, l.VERTEX_SHADER, Fe), s = se(l, l.FRAGMENT_SHADER, e);
  if (l.attachShader(t, i), l.attachShader(t, s), l.linkProgram(t), l.deleteShader(i), l.deleteShader(s), !l.getProgramParameter(t, l.LINK_STATUS)) {
    const A = l.getProgramInfoLog(t);
    throw l.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${A ?? "no reason given"}`
    );
  }
  return t;
}
function se(l, e, t) {
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
const Ae = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Se = 0.5, ke = 3e3, re = 0.1, I = 16, ne = 'video/mp4; codecs="avc1.640029"';
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
  const e = l.tolerance ?? Se, t = l.timeoutMs ?? ke, i = performance.now(), s = (h) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: h instanceof Error ? h.message : String(h)
  });
  if (typeof document > "u")
    return s(new Error("there is no document to decode in"));
  const A = document.createElement("video");
  A.muted = !0, A.defaultMuted = !0, A.playsInline = !0, A.preload = "auto";
  let r = null;
  try {
    r = Pe(A, t);
    const h = O(H(A, "loadeddata"), t), n = A.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await h, await Ie(A, t, await n), A.videoWidth === 0 || A.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const a = _e(A);
    return {
      deinterlaces: a < 1 - e,
      survives: a,
      tookMs: performance.now() - i
    };
  } catch (h) {
    return s(h);
  } finally {
    A.pause(), A.removeAttribute("src"), A.replaceChildren(), A.load(), r && URL.revokeObjectURL(r.url);
  }
}
const J = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Be = typeof MediaSource > "u";
function Pe(l, e) {
  if (!J || !J.isTypeSupported(ne))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = Ae.indexOf(","), i = atob(Ae.slice(t + 1)), s = new Uint8Array(i.length);
  for (let n = 0; n < i.length; n++) s[n] = i.charCodeAt(n);
  const A = new J(), r = URL.createObjectURL(A);
  if (Be) {
    l.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, l.append(n), l.load();
  } else
    l.src = r;
  const h = (async () => {
    await O(H(A, "sourceopen"), e);
    const n = A.addSourceBuffer(ne), a = O(H(n, "updateend"), e);
    n.appendBuffer(s), await a, A.endOfStream();
  })();
  return { url: r, ready: h };
}
async function Ie(l, e, t) {
  if (t) {
    const i = performance.now();
    for (; l.currentTime < re && performance.now() - i < e; )
      await new Promise((s) => requestAnimationFrame(s));
    l.pause();
  } else
    l.currentTime = re, await O(H(l, "seeked"), e);
}
function _e(l) {
  const e = l.videoHeight, t = document.createElement("canvas");
  t.width = I, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(l, 0, 0, I, e);
  const s = i.getImageData(0, 0, I, e).data, A = (o) => {
    let f = 0;
    for (let u = 0; u < I; u++)
      f += s[(o * I + u) * 4 + 1] ?? 0;
    return f / I;
  };
  let r = 0;
  const h = 2, n = e - 3;
  let a = A(h);
  for (let o = h + 1; o <= n; o++) {
    const f = A(o);
    r += Math.abs(f - a), a = f;
  }
  return r / (n - h) / 255;
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
ve(le);
export {
  Ne as Deinterlacer,
  fe as FILM_ANALYSIS_FRAGMENT_SHADER,
  me as FILM_SAMPLE_FRAGMENT_SHADER,
  Q as FILM_UNIFORMS,
  de as FILM_WEAVE_FRAGMENT_SHADER,
  ue as YADIF_FRAGMENT_SHADER,
  ce as YADIF_UNIFORMS,
  Ge as decoderDeinterlaces,
  We as forgetDecoderProbe,
  Ce as probeDecoder,
  Ue as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
