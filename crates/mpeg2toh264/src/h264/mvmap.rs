//! Mapping MPEG-2 motion vectors onto H.264 prediction.
//!
//! MPEG-2 vectors are in half samples and its half-sample prediction is the
//! bilinear average `(a + b + 1) >> 1`. H.264's default bi-prediction averages
//! its two list predictions as `(P0 + P1 + 1) >> 1`, so pointing both lists at
//! the same reference picture one whole sample apart reproduces that filter
//! exactly -- H.264's own six-tap interpolation never runs.
//!
//! Two things cannot be reproduced:
//!
//! - The half-sample position on both axes averages four samples, which two
//!   predictions cannot express. There the bilinear is kept exact along one axis
//!   and the six-tap handles the other, which measured better than letting
//!   H.264 interpolate both.
//! - Chroma. MPEG-2 halves the luma vector with truncation toward zero
//!   (clause 7.6.3.7) while H.264 derives chroma motion from the luma vector at
//!   eighth-sample precision, so an odd luma vector puts chroma a quarter of a
//!   chroma sample out. H.264 offers no way to set chroma motion separately, so
//!   this is there however the luma is mapped.

/// What a mapped vector costs in fidelity.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VectorKind {
    /// Whole-sample position: luma and chroma both exact.
    Integer,
    /// Half sample on one axis: luma exact, chroma a quarter sample out.
    HalfOneAxis,
    /// Half sample on both axes: luma approximate as well.
    HalfBothAxes,
}

#[derive(Clone, Copy, Debug)]
pub struct MappedPosition {
    pub kind: VectorKind,
    /// Primary position in quarter samples.
    pub a: [i32; 2],
    /// Second position for the bi-predicted pair, or `None` when one prediction
    /// is enough. Both refer to the same reference picture.
    pub b: Option<[i32; 2]>,
}

/// Map one MPEG-2 vector, given in half samples, to the position or pair of
/// positions that reproduce its prediction.
///
/// Arithmetic shift gives the floor for negative values, matching the DIV of
/// clause 7.6.4: a vector of -3 is integer part -2 with a half-sample offset.
pub fn map_vector(mvx_half: i32, mvy_half: i32) -> MappedPosition {
    let ix = mvx_half >> 1;
    let iy = mvy_half >> 1;
    let fx = mvx_half & 1;
    let fy = mvy_half & 1;

    if fx == 0 && fy == 0 {
        return MappedPosition {
            kind: VectorKind::Integer,
            a: [ix * 4, iy * 4],
            b: None,
        };
    }
    if fy == 0 {
        return MappedPosition {
            kind: VectorKind::HalfOneAxis,
            a: [ix * 4, iy * 4],
            b: Some([(ix + 1) * 4, iy * 4]),
        };
    }
    if fx == 0 {
        return MappedPosition {
            kind: VectorKind::HalfOneAxis,
            a: [ix * 4, iy * 4],
            b: Some([ix * 4, (iy + 1) * 4]),
        };
    }
    // Both predictions sit at H.264's vertical half sample, so the bi-prediction
    // average runs horizontally and stays exactly bilinear there; the six-tap
    // filter absorbs the vertical axis.
    MappedPosition {
        kind: VectorKind::HalfBothAxes,
        a: [ix * 4, iy * 4 + 2],
        b: Some([(ix + 1) * 4, iy * 4 + 2]),
    }
}

/// The plain quarter-sample position, letting H.264 interpolate. Used where both
/// predictions are already spoken for -- a bidirectional macroblock averages a
/// forward and a backward prediction, so neither side has a spare slot for the
/// bilinear pair. The averaging structure still matches MPEG-2's; only the
/// sub-sample filter differs.
pub fn native_position(mvx_half: i32, mvy_half: i32) -> [i32; 2] {
    [mvx_half * 2, mvy_half * 2]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_sample_vector_needs_one_prediction() {
        let mapped = map_vector(4, -6);
        assert_eq!(mapped.kind, VectorKind::Integer);
        assert_eq!(mapped.a, [8, -12], "half samples become quarter samples");
        assert_eq!(mapped.b, None);
    }

    #[test]
    fn a_half_sample_axis_becomes_a_bilinear_pair_one_sample_apart() {
        let horizontal = map_vector(3, 4);
        assert_eq!(horizontal.kind, VectorKind::HalfOneAxis);
        assert_eq!(horizontal.a, [4, 8]);
        assert_eq!(
            horizontal.b,
            Some([8, 8]),
            "the pair straddles the position"
        );

        let vertical = map_vector(4, 3);
        assert_eq!(vertical.a, [8, 4]);
        assert_eq!(vertical.b, Some([8, 8]));
    }

    #[test]
    fn a_negative_half_sample_floors_rather_than_truncating() {
        // Clause 7.6.4 divides toward minus infinity: -3 is -2 plus a half.
        let mapped = map_vector(-3, 0);
        assert_eq!(mapped.a, [-8, 0]);
        assert_eq!(mapped.b, Some([-4, 0]));
    }

    #[test]
    fn a_half_sample_on_both_axes_keeps_the_horizontal_exact() {
        // Two predictions cannot average four samples, so the pair stays
        // bilinear horizontally and the six-tap filter absorbs the vertical.
        let mapped = map_vector(3, 5);
        assert_eq!(mapped.kind, VectorKind::HalfBothAxes);
        assert_eq!(mapped.a, [4, 10], "vertically at the half sample");
        assert_eq!(mapped.b, Some([8, 10]));
    }

    #[test]
    fn the_native_position_just_doubles() {
        assert_eq!(native_position(3, -5), [6, -10]);
    }
}
