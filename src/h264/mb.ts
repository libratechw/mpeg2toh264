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
import { ZIGZAG_8X8 } from "./params.ts";

/** mb_type 0 in a P slice: one 16x16 partition predicted from list 0. */
const MB_TYPE_P_L0_16X16 = 0;

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

  constructor(mbWidth: number, mbHeight: number) {
    this.blkW = mbWidth * 4;
    this.blkH = mbHeight * 4;
    this.counts = new Int16Array(this.blkW * this.blkH).fill(-1);
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
  /**
   * Four 8x8 luma blocks of H.264 coefficient levels in 8x8 zig-zag scan order,
   * or null where the block has no coefficients at all.
   */
  luma: (Int32Array | null)[];
  /** QP this macroblock is coded at. */
  qp: number;
  /** QP of the previous macroblock in decoding order, for mb_qp_delta. */
  prevQp: number;
}

/**
 * Write one macroblock. Returns the QP in effect afterwards, which is the
 * macroblock's own QP only if it actually carried a mb_qp_delta.
 */
export function writeGrayRefMacroblock(
  w: BitWriter,
  counts: CoeffCountMap,
  mb: GrayRefMacroblock,
): number {
  w.ue(MB_TYPE_P_L0_16X16);

  // mb_pred: ref_idx_l0 is not sent because the grey frame is the only entry in
  // list 0. Every macroblock uses a zero vector, so every neighbour predicts
  // zero and the difference is zero too.
  w.se(0); // mvd_l0[0][0][0]
  w.se(0); // mvd_l0[0][0][1]

  let cbpLuma = 0;
  for (let i8x8 = 0; i8x8 < 4; i8x8++) {
    if (mb.luma[i8x8]) cbpLuma |= 1 << i8x8;
  }
  // Chroma is not carried yet, so CodedBlockPatternChroma stays 0.
  const cbp = cbpLuma;
  w.ue(CBP_TO_CODE_NUM_INTER[cbp]!);

  if (cbpLuma > 0) {
    w.flag(1); // transform_size_8x8_flag
  }

  let qpAfter = mb.prevQp;
  if (cbp !== 0) {
    w.se(wrapQpDelta(mb.qp - mb.prevQp));
    qpAfter = mb.qp;
    writeLumaResidual8x8(w, counts, mb, cbpLuma);
  } else {
    markNoCoefficients(counts, mb.mbX, mb.mbY);
  }
  return qpAfter;
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
