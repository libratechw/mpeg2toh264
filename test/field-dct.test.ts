import { describe, expect, it } from "vitest";
import { fieldDctToFrameTargets } from "../src/h264/quant.ts";

describe("fieldDctToFrameTargets", () => {
  it("keeps a constant residual constant in both frame blocks", () => {
    const first = new Float64Array(64);
    const second = new Float64Array(64);
    const upper = new Float64Array(64);
    const lower = new Float64Array(64);
    first[0] = 320;
    second[0] = 320;

    fieldDctToFrameTargets(first, second, upper, lower);

    expect(upper[0]).toBeCloseTo(320, 10);
    expect(lower[0]).toBeCloseTo(320, 10);
    for (let i = 1; i < 64; i++) {
      expect(upper[i]).toBeCloseTo(0, 10);
      expect(lower[i]).toBeCloseTo(0, 10);
    }
  });

  it("preserves coefficient energy across the orthonormal basis change", () => {
    const first = Float64Array.from(
      { length: 64 },
      (_, i) => ((i * 37) % 29) - 14,
    );
    const second = Float64Array.from(
      { length: 64 },
      (_, i) => ((i * 19) % 31) - 15,
    );
    const upper = new Float64Array(64);
    const lower = new Float64Array(64);

    fieldDctToFrameTargets(first, second, upper, lower);

    const energy = (a: Float64Array) =>
      a.reduce((sum, value) => sum + value * value, 0);
    expect(energy(upper) + energy(lower)).toBeCloseTo(
      energy(first) + energy(second),
      8,
    );
  });
});
