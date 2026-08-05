import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeStats, resetDecodeStats } from "../src/mpeg2/macroblock.ts";
import { PictureType } from "../src/mpeg2/constants.ts";
import { parseElementaryStream } from "../src/mpeg2/headers.ts";
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

  it("can emit only source I pictures", () => {
    const source = new Uint8Array(readFileSync("test/fixtures/hd1080i.m2v"));
    const pictures = parseElementaryStream(source);
    const iPictures = pictures.filter(
      (picture) => picture.header.pictureCodingType === PictureType.I,
    ).length;

    const result = transcode(source, { iFramesOnly: true });

    expect(result.picturesConverted).toBe(iPictures);
    expect(result.picturesSkipped).toBe(pictures.length - iPictures);
    expect(result.bitstream.length).toBeGreaterThan(0);
  });
});
