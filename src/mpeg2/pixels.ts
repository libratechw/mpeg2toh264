/** Pixel-domain MPEG-2 reconstruction for the opt-in I_PCM repair path. */
import { MBFlag, PictureType, QUANTISER_SCALE } from "./constants.ts";
import type { Picture } from "./headers.ts";
import { MotionType, type Macroblock } from "./macroblock.ts";
import { idct8 } from "../h264/chroma.ts";
import type { PcmMacroblockSamples } from "../h264/mb.ts";
import { reconstructIntraPcm } from "../h264/intra-pcm.ts";
import { fieldDctToFrameTargets, interTargets } from "../h264/quant.ts";

export interface PixelFrame {
  width: number;
  height: number;
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
}

function clip(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** H.262 7.4.2: saturate dequantised coefficients and force an odd sum. */
function mismatchControl(coeff: Float64Array): void {
  let sum = 0;
  for (let i = 0; i < 64; i++) {
    const value = Math.max(-2048, Math.min(2047, Math.trunc(coeff[i]!)));
    coeff[i] = value;
    sum += value;
  }
  if ((sum & 1) === 0) coeff[63] = Math.trunc(coeff[63]!) ^ 1;
}

export function createPixelFrame(
  mbWidth: number,
  mbHeight: number,
): PixelFrame {
  const width = mbWidth * 16;
  const height = mbHeight * 16;
  return {
    width,
    height,
    y: new Uint8Array(width * height),
    cb: new Uint8Array((width >> 1) * (height >> 1)),
    cr: new Uint8Array((width >> 1) * (height >> 1)),
  };
}

function halfPel(
  plane: Uint8Array,
  width: number,
  height: number,
  x2: number,
  y2: number,
): number {
  const x = Math.floor(x2 / 2);
  const y = Math.floor(y2 / 2);
  const fx = x2 - x * 2;
  const fy = y2 - y * 2;
  const at = (px: number, py: number) =>
    plane[
      Math.max(0, Math.min(height - 1, py)) * width +
        Math.max(0, Math.min(width - 1, px))
    ]!;
  const a = at(x, y);
  if (!fx && !fy) return a;
  if (fx && !fy) return (a + at(x + 1, y) + 1) >> 1;
  if (!fx && fy) return (a + at(x, y + 1) + 1) >> 1;
  return (a + at(x + 1, y) + at(x, y + 1) + at(x + 1, y + 1) + 2) >> 2;
}

function fieldHalfPel(
  plane: Uint8Array,
  width: number,
  height: number,
  x2: number,
  fieldY2: number,
  parity: number,
): number {
  const x = Math.floor(x2 / 2);
  const y = Math.floor(fieldY2 / 2);
  const fx = x2 - x * 2;
  const fy = fieldY2 - y * 2;
  const fieldHeight = height >> 1;
  const at = (px: number, py: number) => {
    const cx = Math.max(0, Math.min(width - 1, px));
    const cy = Math.max(0, Math.min(fieldHeight - 1, py));
    return plane[(cy * 2 + parity) * width + cx]!;
  };
  const a = at(x, y);
  if (!fx && !fy) return a;
  if (fx && !fy) return (a + at(x + 1, y) + 1) >> 1;
  if (!fx && fy) return (a + at(x, y + 1) + 1) >> 1;
  return (a + at(x + 1, y) + at(x, y + 1) + at(x + 1, y + 1) + 2) >> 2;
}

function prediction(
  ref: PixelFrame,
  plane: "y" | "cb" | "cr",
  mb: Macroblock,
  direction: 0 | 1,
  mbX: number,
  mbY: number,
  x: number,
  y: number,
): number {
  const chroma = plane !== "y";
  const data = ref[plane];
  const width = chroma ? ref.width >> 1 : ref.width;
  const height = chroma ? ref.height >> 1 : ref.height;
  const baseX = mbX * (chroma ? 8 : 16) + x;
  const baseY = mbY * (chroma ? 8 : 16) + y;
  if (mb.motionType === MotionType.FIELD && !chroma) {
    const field = y & 1;
    const vector = field;
    const mvBase = vector * 4 + direction * 2;
    const selected = mb.fieldSelect[vector * 2 + direction]!;
    // Vertical field vectors count in field lines. Address the selected field
    // explicitly, then convert back to the interleaved frame plane.
    const fieldY2 = Math.floor(baseY / 2) * 2 + mb.mv[mvBase + 1]!;
    return fieldHalfPel(
      data,
      width,
      height,
      baseX * 2 + mb.mv[mvBase]!,
      fieldY2,
      selected,
    );
  }
  const mvBase = direction * 2;
  const mvX = mb.mv[mvBase]!;
  const mvY = mb.mv[mvBase + 1]!;
  // MPEG-2 4:2:0 chroma vectors are derived by halving the luma vector with
  // truncation toward zero; halfPel still expects chroma half-sample units.
  const sx = chroma ? Math.trunc(mvX / 2) : mvX;
  const sy = chroma ? Math.trunc(mvY / 2) : mvY;
  return halfPel(data, width, height, baseX * 2 + sx, baseY * 2 + sy);
}

function putMacroblock(
  frame: PixelFrame,
  mbX: number,
  mbY: number,
  samples: PcmMacroblockSamples,
): void {
  for (let y = 0; y < 16; y++) {
    frame.y.set(
      samples.luma.subarray(y * 16, y * 16 + 16),
      (mbY * 16 + y) * frame.width + mbX * 16,
    );
  }
  const cw = frame.width >> 1;
  for (let y = 0; y < 8; y++) {
    const at = (mbY * 8 + y) * cw + mbX * 8;
    frame.cb.set(samples.cb.subarray(y * 8, y * 8 + 8), at);
    frame.cr.set(samples.cr.subarray(y * 8, y * 8 + 8), at);
  }
}

function residualBlocks(mb: Macroblock, pic: Picture): Float64Array[] {
  const scale = QUANTISER_SCALE[pic.coding.qScaleType]![mb.quantiserScaleCode]!;
  const coeff = Array.from({ length: 6 }, () => new Float64Array(64));
  for (let b = 0; b < 6; b++) {
    const levels = mb.blocks[b];
    if (levels) {
      interTargets(
        levels,
        b < 4 ? pic.quant.nonIntra : pic.quant.chromaNonIntra,
        scale,
        coeff[b]!,
      );
      mismatchControl(coeff[b]!);
    }
  }
  if (mb.dctType === 1) {
    const converted = Array.from({ length: 4 }, () => new Float64Array(64));
    fieldDctToFrameTargets(coeff[0]!, coeff[2]!, converted[0]!, converted[2]!);
    fieldDctToFrameTargets(coeff[1]!, coeff[3]!, converted[1]!, converted[3]!);
    for (let b = 0; b < 4; b++) coeff[b] = converted[b]!;
  }
  const spatial = coeff.map(() => new Float64Array(64));
  for (let b = 0; b < 6; b++) idct8(coeff[b]!, spatial[b]!);
  return spatial;
}

/** Reconstruct a decoded frame picture using its MPEG-2 reference pictures. */
export function reconstructPicture(
  pic: Picture,
  macroblocks: readonly (Macroblock | undefined)[],
  forward: PixelFrame | null,
  backward: PixelFrame | null,
): PixelFrame {
  const mbWidth = (pic.sequence.horizontalSize + 15) >> 4;
  const mbHeight = (pic.sequence.verticalSize + 15) >> 4;
  const out = createPixelFrame(mbWidth, mbHeight);
  for (let address = 0; address < mbWidth * mbHeight; address++) {
    const mb = macroblocks[address];
    if (!mb) continue;
    const mbX = address % mbWidth;
    const mbY = Math.floor(address / mbWidth);
    if (!mb.skipped && mb.flags & MBFlag.INTRA) {
      putMacroblock(out, mbX, mbY, reconstructIntraPcm(mb, pic));
      continue;
    }
    const residual = residualBlocks(mb, pic);
    const dirs: [0 | 1, PixelFrame][] = [];
    if (mb.flags & MBFlag.MOTION_FORWARD && forward) dirs.push([0, forward]);
    if (mb.flags & MBFlag.MOTION_BACKWARD && backward) dirs.push([1, backward]);
    if (
      pic.header.pictureCodingType === PictureType.P &&
      dirs.length === 0 &&
      forward
    )
      dirs.push([0, forward]);
    const samplePlane = (
      plane: "y" | "cb" | "cr",
      width: number,
      height: number,
    ) => {
      const target = out[plane];
      const stride = plane === "y" ? out.width : out.width >> 1;
      const blocks = plane === "y" ? [0, 1, 2, 3] : [plane === "cb" ? 4 : 5];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          let pred = 128;
          if (dirs.length)
            pred = Math.floor(
              (dirs.reduce(
                (n, [d, ref]) =>
                  n + prediction(ref, plane, mb, d, mbX, mbY, x, y),
                0,
              ) +
                (dirs.length >> 1)) /
                dirs.length,
            );
          const block = blocks[(y >> 3) * (width >> 3) + (x >> 3)]!;
          const value = pred + residual[block]![(y & 7) * 8 + (x & 7)]!;
          target[(mbY * height + y) * stride + mbX * width + x] = clip(value);
        }
    };
    samplePlane("y", 16, 16);
    samplePlane("cb", 8, 8);
    samplePlane("cr", 8, 8);
  }
  return out;
}

/** Extract one frame-ordered 4:2:0 macroblock for H.264 I_PCM. */
export function macroblockSamples(
  frame: PixelFrame,
  mbX: number,
  mbY: number,
): PcmMacroblockSamples {
  const luma = new Uint8Array(256);
  const cb = new Uint8Array(64);
  const cr = new Uint8Array(64);
  for (let y = 0; y < 16; y++)
    luma.set(
      frame.y.subarray(
        (mbY * 16 + y) * frame.width + mbX * 16,
        (mbY * 16 + y) * frame.width + mbX * 16 + 16,
      ),
      y * 16,
    );
  const cw = frame.width >> 1;
  for (let y = 0; y < 8; y++) {
    const at = (mbY * 8 + y) * cw + mbX * 8;
    cb.set(frame.cb.subarray(at, at + 8), y * 8);
    cr.set(frame.cr.subarray(at, at + 8), y * 8);
  }
  return { luma, cb, cr };
}
