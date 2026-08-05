import { describe, expect, it } from "vitest";
import { MotionField, type MbMotion } from "../src/h264/mvpred.ts";

const motion = (x: number, y: number): MbMotion => ({
  refIdxL0: 0,
  refIdxL1: -1,
  mvL0x: x,
  mvL0y: y,
  mvL1x: 0,
  mvL1y: 0,
});

describe("16x8 motion prediction", () => {
  it("keeps the two left-hand partition vectors distinct", () => {
    const field = new MotionField(2, 1);
    field.set16x8(0, 0, 0, motion(4, 8));
    field.set16x8(0, 0, 1, motion(12, 16));

    expect(field.predict16x8(1, 0, 0, 0, 0)).toEqual([4, 8]);
    expect(field.predict16x8(1, 0, 1, 0, 0)).toEqual([12, 16]);
  });
});
