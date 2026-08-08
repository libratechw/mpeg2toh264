//! Splitting an MPEG-2 elementary stream into bounded, independently
//! transcodable units.

use std::collections::VecDeque;
use std::ops::ControlFlow;

use crate::mpeg2::constants::start_code;
use crate::mpeg2::headers::stream_sequence_description;

/// Walk every `00 00 01 <code>` start code in `data` in order, handing each
/// offset and its code byte to `visit`, and stop as soon as `visit` breaks.
///
/// One walk answers every question the splitter asks. Looking each kind of
/// start code up on its own walked the buffer five times to cut one group,
/// and at broadcast bitrates that is megabytes a group.
///
/// The common case -- coded data with no zero byte anywhere near -- is skipped
/// eight bytes at a time rather than one.
fn scan_start_codes(data: &[u8], mut visit: impl FnMut(usize, u8) -> ControlFlow<()>) {
    if data.len() < 4 {
        return;
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
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            if visit(i, data[i + 3]).is_break() {
                return;
            }
            // The next start code cannot begin before the code byte, which is
            // the first position after this one that is allowed to be zero.
            i += 3;
        } else {
            i += 1;
        }
    }
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
    /// Start-code offsets in `buffer`, discovered once as bytes arrive.
    sequences: VecDeque<usize>,
    gops: VecDeque<usize>,
    pictures: VecDeque<usize>,
    /// First byte that has not been tested as the start of a four-byte code.
    /// The final three bytes remain pending until the next chunk completes it.
    scan_pos: usize,
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
        self.scan_new_bytes();
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
        Self::consume_offsets(&mut self.sequences, count);
        Self::consume_offsets(&mut self.gops, count);
        Self::consume_offsets(&mut self.pictures, count);
        self.scan_pos = self.scan_pos.saturating_sub(count);
    }

    fn consume_offsets(offsets: &mut VecDeque<usize>, count: usize) {
        while offsets.front().is_some_and(|&offset| offset < count) {
            offsets.pop_front();
        }
        for offset in offsets {
            *offset -= count;
        }
    }

    /// Scan only bytes that no earlier push had enough lookahead to inspect.
    fn scan_new_bytes(&mut self) {
        let from = self.scan_pos.min(self.buffer.len());
        let Self {
            buffer,
            sequences,
            gops,
            pictures,
            ..
        } = self;
        scan_start_codes(&buffer[from..], |at, code| {
            let at = from + at;
            match code {
                start_code::SEQUENCE_HEADER => sequences.push_back(at),
                start_code::GROUP => gops.push_back(at),
                start_code::PICTURE => pictures.push_back(at),
                _ => {}
            }
            ControlFlow::Continue(())
        });
        self.scan_pos = self.buffer.len().saturating_sub(3);
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

    /// Where a unit running from the start of the buffer to `boundary` has to
    /// be cut short because a sequence header inside it describes something
    /// else.
    ///
    /// A unit carries one description: the H.264 parameter sets and the MP4
    /// sample entry are built from the header it opens with, and every picture
    /// in it is coded under that. A stream that changes format restarts its
    /// groups as well, so the cut above normally lands on the change anyway --
    /// this is for the stream that puts the new header somewhere else, and it
    /// costs a look only when a unit holds a second header at all.
    fn description_boundary(&self, first_gop: usize, boundary: usize) -> usize {
        let inner = self
            .sequences
            .iter()
            .copied()
            .filter(|&at| at > first_gop && at < boundary);
        let mut opening = None;
        for at in inner {
            let opening = opening
                .get_or_insert_with(|| stream_sequence_description(&self.buffer[..boundary]));
            if stream_sequence_description(&self.buffer[at..boundary]) != *opening {
                return at;
            }
        }
        boundary
    }

    fn extract(&mut self, final_flush: bool) -> Vec<Mpeg2Gop> {
        let mut output = Vec::new();
        loop {
            let Some(&first_gop) = self.gops.front() else {
                // Nothing to cut on yet. Anything before the first sequence
                // header cannot be transcoded, so it is dropped rather than
                // held.
                if let Some(&first_sequence) = self.sequences.front() {
                    if first_sequence > 0 {
                        self.consume(first_sequence);
                    }
                }
                break;
            };
            // Everything the offsets above name moves down by this much once
            // the bytes ahead of the sequence header are dropped.
            let mut dropped = 0;
            if first_gop > 0 {
                // Remember the sequence header this group was coded under, so
                // the units after it can be given a copy.
                if let Some(&sequence) = self.sequences.iter().rev().find(|&&at| at < first_gop) {
                    self.sequence_prefix = self.buffer[sequence..first_gop].to_vec();
                    if sequence > 0 {
                        self.consume(sequence);
                        dropped = sequence;
                    }
                }
            }
            // Every offset from here on is read back out of the deques, which
            // the drop above has already moved; the one captured before it has
            // to be moved to match.
            let first_gop = first_gop - dropped;
            let Some(&second_gop) = self.gops.get(1) else {
                break;
            };
            // A sequence header of its own makes a better boundary than the
            // group header behind it, since the next unit then needs no
            // re-injected copy.
            let next_sequence = self
                .sequences
                .iter()
                .rev()
                .find(|&&at| at > first_gop && at < second_gop)
                .copied();
            let boundary = next_sequence.unwrap_or(second_gop);
            let boundary = self.description_boundary(first_gop, boundary);
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
                let injected = self.sequence_prefix.len();
                self.prefix_length += injected;
                for offset in &mut self.sequences {
                    *offset += injected;
                }
                for offset in &mut self.gops {
                    *offset += injected;
                }
                for offset in &mut self.pictures {
                    *offset += injected;
                }
                self.sequences.push_front(0);
                self.scan_pos += injected;
            }
        }
        if final_flush && !self.pictures.is_empty() {
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
