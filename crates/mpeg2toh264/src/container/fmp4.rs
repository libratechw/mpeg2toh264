//! Packaging this transcoder's Annex B output as a fragmented MP4.

use crate::bitreader::BitReader;
use crate::container::adts::{AacConfig, AAC_FRAME_SAMPLES};
use crate::error::{bail, Result};
use crate::mpeg2::constants::{PictureStructure, PictureType, FRAME_RATE};
use crate::mpeg2::headers::{
    parse_elementary_stream, picture_geometry, pictures_interlacing, sequence_sample_aspect_ratio,
    Interlacing, Picture, SampleAspectRatio,
};
use crate::mpeg2::macroblock::{decode_slice, MacroblockGrid};
use crate::round_half_up;

const TIMESCALE: u32 = 90_000;

/// A growable big-endian byte buffer, which is all the box writer needs.
#[derive(Default)]
struct Buf(Vec<u8>);

impl Buf {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn u8(&mut self, value: u8) -> &mut Self {
        self.0.push(value);
        self
    }

    fn u16(&mut self, value: u16) -> &mut Self {
        self.0.extend_from_slice(&value.to_be_bytes());
        self
    }

    fn u24(&mut self, value: u32) -> &mut Self {
        self.0.extend_from_slice(&value.to_be_bytes()[1..]);
        self
    }

    fn u32(&mut self, value: u32) -> &mut Self {
        self.0.extend_from_slice(&value.to_be_bytes());
        self
    }

    fn u64(&mut self, value: u64) -> &mut Self {
        self.0.extend_from_slice(&value.to_be_bytes());
        self
    }

    fn bytes(&mut self, value: &[u8]) -> &mut Self {
        self.0.extend_from_slice(value);
        self
    }

    fn ascii(&mut self, value: &str) -> &mut Self {
        self.0.extend_from_slice(value.as_bytes());
        self
    }

    fn zeros(&mut self, count: usize) -> &mut Self {
        self.0.resize(self.0.len() + count, 0);
        self
    }

    fn into_vec(self) -> Vec<u8> {
        self.0
    }
}

/// Wrap a payload in a box header: a 32-bit size then the four-character type.
fn boxed(kind: &str, payload: &[u8]) -> Vec<u8> {
    let mut out = Buf::new();
    out.u32((8 + payload.len()) as u32)
        .ascii(kind)
        .bytes(payload);
    out.into_vec()
}

/// A box whose payload begins with a version byte and 24 flag bits.
fn full_box(kind: &str, version: u8, flags: u32, payload: &[u8]) -> Vec<u8> {
    let mut body = Buf::new();
    body.u8(version).u24(flags).bytes(payload);
    boxed(kind, &body.into_vec())
}

fn concat(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(|p| p.len()).sum());
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

/// Split an Annex B byte stream into its NAL units, dropping the start codes.
fn split_annex_b(data: &[u8]) -> Vec<&[u8]> {
    let mut starts: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] != 0 || data[i + 1] != 0 {
            i += 1;
            continue;
        }
        if data[i + 2] == 1 {
            starts.push((i, 3));
            i += 3;
        } else if data[i + 2] == 0 && data[i + 3] == 1 {
            starts.push((i, 4));
            i += 4;
        } else {
            i += 1;
        }
    }
    let mut nals = Vec::with_capacity(starts.len());
    for (index, &(at, length)) in starts.iter().enumerate() {
        let start = at + length;
        let end = starts.get(index + 1).map_or(data.len(), |next| next.0);
        if end > start {
            nals.push(&data[start..end]);
        }
    }
    nals
}

type VideoSample<'a> = Vec<&'a [u8]>;

/// Group VCL NAL units into access units. New streams carry AUDs so a PAFF
/// field pair becomes one MP4 sample; accepting streams without AUDs preserves
/// compatibility with callers that provide one VCL NAL per picture.
fn video_samples<'a>(nals: &[&'a [u8]]) -> Vec<VideoSample<'a>> {
    let has_aud = nals.iter().any(|nal| nal[0] & 0x1f == 9);
    if !has_aud {
        return nals
            .iter()
            .filter(|nal| matches!(nal[0] & 0x1f, 1 | 5))
            .map(|&nal| vec![nal])
            .collect();
    }
    let mut samples = Vec::new();
    let mut current = Vec::new();
    for &nal in nals {
        match nal[0] & 0x1f {
            9 => {
                if !current.is_empty() {
                    samples.push(std::mem::take(&mut current));
                }
            }
            1 | 5 => current.push(nal),
            _ => {}
        }
    }
    if !current.is_empty() {
        samples.push(current);
    }
    samples
}

