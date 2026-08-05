/**
 * H.264 sequence and picture parameter sets.
 *
 * Several fields here are load-bearing for the transcode rather than free
 * choices, and are called out at their definitions:
 *
 * - High profile, because only it has the 8x8 transform and scaling lists that
 *   let MPEG-2 coefficients pass through.
 * - weighted_bipred_idc = 0, so B-slice bi-prediction is the plain
 *   (P0 + P1 + 1) >> 1 average. That is exactly MPEG-2's half-sample filter,
 *   and it is what makes half-pel motion reproducible bit-for-bit.
 * - deblocking_filter_control_present_flag = 1, so slices can switch the loop
 *   filter off. MPEG-2 has no in-loop filter, so leaving it on would alter
 *   every reconstructed picture.
 */
import { BitWriter, NalType, toNalUnit } from "./bitwriter.ts";

/**
 * H.264's 8x8 zig-zag scan (Table 8-13), used to serialise scaling lists.
 * Identical to the MPEG-2 scan, but repeated here so the H.264 writer does not
 * reach into the MPEG-2 module for it.
 */
export const ZIGZAG_8X8: readonly number[] = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];

export interface SpsConfig {
  /** Luma width in samples, before cropping. */
  width: number;
  height: number;
  /** level_idc, e.g. 40 for level 4.0 (enough for 1440x1080 at 30i). */
  levelIdc: number;
  /**
   * False when the source is interlaced. MPEG-2 frame pictures mix frame-DCT
   * and field-DCT macroblocks, which only macroblock-adaptive frame/field
   * coding can represent, so interlaced sources need MBAFF.
   */
  frameMbsOnly: boolean;
  /** Size of the decoded picture buffer to request. */
  maxNumRefFrames: number;
  log2MaxFrameNumMinus4: number;
  log2MaxPocLsbMinus4: number;
}

export interface PpsConfig {
  /** Initial QP, carried as pic_init_qp_minus26. */
  initQp: number;
  /**
   * The 8x8 luma scaling lists, in raster order, or null to leave the flat
   * default in place. This is where the MPEG-2 quantiser matrices are carried:
   * H.264's normAdjust8x8 already performs the transform's basis-norm
   * compensation, so weightScale8x8 is a pure quantiser weight, the same role
   * MPEG-2's W plays.
   */
  scaling8x8Intra: readonly number[] | null;
  scaling8x8Inter: readonly number[] | null;
}

/** Macroblock dimensions and the cropping needed to reach the coded size. */
export function frameGeometry(
  width: number,
  height: number,
  frameMbsOnly: boolean,
) {
  const mbWidth = (width + 15) >> 4;
  const mbHeight = (height + 15) >> 4;
  // With MBAFF or field coding, a map unit is a macroblock pair.
  const mapUnits = frameMbsOnly ? mbHeight : mbHeight >> 1;
  // 4:2:0 crops in chroma units; vertically those double again when a picture
  // is not frame-only (clause 7.4.2.1.1).
  const cropUnitX = 2;
  const cropUnitY = frameMbsOnly ? 2 : 4;
  const cropRight = (mbWidth * 16 - width) / cropUnitX;
  const cropBottom = (mbHeight * 16 - height) / cropUnitY;
  return {
    mbWidth,
    mbHeight,
    mapUnits,
    cropRight,
    cropBottom,
    cropUnitX,
    cropUnitY,
  };
}

/**
 * Serialise one scaling list. The syntax codes successive differences, and the
 * decoder treats a next value of zero as "hold the previous one for the rest of
 * the list" -- harmless here because scaling weights are always 1..255.
 */
function writeScalingList(w: BitWriter, listRaster: readonly number[]): void {
  let lastScale = 8;
  for (let j = 0; j < 64; j++) {
    const nextScale = listRaster[ZIGZAG_8X8[j]!]!;
    if (nextScale < 1 || nextScale > 255) {
      throw new Error(`scaling list value ${nextScale} out of range at ${j}`);
    }
    let delta = nextScale - lastScale;
    if (delta > 127) delta -= 256;
    if (delta < -128) delta += 256;
    w.se(delta);
    lastScale = nextScale;
  }
}

