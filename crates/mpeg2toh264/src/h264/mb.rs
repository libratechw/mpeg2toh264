//! H.264 macroblock layer.
//!
//! Every MPEG-2 macroblock becomes an inter macroblock, including intra ones:
//! see [`crate::h264::slice`] for why H.264 intra prediction is avoided
//! entirely. An intra macroblock is coded as `P_L0_16x16` with a zero motion
//! vector pointing at the flat-prediction reference index, so its prediction is
//! a known constant and its residual is just the block with that constant
//! removed.

use crate::error::Result;
use crate::h264::bitwriter::BitWriter;
use crate::h264::cavlc::write_residual_levels;
use crate::h264::cavlc_tables::CBP_TO_CODE_NUM_INTER;
use crate::h264::chroma::ChromaBlockLevels;
use crate::h264::params::ZIGZAG_8X8;

/// H.264 Table 8-14: 8x8 field scan for field-coded macroblocks.
pub static FIELD_SCAN_8X8: [usize; 64] = [
    0, 8, 16, 1, 9, 24, 32, 17, 2, 10, 25, 40, 48, 33, 18, 3, 11, 26, 41, 56, 49, 34, 19, 4, 12,
    27, 42, 57, 50, 35, 20, 5, 13, 28, 43, 58, 51, 36, 21, 6, 14, 29, 44, 59, 52, 37, 22, 7, 15,
    30, 45, 60, 53, 38, 23, 31, 46, 61, 54, 39, 47, 62, 55, 63,
];

