//! H.264 slice headers (clause 7.3.3).

use crate::h264::bitwriter::BitWriter;
use crate::h264::quant::FLAT_PREDICTION;

/// `slice_type` values. The +5 forms additionally assert that every slice in the
/// picture has the same type, which is always true here.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SliceType {
    P,
    B,
    I,
}

impl SliceType {
    pub fn code(self) -> u32 {
        match self {
            Self::P => 5,
            Self::B => 6,
            Self::I => 7,
        }
    }
}

/// One short-term reference picture of a list written out by name.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct RefPicListEntry {
    /// How far back the picture's frame sits in `frame_num`.
    pub frames_back: u32,
    /// Whether the field has the parity of the field being coded. Ignored by a
    /// frame slice, where a reference frame takes one entry rather than two.
    pub same_parity: bool,
}

/// The longest run this writer names: three short-term frames, two fields each.
pub const MAX_REF_PIC_LIST: usize = 6;

/// A reference picture list built entry by entry, in list order.
#[derive(Clone, Copy)]
pub struct RefPicList {
    entries: [Option<RefPicListEntry>; MAX_REF_PIC_LIST],
    len: usize,
}

impl Default for RefPicList {
    fn default() -> Self {
        Self {
            entries: [None; MAX_REF_PIC_LIST],
            len: 0,
        }
    }
}

impl RefPicList {
    pub fn push(&mut self, entry: RefPicListEntry) {
        assert!(
            self.len < MAX_REF_PIC_LIST,
            "reference list longer than {MAX_REF_PIC_LIST} entries"
        );
        self.entries[self.len] = Some(entry);
        self.len += 1;
    }

    pub fn len(&self) -> usize {
        self.len
    }

    fn iter(&self) -> impl Iterator<Item = RefPicListEntry> + '_ {
        self.entries[..self.len].iter().filter_map(|entry| *entry)
    }
}

