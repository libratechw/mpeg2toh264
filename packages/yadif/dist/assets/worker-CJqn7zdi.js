(function(){"use strict";const ue={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",parity:"uParity",tff:"uTff",spatialCheck:"uSpatialCheck"},fe=`#version 300 es
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
`,K={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",topFieldFirst:"uTopFieldFirst",match:"uMatch"},k=288,A=162,de=`#version 300 es
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
  ivec2 targetSize = ivec2(${k}, ${A});
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
`,me=`#version 300 es
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
`,pe=`#version 300 es
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
  ivec2 targetSize = ivec2(${k}, ${A});
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
`;class T{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#r;#t;#e;#i=0;#b=null;#l=[];#T=null;#U=1/0;#L=1/0;constructor(e,i){this.#r=e,this.#t=i,this.#e=255*T.DECIMATE_BLOCK**2*T.DUPLICATE_PERCENT/100}fieldMatch(e,i,t,r,n=T.COMBED_PIXEL_LIMIT){const s=r?1:0,a={p:e,c:i,n:t};let o=this.#I("c","p",s,a);const m=new Map,l=p=>{const E=m.get(p);if(E!==void 0)return E;const g=T.#N(this.weave(e,i,t,p,r),this.#r,this.#t);return m.set(p,g),g},d=l(o),c=l("n");(c*3<d||c*2<d&&d>n)&&Math.abs(c-d)>=30&&c<n&&(o="n");const h=l(o),f=h>=n;return f&&(o="c"),{match:o,combScore:h,isCombed:f,luma:this.weave(e,i,t,o,r)}}decimate(e){const i=this.#i,t=this.#T?T.#Me(this.#T,e,this.#r,this.#t):{maxBlockDifference:1/0,totalDifference:1/0};this.#l.push(t);const r=this.#b===i,n=r&&t.maxBlockDifference<this.#e;r&&!n&&(this.#b=null);const s=this.#b;this.#T=e.slice(),this.#i++;let a=this.#b;if(this.#i===T.CYCLE){let o=0,m=null;for(let l=1;l<this.#l.length;l++)(this.#l[l]?.maxBlockDifference??1/0)<(this.#l[o]?.maxBlockDifference??1/0)?(m=o,o=l):(m===null||(this.#l[l]?.maxBlockDifference??1/0)<(this.#l[m]?.maxBlockDifference??1/0))&&(m=l);this.#U=this.#l[o]?.maxBlockDifference??1/0,this.#L=m===null?1/0:this.#l[m]?.maxBlockDifference??1/0,a=(this.#l[o]?.maxBlockDifference??1/0)<this.#e?o:null,this.#b=a,this.#l=[],this.#i=0}return{cycleIndex:i,maxBlockDifference:t.maxBlockDifference,totalDifference:t.totalDifference,shouldDrop:n,dropIndex:s,nextDropIndex:a,lowestCycleDifference:this.#U,runnerUpCycleDifference:this.#L}}weave(e,i,t,r,n){if(r==="c")return i.slice();const s=i.slice(),a=r==="p"?e:t,o=s.length/this.#t,m=n?1:0;for(let l=m;l<this.#t;l+=2)s.set(a.subarray(l*o,(l+1)*o),l*o);return s}reset(){this.#i=0,this.#b=null,this.#l=[],this.#T=null,this.#U=1/0,this.#L=1/0}#I(e,i,t,r){const n=this.#r,s=this.#t,a=2-t,o=2-t,m=r[e],l=r[i],d=T.#Fe(m,l,n,s,t);let c=0,h=0,f=0,p=0,E=0,g=0;for(let L=2;L<s-2;L+=2){const R=(L-2)/2,ee=a-1+R*2,te=a+1+R*2,ie=a+3+R*2,$=a+R*2,Q=$+2,O=o+R*2,P=O+2,le=a+R*2;for(let S=8;S<n-8;S++){const I=(d[le*n+S]??0)|(d[(le+2)*n+S]??0);if(I===0)continue;const ce=(r.c[ee*n+S]??0)+((r.c[te*n+S]??0)<<2)+(r.c[ie*n+S]??0),W=Math.abs(3*((m[$*n+S]??0)+(m[Q*n+S]??0))-ce),G=Math.abs(3*((l[O*n+S]??0)+(l[P*n+S]??0))-ce);W>23&&(I&1)!==0&&(c+=W),G>23&&(I&1)!==0&&(p+=G),W>42&&(I&2)!==0&&(h+=W),G>42&&(I&2)!==0&&(E+=G),W>42&&(I&4)!==0&&(f+=W),G>42&&(I&4)!==0&&(g+=G)}}h<500&&E<500&&(f>=500||g>=500)&&Math.max(f,g)>3*Math.min(f,g)&&(h=f,E=g);const b=Math.floor(c/6+.5),_=Math.floor(p/6+.5),y=Math.floor(h/6+.5),v=Math.floor(E/6+.5),X=Math.max(b,_)/Math.max(Math.min(b,_),1),z=Math.max(y,v)/Math.max(Math.min(y,v),1),q=Math.max(y,v)/Math.max(Math.max(b,_),1);return(y>=500||v>=500)&&(y*2<v||v*2<y)||(y>=1e3||v>=1e3)&&(y*3<v*2||v*3<y*2)||(y>=2e3||v>=2e3)&&(y*5<v*4||v*5<y*4)||(y>=4e3||v>=4e3)&&z>X||q>.005&&Math.max(y,v)>150&&(y*2<v||v*2<y)?y>v?i:e:b>_?i:e}static#Fe(e,i,t,r,n){const s=Array.from({length:Math.ceil(r/2)},()=>new Uint8Array(t)),a=n===1?1:0;for(let l=0;l<s.length;l++){const d=Math.min(r-1,a+l*2),c=s[l];if(c)for(let h=0;h<t;h++)c[h]=Math.abs((e[d*t+h]??0)-(i[d*t+h]??0))}const o=new Uint8Array(t*r),m=n===1?3:2;for(let l=1;l<s.length-1;l++){const d=m+(l-1)*2;if(d>=r)break;const c=s[l];if(c)for(let h=1;h<t-1;h++){const f=c[h]??0;if(f<=3)continue;let p=0;for(let v=h-1;v<=h+1;v++)p+=(s[l-1]?.[v]??0)>3?1:0,p+=(s[l]?.[v]??0)>3?1:0,p+=(s[l+1]?.[v]??0)>3?1:0;if(p<=1)continue;const E=d*t+h;if(o[E]=1,f<=19)continue;p=0;let g=!1,b=!1;for(let v=h-1;v<=h+1;v++)(s[l-1]?.[v]??0)>19&&(p++,g=!0),(s[l]?.[v]??0)>19&&p++,(s[l+1]?.[v]??0)>19&&(p++,b=!0);if(p<=3)continue;if(g&&b){o[E]|=2;continue}let _=!1,y=!1;for(let v=Math.max(h-4,0);v<Math.min(h+5,t);v++)l!==1&&(s[l-2]?.[v]??0)>19&&(_=!0),(s[l-1]?.[v]??0)>19&&(g=!0),(s[l+1]?.[v]??0)>19&&(b=!0),l!==s.length-2&&(s[l+2]?.[v]??0)>19&&(y=!0);g&&(b||_)||b&&(g||y)?o[E]|=2:p>5&&(o[E]|=4)}}return o}static#N(e,i,t){const r=new Uint8Array(i*t);for(let s=0;s<t;s++){const a=s*i,o=Math.max(0,Math.min(t-1,s===0?1:s-1))*i,m=Math.max(0,Math.min(t-1,s===t-1?t-2:s+1))*i,l=Math.max(0,Math.min(t-1,s<2?s===0?2:3:s-2))*i,d=Math.max(0,Math.min(t-1,s+2>=t?s===t-1?t-3:t-4:s+2))*i;for(let c=0;c<i;c++){const h=e[a+c]??0,f=e[o+c]??0,p=e[m+c]??0,E=e[l+c]??0,g=e[d+c]??0;(s===0?Math.abs(h-p)>T.COMB_THRESHOLD:s===t-1?Math.abs(h-f)>T.COMB_THRESHOLD:Math.abs(h-f)>T.COMB_THRESHOLD&&Math.abs(h-p)>T.COMB_THRESHOLD)&&Math.abs(4*h-3*(f+p)+E+g)>T.COMB_THRESHOLD*6&&(r[s*i+c]=255)}}let n=0;for(const s of[0,8])for(const a of[0,8])for(let o=s;o<t;o+=16)for(let m=a;m<i;m+=16){let l=0;for(let d=Math.max(1,o);d<Math.min(t-1,o+16);d++)for(let c=m;c<Math.min(i,m+16);c++){const h=d*i+c;r[h-i]===255&&r[h]===255&&r[h+i]===255&&l++}n=Math.max(n,l)}return n}static#Me(e,i,t,r){const n=T.DECIMATE_BLOCK/2,s=Math.ceil(t/n),a=Math.ceil(r/n),o=new Float64Array(s*a),m=e.length/(t*r);for(let c=0;c<r;c++){const h=Math.floor(c/n);for(let f=0;f<t;f++){const p=Math.floor(f/n),E=h*s+p,g=(c*t+f)*m;if(m===1){o[E]=(o[E]??0)+Math.abs((e[g]??0)-(i[g]??0));continue}const b=Math.round((e[g]??0)*.2126+(e[g+1]??0)*.7152+(e[g+2]??0)*.0722),_=Math.round((i[g]??0)*.2126+(i[g+1]??0)*.7152+(i[g+2]??0)*.0722);if(o[E]=(o[E]??0)+Math.abs(b-_),(f&1)!==0||(c&1)!==0)continue;let y=0,v=0,X=0,z=0,q=0,L=0,R=0;for(let Q=c;Q<Math.min(c+2,r);Q++)for(let O=f;O<Math.min(f+2,t);O++){const P=(Q*t+O)*m;y+=e[P]??0,v+=e[P+1]??0,X+=e[P+2]??0,z+=i[P]??0,q+=i[P+1]??0,L+=i[P+2]??0,R++}const ee=Math.round((-.114572*y-.385428*v+.5*X)/R),te=Math.round((-.114572*z-.385428*q+.5*L)/R),ie=Math.round((.5*y-.454153*v-.045847*X)/R),$=Math.round((.5*z-.454153*q-.045847*L)/R);o[E]=(o[E]??0)+Math.abs(ee-te)+Math.abs(ie-$)}}let l=-1;for(let c=0;c<a-1;c++)for(let h=0;h<s-1;h++)l=Math.max(l,(o[c*s+h]??0)+(o[c*s+h+1]??0)+(o[(c+1)*s+h]??0)+(o[(c+1)*s+h+1]??0));let d=0;for(const c of o)d+=c;return{maxBlockDifference:l,totalDifference:d}}}let ve=null;const ge=.5,x=3,se=5,U=se+1,re=1e3,J=4,Z=200,Ee=.25,ye=1e3/60,be=.02,Te=250,xe=1e3/30,D=160,w=90;function ne(u){if(!Number.isFinite(u)||u<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return u}const Fe=`#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`,Me=`#version 300 es
precision highp float;
uniform sampler2D uField;
uniform bool uFlip;
out vec4 fragColor;
void main() {
  ivec2 position = ivec2(gl_FragCoord.xy);
  if (uFlip) position.y = textureSize(uField, 0).y - 1 - position.y;
  fragColor = texelFetch(uField, position, 0);
}
`;function Re(u){return Math.max(0,Math.round(u*1e6))}class ke{#r;#t=!1;#e=0;#i=0;constructor(e,i=!1){this.#r=e,this.#t=i}get enabled(){return this.#r!==void 0||this.#t}get generation(){return this.#e}get frameId(){return this.#i}invalidate(){return this.#e+=1,this.#e}destroy(){this.#r=void 0,this.#t=!1}deliver(e){this.#r?.(e)}emit(e,i,t,r,n){const s=this.#r;if(!s&&!this.#t)return null;this.#i+=1;const a={source:e,mediaTimestampUs:i,generation:this.#e,frameId:this.#i,second:t,width:r,height:n};return s?.(a),a}}class Ae extends EventTarget{#r;#t;#e;#i;#b;#l;#T;#U;#L;#I=null;#Fe=null;#N=null;#Me=null;#re=null;#vt=null;#B=null;#F=[];#x=[];#ne=U-1;#m=null;#n=[];#O=null;#Re=0;#W=null;#ae=ye;#Q=null;#We;#M;#v;#Y;#Ge;#D="video";#he="c";#He=0;#Xe=!0;#ze=new T(k,A);#qe=1/0;#Qe=1/0;#G=0;#o=0;#f=0;#p=0;#g=x-1;#u=0;#oe=0;#ke=Number.NaN;#le=!1;#V=null;#Ae=0;#j=0;#Ye=0;#d=!1;#we=!1;#Se=!1;#c=null;#$=[];#R=!1;#Ve;#De;#K;#A;#H;#ce=0;#je=!1;#$e=!1;#ue;#Ce;#Ke=!1;#C;#X;#J;#fe=null;#Z;#a;#_e;#w;#Je;#h=null;#s;#de=!1;#Ze=0;#et=!1;#Gt=0;#me=!1;#Pe=!1;#ee=null;#Ht=0;#pe=new Map;#S={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0};#z=0;#tt=0;#Ue=0;#q=0;#ve=0;#ge=0;#Ee=0;#te=0;constructor(e,i={},t=null){if(super(),this.#e=e,this.#M=i.doubleRate??!1,this.#v=i.autoFilm??!1,this.#Y=ne(i.filmCombThreshold??T.COMBED_PIXEL_LIMIT),this.#Ge=i.spatialCheck??!0,this.#Ve=i.onStats,this.#De=i.diagnostic?.onFilteredPicture,this.#K=i.diagnostic?.onPresentedFrame,i.presenter!==void 0){if(i.diagnostic?.onQueuedFrame!==void 0||i.diagnostic?.onQueuedMeta!==void 0||i.queuedFrameSink!==void 0)throw new TypeError("presenter cannot be combined with diagnostic frame transport");if(typeof VideoFrame>"u")throw new TypeError("presenter requires VideoFrame")}if(this.#H=i.presenter??null,this.#A=i.presenter?(s,a)=>i.presenter(s,{mediaTimestampUs:a.mediaTimestampUs,durationUs:a.durationUs}):i.diagnostic?.onQueuedFrame,this.#ue=i.diagnostic?.onQueuedMeta,this.#Ce=i.queuedFrameSink??null,this.#C=i.diagnostic?.onPresentationQueue,this.#X=(this.#A!==void 0||this.#ue!==void 0)&&(i.presenter!==void 0||i.diagnostic?.bypassDisplayQueue===!0),this.#J=i.presenter!==void 0||i.diagnostic?.captureQueuedFrameFullSize===!0,this.#J&&this.#A===void 0&&this.#ue===void 0)throw new TypeError("captureQueuedFrameFullSize requires onQueuedFrame or onQueuedMeta");if(this.#J&&!this.#X)throw new TypeError("captureQueuedFrameFullSize requires bypassDisplayQueue");this.#Z=this.#De||this.#K||this.#A||this.#C?new ke(this.#De,this.#K!==void 0||this.#A!==void 0||this.#C!==void 0):null,this.#a=t,this.#w=t?"main":i.rendering??"auto",this.#Je=i.workerUrl??ve,this.#s=this.#w==="main"?"main":"idle",this.#t=t?t.canvas:document.createElement("canvas"),this.#r=t?.canvas??(this.#w==="main"?this.#t:document.createElement("canvas")),this.#_e=e,t||(this.#t.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const r=this.#r.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!r)throw new Error("this browser has no WebGL2");this.#i=r,this.#b=H(r,fe);const n=this.#b;this.#l=Object.fromEntries(Object.entries(ue).map(([s,a])=>[s,r.getUniformLocation(n,a)])),this.#T=H(r,Me),this.#U=r.getUniformLocation(this.#T,"uField"),this.#L=r.getUniformLocation(this.#T,"uFlip"),this.#Xt(),this.#v&&this.#Rt(),this.#r.addEventListener("webglcontextlost",this.#Wt),this.#We=t?null:new ResizeObserver(()=>this.#Oe()),e.addEventListener("emptied",this.#Nt),e.addEventListener("resize",this.#It),e.addEventListener("pause",this.#P),e.addEventListener("ended",this.#P),e.addEventListener("seeking",this.#Ot),e.addEventListener("seeked",this.#P),e.addEventListener("ratechange",this.#P)}get running(){return this.#d&&(this.#c?.interlaced??!0)}get renderPath(){return{rendering:this.#w,workerState:this.#s,externalHost:this.#a!==null,presenterFailures:this.#ce}}get canvas(){return this.#t}get#Le(){return this.#c?.topFieldFirst!==!1}#gt(){return{doubleRate:this.#M,autoFilm:this.#v,filmCombThreshold:this.#Y,spatialCheck:this.#Ge,diagnostic:this.#De!==void 0,capturePresentedFrames:this.#K!==void 0,captureQueuedFrames:this.#A!==void 0,captureQueuedFrameFullSize:this.#J,capturePresentationQueue:this.#C!==void 0,bypassDisplayQueue:this.#X,captureQueuedMeta:this.#ue!==void 0}}get enabled(){return this.#we}set enabled(e){this.#we=e,this.#nt(),this.#h?.postMessage({type:"enabled",enabled:e})}set scan(e){const i=this.#c?.interlaced!==e?.interlaced,t=i||this.#c?.topFieldFirst!==e?.topFieldFirst;this.#c=e,this.#h?.postMessage({type:"scan",scan:e}),t&&(this.#u=0,this.#y(),this.#E(),i&&(this.#o=0),this.#m=null,this.#k(!1)),this.#nt(),t&&((e?.interlaced??!0)&&(this.#a||this.#s==="main")?this.#ie():this.#lt())}get scan(){return this.#c}set videoTimeline(e){this.#$=e,this.#h?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#c=null),this.#nt()}get videoTimeline(){return this.#$}get container(){return this.#Q??this.#e}get doubleRate(){return this.#M}set doubleRate(e){e!==this.#M&&(this.#M=e,this.#rt(),this.#n.length=0,this.#E(),e?(this.#f>0&&this.#mt(),(this.#c?.interlaced??!0)&&(this.#a||this.#s==="main")&&this.#ie()):this.#v||(this.#m=null,this.#k(!1),this.#se()))}get autoFilm(){return this.#v}set autoFilm(e){e!==this.#v&&(this.#v=e,this.#rt(),this.#y(),this.#E(),e?(this.#Rt(),this.#f>0&&(this.#Lt(),this.#mt()),(this.#c?.interlaced??!0)&&(this.#a||this.#s==="main")&&this.#ie()):(this.#dt(),this.#M||(this.#m=null,this.#k(!1),this.#se())))}get filmCombThreshold(){return this.#Y}set filmCombThreshold(e){const i=ne(e);i!==this.#Y&&(this.#Y=i,this.#rt(),this.#v&&this.#y())}get diagnosticGeneration(){return this.#Z?.generation??0}#Et(e,i,t){const r=this.#Z;return!r||this.#s!=="main"||!Number.isFinite(i)?null:r.emit(e,Re(i),t,this.#f,this.#p)}#it(e,i){const t={timestamp:e};Number.isFinite(i)&&i>0&&(t.duration=Math.max(1,Math.round(i*1e3)));const r=this.#e.videoWidth,n=this.#e.videoHeight;return r>0&&n>0&&(t.displayWidth=r,t.displayHeight=n),t}#st(e,i){const t=this.#K;if(!t||!e||typeof VideoFrame>"u")return;const r=this.#it(e.mediaTimestampUs,i),n=r.duration??null;let s;try{s=new VideoFrame(this.#r,r)}catch{return}try{t(s,{...e,presentationTimeMs:performance.now(),durationUs:n})}catch{s.close()}}#yt(e,i=!1){const t=this.#i;t.bindFramebuffer(t.FRAMEBUFFER,null),t.useProgram(this.#T),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,e),t.uniform1i(this.#U,0),t.uniform1i(this.#L,i?1:0),t.viewport(0,0,this.#f,this.#p),t.drawArrays(t.TRIANGLES,0,3)}#bt(e,i,t){const r=this.#A;if(!r||!i||typeof VideoFrame>"u"){this.#H&&(this.#ce+=1);return}this.#_t();const n=performance.now();if(this.#J){try{this.#yt(e)}catch{this.#H&&(this.#ce+=1);return}const d=this.#it(i.mediaTimestampUs,t),c=d.duration??null;let h;try{h=new VideoFrame(this.#r,d)}catch{this.#H&&(this.#ce+=1);return}try{r(h,{...i,queuedAtMs:n,durationUs:c,captureWidth:this.#f,captureHeight:this.#p})}catch{this.#H&&(this.#ce+=1),h.close()}return}const s=this.#fe;if(!s)return;const a=this.#i;try{a.bindFramebuffer(a.FRAMEBUFFER,s.framebuffer),a.useProgram(this.#T),a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,e),a.uniform1i(this.#U,0),a.uniform1i(this.#L,0),a.viewport(0,0,D,w),a.drawArrays(a.TRIANGLES,0,3),a.readPixels(0,0,D,w,a.RGBA,a.UNSIGNED_BYTE,s.pixels);const d=D*4;for(let h=0;h<w;h++){const f=(w-1-h)*d;s.flipped.set(s.pixels.subarray(f,f+d),h*d)}const c=s.context.createImageData(D,w);c.data.set(s.flipped),s.context.putImageData(c,0,0)}catch{a.bindFramebuffer(a.FRAMEBUFFER,null),a.viewport(0,0,this.#f,this.#p);return}a.bindFramebuffer(a.FRAMEBUFFER,null),a.viewport(0,0,this.#f,this.#p);const o=this.#it(i.mediaTimestampUs,t),m=o.duration??null;let l;try{l=new VideoFrame(s.canvas,o)}catch{return}try{r(l,{...i,queuedAtMs:n,durationUs:m,captureWidth:D,captureHeight:w})}catch{l.close()}}#Xt(){if(!this.#A||this.#J||this.#fe)return;let e=null;if(typeof OffscreenCanvas<"u")e=new OffscreenCanvas(D,w);else if(typeof document<"u"){const a=document.createElement("canvas");a.width=D,a.height=w,e=a}if(!e)return;const i=e.getContext("2d",{willReadFrequently:!0});if(!i)return;const t=this.#i,r=t.createTexture();if(!r)return;t.bindTexture(t.TEXTURE_2D,r),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,D,w,0,t.RGBA,t.UNSIGNED_BYTE,null);const n=t.createFramebuffer();if(!n){t.deleteTexture(r);return}t.bindFramebuffer(t.FRAMEBUFFER,n),t.framebufferTexture2D(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0,t.TEXTURE_2D,r,0);const s=t.checkFramebufferStatus(t.FRAMEBUFFER)===t.FRAMEBUFFER_COMPLETE;if(t.bindFramebuffer(t.FRAMEBUFFER,null),!s){t.deleteFramebuffer(n),t.deleteTexture(r);return}this.#fe={texture:r,framebuffer:n,canvas:e,context:i,pixels:new Uint8Array(D*w*4),flipped:new Uint8ClampedArray(D*w*4)}}#zt(){const e=this.#fe;e&&(this.#i.deleteFramebuffer(e.framebuffer),this.#i.deleteTexture(e.texture),this.#fe=null)}#E(){this.#Z?.invalidate()}#rt(){this.#h?.postMessage({type:"settings",options:this.#gt()})}#nt(){this.#we&&(this.#$.length>0||(this.#c?.interlaced??!0))?this.start():this.stop()}#qt(){return this.#a||this.#w==="main"?!1:this.#s==="starting"||this.#s==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#Je!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#Tt(),!0):this.#w==="auto"?(this.#Ie(),!1):(this.#s="failed",this.#d=!1,!0)}#Tt(){this.#_(),this.#h?.terminate(),this.#h=null,this.#me=!1,this.#Pe=!1;let e=this.#t;if(this.#et){e=document.createElement("canvas"),e.className=this.#t.className;const s=this.#t.getAttribute("style");s===null?e.removeAttribute("style"):e.setAttribute("style",s),e.style.visibility="hidden",this.#t.parentElement&&this.#t.replaceWith(e),this.#t=e}const i=++this.#Ze;this.#je=!1,this.#$e=!1,this.#E(),this.#s="starting";let t,r;try{r=e.transferControlToOffscreen(),this.#et=!0,t=new Worker(this.#Je,{type:"module"})}catch(s){this.#ye(s instanceof Error?s.message:String(s));return}this.#h=t,t.onmessage=s=>{i===this.#Ze&&!this.#Se?this.#Qt(s.data):(s.data.type==="presented"||s.data.type==="queued")&&s.data.frame.close()},t.onerror=s=>{i===this.#Ze&&(s.preventDefault(),this.#ye(s.message||"the deinterlacer worker failed"))};const n=[r];this.#Ce&&!this.#Ke&&(n.push(this.#Ce),this.#Ke=!0),t.postMessage({type:"initialize",canvas:r,options:this.#gt(),queuedFrameSink:this.#Ke?this.#Ce:null,scan:this.#c,videoTimeline:this.#$,enabled:this.#d,video:this.#at()},n)}#Qt(e){switch(e.type){case"ready":this.#s="active",this.#d&&(this.#be(),this.#ct());break;case"failed":this.#ye(e.message);break;case"consumed":{this.#me=!1,this.#Pe=!0;const i=this.#ee;this.#ee=null,i&&this.#Ft(i);break}case"visibility":this.#t.style.visibility=e.visible?"visible":"hidden";break;case"presenterOwnsDisplay":this.#je=e.owns;break;case"diagnostic":{if(this.#s!=="active")break;this.#Z?.deliver(e.meta);break}case"queuedMeta":{if(this.#s!=="active")break;try{this.#ue?.(e.meta)}catch{}break}case"presented":{if(this.#s!=="active"){e.frame.close();break}const i=this.#K;if(!i){e.frame.close();break}try{i(e.frame,e.meta)}catch{e.frame.close()}break}case"queued":{if(this.#s!=="active"){e.frame.close();break}const i=this.#A;if(!i){e.frame.close();break}this.#_t(),this.#Be();try{i(e.frame,e.meta)}catch{e.frame.close()}break}case"presentationQueue":this.#s==="active"&&this.#C?.(e.meta);break;case"stats":{const i={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0};this.dispatchEvent(new CustomEvent("stats",{detail:i})),this.#Ve?.(i);break}case"capture":{const i=this.#pe.get(e.id);if(this.#pe.delete(e.id),!i){e.image?.close();break}e.image?i.resolve(e.image):createImageBitmap(this.#e).then(i.resolve,i.reject);break}}}#ye(e){if(this.#s==="starting"&&this.#w==="auto"&&!this.#de){this.#Ie();return}if(this.#xt(e),!this.#de){this.#de=!0,this.#Tt();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#s="failed",this.#h?.terminate(),this.#h=null,this.#_(),this.stop()}#Ie(){const e=this.#r;e.className=this.#t.className;const i=this.#t.getAttribute("style");i===null?e.removeAttribute("style"):e.setAttribute("style",i),e.style.visibility="hidden",this.#t.parentElement&&this.#t.replaceWith(e),this.#t=e,this.#et=!1,this.#h?.terminate(),this.#h=null,this.#s="main",this.#E(),this.#_(),this.#d&&(this.#be(),this.#ct(),(this.#c?.interlaced??!0)&&this.#ie())}#_(){this.#ee?.frame.close(),this.#ee=null}#xt(e){for(const i of this.#pe.values())i.reject(new Error(e));this.#pe.clear()}start(){if(!(this.#d||this.#Se||this.#R)){if(this.#d=!0,this.#Bt(),this.#y(),this.#Ae=performance.now(),this.#Ye=this.#Ae,this.#ke=Number.NaN,this.#j=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#hi(),this.#ct(),this.#qt()){this.#h?.postMessage({type:"enabled",enabled:!0}),this.#s==="active"&&this.#be();return}this.#be(),(this.#c?.interlaced??!0)&&this.#ie()}}stop(){this.#d&&(this.#d=!1,this.#V!==null&&this.#e.cancelVideoFrameCallback(this.#V),this.#V=null,this.#ei(),this.#lt(),this.#u=0,this.#m=null,this.#k(!1),this.#E(),this.#_(),this.#h?.postMessage({type:"enabled",enabled:!1}))}destroy(){if(!this.#Se){this.#Se=!0,this.#we=!1,this.stop(),this.#h?.postMessage({type:"destroy"}),this.#h?.terminate(),this.#h=null,this.#E(),this.#Z?.destroy(),this.#_(),this.#xt("the deinterlacer was destroyed"),this.#r.removeEventListener("webglcontextlost",this.#Wt),this.#e.removeEventListener("emptied",this.#Nt),this.#e.removeEventListener("resize",this.#It),this.#e.removeEventListener("pause",this.#P),this.#e.removeEventListener("ended",this.#P),this.#e.removeEventListener("seeking",this.#Ot),this.#e.removeEventListener("seeked",this.#P),this.#e.removeEventListener("ratechange",this.#P),this.#oi();for(const e of this.#F)this.#i.deleteTexture(e);this.#F=[],this.#zt(),this.#se(),this.#dt(),this.#i.deleteProgram(this.#b),this.#i.deleteProgram(this.#T),this.#I&&this.#i.deleteProgram(this.#I),this.#N&&this.#i.deleteProgram(this.#N),this.#re&&this.#i.deleteProgram(this.#re),this.#i.getExtension("WEBGL_lose_context")?.loseContext()}}capture(){if(this.#s==="active"&&this.#t.style.visibility==="visible"&&this.#h){const r=++this.#Ht,n=new Promise((s,a)=>{this.#pe.set(r,{resolve:s,reject:a})});return this.#h.postMessage({type:"capture",id:r,width:this.#e.videoWidth,height:this.#e.videoHeight}),n}if(this.#s==="starting"||this.#s==="failed")return createImageBitmap(this.#e);const e=this.#m;if(this.#a&&(!this.#d||this.#R||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#d||this.#R||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#ft(e.texture,e.flip,!1):e.kind==="yadif"?this.#xe(e.flush,e.second,null,!1):this.#ht(null,!1);const i=this.#e.videoWidth,t=this.#e.videoHeight;return i>0&&t>0&&(i!==this.#r.width||t!==this.#r.height)?createImageBitmap(this.#r,{resizeWidth:i,resizeHeight:t,resizeQuality:"high"}):createImageBitmap(this.#r)}addEventListener(e,i,t){super.addEventListener(e,i,t)}removeEventListener(e,i,t){super.removeEventListener(e,i,t)}#be(){this.#a||!this.#d||this.#V!==null||(this.#V=this.#e.requestVideoFrameCallback(this.#Vt))}#at(){const e=[];for(let i=0;i<this.#e.buffered.length;i++)e.push({start:this.#e.buffered.start(i),end:this.#e.buffered.end(i)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#Yt(e,i){let t;try{t=new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(i.mediaTime*1e6))})}catch(n){const s=n instanceof Error?n.message:String(n);this.#w==="auto"&&!this.#Pe&&!this.#de?(this.#Ie(),this.#Ne(e,i)):this.#ye(s);return}const r={id:++this.#Gt,frame:t,now:e,metadata:i,video:this.#at()};if(this.#me){this.#ee?.frame.close(),this.#ee=r;return}this.#Ft(r)}#Ft(e){const i=this.#h;if(!i||this.#s!=="active"){e.frame.close();return}this.#me=!0;const t={type:"frame",...e};try{i.postMessage(t,[e.frame])}catch(r){this.#me=!1,e.frame.close();const n=r instanceof Error?r.message:String(r);this.#w==="auto"&&!this.#Pe&&!this.#de?(this.#Ie(),this.#Ne(e.now,e.metadata)):this.#ye(n)}}#Vt=(e,i)=>{this.#V=null,!(!this.#d||this.#R)&&(this.#Ae=e,this.#j=Math.max(this.#j,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0),this.#Mt(e,i),this.#be())};#Mt(e,i){if(this.#ke=i.mediaTime,this.#s==="active"){this.#Yt(e,i);return}this.#s!=="starting"&&this.#Ne(e,i)}ingestExternalFrame(e,i,t){this.#_e=t;try{this.#Ne(e,i)}finally{this.#_e=this.#e}}#Ne(e,i){if(this.#jt(i.mediaTime),i.width>0&&i.height>0){let t=!1;if(!this.#le&&this.#e.seeking){const h=this.#e.buffered,f=this.#o>=J?this.#o/1e3:Z/1e3;for(let p=0;p<h.length;p++)if(i.mediaTime>=h.start(p)&&i.mediaTime<h.end(p)&&Math.abs(i.mediaTime-this.#e.currentTime)<=f){t=!0;break}}if(t&&(this.#le=!0),(this.#f===0||this.#p===0)&&this.#Ut(i.width,i.height),this.#c&&!this.#c.interlaced){this.#si();return}const r=i.mediaTime-this.#oe,n=t||r<0||r>ge;n&&(this.#u=0,this.#o=0,this.#S.discontinuities++,this.#E(),this.#n.length=0,this.#y());const s=this.#v&&this.#z!==0&&i.presentedFrames-this.#z>1;if(this.#ni(i.presentedFrames,n),!n&&s&&(this.#u=0,this.#y()),this.#u>0&&i.mediaTime===this.#oe)return;!n&&r>0&&this.#$t(r),this.#oe=i.mediaTime;const a=performance.now();a-this.#tt>re&&(this.#Ue=a,this.#q=0,this.#ve=0,this.#ge=0,this.#Ee=0,this.#te=0,this.#G=0),this.#tt=a;const o=performance.now();this.#Pt();const m=this.#D,l=this.#v&&this.#u===x&&this.#Kt();if(m!==this.#D&&(this.#n.length=0),!(l&&this.#Te()))if(this.#v&&!this.#Xe&&this.#D==="film")if(this.#Te()){const h=this.#o*5/4;this.#At(1);const f=this.#n.at(-1),p=f==null?e+h:f.at+f.duration;this.#Jt(p,h,i.mediaTime)}else this.#ht(null,!0,i.mediaTime);else if(this.#M&&this.#Te()){const h=this.#o/2;this.#At(2);const f=this.#n.at(-1),p=f==null?e+h*2:f.at+f.duration;this.#kt(!1,p,h,i.mediaTime),this.#kt(!0,p+h,h,i.mediaTime+h/1e3)}else this.#S.late+=this.#n.length,this.#n.length=0,this.#xe(!1,!1,null,!0,i.mediaTime);this.#te=Math.max(this.#te,this.#n.length),this.#ve+=performance.now()-o,this.#q++,this.#ai(a)}}#jt(e){let i;for(let n=this.#$.length-1;n>=0;n--){const s=this.#$[n];if(s.start<=e+1e-6){i=s;break}}i?.codedSize&&(i.codedSize.width!==this.#f||i.codedSize.height!==this.#p)&&this.#Ut(i.codedSize.width,i.codedSize.height);const t=i?.scan;if(!t||this.#c?.interlaced===t.interlaced&&this.#c.topFieldFirst===t.topFieldFirst)return;const r=this.#c?.interlaced;this.#c=t,this.#u=0,this.#n.length=0,this.#y(),this.#E(),r!==t.interlaced&&(this.#o=0),t.interlaced&&(this.#a||this.#s==="main")?this.#ie():this.#lt()}#Te(){return(this.#M||this.#v)&&this.#o>0&&this.#x.length===U}#$t(e){const i=e*1e3/(this.#e.playbackRate||1),t=this.#o>0?Math.max(1,Math.round(i/this.#o)):1,r=i/t;r<J||r>Z||(this.#o=this.#o>0?this.#o+(r-this.#o)*Ee:r)}#Rt(){if(this.#I&&this.#N&&this.#re)return;const e=this.#i,i=H(e,de),t=H(e,me),r=H(e,pe);this.#I=i,this.#Fe=Object.fromEntries(Object.entries(K).filter(([n])=>n!=="match"&&n!=="topFieldFirst").map(([n,s])=>[n,e.getUniformLocation(i,s)])),this.#N=t,this.#Me=Object.fromEntries(Object.entries(K).map(([n,s])=>[n,e.getUniformLocation(t,s)])),this.#re=r,this.#vt=Object.fromEntries(Object.entries(K).map(([n,s])=>[n,e.getUniformLocation(r,s)]))}#Kt(){const e=this.#B,i=this.#I,t=this.#Fe,r=this.#re,n=this.#vt;if(!e||!i||!t||!r||!n)return!1;const s=this.#i,a=this.#g,o=(this.#g+x-1)%x,m=(this.#g+1)%x,l=this.#Le;s.bindFramebuffer(s.FRAMEBUFFER,e.framebuffer),s.useProgram(i);for(const[g,b]of[m,o,a].entries())s.activeTexture(s.TEXTURE0+g),s.bindTexture(s.TEXTURE_2D,this.#F[b]??null);s.uniform1i(t.prev,0),s.uniform1i(t.cur,1),s.uniform1i(t.next,2),s.uniform2i(t.size,this.#f,this.#p),s.viewport(0,0,k,A),s.drawArrays(s.TRIANGLES,0,3),s.readPixels(0,0,k,A,s.RGBA,s.UNSIGNED_BYTE,e.pixels);const{previousLuma:d,currentLuma:c,nextLuma:h}=e;for(let g=0;g<d.length;g++){const b=g*4;d[g]=e.pixels[b]??0,c[g]=e.pixels[b+1]??0,h[g]=e.pixels[b+2]??0}const f=this.#ze.fieldMatch(d,c,h,l,this.#Y);s.useProgram(r),s.uniform1i(n.prev,0),s.uniform1i(n.cur,1),s.uniform1i(n.next,2),s.uniform2i(n.size,this.#f,this.#p),s.uniform1i(n.topFieldFirst,l?1:0),s.uniform1i(n.match,f.match==="p"?0:f.match==="c"?1:2),s.drawArrays(s.TRIANGLES,0,3),s.readPixels(0,0,k,A,s.RGBA,s.UNSIGNED_BYTE,e.pixels);const p=this.#ze.decimate(e.pixels);this.#he=f.match,this.#He=f.combScore,this.#Xe=f.isCombed,this.#qe=p.lowestCycleDifference,this.#Qe=p.runnerUpCycleDifference;const E=p.dropIndex!==null&&!f.isCombed;return(E?"film":"video")!==this.#D&&(this.#D=E?"film":"video"),p.shouldDrop&&!f.isCombed}#Jt(e,i,t){const r=this.#ot();if(r===null)return;const n=this.#x[r];if(!n)return;this.#ne=r;const s=this.#ht(n.framebuffer,!0,t);this.#bt(n.texture,s,i),this.#X||this.#n.push({slot:r,at:e,enqueuedAtMs:this.#C?performance.now():null,duration:i,diagnosticMeta:s})}#ht(e,i=!0,t=Number.NaN){const r=this.#N,n=this.#Me;if(!r||!n)return null;const s=this.#i,a=this.#g,o=(this.#g+x-1)%x,m=(this.#g+1)%x,l=this.#Le;s.bindFramebuffer(s.FRAMEBUFFER,e),s.useProgram(r);for(const[c,h]of[m,o,a].entries())s.activeTexture(s.TEXTURE0+c),s.bindTexture(s.TEXTURE_2D,this.#F[h]??null);s.uniform1i(n.prev,0),s.uniform1i(n.cur,1),s.uniform1i(n.next,2),s.uniform2i(n.size,this.#f,this.#p),s.uniform1i(n.topFieldFirst,l?1:0),s.uniform1i(n.match,this.#he==="p"?0:this.#he==="c"?1:2),s.viewport(0,0,this.#f,this.#p),s.drawArrays(s.TRIANGLES,0,3);const d=i?this.#Et("film",t,!1):null;return e===null&&(this.#m={kind:"film"},this.#k(!0),i&&(this.#G++,this.#st(d,this.#o))),d}#kt(e,i,t,r){const n=this.#ot();if(n===null)return;const s=this.#x[n];if(!s)return;this.#ne=n;const a=this.#xe(!1,e,s.framebuffer,!0,r);this.#bt(s.texture,a,t),this.#X||this.#n.push({slot:n,at:i,enqueuedAtMs:this.#C?performance.now():null,duration:t,diagnosticMeta:a})}#At(e){const i=Math.max(0,this.#n.length+e-se);let t=0,r=0;for(;r<i;){const n=this.#n.shift();if(!n)break;t+=n.duration,r++}for(const n of this.#n)n.at-=t;this.#S.late+=r}#ot(){const e=this.#m?.kind==="texture"?this.#m.texture:null,i=new Set(this.#n.map(({slot:t})=>t));for(let t=1;t<=U;t++){const r=(this.#ne+t)%U,n=this.#x[r];if(n&&n.texture!==e&&!i.has(r))return r}return null}#ie(){this.#O===null&&(!this.#d||this.#R||(this.#Re=0,this.#O=this.#St(this.#wt)))}#lt(){this.#O!==null&&this.#Zt(this.#O),this.#O=null,this.#n.length=0}#wt=e=>{if(this.#O=null,!(!this.#d||this.#R)){if(this.#Re>0){const i=e-this.#Re;i>=1&&i<=Z&&(this.#ae=i<this.#ae?i:this.#ae+(i-this.#ae)*be)}this.#Re=e,this.#s==="main"&&this.#ii(e),this.#O=this.#St(this.#wt)}};#St(e){return this.#a?this.#a.requestAnimationFrame(e):requestAnimationFrame(e)}#Zt(e){this.#a?this.#a.cancelAnimationFrame(e):cancelAnimationFrame(e)}#ct(){this.#a||this.#W!==null||!this.#d||this.#R||(this.#W=requestAnimationFrame(this.#Dt))}#ei(){this.#W!==null&&cancelAnimationFrame(this.#W),this.#W=null}#Dt=e=>{this.#W=null,!(!this.#d||this.#R)&&(this.#ti(e),this.#W=requestAnimationFrame(this.#Dt))};#ti(e){if(this.#a||e-this.#Ae<Te||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const i=this.#e.currentTime,t=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,r=this.#o>=J?this.#o:xe,n=t>this.#j,s=i!==this.#ke&&e-this.#Ye>=r*.75;!n&&!s||(this.#j=Math.max(this.#j,t),this.#Ye=e,this.#Mt(e,{mediaTime:i,presentedFrames:Math.max(this.#z+1,t),width:this.#e.videoWidth,height:this.#e.videoHeight}))}#ii(e){const i=e+this.#ae*1.5,t=this.#n.length;let r=0;const n=[];for(;this.#n[1]&&this.#n[1].at<=i;){this.#S.late++;const o=this.#n.shift();o&&n.push({frameId:o.diagnosticMeta?.frameId??null,generation:o.diagnosticMeta?.generation??null,mediaTimestampUs:o.diagnosticMeta?.mediaTimestampUs??null,plannedAtMs:o.at,enqueuedAtMs:o.enqueuedAtMs,reason:"deadline"}),r++}let s=this.#n[0];if(this.#C?.({atMs:e,deadlineMs:i,queueLengthBefore:t,retired:r,queueLengthAfter:this.#n.length,selectedFrameId:s?.diagnosticMeta?.frameId??null,selectedAtMs:s?.at??null,selectedEnqueuedAtMs:s?.enqueuedAtMs??null,retiredFields:n}),!s||s.at>i)return;this.#n.shift();const a=performance.now();this.#Ct(s.slot,s.diagnosticMeta,s.duration),this.#Ee+=performance.now()-a,this.#ge++}#Ct(e,i=null,t=0){const r=this.#x[e];r&&this.#ft(r.texture,!1,!0,i,t)}#si(){this.#Pt();const e=this.#F[this.#g];e&&this.#ft(e,!0),this.#u=0}#k(e){const i=this.#ri?!1:e;if(this.#a){this.#a.onVisibility(i),this.#Be();return}this.#t.style.visibility=i?"visible":"hidden",this.#Be()}get#ri(){return this.#ut()}get presenterOwnsDisplay(){return this.#h!==null?this.#je:this.#ut()}#ut(){return(this.#H!==null||this.#X)&&this.#c?.interlaced!==!1&&this.#Te()}#Be(){const e=this.#ut();e!==this.#$e&&(this.#$e=e,this.#a?.onPresenterOwnsDisplay?.(e))}#_t(){if(!(this.#H===null&&!this.#X)){if(this.#Be(),this.#a){this.#a.onVisibility(!1);return}this.#t.style.visibility="hidden"}}#ft(e,i=!1,t=!0,r=null,n=0){this.#yt(e,i),this.#m={kind:"texture",texture:e,flip:i},this.#k(!0),t&&(this.#G++,this.#st(r,n))}#ni(e,i){this.#z!==0&&!i&&(this.#S.missed+=Math.max(0,e-this.#z-1)),this.#z=e}#ai(e){const i=e-this.#Ue;if(i<re)return;const t=this.#Te()&&(this.#M||this.#D==="film")?this.#ge:this.#q,r={...this.#S,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:t*1e3/i,frameMs:this.#q===0?0:(this.#ve+this.#Ee)/this.#q,maxQueuedFields:this.#te,mode:this.#D,match:this.#he,combScore:this.#He,outputFps:this.#G*1e3/i,duplicateScore:this.#qe,duplicateRunnerUp:this.#Qe};this.dispatchEvent(new CustomEvent("stats",{detail:r})),this.#Ve?.(r),this.#Ue=e,this.#q=0,this.#ve=0,this.#ge=0,this.#Ee=0,this.#te=0,this.#G=0}#Pt(){const e=this.#i;this.#g=(this.#g+1)%x,e.bindTexture(e.TEXTURE_2D,this.#F[this.#g]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#_e),this.#u=Math.min(this.#u+1,x)}#xe(e,i,t,r=!0,n=Number.NaN){if(this.#u===0||this.#R)return null;let s=null;r&&(this.#u===x&&!e?this.#S.filtered++:this.#S.degraded++,s=this.#Et(e?"yadif-flush":i?"yadif-second":"yadif-first",n,i));const a=this.#i,o=this.#g,m=(this.#g+x-1)%x,l=(this.#g+1)%x;let d,c,h;this.#u===1?d=c=h=o:e?(d=m,c=h=o):this.#u===2?(d=c=m,h=o):(d=l,c=m,h=o),a.bindFramebuffer(a.FRAMEBUFFER,t),a.useProgram(this.#b);for(const[p,E]of[d,c,h].entries())a.activeTexture(a.TEXTURE0+p),a.bindTexture(a.TEXTURE_2D,this.#F[E]??null);a.uniform1i(this.#l.prev,0),a.uniform1i(this.#l.cur,1),a.uniform1i(this.#l.next,2),a.uniform2i(this.#l.size,this.#f,this.#p);const f=this.#Le?0:1;return a.uniform1i(this.#l.parity,i?1-f:f),a.uniform1i(this.#l.tff,this.#Le?1:0),a.uniform1i(this.#l.spatialCheck,this.#Ge?1:0),a.viewport(0,0,this.#f,this.#p),a.drawArrays(a.TRIANGLES,0,3),t===null&&(this.#m={kind:"yadif",flush:e,second:i},this.#k(!0),r&&(this.#G++,this.#st(s,this.#o))),s}#Oe(){if(!this.#Q)return;const e=this.#e,i=e.videoWidth,t=e.videoHeight;if(i===0||t===0)return;const r=Math.min(e.offsetWidth/i,e.offsetHeight/t),n=i*r,s=t*r;this.#t.style.left=`${e.offsetLeft+(e.offsetWidth-n)/2}px`,this.#t.style.top=`${e.offsetTop+(e.offsetHeight-s)/2}px`,this.#t.style.width=`${n}px`,this.#t.style.height=`${s}px`}#Ut(e,i){const t=this.#i;this.#r.width=e,this.#r.height=i,this.#f=e,this.#p=i,this.#u=0,this.#m=null,this.#y(),this.#E(),this.#Oe();for(const r of this.#F)t.deleteTexture(r);this.#F=[];for(let r=0;r<x;r++){const n=t.createTexture();t.bindTexture(t.TEXTURE_2D,n),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,e,i,0,t.RGBA,t.UNSIGNED_BYTE,null),this.#F.push(n)}this.#se(),this.#dt(),this.#v&&this.#Lt(),(this.#M||this.#v)&&this.#mt()}#Lt(){if(this.#B)return;const e=this.#i,i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,k,A,0,e.RGBA,e.UNSIGNED_BYTE,null);const t=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,t),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(t),e.deleteTexture(i);return}this.#B={texture:i,framebuffer:t,pixels:new Uint8Array(k*A*4),previousLuma:new Uint8Array(k*A),currentLuma:new Uint8Array(k*A),nextLuma:new Uint8Array(k*A)}}#dt(){this.#B&&(this.#i.deleteFramebuffer(this.#B.framebuffer),this.#i.deleteTexture(this.#B.texture),this.#B=null)}#mt(){const e=this.#i;if(!(this.#x.length===U||this.#f===0)){this.#se();for(let i=0;i<U;i++){const t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#f,this.#p,0,e.RGBA,e.UNSIGNED_BYTE,null);const r=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,r),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const n=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!n){e.deleteFramebuffer(r),e.deleteTexture(t),this.#se();return}this.#x.push({texture:t,framebuffer:r})}this.#ne=U-1}}#se(){const e=this.#i,i=this.#m?.kind==="texture"?this.#m.texture:null;this.#x.some(t=>t.texture===i)&&(this.#m=null);for(const{texture:t,framebuffer:r}of this.#x)e.deleteFramebuffer(r),e.deleteTexture(t);this.#x=[],this.#n.length=0}#hi(){if(this.#Q)return;const e=this.#e.parentElement;if(!e)return;const i=document.createElement("div");i.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(i,this.#e),i.appendChild(this.#e),i.appendChild(this.#t),this.#Q=i,this.#We?.observe(this.#e),this.#Oe()}#oi(){if(this.#a)return;const e=this.#Q;this.#Q=null,this.#We?.disconnect(),this.#t.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#It=()=>this.#Oe();#pt(e){return!this.#h||this.#s==="main"?!1:(this.#h.postMessage({type:"event",name:e,video:this.#at()}),!0)}#Nt=()=>{if(this.#E(),this.#ke=Number.NaN,this.#pt("emptied")){this.#_(),this.#k(!1);return}this.#u=0,this.#oe=0,this.#n.length=0,this.#o=0,this.#Bt(),this.#y(),this.#m=null,this.#k(!1)};#Bt(){this.#S={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0},this.#z=0,this.#Ue=0,this.#tt=0,this.#q=0,this.#ve=0,this.#ge=0,this.#Ee=0,this.#te=0,this.#G=0,this.#y()}#y(){this.#n.length=0,this.#D="video",this.#he="c",this.#He=0,this.#Xe=!0,this.#ze.reset(),this.#qe=1/0,this.#Qe=1/0}#Ot=()=>{if(this.#E(),this.#pt("seeking")){this.#_();return}this.#le=!1};#P=e=>{if(this.#E(),(e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#pt(e.type)){this.#_();return}if(e.type==="seeked"){const t=this.#le;if(this.#le=!1,t)return;this.#u=0,this.#y(),this.#m=null,this.#k(!1);return}const i=e.type==="ratechange";if(i&&(this.#o=0,this.#oe=this.#e.currentTime),this.#n.length=0,this.#d&&this.#u>0){const t=this.#ot(),r=t===null?void 0:this.#x[t];if(t!==null&&r){this.#ne=t;const n=this.#xe(!0,!1,r.framebuffer,!0,this.#e.currentTime);this.#Ct(t,n,this.#o)}else this.#xe(!0,!1,null,!0,this.#e.currentTime)}i&&(this.#u=0,this.#y())};#Wt=e=>{if(e.preventDefault(),this.#a){this.#a.onFailure("the deinterlacer WebGL context was lost");return}this.#s!=="active"&&(this.#R=!0,this.stop())}}function we(u,e,i,t,r,n,s,a){return new Ae(u,i,{canvas:e,onFailure:t,onVisibility:r,onPresenterOwnsDisplay:n,requestAnimationFrame:s,cancelAnimationFrame:a})}function H(u,e){const i=u.createProgram(),t=ae(u,u.VERTEX_SHADER,Fe),r=ae(u,u.FRAGMENT_SHADER,e);if(u.attachShader(i,t),u.attachShader(i,r),u.linkProgram(i),u.deleteShader(t),u.deleteShader(r),!u.getProgramParameter(i,u.LINK_STATUS)){const n=u.getProgramInfoLog(i);throw u.deleteProgram(i),new Error(`the deinterlacer failed to link: ${n??"no reason given"}`)}return i}function ae(u,e,i){const t=u.createShader(e);if(!t)throw new Error("the deinterlacer could not create a shader");if(u.shaderSource(t,i),u.compileShader(t),!u.getShaderParameter(t,u.COMPILE_STATUS)){const r=u.getShaderInfoLog(t);throw u.deleteShader(t),new Error(`the deinterlacer failed to compile: ${r??"no reason given"}`)}return t}const N=self;class Se extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#r=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#r=e.buffered}get buffered(){return{length:this.#r.length,start:e=>{const i=this.#r[e];if(!i)throw new DOMException("Invalid range index","IndexSizeError");return i.start},end:e=>{const i=this.#r[e];if(!i)throw new DOMException("Invalid range index","IndexSizeError");return i.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let C=null,F=null,B=!1,Y=null,he=Promise.resolve(),V=null,j=null,oe=null;function De(u,e,i){he=he.then(async()=>{const t=Y;if(!t){u.close();return}const r=Number.isFinite(u.timestamp)?Number(u.timestamp):Number(e.mediaTimestampUs);oe!==e.generation&&(oe=e.generation,V=null,j=null),(V===null||j===null)&&(V=performance.now(),j=r);const n=V+(r-j)/1e3,s=Math.max(0,n-performance.now());s>0&&await new Promise(a=>setTimeout(a,s));try{await t.write(u)}catch{try{u.close()}catch{}}i&&M({type:"queuedMeta",meta:e})}).catch(()=>{})}function Ce(u){return N.requestAnimationFrame(u)}function _e(u){N.cancelAnimationFrame(u)}function M(u,e=[]){N.postMessage(u,e)}function Pe(u,e){u.doubleRate=e.doubleRate,u.autoFilm=e.autoFilm,u.filmCombThreshold=e.filmCombThreshold}N.onmessage=u=>{const e=u.data;try{if(e.type==="initialize"){if(typeof N.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");Y=e.queuedFrameSink?e.queuedFrameSink.getWriter():null,C=new Se,C.update(e.video);const i=e.options.diagnostic||e.options.capturePresentedFrames||e.options.captureQueuedFrames||e.options.captureQueuedFrameFullSize||e.options.capturePresentationQueue?{onFilteredPicture:e.options.diagnostic?t=>{B||M({type:"diagnostic",meta:t})}:void 0,onPresentedFrame:e.options.capturePresentedFrames?(t,r)=>{if(B){t.close();return}try{M({type:"presented",frame:t,meta:r},[t])}catch{t.close()}}:void 0,onQueuedFrame:e.options.captureQueuedFrames||Y?(t,r)=>{if(B){t.close();return}if(Y){De(t,r,e.options.captureQueuedMeta);return}try{M({type:"queued",frame:t,meta:r},[t])}catch{t.close()}}:void 0,onPresentationQueue:e.options.capturePresentationQueue?t=>{B||M({type:"presentationQueue",meta:t})}:void 0}:void 0;F=we(C,e.canvas,{...e.options,diagnostic:{...i,bypassDisplayQueue:e.options.bypassDisplayQueue,captureQueuedFrameFullSize:e.options.captureQueuedFrameFullSize}},t=>{B||M({type:"failed",message:t})},t=>M({type:"visibility",visible:t}),t=>M({type:"presenterOwnsDisplay",owns:t}),Ce,_e),F.addEventListener("stats",t=>{const{dropped:r,...n}=t.detail;M({type:"stats",stats:n})}),F.scan=e.scan,F.videoTimeline=e.videoTimeline,F.enabled=e.enabled,M({type:"ready"});return}if(!C||!F)return;switch(e.type){case"frame":C.update(e.video);try{F.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),M({type:"consumed",id:e.id})}break;case"settings":Pe(F,e.options);break;case"scan":F.scan=e.scan;break;case"timeline":F.videoTimeline=e.videoTimeline;break;case"enabled":F.enabled=e.enabled;break;case"event":C.update(e.video),C.dispatchEvent(new Event(e.name));break;case"capture":C.videoWidth=e.width,C.videoHeight=e.height,F.capture().then(i=>M({type:"capture",id:e.id,image:i},[i])).catch(()=>M({type:"capture",id:e.id,image:null}));break;case"destroy":B=!0,F.destroy(),F=null,C=null,N.close();break}}catch(i){const t=i instanceof Error?i.message:String(i);M({type:"failed",message:t})}}})();
//# sourceMappingURL=worker-CJqn7zdi.js.map
