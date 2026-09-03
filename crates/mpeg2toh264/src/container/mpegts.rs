//! Minimal MPEG-TS demuxing for MPEG-2 video and AAC-LC audio.

use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;

use crate::error::{bail, Result};

const TS_PACKET_SIZE: usize = 188;
const SYNC_BYTE: u8 = 0x47;
const STREAM_TYPE_MPEG2_VIDEO: u8 = 0x02;
const STREAM_TYPE_AAC_ADTS: u8 = 0x0f;
const MIN_SYNC_COUNT: usize = 6;

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

fn select_private_streams(streams: Vec<(u16, Option<u8>)>) -> Vec<PrivateStream> {
    let caption = streams
        .iter()
        .find(|(_, tag)| matches!(tag, Some(0x30 | 0x87)))
        .or_else(|| {
            streams
                .iter()
                .find(|(_, tag)| matches!(tag, Some(0x30..=0x37 | 0x87)))
        })
        .map(|(pid, _)| PrivateStream {
            is_async: false,
            pid: *pid,
        });
    let superimpose = streams
        .iter()
        .find(|(_, tag)| matches!(tag, Some(0x38 | 0x88)))
        .or_else(|| {
            streams
                .iter()
                .find(|(_, tag)| matches!(tag, Some(0x38..=0x3f | 0x88)))
        })
        .map(|(pid, _)| PrivateStream {
            is_async: true,
            pid: *pid,
        });

    let mut selected = Vec::new();
    selected.extend(caption);
    selected.extend(superimpose);
    selected
}

#[cfg(test)]
mod private_stream_tests {
    use super::select_private_streams;
    use super::PrivateStream;

    #[test]
    fn prefers_default_caption_and_superimpose_component_tags() {
        let streams = vec![
            (0x131, Some(0x31)),
            (0x139, Some(0x39)),
            (0x130, Some(0x30)),
            (0x138, Some(0x38)),
        ];
        assert_eq!(
            select_private_streams(streams),
            [
                PrivateStream {
                    is_async: false,
                    pid: 0x130
                },
                PrivateStream {
                    is_async: true,
                    pid: 0x138
                }
            ]
        );
    }

    #[test]
    fn falls_back_to_the_first_component_of_each_kind() {
        let streams = vec![
            (0x132, Some(0x32)),
            (0x131, Some(0x31)),
            (0x13a, Some(0x3a)),
            (0x139, Some(0x39)),
        ];
        assert_eq!(
            select_private_streams(streams),
            [
                PrivateStream {
                    is_async: false,
                    pid: 0x132
                },
                PrivateStream {
                    is_async: true,
                    pid: 0x13a
                }
            ]
        );
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
    /// Bytes belonging to this elementary stream were lost before this PES.
    /// Stateful parsers discard unfinished access units before reading it.
    pub discontinuity: bool,
    /// The preceding PES itself lost bytes, so video parsing also discards the
    /// unfinished GOP before reading this packet.
    pub damaged_previous_pes: bool,
    /// Earliest recent program-table packet a new demuxer for the same service
    /// can start at and still discover this PES packet's PID.
    pub restart_offset: Option<u64>,
}

struct TsPayload<'a> {
    source_offset: u64,
    pid: u16,
    transport_error_indicator: bool,
    has_payload: bool,
    payload_unit_start: bool,
    continuity_counter: u8,
    discontinuity: bool,
    scrambled: bool,
    data: &'a [u8],
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ContinuityChange {
    None,
    /// A retransmitted packet repeats the preceding accepted payload.
    Duplicate,
    /// A discontinuity marker opened a new time base.
    Reset,
    /// The continuity counter proves that transport packets were lost.
    Loss,
}

#[derive(Default)]
struct ContinuityState {
    counter: u8,
    payload_unit_start: bool,
    scrambled: bool,
    data: Vec<u8>,
    /// Whether this payload entered a PSI assembler or elementary PES state.
    accepted: bool,
}

impl ContinuityState {
    /// Retain accepted bytes so a later retransmission can be distinguished
    /// from different data that reused the same continuity counter.
    fn from_packet(packet: &TsPayload<'_>, accepted: bool, previous: Option<Self>) -> Self {
        let mut state = previous.unwrap_or_default();
        state.counter = packet.continuity_counter;
        state.payload_unit_start = packet.payload_unit_start;
        state.scrambled = packet.scrambled;
        state.data.clear();
        if accepted {
            state.data.extend_from_slice(packet.data);
        }
        state.accepted = accepted;
        state
    }

