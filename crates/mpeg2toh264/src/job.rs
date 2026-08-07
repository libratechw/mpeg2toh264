//! The pieces of a transcode that cross a thread, a worker, or a message port.
//!
//! Nothing here decides anything. It is the state [`crate::transcode`] carries
//! between pictures, plus a byte encoding for it, so that one picture can be
//! converted somewhere other than where the stream is being walked.
//!
//! The encoding exists because the browser has no shared memory to put these in:
//! a picture worker is a separate WebAssembly instance and reaches its work only
//! as bytes. Keeping both sides of it in Rust is what stops the field list being
//! written out a second time in TypeScript, where nothing would notice it
//! drifting.

use crate::error::{bail, Result};
use crate::transcode::{TranscodeOptions, VideoMode};

/// How many short-term reference frames the buffer holds, the long-term copy
/// taking the remaining slot.
pub(crate) const MAX_SHORT_TERM_FRAMES: usize = 3;

/// The `frame_num` of every short-term reference frame in the buffer, oldest
/// first.
///
/// Not simply the last few values of `frame_num`: the copy that carries the
/// long-term mark spends one of its own without joining the short-term chain,
/// leaving a hole behind the IDR in front of it. A field slice names its
/// references by how far back they sit, so it needs the values and not a count.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct ShortTermFrames {
    pub(crate) frame_nums: [u32; MAX_SHORT_TERM_FRAMES],
    pub(crate) len: usize,
}

impl ShortTermFrames {
    /// Take a reference in, sliding the oldest out of a full buffer.
    pub(crate) fn push(&mut self, frame_num: u32) {
        if self.len == MAX_SHORT_TERM_FRAMES {
            self.frame_nums.rotate_left(1);
            self.len -= 1;
        }
        self.frame_nums[self.len] = frame_num;
        self.len += 1;
    }

    pub(crate) fn clear(&mut self) {
        self.len = 0;
    }

    /// Oldest first, which is the order the sliding window will empty them in.
    pub(crate) fn iter(&self) -> impl DoubleEndedIterator<Item = u32> + '_ {
        self.frame_nums[..self.len].iter().copied()
    }
}

/// Which reference index reaches which picture, per list.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct RefLayout {
    pub(crate) count: u32,
    /// The picture an MPEG-2 forward vector refers to.
    pub(crate) fwd_l0: i32,
    pub(crate) fwd_l1: i32,
    /// The picture an MPEG-2 backward vector refers to; -1 in I and P pictures.
    pub(crate) bwd_l0: i32,
    pub(crate) bwd_l1: i32,
    /// The index whose weights force a flat prediction, which intra macroblocks
    /// use in place of H.264 intra prediction; see [`crate::h264::slice`]. It is
    /// the long-term picture, which is kept purely to have an index to hang
    /// those weights on -- its samples are never read.
    pub(crate) flat: i32,
    /// Set for I and P pictures, where both lists must reach the same picture
    /// and list 1's default construction would swap its first two entries. It
    /// holds how far back in `frame_num` the newest short-term reference is.
    pub(crate) l1_short_term_delta: Option<u32>,
    /// Set on the second field of the picture that opens a random access point.
    ///
    /// That field is routinely a P field predicted from the first half of its
    /// own pair, and that half is the only reference field in the buffer. One
    /// picture cannot be named twice in one list, so the two roles are split
    /// between the lists: list 0 holds the field at its ordinary weight for the
    /// motion the source coded, list 1 holds it again carrying the flat weights
    /// its intra macroblocks need. Both lists are one entry long, so every
    /// index below is 0 whatever parity the source asked for.
    pub(crate) anchor_second_field: bool,
}

/// Everything one picture's coding needs to know that is not in its own bytes.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct PictureContext {
    pub(crate) frame_num: u32,
    pub(crate) poc: u32,
    pub(crate) is_reference: bool,
    pub(crate) layout: RefLayout,
    /// The short-term references a field slice names its lists from.
    pub(crate) short_term: ShortTermFrames,
    pub(crate) options: TranscodeOptions,
    pub(crate) mbaff: bool,
    pub(crate) real_idr: bool,
    pub(crate) recovery_intra: bool,
    /// The non-intra quantiser matrix the H.264 requantiser scales against,
    /// which is the one the PPS declared as its 8x8 scaling list.
    ///
    /// Carried rather than read from the picture's own header because it is the
    /// unit's, taken from the first picture in it: a stream that changes its
    /// matrices part way through a unit still has to be requantised against the
    /// scaling list the decoder was given, and the picture's own matrices are
    /// used only to dequantise the source levels.
    pub(crate) weight_scale: [i32; 64],
    /// How many coded pictures the job's elementary stream ends with that
    /// belong to it: two for a complementary field pair, one otherwise.
    /// Anything before them is context; see [`crate::mpeg2::headers::Picture`].
    pub(crate) picture_count: u8,
}

