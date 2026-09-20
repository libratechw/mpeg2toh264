(function(){"use strict";const Z=`#version 300 es
void main() {
  // From the vertex index alone. There is no geometry here worth a buffer.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;function Y(n,e,t){const i=n.createProgram(),s=le(n,n.VERTEX_SHADER,t),r=le(n,n.FRAGMENT_SHADER,e);if(n.attachShader(i,s),n.attachShader(i,r),n.linkProgram(i),n.deleteShader(s),n.deleteShader(r),!n.getProgramParameter(i,n.LINK_STATUS)){const o=n.getProgramInfoLog(i);throw n.deleteProgram(i),new Error(`the deinterlacer failed to link: ${o??"no reason given"}`)}return i}function le(n,e,t){const i=n.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(n.shaderSource(i,t),n.compileShader(i),!n.getShaderParameter(i,n.COMPILE_STATUS)){const s=n.getShaderInfoLog(i);throw n.deleteShader(i),new Error(`the deinterlacer failed to compile: ${s??"no reason given"}`)}return i}const _e=`#version 300 es
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
`,Ae=`#version 300 es
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
`;function Se(n,e){const t=Y(n,_e,Ae),i=n.getAttribLocation(t,"aVertexPosition"),s=n.getAttribLocation(t,"aTextureCoord"),r=n.getUniformLocation(t,"uTexture"),o=n.getUniformLocation(t,"uMatrix"),a=n.getUniformLocation(t,"uUvMatrix"),l=n.getUniformLocation(t,"uTextColor"),u=n.getUniformLocation(t,"uBackColor");if(r==null||o==null||a==null||l==null||u==null)throw new Error("failed to initialize DEBUG_FRAGMENT_SHADER, DEBUG_VERTEX_SHADER");const h=n.createBuffer(),p=n.createBuffer();return{gl:n,...Me(n,e),program:t,programUniforms:{vertex:i,textureCoord:s,texture:r,matrix:o,uvMatrix:a,textColor:l,backColor:u},positionBuffer:h,textureBuffer:p}}function Me(n,e){const t=new OffscreenCanvas(0,0),i=t.getContext("2d"),s=new Map;let r=0;const o=0;let a=1;i.font=e,i.fillStyle="white";for(let u=32;u<128;u++){const h=String.fromCharCode(u),p=i.measureText(h),d=Math.ceil(p.actualBoundingBoxDescent+p.actualBoundingBoxAscent+1),c=Math.ceil(p.actualBoundingBoxLeft+p.actualBoundingBoxRight+1);s.set(h,{x:r,y:o,width:c,height:d,metrics:p}),a=Math.max(a,d),r+=c}t.width=r,t.height=a,i.font=e,i.fillStyle="white";for(const[u,h]of s)i.fillText(u,Math.floor(h.x+h.metrics.actualBoundingBoxLeft+1),Math.floor(h.metrics.actualBoundingBoxAscent+1));const l=n.createTexture();return n.bindTexture(n.TEXTURE_2D,l),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MIN_FILTER,n.LINEAR),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MAG_FILTER,n.LINEAR),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_S,n.CLAMP_TO_EDGE),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_T,n.CLAMP_TO_EDGE),n.texImage2D(n.TEXTURE_2D,0,n.RGBA,n.RGBA,n.UNSIGNED_BYTE,t),{fontTexture:l,chars:s,textureSize:{width:r,height:a}}}function De(n){const e=n.gl;e.deleteBuffer(n.positionBuffer),e.deleteBuffer(n.textureBuffer),e.deleteTexture(n.fontTexture),e.deleteProgram(n.program)}function Le(n,e,t,i,s,r,o){const a=[],l=[],u=t;for(const d of e){if(d===`
`){t=u,i+=o;continue}const c=n.chars.get(d);if(c==null)continue;if(c.width===1){t+=c.metrics.width;continue}const v=Math.floor(t-c.metrics.actualBoundingBoxLeft),x=Math.floor(i-c.metrics.actualBoundingBoxAscent),T=v+c.width,E=x+c.height;a.push(v,x),l.push(c.x,c.y),a.push(v,E),l.push(c.x,c.y+c.height),a.push(v+c.width,E),l.push(c.x+c.width,c.y+c.height),a.push(T,E),l.push(c.x+c.width,c.y+c.height),a.push(v,x),l.push(c.x,c.y),a.push(T,x),l.push(c.x+c.width,c.y),t+=c.metrics.width}const h=n.gl;h.useProgram(n.program),h.bindBuffer(h.ARRAY_BUFFER,n.positionBuffer),h.bufferData(h.ARRAY_BUFFER,new Float32Array(a),h.STATIC_DRAW),h.vertexAttribPointer(n.programUniforms.vertex,2,h.FLOAT,!1,0,0),h.enableVertexAttribArray(n.programUniforms.vertex),h.bindBuffer(h.ARRAY_BUFFER,n.textureBuffer),h.bufferData(h.ARRAY_BUFFER,new Float32Array(l),h.STATIC_DRAW),h.vertexAttribPointer(n.programUniforms.textureCoord,2,h.FLOAT,!1,0,0),h.enableVertexAttribArray(n.programUniforms.textureCoord),h.activeTexture(h.TEXTURE0),h.bindTexture(h.TEXTURE_2D,n.fontTexture),h.uniform1i(n.programUniforms.texture,0),h.uniform3fv(n.programUniforms.textColor,[1,1,1]),h.uniform3fv(n.programUniforms.backColor,[0,0,0]);function p(d,c,v){const x=[];for(let T=0;T<c;T++)for(let E=0;E<d;E++)x.push(v[E*d+T]);return x}h.uniformMatrix4fv(n.programUniforms.matrix,!1,p(4,4,[1/(s/2),0,0,-1,0,-2/r,0,1,0,0,1,0,0,0,0,1])),h.uniformMatrix3fv(n.programUniforms.uvMatrix,!1,p(3,3,[1/n.textureSize.width,0,0,0,1/n.textureSize.height,0,0,0,1])),h.viewport(0,0,s,r),h.enable(h.BLEND),h.blendFunc(h.SRC_ALPHA,h.ONE_MINUS_SRC_ALPHA),h.drawArrays(h.TRIANGLES,0,a.length/2),h.disable(h.BLEND)}const b={firstRepeatsPrevious:0,secondRepeatsNext:1,secondRepeatsPrevious:2,previousSecondRepeated:3,firstRepeatsNext:4,previousFirstRepeated:5,phase:6},U=7,ce=2,Pe=16,ee=1,Ce=2,ue=5,ke={a:"uA",b:"uB",fieldMetrics:"uFieldMetrics",first:"uFirst",size:"uSize"},fe=16,de=8,we=`#version 300 es

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
  const int BLOCK_W = ${fe};
  const int BLOCK_H = ${de};

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

        diffEven += abs(a - b);
        totalEven += 1;
      }
      p.y += 1;
      if (p.x < uSize.x && p.y < uSize.y) {
        float a = luma(texelFetch(uA, p, 0).rgb);
        float b = luma(texelFetch(uB, p, 0).rgb);

        diffOdd += abs(a - b);
        totalOdd += 1;
      }
    }
  }

  float run = texelFetch(uFieldMetrics, ivec2(${b.phase}, 0), 0)[1];
  float threshold = run == 0.0 ? 0.025 : (run <= 10.0 ? 0.11 : 0.15);

  vec4 even = measure(diffEven, float(totalEven), threshold);
  vec4 odd = measure(diffOdd, float(totalOdd), threshold);
  outFirst = uFirst == 0 ? even : odd;
  outSecond = uFirst == 0 ? odd : even;
}
`,Ue={second:"uSecond",first:"uFirst",size:"uSize"},W=8,Ie=`#version 300 es
precision highp float;

uniform sampler2D uSecond;
uniform sampler2D uFirst;

uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

