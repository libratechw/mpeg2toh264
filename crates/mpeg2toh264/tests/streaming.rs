//! The streaming path: GOP splitting, ADTS framing, and the Session that puts
//! them together with the transcoder and the muxer.

mod support;

use mpeg2toh264::container::adts::AdtsStream;
use mpeg2toh264::mpeg2::gop_stream::Mpeg2GopStream;
use mpeg2toh264::mpeg2::headers::parse_elementary_stream;
use mpeg2toh264::{Fragment, Session};
use support::{
    adts_frame, adts_stream, mux_transport_stream, read_fixture, PesUnit, AUDIO_PID,
    STREAM_TYPE_AAC_ADTS, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID,
};

/// Offset of the first `00 00 01 B8` group header.
fn first_gop_offset(data: &[u8]) -> usize {
    (0..data.len() - 3)
        .find(|&i| data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 && data[i + 3] == 0xb8)
        .expect("the fixture opens a group of pictures")
}

fn repeat_fixture(name: &str, copies: usize) -> Vec<u8> {
    let one = read_fixture(name);
    one.repeat(copies)
}

// ------------------------------------------------------------- GOP splitting

#[test]
fn splits_a_stream_into_one_unit_per_group() {
    let one = read_fixture("ibbp.m2v");
    let stream = one.repeat(3);
    let pictures_per_gop = parse_elementary_stream(&one).expect("parses").len();

    let mut splitter = Mpeg2GopStream::new();
    let mut units = Vec::new();
    // A chunk size that lines up with nothing, so boundaries fall mid-header.
    for chunk in stream.chunks(97) {
        units.extend(splitter.push(chunk, None));
    }
    units.extend(splitter.finish());

    assert_eq!(units.len(), 3, "one unit per group of pictures");
    for unit in &units {
        assert_eq!(
            parse_elementary_stream(&unit.data)
                .expect("unit parses")
                .len(),
            pictures_per_gop,
            "a unit holds exactly its own group"
        );
    }
}

#[test]
fn re_injects_the_sequence_header_a_later_unit_lacks() {
    // A broadcast repeats the sequence header, but a stream that carries it
    // only once still has to yield independently decodable units.
    let one = read_fixture("ibbp.m2v");
    let mut stream = one.clone();
    stream.extend_from_slice(&one[first_gop_offset(&one)..]);

    let mut splitter = Mpeg2GopStream::new();
    let mut units = splitter.push(&stream, None);
    units.extend(splitter.finish());

    assert_eq!(units.len(), 2);
    for (index, unit) in units.iter().enumerate() {
        assert_eq!(
            &unit.data[..4],
            &[0, 0, 1, 0xb3],
            "unit {index} opens with a sequence header"
        );
        assert!(!parse_elementary_stream(&unit.data)
            .expect("parses")
            .is_empty());
    }
}

#[test]
fn gives_each_unit_the_timestamp_of_the_packet_that_opens_it() {
    // The splitter drops everything before the first sequence header and
    // re-injects headers ahead of later units, so the byte a unit starts at is
    // not the byte it was handed. Getting that mapping wrong anchors the whole
    // presentation on the wrong picture.
    let one = read_fixture("ibbp.m2v");
    let mut splitter = Mpeg2GopStream::new();
    let mut units = Vec::new();
    for (index, chunk) in [one.as_slice(), one.as_slice(), one.as_slice()]
        .into_iter()
        .enumerate()
    {
        units.extend(splitter.push(chunk, Some(900_000 + index as u64 * 15_000)));
    }
    units.extend(splitter.finish());

    assert_eq!(
        units.iter().map(|unit| unit.pts).collect::<Vec<_>>(),
        vec![Some(900_000), Some(915_000), Some(930_000)],
    );
}

#[test]
fn holds_an_unfinished_group_back() {
    let one = read_fixture("ibbp.m2v");
    let mut splitter = Mpeg2GopStream::new();
    // One whole group is not enough: the splitter cannot know it has ended
    // until the next one starts.
    assert!(splitter.push(&one, None).is_empty());
    assert_eq!(splitter.finish().len(), 1, "and it comes out at the end");
}

// --------------------------------------------------------------- ADTS framing

#[test]
fn strips_adts_headers_without_touching_the_payload() {
    let expected: Vec<Vec<u8>> = (0..4)
        .map(|i| {
            let frame = adts_frame(3, 2, 32 + i);
            frame[7..].to_vec()
        })
        .collect();
    let stream: Vec<u8> = (0..4).flat_map(|i| adts_frame(3, 2, 32 + i)).collect();

    let mut adts = AdtsStream::new();
    let mut frames = adts.push(&stream).expect("frames decode");
    frames.extend(adts.finish().expect("nothing is left over"));

    assert_eq!(frames.len(), 4);
    for (frame, payload) in frames.iter().zip(&expected) {
        assert_eq!(&frame.data, payload);
    }
}

