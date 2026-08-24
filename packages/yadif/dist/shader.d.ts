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
export declare const YADIF_UNIFORMS: {
    readonly prev: "uPrev";
    readonly cur: "uCur";
    readonly next: "uNext";
    readonly size: "uSize";
    readonly parity: "uParity";
    readonly tff: "uTff";
    readonly spatialCheck: "uSpatialCheck";
};
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
export declare const YADIF_FRAGMENT_SHADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n\nuniform sampler2D uPrev;\nuniform sampler2D uCur;\nuniform sampler2D uNext;\n/** The size of a frame in texels. */\nuniform ivec2 uSize;\n/** The parity of the lines that are kept; the others are interpolated. */\nuniform int uParity;\n/** Whether the first field of a frame is its top field. */\nuniform int uTff;\n/** Whether the temporal bound is widened by the local vertical range. */\nuniform bool uSpatialCheck;\n\nout vec4 fragColor;\n\n/**\n * A texel, with the edges of the frame mirrored.\n *\n * The reference reflects its line offsets on the first and last line rather\n * than reading outside the frame, and this is the same thing said once.\n */\nvec3 fetch(sampler2D image, int x, int y) {\n  int line = y < 0 ? -y : (y >= uSize.y ? 2 * (uSize.y - 1) - y : y);\n  return texelFetch(image, ivec2(clamp(x, 0, uSize.x - 1), clamp(line, 0, uSize.y - 1)), 0).rgb;\n}\n\n/**\n * Interpolate the missing line along whichever direction the picture runs in.\n *\n * a..g are the seven texels of the line above and h..n those of the line\n * below, both centred on the pixel being built. The straight vertical average\n * is the starting point, and each candidate direction is taken only if the\n * three differences across it are smaller than the best so far; the steeper\n * pair of directions is only considered when the shallower one was an\n * improvement, which is what keeps a busy picture from finding an edge that is\n * not there.\n */\nvec3 spatialPredictor(vec3 a, vec3 b, vec3 c, vec3 d, vec3 e, vec3 f, vec3 g,\n                      vec3 h, vec3 i, vec3 j, vec3 k, vec3 l, vec3 m, vec3 n) {\n  vec3 pred = (d + k) * 0.5;\n  vec3 best = abs(c - j) + abs(d - k) + abs(e - l);\n\n  vec3 score = abs(b - k) + abs(c - l) + abs(d - m);\n  vec3 taken = vec3(lessThan(score, best));\n  pred = mix(pred, (c + l) * 0.5, taken);\n  best = mix(best, score, taken);\n\n  score = abs(a - l) + abs(b - m) + abs(c - n);\n  taken *= vec3(lessThan(score, best));\n  pred = mix(pred, (b + m) * 0.5, taken);\n  best = mix(best, score, taken);\n\n  score = abs(d - i) + abs(e - j) + abs(f - k);\n  taken = vec3(lessThan(score, best));\n  pred = mix(pred, (e + j) * 0.5, taken);\n  best = mix(best, score, taken);\n\n  score = abs(e - h) + abs(f - i) + abs(g - j);\n  taken *= vec3(lessThan(score, best));\n  pred = mix(pred, (f + i) * 0.5, taken);\n\n  return pred;\n}\n\n/**\n * Hold the spatial guess to what the moving picture allows.\n *\n * p2 is where the line would be if nothing moved -- the average of the same\n * line in the two frames that bracket this moment -- and the three temporal\n * differences say how much did move. The spatial guess is then clamped to that\n * distance from p2: still picture, and the answer is the line that is really\n * there; motion, and the interpolation is free to take over.\n */\nvec3 temporalPredictor(vec3 A, vec3 B, vec3 C, vec3 D, vec3 E, vec3 F,\n                       vec3 G, vec3 H, vec3 I, vec3 J, vec3 K, vec3 L,\n                       vec3 spatialPred, bool skipCheck) {\n  vec3 p0 = (C + H) * 0.5;\n  vec3 p1 = F;\n  vec3 p2 = (D + I) * 0.5;\n  vec3 p3 = G;\n  vec3 p4 = (E + J) * 0.5;\n\n  vec3 tdiff0 = abs(D - I) * 0.5;\n  vec3 tdiff1 = (abs(A - F) + abs(B - G)) * 0.5;\n  vec3 tdiff2 = (abs(K - F) + abs(G - L)) * 0.5;\n\n  vec3 diff = max(tdiff0, max(tdiff1, tdiff2));\n\n  if (!skipCheck) {\n    vec3 hi = max(p2 - p3, max(p2 - p1, min(p0 - p1, p4 - p3)));\n    vec3 lo = min(p2 - p3, min(p2 - p1, max(p0 - p1, p4 - p3)));\n    diff = max(diff, max(lo, -hi));\n  }\n\n  return clamp(spatialPred, p2 - diff, p2 + diff);\n}\n\n/**\n * Build one interpolated pixel.\n *\n * prev2 and next2 are the frames the missing line is bracketed by, which is\n * not the same pair as prev and next: the field being rebuilt is half a frame\n * from one of its neighbours and one and a half from the other, and it is the\n * near pair that says what the picture looked like around this moment. prev\n * and next themselves are still read, for the two motion measurements.\n */\nvec3 filterPixel(sampler2D prev2, sampler2D next2, int x, int y) {\n  vec3 a = fetch(uCur, x - 3, y - 1);\n  vec3 b = fetch(uCur, x - 2, y - 1);\n  vec3 c = fetch(uCur, x - 1, y - 1);\n  vec3 d = fetch(uCur, x, y - 1);\n  vec3 e = fetch(uCur, x + 1, y - 1);\n  vec3 f = fetch(uCur, x + 2, y - 1);\n  vec3 g = fetch(uCur, x + 3, y - 1);\n\n  vec3 h = fetch(uCur, x - 3, y + 1);\n  vec3 i = fetch(uCur, x - 2, y + 1);\n  vec3 j = fetch(uCur, x - 1, y + 1);\n  vec3 k = fetch(uCur, x, y + 1);\n  vec3 l = fetch(uCur, x + 1, y + 1);\n  vec3 m = fetch(uCur, x + 2, y + 1);\n  vec3 n = fetch(uCur, x + 3, y + 1);\n\n  // Within three texels of either side there is no room to look along an edge,\n  // so the reference takes the vertical average there and so does this.\n  bool interior = x >= 3 && x + 3 < uSize.x;\n  vec3 spatialPred = interior ? spatialPredictor(a, b, c, d, e, f, g, h, i, j, k, l, m, n)\n                              : (d + k) * 0.5;\n\n  vec3 A = fetch(uPrev, x, y - 1);\n  vec3 B = fetch(uPrev, x, y + 1);\n  vec3 C = fetch(prev2, x, y - 2);\n  vec3 D = fetch(prev2, x, y);\n  vec3 E = fetch(prev2, x, y + 2);\n  vec3 F = d;\n  vec3 G = k;\n  vec3 H = fetch(next2, x, y - 2);\n  vec3 I = fetch(next2, x, y);\n  vec3 J = fetch(next2, x, y + 2);\n  vec3 K = fetch(uNext, x, y - 1);\n  vec3 L = fetch(uNext, x, y + 1);\n\n  // The first and last line the filter builds have only one line of picture\n  // outside them, so the range the spatial check would be measured over is not\n  // there. The reference drops the check on those two lines.\n  bool skipCheck = !uSpatialCheck || y < 2 || y + 2 >= uSize.y;\n  return temporalPredictor(A, B, C, D, E, F, G, H, I, J, K, L, spatialPred, skipCheck);\n}\n\nvoid main() {\n  ivec2 at = ivec2(gl_FragCoord.xy);\n  int x = at.x;\n  // The framebuffer counts its rows from the bottom and a frame from the top.\n  int y = uSize.y - 1 - at.y;\n\n  vec3 rgb;\n  if ((y & 1) == uParity) {\n    rgb = texelFetch(uCur, ivec2(x, y), 0).rgb;\n  } else if ((uParity ^ uTff) != 0) {\n    // The first field of the frame: the moment it holds sits between the\n    // previous frame and the second field of this one.\n    rgb = filterPixel(uPrev, uCur, x, y);\n  } else {\n    rgb = filterPixel(uCur, uNext, x, y);\n  }\n  fragColor = vec4(rgb, 1.0);\n}\n";
/** Uniforms shared by the reduced luma and field-weave shaders. */
export declare const FILM_UNIFORMS: {
    readonly prev: "uPrev";
    readonly cur: "uCur";
    readonly next: "uNext";
    readonly size: "uSize";
    readonly topFieldFirst: "uTopFieldFirst";
    readonly match: "uMatch";
};
/** Width of the reduced fieldmatch and decimate inputs. */
export declare const FILM_ANALYSIS_WIDTH = 160;
/** Height of the reduced fieldmatch and decimate inputs. */
export declare const FILM_ANALYSIS_HEIGHT = 90;
/**
 * Reads reduced luma from the three frames available to fieldmatch.
 * RGB stores previous/current/next luma so one fixed-size readback supplies
 * the 8-bit analysis frames used by the CPU port of FFmpeg fieldmatch and
 * decimate. Scaling the two fields independently preserves their alternating
 * rows while the clean full-size frames stay on the GPU.
 */
export declare const FILM_ANALYSIS_FRAGMENT_SHADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n\nuniform sampler2D uPrev;\nuniform sampler2D uCur;\nuniform sampler2D uNext;\nuniform ivec2 uSize;\nout vec4 fragColor;\n\nfloat luma(vec3 rgb) {\n  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));\n}\n\nint sourceY(int targetY, int targetHeight) {\n  // Scale both fields independently so every adjacent target row still\n  // alternates parity. A direct full-frame scale can select only one parity\n  // when the source-to-target ratio is even, erasing the borrowed field.\n  int parity = targetY & 1;\n  int sourceFieldHeight = uSize.y / 2;\n  int targetFieldHeight = targetHeight / 2;\n  int fieldY = (targetY / 2) * sourceFieldHeight / targetFieldHeight;\n  return clamp(fieldY * 2 + parity, 0, uSize.y - 1);\n}\n\nvoid main() {\n  ivec2 targetSize = ivec2(160, 90);\n  ivec2 target = ivec2(gl_FragCoord.xy);\n  // readPixels returns the framebuffer's bottom row first, so writing the\n  // source's top row there gives JavaScript a conventional top-origin image.\n  int y = target.y;\n  int sourceX = clamp(target.x * uSize.x / targetSize.x, 0, uSize.x - 1);\n  int sourceRow = sourceY(y, targetSize.y);\n  ivec2 source = ivec2(sourceX, sourceRow);\n  fragColor = vec4(\n    luma(texelFetch(uPrev, source, 0).rgb),\n    luma(texelFetch(uCur, source, 0).rgb),\n    luma(texelFetch(uNext, source, 0).rgb),\n    1.0\n  );\n}\n";
/** Reconstructs one progressive film picture from the selected field match. */
export declare const FILM_WEAVE_FRAGMENT_SHADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n\nuniform sampler2D uPrev;\nuniform sampler2D uCur;\nuniform sampler2D uNext;\nuniform ivec2 uSize;\nuniform int uTopFieldFirst;\nuniform int uMatch;\n\nout vec4 fragColor;\n\nvoid main() {\n  ivec2 at = ivec2(gl_FragCoord.xy);\n  int y = uSize.y - 1 - at.y;\n  // p/n borrow the matched field from a neighbour after converting the\n  // framebuffer's bottom-origin coordinate to the frame's top-origin row.\n  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;\n  if ((y & 1) != borrowedParity || uMatch == 1) {\n    fragColor = texelFetch(uCur, ivec2(at.x, y), 0);\n  } else if (uMatch == 0) {\n    fragColor = texelFetch(uPrev, ivec2(at.x, y), 0);\n  } else {\n    fragColor = texelFetch(uNext, ivec2(at.x, y), 0);\n  }\n}\n";
/** Produces a reduced RGB copy of the selected weave for decimate metrics. */
export declare const FILM_SAMPLE_FRAGMENT_SHADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n\nuniform sampler2D uPrev;\nuniform sampler2D uCur;\nuniform sampler2D uNext;\nuniform ivec2 uSize;\nuniform int uTopFieldFirst;\nuniform int uMatch;\n\nout vec4 fragColor;\n\nvoid main() {\n  ivec2 targetSize = ivec2(160, 90);\n  ivec2 target = ivec2(gl_FragCoord.xy);\n  int x = clamp(target.x * uSize.x / targetSize.x, 0, uSize.x - 1);\n  // The bottom framebuffer row becomes the first readPixels row, so it holds\n  // the source's top row for the CPU's top-origin decimate blocks.\n  int targetY = target.y;\n  int parity = targetY & 1;\n  int fieldY = (targetY / 2) * (uSize.y / 2) / (targetSize.y / 2);\n  int y = clamp(fieldY * 2 + parity, 0, uSize.y - 1);\n  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;\n  if ((y & 1) != borrowedParity || uMatch == 1) {\n    fragColor = texelFetch(uCur, ivec2(x, y), 0);\n  } else if (uMatch == 0) {\n    fragColor = texelFetch(uPrev, ivec2(x, y), 0);\n  } else {\n    fragColor = texelFetch(uNext, ivec2(x, y), 0);\n  }\n}\n";
//# sourceMappingURL=shader.d.ts.map