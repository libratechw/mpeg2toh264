//! H.264 macroblock layer.
//!
//! Every MPEG-2 macroblock becomes an inter macroblock, including intra ones:
//! see [`crate::h264::slice`] for why H.264 intra prediction is avoided
//! nearly everywhere. An intra macroblock is coded as `P_L0_16x16` with a zero
//! motion vector pointing at the flat-prediction reference index, so its
//! prediction is a known constant and its residual is just the block with that
//! constant removed.
//!
//! The exception is the random access point, whose I slices have no reference
//! list to hang that constant on. It uses `I_NxN` and real intra prediction;
//! see [`write_intra_macroblock`].

use crate::error::Result;
use crate::h264::bitwriter::BitWriter;
use crate::h264::cavlc::{write_masked_levels, write_residual_levels};
use crate::h264::cavlc_tables::{CBP_TO_CODE_NUM_INTER, CBP_TO_CODE_NUM_INTRA};
use crate::h264::chroma::ChromaBlockLevels;
use crate::h264::mbaff::Frame;
use crate::h264::params::ZIGZAG_8X8;

/// H.264 Table 8-14: 8x8 field scan for field-coded macroblocks.
pub const FIELD_SCAN_8X8: [usize; 64] = [
    0, 8, 16, 1, 9, 24, 32, 17, 2, 25, 40, 48, 56, 33, 10, 3, 18, 41, 49, 57, 26, 11, 4, 19, 34,
    42, 50, 58, 27, 12, 5, 20, 35, 43, 51, 59, 28, 13, 6, 21, 36, 44, 52, 60, 29, 14, 22, 37, 45,
    53, 61, 30, 7, 15, 38, 46, 54, 62, 23, 31, 39, 47, 55, 63,
];

/// Where each raster position lands in [`FIELD_SCAN_8X8`], for a quantiser
/// that writes only the positions it has something to put in.
pub const INVERSE_FIELD_SCAN_8X8: [u8; 64] = inverse_scan(&FIELD_SCAN_8X8);

/// The same for [`ZIGZAG_8X8`].
pub const INVERSE_ZIGZAG_8X8: [u8; 64] = inverse_scan(&ZIGZAG_8X8);

const fn inverse_scan(scan: &[usize; 64]) -> [u8; 64] {
    let mut inverse = [0u8; 64];
    let mut k = 0;
    while k < 64 {
        inverse[scan[k]] = k as u8;
        k += 1;
    }
    inverse
}

/// Bit `k` set where `levels[k]` is non-zero, for levels made the dense way.
pub fn level_mask(levels: &[i32; 64]) -> u64 {
    let mut mask = 0u64;
    for (k, &level) in levels.iter().enumerate() {
        mask |= u64::from(level != 0) << k;
    }
    mask
}

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

/// TotalCoeff of every 4x4 block of one component, which neighbouring blocks
/// need to derive their nC (clause 9.2.1). -1 marks a block that is not there.
///
/// Blocks are held per macroblock rather than by position, because which
/// macroblock holds the block above another is [`Frame`]'s answer once a
/// picture mixes frame and field pairs.
pub struct CoeffCountMap {
    counts: Vec<i16>,
    /// 4x4 blocks across a macroblock: four for luma, two for chroma.
    across: usize,
}

impl CoeffCountMap {
    pub fn new(macroblocks: usize, across: usize) -> Self {
        Self {
            counts: vec![-1; macroblocks * across * across],
            across,
        }
    }

    pub fn reset(&mut self) {
        self.counts.fill(-1);
    }

    pub fn set(&mut self, address: usize, bx: usize, by: usize, total: usize) {
        let across = self.across;
        self.counts[address * across * across + by * across + bx] = total as i16;
    }

    /// The count of the block holding a sample location, or -1 where there is
    /// no such block.
    fn at(&self, frame: &Frame, address: usize, x: i32, y: i32) -> i32 {
        let size = self.across as i32 * 4;
        let Some(found) = frame.neighbour(address, x, y, size, size) else {
            return -1;
        };
        let across = self.across;
        self.counts[found.address * across * across + (found.y / 4) * across + found.x / 4] as i32
    }

    /// The count of one of the current macroblock's own blocks.
    #[inline]
    fn own(&self, address: usize, bx: usize, by: usize) -> i32 {
        let across = self.across;
        self.counts[address * across * across + by * across + bx] as i32
    }

