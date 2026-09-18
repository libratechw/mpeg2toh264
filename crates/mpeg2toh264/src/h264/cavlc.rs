//! CAVLC residual block encoding (clause 9.2, run in reverse).
//!
//! A block is coded from the highest frequency coefficient downwards: first how
//! many non-zero levels there are and how many of them are trailing +/-1s, then
//! the signs of those ones, then the remaining levels, then how the zeros are
//! distributed between them.

use std::sync::LazyLock;

use crate::error::{bail, Result};
use crate::h264::bitwriter::BitWriter;
use crate::h264::cavlc_tables::{
    coeff_token_table_index, Vlc, COEFF_TOKEN, RUN_BEFORE, TOTAL_ZEROS_4X4, TOTAL_ZEROS_CHROMA_DC,
};

/// A codeword as one word: its length in the high half and its bits in the
/// low half, so that a table entry is one load and one write. Zero is no
/// codeword, which the tables use where the standard has none.
type Packed = u32;

const fn pack(len: u32, bits: u32) -> Packed {
    (len << 16) | bits
}

fn pack_vlc(code: Option<Vlc>) -> Packed {
    match code {
        Some(code) => pack(code.len, code.bits),
        None => 0,
    }
}

#[inline]
fn write_packed(w: &mut BitWriter, code: Packed) {
    w.u(code >> 16, code & 0xffff);
}

/// The generated tables laid out for the writer: dense, sized so that an
/// index needs no bounds check, and packed. The generated form nests slices
/// of `Option`s, and every one of those is a branch on the hottest path in
/// the encoder.
struct Tables {
    /// `[nC range][trailing_ones * 17 + total_coeff]`.
    coeff_token: [[Packed; 128]; 6],
    /// `[total_coeff - 1][total_zeros]` for blocks of fifteen or sixteen.
    total_zeros: [[Packed; 16]; 16],
    /// The same for the four-coefficient chroma DC block.
    total_zeros_dc: [[Packed; 4]; 4],
    /// `[min(zeros_left, 7) - 1][run_before]`.
    run_before: [[Packed; 16]; 8],
}

static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let mut tables = Tables {
        coeff_token: [[0; 128]; 6],
        total_zeros: [[0; 16]; 16],
        total_zeros_dc: [[0; 4]; 4],
        run_before: [[0; 16]; 8],
    };
    for (packed, codes) in tables.coeff_token.iter_mut().zip(COEFF_TOKEN.iter()) {
        for (slot, &code) in packed.iter_mut().zip(codes.iter()) {
            *slot = pack_vlc(code);
        }
    }
    for (packed, codes) in tables.total_zeros.iter_mut().zip(TOTAL_ZEROS_4X4.iter()) {
        for (slot, &code) in packed.iter_mut().zip(codes.iter()) {
            *slot = pack_vlc(code);
        }
    }
    for (packed, codes) in tables
        .total_zeros_dc
        .iter_mut()
        .zip(TOTAL_ZEROS_CHROMA_DC.iter())
    {
        for (slot, &code) in packed.iter_mut().zip(codes.iter()) {
            *slot = pack_vlc(code);
        }
    }
    for (packed, codes) in tables.run_before.iter_mut().zip(RUN_BEFORE.iter()) {
        for (slot, &code) in packed.iter_mut().zip(codes.iter()) {
            *slot = pack_vlc(code);
        }
    }
    tables
});

/// `level_prefix` and `level_suffix` of one level, as clause 9.2.2 inverted.
///
/// The prefix/suffix split depends on `suffix_length`, which adapts as levels
/// are written so that blocks with large coefficients spend fewer bits on them.
/// Returns the codeword's length and bits, with the suffix separately for the
/// few escape codes wider than the writer takes at once, or nothing for a
/// level beyond what level_prefix 24 can reach.
const fn level_codeword(level_code: u32, suffix_length: u32) -> Option<LevelCodeword> {
    let prefix;
    let mut suffix = 0u32;
    let mut suffix_bits = 0u32;

    // Below the escape, level_prefix carries the high part of the value directly.
    if suffix_length == 0 && level_code <= 13 {
        prefix = level_code;
    } else if suffix_length == 0 && level_code <= 29 {
        prefix = 14;
        suffix = level_code - 14;
        suffix_bits = 4;
    } else if suffix_length > 0 && level_code < (15 << suffix_length) {
        prefix = level_code >> suffix_length;
        suffix = level_code & ((1 << suffix_length) - 1);
        suffix_bits = suffix_length;
    } else {
        // Escape range. level_prefix 15 carries a 12-bit suffix; each prefix
        // above that widens the suffix by a bit and continues where the last
        // left off, so the ranges tile without gaps.
        let mut p = 15u32;
        let mut base = if suffix_length == 0 {
            30
        } else {
            15 << suffix_length
        };
        loop {
            let size = 1u32 << (p - 3);
            if level_code < base + size {
                break;
            }
            base += size;
            p += 1;
            if p > 24 {
                return None;
            }
        }
        prefix = p;
        suffix_bits = p - 3;
        suffix = level_code - base;
    }

    // The overwhelmingly common codewords fit in one write. Keeping prefix
    // and suffix together avoids updating and testing BitWriter's accumulator
    // twice for every non-zero coefficient. Only the largest escape codes can
    // exceed its 32-bit input and need the split form.
    let codeword_bits = prefix + 1 + suffix_bits;
    if codeword_bits <= 32 {
        Some((codeword_bits, (1 << suffix_bits) | suffix, None))
    } else {
        Some((prefix + 1, 1, Some((suffix_bits, suffix))))
    }
}

