/**
 * Chroma conversion.
 *
 * This is the one place the transcoder does real transform work. MPEG-2 codes a
 * chroma block as a single 8x8 DCT, while H.264 4:2:0 uses four 4x4 transforms
 * plus a 2x2 DC block, and a single 8x8 coefficient spreads across roughly 22 of
 * the 4x4 ones -- there is no per-coefficient shortcut of the kind the luma path
 * uses. So the block is inverse transformed to samples and forward transformed
 * again.
 *
 * Having paid that cost, the forward transform used is H.264's own core
 * transform rather than an idealised DCT. Its rows are mutually orthogonal, so
 * projecting onto them yields exactly the coefficients the decoder
 * reconstructs from, and the basis-shape mismatch that puts a floor under the
 * luma path does not arise here.
 */
import { COS_PI_OVER_16 } from "./cos-table.ts";
import { ZIGZAG_4X4 } from "./params.ts";
import {
  CHROMA_AC_GAIN_4X4,
  CHROMA_DC_GAIN,
  QPC_FROM_QPI,
} from "./quant-tables.ts";
import { FLAT_PREDICTION_DC } from "./quant.ts";

/** Orthonormal 8-point DCT matrix; MPEG-2 coefficients live in this basis. */
const C8 = (() => {
  const m = new Float64Array(64);
  for (let k = 0; k < 8; k++) {
    const scale = Math.sqrt((k === 0 ? 0.5 : 1) / 4);
    for (let n = 0; n < 8; n++) {
      m[k * 8 + n] = COS_PI_OVER_16[(2 * n + 1) * k]! * scale;
    }
  }
  return m;
})();

/** Chroma QP for a given luma QP and PPS offset, via Table 8-15. */
export function chromaQp(lumaQp: number, offset: number): number {
  return QPC_FROM_QPI[Math.max(0, Math.min(51, lumaQp + offset))]!;
}

/** Inverse 8x8 DCT, orthonormal, into `out` in raster order. */
export function idct8(
  coeff: Float64Array,
  out: Float64Array,
  tmp: Float64Array = new Float64Array(64),
): void {
  // Columns first: tmp = C8^T * coeff
  for (let x = 0; x < 8; x++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += C8[u * 8 + x]! * coeff[v * 8 + u]!;
      tmp[v * 8 + x] = s;
    }
  }
  // Then rows: out = tmp^T applied the same way down the other axis.
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += C8[v * 8 + y]! * tmp[v * 8 + x]!;
      out[y * 8 + x] = s;
    }
  }
}

/**
 * H.264's forward 4x4 core transform, W = Cf * X * Cf^T, applied to the 4x4
 * sub-block at (bx, by) of an 8x8 sample block.
 */
const forwardTemp = new Float64Array(16);

function forward4x4(
  block: Float64Array,
  bx: number,
  by: number,
  out: Float64Array,
): void {
  // Cf rows are [1,1,1,1], [2,1,-1,-2], [1,-1,-1,1], [1,-2,2,-1].
  const t = forwardTemp;
  for (let i = 0; i < 4; i++) {
    const r = (by + i) * 8 + bx;
    const a = block[r]!;
    const b = block[r + 1]!;
    const c = block[r + 2]!;
    const d = block[r + 3]!;
    const s0 = a + d;
    const s1 = b + c;
    const s2 = b - c;
    const s3 = a - d;
    t[i * 4] = s0 + s1;
    t[i * 4 + 1] = 2 * s3 + s2;
    t[i * 4 + 2] = s0 - s1;
    t[i * 4 + 3] = s3 - 2 * s2;
  }
  for (let j = 0; j < 4; j++) {
    const a = t[j]!;
    const b = t[4 + j]!;
    const c = t[8 + j]!;
    const d = t[12 + j]!;
    const s0 = a + d;
    const s1 = b + c;
    const s2 = b - c;
    const s3 = a - d;
    out[j] = s0 + s1;
    out[4 + j] = 2 * s3 + s2;
    out[8 + j] = s0 - s1;
    out[12 + j] = s3 - 2 * s2;
  }
}

export interface ChromaBlockLevels {
  /** The four 2x2 DC block levels, in raster order of the 4x4 sub-blocks. */
  dc: Int32Array;
  /** Four 4x4 AC blocks of 15 levels each, in 4x4 zig-zag order from position 1. */
  ac: Int32Array[];
  anyDc: boolean;
  anyAc: boolean;
}

const spatial = new Float64Array(64);
const dequant = new Float64Array(64);
const coeff4 = new Float64Array(16);
const dcTarget = new Float64Array(4);

