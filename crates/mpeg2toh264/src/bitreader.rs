//! Bit reader for MPEG-2 elementary streams.
//!
//! MPEG-2 has no emulation prevention bytes, so the byte stream maps directly to
//! the bit stream. Start codes are byte-aligned `00 00 01 xx` sequences and are
//! guaranteed not to occur inside coded data, which is what lets us scan for them.

use crate::error::{bail, Result};

pub struct BitReader<'a> {
    pub data: &'a [u8],
    /// Absolute position in bits from the start of `data`.
    pos: usize,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn at_bit(data: &'a [u8], start_bit: usize) -> Self {
        Self {
            data,
            pos: start_bit,
        }
    }

    pub fn bit_pos(&self) -> usize {
        self.pos
    }

    pub fn set_bit_pos(&mut self, pos: usize) {
        self.pos = pos;
    }

    pub fn byte_pos(&self) -> usize {
        self.pos >> 3
    }

    pub fn bits_left(&self) -> isize {
        self.data.len() as isize * 8 - self.pos as isize
    }

    pub fn at_end(&self) -> bool {
        self.pos >= self.data.len() * 8
    }

    /// Reading past the end yields zero bits rather than failing: a slice runs
    /// until the next start code, and the last one in a buffer simply stops.
    #[inline]
    fn byte_at(&self, index: usize) -> u32 {
        self.data.get(index).copied().unwrap_or(0) as u32
    }

    #[inline]
    fn word_at(&self, byte: usize) -> u32 {
        (self.byte_at(byte) << 24)
            | (self.byte_at(byte + 1) << 16)
            | (self.byte_at(byte + 2) << 8)
            | self.byte_at(byte + 3)
    }

    /// Read `n` bits (n <= 32) MSB-first as an unsigned integer.
    #[inline]
    pub fn u(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        // A four-byte window covers any request that starts at any bit offset
        // and spans at most 25 bits, which is every field but the widest few.
        if n <= 25 {
            let value = (self.word_at(self.pos >> 3) << (self.pos & 7) as u32) >> (32 - n);
            self.pos += n as usize;
            return value;
        }
        let mut value: u64 = 0;
        let mut left = n;
        let mut p = self.pos;
        while left > 0 {
            let bit_offset = (p & 7) as u32;
            let avail = 8 - bit_offset;
            let take = avail.min(left);
            // Extract `take` bits starting at bit_offset within the byte.
            let chunk = (self.byte_at(p >> 3) >> (avail - take)) & ((1 << take) - 1);
            value = (value << take) | chunk as u64;
            p += take as usize;
            left -= take;
        }
        self.pos = p;
        value as u32
    }

    /// Peek `n` bits without consuming them.
    #[inline]
    pub fn peek(&self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        if n <= 25 {
            return (self.word_at(self.pos >> 3) << (self.pos & 7) as u32) >> (32 - n);
        }
        let mut value: u64 = 0;
        let mut left = n;
        let mut p = self.pos;
        while left > 0 {
            let bit_offset = (p & 7) as u32;
            let avail = 8 - bit_offset;
            let take = avail.min(left);
            let chunk = (self.byte_at(p >> 3) >> (avail - take)) & ((1 << take) - 1);
            value = (value << take) | chunk as u64;
            p += take as usize;
            left -= take;
        }
        value as u32
    }

    /// Read a single bit as a boolean.
    #[inline]
    pub fn flag(&mut self) -> bool {
        self.u(1) == 1
    }

    #[inline]
    pub fn skip(&mut self, n: u32) {
        self.pos += n as usize;
    }

    /// MPEG-2 `marker_bit`: a bit that shall be 1, present purely to prevent
    /// accidental start code emulation. A zero here means we have lost sync.
    pub fn marker(&mut self) -> Result<()> {
        if self.u(1) != 1 {
            bail!("marker_bit was 0 at bit {} (lost sync)", self.pos - 1);
        }
        Ok(())
    }

    pub fn is_byte_aligned(&self) -> bool {
        self.pos & 7 == 0
    }

    pub fn align_to_byte(&mut self) {
        self.pos = (self.pos + 7) & !7;
    }

    /// MPEG-2 `nextbits() == '0000 0000 0000 0000 0000 0001'`: true when the
    /// upcoming (byte-aligned) data is a start code prefix. Used to detect the
    /// end of a slice, since slices are terminated by whatever start code
    /// follows.
    pub fn at_start_code(&self) -> bool {
        let byte = ((self.pos + 7) & !7) >> 3;
        self.data.get(byte) == Some(&0x00)
            && self.data.get(byte + 1) == Some(&0x00)
            && self.data.get(byte + 2) == Some(&0x01)
    }
}

/// A `00 00 01 xx` start code located in the stream.
#[derive(Clone, Copy, Debug)]
pub struct StartCode {
    /// The `xx` byte following the `00 00 01` prefix.
    pub code: u8,
    /// Byte offset of the `00` that begins the prefix.
    pub offset: usize,
    /// Byte offset of the first payload byte (just past the code byte).
    pub payload_offset: usize,
}

/// Scan the whole buffer for start codes. MPEG-2 streams are small enough in
/// practice that one up-front pass is simpler than incremental scanning, and it
/// lets the header/slice parsers work on known-bounded ranges.
pub fn find_start_codes(data: &[u8]) -> Vec<StartCode> {
    let mut out = Vec::new();
    if data.len() < 4 {
        return out;
    }
    for i in 0..data.len() - 3 {
        if data[i] == 0x00 && data[i + 1] == 0x00 && data[i + 2] == 0x01 {
            out.push(StartCode {
                code: data[i + 3],
                offset: i,
                payload_offset: i + 4,
            });
        }
    }
    out
}
