//! H.264 sequence and picture parameter sets.
//!
//! Several fields here are load-bearing for the transcode rather than free
//! choices, and are called out at their definitions:
//!
//! - High profile, because only it has the 8x8 transform and scaling lists that
//!   let MPEG-2 coefficients pass through.
//! - `weighted_pred_flag = 1` and `weighted_bipred_idc = 1`, which is how intra
//!   macroblocks reach a flat prediction without a manufactured reference
//!   picture. See [`crate::h264::slice`]; the weights every other reference
//!   index gets leave bi-prediction at the plain `(P0 + P1 + 1) >> 1` average,
//!   which is exactly MPEG-2's half-sample filter.
//! - `deblocking_filter_control_present_flag = 1`, so slices can switch the loop
//!   filter off. MPEG-2 has no in-loop filter, so leaving it on would alter
//!   every reconstructed picture.

use crate::h264::bitwriter::{nal_type, to_nal_unit, BitWriter};
use crate::mpeg2::headers::SampleAspectRatio;

/// H.264's 8x8 zig-zag scan (Table 8-13), used to serialise scaling lists.
/// Identical to the MPEG-2 scan, but repeated here so the H.264 writer does not
/// reach into the MPEG-2 module for it.
pub static ZIGZAG_8X8: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/// H.264's 4x4 zig-zag scan, used to serialise the 4x4 scaling lists.
pub static ZIGZAG_4X4: [usize; 16] = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];

/// Flat weights, i.e. no frequency-dependent weighting at all.
static FLAT_4X4: [i32; 16] = [16; 16];

pub struct SpsConfig {
    /// Luma width in samples, before cropping.
    pub width: u32,
    pub height: u32,
    /// `level_idc`, e.g. 40 for level 4.0 (enough for 1440x1080 at 30i).
    pub level_idc: u32,
    /// False when the source is interlaced. MPEG-2 frame pictures mix frame-DCT
    /// and field-DCT macroblocks, which only macroblock-adaptive frame/field
    /// coding can represent, so interlaced sources need MBAFF.
    pub frame_mbs_only: bool,
    /// Size of the decoded picture buffer to request.
    pub max_num_ref_frames: u32,
    pub log2_max_frame_num_minus4: u32,
    pub log2_max_poc_lsb_minus4: u32,
    /// How many pictures may precede a picture in decoding order yet follow it
    /// in output order. Without this a decoder has no reason to hold pictures
    /// back and emits them in decoding order, which for a source with B pictures
    /// is not display order.
    pub max_num_reorder_frames: Option<u32>,
    /// Frames the decoder must be able to hold, at least `max_num_reorder_frames`.
    pub max_dec_frame_buffering: Option<u32>,
    /// Pixel width:height ratio carried in VUI.
    pub sample_aspect_ratio: Option<SampleAspectRatio>,
}

pub struct PpsConfig<'a> {
    /// Initial QP, carried as `pic_init_qp_minus26`.
    pub init_qp: i32,
    /// The 8x8 luma scaling lists, in raster order, or `None` to leave the flat
    /// default in place. This is where the MPEG-2 quantiser matrices are
    /// carried: H.264's `normAdjust8x8` already performs the transform's
    /// basis-norm compensation, so `weightScale8x8` is a pure quantiser weight,
    /// the same role MPEG-2's W plays.
    pub scaling_8x8_intra: Option<&'a [i32; 64]>,
    pub scaling_8x8_inter: Option<&'a [i32; 64]>,
    /// Shifts chroma QP relative to luma, -12..12. Chroma otherwise inherits the
    /// luma QP through Table 8-15 with no way to refine it, and its path carries
    /// more rounding than luma's -- notably the 2x2 DC Hadamard, which is
    /// orthogonal but not orthonormal, so a half-step rounding of a DC level can
    /// reach four times that in the reconstructed value.
    pub chroma_qp_index_offset: i32,
}

/// Macroblock dimensions and the cropping needed to reach the coded size.
#[derive(Clone, Copy, Debug)]
pub struct FrameGeometry {
    pub mb_width: usize,
    pub mb_height: usize,
    pub map_units: usize,
    pub crop_right: u32,
    pub crop_bottom: u32,
    pub crop_unit_x: u32,
    pub crop_unit_y: u32,
}