    fn is_duplicate(&self, packet: &TsPayload<'_>) -> bool {
        self.counter == packet.continuity_counter
            && self.payload_unit_start == packet.payload_unit_start
            && self.scrambled == packet.scrambled
            && self.data == packet.data
    }
}

/// Find the first packet boundary, by requiring several sync bytes 188 apart.
fn sync_offset(data: &[u8], min_sync_count: usize) -> Option<usize> {
    for offset in 0..TS_PACKET_SIZE.min(data.len()) {
        let mut matches = 0;
        let mut at = offset;
        while at < data.len() && matches < min_sync_count {
            if data[at] != SYNC_BYTE {
                break;
            }
            matches += 1;
            at += TS_PACKET_SIZE;
        }
        if matches >= min_sync_count {
            return Some(offset);
        }
    }
    None
}

pub fn is_mpeg_transport_stream(data: &[u8]) -> bool {
    data.len() >= TS_PACKET_SIZE * MIN_SYNC_COUNT && sync_offset(data, MIN_SYNC_COUNT).is_some()
}

fn payload_at(data: &[u8], at: usize, source_offset: u64) -> Option<TsPayload<'_>> {
    if data[at] != SYNC_BYTE {
        return None;
    }
    let transport_error_indicator = data[at + 1] & 0x80 != 0;
    let payload_unit_start = data[at + 1] & 0x40 != 0;
    let scrambled = data[at + 3] >> 6 != 0;
    let continuity_counter = data[at + 3] & 0x0f;
    let pid = (((data[at + 1] & 0x1f) as u16) << 8) | data[at + 2] as u16;
    let adaptation_control = (data[at + 3] >> 4) & 3;
    if adaptation_control == 0 {
        return None;
    }
    let has_payload = adaptation_control & 1 != 0;
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
        return None;
    }
    Some(TsPayload {
        source_offset,
        pid,
        transport_error_indicator,
        has_payload,
        payload_unit_start,
        continuity_counter,
        discontinuity,
        scrambled,
        data: &data[payload..end],
    })
}

/// Reassembles PSI sections, which are length-prefixed and may straddle packets.
struct PsiSection {
    data: Vec<u8>,
    source_offset: Option<u64>,
}

#[derive(Default)]
struct SectionAssembler {
    bytes: Vec<u8>,
    source_offset: Option<u64>,
}

impl SectionAssembler {
    fn push(&mut self, packet: &TsPayload<'_>, sections: &mut Vec<PsiSection>) {
        let payload = packet.data;
        let mut at = 0;
        if packet.payload_unit_start {
            if payload.is_empty() {
                return;
            }
            let pointer = payload[0] as usize;
            at = 1;
            if !self.bytes.is_empty() && pointer > 0 {
                let end = (at + pointer).min(payload.len());
                self.append(&payload[at..end], packet.source_offset, sections);
            }
            self.bytes.clear();
            self.source_offset = None;
            at += pointer;
        }
        if at <= payload.len() {
            self.append(&payload[at..], packet.source_offset, sections);
        }
    }

