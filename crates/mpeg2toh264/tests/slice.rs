//! A slice's reference list modification read back with a parser written
//! against clause 8.2.4.3.1 rather than against the writer, so a shared
//! misunderstanding of the picture numbering cannot hide.

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
const MAX_FRAME_NUM: i64 = 1 << LOG2_MAX_FRAME_NUM;

/// Run the reordering commands of one list and return the `PicNum` each one
/// selects, in the order the list ends up in.
fn read_modification(r: &mut Reader, frame_num: u32, field: bool) -> Vec<i64> {
    let max_pic_num = if field {
        2 * MAX_FRAME_NUM
    } else {
        MAX_FRAME_NUM
    };
    // CurrPicNum: frame_num for a frame, 2 * frame_num + 1 for a field.
    let curr_pic_num = pic_num(frame_num, 0, true, field);
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
            no_wrap += max_pic_num;
        } else if no_wrap >= max_pic_num {
            no_wrap -= max_pic_num;
        }
        predicted = no_wrap;
        selected.push(if no_wrap > curr_pic_num {
            no_wrap - max_pic_num
        } else {
            no_wrap
        });
    }
}

/// Both lists of a B slice, as `PicNum` values.
fn slice_lists(frame_num: u32, lists: [RefPicList; 2], field: bool) -> [Vec<i64>; 2] {
    let mut w = BitWriter::with_capacity(64);
    write_slice_header(
        &mut w,
        &SliceHeaderConfig {
            slice_type: SliceType::B,
            frame_num,
            log2_max_frame_num: LOG2_MAX_FRAME_NUM,
            log2_max_poc_lsb: LOG2_MAX_POC_LSB,
            mbaff: true,
            field_picture: field.then_some(false),
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
    assert_eq!(r.flag(), field, "field_pic_flag");
    if field {
        assert!(!r.flag(), "bottom_field_flag");
    }
    r.u(LOG2_MAX_POC_LSB); // pic_order_cnt_lsb
    assert!(r.flag(), "direct_spatial_mv_pred_flag");
    assert!(r.flag(), "num_ref_idx_active_override_flag");
    assert_eq!(r.ue(), 7, "num_ref_idx_l0_active_minus1");
    assert_eq!(r.ue(), 7, "num_ref_idx_l1_active_minus1");
    let l0 = read_modification(&mut r, frame_num, field);
    let l1 = read_modification(&mut r, frame_num, field);
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

/// A frame's `PicNum` is its `FrameNumWrap`; a field's is twice that, plus one
/// when it has the parity of the field being coded (clause 8.2.4.1).
fn pic_num(frame_num: u32, frames_back: u32, same_parity: bool, field: bool) -> i64 {
    let frame_num_wrap = i64::from(frame_num) - i64::from(frames_back);
    if field {
        2 * frame_num_wrap + i64::from(same_parity)
    } else {
        frame_num_wrap
    }
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
    let read = slice_lists(frame_num, [list_of(&l0), list_of(&l1)], true);
    for (list, expected) in read.iter().zip([l0, l1]) {
        let expected: Vec<i64> = expected
            .iter()
            .map(|&(back, same)| pic_num(frame_num, back, same, true))
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
    let read = slice_lists(frame_num, [list_of(&entries), list_of(&entries)], true);
    let expected: Vec<i64> = entries
        .iter()
        .map(|&(back, same)| pic_num(frame_num, back, same, true))
        .collect();
    assert!(expected.iter().all(|&num| num < 0), "{expected:?}");
    assert_eq!(read[0], expected);
    assert_eq!(read[1], expected);
}

#[test]
fn a_frame_slice_names_one_entry_per_reference_frame() {
    // The first B picture behind a random access point: list 0 reaches the IDR
    // three frame numbers back and then the reference picture it was decoded
    // behind, which is the one command that has to count forward.
    let frame_num = 3;
    let l0 = [(3, true), (1, true)];
    let l1 = [(1, true), (3, true)];
    let read = slice_lists(frame_num, [list_of(&l0), list_of(&l1)], false);
    assert_eq!(
        read[0],
        vec![0, 2],
        "list 0 names the IDR and then PicNum 2"
    );
    assert_eq!(read[1], vec![2, 0]);
    // A frame numbers its references by FrameNumWrap alone, so the parity bit
    // the entries carry for a field must not reach the bitstream.
    let same: Vec<i64> = l0
        .iter()
        .map(|&(back, _)| pic_num(frame_num, back, false, false))
        .collect();
    assert_eq!(read[0], same);
}

/// `dec_ref_pic_marking` of an I slice, which is all an IDR carries.
fn idr_marking(long_term: Option<u32>) -> (bool, bool) {
    let mut w = BitWriter::with_capacity(32);
    write_slice_header(
        &mut w,
        &SliceHeaderConfig {
            slice_type: SliceType::I,
            log2_max_frame_num: LOG2_MAX_FRAME_NUM,
            log2_max_poc_lsb: LOG2_MAX_POC_LSB,
            idr: true,
            reference: true,
            long_term_current: long_term,
            ..Default::default()
        },
    );
    w.rbsp_trailing_bits();
    let mut r = Reader {
        data: w.bytes().to_vec(),
        pos: 0,
    };
    assert_eq!(r.ue(), 0, "first_mb_in_slice");
    assert_eq!(r.ue(), SliceType::I.code(), "slice_type");
    assert_eq!(r.ue(), 0, "pic_parameter_set_id");
    r.u(LOG2_MAX_FRAME_NUM); // frame_num
    assert_eq!(r.ue(), 0, "idr_pic_id");
    r.u(LOG2_MAX_POC_LSB); // pic_order_cnt_lsb
    (r.flag(), r.flag()) // no_output_of_prior_pics_flag, long_term_reference_flag
}

#[test]
fn an_idr_marks_itself_long_term_with_the_flag_rather_than_a_command() {
    // Clause 7.4.3.3 gives an IDR no memory management commands at all, so the
    // flag is the only way it can take the long-term slot -- and it fixes
    // LongTermFrameIdx at 0, which is why nothing else may be asked for.
    assert_eq!(idr_marking(Some(0)), (false, true));
    assert_eq!(idr_marking(None), (false, false));
}

#[test]
#[should_panic(expected = "LongTermFrameIdx 0")]
fn an_idr_cannot_ask_for_another_long_term_frame_index() {
    idr_marking(Some(1));
}

#[test]
fn a_slice_without_explicit_lists_leaves_both_modification_flags_clear() {
    let read = slice_lists(107, [RefPicList::default(), RefPicList::default()], true);
    assert!(read[0].is_empty());
    assert!(read[1].is_empty());
}
