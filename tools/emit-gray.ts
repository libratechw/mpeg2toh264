/**
 * Emit SPS + PPS + the all-grey long-term reference IDR, so a real decoder can
 * be asked whether it really reconstructs to uniform 128.
 */
import { writeFileSync } from "node:fs";
import { frameGeometry, writePps, writeSps } from "../src/h264/params.ts";
import { writeGrayIdr } from "../src/h264/grayframe.ts";
import {
  DEFAULT_INTRA_QUANT,
  DEFAULT_NON_INTRA_QUANT,
} from "../src/mpeg2/constants.ts";

const width = Number(process.argv[2] ?? 352);
const height = Number(process.argv[3] ?? 288);
const interlaced = process.argv[4] === "interlaced";
const output = process.argv[5] ?? "gray.h264";

const frameMbsOnly = !interlaced;
const log2MaxFrameNumMinus4 = 4;
const log2MaxPocLsbMinus4 = 4;
const ppsInitQp = 26;

const g = frameGeometry(width, height, frameMbsOnly);

const sps = writeSps({
  width,
  height,
  levelIdc: width * height > 720 * 576 ? 40 : 30,
  frameMbsOnly,
  maxNumRefFrames: 4,
  log2MaxFrameNumMinus4,
  log2MaxPocLsbMinus4,
});
const pps = writePps({
  initQp: ppsInitQp,
  scaling8x8Intra: DEFAULT_INTRA_QUANT,
  scaling8x8Inter: DEFAULT_NON_INTRA_QUANT,
});
const gray = writeGrayIdr({
  mbWidth: g.mbWidth,
  mbHeight: g.mbHeight,
  log2MaxFrameNum: log2MaxFrameNumMinus4 + 4,
  log2MaxPocLsb: log2MaxPocLsbMinus4 + 4,
  ppsInitQp,
  mbaff: !frameMbsOnly,
});

const out = new Uint8Array(sps.length + pps.length + gray.length);
out.set(sps, 0);
out.set(pps, sps.length);
out.set(gray, sps.length + pps.length);
writeFileSync(output, out);

const mbs = g.mbWidth * g.mbHeight;
console.log(
  `size      : ${width}x${height} ${interlaced ? "interlaced (MBAFF)" : "progressive"}`,
);
console.log(`macroblocks: ${g.mbWidth}x${g.mbHeight} = ${mbs}`);
console.log(
  `grey IDR  : ${gray.length} bytes  (${((gray.length * 8) / mbs).toFixed(1)} bits/MB)`,
);
console.log(`wrote     : ${output}  (${out.length} bytes total)`);