    fn append(&mut self, data: &[u8], source_offset: u64, sections: &mut Vec<PsiSection>) {
        if self.bytes.is_empty() && !data.is_empty() {
            self.source_offset = Some(source_offset);
        }
        self.bytes.extend_from_slice(data);
        loop {
            if self.bytes.first() == Some(&0xff) {
                self.bytes.clear();
                self.source_offset = None;
                return;
            }
            if self.bytes.len() < 3 {
                return;
            }
            let length = 3 + ((((self.bytes[1] & 0x0f) as usize) << 8) | self.bytes[2] as usize);
            if self.bytes.len() < length {
                return;
            }
            sections.push(PsiSection {
                data: self.bytes.drain(..length).collect(),
                source_offset: self.source_offset.take(),
            });
            if !self.bytes.is_empty() {
                self.source_offset = Some(source_offset);
            }
        }
    }
}

#[cfg(test)]
mod section_source_tests {
    use super::{PsiSection, SectionAssembler, TsPayload};

    fn payload<'a>(data: &'a [u8], source_offset: u64, start: bool) -> TsPayload<'a> {
        TsPayload {
            source_offset,
            pid: 0,
            transport_error_indicator: false,
            has_payload: true,
            payload_unit_start: start,
            continuity_counter: 0,
            discontinuity: false,
            scrambled: false,
            data,
        }
    }

    #[test]
    fn retains_the_first_packet_of_a_section_that_spans_packets() {
        let mut section = vec![0; 200];
        section[..3].copy_from_slice(&[0x00, 0xb0, 197]);
        let mut first = vec![0];
        first.extend_from_slice(&section[..183]);

        let mut assembler = SectionAssembler::default();
        let mut output: Vec<PsiSection> = Vec::new();
        assembler.push(&payload(&first, 1_000, true), &mut output);
        assert!(output.is_empty());
        assembler.push(&payload(&section[183..], 1_188, false), &mut output);

        assert_eq!(output.len(), 1);
        assert_eq!(output[0].source_offset, Some(1_000));
        assert_eq!(output[0].data, section);
    }
}

struct DeferredProgram {
    service: u16,
    rank: usize,
    video: Option<u16>,
    audio: Option<u16>,
    audio_streams: Vec<AudioStream>,
    private_streams: Vec<PrivateStream>,
}

#[derive(PartialEq, Eq, PartialOrd, Ord, Debug)]
struct PrivateStream {
    is_async: bool,
    pid: u16,
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
    private_streams: Vec<PrivateStream>,
    /// Every service seen in the program association table, in the order they
    /// were announced.
    services: Vec<u16>,
    all_service_pids: HashMap<u16, Vec<u16>>,
    changed_pids: HashSet<u16>,
    assemblers: HashMap<u16, SectionAssembler>,
    pat_offsets: HashMap<u16, u64>,
    restart_offsets: HashMap<u16, u64>,
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
            private_streams: Vec::new(),
            services: Vec::new(),
            all_service_pids: HashMap::new(),
            changed_pids: HashSet::new(),
            assemblers: HashMap::new(),
            pat_offsets: HashMap::new(),
            restart_offsets: HashMap::new(),
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
            self.private_streams = deferred.private_streams;
        }
    }

    fn wants(&self, pid: u16) -> bool {
        pid == 0 || self.pmt_pids.contains(&pid)
    }

    fn push(&mut self, packet: &TsPayload<'_>, sections: &mut Vec<PsiSection>) -> Vec<u16> {
        sections.clear();
        self.assemblers
            .entry(packet.pid)
            .or_default()
            .push(packet, sections);
        for section in sections.iter() {
            self.scan(&section.data, packet.pid, section.source_offset);
        }
        self.changed_pids.drain().collect()
    }

    fn restart_offset(&self) -> Option<u64> {
        let service = self.service?;
        self.restart_offsets.get(&service).copied()
    }

    /// Scan a PAT or PMT section, recording the PMT PIDs and the first MPEG-2
    /// video and AAC elementary streams they advertise.
    fn scan(&mut self, section: &[u8], pid: u16, source_offset: Option<u64>) {
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
                    if let Some(source_offset) = source_offset {
                        self.pat_offsets.insert(program, source_offset);
                    }
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
            if source_offset.is_some() {
                if let Some(&pat_offset) = self.pat_offsets.get(&service) {
                    // A new demuxer has to read the PAT before this PMT: if a
                    // newer PAT arrived after the last PMT, starting there
                    // would make it discard that PMT and miss the next GOP.
                    self.restart_offsets.insert(service, pat_offset);
                }
            }
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
            let private_streams = select_private_streams(private);
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
                        private_streams,
                    });
                }
                return;
            }
            self.service = Some(service);
            self.rank = rank;
            self.video_pid = video;
            self.audio_pid = audio;
            self.audio_streams = audio_streams;
            self.private_streams = private_streams;
        }
    }
}

