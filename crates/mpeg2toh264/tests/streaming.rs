//! The streaming path: GOP splitting, ADTS framing, and the Session that puts
//! them together with the transcoder and the muxer.

mod support;

use mpeg2toh264::container::adts::AdtsStream;
use mpeg2toh264::mpeg2::gop_stream::Mpeg2GopStream;
use mpeg2toh264::mpeg2::headers::parse_elementary_stream;
use mpeg2toh264::{Fragment, Session, TranscodeOptions};
use support::{
    adts_frame, adts_frame_with_payload, adts_stream, mux_programs, mux_transport_stream,
    read_fixture, wrap_mpeg2_es_in_ts, PesUnit, AUDIO_PID, STREAM_TYPE_AAC_ADTS,
    STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID,
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
fn cuts_a_unit_where_the_description_changes_without_a_group_behind_it() {
    // A unit carries one description, and normally the change comes with a
    // group header the splitter would cut on anyway. This is the stream that
    // puts the new sequence header somewhere else: the cut has to follow it
    // there, or the unit's later pictures are coded at a size the parameter
    // sets in front of them do not describe.
    let one = read_fixture("ibbp.m2v");
    let other = read_fixture("hd1080i.m2v");
    let head = &other[..first_gop_offset(&other)];
    // The second picture of the first group, which is inside it and behind no
    // group header of its own.
    let at = (first_gop_offset(&one)..one.len() - 4)
        .filter(|&i| one[i] == 0 && one[i + 1] == 0 && one[i + 2] == 1 && one[i + 3] == 0)
        .nth(1)
        .expect("the group has a second picture");

    let mut stream = one[..at].to_vec();
    stream.extend_from_slice(head);
    stream.extend_from_slice(&one[at..]);
    // Something after it to cut the rest on.
    stream.extend_from_slice(&one);

    let mut splitter = Mpeg2GopStream::new();
    let mut units = splitter.push(&stream, None);
    units.extend(splitter.finish());

    assert_eq!(
        units[0].data.len(),
        at,
        "the first unit ends where the description changes"
    );
    for (index, unit) in units.iter().enumerate() {
        let sizes: Vec<(u32, u32)> = parse_elementary_stream(&unit.data)
            .expect("unit parses")
            .iter()
            .map(|picture| {
                (
                    picture.sequence.horizontal_size,
                    picture.sequence.vertical_size,
                )
            })
            .collect();
        assert!(
            sizes.windows(2).all(|pair| pair[0] == pair[1]),
            "unit {index} holds one frame size, not {sizes:?}"
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

/// What a hole in the sound is filled with. Every channel the configuration
/// names carries a long window with no scalefactor bands, which is no spectral
/// data at all: the shortest access unit a decoder will accept for that
/// configuration, and digital silence when it decodes it.
#[test]
fn builds_silence_a_decoder_can_read_for_each_configuration() {
    use mpeg2toh264::container::adts::silent_frame;

    for channels in [2u8, 6] {
        let config = AdtsStream::new()
            .push(&adts_frame(3, channels, 16))
            .expect("a frame of this configuration")[0]
            .config
            .clone();
        let silence = silent_frame(&config).expect("a layout with a name");
        assert_eq!(silence.config, config);

        // Read back the way the stream's own frames are, so that what is
        // handed on is something this walker calls whole.
        let mut framed = adts_frame(3, channels, silence.data.len());
        framed[7..].copy_from_slice(&silence.data);
        let read = AdtsStream::new().push(&framed).expect("silence decodes");
        assert_eq!(read.len(), 1, "{channels} channels");
        assert_eq!(read[0].data, silence.data);
        assert_eq!(read[0].config.channel_count, channels);
    }
}

/// A programme in 5.1 followed by an announcement in stereo is one stream that
/// changes what it is, not a damaged one. The header says so, and the elements
/// change with it, so the run of frames the walker was reading ends there.
#[test]
fn reads_past_a_change_of_configuration() {
    let mut stream = adts_stream(2, 3, 2);
    stream.extend_from_slice(&adts_frame_with_payload(3, 6, &five_point_one_payload(0)));
    stream.extend_from_slice(&adts_frame_with_payload(3, 6, &five_point_one_payload(0)));

    let mut adts = AdtsStream::new();
    let mut frames = adts.push(&stream).expect("both configurations decode");
    frames.extend(adts.finish().expect("nothing is left over"));

    assert_eq!(frames.len(), 4, "no frame is dropped at the change");
    assert_eq!(frames[0].config.channel_count, 2);
    assert_eq!(frames[0].config.audio_specific_config, [0x11, 0x90]);
    assert_eq!(frames[3].config.channel_count, 6);
    assert_eq!(
        frames[3].config.audio_specific_config,
        [0x11, 0xb0],
        "and each frame carries the configuration it was coded under"
    );
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

/// Both tracks, with the sound changing configuration part way through, which
/// is what a broadcast does between a programme in 5.1 and the announcement in
/// stereo after it.
fn audio_change_stream(copies: usize, before: usize, after: usize) -> Vec<u8> {
    let video = repeat_fixture("ibbp.m2v", copies);
    let mut audio = adts_stream(before, 3, 2);
    for _ in 0..after {
        audio.extend_from_slice(&adts_frame_with_payload(3, 6, &five_point_one_payload(0)));
    }
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

/// Both tracks with the timestamps the source would really carry: one PES per
/// group of pictures, and the sound running alongside it access unit by access
/// unit. `av_stream` times its PES by where the bytes fell rather than by where
/// the pictures play, which is enough for pairing the two tracks but says
/// nothing about a hole -- and a hole is a hole in the timestamps.
fn timed_av_stream(copies: usize) -> Vec<u8> {
    let one = read_fixture("ibbp.m2v");
    let pictures = parse_elementary_stream(&one).expect("parses").len() as u64;
    // The fixture is 25 fps, and 48 kHz AAC access units are 1024 samples.
    const FRAME: u64 = 90_000 / 25;
    const AAC: u64 = 1024 * 90_000 / 48_000;
    let group = pictures * FRAME;
    let audio = adts_stream(1, 3, 2);

    let mut audio_frames = 0u64;
    let mut payloads: Vec<Vec<u8>> = Vec::new();
    let mut units: Vec<(u16, u8, usize, u64)> = Vec::new();
    for copy in 0..copies as u64 {
        payloads.push(one.clone());
        units.push((VIDEO_PID, 0xe0, payloads.len() - 1, 900_000 + copy * group));
        let through = (copy + 1) * group / AAC;
        let mut block = Vec::new();
        let first = audio_frames;
        while audio_frames < through {
            block.extend_from_slice(&audio);
            audio_frames += 1;
        }
        if !block.is_empty() {
            payloads.push(block);
            units.push((AUDIO_PID, 0xc0, payloads.len() - 1, 900_000 + first * AAC));
        }
    }
    let units: Vec<PesUnit<'_>> = units
        .iter()
        .map(|&(pid, stream_id, payload, pts)| PesUnit {
            pid,
            stream_id,
            payload: &payloads[payload],
            pts: Some(pts),
        })
        .collect();
    mux_transport_stream(
        &[
            (VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO),
            (AUDIO_PID, STREAM_TYPE_AAC_ADTS),
        ],
        &units,
    )
}

/// The same transport stream with a stretch of packets missing, which is what
/// a recording made through a failing signal has in it.
fn with_packets_dropped(stream: &[u8], from: usize, count: usize) -> Vec<u8> {
    stream
        .chunks(188)
        .enumerate()
        .filter(|(index, _)| !(from..from + count).contains(index))
        .flat_map(|(_, packet)| packet.iter().copied())
        .collect()
}

fn run_session(stream: &[u8], chunk_size: usize) -> Vec<Fragment> {
    run_session_with_options(stream, chunk_size, TranscodeOptions::default())
}

fn run_session_with_options(
    stream: &[u8],
    chunk_size: usize,
    options: TranscodeOptions,
) -> Vec<Fragment> {
    let mut session = Session::new(options);
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

/// The coded width and height of the first video sample entry in an
/// initialization segment, read back out of the `moov` the muxer wrote.
fn sample_entry_size(init: &[u8], sample_entry_type: &[u8; 4]) -> (u16, u16) {
    // From the sample description box, since `avc1` is also a brand in `ftyp`.
    let stsd = init
        .windows(4)
        .position(|window| window == b"stsd")
        .expect("the init segment describes a track");
    let at = stsd
        + init[stsd..]
            .windows(4)
            .position(|window| window == sample_entry_type)
            .expect("the init segment describes a video track");
    // Past the four-character code: six reserved bytes, the data reference
    // index, sixteen more reserved, and then the coded size.
    let width = u16::from_be_bytes([init[at + 28], init[at + 29]]);
    let height = u16::from_be_bytes([init[at + 30], init[at + 31]]);
    (width, height)
}

/// Two programmes coded at different frame sizes, one after the other, which
/// is what a station switching between its services sends.
fn resolution_change_stream() -> Vec<u8> {
    let mut es = repeat_fixture("ibbp.m2v", 2);
    es.extend_from_slice(&read_fixture("hd1080i.m2v"));
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

#[test]
fn a_new_frame_size_is_described_again_and_restarts_the_decoder() {
    let fragments = run_session(&resolution_change_stream(), 256 * 1024);
    let (init, _) = split_fragments(&fragments);

    assert_eq!(init.len(), 2, "one description per frame size");
    let sizes: Vec<(u16, u16)> = init
        .iter()
        .map(|fragment| {
            let Fragment::Init { data, .. } = fragment else {
                unreachable!()
            };
            sample_entry_size(data, b"avc1")
        })
        .collect();
    assert_eq!(sizes, vec![(352, 288), (1440, 1080)]);

    // The second description reaches the SourceBuffer before the media it
    // describes, and that media opens at an IDR: H.264 activates a new
    // sequence parameter set nowhere else.
    let second = fragments
        .iter()
        .rposition(|fragment| matches!(fragment, Fragment::Init { .. }))
        .expect("the second init segment");
    assert!(
        matches!(
            fragments.get(second + 1),
            Some(Fragment::Media {
                random_access: true,
                ..
            })
        ),
        "the fragment after a new description restarts the decoder"
    );
    let restarts = fragments
        .iter()
        .filter(|fragment| {
            matches!(
                fragment,
                Fragment::Media {
                    random_access: true,
                    ..
                }
            )
        })
        .count();
    assert_eq!(restarts, 2, "the stream opening, and the change");

    // Everything after the change is timed on the same timeline as everything
    // before it, so a player appends it where it stands.
    let (_, media) = split_fragments(&fragments);
    let mut previous = -1.0;
    for fragment in &media {
        let Fragment::Media {
            start,
            video_samples,
            ..
        } = fragment
        else {
            unreachable!()
        };
        assert!(*start > previous, "{start} follows {previous}");
        previous = *start;
        assert!(*video_samples > 0);
    }
    assert!(media.len() > 2, "both programmes produced fragments");
}

#[test]
fn a_new_frame_size_is_described_again_on_the_passthrough_path() {
    let options = TranscodeOptions {
        video: mpeg2toh264::VideoMode::Passthrough,
        ..TranscodeOptions::default()
    };
    let fragments = run_session_with_options(&resolution_change_stream(), 256 * 1024, options);
    let (init, media) = split_fragments(&fragments);

    let sizes: Vec<(u16, u16)> = init
        .iter()
        .map(|fragment| {
            let Fragment::Init { data, .. } = fragment else {
                unreachable!()
            };
            sample_entry_size(data, b"mp4v")
        })
        .collect();
    assert_eq!(sizes, vec![(352, 288), (1440, 1080)]);
    assert!(media.len() > 2, "both programmes produced fragments");
}

#[test]
fn emits_a_recovery_point_every_twenty_fourth_group() {
    // Recovery points are what let a player evict what it has already shown.
    let options = TranscodeOptions {
        recovery_interval: 24,
        ..TranscodeOptions::default()
    };
    let fragments = run_session_with_options(&video_only_stream(26), 256 * 1024, options);
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
        "the opening fragment, then a recovery point every 24th"
    );
}

#[test]
fn continuous_playback_does_not_restart_at_an_open_gop() {
    let pictures_per_gop = parse_elementary_stream(&read_fixture("ibbp.m2v"))
        .expect("fixture parses")
        .len();
    let fragments = run_session(&video_only_stream(26), 256 * 1024);
    let (_, media) = split_fragments(&fragments);

    assert_eq!(media.len(), 26);
    for (index, fragment) in media.iter().enumerate().skip(1) {
        let Fragment::Media {
            data,
            random_access,
            video_samples,
            ..
        } = fragment
        else {
            unreachable!()
        };
        assert_eq!(*random_access, index == 24);
        assert_eq!(
            data.windows(9)
                .any(|bytes| bytes == [0, 0, 0, 5, 6, 6, 1, 0xe4, 0x80]),
            index == 24,
            "GOP {index} recovery-point SEI"
        );
        if index == 24 {
            let trun = data
                .windows(4)
                .position(|bytes| bytes == b"trun")
                .expect("fragment has a video trun");
            let first_sample_flags = u32::from_be_bytes(
                data[trun + 24..trun + 28]
                    .try_into()
                    .expect("first sample flags"),
            );
            assert_eq!(
                first_sample_flags, 0x0200_0000,
                "the recovery picture is an ISO-BMFF sync sample"
            );
        }
        assert_eq!(
            *video_samples, pictures_per_gop,
            "GOP {index} lost an open-GOP picture"
        );
    }
}

#[test]
fn audio_pending_timeline_keeps_open_gop_pictures_at_a_recovery_point() {
    let pictures_per_gop = parse_elementary_stream(&read_fixture("ibbp.m2v"))
        .expect("fixture parses")
        .len();
    let fragments = run_session(&av_stream(26, 800), 256 * 1024);
    let (_, media) = split_fragments(&fragments);
    let recovery = media.get(24).expect("the recovery GOP is emitted");
    let Fragment::Media {
        random_access,
        video_samples,
        ..
    } = recovery
    else {
        unreachable!()
    };

    assert!(*random_access);
    assert_eq!(*video_samples, pictures_per_gop);
}

#[test]
fn recovery_points_preserve_distinct_leading_b_pictures() {
    let source = read_fixture("open_gop_leading_bb.m2v");
    let source_pictures = parse_elementary_stream(&source)
        .expect("fixture parses")
        .len();
    assert_eq!(source_pictures, 46);

    let options = TranscodeOptions {
        // Exercise every genuine open-GOP boundary in the fixture.
        recovery_interval: 1,
        ..TranscodeOptions::default()
    };
    let stream = wrap_mpeg2_es_in_ts(&source, Some(900_000));
    let fragments = run_session_with_options(&stream, 64 * 1024, options);
    let (_, media) = split_fragments(&fragments);
    let video_samples: usize = media
        .iter()
        .map(|fragment| match fragment {
            Fragment::Media { video_samples, .. } => *video_samples,
            _ => unreachable!(),
        })
        .sum();

    // The opening IDR has its reference clone; every source picture, including
    // each red/blue leading-B pair, must still have its own sample.
    assert_eq!(video_samples, source_pictures + 1);
    assert!(media.iter().skip(1).all(|fragment| matches!(
        fragment,
        Fragment::Media {
            random_access: true,
            ..
        }
    )));
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

/// How many channels the first audio sample entry of an initialization segment
/// declares.
fn sample_entry_channels(init: &[u8]) -> u16 {
    let at = init
        .windows(4)
        .position(|window| window == b"mp4a")
        .expect("the init segment describes an audio track");
    // Past the four-character code: six reserved bytes, the data reference
    // index, and eight more reserved, then the channel count.
    u16::from_be_bytes([init[at + 20], init[at + 21]])
}

/// Where the media of a run of fragments ends, and how much sound it carried.
fn presentation_end(fragments: &[Fragment]) -> (f64, usize) {
    let mut end = 0.0f64;
    let mut audio = 0;
    for fragment in fragments {
        if let Fragment::Media {
            start,
            audio_samples,
            ..
        } = fragment
        {
            end = end.max(*start);
            audio += audio_samples;
        }
    }
    (end, audio)
}

#[test]
fn a_hole_in_the_recording_does_not_move_what_follows_it() {
    // Pictures and access units are laid down one after another, so a stretch
    // the recording lost would close up and everything after it would play
    // early -- by a fraction of a second here, and permanently. The captions
    // carry the source's own timestamps and do not move with it, so they would
    // be that far out for the rest of the stream. The picture is held over the
    // hole and the sound filled with silence instead, which leaves the whole
    // presentation where the source put it.
    let stream = timed_av_stream(10);
    let packets = stream.len() / 188;
    let lossy = with_packets_dropped(&stream, packets / 2, packets / 20);

    let (intact_end, intact_audio) = presentation_end(&run_session(&stream, 64 * 1024));
    let (lossy_end, lossy_audio) = presentation_end(&run_session(&lossy, 64 * 1024));

    assert!(
        (intact_end - lossy_end).abs() < 0.05,
        "the last fragment sits at {lossy_end}s where the whole recording puts it at {intact_end}s"
    );
    assert!(
        intact_audio.abs_diff(lossy_audio) <= 1,
        "the sound is {lossy_audio} access units against {intact_audio}, so the hole was not filled"
    );
}

#[test]
fn a_join_between_recordings_is_left_where_the_source_has_it() {
    // Two takes minutes apart, which is what a recording resumed after a stop
    // holds. Holding a picture across that would make a viewer sit through the
    // whole of it, and closing it up would move everything after it -- so the
    // media keeps its positions and the gap stays in the buffered ranges, where
    // whoever is driving playback can step over it.
    const JUMP: u64 = 120 * 90_000;
    let one = read_fixture("ibbp.m2v");
    let group = parse_elementary_stream(&one).expect("parses").len() as u64 * (90_000 / 25);
    let mut units = Vec::new();
    for copy in 0..6u64 {
        units.push(PesUnit {
            pid: VIDEO_PID,
            stream_id: 0xe0,
            payload: &one,
            pts: Some(900_000 + copy * group + if copy >= 3 { JUMP } else { 0 }),
        });
    }
    let stream = mux_transport_stream(&[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)], &units);
    let starts = media_starts(&run_session(&stream, 64 * 1024));

    let steps: Vec<f64> = starts.windows(2).map(|pair| pair[1] - pair[0]).collect();
    let jumped = steps
        .iter()
        .filter(|&&step| step > 1.0)
        .copied()
        .collect::<Vec<f64>>();
    assert_eq!(jumped.len(), 1, "one step out of the ordinary in {steps:?}");
    assert!(
        (jumped[0] - (JUMP as f64 / 90_000.0) - group as f64 / 90_000.0).abs() < 0.1,
        "the join is {}s where the source puts it {}s apart",
        jumped[0],
        JUMP as f64 / 90_000.0
    );
}

#[test]
fn a_new_audio_configuration_is_described_again() {
    // A broadcast changes what its sound is between programmes, and the
    // initialization segment carries the audio configuration in its `esds` just
    // as it carries the picture in its `avcC`. Reading past the change used to
    // be refused outright, which ended the conversion there.
    let fragments = run_session(&audio_change_stream(8, 90, 90), 64 * 1024);
    let (init, media) = split_fragments(&fragments);

    assert_eq!(init.len(), 2, "one description per configuration");
    let channels: Vec<u16> = init
        .iter()
        .map(|fragment| {
            let Fragment::Init { data, .. } = fragment else {
                unreachable!()
            };
            sample_entry_channels(data)
        })
        .collect();
    assert_eq!(channels, vec![2, 6]);

    let second = fragments
        .iter()
        .rposition(|fragment| matches!(fragment, Fragment::Init { .. }))
        .expect("the second init segment");
    assert!(
        matches!(
            fragments.get(second + 1),
            Some(Fragment::Media {
                random_access: true,
                ..
            })
        ),
        "the fragment a new description opens is one a decoder can start on"
    );

    let audio_samples: usize = media
        .iter()
        .map(|fragment| match fragment {
            Fragment::Media { audio_samples, .. } => *audio_samples,
            _ => 0,
        })
        .sum();
    assert_eq!(
        audio_samples, 180,
        "every frame of both configurations comes out"
    );
}

#[test]
fn moving_the_sound_to_another_stream_does_not_splice_a_frame_across_the_change() {
    // The programme's own map moves its picture and its sound to other PIDs,
    // and the old sound stops in the middle of a frame -- which is where a
    // multiplexer cuts it. Carrying the half frame over joins it to the new
    // stream's bytes and makes one access unit belonging to neither: the
    // header still walks, so nothing downstream drops it, and a browser's
    // audio decoder refuses it outright and stops playing. The frame this
    // one claims is long enough to swallow most of what follows it, so
    // splicing it would show up in the count.
    let video_before = read_fixture("ibbp.m2v");
    let video_after = read_fixture("hd1080i.m2v");
    let audio_before = adts_stream(10, 3, 2);
    let cut_short = adts_frame(3, 2, 400);
    let audio_after = adts_stream(10, 3, 2);

    let before: &[(u16, u8)] = &[
        (0x200, STREAM_TYPE_MPEG2_VIDEO),
        (0x210, STREAM_TYPE_AAC_ADTS),
    ];
    let after: &[(u16, u8)] = &[
        (0x100, STREAM_TYPE_MPEG2_VIDEO),
        (0x110, STREAM_TYPE_AAC_ADTS),
    ];
    let mut stream = mux_programs(
        &[(101, 0x1f0, before)],
        &[
            PesUnit {
                pid: 0x200,
                stream_id: 0xe0,
                payload: &video_before,
                pts: Some(900_000),
            },
            PesUnit {
                pid: 0x210,
                stream_id: 0xc0,
                payload: &audio_before,
                pts: Some(900_000),
            },
            PesUnit {
                pid: 0x210,
                stream_id: 0xc0,
                payload: &cut_short[..20],
                pts: None,
            },
        ],
    );
    stream.extend_from_slice(&mux_programs(
        &[(101, 0x1f0, after)],
        &[
            PesUnit {
                pid: 0x100,
                stream_id: 0xe0,
                payload: &video_after,
                pts: Some(1_000_000),
            },
            PesUnit {
                pid: 0x110,
                stream_id: 0xc0,
                payload: &audio_after,
                pts: None,
            },
        ],
    ));

    let fragments = run_session(&stream, 64 * 1024);
    let (init, media) = split_fragments(&fragments);
    let audio_samples: usize = media
        .iter()
        .map(|fragment| match fragment {
            Fragment::Media { audio_samples, .. } => *audio_samples,
            _ => 0,
        })
        .sum();
    assert_eq!(
        audio_samples, 20,
        "every whole frame of both streams, and nothing made out of the join"
    );
    assert_eq!(
        init.len(),
        2,
        "the picture moved size along with the stream"
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
