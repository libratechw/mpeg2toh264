const R = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, C = `#version 300 es
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
`, S = 0.5, d = 3, f = 4, v = 1e3, B = 4, g = 200, k = 0.25, P = 0.2, I = 1e3 / 60, _ = 0.02, G = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, L = `#version 300 es
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
function O() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class Y {
  canvas;
  #A;
  #i;
  #R;
  #c;
  /** The program that copies a filtered picture onto the canvas. */
  #T;
  #Y;
  #j;
  #l = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #d = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #G = f - 1;
  /** Filtered fields waiting for their moment, oldest first. */
  #e = [];
  /** The rAF loop that puts them up, which is all that draws on the canvas. */
  #f = null;
  #C = 0;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #x = I;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #D = null;
  #L;
  #u;
  #h;
  #S;
  #V;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #r = 0;
  /** Where the media timeline was last pinned to the wall clock, and when. */
  #U = 0;
  #X = 0;
  #w = !1;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #a = 0;
  #m = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #p = d - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #t = 0;
  #B = 0;
  #E = null;
  #n = !1;
  #Z = !1;
  #s = null;
  #y = [];
  #v = !1;
  #W;
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #o = { filtered: 0, missed: 0, degraded: 0, discontinuities: 0, late: 0 };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #k = 0;
  #P = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #N = 0;
  #F = 0;
  #g = 0;
  constructor(A, t = {}) {
    this.#A = A, this.#u = t.topFieldFirst ?? !0, this.#h = t.doubleRate ?? !1, this.#S = Math.max(0, t.bufferFields ?? 1), this.#V = t.spatialCheck ?? !0, this.#W = t.onStats, this.canvas = document.createElement("canvas"), this.canvas.style.cssText = "position:absolute;pointer-events:none;visibility:hidden";
    const e = this.canvas.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!e) throw new Error("this browser has no WebGL2");
    this.#i = e, this.#R = b(e, C);
    const i = this.#R;
    this.#c = Object.fromEntries(
      Object.entries(R).map(([s, n]) => [
        s,
        e.getUniformLocation(i, n)
      ])
    ), this.#T = b(e, L), this.#Y = e.getUniformLocation(this.#T, "uField"), this.#j = e.getUniformLocation(this.#T, "uFlip"), this.canvas.addEventListener("webglcontextlost", this.#rA), this.#L = new ResizeObserver(() => this.#_()), A.addEventListener("emptied", this.#iA), A.addEventListener("resize", this.#tA), A.addEventListener("pause", this.#b), A.addEventListener("ended", this.#b), A.addEventListener("seeked", this.#b);
  }
  get running() {
    return this.#n && (this.#s?.interlaced ?? !0);
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#Z;
  }
  set enabled(A) {
    this.#Z = A, this.#H();
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(A) {
    this.#s = A, A && (this.#u = A.topFieldFirst), this.#H();
  }
  get scan() {
    return this.#s;
  }
  set videoTimeline(A) {
    this.#y = A, A.length === 0 && (this.#s = null), this.#H();
  }
  get videoTimeline() {
    return this.#y;
  }
  /**
   * What to put on the screen for fullscreen: the `<div>` holding both the
   * element and the canvas once there is one, and the element itself before
   * that. Fullscreening the element alone would leave the canvas behind in
   * the page, and with it the only deinterlaced picture there is.
   */
  get container() {
    return this.#D ?? this.#A;
  }
  /** Whether the top field of a frame is the one captured first. */
  get topFieldFirst() {
    return this.#u;
  }
  set topFieldFirst(A) {
    this.#u = A;
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#h;
  }
  set doubleRate(A) {
    A !== this.#h && (this.#h = A, A ? (this.#a > 0 && this.#eA(), this.#z()) : (this.#Q(), this.#M()));
  }
  /** How many field intervals of slack the field schedule is held back by. */
  get bufferFields() {
    return this.#S;
  }
  set bufferFields(A) {
    this.#S = Math.max(0, A);
  }
  #H() {
    this.#Z && (this.#y.length > 0 || (this.#s?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  start() {
    this.#n || this.#v || (this.#n = !0, this.#sA(), this.#mA(), this.#I(), (this.#s?.interlaced ?? !0) && this.#z());
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#n && (this.#n = !1, this.#E !== null && this.#A.cancelVideoFrameCallback(this.#E), this.#E = null, this.#Q(), this.#t = 0, this.#w = !1, this.canvas.style.visibility = "hidden");
  }
  destroy() {
    this.stop(), this.canvas.removeEventListener("webglcontextlost", this.#rA), this.#A.removeEventListener("emptied", this.#iA), this.#A.removeEventListener("resize", this.#tA), this.#A.removeEventListener("pause", this.#b), this.#A.removeEventListener("ended", this.#b), this.#A.removeEventListener("seeked", this.#b), this.#pA();
    for (const A of this.#l) this.#i.deleteTexture(A);
    this.#l = [], this.#M(), this.#i.deleteProgram(this.#R), this.#i.deleteProgram(this.#T), this.#i.getExtension("WEBGL_lose_context")?.loseContext();
  }
  #I() {
    !this.#n || this.#E !== null || (this.#E = this.#A.requestVideoFrameCallback(this.#nA));
  }
  #nA = (A, t) => {
    if (this.#E = null, !(!this.#n || this.#v)) {
      if (this.#hA(t.mediaTime), t.width > 0 && t.height > 0) {
        if ((this.#a === 0 || this.#m === 0) && this.#AA(t.width, t.height), this.#s && !this.#s.interlaced) {
          this.#fA(), this.#I();
          return;
        }
        const e = t.mediaTime - this.#B, i = e < 0 || e > S;
        if (i && (this.#t = 0, this.#o.discontinuities++, this.#e.length = 0, this.#w = !1), this.#uA(t.presentedFrames, i), this.#t > 0 && t.mediaTime === this.#B) {
          this.#I();
          return;
        }
        !i && e > 0 && this.#oA(e), this.#B = t.mediaTime;
        const s = performance.now();
        if (s - this.#N > v && (this.#P = s, this.#F = 0, this.#g = 0), this.#N = s, this.#$(), this.#aA()) {
          const n = this.#r / 2, a = this.#cA(t.mediaTime, t.expectedDisplayTime) + (1 + this.#S) * n;
          this.#J(!1, a), this.#J(!0, a + n);
        } else
          this.#O(!1, !1, null);
        this.#g += performance.now() - s, this.#F++, this.#wA(s);
      }
      this.#I();
    }
  };
  #hA(A) {
    let t;
    for (let i = this.#y.length - 1; i >= 0; i--) {
      const s = this.#y[i];
      if (s.start <= A + 1e-6) {
        t = s;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#a || t.codedSize.height !== this.#m) && this.#AA(t.codedSize.width, t.codedSize.height);
    const e = t?.scan;
    !e || this.#s?.interlaced === e.interlaced && this.#s.topFieldFirst === e.topFieldFirst || (this.#s = e, this.#u = e.topFieldFirst, this.#t = 0, this.#e.length = 0, this.#w = !1, e.interlaced ? this.#h && this.#z() : this.#Q());
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #aA() {
    return this.#h && this.#r > 0 && this.#d.length === f;
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
  #oA(A) {
    const t = A * 1e3 / (this.#A.playbackRate || 1), e = this.#r > 0 ? Math.max(1, Math.round(t / this.#r)) : 1, i = t / e;
    i < B || i > g || (this.#r = this.#r > 0 ? this.#r + (i - this.#r) * k : i);
  }
  /**
   * When this frame reaches the screen, from a clock that is pulled towards
   * what each frame says rather than set by it.
   *
   * `expectedDisplayTime` is an estimate, and it moves about by a refresh or
   * so either way even while playback is perfectly steady. Hanging two fields
   * off it directly passes that movement to the screen, which is exactly the
   * unevenness a picture for every field is meant to remove; running a clock
   * of the media timeline and correcting a fifth of the error each frame
   * keeps the fields evenly spaced while still following the element. An
   * error of more than a whole frame is not drift -- the element is
   * presenting from somewhere else, or at a rate it was not at before -- and
   * the clock goes straight there, taking the fields timed by the old one
   * with it.
   */
  #cA(A, t) {
    if (!this.#w)
      return this.#w = !0, this.#U = A, this.#X = t, t;
    const e = this.#A.playbackRate || 1, i = this.#X + (A - this.#U) * 1e3 / e, s = t - i;
    let n;
    return Math.abs(s) > this.#r ? (n = t, this.#o.late += this.#e.length, this.#e.length = 0) : n = i + s * P, this.#U = A, this.#X = n, n;
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #J(A, t) {
    const e = (this.#G + 1) % f, i = this.#d[e];
    if (i) {
      for (this.#G = e; this.#e.length > 0 && this.#e[0]?.slot === e; )
        this.#e.shift(), this.#o.late++;
      this.#O(!1, A, i.framebuffer), this.#e.push({ slot: e, at: t });
    }
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #z() {
    this.#f === null && (!this.#n || this.#v || !this.#h || (this.#C = 0, this.#f = requestAnimationFrame(this.#K)));
  }
  #Q() {
    this.#f !== null && cancelAnimationFrame(this.#f), this.#f = null, this.#e.length = 0;
  }
  #K = (A) => {
    if (this.#f = null, !(!this.#n || this.#v || !this.#h)) {
      if (this.#C > 0) {
        const t = A - this.#C;
        t >= 1 && t <= g && (this.#x = t < this.#x ? t : this.#x + (t - this.#x) * _);
      }
      this.#C = A, this.#lA(A), this.#f = requestAnimationFrame(this.#K);
    }
  };
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
  #lA(A) {
    const t = A + this.#x * 1.5;
    if ((this.#e[0]?.at ?? 1 / 0) > t) return;
    let e = this.#e.shift();
    for (; (this.#e[0]?.at ?? 1 / 0) <= t; )
      this.#o.late++, e = this.#e.shift();
    if (!e) return;
    const i = performance.now();
    this.#dA(e.slot), this.#g += performance.now() - i;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #dA(A) {
    const t = this.#d[A];
    t && this.#q(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #fA() {
    this.#$();
    const A = this.#l[this.#p];
    A && this.#q(A, !0), this.#t = 0;
  }
  #q(A, t = !1) {
    const e = this.#i;
    e.bindFramebuffer(e.FRAMEBUFFER, null), e.useProgram(this.#T), e.activeTexture(e.TEXTURE0), e.bindTexture(e.TEXTURE_2D, A), e.uniform1i(this.#Y, 0), e.uniform1i(this.#j, t ? 1 : 0), e.viewport(0, 0, this.#a, this.#m), e.drawArrays(e.TRIANGLES, 0, 3), this.canvas.style.visibility = "visible";
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
  #uA(A, t) {
    this.#k !== 0 && !t && (this.#o.missed += Math.max(0, A - this.#k - 1)), this.#k = A;
  }
  #wA(A) {
    if (!this.#W) return;
    const t = A - this.#P;
    if (t < v) return;
    const e = this.#F;
    this.#W({
      ...this.#o,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#A.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: e * 1e3 / t,
      frameMs: e === 0 ? 0 : this.#g / e
    }), this.#P = A, this.#F = 0, this.#g = 0;
  }
  /** Take the newest frame into the ring. */
  #$() {
    const A = this.#i;
    this.#p = (this.#p + 1) % d, A.bindTexture(A.TEXTURE_2D, this.#l[this.#p] ?? null), A.texSubImage2D(
      A.TEXTURE_2D,
      0,
      0,
      0,
      A.RGBA,
      A.UNSIGNED_BYTE,
      this.#A
    ), this.#t = Math.min(this.#t + 1, d);
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
  #O(A, t, e) {
    if (this.#t === 0 || this.#v) return;
    this.#t === d && !A ? this.#o.filtered++ : this.#o.degraded++;
    const i = this.#i, s = this.#p, n = (this.#p + d - 1) % d, a = (this.#p + 1) % d;
    let h, o, c;
    this.#t === 1 ? h = o = c = s : A ? (h = n, o = c = s) : this.#t === 2 ? (h = o = n, c = s) : (h = a, o = n, c = s), i.bindFramebuffer(i.FRAMEBUFFER, e), i.useProgram(this.#R);
    for (const [w, M] of [h, o, c].entries())
      i.activeTexture(i.TEXTURE0 + w), i.bindTexture(i.TEXTURE_2D, this.#l[M] ?? null);
    i.uniform1i(this.#c.prev, 0), i.uniform1i(this.#c.cur, 1), i.uniform1i(this.#c.next, 2), i.uniform2i(this.#c.size, this.#a, this.#m);
    const l = this.#u ? 0 : 1;
    i.uniform1i(this.#c.parity, t ? 1 - l : l), i.uniform1i(this.#c.tff, this.#u ? 1 : 0), i.uniform1i(this.#c.spatialCheck, this.#V ? 1 : 0), i.viewport(0, 0, this.#a, this.#m), i.drawArrays(i.TRIANGLES, 0, 3), e === null && (this.canvas.style.visibility = "visible");
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
  #_() {
    if (!this.#D) return;
    const A = this.#A, t = A.videoWidth, e = A.videoHeight;
    if (t === 0 || e === 0) return;
    const i = Math.min(
      A.offsetWidth / t,
      A.offsetHeight / e
    ), s = t * i, n = e * i;
    this.canvas.style.left = `${A.offsetLeft + (A.offsetWidth - s) / 2}px`, this.canvas.style.top = `${A.offsetTop + (A.offsetHeight - n) / 2}px`, this.canvas.style.width = `${s}px`, this.canvas.style.height = `${n}px`;
  }
  #AA(A, t) {
    const e = this.#i;
    this.canvas.width = A, this.canvas.height = t, this.#a = A, this.#m = t, this.#t = 0, this.#_();
    for (const i of this.#l) e.deleteTexture(i);
    this.#l = [];
    for (let i = 0; i < d; i++) {
      const s = e.createTexture();
      e.bindTexture(e.TEXTURE_2D, s), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
        e.TEXTURE_2D,
        0,
        e.RGBA,
        A,
        t,
        0,
        e.RGBA,
        e.UNSIGNED_BYTE,
        null
      ), this.#l.push(s);
    }
    this.#M(), this.#h && this.#eA();
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
  #eA() {
    const A = this.#i;
    if (!(this.#d.length === f || this.#a === 0)) {
      this.#M();
      for (let t = 0; t < f; t++) {
        const e = A.createTexture();
        A.bindTexture(A.TEXTURE_2D, e), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_MIN_FILTER, A.NEAREST), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_MAG_FILTER, A.NEAREST), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_WRAP_S, A.CLAMP_TO_EDGE), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_WRAP_T, A.CLAMP_TO_EDGE), A.texImage2D(
          A.TEXTURE_2D,
          0,
          A.RGBA,
          this.#a,
          this.#m,
          0,
          A.RGBA,
          A.UNSIGNED_BYTE,
          null
        );
        const i = A.createFramebuffer();
        A.bindFramebuffer(A.FRAMEBUFFER, i), A.framebufferTexture2D(
          A.FRAMEBUFFER,
          A.COLOR_ATTACHMENT0,
          A.TEXTURE_2D,
          e,
          0
        );
        const s = A.checkFramebufferStatus(A.FRAMEBUFFER) === A.FRAMEBUFFER_COMPLETE;
        if (A.bindFramebuffer(A.FRAMEBUFFER, null), !s) {
          A.deleteFramebuffer(i), A.deleteTexture(e), this.#M();
          return;
        }
        this.#d.push({ texture: e, framebuffer: i });
      }
      this.#G = f - 1;
    }
  }
  #M() {
    const A = this.#i;
    for (const { texture: t, framebuffer: e } of this.#d)
      A.deleteFramebuffer(e), A.deleteTexture(t);
    this.#d = [], this.#e.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #mA() {
    if (this.#D) return;
    const A = this.#A.parentElement;
    if (!A) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", A.insertBefore(t, this.#A), t.appendChild(this.#A), t.appendChild(this.canvas), this.#D = t, this.#L.observe(this.#A), this.#_();
  }
  #pA() {
    const A = this.#D;
    this.#D = null, this.#L.disconnect(), this.canvas.remove(), A?.parentElement && (A.parentElement.insertBefore(this.#A, A), A.remove());
  }
  #tA = () => this.#_();
  #iA = () => {
    this.#t = 0, this.#B = 0, this.#e.length = 0, this.#w = !1, this.#r = 0, this.#sA(), this.canvas.style.visibility = "hidden";
  };
  #sA() {
    this.#o = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0
    }, this.#k = 0, this.#P = 0, this.#N = 0, this.#F = 0, this.#g = 0;
  }
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #b = () => {
    this.#e.length = 0, this.#w = !1, this.#n && this.#O(!0, !1, null);
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #rA = (A) => {
    A.preventDefault(), this.#v = !0, this.stop();
  };
}
function b(r, A) {
  const t = r.createProgram(), e = T(r, r.VERTEX_SHADER, G), i = T(r, r.FRAGMENT_SHADER, A);
  if (r.attachShader(t, e), r.attachShader(t, i), r.linkProgram(t), r.deleteShader(e), r.deleteShader(i), !r.getProgramParameter(t, r.LINK_STATUS)) {
    const s = r.getProgramInfoLog(t);
    throw r.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${s ?? "no reason given"}`
    );
  }
  return t;
}
function T(r, A, t) {
  const e = r.createShader(A);
  if (!e) throw new Error("the deinterlacer could not create a shader");
  if (r.shaderSource(e, t), r.compileShader(e), !r.getShaderParameter(e, r.COMPILE_STATUS)) {
    const i = r.getShaderInfoLog(e);
    throw r.deleteShader(e), new Error(
      `the deinterlacer failed to compile: ${i ?? "no reason given"}`
    );
  }
  return e;
}
const x = "data:video/mp4;base64,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AwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", U = 0.5, X = 3e3, y = 0.1, u = 16, F = 'video/mp4; codecs="avc1.640029"';
let E = null;
function Z(r = {}) {
  return E ??= W(r), E;
}
async function j(r = {}) {
  return (await Z(r)).deinterlaces;
}
function V() {
  E = null;
}
async function W(r) {
  const A = r.tolerance ?? U, t = r.timeoutMs ?? X, e = performance.now(), i = (a) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - e,
    error: a instanceof Error ? a.message : String(a)
  });
  if (typeof document > "u")
    return i(new Error("there is no document to decode in"));
  const s = document.createElement("video");
  s.muted = !0, s.defaultMuted = !0, s.playsInline = !0, s.preload = "auto";
  let n = null;
  try {
    n = H(s, t);
    const a = p(m(s, "loadeddata"), t), h = s.play().then(
      () => !0,
      () => !1
    );
    if (await n.ready, await a, await z(s, t, await h), s.videoWidth === 0 || s.videoHeight === 0)
      return i(new Error("the probe clip decoded to nothing"));
    const o = Q(s);
    return {
      deinterlaces: o < 1 - A,
      survives: o,
      tookMs: performance.now() - e
    };
  } catch (a) {
    return i(a);
  } finally {
    s.pause(), s.removeAttribute("src"), s.replaceChildren(), s.load(), n && URL.revokeObjectURL(n.url);
  }
}
const D = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, N = typeof MediaSource > "u";
function H(r, A) {
  if (!D || !D.isTypeSupported(F))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = x.indexOf(","), e = atob(x.slice(t + 1)), i = new Uint8Array(e.length);
  for (let h = 0; h < e.length; h++) i[h] = e.charCodeAt(h);
  const s = new D(), n = URL.createObjectURL(s);
  if (N) {
    r.disableRemotePlayback = !0;
    const h = document.createElement("source");
    h.type = "video/mp4", h.src = n, r.append(h), r.load();
  } else
    r.src = n;
  const a = (async () => {
    await p(m(s, "sourceopen"), A);
    const h = s.addSourceBuffer(F), o = p(m(h, "updateend"), A);
    h.appendBuffer(i), await o, s.endOfStream();
  })();
  return { url: n, ready: a };
}
async function z(r, A, t) {
  if (t) {
    const e = performance.now();
    for (; r.currentTime < y && performance.now() - e < A; )
      await new Promise((i) => requestAnimationFrame(i));
    r.pause();
  } else
    r.currentTime = y, await p(m(r, "seeked"), A);
}
function Q(r) {
  const A = r.videoHeight, t = document.createElement("canvas");
  t.width = u, t.height = A;
  const e = t.getContext("2d", { willReadFrequently: !0 });
  if (!e) throw new Error("there is no 2d context to read the clip with");
  e.imageSmoothingEnabled = !1, e.drawImage(r, 0, 0, u, A);
  const i = e.getImageData(0, 0, u, A).data, s = (c) => {
    let l = 0;
    for (let w = 0; w < u; w++)
      l += i[(c * u + w) * 4 + 1] ?? 0;
    return l / u;
  };
  let n = 0;
  const a = 2, h = A - 3;
  let o = s(a);
  for (let c = a + 1; c <= h; c++) {
    const l = s(c);
    n += Math.abs(l - o), o = l;
  }
  return n / (h - a) / 255;
}
function m(r, A) {
  return new Promise((t, e) => {
    r.addEventListener(A, () => t(), { once: !0 }), r.addEventListener(
      "error",
      () => {
        const i = r instanceof HTMLMediaElement ? r.error : null, s = i ? ` (MediaError ${i.code}${i.message ? `: ${i.message}` : ""})` : "";
        e(new Error(`the probe clip ${A} failed${s}`));
      },
      { once: !0 }
    );
  });
}
function p(r, A) {
  return Promise.race([
    r,
    new Promise(
      (t, e) => setTimeout(
        () => e(new Error("the probe clip took too long")),
        A
      )
    )
  ]);
}
export {
  Y as Deinterlacer,
  C as YADIF_FRAGMENT_SHADER,
  R as YADIF_UNIFORMS,
  j as decoderDeinterlaces,
  V as forgetDecoderProbe,
  Z as probeDecoder,
  O as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
