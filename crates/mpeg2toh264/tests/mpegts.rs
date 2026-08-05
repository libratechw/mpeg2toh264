//! Demuxing an MPEG-2 video elementary stream back out of a transport stream.

mod support;

use mpeg2toh264::{extract_mpeg2_video_es, is_mpeg_transport_stream, transcode, TranscodeOptions};
use support::{read_fixture, wrap_mpeg2_es_in_ts, FIXTURES};

#[test]
fn recognises_a_transport_stream() {
    let es = read_fixture("ip.m2v");
    assert!(!is_mpeg_transport_stream(&es), "an ES is not a TS");
    assert!(is_mpeg_transport_stream(&wrap_mpeg2_es_in_ts(&es, None)));
}

#[test]
fn recovers_the_elementary_stream_byte_for_byte() {
    for name in FIXTURES {
        let es = read_fixture(name);
        let ts = wrap_mpeg2_es_in_ts(&es, None);
        let recovered = extract_mpeg2_video_es(&ts).expect("demux succeeds");
        assert_eq!(recovered, es, "{name} did not survive the transport stream");
    }
}

#[test]
fn survives_a_pes_header_carrying_a_timestamp() {
    let es = read_fixture("ibbp.m2v");
    let ts = wrap_mpeg2_es_in_ts(&es, Some(900_000));
    assert_eq!(extract_mpeg2_video_es(&ts).expect("demux succeeds"), es);
}

#[test]
fn transcoding_through_a_transport_stream_matches_the_bare_stream() {
    let es = read_fixture("ibbp.m2v");
    let ts = wrap_mpeg2_es_in_ts(&es, None);
    let direct = transcode(&es, TranscodeOptions::default()).expect("transcode succeeds");
    let demuxed = extract_mpeg2_video_es(&ts).expect("demux succeeds");
    let through = transcode(&demuxed, TranscodeOptions::default()).expect("transcode succeeds");
    assert_eq!(through.bitstream, direct.bitstream);
}

#[test]
fn rejects_a_transport_stream_with_no_video() {
    // A PAT and PMT that advertise nothing, with no elementary stream behind them.
    let empty = wrap_mpeg2_es_in_ts(&[], None);
    let truncated = &empty[..376]; // PAT and PMT only
    let error = extract_mpeg2_video_es(truncated).expect_err("must fail");
    assert!(
        error.to_string().contains("no PES packets")
            || error.to_string().contains("not a 188-byte"),
        "unexpected error: {error}"
    );
}
