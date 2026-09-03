const he = "" + new URL("assets/worker-BbHpxmJC.js", import.meta.url).href, ae = {
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
}, T = 288, M = 162, ce = `#version 300 es
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
  ivec2 targetSize = ivec2(${T}, ${M});
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
  ivec2 targetSize = ivec2(${T}, ${M});
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
  #u;
  #i;
  #e;
  #A = 0;
  #v = null;
  #r = [];
  #b = null;
  #N = 1 / 0;
  #W = 1 / 0;
  constructor(e, t) {
    this.#u = e, this.#i = t, this.#e = 255 * D.DECIMATE_BLOCK ** 2 * D.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, s, A = D.COMBED_PIXEL_LIMIT) {
    const r = s ? 1 : 0, h = { p: e, c: t, n: i };
    let n = this.#S("c", "p", r, h);
    const l = /* @__PURE__ */ new Map(), o = (p) => {
      const E = l.get(p);
      if (E !== void 0) return E;
      const w = D.#k(
        this.weave(e, t, i, p, s),
        this.#u,
        this.#i
      );
      return l.set(p, w), w;
    }, f = o(n), u = o("n");
    (u * 3 < f || u * 2 < f && f > A) && Math.abs(u - f) >= 30 && u < A && (n = "n");
    const a = o(n), d = a >= A;
    return d && (n = "c"), {
      match: n,
      combScore: a,
      isCombed: d,
      luma: this.weave(e, t, i, n, s)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#A, i = this.#b ? D.#le(
      this.#b,
      e,
      this.#u,
      this.#i
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#r.push(i);
    const s = this.#v === t, A = s && i.maxBlockDifference < this.#e;
    s && !A && (this.#v = null);
    const r = this.#v;
    this.#b = e.slice(), this.#A++;
    let h = this.#v;
    if (this.#A === D.CYCLE) {
      let n = 0, l = null;
      for (let o = 1; o < this.#r.length; o++)
        (this.#r[o]?.maxBlockDifference ?? 1 / 0) < (this.#r[n]?.maxBlockDifference ?? 1 / 0) ? (l = n, n = o) : (l === null || (this.#r[o]?.maxBlockDifference ?? 1 / 0) < (this.#r[l]?.maxBlockDifference ?? 1 / 0)) && (l = o);
      this.#N = this.#r[n]?.maxBlockDifference ?? 1 / 0, this.#W = l === null ? 1 / 0 : this.#r[l]?.maxBlockDifference ?? 1 / 0, h = (this.#r[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#v = h, this.#r = [], this.#A = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: A,
      dropIndex: r,
      nextDropIndex: h,
      lowestCycleDifference: this.#N,
      runnerUpCycleDifference: this.#W
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, s, A) {
    if (s === "c") return t.slice();
    const r = t.slice(), h = s === "p" ? e : i, n = r.length / this.#i, l = A ? 1 : 0;
    for (let o = l; o < this.#i; o += 2)
      r.set(
        h.subarray(o * n, (o + 1) * n),
        o * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#A = 0, this.#v = null, this.#r = [], this.#b = null, this.#N = 1 / 0, this.#W = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #S(e, t, i, s) {
    const A = this.#u, r = this.#i, h = 2 - i, n = 2 - i, l = s[e], o = s[t], f = D.#ae(
      l,
      o,
      A,
      r,
      i
    );
    let u = 0, a = 0, d = 0, p = 0, E = 0, w = 0;
    for (let C = 2; C < r - 2; C += 2) {
      const y = (C - 2) / 2, z = h - 1 + y * 2, Y = h + 1 + y * 2, Z = h + 3 + y * 2, H = h + y * 2, N = H + 2, L = n + y * 2, R = L + 2, $ = h + y * 2;
      for (let x = 8; x < A - 8; x++) {
        const S = (f[$ * A + x] ?? 0) | (f[($ + 2) * A + x] ?? 0);
        if (S === 0) continue;
        const ee = (s.c[z * A + x] ?? 0) + ((s.c[Y * A + x] ?? 0) << 2) + (s.c[Z * A + x] ?? 0), B = Math.abs(
          3 * ((l[H * A + x] ?? 0) + (l[N * A + x] ?? 0)) - ee
        ), P = Math.abs(
          3 * ((o[L * A + x] ?? 0) + (o[R * A + x] ?? 0)) - ee
        );
        B > 23 && (S & 1) !== 0 && (u += B), P > 23 && (S & 1) !== 0 && (p += P), B > 42 && (S & 2) !== 0 && (a += B), P > 42 && (S & 2) !== 0 && (E += P), B > 42 && (S & 4) !== 0 && (d += B), P > 42 && (S & 4) !== 0 && (w += P);
      }
    }
    a < 500 && E < 500 && (d >= 500 || w >= 500) && Math.max(d, w) > 3 * Math.min(d, w) && (a = d, E = w);
    const v = Math.floor(u / 6 + 0.5), F = Math.floor(p / 6 + 0.5), g = Math.floor(a / 6 + 0.5), m = Math.floor(E / 6 + 0.5), _ = Math.max(v, F) / Math.max(Math.min(v, F), 1), U = Math.max(g, m) / Math.max(Math.min(g, m), 1), G = Math.max(g, m) / Math.max(Math.max(v, F), 1);
    return (g >= 500 || m >= 500) && (g * 2 < m || m * 2 < g) || (g >= 1e3 || m >= 1e3) && (g * 3 < m * 2 || m * 3 < g * 2) || (g >= 2e3 || m >= 2e3) && (g * 5 < m * 4 || m * 5 < g * 4) || (g >= 4e3 || m >= 4e3) && U > _ || G > 5e-3 && Math.max(g, m) > 150 && (g * 2 < m || m * 2 < g) ? g > m ? t : e : v > F ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #ae(e, t, i, s, A) {
    const r = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(i)
    ), h = A === 1 ? 1 : 0;
    for (let o = 0; o < r.length; o++) {
      const f = Math.min(s - 1, h + o * 2), u = r[o];
      if (u)
        for (let a = 0; a < i; a++)
          u[a] = Math.abs(
            (e[f * i + a] ?? 0) - (t[f * i + a] ?? 0)
          );
    }
    const n = new Uint8Array(i * s), l = A === 1 ? 3 : 2;
    for (let o = 1; o < r.length - 1; o++) {
      const f = l + (o - 1) * 2;
      if (f >= s) break;
      const u = r[o];
      if (u)
        for (let a = 1; a < i - 1; a++) {
          const d = u[a] ?? 0;
          if (d <= 3) continue;
          let p = 0;
          for (let m = a - 1; m <= a + 1; m++)
            p += (r[o - 1]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[o]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[o + 1]?.[m] ?? 0) > 3 ? 1 : 0;
          if (p <= 1) continue;
          const E = f * i + a;
          if (n[E] = 1, d <= 19) continue;
          p = 0;
          let w = !1, v = !1;
          for (let m = a - 1; m <= a + 1; m++)
            (r[o - 1]?.[m] ?? 0) > 19 && (p++, w = !0), (r[o]?.[m] ?? 0) > 19 && p++, (r[o + 1]?.[m] ?? 0) > 19 && (p++, v = !0);
          if (p <= 3) continue;
          if (w && v) {
            n[E] |= 2;
            continue;
          }
          let F = !1, g = !1;
          for (let m = Math.max(a - 4, 0); m < Math.min(a + 5, i); m++)
            o !== 1 && (r[o - 2]?.[m] ?? 0) > 19 && (F = !0), (r[o - 1]?.[m] ?? 0) > 19 && (w = !0), (r[o + 1]?.[m] ?? 0) > 19 && (v = !0), o !== r.length - 2 && (r[o + 2]?.[m] ?? 0) > 19 && (g = !0);
          w && (v || F) || v && (w || g) ? n[E] |= 2 : p > 5 && (n[E] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #k(e, t, i) {
    const s = new Uint8Array(t * i), A = (h, n) => e[Math.max(0, Math.min(i - 1, n)) * t + h] ?? 0;
    for (let h = 0; h < i; h++)
      for (let n = 0; n < t; n++) {
        const l = A(n, h), o = A(n, h === 0 ? 1 : h - 1), f = A(n, h === i - 1 ? i - 2 : h + 1), u = h < 2 ? A(n, h === 0 ? 2 : 3) : A(n, h - 2), a = h + 2 >= i ? A(n, h === i - 1 ? i - 3 : i - 4) : A(n, h + 2);
        (h === 0 ? Math.abs(l - f) > D.COMB_THRESHOLD : h === i - 1 ? Math.abs(l - o) > D.COMB_THRESHOLD : Math.abs(l - o) > D.COMB_THRESHOLD && Math.abs(l - f) > D.COMB_THRESHOLD) && Math.abs(
          4 * l - 3 * (o + f) + u + a
        ) > D.COMB_THRESHOLD * 6 && (s[h * t + n] = 255);
      }
    let r = 0;
    for (const h of [0, 8])
      for (const n of [0, 8])
        for (let l = h; l < i; l += 16)
          for (let o = n; o < t; o += 16) {
            let f = 0;
            for (let u = Math.max(1, l); u < Math.min(i - 1, l + 16); u++)
              for (let a = o; a < Math.min(t, o + 16); a++) {
                const d = u * t + a;
                s[d - t] === 255 && s[d] === 255 && s[d + t] === 255 && f++;
              }
            r = Math.max(r, f);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #le(e, t, i, s) {
    const A = D.DECIMATE_BLOCK / 2, r = Math.ceil(i / A), h = Math.ceil(s / A), n = new Float64Array(r * h), l = e.length / (i * s);
    for (let u = 0; u < s; u++) {
      const a = Math.floor(u / A);
      for (let d = 0; d < i; d++) {
        const p = Math.floor(d / A), E = a * r + p, w = (u * i + d) * l;
        if (l === 1) {
          n[E] = (n[E] ?? 0) + Math.abs((e[w] ?? 0) - (t[w] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[w] ?? 0) * 0.2126 + (e[w + 1] ?? 0) * 0.7152 + (e[w + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (t[w] ?? 0) * 0.2126 + (t[w + 1] ?? 0) * 0.7152 + (t[w + 2] ?? 0) * 0.0722
        );
        if (n[E] = (n[E] ?? 0) + Math.abs(v - F), (d & 1) !== 0 || (u & 1) !== 0) continue;
        let g = 0, m = 0, _ = 0, U = 0, G = 0, C = 0, y = 0;
        for (let N = u; N < Math.min(u + 2, s); N++)
          for (let L = d; L < Math.min(d + 2, i); L++) {
            const R = (N * i + L) * l;
            g += e[R] ?? 0, m += e[R + 1] ?? 0, _ += e[R + 2] ?? 0, U += t[R] ?? 0, G += t[R + 1] ?? 0, C += t[R + 2] ?? 0, y++;
          }
        const z = Math.round(
          (-0.114572 * g - 0.385428 * m + 0.5 * _) / y
        ), Y = Math.round(
          (-0.114572 * U - 0.385428 * G + 0.5 * C) / y
        ), Z = Math.round(
          (0.5 * g - 0.454153 * m - 0.045847 * _) / y
        ), H = Math.round(
          (0.5 * U - 0.454153 * G - 0.045847 * C) / y
        );
        n[E] = (n[E] ?? 0) + Math.abs(z - Y) + Math.abs(Z - H);
      }
    }
    let o = -1;
    for (let u = 0; u < h - 1; u++)
      for (let a = 0; a < r - 1; a++)
        o = Math.max(
          o,
          (n[u * r + a] ?? 0) + (n[u * r + a + 1] ?? 0) + (n[(u + 1) * r + a] ?? 0) + (n[(u + 1) * r + a + 1] ?? 0)
        );
    let f = 0;
    for (const u of n) f += u;
    return { maxBlockDifference: o, totalDifference: f };
  }
}
let oe = null;
function de(c) {
  oe = c;
}
const me = 0.5, b = 3, q = 5, k = q + 1, te = 1e3, j = 4, V = 200, pe = 0.25, we = 1e3 / 60, Ee = 0.02, ge = 250, ve = 1e3 / 30;
function ie(c) {
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
`, be = `#version 300 es
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
function ke() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class Le extends EventTarget {
  #u;
  #i;
  #e;
  #A;
  #v;
  #r;
  /** The program that copies a filtered picture onto the canvas. */
  #b;
  #N;
  #W;
  /** The reduced pass that reads previous, current and next luma together. */
  #S = null;
  #ae = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #k = null;
  #le = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #K = null;
  #je = null;
  #L = null;
  #y = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #w = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #$ = k - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #f = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #t = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #B = null;
  #ce = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #P = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #H = we;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #X = null;
  #ve;
  #x;
  #d;
  #O;
  #De;
  #F = "video";
  #ee = "c";
  #be = 0;
  #ye = !0;
  #xe = new D(T, M);
  #Te = 1 / 0;
  #Me = 1 / 0;
  #I = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #a = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #m = 0;
  #D = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #p = b - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #o = 0;
  #z = 0;
  /** A destination frame that arrived before the browser finished seeking. */
  #te = !1;
  #Y = null;
  /** requestVideoFrameCallback() の停止を検出するために保持する最終通知時刻。 */
  #ue = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #Z = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #Fe = 0;
  #l = !1;
  #Re = !1;
  #h = null;
  #Q = [];
  #T = !1;
  #Ce;
  #c;
  #fe;
  #_;
  #Se;
  #s = null;
  #n;
  #de = !1;
  #ke = 0;
  #Le = !1;
  #mt = 0;
  #ie = !1;
  #Be = !1;
  #j = null;
  #pt = 0;
  #Ae = /* @__PURE__ */ new Map();
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #E = {
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
  #Pe = 0;
  #me = 0;
  #G = 0;
  #se = 0;
  #re = 0;
  #ne = 0;
  #V = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#x = t.doubleRate ?? !1, this.#d = t.autoFilm ?? !1, this.#O = ie(
      t.filmCombThreshold ?? D.COMBED_PIXEL_LIMIT
    ), this.#De = t.spatialCheck ?? !0, this.#Ce = t.onStats, this.#c = i, this.#_ = i ? "main" : t.rendering ?? "auto", this.#Se = t.workerUrl ?? oe, this.#n = this.#_ === "main" ? "main" : "idle", this.#i = i ? i.canvas : document.createElement("canvas"), this.#u = i?.canvas ?? (this.#_ === "main" ? this.#i : document.createElement("canvas")), this.#fe = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const s = this.#u.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!s) throw new Error("this browser has no WebGL2");
    this.#A = s, this.#v = W(s, le);
    const A = this.#v;
    this.#r = Object.fromEntries(
      Object.entries(ae).map(([r, h]) => [
        r,
        s.getUniformLocation(A, h)
      ])
    ), this.#b = W(s, be), this.#N = s.getUniformLocation(this.#b, "uField"), this.#W = s.getUniformLocation(this.#b, "uFlip"), this.#d && this.#et(), this.#u.addEventListener(
      "webglcontextlost",
      this.#dt
    ), this.#ve = i ? null : new ResizeObserver(() => this.#ge()), e.addEventListener("emptied", this.#ct), e.addEventListener("resize", this.#lt), e.addEventListener("pause", this.#C), e.addEventListener("ended", this.#C), e.addEventListener("seeking", this.#ft), e.addEventListener("seeked", this.#C), e.addEventListener("ratechange", this.#C);
  }
  get running() {
    return this.#l && (this.#h?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#i;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #pe() {
    return this.#h?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #Ve() {
    return {
      doubleRate: this.#x,
      autoFilm: this.#d,
      filmCombThreshold: this.#O,
      spatialCheck: this.#De
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#Re;
  }
  set enabled(e) {
    this.#Re = e, this.#_e(), this.#s?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#h?.interlaced !== e?.interlaced, i = t || this.#h?.topFieldFirst !== e?.topFieldFirst;
    this.#h = e, this.#s?.postMessage({ type: "scan", scan: e }), i && (this.#o = 0, this.#g(), t && (this.#a = 0), this.#f = null, this.#M(!1)), this.#_e(), i && ((e?.interlaced ?? !0) && (this.#c || this.#n === "main") ? this.#J() : this.#Xe());
  }
  get scan() {
    return this.#h;
  }
  set videoTimeline(e) {
    this.#Q = e, this.#s?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#h = null), this.#_e();
  }
  get videoTimeline() {
    return this.#Q;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#X ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#x;
  }
  set doubleRate(e) {
    e !== this.#x && (this.#x = e, this.#Ie(), this.#t.length = 0, e ? (this.#m > 0 && this.#Ze(), (this.#h?.interlaced ?? !0) && this.#J()) : this.#d || (this.#f = null, this.#M(!1), this.#q()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#d;
  }
  set autoFilm(e) {
    e !== this.#d && (this.#d = e, this.#Ie(), this.#g(), e ? (this.#et(), this.#m > 0 && (this.#at(), this.#Ze()), (this.#h?.interlaced ?? !0) && this.#J()) : (this.#Ye(), this.#x || (this.#f = null, this.#M(!1), this.#q())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#O;
  }
  set filmCombThreshold(e) {
    const t = ie(e);
    t !== this.#O && (this.#O = t, this.#Ie(), this.#d && this.#g());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Ie() {
    this.#s?.postMessage({
      type: "settings",
      options: this.#Ve()
    });
  }
  #_e() {
    this.#Re && (this.#Q.length > 0 || (this.#h?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #wt() {
    return this.#c || this.#_ === "main" ? !1 : this.#n === "starting" || this.#n === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Se !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Je(), !0) : this.#_ === "auto" ? (this.#Ue(), !1) : (this.#n = "failed", this.#l = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #Je() {
    this.#R(), this.#s?.terminate(), this.#s = null, this.#ie = !1, this.#Be = !1;
    let e = this.#i;
    if (this.#Le) {
      e = document.createElement("canvas"), e.className = this.#i.className;
      const A = this.#i.getAttribute("style");
      A === null ? e.removeAttribute("style") : e.setAttribute("style", A), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e;
    }
    const t = ++this.#ke;
    this.#n = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#Le = !0, i = new Worker(this.#Se, { type: "module" });
    } catch (A) {
      this.#oe(
        A instanceof Error ? A.message : String(A)
      );
      return;
    }
    this.#s = i, i.onmessage = (A) => {
      t === this.#ke && this.#Et(A.data);
    }, i.onerror = (A) => {
      t === this.#ke && (A.preventDefault(), this.#oe(A.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#Ve(),
        scan: this.#h,
        videoTimeline: this.#Q,
        enabled: this.#l,
        video: this.#Ge()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #Et(e) {
    switch (e.type) {
      case "ready":
        this.#n = "active", this.#l && (this.#we(), this.#Oe());
        break;
      case "failed":
        this.#oe(e.message);
        break;
      case "consumed": {
        this.#ie = !1, this.#Be = !0;
        const t = this.#j;
        this.#j = null, t && this.#Ke(t);
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
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#Ce?.(t);
        break;
      }
      case "capture": {
        const t = this.#Ae.get(e.id);
        if (this.#Ae.delete(e.id), !t) {
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
  #oe(e) {
    if (this.#n === "starting" && this.#_ === "auto" && !this.#de) {
      this.#Ue();
      return;
    }
    if (this.#qe(e), !this.#de) {
      this.#de = !0, this.#Je();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#n = "failed", this.#s?.terminate(), this.#s = null, this.#R(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #Ue() {
    const e = this.#u;
    e.className = this.#i.className;
    const t = this.#i.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e, this.#Le = !1, this.#s?.terminate(), this.#s = null, this.#n = "main", this.#R(), this.#l && (this.#we(), this.#Oe(), (this.#h?.interlaced ?? !0) && this.#J());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #R() {
    this.#j?.frame.close(), this.#j = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #qe(e) {
    for (const t of this.#Ae.values())
      t.reject(new Error(e));
    this.#Ae.clear();
  }
  start() {
    if (!(this.#l || this.#T)) {
      if (this.#l = !0, this.#ut(), this.#g(), this.#ue = performance.now(), this.#Fe = this.#ue, this.#Z = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#Lt(), this.#Oe(), this.#wt()) {
        this.#s?.postMessage({
          type: "enabled",
          enabled: !0
        });
        return;
      }
      this.#we(), (this.#h?.interlaced ?? !0) && this.#J();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#l && (this.#l = !1, this.#Y !== null && this.#e.cancelVideoFrameCallback(this.#Y), this.#Y = null, this.#Mt(), this.#Xe(), this.#o = 0, this.#f = null, this.#M(!1), this.#R(), this.#s?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    this.stop(), this.#s?.postMessage({ type: "destroy" }), this.#s?.terminate(), this.#s = null, this.#R(), this.#qe("the deinterlacer was destroyed"), this.#u.removeEventListener(
      "webglcontextlost",
      this.#dt
    ), this.#e.removeEventListener("emptied", this.#ct), this.#e.removeEventListener("resize", this.#lt), this.#e.removeEventListener("pause", this.#C), this.#e.removeEventListener("ended", this.#C), this.#e.removeEventListener("seeking", this.#ft), this.#e.removeEventListener("seeked", this.#C), this.#e.removeEventListener("ratechange", this.#C), this.#Bt();
    for (const e of this.#y) this.#A.deleteTexture(e);
    this.#y = [], this.#q(), this.#Ye(), this.#A.deleteProgram(this.#v), this.#A.deleteProgram(this.#b), this.#S && this.#A.deleteProgram(this.#S), this.#k && this.#A.deleteProgram(this.#k), this.#K && this.#A.deleteProgram(this.#K), this.#A.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#n === "active" && this.#i.style.visibility === "visible" && this.#s) {
      const s = ++this.#pt, A = new Promise((r, h) => {
        this.#Ae.set(s, { resolve: r, reject: h });
      });
      return this.#s.postMessage({
        type: "capture",
        id: s,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), A;
    }
    if (this.#n === "starting" || this.#n === "failed")
      return createImageBitmap(this.#e);
    const e = this.#f;
    if (this.#c && (!this.#l || this.#T || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#l || this.#T || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#ze(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#he(e.flush, e.second, null, !1) : this.#We(null, !1);
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
  #we() {
    this.#c || !this.#l || this.#Y !== null || (this.#Y = this.#e.requestVideoFrameCallback(this.#vt));
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #Ge() {
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
  #gt(e, t) {
    let i;
    try {
      i = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (A) {
      this.#oe(
        A instanceof Error ? A.message : String(A)
      );
      return;
    }
    const s = {
      id: ++this.#mt,
      frame: i,
      now: e,
      metadata: t,
      video: this.#Ge()
    };
    if (this.#ie) {
      this.#j?.frame.close(), this.#j = s;
      return;
    }
    this.#Ke(s);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #Ke(e) {
    const t = this.#s;
    if (!t || this.#n !== "active") {
      e.frame.close();
      return;
    }
    this.#ie = !0;
    const i = { type: "frame", ...e };
    try {
      t.postMessage(i, [e.frame]);
    } catch (s) {
      this.#ie = !1, e.frame.close();
      const A = s instanceof Error ? s.message : String(s);
      this.#_ === "auto" && !this.#Be && !this.#de ? (this.#Ue(), this.#Ne(e.now, e.metadata)) : this.#oe(A);
    }
  }
  #vt = (e, t) => {
    this.#Y = null, !(!this.#l || this.#T) && (this.#ue = e, this.#Z = Math.max(
      this.#Z,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#$e(e, t), this.#we());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #$e(e, t) {
    if (this.#n === "active") {
      this.#gt(e, t);
      return;
    }
    this.#n !== "starting" && this.#Ne(e, t);
  }
  /** @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。 */
  ingestExternalFrame(e, t, i) {
    this.#fe = i;
    try {
      this.#Ne(e, t);
    } finally {
      this.#fe = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #Ne(e, t) {
    if (this.#Dt(t.mediaTime), t.width > 0 && t.height > 0) {
      let i = !1;
      if (!this.#te && this.#e.seeking) {
        const a = this.#e.buffered, d = this.#a >= j ? this.#a / 1e3 : V / 1e3;
        for (let p = 0; p < a.length; p++)
          if (t.mediaTime >= a.start(p) && t.mediaTime < a.end(p) && Math.abs(t.mediaTime - this.#e.currentTime) <= d) {
            i = !0;
            break;
          }
      }
      if (i && (this.#te = !0), (this.#m === 0 || this.#D === 0) && this.#ht(t.width, t.height), this.#h && !this.#h.interlaced) {
        this.#Ct();
        return;
      }
      const s = t.mediaTime - this.#z, A = i || s < 0 || s > me;
      A && (this.#o = 0, this.#a = 0, this.#E.discontinuities++, this.#t.length = 0, this.#g());
      const r = this.#d && this.#U !== 0 && t.presentedFrames - this.#U > 1;
      if (this.#St(t.presentedFrames, A), !A && r && (this.#o = 0, this.#g()), this.#o > 0 && t.mediaTime === this.#z)
        return;
      !A && s > 0 && this.#bt(s), this.#z = t.mediaTime;
      const h = performance.now();
      h - this.#Pe > te && (this.#me = h, this.#G = 0, this.#se = 0, this.#re = 0, this.#ne = 0, this.#V = 0, this.#I = 0), this.#Pe = h;
      const n = performance.now();
      this.#ot();
      const l = this.#F, o = this.#d && this.#o === b && this.#yt();
      if (l !== this.#F && (this.#t.length = 0), !(o && this.#Ee())) if (this.#d && !this.#ye && this.#F === "film")
        if (this.#Ee()) {
          const a = this.#a * 5 / 4, d = this.#it(1, e, a), p = this.#t.at(-1), E = d ? e : p == null ? e + a : p.at + p.duration;
          this.#xt(E, a);
        } else
          this.#We(null);
      else if (this.#x && this.#Ee()) {
        const a = this.#a / 2, d = this.#it(2, e, a), p = this.#t.at(-1), E = d ? e : p == null ? e + a * 2 : p.at + p.duration;
        this.#tt(!1, E, a), this.#tt(!0, E + a, a);
      } else
        this.#E.late += this.#t.length, this.#t.length = 0, this.#he(!1, !1, null);
      this.#V = Math.max(
        this.#V,
        this.#t.length
      ), this.#se += performance.now() - n, this.#G++, this.#kt(h);
    }
  }
  #Dt(e) {
    let t;
    for (let A = this.#Q.length - 1; A >= 0; A--) {
      const r = this.#Q[A];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#m || t.codedSize.height !== this.#D) && this.#ht(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#h?.interlaced === i.interlaced && this.#h.topFieldFirst === i.topFieldFirst)
      return;
    const s = this.#h?.interlaced;
    this.#h = i, this.#o = 0, this.#t.length = 0, this.#g(), s !== i.interlaced && (this.#a = 0), i.interlaced && (this.#c || this.#n === "main") ? this.#J() : this.#Xe();
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #Ee() {
    return (this.#x || this.#d) && this.#a > 0 && this.#w.length === k;
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
  #bt(e) {
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#a > 0 ? Math.max(1, Math.round(t / this.#a)) : 1, s = t / i;
    s < j || s > V || (this.#a = this.#a > 0 ? this.#a + (s - this.#a) * pe : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #et() {
    if (this.#S && this.#k && this.#K) return;
    const e = this.#A, t = W(e, ce), i = W(e, ue), s = W(e, fe);
    this.#S = t, this.#ae = Object.fromEntries(
      Object.entries(Q).filter(([A]) => A !== "match" && A !== "topFieldFirst").map(([A, r]) => [A, e.getUniformLocation(t, r)])
    ), this.#k = i, this.#le = Object.fromEntries(
      Object.entries(Q).map(([A, r]) => [
        A,
        e.getUniformLocation(i, r)
      ])
    ), this.#K = s, this.#je = Object.fromEntries(
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
  #yt() {
    const e = this.#L, t = this.#S, i = this.#ae, s = this.#K, A = this.#je;
    if (!e || !t || !i || !s || !A)
      return !1;
    const r = this.#A, h = this.#p, n = (this.#p + b - 1) % b, l = (this.#p + 1) % b, o = this.#pe;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [w, v] of [l, n, h].entries())
      r.activeTexture(r.TEXTURE0 + w), r.bindTexture(r.TEXTURE_2D, this.#y[v] ?? null);
    r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#m, this.#D), r.viewport(0, 0, T, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      T,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: f, currentLuma: u, nextLuma: a } = e;
    for (let w = 0; w < f.length; w++) {
      const v = w * 4;
      f[w] = e.pixels[v] ?? 0, u[w] = e.pixels[v + 1] ?? 0, a[w] = e.pixels[v + 2] ?? 0;
    }
    const d = this.#xe.fieldMatch(
      f,
      u,
      a,
      o,
      this.#O
    );
    r.useProgram(s), r.uniform1i(A.prev, 0), r.uniform1i(A.cur, 1), r.uniform1i(A.next, 2), r.uniform2i(A.size, this.#m, this.#D), r.uniform1i(A.topFieldFirst, o ? 1 : 0), r.uniform1i(
      A.match,
      d.match === "p" ? 0 : d.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      T,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const p = this.#xe.decimate(e.pixels);
    this.#ee = d.match, this.#be = d.combScore, this.#ye = d.isCombed, this.#Te = p.lowestCycleDifference, this.#Me = p.runnerUpCycleDifference;
    const E = p.dropIndex !== null && !d.isCombed;
    return (E ? "film" : "video") !== this.#F && (this.#F = E ? "film" : "video"), p.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #xt(e, t) {
    const i = this.#He();
    if (i === null) return;
    const s = this.#w[i];
    if (s) {
      for (this.#$ = i; this.#t.length > 0 && this.#t[0]?.slot === i; )
        this.#t.shift(), this.#E.late++;
      this.#We(s.framebuffer), this.#t.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #We(e, t = !0) {
    const i = this.#k, s = this.#le;
    if (!i || !s) return;
    const A = this.#A, r = this.#p, h = (this.#p + b - 1) % b, n = (this.#p + 1) % b, l = this.#pe;
    A.bindFramebuffer(A.FRAMEBUFFER, e), A.useProgram(i);
    for (const [o, f] of [n, h, r].entries())
      A.activeTexture(A.TEXTURE0 + o), A.bindTexture(A.TEXTURE_2D, this.#y[f] ?? null);
    A.uniform1i(s.prev, 0), A.uniform1i(s.cur, 1), A.uniform1i(s.next, 2), A.uniform2i(s.size, this.#m, this.#D), A.uniform1i(s.topFieldFirst, l ? 1 : 0), A.uniform1i(
      s.match,
      this.#ee === "p" ? 0 : this.#ee === "c" ? 1 : 2
    ), A.viewport(0, 0, this.#m, this.#D), A.drawArrays(A.TRIANGLES, 0, 3), e === null && (this.#f = { kind: "film" }, this.#M(!0), t && this.#I++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #tt(e, t, i) {
    const s = this.#He();
    if (s === null) return;
    const A = this.#w[s];
    if (A) {
      for (this.#$ = s; this.#t.length > 0 && this.#t[0]?.slot === s; )
        this.#t.shift(), this.#E.late++;
      this.#he(!1, e, A.framebuffer), this.#t.push({ slot: s, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #it(e, t, i) {
    const s = this.#t.at(-1), A = (q + 1) * Math.max(this.#H, i);
    if (s && s.at - t > A)
      return this.#t.length = 0, this.#E.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#t.length + e - q
    );
    let h = 0, n = 0;
    for (; n < r; ) {
      const l = this.#t.shift();
      if (!l) break;
      h += l.duration, n++;
    }
    for (const l of this.#t) l.at -= h;
    return this.#E.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #He() {
    const e = this.#f?.kind === "texture" ? this.#f.texture : null, t = new Set(this.#t.map(({ slot: s }) => s));
    for (let s = 1; s <= k; s++) {
      const A = (this.#$ + s) % k, r = this.#w[A];
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
  #J() {
    this.#B === null && (!this.#l || this.#T || (this.#ce = 0, this.#B = this.#st(this.#At)));
  }
  #Xe() {
    this.#B !== null && this.#Tt(this.#B), this.#B = null, this.#t.length = 0;
  }
  #At = (e) => {
    if (this.#B = null, !(!this.#l || this.#T)) {
      if (this.#ce > 0) {
        const t = e - this.#ce;
        t >= 1 && t <= V && (this.#H = t < this.#H ? t : this.#H + (t - this.#H) * Ee);
      }
      this.#ce = e, this.#n === "main" && this.#Rt(e), this.#B = this.#st(this.#At);
    }
  };
  /** ページと Worker のそれぞれが所有する requestAnimationFrame() へ表示ループを委ねる。 */
  #st(e) {
    return this.#c ? this.#c.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #Tt(e) {
    this.#c ? this.#c.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #Oe() {
    this.#c || this.#P !== null || !this.#l || this.#T || (this.#P = requestAnimationFrame(this.#rt));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Mt() {
    this.#P !== null && cancelAnimationFrame(this.#P), this.#P = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #rt = (e) => {
    this.#P = null, !(!this.#l || this.#T) && (this.#Ft(e), this.#P = requestAnimationFrame(this.#rt));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #Ft(e) {
    if (this.#c || e - this.#ue < ge || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#a >= j ? this.#a : ve, A = i > this.#Z, r = t > this.#z && e - this.#Fe >= s * 0.75;
    !A && !r || (this.#Z = Math.max(
      this.#Z,
      i
    ), this.#Fe = e, this.#$e(e, {
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
  #Rt(e) {
    const t = e + this.#H * 1.5;
    for (; this.#t[1] && this.#t[1].at <= t; )
      this.#E.late++, this.#t.shift();
    let i = this.#t[0];
    if (!i || i.at > t)
      return;
    this.#t.shift();
    const s = performance.now();
    this.#nt(i.slot), this.#ne += performance.now() - s, this.#re++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #nt(e) {
    const t = this.#w[e];
    t && this.#ze(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Ct() {
    this.#ot();
    const e = this.#y[this.#p];
    e && this.#ze(e, !0), this.#o = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #M(e) {
    if (this.#c) {
      this.#c.onVisibility(e);
      return;
    }
    this.#i.style.visibility = e ? "visible" : "hidden";
  }
  #ze(e, t = !1, i = !0) {
    const s = this.#A;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#b), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#N, 0), s.uniform1i(this.#W, t ? 1 : 0), s.viewport(0, 0, this.#m, this.#D), s.drawArrays(s.TRIANGLES, 0, 3), this.#f = { kind: "texture", texture: e, flip: t }, this.#M(!0), i && this.#I++;
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
  #St(e, t) {
    this.#U !== 0 && !t && (this.#E.missed += Math.max(0, e - this.#U - 1)), this.#U = e;
  }
  #kt(e) {
    const t = e - this.#me;
    if (t < te) return;
    const i = this.#Ee() && (this.#x || this.#F === "film") ? this.#re : this.#G, s = {
      ...this.#E,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#G === 0 ? 0 : (this.#se + this.#ne) / this.#G,
      maxQueuedFields: this.#V,
      mode: this.#F,
      match: this.#ee,
      combScore: this.#be,
      outputFps: this.#I * 1e3 / t,
      duplicateScore: this.#Te,
      duplicateRunnerUp: this.#Me
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#Ce?.(s), this.#me = e, this.#G = 0, this.#se = 0, this.#re = 0, this.#ne = 0, this.#V = 0, this.#I = 0;
  }
  /** Take the newest frame into the ring. */
  #ot() {
    const e = this.#A;
    this.#p = (this.#p + 1) % b, e.bindTexture(e.TEXTURE_2D, this.#y[this.#p] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#fe
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
  #he(e, t, i, s = !0) {
    if (this.#o === 0 || this.#T) return;
    s && (this.#o === b && !e ? this.#E.filtered++ : this.#E.degraded++);
    const A = this.#A, r = this.#p, h = (this.#p + b - 1) % b, n = (this.#p + 1) % b;
    let l, o, f;
    this.#o === 1 ? l = o = f = r : e ? (l = h, o = f = r) : this.#o === 2 ? (l = o = h, f = r) : (l = n, o = h, f = r), A.bindFramebuffer(A.FRAMEBUFFER, i), A.useProgram(this.#v);
    for (const [a, d] of [l, o, f].entries())
      A.activeTexture(A.TEXTURE0 + a), A.bindTexture(A.TEXTURE_2D, this.#y[d] ?? null);
    A.uniform1i(this.#r.prev, 0), A.uniform1i(this.#r.cur, 1), A.uniform1i(this.#r.next, 2), A.uniform2i(this.#r.size, this.#m, this.#D);
    const u = this.#pe ? 0 : 1;
    A.uniform1i(this.#r.parity, t ? 1 - u : u), A.uniform1i(this.#r.tff, this.#pe ? 1 : 0), A.uniform1i(this.#r.spatialCheck, this.#De ? 1 : 0), A.viewport(0, 0, this.#m, this.#D), A.drawArrays(A.TRIANGLES, 0, 3), i === null && (this.#f = { kind: "yadif", flush: e, second: t }, this.#M(!0), s && this.#I++);
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
  #ge() {
    if (!this.#X) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const s = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), A = t * s, r = i * s;
    this.#i.style.left = `${e.offsetLeft + (e.offsetWidth - A) / 2}px`, this.#i.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#i.style.width = `${A}px`, this.#i.style.height = `${r}px`;
  }
  #ht(e, t) {
    const i = this.#A;
    this.#u.width = e, this.#u.height = t, this.#m = e, this.#D = t, this.#o = 0, this.#f = null, this.#g(), this.#ge();
    for (const s of this.#y) i.deleteTexture(s);
    this.#y = [];
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
      ), this.#y.push(A);
    }
    this.#q(), this.#Ye(), this.#d && this.#at(), (this.#x || this.#d) && this.#Ze();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #at() {
    if (this.#L) return;
    const e = this.#A, t = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      T,
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
    this.#L = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(T * M * 4),
      previousLuma: new Uint8Array(T * M),
      currentLuma: new Uint8Array(T * M),
      nextLuma: new Uint8Array(T * M)
    };
  }
  #Ye() {
    this.#L && (this.#A.deleteFramebuffer(this.#L.framebuffer), this.#A.deleteTexture(this.#L.texture), this.#L = null);
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
  #Ze() {
    const e = this.#A;
    if (!(this.#w.length === k || this.#m === 0)) {
      this.#q();
      for (let t = 0; t < k; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#m,
          this.#D,
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
          e.deleteFramebuffer(s), e.deleteTexture(i), this.#q();
          return;
        }
        this.#w.push({ texture: i, framebuffer: s });
      }
      this.#$ = k - 1;
    }
  }
  #q() {
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
  #Lt() {
    if (this.#X) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#X = t, this.#ve?.observe(this.#e), this.#ge();
  }
  #Bt() {
    if (this.#c) return;
    const e = this.#X;
    this.#X = null, this.#ve?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #lt = () => this.#ge();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #Qe(e) {
    return !this.#s || this.#n === "main" ? !1 : (this.#s.postMessage({
      type: "event",
      name: e,
      video: this.#Ge()
    }), !0);
  }
  #ct = () => {
    if (this.#Qe("emptied")) {
      this.#R(), this.#M(!1);
      return;
    }
    this.#o = 0, this.#z = 0, this.#t.length = 0, this.#a = 0, this.#ut(), this.#g(), this.#f = null, this.#M(!1);
  };
  #ut() {
    this.#E = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#U = 0, this.#me = 0, this.#Pe = 0, this.#G = 0, this.#se = 0, this.#re = 0, this.#ne = 0, this.#V = 0, this.#I = 0, this.#g();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #g() {
    this.#t.length = 0, this.#F = "video", this.#ee = "c", this.#be = 0, this.#ye = !0, this.#xe.reset(), this.#Te = 1 / 0, this.#Me = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #ft = () => {
    if (this.#Qe("seeking")) {
      this.#R();
      return;
    }
    this.#te = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #C = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#Qe(e.type)) {
      this.#R();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#te;
      if (this.#te = !1, i) return;
      this.#o = 0, this.#g(), this.#f = null, this.#M(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#a = 0, this.#z = this.#e.currentTime), this.#t.length = 0, this.#l && this.#o > 0) {
      const i = this.#He(), s = i === null ? void 0 : this.#w[i];
      i !== null && s ? (this.#$ = i, this.#he(!0, !1, s.framebuffer), this.#nt(i)) : this.#he(!0, !1, null);
    }
    t && (this.#o = 0, this.#g());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #dt = (e) => {
    if (e.preventDefault(), this.#c) {
      this.#c.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#n !== "active" && (this.#T = !0, this.stop());
  };
}
function W(c, e) {
  const t = c.createProgram(), i = Ae(c, c.VERTEX_SHADER, De), s = Ae(c, c.FRAGMENT_SHADER, e);
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
const se = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", ye = 0.5, xe = 3e3, re = 0.1, I = 16, ne = 'video/mp4; codecs="avc1.640029"';
let K = null;
function Te(c = {}) {
  return K ??= Me(c), K;
}
async function Be(c = {}) {
  return (await Te(c)).deinterlaces;
}
function Pe() {
  K = null;
}
async function Me(c) {
  const e = c.tolerance ?? ye, t = c.timeoutMs ?? xe, i = performance.now(), s = (h) => ({
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
    r = Re(A, t);
    const h = O(X(A, "loadeddata"), t), n = A.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await h, await Ce(A, t, await n), A.videoWidth === 0 || A.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const l = Se(A);
    return {
      deinterlaces: l < 1 - e,
      survives: l,
      tookMs: performance.now() - i
    };
  } catch (h) {
    return s(h);
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
  const h = (async () => {
    await O(X(A, "sourceopen"), e);
    const n = A.addSourceBuffer(ne), l = O(X(n, "updateend"), e);
    n.appendBuffer(s), await l, A.endOfStream();
  })();
  return { url: r, ready: h };
}
async function Ce(c, e, t) {
  if (t) {
    const i = performance.now();
    for (; c.currentTime < re && performance.now() - i < e; )
      await new Promise((s) => requestAnimationFrame(s));
    c.pause();
  } else
    c.currentTime = re, await O(X(c, "seeked"), e);
}
function Se(c) {
  const e = c.videoHeight, t = document.createElement("canvas");
  t.width = I, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(c, 0, 0, I, e);
  const s = i.getImageData(0, 0, I, e).data, A = (o) => {
    let f = 0;
    for (let u = 0; u < I; u++)
      f += s[(o * I + u) * 4 + 1] ?? 0;
    return f / I;
  };
  let r = 0;
  const h = 2, n = e - 3;
  let l = A(h);
  for (let o = h + 1; o <= n; o++) {
    const f = A(o);
    r += Math.abs(f - l), l = f;
  }
  return r / (n - h) / 255;
}
function X(c, e) {
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
function O(c, e) {
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
de(he);
export {
  Le as Deinterlacer,
  ce as FILM_ANALYSIS_FRAGMENT_SHADER,
  fe as FILM_SAMPLE_FRAGMENT_SHADER,
  Q as FILM_UNIFORMS,
  ue as FILM_WEAVE_FRAGMENT_SHADER,
  le as YADIF_FRAGMENT_SHADER,
  ae as YADIF_UNIFORMS,
  Be as decoderDeinterlaces,
  Pe as forgetDecoderProbe,
  Te as probeDecoder,
  ke as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
