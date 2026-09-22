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
export const FIELD_METRICS = {
  /** This frame's first field is the previous frame's first field. */
  firstRepeatsPrevious: 0,
  /** This frame's second field is the next frame's second field. */
  secondRepeatsNext: 1,
  /** This frame's second field is the previous frame's second field. */
  secondRepeatsPrevious: 2,
  /** The previous frame's second field was the one before's. */
  previousSecondRepeated: 3,
  /** This frame's first field is the next frame's first field. */
  firstRepeatsNext: 4,
  /** The previous frame's first field was the one before's. */
  previousFirstRepeated: 5,
  phase: 6,
} as const;

export const FIELD_METRICS_SIZE = 7;

/**
 * Differing blocks up to which two fields are the same (encoder noise on a
 * still), and from which they are plainly different. Between is neither.
 */
export const SAME_BLOCKS_MAX = 2;
export const DIFFERENT_BLOCKS_MIN = 16;

/** The phases whose frame holds two film frames; the first is the repeat. */
export const FILM_DUPLICATE_PHASE = 1;
export const FILM_MIXED_PHASE = 2;

/** Frames in a row with a phase before the cadence is believed: a cycle. */
export const FILM_LOCK_FRAMES = 5;

export const FIELD_COMPARE_UNIFORMS = {
  a: "uA",
  b: "uB",
  fieldMetrics: "uFieldMetrics",
  first: "uFirst",
  size: "uSize",
} as const;

/** Block size in field lines. */
export const FIELD_COMPARE_BLOCK_W = 16;
export const FIELD_COMPARE_BLOCK_H = 8;

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
export const FIELD_COMPARE_FRAGMENT_SHADER = `#version 300 es

precision highp float;

uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFieldMetrics;

/** The parity of the field captured first. */
uniform int uFirst;
uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

float luma(vec3 c)
{
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec4 measure(float diff, float total, float threshold)
{
  diff /= total;
  return vec4(diff, diff > threshold ? 1.0 : 0.0, diff, 1.0);
}

void main()
{
  const int BLOCK_W = ${FIELD_COMPARE_BLOCK_W};
  const int BLOCK_H = ${FIELD_COMPARE_BLOCK_H};

  ivec2 block = ivec2(gl_FragCoord.xy);
  ivec2 base = ivec2(block.x * BLOCK_W, block.y * BLOCK_H * 2);

  // Even and odd frame lines, summed apart.
  float diffEven = 0.0;
  float diffOdd = 0.0;
  int totalEven = 0;
  int totalOdd = 0;

  for (int y = 0; y < BLOCK_H; ++y) {
    for (int x = 0; x < BLOCK_W; ++x) {
      ivec2 p = base + ivec2(x, y * 2);

      if (p.x < uSize.x && p.y < uSize.y) {
        float a = luma(texelFetch(uA, p, 0).rgb);
        float b = luma(texelFetch(uB, p, 0).rgb);

        diffEven += abs(a - b);
        totalEven += 1;
      }
      p.y += 1;
      if (p.x < uSize.x && p.y < uSize.y) {
        float a = luma(texelFetch(uA, p, 0).rgb);
        float b = luma(texelFetch(uB, p, 0).rgb);

        diffOdd += abs(a - b);
        totalOdd += 1;
      }
    }
  }

  float run = texelFetch(uFieldMetrics, ivec2(${FIELD_METRICS.phase}, 0), 0)[1];
  float threshold = run == 0.0 ? 0.025 : (run <= 10.0 ? 0.11 : 0.15);

  vec4 even = measure(diffEven, float(totalEven), threshold);
  vec4 odd = measure(diffOdd, float(totalOdd), threshold);
  outFirst = uFirst == 0 ? even : odd;
  outSecond = uFirst == 0 ? odd : even;
}
`;

export const REDUCTION_UNIFORMS = {
  second: "uSecond",
  first: "uFirst",
  size: "uSize",
} as const;
export const REDUCTION_FACTOR = 8;

/** Fold a square of texels of both comparisons into one texel each. */
export const REDUCTION_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uSecond;
uniform sampler2D uFirst;

uniform ivec2 uSize;

layout(location = 0) out vec4 outSecond;
layout(location = 1) out vec4 outFirst;

