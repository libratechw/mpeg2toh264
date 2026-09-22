//! Causal soft-telecine timing: each picture commits its own end time.

use crate::mpeg2::constants::{PictureStructure, FRAME_RATE};
use crate::mpeg2::headers::Picture;
use crate::round_half_up;

pub(crate) fn frame_rate(picture: &Picture) -> (u32, u32) {
    let (n, d) = FRAME_RATE
        .get(picture.sequence.frame_rate_code as usize)
        .copied()
        .unwrap_or((0, 0));
    (
        n * (picture.sequence_ext.frame_rate_extension_n + 1),
        d * (picture.sequence_ext.frame_rate_extension_d + 1),
    )
}

/// Soft telecine at 59.94/60 fields per second, not frame repetition in a
/// progressive sequence or the ordinary interlaced pictures beside it.
pub(crate) fn supports_film(picture: &Picture) -> bool {
    let (n, d) = frame_rate(picture);
    d != 0
        && !picture.sequence_ext.progressive_sequence
        && (u64::from(n) * 1001 == u64::from(d) * 30_000 || n == d * 30)
}

pub(crate) fn is_film_repeat(picture: &Picture) -> bool {
    supports_film(picture)
        && picture.coding.picture_structure == PictureStructure::Frame
        && picture.coding.progressive_frame
        && picture.coding.repeat_first_field
        && !picture.slices.is_empty()
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RffState {
    fields: u64,
    rate: (u32, u32),
    /// The already-committed end relative to the source end, in ticks. Never
    /// positive: zero, or half a field early after a progressive RFF picture.
    end_shift: i64,
}

pub(crate) struct DisplayTiming {
    pub starts: Vec<u64>,
    pub durations: Vec<u32>,
    pub source_starts: Vec<u64>,
    pub start_shift: i64,
    pub after: RffState,
}

/// Slots are in display order, with slot zero unused. An RFF picture commits
/// its end half a field early; the next picture starts exactly there and
/// commits its own end using its own header. Alternating 3/2-field pictures
/// therefore occupy 2.5/2.5 fields, even across a GOP boundary with no bytes of
/// the following picture available.
///
/// If native video follows an RFF picture, its first picture starts up to half
/// a field early and covers that difference; the next is back on source time.
/// Consecutive RFF pictures keep their three-field spacing.
pub(crate) fn display_timing(
    fields: &[u8],
    repeats: &[bool],
    rate: (u32, u32),
    before: RffState,
) -> DisplayTiming {
    let field_ticks = 90_000.0 * f64::from(rate.1) / f64::from(rate.0) / 2.0;
    let (mut position, start_shift) = if before.rate == rate {
        (before.fields, before.end_shift)
    } else {
        (0, 0)
    };
    let tick = |position: f64| round_half_up(position * field_ticks) as u64;
    let source_origin = tick(position as f64);
    let mut shift = start_shift;
    let mut starts = vec![0; fields.len()];
    let mut source_starts = vec![0; fields.len()];
    let mut durations = vec![0; fields.len()];
    for index in 1..fields.len() {
        let source_start = tick(position as f64) - source_origin;
        source_starts[index] = source_start;
        starts[index] = (source_start as i64 + shift - start_shift) as u64;
        position += u64::from(fields[index]);
        let source_end = tick(position as f64);
        shift = if repeats[index] {
            tick(position as f64 - 0.5) as i64 - source_end as i64
        } else {
            0
        };
        let end = (source_end - source_origin) as i64 + shift - start_shift;
        durations[index] = (end as u64 - starts[index]) as u32;
    }
    DisplayTiming {
        starts,
        durations,
        source_starts,
        start_shift,
        after: RffState {
            fields: position,
            rate,
            end_shift: shift,
        },
    }
}
