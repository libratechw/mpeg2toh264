//! Packaging this transcoder's Annex B output as a fragmented MP4.

use crate::error::{bail, Result};
use crate::mpeg2::constants::{PictureType, FRAME_RATE};
use crate::mpeg2::headers::{
    parse_elementary_stream, sequence_sample_aspect_ratio, SampleAspectRatio,
};
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

#[derive(Clone, Debug)]
pub struct Mpeg2VideoTimeline {
    pub width: u32,
    pub height: u32,
    pub sample_duration: u32,
    /// Presentation index for each coded picture, excluding the IDR clone.
    pub presentation_indices: Vec<u32>,
    pub sample_aspect_ratio: Option<SampleAspectRatio>,
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
    let mut gop_base: u32 = 0;
    let mut seen_picture = false;
    let mut max_tr_in_gop: u32 = 0;
    let mut presentation_indices = Vec::new();
    for picture in &pictures {
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
        body.zeros(24).u32(2);
        full_box("mvhd", 0, 0, &body.into_vec())
    };
    let tkhd = {
        let mut body = Buf::new();
        body.u32(0).u32(0).u32(1).u32(0).u32(0).zeros(8);
        body.u16(0).u16(0).u16(0).u16(0);
        identity_matrix(&mut body);
        body.u32(width << 16).u32(height << 16);
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
        body.u32(72 << 16).u32(72 << 16).u32(0).u16(1).zeros(32);
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
    let mvex = boxed("mvex", &trex);
    let moov = boxed("moov", &concat(&[&mvhd, &trak, &mvex]));
    Ok(concat(&[&ftyp, &moov]))
}

fn length_prefixed(nal: &[u8]) -> Vec<u8> {
    let mut out = Buf::new();
    out.u32(nal.len() as u32).bytes(nal);
    out.into_vec()
}

/// Each sample as the `mdat` carries it: length-prefixed NAL units, with any
/// parameter-set-adjacent SEI prepended to the first sample.
fn make_video_payloads(samples: &[&[u8]], first_sample_prefixes: &[&[u8]]) -> Vec<Vec<u8>> {
    samples
        .iter()
        .enumerate()
        .map(|(index, sample)| {
            if index == 0 && !first_sample_prefixes.is_empty() {
                let mut out = Vec::new();
                for prefix in first_sample_prefixes {
                    out.extend_from_slice(&length_prefixed(prefix));
                }
                out.extend_from_slice(&length_prefixed(sample));
                out
            } else {
                length_prefixed(sample)
            }
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn make_media_segment(
    samples: &[&[u8]],
    durations: &[u32],
    compositions: &[u32],
    sync_samples: &[bool],
    sequence_number: u32,
    base_decode_time: u32,
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
            body.u32(base_decode_time);
            full_box("tfdt", 0, 0, &body.into_vec())
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
    let samples: Vec<&[u8]> = nals
        .iter()
        .filter(|nal| matches!(nal_type(nal), 1 | 5))
        .copied()
        .collect();
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
    let sync_samples: Vec<bool> = samples.iter().map(|nal| nal[0] & 0x1f == 5).collect();
    let codec = format!("{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]);
    let prefixes: Vec<&[u8]> = sei.into_iter().collect();

    Ok(Fmp4Output {
        init_segment: make_init_segment(
            timeline.width,
            timeline.height,
            sps,
            pps,
            timeline.sample_aspect_ratio,
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
