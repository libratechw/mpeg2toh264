//! The SPS and PPS read back with a parser written against the spec rather than
//! against the writer, so a shared misunderstanding cannot hide.

use mpeg2toh264::h264::params::{write_pps, write_sps, PpsConfig, SpsConfig, ZIGZAG_8X8};
use mpeg2toh264::mpeg2::constants::DEFAULT_INTRA_QUANT;
use mpeg2toh264::mpeg2::headers::SampleAspectRatio;

/// Strip the Annex B start code, NAL header and emulation prevention bytes.
fn rbsp_of(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut zeros = 0;
    for &b in &nal[5..] {
        if zeros >= 2 && b == 0x03 {
            zeros = 0;
            continue;
        }
        out.push(b);
        zeros = if b == 0x00 { zeros + 1 } else { 0 };
    }
    out
}

struct Reader {
    data: Vec<u8>,
    pos: usize,
}

impl Reader {
    fn new(data: Vec<u8>) -> Self {
        Self { data, pos: 0 }
    }

    fn u1(&mut self) -> u32 {
        let bit = (self.data[self.pos >> 3] >> (7 - (self.pos & 7))) & 1;
        self.pos += 1;
        bit as u32
    }

    fn u(&mut self, n: u32) -> u32 {
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | self.u1();
        }
        v
    }

    fn flag(&mut self) -> bool {
        self.u1() == 1
    }

    fn ue(&mut self) -> u32 {
        let mut zeros = 0;
        while self.u1() == 0 {
            zeros += 1;
        }
        (1 << zeros) - 1 + if zeros == 0 { 0 } else { self.u(zeros) }
    }

    fn se(&mut self) -> i32 {
        let k = self.ue();
        if k % 2 == 1 {
            k.div_ceil(2) as i32
        } else {
            -((k / 2) as i32)
        }
    }
}

/// Reconstruct a scaling list exactly as clause 7.3.2.1.1.1 specifies.
fn read_scaling_list(r: &mut Reader, size: usize) -> Vec<i32> {
    let mut list = vec![0i32; size];
    let mut last_scale = 8i32;
    let mut next_scale = 8i32;
    for entry in list.iter_mut() {
        if next_scale != 0 {
            next_scale = (last_scale + r.se()).rem_euclid(256);
        }
        *entry = if next_scale == 0 {
            last_scale
        } else {
            next_scale
        };
        last_scale = *entry;
    }
    list
}

/// The SPS fields these tests care about, parsed in syntax order (clause 7.3.2.1).
#[derive(Debug, Default)]
struct Sps {
    profile_idc: u32,
    level_idc: u32,
    chroma_format_idc: u32,
    seq_scaling_matrix_present: bool,
    log2_max_frame_num_minus4: u32,
    pic_order_cnt_type: u32,
    log2_max_poc_lsb_minus4: u32,
    max_num_ref_frames: u32,
    pic_width_in_mbs_minus1: u32,
    pic_height_in_map_units_minus1: u32,
    frame_mbs_only: bool,
    mb_adaptive_frame_field: bool,
    direct_8x8_inference: bool,
    crop: Option<[u32; 4]>,
    aspect_ratio_idc: Option<u32>,
    sar: Option<(u32, u32)>,
    max_num_reorder_frames: Option<u32>,
    max_dec_frame_buffering: Option<u32>,
}

