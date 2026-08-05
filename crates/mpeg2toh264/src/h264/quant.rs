//! Mapping MPEG-2 coefficients onto H.264 coefficient levels.
//!
//! Both formats reconstruct from orthonormal-DCT coefficients, which is what
//! makes the mapping possible at all: MPEG-2's dequantised value and the value
//! an H.264 decoder reconstructs live in the same space, so the level is just
//! the target divided by what one unit of level is worth.

use std::sync::LazyLock;

use crate::h264::cos_table::COS_PI_OVER_16;
use crate::h264::quant_tables::BASE_GAIN_8X8;
use crate::round_half_up_i32;

/// How much finer than the source the H.264 quantiser is made.
#[derive(Clone, Copy, Debug)]
pub struct QuantiserOptions {
    /// Ratio between the MPEG-2 step and the H.264 step. At 1 the levels
    /// transfer almost unchanged, but rounding them adds an error comparable to
    /// the one MPEG-2 already made, costing roughly 1.5 dB. Each doubling
    /// quarters the added error for about one extra bit per non-zero
    /// coefficient: 2 gives ~0.5 dB, 4 gives ~0.13 dB.
    pub oversample: f64,
}

pub const DEFAULT_OVERSAMPLE: f64 = 2.0;

impl Default for QuantiserOptions {
    fn default() -> Self {
        Self {
            oversample: DEFAULT_OVERSAMPLE,
        }
    }
}

/// Per-position reconstruction gain for one scaling list, precomputed for every
/// QP. Small enough to build eagerly: 52 QPs by 64 positions.
pub struct Quantiser8x8 {
    /// Indexed by `qp * 64 + position`, in raster order.
    gain: Vec<f64>,
    weight_scale: [i32; 64],
}

impl Quantiser8x8 {
    pub fn new(weight_scale: &[i32; 64]) -> Self {
        let mut gain = vec![0.0; 52 * 64];
        for qp in 0..52usize {
            let plane = &BASE_GAIN_8X8[qp % 6];
            let shift = 2f64.powi(qp as i32 / 6);
            for pos in 0..64 {
                gain[qp * 64 + pos] = plane[pos >> 3][pos & 7] * weight_scale[pos] as f64 * shift;
            }
        }
        Self {
            gain,
            weight_scale: *weight_scale,
        }
    }

    /// Orthonormal-DCT value reconstructed per unit of coefficient level.
    #[inline]
    pub fn gain_at(&self, qp: i32, pos: usize) -> f64 {
        self.gain[qp as usize * 64 + pos]
    }

    /// The level whose reconstruction lands closest to `target`.
    #[inline]
    pub fn level_for(&self, target: f64, qp: i32, pos: usize) -> i32 {
        round_half_up_i32(target / self.gain[qp as usize * 64 + pos])
    }

    /// [`Self::level_for`] across a whole block, with the QP's gains found once
    /// rather than per position. The division itself is not worth avoiding:
    /// multiplying by a precomputed reciprocal instead is under 2% faster and
    /// no longer reproduces the same levels.
    #[inline]
    pub fn levels_for(&self, targets: &[f64; 64], qp: i32, out: &mut [i32; 64]) {
        let base = qp as usize * 64;
        let gains: &[f64; 64] = self.gain[base..base + 64].try_into().expect("64 gains");
        for pos in 0..64 {
            out[pos] = round_half_up_i32(targets[pos] / gains[pos]);
        }
    }

