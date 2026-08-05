//! Minimal MPEG-TS demuxing for an MPEG-2 video elementary stream.

use std::collections::{HashMap, HashSet};

use crate::error::{bail, Result};

const TS_PACKET_SIZE: usize = 188;
const SYNC_BYTE: u8 = 0x47;
const STREAM_TYPE_MPEG2_VIDEO: u8 = 0x02;

struct TsPayload<'a> {
    pid: u16,
    payload_unit_start: bool,
    data: &'a [u8],
}

/// Find the first packet boundary, by requiring several sync bytes 188 apart.
fn sync_offset(data: &[u8]) -> Option<usize> {
    for offset in 0..TS_PACKET_SIZE.min(data.len()) {
        if data[offset] != SYNC_BYTE {
            continue;
        }
        let mut matches = 0;
        let mut at = offset;
        while at < data.len() && matches < 4 {
            if data[at] != SYNC_BYTE {
                break;
            }
            matches += 1;
            at += TS_PACKET_SIZE;
        }
        if matches >= 4.min((data.len() - offset) / TS_PACKET_SIZE) {
            return Some(offset);
        }
    }
    None
}

pub fn is_mpeg_transport_stream(data: &[u8]) -> bool {
    data.len() >= TS_PACKET_SIZE && sync_offset(data).is_some()
}

fn payload_at(data: &[u8], at: usize) -> Result<Option<TsPayload<'_>>> {
    if data[at] != SYNC_BYTE {
        bail!("MPEG-TS sync lost at byte {at}");
    }
    if data[at + 1] & 0x80 != 0 {
        bail!("MPEG-TS transport error at byte {at}");
    }
    let payload_unit_start = data[at + 1] & 0x40 != 0;
    let pid = (((data[at + 1] & 0x1f) as u16) << 8) | data[at + 2] as u16;
    let adaptation_control = (data[at + 3] >> 4) & 3;
    if adaptation_control == 0 {
        bail!("invalid adaptation_field_control at byte {at}");
    }
    if adaptation_control & 1 == 0 {
        return Ok(None);
    }
    let mut payload = at + 4;
    if adaptation_control & 2 != 0 {
        payload += 1 + data[payload] as usize;
    }
    let end = at + TS_PACKET_SIZE;
    if payload > end {
        bail!("invalid MPEG-TS adaptation field at byte {at}");
    }
    Ok(Some(TsPayload {
        pid,
        payload_unit_start,
        data: &data[payload..end],
    }))
}

/// Reassembles PSI sections, which are length-prefixed and may straddle packets.
#[derive(Default)]
struct SectionAssembler {
    bytes: Vec<u8>,
}

impl SectionAssembler {
    fn push(&mut self, payload: &[u8], payload_unit_start: bool, sections: &mut Vec<Vec<u8>>) {
        let mut at = 0;
        if payload_unit_start {
            if payload.is_empty() {
                return;
            }
            let pointer = payload[0] as usize;
            at = 1;
            if !self.bytes.is_empty() && pointer > 0 {
                let end = (at + pointer).min(payload.len());
                self.append(&payload[at..end], sections);
            }
            self.bytes.clear();
            at += pointer;
        }
        if at <= payload.len() {
            self.append(&payload[at..], sections);
        }
    }

    fn append(&mut self, data: &[u8], sections: &mut Vec<Vec<u8>>) {
        self.bytes.extend_from_slice(data);
        loop {
            if self.bytes.first() == Some(&0xff) {
                self.bytes.clear();
                return;
            }
            if self.bytes.len() < 3 {
                return;
            }
            let length = 3 + ((((self.bytes[1] & 0x0f) as usize) << 8) | self.bytes[2] as usize);
            if self.bytes.len() < length {
                return;
            }
            sections.push(self.bytes.drain(..length).collect());
        }
    }
}

/// The 33-bit presentation timestamp, in 90 kHz units, or `None` when the PES
/// packet carries none. It is spread over five bytes with a marker bit after
/// every group (clause 2.4.3.7).
#[allow(dead_code)]
fn pes_pts(packet: &[u8]) -> Option<u64> {
    if packet.len() < 14 || packet[6] & 0xc0 != 0x80 || packet[7] & 0x80 == 0 {
        return None;
    }
    Some(
        (((packet[9] >> 1) & 0x07) as u64) << 30
            | (packet[10] as u64) << 22
            | (((packet[11] >> 1) & 0x7f) as u64) << 15
            | (packet[12] as u64) << 7
            | (packet[13] >> 1) as u64,
    )
}

