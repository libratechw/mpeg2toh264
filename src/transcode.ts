/**
 * MPEG-2 to H.264 transcoding.
 *
 * No pixels are reconstructed anywhere on the luma path: MPEG-2 coefficient
 * levels are dequantised into orthonormal-DCT values and requantised straight
 * into H.264 levels, with no inverse transform, no motion compensation and no
 * reference frame buffer. Chroma is the exception and is documented in
 * h264/chroma.ts.
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
  convertInterFieldChromaBlocks,
  convertIntraChromaBlock,
  makeChromaBlockLevels,
  type ChromaBlockLevels,
} from "./h264/chroma.ts";
import { writeGrayIdr } from "./h264/grayframe.ts";
import {
  BMbType,
  b16x8MbType,
  CoeffCountMap,
  makeChromaCounts,
  makeLumaCounts,
  markNoChromaCoefficients,
  markNoCoefficients,
  toZigzag8x8,
  writeGrayRefMacroblock,
  type ChromaCounts,
  type GrayRefMacroblock,
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

export interface TranscodeOptions {
  oversample?: number;
  /** Convert only MPEG-2 I pictures; P and B pictures are counted as skipped. */
  iFramesOnly?: boolean;
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
  /** The all-grey frame, which intra macroblocks predict from. */
  gray: number;
  /**
   * Set for I and P pictures, where both lists must reach the same picture and
   * list 1's default construction would swap its first two entries.
   */
  forceL1ShortTerm: boolean;
  /** Long-term picture forced to list 0 index 0, used by I-only mode. */
  l0FirstLongTerm?: number;
}

type Stats = Omit<
  TranscodeResult,
  "bitstream" | "picturesConverted" | "picturesSkipped"
>;