    /// Pick the QP whose step is `oversample` times finer than the MPEG-2 step.
    ///
    /// MPEG-2's step at position p is `weight_scale[p] * quantiser_scale / 16`,
    /// and the H.264 gain is proportional to the same weight_scale, so the ratio
    /// is very nearly position-independent and one QP serves the whole block.
    /// What position-dependence remains is absorbed by [`Self::level_for`],
    /// which divides by the gain for the actual position.
    pub fn choose_qp(&self, quantiser_scale: i32, oversample: f64) -> i32 {
        let target_ratio = quantiser_scale as f64 / 16.0 / oversample;
        let mut best_qp = 0;
        let mut best_err = f64::INFINITY;
        for qp in 0..52usize {
            // Compare using the mean over positions, since the spread is only ~2.7%.
            let mut mean = 0.0;
            for pos in 0..64 {
                mean += self.gain[qp * 64 + pos] / self.weight_scale[pos] as f64;
            }
            mean /= 64.0;
            let err = (mean / target_ratio).ln().abs();
            if err < best_err {
                best_err = err;
                best_qp = qp as i32;
            }
        }
        best_qp
    }
}

/// The constant an intra macroblock is predicted from; see
/// [`crate::h264::slice`].
///
/// It is 127 rather than the more obvious 128 because it is carried in
/// `luma_offset_l0`, whose range stops at 127. The exact value does not matter:
/// the residual carries whatever the difference turns out to be.
pub const FLAT_PREDICTION: i32 = 127;

/// The DC of an all-[`FLAT_PREDICTION`] block in orthonormal-DCT terms. Intra
/// macroblocks are coded as a residual against that flat prediction, so this
/// comes off their DC coefficient and nothing else changes: a constant offset
/// touches no AC term.
pub const FLAT_PREDICTION_DC: f64 = 8.0 * FLAT_PREDICTION as f64;

/// MPEG-2 dequantisation of an intra block, clause 7.4.1 and 7.4.2.1, minus the
/// flat prediction. The result is what the H.264 residual has to reconstruct.
///
/// DC uses `intra_dc_mult` rather than the quantiser matrix, so it is handled
/// separately from the AC coefficients.
pub fn intra_targets(
    levels: &[i16; 64],
    weight_scale: &[i32; 64],
    quantiser_scale: i32,
    intra_dc_precision: u32,
    out: &mut [f64; 64],
) {
    let intra_dc_mult = (8 >> intra_dc_precision) as i32;
    out[0] = (intra_dc_mult * levels[0] as i32) as f64 - FLAT_PREDICTION_DC;
    // A level of zero gives zero through the same arithmetic, so there is no
    // branch to keep the compiler from taking these four at a time. The
    // products stay well inside 32 bits: the widest is 2 * 2048 * 255 * 112.
    for pos in 1..64 {
        let level = levels[pos] as i32;
        // The division truncates toward zero, matching what a decoder computes.
        out[pos] = ((2 * level * weight_scale[pos] * quantiser_scale) / 32) as f64;
    }
}

/// MPEG-2 dequantisation of a non-intra block, clause 7.4.2.1. The prediction is
/// the source's motion-compensated block, which the H.264 side reproduces, so
/// nothing is subtracted here -- the residual carries across as it stands.
pub fn inter_targets(
    levels: &[i16; 64],
    weight_scale: &[i32; 64],
    quantiser_scale: i32,
    out: &mut [f64; 64],
) {
    // signum is zero at zero, which is exactly what a zero level has to
    // dequantise to, so this needs no branch and can go four at a time.
    for pos in 0..64 {
        let level = levels[pos] as i32;
        out[pos] =
            (((2 * level + level.signum()) * weight_scale[pos] * quantiser_scale) / 32) as f64;
    }
}

/// Orthonormal 8-point DCT basis, indexed by sample then frequency.
static DCT8_BASIS: LazyLock<[f64; 64]> = LazyLock::new(|| {
    let mut basis = [0.0; 64];
    for y in 0..8 {
        for k in 0..8 {
            let scale = if k == 0 { 1.0 / 8f64.sqrt() } else { 0.5 };
            basis[y * 8 + k] = scale * COS_PI_OVER_16[(2 * y + 1) * k];
        }
    }
    basis
});

