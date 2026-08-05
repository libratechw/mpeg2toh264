import { describe, expect, it } from "vitest";
import { BitReader } from "../src/bitreader.ts";
import { BitWriter } from "../src/h264/bitwriter.ts";
import { writeResidualBlock } from "../src/h264/cavlc.ts";
import {
  COEFF_TOKEN,
  RUN_BEFORE,
  TOTAL_ZEROS_4X4,
  TOTAL_ZEROS_CHROMA_DC,
  coeffTokenTableIndex,
} from "../src/h264/cavlc-tables.ts";

/**
 * A decoder written straight from clause 9.2 rather than by inverting the
 * encoder, so that the two agreeing means something. The codeword tables are
 * shared, but the prefix/suffix arithmetic, trailing-one handling and run
 * distribution are independent implementations.
 */
function invert(
  table: Readonly<Record<string | number, string>>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const [value, code] of Object.entries(table)) m.set(code, String(value));
  return m;
}

/** Read the shortest codeword present in `codes` starting at the reader. */
function readCode(r: BitReader, codes: Map<string, string>): string {
  let bits = "";
  for (let n = 0; n < 32; n++) {
    bits += r.u(1) === 1 ? "1" : "0";
    const hit = codes.get(bits);
    if (hit !== undefined) return hit;
  }
  throw new Error(`no codeword matched ${bits}`);
}

function decodeBlock(r: BitReader, nC: number, maxNumCoeff: number): number[] {
  const tokenTable = invert(COEFF_TOKEN[coeffTokenTableIndex(nC)]!);
  const key = readCode(r, tokenTable); // "trailingOnes,totalCoeff"
  const [trailingOnes, totalCoeff] = key.split(",").map(Number) as [
    number,
    number,
  ];

  const out = new Array<number>(maxNumCoeff).fill(0);
  if (totalCoeff === 0) return out;

  const levelVal: number[] = [];
  for (let i = 0; i < trailingOnes; i++) {
    levelVal.push(1 - 2 * r.u(1));
  }

  let suffixLength = totalCoeff > 10 && trailingOnes < 3 ? 1 : 0;
  for (let i = trailingOnes; i < totalCoeff; i++) {
    let levelPrefix = 0;
    while (r.u(1) === 0) levelPrefix++;

    let levelSuffixSize = suffixLength;
    if (levelPrefix === 14 && suffixLength === 0) levelSuffixSize = 4;
    else if (levelPrefix >= 15) levelSuffixSize = levelPrefix - 3;

    let levelCode = Math.min(15, levelPrefix) << suffixLength;
    if (levelSuffixSize > 0) levelCode += r.u(levelSuffixSize);
    if (levelPrefix >= 15 && suffixLength === 0) levelCode += 15;
    if (levelPrefix >= 16) levelCode += (1 << (levelPrefix - 3)) - 4096;
    if (i === trailingOnes && trailingOnes < 3) levelCode += 2;

    const level =
      levelCode % 2 === 0 ? (levelCode + 2) >> 1 : (-levelCode - 1) >> 1;
    levelVal.push(level);

    if (suffixLength === 0) suffixLength = 1;
    if (Math.abs(level) > 3 << (suffixLength - 1) && suffixLength < 6)
      suffixLength++;
  }

  let zerosLeft = 0;
  if (totalCoeff < maxNumCoeff) {
    const table =
      maxNumCoeff === 4
        ? TOTAL_ZEROS_CHROMA_DC[totalCoeff - 1]!
        : TOTAL_ZEROS_4X4[totalCoeff - 1]!;
    zerosLeft = Number(readCode(r, invert(table)));
  }

  const runVal = new Array<number>(totalCoeff).fill(0);
  for (let i = 0; i < totalCoeff - 1; i++) {
    if (zerosLeft > 0) {
      const table = RUN_BEFORE[Math.min(zerosLeft, 7) - 1]!;
      runVal[i] = Number(readCode(r, invert(table)));
    }
    zerosLeft -= runVal[i]!;
  }
  runVal[totalCoeff - 1] = zerosLeft;

  let coeffNum = -1;
  for (let k = 0, i = totalCoeff - 1; k < totalCoeff; k++, i--) {
    coeffNum += runVal[i]! + 1;
    out[coeffNum] = levelVal[i]!;
  }
  return out;
}

