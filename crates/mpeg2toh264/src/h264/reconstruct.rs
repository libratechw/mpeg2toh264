//! What an H.264 decoder makes of the levels this transcoder writes.
//!
//! Everywhere else the transcoder can stay in the coefficient domain, because
//! nothing it writes is ever predicted from a picture it produced. The random
//! access point is the exception: it is a real intra picture, and H.264 intra
//! prediction reads back the reconstructed samples of the blocks already coded.
//! Those samples are the *decoder's*, not the source's, so they have to be
//! reproduced here exactly -- integer for integer. A single sample out of place
//! is not a rounding difference that stays put: the next block predicts from
//! it, so the error walks along the scan and turns into banding.
//!
//! Clauses 8.5.12 and 8.5.13, transcribed. The forward direction lives in
//! [`crate::h264::quant`] and [`crate::h264::chroma`], which work in floating
//! point because they only have to land on the nearest level; this direction
//! has no such latitude.

/// `normAdjust8x8`, clause 8.5.13.1. Six positions per `qP % 6`, selected by
/// where `(i, j)` falls modulo four.
const NORM_ADJUST_8X8: [[i32; 6]; 6] = [
    [20, 18, 32, 19, 25, 24],
    [22, 19, 35, 21, 28, 26],
    [26, 23, 42, 24, 33, 31],
    [28, 25, 45, 26, 35, 33],
    [32, 28, 51, 30, 40, 38],
    [36, 32, 58, 34, 46, 43],
];

/// `normAdjust4x4`, clause 8.5.12.1. Three positions per `qP % 6`.
const NORM_ADJUST_4X4: [[i32; 3]; 6] = [
    [10, 16, 13],
    [11, 18, 14],
    [13, 20, 16],
    [14, 23, 18],
    [16, 25, 20],
    [18, 29, 23],
];

fn norm_adjust_8x8(m: usize, i: usize, j: usize) -> i32 {
    let v = &NORM_ADJUST_8X8[m];
    match (i % 4, j % 4, i % 2, j % 2) {
        (0, 0, _, _) => v[0],
        (_, _, 1, 1) => v[1],
        (2, 2, _, _) => v[2],
        (0, _, _, 1) | (_, 0, 1, _) => v[3],
        (0, 2, _, _) | (2, 0, _, _) => v[4],
        _ => v[5],
    }
}

fn norm_adjust_4x4(m: usize, i: usize, j: usize) -> i32 {
    let v = &NORM_ADJUST_4X4[m];
    match (i % 2, j % 2) {
        (0, 0) => v[0],
        (1, 1) => v[1],
        _ => v[2],
    }
}

/// `levelScale8x8` for one scaling list, for every `qP % 6` and position.
///
/// The scaling list is fixed for a sequence, so this is built once alongside
/// the forward quantiser that shares it.
pub struct InverseScale8x8 {
    /// Indexed by `(qp % 6) * 64 + position`, position in raster order.
    scale: [i32; 6 * 64],
}

impl InverseScale8x8 {
    pub fn new(weight_scale: &[i32; 64]) -> Self {
        let mut scale = [0i32; 6 * 64];
        for m in 0..6 {
            for pos in 0..64 {
                scale[m * 64 + pos] = weight_scale[pos] * norm_adjust_8x8(m, pos >> 3, pos & 7);
            }
        }
        Self { scale }
    }
}

/// Clause 8.5.13.1 then 8.5.13.2: levels in raster order to residual samples.
pub fn residual_8x8(levels: &[i32; 64], qp: i32, scale: &InverseScale8x8, out: &mut [i32; 64]) {
    let m = (qp % 6) as usize;
    let shift = qp / 6;
    let base = m * 64;
    let mut d = [0i32; 64];
    if shift >= 6 {
        for pos in 0..64 {
            d[pos] = (levels[pos] * scale.scale[base + pos]) << (shift - 6);
        }
    } else {
        let round = 1 << (5 - shift);
        for pos in 0..64 {
            d[pos] = (levels[pos] * scale.scale[base + pos] + round) >> (6 - shift);
        }
    }
    // Rows first, then columns, exactly as clause 8.5.13.2 orders them.
    let mut row = [0i32; 64];
    for i in 0..8 {
        let mut line = [0i32; 8];
        line.copy_from_slice(&d[i * 8..i * 8 + 8]);
        butterfly_8(&mut line);
        row[i * 8..i * 8 + 8].copy_from_slice(&line);
    }
    for j in 0..8 {
        let mut line = [0i32; 8];
        for i in 0..8 {
            line[i] = row[i * 8 + j];
        }
        butterfly_8(&mut line);
        for i in 0..8 {
            out[i * 8 + j] = (line[i] + 32) >> 6;
        }
    }
}

