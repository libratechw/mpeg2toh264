//! Shared helpers for the integration tests.
//!
//! Each test binary compiles the whole module, so not every helper is used by
//! every one of them.
#![allow(dead_code)]

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
