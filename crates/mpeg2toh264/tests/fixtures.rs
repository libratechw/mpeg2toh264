//! End-to-end transcodes of the checked-in MPEG-2 fixtures.
//!
//! The hashes pin the exact bitstream. They are not a specification -- they are
//! a tripwire: any change that alters a single coefficient shows up here, and
//! whoever made the change has to say why it was intended.

mod support;

use mpeg2toh264::mpeg2::headers::{
    parse_elementary_stream, picture_sequence_description, pictures_interlacing,
    stream_sequence_description,
};
use mpeg2toh264::{
    h264_to_fmp4, mpeg2_video_timeline, transcode, IncrementalTranscoder, TranscodeOptions,
};
use support::{fnv1a, read_fixture, split_annex_b, FIXTURES};

/// fixture, converted pictures, output bytes, FNV-1a of the Annex B stream.
/// Last moved when a frame IDR began taking the long-term slot itself, leaving
/// the copy behind it short-term, and when every P and B slice began naming its
/// short-term reference list outright. Both only move the slice headers: each
/// fixture decodes to the same frames as before, checked frame by frame with
/// `ffmpeg -f framemd5`.
const GOLDEN: [(&str, usize, usize, u64); 6] = [
    ("altscan.m2v", 8, 224007, 0x4c98_4bed_dc31_53c5),
    ("escape.m2v", 6, 122600, 0x273e_747d_a781_32cf),
    ("hd1080i.m2v", 15, 2106380, 0xa903_55d8_0a1c_4d05),
    ("i_only.m2v", 3, 79513, 0x31f6_0c7f_fb6b_b97a),
    ("ibbp.m2v", 15, 164459, 0x183e_7cc0_f7ca_1a86),
    ("ip.m2v", 10, 132314, 0x7f35_4fc6_a64f_829c),
];

