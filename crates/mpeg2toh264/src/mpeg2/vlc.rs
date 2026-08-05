//! Flat lookup decoding for the Annex B variable length codes.
//!
//! Each table is expanded into a direct-indexed array covering the longest code
//! in it: peek `max_len` bits, read the value and the true code length out of
//! the table, then consume that many bits. Costs one memory read per symbol.

use crate::bitreader::BitReader;
use crate::error::{bail, Result};

pub struct VlcTable {
    name: &'static str,
    max_len: u32,
    /// Value in the high 27 bits and code length in the low five. A zero
    /// length means "no code here". Packing both fields makes decoding one
    /// table lookup rather than two parallel vector lookups.
    entries: Vec<u32>,
}

impl VlcTable {
    /// Expand a bit-string table into the lookup. Collisions and malformed
    /// codes are a defect in the generated tables, not in any input, so they
    /// panic rather than surfacing as a stream error.
    pub fn new(name: &'static str, entries: &[(&str, i32)]) -> Self {
        let max_len = entries
            .iter()
            .map(|(code, _)| code.len() as u32)
            .max()
            .unwrap_or(0);
        let size = 1usize << max_len;
        let mut expanded = vec![0u32; size];

        for (code, value) in entries {
            let len = code.len() as u32;
            assert!(
                (-1 << 26..1 << 26).contains(value),
                "{name}: value {value} does not fit the packed VLC entry"
            );
            let entry = ((*value as u32) << 5) | len;
            let prefix = (u32::from_str_radix(code, 2)
                .unwrap_or_else(|_| panic!("{name}: code '{code}' is not binary"))
                << (max_len - len)) as usize;
            let fill = 1usize << (max_len - len);
            for i in 0..fill {
                let index = prefix | i;
                assert_eq!(
                    expanded[index], 0,
                    "{name}: code '{code}' collides at index {index}"
                );
                expanded[index] = entry;
            }
        }

        Self {
            name,
            max_len,
            entries: expanded,
        }
    }

    /// Decode one symbol, advancing the reader.
    #[inline]
    pub fn decode(&self, r: &mut BitReader<'_>) -> Result<i32> {
        let index = r.peek(self.max_len) as usize;
        let entry = self.entries[index];
        let len = entry & 31;
        if len == 0 {
            bail!(
                "{}: invalid code 0b{:0width$b} at bit {}",
                self.name,
                index,
                r.bit_pos(),
                width = self.max_len as usize
            );
        }
        r.skip(len);
        Ok((entry as i32) >> 5)
    }

    /// Decode a symbol, treating MPEG-2 slice-ending zero stuffing as `None`.
    ///
    /// A slice checks for 23 zero bits at every macroblock boundary. Valid VLC
    /// codes never begin with `max_len` zeroes, so normal symbols need only the
    /// table lookup; the wider end check is deferred to that invalid prefix.
    #[inline]
    pub fn decode_or_zero_stuffing(&self, r: &mut BitReader<'_>) -> Result<Option<i32>> {
        let index = r.peek(self.max_len) as usize;
        let entry = self.entries[index];
        let len = entry & 31;
        if len == 0 {
            if index == 0 && r.peek(23) == 0 {
                return Ok(None);
            }
            bail!(
                "{}: invalid code 0b{:0width$b} at bit {}",
                self.name,
                index,
                r.bit_pos(),
                width = self.max_len as usize
            );
        }
        r.skip(len);
        Ok(Some((entry as i32) >> 5))
    }

    /// Peek at the symbol without consuming it; `None` if the code is invalid.
    pub fn peek_symbol(&self, r: &mut BitReader<'_>) -> Option<i32> {
        let index = r.peek(self.max_len) as usize;
        let entry = self.entries[index];
        if entry & 31 == 0 {
            None
        } else {
            Some((entry as i32) >> 5)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_end_decode_distinguishes_symbols_stuffing_and_invalid_codes() {
        let table = VlcTable::new("test", &[("1", 7), ("01", 8)]);

        let mut symbol = BitReader::new(&[0x80, 0, 0, 0]);
        assert_eq!(table.decode_or_zero_stuffing(&mut symbol).unwrap(), Some(7));
        assert_eq!(symbol.bit_pos(), 1);

        let mut stuffing = BitReader::new(&[0; 4]);
        assert_eq!(table.decode_or_zero_stuffing(&mut stuffing).unwrap(), None);
        assert_eq!(stuffing.bit_pos(), 0, "the end marker is only observed");

        let mut invalid = BitReader::new(&[0x20, 0, 0, 0]);
        assert!(table.decode_or_zero_stuffing(&mut invalid).is_err());
    }
}
