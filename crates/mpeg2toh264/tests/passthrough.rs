//! Carrying the MPEG-2 video through to the MP4 instead of converting it.
//!
//! The point of this path is that nothing happens to the picture, so that is
//! what these check: the bytes that come out are the bytes that went in, cut
//! into the same access units the transcoding path would have coded, sitting at
//! the same times on the same timeline.

mod support;

use mpeg2toh264::mpeg2::headers::parse_elementary_stream;
use mpeg2toh264::{
    mpeg2_passthrough_unit, mpeg2_to_fmp4, Fragment, Session, TranscodeOptions, VideoMode,
};
use support::{fnv1a, read_fixture, wrap_mpeg2_es_in_ts, FIXTURES};

fn passthrough_options() -> TranscodeOptions {
    TranscodeOptions {
        video: VideoMode::Passthrough,
        ..TranscodeOptions::default()
    }
}

fn run_session(stream: &[u8], options: TranscodeOptions) -> Vec<Fragment> {
    let mut session = Session::new(options);
    let mut fragments = Vec::new();
    for chunk in stream.chunks(64 * 1024) {
        fragments.extend(session.push(chunk).expect("push succeeds"));
    }
    fragments.extend(session.finish().expect("finish succeeds"));
    fragments
}

/// The payload of the one `mdat` in a media segment. A session with no audio
/// puts nothing else in it, so this is every video sample end to end.
fn mdat_payload(segment: &[u8]) -> &[u8] {
    let mut at = 0;
    while at + 8 <= segment.len() {
        let size = u32::from_be_bytes(segment[at..at + 4].try_into().expect("four bytes")) as usize;
        assert!(
            size >= 8 && at + size <= segment.len(),
            "box at {at} overruns"
        );
        if &segment[at + 4..at + 8] == b"mdat" {
            return &segment[at + 8..at + size];
        }
        at += size;
    }
    panic!("media segment has no mdat");
}

/// Every video sample of a video-only session, end to end.
fn media_bytes(fragments: &[Fragment]) -> Vec<u8> {
    let mut out = Vec::new();
    for fragment in fragments {
        if let Fragment::Media { data, .. } = fragment {
            out.extend_from_slice(mdat_payload(data));
        }
    }
    out
}

fn media_only(fragments: &[Fragment]) -> Vec<&Fragment> {
    fragments
        .iter()
        .filter(|f| matches!(f, Fragment::Media { .. }))
        .collect()
}

// ------------------------------------------------------------ the whole unit

#[test]
fn cuts_every_fixture_into_one_sample_per_picture() {
    for name in FIXTURES {
        let source = read_fixture(name);
        let unit = mpeg2_passthrough_unit(&source, false).expect("passthrough unit");
        assert_eq!(
            unit.samples.len(),
            unit.timeline.presentation_indices.len(),
            "{name} has a sample for each picture the timeline places"
        );
        assert!(unit.samples[0].sync, "{name} opens at an intra picture");
        assert!(
            unit.sequence_header_len > 0,
            "{name} opens with a sequence header"
        );
        // Samples run end to end, in order, inside the unit.
        let mut previous = 0;
        for (index, sample) in unit.samples.iter().enumerate() {
            assert!(
                sample.start >= previous && sample.end > sample.start,
                "{name} sample {index} is {}..{} after {previous}",
                sample.start,
                sample.end
            );
            previous = sample.end;
        }
        assert!(previous <= source.len(), "{name} runs past the source");
    }
}

#[test]
fn carries_the_source_bytes_unchanged() {
    // Nothing is decoded and nothing is coded, so every byte of every picture
    // the unit keeps has to reach the MP4 as it stood. A fixture is one group
    // of pictures with nothing dropped, so that is all of them.
    for name in FIXTURES {
        let source = read_fixture(name);
        let unit = mpeg2_passthrough_unit(&source, false).expect("passthrough unit");
        let carried: Vec<u8> = unit
            .samples
            .iter()
            .flat_map(|sample| source[sample.start..sample.end].iter().copied())
            .collect();
        let end = unit.samples.last().expect("a sample").end;
        assert_eq!(
            fnv1a(&carried),
            fnv1a(&source[..end]),
            "{name} was altered on the way through"
        );
        // What is left out is the tail after the last slice, which holds no
        // picture: a sequence end code, or padding.
        let pictures = parse_elementary_stream(&source[end..]).expect("tail parses");
        assert!(pictures.is_empty(), "{name} left a picture behind");
    }
}

