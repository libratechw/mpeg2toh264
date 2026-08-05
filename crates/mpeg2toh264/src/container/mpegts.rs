//! Minimal MPEG-TS demuxing for MPEG-2 video and AAC-LC audio.

use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;

use crate::error::{bail, Result};

const TS_PACKET_SIZE: usize = 188;
const SYNC_BYTE: u8 = 0x47;
const STREAM_TYPE_MPEG2_VIDEO: u8 = 0x02;
const STREAM_TYPE_AAC_ADTS: u8 = 0x0f;

/// Which elementary stream a packet belongs to. The two differ in the
/// `stream_id` range their PES headers may use (Table 2-22).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ElementaryKind {
    Video,
    Audio,
}

impl ElementaryKind {
    fn accepts_stream_id(self, stream_id: u8) -> bool {
        match self {
            Self::Video => (0xe0..=0xef).contains(&stream_id),
            Self::Audio => (0xc0..=0xdf).contains(&stream_id),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Audio => "audio",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ElementaryPacket {
    pub kind: ElementaryKind,
    pub data: Vec<u8>,
    /// The PES presentation timestamp in 90 kHz units, when one is present.
    /// Video and audio rarely start at the same timestamp in a broadcast
    /// stream, so this is what puts the two tracks on a common timeline.
    pub pts: Option<u64>,
}

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

/// The elementary stream PIDs a program advertises.
struct ProgramMap {
    pmt_pids: HashSet<u16>,
    /// Which service to take, when the caller has said. A recording can hold
    /// more than one -- a broadcaster's sub-channel rides in the same transport
    /// stream, with its own video and its own audio -- and without being told,
    /// whichever program map arrives first is the one that gets used.
    wanted_service: Option<u16>,
    /// The service the streams below were taken from, once one has been, and
    /// where it sits in the program association table.
    service: Option<u16>,
    rank: usize,
    video_pid: Option<u16>,
    audio_pid: Option<u16>,
    /// Every service seen in the program association table, in the order they
    /// were announced.
    services: Vec<u16>,
    /// Whether the streams may still be changed, which they may until the
    /// first of their packets has been handed on.
    may_switch_streams: bool,
    /// Set when a scan moved to a service with different streams, so that what
    /// was gathered from the old ones can be thrown away.
    changed_streams: bool,
    assemblers: HashMap<u16, SectionAssembler>,
}

impl Default for ProgramMap {
    fn default() -> Self {
        Self {
            pmt_pids: HashSet::new(),
            wanted_service: None,
            service: None,
            rank: usize::MAX,
            video_pid: None,
            audio_pid: None,
            services: Vec::new(),
            may_switch_streams: true,
            changed_streams: false,
            assemblers: HashMap::new(),
        }
    }
}

impl ProgramMap {
    fn wants(&self, pid: u16) -> bool {
        pid == 0 || self.pmt_pids.contains(&pid)
    }

    fn push(&mut self, packet: &TsPayload<'_>, sections: &mut Vec<Vec<u8>>) {
        sections.clear();
        self.assemblers.entry(packet.pid).or_default().push(
            packet.data,
            packet.payload_unit_start,
            sections,
        );
        for section in sections.iter() {
            self.scan(section, packet.pid);
        }
    }

    /// Scan a PAT or PMT section, recording the PMT PIDs and the first MPEG-2
    /// video and AAC elementary streams they advertise.
    fn scan(&mut self, section: &[u8], pid: u16) {
        if section.len() < 12 {
            return;
        }
        if pid == 0 && section[0] == 0x00 {
            let end = section.len() - 4;
            let mut i = 8;
            while i + 3 < end {
                let program = ((section[i] as u16) << 8) | section[i + 1] as u16;
                if program != 0 {
                    if !self.services.contains(&program) {
                        self.services.push(program);
                    }
                    self.pmt_pids
                        .insert((((section[i + 2] & 0x1f) as u16) << 8) | section[i + 3] as u16);
                }
                i += 4;
            }
        } else if section[0] == 0x02 {
            // The service this map describes, which is the table's own id
            // extension. Taking a stream from one service and a stream from
            // another would put a programme's picture against a different
            // programme's sound, so both come from here or neither does.
            let service = ((section[3] as u16) << 8) | section[4] as u16;
            if self.wanted_service.is_some_and(|wanted| wanted != service) {
                return;
            }
            // Which map arrives first is the multiplexer's business, and the
            // one in front is not always the programme anyone is watching: a
            // data service sits alongside the television it belongs to and can
            // be described first while naming the same streams. The order the
            // program association table announces its services in is the
            // broadcaster's own, so that is the order to prefer.
            let rank = self
                .services
                .iter()
                .position(|&announced| announced == service)
                .unwrap_or(usize::MAX);
            if self.service.is_some() && rank >= self.rank {
                return;
            }
            let program_info_length = (((section[10] & 0x0f) as usize) << 8) | section[11] as usize;
            let end = section.len() - 4;
            let mut i = 12 + program_info_length;
            let mut video = None;
            let mut audio = None;
            while i + 4 < end {
                let stream_type = section[i];
                let stream_pid = (((section[i + 1] & 0x1f) as u16) << 8) | section[i + 2] as u16;
                let info_length =
                    (((section[i + 3] & 0x0f) as usize) << 8) | section[i + 4] as usize;
                if video.is_none() && stream_type == STREAM_TYPE_MPEG2_VIDEO {
                    video = Some(stream_pid);
                }
                if audio.is_none() && stream_type == STREAM_TYPE_AAC_ADTS {
                    audio = Some(stream_pid);
                }
                i += 5 + info_length;
            }
            // A service with no picture in it is not the one being watched,
            // unless the caller named it.
            if video.is_none() && self.wanted_service.is_none() {
                return;
            }
            // Moving to a better-placed service is free while it names the
            // streams already being read -- which is what an accompanying data
            // service does -- and is only a matter of calling them by the right
            // name. Where it names different ones, the packets gathered so far
            // belong to the wrong programme and have to go, so it is only worth
            // doing before any of them have been handed on.
            let same_streams = self.video_pid == video && self.audio_pid == audio;
            if self.service.is_some() && !same_streams && !self.may_switch_streams {
                return;
            }
            self.changed_streams |= !same_streams && self.service.is_some();
            self.service = Some(service);
            self.rank = rank;
            self.video_pid = video;
            self.audio_pid = audio;
        }
    }
}

/// The 33-bit presentation timestamp, in 90 kHz units, or `None` when the PES
/// packet carries none. It is spread over five bytes with a marker bit after
/// every group (clause 2.4.3.7).
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

fn pes_payload(packet: &[u8], kind: ElementaryKind) -> Result<&[u8]> {
    if packet.len() < 9 || packet[0] != 0 || packet[1] != 0 || packet[2] != 1 {
        bail!("invalid MPEG-TS {} PES start code", kind.name());
    }
    let stream_id = packet[3];
    if !kind.accepts_stream_id(stream_id) {
        bail!("unexpected {} stream_id 0x{stream_id:02x}", kind.name());
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
        bail!("truncated MPEG-TS {} PES header", kind.name());
    }
    Ok(&packet[start..end])
}

/// Whether a packet payload opens a PES packet of the given kind. A payload
/// unit start on the right PID is not enough: broadcast streams interleave
/// other PES types on PIDs a PMT has already claimed.
fn is_pes_start(packet: &[u8], kind: ElementaryKind) -> bool {
    packet.len() >= 4
        && packet[0] == 0
        && packet[1] == 0
        && packet[2] == 1
        && kind.accepts_stream_id(packet[3])
}

/// One elementary stream's PES packet as it accumulates across TS packets.
#[derive(Default)]
struct PesState {
    parts: Vec<u8>,
    collecting: bool,
}

impl PesState {
    fn flush(&mut self, kind: ElementaryKind, output: &mut Vec<ElementaryPacket>) -> Result<()> {
        if self.parts.is_empty() {
            return Ok(());
        }
        let packet = std::mem::take(&mut self.parts);
        output.push(ElementaryPacket {
            kind,
            data: pes_payload(&packet, kind)?.to_vec(),
            pts: pes_pts(&packet),
        });
        self.collecting = false;
        Ok(())
    }
}

/// Stateful MPEG-2-video/AAC demuxer, for streaming a file through in bounded
/// memory rather than holding all of it.
#[derive(Default)]
pub struct MpegTsAvDemuxer {
    pending: Vec<u8>,
    synced: bool,
    program: ProgramMap,
    video: PesState,
    audio: PesState,
}

impl MpegTsAvDemuxer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take the streams of one named service rather than of whichever program
    /// map turns up first.
    pub fn for_service(service_id: Option<u16>) -> Self {
        Self {
            program: ProgramMap {
                wanted_service: service_id,
                ..ProgramMap::default()
            },
            ..Self::default()
        }
    }

    /// The service the streams being demuxed belong to, once a program map has
    /// named it.
    pub fn service_id(&self) -> Option<u16> {
        self.program.service
    }

    /// Every service the program association table has announced, in order.
    pub fn service_ids(&self) -> &[u16] {
        &self.program.services
    }

    /// Whether the program map has named an AAC-LC audio stream yet. The
    /// caller needs this to decide whether to hold video back waiting for
    /// audio that may never come.
    pub fn has_aac_audio(&self) -> bool {
        self.program.audio_pid.is_some()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<ElementaryPacket>> {
        self.pending.extend_from_slice(chunk);
        let input = std::mem::take(&mut self.pending);

        let mut at = 0;
        if !self.synced {
            match sync_offset(&input) {
                Some(offset) => {
                    at = offset;
                    self.synced = true;
                }
                None => {
                    self.pending = input;
                    return Ok(Vec::new());
                }
            }
        }

        let mut output = Vec::new();
        let mut sections = Vec::new();
        while at + TS_PACKET_SIZE <= input.len() {
            if let Some(packet) = payload_at(&input, at)? {
                if self.program.wants(packet.pid) {
                    self.program.push(&packet, &mut sections);
                    if std::mem::take(&mut self.program.changed_streams) {
                        // The streams belong to a different programme now, and
                        // what was gathered from the old ones is not the start
                        // of anything.
                        self.video = PesState::default();
                        self.audio = PesState::default();
                    }
                }
                let kind = if Some(packet.pid) == self.program.video_pid {
                    Some(ElementaryKind::Video)
                } else if Some(packet.pid) == self.program.audio_pid {
                    Some(ElementaryKind::Audio)
                } else {
                    None
                };
                if let Some(kind) = kind {
                    let state = match kind {
                        ElementaryKind::Video => &mut self.video,
                        ElementaryKind::Audio => &mut self.audio,
                    };
                    if packet.payload_unit_start {
                        state.flush(kind, &mut output)?;
                        state.collecting = is_pes_start(packet.data, kind);
                    }
                    if state.collecting {
                        state.parts.extend_from_slice(packet.data);
                    }
                    // Once a packet of these streams is on its way out, the
                    // choice of service is made: switching would splice one
                    // programme onto another.
                    if !output.is_empty() {
                        self.program.may_switch_streams = false;
                    }
                }
            }
            at += TS_PACKET_SIZE;
        }
        self.pending = input[at..].to_vec();
        Ok(output)
    }

    /// Flush whatever PES packets were still accumulating at end of input.
    pub fn finish(&mut self) -> Result<Vec<ElementaryPacket>> {
        if !self.synced {
            bail!("input is not a 188-byte MPEG transport stream");
        }
        if self.program.video_pid.is_none() {
            bail!("MPEG-TS contains no MPEG-2 video stream (stream_type 0x02)");
        }
        let mut output = Vec::new();
        self.video.flush(ElementaryKind::Video, &mut output)?;
        self.audio.flush(ElementaryKind::Audio, &mut output)?;
        Ok(output)
    }
}

/// Walk the presentation timestamps in a slice of transport stream, in 90 kHz
/// units, and hand each to `visit` until it says to stop.
///
/// A player reads these out of a slice taken from anywhere in a file, so this
/// reads the PES headers where they lie rather than following a PID: the slice
/// may open mid-packet, and a program map it happens to miss would leave a
/// PID-driven demuxer with nothing to report.
fn walk_pts(data: &[u8], mut visit: impl FnMut(u64) -> ControlFlow<()>) {
    let Some(mut at) = sync_offset(data) else {
        return;
    };
    while at + TS_PACKET_SIZE <= data.len() {
        // A payload the sync check walked past is worth stepping over rather
        // than giving up on: a slice is a fragment of a file, and one damaged
        // packet says nothing about the ones after it.
        if let Ok(Some(packet)) = payload_at(data, at) {
            if packet.payload_unit_start
                && (is_pes_start(packet.data, ElementaryKind::Video)
                    || is_pes_start(packet.data, ElementaryKind::Audio))
            {
                if let Some(pts) = pes_pts(packet.data) {
                    if visit(pts).is_break() {
                        return;
                    }
                }
            }
        }
        at += TS_PACKET_SIZE;
    }
}

/// The first presentation timestamp in a slice, or `None` when it holds none.
///
/// This is what time it is at the byte the slice was taken from, which is what
/// a player seeking by byte needs to know: a hundred kilobytes answers it,
/// where transcoding to find out costs seconds of video.
pub fn first_pts(data: &[u8]) -> Option<u64> {
    let mut first = None;
    walk_pts(data, |pts| {
        first = Some(pts);
        ControlFlow::Break(())
    });
    first
}

/// The last presentation timestamp in a slice, or `None` when it holds none.
/// Read from the end of a file, this is where the file ends.
pub fn last_pts(data: &[u8]) -> Option<u64> {
    let mut last = None;
    walk_pts(data, |pts| {
        last = Some(pts);
        ControlFlow::Continue(())
    });
    last
}

/// Extract the first ISO/IEC 13818-2 video stream advertised by PAT/PMT, from a
/// transport stream held whole in memory.
pub fn extract_mpeg2_video_es(data: &[u8]) -> Result<Vec<u8>> {
    let mut demuxer = MpegTsAvDemuxer::new();
    let mut elementary = Vec::new();
    let mut saw_video = false;
    for packet in demuxer.push(data)? {
        if packet.kind == ElementaryKind::Video {
            elementary.extend_from_slice(&packet.data);
            saw_video = true;
        }
    }
    if !demuxer.synced {
        bail!("input is not a 188-byte MPEG transport stream");
    }
    if demuxer.program.pmt_pids.is_empty() {
        bail!("MPEG-TS PAT contains no program");
    }
    for packet in demuxer.finish()? {
        if packet.kind == ElementaryKind::Video {
            elementary.extend_from_slice(&packet.data);
            saw_video = true;
        }
    }
    if !saw_video {
        bail!("MPEG-TS MPEG-2 video PID has no PES packets");
    }
    Ok(elementary)
}
