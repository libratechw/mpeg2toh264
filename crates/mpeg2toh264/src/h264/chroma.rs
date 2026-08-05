//! Chroma conversion.
//!
//! This is the one place the transcoder does real transform work. MPEG-2 codes a
//! chroma block as a single 8x8 DCT, while H.264 4:2:0 uses four 4x4 transforms
//! plus a 2x2 DC block, and a single 8x8 coefficient spreads across roughly 22
//! of the 4x4 ones -- there is no per-coefficient shortcut of the kind the luma
//! path uses. So the block is inverse transformed to samples and forward
//! transformed again.
//!
//! Having paid that cost, the forward transform used is H.264's own core
//! transform rather than an idealised DCT. Its rows are mutually orthogonal, so
//! projecting onto them yields exactly the coefficients the decoder
//! reconstructs from, and the basis-shape mismatch that puts a floor under the
//! luma path does not arise here.

use std::sync::LazyLock;

use crate::h264::cos_table::COS_PI_OVER_16;
use crate::h264::params::ZIGZAG_4X4;
use crate::h264::quant::FLAT_PREDICTION_DC;
use crate::h264::quant_tables::{CHROMA_AC_GAIN_4X4, CHROMA_DC_GAIN, QPC_FROM_QPI};
use crate::round_half_up_i32;

/// Orthonormal 8-point DCT matrix; MPEG-2 coefficients live in this basis.
static C8: LazyLock<[f64; 64]> = LazyLock::new(|| {
    let mut m = [0.0; 64];
    for k in 0..8 {
        let norm = if k == 0 { 0.5f64 } else { 1.0 };
        let scale = (norm / 4.0).sqrt();
        for n in 0..8 {
            m[k * 8 + n] = COS_PI_OVER_16[(2 * n + 1) * k] * scale;
        }
    }
    m
});

/// H.264 Table 8-14: 4x4 field scan for field-coded macroblocks.
pub static FIELD_SCAN_4X4: [usize; 16] = [0, 4, 1, 8, 12, 5, 9, 2, 6, 13, 10, 3, 7, 14, 11, 15];

/// Chroma QP for a given luma QP and PPS offset, via Table 8-15.
pub fn chroma_qp(luma_qp: i32, offset: i32) -> i32 {
    QPC_FROM_QPI[(luma_qp + offset).clamp(0, 51) as usize]
}

/// Inverse 8x8 DCT, orthonormal, into `out` in raster order.
pub fn idct8(coeff: &[f64; 64], out: &mut [f64; 64], tmp: &mut [f64; 64]) {
    let c8 = &*C8;
    // Columns first: tmp = C8^T * coeff
    for x in 0..8 {
        for v in 0..8 {
            let mut s = 0.0;
            for u in 0..8 {
                s += c8[u * 8 + x] * coeff[v * 8 + u];
            }
            tmp[v * 8 + x] = s;
        }
    }
    // Then rows: out = tmp^T applied the same way down the other axis.
    for x in 0..8 {
        for y in 0..8 {
            let mut s = 0.0;
            for v in 0..8 {
                s += c8[v * 8 + y] * tmp[v * 8 + x];
            }
            out[y * 8 + x] = s;
        }
    }
}

/// H.264's forward 4x4 core transform, `W = Cf * X * Cf^T`, applied to the 4x4
/// sub-block at (bx, by) of an 8x8 sample block.
fn forward4x4(block: &[f64; 64], bx: usize, by: usize, out: &mut [f64; 16]) {
    // Cf rows are [1,1,1,1], [2,1,-1,-2], [1,-1,-1,1], [1,-2,2,-1].
    let mut t = [0.0f64; 16];
    for i in 0..4 {
        let r = (by + i) * 8 + bx;
        let (a, b, c, d) = (block[r], block[r + 1], block[r + 2], block[r + 3]);
        let s0 = a + d;
        let s1 = b + c;
        let s2 = b - c;
        let s3 = a - d;
        t[i * 4] = s0 + s1;
        t[i * 4 + 1] = 2.0 * s3 + s2;
        t[i * 4 + 2] = s0 - s1;
        t[i * 4 + 3] = s3 - 2.0 * s2;
    }
    for j in 0..4 {
        let (a, b, c, d) = (t[j], t[4 + j], t[8 + j], t[12 + j]);
        let s0 = a + d;
        let s1 = b + c;
        let s2 = b - c;
        let s3 = a - d;
        out[j] = s0 + s1;
        out[4 + j] = 2.0 * s3 + s2;
        out[8 + j] = s0 - s1;
        out[12 + j] = s3 - 2.0 * s2;
    }
}

