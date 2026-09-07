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
/// - other targets compute the same floor as an integer expression that the
///   compiler can vectorise: `x as i32` is a saturating truncation, and the
///   comparison `x < truncated as f32` is false for NaN, so the `& mask` turns
///   exactly the negative non-integer correction. The reachable codec inputs
///   are far inside `|x| < 2^24` (the largest luma level input is bounded by
///   about 1.31e6; see the chain from dequant ±2048 and `FLAT_PREDICTION_DC`
///   through the ≤16 basis conversion and the largest reciprocal ≈25.97), but
///   the case proof below covers every `f32` input, so no out-of-domain
///   difference is accepted:
///
///   - `x` NaN: the saturating cast gives 0 and `NaN < 0.0` is false, so the
///     result is 0, exactly what `NaN.floor() as i32` saturates to.
///   - `x` `+inf` or a finite value `>= 2^31`: the cast saturates to
///     `i32::MAX`; `x < 2^31` is false, the mask is 1, and the result is
///     `i32::MAX`, the floor's saturated cast.
///   - `x` `-inf` or a finite value `< -2^31`: the cast saturates to
///     `i32::MIN`, and the `truncated != i32::MIN` mask suppresses the
///     correction so the result stays `i32::MIN` instead of wrapping to
///     `i32::MAX`. This is the case the mask exists for; the floor's saturated
///     cast also gives `i32::MIN`.
///   - `-2^31 <= x < 2^31` finite: `x as i32` is the exact truncation (every
///     representable `f32` here is an integer, or its integer truncation
///     round-trips exactly). For `x >= 0` and for negative integers,
///     `x < trunc(x)` is false and the result is `trunc(x) = floor(x)`. For
///     negative non-integers `x < trunc(x)` is true and the result is
///     `trunc(x) - 1 = floor(x)`.
///
///   The result is `floor(x)` for every `f32` input, matching
///   `(value + 0.5).floor() as i32`. No claim is made about future compiler
///   versions producing the same vectorised code as the current one.
#[inline]
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn round_half_up_i32(value: f32) -> i32 {
    let x = value + 0.5;
    let truncated = x as i32;
    let correction = i32::from(x < truncated as f32) & i32::from(truncated != i32::MIN);
    truncated - correction
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
        // and the two are compared over the reachable domain plus the
        // saturating boundary cases the randomized filter cannot reach. The
        // randomized filter below skips infinities and large finite values
        // (`v.abs() > 4e6` is true for both infinities), while NaN passes the
        // comparison (`NaN > 4e6` is false) and so is exercised by the random
        // loop; the explicit boundary list covers the excluded cases. The
        // end-to-end WASM evidence is the compare-wasm digest comparison, not
        // these tests.
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
            f32::NEG_INFINITY,
            f32::INFINITY,
            f32::NAN,
            -2_147_483_648.0, // -2^31, exactly i32::MIN
            -2_147_483_904.0, // -2^31 - 256, the first representable f32 below
            2_147_483_648.0,  // 2^31, just past i32::MAX
            2_147_483_904.0,  // 2^31 + 256, the next representable f32 above
        ] {
            assert_eq!(round_half_up_i32(v), reference(v), "boundary {v}");
        }
    }
}
