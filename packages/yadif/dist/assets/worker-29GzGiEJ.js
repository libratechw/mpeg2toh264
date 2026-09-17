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
`;class T{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#r;#t;#e;#i=0;#y=null;#o=[];#T=null;#U=1/0;#L=1/0;constructor(e,i){this.#r=e,this.#t=i,this.#e=255*T.DECIMATE_BLOCK**2*T.DUPLICATE_PERCENT/100}fieldMatch(e,i,t,r,n=T.COMBED_PIXEL_LIMIT){const s=r?1:0,a={p:e,c:i,n:t};let o=this.#I("c","p",s,a);const m=new Map,l=p=>{const E=m.get(p);if(E!==void 0)return E;const g=T.#N(this.weave(e,i,t,p,r),this.#r,this.#t);return m.set(p,g),g},d=l(o),c=l("n");(c*3<d||c*2<d&&d>n)&&Math.abs(c-d)>=30&&c<n&&(o="n");const h=l(o),f=h>=n;return f&&(o="c"),{match:o,combScore:h,isCombed:f,luma:this.weave(e,i,t,o,r)}}decimate(e){const i=this.#i,t=this.#T?T.#xe(this.#T,e,this.#r,this.#t):{maxBlockDifference:1/0,totalDifference:1/0};this.#o.push(t);const r=this.#y===i,n=r&&t.maxBlockDifference<this.#e;r&&!n&&(this.#y=null);const s=this.#y;this.#T=e.slice(),this.#i++;let a=this.#y;if(this.#i===T.CYCLE){let o=0,m=null;for(let l=1;l<this.#o.length;l++)(this.#o[l]?.maxBlockDifference??1/0)<(this.#o[o]?.maxBlockDifference??1/0)?(m=o,o=l):(m===null||(this.#o[l]?.maxBlockDifference??1/0)<(this.#o[m]?.maxBlockDifference??1/0))&&(m=l);this.#U=this.#o[o]?.maxBlockDifference??1/0,this.#L=m===null?1/0:this.#o[m]?.maxBlockDifference??1/0,a=(this.#o[o]?.maxBlockDifference??1/0)<this.#e?o:null,this.#y=a,this.#o=[],this.#i=0}return{cycleIndex:i,maxBlockDifference:t.maxBlockDifference,totalDifference:t.totalDifference,shouldDrop:n,dropIndex:s,nextDropIndex:a,lowestCycleDifference:this.#U,runnerUpCycleDifference:this.#L}}weave(e,i,t,r,n){if(r==="c")return i.slice();const s=i.slice(),a=r==="p"?e:t,o=s.length/this.#t,m=n?1:0;for(let l=m;l<this.#t;l+=2)s.set(a.subarray(l*o,(l+1)*o),l*o);return s}reset(){this.#i=0,this.#y=null,this.#o=[],this.#T=null,this.#U=1/0,this.#L=1/0}#I(e,i,t,r){const n=this.#r,s=this.#t,a=2-t,o=2-t,m=r[e],l=r[i],d=T.#Fe(m,l,n,s,t);let c=0,h=0,f=0,p=0,E=0,g=0;for(let L=2;L<s-2;L+=2){const R=(L-2)/2,ee=a-1+R*2,te=a+1+R*2,ie=a+3+R*2,$=a+R*2,Q=$+2,O=o+R*2,P=O+2,le=a+R*2;for(let w=8;w<n-8;w++){const I=(d[le*n+w]??0)|(d[(le+2)*n+w]??0);if(I===0)continue;const ce=(r.c[ee*n+w]??0)+((r.c[te*n+w]??0)<<2)+(r.c[ie*n+w]??0),W=Math.abs(3*((m[$*n+w]??0)+(m[Q*n+w]??0))-ce),G=Math.abs(3*((l[O*n+w]??0)+(l[P*n+w]??0))-ce);W>23&&(I&1)!==0&&(c+=W),G>23&&(I&1)!==0&&(p+=G),W>42&&(I&2)!==0&&(h+=W),G>42&&(I&2)!==0&&(E+=G),W>42&&(I&4)!==0&&(f+=W),G>42&&(I&4)!==0&&(g+=G)}}h<500&&E<500&&(f>=500||g>=500)&&Math.max(f,g)>3*Math.min(f,g)&&(h=f,E=g);const y=Math.floor(c/6+.5),_=Math.floor(p/6+.5),b=Math.floor(h/6+.5),v=Math.floor(E/6+.5),X=Math.max(y,_)/Math.max(Math.min(y,_),1),z=Math.max(b,v)/Math.max(Math.min(b,v),1),q=Math.max(b,v)/Math.max(Math.max(y,_),1);return(b>=500||v>=500)&&(b*2<v||v*2<b)||(b>=1e3||v>=1e3)&&(b*3<v*2||v*3<b*2)||(b>=2e3||v>=2e3)&&(b*5<v*4||v*5<b*4)||(b>=4e3||v>=4e3)&&z>X||q>.005&&Math.max(b,v)>150&&(b*2<v||v*2<b)?b>v?i:e:y>_?i:e}static#Fe(e,i,t,r,n){const s=Array.from({length:Math.ceil(r/2)},()=>new Uint8Array(t)),a=n===1?1:0;for(let l=0;l<s.length;l++){const d=Math.min(r-1,a+l*2),c=s[l];if(c)for(let h=0;h<t;h++)c[h]=Math.abs((e[d*t+h]??0)-(i[d*t+h]??0))}const o=new Uint8Array(t*r),m=n===1?3:2;for(let l=1;l<s.length-1;l++){const d=m+(l-1)*2;if(d>=r)break;const c=s[l];if(c)for(let h=1;h<t-1;h++){const f=c[h]??0;if(f<=3)continue;let p=0;for(let v=h-1;v<=h+1;v++)p+=(s[l-1]?.[v]??0)>3?1:0,p+=(s[l]?.[v]??0)>3?1:0,p+=(s[l+1]?.[v]??0)>3?1:0;if(p<=1)continue;const E=d*t+h;if(o[E]=1,f<=19)continue;p=0;let g=!1,y=!1;for(let v=h-1;v<=h+1;v++)(s[l-1]?.[v]??0)>19&&(p++,g=!0),(s[l]?.[v]??0)>19&&p++,(s[l+1]?.[v]??0)>19&&(p++,y=!0);if(p<=3)continue;if(g&&y){o[E]|=2;continue}let _=!1,b=!1;for(let v=Math.max(h-4,0);v<Math.min(h+5,t);v++)l!==1&&(s[l-2]?.[v]??0)>19&&(_=!0),(s[l-1]?.[v]??0)>19&&(g=!0),(s[l+1]?.[v]??0)>19&&(y=!0),l!==s.length-2&&(s[l+2]?.[v]??0)>19&&(b=!0);g&&(y||_)||y&&(g||b)?o[E]|=2:p>5&&(o[E]|=4)}}return o}static#N(e,i,t){const r=new Uint8Array(i*t);for(let s=0;s<t;s++){const a=s*i,o=Math.max(0,Math.min(t-1,s===0?1:s-1))*i,m=Math.max(0,Math.min(t-1,s===t-1?t-2:s+1))*i,l=Math.max(0,Math.min(t-1,s<2?s===0?2:3:s-2))*i,d=Math.max(0,Math.min(t-1,s+2>=t?s===t-1?t-3:t-4:s+2))*i;for(let c=0;c<i;c++){const h=e[a+c]??0,f=e[o+c]??0,p=e[m+c]??0,E=e[l+c]??0,g=e[d+c]??0;(s===0?Math.abs(h-p)>T.COMB_THRESHOLD:s===t-1?Math.abs(h-f)>T.COMB_THRESHOLD:Math.abs(h-f)>T.COMB_THRESHOLD&&Math.abs(h-p)>T.COMB_THRESHOLD)&&Math.abs(4*h-3*(f+p)+E+g)>T.COMB_THRESHOLD*6&&(r[s*i+c]=255)}}let n=0;for(const s of[0,8])for(const a of[0,8])for(let o=s;o<t;o+=16)for(let m=a;m<i;m+=16){let l=0;for(let d=Math.max(1,o);d<Math.min(t-1,o+16);d++)for(let c=m;c<Math.min(i,m+16);c++){const h=d*i+c;r[h-i]===255&&r[h]===255&&r[h+i]===255&&l++}n=Math.max(n,l)}return n}static#xe(e,i,t,r){const n=T.DECIMATE_BLOCK/2,s=Math.ceil(t/n),a=Math.ceil(r/n),o=new Float64Array(s*a),m=e.length/(t*r);for(let c=0;c<r;c++){const h=Math.floor(c/n);for(let f=0;f<t;f++){const p=Math.floor(f/n),E=h*s+p,g=(c*t+f)*m;if(m===1){o[E]=(o[E]??0)+Math.abs((e[g]??0)-(i[g]??0));continue}const y=Math.round((e[g]??0)*.2126+(e[g+1]??0)*.7152+(e[g+2]??0)*.0722),_=Math.round((i[g]??0)*.2126+(i[g+1]??0)*.7152+(i[g+2]??0)*.0722);if(o[E]=(o[E]??0)+Math.abs(y-_),(f&1)!==0||(c&1)!==0)continue;let b=0,v=0,X=0,z=0,q=0,L=0,R=0;for(let Q=c;Q<Math.min(c+2,r);Q++)for(let O=f;O<Math.min(f+2,t);O++){const P=(Q*t+O)*m;b+=e[P]??0,v+=e[P+1]??0,X+=e[P+2]??0,z+=i[P]??0,q+=i[P+1]??0,L+=i[P+2]??0,R++}const ee=Math.round((-.114572*b-.385428*v+.5*X)/R),te=Math.round((-.114572*z-.385428*q+.5*L)/R),ie=Math.round((.5*b-.454153*v-.045847*X)/R),$=Math.round((.5*z-.454153*q-.045847*L)/R);o[E]=(o[E]??0)+Math.abs(ee-te)+Math.abs(ie-$)}}let l=-1;for(let c=0;c<a-1;c++)for(let h=0;h<s-1;h++)l=Math.max(l,(o[c*s+h]??0)+(o[c*s+h+1]??0)+(o[(c+1)*s+h]??0)+(o[(c+1)*s+h+1]??0));let d=0;for(const c of o)d+=c;return{maxBlockDifference:l,totalDifference:d}}}let ve=null;const ge=.5,F=3,se=5,U=se+1,re=1e3,J=4,Z=200,Ee=.25,be=1e3/60,ye=.02,Te=250,Fe=1e3/30,D=160,S=90;function ne(u){if(!Number.isFinite(u)||u<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return u}const xe=`#version 300 es
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
`;function Re(u){return Math.max(0,Math.round(u*1e6))}class ke{#r;#t=!1;#e=0;#i=0;constructor(e,i=!1){this.#r=e,this.#t=i}get enabled(){return this.#r!==void 0||this.#t}get generation(){return this.#e}get frameId(){return this.#i}invalidate(){return this.#e+=1,this.#e}destroy(){this.#r=void 0,this.#t=!1}deliver(e){this.#r?.(e)}emit(e,i,t,r,n){const s=this.#r;if(!s&&!this.#t)return null;this.#i+=1;const a={source:e,mediaTimestampUs:i,generation:this.#e,frameId:this.#i,second:t,width:r,height:n};return s?.(a),a}}class Ae extends EventTarget{#r;#t;#e;#i;#y;#o;#T;#U;#L;#I=null;#Fe=null;#N=null;#xe=null;#ie=null;#ft=null;#B=null;#x=[];#F=[];#se=U-1;#m=null;#n=[];#O=null;#Me=0;#W=null;#re=be;#z=null;#Oe;#M;#v;#q;#We;#D="video";#ne="c";#Ge=0;#He=!0;#Xe=new T(k,A);#ze=1/0;#qe=1/0;#G=0;#a=0;#f=0;#p=0;#g=F-1;#c=0;#ae=0;#Re=Number.NaN;#he=!1;#Q=null;#ke=0;#Y=0;#Qe=0;#d=!1;#Ae=!1;#Se=!1;#u=null;#V=[];#R=!1;#Ye;#we;#j;#A;#oe;#le=0;#ce;#De;#Ve=!1;#C;#ue;#$;#fe=null;#K;#l;#Ce;#S;#je;#h=null;#s;#de=!1;#$e=0;#Ke=!1;#It=0;#me=!1;#_e=!1;#J=null;#Nt=0;#pe=new Map;#w={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0};#H=0;#Je=0;#Pe=0;#X=0;#ve=0;#ge=0;#Ee=0;#Z=0;constructor(e,i={},t=null){if(super(),this.#e=e,this.#M=i.doubleRate??!1,this.#v=i.autoFilm??!1,this.#q=ne(i.filmCombThreshold??T.COMBED_PIXEL_LIMIT),this.#We=i.spatialCheck??!0,this.#Ye=i.onStats,this.#we=i.diagnostic?.onFilteredPicture,this.#j=i.diagnostic?.onPresentedFrame,i.presenter!==void 0){if(i.diagnostic?.onQueuedFrame!==void 0||i.diagnostic?.onQueuedMeta!==void 0||i.queuedFrameSink!==void 0)throw new TypeError("presenter cannot be combined with diagnostic frame transport");if(typeof VideoFrame>"u")throw new TypeError("presenter requires VideoFrame")}if(this.#oe=i.presenter??null,this.#A=i.presenter?(s,a)=>i.presenter(s,{mediaTimestampUs:a.mediaTimestampUs,durationUs:a.durationUs}):i.diagnostic?.onQueuedFrame,this.#ce=i.diagnostic?.onQueuedMeta,this.#De=i.queuedFrameSink??null,this.#C=i.diagnostic?.onPresentationQueue,this.#ue=(this.#A!==void 0||this.#ce!==void 0)&&(i.presenter!==void 0||i.diagnostic?.bypassDisplayQueue===!0),this.#$=i.presenter!==void 0||i.diagnostic?.captureQueuedFrameFullSize===!0,this.#$&&this.#A===void 0&&this.#ce===void 0)throw new TypeError("captureQueuedFrameFullSize requires onQueuedFrame or onQueuedMeta");if(this.#$&&!this.#ue)throw new TypeError("captureQueuedFrameFullSize requires bypassDisplayQueue");this.#K=this.#we||this.#j||this.#A||this.#C?new ke(this.#we,this.#j!==void 0||this.#A!==void 0||this.#C!==void 0):null,this.#l=t,this.#S=t?"main":i.rendering??"auto",this.#je=i.workerUrl??ve,this.#s=this.#S==="main"?"main":"idle",this.#t=t?t.canvas:document.createElement("canvas"),this.#r=t?.canvas??(this.#S==="main"?this.#t:document.createElement("canvas")),this.#Ce=e,t||(this.#t.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const r=this.#r.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!r)throw new Error("this browser has no WebGL2");this.#i=r,this.#y=H(r,fe);const n=this.#y;this.#o=Object.fromEntries(Object.entries(ue).map(([s,a])=>[s,r.getUniformLocation(n,a)])),this.#T=H(r,Me),this.#U=r.getUniformLocation(this.#T,"uField"),this.#L=r.getUniformLocation(this.#T,"uFlip"),this.#Bt(),this.#v&&this.#Tt(),this.#r.addEventListener("webglcontextlost",this.#Lt),this.#Oe=t?null:new ResizeObserver(()=>this.#Be()),e.addEventListener("emptied",this.#_t),e.addEventListener("resize",this.#Ct),e.addEventListener("pause",this.#P),e.addEventListener("ended",this.#P),e.addEventListener("seeking",this.#Ut),e.addEventListener("seeked",this.#P),e.addEventListener("ratechange",this.#P)}get running(){return this.#d&&(this.#u?.interlaced??!0)}get renderPath(){return{rendering:this.#S,workerState:this.#s,externalHost:this.#l!==null,presenterFailures:this.#le}}get canvas(){return this.#t}get#Ue(){return this.#u?.topFieldFirst!==!1}#dt(){return{doubleRate:this.#M,autoFilm:this.#v,filmCombThreshold:this.#q,spatialCheck:this.#We,diagnostic:this.#we!==void 0,capturePresentedFrames:this.#j!==void 0,captureQueuedFrames:this.#A!==void 0,captureQueuedFrameFullSize:this.#$,capturePresentationQueue:this.#C!==void 0,bypassDisplayQueue:this.#ue,captureQueuedMeta:this.#ce!==void 0}}get enabled(){return this.#Ae}set enabled(e){this.#Ae=e,this.#it(),this.#h?.postMessage({type:"enabled",enabled:e})}set scan(e){const i=this.#u?.interlaced!==e?.interlaced,t=i||this.#u?.topFieldFirst!==e?.topFieldFirst;this.#u=e,this.#h?.postMessage({type:"scan",scan:e}),t&&(this.#c=0,this.#b(),this.#E(),i&&(this.#a=0),this.#m=null,this.#k(!1)),this.#it(),t&&((e?.interlaced??!0)&&(this.#l||this.#s==="main")?this.#ee():this.#at())}get scan(){return this.#u}set videoTimeline(e){this.#V=e,this.#h?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#u=null),this.#it()}get videoTimeline(){return this.#V}get container(){return this.#z??this.#e}get doubleRate(){return this.#M}set doubleRate(e){e!==this.#M&&(this.#M=e,this.#tt(),this.#n.length=0,this.#E(),e?(this.#f>0&&this.#ct(),(this.#u?.interlaced??!0)&&(this.#l||this.#s==="main")&&this.#ee()):this.#v||(this.#m=null,this.#k(!1),this.#te()))}get autoFilm(){return this.#v}set autoFilm(e){e!==this.#v&&(this.#v=e,this.#tt(),this.#b(),this.#E(),e?(this.#Tt(),this.#f>0&&(this.#Dt(),this.#ct()),(this.#u?.interlaced??!0)&&(this.#l||this.#s==="main")&&this.#ee()):(this.#lt(),this.#M||(this.#m=null,this.#k(!1),this.#te())))}get filmCombThreshold(){return this.#q}set filmCombThreshold(e){const i=ne(e);i!==this.#q&&(this.#q=i,this.#tt(),this.#v&&this.#b())}get diagnosticGeneration(){return this.#K?.generation??0}#mt(e,i,t){const r=this.#K;return!r||this.#s!=="main"||!Number.isFinite(i)?null:r.emit(e,Re(i),t,this.#f,this.#p)}#Ze(e,i){const t={timestamp:e};Number.isFinite(i)&&i>0&&(t.duration=Math.max(1,Math.round(i*1e3)));const r=this.#e.videoWidth,n=this.#e.videoHeight;return r>0&&n>0&&(t.displayWidth=r,t.displayHeight=n),t}#et(e,i){const t=this.#j;if(!t||!e||typeof VideoFrame>"u")return;const r=this.#Ze(e.mediaTimestampUs,i),n=r.duration??null;let s;try{s=new VideoFrame(this.#r,r)}catch{return}try{t(s,{...e,presentationTimeMs:performance.now(),durationUs:n})}catch{s.close()}}#pt(e,i=!1){const t=this.#i;t.bindFramebuffer(t.FRAMEBUFFER,null),t.useProgram(this.#T),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,e),t.uniform1i(this.#U,0),t.uniform1i(this.#L,i?1:0),t.viewport(0,0,this.#f,this.#p),t.drawArrays(t.TRIANGLES,0,3)}#vt(e,i,t){const r=this.#A;if(!r||!i||typeof VideoFrame>"u"){this.#oe&&(this.#le+=1);return}const n=performance.now();if(this.#$){try{this.#pt(e)}catch{this.#oe&&(this.#le+=1);return}const d=this.#Ze(i.mediaTimestampUs,t),c=d.duration??null;let h;try{h=new VideoFrame(this.#r,d)}catch{this.#oe&&(this.#le+=1);return}try{r(h,{...i,queuedAtMs:n,durationUs:c,captureWidth:this.#f,captureHeight:this.#p})}catch{this.#oe&&(this.#le+=1),h.close()}return}const s=this.#fe;if(!s)return;const a=this.#i;try{a.bindFramebuffer(a.FRAMEBUFFER,s.framebuffer),a.useProgram(this.#T),a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,e),a.uniform1i(this.#U,0),a.uniform1i(this.#L,0),a.viewport(0,0,D,S),a.drawArrays(a.TRIANGLES,0,3),a.readPixels(0,0,D,S,a.RGBA,a.UNSIGNED_BYTE,s.pixels);const d=D*4;for(let h=0;h<S;h++){const f=(S-1-h)*d;s.flipped.set(s.pixels.subarray(f,f+d),h*d)}const c=s.context.createImageData(D,S);c.data.set(s.flipped),s.context.putImageData(c,0,0)}catch{a.bindFramebuffer(a.FRAMEBUFFER,null),a.viewport(0,0,this.#f,this.#p);return}a.bindFramebuffer(a.FRAMEBUFFER,null),a.viewport(0,0,this.#f,this.#p);const o=this.#Ze(i.mediaTimestampUs,t),m=o.duration??null;let l;try{l=new VideoFrame(s.canvas,o)}catch{return}try{r(l,{...i,queuedAtMs:n,durationUs:m,captureWidth:D,captureHeight:S})}catch{l.close()}}#Bt(){if(!this.#A||this.#$||this.#fe)return;let e=null;if(typeof OffscreenCanvas<"u")e=new OffscreenCanvas(D,S);else if(typeof document<"u"){const a=document.createElement("canvas");a.width=D,a.height=S,e=a}if(!e)return;const i=e.getContext("2d",{willReadFrequently:!0});if(!i)return;const t=this.#i,r=t.createTexture();if(!r)return;t.bindTexture(t.TEXTURE_2D,r),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,D,S,0,t.RGBA,t.UNSIGNED_BYTE,null);const n=t.createFramebuffer();if(!n){t.deleteTexture(r);return}t.bindFramebuffer(t.FRAMEBUFFER,n),t.framebufferTexture2D(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0,t.TEXTURE_2D,r,0);const s=t.checkFramebufferStatus(t.FRAMEBUFFER)===t.FRAMEBUFFER_COMPLETE;if(t.bindFramebuffer(t.FRAMEBUFFER,null),!s){t.deleteFramebuffer(n),t.deleteTexture(r);return}this.#fe={texture:r,framebuffer:n,canvas:e,context:i,pixels:new Uint8Array(D*S*4),flipped:new Uint8ClampedArray(D*S*4)}}#Ot(){const e=this.#fe;e&&(this.#i.deleteFramebuffer(e.framebuffer),this.#i.deleteTexture(e.texture),this.#fe=null)}#E(){this.#K?.invalidate()}#tt(){this.#h?.postMessage({type:"settings",options:this.#dt()})}#it(){this.#Ae&&(this.#V.length>0||(this.#u?.interlaced??!0))?this.start():this.stop()}#Wt(){return this.#l||this.#S==="main"?!1:this.#s==="starting"||this.#s==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#je!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#gt(),!0):this.#S==="auto"?(this.#Le(),!1):(this.#s="failed",this.#d=!1,!0)}#gt(){this.#_(),this.#h?.terminate(),this.#h=null,this.#me=!1,this.#_e=!1;let e=this.#t;if(this.#Ke){e=document.createElement("canvas"),e.className=this.#t.className;const s=this.#t.getAttribute("style");s===null?e.removeAttribute("style"):e.setAttribute("style",s),e.style.visibility="hidden",this.#t.parentElement&&this.#t.replaceWith(e),this.#t=e}const i=++this.#$e;this.#E(),this.#s="starting";let t,r;try{r=e.transferControlToOffscreen(),this.#Ke=!0,t=new Worker(this.#je,{type:"module"})}catch(s){this.#be(s instanceof Error?s.message:String(s));return}this.#h=t,t.onmessage=s=>{i===this.#$e&&!this.#Se?this.#Gt(s.data):(s.data.type==="presented"||s.data.type==="queued")&&s.data.frame.close()},t.onerror=s=>{i===this.#$e&&(s.preventDefault(),this.#be(s.message||"the deinterlacer worker failed"))};const n=[r];this.#De&&!this.#Ve&&(n.push(this.#De),this.#Ve=!0),t.postMessage({type:"initialize",canvas:r,options:this.#dt(),queuedFrameSink:this.#Ve?this.#De:null,scan:this.#u,videoTimeline:this.#V,enabled:this.#d,video:this.#st()},n)}#Gt(e){switch(e.type){case"ready":this.#s="active",this.#d&&(this.#ye(),this.#ht());break;case"failed":this.#be(e.message);break;case"consumed":{this.#me=!1,this.#_e=!0;const i=this.#J;this.#J=null,i&&this.#bt(i);break}case"visibility":this.#t.style.visibility=e.visible?"visible":"hidden";break;case"diagnostic":{if(this.#s!=="active")break;this.#K?.deliver(e.meta);break}case"queuedMeta":{if(this.#s!=="active")break;try{this.#ce?.(e.meta)}catch{}break}case"presented":{if(this.#s!=="active"){e.frame.close();break}const i=this.#j;if(!i){e.frame.close();break}try{i(e.frame,e.meta)}catch{e.frame.close()}break}case"queued":{if(this.#s!=="active"){e.frame.close();break}const i=this.#A;if(!i){e.frame.close();break}try{i(e.frame,e.meta)}catch{e.frame.close()}break}case"presentationQueue":this.#s==="active"&&this.#C?.(e.meta);break;case"stats":{const i={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0};this.dispatchEvent(new CustomEvent("stats",{detail:i})),this.#Ye?.(i);break}case"capture":{const i=this.#pe.get(e.id);if(this.#pe.delete(e.id),!i){e.image?.close();break}e.image?i.resolve(e.image):createImageBitmap(this.#e).then(i.resolve,i.reject);break}}}#be(e){if(this.#s==="starting"&&this.#S==="auto"&&!this.#de){this.#Le();return}if(this.#Et(e),!this.#de){this.#de=!0,this.#gt();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#s="failed",this.#h?.terminate(),this.#h=null,this.#_(),this.stop()}#Le(){const e=this.#r;e.className=this.#t.className;const i=this.#t.getAttribute("style");i===null?e.removeAttribute("style"):e.setAttribute("style",i),e.style.visibility="hidden",this.#t.parentElement&&this.#t.replaceWith(e),this.#t=e,this.#Ke=!1,this.#h?.terminate(),this.#h=null,this.#s="main",this.#E(),this.#_(),this.#d&&(this.#ye(),this.#ht(),(this.#u?.interlaced??!0)&&this.#ee())}#_(){this.#J?.frame.close(),this.#J=null}#Et(e){for(const i of this.#pe.values())i.reject(new Error(e));this.#pe.clear()}start(){if(!(this.#d||this.#Se||this.#R)){if(this.#d=!0,this.#Pt(),this.#b(),this.#ke=performance.now(),this.#Qe=this.#ke,this.#Re=Number.NaN,this.#Y=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#ti(),this.#ht(),this.#Wt()){this.#h?.postMessage({type:"enabled",enabled:!0}),this.#s==="active"&&this.#ye();return}this.#ye(),(this.#u?.interlaced??!0)&&this.#ee()}}stop(){this.#d&&(this.#d=!1,this.#Q!==null&&this.#e.cancelVideoFrameCallback(this.#Q),this.#Q=null,this.#jt(),this.#at(),this.#c=0,this.#m=null,this.#k(!1),this.#E(),this.#_(),this.#h?.postMessage({type:"enabled",enabled:!1}))}destroy(){if(!this.#Se){this.#Se=!0,this.#Ae=!1,this.stop(),this.#h?.postMessage({type:"destroy"}),this.#h?.terminate(),this.#h=null,this.#E(),this.#K?.destroy(),this.#_(),this.#Et("the deinterlacer was destroyed"),this.#r.removeEventListener("webglcontextlost",this.#Lt),this.#e.removeEventListener("emptied",this.#_t),this.#e.removeEventListener("resize",this.#Ct),this.#e.removeEventListener("pause",this.#P),this.#e.removeEventListener("ended",this.#P),this.#e.removeEventListener("seeking",this.#Ut),this.#e.removeEventListener("seeked",this.#P),this.#e.removeEventListener("ratechange",this.#P),this.#ii();for(const e of this.#x)this.#i.deleteTexture(e);this.#x=[],this.#Ot(),this.#te(),this.#lt(),this.#i.deleteProgram(this.#y),this.#i.deleteProgram(this.#T),this.#I&&this.#i.deleteProgram(this.#I),this.#N&&this.#i.deleteProgram(this.#N),this.#ie&&this.#i.deleteProgram(this.#ie),this.#i.getExtension("WEBGL_lose_context")?.loseContext()}}capture(){if(this.#s==="active"&&this.#t.style.visibility==="visible"&&this.#h){const r=++this.#Nt,n=new Promise((s,a)=>{this.#pe.set(r,{resolve:s,reject:a})});return this.#h.postMessage({type:"capture",id:r,width:this.#e.videoWidth,height:this.#e.videoHeight}),n}if(this.#s==="starting"||this.#s==="failed")return createImageBitmap(this.#e);const e=this.#m;if(this.#l&&(!this.#d||this.#R||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#d||this.#R||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#ot(e.texture,e.flip,!1):e.kind==="yadif"?this.#Te(e.flush,e.second,null,!1):this.#rt(null,!1);const i=this.#e.videoWidth,t=this.#e.videoHeight;return i>0&&t>0&&(i!==this.#r.width||t!==this.#r.height)?createImageBitmap(this.#r,{resizeWidth:i,resizeHeight:t,resizeQuality:"high"}):createImageBitmap(this.#r)}addEventListener(e,i,t){super.addEventListener(e,i,t)}removeEventListener(e,i,t){super.removeEventListener(e,i,t)}#ye(){this.#l||!this.#d||this.#Q!==null||(this.#Q=this.#e.requestVideoFrameCallback(this.#Xt))}#st(){const e=[];for(let i=0;i<this.#e.buffered.length;i++)e.push({start:this.#e.buffered.start(i),end:this.#e.buffered.end(i)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#Ht(e,i){let t;try{t=new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(i.mediaTime*1e6))})}catch(n){const s=n instanceof Error?n.message:String(n);this.#S==="auto"&&!this.#_e&&!this.#de?(this.#Le(),this.#Ie(e,i)):this.#be(s);return}const r={id:++this.#It,frame:t,now:e,metadata:i,video:this.#st()};if(this.#me){this.#J?.frame.close(),this.#J=r;return}this.#bt(r)}#bt(e){const i=this.#h;if(!i||this.#s!=="active"){e.frame.close();return}this.#me=!0;const t={type:"frame",...e};try{i.postMessage(t,[e.frame])}catch(r){this.#me=!1,e.frame.close();const n=r instanceof Error?r.message:String(r);this.#S==="auto"&&!this.#_e&&!this.#de?(this.#Le(),this.#Ie(e.now,e.metadata)):this.#be(n)}}#Xt=(e,i)=>{this.#Q=null,!(!this.#d||this.#R)&&(this.#ke=e,this.#Y=Math.max(this.#Y,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0),this.#yt(e,i),this.#ye())};#yt(e,i){if(this.#Re=i.mediaTime,this.#s==="active"){this.#Ht(e,i);return}this.#s!=="starting"&&this.#Ie(e,i)}ingestExternalFrame(e,i,t){this.#Ce=t;try{this.#Ie(e,i)}finally{this.#Ce=this.#e}}#Ie(e,i){if(this.#zt(i.mediaTime),i.width>0&&i.height>0){let t=!1;if(!this.#he&&this.#e.seeking){const h=this.#e.buffered,f=this.#a>=J?this.#a/1e3:Z/1e3;for(let p=0;p<h.length;p++)if(i.mediaTime>=h.start(p)&&i.mediaTime<h.end(p)&&Math.abs(i.mediaTime-this.#e.currentTime)<=f){t=!0;break}}if(t&&(this.#he=!0),(this.#f===0||this.#p===0)&&this.#wt(i.width,i.height),this.#u&&!this.#u.interlaced){this.#Jt();return}const r=i.mediaTime-this.#ae,n=t||r<0||r>ge;n&&(this.#c=0,this.#a=0,this.#w.discontinuities++,this.#E(),this.#n.length=0,this.#b());const s=this.#v&&this.#H!==0&&i.presentedFrames-this.#H>1;if(this.#Zt(i.presentedFrames,n),!n&&s&&(this.#c=0,this.#b()),this.#c>0&&i.mediaTime===this.#ae)return;!n&&r>0&&this.#qt(r),this.#ae=i.mediaTime;const a=performance.now();a-this.#Je>re&&(this.#Pe=a,this.#X=0,this.#ve=0,this.#ge=0,this.#Ee=0,this.#Z=0,this.#G=0),this.#Je=a;const o=performance.now();this.#St();const m=this.#D,l=this.#v&&this.#c===F&&this.#Qt();if(m!==this.#D&&(this.#n.length=0),!(l&&this.#Ne()))if(this.#v&&!this.#He&&this.#D==="film")if(this.#Ne()){const h=this.#a*5/4;this.#xt(1);const f=this.#n.at(-1),p=f==null?e+h:f.at+f.duration;this.#Yt(p,h,i.mediaTime)}else this.#rt(null,!0,i.mediaTime);else if(this.#M&&this.#Ne()){const h=this.#a/2;this.#xt(2);const f=this.#n.at(-1),p=f==null?e+h*2:f.at+f.duration;this.#Ft(!1,p,h,i.mediaTime),this.#Ft(!0,p+h,h,i.mediaTime+h/1e3)}else this.#w.late+=this.#n.length,this.#n.length=0,this.#Te(!1,!1,null,!0,i.mediaTime);this.#Z=Math.max(this.#Z,this.#n.length),this.#ve+=performance.now()-o,this.#X++,this.#ei(a)}}#zt(e){let i;for(let n=this.#V.length-1;n>=0;n--){const s=this.#V[n];if(s.start<=e+1e-6){i=s;break}}i?.codedSize&&(i.codedSize.width!==this.#f||i.codedSize.height!==this.#p)&&this.#wt(i.codedSize.width,i.codedSize.height);const t=i?.scan;if(!t||this.#u?.interlaced===t.interlaced&&this.#u.topFieldFirst===t.topFieldFirst)return;const r=this.#u?.interlaced;this.#u=t,this.#c=0,this.#n.length=0,this.#b(),this.#E(),r!==t.interlaced&&(this.#a=0),t.interlaced&&(this.#l||this.#s==="main")?this.#ee():this.#at()}#Ne(){return(this.#M||this.#v)&&this.#a>0&&this.#F.length===U}#qt(e){const i=e*1e3/(this.#e.playbackRate||1),t=this.#a>0?Math.max(1,Math.round(i/this.#a)):1,r=i/t;r<J||r>Z||(this.#a=this.#a>0?this.#a+(r-this.#a)*Ee:r)}#Tt(){if(this.#I&&this.#N&&this.#ie)return;const e=this.#i,i=H(e,de),t=H(e,me),r=H(e,pe);this.#I=i,this.#Fe=Object.fromEntries(Object.entries(K).filter(([n])=>n!=="match"&&n!=="topFieldFirst").map(([n,s])=>[n,e.getUniformLocation(i,s)])),this.#N=t,this.#xe=Object.fromEntries(Object.entries(K).map(([n,s])=>[n,e.getUniformLocation(t,s)])),this.#ie=r,this.#ft=Object.fromEntries(Object.entries(K).map(([n,s])=>[n,e.getUniformLocation(r,s)]))}#Qt(){const e=this.#B,i=this.#I,t=this.#Fe,r=this.#ie,n=this.#ft;if(!e||!i||!t||!r||!n)return!1;const s=this.#i,a=this.#g,o=(this.#g+F-1)%F,m=(this.#g+1)%F,l=this.#Ue;s.bindFramebuffer(s.FRAMEBUFFER,e.framebuffer),s.useProgram(i);for(const[g,y]of[m,o,a].entries())s.activeTexture(s.TEXTURE0+g),s.bindTexture(s.TEXTURE_2D,this.#x[y]??null);s.uniform1i(t.prev,0),s.uniform1i(t.cur,1),s.uniform1i(t.next,2),s.uniform2i(t.size,this.#f,this.#p),s.viewport(0,0,k,A),s.drawArrays(s.TRIANGLES,0,3),s.readPixels(0,0,k,A,s.RGBA,s.UNSIGNED_BYTE,e.pixels);const{previousLuma:d,currentLuma:c,nextLuma:h}=e;for(let g=0;g<d.length;g++){const y=g*4;d[g]=e.pixels[y]??0,c[g]=e.pixels[y+1]??0,h[g]=e.pixels[y+2]??0}const f=this.#Xe.fieldMatch(d,c,h,l,this.#q);s.useProgram(r),s.uniform1i(n.prev,0),s.uniform1i(n.cur,1),s.uniform1i(n.next,2),s.uniform2i(n.size,this.#f,this.#p),s.uniform1i(n.topFieldFirst,l?1:0),s.uniform1i(n.match,f.match==="p"?0:f.match==="c"?1:2),s.drawArrays(s.TRIANGLES,0,3),s.readPixels(0,0,k,A,s.RGBA,s.UNSIGNED_BYTE,e.pixels);const p=this.#Xe.decimate(e.pixels);this.#ne=f.match,this.#Ge=f.combScore,this.#He=f.isCombed,this.#ze=p.lowestCycleDifference,this.#qe=p.runnerUpCycleDifference;const E=p.dropIndex!==null&&!f.isCombed;return(E?"film":"video")!==this.#D&&(this.#D=E?"film":"video"),p.shouldDrop&&!f.isCombed}#Yt(e,i,t){const r=this.#nt();if(r===null)return;const n=this.#F[r];if(!n)return;this.#se=r;const s=this.#rt(n.framebuffer,!0,t);this.#vt(n.texture,s,i),this.#ue||this.#n.push({slot:r,at:e,enqueuedAtMs:this.#C?performance.now():null,duration:i,diagnosticMeta:s})}#rt(e,i=!0,t=Number.NaN){const r=this.#N,n=this.#xe;if(!r||!n)return null;const s=this.#i,a=this.#g,o=(this.#g+F-1)%F,m=(this.#g+1)%F,l=this.#Ue;s.bindFramebuffer(s.FRAMEBUFFER,e),s.useProgram(r);for(const[c,h]of[m,o,a].entries())s.activeTexture(s.TEXTURE0+c),s.bindTexture(s.TEXTURE_2D,this.#x[h]??null);s.uniform1i(n.prev,0),s.uniform1i(n.cur,1),s.uniform1i(n.next,2),s.uniform2i(n.size,this.#f,this.#p),s.uniform1i(n.topFieldFirst,l?1:0),s.uniform1i(n.match,this.#ne==="p"?0:this.#ne==="c"?1:2),s.viewport(0,0,this.#f,this.#p),s.drawArrays(s.TRIANGLES,0,3);const d=i?this.#mt("film",t,!1):null;return e===null&&(this.#m={kind:"film"},this.#k(!0),i&&(this.#G++,this.#et(d,this.#a))),d}#Ft(e,i,t,r){const n=this.#nt();if(n===null)return;const s=this.#F[n];if(!s)return;this.#se=n;const a=this.#Te(!1,e,s.framebuffer,!0,r);this.#vt(s.texture,a,t),this.#ue||this.#n.push({slot:n,at:i,enqueuedAtMs:this.#C?performance.now():null,duration:t,diagnosticMeta:a})}#xt(e){const i=Math.max(0,this.#n.length+e-se);let t=0,r=0;for(;r<i;){const n=this.#n.shift();if(!n)break;t+=n.duration,r++}for(const n of this.#n)n.at-=t;this.#w.late+=r}#nt(){const e=this.#m?.kind==="texture"?this.#m.texture:null,i=new Set(this.#n.map(({slot:t})=>t));for(let t=1;t<=U;t++){const r=(this.#se+t)%U,n=this.#F[r];if(n&&n.texture!==e&&!i.has(r))return r}return null}#ee(){this.#O===null&&(!this.#d||this.#R||(this.#Me=0,this.#O=this.#Rt(this.#Mt)))}#at(){this.#O!==null&&this.#Vt(this.#O),this.#O=null,this.#n.length=0}#Mt=e=>{if(this.#O=null,!(!this.#d||this.#R)){if(this.#Me>0){const i=e-this.#Me;i>=1&&i<=Z&&(this.#re=i<this.#re?i:this.#re+(i-this.#re)*ye)}this.#Me=e,this.#s==="main"&&this.#Kt(e),this.#O=this.#Rt(this.#Mt)}};#Rt(e){return this.#l?this.#l.requestAnimationFrame(e):requestAnimationFrame(e)}#Vt(e){this.#l?this.#l.cancelAnimationFrame(e):cancelAnimationFrame(e)}#ht(){this.#l||this.#W!==null||!this.#d||this.#R||(this.#W=requestAnimationFrame(this.#kt))}#jt(){this.#W!==null&&cancelAnimationFrame(this.#W),this.#W=null}#kt=e=>{this.#W=null,!(!this.#d||this.#R)&&(this.#$t(e),this.#W=requestAnimationFrame(this.#kt))};#$t(e){if(this.#l||e-this.#ke<Te||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const i=this.#e.currentTime,t=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,r=this.#a>=J?this.#a:Fe,n=t>this.#Y,s=i!==this.#Re&&e-this.#Qe>=r*.75;!n&&!s||(this.#Y=Math.max(this.#Y,t),this.#Qe=e,this.#yt(e,{mediaTime:i,presentedFrames:Math.max(this.#H+1,t),width:this.#e.videoWidth,height:this.#e.videoHeight}))}#Kt(e){const i=e+this.#re*1.5,t=this.#n.length;let r=0;const n=[];for(;this.#n[1]&&this.#n[1].at<=i;){this.#w.late++;const o=this.#n.shift();o&&n.push({frameId:o.diagnosticMeta?.frameId??null,generation:o.diagnosticMeta?.generation??null,mediaTimestampUs:o.diagnosticMeta?.mediaTimestampUs??null,plannedAtMs:o.at,enqueuedAtMs:o.enqueuedAtMs,reason:"deadline"}),r++}let s=this.#n[0];if(this.#C?.({atMs:e,deadlineMs:i,queueLengthBefore:t,retired:r,queueLengthAfter:this.#n.length,selectedFrameId:s?.diagnosticMeta?.frameId??null,selectedAtMs:s?.at??null,selectedEnqueuedAtMs:s?.enqueuedAtMs??null,retiredFields:n}),!s||s.at>i)return;this.#n.shift();const a=performance.now();this.#At(s.slot,s.diagnosticMeta,s.duration),this.#Ee+=performance.now()-a,this.#ge++}#At(e,i=null,t=0){const r=this.#F[e];r&&this.#ot(r.texture,!1,!0,i,t)}#Jt(){this.#St();const e=this.#x[this.#g];e&&this.#ot(e,!0),this.#c=0}#k(e){if(this.#l){this.#l.onVisibility(e);return}this.#t.style.visibility=e?"visible":"hidden"}#ot(e,i=!1,t=!0,r=null,n=0){this.#pt(e,i),this.#m={kind:"texture",texture:e,flip:i},this.#k(!0),t&&(this.#G++,this.#et(r,n))}#Zt(e,i){this.#H!==0&&!i&&(this.#w.missed+=Math.max(0,e-this.#H-1)),this.#H=e}#ei(e){const i=e-this.#Pe;if(i<re)return;const t=this.#Ne()&&(this.#M||this.#D==="film")?this.#ge:this.#X,r={...this.#w,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:t*1e3/i,frameMs:this.#X===0?0:(this.#ve+this.#Ee)/this.#X,maxQueuedFields:this.#Z,mode:this.#D,match:this.#ne,combScore:this.#Ge,outputFps:this.#G*1e3/i,duplicateScore:this.#ze,duplicateRunnerUp:this.#qe};this.dispatchEvent(new CustomEvent("stats",{detail:r})),this.#Ye?.(r),this.#Pe=e,this.#X=0,this.#ve=0,this.#ge=0,this.#Ee=0,this.#Z=0,this.#G=0}#St(){const e=this.#i;this.#g=(this.#g+1)%F,e.bindTexture(e.TEXTURE_2D,this.#x[this.#g]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#Ce),this.#c=Math.min(this.#c+1,F)}#Te(e,i,t,r=!0,n=Number.NaN){if(this.#c===0||this.#R)return null;let s=null;r&&(this.#c===F&&!e?this.#w.filtered++:this.#w.degraded++,s=this.#mt(e?"yadif-flush":i?"yadif-second":"yadif-first",n,i));const a=this.#i,o=this.#g,m=(this.#g+F-1)%F,l=(this.#g+1)%F;let d,c,h;this.#c===1?d=c=h=o:e?(d=m,c=h=o):this.#c===2?(d=c=m,h=o):(d=l,c=m,h=o),a.bindFramebuffer(a.FRAMEBUFFER,t),a.useProgram(this.#y);for(const[p,E]of[d,c,h].entries())a.activeTexture(a.TEXTURE0+p),a.bindTexture(a.TEXTURE_2D,this.#x[E]??null);a.uniform1i(this.#o.prev,0),a.uniform1i(this.#o.cur,1),a.uniform1i(this.#o.next,2),a.uniform2i(this.#o.size,this.#f,this.#p);const f=this.#Ue?0:1;return a.uniform1i(this.#o.parity,i?1-f:f),a.uniform1i(this.#o.tff,this.#Ue?1:0),a.uniform1i(this.#o.spatialCheck,this.#We?1:0),a.viewport(0,0,this.#f,this.#p),a.drawArrays(a.TRIANGLES,0,3),t===null&&(this.#m={kind:"yadif",flush:e,second:i},this.#k(!0),r&&(this.#G++,this.#et(s,this.#a))),s}#Be(){if(!this.#z)return;const e=this.#e,i=e.videoWidth,t=e.videoHeight;if(i===0||t===0)return;const r=Math.min(e.offsetWidth/i,e.offsetHeight/t),n=i*r,s=t*r;this.#t.style.left=`${e.offsetLeft+(e.offsetWidth-n)/2}px`,this.#t.style.top=`${e.offsetTop+(e.offsetHeight-s)/2}px`,this.#t.style.width=`${n}px`,this.#t.style.height=`${s}px`}#wt(e,i){const t=this.#i;this.#r.width=e,this.#r.height=i,this.#f=e,this.#p=i,this.#c=0,this.#m=null,this.#b(),this.#E(),this.#Be();for(const r of this.#x)t.deleteTexture(r);this.#x=[];for(let r=0;r<F;r++){const n=t.createTexture();t.bindTexture(t.TEXTURE_2D,n),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,e,i,0,t.RGBA,t.UNSIGNED_BYTE,null),this.#x.push(n)}this.#te(),this.#lt(),this.#v&&this.#Dt(),(this.#M||this.#v)&&this.#ct()}#Dt(){if(this.#B)return;const e=this.#i,i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,k,A,0,e.RGBA,e.UNSIGNED_BYTE,null);const t=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,t),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(t),e.deleteTexture(i);return}this.#B={texture:i,framebuffer:t,pixels:new Uint8Array(k*A*4),previousLuma:new Uint8Array(k*A),currentLuma:new Uint8Array(k*A),nextLuma:new Uint8Array(k*A)}}#lt(){this.#B&&(this.#i.deleteFramebuffer(this.#B.framebuffer),this.#i.deleteTexture(this.#B.texture),this.#B=null)}#ct(){const e=this.#i;if(!(this.#F.length===U||this.#f===0)){this.#te();for(let i=0;i<U;i++){const t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#f,this.#p,0,e.RGBA,e.UNSIGNED_BYTE,null);const r=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,r),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const n=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!n){e.deleteFramebuffer(r),e.deleteTexture(t),this.#te();return}this.#F.push({texture:t,framebuffer:r})}this.#se=U-1}}#te(){const e=this.#i,i=this.#m?.kind==="texture"?this.#m.texture:null;this.#F.some(t=>t.texture===i)&&(this.#m=null);for(const{texture:t,framebuffer:r}of this.#F)e.deleteFramebuffer(r),e.deleteTexture(t);this.#F=[],this.#n.length=0}#ti(){if(this.#z)return;const e=this.#e.parentElement;if(!e)return;const i=document.createElement("div");i.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(i,this.#e),i.appendChild(this.#e),i.appendChild(this.#t),this.#z=i,this.#Oe?.observe(this.#e),this.#Be()}#ii(){if(this.#l)return;const e=this.#z;this.#z=null,this.#Oe?.disconnect(),this.#t.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#Ct=()=>this.#Be();#ut(e){return!this.#h||this.#s==="main"?!1:(this.#h.postMessage({type:"event",name:e,video:this.#st()}),!0)}#_t=()=>{if(this.#E(),this.#Re=Number.NaN,this.#ut("emptied")){this.#_(),this.#k(!1);return}this.#c=0,this.#ae=0,this.#n.length=0,this.#a=0,this.#Pt(),this.#b(),this.#m=null,this.#k(!1)};#Pt(){this.#w={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0},this.#H=0,this.#Pe=0,this.#Je=0,this.#X=0,this.#ve=0,this.#ge=0,this.#Ee=0,this.#Z=0,this.#G=0,this.#b()}#b(){this.#n.length=0,this.#D="video",this.#ne="c",this.#Ge=0,this.#He=!0,this.#Xe.reset(),this.#ze=1/0,this.#qe=1/0}#Ut=()=>{if(this.#E(),this.#ut("seeking")){this.#_();return}this.#he=!1};#P=e=>{if(this.#E(),(e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#ut(e.type)){this.#_();return}if(e.type==="seeked"){const t=this.#he;if(this.#he=!1,t)return;this.#c=0,this.#b(),this.#m=null,this.#k(!1);return}const i=e.type==="ratechange";if(i&&(this.#a=0,this.#ae=this.#e.currentTime),this.#n.length=0,this.#d&&this.#c>0){const t=this.#nt(),r=t===null?void 0:this.#F[t];if(t!==null&&r){this.#se=t;const n=this.#Te(!0,!1,r.framebuffer,!0,this.#e.currentTime);this.#At(t,n,this.#a)}else this.#Te(!0,!1,null,!0,this.#e.currentTime)}i&&(this.#c=0,this.#b())};#Lt=e=>{if(e.preventDefault(),this.#l){this.#l.onFailure("the deinterlacer WebGL context was lost");return}this.#s!=="active"&&(this.#R=!0,this.stop())}}function Se(u,e,i,t,r,n,s){return new Ae(u,i,{canvas:e,onFailure:t,onVisibility:r,requestAnimationFrame:n,cancelAnimationFrame:s})}function H(u,e){const i=u.createProgram(),t=ae(u,u.VERTEX_SHADER,xe),r=ae(u,u.FRAGMENT_SHADER,e);if(u.attachShader(i,t),u.attachShader(i,r),u.linkProgram(i),u.deleteShader(t),u.deleteShader(r),!u.getProgramParameter(i,u.LINK_STATUS)){const n=u.getProgramInfoLog(i);throw u.deleteProgram(i),new Error(`the deinterlacer failed to link: ${n??"no reason given"}`)}return i}function ae(u,e,i){const t=u.createShader(e);if(!t)throw new Error("the deinterlacer could not create a shader");if(u.shaderSource(t,i),u.compileShader(t),!u.getShaderParameter(t,u.COMPILE_STATUS)){const r=u.getShaderInfoLog(t);throw u.deleteShader(t),new Error(`the deinterlacer failed to compile: ${r??"no reason given"}`)}return t}const N=self;class we extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#r=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#r=e.buffered}get buffered(){return{length:this.#r.length,start:e=>{const i=this.#r[e];if(!i)throw new DOMException("Invalid range index","IndexSizeError");return i.start},end:e=>{const i=this.#r[e];if(!i)throw new DOMException("Invalid range index","IndexSizeError");return i.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let C=null,x=null,B=!1,Y=null,he=Promise.resolve(),V=null,j=null,oe=null;function De(u,e,i){he=he.then(async()=>{const t=Y;if(!t){u.close();return}const r=Number.isFinite(u.timestamp)?Number(u.timestamp):Number(e.mediaTimestampUs);oe!==e.generation&&(oe=e.generation,V=null,j=null),(V===null||j===null)&&(V=performance.now(),j=r);const n=V+(r-j)/1e3,s=Math.max(0,n-performance.now());s>0&&await new Promise(a=>setTimeout(a,s));try{await t.write(u)}catch{try{u.close()}catch{}}i&&M({type:"queuedMeta",meta:e})}).catch(()=>{})}function Ce(u){return N.requestAnimationFrame(u)}function _e(u){N.cancelAnimationFrame(u)}function M(u,e=[]){N.postMessage(u,e)}function Pe(u,e){u.doubleRate=e.doubleRate,u.autoFilm=e.autoFilm,u.filmCombThreshold=e.filmCombThreshold}N.onmessage=u=>{const e=u.data;try{if(e.type==="initialize"){if(typeof N.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");Y=e.queuedFrameSink?e.queuedFrameSink.getWriter():null,C=new we,C.update(e.video);const i=e.options.diagnostic||e.options.capturePresentedFrames||e.options.captureQueuedFrames||e.options.captureQueuedFrameFullSize||e.options.capturePresentationQueue?{onFilteredPicture:e.options.diagnostic?t=>{B||M({type:"diagnostic",meta:t})}:void 0,onPresentedFrame:e.options.capturePresentedFrames?(t,r)=>{if(B){t.close();return}try{M({type:"presented",frame:t,meta:r},[t])}catch{t.close()}}:void 0,onQueuedFrame:e.options.captureQueuedFrames||Y?(t,r)=>{if(B){t.close();return}if(Y){De(t,r,e.options.captureQueuedMeta);return}try{M({type:"queued",frame:t,meta:r},[t])}catch{t.close()}}:void 0,onPresentationQueue:e.options.capturePresentationQueue?t=>{B||M({type:"presentationQueue",meta:t})}:void 0}:void 0;x=Se(C,e.canvas,{...e.options,diagnostic:{...i,bypassDisplayQueue:e.options.bypassDisplayQueue,captureQueuedFrameFullSize:e.options.captureQueuedFrameFullSize}},t=>{B||M({type:"failed",message:t})},t=>M({type:"visibility",visible:t}),Ce,_e),x.addEventListener("stats",t=>{const{dropped:r,...n}=t.detail;M({type:"stats",stats:n})}),x.scan=e.scan,x.videoTimeline=e.videoTimeline,x.enabled=e.enabled,M({type:"ready"});return}if(!C||!x)return;switch(e.type){case"frame":C.update(e.video);try{x.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),M({type:"consumed",id:e.id})}break;case"settings":Pe(x,e.options);break;case"scan":x.scan=e.scan;break;case"timeline":x.videoTimeline=e.videoTimeline;break;case"enabled":x.enabled=e.enabled;break;case"event":C.update(e.video),C.dispatchEvent(new Event(e.name));break;case"capture":C.videoWidth=e.width,C.videoHeight=e.height,x.capture().then(i=>M({type:"capture",id:e.id,image:i},[i])).catch(()=>M({type:"capture",id:e.id,image:null}));break;case"destroy":B=!0,x.destroy(),x=null,C=null,N.close();break}}catch(i){const t=i instanceof Error?i.message:String(i);M({type:"failed",message:t})}}})();
//# sourceMappingURL=worker-29GzGiEJ.js.map
