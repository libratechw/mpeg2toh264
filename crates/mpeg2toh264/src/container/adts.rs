//! ADTS framing for AAC-LC.
//!
//! Spectral Huffman data is never re-encoded. Stereo CPE payloads pass through;
//! mono and dual-mono SCE payloads are repackaged as a CPE containing two copies
//! of the primary channel, then the ADTS header is removed for fragmented MP4.

use super::aac::{cpe_end, sce_end, single_channel_end};
use crate::error::{bail, Result};

/// `sampling_frequency_index` to sample rate (ISO/IEC 14496-3 Table 1.16).
static SAMPLE_RATES: [u32; 13] = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
    7_350,
];

/// Samples in one AAC-LC access unit.
pub const AAC_FRAME_SAMPLES: u64 = 1024;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AacConfig {
    pub audio_object_type: u8,
    pub sample_rate: u32,
    pub sampling_frequency_index: u8,
    pub channel_count: u8,
    /// The AudioSpecificConfig an `esds` box carries. Explicit PCE layouts are
    /// longer than the usual two-byte implicit configuration.
    pub audio_specific_config: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct AacFrame {
    pub data: Vec<u8>,
    pub config: AacConfig,
}

/// AAC access units needed through an absolute 90 kHz video decode time. The
/// result can be negative, when the audio track starts later than the video
/// time being asked about.
pub fn aac_frame_count_through_video_time(video_time: i64, sample_rate: u32) -> i64 {
    let frames = (video_time as f64 * sample_rate as f64) / (90_000.0 * AAC_FRAME_SAMPLES as f64);
    crate::round_half_up(frames) as i64
}

/// Incrementally remove ADTS headers without touching AAC payload bits.
#[derive(Default)]
pub struct AdtsStream {
    pending: Vec<u8>,
    current_config: Option<AacConfig>,
    /// The channel elements of the last frame that walked, by id and instance
    /// tag. Until one has, a walk that fails says nothing about the frame;
    /// after one has, it says the frame is damaged -- and so does a frame that
    /// walks but names elements the last one did not.
    chain: Option<Vec<(u8, u8)>>,
}

fn bit(data: &[u8], at: usize) -> u8 {
    (data[at >> 3] >> (7 - (at & 7))) & 1
}

/// Return the first channel element, skipping any byte-counted fill elements
/// an encoder placed before it.
struct PceInfo {
    end: usize,
    body_start: usize,
    body_end: usize,
    channels: u8,
}

fn parse_pce(data: &[u8], start: usize) -> Result<PceInfo> {
    let mut r = crate::bitreader::BitReader::at_bit(data, start + 3);
    r.skip(4 + 2 + 4); // tag, object_type, sampling_frequency_index
    let front = r.u(4);
    let side = r.u(4);
    let back = r.u(4);
    let lfe = r.u(2);
    let assoc = r.u(3);
    let cc = r.u(4);
    if r.flag() {
        r.skip(4);
    } // mono_mixdown_element_number
    if r.flag() {
        r.skip(4);
    } // stereo_mixdown_element_number
    if r.flag() {
        r.skip(3);
    } // matrix_mixdown_idx, pseudo_surround_enable
    let mut channels = lfe as u8;
    for _ in 0..front + side + back {
        channels += if r.flag() { 2 } else { 1 };
        r.skip(4);
    }
    r.skip((lfe + assoc) * 4 + cc * 5);
    let body_end = r.bit_pos();
    r.align_to_byte();
    let comments = r.u(8);
    r.skip(comments * 8);
    if r.bits_left() < 0 {
        bail!("AAC program_config_element overruns the raw_data_block");
    }
    Ok(PceInfo {
        end: r.bit_pos(),
        body_start: start + 3,
        body_end,
        channels,
    })
}

/// Step over a fill element, which is byte-counted rather than parsed.
fn fill_element_end(data: &[u8], at: usize) -> usize {
    let mut at = at + 3;
    let mut count = (0..4).fold(0usize, |v, n| (v << 1) | bit(data, at + n) as usize);
    at += 4;
    if count == 15 {
        let extra = (0..8).fold(0usize, |v, n| (v << 1) | bit(data, at + n) as usize);
        at += 8;
        count += extra.saturating_sub(1);
    }
    at + count * 8
}

/// One past the last bit of ID_END, walking whatever fill elements sit between
/// the channel element and it.
///
/// What follows ID_END is the alignment the encoder wrote, and a rewrite that
/// carries it across ends up padding a frame that was padded already: the two
/// together come to more than a byte about half the time, which leaves a whole
/// byte hanging off the end of the block. Decoders that stop reading at ID_END
/// never notice; ones that check the frame against the bytes they consumed
/// reject it, and half the frames of a mono service went missing that way.
fn raw_data_block_end(data: &[u8], mut at: usize) -> Result<usize> {
    let total = data.len() * 8;
    loop {
        if at + 3 > total {
            bail!("AAC raw_data_block ended before ID_END");
        }
        match (bit(data, at) << 2) | (bit(data, at + 1) << 1) | bit(data, at + 2) {
            7 => return Ok(at + 3),
            6 => at = fill_element_end(data, at),
            id => bail!("unsupported AAC element {id} after the channel element"),
        }
    }
}

/// Whether every element of a raw_data_block can be walked to its end.
///
/// A broadcast recording carries the odd damaged access unit, and one handed to
/// a decoder is not a frame it skips: it is an error that stops the stream. The
/// video path drops a picture whose slices will not decode, and this is the
/// same decision made on the same grounds -- what cannot be walked here is what
/// a decoder cannot read either, which is how the frame that prompted this was
/// found: the fourth element of an otherwise ordinary 5.1 frame read as a
/// single channel element with prediction, which AAC-LC does not have.
///
/// Only the sample rates the element walker handles can be judged. At anything
/// else the frame goes out unexamined, as it always did.
fn raw_data_block_chain(data: &[u8], frequency_index: u8) -> Option<Vec<(u8, u8)>> {
    if frequency_index != 3 && frequency_index != 4 {
        return Some(Vec::new());
    }
    let mut chain = Vec::new();
    let mut at = 0;
    loop {
        if at + 3 > data.len() * 8 {
            return None;
        }
        let id = (bit(data, at) << 2) | (bit(data, at + 1) << 1) | bit(data, at + 2);
        if matches!(id, 0 | 1 | 3) {
            if at + 7 > data.len() * 8 {
                return None;
            }
            let tag = (bit(data, at + 3) << 3)
                | (bit(data, at + 4) << 2)
                | (bit(data, at + 5) << 1)
                | bit(data, at + 6);
            chain.push((id, tag));
        }
        let next = match id {
            7 => return Some(chain),
            0 | 3 => single_channel_end(data, at, frequency_index, id as u32),
            1 => cpe_end(data, at, frequency_index),
            5 => parse_pce(data, at).map(|pce| pce.end),
            6 => Ok(fill_element_end(data, at)),
            _ => return None,
        };
        match next {
            Ok(end) if end > at => at = end,
            _ => return None,
        }
    }
}

fn first_channel_element(data: &[u8]) -> Result<(u8, usize, Vec<(usize, usize)>, Option<PceInfo>)> {
    let mut at = 0;
    let mut pces = Vec::new();
    let mut pce = None;
    loop {
        if at + 7 > data.len() * 8 {
            bail!("AAC raw_data_block ended before a channel element");
        }
        let id = (bit(data, at) << 2) | (bit(data, at + 1) << 1) | bit(data, at + 2);
        if id == 0 || id == 1 {
            return Ok((id, at, pces, pce));
        }
        if id == 5 {
            let info = parse_pce(data, at)?;
            pces.push((at, info.end));
            at = info.end;
            pce = Some(info);
            continue;
        }
        if id != 6 {
            bail!("unsupported AAC element {id} before the channel element");
        }
        at = fill_element_end(data, at);
        if at + 7 > data.len() * 8 {
            bail!("AAC FIL element overruns the raw_data_block");
        }
    }
}

struct Bits {
    data: Vec<u8>,
    len: usize,
}

impl Bits {
    fn push(&mut self, value: u8) {
        if self.len & 7 == 0 {
            self.data.push(0);
        }
        if value != 0 {
            self.data[self.len >> 3] |= 1 << (7 - (self.len & 7));
        }
        self.len += 1;
    }
    fn value(&mut self, n: usize, value: u32) {
        for shift in (0..n).rev() {
            self.push(((value >> shift) & 1) as u8);
        }
    }
    fn copy(&mut self, source: &[u8], start: usize, end: usize) {
        for at in start..end {
            self.push(bit(source, at));
        }
    }
}

fn pce_audio_specific_config(
    data: &[u8],
    pce: &PceInfo,
    audio_object_type: u8,
    frequency_index: u8,
) -> Vec<u8> {
    let mut out = Bits {
        data: Vec::new(),
        len: 0,
    };
    out.value(5, audio_object_type as u32);
    out.value(4, frequency_index as u32);
    out.value(4, 0); // channelConfiguration: use the following PCE
    out.value(3, 0); // frameLengthFlag, dependsOnCoreCoder, extensionFlag
    out.copy(data, pce.body_start, pce.body_end);
    while out.len & 7 != 0 {
        out.push(0);
    }
    out.value(8, 0); // comment_field_bytes
    out.data
}

/// Turn SCE or SCE+SCE (dual mono) into a CPE with two identical independent
/// channel streams. The first SCE is the main service; no spectral value is
/// decoded or re-encoded.
fn primary_sce_to_cpe(
    data: &[u8],
    sce: usize,
    frequency_index: u8,
    pces: &[(usize, usize)],
) -> Result<Vec<u8>> {
    let primary_end = sce_end(data, sce, frequency_index)?;
    let mut tail = primary_end;
    if tail + 7 <= data.len() * 8
        && bit(data, tail) == 0
        && bit(data, tail + 1) == 0
        && bit(data, tail + 2) == 0
    {
        tail = sce_end(data, tail, frequency_index)?; // discard the sub service
    }
    let mut out = Bits {
        data: Vec::with_capacity(data.len()),
        len: 0,
    };
    let mut prefix = 0;
    for &(start, end) in pces {
        out.copy(data, prefix, start);
        prefix = end;
    }
    out.copy(data, prefix, sce);
    out.value(3, 1); // ID_CPE
    out.copy(data, sce + 3, sce + 7); // element_instance_tag
    out.push(0); // common_window: each copy carries its own ics_info
    out.copy(data, sce + 7, primary_end);
    out.copy(data, sce + 7, primary_end);
    out.copy(data, tail, raw_data_block_end(data, tail)?);
    Ok(out.data)
}

impl AdtsStream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<AacFrame>> {
        self.pending.extend_from_slice(chunk);
        let mut output = Vec::new();
        let mut at = 0;
        while at + 7 <= self.pending.len() {
            // The syncword is twelve set bits; the layer bits below it must be
            // zero, which is what the 0xf6 mask checks.
            if self.pending[at] != 0xff || self.pending[at + 1] & 0xf6 != 0xf0 {
                at += 1;
                continue;
            }
            let protection_absent = self.pending[at + 1] & 1;
            let audio_object_type = ((self.pending[at + 2] >> 6) & 3) + 1;
            let sampling_frequency_index = (self.pending[at + 2] >> 2) & 15;
            let channel_count = ((self.pending[at + 2] & 1) << 2) | (self.pending[at + 3] >> 6);
            let frame_length = (((self.pending[at + 3] & 3) as usize) << 11)
                | ((self.pending[at + 4] as usize) << 3)
                | (self.pending[at + 5] >> 5) as usize;
            let header_length = if protection_absent != 0 { 7 } else { 9 };
            let raw_blocks = self.pending[at + 6] & 3;

            if audio_object_type != 2 {
                bail!("unsupported ADTS audio object type {audio_object_type}; AAC-LC is required");
            }
            let Some(&sample_rate) = SAMPLE_RATES.get(sampling_frequency_index as usize) else {
                bail!("unsupported ADTS sampling_frequency_index {sampling_frequency_index}");
            };
            if raw_blocks != 0 {
                bail!("ADTS frames with multiple raw data blocks are unsupported");
            }
            if frame_length < header_length {
                bail!("invalid ADTS frame length");
            }
            if at + frame_length > self.pending.len() {
                break;
            }

            let raw_data = &self.pending[at + header_length..at + frame_length];
            // Damaged. A stream this walker has read once it can read, so a
            // frame it cannot is one a decoder cannot either -- and one whose
            // elements are not the ones the stream has been carrying will be
            // refused just the same, since a decoder only has room for the
            // elements its configuration named. Handing either over does not
            // cost a frame, it stops the stream.
            match raw_data_block_chain(raw_data, sampling_frequency_index) {
                Some(chain) if self.chain.as_ref().is_none_or(|last| *last == chain) => {
                    self.chain = Some(chain);
                }
                // A mono or dual-mono service is rebuilt from its primary
                // element alone and switches between the two as the broadcast
                // does, so its chain is not fixed and is not judged by this.
                _ if channel_count != 0 && channel_count <= 2 => {}
                _ if self.chain.is_none() => {}
                _ => {
                    at += frame_length;
                    continue;
                }
            }

            // A mono service and ARIB dual-mono both use SCEs. Repackage the
            // primary SCE as both independent streams of a CPE, so every mode
            // has the same channel_configuration=2 ASC. Genuine stereo CPEs
            // pass through unchanged.
            let (first_element, channel_start, pces, pce) = first_channel_element(raw_data)?;
            let input_channels = if channel_count != 0 {
                channel_count
            } else if let Some(pce) = &pce {
                pce.channels
            } else if let Some(current) = &self.current_config {
                current.channel_count
            } else {
                // A broadcast mono or dual-mono service leaves the header's
                // channel configuration at zero and sends no
                // program_config_element to carry one either: what the service
                // is lives in the PMT, which is not where anything reading a
                // raw ADTS stream would look. The element itself says enough
                // for the repackaging below -- a single channel element is one
                // channel, a channel pair is two -- and a stream that opens
                // mid-way, as one resumed at a seek does, has nothing else to
                // go on.
                if first_element == 0 {
                    1
                } else {
                    2
                }
            };
            let sce_service = input_channels <= 2 && (input_channels == 1 || first_element == 0);
            let output_channels = if sce_service { 2 } else { input_channels };
            let audio_specific_config = if sce_service {
                vec![
                    (audio_object_type << 3) | (sampling_frequency_index >> 1),
                    ((sampling_frequency_index & 1) << 7) | (2 << 3),
                ]
            } else if channel_count == 0 {
                if let Some(pce) = &pce {
                    pce_audio_specific_config(
                        raw_data,
                        pce,
                        audio_object_type,
                        sampling_frequency_index,
                    )
                } else if let Some(current) = &self.current_config {
                    current.audio_specific_config.clone()
                } else {
                    vec![
                        (audio_object_type << 3) | (sampling_frequency_index >> 1),
                        ((sampling_frequency_index & 1) << 7) | (input_channels << 3),
                    ]
                }
            } else {
                vec![
                    (audio_object_type << 3) | (sampling_frequency_index >> 1),
                    ((sampling_frequency_index & 1) << 7) | (channel_count << 3),
                ]
            };
            let config = AacConfig {
                audio_object_type,
                sample_rate,
                sampling_frequency_index,
                channel_count: output_channels,
                audio_specific_config,
            };
            if let Some(current) = &self.current_config {
                if current.sample_rate != sample_rate
                    || current.audio_specific_config != config.audio_specific_config
                {
                    bail!(
                        "ADTS configuration changed within the stream ({:?} -> {:?}, element {})",
                        current.audio_specific_config,
                        config.audio_specific_config,
                        first_element
                    );
                }
            }
            self.current_config = Some(config.clone());
            output.push(AacFrame {
                data: if sce_service {
                    primary_sce_to_cpe(raw_data, channel_start, sampling_frequency_index, &pces)?
                } else {
                    raw_data.to_vec()
                },
                config,
            });
            at += frame_length;
        }
        self.pending.drain(..at);
        Ok(output)
    }

    pub fn finish(&mut self) -> Result<Vec<AacFrame>> {
        let output = self.push(&[])?;
        // Whatever is left is the part of a frame the input was cut in the
        // middle of, which a recording that stopped mid-frame ends with. A
        // fraction of an access unit is not something a decoder can be given,
        // and refusing the whole stream over the last few milliseconds of it
        // would be worse, so it goes.
        self.pending.clear();
        Ok(output)
    }
}