pub struct SliceHeaderConfig {
    pub first_mb_in_slice: u32,
    pub slice_type: SliceType,
    pub frame_num: u32,
    /// Bit width of `frame_num`, i.e. `log2_max_frame_num_minus4 + 4`.
    pub log2_max_frame_num: u32,
    pub pic_order_cnt_lsb: u32,
    pub log2_max_poc_lsb: u32,
    /// True for an IDR picture, which changes which header fields appear.
    pub idr: bool,
    pub idr_pic_id: u32,
    /// Marks this picture as a long-term reference with the given
    /// `LongTermFrameIdx`, which is how the flat-prediction reference is kept in
    /// the decoded picture buffer for the rest of the stream. An IDR says so
    /// with `long_term_reference_flag`, which fixes the index at 0; any other
    /// reference picture says it with memory management commands.
    pub long_term_current: Option<u32>,
    /// Set when the source is interlaced, i.e. `frame_mbs_only_flag` is 0.
    pub mbaff: bool,
    /// `Some(false)` for a top field picture and `Some(true)` for a bottom
    /// field picture. `None` emits a frame picture (MBAFF when enabled).
    pub field_picture: Option<bool>,
    /// Whether the picture is a reference, i.e. `nal_ref_idc` is non-zero. It
    /// governs whether `dec_ref_pic_marking` appears at all, so it has to match
    /// the NAL header exactly.
    pub reference: bool,
    /// QP for the slice, carried as `slice_qp_delta` against the PPS initial QP.
    pub slice_qp: i32,
    pub pps_init_qp: i32,
    /// 1 disables the loop filter. MPEG-2 has no in-loop filter, so leaving
    /// H.264's on would change every reconstructed picture.
    pub disable_deblocking_filter_idc: u32,
    /// Number of active L0 references, when it differs from the PPS default.
    pub num_ref_idx_l0_active: Option<u32>,
    pub num_ref_idx_l1_active: Option<u32>,
    /// Put this long-term picture first in list 0.
    pub l0_first_long_term: Option<u32>,
    /// The short-term run of both reference lists, written out entry by entry,
    /// which replaces `l0_first_long_term` and `l1_first_short_term_delta` for
    /// the slices that use it.
    ///
    /// Decoders do not agree on what the initialisation produces here.
    /// VideoToolbox shortens the run of short-term fields of a non-reference
    /// field pair by one, which moves the long-term entry the flat prediction
    /// weights sit on and hands every macroblock a picture other than the one
    /// it was coded against; it builds a different list again for the first
    /// frames behind an IDR. Naming the run leaves nothing there to decide.
    pub explicit_ref_lists: Option<[RefPicList; 2]>,
    /// Force list 1 to begin with a short-term picture, given as the difference
    /// between the current `frame_num` and that picture's.
    ///
    /// List 1 needs this because its default construction ends with a rule that
    /// swaps the first two entries whenever it comes out identical to list 0 --
    /// which is exactly the case here, since the half-sample mapping wants the
    /// same picture reachable through both lists.
    pub l1_first_short_term_delta: Option<u32>,
    /// The reference index intra macroblocks point at, given per list.
    ///
    /// It is normally the same index in both, since it names a picture nothing
    /// else predicts from. The exception is the second field of a picture
    /// opening a random access point: the one reference field it has is the
    /// first half of its own pair, which its inter macroblocks really do
    /// predict from, so the flat weights go on list 1 alone and list 0 keeps
    /// the field at its ordinary weight.
    ///
    /// H.264 has no "no prediction" macroblock mode, so an MPEG-2 intra
    /// macroblock cannot be expressed directly: H.264 intra prediction would
    /// subtract a neighbour-derived value that MPEG-2 never added, and working
    /// out those neighbours means decoding pixels, which is exactly what this
    /// transcoder exists to avoid. The picture opening a random access point
    /// has no reference list and so has no choice; every other one comes
    /// through here.
    ///
    /// The way out is explicit weighted prediction. This index gets weight 0 and
    /// offset [`FLAT_PREDICTION`], which makes its prediction that constant
    /// everywhere no matter what the reference picture holds (clause 8.4.2.3.2,
    /// Equation 8-274). The residual is then simply the MPEG-2 block with the
    /// constant removed -- in the transform domain, a shift of the DC
    /// coefficient alone -- and no reference picture has to be manufactured to
    /// carry it.
    pub flat_pred_ref_idx: [Option<u32>; 2],
}

impl Default for SliceHeaderConfig {
    fn default() -> Self {
        Self {
            first_mb_in_slice: 0,
            slice_type: SliceType::B,
            frame_num: 0,
            log2_max_frame_num: 8,
            pic_order_cnt_lsb: 0,
            log2_max_poc_lsb: 16,
            idr: false,
            idr_pic_id: 0,
            long_term_current: None,
            mbaff: false,
            field_picture: None,
            reference: false,
            slice_qp: 26,
            pps_init_qp: 26,
            disable_deblocking_filter_idc: 1,
            num_ref_idx_l0_active: None,
            num_ref_idx_l1_active: None,
            l0_first_long_term: None,
            explicit_ref_lists: None,
            l1_first_short_term_delta: None,
            flat_pred_ref_idx: [None; 2],
        }
    }
}

/// `pred_weight_table`, clause 7.3.3.2. Every index other than
/// `flat_pred_ref_idx` keeps the default weight of 1 and offset of 0, so with
/// the denominators at 0 both single-list and bi-prediction reduce to the
/// unweighted equations: in particular bi-prediction stays `(P0 + P1 + 1) >> 1`,
/// which is what makes MPEG-2's half-sample filter reproducible bit for bit.
fn write_pred_weight_table(w: &mut BitWriter, counts: &[u32], flat_pred_ref_idx: &[Option<u32>]) {
    w.ue(0); // luma_log2_weight_denom
    w.ue(0); // chroma_log2_weight_denom
    for (list, &count) in counts.iter().enumerate() {
        for i in 0..count {
            let flat = Some(i) == flat_pred_ref_idx[list];
            w.flag(flat); // luma_weight_lX_flag
            if flat {
                w.se(0); // luma_weight_lX
                w.se(FLAT_PREDICTION); // luma_offset_lX
            }
            w.flag(flat); // chroma_weight_lX_flag
            if flat {
                for _ in 0..2 {
                    w.se(0); // chroma_weight_lX
                    w.se(FLAT_PREDICTION); // chroma_offset_lX
                }
            }
        }
    }
}

