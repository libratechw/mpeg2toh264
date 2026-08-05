/**
 * MPEG-2 to H.264 transcoding.
 *
 * The normal path reconstructs no pixels on the luma path: MPEG-2 coefficient
 * levels are dequantised into orthonormal-DCT values and requantised straight
 * into H.264 levels, with no inverse transform, no motion compensation and no
 * reference frame buffer. Chroma is the exception and is documented in
 * h264/chroma.ts.
 *
 * The one place pixels are unavoidable is the very first picture of a random
 * access point, which has nothing to predict from: it is reconstructed and
 * emitted as an I_PCM IDR. Every later picture predicts, so it goes back
 * through the coefficient path.
 *
 * Every output picture is a B slice, even those that were I or P in the source,
 * because the half-sample motion mapping needs bi-prediction and that is only
 * available in B slices. See h264/mvmap.ts.
 */
import { BitReader } from "./bitreader.ts";
import {
  MBFlag,
  PictureStructure,
  PictureType,
  QUANTISER_SCALE,
} from "./mpeg2/constants.ts";
import {
  parseElementaryStream,
  pictureGeometry,
  sequenceSampleAspectRatio,
  type Picture,
} from "./mpeg2/headers.ts";
import {
  MotionType,
  decodeSlice,
  type Macroblock,
} from "./mpeg2/macroblock.ts";
import { BitWriter, NalType, toNalUnit } from "./h264/bitwriter.ts";
import {
  chromaQp,
  clearChromaBlockLevels,
  convertFieldChromaPair,
  convertIntraChromaBlock,
  makeFieldChromaScratch,
  makeChromaBlockLevels,
  type ChromaBlockLevels,
} from "./h264/chroma.ts";
import { reconstructIntraPcm } from "./h264/intra-pcm.ts";
import {
  BMbType,
  b16x8MbType,
  CoeffCountMap,
  makeChromaCounts,
  makeLumaCounts,
  markNoChromaCoefficients,
  markNoCoefficients,
  toZigzag8x8,
  writeInterMacroblock,
  writePcmMacroblock,
  type ChromaCounts,
  type InterMacroblock,
  type PcmMacroblockSamples,
} from "./h264/mb.ts";
import { VectorKind, mapVector, nativePosition } from "./h264/mvmap.ts";
import { MotionField } from "./h264/mvpred.ts";
import { frameGeometry, writePps, writeSps } from "./h264/params.ts";
import {
  DEFAULT_QUANTISER_OPTIONS,
  Quantiser8x8,
  fieldDctToFrameTargets,
  frameDctToFieldTargets,
  interTargets,
  intraTargets,
} from "./h264/quant.ts";
import { SliceType, writeSliceHeader } from "./h264/slice.ts";

const LOG2_MAX_FRAME_NUM_MINUS4 = 4;
const LOG2_MAX_POC_LSB_MINUS4 = 12;
const PPS_INIT_QP = 26;
/**
 * Chroma is quantised finer than luma. Its conversion runs through an inverse
 * and a forward transform plus the 2x2 DC Hadamard, which is orthogonal but not
 * orthonormal, so it accumulates more rounding than luma's direct coefficient
 * mapping and that error compounds along a chain of predicted pictures.
 */
const CHROMA_QP_OFFSET = -6;
const MAX_FRAME_NUM = 1 << (LOG2_MAX_FRAME_NUM_MINUS4 + 4);

/** Neutral grey, for a macroblock the source never coded. */
const CONCEALMENT_MACROBLOCK: PcmMacroblockSamples = {
  luma: new Uint8Array(256).fill(128),
  cb: new Uint8Array(64).fill(128),
  cr: new Uint8Array(64).fill(128),
};

export interface TranscodeOptions {
  oversample?: number;
  /** Convert only MPEG-2 I pictures; P and B pictures are counted as skipped. */
  iFramesOnly?: boolean;
  /**
   * Code an interlaced source as progressive frames.
   *
   * Field-DCT macroblocks cost nothing: their blocks convert to frame DCT
   * exactly, in the coefficient domain. Field motion does cost something,
   * because a field-motion macroblock carries a vector per field and a frame
   * macroblock has room for one, so the two are averaged and the prediction is
   * approximate wherever the fields moved differently.
   *
   * What it buys is a stream without macroblock-adaptive frame/field coding,
   * which some hardware decoders refuse outright -- Apple's VideoToolbox will
   * not create a decoder for frame_mbs_only_flag equal to 0 at all, whoever
   * produced the stream.
   */
  progressive?: boolean;
}

export interface TranscodeResult {
  bitstream: Uint8Array;
  picturesConverted: number;
  picturesSkipped: number;
  /** Inter macroblocks whose motion is reproduced exactly, luma and chroma. */
  integerVectors: number;
  /** Half sample on one axis: luma exact, chroma a quarter sample out. */
  singleAxisHalfVectors: number;
  /** Half sample on both axes, where luma is approximate as well. */
  bothAxisHalfVectors: number;
  /** Bidirectional macroblocks, where both prediction slots are already used. */
  bidirectionalVectors: number;
  intraMacroblocks: number;
  interMacroblocks: number;
}

/** Which reference index reaches which picture, per list. */
interface RefLayout {
  count: number;
  /** The picture an MPEG-2 forward vector refers to. */
  fwdL0: number;
  fwdL1: number;
  /** The picture an MPEG-2 backward vector refers to; -1 in I and P pictures. */
  bwdL0: number;
  bwdL1: number;
  /**
   * The index whose weights force a flat prediction, which intra macroblocks
   * use in place of H.264 intra prediction; see h264/slice.ts. It is the
   * long-term picture, which is kept purely to have an index to hang those
   * weights on -- its samples are never read.
   */
  flat: number;
  /**
   * Set for I and P pictures, where both lists must reach the same picture and
   * list 1's default construction would swap its first two entries.
   */
  forceL1ShortTerm: boolean;
}

type Stats = Omit<
  TranscodeResult,
  "bitstream" | "picturesConverted" | "picturesSkipped"
>;