void main()
{
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 base = dst * ${W};

  vec4 second = vec4(0.0);
  vec4 first = vec4(0.0);

  for (int y = 0; y < ${W}; ++y) {
    for (int x = 0; x < ${W}; ++x) {
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
  return differing <= ${ce}.0;
}

bool differs(float differing) {
  return differing >= ${Pe}.0;
}

/** The phase texel, (phase, run), from the six comparisons' differing counts. */
vec4 decide(vec4 last, float dFirstRepeatsPrevious, float dSecondRepeatsNext,
            float dSecondRepeatsPrevious, float dPreviousSecondRepeated,
            float dFirstRepeatsNext, float dPreviousFirstRepeated)
{
  bool firstRepeatsPrevious = same(dFirstRepeatsPrevious);
  bool secondRepeatsNext = same(dSecondRepeatsNext);
  bool secondRepeatsPrevious = same(dSecondRepeatsPrevious);
  bool previousSecondRepeated = same(dPreviousSecondRepeated);
  bool firstRepeatsNext = same(dFirstRepeatsNext);
  bool previousFirstRepeated = same(dPreviousFirstRepeated);
  bool still = (firstRepeatsPrevious && secondRepeatsPrevious) || (secondRepeatsNext && firstRepeatsNext);

  int previous = int(last[0]);
  float run = last[1];
  // What each phase looks like: one field repeats, the other plainly does not.
  bool looks1 = firstRepeatsPrevious && differs(dSecondRepeatsPrevious);
  bool looks2 = secondRepeatsNext && differs(dFirstRepeatsNext);
  bool looks3 = secondRepeatsPrevious && differs(dFirstRepeatsPrevious);
  bool looks4 = previousSecondRepeated && differs(dPreviousFirstRepeated);
  bool looks5 = firstRepeatsNext && differs(dSecondRepeatsNext);

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
  bool believed = run >= ${ue}.0;
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
  if (metric == ${b.firstRepeatsPrevious}) {
    outValue = previous(${b.firstRepeatsNext});
  } else if (metric == ${b.secondRepeatsNext}) {
    outValue = fold(uSecond);
  } else if (metric == ${b.secondRepeatsPrevious}) {
    outValue = previous(${b.secondRepeatsNext});
  } else if (metric == ${b.previousSecondRepeated}) {
    outValue = previous(${b.secondRepeatsPrevious});
  } else if (metric == ${b.firstRepeatsNext}) {
    outValue = fold(uFirst);
  } else if (metric == ${b.previousFirstRepeated}) {
    outValue = previous(${b.firstRepeatsPrevious});
  } else {
    outValue = decide(
      previous(${b.phase}),
      previous(${b.firstRepeatsNext})[1],
      fold(uSecond)[1],
      previous(${b.secondRepeatsNext})[1],
      previous(${b.secondRepeatsPrevious})[1],
      fold(uFirst)[1],
      previous(${b.firstRepeatsPrevious})[1]
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
  return texelFetch(uFieldMetrics, ivec2(metric, 0), 0)[1] <= ${ce}.0;
}

/** The pulldown phase the detection gave this frame, or 0. See film-shader.ts. */
int detectedPhase() {
  return int(texelFetch(uFieldMetrics, ivec2(${b.phase}, 0), 0)[0]);
}

bool isMixedPhase(int phase) {
  return phase == ${ee} || phase == ${Ce};
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
  } else if (uFilm && !uSecond && isMixedPhase(detectedPhase())) {
    rgb = (y & 1) == firstParity() ? texelFetch(uCur, ivec2(x, y), 0).rgb
                                   : texelFetch(uPrev, ivec2(x, y), 0).rgb;
  } else if (uFilm && !uSecond && detectedPhase() != 0) {
    // One film frame, whole.
    rgb = texelFetch(uCur, ivec2(x, y), 0).rgb;
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
`,te={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",topFieldFirst:"uTopFieldFirst",match:"uMatch"},M=288,D=162,Ge=`#version 300 es
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
  ivec2 targetSize = ivec2(${M}, ${D});
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
  ivec2 targetSize = ivec2(${M}, ${D});
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
`;class _{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#r;#i;#e;#u=0;#t=null;#s=[];#T=null;#n=1/0;#f=1/0;constructor(e,t){this.#r=e,this.#i=t,this.#e=255*_.DECIMATE_BLOCK**2*_.DUPLICATE_PERCENT/100}fieldMatch(e,t,i,s,r=_.COMBED_PIXEL_LIMIT){const o=s?1:0,a={p:e,c:t,n:i};let l=this.#b("c","p",o,a);const u=new Map,h=x=>{const T=u.get(x);if(T!==void 0)return T;const E=_.#d(this.weave(e,t,i,x,s),this.#r,this.#i);return u.set(x,E),E},p=h(l),d=h("n");(d*3<p||d*2<p&&p>r)&&Math.abs(d-p)>=30&&d<r&&(l="n");const c=h(l),v=c>=r;return v&&(l="c"),{match:l,combScore:c,isCombed:v,luma:this.weave(e,t,i,l,s)}}decimate(e){const t=this.#u,i=this.#T?_.#g(this.#T,e,this.#r,this.#i):{maxBlockDifference:1/0,totalDifference:1/0};this.#s.push(i);const s=this.#t===t,r=s&&i.maxBlockDifference<this.#e;s&&!r&&(this.#t=null);const o=this.#t;this.#T=e.slice(),this.#u++;let a=this.#t;if(this.#u===_.CYCLE){let l=0,u=null;for(let h=1;h<this.#s.length;h++)(this.#s[h]?.maxBlockDifference??1/0)<(this.#s[l]?.maxBlockDifference??1/0)?(u=l,l=h):(u===null||(this.#s[h]?.maxBlockDifference??1/0)<(this.#s[u]?.maxBlockDifference??1/0))&&(u=h);this.#n=this.#s[l]?.maxBlockDifference??1/0,this.#f=u===null?1/0:this.#s[u]?.maxBlockDifference??1/0,a=(this.#s[l]?.maxBlockDifference??1/0)<this.#e?l:null,this.#t=a,this.#s=[],this.#u=0}return{cycleIndex:t,maxBlockDifference:i.maxBlockDifference,totalDifference:i.totalDifference,shouldDrop:r,dropIndex:o,nextDropIndex:a,lowestCycleDifference:this.#n,runnerUpCycleDifference:this.#f}}weave(e,t,i,s,r){if(s==="c")return t.slice();const o=t.slice(),a=s==="p"?e:i,l=o.length/this.#i,u=r?1:0;for(let h=u;h<this.#i;h+=2)o.set(a.subarray(h*l,(h+1)*l),h*l);return o}reset(){this.#u=0,this.#t=null,this.#s=[],this.#T=null,this.#n=1/0,this.#f=1/0}#b(e,t,i,s){const r=this.#r,o=this.#i,a=2-i,l=2-i,u=s[e],h=s[t],p=_.#v(u,h,r,o,i);let d=0,c=0,v=0,x=0,T=0,E=0;for(let O=2;O<o-2;O+=2){const S=(O-2)/2,oe=a-1+S*2,he=a+1+S*2,ae=a+3+S*2,J=a+S*2,q=J+2,X=l+S*2,w=X+2,ye=a+S*2;for(let P=8;P<r-8;P++){const z=(p[ye*r+P]??0)|(p[(ye+2)*r+P]??0);if(z===0)continue;const Re=(s.c[oe*r+P]??0)+((s.c[he*r+P]??0)<<2)+(s.c[ae*r+P]??0),H=Math.abs(3*((u[J*r+P]??0)+(u[q*r+P]??0))-Re),$=Math.abs(3*((h[X*r+P]??0)+(h[w*r+P]??0))-Re);H>23&&(z&1)!==0&&(d+=H),$>23&&(z&1)!==0&&(x+=$),H>42&&(z&2)!==0&&(c+=H),$>42&&(z&2)!==0&&(T+=$),H>42&&(z&4)!==0&&(v+=H),$>42&&(z&4)!==0&&(E+=$)}}c<500&&T<500&&(v>=500||E>=500)&&Math.max(v,E)>3*Math.min(v,E)&&(c=v,T=E);const g=Math.floor(d/6+.5),F=Math.floor(x/6+.5),f=Math.floor(c/6+.5),m=Math.floor(T/6+.5),y=Math.max(g,F)/Math.max(Math.min(g,F),1),L=Math.max(f,m)/Math.max(Math.min(f,m),1),N=Math.max(f,m)/Math.max(Math.max(g,F),1);return(f>=500||m>=500)&&(f*2<m||m*2<f)||(f>=1e3||m>=1e3)&&(f*3<m*2||m*3<f*2)||(f>=2e3||m>=2e3)&&(f*5<m*4||m*5<f*4)||(f>=4e3||m>=4e3)&&L>y||N>.005&&Math.max(f,m)>150&&(f*2<m||m*2<f)?f>m?t:e:g>F?t:e}static#v(e,t,i,s,r){const o=Array.from({length:Math.ceil(s/2)},()=>new Uint8Array(i)),a=r===1?1:0;for(let h=0;h<o.length;h++){const p=Math.min(s-1,a+h*2),d=o[h];if(d)for(let c=0;c<i;c++)d[c]=Math.abs((e[p*i+c]??0)-(t[p*i+c]??0))}const l=new Uint8Array(i*s),u=r===1?3:2;for(let h=1;h<o.length-1;h++){const p=u+(h-1)*2;if(p>=s)break;const d=o[h];if(d)for(let c=1;c<i-1;c++){const v=d[c]??0;if(v<=3)continue;let x=0;for(let m=c-1;m<=c+1;m++)x+=(o[h-1]?.[m]??0)>3?1:0,x+=(o[h]?.[m]??0)>3?1:0,x+=(o[h+1]?.[m]??0)>3?1:0;if(x<=1)continue;const T=p*i+c;if(l[T]=1,v<=19)continue;x=0;let E=!1,g=!1;for(let m=c-1;m<=c+1;m++)(o[h-1]?.[m]??0)>19&&(x++,E=!0),(o[h]?.[m]??0)>19&&x++,(o[h+1]?.[m]??0)>19&&(x++,g=!0);if(x<=3)continue;if(E&&g){l[T]|=2;continue}let F=!1,f=!1;for(let m=Math.max(c-4,0);m<Math.min(c+5,i);m++)h!==1&&(o[h-2]?.[m]??0)>19&&(F=!0),(o[h-1]?.[m]??0)>19&&(E=!0),(o[h+1]?.[m]??0)>19&&(g=!0),h!==o.length-2&&(o[h+2]?.[m]??0)>19&&(f=!0);E&&(g||F)||g&&(E||f)?l[T]|=2:x>5&&(l[T]|=4)}}return l}static#d(e,t,i){const s=new Uint8Array(t*i),r=(a,l)=>e[Math.max(0,Math.min(i-1,l))*t+a]??0;for(let a=0;a<i;a++)for(let l=0;l<t;l++){const u=r(l,a),h=r(l,a===0?1:a-1),p=r(l,a===i-1?i-2:a+1),d=a<2?r(l,a===0?2:3):r(l,a-2),c=a+2>=i?r(l,a===i-1?i-3:i-4):r(l,a+2);(a===0?Math.abs(u-p)>_.COMB_THRESHOLD:a===i-1?Math.abs(u-h)>_.COMB_THRESHOLD:Math.abs(u-h)>_.COMB_THRESHOLD&&Math.abs(u-p)>_.COMB_THRESHOLD)&&Math.abs(4*u-3*(h+p)+d+c)>_.COMB_THRESHOLD*6&&(s[a*t+l]=255)}let o=0;for(const a of[0,8])for(const l of[0,8])for(let u=a;u<i;u+=16)for(let h=l;h<t;h+=16){let p=0;for(let d=Math.max(1,u);d<Math.min(i-1,u+16);d++)for(let c=h;c<Math.min(t,h+16);c++){const v=d*t+c;s[v-t]===255&&s[v]===255&&s[v+t]===255&&p++}o=Math.max(o,p)}return o}static#g(e,t,i,s){const r=_.DECIMATE_BLOCK/2,o=Math.ceil(i/r),a=Math.ceil(s/r),l=new Float64Array(o*a),u=e.length/(i*s);for(let d=0;d<s;d++){const c=Math.floor(d/r);for(let v=0;v<i;v++){const x=Math.floor(v/r),T=c*o+x,E=(d*i+v)*u;if(u===1){l[T]=(l[T]??0)+Math.abs((e[E]??0)-(t[E]??0));continue}const g=Math.round((e[E]??0)*.2126+(e[E+1]??0)*.7152+(e[E+2]??0)*.0722),F=Math.round((t[E]??0)*.2126+(t[E+1]??0)*.7152+(t[E+2]??0)*.0722);if(l[T]=(l[T]??0)+Math.abs(g-F),(v&1)!==0||(d&1)!==0)continue;let f=0,m=0,y=0,L=0,N=0,O=0,S=0;for(let q=d;q<Math.min(d+2,s);q++)for(let X=v;X<Math.min(v+2,i);X++){const w=(q*i+X)*u;f+=e[w]??0,m+=e[w+1]??0,y+=e[w+2]??0,L+=t[w]??0,N+=t[w+1]??0,O+=t[w+2]??0,S++}const oe=Math.round((-.114572*f-.385428*m+.5*y)/S),he=Math.round((-.114572*L-.385428*N+.5*O)/S),ae=Math.round((.5*f-.454153*m-.045847*y)/S),J=Math.round((.5*L-.454153*N-.045847*O)/S);l[T]=(l[T]??0)+Math.abs(oe-he)+Math.abs(ae-J)}}let h=-1;for(let d=0;d<a-1;d++)for(let c=0;c<o-1;c++)h=Math.max(h,(l[d*o+c]??0)+(l[d*o+c+1]??0)+(l[(d+1)*o+c]??0)+(l[(d+1)*o+c+1]??0));let p=0;for(const d of l)p+=d;return{maxBlockDifference:h,totalDifference:p}}}const I={phase:0,run:0};function ie(n,e,t){return Object.fromEntries(Object.entries(t).map(([i,s])=>[i,n.getUniformLocation(e,s)]))}class me{#r;#i;#e;#u;#t;#s;#T;#n=null;#f=null;#b=null;#v=0;#d=null;#g=null;metrics=new Float32Array(U*4);#D=0;#w=0;constructor(e){this.#r=e,this.#i=Y(e,we,Z),this.#e=ie(e,this.#i,ke),this.#u=Y(e,Ie,Z),this.#t=ie(e,this.#u,Ue),this.#s=Y(e,Ne,Z),this.#T=ie(e,this.#s,Be)}get texture(){return this.#b?.[this.#v]?.textures[0]??null}resize(e,t){e===this.#D&&t===this.#w||(this.#D=e,this.#w=t,this.#ae())}reset(){const e=this.#r;e.deleteSync(this.#g),this.#g=null;const t=this.#b?.[this.#v];if(!t)return;const i=new Float32Array(U*4);for(let s=0;s<b.phase;s++)i[s*4+1]=1;e.bindTexture(e.TEXTURE_2D,t.textures[0]??null),e.texSubImage2D(e.TEXTURE_2D,0,0,0,U,1,e.RGBA,e.FLOAT,i)}detect(e,t,i){const s=this.#r;if(this.#D===0||this.#w===0)return;this.#W();const r=this.#n,o=this.#f,a=this.#b;if(r===null||o===null||a===null)return;const l=a[this.#v],u=a[1-this.#v];s.bindFramebuffer(s.FRAMEBUFFER,r.framebuffer),s.useProgram(this.#i),this.#R(0,e,this.#e.a),this.#R(1,t,this.#e.b),this.#R(2,l.textures[0],this.#e.fieldMetrics),s.uniform1i(this.#e.first,i),s.uniform2i(this.#e.size,this.#D,this.#w),s.viewport(0,0,r.width,r.height),s.drawArrays(s.TRIANGLES,0,3),s.bindFramebuffer(s.FRAMEBUFFER,o.framebuffer),s.useProgram(this.#u),this.#R(0,r.textures[0],this.#t.second),this.#R(1,r.textures[1],this.#t.first),s.uniform2i(this.#t.size,r.width,r.height),s.viewport(0,0,o.width,o.height),s.drawArrays(s.TRIANGLES,0,3),s.bindFramebuffer(s.FRAMEBUFFER,u.framebuffer),s.useProgram(this.#s),this.#R(0,l.textures[0],this.#T.previous),this.#R(1,o.textures[0],this.#T.second),this.#R(2,o.textures[1],this.#T.first),s.uniform2i(this.#T.size,o.width,o.height),s.viewport(0,0,U,1),s.drawArrays(s.TRIANGLES,0,3),this.#v=1-this.#v,s.deleteSync(this.#g),s.bindBuffer(s.PIXEL_PACK_BUFFER,this.#d),s.readPixels(0,0,U,1,s.RGBA,s.FLOAT,0),s.bindBuffer(s.PIXEL_PACK_BUFFER,null),s.bindFramebuffer(s.FRAMEBUFFER,null),this.#g=s.fenceSync(s.SYNC_GPU_COMMANDS_COMPLETE,0),s.flush()}poll(){const e=this.#r,t=this.#g;if(t===null||this.#d===null)return null;switch(e.clientWaitSync(t,0,0)){case e.ALREADY_SIGNALED:case e.CONDITION_SATISFIED:return e.bindBuffer(e.PIXEL_PACK_BUFFER,this.#d),e.getBufferSubData(e.PIXEL_PACK_BUFFER,0,this.metrics),e.bindBuffer(e.PIXEL_PACK_BUFFER,null),e.deleteSync(t),this.#g=null,{phase:this.metrics[b.phase*4]??0,run:this.metrics[b.phase*4+1]??0};default:return null}}destroy(){const e=this.#r;if(this.#ae(),this.#b!==null){for(const t of this.#b)j(e,t);this.#b=null}e.deleteSync(this.#g),this.#g=null,e.deleteBuffer(this.#d),this.#d=null,e.deleteProgram(this.#i),e.deleteProgram(this.#u),e.deleteProgram(this.#s)}#R(e,t,i){const s=this.#r;s.activeTexture(s.TEXTURE0+e),s.bindTexture(s.TEXTURE_2D,t??null),s.uniform1i(i,e)}#ae(){const e=this.#r;this.#n!==null&&j(e,this.#n),this.#f!==null&&j(e,this.#f),this.#n=null,this.#f=null}#W(){const e=this.#r;if(this.#n===null||this.#f===null){this.#ae();const t=Math.ceil(this.#D/fe),i=Math.ceil(this.#w/(de*2));this.#n=K(e,t,i,2),this.#f=K(e,Math.ceil(t/W),Math.ceil(i/W),2)}this.#b===null&&(this.#b=[K(e,U,1,1),K(e,U,1,1)],this.#v=0,this.reset()),this.#d===null&&(this.#d=e.createBuffer(),e.bindBuffer(e.PIXEL_PACK_BUFFER,this.#d),e.bufferData(e.PIXEL_PACK_BUFFER,this.metrics.byteLength,e.STREAM_READ),e.bindBuffer(e.PIXEL_PACK_BUFFER,null))}}function K(n,e,t,i){const s=n.createFramebuffer();n.bindFramebuffer(n.FRAMEBUFFER,s);const r=[];for(let l=0;l<i;l++){const u=n.createTexture();n.bindTexture(n.TEXTURE_2D,u),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MIN_FILTER,n.NEAREST),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MAG_FILTER,n.NEAREST),n.texImage2D(n.TEXTURE_2D,0,n.RGBA32F,e,t,0,n.RGBA,n.FLOAT,null),n.framebufferTexture2D(n.FRAMEBUFFER,n.COLOR_ATTACHMENT0+l,n.TEXTURE_2D,u,0),r.push(u)}n.drawBuffers(r.map((l,u)=>n.COLOR_ATTACHMENT0+u));const o=n.checkFramebufferStatus(n.FRAMEBUFFER)===n.FRAMEBUFFER_COMPLETE;n.bindFramebuffer(n.FRAMEBUFFER,null);const a={framebuffer:s,textures:r,width:e,height:t};if(!o)throw j(n,a),new Error("failed to allocate framebuffer");return a}function j(n,{framebuffer:e,textures:t}){n.deleteFramebuffer(e);for(const i of t)n.deleteTexture(i)}const pe=["mozParsedFrames","mozDecodedFrames","mozPresentedFrames","mozPaintedFrames"];function $e(n){return pe.every(e=>e in n)}function We(n){return n.ownerDocument?.defaultView?.performance.timeOrigin??performance.timeOrigin}const Ve=250,qe=500;class Ye{#r;#i;#e=null;#u=null;#t=null;#s=null;#T=!1;#n=!0;#f=null;#b=null;#v=0;constructor(e){if(this.#r=e,this.#i=$e(e)?e:null,this.#i){for(const t of["emptied","seeking","seeked"])e.addEventListener(t,this.#g);for(const t of["pause","playing","waiting","ratechange"])e.addEventListener(t,this.#d)}}get mozDriven(){return this.#i!==null}get hasDelivered(){return this.#T}request(e){this.#e===null&&(this.#u=e,this.#e=this.#i?requestAnimationFrame(this.#R):this.#r.requestVideoFrameCallback(this.#D))}cancel(){this.#e!==null&&(this.#i?cancelAnimationFrame(this.#e):this.#r.cancelVideoFrameCallback(this.#e)),this.#e=null,this.#u=null,this.#g()}destroy(){this.cancel();for(const e of["emptied","seeking","seeked"])this.#r.removeEventListener(e,this.#g);for(const e of["pause","playing","waiting","ratechange"])this.#r.removeEventListener(e,this.#d)}#d=()=>{this.#f=null,this.#b=null,this.#v=0};#g=()=>{this.#t=null,this.#s=null,this.#n=!0,this.#d()};#D=(e,t)=>{this.#w(e,{width:t.width,height:t.height,mediaTime:t.mediaTime,presentedFrames:t.presentedFrames,expectedDisplayTime:t.expectedDisplayTime,timeOrigin:We(this.#r)})};#w=(e,t)=>{const i=this.#u;this.#e=null,this.#u=null,this.#T=!0,i?.(e,t)};#R=e=>{const t=this.#i,i=pe.map(a=>t[a]);this.#t?.some((a,l)=>i[l]<a)&&this.#g(),this.#t=i;const s=t.mozPaintedFrames,r=!t.seeking&&t.readyState>=2&&t.videoWidth>0&&t.videoHeight>0,o=this.#s===null&&(s>0||t.paused&&(t.mozPresentedFrames>0||t.mozDecodedFrames>0));if(r&&(o||this.#s!==null&&s!==this.#s)){if(this.#f!==null&&e-this.#f>qe&&(this.#d(),this.#n=!0),!t.paused&&!t.ended){const l=this.#b;if(l&&e-l.at>=Ve){const u=s-l.frames;if(u>0){const h=(e-l.at)/u;h>=4&&h<=200&&(this.#v=this.#v?this.#v+(h-this.#v)*.25:h)}this.#b=null}this.#b??={at:e,frames:s}}this.#f=e,this.#s=s;const a=this.#n;this.#n=!1,this.#w(e,{width:t.videoWidth,height:t.videoHeight,mediaTime:t.currentTime,presentedFrames:s,expectedDisplayTime:e,timeOrigin:performance.timeOrigin,mozTiming:{periodMs:this.#v,discontinuity:a}})}else this.#e=requestAnimationFrame(this.#R)}}let Ke=null;const ve=.5,R=4,se=5,B=se+1,Ee=1e3,re=4,Q=200,je=.25,Qe=1e3/60,Je=250,Ze=1e3/30;function xe(n){if(!Number.isFinite(n)||n<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return n}const et=`#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`,tt=.75,it=.1,Te=1,st=.02,rt=.1,be=1,nt=4,ne=5,ot=4,ht={2:0,3:.25,4:.5,5:.75},at=3,lt=`#version 300 es
precision highp float;
uniform sampler2D uField;
uniform bool uFlip;
out vec4 fragColor;
void main() {
  ivec2 position = ivec2(gl_FragCoord.xy);
  if (uFlip) position.y = textureSize(uField, 0).y - 1 - position.y;
  fragColor = texelFetch(uField, position, 0);
}
`,ct={requestAnimationFrame:n=>requestAnimationFrame(n),cancelAnimationFrame:n=>cancelAnimationFrame(n)};class ut extends EventTarget{#r;#i;#e;#u;#t;#s=null;#T;#n;#f;#b;#v;#d=null;#g=null;#D=null;#w=null;#R=null;#ae=null;#W=null;#P=[];#C=[];#_e=B-1;#A=null;#h=[];#B=null;#We=0;#N=null;#Ae=null;#O=Qe;#Se=0;#$t=0;#ct=0;#se=0;#Y=null;#U(){this.#h.length=0,this.#Y=null,this.#se=0}#le=null;#ut;#z;#l;#ce;#ue;#K="video";#Me="c";#ft=0;#dt=!0;#mt=new _(M,D);#pt=1/0;#vt=1/0;#re=0;#V;#_;#a=0;#F=0;#L=0;#y=R-1;#p=0;#De=0;#Et=0;#Ve=Number.NaN;#Le=!1;#qe=0;#fe=0;#xt=0;#E=!1;#j=0;#Ye=!1;#I=!1;#m=null;#de=[];#G=!1;#Tt;#bt;#x;#Ke;#Q;#gt;#o=null;#c;#Pe=!1;#Ft=0;#yt=!1;#fi=0;#Ce=!1;#je=!1;#me=null;#di=0;#ke=new Map;#S={filtered:0,missed:0,degraded:0,discontinuities:0,resynced:0,late:0,queueResetted:0};#ne=0;#Rt=0;#Qe=0;#oe=0;#we=0;#Ue=0;#Ie=0;#pe=0;#ve;#Je=[];#Ee=[];#Be=0;#xe=0;#Ne=0;#Te=0;#Oe=I;#be=0;#M=I;#J=!1;#ge=null;#Wt="";#Ze=[0,0,0,0,0,0];#_t=0;#X=null;#et=0;#tt=null;#At=0;constructor(e,t={},i=null){super(),this.#e=e,this.#z=t.doubleRate??!1,this.#l=t.autoFilm??!1,this.#ce=xe(t.filmCombThreshold??_.COMBED_PIXEL_LIMIT),this.#ue=t.spatialCheck??!0,this.#V=t.debug??!1,this.#_=t.film??!1,this.#Tt=t.onStats,this.#bt=t.onFailure,this.#x=i,this.#Q=i?"main":t.rendering??"auto",this.#gt=t.workerUrl??Ke,this.#c=this.#Q==="main"?"main":"idle",this.#i=i?i.canvas:document.createElement("canvas"),this.#r=i?.canvas??(this.#Q==="main"?this.#i:document.createElement("canvas")),this.#Ke=e,i||(this.#i.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const s=this.#r.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!(s instanceof WebGL2RenderingContext))throw new Error("this browser has no WebGL2");this.#t=s,this.#_&&!this.#l&&(this.#qt(),this.#s=new me(s)),this.#T=V(s,ze);const r=this.#T;this.#n=Object.fromEntries(Object.entries(Oe).map(([o,a])=>[o,s.getUniformLocation(r,a)])),this.#f=V(s,lt),this.#b=s.getUniformLocation(this.#f,"uField"),this.#v=s.getUniformLocation(this.#f,"uFlip"),this.#l&&this.#ti(),this.#ve=s.getExtension("EXT_disjoint_timer_query_webgl2"),this.#r.addEventListener("webglcontextlost",this.#ui),this.#ut=i?null:new ResizeObserver(()=>this.#lt()),this.#u=new Ye(e),e.addEventListener("emptied",this.#ai),e.addEventListener("resize",this.#hi),e.addEventListener("pause",this.#ie),e.addEventListener("ended",this.#ie),e.addEventListener("seeking",this.#ci),e.addEventListener("seeked",this.#ie),e.addEventListener("ratechange",this.#ie)}get running(){return this.#E&&(this.#m?.interlaced??!0)}get canvas(){return this.#i}get#it(){return this.#m?.topFieldFirst!==!1}#Vt(){return{doubleRate:this.#z,autoFilm:this.#l,filmCombThreshold:this.#ce,spatialCheck:this.#ue,film:this.#_,debug:this.#V}}get enabled(){return this.#Ye}set enabled(e){this.#Ye=e,this.#Mt(),this.#o?.postMessage({type:"enabled",enabled:e})}set scan(e){const t=this.#m?.interlaced!==e?.interlaced,i=t||this.#m?.topFieldFirst!==e?.topFieldFirst;this.#m=e,!(i&&(!this.#Z()||this.#m!==e))&&(this.#o?.postMessage({type:"scan",scan:e}),i&&(this.#p=0,this.#k(),this.#$(),t&&(this.#a=0),this.#A=null,this.#q(!1)),this.#Mt(),i&&((e?.interlaced??!0)&&(this.#x||this.#c==="main")?this.#ye():this.#wt()))}get scan(){return this.#m}set videoTimeline(e){this.#de=e,this.#o?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#m=null),this.#Mt()}get videoTimeline(){return this.#de}get container(){return this.#le??this.#e}get doubleRate(){return this.#z}set doubleRate(e){e!==this.#z&&(this.#z=e,this.#H(),this.#U(),this.#St())}get spatialCheck(){return this.#ue}set spatialCheck(e){e!==this.#ue&&(this.#ue=e,this.#H())}get film(){return this.#_}set film(e){if(this.#l){this.#_=e,this.#H();return}const t=this.#o?this.#tt:this.#X;if(!(e===this.#_&&(e===!1||t===null))){if(this.#o){this.#_=e,this.#H(e?"film":void 0);return}if(e){if(!this.#Z())return;try{this.#Yt()}catch(i){this.#_=!0,this.#H(),this.#ze(`film detector unavailable: ${i instanceof Error?i.message:String(i)}`);return}}if(this.#_=e,this.#H(),!e){if(!this.#Z())return;this.#J=!1,this.#M=I,this.#$(),this.#s?.destroy(),this.#s=null}this.#St()}}get debug(){return this.#V}set debug(e){e!==this.#V&&(this.#V=e,this.#H())}get#mi(){return this.#z||this.#_||this.#l}#St(){this.#I||(this.#mi?(this.#F>0&&this.#Xt(),(this.#m?.interlaced??!0)&&(this.#x||this.#c==="main")&&this.#ye()):!this.#l&&!this.#_&&(this.#A=null,this.#q(!1),this.#$e()))}get autoFilm(){return this.#l}set autoFilm(e){const t=this.#o?this.#tt:this.#X;if(!(e===this.#l&&(!e||t===null))){if(this.#l=e,this.#o){this.#H(e?"autoFilm":void 0);return}if(this.#H(),this.#k(),e){if(this.#$(),this.#s?.destroy(),this.#s=null,!this.#Z()||this.#l!==e)return;this.#F>0&&this.#Xt(),(this.#m?.interlaced??!0)&&(this.#x||this.#c==="main")&&this.#ye()}else{if(!this.#Z()||this.#l!==e)return;this.#Gt(),this.#St()}}}get filmCombThreshold(){return this.#ce}set filmCombThreshold(e){const t=xe(e);t!==this.#ce&&(this.#ce=t,this.#H(),this.#l&&this.#k())}#H(e){this.#o?.postMessage({type:"settings",options:this.#Vt(),retryFilm:e})}#qt(){if(this.#t.getExtension("EXT_color_buffer_float")===null)throw new Error("film needs EXT_color_buffer_float")}#Yt(){this.#qt(),this.#s??=new me(this.#t),this.#F>0&&this.#s.resize(this.#F,this.#L)}#Mt(){this.#Ye&&(this.#de.length>0||(this.#m?.interlaced??!0))?this.start():this.stop()}#pi(){return this.#x||this.#Q==="main"?!1:this.#c==="starting"||this.#c==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#gt!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#Kt(),!0):this.#Q==="auto"?(this.#st(),!1):(this.#c="failed",this.#E=!1,!0)}#Kt(){this.#ee(),this.#o?.terminate(),this.#o=null,this.#Ce=!1,this.#je=!1,this.#tt=null,this.#At=0;let e=this.#i;if(this.#yt){e=document.createElement("canvas"),e.className=this.#i.className;const r=this.#i.getAttribute("style");r===null?e.removeAttribute("style"):e.setAttribute("style",r),e.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(e),this.#i=e}const t=++this.#Ft;this.#c="starting";let i,s;try{s=e.transferControlToOffscreen(),this.#yt=!0,i=new Worker(this.#gt,{type:"module"})}catch(r){this.#Ge(r instanceof Error?r.message:String(r));return}this.#o=i,i.onmessage=r=>{t===this.#Ft&&this.#vi(r.data)},i.onerror=r=>{t===this.#Ft&&(r.preventDefault(),this.#Ge(r.message||"the deinterlacer worker failed"))},i.postMessage({type:"initialize",canvas:s,options:this.#Vt(),scan:this.#m,videoTimeline:this.#de,enabled:this.#E,video:this.#Lt()},[s])}#vi(e){switch(e.type){case"ready":this.#c="active",this.#E&&(this.#Xe(),this.#Nt());break;case"failed":this.#Ge(e.message);break;case"consumed":{this.#Ce=!1,this.#je=!0;const t=this.#me;this.#me=null,t&&this.#Qt(t);break}case"visibility":this.#i.style.visibility=e.visible?"visible":"hidden";break;case"stats":{const t={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0},i=t.filmError??null,s=this.#At;if(this.#tt=i,this.#At=e.filmFailure,i!==null&&e.filmFailure!==s){this.dispatchEvent(new CustomEvent("failure",{detail:i}));try{this.#bt?.(i)}catch{}}this.dispatchEvent(new CustomEvent("stats",{detail:t})),this.#Tt?.(t);break}case"capture":{const t=this.#ke.get(e.id);if(this.#ke.delete(e.id),!t){e.image?.close();break}e.image?t.resolve(e.image):createImageBitmap(this.#e).then(t.resolve,t.reject);break}}}#Dt(e){if(this.dispatchEvent(new CustomEvent("failure",{detail:e})),!this.#x)try{this.#bt?.(e)}catch{}}#ze(e){this.#X!==e&&(this.#X=e,this.#J=!1,this.#M=I,this.#$(),this.#et=0,this.#s?.destroy(),this.#s=null,this.#Dt(e))}#Z(){if(this.#I)return!1;if(this.#o)return!0;const e=this.#j;if(this.#X=null,this.#et=0,this.#l)try{this.#ti(),this.#F>0&&this.#Ii()}catch(t){this.#ze(`autoFilm programs unavailable: ${t instanceof Error?t.message:String(t)}`)}return!this.#I&&e===this.#j}#Ge(e){if(this.#c==="starting"&&this.#Q==="auto"&&!this.#Pe){this.#st();return}if(this.#jt(e),!this.#Pe){this.#Pe=!0,this.#Kt();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#c="failed",this.#o?.terminate(),this.#o=null,this.#ee(),this.#Dt(`deinterlacer worker stopped: ${e}`),this.stop()}#st(){const e=this.#r;e.className=this.#i.className;const t=this.#i.getAttribute("style");t===null?e.removeAttribute("style"):e.setAttribute("style",t),e.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(e),this.#i=e,this.#yt=!1,this.#o?.terminate(),this.#o=null,this.#c="main",this.#ee(),this.#E&&(this.#Xe(),this.#Nt(),(this.#m?.interlaced??!0)&&this.#ye())}#ee(){this.#me?.frame.close(),this.#me=null}#jt(e){for(const t of this.#ke.values())t.reject(new Error(e));this.#ke.clear()}start(){if(!(this.#E||this.#I||this.#G)&&(this.#j++,this.#E=!0,this.#li(),this.#k(),!!this.#Z())){if(this.#qe=performance.now(),this.#xt=this.#qe,this.#Ve=Number.NaN,this.#fe=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#Bi(),this.#Nt(),this.#pi()){this.#o?.postMessage({type:"enabled",enabled:!0}),this.#c==="active"&&this.#Xe();return}this.#Xe(),(this.#m?.interlaced??!0)&&this.#ye()}}stop(){this.#j++,this.#E&&(this.#E=!1,this.#u.cancel(),this.#Di(),this.#wt(),this.#p=0,this.#A=null,this.#q(!1),this.#ee(),this.#o?.postMessage({type:"enabled",enabled:!1}))}destroy(){if(!this.#I){this.#I=!0,this.#Ye=!1,this.stop(),this.#o?.postMessage({type:"destroy"}),this.#o?.terminate(),this.#o=null,this.#ee(),this.#jt("the deinterlacer was destroyed"),this.#Ae?.removeEventListener("visibilitychange",this.#Bt),this.#Ae=null,this.#r.removeEventListener("webglcontextlost",this.#ui),this.#u.destroy(),this.#e.removeEventListener("emptied",this.#ai),this.#e.removeEventListener("resize",this.#hi),this.#e.removeEventListener("pause",this.#ie),this.#e.removeEventListener("ended",this.#ie),this.#e.removeEventListener("seeking",this.#ci),this.#e.removeEventListener("seeked",this.#ie),this.#e.removeEventListener("ratechange",this.#ie),this.#Ni();for(const e of this.#P)this.#t.deleteTexture(e);this.#P=[],this.#$e(),this.#Gt();for(const e of[...this.#Je,...this.#Ee.map(({q:t})=>t)])this.#t.deleteQuery(e);this.#Je.length=0,this.#Ee.length=0,this.#s?.destroy(),this.#s=null,this.#ge!==null&&(De(this.#ge),this.#ge=null),this.#t.deleteProgram(this.#T),this.#t.deleteProgram(this.#f),this.#d&&this.#t.deleteProgram(this.#d),this.#D&&this.#t.deleteProgram(this.#D),this.#R&&this.#t.deleteProgram(this.#R),this.#t.getExtension("WEBGL_lose_context")?.loseContext()}}capture(){if(this.#c==="active"&&this.#i.style.visibility==="visible"&&this.#o){const s=++this.#di,r=new Promise((o,a)=>{this.#ke.set(s,{resolve:o,reject:a})});return this.#o.postMessage({type:"capture",id:s,width:this.#e.videoWidth,height:this.#e.videoHeight}),r}if(this.#c==="starting"||this.#c==="failed")return createImageBitmap(this.#e);const e=this.#A;if(this.#x&&(!this.#E||this.#G||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#E||this.#G||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#zt(e.texture,e.flip,!1):e.kind==="yadif"?this.#he(e.flush,e.second,null,!1):this.#Ct(null,!1);const t=this.#e.videoWidth,i=this.#e.videoHeight;return t>0&&i>0&&(t!==this.#r.width||i!==this.#r.height)?createImageBitmap(this.#r,{resizeWidth:t,resizeHeight:i,resizeQuality:"high"}):createImageBitmap(this.#r)}addEventListener(e,t,i){super.addEventListener(e,t,i)}removeEventListener(e,t,i){super.removeEventListener(e,t,i)}#Xe(){this.#x||!this.#E||this.#u.request(this.#yi)}#Lt(){const e=[];for(let t=0;t<this.#e.buffered.length;t++)e.push({start:this.#e.buffered.start(t),end:this.#e.buffered.end(t)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#Ei(e,t){let i;try{i=new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(t.mediaTime*1e6))})}catch(r){const o=r instanceof Error?r.message:String(r);this.#Q==="auto"&&!this.#je&&!this.#Pe?(this.#st(),this.#rt(e,t)):this.#Ge(o);return}const s={id:++this.#fi,frame:i,now:e,metadata:t,video:this.#Lt()};if(this.#Ce){this.#me?.frame.close(),this.#me=s;return}this.#Qt(s)}#Qt(e){const t=this.#o;if(!t||this.#c!=="active"){e.frame.close();return}this.#Ce=!0;const i={type:"frame",id:e.id,frame:e.frame,metadata:e.metadata,video:e.video};try{t.postMessage(i,[e.frame])}catch(s){this.#Ce=!1,e.frame.close();const r=s instanceof Error?s.message:String(s);this.#Q==="auto"&&!this.#je&&!this.#Pe?(this.#st(),this.#rt(e.now,e.metadata)):this.#Ge(r)}}#xi(e,t,i){this.#ge==null&&(this.#ge=Se(this.#t,"20px monospace")),Le(this.#ge,e,t,i,this.#F,this.#L,20)}#Jt(e){if(this.#ve==null||this.#Ee.length>30)return;const t=this.#Je.pop()??this.#t.createQuery();return this.#t.beginQuery(this.#ve.TIME_ELAPSED_EXT,t),this.#Ee.push({q:t,isField:e}),t}#He(e){this.#ve!=null&&(e!=null&&this.#t.endQuery(this.#ve.TIME_ELAPSED_EXT),this.#Ee=this.#Ee.filter(({q:t,isField:i})=>{if(this.#t.getQueryParameter(t,this.#t.QUERY_RESULT_AVAILABLE)){const s=this.#t.getQueryParameter(t,this.#t.QUERY_RESULT);return i?(this.#Ne+=s,this.#Te++):(this.#Be+=s,this.#xe++),this.#Je.push(t),!1}return!0}))}#$(){this.#M=I,this.#Oe=I,this.#be=0,this.#J=!1,this.#s?.reset()}#Ti(){const{cur:e,next:t}=this.#ni(!1),i=this.#P[e],s=this.#P[t];if(!i||!s)return;const r=this.#m?.topFieldFirst!==!1?0:1;this.#s?.detect(i,s,r)}#bi(){const e=this.#s?.poll()??null;e!==null&&(this.#Oe=e,this.#be=0),this.#be++;const{phase:t,run:i}=this.#Oe;t===0||this.#be>ne?this.#M=I:this.#M={phase:(t-1+this.#be)%ne+1,run:i}}#gi(e){const t=[],i=this.#s?.metrics??new Float32Array(0);for(let r=0;r<b.phase;r++){const o=i[r*4]??0,a=i[r*4+1]??0,l=i[r*4+2]??0;t.push(`${o.toFixed(3)},${a.toString().padStart(4)},${l.toFixed(3)}`)}const s=this.#Ze.map((r,o)=>`${o===0?"-":o}:${r}`).join(" ");return`frame=${e} phase=${this.#M.phase} run=${this.#M.run} known=${this.#Oe.phase}/${this.#Oe.run} age=${this.#be} ${this.#J?"film":"video"} period=${this.#a.toFixed(3)}
${t.join(" ")}
${s} dropped:${this.#_t}`}#Pt(e,t){const i=t-performance.timeOrigin;return Number.isFinite(i)&&i!==0?e+i:e}#Fi(e,t){const i=e.expectedDisplayTime;if(!Number.isFinite(i)||i<=0||!Number.isFinite(e.timeOrigin))return t;const s=this.#Pt(i,e.timeOrigin),r=nt*Math.max(this.#O,this.#a);return s<t-r||s>t+r?t:s}#yi=(e,t)=>{if(!this.#E||this.#G)return;this.#It();const i=this.#Pt(e,t.timeOrigin);this.#qe=i,this.#fe=Math.max(this.#fe,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0),this.#Zt(i,t),this.#Xe()};#Zt(e,t){if(this.#Ve=t.mediaTime,this.#c==="active"){this.#Ei(e,t);return}this.#c!=="starting"&&this.#rt(e,t)}ingestExternalFrame(e,t,i){this.#Ke=i;try{this.#rt(e,t)}finally{this.#Ke=this.#e}}#rt(e,t){const i=this.#j;if(this.#te(i)&&(this.#Ri(t.mediaTime),!!this.#te(i)&&t.width>0&&t.height>0)){let s=!1;if(!this.#Le&&this.#e.seeking){const f=this.#e.buffered,m=this.#a>=re?this.#a/1e3:Q/1e3;for(let y=0;y<f.length;y++)if(t.mediaTime>=f.start(y)&&t.mediaTime<f.end(y)&&Math.abs(t.mediaTime-this.#e.currentTime)<=m){s=!0;break}}if(s&&(this.#Le=!0),(this.#F===0||this.#L===0)&&this.#oi(t.width,t.height),!this.#te(i))return;if(this.#m&&!this.#m.interlaced){this.#ki();return}const r=t.mediaTime-this.#De,o=t.mozTiming,a=s||(o?o.discontinuity||r<0||r>ve:r<0||r>ve);a&&(this.#p=0,this.#a=0,this.#S.discontinuities++,this.#U(),this.#k(),this.#$());const l=this.#l&&this.#ne!==0&&t.presentedFrames-this.#ne>1,u=this.#wi(t.presentedFrames,a);if(!a&&l&&(this.#p=0,this.#k()),this.#p>0&&t.mediaTime===this.#De&&(!o||t.presentedFrames===this.#Et))return;if(!a){const f=o?.periodMs??0;f>0?this.#ei(f*(this.#e.playbackRate||1)/1e3):r>0&&this.#ei(r)}this.#De=t.mediaTime,this.#Et=t.presentedFrames;const h=performance.now();h-this.#Rt>Ee&&(this.#Qe=h,this.#oe=0,this.#we=0,this.#Ue=0,this.#Ie=0,this.#pe=0,this.#re=0,this.#Be=0,this.#xe=0,this.#Ne=0,this.#Te=0),this.#Rt=h;const p=performance.now(),d=this.#Jt(!1);this.#ri();const c=this.#K,v=this.#l&&!this.#X&&this.#p===R?this.#_i():!1;if(v==="unavailable"?++this.#et>=at&&this.#ze("autoFilm analysis unavailable: the GPU analysis target or programs would not allocate"):this.#et=0,!this.#te(i)){this.#I||this.#He(d);return}const x=v===!0;c!==this.#K&&this.#U();const E=x&&this.#Fe();if(this.#_&&!this.#l&&!this.#X&&!this.#s)try{this.#Yt()}catch(f){this.#ze(`film detector unavailable: ${f instanceof Error?f.message:String(f)}`)}if(!this.#te(i)){this.#I||this.#He(d);return}if(this.#_&&!this.#l&&!this.#X){if(this.#p===R&&u===0)try{this.#bi(),this.#Ti()}catch(f){this.#ze(`film detection failed: ${f instanceof Error?f.message:String(f)}`)}else this.#$();this.#Ze[this.#M.phase]=(this.#Ze[this.#M.phase]??0)+1,this.#J=this.#M.phase!==0&&this.#M.run>=ue,this.#V&&(this.#Wt=this.#gi(t.presentedFrames))}if(!this.#te(i)){this.#I||this.#He(d);return}const F=this.#Fi(t,e)+this.#O;if(E)this.#se++;else if(this.#l&&!this.#X&&!this.#dt&&this.#K==="film")if(this.#Fe()){const f=this.#a*5/4,y=this.#ht(1,e,f)||this.#Y===null?F+f:F;this.#Ai(this.#ot("film",y,f),f)}else this.#Ct(null);else if(this.#J&&!this.#l)if(this.#Fe()){const f=this.#M.phase;if(f===ee)this.#_t++,this.#se++;else{const m=this.#a*ne/ot,y=this.#ht(1,e,m),L=ht[f]??0,N=y||this.#Y===null?F+m:F+L*this.#a;this.#nt("film",!1,this.#ot("film",N,m),m)}}else this.#he(!1,!1,null);else if(this.#z&&this.#Fe()){const f=this.#a/2,y=this.#ht(2,e,f)||this.#Y===null?F+f*2:F,L=this.#ot("field",y,f);this.#nt("field",!1,L,f),this.#nt("field",!0,L+f,f)}else if(this.#Fe()){const f=this.#a,y=this.#ht(1,e,f)||this.#Y===null?F+f:F;this.#nt("frame",!1,this.#ot("frame",y,f),f)||(this.#S.late++,this.#he(!1,!1,null))}else this.#S.late+=this.#h.length,this.#U(),this.#he(!1,!1,null);this.#pe=Math.max(this.#pe,this.#h.length),this.#He(d),this.#we+=performance.now()-p,this.#oe++,this.#Ui(h)}}#te(e){return!this.#I&&this.#E&&e===this.#j}#Ri(e){const t=this.#j;let i;for(let o=this.#de.length-1;o>=0;o--){const a=this.#de[o];if(a.start<=e+1e-6){i=a;break}}if(i?.codedSize&&(i.codedSize.width!==this.#F||i.codedSize.height!==this.#L)&&this.#oi(i.codedSize.width,i.codedSize.height),!this.#te(t))return;const s=i?.scan;if(!s||this.#m?.interlaced===s.interlaced&&this.#m.topFieldFirst===s.topFieldFirst)return;const r=this.#m?.interlaced;this.#m=s,this.#p=0,this.#U(),this.#k(),this.#Z()&&(r!==s.interlaced&&(this.#a=0),s.interlaced&&(this.#x||this.#c==="main")?this.#ye():this.#wt(),this.#$())}#Fe(){return(this.#z||this.#l||this.#_)&&this.#a>0&&this.#C.length===B}#ei(e){const t=e*1e3/(this.#e.playbackRate||1),i=this.#a>0?Math.max(1,Math.round(t/this.#a)):1,s=t/i;s<re||s>Q||(this.#a=this.#a>0&&s>this.#a*tt?this.#a+(s-this.#a)*je:s)}#ti(){if(this.#d&&this.#D&&this.#R)return;const e=this.#t,t=[];let i,s,r;try{i=V(e,Ge),t.push(i),s=V(e,Xe),t.push(s),r=V(e,He),t.push(r)}catch(o){for(const a of t)e.deleteProgram(a);throw o}this.#d=i,this.#g=Object.fromEntries(Object.entries(te).filter(([o])=>o!=="match"&&o!=="topFieldFirst").map(([o,a])=>[o,e.getUniformLocation(i,a)])),this.#D=s,this.#w=Object.fromEntries(Object.entries(te).map(([o,a])=>[o,e.getUniformLocation(s,a)])),this.#R=r,this.#ae=Object.fromEntries(Object.entries(te).map(([o,a])=>[o,e.getUniformLocation(r,a)]))}#_i(){const e=this.#W,t=this.#d,i=this.#g,s=this.#R,r=this.#ae;if(!e||!t||!i||!s||!r)return"unavailable";const o=this.#t,a=this.#y,l=(this.#y+R-1)%R,u=(this.#y+R-2)%R,h=this.#it;o.bindFramebuffer(o.FRAMEBUFFER,e.framebuffer),o.useProgram(t);for(const[E,g]of[u,l,a].entries())o.activeTexture(o.TEXTURE0+E),o.bindTexture(o.TEXTURE_2D,this.#P[g]??null);o.uniform1i(i.prev,0),o.uniform1i(i.cur,1),o.uniform1i(i.next,2),o.uniform2i(i.size,this.#F,this.#L),o.viewport(0,0,M,D),o.drawArrays(o.TRIANGLES,0,3),o.readPixels(0,0,M,D,o.RGBA,o.UNSIGNED_BYTE,e.pixels);const{previousLuma:p,currentLuma:d,nextLuma:c}=e;for(let E=0;E<p.length;E++){const g=E*4;p[E]=e.pixels[g]??0,d[E]=e.pixels[g+1]??0,c[E]=e.pixels[g+2]??0}const v=this.#mt.fieldMatch(p,d,c,h,this.#ce);o.useProgram(s),o.uniform1i(r.prev,0),o.uniform1i(r.cur,1),o.uniform1i(r.next,2),o.uniform2i(r.size,this.#F,this.#L),o.uniform1i(r.topFieldFirst,h?1:0),o.uniform1i(r.match,v.match==="p"?0:v.match==="c"?1:2),o.drawArrays(o.TRIANGLES,0,3),o.readPixels(0,0,M,D,o.RGBA,o.UNSIGNED_BYTE,e.pixels);const x=this.#mt.decimate(e.pixels);this.#Me=v.match,this.#ft=v.combScore,this.#dt=v.isCombed,this.#pt=x.lowestCycleDifference,this.#vt=x.runnerUpCycleDifference;const T=x.dropIndex!==null&&!v.isCombed;return(T?"film":"video")!==this.#K&&(this.#K=T?"film":"video"),x.shouldDrop&&!v.isCombed}#Ai(e,t){const i=this.#kt();if(i===null)return;const s=this.#C[i];if(!s)return;for(this.#_e=i;this.#h.length>0&&this.#h[0]?.slot===i;)this.#h.shift(),this.#S.late++;this.#Ct(s.framebuffer);const r={slot:i,at:e,duration:t,cadence:"film",phase:0,droppedBefore:this.#se};this.#se=0,this.#h.push(r),this.#Y=r}#Ct(e,t=!0){const i=this.#D,s=this.#w;if(!i||!s)return;const r=this.#t,o=this.#y,a=(this.#y+R-1)%R,l=(this.#y+R-2)%R,u=this.#it;r.bindFramebuffer(r.FRAMEBUFFER,e),r.useProgram(i);for(const[h,p]of[l,a,o].entries())r.activeTexture(r.TEXTURE0+h),r.bindTexture(r.TEXTURE_2D,this.#P[p]??null);r.uniform1i(s.prev,0),r.uniform1i(s.cur,1),r.uniform1i(s.next,2),r.uniform2i(s.size,this.#F,this.#L),r.uniform1i(s.topFieldFirst,u?1:0),r.uniform1i(s.match,this.#Me==="p"?0:this.#Me==="c"?1:2),r.viewport(0,0,this.#F,this.#L),r.drawArrays(r.TRIANGLES,0,3),e===null&&(this.#A={kind:"film"},this.#q(!0),t&&this.#re++)}#nt(e,t,i,s){const r=this.#kt();if(r===null)return!1;const o=this.#C[r];if(!o)return!1;for(this.#_e=r;this.#h.length>0&&this.#h[0]?.slot===r;)this.#h.shift(),this.#S.late++;this.#he(!1,t,o.framebuffer);const a={slot:r,at:i,duration:s,cadence:e,phase:e==="film"?this.#M.phase:e==="field"?t?2:1:0,droppedBefore:this.#se};return this.#se=0,this.#h.push(a),this.#Y=a,!0}#ot(e,t,i){if(!(i>0))return t;const s=this.#Y;if(s!==null&&s.cadence===e){const r=s.at+s.duration,o=t-r;if(Math.abs(o)<i){const a=Math.max(-Te,Math.min(Te,o*it));return r+a}}s!==null&&this.#S.resynced++;for(let r=this.#h.at(-1);r&&r.at>=t;)this.#h.pop(),this.#S.late++,r=this.#h.at(-1);return t}#ht(e,t,i){const s=this.#h.at(-1),r=(se+1)*Math.max(this.#O,i);if(s&&s.at-t>r)return this.#U(),this.#S.queueResetted++,!0;const o=Math.max(0,this.#h.length+e-se);let a=0,l=0;for(;l<o;){const u=this.#h.shift();if(!u)break;a+=u.duration,l++}for(const u of this.#h)u.at-=a;return this.#S.late+=l,!1}#kt(){const e=this.#A?.kind==="texture"?this.#A.texture:null,t=new Set(this.#h.map(({slot:s})=>s));for(let s=1;s<=B;s++){const r=(this.#_e+s)%B,o=this.#C[r];if(o&&o.texture!==e&&!t.has(r))return r}const i=this.#h[0];if(i){const s=this.#C[i.slot];if(s&&s.texture!==e)return i.slot}return null}#ye(){this.#B===null&&(!this.#E||this.#G||(this.#We=0,this.#B=this.#Re(this.#Ut)))}#wt(){this.#at(this.#B),this.#B=null,this.#U()}#Ut=e=>{this.#B=null,!(!this.#E||this.#G)&&(this.#Si(e),this.#c==="main"&&this.#Pi(this.#Se,e),this.#B=this.#Re(this.#Ut))};#Si(e){const t=e-this.#We;this.#We=e;const i=Math.max(1,Math.round(t/this.#O)),s=this.#Se+i*this.#O,r=e-s;if(this.#Se===0||t<=0||t>Q||Math.abs(r)>this.#O/4){t>0&&t<=Q&&(this.#O=t),this.#Se=e;return}this.#O+=r/i*st,this.#Se=s+r*rt}#ii(){const e=this.#x;if(e)return{frames:e,origin:performance.timeOrigin};const t=this.#i.ownerDocument?.defaultView??this.#e.ownerDocument?.defaultView??null;return t===null?{frames:ct,origin:performance.timeOrigin}:{frames:t,origin:t.performance.timeOrigin}}#Re(e){const{frames:t,origin:i}=this.#ii(),s=t.requestAnimationFrame(r=>e(this.#Pt(r,i)));return{frames:t,handle:s}}#at(e){e?.frames.cancelAnimationFrame(e.handle)}#It(){if(this.#x)return;this.#Mi();const{frames:e}=this.#ii(),t=this.#B!==null&&this.#B.frames!==e,i=this.#N!==null&&this.#N.frames!==e;!t&&!i||(this.#We=0,t&&(this.#at(this.#B),this.#B=this.#Re(this.#Ut)),i&&(this.#at(this.#N),this.#N=this.#Re(this.#Ot)))}#Mi(){const e=this.#x?null:this.#i.ownerDocument??null;e!==this.#Ae&&(this.#Ae?.removeEventListener("visibilitychange",this.#Bt),this.#Ae=e,e?.addEventListener("visibilitychange",this.#Bt))}#Bt=()=>{this.#I||this.#It()};#Nt(){this.#x||this.#N!==null||!this.#E||this.#G||(this.#N=this.#Re(this.#Ot))}#Di(){this.#at(this.#N),this.#N=null}#Ot=e=>{if(this.#N=null,!this.#E||this.#G)return;const t=this.#j;this.#Li(e),this.#te(t)&&(this.#N=this.#Re(this.#Ot))};#Li(e){if(this.#x||this.#u.mozDriven&&this.#u.hasDelivered||e-this.#qe<Je||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const t=this.#e.currentTime,i=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,s=this.#a>=re?this.#a:Ze,r=i>this.#fe,o=t!==this.#Ve&&e-this.#xt>=s*.75;!r&&!o||(this.#fe=Math.max(this.#fe,i),this.#xt=e,this.#Zt(e,{mediaTime:t,presentedFrames:Math.max(this.#ne+1,i),expectedDisplayTime:e,timeOrigin:performance.timeOrigin,width:this.#e.videoWidth,height:this.#e.videoHeight}))}#Pi(e,t){const i=this.#O/2,s=l=>{const u=l.at-e;return u<=i-be?!0:u>i+be?!1:this.#$t>0};for(;this.#h[1]&&s(this.#h[1]);)this.#S.late++,this.#h.shift();const r=this.#h[0];if(!r||!s(r))return;this.#h.shift(),this.#$t=r.at-e;const o=performance.now(),a=this.#Jt(!0);this.#si(r.slot),this.#He(a),this.#Ie+=performance.now()-o,this.#Ue++,this.#V&&this.#Ci(r,t),this.#ct=t}#Ci(e,t){const i=this.#ct===0?0:t-this.#ct,s=i/this.#O,r=e.cadence==="film"?e.phase===0?"CPU film":`phase ${e.phase}`:e.cadence==="field"?`field ${e.phase}`:"frame",o=e.phase===0?"duplicate":`phase ${ee}`,a=e.droppedBefore>0?`, ${o} dropped before it`+(e.droppedBefore>1?` (${e.droppedBefore})`:""):"";console.log(`yadif: +${i.toFixed(2)} ms (${s.toFixed(2)} refreshes) ${e.cadence} ${r}, due ${(e.at-t).toFixed(2)} ms${a}`)}#si(e){const t=this.#C[e];t&&this.#zt(t.texture)}#ki(){this.#ri();const e=this.#P[this.#y];e&&this.#zt(e,!0),this.#p=0}#q(e){if(this.#x){this.#x.onVisibility(e);return}this.#i.style.visibility=e?"visible":"hidden"}#zt(e,t=!1,i=!0){const s=this.#t;s.bindFramebuffer(s.FRAMEBUFFER,null),s.useProgram(this.#f),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,e),s.uniform1i(this.#b,0),s.uniform1i(this.#v,t?1:0),s.viewport(0,0,this.#F,this.#L),s.drawArrays(s.TRIANGLES,0,3),this.#A={kind:"texture",texture:e,flip:t},this.#q(!0),i&&this.#re++}#wi(e,t){let i=0;return this.#ne!==0&&!t&&(i=Math.max(0,e-this.#ne-1),this.#S.missed+=i),this.#ne=e,i}#Ui(e){const t=e-this.#Qe;if(t<Ee)return;const i=this.#Fe()&&(this.#z||this.#K==="film"||this.#J)?this.#Ue:this.#oe,s=this.#oe?(this.#we+this.#Ie)/this.#oe:0;let r;this.#ve!=null&&(r=0,this.#xe!==0&&(r+=this.#Be/1e6/this.#xe),this.#Te!==0&&(r+=this.#Ne/1e6/this.#Te/2));const o={...this.#S,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:i*1e3/t,frameMs:s,maxQueuedFields:this.#pe,mode:this.#K,match:this.#Me,combScore:this.#ft,outputFps:this.#re*1e3/t,duplicateScore:this.#pt,duplicateRunnerUp:this.#vt,gpuMs:r,film:this.#J,filmError:this.#X};this.dispatchEvent(new CustomEvent("stats",{detail:o})),this.#Tt?.(o),this.#Qe=e,this.#oe=0,this.#we=0,this.#Ue=0,this.#Ie=0,this.#pe=0,this.#re=0,this.#Be=0,this.#xe=0,this.#Ne=0,this.#Te=0}#ri(){const e=this.#t;this.#y=(this.#y+1)%R,e.bindTexture(e.TEXTURE_2D,this.#P[this.#y]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#Ke),this.#p=Math.min(this.#p+1,R)}#he(e,t,i,s=!0){if(this.#p===0||this.#G)return;s&&(this.#p===R&&!e?this.#S.filtered++:this.#S.degraded++);const r=this.#t,{prev:o,cur:a,next:l}=this.#ni(e);r.bindFramebuffer(r.FRAMEBUFFER,i),r.useProgram(this.#T);for(const[d,c]of[o,a,l].entries())r.activeTexture(r.TEXTURE0+d),r.bindTexture(r.TEXTURE_2D,this.#P[c]??null);r.uniform1i(this.#n.prev,0),r.uniform1i(this.#n.cur,1),r.uniform1i(this.#n.next,2);const u=this.#_&&!this.#l?this.#s?.texture??null:null,h=u!==null;u!==null&&(r.activeTexture(r.TEXTURE0+3),r.bindTexture(r.TEXTURE_2D,u),r.uniform1i(this.#n.fieldMetrics,3)),r.uniform2i(this.#n.size,this.#F,this.#L);const p=this.#it?0:1;r.uniform1i(this.#n.parity,t?1-p:p),r.uniform1i(this.#n.tff,this.#it?1:0),r.uniform1i(this.#n.second,t?1:0),r.uniform1i(this.#n.spatialCheck,this.#ue?1:0),r.uniform1i(this.#n.debug,this.#V?1:0),r.uniform1i(this.#n.film,h?1:0),r.uniform1i(this.#n.phase,this.#M.phase),r.viewport(0,0,this.#F,this.#L),r.drawArrays(r.TRIANGLES,0,3),this.#V&&h&&this.#xi(this.#Wt,0,90),i===null&&(this.#A={kind:"yadif",flush:e,second:t},this.#q(!0),s&&this.#re++)}#ni(e){const t=i=>(this.#y+R-i)%R;return this.#p===1?{prev:this.#y,cur:this.#y,next:this.#y}:e?{prev:t(1),cur:this.#y,next:this.#y}:this.#p===2?{prev:t(1),cur:t(1),next:this.#y}:{prev:t(2),cur:t(1),next:this.#y}}#lt(){if(this.#It(),!this.#le)return;const e=this.#e,t=e.videoWidth,i=e.videoHeight;if(t===0||i===0)return;const s=Math.min(e.offsetWidth/t,e.offsetHeight/i),r=t*s,o=i*s;this.#i.style.left=`${e.offsetLeft+(e.offsetWidth-r)/2}px`,this.#i.style.top=`${e.offsetTop+(e.offsetHeight-o)/2}px`,this.#i.style.width=`${r}px`,this.#i.style.height=`${o}px`}#oi(e,t){const i=this.#t;this.#r.width=e,this.#r.height=t,this.#F=e,this.#L=t,this.#p=0,this.#A=null,this.#k(),this.#lt();for(const s of this.#P)i.deleteTexture(s);this.#P=[];for(let s=0;s<R;s++){const r=i.createTexture();i.bindTexture(i.TEXTURE_2D,r),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,e,t,0,i.RGBA,i.UNSIGNED_BYTE,null),this.#P.push(r)}this.#$e(),this.#Gt(),(this.#z||this.#l||this.#_)&&this.#Xt(),this.#s?.resize(e,t),this.#Z()}#Ii(){if(this.#W)return;const e=this.#t,t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,M,D,0,e.RGBA,e.UNSIGNED_BYTE,null);const i=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,i),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const s=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!s){e.deleteFramebuffer(i),e.deleteTexture(t);return}this.#W={texture:t,framebuffer:i,pixels:new Uint8Array(M*D*4),previousLuma:new Uint8Array(M*D),currentLuma:new Uint8Array(M*D),nextLuma:new Uint8Array(M*D)}}#Gt(){this.#W&&(this.#t.deleteFramebuffer(this.#W.framebuffer),this.#t.deleteTexture(this.#W.texture),this.#W=null)}#Xt(){const e=this.#t;if(!(this.#C.length===B||this.#F===0)){this.#$e();for(let t=0;t<B;t++){const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#F,this.#L,0,e.RGBA,e.UNSIGNED_BYTE,null);const s=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,s),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(s),e.deleteTexture(i),this.#$e();return}this.#C.push({texture:i,framebuffer:s})}this.#_e=B-1}}#$e(){const e=this.#t,t=this.#A?.kind==="texture"?this.#A.texture:null;this.#C.some(i=>i.texture===t)&&(this.#A=null);for(const{texture:i,framebuffer:s}of this.#C)e.deleteFramebuffer(s),e.deleteTexture(i);this.#C=[],this.#U()}#Bi(){if(this.#le)return;const e=this.#e.parentElement;if(!e)return;const t=document.createElement("div");t.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(t,this.#e),t.appendChild(this.#e),t.appendChild(this.#i),this.#le=t,this.#ut?.observe(this.#e),this.#lt()}#Ni(){if(this.#x)return;const e=this.#le;this.#le=null,this.#ut?.disconnect(),this.#i.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#hi=()=>this.#lt();#Ht(e){return!this.#o||this.#c==="main"?!1:(this.#o.postMessage({type:"event",name:e,video:this.#Lt()}),!0)}#ai=()=>{if(this.#Ve=Number.NaN,this.#Ht("emptied")){this.#ee(),this.#q(!1);return}this.#p=0,this.#De=0,this.#Et=0,this.#U(),this.#$(),this.#a=0,this.#li(),this.#k(),this.#A=null,this.#q(!1)};#li(){this.#S={filtered:0,missed:0,degraded:0,discontinuities:0,resynced:0,late:0,queueResetted:0},this.#Ze.fill(0),this.#_t=0,this.#ne=0,this.#Qe=0,this.#Rt=0,this.#oe=0,this.#we=0,this.#Ue=0,this.#Ie=0,this.#pe=0,this.#re=0,this.#k(),this.#Be=0,this.#xe=0,this.#Ne=0,this.#Te=0}#k(){this.#U(),this.#K="video",this.#Me="c",this.#ft=0,this.#dt=!0,this.#mt.reset(),this.#pt=1/0,this.#vt=1/0}#ci=()=>{if(this.#Ht("seeking")){this.#ee();return}this.#Le=!1};#ie=e=>{if((e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#Ht(e.type)){this.#ee();return}if(e.type==="seeked"){const i=this.#Le;if(this.#Le=!1,i)return;this.#p=0,this.#k(),this.#$(),this.#A=null,this.#q(!1);return}const t=e.type==="ratechange";if(t&&(this.#a=0,this.#De=this.#e.currentTime),this.#U(),this.#E&&this.#p>0){const i=this.#kt(),s=i===null?void 0:this.#C[i];i!==null&&s?(this.#_e=i,this.#he(!0,!1,s.framebuffer),this.#si(i)):this.#he(!0,!1,null)}t&&(this.#p=0,this.#k(),this.#$())};#ui=e=>{if(e.preventDefault(),this.#x){this.#x.onFailure("the deinterlacer WebGL context was lost");return}this.#c!=="active"&&(this.#G=!0,this.#Dt("the deinterlacer WebGL context was lost"),this.stop())}}function ft(n,e,t,i,s,r,o){return new ut(n,t,{canvas:e,onFailure:i,onVisibility:s,requestAnimationFrame:r,cancelAnimationFrame:o})}function V(n,e){const t=n.createProgram(),i=ge(n,n.VERTEX_SHADER,et),s=ge(n,n.FRAGMENT_SHADER,e);if(n.attachShader(t,i),n.attachShader(t,s),n.linkProgram(t),n.deleteShader(i),n.deleteShader(s),!n.getProgramParameter(t,n.LINK_STATUS)){const r=n.getProgramInfoLog(t);throw n.deleteProgram(t),new Error(`the deinterlacer failed to link: ${r??"no reason given"}`)}return t}function ge(n,e,t){const i=n.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(n.shaderSource(i,t),n.compileShader(i),!n.getShaderParameter(i,n.COMPILE_STATUS)){const s=n.getShaderInfoLog(i);throw n.deleteShader(i),new Error(`the deinterlacer failed to compile: ${s??"no reason given"}`)}return i}const G=self;class dt extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#r=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#r=e.buffered}get buffered(){return{length:this.#r.length,start:e=>{const t=this.#r[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.start},end:e=>{const t=this.#r[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let C=null,A=null,Fe=!1;function mt(n){return G.requestAnimationFrame(n)}function pt(n){G.cancelAnimationFrame(n)}function k(n,e=[]){G.postMessage(n,e)}function vt(n,e,t){n.doubleRate=e.doubleRate,(n.autoFilm!==e.autoFilm||t==="autoFilm")&&(n.autoFilm=e.autoFilm),n.filmCombThreshold=e.filmCombThreshold,n.spatialCheck=e.spatialCheck,(n.film!==e.film||t==="film")&&(n.film=e.film),n.debug=e.debug}G.onmessage=n=>{const e=n.data;try{if(e.type==="initialize"){if(typeof G.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");C=new dt,C.update(e.video),A=ft(C,e.canvas,e.options,i=>{Fe||k({type:"failed",message:i})},i=>k({type:"visibility",visible:i}),mt,pt);let t=0;A.addEventListener("failure",()=>t++),A.addEventListener("stats",i=>{const{dropped:s,...r}=i.detail;k({type:"stats",stats:r,filmFailure:t})}),A.scan=e.scan,A.videoTimeline=e.videoTimeline,A.enabled=e.enabled,k({type:"ready"});return}if(!C||!A)return;switch(e.type){case"frame":C.update(e.video);try{A.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),k({type:"consumed",id:e.id})}break;case"settings":vt(A,e.options,e.retryFilm);break;case"scan":A.scan=e.scan;break;case"timeline":A.videoTimeline=e.videoTimeline;break;case"enabled":A.enabled=e.enabled;break;case"event":C.update(e.video),C.dispatchEvent(new Event(e.name));break;case"capture":C.videoWidth=e.width,C.videoHeight=e.height,A.capture().then(t=>k({type:"capture",id:e.id,image:t},[t])).catch(()=>k({type:"capture",id:e.id,image:null}));break;case"destroy":Fe=!0,A.destroy(),A=null,C=null,G.close();break}}catch(t){const i=t instanceof Error?t.message:String(t);k({type:"failed",message:i})}}})();
//# sourceMappingURL=worker-CM3qGCuk.js.map