/// One pass of the 8x8 inverse transform, clause 8.5.13.2.
fn butterfly_8(x: &mut [i32; 8]) {
    let e0 = x[0] + x[4];
    let e1 = -x[3] + x[5] - x[7] - (x[7] >> 1);
    let e2 = x[0] - x[4];
    let e3 = x[1] + x[7] - x[3] - (x[3] >> 1);
    let e4 = (x[2] >> 1) - x[6];
    let e5 = -x[1] + x[7] + x[5] + (x[5] >> 1);
    let e6 = x[2] + (x[6] >> 1);
    let e7 = x[3] + x[5] + x[1] + (x[1] >> 1);

    let f0 = e0 + e6;
    let f1 = e1 + (e7 >> 2);
    let f2 = e2 + e4;
    let f3 = e3 + (e5 >> 2);
    let f4 = e2 - e4;
    let f5 = (e3 >> 2) - e5;
    let f6 = e0 - e6;
    let f7 = e7 - (e1 >> 2);

    x[0] = f0 + f7;
    x[1] = f2 + f5;
    x[2] = f4 + f3;
    x[3] = f6 + f1;
    x[4] = f6 - f1;
    x[5] = f4 - f3;
    x[6] = f2 - f5;
    x[7] = f0 - f7;
}

/// Clause 8.5.11.1: the four chroma DC levels of one component to the DC term
/// of each of its 4x4 blocks. 4:2:0, so the transform is 2x2.
///
/// The 4x4 scaling list is flat here -- the PPS sends 8x8 lists only, and the
/// default for the lists it leaves out is Flat_4x4_16 -- so the weight is 16
/// at every position and only `normAdjust4x4(m, 0, 0)` varies.
pub fn chroma_dc_terms(levels: &[i32; 4], qp_c: i32) -> [i32; 4] {
    let m = (qp_c % 6) as usize;
    let shift = qp_c / 6;
    let scale = 16 * norm_adjust_4x4(m, 0, 0);
    // [[1,1],[1,-1]] on both sides.
    let f = [
        levels[0] + levels[1] + levels[2] + levels[3],
        levels[0] - levels[1] + levels[2] - levels[3],
        levels[0] + levels[1] - levels[2] - levels[3],
        levels[0] - levels[1] - levels[2] + levels[3],
    ];
    let mut out = [0i32; 4];
    for k in 0..4 {
        out[k] = ((f[k] * scale) << shift) >> 5;
    }
    out
}

/// Clause 8.5.12.1 then 8.5.12.2 for one chroma 4x4 block, whose DC term comes
/// from [`chroma_dc_terms`] rather than from the block's own level.
pub fn chroma_residual_4x4(ac: &[i32; 16], dc: i32, qp_c: i32, out: &mut [i32; 16]) {
    let m = (qp_c % 6) as usize;
    let shift = qp_c / 6;
    let mut d = [0i32; 16];
    for pos in 1..16 {
        let scale = 16 * norm_adjust_4x4(m, pos >> 2, pos & 3);
        d[pos] = if shift >= 4 {
            (ac[pos] * scale) << (shift - 4)
        } else {
            (ac[pos] * scale + (1 << (3 - shift))) >> (4 - shift)
        };
    }
    d[0] = dc;
    let mut row = [0i32; 16];
    for i in 0..4 {
        let mut line = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]];
        butterfly_4(&mut line);
        row[i * 4..i * 4 + 4].copy_from_slice(&line);
    }
    for j in 0..4 {
        let mut line = [row[j], row[4 + j], row[8 + j], row[12 + j]];
        butterfly_4(&mut line);
        for i in 0..4 {
            out[i * 4 + j] = (line[i] + 32) >> 6;
        }
    }
}