/// Convert the two vertically interleaved MPEG-2 field-DCT blocks on one side
/// of a macroblock into the two spatially stacked frame-DCT blocks expected by
/// an H.264 frame macroblock.
///
/// This is a change of transform basis, not a pixel-domain decode: horizontal
/// frequencies are unchanged and each column of eight vertical coefficients is
/// multiplied by the orthonormal DCT basis. `first_field` supplies lines
/// 0,2,...,14 and `second_field` lines 1,3,...,15.
pub fn field_dct_to_frame_targets(
    first_field: &[f64; 64],
    second_field: &[f64; 64],
    upper: &mut [f64; 64],
    lower: &mut [f64; 64],
) {
    let dct = &*DCT8_BASIS;
    let mut samples = [0.0f64; 16];

    for horizontal_frequency in 0..8 {
        for y in 0..8 {
            let mut even = 0.0;
            let mut odd = 0.0;
            for vertical_frequency in 0..8 {
                let basis = dct[y * 8 + vertical_frequency];
                let pos = vertical_frequency * 8 + horizontal_frequency;
                even += basis * first_field[pos];
                odd += basis * second_field[pos];
            }
            samples[y * 2] = even;
            samples[y * 2 + 1] = odd;
        }

        for half in 0..2 {
            let out: &mut [f64; 64] = if half == 0 { upper } else { lower };
            for vertical_frequency in 0..8 {
                let mut coefficient = 0.0;
                for y in 0..8 {
                    coefficient += samples[half * 8 + y] * dct[y * 8 + vertical_frequency];
                }
                out[vertical_frequency * 8 + horizontal_frequency] = coefficient;
            }
        }
    }
}

