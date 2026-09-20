//! H.264 motion vector prediction (clause 8.4.1.3).
//!
//! Vectors are coded as differences from a prediction derived from the
//! neighbouring macroblocks, so the encoder has to reproduce that derivation
//! exactly to know what difference to send. State is stored per 4x4 luma block
//! so both 16x16 and 16x8 macroblock partitions can use the same neighbour
//! derivation, and per macroblock address rather than by position so that a
//! frame macroblock and a field one can be neighbours: which of a pair holds a
//! given line is [`crate::h264::mbaff`]'s answer, and what a macroblock of the
//! other kind makes of the vector it finds there is clause 8.4.1.3.2's.

use crate::h264::mbaff::{self, Frame, Neighbourhood};

/// Motion state of one macroblock, as neighbours need to see it.
#[derive(Clone, Copy, Debug, Default)]
pub struct MbMotion {
    /// Reference index per list, or -1 where the list is unused.
    pub ref_idx_l0: i32,
    pub ref_idx_l1: i32,
    /// Vectors in quarter samples.
    pub mv_l0x: i32,
    pub mv_l0y: i32,
    pub mv_l1x: i32,
    pub mv_l1y: i32,
}

/// A neighbour as the predictor sees it; absent ones read as reference -1.
#[derive(Clone, Copy)]
struct Neighbour {
    available: bool,
    ref_idx: i32,
    mv_x: i32,
    mv_y: i32,
}

const UNAVAILABLE: Neighbour = Neighbour {
    available: false,
    ref_idx: -1,
    mv_x: 0,
    mv_y: 0,
};

fn median(a: i32, b: i32, c: i32) -> i32 {
    a + b + c - a.min(b).min(c) - a.max(b).max(c)
}

/// Per-picture record of macroblock motion, used to predict each macroblock's
/// vectors from its neighbours.
pub struct MotionField {
    /// Sixteen 4x4 blocks per macroblock, in raster order within it.
    ref_idx: Vec<i8>,
    mv: Vec<i32>,
    coded: Vec<u8>,
}

impl MotionField {
    pub fn new(mb_width: usize, mb_height: usize) -> Self {
        let blocks = mb_width * mb_height * 16;
        Self {
            ref_idx: vec![0; blocks * 2],
            mv: vec![0; blocks * 4],
            coded: vec![0; blocks],
        }
    }

    /// Empty the field for a new picture.
    ///
    /// Only the coded flags are cleared. `at` reads a block's reference indices
    /// and vectors solely after finding it coded, so what the previous picture
    /// left in them is never visible -- and they are nine tenths of the field,
    /// two megabytes a picture the browser build would write by hand.
    pub fn reset(&mut self) {
        self.coded.fill(0);
    }

    pub fn set(&mut self, address: usize, m: &MbMotion) {
        self.set_rows(address, 0, 4, m);
    }

    /// Record one half of a 16x8-partitioned macroblock.
    pub fn set_16x8(&mut self, address: usize, part: usize, m: &MbMotion) {
        self.set_rows(address, part * 2, 2, m);
    }

    fn set_rows(&mut self, address: usize, first_row: usize, rows: usize, m: &MbMotion) {
        let base = address * 16 + first_row * 4;
        let end = base + rows * 4;
        self.coded[base..end].fill(1);
        for refs in self.ref_idx[base * 2..end * 2].chunks_exact_mut(2) {
            refs[0] = m.ref_idx_l0 as i8;
            refs[1] = m.ref_idx_l1 as i8;
        }
        for mv in self.mv[base * 4..end * 4].chunks_exact_mut(4) {
            mv.copy_from_slice(&[m.mv_l0x, m.mv_l0y, m.mv_l1x, m.mv_l1y]);
        }
    }

    /// The neighbouring partition at a luma location relative to the current
    /// macroblock, as clause 8.4.1.3.2 hands it over.
    ///
    /// A field macroblock counts lines half as often as a frame one, so a
    /// vector read across that boundary is scaled and its reference index moved
    /// between the frame list and the field list built from it.
    fn at(
        &self,
        frame: &Frame,
        address: usize,
        found: Option<mbaff::Neighbour>,
        list: usize,
    ) -> Neighbour {
        let Some(found) = found else {
            return UNAVAILABLE;
        };
        let block = found.address * 16 + (found.y / 4) * 4 + found.x / 4;
        if self.coded[block] == 0 {
            return UNAVAILABLE;
        }
        let list_offset = list * 2;
        let mut neighbour = Neighbour {
            available: true,
            ref_idx: self.ref_idx[block * 2 + list] as i32,
            mv_x: self.mv[block * 4 + list_offset],
            mv_y: self.mv[block * 4 + list_offset + 1],
        };
        // A neighbour that does not predict from this list has nothing to
        // scale: -1 says so, and it has to stay -1 rather than become some
        // reference index the current macroblock might match.
        if neighbour.ref_idx >= 0 {
            match (frame.is_field(address), frame.is_field(found.address)) {
                (true, false) => {
                    neighbour.mv_y /= 2;
                    neighbour.ref_idx *= 2;
                }
                (false, true) => {
                    neighbour.mv_y *= 2;
                    neighbour.ref_idx /= 2;
                }
                _ => {}
            }
        }
        neighbour
    }

