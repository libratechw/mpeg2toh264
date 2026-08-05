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
    /// Code length at each index; 0 means "no code here".
    lengths: Vec<u8>,
    values: Vec<i32>,
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
        let mut lengths = vec![0u8; size];
        let mut values = vec![0i32; size];

        for (code, value) in entries {
            let len = code.len() as u32;
            let prefix = (u32::from_str_radix(code, 2)
                .unwrap_or_else(|_| panic!("{name}: code '{code}' is not binary"))
                << (max_len - len)) as usize;
            let fill = 1usize << (max_len - len);
            for i in 0..fill {
                let index = prefix | i;
                assert_eq!(
                    lengths[index], 0,
                    "{name}: code '{code}' collides at index {index}"
                );
                lengths[index] = len as u8;
                values[index] = *value;
            }
        }

        Self {
            name,
            max_len,
            lengths,
            values,
        }
    }

    /// Decode one symbol, advancing the reader.
    #[inline]
    pub fn decode(&self, r: &mut BitReader<'_>) -> Result<i32> {
        let index = r.peek(self.max_len) as usize;
        let len = self.lengths[index];
        if len == 0 {
            bail!(
                "{}: invalid code 0b{:0width$b} at bit {}",
                self.name,
                index,
                r.bit_pos(),
                width = self.max_len as usize
            );
        }
        r.skip(len as u32);
        Ok(self.values[index])
    }

    /// Peek at the symbol without consuming it; `None` if the code is invalid.
    pub fn peek_symbol(&self, r: &BitReader<'_>) -> Option<i32> {
        let index = r.peek(self.max_len) as usize;
        if self.lengths[index] == 0 {
            None
        } else {
            Some(self.values[index])
        }
    }
}