/// A level's codeword: its length and bits, and for the widest escapes the
/// suffix's own length and bits, which go out as a second write.
type LevelCodeword = (u32, u32, Option<(u32, u32)>);

/// Every level below this is written from [`LEVEL_CODES`]; a level that large
/// is rare enough to work out on the spot.
const TABLED_LEVELS: usize = 256;

/// [`level_codeword`] for each `suffix_length` and every level code below
/// [`TABLED_LEVELS`], where the codeword is at most 28 bits and its bits fit
/// the packed form. Built at compile time.
static LEVEL_CODES: [[Packed; TABLED_LEVELS]; 7] = {
    let mut codes = [[0; TABLED_LEVELS]; 7];
    let mut suffix_length = 0;
    while suffix_length < 7 {
        let mut level_code = 0;
        while level_code < TABLED_LEVELS {
            let Some((len, bits, None)) = level_codeword(level_code as u32, suffix_length) else {
                panic!("a tabled level needs more than one write");
            };
            assert!(bits < 1 << 16);
            codes[suffix_length as usize][level_code] = pack(len, bits);
            level_code += 1;
        }
        suffix_length += 1;
    }
    codes
};

/// Write one level. Everything a table can hold is one load; the rest, which
/// is a level in the thousands, is worked out. Always inlined: this runs once
/// per non-zero coefficient, and as a call it cost more than the table saved.
#[inline(always)]
fn write_level(w: &mut BitWriter, level_code: u32, suffix_length: u32) -> Result<()> {
    if let Some(&code) = LEVEL_CODES[(suffix_length & 7) as usize].get(level_code as usize) {
        write_packed(w, code);
        return Ok(());
    }
    write_large_level(w, level_code, suffix_length)
}

#[cold]
#[inline(never)]
fn write_large_level(w: &mut BitWriter, level_code: u32, suffix_length: u32) -> Result<()> {
    let Some((len, bits, rest)) = level_codeword(level_code, suffix_length) else {
        bail!("level code {level_code} is beyond level_prefix range");
    };
    w.u(len, bits);
    if let Some((suffix_bits, suffix)) = rest {
        w.u(suffix_bits, suffix);
    }
    Ok(())
}

/// A level from a block of `N`, without a bounds check where `N` is a power
/// of two: the position comes off a mask no wider than the block.
#[inline]
fn level_at<const N: usize>(levels: &[i32; N], position: usize) -> i32 {
    if N.is_power_of_two() {
        levels[position & (N - 1)]
    } else {
        levels[position]
    }
}

/// Write one residual block. Returns TotalCoeff, which neighbouring blocks need
/// in order to derive their own nC.
///
/// `levels` holds the coefficient levels in coding scan order, lowest frequency
/// first, and its length `N` is how many positions the block has (16, 15 or
/// 4); `n_c` is the count predicted from the neighbouring blocks, or -1 for a
/// 4:2:0 chroma DC block (clause 9.2.1).
pub fn write_residual_levels<const N: usize>(
    w: &mut BitWriter,
    levels: &[i32; N],
    n_c: i32,
) -> Result<usize> {
    // Which levels are non-zero, one bit each, lowest frequency in bit 0.
    let mut mask = 0u32;
    for (i, &level) in levels.iter().enumerate() {
        mask |= u32::from(level != 0) << i;
    }
    write_masked_levels(w, levels, mask, n_c)
}

