//! Minimal MPEG-TS demuxing for MPEG-2 video and AAC-LC audio.

use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;

use crate::error::{bail, Result};

const TS_PACKET_SIZE: usize = 188;
const SYNC_BYTE: u8 = 0x47;
const STREAM_TYPE_MPEG2_VIDEO: u8 = 0x02;
const STREAM_TYPE_AAC_ADTS: u8 = 0x0f;

/// The body of the first descriptor carrying this tag, without its own two
/// bytes of tag and length.
fn descriptor(descriptors: &[u8], tag: u8) -> Option<&[u8]> {
    let mut at = 0;
    while at + 2 <= descriptors.len() {
        let length = descriptors[at + 1] as usize;
        let end = at + 2 + length;
        if end > descriptors.len() {
            return None;
        }
        if descriptors[at] == tag {
            return Some(&descriptors[at + 2..end]);
        }
        at = end;
    }
    None
}

/// The component tag carried by an ARIB stream identifier descriptor.
fn component_tag(descriptors: &[u8]) -> Option<u8> {
    descriptor(descriptors, 0x52).and_then(|body| (body.len() == 1).then(|| body[0]))
}

/// One sound stream a service offers, as its program map describes it.
///
/// A broadcast that carries a second sound sends it as a stream of its own
/// beside the first, and says which is which in the descriptors rather than by
/// the order it lists them in. Everything here comes from the map: nothing has
/// to be demuxed, so a caller can offer the choice before a byte of either has
/// been read.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct AudioStream {
    pub pid: u16,
    /// The ARIB stream identifier's component tag. A broadcast names its main
    /// sound 0x10 and the ones beside it 0x11 upwards, which is the only thing
    /// that distinguishes them where the languages are the same.
    pub component_tag: Option<u8>,
    /// Whether the stream's two channels are two separate services rather than
    /// a stereo pair. Which of the two is played is not a choice about the
    /// stream but a choice inside it -- see [`crate::container::adts`].
    pub dual_mono: bool,
    /// The languages the descriptors name, in the order they name them. Dual
    /// mono carries the second service's language as a second entry, which is
    /// what a bilingual broadcast is announced as.
    pub languages: Vec<String>,
}

/// ISO 639 language codes are three ASCII letters. Anything else is a
/// descriptor that has been damaged or that this is not reading correctly, and
/// a label made of it would be worse than none.
fn language_code(code: &[u8]) -> Option<String> {
    code.iter()
        .all(|byte| byte.is_ascii_alphabetic())
        .then(|| String::from_utf8_lossy(code).to_ascii_lowercase())
}

impl AudioStream {
    /// Read what one stream's descriptors say about the sound in it.
    ///
    /// The ARIB audio component descriptor is the one that answers everything
    /// at once (STD-B10 part 2, 6.2.26): its `component_type` says how many
    /// channels there are and whether they are one service or two, and its
    /// language codes -- a second one when `ES_multi_lingual_flag` is set --
    /// name what a viewer would be choosing between. A stream that carries only
    /// the ISO 639 language descriptor still gets its language from there.
    fn from_descriptors(pid: u16, descriptors: &[u8]) -> Self {
        let mut stream = Self {
            pid,
            component_tag: component_tag(descriptors),
            ..Self::default()
        };
        if let Some(body) = descriptor(descriptors, 0xc4) {
            if body.len() >= 9 {
                // 1/0 + 1/0 mode: two mono services in one stream.
                stream.dual_mono = body[1] == 0x02;
                stream.component_tag = stream.component_tag.or(Some(body[2]));
                let multilingual = body[5] & 0x80 != 0;
                stream.languages.extend(language_code(&body[6..9]));
                if multilingual && body.len() >= 12 {
                    stream.languages.extend(language_code(&body[9..12]));
                }
            }
        }
        if stream.languages.is_empty() {
            if let Some(body) = descriptor(descriptors, 0x0a) {
                stream.languages.extend(
                    body.chunks_exact(4)
                        .filter_map(|entry| language_code(&entry[..3])),
                );
            }
        }
        stream
    }
}