fn parse_sps(nal: &[u8]) -> Sps {
    let mut r = Reader::new(rbsp_of(nal));
    let mut sps = Sps {
        profile_idc: r.u(8),
        ..Default::default()
    };
    r.u(8); // constraint flags and reserved_zero_2bits
    sps.level_idc = r.u(8);
    r.ue(); // seq_parameter_set_id
    if matches!(
        sps.profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128
    ) {
        sps.chroma_format_idc = r.ue();
        assert_ne!(
            sps.chroma_format_idc, 3,
            "separate_colour_plane is untested"
        );
        r.ue(); // bit_depth_luma_minus8
        r.ue(); // bit_depth_chroma_minus8
        r.flag(); // qpprime_y_zero_transform_bypass_flag
        sps.seq_scaling_matrix_present = r.flag();
        assert!(!sps.seq_scaling_matrix_present, "the lists live in the PPS");
    }
    sps.log2_max_frame_num_minus4 = r.ue();
    sps.pic_order_cnt_type = r.ue();
    assert_eq!(sps.pic_order_cnt_type, 0, "B reordering needs explicit POC");
    sps.log2_max_poc_lsb_minus4 = r.ue();
    sps.max_num_ref_frames = r.ue();
    r.flag(); // gaps_in_frame_num_value_allowed_flag
    sps.pic_width_in_mbs_minus1 = r.ue();
    sps.pic_height_in_map_units_minus1 = r.ue();
    sps.frame_mbs_only = r.flag();
    if !sps.frame_mbs_only {
        sps.mb_adaptive_frame_field = r.flag();
    }
    sps.direct_8x8_inference = r.flag();
    if r.flag() {
        sps.crop = Some([r.ue(), r.ue(), r.ue(), r.ue()]);
    }
    if r.flag() {
        // vui_parameters
        if r.flag() {
            let idc = r.u(8);
            sps.aspect_ratio_idc = Some(idc);
            if idc == 255 {
                sps.sar = Some((r.u(16), r.u(16)));
            }
        }
        r.flag(); // overscan_info_present_flag
        r.flag(); // video_signal_type_present_flag
        r.flag(); // chroma_loc_info_present_flag
        r.flag(); // timing_info_present_flag
        r.flag(); // nal_hrd_parameters_present_flag
        r.flag(); // vcl_hrd_parameters_present_flag
        r.flag(); // pic_struct_present_flag
        if r.flag() {
            // bitstream_restriction
            r.flag(); // motion_vectors_over_pic_boundaries_flag
            r.ue(); // max_bytes_per_pic_denom
            r.ue(); // max_bits_per_mb_denom
            r.ue(); // log2_max_mv_length_horizontal
            r.ue(); // log2_max_mv_length_vertical
            sps.max_num_reorder_frames = Some(r.ue());
            sps.max_dec_frame_buffering = Some(r.ue());
        }
    }
    sps
}

fn sample_sps(sar: Option<SampleAspectRatio>) -> SpsConfig {
    SpsConfig {
        width: 704,
        height: 480,
        level_idc: 30,
        frame_mbs_only: true,
        max_num_ref_frames: 3,
        log2_max_frame_num_minus4: 4,
        log2_max_poc_lsb_minus4: 12,
        max_num_reorder_frames: Some(1),
        max_dec_frame_buffering: Some(4),
        sample_aspect_ratio: sar,
    }
}

#[test]
fn sps_declares_high_profile_with_the_geometry_it_was_given() {
    let nal = write_sps(&sample_sps(None));
    assert_eq!(&nal[..4], &[0, 0, 0, 1]);
    assert_eq!(nal[4] & 0x1f, 7, "nal_unit_type is SPS");
    assert_eq!(nal[4] >> 5, 3, "parameter sets are top priority");

    let sps = parse_sps(&nal);
    assert_eq!(sps.profile_idc, 100, "High profile, for the 8x8 transform");
    assert_eq!(sps.level_idc, 30);
    assert_eq!(sps.chroma_format_idc, 1, "4:2:0");
    assert_eq!(sps.log2_max_frame_num_minus4, 4);
    assert_eq!(sps.log2_max_poc_lsb_minus4, 12);
    assert_eq!(sps.max_num_ref_frames, 3);
    assert_eq!(sps.pic_width_in_mbs_minus1, 43, "704 / 16 - 1");
    assert_eq!(sps.pic_height_in_map_units_minus1, 29, "480 / 16 - 1");
    assert!(sps.frame_mbs_only, "a progressive source needs no MBAFF");
    assert!(sps.direct_8x8_inference);
    assert_eq!(sps.crop, None, "704x480 is macroblock aligned");
    assert_eq!(sps.aspect_ratio_idc, None);
    assert_eq!(
        sps.max_num_reorder_frames,
        Some(1),
        "one anchor is held back"
    );
    assert_eq!(sps.max_dec_frame_buffering, Some(4));
}

