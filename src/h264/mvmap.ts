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
 * The half-sample position on both axes averages four samples, which two
 * predictions cannot express. There the bilinear is kept exact along one axis
 * and the six-tap handles the other, which measured better than letting H.264
 * interpolate both.
 */
import { BMbType } from "./mb.ts";

export interface MappedVector {
  /** One of BMbType. */
  mbType: number;
  /** List 0 vector in quarter samples. */
  l0: [number, number];
  /** List 1 vector, or null when the macroblock predicts from list 0 alone. */
  l1: [number, number] | null;
  /** False when the position could only be approximated. */
  exact: boolean;
}

/**
 * Map a forward motion vector given in half samples.
 *
 * Arithmetic shift gives the floor for negative values, so a vector of -3
 * becomes integer part -2 with a half-sample offset, i.e. -1.5 samples.
 */
export function mapForwardVector(
  mvxHalf: number,
  mvyHalf: number,
): MappedVector {
  const ix = mvxHalf >> 1;
  const iy = mvyHalf >> 1;
  const fx = mvxHalf & 1;
  const fy = mvyHalf & 1;

  if (fx === 0 && fy === 0) {
    return {
      mbType: BMbType.L0_16X16,
      l0: [ix * 4, iy * 4],
      l1: null,
      exact: true,
    };
  }
  if (fy === 0) {
    // Horizontal half sample: average the two adjacent whole-sample positions.
    return {
      mbType: BMbType.BI_16X16,
      l0: [ix * 4, iy * 4],
      l1: [(ix + 1) * 4, iy * 4],
      exact: true,
    };
  }
  if (fx === 0) {
    return {
      mbType: BMbType.BI_16X16,
      l0: [ix * 4, iy * 4],
      l1: [ix * 4, (iy + 1) * 4],
      exact: true,
    };
  }
  // Half sample on both axes. Both predictions sit at H.264's vertical half
  // sample, so the bi-prediction average runs horizontally and stays exactly
  // bilinear there; the six-tap filter absorbs the vertical axis.
  return {
    mbType: BMbType.BI_16X16,
    l0: [ix * 4, iy * 4 + 2],
    l1: [(ix + 1) * 4, iy * 4 + 2],
    exact: false,
  };
}