#[derive(Clone, Debug)]
pub struct ChromaBlockLevels {
    /// The four 2x2 DC block levels, in raster order of the 4x4 sub-blocks.
    pub dc: [i32; 4],
    /// Four 4x4 AC blocks of 15 levels each, in 4x4 zig-zag order from position 1.
    pub ac: [[i32; 15]; 4],
    pub any_dc: bool,
    pub any_ac: bool,
}

impl Default for ChromaBlockLevels {
    fn default() -> Self {
        Self {
            dc: [0; 4],
            ac: [[0; 15]; 4],
            any_dc: false,
            any_ac: false,
        }
    }
}

impl ChromaBlockLevels {
    /// Reset the record. Necessary because `coded_block_pattern`'s chroma field
    /// is shared between Cb and Cr: if one component has AC coefficients then
    /// both components' AC blocks get written, so an uncoded component must
    /// present zeros rather than whatever the previous macroblock left behind.
    pub fn clear(&mut self) {
        self.dc = [0; 4];
        self.ac = [[0; 15]; 4];
        self.any_dc = false;
        self.any_ac = false;
    }

    pub fn is_empty(&self) -> bool {
        !self.any_dc && !self.any_ac
    }
}

fn spatial_to_chroma_levels(
    samples: &[f64; 64],
    qp_c: i32,
    out: &mut ChromaBlockLevels,
    field_scan: bool,
) {
    let ac_gain = &CHROMA_AC_GAIN_4X4[(qp_c % 6) as usize];
    let shift = 2f64.powi(qp_c / 6);
    let dc_gain = CHROMA_DC_GAIN[(qp_c % 6) as usize] * shift;
    let scan: &[usize; 16] = if field_scan {
        &FIELD_SCAN_4X4
    } else {
        &ZIGZAG_4X4
    };

    let mut coeff4 = [0.0f64; 16];
    let mut dc_target = [0.0f64; 4];
    out.any_ac = false;
    for b in 0..4 {
        forward4x4(samples, (b & 1) * 4, (b >> 1) * 4, &mut coeff4);
        dc_target[b] = coeff4[0];
        let ac_out = &mut out.ac[b];
        for k in 1..16 {
            let pos = scan[k];
            let gain = ac_gain[pos >> 2][pos & 3] * shift;
            let level = round_half_up_i32(coeff4[pos] / gain);
            ac_out[k - 1] = level;
            if level != 0 {
                out.any_ac = true;
            }
        }
    }

    let f0 = dc_target[0] / dc_gain;
    let f1 = dc_target[1] / dc_gain;
    let f2 = dc_target[2] / dc_gain;
    let f3 = dc_target[3] / dc_gain;
    out.dc[0] = round_half_up_i32((f0 + f1 + f2 + f3) / 4.0);
    out.dc[1] = round_half_up_i32((f0 - f1 + f2 - f3) / 4.0);
    out.dc[2] = round_half_up_i32((f0 + f1 - f2 - f3) / 4.0);
    out.dc[3] = round_half_up_i32((f0 - f1 - f2 + f3) / 4.0);
    out.any_dc = out.dc.iter().any(|&v| v != 0);
}