export function writeSps(cfg: SpsConfig): Uint8Array {
  const w = new BitWriter(256);
  const g = frameGeometry(cfg.width, cfg.height, cfg.frameMbsOnly);

  w.u(8, 100); // profile_idc: High
  w.flag(0); // constraint_set0_flag
  w.flag(0); // constraint_set1_flag
  w.flag(0); // constraint_set2_flag
  w.flag(0); // constraint_set3_flag
  w.flag(0); // constraint_set4_flag
  w.flag(0); // constraint_set5_flag
  w.u(2, 0); // reserved_zero_2bits
  w.u(8, cfg.levelIdc);
  w.ue(0); // seq_parameter_set_id

  // High profile block
  w.ue(1); // chroma_format_idc: 4:2:0
  w.ue(0); // bit_depth_luma_minus8
  w.ue(0); // bit_depth_chroma_minus8
  w.flag(0); // qpprime_y_zero_transform_bypass_flag
  w.flag(0); // seq_scaling_matrix_present_flag: the lists live in the PPS

  w.ue(cfg.log2MaxFrameNumMinus4);
  w.ue(0); // pic_order_cnt_type 0: explicit POC, needed for B picture reordering
  w.ue(cfg.log2MaxPocLsbMinus4);
  w.ue(cfg.maxNumRefFrames);
  w.flag(0); // gaps_in_frame_num_value_allowed_flag
  w.ue(g.mbWidth - 1);
  w.ue(g.mapUnits - 1);
  w.flag(cfg.frameMbsOnly);
  if (!cfg.frameMbsOnly) {
    w.flag(1); // mb_adaptive_frame_field_flag
  }
  w.flag(1); // direct_8x8_inference_flag

  const cropping = g.cropRight > 0 || g.cropBottom > 0;
  w.flag(cropping);
  if (cropping) {
    w.ue(0); // frame_crop_left_offset
    w.ue(g.cropRight);
    w.ue(0); // frame_crop_top_offset
    w.ue(g.cropBottom);
  }
  w.flag(0); // vui_parameters_present_flag

  w.rbspTrailingBits();
  return toNalUnit(w.bytes(), 3, NalType.SPS);
}

export function writePps(cfg: PpsConfig): Uint8Array {
  const w = new BitWriter(256);

  w.ue(0); // pic_parameter_set_id
  w.ue(0); // seq_parameter_set_id
  w.flag(0); // entropy_coding_mode_flag: CAVLC
  w.flag(0); // bottom_field_pic_order_in_frame_present_flag
  w.ue(0); // num_slice_groups_minus1
  w.ue(0); // num_ref_idx_l0_default_active_minus1
  w.ue(0); // num_ref_idx_l1_default_active_minus1
  w.flag(0); // weighted_pred_flag
  // Default bi-prediction, i.e. (P0 + P1 + 1) >> 1. The half-pel mapping
  // depends on this exact rounding, so it must not become weighted.
  w.u(2, 0); // weighted_bipred_idc
  w.se(cfg.initQp - 26); // pic_init_qp_minus26
  w.se(0); // pic_init_qs_minus26
  w.se(0); // chroma_qp_index_offset
  w.flag(1); // deblocking_filter_control_present_flag: slices switch it off
  w.flag(0); // constrained_intra_pred_flag: no H.264 intra prediction is used
  w.flag(0); // redundant_pic_cnt_present_flag

  // High profile extension
  w.flag(1); // transform_8x8_mode_flag
  const anyScaling =
    cfg.scaling8x8Intra !== null || cfg.scaling8x8Inter !== null;
  w.flag(anyScaling);
  if (anyScaling) {
    // Six 4x4 lists come first and are left at their defaults, then the two
    // 8x8 luma lists (intra, inter) that carry the MPEG-2 matrices.
    for (let i = 0; i < 6; i++) w.flag(0);
    for (const list of [cfg.scaling8x8Intra, cfg.scaling8x8Inter]) {
      w.flag(list !== null);
      if (list !== null) writeScalingList(w, list);
    }
  }
  w.se(0); // second_chroma_qp_index_offset

  w.rbspTrailingBits();
  return toNalUnit(w.bytes(), 3, NalType.PPS);
}