export class IncrementalTranscoder {
  private readonly options: TranscodeOptions;
  private initialized = false;
  private width = 0;
  private height = 0;
  private mbaff = false;
  private prevRefFrameNum = 0;
  private shortTermCount = 0;
  private gopBase = 0;
  private seenPicture = false;
  private maxTrInGop = 0;
  private randomAccessPending = false;
  private picturesConverted = 0;
  private picturesSkipped = 0;
  private readonly stats: Stats = {
    integerVectors: 0,
    singleAxisHalfVectors: 0,
    bothAxisHalfVectors: 0,
    bidirectionalVectors: 0,
    intraMacroblocks: 0,
    interMacroblocks: 0,
  };

  constructor(options: TranscodeOptions = DEFAULT_QUANTISER_OPTIONS) {
    this.options = options;
  }

  /** Restart the H.264 DPB from an IDR at the next incremental unit. */
  requestRandomAccessPoint(): void {
    if (this.initialized) this.randomAccessPending = true;
  }

  push(data: Uint8Array): TranscodeResult {
    const options = this.options;
    const pics = parseElementaryStream(data);
    const first = pics[0];
    if (!first) throw new Error("no pictures in stream");

    const width = first.sequence.horizontalSize;
    const height = first.sequence.verticalSize;
    const mbaff =
      !first.sequenceExt.progressiveSequence && !options.progressive;
    if (
      this.initialized &&
      (width !== this.width || height !== this.height || mbaff !== this.mbaff)
    ) {
      throw new Error(
        "MPEG-2 sequence parameters changed during incremental transcode",
      );
    }

    // Interlaced coding is not handled. A field-DCT macroblock builds its 8x8
    // blocks from alternate lines and field motion predicts each field
    // separately; representing either in H.264 needs macroblock-adaptive
    // frame/field coding, which the macroblock layer here does not emit. Refusing
    // beats silently producing a picture assembled from the wrong lines.
    //
    // Field pictures are ruled out here; field DCT and field motion are caught per
    // macroblock instead, because clearing frame_pred_frame_dct only *permits*
    // them and progressive content often carries that flag without a single
    // field-coded macroblock in the stream.
    const fieldPicture = pics.find(
      (p) => p.coding.pictureStructure !== PictureStructure.FRAME,
    );
    if (fieldPicture) {
      throw new Error(
        "field pictures: this needs PAFF or MBAFF, which is not implemented " +
          `(picture_structure=${fieldPicture.coding.pictureStructure})`,
      );
    }

    const g = frameGeometry(width, height, !mbaff);
    const scaling = first.quant.nonIntra;

    const randomAccess = this.initialized && this.randomAccessPending;
    const parts: Uint8Array[] = this.initialized
      ? []
      : [
          writeSps({
            width,
            height,
            levelIdc: width * height > 720 * 576 ? 40 : 30,
            frameMbsOnly: !mbaff,
            // The long-term flat-prediction picture plus the two most recent I or P
            // pictures, which are what a B picture predicts from. The count also
            // fixes how many short-term pictures the sliding window keeps, so the
            // reference indices in RefLayout depend on it.
            maxNumRefFrames: 3,
            log2MaxFrameNumMinus4: LOG2_MAX_FRAME_NUM_MINUS4,
            log2MaxPocLsbMinus4: LOG2_MAX_POC_LSB_MINUS4,
            // An MPEG-2 stream codes its anchor picture before the B pictures that
            // display ahead of it, so one picture has to be held back.
            maxNumReorderFrames: 1,
            maxDecFrameBuffering: 4,
            sampleAspectRatio: sequenceSampleAspectRatio(first.sequence),
          }),
          writePps({
            initQp: PPS_INIT_QP,
            scaling8x8Intra: scaling,
            scaling8x8Inter: scaling,
            chromaQpIndexOffset: CHROMA_QP_OFFSET,
          }),
        ];

    const quant = new Quantiser8x8(scaling);
    const counts = makeLumaCounts(g.mbWidth, g.mbHeight);
    const chromaCounts = makeChromaCounts(g.mbWidth, g.mbHeight);
    const motion = new MotionField(g.mbWidth, g.mbHeight);
    const reader = new BitReader(data);

    const stats = this.stats;
    let picturesConverted = 0;
    let picturesSkipped = 0;

    let prevRefFrameNum = randomAccess ? 0 : this.prevRefFrameNum;
    let shortTermCount = randomAccess ? 0 : this.shortTermCount;
    // temporal_reference restarts at each group of pictures, so display order is
    // recovered by accumulating a base as the counter wraps.
    let gopBase = randomAccess ? 0 : this.gopBase;
    let seenPicture = randomAccess ? false : this.seenPicture;
    let maxTrInGop = randomAccess ? 0 : this.maxTrInGop;
    // A fresh stream, and a stream restarting at a random access point, has an
    // empty decoded picture buffer and so cannot code anything that predicts.
    let awaitingIdr = !this.initialized || randomAccess;

    for (const pic of pics) {
      const type = pic.header.pictureCodingType;
      if (
        type !== PictureType.I &&
        type !== PictureType.P &&
        type !== PictureType.B
      ) {
        picturesSkipped++;
        continue;
      }
      if (options.iFramesOnly && type !== PictureType.I) {
        picturesSkipped++;
        continue;
      }
      const tr = pic.header.temporalReference;
      if (pic.startsGop && seenPicture) {
        gopBase += maxTrInGop + 1;
        maxTrInGop = 0;
      }
      seenPicture = true;
      maxTrInGop = Math.max(maxTrInGop, tr);

      // A B picture needs both of its references present.
      if (type === PictureType.B && shortTermCount < 2) {
        picturesSkipped++;
        continue;
      }
      // Nothing can be coded before the IDR that starts the decoded picture
      // buffer, and only an I picture can become one.
      const realIdr = awaitingIdr && type === PictureType.I;
      if (awaitingIdr && !realIdr) {
        picturesSkipped++;
        continue;
      }
      awaitingIdr = false;
      // In I-only mode every content picture depends solely on the long-term
      // picture. Keeping content pictures as references only makes that picture
      // move through the default reference list, and serves no purpose.
      const isReference =
        realIdr || (!options.iFramesOnly && type !== PictureType.B);

      const layout: RefLayout =
        type === PictureType.B
          ? {
              // A B picture sits between its two references, so list 0 defaults to
              // [forward, backward, long-term] and list 1 to [backward, forward,
              // long-term].
              count: 3,
              fwdL0: 0,
              fwdL1: 1,
              bwdL0: 1,
              bwdL1: 0,
              flat: 2,
              forceL1ShortTerm: false,
            }
          : {
              count: shortTermCount + 1,
              fwdL0: 0,
              fwdL1: 0,
              bwdL0: -1,
              bwdL1: -1,
              // Long-term entries follow every short-term one in both default lists.
              flat: shortTermCount,
              forceL1ShortTerm: shortTermCount > 0,
            };

      const frameNum = realIdr ? 0 : (prevRefFrameNum + 1) % MAX_FRAME_NUM;
      const geo = pictureGeometry(pic);
      const byAddress: (Macroblock | undefined)[] = new Array(
        geo.mbWidth * geo.mbHeight,
      );
      for (const slice of pic.slices) {
        for (const mb of decodeSlice(reader, pic, slice, geo.mbWidth))
          byAddress[mb.address] = mb;
      }
      parts.push(
        writePicture(pic, byAddress, g, quant, counts, chromaCounts, motion, {
          frameNum,
          // The IDR displays first, so it takes the lowest POC in the segment.
          poc: realIdr ? 0 : 2 * (gopBase + tr),
          isReference,
          layout,
          options,
          mbaff,
          stats,
          realIdr,
        }),
      );
      if (realIdr) {
        // The IDR is held as the long-term flat-prediction picture, and nothing
        // predicts from its samples, so I-only mode needs no short-term
        // reference at all. Otherwise a skipped copy of it starts that chain.
        if (!options.iFramesOnly) {
          parts.push(writeReferenceClone(g, mbaff));
          prevRefFrameNum = 1;
          shortTermCount = 1;
        }
      } else if (isReference) {
        prevRefFrameNum = frameNum;
        shortTermCount = Math.min(2, shortTermCount + 1);
      }
      picturesConverted++;
    }

    let total = 0;
    for (const p of parts) total += p.length;
    const bitstream = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      bitstream.set(p, at);
      at += p.length;
    }
    this.initialized = true;
    this.width = width;
    this.height = height;
    this.mbaff = mbaff;
    this.prevRefFrameNum = prevRefFrameNum;
    this.shortTermCount = shortTermCount;
    this.gopBase = gopBase;
    this.seenPicture = seenPicture;
    this.maxTrInGop = maxTrInGop;
    this.randomAccessPending = false;
    this.picturesConverted += picturesConverted;
    this.picturesSkipped += picturesSkipped;
    return {
      bitstream,
      picturesConverted: this.picturesConverted,
      picturesSkipped: this.picturesSkipped,
      ...stats,
    };
  }
}

