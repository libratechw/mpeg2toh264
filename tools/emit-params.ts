/**
 * Emit an H.264 SPS + PPS derived from an MPEG-2 stream's sequence header, so
 * a real H.264 parser can be pointed at the result.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseElementaryStream } from "../src/mpeg2/headers.ts";
import { frameGeometry, writePps, writeSps } from "../src/h264/params.ts";

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error("usage: emit-params.ts <in.m2v> <out.h264>");

const pics = parseElementaryStream(new Uint8Array(readFileSync(input)));
const first = pics[0]!;
const width = first.sequence.horizontalSize;
const height = first.sequence.verticalSize;
// An interlaced source needs MBAFF, because MPEG-2 frame pictures mix frame-DCT
// and field-DCT macroblocks within one picture.
const interlaced = !first.sequenceExt.progressiveSequence;
const frameMbsOnly = !interlaced;

// Level 4.0 covers 1440x1080 at 30i; smaller pictures fit comfortably below it.
const levelIdc = width * height > 720 * 576 ? 40 : 30;

const sps = writeSps({
  width,
  height,
  levelIdc,
  frameMbsOnly,
  // Two MPEG-2 references plus the long-term picture that carries the
  // flat-prediction weights, with headroom.
  maxNumRefFrames: 4,
  log2MaxFrameNumMinus4: 4,
  log2MaxPocLsbMinus4: 4,
});

// MPEG-2's quantiser matrices go straight into the 8x8 scaling lists: both
// formats treat 16 as unity, so no rescaling is expected here. The exact
// constant is confirmed when coefficient levels are actually mapped.
const pps = writePps({
  initQp: 26,
  scaling8x8Intra: first.quant.intra,
  scaling8x8Inter: first.quant.nonIntra,
});

const out = new Uint8Array(sps.length + pps.length);
out.set(sps, 0);
out.set(pps, sps.length);
writeFileSync(output, out);

const g = frameGeometry(width, height, frameMbsOnly);
console.log(`source     : ${input}`);
console.log(
  `size       : ${width}x${height}  ${interlaced ? "interlaced (MBAFF)" : "progressive"}`,
);
console.log(`macroblocks: ${g.mbWidth}x${g.mbHeight}, ${g.mapUnits} map units`);
console.log(
  `cropping   : right ${g.cropRight} bottom ${g.cropBottom} (units ${g.cropUnitX}x${g.cropUnitY})`,
);
console.log(`level_idc  : ${levelIdc}`);
console.log(
  `wrote      : ${output}  (SPS ${sps.length} B, PPS ${pps.length} B)`,
);
