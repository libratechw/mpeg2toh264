//! H.264 bitstream writing: RBSP construction, Exp-Golomb coding, and the
//! byte stream NAL unit wrapping from Annex B.

/// NAL unit types used by this encoder (Table 7-1).
pub mod nal_type {
    pub const SLICE_NON_IDR: u8 = 1;
    pub const SLICE_IDR: u8 = 5;
    pub const SEI: u8 = 6;
    pub const SPS: u8 = 7;
    pub const PPS: u8 = 8;
}

/// Writes an RBSP (raw byte sequence payload) bit by bit.
///
/// Bits land in an accumulator and leave it a whole byte at a time, so a
/// syntax element costs one shift rather than a trip around a loop per byte it
/// straddles. `buf` therefore holds only the bytes that are already full, and
/// the up-to-seven bits after them live in `acc`.
pub struct BitWriter {
    buf: Vec<u8>,
    /// The bits not yet in `buf`, in the low `bits` bits, most significant
    /// first. Never eight or more: every full byte is flushed as it forms.
    acc: u64,
    bits: u32,
}

impl BitWriter {
    pub fn new() -> Self {
        Self::with_capacity(1024)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            buf: Vec::with_capacity(capacity),
            acc: 0,
            bits: 0,
        }
    }

    /// Drop everything written, keeping the buffer for the next payload.
    pub fn clear(&mut self) {
        self.buf.clear();
        self.acc = 0;
        self.bits = 0;
    }

    /// Total bits written so far.
    pub fn bit_length(&self) -> usize {
        self.buf.len() * 8 + self.bits as usize
    }

    pub fn is_byte_aligned(&self) -> bool {
        self.bits == 0
    }

    /// Write the low `n` bits of `value`, most significant first.
    #[inline]
    pub fn u(&mut self, n: u32, value: u32) {
        debug_assert!(n <= 32, "u({n}) exceeds 32 bits");
        if n == 0 {
            return;
        }
        // Fewer than eight bits are held, so at most 39 end up in the
        // accumulator and nothing is shifted out of the top.
        let value = (value as u64) & (u64::MAX >> (64 - n));
        self.acc = (self.acc << n) | value;
        self.bits += n;
        while self.bits >= 8 {
            self.bits -= 8;
            self.buf.push((self.acc >> self.bits) as u8);
        }
        // Drop what was flushed, so the accumulator holds the tail and nothing
        // else. `bits` is below eight here, so the shift is always in range.
        self.acc &= (1u64 << self.bits) - 1;
    }

    #[inline]
    pub fn flag(&mut self, value: bool) {
        self.u(1, u32::from(value));
    }

    /// `ue(v)`: unsigned Exp-Golomb (clause 9.1).
    #[inline]
    pub fn ue(&mut self, value: u32) {
        // codeNum + 1 written as a 1 followed by (bits-1) zeros then the remainder.
        let v = value + 1;
        let bits = 32 - v.leading_zeros();
        if bits <= 16 {
            // The leading zeroes and v together are one 2*bits-1 bit codeword.
            self.u(bits * 2 - 1, v);
        } else {
            self.u(bits - 1, 0);
            self.u(bits, v);
        }
    }

    /// `se(v)`: signed Exp-Golomb (clause 9.1.1).
    #[inline]
    pub fn se(&mut self, value: i32) {
        self.ue(if value <= 0 {
            (-2 * value) as u32
        } else {
            (2 * value - 1) as u32
        });
    }

    /// `rbsp_trailing_bits()`: a stop bit then zeros to the byte boundary.
    pub fn rbsp_trailing_bits(&mut self) {
        self.u(1, 1);
        while !self.is_byte_aligned() {
            self.u(1, 0);
        }
    }

    /// The bytes written. Panics unless the payload is byte aligned, which is a
    /// defect in the caller's syntax rather than anything the stream can cause.
    pub fn bytes(&self) -> &[u8] {
        assert!(
            self.is_byte_aligned(),
            "RBSP is not byte aligned ({} bits)",
            self.bit_length()
        );
        &self.buf
    }
}

impl Default for BitWriter {
    fn default() -> Self {
        Self::new()
    }
}

