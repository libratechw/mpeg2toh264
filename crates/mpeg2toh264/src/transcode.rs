//! MPEG-2 to H.264 transcoding.
//!
//! The normal path reconstructs no pixels on the luma path: MPEG-2 coefficient
//! levels are dequantised into orthonormal-DCT values and requantised straight
//! into H.264 levels, with no inverse transform, no motion compensation and no
//! reference frame buffer. Chroma is the exception and is documented in
//! [`crate::h264::chroma`].
//!
//! The exception is the picture that opens a random access point. Its slices
//! are I slices, which carry no reference list, so there is nothing to hang the
//! flat prediction's weights on and it has to be coded with H.264's own intra
//! prediction. DC mode is used throughout, which keeps the prediction a single
//! constant per block and lets the residual stay in the coefficient domain
//! alongside everything else -- but the constant is read back from what a
//! decoder will reconstruct, so that picture, and only that picture, is
//! reconstructed here as well. See [`crate::h264::intra`] and
//! [`crate::h264::reconstruct`].
//!
//! Every output picture is a B slice, even those that were I or P in the source,
//! because the half-sample motion mapping needs bi-prediction and that is only
//! available in B slices. See [`crate::h264::mvmap`].

use crate::bitreader::BitReader;
use crate::error::{bail, Result};
use crate::h264::bitwriter::{nal_type, to_nal_unit, BitWriter};
use crate::h264::chroma::{
    chroma_qp, convert_chroma_block, convert_field_chroma_pair, convert_intra_chroma_block,
    ChromaBlockLevels, FieldChromaScratch, FieldChromaSource,
};
use crate::h264::intra::{chroma_dc, luma_8x8_dc, CodingOrder, ReconstructedPicture};
use crate::h264::mb::{
    b16x8_mb_type, b_mb_type, make_luma_counts, mark_no_chroma_coefficients, mark_no_coefficients,
    write_inter_macroblock, write_intra_macroblock, ChromaCounts, CoeffCountMap, InterMacroblock,
    MotionPartition, PredictionMode, FIELD_SCAN_8X8,
};
use crate::h264::mvmap::{map_vector, native_position, VectorKind};
use crate::h264::mvpred::{MbMotion, MotionField};
use crate::h264::params::{
    frame_geometry, write_pps, write_sps, FrameGeometry, PpsConfig, SpsConfig,
};
use crate::h264::params::{ZIGZAG_4X4, ZIGZAG_8X8};
use crate::h264::quant::{
    field_dct_to_frame_targets, frame_dct_to_field_targets, inter_targets, intra_targets,
    Quantiser8x8, DEFAULT_OVERSAMPLE, FLAT_PREDICTION_DC,
};
use crate::h264::reconstruct::{
    chroma_dc_terms, chroma_residual_4x4, residual_8x8, InverseScale8x8,
};
use crate::h264::slice::{write_slice_header, SliceHeaderConfig, SliceType};
use crate::mpeg2::constants::{mb_flag, PictureStructure, PictureType, QUANTISER_SCALE};
use crate::mpeg2::headers::{
    parse_elementary_stream, picture_geometry, sequence_sample_aspect_ratio, Picture,
};
use crate::mpeg2::macroblock::{decode_slice, motion_type, Macroblock, MacroblockGrid};

const LOG2_MAX_FRAME_NUM_MINUS4: u32 = 4;
const LOG2_MAX_POC_LSB_MINUS4: u32 = 12;
const PPS_INIT_QP: i32 = 26;
/// Chroma is quantised finer than luma. Its conversion runs through an inverse
/// and a forward transform plus the 2x2 DC Hadamard, which is orthogonal but not
/// orthonormal, so it accumulates more rounding than luma's direct coefficient
/// mapping and that error compounds along a chain of predicted pictures.
const CHROMA_QP_OFFSET: i32 = -6;
const MAX_FRAME_NUM: u32 = 1 << (LOG2_MAX_FRAME_NUM_MINUS4 + 4);

#[derive(Clone, Copy, Debug)]
pub struct TranscodeOptions {
    pub oversample: f64,
    /// Convert only MPEG-2 I pictures; P and B pictures are counted as skipped.
    pub i_frames_only: bool,
}

impl Default for TranscodeOptions {
    fn default() -> Self {
        Self {
            oversample: DEFAULT_OVERSAMPLE,
            i_frames_only: false,
        }
    }
}

/// Counts of how faithfully each macroblock's motion could be reproduced.
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    /// Inter macroblocks whose motion is reproduced exactly, luma and chroma.
    pub integer_vectors: u64,
    /// Half sample on one axis: luma exact, chroma a quarter sample out.
    pub single_axis_half_vectors: u64,
    /// Half sample on both axes, where luma is approximate as well.
    pub both_axis_half_vectors: u64,
    /// Bidirectional macroblocks, where both prediction slots are already used.
    pub bidirectional_vectors: u64,
    pub intra_macroblocks: u64,
    pub inter_macroblocks: u64,
}

#[derive(Clone, Debug)]
pub struct TranscodeResult {
    pub bitstream: Vec<u8>,
    pub pictures_converted: usize,
    pub pictures_skipped: usize,
    pub stats: Stats,
}

/// Which reference index reaches which picture, per list.
#[derive(Clone, Copy, Debug)]
struct RefLayout {
    count: u32,
    /// The picture an MPEG-2 forward vector refers to.
    fwd_l0: i32,
    fwd_l1: i32,
    /// The picture an MPEG-2 backward vector refers to; -1 in I and P pictures.
    bwd_l0: i32,
    bwd_l1: i32,
    /// The index whose weights force a flat prediction, which intra macroblocks
    /// use in place of H.264 intra prediction; see [`crate::h264::slice`]. It is
    /// the long-term picture, which is kept purely to have an index to hang
    /// those weights on -- its samples are never read.
    flat: i32,
    /// Set for I and P pictures, where both lists must reach the same picture
    /// and list 1's default construction would swap its first two entries.
    force_l1_short_term: bool,
}

/// The neighbour state a picture's coding reads back, kept between pictures.
///
/// Every picture starts from these empty, so what they hold is never carried
/// over -- but at an HD macroblock count they are several megabytes between
/// them, and asking the allocator for that per picture costs more than the
/// emptying does. In the browser build it costs more still, since the zeroing
/// an allocation comes with is a memset there.
struct PictureScratch {
    counts: CoeffCountMap,
    chroma_counts: ChromaCounts,
    motion: MotionField,
    /// Indexed by field parity, for the pictures coded as field pairs.
    field_counts: [CoeffCountMap; 2],
    field_chroma_counts: [ChromaCounts; 2],
    field_motion: [MotionField; 2],
}

impl PictureScratch {
    fn new(mb_width: usize, mb_height: usize) -> Self {
        let field_height = mb_height >> 1;
        Self {
            counts: make_luma_counts(mb_width, mb_height),
            chroma_counts: ChromaCounts::new(mb_width, mb_height),
            motion: MotionField::new(mb_width, mb_height),
            field_counts: [
                make_luma_counts(mb_width, field_height),
                make_luma_counts(mb_width, field_height),
            ],
            field_chroma_counts: [
                ChromaCounts::new(mb_width, field_height),
                ChromaCounts::new(mb_width, field_height),
            ],
            field_motion: [
                MotionField::new(mb_width, field_height),
                MotionField::new(mb_width, field_height),
            ],
        }
    }
}

pub struct IncrementalTranscoder {
    options: TranscodeOptions,
    /// Built at the first picture and kept: the sequence dimensions may not
    /// change while a transcoder is alive.
    scratch: Option<PictureScratch>,
    initialized: bool,
    width: u32,
    height: u32,
    mbaff: bool,
    prev_ref_frame_num: u32,
    short_term_count: u32,
    gop_base: u32,
    seen_picture: bool,
    max_tr_in_gop: u32,
    random_access_pending: bool,
    pictures_converted: usize,
    pictures_skipped: usize,
    stats: Stats,
}

impl IncrementalTranscoder {
    pub fn new(options: TranscodeOptions) -> Self {
        Self {
            options,
            scratch: None,
            initialized: false,
            width: 0,
            height: 0,
            mbaff: false,
            prev_ref_frame_num: 0,
            short_term_count: 0,
            gop_base: 0,
            seen_picture: false,
            max_tr_in_gop: 0,
            random_access_pending: false,
            pictures_converted: 0,
            pictures_skipped: 0,
            stats: Stats::default(),
        }
    }

    /// Restart the H.264 DPB from an IDR at the next incremental unit.
    pub fn request_random_access_point(&mut self) {
        if self.initialized {
            self.random_access_pending = true;
        }
    }

