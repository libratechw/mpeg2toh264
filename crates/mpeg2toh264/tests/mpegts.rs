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
fn skips_a_packet_with_reserved_adaptation_field_control() {
    let es = read_fixture("ibbp.m2v");
    let mut ts = wrap_mpeg2_es_in_ts(&es, None);
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
    let tables = mux_programs(&[(101, 0x1f0, main), (102, 0x1f1, sub)], &[]);
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
    );
    let main_pes = mux_programs(
        &[(101, 0x1f0, main), (102, 0x1f1, sub)],
        &[PesUnit {
            pid: 0x100,
            stream_id: 0xe0,
            pts: Some(27000),
            payload: &[3],
        }],
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
    let streams = &[
        (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
        (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
        (
            0x120,
            STREAM_TYPE_PRIVATE_DATA,
            caption_component.as_slice(),
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
            // A following start flushes the first packet during push(), including
            // its continuation TS packet.
            PesUnit {
                pid: 0x120,
                stream_id: 0xbd,
                pts: None,
                payload: &[0x81],
            },
            PesUnit {
                pid: 0x120,
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

    let untimed_superimpose = packets
        .iter()
        .find(|packet| packet.kind == ElementaryKind::PrivateStream1 && packet.data == [0x81])
        .expect("untimed superimpose packet");
    assert_eq!(
        untimed_superimpose.pts,
        Some(135_000),
        "uses the accompanying audio PTS"
    );

    let private2 = packets
        .iter()
        .find(|packet| packet.kind == ElementaryKind::PrivateStream2)
        .expect("private_stream_2 packet");
    assert_eq!(private2.pid, 0x120);
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
    let ts = mux_transport_stream_with_descriptors(streams, &units);

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

/// Switching the sound during a live broadcast changes what is read from here
/// on and nothing else: the stream being left is not rewound, and the one being
/// joined is not caught up with. What must not happen is the two being run
/// together -- the tail of one stream's access unit followed by the head of
/// another's makes one belonging to neither, which a browser's audio decoder
/// refuses outright rather than concealing.
#[test]
fn changes_which_sound_stream_is_read_from_where_it_is_asked() {
    use mpeg2toh264::container::mpegts::{ElementaryKind, MpegTsAvDemuxer};
    use support::{
        mux_transport_stream_with_descriptors, PesUnit, STREAM_TYPE_AAC_ADTS,
        STREAM_TYPE_MPEG2_VIDEO,
    };

    const MAIN: u16 = 0x110;
    const SECOND: u16 = 0x111;
    let main_tag = [0x52, 0x01, 0x10];
    let second_tag = [0x52, 0x01, 0x11];
    let streams = &[
        (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
        (MAIN, STREAM_TYPE_AAC_ADTS, main_tag.as_slice()),
        (SECOND, STREAM_TYPE_AAC_ADTS, second_tag.as_slice()),
    ];
    // Long enough that a PES packet takes more than one transport packet, so
    // that a switch can be asked for in the middle of one.
    let sound = |fill: u8| vec![fill; 300];
    let (main_first, second_first) = (sound(0xa1), sound(0xb1));
    let (main_second, second_second) = (sound(0xa2), sound(0xb2));
    let ts = mux_transport_stream_with_descriptors(
        streams,
        &[
            PesUnit {
                pid: MAIN,
                stream_id: 0xc0,
                pts: Some(90_000),
                payload: &main_first,
            },
            PesUnit {
                pid: SECOND,
                stream_id: 0xc0,
                pts: Some(90_000),
                payload: &second_first,
            },
            PesUnit {
                pid: MAIN,
                stream_id: 0xc0,
                pts: Some(91_920),
                payload: &main_second,
            },
            PesUnit {
                pid: SECOND,
                stream_id: 0xc0,
                pts: Some(91_920),
                payload: &second_second,
            },
        ],
    );

    // Up to the middle of the second main-sound PES: its first transport packet
    // is in, and the one that finishes it is not.
    let cut = 188 * 7;
    let mut demuxer = MpegTsAvDemuxer::new();
    let mut packets = demuxer.push(&ts[..cut]).expect("demuxes");
    demuxer.select_audio(SECOND);
    packets.extend(demuxer.push(&ts[cut..]).expect("demuxes the rest"));
    packets.extend(demuxer.finish().expect("flushes"));

    let sound: Vec<(u16, u8, usize)> = packets
        .iter()
        .filter(|packet| packet.kind == ElementaryKind::Audio)
        .map(|packet| (packet.pid, packet.data[0], packet.data.len()))
        .collect();
    assert_eq!(
        sound,
        vec![(MAIN, 0xa1, 300), (MAIN, 0xa2, 170), (SECOND, 0xb2, 300)],
        "the main sound up to the switch, what had been gathered of it under \
         its own PID, and the second sound after it"
    );
    assert_eq!(demuxer.audio_pid(), Some(SECOND));
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
    let ts = mux_transport_stream_with_descriptors(streams, std::slice::from_ref(&video));

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
    let map = |streams: &[(u16, u8, &[u8])]| {
        mux_transport_stream_with_descriptors(streams, std::slice::from_ref(&video))
    };
    let both = map(&[
        (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
        (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
        (0x111, STREAM_TYPE_AAC_ADTS, &[][..]),
    ]);
    let one = map(&[
        (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
        (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
    ]);

    let mut demuxer = MpegTsAvDemuxer::new();
    demuxer.push(&both).expect("demuxes");
    demuxer.select_audio(0x111);
    demuxer.push(&both).expect("demuxes");
    assert_eq!(demuxer.audio_pid(), Some(0x111), "the sound that was picked");

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
    let with_sound = mux_transport_stream_with_descriptors(
        &[
            (0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..]),
            (0x110, STREAM_TYPE_AAC_ADTS, &[][..]),
        ],
        std::slice::from_ref(&video),
    );
    let silent = mux_transport_stream_with_descriptors(
        &[(0x100, STREAM_TYPE_MPEG2_VIDEO, &[][..])],
        std::slice::from_ref(&video),
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
