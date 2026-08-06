//! A field slice's reference list modification read back with a parser written
//! against clause 8.2.4.3.1 rather than against the writer, so a shared
//! misunderstanding of the field picture numbering cannot hide.

use mpeg2toh264::h264::bitwriter::BitWriter;
use mpeg2toh264::h264::slice::{
    write_slice_header, RefPicList, RefPicListEntry, SliceHeaderConfig, SliceType,
};

struct Reader {
    data: Vec<u8>,
    pos: usize,
}

impl Reader {
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
}

const LOG2_MAX_FRAME_NUM: u32 = 8;
const LOG2_MAX_POC_LSB: u32 = 16;
const MAX_PIC_NUM: i64 = 2 * (1 << LOG2_MAX_FRAME_NUM);

/// Run the reordering commands of one list and return the `PicNum` each one
/// selects, in the order the list ends up in.
fn read_modification(r: &mut Reader, frame_num: u32) -> Vec<i64> {
    let curr_pic_num = 2 * i64::from(frame_num) + 1;
    let mut selected = Vec::new();
    if !r.flag() {
        return selected;
    }
    let mut predicted = curr_pic_num;
    loop {
        let idc = r.ue();
        if idc == 3 {
            return selected;
        }
        assert!(
            idc < 2,
            "these lists name short-term fields only, got {idc}"
        );
        let difference = i64::from(r.ue()) + 1;
        let mut no_wrap = if idc == 0 {
            predicted - difference
        } else {
            predicted + difference
        };
        if no_wrap < 0 {
            no_wrap += MAX_PIC_NUM;
        } else if no_wrap >= MAX_PIC_NUM {
            no_wrap -= MAX_PIC_NUM;
        }
        predicted = no_wrap;
        selected.push(if no_wrap > curr_pic_num {
            no_wrap - MAX_PIC_NUM
        } else {
            no_wrap
        });
    }
}

/// Both lists of a B field slice, as `PicNum` values.
fn field_slice_lists(frame_num: u32, lists: [RefPicList; 2]) -> [Vec<i64>; 2] {
    let mut w = BitWriter::with_capacity(64);
    write_slice_header(
        &mut w,
        &SliceHeaderConfig {
            slice_type: SliceType::B,
            frame_num,
            log2_max_frame_num: LOG2_MAX_FRAME_NUM,
            log2_max_poc_lsb: LOG2_MAX_POC_LSB,
            mbaff: true,
            field_picture: Some(false),
            num_ref_idx_l0_active: Some(8),
            num_ref_idx_l1_active: Some(8),
            explicit_ref_lists: Some(lists),
            ..Default::default()
        },
    );
    // A real slice carries macroblock data here; the reader stops well before
    // the padding, which is only there to make the buffer whole bytes.
    w.rbsp_trailing_bits();
    let mut r = Reader {
        data: w.bytes().to_vec(),
        pos: 0,
    };
    assert_eq!(r.ue(), 0, "first_mb_in_slice");
    assert_eq!(r.ue(), SliceType::B.code(), "slice_type");
    assert_eq!(r.ue(), 0, "pic_parameter_set_id");
    assert_eq!(r.u(LOG2_MAX_FRAME_NUM), frame_num, "frame_num");
    assert!(r.flag(), "field_pic_flag");
    assert!(!r.flag(), "bottom_field_flag");
    r.u(LOG2_MAX_POC_LSB); // pic_order_cnt_lsb
    assert!(r.flag(), "direct_spatial_mv_pred_flag");
    assert!(r.flag(), "num_ref_idx_active_override_flag");
    assert_eq!(r.ue(), 7, "num_ref_idx_l0_active_minus1");
    assert_eq!(r.ue(), 7, "num_ref_idx_l1_active_minus1");
    let l0 = read_modification(&mut r, frame_num);
    let l1 = read_modification(&mut r, frame_num);
    [l0, l1]
}

fn list_of(entries: &[(u32, bool)]) -> RefPicList {
    let mut list = RefPicList::default();
    for &(frames_back, same_parity) in entries {
        list.push(RefPicListEntry {
            frames_back,
            same_parity,
        });
    }
    list
}

/// A field's `PicNum` is twice its frame's `FrameNumWrap`, plus one when it has
/// the parity of the field being coded (clause 8.2.4.1).
fn pic_num(frame_num: u32, frames_back: u32, same_parity: bool) -> i64 {
    2 * (i64::from(frame_num) - i64::from(frames_back)) + i64::from(same_parity)
}

#[test]
fn a_field_slice_names_every_short_term_field_of_both_lists() {
    // A B field between its references: list 0 counts back from the nearest
    // preceding frame and ends at the following one, list 1 starts there.
    let frame_num = 107;
    let l0 = [
        (2, true),
        (2, false),
        (3, true),
        (3, false),
        (1, true),
        (1, false),
    ];
    let l1 = [
        (1, true),
        (1, false),
        (2, true),
        (2, false),
        (3, true),
        (3, false),
    ];
    let read = field_slice_lists(frame_num, [list_of(&l0), list_of(&l1)]);
    for (list, expected) in read.iter().zip([l0, l1]) {
        let expected: Vec<i64> = expected
            .iter()
            .map(|&(back, same)| pic_num(frame_num, back, same))
            .collect();
        assert_eq!(*list, expected);
    }
    // The step forward to the following picture is the one command that has to
    // add rather than subtract, so the list is not merely descending.
    assert!(read[0][4] > read[0][3]);
}

#[test]
fn a_field_slice_list_survives_the_frame_num_wrapping_to_zero() {
    // frame_num has just wrapped, so every reference sits above the current
    // picture and its FrameNumWrap is negative.
    let frame_num = 1;
    let entries = [(2, true), (2, false), (3, true), (3, false)];
    let read = field_slice_lists(frame_num, [list_of(&entries), list_of(&entries)]);
    let expected: Vec<i64> = entries
        .iter()
        .map(|&(back, same)| pic_num(frame_num, back, same))
        .collect();
    assert!(expected.iter().all(|&num| num < 0), "{expected:?}");
    assert_eq!(read[0], expected);
    assert_eq!(read[1], expected);
}

#[test]
fn a_slice_without_explicit_lists_leaves_both_modification_flags_clear() {
    let read = field_slice_lists(107, [RefPicList::default(), RefPicList::default()]);
    assert!(read[0].is_empty());
    assert!(read[1].is_empty());
}
