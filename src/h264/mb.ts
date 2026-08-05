/**
 * H.264 macroblock layer for macroblocks predicted from the grey reference.
 *
 * Every MPEG-2 macroblock becomes an inter macroblock, including intra ones:
 * see grayframe.ts for why H.264 intra prediction is avoided entirely. An intra
 * macroblock is coded as P_L0_16x16 with a zero motion vector pointing at the
 * all-grey long-term reference, so its prediction is a known constant and its
 * residual is just the block with 128 removed.
 */
import type { BitWriter } from "./bitwriter.ts";
import { CBP_TO_CODE_NUM_INTER } from "./cavlc-tables.ts";
import { writeResidualBlock } from "./cavlc.ts";
import type { ChromaBlockLevels } from "./chroma.ts";
import { ZIGZAG_8X8 } from "./params.ts";

/**
 * B slice macroblock types for a single 16x16 partition (Table 7-14).
 *
 * Everything this transcoder emits is a B slice, including the pictures that
 * were I or P in the source, because bi-prediction is only available there and
 * the half-sample mapping depends on it.
 */
export const BMbType = {
  L0_16X16: 1,
  L1_16X16: 2,
  BI_16X16: 3,
} as const;

/**
 * te(v): with exactly two choices the value is a single inverted bit, otherwise
 * it is plain ue(v) (clause 9.1.1).
 */
function writeTe(w: BitWriter, value: number, range: number): void {
  if (range === 1) w.u(1, value === 0 ? 1 : 0);
  else w.ue(value);
}

/**
 * Position of each 4x4 luma block within a macroblock, in units of 4 samples
 * (clause 6.4.3). The order walks 8x8 quadrants, and the four 4x4 blocks inside
 * each quadrant, rather than plain raster.
 */
const LUMA_4X4_XY: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [2, 0],
  [3, 0],
  [2, 1],
  [3, 1],
  [0, 2],
  [1, 2],
  [0, 3],
  [1, 3],
  [2, 2],
  [3, 2],
  [2, 3],
  [3, 3],
];

/**
 * TotalCoeff of every 4x4 luma block in the picture, which neighbouring blocks
 * need to derive their nC (clause 9.2.1). -1 marks a block outside the picture.
 */
export class CoeffCountMap {
  private readonly counts: Int16Array;
  readonly blkW: number;
  readonly blkH: number;

  /** Dimensions are in 4x4 blocks, which differ between luma and chroma. */
  constructor(blkW: number, blkH: number) {
    this.blkW = blkW;
    this.blkH = blkH;
    this.counts = new Int16Array(blkW * blkH).fill(-1);
  }

  reset(): void {
    this.counts.fill(-1);
  }

  set(bx: number, by: number, total: number): void {
    this.counts[by * this.blkW + bx] = total;
  }

  /**
   * nC from the left and upper neighbours. A block that was coded but carries
   * no coefficients counts as 0, which is different from being unavailable.
   */
  nC(bx: number, by: number): number {
    const a = bx > 0 ? this.counts[by * this.blkW + bx - 1]! : -1;
    const b = by > 0 ? this.counts[(by - 1) * this.blkW + bx]! : -1;
    if (a >= 0 && b >= 0) return (a + b + 1) >> 1;
    if (a >= 0) return a;
    if (b >= 0) return b;
    return 0;
  }
}

export interface GrayRefMacroblock {
  /** Macroblock position in the picture. */
  mbX: number;
  mbY: number;
  /** One of BMbType. */
  mbType: number;
  /** Reference indices; -1 marks a list this macroblock does not use. */
  refIdxL0: number;
  refIdxL1: number;
  /** Motion vector differences in quarter samples. */
  mvdL0x: number;
  mvdL0y: number;
  mvdL1x: number;
  mvdL1y: number;
  /** Highest reference index available in each list, for te(v). */
  numRefIdxL0Minus1: number;
  numRefIdxL1Minus1: number;
  /**
   * Four 8x8 luma blocks of H.264 coefficient levels in 8x8 zig-zag scan order,
   * or null where the block has no coefficients at all.
   */
  luma: (Int32Array | null)[];
  /** Cb and Cr, or null to leave chroma at the prediction. */
  chroma: [ChromaBlockLevels, ChromaBlockLevels] | null;
  /** QP this macroblock is coded at. */
  qp: number;
  /** QP of the previous macroblock in decoding order, for mb_qp_delta. */
  prevQp: number;
}

