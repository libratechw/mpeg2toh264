//! Demuxing an MPEG-2 video elementary stream back out of a transport stream.

mod support;

use std::collections::HashMap;

use mpeg2toh264::{
    extract_mpeg2_video_es, first_pts, is_mpeg_transport_stream, last_pts, transcode,
    TranscodeOptions,
};
use support::{mux_programs, read_fixture, wrap_mpeg2_es_in_ts, FIXTURES};

#[test]
fn recognises_a_transport_stream() {
    let es = read_fixture("ip.m2v");
    assert!(!is_mpeg_transport_stream(&es), "an ES is not a TS");
    assert!(is_mpeg_transport_stream(&wrap_mpeg2_es_in_ts(
        &es,
        None,
        &mut HashMap::new()
    )));
}

#[test]
fn recovers_the_elementary_stream_byte_for_byte() {
    for name in FIXTURES {
        let es = read_fixture(name);
        let ts = wrap_mpeg2_es_in_ts(&es, None, &mut HashMap::new());
        let recovered = extract_mpeg2_video_es(&ts).expect("demux succeeds");
        assert_eq!(recovered, es, "{name} did not survive the transport stream");
    }
}

#[test]
fn skips_a_packet_with_reserved_adaptation_field_control() {
    let es = read_fixture("ibbp.m2v");
    let mut ts = wrap_mpeg2_es_in_ts(&es, None, &mut HashMap::new());
    let mut damaged = vec![0xff; 188];
    damaged[..4].copy_from_slice(&[0x47, 0x1f, 0xff, 0x00]);
    damaged.append(&mut ts);

    assert_eq!(
        extract_mpeg2_video_es(&damaged).expect("one damaged packet is skipped"),
        es
    );
}

#[test]
fn survives_a_pes_header_carrying_a_timestamp() {
    let es = read_fixture("ibbp.m2v");
    let ts = wrap_mpeg2_es_in_ts(&es, Some(900_000), &mut HashMap::new());
    assert_eq!(extract_mpeg2_video_es(&ts).expect("demux succeeds"), es);
}

#[test]
fn transcoding_through_a_transport_stream_matches_the_bare_stream() {
    let es = read_fixture("ibbp.m2v");
    let ts = wrap_mpeg2_es_in_ts(&es, None, &mut HashMap::new());
    let direct = transcode(&es, TranscodeOptions::default()).expect("transcode succeeds");
    let demuxed = extract_mpeg2_video_es(&ts).expect("demux succeeds");
    let through = transcode(&demuxed, TranscodeOptions::default()).expect("transcode succeeds");
    assert_eq!(through.bitstream, direct.bitstream);
}

#[test]
fn rejects_a_transport_stream_with_no_video() {
    // A PAT and PMT that advertise nothing, with no elementary stream behind them.
    let empty = wrap_mpeg2_es_in_ts(&[], None, &mut HashMap::new());
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
    let mut continuity = HashMap::new();
    let mut stream = wrap_mpeg2_es_in_ts(&es, Some(900_000), &mut continuity);
    stream.extend_from_slice(&wrap_mpeg2_es_in_ts(&es, Some(954_000), &mut continuity));

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
        &mut HashMap::new(),
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
        &mut HashMap::new(),
    );

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&stream).expect("demuxes");
    assert_eq!(demuxer.service_id(), Some(101));
}

/// A lower-ranked PMT may be followed by its PES before the first service's
/// PMT appears. That must not make the provisional service permanent.
#[test]
fn waits_for_the_first_announced_services_pmt_before_emitting() {
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
    let mut continuity = HashMap::new();
    let tables = mux_programs(
        &[(101, 0x1f0, main), (102, 0x1f1, sub)],
        &[],
        &mut continuity,
    );
    let sub_pes = mux_programs(
        &[(101, 0x1f0, main), (102, 0x1f1, sub)],
        &[
            PesUnit {
                pid: 0x200,
                stream_id: 0xe0,
                pts: Some(9000),
                payload: &[1],
            },
            PesUnit {
                pid: 0x200,
                stream_id: 0xe0,
                pts: Some(18000),
                payload: &[2],
            },
        ],
        &mut continuity,
    );
    let main_pes = mux_programs(
        &[(101, 0x1f0, main), (102, 0x1f1, sub)],
        &[PesUnit {
            pid: 0x100,
            stream_id: 0xe0,
            pts: Some(27000),
            payload: &[3],
        }],
        &mut continuity,
    );

    // PAT, second service's PMT, its PES, first service's PMT, then its PES.
    let mut stream = tables[..2 * 188].to_vec();
    stream.extend_from_slice(&sub_pes[3 * 188..]);
    stream.extend_from_slice(&tables[2 * 188..3 * 188]);
    stream.extend_from_slice(&main_pes[3 * 188..]);

    let mut demuxer = MpegTsAvDemuxer::new();
    let packets = demuxer.push(&stream).expect("demuxes");
    assert_eq!(demuxer.service_id(), Some(101));
    assert!(packets.iter().all(|packet| packet.pid == 0x100));
}

