//! Flat lookup decoding for the Annex B variable length codes.
//!
//! Each table is expanded into a direct-indexed array covering the longest code
//! in it: peek `max_len` bits, read the value and the true code length out of
//! the table, then consume that many bits. Costs one memory read per symbol.

use crate::bitreader::BitReader;
use crate::error::{bail, Error, Result};

pub struct VlcTable {
    name: &'static str,
    max_len: u32,
    primary_bits: u32,
    secondary_bits: u32,
    /// Value in the high 27 bits and code length in the low five. A zero
    /// length with a non-zero value points into `secondary`; an all-zero entry
    /// is invalid. Packing both fields keeps the common short-code path to one
    /// lookup.
    entries: Vec<u32>,
    secondary: Vec<u32>,
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
        let primary_bits = max_len.min(8);
        let secondary_bits = max_len - primary_bits;
        let mut expanded = vec![0u32; 1usize << primary_bits];
        let mut secondary = Vec::new();

        for (code, value) in entries {
            let len = code.len() as u32;
            assert!(
                (-1 << 26..1 << 26).contains(value),
                "{name}: value {value} does not fit the packed VLC entry"
            );
            let entry = ((*value as u32) << 5) | len;
            let bits = u32::from_str_radix(code, 2)
                .unwrap_or_else(|_| panic!("{name}: code '{code}' is not binary"));
            if len <= primary_bits {
                let prefix = (bits << (primary_bits - len)) as usize;
                let fill = 1usize << (primary_bits - len);
                for i in 0..fill {
                    let index = prefix | i;
                    assert_eq!(expanded[index], 0, "{name}: code '{code}' collides");
                    expanded[index] = entry;
                }
                continue;
            }

            let primary = (bits >> (len - primary_bits)) as usize;
            let offset = if expanded[primary] == 0 {
                let offset = secondary.len();
                secondary.resize(offset + (1usize << secondary_bits), 0);
                expanded[primary] = (offset as u32 + 1) << 5;
                offset
            } else {
                assert_eq!(expanded[primary] & 31, 0, "{name}: code '{code}' collides");
                ((expanded[primary] >> 5) - 1) as usize
            };
            let suffix_mask = (1u32 << secondary_bits) - 1;
            let prefix = ((bits << (max_len - len)) & suffix_mask) as usize;
            let fill = 1usize << (max_len - len);
            for i in 0..fill {
                let index = offset + (prefix | i);
                assert_eq!(
                    secondary[index], 0,
                    "{name}: code '{code}' collides at index {index}"
                );
                secondary[index] = entry;
            }
        }