    /// Predicted vector for a 16x16 partition, in quarter samples.
    ///
    /// Neighbours are the macroblock to the left, above, and above-right --
    /// falling back to above-left when above-right is outside the picture. If
    /// exactly one of them uses the same reference index, its vector is taken
    /// directly; otherwise the component-wise median is used.
    pub fn predict(&self, frame: &Frame, address: usize, list: usize, ref_idx: i32) -> [i32; 2] {
        self.predict_in(frame, address, &frame.neighbourhood(address), list, ref_idx)
    }

    /// [`Self::predict`] with the neighbours already derived, which a
    /// macroblock does once and then uses for both lists.
    pub fn predict_in(
        &self,
        frame: &Frame,
        address: usize,
        hood: &Neighbourhood,
        list: usize,
        ref_idx: i32,
    ) -> [i32; 2] {
        let a = self.at(frame, address, hood.a, list);
        let b = self.at(frame, address, hood.b, list);
        let mut c = self.at(frame, address, hood.c, list);
        if !c.available {
            c = self.at(frame, address, hood.d, list);
        }
        predict_from_neighbours(a, b, c, ref_idx)
    }

    /// Predicted vector for the top or bottom partition of a 16x8 macroblock.
    pub fn predict_16x8(
        &self,
        frame: &Frame,
        address: usize,
        part: usize,
        list: usize,
        ref_idx: i32,
    ) -> [i32; 2] {
        self.predict_16x8_in(
            frame,
            address,
            &frame.neighbourhood(address),
            part,
            list,
            ref_idx,
        )
    }

    /// [`Self::predict_16x8`] with the corner's neighbours already derived.
    /// The top partition uses them as they are; the bottom one starts eight
    /// lines down, where the neighbour above is the macroblock's own top half
    /// and above-right is never available.
    pub fn predict_16x8_in(
        &self,
        frame: &Frame,
        address: usize,
        hood: &Neighbourhood,
        part: usize,
        list: usize,
        ref_idx: i32,
    ) -> [i32; 2] {
        let (a, b) = if part == 0 {
            (
                self.at(frame, address, hood.a, list),
                self.at(frame, address, hood.b, list),
            )
        } else {
            (
                self.at(
                    frame,
                    address,
                    frame.neighbour(address, -1, 8, 16, 16),
                    list,
                ),
                self.at(
                    frame,
                    address,
                    Some(mbaff::Neighbour {
                        address,
                        x: 0,
                        y: 7,
                    }),
                    list,
                ),
            )
        };
        let same_ref = |n: &Neighbour| n.available && n.ref_idx == ref_idx;
        // Clause 8.4.1.3: 16x8 top prefers B and bottom prefers A before the
        // general median/reference-match process.
        if part == 0 && same_ref(&b) {
            return vector_of(&b);
        }
        if part == 1 && same_ref(&a) {
            return vector_of(&a);
        }
        let c = if part == 0 {
            let c = self.at(frame, address, hood.c, list);
            if c.available {
                c
            } else {
                self.at(frame, address, hood.d, list)
            }
        } else {
            self.at(
                frame,
                address,
                frame.neighbour(address, -1, 7, 16, 16),
                list,
            )
        };
        predict_from_neighbours(a, b, c, ref_idx)
    }
}

