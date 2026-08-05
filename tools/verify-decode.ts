/**
 * Validate the MPEG-2 front end by decoding with it and comparing against
 * ffmpeg.
 *
 * The macroblock layer has so far only been checked for consuming exactly the
 * right number of bits, which says nothing about whether the values it produces
 * are right. Reconstructing actual pictures from them and comparing samples
 * tests everything at once: motion vectors and their predictors, prediction
 * modes, coefficient values, dequantisation and scan order. Anything wrong
 * shows up as a mismatch, and which pictures mismatch says where.
 *
 * This is a reference decoder for checking, not part of the transcoder -- the
 * whole point of the transcoder is to avoid doing any of this.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BitReader } from "../src/bitreader.ts";
import {
  MBFlag,
  PictureType,
  QUANTISER_SCALE,
} from "../src/mpeg2/constants.ts";
import {
  parseElementaryStream,
  pictureGeometry,
  type Picture,
} from "../src/mpeg2/headers.ts";
import { decodeSlice, type Macroblock } from "../src/mpeg2/macroblock.ts";
import { idct8 } from "../src/h264/chroma.ts";

const input = process.argv[2];
if (!input) throw new Error("usage: verify-decode.ts <in.m2v>");

interface Frame {
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
  /** Position in display order, with each group's temporal_reference rebased. */
  displayIndex: number;
}

const data = new Uint8Array(readFileSync(input));
const pics = parseElementaryStream(data);
const first = pics[0]!;
const width = first.sequence.horizontalSize;
const height = first.sequence.verticalSize;
const cw = width >> 1;
const ch = height >> 1;
const g = pictureGeometry(first);

function makeFrame(displayIndex: number): Frame {
  return {
    y: new Uint8Array(width * height),
    cb: new Uint8Array(cw * ch),
    cr: new Uint8Array(cw * ch),
    displayIndex,
  };
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * MPEG-2 prediction, clause 7.6.4. Vectors are in half samples; a component
 * with its low bit set reads midway between samples, by plain bilinear average.
 */
function predict(
  ref: Uint8Array,
  w: number,
  h: number,
  px: number,
  py: number,
  bw: number,
  bh: number,
  mvx: number,
  mvy: number,
  out: Float64Array,
): void {
  const ix = mvx >> 1;
  const iy = mvy >> 1;
  const hx = mvx & 1;
  const hy = mvy & 1;
  const at = (x: number, y: number) => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return ref[cy * w + cx]!;
  };
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const sx = px + x + ix;
      const sy = py + y + iy;
      let v: number;
      if (hx && hy) {
        v =
          (at(sx, sy) +
            at(sx + 1, sy) +
            at(sx, sy + 1) +
            at(sx + 1, sy + 1) +
            2) >>
          2;
      } else if (hx) {
        v = (at(sx, sy) + at(sx + 1, sy) + 1) >> 1;
      } else if (hy) {
        v = (at(sx, sy) + at(sx, sy + 1) + 1) >> 1;
      } else {
        v = at(sx, sy);
      }
      out[y * bw + x] = v;
    }
  }
}

const coeff = new Float64Array(64);
const samples = new Float64Array(64);
const predA = new Float64Array(256);
const predB = new Float64Array(256);

/** Dequantise one block into orthonormal-DCT coefficients (clause 7.4). */
function dequantise(
  levels: Int16Array,
  weight: readonly number[],
  qs: number,
  intra: boolean,
  intraDcPrecision: number,
): void {
  if (intra) {
    coeff[0] = (8 >> intraDcPrecision) * levels[0]!;
    for (let i = 1; i < 64; i++) {
      const l = levels[i]!;
      coeff[i] = l === 0 ? 0 : Math.trunc((2 * l * weight[i]! * qs) / 32);
    }
  } else {
    for (let i = 0; i < 64; i++) {
      const l = levels[i]!;
      if (l === 0) {
        coeff[i] = 0;
        continue;
      }
      const sign = l < 0 ? -1 : 1;
      coeff[i] = Math.trunc(((2 * l + sign) * weight[i]! * qs) / 32);
    }
  }
}

