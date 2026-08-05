/**
 * MPEG-2 macroblock layer decoding.
 *
 * Coefficients come out as quantised levels, not pixels: this transcoder maps
 * levels straight into H.264 syntax, so nothing here dequantises, inverse
 * transforms, or motion compensates. Motion vectors are reconstructed because
 * the H.264 side needs their actual values.
 */
import type { BitReader } from "../bitreader.ts";
import {
  ALTERNATE_SCAN,
  MBFlag,
  PictureStructure,
  PictureType,
  ZIGZAG_SCAN,
} from "./constants.ts";
import type { Picture, Slice } from "./headers.ts";
import { VlcTable } from "./vlc.ts";
import {
  CODED_BLOCK_PATTERN,
  DCT_COEFF_TABLE0,
  DCT_COEFF_TABLE1,
  DCT_DC_SIZE_CHROMA,
  DCT_DC_SIZE_LUMA,
  DMVECTOR,
  EOB,
  ESCAPE,
  MB_ADDR_INCREMENT,
  MB_TYPE_B,
  MB_TYPE_I,
  MB_TYPE_P,
  MOTION_CODE,
} from "./vlc-tables.ts";

const V_MB_ADDR = new VlcTable(
  "macroblock_address_increment",
  MB_ADDR_INCREMENT,
);
const V_MB_TYPE_I = new VlcTable("macroblock_type(I)", MB_TYPE_I);
const V_MB_TYPE_P = new VlcTable("macroblock_type(P)", MB_TYPE_P);
const V_MB_TYPE_B = new VlcTable("macroblock_type(B)", MB_TYPE_B);
const V_CBP = new VlcTable("coded_block_pattern", CODED_BLOCK_PATTERN);
const V_MOTION = new VlcTable("motion_code", MOTION_CODE);
const V_DMV = new VlcTable("dmvector", DMVECTOR);
const V_DC_LUMA = new VlcTable("dct_dc_size_luminance", DCT_DC_SIZE_LUMA);
const V_DC_CHROMA = new VlcTable("dct_dc_size_chrominance", DCT_DC_SIZE_CHROMA);
const V_COEFF0 = new VlcTable("dct_coefficients_0", DCT_COEFF_TABLE0);
const V_COEFF1 = new VlcTable("dct_coefficients_1", DCT_COEFF_TABLE1);

/**
 * Counters for which syntax paths actually executed. A decoder that never
 * exercises Table B.15 or the escape code still reports success on every
 * stream, so coverage has to be measured rather than assumed.
 */
export const decodeStats = {
  blocksTable0: 0,
  blocksTable1: 0,
  escapes: 0,
  intraBlocks: 0,
  motionField: 0,
  motionFrame: 0,
  dualPrime: 0,
  dctTypeField: 0,
  concealmentMv: 0,
  mbEscapes: 0,
};

export function resetDecodeStats(): void {
  for (const k of Object.keys(decodeStats) as (keyof typeof decodeStats)[]) {
    decodeStats[k] = 0;
  }
}

/** frame_motion_type / field_motion_type values (Tables 6-17, 6-18). */
export const MotionType = {
  FIELD: 1,
  /** Frame-based in frame pictures; 16x8 MC in field pictures. */
  FRAME_OR_16X8: 2,
  DUAL_PRIME: 3,
} as const;

export interface Macroblock {
  /** Macroblock address within the picture, in raster order. */
  address: number;
  /** True for macroblocks covered by macroblock_address_increment but not coded. */
  skipped: boolean;
  /** Bit set of MBFlag. */
  flags: number;
  quantiserScaleCode: number;
  /** frame_motion_type or field_motion_type; 0 when the macroblock has no motion. */
  motionType: number;
  /** 0 = frame DCT, 1 = field DCT. */
  dctType: number;
  /** coded_block_pattern; for intra macroblocks all blocks are coded. */
  cbp: number;
  /**
   * Reconstructed motion vectors in half-pel units, indexed [r * 4 + s * 2 + t]
   * with r the vector index, s = 0 forward / 1 backward, t = 0 horizontal /
   * 1 vertical.
   */
  mv: Int32Array;
  /** motion_vertical_field_select, indexed [r * 2 + s]. */
  fieldSelect: Uint8Array;
  /** How many of the two vector slots are in use. */
  mvCount: number;
  /** Six 8x8 blocks of quantised levels in raster order; null when not coded. */
  blocks: (Int16Array | null)[];
}

/** Per-slice decoder state that persists across macroblocks. */
interface SliceState {
  quantiserScaleCode: number;
  /** DC predictors for Y, Cb, Cr. */
  dcPred: Int32Array;
  /** Value the DC predictors reset to, from intra_dc_precision. */
  dcPredReset: number;
  /** Motion vector predictors, same indexing as Macroblock.mv. */
  pmv: Int32Array;
  /** Previous macroblock's vectors, which skipped B macroblocks reuse. */
  prev: Macroblock | null;
}

