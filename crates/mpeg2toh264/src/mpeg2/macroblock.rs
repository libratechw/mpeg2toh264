//! MPEG-2 macroblock layer decoding.
//!
//! Coefficients come out as quantised levels, not pixels: this transcoder maps
//! levels straight into H.264 syntax, so nothing here dequantises, inverse
//! transforms, or motion compensates. Motion vectors are reconstructed because
//! the H.264 side needs their actual values.

use std::sync::LazyLock;

use crate::bitreader::BitReader;
use crate::error::{bail, Result};
use crate::mpeg2::constants::{
    mb_flag, PictureStructure, PictureType, ALTERNATE_SCAN, ZIGZAG_SCAN,
};
use crate::mpeg2::headers::{Picture, Slice};
use crate::mpeg2::vlc::VlcTable;
use crate::mpeg2::vlc_tables::{
    CODED_BLOCK_PATTERN, DCT_COEFF_TABLE0, DCT_COEFF_TABLE1, DCT_DC_SIZE_CHROMA, DCT_DC_SIZE_LUMA,
    DMVECTOR, EOB, ESCAPE, MB_ADDR_ESCAPE, MB_ADDR_INCREMENT, MB_TYPE_B, MB_TYPE_I, MB_TYPE_P,
    MOTION_CODE,
};

static V_MB_ADDR: LazyLock<VlcTable> =
    LazyLock::new(|| VlcTable::new("macroblock_address_increment", MB_ADDR_INCREMENT));
static V_MB_TYPE_I: LazyLock<VlcTable> =
    LazyLock::new(|| VlcTable::new("macroblock_type(I)", MB_TYPE_I));
static V_MB_TYPE_P: LazyLock<VlcTable> =
    LazyLock::new(|| VlcTable::new("macroblock_type(P)", MB_TYPE_P));
static V_MB_TYPE_B: LazyLock<VlcTable> =
    LazyLock::new(|| VlcTable::new("macroblock_type(B)", MB_TYPE_B));
static V_CBP: LazyLock<VlcTable> =
    LazyLock::new(|| VlcTable::new("coded_block_pattern", CODED_BLOCK_PATTERN));
static V_MOTION: LazyLock<VlcTable> = LazyLock::new(|| VlcTable::new("motion_code", MOTION_CODE));
static V_DMV: LazyLock<VlcTable> = LazyLock::new(|| VlcTable::new("dmvector", DMVECTOR));
static V_DC_LUMA: LazyLock<VlcTable> =
    LazyLock::new(|| VlcTable::new("dct_dc_size_luminance", DCT_DC_SIZE_LUMA));
static V_DC_CHROMA: LazyLock<VlcTable> =
    LazyLock::new(|| VlcTable::new("dct_dc_size_chrominance", DCT_DC_SIZE_CHROMA));
static V_COEFF0: LazyLock<VlcTable> =
    LazyLock::new(|| VlcTable::new("dct_coefficients_0", DCT_COEFF_TABLE0));
static V_COEFF1: LazyLock<VlcTable> =
    LazyLock::new(|| VlcTable::new("dct_coefficients_1", DCT_COEFF_TABLE1));

/// `frame_motion_type` / `field_motion_type` values (Tables 6-17, 6-18).
pub mod motion_type {
    pub const NONE: i32 = 0;
    pub const FIELD: i32 = 1;
    /// Frame-based in frame pictures; 16x8 MC in field pictures.
    pub const FRAME_OR_16X8: i32 = 2;
    pub const DUAL_PRIME: i32 = 3;
}

