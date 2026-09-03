//! Where a macroblock's neighbours are, when a picture mixes frame and field
//! macroblock pairs (clauses 6.4.10 and 6.4.12.2).
//!
//! A decoder derives motion vector predictors and CAVLC coefficient counts from
//! the macroblocks to the left and above, so an encoder has to reach the same
//! ones. Without MBAFF that is arithmetic on the raster address. With it, a pair
//! holds either two frame macroblocks stacked or two field macroblocks
//! interleaved, and which of the neighbouring pair's two macroblocks holds a
//! given line depends on both pairs' choice -- which is what Table 6-4 spells
//! out and this reproduces.
//!
//! Addresses count macroblocks in decoding order: pairs in raster order, the
//! top macroblock of a pair then the bottom one. A picture that is not
//! macroblock-adaptive is addressed the same way with every pair frame-coded,
//! which reduces the table to plain raster arithmetic.

use std::cell::Cell;

/// A neighbouring location: which macroblock holds it and where inside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Neighbour {
    pub address: usize,
    /// Column inside the macroblock, in samples of whichever component asked.
    pub x: usize,
    /// Row inside the macroblock, likewise.
    pub y: usize,
}

/// The shape of a picture and how each of its pairs is coded.
///
/// Whether a macroblock has been coded yet is not here: the caller's own record
/// of what it wrote answers that, and every pair this consults has been coded
/// already, since all four neighbours precede the current macroblock in
/// decoding order.
pub struct Frame {
    mb_width: usize,
    /// How many macroblocks the picture holds, which is what puts an address
    /// inside it or outside.
    macroblocks: usize,
    mbaff: bool,
    /// Indexed by pair address; meaningless where `mbaff` is false.
    field_pair: Vec<bool>,
    /// The last macroblock asked about and what its four neighbouring pairs
    /// are, since a macroblock asks about them a couple of dozen times.
    remembered: Cell<(usize, [isize; 4])>,
}

impl Frame {
    pub fn new(mb_width: usize, mb_height: usize, mbaff: bool) -> Self {
        let macroblocks = mb_width * mb_height;
        Self {
            mb_width,
            macroblocks,
            mbaff,
            field_pair: vec![false; macroblocks.div_ceil(2)],
            remembered: Cell::new((usize::MAX, [-1; 4])),
        }
    }

    /// Whether the picture about to be coded is macroblock-adaptive.
    pub fn set_mbaff(&mut self, mbaff: bool) {
        self.mbaff = mbaff;
        self.remembered.set((usize::MAX, [-1; 4]));
    }

    /// The address of the macroblock at `(mb_x, mb_y)`, spatially.
    #[inline]
    pub fn address(&self, mb_x: usize, mb_y: usize) -> usize {
        if self.mbaff {
            (mb_y / 2 * self.mb_width + mb_x) * 2 + mb_y % 2
        } else {
            mb_y * self.mb_width + mb_x
        }
    }

    /// Say how a pair is coded, before either of its macroblocks is written.
    pub fn set_field_pair(&mut self, address: usize, field: bool) {
        if self.mbaff {
            self.field_pair[address / 2] = field;
        }
    }

    #[inline]
    pub fn is_field(&self, address: usize) -> bool {
        self.mbaff && self.field_pair[address / 2]
    }

    #[inline]
    fn inside(&self, address: isize) -> bool {
        address >= 0 && (address as usize) < self.macroblocks
    }

    /// The address of the top macroblock of the pair left of, above,
    /// above-right of and above-left of `address`, remembered because every
    /// lookup a macroblock makes wants the same four and working them out costs
    /// four divisions.
    fn neighbour_addresses(&self, address: usize) -> [isize; 4] {
        let (remembered, addresses) = self.remembered.get();
        if remembered == address {
            return addresses;
        }
        let addresses = self.derive_neighbour_addresses(address);
        self.remembered.set((address, addresses));
        addresses
    }