/// B slice macroblock types for a single 16x16 partition (Table 7-14).
///
/// Everything this transcoder emits is a B slice, including the pictures that
/// were I or P in the source, because bi-prediction is only available there and
/// the half-sample mapping depends on it.
pub mod b_mb_type {
    pub const L0_16X16: u32 = 1;
    pub const L1_16X16: u32 = 2;
    pub const BI_16X16: u32 = 3;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PredictionMode {
    L0,
    L1,
    Bi,
}

impl PredictionMode {
    /// The mode a single-partition `mb_type` stands for.
    pub fn from_mb_type(mb_type: u32) -> Self {
        match mb_type {
            b_mb_type::L0_16X16 => Self::L0,
            b_mb_type::L1_16X16 => Self::L1,
            _ => Self::Bi,
        }
    }
}

/// B-slice `mb_type` for two 16x8 partitions (Table 7-14).
pub fn b16x8_mb_type(top: PredictionMode, bottom: PredictionMode) -> u32 {
    use PredictionMode::{Bi, L0, L1};
    match (top, bottom) {
        (L0, L0) => 4,
        (L0, L1) => 8,
        (L0, Bi) => 12,
        (L1, L0) => 10,
        (L1, L1) => 6,
        (L1, Bi) => 14,
        (Bi, L0) => 16,
        (Bi, L1) => 18,
        (Bi, Bi) => 20,
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MotionPartition {
    pub ref_idx_l0: i32,
    pub ref_idx_l1: i32,
    pub mvd_l0x: i32,
    pub mvd_l0y: i32,
    pub mvd_l1x: i32,
    pub mvd_l1y: i32,
}

/// `te(v)`: with exactly two choices the value is a single inverted bit,
/// otherwise it is plain `ue(v)` (clause 9.1.1).
fn write_te(w: &mut BitWriter, value: i32, range: i32) {
    if range == 1 {
        w.u(1, u32::from(value == 0));
    } else {
        w.ue(value as u32);
    }
}

/// Position of each 4x4 luma block within a macroblock, in units of 4 samples
/// (clause 6.4.3). The order walks 8x8 quadrants, and the four 4x4 blocks inside
/// each quadrant, rather than plain raster.
static LUMA_4X4_XY: [(usize, usize); 16] = [
    (0, 0),
    (1, 0),
    (0, 1),
    (1, 1),
    (2, 0),
    (3, 0),
    (2, 1),
    (3, 1),
    (0, 2),
    (1, 2),
    (0, 3),
    (1, 3),
    (2, 2),
    (3, 2),
    (2, 3),
    (3, 3),
];

/// TotalCoeff of every 4x4 luma block in the picture, which neighbouring blocks
/// need to derive their nC (clause 9.2.1). -1 marks a block outside the picture.
pub struct CoeffCountMap {
    counts: Vec<i16>,
    pub blk_w: usize,
    pub blk_h: usize,
}

impl CoeffCountMap {
    /// Dimensions are in 4x4 blocks, which differ between luma and chroma.
    pub fn new(blk_w: usize, blk_h: usize) -> Self {
        Self {
            counts: vec![-1; blk_w * blk_h],
            blk_w,
            blk_h,
        }
    }

    pub fn reset(&mut self) {
        self.counts.fill(-1);
    }

    pub fn set(&mut self, bx: usize, by: usize, total: usize) {
        self.counts[by * self.blk_w + bx] = total as i16;
    }

    /// nC from the left and upper neighbours. A block that was coded but carries
    /// no coefficients counts as 0, which is different from being unavailable.
    pub fn n_c(&self, bx: usize, by: usize) -> i32 {
        let a = if bx > 0 {
            self.counts[by * self.blk_w + bx - 1] as i32
        } else {
            -1
        };
        let b = if by > 0 {
            self.counts[(by - 1) * self.blk_w + bx] as i32
        } else {
            -1
        };
        if a >= 0 && b >= 0 {
            return (a + b + 1) >> 1;
        }
        if a >= 0 {
            return a;
        }
        if b >= 0 {
            return b;
        }
        0
    }
}

/// Coefficient counts for the chroma 4x4 blocks, one map per component.
pub struct ChromaCounts {
    pub cb: CoeffCountMap,
    pub cr: CoeffCountMap,
}

impl ChromaCounts {
    /// 4:2:0 chroma is a 2x2 grid of 4x4 blocks per macroblock.
    pub fn new(mb_width: usize, mb_height: usize) -> Self {
        Self {
            cb: CoeffCountMap::new(mb_width * 2, mb_height * 2),
            cr: CoeffCountMap::new(mb_width * 2, mb_height * 2),
        }
    }

    pub fn reset(&mut self) {
        self.cb.reset();
        self.cr.reset();
    }
}

/// Luma is a 4x4 grid of 4x4 blocks per macroblock.
pub fn make_luma_counts(mb_width: usize, mb_height: usize) -> CoeffCountMap {
    CoeffCountMap::new(mb_width * 4, mb_height * 4)
}

#[derive(Clone, Debug)]
pub struct InterMacroblock {
    /// Macroblock position in the picture.
    pub mb_x: usize,
    pub mb_y: usize,
    /// `P_L0_16x16` syntax instead of a B-slice macroblock type.
    pub p_slice: bool,
    /// One of [`b_mb_type`], or a 16x8 type from [`b16x8_mb_type`].
    pub mb_type: u32,
    /// Reference indices; -1 marks a list this macroblock does not use.
    pub ref_idx_l0: i32,
    pub ref_idx_l1: i32,
    /// Motion vector differences in quarter samples.
    pub mvd_l0x: i32,
    pub mvd_l0y: i32,
    pub mvd_l1x: i32,
    pub mvd_l1y: i32,
    /// Two entries select 16x8 partition syntax; `None` means one 16x16 partition.
    pub partitions: Option<[MotionPartition; 2]>,
    /// Highest reference index available in each list, for `te(v)`.
    pub num_ref_idx_l0_minus1: i32,
    pub num_ref_idx_l1_minus1: i32,
    /// QP this macroblock is coded at.
    pub qp: i32,
    /// QP of the previous macroblock in decoding order, for `mb_qp_delta`.
    pub prev_qp: i32,
}

/// Sixteen raster-order luma rows of sixteen samples, then eight raster-order
/// 4:2:0 chroma rows for each component.
#[derive(Clone)]
pub struct PcmMacroblockSamples {
    pub luma: [u8; 256],
    pub cb: [u8; 64],
    pub cr: [u8; 64],
}

impl PcmMacroblockSamples {
    /// Neutral grey, for a macroblock the source never coded.
    pub fn grey() -> Self {
        Self {
            luma: [128; 256],
            cb: [128; 64],
            cr: [128; 64],
        }
    }
}

/// Which slice type the I_PCM macroblock is being written into, which shifts its
/// `mb_type` past that slice's inter types.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PcmSliceType {
    I,
    P,
    B,
}

/// Write an independently decodable I_PCM macroblock.
pub fn write_pcm_macroblock(
    w: &mut BitWriter,
    slice_type: PcmSliceType,
    samples: &PcmMacroblockSamples,
) {
    // I_PCM is mb_type 25 in an I slice, offset by the inter types in P and B.
    w.ue(match slice_type {
        PcmSliceType::I => 25,
        PcmSliceType::P => 30,
        PcmSliceType::B => 48,
    });
    while !w.is_byte_aligned() {
        w.flag(false); // pcm_alignment_zero_bit
    }
    for &sample in samples.luma.iter() {
        w.u(8, sample as u32);
    }
    for &sample in samples.cb.iter() {
        w.u(8, sample as u32);
    }
    for &sample in samples.cr.iter() {
        w.u(8, sample as u32);
    }
}

/// Write one macroblock. Returns the QP in effect afterwards, which is the
/// macroblock's own QP only if it actually carried a `mb_qp_delta`.
///
/// `luma` holds the four 8x8 blocks of coefficient levels in 8x8 zig-zag scan
/// order, or `None` where a block has no coefficients at all; `chroma` is `None`
/// to leave chroma at the prediction.
pub fn write_inter_macroblock(
    w: &mut BitWriter,
    counts: &mut CoeffCountMap,
    chroma_counts: &mut ChromaCounts,
    mb: &InterMacroblock,
    luma: &[Option<&[i32; 64]>; 4],
    chroma: Option<&[ChromaBlockLevels; 2]>,
) -> Result<i32> {
    // P_L0_16x16 is mb_type 0 (Table 7-13). B slices use Table 7-14 below.
    w.ue(if mb.p_slice {
        u32::from(mb.partitions.is_some())
    } else {
        mb.mb_type
    });

    // mb_pred: reference indices for whichever lists this type uses, then their
    // vector differences. ref_idx is omitted when the list holds one picture.
    let single = MotionPartition {
        ref_idx_l0: mb.ref_idx_l0,
        ref_idx_l1: mb.ref_idx_l1,
        mvd_l0x: mb.mvd_l0x,
        mvd_l0y: mb.mvd_l0y,
        mvd_l1x: mb.mvd_l1x,
        mvd_l1y: mb.mvd_l1y,
    };
    let parts: &[MotionPartition] = match mb.partitions.as_ref() {
        Some(partitions) => partitions,
        None => std::slice::from_ref(&single),
    };

    for part in parts {
        if part.ref_idx_l0 >= 0 && mb.num_ref_idx_l0_minus1 > 0 {
            write_te(w, part.ref_idx_l0, mb.num_ref_idx_l0_minus1);
        }
    }
    for part in parts {
        if !mb.p_slice && part.ref_idx_l1 >= 0 && mb.num_ref_idx_l1_minus1 > 0 {
            write_te(w, part.ref_idx_l1, mb.num_ref_idx_l1_minus1);
        }
    }
    for part in parts {
        if part.ref_idx_l0 >= 0 {
            w.se(part.mvd_l0x);
            w.se(part.mvd_l0y);
        }
    }
    for part in parts {
        if !mb.p_slice && part.ref_idx_l1 >= 0 {
            w.se(part.mvd_l1x);
            w.se(part.mvd_l1y);
        }
    }

    let mut cbp_luma = 0u32;
    for (i8x8, block) in luma.iter().enumerate() {
        if block.is_some() {
            cbp_luma |= 1 << i8x8;
        }
    }
    // 0 means no chroma coefficients, 1 means DC only, 2 means DC and AC.
    let mut cbp_chroma = 0u32;
    if let Some([cb, cr]) = chroma {
        if cb.any_ac || cr.any_ac {
            cbp_chroma = 2;
        } else if cb.any_dc || cr.any_dc {
            cbp_chroma = 1;
        }
    }
    let cbp = cbp_luma + 16 * cbp_chroma;
    w.ue(CBP_TO_CODE_NUM_INTER[cbp as usize]);

    if cbp_luma > 0 {
        w.flag(true); // transform_size_8x8_flag
    }

    let mut qp_after = mb.prev_qp;
    if cbp != 0 {
        w.se(wrap_qp_delta(mb.qp - mb.prev_qp));
        qp_after = mb.qp;
        if cbp_luma > 0 {
            write_luma_residual_8x8(w, counts, mb, luma, cbp_luma)?;
        } else {
            mark_no_coefficients(counts, mb.mb_x, mb.mb_y);
        }
        write_chroma_residual(w, chroma_counts, mb, chroma, cbp_chroma)?;
    } else {
        mark_no_coefficients(counts, mb.mb_x, mb.mb_y);
        mark_no_chroma_coefficients(chroma_counts, mb.mb_x, mb.mb_y);
    }
    Ok(qp_after)
}

/// Chroma residual: both DC blocks first, then every AC block (clause 7.3.5.3).
/// The DC blocks use the dedicated chroma table, signalled by nC of -1.
fn write_chroma_residual(
    w: &mut BitWriter,
    counts: &mut ChromaCounts,
    mb: &InterMacroblock,
    chroma: Option<&[ChromaBlockLevels; 2]>,
    cbp_chroma: u32,
) -> Result<()> {
    let (Some(chroma), true) = (chroma, cbp_chroma != 0) else {
        mark_no_chroma_coefficients(counts, mb.mb_x, mb.mb_y);
        return Ok(());
    };

    for component in chroma {
        write_residual_levels(w, &component.dc, 4, -1)?;
    }

    for c in 0..2 {
        let map = if c == 0 {
            &mut counts.cb
        } else {
            &mut counts.cr
        };
        for b in 0..4 {
            let bx = mb.mb_x * 2 + (b & 1);
            let by = mb.mb_y * 2 + (b >> 1);
            if cbp_chroma != 2 {
                map.set(bx, by, 0);
                continue;
            }
            let total = write_residual_levels(w, &chroma[c].ac[b], 15, map.n_c(bx, by))?;
            map.set(bx, by, total);
        }
    }
    Ok(())
}

pub fn mark_no_chroma_coefficients(counts: &mut ChromaCounts, mb_x: usize, mb_y: usize) {
    for b in 0..4 {
        let bx = mb_x * 2 + (b & 1);
        let by = mb_y * 2 + (b >> 1);
        counts.cb.set(bx, by, 0);
        counts.cr.set(bx, by, 0);
    }
}

/// Record that a macroblock carries no coefficients, so its blocks contribute
/// nC 0 to their neighbours. Applies to skipped macroblocks and to coded ones
/// whose `coded_block_pattern` is zero.
pub fn mark_no_coefficients(counts: &mut CoeffCountMap, mb_x: usize, mb_y: usize) {
    let bx = mb_x * 4;
    let by = mb_y * 4;
    for y in 0..4 {
        for x in 0..4 {
            counts.set(bx + x, by + y, 0);
        }
    }
}

/// `mb_qp_delta` is confined to -26..25, but the decoder resolves it modulo 52,
/// so a jump larger than that range is expressed by wrapping rather than
/// clamping.
pub fn wrap_qp_delta(delta: i32) -> i32 {
    (delta + 26).rem_euclid(52) - 26
}

/// Write the luma residual with the 8x8 transform under CAVLC.
///
/// CAVLC has no 8x8 residual syntax: clause 7.3.5.3.2 sends an 8x8 block as four
/// interleaved 4x4 blocks, where 4x4 block `i4x4` carries the 8x8 scan positions
/// congruent to `i4x4` modulo 4.
fn write_luma_residual_8x8(
    w: &mut BitWriter,
    counts: &mut CoeffCountMap,
    mb: &InterMacroblock,
    luma: &[Option<&[i32; 64]>; 4],
    cbp_luma: u32,
) -> Result<()> {
    let mut sub = [0i32; 16];
    for i8x8 in 0..4 {
        let block = luma[i8x8];
        for i4x4 in 0..4 {
            let blk_idx = i8x8 * 4 + i4x4;
            let (x, y) = LUMA_4X4_XY[blk_idx];
            let bx = mb.mb_x * 4 + x;
            let by = mb.mb_y * 4 + y;

            let (true, Some(block)) = (cbp_luma & (1 << i8x8) != 0, block) else {
                counts.set(bx, by, 0);
                continue;
            };

            for i in 0..16 {
                sub[i] = block[4 * i + i4x4];
            }
            let total = write_residual_levels(w, &sub, 16, counts.n_c(bx, by))?;
            counts.set(bx, by, total);
        }
    }
    Ok(())
}

/// Reorder an 8x8 block of levels from raster order into the 8x8 zig-zag scan
/// the residual syntax expects. Returns whether any level is non-zero.
pub fn to_zigzag_8x8(raster: &[i32; 64], out: &mut [i32; 64], field_scan: bool) -> bool {
    let mut any = false;
    let scan: &[usize; 64] = if field_scan {
        &FIELD_SCAN_8X8
    } else {
        &ZIGZAG_8X8
    };
    for k in 0..64 {
        let v = raster[scan[k]];
        out[k] = v;
        if v != 0 {
            any = true;
        }
    }
    any
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_scan_serialises_raster_coefficients_in_field_order() {
        let raster: [i32; 64] = std::array::from_fn(|i| i as i32 + 1);
        let mut out = [0i32; 64];
        assert!(to_zigzag_8x8(&raster, &mut out, true));
        let expected: Vec<i32> = FIELD_SCAN_8X8.iter().map(|&p| p as i32 + 1).collect();
        assert_eq!(out.to_vec(), expected);
    }

    #[test]
    fn an_all_zero_block_reports_nothing_to_code() {
        let mut out = [0i32; 64];
        assert!(!to_zigzag_8x8(&[0; 64], &mut out, false));
    }

    #[test]
    fn qp_delta_wraps_rather_than_clamping() {
        // The decoder resolves mb_qp_delta modulo 52, so a jump of 30 is -22.
        assert_eq!(wrap_qp_delta(0), 0);
        assert_eq!(wrap_qp_delta(25), 25);
        assert_eq!(wrap_qp_delta(-26), -26);
        assert_eq!(wrap_qp_delta(30), -22);
        assert_eq!(wrap_qp_delta(-30), 22);
    }

    #[test]
    fn sixteen_by_eight_types_follow_table_7_14() {
        use PredictionMode::{Bi, L0, L1};
        assert_eq!(b16x8_mb_type(L0, L0), 4);
        assert_eq!(b16x8_mb_type(L1, L1), 6);
        assert_eq!(b16x8_mb_type(L0, L1), 8);
        assert_eq!(b16x8_mb_type(L1, L0), 10);
        assert_eq!(b16x8_mb_type(Bi, Bi), 20);
    }

    #[test]
    fn neighbouring_counts_average_only_when_both_exist() {
        let mut counts = CoeffCountMap::new(4, 4);
        assert_eq!(counts.n_c(0, 0), 0, "no neighbours reads as zero");
        counts.set(0, 1, 5);
        assert_eq!(counts.n_c(1, 1), 5, "only the left neighbour");
        counts.set(1, 0, 2);
        assert_eq!(counts.n_c(1, 1), 4, "(5 + 2 + 1) >> 1");
    }

    #[test]
    fn a_coded_but_empty_block_is_not_the_same_as_an_absent_one() {
        let mut counts = CoeffCountMap::new(4, 4);
        counts.set(0, 0, 0);
        assert_eq!(counts.n_c(1, 0), 0);
        counts.set(1, 0, 8);
        assert_eq!(counts.n_c(2, 0), 8, "an absent upper neighbour is skipped");
    }
}
