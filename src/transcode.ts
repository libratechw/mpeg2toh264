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
import { MBFlag, PictureType, QUANTISER_SCALE } from "./mpeg2/constants.ts";
import {
  parseElementaryStream,
  pictureGeometry,
  type Picture,
} from "./mpeg2/headers.ts";
import { decodeSlice, type Macroblock } from "./mpeg2/macroblock.ts";
import { BitWriter, NalType, toNalUnit } from "./h264/bitwriter.ts";
import {
  chromaQp,
  clearChromaBlockLevels,
  convertIntraChromaBlock,
  makeChromaBlockLevels,
  type ChromaBlockLevels,
} from "./h264/chroma.ts";
import { writeGrayIdr } from "./h264/grayframe.ts";
import {
  BMbType,
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
import { mapForwardVector } from "./h264/mvmap.ts";
import { MotionField } from "./h264/mvpred.ts";
import { frameGeometry, writePps, writeSps } from "./h264/params.ts";
import {
  DEFAULT_QUANTISER_OPTIONS,
  Quantiser8x8,
  interTargets,
  intraTargets,
} from "./h264/quant.ts";
import { SliceType, writeSliceHeader } from "./h264/slice.ts";

const LOG2_MAX_FRAME_NUM_MINUS4 = 4;
const LOG2_MAX_POC_LSB_MINUS4 = 12;
const PPS_INIT_QP = 26;
/**
 * Chroma is quantised finer than luma. Its conversion runs through an inverse
 * and a forward transform plus the 2x2 DC Hadamard, so it accumulates more
 * rounding than luma's direct coefficient mapping, and that error compounds
 * along a chain of predicted pictures.
 */
const CHROMA_QP_OFFSET = -6;
const MAX_FRAME_NUM = 1 << (LOG2_MAX_FRAME_NUM_MINUS4 + 4);

export interface TranscodeOptions {
  /** See QuantiserOptions.oversample. */
  oversample: number;
}

export interface TranscodeResult {
  bitstream: Uint8Array;
  picturesConverted: number;
  picturesSkipped: number;
  /** Macroblocks whose half-sample position could not be mapped exactly. */
  inexactVectors: number;
  intraMacroblocks: number;
  interMacroblocks: number;
}

/**
 * Convert the I and P pictures of an MPEG-2 elementary stream. B pictures need
 * two simultaneous references and are not handled yet.
 */
export function transcode(
  data: Uint8Array,
  options: TranscodeOptions = DEFAULT_QUANTISER_OPTIONS,
): TranscodeResult {
  const pics = parseElementaryStream(data);
  const first = pics[0];
  if (!first) throw new Error("no pictures in stream");

  const width = first.sequence.horizontalSize;
  const height = first.sequence.verticalSize;
  const g = frameGeometry(width, height, true);

  // Both 8x8 scaling lists carry the MPEG-2 non-intra matrix. Every macroblock
  // is coded as inter, so the inter list is the one the decoder applies; which
  // matrix it holds affects only how efficiently levels are represented, since
  // the mapping divides by the gain that same list produces.
  const scaling = first.quant.nonIntra;

  const parts: Uint8Array[] = [
    writeSps({
      width,
      height,
      levelIdc: width * height > 720 * 576 ? 40 : 30,
      frameMbsOnly: true,
      // The grey frame plus the most recent I or P picture.
      maxNumRefFrames: 2,
      log2MaxFrameNumMinus4: LOG2_MAX_FRAME_NUM_MINUS4,
      log2MaxPocLsbMinus4: LOG2_MAX_POC_LSB_MINUS4,
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
      mbaff: false,
    }),
  ];

  const quant = new Quantiser8x8(scaling);
  const counts = makeLumaCounts(g.mbWidth, g.mbHeight);
  const chromaCounts = makeChromaCounts(g.mbWidth, g.mbHeight);
  const motion = new MotionField(g.mbWidth, g.mbHeight);
  const reader = new BitReader(data);

  const stats = {
    picturesConverted: 0,
    picturesSkipped: 0,
    inexactVectors: 0,
    intraMacroblocks: 0,
    interMacroblocks: 0,
  };

  // The grey IDR is frame_num 0; each converted picture is a reference and
  // takes the next value.
  let frameNum = 0;
  let poc = 0;
  let havePrevPicture = false;

  for (const pic of pics) {
    const type = pic.header.pictureCodingType;
    if (type !== PictureType.I && type !== PictureType.P) {
      stats.picturesSkipped++;
      continue;
    }
    frameNum = (frameNum + 1) % MAX_FRAME_NUM;
    poc += 2;
    parts.push(
      writePicture(reader, pic, g, quant, counts, chromaCounts, motion, {
        frameNum,
        poc,
        havePrevPicture,
        options,
        stats,
      }),
    );
    havePrevPicture = true;
    stats.picturesConverted++;
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const bitstream = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bitstream.set(p, at);
    at += p.length;
  }
  return { bitstream, ...stats };
}

interface PictureContext {
  frameNum: number;
  poc: number;
  /** False for the first converted picture, where only the grey frame exists. */
  havePrevPicture: boolean;
  options: TranscodeOptions;
  stats: {
    inexactVectors: number;
    intraMacroblocks: number;
    interMacroblocks: number;
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
  const w = new BitWriter(1 << 18);
  counts.reset();
  chromaCounts.cb.reset();
  chromaCounts.cr.reset();
  motion.reset();

  // Reference list layout. Without a previous picture only the grey frame is
  // present; otherwise list 0 defaults to [previous, grey] and list 1 is forced
  // to match, since its default construction would swap the two.
  const refCount = ctx.havePrevPicture ? 2 : 1;
  const grayIdx = ctx.havePrevPicture ? 1 : 0;
  const prevIdx = 0;

  writeSliceHeader(w, {
    firstMbInSlice: 0,
    sliceType: SliceType.B,
    frameNum: ctx.frameNum,
    log2MaxFrameNum: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
    picOrderCntLsb: ctx.poc,
    log2MaxPocLsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
    idr: false,
    reference: true,
    mbaff: false,
    sliceQp: PPS_INIT_QP,
    ppsInitQp: PPS_INIT_QP,
    disableDeblockingFilterIdc: 1,
    numRefIdxL0Active: refCount,
    numRefIdxL1Active: refCount,
    l1FirstShortTermDelta: ctx.havePrevPicture ? 1 : undefined,
  });

  const byAddress = new Map<number, Macroblock>();
  for (const slice of pic.slices) {
    for (const mb of decodeSlice(reader, pic, slice, geo.mbWidth)) {
      byAddress.set(mb.address, mb);
    }
  }

  const targets = new Float64Array(64);
  const raster = new Int32Array(64);
  const chromaScratch: [ChromaBlockLevels, ChromaBlockLevels] = [
    makeChromaBlockLevels(),
    makeChromaBlockLevels(),
  ];
  let prevQp = PPS_INIT_QP;

  for (let mbY = 0; mbY < g.mbHeight; mbY++) {
    for (let mbX = 0; mbX < g.mbWidth; mbX++) {
      const source = byAddress.get(mbY * g.mbWidth + mbX);
      const intra =
        !source || source.skipped ? false : (source.flags & MBFlag.INTRA) !== 0;
      const luma: (Int32Array | null)[] = [null, null, null, null];
      let chroma: [ChromaBlockLevels, ChromaBlockLevels] | null = null;
      let qp = prevQp;

      if (
        source &&
        !source.skipped &&
        (source.flags & MBFlag.PATTERN || intra)
      ) {
        const quantiserScale =
          QUANTISER_SCALE[pic.coding.qScaleType]![source.quantiserScaleCode]!;
        qp = quant.chooseQp(quantiserScale, ctx.options.oversample);
        const matrix = intra ? pic.quant.intra : pic.quant.nonIntra;
        const chromaMatrix = intra
          ? pic.quant.chromaIntra
          : pic.quant.chromaNonIntra;

        for (let b = 0; b < 4; b++) {
          const block = source.blocks[b];
          if (!block) continue;
          if (intra) {
            intraTargets(
              block,
              matrix,
              quantiserScale,
              pic.coding.intraDcPrecision,
              targets,
            );
          } else {
            interTargets(block, matrix, quantiserScale, targets);
          }
          for (let pos = 0; pos < 64; pos++) {
            raster[pos] = quant.levelFor(targets[pos]!, qp, pos);
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

      // Map the source's motion onto H.264 prediction.
      const mapped = intra
        ? {
            mbType: BMbType.L0_16X16,
            l0: [0, 0] as [number, number],
            l1: null,
            exact: true,
          }
        : mapForwardVector(source?.mv[0] ?? 0, source?.mv[1] ?? 0);
      if (!mapped.exact) ctx.stats.inexactVectors++;
      if (intra) ctx.stats.intraMacroblocks++;
      else ctx.stats.interMacroblocks++;

      const refIdxL0 = intra ? grayIdx : prevIdx;
      const refIdxL1 = intra ? -1 : prevIdx;
      const predL0 = motion.predict(mbX, mbY, 0, refIdxL0);
      const predL1 =
        mapped.l1 !== null
          ? motion.predict(mbX, mbY, 1, refIdxL1)
          : ([0, 0] as [number, number]);

      const mb: GrayRefMacroblock = {
        mbX,
        mbY,
        mbType: mapped.mbType,
        refIdxL0,
        refIdxL1: mapped.l1 !== null ? refIdxL1 : -1,
        mvdL0x: mapped.l0[0] - predL0[0],
        mvdL0y: mapped.l0[1] - predL0[1],
        mvdL1x: mapped.l1 !== null ? mapped.l1[0] - predL1[0] : 0,
        mvdL1y: mapped.l1 !== null ? mapped.l1[1] - predL1[1] : 0,
        numRefIdxL0Minus1: refCount - 1,
        numRefIdxL1Minus1: refCount - 1,
        luma,
        chroma,
        qp,
        prevQp,
      };

      motion.set(mbX, mbY, {
        refIdxL0,
        refIdxL1: mapped.l1 !== null ? refIdxL1 : -1,
        mvL0x: mapped.l0[0],
        mvL0y: mapped.l0[1],
        mvL1x: mapped.l1 !== null ? mapped.l1[0] : 0,
        mvL1y: mapped.l1 !== null ? mapped.l1[1] : 0,
      });

      // Every macroblock is coded explicitly. A B_Skip would mean direct mode,
      // whose derived vectors are not the ones the source used.
      w.ue(0); // mb_skip_run
      prevQp = writeGrayRefMacroblock(w, counts, chromaCounts, mb);
      if (!luma[0] && !luma[1] && !luma[2] && !luma[3]) {
        markNoCoefficients(counts, mbX, mbY);
      }
      if (!chroma) markNoChromaCoefficients(chromaCounts, mbX, mbY);
    }
  }

  w.rbspTrailingBits();
  return toNalUnit(w.bytes(), 2, NalType.SLICE_NON_IDR);
}