/// What a transcoder carries from one unit to the next.
///
/// Small, and every field a plain number: this is what makes a unit convertible
/// anywhere, because a worker handed one of these needs nothing else of the
/// stream that came before it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct TranscoderState {
    /// Whether the sequence has been described yet, i.e. whether SPS and PPS
    /// have gone out and the dimensions below mean anything.
    pub initialized: bool,
    /// Whether the decoded picture buffer is still waiting to be opened, which
    /// only an intra picture can do.
    pub awaiting_idr: bool,
    pub width: u32,
    pub height: u32,
    pub mbaff: bool,
    pub prev_ref_frame_num: u32,
    pub short_term_count: u32,
    /// `frame_num` of the newest short-term reference, which is not the newest
    /// reference outright: the copy behind an IDR is long-term and leaves the
    /// IDR itself, one `frame_num` further back, as the newest short-term one.
    pub newest_short_term: u32,
    /// The buffer's short-term references, oldest first.
    pub short_term: ShortTermFrames,
    pub gop_base: u32,
    pub seen_picture: bool,
    pub max_tr_in_gop: u32,
}

impl TranscoderState {
    /// What a transcoder starts life with, before any picture has been seen.
    pub fn new() -> Self {
        Self {
            awaiting_idr: true,
            ..Self::default()
        }
    }

    /// What the state becomes at a random access point, which empties the
    /// decoded picture buffer and restarts display order from nothing. The
    /// sequence description survives, because the SPS and PPS are not resent.
    pub(crate) fn restarted(self) -> Self {
        Self {
            initialized: self.initialized,
            width: self.width,
            height: self.height,
            mbaff: self.mbaff,
            ..Self::new()
        }
    }
}

/// One picture's worth of work: its context, and the bytes it was coded in.
///
/// `source` and `mate` name the pictures of the unit this covers, so that a
/// worker reporting an undecodable one can be answered with a re-plan.
#[derive(Clone, Debug)]
pub struct PictureJob {
    /// Where this picture's output belongs in the unit's assembled bitstream.
    pub index: usize,
    /// Index of the source picture in the unit, and of its complementary field.
    pub source: usize,
    pub mate: Option<usize>,
    /// Context header followed by a self-contained MPEG-2 elementary stream.
    pub data: Vec<u8>,
}

impl PictureJob {
    /// The part of the job that is MPEG-2, i.e. everything past the context.
    pub fn elementary_stream(&self) -> &[u8] {
        &self.data[JOB_HEADER_LEN..]
    }
}

/// What a worker made of one [`PictureJob`].
#[derive(Clone, Debug, Default)]
pub struct PictureOutput {
    /// False when a slice would not decode. The plan assumed it would, so the
    /// unit has to be drawn again knowing better.
    pub decoded: bool,
    pub stats: crate::transcode::Stats,
    /// The access unit, empty when `decoded` is false.
    pub bitstream: Vec<u8>,
}

/// Bumped whenever the layouts below change. A worker is a separately loaded
/// WebAssembly module and can in principle be a build behind the page that
/// drives it, which is worth finding out about here rather than three hundred
/// macroblocks later.
const ENCODING_VERSION: u8 = 1;

/// Where the count of coded pictures sits, just past the fixed scalar fields.
const PICTURE_COUNT_AT: usize = 64;
/// Where the quantiser matrix starts, one byte after that.
const WEIGHT_SCALE_AT: usize = PICTURE_COUNT_AT + 1;
/// Bytes of context in front of a job's elementary stream: the scalar fields,
/// the picture count, then the 64 entries of the quantiser matrix.
pub(crate) const JOB_HEADER_LEN: usize = WEIGHT_SCALE_AT + 64;
/// Bytes of result in front of an output's access unit.
pub(crate) const OUTPUT_HEADER_LEN: usize = 72;