#[test]
fn describes_the_video_as_mpeg_2_with_its_sequence_header() {
    let source = read_fixture("ibbp.m2v");
    let unit = mpeg2_passthrough_unit(&source, false).expect("passthrough unit");
    let mp4 = mpeg2_to_fmp4(&source, &unit).expect("mp4 packaging");

    assert_eq!(
        mp4.mime_codec, "video/mp4; codecs=\"mp4v.61\"",
        "MPEG-2 Main Profile carried by MPEG-4 systems (RFC 6381)"
    );
    assert_eq!(&mp4.init_segment[4..8], b"ftyp");
    assert!(
        mp4.init_segment.windows(4).any(|w| w == b"mp4v"),
        "the sample entry is an MPEG-4 visual one"
    );
    assert!(
        mp4.init_segment.windows(4).any(|w| w == b"esds"),
        "which carries its decoder configuration in an esds"
    );
    assert!(
        !mp4.init_segment.windows(4).any(|w| w == b"avcC"),
        "and nothing about H.264"
    );
    // The decoder specific info is the sequence header the unit opens with.
    let sequence_header = &source[..unit.sequence_header_len];
    assert!(
        mp4.init_segment
            .windows(sequence_header.len())
            .any(|w| w == sequence_header),
        "the esds does not hold the sequence header"
    );
    assert_eq!(mp4.sample_count, unit.samples.len());
}

// ---------------------------------------------------------------- a session

/// The fixture, repeated, as a transport stream: one group of pictures each.
fn video_only_stream(copies: usize) -> Vec<u8> {
    wrap_mpeg2_es_in_ts(&read_fixture("ibbp.m2v").repeat(copies), Some(90_000))
}

#[test]
fn a_passthrough_session_says_it_carries_mpeg_2() {
    let fragments = run_session(&video_only_stream(3), passthrough_options());
    let Some(Fragment::Init { data, mime_codec }) = fragments.first() else {
        panic!("the init segment comes first");
    };
    assert_eq!(mime_codec, "video/mp4; codecs=\"mp4v.61\"");
    assert!(data.windows(4).any(|w| w == b"mp4v"));
    assert_eq!(
        fragments
            .iter()
            .filter(|f| matches!(f, Fragment::Init { .. }))
            .count(),
        1,
        "MSE needs the init segment exactly once, and every unit could give one"
    );
}

#[test]
fn a_session_carries_the_source_pictures_end_to_end() {
    let stream = video_only_stream(3);
    let fragments = run_session(&stream, passthrough_options());
    let carried = media_bytes(&fragments);

    let pictures = parse_elementary_stream(&carried).expect("the samples parse as MPEG-2");
    let samples: usize = fragments
        .iter()
        .map(|fragment| match fragment {
            Fragment::Media { video_samples, .. } => *video_samples,
            _ => 0,
        })
        .sum();
    assert_eq!(
        pictures.len(),
        samples,
        "one coded picture per sample the fragments claim"
    );
    // Three copies of a group of pictures, carried whole.
    let one = read_fixture("ibbp.m2v");
    let expected = parse_elementary_stream(&one).expect("fixture parses").len();
    assert_eq!(pictures.len(), expected * 3);
}