/// An empty first service must not leave a later playable service waiting
/// forever when their program maps arrive in announcement order.
#[test]
fn takes_a_playable_service_after_the_first_services_empty_pmt() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::{PesUnit, STREAM_TYPE_AAC_ADTS, STREAM_TYPE_MPEG2_VIDEO};

    let empty: &[(u16, u8)] = &[];
    let playable: &[(u16, u8)] = &[
        (0x200, STREAM_TYPE_MPEG2_VIDEO),
        (0x210, STREAM_TYPE_AAC_ADTS),
    ];
    let mut continuity = HashMap::new();
    let tables = mux_programs(
        &[(201, 0x110, empty), (202, 0x120, playable)],
        &[],
        &mut continuity,
    );
    let pes = mux_programs(
        &[(201, 0x110, empty), (202, 0x120, playable)],
        &[PesUnit {
            pid: 0x200,
            stream_id: 0xe0,
            pts: Some(9000),
            payload: &[1],
        }],
        &mut continuity,
    );

    // mux_programs deliberately emits PMTs in reverse order; put the empty
    // service first to reproduce this stream's ordering.
    let mut stream = tables[..188].to_vec();
    stream.extend_from_slice(&tables[2 * 188..3 * 188]);
    stream.extend_from_slice(&tables[188..2 * 188]);
    stream.extend_from_slice(&pes[3 * 188..]);

    let mut demuxer = MpegTsAvDemuxer::new();
    let packets = demuxer.push(&stream).expect("demuxes");
    assert_eq!(demuxer.service_id(), Some(202));
    assert!(packets.iter().all(|packet| packet.pid == 0x200));
}

/// A later playable PMT must wait for every service ahead of it, not just for
/// the first one. Otherwise PMT arrival order can override PAT order.
#[test]
fn waits_for_every_earlier_service_before_choosing_a_later_one() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::STREAM_TYPE_MPEG2_VIDEO;

    let empty: &[(u16, u8)] = &[];
    let second: &[(u16, u8)] = &[(0x200, STREAM_TYPE_MPEG2_VIDEO)];
    let third: &[(u16, u8)] = &[(0x300, STREAM_TYPE_MPEG2_VIDEO)];
    let tables = mux_programs(
        &[
            (201, 0x110, empty),
            (202, 0x120, second),
            (203, 0x130, third),
        ],
        &[],
        &mut HashMap::new(),
    );

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&tables[..188]).expect("reads PAT");
    // mux_programs emits PMTs as 203, 202, 201. Inspect 201, then 203: 203
    // still cannot be chosen because the preferred 202 has not been seen.
    demuxer
        .push(&tables[3 * 188..4 * 188])
        .expect("reads empty 201 PMT");
    demuxer
        .push(&tables[188..2 * 188])
        .expect("reads playable 203 PMT");
    assert_eq!(demuxer.service_id(), None);

    demuxer
        .push(&tables[2 * 188..3 * 188])
        .expect("reads playable 202 PMT");
    assert_eq!(demuxer.service_id(), Some(202));
}

#[test]
fn skips_multiple_empty_services_in_pat_order() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::STREAM_TYPE_MPEG2_VIDEO;

    let empty: &[(u16, u8)] = &[];
    let playable: &[(u16, u8)] = &[(0x300, STREAM_TYPE_MPEG2_VIDEO)];
    let tables = mux_programs(
        &[
            (201, 0x110, empty),
            (202, 0x120, empty),
            (203, 0x130, playable),
        ],
        &[],
        &mut HashMap::new(),
    );
    let mut stream = tables[..188].to_vec();
    stream.extend_from_slice(&tables[3 * 188..4 * 188]);
    stream.extend_from_slice(&tables[2 * 188..3 * 188]);
    stream.extend_from_slice(&tables[188..2 * 188]);

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&stream).expect("demuxes");
    assert_eq!(demuxer.service_id(), Some(203));
}

/// A PAT entry may outlive the PMT it points to. A later playable service must
/// not wait forever for a map that remains absent across PAT repetitions.
#[test]
fn skips_an_earlier_service_whose_pmt_is_missing() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::STREAM_TYPE_MPEG2_VIDEO;

    let missing: &[(u16, u8)] = &[];
    let playable: &[(u16, u8)] = &[(0x200, STREAM_TYPE_MPEG2_VIDEO)];
    let tables = mux_programs(
        &[(201, 0x110, missing), (202, 0x120, playable)],
        &[],
        &mut HashMap::new(),
    );
    // PAT, 202 PMT, then the next PAT. The 201 PMT is never transmitted.
    let mut stream = tables[..2 * 188].to_vec();
    let mut repeated_pat = tables[..188].to_vec();
    // The low nibble is the TS continuity counter, not the PAT version number.
    // Advancing it makes this a new transport packet rather than a retransmission.
    repeated_pat[3] = (repeated_pat[3] & 0xf0) | 1;
    stream.extend_from_slice(&repeated_pat);

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&stream).expect("demuxes");
    assert_eq!(demuxer.service_id(), Some(202));
}

#[test]
fn a_retransmitted_pat_does_not_end_the_pmt_wait() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::STREAM_TYPE_MPEG2_VIDEO;

    let missing: &[(u16, u8)] = &[];
    let playable: &[(u16, u8)] = &[(0x200, STREAM_TYPE_MPEG2_VIDEO)];
    let tables = mux_programs(
        &[(201, 0x110, missing), (202, 0x120, playable)],
        &[],
        &mut HashMap::new(),
    );
    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer
        .push(&tables[..2 * 188])
        .expect("reads PAT and 202 PMT");

    demuxer
        .push(&tables[..188])
        .expect("ignores retransmitted PAT");
    assert_eq!(demuxer.service_id(), None);

    let mut next_pat = tables[..188].to_vec();
    // Advance the TS continuity counter so duplicate suppression admits the
    // next PAT cycle; the section and its version number remain unchanged.
    next_pat[3] = (next_pat[3] & 0xf0) | 1;
    demuxer.push(&next_pat).expect("reads the next PAT cycle");
    assert_eq!(demuxer.service_id(), Some(202));
}

