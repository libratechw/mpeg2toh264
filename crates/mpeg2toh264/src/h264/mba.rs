//! Mixed MBAFF neighbour locations from H.264 clauses 6.4.10 and 6.4.12.2.

/// The frame/field mode of each macroblock pair in an MBAFF picture.
#[derive(Clone, Debug)]
pub(crate) struct MbaffModes {
    pub(crate) mb_width: usize,
    pub(crate) pair_height: usize,
    /// `true` means a frame macroblock pair; `false` means a field pair.
    pub(crate) frame: Vec<bool>,
}

impl MbaffModes {
    pub(crate) fn new(mb_width: usize, pair_height: usize, frame: Vec<bool>) -> Self {
        assert_eq!(frame.len(), mb_width * pair_height);
        Self {
            mb_width,
            pair_height,
            frame,
        }
    }

    fn pair_frame(&self, pair_x: isize, pair_y: isize) -> Option<bool> {
        if pair_x < 0
            || pair_y < 0
            || pair_x >= self.mb_width as isize
            || pair_y >= self.pair_height as isize
        {
            return None;
        }
        Some(self.frame[pair_y as usize * self.mb_width + pair_x as usize])
    }

    /// Derive a neighbouring macroblock and its local sample location.
    ///
    /// `x_n` and `y_n` are relative to the current macroblock's upper-left
    /// sample, and are normally one of the A/B/C/D locations from clause
    /// 6.4.11. The returned `(x_w, y_w)` is the location in the neighbour.
    pub(crate) fn neighbour(
        &self,
        curr_x: usize,
        curr_y: usize,
        x_n: i32,
        y_n: i32,
    ) -> Option<(usize, usize, usize, usize)> {
        self.neighbour_with_size(curr_x, curr_y, x_n, y_n, 16, 16)
    }

    pub(crate) fn neighbour_with_size(
        &self,
        curr_x: usize,
        curr_y: usize,
        x_n: i32,
        y_n: i32,
        max_w: i32,
        max_h: i32,
    ) -> Option<(usize, usize, usize, usize)> {
        let pair_x = curr_x as isize;
        let pair_y = (curr_y / 2) as isize;
        let curr_frame = self.pair_frame(pair_x, pair_y)?;
        let curr_top = curr_y.is_multiple_of(2);

        let (addr_pair_x, addr_pair_y, kind) = match (x_n < 0, x_n >= max_w, y_n < 0, y_n >= max_h)
        {
            (true, false, true, false) => (
                pair_x - 1,
                if curr_frame && !curr_top {
                    pair_y
                } else {
                    pair_y - 1
                },
                Kind::D,
            ),
            (true, false, false, false) => (pair_x - 1, pair_y, Kind::A),
            (false, true, true, false) => (pair_x + 1, pair_y - 1, Kind::C),
            (false, false, true, false) => (
                pair_x,
                if curr_frame && !curr_top {
                    pair_y
                } else {
                    pair_y - 1
                },
                Kind::B,
            ),
            (false, false, false, true) | (false, true, false, false) => return None,
            (false, false, false, false) => (pair_x, pair_y, Kind::Current),
            _ => return None,
        };
        // For the lower macroblock of a frame-coded pair, B is the upper
        // macroblock of the same pair.  Its pair address is not `pair_y - 1`;
        // Table 6-4 handles it directly below, so do not reject it as an
        // out-of-picture pair before that case is selected.
        let candidate_frame = if matches!(kind, Kind::B) && curr_frame && !curr_top {
            true
        } else {
            self.pair_frame(addr_pair_x, addr_pair_y)?
        };
        let candidate_top_addr_y = addr_pair_y as usize * 2;
        let curr_addr_y = curr_y;

        // The table uses mbAddrX as the top macroblock address of the
        // candidate pair. These helpers return the actual raster row of the
        // selected top or bottom macroblock.
        let select = |bottom: bool| candidate_top_addr_y + usize::from(bottom);
        let (target_y, y_m) = match kind {
            Kind::Current => (curr_addr_y, y_n),
            Kind::A => {
                if curr_frame {
                    if curr_top {
                        if candidate_frame {
                            (select(false), y_n)
                        } else if y_n % 2 == 0 {
                            (select(false), y_n >> 1)
                        } else {
                            (select(true), y_n >> 1)
                        }
                    } else if candidate_frame {
                        (select(true), y_n)
                    } else if y_n % 2 == 0 {
                        (select(false), (y_n + max_h) >> 1)
                    } else {
                        (select(true), (y_n + max_h) >> 1)
                    }
                } else if curr_top {
                    if candidate_frame {
                        if y_n < max_h / 2 {
                            (select(false), y_n << 1)
                        } else {
                            (select(true), (y_n << 1) - max_h)
                        }
                    } else {
                        (select(false), y_n)
                    }
                } else if candidate_frame {
                    if y_n < max_h / 2 {
                        (select(false), (y_n << 1) + 1)
                    } else {
                        (select(true), (y_n << 1) + 1 - max_h)
                    }
                } else {
                    (select(true), y_n)
                }
            }
            Kind::B => {
                if curr_frame {
                    if curr_top {
                        (select(true), y_n)
                    } else {
                        (curr_addr_y - 1, y_n)
                    }
                } else if curr_top {
                    if candidate_frame {
                        (select(true), y_n << 1)
                    } else {
                        (select(false), y_n)
                    }
                } else {
                    (select(true), y_n)
                }
            }
            Kind::C => {
                if curr_frame {
                    if curr_top {
                        (select(true), y_n)
                    } else {
                        return None;
                    }
                } else if curr_top {
                    if candidate_frame {
                        (select(true), y_n << 1)
                    } else {
                        (select(false), y_n)
                    }
                } else {
                    (select(true), y_n)
                }
            }
            Kind::D => {
                if curr_frame {
                    if curr_top {
                        (select(true), y_n)
                    } else if candidate_frame {
                        (select(false), y_n)
                    } else {
                        (select(true), (y_n + max_h) >> 1)
                    }
                } else if !curr_top {
                    (select(true), y_n)
                } else if candidate_frame {
                    (select(true), y_n << 1)
                } else {
                    (select(false), y_n)
                }
            }
        };

        let x_w = (x_n + max_w).rem_euclid(max_w) as usize;
        let y_w = (y_m + max_h).rem_euclid(max_h) as usize;
        Some((addr_pair_x as usize, target_y, x_w, y_w))
    }
}

