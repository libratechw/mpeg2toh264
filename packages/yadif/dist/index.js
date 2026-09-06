const le = "" + new URL("assets/worker-lbyVSV4o.js", import.meta.url).href, ce = {
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
`, j = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  topFieldFirst: "uTopFieldFirst",
  match: "uMatch"
}, x = 288, M = 162, ue = `#version 300 es
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
  #u;
  #i;
  #e;
  #s = 0;
  #D = null;
  #a = [];
  #M = null;
  #Z = 1 / 0;
  #Q = 1 / 0;
  constructor(e, t) {
    this.#u = e, this.#i = t, this.#e = 255 * b.DECIMATE_BLOCK ** 2 * b.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, A, s = b.COMBED_PIXEL_LIMIT) {
    const r = A ? 1 : 0, o = { p: e, c: t, n: i };
    let n = this.#I("c", "p", r, o);
    const l = /* @__PURE__ */ new Map(), h = (p) => {
      const w = l.get(p);
      if (w !== void 0) return w;
      const g = b.#U(
        this.weave(e, t, i, p, A),
        this.#u,
        this.#i
      );
      return l.set(p, g), g;
    }, u = h(n), f = h("n");
    (f * 3 < u || f * 2 < u && u > s) && Math.abs(f - u) >= 30 && f < s && (n = "n");
    const a = h(n), d = a >= s;
    return d && (n = "c"), {
      match: n,
      combScore: a,
      isCombed: d,
      luma: this.weave(e, t, i, n, A)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#s, i = this.#M ? b.#be(
      this.#M,
      e,
      this.#u,
      this.#i
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#a.push(i);
    const A = this.#D === t, s = A && i.maxBlockDifference < this.#e;
    A && !s && (this.#D = null);
    const r = this.#D;
    this.#M = e.slice(), this.#s++;
    let o = this.#D;
    if (this.#s === b.CYCLE) {
      let n = 0, l = null;
      for (let h = 1; h < this.#a.length; h++)
        (this.#a[h]?.maxBlockDifference ?? 1 / 0) < (this.#a[n]?.maxBlockDifference ?? 1 / 0) ? (l = n, n = h) : (l === null || (this.#a[h]?.maxBlockDifference ?? 1 / 0) < (this.#a[l]?.maxBlockDifference ?? 1 / 0)) && (l = h);
      this.#Z = this.#a[n]?.maxBlockDifference ?? 1 / 0, this.#Q = l === null ? 1 / 0 : this.#a[l]?.maxBlockDifference ?? 1 / 0, o = (this.#a[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#D = o, this.#a = [], this.#s = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: s,
      dropIndex: r,
      nextDropIndex: o,
      lowestCycleDifference: this.#Z,
      runnerUpCycleDifference: this.#Q
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, A, s) {
    if (A === "c") return t.slice();
    const r = t.slice(), o = A === "p" ? e : i, n = r.length / this.#i, l = s ? 1 : 0;
    for (let h = l; h < this.#i; h += 2)
      r.set(
        o.subarray(h * n, (h + 1) * n),
        h * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#s = 0, this.#D = null, this.#a = [], this.#M = null, this.#Z = 1 / 0, this.#Q = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #I(e, t, i, A) {
    const s = this.#u, r = this.#i, o = 2 - i, n = 2 - i, l = A[e], h = A[t], u = b.#ve(
      l,
      h,
      s,
      r,
      i
    );
    let f = 0, a = 0, d = 0, p = 0, w = 0, g = 0;
    for (let R = 2; R < r - 2; R += 2) {
      const D = (R - 2) / 2, Y = o - 1 + D * 2, Z = o + 1 + D * 2, Q = o + 3 + D * 2, O = o + D * 2, G = O + 2, L = n + D * 2, S = L + 2, $ = o + D * 2;
      for (let T = 8; T < s - 8; T++) {
        const C = (u[$ * s + T] ?? 0) | (u[($ + 2) * s + T] ?? 0);
        if (C === 0) continue;
        const ee = (A.c[Y * s + T] ?? 0) + ((A.c[Z * s + T] ?? 0) << 2) + (A.c[Q * s + T] ?? 0), _ = Math.abs(
          3 * ((l[O * s + T] ?? 0) + (l[G * s + T] ?? 0)) - ee
        ), B = Math.abs(
          3 * ((h[L * s + T] ?? 0) + (h[S * s + T] ?? 0)) - ee
        );
        _ > 23 && (C & 1) !== 0 && (f += _), B > 23 && (C & 1) !== 0 && (p += B), _ > 42 && (C & 2) !== 0 && (a += _), B > 42 && (C & 2) !== 0 && (w += B), _ > 42 && (C & 4) !== 0 && (d += _), B > 42 && (C & 4) !== 0 && (g += B);
      }
    }
    a < 500 && w < 500 && (d >= 500 || g >= 500) && Math.max(d, g) > 3 * Math.min(d, g) && (a = d, w = g);
    const v = Math.floor(f / 6 + 0.5), F = Math.floor(p / 6 + 0.5), E = Math.floor(a / 6 + 0.5), m = Math.floor(w / 6 + 0.5), I = Math.max(v, F) / Math.max(Math.min(v, F), 1), U = Math.max(E, m) / Math.max(Math.min(E, m), 1), N = Math.max(E, m) / Math.max(Math.max(v, F), 1);
    return (E >= 500 || m >= 500) && (E * 2 < m || m * 2 < E) || (E >= 1e3 || m >= 1e3) && (E * 3 < m * 2 || m * 3 < E * 2) || (E >= 2e3 || m >= 2e3) && (E * 5 < m * 4 || m * 5 < E * 4) || (E >= 4e3 || m >= 4e3) && U > I || N > 5e-3 && Math.max(E, m) > 150 && (E * 2 < m || m * 2 < E) ? E > m ? t : e : v > F ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #ve(e, t, i, A, s) {
    const r = Array.from(
      { length: Math.ceil(A / 2) },
      () => new Uint8Array(i)
    ), o = s === 1 ? 1 : 0;
    for (let h = 0; h < r.length; h++) {
      const u = Math.min(A - 1, o + h * 2), f = r[h];
      if (f)
        for (let a = 0; a < i; a++)
          f[a] = Math.abs(
            (e[u * i + a] ?? 0) - (t[u * i + a] ?? 0)
          );
    }
    const n = new Uint8Array(i * A), l = s === 1 ? 3 : 2;
    for (let h = 1; h < r.length - 1; h++) {
      const u = l + (h - 1) * 2;
      if (u >= A) break;
      const f = r[h];
      if (f)
        for (let a = 1; a < i - 1; a++) {
          const d = f[a] ?? 0;
          if (d <= 3) continue;
          let p = 0;
          for (let m = a - 1; m <= a + 1; m++)
            p += (r[h - 1]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[h]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[h + 1]?.[m] ?? 0) > 3 ? 1 : 0;
          if (p <= 1) continue;
          const w = u * i + a;
          if (n[w] = 1, d <= 19) continue;
          p = 0;
          let g = !1, v = !1;
          for (let m = a - 1; m <= a + 1; m++)
            (r[h - 1]?.[m] ?? 0) > 19 && (p++, g = !0), (r[h]?.[m] ?? 0) > 19 && p++, (r[h + 1]?.[m] ?? 0) > 19 && (p++, v = !0);
          if (p <= 3) continue;
          if (g && v) {
            n[w] |= 2;
            continue;
          }
          let F = !1, E = !1;
          for (let m = Math.max(a - 4, 0); m < Math.min(a + 5, i); m++)
            h !== 1 && (r[h - 2]?.[m] ?? 0) > 19 && (F = !0), (r[h - 1]?.[m] ?? 0) > 19 && (g = !0), (r[h + 1]?.[m] ?? 0) > 19 && (v = !0), h !== r.length - 2 && (r[h + 2]?.[m] ?? 0) > 19 && (E = !0);
          g && (v || F) || v && (g || E) ? n[w] |= 2 : p > 5 && (n[w] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #U(e, t, i) {
    const A = new Uint8Array(t * i), s = (o, n) => e[Math.max(0, Math.min(i - 1, n)) * t + o] ?? 0;
    for (let o = 0; o < i; o++)
      for (let n = 0; n < t; n++) {
        const l = s(n, o), h = s(n, o === 0 ? 1 : o - 1), u = s(n, o === i - 1 ? i - 2 : o + 1), f = o < 2 ? s(n, o === 0 ? 2 : 3) : s(n, o - 2), a = o + 2 >= i ? s(n, o === i - 1 ? i - 3 : i - 4) : s(n, o + 2);
        (o === 0 ? Math.abs(l - u) > b.COMB_THRESHOLD : o === i - 1 ? Math.abs(l - h) > b.COMB_THRESHOLD : Math.abs(l - h) > b.COMB_THRESHOLD && Math.abs(l - u) > b.COMB_THRESHOLD) && Math.abs(
          4 * l - 3 * (h + u) + f + a
        ) > b.COMB_THRESHOLD * 6 && (A[o * t + n] = 255);
      }
    let r = 0;
    for (const o of [0, 8])
      for (const n of [0, 8])
        for (let l = o; l < i; l += 16)
          for (let h = n; h < t; h += 16) {
            let u = 0;
            for (let f = Math.max(1, l); f < Math.min(i - 1, l + 16); f++)
              for (let a = h; a < Math.min(t, h + 16); a++) {
                const d = f * t + a;
                A[d - t] === 255 && A[d] === 255 && A[d + t] === 255 && u++;
              }
            r = Math.max(r, u);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #be(e, t, i, A) {
    const s = b.DECIMATE_BLOCK / 2, r = Math.ceil(i / s), o = Math.ceil(A / s), n = new Float64Array(r * o), l = e.length / (i * A);
    for (let f = 0; f < A; f++) {
      const a = Math.floor(f / s);
      for (let d = 0; d < i; d++) {
        const p = Math.floor(d / s), w = a * r + p, g = (f * i + d) * l;
        if (l === 1) {
          n[w] = (n[w] ?? 0) + Math.abs((e[g] ?? 0) - (t[g] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[g] ?? 0) * 0.2126 + (e[g + 1] ?? 0) * 0.7152 + (e[g + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (t[g] ?? 0) * 0.2126 + (t[g + 1] ?? 0) * 0.7152 + (t[g + 2] ?? 0) * 0.0722
        );
        if (n[w] = (n[w] ?? 0) + Math.abs(v - F), (d & 1) !== 0 || (f & 1) !== 0) continue;
        let E = 0, m = 0, I = 0, U = 0, N = 0, R = 0, D = 0;
        for (let G = f; G < Math.min(f + 2, A); G++)
          for (let L = d; L < Math.min(d + 2, i); L++) {
            const S = (G * i + L) * l;
            E += e[S] ?? 0, m += e[S + 1] ?? 0, I += e[S + 2] ?? 0, U += t[S] ?? 0, N += t[S + 1] ?? 0, R += t[S + 2] ?? 0, D++;
          }
        const Y = Math.round(
          (-0.114572 * E - 0.385428 * m + 0.5 * I) / D
        ), Z = Math.round(
          (-0.114572 * U - 0.385428 * N + 0.5 * R) / D
        ), Q = Math.round(
          (0.5 * E - 0.454153 * m - 0.045847 * I) / D
        ), O = Math.round(
          (0.5 * U - 0.454153 * N - 0.045847 * R) / D
        );
        n[w] = (n[w] ?? 0) + Math.abs(Y - Z) + Math.abs(Q - O);
      }
    }
    let h = -1;
    for (let f = 0; f < o - 1; f++)
      for (let a = 0; a < r - 1; a++)
        h = Math.max(
          h,
          (n[f * r + a] ?? 0) + (n[f * r + a + 1] ?? 0) + (n[(f + 1) * r + a] ?? 0) + (n[(f + 1) * r + a + 1] ?? 0)
        );
    let u = 0;
    for (const f of n) u += f;
    return { maxBlockDifference: h, totalDifference: u };
  }
}
let ae = null;
function pe(c) {
  ae = c;
}
const ge = 0.5, y = 3, q = 5, k = q + 1, te = 1e3, V = 4, X = 200, we = 0.25, Ee = 1e3 / 60, ve = 0.02, be = 250, ye = 1e3 / 30, De = 27, Te = 22, ie = 36, xe = 0.8, Me = 250, Fe = 6e3, se = 45, Se = 0.8, Re = 300 * 1e3, Ce = 90;
function Ae(c) {
  if (!Number.isFinite(c) || c < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return c;
}
const ke = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, Le = `#version 300 es
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
function Oe() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class Xe extends EventTarget {
  #u;
  #i;
  #e;
  #s;
  #D;
  #a;
  /** The program that copies a filtered picture onto the canvas. */
  #M;
  #Z;
  #Q;
  /** The reduced pass that reads previous, current and next luma together. */
  #I = null;
  #ve = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #U = null;
  #be = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #ne = null;
  #nt = null;
  #N = null;
  #F = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #E = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #he = k - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #d = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #t = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #G = null;
  #ye = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #W = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #j = Ee;
  /**
   * Recent page-side rAF gaps from the frame watchdog, oldest first.
   * This is the observable page cadence the surface trial decides on: stuck
   * near 33.3 ms in the bad state, near 16.7 ms after a 30-to-60 Hz recovery.
   */
  #c = [];
  /** The watchdog timestamp the current gap is measured from; 0 before any. */
  #k = 0;
  /**
   * The lazily created 1x1 CSS-pixel surface. Page-owned so it composites even
   * while Worker rendering is active; null unless a trial or latched session
   * is running.
   */
  #O = null;
  /** The 250 ms toggle driving the surface; null unless trial/latched. */
  #V = null;
  /** Which side of the visible toggle the surface currently shows. */
  #J = !1;
  /** Whether the surface is proving itself, kept, or absent. */
  #g = "off";
  /** When the current bounded trial started, on the rAF clock. */
  #ht = 0;
  /** When a failed trial may be retried, on the rAF clock. */
  #Pe = 0;
  /**
   * The Worker's film/video cadence as last reported via stats, unknown until
   * the first notification. Page-side #mode never moves while Worker rendering
   * is active (frames are filtered in the Worker), so the trial reads this
   * copy and requires a confirmed "video": a long film section would otherwise
   * satisfy the slow page-rAF window before the Worker has reported anything.
   */
  #q = "unknown";
  /** The `<div>` this put around the element, so it can be taken away again. */
  #L = null;
  #Ie;
  #v;
  #m;
  #K;
  #Ue;
  #S = "video";
  #oe = "c";
  #Ne = 0;
  #Ge = !0;
  #We = new b(x, M);
  #Oe = 1 / 0;
  #Xe = 1 / 0;
  #X = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #f = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #p = 0;
  #T = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #w = y - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #l = 0;
  #ae = 0;
  #De = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #le = !1;
  #$ = null;
  /** requestVideoFrameCallback() の停止を検出するために保持する最終通知時刻。 */
  #Te = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #ee = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #He = 0;
  #r = !1;
  #xe = !1;
  #Me = !1;
  #n = null;
  #te = [];
  #x = !1;
  #ze;
  #h;
  #Fe;
  #_;
  #Ye;
  #o = null;
  #A;
  #ce = !1;
  #Ze = 0;
  #Qe = !1;
  #Ct = 0;
  #fe = !1;
  #Se = !1;
  #ie = null;
  #kt = 0;
  #ue = /* @__PURE__ */ new Map();
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
  #je = 0;
  #Re = 0;
  #z = 0;
  #de = 0;
  #me = 0;
  #pe = 0;
  #se = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#v = t.doubleRate ?? !1, this.#m = t.autoFilm ?? !1, this.#K = Ae(
      t.filmCombThreshold ?? b.COMBED_PIXEL_LIMIT
    ), this.#Ue = t.spatialCheck ?? !0, this.#ze = t.onStats, this.#h = i, this.#_ = i ? "main" : t.rendering ?? "auto", this.#Ye = t.workerUrl ?? ae, this.#A = this.#_ === "main" ? "main" : "idle", this.#i = i ? i.canvas : document.createElement("canvas"), this.#u = i?.canvas ?? (this.#_ === "main" ? this.#i : document.createElement("canvas")), this.#Fe = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const A = this.#u.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!A) throw new Error("this browser has no WebGL2");
    this.#s = A, this.#D = W(A, fe);
    const s = this.#D;
    this.#a = Object.fromEntries(
      Object.entries(ce).map(([r, o]) => [
        r,
        A.getUniformLocation(s, o)
      ])
    ), this.#M = W(A, Le), this.#Z = A.getUniformLocation(this.#M, "uField"), this.#Q = A.getUniformLocation(this.#M, "uFlip"), this.#m && this.#ut(), this.#u.addEventListener(
      "webglcontextlost",
      this.#Rt
    ), this.#Ie = i ? null : new ResizeObserver(() => this.#Be()), e.addEventListener("emptied", this.#Mt), e.addEventListener("resize", this.#xt), e.addEventListener("pause", this.#P), e.addEventListener("ended", this.#P), e.addEventListener("seeking", this.#St), e.addEventListener("seeked", this.#P), e.addEventListener("ratechange", this.#P), !i && typeof document < "u" && document.addEventListener("visibilitychange", this.#vt);
  }
  get running() {
    return this.#r && (this.#n?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#i;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #Ce() {
    return this.#n?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #ot() {
    return {
      doubleRate: this.#v,
      autoFilm: this.#m,
      filmCombThreshold: this.#K,
      spatialCheck: this.#Ue
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#xe;
  }
  set enabled(e) {
    this.#xe = e, this.#Je(), this.#o?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#n?.interlaced !== e?.interlaced, i = t || this.#n?.topFieldFirst !== e?.topFieldFirst;
    this.#n = e, this.#o?.postMessage({ type: "scan", scan: e }), i && (this.#l = 0, this.#y(), t && (this.#f = 0), this.#d = null, this.#C(!1), e?.interlaced !== !0 ? this.#R(!0) : t && (this.#c.length = 0, this.#k = 0, this.#q = "unknown")), this.#Je(), i && ((e?.interlaced ?? !0) && (this.#h || this.#A === "main") ? this.#Ae() : this.#et());
  }
  get scan() {
    return this.#n;
  }
  set videoTimeline(e) {
    this.#te = e, this.#o?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#n = null), this.#Je();
  }
  get videoTimeline() {
    return this.#te;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#L ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#v;
  }
  set doubleRate(e) {
    e !== this.#v && (this.#v = e, this.#Ve(), this.#t.length = 0, e || this.#R(!1), e ? (this.#p > 0 && this.#At(), (this.#n?.interlaced ?? !0) && (this.#h || this.#A === "main") && this.#Ae()) : this.#m || (this.#d = null, this.#C(!1), this.#re()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#m;
  }
  set autoFilm(e) {
    e !== this.#m && (this.#m = e, this.#Ve(), this.#y(), e ? (this.#ut(), this.#p > 0 && (this.#Tt(), this.#At()), (this.#n?.interlaced ?? !0) && (this.#h || this.#A === "main") && this.#Ae()) : (this.#st(), this.#v || (this.#d = null, this.#C(!1), this.#re())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#K;
  }
  set filmCombThreshold(e) {
    const t = Ae(e);
    t !== this.#K && (this.#K = t, this.#Ve(), this.#m && this.#y());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Ve() {
    this.#o?.postMessage({
      type: "settings",
      options: this.#ot()
    });
  }
  #Je() {
    this.#xe && (this.#te.length > 0 || (this.#n?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #Lt() {
    return this.#h || this.#_ === "main" ? !1 : this.#A === "starting" || this.#A === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Ye !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#at(), !0) : this.#_ === "auto" ? (this.#ke(), !1) : (this.#A = "failed", this.#r = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #at() {
    this.#B(), this.#o?.terminate(), this.#o = null, this.#fe = !1, this.#Se = !1;
    let e = this.#i;
    if (this.#Qe) {
      e = document.createElement("canvas"), e.className = this.#i.className;
      const s = this.#i.getAttribute("style");
      s === null ? e.removeAttribute("style") : e.setAttribute("style", s), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e;
    }
    const t = ++this.#Ze;
    this.#A = "starting";
    let i, A;
    try {
      A = e.transferControlToOffscreen(), this.#Qe = !0, i = new Worker(this.#Ye, { type: "module" });
    } catch (s) {
      this.#ge(
        s instanceof Error ? s.message : String(s)
      );
      return;
    }
    this.#o = i, i.onmessage = (s) => {
      t === this.#Ze && this.#_t(s.data);
    }, i.onerror = (s) => {
      t === this.#Ze && (s.preventDefault(), this.#ge(s.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: A,
        options: this.#ot(),
        scan: this.#n,
        videoTimeline: this.#te,
        enabled: this.#r,
        video: this.#qe()
      },
      [A]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #_t(e) {
    switch (e.type) {
      case "ready":
        this.#A = "active", this.#r && (this.#we(), this.#tt());
        break;
      case "failed":
        this.#ge(e.message);
        break;
      case "consumed": {
        this.#fe = !1, this.#Se = !0;
        const t = this.#ie;
        this.#ie = null, t && this.#ct(t);
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
        this.#q = e.stats.mode, this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#ze?.(t);
        break;
      }
      case "capture": {
        const t = this.#ue.get(e.id);
        if (this.#ue.delete(e.id), !t) {
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
    if (this.#R(!0), this.#A === "starting" && this.#_ === "auto" && !this.#ce) {
      this.#ke();
      return;
    }
    if (this.#lt(e), !this.#ce) {
      this.#ce = !0, this.#at();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#A = "failed", this.#o?.terminate(), this.#o = null, this.#B(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #ke() {
    this.#R(!0);
    const e = this.#u;
    e.className = this.#i.className;
    const t = this.#i.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e, this.#Qe = !1, this.#o?.terminate(), this.#o = null, this.#A = "main", this.#B(), this.#r && (this.#we(), this.#tt(), (this.#n?.interlaced ?? !0) && this.#Ae());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #B() {
    this.#ie?.frame.close(), this.#ie = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #lt(e) {
    for (const t of this.#ue.values())
      t.reject(new Error(e));
    this.#ue.clear();
  }
  start() {
    if (!(this.#r || this.#Me || this.#x)) {
      if (this.#r = !0, this.#Ft(), this.#y(), this.#R(!0), this.#Te = performance.now(), this.#He = this.#Te, this.#De = Number.NaN, this.#ee = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#ii(), this.#tt(), this.#Lt()) {
        this.#o?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#A === "active" && this.#we();
        return;
      }
      this.#we(), (this.#n?.interlaced ?? !0) && this.#Ae();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#r && (this.#r = !1, this.#R(!1), this.#$ !== null && this.#e.cancelVideoFrameCallback(this.#$), this.#$ = null, this.#Ot(), this.#et(), this.#l = 0, this.#d = null, this.#C(!1), this.#B(), this.#o?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#Me) {
      this.#Me = !0, this.#xe = !1, this.stop(), this.#R(!1), typeof document < "u" && document.removeEventListener(
        "visibilitychange",
        this.#vt
      ), this.#o?.postMessage({ type: "destroy" }), this.#o?.terminate(), this.#o = null, this.#B(), this.#lt("the deinterlacer was destroyed"), this.#u.removeEventListener(
        "webglcontextlost",
        this.#Rt
      ), this.#e.removeEventListener("emptied", this.#Mt), this.#e.removeEventListener("resize", this.#xt), this.#e.removeEventListener("pause", this.#P), this.#e.removeEventListener("ended", this.#P), this.#e.removeEventListener("seeking", this.#St), this.#e.removeEventListener("seeked", this.#P), this.#e.removeEventListener("ratechange", this.#P), this.#si();
      for (const e of this.#F) this.#s.deleteTexture(e);
      this.#F = [], this.#re(), this.#st(), this.#s.deleteProgram(this.#D), this.#s.deleteProgram(this.#M), this.#I && this.#s.deleteProgram(this.#I), this.#U && this.#s.deleteProgram(this.#U), this.#ne && this.#s.deleteProgram(this.#ne), this.#s.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#A === "active" && this.#i.style.visibility === "visible" && this.#o) {
      const A = ++this.#kt, s = new Promise((r, o) => {
        this.#ue.set(A, { resolve: r, reject: o });
      });
      return this.#o.postMessage({
        type: "capture",
        id: A,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), s;
    }
    if (this.#A === "starting" || this.#A === "failed")
      return createImageBitmap(this.#e);
    const e = this.#d;
    if (this.#h && (!this.#r || this.#x || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#r || this.#x || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#it(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#Ee(e.flush, e.second, null, !1) : this.#Ke(null, !1);
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
    this.#h || !this.#r || this.#$ !== null || (this.#$ = this.#e.requestVideoFrameCallback(this.#Pt));
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #qe() {
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
  #Bt(e, t) {
    let i;
    try {
      i = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (s) {
      const r = s instanceof Error ? s.message : String(s);
      this.#_ === "auto" && !this.#Se && !this.#ce ? (this.#ke(), this.#Le(e, t)) : this.#ge(r);
      return;
    }
    const A = {
      id: ++this.#Ct,
      frame: i,
      now: e,
      metadata: t,
      video: this.#qe()
    };
    if (this.#fe) {
      this.#ie?.frame.close(), this.#ie = A;
      return;
    }
    this.#ct(A);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #ct(e) {
    const t = this.#o;
    if (!t || this.#A !== "active") {
      e.frame.close();
      return;
    }
    this.#fe = !0;
    const i = { type: "frame", ...e };
    try {
      t.postMessage(i, [e.frame]);
    } catch (A) {
      this.#fe = !1, e.frame.close();
      const s = A instanceof Error ? A.message : String(A);
      this.#_ === "auto" && !this.#Se && !this.#ce ? (this.#ke(), this.#Le(e.now, e.metadata)) : this.#ge(s);
    }
  }
  #Pt = (e, t) => {
    this.#$ = null, !(!this.#r || this.#x) && (this.#Te = e, this.#ee = Math.max(
      this.#ee,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#ft(e, t), this.#we());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #ft(e, t) {
    if (this.#De = t.mediaTime, this.#A === "active") {
      this.#Bt(e, t);
      return;
    }
    this.#A !== "starting" && this.#Le(e, t);
  }
  /** @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。 */
  ingestExternalFrame(e, t, i) {
    this.#Fe = i;
    try {
      this.#Le(e, t);
    } finally {
      this.#Fe = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #Le(e, t) {
    if (this.#It(t.mediaTime), t.width > 0 && t.height > 0) {
      let i = !1;
      if (!this.#le && this.#e.seeking) {
        const a = this.#e.buffered, d = this.#f >= V ? this.#f / 1e3 : X / 1e3;
        for (let p = 0; p < a.length; p++)
          if (t.mediaTime >= a.start(p) && t.mediaTime < a.end(p) && Math.abs(t.mediaTime - this.#e.currentTime) <= d) {
            i = !0;
            break;
          }
      }
      if (i && (this.#le = !0), (this.#p === 0 || this.#T === 0) && this.#Dt(t.width, t.height), this.#n && !this.#n.interlaced) {
        this.#$t();
        return;
      }
      const A = t.mediaTime - this.#ae, s = i || A < 0 || A > ge;
      s && (this.#l = 0, this.#f = 0, this.#b.discontinuities++, this.#t.length = 0, this.#y());
      const r = this.#m && this.#H !== 0 && t.presentedFrames - this.#H > 1;
      if (this.#ei(t.presentedFrames, s), !s && r && (this.#l = 0, this.#y()), this.#l > 0 && t.mediaTime === this.#ae)
        return;
      !s && A > 0 && this.#Ut(A), this.#ae = t.mediaTime;
      const o = performance.now();
      o - this.#je > te && (this.#Re = o, this.#z = 0, this.#de = 0, this.#me = 0, this.#pe = 0, this.#se = 0, this.#X = 0), this.#je = o;
      const n = performance.now();
      this.#yt();
      const l = this.#S, h = this.#m && this.#l === y && this.#Nt();
      if (l !== this.#S && (this.#t.length = 0), !(h && this.#_e())) if (this.#m && !this.#Ge && this.#S === "film")
        if (this.#_e()) {
          const a = this.#f * 5 / 4, d = this.#mt(1, e, a), p = this.#t.at(-1), w = d ? e : p == null ? e + a : p.at + p.duration;
          this.#Gt(w, a);
        } else
          this.#Ke(null);
      else if (this.#v && this.#_e()) {
        const a = this.#f / 2, d = this.#mt(2, e, a), p = this.#t.at(-1), w = d ? e : p == null ? e + a * 2 : p.at + p.duration;
        this.#dt(!1, w, a), this.#dt(!0, w + a, a);
      } else
        this.#b.late += this.#t.length, this.#t.length = 0, this.#Ee(!1, !1, null);
      this.#se = Math.max(
        this.#se,
        this.#t.length
      ), this.#de += performance.now() - n, this.#z++, this.#ti(o);
    }
  }
  #It(e) {
    let t;
    for (let s = this.#te.length - 1; s >= 0; s--) {
      const r = this.#te[s];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#p || t.codedSize.height !== this.#T) && this.#Dt(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#n?.interlaced === i.interlaced && this.#n.topFieldFirst === i.topFieldFirst)
      return;
    const A = this.#n?.interlaced;
    this.#n = i, this.#l = 0, this.#t.length = 0, this.#y(), A !== i.interlaced && (this.#f = 0), i.interlaced !== !0 ? this.#R(!0) : A !== !0 && (this.#c.length = 0, this.#k = 0, this.#q = "unknown"), i.interlaced && (this.#h || this.#A === "main") ? this.#Ae() : this.#et();
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #_e() {
    return (this.#v || this.#m) && this.#f > 0 && this.#E.length === k;
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
  #Ut(e) {
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#f > 0 ? Math.max(1, Math.round(t / this.#f)) : 1, A = t / i;
    A < V || A > X || (this.#f = this.#f > 0 ? this.#f + (A - this.#f) * we : A);
  }
  /** Build the optional film passes only for callers that enable them. */
  #ut() {
    if (this.#I && this.#U && this.#ne) return;
    const e = this.#s, t = W(e, ue), i = W(e, de), A = W(e, me);
    this.#I = t, this.#ve = Object.fromEntries(
      Object.entries(j).filter(([s]) => s !== "match" && s !== "topFieldFirst").map(([s, r]) => [s, e.getUniformLocation(t, r)])
    ), this.#U = i, this.#be = Object.fromEntries(
      Object.entries(j).map(([s, r]) => [
        s,
        e.getUniformLocation(i, r)
      ])
    ), this.#ne = A, this.#nt = Object.fromEntries(
      Object.entries(j).map(([s, r]) => [
        s,
        e.getUniformLocation(A, r)
      ])
    );
  }
  /**
   * Run FFmpeg's fieldmatch and live decimate decisions on reduced luma.
   * Full decoded frames remain in GPU textures, while the first readback packs
   * the previous, current and next luma proxies into RGB. A second readback
   * supplies the selected RGB weave to its chroma-sensitive decimate metric.
   */
  #Nt() {
    const e = this.#N, t = this.#I, i = this.#ve, A = this.#ne, s = this.#nt;
    if (!e || !t || !i || !A || !s)
      return !1;
    const r = this.#s, o = this.#w, n = (this.#w + y - 1) % y, l = (this.#w + 1) % y, h = this.#Ce;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [g, v] of [l, n, o].entries())
      r.activeTexture(r.TEXTURE0 + g), r.bindTexture(r.TEXTURE_2D, this.#F[v] ?? null);
    r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#p, this.#T), r.viewport(0, 0, x, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      x,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: u, currentLuma: f, nextLuma: a } = e;
    for (let g = 0; g < u.length; g++) {
      const v = g * 4;
      u[g] = e.pixels[v] ?? 0, f[g] = e.pixels[v + 1] ?? 0, a[g] = e.pixels[v + 2] ?? 0;
    }
    const d = this.#We.fieldMatch(
      u,
      f,
      a,
      h,
      this.#K
    );
    r.useProgram(A), r.uniform1i(s.prev, 0), r.uniform1i(s.cur, 1), r.uniform1i(s.next, 2), r.uniform2i(s.size, this.#p, this.#T), r.uniform1i(s.topFieldFirst, h ? 1 : 0), r.uniform1i(
      s.match,
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
    const p = this.#We.decimate(e.pixels);
    this.#oe = d.match, this.#Ne = d.combScore, this.#Ge = d.isCombed, this.#Oe = p.lowestCycleDifference, this.#Xe = p.runnerUpCycleDifference;
    const w = p.dropIndex !== null && !d.isCombed;
    return (w ? "film" : "video") !== this.#S && (this.#S = w ? "film" : "video"), p.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Gt(e, t) {
    const i = this.#$e();
    if (i === null) return;
    const A = this.#E[i];
    if (A) {
      for (this.#he = i; this.#t.length > 0 && this.#t[0]?.slot === i; )
        this.#t.shift(), this.#b.late++;
      this.#Ke(A.framebuffer), this.#t.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Ke(e, t = !0) {
    const i = this.#U, A = this.#be;
    if (!i || !A) return;
    const s = this.#s, r = this.#w, o = (this.#w + y - 1) % y, n = (this.#w + 1) % y, l = this.#Ce;
    s.bindFramebuffer(s.FRAMEBUFFER, e), s.useProgram(i);
    for (const [h, u] of [n, o, r].entries())
      s.activeTexture(s.TEXTURE0 + h), s.bindTexture(s.TEXTURE_2D, this.#F[u] ?? null);
    s.uniform1i(A.prev, 0), s.uniform1i(A.cur, 1), s.uniform1i(A.next, 2), s.uniform2i(A.size, this.#p, this.#T), s.uniform1i(A.topFieldFirst, l ? 1 : 0), s.uniform1i(
      A.match,
      this.#oe === "p" ? 0 : this.#oe === "c" ? 1 : 2
    ), s.viewport(0, 0, this.#p, this.#T), s.drawArrays(s.TRIANGLES, 0, 3), e === null && (this.#d = { kind: "film" }, this.#C(!0), t && this.#X++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #dt(e, t, i) {
    const A = this.#$e();
    if (A === null) return;
    const s = this.#E[A];
    if (s) {
      for (this.#he = A; this.#t.length > 0 && this.#t[0]?.slot === A; )
        this.#t.shift(), this.#b.late++;
      this.#Ee(!1, e, s.framebuffer), this.#t.push({ slot: A, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #mt(e, t, i) {
    const A = this.#t.at(-1), s = (q + 1) * Math.max(this.#j, i);
    if (A && A.at - t > s)
      return this.#t.length = 0, this.#b.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#t.length + e - q
    );
    let o = 0, n = 0;
    for (; n < r; ) {
      const l = this.#t.shift();
      if (!l) break;
      o += l.duration, n++;
    }
    for (const l of this.#t) l.at -= o;
    return this.#b.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #$e() {
    const e = this.#d?.kind === "texture" ? this.#d.texture : null, t = new Set(this.#t.map(({ slot: A }) => A));
    for (let A = 1; A <= k; A++) {
      const s = (this.#he + A) % k, r = this.#E[s];
      if (r && r.texture !== e && !t.has(s))
        return s;
    }
    const i = this.#t[0];
    if (i) {
      const A = this.#E[i.slot];
      if (A && A.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #Ae() {
    this.#G === null && (!this.#r || this.#x || (this.#ye = 0, this.#G = this.#gt(this.#pt)));
  }
  #et() {
    this.#G !== null && this.#Wt(this.#G), this.#G = null, this.#t.length = 0;
  }
  #pt = (e) => {
    if (this.#G = null, !(!this.#r || this.#x)) {
      if (this.#ye > 0) {
        const t = e - this.#ye;
        t >= 1 && t <= X && (this.#j = t < this.#j ? t : this.#j + (t - this.#j) * ve);
      }
      this.#ye = e, this.#A === "main" && this.#Kt(e), this.#G = this.#gt(this.#pt);
    }
  };
  /** ページと Worker のそれぞれが所有する requestAnimationFrame() へ表示ループを委ねる。 */
  #gt(e) {
    return this.#h ? this.#h.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #Wt(e) {
    this.#h ? this.#h.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #tt() {
    this.#h || this.#W !== null || !this.#r || this.#x || (this.#W = requestAnimationFrame(this.#wt));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Ot() {
    this.#W !== null && cancelAnimationFrame(this.#W), this.#W = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #wt = (e) => {
    this.#W = null, !(!this.#r || this.#x) && (this.#Ht(e), this.#qt(e), this.#W = requestAnimationFrame(this.#wt));
  };
  /**
   * Whether a surface trial may even be considered on this tick.
   *
   * Running, visible, interlaced, double-rate playback with the Worker backend
   * active is the only eligible shape: the main-thread renderer draws on the
   * page rAF itself, film cadence has no 60 Hz field schedule to rescue,
   * progressive content needs no deinterlacing, and paused/ended or hidden
   * playback produces no meaningful cadence. The cooldown gate keeps true
   * 30 Hz displays -- which also sit at 33.3 ms -- from paying for repeated
   * trials. No device, vendor, UA, or platform signal is consulted.
   */
  #Xt(e) {
    return !(this.#h || typeof document > "u" || !this.#r || this.#Me || this.#x || this.#A !== "active" || !this.#v || this.#n?.interlaced !== !0 || this.#q !== "video" || this.#S === "film" || document.hidden || this.#e.paused || this.#e.ended || e < this.#Pe);
  }
  /**
   * Track the page-side rAF cadence and drive the bounded surface trial.
   *
   * The watchdog's own rAF timestamps are the page cadence signal: stuck near
   * 33.3 ms in the bad state, near 16.7 ms after a 30-to-60 Hz recovery. Off
   * collects gaps until a stable slow window justifies a trial, trial toggles
   * the 1x1 surface while watching for sustained fast gaps, and on keeps the
   * proven surface for the session. A trial that runs its bounded length
   * without recovery is removed and enters cooldown.
   */
  #Ht(e) {
    if (!(this.#h || typeof document > "u")) {
      if (this.#k > 0) {
        const t = e - this.#k;
        t >= 1 && t <= X && (this.#c.push(t), this.#c.length > Ce && this.#c.shift());
      }
      if (this.#k = e, document.hidden) {
        this.#g !== "off" && this.#Y(), this.#c.length = 0;
        return;
      }
      if (!this.#Xt(e)) {
        if (this.#g !== "off" && this.#Y(), this.#g === "off" && this.#c.length > 0) {
          const t = e < this.#Pe, i = !this.#r || this.#e.paused || this.#e.ended || this.#n?.interlaced !== !0 || !this.#v || this.#A !== "active" || this.#S === "film" || this.#q !== "video";
          (t || i) && (this.#c.length = 0);
        }
        return;
      }
      this.#g === "off" ? this.#zt() && this.#Zt(e) : this.#g === "trial" && (this.#Yt() ? this.#Qt() : e - this.#ht >= Fe && this.#jt(e));
    }
  }
  /** Whether recent page gaps sit stably near the stuck 30 Hz cadence. */
  #zt() {
    if (this.#c.length < ie) return !1;
    const e = this.#c.slice(-ie);
    let t = 0;
    for (const i of e) i >= De && t++;
    return t / e.length >= xe;
  }
  /** Whether recent page gaps show sustained recovery toward ~60 Hz. */
  #Yt() {
    if (this.#c.length < se) return !1;
    const e = this.#c.slice(-se);
    let t = 0;
    for (const i of e) i <= Te && t++;
    return t / e.length >= Se;
  }
  /** Begin the bounded trial: lazily create the surface and toggle it. */
  #Zt(e) {
    this.#g !== "off" || !this.#Vt() || (this.#g = "trial", this.#ht = e, this.#J = !1, this.#Et(), this.#V !== null && clearInterval(this.#V), this.#V = setInterval(
      () => this.#Jt(),
      Me
    ));
  }
  /** Keep the surface for the session: the trial proved a 60 Hz recovery. */
  #Qt() {
    this.#g === "trial" && (this.#g = "on");
  }
  /**
   * End a trial that proved nothing: remove the surface and back off.
   * True 30 Hz displays never recover, so the bounded cooldown keeps them
   * from paying for back-to-back trials.
   */
  #jt(e) {
    this.#Y(), this.#Pe = e + Re, this.#c.length = 0, this.#k = e;
  }
  /** Clear the timer and remove the page-owned element, if any. */
  #Y() {
    this.#V !== null && (clearInterval(this.#V), this.#V = null), this.#O?.remove(), this.#O = null, this.#g = "off", this.#J = !1;
  }
  /**
   * Abort any surface trial and restart page-cadence observation from scratch.
   * When `forgetCadence` is set, the Worker cadence also returns to unknown so
   * the next trial needs a fresh video confirmation via stats: a new Worker, a
   * new scan section, or a new stream. Transient interruptions (pause, ended,
   * rate toggles, teardown) keep the confirmed cadence and only restart the
   * gaps, so an eligible session does not wait for stats twice.
   */
  #R(e) {
    this.#g !== "off" && this.#Y(), this.#c.length = 0, this.#k = 0, e && (this.#q = "unknown");
  }
  /**
   * Lazily create the page-owned 1x1 CSS-pixel surface.
   *
   * It must actually reach composition: fully opaque, visible, non-zero size,
   * with background and transform toggled every 250 ms. display:none,
   * visibility:hidden, zero opacity, or a no-op timer are not substitutes --
   * the measured prevention required a real composed update. It lives inside
   * the deinterlacer wrapper (or body before mount) with pointer-events none
   * and absolute/fixed 1x1 placement, so it intercepts no input, disturbs no
   * layout, and stays inside the fullscreen container.
   */
  #Vt() {
    if (typeof document > "u") return null;
    if (this.#O) return this.#O;
    const e = this.#L ?? document.body;
    if (!e) return null;
    const t = document.createElement("div");
    return t.setAttribute("data-mpeg2toh264-surface", "true"), t.style.cssText = this.#L ? "position:absolute;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;pointer-events:none;opacity:1;visibility:visible;transform:translateZ(0);background-color:rgb(0,0,0);" : "position:fixed;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;pointer-events:none;opacity:1;visibility:visible;transform:translateZ(0);background-color:rgb(0,0,0);z-index:2147483647;", e.appendChild(t), this.#O = t, t;
  }
  /** Flip the visible surface phase; the composition is the workaround. */
  #Jt() {
    if (!(!this.#O || this.#g === "off")) {
      if (typeof document < "u" && document.hidden) {
        this.#Y(), this.#c.length = 0;
        return;
      }
      if (!this.#r || this.#e.paused || this.#e.ended) {
        this.#Y(), this.#c.length = 0;
        return;
      }
      this.#J = !this.#J, this.#Et();
    }
  }
  /** Apply the current toggle phase as a composited style change. */
  #Et() {
    const e = this.#O;
    e && (e.style.backgroundColor = this.#J ? "rgb(1,0,0)" : "rgb(0,0,0)", e.style.transform = this.#J ? "translateZ(0) translateX(1px)" : "translateZ(0)");
  }
  /** Hidden pages run no rAF: never leave the surface behind in background. */
  #vt = () => {
    if (!(typeof document > "u")) {
      if (!document.hidden) {
        this.#c.length = 0, this.#k = 0;
        return;
      }
      this.#g !== "off" && this.#Y(), this.#c.length = 0, this.#k = 0;
    }
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #qt(e) {
    if (this.#h || e - this.#Te < be || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, A = this.#f >= V ? this.#f : ye, s = i > this.#ee, r = t !== this.#De && e - this.#He >= A * 0.75;
    !s && !r || (this.#ee = Math.max(
      this.#ee,
      i
    ), this.#He = e, this.#ft(e, {
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
  #Kt(e) {
    const t = e + this.#j * 1.5;
    for (; this.#t[1] && this.#t[1].at <= t; )
      this.#b.late++, this.#t.shift();
    let i = this.#t[0];
    if (!i || i.at > t)
      return;
    this.#t.shift();
    const A = performance.now();
    this.#bt(i.slot), this.#pe += performance.now() - A, this.#me++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #bt(e) {
    const t = this.#E[e];
    t && this.#it(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #$t() {
    this.#yt();
    const e = this.#F[this.#w];
    e && this.#it(e, !0), this.#l = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #C(e) {
    if (this.#h) {
      this.#h.onVisibility(e);
      return;
    }
    this.#i.style.visibility = e ? "visible" : "hidden";
  }
  #it(e, t = !1, i = !0) {
    const A = this.#s;
    A.bindFramebuffer(A.FRAMEBUFFER, null), A.useProgram(this.#M), A.activeTexture(A.TEXTURE0), A.bindTexture(A.TEXTURE_2D, e), A.uniform1i(this.#Z, 0), A.uniform1i(this.#Q, t ? 1 : 0), A.viewport(0, 0, this.#p, this.#T), A.drawArrays(A.TRIANGLES, 0, 3), this.#d = { kind: "texture", texture: e, flip: t }, this.#C(!0), i && this.#X++;
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
  #ei(e, t) {
    this.#H !== 0 && !t && (this.#b.missed += Math.max(0, e - this.#H - 1)), this.#H = e;
  }
  #ti(e) {
    const t = e - this.#Re;
    if (t < te) return;
    const i = this.#_e() && (this.#v || this.#S === "film") ? this.#me : this.#z, A = {
      ...this.#b,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#z === 0 ? 0 : (this.#de + this.#pe) / this.#z,
      maxQueuedFields: this.#se,
      mode: this.#S,
      match: this.#oe,
      combScore: this.#Ne,
      outputFps: this.#X * 1e3 / t,
      duplicateScore: this.#Oe,
      duplicateRunnerUp: this.#Xe
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: A })), this.#ze?.(A), this.#Re = e, this.#z = 0, this.#de = 0, this.#me = 0, this.#pe = 0, this.#se = 0, this.#X = 0;
  }
  /** Take the newest frame into the ring. */
  #yt() {
    const e = this.#s;
    this.#w = (this.#w + 1) % y, e.bindTexture(e.TEXTURE_2D, this.#F[this.#w] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#Fe
    ), this.#l = Math.min(this.#l + 1, y);
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
  #Ee(e, t, i, A = !0) {
    if (this.#l === 0 || this.#x) return;
    A && (this.#l === y && !e ? this.#b.filtered++ : this.#b.degraded++);
    const s = this.#s, r = this.#w, o = (this.#w + y - 1) % y, n = (this.#w + 1) % y;
    let l, h, u;
    this.#l === 1 ? l = h = u = r : e ? (l = o, h = u = r) : this.#l === 2 ? (l = h = o, u = r) : (l = n, h = o, u = r), s.bindFramebuffer(s.FRAMEBUFFER, i), s.useProgram(this.#D);
    for (const [a, d] of [l, h, u].entries())
      s.activeTexture(s.TEXTURE0 + a), s.bindTexture(s.TEXTURE_2D, this.#F[d] ?? null);
    s.uniform1i(this.#a.prev, 0), s.uniform1i(this.#a.cur, 1), s.uniform1i(this.#a.next, 2), s.uniform2i(this.#a.size, this.#p, this.#T);
    const f = this.#Ce ? 0 : 1;
    s.uniform1i(this.#a.parity, t ? 1 - f : f), s.uniform1i(this.#a.tff, this.#Ce ? 1 : 0), s.uniform1i(this.#a.spatialCheck, this.#Ue ? 1 : 0), s.viewport(0, 0, this.#p, this.#T), s.drawArrays(s.TRIANGLES, 0, 3), i === null && (this.#d = { kind: "yadif", flush: e, second: t }, this.#C(!0), A && this.#X++);
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
  #Be() {
    if (!this.#L) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const A = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), s = t * A, r = i * A;
    this.#i.style.left = `${e.offsetLeft + (e.offsetWidth - s) / 2}px`, this.#i.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#i.style.width = `${s}px`, this.#i.style.height = `${r}px`;
  }
  #Dt(e, t) {
    const i = this.#s;
    this.#u.width = e, this.#u.height = t, this.#p = e, this.#T = t, this.#l = 0, this.#d = null, this.#y(), this.#Be();
    for (const A of this.#F) i.deleteTexture(A);
    this.#F = [];
    for (let A = 0; A < y; A++) {
      const s = i.createTexture();
      i.bindTexture(i.TEXTURE_2D, s), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MIN_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_MAG_FILTER, i.NEAREST), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_S, i.CLAMP_TO_EDGE), i.texParameteri(i.TEXTURE_2D, i.TEXTURE_WRAP_T, i.CLAMP_TO_EDGE), i.texImage2D(
        i.TEXTURE_2D,
        0,
        i.RGBA,
        e,
        t,
        0,
        i.RGBA,
        i.UNSIGNED_BYTE,
        null
      ), this.#F.push(s);
    }
    this.#re(), this.#st(), this.#m && this.#Tt(), (this.#v || this.#m) && this.#At();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Tt() {
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
    const A = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
    if (e.bindFramebuffer(e.FRAMEBUFFER, null), !A) {
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
  #st() {
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
  #At() {
    const e = this.#s;
    if (!(this.#E.length === k || this.#p === 0)) {
      this.#re();
      for (let t = 0; t < k; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#p,
          this.#T,
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
        const s = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
        if (e.bindFramebuffer(e.FRAMEBUFFER, null), !s) {
          e.deleteFramebuffer(A), e.deleteTexture(i), this.#re();
          return;
        }
        this.#E.push({ texture: i, framebuffer: A });
      }
      this.#he = k - 1;
    }
  }
  #re() {
    const e = this.#s, t = this.#d?.kind === "texture" ? this.#d.texture : null;
    this.#E.some((i) => i.texture === t) && (this.#d = null);
    for (const { texture: i, framebuffer: A } of this.#E)
      e.deleteFramebuffer(A), e.deleteTexture(i);
    this.#E = [], this.#t.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #ii() {
    if (this.#L) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#L = t, this.#Ie?.observe(this.#e), this.#Be();
  }
  #si() {
    if (this.#h) return;
    const e = this.#L;
    this.#L = null, this.#Ie?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #xt = () => this.#Be();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #rt(e) {
    return !this.#o || this.#A === "main" ? !1 : (this.#o.postMessage({
      type: "event",
      name: e,
      video: this.#qe()
    }), !0);
  }
  #Mt = () => {
    if (this.#De = Number.NaN, this.#R(!0), this.#rt("emptied")) {
      this.#B(), this.#C(!1);
      return;
    }
    this.#l = 0, this.#ae = 0, this.#t.length = 0, this.#f = 0, this.#Ft(), this.#y(), this.#d = null, this.#C(!1);
  };
  #Ft() {
    this.#b = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#H = 0, this.#Re = 0, this.#je = 0, this.#z = 0, this.#de = 0, this.#me = 0, this.#pe = 0, this.#se = 0, this.#X = 0, this.#y();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #y() {
    this.#t.length = 0, this.#S = "video", this.#oe = "c", this.#Ne = 0, this.#Ge = !0, this.#We.reset(), this.#Oe = 1 / 0, this.#Xe = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #St = () => {
    if (this.#rt("seeking")) {
      this.#B();
      return;
    }
    this.#le = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #P = (e) => {
    if ((e.type === "pause" || e.type === "ended") && this.#R(!1), (e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#rt(e.type)) {
      this.#B();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#le;
      if (this.#le = !1, i) return;
      this.#l = 0, this.#y(), this.#d = null, this.#C(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#f = 0, this.#ae = this.#e.currentTime), this.#t.length = 0, this.#r && this.#l > 0) {
      const i = this.#$e(), A = i === null ? void 0 : this.#E[i];
      i !== null && A ? (this.#he = i, this.#Ee(!0, !1, A.framebuffer), this.#bt(i)) : this.#Ee(!0, !1, null);
    }
    t && (this.#l = 0, this.#y());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Rt = (e) => {
    if (e.preventDefault(), this.#h) {
      this.#h.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#A !== "active" && (this.#x = !0, this.stop());
  };
}
function W(c, e) {
  const t = c.createProgram(), i = re(c, c.VERTEX_SHADER, ke), A = re(c, c.FRAGMENT_SHADER, e);
  if (c.attachShader(t, i), c.attachShader(t, A), c.linkProgram(t), c.deleteShader(i), c.deleteShader(A), !c.getProgramParameter(t, c.LINK_STATUS)) {
    const s = c.getProgramInfoLog(t);
    throw c.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${s ?? "no reason given"}`
    );
  }
  return t;
}
function re(c, e, t) {
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
const ne = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", _e = 0.5, Be = 3e3, he = 0.1, P = 16, oe = 'video/mp4; codecs="avc1.640029"';
let K = null;
function Pe(c = {}) {
  return K ??= Ie(c), K;
}
async function He(c = {}) {
  return (await Pe(c)).deinterlaces;
}
function ze() {
  K = null;
}
async function Ie(c) {
  const e = c.tolerance ?? _e, t = c.timeoutMs ?? Be, i = performance.now(), A = (o) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: o instanceof Error ? o.message : String(o)
  });
  if (typeof document > "u")
    return A(new Error("there is no document to decode in"));
  const s = document.createElement("video");
  s.muted = !0, s.defaultMuted = !0, s.playsInline = !0, s.preload = "auto";
  let r = null;
  try {
    r = Ne(s, t);
    const o = z(H(s, "loadeddata"), t), n = s.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await o, await Ge(s, t, await n), s.videoWidth === 0 || s.videoHeight === 0)
      return A(new Error("the probe clip decoded to nothing"));
    const l = We(s);
    return {
      deinterlaces: l < 1 - e,
      survives: l,
      tookMs: performance.now() - i
    };
  } catch (o) {
    return A(o);
  } finally {
    s.pause(), s.removeAttribute("src"), s.replaceChildren(), s.load(), r && URL.revokeObjectURL(r.url);
  }
}
const J = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Ue = typeof MediaSource > "u";
function Ne(c, e) {
  if (!J || !J.isTypeSupported(oe))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = ne.indexOf(","), i = atob(ne.slice(t + 1)), A = new Uint8Array(i.length);
  for (let n = 0; n < i.length; n++) A[n] = i.charCodeAt(n);
  const s = new J(), r = URL.createObjectURL(s);
  if (Ue) {
    c.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, c.append(n), c.load();
  } else
    c.src = r;
  const o = (async () => {
    await z(H(s, "sourceopen"), e);
    const n = s.addSourceBuffer(oe), l = z(H(n, "updateend"), e);
    n.appendBuffer(A), await l, s.endOfStream();
  })();
  return { url: r, ready: o };
}
async function Ge(c, e, t) {
  if (t) {
    const i = performance.now();
    for (; c.currentTime < he && performance.now() - i < e; )
      await new Promise((A) => requestAnimationFrame(A));
    c.pause();
  } else
    c.currentTime = he, await z(H(c, "seeked"), e);
}
function We(c) {
  const e = c.videoHeight, t = document.createElement("canvas");
  t.width = P, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(c, 0, 0, P, e);
  const A = i.getImageData(0, 0, P, e).data, s = (h) => {
    let u = 0;
    for (let f = 0; f < P; f++)
      u += A[(h * P + f) * 4 + 1] ?? 0;
    return u / P;
  };
  let r = 0;
  const o = 2, n = e - 3;
  let l = s(o);
  for (let h = o + 1; h <= n; h++) {
    const u = s(h);
    r += Math.abs(u - l), l = u;
  }
  return r / (n - o) / 255;
}
function H(c, e) {
  return new Promise((t, i) => {
    c.addEventListener(e, () => t(), { once: !0 }), c.addEventListener(
      "error",
      () => {
        const A = c instanceof HTMLMediaElement ? c.error : null, s = A ? ` (MediaError ${A.code}${A.message ? `: ${A.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${s}`));
      },
      { once: !0 }
    );
  });
}
function z(c, e) {
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
  Xe as Deinterlacer,
  ue as FILM_ANALYSIS_FRAGMENT_SHADER,
  me as FILM_SAMPLE_FRAGMENT_SHADER,
  j as FILM_UNIFORMS,
  de as FILM_WEAVE_FRAGMENT_SHADER,
  fe as YADIF_FRAGMENT_SHADER,
  ce as YADIF_UNIFORMS,
  He as decoderDeinterlaces,
  ze as forgetDecoderProbe,
  Pe as probeDecoder,
  Oe as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