#[test]
fn both_paths_place_the_same_pictures_on_the_same_timeline() {
    // The invariant the two paths share: they accept and drop exactly the same
    // source pictures, and put what they keep at the same times. A fragment
    // that disagreed would drift against the audio track beside it.
    let stream = video_only_stream(26);
    let transcoded = run_session(&stream, TranscodeOptions::default());
    let carried = run_session(&stream, passthrough_options());
    let transcoded = media_only(&transcoded);
    let carried = media_only(&carried);
    assert_eq!(transcoded.len(), carried.len(), "fragment count");

    let mut opening_clones = 0i64;
    for (index, (left, right)) in transcoded.iter().zip(carried.iter()).enumerate() {
        let (
            Fragment::Media {
                start: transcoded_start,
                random_access: transcoded_restart,
                video_samples: transcoded_samples,
                interlacing: transcoded_scan,
                ..
            },
            Fragment::Media {
                start: carried_start,
                random_access: carried_restart,
                video_samples: carried_samples,
                interlacing: carried_scan,
                ..
            },
        ) = (left, right)
        else {
            unreachable!()
        };
        // A closed group of pictures leaves the transcoder's IDR clone no
        // display slot to fill, and a sample of no duration is not something
        // to hand a parser, so it takes one tick. Passthrough adds no sample
        // and so takes none. That is the whole of the difference between the
        // two timelines, and only the opening fragment has an IDR in it: a
        // single 90 kHz tick, or eleven microseconds over the whole stream.
        let ticks = |seconds: &f64| (seconds * 90_000.0).round() as i64;
        let drift = ticks(transcoded_start) - ticks(carried_start);
        assert!(
            (0..=opening_clones).contains(&drift),
            "fragment {index} starts {drift} ticks from the transcoded one"
        );
        assert_eq!(
            transcoded_restart, carried_restart,
            "fragment {index} restart point"
        );
        assert_eq!(transcoded_scan, carried_scan, "fragment {index} scan");
        // The fragment that opens the presentation is the one the transcoder
        // adds a copy of its IDR to, to hang the flat prediction on.
        // Passthrough needs no such thing, so it holds one sample fewer and
        // shows its first picture for that much longer instead. A periodic
        // recovery point adds nothing on either path.
        let clone = usize::from(index == 0);
        opening_clones += clone as i64;
        assert_eq!(
            *transcoded_samples,
            carried_samples + clone,
            "fragment {index} sample count"
        );
    }
}

#[test]
fn a_restart_point_opens_with_a_sequence_header() {
    // A player evicting what it has shown cuts back to a restart point, so the
    // sample there has to be one a decoder can be handed cold.
    let fragments = run_session(&video_only_stream(26), passthrough_options());
    let mut restarts = 0;
    for fragment in &fragments {
        let Fragment::Media {
            data,
            random_access,
            ..
        } = fragment
        else {
            continue;
        };
        if !random_access {
            continue;
        }
        restarts += 1;
        assert_eq!(
            &mdat_payload(data)[..4],
            &[0, 0, 1, 0xb3],
            "a restart fragment opens with a sequence header"
        );
    }
    assert_eq!(restarts, 2, "the opening fragment, then every 24th");
}

#[test]
fn a_passthrough_session_muxes_the_aac_track_beside_it() {
    // The audio path is the same on both, but the fragment is put together by
    // different code, so the two trafs still have to arrive.
    let stream = support::mux_transport_stream(
        &[
            (support::VIDEO_PID, support::STREAM_TYPE_MPEG2_VIDEO),
            (support::AUDIO_PID, support::STREAM_TYPE_AAC_ADTS),
        ],
        &[
            support::PesUnit {
                pid: support::VIDEO_PID,
                stream_id: 0xe0,
                pts: Some(90_000),
                payload: &read_fixture("ibbp.m2v").repeat(3),
            },
            support::PesUnit {
                pid: support::AUDIO_PID,
                stream_id: 0xc0,
                pts: Some(90_000),
                payload: &support::adts_stream(64, 4, 2),
            },
        ],
    );
    let fragments = run_session(&stream, passthrough_options());
    let Some(Fragment::Init { mime_codec, .. }) = fragments.first() else {
        panic!("the init segment comes first");
    };
    assert_eq!(mime_codec, "video/mp4; codecs=\"mp4v.61,mp4a.40.2\"");
    let audio: usize = fragments
        .iter()
        .map(|fragment| match fragment {
            Fragment::Media { audio_samples, .. } => *audio_samples,
            _ => 0,
        })
        .sum();
    assert!(audio > 0, "the audio track reached the fragments");
}