#[test]
fn emits_private_stream_pes_from_the_selected_service() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{
        mux_transport_stream_with_descriptors, PesUnit, STREAM_TYPE_AAC_ADTS,
        STREAM_TYPE_MPEG2_VIDEO, STREAM_TYPE_PRIVATE_DATA,
    };

    let caption = vec![0x80; 300];
    let superimpose = vec![0x81; 40];
    let caption_component = [0x52, 0x01, 0x30];
    let superimpose_component = [0x52, 0x01, 0x38];
    let streams = &[
        (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
        (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
        (
            0x120,
            STREAM_TYPE_PRIVATE_DATA,
            caption_component.as_slice(),
        ),
        (
            0x121,
            STREAM_TYPE_PRIVATE_DATA,
            superimpose_component.as_slice(),
        ),
    ];
    let ts = mux_transport_stream_with_descriptors(
        streams,
        &[
            PesUnit {
                pid: 0x110,
                stream_id: 0xc0,
                pts: Some(135_000),
                payload: &[0xff],
            },
            PesUnit {
                pid: 0x120,
                stream_id: 0xbd,
                pts: Some(90_000),
                payload: &caption,
            },
            PesUnit {
                pid: 0x121,
                stream_id: 0xbf,
                pts: None,
                payload: &superimpose,
            },
            PesUnit {
                pid: 0x100,
                stream_id: 0xe0,
                pts: Some(90_000),
                payload: &[0, 0, 1, 0xb3],
            },
        ],
        &mut HashMap::new(),
    );

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&ts).expect("private streams demux");
    packets.extend(demuxer.finish().expect("private streams flush"));

    let private1 = packets
        .iter()
        .find(|packet| {
            packet.kind == ElementaryKind::PrivateStream1 && packet.data.len() == caption.len()
        })
        .expect("private_stream_1 packet");
    assert_eq!(private1.pid, 0x120);
    assert_eq!(private1.pts, Some(90_000));
    assert_eq!(private1.data, caption);

    let private2 = packets
        .iter()
        .find(|packet| packet.kind == ElementaryKind::PrivateStream2)
        .expect("private_stream_2 packet");
    assert_eq!(private2.pid, 0x121);
    assert_eq!(private2.pts, Some(135_000));
    assert_eq!(private2.data, superimpose);
}

#[test]
fn emits_only_the_default_caption_and_superimpose_streams() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{
        mux_transport_stream_with_descriptors, PesUnit, STREAM_TYPE_AAC_ADTS,
        STREAM_TYPE_MPEG2_VIDEO, STREAM_TYPE_PRIVATE_DATA,
    };

    let component = |tag| [0x52, 0x01, tag];
    let main_video = component(0x00);
    let secondary_video = component(0x01);
    let main_caption = component(0x30);
    let secondary_caption = component(0x31);
    let main_superimpose = component(0x38);
    let secondary_superimpose = component(0x39);
    let streams = &[
        (0x100, STREAM_TYPE_MPEG2_VIDEO, main_video.as_slice()),
        (0x101, STREAM_TYPE_MPEG2_VIDEO, secondary_video.as_slice()),
        (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
        (
            0x131,
            STREAM_TYPE_PRIVATE_DATA,
            secondary_caption.as_slice(),
        ),
        (0x130, STREAM_TYPE_PRIVATE_DATA, main_caption.as_slice()),
        (
            0x139,
            STREAM_TYPE_PRIVATE_DATA,
            secondary_superimpose.as_slice(),
        ),
        (0x138, STREAM_TYPE_PRIVATE_DATA, main_superimpose.as_slice()),
    ];
    let units = [
        PesUnit {
            pid: 0x130,
            stream_id: 0xbd,
            pts: Some(90_000),
            payload: &[0x80],
        },
        PesUnit {
            pid: 0x131,
            stream_id: 0xbd,
            pts: Some(90_000),
            payload: &[0x81],
        },
        PesUnit {
            pid: 0x138,
            stream_id: 0xbf,
            pts: None,
            payload: &[0x82; 3],
        },
        PesUnit {
            pid: 0x139,
            stream_id: 0xbf,
            pts: None,
            payload: &[0x83; 3],
        },
        PesUnit {
            pid: 0x100,
            stream_id: 0xe0,
            pts: Some(90_000),
            payload: &[0, 0, 1, 0xb3],
        },
    ];
    let ts = mux_transport_stream_with_descriptors(streams, &units, &mut HashMap::new());

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&ts).expect("demuxes component-tagged streams");
    packets.extend(demuxer.finish().expect("flushes component-tagged streams"));

    let mut private_pids: Vec<_> = packets
        .iter()
        .filter(|packet| {
            matches!(
                packet.kind,
                ElementaryKind::PrivateStream1 | ElementaryKind::PrivateStream2
            )
        })
        .map(|packet| packet.pid)
        .collect();
    private_pids.sort_unstable();
    assert_eq!(private_pids, [0x130, 0x138]);
}

/// The audio component descriptor is what a broadcast says its sound with, and
/// it says all of it in one place: which of the streams is the main one, whether
/// the two channels of a stream are a stereo pair or two separate services, and
/// what language each carries. A viewer choosing between them is choosing
/// between those labels, so they have to come out of the program map -- before
/// either stream has been read, and without decoding a frame of sound.
#[test]
fn reads_what_the_program_map_says_about_each_sound_stream() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::{
        mux_transport_stream_with_descriptors, PesUnit, STREAM_TYPE_AAC_ADTS,
        STREAM_TYPE_MPEG2_VIDEO,
    };

    // 1/0 + 1/0 mode, component tag 0x10, bilingual: Japanese and English in
    // one stream, which a receiver plays one of.
    let bilingual = [
        0xc4, 0x0c, 0xf2, 0x02, 0x10, 0x0f, 0xff, 0xff, b'j', b'p', b'n', b'e', b'n', b'g',
    ];
    // 2/0 mode, component tag 0x11: an ordinary stereo pair beside it.
    let commentary = [
        0x52, 0x01, 0x11, 0xc4, 0x09, 0xf2, 0x03, 0x11, 0x0f, 0xff, 0x7f, b'j', b'p', b'n',
    ];
    let streams = &[
        (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
        (0x110, STREAM_TYPE_AAC_ADTS, bilingual.as_slice()),
        (0x111, STREAM_TYPE_AAC_ADTS, commentary.as_slice()),
    ];
    let ts = mux_transport_stream_with_descriptors(
        streams,
        &[PesUnit {
            pid: 0x100,
            stream_id: 0xe0,
            pts: Some(90_000),
            payload: &[0, 0, 1, 0xb3],
        }],
        &mut HashMap::new(),
    );

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&ts).expect("demuxes");

    let sound = demuxer.audio_streams();
    assert_eq!(sound.len(), 2, "both sound streams, in the map's own order");
    assert_eq!(sound[0].pid, 0x110);
    assert_eq!(
        sound[0].component_tag,
        Some(0x10),
        "the audio component descriptor names the tag where no stream \
         identifier descriptor does"
    );
    assert!(sound[0].dual_mono, "1/0 + 1/0 is two services, not a pair");
    assert_eq!(sound[0].languages, ["jpn", "eng"]);
    assert_eq!(sound[1].pid, 0x111);
    assert_eq!(sound[1].component_tag, Some(0x11));
    assert!(!sound[1].dual_mono);
    assert_eq!(sound[1].languages, ["jpn"]);

    assert_eq!(
        demuxer.audio_pid(),
        Some(0x110),
        "and until anyone says otherwise the sound is the first of them"
    );
}