/// [`write_residual_levels`] for a caller that already knows which levels are
/// non-zero. The luma path gathers its 4x4 sub-block out of the 8x8 scan and can
/// note that while it copies, rather than walking the sixteen values again.
///
/// Bit `i` of `mask` is set when `levels[i]` is non-zero; the positions are read
/// off it below rather than built by a branch per coefficient, since this runs
/// for every block of every macroblock.
pub fn write_masked_levels<const N: usize>(
    w: &mut BitWriter,
    levels: &[i32; N],
    mask: u32,
    n_c: i32,
) -> Result<usize> {
    let tables = &*TABLES;
    let total_coeff = mask.count_ones() as usize;
    let coeff_token = &tables.coeff_token[coeff_token_table_index(n_c)];

    if total_coeff == 0 {
        if coeff_token[0] == 0 {
            bail!("no coeff_token for an empty block at nC={n_c}");
        }
        write_packed(w, coeff_token[0]);
        return Ok(0);
    }

    // Trailing ones are the run of +/-1 at the high frequency end, at most three.
    let mut trailing_ones = 0usize;
    let mut trailing_signs = 0u32;
    let mut rest = mask;
    while trailing_ones < 3 {
        let position = 31 - rest.leading_zeros() as usize;
        let level = level_at(levels, position);
        if level != 1 && level != -1 {
            break;
        }
        trailing_signs = (trailing_signs << 1) | u32::from(level < 0);
        trailing_ones += 1;
        rest ^= 1 << position;
        if rest == 0 {
            break;
        }
    }

    let token = coeff_token[(trailing_ones * 17 + total_coeff) & 127];
    if token == 0 {
        bail!("no coeff_token for trailingOnes={trailing_ones} totalCoeff={total_coeff} nC={n_c}");
    }
    // The signs of the trailing ones follow the token directly, highest
    // frequency first, and were gathered while identifying the run: the two
    // go out as one codeword.
    let trailing_ones_bits = trailing_ones as u32;
    w.u(
        (token >> 16) + trailing_ones_bits,
        ((token & 0xffff) << trailing_ones_bits) | trailing_signs,
    );

    // Remaining levels, still highest frequency first.
    let mut suffix_length = u32::from(total_coeff > 10 && trailing_ones < 3);
    for i in trailing_ones..total_coeff {
        let position = 31 - rest.leading_zeros() as usize;
        let level = level_at(levels, position);
        rest ^= 1 << position;
        let mut level_code = if level > 0 {
            2 * level - 2
        } else {
            -2 * level - 1
        };
        // The first level after fewer than three trailing ones cannot be +/-1,
        // since it would have been a trailing one, so the range is shifted down.
        if i == trailing_ones && trailing_ones < 3 {
            level_code -= 2;
        }
        debug_assert!(
            level_code >= 0,
            "a level of magnitude one was not a trailing one"
        );

        write_level(w, level_code as u32, suffix_length)?;

        if suffix_length == 0 {
            suffix_length = 1;
        }
        if level.abs() > (3 << (suffix_length - 1)) && suffix_length < 6 {
            suffix_length += 1;
        }
    }

    // How the zeros are distributed. The count before the lowest frequency
    // non-zero coefficient is implied by what is left over.
    if total_coeff < N {
        let highest = 31 - mask.leading_zeros() as usize;
        let total_zeros = highest - (total_coeff - 1);
        let code = if N == 4 {
            tables.total_zeros_dc[(total_coeff - 1) & 3][total_zeros & 3]
        } else {
            tables.total_zeros[(total_coeff - 1) & 15][total_zeros & 15]
        };
        if code == 0 {
            bail!(
                "no total_zeros code for totalCoeff={total_coeff} totalZeros={total_zeros} maxNumCoeff={N}"
            );
        }
        write_packed(w, code);

        let mut zeros_left = total_zeros;
        let mut rest = mask ^ (1 << highest);
        let mut hi = highest;
        let mut remaining = total_coeff - 1;
        while remaining > 0 && zeros_left > 0 {
            let lo = 31 - rest.leading_zeros() as usize;
            let run_before = hi - lo - 1;
            let code = tables.run_before[(zeros_left.min(7) - 1) & 7][run_before & 15];
            if code == 0 {
                bail!("no run_before code for run={run_before} zerosLeft={zeros_left}");
            }
            write_packed(w, code);
            zeros_left -= run_before;
            hi = lo;
            rest ^= 1 << lo;
            remaining -= 1;
        }
    }

    Ok(total_coeff)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The written bits as a string. `bytes()` insists on alignment, so pad
    /// first and trim back to the true length.
    fn bits(w: &mut BitWriter) -> String {
        let n = w.bit_length();
        while !w.is_byte_aligned() {
            w.u(1, 0);
        }
        let mut s = String::new();
        for &b in w.bytes() {
            s.push_str(&format!("{b:08b}"));
        }
        s.truncate(n);
        s
    }

    #[test]
    fn encodes_the_worked_example_from_the_standard() {
        // Clause 9.2's example block, in scan order: TotalCoeff 5, three
        // trailing ones, three zeros scattered between the levels.
        let mut levels = [0i32; 16];
        levels[1] = 3;
        levels[3] = 1;
        levels[4] = -1;
        levels[5] = -1;
        levels[7] = 1;

        let mut w = BitWriter::new();
        let total = write_residual_levels(&mut w, &levels, 0).expect("encodes");
        assert_eq!(total, 5, "TotalCoeff is what neighbours read back");
        assert_eq!(bits(&mut w), "000010001110010111101101");
    }

    #[test]
    fn an_empty_block_is_one_coeff_token_and_nothing_else() {
        let mut w = BitWriter::new();
        let total = write_residual_levels(&mut w, &[0; 16], 0).expect("encodes");
        assert_eq!(total, 0);
        assert_eq!(
            bits(&mut w),
            "1",
            "coeff_token for (0 ones, 0 coefficients)"
        );
    }

    #[test]
    fn a_chroma_dc_block_uses_its_own_table() {
        // nC of -1 selects the 2x2 chroma DC tables, which are much shorter.
        let mut w = BitWriter::new();
        let total = write_residual_levels(&mut w, &[1, 0, 0, 0], -1).expect("encodes");
        assert_eq!(total, 1);
        // coeff_token (1 trailing one, 1 coefficient) = '1', sign '0' for
        // positive, then total_zeros of 0 for tzVlcIndex 1 = '1'.
        assert_eq!(bits(&mut w), "101");
    }

    #[test]
    fn more_than_three_ones_leaves_the_rest_as_ordinary_levels() {
        // Only the last three +/-1s are trailing ones; the fourth is coded as a
        // level, with its range shifted down because it cannot itself be one.
        let levels = [1i32, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let mut w = BitWriter::new();
        assert_eq!(
            write_residual_levels(&mut w, &levels, 0).expect("encodes"),
            4
        );
    }

    #[test]
    fn a_large_level_reaches_the_escape_range() {
        let mut levels = [0i32; 16];
        levels[0] = 4000;
        let mut w = BitWriter::new();
        write_residual_levels(&mut w, &levels, 0).expect("encodes a large level");
        assert!(w.bit_length() > 20, "the escape suffix is wide");
    }

    /// Clause 9.2.2.1 read forwards: what a decoder makes of `level_prefix`,
    /// `level_suffix` and `suffixLength`, which the writer's split has to
    /// invert exactly.
    fn decode_level_code(bits: &str, suffix_length: u32) -> (u32, usize) {
        let prefix = bits.find('1').expect("a stop bit") as u32;
        let mut consumed = prefix as usize + 1;
        let suffix_size = if prefix == 14 && suffix_length == 0 {
            4
        } else if prefix >= 15 {
            prefix - 3
        } else {
            suffix_length
        };
        let suffix = if suffix_size > 0 {
            let field = &bits[consumed..consumed + suffix_size as usize];
            consumed += suffix_size as usize;
            u32::from_str_radix(field, 2).expect("binary")
        } else {
            0
        };
        let mut level_code = (prefix.min(15) << suffix_length) + suffix;
        if prefix >= 15 && suffix_length == 0 {
            level_code += 15;
        }
        if prefix >= 16 {
            level_code += (1 << (prefix - 3)) - 4096;
        }
        (level_code, consumed)
    }

    #[test]
    fn every_level_codeword_decodes_back_to_its_level_code() {
        // The tabled range and a stretch beyond it, at every suffixLength,
        // including the widest escapes and the boundary where two writes are
        // needed.
        let codes = (0..600u32).chain([4095, 4096, 8191, 8192, 100_000, 1_000_000, 2_000_000]);
        for suffix_length in 0..7 {
            for level_code in codes.clone() {
                let mut w = BitWriter::new();
                write_level(&mut w, level_code, suffix_length).expect("in range");
                let written = bits(&mut w);
                let (decoded, consumed) = decode_level_code(&written, suffix_length);
                assert_eq!(consumed, written.len(), "{level_code} at {suffix_length}");
                assert_eq!(decoded, level_code, "{level_code} at {suffix_length}");
            }
        }
    }

    #[test]
    fn a_level_past_level_prefix_24_is_an_error() {
        // Prefixes 15 to 24 carry suffixes of 12 to 21 bits, stacked end to
        // end after the 30 values below them.
        let last = 30 + (1u32 << 22) - 4096 - 1;
        let mut w = BitWriter::new();
        assert!(
            write_level(&mut w, last, 0).is_ok(),
            "the last value inside"
        );
        assert!(write_level(&mut w, last + 1, 0).is_err());
    }
}