/** Coefficient counts for the chroma 4x4 blocks, one map per component. */
export interface ChromaCounts {
  cb: CoeffCountMap;
  cr: CoeffCountMap;
}

export function makeChromaCounts(
  mbWidth: number,
  mbHeight: number,
): ChromaCounts {
  // 4:2:0 chroma is a 2x2 grid of 4x4 blocks per macroblock.
  return {
    cb: new CoeffCountMap(mbWidth * 2, mbHeight * 2),
    cr: new CoeffCountMap(mbWidth * 2, mbHeight * 2),
  };
}

/** Luma is a 4x4 grid of 4x4 blocks per macroblock. */
export function makeLumaCounts(
  mbWidth: number,
  mbHeight: number,
): CoeffCountMap {
  return new CoeffCountMap(mbWidth * 4, mbHeight * 4);
}

/**
 * Write one macroblock. Returns the QP in effect afterwards, which is the
 * macroblock's own QP only if it actually carried a mb_qp_delta.
 */
export function writeGrayRefMacroblock(
  w: BitWriter,
  counts: CoeffCountMap,
  chromaCounts: ChromaCounts,
  mb: GrayRefMacroblock,
): number {
  w.ue(mb.mbType);

  // mb_pred: reference indices for whichever lists this type uses, then their
  // vector differences. ref_idx is omitted when the list holds one picture.
  const usesL0 =
    mb.mbType === BMbType.L0_16X16 || mb.mbType === BMbType.BI_16X16;
  const usesL1 =
    mb.mbType === BMbType.L1_16X16 || mb.mbType === BMbType.BI_16X16;
  if (usesL0 && mb.numRefIdxL0Minus1 > 0)
    writeTe(w, mb.refIdxL0, mb.numRefIdxL0Minus1);
  if (usesL1 && mb.numRefIdxL1Minus1 > 0)
    writeTe(w, mb.refIdxL1, mb.numRefIdxL1Minus1);
  if (usesL0) {
    w.se(mb.mvdL0x);
    w.se(mb.mvdL0y);
  }
  if (usesL1) {
    w.se(mb.mvdL1x);
    w.se(mb.mvdL1y);
  }

  let cbpLuma = 0;
  for (let i8x8 = 0; i8x8 < 4; i8x8++) {
    if (mb.luma[i8x8]) cbpLuma |= 1 << i8x8;
  }
  // 0 means no chroma coefficients, 1 means DC only, 2 means DC and AC.
  let cbpChroma = 0;
  if (mb.chroma) {
    const [cb, cr] = mb.chroma;
    if (cb.anyAc || cr.anyAc) cbpChroma = 2;
    else if (cb.anyDc || cr.anyDc) cbpChroma = 1;
  }
  const cbp = cbpLuma + 16 * cbpChroma;
  w.ue(CBP_TO_CODE_NUM_INTER[cbp]!);

  if (cbpLuma > 0) {
    w.flag(1); // transform_size_8x8_flag
  }

  let qpAfter = mb.prevQp;
  if (cbp !== 0) {
    w.se(wrapQpDelta(mb.qp - mb.prevQp));
    qpAfter = mb.qp;
    if (cbpLuma > 0) {
      writeLumaResidual8x8(w, counts, mb, cbpLuma);
    } else {
      markNoCoefficients(counts, mb.mbX, mb.mbY);
    }
    writeChromaResidual(w, chromaCounts, mb, cbpChroma);
  } else {
    markNoCoefficients(counts, mb.mbX, mb.mbY);
    markNoChromaCoefficients(chromaCounts, mb.mbX, mb.mbY);
  }
  return qpAfter;
}

/**
 * Chroma residual: both DC blocks first, then every AC block (clause 7.3.5.3).
 * The DC blocks use the dedicated chroma table, signalled by nC of -1.
 */