#[derive(Clone)]
pub struct Macroblock {
    /// Macroblock address within the picture, in raster order.
    pub address: usize,
    /// True for macroblocks covered by `macroblock_address_increment` but not coded.
    pub skipped: bool,
    /// Bit set of [`mb_flag`].
    pub flags: i32,
    pub quantiser_scale_code: u32,
    /// `frame_motion_type` or `field_motion_type`; 0 when the macroblock has no motion.
    pub motion_type: i32,
    /// 0 = frame DCT, 1 = field DCT.
    pub dct_type: u32,
    /// `coded_block_pattern`; for intra macroblocks all blocks are coded.
    pub cbp: i32,
    /// Reconstructed motion vectors in half-pel units, indexed
    /// `[r * 4 + s * 2 + t]` with r the vector index, s = 0 forward / 1
    /// backward, t = 0 horizontal / 1 vertical.
    pub mv: [i32; 8],
    /// Dual-prime differential vector, whose two components are each -1, 0,
    /// or +1 (H.262 7.6.3.6).
    pub dmvector: [i32; 2],
    /// `motion_vertical_field_select`, indexed `[r * 2 + s]`.
    pub field_select: [u8; 4],
    /// How many of the two vector slots are in use.
    pub mv_count: usize,
    /// Six 8x8 blocks of quantised levels in raster order.
    blocks: [[i16; 64]; 6],
    /// Bit `i` is set when block `i` carries decoded levels.
    coded_blocks: u8,
}

impl Macroblock {
    /// Levels of one 8x8 block, or `None` where the source did not code it.
    #[inline]
    pub fn block(&self, index: usize) -> Option<&[i16; 64]> {
        if self.coded_blocks & (1 << index) != 0 {
            Some(&self.blocks[index])
        } else {
            None
        }
    }

    #[inline]
    pub fn is_intra(&self) -> bool {
        self.flags & mb_flag::INTRA != 0
    }

    fn empty() -> Self {
        Self {
            address: 0,
            skipped: false,
            flags: 0,
            quantiser_scale_code: 0,
            motion_type: motion_type::NONE,
            dct_type: 0,
            cbp: 0,
            mv: [0; 8],
            dmvector: [0; 2],
            field_select: [0; 4],
            mv_count: 1,
            blocks: [[0; 64]; 6],
            coded_blocks: 0,
        }
    }

    /// Reset the header fields to decode a fresh macroblock into this cell.
    ///
    /// The six blocks keep whatever the previous picture left in them. Nothing
    /// reads a block `coded_blocks` does not name, and clearing all six is 768
    /// bytes the browser build writes by hand.
    fn begin(&mut self, address: usize, quantiser_scale_code: u32) {
        self.address = address;
        self.skipped = false;
        self.flags = 0;
        self.quantiser_scale_code = quantiser_scale_code;
        self.motion_type = motion_type::NONE;
        self.dct_type = 0;
        self.cbp = 0;
        self.mv = [0; 8];
        self.dmvector = [0; 2];
        self.field_select = [0; 4];
        self.mv_count = 1;
        self.coded_blocks = 0;
    }
}

/// One picture's macroblocks, indexed by raster macroblock address.
///
/// The cells outlive the picture they were decoded for. A macroblock is 848
/// bytes and an HD picture has six thousand of them, so both handing the array
/// back to the allocator and emptying it cell by cell cost more than the
/// decoding does -- in the browser build, where a move is a library call, far
/// more. Instead the grid keeps its storage, marks every cell absent, and hands
/// out `&mut` cells for the decoder to write through.
pub struct MacroblockGrid {
    cells: Vec<Macroblock>,
    /// Whether the cell at the same index was decoded for the current picture.
    present: Vec<bool>,
    /// Where a macroblock whose address falls outside the picture is decoded.
    /// Its contents are never read.
    outside: Macroblock,
}

impl MacroblockGrid {
    pub fn new() -> Self {
        Self {
            cells: Vec::new(),
            present: Vec::new(),
            outside: Macroblock::empty(),
        }
    }

    /// Start a picture of `cells` macroblocks, all of them absent.
    pub fn reset(&mut self, cells: usize) {
        if self.cells.len() != cells {
            self.cells.resize_with(cells, Macroblock::empty);
            self.present.resize(cells, false);
        }
        self.present.fill(false);
    }

    /// The macroblock at `address`, or `None` where this picture did not code one.
    #[inline]
    pub fn get(&self, address: usize) -> Option<&Macroblock> {
        if *self.present.get(address)? {
            Some(&self.cells[address])
        } else {
            None
        }
    }

