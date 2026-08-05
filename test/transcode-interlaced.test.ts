import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BitReader } from "../src/bitreader.ts";
import {
  decodeSlice,
  decodeStats,
  MotionType,
  resetDecodeStats,
} from "../src/mpeg2/macroblock.ts";
import { MBFlag, PictureType } from "../src/mpeg2/constants.ts";
import { parseElementaryStream } from "../src/mpeg2/headers.ts";
import { transcode } from "../src/transcode.ts";

describe("interlaced frame-picture transcoding", () => {
  it("converts field-DCT and field-motion macroblocks in one slice per picture", () => {
    const source = new Uint8Array(readFileSync("testdata/hd1080i.m2v"));
    resetDecodeStats();

    const result = transcode(source);

    expect(result.picturesConverted).toBeGreaterThan(0);
    expect(result.bitstream.length).toBeGreaterThan(0);
    expect(decodeStats.dctTypeField).toBeGreaterThan(0);
    expect(decodeStats.motionField).toBeGreaterThan(0);
    const nalTypes: number[] = [];
    for (let i = 0; i + 3 < result.bitstream.length; i++) {
      if (
        result.bitstream[i] === 0 &&
        result.bitstream[i + 1] === 0 &&
        result.bitstream[i + 2] === 1
      ) {
        nalTypes.push(result.bitstream[i + 3]! & 0x1f);
      }
    }
    expect(nalTypes.filter((type) => type === 1)).toHaveLength(
      result.picturesConverted,
    );
    expect(nalTypes.filter((type) => type === 5)).toHaveLength(1);
  }, 15_000);

  it("can emit only source I pictures", () => {
    const source = new Uint8Array(readFileSync("testdata/hd1080i.m2v"));
    const pictures = parseElementaryStream(source);
    const iPictures = pictures.filter(
      (picture) => picture.header.pictureCodingType === PictureType.I,
    ).length;

    const result = transcode(source, { iFramesOnly: true });

    expect(result.picturesConverted).toBe(iPictures);
    expect(result.picturesSkipped).toBe(pictures.length - iPictures);
    expect(result.bitstream.length).toBeGreaterThan(0);
  });

  it("derives skipped B macroblocks as frame-based PMV predictions", () => {
    const source = new Uint8Array(readFileSync("testdata/hd1080i.m2v"));
    const pictures = parseElementaryStream(source);
    const reader = new BitReader(source);
    const skippedB = pictures.flatMap((picture) =>
      picture.slices.flatMap((slice) =>
        decodeSlice(reader, picture, slice, 90).filter(
          (mb) =>
            mb.skipped && picture.header.pictureCodingType === PictureType.B,
        ),
      ),
    );

    expect(skippedB.length).toBeGreaterThan(0);
    expect(
      skippedB.every((mb) => mb.motionType === MotionType.FRAME_OR_16X8),
    ).toBe(true);
    expect(
      skippedB.some((mb) => mb.mv.some((component) => component !== 0)),
    ).toBe(true);
  });

  it("covers mixed frame/field inter macroblock pairs", () => {
    const source = new Uint8Array(readFileSync("testdata/hd1080i.m2v"));
    const pictures = parseElementaryStream(source);
    const reader = new BitReader(source);
    let mixedPairs = 0;

    for (const picture of pictures) {
      const macroblocks = picture.slices.flatMap((slice) =>
        decodeSlice(reader, picture, slice, 90),
      );
      const byAddress = new Map(macroblocks.map((mb) => [mb.address, mb]));
      for (const mb of macroblocks) {
        if (Math.floor(mb.address / 90) % 2 !== 0) continue;
        const lower = byAddress.get(mb.address + 90);
        if (
          !lower ||
          (mb.flags & MBFlag.INTRA) !== 0 ||
          (lower.flags & MBFlag.INTRA) !== 0
        ) {
          continue;
        }
        if (
          (mb.motionType === MotionType.FIELD) !==
          (lower.motionType === MotionType.FIELD)
        ) {
          mixedPairs++;
        }
      }
    }

    expect(mixedPairs).toBeGreaterThan(0);
  });
});