    pub fn push(&mut self, data: &[u8]) -> Result<TranscodeResult> {
        let options = self.options;
        let pics = parse_elementary_stream(data)?;
        let Some(first) = pics.first() else {
            bail!("no pictures in stream");
        };

        let width = first.sequence.horizontal_size;
        let height = first.sequence.vertical_size;
        let mbaff = !first.sequence_ext.progressive_sequence;
        if self.initialized && (width != self.width || height != self.height || mbaff != self.mbaff)
        {
            bail!("MPEG-2 sequence parameters changed during incremental transcode");
        }

        // Interlaced coding is not handled by the frame path. A field-DCT
        // macroblock builds its 8x8 blocks from alternate lines and field motion
        // predicts each field separately; representing either in H.264 needs
        // macroblock-adaptive frame/field coding.
        //
        // Field pictures are paired below and represented as one MBAFF frame.

        let g = frame_geometry(width, height, !mbaff);
        let scaling = first.quant.non_intra;

        let random_access = self.initialized && self.random_access_pending;
        let mut parts: Vec<Vec<u8>> = Vec::new();
        if !self.initialized {
            parts.push(write_sps(&SpsConfig {
                width,
                height,
                // Higher than the frame size alone would ask for, because a
                // level is a promise about the bitstream and not just about
                // its dimensions. Requantising with no reference buffer costs
                // bits: broadcast HD comes out around 35 Mb/s, with second-long
                // peaks past 50, where level 4.0 promises 25. Access units are
                // outsized too -- a random access point is a whole picture of
                // raw samples -- and 5.1 is back to the looser MinCR that the
                // levels below 3.1 use.
                level_idc: 51,
                frame_mbs_only: !mbaff,
                // The long-term flat-prediction picture plus the two most recent
                // I or P pictures, which are what a B picture predicts from. The
                // count also fixes how many short-term pictures the sliding
                // window keeps, so the reference indices in RefLayout depend on
                // it.
                max_num_ref_frames: 4,
                log2_max_frame_num_minus4: LOG2_MAX_FRAME_NUM_MINUS4,
                log2_max_poc_lsb_minus4: LOG2_MAX_POC_LSB_MINUS4,
                // An MPEG-2 stream codes its anchor picture before the B
                // pictures that display ahead of it, so one picture has to be
                // held back.
                max_num_reorder_frames: Some(1),
                max_dec_frame_buffering: Some(4),
                sample_aspect_ratio: sequence_sample_aspect_ratio(&first.sequence),
            }));
            parts.push(write_pps(&PpsConfig {
                init_qp: PPS_INIT_QP,
                scaling_8x8_intra: Some(&scaling),
                scaling_8x8_inter: Some(&scaling),
                chroma_qp_index_offset: CHROMA_QP_OFFSET,
            }));
        }

        let quant = Quantiser8x8::new(&scaling);
        let scratch = self
            .scratch
            .get_or_insert_with(|| PictureScratch::new(g.mb_width, g.mb_height));
        let mut reader = BitReader::new(data);
        // One picture's macroblocks, reused by every picture in the group. At
        // an HD macroblock count this is several megabytes, and handing it back
        // to the allocator after each picture only to fault it in again for the
        // next is most of what the pictures cost outside their own coding.
        let mut by_address = MacroblockGrid::new();
        let mut paired_by_address = MacroblockGrid::new();
        // Likewise the slice payload: a picture's worth of coded macroblocks
        // is megabytes, and asking the allocator for that per picture costs
        // more than the writing does.
        let mut slice_writer = BitWriter::with_capacity(1 << 22);

        let mut pictures_converted = 0usize;
        let mut pictures_skipped = 0usize;

        let mut prev_ref_frame_num = if random_access {
            0
        } else {
            self.prev_ref_frame_num
        };
        let mut short_term_count = if random_access {
            0
        } else {
            self.short_term_count
        };
        // temporal_reference restarts at each group of pictures, so display
        // order is recovered by accumulating a base as the counter wraps.
        let mut gop_base = if random_access { 0 } else { self.gop_base };
        let mut seen_picture = !random_access && self.seen_picture;
        let mut max_tr_in_gop = if random_access { 0 } else { self.max_tr_in_gop };
        // A fresh stream, and a stream restarting at a random access point, has
        // an empty decoded picture buffer and so cannot code anything that
        // predicts.
        let mut awaiting_idr = !self.initialized || random_access;

        let mut logical_pictures = Vec::with_capacity(pics.len());
        let mut source_index = 0;
        while source_index < pics.len() {
            let pic = &pics[source_index];
            if pic.coding.picture_structure == PictureStructure::Frame {
                logical_pictures.push((pic, None));
                source_index += 1;
                continue;
            }
            let Some(mate) = pics.get(source_index + 1) else {
                bail!("unpaired MPEG-2 field picture at end of stream");
            };
            if mate.coding.picture_structure == PictureStructure::Frame
                || mate.coding.picture_structure == pic.coding.picture_structure
                || mate.header.temporal_reference != pic.header.temporal_reference
                || mate.header.picture_coding_type != pic.header.picture_coding_type
            {
                bail!("MPEG-2 field picture is not followed by its complementary field");
            }
            logical_pictures.push((pic, Some(mate)));
            source_index += 2;
        }
        let has_field_pairs = logical_pictures.iter().any(|(_, mate)| mate.is_some());

        'pictures: for &(pic, paired_pic) in &logical_pictures {
            let picture_type = pic.header.picture_coding_type;
            if !picture_type.is_ipb() {
                pictures_skipped += 1;
                continue;
            }
            if options.i_frames_only && picture_type != PictureType::I {
                pictures_skipped += 1;
                continue;
            }
            let tr = pic.header.temporal_reference;
            if pic.starts_gop && seen_picture {
                gop_base += max_tr_in_gop + 1;
                max_tr_in_gop = 0;
            }
            seen_picture = true;
            max_tr_in_gop = max_tr_in_gop.max(tr);

            // A B picture needs both of its references present.
            if picture_type == PictureType::B && short_term_count < 2 {
                pictures_skipped += 1;
                continue;
            }
            // Nothing can be coded before the IDR that starts the decoded
            // picture buffer, and only an I picture can become one.
            let real_idr = awaiting_idr && picture_type == PictureType::I;
            if awaiting_idr && !real_idr {
                pictures_skipped += 1;
                continue;
            }
            awaiting_idr = false;
            // In I-only mode every content picture depends solely on the
            // long-term picture. Keeping content pictures as references only
            // makes that picture move through the default reference list, and
            // serves no purpose.
            let is_reference =
                real_idr || (!options.i_frames_only && picture_type != PictureType::B);

            let layout = if picture_type == PictureType::B {
                // A B picture sits between its two references, so list 0
                // defaults to [forward, backward, long-term] and list 1 to
                // [backward, forward, long-term].
                RefLayout {
                    count: short_term_count + 1,
                    fwd_l0: 0,
                    fwd_l1: 1,
                    bwd_l0: short_term_count as i32 - 1,
                    bwd_l1: 0,
                    flat: short_term_count as i32,
                    force_l1_short_term: false,
                }
            } else {
                RefLayout {
                    count: short_term_count + 1,
                    fwd_l0: 0,
                    fwd_l1: 0,
                    bwd_l0: -1,
                    bwd_l1: -1,
                    // Long-term entries follow every short-term one in both
                    // default lists.
                    flat: short_term_count as i32,
                    force_l1_short_term: short_term_count > 0,
                }
            };

            let frame_num = if real_idr {
                0
            } else {
                (prev_ref_frame_num + 1) % MAX_FRAME_NUM
            };
            let geo = picture_geometry(pic);
            by_address.reset(geo.mb_width * geo.mb_height);
            let mut decoded_slices = 0usize;
            let mut first_slice_error = None;
            for slice in &pic.slices {
                match decode_slice(&mut reader, pic, slice, geo.mb_width, &mut by_address) {
                    Ok(()) => decoded_slices += 1,
                    Err(error) if first_slice_error.is_none() => {
                        first_slice_error = Some((slice, error))
                    }
                    Err(_) => {}
                }
            }
            if decoded_slices == 0 {
                let (slice, error) = first_slice_error.expect("a picture has at least one slice");
                bail!(
                    "picture tr={} structure={} slice row {}: {error}",
                    pic.header.temporal_reference,
                    pic.coding.picture_structure.code(),
                    slice.vertical_position
                );
            }
            if first_slice_error.is_some() {
                pictures_skipped += 1;
                continue;
            }
            if let Some(mate) = paired_pic {
                let mate_geo = picture_geometry(mate);
                paired_by_address.reset(mate_geo.mb_width * mate_geo.mb_height);
                let mut decoded_slices = 0usize;
                let mut first_slice_error = None;
                for slice in &mate.slices {
                    match decode_slice(
                        &mut reader,
                        mate,
                        slice,
                        mate_geo.mb_width,
                        &mut paired_by_address,
                    ) {
                        Ok(()) => decoded_slices += 1,
                        Err(error) if first_slice_error.is_none() => {
                            first_slice_error = Some((slice, error))
                        }
                        Err(_) => {}
                    }
                }
                if decoded_slices == 0 {
                    let (slice, error) =
                        first_slice_error.expect("a picture has at least one slice");
                    bail!(
                        "picture tr={} structure={} slice row {}: {error}",
                        mate.header.temporal_reference,
                        mate.coding.picture_structure.code(),
                        slice.vertical_position
                    );
                }
                if first_slice_error.is_some() {
                    pictures_skipped += 1;
                    continue 'pictures;
                }
            }
            let ctx = PictureContext {
                frame_num,
                // The IDR displays first, so it takes the lowest POC in the segment.
                poc: if real_idr { 0 } else { 2 * (gop_base + tr) },
                is_reference,
                layout,
                options,
                mbaff,
                real_idr,
            };
            if has_field_pairs {
                parts.push(write_access_unit_delimiter());
            }
            parts.push(write_picture(
                pic,
                &by_address,
                paired_pic.map(|mate| (mate, &paired_by_address)),
                &g,
                &quant,
                scratch,
                &ctx,
                &mut self.stats,
                &mut slice_writer,
            )?);

            if real_idr {
                // The IDR is held as the long-term flat-prediction picture, and
                // nothing predicts from its samples, so I-only mode needs no
                // short-term reference at all. Otherwise a skipped copy of it
                // starts that chain.
                if !options.i_frames_only {
                    if has_field_pairs {
                        parts.push(write_access_unit_delimiter());
                    }
                    parts.push(write_reference_clone(&g, mbaff));
                    prev_ref_frame_num = 1;
                    short_term_count = 1;
                }
            } else if is_reference {
                prev_ref_frame_num = frame_num;
                short_term_count = (short_term_count + 1).min(3);
            }
            pictures_converted += 1;
        }

        let total: usize = parts.iter().map(Vec::len).sum();
        let mut bitstream = Vec::with_capacity(total);
        for part in &parts {
            bitstream.extend_from_slice(part);
        }

        self.initialized = true;
        self.width = width;
        self.height = height;
        self.mbaff = mbaff;
        self.prev_ref_frame_num = prev_ref_frame_num;
        self.short_term_count = short_term_count;
        self.gop_base = gop_base;
        self.seen_picture = seen_picture;
        self.max_tr_in_gop = max_tr_in_gop;
        self.random_access_pending = false;
        self.pictures_converted += pictures_converted;
        self.pictures_skipped += pictures_skipped;

        Ok(TranscodeResult {
            bitstream,
            pictures_converted: self.pictures_converted,
            pictures_skipped: self.pictures_skipped,
            stats: self.stats,
        })
    }
}

pub fn transcode(data: &[u8], options: TranscodeOptions) -> Result<TranscodeResult> {
    IncrementalTranscoder::new(options).push(data)
}

struct PictureContext {
    frame_num: u32,
    poc: u32,
    is_reference: bool,
    layout: RefLayout,
    options: TranscodeOptions,
    mbaff: bool,
    real_idr: bool,
}

/// How one macroblock is predicted, once the source's motion has been mapped.
#[derive(Clone, Copy, Debug)]
struct Prediction {
    mb_type: u32,
    ref_idx_l0: i32,
    ref_idx_l1: i32,
    mv_l0: [i32; 2],
    mv_l1: [i32; 2],
}

/// The vector of one direction, in half samples. A frame-picture field
/// prediction carries one vector for each field; the current H.264 macroblock
/// writer emits a single 16x16 partition, so the centre of the two predictions
/// is used. MPEG-2 vertical field vectors count field lines and therefore become
/// twice as large in frame-line coordinates.
fn frame_vector(mb: &Macroblock, backward: bool) -> [i32; 2] {
    let base = if backward { 2 } else { 0 };
    if mb.motion_type != motion_type::FIELD || mb.mv_count < 2 {
        return [mb.mv[base], mb.mv[base + 1]];
    }
    [
        // Halving with the tie going up, matching the reference implementation.
        (mb.mv[base] + mb.mv[base + 4] + 1).div_euclid(2),
        mb.mv[base + 1] + mb.mv[base + 5],
    ]
}

