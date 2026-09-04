(function(){"use strict";const pe={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",parity:"uParity",tff:"uTff",spatialCheck:"uSpatialCheck"},ve=`#version 300 es
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
`,J={prev:"uPrev",cur:"uCur",next:"uNext",size:"uSize",topFieldFirst:"uTopFieldFirst",match:"uMatch"},k=288,R=162,ge=`#version 300 es
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
`;class x{static CYCLE=5;static COMB_THRESHOLD=9;static COMBED_PIXEL_LIMIT=80;static DECIMATE_BLOCK=32;static DUPLICATE_PERCENT=1.1;#n;#i;#e;#s=0;#x=null;#h=[];#F=null;#z=1/0;#W=1/0;constructor(e,t){this.#n=e,this.#i=t,this.#e=255*x.DECIMATE_BLOCK**2*x.DUPLICATE_PERCENT/100}fieldMatch(e,t,i,s,r=x.COMBED_PIXEL_LIMIT){const n=s?1:0,l={p:e,c:t,n:i};let h=this.#_("c","p",n,l);const f=new Map,a=p=>{const E=f.get(p);if(E!==void 0)return E;const g=x.#L(this.weave(e,t,i,p,s),this.#n,this.#i);return f.set(p,g),g},v=a(h),u=a("n");(u*3<v||u*2<v&&v>r)&&Math.abs(u-v)>=30&&u<r&&(h="n");const c=a(h),d=c>=r;return d&&(h="c"),{match:h,combScore:c,isCombed:d,luma:this.weave(e,t,i,h,s)}}decimate(e){const t=this.#s,i=this.#F?x.#de(this.#F,e,this.#n,this.#i):{maxBlockDifference:1/0,totalDifference:1/0};this.#h.push(i);const s=this.#x===t,r=s&&i.maxBlockDifference<this.#e;s&&!r&&(this.#x=null);const n=this.#x;this.#F=e.slice(),this.#s++;let l=this.#x;if(this.#s===x.CYCLE){let h=0,f=null;for(let a=1;a<this.#h.length;a++)(this.#h[a]?.maxBlockDifference??1/0)<(this.#h[h]?.maxBlockDifference??1/0)?(f=h,h=a):(f===null||(this.#h[a]?.maxBlockDifference??1/0)<(this.#h[f]?.maxBlockDifference??1/0))&&(f=a);this.#z=this.#h[h]?.maxBlockDifference??1/0,this.#W=f===null?1/0:this.#h[f]?.maxBlockDifference??1/0,l=(this.#h[h]?.maxBlockDifference??1/0)<this.#e?h:null,this.#x=l,this.#h=[],this.#s=0}return{cycleIndex:t,maxBlockDifference:i.maxBlockDifference,totalDifference:i.totalDifference,shouldDrop:r,dropIndex:n,nextDropIndex:l,lowestCycleDifference:this.#z,runnerUpCycleDifference:this.#W}}weave(e,t,i,s,r){if(s==="c")return t.slice();const n=t.slice(),l=s==="p"?e:i,h=n.length/this.#i,f=r?1:0;for(let a=f;a<this.#i;a+=2)n.set(l.subarray(a*h,(a+1)*h),a*h);return n}reset(){this.#s=0,this.#x=null,this.#h=[],this.#F=null,this.#z=1/0,this.#W=1/0}#_(e,t,i,s){const r=this.#n,n=this.#i,l=2-i,h=2-i,f=s[e],a=s[t],v=x.#ue(f,a,r,n,i);let u=0,c=0,d=0,p=0,E=0,g=0;for(let U=2;U<n-2;U+=2){const M=(U-2)/2,se=l-1+M*2,re=l+1+M*2,ne=l+3+M*2,K=l+M*2,Q=K+2,z=h+M*2,L=z+2,de=l+M*2;for(let A=8;A<r-8;A++){const N=(v[de*r+A]??0)|(v[(de+2)*r+A]??0);if(N===0)continue;const me=(s.c[se*r+A]??0)+((s.c[re*r+A]??0)<<2)+(s.c[ne*r+A]??0),W=Math.abs(3*((f[K*r+A]??0)+(f[Q*r+A]??0))-me),H=Math.abs(3*((a[z*r+A]??0)+(a[L*r+A]??0))-me);W>23&&(N&1)!==0&&(u+=W),H>23&&(N&1)!==0&&(p+=H),W>42&&(N&2)!==0&&(c+=W),H>42&&(N&2)!==0&&(E+=H),W>42&&(N&4)!==0&&(d+=W),H>42&&(N&4)!==0&&(g+=H)}}c<500&&E<500&&(d>=500||g>=500)&&Math.max(d,g)>3*Math.min(d,g)&&(c=d,E=g);const y=Math.floor(u/6+.5),D=Math.floor(p/6+.5),b=Math.floor(c/6+.5),m=Math.floor(E/6+.5),Y=Math.max(y,D)/Math.max(Math.min(y,D),1),V=Math.max(b,m)/Math.max(Math.min(b,m),1),j=Math.max(b,m)/Math.max(Math.max(y,D),1);return(b>=500||m>=500)&&(b*2<m||m*2<b)||(b>=1e3||m>=1e3)&&(b*3<m*2||m*3<b*2)||(b>=2e3||m>=2e3)&&(b*5<m*4||m*5<b*4)||(b>=4e3||m>=4e3)&&V>Y||j>.005&&Math.max(b,m)>150&&(b*2<m||m*2<b)?b>m?t:e:y>D?t:e}static#ue(e,t,i,s,r){const n=Array.from({length:Math.ceil(s/2)},()=>new Uint8Array(i)),l=r===1?1:0;for(let a=0;a<n.length;a++){const v=Math.min(s-1,l+a*2),u=n[a];if(u)for(let c=0;c<i;c++)u[c]=Math.abs((e[v*i+c]??0)-(t[v*i+c]??0))}const h=new Uint8Array(i*s),f=r===1?3:2;for(let a=1;a<n.length-1;a++){const v=f+(a-1)*2;if(v>=s)break;const u=n[a];if(u)for(let c=1;c<i-1;c++){const d=u[c]??0;if(d<=3)continue;let p=0;for(let m=c-1;m<=c+1;m++)p+=(n[a-1]?.[m]??0)>3?1:0,p+=(n[a]?.[m]??0)>3?1:0,p+=(n[a+1]?.[m]??0)>3?1:0;if(p<=1)continue;const E=v*i+c;if(h[E]=1,d<=19)continue;p=0;let g=!1,y=!1;for(let m=c-1;m<=c+1;m++)(n[a-1]?.[m]??0)>19&&(p++,g=!0),(n[a]?.[m]??0)>19&&p++,(n[a+1]?.[m]??0)>19&&(p++,y=!0);if(p<=3)continue;if(g&&y){h[E]|=2;continue}let D=!1,b=!1;for(let m=Math.max(c-4,0);m<Math.min(c+5,i);m++)a!==1&&(n[a-2]?.[m]??0)>19&&(D=!0),(n[a-1]?.[m]??0)>19&&(g=!0),(n[a+1]?.[m]??0)>19&&(y=!0),a!==n.length-2&&(n[a+2]?.[m]??0)>19&&(b=!0);g&&(y||D)||y&&(g||b)?h[E]|=2:p>5&&(h[E]|=4)}}return h}static#L(e,t,i){const s=new Uint8Array(t*i),r=(l,h)=>e[Math.max(0,Math.min(i-1,h))*t+l]??0;for(let l=0;l<i;l++)for(let h=0;h<t;h++){const f=r(h,l),a=r(h,l===0?1:l-1),v=r(h,l===i-1?i-2:l+1),u=l<2?r(h,l===0?2:3):r(h,l-2),c=l+2>=i?r(h,l===i-1?i-3:i-4):r(h,l+2);(l===0?Math.abs(f-v)>x.COMB_THRESHOLD:l===i-1?Math.abs(f-a)>x.COMB_THRESHOLD:Math.abs(f-a)>x.COMB_THRESHOLD&&Math.abs(f-v)>x.COMB_THRESHOLD)&&Math.abs(4*f-3*(a+v)+u+c)>x.COMB_THRESHOLD*6&&(s[l*t+h]=255)}let n=0;for(const l of[0,8])for(const h of[0,8])for(let f=l;f<i;f+=16)for(let a=h;a<t;a+=16){let v=0;for(let u=Math.max(1,f);u<Math.min(i-1,f+16);u++)for(let c=a;c<Math.min(t,a+16);c++){const d=u*t+c;s[d-t]===255&&s[d]===255&&s[d+t]===255&&v++}n=Math.max(n,v)}return n}static#de(e,t,i,s){const r=x.DECIMATE_BLOCK/2,n=Math.ceil(i/r),l=Math.ceil(s/r),h=new Float64Array(n*l),f=e.length/(i*s);for(let u=0;u<s;u++){const c=Math.floor(u/r);for(let d=0;d<i;d++){const p=Math.floor(d/r),E=c*n+p,g=(u*i+d)*f;if(f===1){h[E]=(h[E]??0)+Math.abs((e[g]??0)-(t[g]??0));continue}const y=Math.round((e[g]??0)*.2126+(e[g+1]??0)*.7152+(e[g+2]??0)*.0722),D=Math.round((t[g]??0)*.2126+(t[g+1]??0)*.7152+(t[g+2]??0)*.0722);if(h[E]=(h[E]??0)+Math.abs(y-D),(d&1)!==0||(u&1)!==0)continue;let b=0,m=0,Y=0,V=0,j=0,U=0,M=0;for(let Q=u;Q<Math.min(u+2,s);Q++)for(let z=d;z<Math.min(d+2,i);z++){const L=(Q*i+z)*f;b+=e[L]??0,m+=e[L+1]??0,Y+=e[L+2]??0,V+=t[L]??0,j+=t[L+1]??0,U+=t[L+2]??0,M++}const se=Math.round((-.114572*b-.385428*m+.5*Y)/M),re=Math.round((-.114572*V-.385428*j+.5*U)/M),ne=Math.round((.5*b-.454153*m-.045847*Y)/M),K=Math.round((.5*V-.454153*j-.045847*U)/M);h[E]=(h[E]??0)+Math.abs(se-re)+Math.abs(ne-K)}}let a=-1;for(let u=0;u<l-1;u++)for(let c=0;c<n-1;c++)a=Math.max(a,(h[u*n+c]??0)+(h[u*n+c+1]??0)+(h[(u+1)*n+c]??0)+(h[(u+1)*n+c+1]??0));let v=0;for(const u of h)v+=u;return{maxBlockDifference:a,totalDifference:v}}}const ae=8192;let he=0,C=0,G=[],X=[];const B={requested:"auto",active:"starting",generation:0,reason:"module-loaded"};function Z(o){X.length===ae&&(X.shift(),C++),X.push(o)}function O(o){const e={...o,sequence:++he};if(typeof document<"u"){Z({...e,realm:"main",generation:B.generation,timeOriginMs:performance.timeOrigin});return}G.length===ae&&(G.shift(),C++),G.push(e)}function ye(){const o={timeOriginMs:performance.timeOrigin,events:G,droppedEvents:C};return G=[],C=0,o}function xe(o,e){for(const t of o.events)Z({...t,realm:"worker",generation:e,timeOriginMs:o.timeOriginMs});C+=o.droppedEvents}function P(o,e,t,i){B.requested=o,B.active=e,B.generation=t,B.reason=i,typeof document<"u"&&Z({kind:"backend",sequence:++he,realm:"main",generation:t,timeOriginMs:performance.timeOrigin,atMs:performance.now(),requested:o,active:e,reason:i})}typeof document<"u"&&(globalThis.__YADIF_RENDER_TRACE__={schemaVersion:1,get backend(){return{...B}},get droppedEvents(){return C},drain(){const o={events:X,droppedEvents:C};return X=[],C=0,o}});let Te=null;const Fe=.5,T=3,ee=5,I=ee+1,oe=1e3,te=4,ie=200,Me=.25,ke=1e3/60,Re=.02,Ae=250,Se=1e3/30;function le(o){if(!Number.isFinite(o)||o<0)throw new RangeError("filmCombThreshold must be a finite number greater than or equal to 0");return o}const we=`#version 300 es
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
`;class Ce extends EventTarget{#n;#i;#e;#s;#x;#h;#F;#z;#W;#_=null;#ue=null;#L=null;#de=null;#Z=null;#$e=null;#P=null;#M=[];#E=[];#ee=I-1;#d=null;#t=[];#I=null;#me=0;#U=null;#H=ke;#G=null;#Re;#k;#p;#X;#Ae;#w="video";#te="c";#Se=0;#we=!0;#De=new x(k,R);#Ce=1/0;#_e=1/0;#N=0;#f=0;#v=0;#T=0;#g=T-1;#o=0;#ie=0;#pe=Number.NaN;#se=!1;#q=null;#ve=0;#Y=0;#Le=0;#u=!1;#ge=!1;#Pe=!1;#l=null;#V=[];#R=!1;#Ie;#c;#Ee;#m;#Ue;#a=null;#r;#j=!1;#A=0;#Ne=!1;#gt=0;#re=!1;#be=!1;#Q=null;#Et=0;#ne=new Map;#b={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0};#B=0;#Be=0;#ye=0;#O=0;#ae=0;#he=0;#oe=0;#$=0;constructor(e,t={},i=null){super(),this.#e=e,this.#k=t.doubleRate??!1,this.#p=t.autoFilm??!1,this.#X=le(t.filmCombThreshold??x.COMBED_PIXEL_LIMIT),this.#Ae=t.spatialCheck??!0,this.#Ie=t.onStats,this.#c=i,this.#m=i?"main":t.rendering??"auto",this.#Ue=t.workerUrl??Te,this.#r=this.#m==="main"?"main":"idle",i||P(this.#m,this.#r==="main"?"main":"starting",this.#A,this.#r==="main"?"configured-main":"configured-auto"),this.#i=i?i.canvas:document.createElement("canvas"),this.#n=i?.canvas??(this.#m==="main"?this.#i:document.createElement("canvas")),this.#Ee=e,i||(this.#i.style.cssText="position:absolute;pointer-events:none;visibility:hidden");const s=this.#n.getContext("webgl2",{alpha:!1,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1,powerPreference:"high-performance"});if(!s)throw new Error("this browser has no WebGL2");this.#s=s,this.#x=q(s,ve);const r=this.#x;this.#h=Object.fromEntries(Object.entries(pe).map(([n,l])=>[n,s.getUniformLocation(r,l)])),this.#F=q(s,De),this.#z=s.getUniformLocation(this.#F,"uField"),this.#W=s.getUniformLocation(this.#F,"uFlip"),this.#p&&this.#it(),this.#n.addEventListener("webglcontextlost",this.#vt),this.#Re=i?null:new ResizeObserver(()=>this.#ke()),e.addEventListener("emptied",this.#dt),e.addEventListener("resize",this.#ut),e.addEventListener("pause",this.#C),e.addEventListener("ended",this.#C),e.addEventListener("seeking",this.#pt),e.addEventListener("seeked",this.#C),e.addEventListener("ratechange",this.#C)}get running(){return this.#u&&(this.#l?.interlaced??!0)}get canvas(){return this.#i}get#xe(){return this.#l?.topFieldFirst!==!1}#Ke(){return{doubleRate:this.#k,autoFilm:this.#p,filmCombThreshold:this.#X,spatialCheck:this.#Ae}}get enabled(){return this.#ge}set enabled(e){this.#ge=e,this.#ze(),this.#a?.postMessage({type:"enabled",enabled:e})}set scan(e){const t=this.#l?.interlaced!==e?.interlaced,i=t||this.#l?.topFieldFirst!==e?.topFieldFirst;this.#l=e,this.#a?.postMessage({type:"scan",scan:e}),i&&(this.#o=0,this.#y(),t&&(this.#f=0),this.#d=null,this.#S(!1)),this.#ze(),i&&((e?.interlaced??!0)&&(this.#c||this.#r==="main")?this.#K():this.#Xe())}get scan(){return this.#l}set videoTimeline(e){this.#V=e,this.#a?.postMessage({type:"timeline",videoTimeline:e}),e.length===0&&(this.#l=null),this.#ze()}get videoTimeline(){return this.#V}get container(){return this.#G??this.#e}get doubleRate(){return this.#k}set doubleRate(e){e!==this.#k&&(this.#k=e,this.#Oe(),this.#t.length=0,e?(this.#v>0&&this.#je(),(this.#l?.interlaced??!0)&&(this.#c||this.#r==="main")&&this.#K()):this.#p||(this.#d=null,this.#S(!1),this.#J()))}get autoFilm(){return this.#p}set autoFilm(e){e!==this.#p&&(this.#p=e,this.#Oe(),this.#y(),e?(this.#it(),this.#v>0&&(this.#ft(),this.#je()),(this.#l?.interlaced??!0)&&(this.#c||this.#r==="main")&&this.#K()):(this.#Ve(),this.#k||(this.#d=null,this.#S(!1),this.#J())))}get filmCombThreshold(){return this.#X}set filmCombThreshold(e){const t=le(e);t!==this.#X&&(this.#X=t,this.#Oe(),this.#p&&this.#y())}#Oe(){this.#a?.postMessage({type:"settings",options:this.#Ke()})}#ze(){this.#ge&&(this.#V.length>0||(this.#l?.interlaced??!0))?this.start():this.stop()}#bt(){return this.#c||this.#m==="main"?!1:this.#r==="starting"||this.#r==="active"?!0:typeof Worker<"u"&&typeof VideoFrame<"u"&&typeof OffscreenCanvas<"u"&&this.#Ue!==null&&"transferControlToOffscreen"in HTMLCanvasElement.prototype?(this.#Je(),!0):this.#m==="auto"?(this.#Te("capability-fallback"),!1):(this.#r="failed",this.#u=!1,P(this.#m,"failed",this.#A,"required-worker-unavailable"),!0)}#Je(){this.#D(),this.#a?.terminate(),this.#a=null,this.#re=!1,this.#be=!1;let e=this.#i;if(this.#Ne){e=document.createElement("canvas"),e.className=this.#i.className;const r=this.#i.getAttribute("style");r===null?e.removeAttribute("style"):e.setAttribute("style",r),e.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(e),this.#i=e}const t=++this.#A;this.#r="starting",P(this.#m,"starting",t,this.#j?"worker-restarting":"worker-starting");let i,s;try{s=e.transferControlToOffscreen(),this.#Ne=!0,i=new Worker(this.#Ue,{type:"module"})}catch(r){this.#le(r instanceof Error?r.message:String(r));return}this.#a=i,i.onmessage=r=>{t===this.#A&&this.#yt(r.data)},i.onerror=r=>{t===this.#A&&(r.preventDefault(),this.#le(r.message||"the deinterlacer worker failed"))},i.postMessage({type:"initialize",canvas:s,options:this.#Ke(),scan:this.#l,videoTimeline:this.#V,enabled:this.#u,video:this.#We()},[s])}#yt(e){switch(e.type){case"ready":this.#r="active",P(this.#m,"worker",this.#A,"worker-ready"),this.#u&&(this.#ce(),this.#qe());break;case"failed":this.#le(e.message);break;case"consumed":{this.#re=!1,this.#be=!0;const t=this.#Q;this.#Q=null,t&&this.#et(t);break}case"visibility":this.#i.style.visibility=e.visible?"visible":"hidden";break;case"stats":{const t={...e.stats,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0};this.dispatchEvent(new CustomEvent("stats",{detail:t})),this.#Ie?.(t);break}case"diagnostic-batch":xe(e.batch,this.#A);break;case"capture":{const t=this.#ne.get(e.id);if(this.#ne.delete(e.id),!t){e.image?.close();break}e.image?t.resolve(e.image):createImageBitmap(this.#e).then(t.resolve,t.reject);break}}}#le(e){if(this.#r==="starting"&&this.#m==="auto"&&!this.#j){this.#Te("initialization-fallback");return}if(this.#Ze(e),!this.#j){this.#j=!0,this.#Je();return}console.error(`Deinterlacer Worker stopped: ${e}`),this.#r="failed",P(this.#m,"failed",this.#A,"worker-terminal-failure"),this.#a?.terminate(),this.#a=null,this.#D(),this.stop()}#Te(e){const t=this.#n;t.className=this.#i.className;const i=this.#i.getAttribute("style");i===null?t.removeAttribute("style"):t.setAttribute("style",i),t.style.visibility="hidden",this.#i.parentElement&&this.#i.replaceWith(t),this.#i=t,this.#Ne=!1,this.#a?.terminate(),this.#a=null,this.#r="main",P(this.#m,"main",this.#A,e),this.#D(),this.#u&&(this.#ce(),this.#qe(),(this.#l?.interlaced??!0)&&this.#K())}#D(){this.#Q?.frame.close(),this.#Q=null}#Ze(e){for(const t of this.#ne.values())t.reject(new Error(e));this.#ne.clear()}start(){if(!(this.#u||this.#Pe||this.#R)){if(this.#u=!0,this.#mt(),this.#y(),this.#ve=performance.now(),this.#Le=this.#ve,this.#pe=Number.NaN,this.#Y=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,this.#Pt(),this.#qe(),this.#bt()){this.#a?.postMessage({type:"enabled",enabled:!0}),this.#r==="active"&&this.#ce();return}this.#ce(),(this.#l?.interlaced??!0)&&this.#K()}}stop(){this.#u&&(this.#u=!1,this.#q!==null&&this.#e.cancelVideoFrameCallback(this.#q),this.#q=null,this.#St(),this.#Xe(),this.#o=0,this.#d=null,this.#S(!1),this.#D(),this.#a?.postMessage({type:"enabled",enabled:!1}))}destroy(){if(!this.#Pe){this.#Pe=!0,this.#ge=!1,this.stop(),this.#a?.postMessage({type:"destroy"}),this.#a?.terminate(),this.#a=null,P(this.#m,"failed",this.#A,"destroyed"),this.#D(),this.#Ze("the deinterlacer was destroyed"),this.#n.removeEventListener("webglcontextlost",this.#vt),this.#e.removeEventListener("emptied",this.#dt),this.#e.removeEventListener("resize",this.#ut),this.#e.removeEventListener("pause",this.#C),this.#e.removeEventListener("ended",this.#C),this.#e.removeEventListener("seeking",this.#pt),this.#e.removeEventListener("seeked",this.#C),this.#e.removeEventListener("ratechange",this.#C),this.#It();for(const e of this.#M)this.#s.deleteTexture(e);this.#M=[],this.#J(),this.#Ve(),this.#s.deleteProgram(this.#x),this.#s.deleteProgram(this.#F),this.#_&&this.#s.deleteProgram(this.#_),this.#L&&this.#s.deleteProgram(this.#L),this.#Z&&this.#s.deleteProgram(this.#Z),this.#s.getExtension("WEBGL_lose_context")?.loseContext()}}capture(){if(this.#r==="active"&&this.#i.style.visibility==="visible"&&this.#a){const s=++this.#Et,r=new Promise((n,l)=>{this.#ne.set(s,{resolve:n,reject:l})});return this.#a.postMessage({type:"capture",id:s,width:this.#e.videoWidth,height:this.#e.videoHeight}),r}if(this.#r==="starting"||this.#r==="failed")return createImageBitmap(this.#e);const e=this.#d;if(this.#c&&(!this.#u||this.#R||!e))return Promise.reject(new Error("no rendered picture is available"));if(!this.#u||this.#R||!e)return createImageBitmap(this.#e);e.kind==="texture"?this.#Ye(e.texture,e.flip,!1):e.kind==="yadif"?this.#fe(e.flush,e.second,null,!1):this.#He(null,!1);const t=this.#e.videoWidth,i=this.#e.videoHeight;return t>0&&i>0&&(t!==this.#n.width||i!==this.#n.height)?createImageBitmap(this.#n,{resizeWidth:t,resizeHeight:i,resizeQuality:"high"}):createImageBitmap(this.#n)}addEventListener(e,t,i){super.addEventListener(e,t,i)}removeEventListener(e,t,i){super.removeEventListener(e,t,i)}#ce(){this.#c||!this.#u||this.#q!==null||(this.#q=this.#e.requestVideoFrameCallback(this.#Tt))}#We(){const e=[];for(let t=0;t<this.#e.buffered.length;t++)e.push({start:this.#e.buffered.start(t),end:this.#e.buffered.end(t)});return{currentTime:this.#e.currentTime,playbackRate:this.#e.playbackRate,seeking:this.#e.seeking,paused:this.#e.paused,ended:this.#e.ended,readyState:this.#e.readyState,videoWidth:this.#e.videoWidth,videoHeight:this.#e.videoHeight,buffered:e}}#xt(e,t){let i;try{i=new VideoFrame(this.#e,{timestamp:Math.max(0,Math.round(t.mediaTime*1e6))})}catch(r){const n=r instanceof Error?r.message:String(r);this.#m==="auto"&&!this.#be&&!this.#j?(this.#Te("video-frame-fallback"),this.#Fe(e,t)):this.#le(n);return}const s={id:++this.#gt,frame:i,now:e,metadata:t,video:this.#We()};if(this.#re){this.#Q?.frame.close(),this.#Q=s;return}this.#et(s)}#et(e){const t=this.#a;if(!t||this.#r!=="active"){e.frame.close();return}this.#re=!0;const i={type:"frame",...e};try{t.postMessage(i,[e.frame])}catch(s){this.#re=!1,e.frame.close();const r=s instanceof Error?s.message:String(s);this.#m==="auto"&&!this.#be&&!this.#j?(this.#Te("transfer-fallback"),this.#Fe(e.now,e.metadata)):this.#le(r)}}#Tt=(e,t)=>{this.#q=null,!(!this.#u||this.#R)&&(this.#ve=e,this.#Y=Math.max(this.#Y,this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0),this.#tt(e,t),this.#ce())};#tt(e,t){if(this.#pe=t.mediaTime,this.#r==="active"){this.#xt(e,t);return}this.#r!=="starting"&&this.#Fe(e,t)}ingestExternalFrame(e,t,i){this.#Ee=i;try{this.#Fe(e,t)}finally{this.#Ee=this.#e}}#Fe(e,t){if(this.#Ft(t.mediaTime),t.width>0&&t.height>0){let i=!1;if(!this.#se&&this.#e.seeking){const c=this.#e.buffered,d=this.#f>=te?this.#f/1e3:ie/1e3;for(let p=0;p<c.length;p++)if(t.mediaTime>=c.start(p)&&t.mediaTime<c.end(p)&&Math.abs(t.mediaTime-this.#e.currentTime)<=d){i=!0;break}}if(i&&(this.#se=!0),(this.#v===0||this.#T===0)&&this.#ct(t.width,t.height),this.#l&&!this.#l.interlaced){this.#Ct();return}const s=t.mediaTime-this.#ie,r=i||s<0||s>Fe;r&&(this.#o=0,this.#f=0,this.#b.discontinuities++,this.#t.length=0,this.#y());const n=this.#p&&this.#B!==0&&t.presentedFrames-this.#B>1;if(this.#_t(t.presentedFrames,r),!r&&n&&(this.#o=0,this.#y()),this.#o>0&&t.mediaTime===this.#ie)return;!r&&s>0&&this.#Mt(s),this.#ie=t.mediaTime;const l=performance.now();l-this.#Be>oe&&(this.#ye=l,this.#O=0,this.#ae=0,this.#he=0,this.#oe=0,this.#$=0,this.#N=0),this.#Be=l;const h=performance.now();this.#lt();const f=this.#w,a=this.#p&&this.#o===T&&this.#kt();if(f!==this.#w&&(this.#t.length=0),!(a&&this.#Me()))if(this.#p&&!this.#we&&this.#w==="film")if(this.#Me()){const c=this.#f*5/4,d=this.#rt(1,e,c),p=this.#t.at(-1),E=d?e:p==null?e+c:p.at+p.duration;this.#Rt(E,c)}else this.#He(null);else if(this.#k&&this.#Me()){const c=this.#f/2,d=this.#rt(2,e,c),p=this.#t.at(-1),E=d?e:p==null?e+c*2:p.at+p.duration;this.#st(!1,E,c),this.#st(!0,E+c,c)}else this.#b.late+=this.#t.length,this.#t.length=0,this.#fe(!1,!1,null);this.#$=Math.max(this.#$,this.#t.length),this.#ae+=performance.now()-h,this.#O++,this.#Lt(l)}}#Ft(e){let t;for(let r=this.#V.length-1;r>=0;r--){const n=this.#V[r];if(n.start<=e+1e-6){t=n;break}}t?.codedSize&&(t.codedSize.width!==this.#v||t.codedSize.height!==this.#T)&&this.#ct(t.codedSize.width,t.codedSize.height);const i=t?.scan;if(!i||this.#l?.interlaced===i.interlaced&&this.#l.topFieldFirst===i.topFieldFirst)return;const s=this.#l?.interlaced;this.#l=i,this.#o=0,this.#t.length=0,this.#y(),s!==i.interlaced&&(this.#f=0),i.interlaced&&(this.#c||this.#r==="main")?this.#K():this.#Xe()}#Me(){return(this.#k||this.#p)&&this.#f>0&&this.#E.length===I}#Mt(e){const t=e*1e3/(this.#e.playbackRate||1),i=this.#f>0?Math.max(1,Math.round(t/this.#f)):1,s=t/i;s<te||s>ie||(this.#f=this.#f>0?this.#f+(s-this.#f)*Me:s)}#it(){if(this.#_&&this.#L&&this.#Z)return;const e=this.#s,t=q(e,ge),i=q(e,Ee),s=q(e,be);this.#_=t,this.#ue=Object.fromEntries(Object.entries(J).filter(([r])=>r!=="match"&&r!=="topFieldFirst").map(([r,n])=>[r,e.getUniformLocation(t,n)])),this.#L=i,this.#de=Object.fromEntries(Object.entries(J).map(([r,n])=>[r,e.getUniformLocation(i,n)])),this.#Z=s,this.#$e=Object.fromEntries(Object.entries(J).map(([r,n])=>[r,e.getUniformLocation(s,n)]))}#kt(){const e=this.#P,t=this.#_,i=this.#ue,s=this.#Z,r=this.#$e;if(!e||!t||!i||!s||!r)return!1;const n=this.#s,l=this.#g,h=(this.#g+T-1)%T,f=(this.#g+1)%T,a=this.#xe;n.bindFramebuffer(n.FRAMEBUFFER,e.framebuffer),n.useProgram(t);for(const[g,y]of[f,h,l].entries())n.activeTexture(n.TEXTURE0+g),n.bindTexture(n.TEXTURE_2D,this.#M[y]??null);n.uniform1i(i.prev,0),n.uniform1i(i.cur,1),n.uniform1i(i.next,2),n.uniform2i(i.size,this.#v,this.#T),n.viewport(0,0,k,R),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,k,R,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const{previousLuma:v,currentLuma:u,nextLuma:c}=e;for(let g=0;g<v.length;g++){const y=g*4;v[g]=e.pixels[y]??0,u[g]=e.pixels[y+1]??0,c[g]=e.pixels[y+2]??0}const d=this.#De.fieldMatch(v,u,c,a,this.#X);n.useProgram(s),n.uniform1i(r.prev,0),n.uniform1i(r.cur,1),n.uniform1i(r.next,2),n.uniform2i(r.size,this.#v,this.#T),n.uniform1i(r.topFieldFirst,a?1:0),n.uniform1i(r.match,d.match==="p"?0:d.match==="c"?1:2),n.drawArrays(n.TRIANGLES,0,3),n.readPixels(0,0,k,R,n.RGBA,n.UNSIGNED_BYTE,e.pixels);const p=this.#De.decimate(e.pixels);this.#te=d.match,this.#Se=d.combScore,this.#we=d.isCombed,this.#Ce=p.lowestCycleDifference,this.#_e=p.runnerUpCycleDifference;const E=p.dropIndex!==null&&!d.isCombed;return(E?"film":"video")!==this.#w&&(this.#w=E?"film":"video"),p.shouldDrop&&!d.isCombed}#Rt(e,t){const i=this.#Ge();if(i===null)return;const s=this.#E[i];if(s){for(this.#ee=i;this.#t.length>0&&this.#t[0]?.slot===i;)this.#t.shift(),this.#b.late++;this.#He(s.framebuffer),this.#t.push({slot:i,at:e,duration:t})}}#He(e,t=!0){const i=this.#L,s=this.#de;if(!i||!s)return;const r=this.#s,n=this.#g,l=(this.#g+T-1)%T,h=(this.#g+1)%T,f=this.#xe;r.bindFramebuffer(r.FRAMEBUFFER,e),r.useProgram(i);for(const[a,v]of[h,l,n].entries())r.activeTexture(r.TEXTURE0+a),r.bindTexture(r.TEXTURE_2D,this.#M[v]??null);r.uniform1i(s.prev,0),r.uniform1i(s.cur,1),r.uniform1i(s.next,2),r.uniform2i(s.size,this.#v,this.#T),r.uniform1i(s.topFieldFirst,f?1:0),r.uniform1i(s.match,this.#te==="p"?0:this.#te==="c"?1:2),r.viewport(0,0,this.#v,this.#T),r.drawArrays(r.TRIANGLES,0,3),e===null&&(this.#d={kind:"film"},this.#S(!0),t&&(this.#N++,O({kind:"draw-submit",atMs:performance.now(),rafAtMs:null,scheduledAtMs:null,queueDepthAfter:this.#t.length,path:"film-direct"})))}#st(e,t,i){const s=this.#Ge();if(s===null)return;const r=this.#E[s];if(r){for(this.#ee=s;this.#t.length>0&&this.#t[0]?.slot===s;)this.#t.shift(),this.#b.late++;this.#fe(!1,e,r.framebuffer),this.#t.push({slot:s,at:t,duration:i})}}#rt(e,t,i){const s=this.#t.at(-1),r=(ee+1)*Math.max(this.#H,i);if(s&&s.at-t>r)return this.#t.length=0,this.#b.queueResetted++,!0;const n=Math.max(0,this.#t.length+e-ee);let l=0,h=0;for(;h<n;){const f=this.#t.shift();if(!f)break;l+=f.duration,h++}for(const f of this.#t)f.at-=l;return this.#b.late+=h,!1}#Ge(){const e=this.#d?.kind==="texture"?this.#d.texture:null,t=new Set(this.#t.map(({slot:s})=>s));for(let s=1;s<=I;s++){const r=(this.#ee+s)%I,n=this.#E[r];if(n&&n.texture!==e&&!t.has(r))return r}const i=this.#t[0];if(i){const s=this.#E[i.slot];if(s&&s.texture!==e)return i.slot}return null}#K(){this.#I===null&&(!this.#u||this.#R||(this.#me=0,this.#I=this.#at(this.#nt)))}#Xe(){this.#I!==null&&this.#At(this.#I),this.#I=null,this.#t.length=0}#nt=e=>{if(this.#I=null,!this.#u||this.#R)return;const t=this.#me>0?e-this.#me:null;if(t!==null){const i=t;i>=1&&i<=ie&&(this.#H=i<this.#H?i:this.#H+(i-this.#H)*Re)}this.#me=e,O({kind:"raf",atMs:e,gapMs:t,queueDepth:this.#t.length}),this.#r==="main"&&this.#Dt(e),this.#I=this.#at(this.#nt)};#at(e){return this.#c?this.#c.requestAnimationFrame(e):requestAnimationFrame(e)}#At(e){this.#c?this.#c.cancelAnimationFrame(e):cancelAnimationFrame(e)}#qe(){this.#c||this.#U!==null||!this.#u||this.#R||(this.#U=requestAnimationFrame(this.#ht))}#St(){this.#U!==null&&cancelAnimationFrame(this.#U),this.#U=null}#ht=e=>{this.#U=null,!(!this.#u||this.#R)&&(this.#wt(e),this.#U=requestAnimationFrame(this.#ht))};#wt(e){if(this.#c||e-this.#ve<Ae||this.#e.paused||this.#e.ended||this.#e.readyState<2)return;const t=this.#e.currentTime,i=this.#e.getVideoPlaybackQuality?.().totalVideoFrames??0,s=this.#f>=te?this.#f:Se,r=i>this.#Y,n=t!==this.#pe&&e-this.#Le>=s*.75;!r&&!n||(this.#Y=Math.max(this.#Y,i),this.#Le=e,this.#tt(e,{mediaTime:t,presentedFrames:Math.max(this.#B+1,i),width:this.#e.videoWidth,height:this.#e.videoHeight}))}#Dt(e){const t=e+this.#H*1.5;for(;this.#t[1]&&this.#t[1].at<=t;)this.#b.late++,this.#t.shift();let i=this.#t[0];if(!i||i.at>t)return;this.#t.shift();const s=performance.now();this.#ot(i.slot);const r=performance.now();this.#oe+=r-s,this.#he++,O({kind:"draw-submit",atMs:r,rafAtMs:e,scheduledAtMs:i.at,queueDepthAfter:this.#t.length,path:"scheduled"})}#ot(e){const t=this.#E[e];t&&this.#Ye(t.texture)}#Ct(){this.#lt();const e=this.#M[this.#g];e&&(this.#Ye(e,!0),O({kind:"draw-submit",atMs:performance.now(),rafAtMs:null,scheduledAtMs:null,queueDepthAfter:this.#t.length,path:"progressive"})),this.#o=0}#S(e){if(this.#c){this.#c.onVisibility(e);return}this.#i.style.visibility=e?"visible":"hidden"}#Ye(e,t=!1,i=!0){const s=this.#s;s.bindFramebuffer(s.FRAMEBUFFER,null),s.useProgram(this.#F),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,e),s.uniform1i(this.#z,0),s.uniform1i(this.#W,t?1:0),s.viewport(0,0,this.#v,this.#T),s.drawArrays(s.TRIANGLES,0,3),this.#d={kind:"texture",texture:e,flip:t},this.#S(!0),i&&this.#N++}#_t(e,t){this.#B!==0&&!t&&(this.#b.missed+=Math.max(0,e-this.#B-1)),this.#B=e}#Lt(e){const t=e-this.#ye;if(t<oe)return;const i=this.#Me()&&(this.#k||this.#w==="film")?this.#he:this.#O,s={...this.#b,dropped:this.#e.getVideoPlaybackQuality?.().droppedVideoFrames??0,fps:i*1e3/t,frameMs:this.#O===0?0:(this.#ae+this.#oe)/this.#O,maxQueuedFields:this.#$,mode:this.#w,match:this.#te,combScore:this.#Se,outputFps:this.#N*1e3/t,duplicateScore:this.#Ce,duplicateRunnerUp:this.#_e};this.dispatchEvent(new CustomEvent("stats",{detail:s})),this.#Ie?.(s),this.#ye=e,this.#O=0,this.#ae=0,this.#he=0,this.#oe=0,this.#$=0,this.#N=0}#lt(){const e=this.#s;this.#g=(this.#g+1)%T,e.bindTexture(e.TEXTURE_2D,this.#M[this.#g]??null),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.#Ee),this.#o=Math.min(this.#o+1,T)}#fe(e,t,i,s=!0){if(this.#o===0||this.#R)return;s&&(this.#o===T&&!e?this.#b.filtered++:this.#b.degraded++);const r=this.#s,n=this.#g,l=(this.#g+T-1)%T,h=(this.#g+1)%T;let f,a,v;this.#o===1?f=a=v=n:e?(f=l,a=v=n):this.#o===2?(f=a=l,v=n):(f=h,a=l,v=n),r.bindFramebuffer(r.FRAMEBUFFER,i),r.useProgram(this.#x);for(const[c,d]of[f,a,v].entries())r.activeTexture(r.TEXTURE0+c),r.bindTexture(r.TEXTURE_2D,this.#M[d]??null);r.uniform1i(this.#h.prev,0),r.uniform1i(this.#h.cur,1),r.uniform1i(this.#h.next,2),r.uniform2i(this.#h.size,this.#v,this.#T);const u=this.#xe?0:1;r.uniform1i(this.#h.parity,t?1-u:u),r.uniform1i(this.#h.tff,this.#xe?1:0),r.uniform1i(this.#h.spatialCheck,this.#Ae?1:0),r.viewport(0,0,this.#v,this.#T),r.drawArrays(r.TRIANGLES,0,3),i===null&&(this.#d={kind:"yadif",flush:e,second:t},this.#S(!0),s&&(this.#N++,O({kind:"draw-submit",atMs:performance.now(),rafAtMs:null,scheduledAtMs:null,queueDepthAfter:this.#t.length,path:e?"flush":"yadif-direct"})))}#ke(){if(!this.#G)return;const e=this.#e,t=e.videoWidth,i=e.videoHeight;if(t===0||i===0)return;const s=Math.min(e.offsetWidth/t,e.offsetHeight/i),r=t*s,n=i*s;this.#i.style.left=`${e.offsetLeft+(e.offsetWidth-r)/2}px`,this.#i.style.top=`${e.offsetTop+(e.offsetHeight-n)/2}px`,this.#i.style.width=`${r}px`,this.#i.style.height=`${n}px`}#ct(e,t){const i=this.#s;this.#n.width=e,this.#n.height=t,this.#v=e,this.#T=t,this.#o=0,this.#d=null,this.#y(),this.#ke();for(const s of this.#M)i.deleteTexture(s);this.#M=[];for(let s=0;s<T;s++){const r=i.createTexture();i.bindTexture(i.TEXTURE_2D,r),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.NEAREST),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texImage2D(i.TEXTURE_2D,0,i.RGBA,e,t,0,i.RGBA,i.UNSIGNED_BYTE,null),this.#M.push(r)}this.#J(),this.#Ve(),this.#p&&this.#ft(),(this.#k||this.#p)&&this.#je()}#ft(){if(this.#P)return;const e=this.#s,t=e.createTexture();e.bindTexture(e.TEXTURE_2D,t),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,k,R,0,e.RGBA,e.UNSIGNED_BYTE,null);const i=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,i),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,t,0);const s=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!s){e.deleteFramebuffer(i),e.deleteTexture(t);return}this.#P={texture:t,framebuffer:i,pixels:new Uint8Array(k*R*4),previousLuma:new Uint8Array(k*R),currentLuma:new Uint8Array(k*R),nextLuma:new Uint8Array(k*R)}}#Ve(){this.#P&&(this.#s.deleteFramebuffer(this.#P.framebuffer),this.#s.deleteTexture(this.#P.texture),this.#P=null)}#je(){const e=this.#s;if(!(this.#E.length===I||this.#v===0)){this.#J();for(let t=0;t<I;t++){const i=e.createTexture();e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.NEAREST),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,this.#v,this.#T,0,e.RGBA,e.UNSIGNED_BYTE,null);const s=e.createFramebuffer();e.bindFramebuffer(e.FRAMEBUFFER,s),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,i,0);const r=e.checkFramebufferStatus(e.FRAMEBUFFER)===e.FRAMEBUFFER_COMPLETE;if(e.bindFramebuffer(e.FRAMEBUFFER,null),!r){e.deleteFramebuffer(s),e.deleteTexture(i),this.#J();return}this.#E.push({texture:i,framebuffer:s})}this.#ee=I-1}}#J(){const e=this.#s,t=this.#d?.kind==="texture"?this.#d.texture:null;this.#E.some(i=>i.texture===t)&&(this.#d=null);for(const{texture:i,framebuffer:s}of this.#E)e.deleteFramebuffer(s),e.deleteTexture(i);this.#E=[],this.#t.length=0}#Pt(){if(this.#G)return;const e=this.#e.parentElement;if(!e)return;const t=document.createElement("div");t.style.cssText="position:relative;display:inline-block;line-height:0;max-width:100%",e.insertBefore(t,this.#e),t.appendChild(this.#e),t.appendChild(this.#i),this.#G=t,this.#Re?.observe(this.#e),this.#ke()}#It(){if(this.#c)return;const e=this.#G;this.#G=null,this.#Re?.disconnect(),this.#i.remove(),e?.parentElement&&(e.parentElement.insertBefore(this.#e,e),e.remove())}#ut=()=>this.#ke();#Qe(e){return!this.#a||this.#r==="main"?!1:(this.#a.postMessage({type:"event",name:e,video:this.#We()}),!0)}#dt=()=>{if(this.#pe=Number.NaN,this.#Qe("emptied")){this.#D(),this.#S(!1);return}this.#o=0,this.#ie=0,this.#t.length=0,this.#f=0,this.#mt(),this.#y(),this.#d=null,this.#S(!1)};#mt(){this.#b={filtered:0,missed:0,degraded:0,discontinuities:0,late:0,queueResetted:0},this.#B=0,this.#ye=0,this.#Be=0,this.#O=0,this.#ae=0,this.#he=0,this.#oe=0,this.#$=0,this.#N=0,this.#y()}#y(){this.#t.length=0,this.#w="video",this.#te="c",this.#Se=0,this.#we=!0,this.#De.reset(),this.#Ce=1/0,this.#_e=1/0}#pt=()=>{if(this.#Qe("seeking")){this.#D();return}this.#se=!1};#C=e=>{if((e.type==="pause"||e.type==="ended"||e.type==="seeked"||e.type==="ratechange")&&this.#Qe(e.type)){this.#D();return}if(e.type==="seeked"){const i=this.#se;if(this.#se=!1,i)return;this.#o=0,this.#y(),this.#d=null,this.#S(!1);return}const t=e.type==="ratechange";if(t&&(this.#f=0,this.#ie=this.#e.currentTime),this.#t.length=0,this.#u&&this.#o>0){const i=this.#Ge(),s=i===null?void 0:this.#E[i];i!==null&&s?(this.#ee=i,this.#fe(!0,!1,s.framebuffer),this.#ot(i),O({kind:"draw-submit",atMs:performance.now(),rafAtMs:null,scheduledAtMs:null,queueDepthAfter:this.#t.length,path:"flush"})):this.#fe(!0,!1,null)}t&&(this.#o=0,this.#y())};#vt=e=>{if(e.preventDefault(),this.#c){this.#c.onFailure("the deinterlacer WebGL context was lost");return}this.#r!=="active"&&(this.#R=!0,this.stop())}}function _e(o,e,t,i,s,r,n){return new Ce(o,t,{canvas:e,onFailure:i,onVisibility:s,requestAnimationFrame:r,cancelAnimationFrame:n})}function q(o,e){const t=o.createProgram(),i=ce(o,o.VERTEX_SHADER,we),s=ce(o,o.FRAGMENT_SHADER,e);if(o.attachShader(t,i),o.attachShader(t,s),o.linkProgram(t),o.deleteShader(i),o.deleteShader(s),!o.getProgramParameter(t,o.LINK_STATUS)){const r=o.getProgramInfoLog(t);throw o.deleteProgram(t),new Error(`the deinterlacer failed to link: ${r??"no reason given"}`)}return t}function ce(o,e,t){const i=o.createShader(e);if(!i)throw new Error("the deinterlacer could not create a shader");if(o.shaderSource(i,t),o.compileShader(i),!o.getShaderParameter(i,o.COMPILE_STATUS)){const s=o.getShaderInfoLog(i);throw o.deleteShader(i),new Error(`the deinterlacer failed to compile: ${s??"no reason given"}`)}return i}const _=self;class Le extends EventTarget{currentTime=0;playbackRate=1;seeking=!1;paused=!0;ended=!1;readyState=0;videoWidth=0;videoHeight=0;parentElement=null;offsetWidth=0;offsetHeight=0;offsetLeft=0;offsetTop=0;#n=[];update(e){this.currentTime=e.currentTime,this.playbackRate=e.playbackRate,this.seeking=e.seeking,this.paused=e.paused,this.ended=e.ended,this.readyState=e.readyState,this.videoWidth=e.videoWidth,this.videoHeight=e.videoHeight,this.#n=e.buffered}get buffered(){return{length:this.#n.length,start:e=>{const t=this.#n[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.start},end:e=>{const t=this.#n[e];if(!t)throw new DOMException("Invalid range index","IndexSizeError");return t.end}}}getVideoPlaybackQuality(){return{creationTime:performance.now(),droppedVideoFrames:0,totalVideoFrames:0,corruptedVideoFrames:0}}requestVideoFrameCallback(){return 0}cancelVideoFrameCallback(){}}let S=null,F=null,fe=!1,$=null;function ue(){const o=ye();(o.events.length>0||o.droppedEvents>0)&&w({type:"diagnostic-batch",batch:o})}function Pe(o){return _.requestAnimationFrame(o)}function Ie(o){_.cancelAnimationFrame(o)}function w(o,e=[]){_.postMessage(o,e)}function Ue(o,e){o.doubleRate=e.doubleRate,o.autoFilm=e.autoFilm,o.filmCombThreshold=e.filmCombThreshold}_.onmessage=o=>{const e=o.data;try{if(e.type==="initialize"){if(typeof _.requestAnimationFrame!="function")throw new Error("requestAnimationFrame is unavailable in this Worker");S=new Le,S.update(e.video),F=_e(S,e.canvas,e.options,t=>{fe||w({type:"failed",message:t})},t=>w({type:"visibility",visible:t}),Pe,Ie),F.addEventListener("stats",t=>{const{dropped:i,...s}=t.detail;w({type:"stats",stats:s})}),F.scan=e.scan,F.videoTimeline=e.videoTimeline,F.enabled=e.enabled,$=_.setInterval(ue,250),w({type:"ready"});return}if(!S||!F)return;switch(e.type){case"frame":S.update(e.video);try{F.ingestExternalFrame(performance.now(),e.metadata,e.frame)}finally{e.frame.close(),w({type:"consumed",id:e.id})}break;case"settings":Ue(F,e.options);break;case"scan":F.scan=e.scan;break;case"timeline":F.videoTimeline=e.videoTimeline;break;case"enabled":F.enabled=e.enabled;break;case"event":S.update(e.video),S.dispatchEvent(new Event(e.name));break;case"capture":S.videoWidth=e.width,S.videoHeight=e.height,F.capture().then(t=>w({type:"capture",id:e.id,image:t},[t])).catch(()=>w({type:"capture",id:e.id,image:null}));break;case"destroy":fe=!0,$!==null&&_.clearInterval($),$=null,ue(),F.destroy(),F=null,S=null,_.close();break}}catch(t){const i=t instanceof Error?t.message:String(t);w({type:"failed",message:i})}}})();
//# sourceMappingURL=worker-CNEg1XXr.js.map