#[derive(Clone, Debug)]
pub struct Mpeg2VideoTimeline {
    pub width: u32,
    pub height: u32,
    pub sample_duration: u32,
    /// Presentation index for each coded picture, excluding the IDR clone.
    pub presentation_indices: Vec<u32>,
    pub sample_aspect_ratio: Option<SampleAspectRatio>,
    /// What the source pictures said about their fields. Nothing in the MP4
    /// carries this -- H.264 could say it in a picture timing SEI, and the
    /// browsers that would read one do not deinterlace anyway -- so it is
    /// reported alongside instead, for a player that filters the picture
    /// itself.
    pub interlacing: Interlacing,
}

/// The field that pairs with `picture` to make a frame, if `candidate` is it.
///
/// A unit that begins between the two fields of a pair has only the second, and
/// one that ends between them has only the first; a broadcast that loses a
/// field leaves the same thing in the middle. None of the three can be made
/// into a frame, so the odd field is dropped -- by the transcoder and by the
/// timeline alike, which is why this decision lives in one place.
pub fn complementary_field<'a>(
    candidate: Option<&'a Picture>,
    picture: &Picture,
) -> Option<&'a Picture> {
    candidate.filter(|mate| {
        mate.coding.picture_structure != PictureStructure::Frame
            && mate.coding.picture_structure != picture.coding.picture_structure
            && mate.header.temporal_reference == picture.header.temporal_reference
            && mate.header.picture_coding_type == picture.header.picture_coding_type
    })
}

/// Whether every slice in a source picture reaches its end cleanly. The
/// transcoder drops a picture when any of its independently decodable slices
/// is damaged or truncated; the MP4 timeline must make the identical decision
/// or it will reserve a sample that the H.264 stream does not contain.
fn picture_is_decodable(
    reader: &mut BitReader<'_>,
    picture: &Picture,
    grid: &mut MacroblockGrid,
) -> bool {
    let geometry = picture_geometry(picture);
    grid.reset(geometry.mb_width * geometry.mb_height);
    !picture.slices.is_empty()
        && picture
            .slices
            .iter()
            .all(|slice| decode_slice(reader, picture, slice, geometry.mb_width, grid).is_ok())
}

/// Reproduce the transcoder's accepted-picture timeline in MP4 timescale units.
///
/// `has_references` is set when the unit continues an already-populated decoded
/// picture buffer, so its leading B pictures are codeable.
pub fn mpeg2_video_timeline(data: &[u8], has_references: bool) -> Result<Mpeg2VideoTimeline> {
    let pictures = parse_elementary_stream(data)?;
    let Some(first) = pictures.first() else {
        bail!("no MPEG-2 pictures for MP4 timeline");
    };
    let code = first.sequence.frame_rate_code as usize;
    let base_rate = FRAME_RATE.get(code).copied().unwrap_or((0, 0));
    if base_rate.0 == 0 {
        bail!(
            "unsupported MPEG-2 frame_rate_code {}",
            first.sequence.frame_rate_code
        );
    }
    let numerator = base_rate.0 as f64 * (first.sequence_ext.frame_rate_extension_n + 1) as f64;
    let denominator = base_rate.1 as f64 * (first.sequence_ext.frame_rate_extension_d + 1) as f64;
    let sample_duration = round_half_up(TIMESCALE as f64 * denominator / numerator) as u32;

    let mut references = if has_references { 2 } else { 0 };
    // A unit that opens the decoded picture buffer can hold nothing until the
    // picture that opens it arrives, and only an I picture can. One that starts
    // part way through a group of pictures -- which is what a seek lands on --
    // may have none, and then it holds nothing at all. The transcoder decides
    // this the same way, and the two have to agree or the fragment claims
    // samples the H.264 stream does not have.
    let mut awaiting_intra = !has_references;
    let mut gop_base: u32 = 0;
    let mut seen_picture = false;
    let mut max_tr_in_gop: u32 = 0;
    let mut presentation_indices = Vec::new();
    let mut reader = BitReader::new(data);
    let mut grid = MacroblockGrid::new();
    let mut picture_index = 0;
    while picture_index < pictures.len() {
        let picture = &pictures[picture_index];
        let mut mate = None;
        let mut unpaired = false;
        if picture.coding.picture_structure != PictureStructure::Frame {
            match complementary_field(pictures.get(picture_index + 1), picture) {
                // The transcoder combines complementary fields into one MBAFF
                // frame, so they occupy one MP4 sample and advance reference
                // state only once as well.
                Some(field_mate) => {
                    mate = Some(field_mate);
                    picture_index += 2;
                }
                None => {
                    unpaired = true;
                    picture_index += 1;
                }
            }
        } else {
            picture_index += 1;
        }
        let picture_type = picture.header.picture_coding_type;
        if !picture_type.is_ipb() {
            continue;
        }
        let tr = picture.header.temporal_reference;
        if picture.starts_gop && seen_picture {
            gop_base += max_tr_in_gop + 1;
            max_tr_in_gop = 0;
        }
        seen_picture = true;
        max_tr_in_gop = max_tr_in_gop.max(tr);
        // A lone field is no frame, and the transcoder drops it for the same
        // reason. Both have to, or the timeline reserves a sample the H.264
        // stream does not hold.
        if unpaired {
            continue;
        }
        if !picture_is_decodable(&mut reader, picture, &mut grid)
            || mate.is_some_and(|field| !picture_is_decodable(&mut reader, field, &mut grid))
        {
            continue;
        }
        if awaiting_intra {
            if picture_type != PictureType::I {
                continue;
            }
            awaiting_intra = false;
        }
        if picture_type == PictureType::B && references < 2 {
            continue;
        }
        presentation_indices.push(gop_base + tr + 1);
        if picture_type != PictureType::B {
            references = (references + 1).min(2);
        }
    }
    Ok(Mpeg2VideoTimeline {
        width: first.sequence.horizontal_size,
        height: first.sequence.vertical_size,
        sample_duration,
        presentation_indices,
        sample_aspect_ratio: sequence_sample_aspect_ratio(&first.sequence),
        interlacing: pictures_interlacing(&pictures),
    })
}