/// H.262 `// 2`: nearest integer, with a half-integer rounded away from zero.
fn rounded_half(value: i32) -> i32 {
    if value < 0 {
        (value - 1) / 2
    } else {
        (value + 1) / 2
    }
}

/// Derive the opposite-parity vector of dual-prime prediction (H.262
/// 7.6.3.6). The coded vector addresses the same-parity field.
fn dual_prime_opposite(
    coded: [i32; 2],
    differential: [i32; 2],
    predicted_field: usize,
    frame_picture: bool,
    top_field_first: bool,
) -> [i32; 2] {
    let multiplier = if frame_picture {
        match (predicted_field, top_field_first) {
            (0, true) | (1, false) => 1,
            _ => 3,
        }
    } else {
        1
    };
    let parity_offset = if predicted_field == 0 { -1 } else { 1 };
    [
        rounded_half(coded[0] * multiplier) + differential[0],
        rounded_half(coded[1] * multiplier) + parity_offset + differential[1],
    ]
}

fn prediction_for(
    mb: Option<&Macroblock>,
    intra: bool,
    layout: &RefLayout,
    stats: &mut Stats,
) -> Prediction {
    let (Some(mb), false) = (mb, intra) else {
        // Intra macroblocks take the flat prediction that stands in for H.264
        // intra prediction; see h264/slice.rs.
        return Prediction {
            mb_type: b_mb_type::L0_16X16,
            ref_idx_l0: layout.flat,
            ref_idx_l1: -1,
            mv_l0: [0, 0],
            mv_l1: [0, 0],
        };
    };

    let has_backward = layout.bwd_l0 >= 0 && mb.flags & mb_flag::MOTION_BACKWARD != 0;
    let has_forward = mb.flags & mb_flag::MOTION_FORWARD != 0 || !has_backward;

    if has_forward && has_backward {
        // Both slots go to the two directions, leaving none for the bilinear
        // pair, so H.264 interpolates each side itself. The averaging structure
        // still matches MPEG-2's; only the sub-sample filter differs.
        stats.bidirectional_vectors += 1;
        let fwd = frame_vector(mb, false);
        let bwd = frame_vector(mb, true);
        return Prediction {
            mb_type: b_mb_type::BI_16X16,
            ref_idx_l0: layout.fwd_l0,
            // The backward picture's index in list 1, not its index in list 0:
            // the two lists hold the same pictures in opposite orders.
            ref_idx_l1: layout.bwd_l1,
            mv_l0: native_position(fwd[0], fwd[1]),
            mv_l1: native_position(bwd[0], bwd[1]),
        };
    }

    let use_backward = has_backward;
    let [mvx, mvy] = frame_vector(mb, use_backward);
    let mapped = map_vector(mvx, mvy);

    match mapped.kind {
        VectorKind::Integer => stats.integer_vectors += 1,
        VectorKind::HalfOneAxis => stats.single_axis_half_vectors += 1,
        VectorKind::HalfBothAxes => stats.both_axis_half_vectors += 1,
    }

    // The bilinear pair must reach the same picture through both lists.
    let primary = if use_backward {
        layout.bwd_l0
    } else {
        layout.fwd_l0
    };
    let secondary = if use_backward {
        layout.bwd_l1
    } else {
        layout.fwd_l1
    };

    let Some(b) = mapped.b else {
        return if use_backward {
            Prediction {
                mb_type: b_mb_type::L1_16X16,
                ref_idx_l0: -1,
                ref_idx_l1: layout.bwd_l1,
                mv_l0: [0, 0],
                mv_l1: mapped.a,
            }
        } else {
            Prediction {
                mb_type: b_mb_type::L0_16X16,
                ref_idx_l0: layout.fwd_l0,
                ref_idx_l1: -1,
                mv_l0: mapped.a,
                mv_l1: [0, 0],
            }
        };
    };
    Prediction {
        mb_type: b_mb_type::BI_16X16,
        ref_idx_l0: primary,
        ref_idx_l1: secondary,
        mv_l0: mapped.a,
        mv_l1: b,
    }
}

/// Preserve vector-fidelity statistics when only field prediction is emitted.
fn count_field_pair_vector(
    mb: Option<&Macroblock>,
    intra: bool,
    layout: &RefLayout,
    stats: &mut Stats,
) {
    let (Some(mb), false) = (mb, intra) else {
        return;
    };
    let backward = layout.bwd_l0 >= 0 && mb.flags & mb_flag::MOTION_BACKWARD != 0;
    let forward = mb.flags & mb_flag::MOTION_FORWARD != 0 || !backward;
    if forward && backward {
        stats.bidirectional_vectors += 1;
        return;
    }
    let [x, y] = frame_vector(mb, backward);
    match (x & 1) + (y & 1) {
        0 => stats.integer_vectors += 1,
        1 => stats.single_axis_half_vectors += 1,
        _ => stats.both_axis_half_vectors += 1,
    }
}

/// Prediction for one field of an MPEG-2 field-motion macroblock.
fn prediction_for_field(
    mb: &Macroblock,
    field: usize,
    top_field_first: bool,
    layout: &RefLayout,
    intra: bool,
) -> Prediction {
    if intra {
        return Prediction {
            mb_type: b_mb_type::L0_16X16,
            ref_idx_l0: layout.flat * 2,
            ref_idx_l1: -1,
            mv_l0: [0, 0],
            mv_l1: [0, 0],
        };
    }
    let has_backward = layout.bwd_l0 >= 0 && mb.flags & mb_flag::MOTION_BACKWARD != 0;
    let has_forward = mb.flags & mb_flag::MOTION_FORWARD != 0 || !has_backward;
    let field_motion = mb.motion_type == motion_type::FIELD;
    let vector = |direction: usize| -> [i32; 2] {
        let base = if field_motion { field * 4 } else { 0 } + direction * 2;
        [mb.mv[base], mb.mv[base + 1]]
    };
    let ref_parity = |direction: usize| -> usize {
        if field_motion {
            mb.field_select[field * 2 + direction] as usize
        } else {
            // A frame vertical vector counts half frame-lines.  When its
            // integer part crosses an odd number of frame lines, the exact
            // sample belongs to the opposite reference field.
            (field as i32 + vector(direction)[1].div_euclid(2)).rem_euclid(2) as usize
        }
    };
    let field_ref = |frame_ref: i32, direction: usize| -> i32 {
        let ref_parity = ref_parity(direction);
        // MBAFF field lists expand each frame entry into same-parity then
        // opposite-parity fields for the current macroblock.
        frame_ref * 2 + i32::from(ref_parity != field)
    };

    if mb.motion_type == motion_type::DUAL_PRIME {
        let opposite = dual_prime_opposite(
            [mb.mv[0], mb.mv[1]],
            mb.dmvector,
            field,
            true,
            top_field_first,
        );
        return Prediction {
            mb_type: b_mb_type::BI_16X16,
            ref_idx_l0: layout.fwd_l0 * 2,
            ref_idx_l1: layout.fwd_l1 * 2 + 1,
            mv_l0: native_position(mb.mv[0], mb.mv[1]),
            mv_l1: native_position(opposite[0], opposite[1]),
        };
    }
    let native = |direction: usize| -> [i32; 2] {
        let [x, y] = vector(direction);
        // A frame vector's vertical half-sample unit is one quarter sample on
        // the field grid. Field-format vectors have already been scaled by the
        // MPEG decoder and use the ordinary mapping in MBAFF coordinates.
        if field_motion {
            native_position(x, y)
        } else {
            // Convert the frame-grid position to quarter samples of the
            // selected reference field.  The parity term is what turns an odd
            // whole-frame-line displacement into an integer position in the
            // opposite field instead of filtering between same-parity lines.
            [x * 2, y + 2 * (field as i32 - ref_parity(direction) as i32)]
        }
    };

    if has_forward && has_backward {
        return Prediction {
            mb_type: b_mb_type::BI_16X16,
            ref_idx_l0: field_ref(layout.fwd_l0, 0),
            ref_idx_l1: field_ref(layout.bwd_l1, 1),
            mv_l0: native(0),
            mv_l1: native(1),
        };
    }

    let use_backward = has_backward;
    let direction = usize::from(use_backward);
    if !field_motion {
        let [x, y] = vector(direction);
        let primary_frame = if use_backward {
            layout.bwd_l0
        } else {
            layout.fwd_l0
        };
        let secondary_frame = if use_backward {
            layout.bwd_l1
        } else {
            layout.fwd_l1
        };
        let field_index =
            |frame_ref: i32, parity: usize| frame_ref * 2 + i32::from(parity != field);
        let vector_to_line = |horizontal: i32, displacement: i32, parity: usize| {
            [
                horizontal,
                2 * (field as i32 - parity as i32) + 2 * displacement,
            ]
        };

        // With a half-sample on one axis MPEG-2's bilinear prediction is the
        // rounded average of two integer samples.  Name the same source field
        // through both H.264 lists and reproduce that average, avoiding the
        // H.264 six-tap filter.  Two-axis halves retain H.264 horizontal
        // interpolation but still average the correct adjacent frame lines.
        if x & 1 != 0 || y & 1 != 0 {
            let dy0 = y.div_euclid(2);
            let (p0, p1, mv0, mv1) = if y & 1 != 0 {
                let p0 = (field as i32 + dy0).rem_euclid(2) as usize;
                let p1 = (field as i32 + dy0 + 1).rem_euclid(2) as usize;
                (
                    p0,
                    p1,
                    vector_to_line(x * 2, dy0, p0),
                    vector_to_line(x * 2, dy0 + 1, p1),
                )
            } else {
                let parity = (field as i32 + dy0).rem_euclid(2) as usize;
                let x0 = x.div_euclid(2) * 4;
                (
                    parity,
                    parity,
                    vector_to_line(x0, dy0, parity),
                    vector_to_line(x0 + 4, dy0, parity),
                )
            };
            return Prediction {
                mb_type: b_mb_type::BI_16X16,
                ref_idx_l0: field_index(primary_frame, p0),
                ref_idx_l1: field_index(secondary_frame, p1),
                mv_l0: mv0,
                mv_l1: mv1,
            };
        }

        let mv = native(direction);
        return if use_backward {
            Prediction {
                mb_type: b_mb_type::L1_16X16,
                ref_idx_l0: -1,
                ref_idx_l1: field_ref(layout.bwd_l1, 1),
                mv_l0: [0, 0],
                mv_l1: mv,
            }
        } else {
            Prediction {
                mb_type: b_mb_type::L0_16X16,
                ref_idx_l0: field_ref(layout.fwd_l0, 0),
                ref_idx_l1: -1,
                mv_l0: mv,
                mv_l1: [0, 0],
            }
        };
    }
    let [x, y] = vector(direction);
    let mapped = map_vector(x, y);
    let primary_frame = if use_backward {
        layout.bwd_l0
    } else {
        layout.fwd_l0
    };
    let secondary_frame = if use_backward {
        layout.bwd_l1
    } else {
        layout.fwd_l1
    };
    let Some(b) = mapped.b else {
        return if use_backward {
            Prediction {
                mb_type: b_mb_type::L1_16X16,
                ref_idx_l0: -1,
                ref_idx_l1: field_ref(layout.bwd_l1, 1),
                mv_l0: [0, 0],
                mv_l1: mapped.a,
            }
        } else {
            Prediction {
                mb_type: b_mb_type::L0_16X16,
                ref_idx_l0: field_ref(layout.fwd_l0, 0),
                ref_idx_l1: -1,
                mv_l0: mapped.a,
                mv_l1: [0, 0],
            }
        };
    };
    Prediction {
        mb_type: b_mb_type::BI_16X16,
        ref_idx_l0: field_ref(primary_frame, direction),
        ref_idx_l1: field_ref(secondary_frame, direction),
        mv_l0: mapped.a,
        mv_l1: b,
    }
}