pub fn frame_geometry(width: u32, height: u32, frame_mbs_only: bool) -> FrameGeometry {
    let mb_width = ((width + 15) >> 4) as usize;
    let mb_height = ((height + 15) >> 4) as usize;
    // With MBAFF or field coding, a map unit is a macroblock pair.
    let map_units = if frame_mbs_only {
        mb_height
    } else {
        mb_height >> 1
    };
    // 4:2:0 crops in chroma units; vertically those double again when a picture
    // is not frame-only (clause 7.4.2.1.1).
    let crop_unit_x = 2;
    let crop_unit_y = if frame_mbs_only { 2 } else { 4 };
    let crop_right = (mb_width as u32 * 16 - width) / crop_unit_x;
    let crop_bottom = (mb_height as u32 * 16 - height) / crop_unit_y;
    FrameGeometry {
        mb_width,
        mb_height,
        map_units,
        crop_right,
        crop_bottom,
        crop_unit_x,
        crop_unit_y,
    }
}

/// Serialise one scaling list. The syntax codes successive differences, and the
/// decoder treats a next value of zero as "hold the previous one for the rest of
/// the list" -- harmless here because scaling weights are always 1..255.
fn write_scaling_list(w: &mut BitWriter, list_raster: &[i32]) {
    let scan: &[usize] = if list_raster.len() == 16 {
        &ZIGZAG_4X4
    } else {
        &ZIGZAG_8X8
    };
    let mut last_scale = 8;
    for j in 0..list_raster.len() {
        let next_scale = list_raster[scan[j]];
        assert!(
            (1..=255).contains(&next_scale),
            "scaling list value {next_scale} out of range at {j}"
        );
        let mut delta = next_scale - last_scale;
        if delta > 127 {
            delta -= 256;
        }
        if delta < -128 {
            delta += 256;
        }
        w.se(delta);
        last_scale = next_scale;
    }
}

pub fn write_sps(cfg: &SpsConfig) -> Vec<u8> {
    let mut w = BitWriter::with_capacity(256);
    let g = frame_geometry(cfg.width, cfg.height, cfg.frame_mbs_only);

    w.u(8, 100); // profile_idc: High
    w.flag(false); // constraint_set0_flag
    w.flag(false); // constraint_set1_flag
    w.flag(false); // constraint_set2_flag
    w.flag(false); // constraint_set3_flag
    w.flag(false); // constraint_set4_flag
    w.flag(false); // constraint_set5_flag
    w.u(2, 0); // reserved_zero_2bits
    w.u(8, cfg.level_idc);
    w.ue(0); // seq_parameter_set_id

    // High profile block
    w.ue(1); // chroma_format_idc: 4:2:0
    w.ue(0); // bit_depth_luma_minus8
    w.ue(0); // bit_depth_chroma_minus8
    w.flag(false); // qpprime_y_zero_transform_bypass_flag
    w.flag(false); // seq_scaling_matrix_present_flag: the lists live in the PPS

    w.ue(cfg.log2_max_frame_num_minus4);
    w.ue(0); // pic_order_cnt_type 0: explicit POC, needed for B picture reordering
    w.ue(cfg.log2_max_poc_lsb_minus4);
    w.ue(cfg.max_num_ref_frames);
    w.flag(false); // gaps_in_frame_num_value_allowed_flag
    w.ue(g.mb_width as u32 - 1);
    w.ue(g.map_units as u32 - 1);
    w.flag(cfg.frame_mbs_only);
    if !cfg.frame_mbs_only {
        w.flag(true); // mb_adaptive_frame_field_flag
    }
    w.flag(true); // direct_8x8_inference_flag

    let cropping = g.crop_right > 0 || g.crop_bottom > 0;
    w.flag(cropping);
    if cropping {
        w.ue(0); // frame_crop_left_offset
        w.ue(g.crop_right);
        w.ue(0); // frame_crop_top_offset
        w.ue(g.crop_bottom);
    }
    let reorder = cfg.max_num_reorder_frames;
    let sar = cfg.sample_aspect_ratio;
    let vui = reorder.is_some() || sar.is_some();
    w.flag(vui); // vui_parameters_present_flag
    if vui {
        w.flag(sar.is_some()); // aspect_ratio_info_present_flag
        if let Some(sar) = sar {
            w.u(8, 255); // aspect_ratio_idc: Extended_SAR
            w.u(16, sar.width);
            w.u(16, sar.height);
        }
        w.flag(false); // overscan_info_present_flag
        w.flag(false); // video_signal_type_present_flag
        w.flag(false); // chroma_loc_info_present_flag
        w.flag(false); // timing_info_present_flag
        w.flag(false); // nal_hrd_parameters_present_flag
        w.flag(false); // vcl_hrd_parameters_present_flag
        w.flag(false); // pic_struct_present_flag
        w.flag(reorder.is_some()); // bitstream_restriction_flag
        if let Some(reorder) = reorder {
            w.flag(true); // motion_vectors_over_pic_boundaries_flag
            w.ue(0); // max_bytes_per_pic_denom: unconstrained
            w.ue(0); // max_bits_per_mb_denom: unconstrained
            w.ue(16); // log2_max_mv_length_horizontal
            w.ue(16); // log2_max_mv_length_vertical
            w.ue(reorder);
            w.ue(cfg
                .max_dec_frame_buffering
                .unwrap_or_else(|| reorder.max(cfg.max_num_ref_frames)));
        }
    }

    w.rbsp_trailing_bits();
    to_nal_unit(w.bytes(), 3, nal_type::SPS)
}

