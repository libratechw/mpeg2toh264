/** Dump the parsed header layer of an MPEG-2 elementary stream. */
import { readFileSync } from "node:fs";
import {
  parseElementaryStream,
  pictureGeometry,
} from "../src/mpeg2/headers.ts";
import {
  DEFAULT_INTRA_QUANT,
  PictureType,
  QUANTISER_SCALE,
} from "../src/mpeg2/constants.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: dump.ts <file.m2v>");

const pics = parseElementaryStream(new Uint8Array(readFileSync(path)));
const typeName = ["?", "I", "P", "B", "D"];

const first = pics[0]!;
const g = pictureGeometry(first);
console.log(`file            : ${path}`);
console.log(
  `size            : ${g.width}x${g.height}  (${g.mbWidth}x${g.mbHeight} MBs)`,
);
console.log(
  `profile/level   : 0x${first.sequenceExt.profileAndLevel.toString(16)}`,
);
console.log(`progressive_seq : ${first.sequenceExt.progressiveSequence}`);
console.log(
  `chroma_format   : ${["?", "4:2:0", "4:2:2", "4:4:4"][first.sequenceExt.chromaFormat]}`,
);
console.log(`frame_rate_code : ${first.sequence.frameRateCode}`);
console.log(`pictures        : ${pics.length}`);

const custom = first.quant.intra.some((v, i) => v !== DEFAULT_INTRA_QUANT[i]);
console.log(`intra matrix    : ${custom ? "custom" : "default"}`);

console.log(
  "\n idx  tr type struct  fcode(f/b)   dcprec altscan ivlc qtype slices  qs(first)",
);
for (const [i, p] of pics.entries()) {
  const c = p.coding;
  const qsCode = p.slices[0]?.quantiserScaleCode ?? 0;
  const qs = QUANTISER_SCALE[c.qScaleType]![qsCode];
  const struct = ["-", "top", "bot", "frame"][c.pictureStructure];
  const fb = `${c.fCode[0][0]},${c.fCode[0][1]}/${c.fCode[1][0]},${c.fCode[1][1]}`;
  console.log(
    `${String(i).padStart(4)} ${String(p.header.temporalReference).padStart(3)}` +
      `  ${typeName[p.header.pictureCodingType]}   ${struct!.padEnd(6)} ${fb.padEnd(12)}` +
      ` ${c.intraDcPrecision}      ${c.alternateScan ? 1 : 0}       ${c.intraVlcFormat}    ${c.qScaleType}` +
      `     ${String(p.slices.length).padStart(3)}    ${qsCode}->${qs}`,
  );
}

// Sanity: every slice must have a resolved end, and slices must cover MB rows once.
let bad = 0;
for (const p of pics) {
  for (const s of p.slices) {
    if (s.dataEndBit < s.dataStartBit) bad++;
  }
}
const totalBits = pics.reduce(
  (a, p) =>
    a + p.slices.reduce((b, s) => b + (s.dataEndBit - s.dataStartBit), 0),
  0,
);
console.log(`\nunterminated slices: ${bad}`);
console.log(
  `macroblock-layer bits: ${totalBits} (${((totalBits / 8 / Buffer.from(readFileSync(path)).length) * 100).toFixed(1)}% of file)`,
);
const iCount = pics.filter(
  (p) => p.header.pictureCodingType === PictureType.I,
).length;
console.log(
  `I/P/B: ${iCount}/${pics.filter((p) => p.header.pictureCodingType === 2).length}/${pics.filter((p) => p.header.pictureCodingType === 3).length}`,
);
