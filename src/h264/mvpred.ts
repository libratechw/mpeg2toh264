/**
 * H.264 motion vector prediction (clause 8.4.1.3).
 *
 * Vectors are coded as differences from a prediction derived from the
 * neighbouring macroblocks, so the encoder has to reproduce that derivation
 * exactly to know what difference to send. State is stored per 4x4 luma block
 * so both 16x16 and 16x8 macroblock partitions can use the same neighbour
 * derivation.
 */

/** Motion state of one macroblock, as neighbours need to see it. */
export interface MbMotion {
  /** Reference index per list, or -1 where the list is unused. */
  refIdxL0: number;
  refIdxL1: number;
  /** Vectors in quarter samples. */
  mvL0x: number;
  mvL0y: number;
  mvL1x: number;
  mvL1y: number;
}

/** A neighbour as the predictor sees it; absent ones read as reference -1. */
interface Neighbour {
  available: boolean;
  refIdxL0: number;
  refIdxL1: number;
  mvL0x: number;
  mvL0y: number;
  mvL1x: number;
  mvL1y: number;
}

const UNAVAILABLE: Neighbour = {
  available: false,
  refIdxL0: -1,
  refIdxL1: -1,
  mvL0x: 0,
  mvL0y: 0,
  mvL1x: 0,
  mvL1y: 0,
};

function median(a: number, b: number, c: number): number {
  return a + b + c - Math.min(a, Math.min(b, c)) - Math.max(a, Math.max(b, c));
}

/**
 * Per-picture record of macroblock motion, used to predict each macroblock's
 * vectors from its neighbours.
 */
export class MotionField {
  private readonly blkW: number;
  private readonly blkH: number;
  private readonly refIdx: Int8Array;
  private readonly mv: Int32Array;
  private readonly coded: Uint8Array;

  constructor(mbWidth: number, mbHeight: number) {
    this.blkW = mbWidth * 4;
    this.blkH = mbHeight * 4;
    this.refIdx = new Int8Array(this.blkW * this.blkH * 2);
    this.mv = new Int32Array(this.blkW * this.blkH * 4);
    this.coded = new Uint8Array(this.blkW * this.blkH);
  }

  reset(): void {
    this.refIdx.fill(-1);
    this.mv.fill(0);
    this.coded.fill(0);
  }

  set(mbX: number, mbY: number, m: MbMotion): void {
    this.setRect(mbX * 4, mbY * 4, 4, 4, m);
  }

  /** Record one half of a 16x8-partitioned macroblock. */
  set16x8(mbX: number, mbY: number, part: 0 | 1, m: MbMotion): void {
    this.setRect(mbX * 4, mbY * 4 + part * 2, 4, 2, m);
  }

  private setRect(
    bx: number,
    by: number,
    width: number,
    height: number,
    m: MbMotion,
  ): void {
    for (let y = by; y < by + height; y++) {
      for (let x = bx; x < bx + width; x++) this.setBlock(x, y, m);
    }
  }

  private setBlock(bx: number, by: number, m: MbMotion): void {
    const i = by * this.blkW + bx;
    this.refIdx[i * 2] = m.refIdxL0;
    this.refIdx[i * 2 + 1] = m.refIdxL1;
    this.mv[i * 4] = m.mvL0x;
    this.mv[i * 4 + 1] = m.mvL0y;
    this.mv[i * 4 + 2] = m.mvL1x;
    this.mv[i * 4 + 3] = m.mvL1y;
    this.coded[i] = 1;
  }

  private at(bx: number, by: number): Neighbour {
    if (bx < 0 || by < 0 || bx >= this.blkW || by >= this.blkH)
      return UNAVAILABLE;
    const i = by * this.blkW + bx;
    if (!this.coded[i]) return UNAVAILABLE;
    return {
      available: true,
      refIdxL0: this.refIdx[i * 2]!,
      refIdxL1: this.refIdx[i * 2 + 1]!,
      mvL0x: this.mv[i * 4]!,
      mvL0y: this.mv[i * 4 + 1]!,
      mvL1x: this.mv[i * 4 + 2]!,
      mvL1y: this.mv[i * 4 + 3]!,
    };
  }

  /**
   * Predicted vector for a 16x16 partition, in quarter samples.
   *
   * Neighbours are the macroblock to the left, above, and above-right --
   * falling back to above-left when above-right is outside the picture. If
   * exactly one of them uses the same reference index, its vector is taken
   * directly; otherwise the component-wise median is used.
   */
  predict(
    mbX: number,
    mbY: number,
    list: 0 | 1,
    refIdx: number,
  ): [number, number] {
    return this.predictAt(mbX * 4, mbY * 4, 4, list, refIdx);
  }

  /** Predicted vector for the top or bottom partition of a 16x8 macroblock. */
  predict16x8(
    mbX: number,
    mbY: number,
    part: 0 | 1,
    list: 0 | 1,
    refIdx: number,
  ): [number, number] {
    const bx = mbX * 4;
    const by = mbY * 4 + part * 2;
    const a = this.at(bx - 1, by);
    const b = this.at(bx, by - 1);
    const sameRef = (n: Neighbour) =>
      n.available && (list === 0 ? n.refIdxL0 : n.refIdxL1) === refIdx;
    // Clause 8.4.1.3: 16x8 top prefers B and bottom prefers A before the
    // general median/reference-match process.
    if (part === 0 && sameRef(b)) return this.vectorOf(b, list);
    if (part === 1 && sameRef(a)) return this.vectorOf(a, list);
    return this.predictAt(bx, by, 4, list, refIdx);
  }

  private vectorOf(n: Neighbour, list: 0 | 1): [number, number] {
    return list === 0 ? [n.mvL0x, n.mvL0y] : [n.mvL1x, n.mvL1y];
  }

  private predictAt(
    bx: number,
    by: number,
    width: number,
    list: 0 | 1,
    refIdx: number,
  ): [number, number] {
    const a = this.at(bx - 1, by);
    const b = this.at(bx, by - 1);
    let c = this.at(bx + width, by - 1);
    if (!c.available) c = this.at(bx - 1, by - 1);

    const pick = (m: Neighbour): [number, number, number] =>
      list === 0
        ? [m.refIdxL0, m.mvL0x, m.mvL0y]
        : [m.refIdxL1, m.mvL1x, m.mvL1y];

    let [rA, xA, yA] = pick(a);
    let [rB, xB, yB] = pick(b);
    let [rC, xC, yC] = pick(c);

    // With nothing above, the left neighbour stands in for all three.
    if (!b.available && !c.available && a.available) {
      rB = rA;
      xB = xA;
      yB = yA;
      rC = rA;
      xC = xA;
      yC = yA;
    }

    const matches =
      (rA === refIdx ? 1 : 0) +
      (rB === refIdx ? 1 : 0) +
      (rC === refIdx ? 1 : 0);
    if (matches === 1) {
      if (rA === refIdx) return [xA, yA];
      if (rB === refIdx) return [xB, yB];
      return [xC, yC];
    }
    return [median(xA, xB, xC), median(yA, yB, yC)];
  }
}
