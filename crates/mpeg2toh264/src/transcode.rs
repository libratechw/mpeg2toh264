//! MPEG-2 to H.264 transcoding.
//!
//! The normal path reconstructs no pixels on the luma path: MPEG-2 coefficient
//! levels are dequantised into orthonormal-DCT values and requantised straight
//! into H.264 levels, with no inverse transform, no motion compensation and no
//! reference frame buffer. Chroma is the exception and is documented in
//! [`crate::h264::chroma`].
//!
//! The one place pixels are unavoidable is the very first picture of a random
//! access point, which has nothing to predict from: it is reconstructed and
//! emitted as an I_PCM IDR. Every later picture predicts, so it goes back
//! through the coefficient path.
//!
//! Every output picture is a B slice, even those that were I or P in the source,
//! because the half-sample motion mapping needs bi-prediction and that is only
//! available in B slices. See [`crate::h264::mvmap`].

use crate::bitreader::BitReader;
use crate::error::{bail, Result};
use crate::h264::bitwriter::{nal_type, to_nal_unit, BitWriter};
use crate::h264::chroma::{
    chroma_qp, convert_chroma_block, convert_field_chroma_pair, ChromaBlockLevels,
    FieldChromaScratch, FieldChromaSource,
};
use crate::h264::intra_pcm::reconstruct_intra_pcm;
use crate::h264::mb::{
    b16x8_mb_type, b_mb_type, make_luma_counts, mark_no_chroma_coefficients, mark_no_coefficients,
    to_zigzag_8x8, write_inter_macroblock, write_pcm_macroblock, ChromaCounts, CoeffCountMap,
    InterMacroblock, MotionPartition, PcmMacroblockSamples, PcmSliceType, PredictionMode,
};
use crate::h264::mvmap::{map_vector, native_position, VectorKind};
use crate::h264::mvpred::{MbMotion, MotionField};
use crate::h264::params::{
    frame_geometry, write_pps, write_sps, FrameGeometry, PpsConfig, SpsConfig,
};
use crate::h264::quant::{
    field_dct_to_frame_targets, frame_dct_to_field_targets, inter_targets, intra_targets,
    Quantiser8x8, DEFAULT_OVERSAMPLE,
};
use crate::h264::slice::{write_slice_header, SliceHeaderConfig, SliceType};
use crate::mpeg2::constants::{mb_flag, PictureStructure, PictureType, QUANTISER_SCALE};
use crate::mpeg2::headers::{
    parse_elementary_stream, picture_geometry, sequence_sample_aspect_ratio, Picture,
};
use crate::mpeg2::macroblock::{decode_slice, motion_type, Macroblock};

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

pub struct IncrementalTranscoder {
    options: TranscodeOptions,
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
        // Field pictures are ruled out here; field DCT and field motion are
        // caught per macroblock instead, because clearing frame_pred_frame_dct
        // only *permits* them and progressive content often carries that flag
        // without a single field-coded macroblock in the stream.
        if let Some(field_picture) = pics
            .iter()
            .find(|p| p.coding.picture_structure != PictureStructure::Frame)
        {
            bail!(
                "field pictures: this needs PAFF or MBAFF, which is not implemented \
                 (picture_structure={})",
                field_picture.coding.picture_structure.code()
            );
        }

        let g = frame_geometry(width, height, !mbaff);
        let scaling = first.quant.non_intra;

