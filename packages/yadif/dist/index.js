const he = "" + new URL("assets/worker-BWAomwEu.js", import.meta.url).href, ae = {
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
  #l;
  #i;
  #e;
  #A = 0;
  #v = null;
  #s = [];
  #b = null;
  #N = 1 / 0;
  #W = 1 / 0;
  constructor(e, t) {
    this.#l = e, this.#i = t, this.#e = 255 * D.DECIMATE_BLOCK ** 2 * D.DUPLICATE_PERCENT / 100;
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
        this.#l,
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
    const t = this.#A, i = this.#b ? D.#ae(
      this.#b,
      e,
      this.#l,
      this.#i
    ) : {
      maxBlockDifference: 1 / 0,
      totalDifference: 1 / 0
    };
    this.#s.push(i);
    const s = this.#v === t, A = s && i.maxBlockDifference < this.#e;
    s && !A && (this.#v = null);
    const r = this.#v;
    this.#b = e.slice(), this.#A++;
    let h = this.#v;
    if (this.#A === D.CYCLE) {
      let n = 0, l = null;
      for (let o = 1; o < this.#s.length; o++)
        (this.#s[o]?.maxBlockDifference ?? 1 / 0) < (this.#s[n]?.maxBlockDifference ?? 1 / 0) ? (l = n, n = o) : (l === null || (this.#s[o]?.maxBlockDifference ?? 1 / 0) < (this.#s[l]?.maxBlockDifference ?? 1 / 0)) && (l = o);
      this.#N = this.#s[n]?.maxBlockDifference ?? 1 / 0, this.#W = l === null ? 1 / 0 : this.#s[l]?.maxBlockDifference ?? 1 / 0, h = (this.#s[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#v = h, this.#s = [], this.#A = 0;
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
    this.#A = 0, this.#v = null, this.#s = [], this.#b = null, this.#N = 1 / 0, this.#W = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #S(e, t, i, s) {
    const A = this.#l, r = this.#i, h = 2 - i, n = 2 - i, l = s[e], o = s[t], f = D.#he(
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
  static #he(e, t, i, s, A) {
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
  static #ae(e, t, i, s) {
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
  #l;
  #i;
  #e;
  #A;
  #v;
  #s;
  /** The program that copies a filtered picture onto the canvas. */
  #b;
  #N;
  #W;
  /** The reduced pass that reads previous, current and next luma together. */
  #S = null;
  #he = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #k = null;
  #ae = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #q = null;
  #Ze = null;
  #L = null;
  #y = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #w = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #K = k - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #c = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #t = [];
  /** The rAF loop that puts them up, which is all that draws on the canvas. */
  #B = null;
  #le = 0;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #H = we;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #X = null;
  #ve;
  #x;
  #d;
  #O;
  #De;
  #M = "video";
  #$ = "c";
  #be = 0;
  #ye = !0;
  #xe = new D(T, M);
  #Te = 1 / 0;
  #Me = 1 / 0;
  #P = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #h = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #m = 0;
  #D = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #p = b - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #o = 0;
  #z = 0;
  /** A destination frame that arrived before the browser finished seeking. */
  #ee = !1;
  #Y = null;
  /** callback の停止を animation loop で検出するために保持する最終通知時刻。 */
  #ce = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #Z = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #Fe = 0;
  #u = !1;
  #ue = !1;
  #r = null;
  #Q = [];
  #F = !1;
  #Re;
  #f;
  #fe;
  #I;
  #Ce;
  #n = null;
  #a;
  #de = !1;
  #Se = 0;
  #ke = !1;
  #ut = 0;
  #te = !1;
  #Le = !1;
  #j = null;
  #ft = 0;
  #ie = /* @__PURE__ */ new Map();
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
  #_ = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #Be = 0;
  #me = 0;
  #U = 0;
  #Ae = 0;
  #se = 0;
  #re = 0;
  #V = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#x = t.doubleRate ?? !1, this.#d = t.autoFilm ?? !1, this.#O = ie(
      t.filmCombThreshold ?? D.COMBED_PIXEL_LIMIT
    ), this.#De = t.spatialCheck ?? !0, this.#Re = t.onStats, this.#f = i, this.#I = i ? "main" : t.rendering ?? "auto", this.#Ce = t.workerUrl ?? oe, this.#a = this.#I === "main" ? "main" : "idle", this.#i = i ? i.canvas : document.createElement("canvas"), this.#l = i?.canvas ?? (this.#I === "main" ? this.#i : document.createElement("canvas")), this.#fe = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const s = this.#l.getContext("webgl2", {
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
    this.#s = Object.fromEntries(
      Object.entries(ae).map(([r, h]) => [
        r,
        s.getUniformLocation(A, h)
      ])
    ), this.#b = W(s, be), this.#N = s.getUniformLocation(this.#b, "uField"), this.#W = s.getUniformLocation(this.#b, "uFlip"), this.#d && this.#Ke(), this.#l.addEventListener(
      "webglcontextlost",
      this.#ct
    ), this.#ve = i ? null : new ResizeObserver(() => this.#ge()), e.addEventListener("emptied", this.#ht), e.addEventListener("resize", this.#ot), e.addEventListener("pause", this.#C), e.addEventListener("ended", this.#C), e.addEventListener("seeking", this.#lt), e.addEventListener("seeked", this.#C), e.addEventListener("ratechange", this.#C);
  }
  get running() {
    return this.#u && (this.#r?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#i;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #pe() {
    return this.#r?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #Qe() {
    return {
      doubleRate: this.#x,
      autoFilm: this.#d,
      filmCombThreshold: this.#O,
      spatialCheck: this.#De
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#ue;
  }
  set enabled(e) {
    this.#ue = e, this.#Ie(), this.#n?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#r?.interlaced !== e?.interlaced, i = t || this.#r?.topFieldFirst !== e?.topFieldFirst;
    this.#r = e, this.#n?.postMessage({ type: "scan", scan: e }), i && (this.#o = 0, this.#g(), t && (this.#h = 0), this.#c = null, this.#T(!1)), this.#Ie(), i && (e?.interlaced ?? !0 ? this.#G() : this.#He());
  }
  get scan() {
    return this.#r;
  }
  set videoTimeline(e) {
    this.#Q = e, this.#n?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#r = null), this.#Ie();
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
    e !== this.#x && (this.#x = e, this.#Pe(), this.#t.length = 0, e ? (this.#m > 0 && this.#ze(), (this.#r?.interlaced ?? !0) && this.#G()) : this.#d || (this.#c = null, this.#T(!1), this.#J()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#d;
  }
  set autoFilm(e) {
    e !== this.#d && (this.#d = e, this.#Pe(), this.#g(), e ? (this.#Ke(), this.#m > 0 && (this.#nt(), this.#ze()), (this.#r?.interlaced ?? !0) && this.#G()) : (this.#Oe(), this.#x || (this.#c = null, this.#T(!1), this.#J())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#O;
  }
  set filmCombThreshold(e) {
    const t = ie(e);
    t !== this.#O && (this.#O = t, this.#Pe(), this.#d && this.#g());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Pe() {
    this.#n?.postMessage({
      type: "settings",
      options: this.#Qe()
    });
  }
  #Ie() {
    this.#ue && (this.#Q.length > 0 || (this.#r?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #dt() {
    return this.#f || this.#I === "main" ? !1 : this.#a === "starting" || this.#a === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Ce !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#je(), !0) : this.#I === "auto" ? (this.#_e(), !1) : (this.#a = "failed", this.#u = !1, !0);
  }
  /** 表示中の canvas を置き換えてから、新しい canvas の制御を Worker へ移す。 */
  #je() {
    this.#R(), this.#n?.terminate(), this.#n = null, this.#te = !1, this.#Le = !1;
    let e = this.#i;
    if (this.#ke) {
      e = document.createElement("canvas"), e.className = this.#i.className;
      const A = this.#i.getAttribute("style");
      A === null ? e.removeAttribute("style") : e.setAttribute("style", A), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e;
    }
    const t = ++this.#Se;
    this.#a = "starting";
    let i, s;
    try {
      s = e.transferControlToOffscreen(), this.#ke = !0, i = new Worker(this.#Ce, { type: "module" });
    } catch (A) {
      this.#ne(
        A instanceof Error ? A.message : String(A)
      );
      return;
    }
    this.#n = i, i.onmessage = (A) => {
      t === this.#Se && this.#mt(A.data);
    }, i.onerror = (A) => {
      t === this.#Se && (A.preventDefault(), this.#ne(A.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: s,
        options: this.#Qe(),
        scan: this.#r,
        videoTimeline: this.#Q,
        enabled: this.#ue,
        video: this.#Ue()
      },
      [s]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #mt(e) {
    switch (e.type) {
      case "ready":
        this.#a = "active", this.#u && (this.#we(), (this.#r?.interlaced ?? !0) && this.#G());
        break;
      case "failed":
        this.#ne(e.message);
        break;
      case "consumed": {
        this.#te = !1, this.#Le = !0;
        const t = this.#j;
        this.#j = null, t && this.#Je(t);
        break;
      }
      case "visibility":
        this.#i.style.visibility = e.visible ? "visible" : "hidden";
        break;
      case "size":
        this.#i.width = e.width, this.#i.height = e.height;
        break;
      case "stats": {
        const t = {
          ...e.stats,
          dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0
        };
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#Re?.(t);
        break;
      }
      case "capture": {
        const t = this.#ie.get(e.id);
        if (this.#ie.delete(e.id), !t) {
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
  #ne(e) {
    if (this.#a === "starting" && this.#I === "auto" && !this.#de) {
      this.#_e();
      return;
    }
    if (this.#Ve(e), !this.#de) {
      this.#de = !0, this.#je();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#a = "failed", this.#n?.terminate(), this.#n = null, this.#R(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #_e() {
    const e = this.#l;
    e.className = this.#i.className;
    const t = this.#i.getAttribute("style");
    t === null ? e.removeAttribute("style") : e.setAttribute("style", t), e.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(e), this.#i = e, this.#ke = !1, this.#n?.terminate(), this.#n = null, this.#a = "main", this.#R(), this.#u && (this.#we(), (this.#r?.interlaced ?? !0) && this.#G());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #R() {
    this.#j?.frame.close(), this.#j = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #Ve(e) {
    for (const t of this.#ie.values())
      t.reject(new Error(e));
    this.#ie.clear();
  }
  start() {
    this.#u || this.#F || (this.#u = !0, this.#at(), this.#g(), this.#ce = performance.now(), this.#Fe = this.#ce, this.#Z = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#Rt(), !this.#dt() && (this.#we(), (this.#r?.interlaced ?? !0) && this.#G()));
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#u && (this.#u = !1, this.#Y !== null && this.#e.cancelVideoFrameCallback(this.#Y), this.#Y = null, this.#He(), this.#o = 0, this.#c = null, this.#T(!1), this.#R(), this.#n?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    this.stop(), this.#n?.postMessage({ type: "destroy" }), this.#n?.terminate(), this.#n = null, this.#R(), this.#Ve("the deinterlacer was destroyed"), this.#l.removeEventListener(
      "webglcontextlost",
      this.#ct
    ), this.#e.removeEventListener("emptied", this.#ht), this.#e.removeEventListener("resize", this.#ot), this.#e.removeEventListener("pause", this.#C), this.#e.removeEventListener("ended", this.#C), this.#e.removeEventListener("seeking", this.#lt), this.#e.removeEventListener("seeked", this.#C), this.#e.removeEventListener("ratechange", this.#C), this.#Ct();
    for (const e of this.#y) this.#A.deleteTexture(e);
    this.#y = [], this.#J(), this.#Oe(), this.#A.deleteProgram(this.#v), this.#A.deleteProgram(this.#b), this.#S && this.#A.deleteProgram(this.#S), this.#k && this.#A.deleteProgram(this.#k), this.#q && this.#A.deleteProgram(this.#q), this.#A.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.#a === "active" && this.#i.style.visibility === "visible" && this.#n) {
      const s = ++this.#ft, A = new Promise((r, h) => {
        this.#ie.set(s, { resolve: r, reject: h });
      });
      return this.#n.postMessage({
        type: "capture",
        id: s,
        width: this.#e.videoWidth,
        height: this.#e.videoHeight
      }), A;
    }
    if (this.#a === "starting" || this.#a === "failed")
      return createImageBitmap(this.#e);
    const e = this.#c;
    if (this.#f && (!this.#u || this.#F || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#u || this.#F || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#Xe(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#oe(e.flush, e.second, null, !1) : this.#Ne(null, !1);
    const t = this.#e.videoWidth, i = this.#e.videoHeight;
    return t > 0 && i > 0 && (t !== this.#l.width || i !== this.#l.height) ? createImageBitmap(this.#l, {
      resizeWidth: t,
      resizeHeight: i,
      resizeQuality: "high"
    }) : createImageBitmap(this.#l);
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #we() {
    this.#f || !this.#u || this.#Y !== null || (this.#Y = this.#e.requestVideoFrameCallback(this.#wt));
  }
  /** seek と表示周期の判断に必要な DOM 側の再生状態を複製する。 */
  #Ue() {
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
  #pt(e, t) {
    let i;
    try {
      i = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (A) {
      this.#ne(
        A instanceof Error ? A.message : String(A)
      );
      return;
    }
    const s = {
      id: ++this.#ut,
      frame: i,
      now: e,
      metadata: t,
      video: this.#Ue()
    };
    if (this.#te) {
      this.#j?.frame.close(), this.#j = s;
      return;
    }
    this.#Je(s);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #Je(e) {
    const t = this.#n;
    if (!t || this.#a !== "active") {
      e.frame.close();
      return;
    }
    this.#te = !0;
    const i = { type: "frame", ...e };
    try {
      t.postMessage(i, [e.frame]);
    } catch (s) {
      this.#te = !1, e.frame.close();
      const A = s instanceof Error ? s.message : String(s);
      this.#I === "auto" && !this.#Le && !this.#de ? (this.#_e(), this.#Ge(e.now, e.metadata)) : this.#ne(A);
    }
  }
  #wt = (e, t) => {
    this.#Y = null, !(!this.#u || this.#F) && (this.#ce = e, this.#Z = Math.max(
      this.#Z,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#qe(e, t), this.#we());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #qe(e, t) {
    if (this.#a === "active") {
      this.#pt(e, t);
      return;
    }
    this.#a !== "starting" && this.#Ge(e, t);
  }
  /** @internal Worker でもメインスレッドと同じ履歴と描画判断を使うための入口。 */
  ingestExternalFrame(e, t, i) {
    this.#fe = i;
    try {
      this.#Ge(e, t);
    } finally {
      this.#fe = this.#e;
    }
  }
  /** 1枚の入力を共通の履歴へ取り込み、YADIF と IVTC の表示判断を完了する。 */
  #Ge(e, t) {
    if (this.#Et(t.mediaTime), t.width > 0 && t.height > 0) {
      let i = !1;
      if (!this.#ee && this.#e.seeking) {
        const a = this.#e.buffered, d = this.#h >= j ? this.#h / 1e3 : V / 1e3;
        for (let p = 0; p < a.length; p++)
          if (t.mediaTime >= a.start(p) && t.mediaTime < a.end(p) && Math.abs(t.mediaTime - this.#e.currentTime) <= d) {
            i = !0;
            break;
          }
      }
      if (i && (this.#ee = !0), (this.#m === 0 || this.#D === 0) && this.#rt(t.width, t.height), this.#r && !this.#r.interlaced) {
        this.#Tt();
        return;
      }
      const s = t.mediaTime - this.#z, A = i || s < 0 || s > me;
      A && (this.#o = 0, this.#h = 0, this.#E.discontinuities++, this.#t.length = 0, this.#g());
      const r = this.#d && this.#_ !== 0 && t.presentedFrames - this.#_ > 1;
      if (this.#Mt(t.presentedFrames, A), !A && r && (this.#o = 0, this.#g()), this.#o > 0 && t.mediaTime === this.#z)
        return;
      !A && s > 0 && this.#gt(s), this.#z = t.mediaTime;
      const h = performance.now();
      h - this.#Be > te && (this.#me = h, this.#U = 0, this.#Ae = 0, this.#se = 0, this.#re = 0, this.#V = 0, this.#P = 0), this.#Be = h;
      const n = performance.now();
      this.#st();
      const l = this.#M, o = this.#d && this.#o === b && this.#vt();
      if (l !== this.#M && (this.#t.length = 0), !(o && this.#Ee())) if (this.#d && !this.#ye && this.#M === "film")
        if (this.#Ee()) {
          const a = this.#h * 5 / 4, d = this.#et(1, e, a), p = this.#t.at(-1), E = d ? e : p == null ? e + a : p.at + p.duration;
          this.#Dt(E, a);
        } else
          this.#Ne(null);
      else if (this.#x && this.#Ee()) {
        const a = this.#h / 2, d = this.#et(2, e, a), p = this.#t.at(-1), E = d ? e : p == null ? e + a * 2 : p.at + p.duration;
        this.#$e(!1, E, a), this.#$e(!0, E + a, a);
      } else
        this.#E.late += this.#t.length, this.#t.length = 0, this.#oe(!1, !1, null);
      this.#V = Math.max(
        this.#V,
        this.#t.length
      ), this.#Ae += performance.now() - n, this.#U++, this.#Ft(h);
    }
  }
  #Et(e) {
    let t;
    for (let A = this.#Q.length - 1; A >= 0; A--) {
      const r = this.#Q[A];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#m || t.codedSize.height !== this.#D) && this.#rt(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#r?.interlaced === i.interlaced && this.#r.topFieldFirst === i.topFieldFirst)
      return;
    const s = this.#r?.interlaced;
    this.#r = i, this.#o = 0, this.#t.length = 0, this.#g(), s !== i.interlaced && (this.#h = 0), i.interlaced ? this.#G() : this.#He();
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
    return (this.#x || this.#d) && this.#h > 0 && this.#w.length === k;
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
  #gt(e) {
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#h > 0 ? Math.max(1, Math.round(t / this.#h)) : 1, s = t / i;
    s < j || s > V || (this.#h = this.#h > 0 ? this.#h + (s - this.#h) * pe : s);
  }
  /** Build the optional film passes only for callers that enable them. */
  #Ke() {
    if (this.#S && this.#k && this.#q) return;
    const e = this.#A, t = W(e, ce), i = W(e, ue), s = W(e, fe);
    this.#S = t, this.#he = Object.fromEntries(
      Object.entries(Q).filter(([A]) => A !== "match" && A !== "topFieldFirst").map(([A, r]) => [A, e.getUniformLocation(t, r)])
    ), this.#k = i, this.#ae = Object.fromEntries(
      Object.entries(Q).map(([A, r]) => [
        A,
        e.getUniformLocation(i, r)
      ])
    ), this.#q = s, this.#Ze = Object.fromEntries(
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
  #vt() {
    const e = this.#L, t = this.#S, i = this.#he, s = this.#q, A = this.#Ze;
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
    this.#$ = d.match, this.#be = d.combScore, this.#ye = d.isCombed, this.#Te = p.lowestCycleDifference, this.#Me = p.runnerUpCycleDifference;
    const E = p.dropIndex !== null && !d.isCombed;
    return (E ? "film" : "video") !== this.#M && (this.#M = E ? "film" : "video"), p.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Dt(e, t) {
    const i = this.#We();
    if (i === null) return;
    const s = this.#w[i];
    if (s) {
      for (this.#K = i; this.#t.length > 0 && this.#t[0]?.slot === i; )
        this.#t.shift(), this.#E.late++;
      this.#Ne(s.framebuffer), this.#t.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Ne(e, t = !0) {
    const i = this.#k, s = this.#ae;
    if (!i || !s) return;
    const A = this.#A, r = this.#p, h = (this.#p + b - 1) % b, n = (this.#p + 1) % b, l = this.#pe;
    A.bindFramebuffer(A.FRAMEBUFFER, e), A.useProgram(i);
    for (const [o, f] of [n, h, r].entries())
      A.activeTexture(A.TEXTURE0 + o), A.bindTexture(A.TEXTURE_2D, this.#y[f] ?? null);
    A.uniform1i(s.prev, 0), A.uniform1i(s.cur, 1), A.uniform1i(s.next, 2), A.uniform2i(s.size, this.#m, this.#D), A.uniform1i(s.topFieldFirst, l ? 1 : 0), A.uniform1i(
      s.match,
      this.#$ === "p" ? 0 : this.#$ === "c" ? 1 : 2
    ), A.viewport(0, 0, this.#m, this.#D), A.drawArrays(A.TRIANGLES, 0, 3), e === null && (this.#c = { kind: "film" }, this.#T(!0), t && this.#P++);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #$e(e, t, i) {
    const s = this.#We();
    if (s === null) return;
    const A = this.#w[s];
    if (A) {
      for (this.#K = s; this.#t.length > 0 && this.#t[0]?.slot === s; )
        this.#t.shift(), this.#E.late++;
      this.#oe(!1, e, A.framebuffer), this.#t.push({ slot: s, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #et(e, t, i) {
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
  #We() {
    const e = this.#c?.kind === "texture" ? this.#c.texture : null, t = new Set(this.#t.map(({ slot: s }) => s));
    for (let s = 1; s <= k; s++) {
      const A = (this.#K + s) % k, r = this.#w[A];
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
  #G() {
    this.#B === null && (!this.#u || this.#F || (this.#le = 0, this.#B = this.#it(this.#tt)));
  }
  #He() {
    this.#B !== null && this.#bt(this.#B), this.#B = null, this.#t.length = 0;
  }
  #tt = (e) => {
    if (this.#B = null, !(!this.#u || this.#F)) {
      if (this.#le > 0) {
        const t = e - this.#le;
        t >= 1 && t <= V && (this.#H = t < this.#H ? t : this.#H + (t - this.#H) * Ee);
      }
      this.#le = e, this.#yt(e), this.#a === "main" && this.#xt(e), this.#B = this.#it(this.#tt);
    }
  };
  /** ページと Worker のそれぞれが所有する rAF へ表示ループを委ねる。 */
  #it(e) {
    return this.#f ? this.#f.requestAnimationFrame(e) : requestAnimationFrame(e);
  }
  /** 選択中の描画先で予約した表示機会を取り消す。 */
  #bt(e) {
    this.#f ? this.#f.cancelAnimationFrame(e) : cancelAnimationFrame(e);
  }
  /** ブラウザから callback が来ない間も animation loop から復号フレームを取り込む。 */
  #yt(e) {
    if (this.#f || e - this.#ce < ge || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, s = this.#h >= j ? this.#h : ve, A = i > this.#Z, r = t > this.#z && e - this.#Fe >= s * 0.75;
    !A && !r || (this.#Z = Math.max(
      this.#Z,
      i
    ), this.#Fe = e, this.#qe(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#_ + 1, i),
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
  #xt(e) {
    const t = e + this.#H * 1.5;
    for (; this.#t[1] && this.#t[1].at <= t; )
      this.#E.late++, this.#t.shift();
    let i = this.#t[0];
    if (!i || i.at > t)
      return;
    this.#t.shift();
    const s = performance.now();
    this.#At(i.slot), this.#re += performance.now() - s, this.#se++;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #At(e) {
    const t = this.#w[e];
    t && this.#Xe(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #Tt() {
    this.#st();
    const e = this.#y[this.#p];
    e && this.#Xe(e, !0), this.#o = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #T(e) {
    if (this.#f) {
      this.#f.onVisibility(e);
      return;
    }
    this.#i.style.visibility = e ? "visible" : "hidden";
  }
  #Xe(e, t = !1, i = !0) {
    const s = this.#A;
    s.bindFramebuffer(s.FRAMEBUFFER, null), s.useProgram(this.#b), s.activeTexture(s.TEXTURE0), s.bindTexture(s.TEXTURE_2D, e), s.uniform1i(this.#N, 0), s.uniform1i(this.#W, t ? 1 : 0), s.viewport(0, 0, this.#m, this.#D), s.drawArrays(s.TRIANGLES, 0, 3), this.#c = { kind: "texture", texture: e, flip: t }, this.#T(!0), i && this.#P++;
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
  #Mt(e, t) {
    this.#_ !== 0 && !t && (this.#E.missed += Math.max(0, e - this.#_ - 1)), this.#_ = e;
  }
  #Ft(e) {
    const t = e - this.#me;
    if (t < te) return;
    const i = this.#Ee() && (this.#x || this.#M === "film") ? this.#se : this.#U, s = {
      ...this.#E,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#U === 0 ? 0 : (this.#Ae + this.#re) / this.#U,
      maxQueuedFields: this.#V,
      mode: this.#M,
      match: this.#$,
      combScore: this.#be,
      outputFps: this.#P * 1e3 / t,
      duplicateScore: this.#Te,
      duplicateRunnerUp: this.#Me
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: s })), this.#Re?.(s), this.#me = e, this.#U = 0, this.#Ae = 0, this.#se = 0, this.#re = 0, this.#V = 0, this.#P = 0;
  }
  /** Take the newest frame into the ring. */
  #st() {
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
  #oe(e, t, i, s = !0) {
    if (this.#o === 0 || this.#F) return;
    s && (this.#o === b && !e ? this.#E.filtered++ : this.#E.degraded++);
    const A = this.#A, r = this.#p, h = (this.#p + b - 1) % b, n = (this.#p + 1) % b;
    let l, o, f;
    this.#o === 1 ? l = o = f = r : e ? (l = h, o = f = r) : this.#o === 2 ? (l = o = h, f = r) : (l = n, o = h, f = r), A.bindFramebuffer(A.FRAMEBUFFER, i), A.useProgram(this.#v);
    for (const [a, d] of [l, o, f].entries())
      A.activeTexture(A.TEXTURE0 + a), A.bindTexture(A.TEXTURE_2D, this.#y[d] ?? null);
    A.uniform1i(this.#s.prev, 0), A.uniform1i(this.#s.cur, 1), A.uniform1i(this.#s.next, 2), A.uniform2i(this.#s.size, this.#m, this.#D);
    const u = this.#pe ? 0 : 1;
    A.uniform1i(this.#s.parity, t ? 1 - u : u), A.uniform1i(this.#s.tff, this.#pe ? 1 : 0), A.uniform1i(this.#s.spatialCheck, this.#De ? 1 : 0), A.viewport(0, 0, this.#m, this.#D), A.drawArrays(A.TRIANGLES, 0, 3), i === null && (this.#c = { kind: "yadif", flush: e, second: t }, this.#T(!0), s && this.#P++);
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
  #rt(e, t) {
    const i = this.#A;
    this.#l.width = e, this.#l.height = t, this.#f?.onSize(e, t), this.#m = e, this.#D = t, this.#o = 0, this.#c = null, this.#g(), this.#ge();
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
    this.#J(), this.#Oe(), this.#d && this.#nt(), (this.#x || this.#d) && this.#ze();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #nt() {
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
  #Oe() {
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
  #ze() {
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
          e.deleteFramebuffer(s), e.deleteTexture(i), this.#J();
          return;
        }
        this.#w.push({ texture: i, framebuffer: s });
      }
      this.#K = k - 1;
    }
  }
  #J() {
    const e = this.#A, t = this.#c?.kind === "texture" ? this.#c.texture : null;
    this.#w.some((i) => i.texture === t) && (this.#c = null);
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
  #Rt() {
    if (this.#X) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#X = t, this.#ve?.observe(this.#e), this.#ge();
  }
  #Ct() {
    if (this.#f) return;
    const e = this.#X;
    this.#X = null, this.#ve?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #ot = () => this.#ge();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #Ye(e) {
    return !this.#n || this.#a === "main" ? !1 : (this.#n.postMessage({
      type: "event",
      name: e,
      video: this.#Ue()
    }), !0);
  }
  #ht = () => {
    if (this.#Ye("emptied")) {
      this.#R(), this.#T(!1);
      return;
    }
    this.#o = 0, this.#z = 0, this.#t.length = 0, this.#h = 0, this.#at(), this.#g(), this.#c = null, this.#T(!1);
  };
  #at() {
    this.#E = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#_ = 0, this.#me = 0, this.#Be = 0, this.#U = 0, this.#Ae = 0, this.#se = 0, this.#re = 0, this.#V = 0, this.#P = 0, this.#g();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #g() {
    this.#t.length = 0, this.#M = "video", this.#$ = "c", this.#be = 0, this.#ye = !0, this.#xe.reset(), this.#Te = 1 / 0, this.#Me = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #lt = () => {
    if (this.#Ye("seeking")) {
      this.#R();
      return;
    }
    this.#ee = !1;
  };
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #C = (e) => {
    if ((e.type === "pause" || e.type === "ended" || e.type === "seeked" || e.type === "ratechange") && this.#Ye(e.type)) {
      this.#R();
      return;
    }
    if (e.type === "seeked") {
      const i = this.#ee;
      if (this.#ee = !1, i) return;
      this.#o = 0, this.#g(), this.#c = null, this.#T(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#h = 0, this.#z = this.#e.currentTime), this.#t.length = 0, this.#u && this.#o > 0) {
      const i = this.#We(), s = i === null ? void 0 : this.#w[i];
      i !== null && s ? (this.#K = i, this.#oe(!0, !1, s.framebuffer), this.#At(i)) : this.#oe(!0, !1, null);
    }
    t && (this.#o = 0, this.#g());
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #ct = (e) => {
    if (e.preventDefault(), this.#f) {
      this.#f.onFailure("the deinterlacer WebGL context was lost");
      return;
    }
    this.#a !== "active" && (this.#F = !0, this.stop());
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
