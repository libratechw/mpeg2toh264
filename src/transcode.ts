/**
 * MPEG-2 to H.264 transcoding, luma intra path.
 *
 * No pixels are reconstructed anywhere: MPEG-2 coefficient levels are
 * dequantised into orthonormal-DCT values, the grey prediction is removed from
 * the DC, and the result is requantised straight into H.264 coefficient levels.
 * There is no inverse transform and no motion compensation.
 */
import { BitReader } from "./bitreader.ts";
import { PictureType, QUANTISER_SCALE } from "./mpeg2/constants.ts";
import {
  parseElementaryStream,
  pictureGeometry,
  type Picture,
} from "./mpeg2/headers.ts";
import { decodeSlice, type Macroblock } from "./mpeg2/macroblock.ts";
import { BitWriter, NalType, toNalUnit } from "./h264/bitwriter.ts";
import { writeGrayIdr } from "./h264/grayframe.ts";
import {
  CoeffCountMap,
  makeChromaCounts,
  makeLumaCounts,
  markNoCoefficients,
  markNoChromaCoefficients,
  toZigzag8x8,
  writeGrayRefMacroblock,
  type ChromaCounts,
  type GrayRefMacroblock,
} from "./h264/mb.ts";
import {
  chromaQp,
  convertIntraChromaBlock,
  makeChromaBlockLevels,
  type ChromaBlockLevels,
} from "./h264/chroma.ts";
import { frameGeometry, writePps, writeSps } from "./h264/params.ts";
import {
  DEFAULT_QUANTISER_OPTIONS,
  Quantiser8x8,
  intraTargets,
} from "./h264/quant.ts";
import { SliceType, writeSliceHeader } from "./h264/slice.ts";

const LOG2_MAX_FRAME_NUM_MINUS4 = 4;
// The largest the syntax allows. Output pictures are not reference pictures, so
// the picture order count never gets a fresh baseline to count from, and a wide
// field keeps it monotonic for long sequences.
const LOG2_MAX_POC_LSB_MINUS4 = 12;
const PPS_INIT_QP = 26;

export interface TranscodeOptions {
  /** See QuantiserOptions.oversample. */
  oversample: number;
}

export interface TranscodeResult {
  bitstream: Uint8Array;
  picturesConverted: number;
  picturesSkipped: number;
  /** Largest absolute difference between a target coefficient and what the
   *  chosen level reconstructs, in orthonormal-DCT units. */
  worstCoefficientError: number;
}

/**
 * Convert the I pictures of an MPEG-2 elementary stream. P and B pictures are
 * skipped for now: they need the motion vector mapping, which is separate work.
 */