function signedDcDifferential(r: BitReader, size: number): number {
  if (size === 0) return 0;
  const v = r.u(size);
  // A leading zero means the value is negative; sign-extend from `size` bits.
  return v & (1 << (size - 1)) ? v : v - (1 << size) + 1;
}

/**
 * Derive motion_vector_count / mv_format / dmv from the motion type
 * (Tables 6-17 and 6-18).
 */
function motionSpec(pictureStructure: number, motionType: number) {
  const frame = pictureStructure === PictureStructure.FRAME;
  if (motionType === MotionType.DUAL_PRIME) {
    return { count: 1, fieldFormat: true, dmv: true };
  }
  if (frame) {
    // Frame picture: 1 = two field vectors, 2 = one frame vector.
    return motionType === MotionType.FIELD
      ? { count: 2, fieldFormat: true, dmv: false }
      : { count: 1, fieldFormat: false, dmv: false };
  }
  // Field picture: 1 = one field vector, 2 = 16x8 (two vectors).
  return motionType === MotionType.FIELD
    ? { count: 1, fieldFormat: true, dmv: false }
    : { count: 2, fieldFormat: true, dmv: false };
}

/**
 * Decode one motion vector component and update its predictor (clause 7.6.3.1).
 * `fCode` selects the residual width and the wrap-around range.
 */
function decodeMotionComponent(
  r: BitReader,
  fCode: number,
  pmv: Int32Array,
  pmvIndex: number,
  /**
   * True for the vertical component of a field motion vector in a frame
   * picture. Such a vector counts in field lines while the predictor is kept in
   * frame lines, so the predictor is halved on the way in and doubled on the
   * way out (clause 7.6.3.1).
   */
  fieldVerticalInFrame = false,
): number {
  const code = V_MOTION.decode(r);
  const rSize = fCode - 1;
  const f = 1 << rSize;
  let delta: number;
  if (f === 1 || code === 0) {
    delta = code;
  } else {
    const residual = r.u(rSize);
    delta = (Math.abs(code) - 1) * f + residual + 1;
    if (code < 0) delta = -delta;
  }
  const high = 16 * f - 1;
  const low = -16 * f;
  const range = 32 * f;
  // DIV is division rounding toward minus infinity, which an arithmetic shift
  // gives directly.
  const prediction = fieldVerticalInFrame
    ? pmv[pmvIndex]! >> 1
    : pmv[pmvIndex]!;
  let vector = prediction + delta;
  if (vector < low) vector += range;
  else if (vector > high) vector -= range;
  pmv[pmvIndex] = fieldVerticalInFrame ? vector * 2 : vector;
  return vector;
}

/** Decode the block layer: run/level pairs into an 8x8 array of levels. */
function decodeBlock(
  r: BitReader,
  pic: Picture,
  state: SliceState,
  blockIndex: number,
  intra: boolean,
): Int16Array {
  const coeffs = new Int16Array(64);
  const scan = pic.coding.alternateScan ? ALTERNATE_SCAN : ZIGZAG_SCAN;
  // Intra blocks use Table B.15 when intra_vlc_format is set; everything else
  // uses Table B.14.
  const useTable1 = intra && pic.coding.intraVlcFormat === 1;
  const table = useTable1 ? V_COEFF1 : V_COEFF0;
  if (useTable1) decodeStats.blocksTable1++;
  else decodeStats.blocksTable0++;
  if (intra) decodeStats.intraBlocks++;
  let n: number;

  if (intra) {
    const isLuma = blockIndex < 4;
    const size = isLuma ? V_DC_LUMA.decode(r) : V_DC_CHROMA.decode(r);
    const component = isLuma ? 0 : blockIndex - 3; // 0 = Y, 1 = Cb, 2 = Cr
    state.dcPred[component] =
      state.dcPred[component]! + signedDcDifferential(r, size);
    coeffs[0] = state.dcPred[component]!;
    n = 1;
  } else {
    // The first coefficient of a non-intra block uses the one-bit code '1' for
    // (run 0, level 1); Table B.14's '11' form applies only from the second
    // coefficient onwards.
    if (r.peek(1) === 1) {
      r.skip(1);
      const level = r.flag() ? -1 : 1;
      coeffs[scan[0]!] = level;
      n = 1;
    } else {
      n = 0;
    }
  }

  for (;;) {
    const sym = table.decode(r);
    if (sym === EOB) break;
    let run: number;
    let level: number;
    if (sym === ESCAPE) {
      decodeStats.escapes++;
      run = r.u(6);
      const raw = r.u(12);
      level = raw >= 2048 ? raw - 4096 : raw;
    } else {
      run = sym >> 8;
      level = sym & 0xff;
      if (r.flag()) level = -level;
    }
    n += run;
    if (n > 63) {
      throw new Error(`coefficient index ${n} out of range at bit ${r.bitPos}`);
    }
    coeffs[scan[n]!] = level;
    n++;
  }
  return coeffs;
}

