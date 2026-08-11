//! Packaging this transcoder's Annex B output as a fragmented MP4.

use crate::container::adts::{AacConfig, AAC_FRAME_SAMPLES};
use crate::error::{bail, Result};
use crate::mpeg2::constants::{start_code, PictureStructure, PictureType, FRAME_RATE};
use crate::mpeg2::headers::{
    parse_elementary_stream, picture_sequence_description, pictures_interlacing,
    sequence_sample_aspect_ratio, Interlacing, Picture, SampleAspectRatio,
};
use crate::round_half_up;
use crate::TranscodeOptions;

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

/// The video samples of one fragment, and how the sample entry says to read
/// them.
///
/// Two shapes reach the same `mdat`: AVC, whose access units are NAL units the
/// `avcC` says are length-prefixed, and MPEG-2 carried through untouched, whose
/// samples are elementary stream bytes with their own start codes. Everything
/// downstream needs is a size and a way to write, so that is what this is.
struct VideoPayload<'a> {
    samples: Vec<VideoSample<'a>>,
    length_prefixed: bool,
}

impl<'a> VideoPayload<'a> {
    /// AVC access units, with anything belonging ahead of the first sample --
    /// parameter-set-adjacent SEI -- prepended to it.
    fn avc(mut samples: Vec<VideoSample<'a>>, prefixes: &[&'a [u8]]) -> Self {
        if let Some(first) = samples.first_mut() {
            first.splice(0..0, prefixes.iter().copied());
        }
        Self {
            samples,
            length_prefixed: true,
        }
    }

    fn mpeg2(samples: Vec<VideoSample<'a>>) -> Self {
        Self {
            samples,
            length_prefixed: false,
        }
    }

    fn len(&self) -> usize {
        self.samples.len()
    }

    fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    fn sample_bytes(&self, index: usize) -> usize {
        let prefix = if self.length_prefixed { 4 } else { 0 };
        self.samples[index]
            .iter()
            .map(|part| prefix + part.len())
            .sum()
    }

    fn total_bytes(&self) -> usize {
        (0..self.samples.len()).map(|i| self.sample_bytes(i)).sum()
    }

    fn write_sample(&self, index: usize, out: &mut Vec<u8>) {
        for part in &self.samples[index] {
            if self.length_prefixed {
                out.extend_from_slice(&(part.len() as u32).to_be_bytes());
            }
            out.extend_from_slice(part);
        }
    }
}

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

/// The access unit immediately following a recovery-point SEI.
fn recovery_sample_index(nals: &[&[u8]]) -> Option<usize> {
    let has_aud = nals.iter().any(|nal| nal[0] & 0x1f == 9);
    let mut completed = 0usize;
    let mut current_vcl = false;
    for nal in nals {
        match nal[0] & 0x1f {
            9 if has_aud => {
                completed += usize::from(current_vcl);
                current_vcl = false;
            }
            1 | 5 => {
                if !has_aud {
                    completed += 1;
                } else {
                    current_vcl = true;
                }
            }
            6 if nal.get(1) == Some(&6) => return Some(completed),
            _ => {}
        }
    }
    None
}

#[derive(Clone, Debug)]
pub struct Mpeg2VideoTimeline {
    pub width: u32,
    pub height: u32,
    pub sample_duration: u32,
    /// Presentation time of each coded picture, relative to the first display
    /// slot in the unit. Parallel with `presentation_indices`.
    pub presentation_times: Vec<u64>,
    /// Display duration of each coded picture. MPEG-2 `repeat_first_field`
    /// makes this longer than `sample_duration` for telecined material.
    /// Parallel with `presentation_indices`.
    pub sample_durations: Vec<u32>,
    /// Presentation index for each coded picture, excluding the IDR clone.
    pub presentation_indices: Vec<u32>,
    /// Whether each coded picture is a complementary field pair rather than a
    /// frame. Parallel with `presentation_indices`.
    pub field_pairs: Vec<bool>,
    /// Whether the transcoder gave each field of a pair its own access unit,
    /// which makes such a picture occupy two MP4 samples instead of one. Set by
    /// the caller from [`TranscodeOptions::split_field_samples`]; parsing the
    /// source cannot tell. [`mpeg2_video_timeline`] fills it in to match that
    /// option's default, so a caller that transcodes with the defaults and
    /// never touches this still counts the same samples the bitstream holds.
    ///
    /// [`TranscodeOptions::split_field_samples`]: crate::TranscodeOptions::split_field_samples
    pub split_field_samples: bool,
    pub sample_aspect_ratio: Option<SampleAspectRatio>,
    /// Extra ticks the unit's opening sample is held for, covering a hole
    /// between the unit before it and this one.
    ///
    /// A unit's pictures are timed against each other, and the units are
    /// appended end to end, so a stretch the source lost would simply close up
    /// -- the picture and the sound would keep playing, a little earlier than
    /// they belong, and the captions alongside them, which carry their own
    /// timestamps, would no longer line up. Holding the opening sample over the
    /// hole instead leaves everything where the source put it. Set by the
    /// caller, which is the only one that knows where the unit before this
    /// ended; zero for a unit that follows without a break.
    ///
    /// It goes to the sample that covers the unit's leading display slots -- an
    /// IDR clone or the first picture -- so a caller that sets it asks for a
    /// random access point as well.
    pub hold_ticks: u32,
    /// What the source pictures said about their fields. Nothing in the MP4
    /// carries this -- H.264 could say it in a picture timing SEI, and the
    /// browsers that would read one do not deinterlace anyway -- so it is
    /// reported alongside instead, for a player that filters the picture
    /// itself.
    pub interlacing: Interlacing,
}

impl Mpeg2VideoTimeline {
    /// Whether the picture at this decode position is a complementary field
    /// pair. A caller that filled in the indices but not `field_pairs` gets
    /// what it would have got before the field ever existed: frames.
    fn is_field_pair(&self, decode_index: usize) -> bool {
        self.field_pairs.get(decode_index).copied().unwrap_or(false)
    }

    fn duration_at(&self, decode_index: usize) -> u32 {
        self.sample_durations
            .get(decode_index)
            .copied()
            .unwrap_or(self.sample_duration)
    }

    fn presentation_time_at(&self, decode_index: usize) -> u64 {
        self.presentation_times
            .get(decode_index)
            .copied()
            .unwrap_or_else(|| {
                u64::from(
                    self.presentation_indices
                        .get(decode_index)
                        .copied()
                        .unwrap_or(1)
                        .saturating_sub(1),
                ) * u64::from(self.sample_duration)
            })
    }

    pub(crate) fn first_presentation_time(&self) -> u64 {
        (0..self.presentation_indices.len())
            .map(|index| self.presentation_time_at(index))
            .min()
            .unwrap_or(0)
    }

