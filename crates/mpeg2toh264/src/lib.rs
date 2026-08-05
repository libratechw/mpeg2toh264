//! MPEG-2 to H.264 bitstream-domain transcoding.
//!
//! The transcoder keeps the MPEG-2 coefficient and motion vector structure and
//! re-expresses it in H.264 syntax. On the luma path no pixels are reconstructed
//! at all: MPEG-2 levels are dequantised into orthonormal-DCT values and
//! requantised straight into H.264 levels, with no inverse transform, no motion
//! compensation and no reference frame buffer. See [`transcode`] for the whole
//! picture, and [`h264::chroma`] for the one path that does reconstruct samples.

mod error;

pub mod bitreader;
pub mod container;
pub mod h264;
pub mod mpeg2;
pub mod transcode;

pub use error::{Error, Result};

pub use container::fmp4::{h264_to_fmp4, mpeg2_video_timeline, Fmp4Output, Mpeg2VideoTimeline};
pub use container::mpegts::{extract_mpeg2_video_es, is_mpeg_transport_stream};
pub use transcode::{transcode, IncrementalTranscoder, TranscodeOptions, TranscodeResult};

/// JavaScript's `Math.round`, which the reference implementation used
/// throughout: exact halves go towards positive infinity, where Rust's
/// [`f64::round`] sends them away from zero. Keeping the tie-break identical is
/// what makes the two implementations produce the same bitstream.
#[inline]
pub(crate) fn round_half_up(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// [`round_half_up`] straight to an integer, for the quantiser hot paths.
#[inline]
pub(crate) fn round_half_up_i32(value: f64) -> i32 {
    (value + 0.5).floor() as i32
}