export function transcodeIntraOnly(
  data: Uint8Array,
  options: TranscodeOptions = DEFAULT_QUANTISER_OPTIONS,
): TranscodeResult {
  const pics = parseElementaryStream(data);
  const first = pics[0];
  if (!first) throw new Error("no pictures in stream");

  const width = first.sequence.horizontalSize;
  const height = first.sequence.verticalSize;
  const g = frameGeometry(width, height, true);

  const parts: Uint8Array[] = [
    writeSps({
      width,
      height,
      levelIdc: width * height > 720 * 576 ? 40 : 30,
      frameMbsOnly: true,
      maxNumRefFrames: 2,
      log2MaxFrameNumMinus4: LOG2_MAX_FRAME_NUM_MINUS4,
      log2MaxPocLsbMinus4: LOG2_MAX_POC_LSB_MINUS4,
    }),
    writePps({
      initQp: PPS_INIT_QP,
      scaling8x8Intra: first.quant.intra,
      scaling8x8Inter: first.quant.intra,
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

  // The scaling list sent in the PPS is the MPEG-2 intra matrix, so the
  // quantiser is built from the same weights the decoder will apply.
  const quant = new Quantiser8x8(first.quant.intra);
  const counts = makeLumaCounts(g.mbWidth, g.mbHeight);
  const chromaCounts = makeChromaCounts(g.mbWidth, g.mbHeight);
  const reader = new BitReader(data);

  let converted = 0;
  let skipped = 0;
  let poc = 0;
  let worstError = 0;

  for (const pic of pics) {
    if (pic.header.pictureCodingType !== PictureType.I) {
      skipped++;
      continue;
    }
    const result = writeIntraPicture(
      reader,
      pic,
      g,
      quant,
      counts,
      chromaCounts,
      poc,
      options,
    );
    parts.push(result.nal);
    worstError = Math.max(worstError, result.worstError);
    converted++;
    poc += 2;
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const bitstream = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bitstream.set(p, at);
    at += p.length;
  }

  return {
    bitstream,
    picturesConverted: converted,
    picturesSkipped: skipped,
    worstCoefficientError: worstError,
  };
}

function writeIntraPicture(
  reader: BitReader,
  pic: Picture,
  g: ReturnType<typeof frameGeometry>,
  quant: Quantiser8x8,
  counts: CoeffCountMap,
  chromaCounts: ChromaCounts,
  poc: number,
  options: TranscodeOptions,
): { nal: Uint8Array; worstError: number } {
  const geo = pictureGeometry(pic);
  const w = new BitWriter(1 << 16);
  counts.reset();
  chromaCounts.cb.reset();
  chromaCounts.cr.reset();

  // One slice per picture: the source's slice structure carries no information
  // the output needs, and a single slice keeps neighbour availability simple.
  writeSliceHeader(w, {
    firstMbInSlice: 0,
    sliceType: SliceType.P,
    frameNum: 0,
    log2MaxFrameNum: LOG2_MAX_FRAME_NUM_MINUS4 + 4,
    picOrderCntLsb: poc,
    log2MaxPocLsb: LOG2_MAX_POC_LSB_MINUS4 + 4,
    idr: false,
    reference: false,
    mbaff: false,
    sliceQp: PPS_INIT_QP,
    ppsInitQp: PPS_INIT_QP,
    disableDeblockingFilterIdc: 1,
  });

  // Gather the whole picture's macroblocks first, so they can be emitted in
  // raster order regardless of how the source sliced them.
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
  let worstError = 0;
  // In a CAVLC P slice every coded macroblock is preceded by a count of the
  // skipped ones before it. A macroblock with no coefficients is exactly a
  // P_Skip here -- zero predicted vector, the grey reference, no residual --
  // so folding those into the run is both correct and cheaper than coding them.
  let skipRun = 0;

  for (let mbY = 0; mbY < g.mbHeight; mbY++) {
    for (let mbX = 0; mbX < g.mbWidth; mbX++) {
      const source = byAddress.get(mbY * g.mbWidth + mbX);
      const luma: (Int32Array | null)[] = [null, null, null, null];
      let chroma: [ChromaBlockLevels, ChromaBlockLevels] | null = null;
      let qp = prevQp;

      if (source && !source.skipped) {
        const quantiserScale =
          QUANTISER_SCALE[pic.coding.qScaleType]![source.quantiserScaleCode]!;
        qp = quant.chooseQp(quantiserScale, options.oversample);

        for (let b = 0; b < 4; b++) {
          const block = source.blocks[b];
          if (!block) continue;
          intraTargets(
            block,
            quant.weightScale,
            quantiserScale,
            pic.coding.intraDcPrecision,
            targets,
          );
          for (let pos = 0; pos < 64; pos++) {
            const level = quant.levelFor(targets[pos]!, qp, pos);
            raster[pos] = level;
            const err = Math.abs(targets[pos]! - level * quant.gainAt(qp, pos));
            if (err > worstError) worstError = err;
          }
          const out = new Int32Array(64);
          if (toZigzag8x8(raster, out)) luma[b] = out;
        }

        // MPEG-2 blocks 4 and 5 are Cb and Cr, each a single 8x8 DCT that has
        // to be re-expressed as four 4x4 transforms plus a 2x2 DC block.
        const qpC = chromaQp(qp);
        for (let c = 0; c < 2; c++) {
          const block = source.blocks[4 + c];
          if (!block) continue;
          convertIntraChromaBlock(
            block,
            pic.quant.chromaIntra,
            quantiserScale,
            pic.coding.intraDcPrecision,
            qpC,
            chromaScratch[c]!,
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

      if (!luma[0] && !luma[1] && !luma[2] && !luma[3] && !chroma) {
        skipRun++;
        markNoCoefficients(counts, mbX, mbY);
        markNoChromaCoefficients(chromaCounts, mbX, mbY);
        continue;
      }

      w.ue(skipRun);
      skipRun = 0;
      const mb: GrayRefMacroblock = { mbX, mbY, luma, chroma, qp, prevQp };
      prevQp = writeGrayRefMacroblock(w, counts, chromaCounts, mb);
    }
  }

  // Trailing skipped macroblocks are carried by a final run; more_rbsp_data()
  // then reports no further macroblocks.
  if (skipRun > 0) w.ue(skipRun);

  w.rbspTrailingBits();
  // Not a reference picture: the grey frame stays the only entry in the DPB.
  return { nal: toNalUnit(w.bytes(), 0, NalType.SLICE_NON_IDR), worstError };
}