/// Prediction for a macroblock that came from an MPEG-2 field picture and is
/// emitted as one field-coded macroblock of an MBAFF complementary pair.
fn prediction_for_field_picture(
    mb: Option<&Macroblock>,
    field: usize,
    partition: usize,
    intra: bool,
    layout: &RefLayout,
    stats: &mut Stats,
    second_reference_field: bool,
) -> Prediction {
    let (Some(mb), false) = (mb, intra) else {
        return Prediction {
            mb_type: b_mb_type::L0_16X16,
            ref_idx_l0: if second_reference_field {
                4
            } else {
                layout.flat * 2 + field as i32
            },
            ref_idx_l1: -1,
            mv_l0: [0, 0],
            mv_l1: [0, 0],
        };
    };
    let has_backward = layout.bwd_l0 >= 0 && mb.flags & mb_flag::MOTION_BACKWARD != 0;
    let has_forward = mb.flags & mb_flag::MOTION_FORWARD != 0 || !has_backward;
    let field_ref = |frame_ref: i32, direction: usize| {
        // Skipped MPEG-2 field macroblocks infer zero-vector, same-parity
        // prediction; no motion_vertical_field_select bit is present for the
        // parser to store.
        let selected = field_picture_selected_parity(
            mb.skipped,
            mb.flags,
            mb.field_select[partition * 2 + direction] as usize,
            field,
            direction,
        );
        field_picture_ref_index(
            frame_ref,
            selected,
            field,
            second_reference_field,
            direction == 0 && frame_ref == layout.fwd_l0,
        )
    };
    let vector_base = partition * 4;
    let mapped = |direction: usize| {
        map_vector(
            mb.mv[vector_base + direction * 2],
            mb.mv[vector_base + direction * 2 + 1],
        )
    };

    if mb.motion_type == motion_type::DUAL_PRIME {
        stats.bidirectional_vectors += 1;
        let opposite = dual_prime_opposite([mb.mv[0], mb.mv[1]], mb.dmvector, field, false, false);
        return Prediction {
            mb_type: b_mb_type::BI_16X16,
            ref_idx_l0: field_ref(layout.fwd_l0, 0),
            // In a P-field B slice list 1 has the first two fields swapped, so
            // its entry 0 is the opposite-parity field of the same reference.
            ref_idx_l1: 0,
            mv_l0: native_position(mb.mv[0], mb.mv[1]),
            mv_l1: native_position(opposite[0], opposite[1]),
        };
    }

    if has_forward && has_backward {
        stats.bidirectional_vectors += 1;
        return Prediction {
            mb_type: b_mb_type::BI_16X16,
            ref_idx_l0: field_ref(layout.fwd_l0, 0),
            ref_idx_l1: field_ref(layout.bwd_l1, 1),
            mv_l0: native_position(mb.mv[vector_base], mb.mv[vector_base + 1]),
            mv_l1: native_position(mb.mv[vector_base + 2], mb.mv[vector_base + 3]),
        };
    }

    // A P field picture has no future reference, so the initial B-slice lists
    // contain the same past fields and H.264 8.2.4.2.3 swaps the first two
    // entries of list 1.  Use those two views of the same MPEG-2 reference to
    // reproduce a one-axis half sample as an integer-sample average, just as
    // the frame-picture path does.
    if layout.bwd_l0 < 0 {
        let motion = mapped(0);
        match motion.kind {
            VectorKind::Integer => stats.integer_vectors += 1,
            VectorKind::HalfOneAxis => stats.single_axis_half_vectors += 1,
            VectorKind::HalfBothAxes => stats.both_axis_half_vectors += 1,
        }
        let Some(second) = motion.b else {
            return Prediction {
                mb_type: b_mb_type::L0_16X16,
                ref_idx_l0: field_ref(layout.fwd_l0, 0),
                ref_idx_l1: -1,
                mv_l0: motion.a,
                mv_l1: [0, 0],
            };
        };
        let selected = field_picture_selected_parity(
            mb.skipped,
            mb.flags,
            mb.field_select[partition * 2] as usize,
            field,
            0,
        );
        return Prediction {
            mb_type: b_mb_type::BI_16X16,
            ref_idx_l0: field_ref(layout.fwd_l0, 0),
            // List 1 has the first two field entries exchanged: same parity is
            // entry 1 and opposite parity is entry 0.
            ref_idx_l1: i32::from(selected == field),
            mv_l0: motion.a,
            mv_l1: second,
        };
    }

    let direction = usize::from(has_backward);
    let motion = mapped(direction);
    match motion.kind {
        VectorKind::Integer => stats.integer_vectors += 1,
        VectorKind::HalfOneAxis => stats.single_axis_half_vectors += 1,
        VectorKind::HalfBothAxes => stats.both_axis_half_vectors += 1,
    }
    let use_backward = !has_forward;
    let primary = if use_backward {
        layout.bwd_l0
    } else {
        layout.fwd_l0
    };
    let secondary = if use_backward {
        layout.bwd_l1
    } else {
        layout.fwd_l1
    };
    let Some(second) = motion.b else {
        return if use_backward {
            Prediction {
                mb_type: b_mb_type::L1_16X16,
                ref_idx_l0: -1,
                ref_idx_l1: field_ref(layout.bwd_l1, 1),
                mv_l0: [0, 0],
                mv_l1: motion.a,
            }
        } else {
            Prediction {
                mb_type: b_mb_type::L0_16X16,
                ref_idx_l0: field_ref(layout.fwd_l0, 0),
                ref_idx_l1: -1,
                mv_l0: motion.a,
                mv_l1: [0, 0],
            }
        };
    };
    Prediction {
        mb_type: b_mb_type::BI_16X16,
        ref_idx_l0: field_ref(primary, direction),
        ref_idx_l1: field_ref(secondary, direction),
        mv_l0: motion.a,
        mv_l1: second,
    }
}

fn field_picture_selected_parity(
    skipped: bool,
    flags: i32,
    signalled: usize,
    field: usize,
    direction: usize,
) -> usize {
    let inferred_forward = direction == 0 && flags & mb_flag::MOTION_FORWARD == 0;
    if skipped || inferred_forward {
        field
    } else {
        signalled
    }
}

/// Index an MPEG-2 top/bottom field in the H.264 field reference list.
///
/// Non-reference B pairs use the ordinary parity-relative alternation.  A
/// reference P pair is different after its first field has been decoded: that
/// field is inserted separately ahead of the older complementary pairs.
fn field_picture_ref_index(
    frame_ref: i32,
    selected: usize,
    current: usize,
    second_reference_field: bool,
    forward_reference: bool,
) -> i32 {
    if second_reference_field && forward_reference {
        return i32::from(selected != current);
    }
    // H.264 8.2.4.2.5 alternates fields starting with the parity of the
    // current field.  The index is therefore parity-relative for P fields as
    // well as B fields; using the MPEG top/bottom bit as an absolute offset
    // makes both selections address index 1 for a bottom P field.
    frame_ref * 2 + i32::from(selected != current)
}

/// Copy the content IDR into a short-term reference without changing pixels.
///
/// The IDR itself is kept as a long-term picture, purely to have a reference
/// index whose weights can force the flat prediction that intra macroblocks
/// need. That leaves nothing short-term for the pictures after it to predict
/// from, so this all-skip P picture puts the same samples in the short-term
/// chain. It carries the pair's display slot while the IDR is given a single
/// tick, and the two hold identical samples, so the seam is invisible.
fn write_reference_clone(g: &FrameGeometry, mbaff: bool) -> Vec<u8> {
    let mut w = BitWriter::with_capacity(64);
    write_slice_header(
        &mut w,
        &SliceHeaderConfig {
            slice_type: SliceType::P,
            frame_num: 1,
            log2_max_frame_num: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
            pic_order_cnt_lsb: 1,
            log2_max_poc_lsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
            reference: true,
            mbaff,
            slice_qp: PPS_INIT_QP,
            pps_init_qp: PPS_INIT_QP,
            disable_deblocking_filter_idc: 1,
            num_ref_idx_l0_active: Some(1),
            ..Default::default()
        },
    );
    w.ue((g.mb_width * g.mb_height) as u32); // mb_skip_run: copy the long-term IDR
    w.rbsp_trailing_bits();
    to_nal_unit(w.bytes(), 2, nal_type::SLICE_NON_IDR)
}

/// What the random access point needs to carry that no other picture does.
struct IntraState {
    picture: ReconstructedPicture,
    order: CodingOrder,
}