const FLAG_IS_REFERENCE: u8 = 1 << 0;
const FLAG_MBAFF: u8 = 1 << 1;
const FLAG_REAL_IDR: u8 = 1 << 2;
const FLAG_RECOVERY_INTRA: u8 = 1 << 3;
const FLAG_ANCHOR_SECOND_FIELD: u8 = 1 << 4;
const FLAG_HAS_L1_DELTA: u8 = 1 << 5;
const FLAG_SPLIT_FIELD_SAMPLES: u8 = 1 << 6;

fn put_u32(out: &mut [u8], at: usize, value: u32) {
    out[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_i32(out: &mut [u8], at: usize, value: i32) {
    out[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn get_u32(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

fn get_i32(data: &[u8], at: usize) -> i32 {
    get_u32(data, at) as i32
}

fn put_u64(out: &mut [u8], at: usize, value: u64) {
    out[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

fn get_u64(data: &[u8], at: usize) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[at..at + 8]);
    u64::from_le_bytes(bytes)
}

impl PictureContext {
    /// Write the context into the first [`JOB_HEADER_LEN`] bytes of `out`.
    pub(crate) fn encode(&self, out: &mut [u8]) {
        let mut flags = 0u8;
        flags |= u8::from(self.is_reference) * FLAG_IS_REFERENCE;
        flags |= u8::from(self.mbaff) * FLAG_MBAFF;
        flags |= u8::from(self.real_idr) * FLAG_REAL_IDR;
        flags |= u8::from(self.recovery_intra) * FLAG_RECOVERY_INTRA;
        flags |= u8::from(self.layout.anchor_second_field) * FLAG_ANCHOR_SECOND_FIELD;
        flags |= u8::from(self.layout.l1_short_term_delta.is_some()) * FLAG_HAS_L1_DELTA;
        flags |= u8::from(self.options.split_field_samples) * FLAG_SPLIT_FIELD_SAMPLES;
        out[0] = ENCODING_VERSION;
        out[1] = flags;
        out[2] = self.short_term.len as u8;
        out[3] = match self.options.video {
            VideoMode::Transcode => 0,
            VideoMode::Passthrough => 1,
        };
        out[PICTURE_COUNT_AT] = self.picture_count;
        put_u32(out, 4, self.frame_num);
        put_u32(out, 8, self.poc);
        put_u32(out, 12, self.layout.count);
        put_i32(out, 16, self.layout.fwd_l0);
        put_i32(out, 20, self.layout.fwd_l1);
        put_i32(out, 24, self.layout.bwd_l0);
        put_i32(out, 28, self.layout.bwd_l1);
        put_i32(out, 32, self.layout.flat);
        put_u32(out, 36, self.layout.l1_short_term_delta.unwrap_or(0));
        for (index, frame_num) in self.short_term.frame_nums.iter().enumerate() {
            put_u32(out, 40 + index * 4, *frame_num);
        }
        put_u64(out, 52, self.options.oversample.to_bits());
        put_u32(out, 60, self.options.recovery_interval as u32);
        for (index, weight) in self.weight_scale.iter().enumerate() {
            // A quantiser matrix entry is eight bits (H.262 clause 6.3.11), so
            // the whole matrix is one byte per position.
            debug_assert!((1..=255).contains(weight), "quantiser weight {weight}");
            out[WEIGHT_SCALE_AT + index] = *weight as u8;
        }
    }

    /// Read back what [`encode`](Self::encode) wrote.
    pub(crate) fn decode(data: &[u8]) -> Result<Self> {
        if data.len() < JOB_HEADER_LEN {
            bail!("picture job is shorter than its header");
        }
        if data[0] != ENCODING_VERSION {
            bail!(
                "picture job encoding version {}, expected {ENCODING_VERSION}",
                data[0]
            );
        }
        let flags = data[1];
        let len = data[2] as usize;
        if len > MAX_SHORT_TERM_FRAMES {
            bail!("picture job names {len} short-term references");
        }
        let mut frame_nums = [0u32; MAX_SHORT_TERM_FRAMES];
        for (index, frame_num) in frame_nums.iter_mut().enumerate() {
            *frame_num = get_u32(data, 40 + index * 4);
        }
        let mut weight_scale = [0i32; 64];
        for (index, weight) in weight_scale.iter_mut().enumerate() {
            *weight = data[WEIGHT_SCALE_AT + index] as i32;
        }
        let picture_count = match data[PICTURE_COUNT_AT] {
            count @ (1 | 2) => count,
            other => bail!("picture job claims {other} coded pictures"),
        };
        Ok(Self {
            frame_num: get_u32(data, 4),
            poc: get_u32(data, 8),
            is_reference: flags & FLAG_IS_REFERENCE != 0,
            layout: RefLayout {
                count: get_u32(data, 12),
                fwd_l0: get_i32(data, 16),
                fwd_l1: get_i32(data, 20),
                bwd_l0: get_i32(data, 24),
                bwd_l1: get_i32(data, 28),
                flat: get_i32(data, 32),
                l1_short_term_delta: (flags & FLAG_HAS_L1_DELTA != 0).then(|| get_u32(data, 36)),
                anchor_second_field: flags & FLAG_ANCHOR_SECOND_FIELD != 0,
            },
            short_term: ShortTermFrames { frame_nums, len },
            options: TranscodeOptions {
                oversample: f64::from_bits(get_u64(data, 52)),
                recovery_interval: get_u32(data, 60) as usize,
                split_field_samples: flags & FLAG_SPLIT_FIELD_SAMPLES != 0,
                video: match data[3] {
                    0 => VideoMode::Transcode,
                    1 => VideoMode::Passthrough,
                    other => bail!("picture job names video mode {other}"),
                },
            },
            mbaff: flags & FLAG_MBAFF != 0,
            real_idr: flags & FLAG_REAL_IDR != 0,
            recovery_intra: flags & FLAG_RECOVERY_INTRA != 0,
            weight_scale,
            picture_count,
        })
    }
}

impl PictureOutput {
    /// The whole result as one buffer, which is what a message port takes.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![0u8; OUTPUT_HEADER_LEN + self.bitstream.len()];
        out[0] = ENCODING_VERSION;
        out[1] = u8::from(self.decoded);
        let stats = [
            self.stats.integer_vectors,
            self.stats.single_axis_half_vectors,
            self.stats.both_axis_half_vectors,
            self.stats.bidirectional_vectors,
            self.stats.intra_macroblocks,
            self.stats.inter_macroblocks,
            self.stats.dropped,
            self.stats.errors,
        ];
        for (index, value) in stats.iter().enumerate() {
            put_u64(&mut out, 8 + index * 8, *value);
        }
        out[OUTPUT_HEADER_LEN..].copy_from_slice(&self.bitstream);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self> {
        if data.len() < OUTPUT_HEADER_LEN {
            bail!("picture output is shorter than its header");
        }
        if data[0] != ENCODING_VERSION {
            bail!(
                "picture output encoding version {}, expected {ENCODING_VERSION}",
                data[0]
            );
        }
        Ok(Self {
            decoded: data[1] != 0,
            stats: crate::transcode::Stats {
                integer_vectors: get_u64(data, 8),
                single_axis_half_vectors: get_u64(data, 16),
                both_axis_half_vectors: get_u64(data, 24),
                bidirectional_vectors: get_u64(data, 32),
                intra_macroblocks: get_u64(data, 40),
                inter_macroblocks: get_u64(data, 48),
                dropped: get_u64(data, 56),
                errors: get_u64(data, 64),
            },
            bitstream: data[OUTPUT_HEADER_LEN..].to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcode::Stats;

    fn a_context() -> PictureContext {
        PictureContext {
            frame_num: 9,
            poc: 40,
            is_reference: true,
            layout: RefLayout {
                count: 4,
                fwd_l0: 0,
                fwd_l1: 1,
                bwd_l0: 2,
                bwd_l1: 0,
                flat: 3,
                l1_short_term_delta: Some(7),
                anchor_second_field: false,
            },
            short_term: ShortTermFrames {
                frame_nums: [4, 6, 9],
                len: 3,
            },
            options: TranscodeOptions {
                oversample: 2.5,
                recovery_interval: 24,
                split_field_samples: true,
                video: VideoMode::Transcode,
            },
            mbaff: true,
            real_idr: false,
            recovery_intra: true,
            // Distinct per position, so a matrix written or read in the wrong
            // order does not survive.
            weight_scale: std::array::from_fn(|pos| 16 + pos as i32 * 3),
            picture_count: 2,
        }
    }

    #[test]
    fn the_quantiser_matrix_survives_position_by_position() {
        let context = a_context();
        let mut bytes = [0u8; JOB_HEADER_LEN];
        context.encode(&mut bytes);
        let decoded = PictureContext::decode(&bytes).expect("decodes");
        assert_eq!(decoded.weight_scale, context.weight_scale);
    }

    #[test]
    fn a_lone_picture_and_a_field_pair_are_told_apart() {
        for count in [1u8, 2] {
            let context = PictureContext {
                picture_count: count,
                ..a_context()
            };
            let mut bytes = [0u8; JOB_HEADER_LEN];
            context.encode(&mut bytes);
            assert_eq!(
                PictureContext::decode(&bytes)
                    .expect("decodes")
                    .picture_count,
                count
            );
        }
        let mut bytes = [0u8; JOB_HEADER_LEN];
        a_context().encode(&mut bytes);
        bytes[PICTURE_COUNT_AT] = 3;
        assert!(PictureContext::decode(&bytes).is_err());
    }

    #[test]
    fn a_context_survives_the_round_trip() {
        let context = a_context();
        let mut bytes = [0u8; JOB_HEADER_LEN];
        context.encode(&mut bytes);
        assert_eq!(PictureContext::decode(&bytes).expect("decodes"), context);
    }

    #[test]
    fn every_flag_is_carried_on_its_own() {
        // One field at a time, so a flag written into the wrong bit is not
        // hidden by another that happens to be set the same way.
        let base = PictureContext {
            is_reference: false,
            mbaff: false,
            real_idr: false,
            recovery_intra: false,
            ..a_context()
        };
        let variants = [
            PictureContext {
                is_reference: true,
                ..base
            },
            PictureContext {
                mbaff: true,
                ..base
            },
            PictureContext {
                real_idr: true,
                ..base
            },
            PictureContext {
                recovery_intra: true,
                ..base
            },
            PictureContext {
                layout: RefLayout {
                    anchor_second_field: true,
                    ..base.layout
                },
                ..base
            },
            PictureContext {
                layout: RefLayout {
                    l1_short_term_delta: None,
                    ..base.layout
                },
                ..base
            },
            PictureContext {
                options: TranscodeOptions {
                    split_field_samples: false,
                    ..base.options
                },
                ..base
            },
        ];
        for variant in variants {
            let mut bytes = [0u8; JOB_HEADER_LEN];
            variant.encode(&mut bytes);
            assert_eq!(PictureContext::decode(&bytes).expect("decodes"), variant);
        }
    }

    #[test]
    fn negative_reference_indices_survive() {
        let context = PictureContext {
            layout: RefLayout {
                bwd_l0: -1,
                bwd_l1: -1,
                ..a_context().layout
            },
            ..a_context()
        };
        let mut bytes = [0u8; JOB_HEADER_LEN];
        context.encode(&mut bytes);
        assert_eq!(PictureContext::decode(&bytes).expect("decodes"), context);
    }

    #[test]
    fn an_output_survives_the_round_trip() {
        let output = PictureOutput {
            decoded: true,
            stats: Stats {
                integer_vectors: 1,
                single_axis_half_vectors: 2,
                both_axis_half_vectors: 3,
                bidirectional_vectors: 4,
                intra_macroblocks: 5,
                inter_macroblocks: 6,
                dropped: 7,
                errors: 8,
            },
            bitstream: vec![0, 0, 0, 1, 0x25, 0xff],
        };
        let decoded = PictureOutput::decode(&output.encode()).expect("decodes");
        assert_eq!(decoded.decoded, output.decoded);
        assert_eq!(decoded.bitstream, output.bitstream);
        assert_eq!(decoded.stats.integer_vectors, 1);
        assert_eq!(decoded.stats.errors, 8);
    }

    #[test]
    fn an_undecodable_output_carries_no_bitstream() {
        let output = PictureOutput {
            decoded: false,
            stats: Stats {
                errors: 1,
                ..Stats::default()
            },
            bitstream: Vec::new(),
        };
        let decoded = PictureOutput::decode(&output.encode()).expect("decodes");
        assert!(!decoded.decoded);
        assert!(decoded.bitstream.is_empty());
        assert_eq!(decoded.stats.errors, 1);
    }

    #[test]
    fn a_truncated_job_is_rejected() {
        assert!(PictureContext::decode(&[0u8; 8]).is_err());
        assert!(PictureOutput::decode(&[0u8; 8]).is_err());
    }

    #[test]
    fn a_version_from_another_build_is_rejected() {
        let mut bytes = [0u8; JOB_HEADER_LEN];
        a_context().encode(&mut bytes);
        bytes[0] = ENCODING_VERSION + 1;
        assert!(PictureContext::decode(&bytes).is_err());
    }
}