    /// Presentation time of the first picture in coding order. A GOP's PES
    /// timestamp belongs here, even when leading B pictures display earlier.
    pub(crate) fn first_coded_presentation_time(&self) -> u64 {
        self.presentation_time_at(0)
    }
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
            // The two fields of a frame need not be coded the same way. The
            // second field of an intra frame is routinely predicted from the
            // first, which puts a P field beside an I one, and refusing the
            // pair over that leaves the frame with neither of its halves --
            // and every picture that predicts from it wrong until the next
            // intra picture puts them right.
            && matches!(
                (
                    picture.header.picture_coding_type,
                    mate.header.picture_coding_type
                ),
                (PictureType::I, PictureType::I)
                    | (PictureType::I, PictureType::P)
                    | (PictureType::P, PictureType::P)
                    | (PictureType::B, PictureType::B)
            )
    })
}

/// One source picture the timeline kept, and the bytes it was coded in.
///
/// The range runs from the end of the picture before it, so the sequence and
/// group headers between two pictures belong to the one that follows them --
/// which is what makes a sample that opens a fragment decodable on its own.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Mpeg2Sample {
    pub start: usize,
    /// Where the first field of a complementary pair ends, when this picture is
    /// one. A caller splitting field samples cuts here; one that is not ignores
    /// it and carries the pair whole, as the two coded pictures it already is.
    pub field_end: Option<usize>,
    pub end: usize,
    /// Whether a decoder can begin at this sample, i.e. an intra picture.
    pub sync: bool,
}

/// One unit of MPEG-2 video, cut into the samples an MP4 carries it as.
#[derive(Clone, Debug)]
pub struct Mpeg2Unit {
    pub timeline: Mpeg2VideoTimeline,
    /// In decode order, one per entry of `timeline.presentation_indices`.
    pub samples: Vec<Mpeg2Sample>,
    /// How many bytes of sequence header the unit opens with, which is what a
    /// passthrough MP4 declares as the decoder configuration. Zero for a unit
    /// that does not begin with one.
    pub sequence_header_len: usize,
}

/// Reproduce the transcoder's accepted-picture timeline in MP4 timescale units.
///
/// `has_references` is set when the unit continues an already-populated decoded
/// picture buffer, so its leading B pictures are codeable.
///
/// `undecodable`, indexed by source picture, names the pictures the transcoder
/// found damaged. The timeline must reserve a sample for each picture the
/// transcoder emits and no others, and this is how it is told which those are;
/// an empty slice means none were, which is the ordinary case.
pub fn mpeg2_video_timeline(
    data: &[u8],
    has_references: bool,
    undecodable: &[bool],
) -> Result<Mpeg2VideoTimeline> {
    Ok(walk_pictures(data, has_references, undecodable)?.timeline)
}

/// Cut a unit into the samples a passthrough MP4 carries, alongside the same
/// timeline the transcoding path would build for it.
///
/// The pictures kept here are exactly the pictures the transcoder would code,
/// bar the ones it drops for being undecodable: nothing is decoded on this
/// path, and a damaged slice is the decoder's business rather than this one's.
pub fn mpeg2_passthrough_unit(data: &[u8], has_references: bool) -> Result<Mpeg2Unit> {
    walk_pictures(data, has_references, &[])
}

