//! End-to-end transcodes of the checked-in MPEG-2 fixtures.
//!
//! The hashes pin the exact bitstream. They are not a specification -- they are
//! a tripwire: any change that alters a single coefficient shows up here, and
//! whoever made the change has to say why it was intended.

mod support;

use mpeg2toh264::mpeg2::headers::{parse_elementary_stream, pictures_interlacing};
use mpeg2toh264::{
    h264_to_fmp4, mpeg2_video_timeline, transcode, IncrementalTranscoder, TranscodeOptions,
};
use support::{fnv1a, read_fixture, split_annex_b, FIXTURES};

/// fixture, converted pictures, output bytes, FNV-1a of the Annex B stream.
/// Last moved when every P and B slice began naming its short-term reference
/// list outright, which only lengthens the slice headers: each fixture decodes
/// to the same frames as before, checked frame by frame with `ffmpeg -f
/// framemd5`.
const GOLDEN: [(&str, usize, usize, u64); 6] = [
    ("altscan.m2v", 8, 224013, 0x010e_15c1_223c_db4b),
    ("escape.m2v", 6, 122608, 0xdfdc_2865_256a_077b),
    ("hd1080i.m2v", 15, 2106384, 0x83f4_3466_1d58_cd74),
    ("i_only.m2v", 3, 79516, 0x337a_4d1d_9eb5_2ef4),
    ("ibbp.m2v", 15, 164467, 0x7a75_2afa_9f87_6f58),
    ("ip.m2v", 10, 132315, 0x02b3_17b4_0c62_f30b),
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
fn packages_each_fixture_as_a_fragmented_mp4() {
    for name in FIXTURES {
        let source = read_fixture(name);
        let result = transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
        let timeline = mpeg2_video_timeline(&source, false).expect("timeline");
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
        let timeline = mpeg2_video_timeline(&source, false).expect("timeline");
        assert_eq!(timeline.interlacing, interlacing, "{name} timeline");
    }
}

#[test]
fn rejects_a_stream_with_no_pictures() {
    let error = transcode(&[0u8; 16], TranscodeOptions::default()).expect_err("must fail");
    assert!(error.to_string().contains("no pictures"));
}