function roundTrip(
  levels: number[],
  nC: number,
  maxNumCoeff = levels.length,
): number[] {
  const w = new BitWriter(256);
  writeResidualBlock(w, { levels, maxNumCoeff, nC });
  w.rbspTrailingBits();
  return decodeBlock(new BitReader(w.bytes()), nC, maxNumCoeff);
}

/** Deterministic PRNG so a failure can be reproduced. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("CAVLC residual blocks round-trip", () => {
  it("handles an empty block", () => {
    expect(roundTrip(new Array(16).fill(0), 0)).toEqual(new Array(16).fill(0));
  });

  it("handles a lone DC coefficient", () => {
    const levels = new Array(16).fill(0);
    levels[0] = 7;
    expect(roundTrip(levels, 0)).toEqual(levels);
  });

  it("handles a full block with no zeros", () => {
    const levels = Array.from({ length: 16 }, (_, i) =>
      i % 2 ? -(i + 1) : i + 1,
    );
    expect(roundTrip(levels, 0)).toEqual(levels);
  });

  for (const t1 of [0, 1, 2, 3]) {
    it(`handles exactly ${t1} trailing ones`, () => {
      const levels = new Array(16).fill(0);
      levels[0] = 5;
      levels[1] = -9;
      for (let i = 0; i < t1; i++) levels[2 + i] = i % 2 ? -1 : 1;
      // A level of magnitude above one after them, so the count is exactly t1.
      if (t1 < 3) levels[2 + t1] = 4;
      expect(roundTrip(levels, 0)).toEqual(levels);
    });
  }

  it("handles levels large enough to need the escape", () => {
    for (const big of [16, 100, 1000, 2047, -2047, -1000, -16]) {
      const levels = new Array(16).fill(0);
      levels[0] = big;
      expect(roundTrip(levels, 0)[0]).toBe(big);
    }
  });

  it("handles levels needing level_prefix past 15", () => {
    // level_prefix 15 tops out around levelCode 4125, i.e. a level of ~2063.
    // High profile at 8 bits permits prefixes above that, and a finely
    // quantised transcode reaches them.
    for (const big of [2064, 3000, 6158, -6158, 12000, -12000, 32767, -32767]) {
      const levels = new Array(16).fill(0);
      levels[3] = big;
      expect(roundTrip(levels, 0)[3], `level ${big}`).toBe(big);
    }
  });

  it("handles levels that escalate suffixLength", () => {
    // Rising magnitudes push suffixLength up through its range.
    const levels = [
      2, 5, 9, 17, 33, 65, 129, 257, 513, 1025, 2047, 0, 0, 0, 0, 0,
    ];
    expect(roundTrip(levels, 0)).toEqual(levels);
  });

  it("round-trips across every nC table", () => {
    for (const nC of [0, 1, 2, 3, 4, 7, 8, 20]) {
      const levels = new Array(16).fill(0);
      levels[0] = 3;
      levels[5] = -1;
      levels[9] = 1;
      expect(roundTrip(levels, nC)).toEqual(levels);
    }
  });

  it("round-trips a 4:2:0 chroma DC block", () => {
    for (const levels of [
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [-3, 2, 0, 1],
      [5, -5, 5, -5],
    ]) {
      expect(roundTrip(levels, -1, 4)).toEqual(levels);
    }
  });

  it("round-trips a 15-coefficient AC block", () => {
    const levels = new Array(15).fill(0);
    levels[0] = -2;
    levels[7] = 1;
    levels[14] = -1;
    expect(roundTrip(levels, 2, 15)).toEqual(levels);
  });

  it("round-trips random blocks", () => {
    const rand = mulberry32(0x5eed);
    for (let trial = 0; trial < 3000; trial++) {
      const maxNumCoeff = [16, 15, 4][trial % 3]!;
      const nC = maxNumCoeff === 4 ? -1 : Math.floor(rand() * 10);
      const levels = new Array(maxNumCoeff).fill(0);
      const density = rand();
      for (let i = 0; i < maxNumCoeff; i++) {
        if (rand() > density) continue;
        // Mostly small levels, occasionally large ones, as real residuals go.
        const mag =
          rand() < 0.75
            ? 1 + Math.floor(rand() * 3)
            : 1 + Math.floor(rand() * 600);
        levels[i] = rand() < 0.5 ? -mag : mag;
      }
      expect(roundTrip(levels, nC, maxNumCoeff), `trial ${trial}`).toEqual(
        levels,
      );
    }
  });
});
