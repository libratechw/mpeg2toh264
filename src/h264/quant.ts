/**
 * Mapping MPEG-2 coefficients onto H.264 coefficient levels.
 *
 * Both formats reconstruct from orthonormal-DCT coefficients, which is what
 * makes the mapping possible at all: MPEG-2's dequantised value and the value
 * an H.264 decoder reconstructs live in the same space, so the level is just
 * the target divided by what one unit of level is worth.
 */
import { BASE_GAIN_8X8 } from "./quant-tables.ts";

/** How much finer than the source the H.264 quantiser is made. */
export interface QuantiserOptions {
  /**
   * Ratio between the MPEG-2 step and the H.264 step. At 1 the levels transfer
   * almost unchanged, but rounding them adds an error comparable to the one
   * MPEG-2 already made, costing roughly 1.5 dB. Each doubling quarters the
   * added error for about one extra bit per non-zero coefficient: 2 gives
   * ~0.5 dB, 4 gives ~0.13 dB.
   */
  oversample: number;
}

export const DEFAULT_QUANTISER_OPTIONS: QuantiserOptions = { oversample: 2 };

/**
 * Per-position reconstruction gain for one scaling list, precomputed for every
 * QP. Small enough to build eagerly: 52 QPs by 64 positions.
 */
export class Quantiser8x8 {
  /** Indexed by qp * 64 + position, in raster order. */
  private readonly gain: Float64Array;
  readonly weightScale: readonly number[];

  constructor(weightScale: readonly number[]) {
    if (weightScale.length !== 64) {
      throw new Error(
        `scaling list must have 64 entries, got ${weightScale.length}`,
      );
    }
    this.weightScale = weightScale;
    this.gain = new Float64Array(52 * 64);
    for (let qp = 0; qp < 52; qp++) {
      const plane = BASE_GAIN_8X8[qp % 6]!;
      const shift = 2 ** Math.floor(qp / 6);
      for (let pos = 0; pos < 64; pos++) {
        this.gain[qp * 64 + pos] =
          plane[pos >> 3]![pos & 7]! * weightScale[pos]! * shift;
      }
    }
  }

  /** Orthonormal-DCT value reconstructed per unit of coefficient level. */
  gainAt(qp: number, pos: number): number {
    return this.gain[qp * 64 + pos]!;
  }

  /** The level whose reconstruction lands closest to `target`. */
  levelFor(target: number, qp: number, pos: number): number {
    return Math.round(target / this.gain[qp * 64 + pos]!);
  }

  /**
   * Pick the QP whose step is `oversample` times finer than the MPEG-2 step.
   *
   * MPEG-2's step at position p is `weightScale[p] * quantiserScale / 16`, and
   * the H.264 gain is proportional to the same weightScale, so the ratio is
   * very nearly position-independent and one QP serves the whole block. What
   * position-dependence remains is absorbed by levelFor(), which divides by the
   * gain for the actual position.
   */
  chooseQp(quantiserScale: number, oversample: number): number {
    const targetRatio = quantiserScale / 16 / oversample;
    let bestQp = 0;
    let bestErr = Infinity;
    for (let qp = 0; qp < 52; qp++) {
      // Compare using the mean over positions, since the spread is only ~2.7%.
      let mean = 0;
      for (let pos = 0; pos < 64; pos++) {
        mean += this.gain[qp * 64 + pos]! / this.weightScale[pos]!;
      }
      mean /= 64;
      const err = Math.abs(Math.log(mean / targetRatio));
      if (err < bestErr) {
        bestErr = err;
        bestQp = qp;
      }
    }
    return bestQp;
  }
}

/**
 * The DC of an all-128 block in orthonormal-DCT terms. Intra macroblocks are
 * coded as a residual against the grey reference frame, so this comes off their
 * DC coefficient and nothing else changes: a constant offset touches no AC term.
 */
export const GRAY_DC = 8 * 128;

/**
 * MPEG-2 dequantisation of an intra block, clause 7.4.1 and 7.4.2.1, minus the
 * grey prediction. The result is what the H.264 residual has to reconstruct.
 *
 * DC uses intra_dc_mult rather than the quantiser matrix, so it is handled
 * separately from the AC coefficients.
 */
export function intraTargets(
  levels: Int16Array,
  weightScale: readonly number[],
  quantiserScale: number,
  intraDcPrecision: number,
  out: Float64Array,
): void {
  const intraDcMult = 8 >> intraDcPrecision;
  out[0] = intraDcMult * levels[0]! - GRAY_DC;
  for (let pos = 1; pos < 64; pos++) {
    const level = levels[pos]!;
    // The division truncates toward zero, matching what a decoder computes.
    out[pos] =
      level === 0
        ? 0
        : Math.trunc((2 * level * weightScale[pos]! * quantiserScale) / 32);
  }
}

