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
use crate::h264::quant::{inter_targets, intra_targets, FLAT_PREDICTION_DC};
use crate::h264::quant_tables::{CHROMA_AC_GAIN_4X4, CHROMA_DC_GAIN, QPC_FROM_QPI};
use crate::round_half_up_i32;

/// Orthonormal 8-point DCT matrix; MPEG-2 coefficients live in this basis.
static C8: LazyLock<[f32; 64]> = LazyLock::new(|| {
    let mut m = [0.0; 64];
    for k in 0..8 {
        let norm: f64 = if k == 0 { 0.5 } else { 1.0 };
        let scale = (norm / 4.0).sqrt();
        for n in 0..8 {
            m[k * 8 + n] = (COS_PI_OVER_16[(2 * n + 1) * k] * scale) as f32;
        }
    }
    m
});

/// Reciprocal reconstruction gains indexed by chroma QP. Keeping these in one
/// table removes a `powi` and 64 floating-point divisions from every converted
/// chroma block.
static CHROMA_RECIPROCAL_GAIN: LazyLock<([[f32; 16]; 40], [f32; 40])> = LazyLock::new(|| {
    let mut ac = [[0.0; 16]; 40];
    let mut dc = [0.0; 40];
    for qp in 0..40 {
        let shift = 2f32.powi(qp as i32 / 6);
        let base = &CHROMA_AC_GAIN_4X4[qp % 6];
        for pos in 1..16 {
            ac[qp][pos] = 1.0 / (base[pos >> 2][pos & 3] as f32 * shift);
        }
        dc[qp] = 1.0 / (CHROMA_DC_GAIN[qp % 6] as f32 * shift);
    }
    (ac, dc)
});

/// H.264 Table 8-13: 4x4 field scan for field-coded macroblocks.
pub static FIELD_SCAN_4X4: [usize; 16] = [0, 4, 1, 8, 12, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];

/// Chroma QP for a given luma QP and PPS offset, via Table 8-15.
pub fn chroma_qp(luma_qp: i32, offset: i32) -> i32 {
    QPC_FROM_QPI[(luma_qp + offset).clamp(0, 51) as usize]
}