/** Decode every macroblock of one slice. */
export function decodeSlice(
  r: BitReader,
  pic: Picture,
  slice: Slice,
  mbWidth: number,
): Macroblock[] {
  r.bitPos = slice.dataStartBit;

  // DC predictors reset to the midpoint for the picture's DC precision.
  const dcPredReset = 1 << (7 + pic.coding.intraDcPrecision);
  const state: SliceState = {
    quantiserScaleCode: slice.quantiserScaleCode,
    dcPred: new Int32Array(3).fill(dcPredReset),
    dcPredReset,
    pmv: new Int32Array(8),
    prev: null,
  };

  const out: Macroblock[] = [];
  const type = pic.header.pictureCodingType;
  const frame = pic.coding.pictureStructure === PictureStructure.FRAME;
  // slice_vertical_position is 1-based and names the macroblock row.
  let address = (slice.verticalPosition - 1) * mbWidth - 1;

  // Clause 6.2.4: macroblocks continue until 23 zero bits appear at the current
  // position. Testing here rather than seeking to a byte-aligned start code is
  // what makes trailing stuffing bits and zero stuffing bytes work out.
  while (r.peek(23) !== 0) {
    let increment = 0;
    for (;;) {
      const sym = V_MB_ADDR.decode(r);
      if (sym === "ESCAPE") {
        decodeStats.mbEscapes++;
        increment += 33;
        continue;
      }
      increment += sym;
      break;
    }

    // Everything between the previous macroblock and this one is skipped.
    for (let k = 1; k < increment; k++) {
      address++;
      out.push(makeSkipped(address, state, type, frame));
    }
    address++;

    const mb = decodeMacroblock(r, pic, state, address, frame);
    out.push(mb);
    state.prev = mb;
  }

  return out;
}

/**
 * A skipped macroblock. In P pictures it is a zero-vector copy and resets the
 * predictors; in B pictures it repeats the previous macroblock's prediction, so
 * the predictors carry over untouched (clause 7.6.6).
 */
function makeSkipped(
  address: number,
  state: SliceState,
  pictureType: number,
  framePicture: boolean,
): Macroblock {
  const skipped: Macroblock = {
    address,
    skipped: true,
    flags: 0,
    quantiserScaleCode: state.quantiserScaleCode,
    motionType: 0,
    dctType: 0,
    cbp: 0,
    mv: new Int32Array(8),
    fieldSelect: new Uint8Array(4),
    mvCount: 1,
    blocks: [null, null, null, null, null, null],
  };
  if (pictureType === PictureType.P) {
    state.pmv.fill(0);
  } else if (state.prev) {
    skipped.flags =
      state.prev.flags & (MBFlag.MOTION_FORWARD | MBFlag.MOTION_BACKWARD);
    if (framePicture) {
      // H.262 7.6.6.4: a skipped B macroblock in a frame picture is always
      // frame-based. Its direction comes from the previous macroblock, while
      // its vectors come directly from the corresponding PMV[0] predictors.
      skipped.motionType = MotionType.FRAME_OR_16X8;
      for (let direction = 0; direction < 2; direction++) {
        const directionFlag =
          direction === 0 ? MBFlag.MOTION_FORWARD : MBFlag.MOTION_BACKWARD;
        if ((skipped.flags & directionFlag) === 0) {
          continue;
        }
        const base = direction * 2;
        skipped.mv[base] = state.pmv[base]!;
        skipped.mv[base + 1] = state.pmv[base + 1]!;
      }
    } else {
      // Field pictures use same-parity field prediction (7.6.6.3). Keep the
      // decoded predictor values here; field pictures are rejected later by
      // this transcoder, but the elementary-stream decoder remains coherent.
      skipped.motionType = MotionType.FIELD;
      skipped.mv[0] = state.pmv[0]!;
      skipped.mv[1] = state.pmv[1]!;
      skipped.mv[2] = state.pmv[2]!;
      skipped.mv[3] = state.pmv[3]!;
    }
  }
  // A skipped macroblock has no coded blocks, so the DC predictors reset.
  state.dcPred.fill(state.dcPredReset);
  return skipped;
}

