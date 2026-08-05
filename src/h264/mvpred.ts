/**
 * H.264 motion vector prediction (clause 8.4.1.3).
 *
 * Vectors are coded as differences from a prediction derived from the
 * neighbouring macroblocks, so the encoder has to reproduce that derivation
 * exactly to know what difference to send. Only 16x16 partitions are produced
 * here, which keeps this to the macroblock-level case.
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
  private readonly mbW: number;
  private readonly mbH: number;
  private readonly refIdx: Int8Array;
  private readonly mv: Int32Array;
  private readonly coded: Uint8Array;

  constructor(mbWidth: number, mbHeight: number) {
    this.mbW = mbWidth;
    this.mbH = mbHeight;
    this.refIdx = new Int8Array(mbWidth * mbHeight * 2);
    this.mv = new Int32Array(mbWidth * mbHeight * 4);
    this.coded = new Uint8Array(mbWidth * mbHeight);
  }

  reset(): void {
    this.refIdx.fill(-1);
    this.mv.fill(0);
    this.coded.fill(0);
  }

  set(mbX: number, mbY: number, m: MbMotion): void {
    const i = mbY * this.mbW + mbX;
    this.refIdx[i * 2] = m.refIdxL0;
    this.refIdx[i * 2 + 1] = m.refIdxL1;
    this.mv[i * 4] = m.mvL0x;
    this.mv[i * 4 + 1] = m.mvL0y;
    this.mv[i * 4 + 2] = m.mvL1x;
    this.mv[i * 4 + 3] = m.mvL1y;
    this.coded[i] = 1;
  }

  private at(mbX: number, mbY: number): Neighbour {
    if (mbX < 0 || mbY < 0 || mbX >= this.mbW || mbY >= this.mbH)
      return UNAVAILABLE;
    const i = mbY * this.mbW + mbX;
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
    const a = this.at(mbX - 1, mbY);
    const b = this.at(mbX, mbY - 1);
    let c = this.at(mbX + 1, mbY - 1);
    if (!c.available) c = this.at(mbX - 1, mbY - 1);

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
