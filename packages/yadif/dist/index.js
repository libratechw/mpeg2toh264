const he = "" + new URL("assets/worker-CHHR8w0w.js", import.meta.url).href, ae = {
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
class b {
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
    this.#u = e, this.#i = t, this.#e = 255 * b.DECIMATE_BLOCK ** 2 * b.DUPLICATE_PERCENT / 100;
  }
  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the matching
   * arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(e, t, i, A, s = b.COMBED_PIXEL_LIMIT) {
    const r = A ? 1 : 0, l = { p: e, c: t, n: i };
    let n = this.#k("c", "p", r, l);
    const u = /* @__PURE__ */ new Map(), o = (d) => {
      const E = u.get(d);
      if (E !== void 0) return E;
      const w = b.#L(
        this.weave(e, t, i, d, A),
        this.#u,
        this.#i
      );
      return u.set(d, w), w;
    }, f = o(n), c = o("n");
    (c * 3 < f || c * 2 < f && f > s) && Math.abs(c - f) >= 30 && c < s && (n = "n");
    const h = o(n), p = h >= s;
    return p && (n = "c"), {
      match: n,
      combScore: h,
      isCombed: p,
      luma: this.weave(e, t, i, n, A)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#A, i = this.#D ? b.#ue(
      this.#D,
      e,
      this.#u,
      this.#i
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#n.push(i);
    const A = this.#v === t, s = A && i.maxBlockDifference < this.#e;
    A && !s && (this.#v = null);
    const r = this.#v;
    this.#D = e.slice(), this.#A++;
    let l = this.#v;
    if (this.#A === b.CYCLE) {
      let n = 0, u = null;
      for (let o = 1; o < this.#n.length; o++)
        (this.#n[o]?.maxBlockDifference ?? 1 / 0) < (this.#n[n]?.maxBlockDifference ?? 1 / 0) ? (u = n, n = o) : (u === null || (this.#n[o]?.maxBlockDifference ?? 1 / 0) < (this.#n[u]?.maxBlockDifference ?? 1 / 0)) && (u = o);
      this.#G = this.#n[n]?.maxBlockDifference ?? 1 / 0, this.#W = u === null ? 1 / 0 : this.#n[u]?.maxBlockDifference ?? 1 / 0, l = (this.#n[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#v = l, this.#n = [], this.#A = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: s,
      dropIndex: r,
      nextDropIndex: l,
      lowestCycleDifference: this.#G,
      runnerUpCycleDifference: this.#W
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, A, s) {
    if (A === "c") return t.slice();
    const r = t.slice(), l = A === "p" ? e : i, n = r.length / this.#i, u = s ? 1 : 0;
    for (let o = u; o < this.#i; o += 2)
      r.set(
        l.subarray(o * n, (o + 1) * n),
        o * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#A = 0, this.#v = null, this.#n = [], this.#D = null, this.#G = 1 / 0, this.#W = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #k(e, t, i, A) {
    const s = this.#u, r = this.#i, l = 2 - i, n = 2 - i, u = A[e], o = A[t], f = b.#ce(
      u,
      o,
      s,
      r,
      i
    );
    let c = 0, h = 0, p = 0, d = 0, E = 0, w = 0;
    for (let C = 2; C < r - 2; C += 2) {
      const y = (C - 2) / 2, z = l - 1 + y * 2, Y = l + 1 + y * 2, Z = l + 3 + y * 2, H = l + y * 2, G = H + 2, L = n + y * 2, R = L + 2, $ = l + y * 2;
      for (let x = 8; x < s - 8; x++) {
        const S = (f[$ * s + x] ?? 0) | (f[($ + 2) * s + x] ?? 0);
        if (S === 0) continue;
        const ee = (A.c[z * s + x] ?? 0) + ((A.c[Y * s + x] ?? 0) << 2) + (A.c[Z * s + x] ?? 0), B = Math.abs(
          3 * ((u[H * s + x] ?? 0) + (u[G * s + x] ?? 0)) - ee
        ), P = Math.abs(
          3 * ((o[L * s + x] ?? 0) + (o[R * s + x] ?? 0)) - ee
        );
        B > 23 && (S & 1) !== 0 && (c += B), P > 23 && (S & 1) !== 0 && (d += P), B > 42 && (S & 2) !== 0 && (h += B), P > 42 && (S & 2) !== 0 && (E += P), B > 42 && (S & 4) !== 0 && (p += B), P > 42 && (S & 4) !== 0 && (w += P);
      }
    }
    h < 500 && E < 500 && (p >= 500 || w >= 500) && Math.max(p, w) > 3 * Math.min(p, w) && (h = p, E = w);
    const v = Math.floor(c / 6 + 0.5), F = Math.floor(d / 6 + 0.5), g = Math.floor(h / 6 + 0.5), m = Math.floor(E / 6 + 0.5), _ = Math.max(v, F) / Math.max(Math.min(v, F), 1), U = Math.max(g, m) / Math.max(Math.min(g, m), 1), N = Math.max(g, m) / Math.max(Math.max(v, F), 1);
    return (g >= 500 || m >= 500) && (g * 2 < m || m * 2 < g) || (g >= 1e3 || m >= 1e3) && (g * 3 < m * 2 || m * 3 < g * 2) || (g >= 2e3 || m >= 2e3) && (g * 5 < m * 4 || m * 5 < g * 4) || (g >= 4e3 || m >= 4e3) && U > _ || N > 5e-3 && Math.max(g, m) > 150 && (g * 2 < m || m * 2 < g) ? g > m ? t : e : v > F ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #ce(e, t, i, A, s) {
    const r = Array.from(
      { length: Math.ceil(A / 2) },
      () => new Uint8Array(i)
    ), l = s === 1 ? 1 : 0;
    for (let o = 0; o < r.length; o++) {
      const f = Math.min(A - 1, l + o * 2), c = r[o];
      if (c)
        for (let h = 0; h < i; h++)
          c[h] = Math.abs(
            (e[f * i + h] ?? 0) - (t[f * i + h] ?? 0)
          );
    }
    const n = new Uint8Array(i * A), u = s === 1 ? 3 : 2;
    for (let o = 1; o < r.length - 1; o++) {
      const f = u + (o - 1) * 2;
      if (f >= A) break;
      const c = r[o];
      if (c)
        for (let h = 1; h < i - 1; h++) {
          const p = c[h] ?? 0;
          if (p <= 3) continue;
          let d = 0;
          for (let m = h - 1; m <= h + 1; m++)
            d += (r[o - 1]?.[m] ?? 0) > 3 ? 1 : 0, d += (r[o]?.[m] ?? 0) > 3 ? 1 : 0, d += (r[o + 1]?.[m] ?? 0) > 3 ? 1 : 0;
          if (d <= 1) continue;
          const E = f * i + h;
          if (n[E] = 1, p <= 19) continue;
          d = 0;
          let w = !1, v = !1;
          for (let m = h - 1; m <= h + 1; m++)
            (r[o - 1]?.[m] ?? 0) > 19 && (d++, w = !0), (r[o]?.[m] ?? 0) > 19 && d++, (r[o + 1]?.[m] ?? 0) > 19 && (d++, v = !0);
          if (d <= 3) continue;
          if (w && v) {
            n[E] |= 2;
            continue;
          }
          let F = !1, g = !1;
          for (let m = Math.max(h - 4, 0); m < Math.min(h + 5, i); m++)
            o !== 1 && (r[o - 2]?.[m] ?? 0) > 19 && (F = !0), (r[o - 1]?.[m] ?? 0) > 19 && (w = !0), (r[o + 1]?.[m] ?? 0) > 19 && (v = !0), o !== r.length - 2 && (r[o + 2]?.[m] ?? 0) > 19 && (g = !0);
          w && (v || F) || v && (w || g) ? n[E] |= 2 : d > 5 && (n[E] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #L(e, t, i) {
    const A = new Uint8Array(t * i);
    for (let r = 0; r < i; r++) {
      const l = r * t, n = Math.max(0, Math.min(i - 1, r === 0 ? 1 : r - 1)) * t, u = Math.max(
        0,
        Math.min(i - 1, r === i - 1 ? i - 2 : r + 1)
      ) * t, o = Math.max(0, Math.min(i - 1, r < 2 ? r === 0 ? 2 : 3 : r - 2)) * t, f = Math.max(
        0,
        Math.min(
          i - 1,
          r + 2 >= i ? r === i - 1 ? i - 3 : i - 4 : r + 2
        )
      ) * t;
      for (let c = 0; c < t; c++) {
        const h = e[l + c] ?? 0, p = e[n + c] ?? 0, d = e[u + c] ?? 0, E = e[o + c] ?? 0, w = e[f + c] ?? 0;
        (r === 0 ? Math.abs(h - d) > b.COMB_THRESHOLD : r === i - 1 ? Math.abs(h - p) > b.COMB_THRESHOLD : Math.abs(h - p) > b.COMB_THRESHOLD && Math.abs(h - d) > b.COMB_THRESHOLD) && Math.abs(
          4 * h - 3 * (p + d) + E + w
        ) > b.COMB_THRESHOLD * 6 && (A[r * t + c] = 255);
      }
    }
    let s = 0;
    for (const r of [0, 8])
      for (const l of [0, 8])
        for (let n = r; n < i; n += 16)
          for (let u = l; u < t; u += 16) {
            let o = 0;
            for (let f = Math.max(1, n); f < Math.min(i - 1, n + 16); f++)
              for (let c = u; c < Math.min(t, u + 16); c++) {
                const h = f * t + c;
                A[h - t] === 255 && A[h] === 255 && A[h + t] === 255 && o++;
              }
            s = Math.max(s, o);
          }
    return s;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #ue(e, t, i, A) {
    const s = b.DECIMATE_BLOCK / 2, r = Math.ceil(i / s), l = Math.ceil(A / s), n = new Float64Array(r * l), u = e.length / (i * A);
    for (let c = 0; c < A; c++) {
      const h = Math.floor(c / s);
      for (let p = 0; p < i; p++) {
        const d = Math.floor(p / s), E = h * r + d, w = (c * i + p) * u;
        if (u === 1) {
          n[E] = (n[E] ?? 0) + Math.abs((e[w] ?? 0) - (t[w] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[w] ?? 0) * 0.2126 + (e[w + 1] ?? 0) * 0.7152 + (e[w + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (t[w] ?? 0) * 0.2126 + (t[w + 1] ?? 0) * 0.7152 + (t[w + 2] ?? 0) * 0.0722
        );
        if (n[E] = (n[E] ?? 0) + Math.abs(v - F), (p & 1) !== 0 || (c & 1) !== 0) continue;
        let g = 0, m = 0, _ = 0, U = 0, N = 0, C = 0, y = 0;
        for (let G = c; G < Math.min(c + 2, A); G++)
          for (let L = p; L < Math.min(p + 2, i); L++) {
            const R = (G * i + L) * u;
            g += e[R] ?? 0, m += e[R + 1] ?? 0, _ += e[R + 2] ?? 0, U += t[R] ?? 0, N += t[R + 1] ?? 0, C += t[R + 2] ?? 0, y++;
          }
        const z = Math.round(
          (-0.114572 * g - 0.385428 * m + 0.5 * _) / y
        ), Y = Math.round(
          (-0.114572 * U - 0.385428 * N + 0.5 * C) / y
        ), Z = Math.round(
          (0.5 * g - 0.454153 * m - 0.045847 * _) / y
        ), H = Math.round(
          (0.5 * U - 0.454153 * N - 0.045847 * C) / y
        );
        n[E] = (n[E] ?? 0) + Math.abs(z - Y) + Math.abs(Z - H);
      }
    }
    let o = -1;
    for (let c = 0; c < l - 1; c++)
      for (let h = 0; h < r - 1; h++)
        o = Math.max(
          o,
          (n[c * r + h] ?? 0) + (n[c * r + h + 1] ?? 0) + (n[(c + 1) * r + h] ?? 0) + (n[(c + 1) * r + h + 1] ?? 0)
        );
    let f = 0;
    for (const c of n) f += c;
    return { maxBlockDifference: o, totalDifference: f };
  }
}
let oe = null;
function de(a) {
  oe = a;
}
const me = 0.5, D = 3, q = 5, k = q + 1, te = 1e3, j = 4, V = 200, pe = 0.25, we = 1e3 / 60, Ee = 0.02, ge = 250, ve = 1e3 / 30;
function ie(a) {
  if (!Number.isFinite(a) || a < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return a;
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
function ke() {
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
  #k = null;
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
  #K = k - 1;
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
  #X = null;
  #Te;
  #x;
  #d;
  #O;
  #Me;
  #F = "video";
  #$ = "c";
  #Fe = 0;
  #Re = !0;
  #Ce = new b(T, M);
  #Se = 1 / 0;
  #ke = 1 / 0;
  #_ = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #l = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #m = 0;
  #b = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #p = D - 1;
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
  #h = null;
  #Z = [];
  #T = !1;
  #Pe;
  #a;
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
  #Ee = !1;
  #Q = null;
  #Et = 0;
  #se = /* @__PURE__ */ new Map();
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
  #Ne = 0;
  #ge = 0;
  #N = 0;
  #re = 0;
  #ne = 0;
  #oe = 0;
  #j = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#x = t.doubleRate ?? !1, this.#d = t.autoFilm ?? !1, this.#O = ie(
      t.filmCombThreshold ?? b.COMBED_PIXEL_LIMIT
    ), this.#Me = t.spatialCheck ?? !0, this.#Pe = t.onStats, this.#a = i, this.#R = i ? "main" : t.rendering ?? "auto", this.#Ie = t.workerUrl ?? oe, this.#s = this.#R === "main" ? "main" : "idle", this.#i = i ? i.canvas : document.createElement("canvas"), this.#u = i?.canvas ?? (this.#R === "main" ? this.#i : document.createElement("canvas")), this.#we = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const A = this.#u.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!A) throw new Error("this browser has no WebGL2");
    this.#A = A, this.#v = W(A, le);
    const s = this.#v;
    this.#n = Object.fromEntries(
      Object.entries(ae).map(([r, l]) => [
        r,
        A.getUniformLocation(s, l)
      ])
    ), this.#D = W(A, De), this.#G = A.getUniformLocation(this.#D, "uField"), this.#W = A.getUniformLocation(this.#D, "uFlip"), this.#d && this.#it(), this.#u.addEventListener(
      "webglcontextlost",
      this.#pt
    ), this.#Te = i ? null : new ResizeObserver(() => this.#xe()), e.addEventListener("emptied", this.#ft), e.addEventListener("resize", this.#ut), e.addEventListener("pause", this.#S), e.addEventListener("ended", this.#S), e.addEventListener("seeking", this.#mt), e.addEventListener("seeked", this.#S), e.addEventListener("ratechange", this.#S);
  }
  get running() {
    return this.#c && (this.#h?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#i;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #ve() {
    return this.#h?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #qe() {
    return {
      doubleRate: this.#x,
      autoFilm: this.#d,
      filmCombThreshold: this.#O,
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
    const t = this.#h?.interlaced !== e?.interlaced, i = t || this.#h?.topFieldFirst !== e?.topFieldFirst;
    this.#h = e, this.#r?.postMessage({ type: "scan", scan: e }), i && (this.#o = 0, this.#g(), t && (this.#l = 0), this.#f = null, this.#M(!1)), this.#We(), i && ((e?.interlaced ?? !0) && (this.#a || this.#s === "main") ? this.#V() : this.#ze());
  }
  get scan() {
    return this.#h;
  }
  set videoTimeline(e) {
    this.#Z = e, this.#r?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#h = null), this.#We();
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
    return this.#X ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#x;
  }
  set doubleRate(e) {
    e !== this.#x && (this.#x = e, this.#Ge(), this.#t.length = 0, e ? (this.#m > 0 && this.#je(), (this.#h?.interlaced ?? !0) && (this.#a || this.#s === "main") && this.#V()) : this.#d || (this.#f = null, this.#M(!1), this.#J()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#d;
  }
  set autoFilm(e) {
    e !== this.#d && (this.#d = e, this.#Ge(), this.#g(), e ? (this.#it(), this.#m > 0 && (this.#ct(), this.#je()), (this.#h?.interlaced ?? !0) && (this.#a || this.#s === "main") && this.#V()) : (this.#Qe(), this.#x || (this.#f = null, this.#M(!1), this.#J())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#O;
  }
  set filmCombThreshold(e) {
    const t = ie(e);
    t !== this.#O && (this.#O = t, this.#Ge(), this.#d && this.#g());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Ge() {
    this.#r?.postMessage({
      type: "settings",
      options: this.#qe()
    });
  }
  #We() {
    this.#pe && (this.#Z.length > 0 || (this.#h?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #gt() {
    return this.#a || this.#R === "main" ? !1 : this.#s === "starting" || this.#s === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Ie !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Ke(), !0) : this.#R === "auto" ? (this.#be(), !1) : (this.#s = "failed", this.#c = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #Ke() {
    this.#C(), this.#r?.terminate(), this.#r = null, this.#Ae = !1, this.#Ee = !1;
    let e = this.#i;
    if (this.#Ue) {
      e = document.createElement("canvas"), e.className = this.#i.className;
      const s = this.#i.getAttribute("style");
      s === null ? e.removeAttribute("style") : e.setAttribute("style", s), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e;
    }
    const t = ++this.#_e;
    this.#s = "starting";
    let i, A;
    try {
      A = e.transferControlToOffscreen(), this.#Ue = !0, i = new Worker(this.#Ie, { type: "module" });
    } catch (s) {
      this.#he(
        s instanceof Error ? s.message : String(s)
      );
      return;
    }
    this.#r = i, i.onmessage = (s) => {
      t === this.#_e && this.#vt(s.data);
    }, i.onerror = (s) => {
      t === this.#_e && (s.preventDefault(), this.#he(s.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: A,
        options: this.#qe(),
        scan: this.#h,
        videoTimeline: this.#Z,
        enabled: this.#c,
        video: this.#He()
      },
      [A]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #vt(e) {
    switch (e.type) {
      case "ready":
        this.#s = "active", this.#c && (this.#ae(), this.#Ye());
        break;
      case "failed":
        this.#he(e.message);
        break;
      case "consumed": {
        this.#Ae = !1, this.#Ee = !0;
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
  #he(e) {
    if (this.#s === "starting" && this.#R === "auto" && !this.#ie) {
      this.#be();
      return;
    }
    if (this.#$e(e), !this.#ie) {
      this.#ie = !0, this.#Ke();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#s = "failed", this.#r?.terminate(), this.#r = null, this.#C(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #be() {
    const e = this.#u;
    e.className = this.#i.className;
    const t = this.#i.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e, this.#Ue = !1, this.#r?.terminate(), this.#r = null, this.#s = "main", this.#C(), this.#c && (this.#ae(), this.#Ye(), (this.#h?.interlaced ?? !0) && this.#V());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #C() {
    this.#Q?.frame.close(), this.#Q = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #$e(e) {
    for (const t of this.#se.values())
      t.reject(new Error(e));
    this.#se.clear();
  }
  start() {
    if (!(this.#c || this.#Be || this.#T)) {
      if (this.#c = !0, this.#dt(), this.#g(), this.#me = performance.now(), this.#Le = this.#me, this.#de = Number.NaN, this.#Y = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#Pt(), this.#Ye(), this.#gt()) {
        this.#r?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#s === "active" && this.#ae();
        return;
      }
      this.#ae(), (this.#h?.interlaced ?? !0) && this.#V();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#c && (this.#c = !1, this.#z !== null && this.#e.cancelVideoFrameCallback(this.#z), this.#z = null, this.#Rt(), this.#ze(), this.#o = 0, this.#f = null, this.#M(!1), this.#C(), this.#r?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#Be) {
      this.#Be = !0, this.#pe = !1, this.stop(), this.#r?.postMessage({ type: "destroy" }), this.#r?.terminate(), this.#r = null, this.#C(), this.#$e("the deinterlacer was destroyed"), this.#u.removeEventListener(
        "webglcontextlost",
        this.#pt
      ), this.#e.removeEventListener("emptied", this.#ft), this.#e.removeEventListener("resize", this.#ut), this.#e.removeEventListener("pause", this.#S), this.#e.removeEventListener("ended", this.#S), this.#e.removeEventListener("seeking", this.#mt), this.#e.removeEventListener("seeked", this.#S), this.#e.removeEventListener("ratechange", this.#S), this.#It();
      for (const e of this.#y) this.#A.deleteTexture(e);
      this.#y = [], this.#J(), this.#Qe(), this.#A.deleteProgram(this.#v), this.#A.deleteProgram(this.#D), this.#k && this.#A.deleteProgram(this.#k), this.#L && this.#A.deleteProgram(this.#L), this.#q && this.#A.deleteProgram(this.#q), this.#A.getExtension("WEBGL_lose_context")?.loseContext();
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
      const A = ++this.#Et, s = new Promise((r, l) => {
        this.#se.set(A, { resolve: r, reject: l });
      });
      return this.#r.postMessage({
        type: "capture",
        id: A,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), s;
    }
    if (this.#s === "starting" || this.#s === "failed")
      return createImageBitmap(this.#e);
    const e = this.#f;
    if (this.#a && (!this.#c || this.#T || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#c || this.#T || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#Ze(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#le(e.flush, e.second, null, !1) : this.#Xe(null, !1);
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
  #ae() {
    this.#a || !this.#c || this.#z !== null || (this.#z = this.#e.requestVideoFrameCallback(this.#Dt));
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
    } catch (s) {
      const r = s instanceof Error ? s.message : String(s);
      this.#R === "auto" && !this.#Ee && !this.#ie ? (this.#be(), this.#De(e, t)) : this.#he(r);
      return;
    }
    const A = {
      id: ++this.#wt,
      frame: i,
      now: e,
      metadata: t,
      video: this.#He()
    };
    if (this.#Ae) {
      this.#Q?.frame.close(), this.#Q = A;
      return;
    }
    this.#et(A);
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
    } catch (A) {
      this.#Ae = !1, e.frame.close();
      const s = A instanceof Error ? A.message : String(A);
      this.#R === "auto" && !this.#Ee && !this.#ie ? (this.#be(), this.#De(e.now, e.metadata)) : this.#he(s);
    }
  }
  #Dt = (e, t) => {
    this.#z = null, !(!this.#c || this.#T) && (this.#me = e, this.#Y = Math.max(
      this.#Y,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#tt(e, t), this.#ae());
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
        const h = this.#e.buffered, p = this.#l >= j ? this.#l / 1e3 : V / 1e3;
        for (let d = 0; d < h.length; d++)
          if (t.mediaTime >= h.start(d) && t.mediaTime < h.end(d) && Math.abs(t.mediaTime - this.#e.currentTime) <= p) {
            i = !0;
            break;
          }
      }
      if (i && (this.#te = !0), (this.#m === 0 || this.#b === 0) && this.#lt(t.width, t.height), this.#h && !this.#h.interlaced) {
        this.#kt();
        return;
      }
      const A = t.mediaTime - this.#ee, s = i || A < 0 || A > me;
      s && (this.#o = 0, this.#l = 0, this.#E.discontinuities++, this.#t.length = 0, this.#g());
      const r = this.#d && this.#U !== 0 && t.presentedFrames - this.#U > 1;
      if (this.#Lt(t.presentedFrames, s), !s && r && (this.#o = 0, this.#g()), this.#o > 0 && t.mediaTime === this.#ee)
        return;
      !s && A > 0 && this.#xt(A), this.#ee = t.mediaTime;
      const l = performance.now();
      l - this.#Ne > te && (this.#ge = l, this.#N = 0, this.#re = 0, this.#ne = 0, this.#oe = 0, this.#j = 0, this.#_ = 0), this.#Ne = l;
      const n = performance.now();
      this.#at();
      const u = this.#F, o = this.#d && this.#o === D && this.#Tt();
      if (u !== this.#F && (this.#t.length = 0), !(o && this.#ye())) if (this.#d && !this.#Re && this.#F === "film")
        if (this.#ye()) {
          const h = this.#l * 5 / 4, p = this.#st(1, e, h), d = this.#t.at(-1), E = p ? e : d == null ? e + h : d.at + d.duration;
          this.#Mt(E, h);
        } else
          this.#Xe(null);
      else if (this.#x && this.#ye()) {
        const h = this.#l / 2, p = this.#st(2, e, h), d = this.#t.at(-1), E = p ? e : d == null ? e + h * 2 : d.at + d.duration;
        this.#At(!1, E, h), this.#At(!0, E + h, h);
      } else
        this.#E.late += this.#t.length, this.#t.length = 0, this.#le(!1, !1, null);
      this.#j = Math.max(
        this.#j,
        this.#t.length
      ), this.#re += performance.now() - n, this.#N++, this.#Bt(l);
    }
  }
  #yt(e) {
    let t;
    for (let s = this.#Z.length - 1; s >= 0; s--) {
      const r = this.#Z[s];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#m || t.codedSize.height !== this.#b) && this.#lt(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#h?.interlaced === i.interlaced && this.#h.topFieldFirst === i.topFieldFirst)
      return;
    const A = this.#h?.interlaced;
    this.#h = i, this.#o = 0, this.#t.length = 0, this.#g(), A !== i.interlaced && (this.#l = 0), i.interlaced && (this.#a || this.#s === "main") ? this.#V() : this.#ze();
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
    return (this.#x || this.#d) && this.#l > 0 && this.#w.length === k;
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
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#l > 0 ? Math.max(1, Math.round(t / this.#l)) : 1, A = t / i;
    A < j || A > V || (this.#l = this.#l > 0 ? this.#l + (A - this.#l) * pe : A);
  }
  /** Build the optional film passes only for callers that enable them. */
  #it() {
    if (this.#k && this.#L && this.#q) return;
    const e = this.#A, t = W(e, ce), i = W(e, ue), A = W(e, fe);
    this.#k = t, this.#ce = Object.fromEntries(
      Object.entries(Q).filter(([s]) => s !== "match" && s !== "topFieldFirst").map(([s, r]) => [s, e.getUniformLocation(t, r)])
    ), this.#L = i, this.#ue = Object.fromEntries(
      Object.entries(Q).map(([s, r]) => [
        s,
        e.getUniformLocation(i, r)
      ])
    ), this.#q = A, this.#Je = Object.fromEntries(
      Object.entries(Q).map(([s, r]) => [
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
  #Tt() {
    const e = this.#B, t = this.#k, i = this.#ce, A = this.#q, s = this.#Je;
    if (!e || !t || !i || !A || !s)
      return !1;
    const r = this.#A, l = this.#p, n = (this.#p + D - 1) % D, u = (this.#p + 1) % D, o = this.#ve;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [w, v] of [u, n, l].entries())
      r.activeTexture(r.TEXTURE0 + w), r.bindTexture(r.TEXTURE_2D, this.#y[v] ?? null);
    r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#m, this.#b), r.viewport(0, 0, T, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      T,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: f, currentLuma: c, nextLuma: h } = e;
    for (let w = 0; w < f.length; w++) {
      const v = w * 4;
      f[w] = e.pixels[v] ?? 0, c[w] = e.pixels[v + 1] ?? 0, h[w] = e.pixels[v + 2] ?? 0;
    }
    const p = this.#Ce.fieldMatch(
      f,
      c,
      h,
      o,
      this.#O
    );
    r.useProgram(A), r.uniform1i(s.prev, 0), r.uniform1i(s.cur, 1), r.uniform1i(s.next, 2), r.uniform2i(s.size, this.#m, this.#b), r.uniform1i(s.topFieldFirst, o ? 1 : 0), r.uniform1i(
      s.match,
      p.match === "p" ? 0 : p.match === "c" ? 1 : 2
    ), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      T,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const d = this.#Ce.decimate(e.pixels);
    this.#$ = p.match, this.#Fe = p.combScore, this.#Re = p.isCombed, this.#Se = d.lowestCycleDifference, this.#ke = d.runnerUpCycleDifference;
    const E = d.dropIndex !== null && !p.isCombed;
    return (E ? "film" : "video") !== this.#F && (this.#F = E ? "film" : "video"), d.shouldDrop && !p.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Mt(e, t) {
    const i = this.#Oe();
    if (i === null) return;
    const A = this.#w[i];
    if (A) {
      for (this.#K = i; this.#t.length > 0 && this.#t[0]?.slot === i; )
        this.#t.shift(), this.#E.late++;
      this.#Xe(A.framebuffer), this.#t.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Xe(e, t = !0) {
    const i = this.#L, A = this.#ue;
    if (!i || !A) return;
    const s = this.#A, r = this.#p, l = (this.#p + D - 1) % D, n = (this.#p + 1) % D, u = this.#ve;
    s.bindFramebuffer(s.FRAMEBUFFER, e), s.useProgram(i);
    for (const [o, f] of [n, l, r].entries())
      s.activeTexture(s.TEXTURE0 + o), s.bindTexture(s.TEXTURE_2D, this.#y[f] ?? null);
    s.uniform1i(A.prev, 0), s.uniform1i(A.cur, 1), s.uniform1i(A.next, 2), s.uniform2i(A.size, this.#m, this.#b), s.uniform1i(A.topFieldFirst, u ? 1 : 0), s.uniform1i(
      A.match,
      this.#$ === "p" ? 0 : this.#$ === "c" ? 1 : 2
    ), s.viewport(0, 0, this.#m, this.#b), s.drawArrays(s.TRIANGLES, 0, 3), e === null && (this.#f = { kind: "film" }, this.#M(!0), t && this.#_++);
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
    const A = this.#Oe();
    if (A === null) return;
    const s = this.#w[A];
    if (s) {
      for (this.#K = A; this.#t.length > 0 && this.#t[0]?.slot === A; )
        this.#t.shift(), this.#E.late++;
      this.#le(!1, e, s.framebuffer), this.#t.push({ slot: A, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #st(e, t, i) {
    const A = this.#t.at(-1), s = (q + 1) * Math.max(this.#H, i);
    if (A && A.at - t > s)
      return this.#t.length = 0, this.#E.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#t.length + e - q
    );
    let l = 0, n = 0;
    for (; n < r; ) {
      const u = this.#t.shift();
      if (!u) break;
      l += u.duration, n++;
    }
    for (const u of this.#t) u.at -= l;
    return this.#E.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #Oe() {
    const e = this.#f?.kind === "texture" ? this.#f.texture : null, t = new Set(this.#t.map(({ slot: A }) => A));
    for (let A = 1; A <= k; A++) {
      const s = (this.#K + A) % k, r = this.#w[s];
      if (r && r.texture !== e && !t.has(s))
        return s;
    }
    const i = this.#t[0];
    if (i) {
      const A = this.#w[i.slot];
      if (A && A.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #V() {
    this.#P === null && (!this.#c || this.#T || (this.#fe = 0, this.#P = this.#nt(this.#rt)));
  }
  #ze() {
    this.#P !== null && this.#Ft(this.#P), this.#P = null, this.#t.length = 0;
  }
  #rt = (e) => {
    if (this.#P = null, !(!this.#c || this.#T)) {
      if (this.#fe > 0) {
        const t = e - this.#fe;
        t >= 1 && t <= V && (this.#H = t < this.#H ? t : this.#H + (t - this.#H) * Ee);
      }
      this.#fe = e, this.#s === "main" && this.#St(e), this.#P = this.#nt(this.#rt);
    }
  };
  /** ページと Worker のそれぞれが所有する requestAnimationFrame() へ表示ループを委ねる。 */
  #nt(e) {
    return this.#a ? this.#a.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #Ft(e) {
    this.#a ? this.#a.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ページ側の監視を開始し、描画ループの停止中も復号フレームの到着を検査する。 */
  #Ye() {
    this.#a || this.#I !== null || !this.#c || this.#T || (this.#I = requestAnimationFrame(this.#ot));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Rt() {
    this.#I !== null && cancelAnimationFrame(this.#I), this.#I = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #ot = (e) => {
    this.#I = null, !(!this.#c || this.#T) && (this.#Ct(e), this.#I = requestAnimationFrame(this.#ot));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #Ct(e) {
    if (this.#a || e - this.#me < ge || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, A = this.#l >= j ? this.#l : ve, s = i > this.#Y, r = t !== this.#de && e - this.#Le >= A * 0.75;
    !s && !r || (this.#Y = Math.max(
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
  #St(e) {
    const t = e + this.#H * 1.5;
    for (; this.#t[1] && this.#t[1].at <= t; )
      this.#E.late++, this.#t.shift();
    let i = this.#t[0];
    if (!i || i.at > t)
      return;
    this.#t.shift();
    const A = performance.now();
    this.#ht(i.slot), this.#oe += performance.now() - A, this.#ne++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #ht(e) {
    const t = this.#w[e];
    t && this.#Ze(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #kt() {
    this.#at();
    const e = this.#y[this.#p];
    e && this.#Ze(e, !0), this.#o = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #M(e) {
    if (this.#a) {
      this.#a.onVisibility(e);
      return;
    }
    this.#i.style.visibility = e ? "visible" : "hidden";
  }
  #Ze(e, t = !1, i = !0) {
    const A = this.#A;
    A.bindFramebuffer(A.FRAMEBUFFER, null), A.useProgram(this.#D), A.activeTexture(A.TEXTURE0), A.bindTexture(A.TEXTURE_2D, e), A.uniform1i(this.#G, 0), A.uniform1i(this.#W, t ? 1 : 0), A.viewport(0, 0, this.#m, this.#b), A.drawArrays(A.TRIANGLES, 0, 3), this.#f = { kind: "texture", texture: e, flip: t }, this.#M(!0), i && this.#_++;
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
    this.#U !== 0 && !t && (this.#E.missed += Math.max(0, e - this.#U - 1)), this.#U = e;
  }
  #Bt(e) {
    const t = e - this.#ge;
    if (t < te) return;
    const i = this.#ye() && (this.#x || this.#F === "film") ? this.#ne : this.#N, A = {
      ...this.#E,
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
      duplicateScore: this.#Se,
      duplicateRunnerUp: this.#ke
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: A })), this.#Pe?.(A), this.#ge = e, this.#N = 0, this.#re = 0, this.#ne = 0, this.#oe = 0, this.#j = 0, this.#_ = 0;
  }
  /** Take the newest frame into the ring. */
  #at() {
    const e = this.#A;
    this.#p = (this.#p + 1) % D, e.bindTexture(e.TEXTURE_2D, this.#y[this.#p] ?? null), e.texImage2D(
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
  #le(e, t, i, A = !0) {
    if (this.#o === 0 || this.#T) return;
    A && (this.#o === D && !e ? this.#E.filtered++ : this.#E.degraded++);
    const s = this.#A, r = this.#p, l = (this.#p + D - 1) % D, n = (this.#p + 1) % D;
    let u, o, f;
    this.#o === 1 ? u = o = f = r : e ? (u = l, o = f = r) : this.#o === 2 ? (u = o = l, f = r) : (u = n, o = l, f = r), s.bindFramebuffer(s.FRAMEBUFFER, i), s.useProgram(this.#v);
    for (const [h, p] of [u, o, f].entries())
      s.activeTexture(s.TEXTURE0 + h), s.bindTexture(s.TEXTURE_2D, this.#y[p] ?? null);
    s.uniform1i(this.#n.prev, 0), s.uniform1i(this.#n.cur, 1), s.uniform1i(this.#n.next, 2), s.uniform2i(this.#n.size, this.#m, this.#b);
    const c = this.#ve ? 0 : 1;
    s.uniform1i(this.#n.parity, t ? 1 - c : c), s.uniform1i(this.#n.tff, this.#ve ? 1 : 0), s.uniform1i(this.#n.spatialCheck, this.#Me ? 1 : 0), s.viewport(0, 0, this.#m, this.#b), s.drawArrays(s.TRIANGLES, 0, 3), i === null && (this.#f = { kind: "yadif", flush: e, second: t }, this.#M(!0), A && this.#_++);
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
    if (!this.#X) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const A = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), s = t * A, r = i * A;
    this.#i.style.left = `${e.offsetLeft + (e.offsetWidth - s) / 2}px`, this.#i.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#i.style.width = `${s}px`, this.#i.style.height = `${r}px`;
  }
  #lt(e, t) {
    const i = this.#A;
    this.#u.width = e, this.#u.height = t, this.#m = e, this.#b = t, this.#o = 0, this.#f = null, this.#g(), this.#xe();
    for (const A of this.#y) i.deleteTexture(A);
    this.#y = [];
    for (let A = 0; A < D; A++) {
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
      ), this.#y.push(s);
    }
    this.#J(), this.#Qe(), this.#d && this.#ct(), (this.#x || this.#d) && this.#je();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #ct() {
    if (this.#B) return;
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
    const A = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
    if (e.bindFramebuffer(e.FRAMEBUFFER, null), !A) {
      e.deleteFramebuffer(i), e.deleteTexture(t);
      return;
    }
    this.#B = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(T * M * 4),
      previousLuma: new Uint8Array(T * M),
      currentLuma: new Uint8Array(T * M),
      nextLuma: new Uint8Array(T * M)
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
    if (!(this.#w.length === k || this.#m === 0)) {
      this.#J();
      for (let t = 0; t < k; t++) {
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
          e.deleteFramebuffer(A), e.deleteTexture(i), this.#J();
          return;
        }
        this.#w.push({ texture: i, framebuffer: A });
      }
      this.#K = k - 1;
    }
  }
  #J() {
    const e = this.#A, t = this.#f?.kind === "texture" ? this.#f.texture : null;
    this.#w.some((i) => i.texture === t) && (this.#f = null);
    for (const { texture: i, framebuffer: A } of this.#w)
      e.deleteFramebuffer(A), e.deleteTexture(i);
    this.#w = [], this.#t.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #Pt() {
    if (this.#X) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#X = t, this.#Te?.observe(this.#e), this.#xe();
  }
  #It() {
    if (this.#a) return;
    const e = this.#X;
    this.#X = null, this.#Te?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #ut = () => this.#xe();
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
      this.#C(), this.#M(!1);
      return;
    }
    this.#o = 0, this.#ee = 0, this.#t.length = 0, this.#l = 0, this.#dt(), this.#g(), this.#f = null, this.#M(!1);
  };
  #dt() {
    this.#E = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#U = 0, this.#ge = 0, this.#Ne = 0, this.#N = 0, this.#re = 0, this.#ne = 0, this.#oe = 0, this.#j = 0, this.#_ = 0, this.#g();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #g() {
    this.#t.length = 0, this.#F = "video", this.#$ = "c", this.#Fe = 0, this.#Re = !0, this.#Ce.reset(), this.#Se = 1 / 0, this.#ke = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #mt = () => {
    if (this.#Ve("seeking")) {
      this.#C();
      return;
    }
    this.#te = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #S = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#Ve(e.type)) {
      this.#C();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#te;
      if (this.#te = !1, i) return;
      this.#o = 0, this.#g(), this.#f = null, this.#M(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#l = 0, this.#ee = this.#e.currentTime), this.#t.length = 0, this.#c && this.#o > 0) {
      const i = this.#Oe(), A = i === null ? void 0 : this.#w[i];
      i !== null && A ? (this.#K = i, this.#le(!0, !1, A.framebuffer), this.#ht(i)) : this.#le(!0, !1, null);
    }
    t && (this.#o = 0, this.#g());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #pt = (e) => {
    if (e.preventDefault(), this.#a) {
      this.#a.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#s !== "active" && (this.#T = !0, this.stop());
  };
}
function W(a, e) {
  const t = a.createProgram(), i = Ae(a, a.VERTEX_SHADER, be), A = Ae(a, a.FRAGMENT_SHADER, e);
  if (a.attachShader(t, i), a.attachShader(t, A), a.linkProgram(t), a.deleteShader(i), a.deleteShader(A), !a.getProgramParameter(t, a.LINK_STATUS)) {
    const s = a.getProgramInfoLog(t);
    throw a.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${s ?? "no reason given"}`
    );
  }
  return t;
}
function Ae(a, e, t) {
  const i = a.createShader(e);
  if (!i) throw new Error("the deinterlacer could not create a shader");
  if (a.shaderSource(i, t), a.compileShader(i), !a.getShaderParameter(i, a.COMPILE_STATUS)) {
    const A = a.getShaderInfoLog(i);
    throw a.deleteShader(i), new Error(
      `the deinterlacer failed to compile: ${A ?? "no reason given"}`
    );
  }
  return i;
}
const se = "data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAu9tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB8nRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAFoAAABDgAAAAAAY5tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAHUwAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAE5bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA+XN0YmwAAACtc3RzZAAAAAAAAAABAAAAnWF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAFoAQ4AEgAAABIAAAAAAAAAAEVTGF2YzYxLjE5LjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkACn/4QAZZ2QAKazZQFoET94CIAAAfSAAHUwD4sWywAEAB2j5KBLLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDAAAACYbW9vZgAAABBtZmhkAAAAAAAAAAEAAACAdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAPpAAAEJwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAAEh0cnVuAAAKBQAAAAYAAACgAgAAAAAABCcAAAfSAAAAQgAAE40AAAA/AAAH0gAAAgAAAAAAAAAARAAAA+kAAAG7AAAH0gAACK9tZGF0AAACrwYF//+r3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDEzMyBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xNSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9dGZmIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTIgYl9iaWFzPTAgZGlyZWN0PTMgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0wIGtleWludD0zMCBrZXlpbnRfbWluPTMgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD0zMCByYz1jcmYgbWJ0cmVlPTEgY3JmPTguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAUGAQEygAAAAWdliIICAj/+/76ivgU3edyfbbnP6kzu1BfFPXa9rMu/FCi/GMk76JT20AAAAwAAAwAAAwAAAwAAAwAAAwEJmrWZnq7KhXxVTgAAAwAAAwAAAwAABJ9gAAADAAAKtgAAAwAAAwCi4AAAAwAAHQgAAAMAAAiqAAADAAADA7EAAAMAAAMCCgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", ye = 0.5, xe = 3e3, re = 0.1, I = 16, ne = 'video/mp4; codecs="avc1.640029"';
let K = null;
function Te(a = {}) {
  return K ??= Me(a), K;
}
async function Be(a = {}) {
  return (await Te(a)).deinterlaces;
}
function Pe() {
  K = null;
}
async function Me(a) {
  const e = a.tolerance ?? ye, t = a.timeoutMs ?? xe, i = performance.now(), A = (l) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - i,
    error: l instanceof Error ? l.message : String(l)
  });
  if (typeof document > "u")
    return A(new Error("there is no document to decode in"));
  const s = document.createElement("video");
  s.muted = !0, s.defaultMuted = !0, s.playsInline = !0, s.preload = "auto";
  let r = null;
  try {
    r = Re(s, t);
    const l = O(X(s, "loadeddata"), t), n = s.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await l, await Ce(s, t, await n), s.videoWidth === 0 || s.videoHeight === 0)
      return A(new Error("the probe clip decoded to nothing"));
    const u = Se(s);
    return {
      deinterlaces: u < 1 - e,
      survives: u,
      tookMs: performance.now() - i
    };
  } catch (l) {
    return A(l);
  } finally {
    s.pause(), s.removeAttribute("src"), s.replaceChildren(), s.load(), r && URL.revokeObjectURL(r.url);
  }
}
const J = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, Fe = typeof MediaSource > "u";
function Re(a, e) {
  if (!J || !J.isTypeSupported(ne))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = se.indexOf(","), i = atob(se.slice(t + 1)), A = new Uint8Array(i.length);
  for (let n = 0; n < i.length; n++) A[n] = i.charCodeAt(n);
  const s = new J(), r = URL.createObjectURL(s);
  if (Fe) {
    a.disableRemotePlayback = !0;
    const n = document.createElement("source");
    n.type = "video/mp4", n.src = r, a.append(n), a.load();
  } else
    a.src = r;
  const l = (async () => {
    await O(X(s, "sourceopen"), e);
    const n = s.addSourceBuffer(ne), u = O(X(n, "updateend"), e);
    n.appendBuffer(A), await u, s.endOfStream();
  })();
  return { url: r, ready: l };
}
async function Ce(a, e, t) {
  if (t) {
    const i = performance.now();
    for (; a.currentTime < re && performance.now() - i < e; )
      await new Promise((A) => requestAnimationFrame(A));
    a.pause();
  } else
    a.currentTime = re, await O(X(a, "seeked"), e);
}
function Se(a) {
  const e = a.videoHeight, t = document.createElement("canvas");
  t.width = I, t.height = e;
  const i = t.getContext("2d", { willReadFrequently: !0 });
  if (!i) throw new Error("there is no 2d context to read the clip with");
  i.imageSmoothingEnabled = !1, i.drawImage(a, 0, 0, I, e);
  const A = i.getImageData(0, 0, I, e).data, s = (o) => {
    let f = 0;
    for (let c = 0; c < I; c++)
      f += A[(o * I + c) * 4 + 1] ?? 0;
    return f / I;
  };
  let r = 0;
  const l = 2, n = e - 3;
  let u = s(l);
  for (let o = l + 1; o <= n; o++) {
    const f = s(o);
    r += Math.abs(f - u), u = f;
  }
  return r / (n - l) / 255;
}
function X(a, e) {
  return new Promise((t, i) => {
    a.addEventListener(e, () => t(), { once: !0 }), a.addEventListener(
      "error",
      () => {
        const A = a instanceof HTMLMediaElement ? a.error : null, s = A ? ` (MediaError ${A.code}${A.message ? `: ${A.message}` : ""})` : "";
        i(new Error(`the probe clip ${e} failed${s}`));
      },
      { once: !0 }
    );
  });
}
function O(a, e) {
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