/// Sample durations and composition offsets for one unit of coded pictures.
#[derive(Clone, Debug)]
pub struct SampleTiming {
    /// Durations in decode order.
    pub durations: Vec<u32>,
    /// Offsets carrying each sample from its decode slot to its display slot.
    pub compositions: Vec<u32>,
    /// How far decoding runs ahead of display.
    pub reorder_delay: i64,
}

/// Work out the sample timing for one unit of coded pictures.
///
/// A unit that starts at a random access point carries an IDR plus the skipped
/// copy of it that starts the short-term reference chain, so it holds one more
/// sample than the timeline has pictures. It is also short of pictures at the
/// front: an open GOP's leading B pictures reference an anchor the IDR flushes,
/// so the transcoder cannot code them and the first retained picture sits that
/// many display slots in.
///
/// Those empty slots go to the IDR, which holds the same picture as the copy
/// that follows it. That leaves no gap to stall on, and -- the reason this
/// matters -- it makes every unit span exactly as many frames as the source did,
/// so units appended end to end cannot creep away from the audio.
pub fn mpeg2_sample_timing(timeline: &Mpeg2VideoTimeline, starts_at_idr: bool) -> SampleTiming {
    let indices = &timeline.presentation_indices;
    // The slot the unit starts on, which is not the first picture in decode
    // order: an I picture is coded ahead of the B pictures that display before
    // it, and at a random access point those B pictures are missing entirely.
    let first_index = indices.iter().copied().min().unwrap_or(1) as i64;
    let duration = timeline.sample_duration as i64;
    let offsets: Vec<i64> = indices
        .iter()
        .enumerate()
        .map(|(decode_index, &presentation_index)| {
            (presentation_index as i64 - first_index - decode_index as i64) * duration
        })
        .collect();
    // An anchor picture is coded before the B pictures that display ahead of it,
    // so it reaches its display slot before its decode slot -- a negative
    // composition offset, which asks a decoder to show a picture it has not
    // decoded yet. Holding the whole decode timeline back by the largest such
    // lead keeps every offset at or above zero without moving a single picture
    // relative to the audio.
    let reorder_delay = -offsets.iter().copied().min().unwrap_or(0).min(0);
    let mut durations: Vec<u32> = vec![timeline.sample_duration; indices.len()];
    let mut compositions: Vec<u32> = offsets
        .iter()
        .map(|offset| (offset + reorder_delay) as u32)
        .collect();
    if starts_at_idr {
        durations.insert(0, ((first_index - 1) * duration).max(1) as u32);
        compositions.insert(0, reorder_delay as u32);
    }
    SampleTiming {
        durations,
        compositions,
        reorder_delay,
    }
}

fn make_avc_c(sps: &[u8], pps: &[u8]) -> Result<Vec<u8>> {
    if sps.len() < 4 {
        bail!("H.264 SPS is too short for avcC");
    }
    let mut body = Buf::new();
    body.bytes(&[1, sps[1], sps[2], sps[3], 0xff, 0xe1])
        .u16(sps.len() as u16)
        .bytes(sps)
        .u8(1)
        .u16(pps.len() as u16)
        .bytes(pps);
    Ok(boxed("avcC", &body.into_vec()))
}