    /// What the blocks along the macroblock's left and upper edges see across
    /// them, worked out once: every other block's neighbours are inside the
    /// macroblock, where no derivation is needed at all.
    ///
    /// The blocks above all lie in one macroblock, on one row of it, so that
    /// side is a single question; the left side is asked row by row, because
    /// a field pair beside a frame macroblock answers it differently for even
    /// and odd lines.
    pub fn edges(&self, frame: &Frame, address: usize) -> EdgeCounts {
        let across = self.across;
        let size = across as i32 * 4;
        let mut edges = EdgeCounts {
            left: [-1; 4],
            above: [-1; 4],
        };
        for (by, left) in edges.left.iter_mut().enumerate().take(across) {
            *left = self.at(frame, address, -1, by as i32 * 4);
        }
        if let Some(found) = frame.neighbour(address, 0, -1, size, size) {
            for (bx, above) in edges.above.iter_mut().enumerate().take(across) {
                *above = self.own(found.address, bx, found.y / 4);
            }
        }
        edges
    }

    /// nC from the left and upper neighbours. A block that was coded but carries
    /// no coefficients counts as 0, which is different from being unavailable.
    #[inline]
    pub fn n_c(&self, edges: &EdgeCounts, address: usize, bx: usize, by: usize) -> i32 {
        let a = if bx > 0 {
            self.own(address, bx - 1, by)
        } else {
            edges.left[by]
        };
        let b = if by > 0 {
            self.own(address, bx, by - 1)
        } else {
            edges.above[bx]
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

/// The counts just outside a macroblock, indexed by the row (left) or column
/// (above) of the edge block asking. -1 where there is no block there.
pub struct EdgeCounts {
    left: [i32; 4],
    above: [i32; 4],
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
            cb: CoeffCountMap::new(mb_width * mb_height, 2),
            cr: CoeffCountMap::new(mb_width * mb_height, 2),
        }
    }

    pub fn reset(&mut self) {
        self.cb.reset();
        self.cr.reset();
    }
}

/// Luma is a 4x4 grid of 4x4 blocks per macroblock.
pub fn make_luma_counts(mb_width: usize, mb_height: usize) -> CoeffCountMap {
    CoeffCountMap::new(mb_width * mb_height, 4)
}

#[derive(Clone, Debug)]
pub struct InterMacroblock {
    /// Where the macroblock is, in decoding order.
    pub address: usize,
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

/// Write one macroblock. Returns the QP in effect afterwards, which is the
/// macroblock's own QP only if it actually carried a `mb_qp_delta`.
///
/// `luma` holds the four 8x8 blocks of coefficient levels in 8x8 zig-zag scan
/// order, or `None` where a block has no coefficients at all, and `luma_masks`
/// says which positions of each are non-zero -- nothing else in a block is
/// read, so the rest need not have been written; `chroma` is `None` to leave
/// chroma at the prediction.
#[allow(clippy::too_many_arguments)]
pub fn write_inter_macroblock(
    w: &mut BitWriter,
    counts: &mut CoeffCountMap,
    chroma_counts: &mut ChromaCounts,
    frame: &Frame,
    mb: &InterMacroblock,
    luma: &[Option<&[i32; 64]>; 4],
    luma_masks: &[u64; 4],
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
            write_luma_residual_8x8(w, counts, frame, mb.address, luma, luma_masks, cbp_luma)?;
        } else {
            mark_no_coefficients(counts, mb.address);
        }
        write_chroma_residual(w, chroma_counts, frame, mb.address, chroma, cbp_chroma)?;
    } else {
        mark_no_coefficients(counts, mb.address);
        mark_no_chroma_coefficients(chroma_counts, mb.address);
    }
    Ok(qp_after)
}

