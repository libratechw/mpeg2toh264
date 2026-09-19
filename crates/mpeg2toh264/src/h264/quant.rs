//! Mapping MPEG-2 coefficients onto H.264 coefficient levels.
//!
//! Both formats reconstruct from orthonormal-DCT coefficients, which is what
//! makes the mapping possible at all: MPEG-2's dequantised value and the value
//! an H.264 decoder reconstructs live in the same space, so the level is just
//! the target divided by what one unit of level is worth.

use std::sync::LazyLock;

use crate::h264::cos_table::COS_PI_OVER_16;
use crate::h264::quant_tables::BASE_GAIN_8X8;
use crate::h264::reconstruct::InverseScale8x8;
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
    gain: Vec<f32>,
    /// Reciprocal of `gain`, used by the whole-block hot path so WASM can
    /// multiply four positions at a time instead of issuing scalar divides.
    /// Rounding can differ at an exact half-step; the decoded difference is
    /// negligible (over 80 dB PSNR on the HD benchmark) and buys throughput.
    reciprocal_gain: Vec<f32>,
    /// Mean of `gain / weight_scale` over the positions, per QP, kept in double
    /// precision: [`Self::choose_qp`] compares QPs whose steps are 12% apart and
    /// runs once per quantiser scale, so it has no reason to narrow.
    mean_ratio: [f64; 52],
    /// The same scaling list read the other way, for the one picture that has
    /// to know what a decoder will make of the levels it just wrote.
    inverse: InverseScale8x8,
}

impl Quantiser8x8 {
    pub fn new(weight_scale: &[i32; 64]) -> Self {
        let mut gain = vec![0.0f32; 52 * 64];
        let mut reciprocal_gain = vec![0.0f32; 52 * 64];
        let mut mean_ratio = [0.0f64; 52];
        for qp in 0..52usize {
            let plane = &BASE_GAIN_8X8[qp % 6];
            let shift = 2f64.powi(qp as i32 / 6);
            let mut mean = 0.0;
            for pos in 0..64 {
                let g = plane[pos >> 3][pos & 7] * weight_scale[pos] as f64 * shift;
                let index = qp * 64 + pos;
                gain[index] = g as f32;
                reciprocal_gain[index] = 1.0 / gain[index];
                mean += g / weight_scale[pos] as f64;
            }
            mean_ratio[qp] = mean / 64.0;
        }
        Self {
            gain,
            reciprocal_gain,
            mean_ratio,
            inverse: InverseScale8x8::new(weight_scale),
        }
    }

    pub fn inverse(&self) -> &InverseScale8x8 {
        &self.inverse
    }

    /// Orthonormal-DCT value reconstructed per unit of coefficient level.
    #[inline]
    pub fn gain_at(&self, qp: i32, pos: usize) -> f32 {
        self.gain[qp as usize * 64 + pos]
    }

    /// The level whose reconstruction lands closest to `target`.
    #[inline]
    pub fn level_for(&self, target: f32, qp: i32, pos: usize) -> i32 {
        round_half_up_i32(target / self.gain[qp as usize * 64 + pos])
    }

    /// Quantise a whole block directly into the scan order the residual coder
    /// consumes. This avoids first writing raster levels and then copying all
    /// 64 of them through a separate scan pass.
    #[inline]
    pub fn scanned_levels_for(
        &self,
        targets: &[f32; 64],
        qp: i32,
        scan: &[usize; 64],
        out: &mut [i32; 64],
    ) -> bool {
        let base = qp as usize * 64;
        let reciprocal_gains: &[f32; 64] = self.reciprocal_gain[base..base + 64]
            .try_into()
            .expect("64 reciprocal gains");
        let mut any = false;
        for k in 0..64 {
            let pos = scan[k];
            let level = round_half_up_i32(targets[pos] * reciprocal_gains[pos]);
            out[k] = level;
            any |= level != 0;
        }
        any
    }