export function transcode(
  data: Uint8Array,
  options: TranscodeOptions = DEFAULT_QUANTISER_OPTIONS,
): TranscodeResult {
  return new IncrementalTranscoder(options).push(data);
}

interface PictureContext {
  frameNum: number;
  poc: number;
  isReference: boolean;
  layout: RefLayout;
  options: TranscodeOptions;
  mbaff: boolean;
  stats: Stats;
  realIdr: boolean;
}

/** How one macroblock is predicted, once the source's motion has been mapped. */
interface Prediction {
  mbType: number;
  refIdxL0: number;
  refIdxL1: number;
  mvL0: [number, number];
  mvL1: [number, number];
}

function predictionFor(
  mb: Macroblock | undefined,
  intra: boolean,
  layout: RefLayout,
  stats: Stats,
): Prediction {
  if (intra || !mb) {
    // Intra macroblocks take the flat prediction that stands in for H.264
    // intra prediction; see h264/slice.ts.
    return {
      mbType: BMbType.L0_16X16,
      refIdxL0: layout.flat,
      refIdxL1: -1,
      mvL0: [0, 0],
      mvL1: [0, 0],
    };
  }

  const hasBackward =
    layout.bwdL0 >= 0 && (mb.flags & MBFlag.MOTION_BACKWARD) !== 0;
  const hasForward = (mb.flags & MBFlag.MOTION_FORWARD) !== 0 || !hasBackward;

  // A frame-picture field prediction carries one vector for each field.  The
  // current H.264 macroblock writer emits a single 16x16 partition, so use the
  // centre of the two predictions. MPEG-2 vertical field vectors count field
  // lines and therefore become twice as large in frame-line coordinates.
  const vector = (backward: boolean): [number, number] => {
    const base = backward ? 2 : 0;
    if (mb.motionType !== MotionType.FIELD || mb.mvCount < 2) {
      return [mb.mv[base]!, mb.mv[base + 1]!];
    }
    return [
      Math.round((mb.mv[base]! + mb.mv[base + 4]!) / 2),
      Math.round(mb.mv[base + 1]! + mb.mv[base + 5]!),
    ];
  };

  if (hasForward && hasBackward) {
    // Both slots go to the two directions, leaving none for the bilinear pair,
    // so H.264 interpolates each side itself. The averaging structure still
    // matches MPEG-2's; only the sub-sample filter differs.
    stats.bidirectionalVectors++;
    return {
      mbType: BMbType.BI_16X16,
      refIdxL0: layout.fwdL0,
      // The backward picture's index in list 1, not its index in list 0: the
      // two lists hold the same pictures in opposite orders.
      refIdxL1: layout.bwdL1,
      mvL0: nativePosition(...vector(false)),
      mvL1: nativePosition(...vector(true)),
    };
  }

  const useBackward = hasBackward;
  const [mvx, mvy] = vector(useBackward);
  const mapped = mapVector(mvx, mvy);

  if (mapped.kind === VectorKind.INTEGER) stats.integerVectors++;
  else if (mapped.kind === VectorKind.HALF_ONE_AXIS)
    stats.singleAxisHalfVectors++;
  else stats.bothAxisHalfVectors++;

  // The bilinear pair must reach the same picture through both lists.
  const primary = useBackward ? layout.bwdL0 : layout.fwdL0;
  const secondary = useBackward ? layout.bwdL1 : layout.fwdL1;

  if (mapped.b === null) {
    return useBackward
      ? {
          mbType: BMbType.L1_16X16,
          refIdxL0: -1,
          refIdxL1: layout.bwdL1,
          mvL0: [0, 0],
          mvL1: mapped.a,
        }
      : {
          mbType: BMbType.L0_16X16,
          refIdxL0: layout.fwdL0,
          refIdxL1: -1,
          mvL0: mapped.a,
          mvL1: [0, 0],
        };
  }
  return {
    mbType: BMbType.BI_16X16,
    refIdxL0: primary,
    refIdxL1: secondary,
    mvL0: mapped.a,
    mvL1: mapped.b,
  };
}

