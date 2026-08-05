//! Pixel reconstruction used only by the expensive I_PCM fallback path.

use crate::error::{bail, Result};
use crate::h264::chroma::idct8;
use crate::h264::mb::PcmMacroblockSamples;
use crate::h264::quant::{field_dct_to_frame_targets, intra_targets, FLAT_PREDICTION_DC};
use crate::mpeg2::constants::QUANTISER_SCALE;
use crate::mpeg2::headers::Picture;
use crate::mpeg2::macroblock::Macroblock;
use crate::round_half_up;

fn sample(value: f32) -> u8 {
    round_half_up(value as f64).clamp(0.0, 255.0) as u8
}

/// H.262 clause 7.4.4: the reconstructed coefficients are clipped and their sum
/// forced odd, so that different IDCT implementations cannot drift apart.
fn mismatch_control(coeff: &mut [f32; 64]) {
    let mut sum = 0i64;
    for value in coeff.iter_mut() {
        let clamped = value.trunc().clamp(-2048.0, 2047.0);
        *value = clamped;
        sum += clamped as i64;
    }
    if sum & 1 == 0 {
        coeff[63] = ((coeff[63].trunc() as i32) ^ 1) as f32;
    }
}

/// Reconstruct one MPEG-2 intra macroblock as planar 4:2:0 samples.
pub fn reconstruct_intra_pcm(mb: &Macroblock, pic: &Picture) -> Result<PcmMacroblockSamples> {
    if mb.skipped || !mb.is_intra() {
        bail!("I_PCM reconstruction requires a coded MPEG-2 intra macroblock");
    }
    let quantiser_scale =
        QUANTISER_SCALE[pic.coding.q_scale_type][mb.quantiser_scale_code as usize];
    let mut coeff = [[0.0f32; 64]; 6];
    for block in 0..6 {
        let Some(levels) = mb.block(block) else {
            continue;
        };
        let matrix = if block < 4 {
            &pic.quant.intra
        } else {
            &pic.quant.chroma_intra
        };
        let target = &mut coeff[block];
        intra_targets(
            levels,
            matrix,
            quantiser_scale,
            pic.coding.intra_dc_precision,
            target,
        );
        target[0] += FLAT_PREDICTION_DC;
        mismatch_control(target);
    }

    // Field-DCT luma blocks carry alternating lines. Convert them into ordinary
    // upper/lower frame blocks before the inverse transform.
    if mb.dct_type == 1 {
        let mut converted = [[0.0f32; 64]; 4];
        {
            let (upper, lower) = converted.split_at_mut(2);
            field_dct_to_frame_targets(&coeff[0], &coeff[2], &mut upper[0], &mut lower[0]);
            field_dct_to_frame_targets(&coeff[1], &coeff[3], &mut upper[1], &mut lower[1]);
        }
        coeff[..4].copy_from_slice(&converted);
    }

    let mut spatial = [[0.0f32; 64]; 6];
    let mut tmp = [0.0f32; 64];
    for block in 0..6 {
        idct8(&coeff[block], &mut spatial[block], &mut tmp);
    }

    let mut luma = [0u8; 256];
    for block in 0..4 {
        let x0 = (block & 1) * 8;
        let y0 = (block >> 1) * 8;
        for y in 0..8 {
            for x in 0..8 {
                luma[(y0 + y) * 16 + x0 + x] = sample(spatial[block][y * 8 + x]);
            }
        }
    }
    let mut cb = [0u8; 64];
    let mut cr = [0u8; 64];
    for i in 0..64 {
        cb[i] = sample(spatial[4][i]);
        cr[i] = sample(spatial[5][i]);
    }
    Ok(PcmMacroblockSamples { luma, cb, cr })
}
