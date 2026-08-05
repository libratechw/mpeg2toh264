//! The streaming path: GOP splitting, ADTS framing, and the Session that puts
//! them together with the transcoder and the muxer.

mod support;

use mpeg2toh264::container::adts::AdtsStream;
use mpeg2toh264::mpeg2::gop_stream::Mpeg2GopStream;
use mpeg2toh264::mpeg2::headers::parse_elementary_stream;
use mpeg2toh264::{Fragment, Session, TranscodeOptions};
use support::{
    adts_frame, adts_frame_with_payload, adts_stream, mux_transport_stream, read_fixture, PesUnit,
    AUDIO_PID, STREAM_TYPE_AAC_ADTS, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID,
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

fn packed_bits(bits: &str) -> Vec<u8> {
    let mut out = vec![0; bits.len().div_ceil(8)];
    for (at, value) in bits.bytes().enumerate() {
        if value == b'1' {
            out[at / 8] |= 1 << (7 - at % 8);
        }
    }
    out
}

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

/// A broadcast mono or dual-mono service sends neither a channel
/// configuration in the header nor a program_config_element to carry one: what
/// the service is lives in the PMT. A stream opened part way through, as one
/// resumed at a seek is, has only the element to go on.
#[test]
fn takes_a_single_channel_element_with_no_channel_configuration() {
    // The empty SCE of the mono case, with the header saying nothing.
    let frame = adts_frame_with_payload(3, 0, &[0, 0, 0, 7]);
    let frames = AdtsStream::new().push(&frame).expect("frame decodes");
    let config = &frames[0].config;
    // Every single-element service comes out as a stereo pair, so the track
    // keeps one configuration however the broadcast switches about.
    assert_eq!(config.channel_count, 2);
    assert_eq!(config.audio_specific_config, [0x11, 0x90]);
    assert_eq!(frames[0].data[0] >> 5, 1, "SCE became a CPE");
}

#[test]
fn takes_a_channel_pair_with_no_channel_configuration() {
    let mut frame = adts_frame(3, 0, 16);
    frame[7] = 0x20; // id_syn_ele=CPE
    let frames = AdtsStream::new().push(&frame).expect("frame decodes");
    assert_eq!(frames[0].config.channel_count, 2);
    assert_eq!(frames[0].config.audio_specific_config, [0x11, 0x90]);
}

/// Packet loss leaves a recording with the odd unreadable access unit, and one
/// handed to a decoder is not a frame it skips -- it is an error that stops the
/// stream. A frame whose elements cannot be walked, or which names elements the
/// stream has not been carrying, is dropped the way a damaged picture is.
#[test]
fn drops_a_frame_packet_loss_made_unreadable() {
    // Two 5.1 frames the walker can read, then one whose second element is not
    // there at all, then another good one.
    let good = adts_frame_with_payload(3, 6, &five_point_one_payload(0));
    let damaged = adts_frame_with_payload(3, 6, &packed_bits("000 0000 111"));
    let mut stream = good.clone();
    stream.extend_from_slice(&good);
    stream.extend_from_slice(&damaged);
    stream.extend_from_slice(&good);

    let mut adts = AdtsStream::new();
    let mut frames = adts.push(&stream).expect("the readable frames decode");
    frames.extend(adts.finish().expect("nothing is left over"));
    assert_eq!(frames.len(), 3, "the damaged frame is not passed on");
}

/// A frame that walks but names an element the stream has not carried is
/// damage as well: a decoder has room only for the elements its configuration
/// named, and refuses the frame that mentions another.
#[test]
fn drops_a_frame_whose_elements_are_not_the_streams() {
    let good = adts_frame_with_payload(3, 6, &five_point_one_payload(0));
    let renamed = adts_frame_with_payload(3, 6, &five_point_one_payload(12));
    let mut stream = good.clone();
    stream.extend_from_slice(&renamed);
    stream.extend_from_slice(&good);

    let mut adts = AdtsStream::new();
    let mut frames = adts.push(&stream).expect("decodes");
    frames.extend(adts.finish().expect("nothing is left over"));
    assert_eq!(frames.len(), 2, "the frame with a stray element tag goes");
}

/// An empty 5.1 raw_data_block: a centre SCE, a front pair, a back pair and an
/// LFE, every one of them carrying no spectral data. `tag` names the first
/// element, so that a frame can be made to disagree with its neighbours.
fn five_point_one_payload(tag: u8) -> Vec<u8> {
    // global_gain, then an ics_info with a long window and max_sfb 0, then the
    // three absent-tool flags. Twenty-two zeroes, and no spectral data at all.
    let empty_ics = "0".repeat(22);
    let mut bits = String::new();
    bits.push_str("000"); // ID_SCE
    bits.push_str(&format!("{:04b}", tag));
    bits.push_str(&empty_ics);
    for pair in 0..2 {
        bits.push_str("001"); // ID_CPE
        bits.push_str(&format!("{:04b}", pair));
        bits.push('0'); // common_window: each channel carries its own ics_info
        bits.push_str(&empty_ics);
        bits.push_str(&empty_ics);
    }
    bits.push_str("011"); // ID_LFE
    bits.push_str("0000");
    bits.push_str(&empty_ics);
    bits.push_str("111"); // ID_END
    packed_bits(&bits.replace(' ', ""))
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
    let mut frame = adts_frame(3, 2, 16);
    frame[7] = 0x20; // id_syn_ele=CPE
    let frames = adts.push(&frame).expect("frame decodes");
    let config = &frames[0].config;
    assert_eq!(config.audio_object_type, 2);
    assert_eq!(config.sample_rate, 48_000);
    assert_eq!(config.channel_count, 2);
    assert_eq!(config.audio_specific_config, [0x11, 0x90]);
}

#[test]
fn maps_mono_sce_to_primary_audio_on_both_stereo_channels() {
    // max_sfb=0 gives a valid empty ICS: SCE/tag 0, global_gain, ics_info,
    // three absent-tool flags, END and byte alignment.
    let frame = adts_frame_with_payload(3, 1, &[0, 0, 0, 7]);
    let frames = AdtsStream::new().push(&frame).expect("mono frame decodes");
    let config = &frames[0].config;
    assert_eq!(config.channel_count, 2);
    assert_eq!(config.audio_specific_config, [0x11, 0x90]);
    assert_eq!(frames[0].data[0] >> 5, 1, "SCE became a CPE");
}

/// A frame the encoder padded to a byte, rewritten, must not end up padded
/// twice: a decoder that measures the block against the bytes it consumed
/// rejects a frame with a whole byte hanging off the end, which is what a mono
/// service sounded like on a Media Foundation decoder -- about half its frames
/// went missing.
#[test]
fn the_rewrite_ends_the_block_at_id_end() {
    // The empty SCE and ID_END of the mono case, then a byte of padding.
    let frame = adts_frame_with_payload(3, 1, &[0, 0, 0, 7, 0]);
    let frames = AdtsStream::new()
        .push(&frame)
        .expect("padded frame decodes");
    // ID_CPE, tag, common_window, two 22-bit channel streams and ID_END: 55
    // bits, which is seven bytes once aligned. Carrying the input's tail
    // across would make it eight.
    assert_eq!(frames[0].data.len(), 7);
}

/// A fill element's escape form spans `count + esc_count - 1` bytes, and
/// `count` is 15 to have reached it, so `esc_count` 0 is fourteen bytes.
/// Fourteen is the one length both forms can write, so an encoder that writes
/// it the long way is rare -- and reading it as fifteen walks the element a byte
/// past the end of the block it is in, which loses the frame and with it the
/// stream. A news recording ran forty seconds before hitting one.
#[test]
fn reads_a_fill_element_written_with_an_escape_count_of_zero() {
    // The empty SCE of the mono case, then a fill element written as count 15
    // with esc_count 0, its fourteen bytes of payload, ID_END and alignment.
    let mut payload = vec![0x00, 0x00, 0x00, 0x06, 0xf0];
    payload.extend_from_slice(&[0x00; 14]);
    payload.push(0x0e);
    let frame = adts_frame_with_payload(3, 1, &payload);
    let frames = AdtsStream::new()
        .push(&frame)
        .expect("the fill element is fourteen bytes, not fifteen");
    assert_eq!(frames[0].data[0] >> 5, 1, "SCE became a CPE");
    // ID_CPE, tag, common_window, two 22-bit channel streams, and the 130 bits
    // from the fill element to one past ID_END: 182 bits, or 23 bytes aligned.
    assert_eq!(
        frames[0].data.len(),
        23,
        "the fill element is carried across"
    );
}

#[test]
fn accepts_mono_to_dual_mono_changes_when_the_primary_sce_is_stable() {
    let mono = adts_frame_with_payload(3, 1, &[0, 0, 0, 7]);
    // Two empty SCEs (tags 0 and 1) followed by END.
    let dual = adts_frame_with_payload(3, 2, &[0, 0, 0, 0, 0x10, 0, 0, 0x38]);
    let mut adts = AdtsStream::new();
    let first = adts.push(&mono).expect("mono frame");
    let second = adts.push(&dual).expect("dual-mono frame");
    assert_eq!(first[0].config, second[0].config);
    assert_eq!(second[0].config.channel_count, 2);
    assert_eq!(second[0].data.len(), 7, "the secondary SCE is discarded");
    for bit in 0..22 {
        let left = (second[0].data[(8 + bit) / 8] >> (7 - ((8 + bit) & 7))) & 1;
        let right = (second[0].data[(30 + bit) / 8] >> (7 - ((30 + bit) & 7))) & 1;
        assert_eq!(left, right, "ICS bit {bit} is duplicated");
    }
}

#[test]
fn accepts_stereo_to_zero_config_dual_mono_changes() {
    let mut stereo = adts_frame(3, 2, 16);
    stereo[7] = 0x20; // ID_CPE
                      // Two empty SCEs while channel_configuration is zero, as ARIB dual mono
                      // signals itself after an ordinary stereo programme.
    let dual = adts_frame_with_payload(3, 0, &[0, 0, 0, 0, 0x10, 0, 0, 0x38]);
    let mut adts = AdtsStream::new();
    assert_eq!(adts.push(&stereo).expect("stereo frame").len(), 1);
    let frames = adts.push(&dual).expect("dual-mono frame");

    assert_eq!(
        frames.len(),
        1,
        "the configuration change is not packet damage"
    );
    assert_eq!(frames[0].config.channel_count, 2);
    assert_eq!(frames[0].data.len(), 7, "the primary SCE is duplicated");
}

#[test]
fn reads_an_in_band_pce_when_adts_channel_configuration_is_zero() {
    let payload = packed_bits(concat!(
        "101", // ID_PCE
        "0000",
        "01",
        "0011", // tag, AAC-LC, 48 kHz
        "0001",
        "0000",
        "0000",
        "00",
        "000",
        "0000", // element counts
        "0",
        "0",
        "0", // no mixdown metadata
        "0",
        "0000",                          // one front SCE, tag 0
        "000000",                        // byte alignment
        "00000000",                      // no PCE comment
        "00000000000000000000000000000", // empty SCE/tag 0 and ICS
        "111",                           // ID_END
    ));
    let frame = adts_frame_with_payload(3, 0, &payload);
    let frames = AdtsStream::new().push(&frame).expect("PCE frame decodes");
    assert_eq!(frames[0].config.channel_count, 2);
    assert_eq!(frames[0].config.audio_specific_config, [0x11, 0x90]);
    assert_eq!(frames[0].data[0] >> 5, 1, "the PCE/SCE became a CPE");
}

#[test]
fn preserves_an_implicit_five_point_one_configuration() {
    let frame = adts_frame(3, 6, 16);
    let expected = frame[7..].to_vec();
    let frames = AdtsStream::new().push(&frame).expect("5.1 frame decodes");
    assert_eq!(frames[0].config.channel_count, 6);
    assert_eq!(frames[0].config.audio_specific_config, [0x11, 0xb0]);
    assert_eq!(frames[0].data, expected, "5.1 payload passes through");
}

#[test]
fn moves_an_explicit_five_point_one_pce_into_the_asc() {
    let payload = packed_bits(concat!(
        "101", // ID_PCE
        "0000",
        "01",
        "0011", // tag, AAC-LC, 48 kHz
        "0010",
        "0000",
        "0001",
        "01",
        "000",
        "0000", // 2 front, 1 back, 1 LFE
        "0",
        "0",
        "0", // no mixdown metadata
        "0",
        "0000", // front centre SCE 0
        "1",
        "0000", // front left/right CPE 0
        "1",
        "0001",                          // back left/right CPE 1
        "0000",                          // LFE tag 0
        "00000000",                      // no PCE comment (already byte aligned)
        "00000000000000000000000000000", // first SCE; rest is opaque here
        "111",                           // ID_END
    ));
    let frame = adts_frame_with_payload(3, 0, &payload);
    let frames = AdtsStream::new()
        .push(&frame)
        .expect("PCE 5.1 frame decodes");
    assert_eq!(frames[0].config.channel_count, 6);
    assert_eq!(&frames[0].config.audio_specific_config[..2], &[0x11, 0x80]);
    assert!(frames[0].config.audio_specific_config.len() > 2);
    assert_eq!(
        frames[0].data, payload,
        "multichannel payload passes through"
    );
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
fn conceals_a_missing_aac_frame_instead_of_stalling_video() {
    let video = repeat_fixture("ibbp.m2v", 4);
    let audio = adts_stream(1, 3, 2);
    let mut units = vec![PesUnit {
        pid: VIDEO_PID,
        stream_id: 0xe0,
        payload: &video,
        pts: Some(900_000),
    }];
    for index in 0..120u64 {
        units.push(PesUnit {
            pid: AUDIO_PID,
            stream_id: 0xc0,
            payload: &audio,
            // One 48 kHz AAC access unit is absent halfway through.
            pts: Some(900_000 + index * 1_920 + u64::from(index >= 60) * 1_920),
        });
    }
    let stream = mux_transport_stream(
        &[
            (VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO),
            (AUDIO_PID, STREAM_TYPE_AAC_ADTS),
        ],
        &units,
    );
    let fragments = run_session(&stream, 64 * 1024);
    let (_, media) = split_fragments(&fragments);
    let audio_samples: usize = media
        .iter()
        .map(|fragment| match fragment {
            Fragment::Media { audio_samples, .. } => *audio_samples,
            _ => 0,
        })
        .sum();

    assert_eq!(audio_samples, 121, "the missing timeline slot is concealed");
    assert_eq!(media.len(), 4, "every video GOP is emitted");
}

/// The audio of a recording can run out before its video does, and a `trun`
/// describing no samples is not something to hand a parser: the track with
/// nothing in a fragment takes no `traf` in it.
#[test]
fn a_fragment_with_no_audio_leaves_the_audio_track_out_of_it() {
    let fragments = run_session(&av_stream(4, 20), 64 * 1024);
    let (_, media) = split_fragments(&fragments);
    let mut silent = 0;
    for fragment in &media {
        let Fragment::Media {
            data,
            audio_samples,
            ..
        } = fragment
        else {
            unreachable!()
        };
        let trafs = data.windows(4).filter(|w| *w == b"traf").count();
        if *audio_samples == 0 {
            silent += 1;
            assert_eq!(trafs, 1, "only the video track is in this fragment");
        } else {
            assert_eq!(trafs, 2, "both tracks are in this fragment");
        }
    }
    assert!(silent > 0, "the audio ran out before the video did");
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

// ------------------------------------------------------ resuming mid-stream

/// Ticks of one copy of the fixture: fifteen pictures at 25 Hz.
const GOP_TICKS: u64 = 15 * 3_600;

/// A stream a cut can be taken out of the middle of.
///
/// It differs from the ones above in the two ways a real broadcast does and
/// they do not: the program map is repeated rather than sent once, so a cut
/// still says what its PIDs are, and the timestamps advance with the pictures
/// rather than with the bytes, so a resumed session and a session that read the
/// whole file can be expected to agree.
fn seekable_stream(copies: usize, audio_per_copy: usize) -> Vec<u8> {
    let video = read_fixture("ibbp.m2v");
    let audio = adts_stream(audio_per_copy, 3, 2);
    let mut streams = vec![(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)];
    if audio_per_copy > 0 {
        streams.push((AUDIO_PID, STREAM_TYPE_AAC_ADTS));
    }
    let mut out = Vec::new();
    for copy in 0..copies as u64 {
        let mut units = vec![PesUnit {
            pid: VIDEO_PID,
            stream_id: 0xe0,
            payload: &video,
            pts: Some(900_000 + copy * GOP_TICKS),
        }];
        if audio_per_copy > 0 {
            units.push(PesUnit {
                pid: AUDIO_PID,
                stream_id: 0xc0,
                payload: &audio,
                // The audio starts a little after the video, as a broadcast's does.
                pts: Some(903_600 + copy * GOP_TICKS),
            });
        }
        // Each call opens with a PAT and a PMT, which is the repetition.
        out.extend_from_slice(&mux_transport_stream(&streams, &units));
    }
    out
}

/// Run a session over `stream`, and report the origin its timeline settled on.
fn run_anchored(stream: &[u8], origin: Option<u64>) -> (Vec<Fragment>, Option<u64>) {
    let mut session = Session::anchored(TranscodeOptions::default(), origin);
    let mut fragments = Vec::new();
    for chunk in stream.chunks(64 * 1024) {
        fragments.extend(session.push(chunk).expect("push succeeds"));
    }
    fragments.extend(session.finish().expect("finish succeeds"));
    (fragments, session.origin_ticks())
}

fn media_starts(fragments: &[Fragment]) -> Vec<f64> {
    fragments
        .iter()
        .filter_map(|f| match f {
            Fragment::Media { start, .. } => Some(*start),
            _ => None,
        })
        .collect()
}

/// Where in the byte stream to cut, on no boundary in particular.
fn midpoint(stream: &[u8]) -> usize {
    stream.len() / 2 + 37
}

#[test]
fn reports_the_origin_its_timeline_starts_from() {
    let (fragments, origin) = run_anchored(&seekable_stream(2, 0), None);
    let origin = origin.expect("the opening fragment fixes the origin");
    assert_eq!(
        origin, 900_000,
        "a video-only timeline starts where its video does"
    );
    assert_eq!(media_starts(&fragments)[0], 0.0);
}

#[test]
fn an_anchored_session_puts_a_cut_where_the_whole_file_puts_it() {
    let stream = seekable_stream(6, 0);
    let (whole, origin) = run_anchored(&stream, None);
    let origin = origin.expect("the opening fragment fixes the origin");
    let whole_starts = media_starts(&whole);

    let (cut, _) = run_anchored(&stream[midpoint(&stream)..], Some(origin));
    let cut_starts = media_starts(&cut);

    assert!(
        !cut_starts.is_empty(),
        "the cut yields fragments of its own"
    );
    let first = cut_starts[0];
    assert!(
        first > 1.0,
        "the cut lands where it was taken from, not at the start: {first}"
    );
    let matched = whole_starts
        .iter()
        .any(|&start| (start - first).abs() < 0.04);
    assert!(
        matched,
        "cut starts at {first}, which is no fragment of {whole_starts:?}"
    );

    // The control: without an origin the same bytes open at zero, which is
    // what a player appending them over a seek would place wrongly.
    let (adrift, _) = run_anchored(&stream[midpoint(&stream)..], None);
    assert_eq!(media_starts(&adrift)[0], 0.0);
}

#[test]
fn an_anchored_session_carries_both_tracks_over_a_cut() {
    let stream = seekable_stream(6, 40);
    let (whole, origin) = run_anchored(&stream, None);
    let origin = origin.expect("the opening fragment fixes the origin");
    let whole_starts = media_starts(&whole);

    let (cut, _) = run_anchored(&stream[midpoint(&stream)..], Some(origin));
    let starts = media_starts(&cut);
    assert!(!starts.is_empty(), "the cut yields fragments of its own");
    assert!(
        whole_starts.iter().any(|&s| (s - starts[0]).abs() < 0.04),
        "cut starts at {}, which is no fragment of {whole_starts:?}",
        starts[0]
    );
    let audio: usize = cut
        .iter()
        .map(|f| match f {
            Fragment::Media { audio_samples, .. } => *audio_samples,
            _ => 0,
        })
        .sum();
    assert!(
        audio > 0,
        "the audio track resumes too -- the count it measures from is the \
         audio's own start, not the file's"
    );
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
