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
`;class x{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#n;#t;#e;#i=0;#E=null;#a=[];#x=null;#O=1/0;#z=1/0;constructor(e,t){this.#n=e,this.#t=t,this.#e=255*x.DECIMATE_BLOCK**2*x.DUPLICATE_PERCENT/100}fieldMatch(e,t,i,s,r=x.COMBED_PIXEL_LIMIT){const n=s?1:0,o={p:e,c:t,n:i};let a=this.#w("c","p",n,o);const c=new Map,h=v=>{const b=c.get(v);if(b!==void 0)return b;const g=x.#L(this.weave(e,t,i,v,s),this.#n,this.#t);return c.set(v,g),g},p=h(a),u=h("n");(u*3<p||u*2<p&&p>r)&&Math.abs(u-p)>=30&&u<r&&(a="n");const l=h(a),f=l>=r;return f&&(a="c"),{match:a,combScore:l,isCombed:f,luma:this.weave(e,t,i,a,s)}}decimate(e){const t=this.#i,i=this.#x?x.#ue(this.#x,e,this.#n,this.#t):{maxBlockDifference:1/0,totalDifference:1/0};this.#a.push(i);const s=this.#E===t,r=s&&i.maxBlockDifference<this.#e;s&&!r&&(this.#E=null);const n=this.#E;this.#x=e.slice(),this.#i++;let o=this.#E;if(this.#i===x.CYCLE){let a=0,c=null;for(let h=1;h<this.#a.length;h++)(this.#a[h]?.maxBlockDifference??1/0)<(this.#a[a]?.maxBlockDifference??1/0)?(c=a,a=h):(c===null||(this.#a[h]?.maxBlockDifference??1/0)<(this.#a[c]?.maxBlockDifference??1/0))&&(c=h);this.#O=this.#a[a]?.maxBlockDifference??1/0,this.#z=c===null?1/0:this.#a[c]?.maxBlockDifference??1/0,o=(this.#a[a]?.maxBlockDifference??1/0)<this.#e?a:null,this.#E=o,this.#a=[],this.#i=0}return{cycleIndex:t,maxBlockDifference:i.maxBlockDifference,totalDifference:i.totalDifference,shouldDrop:r,dropIndex:n,nextDropIndex:o,lowestCycleDifference:this.#O,runnerUpCycleDifference:this.#z}}weave(e,t,i,s,r){if(s==="c")return t.slice();const n=t.slice(),o=s==="p"?e:i,a=n.length/this.#t,c=r?1:0;for(let h=c;h<this.#t;h+=2)n.set(o.subarray(h*a,(h+1)*a),h*a);return n}reset(){this.#i=0,this.#E=null,this.#a=[],this.#x=null,this.#O=1/0,this.#z=1/0}#w(e,t,i,s){const r=this.#n,n=this.#t,o=2-i,a=2-i,c=s[e],h=s[t],p=x.#fe(c,h,r,n,i);let u=0,l=0,f=0,v=0,b=0,g=0;for(let _=2;_<n-2;_+=2){const R=(_-2)/2,j=o-1+R*2,Q=o+1+R*2,$=o+3+R*2,G=o+R*2,X=G+2,U=a+R*2,w=U+2,ie=o+R*2;for(let S=8;S<r-8;S++){const P=(p[ie*r+S]??0)|(p[(ie+2)*r+S]??0);if(P===0)continue;const se=(s.c[j*r+S]??0)+((s.c[Q*r+S]??0)<<2)+(s.c[$*r+S]??0),N=Math.abs(3*((c[G*r+S]??0)+(c[X*r+S]??0))-se),B=Math.abs(3*((h[U*r+S]??0)+(h[w*r+S]??0))-se);N>23&&(P&1)!==0&&(u+=N),B>23&&(P&1)!==0&&(v+=B),N>42&&(P&2)!==0&&(l+=N),B>42&&(P&2)!==0&&(b+=B),N>42&&(P&4)!==0&&(f+=N),B>42&&(P&4)!==0&&(g+=B)}}l<500&&b<500&&(f>=500||g>=500)&&Math.max(f,g)>3*Math.min(f,g)&&(l=f,b=g);const y=Math.floor(u/6+.5),D=Math.floor(v/6+.5),E=Math.floor(l/6+.5),m=Math.floor(b/6+.5),z=Math.max(y,D)/Math.max(Math.min(y,D),1),W=Math.max(E,m)/Math.max(Math.min(E,m),1),H=Math.max(E,m)/Math.max(Math.max(y,D),1);return(E>=500||m>=500)&&(E*2<m||m*2<E)||(E>=1e3||m>=1e3)&&(E*3<m*2||m*3<E*2)||(E>=2e3||m>=2e3)&&(E*5<m*4||m*5<E*4)||(E>=4e3||m>=4e3)&&W>z||H>.005&&Math.max(E,m)>150&&(E*2<m||m*2<E)?E>m?t:e:y>D?t:e}static#fe(e,t,i,s,r){const n=Array.from({length:Math.ceil(s/2)},()=>new Uint8Array(i)),o=r===1?1:0;for(let h=0;h<n.length;h++){const p=Math.min(s-1,o+h*2),u=n[h];if(u)for(let l=0;l<i;l++)u[l]=Math.abs((e[p*i+l]??0)-(t[p*i+l]??0))}const a=new Uint8Array(i*s),c=r===1?3:2;for(let h=1;h<n.length-1;h++){const p=c+(h-1)*2;if(p>=s)break;const u=n[h];if(u)for(let l=1;l<i-1;l++){const f=u[l]??0;if(f<=3)continue;let v=0;for(let m=l-1;m<=l+1;m++)v+=(n[h-1]?.[m]??0)>3?1:0,v+=(n[h]?.[m]??0)>3?1:0,v+=(n[h+1]?.[m]??0)>3?1:0;if(v<=1)continue;const b=p*i+l;if(a[b]=1,f<=19)continue;v=0;let g=!1,y=!1;for(let m=l-1;m<=l+1;m++)(n[h-1]?.[m]??0)>19&&(v++,g=!0),(n[h]?.[m]??0)>19&&v++,(n[h+1]?.[m]??0)>19&&(v++,y=!0);if(v<=3)continue;if(g&&y){a[b]|=2;continue}let D=!1,E=!1;for(let m=Math.max(l-4,0);m<Math.min(l+5,i);m++)h!==1&&(n[h-2]?.[m]??0)>19&&(D=!0),(n[h-1]?.[m]??0)>19&&(g=!0),(n[h+1]?.[m]??0)>19&&(y=!0),h!==n.length-2&&(n[h+2]?.[m]??0)>19&&(E=!0);g&&(y||D)||y&&(g||E)?a[b]|=2:v>5&&(a[b]|=4)}}return a}static#L(e,t,i){const s=new Uint8Array(t*i),r=(o,a)=>e[Math.max(0,Math.min(i-1,a))*t+o]??0;for(let o=0;o<i;o++)for(let a=0;a<t;a++){const c=r(a,o),h=r(a,o===0?1:o-1),p=r(a,o===i-1?i-2:o+1),u=o<2?r(a,o===0?2:3):r(a,o-2),l=o+2>=i?r(a,o===i-1?i-3:i-4):r(a,o+2);(o===0?Math.abs(c-p)>x.COMB_THRESHOLD:o===i-1?Math.abs(c-h)>x.COMB_THRESHOLD:Math.abs(c-h)>x.COMB_THRESHOLD&&Math.abs(c-p)>x.COMB_THRESHOLD)&&Math.abs(4*c-3*(h+p)+u+l)>x.COMB_THRESHOLD*6&&(s[o*t+a]=255)}let n=0;for(const o of[0,8])for(const a of[0,8])for(let c=o;c<i;c+=16)for(let h=a;h<t;h+=16){let p=0;for(let u=Math.max(1,c);u<Math.min(i-1,c+16);u++)for(let l=h;l<Math.min(t,h+16);l++){const f=u*t+l;s[f-t]===255&&s[f]===255&&s[f+t]===255&&p++}n=Math.max(n,p)}return n}static#ue(e,t,i,s){const r=x.DECIMATE_BLOCK/2,n=Math.ceil(i/r),o=Math.ceil(s/r),a=new Float64Array(n*o),c=e.length/(i*s);for(let u=0;u<s;u++){const l=Math.floor(u/r);for(let f=0;f<i;f++){const v=Math.floor(f/r),b=l*n+v,g=(u*i+f)*c;if(c===1){a[b]=(a[b]??0)+Math.abs((e[g]??0)-(t[g]??0));continue}const y=Math.round((e[g]??0)*.2126+(e[g+1]??0)*.7152+(e[g+2]??0)*.0722),D=Math.round((t[g]??0)*.2126+(t[g+1]??0)*.7152+(t[g+2]??0)*.0722);if(a[b]=(a[b]??0)+Math.abs(y-D),(f&1)!==0||(u&1)!==0)continue;let E=0,m=0,z=0,W=0,H=0,_=0,R=0;for(let X=u;X<Math.min(u+2,s);X++)for(let U=f;U<Math.min(f+2,i);U++){const w=(X*i+U)*c;E+=e[w]??0,m+=e[w+1]??0,z+=e[w+2]??0,W+=t[w]??0,H+=t[w+1]??0,_+=t[w+2]??0,R++}const j=Math.round((-.114572*E-.385428*m+.5*z)/R),Q=Math.round((-.114572*W-.385428*H+.5*_)/R),$=Math.round((.5*E-.454153*m-.045847*z)/R),G=Math.round((.5*W-.454153*H-.045847*_)/R);a[b]=(a[b]??0)+Math.abs(j-Q)+Math.abs($-G)}}let h=-1;for(let u=0;u<o-1;u++)for(let l=0;l<n-1;l++)h=Math.max(h,(a[u*n+l]??0)+(a[u*n+l+1]??0)+(a[(u+1)*n+l]??0)+(a[(u+1)*n+l+1]??0));let p=0;for(const u of a)p+=u;return{maxBlockDifference:h,totalDifference:p}}}let le=null;const ce=.5,T=3,K=5,L=K+1,J=1e3,V=4,q=200,fe=.25,ue=1e3/60,de=.02,me=250,pe=1e3/30;function Z(d){if(!Number.isFinite(d)||d<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return d}const ve=`#version 300 es
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
`;class Ee extends EventTarget{#n;#t;#e;#i;#E;#a;#x;#O;#z;#w=null;#fe=null;#L=null;#ue=null;#$=null;#$e=null;#_=null;#T=[];#b=[];#K=L-1;#d=null;#s=[];#P=null;#de=0;#I=null;#J=ue;#W=null;#Me;#F;#m;#H;#ke;#S="video";#Z="c";#Se=0;#Ae=!0;#De=new x(M,k);#Ce=1/0;#we=1/0;#U=0;#f=0;#p=0;#y=0;#v=T-1;#o=0;#ee=0;#me=Number.NaN;#te=!1;#X=null;#pe=0;#G=0;#Le=0;#u=!1;#ve=!1;#_e=!1;#l=null;#Y=[];#R=!1;#Pe;#c;#ge;#A;#Ie;#h=null;#r;#ie=!1;#Ue=0;#Ne=!1;#gt=0;#se=!1;#Ee=!1;#V=null;#Et=0;#re=new Map;#k={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0};#N=0;#Be=0;#be=0;#B=0;#ne=0;#he=0;#ae=0;#q=0;constructor(e,t={},i=null){super(),this.#e=e,this.#F=t.doubleRate??!1,this.#m=t.autoFilm??!1,this.#H=Z(t.filmCombThreshold??x.COMBED_PIXEL_LIMIT),this.#ke=t.spatialCheck??!0,this.#Pe=t.onStats,this.#c=i,this.#A=i?"main":t.rendering??"auto",this.#Ie=t.workerUrl??le,this.#r=this.#A==="main"?"main":"idle",this.#t=i?i.canvas:document.createElement("canvas"),this.#n=i?.canvas??(this.#A==="main"?this.#t:document.createElement("canvas")),this.#ge=e,i||(this.#t.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const s=this.#n.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!s)throw new Error("this browser has no WebGL2");this.#i=s,this.#E=O(s,ne);const r=this.#E;this.#a=Object.fromEntries(Object.entries(re).map(([n,o])=>[n,s.getUniformLocation(r,o)])),this.#x=O(s,ge),this.#O=s.getUniformLocation(this.#x,"uField"),this.#z=s.getUniformLocation(this.#x,"uFlip"),this.#m&&this.#it(),this.#n.addEventListener("webglcontextlost",this.#vt),this.#Me=i?null:new ResizeObserver(()=>this.#Re()),e.addEventListener("emptied",this.#dt),e.addEventListener("resize",this.#ut),e.addEventListener("pause",this.#C),e.addEventListener("ended",this.#C),e.addEventListener("seeking",this.#pt),e.addEventListener("seeked",this.#C),e.addEventListener("ratechange",this.#C)}get running(){return this.#u&&(this.#l?.interlaced??!0)}get canvas(){return this.#t}get#ye(){return this.#l?.topFieldFirst!==!1}#Ke(){return{doubleRate:this.#F,autoFilm:this.#m,filmCombThreshold:this.#H,spatialCheck:this.#ke}}get enabled(){return this.#ve}set enabled(e){this.#ve=e,this.#ze(),this.#h?.postMessage({type:"enabled",enabled:e})}set scan(e){const t=this.#l?.interlaced!==e?.interlaced,i=t||this.#l?.topFieldFirst!==e?.topFieldFirst;this.#l=e,this.#h?.postMessage({type:"scan",scan:e}),i&&(this.#o=0,this.#g(),t&&(this.#f=0),this.#d=null,this.#M(!1)),this.#ze(),i&&((e?.interlaced??!0)&&(this.#c||this.#r==="main")?this.#j():this.#Ge())}get scan(){return this.#l}set videoTimeline(e){this.#Y=e,this.#h?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#l=null),this.#ze()}get videoTimeline(){return this.#Y}get container(){return this.#W??this.#e}get doubleRate(){return this.#F}set doubleRate(e){e!==this.#F&&(this.#F=e,this.#Oe(),this.#s.length=0,e?(this.#p>0&&this.#je(),(this.#l?.interlaced??!0)&&(this.#c||this.#r==="main")&&this.#j()):this.#m||(this.#d=null,this.#M(!1),this.#Q()))}get autoFilm(){return this.#m}set autoFilm(e){e!==this.#m&&(this.#m=e,this.#Oe(),this.#g(),e?(this.#it(),this.#p>0&&(this.#ft(),this.#je()),(this.#l?.interlaced??!0)&&(this.#c||this.#r==="main")&&this.#j()):(this.#qe(),this.#F||(this.#d=null,this.#M(!1),this.#Q())))}get filmCombThreshold(){return this.#H}set filmCombThreshold(e){const t=Z(e);t!==this.#H&&(this.#H=t,this.#Oe(),this.#m&&this.#g())}#Oe(){this.#h?.postMessage({type:"settings",options:this.#Ke()})}#ze(){this.#ve&&(this.#Y.length>0||(this.#l?.interlaced??!0))?this.start():this.stop()}#bt(){return this.#c||this.#A==="main"?!1:this.#r==="starting"||this.#r==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#Ie!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#Je(),!0):this.#A==="auto"?(this.#xe(),!1):(this.#r="failed",this.#u=!1,!0)}#Je(){this.#D(),this.#h?.terminate(),this.#h=null,this.#se=!1,this.#Ee=!1;let e=this.#t;if(this.#Ne){e=document.createElement("canvas"),e.className=this.#t.className;const r=this.#t.getAttribute("style");r===null?e.removeAttribute("style"):e.setAttribute("style",r),e.style.visibility="hidden",this.#t.parentElement&&this.#t.replaceWith(e),this.#t=e}const t=++this.#Ue;this.#r="starting";let i,s;try{s=e.transferControlToOffscreen(),this.#Ne=!0,i=new Worker(this.#Ie,{type:"module"})}catch(r){this.#oe(r instanceof Error?r.message:String(r));return}this.#h=i,i.onmessage=r=>{t===this.#Ue&&this.#yt(r.data)},i.onerror=r=>{t===this.#Ue&&(r.preventDefault(),this.#oe(r.message||"the deinterlacer worker failed"))},i.postMessage({type:"initialize",canvas:s,options:this.#Ke(),scan:this.#l,videoTimeline:this.#Y,enabled:this.#u,video:this.#We()},[s])}#yt(e){switch(e.type){case"ready":this.#r="active",this.#u&&(this.#le(),this.#Ye());break;case"failed":this.#oe(e.message);break;case"consumed":{this.#se=!1,this.#Ee=!0;const t=this.#V;this.#V=null,t&&this.#et(t);break}case"visibility":this.#t.style.visibility=e.visible?"visible":"hidden";break;case"stats":{const t={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0};this.dispatchEvent(new CustomEvent("stats",{detail:t})),this.#Pe?.(t);break}case"capture":{const t=this.#re.get(e.id);if(this.#re.delete(e.id),!t){e.image?.close();break}e.image?t.resolve(e.image):createImageBitmap(this.#e).then(t.resolve,t.reject);break}}}#oe(e){if(this.#r==="starting"&&this.#A==="auto"&&!this.#ie){this.#xe();return}if(this.#Ze(e),!this.#ie){this.#ie=!0,this.#Je();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#r="failed",this.#h?.terminate(),this.#h=null,this.#D(),this.stop()}#xe(){const e=this.#n;e.className=this.#t.className;const t=this.#t.getAttribute("style");t===null?e.removeAttribute("style"):e.setAttribute("style",t),e.style.visibility="hidden",this.#t.parentElement&&this.#t.replaceWith(e),this.#t=e,this.#Ne=!1,this.#h?.terminate(),this.#h=null,this.#r="main",this.#D(),this.#u&&(this.#le(),this.#Ye(),(this.#l?.interlaced??!0)&&this.#j())}#D(){this.#V?.frame.close(),this.#V=null}#Ze(e){for(const t of this.#re.values())t.reject(new Error(e));this.#re.clear()}start(){if(!(this.#u||this.#_e||this.#R)){if(this.#u=!0,this.#mt(),this.#g(),this.#pe=performance.now(),this.#Le=this.#pe,this.#me=Number.NaN,this.#G=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#Pt(),this.#Ye(),this.#bt()){this.#h?.postMessage({type:"enabled",enabled:!0}),this.#r==="active"&&this.#le();return}this.#le(),(this.#l?.interlaced??!0)&&this.#j()}}stop(){this.#u&&(this.#u=!1,this.#X!==null&&this.#e.cancelVideoFrameCallback(this.#X),this.#X=null,this.#At(),this.#Ge(),this.#o=0,this.#d=null,this.#M(!1),this.#D(),this.#h?.postMessage({type:"enabled",enabled:!1}))}destroy(){if(!this.#_e){this.#_e=!0,this.#ve=!1,this.stop(),this.#h?.postMessage({type:"destroy"}),this.#h?.terminate(),this.#h=null,this.#D(),this.#Ze("the deinterlacer was destroyed"),this.#n.removeEventListener("webglcontextlost",this.#vt),this.#e.removeEventListener("emptied",this.#dt),this.#e.removeEventListener("resize",this.#ut),this.#e.removeEventListener("pause",this.#C),this.#e.removeEventListener("ended",this.#C),this.#e.removeEventListener("seeking",this.#pt),this.#e.removeEventListener("seeked",this.#C),this.#e.removeEventListener("ratechange",this.#C),this.#It();for(const e of this.#T)this.#i.deleteTexture(e);this.#T=[],this.#Q(),this.#qe(),this.#i.deleteProgram(this.#E),this.#i.deleteProgram(this.#x),this.#w&&this.#i.deleteProgram(this.#w),this.#L&&this.#i.deleteProgram(this.#L),this.#$&&this.#i.deleteProgram(this.#$),this.#i.getExtension("WEBGL_lose_context")?.loseContext()}}capture(){if(this.#r==="active"&&this.#t.style.visibility==="visible"&&this.#h){const s=++this.#Et,r=new Promise((n,o)=>{this.#re.set(s,{resolve:n,reject:o})});return this.#h.postMessage({type:"capture",id:s,width:this.#e.videoWidth,height:this.#e.videoHeight}),r}if(this.#r==="starting"||this.#r==="failed")return createImageBitmap(this.#e);const e=this.#d;if(this.#c&&(!this.#u||this.#R||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#u||this.#R||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#Ve(e.texture,e.flip,!1):e.kind==="yadif"?this.#ce(e.flush,e.second,null,!1):this.#He(null,!1);const t=this.#e.videoWidth,i=this.#e.videoHeight;return t>0&&i>0&&(t!==this.#n.width||i!==this.#n.height)?createImageBitmap(this.#n,{resizeWidth:t,resizeHeight:i,resizeQuality:"high"}):createImageBitmap(this.#n)}addEventListener(e,t,i){super.addEventListener(e,t,i)}removeEventListener(e,t,i){super.removeEventListener(e,t,i)}#le(){this.#c||!this.#u||this.#X!==null||(this.#X=this.#e.requestVideoFrameCallback(this.#Tt))}#We(){const e=[];for(let t=0;t<this.#e.buffered.length;t++)e.push({start:this.#e.buffered.start(t),end:this.#e.buffered.end(t)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#xt(e,t){let i;try{i=new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(t.mediaTime*1e6))})}catch(r){const n=r instanceof Error?r.message:String(r);this.#A==="auto"&&!this.#Ee&&!this.#ie?(this.#xe(),this.#Te(e,t)):this.#oe(n);return}const s={id:++this.#gt,frame:i,now:e,metadata:t,video:this.#We()};if(this.#se){this.#V?.frame.close(),this.#V=s;return}this.#et(s)}#et(e){const t=this.#h;if(!t||this.#r!=="active"){e.frame.close();return}this.#se=!0;const i={type:"frame",...e};try{t.postMessage(i,[e.frame])}catch(s){this.#se=!1,e.frame.close();const r=s instanceof Error?s.message:String(s);this.#A==="auto"&&!this.#Ee&&!this.#ie?(this.#xe(),this.#Te(e.now,e.metadata)):this.#oe(r)}}#Tt=(e,t)=>{this.#X=null,!(!this.#u||this.#R)&&(this.#pe=e,this.#G=Math.max(this.#G,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0),this.#tt(e,t),this.#le())};#tt(e,t){if(this.#me=t.mediaTime,this.#r==="active"){this.#xt(e,t);return}this.#r!=="starting"&&this.#Te(e,t)}ingestExternalFrame(e,t,i){this.#ge=i;try{this.#Te(e,t)}finally{this.#ge=this.#e}}#Te(e,t){if(this.#Ft(t.mediaTime),t.width>0&&t.height>0){let i=!1;if(!this.#te&&this.#e.seeking){const l=this.#e.buffered,f=this.#f>=V?this.#f/1e3:q/1e3;for(let v=0;v<l.length;v++)if(t.mediaTime>=l.start(v)&&t.mediaTime<l.end(v)&&Math.abs(t.mediaTime-this.#e.currentTime)<=f){i=!0;break}}if(i&&(this.#te=!0),(this.#p===0||this.#y===0)&&this.#ct(t.width,t.height),this.#l&&!this.#l.interlaced){this.#wt();return}const s=t.mediaTime-this.#ee,r=i||s<0||s>ce;r&&(this.#o=0,this.#f=0,this.#k.discontinuities++,this.#s.length=0,this.#g());const n=this.#m&&this.#N!==0&&t.presentedFrames-this.#N>1;if(this.#Lt(t.presentedFrames,r),!r&&n&&(this.#o=0,this.#g()),this.#o>0&&t.mediaTime===this.#ee)return;!r&&s>0&&this.#Rt(s),this.#ee=t.mediaTime;const o=performance.now();o-this.#Be>J&&(this.#be=o,this.#B=0,this.#ne=0,this.#he=0,this.#ae=0,this.#q=0,this.#U=0),this.#Be=o;const a=performance.now();this.#lt();const c=this.#S,h=this.#m&&this.#o===T&&this.#Mt();if(c!==this.#S&&(this.#s.length=0),!(h&&this.#Fe()))if(this.#m&&!this.#Ae&&this.#S==="film")if(this.#Fe()){const l=this.#f*5/4;this.#rt(1);const f=this.#s.at(-1),v=f==null?e+l:f.at+f.duration;this.#kt(v,l)}else this.#He(null);else if(this.#F&&this.#Fe()){const l=this.#f/2;this.#rt(2);const f=this.#s.at(-1),v=f==null?e+l*2:f.at+f.duration;this.#st(!1,v,l),this.#st(!0,v+l,l)}else this.#k.late+=this.#s.length,this.#s.length=0,this.#ce(!1,!1,null);this.#q=Math.max(this.#q,this.#s.length),this.#ne+=performance.now()-a,this.#B++,this.#_t(o)}}#Ft(e){let t;for(let r=this.#Y.length-1;r>=0;r--){const n=this.#Y[r];if(n.start<=e+1e-6){t=n;break}}t?.codedSize&&(t.codedSize.width!==this.#p||t.codedSize.height!==this.#y)&&this.#ct(t.codedSize.width,t.codedSize.height);const i=t?.scan;if(!i||this.#l?.interlaced===i.interlaced&&this.#l.topFieldFirst===i.topFieldFirst)return;const s=this.#l?.interlaced;this.#l=i,this.#o=0,this.#s.length=0,this.#g(),s!==i.interlaced&&(this.#f=0),i.interlaced&&(this.#c||this.#r==="main")?this.#j():this.#Ge()}#Fe(){return(this.#F||this.#m)&&this.#f>0&&this.#b.length===L}#Rt(e){const t=e*1e3/(this.#e.playbackRate||1),i=this.#f>0?Math.max(1,Math.round(t/this.#f)):1,s=t/i;s<V||s>q||(this.#f=this.#f>0?this.#f+(s-this.#f)*fe:s)}#it(){if(this.#w&&this.#L&&this.#$)return;const e=this.#i,t=O(e,he),i=O(e,ae),s=O(e,oe);this.#w=t,this.#fe=Object.fromEntries(Object.entries(Y).filter(([r])=>r!=="match"&&r!=="topFieldFirst").map(([r,n])=>[r,e.getUniformLocation(t,n)])),this.#L=i,this.#ue=Object.fromEntries(Object.entries(Y).map(([r,n])=>[r,e.getUniformLocation(i,n)])),this.#$=s,this.#$e=Object.fromEntries(Object.entries(Y).map(([r,n])=>[r,e.getUniformLocation(s,n)]))}#Mt(){const e=this.#_,t=this.#w,i=this.#fe,s=this.#$,r=this.#$e;if(!e||!t||!i||!s||!r)return!1;const n=this.#i,o=this.#v,a=(this.#v+T-1)%T,c=(this.#v+1)%T,h=this.#ye;n.bindFramebuffer(n.FRAMEBUFFER,e.framebuffer),n.useProgram(t);for(const[g,y]of[c,a,o].entries())n.activeTexture(n.TEXTURE0+g),n.bindTexture(n.TEXTURE_2D,this.#T[y]??null);n.uniform1i(i.prev,0),n.uniform1i(i.cur,1),n.uniform1i(i.next,2),n.uniform2i(i.size,this.#p,this.#y),n.viewport(0,0,M,k),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,M,k,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const{previousLuma:p,currentLuma:u,nextLuma:l}=e;for(let g=0;g<p.length;g++){const y=g*4;p[g]=e.pixels[y]??0,u[g]=e.pixels[y+1]??0,l[g]=e.pixels[y+2]??0}const f=this.#De.fieldMatch(p,u,l,h,this.#H);n.useProgram(s),n.uniform1i(r.prev,0),n.uniform1i(r.cur,1),n.uniform1i(r.next,2),n.uniform2i(r.size,this.#p,this.#y),n.uniform1i(r.topFieldFirst,h?1:0),n.uniform1i(r.match,f.match==="p"?0:f.match==="c"?1:2),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,M,k,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const v=this.#De.decimate(e.pixels);this.#Z=f.match,this.#Se=f.combScore,this.#Ae=f.isCombed,this.#Ce=v.lowestCycleDifference,this.#we=v.runnerUpCycleDifference;const b=v.dropIndex!==null&&!f.isCombed;return(b?"film":"video")!==this.#S&&(this.#S=b?"film":"video"),v.shouldDrop&&!f.isCombed}#kt(e,t){const i=this.#Xe();if(i===null)return;const s=this.#b[i];s&&(this.#K=i,this.#He(s.framebuffer),this.#s.push({slot:i,at:e,duration:t}))}#He(e,t=!0){const i=this.#L,s=this.#ue;if(!i||!s)return;const r=this.#i,n=this.#v,o=(this.#v+T-1)%T,a=(this.#v+1)%T,c=this.#ye;r.bindFramebuffer(r.FRAMEBUFFER,e),r.useProgram(i);for(const[h,p]of[a,o,n].entries())r.activeTexture(r.TEXTURE0+h),r.bindTexture(r.TEXTURE_2D,this.#T[p]??null);r.uniform1i(s.prev,0),r.uniform1i(s.cur,1),r.uniform1i(s.next,2),r.uniform2i(s.size,this.#p,this.#y),r.uniform1i(s.topFieldFirst,c?1:0),r.uniform1i(s.match,this.#Z==="p"?0:this.#Z==="c"?1:2),r.viewport(0,0,this.#p,this.#y),r.drawArrays(r.TRIANGLES,0,3),e===null&&(this.#d={kind:"film"},this.#M(!0),t&&this.#U++)}#st(e,t,i){const s=this.#Xe();if(s===null)return;const r=this.#b[s];r&&(this.#K=s,this.#ce(!1,e,r.framebuffer),this.#s.push({slot:s,at:t,duration:i}))}#rt(e){const t=Math.max(0,this.#s.length+e-K);let i=0,s=0;for(;s<t;){const r=this.#s.shift();if(!r)break;i+=r.duration,s++}for(const r of this.#s)r.at-=i;this.#k.late+=s}#Xe(){const e=this.#d?.kind==="texture"?this.#d.texture:null,t=new Set(this.#s.map(({slot:i})=>i));for(let i=1;i<=L;i++){const s=(this.#K+i)%L,r=this.#b[s];if(r&&r.texture!==e&&!t.has(s))return s}return null}#j(){this.#P===null&&(!this.#u||this.#R||(this.#de=0,this.#P=this.#ht(this.#nt)))}#Ge(){this.#P!==null&&this.#St(this.#P),this.#P=null,this.#s.length=0}#nt=e=>{if(this.#P=null,!(!this.#u||this.#R)){if(this.#de>0){const t=e-this.#de;t>=1&&t<=q&&(this.#J=t<this.#J?t:this.#J+(t-this.#J)*de)}this.#de=e,this.#r==="main"&&this.#Ct(e),this.#P=this.#ht(this.#nt)}};#ht(e){return this.#c?this.#c.requestAnimationFrame(e):requestAnimationFrame(e)}#St(e){this.#c?this.#c.cancelAnimationFrame(e):cancelAnimationFrame(e)}#Ye(){this.#c||this.#I!==null||!this.#u||this.#R||(this.#I=requestAnimationFrame(this.#at))}#At(){this.#I!==null&&cancelAnimationFrame(this.#I),this.#I=null}#at=e=>{this.#I=null,!(!this.#u||this.#R)&&(this.#Dt(e),this.#I=requestAnimationFrame(this.#at))};#Dt(e){if(this.#c||e-this.#pe<me||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const t=this.#e.currentTime,i=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,s=this.#f>=V?this.#f:pe,r=i>this.#G,n=t!==this.#me&&e-this.#Le>=s*.75;!r&&!n||(this.#G=Math.max(this.#G,i),this.#Le=e,this.#tt(e,{mediaTime:t,presentedFrames:Math.max(this.#N+1,i),width:this.#e.videoWidth,height:this.#e.videoHeight}))}#Ct(e){const t=e+this.#J*1.5;for(;this.#s[1]&&this.#s[1].at<=t;)this.#k.late++,this.#s.shift();let i=this.#s[0];if(!i||i.at>t)return;this.#s.shift();const s=performance.now();this.#ot(i.slot),this.#ae+=performance.now()-s,this.#he++}#ot(e){const t=this.#b[e];t&&this.#Ve(t.texture)}#wt(){this.#lt();const e=this.#T[this.#v];e&&this.#Ve(e,!0),this.#o=0}#M(e){if(this.#c){this.#c.onVisibility(e);return}this.#t.style.visibility=e?"visible":"hidden"}#Ve(e,t=!1,i=!0){const s=this.#i;s.bindFramebuffer(s.FRAMEBUFFER,null),s.useProgram(this.#x),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,e),s.uniform1i(this.#O,0),s.uniform1i(this.#z,t?1:0),s.viewport(0,0,this.#p,this.#y),s.drawArrays(s.TRIANGLES,0,3),this.#d={kind:"texture",texture:e,flip:t},this.#M(!0),i&&this.#U++}#Lt(e,t){this.#N!==0&&!t&&(this.#k.missed+=Math.max(0,e-this.#N-1)),this.#N=e}#_t(e){const t=e-this.#be;if(t<J)return;const i=this.#Fe()&&(this.#F||this.#S==="film")?this.#he:this.#B,s={...this.#k,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:i*1e3/t,frameMs:this.#B===0?0:(this.#ne+this.#ae)/this.#B,maxQueuedFields:this.#q,mode:this.#S,match:this.#Z,combScore:this.#Se,outputFps:this.#U*1e3/t,duplicateScore:this.#Ce,duplicateRunnerUp:this.#we};this.dispatchEvent(new CustomEvent("stats",{detail:s})),this.#Pe?.(s),this.#be=e,this.#B=0,this.#ne=0,this.#he=0,this.#ae=0,this.#q=0,this.#U=0}#lt(){const e=this.#i;this.#v=(this.#v+1)%T,e.bindTexture(e.TEXTURE_2D,this.#T[this.#v]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#ge),this.#o=Math.min(this.#o+1,T)}#ce(e,t,i,s=!0){if(this.#o===0||this.#R)return;s&&(this.#o===T&&!e?this.#k.filtered++:this.#k.degraded++);const r=this.#i,n=this.#v,o=(this.#v+T-1)%T,a=(this.#v+1)%T;let c,h,p;this.#o===1?c=h=p=n:e?(c=o,h=p=n):this.#o===2?(c=h=o,p=n):(c=a,h=o,p=n),r.bindFramebuffer(r.FRAMEBUFFER,i),r.useProgram(this.#E);for(const[l,f]of[c,h,p].entries())r.activeTexture(r.TEXTURE0+l),r.bindTexture(r.TEXTURE_2D,this.#T[f]??null);r.uniform1i(this.#a.prev,0),r.uniform1i(this.#a.cur,1),r.uniform1i(this.#a.next,2),r.uniform2i(this.#a.size,this.#p,this.#y);const u=this.#ye?0:1;r.uniform1i(this.#a.parity,t?1-u:u),r.uniform1i(this.#a.tff,this.#ye?1:0),r.uniform1i(this.#a.spatialCheck,this.#ke?1:0),r.viewport(0,0,this.#p,this.#y),r.drawArrays(r.TRIANGLES,0,3),i===null&&(this.#d={kind:"yadif",flush:e,second:t},this.#M(!0),s&&this.#U++)}#Re(){if(!this.#W)return;const e=this.#e,t=e.videoWidth,i=e.videoHeight;if(t===0||i===0)return;const s=Math.min(e.offsetWidth/t,e.offsetHeight/i),r=t*s,n=i*s;this.#t.style.left=`${e.offsetLeft+(e.offsetWidth-r)/2}px`,this.#t.style.top=`${e.offsetTop+(e.offsetHeight-n)/2}px`,this.#t.style.width=`${r}px`,this.#t.style.height=`${n}px`}#ct(e,t){const i=this.#i;this.#n.width=e,this.#n.height=t,this.#p=e,this.#y=t,this.#o=0,this.#d=null,this.#g(),this.#Re();for(const s of this.#T)i.deleteTexture(s);this.#T=[];for(let s=0;s<T;s++){const r=i.createTexture();i.bindTexture(i.TEXTURE_2D,r),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,e,t,0,i.RGBA,i.UNSIGNED_BYTE,null),this.#T.push(r)}this.#Q(),this.#qe(),this.#m&&this.#ft(),(this.#F||this.#m)&&this.#je()}#ft(){if(this.#_)return;const e=this.#i,t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,M,k,0,e.RGBA,e.UNSIGNED_BYTE,null);const i=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,i),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const s=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!s){e.deleteFramebuffer(i),e.deleteTexture(t);return}this.#_={texture:t,framebuffer:i,pixels:new Uint8Array(M*k*4),previousLuma:new Uint8Array(M*k),currentLuma:new Uint8Array(M*k),nextLuma:new Uint8Array(M*k)}}#qe(){this.#_&&(this.#i.deleteFramebuffer(this.#_.framebuffer),this.#i.deleteTexture(this.#_.texture),this.#_=null)}#je(){const e=this.#i;if(!(this.#b.length===L||this.#p===0)){this.#Q();for(let t=0;t<L;t++){const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#p,this.#y,0,e.RGBA,e.UNSIGNED_BYTE,null);const s=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,s),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(s),e.deleteTexture(i),this.#Q();return}this.#b.push({texture:i,framebuffer:s})}this.#K=L-1}}#Q(){const e=this.#i,t=this.#d?.kind==="texture"?this.#d.texture:null;this.#b.some(i=>i.texture===t)&&(this.#d=null);for(const{texture:i,framebuffer:s}of this.#b)e.deleteFramebuffer(s),e.deleteTexture(i);this.#b=[],this.#s.length=0}#Pt(){if(this.#W)return;const e=this.#e.parentElement;if(!e)return;const t=document.createElement("div");t.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(t,this.#e),t.appendChild(this.#e),t.appendChild(this.#t),this.#W=t,this.#Me?.observe(this.#e),this.#Re()}#It(){if(this.#c)return;const e=this.#W;this.#W=null,this.#Me?.disconnect(),this.#t.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#ut=()=>this.#Re();#Qe(e){return!this.#h||this.#r==="main"?!1:(this.#h.postMessage({type:"event",name:e,video:this.#We()}),!0)}#dt=()=>{if(this.#me=Number.NaN,this.#Qe("emptied")){this.#D(),this.#M(!1);return}this.#o=0,this.#ee=0,this.#s.length=0,this.#f=0,this.#mt(),this.#g(),this.#d=null,this.#M(!1)};#mt(){this.#k={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0},this.#N=0,this.#be=0,this.#Be=0,this.#B=0,this.#ne=0,this.#he=0,this.#ae=0,this.#q=0,this.#U=0,this.#g()}#g(){this.#s.length=0,this.#S="video",this.#Z="c",this.#Se=0,this.#Ae=!0,this.#De.reset(),this.#Ce=1/0,this.#we=1/0}#pt=()=>{if(this.#Qe("seeking")){this.#D();return}this.#te=!1};#C=e=>{if((e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#Qe(e.type)){this.#D();return}if(e.type==="seeked"){const i=this.#te;if(this.#te=!1,i)return;this.#o=0,this.#g(),this.#d=null,this.#M(!1);return}const t=e.type==="ratechange";if(t&&(this.#f=0,this.#ee=this.#e.currentTime),this.#s.length=0,this.#u&&this.#o>0){const i=this.#Xe(),s=i===null?void 0:this.#b[i];i!==null&&s?(this.#K=i,this.#ce(!0,!1,s.framebuffer),this.#ot(i)):this.#ce(!0,!1,null)}t&&(this.#o=0,this.#g())};#vt=e=>{if(e.preventDefault(),this.#c){this.#c.onFailure("the deinterlacer WebGL context was lost");return}this.#r!=="active"&&(this.#R=!0,this.stop())}}function be(d,e,t,i,s,r,n){return new Ee(d,t,{canvas:e,onFailure:i,onVisibility:s,requestAnimationFrame:r,cancelAnimationFrame:n})}function O(d,e){const t=d.createProgram(),i=ee(d,d.VERTEX_SHADER,ve),s=ee(d,d.FRAGMENT_SHADER,e);if(d.attachShader(t,i),d.attachShader(t,s),d.linkProgram(t),d.deleteShader(i),d.deleteShader(s),!d.getProgramParameter(t,d.LINK_STATUS)){const r=d.getProgramInfoLog(t);throw d.deleteProgram(t),new Error(`the deinterlacer failed to link: ${r??"no reason given"}`)}return t}function ee(d,e,t){const i=d.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(d.shaderSource(i,t),d.compileShader(i),!d.getShaderParameter(i,d.COMPILE_STATUS)){const s=d.getShaderInfoLog(i);throw d.deleteShader(i),new Error(`the deinterlacer failed to compile: ${s??"no reason given"}`)}return i}const I=self;class ye extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#n=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#n=e.buffered}get buffered(){return{length:this.#n.length,start:e=>{const t=this.#n[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.start},end:e=>{const t=this.#n[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let A=null,F=null,te=!1;function xe(d){return I.requestAnimationFrame(d)}function Te(d){I.cancelAnimationFrame(d)}function C(d,e=[]){I.postMessage(d,e)}function Fe(d,e){d.doubleRate=e.doubleRate,d.autoFilm=e.autoFilm,d.filmCombThreshold=e.filmCombThreshold}I.onmessage=d=>{const e=d.data;try{if(e.type==="initialize"){if(typeof I.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");A=new ye,A.update(e.video),F=be(A,e.canvas,e.options,t=>{te||C({type:"failed",message:t})},t=>C({type:"visibility",visible:t}),xe,Te),F.addEventListener("stats",t=>{const{dropped:i,...s}=t.detail;C({type:"stats",stats:s})}),F.scan=e.scan,F.videoTimeline=e.videoTimeline,F.enabled=e.enabled,C({type:"ready"});return}if(!A||!F)return;switch(e.type){case"frame":A.update(e.video);try{F.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),C({type:"consumed",id:e.id})}break;case"settings":Fe(F,e.options);break;case"scan":F.scan=e.scan;break;case"timeline":F.videoTimeline=e.videoTimeline;break;case"enabled":F.enabled=e.enabled;break;case"event":A.update(e.video),A.dispatchEvent(new Event(e.name));break;case"capture":A.videoWidth=e.width,A.videoHeight=e.height,F.capture().then(t=>C({type:"capture",id:e.id,image:t},[t])).catch(()=>C({type:"capture",id:e.id,image:null}));break;case"destroy":te=!0,F.destroy(),F=null,A=null,I.close();break}}catch(t){const i=t instanceof Error?t.message:String(t);C({type:"failed",message:i})}}})();
//# sourceMappingURL=worker-_KEaLoY0.js.map