/** Preserve vector-fidelity statistics when only field prediction is emitted. */
function countFieldPairVector(
  mb: Macroblock | undefined,
  intra: boolean,
  layout: RefLayout,
  stats: Stats,
): void {
  if (intra || !mb) return;
  const backward =
    layout.bwdL0 >= 0 && (mb.flags & MBFlag.MOTION_BACKWARD) !== 0;
  const forward = (mb.flags & MBFlag.MOTION_FORWARD) !== 0 || !backward;
  if (forward && backward) {
    stats.bidirectionalVectors++;
    return;
  }
  const base = backward ? 2 : 0;
  let x = mb.mv[base]!;
  let y = mb.mv[base + 1]!;
  if (mb.motionType === MotionType.FIELD && mb.mvCount >= 2) {
    x = Math.round((x + mb.mv[base + 4]!) / 2);
    y = Math.round(y + mb.mv[base + 5]!);
  }
  const halfAxes = (x & 1) + (y & 1);
  if (halfAxes === 0) stats.integerVectors++;
  else if (halfAxes === 1) stats.singleAxisHalfVectors++;
  else stats.bothAxisHalfVectors++;
}

/** Prediction for one field of an MPEG-2 field-motion macroblock. */
function predictionForField(
  mb: Macroblock,
  field: 0 | 1,
  layout: RefLayout,
  intra = false,
): Prediction {
  if (intra) {
    return {
      mbType: BMbType.L0_16X16,
      refIdxL0: layout.flat * 2,
      refIdxL1: -1,
      mvL0: [0, 0],
      mvL1: [0, 0],
    };
  }
  const hasBackward =
    layout.bwdL0 >= 0 && (mb.flags & MBFlag.MOTION_BACKWARD) !== 0;
  const hasForward = (mb.flags & MBFlag.MOTION_FORWARD) !== 0 || !hasBackward;
  const fieldMotion = mb.motionType === MotionType.FIELD;
  const fieldRef = (frameRef: number, direction: 0 | 1) => {
    if (!fieldMotion) return frameRef * 2;
    const refParity = mb.fieldSelect[field * 2 + direction]!;
    // MBAFF field lists expand each frame entry into same-parity then
    // opposite-parity fields for the current macroblock.
    return frameRef * 2 + (refParity === field ? 0 : 1);
  };
  const vector = (direction: 0 | 1): [number, number] => {
    const base = (fieldMotion ? field * 4 : 0) + direction * 2;
    return [mb.mv[base]!, mb.mv[base + 1]!];
  };
  const native = (direction: 0 | 1): [number, number] => {
    const [x, y] = vector(direction);
    // A frame vector's vertical half-sample unit is one quarter sample on the
    // field grid. Field-format vectors have already been scaled by the MPEG
    // decoder and use the ordinary mapping in MBAFF coordinates.
    return fieldMotion ? nativePosition(x, y) : [x * 2, y];
  };

  if (hasForward && hasBackward) {
    return {
      mbType: BMbType.BI_16X16,
      refIdxL0: fieldRef(layout.fwdL0, 0),
      refIdxL1: fieldRef(layout.bwdL1, 1),
      mvL0: native(0),
      mvL1: native(1),
    };
  }

  const useBackward = hasBackward;
  const direction = useBackward ? 1 : 0;
  if (!fieldMotion) {
    const mv = native(direction);
    return useBackward
      ? {
          mbType: BMbType.L1_16X16,
          refIdxL0: -1,
          refIdxL1: fieldRef(layout.bwdL1, 1),
          mvL0: [0, 0],
          mvL1: mv,
        }
      : {
          mbType: BMbType.L0_16X16,
          refIdxL0: fieldRef(layout.fwdL0, 0),
          refIdxL1: -1,
          mvL0: mv,
          mvL1: [0, 0],
        };
  }
  const mapped = mapVector(...vector(direction));
  const primaryFrame = useBackward ? layout.bwdL0 : layout.fwdL0;
  const secondaryFrame = useBackward ? layout.bwdL1 : layout.fwdL1;
  if (mapped.b === null) {
    return useBackward
      ? {
          mbType: BMbType.L1_16X16,
          refIdxL0: -1,
          refIdxL1: fieldRef(layout.bwdL1, 1),
          mvL0: [0, 0],
          mvL1: mapped.a,
        }
      : {
          mbType: BMbType.L0_16X16,
          refIdxL0: fieldRef(layout.fwdL0, 0),
          refIdxL1: -1,
          mvL0: mapped.a,
          mvL1: [0, 0],
        };
  }
  return {
    mbType: BMbType.BI_16X16,
    refIdxL0: fieldRef(primaryFrame, direction),
    refIdxL1: fieldRef(secondaryFrame, direction),
    mvL0: mapped.a,
    mvL1: mapped.b,
  };
}

/**
 * Copy the content IDR into a short-term reference without changing pixels.
 *
 * The IDR itself is kept as a long-term picture, purely to have a reference
 * index whose weights can force the flat prediction that intra macroblocks
 * need. That leaves nothing short-term for the pictures after it to predict
 * from, so this all-skip P picture puts the same samples in the short-term
 * chain. It carries the pair's display slot while the IDR is given a single
 * tick, and the two hold identical samples, so the seam is invisible.
 */