fn pes_payload(packet: &[u8]) -> Result<&[u8]> {
    if packet.len() < 9 || packet[0] != 0 || packet[1] != 0 || packet[2] != 1 {
        bail!("invalid MPEG-TS video PES start code");
    }
    let stream_id = packet[3];
    if !(0xe0..=0xef).contains(&stream_id) {
        bail!("unexpected video stream_id 0x{stream_id:02x}");
    }
    let pes_length = ((packet[4] as usize) << 8) | packet[5] as usize;
    let start = if packet[6] & 0xc0 == 0x80 {
        9 + packet[8] as usize
    } else {
        // MPEG-1 PES header form, retained for older transport streams.
        let mut start = 6;
        while packet.get(start) == Some(&0xff) {
            start += 1;
        }
        let Some(&first) = packet.get(start) else {
            bail!("truncated MPEG-1 PES header");
        };
        if first & 0xc0 == 0x40 {
            start += 2;
        }
        let Some(&marker) = packet.get(start) else {
            bail!("truncated MPEG-1 PES header");
        };
        match marker & 0xf0 {
            0x20 => start += 5,
            0x30 => start += 10,
            _ if marker == 0x0f => start += 1,
            _ => bail!("invalid MPEG-1 PES header"),
        }
        start
    };
    let end = if pes_length == 0 {
        packet.len()
    } else {
        packet.len().min(6 + pes_length)
    };
    if start > end {
        bail!("truncated MPEG-TS video PES header");
    }
    Ok(&packet[start..end])
}

/// Scan PAT and PMT sections, recording the PMT PIDs and the first MPEG-2 video
/// elementary stream PID they advertise.
fn scan_psi_section(section: &[u8], pid: u16, pmt_pids: &mut HashSet<u16>, video_pid: &mut i32) {
    if section.len() < 12 {
        return;
    }
    if pid == 0 && section[0] == 0x00 {
        let end = section.len() - 4;
        let mut i = 8;
        while i + 3 < end {
            let program = ((section[i] as u16) << 8) | section[i + 1] as u16;
            if program != 0 {
                pmt_pids.insert((((section[i + 2] & 0x1f) as u16) << 8) | section[i + 3] as u16);
            }
            i += 4;
        }
    } else if section[0] == 0x02 {
        let program_info_length = (((section[10] & 0x0f) as usize) << 8) | section[11] as usize;
        let end = section.len() - 4;
        let mut i = 12 + program_info_length;
        while i + 4 < end {
            let stream_type = section[i];
            let stream_pid = (((section[i + 1] & 0x1f) as u16) << 8) | section[i + 2] as u16;
            let info_length = (((section[i + 3] & 0x0f) as usize) << 8) | section[i + 4] as usize;
            if *video_pid < 0 && stream_type == STREAM_TYPE_MPEG2_VIDEO {
                *video_pid = stream_pid as i32;
            }
            i += 5 + info_length;
        }
    }
}

/// Extract the first ISO/IEC 13818-2 video stream advertised by PAT/PMT.
pub fn extract_mpeg2_video_es(data: &[u8]) -> Result<Vec<u8>> {
    let Some(first_packet) = sync_offset(data) else {
        bail!("input is not a 188-byte MPEG transport stream");
    };

    let mut pmt_pids: HashSet<u16> = HashSet::new();
    let mut video_pid: i32 = -1;
    let mut assemblers: HashMap<u16, SectionAssembler> = HashMap::new();
    let mut sections: Vec<Vec<u8>> = Vec::new();

    let mut at = first_packet;
    while at + TS_PACKET_SIZE <= data.len() {
        if let Some(packet) = payload_at(data, at)? {
            if packet.pid == 0 || pmt_pids.contains(&packet.pid) {
                let pid = packet.pid;
                sections.clear();
                assemblers.entry(pid).or_default().push(
                    packet.data,
                    packet.payload_unit_start,
                    &mut sections,
                );
                for section in &sections {
                    scan_psi_section(section, pid, &mut pmt_pids, &mut video_pid);
                }
            }
        }
        at += TS_PACKET_SIZE;
    }
    if pmt_pids.is_empty() {
        bail!("MPEG-TS PAT contains no program");
    }
    if video_pid < 0 {
        bail!("MPEG-TS contains no MPEG-2 video stream (stream_type 0x02)");
    }
    let video_pid = video_pid as u16;

    let mut elementary = Vec::new();
    let mut pes_parts: Vec<u8> = Vec::new();
    let mut saw_pes = false;
    let mut at = first_packet;
    while at + TS_PACKET_SIZE <= data.len() {
        if let Some(packet) = payload_at(data, at)? {
            if packet.pid == video_pid {
                if packet.payload_unit_start && !pes_parts.is_empty() {
                    elementary.extend_from_slice(pes_payload(&pes_parts)?);
                    saw_pes = true;
                    pes_parts.clear();
                }
                pes_parts.extend_from_slice(packet.data);
            }
        }
        at += TS_PACKET_SIZE;
    }
    if !pes_parts.is_empty() {
        elementary.extend_from_slice(pes_payload(&pes_parts)?);
        saw_pes = true;
    }
    if !saw_pes {
        bail!("MPEG-TS MPEG-2 video PID has no PES packets");
    }
    Ok(elementary)
}
