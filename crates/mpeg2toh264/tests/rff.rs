//! Soft telecine timing, read back independently from the emitted MP4 boxes.

mod support;

use std::collections::HashMap;

use mpeg2toh264::mpeg2::{gop_stream::Mpeg2GopStream, headers::parse_elementary_stream};
use mpeg2toh264::{
    mpeg2_video_timeline, Fragment, PictureEncoder, Progress, Session, TranscodeOptions, VideoMode,
};
use support::{read_fixture, wrap_mpeg2_es_in_ts};

const ORIGIN: u64 = 891_000;
const START: u64 = 900_000;

/// Fifteen pictures, deliberately odd, so alternating RFF crosses GOPs. The
/// fixture has B pictures, so decode order cannot be used as display order.
fn gop(film_start: Option<usize>) -> Vec<u8> {
    set_film(read_fixture("ibbp.m2v"), film_start)
}

fn set_film(mut data: Vec<u8>, film_start: Option<usize>) -> Vec<u8> {
    let mut tr = 0;
    for at in 0..data.len() - 9 {
        if data[at..at + 3] != [0, 0, 1] {
            continue;
        }
        match data[at + 3] {
            0xb3 => data[at + 7] = (data[at + 7] & 0xf0) | 4, // 30000/1001
            0x00 => tr = (usize::from(data[at + 4]) << 2) | usize::from(data[at + 5] >> 6),
            0xb5 if data[at + 4] >> 4 == 1 => data[at + 5] &= !8, // interlaced sequence
            0xb5 if data[at + 4] >> 4 == 8 => {
                let index = film_start.unwrap_or(0) + tr;
                let repeat = film_start.is_some() && index % 2 == 1;
                let top = film_start.is_none() || (index / 2) % 2 == 0;
                data[at + 7] =
                    (data[at + 7] & !0x82) | (u8::from(top) << 7) | (u8::from(repeat) << 1);
                data[at + 8] = (data[at + 8] & !0x80) | (u8::from(film_start.is_some()) << 7);
            }
            _ => {}
        }
    }
    data
}

fn ticks(fields: u64) -> u64 {
    (fields * 3003 + 1) / 2
}

fn field_count(film_start: Option<usize>) -> u64 {
    30 + film_start.map_or(0, |start| {
        (start..start + 15).filter(|i| i % 2 == 1).count()
    }) as u64
}

fn stream(groups: &[Option<usize>], gap_before: Option<usize>) -> Vec<u8> {
    let mut fields = 0;
    let mut continuity = HashMap::new();
    let mut stream = Vec::new();
    for (index, &film_start) in groups.iter().enumerate() {
        let gap = if gap_before.is_some_and(|at| index >= at) {
            90_000
        } else {
            0
        };
        stream.extend(wrap_mpeg2_es_in_ts(
            &gop(film_start),
            Some(START + ticks(fields) + gap),
            &mut continuity,
        ));
        fields += field_count(film_start);
    }
    stream
}

fn run(stream: &[u8], mode: VideoMode, chunk: usize) -> Vec<Fragment> {
    let mut session = Session::anchored(
        TranscodeOptions {
            video: mode,
            recovery_interval: 1000,
            ..TranscodeOptions::default()
        },
        Some(ORIGIN),
    );
    let mut out = Vec::new();
    for bytes in stream.chunks(chunk) {
        out.extend(session.push(bytes).unwrap());
    }
    out.extend(session.finish().unwrap());
    out
}