fn dequant_chroma(
    levels: Option<&[i16; 64]>,
    weight_scale: &[i32; 64],
    quantiser_scale: i32,
    intra_dc_precision: u32,
    intra: bool,
    out: &mut [f64; 64],
) {
    let Some(levels) = levels else {
        out.fill(0.0);
        return;
    };
    for pos in 0..64 {
        let level = levels[pos] as i64;
        if intra && pos == 0 {
            out[pos] = ((8 >> intra_dc_precision) as i64 * level) as f64 - FLAT_PREDICTION_DC;
        } else if level == 0 {
            out[pos] = 0.0;
        } else {
            let sign: i64 = if level < 0 { -1 } else { 1 };
            let numerator = if intra { 2 * level } else { 2 * level + sign };
            let scaled = numerator * weight_scale[pos] as i64 * quantiser_scale as i64;
            out[pos] = (scaled / 32) as f64;
        }
    }
}

/// One MPEG-2 chroma block as the field-pair conversion needs to see it.
pub struct FieldChromaSource<'a> {
    pub levels: Option<&'a [i16; 64]>,
    pub weight_scale: &'a [i32; 64],
    pub quantiser_scale: i32,
    pub intra_dc_precision: u32,
    pub intra: bool,
}

/// Reusable buffers for the field-pair conversion, which runs per macroblock
/// pair and would otherwise allocate six 8x8 blocks each time.
pub struct FieldChromaScratch {
    upper_coeff: [f64; 64],
    lower_coeff: [f64; 64],
    upper_spatial: [f64; 64],
    lower_spatial: [f64; 64],
    field_spatial: [f64; 64],
    idct_temp: [f64; 64],
}

impl Default for FieldChromaScratch {
    fn default() -> Self {
        Self {
            upper_coeff: [0.0; 64],
            lower_coeff: [0.0; 64],
            upper_spatial: [0.0; 64],
            lower_spatial: [0.0; 64],
            field_spatial: [0.0; 64],
            idct_temp: [0.0; 64],
        }
    }
}

/// Convert both field macroblocks of a pair while sharing the source
/// dequantisation and IDCT. `out_top` receives the field made of the even lines
/// and `out_bottom` the odd ones.
pub fn convert_field_chroma_pair(
    upper: &FieldChromaSource<'_>,
    lower: &FieldChromaSource<'_>,
    qp_c: i32,
    out_top: &mut ChromaBlockLevels,
    out_bottom: &mut ChromaBlockLevels,
    scratch: &mut FieldChromaScratch,
) {
    if upper.levels.is_some() {
        dequant_chroma(
            upper.levels,
            upper.weight_scale,
            upper.quantiser_scale,
            upper.intra_dc_precision,
            upper.intra,
            &mut scratch.upper_coeff,
        );
        idct8(
            &scratch.upper_coeff,
            &mut scratch.upper_spatial,
            &mut scratch.idct_temp,
        );
    } else {
        scratch.upper_spatial.fill(0.0);
    }
    if lower.levels.is_some() {
        dequant_chroma(
            lower.levels,
            lower.weight_scale,
            lower.quantiser_scale,
            lower.intra_dc_precision,
            lower.intra,
            &mut scratch.lower_coeff,
        );
        idct8(
            &scratch.lower_coeff,
            &mut scratch.lower_spatial,
            &mut scratch.idct_temp,
        );
    } else {
        scratch.lower_spatial.fill(0.0);
    }
    for (field, out) in [out_top, out_bottom].into_iter().enumerate() {
        for y in 0..4 {
            for x in 0..8 {
                scratch.field_spatial[y * 8 + x] = scratch.upper_spatial[(y * 2 + field) * 8 + x];
                scratch.field_spatial[(y + 4) * 8 + x] =
                    scratch.lower_spatial[(y * 2 + field) * 8 + x];
            }
        }
        spatial_to_chroma_levels(&scratch.field_spatial, qp_c, out, true);
    }
}