function writeReferenceClone(
  g: ReturnType<typeof frameGeometry>,
  mbaff: boolean,
): Uint8Array {
  const w = new BitWriter(64);
  writeSliceHeader(w, {
    firstMbInSlice: 0,
    sliceType: SliceType.P,
    frameNum: 1,
    log2MaxFrameNum: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
    picOrderCntLsb: 1,
    log2MaxPocLsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
    idr: false,
    reference: true,
    mbaff,
    sliceQp: PPS_INIT_QP,
    ppsInitQp: PPS_INIT_QP,
    disableDeblockingFilterIdc: 1,
    numRefIdxL0Active: 1,
  });
  w.ue(g.mbWidth * g.mbHeight); // mb_skip_run: copy the long-term IDR
  w.rbspTrailingBits();
  return toNalUnit(w.bytes(), 2, NalType.SLICE_NON_IDR);
}

function writePicture(
  pic: Picture,
  byAddress: readonly (Macroblock | undefined)[],
  g: ReturnType<typeof frameGeometry>,
  quant: Quantiser8x8,
  counts: CoeffCountMap,
  chromaCounts: ChromaCounts,
  motion: MotionField,
  ctx: PictureContext,
): Uint8Array {
  const nalParts: Uint8Array[] = [];

  const targets = Array.from({ length: 4 }, () => new Float64Array(64));
  const fieldTargets = Array.from({ length: 4 }, () => new Float64Array(64));
  const raster = new Int32Array(64);
  const lumaScratch = Array.from({ length: 4 }, () => new Int32Array(64));
  const chromaScratch: [ChromaBlockLevels, ChromaBlockLevels] = [
    makeChromaBlockLevels(),
    makeChromaBlockLevels(),
  ];
  const fieldChromaScratch = makeFieldChromaScratch();
  const pairFieldChroma = [0, 1].map(
    () =>
      [makeChromaBlockLevels(), makeChromaBlockLevels()] as [
        ChromaBlockLevels,
        ChromaBlockLevels,
      ],
  ) as [
    [ChromaBlockLevels, ChromaBlockLevels],
    [ChromaBlockLevels, ChromaBlockLevels],
  ];
  const fieldMotion: [MotionField, MotionField] = [
    new MotionField(g.mbWidth, g.mbHeight >> 1),
    new MotionField(g.mbWidth, g.mbHeight >> 1),
  ];
  const fieldCounts: [CoeffCountMap, CoeffCountMap] = [
    makeLumaCounts(g.mbWidth, g.mbHeight >> 1),
    makeLumaCounts(g.mbWidth, g.mbHeight >> 1),
  ];
  const fieldChromaCounts: [ChromaCounts, ChromaCounts] = [
    makeChromaCounts(g.mbWidth, g.mbHeight >> 1),
    makeChromaCounts(g.mbWidth, g.mbHeight >> 1),
  ];
  let prevQp = PPS_INIT_QP;
  let w: BitWriter | null = null;
  const outputSliceType = ctx.realIdr
    ? SliceType.I
    : ctx.options.iFramesOnly
      ? SliceType.P
      : SliceType.B;
  const pictureFieldPairs =
    ctx.mbaff &&
    !ctx.options.iFramesOnly &&
    pic.header.pictureCodingType !== PictureType.I;
  let cachedPairAddress = -1;
  type FieldTargetSet = { blocks: Float64Array[]; activeMask: number };
  let cachedPairTargets: [FieldTargetSet, FieldTargetSet] | null = null;
  let cachedPairQp = PPS_INIT_QP;
  const qpByScale = new Int16Array(256).fill(-1);
  const pairRawTargets = [0, 1].map(() =>
    Array.from({ length: 4 }, () => new Float64Array(64)),
  );
  const pairConvertedTargets = [0, 1].map(() =>
    Array.from({ length: 4 }, () => new Float64Array(64)),
  );
  const sourceFieldTargets = (fieldSource: Macroblock, pairSlot: 0 | 1) => {
    const raw = pairRawTargets[pairSlot]!;
    const converted = pairConvertedTargets[pairSlot]!;
    let activeMask = 0;
    if (fieldSource.skipped) return { blocks: raw, activeMask };
    const quantiserScale =
      QUANTISER_SCALE[pic.coding.qScaleType]![fieldSource.quantiserScaleCode]!;
    const sourceIntra = (fieldSource.flags & MBFlag.INTRA) !== 0;
    const matrix = sourceIntra ? pic.quant.intra : pic.quant.nonIntra;
    for (let b = 0; b < 4; b++) {
      const block = fieldSource.blocks[b];
      if (!block) continue;
      activeMask |= 1 << b;
      if (sourceIntra) {
        intraTargets(
          block,
          matrix,
          quantiserScale,
          pic.coding.intraDcPrecision,
          raw[b]!,
        );
      } else {
        interTargets(block, matrix, quantiserScale, raw[b]!);
      }
    }
    if (fieldSource.dctType === 1) return { blocks: raw, activeMask };
    let convertedMask = 0;
    if (activeMask & 0b0101) {
      if (!(activeMask & 0b0001)) raw[0]!.fill(0);
      if (!(activeMask & 0b0100)) raw[2]!.fill(0);
      frameDctToFieldTargets(raw[0]!, raw[2]!, converted[0]!, converted[2]!);
      convertedMask |= 0b0101;
    }
    if (activeMask & 0b1010) {
      if (!(activeMask & 0b0010)) raw[1]!.fill(0);
      if (!(activeMask & 0b1000)) raw[3]!.fill(0);
      frameDctToFieldTargets(raw[1]!, raw[3]!, converted[1]!, converted[3]!);
      convertedMask |= 0b1010;
    }
    return { blocks: converted, activeMask: convertedMask };
  };
  const qpForScale = (scale: number) => {
    let qp = qpByScale[scale]!;
    if (qp < 0) {
      qp = quant.chooseQp(
        scale,
        ctx.options.oversample ?? DEFAULT_QUANTISER_OPTIONS.oversample,
      );
      qpByScale[scale] = qp;
    }
    return qp;
  };
  const sourceQp = (fieldSource: Macroblock) =>
    qpForScale(
      QUANTISER_SCALE[pic.coding.qScaleType]![fieldSource.quantiserScaleCode]!,
    );

  // MBAFF addresses macroblocks pair-by-pair: top then bottom at one X,
  // followed by the next pair horizontally. Frame-only pictures use raster
  // order. Coordinates remain spatial so coefficient and MV neighbour lookup
  // does not otherwise change for frame-coded pairs.
  const positionCount = g.mbWidth * g.mbHeight;
  const writeMacroblock = (position: number): void => {
    const pairAddress = position >> 1;
    const mbX = ctx.mbaff ? pairAddress % g.mbWidth : position % g.mbWidth;
    const mbY = ctx.mbaff
      ? Math.floor(pairAddress / g.mbWidth) * 2 + (position & 1)
      : Math.floor(position / g.mbWidth);
    const startsSlice = w === null;
    if (startsSlice) {
      counts.reset();
      chromaCounts.cb.reset();
      chromaCounts.cr.reset();
      motion.reset();
      fieldMotion[0].reset();
      fieldMotion[1].reset();
      for (const map of fieldCounts) map.reset();
      for (const maps of fieldChromaCounts) {
        maps.cb.reset();
        maps.cr.reset();
      }
      prevQp = PPS_INIT_QP;
      w = new BitWriter(1 << 22);
      writeSliceHeader(w, {
        firstMbInSlice: 0,
        // I-only pictures need no bi-prediction. P slices are simpler and much
        // more widely handled than a stream consisting solely of reference-less B
        // pictures, while still giving every source intra MB its flat prediction.
        sliceType: outputSliceType,
        frameNum: ctx.frameNum,
        log2MaxFrameNum: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
        picOrderCntLsb: ctx.poc,
        log2MaxPocLsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
        idr: ctx.realIdr,
        // The IDR is the flat-prediction reference for everything that
        // follows, so it has to survive the sliding window.
        longTermReference: ctx.realIdr,
        reference: ctx.isReference,
        mbaff: ctx.mbaff,
        sliceQp: PPS_INIT_QP,
        ppsInitQp: PPS_INIT_QP,
        disableDeblockingFilterIdc: 1,
        numRefIdxL0Active: ctx.layout.count,
        numRefIdxL1Active: ctx.layout.count,
        l1FirstShortTermDelta: ctx.layout.forceL1ShortTerm ? 1 : undefined,
        flatPredRefIdx: ctx.layout.flat,
      });
    }
    const writer = w!;
    const source = byAddress[mbY * g.mbWidth + mbX];
    const pairTop = byAddress[(mbY & ~1) * g.mbWidth + mbX];
    const pairBottom = byAddress[((mbY & ~1) + 1) * g.mbWidth + mbX];
    // Use a uniform coding mode across an MBAFF picture. This makes every
    // horizontal and vertical neighbour live in the same field coordinate
    // system, so thousands of pair-isolating slices are unnecessary.
    const fieldPair = pictureFieldPairs;
    const intra =
      !source || source.skipped ? false : (source.flags & MBFlag.INTRA) !== 0;

    // The IDR opening a random access point has nothing to predict from, so
    // it is the one picture reconstructed in the pixel domain. Its slice is
    // I_PCM throughout, which leaves no neighbour coefficient counts, motion
    // vectors or QP for anything to read back.
    if (ctx.realIdr) {
      ctx.stats.intraMacroblocks++;
      if (ctx.mbaff && mbY % 2 === 0) writer.flag(0); // frame-coded MB pair
      writePcmMacroblock(
        writer,
        "I",
        source && intra
          ? reconstructIntraPcm(source, pic)
          : CONCEALMENT_MACROBLOCK,
      );
      if (mbX === g.mbWidth - 1 && mbY === g.mbHeight - 1) {
        writer.rbspTrailingBits();
        nalParts.push(toNalUnit(writer.bytes(), 3, NalType.SLICE_IDR));
        w = null;
      }
      return;
    }
    const luma: (Int32Array | null)[] = [null, null, null, null];
    let chroma: [ChromaBlockLevels, ChromaBlockLevels] | null = null;
    let qp = prevQp;

    if (
      !fieldPair &&
      source &&
      !source.skipped &&
      ((source.flags & MBFlag.PATTERN) !== 0 || intra)
    ) {
      const quantiserScale =
        QUANTISER_SCALE[pic.coding.qScaleType]![source.quantiserScaleCode]!;
      qp = qpForScale(quantiserScale);
      const matrix = intra ? pic.quant.intra : pic.quant.nonIntra;
      const chromaMatrix = intra
        ? pic.quant.chromaIntra
        : pic.quant.chromaNonIntra;

      for (let b = 0; b < 4; b++) {
        const block = source.blocks[b];
        const target = source.dctType === 1 ? fieldTargets[b]! : targets[b]!;
        target.fill(0);
        if (!block) continue;
        if (intra) {
          intraTargets(
            block,
            matrix,
            quantiserScale,
            pic.coding.intraDcPrecision,
            target,
          );
        } else {
          interTargets(block, matrix, quantiserScale, target);
        }
      }
      if (source.dctType === 1) {
        fieldDctToFrameTargets(
          fieldTargets[0]!,
          fieldTargets[2]!,
          targets[0]!,
          targets[2]!,
        );
        fieldDctToFrameTargets(
          fieldTargets[1]!,
          fieldTargets[3]!,
          targets[1]!,
          targets[3]!,
        );
      }
      for (let b = 0; b < 4; b++) {
        const target = targets[b]!;
        for (let pos = 0; pos < 64; pos++) {
          raster[pos] = quant.levelFor(target[pos]!, qp, pos);
        }
        const out = lumaScratch[b]!;
        if (toZigzag8x8(raster, out)) luma[b] = out;
      }

      const qpC = chromaQp(qp, CHROMA_QP_OFFSET);
      for (let c = 0; c < 2; c++) {
        const block = source.blocks[4 + c];
        if (!block) {
          clearChromaBlockLevels(chromaScratch[c]!);
          continue;
        }
        convertIntraChromaBlock(
          block,
          chromaMatrix,
          quantiserScale,
          pic.coding.intraDcPrecision,
          qpC,
          chromaScratch[c]!,
          intra,
        );
      }
      if (
        chromaScratch[0]!.anyDc ||
        chromaScratch[0]!.anyAc ||
        chromaScratch[1]!.anyDc ||
        chromaScratch[1]!.anyAc
      ) {
        chroma = chromaScratch;
      }
    }

    if (fieldPair) {
      const pairAddress = (mbY >> 1) * g.mbWidth + mbX;
      if (cachedPairAddress !== pairAddress) {
        cachedPairAddress = pairAddress;
        cachedPairTargets = [
          sourceFieldTargets(pairTop!, 0),
          sourceFieldTargets(pairBottom!, 1),
        ];
        // One H.264 field MB combines eight field lines from each of the two
        // vertically adjacent MPEG-2 MBs. Use the finer source QP for both.
        cachedPairQp = Math.min(sourceQp(pairTop!), sourceQp(pairBottom!));
        for (let c = 0; c < 2; c++) {
          const chromaSource = (pairSource: Macroblock) => {
            const sourceIntra = (pairSource.flags & MBFlag.INTRA) !== 0;
            return {
              levels: pairSource.blocks[4 + c] ?? null,
              weightScale: sourceIntra
                ? pic.quant.chromaIntra
                : pic.quant.chromaNonIntra,
              quantiserScale:
                QUANTISER_SCALE[pic.coding.qScaleType]![
                  pairSource.quantiserScaleCode
                ]!,
              intraDcPrecision: pic.coding.intraDcPrecision,
              intra: sourceIntra,
            };
          };
          const upperChroma = chromaSource(pairTop!);
          const lowerChroma = chromaSource(pairBottom!);
          if (upperChroma.levels || lowerChroma.levels) {
            convertFieldChromaPair(
              upperChroma,
              lowerChroma,
              chromaQp(cachedPairQp, CHROMA_QP_OFFSET),
              [pairFieldChroma[0][c]!, pairFieldChroma[1][c]!],
              fieldChromaScratch,
            );
          } else {
            clearChromaBlockLevels(pairFieldChroma[0][c]!);
            clearChromaBlockLevels(pairFieldChroma[1][c]!);
          }
        }
      }
      const [topTargets, bottomTargets] = cachedPairTargets!;
      qp = cachedPairQp;
      luma.fill(null);
      const field = (mbY & 1) as 0 | 1;
      for (let b = 0; b < 4; b++) {
        const selectedSet = b < 2 ? topTargets : bottomTargets;
        const sourceIndex = field * 2 + (b & 1);
        if (!(selectedSet.activeMask & (1 << sourceIndex))) continue;
        const selected = selectedSet.blocks[sourceIndex]!;
        for (let pos = 0; pos < 64; pos++) {
          raster[pos] = quant.levelFor(selected[pos]!, qp, pos);
        }
        const out = lumaScratch[b]!;
        if (toZigzag8x8(raster, out, true)) luma[b] = out;
      }
      const fieldChroma = pairFieldChroma[field];
      chroma =
        fieldChroma[0].anyDc ||
        fieldChroma[0].anyAc ||
        fieldChroma[1].anyDc ||
        fieldChroma[1].anyAc
          ? fieldChroma
          : null;
    }

    if (intra) ctx.stats.intraMacroblocks++;
    else ctx.stats.interMacroblocks++;
    if (fieldPair) countFieldPairVector(source, intra, ctx.layout, ctx.stats);
    const pred = fieldPair
      ? {
          mbType: BMbType.L0_16X16,
          refIdxL0: -1,
          refIdxL1: -1,
          mvL0: [0, 0] as [number, number],
          mvL1: [0, 0] as [number, number],
        }
      : predictionFor(source, intra, ctx.layout, ctx.stats);

    const usesL0 = pred.mbType !== BMbType.L1_16X16;
    const usesL1 = pred.mbType !== BMbType.L0_16X16;
    const predL0 =
      !fieldPair && usesL0
        ? motion.predict(mbX, mbY, 0, pred.refIdxL0)
        : ([0, 0] as [number, number]);
    const predL1 =
      !fieldPair && usesL1
        ? motion.predict(mbX, mbY, 1, pred.refIdxL1)
        : ([0, 0] as [number, number]);

    const splitFrameMb = ctx.mbaff && !ctx.options.iFramesOnly && !fieldPair;
    const fieldPreds = fieldPair
      ? ([pairTop!, pairBottom!].map((partSource) =>
          predictionForField(
            partSource,
            (mbY & 1) as 0 | 1,
            ctx.layout,
            (partSource.flags & MBFlag.INTRA) !== 0,
          ),
        ) as [
          ReturnType<typeof predictionForField>,
          ReturnType<typeof predictionForField>,
        ])
      : undefined;
    const mode =
      pred.mbType === BMbType.L0_16X16
        ? ("L0" as const)
        : pred.mbType === BMbType.L1_16X16
          ? ("L1" as const)
          : ("BI" as const);
    const partitions: InterMacroblock["partitions"] = splitFrameMb
      ? ([0, 1].map((partNumber) => {
          const part = partNumber as 0 | 1;
          const pL0 = usesL0
            ? motion.predict16x8(mbX, mbY, part, 0, pred.refIdxL0)
            : ([0, 0] as [number, number]);
          const pL1 = usesL1
            ? motion.predict16x8(mbX, mbY, part, 1, pred.refIdxL1)
            : ([0, 0] as [number, number]);
          const state = {
            refIdxL0: usesL0 ? pred.refIdxL0 : -1,
            refIdxL1: usesL1 ? pred.refIdxL1 : -1,
            mvL0x: usesL0 ? pred.mvL0[0] : 0,
            mvL0y: usesL0 ? pred.mvL0[1] : 0,
            mvL1x: usesL1 ? pred.mvL1[0] : 0,
            mvL1y: usesL1 ? pred.mvL1[1] : 0,
          };
          motion.set16x8(mbX, mbY, part, state);
          return {
            refIdxL0: state.refIdxL0,
            refIdxL1: state.refIdxL1,
            mvdL0x: usesL0 ? pred.mvL0[0] - pL0[0] : 0,
            mvdL0y: usesL0 ? pred.mvL0[1] - pL0[1] : 0,
            mvdL1x: usesL1 ? pred.mvL1[0] - pL1[0] : 0,
            mvdL1y: usesL1 ? pred.mvL1[1] - pL1[1] : 0,
          };
        }) as InterMacroblock["partitions"])
      : fieldPair
        ? ([pairTop!, pairBottom!].map((_partSource, partNumber) => {
            const field = (mbY & 1) as 0 | 1;
            const part = partNumber as 0 | 1;
            const fieldPred = fieldPreds![part];
            const usesFieldL0 = fieldPred.refIdxL0 >= 0;
            const usesFieldL1 = fieldPred.refIdxL1 >= 0;
            const pL0 = usesFieldL0
              ? fieldMotion[field].predict16x8(
                  mbX,
                  mbY >> 1,
                  part,
                  0,
                  fieldPred.refIdxL0,
                )
              : ([0, 0] as [number, number]);
            const pL1 = usesFieldL1
              ? fieldMotion[field].predict16x8(
                  mbX,
                  mbY >> 1,
                  part,
                  1,
                  fieldPred.refIdxL1,
                )
              : ([0, 0] as [number, number]);
            fieldMotion[field].set16x8(mbX, mbY >> 1, part, {
              refIdxL0: fieldPred.refIdxL0,
              refIdxL1: fieldPred.refIdxL1,
              mvL0x: usesFieldL0 ? fieldPred.mvL0[0] : 0,
              mvL0y: usesFieldL0 ? fieldPred.mvL0[1] : 0,
              mvL1x: usesFieldL1 ? fieldPred.mvL1[0] : 0,
              mvL1y: usesFieldL1 ? fieldPred.mvL1[1] : 0,
            });
            return {
              refIdxL0: fieldPred.refIdxL0,
              refIdxL1: fieldPred.refIdxL1,
              mvdL0x: usesFieldL0 ? fieldPred.mvL0[0] - pL0[0] : 0,
              mvdL0y: usesFieldL0 ? fieldPred.mvL0[1] - pL0[1] : 0,
              mvdL1x: usesFieldL1 ? fieldPred.mvL1[0] - pL1[0] : 0,
              mvdL1y: usesFieldL1 ? fieldPred.mvL1[1] - pL1[1] : 0,
            };
          }) as InterMacroblock["partitions"])
        : undefined;
    const fieldModes = fieldPair
      ? (fieldPreds!.map((p) => {
          return p.mbType === BMbType.L0_16X16
            ? ("L0" as const)
            : p.mbType === BMbType.L1_16X16
              ? ("L1" as const)
              : ("BI" as const);
        }) as ["L0" | "L1" | "BI", "L0" | "L1" | "BI"])
      : undefined;

    const mb: InterMacroblock = {
      mbX,
      mbY: fieldPair ? mbY >> 1 : mbY,
      pSlice: ctx.options.iFramesOnly ?? false,
      mbType: splitFrameMb
        ? b16x8MbType(mode, mode)
        : fieldModes
          ? b16x8MbType(fieldModes[0], fieldModes[1])
          : pred.mbType,
      refIdxL0: pred.refIdxL0,
      refIdxL1: pred.refIdxL1,
      mvdL0x: usesL0 ? pred.mvL0[0] - predL0[0] : 0,
      mvdL0y: usesL0 ? pred.mvL0[1] - predL0[1] : 0,
      mvdL1x: usesL1 ? pred.mvL1[0] - predL1[0] : 0,
      mvdL1y: usesL1 ? pred.mvL1[1] - predL1[1] : 0,
      partitions,
      numRefIdxL0Minus1: fieldPair
        ? ctx.layout.count * 2 - 1
        : ctx.layout.count - 1,
      numRefIdxL1Minus1: fieldPair
        ? ctx.layout.count * 2 - 1
        : ctx.layout.count - 1,
      luma,
      chroma,
      qp,
      prevQp,
    };

    if (!splitFrameMb && !fieldPair) {
      motion.set(mbX, mbY, {
        refIdxL0: usesL0 ? pred.refIdxL0 : -1,
        refIdxL1: usesL1 ? pred.refIdxL1 : -1,
        mvL0x: usesL0 ? pred.mvL0[0] : 0,
        mvL0y: usesL0 ? pred.mvL0[1] : 0,
        mvL1x: usesL1 ? pred.mvL1[0] : 0,
        mvL1y: usesL1 ? pred.mvL1[1] : 0,
      });
    }

    // Every macroblock is coded explicitly. A B_Skip would mean direct mode,
    // whose derived vectors are not the ones the source used.
    writer.ue(0); // mb_skip_run
    if (ctx.mbaff && mbY % 2 === 0) {
      // In P/B slices mb_field_decoding_flag follows mb_skip_run, unlike the
      // I_PCM IDR slice where it immediately precedes mb_type.
      writer.flag(fieldPair);
    }
    const activeCounts = fieldPair ? fieldCounts[(mbY & 1) as 0 | 1] : counts;
    const activeChromaCounts = fieldPair
      ? fieldChromaCounts[(mbY & 1) as 0 | 1]
      : chromaCounts;
    prevQp = writeInterMacroblock(writer, activeCounts, activeChromaCounts, mb);
    if (!luma[0] && !luma[1] && !luma[2] && !luma[3]) {
      markNoCoefficients(activeCounts, mb.mbX, mb.mbY);
    }
    if (!chroma) {
      markNoChromaCoefficients(activeChromaCounts, mb.mbX, mb.mbY);
    }
    const endsSlice = mbX === g.mbWidth - 1 && mbY === g.mbHeight - 1;
    if (endsSlice) {
      writer.rbspTrailingBits();
      nalParts.push(
        toNalUnit(
          writer.bytes(),
          ctx.realIdr ? 3 : ctx.isReference ? 2 : 0,
          ctx.realIdr ? NalType.SLICE_IDR : NalType.SLICE_NON_IDR,
        ),
      );
      w = null;
    }
  };
  for (let position = 0; position < positionCount; position++) {
    writeMacroblock(position);
  }

  const total = nalParts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of nalParts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