#[test]
fn reassembles_frames_split_across_chunks() {
    let stream = adts_stream(8, 3, 2);
    let mut adts = AdtsStream::new();
    let mut frames = Vec::new();
    for chunk in stream.chunks(7) {
        frames.extend(adts.push(chunk).expect("frames decode"));
    }
    frames.extend(adts.finish().expect("nothing is left over"));
    assert_eq!(frames.len(), 8);
}

#[test]
fn derives_the_audio_specific_config_from_the_header() {
    // 48 kHz stereo: object type 2, frequency index 3, channel configuration 2.
    let mut adts = AdtsStream::new();
    let frames = adts.push(&adts_frame(3, 2, 16)).expect("frame decodes");
    let config = &frames[0].config;
    assert_eq!(config.audio_object_type, 2);
    assert_eq!(config.sample_rate, 48_000);
    assert_eq!(config.channel_count, 2);
    assert_eq!(config.audio_specific_config, [0x11, 0x90]);
}

#[test]
fn rejects_audio_that_is_not_aac_lc() {
    // The audio is carried through without being decoded, so anything but the
    // profile the muxer will claim in its esds has to be refused up front.
    let mut frame = adts_frame(3, 2, 16);
    frame[2] &= 0x3f; // profile 0, i.e. AAC Main
    let error = AdtsStream::new().push(&frame).expect_err("must fail");
    assert!(error.to_string().contains("audio object type 1"), "{error}");
}

#[test]
fn drops_a_truncated_final_frame() {
    // A recording that stops mid-frame ends with part of an access unit. There
    // is nothing to hand a decoder there, and the frames before it are still
    // good, so the remainder is dropped rather than failing the stream.
    let stream = adts_stream(2, 3, 2);
    let mut adts = AdtsStream::new();
    let frames = adts
        .push(&stream[..stream.len() - 4])
        .expect("frames decode");
    assert_eq!(frames.len(), 1, "the frame that did arrive whole");
    assert!(adts
        .finish()
        .expect("the partial frame is dropped")
        .is_empty());
}

// ------------------------------------------------------------------- Session

fn video_only_stream(copies: usize) -> Vec<u8> {
    let es = repeat_fixture("ibbp.m2v", copies);
    let units: Vec<PesUnit<'_>> = es
        .chunks(20_000)
        .enumerate()
        .map(|(index, payload)| PesUnit {
            pid: VIDEO_PID,
            stream_id: 0xe0,
            payload,
            pts: Some(900_000 + index as u64 * 3_000),
        })
        .collect();
    mux_transport_stream(&[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)], &units)
}

/// A stream with both tracks, interleaved the way a broadcast would send them,
/// and with the audio starting slightly later than the video.
fn av_stream(copies: usize, audio_frames: usize) -> Vec<u8> {
    let video = repeat_fixture("ibbp.m2v", copies);
    let audio = adts_stream(audio_frames, 3, 2);
    let video_chunks: Vec<&[u8]> = video.chunks(20_000).collect();
    let audio_chunks: Vec<&[u8]> = audio.chunks(400).collect();

    let mut units: Vec<PesUnit<'_>> = Vec::new();
    for index in 0..video_chunks.len().max(audio_chunks.len()) {
        if let Some(payload) = video_chunks.get(index) {
            units.push(PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                payload,
                pts: Some(900_000 + index as u64 * 3_000),
            });
        }
        if let Some(payload) = audio_chunks.get(index) {
            units.push(PesUnit {
                pid: AUDIO_PID,
                stream_id: 0xc0,
                payload,
                pts: Some(903_600 + index as u64 * 3_000),
            });
        }
    }
    mux_transport_stream(
        &[
            (VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO),
            (AUDIO_PID, STREAM_TYPE_AAC_ADTS),
        ],
        &units,
    )
}

fn run_session(stream: &[u8], chunk_size: usize) -> Vec<Fragment> {
    let mut session = Session::default();
    let mut fragments = Vec::new();
    for chunk in stream.chunks(chunk_size) {
        fragments.extend(session.push(chunk).expect("push succeeds"));
    }
    fragments.extend(session.finish().expect("finish succeeds"));
    fragments
}

fn split_fragments(fragments: &[Fragment]) -> (Vec<&Fragment>, Vec<&Fragment>) {
    fragments
        .iter()
        .partition(|f| matches!(f, Fragment::Init { .. }))
}

#[test]
fn emits_one_initialization_segment_then_media() {
    let fragments = run_session(&video_only_stream(3), 64 * 1024);
    let (init, media) = split_fragments(&fragments);

    assert_eq!(init.len(), 1, "MSE needs the init segment exactly once");
    let Fragment::Init { data, mime_codec } = init[0] else {
        unreachable!()
    };
    assert_eq!(&data[4..8], b"ftyp");
    assert!(data.windows(4).any(|w| w == b"moov"));
    assert!(
        mime_codec.starts_with("video/mp4; codecs=\"avc1."),
        "{mime_codec}"
    );
    assert!(!mime_codec.contains("mp4a"), "no audio track was declared");

    assert_eq!(media.len(), 3, "one fragment per group of pictures");
    assert!(
        matches!(fragments[0], Fragment::Init { .. }),
        "the init segment comes first"
    );
    for fragment in &media {
        let Fragment::Media { data, .. } = fragment else {
            unreachable!()
        };
        assert_eq!(&data[4..8], b"moof");
        assert!(data.windows(4).any(|w| w == b"mdat"));
    }
}