/// Wrap an RBSP as a NAL unit with a 4-byte Annex B start code.
///
/// Emulation prevention: a third byte of 0x00..0x03 following two zero bytes
/// would otherwise let payload data imitate a start code, so a 0x03 is inserted
/// between them (clause 7.4.1.1).
pub fn to_nal_unit(rbsp: &[u8], nal_ref_idc: u8, nal_unit_type: u8) -> Vec<u8> {
    // A run of zeroes needs an emulation-prevention byte before every second
    // input byte after the first two, which is what the reserve accounts for.
    let mut out = Vec::with_capacity(5 + rbsp.len() + rbsp.len().div_ceil(2));
    out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
    out.push((nal_ref_idc << 5) | nal_unit_type);
    let mut zeros = 0;
    for &b in rbsp {
        if zeros >= 2 && b <= 0x03 {
            out.push(0x03);
            zeros = 0;
        }
        out.push(b);
        zeros = if b == 0x00 { zeros + 1 } else { 0 };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Everything written so far as a bit string, for comparing with the spec.
    /// The bits still in the accumulator have not reached `buf` yet.
    fn bits(w: &BitWriter) -> String {
        let mut s = String::new();
        for &b in &w.buf {
            s.push_str(&format!("{b:08b}"));
        }
        for i in (0..w.bits).rev() {
            s.push(if (w.acc >> i) & 1 == 1 { '1' } else { '0' });
        }
        s
    }

    #[test]
    fn ue_matches_the_canonical_codewords() {
        // Table from H.264 clause 9.1.
        for (value, code) in [
            (0, "1"),
            (1, "010"),
            (2, "011"),
            (3, "00100"),
            (4, "00101"),
            (5, "00110"),
            (6, "00111"),
            (7, "0001000"),
            (8, "0001001"),
        ] {
            let mut w = BitWriter::new();
            w.ue(value);
            assert_eq!(bits(&w), code, "ue({value})");
        }
    }

    #[test]
    fn se_alternates_positive_and_negative() {
        for (value, code_num) in [(0, 0), (1, 1), (-1, 2), (2, 3), (-2, 4), (3, 5)] {
            let mut w = BitWriter::new();
            w.se(value);
            let mut expected = BitWriter::new();
            expected.ue(code_num);
            assert_eq!(bits(&w), bits(&expected), "se({value})");
        }
    }

    #[test]
    fn ue_spans_the_wide_codeword_path() {
        // A codeword of more than 32 bits cannot go through one u(n) call, so
        // ue splits it. The boundary is codeNum 65534, whose codeNum + 1 is the
        // last value that still fits in 16 bits.
        let mut w = BitWriter::new();
        w.ue(65_534);
        assert_eq!(w.bit_length(), 31, "15 leading zeros, then 16 value bits");
        let mut w = BitWriter::new();
        w.ue(65_535);
        assert_eq!(w.bit_length(), 33, "16 leading zeros, then 17 value bits");
        assert_eq!(
            bits(&w),
            format!("{}{:017b}", "0".repeat(16), 65_536u32),
            "the split path still produces one continuous codeword"
        );
    }

    #[test]
    fn rbsp_trailing_bits_stops_then_pads() {
        let mut w = BitWriter::new();
        w.u(3, 0b101);
        w.rbsp_trailing_bits();
        assert_eq!(w.bytes(), &[0b1011_0000]);
        assert!(w.is_byte_aligned());
    }

    #[test]
    fn nal_wrapping_prevents_start_code_emulation() {
        // Two zeros followed by 0x00..0x03 would imitate a start code prefix.
        let nal = to_nal_unit(&[0x00, 0x00, 0x01, 0x00, 0x00, 0x03], 3, nal_type::SPS);
        assert_eq!(
            nal,
            vec![0x00, 0x00, 0x00, 0x01, 0x67, 0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x03]
        );
    }

    #[test]
    fn nal_wrapping_leaves_innocent_bytes_alone() {
        let nal = to_nal_unit(&[0x00, 0x00, 0x04, 0xff], 0, nal_type::SLICE_NON_IDR);
        assert_eq!(
            nal,
            vec![0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x04, 0xff]
        );
    }

    #[test]
    fn nal_wrapping_survives_a_long_run_of_zeros() {
        // One escape per two payload bytes is the worst case; anything less
        // silently truncates a large I_PCM macroblock.
        let rbsp = vec![0u8; 1024];
        let nal = to_nal_unit(&rbsp, 3, nal_type::SLICE_IDR);
        assert_eq!(nal.len(), 5 + 1024 + 511);
    }
}