    /// The cell to decode `address` into.
    #[inline]
    fn slot(&mut self, address: usize) -> &mut Macroblock {
        self.cells.get_mut(address).unwrap_or(&mut self.outside)
    }

    /// Publish a cell `slot` has just been decoded into.
    #[inline]
    fn mark(&mut self, address: usize) {
        if let Some(present) = self.present.get_mut(address) {
            *present = true;
        }
    }
}

impl Default for MacroblockGrid {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-slice decoder state that persists across macroblocks.
struct SliceState {
    quantiser_scale_code: u32,
    /// DC predictors for Y, Cb, Cr.
    dc_pred: [i32; 3],
    /// Value the DC predictors reset to, from `intra_dc_precision`.
    dc_pred_reset: i32,
    /// Motion vector predictors, same indexing as [`Macroblock::mv`].
    pmv: [i32; 8],
    /// Previous macroblock's direction flags, which skipped B macroblocks reuse.
    prev_flags: Option<i32>,
}

fn signed_dc_differential(r: &mut BitReader<'_>, size: u32) -> i32 {
    if size == 0 {
        return 0;
    }
    let v = r.u(size) as i32;
    // A leading zero means the value is negative; sign-extend from `size` bits.
    if v & (1 << (size - 1)) != 0 {
        v
    } else {
        v - (1 << size) + 1
    }
}

/// Derived from the motion type: how many vectors, in which format, and whether
/// a dmvector follows (Tables 6-17 and 6-18).
struct MotionSpec {
    count: usize,
    field_format: bool,
    dmv: bool,
}

fn motion_spec(picture_structure: PictureStructure, motion: i32) -> MotionSpec {
    let frame = picture_structure == PictureStructure::Frame;
    if motion == motion_type::DUAL_PRIME {
        return MotionSpec {
            count: 1,
            field_format: true,
            dmv: true,
        };
    }
    if frame {
        // Frame picture: 1 = two field vectors, 2 = one frame vector.
        return if motion == motion_type::FIELD {
            MotionSpec {
                count: 2,
                field_format: true,
                dmv: false,
            }
        } else {
            MotionSpec {
                count: 1,
                field_format: false,
                dmv: false,
            }
        };
    }
    // Field picture: 1 = one field vector, 2 = 16x8 (two vectors).
    if motion == motion_type::FIELD {
        MotionSpec {
            count: 1,
            field_format: true,
            dmv: false,
        }
    } else {
        MotionSpec {
            count: 2,
            field_format: true,
            dmv: false,
        }
    }
}

/// Decode one motion vector component and update its predictor (clause 7.6.3.1).
/// `f_code` selects the residual width and the wrap-around range.
///
/// `field_vertical_in_frame` is true for the vertical component of a field
/// motion vector in a frame picture. Such a vector counts in field lines while
/// the predictor is kept in frame lines, so the predictor is halved on the way
/// in and doubled on the way out.
fn decode_motion_component(
    r: &mut BitReader<'_>,
    f_code: u32,
    pmv: &mut [i32; 8],
    pmv_index: usize,
    field_vertical_in_frame: bool,
) -> Result<i32> {
    let code = V_MOTION.decode(r)?;
    let r_size = f_code.saturating_sub(1);
    let f = 1i32 << r_size;
    let delta = if f == 1 || code == 0 {
        code
    } else {
        let residual = r.u(r_size) as i32;
        let magnitude = (code.abs() - 1) * f + residual + 1;
        if code < 0 {
            -magnitude
        } else {
            magnitude
        }
    };
    let high = 16 * f - 1;
    let low = -16 * f;
    let range = 32 * f;
    // DIV is division rounding toward minus infinity, which an arithmetic shift
    // gives directly.
    let prediction = if field_vertical_in_frame {
        pmv[pmv_index] >> 1
    } else {
        pmv[pmv_index]
    };
    let mut vector = prediction + delta;
    if vector < low {
        vector += range;
    } else if vector > high {
        vector -= range;
    }
    pmv[pmv_index] = if field_vertical_in_frame {
        vector * 2
    } else {
        vector
    };
    Ok(vector)
}

fn mirror_single_vector_predictors(pmv: &mut [i32; 8], forward: bool, backward: bool) {
    if forward {
        pmv[4] = pmv[0];
        pmv[5] = pmv[1];
    }
    if backward {
        pmv[6] = pmv[2];
        pmv[7] = pmv[3];
    }
}

/// Decode the block layer: run/level pairs into an 8x8 array of levels.
fn decode_block(
    r: &mut BitReader<'_>,
    pic: &Picture,
    state: &mut SliceState,
    block_index: usize,
    intra: bool,
    out: &mut [i16; 64],
) -> Result<()> {
    out.fill(0);
    let scan: &[usize; 64] = if pic.coding.alternate_scan {
        &ALTERNATE_SCAN
    } else {
        &ZIGZAG_SCAN
    };
    // Intra blocks use Table B.15 when intra_vlc_format is set; everything else
    // uses Table B.14.
    let table: &VlcTable = if intra && pic.coding.intra_vlc_format == 1 {
        &V_COEFF1
    } else {
        &V_COEFF0
    };
    let mut n: usize;

    if intra {
        let is_luma = block_index < 4;
        let size = if is_luma {
            V_DC_LUMA.decode(r)?
        } else {
            V_DC_CHROMA.decode(r)?
        } as u32;
        let component = if is_luma { 0 } else { block_index - 3 }; // 0 = Y, 1 = Cb, 2 = Cr
        state.dc_pred[component] += signed_dc_differential(r, size);
        out[0] = state.dc_pred[component] as i16;
        n = 1;
    } else {
        // The first coefficient of a non-intra block uses the one-bit code '1'
        // for (run 0, level 1); Table B.14's '11' form applies only from the
        // second coefficient onwards.
        if r.peek(1) == 1 {
            r.skip(1);
            out[scan[0]] = if r.flag() { -1 } else { 1 };
            n = 1;
        } else {
            n = 0;
        }
    }

    loop {
        let sym = table.decode(r)?;
        if sym == EOB {
            break;
        }
        let (run, level) = if sym == ESCAPE {
            let run = r.u(6) as usize;
            let raw = r.u(12) as i32;
            (run, if raw >= 2048 { raw - 4096 } else { raw })
        } else {
            let run = (sym >> 8) as usize;
            let mut level = sym & 0xff;
            if r.flag() {
                level = -level;
            }
            (run, level)
        };
        n += run;
        if n > 63 {
            bail!("coefficient index {n} out of range at bit {}", r.bit_pos());
        }
        out[scan[n]] = level as i16;
        n += 1;
    }
    Ok(())
}

/// Decode every macroblock of one slice into `grid`, which is indexed by raster
/// macroblock address across the whole picture.
pub fn decode_slice(
    r: &mut BitReader<'_>,
    pic: &Picture,
    slice: &Slice,
    mb_width: usize,
    grid: &mut MacroblockGrid,
) -> Result<()> {
    r.set_bit_pos(slice.data_start_bit);

    // DC predictors reset to the midpoint for the picture's DC precision.
    let dc_pred_reset = 1 << (7 + pic.coding.intra_dc_precision);
    let mut state = SliceState {
        quantiser_scale_code: slice.quantiser_scale_code,
        dc_pred: [dc_pred_reset; 3],
        dc_pred_reset,
        pmv: [0; 8],
        prev_flags: None,
    };

    let picture_type = pic.header.picture_coding_type;
    let frame = pic.coding.picture_structure == PictureStructure::Frame;
    // slice_vertical_position is 1-based and names the macroblock row.
    let mut address = (slice.vertical_position as isize - 1) * mb_width as isize - 1;

    // Clause 6.2.4: macroblocks continue until 23 zero bits appear at the
    // current position. decode_or_zero_stuffing folds that check into the first
    // address VLC lookup, avoiding two reads from every normal boundary.
    loop {
        let mut increment = 0i32;
        let Some(mut sym) = V_MB_ADDR.decode_or_zero_stuffing(r)? else {
            break;
        };
        loop {
            if sym == MB_ADDR_ESCAPE {
                increment += 33;
                sym = V_MB_ADDR.decode(r)?;
                continue;
            }
            increment += sym;
            break;
        }

        // Everything between the previous macroblock and this one is skipped.
        for _ in 1..increment {
            address += 1;
            let at = address as usize;
            make_skipped(grid.slot(at), at, &mut state, picture_type, frame);
            grid.mark(at);
        }
        address += 1;

        let at = address as usize;
        let mb = grid.slot(at);
        decode_macroblock(r, pic, &mut state, at, frame, mb)?;
        state.prev_flags = Some(mb.flags);
        grid.mark(at);
    }

    Ok(())
}

/// A skipped macroblock. In P pictures it is a zero-vector copy and resets the
/// predictors; in B pictures it repeats the previous macroblock's prediction, so
/// the predictors carry over untouched (clause 7.6.6).
fn make_skipped(
    skipped: &mut Macroblock,
    address: usize,
    state: &mut SliceState,
    picture_type: PictureType,
    frame_picture: bool,
) {
    skipped.begin(address, state.quantiser_scale_code);
    skipped.skipped = true;

    if picture_type == PictureType::P {
        state.pmv.fill(0);
    } else if let Some(prev_flags) = state.prev_flags {
        skipped.flags = prev_flags & (mb_flag::MOTION_FORWARD | mb_flag::MOTION_BACKWARD);
        if frame_picture {
            // H.262 7.6.6.4: a skipped B macroblock in a frame picture is always
            // frame-based. Its direction comes from the previous macroblock,
            // while its vectors come directly from the corresponding PMV[0]
            // predictors.
            skipped.motion_type = motion_type::FRAME_OR_16X8;
            for direction in 0..2 {
                let direction_flag = if direction == 0 {
                    mb_flag::MOTION_FORWARD
                } else {
                    mb_flag::MOTION_BACKWARD
                };
                if skipped.flags & direction_flag == 0 {
                    continue;
                }
                let base = direction * 2;
                skipped.mv[base] = state.pmv[base];
                skipped.mv[base + 1] = state.pmv[base + 1];
            }
        } else {
            // Field pictures use same-parity field prediction (7.6.6.3). Keep
            // the decoded predictor values here; field pictures are rejected
            // later by this transcoder, but the elementary-stream decoder
            // remains coherent.
            skipped.motion_type = motion_type::FIELD;
            skipped.mv[..4].copy_from_slice(&state.pmv[..4]);
        }
    }
    // A skipped macroblock has no coded blocks, so the DC predictors reset.
    state.dc_pred = [state.dc_pred_reset; 3];
}

fn decode_macroblock(
    r: &mut BitReader<'_>,
    pic: &Picture,
    state: &mut SliceState,
    address: usize,
    frame: bool,
    mb: &mut Macroblock,
) -> Result<()> {
    let picture_type = pic.header.picture_coding_type;
    let type_table: &VlcTable = match picture_type {
        PictureType::I => &V_MB_TYPE_I,
        PictureType::P => &V_MB_TYPE_P,
        _ => &V_MB_TYPE_B,
    };
    let flags = type_table.decode(r)?;
    let intra = flags & mb_flag::INTRA != 0;
    let has_motion = flags & (mb_flag::MOTION_FORWARD | mb_flag::MOTION_BACKWARD) != 0;
    let conceal = pic.coding.concealment_motion_vectors;

    let mut motion = motion_type::NONE;
    if has_motion || (intra && conceal) {
        motion = if frame {
            // Not transmitted when frame_pred_frame_dct is set: inferred as
            // frame-based.
            if pic.coding.frame_pred_frame_dct {
                motion_type::FRAME_OR_16X8
            } else {
                r.u(2) as i32
            }
        } else {
            r.u(2) as i32
        };
    }

    let mut dct_type = 0;
    if frame && !pic.coding.frame_pred_frame_dct && (intra || flags & mb_flag::PATTERN != 0) {
        dct_type = r.u(1);
    }

    if flags & mb_flag::QUANT != 0 {
        state.quantiser_scale_code = r.u(5);
    }

    let mut mv = [0i32; 8];
    let mut dmvector = [0i32; 2];
    let mut field_select = [0u8; 4];
    let mut mv_count = 1usize;

    // Intra macroblocks reset the predictors unless they carry concealment vectors.
    if intra && !conceal {
        state.pmv.fill(0);
    }
    // A P macroblock with no forward vector predicts from zero (clause 7.6.3.4).
    if picture_type == PictureType::P && flags & mb_flag::MOTION_FORWARD == 0 && !intra {
        state.pmv.fill(0);
    }

    let read_forward = flags & mb_flag::MOTION_FORWARD != 0 || (intra && conceal);
    let read_backward = flags & mb_flag::MOTION_BACKWARD != 0;
    for s in 0..2 {
        if (s == 0 && !read_forward) || (s == 1 && !read_backward) {
            continue;
        }
        let spec = motion_spec(pic.coding.picture_structure, motion);
        mv_count = spec.count;
        let f_code_h = pic.coding.f_code[s][0];
        let f_code_v = pic.coding.f_code[s][1];
        for vec in 0..spec.count {
            // motion_vertical_field_select is sent for both vectors when there
            // are two, and for a lone field-format vector unless it is dual-prime.
            if spec.count == 2 || (spec.field_format && !spec.dmv) {
                field_select[vec * 2 + s] = r.u(1) as u8;
            }
            let base = vec * 4 + s * 2;
            let field_vertical_in_frame = spec.field_format && frame;
            mv[base] = decode_motion_component(r, f_code_h, &mut state.pmv, base, false)?;
            if spec.dmv {
                dmvector[0] = V_DMV.decode(r)?;
            }
            mv[base + 1] = decode_motion_component(
                r,
                f_code_v,
                &mut state.pmv,
                base + 1,
                field_vertical_in_frame,
            )?;
            if spec.dmv {
                dmvector[1] = V_DMV.decode(r)?;
            }
        }
    }
    if intra && conceal {
        r.skip(1); // marker_bit
    }

    if motion_spec(pic.coding.picture_structure, motion).count == 1 {
        // H.262 Table 7-23: every one-vector mode updates both r predictors.
        // This includes frame motion in a frame picture and field motion in a
        // field picture. Without the latter copy, a following 16x8 macroblock
        // reconstructs its second vector from stale PMV[1] state.
        mirror_single_vector_predictors(&mut state.pmv, read_forward, read_backward);
    }

    let mut cbp = 0;
    if flags & mb_flag::PATTERN != 0 {
        cbp = V_CBP.decode(r)?;
    }

    mb.begin(address, state.quantiser_scale_code);
    mb.flags = flags;
    mb.motion_type = motion;
    mb.dct_type = dct_type;
    mb.cbp = if intra { 0x3f } else { cbp };
    mb.mv = mv;
    mb.dmvector = dmvector;
    mb.field_select = field_select;
    mb.mv_count = mv_count;

    for i in 0..6 {
        let coded = intra || cbp & (1 << (5 - i)) != 0;
        if coded {
            // Straight into the macroblock: a block built on the stack and
            // assigned in is another hundred and twenty-eight bytes copied per
            // coded block, which the browser build pays for in memcpy.
            decode_block(r, pic, state, i, intra, &mut mb.blocks[i])?;
            mb.coded_blocks |= 1 << i;
        }
    }

    if !intra {
        // Non-intra macroblocks reset the DC predictors (clause 7.2.1).
        state.dc_pred = [state.dc_pred_reset; 3];
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::mirror_single_vector_predictors;

    #[test]
    fn one_vector_motion_updates_both_r_predictors() {
        let mut pmv = [11, -12, 21, -22, 99, 99, 99, 99];
        mirror_single_vector_predictors(&mut pmv, true, true);
        assert_eq!(pmv, [11, -12, 21, -22, 11, -12, 21, -22]);
    }
}