/// The choice belongs to the service rather than to one of its program maps. A
/// station repeats its map every fraction of a second, and a viewer who picked
/// the second sound is not asking to be put back on the first one by the next
/// repetition -- nor by the map a station sends when it moves its streams and
/// names that sound again.
#[test]
fn keeps_the_chosen_sound_across_a_repeated_program_map() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::{
        mux_transport_stream_with_descriptors, PesUnit, STREAM_TYPE_AAC_ADTS,
        STREAM_TYPE_MPEG2_VIDEO,
    };

    let streams = &[
        (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
        (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
        (0x111, STREAM_TYPE_AAC_ADTS, &[][..]),
    ];
    let video = PesUnit {
        pid: 0x100,
        stream_id: 0xe0,
        pts: Some(90_000),
        payload: &[0, 0, 1, 0xb3],
    };
    let ts = mux_transport_stream_with_descriptors(
        streams,
        std::slice::from_ref(&video),
        &mut HashMap::new(),
    );

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&ts).expect("demuxes");
    demuxer.select_audio(0x111);
    demuxer.push(&ts).expect("demuxes the map again");
    assert_eq!(demuxer.audio_pid(), Some(0x111));
}

/// A programme boundary can take the stream a viewer picked away with it: the
/// programme after it carries one sound where the one before carried two. There
/// is nothing to fall back to but the sound that is there, and when the
/// broadcast offers the second one again it is offered back -- a station that
/// moves its streams about within a service is the same programme carrying on,
/// and it still owes the viewer the choice they made.
#[test]
fn falls_back_to_the_remaining_sound_and_returns_to_the_chosen_one() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::{
        mux_transport_stream_with_descriptors, PesUnit, STREAM_TYPE_AAC_ADTS,
        STREAM_TYPE_MPEG2_VIDEO,
    };

    let video = PesUnit {
        pid: 0x100,
        stream_id: 0xe0,
        pts: Some(90_000),
        payload: &[0, 0, 1, 0xb3],
    };
    let mut continuity = HashMap::new();
    let map = |streams: &[(u16, u8, &[u8])], continuity: &mut HashMap<u16, u8>| {
        mux_transport_stream_with_descriptors(streams, std::slice::from_ref(&video), continuity)
    };
    let both = map(
        &[
            (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
            (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
            (0x111, STREAM_TYPE_AAC_ADTS, &[][..]),
        ],
        &mut continuity,
    );
    let one = map(
        &[
            (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
            (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
        ],
        &mut continuity,
    );

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&both).expect("demuxes");
    demuxer.select_audio(0x111);
    demuxer.push(&both).expect("demuxes");
    assert_eq!(
        demuxer.audio_pid(),
        Some(0x111),
        "the sound that was picked"
    );

    demuxer.push(&one).expect("demuxes the narrower map");
    assert_eq!(
        demuxer.audio_streams().len(),
        1,
        "the programme offers one sound now"
    );
    assert_eq!(
        demuxer.audio_pid(),
        Some(0x110),
        "which is the one that is heard, there being no other"
    );

    demuxer.push(&both).expect("demuxes the wider map");
    assert_eq!(
        demuxer.audio_pid(),
        Some(0x111),
        "and the choice is honoured again as soon as it can be"
    );
}

/// A programme that carries no sound at all is the same thing taken to its
/// end: there is nothing to offer and nothing to read. What must not happen is
/// the demuxer going on reading a PID the programme no longer names, which
/// would put another programme's sound against this one's picture.
#[test]
fn stops_reading_the_sound_a_programme_no_longer_carries() {
    use mpeg2toh264::container::mpegts::MpegTsAvDemuxer;
    use support::{
        mux_transport_stream_with_descriptors, PesUnit, STREAM_TYPE_AAC_ADTS,
        STREAM_TYPE_MPEG2_VIDEO,
    };

    let video = PesUnit {
        pid: 0x100,
        stream_id: 0xe0,
        pts: Some(90_000),
        payload: &[0, 0, 1, 0xb3],
    };
    let mut continuity = HashMap::new();
    let with_sound = mux_transport_stream_with_descriptors(
        &[
            (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
            (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
        ],
        std::slice::from_ref(&video),
        &mut continuity,
    );
    let silent = mux_transport_stream_with_descriptors(
        &[(0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..])],
        std::slice::from_ref(&video),
        &mut continuity,
    );

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&with_sound).expect("demuxes");
    assert!(demuxer.has_aac_audio());
    demuxer.push(&silent).expect("demuxes the silent map");
    assert_eq!(demuxer.audio_pid(), None);
    assert!(demuxer.audio_streams().is_empty());
    assert!(
        !demuxer.has_aac_audio(),
        "so nothing downstream holds the picture back waiting for sound"
    );
}

#[test]
fn marks_an_unbounded_pes_boundary_after_packet_loss_as_damaged() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    // The first PES spans three transport packets. Losing its last packet is
    // observed only when the next PES starts with a skipped continuity count,
    // so that replacement must carry the damage marker for the flushed tail.
    let first = vec![0xaa; 400];
    let second = vec![0xbb; 32];
    let mut stream = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: Some(90_000),
                payload: &first,
            },
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: Some(93_000),
                payload: &second,
            },
        ],
        &mut HashMap::new(),
    );
    // Video commonly leaves PES_packet_length at zero. A skipped continuity
    // count still proves that the missing packet cut the preceding payload.
    stream[2 * 188 + 8] = 0;
    stream[2 * 188 + 9] = 0;
    stream.drain(4 * 188..5 * 188);

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes around the hole");
    packets.extend(demuxer.finish().expect("flushes the replacement"));
    let video: Vec<_> = packets
        .iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .collect();

    assert_eq!(video.len(), 2);
    assert!(!video[0].damaged_previous_pes);
    assert!(
        video[1].damaged_previous_pes,
        "the complete PES after the hole discards the damaged GOP prefix"
    );
}