#[test]
fn fragments_advance_along_one_timeline() {
    let fragments = run_session(&video_only_stream(4), 64 * 1024);
    let (_, media) = split_fragments(&fragments);

    let mut previous = -1.0f64;
    for (index, fragment) in media.iter().enumerate() {
        let Fragment::Media {
            start,
            random_access,
            video_samples,
            ..
        } = fragment
        else {
            unreachable!()
        };
        assert!(
            *start > previous,
            "fragment {index} starts at {start}, after {previous}"
        );
        previous = *start;
        assert!(*video_samples > 0);
        assert_eq!(
            *random_access,
            index == 0,
            "only the opening fragment restarts the decoder, this far in"
        );
    }
}

#[test]
fn restarts_the_decoder_every_twenty_fourth_group() {
    // Restart points are what let a player evict what it has already shown.
    let fragments = run_session(&video_only_stream(26), 256 * 1024);
    let (_, media) = split_fragments(&fragments);
    let restarts: Vec<usize> = media
        .iter()
        .enumerate()
        .filter(|(_, f)| {
            matches!(
                f,
                Fragment::Media {
                    random_access: true,
                    ..
                }
            )
        })
        .map(|(index, _)| index)
        .collect();
    assert_eq!(
        restarts,
        vec![0, 24],
        "the opening fragment, then every 24th"
    );
}

#[test]
fn the_result_does_not_depend_on_how_the_input_is_chunked() {
    let stream = video_only_stream(3);
    let coarse = run_session(&stream, 1 << 20);
    let fine = run_session(&stream, 1000);

    assert_eq!(coarse.len(), fine.len());
    for (a, b) in coarse.iter().zip(&fine) {
        match (a, b) {
            (
                Fragment::Init {
                    data: a,
                    mime_codec: ma,
                },
                Fragment::Init {
                    data: b,
                    mime_codec: mb,
                },
            ) => {
                assert_eq!(a, b);
                assert_eq!(ma, mb);
            }
            (
                Fragment::Media {
                    data: a, start: sa, ..
                },
                Fragment::Media {
                    data: b, start: sb, ..
                },
            ) => {
                assert_eq!(a, b);
                assert_eq!(sa, sb);
            }
            _ => panic!("fragment kinds diverged"),
        }
    }
}

#[test]
fn carries_aac_audio_through_untouched() {
    let audio_frames = 300;
    let fragments = run_session(&av_stream(3, audio_frames), 64 * 1024);
    let (init, media) = split_fragments(&fragments);

    let Fragment::Init { mime_codec, data } = init[0] else {
        unreachable!()
    };
    assert!(mime_codec.contains("avc1."), "{mime_codec}");
    assert!(mime_codec.contains("mp4a.40.2"), "{mime_codec}");
    assert!(
        data.windows(4).any(|w| w == b"esds"),
        "the audio configuration travels in an esds box"
    );
    assert_eq!(
        data.windows(4).filter(|w| *w == b"trak").count(),
        2,
        "one track each for video and audio"
    );

    let total_audio: usize = media
        .iter()
        .map(|f| match f {
            Fragment::Media { audio_samples, .. } => *audio_samples,
            _ => 0,
        })
        .sum();
    assert_eq!(
        total_audio, audio_frames,
        "every access unit fed in comes out again"
    );
}

#[test]
fn spreads_audio_across_the_fragments_it_belongs_to() {
    let fragments = run_session(&av_stream(4, 400), 64 * 1024);
    let (_, media) = split_fragments(&fragments);
    let per_fragment: Vec<usize> = media
        .iter()
        .map(|f| match f {
            Fragment::Media { audio_samples, .. } => *audio_samples,
            _ => 0,
        })
        .collect();
    assert!(
        per_fragment.iter().filter(|&&n| n > 0).count() >= 2,
        "audio is not all dumped into one fragment: {per_fragment:?}"
    );
    // Every fragment but the last carries roughly a group's worth of audio.
    for (index, &count) in per_fragment.iter().enumerate().take(per_fragment.len() - 1) {
        assert!(count > 0, "fragment {index} has no audio at all");
    }
}

#[test]
fn a_stream_that_is_not_a_transport_stream_is_refused() {
    let mut session = Session::default();
    session
        .push(&[0u8; 512])
        .expect("nothing decodes, but nothing fails yet");
    let error = session.finish().expect_err("must fail");
    assert!(error.to_string().contains("not a 188-byte"), "{error}");
}
