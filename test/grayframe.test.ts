import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeGrayIdr } from "../src/h264/grayframe.ts";
import { frameGeometry, writePps, writeSps } from "../src/h264/params.ts";
import {
  DEFAULT_INTRA_QUANT,
  DEFAULT_NON_INTRA_QUANT,
} from "../src/mpeg2/constants.ts";

const LOG2_MAX_FRAME_NUM_MINUS4 = 4;
const LOG2_MAX_POC_LSB_MINUS4 = 4;
const PPS_INIT_QP = 26;

function buildStream(
  width: number,
  height: number,
  interlaced: boolean,
  fieldPairs = false,
): Uint8Array {
  const frameMbsOnly = !interlaced;
  const g = frameGeometry(width, height, frameMbsOnly);
  const sps = writeSps({
    width,
    height,
    levelIdc: 40,
    frameMbsOnly,
    maxNumRefFrames: 4,
    log2MaxFrameNumMinus4: LOG2_MAX_FRAME_NUM_MINUS4,
    log2MaxPocLsbMinus4: LOG2_MAX_POC_LSB_MINUS4,
  });
  const pps = writePps({
    initQp: PPS_INIT_QP,
    scaling8x8Intra: DEFAULT_INTRA_QUANT,
    scaling8x8Inter: DEFAULT_NON_INTRA_QUANT,
  });
  const gray = writeGrayIdr({
    mbWidth: g.mbWidth,
    mbHeight: g.mbHeight,
    log2MaxFrameNum: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
    log2MaxPocLsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
    ppsInitQp: PPS_INIT_QP,
    mbaff: interlaced,
    fieldPairs,
  });
  const out = new Uint8Array(sps.length + pps.length + gray.length);
  out.set(sps, 0);
  out.set(pps, sps.length);
  out.set(gray, sps.length + pps.length);
  return out;
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Decode with ffmpeg and return the raw yuv420p samples. */
function decode(stream: Uint8Array, width: number, height: number): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "gray-"));
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

describe("all-grey long-term reference frame", () => {
  const ffmpeg = hasFfmpeg();

  it("costs about a byte per macroblock", () => {
    // I_PCM would be 384 bytes per macroblock; prediction-only is ~8 bits.
    const g = frameGeometry(352, 288, true);
    const gray = writeGrayIdr({
      mbWidth: g.mbWidth,
      mbHeight: g.mbHeight,
      log2MaxFrameNum: 8,
      log2MaxPocLsb: 8,
      ppsInitQp: PPS_INIT_QP,
      mbaff: false,
    });
    const bitsPerMb = (gray.length * 8) / (g.mbWidth * g.mbHeight);
    expect(bitsPerMb).toBeLessThan(12);
  });

  it.runIf(ffmpeg)("decodes to uniform 128 when progressive", () => {
    const samples = decode(buildStream(352, 288, false), 352, 288);
    expect(samples.length).toBe((352 * 288 * 3) / 2);
    // The point of the frame is that prediction is a known constant everywhere,
    // so any sample other than 128 breaks the intra mapping.
    expect(new Set(samples)).toEqual(new Set([128]));
  });

  it.runIf(ffmpeg)("decodes to uniform 128 under MBAFF", () => {
    const samples = decode(buildStream(1440, 1080, true), 1440, 1080);
    expect(samples.length).toBe((1440 * 1080 * 3) / 2);
    expect(new Set(samples)).toEqual(new Set([128]));
  });

  it.runIf(ffmpeg)("decodes field-coded MBAFF pairs to uniform 128", () => {
    const samples = decode(buildStream(1440, 1080, true, true), 1440, 1080);
    expect(samples.length).toBe((1440 * 1080 * 3) / 2);
    expect(new Set(samples)).toEqual(new Set([128]));
  });

  it.runIf(ffmpeg)("decodes to uniform 128 at a size needing cropping", () => {
    // 1080 is not a multiple of 16, so this exercises the crop path too.
    const samples = decode(buildStream(1440, 1080, false), 1440, 1080);
    expect(new Set(samples)).toEqual(new Set([128]));
  });
});