fn pes_pts(packet: &[u8]) -> Option<u64> {
    if packet.len() < 14 {
        return None;
    } else if packet[3] == 0xbf {
        return None;
    } else if packet[6] & 0xc0 != 0x80 || packet[7] & 0x80 == 0 {
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

fn pes_payload(packet: &[u8], kind: ElementaryKind) -> Option<&[u8]> {
    if packet.len() < 9 || packet[0] != 0 || packet[1] != 0 || packet[2] != 1 {
        return None;
    }
    let stream_id = packet[3];
    if !kind.accepts_stream_id(stream_id) {
        return None;
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
            return None;
        };
        if first & 0xc0 == 0x40 {
            start += 2;
        }
        let Some(&marker) = packet.get(start) else {
            return None;
        };
        match marker & 0xf0 {
            0x20 => start += 5,
            0x30 => start += 10,
            _ if marker == 0x0f => start += 1,
            _ => return None,
        }
        start
    };
    let end = if pes_length == 0 {
        packet.len()
    } else {
        packet.len().min(6 + pes_length)
    };
    if start > end {
        return None;
    }
    Some(&packet[start..end])
}

fn pes_packet_length(packet: &[u8]) -> Option<usize> {
    if packet.len() < 9 || packet[0] != 0 || packet[1] != 0 || packet[2] != 1 {
        return None;
    }
    return Some(((packet[4] as usize) << 8) | packet[5] as usize);
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
    /// Whether the next complete PES follows a transport-stream continuity gap.
    discontinuity_before: bool,
    /// Whether packet loss cut the preceding PES rather than falling between PES packets.
    damaged_before: bool,
    started: bool,
    restart_offset: Option<u64>,
}

impl PesState {
    /// Whether a bounded PES ended before reaching the length in its header.
    fn is_declared_pes_incomplete(&self) -> bool {
        let Some(length) = self.parts.get(4..6) else {
            return !self.parts.is_empty();
        };
        let length = u16::from_be_bytes([length[0], length[1]]) as usize;
        length != 0 && self.parts.len() < 6 + length
    }

    fn flush(
        &mut self,
        kind: ElementaryKind,
        pid: u16,
        output: &mut Vec<ElementaryPacket>,
        fallback_pts: Option<u64>,
    ) {
        if self.parts.is_empty() {
            self.started = false;
            self.restart_offset = None;
            return;
        }
        let Some(data) = pes_payload(&self.parts, kind) else {
            self.parts.clear();
            self.started = false;
            self.restart_offset = None;
            return;
        };
        if !self.started {
            self.parts.clear();
            self.restart_offset = None;
            return;
        }
        self.started = false;
        let data = data.to_vec();
        let pts = pes_pts(&self.parts).or(fallback_pts);
        self.parts.clear();
        output.push(ElementaryPacket {
            kind,
            pid,
            data,
            pts,
            discontinuity: std::mem::take(&mut self.discontinuity_before),
            damaged_previous_pes: std::mem::take(&mut self.damaged_before),
            restart_offset: self.restart_offset.take(),
        });
    }

    /// Forget a PES cut by packet loss and mark the first complete replacement.
    fn discard_at_discontinuity(&mut self) {
        self.parts.clear();
        self.started = false;
        self.restart_offset = None;
        self.discontinuity_before = true;
        self.damaged_before = true;
    }

    fn push(
        &mut self,
        kind: ElementaryKind,
        pid: u16,
        payload: &TsPayload,
        continuity_change: ContinuityChange,
        output: &mut Vec<ElementaryPacket>,
        fallback_pts: Option<u64>,
        restart_offset: Option<u64>,
    ) {
        if payload.payload_unit_start {
            let was_previous_pes_incomplete = self.is_declared_pes_incomplete();
            let was_previous_pes_damaged = match continuity_change {
                ContinuityChange::Loss => true,
                ContinuityChange::Reset => was_previous_pes_incomplete,
                ContinuityChange::None | ContinuityChange::Duplicate => false,
            };
            // A partially received PES may still contain complete video units
            // or AAC frames, so hand its usable prefix to the stateful parser.
            if !self.parts.is_empty() {
                self.flush(kind, pid, output, fallback_pts);
            }
            self.parts.clear();
            self.started = is_pes_start(payload.data, kind);
            self.restart_offset = self.started.then_some(restart_offset).flatten();
            if continuity_change != ContinuityChange::None {
                self.discontinuity_before = true;
                self.damaged_before |= was_previous_pes_damaged;
            }
        } else if continuity_change == ContinuityChange::Loss {
            self.discard_at_discontinuity();
            return;
        } else if continuity_change == ContinuityChange::Reset {
            // A clean marker within one PES changes the transport time base
            // while leaving all elementary-stream bytes intact.
            self.discontinuity_before = true;
        }
        self.parts.extend_from_slice(payload.data);
        if let Some(length) = pes_packet_length(&self.parts) {
            if length == 0 {
            } else if length + 6 == self.parts.len() {
                self.flush(kind, pid, output, fallback_pts);
            } else if length + 6 < self.parts.len() {
                self.parts.clear();
                self.started = false;
                self.restart_offset = None;
            }
        }
    }
}

/// A stream the chosen service has moved off but which is still sending.
/// Its state remains separate because old and new PIDs may overlap briefly.
struct Superseded {
    pid: u16,
    state: PesState,
}

/// Stateful MPEG-2-video/AAC demuxer, for streaming a file through in bounded
/// memory rather than holding all of it.
#[derive(Default)]
pub struct MpegTsAvDemuxer {
    pending: Vec<u8>,
    /// Offset of `pending[0]` in the byte stream handed to this demuxer.
    stream_offset: u64,
    unsynced: bool,
    program: ProgramMap,
    video: PesState,
    audio: PesState,
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
    continuity: HashMap<u16, ContinuityState>,
    /// PIDs whose adaptation-only marker applies to their next payload.
    pending_discontinuities: HashSet<u16>,
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

    fn take_audio_switch(&mut self) -> Result<()> {
        let Some(pid) = self.audio_switch.take() else {
            return Ok(());
        };
        self.audio = PesState::default();
        self.program.audio_pid = Some(pid);
        self.audio_pts = None;
        Ok(())
    }

    /// ARIB character superimpose is timed by the accompanying audio PES, or
    /// by video when the service has no audio. Its own PES commonly has no PTS.
    fn fallback_pts(&self) -> Option<u64> {
        if self.program.audio_pid.is_some() {
            self.audio_pts
        } else {
            self.video_pts
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<ElementaryPacket>> {
        self.pending.extend_from_slice(chunk);
        let input = std::mem::take(&mut self.pending);
        let input_offset = self.stream_offset;

        let mut at = 0;
        let mut output = Vec::new();
        self.take_audio_switch()?;
        let mut sections = Vec::new();
        while at + TS_PACKET_SIZE <= input.len() {
            if input[at] != 0x47 || self.unsynced {
                if input[at..].len() < TS_PACKET_SIZE * MIN_SYNC_COUNT {
                    break;
                }
                match sync_offset(&input[at..], MIN_SYNC_COUNT) {
                    Some(offset) => {
                        at += offset;
                        self.unsynced = false;
                    }
                    None => {
                        at += TS_PACKET_SIZE * MIN_SYNC_COUNT;
                        self.unsynced = true;
                        continue;
                    }
                }
            }
            let packet_offset = input_offset + at as u64;
            let Some(packet) = payload_at(&input, at, packet_offset) else {
                at += TS_PACKET_SIZE;
                continue;
            };
            at += TS_PACKET_SIZE;
            if packet.transport_error_indicator {
                self.errors += 1;
                continue;
            }
            if !packet.has_payload {
                // An adaptation-only marker anchors the counter of the new
                // run even though it contributes no elementary-stream bytes.
                if packet.discontinuity {
                    self.continuity.entry(packet.pid).or_default().counter =
                        packet.continuity_counter;
                    self.pending_discontinuities.insert(packet.pid);
                }
                continue;
            }
            if packet.scrambled {
                if self.note_continuity(&packet) == ContinuityChange::Duplicate {
                    continue;
                }
                // A skipped payload leaves the PES on either side unrelated,
                // so the next payload-unit start becomes the new assembly point.
                self.discard_partial(packet.pid);
                self.scrambled += 1;
                continue;
            }
            let continuity_change = self.note_continuity(&packet);
            if continuity_change == ContinuityChange::Duplicate {
                continue;
            }
            if continuity_change == ContinuityChange::Loss && !packet.payload_unit_start {
                // Bytes after a continuity hole are the tail of a PES whose
                // middle is gone, so the next complete PES becomes the recovery point.
                self.discard_partial(packet.pid);
            }
            if self.program.wants(packet.pid) {
                let prev_service = self.program.service;
                let prev_video_pid = self.program.video_pid;
                let prev_audio_pid = self.program.audio_pid;
                let changed_pids = self.program.push(&packet, &mut sections);
                for pid in changed_pids {
                    // The old PID remains live until the replacement starts,
                    // so its continuity history still belongs to its own state.
                    if Some(pid) != prev_video_pid && Some(pid) != prev_audio_pid {
                        self.continuity.remove(&pid);
                    }
                }
                if prev_video_pid != self.program.video_pid {
                    if let Some(prev_video_pid) = prev_video_pid {
                        // Flush the older superseded PID before replacing the current PID
                        if let Some(mut superseded) = self.superseded_video.take() {
                            superseded.state.flush(
                                ElementaryKind::Video,
                                superseded.pid,
                                &mut output,
                                None,
                            );
                        }
                        if prev_service == self.program.service {
                            self.superseded_video = Some(Superseded {
                                pid: prev_video_pid,
                                state: std::mem::take(&mut self.video),
                            });
                        } else {
                            self.video.flush(
                                ElementaryKind::Video,
                                prev_video_pid,
                                &mut output,
                                None,
                            );
                            self.video = PesState::default();
                        }
                        self.video_pts = None;
                    }
                }
                if prev_audio_pid != self.program.audio_pid {
                    if let Some(prev_audio_pid) = prev_audio_pid {
                        // Flush the older superseded PID before replacing the current PID
                        if let Some(mut superseded) = self.superseded_audio.take() {
                            superseded.state.flush(
                                ElementaryKind::Audio,
                                superseded.pid,
                                &mut output,
                                None,
                            );
                        }
                        if prev_service == self.program.service {
                            self.superseded_audio = Some(Superseded {
                                pid: prev_audio_pid,
                                state: std::mem::take(&mut self.audio),
                            });
                        } else {
                            self.audio.flush(
                                ElementaryKind::Audio,
                                prev_audio_pid,
                                &mut output,
                                None,
                            );
                            self.audio = PesState::default();
                        }
                        self.audio_pts = None;
                    }
                }
                let fallback_pts = self.fallback_pts();
                for (pid, state) in &mut self.private {
                    if self
                        .program
                        .private_streams
                        .iter()
                        .any(|stream| stream.pid == *pid)
                    {
                        continue;
                    }
                    // A removed private PID keeps the kind named by the PES
                    // already gathered, so its final payload remains decodable.
                    let kind = match state.parts.get(3) {
                        Some(0xbf) => ElementaryKind::PrivateStream2,
                        _ => ElementaryKind::PrivateStream1,
                    };
                    state.flush(kind, *pid, &mut output, fallback_pts);
                }
                self.private.retain(|pid, _| {
                    self.program
                        .private_streams
                        .iter()
                        .any(|stream| stream.pid == *pid)
                });
            }
            let fallback_pts = self.fallback_pts();
            let (kind, state) = if Some(packet.pid) == self.program.video_pid {
                // Everything the old PID sent before this first replacement
                // packet precedes the new stream in the same programme.
                if let Some(mut old) = self.superseded_video.take() {
                    old.state
                        .flush(ElementaryKind::Video, old.pid, &mut output, None);
                }
                (ElementaryKind::Video, &mut self.video)
            } else if Some(packet.pid) == self.program.audio_pid {
                if let Some(mut old) = self.superseded_audio.take() {
                    old.state
                        .flush(ElementaryKind::Audio, old.pid, &mut output, None);
                }
                (ElementaryKind::Audio, &mut self.audio)
            } else if self
                .superseded_video
                .as_ref()
                .is_some_and(|stream| stream.pid == packet.pid)
            {
                (
                    ElementaryKind::Video,
                    &mut self.superseded_video.as_mut().expect("just matched").state,
                )
            } else if self
                .superseded_audio
                .as_ref()
                .is_some_and(|stream| stream.pid == packet.pid)
            {
                (
                    ElementaryKind::Audio,
                    &mut self.superseded_audio.as_mut().expect("just matched").state,
                )
            } else if self.program.private_streams.contains(&PrivateStream {
                is_async: false,
                pid: packet.pid,
            }) {
                (
                    ElementaryKind::PrivateStream1,
                    self.private.entry(packet.pid).or_default(),
                )
            } else if self.program.private_streams.contains(&PrivateStream {
                is_async: true,
                pid: packet.pid,
            }) {
                (
                    ElementaryKind::PrivateStream2,
                    self.private.entry(packet.pid).or_default(),
                )
            } else {
                continue;
            };
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
            state.push(
                kind,
                packet.pid,
                &packet,
                continuity_change,
                &mut output,
                if kind == ElementaryKind::PrivateStream2 {
                    fallback_pts
                } else {
                    None
                },
                self.program.restart_offset(),
            );
        }
        self.stream_offset += at as u64;
        if at >= input.len() {
            self.pending.clear();
        } else {
            self.pending = input[at..].to_vec();
        }
        Ok(output)
    }

    pub fn scrambled(&self) -> u64 {
        self.scrambled
    }
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
    /// Record one payload's continuity and classify any break before it.
    fn note_continuity(&mut self, packet: &TsPayload<'_>) -> ContinuityChange {
        let is_elementary_pid = self.program.video_pid == Some(packet.pid)
            || self.program.audio_pid == Some(packet.pid)
            || self
                .program
                .private_streams
                .iter()
                .any(|stream| stream.pid == packet.pid)
            || self
                .superseded_video
                .as_ref()
                .is_some_and(|stream| stream.pid == packet.pid)
            || self
                .superseded_audio
                .as_ref()
                .is_some_and(|stream| stream.pid == packet.pid);
        let is_accepted_pid = is_elementary_pid || self.program.wants(packet.pid);
        let previous = self.continuity.remove(&packet.pid);

        // A retransmitted marker repeats payload already accepted into the new
        // continuity run, so only its first arrival changes parser state.
        if packet.discontinuity
            && previous
                .as_ref()
                .is_some_and(|previous| previous.accepted && previous.is_duplicate(packet))
        {
            self.continuity
                .insert(packet.pid, previous.expect("just matched"));
            return ContinuityChange::Duplicate;
        }

        let has_pending_discontinuity = self.pending_discontinuities.remove(&packet.pid);
        let continuity_change = if packet.discontinuity {
            let had_previous = previous.is_some();
            if had_previous {
                ContinuityChange::Reset
            } else {
                ContinuityChange::None
            }
        } else if has_pending_discontinuity {
            if let Some(previous) = previous.as_ref() {
                let expected = (previous.counter + 1) & 0x0f;
                if packet.continuity_counter == expected {
                    ContinuityChange::Reset
                } else {
                    self.dropped +=
                        ((packet.continuity_counter as u16 + 16 - expected as u16) & 0x0f) as u64;
                    ContinuityChange::Loss
                }
            } else {
                ContinuityChange::None
            }
        } else if let Some(previous) = previous.as_ref() {
            let expected = (previous.counter + 1) & 0x0f;
            if packet.continuity_counter == expected {
                ContinuityChange::None
            } else {
                if previous.accepted && previous.is_duplicate(packet) {
                    ContinuityChange::Duplicate
                } else if !previous.accepted && previous.counter == packet.continuity_counter {
                    ContinuityChange::None
                } else {
                    self.dropped +=
                        ((packet.continuity_counter as u16 + 16 - expected as u16) & 0x0f) as u64;
                    ContinuityChange::Loss
                }
            }
        } else {
            ContinuityChange::None
        };

        if continuity_change == ContinuityChange::Duplicate {
            self.continuity
                .insert(packet.pid, previous.expect("duplicate has a predecessor"));
        } else {
            self.continuity.insert(
                packet.pid,
                ContinuityState::from_packet(packet, is_accepted_pid, previous),
            );
        }
        continuity_change
    }

    /// Drop the unfinished PES owned by one PID after its payload loses continuity.
    fn discard_partial(&mut self, pid: u16) {
        if self.program.video_pid == Some(pid) {
            self.video.discard_at_discontinuity();
        }
        if self.program.audio_pid == Some(pid) {
            self.audio.discard_at_discontinuity();
        }
        if self
            .superseded_video
            .as_mut()
            .is_some_and(|stream| stream.pid == pid)
        {
            self.superseded_video
                .as_mut()
                .expect("just matched")
                .state
                .discard_at_discontinuity();
        }
        if self
            .superseded_audio
            .as_mut()
            .is_some_and(|stream| stream.pid == pid)
        {
            self.superseded_audio
                .as_mut()
                .expect("just matched")
                .state
                .discard_at_discontinuity();
        }
        if self.private.contains_key(&pid) {
            self.private
                .entry(pid)
                .or_default()
                .discard_at_discontinuity();
        }
    }
    pub fn errors(&self) -> u64 {
        self.errors
    }

    /// Flush whatever PES packets were still accumulating at end of input.
    pub fn finish(&mut self) -> Result<Vec<ElementaryPacket>> {
        let mut output = Vec::new();
        let fallback_pts = self.fallback_pts();
        if let Some(mut video) = self.superseded_video.take() {
            video
                .state
                .flush(ElementaryKind::Video, video.pid, &mut output, None);
        }
        if let Some(mut audio) = self.superseded_audio.take() {
            audio
                .state
                .flush(ElementaryKind::Audio, audio.pid, &mut output, None);
        }
        if let Some(video_pid) = self.program.video_pid {
            self.video
                .flush(ElementaryKind::Video, video_pid, &mut output, None);
        }
        if let Some(audio_pid) = self.program.audio_pid {
            self.audio
                .flush(ElementaryKind::Audio, audio_pid, &mut output, None);
        }
        for private in &mut self.program.private_streams {
            if let Some(state) = self.private.get_mut(&private.pid) {
                state.flush(
                    if private.is_async {
                        ElementaryKind::PrivateStream2
                    } else {
                        ElementaryKind::PrivateStream1
                    },
                    private.pid,
                    &mut output,
                    fallback_pts,
                );
            }
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
    let Some(mut at) = sync_offset(data, 6) else {
        return;
    };
    while at + TS_PACKET_SIZE <= data.len() {
        // A payload the sync check walked past is worth stepping over rather
        // than giving up on: a slice is a fragment of a file, and one damaged
        // packet says nothing about the ones after it.
        if let Some(packet) = payload_at(data, at, at as u64) {
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
    if demuxer.unsynced {
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
