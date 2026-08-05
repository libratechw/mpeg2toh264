/**
 * Self-check for the macroblock layer.
 *
 * The decoder has no independent oracle, but the bitstream constrains it hard:
 * a slice must consume exactly its bit range (up to byte-alignment stuffing),
 * and its macroblocks must exactly tile the picture. A single wrong VLC table
 * entry desynchronises the bit position and both checks fail loudly.
 */
import { readFileSync } from "node:fs";
import { BitReader } from "../src/bitreader.ts";
import {
  parseElementaryStream,
  pictureGeometry,
} from "../src/mpeg2/headers.ts";
import {
  decodeSlice,
  decodeStats,
  resetDecodeStats,
} from "../src/mpeg2/macroblock.ts";
import { MBFlag } from "../src/mpeg2/constants.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("usage: verify-mb.ts <file.m2v> [...]");

const typeName = ["?", "I", "P", "B", "D"];
let anyFailure = false;

for (const path of paths) {
  const data = new Uint8Array(readFileSync(path));
  const pics = parseElementaryStream(data);
  const r = new BitReader(data);
  resetDecodeStats();

  let slicesOk = 0;
  let sliceFail = 0;
  let truncated = 0;
  const endOfBuffer = data.length * 8;
  let mbTotal = 0;
  let coeffTotal = 0;
  let skipped = 0;
  let intra = 0;
  const gapHistogram = new Map<number, number>();
  const failures: string[] = [];

  for (const [pi, pic] of pics.entries()) {
    const g = pictureGeometry(pic);
    let mbInPicture = 0;

    for (const slice of pic.slices) {
      try {
        const mbs = decodeSlice(r, pic, slice, g.mbWidth);
        const gap = slice.dataEndBit - r.bitPos;
        // Anything left must be zero padding out to the next start code.
        const padOk = gap >= 0 && gap < 32 && r.peek(Math.min(gap, 24)) === 0;
        if (!padOk) {
          sliceFail++;
          if (failures.length < 6) {
            failures.push(
              `pic ${pi} (${typeName[pic.header.pictureCodingType]}) slice at row ` +
                `${slice.verticalPosition}: ${gap} bits left over`,
            );
          }
          continue;
        }
        gapHistogram.set(gap, (gapHistogram.get(gap) ?? 0) + 1);
        slicesOk++;
        mbInPicture += mbs.length;
        for (const mb of mbs) {
          mbTotal++;
          if (mb.skipped) skipped++;
          if (mb.flags & MBFlag.INTRA) intra++;
          for (const b of mb.blocks) {
            if (b) for (const v of b) if (v !== 0) coeffTotal++;
          }
        }
      } catch (e) {
        // A stream cut mid-picture leaves a partial final slice. That is normal
        // for any extract or live feed, so it is not counted as a failure.
        if (slice.dataEndBit >= endOfBuffer) {
          truncated++;
          continue;
        }
        sliceFail++;
        if (failures.length < 6) {
          failures.push(
            `pic ${pi} (${typeName[pic.header.pictureCodingType]}) slice at row ` +
              `${slice.verticalPosition}: ${(e as Error).message}`,
          );
        }
      }
    }

    const expect = g.mbWidth * g.mbHeight;
    if (mbInPicture !== expect && sliceFail === 0 && truncated === 0) {
      failures.push(
        `pic ${pi}: ${mbInPicture} macroblocks, expected ${expect}`,
      );
      anyFailure = true;
    }
  }

  const total = slicesOk + sliceFail;
  const status = sliceFail === 0 ? "PASS" : "FAIL";
  if (sliceFail > 0) anyFailure = true;
  console.log(`\n${status}  ${path}`);
  console.log(
    `  slices        : ${slicesOk}/${total} decoded to the exact bit` +
      (truncated ? `  (+${truncated} truncated at end of stream)` : ""),
  );
  console.log(
    `  macroblocks   : ${mbTotal}  (intra ${intra}, skipped ${skipped})`,
  );
  console.log(`  nonzero coeffs: ${coeffTotal}`);
  const gaps = [...gapHistogram.entries()].sort((a, b) => a[0] - b[0]);
  console.log(
    `  trailing bits : ${gaps.map(([k, v]) => `${k}:${v}`).join(" ")}`,
  );
  const cov = Object.entries(decodeStats)
    .map(([k, v]) => `${v > 0 ? "+" : "-"}${k}=${v}`)
    .join(" ");
  console.log(`  paths taken   : ${cov}`);
  for (const f of failures) console.log(`  ! ${f}`);
}

process.exit(anyFailure ? 1 : 0);
