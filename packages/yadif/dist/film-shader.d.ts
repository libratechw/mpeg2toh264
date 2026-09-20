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
/**
 * Differing blocks up to which two fields are the same (encoder noise on a
 * still), and from which they are plainly different. Between is neither.
 */
export declare const SAME_BLOCKS_MAX = 2;
export declare const DIFFERENT_BLOCKS_MIN = 16;
/** The phases whose frame holds two film frames; the first is the repeat. */
export declare const FILM_DUPLICATE_PHASE = 1;
export declare const FILM_MIXED_PHASE = 2;
/** Frames in a row with a phase before the cadence is believed: a cycle. */
export declare const FILM_LOCK_FRAMES = 5;
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
 * film frames (animation) make the latter unreliable, so once a cycle has
 * been seen whole it is carried on by the repeat alone; until then every
 * frame has to show both. A still (both fields the same as a neighbour's)
 * keeps the cycle's place but counts only once the cycle is believed.
 */
export declare const METRICS_FRAGMENT_SHADER: string;
//# sourceMappingURL=film-shader.d.ts.map