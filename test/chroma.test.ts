import { describe, expect, it } from "vitest";
import {
  convertInterFieldChromaBlocks,
  convertIntraChromaBlock,
  FIELD_SCAN_4X4,
  makeChromaBlockLevels,
} from "../src/h264/chroma.ts";

describe("field chroma conversion", () => {
  it("uses the standard 4x4 field scan", () => {
    expect(FIELD_SCAN_4X4).toEqual([
      0, 4, 1, 8, 12, 5, 9, 2, 6, 13, 10, 3, 7, 14, 11, 15,
    ]);
  });

  it("preserves a constant residual across an MBAFF field pair", () => {
    const levels = new Int16Array(64);
    levels[0] = 12;
    const matrix = new Array<number>(64).fill(16);
    const expected = makeChromaBlockLevels();
    const topField = makeChromaBlockLevels();
    const bottomField = makeChromaBlockLevels();

    convertIntraChromaBlock(levels, matrix, 4, 0, 24, expected, false);
    convertInterFieldChromaBlocks(
      levels,
      levels,
      matrix,
      4,
      4,
      0,
      24,
      topField,
    );
    convertInterFieldChromaBlocks(
      levels,
      levels,
      matrix,
      4,
      4,
      1,
      24,
      bottomField,
    );

    expect(topField).toEqual(expected);
    expect(bottomField).toEqual(expected);
  });

  it("emits no coefficients for absent source residuals", () => {
    const out = makeChromaBlockLevels();
    convertInterFieldChromaBlocks(
      null,
      null,
      new Array<number>(64).fill(16),
      4,
      4,
      0,
      24,
      out,
    );

    expect(out.anyDc).toBe(false);
    expect(out.anyAc).toBe(false);
  });
});