function writeChromaResidual(
  w: BitWriter,
  counts: ChromaCounts,
  mb: GrayRefMacroblock,
  cbpChroma: number,
): void {
  if (cbpChroma === 0 || !mb.chroma) {
    markNoChromaCoefficients(counts, mb.mbX, mb.mbY);
    return;
  }
  const maps = [counts.cb, counts.cr];

  for (let c = 0; c < 2; c++) {
    writeResidualBlock(w, { levels: mb.chroma[c]!.dc, maxNumCoeff: 4, nC: -1 });
  }

  for (let c = 0; c < 2; c++) {
    const map = maps[c]!;
    for (let b = 0; b < 4; b++) {
      const bx = mb.mbX * 2 + (b & 1);
      const by = mb.mbY * 2 + (b >> 1);
      if (cbpChroma !== 2) {
        map.set(bx, by, 0);
        continue;
      }
      const total = writeResidualBlock(w, {
        levels: mb.chroma[c]!.ac[b]!,
        maxNumCoeff: 15,
        nC: map.nC(bx, by),
      });
      map.set(bx, by, total);
    }
  }
}

export function markNoChromaCoefficients(
  counts: ChromaCounts,
  mbX: number,
  mbY: number,
): void {
  for (const map of [counts.cb, counts.cr]) {
    for (let b = 0; b < 4; b++) {
      map.set(mbX * 2 + (b & 1), mbY * 2 + (b >> 1), 0);
    }
  }
}

/**
 * Record that a macroblock carries no coefficients, so its blocks contribute
 * nC 0 to their neighbours. Applies to skipped macroblocks and to coded ones
 * whose coded_block_pattern is zero.
 */
export function markNoCoefficients(
  counts: CoeffCountMap,
  mbX: number,
  mbY: number,
): void {
  for (let blk = 0; blk < 16; blk++) {
    const [x, y] = LUMA_4X4_XY[blk]!;
    counts.set(mbX * 4 + x, mbY * 4 + y, 0);
  }
}

/**
 * mb_qp_delta is confined to -26..25, but the decoder resolves it modulo 52, so
 * a jump larger than that range is expressed by wrapping rather than clamping.
 */
export function wrapQpDelta(delta: number): number {
  return ((((delta + 26) % 52) + 52) % 52) - 26;
}

/**
 * Write the luma residual with the 8x8 transform under CAVLC.
 *
 * CAVLC has no 8x8 residual syntax: clause 7.3.5.3.2 sends an 8x8 block as four
 * interleaved 4x4 blocks, where 4x4 block i4x4 carries the 8x8 scan positions
 * congruent to i4x4 modulo 4.
 */
function writeLumaResidual8x8(
  w: BitWriter,
  counts: CoeffCountMap,
  mb: GrayRefMacroblock,
  cbpLuma: number,
): void {
  const sub = new Int32Array(16);
  for (let i8x8 = 0; i8x8 < 4; i8x8++) {
    const block = mb.luma[i8x8];
    for (let i4x4 = 0; i4x4 < 4; i4x4++) {
      const blkIdx = i8x8 * 4 + i4x4;
      const [x, y] = LUMA_4X4_XY[blkIdx]!;
      const bx = mb.mbX * 4 + x;
      const by = mb.mbY * 4 + y;

      if ((cbpLuma & (1 << i8x8)) === 0 || !block) {
        counts.set(bx, by, 0);
        continue;
      }

      for (let i = 0; i < 16; i++) sub[i] = block[4 * i + i4x4]!;
      const total = writeResidualBlock(w, {
        levels: sub,
        maxNumCoeff: 16,
        nC: counts.nC(bx, by),
      });
      counts.set(bx, by, total);
    }
  }
}

/**
 * Reorder an 8x8 block of levels from raster order into the 8x8 zig-zag scan
 * the residual syntax expects.
 */
export function toZigzag8x8(
  raster: Float64Array | Int32Array,
  out: Int32Array,
): boolean {
  let any = false;
  for (let k = 0; k < 64; k++) {
    const v = raster[ZIGZAG_8X8[k]!]!;
    out[k] = v;
    if (v !== 0) any = true;
  }
  return any;
}
