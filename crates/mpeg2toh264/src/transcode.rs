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
use crate::container::fmp4::{complementary_field, picture_end};
use crate::error::{bail, Result};
use crate::h264::bitwriter::{nal_type, to_nal_unit, BitWriter};
use crate::h264::chroma::{
    chroma_qp, convert_chroma_block, convert_field_chroma_pair, convert_intra_chroma_block,
    ChromaBlockLevels, FieldChromaScratch, FieldChromaSource, FIELD_SCAN_4X4,
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
use crate::h264::slice::{
    write_slice_header, RefPicList, RefPicListEntry, SliceHeaderConfig, SliceType,
};
use crate::job::{
    PictureContext, PictureJob, PictureOutput, RefLayout, ShortTermFrames, TranscoderState,
    JOB_HEADER_LEN, MAX_SHORT_TERM_FRAMES,
};
use crate::mpeg2::constants::{mb_flag, PictureStructure, PictureType, QUANTISER_SCALE};
use crate::mpeg2::headers::{
    parse_elementary_stream, picture_geometry, picture_sequence_description, Picture,
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
/// `max_num_ref_frames`, which is also when the sliding window starts pushing
/// pictures out: three short-term frames and the long-term one.
const MAX_NUM_REF_FRAMES: u32 = 4;
/// Picture order counts advance by this much per source frame.
///
/// Four, not the two a pair of fields needs, because a random access point puts
/// two pictures where the source had one: an IDR that may be a field pair and
/// so takes counts 0 and 1, and the copy of it that carries the flat prediction
/// at 2. Content has to start above all three, and stepping by four leaves each
/// frame's own pair of counts adjacent.
const POC_PER_FRAME: u32 = 4;
/// The order count of the copy that follows the IDR, which displays between the
/// IDR and the first content picture.
const CLONE_POC: u32 = 2;
/// `LongTermFrameIdx` of that copy, the only long-term picture there ever is.
const LONG_TERM_FRAME_IDX: u32 = 0;

/// What to do with the source video.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum VideoMode {
    /// Convert it to H.264, which is what every browser can decode.
    #[default]
    Transcode,
    /// Carry the MPEG-2 through into the MP4 as it stands, for a player whose
    /// decoder handles it. Nothing is requantised, so the picture is the
    /// broadcast's own and the conversion costs almost nothing -- but a decoder
    /// that does not take MPEG-2 plays none of it.
    Passthrough,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum OpenGopRecovery {
    /// Preserve every leading picture, then emit a real IDR and its reference
    /// clone after them. This costs two additional samples at each recovery
    /// boundary, but gives hardware decoders an unambiguous restart point.
    #[default]
    Idr,
    /// Preserve every leading picture and use the independently coded source
    /// intra picture as a non-IDR recovery point.
    RecoveryPoint,
    /// Discard leading pictures and restart the decoded picture buffer at the
    /// source intra picture.
    Discard,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct TranscodeOptions {
    pub oversample: f64,
    /// Put a recovery point at every this many GOPs. Its handling is selected
    /// by [`Self::open_gop_recovery`].
    pub recovery_interval: usize,
    /// How an open GOP becomes independently decodable at a periodic recovery
    /// boundary.
    pub open_gop_recovery: OpenGopRecovery,
    /// Put the two coded fields of a complementary pair in separate access
    /// units, and so in separate MP4 samples. On by default, because both
    /// break where frame pictures give way to field pictures: Firefox on
    /// Windows freezes, and a pair sharing a sample decodes to an image of
    /// `CVFieldCount` 2 where a frame picture gives 1, which Safari fails on
    /// because WebKit reuses the format description it cached from the first
    /// decoded image. Only an access unit delimiter moves, so the elementary
    /// stream is the same either way.
    pub split_field_samples: bool,
    /// Ignored by [`transcode`] itself, which is the conversion; it is
    /// [`crate::Session`] that decides between the two paths.
    pub video: VideoMode,
}

impl Default for TranscodeOptions {
    fn default() -> Self {
        Self {
            oversample: DEFAULT_OVERSAMPLE,
            recovery_interval: 24,
            open_gop_recovery: OpenGopRecovery::default(),
            split_field_samples: true,
            video: VideoMode::default(),
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
    /// Macroblocks with both prediction slots already spoken for, so H.264's
    /// own sub-sample filter runs in place of MPEG-2's bilinear. Bidirectional
    /// macroblocks are the usual case; the second field of a random access
    /// point is the other, its list 1 carrying the flat prediction.
    pub bidirectional_vectors: u64,
    pub intra_macroblocks: u64,
    pub inter_macroblocks: u64,
    /// Pictures discarded because they could not be decoded.
    pub dropped: u64,
    /// Pictures containing at least one malformed slice.
    pub errors: u64,
}

impl Stats {
    /// Take one picture's counts into a running total. Pictures are counted
    /// wherever they happen to be converted, so the totals are added up rather
    /// than accumulated in place.
    pub fn add(&mut self, other: &Stats) {
        self.integer_vectors += other.integer_vectors;
        self.single_axis_half_vectors += other.single_axis_half_vectors;
        self.both_axis_half_vectors += other.both_axis_half_vectors;
        self.bidirectional_vectors += other.bidirectional_vectors;
        self.intra_macroblocks += other.intra_macroblocks;
        self.inter_macroblocks += other.inter_macroblocks;
        self.dropped += other.dropped;
        self.errors += other.errors;
    }
}

#[derive(Clone, Debug)]
pub struct TranscodeResult {
    pub bitstream: Vec<u8>,
    pub pictures_converted: usize,
    pub pictures_skipped: usize,
    pub stats: Stats,
    /// Whether this result carries a non-IDR recovery picture.
    pub recovery_point: bool,
    /// Which of the unit's source pictures would not decode, indexed by
    /// picture. Empty when none of them were, which is the ordinary case.
    ///
    /// The MP4 timeline has to drop exactly these, and cannot find them for
    /// itself without decoding every slice a second time. This is the report
    /// that saves it the walk; see [`crate::mpeg2_video_timeline`].
    pub undecodable: Vec<bool>,
}

/// The neighbour state a picture's coding reads back, kept between pictures.
///
/// Every picture starts from these empty, so what they hold is never carried
/// over -- but at an HD macroblock count they are several megabytes between
/// them, and asking the allocator for that per picture costs more than the
/// emptying does. In the browser build it costs more still, since the zeroing
/// an allocation comes with is a memset there.
struct PictureScratch {
    /// What the buffers below are sized for. A stream that changes its frame
    /// size mid-way reaches an encoder holding the ones it made for the size
    /// before it, and every one of them is indexed by the old macroblock width.
    mb_width: usize,
    mb_height: usize,
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
            mb_width,
            mb_height,
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

/// One piece of a unit's assembled bitstream.
///
/// The plan knows the order everything goes in before any of it is coded, which
/// is what lets the pictures be coded anywhere and in any order: the assembly
/// only has to drop each result into the slot held for it.
enum Part {
    /// Bytes the plan already has: parameter sets, delimiters, the recovery
    /// point message, the copy that follows an IDR.
    Literal(Vec<u8>),
    /// Whatever the job at this index turns into.
    Picture(usize),
}

/// What a caller wants of one unit, beyond the conversion itself.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct UnitRequest {
    /// Restart the decoded picture buffer here, at an IDR.
    pub random_access: bool,
    /// Make the unit's first intra picture a recovery point, without flushing
    /// the references an open group's leading pictures need.
    pub recovery_point: bool,
    /// Put the parameter sets in front of the unit again even though nothing
    /// they say has changed. The MP4 initialization segment is built from them,
    /// so this is what a caller that has to send another one asks for -- when
    /// the sound has changed its configuration, say, and the video's own
    /// description is as it was.
    pub description: bool,
}

/// What one unit becomes, worked out from its headers alone.
///
/// Nothing here has decoded a slice. The plan assumes every picture it keeps
/// will decode, because finding out costs as much as the conversion itself and
/// would leave that cost on whichever thread walks the stream. A picture that
/// turns out not to decode is answered by planning the unit again, this time
/// told which ones to leave out; see [`IncrementalTranscoder::push`].
pub struct UnitPlan {
    parts: Vec<Part>,
    /// One per picture the unit codes, in output order.
    pub jobs: Vec<PictureJob>,
    /// What a transcoder carries away from this unit, if the plan holds.
    pub state: TranscoderState,
    pictures_converted: usize,
    pictures_skipped: usize,
    recovery_emitted: bool,
    /// Whether the parameter sets went in front of this unit, which is what
    /// gives the fragment it becomes an initialization segment.
    described: bool,
}

impl UnitPlan {
    /// Take the jobs' bytes out to be converted, leaving behind which source
    /// pictures each was for. Handing them over rather than copying them is
    /// what keeps a unit's bytes crossing to a worker once.
    pub fn take_jobs(&mut self) -> Vec<Vec<u8>> {
        self.jobs
            .iter_mut()
            .map(|job| std::mem::take(&mut job.data))
            .collect()
    }

    /// Put the coded pictures back into the order the plan laid out for them.
    pub fn assemble(&self, outputs: &[PictureOutput]) -> Vec<u8> {
        let total: usize = self
            .parts
            .iter()
            .map(|part| match part {
                Part::Literal(bytes) => bytes.len(),
                Part::Picture(index) => outputs[*index].bitstream.len(),
            })
            .sum();
        let mut bitstream = Vec::with_capacity(total);
        for part in &self.parts {
            match part {
                Part::Literal(bytes) => bitstream.extend_from_slice(bytes),
                Part::Picture(index) => bitstream.extend_from_slice(&outputs[*index].bitstream),
            }
        }
        bitstream
    }
}

/// Work out what one unit turns into, without decoding any of it.
///
/// `undecodable`, indexed by source picture, names the pictures a previous
/// attempt found damaged. It is empty on the first attempt, which is what makes
/// this a walk of headers rather than of macroblocks.
pub fn plan_unit(
    data: &[u8],
    start: &TranscoderState,
    options: TranscodeOptions,
    request: UnitRequest,
    undecodable: &[bool],
) -> Result<UnitPlan> {
    let pics = parse_elementary_stream(data)?;
    let Some(first) = pics.first() else {
        bail!("no pictures in stream");
    };

    let description = picture_sequence_description(first);
    let width = description.width;
    let height = description.height;
    let mbaff = description.mbaff;
    // A stream that changes what its sequence header says is coded under
    // parameter sets that have not gone out. New ones can, but H.264 activates
    // a sequence parameter set only at an IDR, so the change restarts the
    // decoded picture buffer as well. Whoever is drawing the MP4 timeline for
    // this unit has to have reached the same verdict already, from
    // [`stream_sequence_description`]: the timeline is settled before the plan
    // is made, and it is what says the fragment opens at a random access point.
    //
    // [`stream_sequence_description`]: crate::mpeg2::headers::stream_sequence_description
    // A caller may also ask for them where nothing they say has changed,
    // because what it needs is the initialization segment built from them.
    let redescribe = request.description || !start.initialized || description != start.description;
    let random_access =
        request.random_access || (start.initialized && description != start.description);

    // Interlaced coding is not handled by the frame path. A field-DCT
    // macroblock builds its 8x8 blocks from alternate lines and field motion
    // predicts each field separately; representing either in H.264 needs
    // macroblock-adaptive frame/field coding.
    //
    // Field pictures are paired below and represented as one MBAFF frame.

    let g = frame_geometry(width, height, !mbaff);
    // The scaling list the PPS declares, and so what every picture in this unit
    // is requantised against, whatever its own matrices say. A source that
    // adapts them picture by picture -- which some broadcast encoders do,
    // several times within one group -- is coded against this one rather than
    // dropped, and the quantiser search absorbs the difference: the step it
    // picks scales with the list the decoder holds.
    let scaling = first.quant.non_intra;

    let mut parts: Vec<Part> = Vec::new();
    let mut description_parts: Vec<Part> = Vec::new();
    if redescribe {
        description_parts.push(Part::Literal(write_sps(&SpsConfig {
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
            max_num_ref_frames: MAX_NUM_REF_FRAMES,
            log2_max_frame_num_minus4: LOG2_MAX_FRAME_NUM_MINUS4,
            log2_max_poc_lsb_minus4: LOG2_MAX_POC_LSB_MINUS4,
            // An MPEG-2 stream codes its anchor picture before the B
            // pictures that display ahead of it, so one picture has to be
            // held back.
            max_num_reorder_frames: Some(1),
            max_dec_frame_buffering: Some(4),
            sample_aspect_ratio: description.sample_aspect_ratio,
        })));
        description_parts.push(Part::Literal(write_pps(&PpsConfig {
            init_qp: PPS_INIT_QP,
            scaling_8x8_intra: Some(&scaling),
            scaling_8x8_inter: Some(&scaling),
            chroma_qp_index_offset: CHROMA_QP_OFFSET,
        })));
    }

    let mut jobs: Vec<PictureJob> = Vec::new();
    let mut pictures_converted = 0usize;
    let mut pictures_skipped = 0usize;
    let mut recovery_emitted = false;
    let mut pending_recovery_copy: Option<(usize, Option<usize>, u32)> = None;

    // A stream restarting at a random access point has an empty decoded picture
    // buffer and an unstarted display order, so it begins from nothing.
    let mut state = if random_access {
        start.restarted()
    } else {
        *start
    };

    // Where each picture's bytes begin, which is where the one before it ended.
    // A picture that is dropped leaves its bytes to the one that follows, since
    // a header among them describes that picture too.
    let mut starts = Vec::with_capacity(pics.len());
    let mut at = 0;
    for pic in &pics {
        starts.push(at);
        at = picture_end(pic, at);
    }

    let mut logical_pictures = Vec::with_capacity(pics.len());
    let mut source_index = 0;
    while source_index < pics.len() {
        let pic = &pics[source_index];
        if pic.coding.picture_structure == PictureStructure::Frame {
            logical_pictures.push((source_index, None));
            source_index += 1;
            continue;
        }
        let Some(_) = complementary_field(pics.get(source_index + 1), pic) else {
            // Carried through unpaired so the group's temporal references
            // still account for it, and dropped below.
            logical_pictures.push((source_index, None));
            source_index += 1;
            continue;
        };
        logical_pictures.push((source_index, Some(source_index + 1)));
        source_index += 2;
    }
    let has_field_pairs = logical_pictures.iter().any(|(_, mate)| mate.is_some());

    let emit_recovery_copy = |parts: &mut Vec<Part>,
                              jobs: &mut Vec<PictureJob>,
                              state: &mut TranscoderState,
                              source: usize,
                              mate: Option<usize>,
                              _poc: u32| {
        let layout = RefLayout {
            count: 1,
            fwd_l0: 0,
            fwd_l1: 0,
            bwd_l0: -1,
            bwd_l1: -1,
            flat: 0,
            l1_short_term_delta: None,
            anchor_second_field: false,
        };
        let ctx = PictureContext {
            frame_num: 0,
            poc: 0,
            is_reference: true,
            layout,
            short_term: ShortTermFrames::default(),
            options,
            mbaff,
            real_idr: true,
            recovery_intra: false,
            weight_scale: scaling,
            picture_count: if mate.is_some() { 2 } else { 1 },
        };
        if has_field_pairs {
            parts.push(Part::Literal(write_access_unit_delimiter()));
        }
        parts.push(Part::Literal(write_recovery_point_sei()));
        parts.push(Part::Picture(jobs.len()));
        jobs.push(PictureJob {
            index: jobs.len(),
            source,
            mate,
            data: job_bytes(data, &pics, &starts, source, mate, &ctx),
        });
        // Keep the IDR in the long-term slot and put a skipped-P clone in the
        // short-term chain. For a field pair the frame-coded clone marks the
        // complete pair long-term.
        if has_field_pairs {
            parts.push(Part::Literal(write_access_unit_delimiter()));
        }
        parts.push(Part::Literal(write_reference_clone(
            &g,
            mbaff,
            mate.is_some(),
        )));
        state.prev_ref_frame_num = 1;
        state.short_term_count = 1;
        state.newest_short_term = 1;
        state.short_term.clear();
        state.short_term.push(1);
        // The IDR resets PicOrderCntMsb and PicOrderCntLsb. Keep the pictures
        // after it in that new POC epoch too: leaving the stream-wide GOP base
        // in place crosses half of MaxPicOrderCntLsb after about 4.5 minutes,
        // at which point clause 8.2.1 derives the preceding POC cycle.
        state.gop_base = 0;
    };

    for &(source, mate) in &logical_pictures {
        let pic = &pics[source];
        let picture_type = pic.header.picture_coding_type;
        if let Some((copy_source, copy_mate, copy_poc)) = pending_recovery_copy {
            let leading = picture_type == PictureType::B
                && pic.header.temporal_reference < pics[copy_source].header.temporal_reference;
            if !leading {
                emit_recovery_copy(
                    &mut parts,
                    &mut jobs,
                    &mut state,
                    copy_source,
                    copy_mate,
                    copy_poc,
                );
                pending_recovery_copy = None;
            }
        }
        if !picture_type.is_ipb() {
            pictures_skipped += 1;
            continue;
        }
        let tr = pic.header.temporal_reference;
        if pic.starts_gop && state.seen_picture {
            state.gop_base += state.max_tr_in_gop + 1;
            state.max_tr_in_gop = 0;
        }
        state.seen_picture = true;
        state.max_tr_in_gop = state.max_tr_in_gop.max(tr);

        // A lone field is no frame. The MP4 timeline drops it for the same
        // reason and has to make the identical decision.
        if mate.is_none() && pic.coding.picture_structure != PictureStructure::Frame {
            pictures_skipped += 1;
            continue;
        }
        // A unit is coded under the description it opens with, and that is what
        // the parameter sets in front of it say. A picture coded under another
        // one belongs to the next unit: the group splitter cuts where the
        // description changes, so what reaches here is a change with no group
        // boundary behind it to cut on -- the tail of a recording, or a whole
        // stream handed over in one piece. The MP4 timeline drops it for the
        // same reason and has to make the identical decision.
        if picture_sequence_description(pic) != description {
            pictures_skipped += 1;
            continue;
        }
        // A B picture needs both of its references present.
        if picture_type == PictureType::B && state.short_term_count < 2 {
            pictures_skipped += 1;
            continue;
        }
        // Nothing can be coded before the IDR that starts the decoded
        // picture buffer, and only an I picture can become one.
        let real_idr = state.awaiting_idr && picture_type == PictureType::I;
        if state.awaiting_idr && !real_idr {
            pictures_skipped += 1;
            continue;
        }
        // A damaged slice takes its picture with it, and a unit that begins
        // part way through one has every slice truncated. This is the one
        // thing the walk cannot see for itself: it is what a previous attempt
        // reported back. The MP4 timeline reaches the same verdict from the
        // same report, so the two stay in step.
        let is_undecodable = |index: usize| undecodable.get(index).copied().unwrap_or(false);
        if is_undecodable(source) || mate.is_some_and(is_undecodable) {
            pictures_skipped += 1;
            continue;
        }
        let is_reference = real_idr || picture_type != PictureType::B;
        let recovery_intra = request.recovery_point
            && !recovery_emitted
            && !state.awaiting_idr
            && picture_type == PictureType::I;

        let frame_num = if real_idr {
            0
        } else {
            (state.prev_ref_frame_num + 1) % MAX_FRAME_NUM
        };
        let layout = if picture_type == PictureType::B {
            // A B picture sits between its two references, so list 0
            // defaults to [forward, backward, long-term] and list 1 to
            // [backward, forward, long-term].
            RefLayout {
                count: state.short_term_count + 1,
                fwd_l0: 0,
                fwd_l1: 1,
                bwd_l0: state.short_term_count as i32 - 1,
                bwd_l1: 0,
                flat: state.short_term_count as i32,
                l1_short_term_delta: None,
                anchor_second_field: false,
            }
        } else {
            RefLayout {
                count: state.short_term_count + 1,
                fwd_l0: 0,
                fwd_l1: 0,
                bwd_l0: -1,
                bwd_l1: -1,
                // Long-term entries follow every short-term one in both
                // default lists.
                flat: state.short_term_count as i32,
                l1_short_term_delta: (state.short_term_count > 0)
                    .then(|| (frame_num + MAX_FRAME_NUM - state.newest_short_term) % MAX_FRAME_NUM),
                anchor_second_field: false,
            }
        };
        // The picture is coded from here on, so the wait for one that opens the
        // decoded picture buffer ends here too.
        state.awaiting_idr = false;
        let ctx = PictureContext {
            frame_num,
            // The IDR displays first, so it takes the lowest POC in the segment.
            poc: if real_idr {
                0
            } else {
                POC_PER_FRAME * (state.gop_base + tr)
            },
            is_reference,
            layout,
            short_term: state.short_term,
            options,
            mbaff,
            real_idr,
            recovery_intra,
            weight_scale: scaling,
            picture_count: if mate.is_some() { 2 } else { 1 },
        };
        if has_field_pairs {
            parts.push(Part::Literal(write_access_unit_delimiter()));
        }
        if recovery_intra && options.open_gop_recovery == OpenGopRecovery::RecoveryPoint {
            parts.push(Part::Literal(write_recovery_point_sei()));
        }
        parts.push(Part::Picture(jobs.len()));
        jobs.push(PictureJob {
            index: jobs.len(),
            source,
            mate,
            data: job_bytes(data, &pics, &starts, source, mate, &ctx),
        });
        recovery_emitted |= recovery_intra;
        if recovery_intra && options.open_gop_recovery == OpenGopRecovery::Idr {
            pending_recovery_copy = Some((source, mate, ctx.poc));
        }

        if real_idr {
            // A field pair cannot mark itself long-term, so the copy behind
            // it marks the pair rather than marking itself.
            let mark_from_clone = mate.is_some();
            if has_field_pairs {
                parts.push(Part::Literal(write_access_unit_delimiter()));
            }
            parts.push(Part::Literal(write_reference_clone(
                &g,
                mbaff,
                mark_from_clone,
            )));
            state.prev_ref_frame_num = 1;
            state.short_term_count = 1;
            // The IDR emptied the buffer and took the long-term slot either
            // way, so the copy is all the short-term chain has.
            state.newest_short_term = 1;
            state.short_term.clear();
            state.short_term.push(state.newest_short_term);
        } else if is_reference {
            state.prev_ref_frame_num = frame_num;
            state.short_term_count = (state.short_term_count + 1).min(MAX_SHORT_TERM_FRAMES as u32);
            state.newest_short_term = frame_num;
            state.short_term.push(frame_num);
        }
        pictures_converted += 1;
    }

    if let Some((source, mate, poc)) = pending_recovery_copy {
        emit_recovery_copy(&mut parts, &mut jobs, &mut state, source, mate, poc);
    }

    // The parameter sets go in front of the pictures they describe, and only
    // if there are any: a unit that coded none is dropped whole by whoever is
    // packaging it, and a description dropped with it was never sent. Leaving
    // the state as it was is what makes the next unit carry it instead.
    let described = redescribe && pictures_converted > 0;
    if described {
        parts.splice(0..0, description_parts);
        state.initialized = true;
        state.description = description;
    }

    Ok(UnitPlan {
        parts,
        jobs,
        state,
        pictures_converted,
        pictures_skipped,
        recovery_emitted,
        described,
    })
}

/// The bytes a worker needs to code one picture: its context, then an
/// elementary stream the picture can be parsed out of on its own.
///
/// The stream is the picture's own bytes with the headers that describe it in
/// front, which is normally the block its sequence opens with -- a hundred-odd
/// bytes carrying no picture at all. A sequence that changes its quantiser
/// matrices part way through stretches that block over the pictures in between
/// and the prefix carries them along, which is why the context says how many
/// pictures at the end belong to the job rather than trusting the count.
fn job_bytes(
    data: &[u8],
    pics: &[Picture],
    starts: &[usize],
    source: usize,
    mate: Option<usize>,
    ctx: &PictureContext,
) -> Vec<u8> {
    let start = starts[source];
    let end = picture_end(
        &pics[mate.unwrap_or(source)],
        starts[mate.unwrap_or(source)],
    );
    // A picture whose own bytes already reach back over its headers -- the
    // first of a sequence -- needs no prefix, and would only see them twice.
    let prefix = if start <= pics[source].context_start {
        &data[..0]
    } else {
        &data[pics[source].context_start..pics[source].context_end]
    };
    // Reserved and then appended to, rather than sized and filled: a buffer
    // made the second way is zeroed before any of it is written, and the zeroes
    // are a memset over every byte of the unit. That is worth avoiding
    // anywhere, and worth more in the browser, where a memset is a real call
    // rather than something the machine does in the background.
    let mut out = Vec::with_capacity(JOB_HEADER_LEN + prefix.len() + (end - start));
    out.resize(JOB_HEADER_LEN, 0);
    ctx.encode(&mut out);
    out.extend_from_slice(prefix);
    out.extend_from_slice(&data[start..end]);
    out
}

/// Converts one picture at a time, and nothing else.
///
/// This is the whole of what a thread or a worker has to hold. It knows nothing
/// of the stream around it: everything a picture is coded against arrives with
/// it, which is what makes the pictures of a unit convertible at the same time.
/// What it keeps between them is only scratch -- at an HD macroblock count
/// several megabytes of it, and handing that back to the allocator after each
/// picture only to fault it in again is most of what a picture costs outside
/// its own coding.
pub struct PictureEncoder {
    scratch: Option<PictureScratch>,
    by_address: MacroblockGrid,
    paired_by_address: MacroblockGrid,
    writer: BitWriter,
    /// The requantiser, kept across pictures that ask for the same matrix --
    /// which is all of them, in a stream that does not change it.
    quantiser: Option<([i32; 64], Quantiser8x8)>,
}

impl Default for PictureEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl PictureEncoder {
    pub fn new() -> Self {
        Self {
            scratch: None,
            by_address: MacroblockGrid::new(),
            paired_by_address: MacroblockGrid::new(),
            // A picture's worth of coded macroblocks is megabytes, and asking
            // the allocator for that per picture costs more than the writing.
            writer: BitWriter::with_capacity(1 << 22),
            quantiser: None,
        }
    }

    /// Code the picture a [`PictureJob`] describes.
    ///
    /// A slice that will not decode is not an error here: it is a fact about
    /// the source that the plan could not know, reported back so the unit can
    /// be planned again without it.
    pub fn encode(&mut self, job: &[u8]) -> Result<PictureOutput> {
        let ctx = PictureContext::decode(job)?;
        let data = &job[JOB_HEADER_LEN..];
        let pics = parse_elementary_stream(data)?;
        let wanted = ctx.picture_count as usize;
        if pics.len() < wanted {
            bail!(
                "picture job carries {} coded pictures, expected {wanted}",
                pics.len()
            );
        }
        // Everything in front of these is the context the picture is described
        // by, and is not coded.
        let pic = &pics[pics.len() - wanted];
        let paired_pic = (wanted == 2).then(|| &pics[pics.len() - 1]);

        let mut stats = Stats::default();
        let mut reader = BitReader::new(data);
        if !decode_picture(&mut reader, pic, &mut self.by_address, &mut stats) {
            return Ok(PictureOutput {
                decoded: false,
                stats,
                bitstream: Vec::new(),
            });
        }
        if let Some(mate) = paired_pic {
            if !decode_picture(&mut reader, mate, &mut self.paired_by_address, &mut stats) {
                return Ok(PictureOutput {
                    decoded: false,
                    stats,
                    bitstream: Vec::new(),
                });
            }
        }

        let g = frame_geometry(
            pic.sequence.horizontal_size,
            pic.sequence.vertical_size,
            !ctx.mbaff,
        );
        if !self
            .quantiser
            .as_ref()
            .is_some_and(|(scale, _)| *scale == ctx.weight_scale)
        {
            self.quantiser = Some((ctx.weight_scale, Quantiser8x8::new(&ctx.weight_scale)));
        }
        let (_, quant) = self.quantiser.as_ref().expect("just built");
        let fits = self.scratch.as_ref().is_some_and(|scratch| {
            scratch.mb_width == g.mb_width && scratch.mb_height == g.mb_height
        });
        if !fits {
            self.scratch = Some(PictureScratch::new(g.mb_width, g.mb_height));
        }
        let scratch = self.scratch.as_mut().expect("sized for this picture");
        let bitstream = write_picture(
            pic,
            &self.by_address,
            paired_pic.map(|mate| (mate, &self.paired_by_address)),
            &g,
            quant,
            scratch,
            &ctx,
            &mut stats,
            &mut self.writer,
        )?;
        Ok(PictureOutput {
            decoded: true,
            stats,
            bitstream,
        })
    }
}

/// Decode every slice of one coded picture, reporting whether all of them came
/// out whole. A picture with no slices at all is not damaged, merely empty, and
/// is dropped without being counted as an error.
fn decode_picture(
    reader: &mut BitReader<'_>,
    pic: &Picture,
    grid: &mut MacroblockGrid,
    stats: &mut Stats,
) -> bool {
    let geo = picture_geometry(pic);
    grid.reset(geo.mb_width * geo.mb_height);
    let mut decoded_slices = 0usize;
    let mut malformed = false;
    for slice in &pic.slices {
        match decode_slice(reader, pic, slice, geo.mb_width, grid) {
            Ok(()) => decoded_slices += 1,
            Err(_) => malformed = true,
        }
    }
    if malformed {
        stats.errors += 1;
    }
    !malformed && decoded_slices > 0
}

pub struct IncrementalTranscoder {
    options: TranscodeOptions,
    state: TranscoderState,
    encoder: PictureEncoder,
    in_flight: Option<InFlight>,
    random_access_pending: bool,
    recovery_point_pending: bool,
    description_pending: bool,
    pictures_converted: usize,
    pictures_skipped: usize,
    stats: Stats,
}

/// A unit whose pictures are out being converted.
struct InFlight {
    plan: UnitPlan,
    /// Which source pictures earlier rounds found damaged, which is what the
    /// plan above was drawn knowing.
    undecodable: Vec<bool>,
    /// What the plan was drawn under, kept so that drawing it again asks for
    /// the same thing.
    request: UnitRequest,
}

/// What became of the pictures handed back to [`IncrementalTranscoder::complete`].
pub enum Step {
    /// The unit is finished.
    Done(Box<TranscodeResult>),
    /// A picture would not decode, so the unit was planned again without it.
    /// Convert these and hand them back in turn; it takes at most one round,
    /// because by now every picture has been tried.
    Again(Vec<Vec<u8>>),
}

impl IncrementalTranscoder {
    pub fn new(options: TranscodeOptions) -> Self {
        Self {
            options,
            state: TranscoderState::new(),
            encoder: PictureEncoder::new(),
            in_flight: None,
            random_access_pending: false,
            recovery_point_pending: false,
            description_pending: false,
            pictures_converted: 0,
            pictures_skipped: 0,
            stats: Stats::default(),
        }
    }

    /// Whether complementary fields are being delimited into their own access
    /// units. The MP4 timeline has to reserve a sample per access unit, so it
    /// needs to know what this transcoder is emitting.
    pub fn split_field_samples(&self) -> bool {
        self.options.split_field_samples
    }

    /// Restart the H.264 DPB from an IDR at the next incremental unit.
    pub fn request_random_access_point(&mut self) {
        if self.state.initialized {
            self.random_access_pending = true;
            self.state.awaiting_idr = true;
        }
    }

    /// Make the next intra picture independently decodable without flushing
    /// references used by an open GOP's leading B pictures.
    pub fn request_recovery_point(&mut self) {
        if self.state.initialized {
            self.recovery_point_pending = true;
        }
    }

    /// Put the parameter sets in front of the next unit again, so that the
    /// fragment it becomes can be given an initialization segment.
    ///
    /// The sequence they describe need not have changed: the segment describes
    /// the sound as well, and a stream that switches between 5.1 and stereo
    /// needs a new one with the same picture in it.
    pub fn request_description(&mut self) {
        self.description_pending = true;
    }

    /// Whether the next picture coded has to be one that opens the decoded
    /// picture buffer. The MP4 timeline has to reach the same verdict on the
    /// same pictures, so it asks.
    pub fn awaiting_random_access(&self) -> bool {
        self.state.awaiting_idr
    }

    pub fn errors(&self) -> u64 {
        self.stats.errors
    }

    /// Convert one unit here and now.
    pub fn push(&mut self, data: &[u8]) -> Result<TranscodeResult> {
        let mut jobs = self.begin(data)?;
        loop {
            let mut outputs = Vec::with_capacity(jobs.len());
            for job in &jobs {
                outputs.push(self.encoder.encode(job)?);
            }
            match self.complete(data, &outputs)? {
                Step::Done(result) => return Ok(*result),
                Step::Again(again) => jobs = again,
            }
        }
    }

    /// Plan one unit and hand out its pictures to be converted.
    ///
    /// Each is a self-contained buffer that [`PictureEncoder::encode`] turns
    /// into an access unit, wherever it happens to run. Hand the results back
    /// to [`Self::complete`] in the order they were given out. Nothing about
    /// the transcoder moves until then, so a unit that is begun and abandoned
    /// costs only what it took to plan.
    pub fn begin(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>> {
        let request = UnitRequest {
            random_access: self.state.initialized && self.random_access_pending,
            recovery_point: self.state.initialized && self.recovery_point_pending,
            description: self.description_pending,
        };
        let undecodable = Vec::new();
        let mut plan = plan_unit(data, &self.state, self.options, request, &undecodable)?;
        let jobs = plan.take_jobs();
        self.in_flight = Some(InFlight {
            plan,
            undecodable,
            request,
        });
        Ok(jobs)
    }

    /// Take the converted pictures back, in the order [`Self::begin`] gave
    /// their jobs out. `data` is the same unit that was begun.
    pub fn complete(&mut self, data: &[u8], outputs: &[PictureOutput]) -> Result<Step> {
        let Some(mut flight) = self.in_flight.take() else {
            bail!("no unit is being converted");
        };
        if outputs.len() != flight.plan.jobs.len() {
            bail!(
                "{} converted pictures handed back for a unit of {}",
                outputs.len(),
                flight.plan.jobs.len()
            );
        }
        let mut damaged = false;
        for (job, output) in flight.plan.jobs.iter().zip(outputs) {
            if output.decoded {
                continue;
            }
            let mut mark = |index: usize| {
                if flight.undecodable.len() <= index {
                    flight.undecodable.resize(index + 1, false);
                }
                flight.undecodable[index] = true;
            };
            mark(job.source);
            if let Some(mate) = job.mate {
                mark(mate);
            }
            damaged = true;
            // The damage is the transcoder's to report whether or not the
            // picture is coded on the next attempt, where it will have been
            // dropped and so will not report it again.
            self.stats.errors += output.stats.errors;
        }
        if damaged {
            // Every picture was tried, so the whole of what the plan got wrong
            // is now known and the next attempt is the last.
            flight.plan = plan_unit(
                data,
                &self.state,
                self.options,
                flight.request,
                &flight.undecodable,
            )?;
            let jobs = flight.plan.take_jobs();
            self.in_flight = Some(flight);
            return Ok(Step::Again(jobs));
        }
        let bitstream = flight.plan.assemble(outputs);
        for output in outputs {
            self.stats.add(&output.stats);
        }
        self.state = flight.plan.state;
        self.random_access_pending = false;
        self.recovery_point_pending =
            flight.request.recovery_point && !flight.plan.recovery_emitted;
        // A unit that coded no picture carries no parameter sets either, so a
        // description asked for and not sent is still owed.
        self.description_pending = flight.request.description && !flight.plan.described;
        self.pictures_converted += flight.plan.pictures_converted;
        self.pictures_skipped += flight.plan.pictures_skipped;
        Ok(Step::Done(Box::new(TranscodeResult {
            bitstream,
            pictures_converted: self.pictures_converted,
            pictures_skipped: self.pictures_skipped,
            stats: self.stats,
            recovery_point: flight.plan.recovery_emitted,
            undecodable: flight.undecodable,
        })))
    }
}

pub fn transcode(data: &[u8], options: TranscodeOptions) -> Result<TranscodeResult> {
    IncrementalTranscoder::new(options).push(data)
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
    mb: Option<&Macroblock>,
    field: usize,
    top_field_first: bool,
    layout: &RefLayout,
    intra: bool,
) -> Prediction {
    // Nothing to predict from, so the flat constant it is -- for a macroblock
    // the source coded as intra, and for one it never coded at all.
    let (Some(mb), false) = (mb, intra) else {
        return Prediction {
            mb_type: b_mb_type::L0_16X16,
            ref_idx_l0: layout.flat * 2,
            ref_idx_l1: -1,
            mv_l0: [0, 0],
            mv_l1: [0, 0],
        };
    };
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
#[allow(clippy::too_many_arguments)]
fn prediction_for_field_picture(
    mb: Option<&Macroblock>,
    field: usize,
    partition: usize,
    intra: bool,
    layout: &RefLayout,
    stats: &mut Stats,
    second_reference_field: bool,
    flat_field_idx: i32,
) -> Prediction {
    let (Some(mb), false) = (mb, intra) else {
        // The index the slice header hung the flat weights on, which this has
        // to name exactly or the macroblock predicts from a picture instead of
        // from the constant its residual was taken against. On the second field
        // of a random access point those weights are on list 1, since list 0
        // has to keep the same field predictable.
        if layout.anchor_second_field {
            return Prediction {
                mb_type: b_mb_type::L1_16X16,
                ref_idx_l0: -1,
                ref_idx_l1: 0,
                mv_l0: [0, 0],
                mv_l1: [0, 0],
            };
        }
        return Prediction {
            mb_type: b_mb_type::L0_16X16,
            ref_idx_l0: flat_field_idx,
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

    // The second field of a random access point has one reference field and a
    // list 1 already spoken for by the flat prediction, so neither the dual
    // prime average nor the bilinear pair below has anywhere to put its second
    // prediction. H.264 interpolates the sub-sample position itself instead,
    // which is the same trade a bidirectional macroblock already makes.
    if layout.anchor_second_field {
        stats.bidirectional_vectors += 1;
        return Prediction {
            mb_type: b_mb_type::L0_16X16,
            // One entry, one index. The source may name a parity the pair does
            // not hold, since MPEG-2 lets a P field reach back a frame further,
            // but nothing before the random access point was coded, so there is
            // nowhere else the prediction could have come from anyway.
            ref_idx_l0: 0,
            ref_idx_l1: -1,
            mv_l0: native_position(mb.mv[vector_base], mb.mv[vector_base + 1]),
            mv_l1: [0, 0],
        };
    }

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

/// Name the short-term entries of a slice's two reference lists.
///
/// The order is the one clause 8.2.4.2.3 builds for a frame and 8.2.4.2.5 for a
/// field: the reference frames in list order, a field picture taking from each
/// the field with the parity of the one being coded and then its mate. Writing
/// it out instead of leaving it to the decoder is what keeps the index
/// arithmetic of [`Prediction`] true on decoders that build the list
/// differently -- VideoToolbox does, and puts the long-term picture an index
/// below where the slice header's weights are.
///
/// The long-term entries behind them are deliberately left unnamed. Reordering
/// keeps the entries a slice does not name, in the order the initialisation put
/// them, so the long-term picture still lands right behind the run named here
/// -- and naming it is not an option, because VideoToolbox rejects
/// `long_term_pic_num` in a field slice outright and fails the picture with
/// `kVTVideoDecoderBadDataErr`.
fn short_term_ref_lists(
    short_term: &ShortTermFrames,
    frame_num: u32,
    backward: bool,
    field: bool,
) -> [RefPicList; 2] {
    let mut newest_first = [0u32; MAX_SHORT_TERM_FRAMES];
    let mut count = 0;
    for reference in short_term.iter().rev() {
        newest_first[count] = (frame_num + MAX_FRAME_NUM - reference) % MAX_FRAME_NUM;
        count += 1;
    }
    let newest_first = &newest_first[..count];

    // A frame takes one entry; a field takes its own parity and then its mate.
    let push_frame = |list: &mut RefPicList, frames_back: u32| {
        for same_parity in [true, false] {
            list.push(RefPicListEntry {
                frames_back,
                same_parity,
            });
            if !field {
                break;
            }
        }
    };

    let mut lists = [RefPicList::default(), RefPicList::default()];
    match newest_first.split_first() {
        // A B picture sits between its references. The one it was decoded
        // behind is the following picture, which list 0 reaches last and list 1
        // first; the rest precede it, nearest first in both.
        Some((&following, preceding)) if backward => {
            for &frames_back in preceding {
                push_frame(&mut lists[0], frames_back);
            }
            push_frame(&mut lists[0], following);
            push_frame(&mut lists[1], following);
            for &frames_back in preceding {
                push_frame(&mut lists[1], frames_back);
            }
        }
        // Without a following picture the two lists come out identical, and the
        // initialisation ends by exchanging the first two entries of list 1.
        // For a field those two are the parities of one frame, and the
        // macroblock writer reaches both through list 1, so reproduce the
        // exchange; for a frame they are two different pictures and the writer
        // wants the nearest reference first in both lists, so do not.
        Some((&nearest, rest)) => {
            for &frames_back in newest_first {
                push_frame(&mut lists[0], frames_back);
            }
            if field {
                for same_parity in [false, true] {
                    lists[1].push(RefPicListEntry {
                        frames_back: nearest,
                        same_parity,
                    });
                }
            } else {
                push_frame(&mut lists[1], nearest);
            }
            for &frames_back in rest {
                push_frame(&mut lists[1], frames_back);
            }
        }
        None => {}
    }
    lists
}

/// Copy the picture that opens a random access point, without changing pixels.
///
/// Two pictures are needed there. Intra macroblocks need a reference index whose
/// weights can force the flat prediction, and that index has to survive the
/// sliding window for the rest of the stream, so one of the two has to be
/// long-term; the other stays short-term for the content to predict from. Both
/// hold the same samples, so which is which does not change a single decoded
/// sample -- but it does change which one a decoder has to keep.
///
/// The long-term slot goes to the random access picture, not to this copy,
/// because VideoToolbox stops honouring an IDR as a reference once the picture
/// behind it marks itself long-term, and substitutes the most recently decoded
/// reference wherever the IDR is named. Content then predicts from this copy,
/// which no marking has moved, and never names the IDR at all.
///
/// A frame IDR says so itself with `long_term_reference_flag`. A field pair
/// cannot -- only its first half is the IDR, and marking one field leaves the
/// pair half marked, which ffmpeg fails to resolve -- so with
/// `mark_random_access_point` this copy hands the slot over from outside, where
/// being a frame lets it name the pair as a whole.
fn write_reference_clone(
    g: &FrameGeometry,
    mbaff: bool,
    mark_random_access_point: bool,
) -> Vec<u8> {
    let mut w = BitWriter::with_capacity(64);
    write_slice_header(
        &mut w,
        &SliceHeaderConfig {
            slice_type: SliceType::P,
            frame_num: 1,
            log2_max_frame_num: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
            pic_order_cnt_lsb: CLONE_POC,
            log2_max_poc_lsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
            reference: true,
            // The random access picture is the only one in the buffer, and a
            // pair of coded fields sharing a `frame_num` is one frame to a frame
            // picture, so index 0 and one `frame_num` back both reach it
            // whichever way the source sent it.
            long_term_previous: mark_random_access_point.then_some((1, LONG_TERM_FRAME_IDX)),
            mbaff,
            slice_qp: PPS_INIT_QP,
            pps_init_qp: PPS_INIT_QP,
            disable_deblocking_filter_idc: 1,
            num_ref_idx_l0_active: Some(1),
            ..Default::default()
        },
    );
    w.ue((g.mb_width * g.mb_height) as u32); // mb_skip_run: copy the IDR
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
    ///
    /// `scan` is the one the conversion wrote the AC levels in, which is the
    /// field scan of Table 8-13 for a macroblock of a coded field.
    #[allow(clippy::too_many_arguments)]
    fn store_chroma(
        &mut self,
        mb_x: usize,
        mb_y: usize,
        prediction: &[[i32; 4]; 2],
        levels: &[ChromaBlockLevels; 2],
        qp_c: i32,
        cbp_chroma: u32,
        scan: &[usize; 16],
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
                    for k in 1..16 {
                        ac[scan[k]] = levels[c].ac[blk][k - 1];
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

/// Access-unit delimiter, which is what tells the MP4 wrapper where one video
/// sample ends. One before each picture keeps the two NAL units of a PAFF
/// complementary field pair in a single sample; `split_field_samples` adds one
/// between them to make each field a sample of its own.
fn write_access_unit_delimiter() -> Vec<u8> {
    let mut w = BitWriter::new();
    w.u(3, 7); // primary_pic_type: I, P, or B
    w.rbsp_trailing_bits();
    to_nal_unit(w.bytes(), 0, nal_type::AUD)
}

/// Recovery point SEI (D.2.7): recovery_frame_cnt 0, exact match, a broken
/// link for open-GOP leading pictures, and no changing slice groups. Continuous
/// decoding still has their old references and displays them; a decoder that
/// starts here knows not to display them when those references are absent. The
/// payload is byte-aligned before the SEI RBSP's own trailing bit.
fn write_recovery_point_sei() -> Vec<u8> {
    to_nal_unit(&[6, 1, 0xe4, 0x80], 0, nal_type::SEI)
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
    field_source: Option<&Macroblock>,
    raw: &mut [[f32; 64]; 4],
    converted: &mut [[f32; 64]; 4],
) -> FieldTargetSet {
    let mut active_mask = 0u32;
    // A macroblock the source never coded carries nothing, which is the same
    // as one it coded as skipped.
    let Some(field_source) = field_source.filter(|mb| !mb.skipped) else {
        return FieldTargetSet {
            converted: false,
            active_mask,
        };
    };
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
    pair_source: Option<&'a Macroblock>,
    component: usize,
) -> FieldChromaSource<'a> {
    let source_intra = pair_source.is_some_and(Macroblock::is_intra);
    FieldChromaSource {
        levels: pair_source.and_then(|mb| mb.block(4 + component)),
        weight_scale: if source_intra {
            &pic.quant.chroma_intra
        } else {
            &pic.quant.chroma_non_intra
        },
        quantiser_scale: QUANTISER_SCALE[pic.coding.q_scale_type]
            [pair_source.map_or(0, |mb| mb.quantiser_scale_code) as usize],
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
        ..
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
    let mut intra_state = (ctx.real_idr || ctx.recovery_intra).then(|| IntraState {
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
    let direct_field_pair = paired_field.is_some();
    // What the second field of a random access point predicts from, which is
    // the first half of its own pair and nothing else. See [`RefLayout`].
    let anchor_layout = RefLayout {
        count: 1,
        fwd_l0: 0,
        fwd_l1: 0,
        bwd_l0: -1,
        bwd_l1: -1,
        flat: 0,
        l1_short_term_delta: None,
        anchor_second_field: true,
    };
    let picture_field_pairs =
        direct_field_pair || (ctx.mbaff && pic.header.picture_coding_type != PictureType::I);
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
        if ctx.options.split_field_samples && direct_field_pair && position == field_size {
            // Either coded field is a primary coded picture in its own right,
            // so a delimiter between them is legal H.264 whichever way round
            // this option is set. It is what makes the muxer see two access
            // units, and so give each field its own MP4 sample.
            picture_nals.extend_from_slice(&write_access_unit_delimiter());
        }
        let second_field_of_reference_pair = second_output_field && ctx.is_reference;
        // Only one of a pair's two coded fields can carry IdrPicFlag: an IDR
        // empties the decoded picture buffer, so a second one would throw out
        // the field that came before it. Clause 3.30 says as much -- the second
        // field of a complementary reference field pair is by definition not an
        // IDR picture -- so the other field is an ordinary reference field, and
        // the sliding window leaves the pair alone.
        let idr_field = ctx.real_idr && !second_output_field;
        let intra_field = (ctx.real_idr || ctx.recovery_intra) && !second_output_field;
        // Nor is it coded like one. A frame sent as a pair of fields makes its
        // second field a P field predicted from the first as a matter of
        // course, and H.264 intra prediction has nothing to make those inter
        // macroblocks from, so the second field goes through the same path
        // every content picture does.
        // A recovery point must be decodable without the pictures that came
        // before it just like an IDR. Its second field therefore names only
        // the independently reconstructed first field, even though a decoder
        // doing continuous playback still has older pictures in its DPB.
        let anchor_second_field = (ctx.real_idr || ctx.recovery_intra) && second_output_field;
        // Only the first field of an IDR or recovery picture is independently
        // reconstructed. The second field is a B slice and must use inter
        // macroblock syntax; carrying this state across would write I-slice
        // mb_type values under a B-slice header and desynchronise the decoder.
        if (ctx.real_idr || ctx.recovery_intra) && second_output_field {
            intra_state = None;
        }
        let layout = if anchor_second_field {
            &anchor_layout
        } else {
            &ctx.layout
        };
        // How many short-term reference fields stand in front of the long-term
        // ones, which is where the flat prediction sits.
        //
        // A buffer of `count` frames offers twice as many fields. The second
        // field of a reference pair sees a different set: its own first field
        // was marked before it and stands in the list alone, without the mate
        // it has not got yet. Clause 8.2.5.3 makes room for that frame by
        // pushing the oldest one out, which turns a whole frame into a single
        // field and leaves the run a field shorter -- but only once the buffer
        // is full. It is not full for the first pictures behind a random access
        // point, and there nothing leaves and the run is a field longer.
        let short_term_fields = if anchor_second_field {
            // The IDR emptied the buffer, so the first half of this very pair
            // is the whole of it.
            1
        } else if second_field_of_reference_pair {
            if layout.count == MAX_NUM_REF_FRAMES {
                layout.flat as u32 * 2 - 1
            } else {
                layout.flat as u32 * 2 + 1
            }
        } else {
            layout.flat as u32 * 2
        };
        // The long-term picture contributes both of its fields behind them,
        // except to the pair that has not reached it yet.
        let field_list_len = short_term_fields + if anchor_second_field { 0 } else { 2 };
        let output_slice_type = if intra_field {
            SliceType::I
        } else {
            // A B slice is the only one with a list 1 to put the flat weights in.
            SliceType::B
        };
        // The short-term run the slice would otherwise leave a decoder to work
        // out. A recovery pair is decoded while the old DPB is still present,
        // so its second field cannot rely on the default list putting the first
        // field of this pair ahead of those older references. Name that field
        // explicitly: it has this frame_num and the opposite parity.
        let explicit_ref_lists = if anchor_second_field {
            let mut lists = [RefPicList::default(), RefPicList::default()];
            for list in &mut lists {
                list.push(RefPicListEntry {
                    frames_back: 0,
                    same_parity: false,
                });
            }
            Some(lists)
        } else {
            (output_slice_type != SliceType::I && !second_field_of_reference_pair).then(|| {
                short_term_ref_lists(
                    &ctx.short_term,
                    ctx.frame_num,
                    layout.bwd_l0 >= 0,
                    direct_field_pair,
                )
            })
        };
        debug_assert!(
            explicit_ref_lists.is_none_or(|lists| lists.iter().all(|list| list.len()
                == if direct_field_pair {
                    short_term_fields as usize
                } else {
                    layout.flat as usize
                }))
        );
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
                    // A field pair displays in the order it was coded, so the
                    // second coded field takes the later slot whichever parity
                    // it carries. A coded IDR field is also required to hold
                    // order count 0, and the first coded field is the one that
                    // is the IDR.
                    pic_order_cnt_lsb: ctx.poc
                        + if direct_field_pair {
                            u32::from(second_output_field)
                        } else {
                            0
                        },
                    log2_max_poc_lsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
                    idr: idr_field,
                    // A frame IDR takes the long-term slot itself, which leaves
                    // the copy behind it short-term for the content to predict
                    // from. See `write_reference_clone`.
                    long_term_current: (idr_field && !direct_field_pair)
                        .then_some(LONG_TERM_FRAME_IDX),
                    reference: ctx.is_reference,
                    mbaff: ctx.mbaff,
                    field_picture: direct_field_pair.then_some(field != 0),
                    slice_qp: PPS_INIT_QP,
                    pps_init_qp: PPS_INIT_QP,
                    disable_deblocking_filter_idc: 1,
                    num_ref_idx_l0_active: Some(if direct_field_pair {
                        field_list_len
                    } else {
                        layout.count
                    }),
                    num_ref_idx_l1_active: Some(if direct_field_pair {
                        field_list_len
                    } else {
                        layout.count
                    }),
                    explicit_ref_lists,
                    l1_first_short_term_delta: layout
                        .l1_short_term_delta
                        .filter(|_| !direct_field_pair),
                    flat_pred_ref_idx: if anchor_second_field {
                        // The one field this list holds is what the inter
                        // macroblocks predict from, so list 0 keeps it at its
                        // ordinary weight and only list 1 carries the constant.
                        [None, Some(0)]
                    } else {
                        // Long-term fields follow every short-term one, and
                        // both runs start with the parity of the field being
                        // coded, so the long-term picture's own field of this
                        // parity leads them whichever parity that is.
                        let idx = if direct_field_pair {
                            short_term_fields
                        } else {
                            layout.flat as u32
                        };
                        [Some(idx); 2]
                    },
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
        // The two halves of a pair are two coded pictures with headers of their
        // own, and they need not agree: an I field and the P field beside it
        // routinely differ in intra_dc_precision alone. Every macroblock has to
        // be dequantised against the header of the field it came from.
        let source_pic = match paired_field {
            Some((mate, _)) if second_output_field => mate,
            _ => pic,
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
                    let quantiser_scale = QUANTISER_SCALE[source_pic.coding.q_scale_type]
                        [source.quantiser_scale_code as usize];
                    qp = qp_for_scale(quant, &mut qp_by_scale, oversample, quantiser_scale);
                    let matrix = if intra {
                        &source_pic.quant.intra
                    } else {
                        &source_pic.quant.non_intra
                    };
                    let chroma_matrix = if intra {
                        &source_pic.quant.chroma_intra
                    } else {
                        &source_pic.quant.chroma_non_intra
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
                                source_pic.coding.intra_dc_precision,
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
                                source_pic.coding.intra_dc_precision,
                                qp_c,
                                prediction,
                                &mut chroma_scratch[c],
                                direct_field_pair,
                            ),
                            (Some(block), None) => convert_chroma_block(
                                block,
                                chroma_matrix,
                                quantiser_scale,
                                source_pic.coding.intra_dc_precision,
                                qp_c,
                                &mut chroma_scratch[c],
                                intra,
                                direct_field_pair,
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
                if direct_field_pair {
                    &FIELD_SCAN_4X4
                } else {
                    &ZIGZAG_4X4
                },
            );
            let end_of_field =
                direct_field_pair && mb_x == g.mb_width - 1 && field_position == field_size - 1;
            if end_of_field
                || (!direct_field_pair && mb_x == g.mb_width - 1 && mb_y == g.mb_height - 1)
            {
                writer.rbsp_trailing_bits();
                // Only the independently coded first field reaches here: the
                // second field of a pair drops `intra_state` and follows the
                // content path instead.
                debug_assert!(intra_field, "intra reconstruction requires an I slice");
                picture_nals.extend_from_slice(&to_nal_unit(
                    writer.bytes(),
                    3,
                    if idr_field {
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
            continue;
        }

        if field_pair && !direct_field_pair {
            // Either half of the pair may be missing, and at the head of a unit
            // that starts part way through a picture -- which is what a seek
            // hands the transcoder -- both often are. There is nothing to code
            // them from, so they carry no coefficients and predict from the
            // flat constant, the same concealment a field picture already uses.
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
                // for both, and where neither half is there, whatever the
                // macroblock before was coded at -- nothing is being coded at
                // it, and it saves a mb_qp_delta saying so.
                let mut pair_qp: Option<i32> = None;
                for half in [pair_top, pair_bottom].into_iter().flatten() {
                    let half_qp = qp_for_scale(
                        quant,
                        &mut qp_by_scale,
                        oversample,
                        QUANTISER_SCALE[pic.coding.q_scale_type]
                            [half.quantiser_scale_code as usize],
                    );
                    pair_qp = Some(pair_qp.map_or(half_qp, |current| current.min(half_qp)));
                }
                cached_pair_qp = pair_qp.unwrap_or(prev_qp);
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
            count_field_pair_vector(source, intra, layout, stats);
        }
        let pred = if direct_field_pair {
            prediction_for_field_picture(
                source,
                mb_y & 1,
                0,
                intra,
                layout,
                stats,
                second_output_field && ctx.is_reference,
                short_term_fields as i32,
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
            prediction_for(source, intra, layout, stats)
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

        let split_frame_mb = ctx.mbaff && !field_pair;
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
                    layout,
                    stats,
                    second_output_field && ctx.is_reference,
                    short_term_fields as i32,
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
            let field = mb_y & 1;
            let field_preds = [pair_top, pair_bottom].map(|half| {
                prediction_for_field(
                    half,
                    field,
                    pic.coding.top_field_first,
                    layout,
                    half.is_some_and(Macroblock::is_intra),
                )
            });
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
        let ref_count = layout.count as i32;
        let mb = InterMacroblock {
            mb_x,
            mb_y: if field_pair { mb_y >> 1 } else { mb_y },
            p_slice: output_slice_type == SliceType::P,
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
            // The same length the slice header declared, less one. Only a list
            // of one carries no index at all and a list of two codes it as a
            // single bit; above that the coding is the same however long it is.
            num_ref_idx_l0_minus1: if field_pair {
                field_list_len as i32 - 1
            } else {
                ref_count - 1
            },
            num_ref_idx_l1_minus1: if field_pair {
                field_list_len as i32 - 1
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
                if idr_field {
                    3
                } else if ctx.is_reference {
                    2
                } else {
                    0
                },
                if idr_field {
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
        dual_prime_opposite, field_picture_ref_index, field_picture_selected_parity, plan_unit,
        rounded_half, TranscodeOptions, TranscoderState, UnitRequest,
    };
    use crate::mpeg2::constants::mb_flag;

    #[test]
    fn a_recovery_idr_starts_a_new_picture_order_epoch() {
        let data = include_bytes!("../../../testdata/ibbp.m2v");
        let first = plan_unit(
            data,
            &TranscoderState::new(),
            TranscodeOptions::default(),
            UnitRequest::default(),
            &[],
        )
        .expect("the opening unit plans");
        let mut state = first.state;
        state.gop_base = 1 << 13;

        let recovery = plan_unit(
            data,
            &state,
            TranscodeOptions::default(),
            UnitRequest {
                recovery_point: true,
                ..UnitRequest::default()
            },
            &[],
        )
        .expect("the recovery unit plans");

        assert!(recovery.recovery_emitted);
        assert_eq!(recovery.state.gop_base, 0);
    }

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