#[test]
fn sps_carries_an_interlaced_source_as_mbaff_with_doubled_crop_units() {
    // 1920x1088 coded, 1080 displayed: eight lines to crop, in doubled units.
    let nal = write_sps(&SpsConfig {
        width: 1920,
        height: 1080,
        level_idc: 40,
        frame_mbs_only: false,
        ..sample_sps(None)
    });
    let sps = parse_sps(&nal);
    assert_eq!(sps.pic_width_in_mbs_minus1, 119);
    assert_eq!(
        sps.pic_height_in_map_units_minus1, 33,
        "map units are macroblock pairs, not rows"
    );
    assert!(!sps.frame_mbs_only);
    assert!(sps.mb_adaptive_frame_field, "field DCT needs MBAFF");
    assert_eq!(
        sps.crop,
        Some([0, 0, 0, 2]),
        "8 lines to crop, at CropUnitY 4"
    );
}

#[test]
fn sps_carries_a_pixel_aspect_ratio_as_extended_sar() {
    let nal = write_sps(&sample_sps(Some(SampleAspectRatio {
        width: 40,
        height: 33,
    })));
    let sps = parse_sps(&nal);
    assert_eq!(sps.aspect_ratio_idc, Some(255), "Extended_SAR");
    assert_eq!(sps.sar, Some((40, 33)));
}

#[test]
fn pps_carries_the_mpeg2_quantiser_matrices_as_8x8_scaling_lists() {
    let nal = write_pps(&PpsConfig {
        init_qp: 26,
        scaling_8x8_intra: Some(&DEFAULT_INTRA_QUANT),
        scaling_8x8_inter: Some(&DEFAULT_INTRA_QUANT),
        chroma_qp_index_offset: -6,
    });
    assert_eq!(nal[4] & 0x1f, 8, "nal_unit_type is PPS");

    let mut r = Reader::new(rbsp_of(&nal));
    assert_eq!(r.ue(), 0, "pic_parameter_set_id");
    assert_eq!(r.ue(), 0, "seq_parameter_set_id");
    assert!(!r.flag(), "entropy_coding_mode_flag: CAVLC");
    assert!(!r.flag(), "bottom_field_pic_order_in_frame_present_flag");
    assert_eq!(r.ue(), 0, "num_slice_groups_minus1");
    assert_eq!(r.ue(), 0, "num_ref_idx_l0_default_active_minus1");
    assert_eq!(r.ue(), 0, "num_ref_idx_l1_default_active_minus1");
    assert!(r.flag(), "weighted_pred_flag: the flat prediction needs it");
    assert_eq!(r.u(2), 1, "weighted_bipred_idc: explicit");
    assert_eq!(r.se(), 0, "pic_init_qp_minus26");
    assert_eq!(r.se(), 0, "pic_init_qs_minus26");
    assert_eq!(r.se(), -6, "chroma_qp_index_offset");
    assert!(r.flag(), "deblocking_filter_control_present_flag");
    assert!(!r.flag(), "constrained_intra_pred_flag");
    assert!(!r.flag(), "redundant_pic_cnt_present_flag");
    assert!(r.flag(), "transform_8x8_mode_flag");
    assert!(r.flag(), "pic_scaling_matrix_present_flag");

    // The six 4x4 lists come first, and must be explicitly flat: leaving them
    // absent would substitute H.264's own default matrices, which are not.
    for i in 0..6 {
        assert!(r.flag(), "4x4 scaling list {i} is present");
        assert_eq!(
            read_scaling_list(&mut r, 16),
            vec![16; 16],
            "list {i} is flat"
        );
    }
    for name in ["intra", "inter"] {
        assert!(r.flag(), "8x8 {name} scaling list is present");
        let list = read_scaling_list(&mut r, 64);
        // The syntax carries the list in zig-zag order; the writer is given raster.
        let raster: Vec<i32> = (0..64)
            .map(|i| list[ZIGZAG_8X8.iter().position(|&p| p == i).unwrap()])
            .collect();
        assert_eq!(
            raster,
            DEFAULT_INTRA_QUANT.to_vec(),
            "8x8 {name} list survives"
        );
    }
    assert_eq!(r.se(), -6, "second_chroma_qp_index_offset");
}