        Self {
            name,
            max_len,
            primary_bits,
            secondary_bits,
            entries: expanded,
            secondary,
        }
    }

    /// Always-inlined because `decode_coefficient_run` is too
    /// large for the regular inliner to expand this into, and a call per symbol
    /// is most of what this experiment removes.
    #[inline(always)]
    fn lookup(&self, r: &mut BitReader<'_>) -> u32 {
        let primary = r.peek(self.primary_bits) as usize;
        let mut entry = self.entries[primary];
        if entry != 0 && entry & 31 == 0 {
            let offset = ((entry >> 5) - 1) as usize;
            let suffix = r.peek(self.max_len) as usize & ((1usize << self.secondary_bits) - 1);
            entry = self.secondary[offset + suffix];
        }
        entry
    }

    /// Decode one symbol, advancing the reader.
    #[inline]
    pub fn decode(&self, r: &mut BitReader<'_>) -> Result<i32> {
        let entry = self.lookup(r);
        let len = entry & 31;
        if len == 0 {
            let index = r.peek(self.max_len) as usize;
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
        let entry = self.lookup(r);
        let len = entry & 31;
        if len == 0 {
            let index = r.peek(self.max_len) as usize;
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

    /// Peek at the block-layer coefficient symbol and its code length without
    /// consuming any bits; `None` marks an invalid code, which the caller
    /// reports through [`Self::invalid_code`].
    ///
    /// Keeping the error machinery out of this method is what lets the
    /// coefficient loop inline the whole table read and consume a run/level
    /// code together with its sign bit in a single reservoir operation.
    #[inline]
    pub fn peek_symbol_and_len(&self, r: &mut BitReader<'_>) -> Option<(i32, u32)> {
        let entry = self.lookup(r);
        let len = entry & 31;
        if len == 0 {
            None
        } else {
            Some(((entry as i32) >> 5, len))
        }
    }

    /// The error [`Self::peek_symbol_and_len`]'s `None` stands for. Cold path:
    /// marked never-inline so the coefficient loop's inlined fast path does not
    /// drag the formatting machinery in with it. The message and the bit
    /// position are exactly what [`Self::decode`] reports for the same stream.
    #[inline(never)]
    pub fn invalid_code(&self, r: &mut BitReader<'_>) -> Error {
        let index = r.peek(self.max_len) as usize;
        Error::new(format!(
            "{}: invalid code 0b{:0width$b} at bit {}",
            self.name,
            index,
            r.bit_pos(),
            width = self.max_len as usize
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mpeg2::vlc_tables::{DCT_COEFF_TABLE0, DCT_COEFF_TABLE1};

    #[test]
    fn long_codes_share_a_compact_secondary_table() {
        let table = VlcTable::new("test", &[("1", 7), ("000000001", 8), ("000000000", 9)]);
        assert_eq!(table.entries.len(), 256);
        assert_eq!(table.secondary.len(), 2);

        let mut one = BitReader::new(&[0x00, 0x80]);
        assert_eq!(table.decode(&mut one).unwrap(), 8);
        assert_eq!(one.bit_pos(), 9);

        let mut zero = BitReader::new(&[0x00, 0x00]);
        assert_eq!(table.decode(&mut zero).unwrap(), 9);
        assert_eq!(zero.bit_pos(), 9);
    }

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

    #[test]
    fn peek_symbol_and_len_consumes_identically_to_decode() {
        // Every code of both real coefficient tables in a row, each followed by
        // the sign bit that a run/level code carries: the fast path must name
        // the same symbol, the same code length, and leave the reader at the
        // same bit position as the reference decode.
        for (name, entries) in [("B.14", DCT_COEFF_TABLE0), ("B.15", DCT_COEFF_TABLE1)] {
            let table = VlcTable::new(name, entries);
            let mut bits: Vec<u32> = Vec::new();
            for (code, _) in entries {
                for ch in code.chars() {
                    bits.push(ch.to_digit(2).unwrap());
                }
                bits.push(0); // sign bit
            }
            while bits.len() % 8 != 0 {
                bits.push(0);
            }
            let data: Vec<u8> = bits
                .chunks(8)
                .map(|c| c.iter().fold(0u8, |b, bit| (b << 1) | *bit as u8))
                .collect();

            let mut via_decode = BitReader::new(&data);
            let mut via_fast = BitReader::new(&data);
            for (code, value) in entries {
                assert_eq!(
                    table.decode(&mut via_decode).unwrap(),
                    *value,
                    "{name}: decode of {code}"
                );
                via_decode.skip(1); // the sign bit that follows a run/level code
                let (sym, len) = table
                    .peek_symbol_and_len(&mut via_fast)
                    .expect("fast path decodes");
                assert_eq!(sym, *value, "{name}: peek of {code}");
                via_fast.skip(len);
                via_fast.skip(1); // the sign bit the coefficient caller takes with u(len+1)
                assert_eq!(
                    via_fast.bit_pos(),
                    via_decode.bit_pos(),
                    "{name}: bit position after {code}"
                );
            }
            assert_eq!(via_fast.bit_pos(), via_decode.bit_pos());
        }
    }

    #[test]
    fn invalid_code_reports_the_decode_error_verbatim() {
        // Sixteen zero bits are not a code in either coefficient table, so the
        // fast path's cold helper must reproduce exactly what decode reports.
        for (name, entries) in [("B.14", DCT_COEFF_TABLE0), ("B.15", DCT_COEFF_TABLE1)] {
            let table = VlcTable::new(name, entries);
            let mut via_decode = BitReader::new(&[0, 0, 0, 0]);
            let mut via_fast = BitReader::new(&[0, 0, 0, 0]);
            let decode_error = table.decode(&mut via_decode).unwrap_err();
            let fast_symbol = table.peek_symbol_and_len(&mut via_fast).map(|(s, _)| s);
            assert_eq!(fast_symbol, None, "{name}: sixteen zeroes must be invalid");
            let fast_error = table.invalid_code(&mut via_fast);
            assert_eq!(
                fast_error.message(),
                decode_error.message(),
                "{name}: the fast path's error differs from decode's"
            );
            assert_eq!(via_fast.bit_pos(), via_decode.bit_pos());
        }
    }
}