/// Write `ref_pic_list_modification` for one list, naming its short-term run.
///
/// Only field slices come through here. Each command moves the field it names
/// to the next index and shifts the rest along (clause 8.2.4.3.1), so naming
/// the run in order puts those indices beyond doubt whatever the initialisation
/// made of them, and the entries left over -- the long-term fields -- keep
/// their order behind it.
///
/// The numbering follows the picture being coded (clause 8.2.4.1): a frame's
/// `CurrPicNum` is `frame_num` and a reference frame's `PicNum` is its
/// `FrameNumWrap`, while a field doubles both and adds one to the `PicNum` of a
/// field that has the parity of the field being coded. Each command carries the
/// step from the picture named before it, which is why the list is walked in
/// order rather than by index.
fn write_ref_pic_list_modification(
    w: &mut BitWriter,
    list: &RefPicList,
    frame_num: u32,
    field: bool,
) {
    w.flag(list.len() > 0); // ref_pic_list_modification_flag_lX
    if list.len() == 0 {
        return;
    }
    // Signed throughout: a reference older than the last wrap of `frame_num`
    // has a negative `FrameNumWrap`, and the differences below are what the
    // decoder adds back, so they have to be taken before any wrapping.
    let frame_num = i64::from(frame_num);
    let per_frame = if field { 2 } else { 1 };
    let mut predicted = per_frame * frame_num + i64::from(field); // CurrPicNum
    for entry in list.iter() {
        let pic_num = per_frame * (frame_num - i64::from(entry.frames_back))
            + i64::from(field && entry.same_parity);
        if pic_num < predicted {
            w.ue(0); // subtract from the predicted picNum
            w.ue((predicted - pic_num - 1) as u32); // abs_diff_pic_num_minus1
        } else {
            w.ue(1); // add to the predicted picNum
            w.ue((pic_num - predicted - 1) as u32);
        }
        predicted = pic_num;
    }
    w.ue(3); // end of the list
}

