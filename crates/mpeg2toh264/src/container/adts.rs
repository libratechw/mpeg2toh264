//! ADTS framing for AAC-LC.
//!
//! The audio is never re-encoded: the payload bits are carried across
//! untouched, and only the ADTS header comes off, since fragmented MP4 carries
//! the same configuration in an `esds` box instead.

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
    /// The two-byte AudioSpecificConfig an `esds` box carries.
    pub audio_specific_config: [u8; 2],
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
            if channel_count == 0 {
                bail!("ADTS program_config_element channel layout is unsupported");
            }
            if raw_blocks != 0 {
                bail!("ADTS frames with multiple raw data blocks are unsupported");
            }
            if frame_length < header_length {
                bail!("invalid ADTS frame length");
            }
            if at + frame_length > self.pending.len() {
                break;
            }

            let config = AacConfig {
                audio_object_type,
                sample_rate,
                sampling_frequency_index,
                channel_count,
                audio_specific_config: [
                    (audio_object_type << 3) | (sampling_frequency_index >> 1),
                    ((sampling_frequency_index & 1) << 7) | (channel_count << 3),
                ],
            };
            if let Some(current) = &self.current_config {
                if current.sample_rate != sample_rate || current.channel_count != channel_count {
                    bail!("ADTS configuration changed within the stream");
                }
            }
            self.current_config = Some(config.clone());
            output.push(AacFrame {
                data: self.pending[at + header_length..at + frame_length].to_vec(),
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