/// A station that leaves a multi-channel block updates its own program map to
/// name different elementary streams: in Japan the standard-definition
/// sub-channel gives way to the high-definition one, on another PID and at
/// another frame size. That is the programme carrying on, not another one
/// being spliced onto it, so the demuxer follows it. Refusing left the video
/// stopped where the map changed, with everything after it silently dropped.
#[test]
fn follows_the_chosen_services_own_map_to_other_streams() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{PesUnit, STREAM_TYPE_AAC_ADTS, STREAM_TYPE_MPEG2_VIDEO};

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
        &[PesUnit {
            pid: 0x200,
            stream_id: 0xe0,
            pts: Some(9000),
            payload: &[0xaa],
        }],
        &mut HashMap::new(),
    );
    stream.extend_from_slice(&mux_programs(
        &[(101, 0x1f0, after)],
        &[
            // A multiplexer does not cut the old stream where the map changes:
            // it keeps sending until the new one starts, and that is still the
            // programme.
            PesUnit {
                pid: 0x200,
                stream_id: 0xe0,
                pts: Some(13500),
                payload: &[0xcc],
            },
            PesUnit {
                pid: 0x100,
                stream_id: 0xe0,
                pts: Some(18000),
                payload: &[0xbb],
            },
        ],
        &mut HashMap::new(),
    ));

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes");
    packets.extend(demuxer.finish().expect("flushes"));
    let video: Vec<(u16, Vec<u8>)> = packets
        .into_iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .map(|packet| (packet.pid, packet.data))
        .collect();

    assert_eq!(
        video,
        vec![
            (0x200, vec![0xaa]),
            (0x200, vec![0xcc]),
            (0x100, vec![0xbb])
        ],
        "both halves of the programme, in order, including what the stream \
         being left sent after the map changed"
    );
    assert_eq!(demuxer.service_id(), Some(101), "and it is one service");
}

#[test]
fn a_superseded_stream_recovers_after_packet_loss() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{PesUnit, STREAM_TYPE_MPEG2_VIDEO};

    let before: &[(u16, u8)] = &[(0x200, STREAM_TYPE_MPEG2_VIDEO)];
    let after: &[(u16, u8)] = &[(0x100, STREAM_TYPE_MPEG2_VIDEO)];
    let mut stream = mux_programs(
        &[(101, 0x1f0, before)],
        &[PesUnit {
            pid: 0x200,
            stream_id: 0xe0,
            pts: Some(9000),
            payload: &[0xaa],
        }],
        &mut HashMap::new(),
    );
    let damaged = vec![0xcc; 400];
    stream.extend_from_slice(&mux_programs(
        &[(101, 0x1f0, after)],
        &[
            PesUnit {
                pid: 0x200,
                stream_id: 0xe0,
                pts: Some(13_500),
                payload: &damaged,
            },
            PesUnit {
                pid: 0x200,
                stream_id: 0xe0,
                pts: Some(18_000),
                payload: &[0xdd],
            },
            PesUnit {
                pid: 0x100,
                stream_id: 0xe0,
                pts: Some(22_500),
                payload: &[0xbb],
            },
        ],
        &mut HashMap::new(),
    ));
    // The middle packet of the first PES sent on the old PID is lost after the
    // PMT moves the programme, while a later complete PES still precedes the new PID.
    stream.drain(6 * 188..7 * 188);

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes across the move");
    packets.extend(demuxer.finish().expect("flushes the new stream"));
    let video: Vec<(u16, Vec<u8>)> = packets
        .into_iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .map(|packet| (packet.pid, packet.data))
        .collect();

    assert_eq!(
        video,
        vec![
            (0x200, vec![0xaa]),
            (0x200, vec![0xdd]),
            (0x100, vec![0xbb]),
        ]
    );
}