/**
 * MPEG-2 dequantisation of a non-intra block, clause 7.4.2.1. The prediction is
 * the source's motion-compensated block, which the H.264 side reproduces, so
 * nothing is subtracted here -- the residual carries across as it stands.
 */
export function interTargets(
  levels: Int16Array,
  weightScale: readonly number[],
  quantiserScale: number,
  out: Float64Array,
): void {
  for (let pos = 0; pos < 64; pos++) {
    const level = levels[pos]!;
    if (level === 0) {
      out[pos] = 0;
      continue;
    }
    const sign = level < 0 ? -1 : 1;
    out[pos] = Math.trunc(
      ((2 * level + sign) * weightScale[pos]! * quantiserScale) / 32,
    );
  }
}

/** Orthonormal 8-point DCT basis, indexed by sample then frequency. */
const DCT8_BASIS = (() => {
  const basis = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let k = 0; k < 8; k++) {
      const scale = k === 0 ? 1 / Math.sqrt(8) : 0.5;
      basis[y * 8 + k] = scale * Math.cos(((2 * y + 1) * k * Math.PI) / 16);
    }
  }
  return basis;
})();
const fieldFrameSamples = new Float64Array(16);

/**
 * Convert the two vertically interleaved MPEG-2 field-DCT blocks on one side
 * of a macroblock into the two spatially stacked frame-DCT blocks expected by
 * an H.264 frame macroblock.
 *
 * This is a change of transform basis, not a pixel-domain decode: horizontal
 * frequencies are unchanged and each column of eight vertical coefficients is
 * multiplied by the orthonormal DCT basis. `firstField`
 * supplies lines 0,2,...,14 and `secondField` lines 1,3,...,15.
 */
export function fieldDctToFrameTargets(
  firstField: Float64Array,
  secondField: Float64Array,
  upper: Float64Array,
  lower: Float64Array,
): void {
  const samples = fieldFrameSamples;

  for (
    let horizontalFrequency = 0;
    horizontalFrequency < 8;
    horizontalFrequency++
  ) {
    for (let y = 0; y < 8; y++) {
      let even = 0;
      let odd = 0;
      for (
        let verticalFrequency = 0;
        verticalFrequency < 8;
        verticalFrequency++
      ) {
        const basis = DCT8_BASIS[y * 8 + verticalFrequency]!;
        const pos = verticalFrequency * 8 + horizontalFrequency;
        even += basis * firstField[pos]!;
        odd += basis * secondField[pos]!;
      }
      samples[y * 2] = even;
      samples[y * 2 + 1] = odd;
    }

    for (let half = 0; half < 2; half++) {
      const out = half === 0 ? upper : lower;
      for (
        let verticalFrequency = 0;
        verticalFrequency < 8;
        verticalFrequency++
      ) {
        let coefficient = 0;
        for (let y = 0; y < 8; y++) {
          coefficient +=
            samples[half * 8 + y]! * DCT8_BASIS[y * 8 + verticalFrequency]!;
        }
        out[verticalFrequency * 8 + horizontalFrequency] = coefficient;
      }
    }
  }
}

/**
 * Inverse of fieldDctToFrameTargets. This is needed when an MBAFF macroblock
 * pair must be field-coded because either source macroblock uses field motion:
 * frame-DCT neighbours in the same pair then have to be expressed in the field
 * transform basis as well.
 */
export function frameDctToFieldTargets(
  upper: Float64Array,
  lower: Float64Array,
  firstField: Float64Array,
  secondField: Float64Array,
): void {
  const samples = fieldFrameSamples;

  for (
    let horizontalFrequency = 0;
    horizontalFrequency < 8;
    horizontalFrequency++
  ) {
    for (let half = 0; half < 2; half++) {
      const input = half === 0 ? upper : lower;
      for (let y = 0; y < 8; y++) {
        let sample = 0;
        for (
          let verticalFrequency = 0;
          verticalFrequency < 8;
          verticalFrequency++
        ) {
          sample +=
            DCT8_BASIS[y * 8 + verticalFrequency]! *
            input[verticalFrequency * 8 + horizontalFrequency]!;
        }
        samples[half * 8 + y] = sample;
      }
    }

    for (let field = 0; field < 2; field++) {
      const out = field === 0 ? firstField : secondField;
      for (
        let verticalFrequency = 0;
        verticalFrequency < 8;
        verticalFrequency++
      ) {
        let coefficient = 0;
        for (let y = 0; y < 8; y++) {
          coefficient +=
            samples[y * 2 + field]! * DCT8_BASIS[y * 8 + verticalFrequency]!;
        }
        out[verticalFrequency * 8 + horizontalFrequency] = coefficient;
      }
    }
  }
}