        let random_access = self.initialized && self.random_access_pending;
        let mut parts: Vec<Vec<u8>> = Vec::new();
        if !self.initialized {
            parts.push(write_sps(&SpsConfig {
                width,
                height,
                level_idc: if width * height > 720 * 576 { 40 } else { 30 },
                frame_mbs_only: !mbaff,
                // The long-term flat-prediction picture plus the two most recent
                // I or P pictures, which are what a B picture predicts from. The
                // count also fixes how many short-term pictures the sliding
                // window keeps, so the reference indices in RefLayout depend on
                // it.
                max_num_ref_frames: 3,
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
        let mut counts = make_luma_counts(g.mb_width, g.mb_height);
        let mut chroma_counts = ChromaCounts::new(g.mb_width, g.mb_height);
        let mut motion = MotionField::new(g.mb_width, g.mb_height);
        let mut reader = BitReader::new(data);
        // One picture's macroblocks, reused by every picture in the group. At
        // an HD macroblock count this is several megabytes, and handing it back
        // to the allocator after each picture only to fault it in again for the
        // next is most of what the pictures cost outside their own coding.
        let mut by_address: Vec<Option<Macroblock>> = Vec::new();
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

        for pic in &pics {
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
                    count: 3,
                    fwd_l0: 0,
                    fwd_l1: 1,
                    bwd_l0: 1,
                    bwd_l1: 0,
                    flat: 2,
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
            // Emptying the slots one by one writes a discriminant each, where
            // resizing from empty writes a whole macroblock -- five megabytes a
            // picture, which the browser build pays for in memset.
            let cells = geo.mb_width * geo.mb_height;
            if by_address.len() == cells {
                for slot in by_address.iter_mut() {
                    *slot = None;
                }
            } else {
                by_address.clear();
                by_address.resize_with(cells, || None);
            }
            for slice in &pic.slices {
                decode_slice(&mut reader, pic, slice, geo.mb_width, &mut by_address)?;
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
            parts.push(write_picture(
                pic,
                &by_address,
                &g,
                &quant,
                &mut counts,
                &mut chroma_counts,
                &mut motion,
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
                    parts.push(write_reference_clone(&g, mbaff));
                    prev_ref_frame_num = 1;
                    short_term_count = 1;
                }
            } else if is_reference {
                prev_ref_frame_num = frame_num;
                short_term_count = (short_term_count + 1).min(2);
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
    let field_ref = |frame_ref: i32, direction: usize| -> i32 {
        if !field_motion {
            return frame_ref * 2;
        }
        let ref_parity = mb.field_select[field * 2 + direction] as usize;
        // MBAFF field lists expand each frame entry into same-parity then
        // opposite-parity fields for the current macroblock.
        frame_ref * 2 + i32::from(ref_parity != field)
    };
    let vector = |direction: usize| -> [i32; 2] {
        let base = if field_motion { field * 4 } else { 0 } + direction * 2;
        [mb.mv[base], mb.mv[base + 1]]
    };
    let native = |direction: usize| -> [i32; 2] {
        let [x, y] = vector(direction);
        // A frame vector's vertical half-sample unit is one quarter sample on
        // the field grid. Field-format vectors have already been scaled by the
        // MPEG decoder and use the ordinary mapping in MBAFF coordinates.
        if field_motion {
            native_position(x, y)
        } else {
            [x * 2, y]
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
    by_address: &[Option<Macroblock>],
    g: &FrameGeometry,
    quant: &Quantiser8x8,
    counts: &mut CoeffCountMap,
    chroma_counts: &mut ChromaCounts,
    motion: &mut MotionField,
    ctx: &PictureContext,
    stats: &mut Stats,
    writer: &mut BitWriter,
) -> Result<Vec<u8>> {
    let mut nal_parts: Vec<Vec<u8>> = Vec::new();

    let mut targets = [[0.0f32; 64]; 4];
    let mut field_targets = [[0.0f32; 64]; 4];
    let mut raster = [0i32; 64];
    let mut luma_scratch = [[0i32; 64]; 4];
    let mut chroma_scratch: [ChromaBlockLevels; 2] =
        std::array::from_fn(|_| ChromaBlockLevels::default());
    let mut field_chroma_scratch = FieldChromaScratch::default();
    // Indexed [field][component].
    let mut pair_field_chroma: [[ChromaBlockLevels; 2]; 2] =
        std::array::from_fn(|_| std::array::from_fn(|_| ChromaBlockLevels::default()));
    let mut field_motion = [
        MotionField::new(g.mb_width, g.mb_height >> 1),
        MotionField::new(g.mb_width, g.mb_height >> 1),
    ];
    let mut field_counts = [
        make_luma_counts(g.mb_width, g.mb_height >> 1),
        make_luma_counts(g.mb_width, g.mb_height >> 1),
    ];
    let mut field_chroma_counts = [
        ChromaCounts::new(g.mb_width, g.mb_height >> 1),
        ChromaCounts::new(g.mb_width, g.mb_height >> 1),
    ];
    let mut prev_qp = PPS_INIT_QP;
    let mut slice_open = false;
    let output_slice_type = if ctx.real_idr {
        SliceType::I
    } else if ctx.options.i_frames_only {
        SliceType::P
    } else {
        SliceType::B
    };
    let picture_field_pairs =
        ctx.mbaff && !ctx.options.i_frames_only && pic.header.picture_coding_type != PictureType::I;
    let mut cached_pair_address: isize = -1;
    let mut cached_pair_targets = [FieldTargetSet::default(); 2];
    let mut cached_pair_qp = PPS_INIT_QP;
    let mut qp_by_scale = [-1i16; 256];
    let mut pair_raw_targets = [[[0.0f32; 64]; 4]; 2];
    let mut pair_converted_targets = [[[0.0f32; 64]; 4]; 2];
    let concealment = PcmMacroblockSamples::grey();
    let oversample = ctx.options.oversample;

    // MBAFF addresses macroblocks pair-by-pair: top then bottom at one X,
    // followed by the next pair horizontally. Frame-only pictures use raster
    // order. Coordinates remain spatial so coefficient and MV neighbour lookup
    // does not otherwise change for frame-coded pairs.
    let position_count = g.mb_width * g.mb_height;
    for position in 0..position_count {
        let pair_address = position >> 1;
        let mb_x = if ctx.mbaff {
            pair_address % g.mb_width
        } else {
            position % g.mb_width
        };
        let mb_y = if ctx.mbaff {
            (pair_address / g.mb_width) * 2 + (position & 1)
        } else {
            position / g.mb_width
        };

        if !slice_open {
            counts.reset();
            chroma_counts.reset();
            motion.reset();
            for field in &mut field_motion {
                field.reset();
            }
            for map in &mut field_counts {
                map.reset();
            }
            for maps in &mut field_chroma_counts {
                maps.reset();
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
                    pic_order_cnt_lsb: ctx.poc,
                    log2_max_poc_lsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
                    idr: ctx.real_idr,
                    // The IDR is the flat-prediction reference for everything
                    // that follows, so it has to survive the sliding window.
                    long_term_reference: ctx.real_idr,
                    reference: ctx.is_reference,
                    mbaff: ctx.mbaff,
                    slice_qp: PPS_INIT_QP,
                    pps_init_qp: PPS_INIT_QP,
                    disable_deblocking_filter_idc: 1,
                    num_ref_idx_l0_active: Some(ctx.layout.count),
                    num_ref_idx_l1_active: Some(ctx.layout.count),
                    l1_first_short_term_delta: ctx.layout.force_l1_short_term.then_some(1),
                    flat_pred_ref_idx: Some(ctx.layout.flat as u32),
                    ..Default::default()
                },
            );
            slice_open = true;
        }

        let source = by_address
            .get(mb_y * g.mb_width + mb_x)
            .and_then(Option::as_ref);
        let pair_top = by_address
            .get((mb_y & !1) * g.mb_width + mb_x)
            .and_then(Option::as_ref);
        let pair_bottom = by_address
            .get(((mb_y & !1) + 1) * g.mb_width + mb_x)
            .and_then(Option::as_ref);
        // Use a uniform coding mode across an MBAFF picture. This makes every
        // horizontal and vertical neighbour live in the same field coordinate
        // system, so thousands of pair-isolating slices are unnecessary.
        let field_pair = picture_field_pairs;
        let intra = match source {
            Some(mb) if !mb.skipped => mb.is_intra(),
            _ => false,
        };

        // The IDR opening a random access point has nothing to predict from, so
        // it is the one picture reconstructed in the pixel domain. Its slice is
        // I_PCM throughout, which leaves no neighbour coefficient counts, motion
        // vectors or QP for anything to read back.
        if ctx.real_idr {
            stats.intra_macroblocks += 1;
            if ctx.mbaff && mb_y % 2 == 0 {
                writer.flag(false); // frame-coded MB pair
            }
            let samples = match source {
                Some(mb) if intra => reconstruct_intra_pcm(mb, pic)?,
                _ => concealment.clone(),
            };
            write_pcm_macroblock(writer, PcmSliceType::I, &samples);
            if mb_x == g.mb_width - 1 && mb_y == g.mb_height - 1 {
                writer.rbsp_trailing_bits();
                nal_parts.push(to_nal_unit(writer.bytes(), 3, nal_type::SLICE_IDR));
                slice_open = false;
            }
            continue;
        }

        let mut luma_active = [false; 4];
        let mut has_chroma = false;
        let mut chroma_from_pair = false;
        let mut qp = prev_qp;

        if !field_pair {
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
                        let target = if source.dct_type == 1 {
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
                    if source.dct_type == 1 {
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
                    for b in 0..4 {
                        quant.levels_for(&targets[b], qp, &mut raster);
                        luma_active[b] = to_zigzag_8x8(&raster, &mut luma_scratch[b], false);
                    }

                    let qp_c = chroma_qp(qp, CHROMA_QP_OFFSET);
                    for c in 0..2 {
                        match source.block(4 + c) {
                            Some(block) => convert_chroma_block(
                                block,
                                chroma_matrix,
                                quantiser_scale,
                                pic.coding.intra_dc_precision,
                                qp_c,
                                &mut chroma_scratch[c],
                                intra,
                            ),
                            None => chroma_scratch[c].clear(),
                        }
                    }
                    has_chroma = !chroma_scratch[0].is_empty() || !chroma_scratch[1].is_empty();
                }
            }
        }

        if field_pair {
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
                quant.levels_for(selected, qp, &mut raster);
                luma_active[b] = to_zigzag_8x8(&raster, &mut luma_scratch[b], true);
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
        if field_pair {
            count_field_pair_vector(source, intra, &ctx.layout, stats);
        }
        let pred = if field_pair {
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
        let pred_l0 = if !field_pair && uses_l0 {
            motion.predict(mb_x, mb_y, 0, pred.ref_idx_l0)
        } else {
            [0, 0]
        };
        let pred_l1 = if !field_pair && uses_l1 {
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
        } else if field_pair {
            let (Some(pair_top), Some(pair_bottom)) = (pair_top, pair_bottom) else {
                bail!("MBAFF macroblock pair is missing from the source");
            };
            let field = mb_y & 1;
            let field_preds = [
                prediction_for_field(pair_top, field, &ctx.layout, pair_top.is_intra()),
                prediction_for_field(pair_bottom, field, &ctx.layout, pair_bottom.is_intra()),
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
                ref_count * 2 - 1
            } else {
                ref_count - 1
            },
            num_ref_idx_l1_minus1: if field_pair {
                ref_count * 2 - 1
            } else {
                ref_count - 1
            },
            qp,
            prev_qp,
        };

        if !split_frame_mb && !field_pair {
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
        if ctx.mbaff && mb_y % 2 == 0 {
            // In P/B slices mb_field_decoding_flag follows mb_skip_run, unlike
            // the I_PCM IDR slice where it immediately precedes mb_type.
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
        if mb_x == g.mb_width - 1 && mb_y == g.mb_height - 1 {
            writer.rbsp_trailing_bits();
            nal_parts.push(to_nal_unit(
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
            slice_open = false;
        }
    }

    let total: usize = nal_parts.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(total);
    for part in &nal_parts {
        out.extend_from_slice(part);
    }
    Ok(out)
}