#[test]
fn packet_loss_is_not_a_table_restart_just_because_every_counter_is_zero() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    const PACKET_SIZE: usize = 188;
    let packet_pid = |packet: &[u8]| (((packet[1] & 0x1f) as u16) << 8) | packet[2] as u16;
    let first = vec![0xaa; 17 * 184 - 9];
    let replacement = vec![0xbb; 32];
    let mut stream = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                payload: &first,
                pts: None,
            },
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                payload: &replacement,
                pts: None,
            },
        ],
        &mut HashMap::new(),
    );
    let video_packets: Vec<_> = stream
        .chunks(PACKET_SIZE)
        .enumerate()
        .filter_map(|(index, packet)| (packet_pid(packet) == VIDEO_PID).then_some(index))
        .collect();
    assert_eq!(video_packets.len(), 18);
    assert_eq!(stream[video_packets[16] * PACKET_SIZE + 3] & 0x0f, 0);

    // Detect loss on the video PID independently of coincidental PAT and PMT counter resets
    let mut pat = stream[..PACKET_SIZE].to_vec();
    let mut pmt = stream[PACKET_SIZE..2 * PACKET_SIZE].to_vec();
    pat[PACKET_SIZE - 1] = 0xfe;
    pmt[PACKET_SIZE - 1] = 0xfe;
    let insert_at = (video_packets[14] + 1) * PACKET_SIZE;
    stream.splice(insert_at..insert_at, pat);
    stream.splice(insert_at + PACKET_SIZE..insert_at + PACKET_SIZE, pmt);
    let missing = (video_packets[15] + 2) * PACKET_SIZE;
    stream.drain(missing..missing + PACKET_SIZE);

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes");
    packets.extend(demuxer.finish().expect("flushes"));
    let video: Vec<_> = packets
        .into_iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .map(|packet| packet.data)
        .collect();

    assert_eq!(video, vec![replacement]);
    assert_eq!(demuxer.dropped(), 31);
}

#[test]
fn two_pmt_pid_changes_do_not_drop_the_first_superseded_pes() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{PesUnit, STREAM_TYPE_MPEG2_VIDEO};

    const PACKET_SIZE: usize = 188;
    let packet_pid = |packet: &[u8]| (((packet[1] & 0x1f) as u16) << 8) | packet[2] as u16;
    let old_pid = 0x200;
    let middle_pid = 0x201;
    let new_pid = 0x202;
    let old = vec![0xaa; 400];
    let new = vec![0xcc; 32];
    let mut continuity = HashMap::new();
    let mut stream = mux_programs(
        &[(101, 0x1f0, &[(old_pid, STREAM_TYPE_MPEG2_VIDEO)])],
        &[PesUnit {
            pid: old_pid,
            stream_id: 0xe0,
            payload: &old,
            pts: None,
        }],
        &mut continuity,
    );
    let old_start = stream
        .chunks(PACKET_SIZE)
        .position(|packet| packet_pid(packet) == old_pid && packet[1] & 0x40 != 0)
        .expect("old PES starts");
    stream[old_start * PACKET_SIZE + 8] = 0;
    stream[old_start * PACKET_SIZE + 9] = 0;

    // Finalize the earlier PID's PES even when the next PMT precedes the intermediate PID's PES
    stream.extend_from_slice(&mux_programs(
        &[(101, 0x1f0, &[(middle_pid, STREAM_TYPE_MPEG2_VIDEO)])],
        &[],
        &mut continuity,
    ));
    stream.extend_from_slice(&mux_programs(
        &[(101, 0x1f0, &[(new_pid, STREAM_TYPE_MPEG2_VIDEO)])],
        &[PesUnit {
            pid: new_pid,
            stream_id: 0xe0,
            payload: &new,
            pts: None,
        }],
        &mut continuity,
    ));

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes");
    packets.extend(demuxer.finish().expect("flushes"));
    let video: Vec<_> = packets
        .into_iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .map(|packet| (packet.pid, packet.data))
        .collect();

    assert_eq!(video, vec![(old_pid, old), (new_pid, new)]);
}

#[test]
fn flushes_a_superseded_pes_when_the_service_changes_before_new_video_arrives() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_programs, PesUnit, STREAM_TYPE_MPEG2_VIDEO};

    let old_pid = 0x200;
    let middle_pid = 0x201;
    let replacement_pid = 0x300;
    let first_service: &[(u16, u8)] = &[(replacement_pid, STREAM_TYPE_MPEG2_VIDEO)];
    let old_service: &[(u16, u8)] = &[(old_pid, STREAM_TYPE_MPEG2_VIDEO)];
    let moved_service: &[(u16, u8)] = &[(middle_pid, STREAM_TYPE_MPEG2_VIDEO)];
    let mut continuity = HashMap::new();
    let initial = mux_programs(
        &[(101, 0x1f0, first_service), (102, 0x1f1, old_service)],
        &[],
        &mut continuity,
    );

    let mut demuxer = MpegTsAvDemuxer::new();
    // Select the lower-priority service once while the earlier service's PMT remains pending
    assert!(demuxer
        .push(&initial[..2 * 188])
        .expect("defers service 102")
        .is_empty());
    let mut repeated_pat = initial[..188].to_vec();
    repeated_pat[3] = (repeated_pat[3] & 0xf0) | 1;
    assert!(demuxer
        .push(&repeated_pat)
        .expect("selects service 102")
        .is_empty());

    let old_pes = mux_programs(
        &[(101, 0x1f0, first_service), (102, 0x1f1, old_service)],
        &[PesUnit {
            pid: old_pid,
            stream_id: 0xe0,
            payload: &[0xaa; 400],
            pts: None,
        }],
        &mut continuity,
    );
    // Send only the opening packet, leaving the old PID's PES pending
    assert!(demuxer
        .push(&old_pes[3 * 188..4 * 188])
        .expect("starts the old service PES")
        .is_empty());

    let moved = mux_programs(
        &[(101, 0x1f0, first_service), (102, 0x1f1, moved_service)],
        &[],
        &mut continuity,
    );
    // Allow the old PID to continue after a PID update within the same service
    assert!(demuxer
        .push(&moved[188..2 * 188])
        .expect("moves service 102 to its new PID")
        .is_empty());

    // Return the old service's pending PES when switching to the preferred service
    let selected = mux_programs(
        &[(101, 0x1f0, first_service), (102, 0x1f1, moved_service)],
        &[],
        &mut continuity,
    );
    let switched: Vec<_> = demuxer
        .push(&selected[2 * 188..3 * 188])
        .expect("selects service 101")
        .into_iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .map(|packet| (packet.pid, packet.data))
        .collect();
    assert_eq!(switched, vec![(old_pid, vec![0xaa; 175])]);

    let replacement = mux_programs(
        &[(101, 0x1f0, first_service), (102, 0x1f1, moved_service)],
        &[PesUnit {
            pid: replacement_pid,
            stream_id: 0xe0,
            payload: &[0xbb],
            pts: None,
        }],
        &mut continuity,
    );
    // Do not emit the old service's already returned PES again with the new service's video
    let video: Vec<_> = demuxer
        .push(&replacement[3 * 188..])
        .expect("reads the replacement service")
        .into_iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .map(|packet| (packet.pid, packet.data))
        .collect();
    assert_eq!(video, vec![(replacement_pid, vec![0xbb])]);
    assert!(demuxer.finish().expect("flushes").is_empty());
}

