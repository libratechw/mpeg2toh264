(function(){"use strict";const re={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",parity:"uParity",tff:"uTff",spatialCheck:"uSpatialCheck"},ne=`#version 300 es
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
`,Y={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",topFieldFirst:"uTopFieldFirst",match:"uMatch"},M=288,k=162,he=`#version 300 es
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
  ivec2 targetSize = ivec2(${M}, ${k});
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
`,ae=`#version 300 es
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
`,oe=`#version 300 es
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
  ivec2 targetSize = ivec2(${M}, ${k});
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
`;class y{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#r;#i;#e;#s=0;#x=null;#n=[];#T=null;#O=1/0;#z=1/0;constructor(e,t){this.#r=e,this.#i=t,this.#e=255*y.DECIMATE_BLOCK**2*y.DUPLICATE_PERCENT/100}fieldMatch(e,t,i,s,r=y.COMBED_PIXEL_LIMIT){const n=s?1:0,o={p:e,c:t,n:i};let a=this.#C("c","p",n,o);const c=new Map,h=p=>{const E=c.get(p);if(E!==void 0)return E;const g=y.#w(this.weave(e,t,i,p,s),this.#r,this.#i);return c.set(p,g),g},v=h(a),f=h("n");(f*3<v||f*2<v&&v>r)&&Math.abs(f-v)>=30&&f<r&&(a="n");const l=h(a),d=l>=r;return d&&(a="c"),{match:a,combScore:l,isCombed:d,luma:this.weave(e,t,i,a,s)}}decimate(e){const t=this.#s,i=this.#T?y.#le(this.#T,e,this.#r,this.#i):{maxBlockDifference:1/0,totalDifference:1/0};this.#n.push(i);const s=this.#x===t,r=s&&i.maxBlockDifference<this.#e;s&&!r&&(this.#x=null);const n=this.#x;this.#T=e.slice(),this.#s++;let o=this.#x;if(this.#s===y.CYCLE){let a=0,c=null;for(let h=1;h<this.#n.length;h++)(this.#n[h]?.maxBlockDifference??1/0)<(this.#n[a]?.maxBlockDifference??1/0)?(c=a,a=h):(c===null||(this.#n[h]?.maxBlockDifference??1/0)<(this.#n[c]?.maxBlockDifference??1/0))&&(c=h);this.#O=this.#n[a]?.maxBlockDifference??1/0,this.#z=c===null?1/0:this.#n[c]?.maxBlockDifference??1/0,o=(this.#n[a]?.maxBlockDifference??1/0)<this.#e?a:null,this.#x=o,this.#n=[],this.#s=0}return{cycleIndex:t,maxBlockDifference:i.maxBlockDifference,totalDifference:i.totalDifference,shouldDrop:r,dropIndex:n,nextDropIndex:o,lowestCycleDifference:this.#O,runnerUpCycleDifference:this.#z}}weave(e,t,i,s,r){if(s==="c")return t.slice();const n=t.slice(),o=s==="p"?e:i,a=n.length/this.#i,c=r?1:0;for(let h=c;h<this.#i;h+=2)n.set(o.subarray(h*a,(h+1)*a),h*a);return n}reset(){this.#s=0,this.#x=null,this.#n=[],this.#T=null,this.#O=1/0,this.#z=1/0}#C(e,t,i,s){const r=this.#r,n=this.#i,o=2-i,a=2-i,c=s[e],h=s[t],v=y.#oe(c,h,r,n,i);let f=0,l=0,d=0,p=0,E=0,g=0;for(let _=2;_<n-2;_+=2){const R=(_-2)/2,Q=o-1+R*2,$=o+1+R*2,K=o+3+R*2,G=o+R*2,X=G+2,I=a+R*2,w=I+2,ie=o+R*2;for(let S=8;S<r-8;S++){const P=(v[ie*r+S]??0)|(v[(ie+2)*r+S]??0);if(P===0)continue;const se=(s.c[Q*r+S]??0)+((s.c[$*r+S]??0)<<2)+(s.c[K*r+S]??0),B=Math.abs(3*((c[G*r+S]??0)+(c[X*r+S]??0))-se),N=Math.abs(3*((h[I*r+S]??0)+(h[w*r+S]??0))-se);B>23&&(P&1)!==0&&(f+=B),N>23&&(P&1)!==0&&(p+=N),B>42&&(P&2)!==0&&(l+=B),N>42&&(P&2)!==0&&(E+=N),B>42&&(P&4)!==0&&(d+=B),N>42&&(P&4)!==0&&(g+=N)}}l<500&&E<500&&(d>=500||g>=500)&&Math.max(d,g)>3*Math.min(d,g)&&(l=d,E=g);const x=Math.floor(f/6+.5),C=Math.floor(p/6+.5),b=Math.floor(l/6+.5),m=Math.floor(E/6+.5),z=Math.max(x,C)/Math.max(Math.min(x,C),1),H=Math.max(b,m)/Math.max(Math.min(b,m),1),W=Math.max(b,m)/Math.max(Math.max(x,C),1);return(b>=500||m>=500)&&(b*2<m||m*2<b)||(b>=1e3||m>=1e3)&&(b*3<m*2||m*3<b*2)||(b>=2e3||m>=2e3)&&(b*5<m*4||m*5<b*4)||(b>=4e3||m>=4e3)&&H>z||W>.005&&Math.max(b,m)>150&&(b*2<m||m*2<b)?b>m?t:e:x>C?t:e}static#oe(e,t,i,s,r){const n=Array.from({length:Math.ceil(s/2)},()=>new Uint8Array(i)),o=r===1?1:0;for(let h=0;h<n.length;h++){const v=Math.min(s-1,o+h*2),f=n[h];if(f)for(let l=0;l<i;l++)f[l]=Math.abs((e[v*i+l]??0)-(t[v*i+l]??0))}const a=new Uint8Array(i*s),c=r===1?3:2;for(let h=1;h<n.length-1;h++){const v=c+(h-1)*2;if(v>=s)break;const f=n[h];if(f)for(let l=1;l<i-1;l++){const d=f[l]??0;if(d<=3)continue;let p=0;for(let m=l-1;m<=l+1;m++)p+=(n[h-1]?.[m]??0)>3?1:0,p+=(n[h]?.[m]??0)>3?1:0,p+=(n[h+1]?.[m]??0)>3?1:0;if(p<=1)continue;const E=v*i+l;if(a[E]=1,d<=19)continue;p=0;let g=!1,x=!1;for(let m=l-1;m<=l+1;m++)(n[h-1]?.[m]??0)>19&&(p++,g=!0),(n[h]?.[m]??0)>19&&p++,(n[h+1]?.[m]??0)>19&&(p++,x=!0);if(p<=3)continue;if(g&&x){a[E]|=2;continue}let C=!1,b=!1;for(let m=Math.max(l-4,0);m<Math.min(l+5,i);m++)h!==1&&(n[h-2]?.[m]??0)>19&&(C=!0),(n[h-1]?.[m]??0)>19&&(g=!0),(n[h+1]?.[m]??0)>19&&(x=!0),h!==n.length-2&&(n[h+2]?.[m]??0)>19&&(b=!0);g&&(x||C)||x&&(g||b)?a[E]|=2:p>5&&(a[E]|=4)}}return a}static#w(e,t,i){const s=new Uint8Array(t*i),r=(o,a)=>e[Math.max(0,Math.min(i-1,a))*t+o]??0;for(let o=0;o<i;o++)for(let a=0;a<t;a++){const c=r(a,o),h=r(a,o===0?1:o-1),v=r(a,o===i-1?i-2:o+1),f=o<2?r(a,o===0?2:3):r(a,o-2),l=o+2>=i?r(a,o===i-1?i-3:i-4):r(a,o+2);(o===0?Math.abs(c-v)>y.COMB_THRESHOLD:o===i-1?Math.abs(c-h)>y.COMB_THRESHOLD:Math.abs(c-h)>y.COMB_THRESHOLD&&Math.abs(c-v)>y.COMB_THRESHOLD)&&Math.abs(4*c-3*(h+v)+f+l)>y.COMB_THRESHOLD*6&&(s[o*t+a]=255)}let n=0;for(const o of[0,8])for(const a of[0,8])for(let c=o;c<i;c+=16)for(let h=a;h<t;h+=16){let v=0;for(let f=Math.max(1,c);f<Math.min(i-1,c+16);f++)for(let l=h;l<Math.min(t,h+16);l++){const d=f*t+l;s[d-t]===255&&s[d]===255&&s[d+t]===255&&v++}n=Math.max(n,v)}return n}static#le(e,t,i,s){const r=y.DECIMATE_BLOCK/2,n=Math.ceil(i/r),o=Math.ceil(s/r),a=new Float64Array(n*o),c=e.length/(i*s);for(let f=0;f<s;f++){const l=Math.floor(f/r);for(let d=0;d<i;d++){const p=Math.floor(d/r),E=l*n+p,g=(f*i+d)*c;if(c===1){a[E]=(a[E]??0)+Math.abs((e[g]??0)-(t[g]??0));continue}const x=Math.round((e[g]??0)*.2126+(e[g+1]??0)*.7152+(e[g+2]??0)*.0722),C=Math.round((t[g]??0)*.2126+(t[g+1]??0)*.7152+(t[g+2]??0)*.0722);if(a[E]=(a[E]??0)+Math.abs(x-C),(d&1)!==0||(f&1)!==0)continue;let b=0,m=0,z=0,H=0,W=0,_=0,R=0;for(let X=f;X<Math.min(f+2,s);X++)for(let I=d;I<Math.min(d+2,i);I++){const w=(X*i+I)*c;b+=e[w]??0,m+=e[w+1]??0,z+=e[w+2]??0,H+=t[w]??0,W+=t[w+1]??0,_+=t[w+2]??0,R++}const Q=Math.round((-.114572*b-.385428*m+.5*z)/R),$=Math.round((-.114572*H-.385428*W+.5*_)/R),K=Math.round((.5*b-.454153*m-.045847*z)/R),G=Math.round((.5*H-.454153*W-.045847*_)/R);a[E]=(a[E]??0)+Math.abs(Q-$)+Math.abs(K-G)}}let h=-1;for(let f=0;f<o-1;f++)for(let l=0;l<n-1;l++)h=Math.max(h,(a[f*n+l]??0)+(a[f*n+l+1]??0)+(a[(f+1)*n+l]??0)+(a[(f+1)*n+l+1]??0));let v=0;for(const f of a)v+=f;return{maxBlockDifference:h,totalDifference:v}}}let le=null;const ce=.5,T=3,q=5,L=q+1,J=1e3,V=4,j=200,fe=.25,ue=1e3/60,de=.02,me=250,pe=1e3/30;function Z(u){if(!Number.isFinite(u)||u<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return u}const ve=`#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`,ge=`#version 300 es
precision highp float;
uniform sampler2D uField;
uniform bool uFlip;
out vec4 fragColor;
void main() {
  ivec2 position = ivec2(gl_FragCoord.xy);
  if (uFlip) position.y = textureSize(uField, 0).y - 1 - position.y;
  fragColor = texelFetch(uField, position, 0);
}
`;class Ee extends EventTarget{#r;#i;#e;#s;#x;#n;#T;#O;#z;#C=null;#oe=null;#w=null;#le=null;#K=null;#qe=null;#L=null;#F=[];#g=[];#J=L-1;#f=null;#t=[];#_=null;#ce=0;#H=ue;#W=null;#xe;#R;#m;#X;#ye;#k="video";#Z="c";#Te=0;#Fe=!0;#Re=new y(M,k);#Me=1/0;#ke=1/0;#P=0;#l=0;#p=0;#y=0;#v=T-1;#o=0;#G=0;#ee=!1;#Y=null;#fe=0;#q=0;#Se=0;#u=!1;#ue=!1;#h=null;#V=[];#S=!1;#Ae;#d;#de;#U;#De;#a=null;#c;#me=!1;#Ce=0;#we=!1;#ut=0;#te=!1;#Le=!1;#j=null;#dt=0;#ie=new Map;#E={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0};#I=0;#_e=0;#pe=0;#B=0;#se=0;#re=0;#ne=0;#Q=0;constructor(e,t={},i=null){super(),this.#e=e,this.#R=t.doubleRate??!1,this.#m=t.autoFilm??!1,this.#X=Z(t.filmCombThreshold??y.COMBED_PIXEL_LIMIT),this.#ye=t.spatialCheck??!0,this.#Ae=t.onStats,this.#d=i,this.#U=i?"main":t.rendering??"auto",this.#De=t.workerUrl??le,this.#c=this.#U==="main"?"main":"idle",this.#i=i?i.canvas:document.createElement("canvas"),this.#r=i?.canvas??(this.#U==="main"?this.#i:document.createElement("canvas")),this.#de=e,i||(this.#i.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const s=this.#r.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!s)throw new Error("this browser has no WebGL2");this.#s=s,this.#x=O(s,ne);const r=this.#x;this.#n=Object.fromEntries(Object.entries(re).map(([n,o])=>[n,s.getUniformLocation(r,o)])),this.#T=O(s,ge),this.#O=s.getUniformLocation(this.#T,"uField"),this.#z=s.getUniformLocation(this.#T,"uFlip"),this.#m&&this.#Je(),this.#r.addEventListener("webglcontextlost",this.#ft),this.#xe=i?null:new ResizeObserver(()=>this.#be()),e.addEventListener("emptied",this.#ot),e.addEventListener("resize",this.#at),e.addEventListener("pause",this.#D),e.addEventListener("ended",this.#D),e.addEventListener("seeking",this.#ct),e.addEventListener("seeked",this.#D),e.addEventListener("ratechange",this.#D)}get running(){return this.#u&&(this.#h?.interlaced??!0)}get canvas(){return this.#i}get#ve(){return this.#h?.topFieldFirst!==!1}#Ve(){return{doubleRate:this.#R,autoFilm:this.#m,filmCombThreshold:this.#X,spatialCheck:this.#ye}}get enabled(){return this.#ue}set enabled(e){this.#ue=e,this.#Ue(),this.#a?.postMessage({type:"enabled",enabled:e})}set scan(e){const t=this.#h?.interlaced!==e?.interlaced,i=t||this.#h?.topFieldFirst!==e?.topFieldFirst;this.#h=e,this.#a?.postMessage({type:"scan",scan:e}),i&&(this.#o=0,this.#b(),t&&(this.#l=0),this.#f=null,this.#M(!1)),this.#Ue(),i&&(e?.interlaced??!0?this.#N():this.#He())}get scan(){return this.#h}set videoTimeline(e){this.#V=e,this.#a?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#h=null),this.#Ue()}get videoTimeline(){return this.#V}get container(){return this.#W??this.#e}get doubleRate(){return this.#R}set doubleRate(e){e!==this.#R&&(this.#R=e,this.#Pe(),this.#t.length=0,e?(this.#p>0&&this.#Ge(),(this.#h?.interlaced??!0)&&this.#N()):this.#m||(this.#f=null,this.#M(!1),this.#$()))}get autoFilm(){return this.#m}set autoFilm(e){e!==this.#m&&(this.#m=e,this.#Pe(),this.#b(),e?(this.#Je(),this.#p>0&&(this.#ht(),this.#Ge()),(this.#h?.interlaced??!0)&&this.#N()):(this.#Xe(),this.#R||(this.#f=null,this.#M(!1),this.#$())))}get filmCombThreshold(){return this.#X}set filmCombThreshold(e){const t=Z(e);t!==this.#X&&(this.#X=t,this.#Pe(),this.#m&&this.#b())}#Pe(){this.#a?.postMessage({type:"settings",options:this.#Ve()})}#Ue(){this.#ue&&(this.#V.length>0||(this.#h?.interlaced??!0))?this.start():this.stop()}#mt(){return this.#d||this.#U==="main"?!1:this.#c==="starting"||this.#c==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#De!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#je(),!0):this.#U==="auto"?(this.#Ie(),!1):(this.#c="failed",this.#u=!1,!0)}#je(){this.#A(),this.#a?.terminate(),this.#a=null,this.#te=!1,this.#Le=!1;let e=this.#i;if(this.#we){e=document.createElement("canvas"),e.className=this.#i.className;const r=this.#i.getAttribute("style");r===null?e.removeAttribute("style"):e.setAttribute("style",r),e.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(e),this.#i=e}const t=++this.#Ce;this.#c="starting";let i,s;try{s=e.transferControlToOffscreen(),this.#we=!0,i=new Worker(this.#De,{type:"module"})}catch(r){this.#he(r instanceof Error?r.message:String(r));return}this.#a=i,i.onmessage=r=>{t===this.#Ce&&this.#pt(r.data)},i.onerror=r=>{t===this.#Ce&&(r.preventDefault(),this.#he(r.message||"the deinterlacer worker failed"))},i.postMessage({type:"initialize",canvas:s,options:this.#Ve(),scan:this.#h,videoTimeline:this.#V,enabled:this.#ue,video:this.#Be()},[s])}#pt(e){switch(e.type){case"ready":this.#c="active",this.#u&&(this.#ge(),(this.#h?.interlaced??!0)&&this.#N());break;case"failed":this.#he(e.message);break;case"consumed":{this.#te=!1,this.#Le=!0;const t=this.#j;this.#j=null,t&&this.#$e(t);break}case"visibility":this.#i.style.visibility=e.visible?"visible":"hidden";break;case"size":this.#i.width=e.width,this.#i.height=e.height;break;case"stats":{const t={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0};this.dispatchEvent(new CustomEvent("stats",{detail:t})),this.#Ae?.(t);break}case"capture":{const t=this.#ie.get(e.id);if(this.#ie.delete(e.id),!t){e.image?.close();break}e.image?t.resolve(e.image):createImageBitmap(this.#e).then(t.resolve,t.reject);break}}}#he(e){if(this.#c==="starting"&&this.#U==="auto"&&!this.#me){this.#Ie();return}if(this.#Qe(e),!this.#me){this.#me=!0,this.#je();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#c="failed",this.#a?.terminate(),this.#a=null,this.#A(),this.stop()}#Ie(){const e=this.#r;e.className=this.#i.className;const t=this.#i.getAttribute("style");t===null?e.removeAttribute("style"):e.setAttribute("style",t),e.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(e),this.#i=e,this.#we=!1,this.#a?.terminate(),this.#a=null,this.#c="main",this.#A(),this.#u&&(this.#ge(),(this.#h?.interlaced??!0)&&this.#N())}#A(){this.#j?.frame.close(),this.#j=null}#Qe(e){for(const t of this.#ie.values())t.reject(new Error(e));this.#ie.clear()}start(){this.#u||this.#S||(this.#u=!0,this.#lt(),this.#b(),this.#fe=performance.now(),this.#Se=this.#fe,this.#q=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#At(),!this.#mt()&&(this.#ge(),(this.#h?.interlaced??!0)&&this.#N()))}stop(){this.#u&&(this.#u=!1,this.#Y!==null&&this.#e.cancelVideoFrameCallback(this.#Y),this.#Y=null,this.#He(),this.#o=0,this.#f=null,this.#M(!1),this.#A(),this.#a?.postMessage({type:"enabled",enabled:!1}))}destroy(){this.stop(),this.#a?.postMessage({type:"destroy"}),this.#a?.terminate(),this.#a=null,this.#A(),this.#Qe("the deinterlacer was destroyed"),this.#r.removeEventListener("webglcontextlost",this.#ft),this.#e.removeEventListener("emptied",this.#ot),this.#e.removeEventListener("resize",this.#at),this.#e.removeEventListener("pause",this.#D),this.#e.removeEventListener("ended",this.#D),this.#e.removeEventListener("seeking",this.#ct),this.#e.removeEventListener("seeked",this.#D),this.#e.removeEventListener("ratechange",this.#D),this.#Dt();for(const e of this.#F)this.#s.deleteTexture(e);this.#F=[],this.#$(),this.#Xe(),this.#s.deleteProgram(this.#x),this.#s.deleteProgram(this.#T),this.#C&&this.#s.deleteProgram(this.#C),this.#w&&this.#s.deleteProgram(this.#w),this.#K&&this.#s.deleteProgram(this.#K),this.#s.getExtension("WEBGL_lose_context")?.loseContext()}capture(){if(this.#c==="active"&&this.#i.style.visibility==="visible"&&this.#a){const s=++this.#dt,r=new Promise((n,o)=>{this.#ie.set(s,{resolve:n,reject:o})});return this.#a.postMessage({type:"capture",id:s,width:this.#e.videoWidth,height:this.#e.videoHeight}),r}if(this.#c==="starting"||this.#c==="failed")return createImageBitmap(this.#e);const e=this.#f;if(this.#d&&(!this.#u||this.#S||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#u||this.#S||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#We(e.texture,e.flip,!1):e.kind==="yadif"?this.#ae(e.flush,e.second,null,!1):this.#Oe(null,!1);const t=this.#e.videoWidth,i=this.#e.videoHeight;return t>0&&i>0&&(t!==this.#r.width||i!==this.#r.height)?createImageBitmap(this.#r,{resizeWidth:t,resizeHeight:i,resizeQuality:"high"}):createImageBitmap(this.#r)}addEventListener(e,t,i){super.addEventListener(e,t,i)}removeEventListener(e,t,i){super.removeEventListener(e,t,i)}#ge(){this.#d||!this.#u||this.#Y!==null||(this.#Y=this.#e.requestVideoFrameCallback(this.#gt))}#Be(){const e=[];for(let t=0;t<this.#e.buffered.length;t++)e.push({start:this.#e.buffered.start(t),end:this.#e.buffered.end(t)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#vt(e,t){let i;try{i=new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(t.mediaTime*1e6))})}catch(r){this.#he(r instanceof Error?r.message:String(r));return}const s={id:++this.#ut,frame:i,now:e,metadata:t,video:this.#Be()};if(this.#te){this.#j?.frame.close(),this.#j=s;return}this.#$e(s)}#$e(e){const t=this.#a;if(!t||this.#c!=="active"){e.frame.close();return}this.#te=!0;const i={type:"frame",...e};try{t.postMessage(i,[e.frame])}catch(s){this.#te=!1,e.frame.close();const r=s instanceof Error?s.message:String(s);this.#U==="auto"&&!this.#Le&&!this.#me?(this.#Ie(),this.#Ne(e.now,e.metadata)):this.#he(r)}}#gt=(e,t)=>{this.#Y=null,!(!this.#u||this.#S)&&(this.#fe=e,this.#q=Math.max(this.#q,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0),this.#Ke(e,t),this.#ge())};#Ke(e,t){if(this.#c==="active"){this.#vt(e,t);return}this.#c!=="starting"&&this.#Ne(e,t)}ingestExternalFrame(e,t,i){this.#de=i;try{this.#Ne(e,t)}finally{this.#de=this.#e}}#Ne(e,t){if(this.#Et(t.mediaTime),t.width>0&&t.height>0){let i=!1;if(!this.#ee&&this.#e.seeking){const l=this.#e.buffered,d=this.#l>=V?this.#l/1e3:j/1e3;for(let p=0;p<l.length;p++)if(t.mediaTime>=l.start(p)&&t.mediaTime<l.end(p)&&Math.abs(t.mediaTime-this.#e.currentTime)<=d){i=!0;break}}if(i&&(this.#ee=!0),(this.#p===0||this.#y===0)&&this.#nt(t.width,t.height),this.#h&&!this.#h.interlaced){this.#Mt();return}const s=t.mediaTime-this.#G,r=i||s<0||s>ce;r&&(this.#o=0,this.#l=0,this.#E.discontinuities++,this.#t.length=0,this.#b());const n=this.#m&&this.#I!==0&&t.presentedFrames-this.#I>1;if(this.#kt(t.presentedFrames,r),!r&&n&&(this.#o=0,this.#b()),this.#o>0&&t.mediaTime===this.#G)return;!r&&s>0&&this.#bt(s),this.#G=t.mediaTime;const o=performance.now();o-this.#_e>J&&(this.#pe=o,this.#B=0,this.#se=0,this.#re=0,this.#ne=0,this.#Q=0,this.#P=0),this.#_e=o;const a=performance.now();this.#rt();const c=this.#k,h=this.#m&&this.#o===T&&this.#xt();if(c!==this.#k&&(this.#t.length=0),!(h&&this.#Ee()))if(this.#m&&!this.#Fe&&this.#k==="film")if(this.#Ee()){const l=this.#l*5/4,d=this.#et(1,e,l),p=this.#t.at(-1),E=d?e:p==null?e+l:p.at+p.duration;this.#yt(E,l)}else this.#Oe(null);else if(this.#R&&this.#Ee()){const l=this.#l/2,d=this.#et(2,e,l),p=this.#t.at(-1),E=d?e:p==null?e+l*2:p.at+p.duration;this.#Ze(!1,E,l),this.#Ze(!0,E+l,l)}else this.#E.late+=this.#t.length,this.#t.length=0,this.#ae(!1,!1,null);this.#Q=Math.max(this.#Q,this.#t.length),this.#se+=performance.now()-a,this.#B++,this.#St(o)}}#Et(e){let t;for(let r=this.#V.length-1;r>=0;r--){const n=this.#V[r];if(n.start<=e+1e-6){t=n;break}}t?.codedSize&&(t.codedSize.width!==this.#p||t.codedSize.height!==this.#y)&&this.#nt(t.codedSize.width,t.codedSize.height);const i=t?.scan;if(!i||this.#h?.interlaced===i.interlaced&&this.#h.topFieldFirst===i.topFieldFirst)return;const s=this.#h?.interlaced;this.#h=i,this.#o=0,this.#t.length=0,this.#b(),s!==i.interlaced&&(this.#l=0),i.interlaced?this.#N():this.#He()}#Ee(){return(this.#R||this.#m)&&this.#l>0&&this.#g.length===L}#bt(e){const t=e*1e3/(this.#e.playbackRate||1),i=this.#l>0?Math.max(1,Math.round(t/this.#l)):1,s=t/i;s<V||s>j||(this.#l=this.#l>0?this.#l+(s-this.#l)*fe:s)}#Je(){if(this.#C&&this.#w&&this.#K)return;const e=this.#s,t=O(e,he),i=O(e,ae),s=O(e,oe);this.#C=t,this.#oe=Object.fromEntries(Object.entries(Y).filter(([r])=>r!=="match"&&r!=="topFieldFirst").map(([r,n])=>[r,e.getUniformLocation(t,n)])),this.#w=i,this.#le=Object.fromEntries(Object.entries(Y).map(([r,n])=>[r,e.getUniformLocation(i,n)])),this.#K=s,this.#qe=Object.fromEntries(Object.entries(Y).map(([r,n])=>[r,e.getUniformLocation(s,n)]))}#xt(){const e=this.#L,t=this.#C,i=this.#oe,s=this.#K,r=this.#qe;if(!e||!t||!i||!s||!r)return!1;const n=this.#s,o=this.#v,a=(this.#v+T-1)%T,c=(this.#v+1)%T,h=this.#ve;n.bindFramebuffer(n.FRAMEBUFFER,e.framebuffer),n.useProgram(t);for(const[g,x]of[c,a,o].entries())n.activeTexture(n.TEXTURE0+g),n.bindTexture(n.TEXTURE_2D,this.#F[x]??null);n.uniform1i(i.prev,0),n.uniform1i(i.cur,1),n.uniform1i(i.next,2),n.uniform2i(i.size,this.#p,this.#y),n.viewport(0,0,M,k),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,M,k,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const{previousLuma:v,currentLuma:f,nextLuma:l}=e;for(let g=0;g<v.length;g++){const x=g*4;v[g]=e.pixels[x]??0,f[g]=e.pixels[x+1]??0,l[g]=e.pixels[x+2]??0}const d=this.#Re.fieldMatch(v,f,l,h,this.#X);n.useProgram(s),n.uniform1i(r.prev,0),n.uniform1i(r.cur,1),n.uniform1i(r.next,2),n.uniform2i(r.size,this.#p,this.#y),n.uniform1i(r.topFieldFirst,h?1:0),n.uniform1i(r.match,d.match==="p"?0:d.match==="c"?1:2),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,M,k,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const p=this.#Re.decimate(e.pixels);this.#Z=d.match,this.#Te=d.combScore,this.#Fe=d.isCombed,this.#Me=p.lowestCycleDifference,this.#ke=p.runnerUpCycleDifference;const E=p.dropIndex!==null&&!d.isCombed;return(E?"film":"video")!==this.#k&&(this.#k=E?"film":"video"),p.shouldDrop&&!d.isCombed}#yt(e,t){const i=this.#ze();if(i===null)return;const s=this.#g[i];if(s){for(this.#J=i;this.#t.length>0&&this.#t[0]?.slot===i;)this.#t.shift(),this.#E.late++;this.#Oe(s.framebuffer),this.#t.push({slot:i,at:e,duration:t})}}#Oe(e,t=!0){const i=this.#w,s=this.#le;if(!i||!s)return;const r=this.#s,n=this.#v,o=(this.#v+T-1)%T,a=(this.#v+1)%T,c=this.#ve;r.bindFramebuffer(r.FRAMEBUFFER,e),r.useProgram(i);for(const[h,v]of[a,o,n].entries())r.activeTexture(r.TEXTURE0+h),r.bindTexture(r.TEXTURE_2D,this.#F[v]??null);r.uniform1i(s.prev,0),r.uniform1i(s.cur,1),r.uniform1i(s.next,2),r.uniform2i(s.size,this.#p,this.#y),r.uniform1i(s.topFieldFirst,c?1:0),r.uniform1i(s.match,this.#Z==="p"?0:this.#Z==="c"?1:2),r.viewport(0,0,this.#p,this.#y),r.drawArrays(r.TRIANGLES,0,3),e===null&&(this.#f={kind:"film"},this.#M(!0),t&&this.#P++)}#Ze(e,t,i){const s=this.#ze();if(s===null)return;const r=this.#g[s];if(r){for(this.#J=s;this.#t.length>0&&this.#t[0]?.slot===s;)this.#t.shift(),this.#E.late++;this.#ae(!1,e,r.framebuffer),this.#t.push({slot:s,at:t,duration:i})}}#et(e,t,i){const s=this.#t.at(-1),r=(q+1)*Math.max(this.#H,i);if(s&&s.at-t>r)return this.#t.length=0,this.#E.queueResetted++,!0;const n=Math.max(0,this.#t.length+e-q);let o=0,a=0;for(;a<n;){const c=this.#t.shift();if(!c)break;o+=c.duration,a++}for(const c of this.#t)c.at-=o;return this.#E.late+=a,!1}#ze(){const e=this.#f?.kind==="texture"?this.#f.texture:null,t=new Set(this.#t.map(({slot:s})=>s));for(let s=1;s<=L;s++){const r=(this.#J+s)%L,n=this.#g[r];if(n&&n.texture!==e&&!t.has(r))return r}const i=this.#t[0];if(i){const s=this.#g[i.slot];if(s&&s.texture!==e)return i.slot}return null}#N(){this.#_===null&&(!this.#u||this.#S||(this.#ce=0,this.#_=this.#it(this.#tt)))}#He(){this.#_!==null&&this.#Tt(this.#_),this.#_=null,this.#t.length=0}#tt=e=>{if(this.#_=null,!(!this.#u||this.#S)){if(this.#ce>0){const t=e-this.#ce;t>=1&&t<=j&&(this.#H=t<this.#H?t:this.#H+(t-this.#H)*de)}this.#ce=e,this.#Ft(e),this.#c==="main"&&this.#Rt(e),this.#_=this.#it(this.#tt)}};#it(e){return this.#d?this.#d.requestAnimationFrame(e):requestAnimationFrame(e)}#Tt(e){this.#d?this.#d.cancelAnimationFrame(e):cancelAnimationFrame(e)}#Ft(e){if(this.#d||e-this.#fe<me||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const t=this.#e.currentTime,i=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,s=this.#l>=V?this.#l:pe,r=i>this.#q,n=t>this.#G&&e-this.#Se>=s*.75;!r&&!n||(this.#q=Math.max(this.#q,i),this.#Se=e,this.#Ke(e,{mediaTime:t,presentedFrames:Math.max(this.#I+1,i),width:this.#e.videoWidth,height:this.#e.videoHeight}))}#Rt(e){const t=e+this.#H*1.5;for(;this.#t[1]&&this.#t[1].at<=t;)this.#E.late++,this.#t.shift();let i=this.#t[0];if(!i||i.at>t)return;this.#t.shift();const s=performance.now();this.#st(i.slot),this.#ne+=performance.now()-s,this.#re++}#st(e){const t=this.#g[e];t&&this.#We(t.texture)}#Mt(){this.#rt();const e=this.#F[this.#v];e&&this.#We(e,!0),this.#o=0}#M(e){if(this.#d){this.#d.onVisibility(e);return}this.#i.style.visibility=e?"visible":"hidden"}#We(e,t=!1,i=!0){const s=this.#s;s.bindFramebuffer(s.FRAMEBUFFER,null),s.useProgram(this.#T),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,e),s.uniform1i(this.#O,0),s.uniform1i(this.#z,t?1:0),s.viewport(0,0,this.#p,this.#y),s.drawArrays(s.TRIANGLES,0,3),this.#f={kind:"texture",texture:e,flip:t},this.#M(!0),i&&this.#P++}#kt(e,t){this.#I!==0&&!t&&(this.#E.missed+=Math.max(0,e-this.#I-1)),this.#I=e}#St(e){const t=e-this.#pe;if(t<J)return;const i=this.#Ee()&&(this.#R||this.#k==="film")?this.#re:this.#B,s={...this.#E,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:i*1e3/t,frameMs:this.#B===0?0:(this.#se+this.#ne)/this.#B,maxQueuedFields:this.#Q,mode:this.#k,match:this.#Z,combScore:this.#Te,outputFps:this.#P*1e3/t,duplicateScore:this.#Me,duplicateRunnerUp:this.#ke};this.dispatchEvent(new CustomEvent("stats",{detail:s})),this.#Ae?.(s),this.#pe=e,this.#B=0,this.#se=0,this.#re=0,this.#ne=0,this.#Q=0,this.#P=0}#rt(){const e=this.#s;this.#v=(this.#v+1)%T,e.bindTexture(e.TEXTURE_2D,this.#F[this.#v]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#de),this.#o=Math.min(this.#o+1,T)}#ae(e,t,i,s=!0){if(this.#o===0||this.#S)return;s&&(this.#o===T&&!e?this.#E.filtered++:this.#E.degraded++);const r=this.#s,n=this.#v,o=(this.#v+T-1)%T,a=(this.#v+1)%T;let c,h,v;this.#o===1?c=h=v=n:e?(c=o,h=v=n):this.#o===2?(c=h=o,v=n):(c=a,h=o,v=n),r.bindFramebuffer(r.FRAMEBUFFER,i),r.useProgram(this.#x);for(const[l,d]of[c,h,v].entries())r.activeTexture(r.TEXTURE0+l),r.bindTexture(r.TEXTURE_2D,this.#F[d]??null);r.uniform1i(this.#n.prev,0),r.uniform1i(this.#n.cur,1),r.uniform1i(this.#n.next,2),r.uniform2i(this.#n.size,this.#p,this.#y);const f=this.#ve?0:1;r.uniform1i(this.#n.parity,t?1-f:f),r.uniform1i(this.#n.tff,this.#ve?1:0),r.uniform1i(this.#n.spatialCheck,this.#ye?1:0),r.viewport(0,0,this.#p,this.#y),r.drawArrays(r.TRIANGLES,0,3),i===null&&(this.#f={kind:"yadif",flush:e,second:t},this.#M(!0),s&&this.#P++)}#be(){if(!this.#W)return;const e=this.#e,t=e.videoWidth,i=e.videoHeight;if(t===0||i===0)return;const s=Math.min(e.offsetWidth/t,e.offsetHeight/i),r=t*s,n=i*s;this.#i.style.left=`${e.offsetLeft+(e.offsetWidth-r)/2}px`,this.#i.style.top=`${e.offsetTop+(e.offsetHeight-n)/2}px`,this.#i.style.width=`${r}px`,this.#i.style.height=`${n}px`}#nt(e,t){const i=this.#s;this.#r.width=e,this.#r.height=t,this.#d?.onSize(e,t),this.#p=e,this.#y=t,this.#o=0,this.#f=null,this.#b(),this.#be();for(const s of this.#F)i.deleteTexture(s);this.#F=[];for(let s=0;s<T;s++){const r=i.createTexture();i.bindTexture(i.TEXTURE_2D,r),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,e,t,0,i.RGBA,i.UNSIGNED_BYTE,null),this.#F.push(r)}this.#$(),this.#Xe(),this.#m&&this.#ht(),(this.#R||this.#m)&&this.#Ge()}#ht(){if(this.#L)return;const e=this.#s,t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,M,k,0,e.RGBA,e.UNSIGNED_BYTE,null);const i=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,i),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const s=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!s){e.deleteFramebuffer(i),e.deleteTexture(t);return}this.#L={texture:t,framebuffer:i,pixels:new Uint8Array(M*k*4),previousLuma:new Uint8Array(M*k),currentLuma:new Uint8Array(M*k),nextLuma:new Uint8Array(M*k)}}#Xe(){this.#L&&(this.#s.deleteFramebuffer(this.#L.framebuffer),this.#s.deleteTexture(this.#L.texture),this.#L=null)}#Ge(){const e=this.#s;if(!(this.#g.length===L||this.#p===0)){this.#$();for(let t=0;t<L;t++){const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#p,this.#y,0,e.RGBA,e.UNSIGNED_BYTE,null);const s=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,s),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(s),e.deleteTexture(i),this.#$();return}this.#g.push({texture:i,framebuffer:s})}this.#J=L-1}}#$(){const e=this.#s,t=this.#f?.kind==="texture"?this.#f.texture:null;this.#g.some(i=>i.texture===t)&&(this.#f=null);for(const{texture:i,framebuffer:s}of this.#g)e.deleteFramebuffer(s),e.deleteTexture(i);this.#g=[],this.#t.length=0}#At(){if(this.#W)return;const e=this.#e.parentElement;if(!e)return;const t=document.createElement("div");t.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(t,this.#e),t.appendChild(this.#e),t.appendChild(this.#i),this.#W=t,this.#xe?.observe(this.#e),this.#be()}#Dt(){if(this.#d)return;const e=this.#W;this.#W=null,this.#xe?.disconnect(),this.#i.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#at=()=>this.#be();#Ye(e){return!this.#a||this.#c==="main"?!1:(this.#a.postMessage({type:"event",name:e,video:this.#Be()}),!0)}#ot=()=>{if(this.#Ye("emptied")){this.#A(),this.#M(!1);return}this.#o=0,this.#G=0,this.#t.length=0,this.#l=0,this.#lt(),this.#b(),this.#f=null,this.#M(!1)};#lt(){this.#E={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0},this.#I=0,this.#pe=0,this.#_e=0,this.#B=0,this.#se=0,this.#re=0,this.#ne=0,this.#Q=0,this.#P=0,this.#b()}#b(){this.#t.length=0,this.#k="video",this.#Z="c",this.#Te=0,this.#Fe=!0,this.#Re.reset(),this.#Me=1/0,this.#ke=1/0}#ct=()=>{if(this.#Ye("seeking")){this.#A();return}this.#ee=!1};#D=e=>{if((e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#Ye(e.type)){this.#A();return}if(e.type==="seeked"){const i=this.#ee;if(this.#ee=!1,i)return;this.#o=0,this.#b(),this.#f=null,this.#M(!1);return}const t=e.type==="ratechange";if(t&&(this.#l=0,this.#G=this.#e.currentTime),this.#t.length=0,this.#u&&this.#o>0){const i=this.#ze(),s=i===null?void 0:this.#g[i];i!==null&&s?(this.#J=i,this.#ae(!0,!1,s.framebuffer),this.#st(i)):this.#ae(!0,!1,null)}t&&(this.#o=0,this.#b())};#ft=e=>{if(e.preventDefault(),this.#d){this.#d.onFailure("the deinterlacer WebGL context was lost");return}this.#c!=="active"&&(this.#S=!0,this.stop())}}function be(u,e,t,i,s,r,n,o){return new Ee(u,t,{canvas:e,onFailure:i,onVisibility:s,onSize:r,requestAnimationFrame:n,cancelAnimationFrame:o})}function O(u,e){const t=u.createProgram(),i=ee(u,u.VERTEX_SHADER,ve),s=ee(u,u.FRAGMENT_SHADER,e);if(u.attachShader(t,i),u.attachShader(t,s),u.linkProgram(t),u.deleteShader(i),u.deleteShader(s),!u.getProgramParameter(t,u.LINK_STATUS)){const r=u.getProgramInfoLog(t);throw u.deleteProgram(t),new Error(`the deinterlacer failed to link: ${r??"no reason given"}`)}return t}function ee(u,e,t){const i=u.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(u.shaderSource(i,t),u.compileShader(i),!u.getShaderParameter(i,u.COMPILE_STATUS)){const s=u.getShaderInfoLog(i);throw u.deleteShader(i),new Error(`the deinterlacer failed to compile: ${s??"no reason given"}`)}return i}const U=self;class xe extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#r=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#r=e.buffered}get buffered(){return{length:this.#r.length,start:e=>{const t=this.#r[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.start},end:e=>{const t=this.#r[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let A=null,F=null,te=!1;function ye(u){return U.requestAnimationFrame(u)}function Te(u){U.cancelAnimationFrame(u)}function D(u,e=[]){U.postMessage(u,e)}function Fe(u,e){u.doubleRate=e.doubleRate,u.autoFilm=e.autoFilm,u.filmCombThreshold=e.filmCombThreshold}U.onmessage=u=>{const e=u.data;try{if(e.type==="initialize"){if(typeof U.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");A=new xe,A.update(e.video),F=be(A,e.canvas,e.options,t=>{te||D({type:"failed",message:t})},t=>D({type:"visibility",visible:t}),(t,i)=>D({type:"size",width:t,height:i}),ye,Te),F.addEventListener("stats",t=>{const{dropped:i,...s}=t.detail;D({type:"stats",stats:s})}),F.scan=e.scan,F.videoTimeline=e.videoTimeline,F.enabled=e.enabled,D({type:"ready"});return}if(!A||!F)return;switch(e.type){case"frame":A.update(e.video);try{F.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),D({type:"consumed",id:e.id})}break;case"settings":Fe(F,e.options);break;case"scan":F.scan=e.scan;break;case"timeline":F.videoTimeline=e.videoTimeline;break;case"enabled":F.enabled=e.enabled;break;case"event":A.update(e.video),A.dispatchEvent(new Event(e.name));break;case"capture":A.videoWidth=e.width,A.videoHeight=e.height,F.capture().then(t=>D({type:"capture",id:e.id,image:t},[t])).catch(()=>D({type:"capture",id:e.id,image:null}));break;case"destroy":te=!0,F.destroy(),F=null,A=null,U.close();break}}catch(t){const i=t instanceof Error?t.message:String(t);D({type:"failed",message:i})}}})();
//# sourceMappingURL=worker-BWAomwEu.js.map
