(function(){"use strict";const pe={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",parity:"uParity",tff:"uTff",spatialCheck:"uSpatialCheck"},ge=`#version 300 es
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
`,J={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",topFieldFirst:"uTopFieldFirst",match:"uMatch"},k=288,R=162,ve=`#version 300 es
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
  ivec2 targetSize = ivec2(${k}, ${R});
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
`,Ee=`#version 300 es
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
`,be=`#version 300 es
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
  ivec2 targetSize = ivec2(${k}, ${R});
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
`;class y{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#n;#i;#e;#s=0;#y=null;#h=[];#F=null;#W=1/0;#G=1/0;constructor(e,t){this.#n=e,this.#i=t,this.#e=255*y.DECIMATE_BLOCK**2*y.DUPLICATE_PERCENT/100}fieldMatch(e,t,i,r,s=y.COMBED_PIXEL_LIMIT){const n=r?1:0,o={p:e,c:t,n:i};let h=this.#P("c","p",n,o);const u=new Map,a=p=>{const E=u.get(p);if(E!==void 0)return E;const v=y.#I(this.weave(e,t,i,p,r),this.#n,this.#i);return u.set(p,v),v},g=a(h),f=a("n");(f*3<g||f*2<g&&g>s)&&Math.abs(f-g)>=30&&f<s&&(h="n");const c=a(h),d=c>=s;return d&&(h="c"),{match:h,combScore:c,isCombed:d,luma:this.weave(e,t,i,h,r)}}decimate(e){const t=this.#s,i=this.#F?y.#de(this.#F,e,this.#n,this.#i):{maxBlockDifference:1/0,totalDifference:1/0};this.#h.push(i);const r=this.#y===t,s=r&&i.maxBlockDifference<this.#e;r&&!s&&(this.#y=null);const n=this.#y;this.#F=e.slice(),this.#s++;let o=this.#y;if(this.#s===y.CYCLE){let h=0,u=null;for(let a=1;a<this.#h.length;a++)(this.#h[a]?.maxBlockDifference??1/0)<(this.#h[h]?.maxBlockDifference??1/0)?(u=h,h=a):(u===null||(this.#h[a]?.maxBlockDifference??1/0)<(this.#h[u]?.maxBlockDifference??1/0))&&(u=a);this.#W=this.#h[h]?.maxBlockDifference??1/0,this.#G=u===null?1/0:this.#h[u]?.maxBlockDifference??1/0,o=(this.#h[h]?.maxBlockDifference??1/0)<this.#e?h:null,this.#y=o,this.#h=[],this.#s=0}return{cycleIndex:t,maxBlockDifference:i.maxBlockDifference,totalDifference:i.totalDifference,shouldDrop:s,dropIndex:n,nextDropIndex:o,lowestCycleDifference:this.#W,runnerUpCycleDifference:this.#G}}weave(e,t,i,r,s){if(r==="c")return t.slice();const n=t.slice(),o=r==="p"?e:i,h=n.length/this.#i,u=s?1:0;for(let a=u;a<this.#i;a+=2)n.set(o.subarray(a*h,(a+1)*h),a*h);return n}reset(){this.#s=0,this.#y=null,this.#h=[],this.#F=null,this.#W=1/0,this.#G=1/0}#P(e,t,i,r){const s=this.#n,n=this.#i,o=2-i,h=2-i,u=r[e],a=r[t],g=y.#fe(u,a,s,n,i);let f=0,c=0,d=0,p=0,E=0,v=0;for(let B=2;B<n-2;B+=2){const M=(B-2)/2,se=o-1+M*2,re=o+1+M*2,ne=o+3+M*2,K=o+M*2,Q=K+2,z=h+M*2,P=z+2,de=o+M*2;for(let S=8;S<s-8;S++){const N=(g[de*s+S]??0)|(g[(de+2)*s+S]??0);if(N===0)continue;const me=(r.c[se*s+S]??0)+((r.c[re*s+S]??0)<<2)+(r.c[ne*s+S]??0),H=Math.abs(3*((u[K*s+S]??0)+(u[Q*s+S]??0))-me),W=Math.abs(3*((a[z*s+S]??0)+(a[P*s+S]??0))-me);H>23&&(N&1)!==0&&(f+=H),W>23&&(N&1)!==0&&(p+=W),H>42&&(N&2)!==0&&(c+=H),W>42&&(N&2)!==0&&(E+=W),H>42&&(N&4)!==0&&(d+=H),W>42&&(N&4)!==0&&(v+=W)}}c<500&&E<500&&(d>=500||v>=500)&&Math.max(d,v)>3*Math.min(d,v)&&(c=d,E=v);const x=Math.floor(f/6+.5),C=Math.floor(p/6+.5),b=Math.floor(c/6+.5),m=Math.floor(E/6+.5),Y=Math.max(x,C)/Math.max(Math.min(x,C),1),V=Math.max(b,m)/Math.max(Math.min(b,m),1),j=Math.max(b,m)/Math.max(Math.max(x,C),1);return(b>=500||m>=500)&&(b*2<m||m*2<b)||(b>=1e3||m>=1e3)&&(b*3<m*2||m*3<b*2)||(b>=2e3||m>=2e3)&&(b*5<m*4||m*5<b*4)||(b>=4e3||m>=4e3)&&V>Y||j>.005&&Math.max(b,m)>150&&(b*2<m||m*2<b)?b>m?t:e:x>C?t:e}static#fe(e,t,i,r,s){const n=Array.from({length:Math.ceil(r/2)},()=>new Uint8Array(i)),o=s===1?1:0;for(let a=0;a<n.length;a++){const g=Math.min(r-1,o+a*2),f=n[a];if(f)for(let c=0;c<i;c++)f[c]=Math.abs((e[g*i+c]??0)-(t[g*i+c]??0))}const h=new Uint8Array(i*r),u=s===1?3:2;for(let a=1;a<n.length-1;a++){const g=u+(a-1)*2;if(g>=r)break;const f=n[a];if(f)for(let c=1;c<i-1;c++){const d=f[c]??0;if(d<=3)continue;let p=0;for(let m=c-1;m<=c+1;m++)p+=(n[a-1]?.[m]??0)>3?1:0,p+=(n[a]?.[m]??0)>3?1:0,p+=(n[a+1]?.[m]??0)>3?1:0;if(p<=1)continue;const E=g*i+c;if(h[E]=1,d<=19)continue;p=0;let v=!1,x=!1;for(let m=c-1;m<=c+1;m++)(n[a-1]?.[m]??0)>19&&(p++,v=!0),(n[a]?.[m]??0)>19&&p++,(n[a+1]?.[m]??0)>19&&(p++,x=!0);if(p<=3)continue;if(v&&x){h[E]|=2;continue}let C=!1,b=!1;for(let m=Math.max(c-4,0);m<Math.min(c+5,i);m++)a!==1&&(n[a-2]?.[m]??0)>19&&(C=!0),(n[a-1]?.[m]??0)>19&&(v=!0),(n[a+1]?.[m]??0)>19&&(x=!0),a!==n.length-2&&(n[a+2]?.[m]??0)>19&&(b=!0);v&&(x||C)||x&&(v||b)?h[E]|=2:p>5&&(h[E]|=4)}}return h}static#I(e,t,i){const r=new Uint8Array(t*i),s=(o,h)=>e[Math.max(0,Math.min(i-1,h))*t+o]??0;for(let o=0;o<i;o++)for(let h=0;h<t;h++){const u=s(h,o),a=s(h,o===0?1:o-1),g=s(h,o===i-1?i-2:o+1),f=o<2?s(h,o===0?2:3):s(h,o-2),c=o+2>=i?s(h,o===i-1?i-3:i-4):s(h,o+2);(o===0?Math.abs(u-g)>y.COMB_THRESHOLD:o===i-1?Math.abs(u-a)>y.COMB_THRESHOLD:Math.abs(u-a)>y.COMB_THRESHOLD&&Math.abs(u-g)>y.COMB_THRESHOLD)&&Math.abs(4*u-3*(a+g)+f+c)>y.COMB_THRESHOLD*6&&(r[o*t+h]=255)}let n=0;for(const o of[0,8])for(const h of[0,8])for(let u=o;u<i;u+=16)for(let a=h;a<t;a+=16){let g=0;for(let f=Math.max(1,u);f<Math.min(i-1,u+16);f++)for(let c=a;c<Math.min(t,a+16);c++){const d=f*t+c;r[d-t]===255&&r[d]===255&&r[d+t]===255&&g++}n=Math.max(n,g)}return n}static#de(e,t,i,r){const s=y.DECIMATE_BLOCK/2,n=Math.ceil(i/s),o=Math.ceil(r/s),h=new Float64Array(n*o),u=e.length/(i*r);for(let f=0;f<r;f++){const c=Math.floor(f/s);for(let d=0;d<i;d++){const p=Math.floor(d/s),E=c*n+p,v=(f*i+d)*u;if(u===1){h[E]=(h[E]??0)+Math.abs((e[v]??0)-(t[v]??0));continue}const x=Math.round((e[v]??0)*.2126+(e[v+1]??0)*.7152+(e[v+2]??0)*.0722),C=Math.round((t[v]??0)*.2126+(t[v+1]??0)*.7152+(t[v+2]??0)*.0722);if(h[E]=(h[E]??0)+Math.abs(x-C),(d&1)!==0||(f&1)!==0)continue;let b=0,m=0,Y=0,V=0,j=0,B=0,M=0;for(let Q=f;Q<Math.min(f+2,r);Q++)for(let z=d;z<Math.min(d+2,i);z++){const P=(Q*i+z)*u;b+=e[P]??0,m+=e[P+1]??0,Y+=e[P+2]??0,V+=t[P]??0,j+=t[P+1]??0,B+=t[P+2]??0,M++}const se=Math.round((-.114572*b-.385428*m+.5*Y)/M),re=Math.round((-.114572*V-.385428*j+.5*B)/M),ne=Math.round((.5*b-.454153*m-.045847*Y)/M),K=Math.round((.5*V-.454153*j-.045847*B)/M);h[E]=(h[E]??0)+Math.abs(se-re)+Math.abs(ne-K)}}let a=-1;for(let f=0;f<o-1;f++)for(let c=0;c<n-1;c++)a=Math.max(a,(h[f*n+c]??0)+(h[f*n+c+1]??0)+(h[(f+1)*n+c]??0)+(h[(f+1)*n+c+1]??0));let g=0;for(const f of h)g+=f;return{maxBlockDifference:a,totalDifference:g}}}const ae=8192;let he=0,_=0,G=[],X=[];const O={requested:"auto",active:"starting",generation:0,reason:"module-loaded"};function Z(l){X.length===ae&&(X.shift(),_++),X.push(l)}function A(l){const e={...l,sequence:++he};if(typeof document<"u"){Z({...e,realm:"main",generation:O.generation,timeOriginMs:performance.timeOrigin});return}G.length===ae&&(G.shift(),_++),G.push(e)}function xe(){const l={timeOriginMs:performance.timeOrigin,events:G,droppedEvents:_};return G=[],_=0,l}function ye(l,e){for(const t of l.events)Z({...t,realm:"worker",generation:e,timeOriginMs:l.timeOriginMs});_+=l.droppedEvents}function I(l,e,t,i){O.requested=l,O.active=e,O.generation=t,O.reason=i,typeof document<"u"&&Z({kind:"backend",sequence:++he,realm:"main",generation:t,timeOriginMs:performance.timeOrigin,atMs:performance.now(),requested:l,active:e,reason:i})}typeof document<"u"&&(globalThis.__YADIF_RENDER_TRACE__={schemaVersion:2,get backend(){return{...O}},get droppedEvents(){return _},drain(){const l={events:X,droppedEvents:_};return X=[],_=0,l}});let Te=null;const Fe=.5,T=3,ee=5,U=ee+1,oe=1e3,te=4,ie=200,Me=.25,ke=1e3/60,Re=.02,Ae=250,Se=1e3/30;function le(l){if(!Number.isFinite(l)||l<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return l}const we=`#version 300 es
void main() {
  // One triangle over the whole viewport, from the vertex index alone. There
  // is no geometry here worth a buffer: every pixel is the fragment shader's.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`,De=`#version 300 es
precision highp float;
uniform sampler2D uField;
uniform bool uFlip;
out vec4 fragColor;
void main() {
  ivec2 position = ivec2(gl_FragCoord.xy);
  if (uFlip) position.y = textureSize(uField, 0).y - 1 - position.y;
  fragColor = texelFetch(uField, position, 0);
}
`;class Ce extends EventTarget{#n;#i;#e;#s;#y;#h;#F;#W;#G;#P=null;#fe=null;#I=null;#de=null;#ee=null;#$e=null;#U=null;#M=[];#o=[];#w=U-1;#f=null;#t=[];#B=null;#me=0;#N=null;#O=ke;#X=null;#Re;#k;#g;#q;#Ae;#D="video";#te="c";#Se=0;#we=!0;#De=new y(k,R);#Ce=1/0;#_e=1/0;#z=0;#d=0;#v=0;#T=0;#E=T-1;#l=0;#ie=0;#pe=Number.NaN;#se=!1;#Y=null;#ge=0;#V=0;#Le=0;#m=!1;#ve=!1;#Pe=!1;#c=null;#j=[];#R=!1;#Ie;#u;#Ee;#p;#Ue;#a=null;#r;#Q=!1;#A=0;#Be=!1;#vt=0;#re=!1;#be=!1;#$=null;#Et=0;#ne=new Map;#b={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0};#C=0;#Ne=0;#xe=0;#H=0;#ae=0;#he=0;#oe=0;#K=0;constructor(e,t={},i=null){super(),this.#e=e,this.#k=t.doubleRate??!1,this.#g=t.autoFilm??!1,this.#q=le(t.filmCombThreshold??y.COMBED_PIXEL_LIMIT),this.#Ae=t.spatialCheck??!0,this.#Ie=t.onStats,this.#u=i,this.#p=i?"main":t.rendering??"auto",this.#Ue=t.workerUrl??Te,this.#r=this.#p==="main"?"main":"idle",i||I(this.#p,this.#r==="main"?"main":"starting",this.#A,this.#r==="main"?"configured-main":"configured-auto"),this.#i=i?i.canvas:document.createElement("canvas"),this.#n=i?.canvas??(this.#p==="main"?this.#i:document.createElement("canvas")),this.#Ee=e,i||(this.#i.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const r=this.#n.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!r)throw new Error("this browser has no WebGL2");this.#s=r,this.#y=q(r,ge);const s=this.#y;this.#h=Object.fromEntries(Object.entries(pe).map(([n,o])=>[n,r.getUniformLocation(s,o)])),this.#F=q(r,De),this.#W=r.getUniformLocation(this.#F,"uField"),this.#G=r.getUniformLocation(this.#F,"uFlip"),this.#g&&this.#it(),this.#n.addEventListener("webglcontextlost",this.#gt),this.#Re=i?null:new ResizeObserver(()=>this.#ke()),e.addEventListener("emptied",this.#dt),e.addEventListener("resize",this.#ft),e.addEventListener("pause",this.#L),e.addEventListener("ended",this.#L),e.addEventListener("seeking",this.#pt),e.addEventListener("seeked",this.#L),e.addEventListener("ratechange",this.#L)}get running(){return this.#m&&(this.#c?.interlaced??!0)}get canvas(){return this.#i}get#ye(){return this.#c?.topFieldFirst!==!1}#Ke(){return{doubleRate:this.#k,autoFilm:this.#g,filmCombThreshold:this.#q,spatialCheck:this.#Ae}}get enabled(){return this.#ve}set enabled(e){this.#ve=e,this.#ze(),this.#a?.postMessage({type:"enabled",enabled:e})}set scan(e){const t=this.#c?.interlaced!==e?.interlaced,i=t||this.#c?.topFieldFirst!==e?.topFieldFirst;this.#c=e,this.#a?.postMessage({type:"scan",scan:e}),i&&(this.#l=0,this.#x(),t&&(this.#d=0),this.#f=null,this.#S(!1)),this.#ze(),i&&((e?.interlaced??!0)&&(this.#u||this.#r==="main")?this.#J():this.#Xe())}get scan(){return this.#c}set videoTimeline(e){this.#j=e,this.#a?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#c=null),this.#ze()}get videoTimeline(){return this.#j}get container(){return this.#X??this.#e}get doubleRate(){return this.#k}set doubleRate(e){e!==this.#k&&(this.#k=e,this.#Oe(),this.#t.length=0,e?(this.#v>0&&this.#je(),(this.#c?.interlaced??!0)&&(this.#u||this.#r==="main")&&this.#J()):this.#g||(this.#f=null,this.#S(!1),this.#Z()))}get autoFilm(){return this.#g}set autoFilm(e){e!==this.#g&&(this.#g=e,this.#Oe(),this.#x(),e?(this.#it(),this.#v>0&&(this.#ut(),this.#je()),(this.#c?.interlaced??!0)&&(this.#u||this.#r==="main")&&this.#J()):(this.#Ve(),this.#k||(this.#f=null,this.#S(!1),this.#Z())))}get filmCombThreshold(){return this.#q}set filmCombThreshold(e){const t=le(e);t!==this.#q&&(this.#q=t,this.#Oe(),this.#g&&this.#x())}#Oe(){this.#a?.postMessage({type:"settings",options:this.#Ke()})}#ze(){this.#ve&&(this.#j.length>0||(this.#c?.interlaced??!0))?this.start():this.stop()}#bt(){return this.#u||this.#p==="main"?!1:this.#r==="starting"||this.#r==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#Ue!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#Je(),!0):this.#p==="auto"?(this.#Te("capability-fallback"),!1):(this.#r="failed",this.#m=!1,I(this.#p,"failed",this.#A,"required-worker-unavailable"),!0)}#Je(){this.#_(),this.#a?.terminate(),this.#a=null,this.#re=!1,this.#be=!1;let e=this.#i;if(this.#Be){e=document.createElement("canvas"),e.className=this.#i.className;const s=this.#i.getAttribute("style");s===null?e.removeAttribute("style"):e.setAttribute("style",s),e.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(e),this.#i=e}const t=++this.#A;this.#r="starting",I(this.#p,"starting",t,this.#Q?"worker-restarting":"worker-starting");let i,r;try{r=e.transferControlToOffscreen(),this.#Be=!0,i=new Worker(this.#Ue,{type:"module"})}catch(s){this.#le(s instanceof Error?s.message:String(s));return}this.#a=i,i.onmessage=s=>{t===this.#A&&this.#xt(s.data)},i.onerror=s=>{t===this.#A&&(s.preventDefault(),this.#le(s.message||"the deinterlacer worker failed"))},i.postMessage({type:"initialize",canvas:r,options:this.#Ke(),scan:this.#c,videoTimeline:this.#j,enabled:this.#m,video:this.#He()},[r])}#xt(e){switch(e.type){case"ready":this.#r="active",I(this.#p,"worker",this.#A,"worker-ready"),this.#m&&(this.#ce(),this.#qe());break;case"failed":this.#le(e.message);break;case"consumed":{this.#re=!1,this.#be=!0;const t=this.#$;this.#$=null,t&&this.#et(t);break}case"visibility":this.#i.style.visibility=e.visible?"visible":"hidden";break;case"stats":{const t={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0};this.dispatchEvent(new CustomEvent("stats",{detail:t})),this.#Ie?.(t);break}case"diagnostic-batch":ye(e.batch,this.#A);break;case"capture":{const t=this.#ne.get(e.id);if(this.#ne.delete(e.id),!t){e.image?.close();break}e.image?t.resolve(e.image):createImageBitmap(this.#e).then(t.resolve,t.reject);break}}}#le(e){if(this.#r==="starting"&&this.#p==="auto"&&!this.#Q){this.#Te("initialization-fallback");return}if(this.#Ze(e),!this.#Q){this.#Q=!0,this.#Je();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#r="failed",I(this.#p,"failed",this.#A,"worker-terminal-failure"),this.#a?.terminate(),this.#a=null,this.#_(),this.stop()}#Te(e){const t=this.#n;t.className=this.#i.className;const i=this.#i.getAttribute("style");i===null?t.removeAttribute("style"):t.setAttribute("style",i),t.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(t),this.#i=t,this.#Be=!1,this.#a?.terminate(),this.#a=null,this.#r="main",I(this.#p,"main",this.#A,e),this.#_(),this.#m&&(this.#ce(),this.#qe(),(this.#c?.interlaced??!0)&&this.#J())}#_(){this.#$?.frame.close(),this.#$=null}#Ze(e){for(const t of this.#ne.values())t.reject(new Error(e));this.#ne.clear()}start(){if(!(this.#m||this.#Pe||this.#R)){if(this.#m=!0,this.#mt(),this.#x(),this.#ge=performance.now(),this.#Le=this.#ge,this.#pe=Number.NaN,this.#V=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#Pt(),this.#qe(),this.#bt()){this.#a?.postMessage({type:"enabled",enabled:!0}),this.#r==="active"&&this.#ce();return}this.#ce(),(this.#c?.interlaced??!0)&&this.#J()}}stop(){this.#m&&(this.#m=!1,this.#Y!==null&&this.#e.cancelVideoFrameCallback(this.#Y),this.#Y=null,this.#St(),this.#Xe(),this.#l=0,this.#f=null,this.#S(!1),this.#_(),this.#a?.postMessage({type:"enabled",enabled:!1}))}destroy(){if(!this.#Pe){this.#Pe=!0,this.#ve=!1,this.stop(),this.#a?.postMessage({type:"destroy"}),this.#a?.terminate(),this.#a=null,I(this.#p,"failed",this.#A,"destroyed"),this.#_(),this.#Ze("the deinterlacer was destroyed"),this.#n.removeEventListener("webglcontextlost",this.#gt),this.#e.removeEventListener("emptied",this.#dt),this.#e.removeEventListener("resize",this.#ft),this.#e.removeEventListener("pause",this.#L),this.#e.removeEventListener("ended",this.#L),this.#e.removeEventListener("seeking",this.#pt),this.#e.removeEventListener("seeked",this.#L),this.#e.removeEventListener("ratechange",this.#L),this.#It();for(const e of this.#M)this.#s.deleteTexture(e);this.#M=[],this.#Z(),this.#Ve(),this.#s.deleteProgram(this.#y),this.#s.deleteProgram(this.#F),this.#P&&this.#s.deleteProgram(this.#P),this.#I&&this.#s.deleteProgram(this.#I),this.#ee&&this.#s.deleteProgram(this.#ee),this.#s.getExtension("WEBGL_lose_context")?.loseContext()}}capture(){if(this.#r==="active"&&this.#i.style.visibility==="visible"&&this.#a){const r=++this.#Et,s=new Promise((n,o)=>{this.#ne.set(r,{resolve:n,reject:o})});return this.#a.postMessage({type:"capture",id:r,width:this.#e.videoWidth,height:this.#e.videoHeight}),s}if(this.#r==="starting"||this.#r==="failed")return createImageBitmap(this.#e);const e=this.#f;if(this.#u&&(!this.#m||this.#R||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#m||this.#R||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#Ye(e.texture,e.flip,!1):e.kind==="yadif"?this.#ue(e.flush,e.second,null,!1):this.#We(null,!1);const t=this.#e.videoWidth,i=this.#e.videoHeight;return t>0&&i>0&&(t!==this.#n.width||i!==this.#n.height)?createImageBitmap(this.#n,{resizeWidth:t,resizeHeight:i,resizeQuality:"high"}):createImageBitmap(this.#n)}addEventListener(e,t,i){super.addEventListener(e,t,i)}removeEventListener(e,t,i){super.removeEventListener(e,t,i)}#ce(){this.#u||!this.#m||this.#Y!==null||(this.#Y=this.#e.requestVideoFrameCallback(this.#Tt))}#He(){const e=[];for(let t=0;t<this.#e.buffered.length;t++)e.push({start:this.#e.buffered.start(t),end:this.#e.buffered.end(t)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#yt(e,t){let i;try{i=new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(t.mediaTime*1e6))})}catch(s){const n=s instanceof Error?s.message:String(s);this.#p==="auto"&&!this.#be&&!this.#Q?(this.#Te("video-frame-fallback"),this.#Fe(e,t)):this.#le(n);return}const r={id:++this.#vt,frame:i,now:e,metadata:t,video:this.#He()};if(this.#re){this.#$?.frame.close(),this.#$=r;return}this.#et(r)}#et(e){const t=this.#a;if(!t||this.#r!=="active"){e.frame.close();return}this.#re=!0;const i={type:"frame",...e};try{t.postMessage(i,[e.frame])}catch(r){this.#re=!1,e.frame.close();const s=r instanceof Error?r.message:String(r);this.#p==="auto"&&!this.#be&&!this.#Q?(this.#Te("transfer-fallback"),this.#Fe(e.now,e.metadata)):this.#le(s)}}#Tt=(e,t)=>{this.#Y=null,!(!this.#m||this.#R)&&(this.#ge=e,this.#V=Math.max(this.#V,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0),A({kind:"frame-ingest",atMs:e,mediaTime:t.mediaTime,presentedFrames:t.presentedFrames,path:"callback"}),this.#tt(e,t),this.#ce())};#tt(e,t){if(this.#pe=t.mediaTime,this.#r==="active"){this.#yt(e,t);return}this.#r!=="starting"&&this.#Fe(e,t)}ingestExternalFrame(e,t,i){A({kind:"frame-ingest",atMs:e,mediaTime:t.mediaTime,presentedFrames:t.presentedFrames,path:"worker-transfer"}),this.#Ee=i;try{this.#Fe(e,t)}finally{this.#Ee=this.#e}}#Fe(e,t){if(this.#Ft(t.mediaTime),t.width>0&&t.height>0){let i=!1;if(!this.#se&&this.#e.seeking){const c=this.#e.buffered,d=this.#d>=te?this.#d/1e3:ie/1e3;for(let p=0;p<c.length;p++)if(t.mediaTime>=c.start(p)&&t.mediaTime<c.end(p)&&Math.abs(t.mediaTime-this.#e.currentTime)<=d){i=!0;break}}if(i&&(this.#se=!0),(this.#v===0||this.#T===0)&&this.#ct(t.width,t.height),this.#c&&!this.#c.interlaced){this.#Ct();return}const r=t.mediaTime-this.#ie,s=i||r<0||r>Fe;s&&(this.#l=0,this.#d=0,this.#b.discontinuities++,this.#t.length=0,this.#x());const n=this.#g&&this.#C!==0&&t.presentedFrames-this.#C>1;if(this.#_t(t.presentedFrames,s),!s&&n&&(this.#l=0,this.#x()),this.#l>0&&t.mediaTime===this.#ie)return;!s&&r>0&&this.#Mt(r),this.#ie=t.mediaTime;const o=performance.now();o-this.#Ne>oe&&(this.#xe=o,this.#H=0,this.#ae=0,this.#he=0,this.#oe=0,this.#K=0,this.#z=0),this.#Ne=o;const h=performance.now();this.#lt();const u=this.#D,a=this.#g&&this.#l===T&&this.#kt();if(u!==this.#D&&(this.#t.length=0),!(a&&this.#Me()))if(this.#g&&!this.#we&&this.#D==="film")if(this.#Me()){const c=this.#d*5/4,d=this.#rt(1,e,c),p=this.#t.at(-1),E=d?e:p==null?e+c:p.at+p.duration;this.#Rt(E,c)}else this.#We(null);else if(this.#k&&this.#Me()){const c=this.#d/2,d=this.#rt(2,e,c),p=this.#t.at(-1),E=d?e:p==null?e+c*2:p.at+p.duration;this.#st(!1,E,c),this.#st(!0,E+c,c)}else this.#b.late+=this.#t.length,this.#t.length=0,this.#ue(!1,!1,null);this.#K=Math.max(this.#K,this.#t.length),this.#ae+=performance.now()-h,this.#H++,this.#Lt(o)}}#Ft(e){let t;for(let s=this.#j.length-1;s>=0;s--){const n=this.#j[s];if(n.start<=e+1e-6){t=n;break}}t?.codedSize&&(t.codedSize.width!==this.#v||t.codedSize.height!==this.#T)&&this.#ct(t.codedSize.width,t.codedSize.height);const i=t?.scan;if(!i||this.#c?.interlaced===i.interlaced&&this.#c.topFieldFirst===i.topFieldFirst)return;const r=this.#c?.interlaced;this.#c=i,this.#l=0,this.#t.length=0,this.#x(),r!==i.interlaced&&(this.#d=0),i.interlaced&&(this.#u||this.#r==="main")?this.#J():this.#Xe()}#Me(){return(this.#k||this.#g)&&this.#d>0&&this.#o.length===U}#Mt(e){const t=e*1e3/(this.#e.playbackRate||1),i=this.#d>0?Math.max(1,Math.round(t/this.#d)):1,r=t/i;r<te||r>ie||(this.#d=this.#d>0?this.#d+(r-this.#d)*Me:r)}#it(){if(this.#P&&this.#I&&this.#ee)return;const e=this.#s,t=q(e,ve),i=q(e,Ee),r=q(e,be);this.#P=t,this.#fe=Object.fromEntries(Object.entries(J).filter(([s])=>s!=="match"&&s!=="topFieldFirst").map(([s,n])=>[s,e.getUniformLocation(t,n)])),this.#I=i,this.#de=Object.fromEntries(Object.entries(J).map(([s,n])=>[s,e.getUniformLocation(i,n)])),this.#ee=r,this.#$e=Object.fromEntries(Object.entries(J).map(([s,n])=>[s,e.getUniformLocation(r,n)]))}#kt(){const e=this.#U,t=this.#P,i=this.#fe,r=this.#ee,s=this.#$e;if(!e||!t||!i||!r||!s)return!1;const n=this.#s,o=this.#E,h=(this.#E+T-1)%T,u=(this.#E+1)%T,a=this.#ye;n.bindFramebuffer(n.FRAMEBUFFER,e.framebuffer),n.useProgram(t);for(const[v,x]of[u,h,o].entries())n.activeTexture(n.TEXTURE0+v),n.bindTexture(n.TEXTURE_2D,this.#M[x]??null);n.uniform1i(i.prev,0),n.uniform1i(i.cur,1),n.uniform1i(i.next,2),n.uniform2i(i.size,this.#v,this.#T),n.viewport(0,0,k,R),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,k,R,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const{previousLuma:g,currentLuma:f,nextLuma:c}=e;for(let v=0;v<g.length;v++){const x=v*4;g[v]=e.pixels[x]??0,f[v]=e.pixels[x+1]??0,c[v]=e.pixels[x+2]??0}const d=this.#De.fieldMatch(g,f,c,a,this.#q);n.useProgram(r),n.uniform1i(s.prev,0),n.uniform1i(s.cur,1),n.uniform1i(s.next,2),n.uniform2i(s.size,this.#v,this.#T),n.uniform1i(s.topFieldFirst,a?1:0),n.uniform1i(s.match,d.match==="p"?0:d.match==="c"?1:2),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,k,R,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const p=this.#De.decimate(e.pixels);this.#te=d.match,this.#Se=d.combScore,this.#we=d.isCombed,this.#Ce=p.lowestCycleDifference,this.#_e=p.runnerUpCycleDifference;const E=p.dropIndex!==null&&!d.isCombed;return(E?"film":"video")!==this.#D&&(this.#D=E?"film":"video"),p.shouldDrop&&!d.isCombed}#Rt(e,t){const i=this.#Ge();if(i===null)return;const r=this.#o[i];if(r){for(this.#w=i;this.#t.length>0&&this.#t[0]?.slot===i;)this.#t.shift(),this.#b.late++;this.#We(r.framebuffer),this.#t.push({slot:i,at:e,duration:t})}}#We(e,t=!0){const i=this.#I,r=this.#de;if(!i||!r)return;const s=this.#s,n=this.#E,o=(this.#E+T-1)%T,h=(this.#E+1)%T,u=this.#ye;s.bindFramebuffer(s.FRAMEBUFFER,e),s.useProgram(i);for(const[a,g]of[h,o,n].entries())s.activeTexture(s.TEXTURE0+a),s.bindTexture(s.TEXTURE_2D,this.#M[g]??null);s.uniform1i(r.prev,0),s.uniform1i(r.cur,1),s.uniform1i(r.next,2),s.uniform2i(r.size,this.#v,this.#T),s.uniform1i(r.topFieldFirst,u?1:0),s.uniform1i(r.match,this.#te==="p"?0:this.#te==="c"?1:2),s.viewport(0,0,this.#v,this.#T),s.drawArrays(s.TRIANGLES,0,3),e===null&&(this.#f={kind:"film"},this.#S(!0),t&&(this.#z++,A({kind:"draw-submit",atMs:performance.now(),rafAtMs:null,scheduledAtMs:null,queueDepthAfter:this.#t.length,path:"film-direct"})))}#st(e,t,i){const r=this.#Ge();if(r===null)return;const s=this.#o[r];if(s){for(this.#w=r;this.#t.length>0&&this.#t[0]?.slot===r;)this.#t.shift(),this.#b.late++;this.#ue(!1,e,s.framebuffer),this.#t.push({slot:r,at:t,duration:i})}}#rt(e,t,i){const r=this.#t.at(-1),s=(ee+1)*Math.max(this.#O,i);if(r&&r.at-t>s)return this.#t.length=0,this.#b.queueResetted++,!0;const n=Math.max(0,this.#t.length+e-ee);let o=0,h=0;for(;h<n;){const u=this.#t.shift();if(!u)break;o+=u.duration,h++}for(const u of this.#t)u.at-=o;return this.#b.late+=h,!1}#Ge(){const e=this.#f?.kind==="texture"?this.#f.texture:null,t=this.#o.findIndex(n=>n?.texture===e),i=t<0?null:t,r=new Set(this.#t.map(({slot:n})=>n));for(let n=1;n<=U;n++){const o=(this.#w+n)%U,h=this.#o[o];if(h&&h.texture!==e&&!r.has(o))return o}const s=this.#t[0];if(s){const n=this.#o[s.slot];if(n&&n.texture!==e)return A({kind:"slot-pressure",atMs:performance.now(),outcome:"oldest",resultSlot:s.slot,outputPoolLength:this.#o.length,initializedOutputs:this.#o.filter(Boolean).length,outputHead:this.#w,shownSlot:i,queuedSlots:[...r]}),s.slot}return A({kind:"slot-pressure",atMs:performance.now(),outcome:"none",resultSlot:null,outputPoolLength:this.#o.length,initializedOutputs:this.#o.filter(Boolean).length,outputHead:this.#w,shownSlot:i,queuedSlots:[...r]}),null}#J(){this.#B===null&&(!this.#m||this.#R||(this.#me=0,this.#B=this.#at(this.#nt)))}#Xe(){this.#B!==null&&this.#At(this.#B),this.#B=null,this.#t.length=0}#nt=e=>{if(this.#B=null,!this.#m||this.#R)return;const t=this.#me>0?e-this.#me:null;if(t!==null){const s=t;s>=1&&s<=ie&&(this.#O=s<this.#O?s:this.#O+(s-this.#O)*Re)}this.#me=e;const i=this.#f?.kind==="texture"?this.#f.texture:null,r=this.#o.findIndex(s=>s?.texture===i);A({kind:"raf",atMs:e,gapMs:t,queueDepth:this.#t.length,refreshMs:this.#O,outputPoolLength:this.#o.length,initializedOutputs:this.#o.filter(Boolean).length,outputHead:this.#w,shownSlot:r<0?null:r,queue:this.#t.map(({slot:s,at:n,duration:o})=>({slot:s,atMs:n,durationMs:o}))}),this.#r==="main"&&this.#Dt(e),this.#B=this.#at(this.#nt)};#at(e){return this.#u?this.#u.requestAnimationFrame(e):requestAnimationFrame(e)}#At(e){this.#u?this.#u.cancelAnimationFrame(e):cancelAnimationFrame(e)}#qe(){this.#u||this.#N!==null||!this.#m||this.#R||(this.#N=requestAnimationFrame(this.#ht))}#St(){this.#N!==null&&cancelAnimationFrame(this.#N),this.#N=null}#ht=e=>{this.#N=null,!(!this.#m||this.#R)&&(this.#wt(e),this.#N=requestAnimationFrame(this.#ht))};#wt(e){if(this.#u||e-this.#ge<Ae||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const t=this.#e.currentTime,i=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,r=this.#d>=te?this.#d:Se,s=i>this.#V,n=t!==this.#pe&&e-this.#Le>=r*.75;!s&&!n||(this.#V=Math.max(this.#V,i),this.#Le=e,A({kind:"frame-ingest",atMs:e,mediaTime:t,presentedFrames:Math.max(this.#C+1,i),path:"watchdog"}),this.#tt(e,{mediaTime:t,presentedFrames:Math.max(this.#C+1,i),width:this.#e.videoWidth,height:this.#e.videoHeight}))}#Dt(e){const t=e+this.#O*1.5;for(;this.#t[1]&&this.#t[1].at<=t;)this.#b.late++,this.#t.shift();let i=this.#t[0];if(!i||i.at>t)return;this.#t.shift();const r=performance.now();this.#ot(i.slot);const s=performance.now();this.#oe+=s-r,this.#he++,A({kind:"draw-submit",atMs:s,rafAtMs:e,scheduledAtMs:i.at,queueDepthAfter:this.#t.length,path:"scheduled"})}#ot(e){const t=this.#o[e];t&&this.#Ye(t.texture)}#Ct(){this.#lt();const e=this.#M[this.#E];e&&(this.#Ye(e,!0),A({kind:"draw-submit",atMs:performance.now(),rafAtMs:null,scheduledAtMs:null,queueDepthAfter:this.#t.length,path:"progressive"})),this.#l=0}#S(e){if(this.#u){this.#u.onVisibility(e);return}this.#i.style.visibility=e?"visible":"hidden"}#Ye(e,t=!1,i=!0){const r=this.#s;r.bindFramebuffer(r.FRAMEBUFFER,null),r.useProgram(this.#F),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,e),r.uniform1i(this.#W,0),r.uniform1i(this.#G,t?1:0),r.viewport(0,0,this.#v,this.#T),r.drawArrays(r.TRIANGLES,0,3),this.#f={kind:"texture",texture:e,flip:t},this.#S(!0),i&&this.#z++}#_t(e,t){this.#C!==0&&!t&&(this.#b.missed+=Math.max(0,e-this.#C-1)),this.#C=e}#Lt(e){const t=e-this.#xe;if(t<oe)return;const i=this.#Me()&&(this.#k||this.#D==="film")?this.#he:this.#H,r={...this.#b,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:i*1e3/t,frameMs:this.#H===0?0:(this.#ae+this.#oe)/this.#H,maxQueuedFields:this.#K,mode:this.#D,match:this.#te,combScore:this.#Se,outputFps:this.#z*1e3/t,duplicateScore:this.#Ce,duplicateRunnerUp:this.#_e};this.dispatchEvent(new CustomEvent("stats",{detail:r})),this.#Ie?.(r),this.#xe=e,this.#H=0,this.#ae=0,this.#he=0,this.#oe=0,this.#K=0,this.#z=0}#lt(){const e=this.#s;this.#E=(this.#E+1)%T,e.bindTexture(e.TEXTURE_2D,this.#M[this.#E]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#Ee),this.#l=Math.min(this.#l+1,T)}#ue(e,t,i,r=!0){if(this.#l===0||this.#R)return;r&&(this.#l===T&&!e?this.#b.filtered++:this.#b.degraded++);const s=this.#s,n=this.#E,o=(this.#E+T-1)%T,h=(this.#E+1)%T;let u,a,g;this.#l===1?u=a=g=n:e?(u=o,a=g=n):this.#l===2?(u=a=o,g=n):(u=h,a=o,g=n),s.bindFramebuffer(s.FRAMEBUFFER,i),s.useProgram(this.#y);for(const[c,d]of[u,a,g].entries())s.activeTexture(s.TEXTURE0+c),s.bindTexture(s.TEXTURE_2D,this.#M[d]??null);s.uniform1i(this.#h.prev,0),s.uniform1i(this.#h.cur,1),s.uniform1i(this.#h.next,2),s.uniform2i(this.#h.size,this.#v,this.#T);const f=this.#ye?0:1;s.uniform1i(this.#h.parity,t?1-f:f),s.uniform1i(this.#h.tff,this.#ye?1:0),s.uniform1i(this.#h.spatialCheck,this.#Ae?1:0),s.viewport(0,0,this.#v,this.#T),s.drawArrays(s.TRIANGLES,0,3),i===null&&(this.#f={kind:"yadif",flush:e,second:t},this.#S(!0),r&&(this.#z++,A({kind:"draw-submit",atMs:performance.now(),rafAtMs:null,scheduledAtMs:null,queueDepthAfter:this.#t.length,path:e?"flush":"yadif-direct"})))}#ke(){if(!this.#X)return;const e=this.#e,t=e.videoWidth,i=e.videoHeight;if(t===0||i===0)return;const r=Math.min(e.offsetWidth/t,e.offsetHeight/i),s=t*r,n=i*r;this.#i.style.left=`${e.offsetLeft+(e.offsetWidth-s)/2}px`,this.#i.style.top=`${e.offsetTop+(e.offsetHeight-n)/2}px`,this.#i.style.width=`${s}px`,this.#i.style.height=`${n}px`}#ct(e,t){const i=this.#s;this.#n.width=e,this.#n.height=t,this.#v=e,this.#T=t,this.#l=0,this.#f=null,this.#x(),this.#ke();for(const r of this.#M)i.deleteTexture(r);this.#M=[];for(let r=0;r<T;r++){const s=i.createTexture();i.bindTexture(i.TEXTURE_2D,s),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,e,t,0,i.RGBA,i.UNSIGNED_BYTE,null),this.#M.push(s)}this.#Z(),this.#Ve(),this.#g&&this.#ut(),(this.#k||this.#g)&&this.#je()}#ut(){if(this.#U)return;const e=this.#s,t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,k,R,0,e.RGBA,e.UNSIGNED_BYTE,null);const i=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,i),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(i),e.deleteTexture(t);return}this.#U={texture:t,framebuffer:i,pixels:new Uint8Array(k*R*4),previousLuma:new Uint8Array(k*R),currentLuma:new Uint8Array(k*R),nextLuma:new Uint8Array(k*R)}}#Ve(){this.#U&&(this.#s.deleteFramebuffer(this.#U.framebuffer),this.#s.deleteTexture(this.#U.texture),this.#U=null)}#je(){const e=this.#s;if(!(this.#o.length===U||this.#v===0)){this.#Z();for(let t=0;t<U;t++){const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#v,this.#T,0,e.RGBA,e.UNSIGNED_BYTE,null);const r=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,r),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const s=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!s){e.deleteFramebuffer(r),e.deleteTexture(i),this.#Z();return}this.#o.push({texture:i,framebuffer:r})}this.#w=U-1}}#Z(){const e=this.#s,t=this.#f?.kind==="texture"?this.#f.texture:null;this.#o.some(i=>i.texture===t)&&(this.#f=null);for(const{texture:i,framebuffer:r}of this.#o)e.deleteFramebuffer(r),e.deleteTexture(i);this.#o=[],this.#t.length=0}#Pt(){if(this.#X)return;const e=this.#e.parentElement;if(!e)return;const t=document.createElement("div");t.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(t,this.#e),t.appendChild(this.#e),t.appendChild(this.#i),this.#X=t,this.#Re?.observe(this.#e),this.#ke()}#It(){if(this.#u)return;const e=this.#X;this.#X=null,this.#Re?.disconnect(),this.#i.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#ft=()=>this.#ke();#Qe(e){return!this.#a||this.#r==="main"?!1:(this.#a.postMessage({type:"event",name:e,video:this.#He()}),!0)}#dt=()=>{if(this.#pe=Number.NaN,this.#Qe("emptied")){this.#_(),this.#S(!1);return}this.#l=0,this.#ie=0,this.#t.length=0,this.#d=0,this.#mt(),this.#x(),this.#f=null,this.#S(!1)};#mt(){this.#b={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0},this.#C=0,this.#xe=0,this.#Ne=0,this.#H=0,this.#ae=0,this.#he=0,this.#oe=0,this.#K=0,this.#z=0,this.#x()}#x(){this.#t.length=0,this.#D="video",this.#te="c",this.#Se=0,this.#we=!0,this.#De.reset(),this.#Ce=1/0,this.#_e=1/0}#pt=()=>{if(this.#Qe("seeking")){this.#_();return}this.#se=!1};#L=e=>{if((e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#Qe(e.type)){this.#_();return}if(e.type==="seeked"){const i=this.#se;if(this.#se=!1,i)return;this.#l=0,this.#x(),this.#f=null,this.#S(!1);return}const t=e.type==="ratechange";if(t&&(this.#d=0,this.#ie=this.#e.currentTime),this.#t.length=0,this.#m&&this.#l>0){const i=this.#Ge(),r=i===null?void 0:this.#o[i];i!==null&&r?(this.#w=i,this.#ue(!0,!1,r.framebuffer),this.#ot(i),A({kind:"draw-submit",atMs:performance.now(),rafAtMs:null,scheduledAtMs:null,queueDepthAfter:this.#t.length,path:"flush"})):this.#ue(!0,!1,null)}t&&(this.#l=0,this.#x())};#gt=e=>{if(e.preventDefault(),this.#u){this.#u.onFailure("the deinterlacer WebGL context was lost");return}this.#r!=="active"&&(this.#R=!0,this.stop())}}function _e(l,e,t,i,r,s,n){return new Ce(l,t,{canvas:e,onFailure:i,onVisibility:r,requestAnimationFrame:s,cancelAnimationFrame:n})}function q(l,e){const t=l.createProgram(),i=ce(l,l.VERTEX_SHADER,we),r=ce(l,l.FRAGMENT_SHADER,e);if(l.attachShader(t,i),l.attachShader(t,r),l.linkProgram(t),l.deleteShader(i),l.deleteShader(r),!l.getProgramParameter(t,l.LINK_STATUS)){const s=l.getProgramInfoLog(t);throw l.deleteProgram(t),new Error(`the deinterlacer failed to link: ${s??"no reason given"}`)}return t}function ce(l,e,t){const i=l.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(l.shaderSource(i,t),l.compileShader(i),!l.getShaderParameter(i,l.COMPILE_STATUS)){const r=l.getShaderInfoLog(i);throw l.deleteShader(i),new Error(`the deinterlacer failed to compile: ${r??"no reason given"}`)}return i}const L=self;class Le extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#n=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#n=e.buffered}get buffered(){return{length:this.#n.length,start:e=>{const t=this.#n[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.start},end:e=>{const t=this.#n[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let w=null,F=null,ue=!1,$=null;function fe(){const l=xe();(l.events.length>0||l.droppedEvents>0)&&D({type:"diagnostic-batch",batch:l})}function Pe(l){return L.requestAnimationFrame(l)}function Ie(l){L.cancelAnimationFrame(l)}function D(l,e=[]){L.postMessage(l,e)}function Ue(l,e){l.doubleRate=e.doubleRate,l.autoFilm=e.autoFilm,l.filmCombThreshold=e.filmCombThreshold}L.onmessage=l=>{const e=l.data;try{if(e.type==="initialize"){if(typeof L.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");w=new Le,w.update(e.video),F=_e(w,e.canvas,e.options,t=>{ue||D({type:"failed",message:t})},t=>D({type:"visibility",visible:t}),Pe,Ie),F.addEventListener("stats",t=>{const{dropped:i,...r}=t.detail;D({type:"stats",stats:r})}),F.scan=e.scan,F.videoTimeline=e.videoTimeline,F.enabled=e.enabled,$=L.setInterval(fe,250),D({type:"ready"});return}if(!w||!F)return;switch(e.type){case"frame":w.update(e.video);try{F.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),D({type:"consumed",id:e.id})}break;case"settings":Ue(F,e.options);break;case"scan":F.scan=e.scan;break;case"timeline":F.videoTimeline=e.videoTimeline;break;case"enabled":F.enabled=e.enabled;break;case"event":w.update(e.video),w.dispatchEvent(new Event(e.name));break;case"capture":w.videoWidth=e.width,w.videoHeight=e.height,F.capture().then(t=>D({type:"capture",id:e.id,image:t},[t])).catch(()=>D({type:"capture",id:e.id,image:null}));break;case"destroy":ue=!0,$!==null&&L.clearInterval($),$=null,fe(),F.destroy(),F=null,w=null,L.close();break}}catch(t){const i=t instanceof Error?t.message:String(t);D({type:"failed",message:i})}}})();
//# sourceMappingURL=worker-DfV7pbdB.js.map
