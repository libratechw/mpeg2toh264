/*!
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * yadif, as a WebGL2 fragment shader.
 *
 * Ported from FFmpeg's CUDA implementation of the filter,
 * libavfilter/vf_yadif_cuda.cu, which carries:
 *
 *   Copyright (C) 2018 Philip Langdale <philipl@overt.org>
 *
 * and follows libavfilter/vf_yadif.c:
 *
 *   Copyright (C) 2006-2011 Michael Niedermayer <michaelni@gmx.at>
 *                 2010      James Darnley <james.darnley@gmail.com>
 *
 * This file is free software; you can redistribute it and/or modify it under
 * the terms of the GNU Lesser General Public License as published by the Free
 * Software Foundation; either version 2.1 of the License, or (at your option)
 * any later version.
 *
 * This file is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more
 * details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this file; if not, see <https://www.gnu.org/licenses/>.
 *
 */

/**
 * Everything this shader wants to be told, besides the three frames.
 *
 * `parity` is which lines survive: a line whose parity is this one is copied
 * from the current frame, and every other line is what the filter builds. For
 * one output frame per input frame that is `tff ? 0 : 1`, which keeps the field
 * that came first and rebuilds the moment it was captured at.
 */
export const YADIF_UNIFORMS = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  parity: "uParity",
  tff: "uTff",
  spatialCheck: "uSpatialCheck",
} as const;

/**
 * The filter itself.
 *
 * It runs on RGB rather than on planes of YCbCr, which is what the browser
 * hands over when a frame is uploaded as a texture. The reference filters each
 * plane on its own and this filters each channel on its own, so the arithmetic
 * is the same one three times over; every comparison below is per channel,
 * which is what the `mix` by a `lessThan` mask is doing.
 *
 * The reference is never without a frame either side of the one it is
 * filtering: it holds frames back until it has them, and where its input ends
 * it duplicates rather than doing without. A caller here is expected to do the
 * same. A frame standing in as its own neighbour leaves the temporal check
 * nothing to measure, and what comes back is then the picture as it was --
 * except where it alternates strongly from line to line, which is what combing
 * is, and which is where the spatial check lets the interpolation through.
 */
export const YADIF_FRAGMENT_SHADER = `#version 300 es
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
`;

/** Uniforms shared by the film-cadence analysis and field-weave shaders. */
export const FILM_UNIFORMS = {
  prev: "uPrev",
  cur: "uCur",
  next: "uNext",
  size: "uSize",
  topFieldFirst: "uTopFieldFirst",
  match: "uMatch",
} as const;

/**
 * Measures combing in the three field matches available from the frame ring.
 *
 * Each output pixel samples one source location and stores the p/c/n comb
 * contribution in RGB. Reading the small 160 by 90 target therefore transfers
 * only aggregate evidence to JavaScript while the full-size frames stay on the
 * GPU.
 */
export const FILM_ANALYSIS_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uNext;
uniform ivec2 uSize;
uniform int uTopFieldFirst;

out vec4 fragColor;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

vec3 candidate(int x, int y, int match) {
  // fieldmatch keeps the opposite rows from the current frame and borrows the
  // selected field from its neighbour: odd rows for TFF and even rows for BFF.
  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;
  if ((y & 1) != borrowedParity || match == 1) {
    return texelFetch(uCur, ivec2(x, y), 0).rgb;
  }
  return match == 0
    ? texelFetch(uPrev, ivec2(x, y), 0).rgb
    : texelFetch(uNext, ivec2(x, y), 0).rgb;
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

float reducedCandidate(int x, int y, int match, ivec2 targetSize) {
  int sourceX = clamp(x * uSize.x / targetSize.x, 0, uSize.x - 1);
  return luma(candidate(sourceX, sourceY(y, targetSize.y), match));
}

float comb(int x, int y, int match, ivec2 targetSize) {
  // Apply the comb mask after the field-aware reduction. The three-row block
  // test in JavaScript can then use neighbouring target rows on the same scale
  // as FFmpeg's field-aware validation image.
  float minus2 = reducedCandidate(x, max(0, y - 2), match, targetSize);
  float minus1 = reducedCandidate(x, max(0, y - 1), match, targetSize);
  float pixel = reducedCandidate(x, y, match, targetSize);
  float plus1 = reducedCandidate(x, min(targetSize.y - 1, y + 1), match, targetSize);
  float plus2 = reducedCandidate(x, min(targetSize.y - 1, y + 2), match, targetSize);
  float threshold = 9.0 / 255.0;
  float vertical = abs(4.0 * pixel - 3.0 * (minus1 + plus1) + minus2 + plus2);
  return abs(pixel - minus1) > threshold &&
         abs(pixel - plus1) > threshold &&
         vertical > threshold * 6.0 ? 1.0 : 0.0;
}

void main() {
  ivec2 targetSize = ivec2(160, 90);
  ivec2 target = ivec2(gl_FragCoord.xy);
  int y = targetSize.y - 1 - target.y;
  fragColor = vec4(
    comb(target.x, y, 0, targetSize),
    comb(target.x, y, 1, targetSize),
    comb(target.x, y, 2, targetSize),
    1.0
  );
}
`;

/** Reconstructs one progressive film picture from the selected field match. */
export const FILM_WEAVE_FRAGMENT_SHADER = `#version 300 es
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
`;

/** Produces a reduced copy of the selected weave for duplicate detection. */
export const FILM_SAMPLE_FRAGMENT_SHADER = `#version 300 es
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
  ivec2 targetSize = ivec2(160, 90);
  ivec2 target = ivec2(gl_FragCoord.xy);
  int x = clamp(target.x * uSize.x / targetSize.x, 0, uSize.x - 1);
  int targetY = targetSize.y - 1 - target.y;
  // Reduce the top and bottom fields independently, preserving both parities
  // in the cadence sample for any even source-to-target height ratio.
  int parity = targetY & 1;
  int fieldY = (targetY / 2) * (uSize.y / 2) / (targetSize.y / 2);
  int y = clamp(fieldY * 2 + parity, 0, uSize.y - 1);
  // Keep this reduced candidate identical to the full-size weave so duplicate
  // scores describe the picture that the renderer will actually present.
  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;
  if ((y & 1) != borrowedParity || uMatch == 1) {
    fragColor = texelFetch(uCur, ivec2(x, y), 0);
  } else if (uMatch == 0) {
    fragColor = texelFetch(uPrev, ivec2(x, y), 0);
  } else {
    fragColor = texelFetch(uNext, ivec2(x, y), 0);
  }
}
`;