/** Add a decoded block into a plane, on top of whatever prediction is there. */
function addBlock(
  plane: Uint8Array,
  planeW: number,
  px: number,
  py: number,
  pred: Float64Array | null,
  predStride: number,
  predOffset: number,
): void {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const base = pred ? pred[predOffset + y * predStride + x]! : 0;
      plane[(py + y) * planeW + px + x] = clamp(
        Math.round(base + samples[y * 8 + x]!),
      );
    }
  }
}

let past: Frame | null = null;
let future: Frame | null = null;
const decoded: Frame[] = [];
const reader = new BitReader(data);

// temporal_reference restarts at every group of pictures, so display order
// needs the group's base added back on.
let gopBase = 0;
let maxTrInGop = 0;
let seenPicture = false;

for (const pic of pics) {
  const type = pic.header.pictureCodingType;
  if (pic.startsGop && seenPicture) {
    gopBase += maxTrInGop + 1;
    maxTrInGop = 0;
  }
  seenPicture = true;
  maxTrInGop = Math.max(maxTrInGop, pic.header.temporalReference);
  const frame = makeFrame(gopBase + pic.header.temporalReference);
  const mbs = new Map<number, Macroblock>();
  for (const slice of pic.slices) {
    for (const mb of decodeSlice(reader, pic, slice, g.mbWidth))
      mbs.set(mb.address, mb);
  }

  // Forward prediction comes from the older reference, backward from the newer.
  const fwdRef = type === PictureType.B ? past : future;
  const bwdRef = type === PictureType.B ? future : null;

  for (let mbY = 0; mbY < g.mbHeight; mbY++) {
    for (let mbX = 0; mbX < g.mbWidth; mbX++) {
      const mb = mbs.get(mbY * g.mbWidth + mbX);
      const intra = mb ? (mb.flags & MBFlag.INTRA) !== 0 : false;
      const px = mbX * 16;
      const py = mbY * 16;
      const qs = mb
        ? QUANTISER_SCALE[pic.coding.qScaleType]![mb.quantiserScaleCode]!
        : 1;

      let lumaPred: Float64Array | null = null;
      let cbPred: Float64Array | null = null;
      let crPred: Float64Array | null = null;

      if (!intra) {
        const useFwd =
          !mb || (mb.flags & MBFlag.MOTION_FORWARD) !== 0 || !bwdRef;
        const useBwd = mb
          ? (mb.flags & MBFlag.MOTION_BACKWARD) !== 0 && !!bwdRef
          : false;
        const fx = mb ? mb.mv[0]! : 0;
        const fy = mb ? mb.mv[1]! : 0;
        const bx = mb ? mb.mv[2]! : 0;
        const by = mb ? mb.mv[3]! : 0;

        // Chroma vectors are the luma ones halved, truncating toward zero
        // (clause 7.6.3.7).
        const half = (v: number) =>
          v < 0 ? -Math.trunc(-v / 2) : Math.trunc(v / 2);

        const both = useFwd && useBwd;
        for (const which of ["y", "cb", "cr"] as const) {
          const isLuma = which === "y";
          const pw = isLuma ? width : cw;
          const ph = isLuma ? height : ch;
          const bsz = isLuma ? 16 : 8;
          const bx0 = isLuma ? px : px >> 1;
          const by0 = isLuma ? py : py >> 1;
          const mvfx = isLuma ? fx : half(fx);
          const mvfy = isLuma ? fy : half(fy);
          const mvbx = isLuma ? bx : half(bx);
          const mvby = isLuma ? by : half(by);
          const target = new Float64Array(bsz * bsz);

          if (useFwd && fwdRef) {
            const plane = isLuma
              ? fwdRef.y
              : which === "cb"
                ? fwdRef.cb
                : fwdRef.cr;
            predict(plane, pw, ph, bx0, by0, bsz, bsz, mvfx, mvfy, predA);
          }
          if (useBwd && bwdRef) {
            const plane = isLuma
              ? bwdRef.y
              : which === "cb"
                ? bwdRef.cb
                : bwdRef.cr;
            predict(plane, pw, ph, bx0, by0, bsz, bsz, mvbx, mvby, predB);
          }
          for (let i = 0; i < bsz * bsz; i++) {
            if (both) target[i] = (predA[i]! + predB[i]! + 1) >> 1;
            else if (useBwd) target[i] = predB[i]!;
            else target[i] = predA[i]!;
          }
          if (isLuma) lumaPred = target;
          else if (which === "cb") cbPred = target;
          else crPred = target;
        }
      }

      // Luma: four 8x8 blocks in raster order within the macroblock.
      for (let b = 0; b < 4; b++) {
        const bx = (b & 1) * 8;
        const by = (b >> 1) * 8;
        const block = mb?.blocks[b];
        if (block) {
          dequantise(
            block,
            intra ? pic.quant.intra : pic.quant.nonIntra,
            qs,
            intra,
            pic.coding.intraDcPrecision,
          );
          idct8(coeff, samples);
        } else {
          samples.fill(0);
        }
        addBlock(frame.y, width, px + bx, py + by, lumaPred, 16, by * 16 + bx);
      }

      for (const [c, plane, target] of [
        [4, frame.cb, cbPred],
        [5, frame.cr, crPred],
      ] as const) {
        const block = mb?.blocks[c];
        if (block) {
          dequantise(
            block,
            intra ? pic.quant.chromaIntra : pic.quant.chromaNonIntra,
            qs,
            intra,
            pic.coding.intraDcPrecision,
          );
          idct8(coeff, samples);
        } else {
          samples.fill(0);
        }
        addBlock(plane, cw, px >> 1, py >> 1, target, 8, 0);
      }
    }
  }

  decoded.push(frame);
  if (type !== PictureType.B) {
    past = future;
    future = frame;
  }
}

