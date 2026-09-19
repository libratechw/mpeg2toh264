(function(){"use strict";const he={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",parity:"uParity",tff:"uTff",spatialCheck:"uSpatialCheck"},ae=`#version 300 es
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
`,Y={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",topFieldFirst:"uTopFieldFirst",match:"uMatch"},R=288,k=162,oe=`#version 300 es
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
  ivec2 targetSize = ivec2(${R}, ${k});
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
`,le=`#version 300 es
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
`,ce=`#version 300 es
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
  ivec2 targetSize = ivec2(${R}, ${k});
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
`;class x{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#r;#t;#e;#s=0;#m=null;#n=[];#g=null;#M=1/0;#R=1/0;constructor(e,t){this.#r=e,this.#t=t,this.#e=255*x.DECIMATE_BLOCK**2*x.DUPLICATE_PERCENT/100}fieldMatch(e,t,i,s,r=x.COMBED_PIXEL_LIMIT){const n=s?1:0,o={p:e,c:t,n:i};let h=this.#y("c","p",n,o);const l=new Map,a=E=>{const g=l.get(E);if(g!==void 0)return g;const v=x.#b(this.weave(e,t,i,E,s),this.#r,this.#t);return l.set(E,v),v},p=a(h),d=a("n");(d*3<p||d*2<p&&p>r)&&Math.abs(d-p)>=30&&d<r&&(h="n");const u=a(h),c=u>=r;return c&&(h="c"),{match:h,combScore:u,isCombed:c,luma:this.weave(e,t,i,h,s)}}decimate(e){const t=this.#s,i=this.#g?x.#w(this.#g,e,this.#r,this.#t):{maxBlockDifference:1/0,totalDifference:1/0};this.#n.push(i);const s=this.#m===t,r=s&&i.maxBlockDifference<this.#e;s&&!r&&(this.#m=null);const n=this.#m;this.#g=e.slice(),this.#s++;let o=this.#m;if(this.#s===x.CYCLE){let h=0,l=null;for(let a=1;a<this.#n.length;a++)(this.#n[a]?.maxBlockDifference??1/0)<(this.#n[h]?.maxBlockDifference??1/0)?(l=h,h=a):(l===null||(this.#n[a]?.maxBlockDifference??1/0)<(this.#n[l]?.maxBlockDifference??1/0))&&(l=a);this.#M=this.#n[h]?.maxBlockDifference??1/0,this.#R=l===null?1/0:this.#n[l]?.maxBlockDifference??1/0,o=(this.#n[h]?.maxBlockDifference??1/0)<this.#e?h:null,this.#m=o,this.#n=[],this.#s=0}return{cycleIndex:t,maxBlockDifference:i.maxBlockDifference,totalDifference:i.totalDifference,shouldDrop:r,dropIndex:n,nextDropIndex:o,lowestCycleDifference:this.#M,runnerUpCycleDifference:this.#R}}weave(e,t,i,s,r){if(s==="c")return t.slice();const n=t.slice(),o=s==="p"?e:i,h=n.length/this.#t,l=r?1:0;for(let a=l;a<this.#t;a+=2)n.set(o.subarray(a*h,(a+1)*h),a*h);return n}reset(){this.#s=0,this.#m=null,this.#n=[],this.#g=null,this.#M=1/0,this.#R=1/0}#y(e,t,i,s){const r=this.#r,n=this.#t,o=2-i,h=2-i,l=s[e],a=s[t],p=x.#k(l,a,r,n,i);let d=0,u=0,c=0,E=0,g=0,v=0;for(let _=2;_<n-2;_+=2){const M=(_-2)/2,Q=o-1+M*2,$=o+1+M*2,K=o+3+M*2,G=o+M*2,X=G+2,I=h+M*2,L=I+2,re=o+M*2;for(let S=8;S<r-8;S++){const P=(p[re*r+S]??0)|(p[(re+2)*r+S]??0);if(P===0)continue;const ne=(s.c[Q*r+S]??0)+((s.c[$*r+S]??0)<<2)+(s.c[K*r+S]??0),N=Math.abs(3*((l[G*r+S]??0)+(l[X*r+S]??0))-ne),B=Math.abs(3*((a[I*r+S]??0)+(a[L*r+S]??0))-ne);N>23&&(P&1)!==0&&(d+=N),B>23&&(P&1)!==0&&(E+=B),N>42&&(P&2)!==0&&(u+=N),B>42&&(P&2)!==0&&(g+=B),N>42&&(P&4)!==0&&(c+=N),B>42&&(P&4)!==0&&(v+=B)}}u<500&&g<500&&(c>=500||v>=500)&&Math.max(c,v)>3*Math.min(c,v)&&(u=c,g=v);const b=Math.floor(d/6+.5),D=Math.floor(E/6+.5),y=Math.floor(u/6+.5),m=Math.floor(g/6+.5),O=Math.max(b,D)/Math.max(Math.min(b,D),1),W=Math.max(y,m)/Math.max(Math.min(y,m),1),H=Math.max(y,m)/Math.max(Math.max(b,D),1);return(y>=500||m>=500)&&(y*2<m||m*2<y)||(y>=1e3||m>=1e3)&&(y*3<m*2||m*3<y*2)||(y>=2e3||m>=2e3)&&(y*5<m*4||m*5<y*4)||(y>=4e3||m>=4e3)&&W>O||H>.005&&Math.max(y,m)>150&&(y*2<m||m*2<y)?y>m?t:e:b>D?t:e}static#k(e,t,i,s,r){const n=Array.from({length:Math.ceil(s/2)},()=>new Uint8Array(i)),o=r===1?1:0;for(let a=0;a<n.length;a++){const p=Math.min(s-1,o+a*2),d=n[a];if(d)for(let u=0;u<i;u++)d[u]=Math.abs((e[p*i+u]??0)-(t[p*i+u]??0))}const h=new Uint8Array(i*s),l=r===1?3:2;for(let a=1;a<n.length-1;a++){const p=l+(a-1)*2;if(p>=s)break;const d=n[a];if(d)for(let u=1;u<i-1;u++){const c=d[u]??0;if(c<=3)continue;let E=0;for(let m=u-1;m<=u+1;m++)E+=(n[a-1]?.[m]??0)>3?1:0,E+=(n[a]?.[m]??0)>3?1:0,E+=(n[a+1]?.[m]??0)>3?1:0;if(E<=1)continue;const g=p*i+u;if(h[g]=1,c<=19)continue;E=0;let v=!1,b=!1;for(let m=u-1;m<=u+1;m++)(n[a-1]?.[m]??0)>19&&(E++,v=!0),(n[a]?.[m]??0)>19&&E++,(n[a+1]?.[m]??0)>19&&(E++,b=!0);if(E<=3)continue;if(v&&b){h[g]|=2;continue}let D=!1,y=!1;for(let m=Math.max(u-4,0);m<Math.min(u+5,i);m++)a!==1&&(n[a-2]?.[m]??0)>19&&(D=!0),(n[a-1]?.[m]??0)>19&&(v=!0),(n[a+1]?.[m]??0)>19&&(b=!0),a!==n.length-2&&(n[a+2]?.[m]??0)>19&&(y=!0);v&&(b||D)||b&&(v||y)?h[g]|=2:E>5&&(h[g]|=4)}}return h}static#b(e,t,i){const s=new Uint8Array(t*i),r=(o,h)=>e[Math.max(0,Math.min(i-1,h))*t+o]??0;for(let o=0;o<i;o++)for(let h=0;h<t;h++){const l=r(h,o),a=r(h,o===0?1:o-1),p=r(h,o===i-1?i-2:o+1),d=o<2?r(h,o===0?2:3):r(h,o-2),u=o+2>=i?r(h,o===i-1?i-3:i-4):r(h,o+2);(o===0?Math.abs(l-p)>x.COMB_THRESHOLD:o===i-1?Math.abs(l-a)>x.COMB_THRESHOLD:Math.abs(l-a)>x.COMB_THRESHOLD&&Math.abs(l-p)>x.COMB_THRESHOLD)&&Math.abs(4*l-3*(a+p)+d+u)>x.COMB_THRESHOLD*6&&(s[o*t+h]=255)}let n=0;for(const o of[0,8])for(const h of[0,8])for(let l=o;l<i;l+=16)for(let a=h;a<t;a+=16){let p=0;for(let d=Math.max(1,l);d<Math.min(i-1,l+16);d++)for(let u=a;u<Math.min(t,a+16);u++){const c=d*t+u;s[c-t]===255&&s[c]===255&&s[c+t]===255&&p++}n=Math.max(n,p)}return n}static#w(e,t,i,s){const r=x.DECIMATE_BLOCK/2,n=Math.ceil(i/r),o=Math.ceil(s/r),h=new Float64Array(n*o),l=e.length/(i*s);for(let d=0;d<s;d++){const u=Math.floor(d/r);for(let c=0;c<i;c++){const E=Math.floor(c/r),g=u*n+E,v=(d*i+c)*l;if(l===1){h[g]=(h[g]??0)+Math.abs((e[v]??0)-(t[v]??0));continue}const b=Math.round((e[v]??0)*.2126+(e[v+1]??0)*.7152+(e[v+2]??0)*.0722),D=Math.round((t[v]??0)*.2126+(t[v+1]??0)*.7152+(t[v+2]??0)*.0722);if(h[g]=(h[g]??0)+Math.abs(b-D),(c&1)!==0||(d&1)!==0)continue;let y=0,m=0,O=0,W=0,H=0,_=0,M=0;for(let X=d;X<Math.min(d+2,s);X++)for(let I=c;I<Math.min(c+2,i);I++){const L=(X*i+I)*l;y+=e[L]??0,m+=e[L+1]??0,O+=e[L+2]??0,W+=t[L]??0,H+=t[L+1]??0,_+=t[L+2]??0,M++}const Q=Math.round((-.114572*y-.385428*m+.5*O)/M),$=Math.round((-.114572*W-.385428*H+.5*_)/M),K=Math.round((.5*y-.454153*m-.045847*O)/M),G=Math.round((.5*W-.454153*H-.045847*_)/M);h[g]=(h[g]??0)+Math.abs(Q-$)+Math.abs(K-G)}}let a=-1;for(let d=0;d<o-1;d++)for(let u=0;u<n-1;u++)a=Math.max(a,(h[d*n+u]??0)+(h[d*n+u+1]??0)+(h[(d+1)*n+u]??0)+(h[(d+1)*n+u+1]??0));let p=0;for(const d of h)p+=d;return{maxBlockDifference:a,totalDifference:p}}}const J=["mozParsedFrames","mozDecodedFrames","mozPresentedFrames","mozPaintedFrames"];function fe(f){return J.every(e=>e in f)}const ue=250,de=500;class me{#r;#t;#e=null;#s=null;#m=null;#n=null;#g=!1;#M=!0;#R=null;#y=null;#k=0;constructor(e){if(this.#r=e,this.#t=fe(e)?e:null,this.#t){for(const t of["emptied","seeking","seeked"])e.addEventListener(t,this.#w);for(const t of["pause","playing","waiting","ratechange"])e.addEventListener(t,this.#b)}}get mozDriven(){return this.#t!==null}get hasDelivered(){return this.#g}request(e){this.#e===null&&(this.#s=e,this.#e=this.#t?requestAnimationFrame(this.#ee):this.#r.requestVideoFrameCallback(this.#_))}cancel(){this.#e!==null&&(this.#t?cancelAnimationFrame(this.#e):this.#r.cancelVideoFrameCallback(this.#e)),this.#e=null,this.#s=null,this.#w()}destroy(){this.cancel();for(const e of["emptied","seeking","seeked"])this.#r.removeEventListener(e,this.#w);for(const e of["pause","playing","waiting","ratechange"])this.#r.removeEventListener(e,this.#b)}#b=()=>{this.#R=null,this.#y=null,this.#k=0};#w=()=>{this.#m=null,this.#n=null,this.#M=!0,this.#b()};#_=(e,t)=>{const i=this.#s;this.#e=null,this.#s=null,this.#g=!0,i?.(e,t)};#ee=e=>{const t=this.#t,i=J.map(o=>t[o]);this.#m?.some((o,h)=>i[h]<o)&&this.#w(),this.#m=i;const s=t.mozPaintedFrames,r=!t.seeking&&t.readyState>=2&&t.videoWidth>0&&t.videoHeight>0,n=this.#n===null&&(s>0||t.paused&&(t.mozPresentedFrames>0||t.mozDecodedFrames>0));if(r&&(n||this.#n!==null&&s!==this.#n)){if(this.#R!==null&&e-this.#R>de&&(this.#b(),this.#M=!0),!t.paused&&!t.ended){const h=this.#y;if(h&&e-h.at>=ue){const l=s-h.frames;if(l>0){const a=(e-h.at)/l;a>=4&&a<=200&&(this.#k=this.#k?this.#k+(a-this.#k)*.25:a)}this.#y=null}this.#y??={at:e,frames:s}}this.#R=e,this.#n=s;const o=this.#M;this.#M=!1,this.#_(e,{width:t.videoWidth,height:t.videoHeight,mediaTime:t.currentTime,presentedFrames:s,expectedDisplayTime:e,mozTiming:{periodMs:this.#k,discontinuity:o}})}else this.#e=requestAnimationFrame(this.#ee)}}let pe=null;const Z=.5,T=3,q=5,w=q+1,ee=1e3,V=4,j=200,ve=.25,ge=1e3/60,Ee=.02,ye=250,be=1e3/30;function te(f){if(!Number.isFinite(f)||f<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return f}const xe=`#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`,Te=`#version 300 es
precision highp float;
uniform sampler2D uField;
uniform bool uFlip;
out vec4 fragColor;
void main() {
  ivec2 position = ivec2(gl_FragCoord.xy);
  if (uFlip) position.y = textureSize(uField, 0).y - 1 - position.y;
  fragColor = texelFetch(uField, position, 0);
}
`;class Fe extends EventTarget{#r;#t;#e;#s;#m;#n;#g;#M;#R;#y=null;#k=null;#b=null;#w=null;#_=null;#ee=null;#B=null;#A=[];#x=[];#te=w-1;#d=null;#i=[];#z=null;#me=0;#O=null;#G=ge;#Y=null;#ke;#D;#p;#q;#Se;#P="video";#ie="c";#Ae=0;#De=!0;#Ce=new x(R,k);#Le=1/0;#we=1/0;#W=0;#f=0;#v=0;#S=0;#E=T-1;#o=0;#se=0;#_e=0;#pe=Number.NaN;#re=!1;#V;#ve=0;#j=0;#Pe=0;#u=!1;#ge=!1;#Ue=!1;#l=null;#Q=[];#C=!1;#Ie;#c;#Ee;#U;#Ne;#a=null;#h;#ne=!1;#Be=0;#ze=!1;#yt=0;#he=!1;#ye=!1;#$=null;#bt=0;#ae=new Map;#T={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0};#H=0;#Oe=0;#be=0;#X=0;#oe=0;#le=0;#ce=0;#K=0;constructor(e,t={},i=null){super(),this.#e=e,this.#D=t.doubleRate??!1,this.#p=t.autoFilm??!1,this.#q=te(t.filmCombThreshold??x.COMBED_PIXEL_LIMIT),this.#Se=t.spatialCheck??!0,this.#Ie=t.onStats,this.#c=i,this.#U=i?"main":t.rendering??"auto",this.#Ne=t.workerUrl??pe,this.#h=this.#U==="main"?"main":"idle",this.#t=i?i.canvas:document.createElement("canvas"),this.#r=i?.canvas??(this.#U==="main"?this.#t:document.createElement("canvas")),this.#Ee=e,i||(this.#t.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const s=this.#r.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!s)throw new Error("this browser has no WebGL2");this.#s=s,this.#m=z(s,ae);const r=this.#m;this.#n=Object.fromEntries(Object.entries(he).map(([n,o])=>[n,s.getUniformLocation(r,o)])),this.#g=z(s,Te),this.#M=s.getUniformLocation(this.#g,"uField"),this.#R=s.getUniformLocation(this.#g,"uFlip"),this.#p&&this.#rt(),this.#r.addEventListener("webglcontextlost",this.#Et),this.#ke=i?null:new ResizeObserver(()=>this.#Re()),this.#V=new me(e),e.addEventListener("emptied",this.#pt),e.addEventListener("resize",this.#mt),e.addEventListener("pause",this.#N),e.addEventListener("ended",this.#N),e.addEventListener("seeking",this.#gt),e.addEventListener("seeked",this.#N),e.addEventListener("ratechange",this.#N)}get running(){return this.#u&&(this.#l?.interlaced??!0)}get canvas(){return this.#t}get#xe(){return this.#l?.topFieldFirst!==!1}#Je(){return{doubleRate:this.#D,autoFilm:this.#p,filmCombThreshold:this.#q,spatialCheck:this.#Se}}get enabled(){return this.#ge}set enabled(e){this.#ge=e,this.#He(),this.#a?.postMessage({type:"enabled",enabled:e})}set scan(e){const t=this.#l?.interlaced!==e?.interlaced,i=t||this.#l?.topFieldFirst!==e?.topFieldFirst;this.#l=e,this.#a?.postMessage({type:"scan",scan:e}),i&&(this.#o=0,this.#F(),t&&(this.#f=0),this.#d=null,this.#L(!1)),this.#He(),i&&((e?.interlaced??!0)&&(this.#c||this.#h==="main")?this.#J():this.#qe())}get scan(){return this.#l}set videoTimeline(e){this.#Q=e,this.#a?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#l=null),this.#He()}get videoTimeline(){return this.#Q}get container(){return this.#Y??this.#e}get doubleRate(){return this.#D}set doubleRate(e){e!==this.#D&&(this.#D=e,this.#We(),this.#i.length=0,e?(this.#v>0&&this.#$e(),(this.#l?.interlaced??!0)&&(this.#c||this.#h==="main")&&this.#J()):this.#p||(this.#d=null,this.#L(!1),this.#Z()))}get autoFilm(){return this.#p}set autoFilm(e){e!==this.#p&&(this.#p=e,this.#We(),this.#F(),e?(this.#rt(),this.#v>0&&(this.#dt(),this.#$e()),(this.#l?.interlaced??!0)&&(this.#c||this.#h==="main")&&this.#J()):(this.#Qe(),this.#D||(this.#d=null,this.#L(!1),this.#Z())))}get filmCombThreshold(){return this.#q}set filmCombThreshold(e){const t=te(e);t!==this.#q&&(this.#q=t,this.#We(),this.#p&&this.#F())}#We(){this.#a?.postMessage({type:"settings",options:this.#Je()})}#He(){this.#ge&&(this.#Q.length>0||(this.#l?.interlaced??!0))?this.start():this.stop()}#xt(){return this.#c||this.#U==="main"?!1:this.#h==="starting"||this.#h==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#Ne!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#Ze(),!0):this.#U==="auto"?(this.#Te(),!1):(this.#h="failed",this.#u=!1,!0)}#Ze(){this.#I(),this.#a?.terminate(),this.#a=null,this.#he=!1,this.#ye=!1;let e=this.#t;if(this.#ze){e=document.createElement("canvas"),e.className=this.#t.className;const r=this.#t.getAttribute("style");r===null?e.removeAttribute("style"):e.setAttribute("style",r),e.style.visibility="hidden",this.#t.parentElement&&this.#t.replaceWith(e),this.#t=e}const t=++this.#Be;this.#h="starting";let i,s;try{s=e.transferControlToOffscreen(),this.#ze=!0,i=new Worker(this.#Ne,{type:"module"})}catch(r){this.#fe(r instanceof Error?r.message:String(r));return}this.#a=i,i.onmessage=r=>{t===this.#Be&&this.#Tt(r.data)},i.onerror=r=>{t===this.#Be&&(r.preventDefault(),this.#fe(r.message||"the deinterlacer worker failed"))},i.postMessage({type:"initialize",canvas:s,options:this.#Je(),scan:this.#l,videoTimeline:this.#Q,enabled:this.#u,video:this.#Xe()},[s])}#Tt(e){switch(e.type){case"ready":this.#h="active",this.#u&&(this.#ue(),this.#Ve());break;case"failed":this.#fe(e.message);break;case"consumed":{this.#he=!1,this.#ye=!0;const t=this.#$;this.#$=null,t&&this.#tt(t);break}case"visibility":this.#t.style.visibility=e.visible?"visible":"hidden";break;case"stats":{const t={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0};this.dispatchEvent(new CustomEvent("stats",{detail:t})),this.#Ie?.(t);break}case"capture":{const t=this.#ae.get(e.id);if(this.#ae.delete(e.id),!t){e.image?.close();break}e.image?t.resolve(e.image):createImageBitmap(this.#e).then(t.resolve,t.reject);break}}}#fe(e){if(this.#h==="starting"&&this.#U==="auto"&&!this.#ne){this.#Te();return}if(this.#et(e),!this.#ne){this.#ne=!0,this.#Ze();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#h="failed",this.#a?.terminate(),this.#a=null,this.#I(),this.stop()}#Te(){const e=this.#r;e.className=this.#t.className;const t=this.#t.getAttribute("style");t===null?e.removeAttribute("style"):e.setAttribute("style",t),e.style.visibility="hidden",this.#t.parentElement&&this.#t.replaceWith(e),this.#t=e,this.#ze=!1,this.#a?.terminate(),this.#a=null,this.#h="main",this.#I(),this.#u&&(this.#ue(),this.#Ve(),(this.#l?.interlaced??!0)&&this.#J())}#I(){this.#$?.frame.close(),this.#$=null}#et(e){for(const t of this.#ae.values())t.reject(new Error(e));this.#ae.clear()}start(){if(!(this.#u||this.#Ue||this.#C)){if(this.#u=!0,this.#vt(),this.#F(),this.#ve=performance.now(),this.#Pe=this.#ve,this.#pe=Number.NaN,this.#j=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#Ut(),this.#Ve(),this.#xt()){this.#a?.postMessage({type:"enabled",enabled:!0}),this.#h==="active"&&this.#ue();return}this.#ue(),(this.#l?.interlaced??!0)&&this.#J()}}stop(){this.#u&&(this.#u=!1,this.#V.cancel(),this.#Dt(),this.#qe(),this.#o=0,this.#d=null,this.#L(!1),this.#I(),this.#a?.postMessage({type:"enabled",enabled:!1}))}destroy(){if(!this.#Ue){this.#Ue=!0,this.#ge=!1,this.stop(),this.#V.destroy(),this.#a?.postMessage({type:"destroy"}),this.#a?.terminate(),this.#a=null,this.#I(),this.#et("the deinterlacer was destroyed"),this.#r.removeEventListener("webglcontextlost",this.#Et),this.#e.removeEventListener("emptied",this.#pt),this.#e.removeEventListener("resize",this.#mt),this.#e.removeEventListener("pause",this.#N),this.#e.removeEventListener("ended",this.#N),this.#e.removeEventListener("seeking",this.#gt),this.#e.removeEventListener("seeked",this.#N),this.#e.removeEventListener("ratechange",this.#N),this.#It();for(const e of this.#A)this.#s.deleteTexture(e);this.#A=[],this.#Z(),this.#Qe(),this.#s.deleteProgram(this.#m),this.#s.deleteProgram(this.#g),this.#y&&this.#s.deleteProgram(this.#y),this.#b&&this.#s.deleteProgram(this.#b),this.#_&&this.#s.deleteProgram(this.#_),this.#s.getExtension("WEBGL_lose_context")?.loseContext()}}capture(){if(this.#h==="active"&&this.#t.style.visibility==="visible"&&this.#a){const s=++this.#bt,r=new Promise((n,o)=>{this.#ae.set(s,{resolve:n,reject:o})});return this.#a.postMessage({type:"capture",id:s,width:this.#e.videoWidth,height:this.#e.videoHeight}),r}if(this.#h==="starting"||this.#h==="failed")return createImageBitmap(this.#e);const e=this.#d;if(this.#c&&(!this.#u||this.#C||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#u||this.#C||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#je(e.texture,e.flip,!1):e.kind==="yadif"?this.#de(e.flush,e.second,null,!1):this.#Ge(null,!1);const t=this.#e.videoWidth,i=this.#e.videoHeight;return t>0&&i>0&&(t!==this.#r.width||i!==this.#r.height)?createImageBitmap(this.#r,{resizeWidth:t,resizeHeight:i,resizeQuality:"high"}):createImageBitmap(this.#r)}addEventListener(e,t,i){super.addEventListener(e,t,i)}removeEventListener(e,t,i){super.removeEventListener(e,t,i)}#ue(){this.#c||!this.#u||this.#V.request(this.#Mt)}#Xe(){const e=[];for(let t=0;t<this.#e.buffered.length;t++)e.push({start:this.#e.buffered.start(t),end:this.#e.buffered.end(t)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#Ft(e,t){let i;try{i=new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(t.mediaTime*1e6))})}catch(r){const n=r instanceof Error?r.message:String(r);this.#U==="auto"&&!this.#ye&&!this.#ne?(this.#Te(),this.#Fe(e,t)):this.#fe(n);return}const s={id:++this.#yt,frame:i,now:e,metadata:t,video:this.#Xe()};if(this.#he){this.#$?.frame.close(),this.#$=s;return}this.#tt(s)}#tt(e){const t=this.#a;if(!t||this.#h!=="active"){e.frame.close();return}this.#he=!0;const i={type:"frame",...e};try{t.postMessage(i,[e.frame])}catch(s){this.#he=!1,e.frame.close();const r=s instanceof Error?s.message:String(s);this.#U==="auto"&&!this.#ye&&!this.#ne?(this.#Te(),this.#Fe(e.now,e.metadata)):this.#fe(r)}}#Mt=(e,t)=>{!this.#u||this.#C||(this.#ve=e,this.#j=Math.max(this.#j,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0),this.#it(e,t),this.#ue())};#it(e,t){if(this.#pe=t.mediaTime,this.#h==="active"){this.#Ft(e,t);return}this.#h!=="starting"&&this.#Fe(e,t)}ingestExternalFrame(e,t,i){this.#Ee=i;try{this.#Fe(e,t)}finally{this.#Ee=this.#e}}#Fe(e,t){if(this.#Rt(t.mediaTime),t.width>0&&t.height>0){let i=!1;if(!this.#re&&this.#e.seeking){const c=this.#e.buffered,E=this.#f>=V?this.#f/1e3:j/1e3;for(let g=0;g<c.length;g++)if(t.mediaTime>=c.start(g)&&t.mediaTime<c.end(g)&&Math.abs(t.mediaTime-this.#e.currentTime)<=E){i=!0;break}}if(i&&(this.#re=!0),(this.#v===0||this.#S===0)&&this.#ut(t.width,t.height),this.#l&&!this.#l.interlaced){this.#wt();return}const s=t.mediaTime-this.#se,r=t.mozTiming,n=i||(r?r.discontinuity||s<0||s>Z:s<0||s>Z);n&&(this.#o=0,this.#f=0,this.#T.discontinuities++,this.#i.length=0,this.#F());const o=this.#p&&this.#H!==0&&t.presentedFrames-this.#H>1;if(this.#_t(t.presentedFrames,n),!n&&o&&(this.#o=0,this.#F()),this.#o>0&&t.mediaTime===this.#se&&(!t.mozTiming||t.presentedFrames===this.#_e))return;if(!n){const c=r?.periodMs??0;c>0?this.#st(c*(this.#e.playbackRate||1)/1e3):s>0&&this.#st(s)}this.#se=t.mediaTime,this.#_e=t.presentedFrames;const h=performance.now();h-this.#Oe>ee&&(this.#be=h,this.#X=0,this.#oe=0,this.#le=0,this.#ce=0,this.#K=0,this.#W=0),this.#Oe=h;const l=performance.now();this.#ft();const a=this.#P,p=this.#p&&this.#o===T&&this.#kt();if(a!==this.#P&&(this.#i.length=0),!(p&&this.#Me()))if(this.#p&&!this.#De&&this.#P==="film")if(this.#Me()){const c=this.#f*5/4,E=this.#ht(1,e,c),g=this.#i.at(-1),v=E?e:g==null?e+c:g.at+g.duration;this.#St(v,c)}else this.#Ge(null);else if(this.#D&&this.#Me()){const c=this.#f/2,E=this.#ht(2,e,c),g=this.#i.at(-1),v=E?e:g==null?e+c*2:g.at+g.duration;this.#nt(!1,v,c),this.#nt(!0,v+c,c)}else this.#T.late+=this.#i.length,this.#i.length=0,this.#de(!1,!1,null);this.#K=Math.max(this.#K,this.#i.length),this.#oe+=performance.now()-l,this.#X++,this.#Pt(h)}}#Rt(e){let t;for(let r=this.#Q.length-1;r>=0;r--){const n=this.#Q[r];if(n.start<=e+1e-6){t=n;break}}t?.codedSize&&(t.codedSize.width!==this.#v||t.codedSize.height!==this.#S)&&this.#ut(t.codedSize.width,t.codedSize.height);const i=t?.scan;if(!i||this.#l?.interlaced===i.interlaced&&this.#l.topFieldFirst===i.topFieldFirst)return;const s=this.#l?.interlaced;this.#l=i,this.#o=0,this.#i.length=0,this.#F(),s!==i.interlaced&&(this.#f=0),i.interlaced&&(this.#c||this.#h==="main")?this.#J():this.#qe()}#Me(){return(this.#D||this.#p)&&this.#f>0&&this.#x.length===w}#st(e){const t=e*1e3/(this.#e.playbackRate||1),i=this.#f>0?Math.max(1,Math.round(t/this.#f)):1,s=t/i;s<V||s>j||(this.#f=this.#f>0?this.#f+(s-this.#f)*ve:s)}#rt(){if(this.#y&&this.#b&&this.#_)return;const e=this.#s,t=z(e,oe),i=z(e,le),s=z(e,ce);this.#y=t,this.#k=Object.fromEntries(Object.entries(Y).filter(([r])=>r!=="match"&&r!=="topFieldFirst").map(([r,n])=>[r,e.getUniformLocation(t,n)])),this.#b=i,this.#w=Object.fromEntries(Object.entries(Y).map(([r,n])=>[r,e.getUniformLocation(i,n)])),this.#_=s,this.#ee=Object.fromEntries(Object.entries(Y).map(([r,n])=>[r,e.getUniformLocation(s,n)]))}#kt(){const e=this.#B,t=this.#y,i=this.#k,s=this.#_,r=this.#ee;if(!e||!t||!i||!s||!r)return!1;const n=this.#s,o=this.#E,h=(this.#E+T-1)%T,l=(this.#E+1)%T,a=this.#xe;n.bindFramebuffer(n.FRAMEBUFFER,e.framebuffer),n.useProgram(t);for(const[v,b]of[l,h,o].entries())n.activeTexture(n.TEXTURE0+v),n.bindTexture(n.TEXTURE_2D,this.#A[b]??null);n.uniform1i(i.prev,0),n.uniform1i(i.cur,1),n.uniform1i(i.next,2),n.uniform2i(i.size,this.#v,this.#S),n.viewport(0,0,R,k),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,R,k,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const{previousLuma:p,currentLuma:d,nextLuma:u}=e;for(let v=0;v<p.length;v++){const b=v*4;p[v]=e.pixels[b]??0,d[v]=e.pixels[b+1]??0,u[v]=e.pixels[b+2]??0}const c=this.#Ce.fieldMatch(p,d,u,a,this.#q);n.useProgram(s),n.uniform1i(r.prev,0),n.uniform1i(r.cur,1),n.uniform1i(r.next,2),n.uniform2i(r.size,this.#v,this.#S),n.uniform1i(r.topFieldFirst,a?1:0),n.uniform1i(r.match,c.match==="p"?0:c.match==="c"?1:2),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,R,k,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const E=this.#Ce.decimate(e.pixels);this.#ie=c.match,this.#Ae=c.combScore,this.#De=c.isCombed,this.#Le=E.lowestCycleDifference,this.#we=E.runnerUpCycleDifference;const g=E.dropIndex!==null&&!c.isCombed;return(g?"film":"video")!==this.#P&&(this.#P=g?"film":"video"),E.shouldDrop&&!c.isCombed}#St(e,t){const i=this.#Ye();if(i===null)return;const s=this.#x[i];if(s){for(this.#te=i;this.#i.length>0&&this.#i[0]?.slot===i;)this.#i.shift(),this.#T.late++;this.#Ge(s.framebuffer),this.#i.push({slot:i,at:e,duration:t})}}#Ge(e,t=!0){const i=this.#b,s=this.#w;if(!i||!s)return;const r=this.#s,n=this.#E,o=(this.#E+T-1)%T,h=(this.#E+1)%T,l=this.#xe;r.bindFramebuffer(r.FRAMEBUFFER,e),r.useProgram(i);for(const[a,p]of[h,o,n].entries())r.activeTexture(r.TEXTURE0+a),r.bindTexture(r.TEXTURE_2D,this.#A[p]??null);r.uniform1i(s.prev,0),r.uniform1i(s.cur,1),r.uniform1i(s.next,2),r.uniform2i(s.size,this.#v,this.#S),r.uniform1i(s.topFieldFirst,l?1:0),r.uniform1i(s.match,this.#ie==="p"?0:this.#ie==="c"?1:2),r.viewport(0,0,this.#v,this.#S),r.drawArrays(r.TRIANGLES,0,3),e===null&&(this.#d={kind:"film"},this.#L(!0),t&&this.#W++)}#nt(e,t,i){const s=this.#Ye();if(s===null)return;const r=this.#x[s];if(r){for(this.#te=s;this.#i.length>0&&this.#i[0]?.slot===s;)this.#i.shift(),this.#T.late++;this.#de(!1,e,r.framebuffer),this.#i.push({slot:s,at:t,duration:i})}}#ht(e,t,i){const s=this.#i.at(-1),r=(q+1)*Math.max(this.#G,i);if(s&&s.at-t>r)return this.#i.length=0,this.#T.queueResetted++,!0;const n=Math.max(0,this.#i.length+e-q);let o=0,h=0;for(;h<n;){const l=this.#i.shift();if(!l)break;o+=l.duration,h++}for(const l of this.#i)l.at-=o;return this.#T.late+=h,!1}#Ye(){const e=this.#d?.kind==="texture"?this.#d.texture:null,t=new Set(this.#i.map(({slot:s})=>s));for(let s=1;s<=w;s++){const r=(this.#te+s)%w,n=this.#x[r];if(n&&n.texture!==e&&!t.has(r))return r}const i=this.#i[0];if(i){const s=this.#x[i.slot];if(s&&s.texture!==e)return i.slot}return null}#J(){this.#z===null&&(!this.#u||this.#C||(this.#me=0,this.#z=this.#ot(this.#at)))}#qe(){this.#z!==null&&this.#At(this.#z),this.#z=null,this.#i.length=0}#at=e=>{if(this.#z=null,!(!this.#u||this.#C)){if(this.#me>0){const t=e-this.#me;t>=1&&t<=j&&(this.#G=t<this.#G?t:this.#G+(t-this.#G)*Ee)}this.#me=e,this.#h==="main"&&this.#Lt(e),this.#z=this.#ot(this.#at)}};#ot(e){return this.#c?this.#c.requestAnimationFrame(e):requestAnimationFrame(e)}#At(e){this.#c?this.#c.cancelAnimationFrame(e):cancelAnimationFrame(e)}#Ve(){this.#c||this.#O!==null||!this.#u||this.#C||(this.#O=requestAnimationFrame(this.#lt))}#Dt(){this.#O!==null&&cancelAnimationFrame(this.#O),this.#O=null}#lt=e=>{this.#O=null,!(!this.#u||this.#C)&&(this.#Ct(e),this.#O=requestAnimationFrame(this.#lt))};#Ct(e){if(this.#c||this.#V.mozDriven&&this.#V.hasDelivered||e-this.#ve<ye||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const t=this.#e.currentTime,i=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,s=this.#f>=V?this.#f:be,r=i>this.#j,n=t!==this.#pe&&e-this.#Pe>=s*.75;!r&&!n||(this.#j=Math.max(this.#j,i),this.#Pe=e,this.#it(e,{mediaTime:t,presentedFrames:Math.max(this.#H+1,i),width:this.#e.videoWidth,height:this.#e.videoHeight}))}#Lt(e){const t=e+this.#G*1.5;for(;this.#i[1]&&this.#i[1].at<=t;)this.#T.late++,this.#i.shift();let i=this.#i[0];if(!i||i.at>t)return;this.#i.shift();const s=performance.now();this.#ct(i.slot),this.#ce+=performance.now()-s,this.#le++}#ct(e){const t=this.#x[e];t&&this.#je(t.texture)}#wt(){this.#ft();const e=this.#A[this.#E];e&&this.#je(e,!0),this.#o=0}#L(e){if(this.#c){this.#c.onVisibility(e);return}this.#t.style.visibility=e?"visible":"hidden"}#je(e,t=!1,i=!0){const s=this.#s;s.bindFramebuffer(s.FRAMEBUFFER,null),s.useProgram(this.#g),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,e),s.uniform1i(this.#M,0),s.uniform1i(this.#R,t?1:0),s.viewport(0,0,this.#v,this.#S),s.drawArrays(s.TRIANGLES,0,3),this.#d={kind:"texture",texture:e,flip:t},this.#L(!0),i&&this.#W++}#_t(e,t){this.#H!==0&&!t&&(this.#T.missed+=Math.max(0,e-this.#H-1)),this.#H=e}#Pt(e){const t=e-this.#be;if(t<ee)return;const i=this.#Me()&&(this.#D||this.#P==="film")?this.#le:this.#X,s={...this.#T,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:i*1e3/t,frameMs:this.#X===0?0:(this.#oe+this.#ce)/this.#X,maxQueuedFields:this.#K,mode:this.#P,match:this.#ie,combScore:this.#Ae,outputFps:this.#W*1e3/t,duplicateScore:this.#Le,duplicateRunnerUp:this.#we};this.dispatchEvent(new CustomEvent("stats",{detail:s})),this.#Ie?.(s),this.#be=e,this.#X=0,this.#oe=0,this.#le=0,this.#ce=0,this.#K=0,this.#W=0}#ft(){const e=this.#s;this.#E=(this.#E+1)%T,e.bindTexture(e.TEXTURE_2D,this.#A[this.#E]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#Ee),this.#o=Math.min(this.#o+1,T)}#de(e,t,i,s=!0){if(this.#o===0||this.#C)return;s&&(this.#o===T&&!e?this.#T.filtered++:this.#T.degraded++);const r=this.#s,n=this.#E,o=(this.#E+T-1)%T,h=(this.#E+1)%T;let l,a,p;this.#o===1?l=a=p=n:e?(l=o,a=p=n):this.#o===2?(l=a=o,p=n):(l=h,a=o,p=n),r.bindFramebuffer(r.FRAMEBUFFER,i),r.useProgram(this.#m);for(const[u,c]of[l,a,p].entries())r.activeTexture(r.TEXTURE0+u),r.bindTexture(r.TEXTURE_2D,this.#A[c]??null);r.uniform1i(this.#n.prev,0),r.uniform1i(this.#n.cur,1),r.uniform1i(this.#n.next,2),r.uniform2i(this.#n.size,this.#v,this.#S);const d=this.#xe?0:1;r.uniform1i(this.#n.parity,t?1-d:d),r.uniform1i(this.#n.tff,this.#xe?1:0),r.uniform1i(this.#n.spatialCheck,this.#Se?1:0),r.viewport(0,0,this.#v,this.#S),r.drawArrays(r.TRIANGLES,0,3),i===null&&(this.#d={kind:"yadif",flush:e,second:t},this.#L(!0),s&&this.#W++)}#Re(){if(!this.#Y)return;const e=this.#e,t=e.videoWidth,i=e.videoHeight;if(t===0||i===0)return;const s=Math.min(e.offsetWidth/t,e.offsetHeight/i),r=t*s,n=i*s;this.#t.style.left=`${e.offsetLeft+(e.offsetWidth-r)/2}px`,this.#t.style.top=`${e.offsetTop+(e.offsetHeight-n)/2}px`,this.#t.style.width=`${r}px`,this.#t.style.height=`${n}px`}#ut(e,t){const i=this.#s;this.#r.width=e,this.#r.height=t,this.#v=e,this.#S=t,this.#o=0,this.#d=null,this.#F(),this.#Re();for(const s of this.#A)i.deleteTexture(s);this.#A=[];for(let s=0;s<T;s++){const r=i.createTexture();i.bindTexture(i.TEXTURE_2D,r),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,e,t,0,i.RGBA,i.UNSIGNED_BYTE,null),this.#A.push(r)}this.#Z(),this.#Qe(),this.#p&&this.#dt(),(this.#D||this.#p)&&this.#$e()}#dt(){if(this.#B)return;const e=this.#s,t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,R,k,0,e.RGBA,e.UNSIGNED_BYTE,null);const i=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,i),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const s=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!s){e.deleteFramebuffer(i),e.deleteTexture(t);return}this.#B={texture:t,framebuffer:i,pixels:new Uint8Array(R*k*4),previousLuma:new Uint8Array(R*k),currentLuma:new Uint8Array(R*k),nextLuma:new Uint8Array(R*k)}}#Qe(){this.#B&&(this.#s.deleteFramebuffer(this.#B.framebuffer),this.#s.deleteTexture(this.#B.texture),this.#B=null)}#$e(){const e=this.#s;if(!(this.#x.length===w||this.#v===0)){this.#Z();for(let t=0;t<w;t++){const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#v,this.#S,0,e.RGBA,e.UNSIGNED_BYTE,null);const s=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,s),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(s),e.deleteTexture(i),this.#Z();return}this.#x.push({texture:i,framebuffer:s})}this.#te=w-1}}#Z(){const e=this.#s,t=this.#d?.kind==="texture"?this.#d.texture:null;this.#x.some(i=>i.texture===t)&&(this.#d=null);for(const{texture:i,framebuffer:s}of this.#x)e.deleteFramebuffer(s),e.deleteTexture(i);this.#x=[],this.#i.length=0}#Ut(){if(this.#Y)return;const e=this.#e.parentElement;if(!e)return;const t=document.createElement("div");t.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(t,this.#e),t.appendChild(this.#e),t.appendChild(this.#t),this.#Y=t,this.#ke?.observe(this.#e),this.#Re()}#It(){if(this.#c)return;const e=this.#Y;this.#Y=null,this.#ke?.disconnect(),this.#t.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#mt=()=>this.#Re();#Ke(e){return!this.#a||this.#h==="main"?!1:(this.#a.postMessage({type:"event",name:e,video:this.#Xe()}),!0)}#pt=()=>{if(this.#pe=Number.NaN,this.#Ke("emptied")){this.#I(),this.#L(!1);return}this.#o=0,this.#se=0,this.#_e=0,this.#i.length=0,this.#f=0,this.#vt(),this.#F(),this.#d=null,this.#L(!1)};#vt(){this.#T={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0},this.#H=0,this.#be=0,this.#Oe=0,this.#X=0,this.#oe=0,this.#le=0,this.#ce=0,this.#K=0,this.#W=0,this.#F()}#F(){this.#i.length=0,this.#P="video",this.#ie="c",this.#Ae=0,this.#De=!0,this.#Ce.reset(),this.#Le=1/0,this.#we=1/0}#gt=()=>{if(this.#Ke("seeking")){this.#I();return}this.#re=!1};#N=e=>{if((e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#Ke(e.type)){this.#I();return}if(e.type==="seeked"){const i=this.#re;if(this.#re=!1,i)return;this.#o=0,this.#F(),this.#d=null,this.#L(!1);return}const t=e.type==="ratechange";if(t&&(this.#f=0,this.#se=this.#e.currentTime),this.#i.length=0,this.#u&&this.#o>0){const i=this.#Ye(),s=i===null?void 0:this.#x[i];i!==null&&s?(this.#te=i,this.#de(!0,!1,s.framebuffer),this.#ct(i)):this.#de(!0,!1,null)}t&&(this.#o=0,this.#F())};#Et=e=>{if(e.preventDefault(),this.#c){this.#c.onFailure("the deinterlacer WebGL context was lost");return}this.#h!=="active"&&(this.#C=!0,this.stop())}}function Me(f,e,t,i,s,r,n){return new Fe(f,t,{canvas:e,onFailure:i,onVisibility:s,requestAnimationFrame:r,cancelAnimationFrame:n})}function z(f,e){const t=f.createProgram(),i=ie(f,f.VERTEX_SHADER,xe),s=ie(f,f.FRAGMENT_SHADER,e);if(f.attachShader(t,i),f.attachShader(t,s),f.linkProgram(t),f.deleteShader(i),f.deleteShader(s),!f.getProgramParameter(t,f.LINK_STATUS)){const r=f.getProgramInfoLog(t);throw f.deleteProgram(t),new Error(`the deinterlacer failed to link: ${r??"no reason given"}`)}return t}function ie(f,e,t){const i=f.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(f.shaderSource(i,t),f.compileShader(i),!f.getShaderParameter(i,f.COMPILE_STATUS)){const s=f.getShaderInfoLog(i);throw f.deleteShader(i),new Error(`the deinterlacer failed to compile: ${s??"no reason given"}`)}return i}const U=self;class Re extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#r=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#r=e.buffered}get buffered(){return{length:this.#r.length,start:e=>{const t=this.#r[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.start},end:e=>{const t=this.#r[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let A=null,F=null,se=!1;function ke(f){return U.requestAnimationFrame(f)}function Se(f){U.cancelAnimationFrame(f)}function C(f,e=[]){U.postMessage(f,e)}function Ae(f,e){f.doubleRate=e.doubleRate,f.autoFilm=e.autoFilm,f.filmCombThreshold=e.filmCombThreshold}U.onmessage=f=>{const e=f.data;try{if(e.type==="initialize"){if(typeof U.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");A=new Re,A.update(e.video),F=Me(A,e.canvas,e.options,t=>{se||C({type:"failed",message:t})},t=>C({type:"visibility",visible:t}),ke,Se),F.addEventListener("stats",t=>{const{dropped:i,...s}=t.detail;C({type:"stats",stats:s})}),F.scan=e.scan,F.videoTimeline=e.videoTimeline,F.enabled=e.enabled,C({type:"ready"});return}if(!A||!F)return;switch(e.type){case"frame":A.update(e.video);try{F.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),C({type:"consumed",id:e.id})}break;case"settings":Ae(F,e.options);break;case"scan":F.scan=e.scan;break;case"timeline":F.videoTimeline=e.videoTimeline;break;case"enabled":F.enabled=e.enabled;break;case"event":A.update(e.video),A.dispatchEvent(new Event(e.name));break;case"capture":A.videoWidth=e.width,A.videoHeight=e.height,F.capture().then(t=>C({type:"capture",id:e.id,image:t},[t])).catch(()=>C({type:"capture",id:e.id,image:null}));break;case"destroy":se=!0,F.destroy(),F=null,A=null,U.close();break}}catch(t){const i=t instanceof Error?t.message:String(t);C({type:"failed",message:i})}}})();
//# sourceMappingURL=worker-BT6pr8SK.js.map