/// Convert one MPEG-2 chroma block into H.264 chroma levels.
///
/// For an intra block the prediction being removed is the flat constant of the
/// zero-weight reference index, which in the transform domain is a shift of the
/// DC coefficient alone. A non-intra block is coded against motion compensation
/// the H.264 side reproduces, so its residual carries across untouched.
pub fn convert_chroma_block(
    levels: &[i16; 64],
    weight_scale: &[i32; 64],
    quantiser_scale: i32,
    intra_dc_precision: u32,
    qp_c: i32,
    out: &mut ChromaBlockLevels,
    intra: bool,
) {
    let mut dequant = [0.0f64; 64];
    let mut spatial = [0.0f64; 64];
    let mut tmp = [0.0f64; 64];

    dequant_chroma(
        Some(levels),
        weight_scale,
        quantiser_scale,
        intra_dc_precision,
        intra,
        &mut dequant,
    );
    idct8(&dequant, &mut spatial, &mut tmp);
    spatial_to_chroma_levels(&spatial, qp_c, out, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chroma_qp_tracks_luma_until_thirty_then_flattens() {
        assert_eq!(chroma_qp(20, 0), 20, "below 30 the two are equal");
        assert_eq!(chroma_qp(26, -6), 20, "the offset applies first");
        assert_eq!(chroma_qp(30, 0), 29, "Table 8-15 starts compressing");
        assert_eq!(chroma_qp(51, 0), 39, "and saturates");
        assert_eq!(chroma_qp(3, -6), 0, "the index is clamped, not wrapped");
        assert_eq!(chroma_qp(60, 6), 39);
    }

    #[test]
    fn the_inverse_transform_turns_a_dc_term_into_a_flat_block() {
        let mut coeff = [0.0f64; 64];
        coeff[0] = 8.0 * 100.0; // orthonormal DC of a block of 100s
        let mut out = [0.0f64; 64];
        let mut tmp = [0.0f64; 64];
        idct8(&coeff, &mut out, &mut tmp);
        for (i, &v) in out.iter().enumerate() {
            assert!((v - 100.0).abs() < 1e-9, "sample {i} is {v}");
        }
    }

    #[test]
    fn a_flat_residual_becomes_a_chroma_dc_level_and_no_ac() {
        // A constant block has one non-zero 4x4 DC per sub-block, which the 2x2
        // Hadamard then concentrates into a single chroma DC level.
        let mut levels = [0i16; 64];
        levels[0] = 8 * 60; // DC only, at intra_dc_precision 0 this is 60 per sample
        let mut out = ChromaBlockLevels::default();
        convert_chroma_block(&levels, &[16; 64], 8, 0, 26, &mut out, false);
        assert!(out.any_dc, "the flat level lands on the DC block");
        assert!(!out.any_ac, "a constant block has no AC content");
        assert_eq!(&out.dc[1..], &[0, 0, 0], "only the Hadamard DC is non-zero");
    }

    #[test]
    fn an_intra_block_has_the_flat_prediction_removed() {
        // Coding a block whose samples already equal FLAT_PREDICTION leaves
        // nothing at all to transmit.
        let mut levels = [0i16; 64];
        levels[0] = (FLAT_PREDICTION_DC / 8.0) as i16;
        let mut out = ChromaBlockLevels::default();
        convert_chroma_block(&levels, &[16; 64], 8, 0, 26, &mut out, true);
        assert!(
            out.is_empty(),
            "the residual against a flat prediction is zero"
        );
    }

    #[test]
    fn clearing_a_record_wipes_both_dc_and_ac() {
        let mut levels = [0i16; 64];
        levels[5] = 400;
        let mut out = ChromaBlockLevels::default();
        convert_chroma_block(&levels, &[16; 64], 16, 0, 20, &mut out, false);
        assert!(!out.is_empty(), "the fixture actually codes something");
        out.clear();
        assert!(out.is_empty());
        assert_eq!(out.dc, [0; 4]);
        assert!(out.ac.iter().all(|block| block.iter().all(|&v| v == 0)));
    }
}
