/**
 * Everything this shader wants to be told, besides the three frames.
 *
 * `parity` is which lines survive: a line whose parity is this one is copied
 * from the current frame, and every other line is what the filter builds. For
 * one output frame per input frame that is `tff ? 0 : 1`, which keeps the field
 * that came first and rebuilds the moment it was captured at.
 *
 * With `film`, a frame whose pulldown phase `fieldMetrics` (see
 * film-shader.ts) gives is put back together into its film frame instead of
 * filtered; a frame's `second` field is always filtered. `phase` is the
 * phase the page expects, for the debug overlay only.
 */
export declare const YADIF_UNIFORMS: {
    readonly prev: "uPrev";
    readonly cur: "uCur";
    readonly next: "uNext";
    readonly size: "uSize";
    readonly parity: "uParity";
    readonly tff: "uTff";
    readonly spatialCheck: "uSpatialCheck";
    readonly debug: "uDebug";
    readonly film: "uFilm";
    readonly second: "uSecond";
    readonly phase: "uPhase";
    readonly fieldMetrics: "uFieldMetrics";
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
export declare const YADIF_FRAGMENT_SHADER: string;
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
export declare const FILM_ANALYSIS_WIDTH = 288;
/** Height of the reduced fieldmatch and decimate inputs. */
export declare const FILM_ANALYSIS_HEIGHT = 162;
/**
 * Reads reduced luma from the three frames available to fieldmatch.
 * RGB stores previous/current/next luma so one fixed-size readback supplies
 * the 8-bit analysis frames used by the CPU port of FFmpeg fieldmatch and
 * decimate. Scaling the two fields independently preserves their alternating
 * rows while the clean full-size frames stay on the GPU.
 */
export declare const FILM_ANALYSIS_FRAGMENT_SHADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n\nuniform sampler2D uPrev;\nuniform sampler2D uCur;\nuniform sampler2D uNext;\nuniform ivec2 uSize;\nout vec4 fragColor;\n\nfloat luma(vec3 rgb) {\n  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));\n}\n\nint sourceY(int targetY, int targetHeight) {\n  // Scale both fields independently so every adjacent target row still\n  // alternates parity. A direct full-frame scale can select only one parity\n  // when the source-to-target ratio is even, erasing the borrowed field.\n  int parity = targetY & 1;\n  int sourceFieldHeight = uSize.y / 2;\n  int targetFieldHeight = targetHeight / 2;\n  int fieldY = (targetY / 2) * sourceFieldHeight / targetFieldHeight;\n  return clamp(fieldY * 2 + parity, 0, uSize.y - 1);\n}\n\nvoid main() {\n  ivec2 targetSize = ivec2(288, 162);\n  ivec2 target = ivec2(gl_FragCoord.xy);\n  // readPixels returns the framebuffer's bottom row first, so writing the\n  // source's top row there gives JavaScript a conventional top-origin image.\n  int y = target.y;\n  int sourceX = clamp(target.x * uSize.x / targetSize.x, 0, uSize.x - 1);\n  int sourceRow = sourceY(y, targetSize.y);\n  ivec2 source = ivec2(sourceX, sourceRow);\n  fragColor = vec4(\n    luma(texelFetch(uPrev, source, 0).rgb),\n    luma(texelFetch(uCur, source, 0).rgb),\n    luma(texelFetch(uNext, source, 0).rgb),\n    1.0\n  );\n}\n";
/** Reconstructs one progressive film picture from the selected field match. */
export declare const FILM_WEAVE_FRAGMENT_SHADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n\nuniform sampler2D uPrev;\nuniform sampler2D uCur;\nuniform sampler2D uNext;\nuniform ivec2 uSize;\nuniform int uTopFieldFirst;\nuniform int uMatch;\n\nout vec4 fragColor;\n\nvoid main() {\n  ivec2 at = ivec2(gl_FragCoord.xy);\n  int y = uSize.y - 1 - at.y;\n  // p/n borrow the matched field from a neighbour after converting the\n  // framebuffer's bottom-origin coordinate to the frame's top-origin row.\n  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;\n  if ((y & 1) != borrowedParity || uMatch == 1) {\n    fragColor = texelFetch(uCur, ivec2(at.x, y), 0);\n  } else if (uMatch == 0) {\n    fragColor = texelFetch(uPrev, ivec2(at.x, y), 0);\n  } else {\n    fragColor = texelFetch(uNext, ivec2(at.x, y), 0);\n  }\n}\n";
/** Produces a reduced RGB copy of the selected weave for decimate metrics. */
export declare const FILM_SAMPLE_FRAGMENT_SHADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n\nuniform sampler2D uPrev;\nuniform sampler2D uCur;\nuniform sampler2D uNext;\nuniform ivec2 uSize;\nuniform int uTopFieldFirst;\nuniform int uMatch;\n\nout vec4 fragColor;\n\nvoid main() {\n  ivec2 targetSize = ivec2(288, 162);\n  ivec2 target = ivec2(gl_FragCoord.xy);\n  int x = clamp(target.x * uSize.x / targetSize.x, 0, uSize.x - 1);\n  // The bottom framebuffer row becomes the first readPixels row, so it holds\n  // the source's top row for the CPU's top-origin decimate blocks.\n  int targetY = target.y;\n  int parity = targetY & 1;\n  int fieldY = (targetY / 2) * (uSize.y / 2) / (targetSize.y / 2);\n  int y = clamp(fieldY * 2 + parity, 0, uSize.y - 1);\n  int borrowedParity = uTopFieldFirst != 0 ? 1 : 0;\n  if ((y & 1) != borrowedParity || uMatch == 1) {\n    fragColor = texelFetch(uCur, ivec2(x, y), 0);\n  } else if (uMatch == 0) {\n    fragColor = texelFetch(uPrev, ivec2(x, y), 0);\n  } else {\n    fragColor = texelFetch(uNext, ivec2(x, y), 0);\n  }\n}\n";
//# sourceMappingURL=shader.d.ts.map