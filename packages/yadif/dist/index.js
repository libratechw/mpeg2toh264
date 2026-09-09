const ce = "" + new URL("assets/worker-f6CVgoS4.js", import.meta.url).href, fe = {
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
`, j = {
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
  #u;
  #i;
  #e;
  #s = 0;
  #D = null;
  #o = [];
  #M = null;
  #Q = 1 / 0;
  #j = 1 / 0;
  constructor(e, t) {
    this.#u = e, this.#i = t, this.#e = 255 * b.DECIMATE_BLOCK ** 2 * b.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, s, A = b.COMBED_PIXEL_LIMIT) {
    const r = s ? 1 : 0, o = { p: e, c: t, n: i };
    let n = this.#I("c", "p", r, o);
    const c = /* @__PURE__ */ new Map(), h = (p) => {
      const w = c.get(p);
      if (w !== void 0) return w;
      const g = b.#U(
        this.weave(e, t, i, p, s),
        this.#u,
        this.#i
      );
      return c.set(p, g), g;
    }, u = h(n), f = h("n");
    (f * 3 < u || f * 2 < u && u > A) && Math.abs(f - u) >= 30 && f < A && (n = "n");
    const l = h(n), d = l >= A;
    return d && (n = "c"), {
      match: n,
      combScore: l,
      isCombed: d,
      luma: this.weave(e, t, i, n, s)
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
    this.#o.push(i);
    const s = this.#D === t, A = s && i.maxBlockDifference < this.#e;
    s && !A && (this.#D = null);
    const r = this.#D;
    this.#M = e.slice(), this.#s++;
    let o = this.#D;
    if (this.#s === b.CYCLE) {
      let n = 0, c = null;
      for (let h = 1; h < this.#o.length; h++)
        (this.#o[h]?.maxBlockDifference ?? 1 / 0) < (this.#o[n]?.maxBlockDifference ?? 1 / 0) ? (c = n, n = h) : (c === null || (this.#o[h]?.maxBlockDifference ?? 1 / 0) < (this.#o[c]?.maxBlockDifference ?? 1 / 0)) && (c = h);
      this.#Q = this.#o[n]?.maxBlockDifference ?? 1 / 0, this.#j = c === null ? 1 / 0 : this.#o[c]?.maxBlockDifference ?? 1 / 0, o = (this.#o[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#D = o, this.#o = [], this.#s = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: A,
      dropIndex: r,
      nextDropIndex: o,
      lowestCycleDifference: this.#Q,
      runnerUpCycleDifference: this.#j
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, s, A) {
    if (s === "c") return t.slice();
    const r = t.slice(), o = s === "p" ? e : i, n = r.length / this.#i, c = A ? 1 : 0;
    for (let h = c; h < this.#i; h += 2)
      r.set(
        o.subarray(h * n, (h + 1) * n),
        h * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#s = 0, this.#D = null, this.#o = [], this.#M = null, this.#Q = 1 / 0, this.#j = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #I(e, t, i, s) {
    const A = this.#u, r = this.#i, o = 2 - i, n = 2 - i, c = s[e], h = s[t], u = b.#ve(
      c,
      h,
      A,
      r,
      i
    );
    let f = 0, l = 0, d = 0, p = 0, w = 0, g = 0;
    for (let R = 2; R < r - 2; R += 2) {
      const D = (R - 2) / 2, Y = o - 1 + D * 2, Z = o + 1 + D * 2, Q = o + 3 + D * 2, O = o + D * 2, G = O + 2, L = n + D * 2, S = L + 2, $ = o + D * 2;
      for (let T = 8; T < A - 8; T++) {
        const C = (u[$ * A + T] ?? 0) | (u[($ + 2) * A + T] ?? 0);
        if (C === 0) continue;
        const ee = (s.c[Y * A + T] ?? 0) + ((s.c[Z * A + T] ?? 0) << 2) + (s.c[Q * A + T] ?? 0), _ = Math.abs(
          3 * ((c[O * A + T] ?? 0) + (c[G * A + T] ?? 0)) - ee
        ), B = Math.abs(
          3 * ((h[L * A + T] ?? 0) + (h[S * A + T] ?? 0)) - ee
        );
        _ > 23 && (C & 1) !== 0 && (f += _), B > 23 && (C & 1) !== 0 && (p += B), _ > 42 && (C & 2) !== 0 && (l += _), B > 42 && (C & 2) !== 0 && (w += B), _ > 42 && (C & 4) !== 0 && (d += _), B > 42 && (C & 4) !== 0 && (g += B);
      }
    }
    l < 500 && w < 500 && (d >= 500 || g >= 500) && Math.max(d, g) > 3 * Math.min(d, g) && (l = d, w = g);
    const v = Math.floor(f / 6 + 0.5), F = Math.floor(p / 6 + 0.5), E = Math.floor(l / 6 + 0.5), m = Math.floor(w / 6 + 0.5), I = Math.max(v, F) / Math.max(Math.min(v, F), 1), U = Math.max(E, m) / Math.max(Math.min(E, m), 1), N = Math.max(E, m) / Math.max(Math.max(v, F), 1);
    return (E >= 500 || m >= 500) && (E * 2 < m || m * 2 < E) || (E >= 1e3 || m >= 1e3) && (E * 3 < m * 2 || m * 3 < E * 2) || (E >= 2e3 || m >= 2e3) && (E * 5 < m * 4 || m * 5 < E * 4) || (E >= 4e3 || m >= 4e3) && U > I || N > 5e-3 && Math.max(E, m) > 150 && (E * 2 < m || m * 2 < E) ? E > m ? t : e : v > F ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #ve(e, t, i, s, A) {
    const r = Array.from(
      { length: Math.ceil(s / 2) },
      () => new Uint8Array(i)
    ), o = A === 1 ? 1 : 0;
    for (let h = 0; h < r.length; h++) {
      const u = Math.min(s - 1, o + h * 2), f = r[h];
      if (f)
        for (let l = 0; l < i; l++)
          f[l] = Math.abs(
            (e[u * i + l] ?? 0) - (t[u * i + l] ?? 0)
          );
    }
    const n = new Uint8Array(i * s), c = A === 1 ? 3 : 2;
    for (let h = 1; h < r.length - 1; h++) {
      const u = c + (h - 1) * 2;
      if (u >= s) break;
      const f = r[h];
      if (f)
        for (let l = 1; l < i - 1; l++) {
          const d = f[l] ?? 0;
          if (d <= 3) continue;
          let p = 0;
          for (let m = l - 1; m <= l + 1; m++)
            p += (r[h - 1]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[h]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[h + 1]?.[m] ?? 0) > 3 ? 1 : 0;
          if (p <= 1) continue;
          const w = u * i + l;
          if (n[w] = 1, d <= 19) continue;
          p = 0;
          let g = !1, v = !1;
          for (let m = l - 1; m <= l + 1; m++)
            (r[h - 1]?.[m] ?? 0) > 19 && (p++, g = !0), (r[h]?.[m] ?? 0) > 19 && p++, (r[h + 1]?.[m] ?? 0) > 19 && (p++, v = !0);
          if (p <= 3) continue;
          if (g && v) {
            n[w] |= 2;
            continue;
          }
          let F = !1, E = !1;
          for (let m = Math.max(l - 4, 0); m < Math.min(l + 5, i); m++)
            h !== 1 && (r[h - 2]?.[m] ?? 0) > 19 && (F = !0), (r[h - 1]?.[m] ?? 0) > 19 && (g = !0), (r[h + 1]?.[m] ?? 0) > 19 && (v = !0), h !== r.length - 2 && (r[h + 2]?.[m] ?? 0) > 19 && (E = !0);
          g && (v || F) || v && (g || E) ? n[w] |= 2 : p > 5 && (n[w] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #U(e, t, i) {
    const s = new Uint8Array(t * i), A = (o, n) => e[Math.max(0, Math.min(i - 1, n)) * t + o] ?? 0;
    for (let o = 0; o < i; o++)
      for (let n = 0; n < t; n++) {
        const c = A(n, o), h = A(n, o === 0 ? 1 : o - 1), u = A(n, o === i - 1 ? i - 2 : o + 1), f = o < 2 ? A(n, o === 0 ? 2 : 3) : A(n, o - 2), l = o + 2 >= i ? A(n, o === i - 1 ? i - 3 : i - 4) : A(n, o + 2);
        (o === 0 ? Math.abs(c - u) > b.COMB_THRESHOLD : o === i - 1 ? Math.abs(c - h) > b.COMB_THRESHOLD : Math.abs(c - h) > b.COMB_THRESHOLD && Math.abs(c - u) > b.COMB_THRESHOLD) && Math.abs(
          4 * c - 3 * (h + u) + f + l
        ) > b.COMB_THRESHOLD * 6 && (s[o * t + n] = 255);
      }
    let r = 0;
    for (const o of [0, 8])
      for (const n of [0, 8])
        for (let c = o; c < i; c += 16)
          for (let h = n; h < t; h += 16) {
            let u = 0;
            for (let f = Math.max(1, c); f < Math.min(i - 1, c + 16); f++)
              for (let l = h; l < Math.min(t, h + 16); l++) {
                const d = f * t + l;
                s[d - t] === 255 && s[d] === 255 && s[d + t] === 255 && u++;
              }
            r = Math.max(r, u);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #be(e, t, i, s) {
    const A = b.DECIMATE_BLOCK / 2, r = Math.ceil(i / A), o = Math.ceil(s / A), n = new Float64Array(r * o), c = e.length / (i * s);
    for (let f = 0; f < s; f++) {
      const l = Math.floor(f / A);
      for (let d = 0; d < i; d++) {
        const p = Math.floor(d / A), w = l * r + p, g = (f * i + d) * c;
        if (c === 1) {
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
        for (let G = f; G < Math.min(f + 2, s); G++)
          for (let L = d; L < Math.min(d + 2, i); L++) {
            const S = (G * i + L) * c;
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
      for (let l = 0; l < r - 1; l++)
        h = Math.max(
          h,
          (n[f * r + l] ?? 0) + (n[f * r + l + 1] ?? 0) + (n[(f + 1) * r + l] ?? 0) + (n[(f + 1) * r + l + 1] ?? 0)
        );
    let u = 0;
    for (const f of n) u += f;
    return { maxBlockDifference: h, totalDifference: u };
  }
}
let le = null;
function ge(a) {
  le = a;
}
const we = 0.5, y = 3, q = 5, k = q + 1, te = 1e3, V = 4, X = 200, Ee = 0.25, ve = 1e3 / 60, be = 0.02, ye = 250, De = 1e3 / 30, Te = 27, xe = 22, ie = 36, Me = 0.8, Fe = 250, Se = 6e3, se = 45, Re = 0.8, Ce = 300 * 1e3, ke = 90;
function Ae(a) {
  if (!Number.isFinite(a) || a < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return a;
}
const Le = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, _e = `#version 300 es
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
function re(a, e) {
  for (let t = a.length - 1; t >= 0; t--) {
    const i = a[t];
    if (i.start <= e + 1e-6) return i;
  }
}
function Xe() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class He extends EventTarget {
  #u;
  #i;
  #e;
  #s;
  #D;
  #o;
  /** The program that copies a filtered picture onto the canvas. */
  #M;
  #Q;
  #j;
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
  #V = ve;
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
  #J = null;
  /** Which side of the visible toggle the surface currently shows. */
  #q = !1;
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
  #K = "unknown";
  /** The `<div>` this put around the element, so it can be taken away again. */
  #L = null;
  #Ie;
  #v;
  #m;
  #$;
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
  #ee = null;
  /** requestVideoFrameCallback() の停止を検出するために保持する最終通知時刻。 */
  #Te = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #te = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #He = 0;
  #r = !1;
  #xe = !1;
  #Me = !1;
  #a = null;
  #H = [];
  #x = !1;
  #ze;
  #n;
  #Fe;
  #_;
  #Ye;
  #h = null;
  #A;
  #ce = !1;
  #Ze = 0;
  #Qe = !1;
  #kt = 0;
  #fe = !1;
  #Se = !1;
  #ie = null;
  #Lt = 0;
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
  #z = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #je = 0;
  #Re = 0;
  #Y = 0;
  #de = 0;
  #me = 0;
  #pe = 0;
  #se = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#v = t.doubleRate ?? !1, this.#m = t.autoFilm ?? !1, this.#$ = Ae(
      t.filmCombThreshold ?? b.COMBED_PIXEL_LIMIT
    ), this.#Ue = t.spatialCheck ?? !0, this.#ze = t.onStats, this.#n = i, this.#_ = i ? "main" : t.rendering ?? "auto", this.#Ye = t.workerUrl ?? le, this.#A = this.#_ === "main" ? "main" : "idle", this.#i = i ? i.canvas : document.createElement("canvas"), this.#u = i?.canvas ?? (this.#_ === "main" ? this.#i : document.createElement("canvas")), this.#Fe = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const s = this.#u.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!s) throw new Error("this browser has no WebGL2");
    this.#s = s, this.#D = W(s, ue);
    const A = this.#D;
    this.#o = Object.fromEntries(
      Object.entries(fe).map(([r, o]) => [
        r,
        s.getUniformLocation(A, o)
      ])
    ), this.#M = W(s, _e), this.#Q = s.getUniformLocation(this.#M, "uField"), this.#j = s.getUniformLocation(this.#M, "uFlip"), this.#m && this.#ut(), this.#u.addEventListener(
      "webglcontextlost",
      this.#Ct
    ), this.#Ie = i ? null : new ResizeObserver(() => this.#Be()), e.addEventListener("emptied", this.#Ft), e.addEventListener("resize", this.#Mt), e.addEventListener("pause", this.#P), e.addEventListener("ended", this.#P), e.addEventListener("seeking", this.#Rt), e.addEventListener("seeked", this.#P), e.addEventListener("ratechange", this.#P), !i && typeof document < "u" && document.addEventListener("visibilitychange", this.#bt);
  }
  get running() {
    return this.#r && (this.#a?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#i;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #Ce() {
    return this.#a?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #ot() {
    return {
      doubleRate: this.#v,
      autoFilm: this.#m,
      filmCombThreshold: this.#$,
      spatialCheck: this.#Ue
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#xe;
  }
  set enabled(e) {
    this.#xe = e, this.#Je(), this.#h?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#a?.interlaced !== e?.interlaced, i = t || this.#a?.topFieldFirst !== e?.topFieldFirst;
    this.#a = e, this.#h?.postMessage({ type: "scan", scan: e }), i && (this.#l = 0, this.#y(), t && (this.#f = 0), this.#d = null, this.#C(!1), e?.interlaced !== !0 ? this.#R(!0) : t && (this.#c.length = 0, this.#k = 0, this.#K = "unknown")), this.#Je(), i && ((e?.interlaced ?? !0) && (this.#n || this.#A === "main") ? this.#Ae() : this.#et());
  }
  get scan() {
    return this.#a;
  }
  set videoTimeline(e) {
    this.#H = e, this.#h?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#a = null), this.#Je();
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
    return this.#L ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#v;
  }
  set doubleRate(e) {
    e !== this.#v && (this.#v = e, this.#Ve(), this.#t.length = 0, e || this.#R(!1), e ? (this.#p > 0 && this.#At(), (this.#a?.interlaced ?? !0) && (this.#n || this.#A === "main") && this.#Ae()) : this.#m || (this.#d = null, this.#C(!1), this.#re()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#m;
  }
  set autoFilm(e) {
    e !== this.#m && (this.#m = e, this.#Ve(), this.#y(), e ? (this.#ut(), this.#p > 0 && (this.#xt(), this.#At()), (this.#a?.interlaced ?? !0) && (this.#n || this.#A === "main") && this.#Ae()) : (this.#st(), this.#v || (this.#d = null, this.#C(!1), this.#re())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#$;
  }
  set filmCombThreshold(e) {
    const t = Ae(e);
    t !== this.#$ && (this.#$ = t, this.#Ve(), this.#m && this.#y());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Ve() {
    this.#h?.postMessage({
      type: "settings",
      options: this.#ot()
    });
  }
  #Je() {
    this.#xe && (this.#H.length > 0 || (this.#a?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #_t() {
    return this.#n || this.#_ === "main" ? !1 : this.#A === "starting" || this.#A === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Ye !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#at(), !0) : this.#_ === "auto" ? (this.#ke(), !1) : (this.#A = "failed", this.#r = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #at() {
    this.#B(), this.#h?.terminate(), this.#h = null, this.#fe = !1, this.#Se = !1;
    let e = this.#i;
    if (this.#Qe) {
      e = document.createElement("canvas"), e.className = this.#i.className;
      const A = this.#i.getAttribute("style");
      A === null ? e.removeAttribute("style") : e.setAttribute("style", A), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e;
    }
    const t = ++this.#Ze;
    this.#A = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#Qe = !0, i = new Worker(this.#Ye, { type: "module" });
    } catch (A) {
      this.#ge(
        A instanceof Error ? A.message : String(A)
      );
      return;
    }
    this.#h = i, i.onmessage = (A) => {
      t === this.#Ze && this.#Bt(A.data);
    }, i.onerror = (A) => {
      t === this.#Ze && (A.preventDefault(), this.#ge(A.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#ot(),
        scan: this.#a,
        videoTimeline: this.#H,
        enabled: this.#r,
        video: this.#qe()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #Bt(e) {
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
        this.#K = e.stats.mode, this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#ze?.(t);
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
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#A = "failed", this.#h?.terminate(), this.#h = null, this.#B(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #ke() {
    this.#R(!0);
    const e = this.#u;
    e.className = this.#i.className;
    const t = this.#i.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e, this.#Qe = !1, this.#h?.terminate(), this.#h = null, this.#A = "main", this.#B(), this.#r && (this.#we(), this.#tt(), (this.#a?.interlaced ?? !0) && this.#Ae());
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
      if (this.#r = !0, this.#St(), this.#y(), this.#R(!0), this.#Te = performance.now(), this.#He = this.#Te, this.#De = Number.NaN, this.#te = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#si(), this.#tt(), this.#_t()) {
        this.#h?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#A === "active" && this.#we();
        return;
      }
      this.#we(), (this.#a?.interlaced ?? !0) && this.#Ae();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#r && (this.#r = !1, this.#R(!1), this.#ee !== null && this.#e.cancelVideoFrameCallback(this.#ee), this.#ee = null, this.#Xt(), this.#et(), this.#l = 0, this.#d = null, this.#C(!1), this.#B(), this.#h?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#Me) {
      this.#Me = !0, this.#xe = !1, this.stop(), this.#R(!1), typeof document < "u" && document.removeEventListener(
        "visibilitychange",
        this.#bt
      ), this.#h?.postMessage({ type: "destroy" }), this.#h?.terminate(), this.#h = null, this.#B(), this.#lt("the deinterlacer was destroyed"), this.#u.removeEventListener(
        "webglcontextlost",
        this.#Ct
      ), this.#e.removeEventListener("emptied", this.#Ft), this.#e.removeEventListener("resize", this.#Mt), this.#e.removeEventListener("pause", this.#P), this.#e.removeEventListener("ended", this.#P), this.#e.removeEventListener("seeking", this.#Rt), this.#e.removeEventListener("seeked", this.#P), this.#e.removeEventListener("ratechange", this.#P), this.#Ai();
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
    if (this.#A === "active" && this.#i.style.visibility === "visible" && this.#h) {
      const s = ++this.#Lt, A = new Promise((r, o) => {
        this.#ue.set(s, { resolve: r, reject: o });
      });
      return this.#h.postMessage({
        type: "capture",
        id: s,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), A;
    }
    if (this.#A === "starting" || this.#A === "failed")
      return createImageBitmap(this.#e);
    const e = this.#d;
    if (this.#n && (!this.#r || this.#x || !e))
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
    this.#n || !this.#r || this.#ee !== null || (this.#ee = this.#e.requestVideoFrameCallback(this.#It));
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
  #Pt(e, t) {
    let i;
    try {
      i = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (A) {
      const r = A instanceof Error ? A.message : String(A);
      this.#_ === "auto" && !this.#Se && !this.#ce ? (this.#ke(), this.#Le(e, t)) : this.#ge(r);
      return;
    }
    const s = {
      id: ++this.#kt,
      frame: i,
      now: e,
      metadata: t,
      video: this.#qe()
    };
    if (this.#fe) {
      this.#ie?.frame.close(), this.#ie = s;
      return;
    }
    this.#ct(s);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #ct(e) {
    const t = this.#h;
    if (!t || this.#A !== "active") {
      e.frame.close();
      return;
    }
    this.#fe = !0;
    const i = { type: "frame", ...e };
    try {
      t.postMessage(i, [e.frame]);
    } catch (s) {
      this.#fe = !1, e.frame.close();
      const A = s instanceof Error ? s.message : String(s);
      this.#_ === "auto" && !this.#Se && !this.#ce ? (this.#ke(), this.#Le(e.now, e.metadata)) : this.#ge(A);
    }
  }
  #It = (e, t) => {
    this.#ee = null, !(!this.#r || this.#x) && (this.#Te = e, this.#te = Math.max(
      this.#te,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#ft(e, t), this.#we());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #ft(e, t) {
    if (this.#De = t.mediaTime, this.#A === "active") {
      this.#Pt(e, t);
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
    if (this.#Ut(t.mediaTime), t.width > 0 && t.height > 0) {
      let i = !1;
      if (!this.#le && this.#e.seeking) {
        const l = this.#e.buffered, d = this.#f >= V ? this.#f / 1e3 : X / 1e3;
        for (let p = 0; p < l.length; p++)
          if (t.mediaTime >= l.start(p) && t.mediaTime < l.end(p) && Math.abs(t.mediaTime - this.#e.currentTime) <= d) {
            i = !0;
            break;
          }
      }
      if (i && (this.#le = !0), (this.#p === 0 || this.#T === 0) && this.#Tt(t.width, t.height), this.#a && !this.#a.interlaced) {
        this.#ei();
        return;
      }
      const s = t.mediaTime - this.#ae, A = i || s < 0 || s > we;
      A && (this.#l = 0, this.#f = 0, this.#b.discontinuities++, this.#t.length = 0, this.#y());
      const r = this.#m && this.#z !== 0 && t.presentedFrames - this.#z > 1;
      if (this.#ti(t.presentedFrames, A), !A && r && (this.#l = 0, this.#y()), this.#l > 0 && t.mediaTime === this.#ae)
        return;
      !A && s > 0 && this.#Nt(s), this.#ae = t.mediaTime;
      const o = performance.now();
      o - this.#je > te && (this.#Re = o, this.#Y = 0, this.#de = 0, this.#me = 0, this.#pe = 0, this.#se = 0, this.#X = 0), this.#je = o;
      const n = performance.now();
      this.#Dt();
      const c = this.#S, h = this.#m && this.#l === y && this.#Gt();
      if (c !== this.#S && (this.#t.length = 0), !(h && this.#_e())) if (this.#m && !this.#Ge && this.#S === "film")
        if (this.#_e()) {
          const l = this.#f * 5 / 4, d = this.#mt(1, e, l), p = this.#t.at(-1), w = d ? e : p == null ? e + l : p.at + p.duration;
          this.#Wt(w, l);
        } else
          this.#Ke(null);
      else if (this.#v && this.#_e()) {
        const l = this.#f / 2, d = this.#mt(2, e, l), p = this.#t.at(-1), w = d ? e : p == null ? e + l * 2 : p.at + p.duration;
        this.#dt(!1, w, l), this.#dt(!0, w + l, l);
      } else
        this.#b.late += this.#t.length, this.#t.length = 0, this.#Ee(!1, !1, null);
      this.#se = Math.max(
        this.#se,
        this.#t.length
      ), this.#de += performance.now() - n, this.#Y++, this.#ii(o);
    }
  }
  #Ut(e) {
    const t = re(this.#H, e);
    t?.codedSize && (t.codedSize.width !== this.#p || t.codedSize.height !== this.#T) && this.#Tt(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#a?.interlaced === i.interlaced && this.#a.topFieldFirst === i.topFieldFirst)
      return;
    const s = this.#a?.interlaced;
    this.#a = i, this.#l = 0, this.#t.length = 0, this.#y(), s !== i.interlaced && (this.#f = 0), i.interlaced !== !0 ? this.#R(!0) : s !== !0 && (this.#c.length = 0, this.#k = 0, this.#K = "unknown"), i.interlaced && (this.#n || this.#A === "main") ? this.#Ae() : this.#et();
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
  #Nt(e) {
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#f > 0 ? Math.max(1, Math.round(t / this.#f)) : 1, s = t / i;
    s < V || s > X || (this.#f = this.#f > 0 ? this.#f + (s - this.#f) * Ee : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #ut() {
    if (this.#I && this.#U && this.#ne) return;
    const e = this.#s, t = W(e, de), i = W(e, me), s = W(e, pe);
    this.#I = t, this.#ve = Object.fromEntries(
      Object.entries(j).filter(([A]) => A !== "match" && A !== "topFieldFirst").map(([A, r]) => [A, e.getUniformLocation(t, r)])
    ), this.#U = i, this.#be = Object.fromEntries(
      Object.entries(j).map(([A, r]) => [
        A,
        e.getUniformLocation(i, r)
      ])
    ), this.#ne = s, this.#nt = Object.fromEntries(
      Object.entries(j).map(([A, r]) => [
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
  #Gt() {
    const e = this.#N, t = this.#I, i = this.#ve, s = this.#ne, A = this.#nt;
    if (!e || !t || !i || !s || !A)
      return !1;
    const r = this.#s, o = this.#w, n = (this.#w + y - 1) % y, c = (this.#w + 1) % y, h = this.#Ce;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [g, v] of [c, n, o].entries())
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
    const { previousLuma: u, currentLuma: f, nextLuma: l } = e;
    for (let g = 0; g < u.length; g++) {
      const v = g * 4;
      u[g] = e.pixels[v] ?? 0, f[g] = e.pixels[v + 1] ?? 0, l[g] = e.pixels[v + 2] ?? 0;
    }
    const d = this.#We.fieldMatch(
      u,
      f,
      l,
      h,
      this.#$
    );
    r.useProgram(s), r.uniform1i(A.prev, 0), r.uniform1i(A.cur, 1), r.uniform1i(A.next, 2), r.uniform2i(A.size, this.#p, this.#T), r.uniform1i(A.topFieldFirst, h ? 1 : 0), r.uniform1i(
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
    const p = this.#We.decimate(e.pixels);
    this.#oe = d.match, this.#Ne = d.combScore, this.#Ge = d.isCombed, this.#Oe = p.lowestCycleDifference, this.#Xe = p.runnerUpCycleDifference;
    const w = p.dropIndex !== null && !d.isCombed;
    return (w ? "film" : "video") !== this.#S && (this.#S = w ? "film" : "video"), p.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Wt(e, t) {
    const i = this.#$e();
    if (i === null) return;
    const s = this.#E[i];
    if (s) {
      for (this.#he = i; this.#t.length > 0 && this.#t[0]?.slot === i; )
        this.#t.shift(), this.#b.late++;
      this.#Ke(s.framebuffer), this.#t.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Ke(e, t = !0) {
    const i = this.#U, s = this.#be;
    if (!i || !s) return;
    const A = this.#s, r = this.#w, o = (this.#w + y - 1) % y, n = (this.#w + 1) % y, c = this.#Ce;
    A.bindFramebuffer(A.FRAMEBUFFER, e), A.useProgram(i);
    for (const [h, u] of [n, o, r].entries())
      A.activeTexture(A.TEXTURE0 + h), A.bindTexture(A.TEXTURE_2D, this.#F[u] ?? null);
    A.uniform1i(s.prev, 0), A.uniform1i(s.cur, 1), A.uniform1i(s.next, 2), A.uniform2i(s.size, this.#p, this.#T), A.uniform1i(s.topFieldFirst, c ? 1 : 0), A.uniform1i(
      s.match,
      this.#oe === "p" ? 0 : this.#oe === "c" ? 1 : 2
    ), A.viewport(0, 0, this.#p, this.#T), A.drawArrays(A.TRIANGLES, 0, 3), e === null && (this.#d = { kind: "film" }, this.#C(!0), t && this.#X++);
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
    const s = this.#$e();
    if (s === null) return;
    const A = this.#E[s];
    if (A) {
      for (this.#he = s; this.#t.length > 0 && this.#t[0]?.slot === s; )
        this.#t.shift(), this.#b.late++;
      this.#Ee(!1, e, A.framebuffer), this.#t.push({ slot: s, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #mt(e, t, i) {
    const s = this.#t.at(-1), A = (q + 1) * Math.max(this.#V, i);
    if (s && s.at - t > A)
      return this.#t.length = 0, this.#b.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#t.length + e - q
    );
    let o = 0, n = 0;
    for (; n < r; ) {
      const c = this.#t.shift();
      if (!c) break;
      o += c.duration, n++;
    }
    for (const c of this.#t) c.at -= o;
    return this.#b.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #$e() {
    const e = this.#d?.kind === "texture" ? this.#d.texture : null, t = new Set(this.#t.map(({ slot: s }) => s));
    for (let s = 1; s <= k; s++) {
      const A = (this.#he + s) % k, r = this.#E[A];
      if (r && r.texture !== e && !t.has(A))
        return A;
    }
    const i = this.#t[0];
    if (i) {
      const s = this.#E[i.slot];
      if (s && s.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #Ae() {
    this.#G === null && (!this.#r || this.#x || (this.#ye = 0, this.#G = this.#gt(this.#pt)));
  }
  #et() {
    this.#G !== null && this.#Ot(this.#G), this.#G = null, this.#t.length = 0;
  }
  #pt = (e) => {
    if (this.#G = null, !(!this.#r || this.#x)) {
      if (this.#ye > 0) {
        const t = e - this.#ye;
        t >= 1 && t <= X && (this.#V = t < this.#V ? t : this.#V + (t - this.#V) * be);
      }
      this.#ye = e, this.#A === "main" && this.#$t(e), this.#G = this.#gt(this.#pt);
    }
  };
  /** ページと Worker のそれぞれが所有する requestAnimationFrame() へ表示ループを委ねる。 */
  #gt(e) {
    return this.#n ? this.#n.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #Ot(e) {
    this.#n ? this.#n.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #tt() {
    this.#n || this.#W !== null || !this.#r || this.#x || (this.#W = requestAnimationFrame(this.#wt));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Xt() {
    this.#W !== null && cancelAnimationFrame(this.#W), this.#W = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #wt = (e) => {
    this.#W = null, !(!this.#r || this.#x) && (this.#zt(e), this.#Kt(e), this.#W = requestAnimationFrame(this.#wt));
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
  #Ht(e) {
    return !(this.#n || typeof document > "u" || !this.#r || this.#Me || this.#x || this.#A !== "active" || !this.#v || this.#Et?.interlaced !== !0 || this.#K !== "video" || this.#S === "film" || document.hidden || this.#e.paused || this.#e.ended || e < this.#Pe);
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
  #zt(e) {
    if (!(this.#n || typeof document > "u")) {
      if (this.#k > 0) {
        const t = e - this.#k;
        t >= 1 && t <= X && (this.#c.push(t), this.#c.length > ke && this.#c.shift());
      }
      if (this.#k = e, document.hidden) {
        this.#g !== "off" && this.#Z(), this.#c.length = 0;
        return;
      }
      if (!this.#Ht(e)) {
        if (this.#g !== "off" && this.#Z(), this.#g === "off" && this.#c.length > 0) {
          const t = e < this.#Pe, i = !this.#r || this.#e.paused || this.#e.ended || this.#Et?.interlaced !== !0 || !this.#v || this.#A !== "active" || this.#S === "film" || this.#K !== "video";
          (t || i) && (this.#c.length = 0);
        }
        return;
      }
      this.#g === "off" ? this.#Yt() && this.#Qt(e) : this.#g === "trial" && (this.#Zt() ? this.#jt() : e - this.#ht >= Se && this.#Vt(e));
    }
  }
  /**
   * Scan state for page-owned surface decisions.
   *
   * Worker rendering selects timeline state while processing transferred
   * frames, so the page-side #scan is normally untouched. Resolve the same
   * timeline at the media element playhead here. A present timeline owns the
   * answer: before its first state, or at a state with no scan metadata, the
   * result is unknown rather than a permissive interlaced default. Standalone
   * callers without a timeline keep the direct scan-setter contract.
   */
  get #Et() {
    return this.#H.length === 0 ? this.#a : re(this.#H, this.#e.currentTime)?.scan ?? null;
  }
  /** Whether recent page gaps sit stably near the stuck 30 Hz cadence. */
  #Yt() {
    if (this.#c.length < ie) return !1;
    const e = this.#c.slice(-ie);
    let t = 0;
    for (const i of e) i >= Te && t++;
    return t / e.length >= Me;
  }
  /** Whether recent page gaps show sustained recovery toward ~60 Hz. */
  #Zt() {
    if (this.#c.length < se) return !1;
    const e = this.#c.slice(-se);
    let t = 0;
    for (const i of e) i <= xe && t++;
    return t / e.length >= Re;
  }
  /** Begin the bounded trial: lazily create the surface and toggle it. */
  #Qt(e) {
    this.#g !== "off" || !this.#Jt() || (this.#g = "trial", this.#ht = e, this.#q = !1, this.#vt(), this.#J !== null && clearInterval(this.#J), this.#J = setInterval(
      () => this.#qt(),
      Fe
    ));
  }
  /** Keep the surface for the session: the trial proved a 60 Hz recovery. */
  #jt() {
    this.#g === "trial" && (this.#g = "on");
  }
  /**
   * End a trial that proved nothing: remove the surface and back off.
   * True 30 Hz displays never recover, so the bounded cooldown keeps them
   * from paying for back-to-back trials.
   */
  #Vt(e) {
    this.#Z(), this.#Pe = e + Ce, this.#c.length = 0, this.#k = e;
  }
  /** Clear the timer and remove the page-owned element, if any. */
  #Z() {
    this.#J !== null && (clearInterval(this.#J), this.#J = null), this.#O?.remove(), this.#O = null, this.#g = "off", this.#q = !1;
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
    this.#g !== "off" && this.#Z(), this.#c.length = 0, this.#k = 0, e && (this.#K = "unknown");
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
  #Jt() {
    if (typeof document > "u") return null;
    if (this.#O) return this.#O;
    const e = this.#L ?? document.body;
    if (!e) return null;
    const t = document.createElement("div");
    return t.setAttribute("data-mpeg2toh264-surface", "true"), t.style.cssText = this.#L ? "position:absolute;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;pointer-events:none;opacity:1;visibility:visible;transform:translateZ(0);background-color:rgb(0,0,0);" : "position:fixed;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;pointer-events:none;opacity:1;visibility:visible;transform:translateZ(0);background-color:rgb(0,0,0);z-index:2147483647;", e.appendChild(t), this.#O = t, t;
  }
  /** Flip the visible surface phase; the composition is the workaround. */
  #qt() {
    if (!(!this.#O || this.#g === "off")) {
      if (typeof document < "u" && document.hidden) {
        this.#Z(), this.#c.length = 0;
        return;
      }
      if (!this.#r || this.#e.paused || this.#e.ended) {
        this.#Z(), this.#c.length = 0;
        return;
      }
      this.#q = !this.#q, this.#vt();
    }
  }
  /** Apply the current toggle phase as a composited style change. */
  #vt() {
    const e = this.#O;
    e && (e.style.backgroundColor = this.#q ? "rgb(1,0,0)" : "rgb(0,0,0)", e.style.transform = this.#q ? "translateZ(0) translateX(1px)" : "translateZ(0)");
  }
  /** Hidden pages run no rAF: never leave the surface behind in background. */
  #bt = () => {
    if (!(typeof document > "u")) {
      if (!document.hidden) {
        this.#c.length = 0, this.#k = 0;
        return;
      }
      this.#g !== "off" && this.#Z(), this.#c.length = 0, this.#k = 0;
    }
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #Kt(e) {
    if (this.#n || e - this.#Te < ye || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#f >= V ? this.#f : De, A = i > this.#te, r = t !== this.#De && e - this.#He >= s * 0.75;
    !A && !r || (this.#te = Math.max(
      this.#te,
      i
    ), this.#He = e, this.#ft(e, {
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
  #$t(e) {
    const t = e + this.#V * 1.5;
    for (; this.#t[1] && this.#t[1].at <= t; )
      this.#b.late++, this.#t.shift();
    let i = this.#t[0];
    if (!i || i.at > t)
      return;
    this.#t.shift();
    const s = performance.now();
    this.#yt(i.slot), this.#pe += performance.now() - s, this.#me++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #yt(e) {
    const t = this.#E[e];
    t && this.#it(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #ei() {
    this.#Dt();
    const e = this.#F[this.#w];
    e && this.#it(e, !0), this.#l = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #C(e) {
    if (this.#n) {
      this.#n.onVisibility(e);
      return;
    }
    this.#i.style.visibility = e ? "visible" : "hidden";
  }
  #it(e, t = !1, i = !0) {
    const s = this.#s;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#M), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#Q, 0), s.uniform1i(this.#j, t ? 1 : 0), s.viewport(0, 0, this.#p, this.#T), s.drawArrays(s.TRIANGLES, 0, 3), this.#d = { kind: "texture", texture: e, flip: t }, this.#C(!0), i && this.#X++;
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
  #ti(e, t) {
    this.#z !== 0 && !t && (this.#b.missed += Math.max(0, e - this.#z - 1)), this.#z = e;
  }
  #ii(e) {
    const t = e - this.#Re;
    if (t < te) return;
    const i = this.#_e() && (this.#v || this.#S === "film") ? this.#me : this.#Y, s = {
      ...this.#b,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#Y === 0 ? 0 : (this.#de + this.#pe) / this.#Y,
      maxQueuedFields: this.#se,
      mode: this.#S,
      match: this.#oe,
      combScore: this.#Ne,
      outputFps: this.#X * 1e3 / t,
      duplicateScore: this.#Oe,
      duplicateRunnerUp: this.#Xe
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#ze?.(s), this.#Re = e, this.#Y = 0, this.#de = 0, this.#me = 0, this.#pe = 0, this.#se = 0, this.#X = 0;
  }
  /** Take the newest frame into the ring. */
  #Dt() {
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
  #Ee(e, t, i, s = !0) {
    if (this.#l === 0 || this.#x) return;
    s && (this.#l === y && !e ? this.#b.filtered++ : this.#b.degraded++);
    const A = this.#s, r = this.#w, o = (this.#w + y - 1) % y, n = (this.#w + 1) % y;
    let c, h, u;
    this.#l === 1 ? c = h = u = r : e ? (c = o, h = u = r) : this.#l === 2 ? (c = h = o, u = r) : (c = n, h = o, u = r), A.bindFramebuffer(A.FRAMEBUFFER, i), A.useProgram(this.#D);
    for (const [l, d] of [c, h, u].entries())
      A.activeTexture(A.TEXTURE0 + l), A.bindTexture(A.TEXTURE_2D, this.#F[d] ?? null);
    A.uniform1i(this.#o.prev, 0), A.uniform1i(this.#o.cur, 1), A.uniform1i(this.#o.next, 2), A.uniform2i(this.#o.size, this.#p, this.#T);
    const f = this.#Ce ? 0 : 1;
    A.uniform1i(this.#o.parity, t ? 1 - f : f), A.uniform1i(this.#o.tff, this.#Ce ? 1 : 0), A.uniform1i(this.#o.spatialCheck, this.#Ue ? 1 : 0), A.viewport(0, 0, this.#p, this.#T), A.drawArrays(A.TRIANGLES, 0, 3), i === null && (this.#d = { kind: "yadif", flush: e, second: t }, this.#C(!0), s && this.#X++);
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
    const s = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), A = t * s, r = i * s;
    this.#i.style.left = `${e.offsetLeft + (e.offsetWidth - A) / 2}px`, this.#i.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#i.style.width = `${A}px`, this.#i.style.height = `${r}px`;
  }
  #Tt(e, t) {
    const i = this.#s;
    this.#u.width = e, this.#u.height = t, this.#p = e, this.#T = t, this.#l = 0, this.#d = null, this.#y(), this.#Be();
    for (const s of this.#F) i.deleteTexture(s);
    this.#F = [];
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
      ), this.#F.push(A);
    }
    this.#re(), this.#st(), this.#m && this.#xt(), (this.#v || this.#m) && this.#At();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #xt() {
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
          e.deleteFramebuffer(s), e.deleteTexture(i), this.#re();
          return;
        }
        this.#E.push({ texture: i, framebuffer: s });
      }
      this.#he = k - 1;
    }
  }
  #re() {
    const e = this.#s, t = this.#d?.kind === "texture" ? this.#d.texture : null;
    this.#E.some((i) => i.texture === t) && (this.#d = null);
    for (const { texture: i, framebuffer: s } of this.#E)
      e.deleteFramebuffer(s), e.deleteTexture(i);
    this.#E = [], this.#t.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #si() {
    if (this.#L) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#L = t, this.#Ie?.observe(this.#e), this.#Be();
  }
  #Ai() {
    if (this.#n) return;
    const e = this.#L;
    this.#L = null, this.#Ie?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #Mt = () => this.#Be();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #rt(e) {
    return !this.#h || this.#A === "main" ? !1 : (this.#h.postMessage({
      type: "event",
      name: e,
      video: this.#qe()
    }), !0);
  }
  #Ft = () => {
    if (this.#De = Number.NaN, this.#R(!0), this.#rt("emptied")) {
      this.#B(), this.#C(!1);
      return;
    }
    this.#l = 0, this.#ae = 0, this.#t.length = 0, this.#f = 0, this.#St(), this.#y(), this.#d = null, this.#C(!1);
  };
  #St() {
    this.#b = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#z = 0, this.#Re = 0, this.#je = 0, this.#Y = 0, this.#de = 0, this.#me = 0, this.#pe = 0, this.#se = 0, this.#X = 0, this.#y();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #y() {
    this.#t.length = 0, this.#S = "video", this.#oe = "c", this.#Ne = 0, this.#Ge = !0, this.#We.reset(), this.#Oe = 1 / 0, this.#Xe = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #Rt = () => {
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
      const i = this.#$e(), s = i === null ? void 0 : this.#E[i];
      i !== null && s ? (this.#he = i, this.#Ee(!0, !1, s.framebuffer), this.#yt(i)) : this.#Ee(!0, !1, null);
    }
    t && (this.#l = 0, this.#y());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Ct = (e) => {
    if (e.preventDefault(), this.#n) {
      this.#n.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#A !== "active" && (this.#x = !0, this.stop());
  };
}
function W(a, e) {
  const t = a.createProgram(), i = ne(a, a.VERTEX_SHADER, Le), s = ne(a, a.FRAGMENT_SHADER, e);
  if (a.attachShader(t, i), a.attachShader(t, s), a.linkProgram(t), a.deleteShader(i), a.deleteShader(s), !a.getProgramParameter(t, a.LINK_STATUS)) {
    const A = a.getProgramInfoLog(t);
    throw a.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${A ?? "no reason given"}`
    );
  }
  return t;
}
function ne(a, e, t) {
  const i = a.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (a.shaderSource(i, t), a.compileShader(i), !a.getShaderParameter(i, a.COMPILE_STATUS)) {
    const s = a.getShaderInfoLog(i);
    throw a.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${s ?? "no reason given"}`
    );
  }
  return i;
}
const he = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Be = 0.5, Pe = 3e3, oe = 0.1, P = 16, ae = 'video/mp4; codecs="avc1.640029"';
let K = null;
function Ie(a = {}) {
  return K ??= Ue(a), K;
}
async function ze(a = {}) {
  return (await Ie(a)).deinterlaces;
}
function Ye() {
  K = null;
}
async function Ue(a) {
  const e = a.tolerance ?? Be, t = a.timeoutMs ?? Pe, i = performance.now(), s = (o) => ({
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
    r = Ge(A, t);
    const o = z(H(A, "loadeddata"), t), n = A.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await o, await We(A, t, await n), A.videoWidth === 0 || A.videoHeight === 0)
      return s(new Error("the probe clip decoded to nothing"));
    const c = Oe(A);
    return {
      deinterlaces: c < 1 - e,
      survives: c,
      tookMs: performance.now() - i
    };
  } catch (o) {
    return s(o);
  } finally {
    A.pause(), A.removeAttribute("src"), A.replaceChildren(), A.load(), r && URL.revokeObjectURL(r.url);
  }
}
const J = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Ne = typeof MediaSource > "u";
function Ge(a, e) {
  if (!J || !J.isTypeSupported(ae))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = he.indexOf(","), i = atob(he.slice(t + 1)), s = new Uint8Array(i.length);
  for (let n = 0; n < i.length; n++) s[n] = i.charCodeAt(n);
  const A = new J(), r = URL.createObjectURL(A);
  if (Ne) {
    a.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, a.append(n), a.load();
  } else
    a.src = r;
  const o = (async () => {
    await z(H(A, "sourceopen"), e);
    const n = A.addSourceBuffer(ae), c = z(H(n, "updateend"), e);
    n.appendBuffer(s), await c, A.endOfStream();
  })();
  return { url: r, ready: o };
}
async function We(a, e, t) {
  if (t) {
    const i = performance.now();
    for (; a.currentTime < oe && performance.now() - i < e; )
      await new Promise((s) => requestAnimationFrame(s));
    a.pause();
  } else
    a.currentTime = oe, await z(H(a, "seeked"), e);
}
function Oe(a) {
  const e = a.videoHeight, t = document.createElement("canvas");
  t.width = P, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(a, 0, 0, P, e);
  const s = i.getImageData(0, 0, P, e).data, A = (h) => {
    let u = 0;
    for (let f = 0; f < P; f++)
      u += s[(h * P + f) * 4 + 1] ?? 0;
    return u / P;
  };
  let r = 0;
  const o = 2, n = e - 3;
  let c = A(o);
  for (let h = o + 1; h <= n; h++) {
    const u = A(h);
    r += Math.abs(u - c), c = u;
  }
  return r / (n - o) / 255;
}
function H(a, e) {
  return new Promise((t, i) => {
    a.addEventListener(e, () => t(), { once: !0 }), a.addEventListener(
      "error",
      () => {
        const s = a instanceof HTMLMediaElement ? a.error : null, A = s ? ` (MediaError ${s.code}${s.message ? `: ${s.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${A}`));
      },
      { once: !0 }
    );
  });
}
function z(a, e) {
  return Promise.race([
    a,
    new Promise(
      (t, i) => setTimeout(
        () => i(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
ge(ce);
export {
  He as Deinterlacer,
  de as FILM_ANALYSIS_FRAGMENT_SHADER,
  pe as FILM_SAMPLE_FRAGMENT_SHADER,
  j as FILM_UNIFORMS,
  me as FILM_WEAVE_FRAGMENT_SHADER,
  ue as YADIF_FRAGMENT_SHADER,
  fe as YADIF_UNIFORMS,
  ze as decoderDeinterlaces,
  Ye as forgetDecoderProbe,
  Ie as probeDecoder,
  Xe as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