void main()
{
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 base = dst * ${REDUCTION_FACTOR};

  vec4 second = vec4(0.0);
  vec4 first = vec4(0.0);

  for (int y = 0; y < ${REDUCTION_FACTOR}; ++y) {
    for (int x = 0; x < ${REDUCTION_FACTOR}; ++x) {
      ivec2 p = base + ivec2(x, y);

      if (p.x < uSize.x && p.y < uSize.y) {
        vec4 value = texelFetch(uSecond, p, 0);
        second[0] = max(second[0], value[0]);
        second.yzw += value.yzw;
        value = texelFetch(uFirst, p, 0);
        first[0] = max(first[0], value[0]);
        first.yzw += value.yzw;
      }
    }
  }

  outSecond = second;
  outFirst = first;
}
`;

export const METRICS_UNIFORMS = {
  previous: "uPrevious",
  second: "uSecond",
  first: "uFirst",
  size: "uSize",
} as const;

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
export const METRICS_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uPrevious;
uniform sampler2D uSecond;
uniform sampler2D uFirst;

/** The size of the reduced comparisons. */
uniform ivec2 uSize;

out vec4 outValue;

vec4 previous(int metric) {
  return texelFetch(uPrevious, ivec2(metric, 0), 0);
}

/** Fold what REDUCTION left into one texel. */
vec4 fold(sampler2D reduced) {
  vec4 sum = vec4(0.0);
  for (int y = 0; y < uSize.y; ++y) {
    for (int x = 0; x < uSize.x; ++x) {
      vec4 value = texelFetch(reduced, ivec2(x, y), 0);
      sum[0] = max(sum[0], value[0]);
      sum.yzw += value.yzw;
    }
  }
  return vec4(sum[0], sum[1], sum[2] / max(sum[3], 1.0), sum[3]);
}

bool same(float differing) {
  return differing <= ${SAME_BLOCKS_MAX}.0;
}

bool differs(float differing) {
  return differing >= ${DIFFERENT_BLOCKS_MIN}.0;
}

/** The phase texel, (phase, run), from the six comparisons' differing counts. */
vec4 decide(vec4 last, float dFirstRepeatsPrevious, float dSecondRepeatsNext,
            float dSecondRepeatsPrevious, float dPreviousSecondRepeated,
            float dFirstRepeatsNext, float dPreviousFirstRepeated)
{
  bool firstRepeatsPrevious = same(dFirstRepeatsPrevious);
  bool secondRepeatsNext = same(dSecondRepeatsNext);
  bool secondRepeatsPrevious = same(dSecondRepeatsPrevious);
  bool previousSecondRepeated = same(dPreviousSecondRepeated);
  bool firstRepeatsNext = same(dFirstRepeatsNext);
  bool previousFirstRepeated = same(dPreviousFirstRepeated);
  bool still = (firstRepeatsPrevious && secondRepeatsPrevious) || (secondRepeatsNext && firstRepeatsNext);

  int previous = int(last[0]);
  float run = last[1];
  // What each phase looks like: one field repeats, the other plainly does not.
  bool looks1 = firstRepeatsPrevious && differs(dSecondRepeatsPrevious);
  bool looks2 = secondRepeatsNext && differs(dFirstRepeatsNext);
  bool looks3 = secondRepeatsPrevious && differs(dFirstRepeatsPrevious);
  bool looks4 = previousSecondRepeated && differs(dPreviousFirstRepeated);
  bool looks5 = firstRepeatsNext && differs(dSecondRepeatsNext);

  int expected = previous == 0 ? 0 : (previous == 5 ? 1 : previous + 1);
  bool expectedRepeat =
    expected == 1 ? firstRepeatsPrevious :
    expected == 2 ? secondRepeatsNext :
    expected == 3 ? secondRepeatsPrevious :
    expected == 4 ? previousSecondRepeated :
    expected == 5 ? firstRepeatsNext : false;
  bool expectedLooks =
    expected == 1 ? looks1 :
    expected == 2 ? looks2 :
    expected == 3 ? looks3 :
    expected == 4 ? looks4 :
    expected == 5 ? looks5 : false;
  bool believed = run >= ${FILM_LOCK_FRAMES}.0;
  bool carried = believed ? expectedRepeat : expectedLooks;

  int phase = 0;
  if (expected != 0 && carried) {
    phase = expected;
    run += 1.0;
  } else if (expected != 0 && (still || expectedRepeat)) {
    // Uninformative: keeps the cycle's place, counts only once believed.
    phase = expected;
    if (believed) run += 1.0;
  } else if (looks1) {
    phase = 1;
  } else if (looks2) {
    phase = 2;
  } else if (looks3) {
    phase = 3;
  } else if (looks4) {
    phase = 4;
  } else if (looks5) {
    phase = 5;
  }
  if (phase != expected) run = phase != 0 ? 1.0 : 0.0;
  return vec4(float(phase), run, 0.0, 0.0);
}

void main()
{
  int metric = int(gl_FragCoord.x);
  // The comparisons against the next frame become, a frame later, the ones
  // against the previous frame, and those the ones before.
  if (metric == ${FIELD_METRICS.firstRepeatsPrevious}) {
    outValue = previous(${FIELD_METRICS.firstRepeatsNext});
  } else if (metric == ${FIELD_METRICS.secondRepeatsNext}) {
    outValue = fold(uSecond);
  } else if (metric == ${FIELD_METRICS.secondRepeatsPrevious}) {
    outValue = previous(${FIELD_METRICS.secondRepeatsNext});
  } else if (metric == ${FIELD_METRICS.previousSecondRepeated}) {
    outValue = previous(${FIELD_METRICS.secondRepeatsPrevious});
  } else if (metric == ${FIELD_METRICS.firstRepeatsNext}) {
    outValue = fold(uFirst);
  } else if (metric == ${FIELD_METRICS.previousFirstRepeated}) {
    outValue = previous(${FIELD_METRICS.firstRepeatsPrevious});
  } else {
    outValue = decide(
      previous(${FIELD_METRICS.phase}),
      previous(${FIELD_METRICS.firstRepeatsNext})[1],
      fold(uSecond)[1],
      previous(${FIELD_METRICS.secondRepeatsNext})[1],
      previous(${FIELD_METRICS.secondRepeatsPrevious})[1],
      fold(uFirst)[1],
      previous(${FIELD_METRICS.firstRepeatsPrevious})[1]
    );
  }
}
`;
