//! MPEG-2 (H.262) header layer parsing: everything above the macroblock.
//!
//! The output of this pass is what the H.264 side needs to build its SPS/PPS and
//! slice headers, plus the byte ranges of the slices whose macroblock layer will
//! be re-entropy-coded.

use crate::bitreader::{find_start_codes, BitReader};
use crate::error::Result;
use crate::mpeg2::constants::{
    chroma_format, extension, start_code, PictureStructure, PictureType, ALTERNATE_SCAN,
    DEFAULT_INTRA_QUANT, DEFAULT_NON_INTRA_QUANT, ZIGZAG_SCAN,
};

#[derive(Clone, Copy, Debug)]
pub struct SequenceHeader {
    pub horizontal_size: u32,
    pub vertical_size: u32,
    pub aspect_ratio_information: u32,
    pub frame_rate_code: u32,
    pub bit_rate_value: u32,
    pub vbv_buffer_size_value: u32,
    pub constrained_parameters_flag: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct SequenceExtension {
    pub profile_and_level: u32,
    pub progressive_sequence: bool,
    pub chroma_format: u32,
    pub bit_rate_extension: u32,
    pub vbv_buffer_size_extension: u32,
    pub low_delay: bool,
    pub frame_rate_extension_n: u32,
    pub frame_rate_extension_d: u32,
}

impl SequenceExtension {
    /// What a picture carrying no sequence extension is treated as, i.e. the
    /// MPEG-1 style case.
    fn mpeg1_default() -> Self {
        Self {
            profile_and_level: 0,
            progressive_sequence: true,
            chroma_format: chroma_format::C420,
            bit_rate_extension: 0,
            vbv_buffer_size_extension: 0,
            low_delay: false,
            frame_rate_extension_n: 0,
            frame_rate_extension_d: 0,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SampleAspectRatio {
    pub width: u32,
    pub height: u32,
}

fn gcd(mut a: u32, mut b: u32) -> u32 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

/// How the pictures of a coded unit were captured.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Interlacing {
    /// Whether any picture holds two moments rather than one, which is what a
    /// deinterlacer is for and what nothing else here can tell a player.
    pub interlaced: bool,
    /// Which of the two moments came first, where there are two. Nothing in a
    /// progressive picture is ordered by it, so it is only worth reading with
    /// `interlaced`.
    pub top_field_first: bool,
}

impl Default for Interlacing {
    fn default() -> Self {
        Self {
            interlaced: false,
            // Every interlaced broadcast format worth the name is top field
            // first, so a stream that never says is assumed to be one.
            top_field_first: true,
        }
    }
}

/// Read the field order out of a unit's pictures.
///
/// A picture says it in one of two ways. Coded as two field pictures, it is
/// interlaced by construction and the field that came first is whichever one
/// was coded first. Coded as a frame, `progressive_frame` says whether its two
/// fields hold one moment or two, and `top_field_first` orders them where they
/// hold two. A unit that mixes the two -- which is legal, and which a station
/// switching between film and live camera produces -- counts as interlaced if
/// any of it is, since that is the part a viewer would see combed.
pub fn pictures_interlacing(pictures: &[Picture]) -> Interlacing {
    let mut interlacing = Interlacing {
        interlaced: false,
        top_field_first: Interlacing::default().top_field_first,
    };
    let mut ordered = false;
    for picture in pictures {
        let (interlaced, top_field_first) = match picture.coding.picture_structure {
            PictureStructure::TopField => (true, Some(true)),
            PictureStructure::BottomField => (true, Some(false)),
            PictureStructure::Frame => (
                !picture.coding.progressive_frame,
                (!picture.coding.progressive_frame).then_some(picture.coding.top_field_first),
            ),
            PictureStructure::Reserved => (false, None),
        };
        interlacing.interlaced |= interlaced;
        // The first picture that has an order to give is the one to take it
        // from: later ones in the same unit are the same field pair or the
        // pairs after it, and a mid-unit disagreement is not something a
        // single answer can carry anyway.
        if let Some(top_field_first) = top_field_first {
            if !ordered {
                interlacing.top_field_first = top_field_first;
                ordered = true;
            }
        }
    }
    interlacing
}

/// Convert MPEG-2 display aspect ratio signalling to a pixel aspect ratio.
pub fn sequence_sample_aspect_ratio(sequence: &SequenceHeader) -> Option<SampleAspectRatio> {
    if sequence.aspect_ratio_information == 1 {
        return Some(SampleAspectRatio {
            width: 1,
            height: 1,
        });
    }
    let display = match sequence.aspect_ratio_information {
        2 => (4, 3),
        3 => (16, 9),
        4 => (221, 100),
        _ => return None,
    };
    let mut width = display.0 * sequence.vertical_size;
    let mut height = display.1 * sequence.horizontal_size;
    let divisor = gcd(width, height);
    if divisor == 0 {
        return None;
    }
    width /= divisor;
    height /= divisor;
    Some(SampleAspectRatio { width, height })
}

/// What the H.264 parameter sets and the MP4 initialization segment are built
/// out of, as the sequence header states it.
///
/// A broadcast is not one sequence from end to end: a station switching between
/// its main service and a sub-channel, or between an HD programme and an SD
/// commercial, sends a new sequence header and codes everything after it
/// differently. Everything here is something the SPS, the PPS or the MP4 sample
/// entry carries, so a stream that changes any of it has to be described again
/// -- and nothing else in the sequence header needs a decoder to be told twice.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SequenceDescription {
    pub width: u32,
    pub height: u32,
    /// Whether frames are coded as complementary field pairs, which is what the
    /// H.264 side represents as macroblock-adaptive frame/field coding and
    /// declares in the SPS.
    pub mbaff: bool,
    pub sample_aspect_ratio: Option<SampleAspectRatio>,
    /// The non-intra matrix, which the PPS declares as its 8x8 scaling lists
    /// and which every requantised coefficient is scaled against.
    pub non_intra_quant: [i32; 64],
}

impl Default for SequenceDescription {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            mbaff: false,
            sample_aspect_ratio: None,
            non_intra_quant: DEFAULT_NON_INTRA_QUANT,
        }
    }
}

