//! Shared helpers for the integration tests.
//!
//! Each test binary compiles the whole module, so not every helper is used by
//! every one of them.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;

const PACKET_SIZE: usize = 188;

pub fn testdata(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata")
        .join(name)
}

pub fn read_fixture(name: &str) -> Vec<u8> {
    std::fs::read(testdata(name)).expect("fixture is readable")
}

/// Every fixture, so a test can assert something across all of them.
pub const FIXTURES: [&str; 6] = [
    "altscan.m2v",
    "escape.m2v",
    "hd1080i.m2v",
    "i_only.m2v",
    "ibbp.m2v",
    "ip.m2v",
];

/// FNV-1a, so a golden test can pin a multi-megabyte bitstream without either a
/// dependency or a checked-in blob.
pub fn fnv1a(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in data {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn psi_packet(pid: u16, section: &[u8]) -> Vec<u8> {
    let mut packet = vec![0xff; PACKET_SIZE];
    packet[..5].copy_from_slice(&[
        0x47,
        0x40 | (pid >> 8) as u8,
        (pid & 0xff) as u8,
        0x10,
        0x00,
    ]);
    packet[5..5 + section.len()].copy_from_slice(section);
    packet
}

/// The five-byte PTS field of a PES header, clause 2.4.3.7.
fn pts_field(pts: u64) -> [u8; 5] {
    [
        0x21 | (((pts >> 30) & 0x07) as u8) << 1,
        ((pts >> 22) & 0xff) as u8,
        0x01 | (((pts >> 15) & 0x7f) as u8) << 1,
        ((pts >> 7) & 0xff) as u8,
        0x01 | ((pts & 0x7f) as u8) << 1,
    ]
}

/// Wrap an MPEG-2 elementary stream in a single-program transport stream, so the
/// demuxer can be exercised without a multi-megabyte broadcast capture.
pub fn wrap_mpeg2_es_in_ts(es: &[u8], pts: Option<u64>) -> Vec<u8> {
    let pat = psi_packet(
        0,
        &[
            0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00, 0, 0, 0, 0,
        ],
    );
    let pmt = psi_packet(
        0x100,
        &[
            0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, 0x02, 0xe1,
            0x01, 0xf0, 0x00, 0, 0, 0, 0,
        ],
    );

    let mut pes: Vec<u8> = match pts {
        None => vec![0, 0, 1, 0xe0, 0, 0, 0x80, 0, 0],
        Some(pts) => {
            let mut header = vec![0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5];
            header.extend_from_slice(&pts_field(pts));
            header
        }
    };
    pes.extend_from_slice(es);

    let mut out = pat;
    out.extend_from_slice(&pmt);
    let mut at = 0;
    let mut continuity: u8 = 0;
    while at < pes.len() {
        let size = 184.min(pes.len() - at);
        let mut packet = vec![0xff; PACKET_SIZE];
        let start = if at == 0 { 0x40 } else { 0x00 };
        if size == 184 {
            packet[..4].copy_from_slice(&[0x47, start | 0x01, 0x01, 0x10 | continuity]);
            packet[4..4 + size].copy_from_slice(&pes[at..at + size]);
        } else {
            let adaptation_length = 183 - size;
            packet[..5].copy_from_slice(&[
                0x47,
                start | 0x01,
                0x01,
                0x30 | continuity,
                adaptation_length as u8,
            ]);
            if adaptation_length > 0 {
                packet[5] = 0;
            }
            let payload = 5 + adaptation_length;
            packet[payload..payload + size].copy_from_slice(&pes[at..at + size]);
        }
        out.extend_from_slice(&packet);
        continuity = (continuity + 1) & 15;
        at += size;
    }
    out
}

/// Split an Annex B stream into `(nal_unit_type, payload)` pairs.
pub fn split_annex_b(data: &[u8]) -> Vec<(u8, &[u8])> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1 {
            starts.push(i + 4);
            i += 4;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (index, &start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).map_or(data.len(), |next| next - 4);
        out.push((data[start] & 0x1f, &data[start..end]));
    }
    out
}

/// One PES packet to place in a synthetic transport stream.
pub struct PesUnit<'a> {
    pub pid: u16,
    pub stream_id: u8,
    pub payload: &'a [u8],
    pub pts: Option<u64>,
}

/// Build a single-program transport stream from PES packets already in the
/// order they should appear. The caller decides how the tracks interleave,
/// which is what makes the audio arrive alongside the video rather than all at
/// the end.
///
/// `streams` names the elementary streams the PMT advertises, as
/// `(pid, stream_type)`.
pub fn mux_transport_stream(streams: &[(u16, u8)], units: &[PesUnit<'_>]) -> Vec<u8> {
    mux_programs(&[(1, 0x100, streams)], units)
}

/// One service of a transport stream: its program number, the PID its program
/// map rides on, and the elementary streams it advertises.
pub type Program<'a> = (u16, u16, &'a [(u16, u8)]);