/// Inverse of [`field_dct_to_frame_targets`]. This is needed when an MBAFF
/// macroblock pair must be field-coded because either source macroblock uses
/// field motion: frame-DCT neighbours in the same pair then have to be expressed
/// in the field transform basis as well.
pub fn frame_dct_to_field_targets(
    upper: &[f64; 64],
    lower: &[f64; 64],
    first_field: &mut [f64; 64],
    second_field: &mut [f64; 64],
) {
    let dct = &*DCT8_BASIS;
    let mut samples = [0.0f64; 16];

    for horizontal_frequency in 0..8 {
        for half in 0..2 {
            let input: &[f64; 64] = if half == 0 { upper } else { lower };
            for y in 0..8 {
                let mut sample = 0.0;
                for vertical_frequency in 0..8 {
                    sample += dct[y * 8 + vertical_frequency]
                        * input[vertical_frequency * 8 + horizontal_frequency];
                }
                samples[half * 8 + y] = sample;
            }
        }

        for field in 0..2 {
            let out: &mut [f64; 64] = if field == 0 {
                first_field
            } else {
                second_field
            };
            for vertical_frequency in 0..8 {
                let mut coefficient = 0.0;
                for y in 0..8 {
                    coefficient += samples[y * 2 + field] * dct[y * 8 + vertical_frequency];
                }
                out[vertical_frequency * 8 + horizontal_frequency] = coefficient;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mpeg2::constants::{DEFAULT_INTRA_QUANT, DEFAULT_NON_INTRA_QUANT};

    #[test]
    fn doubling_the_mpeg2_step_is_exactly_six_h264_qp() {
        // The linear quantiser_scale table is what makes the mapping clean.
        let quant = Quantiser8x8::new(&DEFAULT_NON_INTRA_QUANT);
        let base = quant.choose_qp(16, 1.0);
        for (scale, steps) in [(32, 1), (64, 2), (8, -1), (4, -2)] {
            assert_eq!(
                quant.choose_qp(scale, 1.0),
                base + 6 * steps,
                "quantiser_scale {scale}"
            );
        }
    }

    #[test]
    fn oversampling_lowers_the_qp_by_six_per_doubling() {
        let quant = Quantiser8x8::new(&DEFAULT_NON_INTRA_QUANT);
        let at_one = quant.choose_qp(16, 1.0);
        assert_eq!(quant.choose_qp(16, 2.0), at_one - 6);
        assert_eq!(quant.choose_qp(16, 4.0), at_one - 12);
    }

    #[test]
    fn a_level_reconstructs_to_within_half_a_step_of_its_target() {
        let quant = Quantiser8x8::new(&DEFAULT_INTRA_QUANT);
        for qp in [0, 13, 26, 51] {
            for pos in [0usize, 7, 27, 63] {
                let gain = quant.gain_at(qp, pos);
                for target in [0.0, gain * 3.2, -gain * 7.8, gain * 100.0] {
                    let level = quant.level_for(target, qp, pos);
                    let error = (level as f64 * gain - target).abs();
                    assert!(error <= gain / 2.0 + 1e-9, "qp {qp} pos {pos}");
                }
            }
        }
    }

    #[test]
    fn intra_dequantisation_removes_the_flat_prediction_from_the_dc_alone() {
        let mut levels = [0i16; 64];
        levels[0] = 200;
        levels[1] = 4;
        let mut out = [0.0f64; 64];
        intra_targets(&levels, &DEFAULT_INTRA_QUANT, 8, 0, &mut out);
        assert_eq!(out[0], 8.0 * 200.0 - FLAT_PREDICTION_DC);
        // AC position 1 has weight 16, so 2 * 4 * 16 * 8 / 32 = 32, and nothing
        // is subtracted: a constant prediction touches no AC term.
        assert_eq!(out[1], 32.0);
        assert_eq!(out[2], 0.0, "an uncoded position stays zero");
    }

    #[test]
    fn inter_dequantisation_adds_the_sign_correction_and_truncates_toward_zero() {
        let mut levels = [0i16; 64];
        levels[0] = 3;
        levels[1] = -3;
        let mut out = [0.0f64; 64];
        inter_targets(&levels, &DEFAULT_NON_INTRA_QUANT, 1, &mut out);
        // (2 * 3 + 1) * 16 * 1 / 32 = 3.5, truncated to 3.
        assert_eq!(out[0], 3.0);
        // (2 * -3 - 1) * 16 * 1 / 32 = -3.5, truncated toward zero to -3.
        assert_eq!(out[1], -3.0);
    }

    #[test]
    fn the_field_and_frame_dct_bases_are_inverses_of_each_other() {
        let first: [f64; 64] = std::array::from_fn(|i| ((i * 37) % 61) as f64 - 30.0);
        let second: [f64; 64] = std::array::from_fn(|i| ((i * 53) % 47) as f64 - 23.0);
        let mut upper = [0.0f64; 64];
        let mut lower = [0.0f64; 64];
        field_dct_to_frame_targets(&first, &second, &mut upper, &mut lower);

        let mut back_first = [0.0f64; 64];
        let mut back_second = [0.0f64; 64];
        frame_dct_to_field_targets(&upper, &lower, &mut back_first, &mut back_second);

        for i in 0..64 {
            assert!(
                (back_first[i] - first[i]).abs() < 1e-9,
                "first field at {i}"
            );
            assert!(
                (back_second[i] - second[i]).abs() < 1e-9,
                "second field at {i}"
            );
        }
    }

    #[test]
    fn the_basis_change_leaves_a_constant_block_constant() {
        // A block with only a DC term is flat in the sample domain, so
        // interleaving its lines cannot change either half.
        let mut first = [0.0f64; 64];
        let mut second = [0.0f64; 64];
        first[0] = 100.0;
        second[0] = 100.0;
        let mut upper = [0.0f64; 64];
        let mut lower = [0.0f64; 64];
        field_dct_to_frame_targets(&first, &second, &mut upper, &mut lower);
        assert!((upper[0] - 100.0).abs() < 1e-9);
        assert!((lower[0] - 100.0).abs() < 1e-9);
        for i in 1..64 {
            assert!(upper[i].abs() < 1e-9, "upper AC at {i}");
            assert!(lower[i].abs() < 1e-9, "lower AC at {i}");
        }
    }
}