/// The description one already-parsed picture was coded under.
pub fn picture_sequence_description(picture: &Picture) -> SequenceDescription {
    SequenceDescription {
        width: picture.sequence.horizontal_size,
        height: picture.sequence.vertical_size,
        mbaff: !picture.sequence_ext.progressive_sequence,
        sample_aspect_ratio: sequence_sample_aspect_ratio(&picture.sequence),
        non_intra_quant: picture.quant.non_intra,
    }
}

/// The description the first picture of `data` is coded under, read from the
/// headers standing in front of it and nothing else.
///
/// This is [`picture_sequence_description`] of what [`parse_elementary_stream`]
/// would return first, reached without parsing the unit: whoever is packaging a
/// unit has to know whether it is described by what went out already *before*
/// the unit is planned, because the answer decides whether the unit opens at a
/// random access point and that is an input to the plan. It stops at the first
/// picture, which in a unit is a few hundred bytes in.
///
/// `None` when the data holds no picture that a sequence header describes,
/// which is a unit nothing can be said about and which is left to the parse.
pub fn stream_sequence_description(data: &[u8]) -> Option<SequenceDescription> {
    let mut sequence: Option<SequenceHeader> = None;
    let mut sequence_ext: Option<SequenceExtension> = None;
    let mut quant = QuantMatrices::default();
    let mut at = 0;
    while at + 3 < data.len() {
        if data[at] != 0 || data[at + 1] != 0 || data[at + 2] != 1 {
            at += 1;
            continue;
        }
        let code = data[at + 3];
        let mut r = BitReader::at_bit(data, (at + 4) * 8);
        if code == start_code::SEQUENCE_HEADER {
            let (header, matrices) = read_sequence_header(&mut r).ok()?;
            sequence = Some(header);
            sequence_ext = None;
            quant = matrices;
        } else if code == start_code::EXTENSION {
            match r.u(4) {
                extension::SEQUENCE => {
                    if let Some(header) = sequence.as_mut() {
                        sequence_ext = Some(read_sequence_extension(&mut r, header).ok()?);
                    }
                }
                extension::QUANT_MATRIX => read_quant_matrix_extension(&mut r, &mut quant),
                _ => {}
            }
        } else if code == start_code::PICTURE {
            // Pictures no sequence header describes are discarded by the parse
            // rather than ending it, so this walk passes over them too: the
            // first picture that counts is the first one a header covers, and
            // the two have to agree on which that is.
            if let Some(sequence) = sequence {
                let progressive_sequence = sequence_ext
                    .unwrap_or_else(SequenceExtension::mpeg1_default)
                    .progressive_sequence;
                return Some(SequenceDescription {
                    width: sequence.horizontal_size,
                    height: sequence.vertical_size,
                    mbaff: !progressive_sequence,
                    sample_aspect_ratio: sequence_sample_aspect_ratio(&sequence),
                    non_intra_quant: quant.non_intra,
                });
            }
        }
        // Nothing shorter than the code byte can begin another start code.
        at += 3;
    }
    None
}

