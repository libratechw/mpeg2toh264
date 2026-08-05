/**
 * The flat prediction that replaces H.264 intra prediction, checked against a
 * real decoder.
 *
 * The claim being tested is that a reference index carrying weight 0 and
 * offset FLAT_PREDICTION predicts that constant no matter what the reference
 * picture holds. So the reference here is deliberately not flat: it is an
 * I_PCM picture full of a gradient, and the picture predicting from it must
 * still come out uniform.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BitWriter, NalType, toNalUnit } from "../src/h264/bitwriter.ts";
import { writePcmMacroblock } from "../src/h264/mb.ts";
import { frameGeometry, writePps, writeSps } from "../src/h264/params.ts";
import { FLAT_PREDICTION } from "../src/h264/quant.ts";
import { SliceType, writeSliceHeader } from "../src/h264/slice.ts";
import {
  DEFAULT_INTRA_QUANT,
  DEFAULT_NON_INTRA_QUANT,
} from "../src/mpeg2/constants.ts";

const LOG2_MAX_FRAME_NUM = 8;
const LOG2_MAX_POC_LSB = 8;
const PPS_INIT_QP = 26;

/** A macroblock whose samples vary, so leakage from it is unmistakable. */
function gradientMacroblock(mbX: number, mbY: number) {
  const plane = (size: number) =>
    Uint8Array.from(
      { length: size * size },
      (_, i) =>
        (mbX * 37 + mbY * 53 + (i % size) * 3 + Math.floor(i / size) * 5) &
        0xff,
    );
  return { luma: plane(16), cb: plane(8), cr: plane(8) };
}

/**
 * An IDR of gradient I_PCM macroblocks, kept as the long-term picture, then a
 * fully skipped picture predicting from it through the flat index.
 */
function buildStream(
  width: number,
  height: number,
  mbaff: boolean,
): Uint8Array {
  const g = frameGeometry(width, height, !mbaff);
  const parts: Uint8Array[] = [
    writeSps({
      width,
      height,
      levelIdc: 40,
      frameMbsOnly: !mbaff,
      maxNumRefFrames: 3,
      log2MaxFrameNumMinus4: LOG2_MAX_FRAME_NUM - 4,
      log2MaxPocLsbMinus4: LOG2_MAX_POC_LSB - 4,
    }),
    writePps({
      initQp: PPS_INIT_QP,
      scaling8x8Intra: DEFAULT_INTRA_QUANT,
      scaling8x8Inter: DEFAULT_NON_INTRA_QUANT,
    }),
  ];

  const idr = new BitWriter(width * height * 2);
  writeSliceHeader(idr, {
    firstMbInSlice: 0,
    sliceType: SliceType.I,
    frameNum: 0,
    log2MaxFrameNum: LOG2_MAX_FRAME_NUM,
    picOrderCntLsb: 0,
    log2MaxPocLsb: LOG2_MAX_POC_LSB,
    idr: true,
    reference: true,
    longTermReference: true,
    mbaff,
    sliceQp: PPS_INIT_QP,
    ppsInitQp: PPS_INIT_QP,
    disableDeblockingFilterIdc: 1,
  });
  for (let position = 0; position < g.mbWidth * g.mbHeight; position++) {
    const pairAddress = position >> 1;
    const mbX = mbaff ? pairAddress % g.mbWidth : position % g.mbWidth;
    const mbY = mbaff
      ? Math.floor(pairAddress / g.mbWidth) * 2 + (position & 1)
      : Math.floor(position / g.mbWidth);
    if (mbaff && mbY % 2 === 0) idr.flag(0); // frame-coded macroblock pair
    writePcmMacroblock(idr, "I", gradientMacroblock(mbX, mbY));
  }
  idr.rbspTrailingBits();
  parts.push(toNalUnit(idr.bytes(), 3, NalType.SLICE_IDR));

  const skipped = new BitWriter(256);
  writeSliceHeader(skipped, {
    firstMbInSlice: 0,
    sliceType: SliceType.P,
    frameNum: 1,
    log2MaxFrameNum: LOG2_MAX_FRAME_NUM,
    picOrderCntLsb: 1,
    log2MaxPocLsb: LOG2_MAX_POC_LSB,
    idr: false,
    reference: false,
    mbaff,
    sliceQp: PPS_INIT_QP,
    ppsInitQp: PPS_INIT_QP,
    disableDeblockingFilterIdc: 1,
    numRefIdxL0Active: 1,
    flatPredRefIdx: 0,
  });
  skipped.ue(g.mbWidth * g.mbHeight); // mb_skip_run
  skipped.rbspTrailingBits();
  parts.push(toNalUnit(skipped.bytes(), 0, NalType.SLICE_NON_IDR));

  let total = 0;
  for (const part of parts) total += part.length;
  const stream = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    stream.set(part, at);
    at += part.length;
  }
  return stream;
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Decode with ffmpeg and return the raw yuv420p samples of every frame. */
function decode(stream: Uint8Array): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "flat-"));
  try {
    const inPath = join(dir, "in.h264");
    const outPath = join(dir, "out.yuv");
    writeFileSync(inPath, stream);
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        inPath,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuv420p",
        outPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return new Uint8Array(readFileSync(outPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("flat prediction from a zero weight", () => {
  const ffmpeg = hasFfmpeg();

  const check = (width: number, height: number, mbaff: boolean) => {
    const frameSize = (width * height * 3) / 2;
    const samples = decode(buildStream(width, height, mbaff));
    expect(samples.length).toBe(frameSize * 2);
    // The gradient must survive in the reference, or the second frame proves
    // nothing about the weights.
    expect(new Set(samples.subarray(0, frameSize)).size).toBeGreaterThan(1);
    expect(new Set(samples.subarray(frameSize))).toEqual(
      new Set([FLAT_PREDICTION]),
    );
  };

  it.runIf(ffmpeg)("predicts a constant when progressive", () => {
    check(352, 288, false);
  });

  it.runIf(ffmpeg)("predicts a constant under MBAFF", () => {
    check(1440, 1080, true);
  });

  it.runIf(ffmpeg)("predicts a constant at a size needing cropping", () => {
    // 1080 is not a multiple of 16, so this exercises the crop path too.
    check(1440, 1080, false);
  });
});