#[test]
fn marks_packet_loss_ending_at_counter_zero_as_damaged() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    // The continuity counter wraps after fifteen, so zero can follow either a
    // complete packet fifteen or a hole where packet fifteen was lost. The
    // missing counter still proves damage even though the received value is zero.
    let first = vec![0xaa; 16 * 184 - 9];
    let second = vec![0xbb; 32];
    let mut stream = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: None,
                payload: &first,
            },
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: None,
                payload: &second,
            },
        ],
        &mut HashMap::new(),
    );
    stream.drain(17 * 188..18 * 188);

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes around the wrap");
    packets.extend(demuxer.finish().expect("flushes the replacement"));
    let replacement = packets
        .iter()
        .find(|packet| packet.kind == ElementaryKind::Video && packet.data == second)
        .expect("complete PES after the hole");

    assert!(replacement.damaged_previous_pes);
    assert_eq!(demuxer.dropped(), 1);
}

#[test]
fn detects_loss_immediately_after_a_payload_discontinuity_marker() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    // A payload-bearing marker resets comparison with the packet before it,
    // then becomes the baseline for detecting loss in the new continuity run.
    let first = vec![0xaa; 700];
    let second = vec![0xbb; 32];
    let mut stream = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: None,
                payload: &first,
            },
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: None,
                payload: &second,
            },
        ],
        &mut HashMap::new(),
    );
    // Make the first video packet carry a one-byte adaptation field and retain
    // the first 182 payload bytes after its discontinuity marker.
    stream[2 * 188 + 3] = 0x30;
    stream.copy_within(2 * 188 + 4..2 * 188 + 186, 2 * 188 + 6);
    stream[2 * 188 + 4] = 1;
    stream[2 * 188 + 5] = 0x80;
    // Counter one is now missing, so counter two must damage the open PES.
    stream.drain(3 * 188..4 * 188);

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes after the marker");
    packets.extend(demuxer.finish().expect("flushes the replacement"));
    let replacement = packets
        .iter()
        .find(|packet| packet.kind == ElementaryKind::Video && packet.data == second)
        .expect("complete PES after the hole");

    assert!(replacement.damaged_previous_pes);
    assert_eq!(demuxer.dropped(), 1);
}

#[test]
fn preserves_an_open_video_pes_across_a_payload_discontinuity_marker() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    // A payload-bearing discontinuity marker supplies the first bytes and the
    // counter baseline of its new run, so the open PES remains intact.
    let first = vec![0xaa; 400];
    let second = vec![0xbb; 32];
    let mut stream = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: Some(90_000),
                payload: &first,
            },
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: Some(93_000),
                payload: &second,
            },
        ],
        &mut HashMap::new(),
    );
    // The last packet of the first PES already has an adaptation field, so its
    // marker resets continuity without removing any elementary-stream bytes.
    stream[4 * 188 + 5] = 0x80;

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes the marked PES");
    packets.extend(demuxer.finish().expect("flushes both PES packets"));
    let video: Vec<_> = packets
        .iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .collect();

    assert_eq!(video.len(), 2);
    assert_eq!(video[0].data, first);
    assert_eq!(video[1].data, second);
    assert!(!video[1].damaged_previous_pes);
    assert_eq!(demuxer.dropped(), 0);
}

#[test]
fn preserves_an_open_video_pes_across_an_adaptation_only_discontinuity() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    // An adaptation-only marker carries no elementary-stream bytes, but its
    // counter anchors the first payload of the new continuity run.
    let first = vec![0xaa; 400];
    let second = vec![0xbb; 32];
    let mut stream = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: Some(90_000),
                payload: &first,
            },
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: Some(93_000),
                payload: &second,
            },
        ],
        &mut HashMap::new(),
    );
    let marker = [
        0x47,
        (VIDEO_PID >> 8) as u8,
        VIDEO_PID as u8,
        0x21,
        183,
        0x80,
    ];
    let mut packet = vec![0xff; 188];
    packet[..marker.len()].copy_from_slice(&marker);
    stream.splice(4 * 188..4 * 188, packet);

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes the marked PES");
    packets.extend(demuxer.finish().expect("flushes both PES packets"));
    let video: Vec<_> = packets
        .iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .collect();

    assert_eq!(video.len(), 2);
    assert_eq!(video[0].data, first);
    assert_eq!(video[1].data, second);
    assert!(!video[1].damaged_previous_pes);
    assert_eq!(demuxer.dropped(), 0);
}

