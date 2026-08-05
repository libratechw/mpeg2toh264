/** Pixel reconstruction used only by the expensive I_PCM fallback path. */
import { MBFlag, QUANTISER_SCALE } from "../mpeg2/constants.ts";
import type { Picture } from "../mpeg2/headers.ts";
import type { Macroblock } from "../mpeg2/macroblock.ts";
import { idct8 } from "./chroma.ts";
import type { PcmMacroblockSamples } from "./mb.ts";
import { fieldDctToFrameTargets, GRAY_DC, intraTargets } from "./quant.ts";

function sample(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mismatchControl(coeff: Float64Array): void {
  let sum = 0;
  for (let i = 0; i < 64; i++) {
    const value = Math.max(-2048, Math.min(2047, Math.trunc(coeff[i]!)));
    coeff[i] = value;
    sum += value;
  }
  if ((sum & 1) === 0) coeff[63] = Math.trunc(coeff[63]!) ^ 1;
}

/** Reconstruct one MPEG-2 intra macroblock as planar 4:2:0 samples. */
export function reconstructIntraPcm(
  mb: Macroblock,
  pic: Picture,
): PcmMacroblockSamples {
  if (mb.skipped || (mb.flags & MBFlag.INTRA) === 0) {
    throw new Error(
      "I_PCM reconstruction requires a coded MPEG-2 intra macroblock",
    );
  }
  const quantiserScale =
    QUANTISER_SCALE[pic.coding.qScaleType]![mb.quantiserScaleCode]!;
  const coeff = Array.from({ length: 6 }, () => new Float64Array(64));
  for (let block = 0; block < 6; block++) {
    const levels = mb.blocks[block];
    if (!levels) continue;
    const matrix = block < 4 ? pic.quant.intra : pic.quant.chromaIntra;
    const target = coeff[block]!;
    intraTargets(
      levels,
      matrix,
      quantiserScale,
      pic.coding.intraDcPrecision,
      target,
    );
    target[0] = target[0]! + GRAY_DC;
    mismatchControl(target);
  }

  // Field-DCT luma blocks carry alternating lines. Convert them into ordinary
  // upper/lower frame blocks before the inverse transform.
  if (mb.dctType === 1) {
    const converted = Array.from({ length: 4 }, () => new Float64Array(64));
    fieldDctToFrameTargets(coeff[0]!, coeff[2]!, converted[0]!, converted[2]!);
    fieldDctToFrameTargets(coeff[1]!, coeff[3]!, converted[1]!, converted[3]!);
    for (let block = 0; block < 4; block++) coeff[block] = converted[block]!;
  }

  const spatial = coeff.map(() => new Float64Array(64));
  for (let block = 0; block < 6; block++) idct8(coeff[block]!, spatial[block]!);

  const luma = new Uint8Array(256);
  for (let block = 0; block < 4; block++) {
    const x0 = (block & 1) * 8;
    const y0 = (block >> 1) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        luma[(y0 + y) * 16 + x0 + x] = sample(spatial[block]![y * 8 + x]!);
      }
    }
  }
  const plane = (block: number) =>
    Uint8Array.from(spatial[block]!, (value) => sample(value));
  return { luma, cb: plane(4), cr: plane(5) };
}
