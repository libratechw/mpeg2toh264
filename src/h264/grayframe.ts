/**
 * The all-grey long-term reference frame.
 *
 * H.264 has no "no prediction" macroblock mode short of I_PCM, so an MPEG-2
 * intra macroblock cannot be expressed directly: H.264 intra prediction would
 * subtract a neighbour-derived value that MPEG-2 never added. Reconstructing
 * those neighbours means decoding pixels, which is exactly what this transcoder
 * exists to avoid.
 *
 * The way out is to never use H.264 intra prediction at all. A single frame of
 * uniform 128 is emitted first and kept as a long-term reference; MPEG-2 intra
 * macroblocks then become inter macroblocks with a zero motion vector pointing
 * at it. Prediction is a known constant everywhere, with no dependency on
 * neighbouring reconstruction, and the residual is simply the MPEG-2 block with
 * 128 removed -- in the transform domain, a shift of the DC coefficient alone.
 *
 * Building the grey frame costs almost nothing. Intra_16x16 DC prediction
 * yields 128 with no neighbours available, and (16*128 + 16*128 + 16) >> 5 is
 * also 128, so a picture of prediction-only macroblocks with no residual
 * reconstructs to uniform 128 by induction across the whole frame.
 */
import { BitWriter, NalType, toNalUnit } from "./bitwriter.ts";
import { SliceType, writeSliceHeader } from "./slice.ts";

/**
 * mb_type for I_16x16_2_0_0 (Table 7-11): Intra_16x16 prediction, DC mode,
 * with no coded residual in either luma or chroma.
 */
const MB_TYPE_I16X16_DC_NO_RESIDUAL = 3;

/** intra_chroma_pred_mode 0 is DC, which likewise yields 128. */
const INTRA_CHROMA_PRED_DC = 0;

export interface GrayFrameConfig {
  mbWidth: number;
  mbHeight: number;
  log2MaxFrameNum: number;
  log2MaxPocLsb: number;
  ppsInitQp: number;
  /** True when the SPS signals MBAFF, which adds mb_field_decoding_flag. */
  mbaff: boolean;
  /** Keep grey as a long-term reference; unnecessary when all content is non-reference. */
  longTermReference?: boolean;
}

export function writeGrayIdr(cfg: GrayFrameConfig): Uint8Array {
  const w = new BitWriter(4096);

  writeSliceHeader(w, {
    firstMbInSlice: 0,
    sliceType: SliceType.I,
    frameNum: 0,
    log2MaxFrameNum: cfg.log2MaxFrameNum,
    picOrderCntLsb: 0,
    log2MaxPocLsb: cfg.log2MaxPocLsb,
    idr: true,
    idrPicId: 0,
    reference: true,
    // This is the whole point: keep the frame in the DPB indefinitely.
    longTermReference: cfg.longTermReference ?? true,
    mbaff: cfg.mbaff,
    sliceQp: cfg.ppsInitQp,
    ppsInitQp: cfg.ppsInitQp,
    disableDeblockingFilterIdc: 1,
  });

  const total = cfg.mbWidth * cfg.mbHeight;
  for (let i = 0; i < total; i++) {
    // Under MBAFF the flag is sent once per macroblock pair, on the top
    // macroblock. A uniform frame has no field structure to preserve, so the
    // pairs are coded as frame pairs.
    if (cfg.mbaff && i % 2 === 0) w.flag(0); // mb_field_decoding_flag

    w.ue(MB_TYPE_I16X16_DC_NO_RESIDUAL);
    w.ue(INTRA_CHROMA_PRED_DC);
    w.se(0); // mb_qp_delta

    // An Intra_16x16 macroblock always codes its luma DC block, whatever the
    // coded block pattern says. Every neighbour is likewise empty, so nC is 0
    // throughout and coeff_token for (TotalCoeff 0, TrailingOnes 0) in the
    // 0 <= nC < 2 table is the single bit 1 (Table 9-5).
    w.u(1, 1);
  }

  w.rbspTrailingBits();
  return toNalUnit(w.bytes(), 3, NalType.SLICE_IDR);
}