fn clip_sample(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

impl IntraState {
    /// Clause 8.3.2.2.4 for one 8x8 luma block.
    fn predict_luma(&self, mb_x: usize, mb_y: usize, blk: usize) -> i32 {
        luma_8x8_dc(&self.picture, &self.order, mb_x, mb_y, blk)
    }

    /// Put the block back together the way a decoder will, so the blocks after
    /// it -- the three that share this macroblock included -- predict from what
    /// the decoder is going to have rather than from what the source held.
    ///
    /// Levels arrive in the scan order the residual syntax uses and the inverse
    /// transform wants them in raster order, so they are unscanned on the way.
    /// `None` is a block whose `coded_block_pattern` bit is clear, which carries
    /// no residual and comes back as the prediction alone.
    #[allow(clippy::too_many_arguments)]
    fn store_luma(
        &mut self,
        mb_x: usize,
        mb_y: usize,
        blk: usize,
        prediction: i32,
        levels: Option<&[i32; 64]>,
        qp: i32,
        scale: &InverseScale8x8,
        scan: &[usize; 64],
    ) {
        let x0 = mb_x * 16 + (blk & 1) * 8;
        let y0 = mb_y * 16 + (blk >> 1) * 8;
        let width = self.picture.width;
        let Some(levels) = levels else {
            for y in 0..8 {
                let row = (y0 + y) * width + x0;
                self.picture.luma[row..row + 8].fill(clip_sample(prediction));
            }
            return;
        };
        let mut raster = [0i32; 64];
        for (k, &pos) in scan.iter().enumerate() {
            raster[pos] = levels[k];
        }
        let mut residual = [0i32; 64];
        residual_8x8(&raster, qp, scale, &mut residual);
        for y in 0..8 {
            for x in 0..8 {
                self.picture.luma[(y0 + y) * width + x0 + x] =
                    clip_sample(prediction + residual[y * 8 + x]);
            }
        }
    }

    /// The same for both chroma components, which predict from neighbouring
    /// macroblocks only and so can be done in one go at the end.
    ///
    /// `cbp_chroma` below 2 means the AC levels were never written, whatever
    /// the conversion produced, and 0 means the DC ones were not either.
    fn store_chroma(
        &mut self,
        mb_x: usize,
        mb_y: usize,
        prediction: &[[i32; 4]; 2],
        levels: &[ChromaBlockLevels; 2],
        qp_c: i32,
        cbp_chroma: u32,
    ) {
        let width = self.picture.chroma_width();
        for c in 0..2 {
            let dc = if cbp_chroma > 0 {
                chroma_dc_terms(&levels[c].dc, qp_c)
            } else {
                [0; 4]
            };
            let plane = if c == 0 {
                &mut self.picture.cb
            } else {
                &mut self.picture.cr
            };
            let mut ac = [0i32; 16];
            let mut residual = [0i32; 16];
            for blk in 0..4 {
                ac.fill(0);
                if cbp_chroma == 2 {
                    // Chroma conversion always writes the frame scan, whatever
                    // the luma blocks use, so this reads it back the same way.
                    for k in 1..16 {
                        ac[ZIGZAG_4X4[k]] = levels[c].ac[blk][k - 1];
                    }
                }
                chroma_residual_4x4(&ac, dc[blk], qp_c, &mut residual);
                let x0 = mb_x * 8 + (blk & 1) * 4;
                let y0 = mb_y * 8 + (blk >> 1) * 4;
                for y in 0..4 {
                    for x in 0..4 {
                        plane[(y0 + y) * width + x0 + x] =
                            clip_sample(prediction[c][blk] + residual[y * 4 + x]);
                    }
                }
            }
        }
    }
}

/// Access-unit delimiter used by the MP4 wrapper to keep the two NAL units of
/// a PAFF complementary field pair in one video sample.
fn write_access_unit_delimiter() -> Vec<u8> {
    let mut w = BitWriter::new();
    w.u(3, 7); // primary_pic_type: I, P, or B
    w.rbsp_trailing_bits();
    to_nal_unit(w.bytes(), 0, nal_type::AUD)
}

/// Which of the two per-slot buffers a field macroblock's targets landed in, and
/// which of its four blocks carry anything.
#[derive(Clone, Copy, Default)]
struct FieldTargetSet {
    converted: bool,
    active_mask: u32,
}

/// Dequantise one MPEG-2 macroblock of a field-coded pair, converting its
/// frame-DCT blocks into the field transform basis where needed.
fn source_field_targets(
    pic: &Picture,
    field_source: &Macroblock,
    raw: &mut [[f32; 64]; 4],
    converted: &mut [[f32; 64]; 4],
) -> FieldTargetSet {
    let mut active_mask = 0u32;
    if field_source.skipped {
        return FieldTargetSet {
            converted: false,
            active_mask,
        };
    }
    let quantiser_scale =
        QUANTISER_SCALE[pic.coding.q_scale_type][field_source.quantiser_scale_code as usize];
    let source_intra = field_source.is_intra();
    let matrix = if source_intra {
        &pic.quant.intra
    } else {
        &pic.quant.non_intra
    };
    for b in 0..4 {
        let Some(block) = field_source.block(b) else {
            continue;
        };
        active_mask |= 1 << b;
        if source_intra {
            intra_targets(
                block,
                matrix,
                quantiser_scale,
                pic.coding.intra_dc_precision,
                &mut raw[b],
            );
        } else {
            inter_targets(block, matrix, quantiser_scale, &mut raw[b]);
        }
    }
    if field_source.dct_type == 1 {
        return FieldTargetSet {
            converted: false,
            active_mask,
        };
    }
    let mut converted_mask = 0u32;
    if active_mask & 0b0101 != 0 {
        if active_mask & 0b0001 == 0 {
            raw[0].fill(0.0);
        }
        if active_mask & 0b0100 == 0 {
            raw[2].fill(0.0);
        }
        let (upper, lower) = converted.split_at_mut(2);
        frame_dct_to_field_targets(&raw[0], &raw[2], &mut upper[0], &mut lower[0]);
        converted_mask |= 0b0101;
    }
    if active_mask & 0b1010 != 0 {
        if active_mask & 0b0010 == 0 {
            raw[1].fill(0.0);
        }
        if active_mask & 0b1000 == 0 {
            raw[3].fill(0.0);
        }
        let (upper, lower) = converted.split_at_mut(2);
        frame_dct_to_field_targets(&raw[1], &raw[3], &mut upper[1], &mut lower[1]);
        converted_mask |= 0b1010;
    }
    FieldTargetSet {
        converted: true,
        active_mask: converted_mask,
    }
}

/// One chroma component of a macroblock in a field-coded pair, as the chroma
/// converter needs to see it.
fn field_chroma_source<'a>(
    pic: &'a Picture,
    pair_source: &'a Macroblock,
    component: usize,
) -> FieldChromaSource<'a> {
    let source_intra = pair_source.is_intra();
    FieldChromaSource {
        levels: pair_source.block(4 + component),
        weight_scale: if source_intra {
            &pic.quant.chroma_intra
        } else {
            &pic.quant.chroma_non_intra
        },
        quantiser_scale: QUANTISER_SCALE[pic.coding.q_scale_type]
            [pair_source.quantiser_scale_code as usize],
        intra_dc_precision: pic.coding.intra_dc_precision,
        intra: source_intra,
    }
}

/// Memoised [`Quantiser8x8::choose_qp`]: one QP serves every block coded at the
/// same MPEG-2 quantiser scale, and a picture uses only a handful of scales.
fn qp_for_scale(
    quant: &Quantiser8x8,
    qp_by_scale: &mut [i16; 256],
    oversample: f64,
    scale: i32,
) -> i32 {
    let slot = &mut qp_by_scale[scale as usize];
    if *slot < 0 {
        *slot = quant.choose_qp(scale, oversample) as i16;
    }
    *slot as i32
}

