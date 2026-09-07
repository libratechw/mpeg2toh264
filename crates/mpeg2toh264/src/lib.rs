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
pub use session::VideoScan;
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
/// Both targets must return the same level for the same input: the native
/// build and the WASM build share the bitstream contract, and a rounding
/// difference between them would break the output digests. The two
/// implementations below are the same rounding -- exact halves go towards
/// positive infinity, which is JavaScript's tie rule and not Rust's
/// `f32::round` -- written two ways only because what was measured differed
/// per target:
///
/// - wasm32 keeps the `(value + 0.5).floor()` expression. The shared
///   truncation formulation measured consistently slower in the tested WASM
///   setup, so it was kept for native only; why it is slower there was not
///   established.
/// - other targets compute the same floor without a per-coefficient call to
///   libm's `floorf`, which is what `f32::floor` lowers to on this target. The
///   truncation round-trip `x as i32 as f32` is exact for `|x| < 2^24`, and
///   every input the codec produces stays far inside that: the largest is
///   the luma level input, bounded by about 1.31e6. The chain is: dequant
///   clamps to ±2048 and removing `FLAT_PREDICTION_DC` puts the largest
///   target within 3064 in magnitude; the field/frame basis conversion
///   multiplies by at most 16 (two orthonormal 8-point passes, each bounded
///   by its basis row sums of at most 4); the random-access intra path can
///   then adjust DC by at most 1024; and the largest reciprocal is
///   `1 / (0.0385049076 * 1)` ≈ 25.97 -- the smallest `BASE_GAIN_8X8` entry
///   with scaling weight 1. Thus `(3064 * 16 + 1024) * 25.97` is about 1.30e6.
///   Chroma AC and DC inputs are lower. Within that domain `t` is the exact
///   truncation of `x`, `t > x` holds exactly when `x` is a negative
///   non-integer, and `t - 1` is exact too, so the result is identical to
///   `floor(x)`.
#[inline]
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn round_half_up_i32(value: f32) -> i32 {
    let x = value + 0.5;
    let truncated = x as i32 as f32;
    let floored = if truncated > x {
        truncated - 1.0
    } else {
        truncated
    };
    floored as i32
}

/// WASM variant: the contract and the tie rule are those of the non-wasm32
/// definition above; only the floor's implementation differs.
#[inline]
#[cfg(target_arch = "wasm32")]
pub(crate) fn round_half_up_i32(value: f32) -> i32 {
    (value + 0.5).floor() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_half_up_i32_breaks_f32_ties_toward_positive_infinity() {
        assert_eq!(round_half_up_i32(0.5), 1);
        assert_eq!(round_half_up_i32(1.5), 2);
        assert_eq!(round_half_up_i32(2.5), 3);
        assert_eq!(round_half_up_i32(-0.5), 0);
        assert_eq!(round_half_up_i32(-1.5), -1);
        assert_eq!(round_half_up_i32(-2.5), -2);
    }

    #[test]
    fn round_half_up_i32_rounds_off_halves_to_the_nearest_integer() {
        for (value, expected) in [
            (0.4f32, 0),
            (2.3, 2),
            (2.7, 3),
            (-2.3, -2),
            (-2.7, -3),
            (100.0, 100),
            (-100.0, -100),
        ] {
            assert_eq!(round_half_up_i32(value), expected, "value {value}");
        }
    }

    #[test]
    fn round_half_up_i32_matches_the_floor_formulation_everywhere_in_range() {
        // These tests run on the host and exercise only the non-wasm32
        // implementation. The wasm32 branch is `(value + 0.5).floor() as i32`
        // itself, so that expression is kept here as a test-local reference
        // and the two are compared over the whole reachable domain, far
        // inside |x| < 2^24. The end-to-end WASM evidence is the
        // compare-wasm digest comparison, not these tests.
        let reference = |value: f32| (value + 0.5).floor() as i32;
        for k in -2_000_000..2_000_000 {
            let v = k as f32;
            assert_eq!(round_half_up_i32(v), reference(v), "value {v}");
            assert_eq!(round_half_up_i32(v + 0.5), reference(v + 0.5), "half {v}");
        }
        let mut seed = 0x1234_5678u32;
        for _ in 0..1_000_000 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let bits = seed & 0x7fff_ffff;
            let v = f32::from_bits(bits);
            if v.abs() > 4_000_000.0 {
                continue;
            }
            assert_eq!(round_half_up_i32(v), reference(v), "bits {bits:08x}");
            assert_eq!(round_half_up_i32(-v), reference(-v), "neg bits {bits:08x}");
        }
        for v in [
            16_777_216.0f32,
            33_554_432.0,
            -16_777_216.0,
            4_000_000.0,
            -4_000_000.0,
            0.5,
            -0.5,
        ] {
            assert_eq!(round_half_up_i32(v), reference(v), "boundary {v}");
        }
    }

    #[test]
    fn round_half_up_keeps_the_same_tie_rule_in_double_precision() {
        assert_eq!(round_half_up(0.5), 1.0);
        assert_eq!(round_half_up(1.5), 2.0);
        assert_eq!(round_half_up(-0.5), 0.0);
        assert_eq!(round_half_up(-1.5), -1.0);
    }
}
