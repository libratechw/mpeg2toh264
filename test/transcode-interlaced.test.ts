import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeStats, resetDecodeStats } from "../src/mpeg2/macroblock.ts";
import { transcode } from "../src/transcode.ts";

describe("interlaced frame-picture transcoding", () => {
  it("converts field-DCT and field-motion macroblocks instead of rejecting them", () => {
    const source = new Uint8Array(readFileSync("test/fixtures/hd1080i.m2v"));
    resetDecodeStats();

    const result = transcode(source);

    expect(result.picturesConverted).toBeGreaterThan(0);
    expect(result.bitstream.length).toBeGreaterThan(0);
    expect(decodeStats.dctTypeField).toBeGreaterThan(0);
    expect(decodeStats.motionField).toBeGreaterThan(0);
  });
});
