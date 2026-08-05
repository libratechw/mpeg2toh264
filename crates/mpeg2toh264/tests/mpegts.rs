//! Demuxing an MPEG-2 video elementary stream back out of a transport stream.

mod support;

use mpeg2toh264::{
    extract_mpeg2_video_es, first_pts, is_mpeg_transport_stream, last_pts, transcode,
    TranscodeOptions,
};
use support::{mux_programs, read_fixture, wrap_mpeg2_es_in_ts, FIXTURES};

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

#[test]
fn reads_the_last_timestamp_out_of_a_tail() {
    let es = read_fixture("ibbp.m2v");
    let mut stream = wrap_mpeg2_es_in_ts(&es, Some(900_000));
    stream.extend_from_slice(&wrap_mpeg2_es_in_ts(&es, Some(954_000)));

    assert_eq!(last_pts(&stream), Some(954_000));
    assert_eq!(first_pts(&stream), Some(900_000), "and the other end of it");
    // A player asks this of the end of a file, so it has to work on a slice
    // that opens mid-packet and carries no program map at all. The cut is
    // ahead of the second PES header, which is the only timestamp in reach:
    // the fixture is one PES per copy, where a broadcast is one per picture.
    let tail = &stream[stream.len() * 2 / 5 + 11..];
    assert_eq!(last_pts(tail), Some(954_000));
    assert_eq!(
        last_pts(&[0u8; 1024]),
        None,
        "no transport stream, no answer"
    );
}

/// A recording is not always of one programme: a broadcaster's sub-channel
/// rides in the same transport stream with its own picture and its own sound.
/// Taking a stream from each would put one programme's picture against the
/// other's audio, so both come from one service -- named, or the first that
/// turns up.
#[test]
fn takes_both_streams_from_one_service() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::{PesUnit, STREAM_TYPE_AAC_ADTS, STREAM_TYPE_MPEG2_VIDEO};

    let main: &[(u16, u8)] = &[
        (0x100, STREAM_TYPE_MPEG2_VIDEO),
        (0x110, STREAM_TYPE_AAC_ADTS),
    ];
    let sub: &[(u16, u8)] = &[
        (0x200, STREAM_TYPE_MPEG2_VIDEO),
        (0x210, STREAM_TYPE_AAC_ADTS),
    ];
    // The main service is announced first and its program map goes out last.
    let stream = mux_programs(
        &[(101, 0x1f0, main), (102, 0x1f1, sub)],
        &[PesUnit {
            pid: 0x100,
            stream_id: 0xe0,
            pts: Some(9000),
            payload: &[0, 0, 1, 0xb3],
        }],
    );

    let mut unguided = MpegTsAvDemuxer::new();
    unguided.push(&stream).expect("demuxes");
    assert_eq!(
        unguided.service_id(),
        Some(101),
        "the service announced first, not the map that arrived first"
    );
    assert_eq!(unguided.service_ids(), &[101, 102]);

    let mut named = MpegTsAvDemuxer::for_service(Some(102));
    named.push(&stream).expect("demuxes");
    assert_eq!(
        named.service_id(),
        Some(102),
        "the service that was asked for"
    );
}

/// A data service sits alongside the television it belongs to and names the
/// same streams. Which of the two program maps a multiplexer sends first is
/// its own business, and the announcement order is what settles it.
#[test]
fn prefers_the_service_the_announcement_puts_first() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::{PesUnit, STREAM_TYPE_AAC_ADTS, STREAM_TYPE_MPEG2_VIDEO};

    let shared: &[(u16, u8)] = &[
        (0x100, STREAM_TYPE_MPEG2_VIDEO),
        (0x110, STREAM_TYPE_AAC_ADTS),
    ];
    let stream = mux_programs(
        &[(101, 0x1f0, shared), (700, 0x1f1, shared)],
        &[PesUnit {
            pid: 0x100,
            stream_id: 0xe0,
            pts: Some(9000),
            payload: &[0, 0, 1, 0xb3],
        }],
    );

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&stream).expect("demuxes");
    assert_eq!(demuxer.service_id(), Some(101));
}