#[test]
fn discards_an_open_video_pes_after_loss_following_an_adaptation_only_discontinuity() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    // An adaptation-only marker anchors the next expected counter, so losing
    // the first payload after it proves that the open PES was cut.
    let first = vec![0xaa; 700];
    let second = vec![0xbb; 32];
    let mut stream = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: Some(90_000),
                payload: &first,
            },
            PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                pts: Some(93_000),
                payload: &second,
            },
        ],
        &mut HashMap::new(),
    );
    let mut marker = vec![0xff; 188];
    marker[..6].copy_from_slice(&[
        0x47,
        (VIDEO_PID >> 8) as u8,
        VIDEO_PID as u8,
        0x20,
        183,
        0x80,
    ]);
    // Replacing the first continuation packet models loss immediately after
    // the marker while leaving no received counter from which to prove it.
    stream.splice(3 * 188..4 * 188, marker);

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes around the hole");
    packets.extend(demuxer.finish().expect("flushes the replacement"));
    let video: Vec<_> = packets
        .iter()
        .filter(|packet| packet.kind == ElementaryKind::Video)
        .collect();

    assert_eq!(video.len(), 1);
    assert_eq!(video[0].data, second);
    assert!(video[0].damaged_previous_pes);
}

#[test]
fn ignores_a_retransmitted_payload_discontinuity_marker() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    // Repeating the marker packet repeats payload already accepted into the
    // new continuity run, so the marker changes state only on its first arrival.
    let payload = vec![0xaa; 400];
    let mut marked = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[PesUnit {
            pid: VIDEO_PID,
            stream_id: 0xe0,
            pts: Some(90_000),
            payload: &payload,
        }],
        &mut HashMap::new(),
    );
    marked[2 * 188 + 3] = 0x30;
    marked.copy_within(2 * 188 + 4..2 * 188 + 186, 2 * 188 + 6);
    marked[2 * 188 + 4] = 1;
    marked[2 * 188 + 5] = 0x80;
    let mut repeated = marked.clone();
    let marker = repeated[2 * 188..3 * 188].to_vec();
    repeated.splice(3 * 188..3 * 188, marker);

    let demux = |stream: &[u8]| {
        let mut demuxer = MpegTsAvDemuxer::new();
        let mut packets = demuxer.push(stream).expect("demuxes the marked PES");
        packets.extend(demuxer.finish().expect("flushes the marked PES"));
        packets
            .into_iter()
            .find(|packet| packet.kind == ElementaryKind::Video)
            .expect("one video PES")
            .data
    };

    assert_eq!(demux(&repeated), demux(&marked));
}

#[test]
fn carries_an_adaptation_only_discontinuity_to_the_next_pes() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{
        mux_transport_stream, PesUnit, AUDIO_PID, STREAM_TYPE_AAC_ADTS, STREAM_TYPE_MPEG2_VIDEO,
        VIDEO_PID,
    };

    // Adaptation-only packets do not advance the continuity counter, but their
    // marker still separates stateful access-unit parsing across a clean join.
    let first = vec![0xaa; 32];
    let second = vec![0xbb; 32];
    let mut stream = mux_transport_stream(
        &[
            (VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO),
            (AUDIO_PID, STREAM_TYPE_AAC_ADTS),
        ],
        &[
            PesUnit {
                pid: AUDIO_PID,
                stream_id: 0xc0,
                pts: Some(90_000),
                payload: &first,
            },
            PesUnit {
                pid: AUDIO_PID,
                stream_id: 0xc0,
                pts: Some(93_000),
                payload: &second,
            },
        ],
        &mut HashMap::new(),
    );
    let mut marker = vec![0xff; 188];
    marker[..6].copy_from_slice(&[
        0x47,
        (AUDIO_PID >> 8) as u8,
        AUDIO_PID as u8,
        0x20,
        183,
        0x80,
    ]);
    stream.splice(3 * 188..3 * 188, marker);

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes the marker");
    packets.extend(demuxer.finish().expect("flushes both PES packets"));
    let audio: Vec<_> = packets
        .iter()
        .filter(|packet| packet.kind == ElementaryKind::Audio)
        .collect();

    assert_eq!(audio.len(), 2);
    assert_eq!(audio[0].data, first);
    assert_eq!(audio[1].data, second);
    assert!(audio[1].discontinuity);
}

#[test]
fn ignores_a_retransmitted_transport_packet() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    // The video PES spans three transport packets. Repeating its middle packet
    // must leave both the elementary payload and the loss count unchanged.
    let payload = vec![0xaa; 400];
    let mut stream = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[PesUnit {
            pid: VIDEO_PID,
            stream_id: 0xe0,
            pts: Some(90_000),
            payload: &payload,
        }],
        &mut HashMap::new(),
    );
    let duplicate = stream[3 * 188..4 * 188].to_vec();
    stream.splice(4 * 188..4 * 188, duplicate);

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes the retransmission");
    packets.extend(demuxer.finish().expect("flushes the video PES"));
    let video = packets
        .iter()
        .find(|packet| packet.kind == ElementaryKind::Video)
        .expect("one video PES");

    assert_eq!(video.data, payload);
    assert_eq!(demuxer.dropped(), 0);
}

#[test]
fn ignores_a_retransmitted_packet_after_another_pid() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{mux_transport_stream, PesUnit, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID};

    // Packet order is global while continuity is per PID. A packet from an
    // unrelated PID may sit between a payload and its retransmission without
    // changing which video payload was most recently accepted.
    let payload = vec![0xaa; 400];
    let mut stream = mux_transport_stream(
        &[(VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO)],
        &[PesUnit {
            pid: VIDEO_PID,
            stream_id: 0xe0,
            pts: Some(90_000),
            payload: &payload,
        }],
        &mut HashMap::new(),
    );
    let duplicate = stream[3 * 188..4 * 188].to_vec();
    let mut null_packet = vec![0xff; 188];
    null_packet[..4].copy_from_slice(&[0x47, 0x1f, 0xff, 0x10]);
    stream.splice(4 * 188..4 * 188, null_packet.into_iter().chain(duplicate));

    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&stream).expect("demuxes the retransmission");
    packets.extend(demuxer.finish().expect("flushes the video PES"));
    let video = packets
        .iter()
        .find(|packet| packet.kind == ElementaryKind::Video)
        .expect("one video PES");

    assert_eq!(video.data, payload);
    assert_eq!(demuxer.dropped(), 0);
}