/// As [`mux_transport_stream`], but for a transport stream carrying more than
/// one service.
///
/// The program association table announces them in the order given, and the
/// program maps go out in the opposite order. Which map a multiplexer sends
/// first says nothing about which service anyone is watching, and putting the
/// two orders at odds here is what keeps that from being assumed.
pub fn mux_programs(programs: &[Program<'_>], units: &[PesUnit<'_>]) -> Vec<u8> {
    let mut pat_section = vec![0x00, 0xb0, 0x00, 0x00, 0x01, 0xc1, 0x00, 0x00];
    for &(program, pmt_pid, _) in programs {
        pat_section.extend_from_slice(&[
            (program >> 8) as u8,
            (program & 0xff) as u8,
            0xe0 | (pmt_pid >> 8) as u8,
            (pmt_pid & 0xff) as u8,
        ]);
    }
    pat_section.extend_from_slice(&[0, 0, 0, 0]);
    pat_section[2] = (pat_section.len() - 3) as u8;
    let mut out = psi_packet(0, &pat_section);

    for &(program, pmt_pid, streams) in programs.iter().rev() {
        let pcr_pid = streams.first().map_or(0x100, |&(pid, _)| pid);
        let mut pmt_section = vec![
            0x02,
            0xb0,
            (13 + 5 * streams.len()) as u8,
            (program >> 8) as u8,
            (program & 0xff) as u8,
            0xc1,
            0x00,
            0x00,
            0xe0 | (pcr_pid >> 8) as u8,
            (pcr_pid & 0xff) as u8,
            0xf0,
            0x00,
        ];
        for &(pid, stream_type) in streams {
            pmt_section.extend_from_slice(&[
                stream_type,
                0xe0 | (pid >> 8) as u8,
                (pid & 0xff) as u8,
                0xf0,
                0x00,
            ]);
        }
        pmt_section.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&psi_packet(pmt_pid, &pmt_section));
    }
    mux_payloads(out, units)
}

fn mux_payloads(mut out: Vec<u8>, units: &[PesUnit<'_>]) -> Vec<u8> {
    let mut continuity: HashMap<u16, u8> = HashMap::new();
    for unit in units {
        let mut pes: Vec<u8> = if unit.stream_id == 0xbf {
            vec![0, 0, 1, unit.stream_id, 0, 0]
        } else {
            match unit.pts {
                None => vec![0, 0, 1, unit.stream_id, 0, 0, 0x80, 0, 0],
                Some(pts) => {
                    let mut header = vec![0, 0, 1, unit.stream_id, 0, 0, 0x80, 0x80, 5];
                    header.extend_from_slice(&pts_field(pts));
                    header
                }
            }
        };
        pes.extend_from_slice(unit.payload);

        let mut at = 0;
        while at < pes.len() {
            let size = 184.min(pes.len() - at);
            let mut packet = vec![0xff; PACKET_SIZE];
            let start = if at == 0 { 0x40 } else { 0x00 };
            let counter = continuity.entry(unit.pid).or_insert(0);
            if size == 184 {
                packet[..4].copy_from_slice(&[
                    0x47,
                    start | (unit.pid >> 8) as u8,
                    (unit.pid & 0xff) as u8,
                    0x10 | *counter,
                ]);
                packet[4..4 + size].copy_from_slice(&pes[at..at + size]);
            } else {
                let adaptation_length = 183 - size;
                packet[..5].copy_from_slice(&[
                    0x47,
                    start | (unit.pid >> 8) as u8,
                    (unit.pid & 0xff) as u8,
                    0x30 | *counter,
                    adaptation_length as u8,
                ]);
                if adaptation_length > 0 {
                    packet[5] = 0;
                }
                let payload = 5 + adaptation_length;
                packet[payload..payload + size].copy_from_slice(&pes[at..at + size]);
            }
            *counter = (*counter + 1) & 15;
            out.extend_from_slice(&packet);
            at += size;
        }
    }
    out
}

/// Synthesise one AAC-LC ADTS frame with a payload of `payload_len` bytes.
///
/// The payload is not valid AAC, which does not matter: nothing here decodes
/// it, and the point of the transcoder's audio path is that it never looks
/// inside.
pub fn adts_frame(sampling_frequency_index: u8, channel_count: u8, payload_len: usize) -> Vec<u8> {
    let frame_length = 7 + payload_len;
    let mut frame = vec![
        0xff,
        0xf1, // MPEG-4, layer 0, protection absent
        (1 << 6) | (sampling_frequency_index << 2) | ((channel_count >> 2) & 1),
        ((channel_count & 3) << 6) | ((frame_length >> 11) & 3) as u8,
        ((frame_length >> 3) & 0xff) as u8,
        (((frame_length & 7) << 5) | 0x1f) as u8,
        0xfc,
    ];
    frame.extend((0..payload_len).map(|i| (i % 251) as u8));
    if channel_count == 2 && payload_len != 0 {
        frame[7] |= 0x20; // Treat synthetic payloads as an opaque CPE.
    }
    frame
}

pub fn adts_frame_with_payload(
    sampling_frequency_index: u8,
    channel_count: u8,
    payload: &[u8],
) -> Vec<u8> {
    let mut frame = adts_frame(sampling_frequency_index, channel_count, payload.len());
    frame[7..].copy_from_slice(payload);
    frame
}

/// A run of identical ADTS frames, as one contiguous elementary stream.
pub fn adts_stream(frames: usize, sampling_frequency_index: u8, channel_count: u8) -> Vec<u8> {
    let mut out = Vec::new();
    for i in 0..frames {
        out.extend_from_slice(&adts_frame(
            sampling_frequency_index,
            channel_count,
            32 + i % 17,
        ));
    }
    out
}

pub const STREAM_TYPE_MPEG2_VIDEO: u8 = 0x02;
pub const STREAM_TYPE_PRIVATE_DATA: u8 = 0x06;
pub const STREAM_TYPE_AAC_ADTS: u8 = 0x0f;
pub const VIDEO_PID: u16 = 0x101;
pub const AUDIO_PID: u16 = 0x102;