fn predict_from_neighbours(a: Neighbour, b: Neighbour, c: Neighbour, ref_idx: i32) -> [i32; 2] {
    let (r_a, x_a, y_a) = (a.ref_idx, a.mv_x, a.mv_y);
    let (mut r_b, mut x_b, mut y_b) = (b.ref_idx, b.mv_x, b.mv_y);
    let (mut r_c, mut x_c, mut y_c) = (c.ref_idx, c.mv_x, c.mv_y);

    // With nothing above, the left neighbour stands in for all three.
    if !b.available && !c.available && a.available {
        r_b = r_a;
        x_b = x_a;
        y_b = y_a;
        r_c = r_a;
        x_c = x_a;
        y_c = y_a;
    }

    let matches = i32::from(r_a == ref_idx) + i32::from(r_b == ref_idx) + i32::from(r_c == ref_idx);
    if matches == 1 {
        if r_a == ref_idx {
            return [x_a, y_a];
        }
        if r_b == ref_idx {
            return [x_b, y_b];
        }
        return [x_c, y_c];
    }
    [median(x_a, x_b, x_c), median(y_a, y_b, y_c)]
}

fn vector_of(n: &Neighbour) -> [i32; 2] {
    [n.mv_x, n.mv_y]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn motion(ref_idx: i32, x: i32, y: i32) -> MbMotion {
        MbMotion {
            ref_idx_l0: ref_idx,
            ref_idx_l1: -1,
            mv_l0x: x,
            mv_l0y: y,
            mv_l1x: 0,
            mv_l1y: 0,
        }
    }

    /// A picture whose every macroblock may be looked at, addressed spatially.
    fn picture(mb_width: usize, mb_height: usize) -> (Frame, MotionField) {
        let frame = Frame::new(mb_width, mb_height, false);
        let mut field = MotionField::new(mb_width, mb_height);
        field.reset();
        (frame, field)
    }

    #[test]
    fn with_no_neighbours_the_prediction_is_zero() {
        let (frame, field) = picture(4, 4);
        assert_eq!(field.predict(&frame, frame.address(0, 0), 0, 0), [0, 0]);
    }

    #[test]
    fn a_lone_matching_reference_is_taken_directly() {
        let (frame, mut field) = picture(4, 4);
        // Left uses reference 0; above and above-right use reference 1.
        field.set(frame.address(0, 1), &motion(0, 12, -4));
        field.set(frame.address(1, 0), &motion(1, 100, 100));
        field.set(frame.address(2, 0), &motion(1, 200, 200));
        assert_eq!(field.predict(&frame, frame.address(1, 1), 0, 0), [12, -4]);
    }

    #[test]
    fn otherwise_the_component_wise_median_wins() {
        let (frame, mut field) = picture(4, 4);
        field.set(frame.address(0, 1), &motion(0, 10, 40));
        field.set(frame.address(1, 0), &motion(0, 30, 20));
        field.set(frame.address(2, 0), &motion(0, 20, 30));
        assert_eq!(field.predict(&frame, frame.address(1, 1), 0, 0), [20, 30]);
    }

    #[test]
    fn with_nothing_above_the_left_neighbour_stands_in_for_all_three() {
        let (frame, mut field) = picture(4, 4);
        field.set(frame.address(0, 0), &motion(1, 7, -9));
        // Reference 0 matches none of them, so the median runs -- over three
        // copies of the left neighbour.
        assert_eq!(field.predict(&frame, frame.address(1, 0), 0, 0), [7, -9]);
    }

    #[test]
    fn a_16x8_top_partition_prefers_the_neighbour_above() {
        let (frame, mut field) = picture(4, 4);
        field.set(frame.address(1, 0), &motion(0, 44, 55));
        field.set(frame.address(0, 1), &motion(0, 11, 22));
        assert_eq!(
            field.predict_16x8(&frame, frame.address(1, 1), 0, 0, 0),
            [44, 55],
            "top takes B"
        );
    }

    #[test]
    fn a_16x8_bottom_partition_prefers_the_neighbour_to_the_left() {
        let (frame, mut field) = picture(4, 4);
        field.set(frame.address(0, 1), &motion(0, 11, 22));
        assert_eq!(
            field.predict_16x8(&frame, frame.address(1, 1), 1, 0, 0),
            [11, 22],
            "bottom takes A"
        );
    }

    #[test]
    fn a_vector_read_across_the_field_boundary_is_scaled() {
        let mut frame = Frame::new(4, 4, true);
        // The left pair is field coded and holds a vector in field lines; the
        // current pair is frame coded and counts twice as many.
        frame.set_field_pair(frame.address(0, 0), true);
        let mut field = MotionField::new(4, 4);
        field.reset();
        field.set(frame.address(0, 0), &motion(2, 8, 20));
        let at = frame.address(1, 0);
        assert_eq!(
            field.predict(&frame, at, 0, 1),
            [8, 40],
            "the vertical vector doubles and the reference index halves"
        );
    }
}