    /// Clause 6.4.10, or the plain neighbouring addresses where the picture is
    /// not macroblock-adaptive (clause 6.4.9).
    fn derive_neighbour_addresses(&self, address: usize) -> [isize; 4] {
        let width = self.mb_width as isize;
        if self.mbaff {
            let pair = (address / 2) as isize;
            let column = pair % width;
            let a = if column == 0 { -1 } else { 2 * (pair - 1) };
            let b = 2 * (pair - width);
            let c = if (pair + 1) % width == 0 {
                -1
            } else {
                2 * (pair - width + 1)
            };
            let d = if column == 0 {
                -1
            } else {
                2 * (pair - width - 1)
            };
            [a, b, c, d]
        } else {
            let at = address as isize;
            let column = at % width;
            let a = if column == 0 { -1 } else { at - 1 };
            let b = at - width;
            let c = if (at + 1) % width == 0 {
                -1
            } else {
                at - width + 1
            };
            let d = if column == 0 { -1 } else { at - width - 1 };
            [a, b, c, d]
        }
    }

    /// The macroblock holding `(x, y)` relative to `address`'s upper-left
    /// corner, where the component is `width` by `height` samples per
    /// macroblock.
    ///
    /// `None` where the location falls outside the picture or into a
    /// macroblock this slice has not coded yet.
    pub fn neighbour(
        &self,
        address: usize,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Option<Neighbour> {
        let inside_x = (0..width).contains(&x);
        // Most of what asks is inside the macroblock it started from -- a
        // block's left and upper neighbours are its own for all but the first
        // row and column -- and that answer costs nothing.
        if inside_x && (0..height).contains(&y) {
            return Some(Neighbour {
                address,
                x: x as usize,
                y: y as usize,
            });
        }
        if y >= height || (x >= width && y >= 0) {
            return None;
        }
        let [a, b, c, d] = self.neighbour_addresses(address);
        let (target, row) = if self.mbaff {
            self.mbaff_target(address, x, y, width, height, [a, b, c, d])?
        } else {
            let target = if y < 0 {
                if x < 0 {
                    d
                } else if inside_x {
                    b
                } else {
                    c
                }
            } else if x < 0 {
                a
            } else if inside_x {
                address as isize
            } else {
                return None;
            };
            (target, y)
        };
        if !self.inside(target) {
            return None;
        }
        // Equations 6-36 and 6-37 wrap the location into the macroblock it
        // landed in. Nothing asks about more than one macroblock away, so
        // adding or taking the width once is the whole of the modulo.
        let wrap = |value: i32, size: i32| {
            if value < 0 {
                value + size
            } else if value >= size {
                value - size
            } else {
                value
            }
        };
        Some(Neighbour {
            address: target as usize,
            x: wrap(x, width) as usize,
            y: wrap(row, height) as usize,
        })
    }

    /// Table 6-4, which says which macroblock of the neighbouring pair holds
    /// the location and which of its rows that is.
    ///
    /// The macroblock chosen by the first column of the table -- mbAddrX -- is
    /// what decides availability, and the one returned is either it or the
    /// macroblock below it in the same pair, so the two share that answer.
    fn mbaff_target(
        &self,
        address: usize,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        [a, b, c, d]: [isize; 4],
    ) -> Option<(isize, i32)> {
        let current_frame = !self.is_field(address);
        let top = address % 2 == 0;
        let inside_x = (0..width).contains(&x);
        // The table names a pair -- mbAddrX -- and then one of its two
        // macroblocks, so whether the pair is there at all is settled first and
        // the same answer covers both halves of it.
        let this = |pair_top: isize| self.inside(pair_top).then_some(pair_top);
        let below = |pair_top: isize| self.inside(pair_top).then_some(pair_top + 1);
        let frame_at = |pair_top: isize| -> Option<bool> {
            self.inside(pair_top)
                .then(|| !self.is_field(pair_top as usize))
        };

        if x < 0 && y < 0 {
            return Some(if current_frame {
                if top {
                    (below(d)?, y)
                } else if frame_at(a)? {
                    (a, y)
                } else {
                    (a + 1, (y + height) >> 1)
                }
            } else if top {
                if frame_at(d)? {
                    (d + 1, 2 * y)
                } else {
                    (d, y)
                }
            } else {
                (below(d)?, y)
            });
        }
        if x < 0 {
            let a_frame = frame_at(a)?;
            return Some(if current_frame {
                if top {
                    if a_frame {
                        (a, y)
                    } else {
                        (a + isize::from(y % 2 != 0), y >> 1)
                    }
                } else if a_frame {
                    (a + 1, y)
                } else {
                    (a + isize::from(y % 2 != 0), (y + height) >> 1)
                }
            } else if top {
                if !a_frame {
                    (a, y)
                } else if y < height / 2 {
                    (a, y << 1)
                } else {
                    (a + 1, (y << 1) - height)
                }
            } else if !a_frame {
                (a + 1, y)
            } else if y < height / 2 {
                (a, (y << 1) + 1)
            } else {
                (a + 1, (y << 1) + 1 - height)
            });
        }
        if y < 0 {
            // Above and above-right differ only in which pair they ask about,
            // and above-right of a bottom frame macroblock is inside the pair
            // that has not been coded yet.
            let (pair, above_right) = if inside_x { (b, false) } else { (c, true) };
            return Some(if current_frame {
                if top {
                    (below(pair)?, y)
                } else if above_right {
                    return None;
                } else {
                    (address as isize - 1, y)
                }
            } else if top {
                if frame_at(pair)? {
                    (pair + 1, 2 * y)
                } else {
                    (this(pair)?, y)
                }
            } else {
                (below(pair)?, y)
            });
        }
        Some((address as isize, y))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every pair frame-coded, which is what a picture looks like today.
    fn frame_coded(mb_width: usize, mb_height: usize) -> Frame {
        Frame::new(mb_width, mb_height, true)
    }

    #[test]
    fn without_mbaff_the_neighbours_are_raster_arithmetic() {
        let frame = Frame::new(4, 4, false);
        let at = frame.address(2, 2);
        assert_eq!(
            frame.neighbour(at, -1, 0, 16, 16),
            Some(Neighbour {
                address: 9,
                x: 15,
                y: 0
            }),
            "left"
        );
        assert_eq!(
            frame.neighbour(at, 0, -1, 16, 16),
            Some(Neighbour {
                address: 6,
                x: 0,
                y: 15
            }),
            "above"
        );
        assert_eq!(
            frame.neighbour(at, 16, -1, 16, 16),
            Some(Neighbour {
                address: 7,
                x: 0,
                y: 15
            }),
            "above right"
        );
        assert_eq!(frame.neighbour(at, 0, 16, 16, 16), None, "below");
    }

    #[test]
    fn a_frame_pair_looks_up_at_the_bottom_of_the_pair_above() {
        let frame = frame_coded(4, 4);
        // Spatial (1, 2) is the top macroblock of the second pair row.
        let at = frame.address(1, 2);
        assert_eq!(at, 2 * (1 * 4 + 1));
        let above = frame.neighbour(at, 0, -1, 16, 16).expect("available");
        assert_eq!(
            above.address,
            frame.address(1, 1),
            "the pair above's bottom"
        );
        assert_eq!(above.y, 15);
        // The bottom macroblock of a frame pair looks up at its own top half.
        let bottom = frame.address(1, 3);
        let above = frame.neighbour(bottom, 0, -1, 16, 16).expect("available");
        assert_eq!(above.address, at);
        assert_eq!(above.y, 15);
    }

    #[test]
    fn a_frame_macroblock_reads_a_field_pair_every_other_line() {
        let mut frame = Frame::new(4, 4, true);
        // The pair to the left is field coded, the current one is not.
        frame.set_field_pair(frame.address(0, 0), true);
        let at = frame.address(1, 0);
        // Even lines come from the top field macroblock, odd from the bottom,
        // and both at half the row.
        let even = frame.neighbour(at, -1, 4, 16, 16).expect("available");
        assert_eq!((even.address, even.y), (frame.address(0, 0), 2));
        let odd = frame.neighbour(at, -1, 5, 16, 16).expect("available");
        assert_eq!((odd.address, odd.y), (frame.address(0, 1), 2));
    }

    #[test]
    fn a_field_macroblock_reads_a_frame_pair_at_twice_the_row() {
        let mut frame = Frame::new(4, 4, true);
        // The current pair is field coded and the one to its left is not.
        frame.set_field_pair(frame.address(1, 0), true);
        let top = frame.address(1, 0);
        let near = frame.neighbour(top, -1, 3, 16, 16).expect("available");
        assert_eq!((near.address, near.y), (frame.address(0, 0), 6));
        let far = frame.neighbour(top, -1, 12, 16, 16).expect("available");
        assert_eq!((far.address, far.y), (frame.address(0, 1), 8));
        // The bottom field macroblock takes the odd lines of the same pair.
        let bottom = frame.address(1, 1);
        let near = frame.neighbour(bottom, -1, 3, 16, 16).expect("available");
        assert_eq!((near.address, near.y), (frame.address(0, 0), 7));
    }

    #[test]
    fn above_right_is_not_there_for_the_bottom_of_a_frame_pair() {
        let frame = frame_coded(4, 4);
        let bottom = frame.address(1, 3);
        assert_eq!(frame.neighbour(bottom, 16, -1, 16, 16), None);
    }

    #[test]
    fn the_edges_of_the_picture_have_no_neighbours() {
        let frame = frame_coded(4, 4);
        let at = frame.address(0, 0);
        assert_eq!(frame.neighbour(at, -1, 0, 16, 16), None, "nothing left");
        assert_eq!(frame.neighbour(at, 0, -1, 16, 16), None, "nothing above");
    }

    #[test]
    fn chroma_locations_use_their_own_macroblock_size() {
        let frame = frame_coded(4, 4);
        let at = frame.address(1, 2);
        let above = frame.neighbour(at, 0, -1, 8, 8).expect("available");
        assert_eq!((above.address, above.y), (frame.address(1, 1), 7));
    }
}

#[cfg(test)]
mod uniform_tests {
    use super::*;

    /// What the neighbour of a location is when every pair is frame coded:
    /// plain spatial arithmetic, since a frame pair stacks its two macroblocks
    /// exactly where a non-adaptive picture would put them.
    fn spatial(
        mb_width: usize,
        mb_height: usize,
        mb_x: usize,
        mb_y: usize,
        x: i32,
        y: i32,
    ) -> Option<(usize, usize, usize)> {
        let column = mb_x as i32 + x.div_euclid(16);
        let row = mb_y as i32 + y.div_euclid(16);
        if column < 0 || row < 0 || column >= mb_width as i32 || row >= mb_height as i32 {
            return None;
        }
        // Decoding order: the macroblock has to come before the current one.
        let order = |c: i32, r: i32| (r as usize / 2 * mb_width + c as usize) * 2 + r as usize % 2;
        if order(column, row) >= order(mb_x as i32, mb_y as i32) {
            return None;
        }
        Some((
            order(column, row),
            x.rem_euclid(16) as usize,
            y.rem_euclid(16) as usize,
        ))
    }

    #[test]
    fn every_neighbour_of_a_frame_pair_is_where_the_spatial_answer_is() {
        let mb_width = 5;
        let mb_height = 6;
        let frame = Frame::new(mb_width, mb_height, true);
        for mb_y in 0..mb_height {
            for mb_x in 0..mb_width {
                let at = frame.address(mb_x, mb_y);
                for (x, y) in [
                    (-1, 0),
                    (-1, 8),
                    (0, -1),
                    (16, -1),
                    (-1, -1),
                    (16, 7),
                    (-1, 15),
                ] {
                    assert_eq!(
                        frame
                            .neighbour(at, x, y, 16, 16)
                            .map(|n| (n.address, n.x, n.y)),
                        spatial(mb_width, mb_height, mb_x, mb_y, x, y),
                        "at ({mb_x}, {mb_y}) offset ({x}, {y})"
                    );
                }
            }
        }
    }
}