#[allow(clippy::too_many_arguments)]
fn write_picture(
    pic: &Picture,
    by_address: &MacroblockGrid,
    paired_field: Option<(&Picture, &MacroblockGrid)>,
    g: &FrameGeometry,
    quant: &Quantiser8x8,
    scratch: &mut PictureScratch,
    ctx: &PictureContext,
    stats: &mut Stats,
    writer: &mut BitWriter,
) -> Result<Vec<u8>> {
    let PictureScratch {
        counts,
        chroma_counts,
        motion,
        field_counts,
        field_chroma_counts,
        field_motion,
    } = scratch;
    let mut targets = [[0.0f32; 64]; 4];
    let mut field_targets = [[0.0f32; 64]; 4];
    let mut luma_scratch = [[0i32; 64]; 4];
    let mut chroma_scratch: [ChromaBlockLevels; 2] =
        std::array::from_fn(|_| ChromaBlockLevels::default());
    let mut field_chroma_scratch = FieldChromaScratch::default();
    // Indexed [field][component].
    let mut pair_field_chroma: [[ChromaBlockLevels; 2]; 2] =
        std::array::from_fn(|_| std::array::from_fn(|_| ChromaBlockLevels::default()));
    let mut prev_qp = PPS_INIT_QP;
    let mut slice_open = false;
    let mut picture_nals = Vec::new();
    // The random access point is the only picture that predicts from itself, so
    // it is the only one that has to carry the samples a decoder will make of
    // it. A field pair is two coded pictures and gets a plane each, which the
    // reset at the head of every slice takes care of.
    let mut intra_state = ctx.real_idr.then(|| IntraState {
        picture: ReconstructedPicture::new(
            g.mb_width * 16,
            g.mb_height * 16 / if paired_field.is_some() { 2 } else { 1 },
        ),
        order: CodingOrder {
            mb_width: g.mb_width,
            mb_height: g.mb_height / if paired_field.is_some() { 2 } else { 1 },
            // A field picture is not macroblock-adaptive whatever the sequence
            // says, because field_pic_flag already settled it.
            mbaff: ctx.mbaff && paired_field.is_none(),
        },
    });
    let output_slice_type = if ctx.real_idr {
        SliceType::I
    } else if ctx.options.i_frames_only {
        SliceType::P
    } else {
        SliceType::B
    };
    let direct_field_pair = paired_field.is_some();
    let picture_field_pairs = direct_field_pair
        || (ctx.mbaff
            && !ctx.options.i_frames_only
            && pic.header.picture_coding_type != PictureType::I);
    let mut cached_pair_address: isize = -1;
    let mut cached_pair_targets = [FieldTargetSet::default(); 2];
    let mut cached_pair_qp = PPS_INIT_QP;
    let mut qp_by_scale = [-1i16; 256];
    let mut pair_raw_targets = [[[0.0f32; 64]; 4]; 2];
    let mut pair_converted_targets = [[[0.0f32; 64]; 4]; 2];
    let oversample = ctx.options.oversample;

    // MBAFF addresses macroblocks pair-by-pair: top then bottom at one X,
    // followed by the next pair horizontally. Frame-only pictures use raster
    // order. Coordinates remain spatial so coefficient and MV neighbour lookup
    // does not otherwise change for frame-coded pairs.
    let position_count = g.mb_width * g.mb_height;
    for position in 0..position_count {
        let field_size = position_count >> 1;
        let second_output_field = direct_field_pair && position >= field_size;
        let source_field = usize::from(second_output_field);
        let first_parity =
            usize::from(pic.coding.picture_structure == PictureStructure::BottomField);
        let field = if direct_field_pair {
            first_parity ^ source_field
        } else {
            position & 1
        };
        let field_position = if direct_field_pair {
            position % field_size
        } else {
            position
        };
        let pair_address = field_position >> 1;
        let mb_x = if direct_field_pair {
            field_position % g.mb_width
        } else if ctx.mbaff {
            pair_address % g.mb_width
        } else {
            position % g.mb_width
        };
        let mb_y = if direct_field_pair {
            (field_position / g.mb_width) * 2 + field
        } else if ctx.mbaff {
            (pair_address / g.mb_width) * 2 + (position & 1)
        } else {
            position / g.mb_width
        };

        if !slice_open {
            if let Some(state) = intra_state.as_mut() {
                state.picture.clear();
            }
            counts.reset();
            chroma_counts.reset();
            motion.reset();
            for map in field_counts.iter_mut() {
                map.reset();
            }
            for maps in field_chroma_counts.iter_mut() {
                maps.reset();
            }
            for field in field_motion.iter_mut() {
                field.reset();
            }
            prev_qp = PPS_INIT_QP;
            writer.clear();
            write_slice_header(
                writer,
                &SliceHeaderConfig {
                    first_mb_in_slice: 0,
                    // I-only pictures need no bi-prediction. P slices are
                    // simpler and much more widely handled than a stream
                    // consisting solely of reference-less B pictures, while
                    // still giving every source intra MB its flat prediction.
                    slice_type: output_slice_type,
                    frame_num: ctx.frame_num,
                    log2_max_frame_num: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
                    pic_order_cnt_lsb: ctx.poc + if direct_field_pair { field as u32 } else { 0 },
                    log2_max_poc_lsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
                    idr: ctx.real_idr,
                    // The IDR is the flat-prediction reference for everything
                    // that follows, so it has to survive the sliding window.
                    long_term_reference: ctx.real_idr,
                    reference: ctx.is_reference,
                    mbaff: ctx.mbaff,
                    field_picture: direct_field_pair.then_some(field != 0),
                    slice_qp: PPS_INIT_QP,
                    pps_init_qp: PPS_INIT_QP,
                    disable_deblocking_filter_idc: 1,
                    num_ref_idx_l0_active: Some(if direct_field_pair {
                        if second_output_field && ctx.is_reference {
                            6
                        } else {
                            ctx.layout.count * 2
                        }
                    } else {
                        ctx.layout.count
                    }),
                    num_ref_idx_l1_active: Some(if direct_field_pair {
                        if second_output_field && ctx.is_reference {
                            6
                        } else {
                            ctx.layout.count * 2
                        }
                    } else {
                        ctx.layout.count
                    }),
                    l1_first_short_term_delta: (!direct_field_pair
                        && ctx.layout.force_l1_short_term)
                        .then_some(1),
                    flat_pred_ref_idx: Some(if direct_field_pair {
                        if second_output_field && ctx.is_reference {
                            4
                        } else {
                            (ctx.layout.flat * 2 + field as i32) as u32
                        }
                    } else {
                        ctx.layout.flat as u32
                    }),
                    ..Default::default()
                },
            );
            slice_open = true;
        }

        let field_row = mb_y >> 1;
        let (top_grid, bottom_grid) = if let Some((mate, mate_grid)) = paired_field {
            if pic.coding.picture_structure == PictureStructure::TopField {
                (by_address, mate_grid)
            } else {
                debug_assert_eq!(mate.coding.picture_structure, PictureStructure::TopField);
                (mate_grid, by_address)
            }
        } else {
            (by_address, by_address)
        };
        let source = if direct_field_pair {
            let grid = if mb_y & 1 == 0 { top_grid } else { bottom_grid };
            grid.get(field_row * g.mb_width + mb_x)
        } else {
            by_address.get(mb_y * g.mb_width + mb_x)
        };
        let pair_top = if direct_field_pair {
            top_grid.get(field_row * g.mb_width + mb_x)
        } else {
            by_address.get((mb_y & !1) * g.mb_width + mb_x)
        };
        let pair_bottom = if direct_field_pair {
            bottom_grid.get(field_row * g.mb_width + mb_x)
        } else {
            by_address.get(((mb_y & !1) + 1) * g.mb_width + mb_x)
        };
        // Use a uniform coding mode across an MBAFF picture. This makes every
        // horizontal and vertical neighbour live in the same field coordinate
        // system, so thousands of pair-isolating slices are unnecessary.
        let field_pair = picture_field_pairs;
        let intra = match source {
            Some(mb) if !mb.skipped => mb.is_intra(),
            _ => false,
        };

        // Position within the coded picture, which for a field picture counts
        // that field's own rows rather than the frame's.
        let coded_mb_y = if direct_field_pair { field_row } else { mb_y };
        // The random access point is the one picture coded with H.264 intra
        // prediction. Chroma predicts from neighbouring macroblocks only, so
        // its constants can be worked out here; the luma blocks predict from
        // each other and have to be taken one at a time, below.
        let chroma_prediction = intra_state.as_ref().map(|state| {
            [
                chroma_dc(
                    &state.picture.cb,
                    state.picture.chroma_width(),
                    &state.order,
                    mb_x,
                    coded_mb_y,
                ),
                chroma_dc(
                    &state.picture.cr,
                    state.picture.chroma_width(),
                    &state.order,
                    mb_x,
                    coded_mb_y,
                ),
            ]
        });
        let mut intra_luma_coded = false;

        let mut luma_active = [false; 4];
        let mut has_chroma = false;
        let mut chroma_from_pair = false;
        let mut qp = prev_qp;

        if !field_pair || direct_field_pair {
            if let Some(source) = source {
                if !source.skipped && (source.flags & mb_flag::PATTERN != 0 || intra) {
                    let quantiser_scale = QUANTISER_SCALE[pic.coding.q_scale_type]
                        [source.quantiser_scale_code as usize];
                    qp = qp_for_scale(quant, &mut qp_by_scale, oversample, quantiser_scale);
                    let matrix = if intra {
                        &pic.quant.intra
                    } else {
                        &pic.quant.non_intra
                    };
                    let chroma_matrix = if intra {
                        &pic.quant.chroma_intra
                    } else {
                        &pic.quant.chroma_non_intra
                    };

                    for b in 0..4 {
                        let target = if source.dct_type == 1 && !direct_field_pair {
                            &mut field_targets[b]
                        } else {
                            &mut targets[b]
                        };
                        target.fill(0.0);
                        let Some(block) = source.block(b) else {
                            continue;
                        };
                        if intra {
                            intra_targets(
                                block,
                                matrix,
                                quantiser_scale,
                                pic.coding.intra_dc_precision,
                                target,
                            );
                        } else {
                            inter_targets(block, matrix, quantiser_scale, target);
                        }
                    }
                    if source.dct_type == 1 && !direct_field_pair {
                        let (upper, lower) = targets.split_at_mut(2);
                        field_dct_to_frame_targets(
                            &field_targets[0],
                            &field_targets[2],
                            &mut upper[0],
                            &mut lower[0],
                        );
                        field_dct_to_frame_targets(
                            &field_targets[1],
                            &field_targets[3],
                            &mut upper[1],
                            &mut lower[1],
                        );
                    }
                    let scan: &[usize; 64] = if direct_field_pair {
                        &FIELD_SCAN_8X8
                    } else {
                        &ZIGZAG_8X8
                    };
                    for b in 0..4 {
                        let Some(state) = intra_state.as_mut().filter(|_| intra) else {
                            luma_active[b] = quant.scanned_levels_for(
                                &targets[b],
                                qp,
                                scan,
                                &mut luma_scratch[b],
                            );
                            continue;
                        };
                        // A block predicts from the ones already coded, its own
                        // neighbours in the same macroblock included, so the
                        // four have to be taken in turn: predict, quantise, and
                        // put back what the decoder will make of it before
                        // moving on.
                        //
                        // Dequantisation took the flat constant off every
                        // sample. Putting it back and removing what this block
                        // predicts from leaves the residual intra prediction
                        // wants. A constant subtracted from every sample comes
                        // through the field-to-frame line shuffle unchanged, so
                        // doing it here rather than before that is the same.
                        let pred = state.predict_luma(mb_x, coded_mb_y, b);
                        targets[b][0] += FLAT_PREDICTION_DC - 8.0 * pred as f32;
                        luma_active[b] =
                            quant.scanned_levels_for(&targets[b], qp, scan, &mut luma_scratch[b]);
                        state.store_luma(
                            mb_x,
                            coded_mb_y,
                            b,
                            pred,
                            luma_active[b].then_some(&luma_scratch[b]),
                            qp,
                            quant.inverse(),
                            scan,
                        );
                        intra_luma_coded = true;
                    }

                    let qp_c = chroma_qp(qp, CHROMA_QP_OFFSET);
                    for c in 0..2 {
                        let prediction =
                            chroma_prediction.as_ref().filter(|_| intra).map(|p| &p[c]);
                        match (source.block(4 + c), prediction) {
                            (Some(block), Some(prediction)) => convert_intra_chroma_block(
                                block,
                                chroma_matrix,
                                quantiser_scale,
                                pic.coding.intra_dc_precision,
                                qp_c,
                                prediction,
                                &mut chroma_scratch[c],
                            ),
                            (Some(block), None) => convert_chroma_block(
                                block,
                                chroma_matrix,
                                quantiser_scale,
                                pic.coding.intra_dc_precision,
                                qp_c,
                                &mut chroma_scratch[c],
                                intra,
                            ),
                            (None, _) => chroma_scratch[c].clear(),
                        }
                    }
                    has_chroma = !chroma_scratch[0].is_empty() || !chroma_scratch[1].is_empty();
                }
            }
        }

        if let Some(state) = intra_state.as_mut() {
            stats.intra_macroblocks += 1;
            if ctx.mbaff && !direct_field_pair && mb_y % 2 == 0 {
                // In an I slice this precedes mb_type directly; there is no
                // mb_skip_run in front of it. Frame-coded, like every pair in
                // an MBAFF picture here.
                writer.flag(false); // mb_field_decoding_flag
            }
            if !intra_luma_coded {
                // A macroblock the source never coded, or coded as something
                // other than intra. It carries no residual, so every block is
                // the constant its neighbours predict -- which continues them
                // rather than showing grey, and is as good a concealment as
                // this has to offer.
                for b in 0..4 {
                    let pred = state.predict_luma(mb_x, coded_mb_y, b);
                    state.store_luma(
                        mb_x,
                        coded_mb_y,
                        b,
                        pred,
                        None,
                        qp,
                        quant.inverse(),
                        &ZIGZAG_8X8,
                    );
                }
                luma_active = [false; 4];
            }
            let luma: [Option<&[i32; 64]>; 4] =
                std::array::from_fn(|i| luma_active[i].then_some(&luma_scratch[i]));
            let written = write_intra_macroblock(
                writer,
                if direct_field_pair {
                    &mut field_counts[field]
                } else {
                    &mut *counts
                },
                if direct_field_pair {
                    &mut field_chroma_counts[field]
                } else {
                    &mut *chroma_counts
                },
                mb_x,
                coded_mb_y,
                qp,
                prev_qp,
                &luma,
                has_chroma.then_some(&chroma_scratch),
            )?;
            prev_qp = written.qp;
            state.store_chroma(
                mb_x,
                coded_mb_y,
                &chroma_prediction.expect("the intra picture predicts every macroblock"),
                &chroma_scratch,
                chroma_qp(written.qp, CHROMA_QP_OFFSET),
                written.cbp_chroma,
            );
            let end_of_field =
                direct_field_pair && mb_x == g.mb_width - 1 && field_position == field_size - 1;
            if end_of_field
                || (!direct_field_pair && mb_x == g.mb_width - 1 && mb_y == g.mb_height - 1)
            {
                writer.rbsp_trailing_bits();
                picture_nals.extend_from_slice(&to_nal_unit(
                    writer.bytes(),
                    3,
                    nal_type::SLICE_IDR,
                ));
                if direct_field_pair && !second_output_field {
                    slice_open = false;
                    continue;
                }
                return Ok(picture_nals);
            }
            continue;
        }

        if field_pair && !direct_field_pair {
            let (Some(pair_top), Some(pair_bottom)) = (pair_top, pair_bottom) else {
                bail!(
                    "MBAFF macroblock pair at ({mb_x}, {}) is missing from the source",
                    mb_y >> 1
                );
            };
            let pair_index = ((mb_y >> 1) * g.mb_width + mb_x) as isize;
            if cached_pair_address != pair_index {
                cached_pair_address = pair_index;
                {
                    let (top_raw, bottom_raw) = pair_raw_targets.split_at_mut(1);
                    let (top_converted, bottom_converted) = pair_converted_targets.split_at_mut(1);
                    cached_pair_targets = [
                        source_field_targets(pic, pair_top, &mut top_raw[0], &mut top_converted[0]),
                        source_field_targets(
                            pic,
                            pair_bottom,
                            &mut bottom_raw[0],
                            &mut bottom_converted[0],
                        ),
                    ];
                }
                // One H.264 field MB combines eight field lines from each of the
                // two vertically adjacent MPEG-2 MBs. Use the finer source QP
                // for both.
                let top_qp = qp_for_scale(
                    quant,
                    &mut qp_by_scale,
                    oversample,
                    QUANTISER_SCALE[pic.coding.q_scale_type]
                        [pair_top.quantiser_scale_code as usize],
                );
                let bottom_qp = qp_for_scale(
                    quant,
                    &mut qp_by_scale,
                    oversample,
                    QUANTISER_SCALE[pic.coding.q_scale_type]
                        [pair_bottom.quantiser_scale_code as usize],
                );
                cached_pair_qp = top_qp.min(bottom_qp);
                let pair_qp_c = chroma_qp(cached_pair_qp, CHROMA_QP_OFFSET);
                for c in 0..2 {
                    let upper_chroma = field_chroma_source(pic, pair_top, c);
                    let lower_chroma = field_chroma_source(pic, pair_bottom, c);
                    let (top_field, bottom_field) = pair_field_chroma.split_at_mut(1);
                    if upper_chroma.levels.is_some() || lower_chroma.levels.is_some() {
                        convert_field_chroma_pair(
                            &upper_chroma,
                            &lower_chroma,
                            pair_qp_c,
                            &mut top_field[0][c],
                            &mut bottom_field[0][c],
                            &mut field_chroma_scratch,
                        );
                    } else {
                        top_field[0][c].clear();
                        bottom_field[0][c].clear();
                    }
                }
            }
            qp = cached_pair_qp;
            let field = mb_y & 1;
            for b in 0..4 {
                let set = cached_pair_targets[b / 2];
                let source_index = field * 2 + (b & 1);
                if set.active_mask & (1 << source_index) == 0 {
                    continue;
                }
                let selected = if set.converted {
                    &pair_converted_targets[b / 2][source_index]
                } else {
                    &pair_raw_targets[b / 2][source_index]
                };
                luma_active[b] =
                    quant.scanned_levels_for(selected, qp, &FIELD_SCAN_8X8, &mut luma_scratch[b]);
            }
            has_chroma =
                !pair_field_chroma[field][0].is_empty() || !pair_field_chroma[field][1].is_empty();
            chroma_from_pair = true;
        }

        if intra {
            stats.intra_macroblocks += 1;
        } else {
            stats.inter_macroblocks += 1;
        }
        if field_pair && !direct_field_pair {
            count_field_pair_vector(source, intra, &ctx.layout, stats);
        }
        let pred = if direct_field_pair {
            prediction_for_field_picture(
                source,
                mb_y & 1,
                0,
                intra,
                &ctx.layout,
                stats,
                second_output_field && ctx.is_reference,
            )
        } else if field_pair {
            Prediction {
                mb_type: b_mb_type::L0_16X16,
                ref_idx_l0: -1,
                ref_idx_l1: -1,
                mv_l0: [0, 0],
                mv_l1: [0, 0],
            }
        } else {
            prediction_for(source, intra, &ctx.layout, stats)
        };

        let uses_l0 = pred.mb_type != b_mb_type::L1_16X16;
        let uses_l1 = pred.mb_type != b_mb_type::L0_16X16;
        let pred_l0 = if direct_field_pair && uses_l0 {
            field_motion[mb_y & 1].predict(mb_x, mb_y >> 1, 0, pred.ref_idx_l0)
        } else if !field_pair && uses_l0 {
            motion.predict(mb_x, mb_y, 0, pred.ref_idx_l0)
        } else {
            [0, 0]
        };
        let pred_l1 = if direct_field_pair && uses_l1 {
            field_motion[mb_y & 1].predict(mb_x, mb_y >> 1, 1, pred.ref_idx_l1)
        } else if !field_pair && uses_l1 {
            motion.predict(mb_x, mb_y, 1, pred.ref_idx_l1)
        } else {
            [0, 0]
        };

        let split_frame_mb = ctx.mbaff && !ctx.options.i_frames_only && !field_pair;
        let mode = PredictionMode::from_mb_type(pred.mb_type);

        let mut partitions: Option<[MotionPartition; 2]> = None;
        let mut field_modes: Option<[PredictionMode; 2]> = None;

        if split_frame_mb {
            let mut built = [MotionPartition::default(); 2];
            for (part, slot) in built.iter_mut().enumerate() {
                let p_l0 = if uses_l0 {
                    motion.predict_16x8(mb_x, mb_y, part, 0, pred.ref_idx_l0)
                } else {
                    [0, 0]
                };
                let p_l1 = if uses_l1 {
                    motion.predict_16x8(mb_x, mb_y, part, 1, pred.ref_idx_l1)
                } else {
                    [0, 0]
                };
                let state = MbMotion {
                    ref_idx_l0: if uses_l0 { pred.ref_idx_l0 } else { -1 },
                    ref_idx_l1: if uses_l1 { pred.ref_idx_l1 } else { -1 },
                    mv_l0x: if uses_l0 { pred.mv_l0[0] } else { 0 },
                    mv_l0y: if uses_l0 { pred.mv_l0[1] } else { 0 },
                    mv_l1x: if uses_l1 { pred.mv_l1[0] } else { 0 },
                    mv_l1y: if uses_l1 { pred.mv_l1[1] } else { 0 },
                };
                motion.set_16x8(mb_x, mb_y, part, &state);
                *slot = MotionPartition {
                    ref_idx_l0: state.ref_idx_l0,
                    ref_idx_l1: state.ref_idx_l1,
                    mvd_l0x: if uses_l0 { pred.mv_l0[0] - p_l0[0] } else { 0 },
                    mvd_l0y: if uses_l0 { pred.mv_l0[1] - p_l0[1] } else { 0 },
                    mvd_l1x: if uses_l1 { pred.mv_l1[0] - p_l1[0] } else { 0 },
                    mvd_l1y: if uses_l1 { pred.mv_l1[1] - p_l1[1] } else { 0 },
                };
            }
            partitions = Some(built);
        } else if direct_field_pair
            && source
                .is_some_and(|mb| mb.motion_type == motion_type::FRAME_OR_16X8 && mb.mv_count >= 2)
        {
            let source = source.expect("checked above");
            let field = mb_y & 1;
            let mut built = [MotionPartition::default(); 2];
            let mut modes = [PredictionMode::L0; 2];
            for (part, slot) in built.iter_mut().enumerate() {
                let part_pred = prediction_for_field_picture(
                    Some(source),
                    field,
                    part,
                    intra,
                    &ctx.layout,
                    stats,
                    second_output_field && ctx.is_reference,
                );
                let uses_part_l0 = part_pred.ref_idx_l0 >= 0;
                let uses_part_l1 = part_pred.ref_idx_l1 >= 0;
                let p_l0 = if uses_part_l0 {
                    field_motion[field].predict_16x8(mb_x, mb_y >> 1, part, 0, part_pred.ref_idx_l0)
                } else {
                    [0, 0]
                };
                let p_l1 = if uses_part_l1 {
                    field_motion[field].predict_16x8(mb_x, mb_y >> 1, part, 1, part_pred.ref_idx_l1)
                } else {
                    [0, 0]
                };
                let state = MbMotion {
                    ref_idx_l0: part_pred.ref_idx_l0,
                    ref_idx_l1: part_pred.ref_idx_l1,
                    mv_l0x: if uses_part_l0 { part_pred.mv_l0[0] } else { 0 },
                    mv_l0y: if uses_part_l0 { part_pred.mv_l0[1] } else { 0 },
                    mv_l1x: if uses_part_l1 { part_pred.mv_l1[0] } else { 0 },
                    mv_l1y: if uses_part_l1 { part_pred.mv_l1[1] } else { 0 },
                };
                field_motion[field].set_16x8(mb_x, mb_y >> 1, part, &state);
                *slot = MotionPartition {
                    ref_idx_l0: state.ref_idx_l0,
                    ref_idx_l1: state.ref_idx_l1,
                    mvd_l0x: if uses_part_l0 {
                        state.mv_l0x - p_l0[0]
                    } else {
                        0
                    },
                    mvd_l0y: if uses_part_l0 {
                        state.mv_l0y - p_l0[1]
                    } else {
                        0
                    },
                    mvd_l1x: if uses_part_l1 {
                        state.mv_l1x - p_l1[0]
                    } else {
                        0
                    },
                    mvd_l1y: if uses_part_l1 {
                        state.mv_l1y - p_l1[1]
                    } else {
                        0
                    },
                };
                modes[part] = PredictionMode::from_mb_type(part_pred.mb_type);
            }
            partitions = Some(built);
            field_modes = Some(modes);
        } else if field_pair && !direct_field_pair {
            let (Some(pair_top), Some(pair_bottom)) = (pair_top, pair_bottom) else {
                bail!("MBAFF macroblock pair is missing from the source");
            };
            let field = mb_y & 1;
            let field_preds = [
                prediction_for_field(
                    pair_top,
                    field,
                    pic.coding.top_field_first,
                    &ctx.layout,
                    pair_top.is_intra(),
                ),
                prediction_for_field(
                    pair_bottom,
                    field,
                    pic.coding.top_field_first,
                    &ctx.layout,
                    pair_bottom.is_intra(),
                ),
            ];
            let mut built = [MotionPartition::default(); 2];
            for (part, slot) in built.iter_mut().enumerate() {
                let field_pred = field_preds[part];
                let uses_field_l0 = field_pred.ref_idx_l0 >= 0;
                let uses_field_l1 = field_pred.ref_idx_l1 >= 0;
                let p_l0 = if uses_field_l0 {
                    field_motion[field].predict_16x8(
                        mb_x,
                        mb_y >> 1,
                        part,
                        0,
                        field_pred.ref_idx_l0,
                    )
                } else {
                    [0, 0]
                };
                let p_l1 = if uses_field_l1 {
                    field_motion[field].predict_16x8(
                        mb_x,
                        mb_y >> 1,
                        part,
                        1,
                        field_pred.ref_idx_l1,
                    )
                } else {
                    [0, 0]
                };
                field_motion[field].set_16x8(
                    mb_x,
                    mb_y >> 1,
                    part,
                    &MbMotion {
                        ref_idx_l0: field_pred.ref_idx_l0,
                        ref_idx_l1: field_pred.ref_idx_l1,
                        mv_l0x: if uses_field_l0 {
                            field_pred.mv_l0[0]
                        } else {
                            0
                        },
                        mv_l0y: if uses_field_l0 {
                            field_pred.mv_l0[1]
                        } else {
                            0
                        },
                        mv_l1x: if uses_field_l1 {
                            field_pred.mv_l1[0]
                        } else {
                            0
                        },
                        mv_l1y: if uses_field_l1 {
                            field_pred.mv_l1[1]
                        } else {
                            0
                        },
                    },
                );
                *slot = MotionPartition {
                    ref_idx_l0: field_pred.ref_idx_l0,
                    ref_idx_l1: field_pred.ref_idx_l1,
                    mvd_l0x: if uses_field_l0 {
                        field_pred.mv_l0[0] - p_l0[0]
                    } else {
                        0
                    },
                    mvd_l0y: if uses_field_l0 {
                        field_pred.mv_l0[1] - p_l0[1]
                    } else {
                        0
                    },
                    mvd_l1x: if uses_field_l1 {
                        field_pred.mv_l1[0] - p_l1[0]
                    } else {
                        0
                    },
                    mvd_l1y: if uses_field_l1 {
                        field_pred.mv_l1[1] - p_l1[1]
                    } else {
                        0
                    },
                };
            }
            partitions = Some(built);
            field_modes = Some([
                PredictionMode::from_mb_type(field_preds[0].mb_type),
                PredictionMode::from_mb_type(field_preds[1].mb_type),
            ]);
        }

        let mb_type = if split_frame_mb {
            b16x8_mb_type(mode, mode)
        } else if let Some(modes) = field_modes {
            b16x8_mb_type(modes[0], modes[1])
        } else {
            pred.mb_type
        };
        let ref_count = ctx.layout.count as i32;
        let mb = InterMacroblock {
            mb_x,
            mb_y: if field_pair { mb_y >> 1 } else { mb_y },
            p_slice: ctx.options.i_frames_only,
            mb_type,
            ref_idx_l0: pred.ref_idx_l0,
            ref_idx_l1: pred.ref_idx_l1,
            mvd_l0x: if uses_l0 {
                pred.mv_l0[0] - pred_l0[0]
            } else {
                0
            },
            mvd_l0y: if uses_l0 {
                pred.mv_l0[1] - pred_l0[1]
            } else {
                0
            },
            mvd_l1x: if uses_l1 {
                pred.mv_l1[0] - pred_l1[0]
            } else {
                0
            },
            mvd_l1y: if uses_l1 {
                pred.mv_l1[1] - pred_l1[1]
            } else {
                0
            },
            partitions,
            num_ref_idx_l0_minus1: if field_pair {
                if second_output_field && ctx.is_reference {
                    5
                } else {
                    ref_count * 2 - 1
                }
            } else {
                ref_count - 1
            },
            num_ref_idx_l1_minus1: if field_pair {
                if second_output_field && ctx.is_reference {
                    5
                } else {
                    ref_count * 2 - 1
                }
            } else {
                ref_count - 1
            },
            qp,
            prev_qp,
        };

        if direct_field_pair && partitions.is_none() {
            field_motion[mb_y & 1].set(
                mb_x,
                mb_y >> 1,
                &MbMotion {
                    ref_idx_l0: if uses_l0 { pred.ref_idx_l0 } else { -1 },
                    ref_idx_l1: if uses_l1 { pred.ref_idx_l1 } else { -1 },
                    mv_l0x: if uses_l0 { pred.mv_l0[0] } else { 0 },
                    mv_l0y: if uses_l0 { pred.mv_l0[1] } else { 0 },
                    mv_l1x: if uses_l1 { pred.mv_l1[0] } else { 0 },
                    mv_l1y: if uses_l1 { pred.mv_l1[1] } else { 0 },
                },
            );
        } else if !split_frame_mb && !field_pair {
            motion.set(
                mb_x,
                mb_y,
                &MbMotion {
                    ref_idx_l0: if uses_l0 { pred.ref_idx_l0 } else { -1 },
                    ref_idx_l1: if uses_l1 { pred.ref_idx_l1 } else { -1 },
                    mv_l0x: if uses_l0 { pred.mv_l0[0] } else { 0 },
                    mv_l0y: if uses_l0 { pred.mv_l0[1] } else { 0 },
                    mv_l1x: if uses_l1 { pred.mv_l1[0] } else { 0 },
                    mv_l1y: if uses_l1 { pred.mv_l1[1] } else { 0 },
                },
            );
        }

        // Every macroblock is coded explicitly. A B_Skip would mean direct mode,
        // whose derived vectors are not the ones the source used.
        writer.ue(0); // mb_skip_run
        if ctx.mbaff && !direct_field_pair && mb_y % 2 == 0 {
            // In P/B slices mb_field_decoding_flag follows mb_skip_run, unlike
            // an I slice where it immediately precedes mb_type.
            writer.flag(field_pair);
        }
        let field = mb_y & 1;
        let active_counts: &mut CoeffCountMap = if field_pair {
            &mut field_counts[field]
        } else {
            &mut *counts
        };
        let active_chroma_counts: &mut ChromaCounts = if field_pair {
            &mut field_chroma_counts[field]
        } else {
            &mut *chroma_counts
        };
        let luma: [Option<&[i32; 64]>; 4] =
            std::array::from_fn(|i| luma_active[i].then_some(&luma_scratch[i]));
        let chroma: Option<&[ChromaBlockLevels; 2]> = if !has_chroma {
            None
        } else if chroma_from_pair {
            Some(&pair_field_chroma[field])
        } else {
            Some(&chroma_scratch)
        };
        prev_qp = write_inter_macroblock(
            writer,
            active_counts,
            active_chroma_counts,
            &mb,
            &luma,
            chroma,
        )?;
        if !luma_active.iter().any(|&active| active) {
            mark_no_coefficients(active_counts, mb.mb_x, mb.mb_y);
        }
        if chroma.is_none() {
            mark_no_chroma_coefficients(active_chroma_counts, mb.mb_x, mb.mb_y);
        }
        let end_of_field =
            direct_field_pair && mb_x == g.mb_width - 1 && field_position == field_size - 1;
        if end_of_field || (!direct_field_pair && mb_x == g.mb_width - 1 && mb_y == g.mb_height - 1)
        {
            writer.rbsp_trailing_bits();
            picture_nals.extend_from_slice(&to_nal_unit(
                writer.bytes(),
                if ctx.real_idr {
                    3
                } else if ctx.is_reference {
                    2
                } else {
                    0
                },
                if ctx.real_idr {
                    nal_type::SLICE_IDR
                } else {
                    nal_type::SLICE_NON_IDR
                },
            ));
            if direct_field_pair && !second_output_field {
                slice_open = false;
                continue;
            }
            return Ok(picture_nals);
        }
    }

    unreachable!("a picture geometry always contains a final macroblock")
}