/// An MPEG-4 descriptor: a tag, a length in the four-byte expanded form every
/// muxer emits, then the payload.
fn descriptor(tag: u8, payload: &[u8]) -> Vec<u8> {
    let length = payload.len() as u32;
    let mut out = Buf::new();
    out.u8(tag)
        .u8(0x80 | ((length >> 21) & 0x7f) as u8)
        .u8(0x80 | ((length >> 14) & 0x7f) as u8)
        .u8(0x80 | ((length >> 7) & 0x7f) as u8)
        .u8((length & 0x7f) as u8)
        .bytes(payload);
    out.into_vec()
}

/// The `esds` box, which is where an MP4 keeps the AudioSpecificConfig that
/// ADTS carried in every frame header.
fn make_esds(config: &AacConfig) -> Vec<u8> {
    let decoder_specific = descriptor(0x05, &config.audio_specific_config);
    let decoder_config = {
        let mut body = Buf::new();
        // objectTypeIndication 0x40 (MPEG-4 audio), streamType 0x15 (audio,
        // upstream off), then buffer size, max and average bitrate as zero.
        body.bytes(&[0x40, 0x15, 0, 0, 0])
            .u32(0)
            .u32(0)
            .bytes(&decoder_specific);
        descriptor(0x04, &body.into_vec())
    };
    let sl_config = descriptor(0x06, &[0x02]);
    let es_descriptor = {
        let mut body = Buf::new();
        body.u16(2) // ES_ID
            .u8(0) // no stream priority, no dependency, no URL
            .bytes(&decoder_config)
            .bytes(&sl_config);
        descriptor(0x03, &body.into_vec())
    };
    full_box("esds", 0, 0, &es_descriptor)
}

/// 16.16 fixed point, wrapping exactly as the reference implementation's 32-bit
/// shift did. A 96 kHz rate is the only value that reaches the wrap.
fn fixed16_16(value: u32) -> u32 {
    ((value as u64) << 16) as u32
}

/// The unity 3x3 display matrix every track here uses, in 16.16 fixed point.
fn identity_matrix(buf: &mut Buf) {
    buf.u32(0x0001_0000).u32(0).u32(0);
    buf.u32(0).u32(0x0001_0000).u32(0);
    buf.u32(0).u32(0).u32(0x4000_0000);
}

