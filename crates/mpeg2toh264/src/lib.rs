//! MPEG-2 to H.264 bitstream-domain transcoding.
//!
//! The transcoder keeps the MPEG-2 coefficient and motion vector structure and
//! re-expresses it in H.264 syntax. On the luma path no pixels are reconstructed
//! at all: MPEG-2 levels are dequantised into orthonormal-DCT values and
//! requantised straight into H.264 levels, with no inverse transform, no motion
//! compensation and no reference frame buffer. See [`transcode`] for the whole
//! picture, and [`h264::chroma`] for the one path that does reconstruct samples.

// The transform, quantiser and residual paths index several arrays in step with
// a position or block number taken straight from the specification's own
// formulas. Rewriting those as iterator chains hides the correspondence that
// makes them checkable against the text.
#![allow(clippy::needless_range_loop)]

mod error;

pub mod bitreader;
pub mod container;
pub mod h264;
pub mod job;
pub mod mpeg2;
pub mod session;
pub mod transcode;

pub use error::{Error, Result};
pub use job::{PictureJob, PictureOutput, TranscoderState};

pub use container::adts::DualMono;
pub use container::fmp4::{
    h264_gop_to_fmp4, h264_to_fmp4, mpeg2_gop_to_fmp4, mpeg2_passthrough_unit, mpeg2_to_fmp4,
    mpeg2_video_timeline, Fmp4Fragment, Fmp4Output, Mpeg2Sample, Mpeg2Unit, Mpeg2VideoTimeline,
    UnitLeadIn,
};
pub use container::mpegts::{
    extract_mpeg2_video_es, first_pts, is_mpeg_transport_stream, last_pts, AudioStream,
    ElementaryKind, MpegTsAvDemuxer,
};
pub use mpeg2::headers::{
    pictures_interlacing, stream_sequence_description, Interlacing, SequenceDescription,
};
pub use session::{Fragment, Progress, Session};
pub use transcode::{
    plan_unit, transcode, IncrementalTranscoder, OpenGopRecovery, PictureEncoder, TranscodeOptions,
    TranscodeResult, UnitPlan, UnitRequest, VideoMode,
};

/// JavaScript's `Math.round`, which the reference implementation used
/// throughout: exact halves go towards positive infinity, where Rust's
/// [`f64::round`] sends them away from zero. Keeping the tie-break identical is
/// what makes the two implementations produce the same bitstream.
#[inline]
pub(crate) fn round_half_up(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// [`round_half_up`] straight to an integer, for the quantiser hot paths.
///
/// Single precision: the coefficient path works in f32, where a dequantised
/// MPEG-2 value -- at most about 3.7 million -- is still exact, and twice as
/// many of them fit in a vector register.
#[inline]
pub(crate) fn round_half_up_i32(value: f32) -> i32 {
    (value + 0.5).floor() as i32
}