// Display order: MPEG-2 codes its anchor pictures ahead of the B pictures that
// belong before them.
decoded.sort((a, b) => a.displayIndex - b.displayIndex);

const dir = mkdtempSync(join(tmpdir(), "verify-decode-"));
try {
  const yuv = join(dir, "ref.yuv");
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", input, "-f", "rawvideo", "-pix_fmt", "yuv420p", yuv],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const ref = new Uint8Array(readFileSync(yuv));
  const frameSize = width * height + 2 * cw * ch;
  const n = Math.min(decoded.length, ref.length / frameSize);

  console.log(`${input}  ${width}x${height}, ${n} frames`);
  console.log("\n  frame   luma PSNR   worst   chroma PSNR   worst");
  let allExact = true;
  for (let f = 0; f < n; f++) {
    const frame = decoded[f]!;
    const base = f * frameSize;
    let sseY = 0;
    let worstY = 0;
    for (let i = 0; i < width * height; i++) {
      const d = frame.y[i]! - ref[base + i]!;
      sseY += d * d;
      if (Math.abs(d) > worstY) worstY = Math.abs(d);
    }
    let sseC = 0;
    let worstC = 0;
    for (let i = 0; i < cw * ch; i++) {
      const d1 = frame.cb[i]! - ref[base + width * height + i]!;
      const d2 = frame.cr[i]! - ref[base + width * height + cw * ch + i]!;
      sseC += d1 * d1 + d2 * d2;
      worstC = Math.max(worstC, Math.abs(d1), Math.abs(d2));
    }
    const psnr = (sse: number, count: number) =>
      sse === 0
        ? "exact"
        : `${(10 * Math.log10((255 * 255 * count) / sse)).toFixed(2)} dB`;
    if (sseY !== 0 || sseC !== 0) allExact = false;
    console.log(
      `  ${String(f).padStart(5)}  ${psnr(sseY, width * height).padStart(10)}  ` +
        `${String(worstY).padStart(6)}  ${psnr(sseC, 2 * cw * ch).padStart(12)}  ${String(worstC).padStart(6)}`,
    );
  }
  console.log(
    allExact
      ? "\nEvery picture matches ffmpeg exactly: the parsed motion vectors, prediction modes and coefficients are all correct."
      : "\nDifferences remain. Small ones are the inverse transform (MPEG-2 does not specify it bit-exactly); large ones are a real disagreement.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