/** H.264 Table 8-14: 4x4 field scan for field-coded macroblocks. */
export const FIELD_SCAN_4X4: readonly number[] = [
  0, 4, 1, 8, 12, 5, 9, 2, 6, 13, 10, 3, 7, 14, 11, 15,
];

function spatialToChromaLevels(
  samples: Float64Array,
  qpC: number,
  out: ChromaBlockLevels,
  fieldScan = false,
): void {
  const acGain = CHROMA_AC_GAIN_4X4[qpC % 6]!;
  const shift = 2 ** Math.floor(qpC / 6);
  const dcGain = CHROMA_DC_GAIN[qpC % 6]! * shift;

  out.anyAc = false;
  for (let b = 0; b < 4; b++) {
    forward4x4(samples, (b & 1) * 4, (b >> 1) * 4, coeff4);
    dcTarget[b] = coeff4[0]!;
    const acOut = out.ac[b]!;
    for (let k = 1; k < 16; k++) {
      const pos = (fieldScan ? FIELD_SCAN_4X4 : ZIGZAG_4X4)[k]!;
      const gain = acGain[pos >> 2]![pos & 3]! * shift;
      const level = Math.round(coeff4[pos]! / gain);
      acOut[k - 1] = level;
      if (level !== 0) out.anyAc = true;
    }
  }

  const f0 = dcTarget[0]! / dcGain;
  const f1 = dcTarget[1]! / dcGain;
  const f2 = dcTarget[2]! / dcGain;
  const f3 = dcTarget[3]! / dcGain;
  out.dc[0] = Math.round((f0 + f1 + f2 + f3) / 4);
  out.dc[1] = Math.round((f0 - f1 + f2 - f3) / 4);
  out.dc[2] = Math.round((f0 + f1 - f2 - f3) / 4);
  out.dc[3] = Math.round((f0 - f1 - f2 + f3) / 4);
  out.anyDc =
    out.dc[0] !== 0 || out.dc[1] !== 0 || out.dc[2] !== 0 || out.dc[3] !== 0;
}

function dequantChroma(
  levels: Int16Array | null,
  weightScale: readonly number[],
  quantiserScale: number,
  intraDcPrecision: number,
  intra: boolean,
  out: Float64Array,
): void {
  if (!levels) {
    out.fill(0);
    return;
  }
  for (let pos = 0; pos < 64; pos++) {
    const level = levels[pos]!;
    if (intra && pos === 0) {
      out[pos] = (8 >> intraDcPrecision) * level - FLAT_PREDICTION_DC;
    } else if (level === 0) out[pos] = 0;
    else {
      const sign = level < 0 ? -1 : 1;
      out[pos] = intra
        ? Math.trunc((2 * level * weightScale[pos]! * quantiserScale) / 32)
        : Math.trunc(
            ((2 * level + sign) * weightScale[pos]! * quantiserScale) / 32,
          );
    }
  }
}

export interface FieldChromaSource {
  levels: Int16Array | null;
  weightScale: readonly number[];
  quantiserScale: number;
  intraDcPrecision: number;
  intra: boolean;
}

export interface FieldChromaScratch {
  upperCoeff: Float64Array;
  lowerCoeff: Float64Array;
  upperSpatial: Float64Array;
  lowerSpatial: Float64Array;
  fieldSpatial: Float64Array;
  idctTemp: Float64Array;
}

export function makeFieldChromaScratch(): FieldChromaScratch {
  return {
    upperCoeff: new Float64Array(64),
    lowerCoeff: new Float64Array(64),
    upperSpatial: new Float64Array(64),
    lowerSpatial: new Float64Array(64),
    fieldSpatial: new Float64Array(64),
    idctTemp: new Float64Array(64),
  };
}

/** Combine two vertically adjacent MPEG-2 chroma residuals into one field MB. */
export function convertFieldChromaBlocks(
  upper: FieldChromaSource,
  lower: FieldChromaSource,
  field: 0 | 1,
  qpC: number,
  out: ChromaBlockLevels,
  scratch = makeFieldChromaScratch(),
): void {
  const {
    upperCoeff,
    lowerCoeff,
    upperSpatial,
    lowerSpatial,
    fieldSpatial,
    idctTemp,
  } = scratch;
  if (upper.levels) {
    dequantChroma(
      upper.levels,
      upper.weightScale,
      upper.quantiserScale,
      upper.intraDcPrecision,
      upper.intra,
      upperCoeff,
    );
    idct8(upperCoeff, upperSpatial, idctTemp);
  } else {
    upperSpatial.fill(0);
  }
  if (lower.levels) {
    dequantChroma(
      lower.levels,
      lower.weightScale,
      lower.quantiserScale,
      lower.intraDcPrecision,
      lower.intra,
      lowerCoeff,
    );
    idct8(lowerCoeff, lowerSpatial, idctTemp);
  } else {
    lowerSpatial.fill(0);
  }
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      fieldSpatial[y * 8 + x] = upperSpatial[(y * 2 + field) * 8 + x]!;
      fieldSpatial[(y + 4) * 8 + x] = lowerSpatial[(y * 2 + field) * 8 + x]!;
    }
  }
  spatialToChromaLevels(fieldSpatial, qpC, out, true);
}

