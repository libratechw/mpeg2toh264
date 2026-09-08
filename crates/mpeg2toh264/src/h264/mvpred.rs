//! H.264 motion vector prediction (clause 8.4.1.3).
//!
//! Vectors are coded as differences from a prediction derived from the
//! neighbouring macroblocks, so the encoder has to reproduce that derivation
//! exactly to know what difference to send. State is stored per 4x4 luma block
//! so both 16x16 and 16x8 macroblock partitions can use the same neighbour
//! derivation.

#[cfg(feature = "experimental-adaptive-mbaff")]
use crate::h264::mba::MbaffModes;

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
    blk_w: usize,
    blk_h: usize,
    ref_idx: Vec<i8>,
    mv: Vec<i32>,
    coded: Vec<u8>,
    #[cfg(feature = "experimental-adaptive-mbaff")]
    mixed_modes: Option<MbaffModes>,
}

impl MotionField {
    pub fn new(mb_width: usize, mb_height: usize) -> Self {
        let blk_w = mb_width * 4;
        let blk_h = mb_height * 4;
        Self {
            blk_w,
            blk_h,
            ref_idx: vec![0; blk_w * blk_h * 2],
            mv: vec![0; blk_w * blk_h * 4],
            coded: vec![0; blk_w * blk_h],
            #[cfg(feature = "experimental-adaptive-mbaff")]
            mixed_modes: None,
        }
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    pub(crate) fn enable_mixed(&mut self, modes: MbaffModes) {
        self.mixed_modes = Some(modes);
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    pub(crate) fn disable_mixed(&mut self) {
        self.mixed_modes = None;
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

    pub fn set(&mut self, mb_x: usize, mb_y: usize, m: &MbMotion) {
        self.set_rect(mb_x * 4, mb_y * 4, 4, 4, m);
    }

    /// Record one half of a 16x8-partitioned macroblock.
    pub fn set_16x8(&mut self, mb_x: usize, mb_y: usize, part: usize, m: &MbMotion) {
        self.set_rect(mb_x * 4, mb_y * 4 + part * 2, 4, 2, m);
    }

    fn set_rect(&mut self, bx: usize, by: usize, width: usize, height: usize, m: &MbMotion) {
        for y in by..by + height {
            let start = y * self.blk_w + bx;
            let end = start + width;
            self.coded[start..end].fill(1);
            for refs in self.ref_idx[start * 2..end * 2].chunks_exact_mut(2) {
                refs[0] = m.ref_idx_l0 as i8;
                refs[1] = m.ref_idx_l1 as i8;
            }
            for mv in self.mv[start * 4..end * 4].chunks_exact_mut(4) {
                mv.copy_from_slice(&[m.mv_l0x, m.mv_l0y, m.mv_l1x, m.mv_l1y]);
            }
        }
    }

    fn at(&self, bx: isize, by: isize, list: usize) -> Neighbour {
        if bx < 0 || by < 0 || bx >= self.blk_w as isize || by >= self.blk_h as isize {
            return UNAVAILABLE;
        }
        let i = by as usize * self.blk_w + bx as usize;
        if self.coded[i] == 0 {
            return UNAVAILABLE;
        }
        let list_offset = list * 2;
        Neighbour {
            available: true,
            ref_idx: self.ref_idx[i * 2 + list] as i32,
            mv_x: self.mv[i * 4 + list_offset],
            mv_y: self.mv[i * 4 + list_offset + 1],
        }
    }

    /// Predicted vector for a 16x16 partition, in quarter samples.
    ///
    /// Neighbours are the macroblock to the left, above, and above-right --
    /// falling back to above-left when above-right is outside the picture. If
    /// exactly one of them uses the same reference index, its vector is taken
    /// directly; otherwise the component-wise median is used.
    pub fn predict(&self, mb_x: usize, mb_y: usize, list: usize, ref_idx: i32) -> [i32; 2] {
        self.predict_at(mb_x as isize * 4, mb_y as isize * 4, 4, list, ref_idx)
    }

    /// Predicted vector for the top or bottom partition of a 16x8 macroblock.
    pub fn predict_16x8(
        &self,
        mb_x: usize,
        mb_y: usize,
        part: usize,
        list: usize,
        ref_idx: i32,
    ) -> [i32; 2] {
        let bx = mb_x as isize * 4;
        let by = mb_y as isize * 4 + part as isize * 2;
        let a = self.at(bx - 1, by, list);
        let b = self.at(bx, by - 1, list);
        let same_ref = |n: &Neighbour| n.available && n.ref_idx == ref_idx;
        // Clause 8.4.1.3: 16x8 top prefers B and bottom prefers A before the
        // general median/reference-match process.
        if part == 0 && same_ref(&b) {
            return vector_of(&b);
        }
        if part == 1 && same_ref(&a) {
            return vector_of(&a);
        }
        let mut c = self.at(bx + 4, by - 1, list);
        if !c.available {
            c = self.at(bx - 1, by - 1, list);
        }
        predict_from_neighbours(a, b, c, ref_idx)
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    pub(crate) fn predict_mixed(
        &self,
        mb_x: usize,
        mb_y: usize,
        list: usize,
        ref_idx: i32,
    ) -> [i32; 2] {
        let modes = self
            .mixed_modes
            .as_ref()
            .expect("mixed predictor requires MBAFF modes");
        self.predict_mixed_at(modes, mb_x, mb_y, 0, 0, 16, list, ref_idx)
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    pub(crate) fn predict_16x8_mixed(
        &self,
        mb_x: usize,
        mb_y: usize,
        part: usize,
        list: usize,
        ref_idx: i32,
    ) -> [i32; 2] {
        let modes = self
            .mixed_modes
            .as_ref()
            .expect("mixed predictor requires MBAFF modes");
        let by = part as i32 * 8;
        let a = self.mixed_at(modes, mb_x, mb_y, -1, by, list);
        let b = self.mixed_at(modes, mb_x, mb_y, 0, by - 1, list);
        let same_ref = |n: &Neighbour| n.available && n.ref_idx == ref_idx;
        if part == 0 && same_ref(&b) {
            return vector_of(&b);
        }
        if part == 1 && same_ref(&a) {
            return vector_of(&a);
        }
        let mut c = self.mixed_at(modes, mb_x, mb_y, 16, by - 1, list);
        if !c.available {
            c = self.mixed_at(modes, mb_x, mb_y, -1, by - 1, list);
        }
        predict_from_neighbours(a, b, c, ref_idx)
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    fn predict_mixed_at(
        &self,
        modes: &MbaffModes,
        mb_x: usize,
        mb_y: usize,
        bx: i32,
        by: i32,
        width: i32,
        list: usize,
        ref_idx: i32,
    ) -> [i32; 2] {
        // Table 6-2 offsets are in samples. Convert to a 4x4 index only
        // after Table 6-4 has mapped the frame/field neighbour location.
        let a = self.mixed_at(modes, mb_x, mb_y, bx - 1, by, list);
        let b = self.mixed_at(modes, mb_x, mb_y, bx, by - 1, list);
        let mut c = self.mixed_at(modes, mb_x, mb_y, bx + width, by - 1, list);
        if !c.available {
            c = self.mixed_at(modes, mb_x, mb_y, bx - 1, by - 1, list);
        }
        predict_from_neighbours(a, b, c, ref_idx)
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    fn mixed_at(
        &self,
        modes: &MbaffModes,
        mb_x: usize,
        mb_y: usize,
        x_n: i32,
        y_n: i32,
        list: usize,
    ) -> Neighbour {
        let Some((nx, ny, x_w, y_w)) = modes.neighbour(mb_x, mb_y, x_n, y_n) else {
            return UNAVAILABLE;
        };
        let mut n = self.at(
            nx as isize * 4 + x_w as isize / 4,
            ny as isize * 4 + y_w as isize / 4,
            list,
        );
        if !n.available {
            return n;
        }
        // Clause 8.4.1.3.2 excludes unused lists (and intra neighbours)
        // from scaling. In particular, -1 / 2 must not become reference 0.
        if n.ref_idx < 0 {
            n.mv_x = 0;
            n.mv_y = 0;
            return n;
        }
        let current_field = !modes.frame[(mb_y / 2) * modes.mb_width + mb_x];
        let neighbour_field = !modes.frame[(ny / 2) * modes.mb_width + nx];
        if current_field && !neighbour_field {
            n.mv_y /= 2;
            n.ref_idx *= 2;
        } else if !current_field && neighbour_field {
            n.mv_y *= 2;
            n.ref_idx /= 2;
        }
        n
    }

    fn predict_at(
        &self,
        bx: isize,
        by: isize,
        width: isize,
        list: usize,
        ref_idx: i32,
    ) -> [i32; 2] {
        let a = self.at(bx - 1, by, list);
        let b = self.at(bx, by - 1, list);
        let mut c = self.at(bx + width, by - 1, list);
        if !c.available {
            c = self.at(bx - 1, by - 1, list);
        }

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
    #[cfg(feature = "experimental-adaptive-mbaff")]
    use crate::h264::mba::MbaffModes;

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

    #[test]
    fn with_no_neighbours_the_prediction_is_zero() {
        let mut field = MotionField::new(4, 4);
        field.reset();
        assert_eq!(field.predict(0, 0, 0, 0), [0, 0]);
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    #[test]
    fn mixed_unused_list_does_not_become_reference_zero() {
        let mut field = MotionField::new(2, 4);
        field.enable_mixed(MbaffModes::new(2, 2, vec![true, true, false, true]));
        // Current frame MB (1,2): A is a field neighbour not using L0;
        // B alone uses reference 0, while C is outside the picture.
        field.set(0, 2, &motion(-1, 0, 0));
        field.set(1, 1, &motion(0, 18, 22));
        assert_eq!(field.predict_mixed(1, 2, 0, 0), [18, 22]);
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    #[test]
    fn mixed_above_location_is_mapped_before_selecting_a_4x4_block() {
        let mut field = MotionField::new(1, 4);
        field.enable_mixed(MbaffModes::new(1, 2, vec![true, false]));
        field.set(0, 1, &motion(1, 8, 10));
        // Table 6-4: top field MB's B sample maps to yW=14 in the
        // bottom frame MB, hence its last 4x4 row, not row 2.
        field.set_rect(0, 7, 4, 1, &motion(1, 24, -7));
        assert_eq!(field.predict_16x8_mixed(0, 2, 0, 0, 2), [24, -3]);
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    #[test]
    fn mixed_field_reference_and_vertical_vector_are_scaled_for_frame() {
        let mut field = MotionField::new(2, 2);
        field.enable_mixed(MbaffModes::new(2, 1, vec![false, true]));
        field.set(0, 0, &motion(3, 9, -5));
        assert_eq!(field.predict_16x8_mixed(1, 0, 1, 0, 1), [9, -10]);
    }

    #[cfg(feature = "experimental-adaptive-mbaff")]
    #[test]
    fn uniform_mbaff_modes_preserve_existing_partition_predictors() {
        for frame in [true, false] {
            let mut mixed = MotionField::new(3, 4);
            mixed.enable_mixed(MbaffModes::new(3, 2, vec![frame; 6]));
            let mut reference_frame = MotionField::new(3, 4);
            let mut reference_fields = [MotionField::new(3, 2), MotionField::new(3, 2)];
            for pair_y in 0..2 {
                for x in 0..3 {
                    for parity in 0..2 {
                        let y = pair_y * 2 + parity;
                        let (reference, reference_y) = if frame {
                            (&mut reference_frame, y)
                        } else {
                            (&mut reference_fields[parity], pair_y)
                        };
                        for part in 0..2 {
                            for ref_idx in 0..3 {
                                assert_eq!(
                                    mixed.predict_16x8_mixed(x, y, part, 0, ref_idx),
                                    reference.predict_16x8(x, reference_y, part, 0, ref_idx),
                                    "frame={frame} x={x} y={y} part={part} ref={ref_idx}"
                                );
                            }
                            let id = (y * 6 + x * 2 + part) as i32;
                            let state = motion(id % 3, 7 * id - 13, 11 - 5 * id);
                            mixed.set_16x8(x, y, part, &state);
                            reference.set_16x8(x, reference_y, part, &state);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_lone_matching_reference_is_taken_directly() {
        let mut field = MotionField::new(4, 4);
        field.reset();
        // Left uses reference 0; above and above-right use reference 1.
        field.set(0, 1, &motion(0, 12, -4));
        field.set(1, 0, &motion(1, 100, 100));
        field.set(2, 0, &motion(1, 200, 200));
        assert_eq!(field.predict(1, 1, 0, 0), [12, -4]);
    }

    #[test]
    fn otherwise_the_component_wise_median_wins() {
        let mut field = MotionField::new(4, 4);
        field.reset();
        field.set(0, 1, &motion(0, 10, 40));
        field.set(1, 0, &motion(0, 30, 20));
        field.set(2, 0, &motion(0, 20, 30));
        assert_eq!(field.predict(1, 1, 0, 0), [20, 30]);
    }

    #[test]
    fn with_nothing_above_the_left_neighbour_stands_in_for_all_three() {
        let mut field = MotionField::new(4, 4);
        field.reset();
        field.set(0, 0, &motion(1, 7, -9));
        // Reference 0 matches none of them, so the median runs -- over three
        // copies of the left neighbour.
        assert_eq!(field.predict(1, 0, 0, 0), [7, -9]);
    }

    #[test]
    fn a_16x8_top_partition_prefers_the_neighbour_above() {
        let mut field = MotionField::new(4, 4);
        field.reset();
        field.set(1, 0, &motion(0, 44, 55));
        field.set(0, 1, &motion(0, 11, 22));
        assert_eq!(field.predict_16x8(1, 1, 0, 0, 0), [44, 55], "top takes B");
    }

    #[test]
    fn a_16x8_bottom_partition_prefers_the_neighbour_to_the_left() {
        let mut field = MotionField::new(4, 4);
        field.reset();
        field.set(0, 1, &motion(0, 11, 22));
        assert_eq!(
            field.predict_16x8(1, 1, 1, 0, 0),
            [11, 22],
            "bottom takes A"
        );
    }
}