/// Write an `I_NxN` macroblock whose four 8x8 blocks and chroma all predict in
/// DC mode.
///
/// DC is the only mode used, so the predicted mode is DC as well -- a
/// neighbouring block that is missing counts as DC, and every one that is there
/// is DC -- and `prev_intra8x8_pred_mode_flag` is set for all four blocks
/// without ever having to send a mode.
///
/// Everything from `coded_block_pattern` onwards is what an inter macroblock
/// writes, apart from the intra ordering of the pattern's codewords.
#[allow(clippy::too_many_arguments)]
pub fn write_intra_macroblock(
    w: &mut BitWriter,
    counts: &mut CoeffCountMap,
    chroma_counts: &mut ChromaCounts,
    frame: &Frame,
    address: usize,
    qp: i32,
    prev_qp: i32,
    luma: &[Option<&[i32; 64]>; 4],
    luma_masks: &[u64; 4],
    chroma: Option<&[ChromaBlockLevels; 2]>,
) -> Result<IntraMacroblock> {
    w.ue(0); // mb_type: I_NxN
             // For I_NxN this comes before the prediction modes rather than after the
             // coded block pattern, and it is not repeated (clause 7.3.5).
    w.flag(true); // transform_size_8x8_flag
    for _ in 0..4 {
        w.flag(true); // prev_intra8x8_pred_mode_flag
    }
    w.ue(0); // intra_chroma_pred_mode: DC

    let mut cbp_luma = 0u32;
    for (i8x8, block) in luma.iter().enumerate() {
        if block.is_some() {
            cbp_luma |= 1 << i8x8;
        }
    }
    let mut cbp_chroma = 0u32;
    if let Some([cb, cr]) = chroma {
        if cb.any_ac || cr.any_ac {
            cbp_chroma = 2;
        } else if cb.any_dc || cr.any_dc {
            cbp_chroma = 1;
        }
    }
    let cbp = cbp_luma + 16 * cbp_chroma;
    w.ue(CBP_TO_CODE_NUM_INTRA[cbp as usize]);

    let mut qp_after = prev_qp;
    if cbp != 0 {
        w.se(wrap_qp_delta(qp - prev_qp));
        qp_after = qp;
        if cbp_luma > 0 {
            write_luma_residual_8x8(w, counts, frame, address, luma, luma_masks, cbp_luma)?;
        } else {
            mark_no_coefficients(counts, address);
        }
        write_chroma_residual(w, chroma_counts, frame, address, chroma, cbp_chroma)?;
    } else {
        mark_no_coefficients(counts, address);
        mark_no_chroma_coefficients(chroma_counts, address);
    }
    Ok(IntraMacroblock {
        qp: qp_after,
        cbp_luma,
        cbp_chroma,
    })
}

/// What an intra macroblock ended up sending, which is what the reconstruction
/// it has to be predicted from is built out of. A block whose bit is clear
/// carries no residual at all, and with `cbp_chroma` below 2 the chroma AC
/// levels were not written whatever the conversion produced.
pub struct IntraMacroblock {
    /// QP in force after the macroblock, which is the one before it when
    /// nothing was coded and `mb_qp_delta` never appeared.
    pub qp: i32,
    pub cbp_luma: u32,
    pub cbp_chroma: u32,
}

/// Chroma residual: both DC blocks first, then every AC block (clause 7.3.5.3).
/// The DC blocks use the dedicated chroma table, signalled by nC of -1.
fn write_chroma_residual(
    w: &mut BitWriter,
    counts: &mut ChromaCounts,
    frame: &Frame,
    address: usize,
    chroma: Option<&[ChromaBlockLevels; 2]>,
    cbp_chroma: u32,
) -> Result<()> {
    let (Some(chroma), true) = (chroma, cbp_chroma != 0) else {
        mark_no_chroma_coefficients(counts, address);
        return Ok(());
    };

    for component in chroma {
        write_residual_levels(w, &component.dc, -1)?;
    }

    for c in 0..2 {
        let map = if c == 0 {
            &mut counts.cb
        } else {
            &mut counts.cr
        };
        if cbp_chroma != 2 {
            for b in 0..4 {
                map.set(address, b & 1, b >> 1, 0);
            }
            continue;
        }
        let edges = map.edges(frame, address);
        for b in 0..4 {
            let (bx, by) = (b & 1, b >> 1);
            let total =
                write_residual_levels(w, &chroma[c].ac[b], map.n_c(&edges, address, bx, by))?;
            map.set(address, bx, by, total);
        }
    }
    Ok(())
}

pub fn mark_no_chroma_coefficients(counts: &mut ChromaCounts, address: usize) {
    for b in 0..4 {
        let (bx, by) = (b & 1, b >> 1);
        counts.cb.set(address, bx, by, 0);
        counts.cr.set(address, bx, by, 0);
    }
}