    /// [`Self::scanned_levels_for`] over the positions `mask` names alone,
    /// which are the only ones that can hold anything: a zero target is a
    /// zero level. Returns which positions of `out`, in scan order, were
    /// given a non-zero level; nothing else in `out` is written, and the
    /// residual writer reads nothing else.
    #[inline]
    pub fn scanned_levels_masked(
        &self,
        targets: &[f32; 64],
        mask: u64,
        qp: i32,
        inverse_scan: &[u8; 64],
        out: &mut [i32; 64],
    ) -> u64 {
        let base = qp as usize * 64;
        let reciprocal_gains: &[f32; 64] = self.reciprocal_gain[base..base + 64]
            .try_into()
            .expect("64 reciprocal gains");
        let mut rest = mask;
        let mut scanned = 0u64;
        while rest != 0 {
            let pos = rest.trailing_zeros() as usize & 63;
            rest &= rest - 1;
            let level = round_half_up_i32(targets[pos] * reciprocal_gains[pos]);
            let k = inverse_scan[pos] as usize & 63;
            out[k] = level;
            scanned |= u64::from(level != 0) << k;
        }
        scanned
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
            let err = (self.mean_ratio[qp] / target_ratio).ln().abs();
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
pub const FLAT_PREDICTION_DC: f32 = 8.0 * FLAT_PREDICTION as f32;

/// Clause 7.4.4's adjustment of F'[7][7]. Returns that position as a mask
/// where it was touched, since it may have been zero before.
#[inline]
fn finish_mismatch_control(out: &mut [f32; 64], parity: i32) -> u64 {
    // Since Rust uses two's-complement integers, XOR with one is exactly the
    // clause 7.4.4 adjustment of F'[7][7]: subtract one when odd and add one
    // when even. Saturation has already happened while filling the block.
    if parity & 1 == 0 {
        out[63] = ((out[63] as i32) ^ 1) as f32;
        1 << 63
    } else {
        0
    }
}

/// Bit `p` set where `levels[p]` is non-zero, which is what the decoder
/// records as it goes and a block made some other way has to work out.
pub fn level_mask(levels: &[i16; 64]) -> u64 {
    let mut mask = 0u64;
    for (pos, &level) in levels.iter().enumerate() {
        mask |= u64::from(level != 0) << pos;
    }
    mask
}

/// MPEG-2 dequantisation of an intra block, clauses 7.4.1 and 7.4.2.3, minus the
/// flat prediction. The result is what the H.264 residual has to reconstruct.
///
/// DC uses `intra_dc_mult` rather than the quantiser matrix, so it is handled
/// separately from the AC coefficients.
///
/// `mask` names the positions of `levels` that are non-zero; the others
/// dequantise to zero and are not visited. The whole of `out` is written, and
/// the positions of it that may be non-zero come back as a mask of their own:
/// mismatch control can put a one where the source had nothing.
pub fn intra_targets(
    levels: &[i16; 64],
    mask: u64,
    weight_scale: &[i32; 64],
    quantiser_scale: i32,
    intra_dc_precision: u32,
    out: &mut [f32; 64],
) -> u64 {
    out.fill(0.0);
    let intra_dc_mult: i32 = 8 >> intra_dc_precision;
    let dc = (intra_dc_mult * levels[0] as i32).clamp(-2048, 2047);
    out[0] = dc as f32;
    let mut parity = dc;
    // The products stay well inside 32 bits: the widest is
    // 2 * 2048 * 255 * 112.
    let mut rest = mask & !1;
    while rest != 0 {
        let pos = rest.trailing_zeros() as usize & 63;
        rest &= rest - 1;
        let level = levels[pos] as i32;
        // The division truncates toward zero, matching what a decoder computes.
        let coefficient =
            ((2 * level * weight_scale[pos] * quantiser_scale) / 32).clamp(-2048, 2047);
        out[pos] = coefficient as f32;
        parity ^= coefficient;
    }
    let nonzero = mask | 1 | finish_mismatch_control(out, parity);
    // Mismatch control applies to the reconstructed MPEG-2 block, before the
    // H.264-only flat prediction is removed from its DC coefficient.
    out[0] -= FLAT_PREDICTION_DC;
    nonzero
}

/// MPEG-2 dequantisation of a non-intra block, clause 7.4.2.3. The prediction is
/// the source's motion-compensated block, which the H.264 side reproduces, so
/// nothing is subtracted here -- the residual carries across as it stands.
/// `mask` and the result are as for [`intra_targets`].
pub fn inter_targets(
    levels: &[i16; 64],
    mask: u64,
    weight_scale: &[i32; 64],
    quantiser_scale: i32,
    out: &mut [f32; 64],
) -> u64 {
    out.fill(0.0);
    // signum is zero at zero, exactly what a zero level has to dequantise to.
    let mut parity = 0i32;
    let mut rest = mask;
    while rest != 0 {
        let pos = rest.trailing_zeros() as usize & 63;
        rest &= rest - 1;
        let level = levels[pos] as i32;
        let coefficient = (((2 * level + level.signum()) * weight_scale[pos] * quantiser_scale)
            / 32)
            .clamp(-2048, 2047);
        out[pos] = coefficient as f32;
        parity ^= coefficient;
    }
    mask | finish_mismatch_control(out, parity)
}

/// Every position in a column that `mask` occupies anywhere. The basis change
/// between field and frame DCT mixes the rows of a column and touches no
/// other column, so this is where its output can be non-zero.
pub fn column_mask(mask: u64) -> u64 {
    let mut rows = mask;
    rows |= rows >> 32;
    rows |= rows >> 16;
    rows |= rows >> 8;
    (rows & 0xff) * 0x0101_0101_0101_0101
}

/// Orthonormal 8-point DCT basis, indexed by sample then frequency.
static DCT8_BASIS: LazyLock<[f32; 64]> = LazyLock::new(|| {
    let mut basis = [0.0; 64];
    for y in 0..8 {
        for k in 0..8 {
            let scale: f64 = if k == 0 { 1.0 / 8f64.sqrt() } else { 0.5 };
            basis[y * 8 + k] = (scale * COS_PI_OVER_16[(2 * y + 1) * k]) as f32;
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
#[cfg(not(target_arch = "wasm32"))]
pub fn field_dct_to_frame_targets(
    first_field: &[f32; 64],
    second_field: &[f32; 64],
    upper: &mut [f32; 64],
    lower: &mut [f32; 64],
) {
    let dct = &*DCT8_BASIS;
    let mut samples = [0.0f32; 16];

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
            let out: &mut [f32; 64] = if half == 0 { upper } else { lower };
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

/// Four consecutive horizontal frequencies of one coefficient row as a vector,
/// and back. Rows are contiguous in raster order, so the basis change can work
/// on four columns at once without gathering anything.
#[cfg(target_arch = "wasm32")]
mod lanes {
    use core::arch::wasm32::{f32x4, f32x4_extract_lane, v128};

    #[inline]
    pub fn load4(values: &[f32; 64], pos: usize) -> v128 {
        f32x4(
            values[pos],
            values[pos + 1],
            values[pos + 2],
            values[pos + 3],
        )
    }

    #[inline]
    pub fn store4(values: &mut [f32; 64], pos: usize, lanes: v128) {
        values[pos] = f32x4_extract_lane::<0>(lanes);
        values[pos + 1] = f32x4_extract_lane::<1>(lanes);
        values[pos + 2] = f32x4_extract_lane::<2>(lanes);
        values[pos + 3] = f32x4_extract_lane::<3>(lanes);
    }
}

/// [`field_dct_to_frame_targets`] four horizontal frequencies at a time. Each
/// lane adds the same products in the same order as the scalar version, so the
/// two agree to the bit.
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
pub fn field_dct_to_frame_targets(
    first_field: &[f32; 64],
    second_field: &[f32; 64],
    upper: &mut [f32; 64],
    lower: &mut [f32; 64],
) {
    use core::arch::wasm32::{f32x4_add, f32x4_mul, f32x4_splat};
    use lanes::{load4, store4};

    let dct = &*DCT8_BASIS;
    // Lines of each field in raster order, before they are interleaved.
    let mut first_samples = [0.0f32; 64];
    let mut second_samples = [0.0f32; 64];

    for horizontal_frequency in (0..8).step_by(4) {
        for y in 0..8 {
            let mut even = f32x4_splat(0.0);
            let mut odd = f32x4_splat(0.0);
            for vertical_frequency in 0..8 {
                let basis = f32x4_splat(dct[y * 8 + vertical_frequency]);
                let pos = vertical_frequency * 8 + horizontal_frequency;
                even = f32x4_add(even, f32x4_mul(basis, load4(first_field, pos)));
                odd = f32x4_add(odd, f32x4_mul(basis, load4(second_field, pos)));
            }
            store4(&mut first_samples, y * 8 + horizontal_frequency, even);
            store4(&mut second_samples, y * 8 + horizontal_frequency, odd);
        }

        for half in 0..2 {
            let out = if half == 0 { &mut *upper } else { &mut *lower };
            for vertical_frequency in 0..8 {
                let mut coefficient = f32x4_splat(0.0);
                for y in 0..8 {
                    // Frame line `half * 8 + y` is line `(half * 8 + y) / 2` of
                    // the field its parity names.
                    let line = half * 8 + y;
                    let samples = if line & 1 == 0 {
                        &first_samples
                    } else {
                        &second_samples
                    };
                    coefficient = f32x4_add(
                        coefficient,
                        f32x4_mul(
                            f32x4_splat(dct[y * 8 + vertical_frequency]),
                            load4(samples, (line >> 1) * 8 + horizontal_frequency),
                        ),
                    );
                }
                store4(
                    out,
                    vertical_frequency * 8 + horizontal_frequency,
                    coefficient,
                );
            }
        }
    }
}

/// Inverse of [`field_dct_to_frame_targets`]. This is needed when an MBAFF
/// macroblock pair must be field-coded because either source macroblock uses
/// field motion: frame-DCT neighbours in the same pair then have to be expressed
/// in the field transform basis as well.
#[cfg(not(target_arch = "wasm32"))]
pub fn frame_dct_to_field_targets(
    upper: &[f32; 64],
    lower: &[f32; 64],
    first_field: &mut [f32; 64],
    second_field: &mut [f32; 64],
) {
    let dct = &*DCT8_BASIS;
    let mut samples = [0.0f32; 16];

    for horizontal_frequency in 0..8 {
        for half in 0..2 {
            let input: &[f32; 64] = if half == 0 { upper } else { lower };
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
            let out: &mut [f32; 64] = if field == 0 {
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

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
pub fn frame_dct_to_field_targets(
    upper: &[f32; 64],
    lower: &[f32; 64],
    first_field: &mut [f32; 64],
    second_field: &mut [f32; 64],
) {
    use core::arch::wasm32::{f32x4_add, f32x4_mul, f32x4_splat};
    use lanes::{load4, store4};

    let dct = &*DCT8_BASIS;
    let mut upper_samples = [0.0f32; 64];
    let mut lower_samples = [0.0f32; 64];

    // Transform four horizontal frequencies together. Each MPEG-2 coefficient
    // row is contiguous, so no lane gathers or shuffles are needed.
    for horizontal_frequency in (0..8).step_by(4) {
        for y in 0..8 {
            let mut upper_sum = f32x4_splat(0.0);
            let mut lower_sum = f32x4_splat(0.0);
            for vertical_frequency in 0..8 {
                let basis = f32x4_splat(dct[y * 8 + vertical_frequency]);
                let pos = vertical_frequency * 8 + horizontal_frequency;
                upper_sum = f32x4_add(upper_sum, f32x4_mul(basis, load4(upper, pos)));
                lower_sum = f32x4_add(lower_sum, f32x4_mul(basis, load4(lower, pos)));
            }
            store4(&mut upper_samples, y * 8 + horizontal_frequency, upper_sum);
            store4(&mut lower_samples, y * 8 + horizontal_frequency, lower_sum);
        }

        for field in 0..2 {
            let out = if field == 0 {
                &mut *first_field
            } else {
                &mut *second_field
            };
            for vertical_frequency in 0..8 {
                let mut coefficient = f32x4_splat(0.0);
                for y in 0..8 {
                    let spatial_y = y * 2 + field;
                    let samples = if spatial_y < 8 {
                        &upper_samples
                    } else {
                        &lower_samples
                    };
                    let source_y = spatial_y & 7;
                    coefficient = f32x4_add(
                        coefficient,
                        f32x4_mul(
                            f32x4_splat(dct[y * 8 + vertical_frequency]),
                            load4(samples, source_y * 8 + horizontal_frequency),
                        ),
                    );
                }
                store4(
                    out,
                    vertical_frequency * 8 + horizontal_frequency,
                    coefficient,
                );
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
                    let error = (level as f32 * gain - target).abs();
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
        let mut out = [0.0f32; 64];
        intra_targets(
            &levels,
            level_mask(&levels),
            &DEFAULT_INTRA_QUANT,
            8,
            0,
            &mut out,
        );
        assert_eq!(out[0], 8.0 * 200.0 - FLAT_PREDICTION_DC);
        // AC position 1 has weight 16, so 2 * 4 * 16 * 8 / 32 = 32, and nothing
        // is subtracted: a constant prediction touches no AC term.
        assert_eq!(out[1], 32.0);
        assert_eq!(out[2], 0.0, "an uncoded position stays zero");
        assert_eq!(out[63], 1.0, "an even coefficient sum is made odd");
    }

    #[test]
    fn inter_dequantisation_adds_the_sign_correction_and_truncates_toward_zero() {
        let mut levels = [0i16; 64];
        levels[0] = 3;
        levels[1] = -3;
        let mut out = [0.0f32; 64];
        inter_targets(
            &levels,
            level_mask(&levels),
            &DEFAULT_NON_INTRA_QUANT,
            1,
            &mut out,
        );
        // (2 * 3 + 1) * 16 * 1 / 32 = 3.5, truncated to 3.
        assert_eq!(out[0], 3.0);
        // (2 * -3 - 1) * 16 * 1 / 32 = -3.5, truncated toward zero to -3.
        assert_eq!(out[1], -3.0);
        assert_eq!(out[63], 1.0, "an even coefficient sum is made odd");
    }

    #[test]
    fn inverse_quantisation_saturates_before_mismatch_control() {
        let mut levels = [0i16; 64];
        levels[0] = 2047;
        levels[1] = -2048;
        levels[63] = 2047;
        let weights = [255; 64];
        let mut out = [0.0f32; 64];
        inter_targets(&levels, level_mask(&levels), &weights, 112, &mut out);

        assert_eq!(out[0], 2047.0);
        assert_eq!(out[1], -2048.0);
        // The saturated sum is even, so the odd value at [7][7] is reduced.
        assert_eq!(out[63], 2046.0);
    }

    #[test]
    fn mismatch_control_leaves_an_odd_sum_unchanged() {
        let mut levels = [0i16; 64];
        levels[0] = 1;
        let mut out = [0.0f32; 64];
        let nonzero = inter_targets(
            &levels,
            level_mask(&levels),
            &DEFAULT_NON_INTRA_QUANT,
            2,
            &mut out,
        );

        assert_eq!(out[0], 3.0);
        assert_eq!(out[63], 0.0);
        assert_eq!(nonzero, 1, "and only the DC can be non-zero");
    }

    #[test]
    fn the_mask_covers_what_mismatch_control_adds() {
        // (2 * 2 + 1) * 16 * 4 / 32 = 10: an even sum, so F'[7][7] becomes
        // one where the source had nothing.
        let mut levels = [0i16; 64];
        levels[5] = 2;
        let mut out = [7.0f32; 64];
        let nonzero = inter_targets(
            &levels,
            level_mask(&levels),
            &DEFAULT_NON_INTRA_QUANT,
            4,
            &mut out,
        );
        assert_eq!(nonzero, (1 << 5) | (1 << 63));
        assert_eq!(out[5], 10.0);
        assert_eq!(out[63], 1.0);
        assert!(
            out.iter()
                .enumerate()
                .all(|(pos, &v)| nonzero >> pos & 1 == 1 || v == 0.0),
            "everything outside the mask was written as zero"
        );
    }

    #[test]
    fn a_column_mask_fills_the_columns_the_mask_touches() {
        assert_eq!(column_mask(0), 0);
        assert_eq!(column_mask(1), 0x0101_0101_0101_0101);
        assert_eq!(column_mask(1 << 63), 0x8080_8080_8080_8080);
        assert_eq!(
            column_mask((1 << 9) | (1 << 62)),
            0x4242_4242_4242_4242,
            "columns 1 and 6"
        );
    }

    /// What a round trip through two eight-point transforms is allowed to
    /// lose. Single precision holds about seven digits and a pass spends a few
    /// of them; a basis that was actually wrong would be out by whole units, so
    /// nothing is given up by checking to a thousandth.
    const ROUND_TRIP_TOLERANCE: f32 = 1e-3;

    #[test]
    fn the_field_and_frame_dct_bases_are_inverses_of_each_other() {
        let first: [f32; 64] = std::array::from_fn(|i| ((i * 37) % 61) as f32 - 30.0);
        let second: [f32; 64] = std::array::from_fn(|i| ((i * 53) % 47) as f32 - 23.0);
        let mut upper = [0.0f32; 64];
        let mut lower = [0.0f32; 64];
        field_dct_to_frame_targets(&first, &second, &mut upper, &mut lower);

        let mut back_first = [0.0f32; 64];
        let mut back_second = [0.0f32; 64];
        frame_dct_to_field_targets(&upper, &lower, &mut back_first, &mut back_second);

        for i in 0..64 {
            assert!(
                (back_first[i] - first[i]).abs() < ROUND_TRIP_TOLERANCE,
                "first field at {i}"
            );
            assert!(
                (back_second[i] - second[i]).abs() < ROUND_TRIP_TOLERANCE,
                "second field at {i}"
            );
        }
    }

    #[test]
    fn the_basis_change_leaves_a_constant_block_constant() {
        // A block with only a DC term is flat in the sample domain, so
        // interleaving its lines cannot change either half.
        let mut first = [0.0f32; 64];
        let mut second = [0.0f32; 64];
        first[0] = 100.0;
        second[0] = 100.0;
        let mut upper = [0.0f32; 64];
        let mut lower = [0.0f32; 64];
        field_dct_to_frame_targets(&first, &second, &mut upper, &mut lower);
        assert!((upper[0] - 100.0).abs() < ROUND_TRIP_TOLERANCE);
        assert!((lower[0] - 100.0).abs() < ROUND_TRIP_TOLERANCE);
        for i in 1..64 {
            assert!(upper[i].abs() < ROUND_TRIP_TOLERANCE, "upper AC at {i}");
            assert!(lower[i].abs() < ROUND_TRIP_TOLERANCE, "lower AC at {i}");
        }
    }
}
