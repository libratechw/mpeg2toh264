/**
 * 2:3 pulldown detection on the GPU.
 *
 * With P, Q, R, S for the film frames and the first field of each frame
 * written first:
 *
 * | frame    | P P | Q Q | Q R | R S | S S |
 * |----------|-----|-----|-----|-----|-----|
 * | phase    |  4  |  5  |  1  |  2  |  3  |
 * | shown as |  P  |  Q  |  -- |  R  |  S  |
 *
 * Phases 1 and 2 are put together from the frame's first field and the
 * previous frame's second; phase 1 then repeats the previous film frame and
 * is dropped. The phases are numbered in the order they are told apart in.
 *
 * Three passes a frame, none of them a copy. FIELD_COMPARE measures both
 * fields of two frames block by block in one go, REDUCTION folds the blocks
 * most of the way down, and METRICS finishes the fold, moves the earlier
 * comparisons along, and decides the phase, writing the whole metrics row of
 * one frame from the row of the frame before. "First" and "second" are the
 * fields in capture order.
 */
/**
 * The texels of the field-metrics texture. Each comparison texel is `(max,
 * differing, mean, blocks)`: the largest block mean absolute luma difference,
 * how many blocks were over the threshold, the mean over all blocks, and how
 * many blocks there were. The `phase` texel is `(phase, run)`.
 *
 * Only the two comparisons against the next frame are measured per frame;
 * the rest are earlier ones moved along by METRICS.
 */
export declare const FIELD_METRICS: {
    /** This frame's first field is the previous frame's first field. */
    readonly firstRepeatsPrevious: 0;
    /** This frame's second field is the next frame's second field. */
    readonly secondRepeatsNext: 1;
    /** This frame's second field is the previous frame's second field. */
    readonly secondRepeatsPrevious: 2;
    /** The previous frame's second field was the one before's. */
    readonly previousSecondRepeated: 3;
    /** This frame's first field is the next frame's first field. */
    readonly firstRepeatsNext: 4;
    /** The previous frame's first field was the one before's. */
    readonly previousFirstRepeated: 5;
    readonly phase: 6;
};
export declare const FIELD_METRICS_SIZE = 7;
/** Differing blocks tolerated when two fields repeat with encoder noise. */
export declare const SAME_BLOCKS_MAX = 2;
/** The phases whose frame holds two film frames; the first is the repeat. */
export declare const FILM_DUPLICATE_PHASE = 1;
export declare const FILM_MIXED_PHASE = 2;
/**
 * Informative phases required to confirm a cadence: two cycles.
 * Brief asymmetry between moving fields can resemble one pulldown cycle.
 */
export declare const FILM_LOCK_FRAMES = 10;
export declare const FIELD_COMPARE_UNIFORMS: {
    readonly a: "uA";
    readonly b: "uB";
    readonly fieldMetrics: "uFieldMetrics";
    readonly first: "uFirst";
    readonly size: "uSize";
};
/** Block size in field lines. */
export declare const FIELD_COMPARE_BLOCK_W = 16;
export declare const FIELD_COMPARE_BLOCK_H = 8;
/**
 * Compare both fields of two frames block by block. A block is BLOCK_W by
 * BLOCK_H lines of each field, which is BLOCK_H * 2 consecutive frame lines,
 * so the two fields are measured in one pass over each texel. The second
 * field goes to the first output and the first field to the second, which
 * is the order the metrics are numbered in.
 *
 * The threshold on a block's mean absolute luma difference is tight until a
 * cadence is found and loosens as it holds.
 */
export declare const FIELD_COMPARE_FRAGMENT_SHADER: string;
export declare const REDUCTION_UNIFORMS: {
    readonly second: "uSecond";
    readonly first: "uFirst";
    readonly size: "uSize";
};
export declare const REDUCTION_FACTOR = 8;
/** Fold a square of texels of both comparisons into one texel each. */
export declare const REDUCTION_FRAGMENT_SHADER = "#version 300 es\nprecision highp float;\n\nuniform sampler2D uSecond;\nuniform sampler2D uFirst;\n\nuniform ivec2 uSize;\n\nlayout(location = 0) out vec4 outSecond;\nlayout(location = 1) out vec4 outFirst;\n\nvoid main()\n{\n  ivec2 dst = ivec2(gl_FragCoord.xy);\n  ivec2 base = dst * 8;\n\n  vec4 second = vec4(0.0);\n  vec4 first = vec4(0.0);\n\n  for (int y = 0; y < 8; ++y) {\n    for (int x = 0; x < 8; ++x) {\n      ivec2 p = base + ivec2(x, y);\n\n      if (p.x < uSize.x && p.y < uSize.y) {\n        vec4 value = texelFetch(uSecond, p, 0);\n        second[0] = max(second[0], value[0]);\n        second.yzw += value.yzw;\n        value = texelFetch(uFirst, p, 0);\n        first[0] = max(first[0], value[0]);\n        first.yzw += value.yzw;\n      }\n    }\n  }\n\n  outSecond = second;\n  outFirst = first;\n}\n";
export declare const METRICS_UNIFORMS: {
    readonly previous: "uPrevious";
    readonly second: "uSecond";
    readonly first: "uFirst";
    readonly size: "uSize";
};
/**
 * Write the metrics row of a frame from the row of the frame before and the
 * two comparisons just measured, and decide the pulldown phase.
 *
 * Each phase is told by one field that repeats and one that does not. Held
 * film frames (animation) make the latter unreliable, so once two cycles have
 * been observed the cadence is carried on by the repeat alone; until then every
 * frame has to show both. A still (both fields the same as a neighbour's)
 * keeps the cycle's place but counts only once the cycle is believed.
 */