fn select_private_streams(streams: Vec<(u16, Option<u8>)>) -> Vec<u16> {
    let caption = streams
        .iter()
        .find(|(_, tag)| matches!(tag, Some(0x30 | 0x87)))
        .or_else(|| {
            streams
                .iter()
                .find(|(_, tag)| matches!(tag, Some(0x30..=0x37 | 0x87)))
        })
        .map(|(pid, _)| *pid);
    let superimpose = streams
        .iter()
        .find(|(_, tag)| matches!(tag, Some(0x38 | 0x88)))
        .or_else(|| {
            streams
                .iter()
                .find(|(_, tag)| matches!(tag, Some(0x38..=0x3f | 0x88)))
        })
        .map(|(pid, _)| *pid);

    let mut selected = Vec::new();
    selected.extend(caption);
    selected.extend(superimpose);
    selected
}

#[cfg(test)]
mod private_stream_tests {
    use super::select_private_streams;

    #[test]
    fn prefers_default_caption_and_superimpose_component_tags() {
        let streams = vec![
            (0x131, Some(0x31)),
            (0x139, Some(0x39)),
            (0x130, Some(0x30)),
            (0x138, Some(0x38)),
        ];
        assert_eq!(select_private_streams(streams), [0x130, 0x138]);
    }

    #[test]
    fn falls_back_to_the_first_component_of_each_kind() {
        let streams = vec![
            (0x132, Some(0x32)),
            (0x131, Some(0x31)),
            (0x13a, Some(0x3a)),
            (0x139, Some(0x39)),
        ];
        assert_eq!(select_private_streams(streams), [0x132, 0x13a]);
    }

    #[test]
    fn ignores_private_data_without_a_caption_or_superimpose_tag() {
        let streams = vec![(0x120, None), (0x121, Some(0x40))];
        assert!(select_private_streams(streams).is_empty());
    }
}

/// Which elementary stream a packet belongs to. The two differ in the
/// `stream_id` range their PES headers may use (Table 2-22).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ElementaryKind {
    Video,
    Audio,
    PrivateStream1,
    PrivateStream2,
}

