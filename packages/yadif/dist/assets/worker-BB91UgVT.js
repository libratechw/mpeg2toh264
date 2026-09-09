(function(){"use strict";const ae={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",parity:"uParity",tff:"uTff",spatialCheck:"uSpatialCheck"},oe=`#version 300 es
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
`,V={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",topFieldFirst:"uTopFieldFirst",match:"uMatch"},R=288,M=162,le=`#version 300 es
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
  ivec2 targetSize = ivec2(${R}, ${M});
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
`,fe=`#version 300 es
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
  ivec2 targetSize = ivec2(${R}, ${M});
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
`;class x{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#n;#i;#e;#s=0;#F=null;#l=[];#k=null;#q=1/0;#j=1/0;constructor(e,t){this.#n=e,this.#i=t,this.#e=255*x.DECIMATE_BLOCK**2*x.DUPLICATE_PERCENT/100}fieldMatch(e,t,i,s,r=x.COMBED_PIXEL_LIMIT){const n=s?1:0,u={p:e,c:t,n:i};let o=this.#N("c","p",n,u);const f=new Map,h=d=>{const E=f.get(d);if(E!==void 0)return E;const g=x.#B(this.weave(e,t,i,d,s),this.#n,this.#i);return f.set(d,g),g},v=h(o),l=h("n");(l*3<v||l*2<v&&v>r)&&Math.abs(l-v)>=30&&l<r&&(o="n");const a=h(o),p=a>=r;return p&&(o="c"),{match:o,combScore:a,isCombed:p,luma:this.weave(e,t,i,o,s)}}decimate(e){const t=this.#s,i=this.#k?x.#xe(this.#k,e,this.#n,this.#i):{maxBlockDifference:1/0,totalDifference:1/0};this.#l.push(i);const s=this.#F===t,r=s&&i.maxBlockDifference<this.#e;s&&!r&&(this.#F=null);const n=this.#F;this.#k=e.slice(),this.#s++;let u=this.#F;if(this.#s===x.CYCLE){let o=0,f=null;for(let h=1;h<this.#l.length;h++)(this.#l[h]?.maxBlockDifference??1/0)<(this.#l[o]?.maxBlockDifference??1/0)?(f=o,o=h):(f===null||(this.#l[h]?.maxBlockDifference??1/0)<(this.#l[f]?.maxBlockDifference??1/0))&&(f=h);this.#q=this.#l[o]?.maxBlockDifference??1/0,this.#j=f===null?1/0:this.#l[f]?.maxBlockDifference??1/0,u=(this.#l[o]?.maxBlockDifference??1/0)<this.#e?o:null,this.#F=u,this.#l=[],this.#s=0}return{cycleIndex:t,maxBlockDifference:i.maxBlockDifference,totalDifference:i.totalDifference,shouldDrop:r,dropIndex:n,nextDropIndex:u,lowestCycleDifference:this.#q,runnerUpCycleDifference:this.#j}}weave(e,t,i,s,r){if(s==="c")return t.slice();const n=t.slice(),u=s==="p"?e:i,o=n.length/this.#i,f=r?1:0;for(let h=f;h<this.#i;h+=2)n.set(u.subarray(h*o,(h+1)*o),h*o);return n}reset(){this.#s=0,this.#F=null,this.#l=[],this.#k=null,this.#q=1/0,this.#j=1/0}#N(e,t,i,s){const r=this.#n,n=this.#i,u=2-i,o=2-i,f=s[e],h=s[t],v=x.#ye(f,h,r,n,i);let l=0,a=0,p=0,d=0,E=0,g=0;for(let L=2;L<n-2;L+=2){const S=(L-2)/2,Q=u-1+S*2,$=u+1+S*2,K=u+3+S*2,Y=u+S*2,H=Y+2,I=o+S*2,D=I+2,ne=u+S*2;for(let k=8;k<r-8;k++){const P=(v[ne*r+k]??0)|(v[(ne+2)*r+k]??0);if(P===0)continue;const he=(s.c[Q*r+k]??0)+((s.c[$*r+k]??0)<<2)+(s.c[K*r+k]??0),N=Math.abs(3*((f[Y*r+k]??0)+(f[H*r+k]??0))-he),B=Math.abs(3*((h[I*r+k]??0)+(h[D*r+k]??0))-he);N>23&&(P&1)!==0&&(l+=N),B>23&&(P&1)!==0&&(d+=B),N>42&&(P&2)!==0&&(a+=N),B>42&&(P&2)!==0&&(E+=B),N>42&&(P&4)!==0&&(p+=N),B>42&&(P&4)!==0&&(g+=B)}}a<500&&E<500&&(p>=500||g>=500)&&Math.max(p,g)>3*Math.min(p,g)&&(a=p,E=g);const y=Math.floor(l/6+.5),C=Math.floor(d/6+.5),b=Math.floor(a/6+.5),m=Math.floor(E/6+.5),W=Math.max(y,C)/Math.max(Math.min(y,C),1),z=Math.max(b,m)/Math.max(Math.min(b,m),1),G=Math.max(b,m)/Math.max(Math.max(y,C),1);return(b>=500||m>=500)&&(b*2<m||m*2<b)||(b>=1e3||m>=1e3)&&(b*3<m*2||m*3<b*2)||(b>=2e3||m>=2e3)&&(b*5<m*4||m*5<b*4)||(b>=4e3||m>=4e3)&&z>W||G>.005&&Math.max(b,m)>150&&(b*2<m||m*2<b)?b>m?t:e:y>C?t:e}static#ye(e,t,i,s,r){const n=Array.from({length:Math.ceil(s/2)},()=>new Uint8Array(i)),u=r===1?1:0;for(let h=0;h<n.length;h++){const v=Math.min(s-1,u+h*2),l=n[h];if(l)for(let a=0;a<i;a++)l[a]=Math.abs((e[v*i+a]??0)-(t[v*i+a]??0))}const o=new Uint8Array(i*s),f=r===1?3:2;for(let h=1;h<n.length-1;h++){const v=f+(h-1)*2;if(v>=s)break;const l=n[h];if(l)for(let a=1;a<i-1;a++){const p=l[a]??0;if(p<=3)continue;let d=0;for(let m=a-1;m<=a+1;m++)d+=(n[h-1]?.[m]??0)>3?1:0,d+=(n[h]?.[m]??0)>3?1:0,d+=(n[h+1]?.[m]??0)>3?1:0;if(d<=1)continue;const E=v*i+a;if(o[E]=1,p<=19)continue;d=0;let g=!1,y=!1;for(let m=a-1;m<=a+1;m++)(n[h-1]?.[m]??0)>19&&(d++,g=!0),(n[h]?.[m]??0)>19&&d++,(n[h+1]?.[m]??0)>19&&(d++,y=!0);if(d<=3)continue;if(g&&y){o[E]|=2;continue}let C=!1,b=!1;for(let m=Math.max(a-4,0);m<Math.min(a+5,i);m++)h!==1&&(n[h-2]?.[m]??0)>19&&(C=!0),(n[h-1]?.[m]??0)>19&&(g=!0),(n[h+1]?.[m]??0)>19&&(y=!0),h!==n.length-2&&(n[h+2]?.[m]??0)>19&&(b=!0);g&&(y||C)||y&&(g||b)?o[E]|=2:d>5&&(o[E]|=4)}}return o}static#B(e,t,i){const s=new Uint8Array(t*i);for(let n=0;n<i;n++){const u=n*t,o=Math.max(0,Math.min(i-1,n===0?1:n-1))*t,f=Math.max(0,Math.min(i-1,n===i-1?i-2:n+1))*t,h=Math.max(0,Math.min(i-1,n<2?n===0?2:3:n-2))*t,v=Math.max(0,Math.min(i-1,n+2>=i?n===i-1?i-3:i-4:n+2))*t;for(let l=0;l<t;l++){const a=e[u+l]??0,p=e[o+l]??0,d=e[f+l]??0,E=e[h+l]??0,g=e[v+l]??0;(n===0?Math.abs(a-d)>x.COMB_THRESHOLD:n===i-1?Math.abs(a-p)>x.COMB_THRESHOLD:Math.abs(a-p)>x.COMB_THRESHOLD&&Math.abs(a-d)>x.COMB_THRESHOLD)&&Math.abs(4*a-3*(p+d)+E+g)>x.COMB_THRESHOLD*6&&(s[n*t+l]=255)}}let r=0;for(const n of[0,8])for(const u of[0,8])for(let o=n;o<i;o+=16)for(let f=u;f<t;f+=16){let h=0;for(let v=Math.max(1,o);v<Math.min(i-1,o+16);v++)for(let l=f;l<Math.min(t,f+16);l++){const a=v*t+l;s[a-t]===255&&s[a]===255&&s[a+t]===255&&h++}r=Math.max(r,h)}return r}static#xe(e,t,i,s){const r=x.DECIMATE_BLOCK/2,n=Math.ceil(i/r),u=Math.ceil(s/r),o=new Float64Array(n*u),f=e.length/(i*s);for(let l=0;l<s;l++){const a=Math.floor(l/r);for(let p=0;p<i;p++){const d=Math.floor(p/r),E=a*n+d,g=(l*i+p)*f;if(f===1){o[E]=(o[E]??0)+Math.abs((e[g]??0)-(t[g]??0));continue}const y=Math.round((e[g]??0)*.2126+(e[g+1]??0)*.7152+(e[g+2]??0)*.0722),C=Math.round((t[g]??0)*.2126+(t[g+1]??0)*.7152+(t[g+2]??0)*.0722);if(o[E]=(o[E]??0)+Math.abs(y-C),(p&1)!==0||(l&1)!==0)continue;let b=0,m=0,W=0,z=0,G=0,L=0,S=0;for(let H=l;H<Math.min(l+2,s);H++)for(let I=p;I<Math.min(p+2,i);I++){const D=(H*i+I)*f;b+=e[D]??0,m+=e[D+1]??0,W+=e[D+2]??0,z+=t[D]??0,G+=t[D+1]??0,L+=t[D+2]??0,S++}const Q=Math.round((-.114572*b-.385428*m+.5*W)/S),$=Math.round((-.114572*z-.385428*G+.5*L)/S),K=Math.round((.5*b-.454153*m-.045847*W)/S),Y=Math.round((.5*z-.454153*G-.045847*L)/S);o[E]=(o[E]??0)+Math.abs(Q-$)+Math.abs(K-Y)}}let h=-1;for(let l=0;l<u-1;l++)for(let a=0;a<n-1;a++)h=Math.max(h,(o[l*n+a]??0)+(o[l*n+a+1]??0)+(o[(l+1)*n+a]??0)+(o[(l+1)*n+a+1]??0));let v=0;for(const l of o)v+=l;return{maxBlockDifference:h,totalDifference:v}}}let ue=null;const de=.5,T=3,q=5,w=q+1,J=1e3,j=4,X=200,me=.25,pe=1e3/60,ve=.02,ge=250,Ee=1e3/30,be=27,ye=22,Z=36,xe=.8,Te=250,Fe=3e3,ee=45,Se=.8,Re=300*1e3,Me=90;function te(c){if(!Number.isFinite(c)||c<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return c}const ke=`#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`,Ae=`#version 300 es
precision highp float;
uniform sampler2D uField;
uniform bool uFlip;
out vec4 fragColor;
void main() {
  ivec2 position = ivec2(gl_FragCoord.xy);
  if (uFlip) position.y = textureSize(uField, 0).y - 1 - position.y;
  fragColor = texelFetch(uField, position, 0);
}
`;function ie(c,e){for(let t=c.length-1;t>=0;t--){const i=c[t];if(i.start<=e+1e-6)return i}}class Ce extends EventTarget{#n;#i;#e;#s;#F;#l;#k;#q;#j;#N=null;#ye=null;#B=null;#xe=null;#he=null;#ht=null;#O=null;#A=[];#b=[];#ae=w-1;#m=null;#t=[];#W=null;#Te=0;#z=null;#Q=pe;#c=[];#S=0;#G=null;#$=null;#K=!1;#p="off";#at=0;#Ue=0;#J="unknown";#L=null;#Ie;#y;#v;#Z;#Ne;#C="video";#oe="c";#Be=0;#Oe=!0;#We=new x(R,M);#ze=1/0;#Ge=1/0;#H=0;#d=0;#g=0;#R=0;#E=T-1;#u=0;#le=0;#Fe=Number.NaN;#ce=!1;#ee=null;#Se=0;#te=0;#He=0;#h=!1;#Re=!1;#Me=!1;#f=null;#X=[];#M=!1;#Xe;#a;#ke;#P;#Ye;#o=null;#r;#fe=!1;#Ve=0;#qe=!1;#Dt=0;#ue=!1;#Ae=!1;#ie=null;#wt=0;#de=new Map;#x={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0};#Y=0;#je=0;#Ce=0;#V=0;#me=0;#pe=0;#ve=0;#se=0;constructor(e,t={},i=null){super(),this.#e=e,this.#y=t.doubleRate??!1,this.#v=t.autoFilm??!1,this.#Z=te(t.filmCombThreshold??x.COMBED_PIXEL_LIMIT),this.#Ne=t.spatialCheck??!0,this.#Xe=t.onStats,this.#a=i,this.#P=i?"main":t.rendering??"auto",this.#Ye=t.workerUrl??ue,this.#r=this.#P==="main"?"main":"idle",this.#i=i?i.canvas:document.createElement("canvas"),this.#n=i?.canvas??(this.#P==="main"?this.#i:document.createElement("canvas")),this.#ke=e,i||(this.#i.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const s=this.#n.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!s)throw new Error("this browser has no WebGL2");this.#s=s,this.#F=O(s,oe);const r=this.#F;this.#l=Object.fromEntries(Object.entries(ae).map(([n,u])=>[n,s.getUniformLocation(r,u)])),this.#k=O(s,Ae),this.#q=s.getUniformLocation(this.#k,"uField"),this.#j=s.getUniformLocation(this.#k,"uFlip"),this.#v&&this.#dt(),this.#n.addEventListener("webglcontextlost",this.#_t),this.#Ie=i?null:new ResizeObserver(()=>this.#Pe()),e.addEventListener("emptied",this.#kt),e.addEventListener("resize",this.#Mt),e.addEventListener("pause",this.#I),e.addEventListener("ended",this.#I),e.addEventListener("seeking",this.#Ct),e.addEventListener("seeked",this.#I),e.addEventListener("ratechange",this.#I),!i&&typeof document<"u"&&document.addEventListener("visibilitychange",this.#xt)}get running(){return this.#h&&(this.#f?.interlaced??!0)}get canvas(){return this.#i}get#_e(){return this.#f?.topFieldFirst!==!1}#ot(){return{doubleRate:this.#y,autoFilm:this.#v,filmCombThreshold:this.#Z,spatialCheck:this.#Ne}}get enabled(){return this.#Re}set enabled(e){this.#Re=e,this.#$e(),this.#o?.postMessage({type:"enabled",enabled:e})}set scan(e){const t=this.#f?.interlaced!==e?.interlaced,i=t||this.#f?.topFieldFirst!==e?.topFieldFirst;this.#f=e,this.#o?.postMessage({type:"scan",scan:e}),i&&(this.#u=0,this.#T(),t&&(this.#d=0),this.#m=null,this.#D(!1),e?.interlaced!==!0?this.#_(!0):t&&(this.#c.length=0,this.#S=0,this.#J="unknown")),this.#$e(),i&&((e?.interlaced??!0)&&(this.#a||this.#r==="main")?this.#re():this.#et())}get scan(){return this.#f}set videoTimeline(e){this.#X=e,this.#o?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#f=null),this.#$e()}get videoTimeline(){return this.#X}get container(){return this.#L??this.#e}get doubleRate(){return this.#y}set doubleRate(e){e!==this.#y&&(this.#y=e,this.#Qe(),this.#t.length=0,e||this.#_(!1),e?(this.#g>0&&this.#rt(),(this.#f?.interlaced??!0)&&(this.#a||this.#r==="main")&&this.#re()):this.#v||(this.#m=null,this.#D(!1),this.#ne()))}get autoFilm(){return this.#v}set autoFilm(e){e!==this.#v&&(this.#v=e,this.#Qe(),this.#T(),e?(this.#dt(),this.#g>0&&(this.#Rt(),this.#rt()),(this.#f?.interlaced??!0)&&(this.#a||this.#r==="main")&&this.#re()):(this.#st(),this.#y||(this.#m=null,this.#D(!1),this.#ne())))}get filmCombThreshold(){return this.#Z}set filmCombThreshold(e){const t=te(e);t!==this.#Z&&(this.#Z=t,this.#Qe(),this.#v&&this.#T())}#Qe(){this.#o?.postMessage({type:"settings",options:this.#ot()})}#$e(){this.#Re&&(this.#X.length>0||(this.#f?.interlaced??!0))?this.start():this.stop()}#Lt(){return this.#a||this.#P==="main"?!1:this.#r==="starting"||this.#r==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#Ye!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#lt(),!0):this.#P==="auto"?(this.#De(),!1):(this.#r="failed",this.#h=!1,!0)}#lt(){this.#U(),this.#o?.terminate(),this.#o=null,this.#ue=!1,this.#Ae=!1;let e=this.#i;if(this.#qe){e=document.createElement("canvas"),e.className=this.#i.className;const r=this.#i.getAttribute("style");r===null?e.removeAttribute("style"):e.setAttribute("style",r),e.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(e),this.#i=e}const t=++this.#Ve;this.#r="starting";let i,s;try{s=e.transferControlToOffscreen(),this.#qe=!0,i=new Worker(this.#Ye,{type:"module"})}catch(r){this.#ge(r instanceof Error?r.message:String(r));return}this.#o=i,i.onmessage=r=>{t===this.#Ve&&this.#Pt(r.data)},i.onerror=r=>{t===this.#Ve&&(r.preventDefault(),this.#ge(r.message||"the deinterlacer worker failed"))},i.postMessage({type:"initialize",canvas:s,options:this.#ot(),scan:this.#f,videoTimeline:this.#X,enabled:this.#h,video:this.#Ke()},[s])}#Pt(e){switch(e.type){case"ready":this.#r="active",this.#h&&(this.#Ee(),this.#tt());break;case"failed":this.#ge(e.message);break;case"consumed":{this.#ue=!1,this.#Ae=!0;const t=this.#ie;this.#ie=null,t&&this.#ft(t);break}case"visibility":this.#i.style.visibility=e.visible?"visible":"hidden";break;case"stats":{const t={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0};this.#J=e.stats.mode,this.dispatchEvent(new CustomEvent("stats",{detail:t})),this.#Xe?.(t);break}case"capture":{const t=this.#de.get(e.id);if(this.#de.delete(e.id),!t){e.image?.close();break}e.image?t.resolve(e.image):createImageBitmap(this.#e).then(t.resolve,t.reject);break}}}#ge(e){if(this.#_(!0),this.#r==="starting"&&this.#P==="auto"&&!this.#fe){this.#De();return}if(this.#ct(e),!this.#fe){this.#fe=!0,this.#lt();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#r="failed",this.#o?.terminate(),this.#o=null,this.#U(),this.stop()}#De(){this.#_(!0);const e=this.#n;e.className=this.#i.className;const t=this.#i.getAttribute("style");t===null?e.removeAttribute("style"):e.setAttribute("style",t),e.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(e),this.#i=e,this.#qe=!1,this.#o?.terminate(),this.#o=null,this.#r="main",this.#U(),this.#h&&(this.#Ee(),this.#tt(),(this.#f?.interlaced??!0)&&this.#re())}#U(){this.#ie?.frame.close(),this.#ie=null}#ct(e){for(const t of this.#de.values())t.reject(new Error(e));this.#de.clear()}start(){if(!(this.#h||this.#Me||this.#M)){if(this.#h=!0,this.#At(),this.#T(),this.#_(!0),this.#Se=performance.now(),this.#He=this.#Se,this.#Fe=Number.NaN,this.#te=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#si(),this.#tt(),this.#Lt()){this.#o?.postMessage({type:"enabled",enabled:!0}),this.#r==="active"&&this.#Ee();return}this.#Ee(),(this.#f?.interlaced??!0)&&this.#re()}}stop(){this.#h&&(this.#h=!1,this.#_(!1),this.#ee!==null&&this.#e.cancelVideoFrameCallback(this.#ee),this.#ee=null,this.#Gt(),this.#et(),this.#u=0,this.#m=null,this.#D(!1),this.#U(),this.#o?.postMessage({type:"enabled",enabled:!1}))}destroy(){if(!this.#Me){this.#Me=!0,this.#Re=!1,this.stop(),this.#_(!1),typeof document<"u"&&document.removeEventListener("visibilitychange",this.#xt),this.#o?.postMessage({type:"destroy"}),this.#o?.terminate(),this.#o=null,this.#U(),this.#ct("the deinterlacer was destroyed"),this.#n.removeEventListener("webglcontextlost",this.#_t),this.#e.removeEventListener("emptied",this.#kt),this.#e.removeEventListener("resize",this.#Mt),this.#e.removeEventListener("pause",this.#I),this.#e.removeEventListener("ended",this.#I),this.#e.removeEventListener("seeking",this.#Ct),this.#e.removeEventListener("seeked",this.#I),this.#e.removeEventListener("ratechange",this.#I),this.#ri();for(const e of this.#A)this.#s.deleteTexture(e);this.#A=[],this.#ne(),this.#st(),this.#s.deleteProgram(this.#F),this.#s.deleteProgram(this.#k),this.#N&&this.#s.deleteProgram(this.#N),this.#B&&this.#s.deleteProgram(this.#B),this.#he&&this.#s.deleteProgram(this.#he),this.#s.getExtension("WEBGL_lose_context")?.loseContext()}}capture(){if(this.#r==="active"&&this.#i.style.visibility==="visible"&&this.#o){const s=++this.#wt,r=new Promise((n,u)=>{this.#de.set(s,{resolve:n,reject:u})});return this.#o.postMessage({type:"capture",id:s,width:this.#e.videoWidth,height:this.#e.videoHeight}),r}if(this.#r==="starting"||this.#r==="failed")return createImageBitmap(this.#e);const e=this.#m;if(this.#a&&(!this.#h||this.#M||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#h||this.#M||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#it(e.texture,e.flip,!1):e.kind==="yadif"?this.#be(e.flush,e.second,null,!1):this.#Je(null,!1);const t=this.#e.videoWidth,i=this.#e.videoHeight;return t>0&&i>0&&(t!==this.#n.width||i!==this.#n.height)?createImageBitmap(this.#n,{resizeWidth:t,resizeHeight:i,resizeQuality:"high"}):createImageBitmap(this.#n)}addEventListener(e,t,i){super.addEventListener(e,t,i)}removeEventListener(e,t,i){super.removeEventListener(e,t,i)}#Ee(){this.#a||!this.#h||this.#ee!==null||(this.#ee=this.#e.requestVideoFrameCallback(this.#It))}#Ke(){const e=[];for(let t=0;t<this.#e.buffered.length;t++)e.push({start:this.#e.buffered.start(t),end:this.#e.buffered.end(t)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#Ut(e,t){let i;try{i=new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(t.mediaTime*1e6))})}catch(r){const n=r instanceof Error?r.message:String(r);this.#P==="auto"&&!this.#Ae&&!this.#fe?(this.#De(),this.#we(e,t)):this.#ge(n);return}const s={id:++this.#Dt,frame:i,now:e,metadata:t,video:this.#Ke()};if(this.#ue){this.#ie?.frame.close(),this.#ie=s;return}this.#ft(s)}#ft(e){const t=this.#o;if(!t||this.#r!=="active"){e.frame.close();return}this.#ue=!0;const i={type:"frame",...e};try{t.postMessage(i,[e.frame])}catch(s){this.#ue=!1,e.frame.close();const r=s instanceof Error?s.message:String(s);this.#P==="auto"&&!this.#Ae&&!this.#fe?(this.#De(),this.#we(e.now,e.metadata)):this.#ge(r)}}#It=(e,t)=>{this.#ee=null,!(!this.#h||this.#M)&&(this.#Se=e,this.#te=Math.max(this.#te,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0),this.#ut(e,t),this.#Ee())};#ut(e,t){if(this.#Fe=t.mediaTime,this.#r==="active"){this.#Ut(e,t);return}this.#r!=="starting"&&this.#we(e,t)}ingestExternalFrame(e,t,i){this.#ke=i;try{this.#we(e,t)}finally{this.#ke=this.#e}}#we(e,t){if(this.#Nt(t.mediaTime),t.width>0&&t.height>0){let i=!1;if(!this.#ce&&this.#e.seeking){const a=this.#e.buffered,p=this.#d>=j?this.#d/1e3:X/1e3;for(let d=0;d<a.length;d++)if(t.mediaTime>=a.start(d)&&t.mediaTime<a.end(d)&&Math.abs(t.mediaTime-this.#e.currentTime)<=p){i=!0;break}}if(i&&(this.#ce=!0),(this.#g===0||this.#R===0)&&this.#St(t.width,t.height),this.#f&&!this.#f.interlaced){this.#ei();return}const s=t.mediaTime-this.#le,r=i||s<0||s>de;r&&(this.#u=0,this.#d=0,this.#x.discontinuities++,this.#t.length=0,this.#T());const n=this.#v&&this.#Y!==0&&t.presentedFrames-this.#Y>1;if(this.#ti(t.presentedFrames,r),!r&&n&&(this.#u=0,this.#T()),this.#u>0&&t.mediaTime===this.#le)return;!r&&s>0&&this.#Bt(s),this.#le=t.mediaTime;const u=performance.now();u-this.#je>J&&(this.#Ce=u,this.#V=0,this.#me=0,this.#pe=0,this.#ve=0,this.#se=0,this.#H=0),this.#je=u;const o=performance.now();this.#Ft();const f=this.#C,h=this.#v&&this.#u===T&&this.#Ot();if(f!==this.#C&&(this.#t.length=0),!(h&&this.#Le()))if(this.#v&&!this.#Oe&&this.#C==="film")if(this.#Le()){const a=this.#d*5/4,p=this.#pt(1,e,a),d=this.#t.at(-1),E=p?e:d==null?e+a:d.at+d.duration;this.#Wt(E,a)}else this.#Je(null);else if(this.#y&&this.#Le()){const a=this.#d/2,p=this.#pt(2,e,a),d=this.#t.at(-1),E=p?e:d==null?e+a*2:d.at+d.duration;this.#mt(!1,E,a),this.#mt(!0,E+a,a)}else this.#x.late+=this.#t.length,this.#t.length=0,this.#be(!1,!1,null);this.#se=Math.max(this.#se,this.#t.length),this.#me+=performance.now()-o,this.#V++,this.#ii(u)}}#Nt(e){const t=ie(this.#X,e);t?.codedSize&&(t.codedSize.width!==this.#g||t.codedSize.height!==this.#R)&&this.#St(t.codedSize.width,t.codedSize.height);const i=t?.scan;if(!i||this.#f?.interlaced===i.interlaced&&this.#f.topFieldFirst===i.topFieldFirst)return;const s=this.#f?.interlaced;this.#f=i,this.#u=0,this.#t.length=0,this.#T(),s!==i.interlaced&&(this.#d=0),i.interlaced!==!0?this.#_(!0):s!==!0&&(this.#c.length=0,this.#S=0,this.#J="unknown"),i.interlaced&&(this.#a||this.#r==="main")?this.#re():this.#et()}#Le(){return(this.#y||this.#v)&&this.#d>0&&this.#b.length===w}#Bt(e){const t=e*1e3/(this.#e.playbackRate||1),i=this.#d>0?Math.max(1,Math.round(t/this.#d)):1,s=t/i;s<j||s>X||(this.#d=this.#d>0?this.#d+(s-this.#d)*me:s)}#dt(){if(this.#N&&this.#B&&this.#he)return;const e=this.#s,t=O(e,le),i=O(e,ce),s=O(e,fe);this.#N=t,this.#ye=Object.fromEntries(Object.entries(V).filter(([r])=>r!=="match"&&r!=="topFieldFirst").map(([r,n])=>[r,e.getUniformLocation(t,n)])),this.#B=i,this.#xe=Object.fromEntries(Object.entries(V).map(([r,n])=>[r,e.getUniformLocation(i,n)])),this.#he=s,this.#ht=Object.fromEntries(Object.entries(V).map(([r,n])=>[r,e.getUniformLocation(s,n)]))}#Ot(){const e=this.#O,t=this.#N,i=this.#ye,s=this.#he,r=this.#ht;if(!e||!t||!i||!s||!r)return!1;const n=this.#s,u=this.#E,o=(this.#E+T-1)%T,f=(this.#E+1)%T,h=this.#_e;n.bindFramebuffer(n.FRAMEBUFFER,e.framebuffer),n.useProgram(t);for(const[g,y]of[f,o,u].entries())n.activeTexture(n.TEXTURE0+g),n.bindTexture(n.TEXTURE_2D,this.#A[y]??null);n.uniform1i(i.prev,0),n.uniform1i(i.cur,1),n.uniform1i(i.next,2),n.uniform2i(i.size,this.#g,this.#R),n.viewport(0,0,R,M),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,R,M,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const{previousLuma:v,currentLuma:l,nextLuma:a}=e;for(let g=0;g<v.length;g++){const y=g*4;v[g]=e.pixels[y]??0,l[g]=e.pixels[y+1]??0,a[g]=e.pixels[y+2]??0}const p=this.#We.fieldMatch(v,l,a,h,this.#Z);n.useProgram(s),n.uniform1i(r.prev,0),n.uniform1i(r.cur,1),n.uniform1i(r.next,2),n.uniform2i(r.size,this.#g,this.#R),n.uniform1i(r.topFieldFirst,h?1:0),n.uniform1i(r.match,p.match==="p"?0:p.match==="c"?1:2),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,R,M,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const d=this.#We.decimate(e.pixels);this.#oe=p.match,this.#Be=p.combScore,this.#Oe=p.isCombed,this.#ze=d.lowestCycleDifference,this.#Ge=d.runnerUpCycleDifference;const E=d.dropIndex!==null&&!p.isCombed;return(E?"film":"video")!==this.#C&&(this.#C=E?"film":"video"),d.shouldDrop&&!p.isCombed}#Wt(e,t){const i=this.#Ze();if(i===null)return;const s=this.#b[i];if(s){for(this.#ae=i;this.#t.length>0&&this.#t[0]?.slot===i;)this.#t.shift(),this.#x.late++;this.#Je(s.framebuffer),this.#t.push({slot:i,at:e,duration:t})}}#Je(e,t=!0){const i=this.#B,s=this.#xe;if(!i||!s)return;const r=this.#s,n=this.#E,u=(this.#E+T-1)%T,o=(this.#E+1)%T,f=this.#_e;r.bindFramebuffer(r.FRAMEBUFFER,e),r.useProgram(i);for(const[h,v]of[o,u,n].entries())r.activeTexture(r.TEXTURE0+h),r.bindTexture(r.TEXTURE_2D,this.#A[v]??null);r.uniform1i(s.prev,0),r.uniform1i(s.cur,1),r.uniform1i(s.next,2),r.uniform2i(s.size,this.#g,this.#R),r.uniform1i(s.topFieldFirst,f?1:0),r.uniform1i(s.match,this.#oe==="p"?0:this.#oe==="c"?1:2),r.viewport(0,0,this.#g,this.#R),r.drawArrays(r.TRIANGLES,0,3),e===null&&(this.#m={kind:"film"},this.#D(!0),t&&this.#H++)}#mt(e,t,i){const s=this.#Ze();if(s===null)return;const r=this.#b[s];if(r){for(this.#ae=s;this.#t.length>0&&this.#t[0]?.slot===s;)this.#t.shift(),this.#x.late++;this.#be(!1,e,r.framebuffer),this.#t.push({slot:s,at:t,duration:i})}}#pt(e,t,i){const s=this.#t.at(-1),r=(q+1)*Math.max(this.#Q,i);if(s&&s.at-t>r)return this.#t.length=0,this.#x.queueResetted++,!0;const n=Math.max(0,this.#t.length+e-q);let u=0,o=0;for(;o<n;){const f=this.#t.shift();if(!f)break;u+=f.duration,o++}for(const f of this.#t)f.at-=u;return this.#x.late+=o,!1}#Ze(){const e=this.#m?.kind==="texture"?this.#m.texture:null,t=new Set(this.#t.map(({slot:s})=>s));for(let s=1;s<=w;s++){const r=(this.#ae+s)%w,n=this.#b[r];if(n&&n.texture!==e&&!t.has(r))return r}const i=this.#t[0];if(i){const s=this.#b[i.slot];if(s&&s.texture!==e)return i.slot}return null}#re(){this.#W===null&&(!this.#h||this.#M||(this.#Te=0,this.#W=this.#gt(this.#vt)))}#et(){this.#W!==null&&this.#zt(this.#W),this.#W=null,this.#t.length=0}#vt=e=>{if(this.#W=null,!(!this.#h||this.#M)){if(this.#Te>0){const t=e-this.#Te;t>=1&&t<=X&&(this.#Q=t<this.#Q?t:this.#Q+(t-this.#Q)*ve)}this.#Te=e,this.#r==="main"&&this.#Zt(e),this.#W=this.#gt(this.#vt)}};#gt(e){return this.#a?this.#a.requestAnimationFrame(e):requestAnimationFrame(e)}#zt(e){this.#a?this.#a.cancelAnimationFrame(e):cancelAnimationFrame(e)}#tt(){this.#a||this.#z!==null||!this.#h||this.#M||(this.#z=requestAnimationFrame(this.#Et))}#Gt(){this.#z!==null&&cancelAnimationFrame(this.#z),this.#z=null}#Et=e=>{this.#z=null,!(!this.#h||this.#M)&&(this.#Xt(e),this.#Jt(e),this.#z=requestAnimationFrame(this.#Et))};#Ht(e){return!(this.#a||typeof document>"u"||!this.#h||this.#Me||this.#M||this.#r!=="active"||!this.#y||this.#bt?.interlaced!==!0||this.#J!=="video"||this.#C==="film"||document.hidden||this.#e.paused||this.#e.ended||this.#e.seeking||e<this.#Ue)}#Xt(e){if(!(this.#a||typeof document>"u")){if(this.#e.seeking){this.#p==="trial"&&this.#w(),this.#c.length=0,this.#S=e;return}if(this.#S>0){const t=e-this.#S;t>=1&&t<=X&&(this.#c.push(t),this.#c.length>Me&&this.#c.shift())}if(this.#S=e,document.hidden){this.#p!=="off"&&this.#w(),this.#c.length=0;return}if(!this.#Ht(e)){if(this.#p!=="off"&&this.#w(),this.#p==="off"&&this.#c.length>0){const t=e<this.#Ue,i=!this.#h||this.#e.paused||this.#e.ended||this.#bt?.interlaced!==!0||!this.#y||this.#r!=="active"||this.#C==="film"||this.#J!=="video";(t||i)&&(this.#c.length=0)}return}this.#p==="off"?this.#Yt()&&this.#qt(e):this.#p==="trial"&&(this.#Vt()?this.#jt():e-this.#at>=Fe&&this.#Qt(e))}}get#bt(){return this.#X.length===0?this.#f:ie(this.#X,this.#e.currentTime)?.scan??null}#Yt(){if(this.#c.length<Z)return!1;const e=this.#c.slice(-Z);let t=0;for(const i of e)i>=be&&t++;return t/e.length>=xe}#Vt(){if(this.#c.length<ee)return!1;const e=this.#c.slice(-ee);let t=0;for(const i of e)i<=ye&&t++;return t/e.length>=Se}#qt(e){this.#p!=="off"||!this.#$t()||(this.#p="trial",this.#at=e,this.#K=!1,this.#yt(),this.#$!==null&&clearInterval(this.#$),this.#$=setInterval(()=>this.#Kt(),Te))}#jt(){this.#p==="trial"&&(this.#p="on")}#Qt(e){this.#w(),this.#Ue=e+Re,this.#c.length=0,this.#S=e}#w(){this.#$!==null&&(clearInterval(this.#$),this.#$=null),this.#G?.remove(),this.#G=null,this.#p="off",this.#K=!1}#_(e){this.#p!=="off"&&this.#w(),this.#c.length=0,this.#S=0,e&&(this.#J="unknown")}#$t(){if(typeof document>"u")return null;if(this.#G)return this.#G;const e=this.#L??document.body;if(!e)return null;const t=document.createElement("div");return t.setAttribute("data-mpeg2toh264-surface","true"),t.style.cssText=this.#L?"position:absolute;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;pointer-events:none;opacity:1;visibility:visible;transform:translateZ(0);background-color:rgb(0,0,0);":"position:fixed;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;pointer-events:none;opacity:1;visibility:visible;transform:translateZ(0);background-color:rgb(0,0,0);z-index:2147483647;",e.appendChild(t),this.#G=t,t}#Kt(){if(!(!this.#G||this.#p==="off")){if(typeof document<"u"&&document.hidden){this.#w(),this.#c.length=0;return}if(!this.#h||this.#e.paused||this.#e.ended){this.#w(),this.#c.length=0;return}this.#K=!this.#K,this.#yt()}}#yt(){const e=this.#G;e&&(e.style.backgroundColor=this.#K?"rgb(1,0,0)":"rgb(0,0,0)",e.style.transform=this.#K?"translateZ(0) translateX(1px)":"translateZ(0)")}#xt=()=>{if(!(typeof document>"u")){if(!document.hidden){this.#c.length=0,this.#S=0;return}this.#p!=="off"&&this.#w(),this.#c.length=0,this.#S=0}};#Jt(e){if(this.#a||e-this.#Se<ge||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const t=this.#e.currentTime,i=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,s=this.#d>=j?this.#d:Ee,r=i>this.#te,n=t!==this.#Fe&&e-this.#He>=s*.75;!r&&!n||(this.#te=Math.max(this.#te,i),this.#He=e,this.#ut(e,{mediaTime:t,presentedFrames:Math.max(this.#Y+1,i),width:this.#e.videoWidth,height:this.#e.videoHeight}))}#Zt(e){const t=e+this.#Q*1.5;for(;this.#t[1]&&this.#t[1].at<=t;)this.#x.late++,this.#t.shift();let i=this.#t[0];if(!i||i.at>t)return;this.#t.shift();const s=performance.now();this.#Tt(i.slot),this.#ve+=performance.now()-s,this.#pe++}#Tt(e){const t=this.#b[e];t&&this.#it(t.texture)}#ei(){this.#Ft();const e=this.#A[this.#E];e&&this.#it(e,!0),this.#u=0}#D(e){if(this.#a){this.#a.onVisibility(e);return}this.#i.style.visibility=e?"visible":"hidden"}#it(e,t=!1,i=!0){const s=this.#s;s.bindFramebuffer(s.FRAMEBUFFER,null),s.useProgram(this.#k),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,e),s.uniform1i(this.#q,0),s.uniform1i(this.#j,t?1:0),s.viewport(0,0,this.#g,this.#R),s.drawArrays(s.TRIANGLES,0,3),this.#m={kind:"texture",texture:e,flip:t},this.#D(!0),i&&this.#H++}#ti(e,t){this.#Y!==0&&!t&&(this.#x.missed+=Math.max(0,e-this.#Y-1)),this.#Y=e}#ii(e){const t=e-this.#Ce;if(t<J)return;const i=this.#Le()&&(this.#y||this.#C==="film")?this.#pe:this.#V,s={...this.#x,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:i*1e3/t,frameMs:this.#V===0?0:(this.#me+this.#ve)/this.#V,maxQueuedFields:this.#se,mode:this.#C,match:this.#oe,combScore:this.#Be,outputFps:this.#H*1e3/t,duplicateScore:this.#ze,duplicateRunnerUp:this.#Ge};this.dispatchEvent(new CustomEvent("stats",{detail:s})),this.#Xe?.(s),this.#Ce=e,this.#V=0,this.#me=0,this.#pe=0,this.#ve=0,this.#se=0,this.#H=0}#Ft(){const e=this.#s;this.#E=(this.#E+1)%T,e.bindTexture(e.TEXTURE_2D,this.#A[this.#E]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#ke),this.#u=Math.min(this.#u+1,T)}#be(e,t,i,s=!0){if(this.#u===0||this.#M)return;s&&(this.#u===T&&!e?this.#x.filtered++:this.#x.degraded++);const r=this.#s,n=this.#E,u=(this.#E+T-1)%T,o=(this.#E+1)%T;let f,h,v;this.#u===1?f=h=v=n:e?(f=u,h=v=n):this.#u===2?(f=h=u,v=n):(f=o,h=u,v=n),r.bindFramebuffer(r.FRAMEBUFFER,i),r.useProgram(this.#F);for(const[a,p]of[f,h,v].entries())r.activeTexture(r.TEXTURE0+a),r.bindTexture(r.TEXTURE_2D,this.#A[p]??null);r.uniform1i(this.#l.prev,0),r.uniform1i(this.#l.cur,1),r.uniform1i(this.#l.next,2),r.uniform2i(this.#l.size,this.#g,this.#R);const l=this.#_e?0:1;r.uniform1i(this.#l.parity,t?1-l:l),r.uniform1i(this.#l.tff,this.#_e?1:0),r.uniform1i(this.#l.spatialCheck,this.#Ne?1:0),r.viewport(0,0,this.#g,this.#R),r.drawArrays(r.TRIANGLES,0,3),i===null&&(this.#m={kind:"yadif",flush:e,second:t},this.#D(!0),s&&this.#H++)}#Pe(){if(!this.#L)return;const e=this.#e,t=e.videoWidth,i=e.videoHeight;if(t===0||i===0)return;const s=Math.min(e.offsetWidth/t,e.offsetHeight/i),r=t*s,n=i*s;this.#i.style.left=`${e.offsetLeft+(e.offsetWidth-r)/2}px`,this.#i.style.top=`${e.offsetTop+(e.offsetHeight-n)/2}px`,this.#i.style.width=`${r}px`,this.#i.style.height=`${n}px`}#St(e,t){const i=this.#s;this.#n.width=e,this.#n.height=t,this.#g=e,this.#R=t,this.#u=0,this.#m=null,this.#T(),this.#Pe();for(const s of this.#A)i.deleteTexture(s);this.#A=[];for(let s=0;s<T;s++){const r=i.createTexture();i.bindTexture(i.TEXTURE_2D,r),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,e,t,0,i.RGBA,i.UNSIGNED_BYTE,null),this.#A.push(r)}this.#ne(),this.#st(),this.#v&&this.#Rt(),(this.#y||this.#v)&&this.#rt()}#Rt(){if(this.#O)return;const e=this.#s,t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,R,M,0,e.RGBA,e.UNSIGNED_BYTE,null);const i=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,i),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const s=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!s){e.deleteFramebuffer(i),e.deleteTexture(t);return}this.#O={texture:t,framebuffer:i,pixels:new Uint8Array(R*M*4),previousLuma:new Uint8Array(R*M),currentLuma:new Uint8Array(R*M),nextLuma:new Uint8Array(R*M)}}#st(){this.#O&&(this.#s.deleteFramebuffer(this.#O.framebuffer),this.#s.deleteTexture(this.#O.texture),this.#O=null)}#rt(){const e=this.#s;if(!(this.#b.length===w||this.#g===0)){this.#ne();for(let t=0;t<w;t++){const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#g,this.#R,0,e.RGBA,e.UNSIGNED_BYTE,null);const s=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,s),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(s),e.deleteTexture(i),this.#ne();return}this.#b.push({texture:i,framebuffer:s})}this.#ae=w-1}}#ne(){const e=this.#s,t=this.#m?.kind==="texture"?this.#m.texture:null;this.#b.some(i=>i.texture===t)&&(this.#m=null);for(const{texture:i,framebuffer:s}of this.#b)e.deleteFramebuffer(s),e.deleteTexture(i);this.#b=[],this.#t.length=0}#si(){if(this.#L)return;const e=this.#e.parentElement;if(!e)return;const t=document.createElement("div");t.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(t,this.#e),t.appendChild(this.#e),t.appendChild(this.#i),this.#L=t,this.#Ie?.observe(this.#e),this.#Pe()}#ri(){if(this.#a)return;const e=this.#L;this.#L=null,this.#Ie?.disconnect(),this.#i.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#Mt=()=>this.#Pe();#nt(e){return!this.#o||this.#r==="main"?!1:(this.#o.postMessage({type:"event",name:e,video:this.#Ke()}),!0)}#kt=()=>{if(this.#Fe=Number.NaN,this.#_(!0),this.#nt("emptied")){this.#U(),this.#D(!1);return}this.#u=0,this.#le=0,this.#t.length=0,this.#d=0,this.#At(),this.#T(),this.#m=null,this.#D(!1)};#At(){this.#x={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0},this.#Y=0,this.#Ce=0,this.#je=0,this.#V=0,this.#me=0,this.#pe=0,this.#ve=0,this.#se=0,this.#H=0,this.#T()}#T(){this.#t.length=0,this.#C="video",this.#oe="c",this.#Be=0,this.#Oe=!0,this.#We.reset(),this.#ze=1/0,this.#Ge=1/0}#Ct=()=>{if(this.#p==="trial"&&this.#w(),this.#c.length=0,this.#S=0,this.#nt("seeking")){this.#U();return}this.#ce=!1};#I=e=>{if((e.type==="pause"||e.type==="ended")&&this.#_(!1),(e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#nt(e.type)){this.#U();return}if(e.type==="seeked"){const i=this.#ce;if(this.#ce=!1,i)return;this.#u=0,this.#T(),this.#m=null,this.#D(!1);return}const t=e.type==="ratechange";if(t&&(this.#d=0,this.#le=this.#e.currentTime),this.#t.length=0,this.#h&&this.#u>0){const i=this.#Ze(),s=i===null?void 0:this.#b[i];i!==null&&s?(this.#ae=i,this.#be(!0,!1,s.framebuffer),this.#Tt(i)):this.#be(!0,!1,null)}t&&(this.#u=0,this.#T())};#_t=e=>{if(e.preventDefault(),this.#a){this.#a.onFailure("the deinterlacer WebGL context was lost");return}this.#r!=="active"&&(this.#M=!0,this.stop())}}function _e(c,e,t,i,s,r,n){return new Ce(c,t,{canvas:e,onFailure:i,onVisibility:s,requestAnimationFrame:r,cancelAnimationFrame:n})}function O(c,e){const t=c.createProgram(),i=se(c,c.VERTEX_SHADER,ke),s=se(c,c.FRAGMENT_SHADER,e);if(c.attachShader(t,i),c.attachShader(t,s),c.linkProgram(t),c.deleteShader(i),c.deleteShader(s),!c.getProgramParameter(t,c.LINK_STATUS)){const r=c.getProgramInfoLog(t);throw c.deleteProgram(t),new Error(`the deinterlacer failed to link: ${r??"no reason given"}`)}return t}function se(c,e,t){const i=c.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(c.shaderSource(i,t),c.compileShader(i),!c.getShaderParameter(i,c.COMPILE_STATUS)){const s=c.getShaderInfoLog(i);throw c.deleteShader(i),new Error(`the deinterlacer failed to compile: ${s??"no reason given"}`)}return i}const U=self;class De extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#n=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#n=e.buffered}get buffered(){return{length:this.#n.length,start:e=>{const t=this.#n[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.start},end:e=>{const t=this.#n[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let A=null,F=null,re=!1;function we(c){return U.requestAnimationFrame(c)}function Le(c){U.cancelAnimationFrame(c)}function _(c,e=[]){U.postMessage(c,e)}function Pe(c,e){c.doubleRate=e.doubleRate,c.autoFilm=e.autoFilm,c.filmCombThreshold=e.filmCombThreshold}U.onmessage=c=>{const e=c.data;try{if(e.type==="initialize"){if(typeof U.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");A=new De,A.update(e.video),F=_e(A,e.canvas,e.options,t=>{re||_({type:"failed",message:t})},t=>_({type:"visibility",visible:t}),we,Le),F.addEventListener("stats",t=>{const{dropped:i,...s}=t.detail;_({type:"stats",stats:s})}),F.scan=e.scan,F.videoTimeline=e.videoTimeline,F.enabled=e.enabled,_({type:"ready"});return}if(!A||!F)return;switch(e.type){case"frame":A.update(e.video);try{F.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),_({type:"consumed",id:e.id})}break;case"settings":Pe(F,e.options);break;case"scan":F.scan=e.scan;break;case"timeline":F.videoTimeline=e.videoTimeline;break;case"enabled":F.enabled=e.enabled;break;case"event":A.update(e.video),A.dispatchEvent(new Event(e.name));break;case"capture":A.videoWidth=e.width,A.videoHeight=e.height,F.capture().then(t=>_({type:"capture",id:e.id,image:t},[t])).catch(()=>_({type:"capture",id:e.id,image:null}));break;case"destroy":re=!0,F.destroy(),F=null,A=null,U.close();break}}catch(t){const i=t instanceof Error?t.message:String(t);_({type:"failed",message:i})}}})();
//# sourceMappingURL=worker-BB91UgVT.js.map
