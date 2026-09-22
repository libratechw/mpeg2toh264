(function(){"use strict";const ee=`#version 300 es
void main() {
  // From the vertex index alone. There is no geometry here worth a buffer.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;function K(o,e,t){const i=o.createProgram(),s=ue(o,o.VERTEX_SHADER,t),r=ue(o,o.FRAGMENT_SHADER,e);if(o.attachShader(i,s),o.attachShader(i,r),o.linkProgram(i),o.deleteShader(s),o.deleteShader(r),!o.getProgramParameter(i,o.LINK_STATUS)){const n=o.getProgramInfoLog(i);throw o.deleteProgram(i),new Error(`the deinterlacer failed to link: ${n??"no reason given"}`)}return i}function ue(o,e,t){const i=o.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(o.shaderSource(i,t),o.compileShader(i),!o.getShaderParameter(i,o.COMPILE_STATUS)){const s=o.getShaderInfoLog(i);throw o.deleteShader(i),new Error(`the deinterlacer failed to compile: ${s??"no reason given"}`)}return i}const _e=`#version 300 es
precision highp float;
uniform sampler2D uTexture;
in vec2 vTextureCoord;
uniform vec3 uTextColor;
uniform vec3 uBackColor;
out vec4 fragColor;

void main() {
  float a = texture(uTexture, vTextureCoord)[3];
  fragColor = vec4(uTextColor * a + uBackColor * (1.0 - a), 1.0);
}
`,Me=`#version 300 es
precision highp float;
in vec4 aVertexPosition;
in vec2 aTextureCoord;
uniform mat4 uMatrix;
uniform mat3 uUvMatrix;
out vec2 vTextureCoord;
out vec3 vTextColor;

void main() {
  gl_Position = uMatrix * aVertexPosition;
  vTextureCoord = vec2(uUvMatrix * vec3(aTextureCoord, 1.0));
}
`;function Se(o,e){const t=K(o,_e,Me),i=o.getAttribLocation(t,"aVertexPosition"),s=o.getAttribLocation(t,"aTextureCoord"),r=o.getUniformLocation(t,"uTexture"),n=o.getUniformLocation(t,"uMatrix"),a=o.getUniformLocation(t,"uUvMatrix"),l=o.getUniformLocation(t,"uTextColor"),u=o.getUniformLocation(t,"uBackColor");if(r==null||n==null||a==null||l==null||u==null)throw new Error("failed to initialize DEBUG_FRAGMENT_SHADER, DEBUG_VERTEX_SHADER");const h=o.createBuffer(),v=o.createBuffer();return{gl:o,...De(o,e),program:t,programUniforms:{vertex:i,textureCoord:s,texture:r,matrix:n,uvMatrix:a,textColor:l,backColor:u},positionBuffer:h,textureBuffer:v}}function De(o,e){const t=new OffscreenCanvas(0,0),i=t.getContext("2d"),s=new Map;let r=0;const n=0;let a=1;i.font=e,i.fillStyle="white";for(let u=32;u<128;u++){const h=String.fromCharCode(u),v=i.measureText(h),f=Math.ceil(v.actualBoundingBoxDescent+v.actualBoundingBoxAscent+1),c=Math.ceil(v.actualBoundingBoxLeft+v.actualBoundingBoxRight+1);s.set(h,{x:r,y:n,width:c,height:f,metrics:v}),a=Math.max(a,f),r+=c}t.width=r,t.height=a,i.font=e,i.fillStyle="white";for(const[u,h]of s)i.fillText(u,Math.floor(h.x+h.metrics.actualBoundingBoxLeft+1),Math.floor(h.metrics.actualBoundingBoxAscent+1));const l=o.createTexture();return o.bindTexture(o.TEXTURE_2D,l),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MIN_FILTER,o.LINEAR),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MAG_FILTER,o.LINEAR),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_WRAP_S,o.CLAMP_TO_EDGE),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_WRAP_T,o.CLAMP_TO_EDGE),o.texImage2D(o.TEXTURE_2D,0,o.RGBA,o.RGBA,o.UNSIGNED_BYTE,t),{fontTexture:l,chars:s,textureSize:{width:r,height:a}}}function we(o){const e=o.gl;e.deleteBuffer(o.positionBuffer),e.deleteBuffer(o.textureBuffer),e.deleteTexture(o.fontTexture),e.deleteProgram(o.program)}function Ce(o,e,t,i,s,r,n){const a=[],l=[],u=t;for(const f of e){if(f===`
`){t=u,i+=n;continue}const c=o.chars.get(f);if(c==null)continue;if(c.width===1){t+=c.metrics.width;continue}const m=Math.floor(t-c.metrics.actualBoundingBoxLeft),x=Math.floor(i-c.metrics.actualBoundingBoxAscent),b=m+c.width,E=x+c.height;a.push(m,x),l.push(c.x,c.y),a.push(m,E),l.push(c.x,c.y+c.height),a.push(m+c.width,E),l.push(c.x+c.width,c.y+c.height),a.push(b,E),l.push(c.x+c.width,c.y+c.height),a.push(m,x),l.push(c.x,c.y),a.push(b,x),l.push(c.x+c.width,c.y),t+=c.metrics.width}const h=o.gl;h.useProgram(o.program),h.bindBuffer(h.ARRAY_BUFFER,o.positionBuffer),h.bufferData(h.ARRAY_BUFFER,new Float32Array(a),h.STATIC_DRAW),h.vertexAttribPointer(o.programUniforms.vertex,2,h.FLOAT,!1,0,0),h.enableVertexAttribArray(o.programUniforms.vertex),h.bindBuffer(h.ARRAY_BUFFER,o.textureBuffer),h.bufferData(h.ARRAY_BUFFER,new Float32Array(l),h.STATIC_DRAW),h.vertexAttribPointer(o.programUniforms.textureCoord,2,h.FLOAT,!1,0,0),h.enableVertexAttribArray(o.programUniforms.textureCoord),h.activeTexture(h.TEXTURE0),h.bindTexture(h.TEXTURE_2D,o.fontTexture),h.uniform1i(o.programUniforms.texture,0),h.uniform3fv(o.programUniforms.textColor,[1,1,1]),h.uniform3fv(o.programUniforms.backColor,[0,0,0]);function v(f,c,m){const x=[];for(let b=0;b<c;b++)for(let E=0;E<f;E++)x.push(m[E*f+b]);return x}h.uniformMatrix4fv(o.programUniforms.matrix,!1,v(4,4,[1/(s/2),0,0,-1,0,-2/r,0,1,0,0,1,0,0,0,0,1])),h.uniformMatrix3fv(o.programUniforms.uvMatrix,!1,v(3,3,[1/o.textureSize.width,0,0,0,1/o.textureSize.height,0,0,0,1])),h.viewport(0,0,s,r),h.enable(h.BLEND),h.blendFunc(h.SRC_ALPHA,h.ONE_MINUS_SRC_ALPHA),h.drawArrays(h.TRIANGLES,0,a.length/2),h.disable(h.BLEND)}const y={firstRepeatsPrevious:0,secondRepeatsNext:1,secondRepeatsPrevious:2,previousSecondRepeated:3,firstRepeatsNext:4,previousFirstRepeated:5,phase:6},U=7,fe=2,te=1,ke=2,ie=5,Pe={a:"uA",b:"uB",fieldMetrics:"uFieldMetrics",first:"uFirst",size:"uSize"},de=16,me=8,Le=`#version 300 es

precision highp float;

uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFieldMetrics;

/** The parity of the field captured first. */
uniform int uFirst;
uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

float luma(vec3 c)
{
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec4 measure(float diff, float total, float threshold)
{
  diff /= total;
  return vec4(diff, diff > threshold ? 1.0 : 0.0, diff, 1.0);
}

void main()
{
  const int BLOCK_W = ${de};
  const int BLOCK_H = ${me};

  ivec2 block = ivec2(gl_FragCoord.xy);
  ivec2 base = ivec2(block.x * BLOCK_W, block.y * BLOCK_H * 2);

  // Even and odd frame lines, summed apart.
  float diffEven = 0.0;
  float diffOdd = 0.0;
  int totalEven = 0;
  int totalOdd = 0;

  for (int y = 0; y < BLOCK_H; ++y) {
    for (int x = 0; x < BLOCK_W; ++x) {
      ivec2 p = base + ivec2(x, y * 2);

      if (p.x < uSize.x && p.y < uSize.y) {
        float a = luma(texelFetch(uA, p, 0).rgb);
        float b = luma(texelFetch(uB, p, 0).rgb);

        // Ignore small compression artifacts when accumulating differences at moving edges.
        diffEven += max(abs(a - b) - 8.0 / 255.0, 0.0);
        totalEven += 1;
      }
      p.y += 1;
      if (p.x < uSize.x && p.y < uSize.y) {
        float a = luma(texelFetch(uA, p, 0).rgb);
        float b = luma(texelFetch(uB, p, 0).rgb);

        diffOdd += max(abs(a - b) - 8.0 / 255.0, 0.0);
        totalOdd += 1;
      }
    }
  }

  float run = texelFetch(uFieldMetrics, ivec2(${y.phase}, 0), 0)[1];
  float threshold = run == 0.0 ? 0.025 : (run <= 10.0 ? 0.11 : 0.15);

  vec4 even = measure(diffEven, float(totalEven), threshold);
  vec4 odd = measure(diffOdd, float(totalOdd), threshold);
  outFirst = uFirst == 0 ? even : odd;
  outSecond = uFirst == 0 ? odd : even;
}
`,Ue={second:"uSecond",first:"uFirst",size:"uSize"},V=8,Ie=`#version 300 es
precision highp float;

uniform sampler2D uSecond;
uniform sampler2D uFirst;

uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

void main()
{
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 base = dst * ${V};

  vec4 second = vec4(0.0);
  vec4 first = vec4(0.0);

  for (int y = 0; y < ${V}; ++y) {
    for (int x = 0; x < ${V}; ++x) {
      ivec2 p = base + ivec2(x, y);

      if (p.x < uSize.x && p.y < uSize.y) {
        vec4 value = texelFetch(uSecond, p, 0);
        second[0] = max(second[0], value[0]);
        second.yzw += value.yzw;
        value = texelFetch(uFirst, p, 0);
        first[0] = max(first[0], value[0]);
        first.yzw += value.yzw;
      }
    }
  }

  outSecond = second;
  outFirst = first;
}
`,Be={previous:"uPrevious",second:"uSecond",first:"uFirst",size:"uSize"},Ne=`#version 300 es
precision highp float;

uniform sampler2D uPrevious;
uniform sampler2D uSecond;
uniform sampler2D uFirst;

/** The size of the reduced comparisons. */
uniform ivec2 uSize;

out vec4 outValue;

vec4 previous(int metric) {
  return texelFetch(uPrevious, ivec2(metric, 0), 0);
}

/** Fold what REDUCTION left into one texel. */
vec4 fold(sampler2D reduced) {
  vec4 sum = vec4(0.0);
  for (int y = 0; y < uSize.y; ++y) {
    for (int x = 0; x < uSize.x; ++x) {
      vec4 value = texelFetch(reduced, ivec2(x, y), 0);
      sum[0] = max(sum[0], value[0]);
      sum.yzw += value.yzw;
    }
  }
  return vec4(sum[0], sum[1], sum[2] / max(sum[3], 1.0), sum[3]);
}

bool same(float differing) {
  return differing <= ${fe}.0;
}

// A repeated field changes less than the opposite field.
// Distinguish motion shared by both fields from a still image with small absolute differences.
bool repeats(vec4 field, vec4 other) {
  return same(field[1]) &&
    (max(field[0], other[0]) < 0.025 || field[2] < other[2] * 0.75);
}

/** The phase texel, (phase, run), from the six comparisons' differing counts. */
vec4 decide(vec4 last, vec4 dFirstRepeatsPrevious, vec4 dSecondRepeatsNext,
            vec4 dSecondRepeatsPrevious, vec4 dPreviousSecondRepeated,
            vec4 dFirstRepeatsNext, vec4 dPreviousFirstRepeated)
{
  bool firstRepeatsPrevious = repeats(dFirstRepeatsPrevious, dSecondRepeatsPrevious);
  bool secondRepeatsNext = repeats(dSecondRepeatsNext, dFirstRepeatsNext);
  bool secondRepeatsPrevious = repeats(dSecondRepeatsPrevious, dFirstRepeatsPrevious);
  bool previousSecondRepeated = repeats(dPreviousSecondRepeated, dPreviousFirstRepeated);
  bool firstRepeatsNext = repeats(dFirstRepeatsNext, dSecondRepeatsNext);
  bool previousFirstRepeated = repeats(dPreviousFirstRepeated, dPreviousSecondRepeated);
  bool still = (firstRepeatsPrevious && secondRepeatsPrevious) || (secondRepeatsNext && firstRepeatsNext);

  int previous = int(last[0]);
  float run = last[1];
  // What each phase looks like: one field repeats, the other plainly does not.
  bool looks1 = firstRepeatsPrevious && !secondRepeatsPrevious;
  bool looks2 = secondRepeatsNext && !firstRepeatsNext;
  bool looks3 = secondRepeatsPrevious && !firstRepeatsPrevious;
  bool looks4 = previousSecondRepeated && !previousFirstRepeated;
  bool looks5 = firstRepeatsNext && !secondRepeatsNext;

  int expected = previous == 0 ? 0 : (previous == 5 ? 1 : previous + 1);
  bool expectedRepeat =
    expected == 1 ? firstRepeatsPrevious :
    expected == 2 ? secondRepeatsNext :
    expected == 3 ? secondRepeatsPrevious :
    expected == 4 ? previousSecondRepeated :
    expected == 5 ? firstRepeatsNext : false;
  bool expectedLooks =
    expected == 1 ? looks1 :
    expected == 2 ? looks2 :
    expected == 3 ? looks3 :
    expected == 4 ? looks4 :
    expected == 5 ? looks5 : false;
  bool believed = run >= ${ie}.0;
  bool carried = believed ? expectedRepeat : expectedLooks;

  int phase = 0;
  if (expected != 0 && carried) {
    phase = expected;
    run += 1.0;
  } else if (expected != 0 && (still || expectedRepeat)) {
    // Uninformative: keeps the cycle's place, counts only once believed.
    phase = expected;
    if (believed) run += 1.0;
  } else if (looks1) {
    phase = 1;
  } else if (looks2) {
    phase = 2;
  } else if (looks3) {
    phase = 3;
  } else if (looks4) {
    phase = 4;
  } else if (looks5) {
    phase = 5;
  }
  if (phase != expected) run = phase != 0 ? 1.0 : 0.0;
  return vec4(float(phase), run, 0.0, 0.0);
}

void main()
{
  int metric = int(gl_FragCoord.x);
  // The comparisons against the next frame become, a frame later, the ones
  // against the previous frame, and those the ones before.
  if (metric == ${y.firstRepeatsPrevious}) {
    outValue = previous(${y.firstRepeatsNext});
  } else if (metric == ${y.secondRepeatsNext}) {
    outValue = fold(uSecond);
  } else if (metric == ${y.secondRepeatsPrevious}) {
    outValue = previous(${y.secondRepeatsNext});
  } else if (metric == ${y.previousSecondRepeated}) {
    outValue = previous(${y.secondRepeatsPrevious});
  } else if (metric == ${y.firstRepeatsNext}) {
    outValue = fold(uFirst);
  } else if (metric == ${y.previousFirstRepeated}) {
    outValue = previous(${y.firstRepeatsPrevious});
  } else {
    outValue = decide(
      previous(${y.phase}),
      previous(${y.firstRepeatsNext}),
      fold(uSecond),
      previous(${y.secondRepeatsNext}),
      previous(${y.secondRepeatsPrevious}),
      fold(uFirst),
      previous(${y.firstRepeatsPrevious})
    );
  }
}
`,Oe={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",parity:"uParity",tff:"uTff",spatialCheck:"uSpatialCheck",debug:"uDebug",film:"uFilm",second:"uSecond",phase:"uPhase",fieldMetrics:"uFieldMetrics"},ze=`#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uNext;
uniform sampler2D uFieldMetrics;
/** The size of a frame in texels. */
uniform ivec2 uSize;
/** The parity of the lines that are kept; the others are interpolated. */
uniform int uParity;
/** Whether the first field of a frame is its top field. */
uniform int uTff;
/** Whether the temporal bound is widened by the local vertical range. */
uniform bool uSpatialCheck;
uniform bool uDebug;
uniform bool uFilm;
uniform bool uSecond;
uniform int uPhase;

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

int firstParity() {
  return uTff != 0 ? 0 : 1;
}

bool same(int metric) {
  return texelFetch(uFieldMetrics, ivec2(metric, 0), 0)[1] <= ${fe}.0;
}

/** The pulldown phase the detection gave this frame, or 0. See film-shader.ts. */
int detectedPhase() {
  vec4 phase = texelFetch(uFieldMetrics, ivec2(${y.phase}, 0), 0);
  // Deinterlace each field normally until the cadence is confirmed.
  return phase[1] >= ${ie}.0 ? int(phase[0]) : 0;
}

bool isMixedPhase(int phase) {
  return phase == ${te} || phase == ${ke};
}

/** Detect new combing in phase 4, whose cadence is inferred from previous repeats. */
bool movingComb(vec3 pixel, int x, int y) {
  vec3 above = fetch(uCur, x, y - 1);
  vec3 below = fetch(uCur, x, y + 1);
  vec3 comb = max(min(above, below) - pixel, pixel - max(above, below));
  // Phase 3 is a complete film frame, so use its vertical detail as the reference.
  // Preserve existing horizontal lines and interpolate only pixels with new combing.
  vec3 previous = fetch(uPrev, x, y);
  vec3 previousAbove = fetch(uPrev, x, y - 1);
  vec3 previousBelow = fetch(uPrev, x, y + 1);
  vec3 previousComb = max(min(previousAbove, previousBelow) - previous,
                          previous - max(previousAbove, previousBelow));
  return any(greaterThan(comb, max(previousComb, vec3(0.0)) + vec3(8.0 / 255.0)));
}

const int DEBUG_BAR_CELL = 32;
const int DEBUG_BAR_WIDTH = DEBUG_BAR_CELL * 7;
const int DEBUG_BAR_HEIGHT = 16;

vec3 debugBar(int x) {
  int cell = x / DEBUG_BAR_CELL;
  bool lit = x % DEBUG_BAR_CELL >= DEBUG_BAR_CELL - 4;
  if (cell == 6) return lit || uSecond ? vec3(1.0, 0.0, 0.0) : vec3(0.0);
  return lit || same(cell) ? vec3(1.0) : vec3(0.0);
}

const int DIGIT_WIDTH = 24;
const int DIGIT_HEIGHT = 60;

bool digitLit(int digit, int x, int y) {
  bool a = y < 20;
  bool b = x >= 20 && y < 40;
  bool c = x >= 20 && y >= 40;
  bool d = y >= 56;
  bool e = x < 4 && y >= 40;
  bool f = x < 4 && y < 40;
  bool g = y >= 36 && y < 40;
  switch (digit) {
    case 1: return b || c;
    case 2: return a || b || d || e || g;
    case 3: return a || b || c || d || g;
    case 4: return b || c || f || g;
    case 5: return a || c || d || f || g;
    default: return false;
  }
}

void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  int x = at.x;
  // The framebuffer counts its rows from the bottom and a frame from the top.
  int y = uSize.y - 1 - at.y;

  vec3 rgb;
  if (uFilm && uDebug && y < DEBUG_BAR_HEIGHT && x < DEBUG_BAR_WIDTH) {
    rgb = debugBar(x);
  } else if (uFilm && uDebug && x < DIGIT_WIDTH && y < DIGIT_HEIGHT && uPhase > 0) {
    rgb = digitLit(uPhase, x, y) ? vec3(1.0, 0.0, 0.0) : vec3(0.0);
  } else if (uFilm && !uSecond && detectedPhase() != 0) {
    bool mixed = isMixedPhase(detectedPhase());
    rgb = mixed && (y & 1) != firstParity()
      ? texelFetch(uPrev, ivec2(x, y), 0).rgb
      : texelFetch(uCur, ivec2(x, y), 0).rgb;
    if (detectedPhase() == 4 && (y & 1) != uParity && movingComb(rgb, x, y))
      rgb = filterPixel(uPrev, uCur, x, y);
  } else if ((y & 1) == uParity) {
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
`,se={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",topFieldFirst:"uTopFieldFirst",match:"uMatch"},S=288,D=162,Ge=`#version 300 es
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
  ivec2 targetSize = ivec2(${S}, ${D});
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
`,Xe=`#version 300 es
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
`,He=`#version 300 es
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
  ivec2 targetSize = ivec2(${S}, ${D});
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
`;class A{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#i;#r;#e;#n=0;#t=null;#s=[];#a=null;#o=1/0;#u=1/0;constructor(e,t){this.#i=e,this.#r=t,this.#e=255*A.DECIMATE_BLOCK**2*A.DUPLICATE_PERCENT/100}fieldMatch(e,t,i,s,r=A.COMBED_PIXEL_LIMIT){const n=s?1:0,a={p:e,c:t,n:i};let l=this.#f("c","p",n,a);const u=new Map,h=x=>{const b=u.get(x);if(b!==void 0)return b;const E=A.#h(this.weave(e,t,i,x,s),this.#i,this.#r);return u.set(x,E),E},v=h(l),f=h("n");(f*3<v||f*2<v&&v>r)&&Math.abs(f-v)>=30&&f<r&&(l="n");const c=h(l),m=c>=r;return m&&(l="c"),{match:l,combScore:c,isCombed:m,luma:this.weave(e,t,i,l,s)}}decimate(e){const t=this.#n,i=this.#a?A.#v(this.#a,e,this.#i,this.#r):{maxBlockDifference:1/0,totalDifference:1/0};this.#s.push(i);const s=this.#t===t,r=s&&i.maxBlockDifference<this.#e;s&&!r&&(this.#t=null);const n=this.#t;this.#a=e.slice(),this.#n++;let a=this.#t;if(this.#n===A.CYCLE){let l=0,u=null;for(let h=1;h<this.#s.length;h++)(this.#s[h]?.maxBlockDifference??1/0)<(this.#s[l]?.maxBlockDifference??1/0)?(u=l,l=h):(u===null||(this.#s[h]?.maxBlockDifference??1/0)<(this.#s[u]?.maxBlockDifference??1/0))&&(u=h);this.#o=this.#s[l]?.maxBlockDifference??1/0,this.#u=u===null?1/0:this.#s[u]?.maxBlockDifference??1/0,a=(this.#s[l]?.maxBlockDifference??1/0)<this.#e?l:null,this.#t=a,this.#s=[],this.#n=0}return{cycleIndex:t,maxBlockDifference:i.maxBlockDifference,totalDifference:i.totalDifference,shouldDrop:r,dropIndex:n,nextDropIndex:a,lowestCycleDifference:this.#o,runnerUpCycleDifference:this.#u}}weave(e,t,i,s,r){if(s==="c")return t.slice();const n=t.slice(),a=s==="p"?e:i,l=n.length/this.#r,u=r?1:0;for(let h=u;h<this.#r;h+=2)n.set(a.subarray(h*l,(h+1)*l),h*l);return n}reset(){this.#n=0,this.#t=null,this.#s=[],this.#a=null,this.#o=1/0,this.#u=1/0}#f(e,t,i,s){const r=this.#i,n=this.#r,a=2-i,l=2-i,u=s[e],h=s[t],v=A.#x(u,h,r,n,i);let f=0,c=0,m=0,x=0,b=0,E=0;for(let z=2;z<n-2;z+=2){const M=(z-2)/2,ae=a-1+M*2,le=a+1+M*2,ce=a+3+M*2,Z=a+M*2,Y=Z+2,H=l+M*2,L=H+2,Re=a+M*2;for(let C=8;C<r-8;C++){const G=(v[Re*r+C]??0)|(v[(Re+2)*r+C]??0);if(G===0)continue;const Ae=(s.c[ae*r+C]??0)+((s.c[le*r+C]??0)<<2)+(s.c[ce*r+C]??0),W=Math.abs(3*((u[Z*r+C]??0)+(u[Y*r+C]??0))-Ae),$=Math.abs(3*((h[H*r+C]??0)+(h[L*r+C]??0))-Ae);W>23&&(G&1)!==0&&(f+=W),$>23&&(G&1)!==0&&(x+=$),W>42&&(G&2)!==0&&(c+=W),$>42&&(G&2)!==0&&(b+=$),W>42&&(G&4)!==0&&(m+=W),$>42&&(G&4)!==0&&(E+=$)}}c<500&&b<500&&(m>=500||E>=500)&&Math.max(m,E)>3*Math.min(m,E)&&(c=m,b=E);const g=Math.floor(f/6+.5),T=Math.floor(x/6+.5),d=Math.floor(c/6+.5),p=Math.floor(b/6+.5),F=Math.max(g,T)/Math.max(Math.min(g,T),1),w=Math.max(d,p)/Math.max(Math.min(d,p),1),O=Math.max(d,p)/Math.max(Math.max(g,T),1);return(d>=500||p>=500)&&(d*2<p||p*2<d)||(d>=1e3||p>=1e3)&&(d*3<p*2||p*3<d*2)||(d>=2e3||p>=2e3)&&(d*5<p*4||p*5<d*4)||(d>=4e3||p>=4e3)&&w>F||O>.005&&Math.max(d,p)>150&&(d*2<p||p*2<d)?d>p?t:e:g>T?t:e}static#x(e,t,i,s,r){const n=Array.from({length:Math.ceil(s/2)},()=>new Uint8Array(i)),a=r===1?1:0;for(let h=0;h<n.length;h++){const v=Math.min(s-1,a+h*2),f=n[h];if(f)for(let c=0;c<i;c++)f[c]=Math.abs((e[v*i+c]??0)-(t[v*i+c]??0))}const l=new Uint8Array(i*s),u=r===1?3:2;for(let h=1;h<n.length-1;h++){const v=u+(h-1)*2;if(v>=s)break;const f=n[h];if(f)for(let c=1;c<i-1;c++){const m=f[c]??0;if(m<=3)continue;let x=0;for(let p=c-1;p<=c+1;p++)x+=(n[h-1]?.[p]??0)>3?1:0,x+=(n[h]?.[p]??0)>3?1:0,x+=(n[h+1]?.[p]??0)>3?1:0;if(x<=1)continue;const b=v*i+c;if(l[b]=1,m<=19)continue;x=0;let E=!1,g=!1;for(let p=c-1;p<=c+1;p++)(n[h-1]?.[p]??0)>19&&(x++,E=!0),(n[h]?.[p]??0)>19&&x++,(n[h+1]?.[p]??0)>19&&(x++,g=!0);if(x<=3)continue;if(E&&g){l[b]|=2;continue}let T=!1,d=!1;for(let p=Math.max(c-4,0);p<Math.min(c+5,i);p++)h!==1&&(n[h-2]?.[p]??0)>19&&(T=!0),(n[h-1]?.[p]??0)>19&&(E=!0),(n[h+1]?.[p]??0)>19&&(g=!0),h!==n.length-2&&(n[h+2]?.[p]??0)>19&&(d=!0);E&&(g||T)||g&&(E||d)?l[b]|=2:x>5&&(l[b]|=4)}}return l}static#h(e,t,i){const s=new Uint8Array(t*i);for(let n=0;n<i;n++){const a=n*t,l=Math.max(0,Math.min(i-1,n===0?1:n-1))*t,u=Math.max(0,Math.min(i-1,n===i-1?i-2:n+1))*t,h=Math.max(0,Math.min(i-1,n<2?n===0?2:3:n-2))*t,v=Math.max(0,Math.min(i-1,n+2>=i?n===i-1?i-3:i-4:n+2))*t;for(let f=0;f<t;f++){const c=e[a+f]??0,m=e[l+f]??0,x=e[u+f]??0,b=e[h+f]??0,E=e[v+f]??0;(n===0?Math.abs(c-x)>A.COMB_THRESHOLD:n===i-1?Math.abs(c-m)>A.COMB_THRESHOLD:Math.abs(c-m)>A.COMB_THRESHOLD&&Math.abs(c-x)>A.COMB_THRESHOLD)&&Math.abs(4*c-3*(m+x)+b+E)>A.COMB_THRESHOLD*6&&(s[a+f]=255)}}let r=0;for(const n of[0,8])for(const a of[0,8])for(let l=n;l<i;l+=16)for(let u=a;u<t;u+=16){let h=0;for(let v=Math.max(1,l);v<Math.min(i-1,l+16);v++)for(let f=u;f<Math.min(t,u+16);f++){const c=v*t+f;s[c-t]===255&&s[c]===255&&s[c+t]===255&&h++}r=Math.max(r,h)}return r}static#v(e,t,i,s){const r=A.DECIMATE_BLOCK/2,n=Math.ceil(i/r),a=Math.ceil(s/r),l=new Float64Array(n*a),u=e.length/(i*s);for(let f=0;f<s;f++){const c=Math.floor(f/r);for(let m=0;m<i;m++){const x=Math.floor(m/r),b=c*n+x,E=(f*i+m)*u;if(u===1){l[b]=(l[b]??0)+Math.abs((e[E]??0)-(t[E]??0));continue}const g=Math.round((e[E]??0)*.2126+(e[E+1]??0)*.7152+(e[E+2]??0)*.0722),T=Math.round((t[E]??0)*.2126+(t[E+1]??0)*.7152+(t[E+2]??0)*.0722);if(l[b]=(l[b]??0)+Math.abs(g-T),(m&1)!==0||(f&1)!==0)continue;let d=0,p=0,F=0,w=0,O=0,z=0,M=0;for(let Y=f;Y<Math.min(f+2,s);Y++)for(let H=m;H<Math.min(m+2,i);H++){const L=(Y*i+H)*u;d+=e[L]??0,p+=e[L+1]??0,F+=e[L+2]??0,w+=t[L]??0,O+=t[L+1]??0,z+=t[L+2]??0,M++}const ae=Math.round((-.114572*d-.385428*p+.5*F)/M),le=Math.round((-.114572*w-.385428*O+.5*z)/M),ce=Math.round((.5*d-.454153*p-.045847*F)/M),Z=Math.round((.5*w-.454153*O-.045847*z)/M);l[b]=(l[b]??0)+Math.abs(ae-le)+Math.abs(ce-Z)}}let h=-1;for(let f=0;f<a-1;f++)for(let c=0;c<n-1;c++)h=Math.max(h,(l[f*n+c]??0)+(l[f*n+c+1]??0)+(l[(f+1)*n+c]??0)+(l[(f+1)*n+c+1]??0));let v=0;for(const f of l)v+=f;return{maxBlockDifference:h,totalDifference:v}}}const I={phase:0,run:0};function re(o,e,t){return Object.fromEntries(Object.entries(t).map(([i,s])=>[i,o.getUniformLocation(e,s)]))}class pe{#i;#r;#e;#n;#t;#s;#a;#o=null;#u=null;#f=null;#x=0;#h=null;#v=null;#b=0;#A=0;metrics=new Float32Array(U*4);#d=0;#g=0;constructor(e){this.#i=e,this.#r=K(e,Le,ee),this.#e=re(e,this.#r,Pe),this.#n=K(e,Ie,ee),this.#t=re(e,this.#n,Ue),this.#s=K(e,Ne,ee),this.#a=re(e,this.#s,Be)}get texture(){return this.#f?.[this.#x]?.textures[0]??null}resize(e,t){e===this.#d&&t===this.#g||(this.#d=e,this.#g=t,this.#_())}reset(){const e=this.#i;e.deleteSync(this.#v),this.#v=null,this.#b=0;const t=this.#f?.[this.#x];if(!t)return;const i=new Float32Array(U*4);for(let s=0;s<y.phase;s++)i[s*4+1]=1;e.bindTexture(e.TEXTURE_2D,t.textures[0]??null),e.texSubImage2D(e.TEXTURE_2D,0,0,0,U,1,e.RGBA,e.FLOAT,i)}detect(e,t,i){const s=this.#i;if(this.#d===0||this.#g===0)return;this.#T();const r=this.#o,n=this.#u,a=this.#f;if(r===null||n===null||a===null)return;const l=a[this.#x],u=a[1-this.#x];if(s.bindFramebuffer(s.FRAMEBUFFER,r.framebuffer),s.useProgram(this.#r),this.#m(0,e,this.#e.a),this.#m(1,t,this.#e.b),this.#m(2,l.textures[0],this.#e.fieldMetrics),s.uniform1i(this.#e.first,i),s.uniform2i(this.#e.size,this.#d,this.#g),s.viewport(0,0,r.width,r.height),s.drawArrays(s.TRIANGLES,0,3),s.bindFramebuffer(s.FRAMEBUFFER,n.framebuffer),s.useProgram(this.#n),this.#m(0,r.textures[0],this.#t.second),this.#m(1,r.textures[1],this.#t.first),s.uniform2i(this.#t.size,r.width,r.height),s.viewport(0,0,n.width,n.height),s.drawArrays(s.TRIANGLES,0,3),s.bindFramebuffer(s.FRAMEBUFFER,u.framebuffer),s.useProgram(this.#s),this.#m(0,l.textures[0],this.#a.previous),this.#m(1,n.textures[0],this.#a.second),this.#m(2,n.textures[1],this.#a.first),s.uniform2i(this.#a.size,n.width,n.height),s.viewport(0,0,U,1),s.drawArrays(s.TRIANGLES,0,3),this.#x=1-this.#x,this.#b++,this.#v!==null){s.bindFramebuffer(s.FRAMEBUFFER,null);return}this.#A=this.#b,s.bindBuffer(s.PIXEL_PACK_BUFFER,this.#h),s.readPixels(0,0,U,1,s.RGBA,s.FLOAT,0),s.bindBuffer(s.PIXEL_PACK_BUFFER,null),s.bindFramebuffer(s.FRAMEBUFFER,null),this.#v=s.fenceSync(s.SYNC_GPU_COMMANDS_COMPLETE,0),s.flush()}poll(){const e=this.#i,t=this.#v;if(t===null||this.#h===null)return null;switch(e.clientWaitSync(t,0,0)){case e.ALREADY_SIGNALED:case e.CONDITION_SATISFIED:return e.bindBuffer(e.PIXEL_PACK_BUFFER,this.#h),e.getBufferSubData(e.PIXEL_PACK_BUFFER,0,this.metrics),e.bindBuffer(e.PIXEL_PACK_BUFFER,null),e.deleteSync(t),this.#v=null,{phase:this.metrics[y.phase*4]??0,run:this.metrics[y.phase*4+1]??0,age:this.#b-this.#A};default:return null}}destroy(){const e=this.#i;if(this.#_(),this.#f!==null){for(const t of this.#f)Q(e,t);this.#f=null}e.deleteSync(this.#v),this.#v=null,e.deleteBuffer(this.#h),this.#h=null,e.deleteProgram(this.#r),e.deleteProgram(this.#n),e.deleteProgram(this.#s)}#m(e,t,i){const s=this.#i;s.activeTexture(s.TEXTURE0+e),s.bindTexture(s.TEXTURE_2D,t??null),s.uniform1i(i,e)}#_(){const e=this.#i;this.#o!==null&&Q(e,this.#o),this.#u!==null&&Q(e,this.#u),this.#o=null,this.#u=null}#T(){const e=this.#i;if(this.#o===null||this.#u===null){this.#_();const t=Math.ceil(this.#d/de),i=Math.ceil(this.#g/(me*2));this.#o=j(e,t,i,2),this.#u=j(e,Math.ceil(t/V),Math.ceil(i/V),2)}this.#f===null&&(this.#f=[j(e,U,1,1),j(e,U,1,1)],this.#x=0,this.reset()),this.#h===null&&(this.#h=e.createBuffer(),e.bindBuffer(e.PIXEL_PACK_BUFFER,this.#h),e.bufferData(e.PIXEL_PACK_BUFFER,this.metrics.byteLength,e.STREAM_READ),e.bindBuffer(e.PIXEL_PACK_BUFFER,null))}}function j(o,e,t,i){const s=o.createFramebuffer();o.bindFramebuffer(o.FRAMEBUFFER,s);const r=[];for(let l=0;l<i;l++){const u=o.createTexture();o.bindTexture(o.TEXTURE_2D,u),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MIN_FILTER,o.NEAREST),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MAG_FILTER,o.NEAREST),o.texImage2D(o.TEXTURE_2D,0,o.RGBA32F,e,t,0,o.RGBA,o.FLOAT,null),o.framebufferTexture2D(o.FRAMEBUFFER,o.COLOR_ATTACHMENT0+l,o.TEXTURE_2D,u,0),r.push(u)}o.drawBuffers(r.map((l,u)=>o.COLOR_ATTACHMENT0+u));const n=o.checkFramebufferStatus(o.FRAMEBUFFER)===o.FRAMEBUFFER_COMPLETE;o.bindFramebuffer(o.FRAMEBUFFER,null);const a={framebuffer:s,textures:r,width:e,height:t};if(!n)throw Q(o,a),new Error("failed to allocate framebuffer");return a}function Q(o,{framebuffer:e,textures:t}){o.deleteFramebuffer(e);for(const i of t)o.deleteTexture(i)}function B(o,e=0,t=o.length){const i=new DataView(o.buffer,o.byteOffset,o.byteLength),s=[];for(let r=e;r<t;){if(r+8>t)throw new Error("Incomplete MP4 box");const n=i.getUint32(r);if(n<8||r+n>t)throw new Error("Invalid MP4 box size");s.push({type:String.fromCharCode(...o.subarray(r+4,r+8)),start:r,body:r+8,end:r+n}),r+=n}return s}function We(o,e){for(const t of B(o,e.body,e.end).filter(i=>i.type==="trak")){let i=t;for(const s of["mdia","minf","stbl","stsd"]){const r=B(o,i.body,i.end).find(n=>n.type===s);if(!r)break;i=r}if(i.type==="stsd")for(const s of B(o,i.body+8,i.end)){if(s.type!=="avc1")continue;const r=B(o,s.body+78,s.end).find(l=>l.type==="avcC");if(!r)throw new Error("AVC sample entry has no avcC");const n=o.slice(r.body,r.end);return{codec:"avc1."+Array.from(n.subarray(1,4)).map(l=>l.toString(16).padStart(2,"0")).join(""),description:n}}}return null}class $e{#i;#r=null;#e=null;#n=[];#t=0;#s=null;#a=[];#o=new Set;#u=!1;#f=!1;#x=!1;#h=!1;#v=!1;#b=new WeakMap;constructor(e){this.#i=e,e.addEventListener("seeking",this.#d),e.addEventListener("ratechange",this.#d)}get active(){return this.#h}append(e){if(this.#x)return;const t=new Uint8Array(e),i=new DataView(e);try{for(const r of B(t)){if(r.type==="moov"){this.#r=We(t,r);const n=this.#r;n&&VideoDecoder.isConfigSupported(n).then(a=>{this.#b.set(n,a.supported===!0)}).catch(a=>this.#g(a))}if(!(r.type!=="moof"||this.#r===null))for(const n of B(t,r.body,r.end).filter(a=>a.type==="traf")){const a=B(t,n.body,n.end),l=a.find(m=>m.type==="tfhd");if(!l||i.getUint32(l.body+4)!==1)continue;const u=a.find(m=>m.type==="tfdt"),h=a.find(m=>m.type==="trun");if(!u||!h||i.getUint32(u.body)!==16777216||i.getUint32(h.body)!==16781057)throw new Error("Unexpected mpeg2toh264 video fragment layout");let v=Number(i.getBigUint64(u.body+4)),f=r.start+i.getInt32(h.body+8);const c=i.getUint32(h.body+4);if(h.body+12+c*16>h.end)throw new Error("Incomplete video samples");for(let m=0;m<c;m++){const x=h.body+12+m*16,b=i.getUint32(x),E=i.getUint32(x+4),g=i.getUint32(x+8),T=i.getInt32(x+12);if(f<0||f+E>t.length)throw new Error("Video sample outside fragment");this.#n.push({config:this.#r,decodeTime:v/9e4,timestamp:Math.round((v+T)*1e6/9e4),duration:Math.round(b*1e6/9e4),type:g&65536?"delta":"key",data:t.subarray(f,f+E)}),v+=b,f+=E}}}const s=this.#i.buffered;if(s.length>0){let r=0;for(let n=0;n<(this.#h?this.#t:this.#n.length);n++){const a=this.#n[n];a.type==="key"&&a.timestamp/1e6<=s.start(0)&&(r=n)}r>0&&(this.#n.splice(0,r),this.#t=Math.max(0,this.#t-r))}}catch(s){this.#g(s)}}take(){if(this.#x||this.#i.playbackRate<=1.25||this.#r===null||this.#b.get(this.#r)!==!0){this.#h&&this.#d();return}this.#h||(this.#d(),this.#h=!0);const e=this.#i.currentTime;try{for(;this.#t<this.#n.length&&(this.#s?.decodeQueueSize??0)<6&&this.#a.length<12;){const i=this.#n[this.#t];if(i.decodeTime>e+.25)break;if(this.#e!==i.config){if(this.#s){if(!this.#f){this.#f=!0;const r=this.#s;r.flush().then(()=>{this.#s===r&&(r.close(),this.#s=null,this.#e=null,this.#f=!1)}).catch(n=>{this.#s===r&&this.#g(n)})}break}const s=new VideoDecoder({output:r=>{this.#s!==s?r.close():this.#A(r)},error:r=>{this.#s===s&&this.#g(r)}});this.#s=s,this.#s.configure(i.config),this.#e=i.config}(i.duration??0)<1e3&&this.#o.add(i.timestamp),this.#s.decode(new EncodedVideoChunk(i)),this.#t++}if(this.#u&&this.#t===this.#n.length&&this.#s&&!this.#f){this.#f=!0;const i=this.#s;i.flush().catch(s=>{this.#s===i&&this.#g(s)})}}catch(i){this.#g(i);return}const t=this.#a[0];return!t||t.timestamp/1e6>e+.003*this.#i.playbackRate?this.#v?null:void 0:(this.#v=!0,this.#a.shift())}#A=e=>{this.#o.delete(e.timestamp)||e.timestamp/1e6<this.#i.currentTime-(this.#v?.1:.04)?e.close():this.#a.push(e)};#d=()=>{this.#s&&this.#s.state!=="closed"&&this.#s.close(),this.#s=null,this.#e=null;for(const e of this.#a)e.close();this.#a=[],this.#o.clear(),this.#f=!1,this.#h=!1,this.#v=!1,this.#t=0;for(let e=0;e<this.#n.length;e++){const t=this.#n[e];t.type==="key"&&t.timestamp/1e6<=this.#i.currentTime&&(this.#t=e)}};finish(){this.#u=!0}suspend(){this.#d()}reset(){this.#d(),this.#n=[],this.#t=0,this.#r=null,this.#u=!1,this.#x=!1}destroy(){this.reset(),this.#i.removeEventListener("seeking",this.#d),this.#i.removeEventListener("ratechange",this.#d)}#g(e){this.#d(),this.#x=!0,console.warn("mpeg2toh264: decoded video input unavailable",e)}}const ve=["mozParsedFrames","mozDecodedFrames","mozPresentedFrames","mozPaintedFrames"];function Ve(o){return ve.every(e=>e in o)}function qe(o){return o.ownerDocument?.defaultView?.performance.timeOrigin??performance.timeOrigin}const Ye=250,Ke=500;class je{#i;#r;#e;#n=null;#t=null;#s=null;#a=null;#o=!1;#u=!0;#f=null;#x=null;#h=0;#v;#b;#A=null;#d=null;#g=null;#m=null;#_=0;#T=[];#N=[];constructor(e,t){if(this.#i=e,this.#r=t,this.#e=Ve(e)?e:null,this.#v=typeof VideoFrame<"u",this.#b=this.#v&&e.playbackRate>1,this.#e){for(const i of["emptied","seeking","seeked"])e.addEventListener(i,this.#L);for(const i of["pause","playing","waiting","ratechange"])e.addEventListener(i,this.#H)}if(this.#v)for(const i of["loadeddata","playing","pause","ended","seeking","seeked","emptied","ratechange"])e.addEventListener(i,this.#l)}get mozDriven(){return this.#e!==null&&!this.#b}get captureDriven(){return this.#b}get hasDelivered(){return this.#o}request(e){if(this.#t===null){if(this.#t=e,this.#b){this.#w();return}this.#n=this.#e?requestAnimationFrame(this.#me):this.#i.requestVideoFrameCallback(this.#he)}}cancel(){this.#n!==null&&(this.#e?cancelAnimationFrame(this.#n):this.#i.cancelVideoFrameCallback(this.#n)),this.#n=null,this.#t=null,this.#A?.(),this.#A=null,this.#g!==null&&this.#i.cancelVideoFrameCallback(this.#g),this.#g=null,this.#D(),this.#m=null,this.#T=[],this.#L()}destroy(){this.cancel();for(const e of["emptied","seeking","seeked"])this.#i.removeEventListener(e,this.#L);for(const e of["pause","playing","waiting","ratechange"])this.#i.removeEventListener(e,this.#H);for(const e of["loadeddata","playing","pause","ended","seeking","seeked","emptied","ratechange"])this.#i.removeEventListener(e,this.#l)}flush(e){if(this.#b)for(this.#i.ownerDocument!==this.#d&&(this.#A?.(),this.#A=null,this.#w());this.#N.length>0&&this.#t!==null;){const t=this.#N.shift(),i=t.frame;try{this.#de(e,{width:i.visibleRect?.width??i.codedWidth,height:i.visibleRect?.height??i.codedHeight,mediaTime:i.timestamp/1e6,presentedFrames:t.count,expectedDisplayTime:t.at,timeOrigin:performance.timeOrigin,frame:i})}finally{i.close()}}}#D(){for(const e of this.#N)e.frame.close();this.#N=[]}#l=e=>{const t=this.#v&&this.#i.playbackRate>1;if(t!==this.#b){const i=this.#t;this.cancel(),this.#b=t,i!==null&&this.request(i);return}this.#b&&((e.type==="pause"||e.type==="ended")&&this.flush(performance.now()),this.#D(),["seeking","seeked","emptied","ratechange"].includes(e.type)&&(this.#m=null,this.#T=[]),this.#A?.(),this.#A=null,this.#t!==null&&this.#w())};#w(){if(this.#A!==null||this.#t===null||(this.#i.paused||this.#i.ended)&&this.#m!==null)return;this.#g===null&&typeof this.#i.requestVideoFrameCallback=="function"&&(this.#g=this.#i.requestVideoFrameCallback(this.#fe));const e=Math.max(4,8/Math.max(1,this.#i.playbackRate)),t=this.#i.ownerDocument?.defaultView;if(this.#d=this.#i.ownerDocument,t){const i=t.setTimeout(this.#I,e);this.#A=()=>t.clearTimeout(i)}else{const i=setTimeout(this.#I,e);this.#A=()=>clearTimeout(i)}}#fe=()=>{this.#g=null,this.#A?.(),this.#A=null,this.#I()};#I=()=>{this.#A=null;const e=this.#i;if(this.#t===null)return;if(e.readyState<2||e.seeking){this.#w();return}let t,i=!1;try{const s=this.#r?.();if(s===null){this.#w();return}i=s!==void 0,t=s??new VideoFrame(e)}catch(s){if(!(s instanceof DOMException)||s.name!=="InvalidStateError")throw s;this.#w();return}if(t.timestamp===this.#m)t.close();else{let s=1;if(this.#m!==null){const n=t.timestamp-this.#m;if(n>1e3&&n<25e4){this.#T.push(n),this.#T.length>7&&this.#T.shift();const a=[...this.#T].sort((u,h)=>u-h),l=a[Math.floor(a.length/2)];s=Math.max(1,Math.round(n/l))}}this.#m=t.timestamp,this.#_+=s;const r=performance.now()+(i?(t.timestamp/1e6-e.currentTime)*1e3/e.playbackRate:0);for(this.#N.push({frame:t,at:r,count:this.#_});this.#N.length>4;)this.#N.shift().frame.close()}this.#w()};#H=()=>{this.#f=null,this.#x=null,this.#h=0};#L=()=>{this.#s=null,this.#a=null,this.#u=!0,this.#H()};#he=(e,t)=>{this.#de(e,{width:t.width,height:t.height,mediaTime:t.mediaTime,presentedFrames:t.presentedFrames,expectedDisplayTime:t.expectedDisplayTime,timeOrigin:qe(this.#i)})};#de=(e,t)=>{const i=this.#t;this.#n=null,this.#t=null,this.#o=!0,i?.(e,t)};#me=e=>{const t=this.#e,i=ve.map(a=>t[a]);this.#s?.some((a,l)=>i[l]<a)&&this.#L(),this.#s=i;const s=t.mozPaintedFrames,r=!t.seeking&&t.readyState>=2&&t.videoWidth>0&&t.videoHeight>0,n=this.#a===null&&(s>0||t.paused&&(t.mozPresentedFrames>0||t.mozDecodedFrames>0));if(r&&(n||this.#a!==null&&s!==this.#a)){if(this.#f!==null&&e-this.#f>Ke&&(this.#H(),this.#u=!0),!t.paused&&!t.ended){const l=this.#x;if(l&&e-l.at>=Ye){const u=s-l.frames;if(u>0){const h=(e-l.at)/u;h>=4&&h<=200&&(this.#h=this.#h?this.#h+(h-this.#h)*.25:h)}this.#x=null}this.#x??={at:e,frames:s}}this.#f=e,this.#a=s;const a=this.#u;this.#u=!1,this.#de(e,{width:t.videoWidth,height:t.videoHeight,mediaTime:t.currentTime,presentedFrames:s,expectedDisplayTime:e,timeOrigin:performance.timeOrigin,mozTiming:{periodMs:this.#h,discontinuity:a}})}else this.#n=requestAnimationFrame(this.#me)}}let Qe=null;const Ee=.5,R=4,ne=5,N=ne+1,xe=1e3,oe=4,J=200,Je=.25,Ze=1e3/60,et=250,tt=1e3/30;function be(o){if(!Number.isFinite(o)||o<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return o}const it=`#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`,st=.75,rt=.1,ge=1,nt=.02,ot=.1,ye=1,ht=4,he=5,at=4,lt={2:0,3:.25,4:.5,5:.75},ct=3,ut=`#version 300 es
precision highp float;
uniform sampler2D uField;
uniform bool uFlip;
out vec4 fragColor;
void main() {
  ivec2 position = ivec2(gl_FragCoord.xy);
  if (uFlip) position.y = textureSize(uField, 0).y - 1 - position.y;
  fragColor = texelFetch(uField, position, 0);
}
`,ft={requestAnimationFrame:o=>requestAnimationFrame(o),cancelAnimationFrame:o=>cancelAnimationFrame(o)};class dt extends EventTarget{encodedVideo;#i;#r;#e;#n;#t;#s=null;#a;#o;#u;#f;#x;#h=null;#v=null;#b=null;#A=null;#d=null;#g=null;#m=null;#_=[];#T=[];#N=N-1;#D=null;#l=[];#w=null;#fe=0;#I=null;#H=null;#L=Ze;#he=0;#de=0;#me=0;#ae=0;#ee=null;#G(){this.#l.length=0,this.#ee=null,this.#ae=0}#pe=null;#ft;#W;#p;#ve;#Ee;#te="video";#ke="c";#dt=0;#mt=!0;#pt=new A(S,D);#vt=1/0;#Et=1/0;#le=0;#j;#P;#y=0;#C=0;#O=0;#k=R-1;#F=0;#Pe=0;#xt=0;#Ke=Number.NaN;#Le=!1;#je=0;#xe=0;#bt=0;#M=!1;#Q=0;#Qe=!1;#X=!1;#R=null;#be=[];#$=!1;#gt;#yt;#S;#ge;#ie;#Tt;#c=null;#E;#Ue=!1;#Ft=0;#Rt=!1;#fi=0;#Ie=!1;#Je=!1;#ye=null;#di=0;#Be=new Map;#U={filtered:0,missed:0,degraded:0,discontinuities:0,resynced:0,late:0,queueResetted:0};#se=0;#At=0;#Ze=0;#ce=0;#Ne=0;#Oe=0;#ze=0;#Te=0;#Fe;#et=[];#Re=[];#Ge=0;#Ae=0;#Xe=0;#_e=0;#He=I;#Me=0;#B=I;#J=!1;#Se=null;#$t="";#tt=[0,0,0,0,0,0];#_t=0;#V=null;#it=0;#st=null;#Mt=0;constructor(e,t={},i=null){super(),this.#e=e,this.#W=t.doubleRate??!1,this.#p=t.autoFilm??!1,this.#ve=be(t.filmCombThreshold??A.COMBED_PIXEL_LIMIT),this.#Ee=t.spatialCheck??!0,this.#j=t.debug??!1,this.#P=t.film??!1,this.#gt=t.onStats,this.#yt=t.onFailure,this.#S=i,this.#ie=i?"main":t.rendering??"main",this.#Tt=t.workerUrl??Qe,this.#E=this.#ie==="main"?"main":"idle",this.#r=i?i.canvas:document.createElement("canvas"),this.#i=i?.canvas??(this.#ie==="main"?this.#r:document.createElement("canvas")),this.#ge=e,i||(this.#r.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const s=this.#i.getContext("webgl2",{alpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!(s instanceof WebGL2RenderingContext))throw new Error("this browser has no WebGL2");this.#t=s,this.#P&&!this.#p&&(this.#qt(),this.#s=new pe(s)),this.#a=q(s,ze);const r=this.#a;this.#o=Object.fromEntries(Object.entries(Oe).map(([n,a])=>[n,s.getUniformLocation(r,a)])),this.#u=q(s,ut),this.#f=s.getUniformLocation(this.#u,"uField"),this.#x=s.getUniformLocation(this.#u,"uFlip"),this.#p&&this.#ti(),this.#Fe=s.getExtension("EXT_disjoint_timer_query_webgl2"),this.#i.addEventListener("webglcontextlost",this.#ui),this.#ft=i?null:new ResizeObserver(()=>this.#ut()),this.encodedVideo=!i&&typeof VideoDecoder<"u"?new $e(e):null,this.#n=new je(e,()=>this.encodedVideo?.take()),e.addEventListener("emptied",this.#ai),e.addEventListener("resize",this.#hi),e.addEventListener("pause",this.#oe),e.addEventListener("ended",this.#oe),e.addEventListener("seeking",this.#ci),e.addEventListener("seeked",this.#oe),e.addEventListener("ratechange",this.#oe)}get running(){return this.#M&&(this.#R?.interlaced??!0)}get canvas(){return this.#r}get#rt(){return this.#R?.topFieldFirst!==!1}#Vt(){return{doubleRate:this.#W,autoFilm:this.#p,filmCombThreshold:this.#ve,spatialCheck:this.#Ee,film:this.#P,debug:this.#j}}get enabled(){return this.#Qe}set enabled(e){this.#Qe=e,this.#Dt(),this.#c?.postMessage({type:"enabled",enabled:e})}set scan(e){const t=this.#R?.interlaced!==e?.interlaced,i=t||this.#R?.topFieldFirst!==e?.topFieldFirst;this.#R=e,!(i&&(!this.#re()||this.#R!==e))&&(this.#c?.postMessage({type:"scan",scan:e}),i&&(this.#F=0,this.#z(),this.#Y(),t&&(this.#y=0),this.#D=null,this.#Z(!1)),this.#Dt(),i&&((e?.interlaced??!0)&&(this.#S||this.#E==="main")?this.#we():this.#Ut()))}get scan(){return this.#R}set videoTimeline(e){this.#be=e,this.#c?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#R=null),this.#Dt()}get videoTimeline(){return this.#be}get container(){return this.#pe??this.#e}get doubleRate(){return this.#W}set doubleRate(e){e!==this.#W&&(this.#W=e,this.#q(),this.#G(),this.#St())}get spatialCheck(){return this.#Ee}set spatialCheck(e){e!==this.#Ee&&(this.#Ee=e,this.#q())}get film(){return this.#P}set film(e){if(this.#p){this.#P=e,this.#q();return}const t=this.#c?this.#st:this.#V;if(!(e===this.#P&&(e===!1||t===null))){if(this.#c){this.#P=e,this.#q(e?"film":void 0);return}if(e){if(!this.#re())return;try{this.#Yt()}catch(i){this.#P=!0,this.#q(),this.#We(`film detector unavailable: ${i instanceof Error?i.message:String(i)}`);return}}if(this.#P=e,this.#q(),!e){if(!this.#re())return;this.#J=!1,this.#B=I,this.#Y(),this.#s?.destroy(),this.#s=null}this.#St()}}get debug(){return this.#j}set debug(e){e!==this.#j&&(this.#j=e,this.#q())}get#mi(){return this.#W||this.#P||this.#p}#St(){this.#X||(this.#mi?(this.#C>0&&this.#Ht(),(this.#R?.interlaced??!0)&&(this.#S||this.#E==="main")&&this.#we()):!this.#p&&!this.#P&&(this.#D=null,this.#Z(!1),this.#Ye()))}get autoFilm(){return this.#p}set autoFilm(e){const t=this.#c?this.#st:this.#V;if(!(e===this.#p&&(!e||t===null))){if(this.#p=e,this.#c){this.#q(e?"autoFilm":void 0);return}if(this.#q(),this.#z(),e){if(this.#Y(),this.#s?.destroy(),this.#s=null,!this.#re()||this.#p!==e)return;this.#C>0&&this.#Ht(),(this.#R?.interlaced??!0)&&(this.#S||this.#E==="main")&&this.#we()}else{if(!this.#re()||this.#p!==e)return;this.#Xt(),this.#St()}}}get filmCombThreshold(){return this.#ve}set filmCombThreshold(e){const t=be(e);t!==this.#ve&&(this.#ve=t,this.#q(),this.#p&&this.#z())}#q(e){this.#c?.postMessage({type:"settings",options:this.#Vt(),retryFilm:e})}#qt(){if(this.#t.getExtension("EXT_color_buffer_float")===null)throw new Error("film needs EXT_color_buffer_float")}#Yt(){this.#qt(),this.#s??=new pe(this.#t),this.#C>0&&this.#s.resize(this.#C,this.#O)}#Dt(){this.#Qe&&(this.#be.length>0||(this.#R?.interlaced??!0))?this.start():this.stop()}#pi(){return this.#S||this.#ie==="main"?!1:this.#E==="starting"||this.#E==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#Tt!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#Kt(),!0):this.#ie==="auto"?(this.#nt(),!1):(this.#E="failed",this.#M=!1,!0)}#Kt(){this.#ne(),this.#c?.terminate(),this.#c=null,this.#Ie=!1,this.#Je=!1,this.#st=null,this.#Mt=0;let e=this.#r;if(this.#Rt){e=document.createElement("canvas"),e.className=this.#r.className;const r=this.#r.getAttribute("style");r===null?e.removeAttribute("style"):e.setAttribute("style",r),e.style.visibility="hidden",this.#r.parentElement&&this.#r.replaceWith(e),this.#r=e}const t=++this.#Ft;this.#E="starting";let i,s;try{s=e.transferControlToOffscreen(),this.#Rt=!0,i=new Worker(this.#Tt,{type:"module"})}catch(r){this.#$e(r instanceof Error?r.message:String(r));return}this.#c=i,i.onmessage=r=>{t===this.#Ft&&this.#vi(r.data)},i.onerror=r=>{t===this.#Ft&&(r.preventDefault(),this.#$e(r.message||"the deinterlacer worker failed"))},i.postMessage({type:"initialize",canvas:s,options:this.#Vt(),scan:this.#R,videoTimeline:this.#be,enabled:this.#M,video:this.#Ct()},[s])}#vi(e){switch(e.type){case"ready":this.#E="active",this.#M&&(this.#Ve(),this.#Ot());break;case"failed":this.#$e(e.message);break;case"consumed":{this.#Ie=!1,this.#Je=!0;const t=this.#ye;this.#ye=null,t&&this.#Qt(t);break}case"visibility":this.#r.style.visibility=e.visible?"visible":"hidden";break;case"stats":{const t={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0},i=t.filmError??null,s=this.#Mt;if(this.#st=i,this.#Mt=e.filmFailure,i!==null&&e.filmFailure!==s){this.dispatchEvent(new CustomEvent("failure",{detail:i}));try{this.#yt?.(i)}catch{}}this.dispatchEvent(new CustomEvent("stats",{detail:t})),this.#gt?.(t);break}case"capture":{const t=this.#Be.get(e.id);if(this.#Be.delete(e.id),!t){e.image?.close();break}e.image?t.resolve(e.image):createImageBitmap(this.#e).then(t.resolve,t.reject);break}}}#wt(e){if(this.dispatchEvent(new CustomEvent("failure",{detail:e})),!this.#S)try{this.#yt?.(e)}catch{}}#We(e){this.#V!==e&&(this.#V=e,this.#J=!1,this.#B=I,this.#Y(),this.#it=0,this.#s?.destroy(),this.#s=null,this.#wt(e))}#re(){if(this.#X)return!1;if(this.#c)return!0;const e=this.#Q;if(this.#V=null,this.#it=0,this.#p)try{this.#ti(),this.#C>0&&this.#Ii()}catch(t){this.#We(`autoFilm programs unavailable: ${t instanceof Error?t.message:String(t)}`)}return!this.#X&&e===this.#Q}#$e(e){if(this.#E==="starting"&&this.#ie==="auto"&&!this.#Ue){this.#nt();return}if(this.#jt(e),!this.#Ue){this.#Ue=!0,this.#Kt();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#E="failed",this.#c?.terminate(),this.#c=null,this.#ne(),this.#wt(`deinterlacer worker stopped: ${e}`),this.stop()}#nt(){const e=this.#i;e.className=this.#r.className;const t=this.#r.getAttribute("style");t===null?e.removeAttribute("style"):e.setAttribute("style",t),e.style.visibility="hidden",this.#r.parentElement&&this.#r.replaceWith(e),this.#r=e,this.#Rt=!1,this.#c?.terminate(),this.#c=null,this.#E="main",this.#ne(),this.#M&&(this.#Ve(),this.#Ot(),(this.#R?.interlaced??!0)&&this.#we())}#ne(){this.#ye?.frame.close(),this.#ye=null}#jt(e){for(const t of this.#Be.values())t.reject(new Error(e));this.#Be.clear()}start(){if(!(this.#M||this.#X||this.#$)&&(this.#Q++,this.#M=!0,this.#li(),this.#z(),!!this.#re())){if(this.#je=performance.now(),this.#bt=this.#je,this.#Ke=Number.NaN,this.#xe=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#Bi(),this.#Ot(),this.#pi()){this.#c?.postMessage({type:"enabled",enabled:!0}),this.#E==="active"&&this.#Ve();return}this.#Ve(),(this.#R?.interlaced??!0)&&this.#we()}}stop(){this.#Q++,this.#M&&(this.#M=!1,this.#n.cancel(),this.encodedVideo?.suspend(),this.#Di(),this.#Ut(),this.#F=0,this.#D=null,this.#Z(!1),this.#ne(),this.#c?.postMessage({type:"enabled",enabled:!1}))}destroy(){if(!this.#X){this.#X=!0,this.#Qe=!1,this.stop(),this.#c?.postMessage({type:"destroy"}),this.#c?.terminate(),this.#c=null,this.#ne(),this.#jt("the deinterlacer was destroyed"),this.#H?.removeEventListener("visibilitychange",this.#Nt),this.#H=null,this.#i.removeEventListener("webglcontextlost",this.#ui),this.#n.destroy(),this.encodedVideo?.destroy(),this.#e.removeEventListener("emptied",this.#ai),this.#e.removeEventListener("resize",this.#hi),this.#e.removeEventListener("pause",this.#oe),this.#e.removeEventListener("ended",this.#oe),this.#e.removeEventListener("seeking",this.#ci),this.#e.removeEventListener("seeked",this.#oe),this.#e.removeEventListener("ratechange",this.#oe),this.#Ni();for(const e of this.#_)this.#t.deleteTexture(e);this.#_=[],this.#Ye(),this.#Xt();for(const e of[...this.#et,...this.#Re.map(({q:t})=>t)])this.#t.deleteQuery(e);this.#et.length=0,this.#Re.length=0,this.#s?.destroy(),this.#s=null,this.#Se!==null&&(we(this.#Se),this.#Se=null),this.#t.deleteProgram(this.#a),this.#t.deleteProgram(this.#u),this.#h&&this.#t.deleteProgram(this.#h),this.#b&&this.#t.deleteProgram(this.#b),this.#d&&this.#t.deleteProgram(this.#d),this.#t.getExtension("WEBGL_lose_context")?.loseContext()}}capture(){if(this.#E==="active"&&this.#r.style.visibility==="visible"&&this.#c){const s=++this.#di,r=new Promise((n,a)=>{this.#Be.set(s,{resolve:n,reject:a})});return this.#c.postMessage({type:"capture",id:s,width:this.#e.videoWidth,height:this.#e.videoHeight}),r}if(this.#E==="starting"||this.#E==="failed")return createImageBitmap(this.#e);const e=this.#D;if(this.#S&&(!this.#M||this.#$||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#M||this.#$||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#Gt(e.texture,e.flip,!1):e.kind==="yadif"?this.#ue(e.flush,e.second,null,!1):this.#Pt(null,!1);const t=this.#e.videoWidth,i=this.#e.videoHeight;return t>0&&i>0&&(t!==this.#i.width||i!==this.#i.height)?createImageBitmap(this.#i,{resizeWidth:t,resizeHeight:i,resizeQuality:"high"}):createImageBitmap(this.#i)}addEventListener(e,t,i){super.addEventListener(e,t,i)}removeEventListener(e,t,i){super.removeEventListener(e,t,i)}#Ve(){this.#S||!this.#M||this.#n.request(this.#Fi)}#Ct(){const e=[];for(let t=0;t<this.#e.buffered.length;t++)e.push({start:this.#e.buffered.start(t),end:this.#e.buffered.end(t)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#Ei(e,t,i){let s;try{s=i?.clone()??new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(t.mediaTime*1e6))})}catch(n){const a=n instanceof Error?n.message:String(n);this.#ie==="auto"&&!this.#Je&&!this.#Ue?(this.#nt(),this.#ot(e,t)):this.#$e(a);return}const r={id:++this.#fi,frame:s,now:e,metadata:t,video:this.#Ct()};if(this.#Ie){this.#ye?.frame.close(),this.#ye=r;return}this.#Qt(r)}#Qt(e){const t=this.#c;if(!t||this.#E!=="active"){e.frame.close();return}this.#Ie=!0;const i={type:"frame",id:e.id,frame:e.frame,metadata:e.metadata,video:e.video};try{t.postMessage(i,[e.frame])}catch(s){this.#Ie=!1,e.frame.close();const r=s instanceof Error?s.message:String(s);this.#ie==="auto"&&!this.#Je&&!this.#Ue?(this.#nt(),this.#ot(e.now,e.metadata)):this.#$e(r)}}#xi(e,t,i){this.#Se==null&&(this.#Se=Se(this.#t,"20px monospace")),Ce(this.#Se,e,t,i,this.#C,this.#O,20)}#Jt(e){if(this.#Fe==null||this.#Re.length>30)return;const t=this.#et.pop()??this.#t.createQuery();return this.#t.beginQuery(this.#Fe.TIME_ELAPSED_EXT,t),this.#Re.push({q:t,isField:e}),t}#qe(e){this.#Fe!=null&&(e!=null&&this.#t.endQuery(this.#Fe.TIME_ELAPSED_EXT),this.#Re=this.#Re.filter(({q:t,isField:i})=>{if(this.#t.getQueryParameter(t,this.#t.QUERY_RESULT_AVAILABLE)){const s=this.#t.getQueryParameter(t,this.#t.QUERY_RESULT);return i?(this.#Xe+=s,this.#_e++):(this.#Ge+=s,this.#Ae++),this.#et.push(t),!1}return!0}))}#Y(){this.#B=I,this.#He=I,this.#Me=0,this.#J=!1,this.#s?.reset()}#bi(){const{cur:e,next:t}=this.#ni(!1),i=this.#_[e],s=this.#_[t];if(!i||!s)return;const r=this.#R?.topFieldFirst!==!1?0:1;this.#s?.detect(i,s,r)}#gi(){const e=this.#s?.poll()??null;e!==null&&(this.#He=e,this.#Me=e.age),this.#Me++;const{phase:t,run:i}=this.#He;t===0||this.#Me>Math.ceil(he*Math.max(1,this.#e.playbackRate))?this.#B=I:this.#B={phase:(t-1+this.#Me)%he+1,run:i}}#yi(e){const t=[],i=this.#s?.metrics??new Float32Array(0);for(let r=0;r<y.phase;r++){const n=i[r*4]??0,a=i[r*4+1]??0,l=i[r*4+2]??0;t.push(`${n.toFixed(3)},${a.toString().padStart(4)},${l.toFixed(3)}`)}const s=this.#tt.map((r,n)=>`${n===0?"-":n}:${r}`).join(" ");return`frame=${e} phase=${this.#B.phase} run=${this.#B.run} known=${this.#He.phase}/${this.#He.run} age=${this.#Me} ${this.#J?"film":"video"} period=${this.#y.toFixed(3)}
${t.join(" ")}
${s} dropped:${this.#_t}`}#kt(e,t){const i=t-performance.timeOrigin;return Number.isFinite(i)&&i!==0?e+i:e}#Ti(e,t){const i=e.expectedDisplayTime;if(!Number.isFinite(i)||i<=0||!Number.isFinite(e.timeOrigin))return t;const s=this.#kt(i,e.timeOrigin),r=ht*Math.max(this.#L,this.#y);return s<t-r||s>t+r?t:s}#Fi=(e,t)=>{if(!this.#M||this.#$)return;this.#Bt();const i=this.#kt(e,t.timeOrigin);this.#je=i,this.#xe=Math.max(this.#xe,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0);const{frame:s,...r}=t;this.#ge=s??this.#e;try{this.#Zt(i,r,s)}finally{this.#ge=this.#e}this.#Ve()};#Zt(e,t,i){if(this.#Ke=t.mediaTime,this.#E==="active"){this.#Ei(e,t,i);return}this.#E!=="starting"&&this.#ot(e,t)}ingestExternalFrame(e,t,i){this.#ge=i;try{this.#ot(e,t)}finally{this.#ge=this.#e}}#ot(e,t){const i=this.#Q;if(this.#K(i)&&(this.#Ri(t.mediaTime),!!this.#K(i)&&t.width>0&&t.height>0)){let s=!1;if(!this.#Le&&this.#e.seeking){const d=this.#e.buffered,p=this.#y>=oe?this.#y/1e3:J/1e3;for(let F=0;F<d.length;F++)if(t.mediaTime>=d.start(F)&&t.mediaTime<d.end(F)&&Math.abs(t.mediaTime-this.#e.currentTime)<=p){s=!0;break}}if(s&&(this.#Le=!0),(this.#C===0||this.#O===0)&&this.#oi(t.width,t.height),!this.#K(i))return;if(this.#R&&!this.#R.interlaced){this.#Pi();return}const r=t.mediaTime-this.#Pe,n=t.mozTiming,a=s||(n?n.discontinuity||r<0||r>Ee:r<0||r>Ee);a&&(this.#F=0,this.#y=0,this.#U.discontinuities++,this.#G(),this.#z(),this.#Y());const l=this.#p&&this.#se!==0&&t.presentedFrames-this.#se>1,u=this.#Li(t.presentedFrames,a);if(!a&&l&&(this.#F=0,this.#z()),this.#F>0&&t.mediaTime===this.#Pe&&(!n||t.presentedFrames===this.#xt))return;if(!a){const d=n?.periodMs??0;d>0?this.#ei(d*(this.#e.playbackRate||1)/1e3,1):this.#F>0&&r>0&&this.#ei(r,u+1)}this.#Pe=t.mediaTime,this.#xt=t.presentedFrames;const h=performance.now();h-this.#At>xe&&(this.#Ze=h,this.#ce=0,this.#Ne=0,this.#Oe=0,this.#ze=0,this.#Te=0,this.#le=0,this.#Ge=0,this.#Ae=0,this.#Xe=0,this.#_e=0),this.#At=h;const v=performance.now(),f=this.#Jt(!1);this.#ri();const c=this.#te,m=this.#p&&!this.#V&&this.#F===R?this.#Ai():!1;if(m==="unavailable"?++this.#it>=ct&&this.#We("autoFilm analysis unavailable: the GPU analysis target or programs would not allocate"):this.#it=0,!this.#K(i)){this.#X||this.#qe(f);return}const x=m===!0;c!==this.#te&&this.#G();const E=x&&this.#De();if(this.#P&&!this.#p&&!this.#V&&!this.#s)try{this.#Yt()}catch(d){this.#We(`film detector unavailable: ${d instanceof Error?d.message:String(d)}`)}if(!this.#K(i)){this.#X||this.#qe(f);return}if(this.#P&&!this.#p&&!this.#V){if(this.#F===R&&u===0)try{this.#gi(),this.#bi()}catch(d){this.#We(`film detection failed: ${d instanceof Error?d.message:String(d)}`)}else this.#Y();this.#tt[this.#B.phase]=(this.#tt[this.#B.phase]??0)+1,this.#J=this.#B.phase!==0&&this.#B.run>=ie,this.#j&&(this.#$t=this.#yi(t.presentedFrames))}if(!this.#K(i)){this.#X||this.#qe(f);return}const T=this.#Ti(t,e)+this.#L;if(E)this.#ae++;else if(this.#p&&!this.#V&&!this.#mt&&this.#te==="film")if(this.#De()){const d=this.#y*5/4,F=this.#lt(1,e,d)||this.#ee===null?T+d:T;this.#_i(this.#at("film",F,d),d)}else this.#Pt(null);else if(this.#J&&!this.#p)if(this.#De()){const d=this.#B.phase;if(d===te)this.#_t++,this.#ae++;else{const p=this.#y*he/at,F=this.#lt(1,e,p),w=lt[d]??0,O=F||this.#ee===null?T+p:T+w*this.#y;this.#ht("film",!1,this.#at("film",O,p),p)}}else this.#ue(!1,!1,null);else if(this.#W&&this.#De()){const d=this.#y/2,F=this.#lt(2,e,d)||this.#ee===null?T+d*2:T,w=this.#at("field",F,d);this.#ht("field",!1,w,d),this.#ht("field",!0,w+d,d)}else if(this.#De()){const d=this.#y,F=this.#lt(1,e,d)||this.#ee===null?T+d:T;this.#ht("frame",!1,this.#at("frame",F,d),d)||(this.#U.late++,this.#ue(!1,!1,null))}else this.#U.late+=this.#l.length,this.#G(),this.#ue(!1,!1,null);this.#Te=Math.max(this.#Te,this.#l.length),this.#qe(f),this.#Ne+=performance.now()-v,this.#ce++,this.#Ui(h)}}#K(e){return!this.#X&&this.#M&&e===this.#Q}#Ri(e){const t=this.#Q;let i;for(let n=this.#be.length-1;n>=0;n--){const a=this.#be[n];if(a.start<=e+1e-6){i=a;break}}if(i?.codedSize&&(i.codedSize.width!==this.#C||i.codedSize.height!==this.#O)&&this.#oi(i.codedSize.width,i.codedSize.height),!this.#K(t))return;const s=i?.scan;if(!s||this.#R?.interlaced===s.interlaced&&this.#R.topFieldFirst===s.topFieldFirst)return;const r=this.#R?.interlaced;this.#R=s,this.#F=0,this.#G(),this.#z(),this.#re()&&(r!==s.interlaced&&(this.#y=0),s.interlaced&&(this.#S||this.#E==="main")?this.#we():this.#Ut(),this.#Y())}#De(){return(this.#W||this.#p||this.#P)&&this.#y>0&&this.#T.length===N}#ei(e,t){const s=e*1e3/(this.#e.playbackRate||1)/t;s<oe||s>J||(this.#y=this.#y>0&&s>this.#y*st?this.#y+(s-this.#y)*Je:s)}#ti(){if(this.#h&&this.#b&&this.#d)return;const e=this.#t,t=[];let i,s,r;try{i=q(e,Ge),t.push(i),s=q(e,Xe),t.push(s),r=q(e,He),t.push(r)}catch(n){for(const a of t)e.deleteProgram(a);throw n}this.#h=i,this.#v=Object.fromEntries(Object.entries(se).filter(([n])=>n!=="match"&&n!=="topFieldFirst").map(([n,a])=>[n,e.getUniformLocation(i,a)])),this.#b=s,this.#A=Object.fromEntries(Object.entries(se).map(([n,a])=>[n,e.getUniformLocation(s,a)])),this.#d=r,this.#g=Object.fromEntries(Object.entries(se).map(([n,a])=>[n,e.getUniformLocation(r,a)]))}#Ai(){const e=this.#m,t=this.#h,i=this.#v,s=this.#d,r=this.#g;if(!e||!t||!i||!s||!r)return"unavailable";const n=this.#t,a=this.#k,l=(this.#k+R-1)%R,u=(this.#k+R-2)%R,h=this.#rt;n.bindFramebuffer(n.FRAMEBUFFER,e.framebuffer),n.useProgram(t);for(const[E,g]of[u,l,a].entries())n.activeTexture(n.TEXTURE0+E),n.bindTexture(n.TEXTURE_2D,this.#_[g]??null);n.uniform1i(i.prev,0),n.uniform1i(i.cur,1),n.uniform1i(i.next,2),n.uniform2i(i.size,this.#C,this.#O),n.viewport(0,0,S,D),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,S,D,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const{previousLuma:v,currentLuma:f,nextLuma:c}=e;for(let E=0;E<v.length;E++){const g=E*4;v[E]=e.pixels[g]??0,f[E]=e.pixels[g+1]??0,c[E]=e.pixels[g+2]??0}const m=this.#pt.fieldMatch(v,f,c,h,this.#ve);n.useProgram(s),n.uniform1i(r.prev,0),n.uniform1i(r.cur,1),n.uniform1i(r.next,2),n.uniform2i(r.size,this.#C,this.#O),n.uniform1i(r.topFieldFirst,h?1:0),n.uniform1i(r.match,m.match==="p"?0:m.match==="c"?1:2),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,S,D,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const x=this.#pt.decimate(e.pixels);this.#ke=m.match,this.#dt=m.combScore,this.#mt=m.isCombed,this.#vt=x.lowestCycleDifference,this.#Et=x.runnerUpCycleDifference;const b=x.dropIndex!==null&&!m.isCombed;return(b?"film":"video")!==this.#te&&(this.#te=b?"film":"video"),x.shouldDrop&&!m.isCombed}#_i(e,t){const i=this.#Lt();if(i===null)return;const s=this.#T[i];if(!s)return;for(this.#N=i;this.#l.length>0&&this.#l[0]?.slot===i;)this.#l.shift(),this.#U.late++;this.#Pt(s.framebuffer);const r={slot:i,at:e,duration:t,cadence:"film",phase:0,droppedBefore:this.#ae};this.#ae=0,this.#l.push(r),this.#ee=r}#Pt(e,t=!0){const i=this.#b,s=this.#A;if(!i||!s)return;const r=this.#t,n=this.#k,a=(this.#k+R-1)%R,l=(this.#k+R-2)%R,u=this.#rt;r.bindFramebuffer(r.FRAMEBUFFER,e),r.useProgram(i);for(const[h,v]of[l,a,n].entries())r.activeTexture(r.TEXTURE0+h),r.bindTexture(r.TEXTURE_2D,this.#_[v]??null);r.uniform1i(s.prev,0),r.uniform1i(s.cur,1),r.uniform1i(s.next,2),r.uniform2i(s.size,this.#C,this.#O),r.uniform1i(s.topFieldFirst,u?1:0),r.uniform1i(s.match,this.#ke==="p"?0:this.#ke==="c"?1:2),r.viewport(0,0,this.#C,this.#O),r.drawArrays(r.TRIANGLES,0,3),e===null&&(this.#D={kind:"film"},this.#Z(!0),t&&this.#le++)}#ht(e,t,i,s){const r=this.#Lt();if(r===null)return!1;const n=this.#T[r];if(!n)return!1;for(this.#N=r;this.#l.length>0&&this.#l[0]?.slot===r;)this.#l.shift(),this.#U.late++;this.#ue(!1,t,n.framebuffer);const a={slot:r,at:i,duration:s,cadence:e,phase:e==="film"?this.#B.phase:e==="field"?t?2:1:0,droppedBefore:this.#ae};return this.#ae=0,this.#l.push(a),this.#ee=a,!0}#at(e,t,i){if(!(i>0))return t;const s=this.#ee;if(s!==null&&s.cadence===e){const r=s.at+s.duration,n=t-r;if(Math.abs(n)<i){const a=Math.max(-ge,Math.min(ge,n*rt));return r+a}}s!==null&&this.#U.resynced++;for(let r=this.#l.at(-1);r&&r.at>=t;)this.#l.pop(),this.#U.late++,r=this.#l.at(-1);return t}#lt(e,t,i){const s=this.#l.at(-1),r=(ne+1)*Math.max(this.#L,i);if(s&&s.at-t>r)return this.#G(),this.#U.queueResetted++,!0;const n=Math.max(0,this.#l.length+e-ne);let a=0,l=0;for(;l<n;){const u=this.#l.shift();if(!u)break;a+=u.duration,l++}for(const u of this.#l)u.at-=a;return this.#U.late+=l,!1}#Lt(){const e=this.#D?.kind==="texture"?this.#D.texture:null,t=new Set(this.#l.map(({slot:s})=>s));for(let s=1;s<=N;s++){const r=(this.#N+s)%N,n=this.#T[r];if(n&&n.texture!==e&&!t.has(r))return r}const i=this.#l[0];if(i){const s=this.#T[i.slot];if(s&&s.texture!==e)return i.slot}return null}#we(){this.#w===null&&(!this.#M||this.#$||(this.#fe=0,this.#w=this.#Ce(this.#It)))}#Ut(){this.#ct(this.#w),this.#w=null,this.#G()}#It=e=>{if(this.#w=null,!this.#M||this.#$)return;this.#Mi(e);const t=this.#Q;this.#n.flush(e),this.#K(t)&&(this.#E==="main"&&this.#Ci(this.#he,e),this.#w=this.#Ce(this.#It))};#Mi(e){const t=e-this.#fe;this.#fe=e;const i=Math.max(1,Math.round(t/this.#L)),s=this.#he+i*this.#L,r=e-s;if(this.#he===0||t<=0||t>J||Math.abs(r)>this.#L/4){t>0&&t<=J&&(this.#L=t),this.#he=e;return}this.#L+=r/i*nt,this.#he=s+r*ot}#ii(){const e=this.#S;if(e)return{frames:e,origin:performance.timeOrigin};const t=this.#r.ownerDocument?.defaultView??this.#e.ownerDocument?.defaultView??null;return t===null?{frames:ft,origin:performance.timeOrigin}:{frames:t,origin:t.performance.timeOrigin}}#Ce(e){const{frames:t,origin:i}=this.#ii(),s=t.requestAnimationFrame(r=>e(this.#kt(r,i)));return{frames:t,handle:s}}#ct(e){e?.frames.cancelAnimationFrame(e.handle)}#Bt(){if(this.#S)return;this.#Si();const{frames:e}=this.#ii(),t=this.#w!==null&&this.#w.frames!==e,i=this.#I!==null&&this.#I.frames!==e;!t&&!i||(this.#fe=0,t&&(this.#ct(this.#w),this.#w=this.#Ce(this.#It)),i&&(this.#ct(this.#I),this.#I=this.#Ce(this.#zt)))}#Si(){const e=this.#S?null:this.#r.ownerDocument??null;e!==this.#H&&(this.#H?.removeEventListener("visibilitychange",this.#Nt),this.#H=e,e?.addEventListener("visibilitychange",this.#Nt))}#Nt=()=>{this.#X||this.#Bt()};#Ot(){this.#S||this.#I!==null||!this.#M||this.#$||(this.#I=this.#Ce(this.#zt))}#Di(){this.#ct(this.#I),this.#I=null}#zt=e=>{if(this.#I=null,!this.#M||this.#$)return;const t=this.#Q;this.#n.flush(e),this.#K(t)&&(this.#wi(e),this.#K(t)&&(this.#I=this.#Ce(this.#zt)))};#wi(e){if(this.#S||this.#n.captureDriven||this.#n.mozDriven&&this.#n.hasDelivered||e-this.#je<et||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const t=this.#e.currentTime,i=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,s=this.#y>=oe?this.#y:tt,r=i>this.#xe,n=t!==this.#Ke&&e-this.#bt>=s*.75;!r&&!n||(this.#xe=Math.max(this.#xe,i),this.#bt=e,this.#Zt(e,{mediaTime:t,presentedFrames:Math.max(this.#se+1,i),expectedDisplayTime:e,timeOrigin:performance.timeOrigin,width:this.#e.videoWidth,height:this.#e.videoHeight}))}#Ci(e,t){const i=this.#L/2,s=l=>{const u=l.at-e;return u<=i-ye?!0:u>i+ye?!1:this.#de>0};for(;this.#l[1]&&s(this.#l[1]);)this.#U.late++,this.#l.shift();const r=this.#l[0];if(!r||!s(r))return;this.#l.shift(),this.#de=r.at-e;const n=performance.now(),a=this.#Jt(!0);this.#si(r.slot),this.#qe(a),this.#ze+=performance.now()-n,this.#Oe++,this.#j&&this.#ki(r,t),this.#me=t}#ki(e,t){const i=this.#me===0?0:t-this.#me,s=i/this.#L,r=e.cadence==="film"?e.phase===0?"CPU film":`phase ${e.phase}`:e.cadence==="field"?`field ${e.phase}`:"frame",n=e.phase===0?"duplicate":`phase ${te}`,a=e.droppedBefore>0?`, ${n} dropped before it`+(e.droppedBefore>1?` (${e.droppedBefore})`:""):"";console.log(`yadif: +${i.toFixed(2)} ms (${s.toFixed(2)} refreshes) ${e.cadence} ${r}, due ${(e.at-t).toFixed(2)} ms${a}`)}#si(e){const t=this.#T[e];t&&this.#Gt(t.texture)}#Pi(){this.#ri();const e=this.#_[this.#k];e&&this.#Gt(e,!0),this.#F=0}#Z(e){if(this.#S){this.#S.onVisibility(e);return}this.#r.style.visibility=e?"visible":"hidden"}#Gt(e,t=!1,i=!0){const s=this.#t;s.bindFramebuffer(s.FRAMEBUFFER,null),s.useProgram(this.#u),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,e),s.uniform1i(this.#f,0),s.uniform1i(this.#x,t?1:0),s.viewport(0,0,this.#C,this.#O),s.drawArrays(s.TRIANGLES,0,3),this.#D={kind:"texture",texture:e,flip:t},this.#Z(!0),i&&this.#le++}#Li(e,t){let i=0;return this.#se!==0&&!t&&(i=Math.max(0,e-this.#se-1),this.#U.missed+=i),this.#se=e,i}#Ui(e){const t=e-this.#Ze;if(t<xe)return;const i=this.#De()&&(this.#W||this.#te==="film"||this.#J)?this.#Oe:this.#ce,s=this.#ce?(this.#Ne+this.#ze)/this.#ce:0;let r;this.#Fe!=null&&(r=0,this.#Ae!==0&&(r+=this.#Ge/1e6/this.#Ae),this.#_e!==0&&(r+=this.#Xe/1e6/this.#_e/2));const n={...this.#U,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:i*1e3/t,frameMs:s,maxQueuedFields:this.#Te,mode:this.#p?this.#te:this.#J?"film":"video",match:this.#ke,combScore:this.#dt,outputFps:this.#le*1e3/t,duplicateScore:this.#vt,duplicateRunnerUp:this.#Et,gpuMs:r,film:this.#J,filmError:this.#V};this.dispatchEvent(new CustomEvent("stats",{detail:n})),this.#gt?.(n),this.#Ze=e,this.#ce=0,this.#Ne=0,this.#Oe=0,this.#ze=0,this.#Te=0,this.#le=0,this.#Ge=0,this.#Ae=0,this.#Xe=0,this.#_e=0}#ri(){const e=this.#t;this.#k=(this.#k+1)%R,e.bindTexture(e.TEXTURE_2D,this.#_[this.#k]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#ge),this.#F=Math.min(this.#F+1,R)}#ue(e,t,i,s=!0){if(this.#F===0||this.#$)return;s&&(this.#F===R&&!e?this.#U.filtered++:this.#U.degraded++);const r=this.#t,{prev:n,cur:a,next:l}=this.#ni(e);r.bindFramebuffer(r.FRAMEBUFFER,i),r.useProgram(this.#a);for(const[f,c]of[n,a,l].entries())r.activeTexture(r.TEXTURE0+f),r.bindTexture(r.TEXTURE_2D,this.#_[c]??null);r.uniform1i(this.#o.prev,0),r.uniform1i(this.#o.cur,1),r.uniform1i(this.#o.next,2);const u=this.#P&&!this.#p?this.#s?.texture??null:null,h=u!==null;u!==null&&(r.activeTexture(r.TEXTURE0+3),r.bindTexture(r.TEXTURE_2D,u),r.uniform1i(this.#o.fieldMetrics,3)),r.uniform2i(this.#o.size,this.#C,this.#O);const v=this.#rt?0:1;r.uniform1i(this.#o.parity,t?1-v:v),r.uniform1i(this.#o.tff,this.#rt?1:0),r.uniform1i(this.#o.second,t?1:0),r.uniform1i(this.#o.spatialCheck,this.#Ee?1:0),r.uniform1i(this.#o.debug,this.#j?1:0),r.uniform1i(this.#o.film,h?1:0),r.uniform1i(this.#o.phase,this.#B.phase),r.viewport(0,0,this.#C,this.#O),r.drawArrays(r.TRIANGLES,0,3),this.#j&&h&&this.#xi(this.#$t,0,90),i===null&&(this.#D={kind:"yadif",flush:e,second:t},this.#Z(!0),s&&this.#le++)}#ni(e){const t=i=>(this.#k+R-i)%R;return this.#F===1?{prev:this.#k,cur:this.#k,next:this.#k}:e?{prev:t(1),cur:this.#k,next:this.#k}:this.#F===2?{prev:t(1),cur:t(1),next:this.#k}:{prev:t(2),cur:t(1),next:this.#k}}#ut(){if(this.#Bt(),!this.#pe)return;const e=this.#e,t=e.videoWidth,i=e.videoHeight;if(t===0||i===0)return;const s=Math.min(e.offsetWidth/t,e.offsetHeight/i),r=t*s,n=i*s;this.#r.style.left=`${e.offsetLeft+(e.offsetWidth-r)/2}px`,this.#r.style.top=`${e.offsetTop+(e.offsetHeight-n)/2}px`,this.#r.style.width=`${r}px`,this.#r.style.height=`${n}px`}#oi(e,t){const i=this.#t;this.#i.width=e,this.#i.height=t,this.#C=e,this.#O=t,this.#F=0,this.#D=null,this.#z(),this.#ut();for(const s of this.#_)i.deleteTexture(s);this.#_=[];for(let s=0;s<R;s++){const r=i.createTexture();i.bindTexture(i.TEXTURE_2D,r),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,e,t,0,i.RGBA,i.UNSIGNED_BYTE,null),this.#_.push(r)}this.#Ye(),this.#Xt(),(this.#W||this.#p||this.#P)&&this.#Ht(),this.#s?.resize(e,t),this.#re()}#Ii(){if(this.#m)return;const e=this.#t,t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,S,D,0,e.RGBA,e.UNSIGNED_BYTE,null);const i=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,i),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const s=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!s){e.deleteFramebuffer(i),e.deleteTexture(t);return}this.#m={texture:t,framebuffer:i,pixels:new Uint8Array(S*D*4),previousLuma:new Uint8Array(S*D),currentLuma:new Uint8Array(S*D),nextLuma:new Uint8Array(S*D)}}#Xt(){this.#m&&(this.#t.deleteFramebuffer(this.#m.framebuffer),this.#t.deleteTexture(this.#m.texture),this.#m=null)}#Ht(){const e=this.#t;if(!(this.#T.length===N||this.#C===0)){this.#Ye();for(let t=0;t<N;t++){const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#C,this.#O,0,e.RGBA,e.UNSIGNED_BYTE,null);const s=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,s),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(s),e.deleteTexture(i),this.#Ye();return}this.#T.push({texture:i,framebuffer:s})}this.#N=N-1}}#Ye(){const e=this.#t,t=this.#D?.kind==="texture"?this.#D.texture:null;this.#T.some(i=>i.texture===t)&&(this.#D=null);for(const{texture:i,framebuffer:s}of this.#T)e.deleteFramebuffer(s),e.deleteTexture(i);this.#T=[],this.#G()}#Bi(){if(this.#pe)return;const e=this.#e.parentElement;if(!e)return;const t=document.createElement("div");t.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(t,this.#e),t.appendChild(this.#e),t.appendChild(this.#r),this.#pe=t,this.#ft?.observe(this.#e),this.#ut()}#Ni(){if(this.#S)return;const e=this.#pe;this.#pe=null,this.#ft?.disconnect(),this.#r.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#hi=()=>this.#ut();#Wt(e){return!this.#c||this.#E==="main"?!1:(this.#c.postMessage({type:"event",name:e,video:this.#Ct()}),!0)}#ai=()=>{if(this.#Ke=Number.NaN,this.#Wt("emptied")){this.#ne(),this.#Z(!1);return}this.#F=0,this.#Pe=0,this.#xt=0,this.#G(),this.#Y(),this.#y=0,this.#li(),this.#z(),this.#D=null,this.#Z(!1)};#li(){this.#U={filtered:0,missed:0,degraded:0,discontinuities:0,resynced:0,late:0,queueResetted:0},this.#tt.fill(0),this.#_t=0,this.#se=0,this.#Ze=0,this.#At=0,this.#ce=0,this.#Ne=0,this.#Oe=0,this.#ze=0,this.#Te=0,this.#le=0,this.#z(),this.#Ge=0,this.#Ae=0,this.#Xe=0,this.#_e=0}#z(){this.#G(),this.#te="video",this.#ke="c",this.#dt=0,this.#mt=!0,this.#pt.reset(),this.#vt=1/0,this.#Et=1/0}#ci=()=>{if(this.#Wt("seeking")){this.#ne();return}this.#Le=!1};#oe=e=>{if((e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#Wt(e.type)){this.#ne();return}if(e.type==="seeked"){const i=this.#Le;if(this.#Le=!1,i)return;this.#F=0,this.#z(),this.#Y(),this.#D=null,this.#Z(!1);return}const t=e.type==="ratechange";if(t&&(this.#y=0,this.#Pe=this.#e.currentTime),this.#G(),this.#M&&this.#F>0){const i=this.#Lt(),s=i===null?void 0:this.#T[i];i!==null&&s?(this.#N=i,this.#ue(!0,!1,s.framebuffer),this.#si(i)):this.#ue(!0,!1,null)}t&&(this.#F=0,this.#se=0,this.#z(),this.#Y())};#ui=e=>{if(e.preventDefault(),this.#S){this.#S.onFailure("the deinterlacer WebGL context was lost");return}this.#E!=="active"&&(this.#$=!0,this.#wt("the deinterlacer WebGL context was lost"),this.stop())}}function mt(o,e,t,i,s,r,n){return new dt(o,t,{canvas:e,onFailure:i,onVisibility:s,requestAnimationFrame:r,cancelAnimationFrame:n})}function q(o,e){const t=o.createProgram(),i=Te(o,o.VERTEX_SHADER,it),s=Te(o,o.FRAGMENT_SHADER,e);if(o.attachShader(t,i),o.attachShader(t,s),o.linkProgram(t),o.deleteShader(i),o.deleteShader(s),!o.getProgramParameter(t,o.LINK_STATUS)){const r=o.getProgramInfoLog(t);throw o.deleteProgram(t),new Error(`the deinterlacer failed to link: ${r??"no reason given"}`)}return t}function Te(o,e,t){const i=o.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(o.shaderSource(i,t),o.compileShader(i),!o.getShaderParameter(i,o.COMPILE_STATUS)){const s=o.getShaderInfoLog(i);throw o.deleteShader(i),new Error(`the deinterlacer failed to compile: ${s??"no reason given"}`)}return i}const X=self;class pt extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#i=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#i=e.buffered}get buffered(){return{length:this.#i.length,start:e=>{const t=this.#i[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.start},end:e=>{const t=this.#i[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let k=null,_=null,Fe=!1;function vt(o){return X.requestAnimationFrame(o)}function Et(o){X.cancelAnimationFrame(o)}function P(o,e=[]){X.postMessage(o,e)}function xt(o,e,t){o.doubleRate=e.doubleRate,(o.autoFilm!==e.autoFilm||t==="autoFilm")&&(o.autoFilm=e.autoFilm),o.filmCombThreshold=e.filmCombThreshold,o.spatialCheck=e.spatialCheck,(o.film!==e.film||t==="film")&&(o.film=e.film),o.debug=e.debug}X.onmessage=o=>{const e=o.data;try{if(e.type==="initialize"){if(typeof X.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");k=new pt,k.update(e.video),_=mt(k,e.canvas,e.options,i=>{Fe||P({type:"failed",message:i})},i=>P({type:"visibility",visible:i}),vt,Et);let t=0;_.addEventListener("failure",()=>t++),_.addEventListener("stats",i=>{const{dropped:s,...r}=i.detail;P({type:"stats",stats:r,filmFailure:t})}),_.scan=e.scan,_.videoTimeline=e.videoTimeline,_.enabled=e.enabled,P({type:"ready"});return}if(!k||!_)return;switch(e.type){case"frame":k.update(e.video);try{_.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),P({type:"consumed",id:e.id})}break;case"settings":xt(_,e.options,e.retryFilm);break;case"scan":_.scan=e.scan;break;case"timeline":_.videoTimeline=e.videoTimeline;break;case"enabled":_.enabled=e.enabled;break;case"event":k.update(e.video),k.dispatchEvent(new Event(e.name));break;case"capture":k.videoWidth=e.width,k.videoHeight=e.height,_.capture().then(t=>P({type:"capture",id:e.id,image:t},[t])).catch(()=>P({type:"capture",id:e.id,image:null}));break;case"destroy":Fe=!0,_.destroy(),_=null,k=null,X.close();break}}catch(t){const i=t instanceof Error?t.message:String(t);P({type:"failed",message:i})}}})();
//# sourceMappingURL=worker-DqNgmEDp.js.map