function decodeMacroblock(
  r: BitReader,
  pic: Picture,
  state: SliceState,
  address: number,
  frame: boolean,
): Macroblock {
  const type = pic.header.pictureCodingType;
  const typeTable =
    type === PictureType.I
      ? V_MB_TYPE_I
      : type === PictureType.P
        ? V_MB_TYPE_P
        : V_MB_TYPE_B;
  const flags = typeTable.decode(r);
  const intra = (flags & MBFlag.INTRA) !== 0;
  const hasMotion =
    (flags & (MBFlag.MOTION_FORWARD | MBFlag.MOTION_BACKWARD)) !== 0;
  const conceal = pic.coding.concealmentMotionVectors;

  let motionType = 0;
  if (hasMotion || (intra && conceal)) {
    if (frame) {
      // Not transmitted when frame_pred_frame_dct is set: inferred as frame-based.
      motionType = pic.coding.framePredFrameDct
        ? MotionType.FRAME_OR_16X8
        : r.u(2);
    } else {
      motionType = r.u(2);
    }
    if (motionType === MotionType.FIELD) decodeStats.motionField++;
    else if (motionType === MotionType.DUAL_PRIME) decodeStats.dualPrime++;
    else decodeStats.motionFrame++;
  }
  if (intra && conceal) decodeStats.concealmentMv++;

  let dctType = 0;
  if (
    frame &&
    !pic.coding.framePredFrameDct &&
    (intra || (flags & MBFlag.PATTERN) !== 0)
  ) {
    dctType = r.u(1);
    if (dctType) decodeStats.dctTypeField++;
  }

  if (flags & MBFlag.QUANT) {
    state.quantiserScaleCode = r.u(5);
  }

  const mv = new Int32Array(8);
  const fieldSelect = new Uint8Array(4);
  let mvCount = 1;

  // Intra macroblocks reset the predictors unless they carry concealment vectors.
  if (intra && !conceal) {
    state.pmv.fill(0);
  }
  // A P macroblock with no forward vector predicts from zero (clause 7.6.3.4).
  if (type === PictureType.P && !(flags & MBFlag.MOTION_FORWARD) && !intra) {
    state.pmv.fill(0);
  }

  const readVectors = (s: number) => {
    const spec = motionSpec(pic.coding.pictureStructure, motionType);
    mvCount = spec.count;
    const fCodeH = pic.coding.fCode[s]![0]!;
    const fCodeV = pic.coding.fCode[s]![1]!;
    for (let vec = 0; vec < spec.count; vec++) {
      // motion_vertical_field_select is sent for both vectors when there are
      // two, and for a lone field-format vector unless it is dual-prime.
      if (spec.count === 2 || (spec.fieldFormat && !spec.dmv)) {
        fieldSelect[vec * 2 + s] = r.u(1);
      }
      const base = vec * 4 + s * 2;
      const fieldVerticalInFrame = spec.fieldFormat && frame;
      mv[base] = decodeMotionComponent(r, fCodeH, state.pmv, base);
      if (spec.dmv) V_DMV.decode(r); // dmvector[0]
      mv[base + 1] = decodeMotionComponent(
        r,
        fCodeV,
        state.pmv,
        base + 1,
        fieldVerticalInFrame,
      );
      if (spec.dmv) V_DMV.decode(r); // dmvector[1]
    }
  };

  if (flags & MBFlag.MOTION_FORWARD || (intra && conceal)) readVectors(0);
  if (flags & MBFlag.MOTION_BACKWARD) readVectors(1);
  if (intra && conceal) r.skip(1); // marker_bit

  if (frame && motionType !== MotionType.FIELD) {
    // H.262 Table 7-23: frame-based (and dual-prime) motion carries one vector
    // per direction, so the second predictor must track the first. Without
    // this copy a following field-based macroblock predicts its bottom-field
    // vector from stale state.
    if (flags & MBFlag.MOTION_FORWARD || (intra && conceal)) {
      state.pmv[4] = state.pmv[0]!;
      state.pmv[5] = state.pmv[1]!;
    }
    if (flags & MBFlag.MOTION_BACKWARD) {
      state.pmv[6] = state.pmv[2]!;
      state.pmv[7] = state.pmv[3]!;
    }
  }

  let cbp = 0;
  if (flags & MBFlag.PATTERN) {
    cbp = V_CBP.decode(r);
  }

  const blocks: (Int16Array | null)[] = [null, null, null, null, null, null];
  for (let i = 0; i < 6; i++) {
    const coded = intra || (cbp & (1 << (5 - i))) !== 0;
    if (coded) blocks[i] = decodeBlock(r, pic, state, i, intra);
  }

  if (!intra) {
    // Non-intra macroblocks reset the DC predictors (clause 7.2.1).
    state.dcPred.fill(state.dcPredReset);
  }

  return {
    address,
    skipped: false,
    flags,
    quantiserScaleCode: state.quantiserScaleCode,
    motionType,
    dctType,
    cbp: intra ? 0x3f : cbp,
    mv,
    fieldSelect,
    mvCount,
    blocks,
  };
}
