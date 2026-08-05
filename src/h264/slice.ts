/**
 * H.264 slice headers (clause 7.3.3).
 */
import type { BitWriter } from "./bitwriter.ts";

/**
 * slice_type values. The +5 forms additionally assert that every slice in the
 * picture has the same type, which is always true here.
 */
export const SliceType = {
  P: 5,
  B: 6,
  I: 7,
} as const;
export type SliceTypeValue = (typeof SliceType)[keyof typeof SliceType];

export interface SliceHeaderConfig {
  firstMbInSlice: number;
  sliceType: SliceTypeValue;
  frameNum: number;
  /** Bit width of frame_num, i.e. log2_max_frame_num_minus4 + 4. */
  log2MaxFrameNum: number;
  picOrderCntLsb: number;
  log2MaxPocLsb: number;
  /** True for an IDR picture, which changes which header fields appear. */
  idr: boolean;
  idrPicId?: number;
  /**
   * IDR only. Marks the picture as a long-term reference with
   * LongTermFrameIdx 0, which is how the all-grey frame is kept in the decoded
   * picture buffer for the rest of the stream.
   */
  longTermReference?: boolean;
  /** Set when the source is interlaced, i.e. frame_mbs_only_flag is 0. */
  mbaff: boolean;
  /**
   * Whether the picture is a reference, i.e. nal_ref_idc is non-zero. It
   * governs whether dec_ref_pic_marking appears at all, so it has to match the
   * NAL header exactly.
   */
  reference: boolean;
  /** QP for the slice, carried as slice_qp_delta against the PPS initial QP. */
  sliceQp: number;
  ppsInitQp: number;
  /**
   * 1 disables the loop filter. MPEG-2 has no in-loop filter, so leaving
   * H.264's on would change every reconstructed picture.
   */
  disableDeblockingFilterIdc: number;
  /** Number of active L0 references, when it differs from the PPS default. */
  numRefIdxL0Active?: number;
  numRefIdxL1Active?: number;
}

export function writeSliceHeader(w: BitWriter, cfg: SliceHeaderConfig): void {
  w.ue(cfg.firstMbInSlice);
  w.ue(cfg.sliceType);
  w.ue(0); // pic_parameter_set_id
  w.u(cfg.log2MaxFrameNum, cfg.frameNum);

  if (cfg.mbaff) {
    // field_pic_flag: always a frame picture. MPEG-2 frame pictures mix
    // frame-DCT and field-DCT macroblocks, which is macroblock-adaptive
    // frame/field coding rather than field pictures.
    w.flag(0);
  }

  if (cfg.idr) w.ue(cfg.idrPicId ?? 0);

  // pic_order_cnt_type is 0 in the SPS, so POC is sent explicitly.
  w.u(cfg.log2MaxPocLsb, cfg.picOrderCntLsb);

  const isP = cfg.sliceType === SliceType.P;
  const isB = cfg.sliceType === SliceType.B;

  if (isB) {
    // Temporal direct mode needs co-located motion; spatial is self-contained
    // and never used here anyway, since every macroblock codes its own vectors.
    w.flag(1); // direct_spatial_mv_pred_flag
  }

  if (isP || isB) {
    const override =
      cfg.numRefIdxL0Active !== undefined ||
      cfg.numRefIdxL1Active !== undefined;
    w.flag(override);
    if (override) {
      w.ue((cfg.numRefIdxL0Active ?? 1) - 1);
      if (isB) w.ue((cfg.numRefIdxL1Active ?? 1) - 1);
    }
  }

  // ref_pic_list_modification: the default list order is used for now.
  if (!isIType(cfg.sliceType)) {
    w.flag(0); // ref_pic_list_modification_flag_l0
  }
  if (isB) {
    w.flag(0); // ref_pic_list_modification_flag_l1
  }

  // weighted_pred_flag is 0 and weighted_bipred_idc is 0, so no pred_weight_table.

  // dec_ref_pic_marking appears only for reference pictures.
  if (cfg.reference) {
    if (cfg.idr) {
      w.flag(0); // no_output_of_prior_pics_flag
      w.flag(cfg.longTermReference ?? false);
    } else {
      w.flag(0); // adaptive_ref_pic_marking_mode_flag: sliding window
    }
  } else if (cfg.idr) {
    throw new Error("an IDR picture must be a reference picture");
  }

  // entropy_coding_mode_flag is 0, so no cabac_init_idc.

  w.se(cfg.sliceQp - cfg.ppsInitQp); // slice_qp_delta

  // deblocking_filter_control_present_flag is 1 in the PPS.
  w.ue(cfg.disableDeblockingFilterIdc);
  if (cfg.disableDeblockingFilterIdc !== 1) {
    w.se(0); // slice_alpha_c0_offset_div2
    w.se(0); // slice_beta_offset_div2
  }
}

function isIType(t: SliceTypeValue): boolean {
  return t === SliceType.I;
}
