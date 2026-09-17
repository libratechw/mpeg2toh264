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
 * FIELD_COMPARE measures one field of two frames block by block, REDUCTION
 * folds the blocks into one texel, and DETECT reads the texels and decides
 * the phase. "First" and "second" are the fields in capture order.
 */

/**
 * The texels of the field-metrics texture. Each comparison texel is `(max,
 * differing, mean)`: the largest block mean absolute luma difference, how
 * many blocks were over the threshold, and the mean over all blocks. The
 * `phase` texel is `(phase, run)`.
 *
 * Only the two comparisons against the next frame are measured per frame;
 * the rest are earlier ones moved along by the deinterlacer.
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
  parity: "uParity",
  size: "uSize",
} as const;

/** Block size in field lines. */
export const FIELD_COMPARE_BLOCK_W = 16;
export const FIELD_COMPARE_BLOCK_H = 8;

/**
 * Compare one field of two frames block by block. The threshold on a
 * block's mean absolute luma difference is tight until a cadence is found
 * and loosens as it holds.
 */
export const FIELD_COMPARE_FRAGMENT_SHADER = `#version 300 es

precision highp float;

uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFieldMetrics;

uniform int uParity;
uniform ivec2 uSize;

out vec4 outValue;

float luma(vec3 c)
{
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main()
{
  const int BLOCK_W = ${FIELD_COMPARE_BLOCK_W};
  const int BLOCK_H = ${FIELD_COMPARE_BLOCK_H};

  ivec2 block = ivec2(gl_FragCoord.xy);
  ivec2 base = ivec2(
    block.x * BLOCK_W,
    block.y * BLOCK_H * 2 + uParity
  );

  float diff = 0.0;
  int total = 0;

  for (int y = 0; y < BLOCK_H; ++y) {
    for (int x = 0; x < BLOCK_W; ++x) {
      ivec2 p = base + ivec2(x, y * 2);

      if (p.x < uSize.x && p.y < uSize.y) {
        float a = luma(texelFetch(uA, p, 0).rgb);
        float b = luma(texelFetch(uB, p, 0).rgb);

        diff += abs(a - b);
        total += 1;
      }
    }
  }

  diff /= float(total);
  float run = texelFetch(uFieldMetrics, ivec2(${FIELD_METRICS.phase}, 0), 0)[1];
  float threshold = run == 0.0 ? 0.025 : (run <= 10.0 ? 0.11 : 0.15);

  outValue = vec4(diff, diff > threshold ? 1.0 : 0.0, diff, 0.0);
}
`;

export const REDUCTION_UNIFORMS = {
  input: "uInput",
  size: "uSize",
} as const;
export const REDUCTION_FACTOR = 4;

/** Fold a square of texels into one, until a comparison is one texel. */
export const REDUCTION_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uInput;

uniform ivec2 uSize;
out vec4 outValue;

void main()
{
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 base = dst * ${REDUCTION_FACTOR};

  vec4 sum = vec4(0.0);
  int total = 0;

  for (int y = 0; y < ${REDUCTION_FACTOR}; ++y) {
    for (int x = 0; x < ${REDUCTION_FACTOR}; ++x) {
      ivec2 p = base + ivec2(x, y);

      if (p.x < uSize.x && p.y < uSize.y) {
        vec4 value = texelFetch(uInput, p, 0);
        sum[0] = max(sum[0], value[0]);
        sum[1] += value[1];
        sum[2] += value[2];
        total += 1;
      }
    }
  }

  sum[2] /= float(total);
  outValue = sum;
}
`;

export const DETECT_UNIFORMS = {
  fieldMetrics: "uFieldMetrics",
} as const;

/**
 * Decide the pulldown phase of a frame from the comparisons.
 *
 * Each phase is told by one field that repeats and one that does not. Held
 * film frames (animation) make the latter unreliable, so once a cycle has
 * been seen whole it is carried on by the repeat alone; until then every
 * frame has to show both. A still (both fields the same as a neighbour's)
 * keeps the cycle's place but counts only once the cycle is believed.
 */
export const DETECT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uFieldMetrics;
out vec4 outValue;

float differing(int metric) {
  return texelFetch(uFieldMetrics, ivec2(metric, 0), 0)[1];
}

bool same(int metric) {
  return differing(metric) <= ${SAME_BLOCKS_MAX}.0;
}

bool differs(int metric) {
  return differing(metric) >= ${DIFFERENT_BLOCKS_MIN}.0;
}

void main()
{
  bool firstRepeatsPrevious = same(${FIELD_METRICS.firstRepeatsPrevious});
  bool secondRepeatsNext = same(${FIELD_METRICS.secondRepeatsNext});
  bool secondRepeatsPrevious = same(${FIELD_METRICS.secondRepeatsPrevious});
  bool previousSecondRepeated = same(${FIELD_METRICS.previousSecondRepeated});
  bool firstRepeatsNext = same(${FIELD_METRICS.firstRepeatsNext});
  bool previousFirstRepeated = same(${FIELD_METRICS.previousFirstRepeated});
  bool still = (firstRepeatsPrevious && secondRepeatsPrevious) || (secondRepeatsNext && firstRepeatsNext);

  vec4 last = texelFetch(uFieldMetrics, ivec2(${FIELD_METRICS.phase}, 0), 0);
  int previous = int(last[0]);
  float run = last[1];
  // What each phase looks like: one field repeats, the other plainly does not.
  bool looks1 = firstRepeatsPrevious && differs(${FIELD_METRICS.secondRepeatsPrevious});
  bool looks2 = secondRepeatsNext && differs(${FIELD_METRICS.firstRepeatsNext});
  bool looks3 = secondRepeatsPrevious && differs(${FIELD_METRICS.firstRepeatsPrevious});
  bool looks4 = previousSecondRepeated && differs(${FIELD_METRICS.previousFirstRepeated});
  bool looks5 = firstRepeatsNext && differs(${FIELD_METRICS.secondRepeatsNext});

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
  outValue = vec4(float(phase), run, 0.0, 0.0);
}
`;
