const we = "" + new URL("assets/worker-CNEg1XXr.js", import.meta.url).href, ge = {
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
}, x = 288, M = 162, ve = `#version 300 es
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
  #b = null;
  #n = [];
  #y = null;
  #W = 1 / 0;
  #O = 1 / 0;
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
    let n = this.#L("c", "p", r, o);
    const c = /* @__PURE__ */ new Map(), a = (p) => {
      const g = c.get(p);
      if (g !== void 0) return g;
      const w = b.#B(
        this.weave(e, t, i, p, A),
        this.#u,
        this.#i
      );
      return c.set(p, w), w;
    }, f = a(n), u = a("n");
    (u * 3 < f || u * 2 < f && f > s) && Math.abs(u - f) >= 30 && u < s && (n = "n");
    const l = a(n), d = l >= s;
    return d && (n = "c"), {
      match: n,
      combScore: l,
      isCombed: d,
      luma: this.weave(e, t, i, n, A)
    };
  }
  /** Apply FFmpeg's mixed decimate threshold to a live five-frame window. */
  decimate(e) {
    const t = this.#s, i = this.#y ? b.#fe(
      this.#y,
      e,
      this.#u,
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
    let o = this.#b;
    if (this.#s === b.CYCLE) {
      let n = 0, c = null;
      for (let a = 1; a < this.#n.length; a++)
        (this.#n[a]?.maxBlockDifference ?? 1 / 0) < (this.#n[n]?.maxBlockDifference ?? 1 / 0) ? (c = n, n = a) : (c === null || (this.#n[a]?.maxBlockDifference ?? 1 / 0) < (this.#n[c]?.maxBlockDifference ?? 1 / 0)) && (c = a);
      this.#W = this.#n[n]?.maxBlockDifference ?? 1 / 0, this.#O = c === null ? 1 / 0 : this.#n[c]?.maxBlockDifference ?? 1 / 0, o = (this.#n[n]?.maxBlockDifference ?? 1 / 0) < this.#e ? n : null, this.#b = o, this.#n = [], this.#s = 0;
    }
    return {
      cycleIndex: t,
      maxBlockDifference: i.maxBlockDifference,
      totalDifference: i.totalDifference,
      shouldDrop: s,
      dropIndex: r,
      nextDropIndex: o,
      lowestCycleDifference: this.#W,
      runnerUpCycleDifference: this.#O
    };
  }
  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(e, t, i, A, s) {
    if (A === "c") return t.slice();
    const r = t.slice(), o = A === "p" ? e : i, n = r.length / this.#i, c = s ? 1 : 0;
    for (let a = c; a < this.#i; a += 2)
      r.set(
        o.subarray(a * n, (a + 1) * n),
        a * n
      );
    return r;
  }
  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset() {
    this.#s = 0, this.#b = null, this.#n = [], this.#y = null, this.#W = 1 / 0, this.#O = 1 / 0;
  }
  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #L(e, t, i, A) {
    const s = this.#u, r = this.#i, o = 2 - i, n = 2 - i, c = A[e], a = A[t], f = b.#ue(
      c,
      a,
      s,
      r,
      i
    );
    let u = 0, l = 0, d = 0, p = 0, g = 0, w = 0;
    for (let k = 2; k < r - 2; k += 2) {
      const y = (k - 2) / 2, V = o - 1 + y * 2, q = o + 1 + y * 2, J = o + 3 + y * 2, Z = o + y * 2, H = Z + 2, B = n + y * 2, R = B + 2, ne = o + y * 2;
      for (let T = 8; T < s - 8; T++) {
        const C = (f[ne * s + T] ?? 0) | (f[(ne + 2) * s + T] ?? 0);
        if (C === 0) continue;
        const ae = (A.c[V * s + T] ?? 0) + ((A.c[q * s + T] ?? 0) << 2) + (A.c[J * s + T] ?? 0), P = Math.abs(
          3 * ((c[Z * s + T] ?? 0) + (c[H * s + T] ?? 0)) - ae
        ), _ = Math.abs(
          3 * ((a[B * s + T] ?? 0) + (a[R * s + T] ?? 0)) - ae
        );
        P > 23 && (C & 1) !== 0 && (u += P), _ > 23 && (C & 1) !== 0 && (p += _), P > 42 && (C & 2) !== 0 && (l += P), _ > 42 && (C & 2) !== 0 && (g += _), P > 42 && (C & 4) !== 0 && (d += P), _ > 42 && (C & 4) !== 0 && (w += _);
      }
    }
    l < 500 && g < 500 && (d >= 500 || w >= 500) && Math.max(d, w) > 3 * Math.min(d, w) && (l = d, g = w);
    const v = Math.floor(u / 6 + 0.5), F = Math.floor(p / 6 + 0.5), E = Math.floor(l / 6 + 0.5), m = Math.floor(g / 6 + 0.5), W = Math.max(v, F) / Math.max(Math.min(v, F), 1), O = Math.max(E, m) / Math.max(Math.min(E, m), 1), X = Math.max(E, m) / Math.max(Math.max(v, F), 1);
    return (E >= 500 || m >= 500) && (E * 2 < m || m * 2 < E) || (E >= 1e3 || m >= 1e3) && (E * 3 < m * 2 || m * 3 < E * 2) || (E >= 2e3 || m >= 2e3) && (E * 5 < m * 4 || m * 5 < E * 4) || (E >= 4e3 || m >= 4e3) && O > W || X > 5e-3 && Math.max(E, m) > 150 && (E * 2 < m || m * 2 < E) ? E > m ? t : e : v > F ? t : e;
  }
  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #ue(e, t, i, A, s) {
    const r = Array.from(
      { length: Math.ceil(A / 2) },
      () => new Uint8Array(i)
    ), o = s === 1 ? 1 : 0;
    for (let a = 0; a < r.length; a++) {
      const f = Math.min(A - 1, o + a * 2), u = r[a];
      if (u)
        for (let l = 0; l < i; l++)
          u[l] = Math.abs(
            (e[f * i + l] ?? 0) - (t[f * i + l] ?? 0)
          );
    }
    const n = new Uint8Array(i * A), c = s === 1 ? 3 : 2;
    for (let a = 1; a < r.length - 1; a++) {
      const f = c + (a - 1) * 2;
      if (f >= A) break;
      const u = r[a];
      if (u)
        for (let l = 1; l < i - 1; l++) {
          const d = u[l] ?? 0;
          if (d <= 3) continue;
          let p = 0;
          for (let m = l - 1; m <= l + 1; m++)
            p += (r[a - 1]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[a]?.[m] ?? 0) > 3 ? 1 : 0, p += (r[a + 1]?.[m] ?? 0) > 3 ? 1 : 0;
          if (p <= 1) continue;
          const g = f * i + l;
          if (n[g] = 1, d <= 19) continue;
          p = 0;
          let w = !1, v = !1;
          for (let m = l - 1; m <= l + 1; m++)
            (r[a - 1]?.[m] ?? 0) > 19 && (p++, w = !0), (r[a]?.[m] ?? 0) > 19 && p++, (r[a + 1]?.[m] ?? 0) > 19 && (p++, v = !0);
          if (p <= 3) continue;
          if (w && v) {
            n[g] |= 2;
            continue;
          }
          let F = !1, E = !1;
          for (let m = Math.max(l - 4, 0); m < Math.min(l + 5, i); m++)
            a !== 1 && (r[a - 2]?.[m] ?? 0) > 19 && (F = !0), (r[a - 1]?.[m] ?? 0) > 19 && (w = !0), (r[a + 1]?.[m] ?? 0) > 19 && (v = !0), a !== r.length - 2 && (r[a + 2]?.[m] ?? 0) > 19 && (E = !0);
          w && (v || F) || v && (w || E) ? n[g] |= 2 : p > 5 && (n[g] |= 4);
        }
    }
    return n;
  }
  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #B(e, t, i) {
    const A = new Uint8Array(t * i), s = (o, n) => e[Math.max(0, Math.min(i - 1, n)) * t + o] ?? 0;
    for (let o = 0; o < i; o++)
      for (let n = 0; n < t; n++) {
        const c = s(n, o), a = s(n, o === 0 ? 1 : o - 1), f = s(n, o === i - 1 ? i - 2 : o + 1), u = o < 2 ? s(n, o === 0 ? 2 : 3) : s(n, o - 2), l = o + 2 >= i ? s(n, o === i - 1 ? i - 3 : i - 4) : s(n, o + 2);
        (o === 0 ? Math.abs(c - f) > b.COMB_THRESHOLD : o === i - 1 ? Math.abs(c - a) > b.COMB_THRESHOLD : Math.abs(c - a) > b.COMB_THRESHOLD && Math.abs(c - f) > b.COMB_THRESHOLD) && Math.abs(
          4 * c - 3 * (a + f) + u + l
        ) > b.COMB_THRESHOLD * 6 && (A[o * t + n] = 255);
      }
    let r = 0;
    for (const o of [0, 8])
      for (const n of [0, 8])
        for (let c = o; c < i; c += 16)
          for (let a = n; a < t; a += 16) {
            let f = 0;
            for (let u = Math.max(1, c); u < Math.min(i - 1, c + 16); u++)
              for (let l = a; l < Math.min(t, a + 16); l++) {
                const d = u * t + l;
                A[d - t] === 255 && A[d] === 255 && A[d + t] === 255 && f++;
              }
            r = Math.max(r, f);
          }
    return r;
  }
  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #fe(e, t, i, A) {
    const s = b.DECIMATE_BLOCK / 2, r = Math.ceil(i / s), o = Math.ceil(A / s), n = new Float64Array(r * o), c = e.length / (i * A);
    for (let u = 0; u < A; u++) {
      const l = Math.floor(u / s);
      for (let d = 0; d < i; d++) {
        const p = Math.floor(d / s), g = l * r + p, w = (u * i + d) * c;
        if (c === 1) {
          n[g] = (n[g] ?? 0) + Math.abs((e[w] ?? 0) - (t[w] ?? 0));
          continue;
        }
        const v = Math.round(
          (e[w] ?? 0) * 0.2126 + (e[w + 1] ?? 0) * 0.7152 + (e[w + 2] ?? 0) * 0.0722
        ), F = Math.round(
          (t[w] ?? 0) * 0.2126 + (t[w + 1] ?? 0) * 0.7152 + (t[w + 2] ?? 0) * 0.0722
        );
        if (n[g] = (n[g] ?? 0) + Math.abs(v - F), (d & 1) !== 0 || (u & 1) !== 0) continue;
        let E = 0, m = 0, W = 0, O = 0, X = 0, k = 0, y = 0;
        for (let H = u; H < Math.min(u + 2, A); H++)
          for (let B = d; B < Math.min(d + 2, i); B++) {
            const R = (H * i + B) * c;
            E += e[R] ?? 0, m += e[R + 1] ?? 0, W += e[R + 2] ?? 0, O += t[R] ?? 0, X += t[R + 1] ?? 0, k += t[R + 2] ?? 0, y++;
          }
        const V = Math.round(
          (-0.114572 * E - 0.385428 * m + 0.5 * W) / y
        ), q = Math.round(
          (-0.114572 * O - 0.385428 * X + 0.5 * k) / y
        ), J = Math.round(
          (0.5 * E - 0.454153 * m - 0.045847 * W) / y
        ), Z = Math.round(
          (0.5 * O - 0.454153 * X - 0.045847 * k) / y
        );
        n[g] = (n[g] ?? 0) + Math.abs(V - q) + Math.abs(J - Z);
      }
    }
    let a = -1;
    for (let u = 0; u < o - 1; u++)
      for (let l = 0; l < r - 1; l++)
        a = Math.max(
          a,
          (n[u * r + l] ?? 0) + (n[u * r + l + 1] ?? 0) + (n[(u + 1) * r + l] ?? 0) + (n[(u + 1) * r + l + 1] ?? 0)
        );
    let f = 0;
    for (const u of n) f += u;
    return { maxBlockDifference: a, totalDifference: f };
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
function I(h) {
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
function S(h, e, t, i) {
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
  schemaVersion: 1,
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
function Te(h) {
  pe = h;
}
const xe = 0.5, D = 3, se = 5, L = se + 1, oe = 1e3, ee = 4, te = 200, Me = 0.25, Fe = 1e3 / 60, Re = 0.02, ke = 250, Ce = 1e3 / 30;
function he(h) {
  if (!Number.isFinite(h) || h < 0)
    throw new RangeError(
      "filmCombThreshold must be a finite number greater than or equal to 0"
    );
  return h;
}
const Se = `#version 300 es
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
  #b;
  #n;
  /** The program that copies a filtered picture onto the canvas. */
  #y;
  #W;
  #O;
  /** The reduced pass that reads previous, current and next luma together. */
  #L = null;
  #ue = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #B = null;
  #fe = null;
  /** The selected weave reduced to RGB for FFmpeg decimate's block metrics. */
  #$ = null;
  #qe = null;
  #P = null;
  #T = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #g = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #ee = L - 1;
  /** The draw path currently shown on the canvas, retained for snapshots. */
  #f = null;
  /** Filtered fields waiting for their moment, oldest first. */
  #t = [];
  /** The requestAnimationFrame() loop that puts them up, which is all that draws on the canvas. */
  #_ = null;
  #de = 0;
  /** ページ側で requestVideoFrameCallback() の停止を監視する requestAnimationFrame()。 */
  #I = null;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #X = Fe;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #H = null;
  #Me;
  #x;
  #m;
  #z;
  #Fe;
  #k = "video";
  #te = "c";
  #Re = 0;
  #ke = !0;
  #Ce = new b(x, M);
  #Se = 1 / 0;
  #Le = 1 / 0;
  #U = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #l = 0;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #p = 0;
  #D = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #w = D - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #a = 0;
  #ie = 0;
  #me = Number.NaN;
  /** A destination frame that arrived before the browser finished seeking. */
  #se = !1;
  #Y = null;
  /** requestVideoFrameCallback() の停止を検出するために保持する最終通知時刻。 */
  #pe = 0;
  /** どちらの取得経路からも参照するブラウザの復号フレーム数。 */
  #Z = 0;
  /** animation loop の代替経路が最後にフレームを取り込んだ時刻。 */
  #Be = 0;
  #c = !1;
  #we = !1;
  #Pe = !1;
  #o = null;
  #Q = [];
  #M = !1;
  #_e;
  #h;
  #ge;
  #d;
  #Ie;
  #r = null;
  #A;
  #j = !1;
  #F = 0;
  #Ue = !1;
  #wt = 0;
  #Ae = !1;
  #Ee = !1;
  #V = null;
  #gt = 0;
  #re = /* @__PURE__ */ new Map();
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
  #N = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #Ne = 0;
  #ve = 0;
  #G = 0;
  #ne = 0;
  #ae = 0;
  #oe = 0;
  #q = 0;
  constructor(e, t = {}, i = null) {
    super(), this.#e = e, this.#x = t.doubleRate ?? !1, this.#m = t.autoFilm ?? !1, this.#z = he(
      t.filmCombThreshold ?? b.COMBED_PIXEL_LIMIT
    ), this.#Fe = t.spatialCheck ?? !0, this.#_e = t.onStats, this.#h = i, this.#d = i ? "main" : t.rendering ?? "auto", this.#Ie = t.workerUrl ?? pe, this.#A = this.#d === "main" ? "main" : "idle", i || S(
      this.#d,
      this.#A === "main" ? "main" : "starting",
      this.#F,
      this.#A === "main" ? "configured-main" : "configured-auto"
    ), this.#i = i ? i.canvas : document.createElement("canvas"), this.#u = i?.canvas ?? (this.#d === "main" ? this.#i : document.createElement("canvas")), this.#ge = e, i || (this.#i.style.cssText = "position:absolute;pointer-events:none;visibility:hidden");
    const A = this.#u.getContext("webgl2", {
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
      Object.entries(ge).map(([r, o]) => [
        r,
        A.getUniformLocation(s, o)
      ])
    ), this.#y = z(A, Le), this.#W = A.getUniformLocation(this.#y, "uField"), this.#O = A.getUniformLocation(this.#y, "uFlip"), this.#m && this.#it(), this.#u.addEventListener(
      "webglcontextlost",
      this.#pt
    ), this.#Me = i ? null : new ResizeObserver(() => this.#xe()), e.addEventListener("emptied", this.#ft), e.addEventListener("resize", this.#ut), e.addEventListener("pause", this.#S), e.addEventListener("ended", this.#S), e.addEventListener("seeking", this.#mt), e.addEventListener("seeked", this.#S), e.addEventListener("ratechange", this.#S);
  }
  get running() {
    return this.#c && (this.#o?.interlaced ?? !0);
  }
  /** 現在 media element の上に配置している HTML canvas。 */
  get canvas() {
    return this.#i;
  }
  /** Field order for the current scan state, defaulting to top-field-first. */
  get #be() {
    return this.#o?.topFieldFirst !== !1;
  }
  /** どの描画先にも同じ公開オプションを渡す。 */
  #Je() {
    return {
      doubleRate: this.#x,
      autoFilm: this.#m,
      filmCombThreshold: this.#z,
      spatialCheck: this.#Fe
    };
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#we;
  }
  set enabled(e) {
    this.#we = e, this.#We(), this.#r?.postMessage({
      type: "enabled",
      enabled: e
    });
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#o?.interlaced !== e?.interlaced, i = t || this.#o?.topFieldFirst !== e?.topFieldFirst;
    this.#o = e, this.#r?.postMessage({ type: "scan", scan: e }), i && (this.#a = 0, this.#v(), t && (this.#l = 0), this.#f = null, this.#R(!1)), this.#We(), i && ((e?.interlaced ?? !0) && (this.#h || this.#A === "main") ? this.#J() : this.#ze());
  }
  get scan() {
    return this.#o;
  }
  set videoTimeline(e) {
    this.#Q = e, this.#r?.postMessage({
      type: "timeline",
      videoTimeline: e
    }), e.length === 0 && (this.#o = null), this.#We();
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
    return this.#H ?? this.#e;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#x;
  }
  set doubleRate(e) {
    e !== this.#x && (this.#x = e, this.#Ge(), this.#t.length = 0, e ? (this.#p > 0 && this.#je(), (this.#o?.interlaced ?? !0) && (this.#h || this.#A === "main") && this.#J()) : this.#m || (this.#f = null, this.#R(!1), this.#K()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#m;
  }
  set autoFilm(e) {
    e !== this.#m && (this.#m = e, this.#Ge(), this.#v(), e ? (this.#it(), this.#p > 0 && (this.#ct(), this.#je()), (this.#o?.interlaced ?? !0) && (this.#h || this.#A === "main") && this.#J()) : (this.#Qe(), this.#x || (this.#f = null, this.#R(!1), this.#K())));
  }
  /** The combed-pixel limit used by automatic film detection. */
  get filmCombThreshold() {
    return this.#z;
  }
  set filmCombThreshold(e) {
    const t = he(e);
    t !== this.#z && (this.#z = t, this.#Ge(), this.#m && this.#v());
  }
  /** Worker と canvas を再構築せずに変更可能なフィルター設定を反映する。 */
  #Ge() {
    this.#r?.postMessage({
      type: "settings",
      options: this.#Je()
    });
  }
  #We() {
    this.#we && (this.#Q.length > 0 || (this.#o?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  /** 転送に必要な API がそろっている場合だけ同梱 Worker を起動する。 */
  #Et() {
    return this.#h || this.#d === "main" ? !1 : this.#A === "starting" || this.#A === "active" ? !0 : typeof Worker < "u" && typeof VideoFrame < "u" && typeof OffscreenCanvas < "u" && this.#Ie !== null && "transferControlToOffscreen" in HTMLCanvasElement.prototype ? (this.#Ke(), !0) : this.#d === "auto" ? (this.#De("capability-fallback"), !1) : (this.#A = "failed", this.#c = !1, S(
      this.#d,
      "failed",
      this.#F,
      "required-worker-unavailable"
    ), !0);
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
    const t = ++this.#F;
    this.#A = "starting", S(
      this.#d,
      "starting",
      t,
      this.#j ? "worker-restarting" : "worker-starting"
    );
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
      t === this.#F && this.#vt(s.data);
    }, i.onerror = (s) => {
      t === this.#F && (s.preventDefault(), this.#he(s.message || "the deinterlacer worker failed"));
    }, i.postMessage(
      {
        type: "initialize",
        canvas: A,
        options: this.#Je(),
        scan: this.#o,
        videoTimeline: this.#Q,
        enabled: this.#c,
        video: this.#Oe()
      },
      [A]
    );
  }
  /** Worker の通知を反映し、入力を1枚ずつ送るための待機を解除する。 */
  #vt(e) {
    switch (e.type) {
      case "ready":
        this.#A = "active", S(
          this.#d,
          "worker",
          this.#F,
          "worker-ready"
        ), this.#c && (this.#le(), this.#Ye());
        break;
      case "failed":
        this.#he(e.message);
        break;
      case "consumed": {
        this.#Ae = !1, this.#Ee = !0;
        const t = this.#V;
        this.#V = null, t && this.#et(t);
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
        this.dispatchEvent(new CustomEvent("stats", { detail: t })), this.#_e?.(t);
        break;
      }
      case "diagnostic-batch":
        ye(e.batch, this.#F);
        break;
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
  #he(e) {
    if (this.#A === "starting" && this.#d === "auto" && !this.#j) {
      this.#De("initialization-fallback");
      return;
    }
    if (this.#$e(e), !this.#j) {
      this.#j = !0, this.#Ke();
      return;
    }
    console.error(`Deinterlacer Worker stopped: ${e}`), this.#A = "failed", S(
      this.#d,
      "failed",
      this.#F,
      "worker-terminal-failure"
    ), this.#r?.terminate(), this.#r = null, this.#C(), this.stop();
  }
  /** Worker を自動選択できなかった場合は元のメインスレッド用 canvas へ戻す。 */
  #De(e) {
    const t = this.#u;
    t.className = this.#i.className;
    const i = this.#i.getAttribute("style");
    i === null ? t.removeAttribute("style") : t.setAttribute("style", i), t.style.visibility = "hidden", this.#i.parentElement && this.#i.replaceWith(t), this.#i = t, this.#Ue = !1, this.#r?.terminate(), this.#r = null, this.#A = "main", S(this.#d, "main", this.#F, e), this.#C(), this.#c && (this.#le(), this.#Ye(), (this.#o?.interlaced ?? !0) && this.#J());
  }
  /** 描画先を切り替えるとき、ページ側がまだ所有する待機フレームを閉じる。 */
  #C() {
    this.#V?.frame.close(), this.#V = null;
  }
  /** Worker の再構築後には応答できない capture を失敗として完了する。 */
  #$e(e) {
    for (const t of this.#re.values())
      t.reject(new Error(e));
    this.#re.clear();
  }
  start() {
    if (!(this.#c || this.#Pe || this.#M)) {
      if (this.#c = !0, this.#dt(), this.#v(), this.#pe = performance.now(), this.#Be = this.#pe, this.#me = Number.NaN, this.#Z = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, this.#Pt(), this.#Ye(), this.#Et()) {
        this.#r?.postMessage({
          type: "enabled",
          enabled: !0
        }), this.#A === "active" && this.#le();
        return;
      }
      this.#le(), (this.#o?.interlaced ?? !0) && this.#J();
    }
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#c && (this.#c = !1, this.#Y !== null && this.#e.cancelVideoFrameCallback(this.#Y), this.#Y = null, this.#Rt(), this.#ze(), this.#a = 0, this.#f = null, this.#R(!1), this.#C(), this.#r?.postMessage({
      type: "enabled",
      enabled: !1
    }));
  }
  destroy() {
    if (!this.#Pe) {
      this.#Pe = !0, this.#we = !1, this.stop(), this.#r?.postMessage({ type: "destroy" }), this.#r?.terminate(), this.#r = null, S(
        this.#d,
        "failed",
        this.#F,
        "destroyed"
      ), this.#C(), this.#$e("the deinterlacer was destroyed"), this.#u.removeEventListener(
        "webglcontextlost",
        this.#pt
      ), this.#e.removeEventListener("emptied", this.#ft), this.#e.removeEventListener("resize", this.#ut), this.#e.removeEventListener("pause", this.#S), this.#e.removeEventListener("ended", this.#S), this.#e.removeEventListener("seeking", this.#mt), this.#e.removeEventListener("seeked", this.#S), this.#e.removeEventListener("ratechange", this.#S), this.#_t();
      for (const e of this.#T) this.#s.deleteTexture(e);
      this.#T = [], this.#K(), this.#Qe(), this.#s.deleteProgram(this.#b), this.#s.deleteProgram(this.#y), this.#L && this.#s.deleteProgram(this.#L), this.#B && this.#s.deleteProgram(this.#B), this.#$ && this.#s.deleteProgram(this.#$), this.#s.getExtension("WEBGL_lose_context")?.loseContext();
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
      const A = ++this.#gt, s = new Promise((r, o) => {
        this.#re.set(A, { resolve: r, reject: o });
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
    const e = this.#f;
    if (this.#h && (!this.#c || this.#M || !e))
      return Promise.reject(new Error("no rendered picture is available"));
    if (!this.#c || this.#M || !e)
      return createImageBitmap(this.#e);
    e.kind === "texture" ? this.#Ze(e.texture, e.flip, !1) : e.kind === "yadif" ? this.#ce(e.flush, e.second, null, !1) : this.#Xe(null, !1);
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
  #le() {
    this.#h || !this.#c || this.#Y !== null || (this.#Y = this.#e.requestVideoFrameCallback(this.#Dt));
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
  #bt(e, t) {
    let i;
    try {
      i = new VideoFrame(this.#e, {
        timestamp: Math.max(0, Math.round(t.mediaTime * 1e6))
      });
    } catch (s) {
      const r = s instanceof Error ? s.message : String(s);
      this.#d === "auto" && !this.#Ee && !this.#j ? (this.#De("video-frame-fallback"), this.#ye(e, t)) : this.#he(r);
      return;
    }
    const A = {
      id: ++this.#wt,
      frame: i,
      now: e,
      metadata: t,
      video: this.#Oe()
    };
    if (this.#Ae) {
      this.#V?.frame.close(), this.#V = A;
      return;
    }
    this.#et(A);
  }
  /** 直前の入力を Worker が解放した後に、選択済みフレームを転送する。 */
  #et(e) {
    const t = this.#r;
    if (!t || this.#A !== "active") {
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
      this.#d === "auto" && !this.#Ee && !this.#j ? (this.#De("transfer-fallback"), this.#ye(e.now, e.metadata)) : this.#he(s);
    }
  }
  #Dt = (e, t) => {
    this.#Y = null, !(!this.#c || this.#M) && (this.#pe = e, this.#Z = Math.max(
      this.#Z,
      this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    ), this.#tt(e, t), this.#le());
  };
  /** どちらの通知経路で見つけたフレームも選択中の描画先へ取り込む。 */
  #tt(e, t) {
    if (this.#me = t.mediaTime, this.#A === "active") {
      this.#bt(e, t);
      return;
    }
    this.#A !== "starting" && this.#ye(e, t);
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
    if (this.#yt(t.mediaTime), t.width > 0 && t.height > 0) {
      let i = !1;
      if (!this.#se && this.#e.seeking) {
        const l = this.#e.buffered, d = this.#l >= ee ? this.#l / 1e3 : te / 1e3;
        for (let p = 0; p < l.length; p++)
          if (t.mediaTime >= l.start(p) && t.mediaTime < l.end(p) && Math.abs(t.mediaTime - this.#e.currentTime) <= d) {
            i = !0;
            break;
          }
      }
      if (i && (this.#se = !0), (this.#p === 0 || this.#D === 0) && this.#lt(t.width, t.height), this.#o && !this.#o.interlaced) {
        this.#St();
        return;
      }
      const A = t.mediaTime - this.#ie, s = i || A < 0 || A > xe;
      s && (this.#a = 0, this.#l = 0, this.#E.discontinuities++, this.#t.length = 0, this.#v());
      const r = this.#m && this.#N !== 0 && t.presentedFrames - this.#N > 1;
      if (this.#Lt(t.presentedFrames, s), !s && r && (this.#a = 0, this.#v()), this.#a > 0 && t.mediaTime === this.#ie)
        return;
      !s && A > 0 && this.#Tt(A), this.#ie = t.mediaTime;
      const o = performance.now();
      o - this.#Ne > oe && (this.#ve = o, this.#G = 0, this.#ne = 0, this.#ae = 0, this.#oe = 0, this.#q = 0, this.#U = 0), this.#Ne = o;
      const n = performance.now();
      this.#ht();
      const c = this.#k, a = this.#m && this.#a === D && this.#xt();
      if (c !== this.#k && (this.#t.length = 0), !(a && this.#Te())) if (this.#m && !this.#ke && this.#k === "film")
        if (this.#Te()) {
          const l = this.#l * 5 / 4, d = this.#At(1, e, l), p = this.#t.at(-1), g = d ? e : p == null ? e + l : p.at + p.duration;
          this.#Mt(g, l);
        } else
          this.#Xe(null);
      else if (this.#x && this.#Te()) {
        const l = this.#l / 2, d = this.#At(2, e, l), p = this.#t.at(-1), g = d ? e : p == null ? e + l * 2 : p.at + p.duration;
        this.#st(!1, g, l), this.#st(!0, g + l, l);
      } else
        this.#E.late += this.#t.length, this.#t.length = 0, this.#ce(!1, !1, null);
      this.#q = Math.max(
        this.#q,
        this.#t.length
      ), this.#ne += performance.now() - n, this.#G++, this.#Bt(o);
    }
  }
  #yt(e) {
    let t;
    for (let s = this.#Q.length - 1; s >= 0; s--) {
      const r = this.#Q[s];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#p || t.codedSize.height !== this.#D) && this.#lt(t.codedSize.width, t.codedSize.height);
    const i = t?.scan;
    if (!i || this.#o?.interlaced === i.interlaced && this.#o.topFieldFirst === i.topFieldFirst)
      return;
    const A = this.#o?.interlaced;
    this.#o = i, this.#a = 0, this.#t.length = 0, this.#v(), A !== i.interlaced && (this.#l = 0), i.interlaced && (this.#h || this.#A === "main") ? this.#J() : this.#ze();
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
    return (this.#x || this.#m) && this.#l > 0 && this.#g.length === L;
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
    const t = e * 1e3 / (this.#e.playbackRate || 1), i = this.#l > 0 ? Math.max(1, Math.round(t / this.#l)) : 1, A = t / i;
    A < ee || A > te || (this.#l = this.#l > 0 ? this.#l + (A - this.#l) * Me : A);
  }
  /** Build the optional film passes only for callers that enable them. */
  #it() {
    if (this.#L && this.#B && this.#$) return;
    const e = this.#s, t = z(e, ve), i = z(e, be), A = z(e, De);
    this.#L = t, this.#ue = Object.fromEntries(
      Object.entries(K).filter(([s]) => s !== "match" && s !== "topFieldFirst").map(([s, r]) => [s, e.getUniformLocation(t, r)])
    ), this.#B = i, this.#fe = Object.fromEntries(
      Object.entries(K).map(([s, r]) => [
        s,
        e.getUniformLocation(i, r)
      ])
    ), this.#$ = A, this.#qe = Object.fromEntries(
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
  #xt() {
    const e = this.#P, t = this.#L, i = this.#ue, A = this.#$, s = this.#qe;
    if (!e || !t || !i || !A || !s)
      return !1;
    const r = this.#s, o = this.#w, n = (this.#w + D - 1) % D, c = (this.#w + 1) % D, a = this.#be;
    r.bindFramebuffer(r.FRAMEBUFFER, e.framebuffer), r.useProgram(t);
    for (const [w, v] of [c, n, o].entries())
      r.activeTexture(r.TEXTURE0 + w), r.bindTexture(r.TEXTURE_2D, this.#T[v] ?? null);
    r.uniform1i(i.prev, 0), r.uniform1i(i.cur, 1), r.uniform1i(i.next, 2), r.uniform2i(i.size, this.#p, this.#D), r.viewport(0, 0, x, M), r.drawArrays(r.TRIANGLES, 0, 3), r.readPixels(
      0,
      0,
      x,
      M,
      r.RGBA,
      r.UNSIGNED_BYTE,
      e.pixels
    );
    const { previousLuma: f, currentLuma: u, nextLuma: l } = e;
    for (let w = 0; w < f.length; w++) {
      const v = w * 4;
      f[w] = e.pixels[v] ?? 0, u[w] = e.pixels[v + 1] ?? 0, l[w] = e.pixels[v + 2] ?? 0;
    }
    const d = this.#Ce.fieldMatch(
      f,
      u,
      l,
      a,
      this.#z
    );
    r.useProgram(A), r.uniform1i(s.prev, 0), r.uniform1i(s.cur, 1), r.uniform1i(s.next, 2), r.uniform2i(s.size, this.#p, this.#D), r.uniform1i(s.topFieldFirst, a ? 1 : 0), r.uniform1i(
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
    const p = this.#Ce.decimate(e.pixels);
    this.#te = d.match, this.#Re = d.combScore, this.#ke = d.isCombed, this.#Se = p.lowestCycleDifference, this.#Le = p.runnerUpCycleDifference;
    const g = p.dropIndex !== null && !d.isCombed;
    return (g ? "film" : "video") !== this.#k && (this.#k = g ? "film" : "video"), p.shouldDrop && !d.isCombed;
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Mt(e, t) {
    const i = this.#He();
    if (i === null) return;
    const A = this.#g[i];
    if (A) {
      for (this.#ee = i; this.#t.length > 0 && this.#t[0]?.slot === i; )
        this.#t.shift(), this.#E.late++;
      this.#Xe(A.framebuffer), this.#t.push({ slot: i, at: e, duration: t });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Xe(e, t = !0) {
    const i = this.#B, A = this.#fe;
    if (!i || !A) return;
    const s = this.#s, r = this.#w, o = (this.#w + D - 1) % D, n = (this.#w + 1) % D, c = this.#be;
    s.bindFramebuffer(s.FRAMEBUFFER, e), s.useProgram(i);
    for (const [a, f] of [n, o, r].entries())
      s.activeTexture(s.TEXTURE0 + a), s.bindTexture(s.TEXTURE_2D, this.#T[f] ?? null);
    s.uniform1i(A.prev, 0), s.uniform1i(A.cur, 1), s.uniform1i(A.next, 2), s.uniform2i(A.size, this.#p, this.#D), s.uniform1i(A.topFieldFirst, c ? 1 : 0), s.uniform1i(
      A.match,
      this.#te === "p" ? 0 : this.#te === "c" ? 1 : 2
    ), s.viewport(0, 0, this.#p, this.#D), s.drawArrays(s.TRIANGLES, 0, 3), e === null && (this.#f = { kind: "film" }, this.#R(!0), t && (this.#U++, I({
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
  #st(e, t, i) {
    const A = this.#He();
    if (A === null) return;
    const s = this.#g[A];
    if (s) {
      for (this.#ee = A; this.#t.length > 0 && this.#t[0]?.slot === A; )
        this.#t.shift(), this.#E.late++;
      this.#ce(!1, e, s.framebuffer), this.#t.push({ slot: A, at: t, duration: i });
    }
  }
  /** Make room without treating ordinary capacity pressure as clock divergence. */
  #At(e, t, i) {
    const A = this.#t.at(-1), s = (se + 1) * Math.max(this.#X, i);
    if (A && A.at - t > s)
      return this.#t.length = 0, this.#E.queueResetted++, !0;
    const r = Math.max(
      0,
      this.#t.length + e - se
    );
    let o = 0, n = 0;
    for (; n < r; ) {
      const c = this.#t.shift();
      if (!c) break;
      o += c.duration, n++;
    }
    for (const c of this.#t) c.at -= o;
    return this.#E.late += n, !1;
  }
  /** Select an output whose pixels are not still represented by the canvas or queue. */
  #He() {
    const e = this.#f?.kind === "texture" ? this.#f.texture : null, t = new Set(this.#t.map(({ slot: A }) => A));
    for (let A = 1; A <= L; A++) {
      const s = (this.#ee + A) % L, r = this.#g[s];
      if (r && r.texture !== e && !t.has(s))
        return s;
    }
    const i = this.#t[0];
    if (i) {
      const A = this.#g[i.slot];
      if (A && A.texture !== e) return i.slot;
    }
    return null;
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #J() {
    this.#_ === null && (!this.#c || this.#M || (this.#de = 0, this.#_ = this.#nt(this.#rt)));
  }
  #ze() {
    this.#_ !== null && this.#Ft(this.#_), this.#_ = null, this.#t.length = 0;
  }
  #rt = (e) => {
    if (this.#_ = null, !this.#c || this.#M) return;
    const t = this.#de > 0 ? e - this.#de : null;
    if (t !== null) {
      const i = t;
      i >= 1 && i <= te && (this.#X = i < this.#X ? i : this.#X + (i - this.#X) * Re);
    }
    this.#de = e, I({
      kind: "raf",
      atMs: e,
      gapMs: t,
      queueDepth: this.#t.length
    }), this.#A === "main" && this.#Ct(e), this.#_ = this.#nt(this.#rt);
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
    this.#h || this.#I !== null || !this.#c || this.#M || (this.#I = requestAnimationFrame(this.#at));
  }
  /** ページ側で予約済みのフレーム監視を取り消す。 */
  #Rt() {
    this.#I !== null && cancelAnimationFrame(this.#I), this.#I = null;
  }
  /** requestAnimationFrame() ごとにフレーム通知の停止を検査し、次の監視を予約する。 */
  #at = (e) => {
    this.#I = null, !(!this.#c || this.#M) && (this.#kt(e), this.#I = requestAnimationFrame(this.#at));
  };
  /** requestVideoFrameCallback() が来ない間も requestAnimationFrame() から復号フレームを取り込む。 */
  #kt(e) {
    if (this.#h || e - this.#pe < ke || this.#e.paused || this.#e.ended || this.#e.readyState < 2)
      return;
    const t = this.#e.currentTime, i = this.#e.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, A = this.#l >= ee ? this.#l : Ce, s = i > this.#Z, r = t !== this.#me && e - this.#Be >= A * 0.75;
    !s && !r || (this.#Z = Math.max(
      this.#Z,
      i
    ), this.#Be = e, this.#tt(e, {
      mediaTime: t,
      presentedFrames: Math.max(this.#N + 1, i),
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
    for (; this.#t[1] && this.#t[1].at <= t; )
      this.#E.late++, this.#t.shift();
    let i = this.#t[0];
    if (!i || i.at > t)
      return;
    this.#t.shift();
    const A = performance.now();
    this.#ot(i.slot);
    const s = performance.now();
    this.#oe += s - A, this.#ae++, I({
      kind: "draw-submit",
      atMs: s,
      rafAtMs: e,
      scheduledAtMs: i.at,
      queueDepthAfter: this.#t.length,
      path: "scheduled"
    });
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #ot(e) {
    const t = this.#g[e];
    t && this.#Ze(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #St() {
    this.#ht();
    const e = this.#T[this.#w];
    e && (this.#Ze(e, !0), I({
      kind: "draw-submit",
      atMs: performance.now(),
      rafAtMs: null,
      scheduledAtMs: null,
      queueDepthAfter: this.#t.length,
      path: "progressive"
    })), this.#a = 0;
  }
  /** DOM の visibility 変更はページ側に残し、Worker からは状態だけを通知する。 */
  #R(e) {
    if (this.#h) {
      this.#h.onVisibility(e);
      return;
    }
    this.#i.style.visibility = e ? "visible" : "hidden";
  }
  #Ze(e, t = !1, i = !0) {
    const A = this.#s;
    A.bindFramebuffer(A.FRAMEBUFFER, null), A.useProgram(this.#y), A.activeTexture(A.TEXTURE0), A.bindTexture(A.TEXTURE_2D, e), A.uniform1i(this.#W, 0), A.uniform1i(this.#O, t ? 1 : 0), A.viewport(0, 0, this.#p, this.#D), A.drawArrays(A.TRIANGLES, 0, 3), this.#f = { kind: "texture", texture: e, flip: t }, this.#R(!0), i && this.#U++;
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
    this.#N !== 0 && !t && (this.#E.missed += Math.max(0, e - this.#N - 1)), this.#N = e;
  }
  #Bt(e) {
    const t = e - this.#ve;
    if (t < oe) return;
    const i = this.#Te() && (this.#x || this.#k === "film") ? this.#ae : this.#G, A = {
      ...this.#E,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#e.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: i * 1e3 / t,
      frameMs: this.#G === 0 ? 0 : (this.#ne + this.#oe) / this.#G,
      maxQueuedFields: this.#q,
      mode: this.#k,
      match: this.#te,
      combScore: this.#Re,
      outputFps: this.#U * 1e3 / t,
      duplicateScore: this.#Se,
      duplicateRunnerUp: this.#Le
    };
    this.dispatchEvent(new CustomEvent("stats", { detail: A })), this.#_e?.(A), this.#ve = e, this.#G = 0, this.#ne = 0, this.#ae = 0, this.#oe = 0, this.#q = 0, this.#U = 0;
  }
  /** Take the newest frame into the ring. */
  #ht() {
    const e = this.#s;
    this.#w = (this.#w + 1) % D, e.bindTexture(e.TEXTURE_2D, this.#T[this.#w] ?? null), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#ge
    ), this.#a = Math.min(this.#a + 1, D);
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
  #ce(e, t, i, A = !0) {
    if (this.#a === 0 || this.#M) return;
    A && (this.#a === D && !e ? this.#E.filtered++ : this.#E.degraded++);
    const s = this.#s, r = this.#w, o = (this.#w + D - 1) % D, n = (this.#w + 1) % D;
    let c, a, f;
    this.#a === 1 ? c = a = f = r : e ? (c = o, a = f = r) : this.#a === 2 ? (c = a = o, f = r) : (c = n, a = o, f = r), s.bindFramebuffer(s.FRAMEBUFFER, i), s.useProgram(this.#b);
    for (const [l, d] of [c, a, f].entries())
      s.activeTexture(s.TEXTURE0 + l), s.bindTexture(s.TEXTURE_2D, this.#T[d] ?? null);
    s.uniform1i(this.#n.prev, 0), s.uniform1i(this.#n.cur, 1), s.uniform1i(this.#n.next, 2), s.uniform2i(this.#n.size, this.#p, this.#D);
    const u = this.#be ? 0 : 1;
    s.uniform1i(this.#n.parity, t ? 1 - u : u), s.uniform1i(this.#n.tff, this.#be ? 1 : 0), s.uniform1i(this.#n.spatialCheck, this.#Fe ? 1 : 0), s.viewport(0, 0, this.#p, this.#D), s.drawArrays(s.TRIANGLES, 0, 3), i === null && (this.#f = { kind: "yadif", flush: e, second: t }, this.#R(!0), A && (this.#U++, I({
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
  #xe() {
    if (!this.#H) return;
    const e = this.#e, t = e.videoWidth, i = e.videoHeight;
    if (t === 0 || i === 0) return;
    const A = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / i
    ), s = t * A, r = i * A;
    this.#i.style.left = `${e.offsetLeft + (e.offsetWidth - s) / 2}px`, this.#i.style.top = `${e.offsetTop + (e.offsetHeight - r) / 2}px`, this.#i.style.width = `${s}px`, this.#i.style.height = `${r}px`;
  }
  #lt(e, t) {
    const i = this.#s;
    this.#u.width = e, this.#u.height = t, this.#p = e, this.#D = t, this.#a = 0, this.#f = null, this.#v(), this.#xe();
    for (const A of this.#T) i.deleteTexture(A);
    this.#T = [];
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
      ), this.#T.push(s);
    }
    this.#K(), this.#Qe(), this.#m && this.#ct(), (this.#x || this.#m) && this.#je();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #ct() {
    if (this.#P) return;
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
    this.#P = {
      texture: t,
      framebuffer: i,
      pixels: new Uint8Array(x * M * 4),
      previousLuma: new Uint8Array(x * M),
      currentLuma: new Uint8Array(x * M),
      nextLuma: new Uint8Array(x * M)
    };
  }
  #Qe() {
    this.#P && (this.#s.deleteFramebuffer(this.#P.framebuffer), this.#s.deleteTexture(this.#P.texture), this.#P = null);
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
    if (!(this.#g.length === L || this.#p === 0)) {
      this.#K();
      for (let t = 0; t < L; t++) {
        const i = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, i), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#p,
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
          e.deleteFramebuffer(A), e.deleteTexture(i), this.#K();
          return;
        }
        this.#g.push({ texture: i, framebuffer: A });
      }
      this.#ee = L - 1;
    }
  }
  #K() {
    const e = this.#s, t = this.#f?.kind === "texture" ? this.#f.texture : null;
    this.#g.some((i) => i.texture === t) && (this.#f = null);
    for (const { texture: i, framebuffer: A } of this.#g)
      e.deleteFramebuffer(A), e.deleteTexture(i);
    this.#g = [], this.#t.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #Pt() {
    if (this.#H) return;
    const e = this.#e.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#e), t.appendChild(this.#e), t.appendChild(this.#i), this.#H = t, this.#Me?.observe(this.#e), this.#xe();
  }
  #_t() {
    if (this.#h) return;
    const e = this.#H;
    this.#H = null, this.#Me?.disconnect(), this.#i.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#e, e), e.remove());
  }
  #ut = () => this.#xe();
  /** media event と、その意味を決めたページ側の再生状態を Worker へ転送する。 */
  #Ve(e) {
    return !this.#r || this.#A === "main" ? !1 : (this.#r.postMessage({
      type: "event",
      name: e,
      video: this.#Oe()
    }), !0);
  }
  #ft = () => {
    if (this.#me = Number.NaN, this.#Ve("emptied")) {
      this.#C(), this.#R(!1);
      return;
    }
    this.#a = 0, this.#ie = 0, this.#t.length = 0, this.#l = 0, this.#dt(), this.#v(), this.#f = null, this.#R(!1);
  };
  #dt() {
    this.#E = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0
    }, this.#N = 0, this.#ve = 0, this.#Ne = 0, this.#G = 0, this.#ne = 0, this.#ae = 0, this.#oe = 0, this.#q = 0, this.#U = 0, this.#v();
  }
  /** Return FFmpeg's fieldmatch and decimate windows to their initial state. */
  #v() {
    this.#t.length = 0, this.#k = "video", this.#te = "c", this.#Re = 0, this.#ke = !0, this.#Ce.reset(), this.#Se = 1 / 0, this.#Le = 1 / 0;
  }
  /**
   * A new seek invalidates any destination frame remembered for the last one.
   */
  #mt = () => {
    if (this.#Ve("seeking")) {
      this.#C();
      return;
    }
    this.#se = !1;
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
      const i = this.#se;
      if (this.#se = !1, i) return;
      this.#a = 0, this.#v(), this.#f = null, this.#R(!1);
      return;
    }
    const t = e.type === "ratechange";
    if (t && (this.#l = 0, this.#ie = this.#e.currentTime), this.#t.length = 0, this.#c && this.#a > 0) {
      const i = this.#He(), A = i === null ? void 0 : this.#g[i];
      i !== null && A ? (this.#ee = i, this.#ce(!0, !1, A.framebuffer), this.#ot(i), I({
        kind: "draw-submit",
        atMs: performance.now(),
        rafAtMs: null,
        scheduledAtMs: null,
        queueDepthAfter: this.#t.length,
        path: "flush"
      })) : this.#ce(!0, !1, null);
    }
    t && (this.#a = 0, this.#v());
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
    this.#A !== "active" && (this.#M = !0, this.stop());
  };
}
function z(h, e) {
  const t = h.createProgram(), i = le(h, h.VERTEX_SHADER, Se), A = le(h, h.FRAGMENT_SHADER, e);
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
function _e(h = {}) {
  return Ae ??= Ie(h), Ae;
}
async function He(h = {}) {
  return (await _e(h)).deinterlaces;
}
function ze() {
  Ae = null;
}
async function Ie(h) {
  const e = h.tolerance ?? Be, t = h.timeoutMs ?? Pe, i = performance.now(), A = (o) => ({
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
    const o = j(Q(s, "loadeddata"), t), n = s.play().then(
      () => !0,
      () => !1
    );
    if (await r.ready, await o, await Ge(s, t, await n), s.videoWidth === 0 || s.videoHeight === 0)
      return A(new Error("the probe clip decoded to nothing"));
    const c = We(s);
    return {
      deinterlaces: c < 1 - e,
      survives: c,
      tookMs: performance.now() - i
    };
  } catch (o) {
    return A(o);
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
  const o = (async () => {
    await j(Q(s, "sourceopen"), e);
    const n = s.addSourceBuffer(fe), c = j(Q(n, "updateend"), e);
    n.appendBuffer(A), await c, s.endOfStream();
  })();
  return { url: r, ready: o };
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
  const A = i.getImageData(0, 0, U, e).data, s = (a) => {
    let f = 0;
    for (let u = 0; u < U; u++)
      f += A[(a * U + u) * 4 + 1] ?? 0;
    return f / U;
  };
  let r = 0;
  const o = 2, n = e - 3;
  let c = s(o);
  for (let a = o + 1; a <= n; a++) {
    const f = s(a);
    r += Math.abs(f - c), c = f;
  }
  return r / (n - o) / 255;
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
Te(we);
export {
  Xe as Deinterlacer,
  ve as FILM_ANALYSIS_FRAGMENT_SHADER,
  De as FILM_SAMPLE_FRAGMENT_SHADER,
  K as FILM_UNIFORMS,
  be as FILM_WEAVE_FRAGMENT_SHADER,
  Ee as YADIF_FRAGMENT_SHADER,
  ge as YADIF_UNIFORMS,
  He as decoderDeinterlaces,
  ze as forgetDecoderProbe,
  _e as probeDecoder,
  Oe as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
