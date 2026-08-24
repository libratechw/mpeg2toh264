const z = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck"
}, X = `#version 300 es
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
`, C = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  topFieldFirst: "uTopFieldFirst",
  match: "uMatch"
}, H = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uNext;
uniform ivec2 uSize;
uniform int uTopFieldFirst;

out vec4 fragColor;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

vec3 candidate(int x, int y, int match) {
  // fieldmatch keeps the opposite rows from the current frame and borrows the
  // selected field from its neighbour: odd rows for TFF and even rows for BFF.
  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;
  if ((y & 1) != borrowedParity || match == 1) {
    return texelFetch(uCur, ivec2(x, y), 0).rgb;
  }
  return match == 0
    ? texelFetch(uPrev, ivec2(x, y), 0).rgb
    : texelFetch(uNext, ivec2(x, y), 0).rgb;
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

float reducedCandidate(int x, int y, int match, ivec2 targetSize) {
  int sourceX = clamp(x * uSize.x / targetSize.x, 0, uSize.x - 1);
  return luma(candidate(sourceX, sourceY(y, targetSize.y), match));
}

float comb(int x, int y, int match, ivec2 targetSize) {
  // Apply the comb mask after the field-aware reduction. The three-row block
  // test in JavaScript can then use neighbouring target rows on the same scale
  // as FFmpeg's field-aware validation image.
  float minus2 = reducedCandidate(x, max(0, y - 2), match, targetSize);
  float minus1 = reducedCandidate(x, max(0, y - 1), match, targetSize);
  float pixel = reducedCandidate(x, y, match, targetSize);
  float plus1 = reducedCandidate(x, min(targetSize.y - 1, y + 1), match, targetSize);
  float plus2 = reducedCandidate(x, min(targetSize.y - 1, y + 2), match, targetSize);
  float threshold = 9.0 / 255.0;
  float vertical = abs(4.0 * pixel - 3.0 * (minus1 + plus1) + minus2 + plus2);
  return abs(pixel - minus1) > threshold &&
         abs(pixel - plus1) > threshold &&
         vertical > threshold * 6.0 ? 1.0 : 0.0;
}

void main() {
  ivec2 targetSize = ivec2(160, 90);
  ivec2 target = ivec2(gl_FragCoord.xy);
  int y = targetSize.y - 1 - target.y;
  fragColor = vec4(
    comb(target.x, y, 0, targetSize),
    comb(target.x, y, 1, targetSize),
    comb(target.x, y, 2, targetSize),
    1.0
  );
}
`, W = `#version 300 es
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
`, Y = `#version 300 es
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
  ivec2 targetSize = ivec2(160, 90);
  ivec2 target = ivec2(gl_FragCoord.xy);
  int x = clamp(target.x * uSize.x / targetSize.x, 0, uSize.x - 1);
  int targetY = targetSize.y - 1 - target.y;
  // Reduce the top and bottom fields independently, preserving both parities
  // in the cadence sample for any even source-to-target height ratio.
  int parity = targetY & 1;
  int fieldY = (targetY / 2) * (uSize.y / 2) / (targetSize.y / 2);
  int y = clamp(fieldY * 2 + parity, 0, uSize.y - 1);
  // Keep this reduced candidate identical to the full-size weave so duplicate
  // scores describe the picture that the renderer will actually present.
  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;
  if ((y & 1) != borrowedParity || uMatch == 1) {
    fragColor = texelFetch(uCur, ivec2(x, y), 0);
  } else if (uMatch == 0) {
    fragColor = texelFetch(uPrev, ivec2(x, y), 0);
  } else {
    fragColor = texelFetch(uNext, ivec2(x, y), 0);
  }
}
`, O = 0.5, f = 3, D = 4, w = 160, E = 90, I = 10, Z = 1, Q = 80, j = 255 * 0.011, B = 1e3, V = 4, L = 200, J = 0.25, K = 0.2, q = 1e3 / 60, $ = 0.02, ee = `#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`, Ae = `#version 300 es
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
function ce() {
  return typeof HTMLVideoElement < "u" && "requestVideoFrameCallback" in HTMLVideoElement.prototype && typeof WebGL2RenderingContext < "u";
}
class le {
  canvas;
  #t;
  #A;
  #Y;
  #g;
  /** The program that copies a filtered picture onto the canvas. */
  #_;
  #me;
  #pe;
  /** The reduced pass that scores the three possible film field matches. */
  #P = null;
  #we = null;
  /** The pass that weaves the selected pair of fields into one film picture. */
  #I = null;
  #ge = null;
  #B = null;
  #Ee = null;
  #D = null;
  #u = [];
  /** Somewhere to filter a field into, and to read it back out of. */
  #E = [];
  /** Which output slot was written last; the next one follows round the ring. */
  #L = D - 1;
  /** Filtered fields waiting for their moment, oldest first. */
  #e = [];
  /** The rAF loop that puts them up, which is all that draws on the canvas. */
  #T = null;
  #O = 0;
  /** The gap between animation frames: as near as the page gets to the screen. */
  #U = q;
  /** The `<div>` this put around the element, so it can be taken away again. */
  #x = null;
  #te;
  #o;
  #c;
  #s;
  #k;
  #G;
  #ve;
  #v = "video";
  #N = "c";
  #Z = 0;
  #Q = 0;
  #j = 0;
  #V = 0;
  #ie = 0;
  #b = null;
  #z = [];
  #se = 1 / 0;
  #re = 1 / 0;
  #p = 0;
  #X = 0;
  /** How long a frame lasts in wall time, from what the frames themselves say. */
  #r = 0;
  /** Where the media timeline was last pinned to the wall clock, and when. */
  #ne = 0;
  #he = 0;
  #w = !1;
  /** The size of a frame as it is coded, which is what a texture holds. */
  #h = 0;
  #l = 0;
  /** Where the newest frame is. The two before it follow round the ring. */
  #a = f - 1;
  /** How many of the held frames are consecutive, up to HISTORY. */
  #i = 0;
  #J = 0;
  #F = null;
  #f = !1;
  #ae = !1;
  #n = null;
  #H = [];
  #y = !1;
  #oe;
  /** Everything the next report is counted from. See DeinterlaceStats. */
  #d = { filtered: 0, missed: 0, degraded: 0, discontinuities: 0, late: 0 };
  /** `presentedFrames` of the last frame the callback saw; 0 before any. */
  #R = 0;
  #K = 0;
  /** When the last frame the filter took arrived, to see the gaps between. */
  #ce = 0;
  #W = 0;
  #M = 0;
  constructor(e, t = {}) {
    this.#t = e, this.#o = t.topFieldFirst ?? !0, this.#c = t.doubleRate ?? !1, this.#s = t.autoFilm ?? !1, this.#k = Math.max(
      0,
      t.filmCombThreshold ?? Q
    ), this.#G = Math.max(0, t.bufferFields ?? 1), this.#ve = t.spatialCheck ?? !0, this.#oe = t.onStats, this.canvas = document.createElement("canvas"), this.canvas.style.cssText = "position:absolute;pointer-events:none;visibility:hidden";
    const A = this.canvas.getContext("webgl2", {
      alpha: !1,
      antialias: !1,
      depth: !1,
      stencil: !1,
      preserveDrawingBuffer: !1,
      powerPreference: "high-performance"
    });
    if (!A) throw new Error("this browser has no WebGL2");
    this.#A = A, this.#Y = b(A, X);
    const i = this.#Y;
    this.#g = Object.fromEntries(
      Object.entries(z).map(([r, s]) => [
        r,
        A.getUniformLocation(i, s)
      ])
    ), this.#_ = b(A, Ae), this.#me = A.getUniformLocation(this.#_, "uField"), this.#pe = A.getUniformLocation(this.#_, "uFlip"), this.#s && this.#xe(), this.canvas.addEventListener("webglcontextlost", this.#Ie), this.#te = new ResizeObserver(() => this.#Ae()), e.addEventListener("emptied", this.#_e), e.addEventListener("resize", this.#Ce), e.addEventListener("pause", this.#C), e.addEventListener("ended", this.#C), e.addEventListener("seeked", this.#C);
  }
  get running() {
    return this.#f && (this.#n?.interlaced ?? !0);
  }
  /** Whether the caller wants filtering, independently of the current source. */
  get enabled() {
    return this.#ae;
  }
  set enabled(e) {
    this.#ae = e, this.#le();
  }
  /** Update whether the source needs filtering and which field comes first. */
  set scan(e) {
    const t = this.#n?.interlaced !== e?.interlaced || this.#n?.topFieldFirst !== e?.topFieldFirst;
    this.#n = e, e && (this.#o = e.topFieldFirst), t && (this.#i = 0, this.#m()), this.#le();
  }
  get scan() {
    return this.#n;
  }
  set videoTimeline(e) {
    this.#H = e, e.length === 0 && (this.#n = null), this.#le();
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
    return this.#x ?? this.#t;
  }
  /** Whether the top field of a frame is the one captured first. */
  get topFieldFirst() {
    return this.#o;
  }
  set topFieldFirst(e) {
    e !== this.#o && (this.#o = e, this.#i = 0, this.#m());
  }
  /** Whether a picture goes up for every field rather than every frame. */
  get doubleRate() {
    return this.#c;
  }
  set doubleRate(e) {
    e !== this.#c && (this.#c = e, this.#e.length = 0, this.#w = !1, e ? (this.#h > 0 && this.#de(), (this.#n?.interlaced ?? !0) && this.#$()) : this.#s || (this.#ee(), this.#S()));
  }
  /** Whether hard-telecined material is reconstructed at film cadence. */
  get autoFilm() {
    return this.#s;
  }
  set autoFilm(e) {
    e !== this.#s && (this.#s = e, this.#m(), e ? (this.#xe(), this.#h > 0 && (this.#Se(), this.#de()), (this.#n?.interlaced ?? !0) && this.#$()) : (this.#fe(), this.#c || (this.#ee(), this.#S())));
  }
  /** The combed-pixel boundary between clean field matches and field motion. */
  get filmCombThreshold() {
    return this.#k;
  }
  set filmCombThreshold(e) {
    this.#k = Math.max(0, e), this.#s && this.#m();
  }
  /** How many field intervals of slack the field schedule is held back by. */
  get bufferFields() {
    return this.#G;
  }
  set bufferFields(e) {
    this.#G = Math.max(0, e);
  }
  #le() {
    this.#ae && (this.#H.length > 0 || (this.#n?.interlaced ?? !0)) ? this.start() : this.stop();
  }
  start() {
    this.#f || this.#y || (this.#f = !0, this.#Pe(), this.#Oe(), this.#q(), (this.#n?.interlaced ?? !0) && this.#$());
  }
  /** Take the deinterlaced picture away, leaving the element's own showing. */
  stop() {
    this.#f && (this.#f = !1, this.#F !== null && this.#t.cancelVideoFrameCallback(this.#F), this.#F = null, this.#ee(), this.#i = 0, this.#w = !1, this.canvas.style.visibility = "hidden");
  }
  destroy() {
    this.stop(), this.canvas.removeEventListener("webglcontextlost", this.#Ie), this.#t.removeEventListener("emptied", this.#_e), this.#t.removeEventListener("resize", this.#Ce), this.#t.removeEventListener("pause", this.#C), this.#t.removeEventListener("ended", this.#C), this.#t.removeEventListener("seeked", this.#C), this.#Ze();
    for (const e of this.#u) this.#A.deleteTexture(e);
    this.#u = [], this.#S(), this.#fe(), this.#A.deleteProgram(this.#Y), this.#A.deleteProgram(this.#_), this.#P && this.#A.deleteProgram(this.#P), this.#I && this.#A.deleteProgram(this.#I), this.#B && this.#A.deleteProgram(this.#B), this.#A.getExtension("WEBGL_lose_context")?.loseContext();
  }
  #q() {
    !this.#f || this.#F !== null || (this.#F = this.#t.requestVideoFrameCallback(this.#Be));
  }
  #Be = (e, t) => {
    if (this.#F = null, !(!this.#f || this.#y)) {
      if (this.#Le(t.mediaTime), t.width > 0 && t.height > 0) {
        if ((this.#h === 0 || this.#l === 0) && this.#Me(t.width, t.height), this.#n && !this.#n.interlaced) {
          this.#He(), this.#q();
          return;
        }
        const A = t.mediaTime - this.#J, i = A < 0 || A > O;
        i && (this.#i = 0, this.#d.discontinuities++, this.#e.length = 0, this.#w = !1, this.#m());
        const r = this.#s && this.#R !== 0 && t.presentedFrames - this.#R > 1;
        if (this.#We(t.presentedFrames, i), !i && r && (this.#i = 0, this.#m()), this.#i > 0 && t.mediaTime === this.#J) {
          this.#q();
          return;
        }
        !i && A > 0 && this.#Ue(A), this.#J = t.mediaTime;
        const s = performance.now();
        if (s - this.#ce > B && (this.#K = s, this.#W = 0, this.#M = 0), this.#ce = s, this.#Re(), this.#s && this.#i === f && this.#ke(), this.#v === "film" && this.#i === f && this.#De()) {
          const a = this.#Te(t.mediaTime, t.expectedDisplayTime) + this.#r * (1 + this.#G / 2), h = this.#V % 5 === this.#ie, c = this.#r / 2;
          (this.#p === 0 || this.#p < a - c || this.#p > a + this.#r + c) && (this.#p = a + (h ? this.#r : 0)), h || (this.#Ge(this.#p), this.#p += this.#r * 5 / 4);
        } else if (this.#c && this.#De()) {
          const a = this.#r / 2, h = this.#Te(t.mediaTime, t.expectedDisplayTime) + (1 + this.#G) * a;
          this.#be(!1, h), this.#be(!0, h + a);
        } else
          this.#ue(!1, !1, null);
        this.#M += performance.now() - s, this.#W++, this.#Ye(s);
      }
      this.#q();
    }
  };
  #Le(e) {
    let t;
    for (let i = this.#H.length - 1; i >= 0; i--) {
      const r = this.#H[i];
      if (r.start <= e + 1e-6) {
        t = r;
        break;
      }
    }
    t?.codedSize && (t.codedSize.width !== this.#h || t.codedSize.height !== this.#l) && this.#Me(t.codedSize.width, t.codedSize.height);
    const A = t?.scan;
    !A || this.#n?.interlaced === A.interlaced && this.#n.topFieldFirst === A.topFieldFirst || (this.#n = A, this.#o = A.topFieldFirst, this.#i = 0, this.#e.length = 0, this.#w = !1, this.#m(), A.interlaced ? (this.#c || this.#s) && this.#$() : this.#ee());
  }
  /**
   * Whether fields are being filtered ahead of time and queued, rather than
   * drawn as their frame arrives.
   *
   * A picture for every frame has nothing to schedule -- there is one of them
   * and it goes up now -- and neither has a filter that has yet to see two
   * frames go by, since until then there is no idea how long a frame lasts.
   */
  #De() {
    return (this.#c || this.#s) && this.#r > 0 && this.#E.length === D;
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
  #Ue(e) {
    const t = e * 1e3 / (this.#t.playbackRate || 1), A = this.#r > 0 ? Math.max(1, Math.round(t / this.#r)) : 1, i = t / A;
    i < V || i > L || (this.#r = this.#r > 0 ? this.#r + (i - this.#r) * J : i);
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
  #Te(e, t) {
    if (!this.#w)
      return this.#w = !0, this.#ne = e, this.#he = t, t;
    const A = this.#t.playbackRate || 1, i = this.#he + (e - this.#ne) * 1e3 / A, r = t - i;
    let s;
    return Math.abs(r) > this.#r ? (s = t, this.#d.late += this.#e.length, this.#e.length = 0) : s = i + r * K, this.#ne = e, this.#he = s, s;
  }
  /** Build the optional film passes only for callers that enable them. */
  #xe() {
    if (this.#P && this.#I && this.#B) return;
    const e = this.#A, t = b(e, H), A = b(e, W), i = b(e, Y);
    this.#P = t, this.#we = Object.fromEntries(
      Object.entries(C).filter(([r]) => r !== "match").map(([r, s]) => [r, e.getUniformLocation(t, s)])
    ), this.#I = A, this.#ge = Object.fromEntries(
      Object.entries(C).map(([r, s]) => [
        r,
        e.getUniformLocation(A, s)
      ])
    ), this.#B = i, this.#Ee = Object.fromEntries(
      Object.entries(C).map(([r, s]) => [
        r,
        e.getUniformLocation(i, s)
      ])
    );
  }
  /**
   * Select the least-combed p/c/n field match and update the render mode.
   *
   * The analysis target is deliberately small, but every sample compares
   * adjacent source lines. This keeps the comb measurement sensitive to the
   * interlaced structure while reducing the synchronous GPU readback to a
   * fixed 160 by 90 buffer.
   */
  #ke() {
    const e = this.#D, t = this.#P, A = this.#we, i = this.#B, r = this.#Ee;
    if (!e || !t || !A || !i || !r)
      return;
    const s = this.#A, a = this.#a, h = (this.#a + f - 1) % f, c = (this.#a + 1) % f;
    s.bindFramebuffer(s.FRAMEBUFFER, e.framebuffer), s.useProgram(t);
    for (const [o, u] of [c, h, a].entries())
      s.activeTexture(s.TEXTURE0 + o), s.bindTexture(s.TEXTURE_2D, this.#u[u] ?? null);
    s.uniform1i(A.prev, 0), s.uniform1i(A.cur, 1), s.uniform1i(A.next, 2), s.uniform2i(A.size, this.#h, this.#l), s.uniform1i(A.topFieldFirst, this.#o ? 1 : 0), s.viewport(0, 0, w, E), s.drawArrays(s.TRIANGLES, 0, 3), s.readPixels(
      0,
      0,
      w,
      E,
      s.RGBA,
      s.UNSIGNED_BYTE,
      e.pixels
    );
    const l = [0, 0, 0];
    for (let o = 0; o < 3; o++)
      for (const u of [0, 8])
        for (const v of [0, 8])
          for (let g = u; g < E; g += 16)
            for (let x = v; x < w; x += 16) {
              let R = 0;
              for (let p = Math.max(1, g); p < Math.min(E - 1, g + 16); p++)
                for (let M = x; M < Math.min(w, x + 16); M++) {
                  const S = (p * w + M) * 4 + o;
                  e.pixels[S - w * 4] === 255 && e.pixels[S] === 255 && e.pixels[S + w * 4] === 255 && R++;
                }
              const m = l[o] ?? 0;
              l[o] = Math.max(m, R);
            }
    let d = l[0] < l[1] ? 0 : 1;
    if (l[2] * 3 < (l[d] ?? 1 / 0) && l[2] <= this.#k && (d = 2), this.#N = ["p", "c", "n"][d] ?? "c", this.#Z = l[d] ?? 0, this.#V++, s.useProgram(i), s.uniform1i(r.prev, 0), s.uniform1i(r.cur, 1), s.uniform1i(r.next, 2), s.uniform2i(r.size, this.#h, this.#l), s.uniform1i(r.topFieldFirst, this.#o ? 1 : 0), s.uniform1i(r.match, d), s.drawArrays(s.TRIANGLES, 0, 3), s.readPixels(
      0,
      0,
      w,
      E,
      s.RGBA,
      s.UNSIGNED_BYTE,
      e.pixels
    ), this.#b) {
      let o = 0;
      for (let u = 0; u < e.pixels.length; u += 4)
        o += Math.abs(
          (e.pixels[u] ?? 0) - (this.#b[u] ?? 0)
        ), o += Math.abs(
          (e.pixels[u + 1] ?? 0) - (this.#b[u + 1] ?? 0)
        ), o += Math.abs(
          (e.pixels[u + 2] ?? 0) - (this.#b[u + 2] ?? 0)
        );
      this.#z.push({
        frame: this.#V,
        score: o / (w * E * 3)
      }), this.#z.length > I && this.#z.shift();
    }
    if (this.#b = e.pixels.slice(), this.#Z <= this.#k) {
      if (this.#Q++, this.#j = 0, this.#Q >= I) {
        const o = Array.from({ length: 5 }, () => ({
          total: 0,
          count: 0
        }));
        for (const m of this.#z) {
          const p = o[m.frame % 5];
          p && (p.total += m.score, p.count++);
        }
        const u = o.map((m, p) => ({
          index: p,
          average: m.count === 0 ? 1 / 0 : m.total / m.count
        })).sort((m, p) => m.average - p.average), v = u[0], g = u[1];
        this.#se = v?.average ?? 1 / 0, this.#re = g?.average ?? 1 / 0, o.every(
          (m) => m.count >= 2
        ) && v !== void 0 && g !== void 0 && v.average <= j && g.average >= Math.max(1, v.average * 2) ? (this.#ie = v.index, this.#v === "video" && (this.#v = "film", this.#p = 0, this.#e.length = 0)) : this.#v === "film" && this.#m();
      }
      return;
    }
    this.#j++, this.#Q = 0, this.#v === "film" && this.#j >= Z && (this.#v = "video", this.#p = 0, this.#e.length = 0);
  }
  /** Weave the selected film fields into an output texture and queue it. */
  #Ge(e) {
    const t = (this.#L + 1) % D, A = this.#E[t];
    if (A) {
      for (this.#L = t; this.#e.length > 0 && this.#e[0]?.slot === t; )
        this.#e.shift(), this.#d.late++;
      this.#Ne(A.framebuffer), this.#e.push({ slot: t, at: e });
    }
  }
  /** Draw the selected p/c/n field weave into a full-size output texture. */
  #Ne(e) {
    const t = this.#I, A = this.#ge;
    if (!t || !A) return;
    const i = this.#A, r = this.#a, s = (this.#a + f - 1) % f, a = (this.#a + 1) % f;
    i.bindFramebuffer(i.FRAMEBUFFER, e), i.useProgram(t);
    for (const [h, c] of [a, s, r].entries())
      i.activeTexture(i.TEXTURE0 + h), i.bindTexture(i.TEXTURE_2D, this.#u[c] ?? null);
    i.uniform1i(A.prev, 0), i.uniform1i(A.cur, 1), i.uniform1i(A.next, 2), i.uniform2i(A.size, this.#h, this.#l), i.uniform1i(A.topFieldFirst, this.#o ? 1 : 0), i.uniform1i(
      A.match,
      this.#N === "p" ? 0 : this.#N === "c" ? 1 : 2
    ), i.viewport(0, 0, this.#h, this.#l), i.drawArrays(i.TRIANGLES, 0, 3);
  }
  /**
   * Filter one field into an output texture and put it in the queue.
   *
   * The three frames the filter reads are only the right three between one
   * frame arriving and the next, so both fields of a frame are built here and
   * held as pictures. What is queued after that is a copy waiting for a
   * moment, which no later frame can take away.
   */
  #be(e, t) {
    const A = (this.#L + 1) % D, i = this.#E[A];
    if (i) {
      for (this.#L = A; this.#e.length > 0 && this.#e[0]?.slot === A; )
        this.#e.shift(), this.#d.late++;
      this.#ue(!1, e, i.framebuffer), this.#e.push({ slot: A, at: t });
    }
  }
  /** The loop that puts filtered fields up, and the only thing that draws. */
  #$() {
    this.#T === null && (!this.#f || this.#y || !this.#c && !this.#s || (this.#O = 0, this.#T = requestAnimationFrame(this.#Fe)));
  }
  #ee() {
    this.#T !== null && cancelAnimationFrame(this.#T), this.#T = null, this.#e.length = 0;
  }
  #Fe = (e) => {
    if (this.#T = null, !(!this.#f || this.#y || !this.#c && !this.#s)) {
      if (this.#O > 0) {
        const t = e - this.#O;
        t >= 1 && t <= L && (this.#U = t < this.#U ? t : this.#U + (t - this.#U) * $);
      }
      this.#O = e, this.#ze(e), this.#T = requestAnimationFrame(this.#Fe);
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
  #ze(e) {
    const t = e + this.#U * 1.5;
    if ((this.#e[0]?.at ?? 1 / 0) > t) return;
    let A = this.#e.shift();
    for (; (this.#e[0]?.at ?? 1 / 0) <= t; )
      this.#d.late++, A = this.#e.shift();
    if (!A) return;
    const i = performance.now();
    this.#Xe(A.slot), this.#M += performance.now() - i;
  }
  /** Copy one of the filtered pictures onto the canvas. */
  #Xe(e) {
    const t = this.#E[e];
    t && this.#ye(t.texture);
  }
  /** Put a progressive frame through unchanged, keeping one display surface. */
  #He() {
    this.#Re();
    const e = this.#u[this.#a];
    e && this.#ye(e, !0), this.#i = 0;
  }
  #ye(e, t = !1) {
    const A = this.#A;
    A.bindFramebuffer(A.FRAMEBUFFER, null), A.useProgram(this.#_), A.activeTexture(A.TEXTURE0), A.bindTexture(A.TEXTURE_2D, e), A.uniform1i(this.#me, 0), A.uniform1i(this.#pe, t ? 1 : 0), A.viewport(0, 0, this.#h, this.#l), A.drawArrays(A.TRIANGLES, 0, 3), this.canvas.style.visibility = "visible", this.#X++;
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
  #We(e, t) {
    this.#R !== 0 && !t && (this.#d.missed += Math.max(0, e - this.#R - 1)), this.#R = e;
  }
  #Ye(e) {
    if (!this.#oe) return;
    const t = e - this.#K;
    if (t < B) return;
    const A = this.#W;
    this.#oe({
      ...this.#d,
      // The element's own count of what its decoder could not keep up with,
      // which is the machine being behind rather than this filter.
      dropped: this.#t.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0,
      fps: A * 1e3 / t,
      frameMs: A === 0 ? 0 : this.#M / A,
      mode: this.#v,
      match: this.#N,
      combScore: this.#Z,
      outputFps: this.#X * 1e3 / t,
      duplicateScore: this.#se,
      duplicateRunnerUp: this.#re
    }), this.#K = e, this.#W = 0, this.#M = 0, this.#X = 0;
  }
  /** Take the newest frame into the ring. */
  #Re() {
    const e = this.#A;
    this.#a = (this.#a + 1) % f, e.bindTexture(e.TEXTURE_2D, this.#u[this.#a] ?? null), e.texSubImage2D(
      e.TEXTURE_2D,
      0,
      0,
      0,
      e.RGBA,
      e.UNSIGNED_BYTE,
      this.#t
    ), this.#i = Math.min(this.#i + 1, f);
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
  #ue(e, t, A) {
    if (this.#i === 0 || this.#y) return;
    this.#i === f && !e ? this.#d.filtered++ : this.#d.degraded++;
    const i = this.#A, r = this.#a, s = (this.#a + f - 1) % f, a = (this.#a + 1) % f;
    let h, c, l;
    this.#i === 1 ? h = c = l = r : e ? (h = s, c = l = r) : this.#i === 2 ? (h = c = s, l = r) : (h = a, c = s, l = r), i.bindFramebuffer(i.FRAMEBUFFER, A), i.useProgram(this.#Y);
    for (const [o, u] of [h, c, l].entries())
      i.activeTexture(i.TEXTURE0 + o), i.bindTexture(i.TEXTURE_2D, this.#u[u] ?? null);
    i.uniform1i(this.#g.prev, 0), i.uniform1i(this.#g.cur, 1), i.uniform1i(this.#g.next, 2), i.uniform2i(this.#g.size, this.#h, this.#l);
    const d = this.#o ? 0 : 1;
    i.uniform1i(this.#g.parity, t ? 1 - d : d), i.uniform1i(this.#g.tff, this.#o ? 1 : 0), i.uniform1i(this.#g.spatialCheck, this.#ve ? 1 : 0), i.viewport(0, 0, this.#h, this.#l), i.drawArrays(i.TRIANGLES, 0, 3), A === null && (this.canvas.style.visibility = "visible", this.#X++);
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
  #Ae() {
    if (!this.#x) return;
    const e = this.#t, t = e.videoWidth, A = e.videoHeight;
    if (t === 0 || A === 0) return;
    const i = Math.min(
      e.offsetWidth / t,
      e.offsetHeight / A
    ), r = t * i, s = A * i;
    this.canvas.style.left = `${e.offsetLeft + (e.offsetWidth - r) / 2}px`, this.canvas.style.top = `${e.offsetTop + (e.offsetHeight - s) / 2}px`, this.canvas.style.width = `${r}px`, this.canvas.style.height = `${s}px`;
  }
  #Me(e, t) {
    const A = this.#A;
    this.canvas.width = e, this.canvas.height = t, this.#h = e, this.#l = t, this.#i = 0, this.#m(), this.#Ae();
    for (const i of this.#u) A.deleteTexture(i);
    this.#u = [];
    for (let i = 0; i < f; i++) {
      const r = A.createTexture();
      A.bindTexture(A.TEXTURE_2D, r), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_MIN_FILTER, A.NEAREST), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_MAG_FILTER, A.NEAREST), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_WRAP_S, A.CLAMP_TO_EDGE), A.texParameteri(A.TEXTURE_2D, A.TEXTURE_WRAP_T, A.CLAMP_TO_EDGE), A.texImage2D(
        A.TEXTURE_2D,
        0,
        A.RGBA,
        e,
        t,
        0,
        A.RGBA,
        A.UNSIGNED_BYTE,
        null
      ), this.#u.push(r);
    }
    this.#S(), this.#fe(), this.#s && this.#Se(), (this.#c || this.#s) && this.#de();
  }
  /** Allocate the fixed-size framebuffer used by both cadence passes. */
  #Se() {
    if (this.#D) return;
    const e = this.#A, t = e.createTexture();
    e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
      e.TEXTURE_2D,
      0,
      e.RGBA,
      w,
      E,
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
      t,
      0
    );
    const i = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
    if (e.bindFramebuffer(e.FRAMEBUFFER, null), !i) {
      e.deleteFramebuffer(A), e.deleteTexture(t);
      return;
    }
    this.#D = {
      texture: t,
      framebuffer: A,
      pixels: new Uint8Array(w * E * 4)
    };
  }
  #fe() {
    this.#D && (this.#A.deleteFramebuffer(this.#D.framebuffer), this.#A.deleteTexture(this.#D.texture), this.#D = null);
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
  #de() {
    const e = this.#A;
    if (!(this.#E.length === D || this.#h === 0)) {
      this.#S();
      for (let t = 0; t < D; t++) {
        const A = e.createTexture();
        e.bindTexture(e.TEXTURE_2D, A), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, e.NEAREST), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texImage2D(
          e.TEXTURE_2D,
          0,
          e.RGBA,
          this.#h,
          this.#l,
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
          A,
          0
        );
        const r = e.checkFramebufferStatus(e.FRAMEBUFFER) === e.FRAMEBUFFER_COMPLETE;
        if (e.bindFramebuffer(e.FRAMEBUFFER, null), !r) {
          e.deleteFramebuffer(i), e.deleteTexture(A), this.#S();
          return;
        }
        this.#E.push({ texture: A, framebuffer: i });
      }
      this.#L = D - 1;
    }
  }
  #S() {
    const e = this.#A;
    for (const { texture: t, framebuffer: A } of this.#E)
      e.deleteFramebuffer(A), e.deleteTexture(t);
    this.#E = [], this.#e.length = 0;
  }
  /**
   * Wrap the element in a `<div>` of this one's own and put the canvas over
   * it. The wrapper is what the canvas is positioned against; moving the
   * element out of the tree and back within the one task leaves playback
   * alone, which is what makes turning this on mid-stream free.
   */
  #Oe() {
    if (this.#x) return;
    const e = this.#t.parentElement;
    if (!e) return;
    const t = document.createElement("div");
    t.style.cssText = "position:relative;display:inline-block;line-height:0;max-width:100%", e.insertBefore(t, this.#t), t.appendChild(this.#t), t.appendChild(this.canvas), this.#x = t, this.#te.observe(this.#t), this.#Ae();
  }
  #Ze() {
    const e = this.#x;
    this.#x = null, this.#te.disconnect(), this.canvas.remove(), e?.parentElement && (e.parentElement.insertBefore(this.#t, e), e.remove());
  }
  #Ce = () => this.#Ae();
  #_e = () => {
    this.#i = 0, this.#J = 0, this.#e.length = 0, this.#w = !1, this.#r = 0, this.#m(), this.#Pe(), this.canvas.style.visibility = "hidden";
  };
  #Pe() {
    this.#d = {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0
    }, this.#R = 0, this.#K = 0, this.#ce = 0, this.#W = 0, this.#M = 0, this.#X = 0;
  }
  /** Return cadence detection to the conservative field-rate render path. */
  #m() {
    this.#e.length = 0, this.#w = !1, this.#v = "video", this.#N = "c", this.#Z = 0, this.#Q = 0, this.#j = 0, this.#V = 0, this.#ie = 0, this.#p = 0, this.#b = null, this.#z = [], this.#se = 1 / 0, this.#re = 1 / 0;
  }
  /**
   * Playback stopped, so the frame being held back goes up now. One picture,
   * whatever the rate: a still frame stands for a moment, and the moment is
   * the one the first field was taken at.
   */
  #C = () => {
    this.#e.length = 0, this.#w = !1, this.#f && this.#ue(!0, !1, null);
  };
  /**
   * A lost context takes the textures and the program with it. Rebuilding
   * them is possible, but a page that has lost its context has bigger
   * problems; getting out of the way leaves the element's own picture showing.
   */
  #Ie = (e) => {
    e.preventDefault(), this.#y = !0, this.stop();
  };
}
function b(n, e) {
  const t = n.createProgram(), A = U(n, n.VERTEX_SHADER, ee), i = U(n, n.FRAGMENT_SHADER, e);
  if (n.attachShader(t, A), n.attachShader(t, i), n.linkProgram(t), n.deleteShader(A), n.deleteShader(i), !n.getProgramParameter(t, n.LINK_STATUS)) {
    const r = n.getProgramInfoLog(t);
    throw n.deleteProgram(t), new Error(
      `the deinterlacer failed to link: ${r ?? "no reason given"}`
    );
  }
  return t;
}
function U(n, e, t) {
  const A = n.createShader(e);
  if (!A) throw new Error("the deinterlacer could not create a shader");
  if (n.shaderSource(A, t), n.compileShader(A), !n.getShaderParameter(A, n.COMPILE_STATUS)) {
    const i = n.getShaderInfoLog(A);
    throw n.deleteShader(A), new Error(
      `the deinterlacer failed to compile: ${i ?? "no reason given"}`
    );
  }
  return A;
}
const k = "data:video/mp4;base64,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AwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAL+QAAAAUGAQEygAAAADVBmiIWQj/51kP//f3t2AAPsAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAS8AAAAAUGAQEygAAAADJBnkETiEf/hv/80gAJcAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAkIQAAAAUGAQEygAAAAfMBnmCTRCP/9ZJR/1zH/6vL5qeSOTmASFdQlObW+4YAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAxvEAAAAwAAAwAAAwAAE4wAAAMAAAMAAAMAAFuAAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAMuAAAAABQYBATKAAAAANwGeYZakI//1bXH/Een/+rAALngAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAN+EAAAAFBgEBMoAAAAGuQZpileloiEf/2XyP/Fn/6mXyw21/v4X7ly3FFO60AAADAAADAAADAAADAAADAAADAAADADKWVJAQiFeS9HQZhFSJuVc/HAAAAwAAAwAAAwAAAwAAAwAAAwAAj8AAAAMAAAMABTIAAAMAAAMAAD+QAAADAAADAAQkAAADAAADAABJgAAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAXUQAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAB9IAAAAAAAADCwEBAQAAABBtZnJvAAAAAAAAAEM=", te = 0.5, ie = 3e3, G = 0.1, T = 16, N = 'video/mp4; codecs="avc1.640029"';
let P = null;
function se(n = {}) {
  return P ??= re(n), P;
}
async function ue(n = {}) {
  return (await se(n)).deinterlaces;
}
function fe() {
  P = null;
}
async function re(n) {
  const e = n.tolerance ?? te, t = n.timeoutMs ?? ie, A = performance.now(), i = (a) => ({
    deinterlaces: !1,
    survives: null,
    tookMs: performance.now() - A,
    error: a instanceof Error ? a.message : String(a)
  });
  if (typeof document > "u")
    return i(new Error("there is no document to decode in"));
  const r = document.createElement("video");
  r.muted = !0, r.defaultMuted = !0, r.playsInline = !0, r.preload = "auto";
  let s = null;
  try {
    s = he(r, t);
    const a = y(F(r, "loadeddata"), t), h = r.play().then(
      () => !0,
      () => !1
    );
    if (await s.ready, await a, await ae(r, t, await h), r.videoWidth === 0 || r.videoHeight === 0)
      return i(new Error("the probe clip decoded to nothing"));
    const c = oe(r);
    return {
      deinterlaces: c < 1 - e,
      survives: c,
      tookMs: performance.now() - A
    };
  } catch (a) {
    return i(a);
  } finally {
    r.pause(), r.removeAttribute("src"), r.replaceChildren(), r.load(), s && URL.revokeObjectURL(s.url);
  }
}
const _ = typeof MediaSource > "u" ? globalThis.ManagedMediaSource : MediaSource, ne = typeof MediaSource > "u";
function he(n, e) {
  if (!_ || !_.isTypeSupported(N))
    throw new Error("the probe clip needs Media Source Extensions");
  const t = k.indexOf(","), A = atob(k.slice(t + 1)), i = new Uint8Array(A.length);
  for (let h = 0; h < A.length; h++) i[h] = A.charCodeAt(h);
  const r = new _(), s = URL.createObjectURL(r);
  if (ne) {
    n.disableRemotePlayback = !0;
    const h = document.createElement("source");
    h.type = "video/mp4", h.src = s, n.append(h), n.load();
  } else
    n.src = s;
  const a = (async () => {
    await y(F(r, "sourceopen"), e);
    const h = r.addSourceBuffer(N), c = y(F(h, "updateend"), e);
    h.appendBuffer(i), await c, r.endOfStream();
  })();
  return { url: s, ready: a };
}
async function ae(n, e, t) {
  if (t) {
    const A = performance.now();
    for (; n.currentTime < G && performance.now() - A < e; )
      await new Promise((i) => requestAnimationFrame(i));
    n.pause();
  } else
    n.currentTime = G, await y(F(n, "seeked"), e);
}
function oe(n) {
  const e = n.videoHeight, t = document.createElement("canvas");
  t.width = T, t.height = e;
  const A = t.getContext("2d", { willReadFrequently: !0 });
  if (!A) throw new Error("there is no 2d context to read the clip with");
  A.imageSmoothingEnabled = !1, A.drawImage(n, 0, 0, T, e);
  const i = A.getImageData(0, 0, T, e).data, r = (l) => {
    let d = 0;
    for (let o = 0; o < T; o++)
      d += i[(l * T + o) * 4 + 1] ?? 0;
    return d / T;
  };
  let s = 0;
  const a = 2, h = e - 3;
  let c = r(a);
  for (let l = a + 1; l <= h; l++) {
    const d = r(l);
    s += Math.abs(d - c), c = d;
  }
  return s / (h - a) / 255;
}
function F(n, e) {
  return new Promise((t, A) => {
    n.addEventListener(e, () => t(), { once: !0 }), n.addEventListener(
      "error",
      () => {
        const i = n instanceof HTMLMediaElement ? n.error : null, r = i ? ` (MediaError ${i.code}${i.message ? `: ${i.message}` : ""})` : "";
        A(new Error(`the probe clip ${e} failed${r}`));
      },
      { once: !0 }
    );
  });
}
function y(n, e) {
  return Promise.race([
    n,
    new Promise(
      (t, A) => setTimeout(
        () => A(new Error("the probe clip took too long")),
        e
      )
    )
  ]);
}
export {
  le as Deinterlacer,
  H as FILM_ANALYSIS_FRAGMENT_SHADER,
  Y as FILM_SAMPLE_FRAGMENT_SHADER,
  C as FILM_UNIFORMS,
  W as FILM_WEAVE_FRAGMENT_SHADER,
  X as YADIF_FRAGMENT_SHADER,
  z as YADIF_UNIFORMS,
  ue as decoderDeinterlaces,
  fe as forgetDecoderProbe,
  se as probeDecoder,
  ce as supportsDeinterlace
};
//# sourceMappingURL=index.js.map