/// Inverse 8x8 DCT, orthonormal, into `out` in raster order.
#[cfg(not(feature = "experimental-symmetric-idct"))]
pub fn idct8(coeff: &[f32; 64], out: &mut [f32; 64], tmp: &mut [f32; 64]) {
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

/// The same basis as the dense IDCT, with mirrored samples sharing their
/// even/odd frequency sums. Regrouping f32 additions can change rounding;
/// this experimental path does not promise the dense path's output bytes.
#[cfg(feature = "experimental-symmetric-idct")]
pub fn idct8(coeff: &[f32; 64], out: &mut [f32; 64], tmp: &mut [f32; 64]) {
    #[inline]
    fn transform(input: [f32; 8], c8: &[f32; 64]) -> [f32; 8] {
        let mut result = [0.0; 8];
        for x in 0..4 {
            let even = ((c8[x] * input[0] + c8[16 + x] * input[2]) + c8[32 + x] * input[4])
                + c8[48 + x] * input[6];
            let odd = ((c8[8 + x] * input[1] + c8[24 + x] * input[3]) + c8[40 + x] * input[5])
                + c8[56 + x] * input[7];
            result[x] = even + odd;
            result[7 - x] = even - odd;
        }
        result
    }

    let c8 = &*C8;
    for v in 0..8 {
        let row = transform(std::array::from_fn(|u| coeff[v * 8 + u]), c8);
        tmp[v * 8..v * 8 + 8].copy_from_slice(&row);
    }
    for x in 0..8 {
        let column = transform(std::array::from_fn(|v| tmp[v * 8 + x]), c8);
        for y in 0..8 {
            out[y * 8 + x] = column[y];
        }
    }
}

/// H.264's forward 4x4 core transform, `W = Cf * X * Cf^T`, applied to the 4x4
/// sub-block at (bx, by) of an 8x8 sample block.
fn forward4x4(block: &[f32; 64], bx: usize, by: usize, out: &mut [f32; 16]) {
    // Cf rows are [1,1,1,1], [2,1,-1,-2], [1,-1,-1,1], [1,-2,2,-1].
    let mut t = [0.0f32; 16];
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

#[derive(Clone, Debug, Default)]
pub struct ChromaBlockLevels {
    /// The four 2x2 DC block levels, in raster order of the 4x4 sub-blocks.
    pub dc: [i32; 4],
    /// Four 4x4 AC blocks of 15 levels each, in 4x4 zig-zag order from position 1.
    pub ac: [[i32; 15]; 4],
    pub any_dc: bool,
    pub any_ac: bool,
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
    samples: &[f32; 64],
    qp_c: i32,
    out: &mut ChromaBlockLevels,
    field_scan: bool,
) {
    let qp_c = qp_c as usize;
    let ac_reciprocal = &CHROMA_RECIPROCAL_GAIN.0[qp_c];
    let dc_reciprocal = CHROMA_RECIPROCAL_GAIN.1[qp_c];
    let scan: &[usize; 16] = if field_scan {
        &FIELD_SCAN_4X4
    } else {
        &ZIGZAG_4X4
    };

    let mut coeff4 = [0.0f32; 16];
    let mut dc_target = [0.0f32; 4];
    out.any_ac = false;
    for b in 0..4 {
        forward4x4(samples, (b & 1) * 4, (b >> 1) * 4, &mut coeff4);
        dc_target[b] = coeff4[0];
        out.any_ac |= ac_levels_for(&coeff4, ac_reciprocal, scan, &mut out.ac[b]);
    }

    let f0 = dc_target[0] * dc_reciprocal;
    let f1 = dc_target[1] * dc_reciprocal;
    let f2 = dc_target[2] * dc_reciprocal;
    let f3 = dc_target[3] * dc_reciprocal;
    out.dc[0] = round_half_up_i32((f0 + f1 + f2 + f3) / 4.0);
    out.dc[1] = round_half_up_i32((f0 - f1 + f2 - f3) / 4.0);
    out.dc[2] = round_half_up_i32((f0 + f1 - f2 - f3) / 4.0);
    out.dc[3] = round_half_up_i32((f0 - f1 - f2 + f3) / 4.0);
    out.any_dc = out.dc.iter().any(|&v| v != 0);
}

/// Quantise the 15 AC coefficients of one 4x4 block into the coding scan
/// order `scan` names, which is the order the residual writer consumes.
///
/// Each level is first computed in raster order -- position by position, so
/// the loads from `coeff4` and `ac_reciprocal` are contiguous and no scan
/// dereference sits between the f32 product and the rounding -- and the
/// integer levels are then copied to where `scan` puts them. The arithmetic is
/// exactly what the previous single gather loop performed: every element is
/// still `round_half_up_i32(coeff4[pos] * ac_reciprocal[pos])` for its own
/// position, and the reorder is pure integer copying. Returns whether any of
/// the 15 levels is non-zero, which is the caller's coded-block-pattern bit.
fn ac_levels_for(
    coeff4: &[f32; 16],
    ac_reciprocal: &[f32; 16],
    scan: &[usize; 16],
    out: &mut [i32; 15],
) -> bool {
    let mut raster = [0i32; 16];
    let mut any = false;
    for pos in 1..16 {
        let level = round_half_up_i32(coeff4[pos] * ac_reciprocal[pos]);
        raster[pos] = level;
        any |= level != 0;
    }
    for k in 1..16 {
        out[k - 1] = raster[scan[k]];
    }
    any
}

fn dequant_chroma(
    levels: Option<&[i16; 64]>,
    weight_scale: &[i32; 64],
    quantiser_scale: i32,
    intra_dc_precision: u32,
    intra: bool,
    out: &mut [f32; 64],
) {
    let Some(levels) = levels else {
        out.fill(0.0);
        return;
    };
    if intra {
        intra_targets(
            levels,
            weight_scale,
            quantiser_scale,
            intra_dc_precision,
            out,
        );
    } else {
        inter_targets(levels, weight_scale, quantiser_scale, out);
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
    upper_coeff: [f32; 64],
    lower_coeff: [f32; 64],
    upper_spatial: [f32; 64],
    lower_spatial: [f32; 64],
    field_spatial: [f32; 64],
    idct_temp: [f32; 64],
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
    field_scan: bool,
) {
    let mut dequant = [0.0f32; 64];
    let mut spatial = [0.0f32; 64];
    let mut tmp = [0.0f32; 64];

    dequant_chroma(
        Some(levels),
        weight_scale,
        quantiser_scale,
        intra_dc_precision,
        intra,
        &mut dequant,
    );
    idct8(&dequant, &mut spatial, &mut tmp);
    spatial_to_chroma_levels(&spatial, qp_c, out, field_scan);
}

/// As [`convert_chroma_block`], but for a block predicted the way H.264 itself
/// predicts rather than from the flat reference index.
///
/// The random access point is coded with real intra prediction, which gives
/// each of the component's four 4x4 blocks its own constant. Dequantisation has
/// already taken the flat constant off every sample, so putting it back and
/// removing the right one leaves the residual this block actually needs.
pub fn convert_intra_chroma_block(
    levels: &[i16; 64],
    weight_scale: &[i32; 64],
    quantiser_scale: i32,
    intra_dc_precision: u32,
    qp_c: i32,
    prediction: &[i32; 4],
    out: &mut ChromaBlockLevels,
    field_scan: bool,
) {
    let mut dequant = [0.0f32; 64];
    let mut spatial = [0.0f32; 64];
    let mut tmp = [0.0f32; 64];

    dequant_chroma(
        Some(levels),
        weight_scale,
        quantiser_scale,
        intra_dc_precision,
        true,
        &mut dequant,
    );
    idct8(&dequant, &mut spatial, &mut tmp);
    for (i, sample) in spatial.iter_mut().enumerate() {
        let blk = ((i / 8) / 4) * 2 + (i % 8) / 4;
        *sample += FLAT_PREDICTION_DC / 8.0 - prediction[blk] as f32;
    }
    spatial_to_chroma_levels(&spatial, qp_c, out, field_scan);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Table 8-13, written as the column and row each entry names.
    #[test]
    fn field_scan_visits_the_positions_table_8_13_names() {
        #[rustfmt::skip]
        let coordinates: [(usize, usize); 16] = [
            (0, 0), (0, 1), (1, 0), (0, 2),
            (0, 3), (1, 1), (1, 2), (1, 3),
            (2, 0), (2, 1), (2, 2), (2, 3),
            (3, 0), (3, 1), (3, 2), (3, 3),
        ];
        let expected: Vec<usize> = coordinates.iter().map(|&(x, y)| y * 4 + x).collect();
        assert_eq!(FIELD_SCAN_4X4.to_vec(), expected);

        let mut seen = [false; 16];
        for &p in &FIELD_SCAN_4X4 {
            assert!(!seen[p], "position {p} is scanned twice");
            seen[p] = true;
        }
    }

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
        let mut coeff = [0.0f32; 64];
        coeff[0] = 8.0 * 100.0; // orthonormal DC of a block of 100s
        let mut out = [0.0f32; 64];
        let mut tmp = [0.0f32; 64];
        idct8(&coeff, &mut out, &mut tmp);
        for (i, &v) in out.iter().enumerate() {
            assert!((v - 100.0).abs() < 1e-9, "sample {i} is {v}");
        }
    }

    #[cfg(feature = "experimental-symmetric-idct")]
    #[test]
    fn the_rounded_basis_preserves_idct_mirror_symmetry() {
        let c8 = &*C8;
        for k in 0..8 {
            for x in 0..4 {
                let reflected = if k % 2 == 0 {
                    c8[k * 8 + x]
                } else {
                    -c8[k * 8 + x]
                };
                assert_eq!(c8[k * 8 + 7 - x].to_bits(), reflected.to_bits());
            }
        }
    }

    fn check_idct_against_f64_matrix(coeff: &[f32; 64]) {
        let c8 = &*C8;
        let mut out = [f32::NAN; 64];
        let mut tmp = [f32::NAN; 64];
        idct8(coeff, &mut out, &mut tmp);
        for y in 0..8 {
            for x in 0..8 {
                let mut expected = 0.0f64;
                let mut absolute_sum = 0.0f64;
                // Direct 2D matrix product in double precision: no shared
                // intermediate layout or even/odd decomposition with idct8.
                for v in 0..8 {
                    for u in 0..8 {
                        let term =
                            coeff[v * 8 + u] as f64 * c8[u * 8 + x] as f64 * c8[v * 8 + y] as f64;
                        expected += term;
                        absolute_sum += term.abs();
                    }
                }
                // Conservative roundoff allowance scaled to the input, not
                // a pixel-quality threshold. Cancellation may make expected
                // zero even for a large block, hence absolute_sum, not |expected|.
                let tolerance = 32.0 * f32::EPSILON as f64 * (absolute_sum + 1.0);
                let actual = out[y * 8 + x] as f64;
                assert!(
                    actual.is_finite() && (actual - expected).abs() <= tolerance,
                    "sample ({x},{y}): actual={actual}, expected={expected}, tolerance={tolerance}"
                );
            }
        }
    }

    #[test]
    fn idct_matches_the_f64_matrix_for_basis_sparse_and_dense_blocks() {
        check_idct_against_f64_matrix(&[0.0; 64]);
        for pos in 0..64 {
            for level in [-3064.0, 1.0, 2047.0] {
                let mut coeff = [0.0; 64];
                coeff[pos] = level;
                check_idct_against_f64_matrix(&coeff);
            }
        }
        for scale in [1.0, 4096.0, 1.0e12] {
            for axis in 0..3 {
                let coeff = std::array::from_fn(|pos| {
                    let parity = match axis {
                        0 => pos % 8,
                        1 => pos / 8,
                        _ => pos % 8 + pos / 8,
                    };
                    if parity % 2 == 0 {
                        scale
                    } else {
                        -scale
                    }
                });
                check_idct_against_f64_matrix(&coeff);
            }
        }
        let mut state = 0x9e37_79b9u32;
        for block in 0..256 {
            let coeff = std::array::from_fn(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                if block % 2 == 0 && state % 4 != 0 {
                    0.0
                } else {
                    ((state & 8191) as i32 - 4096) as f32
                }
            });
            check_idct_against_f64_matrix(&coeff);
        }
    }

    #[test]
    fn a_flat_residual_becomes_a_chroma_dc_level_and_no_ac() {
        // A constant block has one non-zero 4x4 DC per sub-block, which the 2x2
        // Hadamard then concentrates into a single chroma DC level.
        let mut levels = [0i16; 64];
        levels[0] = 8 * 60; // DC only, at intra_dc_precision 0 this is 60 per sample
        let mut out = ChromaBlockLevels::default();
        convert_chroma_block(&levels, &[16; 64], 8, 0, 26, &mut out, false, false);
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
        convert_chroma_block(&levels, &[16; 64], 8, 0, 26, &mut out, true, false);
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
        convert_chroma_block(&levels, &[16; 64], 16, 0, 20, &mut out, false, false);
        assert!(!out.is_empty(), "the fixture actually codes something");
        out.clear();
        assert!(out.is_empty());
        assert_eq!(out.dc, [0; 4]);
        assert!(out.ac.iter().all(|block| block.iter().all(|&v| v == 0)));
    }

    #[test]
    fn the_raster_reorder_path_is_identical_to_the_gather_loop() {
        // The reorder must not change a single level, so a test-local copy of
        // the previous one-pass algorithm is the reference and the two are
        // compared over deterministic pseudo-random blocks, both scans, and a
        // spread of chroma QPs.
        fn reference_ac(
            samples: &[f32; 64],
            qp_c: i32,
            field_scan: bool,
        ) -> ([[i32; 15]; 4], bool) {
            let qp_c = qp_c as usize;
            let ac_reciprocal = &CHROMA_RECIPROCAL_GAIN.0[qp_c];
            let scan: &[usize; 16] = if field_scan {
                &FIELD_SCAN_4X4
            } else {
                &ZIGZAG_4X4
            };
            let mut out = [[0i32; 15]; 4];
            let mut any_ac = false;
            let mut coeff4 = [0.0f32; 16];
            for b in 0..4 {
                forward4x4(samples, (b & 1) * 4, (b >> 1) * 4, &mut coeff4);
                for k in 1..16 {
                    let pos = scan[k];
                    let level = round_half_up_i32(coeff4[pos] * ac_reciprocal[pos]);
                    out[b][k - 1] = level;
                    if level != 0 {
                        any_ac = true;
                    }
                }
            }
            (out, any_ac)
        }

        let mut seed = 0x9e37_79b9u32;
        let mut next = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / 16_777_216.0 - 0.5
        };
        for qp_c in [0, 13, 26, 39] {
            for field_scan in [false, true] {
                for _ in 0..100 {
                    let mut samples = [0.0f32; 64];
                    for sample in samples.iter_mut() {
                        *sample = next() * 600.0;
                    }
                    let mut candidate = ChromaBlockLevels::default();
                    spatial_to_chroma_levels(&samples, qp_c, &mut candidate, field_scan);
                    let (expected_ac, expected_any) = reference_ac(&samples, qp_c, field_scan);
                    assert_eq!(
                        candidate.ac, expected_ac,
                        "qp_c {qp_c} field_scan {field_scan}"
                    );
                    assert_eq!(
                        candidate.any_ac, expected_any,
                        "qp_c {qp_c} field_scan {field_scan}"
                    );
                }
            }
        }
    }

    #[test]
    fn an_all_zero_block_stays_empty_and_a_nonzero_one_reports_ac_for_either_scan() {
        for field_scan in [false, true] {
            let mut out = ChromaBlockLevels::default();
            spatial_to_chroma_levels(&[0.0; 64], 20, &mut out, field_scan);
            assert!(out.is_empty(), "no samples, no levels, {field_scan}");

            let mut samples = [0.0f32; 64];
            // An impulse in the top-left sub-block puts energy into that
            // block's own AC and DC; the other three sub-blocks read none of
            // it. Either scan still has to carry it in the top-left block's AC.
            samples[0] = 400.0;
            spatial_to_chroma_levels(&samples, 20, &mut out, field_scan);
            assert!(out.any_ac, "the impulse lands on AC, {field_scan}");
            assert!(
                out.ac.iter().any(|block| block.iter().any(|&v| v != 0)),
                "the AC record itself holds it, {field_scan}"
            );
        }
    }
}
