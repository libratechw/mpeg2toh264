/**
 * Mapping MPEG-2 motion vectors onto H.264 prediction.
 *
 * MPEG-2 vectors are in half samples and its half-sample prediction is the
 * bilinear average (a + b + 1) >> 1. H.264's default bi-prediction averages its
 * two list predictions as (P0 + P1 + 1) >> 1, so pointing both lists at the same
 * reference picture one whole sample apart reproduces that filter exactly --
 * H.264's own six-tap interpolation never runs. tools/verify-bipred.ts checks
 * this against a real decoder; every case matches bit for bit.
 *
 * Two things cannot be reproduced:
 *
 * - The half-sample position on both axes averages four samples, which two
 *   predictions cannot express. There the bilinear is kept exact along one axis
 *   and the six-tap handles the other, which measured better than letting
 *   H.264 interpolate both.
 * - Chroma. MPEG-2 halves the luma vector with truncation toward zero
 *   (clause 7.6.3.7) while H.264 derives chroma motion from the luma vector at
 *   eighth-sample precision, so an odd luma vector puts chroma a quarter of a
 *   chroma sample out. H.264 offers no way to set chroma motion separately, so
 *   this is there however the luma is mapped.
 */

/** What a mapped vector costs in fidelity. */
export const VectorKind = {
  /** Whole-sample position: luma and chroma both exact. */
  INTEGER: 0,
  /** Half sample on one axis: luma exact, chroma a quarter sample out. */
  HALF_ONE_AXIS: 1,
  /** Half sample on both axes: luma approximate as well. */
  HALF_BOTH_AXES: 2,
} as const;

export interface MappedPosition {
  kind: number;
  /** Primary position in quarter samples. */
  a: [number, number];
  /**
   * Second position for the bi-predicted pair, or null when one prediction is
   * enough. Both refer to the same reference picture.
   */
  b: [number, number] | null;
}

/**
 * Map one MPEG-2 vector, given in half samples, to the position or pair of
 * positions that reproduce its prediction.
 *
 * Arithmetic shift gives the floor for negative values, matching the DIV of
 * clause 7.6.4: a vector of -3 is integer part -2 with a half-sample offset.
 */
export function mapVector(mvxHalf: number, mvyHalf: number): MappedPosition {
  const ix = mvxHalf >> 1;
  const iy = mvyHalf >> 1;
  const fx = mvxHalf & 1;
  const fy = mvyHalf & 1;

  if (fx === 0 && fy === 0) {
    return { kind: VectorKind.INTEGER, a: [ix * 4, iy * 4], b: null };
  }
  if (fy === 0) {
    return {
      kind: VectorKind.HALF_ONE_AXIS,
      a: [ix * 4, iy * 4],
      b: [(ix + 1) * 4, iy * 4],
    };
  }
  if (fx === 0) {
    return {
      kind: VectorKind.HALF_ONE_AXIS,
      a: [ix * 4, iy * 4],
      b: [ix * 4, (iy + 1) * 4],
    };
  }
  // Both predictions sit at H.264's vertical half sample, so the bi-prediction
  // average runs horizontally and stays exactly bilinear there; the six-tap
  // filter absorbs the vertical axis.
  return {
    kind: VectorKind.HALF_BOTH_AXES,
    a: [ix * 4, iy * 4 + 2],
    b: [(ix + 1) * 4, iy * 4 + 2],
  };
}

/**
 * The plain quarter-sample position, letting H.264 interpolate. Used where both
 * predictions are already spoken for -- a bidirectional macroblock averages a
 * forward and a backward prediction, so neither side has a spare slot for the
 * bilinear pair. The averaging structure still matches MPEG-2's; only the
 * sub-sample filter differs.
 */
export function nativePosition(
  mvxHalf: number,
  mvyHalf: number,
): [number, number] {
  return [mvxHalf * 2, mvyHalf * 2];
}