/// One pass of the 4x4 inverse transform, clause 8.5.12.2.
fn butterfly_4(x: &mut [i32; 4]) {
    let e0 = x[0] + x[2];
    let e1 = x[0] - x[2];
    let e2 = (x[1] >> 1) - x[3];
    let e3 = x[1] + (x[3] >> 1);
    x[0] = e0 + e3;
    x[1] = e1 + e2;
    x[2] = e1 - e2;
    x[3] = e0 - e3;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::h264::quant_tables::{BASE_GAIN_8X8, CHROMA_AC_GAIN_4X4, CHROMA_DC_GAIN};

    /// Orthonormal 8-point DCT of a residual block, for comparing what the
    /// integer transform actually produces against what the forward path's
    /// gain table says one unit of level is worth.
    fn dct8_coefficient(samples: &[i32; 64], u: usize, v: usize) -> f64 {
        let basis = |k: usize, n: usize| {
            let norm = if k == 0 { 0.5f64 } else { 1.0 };
            (norm / 4.0).sqrt()
                * ((2 * n + 1) as f64 * k as f64 * std::f64::consts::PI / 16.0).cos()
        };
        let mut sum = 0.0;
        for y in 0..8 {
            for x in 0..8 {
                sum += samples[y * 8 + x] as f64 * basis(v, y) * basis(u, x);
            }
        }
        sum
    }

    #[test]
    fn a_zero_block_reconstructs_to_nothing() {
        let scale = InverseScale8x8::new(&[16; 64]);
        let mut out = [0i32; 64];
        for qp in 0..52 {
            residual_8x8(&[0; 64], qp, &scale, &mut out);
            assert!(out.iter().all(|&v| v == 0), "qp {qp}");
        }
    }

    /// The whole mapping rests on the claim that one unit of level reconstructs
    /// to `BASE_GAIN_8X8 * weight * 2^(qp/6)` of orthonormal-DCT value. That
    /// table was derived from the same clauses this module transcribes, so the
    /// two agreeing is a real check on both.
    #[test]
    fn one_unit_of_level_is_worth_what_the_gain_table_says() {
        let weight = [16i32; 64];
        let scale = InverseScale8x8::new(&weight);
        let mut out = [0i32; 64];
        for qp in [12, 20, 26, 33, 40, 51] {
            for pos in [0usize, 1, 9, 18, 27, 63] {
                // A level large enough that the reconstruction's own rounding
                // is small next to it.
                let level = 64;
                let mut levels = [0i32; 64];
                levels[pos] = level;
                residual_8x8(&levels, qp, &scale, &mut out);
                let got = dct8_coefficient(&out, pos & 7, pos >> 3);
                let expected = BASE_GAIN_8X8[(qp % 6) as usize][pos >> 3][pos & 7]
                    * weight[pos] as f64
                    * 2f64.powi(qp / 6)
                    * level as f64;
                assert!(
                    (got - expected).abs() < expected.abs() * 0.02 + 1.0,
                    "qp {qp} pos {pos}: integer transform gave {got}, gain table says {expected}"
                );
            }
        }
    }

    #[test]
    fn a_flat_residual_comes_back_flat() {
        // Only the DC level set, so every sample of the block is the same.
        let scale = InverseScale8x8::new(&[16; 64]);
        let mut levels = [0i32; 64];
        levels[0] = 40;
        let mut out = [0i32; 64];
        residual_8x8(&levels, 26, &scale, &mut out);
        assert!(out.iter().all(|&v| v == out[0]), "{:?}", &out[..8]);
        assert!(out[0] > 0);
    }

    #[test]
    fn chroma_dc_matches_its_gain_table() {
        for qp_c in [10, 22, 30, 39] {
            let levels = [32, 0, 0, 0];
            let dc = chroma_dc_terms(&levels, qp_c);
            // A DC-only 2x2 spreads evenly over the four blocks.
            assert!(dc.iter().all(|&v| v == dc[0]));
            let mut out = [0i32; 16];
            chroma_residual_4x4(&[0; 16], dc[0], qp_c, &mut out);
            assert!(out.iter().all(|&v| v == out[0]));
            // The gain is per unit of level of the forward transform's DC,
            // which is the sum over the block's sixteen samples.
            let expected = CHROMA_DC_GAIN[(qp_c % 6) as usize] * 2f64.powi(qp_c / 6) * 32.0 / 16.0;
            let got = out[0] as f64;
            assert!(
                (got - expected).abs() < expected.abs() * 0.05 + 1.0,
                "qp_c {qp_c}: got {got}, gain table says {expected}"
            );
        }
    }

    #[test]
    fn chroma_ac_matches_its_gain_table() {
        for qp_c in [10, 22, 30, 39] {
            for pos in [1usize, 5, 10, 15] {
                let mut ac = [0i32; 16];
                ac[pos] = 48;
                let mut out = [0i32; 16];
                chroma_residual_4x4(&ac, 0, qp_c, &mut out);
                // Project onto the H.264 core basis the forward path uses.
                let cf = [
                    [1i32, 1, 1, 1],
                    [2, 1, -1, -2],
                    [1, -1, -1, 1],
                    [1, -2, 2, -1],
                ];
                let (i, j) = (pos >> 2, pos & 3);
                let mut sum = 0i32;
                for y in 0..4 {
                    for x in 0..4 {
                        sum += out[y * 4 + x] * cf[i][y] * cf[j][x];
                    }
                }
                // Projecting onto the basis row is the forward transform, so
                // this is the coefficient the forward path started from.
                let got = sum as f64;
                let expected =
                    CHROMA_AC_GAIN_4X4[(qp_c % 6) as usize][i][j] * 2f64.powi(qp_c / 6) * 48.0;
                assert!(
                    (got - expected).abs() < expected.abs() * 0.08 + 2.0,
                    "qp_c {qp_c} pos {pos}: got {got}, gain table says {expected}"
                );
            }
        }
    }
}
