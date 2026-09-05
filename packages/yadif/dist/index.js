const we = "" + new URL("assets/worker-BOHttRT_.js", import.meta.url).href, ge = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, Ee = `#version 300 es
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
`, K = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  topFieldFirst: "uTopFieldFirst",
  match: "uMatch"
}, x = 288, F = 162, ve = `#version 300 es
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
  ivec2 targetSize = ivec2(${x}, ${F});
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
`, be = `#version 300 es
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
`, De = `#version 300 es
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
  ivec2 targetSize = ivec2(${x}, ${F});
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
  #d;
  #i;
  #e;
  #s = 0;
  #b = null;
  #n = [];
  #y = null;
  #X = 1 / 0;
  #z = 1 / 0;
  constructor(e, t) {
    this.#d = e, this.#i = t, this.#e = 255 * D.DECIMATE_BLOCK ** 2 * D.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, A, s = D.COMBED_PIXEL_LIMIT) {
    const r = A ? 1 : 0, a = { p: e, c: t, n: i };
    let n = this.#P("c", "p", r, a);
    const l = /* @__PURE__ */ new Map(), o = (p) => {
      const g = l.get(p);
      if (g !== void 0) return g;
      const w = D.#I(
        this.weave(e, t, i, p, A),
        this.#d,
        this.#i
      );
      return l.set(p, w), w;
    }, f = o(n), u = o("n");
    (u * 3 < f || u * 2 < f && f > s) && Math.abs(u - f) >= 30 && u < s && (n = "n");
    const c = o(n), d = c >= s;
    return d && (n = "c"), {
      match: n,
      combScore: c,
      isCombed: d,
      luma: this.weave(e, t, i, n, A)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#s, i = this.#y ? D.#me(
      this.#y,
      e,
      this.#d,
      this.#i
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#n.push(i);
    const A = this.#b === t, s = A && i.maxBlockDifference < this.#e;
    A && !s && (this.#b = null);
    const r = this.#b;
    this.#y = e.slice(), this.#s++;
    let a = this.#b;
    if (this.#s === D.CYCLE) {
      let n = 0, l = null;
      for (let o = 1; o < this.#n.length; o++)
        (this.#n[o]?.maxBlockDifference ?? 1 / 0) < (this.#n[n]?.maxBlockDifference ?? 1 / 0) ? (l = n, n = o) : (l === null || (this.#n[o]?.maxBlockDifference ?? 1 / 0) < (this.#n[l]?.maxBlockDifference ?? 1 / 0)) && (l = o);
      this.#X = this.#n[n]?.maxBlockDifference ?? 1 / 0, this.#z = l === null ? 1 / 0 : this.#n[l]?.maxBlockDifference ?? 1 / 0, a = (this.#n[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#b = a, this.#n = [], this.#s = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: s,
      dropIndex: r,
      nextDropIndex: a,
      lowestCycleDifference: this.#X,
      runnerUpCycleDifference: this.#z
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, A, s) {
    if (A === "c") return t.slice();
    const r = t.slice(), a = A === "p" ? e : i, n = r.length / this.#i, l = s ? 1 : 0;
    for (let o = l; o < this.#i; o += 2)
      r.set(
        a.subarray(o * n, (o + 1) * n),
        o * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#s = 0, this.#b = null, this.#n = [], this.#y = null, this.#X = 1 / 0, this.#z = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #P(e, t, i, A) {
    const s = this.#d, r = this.#i, a = 2 - i, n = 2 - i, l = A[e], o = A[t], f = D.#de(
      l,
      o,
      s,
      r,
      i
    );
    let u = 0, c = 0, d = 0, p = 0, g = 0, w = 0;
    for (let S = 2; S < r - 2; S += 2) {
      const M = (S - 2) / 2, V = a - 1 + M * 2, q = a + 1 + M * 2, J = a + 3 + M * 2, Z = a + M * 2, X = Z + 2, P = n + M * 2, R = P + 2, ne = a + M * 2;
      for (let T = 8; T < s - 8; T++) {
        const C = (f[ne * s + T] ?? 0) | (f[(ne + 2) * s + T] ?? 0);
        if (C === 0) continue;
        const ae = (A.c[V * s + T] ?? 0) + ((A.c[q * s + T] ?? 0) << 2) + (A.c[J * s + T] ?? 0), I = Math.abs(
          3 * ((l[Z * s + T] ?? 0) + (l[X * s + T] ?? 0)) - ae
        ), _ = Math.abs(
          3 * ((o[P * s + T] ?? 0) + (o[R * s + T] ?? 0)) - ae
        );
        I > 23 && (C & 1) !== 0 && (u += I), _ > 23 && (C & 1) !== 0 && (p += _), I > 42 && (C & 2) !== 0 && (c += I), _ > 42 && (C & 2) !== 0 && (g += _), I > 42 && (C & 4) !== 0 && (d += I), _ > 42 && (C & 4) !== 0 && (w += _);
      }
    }
    c < 500 && g < 500 && (d >= 500 || w >= 500) && Math.max(d, w) > 3 * Math.min(d, w) && (c = d, g = w);
    const v = Math.floor(u / 6 + 0.5), k = Math.floor(p / 6 + 0.5), E = Math.floor(c / 6 + 0.5), m = Math.floor(g / 6 + 0.5), W = Math.max(v, k) / Math.max(Math.min(v, k), 1), O = Math.max(E, m) / Math.max(Math.min(E, m), 1), H = Math.max(E, m) / Math.max(Math.max(v, k), 1);
    return (E >= 500 || m >= 500) && (E * 2 < m || m * 2 < E) || (E >= 1e3 || m >= 1e3) && (E * 3 < m * 2 || m * 3 < E * 2) || (E >= 2e3 || m >= 2e3) && (E * 5 < m * 4 || m * 5 < E * 4) || (E >= 4e3 || m >= 4e3) && O > W || H > 5e-3 && Math.max(E, m) > 150 && (E * 2 < m || m * 2 < E) ? E > m ? t : e : v > k ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #de(e, t, i, A, s) {
    const r = Array.from(
      { length: Math.ceil(A / 2) },
      () => new Uint8Array(i)
    ), a = s === 1 ? 1 : 0;
    for (let o = 0; o < r.length; o++) {
      const f = Math.min(A - 1, a + o * 2), u = r[o];
      if (u)
        for (let c = 0; c < i; c++)
          u[c] = Math.abs(
            (e[f * i + c] ?? 0) - (t[f * i + c] ?? 0)
          );
    }
    const n = new Uint8Array(i * A), l = s === 1 ? 3 : 2;
    for (let o = 1; o < r.length - 1; o++) {
      const f = l + (o - 1) * 2;
      if (f >= A) break;
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
          let k = !1, E = !1;
          for (let m = Math.max(c - 4, 0); m < Math.min(c + 5, i); m++)
            o !== 1 && (r[o - 2]?.[m] ?? 0) > 19 && (k = !0), (r[o - 1]?.[m] ?? 0) > 19 && (w = !0), (r[o + 1]?.[m] ?? 0) > 19 && (v = !0), o !== r.length - 2 && (r[o + 2]?.[m] ?? 0) > 19 && (E = !0);
          w && (v || k) || v && (w || E) ? n[g] |= 2 : p > 5 && (n[g] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #I(e, t, i) {
    const A = new Uint8Array(t * i), s = (a, n) => e[Math.max(0, Math.min(i - 1, n)) * t + a] ?? 0;
    for (let a = 0; a < i; a++)
      for (let n = 0; n < t; n++) {
        const l = s(n, a), o = s(n, a === 0 ? 1 : a - 1), f = s(n, a === i - 1 ? i - 2 : a + 1), u = a < 2 ? s(n, a === 0 ? 2 : 3) : s(n, a - 2), c = a + 2 >= i ? s(n, a === i - 1 ? i - 3 : i - 4) : s(n, a + 2);
        (a === 0 ? Math.abs(l - f) > D.COMB_THRESHOLD : a === i - 1 ? Math.abs(l - o) > D.COMB_THRESHOLD : Math.abs(l - o) > D.COMB_THRESHOLD && Math.abs(l - f) > D.COMB_THRESHOLD) && Math.abs(
          4 * l - 3 * (o + f) + u + c
        ) > D.COMB_THRESHOLD * 6 && (A[a * t + n] = 255);
      }
    let r = 0;
    for (const a of [0, 8])
      for (const n of [0, 8])
        for (let l = a; l < i; l += 16)
          for (let o = n; o < t; o += 16) {
            let f = 0;
            for (let u = Math.max(1, l); u < Math.min(i - 1, l + 16); u++)
              for (let c = o; c < Math.min(t, o + 16); c++) {
                const d = u * t + c;
                A[d - t] === 255 && A[d] === 255 && A[d + t] === 255 && f++;
              }
            r = Math.max(r, f);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #me(e, t, i, A) {
    const s = D.DECIMATE_BLOCK / 2, r = Math.ceil(i / s), a = Math.ceil(A / s), n = new Float64Array(r * a), l = e.length / (i * A);
    for (let u = 0; u < A; u++) {
      const c = Math.floor(u / s);
      for (let d = 0; d < i; d++) {
        const p = Math.floor(d / s), g = c * r + p, w = (u * i + d) * l;
        if (l === 1) {
          n[g] = (n[g] ?? 0) + Math.abs((e[w] ?? 0) - (t[w] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[w] ?? 0) * 0.2126 + (e[w + 1] ?? 0) * 0.7152 + (e[w + 2] ?? 0) * 0.0722
        ), k = Math.round(
          (t[w] ?? 0) * 0.2126 + (t[w + 1] ?? 0) * 0.7152 + (t[w + 2] ?? 0) * 0.0722
        );
        if (n[g] = (n[g] ?? 0) + Math.abs(v - k), (d & 1) !== 0 || (u & 1) !== 0) continue;
        let E = 0, m = 0, W = 0, O = 0, H = 0, S = 0, M = 0;
        for (let X = u; X < Math.min(u + 2, A); X++)
          for (let P = d; P < Math.min(d + 2, i); P++) {
            const R = (X * i + P) * l;
            E += e[R] ?? 0, m += e[R + 1] ?? 0, W += e[R + 2] ?? 0, O += t[R] ?? 0, H += t[R + 1] ?? 0, S += t[R + 2] ?? 0, M++;
          }
        const V = Math.round(
          (-0.114572 * E - 0.385428 * m + 0.5 * W) / M
        ), q = Math.round(
          (-0.114572 * O - 0.385428 * H + 0.5 * S) / M
        ), J = Math.round(
          (0.5 * E - 0.454153 * m - 0.045847 * W) / M
        ), Z = Math.round(
          (0.5 * O - 0.454153 * H - 0.045847 * S) / M
        );
        n[g] = (n[g] ?? 0) + Math.abs(V - q) + Math.abs(J - Z);
      }
    }
    let o = -1;
    for (let u = 0; u < a - 1; u++)
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
const de = 8192;
let me = 0, G = 0, $ = [], Y = [];
const N = {
  requested: "auto",
  active: "starting",
  generation: 0,
  reason: "module-loaded"
};
function re(h) {
  Y.length === de && (Y.shift(), G++), Y.push(h);
}
function b(h) {
  const e = { ...h, sequence: ++me };
  if (typeof document < "u") {
    re({
      ...e,
      realm: "main",
      generation: N.generation,
      timeOriginMs: performance.timeOrigin
    });
    return;
  }
  $.length === de && ($.shift(), G++), $.push(e);
}
function ye(h, e) {
  for (const t of h.events)
    re({
      ...t,
      realm: "worker",
      generation: e,
      timeOriginMs: h.timeOriginMs
    });
  G += h.droppedEvents;
}
function L(h, e, t, i) {
  N.requested = h, N.active = e, N.generation = t, N.reason = i, typeof document < "u" && re({
    kind: "backend",
    sequence: ++me,
    realm: "main",
    generation: t,
    timeOriginMs: performance.timeOrigin,
    atMs: performance.now(),
    requested: h,
    active: e,
    reason: i
  });
}
typeof document < "u" && (globalThis.__YADIF_RENDER_TRACE__ = {
  schemaVersion: 2,
  get backend() {
    return { ...N };
  },
  get droppedEvents() {
    return G;
  },
  drain() {
    const h = { events: Y, droppedEvents: G };
    return Y = [], G = 0, h;
  }
});
let pe = null;
function Me(h) {
  pe = h;
}
const Te = 0.5, y = 3, se = 5, B = se + 1, oe = 1e3, ee = 4, te = 200, xe = 0.25, Fe = 1e3 / 60, ke = 0.02, Re = 250, Se = 1e3 / 30;
function he(h) {
  if (!Number.isFinite(h) || h < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return h;
}
const Ce = `#version 300 es
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
class He extends EventTarget {
  #d;
  #i;
  #e;
  #s;
  #b;
  #n;
  /** The program that copies a filtered picture onto the canvas. */
  #y;
  #X;
  #z;
  /** The reduced pass that reads previous, current and next luma together. */
  #P = null;
  #de = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #I = null;
  #me = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #ee = null;
  #Ke = null;
  #_ = null;
  #M = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #a = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #R = B - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #c = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #t = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #U = null;
  #pe = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #N = null;
  #te = 0;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #G = Fe;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #Y = null;
  #ke;
  #T;
  #p;
  #Z;
  #Re;
  #S = "video";
  #ie = "c";
  #Se = 0;
  #Ce = !0;
  #Le = new D(x, F);
  #Be = 1 / 0;
  #Pe = 1 / 0;
  #W = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #u = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #w = 0;
  #D = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #g = y - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #o = 0;
  #se = 0;
  #we = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #Ae = !1;
  #Q = null;
  /** requestVideoFrameCallback() の停止を検出するために保持する最終通知時刻。 */
  #ge = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #j = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #Ie = 0;
  #f = !1;
  #Ee = !1;
  #_e = !1;
  #h = null;
  #V = [];
  #x = !1;
  #Ue;
  #l;
  #ve;
  #m;
  #Ne;
  #r = null;
  #A;
  #q = !1;
  #F = 0;
  #Ge = !1;
  #Et = 0;
  #re = !1;
  #ne = null;
  #be = !1;
  #O = null;
  #vt = 0;
  #ae = /* @__PURE__ */ new Map();
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
  #C = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #We = 0;
  #De = 0;
  #H = 0;
  #oe = 0;
  #he = 0;
  #le = 0;
  #J = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#T = t.doubleRate ?? !1, this.#p = t.autoFilm ?? !1, this.#Z = he(
      t.filmCombThreshold ?? D.COMBED_PIXEL_LIMIT
    ), this.#Re = t.spatialCheck ?? !0, this.#Ue = t.onStats, this.#l = i, this.#m = i ? "main" : t.rendering ?? "auto", this.#Ne = t.workerUrl ?? pe, this.#A = this.#m === "main" ? "main" : "idle", i || L(
      this.#m,
      this.#A === "main" ? "main" : "starting",
      this.#F,
      this.#A === "main" ? "configured-main" : "configured-auto"
    ), this.#i = i ? i.canvas : document.createElement("canvas"), this.#d = i?.canvas ?? (this.#m === "main" ? this.#i : document.createElement("canvas")), this.#ve = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const A = this.#d.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!A) throw new Error("this browser has no WebGL2");
    this.#s = A, this.#b = z(A, Ee);
    const s = this.#b;
    this.#n = Object.fromEntries(
      Object.entries(ge).map(([r, a]) => [
        r,
        A.getUniformLocation(s, a)
      ])
    ), this.#y = z(A, Le), this.#X = A.getUniformLocation(this.#y, "uField"), this.#z = A.getUniformLocation(this.#y, "uFlip"), this.#p && this.#At(), this.#d.addEventListener(
      "webglcontextlost",
      this.#gt
    ), this.#ke = i ? null : new ResizeObserver(() => this.#Fe()), e.addEventListener("emptied", this.#mt), e.addEventListener("resize", this.#dt), e.addEventListener("pause", this.#B), e.addEventListener("ended", this.#B), e.addEventListener("seeking", this.#wt), e.addEventListener("seeked", this.#B), e.addEventListener("ratechange", this.#B);
  }
  get running() {
    return this.#f && (this.#h?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#i;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #ye() {
    return this.#h?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #$e() {
    return {
      doubleRate: this.#T,
      autoFilm: this.#p,
      filmCombThreshold: this.#Z,
      spatialCheck: this.#Re
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#Ee;
  }
  set enabled(e) {
    this.#Ee = e, this.#He(), this.#r?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#h?.interlaced !== e?.interlaced, i = t || this.#h?.topFieldFirst !== e?.topFieldFirst;
    this.#h = e, this.#r?.postMessage({ type: "scan", scan: e }), i && (this.#o = 0, this.#v(), t && (this.#u = 0), this.#c = null, this.#k(!1)), this.#He(), i && ((e?.interlaced ?? !0) && (this.#l || this.#A === "main") ? this.#K() : this.#Ze());
  }
  get scan() {
    return this.#h;
  }
  set videoTimeline(e) {
    this.#V = e, this.#r?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#h = null), this.#He();
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
    return this.#T;
  }
  set doubleRate(e) {
    e !== this.#T && (this.#T = e, this.#Oe(), this.#t.length = 0, e ? (this.#w > 0 && this.#qe(), (this.#h?.interlaced ?? !0) && (this.#l || this.#A === "main") && this.#K()) : this.#p || (this.#c = null, this.#k(!1), this.#$()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#p;
  }
  set autoFilm(e) {
    e !== this.#p && (this.#p = e, this.#Oe(), this.#v(), e ? (this.#At(), this.#w > 0 && (this.#ft(), this.#qe()), (this.#h?.interlaced ?? !0) && (this.#l || this.#A === "main") && this.#K()) : (this.#Ve(), this.#T || (this.#c = null, this.#k(!1), this.#$())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#Z;
  }
  set filmCombThreshold(e) {
    const t = he(e);
    t !== this.#Z && (this.#Z = t, this.#Oe(), this.#p && this.#v());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Oe() {
    this.#r?.postMessage({
      type: "settings",
      options: this.#$e()
    });
  }
  #He() {
    this.#Ee && (this.#V.length > 0 || (this.#h?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #bt() {
    return this.#l || this.#m === "main" ? !1 : this.#A === "starting" || this.#A === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Ne !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#et(), !0) : this.#m === "auto" ? (this.#Me("capability-fallback"), !1) : (this.#A = "failed", this.#f = !1, L(
      this.#m,
      "failed",
      this.#F,
      "required-worker-unavailable"
    ), !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #et() {
    this.#L(), this.#r?.terminate(), this.#r = null, this.#re = !1, this.#ne = null, this.#be = !1;
    let e = this.#i;
    if (this.#Ge) {
      e = document.createElement("canvas"), e.className = this.#i.className;
      const s = this.#i.getAttribute("style");
      s === null ? e.removeAttribute("style") : e.setAttribute("style", s), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e;
    }
    const t = ++this.#F;
    this.#A = "starting", L(
      this.#m,
      "starting",
      t,
      this.#q ? "worker-restarting" : "worker-starting"
    );
    let i, A;
    try {
      A = e.transferControlToOffscreen(), this.#Ge = !0, i = new Worker(this.#Ne, { type: "module" });
    } catch (s) {
      this.#ce(
        s instanceof Error ? s.message : String(s)
      );
      return;
    }
    this.#r = i, i.onmessage = (s) => {
      t === this.#F && this.#Dt(s.data);
    }, i.onerror = (s) => {
      t === this.#F && (s.preventDefault(), this.#ce(s.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: A,
        options: this.#$e(),
        scan: this.#h,
        videoTimeline: this.#V,
        enabled: this.#f,
        video: this.#Xe()
      },
      [A]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #Dt(e) {
    switch (e.type) {
      case "ready":
        this.#A = "active", L(
          this.#m,
          "worker",
          this.#F,
          "worker-ready"
        ), this.#f && (this.#ue(), this.#Qe());
        break;
      case "failed":
        this.#ce(e.message);
        break;
      case "consumed": {
        this.#re = !1, this.#be = !0;
        const t = performance.now(), i = this.#ne;
        b({
          kind: "worker-bridge",
          atMs: t,
          stage: "acknowledged",
          id: e.id,
          relatedId: null,
          durationMs: i?.id === e.id ? t - i.atMs : null
        }), this.#ne = null;
        const A = this.#O;
        this.#O = null, A && this.#it(A);
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
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#Ue?.(t);
        break;
      }
      case "diagnostic-batch":
        ye(e.batch, this.#F);
        break;
      case "capture": {
        const t = this.#ae.get(e.id);
        if (this.#ae.delete(e.id), !t) {
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
    if (this.#A === "starting" && this.#m === "auto" && !this.#q) {
      this.#Me("initialization-fallback");
      return;
    }
    if (this.#tt(e), !this.#q) {
      this.#q = !0, this.#et();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#A = "failed", L(
      this.#m,
      "failed",
      this.#F,
      "worker-terminal-failure"
    ), this.#r?.terminate(), this.#r = null, this.#L(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #Me(e) {
    const t = this.#d;
    t.className = this.#i.className;
    const i = this.#i.getAttribute("style");
    i === null ? t.removeAttribute("style") : t.setAttribute("style", i), t.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(t), this.#i = t, this.#Ge = !1, this.#r?.terminate(), this.#r = null, this.#A = "main", L(this.#m, "main", this.#F, e), this.#L(), this.#f && (this.#ue(), this.#Qe(), (this.#h?.interlaced ?? !0) && this.#K());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #L() {
    this.#O?.frame.close(), this.#O = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #tt(e) {
    for (const t of this.#ae.values())
      t.reject(new Error(e));
    this.#ae.clear();
  }
  start() {
    if (!(this.#f || this.#_e || this.#x)) {
      if (this.#f = !0, this.#pt(), this.#v(), this.#ge = performance.now(), this.#Ie = this.#ge, this.#we = Number.NaN, this.#j = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#_t(), this.#Qe(), this.#bt()) {
        this.#r?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#A === "active" && this.#ue();
        return;
      }
      this.#ue(), (this.#h?.interlaced ?? !0) && this.#K();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#f && (this.#f = !1, this.#Q !== null && this.#e.cancelVideoFrameCallback(this.#Q), this.#Q = null, this.#St(), this.#Ze(), this.#o = 0, this.#c = null, this.#k(!1), this.#L(), this.#r?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#_e) {
      this.#_e = !0, this.#Ee = !1, this.stop(), this.#r?.postMessage({ type: "destroy" }), this.#r?.terminate(), this.#r = null, L(
        this.#m,
        "failed",
        this.#F,
        "destroyed"
      ), this.#L(), this.#tt("the deinterlacer was destroyed"), this.#d.removeEventListener(
        "webglcontextlost",
        this.#gt
      ), this.#e.removeEventListener("emptied", this.#mt), this.#e.removeEventListener("resize", this.#dt), this.#e.removeEventListener("pause", this.#B), this.#e.removeEventListener("ended", this.#B), this.#e.removeEventListener("seeking", this.#wt), this.#e.removeEventListener("seeked", this.#B), this.#e.removeEventListener("ratechange", this.#B), this.#Ut();
      for (const e of this.#M) this.#s.deleteTexture(e);
      this.#M = [], this.#$(), this.#Ve(), this.#s.deleteProgram(this.#b), this.#s.deleteProgram(this.#y), this.#P && this.#s.deleteProgram(this.#P), this.#I && this.#s.deleteProgram(this.#I), this.#ee && this.#s.deleteProgram(this.#ee), this.#s.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#A === "active" && this.#i.style.visibility === "visible" && this.#r) {
      const A = ++this.#vt, s = new Promise((r, a) => {
        this.#ae.set(A, { resolve: r, reject: a });
      });
      return this.#r.postMessage({
        type: "capture",
        id: A,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), s;
    }
    if (this.#A === "starting" || this.#A === "failed")
      return createImageBitmap(this.#e);
    const e = this.#c;
    if (this.#l && (!this.#f || this.#x || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#f || this.#x || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#je(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#fe(e.flush, e.second, null, !1) : this.#ze(null, !1);
    const t = this.#e.videoWidth, i = this.#e.videoHeight;
    return t > 0 && i > 0 && (t !== this.#d.width || i !== this.#d.height) ? createImageBitmap(this.#d, {
      resizeWidth: t,
      resizeHeight: i,
      resizeQuality: "high"
    }) : createImageBitmap(this.#d);
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #ue() {
    this.#l || !this.#f || this.#Q !== null || (this.#Q = this.#e.requestVideoFrameCallback(this.#Mt));
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #Xe() {
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
    const i = ++this.#Et, A = performance.now();
    let s;
    try {
      s = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (n) {
      const l = n instanceof Error ? n.message : String(n);
      this.#m === "auto" && !this.#be && !this.#q ? (this.#Me("video-frame-fallback"), this.#Te(e, t)) : this.#ce(l);
      return;
    }
    const r = performance.now();
    b({
      kind: "worker-bridge",
      atMs: r,
      stage: "offered",
      id: i,
      relatedId: null,
      durationMs: r - A
    });
    const a = {
      id: i,
      frame: s,
      now: e,
      metadata: t,
      video: this.#Xe()
    };
    if (this.#re) {
      const n = this.#O?.id ?? null, l = performance.now();
      this.#O?.frame.close();
      const o = performance.now();
      this.#O = a, b({
        kind: "worker-bridge",
        atMs: o,
        stage: n === null ? "pending-set" : "pending-replaced",
        id: i,
        relatedId: n,
        durationMs: o - l
      });
      return;
    }
    this.#it(a);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #it(e) {
    const t = this.#r;
    if (!t || this.#A !== "active") {
      e.frame.close();
      return;
    }
    this.#re = !0;
    const i = { type: "frame", ...e };
    try {
      const A = performance.now();
      t.postMessage(i, [e.frame]);
      const s = performance.now();
      this.#ne = { id: e.id, atMs: s }, b({
        kind: "worker-bridge",
        atMs: s,
        stage: "sent",
        id: e.id,
        relatedId: null,
        durationMs: s - A
      });
    } catch (A) {
      this.#re = !1, this.#ne = null, e.frame.close();
      const s = A instanceof Error ? A.message : String(A);
      this.#m === "auto" && !this.#be && !this.#q ? (this.#Me("transfer-fallback"), this.#Te(e.now, e.metadata)) : this.#ce(s);
    }
  }
  #Mt = (e, t) => {
    this.#Q = null, !(!this.#f || this.#x) && (this.#ge = e, this.#j = Math.max(
      this.#j,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), b({
      kind: "frame-ingest",
      atMs: e,
      mediaTime: t.mediaTime,
      presentedFrames: t.presentedFrames,
      path: "callback"
    }), this.#st(e, t), this.#ue());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #st(e, t) {
    if (this.#we = t.mediaTime, this.#A === "active") {
      this.#yt(e, t);
      return;
    }
    this.#A !== "starting" && this.#Te(e, t);
  }
  /** @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。 */
  ingestExternalFrame(e, t, i) {
    b({
      kind: "frame-ingest",
      atMs: e,
      mediaTime: t.mediaTime,
      presentedFrames: t.presentedFrames,
      path: "worker-transfer"
    }), this.#ve = i;
    try {
      this.#Te(e, t);
    } finally {
      this.#ve = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #Te(e, t) {
    if (this.#Tt(t.mediaTime), t.width > 0 && t.height > 0) {
      let i = !1;
      if (!this.#Ae && this.#e.seeking) {
        const c = this.#e.buffered, d = this.#u >= ee ? this.#u / 1e3 : te / 1e3;
        for (let p = 0; p < c.length; p++)
          if (t.mediaTime >= c.start(p) && t.mediaTime < c.end(p) && Math.abs(t.mediaTime - this.#e.currentTime) <= d) {
            i = !0;
            break;
          }
      }
      if (i && (this.#Ae = !0), (this.#w === 0 || this.#D === 0) && this.#ut(t.width, t.height), this.#h && !this.#h.interlaced) {
        this.#Bt();
        return;
      }
      const A = t.mediaTime - this.#se, s = i || A < 0 || A > Te;
      s && (this.#o = 0, this.#u = 0, this.#E.discontinuities++, this.#t.length = 0, this.#v());
      const r = this.#p && this.#C !== 0 && t.presentedFrames - this.#C > 1;
      if (this.#Pt(t.presentedFrames, s), !s && r && (this.#o = 0, this.#v()), this.#o > 0 && t.mediaTime === this.#se)
        return;
      !s && A > 0 && this.#xt(A), this.#se = t.mediaTime;
      const a = performance.now();
      a - this.#We > oe && (this.#De = a, this.#H = 0, this.#oe = 0, this.#he = 0, this.#le = 0, this.#J = 0, this.#W = 0), this.#We = a;
      const n = performance.now();
      this.#ct();
      const l = this.#S, o = this.#p && this.#o === y && this.#Ft();
      if (l !== this.#S && (this.#t.length = 0), !(o && this.#xe())) if (this.#p && !this.#Ce && this.#S === "film")
        if (this.#xe()) {
          const c = this.#u * 5 / 4, d = this.#nt(1, e, c), p = this.#t.at(-1), g = d ? e : p == null ? e + c : p.at + p.duration;
          this.#kt(g, c);
        } else
          this.#ze(null);
      else if (this.#T && this.#xe()) {
        const c = this.#u / 2, d = this.#nt(2, e, c), p = this.#t.at(-1), g = d ? e : p == null ? e + c * 2 : p.at + p.duration;
        this.#rt(!1, g, c), this.#rt(!0, g + c, c);
      } else
        this.#E.late += this.#t.length, this.#t.length = 0, this.#fe(!1, !1, null);
      this.#J = Math.max(
        this.#J,
        this.#t.length
      ), this.#oe += performance.now() - n, this.#H++, this.#It(a);
    }
  }
  #Tt(e) {
    let t;
    for (let s = this.#V.length - 1; s >= 0; s--) {
      const r = this.#V[s];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#w || t.codedSize.height !== this.#D) && this.#ut(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#h?.interlaced === i.interlaced && this.#h.topFieldFirst === i.topFieldFirst)
      return;
    const A = this.#h?.interlaced;
    this.#h = i, this.#o = 0, this.#t.length = 0, this.#v(), A !== i.interlaced && (this.#u = 0), i.interlaced && (this.#l || this.#A === "main") ? this.#K() : this.#Ze();
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #xe() {
    return (this.#T || this.#p) && this.#u > 0 && this.#a.length === B;
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
  #xt(e) {
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#u > 0 ? Math.max(1, Math.round(t / this.#u)) : 1, A = t / i;
    A < ee || A > te || (this.#u = this.#u > 0 ? this.#u + (A - this.#u) * xe : A);
  }
  /** Build the optional film passes only for callers that enable them. */
  #At() {
    if (this.#P && this.#I && this.#ee) return;
    const e = this.#s, t = z(e, ve), i = z(e, be), A = z(e, De);
    this.#P = t, this.#de = Object.fromEntries(
      Object.entries(K).filter(([s]) => s !== "match" && s !== "topFieldFirst").map(([s, r]) => [s, e.getUniformLocation(t, r)])
    ), this.#I = i, this.#me = Object.fromEntries(
      Object.entries(K).map(([s, r]) => [
        s,
        e.getUniformLocation(i, r)
      ])
    ), this.#ee = A, this.#Ke = Object.fromEntries(
      Object.entries(K).map(([s, r]) => [
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
  #Ft() {
    const e = this.#_, t = this.#P, i = this.#de, A = this.#ee, s = this.#Ke;
    if (!e || !t || !i || !A || !s)
      return !1;
    const r = this.#s, a = this.#g, n = (this.#g + y - 1) % y, l = (this.#g + 1) % y, o = this.#ye;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [w, v] of [l, n, a].entries())
      r.activeTexture(r.TEXTURE0 + w), r.bindTexture(r.TEXTURE_2D, this.#M[v] ?? null);
    r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#w, this.#D), r.viewport(0, 0, x, F), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      x,
      F,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: f, currentLuma: u, nextLuma: c } = e;
    for (let w = 0; w < f.length; w++) {
      const v = w * 4;
      f[w] = e.pixels[v] ?? 0, u[w] = e.pixels[v + 1] ?? 0, c[w] = e.pixels[v + 2] ?? 0;
    }
    const d = this.#Le.fieldMatch(
      f,
      u,
      c,
      o,
      this.#Z
    );
    r.useProgram(A), r.uniform1i(s.prev, 0), r.uniform1i(s.cur, 1), r.uniform1i(s.next, 2), r.uniform2i(s.size, this.#w, this.#D), r.uniform1i(s.topFieldFirst, o ? 1 : 0), r.uniform1i(
      s.match,
      d.match === "p" ? 0 : d.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      x,
      F,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const p = this.#Le.decimate(e.pixels);
    this.#ie = d.match, this.#Se = d.combScore, this.#Ce = d.isCombed, this.#Be = p.lowestCycleDifference, this.#Pe = p.runnerUpCycleDifference;
    const g = p.dropIndex !== null && !d.isCombed;
    return (g ? "film" : "video") !== this.#S && (this.#S = g ? "film" : "video"), p.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #kt(e, t) {
    const i = this.#Ye();
    if (i === null) return;
    const A = this.#a[i];
    if (A) {
      for (this.#R = i; this.#t.length > 0 && this.#t[0]?.slot === i; )
        this.#t.shift(), this.#E.late++;
      this.#ze(A.framebuffer), this.#t.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #ze(e, t = !0) {
    const i = this.#I, A = this.#me;
    if (!i || !A) return;
    const s = this.#s, r = this.#g, a = (this.#g + y - 1) % y, n = (this.#g + 1) % y, l = this.#ye;
    s.bindFramebuffer(s.FRAMEBUFFER, e), s.useProgram(i);
    for (const [o, f] of [n, a, r].entries())
      s.activeTexture(s.TEXTURE0 + o), s.bindTexture(s.TEXTURE_2D, this.#M[f] ?? null);
    s.uniform1i(A.prev, 0), s.uniform1i(A.cur, 1), s.uniform1i(A.next, 2), s.uniform2i(A.size, this.#w, this.#D), s.uniform1i(A.topFieldFirst, l ? 1 : 0), s.uniform1i(
      A.match,
      this.#ie === "p" ? 0 : this.#ie === "c" ? 1 : 2
    ), s.viewport(0, 0, this.#w, this.#D), s.drawArrays(s.TRIANGLES, 0, 3), e === null && (this.#c = { kind: "film" }, this.#k(!0), t && (this.#W++, b({
      kind: "draw-submit",
      atMs: performance.now(),
      rafAtMs: null,
      scheduledAtMs: null,
      queueDepthAfter: this.#t.length,
      path: "film-direct"
    })));
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
    const A = this.#Ye();
    if (A === null) return;
    const s = this.#a[A];
    if (s) {
      for (this.#R = A; this.#t.length > 0 && this.#t[0]?.slot === A; )
        this.#t.shift(), this.#E.late++;
      this.#fe(!1, e, s.framebuffer), this.#t.push({ slot: A, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #nt(e, t, i) {
    const A = this.#t.at(-1), s = (se + 1) * Math.max(this.#G, i);
    if (A && A.at - t > s)
      return this.#t.length = 0, this.#E.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#t.length + e - se
    );
    let a = 0, n = 0;
    for (; n < r; ) {
      const l = this.#t.shift();
      if (!l) break;
      a += l.duration, n++;
    }
    for (const l of this.#t) l.at -= a;
    return this.#E.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Ye() {
    const e = this.#c?.kind === "texture" ? this.#c.texture : null, t = this.#a.findIndex(
      (r) => r?.texture === e
    ), i = t < 0 ? null : t, A = new Set(this.#t.map(({ slot: r }) => r));
    for (let r = 1; r <= B; r++) {
      const a = (this.#R + r) % B, n = this.#a[a];
      if (n && n.texture !== e && !A.has(a))
        return a;
    }
    const s = this.#t[0];
    if (s) {
      const r = this.#a[s.slot];
      if (r && r.texture !== e)
        return b({
          kind: "slot-pressure",
          atMs: performance.now(),
          outcome: "oldest",
          resultSlot: s.slot,
          outputPoolLength: this.#a.length,
          initializedOutputs: this.#a.filter(Boolean).length,
          outputHead: this.#R,
          shownSlot: i,
          queuedSlots: [...A]
        }), s.slot;
    }
    return b({
      kind: "slot-pressure",
      atMs: performance.now(),
      outcome: "none",
      resultSlot: null,
      outputPoolLength: this.#a.length,
      initializedOutputs: this.#a.filter(Boolean).length,
      outputHead: this.#R,
      shownSlot: i,
      queuedSlots: [...A]
    }), null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #K() {
    this.#U === null && (!this.#f || this.#x || (this.#pe = 0, this.#U = this.#ot(this.#at)));
  }
  #Ze() {
    this.#U !== null && this.#Rt(this.#U), this.#U = null, this.#t.length = 0;
  }
  #at = (e) => {
    if (this.#U = null, !this.#f || this.#x) return;
    const t = this.#pe > 0 ? e - this.#pe : null;
    if (t !== null) {
      const s = t;
      s >= 1 && s <= te && (this.#G = s < this.#G ? s : this.#G + (s - this.#G) * ke);
    }
    this.#pe = e;
    const i = this.#c?.kind === "texture" ? this.#c.texture : null, A = this.#a.findIndex(
      (s) => s?.texture === i
    );
    b({
      kind: "raf",
      atMs: e,
      gapMs: t,
      queueDepth: this.#t.length,
      refreshMs: this.#G,
      outputPoolLength: this.#a.length,
      initializedOutputs: this.#a.filter(Boolean).length,
      outputHead: this.#R,
      shownSlot: A < 0 ? null : A,
      queue: this.#t.map(({ slot: s, at: r, duration: a }) => ({
        slot: s,
        atMs: r,
        durationMs: a
      }))
    }), this.#A === "main" && this.#Lt(e), this.#U = this.#ot(this.#at);
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
    this.#l || this.#N !== null || !this.#f || this.#x || (this.#te = 0, this.#N = requestAnimationFrame(this.#ht));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #St() {
    this.#N !== null && cancelAnimationFrame(this.#N), this.#N = null, this.#te = 0;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #ht = (e) => {
    this.#N = null, !(!this.#f || this.#x) && (b({
      kind: "page-raf",
      atMs: e,
      gapMs: this.#te > 0 ? e - this.#te : null
    }), this.#te = e, this.#Ct(e), this.#N = requestAnimationFrame(this.#ht));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #Ct(e) {
    if (this.#l || e - this.#ge < Re || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, A = this.#u >= ee ? this.#u : Se, s = i > this.#j, r = t !== this.#we && e - this.#Ie >= A * 0.75;
    !s && !r || (this.#j = Math.max(
      this.#j,
      i
    ), this.#Ie = e, b({
      kind: "frame-ingest",
      atMs: e,
      mediaTime: t,
      presentedFrames: Math.max(this.#C + 1, i),
      path: "watchdog"
    }), this.#st(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#C + 1, i),
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
  #Lt(e) {
    const t = e + this.#G * 1.5;
    for (; this.#t[1] && this.#t[1].at <= t; )
      this.#E.late++, this.#t.shift();
    let i = this.#t[0];
    if (!i || i.at > t)
      return;
    this.#t.shift();
    const A = performance.now();
    this.#lt(i.slot);
    const s = performance.now();
    this.#le += s - A, this.#he++, b({
      kind: "draw-submit",
      atMs: s,
      rafAtMs: e,
      scheduledAtMs: i.at,
      queueDepthAfter: this.#t.length,
      path: "scheduled"
    });
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #lt(e) {
    const t = this.#a[e];
    t && this.#je(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Bt() {
    this.#ct();
    const e = this.#M[this.#g];
    e && (this.#je(e, !0), b({
      kind: "draw-submit",
      atMs: performance.now(),
      rafAtMs: null,
      scheduledAtMs: null,
      queueDepthAfter: this.#t.length,
      path: "progressive"
    })), this.#o = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #k(e) {
    if (this.#l) {
      this.#l.onVisibility(e);
      return;
    }
    this.#i.style.visibility = e ? "visible" : "hidden";
  }
  #je(e, t = !1, i = !0) {
    const A = this.#s;
    A.bindFramebuffer(A.FRAMEBUFFER, null), A.useProgram(this.#y), A.activeTexture(A.TEXTURE0), A.bindTexture(A.TEXTURE_2D, e), A.uniform1i(this.#X, 0), A.uniform1i(this.#z, t ? 1 : 0), A.viewport(0, 0, this.#w, this.#D), A.drawArrays(A.TRIANGLES, 0, 3), this.#c = { kind: "texture", texture: e, flip: t }, this.#k(!0), i && this.#W++;
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
    this.#C !== 0 && !t && (this.#E.missed += Math.max(0, e - this.#C - 1)), this.#C = e;
  }
  #It(e) {
    const t = e - this.#De;
    if (t < oe) return;
    const i = this.#xe() && (this.#T || this.#S === "film") ? this.#he : this.#H, A = {
      ...this.#E,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#H === 0 ? 0 : (this.#oe + this.#le) / this.#H,
      maxQueuedFields: this.#J,
      mode: this.#S,
      match: this.#ie,
      combScore: this.#Se,
      outputFps: this.#W * 1e3 / t,
      duplicateScore: this.#Be,
      duplicateRunnerUp: this.#Pe
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: A })), this.#Ue?.(A), this.#De = e, this.#H = 0, this.#oe = 0, this.#he = 0, this.#le = 0, this.#J = 0, this.#W = 0;
  }
  /** Take the newest frame into the ring. */
  #ct() {
    const e = this.#s;
    this.#g = (this.#g + 1) % y, e.bindTexture(e.TEXTURE_2D, this.#M[this.#g] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#ve
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
  #fe(e, t, i, A = !0) {
    if (this.#o === 0 || this.#x) return;
    A && (this.#o === y && !e ? this.#E.filtered++ : this.#E.degraded++);
    const s = this.#s, r = this.#g, a = (this.#g + y - 1) % y, n = (this.#g + 1) % y;
    let l, o, f;
    this.#o === 1 ? l = o = f = r : e ? (l = a, o = f = r) : this.#o === 2 ? (l = o = a, f = r) : (l = n, o = a, f = r), s.bindFramebuffer(s.FRAMEBUFFER, i), s.useProgram(this.#b);
    for (const [c, d] of [l, o, f].entries())
      s.activeTexture(s.TEXTURE0 + c), s.bindTexture(s.TEXTURE_2D, this.#M[d] ?? null);
    s.uniform1i(this.#n.prev, 0), s.uniform1i(this.#n.cur, 1), s.uniform1i(this.#n.next, 2), s.uniform2i(this.#n.size, this.#w, this.#D);
    const u = this.#ye ? 0 : 1;
    s.uniform1i(this.#n.parity, t ? 1 - u : u), s.uniform1i(this.#n.tff, this.#ye ? 1 : 0), s.uniform1i(this.#n.spatialCheck, this.#Re ? 1 : 0), s.viewport(0, 0, this.#w, this.#D), s.drawArrays(s.TRIANGLES, 0, 3), i === null && (this.#c = { kind: "yadif", flush: e, second: t }, this.#k(!0), A && (this.#W++, b({
      kind: "draw-submit",
      atMs: performance.now(),
      rafAtMs: null,
      scheduledAtMs: null,
      queueDepthAfter: this.#t.length,
      path: e ? "flush" : "yadif-direct"
    })));
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
  #Fe() {
    if (!this.#Y) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const A = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), s = t * A, r = i * A;
    this.#i.style.left = `${e.offsetLeft + (e.offsetWidth - s) / 2}px`, this.#i.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#i.style.width = `${s}px`, this.#i.style.height = `${r}px`;
  }
  #ut(e, t) {
    const i = this.#s;
    this.#d.width = e, this.#d.height = t, this.#w = e, this.#D = t, this.#o = 0, this.#c = null, this.#v(), this.#Fe();
    for (const A of this.#M) i.deleteTexture(A);
    this.#M = [];
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
      ), this.#M.push(s);
    }
    this.#$(), this.#Ve(), this.#p && this.#ft(), (this.#T || this.#p) && this.#qe();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #ft() {
    if (this.#_) return;
    const e = this.#s, t = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      x,
      F,
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
    this.#_ = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(x * F * 4),
      previousLuma: new Uint8Array(x * F),
      currentLuma: new Uint8Array(x * F),
      nextLuma: new Uint8Array(x * F)
    };
  }
  #Ve() {
    this.#_ && (this.#s.deleteFramebuffer(this.#_.framebuffer), this.#s.deleteTexture(this.#_.texture), this.#_ = null);
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
  #qe() {
    const e = this.#s;
    if (!(this.#a.length === B || this.#w === 0)) {
      this.#$();
      for (let t = 0; t < B; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#w,
          this.#D,
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
          e.deleteFramebuffer(A), e.deleteTexture(i), this.#$();
          return;
        }
        this.#a.push({ texture: i, framebuffer: A });
      }
      this.#R = B - 1;
    }
  }
  #$() {
    const e = this.#s, t = this.#c?.kind === "texture" ? this.#c.texture : null;
    this.#a.some((i) => i.texture === t) && (this.#c = null);
    for (const { texture: i, framebuffer: A } of this.#a)
      e.deleteFramebuffer(A), e.deleteTexture(i);
    this.#a = [], this.#t.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #_t() {
    if (this.#Y) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#Y = t, this.#ke?.observe(this.#e), this.#Fe();
  }
  #Ut() {
    if (this.#l) return;
    const e = this.#Y;
    this.#Y = null, this.#ke?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #dt = () => this.#Fe();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #Je(e) {
    return !this.#r || this.#A === "main" ? !1 : (this.#r.postMessage({
      type: "event",
      name: e,
      video: this.#Xe()
    }), !0);
  }
  #mt = () => {
    if (this.#we = Number.NaN, this.#Je("emptied")) {
      this.#L(), this.#k(!1);
      return;
    }
    this.#o = 0, this.#se = 0, this.#t.length = 0, this.#u = 0, this.#pt(), this.#v(), this.#c = null, this.#k(!1);
  };
  #pt() {
    this.#E = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#C = 0, this.#De = 0, this.#We = 0, this.#H = 0, this.#oe = 0, this.#he = 0, this.#le = 0, this.#J = 0, this.#W = 0, this.#v();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #v() {
    this.#t.length = 0, this.#S = "video", this.#ie = "c", this.#Se = 0, this.#Ce = !0, this.#Le.reset(), this.#Be = 1 / 0, this.#Pe = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #wt = () => {
    if (this.#Je("seeking")) {
      this.#L();
      return;
    }
    this.#Ae = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #B = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#Je(e.type)) {
      this.#L();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#Ae;
      if (this.#Ae = !1, i) return;
      this.#o = 0, this.#v(), this.#c = null, this.#k(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#u = 0, this.#se = this.#e.currentTime), this.#t.length = 0, this.#f && this.#o > 0) {
      const i = this.#Ye(), A = i === null ? void 0 : this.#a[i];
      i !== null && A ? (this.#R = i, this.#fe(!0, !1, A.framebuffer), this.#lt(i), b({
        kind: "draw-submit",
        atMs: performance.now(),
        rafAtMs: null,
        scheduledAtMs: null,
        queueDepthAfter: this.#t.length,
        path: "flush"
      })) : this.#fe(!0, !1, null);
    }
    t && (this.#o = 0, this.#v());
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
    this.#A !== "active" && (this.#x = !0, this.stop());
  };
}
function z(h, e) {
  const t = h.createProgram(), i = le(h, h.VERTEX_SHADER, Ce), A = le(h, h.FRAGMENT_SHADER, e);
  if (h.attachShader(t, i), h.attachShader(t, A), h.linkProgram(t), h.deleteShader(i), h.deleteShader(A), !h.getProgramParameter(t, h.LINK_STATUS)) {
    const s = h.getProgramInfoLog(t);
    throw h.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${s ?? "no reason given"}`
    );
  }
  return t;
}
function le(h, e, t) {
  const i = h.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (h.shaderSource(i, t), h.compileShader(i), !h.getShaderParameter(i, h.COMPILE_STATUS)) {
    const A = h.getShaderInfoLog(i);
    throw h.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${A ?? "no reason given"}`
    );
  }
  return i;
}
const ce = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", Be = 0.5, Pe = 3e3, ue = 0.1, U = 16, fe = 'video/mp4; codecs="avc1.640029"';
let Ae = null;
function Ie(h = {}) {
  return Ae ??= _e(h), Ae;
}
async function Xe(h = {}) {
  return (await Ie(h)).deinterlaces;
}
function ze() {
  Ae = null;
}
async function _e(h) {
  const e = h.tolerance ?? Be, t = h.timeoutMs ?? Pe, i = performance.now(), A = (a) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: a instanceof Error ? a.message : String(a)
  });
  if (typeof document > "u")
    return A(new Error("there is no document to decode in"));
  const s = document.createElement("video");
  s.muted = !0, s.defaultMuted = !0, s.playsInline = !0, s.preload = "auto";
  let r = null;
  try {
    r = Ne(s, t);
    const a = j(Q(s, "loadeddata"), t), n = s.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await a, await Ge(s, t, await n), s.videoWidth === 0 || s.videoHeight === 0)
      return A(new Error("the probe clip decoded to nothing"));
    const l = We(s);
    return {
      deinterlaces: l < 1 - e,
      survives: l,
      tookMs: performance.now() - i
    };
  } catch (a) {
    return A(a);
  } finally {
    s.pause(), s.removeAttribute("src"), s.replaceChildren(), s.load(), r && URL.revokeObjectURL(r.url);
  }
}
const ie = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Ue = typeof MediaSource > "u";
function Ne(h, e) {
  if (!ie || !ie.isTypeSupported(fe))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = ce.indexOf(","), i = atob(ce.slice(t + 1)), A = new Uint8Array(i.length);
  for (let n = 0; n < i.length; n++) A[n] = i.charCodeAt(n);
  const s = new ie(), r = URL.createObjectURL(s);
  if (Ue) {
    h.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, h.append(n), h.load();
  } else
    h.src = r;
  const a = (async () => {
    await j(Q(s, "sourceopen"), e);
    const n = s.addSourceBuffer(fe), l = j(Q(n, "updateend"), e);
    n.appendBuffer(A), await l, s.endOfStream();
  })();
  return { url: r, ready: a };
}
async function Ge(h, e, t) {
  if (t) {
    const i = performance.now();
    for (; h.currentTime < ue && performance.now() - i < e; )
      await new Promise((A) => requestAnimationFrame(A));
    h.pause();
  } else
    h.currentTime = ue, await j(Q(h, "seeked"), e);
}
function We(h) {
  const e = h.videoHeight, t = document.createElement("canvas");
  t.width = U, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(h, 0, 0, U, e);
  const A = i.getImageData(0, 0, U, e).data, s = (o) => {
    let f = 0;
    for (let u = 0; u < U; u++)
      f += A[(o * U + u) * 4 + 1] ?? 0;
    return f / U;
  };
  let r = 0;
  const a = 2, n = e - 3;
  let l = s(a);
  for (let o = a + 1; o <= n; o++) {
    const f = s(o);
    r += Math.abs(f - l), l = f;
  }
  return r / (n - a) / 255;
}
function Q(h, e) {
  return new Promise((t, i) => {
    h.addEventListener(e, () => t(), { once: !0 }), h.addEventListener(
      "error",
      () => {
        const A = h instanceof HTMLMediaElement ? h.error : null, s = A ? ` (MediaError ${A.code}${A.message ? `: ${A.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${s}`));
      },
      { once: !0 }
    );
  });
}
function j(h, e) {
  return Promise.race([
    h,
    new Promise(
      (t, i) => setTimeout(
        () => i(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
Me(we);
export {
  He as Deinterlacer,
  ve as FILM_ANALYSIS_FRAGMENT_SHADER,
  De as FILM_SAMPLE_FRAGMENT_SHADER,
  K as FILM_UNIFORMS,
  be as FILM_WEAVE_FRAGMENT_SHADER,
  Ee as YADIF_FRAGMENT_SHADER,
  ge as YADIF_UNIFORMS,
  Xe as decoderDeinterlaces,
  ze as forgetDecoderProbe,
  Ie as probeDecoder,
  Oe as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