#[cfg(test)]
mod tests {
    use super::{
        dual_prime_opposite, field_picture_ref_index, field_picture_selected_parity, rounded_half,
    };
    use crate::mpeg2::constants::mb_flag;

    #[test]
    fn an_uncoded_p_field_vector_infers_same_parity() {
        assert_eq!(field_picture_selected_parity(false, 0, 0, 1, 0), 1);
        assert_eq!(
            field_picture_selected_parity(false, mb_flag::MOTION_FORWARD, 0, 1, 0),
            0
        );
    }

    #[test]
    fn h262_half_rounds_ties_away_from_zero() {
        assert_eq!(rounded_half(3), 2);
        assert_eq!(rounded_half(-3), -2);
        assert_eq!(rounded_half(2), 1);
        assert_eq!(rounded_half(-2), -1);
    }

    #[test]
    fn dual_prime_uses_the_field_distance_and_parity_offset() {
        let coded = [3, -3];
        let differential = [1, -1];
        assert_eq!(
            dual_prime_opposite(coded, differential, 0, true, true),
            [3, -4],
            "top field is one field interval from the opposite reference"
        );
        assert_eq!(
            dual_prime_opposite(coded, differential, 1, true, true),
            [6, -5],
            "bottom field is three field intervals from the opposite reference"
        );
    }

    #[test]
    fn b_field_lists_start_with_the_current_parity() {
        assert_eq!(field_picture_ref_index(0, 0, 0, false, true), 0);
        assert_eq!(field_picture_ref_index(0, 1, 0, false, true), 1);
        assert_eq!(field_picture_ref_index(0, 1, 1, false, true), 0);
        assert_eq!(field_picture_ref_index(0, 0, 1, false, true), 1);
    }

    #[test]
    fn p_field_lists_also_start_with_the_current_parity() {
        assert_eq!(field_picture_ref_index(0, 0, 0, false, true), 0);
        assert_eq!(field_picture_ref_index(0, 1, 0, false, true), 1);
        assert_eq!(field_picture_ref_index(0, 1, 1, false, true), 0);
        assert_eq!(field_picture_ref_index(0, 0, 1, false, true), 1);
    }

    #[test]
    fn a_second_reference_field_keeps_the_first_field_at_index_one() {
        // The older same-parity field remains first. The already decoded first
        // field of the current pair is the opposite-parity entry immediately
        // after it.
        assert_eq!(field_picture_ref_index(0, 1, 1, true, true), 0);
        assert_eq!(field_picture_ref_index(0, 0, 1, true, true), 1);
    }
}