/// Walk a unit's pictures, keeping the ones that can be coded or carried.
///
/// Nothing is decoded here. A picture is kept if it has slices at all and was
/// not named in `undecodable`, which is what the transcoder reports back once
/// it has tried; passthrough hands the bytes on untouched and names nothing,
/// since a damaged slice is then the decoder's business rather than this one's.
fn walk_pictures(data: &[u8], has_references: bool, undecodable: &[bool]) -> Result<Mpeg2Unit> {
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
    // What this unit is described by, which is what its pictures have to be
    // coded under to belong to it.
    let description = picture_sequence_description(first);

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
    // Indexed by the one-based presentation index. Missing entries retain two
    // ordinary fields: temporal_reference can have holes where damaged source
    // pictures were absent altogether.
    let mut display_fields = vec![2u8];
    let mut field_pairs = Vec::new();
    let mut samples = Vec::new();
    let mut picture_index = 0;
    // Where the picture in hand starts, which is where the one before it ended.
    // A picture that is dropped leaves its bytes to the sample that follows,
    // since a sequence header among them describes that picture too.
    let mut sample_start = 0;
    while picture_index < pictures.len() {
        let picture = &pictures[picture_index];
        // Where this picture sits among the unit's own, which is how the
        // transcoder names the ones it could not decode.
        let source_index = picture_index;
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
        // Where this picture's bytes end, and so where the next one's begin,
        // whether or not this one is kept. A field pair is cut at its middle
        // as well, for a caller that wants each field carried on its own.
        let start = sample_start;
        let field_end = mate.map(|_| picture_end(picture, start));
        sample_start = picture_end(mate.unwrap_or(picture), start);
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
        let presentation_index = (gop_base + tr + 1) as usize;
        if display_fields.len() <= presentation_index {
            display_fields.resize(presentation_index + 1, 2);
        }
        display_fields[presentation_index] = if picture.coding.picture_structure
            == PictureStructure::Frame
            && picture.coding.repeat_first_field
        {
            3
        } else {
            2
        };
        // A lone field is no frame, and the transcoder drops it for the same
        // reason. Both have to, or the timeline reserves a sample the H.264
        // stream does not hold.
        if unpaired {
            continue;
        }
        // Nor is a picture coded under a description other than the one this
        // unit opens with: the parameter sets in front of it describe that one,
        // and the transcoder drops it for the same reason.
        if picture_sequence_description(picture) != description {
            continue;
        }
        let kept = |index: usize, picture: &Picture| {
            !picture.slices.is_empty() && !undecodable.get(index).copied().unwrap_or(false)
        };
        let decodable =
            kept(source_index, picture) && mate.is_none_or(|field| kept(source_index + 1, field));
        if !decodable {
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
        field_pairs.push(mate.is_some());
        samples.push(Mpeg2Sample {
            start,
            field_end,
            end: sample_start,
            sync: picture_type == PictureType::I,
        });
        if picture_type != PictureType::B {
            references = (references + 1).min(2);
        }
    }
    // Round positions on the continuous field clock, not every RFF picture in
    // isolation. At 30000/1001 fps a field is 1501.5 ticks, so successive
    // three-field pictures must alternate between 4505 and 4504 ticks instead
    // of gaining half a tick apiece.
    let field_ticks = TIMESCALE as f64 * denominator / numerator / 2.0;
    let mut starts = vec![0u64; display_fields.len()];
    let mut display_durations = vec![sample_duration; display_fields.len()];
    let mut fields = 0u64;
    for index in 1..display_fields.len() {
        starts[index] = round_half_up(fields as f64 * field_ticks) as u64;
        fields += u64::from(display_fields[index]);
        let end = round_half_up(fields as f64 * field_ticks) as u64;
        display_durations[index] = (end - starts[index]) as u32;
    }
    let presentation_times = presentation_indices
        .iter()
        .map(|&index| starts[index as usize])
        .collect();
    let sample_durations = presentation_indices
        .iter()
        .map(|&index| display_durations[index as usize])
        .collect();
    Ok(Mpeg2Unit {
        timeline: Mpeg2VideoTimeline {
            width: first.sequence.horizontal_size,
            height: first.sequence.vertical_size,
            sample_duration,
            presentation_times,
            sample_durations,
            presentation_indices,
            field_pairs,
            split_field_samples: TranscodeOptions::default().split_field_samples,
            sample_aspect_ratio: sequence_sample_aspect_ratio(&first.sequence),
            hold_ticks: 0,
            interlacing: pictures_interlacing(&pictures),
        },
        samples,
        sequence_header_len: sequence_header_len(data),
    })
}

/// How many MP4 samples the timeline's pictures occupy, before the IDR clone.
/// One each, unless split field pairs are taking two.
fn content_sample_count(timeline: &Mpeg2VideoTimeline) -> usize {
    let pictures = timeline.presentation_indices.len();
    let split_pairs = if timeline.split_field_samples {
        (0..pictures)
            .filter(|&at| timeline.is_field_pair(at))
            .count()
    } else {
        0
    };
    pictures + split_pairs
}

/// Validate the samples synthesized around a random-access point and return
/// how many timing entries they need. An ordinary IDR has one reference clone.
/// Recovery in IDR mode has an IDR copy plus its clone; when that copied source
/// picture is a split field pair, the IDR copy itself occupies two samples.
fn recovery_extra_samples(
    sample_count: usize,
    content_samples: usize,
    recovery_copy: bool,
    split_field_samples: bool,
) -> Option<usize> {
    let extra = sample_count.checked_sub(content_samples)?;
    if recovery_copy {
        (extra == 2 || (split_field_samples && extra == 3)).then_some(extra)
    } else {
        (extra <= 1).then_some(extra)
    }
}

/// Where a picture's coded data ends, which is the start code that terminated
/// its last slice. A picture with no slices at all ends where it began.
pub(crate) fn picture_end(picture: &Picture, start: usize) -> usize {
    picture
        .slices
        .last()
        .and_then(|slice| slice.data_end_bit)
        .map_or(start, |bit| bit / 8)
}

/// How much of a unit is the sequence header block that opens it: everything
/// ahead of its first group or picture header.
///
/// This is the decoder configuration a passthrough MP4 declares, and the only
/// part of the unit that a sample which does not begin at byte zero still
/// needs. The scan stops at the first header of a picture, so it walks the few
/// hundred bytes the block occupies rather than the unit.
fn sequence_header_len(data: &[u8]) -> usize {
    if data.len() < 4 || data[..3] != [0, 0, 1] || data[3] != start_code::SEQUENCE_HEADER {
        return 0;
    }
    let mut at = 4;
    while at + 4 <= data.len() {
        if data[at] != 0 || data[at + 1] != 0 || data[at + 2] != 1 {
            at += 1;
            continue;
        }
        let code = data[at + 3];
        if code == start_code::PICTURE
            || code == start_code::GROUP
            || (start_code::SLICE_MIN..=start_code::SLICE_MAX).contains(&code)
        {
            return at;
        }
        at += 4;
    }
    0
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

/// Give the duplicate recovery picture a real decode instant and a display
/// slot after the picture it repeats, without changing the unit's duration or
/// any following presentation time.
fn insert_recovery_copy_timing(
    timing: &mut SampleTiming,
    index: usize,
    copies: usize,
) -> Result<()> {
    let borrowed = copies as u32;
    if index == timing.durations.len() {
        let Some(previous_duration) = timing.durations.last_mut() else {
            bail!("recovery copy has no content sample to borrow from");
        };
        if *previous_duration <= borrowed {
            bail!("recovery copies cannot borrow time from their preceding sample");
        }
        *previous_duration -= borrowed;
    } else {
        let next_duration = &mut timing.durations[index];
        let next_composition = &mut timing.compositions[index];
        if *next_duration <= borrowed || *next_composition < borrowed {
            bail!("recovery copies cannot borrow time from their following sample");
        }
        *next_duration -= borrowed;
        *next_composition -= borrowed;
    }
    // Where the pictures already coded give way. The copies repeat the unit's
    // intra picture, and everything decoded ahead of them are the leading
    // pictures that display before it, so this is that picture's last sample.
    let mut decode_time = 0u64;
    let mut shown_until = 0u64;
    for (&duration, &composition) in timing.durations[..index]
        .iter()
        .zip(timing.compositions.iter())
    {
        shown_until = shown_until.max(decode_time + u64::from(composition));
        decode_time += u64::from(duration);
    }
    // A tick after their own decode instant, so the browser sees strictly
    // increasing timestamps rather than the source intra picture's own. And a
    // tick after that picture leaves the screen, which is what a split field
    // pair needs: its second field displays half a frame after the first,
    // which is after these samples decode, so timing them from their decode
    // instant alone lands them between the two fields and leaves the pair
    // presented top, top, bottom, frame, bottom.
    let start = shown_until.max(decode_time) + 1;
    let Ok(composition) = u32::try_from(start - decode_time) else {
        bail!("recovery copies cannot reach the picture they repeat");
    };
    for offset in 0..copies {
        timing.durations.insert(index + offset, 1);
        // Each copy decodes a tick after the one before it, so one offset
        // carries them all and they stay a tick apart on screen too.
        timing.compositions.insert(index + offset, composition);
    }
    Ok(())
}

/// What the sample that opens a unit has to stand in for.
///
/// A unit that opens the presentation is short of pictures at the front: an
/// open GOP's leading B pictures reference an anchor that is not there, so
/// neither path can carry them and the first retained picture sits that many
/// display slots in. Those empty slots are given to the opening sample, which
/// leaves no gap to stall on and -- the reason this matters -- makes every unit
/// span exactly as many frames as the source did, so units appended end to end
/// cannot creep away from the audio.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UnitLeadIn {
    /// Nothing: the unit continues a decode chain and every display slot in it
    /// has a picture of its own.
    None,
    /// The empty slots, held by the extra copy of the IDR that the transcoder
    /// puts ahead of the unit to start its short-term reference chain. That
    /// copy is a sample the timeline has no picture for, so the unit holds one
    /// more sample than the timeline has pictures.
    IdrClone,
    /// The empty slots, held by the unit's own first picture, which is what
    /// passthrough does: it adds no samples of its own, so the picture that
    /// opens the unit is simply shown for longer.
    FirstPicture,
}

/// Work out the sample timing for one unit of coded pictures.
pub fn mpeg2_sample_timing(timeline: &Mpeg2VideoTimeline, lead_in: UnitLeadIn) -> SampleTiming {
    let indices = &timeline.presentation_indices;
    // The slot the unit starts on, which is not the first picture in decode
    // order: an I picture is coded ahead of the B pictures that display before
    // it, and at a random access point those B pictures are missing entirely.
    let first_presentation_time = timeline.first_presentation_time() as i64;
    let duration = timeline.sample_duration as i64;
    let mut offsets: Vec<i64> = Vec::with_capacity(indices.len());
    let mut durations: Vec<u32> = Vec::with_capacity(indices.len());
    let mut decode_time = 0i64;
    for decode_index in 0..indices.len() {
        let presentation_time =
            timeline.presentation_time_at(decode_index) as i64 - first_presentation_time;
        let sample_duration = timeline.duration_at(decode_index);
        if timeline.split_field_samples && timeline.is_field_pair(decode_index) {
            // Each field takes half the frame's slot, in the order it displays
            // in. Splitting the duration rather than leaving the second sample
            // at zero keeps every sample on an instant of its own, which is
            // what the decoders this works around want to see.
            let first_duration = sample_duration / 2;
            let second_duration = sample_duration - first_duration;
            offsets.push(presentation_time - decode_time);
            durations.push(first_duration);
            decode_time += i64::from(first_duration);
            offsets.push(presentation_time + i64::from(first_duration) - decode_time);
            durations.push(second_duration);
            decode_time += i64::from(second_duration);
        } else {
            offsets.push(presentation_time - decode_time);
            durations.push(sample_duration);
            decode_time += i64::from(sample_duration);
        }
    }
    // An anchor picture is coded before the B pictures that display ahead of it,
    // so it reaches its display slot before its decode slot -- a negative
    // composition offset, which asks a decoder to show a picture it has not
    // decoded yet. Holding the whole decode timeline back by that lead keeps
    // every offset at or above zero without moving a single picture relative to
    // the audio.
    //
    // The lead is one frame, and it is held back by a frame whether this unit
    // needs it or not, because the delay sets where the unit's decode timeline
    // begins and the units are appended to one timeline. A unit that measured
    // its own would start a frame later than its neighbours whenever it had no
    // picture displaying ahead of its decode slot -- a group coded without B
    // pictures, or one whose leading B pictures the transcoder dropped -- which
    // leaves a hole in the decode timeline in front of it and lands its last
    // sample on the decode time of the next unit's first. Media Source
    // Extensions reads that overlap as an append over buffered frames and
    // clears them back to a random access point, and these streams carry one
    // every few hundred pictures, so the picture freezes until the next one.
    // MPEG-2 never leads by more than a frame: B pictures are not references,
    // so only one anchor is ever held.
    let measured = -offsets.iter().copied().min().unwrap_or(0).min(0);
    let reorder_delay = measured.max(duration);
    let mut compositions: Vec<u32> = offsets
        .iter()
        .map(|offset| (offset + reorder_delay) as u32)
        .collect();
    // The hole in front of the unit, which the sample covering its leading
    // slots is held over. A unit that has no such sample cannot hold anything,
    // and the caller keeps the hole for the next one that can.
    let hold = match lead_in {
        UnitLeadIn::None => 0,
        _ => timeline.hold_ticks,
    };
    match lead_in {
        UnitLeadIn::None => {}
        UnitLeadIn::IdrClone => {
            let lead = first_presentation_time as u32 + hold;
            let opens_on_a_pair = timeline.split_field_samples && timeline.is_field_pair(0);
            if let (true, [first, second, ..]) = (opens_on_a_pair, durations.as_slice()) {
                // The clone is the unit's third sample, because the pair it
                // repeats takes two. Holding the first field over the hole --
                // which is what inserting the extra slot in front does -- puts
                // the second field a whole hole after its own first, so the
                // pair is torn across frames and every field behind it lands
                // on the wrong half of the frame. Hold the second field
                // instead, and give the clone the frame the pair belongs to.
                let (first, second) = (*first, *second);
                let total = lead + first + second;
                let held = lead.saturating_sub(first).max(1);
                let start = (reorder_delay as u32 + lead).max(reorder_delay as u32 + first + 1);
                durations[1] = held;
                durations.insert(2, (total - first - held).max(1));
                compositions.insert(2, start - (first + held));
            } else {
                durations.insert(0, lead.max(1));
                compositions.insert(0, reorder_delay as u32);
            }
        }
        // The opening sample is displayed from the first empty slot through its
        // own, so the unit spans exactly what it would have with a clone in
        // front of it. Holding it longer moves the decode slot of everything
        // after it by the same amount, which is what the clone did too, so the
        // composition offsets already computed still land where they should.
        UnitLeadIn::FirstPicture => {
            if let Some(first) = durations.first_mut() {
                *first += first_presentation_time as u32 + hold;
            }
        }
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

/// `objectTypeIndication` for ISO/IEC 13818-2 Main Profile video, which is what
/// a broadcast MPEG-2 stream is (ISO/IEC 14496-1 table 5).
const OTI_MPEG2_VIDEO_MAIN: u8 = 0x61;
/// `objectTypeIndication` for MPEG-4 audio, which is what AAC-LC is.
const OTI_MPEG4_AUDIO: u8 = 0x40;
/// `streamType` 4 (visual), upstream off, in the byte that carries them.
const STREAM_TYPE_VISUAL: u8 = 0x11;
/// `streamType` 5 (audio), upstream off.
const STREAM_TYPE_AUDIO: u8 = 0x15;

/// Which codec the video track holds, and so what its sample entry says.
#[derive(Clone, Copy, Debug)]
enum VideoCodec<'a> {
    /// H.264, described by the parameter sets an `avcC` carries out of band.
    Avc { sps: &'a [u8], pps: &'a [u8] },
    /// MPEG-2 video carried through as it stood, described by the sequence
    /// header. The samples keep their start codes and their own copy of that
    /// header, so this is a declaration rather than the only copy.
    Mpeg2 { sequence_header: &'a [u8] },
}

impl VideoCodec<'_> {
    /// The four-character sample entry type and the configuration box inside it.
    fn sample_entry(&self) -> Result<(&'static str, Vec<u8>)> {
        match *self {
            Self::Avc { sps, pps } => Ok(("avc1", make_avc_c(sps, pps)?)),
            Self::Mpeg2 { sequence_header } => Ok((
                "mp4v",
                make_esds(1, OTI_MPEG2_VIDEO_MAIN, STREAM_TYPE_VISUAL, sequence_header),
            )),
        }
    }

    /// What the codecs parameter of a MIME type calls this track (RFC 6381).
    fn codecs_parameter(&self) -> String {
        match *self {
            Self::Avc { sps, .. } => {
                format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3])
            }
            Self::Mpeg2 { .. } => format!("mp4v.{OTI_MPEG2_VIDEO_MAIN:02x}"),
        }
    }
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

/// The `esds` box, which is where an MP4 keeps the configuration a transport
/// stream repeats in band: the AudioSpecificConfig that ADTS carries in every
/// frame header, or the sequence header that opens an MPEG-2 video sequence.
fn make_esds(
    es_id: u16,
    object_type: u8,
    stream_type: u8,
    decoder_specific_info: &[u8],
) -> Vec<u8> {
    let decoder_specific = descriptor(0x05, decoder_specific_info);
    let decoder_config = {
        let mut body = Buf::new();
        // objectTypeIndication and streamType, then buffer size, max and
        // average bitrate as zero.
        body.bytes(&[object_type, stream_type, 0, 0, 0])
            .u32(0)
            .u32(0)
            .bytes(&decoder_specific);
        descriptor(0x04, &body.into_vec())
    };
    let sl_config = descriptor(0x06, &[0x02]);
    let es_descriptor = {
        let mut body = Buf::new();
        body.u16(es_id)
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

/// How wide the track is to be seen, in 16.16 fixed point: the coded width with
/// the sample aspect ratio applied.
///
/// `tkhd` carries a display size, not a coded one, and the two differ for every
/// anamorphic broadcast -- 1440x1080 at 16:9 is 1920 wide on the screen. A
/// reader that takes the sample entry's `pasp` reaches the same number without
/// this, which is why ffmpeg and the browsers that parse the file themselves
/// were content; AVFoundation takes the track's, so on Safari the picture was
/// declared 4:3 while being painted 16:9 inside it. Rounded as ffmpeg rounds it,
/// keeping the fraction of a ratio that does not divide the width evenly.
fn track_width(width: u32, sample_aspect_ratio: Option<SampleAspectRatio>) -> u32 {
    let Some(sar) = sample_aspect_ratio.filter(|sar| sar.width > 0 && sar.height > 0) else {
        return fixed16_16(width);
    };
    let scaled = u64::from(width) * u64::from(sar.width) * 65536;
    let denominator = u64::from(sar.height);
    ((scaled + denominator / 2) / denominator) as u32
}

/// The unity 3x3 display matrix every track here uses, in 16.16 fixed point.
fn identity_matrix(buf: &mut Buf) {
    buf.u32(0x0001_0000).u32(0).u32(0);
    buf.u32(0).u32(0x0001_0000).u32(0);
    buf.u32(0).u32(0).u32(0x4000_0000);
}

/// The initialization segment for a presentation, and the MIME type to open a
/// `SourceBuffer` with.
fn make_init_segment(
    video: VideoCodec<'_>,
    width: u32,
    height: u32,
    sample_aspect_ratio: Option<SampleAspectRatio>,
    audio: Option<&AacConfig>,
) -> Result<(Vec<u8>, String)> {
    let (sample_entry_type, decoder_config) = video.sample_entry()?;
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
        body.u32(track_width(width, sample_aspect_ratio))
            .u32(fixed16_16(height));
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
    let sample_entry = {
        let mut body = Buf::new();
        body.zeros(6).u16(1).zeros(16);
        body.u16(width as u16).u16(height as u16);
        body.u32(fixed16_16(72))
            .u32(fixed16_16(72))
            .u32(0)
            .u16(1)
            .zeros(32);
        body.u16(0x18).u16(0xffff).bytes(&decoder_config);
        if let Some(sar) = sample_aspect_ratio {
            let mut pasp = Buf::new();
            pasp.u32(sar.width).u32(sar.height);
            body.bytes(&boxed("pasp", &pasp.into_vec()));
        }
        boxed(sample_entry_type, &body.into_vec())
    };
    let stsd = {
        let mut body = Buf::new();
        body.u32(1).bytes(&sample_entry);
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
                    .bytes(&make_esds(
                        2,
                        OTI_MPEG4_AUDIO,
                        STREAM_TYPE_AUDIO,
                        &audio.audio_specific_config,
                    ));
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
    let audio_codec = if audio.is_some() { ",mp4a.40.2" } else { "" };
    Ok((
        concat(&[&ftyp, &moov]),
        format!(
            "video/mp4; codecs=\"{}{audio_codec}\"",
            video.codecs_parameter()
        ),
    ))
}

fn make_media_segment(
    video: &VideoPayload<'_>,
    durations: &[u32],
    compositions: &[u32],
    sync_samples: &[bool],
    sequence_number: u32,
    base_decode_time: u64,
) -> Vec<u8> {
    let mut entries = Buf::new();
    for i in 0..video.len() {
        entries.u32(durations[i]);
        entries.u32(video.sample_bytes(i) as u32);
        // sample_flags: non-reference and non-sync unless this is an IDR or a
        // recovery picture. Safari needs the container flag to retain an MSE
        // eviction boundary; the recovery-point SEI tells the decoder how the
        // non-IDR I picture becomes independently usable.
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
            body.u32(video.len() as u32)
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
    let mut mdat_payload = Vec::with_capacity(video.total_bytes());
    for index in 0..video.len() {
        video.write_sample(index, &mut mdat_payload);
    }
    concat(&[&moof, &boxed("mdat", &mdat_payload)])
}

/// One fragment carrying both tracks, so an MSE implementation sees a `traf`
/// for each in the same `moof` rather than two interleaved fragment streams.
#[allow(clippy::too_many_arguments)]
fn make_av_media_segment(
    video: &VideoPayload<'_>,
    durations: &[u32],
    compositions: &[u32],
    sync_samples: &[bool],
    audio_samples: &[Vec<u8>],
    sequence_number: u32,
    video_base_decode_time: u64,
    audio_base_decode_time: u64,
) -> Vec<u8> {
    let video_bytes = video.total_bytes();
    let mut video_entries = Buf::new();
    for i in 0..video.len() {
        video_entries.u32(durations[i]);
        video_entries.u32(video.sample_bytes(i) as u32);
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
        if !video.is_empty() {
            parts.push(traf(
                1,
                video_base_decode_time,
                video_offset,
                &video_entries,
                video.len(),
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
    for index in 0..video.len() {
        video.write_sample(index, &mut out);
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
    let mut samples = video_samples(&nals);
    let (Some(sps), Some(pps)) = (sps, pps) else {
        bail!("H.264 stream lacks SPS or PPS");
    };
    let content_samples = content_sample_count(timeline);
    let recovery = recovery_sample_index(&nals);
    let recovery_copy = recovery.filter(|&index| {
        samples
            .get(index)
            .is_some_and(|sample| sample.iter().any(|nal| nal[0] & 0x1f == 5))
    });
    let Some(extra_samples) = recovery_extra_samples(
        samples.len(),
        content_samples,
        recovery_copy.is_some(),
        timeline.split_field_samples,
    ) else {
        bail!(
            "H.264 sample count {} does not match MPEG-2 timeline {content_samples}",
            samples.len(),
        );
    };
    let has_idr_clone = extra_samples == 1 && recovery_copy.is_none();
    let lead_in = if has_idr_clone {
        UnitLeadIn::IdrClone
    } else {
        UnitLeadIn::None
    };
    let mut timing = mpeg2_sample_timing(timeline, lead_in);
    let mut sync_samples: Vec<bool> = samples
        .iter()
        .map(|sample| sample.iter().any(|nal| nal[0] & 0x1f == 5))
        .collect();
    if let Some(index) = recovery.filter(|&index| index < sync_samples.len()) {
        sync_samples[index] = true;
    }
    if let Some(index) = recovery_copy.filter(|&index| index < sync_samples.len()) {
        insert_recovery_copy_timing(&mut timing, index, extra_samples)?;
    }
    if let (Some(index), Some(sei)) = (recovery, sei) {
        samples[index].insert(0, sei);
    }
    let video = VideoPayload::avc(samples, &[]);
    let (init_segment, mime_codec) = make_init_segment(
        VideoCodec::Avc { sps, pps },
        timeline.width,
        timeline.height,
        timeline.sample_aspect_ratio,
        None,
    )?;

    Ok(Fmp4Output {
        media_segment: make_media_segment(
            &video,
            &timing.durations,
            &timing.compositions,
            &sync_samples,
            1,
            0,
        ),
        sample_count: video.len(),
        init_segment,
        mime_codec,
    })
}

/// Package an MPEG-2 unit as one video-only presentation, carrying its video
/// through untouched.
pub fn mpeg2_to_fmp4(es: &[u8], unit: &Mpeg2Unit) -> Result<Fmp4Output> {
    let timing = mpeg2_sample_timing(&unit.timeline, UnitLeadIn::FirstPicture);
    // A whole presentation opens where a decoder has to be able to start.
    let sync_samples = mpeg2_sync_samples(unit, true);
    let video = mpeg2_payload(es, unit);
    let (init_segment, mime_codec) = make_init_segment(
        VideoCodec::Mpeg2 {
            sequence_header: &es[..unit.sequence_header_len],
        },
        unit.timeline.width,
        unit.timeline.height,
        unit.timeline.sample_aspect_ratio,
        None,
    )?;
    Ok(Fmp4Output {
        media_segment: make_media_segment(
            &video,
            &timing.durations,
            &timing.compositions,
            &sync_samples,
            1,
            0,
        ),
        sample_count: video.len(),
        init_segment,
        mime_codec,
    })
}

/// The samples of a passthrough unit as the `mdat` will carry them.
///
/// A sample that does not open the unit but is the first one kept is given the
/// sequence header the unit opens with: the pictures that stood between them
/// were dropped, and their bytes with them.
fn mpeg2_payload<'a>(es: &'a [u8], unit: &Mpeg2Unit) -> VideoPayload<'a> {
    let split_fields = unit.timeline.split_field_samples;
    let mut samples: Vec<VideoSample<'a>> = Vec::with_capacity(unit.samples.len());
    for sample in &unit.samples {
        // The two fields of a pair are already two coded pictures here, so
        // giving each its own sample is a matter of not joining them.
        match sample.field_end.filter(|_| split_fields) {
            Some(field_end) => {
                samples.push(vec![&es[sample.start..field_end]]);
                samples.push(vec![&es[field_end..sample.end]]);
            }
            None => samples.push(vec![&es[sample.start..sample.end]]),
        }
    }
    if let Some(first) = samples.first_mut() {
        if unit.samples[0].start > unit.sequence_header_len {
            first.insert(0, &es[..unit.sequence_header_len]);
        }
    }
    VideoPayload::mpeg2(samples)
}

/// Which of a passthrough unit's samples a decoder can be started on, in step
/// with what [`mpeg2_payload`] emits.
///
/// Only the sample that opens a restart point is marked, which is where the
/// transcoding path puts its IDR and its recovery points. The intra pictures
/// between them are no more startable here than there: an open group's leading
/// B pictures follow one in decode order and reference the group before it.
fn mpeg2_sync_samples(unit: &Mpeg2Unit, random_access: bool) -> Vec<bool> {
    let split_fields = unit.timeline.split_field_samples;
    let mut sync = Vec::with_capacity(unit.samples.len());
    for sample in &unit.samples {
        sync.push(sync.is_empty() && random_access && sample.sync);
        // The second field of a pair is half a picture, and no decoder starts
        // on one.
        if split_fields && sample.field_end.is_some() {
            sync.push(false);
        }
    }
    sync
}

/// How much of the presentation one fragment covers. The caller needs this
/// before it can decide how much audio belongs in the same fragment, which is
/// why it is separate from the muxing.
pub fn mpeg2_fragment_duration(timeline: &Mpeg2VideoTimeline, lead_in: UnitLeadIn) -> u64 {
    mpeg2_sample_timing(timeline, lead_in)
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
    let mut samples = video_samples(&nals);

    let content_samples = content_sample_count(timeline);
    let recovery = recovery_sample_index(&nals);
    let recovery_copy = recovery.filter(|&index| {
        samples
            .get(index)
            .is_some_and(|sample| sample.iter().any(|nal| nal[0] & 0x1f == 5))
    });
    let Some(extra_samples) = recovery_extra_samples(
        samples.len(),
        content_samples,
        recovery_copy.is_some(),
        timeline.split_field_samples,
    ) else {
        bail!(
            "H.264 GOP sample count {} does not match MPEG-2 timeline {content_samples}",
            samples.len(),
        );
    };
    let has_idr_clone = extra_samples == 1 && recovery_copy.is_none();
    let lead_in = if has_idr_clone {
        UnitLeadIn::IdrClone
    } else {
        UnitLeadIn::None
    };
    let mut timing = mpeg2_sample_timing(timeline, lead_in);
    let mut sync_samples: Vec<bool> = samples
        .iter()
        .map(|sample| sample.iter().any(|nal| nal[0] & 0x1f == 5))
        .collect();
    if let Some(index) = recovery.filter(|&index| index < sync_samples.len()) {
        sync_samples[index] = true;
    }
    if let Some(index) = recovery_copy.filter(|&index| index < sync_samples.len()) {
        insert_recovery_copy_timing(&mut timing, index, extra_samples)?;
    }
    if let (Some(index), Some(sei)) = (recovery, sei) {
        samples[index].insert(0, sei);
    }
    // The parameter sets are written once, by the unit that opens the stream,
    // so that is the unit that has an initialization segment to describe.
    let describe = match (sps, pps) {
        (Some(sps), Some(pps)) => Some(VideoCodec::Avc { sps, pps }),
        _ => None,
    };
    make_fragment(
        VideoPayload::avc(samples, &[]),
        timeline,
        &timing,
        &sync_samples,
        describe,
        sequence_number,
        presentation_start,
        audio,
        audio_track,
    )
}

/// Package one unit of MPEG-2 video for incremental appending, carrying the
/// video through untouched.
///
/// `describe` asks for the initialization segment, which the caller wants from
/// the first fragment only: every unit opens with a sequence header, so unlike
/// the transcoded path there is nothing in the unit itself to say which is
/// which.
#[allow(clippy::too_many_arguments)]
pub fn mpeg2_gop_to_fmp4(
    es: &[u8],
    unit: &Mpeg2Unit,
    sequence_number: u32,
    presentation_start: u64,
    lead_in: UnitLeadIn,
    random_access: bool,
    describe: bool,
    audio: Option<&AacConfig>,
    audio_track: Option<&Fmp4AudioSamples>,
) -> Result<Fmp4Fragment> {
    let timing = mpeg2_sample_timing(&unit.timeline, lead_in);
    let sync_samples = mpeg2_sync_samples(unit, random_access);
    let video = mpeg2_payload(es, unit);
    let describe = describe.then_some(VideoCodec::Mpeg2 {
        sequence_header: &es[..unit.sequence_header_len],
    });
    make_fragment(
        video,
        &unit.timeline,
        &timing,
        &sync_samples,
        describe,
        sequence_number,
        presentation_start,
        audio,
        audio_track,
    )
}

/// Put one fragment together, whatever the video in it is coded as.
#[allow(clippy::too_many_arguments)]
fn make_fragment(
    video: VideoPayload<'_>,
    timeline: &Mpeg2VideoTimeline,
    timing: &SampleTiming,
    sync_samples: &[bool],
    describe: Option<VideoCodec<'_>>,
    sequence_number: u32,
    presentation_start: u64,
    audio: Option<&AacConfig>,
    audio_track: Option<&Fmp4AudioSamples>,
) -> Result<Fmp4Fragment> {
    // Decoding runs ahead of display by the reorder delay; a fragment at the
    // very start of the timeline has nowhere to put it and simply displays that
    // much later.
    let base_decode_time = presentation_start.saturating_sub(timing.reorder_delay as u64);
    let media_segment = match audio_track {
        Some(track) => make_av_media_segment(
            &video,
            &timing.durations,
            &timing.compositions,
            sync_samples,
            &track.samples,
            sequence_number,
            base_decode_time,
            track.base_decode_time,
        ),
        None => make_media_segment(
            &video,
            &timing.durations,
            &timing.compositions,
            sync_samples,
            sequence_number,
            base_decode_time,
        ),
    };
    let (init_segment, mime_codec) = match describe {
        Some(codec) => make_init_segment(
            codec,
            timeline.width,
            timeline.height,
            timeline.sample_aspect_ratio,
            audio,
        )?,
        None => (Vec::new(), String::new()),
    };
    Ok(Fmp4Fragment {
        init_segment,
        media_segment,
        mime_codec,
        sample_count: video.len(),
        duration: timing.durations.iter().map(|&d| d as u64).sum(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 29.97 fps, and deliberately odd so a halved field duration cannot be
    /// exact: the two halves still have to add up to the frame.
    const FRAME: u32 = 3003;

    fn timeline(indices: &[u32], field_pairs: &[bool], split: bool) -> Mpeg2VideoTimeline {
        Mpeg2VideoTimeline {
            width: 720,
            height: 480,
            sample_duration: FRAME,
            presentation_times: Vec::new(),
            sample_durations: Vec::new(),
            presentation_indices: indices.to_vec(),
            field_pairs: field_pairs.to_vec(),
            split_field_samples: split,
            sample_aspect_ratio: None,
            hold_ticks: 0,
            interlacing: Interlacing::default(),
        }
    }

    /// Decode order I P B B, as an open group of pictures is coded.
    const IPBB: [u32; 4] = [1, 4, 2, 3];

    #[test]
    fn repeated_first_fields_extend_their_own_samples() {
        let mut timeline = timeline(&IPBB, &[false; 4], false);
        timeline.presentation_times = vec![0, 10_511, 3_003, 7_508];
        timeline.sample_durations = vec![3_003, 4_505, 4_505, 3_003];

        let timing = mpeg2_sample_timing(&timeline, UnitLeadIn::None);

        assert_eq!(timing.durations, [3_003, 4_505, 4_505, 3_003]);
        assert_eq!(timing.compositions, [4_505, 12_013, 0, 0]);
        assert_eq!(timing.reorder_delay, 4_505);
    }

    /// Decode order I P P P, a group coded without B pictures, which displays
    /// in the order it was coded in.
    const IPPP: [u32; 4] = [1, 2, 3, 4];

    #[test]
    fn a_split_field_recovery_copy_adds_three_samples() {
        assert_eq!(recovery_extra_samples(33, 30, true, true), Some(3));
        assert_eq!(recovery_extra_samples(33, 30, true, false), None);
    }

    /// The delay is what the decode timeline of a unit is set back by, and the
    /// units share one timeline, so a unit with nothing to reorder has to be
    /// set back as far as its neighbours. Measuring it from this unit alone
    /// left the group without B pictures a frame later than the group before
    /// it, which put its last sample on the decode time of the next group's
    /// first -- an overlap MSE resolves by dropping buffered frames back to a
    /// random access point.
    #[test]
    fn a_unit_with_nothing_to_reorder_is_still_held_back_a_frame() {
        let reordered = mpeg2_sample_timing(&timeline(&IPBB, &[false; 4], false), UnitLeadIn::None);
        let in_order = mpeg2_sample_timing(&timeline(&IPPP, &[false; 4], false), UnitLeadIn::None);
        assert_eq!(in_order.reorder_delay, reordered.reorder_delay);
        assert_eq!(in_order.reorder_delay, FRAME as i64);
        // Every picture displays a frame after it decodes, so none of them
        // moved: the offsets carry the delay rather than cancelling it.
        assert_eq!(in_order.compositions, vec![FRAME; 4]);
    }

    #[test]
    fn recovery_samples_have_distinct_presentation_times() {
        let mut timing = SampleTiming {
            durations: vec![10, 10],
            compositions: vec![0, 10],
            reorder_delay: 0,
        };
        insert_recovery_copy_timing(&mut timing, 1, 2).expect("timing has room");

        assert_eq!(timing.durations, vec![10, 1, 1, 8]);
        assert_eq!(timing.compositions, vec![0, 1, 1, 8]);
        let mut decode_time = 0u32;
        let presentation_times: Vec<u32> = timing
            .durations
            .iter()
            .zip(&timing.compositions)
            .map(|(&duration, &composition)| {
                let presentation = decode_time + composition;
                decode_time += duration;
                presentation
            })
            .collect();
        assert_eq!(presentation_times, vec![0, 11, 12, 20]);
    }

    /// A split field pair is still on screen when its copy decodes: the second
    /// field displays half a frame after the first, and the copy decodes at
    /// the first field's display instant. Timing the copies from their own
    /// decode instant put them between the two fields, which presented the
    /// frame as top, top, bottom, copy, bottom -- two fields of one parity in
    /// a row, at every recovery point whose source intra picture was a pair.
    #[test]
    fn recovery_copies_of_a_field_pair_follow_its_second_field() {
        let mut timing = SampleTiming {
            // A field pair, then the leading pictures that display ahead of it.
            durations: vec![5, 5, 10, 10, 10],
            compositions: vec![30, 30, 0, 0, 40],
            reorder_delay: 0,
        };
        insert_recovery_copy_timing(&mut timing, 4, 3).expect("timing has room");

        let mut decode_time = 0u32;
        let presentation_times: Vec<u32> = timing
            .durations
            .iter()
            .zip(&timing.compositions)
            .map(|(&duration, &composition)| {
                let presentation = decode_time + composition;
                decode_time += duration;
                presentation
            })
            .collect();
        // The pair displays at 30 and 35, and the three copies pick up from
        // there rather than from 30, where the second field still follows.
        assert_eq!(presentation_times, vec![30, 35, 10, 20, 36, 37, 38, 70]);
    }

    /// The clone in front of a unit holds the empty slots an open group's
    /// dropped leading pictures left. Holding the pair's first field over them
    /// left its second field a whole hole later, which tore the pair across
    /// two frames and put every field behind it on the wrong half of one.
    #[test]
    fn a_clone_holds_the_second_field_of_the_pair_it_opens_on() {
        // Two empty leading slots in front of a group of field pairs.
        let leading = [3, 6, 4, 5];
        let timing =
            mpeg2_sample_timing(&timeline(&leading, &[true; 4], true), UnitLeadIn::IdrClone);
        let mut decode_time = 0u32;
        let presentation_times: Vec<u32> = timing
            .durations
            .iter()
            .zip(&timing.compositions)
            .map(|(&duration, &composition)| {
                let presentation = decode_time + composition;
                decode_time += duration;
                presentation
            })
            .collect();
        let half = FRAME / 2;
        // The pair opens the unit a field apart, and the clone takes the frame
        // the pair belongs to, two frames on.
        assert_eq!(presentation_times[0], FRAME);
        assert_eq!(presentation_times[1], FRAME + half);
        assert_eq!(presentation_times[2], FRAME * 3);
        assert_eq!(timing.durations[2], FRAME);
        // Nothing behind the clone moved, and the unit is as long as it was.
        assert_eq!(
            &presentation_times[3..],
            &[
                FRAME * 6,
                FRAME * 6 + half,
                FRAME * 4,
                FRAME * 4 + half,
                FRAME * 5,
                FRAME * 5 + half
            ]
        );
        assert_eq!(timing.durations.iter().sum::<u32>(), FRAME * 6);
    }

    #[test]
    fn field_pairs_kept_together_take_one_sample_each() {
        let timing = mpeg2_sample_timing(&timeline(&IPBB, &[true; 4], false), UnitLeadIn::None);
        assert_eq!(timing.durations, vec![FRAME; 4]);
        assert_eq!(timing.reorder_delay, FRAME as i64);
        // The anchors lead their display slots; the B pictures catch up.
        assert_eq!(timing.compositions, vec![FRAME, FRAME * 3, 0, 0]);
    }

    #[test]
    fn split_field_pairs_take_two_samples_half_a_frame_apart() {
        let timing = mpeg2_sample_timing(&timeline(&IPBB, &[true; 4], true), UnitLeadIn::None);
        assert_eq!(
            timing.durations,
            vec![1501, 1502, 1501, 1502, 1501, 1502, 1501, 1502]
        );
        // Every field lands where its frame would have, then half a frame on.
        let mut decode_time = 0i64;
        let presentations: Vec<i64> = timing
            .durations
            .iter()
            .zip(&timing.compositions)
            .map(|(&duration, &composition)| {
                let at = decode_time + composition as i64;
                decode_time += duration as i64;
                at
            })
            .collect();
        let delay = timing.reorder_delay;
        assert_eq!(
            presentations,
            vec![
                delay,
                delay + 1501,
                delay + FRAME as i64 * 3,
                delay + FRAME as i64 * 3 + 1501,
                delay + FRAME as i64,
                delay + FRAME as i64 + 1501,
                delay + FRAME as i64 * 2,
                delay + FRAME as i64 * 2 + 1501,
            ]
        );
    }

    #[test]
    fn splitting_leaves_frame_pictures_and_the_total_alone() {
        let mixed = [true, false, true, false];
        let split = mpeg2_sample_timing(&timeline(&IPBB, &mixed, true), UnitLeadIn::None);
        let whole = mpeg2_sample_timing(&timeline(&IPBB, &mixed, false), UnitLeadIn::None);
        assert_eq!(split.durations, vec![1501, 1502, FRAME, 1501, 1502, FRAME]);
        let total = |timing: &SampleTiming| timing.durations.iter().map(|&d| d as u64).sum::<u64>();
        assert_eq!(total(&split), total(&whole));
        assert_eq!(split.reorder_delay, whole.reorder_delay);
    }

    #[test]
    fn a_split_pair_counts_as_two_samples() {
        let mixed = [true, false, true, false];
        assert_eq!(content_sample_count(&timeline(&IPBB, &mixed, true)), 6);
        assert_eq!(content_sample_count(&timeline(&IPBB, &mixed, false)), 4);
    }

    /// A passthrough unit of four pictures, alternating field pairs with
    /// frames, laid over an elementary stream of one byte per coded picture --
    /// a field pair taking two of them.
    fn passthrough_unit(split: bool) -> Mpeg2Unit {
        let mixed = [true, false, true, false];
        let mut samples = Vec::new();
        let mut at = 0;
        for (index, &pair) in mixed.iter().enumerate() {
            let field_end = pair.then(|| at + 1);
            let end = at + if pair { 2 } else { 1 };
            samples.push(Mpeg2Sample {
                start: at,
                field_end,
                end,
                sync: index == 0,
            });
            at = end;
        }
        Mpeg2Unit {
            timeline: timeline(&IPBB, &mixed, split),
            samples,
            sequence_header_len: 0,
        }
    }

    #[test]
    fn splitting_a_carried_field_pair_moves_a_boundary_and_nothing_else() {
        // Both fields are separate coded pictures already, so this is a matter
        // of not joining them: the same bytes reach the mdat either way, in the
        // same order, and only how many samples claim them changes.
        let es: Vec<u8> = (0..6).collect();
        let split = mpeg2_payload(&es, &passthrough_unit(true));
        let whole = mpeg2_payload(&es, &passthrough_unit(false));

        assert_eq!(split.len(), 6, "two field pairs take two samples each");
        assert_eq!(whole.len(), 4);
        assert_eq!(split.total_bytes(), whole.total_bytes());
        // The sample count has to match what the timing was worked out for, or
        // the fragment describes samples the mdat does not hold.
        assert_eq!(
            split.len(),
            mpeg2_sample_timing(
                &timeline(&IPBB, &[true, false, true, false], true),
                UnitLeadIn::None
            )
            .durations
            .len()
        );
        let bytes = |payload: &VideoPayload<'_>| {
            let mut out = Vec::new();
            for index in 0..payload.len() {
                payload.write_sample(index, &mut out);
            }
            out
        };
        assert_eq!(bytes(&split), bytes(&whole));
        assert_eq!(bytes(&split), es);
    }

    #[test]
    fn only_the_sample_a_restart_opens_on_is_a_sync_sample() {
        // A decoder starts on a whole picture, never on the second field of
        // one, and only where a restart point was asked for.
        assert_eq!(
            mpeg2_sync_samples(&passthrough_unit(true), true),
            vec![true, false, false, false, false, false]
        );
        assert_eq!(
            mpeg2_sync_samples(&passthrough_unit(true), false),
            vec![false; 6]
        );
    }

    #[test]
    fn the_track_is_as_wide_as_the_picture_is_to_be_seen() {
        let sar = |width, height| Some(SampleAspectRatio { width, height });
        // The two anamorphic shapes a broadcast comes in, and the square
        // sample that needs no stretch at all.
        assert_eq!(track_width(1440, sar(4, 3)), fixed16_16(1920));
        assert_eq!(track_width(720, sar(8, 9)), fixed16_16(640));
        assert_eq!(track_width(1920, sar(1, 1)), fixed16_16(1920));
        assert_eq!(track_width(1920, None), fixed16_16(1920));
        // A ratio that does not divide the width evenly keeps its fraction
        // rather than landing on a pixel: 704 * 40 / 33 is 853 and a third.
        assert_eq!(track_width(704, sar(40, 33)), 853 * 65536 + 21845);
    }
}