impl ElementaryKind {
    fn accepts_stream_id(self, stream_id: u8) -> bool {
        match self {
            Self::Video => (0xe0..=0xef).contains(&stream_id),
            Self::Audio => (0xc0..=0xdf).contains(&stream_id),
            Self::PrivateStream1 => stream_id == 0xbd,
            Self::PrivateStream2 => stream_id == 0xbf,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Audio => "audio",
            Self::PrivateStream1 => "private_stream_1",
            Self::PrivateStream2 => "private_stream_2",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ElementaryPacket {
    pub kind: ElementaryKind,
    pub pid: u16,
    pub data: Vec<u8>,
    /// The PES presentation timestamp in 90 kHz units, when one is present.
    /// Video and audio rarely start at the same timestamp in a broadcast
    /// stream, so this is what puts the two tracks on a common timeline.
    pub pts: Option<u64>,
}

struct TsPayload<'a> {
    pid: u16,
    payload_unit_start: bool,
    continuity_counter: u8,
    discontinuity: bool,
    scrambled: bool,
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
    let scrambled = data[at + 3] >> 6 != 0;
    let continuity_counter = data[at + 3] & 0x0f;
    let pid = (((data[at + 1] & 0x1f) as u16) << 8) | data[at + 2] as u16;
    let adaptation_control = (data[at + 3] >> 4) & 3;
    if adaptation_control == 0 {
        bail!("invalid adaptation_field_control at byte {at}");
    }
    if adaptation_control & 1 == 0 {
        return Ok(None);
    }
    let mut payload = at + 4;
    let mut discontinuity = false;
    if adaptation_control & 2 != 0 {
        if payload + 1 < at + TS_PACKET_SIZE {
            discontinuity = data[payload + 1] & 0x80 != 0;
        }
        payload += 1 + data[payload] as usize;
    }
    let end = at + TS_PACKET_SIZE;
    if payload > end {
        bail!("invalid MPEG-TS adaptation field at byte {at}");
    }
    Ok(Some(TsPayload {
        pid,
        payload_unit_start,
        continuity_counter,
        discontinuity,
        scrambled,
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

struct DeferredProgram {
    service: u16,
    rank: usize,
    video: Option<u16>,
    audio: Option<u16>,
    audio_streams: Vec<AudioStream>,
    private: Vec<u16>,
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
    /// Best playable map seen while waiting for the PAT's first service. It is
    /// only a fallback for the case where that first service has no picture.
    deferred: Option<DeferredProgram>,
    /// Services whose program maps have been read. PMTs may arrive in a
    /// different order from the PAT, so a playable service is not selected
    /// until every service announced ahead of it has been inspected.
    inspected_services: HashSet<u16>,
    /// PAT sections already read, used to distinguish another section of a
    /// large PAT from the next transmission of the same section.
    seen_pat_sections: HashSet<(u16, u8, u8)>,
    video_pid: Option<u16>,
    audio_pid: Option<u16>,
    /// Which sound the caller has asked for. It is a choice about the service
    /// rather than about one program map, so it survives a map that does not
    /// offer it -- a station that moves its streams still owes the viewer the
    /// sound they picked once it names it again.
    wanted_audio: Option<u16>,
    /// Every sound stream the chosen service's map advertises, in the order it
    /// lists them.
    audio_streams: Vec<AudioStream>,
    private_pids: Vec<u16>,
    /// Every service seen in the program association table, in the order they
    /// were announced.
    services: Vec<u16>,
    /// Whether the streams may still be changed, which they may until the
    /// first of their packets has been handed on.
    may_switch_streams: bool,
    /// Set when a scan moved to a service with different streams, so that what
    /// was gathered from the old ones can be thrown away.
    changed_streams: bool,
    /// Set when the service being read moved its own streams to other PIDs.
    /// What was gathered from the old ones is the end of the same programme,
    /// so it goes out rather than being thrown away.
    moved_streams: bool,
    all_service_pids: HashMap<u16, Vec<u16>>,
    changed_pids: HashSet<u16>,
    assemblers: HashMap<u16, SectionAssembler>,
}

impl Default for ProgramMap {
    fn default() -> Self {
        Self {
            pmt_pids: HashSet::new(),
            wanted_service: None,
            service: None,
            rank: usize::MAX,
            deferred: None,
            inspected_services: HashSet::new(),
            seen_pat_sections: HashSet::new(),
            video_pid: None,
            audio_pid: None,
            wanted_audio: None,
            audio_streams: Vec::new(),
            private_pids: Vec::new(),
            services: Vec::new(),
            may_switch_streams: true,
            changed_streams: false,
            moved_streams: false,
            all_service_pids: HashMap::new(),
            changed_pids: HashSet::new(),
            assemblers: HashMap::new(),
        }
    }
}

impl ProgramMap {
    fn activate_deferred(&mut self) {
        if let Some(deferred) = self.deferred.take() {
            self.service = Some(deferred.service);
            self.rank = deferred.rank;
            self.video_pid = deferred.video;
            self.audio_pid = deferred.audio;
            self.audio_streams = deferred.audio_streams;
            self.private_pids = deferred.private;
        }
    }

    fn wants(&self, pid: u16) -> bool {
        pid == 0 || self.pmt_pids.contains(&pid)
    }

    fn push(&mut self, packet: &TsPayload<'_>, sections: &mut Vec<Vec<u8>>) -> Vec<u16> {
        sections.clear();
        self.assemblers.entry(packet.pid).or_default().push(
            packet.data,
            packet.payload_unit_start,
            sections,
        );
        for section in sections.iter() {
            self.scan(section, packet.pid);
        }
        self.changed_pids.drain().collect()
    }

    /// Scan a PAT or PMT section, recording the PMT PIDs and the first MPEG-2
    /// video and AAC elementary streams they advertise.
    fn scan(&mut self, section: &[u8], pid: u16) {
        if section.len() < 12 {
            return;
        }
        if pid == 0 && section[0] == 0x00 {
            // A service can remain in the PAT after its PMT has disappeared.
            // Once the PAT repeats after a playable candidate was seen, the
            // absent earlier map must not leave that candidate waiting forever.
            let transport_stream_id = ((section[3] as u16) << 8) | section[4] as u16;
            let version = (section[5] >> 1) & 0x1f;
            let repeated_pat =
                !self
                    .seen_pat_sections
                    .insert((transport_stream_id, version, section[6]));
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
            if repeated_pat && self.service.is_none() && self.deferred.is_some() {
                self.activate_deferred();
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
            // A map from the service already chosen is not a competitor to be
            // ranked against it: it is that service saying what it is made of
            // now, which is how a station announces that its picture has moved
            // to another elementary stream.
            if self.service.is_some() && rank >= self.rank && self.service != Some(service) {
                return;
            }
            let program_info_length = (((section[10] & 0x0f) as usize) << 8) | section[11] as usize;
            let end = section.len() - 4;
            let mut i = 12 + program_info_length;
            let mut video = None;
            let mut audio_streams: Vec<AudioStream> = Vec::new();
            let mut private = Vec::new();
            let mut all_pids = Vec::new();
            while i + 4 < end {
                let stream_type = section[i];
                let stream_pid = (((section[i + 1] & 0x1f) as u16) << 8) | section[i + 2] as u16;
                all_pids.push(stream_pid);
                let info_length =
                    (((section[i + 3] & 0x0f) as usize) << 8) | section[i + 4] as usize;
                let info_start = i + 5;
                let info_end = info_start + info_length;
                if info_end > end {
                    break;
                }
                let descriptors = &section[info_start..info_end];
                let tag = component_tag(descriptors);
                if video.is_none() && stream_type == STREAM_TYPE_MPEG2_VIDEO {
                    video = Some(stream_pid);
                }
                if stream_type == STREAM_TYPE_AAC_ADTS {
                    audio_streams.push(AudioStream::from_descriptors(stream_pid, descriptors));
                }
                if stream_type == 0x06 {
                    private.push((stream_pid, tag));
                }
                i += 5 + info_length;
            }
            // The sound the caller picked, while this map still carries it, and
            // otherwise the one the broadcast puts first.
            let audio = self
                .wanted_audio
                .filter(|wanted| audio_streams.iter().any(|stream| stream.pid == *wanted))
                .or_else(|| audio_streams.first().map(|stream| stream.pid));
            let private = select_private_streams(private);
            all_pids.sort_unstable();
            all_pids.dedup();
            let old = self
                .all_service_pids
                .insert(service, all_pids.clone())
                .unwrap_or_default();
            for pid in old.iter().chain(all_pids.iter()) {
                if old.contains(pid) != all_pids.contains(pid) {
                    self.changed_pids.insert(*pid);
                }
            }
            self.inspected_services.insert(service);
            // A service with no picture in it is not the one being watched,
            // unless the caller named it.
            if video.is_none() && self.wanted_service.is_none() {
                // A playable service encountered ahead of this PMT may now be
                // used if every service before it has also proved empty.
                let deferred_is_ready = self.deferred.as_ref().is_some_and(|deferred| {
                    self.services.get(..deferred.rank).is_some_and(|services| {
                        services
                            .iter()
                            .all(|service| self.inspected_services.contains(service))
                    })
                });
                if deferred_is_ready {
                    self.activate_deferred();
                }
                return;
            }
            // PMTs and PES packets are interleaved in real broadcasts. Do not
            // start emitting a lower-ranked programme merely because its PMT
            // arrived before the first programme's PMT; by the time that map
            // arrives, switching may already have been locked out.
            let preceding_services_inspected = self.services.get(..rank).is_some_and(|services| {
                services
                    .iter()
                    .all(|service| self.inspected_services.contains(service))
            });
            if self.wanted_service.is_none()
                && self.rank == usize::MAX
                && !preceding_services_inspected
            {
                if self
                    .deferred
                    .as_ref()
                    .is_none_or(|deferred| rank < deferred.rank)
                {
                    self.deferred = Some(DeferredProgram {
                        service,
                        rank,
                        video,
                        audio,
                        audio_streams,
                        private,
                    });
                }
                return;
            }
            // Moving to a better-placed service is free while it names the
            // streams already being read -- which is what an accompanying data
            // service does -- and is only a matter of calling them by the right
            // name. Where it names different ones, the packets gathered so far
            // belong to the wrong programme and have to go, so it is only worth
            // doing before any of them have been handed on.
            let same_streams =
                self.video_pid == video && self.audio_pid == audio && self.private_pids == private;
            // Unless the service saying so is the one being read. A station
            // that leaves a multi-channel block sends a new version of its own
            // program map naming different elementary PIDs -- in Japan the
            // standard-definition sub-channel's video gives way to the
            // high-definition one -- and that is the same programme carrying
            // on, not another one being spliced onto it. Refusing it stops the
            // video where the map changed. The lock is against being pulled
            // onto a *different* service once its packets have gone out, and
            // that is left alone.
            let continues_this_service = self.service == Some(service);
            if self.service.is_some()
                && !same_streams
                && !self.may_switch_streams
                && !continues_this_service
            {
                return;
            }
            if !same_streams && self.service.is_some() {
                if continues_this_service {
                    self.moved_streams = true;
                } else {
                    self.changed_streams = true;
                }
            }
            self.service = Some(service);
            self.rank = rank;
            self.video_pid = video;
            self.audio_pid = audio;
            self.audio_streams = audio_streams;
            self.private_pids = private;
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
    let start = if kind == ElementaryKind::PrivateStream2 {
        // private_stream_2 is one of the stream ids with no optional PES
        // header (ISO/IEC 13818-1 table 2-17).
        6
    } else if packet[6] & 0xc0 == 0x80 {
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
    /// Timestamp of the accompanying media when this private PES began.
    fallback_pts: Option<u64>,
}

impl PesState {
    fn flush(
        &mut self,
        kind: ElementaryKind,
        pid: u16,
        output: &mut Vec<ElementaryPacket>,
    ) -> Result<()> {
        if self.parts.is_empty() {
            return Ok(());
        }
        let packet = std::mem::take(&mut self.parts);
        let data = pes_payload(&packet, kind)?.to_vec();
        let pts = match kind {
            ElementaryKind::PrivateStream2 => self.fallback_pts,
            ElementaryKind::PrivateStream1 if data.first() == Some(&0x81) => {
                pes_pts(&packet).or(self.fallback_pts)
            }
            _ => pes_pts(&packet),
        };
        output.push(ElementaryPacket {
            kind,
            pid,
            data,
            pts,
        });
        self.collecting = false;
        self.fallback_pts = None;
        Ok(())
    }
}

/// A stream the programme has moved off but which is still sending.
///
/// A multiplexer does not cut the old stream where the program map changes: it
/// keeps sending for a fraction of a second, and the stream that replaces it
/// has not started yet. Everything in between is the programme, so it is read
/// until the new one's first packet -- a third of a second of picture and
/// sound, on the recording this was measured against. Its own PES state,
/// because the two can overlap in the multiplex and a shared one would
/// interleave them.
struct Superseded {
    pid: u16,
    state: PesState,
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
    /// The streams the programme has moved off, still being read; see
    /// [`Superseded`].
    superseded_video: Option<Superseded>,
    superseded_audio: Option<Superseded>,
    /// A sound stream the caller has asked to be read instead, which takes
    /// effect at the next packet boundary; see [`MpegTsAvDemuxer::select_audio`].
    audio_switch: Option<u16>,
    private: HashMap<u16, PesState>,
    video_pts: Option<u64>,
    audio_pts: Option<u64>,
    scrambled: u64,
    errors: u64,
    dropped: u64,
    continuity: HashMap<u16, u8>,
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

    /// Every sound stream the chosen service offers, in the order its program
    /// map lists them. Empty until that map arrives.
    pub fn audio_streams(&self) -> &[AudioStream] {
        &self.program.audio_streams
    }

    /// Which of them is being read.
    pub fn audio_pid(&self) -> Option<u16> {
        self.program.audio_pid
    }

    /// Read the sound from another of the service's streams from here on.
    ///
    /// A broadcast that carries a second sound carries both at once, so this
    /// changes only which one is taken: nothing already handed out is revisited,
    /// and the stream being left is not rewound. That is what a viewer pressing
    /// the button during a live broadcast is asking for, and it is all that can
    /// be offered anyway -- the fragments made from the old sound have been
    /// appended and are being played.
    ///
    /// The choice is remembered rather than applied to one map, so a station
    /// that moves its streams and names the same sound again keeps it. A PID
    /// this service does not offer is remembered too and does nothing until it
    /// does.
    pub fn select_audio(&mut self, pid: u16) {
        self.program.wanted_audio = Some(pid);
        if self.program.audio_pid == Some(pid) {
            self.audio_switch = None;
            return;
        }
        if self
            .program
            .audio_streams
            .iter()
            .any(|stream| stream.pid == pid)
        {
            self.audio_switch = Some(pid);
        }
    }

    /// Move to the sound stream [`Self::select_audio`] asked for, at a packet
    /// boundary rather than in the middle of one.
    ///
    /// What has been gathered from the stream being left goes out under its own
    /// PID, so that whoever is reading the access units sees where one stream
    /// ended and the next began. Joined instead, the two would make one access
    /// unit belonging to neither -- which a browser's audio decoder refuses
    /// outright rather than concealing, and that ends playback.
    fn take_audio_switch(&mut self, output: &mut Vec<ElementaryPacket>) -> Result<()> {
        let Some(pid) = self.audio_switch.take() else {
            return Ok(());
        };
        if let Some(mut old) = self.superseded_audio.take() {
            old.state
                .flush(ElementaryKind::Audio, old.pid, &mut *output)?;
        }
        if let Some(old) = self.program.audio_pid {
            self.audio.flush(ElementaryKind::Audio, old, &mut *output)?;
        }
        self.audio = PesState::default();
        self.program.audio_pid = Some(pid);
        self.audio_pts = None;
        Ok(())
    }

    /// ARIB character superimpose is timed by the accompanying audio PES, or
    /// by video when the service has no audio. Its own PES commonly has no PTS.
    fn superimpose_pts(&self) -> Option<u64> {
        if self.program.audio_pid.is_some() {
            self.audio_pts
        } else {
            self.video_pts
        }
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
        self.take_audio_switch(&mut output)?;
        let mut sections = Vec::new();
        while at + TS_PACKET_SIZE <= input.len() {
            match payload_at(&input, at) {
                Err(_) => {
                    self.errors += 1;
                }
                Ok(Some(packet)) if packet.scrambled => {
                    self.note_continuity(&packet);
                    self.scrambled += 1;
                }
                Ok(Some(packet)) => {
                    self.note_continuity(&packet);
                    if self.program.wants(packet.pid) {
                        // Which streams the programme was being read from, in
                        // case its map moves it to others: what is half
                        // gathered from these belongs to them and not to
                        // whatever the new PIDs carry.
                        let previous = (self.program.video_pid, self.program.audio_pid);
                        let changed_pids = self.program.push(&packet, &mut sections);
                        for pid in changed_pids {
                            self.continuity.remove(&pid);
                        }
                        if std::mem::take(&mut self.program.moved_streams) {
                            // The same programme, carried by other streams from
                            // here on. The old ones are still sending, and what
                            // they send until the new ones start belongs to the
                            // programme too, so they are read on until then --
                            // with what has been gathered from them so far.
                            if previous.0 != self.program.video_pid {
                                self.superseded_video = previous.0.map(|pid| Superseded {
                                    pid,
                                    state: std::mem::take(&mut self.video),
                                });
                            }
                            if previous.1 != self.program.audio_pid {
                                self.superseded_audio = previous.1.map(|pid| Superseded {
                                    pid,
                                    state: std::mem::take(&mut self.audio),
                                });
                            }
                            for (pid, state) in self.private.iter_mut() {
                                if self.program.private_pids.contains(pid) {
                                    continue;
                                }
                                // Which of the two private streams this is, read
                                // where the ordinary path reads it: out of the
                                // PES header already gathered.
                                let kind = match state.parts.get(3) {
                                    Some(0xbf) => ElementaryKind::PrivateStream2,
                                    _ => ElementaryKind::PrivateStream1,
                                };
                                state.flush(kind, *pid, &mut output)?;
                            }
                            self.private
                                .retain(|pid, _| self.program.private_pids.contains(pid));
                            self.video_pts = None;
                            self.audio_pts = None;
                        }
                        if std::mem::take(&mut self.program.changed_streams) {
                            // The streams belong to a different programme now, and
                            // what was gathered from the old ones is not the start
                            // of anything.
                            self.video = PesState::default();
                            self.audio = PesState::default();
                            self.private.clear();
                            self.video_pts = None;
                            self.audio_pts = None;
                        }
                    }
                    // Whether this packet belongs to a stream the programme has
                    // moved off, which is read into its own state until the one
                    // that replaced it starts.
                    let mut superseded = false;
                    let kind = if Some(packet.pid) == self.program.video_pid {
                        // The old stream's last access unit goes out in front of
                        // the new stream's first bytes, which is here.
                        if let Some(mut old) = self.superseded_video.take() {
                            old.state
                                .flush(ElementaryKind::Video, old.pid, &mut output)?;
                        }
                        Some(ElementaryKind::Video)
                    } else if Some(packet.pid) == self.program.audio_pid {
                        if let Some(mut old) = self.superseded_audio.take() {
                            old.state
                                .flush(ElementaryKind::Audio, old.pid, &mut output)?;
                        }
                        Some(ElementaryKind::Audio)
                    } else if self
                        .superseded_video
                        .as_ref()
                        .is_some_and(|old| old.pid == packet.pid)
                    {
                        superseded = true;
                        Some(ElementaryKind::Video)
                    } else if self
                        .superseded_audio
                        .as_ref()
                        .is_some_and(|old| old.pid == packet.pid)
                    {
                        superseded = true;
                        Some(ElementaryKind::Audio)
                    } else if self.program.private_pids.contains(&packet.pid) {
                        let stream_id = if packet.payload_unit_start {
                            packet.data.get(3)
                        } else {
                            self.private
                                .get(&packet.pid)
                                .and_then(|state| state.parts.get(3))
                        };
                        stream_id.and_then(|stream_id| match stream_id {
                            0xbd => Some(ElementaryKind::PrivateStream1),
                            0xbf => Some(ElementaryKind::PrivateStream2),
                            _ => None,
                        })
                    } else {
                        None
                    };
                    if let Some(kind) = kind {
                        if packet.payload_unit_start {
                            match kind {
                                ElementaryKind::Video => {
                                    if let Some(pts) = pes_pts(packet.data) {
                                        self.video_pts = Some(pts);
                                    }
                                }
                                ElementaryKind::Audio => {
                                    if let Some(pts) = pes_pts(packet.data) {
                                        self.audio_pts = Some(pts);
                                    }
                                }
                                _ => {}
                            }
                        }
                        let superimpose_pts = self.superimpose_pts();
                        let state = match (kind, superseded) {
                            (ElementaryKind::Video, false) => &mut self.video,
                            (ElementaryKind::Audio, false) => &mut self.audio,
                            (ElementaryKind::Video, true) => {
                                &mut self.superseded_video.as_mut().expect("just matched").state
                            }
                            (ElementaryKind::Audio, true) => {
                                &mut self.superseded_audio.as_mut().expect("just matched").state
                            }
                            (
                                ElementaryKind::PrivateStream1 | ElementaryKind::PrivateStream2,
                                _,
                            ) => self.private.entry(packet.pid).or_default(),
                        };
                        if packet.payload_unit_start {
                            let previous_kind = match state.parts.get(3) {
                                Some(0xbd) => ElementaryKind::PrivateStream1,
                                Some(0xbf) => ElementaryKind::PrivateStream2,
                                _ => kind,
                            };
                            state.flush(previous_kind, packet.pid, &mut output)?;
                            state.collecting = is_pes_start(packet.data, kind);
                            if matches!(
                                kind,
                                ElementaryKind::PrivateStream1 | ElementaryKind::PrivateStream2
                            ) {
                                state.fallback_pts = superimpose_pts;
                            }
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
                Ok(None) => {}
            }
            at += TS_PACKET_SIZE;
        }
        self.pending = input[at..].to_vec();
        Ok(output)
    }

    pub fn scrambled(&self) -> u64 {
        self.scrambled
    }
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
    fn note_continuity(&mut self, packet: &TsPayload<'_>) {
        if packet.discontinuity {
            self.continuity.remove(&packet.pid);
            return;
        }
        if let Some(previous) = self
            .continuity
            .insert(packet.pid, packet.continuity_counter)
        {
            let expected = (previous + 1) & 0x0f;
            if packet.continuity_counter != expected {
                self.dropped += (packet.continuity_counter as u16 + 16 - expected as u16) as u64;
            }
        }
    }
    pub fn errors(&self) -> u64 {
        self.errors
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
        // A stream the programme moved off, which the input ended before the
        // one that replaced it started, still holds the end of the programme.
        if let Some(mut old) = self.superseded_video.take() {
            old.state
                .flush(ElementaryKind::Video, old.pid, &mut output)?;
        }
        if let Some(mut old) = self.superseded_audio.take() {
            old.state
                .flush(ElementaryKind::Audio, old.pid, &mut output)?;
        }
        self.video.flush(
            ElementaryKind::Video,
            self.program.video_pid.unwrap_or(0),
            &mut output,
        )?;
        self.audio.flush(
            ElementaryKind::Audio,
            self.program.audio_pid.unwrap_or(0),
            &mut output,
        )?;
        for (&pid, state) in self.private.iter_mut() {
            let kind = match state.parts.get(3) {
                Some(0xbd) => ElementaryKind::PrivateStream1,
                Some(0xbf) => ElementaryKind::PrivateStream2,
                _ => continue,
            };
            state.flush(kind, pid, &mut output)?;
        }
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
