//! Splitting an MPEG-2 elementary stream into bounded, independently
//! transcodable units.

use crate::mpeg2::constants::start_code;

/// Offsets of every `00 00 01 <code>` start code in the buffer.
///
/// The whole buffer is walked for every group boundary the splitter looks for,
/// and at broadcast bitrates that is megabytes per group, so the common case --
/// coded data with no zero byte anywhere near -- is skipped eight bytes at a
/// time rather than one.
fn starts(data: &[u8], code: u8) -> Vec<usize> {
    let mut out = Vec::new();
    if data.len() < 4 {
        return out;
    }
    let last = data.len() - 4;
    let mut i = 0;
    while i <= last {
        if i + 8 <= data.len() {
            let word = u64::from_le_bytes(data[i..i + 8].try_into().expect("eight bytes"));
            // The usual zero-byte test: a byte borrows into its high bit only
            // if it was zero. A start code opens with two of them, so a run
            // without any cannot hold the beginning of one.
            if word.wrapping_sub(0x0101_0101_0101_0101) & !word & 0x8080_8080_8080_8080 == 0 {
                i += 8;
                continue;
            }
        }
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 && data[i + 3] == code {
            out.push(i);
            i += 4;
        } else {
            i += 1;
        }
    }
    out
}

/// One GOP unit, and when its first coded picture is meant to be shown.
#[derive(Clone, Debug)]
pub struct Mpeg2Gop {
    pub data: Vec<u8>,
    /// The PES presentation timestamp covering the unit's first byte, in 90 kHz
    /// units, or `None` when the caller supplied none.
    ///
    /// A unit begins at a sequence or GOP header, which a transport stream
    /// places at the start of the PES that also carries the I picture, so this
    /// is that picture's timestamp. Whatever the splitter discarded before it
    /// -- and it discards everything before the first sequence header, which
    /// can be several pictures -- is already excluded.
    pub pts: Option<u64>,
}

/// Where a PES packet's payload landed in the stream, and what time it claimed.
#[derive(Clone, Copy)]
struct Mark {
    offset: usize,
    pts: u64,
}

/// Split an MPEG-2 ES into bounded GOP units while carrying sequence headers
/// forward, so each unit can be transcoded on its own.
#[derive(Default)]
pub struct Mpeg2GopStream {
    buffer: Vec<u8>,
    sequence_prefix: Vec<u8>,
    /// Absolute stream offset of the first byte of `buffer` that came from the
    /// stream, which is `buffer[prefix_length]`: a re-injected sequence header
    /// is not part of the stream and has no offset of its own.
    base: usize,
    prefix_length: usize,
    marks: Vec<Mark>,
}

impl Mpeg2GopStream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8], pts: Option<u64>) -> Vec<Mpeg2Gop> {
        if let Some(pts) = pts {
            self.marks.push(Mark {
                offset: self.base + self.buffer.len() - self.prefix_length,
                pts,
            });
        }
        self.buffer.extend_from_slice(chunk);
        self.extract(false)
    }

    pub fn finish(&mut self) -> Vec<Mpeg2Gop> {
        self.extract(true)
    }

    /// Drop bytes from the front, keeping the offset mapping in step.
    fn consume(&mut self, count: usize) {
        let from_prefix = count.min(self.prefix_length);
        self.prefix_length -= from_prefix;
        self.base += count - from_prefix;
        self.buffer.drain(..count);
    }

    /// The timestamp of the PES packet covering an absolute stream offset.
    fn pts_at(&mut self, offset: usize) -> Option<u64> {
        let mut pts = None;
        let mut covering: isize = -1;
        for (i, mark) in self.marks.iter().enumerate() {
            if mark.offset > offset {
                break;
            }
            pts = Some(mark.pts);
            covering = i as isize;
        }
        if covering > 0 {
            self.marks.drain(..covering as usize);
        }
        pts
    }

    fn extract(&mut self, final_flush: bool) -> Vec<Mpeg2Gop> {
        let mut output = Vec::new();
        loop {
            let sequences = starts(&self.buffer, start_code::SEQUENCE_HEADER);
            let gops = starts(&self.buffer, start_code::GROUP);
            let Some(&first_gop) = gops.first() else {
                // Nothing to cut on yet. Anything before the first sequence
                // header cannot be transcoded, so it is dropped rather than
                // held.
                if let Some(&first_sequence) = sequences.first() {
                    if first_sequence > 0 {
                        self.consume(first_sequence);
                    }
                }
                break;
            };
            if first_gop > 0 {
                // Remember the sequence header this group was coded under, so
                // the units after it can be given a copy.
                if let Some(&sequence) = sequences.iter().rev().find(|&&at| at < first_gop) {
                    self.sequence_prefix = self.buffer[sequence..first_gop].to_vec();
                    if sequence > 0 {
                        self.consume(sequence);
                    }
                }
            }
            let current_gops = starts(&self.buffer, start_code::GROUP);
            if current_gops.len() < 2 {
                break;
            }
            let second_gop = current_gops[1];
            // A sequence header of its own makes a better boundary than the
            // group header behind it, since the next unit then needs no
            // re-injected copy.
            let next_sequence = starts(&self.buffer, start_code::SEQUENCE_HEADER)
                .into_iter()
                .rev()
                .find(|&at| at > current_gops[0] && at < second_gop);
            let boundary = next_sequence.unwrap_or(second_gop);
            let pts = self.pts_at(self.base);
            output.push(Mpeg2Gop {
                data: self.buffer[..boundary].to_vec(),
                pts,
            });
            self.consume(boundary);
            if next_sequence.is_none() && !self.sequence_prefix.is_empty() {
                // The next unit begins mid-sequence, so it needs its own copy
                // of the header to be decodable on its own.
                let mut merged = self.sequence_prefix.clone();
                merged.append(&mut self.buffer);
                self.buffer = merged;
                self.prefix_length += self.sequence_prefix.len();
            }
        }
        if final_flush && !starts(&self.buffer, start_code::PICTURE).is_empty() {
            let pts = self.pts_at(self.base);
            output.push(Mpeg2Gop {
                data: std::mem::take(&mut self.buffer),
                pts,
            });
            self.prefix_length = 0;
        }
        output
    }
}