/// All four quantiser matrices, held in raster order.
#[derive(Clone, Debug)]
pub struct QuantMatrices {
    pub intra: [i32; 64],
    pub non_intra: [i32; 64],
    pub chroma_intra: [i32; 64],
    pub chroma_non_intra: [i32; 64],
}

impl Default for QuantMatrices {
    fn default() -> Self {
        Self {
            intra: DEFAULT_INTRA_QUANT,
            non_intra: DEFAULT_NON_INTRA_QUANT,
            chroma_intra: DEFAULT_INTRA_QUANT,
            chroma_non_intra: DEFAULT_NON_INTRA_QUANT,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PictureHeader {
    pub temporal_reference: u32,
    pub picture_coding_type: PictureType,
    pub vbv_delay: u32,
    /// Present for P and B pictures; MPEG-1 style whole-pel MV flag.
    pub full_pel_forward_vector: bool,
    pub forward_f_code: u32,
    pub full_pel_backward_vector: bool,
    pub backward_f_code: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct PictureCodingExtension {
    /// `f_code[r][s]`: r = 0 forward / 1 backward, s = 0 horizontal / 1 vertical.
    pub f_code: [[u32; 2]; 2],
    pub intra_dc_precision: u32,
    pub picture_structure: PictureStructure,
    pub top_field_first: bool,
    pub frame_pred_frame_dct: bool,
    pub concealment_motion_vectors: bool,
    pub q_scale_type: usize,
    pub intra_vlc_format: u32,
    pub alternate_scan: bool,
    pub repeat_first_field: bool,
    pub chroma_420_type: bool,
    pub progressive_frame: bool,
}

impl PictureCodingExtension {
    /// Default picture coding extension, for the MPEG-1 style case where a
    /// picture carries no extension at all. MPEG-2 streams always have one, but
    /// defaulting keeps the picture record total.
    fn mpeg1_default(header: &PictureHeader) -> Self {
        let f = header.forward_f_code.max(1);
        let b = header.backward_f_code.max(1);
        Self {
            f_code: [[f, f], [b, b]],
            intra_dc_precision: 0,
            picture_structure: PictureStructure::Frame,
            top_field_first: false,
            frame_pred_frame_dct: true,
            concealment_motion_vectors: false,
            q_scale_type: 0,
            intra_vlc_format: 0,
            alternate_scan: false,
            repeat_first_field: false,
            chroma_420_type: true,
            progressive_frame: true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Slice {
    /// `slice_vertical_position`, i.e. the macroblock row this slice starts in (1-based).
    pub vertical_position: u32,
    pub quantiser_scale_code: u32,
    /// Bit offset of the first `macroblock()` in the stream buffer.
    pub data_start_bit: usize,
    /// Bit offset one past the last macroblock (start of the next start code).
    pub data_end_bit: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct Picture {
    /// True when a `group_of_pictures_header` preceded this picture, which is
    /// where `temporal_reference` restarts. Coded order alone cannot tell:
    /// within a group `temporal_reference` already runs backwards whenever B
    /// pictures are present.
    pub starts_gop: bool,
    pub header: PictureHeader,
    pub coding: PictureCodingExtension,
    /// Sequence state in effect for this picture.
    pub sequence: SequenceHeader,
    pub sequence_ext: SequenceExtension,
    pub quant: QuantMatrices,
    pub slices: Vec<Slice>,
    /// Byte range of the sequence-level headers standing in front of this
    /// picture: from its sequence header to one past the last thing that
    /// changed the description, which is the sequence extension and any
    /// quantiser matrix extension that arrived before it.
    ///
    /// This is what a converter has to put in front of the picture's own bytes
    /// for a fresh parse to describe it the way this walk did. Normally it is
    /// the block a sequence opens with, a hundred-odd bytes holding no picture
    /// at all. A stream that changes its quantiser matrices part way through a
    /// sequence stretches the range over the pictures in between, which is why
    /// a reader takes the last picture of a prefixed stream rather than the
    /// first.
    pub context_start: usize,
    pub context_end: usize,
}

/// Derived, ready-to-use view of the picture geometry.
#[derive(Clone, Copy, Debug)]
pub struct PictureGeometry {
    pub width: u32,
    pub height: u32,
    pub mb_width: usize,
    pub mb_height: usize,
    pub frame_mb_height: usize,
    pub is_field_picture: bool,
}

pub fn picture_geometry(pic: &Picture) -> PictureGeometry {
    let width = pic.sequence.horizontal_size;
    let height = pic.sequence.vertical_size;
    let mb_width = ((width + 15) >> 4) as usize;
    // Field pictures code half the macroblock rows.
    let frame_mb_height = ((height + 15) >> 4) as usize;
    let is_field_picture = pic.coding.picture_structure != PictureStructure::Frame;
    let mb_height = if is_field_picture {
        ((height + 31) >> 5) as usize
    } else {
        frame_mb_height
    };
    PictureGeometry {
        width,
        height,
        mb_width,
        mb_height,
        frame_mb_height,
        is_field_picture,
    }
}

pub fn scan_table(pic: &Picture) -> &'static [usize; 64] {
    if pic.coding.alternate_scan {
        &ALTERNATE_SCAN
    } else {
        &ZIGZAG_SCAN
    }
}

/// Quantiser matrices are transmitted in scan order; store them in raster order.
fn read_quant_matrix(r: &mut BitReader<'_>) -> [i32; 64] {
    let mut m = [0i32; 64];
    for i in 0..64 {
        m[ZIGZAG_SCAN[i]] = r.u(8) as i32;
    }
    m
}

fn read_sequence_header(r: &mut BitReader<'_>) -> Result<(SequenceHeader, QuantMatrices)> {
    let horizontal_size = r.u(12);
    let vertical_size = r.u(12);
    let aspect_ratio_information = r.u(4);
    let frame_rate_code = r.u(4);
    let bit_rate_value = r.u(18);
    r.marker()?;
    let vbv_buffer_size_value = r.u(10);
    let constrained_parameters_flag = r.flag();
    let seq = SequenceHeader {
        horizontal_size,
        vertical_size,
        aspect_ratio_information,
        frame_rate_code,
        bit_rate_value,
        vbv_buffer_size_value,
        constrained_parameters_flag,
    };

    // A sequence header always resets the matrices: any not loaded here revert
    // to the defaults (clause 6.3.11).
    let mut quant = QuantMatrices::default();
    if r.flag() {
        quant.intra = read_quant_matrix(r);
        quant.chroma_intra = quant.intra;
    }
    if r.flag() {
        quant.non_intra = read_quant_matrix(r);
        quant.chroma_non_intra = quant.non_intra;
    }
    Ok((seq, quant))
}

fn read_sequence_extension(
    r: &mut BitReader<'_>,
    seq: &mut SequenceHeader,
) -> Result<SequenceExtension> {
    let profile_and_level = r.u(8);
    let progressive_sequence = r.flag();
    let chroma_format = r.u(2);
    let horizontal_size_extension = r.u(2);
    let vertical_size_extension = r.u(2);
    let bit_rate_extension = r.u(12);
    r.marker()?;
    let vbv_buffer_size_extension = r.u(8);
    let low_delay = r.flag();
    let frame_rate_extension_n = r.u(2);
    let frame_rate_extension_d = r.u(5);

    // The extension carries the top 2 bits of each dimension.
    seq.horizontal_size |= horizontal_size_extension << 12;
    seq.vertical_size |= vertical_size_extension << 12;

    Ok(SequenceExtension {
        profile_and_level,
        progressive_sequence,
        chroma_format,
        bit_rate_extension,
        vbv_buffer_size_extension,
        low_delay,
        frame_rate_extension_n,
        frame_rate_extension_d,
    })
}

fn read_quant_matrix_extension(r: &mut BitReader<'_>, quant: &mut QuantMatrices) {
    if r.flag() {
        quant.intra = read_quant_matrix(r);
        quant.chroma_intra = quant.intra;
    }
    if r.flag() {
        quant.non_intra = read_quant_matrix(r);
        quant.chroma_non_intra = quant.non_intra;
    }
    if r.flag() {
        quant.chroma_intra = read_quant_matrix(r);
    }
    if r.flag() {
        quant.chroma_non_intra = read_quant_matrix(r);
    }
}

fn read_picture_header(r: &mut BitReader<'_>) -> PictureHeader {
    let temporal_reference = r.u(10);
    let picture_coding_type = PictureType::from_code(r.u(3));
    let vbv_delay = r.u(16);
    let mut full_pel_forward_vector = false;
    let mut forward_f_code = 0;
    let mut full_pel_backward_vector = false;
    let mut backward_f_code = 0;
    if matches!(picture_coding_type, PictureType::P | PictureType::B) {
        full_pel_forward_vector = r.flag();
        forward_f_code = r.u(3);
    }
    if picture_coding_type == PictureType::B {
        full_pel_backward_vector = r.flag();
        backward_f_code = r.u(3);
    }
    while r.peek(1) == 1 {
        r.skip(1); // extra_bit_picture
        r.skip(8); // extra_information_picture
    }
    r.skip(1); // extra_bit_picture == 0
    PictureHeader {
        temporal_reference,
        picture_coding_type,
        vbv_delay,
        full_pel_forward_vector,
        forward_f_code,
        full_pel_backward_vector,
        backward_f_code,
    }
}

fn read_picture_coding_extension(r: &mut BitReader<'_>) -> PictureCodingExtension {
    let f_code = [[r.u(4), r.u(4)], [r.u(4), r.u(4)]];
    let ext = PictureCodingExtension {
        f_code,
        intra_dc_precision: r.u(2),
        picture_structure: PictureStructure::from_code(r.u(2)),
        top_field_first: r.flag(),
        frame_pred_frame_dct: r.flag(),
        concealment_motion_vectors: r.flag(),
        q_scale_type: r.u(1) as usize,
        intra_vlc_format: r.u(1),
        alternate_scan: r.flag(),
        repeat_first_field: r.flag(),
        chroma_420_type: r.flag(),
        progressive_frame: r.flag(),
    };
    if r.flag() {
        // composite_display_flag
        r.skip(1 + 3 + 1 + 7 + 8);
    }
    ext
}

/// Parse a full MPEG-2 elementary stream into pictures.
///
/// Slices are recorded as bit ranges rather than being decoded here: the
/// macroblock layer is re-coded rather than reconstructed, so it is handled by a
/// separate pass that can run per-slice.
pub fn parse_elementary_stream(data: &[u8]) -> Result<Vec<Picture>> {
    let codes = find_start_codes(data);
    let mut pictures: Vec<Picture> = Vec::new();

    let mut seq: Option<SequenceHeader> = None;
    let mut seq_ext: Option<SequenceExtension> = None;
    let mut quant = QuantMatrices::default();
    let mut current: Option<usize> = None;
    let mut saw_gop_header = false;
    // The sequence description in hand: where its header starts, and one past
    // the last thing that changed it. Recorded on each picture so that one
    // picture can be re-parsed on its own; see [`Picture::context_start`].
    let mut context_start = 0;
    let mut context_end = 0;

    for (position, sc) in codes.iter().enumerate() {
        // A start code terminates whatever slice was in progress.
        if let Some(index) = current {
            if let Some(last) = pictures[index].slices.last_mut() {
                if last.data_end_bit.is_none() {
                    last.data_end_bit = Some(sc.offset * 8);
                }
            }
        }

        let mut r = BitReader::at_bit(data, sc.payload_offset * 8);
        // Where this header stops, which is where the next one starts.
        let ends_at = codes
            .get(position + 1)
            .map_or(data.len(), |next| next.offset);

        if sc.code == start_code::SEQUENCE_HEADER {
            let (header, matrices) = read_sequence_header(&mut r)?;
            seq = Some(header);
            quant = matrices;
            seq_ext = None;
            context_start = sc.offset;
            context_end = ends_at;
        } else if sc.code == start_code::EXTENSION {
            let id = r.u(4);
            if id == extension::SEQUENCE {
                if let Some(header) = seq.as_mut() {
                    seq_ext = Some(read_sequence_extension(&mut r, header)?);
                    context_end = ends_at;
                }
            } else if id == extension::QUANT_MATRIX {
                context_end = ends_at;
                // Applies from the next picture onwards; the already-emitted
                // pictures keep the matrices they were coded with, which value
                // semantics give for free.
                read_quant_matrix_extension(&mut r, &mut quant);
                if let Some(index) = current {
                    pictures[index].quant = quant.clone();
                }
            } else if id == extension::PICTURE_CODING {
                if let Some(index) = current {
                    pictures[index].coding = read_picture_coding_extension(&mut r);
                }
            }
        } else if sc.code == start_code::PICTURE {
            // A transport-stream recording can begin in the middle of a GOP.
            // Pictures before the first sequence header have no dimensions or
            // coding parameters with which to decode them, so discard that
            // incomplete prefix and start at the first self-describing unit.
            let Some(sequence) = seq else {
                current = None;
                continue;
            };
            let header = read_picture_header(&mut r);
            pictures.push(Picture {
                starts_gop: saw_gop_header,
                coding: PictureCodingExtension::mpeg1_default(&header),
                header,
                sequence,
                sequence_ext: seq_ext.unwrap_or_else(SequenceExtension::mpeg1_default),
                quant: quant.clone(),
                slices: Vec::new(),
                context_start,
                context_end,
            });
            saw_gop_header = false;
            current = Some(pictures.len() - 1);
        } else if sc.code == start_code::GROUP {
            saw_gop_header = true;
        } else if (start_code::SLICE_MIN..=start_code::SLICE_MAX).contains(&sc.code) {
            let Some(index) = current else { continue };
            let mut vertical_position = sc.code as u32;
            if pictures[index].sequence.vertical_size > 2800 {
                vertical_position += r.u(3) << 7; // slice_vertical_position_extension
            }
            let quantiser_scale_code = r.u(5);
            if r.peek(1) == 1 {
                r.skip(1); // intra_slice_flag
                r.skip(1); // intra_slice
                r.skip(7); // reserved_bits
                while r.peek(1) == 1 {
                    r.skip(1); // extra_bit_slice
                    r.skip(8); // extra_information_slice
                }
            }
            r.skip(1); // extra_bit_slice == 0
            pictures[index].slices.push(Slice {
                vertical_position,
                quantiser_scale_code,
                data_start_bit: r.bit_pos(),
                data_end_bit: None,
            });
        }
    }

    if let Some(index) = current {
        if let Some(last) = pictures[index].slices.last_mut() {
            if last.data_end_bit.is_none() {
                last.data_end_bit = Some(data.len() * 8);
            }
        }
    }
    Ok(pictures)
}
