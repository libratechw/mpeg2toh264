//! CAVLC residual block encoding (clause 9.2, run in reverse).
//!
//! A block is coded from the highest frequency coefficient downwards: first how
//! many non-zero levels there are and how many of them are trailing +/-1s, then
//! the signs of those ones, then the remaining levels, then how the zeros are
//! distributed between them.

use crate::error::{bail, Result};
use crate::h264::bitwriter::BitWriter;
use crate::h264::cavlc_tables::{
    coeff_token_table_index, Vlc, COEFF_TOKEN, RUN_BEFORE, TOTAL_ZEROS_4X4, TOTAL_ZEROS_CHROMA_DC,
};

#[inline]
fn write_code(w: &mut BitWriter, code: Vlc) {
    w.u(code.len, code.bits);
}

/// Which total_zeros table applies, given the block size being coded.
fn total_zeros_code(total_coeff: usize, total_zeros: usize, max_num_coeff: usize) -> Result<Vlc> {
    let table = if max_num_coeff == 4 {
        TOTAL_ZEROS_CHROMA_DC.get(total_coeff - 1)
    } else {
        TOTAL_ZEROS_4X4.get(total_coeff - 1)
    };
    match table.and_then(|t| t.get(total_zeros)).copied().flatten() {
        Some(code) => Ok(code),
        None => bail!(
            "no total_zeros code for totalCoeff={total_coeff} totalZeros={total_zeros} maxNumCoeff={max_num_coeff}"
        ),
    }
}

/// Encode one level as `level_prefix` and `level_suffix`.
///
/// The prefix/suffix split depends on `suffix_length`, which adapts as levels
/// are written so that blocks with large coefficients spend fewer bits on them.
/// Clause 9.2.2 defines this as a decode; the boundaries below are that process
/// inverted.
fn write_level(w: &mut BitWriter, level_code: i32, suffix_length: u32) -> Result<()> {
    if level_code < 0 {
        bail!("negative levelCode {level_code}");
    }
    let level_code = level_code as u32;

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
                bail!("level {level_code} is beyond level_prefix range");
            }
        }
        prefix = p;
        suffix_bits = p - 3;
        suffix = level_code - base;
    }

    w.u(prefix + 1, 1);
    if suffix_bits > 0 {
        w.u(suffix_bits, suffix);
    }
    Ok(())
}

/// Write one residual block. Returns TotalCoeff, which neighbouring blocks need
/// in order to derive their own nC.
///
/// `levels` holds the coefficient levels in coding scan order, lowest frequency
/// first; `max_num_coeff` is how many positions the block has (16, 15 or 4); and
/// `n_c` is the count predicted from the neighbouring blocks, or -1 for a 4:2:0
/// chroma DC block (clause 9.2.1).
pub fn write_residual_levels(
    w: &mut BitWriter,
    levels: &[i32],
    max_num_coeff: usize,
    n_c: i32,
) -> Result<usize> {
    // Which levels are non-zero, one bit each, lowest frequency in bit 0. This
    // runs on every block of every macroblock, and most blocks are empty or
    // nearly so, so the positions are read off the mask afterwards rather than
    // built by a branch per coefficient.
    let mut mask = 0u32;
    for i in 0..max_num_coeff {
        mask |= u32::from(levels[i] != 0) << i;
    }
    let total_coeff = mask.count_ones() as usize;

    if total_coeff == 0 {
        let Some(token) = COEFF_TOKEN[coeff_token_table_index(n_c)][0] else {
            bail!("no coeff_token for an empty block at nC={n_c}");
        };
        write_code(w, token);
        return Ok(0);
    }

    // Positions of the non-zero levels, lowest frequency first.
    let mut positions = [0u8; 16];
    let mut rest = mask;
    for slot in positions.iter_mut().take(total_coeff) {
        *slot = rest.trailing_zeros() as u8;
        rest &= rest - 1;
    }
    let position = |k: usize| positions[k] as usize;

    // Trailing ones are the run of +/-1 at the high frequency end, at most three.
    let mut trailing_ones = 0usize;
    for k in (0..total_coeff).rev() {
        if trailing_ones >= 3 || levels[position(k)].abs() != 1 {
            break;
        }
        trailing_ones += 1;
    }

    let token = COEFF_TOKEN[coeff_token_table_index(n_c)][trailing_ones * 17 + total_coeff];
    let Some(token) = token else {
        bail!("no coeff_token for trailingOnes={trailing_ones} totalCoeff={total_coeff} nC={n_c}");
    };
    write_code(w, token);

    // Signs of the trailing ones, highest frequency first.
    for i in 0..trailing_ones {
        let level = levels[position(total_coeff - 1 - i)];
        w.flag(level < 0); // 1 means negative
    }

    // Remaining levels, still highest frequency first.
    let mut suffix_length = u32::from(total_coeff > 10 && trailing_ones < 3);
    for i in trailing_ones..total_coeff {
        let level = levels[position(total_coeff - 1 - i)];
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

        write_level(w, level_code, suffix_length)?;

        if suffix_length == 0 {
            suffix_length = 1;
        }
        if level.abs() > (3 << (suffix_length - 1)) && suffix_length < 6 {
            suffix_length += 1;
        }
    }

    // How the zeros are distributed. The count before the lowest frequency
    // non-zero coefficient is implied by what is left over.
    if total_coeff < max_num_coeff {
        let total_zeros = position(total_coeff - 1) - (total_coeff - 1);
        write_code(
            w,
            total_zeros_code(total_coeff, total_zeros, max_num_coeff)?,
        );

        let mut zeros_left = total_zeros;
        let mut i = 0;
        while i < total_coeff - 1 && zeros_left > 0 {
            let hi = position(total_coeff - 1 - i);
            let lo = position(total_coeff - 2 - i);
            let run_before = hi - lo - 1;
            let table_index = zeros_left.min(7) - 1;
            let Some(code) = RUN_BEFORE[table_index].get(run_before).copied().flatten() else {
                bail!("no run_before code for run={run_before} zerosLeft={zeros_left}");
            };
            write_code(w, code);
            zeros_left -= run_before;
            i += 1;
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
        let total = write_residual_levels(&mut w, &levels, 16, 0).expect("encodes");
        assert_eq!(total, 5, "TotalCoeff is what neighbours read back");
        assert_eq!(bits(&mut w), "000010001110010111101101");
    }

    #[test]
    fn an_empty_block_is_one_coeff_token_and_nothing_else() {
        let mut w = BitWriter::new();
        let total = write_residual_levels(&mut w, &[0; 16], 16, 0).expect("encodes");
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
        let total = write_residual_levels(&mut w, &[1, 0, 0, 0], 4, -1).expect("encodes");
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
            write_residual_levels(&mut w, &levels, 16, 0).expect("encodes"),
            4
        );
    }

    #[test]
    fn a_large_level_reaches_the_escape_range() {
        let mut levels = [0i32; 16];
        levels[0] = 4000;
        let mut w = BitWriter::new();
        write_residual_levels(&mut w, &levels, 16, 0).expect("encodes a large level");
        assert!(w.bit_length() > 20, "the escape suffix is wide");
    }
}