fn make_init_segment(
    width: u32,
    height: u32,
    sps: &[u8],
    pps: &[u8],
    sample_aspect_ratio: Option<SampleAspectRatio>,
    audio: Option<&AacConfig>,
) -> Result<Vec<u8>> {
    let ftyp = {
        let mut body = Buf::new();
        body.ascii("isom").u32(0x200).ascii("isomiso6mp41avc1");
        boxed("ftyp", &body.into_vec())
    };
    let mvhd = {
        let mut body = Buf::new();
        body.u32(0).u32(0).u32(TIMESCALE).u32(0);
        body.u32(0x0001_0000).u16(0x0100).u16(0).zeros(8);
        identity_matrix(&mut body);
        // next_track_ID, past every track this movie declares.
        body.zeros(24).u32(if audio.is_some() { 3 } else { 2 });
        full_box("mvhd", 0, 0, &body.into_vec())
    };
    let tkhd = {
        let mut body = Buf::new();
        body.u32(0).u32(0).u32(1).u32(0).u32(0).zeros(8);
        body.u16(0).u16(0).u16(0).u16(0);
        identity_matrix(&mut body);
        body.u32(fixed16_16(width)).u32(fixed16_16(height));
        full_box("tkhd", 0, 7, &body.into_vec())
    };
    let mdhd = {
        let mut body = Buf::new();
        body.u32(0).u32(0).u32(TIMESCALE).u32(0).u16(0x55c4).u16(0);
        full_box("mdhd", 0, 0, &body.into_vec())
    };
    let hdlr = {
        let mut body = Buf::new();
        body.u32(0).ascii("vide").zeros(12).ascii("VideoHandler\0");
        full_box("hdlr", 0, 0, &body.into_vec())
    };
    let vmhd = {
        let mut body = Buf::new();
        body.u16(0).u16(0).u16(0).u16(0);
        full_box("vmhd", 0, 1, &body.into_vec())
    };
    let url = full_box("url ", 0, 1, &[]);
    let dref = {
        let mut body = Buf::new();
        body.u32(1).bytes(&url);
        full_box("dref", 0, 0, &body.into_vec())
    };
    let dinf = boxed("dinf", &dref);
    let avc1 = {
        let mut body = Buf::new();
        body.zeros(6).u16(1).zeros(16);
        body.u16(width as u16).u16(height as u16);
        body.u32(fixed16_16(72))
            .u32(fixed16_16(72))
            .u32(0)
            .u16(1)
            .zeros(32);
        body.u16(0x18).u16(0xffff).bytes(&make_avc_c(sps, pps)?);
        if let Some(sar) = sample_aspect_ratio {
            let mut pasp = Buf::new();
            pasp.u32(sar.width).u32(sar.height);
            body.bytes(&boxed("pasp", &pasp.into_vec()));
        }
        boxed("avc1", &body.into_vec())
    };
    let stsd = {
        let mut body = Buf::new();
        body.u32(1).bytes(&avc1);
        full_box("stsd", 0, 0, &body.into_vec())
    };
    let mut empty_count = Buf::new();
    empty_count.u32(0);
    let mut empty_pair = Buf::new();
    empty_pair.u32(0).u32(0);
    let stbl = boxed(
        "stbl",
        &concat(&[
            &stsd,
            &full_box("stts", 0, 0, &empty_count.0),
            &full_box("stsc", 0, 0, &empty_count.0),
            &full_box("stsz", 0, 0, &empty_pair.0),
            &full_box("stco", 0, 0, &empty_count.0),
        ]),
    );
    let minf = boxed("minf", &concat(&[&vmhd, &dinf, &stbl]));
    let mdia = boxed("mdia", &concat(&[&mdhd, &hdlr, &minf]));
    let trak = boxed("trak", &concat(&[&tkhd, &mdia]));
    let trex = {
        let mut body = Buf::new();
        body.u32(1).u32(1).u32(0).u32(0).u32(0);
        full_box("trex", 0, 0, &body.into_vec())
    };

    let (audio_trak, audio_trex) = match audio {
        None => (Vec::new(), Vec::new()),
        Some(audio) => {
            let audio_tkhd = {
                let mut body = Buf::new();
                body.u32(0).u32(0).u32(2).u32(0).u32(0).zeros(8);
                // Full volume, and no width or height: this track has no picture.
                body.u16(0).u16(0).u16(0x0100).u16(0);
                identity_matrix(&mut body);
                body.u32(0).u32(0);
                full_box("tkhd", 0, 7, &body.into_vec())
            };
            let audio_mdhd = {
                let mut body = Buf::new();
                body.u32(0)
                    .u32(0)
                    .u32(audio.sample_rate)
                    .u32(0)
                    .u16(0x55c4)
                    .u16(0);
                full_box("mdhd", 0, 0, &body.into_vec())
            };
            let audio_hdlr = {
                let mut body = Buf::new();
                body.u32(0).ascii("soun").zeros(12).ascii("SoundHandler\0");
                full_box("hdlr", 0, 0, &body.into_vec())
            };
            let smhd = {
                let mut body = Buf::new();
                body.u16(0).u16(0);
                full_box("smhd", 0, 0, &body.into_vec())
            };
            let mp4a = {
                let mut body = Buf::new();
                body.zeros(6).u16(1).zeros(8);
                body.u16(audio.channel_count as u16).u16(16);
                body.u16(0)
                    .u16(0)
                    .u32(fixed16_16(audio.sample_rate))
                    .bytes(&make_esds(audio));
                boxed("mp4a", &body.into_vec())
            };
            let audio_stsd = {
                let mut body = Buf::new();
                body.u32(1).bytes(&mp4a);
                full_box("stsd", 0, 0, &body.into_vec())
            };
            let audio_stbl = boxed(
                "stbl",
                &concat(&[
                    &audio_stsd,
                    &full_box("stts", 0, 0, &empty_count.0),
                    &full_box("stsc", 0, 0, &empty_count.0),
                    &full_box("stsz", 0, 0, &empty_pair.0),
                    &full_box("stco", 0, 0, &empty_count.0),
                ]),
            );
            let audio_minf = boxed("minf", &concat(&[&smhd, &dinf, &audio_stbl]));
            let audio_mdia = boxed("mdia", &concat(&[&audio_mdhd, &audio_hdlr, &audio_minf]));
            let mut trex_body = Buf::new();
            trex_body.u32(2).u32(1).u32(0).u32(0).u32(0);
            (
                boxed("trak", &concat(&[&audio_tkhd, &audio_mdia])),
                full_box("trex", 0, 0, &trex_body.into_vec()),
            )
        }
    };

    let mvex = boxed("mvex", &concat(&[&trex, &audio_trex]));
    let moov = boxed("moov", &concat(&[&mvhd, &trak, &audio_trak, &mvex]));
    Ok(concat(&[&ftyp, &moov]))
}