export declare const METRICS_FRAGMENT_SHADER: string;
/** The side of the square blocks the comb check counts in, in frame pixels. */
export declare const COMB_BLOCK = 16;
/**
 * Combed pixels on a block's second-field lines at which the whole block is
 * interpolated rather than woven. Half a block's lines are the second field's,
 * so this is 8 of 128. A thin horizontal line lies on one of them and moves
 * with the picture, so it takes more than one line's worth to trip the block,
 * and a stray pixel of mismatch is not worth breaking up a woven block for.
 */
export declare const COMB_BLOCK_PIXELS = 8;
export declare const COMB_UNIFORMS: {
    readonly prev: "uPrev";
    readonly cur: "uCur";
    readonly first: "uFirst";
    readonly size: "uSize";
};
/**
 * Count, block by block, the pixels a woven film frame would show combed.
 *
 * Film reconstruction trusts the cadence: a frame whose phase says it is one
 * film frame goes out as it is, and the frame that holds two gets the previous
 * frame's second field. A cut made after pulldown, a fade or a wipe done at
 * field rate, or a telop scrolled over the film breaks that
 * for part of a frame or for one frame at a cut, and a field from another
 * moment laid between the first field's lines is combing wherever anything
 * moved. The cadence cannot see it: it is decided from whole-frame repeats.
 *
 * Both ways of weaving are measured, the frame as it stands (red) and with
 * the previous frame's second field (green). A second-field pixel counts where
 * it stands apart from the first-field lines either side of it in the same
 * direction by more than the threshold, the five-line test (the same pattern
 * two lines apart) agrees that it alternates rather than being a thin line,
 * and it changed since the previous frame -- still detail is never combing,
 * whatever its shape. The filter interpolates a block past COMB_BLOCK_PIXELS
 * instead of weaving it; blocks rather than pixels, since weak combing left
 * between the pixels that crossed the threshold looks worse than either.
 */
export declare const COMB_FRAGMENT_SHADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n\nuniform sampler2D uPrev;\nuniform sampler2D uCur;\n/** The parity of the lines of the field captured first. */\nuniform int uFirst;\nuniform ivec2 uSize;\n\nout vec4 outValue;\n\nconst float COMB = 8.0 / 255.0;\n\nfloat luma(sampler2D image, int x, int y) {\n  int line = y < 0 ? -y : (y >= uSize.y ? 2 * (uSize.y - 1) - y : y);\n  vec3 c = texelFetch(image, ivec2(x, clamp(line, 0, uSize.y - 1)), 0).rgb;\n  return dot(c, vec3(0.2126, 0.7152, 0.0722));\n}\n\nbool combed(float above2, float above, float pixel, float below, float below2) {\n  float d1 = pixel - above;\n  float d2 = pixel - below;\n  return ((d1 > COMB && d2 > COMB) || (d1 < -COMB && d2 < -COMB)) &&\n    abs(above2 + 4.0 * pixel + below2 - 3.0 * (above + below)) > 6.0 * COMB;\n}\n\nvoid main() {\n  // Block rows count from the top of the frame, as the filter reads them.\n  ivec2 block = ivec2(gl_FragCoord.xy);\n  ivec2 base = block * 16;\n  float standing = 0.0;\n  float woven = 0.0;\n  for (int dy = 0; dy < 16; ++dy) {\n    int y = base.y + dy;\n    if (y >= uSize.y || (y & 1) == uFirst) continue;\n    for (int dx = 0; dx < 16; ++dx) {\n      int x = base.x + dx;\n      if (x >= uSize.x) break;\n      float current = luma(uCur, x, y);\n      float previous = luma(uPrev, x, y);\n      if (abs(current - previous) <= COMB) continue;\n      // The first field's lines either side are the same whichever second\n      // field is woven between them.\n      float above = luma(uCur, x, y - 1);\n      float below = luma(uCur, x, y + 1);\n      if (combed(luma(uCur, x, y - 2), above, current, below, luma(uCur, x, y + 2)))\n        standing += 1.0;\n      if (combed(luma(uPrev, x, y - 2), above, previous, below, luma(uPrev, x, y + 2)))\n        woven += 1.0;\n    }\n  }\n  outValue = vec4(standing, woven, 0.0, 0.0);\n}\n";
//# sourceMappingURL=film-shader.d.ts.map