/// Record that a macroblock carries no coefficients, so its blocks contribute
/// nC 0 to their neighbours. Applies to skipped macroblocks and to coded ones
/// whose `coded_block_pattern` is zero.
pub fn mark_no_coefficients(counts: &mut CoeffCountMap, address: usize) {
    for y in 0..4 {
        for x in 0..4 {
            counts.set(address, x, y, 0);
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
    frame: &Frame,
    address: usize,
    luma: &[Option<&[i32; 64]>; 4],
    luma_masks: &[u64; 4],
    cbp_luma: u32,
) -> Result<()> {
    let mut sub = [0i32; 16];
    let edges = counts.edges(frame, address);
    for i8x8 in 0..4 {
        let block = luma[i8x8];
        for i4x4 in 0..4 {
            let blk_idx = i8x8 * 4 + i4x4;
            let (bx, by) = LUMA_4X4_XY[blk_idx];

            let (true, Some(block)) = (cbp_luma & (1 << i8x8) != 0, block) else {
                counts.set(address, bx, by, 0);
                continue;
            };

            // The non-zero levels among every fourth position from `i4x4`.
            // Only those are gathered, and only those are read back: the
            // writer takes the same mask.
            let mut rest = luma_masks[i8x8] & (0x1111_1111_1111_1111u64 << i4x4);
            let mut mask = 0u32;
            while rest != 0 {
                let position = rest.trailing_zeros() as usize & 63;
                rest &= rest - 1;
                let i = position >> 2;
                sub[i] = block[position];
                mask |= 1 << i;
            }
            let total = write_masked_levels(w, &sub, mask, counts.n_c(&edges, address, bx, by))?;
            counts.set(address, bx, by, total);
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

    /// Table 8-14 as the column and row it names, which is how the standard
    /// prints it. Stating the table a second way is the point: comparing it with
    /// itself, as the test above has to, says nothing about whether it is right.
    #[test]
    fn field_scan_visits_the_positions_table_8_14_names() {
        #[rustfmt::skip]
        let coordinates: [(usize, usize); 64] = [
            (0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (0, 3), (0, 4), (1, 2),
            (2, 0), (1, 3), (0, 5), (0, 6), (0, 7), (1, 4), (2, 1), (3, 0),
            (2, 2), (1, 5), (1, 6), (1, 7), (2, 3), (3, 1), (4, 0), (3, 2),
            (2, 4), (2, 5), (2, 6), (2, 7), (3, 3), (4, 1), (5, 0), (4, 2),
            (3, 4), (3, 5), (3, 6), (3, 7), (4, 3), (5, 1), (6, 0), (5, 2),
            (4, 4), (4, 5), (4, 6), (4, 7), (5, 3), (6, 1), (6, 2), (5, 4),
            (5, 5), (5, 6), (5, 7), (6, 3), (7, 0), (7, 1), (6, 4), (6, 5),
            (6, 6), (6, 7), (7, 2), (7, 3), (7, 4), (7, 5), (7, 6), (7, 7),
        ];
        let expected: Vec<usize> = coordinates.iter().map(|&(x, y)| y * 8 + x).collect();
        assert_eq!(FIELD_SCAN_8X8.to_vec(), expected);

        let mut seen = [false; 64];
        for &p in &FIELD_SCAN_8X8 {
            assert!(!seen[p], "position {p} is scanned twice");
            seen[p] = true;
        }
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

    /// nC as the writer derives it: the edges once, then the block.
    fn n_c(counts: &CoeffCountMap, frame: &Frame, at: usize, bx: usize, by: usize) -> i32 {
        counts.n_c(&counts.edges(frame, at), at, bx, by)
    }

    #[test]
    fn neighbouring_counts_average_only_when_both_exist() {
        let frame = Frame::new(4, 4, false);
        let mut counts = make_luma_counts(4, 4);
        let at = frame.address(1, 1);
        assert_eq!(
            n_c(&counts, &frame, frame.address(0, 0), 0, 0),
            0,
            "no neighbours reads as zero"
        );
        counts.set(frame.address(0, 1), 3, 0, 5);
        assert_eq!(n_c(&counts, &frame, at, 0, 0), 5, "only the left neighbour");
        counts.set(frame.address(1, 0), 0, 3, 2);
        assert_eq!(n_c(&counts, &frame, at, 0, 0), 4, "(5 + 2 + 1) >> 1");
    }

    #[test]
    fn a_coded_but_empty_block_is_not_the_same_as_an_absent_one() {
        let frame = Frame::new(4, 4, false);
        let mut counts = make_luma_counts(4, 4);
        let at = frame.address(1, 0);
        counts.set(frame.address(0, 0), 3, 0, 0);
        assert_eq!(n_c(&counts, &frame, at, 0, 0), 0);
        counts.set(at, 0, 0, 8);
        assert_eq!(
            n_c(&counts, &frame, at, 1, 0),
            8,
            "an absent upper neighbour is skipped"
        );
    }

    #[test]
    fn edges_read_a_field_pair_beside_a_frame_macroblock_row_by_row() {
        // The pair to the left is field coded: even lines of the current frame
        // macroblock come from its top macroblock, odd lines from its bottom,
        // both at half the row. Block rows 0..4 start at lines 0, 4, 8, 12,
        // all even, so the left edge reads the top field macroblock at block
        // rows 0, 0, 1, 1.
        let mut frame = Frame::new(4, 4, true);
        frame.set_field_pair(frame.address(0, 0), true);
        let mut counts = make_luma_counts(4, 4);
        let top = frame.address(0, 0);
        for by in 0..4 {
            counts.set(top, 3, by, 10 + by);
        }
        let at = frame.address(1, 0);
        let edges = counts.edges(&frame, at);
        assert_eq!(edges.left, [10, 10, 11, 11]);
        assert_eq!(edges.above, [-1; 4], "nothing above the first row");
    }
}