pub fn write_slice_header(w: &mut BitWriter, cfg: &SliceHeaderConfig) {
    w.ue(cfg.first_mb_in_slice);
    w.ue(cfg.slice_type.code());
    w.ue(0); // pic_parameter_set_id
    w.u(cfg.log2_max_frame_num, cfg.frame_num);

    if cfg.mbaff {
        w.flag(cfg.field_picture.is_some());
        if let Some(bottom_field) = cfg.field_picture {
            w.flag(bottom_field);
        }
    }

    if cfg.idr {
        w.ue(cfg.idr_pic_id);
    }

    // pic_order_cnt_type is 0 in the SPS, so POC is sent explicitly.
    w.u(cfg.log2_max_poc_lsb, cfg.pic_order_cnt_lsb);

    let is_p = cfg.slice_type == SliceType::P;
    let is_b = cfg.slice_type == SliceType::B;

    if is_b {
        // Temporal direct mode needs co-located motion; spatial is
        // self-contained and never used here anyway, since every macroblock
        // codes its own vectors.
        w.flag(true); // direct_spatial_mv_pred_flag
    }

    if is_p || is_b {
        let override_counts =
            cfg.num_ref_idx_l0_active.is_some() || cfg.num_ref_idx_l1_active.is_some();
        w.flag(override_counts);
        if override_counts {
            w.ue(cfg.num_ref_idx_l0_active.unwrap_or(1) - 1);
            if is_b {
                w.ue(cfg.num_ref_idx_l1_active.unwrap_or(1) - 1);
            }
        }
    }

    // ref_pic_list_modification. List 0's default order already puts the nearest
    // preceding reference first, so only list 1 needs correcting -- except in
    // the field slices that name both lists outright.
    let field = cfg.field_picture.is_some();
    if cfg.slice_type != SliceType::I {
        if let Some(lists) = &cfg.explicit_ref_lists {
            write_ref_pic_list_modification(w, &lists[0], cfg.frame_num, field);
        } else {
            w.flag(cfg.l0_first_long_term.is_some());
            if let Some(long_term) = cfg.l0_first_long_term {
                w.ue(2); // modification_of_pic_nums_idc 2: select a long-term picture
                w.ue(long_term);
                w.ue(3); // modification_of_pic_nums_idc 3: end of the list
            }
        }
    }
    if is_b {
        if let Some(lists) = &cfg.explicit_ref_lists {
            write_ref_pic_list_modification(w, &lists[1], cfg.frame_num, field);
        } else {
            w.flag(cfg.l1_first_short_term_delta.is_some());
            if let Some(delta) = cfg.l1_first_short_term_delta {
                w.ue(0); // modification_of_pic_nums_idc 0: subtract from the predicted picNum
                w.ue(delta - 1); // abs_diff_pic_num_minus1
                w.ue(3); // modification_of_pic_nums_idc 3: end of the list
            }
        }
    }

    // weighted_pred_flag is 1 and weighted_bipred_idc is 1, so every P and B
    // slice carries a table, whether or not it uses the flat prediction.
    if is_p || is_b {
        let l0 = cfg.num_ref_idx_l0_active.unwrap_or(1);
        let counts: &[u32] = if is_b {
            &[l0, cfg.num_ref_idx_l1_active.unwrap_or(1)]
        } else {
            &[l0]
        };
        write_pred_weight_table(w, counts, &cfg.flat_pred_ref_idx);
    }

    // dec_ref_pic_marking appears only for reference pictures.
    if cfg.reference {
        if cfg.idr {
            w.flag(false); // no_output_of_prior_pics_flag
            assert!(
                cfg.long_term_current.is_none_or(|frame_idx| frame_idx == 0),
                "clause 8.2.5.1 gives an IDR marked long-term LongTermFrameIdx 0"
            );
            w.flag(cfg.long_term_current.is_some()); // long_term_reference_flag
        } else {
            w.flag(cfg.long_term_current.is_some()); // adaptive_ref_pic_marking_mode_flag
            if let Some(frame_idx) = cfg.long_term_current {
                // 4: raise MaxLongTermFrameIdx to the index about to be used.
                // The IDR left it at "no long-term frame indices", and clause
                // 7.4.3.3 lets the command below name nothing above it.
                w.ue(4); // memory_management_control_operation
                w.ue(frame_idx + 1); // max_long_term_frame_idx_plus1
                                     // 6: mark the current picture long-term. Step 3 of clause
                                     // 8.2.5.1 then leaves it out of the short-term chain, which is
                                     // what the sliding window would otherwise have put it in.
                w.ue(6); // memory_management_control_operation
                w.ue(frame_idx); // long_term_frame_idx
                w.ue(0); // memory_management_control_operation: end of the list
            }
        }
    } else {
        assert!(!cfg.idr, "an IDR picture must be a reference picture");
        assert!(
            cfg.long_term_current.is_none(),
            "only a reference picture can be marked long-term"
        );
    }

    // entropy_coding_mode_flag is 0, so no cabac_init_idc.

    w.se(cfg.slice_qp - cfg.pps_init_qp); // slice_qp_delta

    // deblocking_filter_control_present_flag is 1 in the PPS.
    w.ue(cfg.disable_deblocking_filter_idc);
    if cfg.disable_deblocking_filter_idc != 1 {
        w.se(0); // slice_alpha_c0_offset_div2
        w.se(0); // slice_beta_offset_div2
    }
}
