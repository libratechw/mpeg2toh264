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
    /// Upcoming bits, most significant first. Sequential syntax reads consume
    /// this reservoir and touch the input only when fewer than 32 bits remain.
    reservoir: u64,
    reservoir_bits: u32,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            reservoir: 0,
            reservoir_bits: 0,
        }
    }

    pub fn at_bit(data: &'a [u8], start_bit: usize) -> Self {
        Self {
            data,
            pos: start_bit,
            reservoir: 0,
            reservoir_bits: 0,
        }
    }

    pub fn bit_pos(&self) -> usize {
        self.pos
    }

    pub fn set_bit_pos(&mut self, pos: usize) {
        self.pos = pos;
        self.reservoir = 0;
        self.reservoir_bits = 0;
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

    /// Refill from the current absolute position. MPEG-2 fields are at most 32
    /// bits, while an eight-byte window leaves at least 57 usable bits after
    /// alignment, so one refill always satisfies the next read.
    #[inline]
    fn refill(&mut self) {
        let byte = self.pos >> 3;
        let bit_offset = (self.pos & 7) as u32;
        let word = if byte.saturating_add(8) <= self.data.len() {
            u64::from_be_bytes([
                self.data[byte],
                self.data[byte + 1],
                self.data[byte + 2],
                self.data[byte + 3],
                self.data[byte + 4],
                self.data[byte + 5],
                self.data[byte + 6],
                self.data[byte + 7],
            ])
        } else {
            let mut word = 0u64;
            for i in 0..8 {
                word = (word << 8) | self.byte_at(byte + i) as u64;
            }
            word
        };
        self.reservoir = word << bit_offset;
        self.reservoir_bits = 64 - bit_offset;
    }

    /// Read `n` bits (n <= 32) MSB-first as an unsigned integer.
    #[inline]
    pub fn u(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        debug_assert!(n <= 32);
        if self.reservoir_bits < n {
            self.refill();
        }
        let value = (self.reservoir >> (64 - n)) as u32;
        self.skip(n);
        value
    }

    /// Peek `n` bits without consuming them.
    #[inline]
    pub fn peek(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        debug_assert!(n <= 32);
        if self.reservoir_bits < n {
            self.refill();
        }
        (self.reservoir >> (64 - n)) as u32
    }

    /// Read a single bit as a boolean.
    #[inline]
    pub fn flag(&mut self) -> bool {
        self.u(1) == 1
    }

    #[inline]
    pub fn skip(&mut self, n: u32) {
        self.pos += n as usize;
        if n < self.reservoir_bits {
            self.reservoir <<= n;
            self.reservoir_bits -= n;
        } else {
            self.reservoir = 0;
            self.reservoir_bits = 0;
        }
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
        self.reservoir = 0;
        self.reservoir_bits = 0;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(data: &[u8], pos: usize, width: u32) -> u32 {
        let mut value = 0;
        for bit in pos..pos + width as usize {
            let byte = data.get(bit >> 3).copied().unwrap_or(0);
            value = (value << 1) | u32::from((byte >> (7 - (bit & 7))) & 1);
        }
        value
    }

    #[test]
    fn reservoir_matches_individual_bits_across_refills_and_seeks() {
        let data: Vec<u8> = (0..20).map(|i| (i * 37 + 11) as u8).collect();
        let mut reader = BitReader::at_bit(&data, 3);
        let mut pos = 3;
        for width in [3, 17, 5, 32, 7, 21, 1, 28] {
            assert_eq!(reader.peek(width), reference(&data, pos, width));
            assert_eq!(reader.bit_pos(), pos, "peek does not consume bits");
            assert_eq!(reader.u(width), reference(&data, pos, width));
            pos += width as usize;
        }

        reader.set_bit_pos(9);
        assert_eq!(reader.u(32), reference(&data, 9, 32));
        reader.skip(70);
        assert_eq!(reader.u(13), reference(&data, 111, 13));
    }

    #[test]
    fn reading_past_the_input_still_supplies_zero_bits() {
        let mut reader = BitReader::at_bit(&[0b1010_0000], 4);
        assert_eq!(reader.u(12), 0);
        assert_eq!(reader.u(32), 0);
    }
}