#[test]
fn transcodes_every_fixture_to_the_expected_bitstream() {
    let mut mismatches = Vec::new();
    for &(name, pictures, length, hash) in &GOLDEN {
        let source = read_fixture(name);
        let result = transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
        let actual = (
            name,
            result.pictures_converted,
            result.bitstream.len(),
            fnv1a(&result.bitstream),
        );
        if actual != (name, pictures, length, hash) {
            mismatches.push(format!(
                "    (\"{}\", {}, {}, 0x{:016x}),",
                actual.0, actual.1, actual.2, actual.3
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "transcoder output changed; if that was intended, update GOLDEN to:\n{}",
        mismatches.join("\n")
    );
}

#[test]
fn every_stream_opens_with_parameter_sets_and_an_idr() {
    for name in FIXTURES {
        let source = read_fixture(name);
        let result = transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
        let nals = split_annex_b(&result.bitstream);
        let types: Vec<u8> = nals.iter().map(|&(kind, _)| kind).collect();
        assert_eq!(
            &types[..3],
            &[7, 8, 5],
            "{name} does not open SPS, PPS, IDR"
        );
        assert_eq!(
            types.iter().filter(|&&kind| kind == 5).count(),
            1,
            "{name} has more than one IDR"
        );
        assert!(
            types[3..].iter().all(|&kind| kind == 1),
            "{name} has a non-slice NAL after the IDR"
        );
    }
}

#[test]
fn accounts_for_every_codeable_picture() {
    for name in FIXTURES {
        let source = read_fixture(name);
        let result = transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
        let codeable = parse_elementary_stream(&source)
            .expect("parses")
            .iter()
            .filter(|p| p.header.picture_coding_type.is_ipb())
            .count();
        assert_eq!(
            result.pictures_converted + result.pictures_skipped,
            codeable,
            "{name}: every I/P/B picture is either converted or counted as skipped"
        );
    }
}

#[test]
fn incremental_pushes_match_one_whole_transcode() {
    // Reference, frame number, POC and GOP state all have to survive the seam.
    let gop = read_fixture("ibbp.m2v");
    let mut combined = gop.clone();
    combined.extend_from_slice(&gop);
    let expected = transcode(&combined, TranscodeOptions::default()).expect("transcode succeeds");

    let mut session = IncrementalTranscoder::new(TranscodeOptions::default());
    let mut actual = session.push(&gop).expect("first push").bitstream;
    actual.extend_from_slice(&session.push(&gop).expect("second push").bitstream);

    assert_eq!(actual, expected.bitstream);
}

#[test]
fn reading_the_description_from_the_headers_agrees_with_the_parse() {
    // A unit is packaged before it is planned, so what the muxer is told about
    // a unit comes from the headers walk and what the transcoder codes comes
    // from the parse. The two answering differently is what would leave a
    // fragment claiming samples the H.264 stream has not got.
    for name in FIXTURES {
        let source = read_fixture(name);
        let pictures = parse_elementary_stream(&source).expect("fixture parses");
        assert_eq!(
            stream_sequence_description(&source),
            Some(picture_sequence_description(&pictures[0])),
            "{name}"
        );
    }
}

#[test]
fn a_unit_carrying_two_descriptions_codes_only_the_one_it_opens_with() {
    // A unit is described by the sequence header it opens with, and the group
    // splitter cuts where that changes. Handed the two in one piece anyway --
    // a whole elementary stream converted in one call, or the tail of a
    // recording that had no group header left to cut on -- the pictures coded
    // under the other description are dropped rather than coded against
    // parameter sets that do not describe them. The MP4 timeline has to drop
    // exactly the same ones, which packaging the result is what proves: it
    // counts the samples against the access units.
    let first = read_fixture("ibbp.m2v");
    let second = read_fixture("hd1080i.m2v");
    let mut combined = first.clone();
    combined.extend_from_slice(&second);

    let alone = transcode(&first, TranscodeOptions::default()).expect("one description");
    let result = transcode(&combined, TranscodeOptions::default()).expect("two descriptions");
    assert_eq!(
        result.bitstream, alone.bitstream,
        "the second description contributes nothing"
    );
    assert!(
        result.pictures_skipped > alone.pictures_skipped,
        "its pictures are skipped, not silently missing"
    );

    let timeline = mpeg2_video_timeline(&combined, false, &result.undecodable).expect("timeline");
    h264_to_fmp4(&result.bitstream, &timeline).expect("the timeline reserves the same samples");
}

#[test]
fn packages_each_fixture_as_a_fragmented_mp4() {
    for name in FIXTURES {
        let source = read_fixture(name);
        let result = transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
        let timeline = mpeg2_video_timeline(&source, false, &[]).expect("timeline");
        let mp4 = h264_to_fmp4(&result.bitstream, &timeline).expect("mp4 packaging");

        assert_eq!(
            &mp4.init_segment[4..8],
            b"ftyp",
            "{name} init is not an MP4"
        );
        assert!(
            mp4.init_segment.windows(4).any(|w| w == b"moov"),
            "{name} init has no moov"
        );
        assert_eq!(
            &mp4.media_segment[4..8],
            b"moof",
            "{name} media segment is not a fragment"
        );
        assert!(mp4.mime_codec.starts_with("video/mp4; codecs=\"avc1."));
        // The IDR plus its skipped clone means one more sample than pictures.
        assert_eq!(
            mp4.sample_count,
            timeline.presentation_indices.len() + 1,
            "{name} sample count"
        );
    }
}

/// fixture, interlaced, top field first. Checked against what ffprobe reports
/// for the same files: `tt` for hd1080i, `bb` for altscan, progressive for the
/// rest. A player has no other way to learn this -- the H.264 that comes out
/// is decoded into frames, and a frame of two moments looks like one of one --
/// so getting it wrong deinterlaces a progressive picture, or moves an
/// interlaced one half a field the wrong way.
const SCAN: [(&str, bool, bool); 6] = [
    ("altscan.m2v", true, false),
    ("escape.m2v", false, true),
    ("hd1080i.m2v", true, true),
    ("i_only.m2v", false, true),
    ("ibbp.m2v", false, true),
    ("ip.m2v", false, true),
];

#[test]
fn reads_the_field_order_of_every_fixture() {
    for &(name, interlaced, top_field_first) in &SCAN {
        let source = read_fixture(name);
        let pictures = parse_elementary_stream(&source).expect("parse");
        let interlacing = pictures_interlacing(&pictures);
        assert_eq!(interlacing.interlaced, interlaced, "{name} interlaced");
        if interlaced {
            assert_eq!(
                interlacing.top_field_first, top_field_first,
                "{name} top field first"
            );
        }
        // The timeline is where a session reads it from, so it has to agree.
        let timeline = mpeg2_video_timeline(&source, false, &[]).expect("timeline");
        assert_eq!(timeline.interlacing, interlacing, "{name} timeline");
    }
}

#[test]
fn rejects_a_stream_with_no_pictures() {
    let error = transcode(&[0u8; 16], TranscodeOptions::default()).expect_err("must fail");
    assert!(error.to_string().contains("no pictures"));
}