export function transcode(
  data: Uint8Array,
  options: TranscodeOptions = DEFAULT_QUANTISER_OPTIONS,
): TranscodeResult {
  const pics = parseElementaryStream(data);
  const first = pics[0];
  if (!first) throw new Error("no pictures in stream");

  const width = first.sequence.horizontalSize;
  const height = first.sequence.verticalSize;
  const mbaff = !first.sequenceExt.progressiveSequence;

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

  const parts: Uint8Array[] = [
    writeSps({
      width,
      height,
      levelIdc: width * height > 720 * 576 ? 40 : 30,
      frameMbsOnly: !mbaff,
      // The grey frame plus the two most recent I or P pictures, which are what
      // a B picture predicts from.
      maxNumRefFrames: 3,
      log2MaxFrameNumMinus4: LOG2_MAX_FRAME_NUM_MINUS4,
      log2MaxPocLsbMinus4: LOG2_MAX_POC_LSB_MINUS4,
      // An MPEG-2 stream codes its anchor picture before the B pictures that
      // display ahead of it, so one picture has to be held back.
      maxNumReorderFrames: 1,
      maxDecFrameBuffering: 4,
    }),
    writePps({
      initQp: PPS_INIT_QP,
      scaling8x8Intra: scaling,
      scaling8x8Inter: scaling,
      chromaQpIndexOffset: CHROMA_QP_OFFSET,
    }),
    writeGrayIdr({
      mbWidth: g.mbWidth,
      mbHeight: g.mbHeight,
      log2MaxFrameNum: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
      log2MaxPocLsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
      ppsInitQp: PPS_INIT_QP,
      mbaff,
      // I-only pictures are non-reference P slices, so this ordinary short-term
      // IDR remains the sole DPB entry without long-term reference machinery.
      longTermReference: !options.iFramesOnly,
    }),
  ];

  const quant = new Quantiser8x8(scaling);
  const counts = makeLumaCounts(g.mbWidth, g.mbHeight);
  const chromaCounts = makeChromaCounts(g.mbWidth, g.mbHeight);
  const motion = new MotionField(g.mbWidth, g.mbHeight);
  const reader = new BitReader(data);

  const stats: Stats = {
    integerVectors: 0,
    singleAxisHalfVectors: 0,
    bothAxisHalfVectors: 0,
    bidirectionalVectors: 0,
    intraMacroblocks: 0,
    interMacroblocks: 0,
  };
  let picturesConverted = 0;
  let picturesSkipped = 0;

  let prevRefFrameNum = 0; // the grey IDR
  let shortTermCount = 0;
  // temporal_reference restarts at each group of pictures, so display order is
  // recovered by accumulating a base as the counter wraps.
  let gopBase = 0;
  let seenPicture = false;
  let maxTrInGop = 0;

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
    // In I-only mode every content picture depends solely on the long-term
    // grey IDR. Keeping content pictures as references only makes the grey
    // frame move through the default reference list, and serves no purpose.
    const isReference = !options.iFramesOnly && type !== PictureType.B;

    const layout: RefLayout = options.iFramesOnly
      ? {
          count: 1,
          fwdL0: 0,
          fwdL1: 0,
          bwdL0: -1,
          bwdL1: -1,
          gray: 0,
          forceL1ShortTerm: false,
        }
      : type === PictureType.B
        ? {
            // A B picture sits between its two references, so list 0 defaults to
            // [forward, backward, grey] and list 1 to [backward, forward, grey].
            count: 3,
            fwdL0: 0,
            fwdL1: 1,
            bwdL0: 1,
            bwdL1: 0,
            gray: 2,
            forceL1ShortTerm: false,
          }
        : {
            count: shortTermCount + 1,
            fwdL0: 0,
            fwdL1: 0,
            bwdL0: -1,
            bwdL1: -1,
            gray: shortTermCount,
            forceL1ShortTerm: shortTermCount > 0,
          };

    const frameNum = (prevRefFrameNum + 1) % MAX_FRAME_NUM;
    parts.push(
      writePicture(reader, pic, g, quant, counts, chromaCounts, motion, {
        frameNum,
        // The grey frame is the IDR at POC 0, so content starts past it.
        poc: 2 * (gopBase + tr) + 2,
        isReference,
        layout,
        options,
        mbaff,
        stats,
      }),
    );
    if (isReference) {
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
  return { bitstream, picturesConverted, picturesSkipped, ...stats };
}

interface PictureContext {
  frameNum: number;
  poc: number;
  isReference: boolean;
  layout: RefLayout;
  options: TranscodeOptions;
  mbaff: boolean;
  stats: Stats;
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
    // Intra macroblocks predict from the grey frame, which stands in for H.264
    // intra prediction; see h264/grayframe.ts.
    return {
      mbType: BMbType.L0_16X16,
      refIdxL0: layout.gray,
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

/** Prediction for one field of an MPEG-2 field-motion macroblock. */
function predictionForField(
  mb: Macroblock,
  field: 0 | 1,
  layout: RefLayout,
): Prediction {
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

function writePicture(
  reader: BitReader,
  pic: Picture,
  g: ReturnType<typeof frameGeometry>,
  quant: Quantiser8x8,
  counts: CoeffCountMap,
  chromaCounts: ChromaCounts,
  motion: MotionField,
  ctx: PictureContext,
): Uint8Array {
  const geo = pictureGeometry(pic);
  const nalParts: Uint8Array[] = [];

  const byAddress = new Map<number, Macroblock>();
  for (const slice of pic.slices) {
    for (const mb of decodeSlice(reader, pic, slice, geo.mbWidth)) {
      byAddress.set(mb.address, mb);
    }
  }

  const targets = Array.from({ length: 4 }, () => new Float64Array(64));
  const fieldTargets = Array.from({ length: 4 }, () => new Float64Array(64));
  const raster = new Int32Array(64);
  const chromaScratch: [ChromaBlockLevels, ChromaBlockLevels] = [
    makeChromaBlockLevels(),
    makeChromaBlockLevels(),
  ];
  const fieldMotion: [MotionField, MotionField] = [
    new MotionField(1, 1),
    new MotionField(1, 1),
  ];
  let prevQp = PPS_INIT_QP;
  let w: BitWriter | null = null;

  // MBAFF addresses macroblocks pair-by-pair: top then bottom at one X,
  // followed by the next pair horizontally. Frame-only pictures use raster
  // order. Coordinates remain spatial so coefficient and MV neighbour lookup
  // does not otherwise change for frame-coded pairs.
  const positions: [number, number][] = [];
  if (ctx.mbaff) {
    for (let pairY = 0; pairY < g.mbHeight; pairY += 2) {
      for (let mbX = 0; mbX < g.mbWidth; mbX++) {
        positions.push([mbX, pairY], [mbX, pairY + 1]);
      }
    }
  } else {
    for (let mbY = 0; mbY < g.mbHeight; mbY++) {
      for (let mbX = 0; mbX < g.mbWidth; mbX++) positions.push([mbX, mbY]);
    }
  }

  for (const [mbX, mbY] of positions) {
    const startsSlice = !ctx.mbaff ? w === null : mbY % 2 === 0;
    if (startsSlice) {
      counts.reset();
      chromaCounts.cb.reset();
      chromaCounts.cr.reset();
      motion.reset();
      fieldMotion[0].reset();
      fieldMotion[1].reset();
      prevQp = PPS_INIT_QP;
      w = new BitWriter(ctx.mbaff ? 4096 : 1 << 18);
      writeSliceHeader(w, {
        firstMbInSlice: ctx.mbaff ? (mbY >> 1) * g.mbWidth + mbX : 0,
        // I-only pictures need no bi-prediction. P slices are simpler and much
        // more widely handled than a stream consisting solely of reference-less B
        // pictures, while still predicting every source intra MB from grey.
        sliceType: ctx.options.iFramesOnly ? SliceType.P : SliceType.B,
        frameNum: ctx.frameNum,
        log2MaxFrameNum: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
        picOrderCntLsb: ctx.poc,
        log2MaxPocLsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
        idr: false,
        reference: ctx.isReference,
        mbaff: ctx.mbaff,
        sliceQp: PPS_INIT_QP,
        ppsInitQp: PPS_INIT_QP,
        disableDeblockingFilterIdc: 1,
        numRefIdxL0Active: ctx.layout.count,
        numRefIdxL1Active: ctx.layout.count,
        l1FirstShortTermDelta: ctx.layout.forceL1ShortTerm ? 1 : undefined,
        l0FirstLongTerm: ctx.layout.l0FirstLongTerm,
      });
    }
    const writer = w!;
    const source = byAddress.get(mbY * g.mbWidth + mbX);
    const pairTop = byAddress.get((mbY & ~1) * g.mbWidth + mbX);
    const pairBottom = byAddress.get(((mbY & ~1) + 1) * g.mbWidth + mbX);
    const isInter = (mb: Macroblock | undefined) =>
      !!mb && (mb.flags & MBFlag.INTRA) === 0;
    const fieldPair =
      ctx.mbaff &&
      (pairTop?.motionType === MotionType.FIELD ||
        pairBottom?.motionType === MotionType.FIELD) &&
      isInter(pairTop) &&
      isInter(pairBottom);
    const intra =
      !source || source.skipped ? false : (source.flags & MBFlag.INTRA) !== 0;
    const luma: (Int32Array | null)[] = [null, null, null, null];
    let chroma: [ChromaBlockLevels, ChromaBlockLevels] | null = null;
    let qp = prevQp;

    if (
      source &&
      !source.skipped &&
      ((source.flags & MBFlag.PATTERN) !== 0 || intra)
    ) {
      const quantiserScale =
        QUANTISER_SCALE[pic.coding.qScaleType]![source.quantiserScaleCode]!;
      qp = quant.chooseQp(
        quantiserScale,
        ctx.options.oversample ?? DEFAULT_QUANTISER_OPTIONS.oversample,
      );
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
        const out = new Int32Array(64);
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
      const sourceFieldTargets = (fieldSource: Macroblock) => {
        const raw = Array.from({ length: 4 }, () => new Float64Array(64));
        const converted = Array.from({ length: 4 }, () => new Float64Array(64));
        const quantiserScale =
          QUANTISER_SCALE[pic.coding.qScaleType]![
            fieldSource.quantiserScaleCode
          ]!;
        for (let b = 0; b < 4; b++) {
          const block = fieldSource.blocks[b];
          if (block)
            interTargets(block, pic.quant.nonIntra, quantiserScale, raw[b]!);
        }
        if (fieldSource.dctType === 1) return raw;
        frameDctToFieldTargets(raw[0]!, raw[2]!, converted[0]!, converted[2]!);
        frameDctToFieldTargets(raw[1]!, raw[3]!, converted[1]!, converted[3]!);
        return converted;
      };
      const topTargets = sourceFieldTargets(pairTop!);
      const bottomTargets = sourceFieldTargets(pairBottom!);
      const sourceQp = (fieldSource: Macroblock) => {
        const scale =
          QUANTISER_SCALE[pic.coding.qScaleType]![
            fieldSource.quantiserScaleCode
          ]!;
        return quant.chooseQp(
          scale,
          ctx.options.oversample ?? DEFAULT_QUANTISER_OPTIONS.oversample,
        );
      };
      // One H.264 field MB combines eight field lines from each of the two
      // vertically adjacent MPEG-2 MBs. Use the finer source QP for both.
      qp = Math.min(sourceQp(pairTop!), sourceQp(pairBottom!));
      luma.fill(null);
      const field = (mbY & 1) as 0 | 1;
      const selected = [
        topTargets[field * 2]!,
        topTargets[field * 2 + 1]!,
        bottomTargets[field * 2]!,
        bottomTargets[field * 2 + 1]!,
      ];
      for (let b = 0; b < 4; b++) {
        for (let pos = 0; pos < 64; pos++) {
          raster[pos] = quant.levelFor(selected[b]![pos]!, qp, pos);
        }
        const out = new Int32Array(64);
        if (toZigzag8x8(raster, out)) luma[b] = out;
      }
      for (let c = 0; c < 2; c++) {
        clearChromaBlockLevels(chromaScratch[c]!);
        convertInterFieldChromaBlocks(
          pairTop!.blocks[4 + c] ?? null,
          pairBottom!.blocks[4 + c] ?? null,
          pic.quant.chromaNonIntra,
          QUANTISER_SCALE[pic.coding.qScaleType]![pairTop!.quantiserScaleCode]!,
          QUANTISER_SCALE[pic.coding.qScaleType]![
            pairBottom!.quantiserScaleCode
          ]!,
          field,
          chromaQp(qp, CHROMA_QP_OFFSET),
          chromaScratch[c]!,
        );
      }
      chroma =
        chromaScratch[0]!.anyDc ||
        chromaScratch[0]!.anyAc ||
        chromaScratch[1]!.anyDc ||
        chromaScratch[1]!.anyAc
          ? chromaScratch
          : null;
    }

    if (intra) ctx.stats.intraMacroblocks++;
    else ctx.stats.interMacroblocks++;
    const pred = predictionFor(source, intra, ctx.layout, ctx.stats);

    const usesL0 = pred.mbType !== BMbType.L1_16X16;
    const usesL1 = pred.mbType !== BMbType.L0_16X16;
    const predL0 = usesL0
      ? motion.predict(mbX, mbY, 0, pred.refIdxL0)
      : ([0, 0] as [number, number]);
    const predL1 = usesL1
      ? motion.predict(mbX, mbY, 1, pred.refIdxL1)
      : ([0, 0] as [number, number]);

    const splitFrameMb = ctx.mbaff && !ctx.options.iFramesOnly && !fieldPair;
    const mode =
      pred.mbType === BMbType.L0_16X16
        ? ("L0" as const)
        : pred.mbType === BMbType.L1_16X16
          ? ("L1" as const)
          : ("BI" as const);
    const partitions: GrayRefMacroblock["partitions"] = splitFrameMb
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
        }) as GrayRefMacroblock["partitions"])
      : fieldPair
        ? ([pairTop!, pairBottom!].map((partSource, partNumber) => {
            const field = (mbY & 1) as 0 | 1;
            const part = partNumber as 0 | 1;
            const fieldPred = predictionForField(partSource, field, ctx.layout);
            const usesFieldL0 = fieldPred.refIdxL0 >= 0;
            const usesFieldL1 = fieldPred.refIdxL1 >= 0;
            const pL0 = usesFieldL0
              ? fieldMotion[field].predict16x8(
                  0,
                  0,
                  part,
                  0,
                  fieldPred.refIdxL0,
                )
              : ([0, 0] as [number, number]);
            const pL1 = usesFieldL1
              ? fieldMotion[field].predict16x8(
                  0,
                  0,
                  part,
                  1,
                  fieldPred.refIdxL1,
                )
              : ([0, 0] as [number, number]);
            fieldMotion[field].set16x8(0, 0, part, {
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
          }) as GrayRefMacroblock["partitions"])
        : undefined;
    const fieldModes = fieldPair
      ? ([pairTop!, pairBottom!].map((partSource) => {
          const p = predictionForField(
            partSource,
            (mbY & 1) as 0 | 1,
            ctx.layout,
          );
          return p.mbType === BMbType.L0_16X16
            ? ("L0" as const)
            : p.mbType === BMbType.L1_16X16
              ? ("L1" as const)
              : ("BI" as const);
        }) as ["L0" | "L1" | "BI", "L0" | "L1" | "BI"])
      : undefined;

    const mb: GrayRefMacroblock = {
      mbX,
      mbY,
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

    if (!splitFrameMb) {
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
      // I-slice grey frame where it immediately precedes mb_type.
      writer.flag(fieldPair);
    }
    if (fieldPair && mbY % 2 === 1) {
      // The two field macroblocks occupy the same spatial area in opposite
      // fields.  The top-field coefficients are therefore unavailable as
      // CAVLC neighbours of the bottom-field macroblock.
      counts.reset();
      chromaCounts.cb.reset();
      chromaCounts.cr.reset();
    }
    prevQp = writeGrayRefMacroblock(writer, counts, chromaCounts, mb);
    if (!luma[0] && !luma[1] && !luma[2] && !luma[3]) {
      markNoCoefficients(counts, mbX, mbY);
    }
    if (!chroma) markNoChromaCoefficients(chromaCounts, mbX, mbY);
    const endsSlice = !ctx.mbaff
      ? mbX === g.mbWidth - 1 && mbY === g.mbHeight - 1
      : mbY % 2 === 1;
    if (endsSlice) {
      writer.rbspTrailingBits();
      nalParts.push(
        toNalUnit(
          writer.bytes(),
          ctx.isReference ? 2 : 0,
          NalType.SLICE_NON_IDR,
        ),
      );
      w = null;
    }
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