/** Convert both field macroblocks while sharing the source dequantisation and IDCT. */
export function convertFieldChromaPair(
  upper: FieldChromaSource,
  lower: FieldChromaSource,
  qpC: number,
  out: [ChromaBlockLevels, ChromaBlockLevels],
  scratch = makeFieldChromaScratch(),
): void {
  const {
    upperCoeff,
    lowerCoeff,
    upperSpatial,
    lowerSpatial,
    fieldSpatial,
    idctTemp,
  } = scratch;
  if (upper.levels) {
    dequantChroma(
      upper.levels,
      upper.weightScale,
      upper.quantiserScale,
      upper.intraDcPrecision,
      upper.intra,
      upperCoeff,
    );
    idct8(upperCoeff, upperSpatial, idctTemp);
  } else {
    upperSpatial.fill(0);
  }
  if (lower.levels) {
    dequantChroma(
      lower.levels,
      lower.weightScale,
      lower.quantiserScale,
      lower.intraDcPrecision,
      lower.intra,
      lowerCoeff,
    );
    idct8(lowerCoeff, lowerSpatial, idctTemp);
  } else {
    lowerSpatial.fill(0);
  }
  for (let field = 0; field < 2; field++) {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 8; x++) {
        fieldSpatial[y * 8 + x] = upperSpatial[(y * 2 + field) * 8 + x]!;
        fieldSpatial[(y + 4) * 8 + x] = lowerSpatial[(y * 2 + field) * 8 + x]!;
      }
    }
    spatialToChromaLevels(fieldSpatial, qpC, out[field as 0 | 1]!, true);
  }
}

/**
 * Convert one MPEG-2 intra chroma block into H.264 chroma levels.
 *
 * The prediction being removed is the flat constant of the zero-weight
 * reference index, which in the transform domain is a shift of the DC
 * coefficient alone.
 */
export function convertIntraChromaBlock(
  levels: Int16Array,
  weightScale: readonly number[],
  quantiserScale: number,
  intraDcPrecision: number,
  qpC: number,
  out: ChromaBlockLevels,
  intra: boolean,
): void {
  // MPEG-2 dequantisation, clause 7.4.2.1. An intra block is coded against the
  // flat prediction, so that constant comes off the DC; a non-intra
  // block is coded against motion compensation the H.264 side reproduces, and
  // its residual carries across untouched.
  if (intra) {
    dequant[0] = (8 >> intraDcPrecision) * levels[0]! - FLAT_PREDICTION_DC;
    for (let pos = 1; pos < 64; pos++) {
      const level = levels[pos]!;
      dequant[pos] =
        level === 0
          ? 0
          : Math.trunc((2 * level * weightScale[pos]! * quantiserScale) / 32);
    }
  } else {
    for (let pos = 0; pos < 64; pos++) {
      const level = levels[pos]!;
      if (level === 0) {
        dequant[pos] = 0;
        continue;
      }
      const sign = level < 0 ? -1 : 1;
      dequant[pos] = Math.trunc(
        ((2 * level + sign) * weightScale[pos]! * quantiserScale) / 32,
      );
    }
  }

  idct8(dequant, spatial);

  spatialToChromaLevels(spatial, qpC, out);
}

/**
 * Reset a scratch record. Necessary because coded_block_pattern's chroma field
 * is shared between Cb and Cr: if one component has AC coefficients then both
 * components' AC blocks get written, so an uncoded component must present
 * zeros rather than whatever the previous macroblock left behind.
 */
export function clearChromaBlockLevels(out: ChromaBlockLevels): void {
  out.dc.fill(0);
  for (const block of out.ac) block.fill(0);
  out.anyDc = false;
  out.anyAc = false;
}

export function makeChromaBlockLevels(): ChromaBlockLevels {
  return {
    dc: new Int32Array(4),
    ac: [
      new Int32Array(15),
      new Int32Array(15),
      new Int32Array(15),
      new Int32Array(15),
    ],
    anyDc: false,
    anyAc: false,
  };
}