fn length_prefixed(nal: &[u8]) -> Vec<u8> {
    let mut out = Buf::new();
    out.u32(nal.len() as u32).bytes(nal);
    out.into_vec()
}

/// Each sample as the `mdat` carries it: length-prefixed NAL units, with any
/// parameter-set-adjacent SEI prepended to the first sample.
fn make_video_payloads(
    samples: &[VideoSample<'_>],
    first_sample_prefixes: &[&[u8]],
) -> Vec<Vec<u8>> {
    samples
        .iter()
        .enumerate()
        .map(|(index, sample)| {
            if index == 0 && !first_sample_prefixes.is_empty() {
                let mut out = Vec::new();
                for prefix in first_sample_prefixes {
                    out.extend_from_slice(&length_prefixed(prefix));
                }
                for nal in sample {
                    out.extend_from_slice(&length_prefixed(nal));
                }
                out
            } else {
                sample.iter().flat_map(|nal| length_prefixed(nal)).collect()
            }
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn make_media_segment(
    samples: &[VideoSample<'_>],
    durations: &[u32],
    compositions: &[u32],
    sync_samples: &[bool],
    sequence_number: u32,
    base_decode_time: u64,
    first_sample_prefixes: &[&[u8]],
) -> Vec<u8> {
    let payloads = make_video_payloads(samples, first_sample_prefixes);
    let mut entries = Buf::new();
    for i in 0..samples.len() {
        entries.u32(durations[i]);
        entries.u32(payloads[i].len() as u32);
        // sample_flags: non-reference and non-sync unless the NAL is an IDR.
        entries.u32(if sync_samples[i] {
            0x0200_0000
        } else {
            0x0101_0000
        });
        entries.u32(compositions[i]);
    }
    let entries = entries.into_vec();

    let make_moof = |data_offset: u32| {
        let mfhd = {
            let mut body = Buf::new();
            body.u32(sequence_number);
            full_box("mfhd", 0, 0, &body.into_vec())
        };
        let tfhd = {
            let mut body = Buf::new();
            body.u32(1);
            full_box("tfhd", 0, 0x020000, &body.into_vec())
        };
        let tfdt = {
            let mut body = Buf::new();
            // Version 1: a session resumed mid-file starts where it sits in the
            // whole presentation, and 32 bits of 90 kHz ticks runs out after
            // thirteen hours.
            body.u64(base_decode_time);
            full_box("tfdt", 1, 0, &body.into_vec())
        };
        let trun = {
            let mut body = Buf::new();
            body.u32(samples.len() as u32)
                .u32(data_offset)
                .bytes(&entries);
            full_box("trun", 1, 0x000f01, &body.into_vec())
        };
        let traf = boxed("traf", &concat(&[&tfhd, &tfdt, &trun]));
        boxed("moof", &concat(&[&mfhd, &traf]))
    };
    // The data offset is relative to the moof, whose size depends on the offset
    // only through its fixed-width field, so one rebuild settles it.
    let moof = make_moof(0);
    let moof = make_moof(moof.len() as u32 + 8);
    let mdat_payload: Vec<u8> = payloads.concat();
    concat(&[&moof, &boxed("mdat", &mdat_payload)])
}

/// One fragment carrying both tracks, so an MSE implementation sees a `traf`
/// for each in the same `moof` rather than two interleaved fragment streams.
#[allow(clippy::too_many_arguments)]
fn make_av_media_segment(
    video_samples: &[VideoSample<'_>],
    durations: &[u32],
    compositions: &[u32],
    sync_samples: &[bool],
    audio_samples: &[Vec<u8>],
    sequence_number: u32,
    video_base_decode_time: u64,
    audio_base_decode_time: u64,
    first_sample_prefixes: &[&[u8]],
) -> Vec<u8> {
    let prefix_bytes: usize = first_sample_prefixes.iter().map(|nal| 4 + nal.len()).sum();
    let video_bytes: usize = video_samples
        .iter()
        .flatten()
        .map(|nal| 4 + nal.len())
        .sum::<usize>()
        + prefix_bytes;
    let mut video_entries = Buf::new();
    for i in 0..video_samples.len() {
        let sample_bytes: usize = video_samples[i]
            .iter()
            .map(|nal| 4 + nal.len())
            .sum::<usize>()
            + if i == 0 { prefix_bytes } else { 0 };
        video_entries.u32(durations[i]);
        video_entries.u32(sample_bytes as u32);
        video_entries.u32(if sync_samples[i] {
            0x0200_0000
        } else {
            0x0101_0000
        });
        video_entries.u32(compositions[i]);
    }
    let video_entries = video_entries.into_vec();
    let mut audio_entries = Buf::new();
    for sample in audio_samples {
        audio_entries.u32(AAC_FRAME_SAMPLES as u32);
        audio_entries.u32(sample.len() as u32);
    }
    let audio_entries = audio_entries.into_vec();
    let make_moof = |video_offset: u32, audio_offset: u32| {
        let mfhd = {
            let mut body = Buf::new();
            body.u32(sequence_number);
            full_box("mfhd", 0, 0, &body.into_vec())
        };
        let traf = |track: u32,
                    base_decode_time: u64,
                    offset: u32,
                    entries: &[u8],
                    count: usize,
                    version: u8,
                    flags: u32| {
            let mut tfhd_body = Buf::new();
            tfhd_body.u32(track);
            let mut tfdt_body = Buf::new();
            tfdt_body.u64(base_decode_time);
            let mut trun_body = Buf::new();
            trun_body.u32(count as u32).u32(offset).bytes(entries);
            boxed(
                "traf",
                &concat(&[
                    &full_box("tfhd", 0, 0x020000, &tfhd_body.into_vec()),
                    // Version 1: see the video-only segment above.
                    &full_box("tfdt", 1, 0, &tfdt_body.into_vec()),
                    &full_box("trun", version, flags, &trun_body.into_vec()),
                ]),
            )
        };
        // A track with nothing in this fragment takes no traf: the audio of a
        // recording runs out before its video does, and a trun describing no
        // samples is not something to hand a parser.
        let mut parts = vec![mfhd];
        if !video_samples.is_empty() {
            parts.push(traf(
                1,
                video_base_decode_time,
                video_offset,
                &video_entries,
                video_samples.len(),
                1,
                0x000f01,
            ));
        }
        if !audio_samples.is_empty() {
            parts.push(traf(
                2,
                audio_base_decode_time,
                audio_offset,
                &audio_entries,
                audio_samples.len(),
                0,
                0x000301,
            ));
        }
        let parts: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
        boxed("moof", &concat(&parts))
    };
    let moof = make_moof(0, 0);
    let payload_start = moof.len() as u32 + 8;
    let moof = make_moof(payload_start, payload_start + video_bytes as u32);

    let audio_bytes: usize = audio_samples.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(moof.len() + 8 + video_bytes + audio_bytes);
    out.extend_from_slice(&moof);
    out.extend_from_slice(&((8 + video_bytes + audio_bytes) as u32).to_be_bytes());
    out.extend_from_slice(b"mdat");
    for (index, sample) in video_samples.iter().enumerate() {
        if index == 0 {
            for prefix in first_sample_prefixes {
                out.extend_from_slice(&(prefix.len() as u32).to_be_bytes());
                out.extend_from_slice(prefix);
            }
        }
        for nal in sample {
            out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
            out.extend_from_slice(nal);
        }
    }
    for sample in audio_samples {
        out.extend_from_slice(sample);
    }
    out
}

#[derive(Clone, Debug)]
pub struct Fmp4Output {
    pub init_segment: Vec<u8>,
    pub media_segment: Vec<u8>,
    pub mime_codec: String,
    pub sample_count: usize,
}

/// Package this transcoder's Annex B output as one video-only presentation.
pub fn h264_to_fmp4(h264: &[u8], timeline: &Mpeg2VideoTimeline) -> Result<Fmp4Output> {
    let nals = split_annex_b(h264);
    let nal_type = |nal: &&[u8]| nal[0] & 0x1f;
    let sps = nals.iter().find(|nal| nal_type(nal) == 7).copied();
    let pps = nals.iter().find(|nal| nal_type(nal) == 8).copied();
    let sei = nals.iter().find(|nal| nal_type(nal) == 6).copied();
    let samples = video_samples(&nals);
    let (Some(sps), Some(pps)) = (sps, pps) else {
        bail!("H.264 stream lacks SPS or PPS");
    };
    let has_idr_clone = samples.len() == timeline.presentation_indices.len() + 1;
    let expected = timeline.presentation_indices.len() + usize::from(has_idr_clone);
    if samples.len() != expected {
        bail!(
            "H.264 sample count {} does not match MPEG-2 timeline {expected}",
            samples.len()
        );
    }
    let timing = mpeg2_sample_timing(timeline, has_idr_clone);
    let sync_samples: Vec<bool> = samples
        .iter()
        .map(|sample| sample.iter().any(|nal| nal[0] & 0x1f == 5))
        .collect();
    let codec = format!("{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]);
    let prefixes: Vec<&[u8]> = sei.into_iter().collect();

    Ok(Fmp4Output {
        init_segment: make_init_segment(
            timeline.width,
            timeline.height,
            sps,
            pps,
            timeline.sample_aspect_ratio,
            None,
        )?,
        media_segment: make_media_segment(
            &samples,
            &timing.durations,
            &timing.compositions,
            &sync_samples,
            1,
            0,
            &prefixes,
        ),
        mime_codec: format!("video/mp4; codecs=\"avc1.{codec}\""),
        sample_count: samples.len(),
    })
}

/// How much of the presentation one fragment covers. The caller needs this
/// before it can decide how much audio belongs in the same fragment, which is
/// why it is separate from the muxing.
pub fn mpeg2_fragment_duration(timeline: &Mpeg2VideoTimeline, starts_at_idr: bool) -> u64 {
    mpeg2_sample_timing(timeline, starts_at_idr)
        .durations
        .iter()
        .map(|&d| d as u64)
        .sum()
}

/// The AAC access units that share a fragment with the video, and where the
/// audio track's own timeline has reached.
#[derive(Clone, Debug)]
pub struct Fmp4AudioSamples {
    pub config: AacConfig,
    pub samples: Vec<Vec<u8>>,
    pub base_decode_time: u64,
}

#[derive(Clone, Debug)]
pub struct Fmp4Fragment {
    /// Empty for every fragment after the first: the transcoder emits the
    /// parameter sets once, and MSE needs the initialization segment once.
    pub init_segment: Vec<u8>,
    pub media_segment: Vec<u8>,
    /// Empty when this fragment carries no parameter sets to describe.
    pub mime_codec: String,
    pub sample_count: usize,
    /// Presentation time this fragment covers; see [`mpeg2_sample_timing`].
    pub duration: u64,
}

/// Package one independently transcoded GOP for incremental appending.
///
/// `presentation_start` is the media time of the fragment's first displayed
/// picture, in the 90 kHz movie timescale.
pub fn h264_gop_to_fmp4(
    h264: &[u8],
    timeline: &Mpeg2VideoTimeline,
    sequence_number: u32,
    presentation_start: u64,
    audio: Option<&AacConfig>,
    audio_track: Option<&Fmp4AudioSamples>,
) -> Result<Fmp4Fragment> {
    let nals = split_annex_b(h264);
    let nal_type = |nal: &&[u8]| nal[0] & 0x1f;
    let sps = nals.iter().find(|nal| nal_type(nal) == 7).copied();
    let pps = nals.iter().find(|nal| nal_type(nal) == 8).copied();
    let sei = nals.iter().find(|nal| nal_type(nal) == 6).copied();
    let samples = video_samples(&nals);

    let has_idr_clone = samples.len() == timeline.presentation_indices.len() + 1;
    let expected = timeline.presentation_indices.len() + usize::from(has_idr_clone);
    if samples.len() != expected {
        bail!(
            "H.264 GOP sample count {} does not match MPEG-2 timeline {expected}",
            samples.len()
        );
    }
    let timing = mpeg2_sample_timing(timeline, has_idr_clone);
    // Decoding runs ahead of display by the reorder delay; a fragment at the
    // very start of the timeline has nowhere to put it and simply displays that
    // much later.
    let base_decode_time = presentation_start.saturating_sub(timing.reorder_delay as u64);
    let sync_samples: Vec<bool> = samples
        .iter()
        .map(|sample| sample.iter().any(|nal| nal[0] & 0x1f == 5))
        .collect();
    let prefixes: Vec<&[u8]> = sei.into_iter().collect();

    let media_segment = match audio_track {
        Some(track) => make_av_media_segment(
            &samples,
            &timing.durations,
            &timing.compositions,
            &sync_samples,
            &track.samples,
            sequence_number,
            base_decode_time,
            track.base_decode_time,
            &prefixes,
        ),
        None => make_media_segment(
            &samples,
            &timing.durations,
            &timing.compositions,
            &sync_samples,
            sequence_number,
            base_decode_time,
            &prefixes,
        ),
    };

    let (init_segment, mime_codec) = match (sps, pps) {
        (Some(sps), Some(pps)) => {
            let codec = format!("{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]);
            let audio_codec = if audio.is_some() { ",mp4a.40.2" } else { "" };
            (
                make_init_segment(
                    timeline.width,
                    timeline.height,
                    sps,
                    pps,
                    timeline.sample_aspect_ratio,
                    audio,
                )?,
                format!("video/mp4; codecs=\"avc1.{codec}{audio_codec}\""),
            )
        }
        _ => (Vec::new(), String::new()),
    };

    Ok(Fmp4Fragment {
        init_segment,
        media_segment,
        mime_codec,
        sample_count: samples.len(),
        duration: timing.durations.iter().map(|&d| d as u64).sum(),
    })
}