#[derive(Clone, Copy)]
enum Kind {
    A,
    B,
    C,
    D,
    Current,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bottom_frame_mb_uses_its_own_pair_above_even_in_first_row() {
        for size in [8, 16] {
            let modes = MbaffModes::new(1, 1, vec![true]);
            assert_eq!(
                modes.neighbour_with_size(0, 1, 0, -1, size, size),
                Some((0, 0, 0, size as usize - 1))
            );
        }
    }

    #[test]
    fn bottom_frame_above_left_uses_left_pair_in_same_row() {
        for size in [8, 16] {
            for left_frame in [true, false] {
                let modes = MbaffModes::new(2, 1, vec![left_frame, true]);
                let expected_y = if left_frame { size - 1 } else { size / 2 - 1 };
                assert_eq!(
                    modes.neighbour_with_size(1, 1, -1, -1, size, size),
                    Some((
                        0,
                        usize::from(!left_frame),
                        size as usize - 1,
                        expected_y as usize
                    ))
                );
            }
        }
    }

    #[test]
    fn bottom_field_above_left_keeps_bottom_parity_for_either_mode() {
        for above_frame in [true, false] {
            let modes = MbaffModes::new(2, 2, vec![above_frame, true, false, false]);
            assert_eq!(modes.neighbour(1, 3, -1, -1), Some((0, 1, 15, 15)));
        }
    }

    #[test]
    fn right_and_below_locations_are_unavailable() {
        let modes = MbaffModes::new(2, 2, vec![true; 4]);
        assert_eq!(modes.neighbour(0, 0, 16, 0), None);
        assert_eq!(modes.neighbour(0, 0, 0, 16), None);
        assert_eq!(modes.neighbour(0, 1, 16, -1), None);
    }

    #[test]
    fn mixed_left_frame_to_field_selects_the_field_half() {
        let modes = MbaffModes::new(2, 2, vec![false, true, true, true]);
        // Current frame pair, top macroblock, left field pair. y=8 maps to
        // the top field macroblock with yM=4 (Table 6-4).
        assert_eq!(modes.neighbour(1, 0, -1, 8), Some((0, 0, 15, 4)));
    }

    #[test]
    fn mixed_above_field_to_frame_scales_the_field_location() {
        let modes = MbaffModes::new(1, 2, vec![true, false]);
        // Current top field pair, above frame pair. yN=-1 selects the lower
        // macroblock of the frame pair and yM=-2 (then yW=14).
        assert_eq!(modes.neighbour(0, 2, 0, -1), Some((0, 1, 0, 14)));
    }
}