fn box_body<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    let mut at = 0;
    while at + 8 <= data.len() {
        let size = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        let body = &data[at + 8..at + size];
        let name = &data[at + 4..at + 8];
        if name == kind {
            return Some(body);
        }
        if name == b"moof" || name == b"traf" {
            if let Some(found) = box_body(body, kind) {
                return Some(found);
            }
        }
        at += size;
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
struct Sample {
    pts: u64,
    duration: u64,
}

fn samples(fragments: &[Fragment]) -> Vec<Sample> {
    let mut out = Vec::new();
    let mut previous_end = None;
    for fragment in fragments {
        let Fragment::Media { data, .. } = fragment else {
            continue;
        };
        let tfdt = box_body(data, b"tfdt").unwrap();
        assert_eq!(tfdt[0], 1);
        let mut dts = u64::from_be_bytes(tfdt[4..12].try_into().unwrap());
        if let Some(end) = previous_end {
            assert_eq!(
                dts, end,
                "film/video transitions must not overlap or gap in decode time"
            );
        }
        let trun = box_body(data, b"trun").unwrap();
        assert_eq!(&trun[..4], &[1, 0, 15, 1]);
        let count = u32::from_be_bytes(trun[4..8].try_into().unwrap()) as usize;
        for index in 0..count {
            let at = 12 + index * 16;
            let duration = u32::from_be_bytes(trun[at..at + 4].try_into().unwrap()) as u64;
            let offset = u32::from_be_bytes(trun[at + 12..at + 16].try_into().unwrap()) as u64;
            // The initial IDR clone is a one-tick sample, not a film frame.
            if duration > 1 {
                out.push(Sample {
                    pts: dts + offset,
                    duration,
                });
            }
            dts += duration;
        }
        previous_end = Some(dts);
    }
    out.sort_by_key(|s| s.pts);
    out
}

fn film_pts(index: usize, starts_with_repeat: bool) -> u64 {
    if starts_with_repeat {
        (index as u64 * 15_015 + 2) / 4
    } else if index == 0 {
        0
    } else {
        // Before the first RFF flag arrives, a plain picture keeps two fields.
        3003 + ((index - 1) as u64 * 15_015 + 2) / 4
    }
}

#[test]
fn rff_is_even_across_odd_gops_on_both_paths() {
    for phase in 0..2 {
        let source = stream(
            &[
                Some(phase),
                Some(phase + 15),
                Some(phase + 30),
                Some(phase + 45),
            ],
            None,
        );
        for mode in [VideoMode::Transcode, VideoMode::Passthrough] {
            for chunk in [97, 1024 * 1024] {
                let frames = samples(&run(&source, mode, chunk));
                assert_eq!(frames.len(), 60);
                for (index, sample) in frames.iter().enumerate() {
                    assert_eq!(
                        sample.pts - frames[0].pts,
                        film_pts(index, phase == 1),
                        "frame {index}, {mode:?}, phase {phase}"
                    );
                    if phase == 1 || index > 0 {
                        assert!((3753..=3754).contains(&sample.duration), "{sample:?}");
                    }
                }
                assert_eq!(
                    frames.iter().map(|s| s.duration).sum::<u64>(),
                    film_pts(60, phase == 1)
                );
            }
        }
    }
}

#[test]
fn mixed_video_has_no_gap_and_returns_to_source_time_after_one_picture() {
    let source = stream(&[None, Some(0), Some(15), None], None);
    for mode in [VideoMode::Transcode, VideoMode::Passthrough] {
        let frames = samples(&run(&source, mode, 1009));
        assert_eq!(frames.len(), 60);
        for (index, frame) in frames.iter().enumerate() {
            let expected = if index < 15 {
                index as u64 * 3003
            } else if index < 45 {
                45_045 + film_pts(index - 15, false)
            } else if index == 45 {
                // The preceding RFF already committed this boundary. It must
                // not be changed by discovering that native video follows.
                156_907
            } else {
                157_658 + (index - 45) as u64 * 3003
            };
            assert_eq!(frame.pts - frames[0].pts, expected, "frame {index}");
            if let Some(next) = frames.get(index + 1) {
                // Transcode's initial reference clone borrows one tick.
                assert!(next.pts.abs_diff(frame.pts + frame.duration) <= 1);
            }
        }
        assert!(frames[16..=45]
            .iter()
            .all(|s| (3753..=3754).contains(&s.duration)));
        assert!(frames[46..].iter().all(|s| s.duration == 3003));
        assert_eq!(frames.iter().map(|s| s.duration).sum::<u64>(), 202_703);
    }
}

#[test]
fn standalone_timing_matches_display_order_and_preserves_picture_selection() {
    let source = [gop(Some(0)), gop(Some(15))].concat();
    let timeline = mpeg2_video_timeline(&source, false, &[]).unwrap();
    for (&index, &pts) in timeline
        .presentation_indices
        .iter()
        .zip(&timeline.presentation_times)
    {
        assert_eq!(pts, film_pts((index - 1) as usize, false));
    }
    let mut damaged = vec![false; 30];
    damaged[7] = true;
    let dropped = mpeg2_video_timeline(&source, false, &damaged).unwrap();
    assert_eq!(
        dropped.presentation_indices.len(),
        timeline.presentation_indices.len() - 1
    );
    for (&index, &pts) in dropped
        .presentation_indices
        .iter()
        .zip(&dropped.presentation_times)
    {
        assert_eq!(
            pts,
            timeline.presentation_times[timeline
                .presentation_indices
                .iter()
                .position(|i| *i == index)
                .unwrap()]
        );
    }
}

#[test]
fn missing_gops_cannot_change_an_already_emitted_duration() {
    let source = stream(&[Some(0), Some(15)], Some(1));
    let fragments = run(&source, VideoMode::Passthrough, 97);
    let first = fragments
        .iter()
        .find_map(|f| match f {
            Fragment::Media { .. } => Some(f),
            _ => None,
        })
        .unwrap();
    let frames = samples(std::slice::from_ref(first));
    assert!((3753..=3754).contains(&frames.last().unwrap().duration));
    assert_eq!(frames.iter().map(|s| s.duration).sum::<u64>(), 55_556);
    let continuous = run(
        &stream(&[Some(0), Some(15)], None),
        VideoMode::Passthrough,
        97,
    );
    let continuous_first = continuous
        .iter()
        .find(|f| matches!(f, Fragment::Media { .. }))
        .unwrap();
    assert_eq!(frames, samples(std::slice::from_ref(continuous_first)));
}

#[test]
fn open_gop_pts_stay_on_the_source_clock_and_seeks_land_at_the_same_time() {
    let mut splitter = Mpeg2GopStream::new();
    let mut groups = splitter.push(&read_fixture("open_gop_leading_bb.m2v"), None);
    groups.extend(splitter.finish());
    let mut index = 0usize;
    let mut pieces = Vec::new();
    let mut continuity = HashMap::new();
    for group in groups {
        let data = set_film(group.data, Some(index));
        let pictures = parse_elementary_stream(&data).unwrap();
        let first = index + pictures[0].header.temporal_reference as usize;
        let pts = START + ticks((first * 2 + first / 2) as u64);
        pieces.push(wrap_mpeg2_es_in_ts(&data, Some(pts), &mut continuity));
        index += pictures.len();
    }
    for mode in [VideoMode::Transcode, VideoMode::Passthrough] {
        let all = samples(&run(&pieces.concat(), mode, 919));
        assert_eq!(all.len(), 46);
        for (index, sample) in all.iter().enumerate() {
            assert_eq!(sample.pts - all[0].pts, film_pts(index, false));
            if index > 0 {
                assert!((3753..=3754).contains(&sample.duration));
            }
        }
        let seeked = samples(&run(&pieces[1..].concat(), mode, 919));
        // A seek holds its opening picture over the unavailable leading Bs.
        // The following pictures must still agree with continuous playback.
        for (actual, expected) in seeked.iter().rev().zip(all.iter().rev()).take(28) {
            assert!(
                actual.pts.abs_diff(expected.pts) <= 1,
                "{actual:?} versus {expected:?}"
            );
        }
    }
}

#[test]
fn consecutive_repeats_keep_decode_time_continuous_through_the_last_open_gop() {
    let mut splitter = Mpeg2GopStream::new();
    let mut groups = splitter.push(&read_fixture("open_gop_leading_bb.m2v"), None);
    groups.extend(splitter.finish());
    let mut continuity = HashMap::new();
    let mut source = Vec::new();
    let mut index = 0usize;
    for group in groups {
        let mut data = set_film(group.data, Some(0));
        for at in 0..data.len() - 9 {
            if data[at..at + 4] == [0, 0, 1, 0xb5] && data[at + 4] >> 4 == 8 {
                data[at + 7] |= 2;
            }
        }
        let pictures = parse_elementary_stream(&data).unwrap();
        let first = index + pictures[0].header.temporal_reference as usize;
        source.extend(wrap_mpeg2_es_in_ts(
            &data,
            Some(START + ticks(first as u64 * 3)),
            &mut continuity,
        ));
        index += pictures.len();
    }
    for mode in [VideoMode::Transcode, VideoMode::Passthrough] {
        let frames = samples(&run(&source, mode, 97));
        assert_eq!(frames.len(), index);
        for pair in frames[1..].windows(2) {
            assert!((4504..=4505).contains(&(pair[1].pts - pair[0].pts)));
        }
    }
}

#[test]
fn interlaced_pictures_and_progressive_sequences_keep_their_source_durations() {
    for kind in 0..2 {
        let mut source = gop(Some(0));
        for at in 0..source.len() - 9 {
            if source[at..at + 4] != [0, 0, 1, 0xb5] {
                continue;
            }
            match (kind, source[at + 4] >> 4) {
                (0, 8) => source[at + 8] &= !0x80, // interlaced pictures
                (1, 1) => source[at + 5] |= 8,     // progressive sequence
                _ => {}
            }
        }
        let timeline = mpeg2_video_timeline(&source, false, &[]).unwrap();
        assert!(timeline
            .sample_durations
            .iter()
            .all(|d| [3003, 4504, 4505].contains(d)));
    }
}

/// Send one whole GOP followed by only a prefix of the next. The final PES
/// starts with a byte of slice payload: it flushes the previous PES without
/// contributing another picture header or completing the second GOP.
fn push_prefix(
    first: &[u8],
    prefix: &[u8],
    next_pts: u64,
    mode: VideoMode,
    deferred: bool,
) -> Vec<Fragment> {
    let mut continuity = HashMap::new();
    let mut source = wrap_mpeg2_es_in_ts(first, Some(START), &mut continuity);
    source.extend(wrap_mpeg2_es_in_ts(prefix, Some(next_pts), &mut continuity));
    source.extend(wrap_mpeg2_es_in_ts(&[0], None, &mut continuity));
    let mut session = Session::anchored(
        TranscodeOptions {
            video: mode,
            ..TranscodeOptions::default()
        },
        Some(ORIGIN),
    );
    if !deferred {
        return session.push(&source).unwrap();
    }
    let mut progress = session.push_deferred(&source).unwrap();
    let mut encoder = PictureEncoder::new();
    let mut out = Vec::new();
    loop {
        out.extend(progress.fragments());
        match progress {
            Progress::Idle(_) => return out,
            Progress::Pending { jobs, .. } => {
                let outputs = jobs
                    .iter()
                    .map(|job| encoder.encode(job).unwrap())
                    .collect::<Vec<_>>();
                progress = session.complete(&outputs).unwrap();
            }
        }
    }
}

#[test]
fn video_and_rff_emit_without_any_following_picture_on_all_paths() {
    for open in [false, true] {
        for phase in [None, Some(0), Some(1)] {
            let (first, next, count) = if open {
                let mut splitter = Mpeg2GopStream::new();
                let groups = splitter.push(&read_fixture("open_gop_leading_bb.m2v"), None);
                (
                    set_film(groups[0].data.clone(), phase),
                    set_film(groups[1].data.clone(), phase.map(|p| p + 13)),
                    13,
                )
            } else {
                (gop(phase), gop(phase.map(|p| p + 15)), 15)
            };
            let picture = next
                .windows(4)
                .position(|bytes| bytes == [0, 0, 1, 0])
                .unwrap();
            // Both fixtures' next first coded picture is at display slot 15.
            let next_pts = START + ticks(field_count(phase));
            for mode in [VideoMode::Transcode, VideoMode::Passthrough] {
                for deferred in [false, true] {
                    // Only the existing splitter's boundary marker arrives.
                    // No picture header, RFF flag, or slice of the next GOP is
                    // present, and finish() is deliberately never called.
                    let out = push_prefix(&first, &next[..picture], next_pts, mode, deferred);
                    let frames = samples(&out);
                    assert_eq!(
                        frames.len(),
                        count,
                        "{mode:?}, phase {phase:?}, open {open}, deferred {deferred}"
                    );
                    if phase.is_some() {
                        assert!((3753..=3754).contains(&frames.last().unwrap().duration));
                    }
                    // Supplying the following GOP cannot revise an output
                    // that was committed without knowing its picture flags.
                    let with_next = push_prefix(&first, &next, next_pts, mode, deferred);
                    assert_eq!(frames, samples(&with_next));
                }
            }
        }
    }
}
