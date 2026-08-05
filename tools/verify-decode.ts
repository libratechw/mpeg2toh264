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
import {
  MotionType,
  decodeSlice,
  type Macroblock,
} from "../src/mpeg2/macroblock.ts";
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
const limit = Number(process.argv[3] ?? Infinity);
const allPics = parseElementaryStream(data);
const pics = Number.isFinite(limit) ? allPics.slice(0, limit) : allPics;
const first = pics[0]!;
const width = first.sequence.horizontalSize;
const height = first.sequence.verticalSize;
const g = pictureGeometry(first);
// MPEG-2 codes whole macroblock rows, so 1080 displayed lines are carried as
// 1088 coded ones. Frames must hold the coded size or the bottom row spills.
const codedWidth = g.mbWidth * 16;
const codedHeight = g.mbHeight * 16;
const cw = codedWidth >> 1;
const ch = codedHeight >> 1;

function makeFrame(displayIndex: number): Frame {
  return {
    y: new Uint8Array(codedWidth * codedHeight),
    cb: new Uint8Array(cw * ch),
    cr: new Uint8Array(cw * ch),
    displayIndex,
  };
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Chroma vectors are the luma ones halved, truncating toward zero (clause 7.6.3.7). */
const half = (v: number) => (v < 0 ? -Math.trunc(-v / 2) : Math.trunc(v / 2));

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

/**
 * Field prediction inside a frame picture (clause 7.6.4). Each of the
 * macroblock's two fields is predicted separately from a chosen field of the
 * reference, and the vertical vector counts in field lines rather than frame
 * lines.
 */
function predictField(
  ref: Uint8Array,
  w: number,
  frameH: number,
  px: number,
  pyFrame: number,
  bw: number,
  fieldLines: number,
  mvx: number,
  mvyField: number,
  refFieldParity: number,
  out: Float64Array,
  outParity: number,
  outStride: number,
): void {
  const ix = mvx >> 1;
  const iy = mvyField >> 1;
  const hx = mvx & 1;
  const hy = mvyField & 1;
  const fieldH = frameH >> 1;
  // Reads a sample of the chosen reference field, addressed in field lines.
  const at = (x: number, yField: number) => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = yField < 0 ? 0 : yField >= fieldH ? fieldH - 1 : yField;
    return ref[(2 * cy + refFieldParity) * w + cx]!;
  };
  for (let i = 0; i < fieldLines; i++) {
    for (let x = 0; x < bw; x++) {
      const sx = px + x + ix;
      const sy = (pyFrame >> 1) + i + iy;
      let v: number;
      if (hx && hy)
        v =
          (at(sx, sy) +
            at(sx + 1, sy) +
            at(sx, sy + 1) +
            at(sx + 1, sy + 1) +
            2) >>
          2;
      else if (hx) v = (at(sx, sy) + at(sx + 1, sy) + 1) >> 1;
      else if (hy) v = (at(sx, sy) + at(sx, sy + 1) + 1) >> 1;
      else v = at(sx, sy);
      out[(2 * i + outParity) * outStride + x] = v;
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

const decodedByPic = new Map<Picture, Frame>();
const mbsByPic = new Map<Picture, Map<number, Macroblock>>();
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
  decodedByPic.set(pic, frame);
  const mbs = new Map<number, Macroblock>();
  mbsByPic.set(pic, mbs);
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

        const both = useFwd && useBwd;
        for (const which of ["y", "cb", "cr"] as const) {
          const isLuma = which === "y";
          const pw = isLuma ? codedWidth : cw;
          const ph = isLuma ? codedHeight : ch;
          const bsz = isLuma ? 16 : 8;
          const bx0 = isLuma ? px : px >> 1;
          const by0 = isLuma ? py : py >> 1;
          const mvfx = isLuma ? fx : half(fx);
          const mvfy = isLuma ? fy : half(fy);
          const mvbx = isLuma ? bx : half(bx);
          const mvby = isLuma ? by : half(by);
          const target = new Float64Array(bsz * bsz);

          // Field motion carries two vectors, one per field of the macroblock,
          // each naming which reference field to read.
          const fieldMotion = mb ? mb.motionType === MotionType.FIELD : false;
          if (useFwd && fwdRef) {
            const plane = isLuma
              ? fwdRef.y
              : which === "cb"
                ? fwdRef.cb
                : fwdRef.cr;
            if (fieldMotion && mb) {
              for (let r2 = 0; r2 < 2; r2++) {
                const vx = isLuma ? mb.mv[r2 * 4]! : half(mb.mv[r2 * 4]!);
                const vy = isLuma
                  ? mb.mv[r2 * 4 + 1]!
                  : half(mb.mv[r2 * 4 + 1]!);
                predictField(
                  plane,
                  pw,
                  ph,
                  bx0,
                  by0,
                  bsz,
                  bsz >> 1,
                  vx,
                  vy,
                  mb.fieldSelect[r2 * 2]!,
                  predA,
                  r2,
                  bsz,
                );
              }
            } else {
              predict(plane, pw, ph, bx0, by0, bsz, bsz, mvfx, mvfy, predA);
            }
          }
          if (useBwd && bwdRef) {
            const plane = isLuma
              ? bwdRef.y
              : which === "cb"
                ? bwdRef.cb
                : bwdRef.cr;
            if (fieldMotion && mb) {
              for (let r2 = 0; r2 < 2; r2++) {
                const vx = isLuma
                  ? mb.mv[r2 * 4 + 2]!
                  : half(mb.mv[r2 * 4 + 2]!);
                const vy = isLuma
                  ? mb.mv[r2 * 4 + 3]!
                  : half(mb.mv[r2 * 4 + 3]!);
                predictField(
                  plane,
                  pw,
                  ph,
                  bx0,
                  by0,
                  bsz,
                  bsz >> 1,
                  vx,
                  vy,
                  mb.fieldSelect[r2 * 2 + 1]!,
                  predB,
                  r2,
                  bsz,
                );
              }
            } else {
              predict(plane, pw, ph, bx0, by0, bsz, bsz, mvbx, mvby, predB);
            }
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

      // Luma: four 8x8 blocks. With frame DCT they are the macroblock's
      // quadrants; with field DCT each block holds alternate lines of one
      // field, so blocks 0 and 1 are the top field and 2 and 3 the bottom.
      const fieldDct = mb ? mb.dctType === 1 : false;
      for (let b = 0; b < 4; b++) {
        const bx = (b & 1) * 8;
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
        if (fieldDct) {
          const parity = b >> 1;
          for (let y = 0; y < 8; y++) {
            const line = py + 2 * y + parity;
            for (let x = 0; x < 8; x++) {
              const base = lumaPred
                ? lumaPred[(2 * y + parity) * 16 + bx + x]!
                : 0;
              frame.y[line * codedWidth + px + bx + x] = clamp(
                Math.round(base + samples[y * 8 + x]!),
              );
            }
          }
        } else {
          const by = (b >> 1) * 8;
          addBlock(
            frame.y,
            codedWidth,
            px + bx,
            py + by,
            lumaPred,
            16,
            by * 16 + bx,
          );
        }
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
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const d = frame.y[y * codedWidth + x]! - ref[base + y * width + x]!;
        sseY += d * d;
        if (Math.abs(d) > worstY) worstY = Math.abs(d);
      }
    let sseC = 0;
    let worstC = 0;
    const dcw = width >> 1;
    const dch = height >> 1;
    for (let y = 0; y < dch; y++)
      for (let x = 0; x < dcw; x++) {
        const d1 =
          frame.cb[y * cw + x]! - ref[base + width * height + y * dcw + x]!;
        const d2 =
          frame.cr[y * cw + x]! -
          ref[base + width * height + dcw * dch + y * dcw + x]!;
        sseC += d1 * d1 + d2 * d2;
        worstC = Math.max(worstC, Math.abs(d1), Math.abs(d2));
      }
    const psnr = (sse: number, count: number) =>
      sse === 0
        ? "exact"
        : `${(10 * Math.log10((255 * 255 * count) / sse)).toFixed(2)} dB`;
    const lumaCount = width * height;
    const chromaCount = (width >> 1) * (height >> 1) * 2;
    if (sseY !== 0 || sseC !== 0) allExact = false;
    console.log(
      `  ${String(f).padStart(5)}  ${psnr(sseY, lumaCount).padStart(10)}  ` +
        `${String(worstY).padStart(6)}  ${psnr(sseC, chromaCount).padStart(12)}  ${String(worstC).padStart(6)}`,
    );
  }
  // Where a mismatch remains, bucket it by macroblock kind: the same technique
  // that located the bidirectional reference bug.
  if (!allExact && process.env.LOCALIZE) {
    const pic = pics.find((p) => p.header.pictureCodingType === PictureType.I)!;
    const idx = decoded.findIndex((f) => f === decodedByPic.get(pic));
    const base = idx * frameSize;
    const buckets = new Map<
      string,
      { n: number; sse: number; worst: number }
    >();
    for (let mbY = 0; mbY < g.mbHeight; mbY++)
      for (let mbX = 0; mbX < g.mbWidth; mbX++) {
        const mb = mbsByPic.get(pic)!.get(mbY * g.mbWidth + mbX);
        let sse = 0;
        let worst = 0;
        for (let y = 0; y < 16; y++)
          for (let x = 0; x < 16; x++) {
            const yy = mbY * 16 + y;
            if (yy >= height) continue;
            const d =
              decoded[idx]!.y[yy * codedWidth + mbX * 16 + x]! -
              ref[base + yy * width + mbX * 16 + x]!;
            sse += d * d;
            if (Math.abs(d) > worst) worst = Math.abs(d);
          }
        const key = !mb
          ? "absent"
          : `${mb.flags & MBFlag.INTRA ? "intra" : "inter"} dct=${mb.dctType} motion=${mb.motionType}`;
        const e = buckets.get(key) ?? { n: 0, sse: 0, worst: 0 };
        e.n++;
        e.sse += sse;
        e.worst = Math.max(e.worst, worst);
        buckets.set(key, e);
      }
    console.log("\nfirst I picture, luma error by macroblock kind:");
    console.log("  kind                     count    rmse   worst");
    for (const [k, v] of [...buckets].sort(
      (a, b) => b[1].sse / b[1].n - a[1].sse / a[1].n,
    ))
      console.log(
        `  ${k.padEnd(24)} ${String(v.n).padStart(5)}  ${Math.sqrt(
          v.sse / (v.n * 256),
        )
          .toFixed(2)
          .padStart(6)}  ${String(v.worst).padStart(5)}`,
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