pub fn write_pps(cfg: &PpsConfig<'_>) -> Vec<u8> {
    let mut w = BitWriter::with_capacity(256);

    w.ue(0); // pic_parameter_set_id
    w.ue(0); // seq_parameter_set_id
    w.flag(false); // entropy_coding_mode_flag: CAVLC
    w.flag(false); // bottom_field_pic_order_in_frame_present_flag
    w.ue(0); // num_slice_groups_minus1
    w.ue(0); // num_ref_idx_l0_default_active_minus1
    w.ue(0); // num_ref_idx_l1_default_active_minus1
             // Explicit weighted prediction, which is what gives intra macroblocks their
             // flat prediction; see h264/slice.rs. Every other reference index is given
             // the default weight, so bi-prediction remains (P0 + P1 + 1) >> 1 and the
             // half-pel mapping keeps its exact rounding.
    w.flag(true); // weighted_pred_flag
    w.u(2, 1); // weighted_bipred_idc: explicit
    w.se(cfg.init_qp - 26); // pic_init_qp_minus26
    w.se(0); // pic_init_qs_minus26
    w.se(cfg.chroma_qp_index_offset); // chroma_qp_index_offset
    w.flag(true); // deblocking_filter_control_present_flag: slices switch it off
    w.flag(false); // constrained_intra_pred_flag: no H.264 intra prediction is used
    w.flag(false); // redundant_pic_cnt_present_flag

    // High profile extension
    w.flag(true); // transform_8x8_mode_flag
    let any_scaling = cfg.scaling_8x8_intra.is_some() || cfg.scaling_8x8_inter.is_some();
    w.flag(any_scaling);
    if any_scaling {
        // The six 4x4 lists are sent explicitly as flat 16. Leaving them absent
        // does not mean "no weighting": fall-back rule set A would substitute
        // H.264's default 4x4 matrices, which are far from flat, and chroma runs
        // through the 4x4 transform. Then the two 8x8 luma lists carry the
        // MPEG-2 quantiser matrices.
        for _ in 0..6 {
            w.flag(true);
            write_scaling_list(&mut w, &FLAT_4X4);
        }
        for list in [cfg.scaling_8x8_intra, cfg.scaling_8x8_inter] {
            w.flag(list.is_some());
            if let Some(list) = list {
                write_scaling_list(&mut w, list);
            }
        }
    }
    w.se(cfg.chroma_qp_index_offset); // second_chroma_qp_index_offset

    w.rbsp_trailing_bits();
    to_nal_unit(w.bytes(), 3, nal_type::PPS)
}
