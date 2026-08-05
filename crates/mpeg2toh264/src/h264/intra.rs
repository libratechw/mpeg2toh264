//! H.264 intra prediction, for the one picture that needs it.
//!
//! The random access point cannot use the weighted-prediction trick the rest of
//! the stream leans on -- an IDR carries I slices, which have no reference lists
//! to hang weights on -- so it is coded with real intra prediction. Only DC mode
//! is used, for luma and chroma alike: it makes the prediction a single constant
//! over each block, which is what lets the residual stay in the coefficient
//! domain and go out through the same path as every other intra macroblock.
//!
//! Prediction reads back reconstructed samples, so it has to agree with
//! [`crate::h264::reconstruct`] about what those samples are, and with the
//! decoder about which of them exist yet. Clauses 8.3.2.2 and 8.3.4.

/// The picture as the decoder will hold it, filled in as macroblocks are coded.
pub struct ReconstructedPicture {
    pub width: usize,
    pub height: usize,
    pub luma: Vec<u8>,
    /// Chroma planes at half resolution in both axes; 4:2:0 only.
    pub cb: Vec<u8>,
    pub cr: Vec<u8>,
}

impl ReconstructedPicture {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            luma: vec![0; width * height],
            cb: vec![0; width * height / 4],
            cr: vec![0; width * height / 4],
        }
    }

    pub fn chroma_width(&self) -> usize {
        self.width / 2
    }

    /// Start a fresh coded picture. A field pair is two of them.
    pub fn clear(&mut self) {
        self.luma.fill(0);
        self.cb.fill(0);
        self.cr.fill(0);
    }
}

/// Where each macroblock falls in coding order, which is what decides whether a
/// neighbour has been reconstructed yet.
///
/// This is not the same as being above or to the left. An MBAFF frame codes
/// macroblocks in pairs, top then bottom, so for the bottom macroblock of a
/// pair the macroblock above and to the right belongs to the *next* pair and
/// has not been coded -- the standard marks it unavailable, and so does this.
#[derive(Clone, Copy)]
pub struct CodingOrder {
    pub mb_width: usize,
    pub mb_height: usize,
    pub mbaff: bool,
}

impl CodingOrder {
    pub fn index(&self, mb_x: usize, mb_y: usize) -> usize {
        if self.mbaff {
            ((mb_y / 2) * self.mb_width + mb_x) * 2 + mb_y % 2
        } else {
            mb_y * self.mb_width + mb_x
        }
    }

    /// Whether the sample at `(x, y)` has been reconstructed by the time the
    /// 8x8 block `blk` of macroblock `(mb_x, mb_y)` is predicted. Samples of
    /// the macroblock itself count only when their block was coded first.
    fn luma_available(&self, x: isize, y: isize, mb_x: usize, mb_y: usize, blk: usize) -> bool {
        if x < 0 || y < 0 {
            return false;
        }
        let (sx, sy) = (x as usize, y as usize);
        if sx >= self.mb_width * 16 || sy >= self.mb_height * 16 {
            return false;
        }
        let (nx, ny) = (sx / 16, sy / 16);
        let here = self.index(mb_x, mb_y);
        match self.index(nx, ny).cmp(&here) {
            std::cmp::Ordering::Less => true,
            std::cmp::Ordering::Greater => false,
            std::cmp::Ordering::Equal => ((sy % 16) / 8) * 2 + (sx % 16) / 8 < blk,
        }
    }

    /// Whether a whole neighbouring macroblock has been coded. Chroma
    /// prediction never reads back the macroblock it belongs to, so macroblock
    /// granularity is all it needs.
    fn macroblock_available(&self, mb_x: isize, mb_y: isize, from_x: usize, from_y: usize) -> bool {
        if mb_x < 0 || mb_y < 0 {
            return false;
        }
        let (nx, ny) = (mb_x as usize, mb_y as usize);
        nx < self.mb_width && ny < self.mb_height && self.index(nx, ny) < self.index(from_x, from_y)
    }
}

/// The reference samples of one 8x8 luma block, after clause 8.3.2.2.1's filter.
struct Neighbourhood {
    /// p'[x, -1] for x = 0..7.
    top: [i32; 8],
    /// p'[-1, y] for y = 0..7.
    left: [i32; 8],
    top_available: bool,
    left_available: bool,
}

fn gather(
    picture: &ReconstructedPicture,
    order: &CodingOrder,
    mb_x: usize,
    mb_y: usize,
    blk: usize,
) -> Neighbourhood {
    let x0 = (mb_x * 16 + (blk & 1) * 8) as isize;
    let y0 = (mb_y * 16 + (blk >> 1) * 8) as isize;
    let at = |x: isize, y: isize| picture.luma[y as usize * picture.width + x as usize] as i32;
    let available = |x: isize, y: isize| order.luma_available(x, y, mb_x, mb_y, blk);

    // p[x, -1] for x = 0..15, the second half of which is the above-right
    // block. The standard substitutes p[7, -1] for it when it does not exist,
    // which matters here only through the filter: DC reads x = 0..7, but
    // filtering p[7, -1] reaches one sample further.
    let top_available = (0..8).all(|x| available(x0 + x, y0 - 1));
    let mut raw_top = [0i32; 17];
    if top_available {
        for x in 0..8 {
            raw_top[x + 1] = at(x0 + x as isize, y0 - 1);
        }
        let above_right = (8..16).all(|x| available(x0 + x, y0 - 1));
        for x in 8..16 {
            raw_top[x + 1] = if above_right {
                at(x0 + x as isize, y0 - 1)
            } else {
                raw_top[8]
            };
        }
    }
    let left_available = (0..8).all(|y| available(x0 - 1, y0 + y));
    let mut raw_left = [0i32; 8];
    if left_available {
        for y in 0..8 {
            raw_left[y] = at(x0 - 1, y0 + y as isize);
        }
    }
    let corner_available = available(x0 - 1, y0 - 1);
    let corner = if corner_available {
        at(x0 - 1, y0 - 1)
    } else {
        0
    };
    // raw_top[0] is p[-1, -1], which the filter of p[0, -1] reads.
    raw_top[0] = corner;

    let mut top = [0i32; 8];
    if top_available {
        top[0] = if corner_available {
            (raw_top[0] + 2 * raw_top[1] + raw_top[2] + 2) >> 2
        } else {
            (3 * raw_top[1] + raw_top[2] + 2) >> 2
        };
        for x in 1..8 {
            top[x] = (raw_top[x] + 2 * raw_top[x + 1] + raw_top[x + 2] + 2) >> 2;
        }
    }
    let mut left = [0i32; 8];
    if left_available {
        left[0] = if corner_available {
            (corner + 2 * raw_left[0] + raw_left[1] + 2) >> 2
        } else {
            (3 * raw_left[0] + raw_left[1] + 2) >> 2
        };
        for y in 1..7 {
            left[y] = (raw_left[y - 1] + 2 * raw_left[y] + raw_left[y + 1] + 2) >> 2;
        }
        left[7] = (raw_left[6] + 3 * raw_left[7] + 2) >> 2;
    }
    Neighbourhood {
        top,
        left,
        top_available,
        left_available,
    }
}

/// Clause 8.3.2.2.4: the constant an Intra_8x8 DC block predicts from.
pub fn luma_8x8_dc(
    picture: &ReconstructedPicture,
    order: &CodingOrder,
    mb_x: usize,
    mb_y: usize,
    blk: usize,
) -> i32 {
    let n = gather(picture, order, mb_x, mb_y, blk);
    let top: i32 = n.top.iter().sum();
    let left: i32 = n.left.iter().sum();
    match (n.top_available, n.left_available) {
        (true, true) => (top + left + 8) >> 4,
        (false, true) => (left + 4) >> 3,
        (true, false) => (top + 4) >> 3,
        (false, false) => 128,
    }
}

/// Clause 8.3.4.1: the constant each of a chroma component's four 4x4 blocks
/// predicts from, in DC mode.
///
/// Which neighbour a block prefers depends on where it sits: the two on the
/// diagonal average both edges, the top-right block takes the edge above and
/// the bottom-left one the edge beside, each falling back to the other.
pub fn chroma_dc(
    plane: &[u8],
    stride: usize,
    order: &CodingOrder,
    mb_x: usize,
    mb_y: usize,
) -> [i32; 4] {
    let x0 = mb_x * 8;
    let y0 = mb_y * 8;
    let above = order.macroblock_available(mb_x as isize, mb_y as isize - 1, mb_x, mb_y);
    let beside = order.macroblock_available(mb_x as isize - 1, mb_y as isize, mb_x, mb_y);
    let top = |x: usize| plane[(y0 - 1) * stride + x0 + x] as i32;
    let left = |y: usize| plane[(y0 + y) * stride + x0 - 1] as i32;

    let mut out = [128i32; 4];
    for blk in 0..4 {
        let (bx, by) = ((blk & 1) * 4, (blk >> 1) * 4);
        let top_sum: i32 = if above {
            (0..4).map(|i| top(bx + i)).sum()
        } else {
            0
        };
        let left_sum: i32 = if beside {
            (0..4).map(|i| left(by + i)).sum()
        } else {
            0
        };
        // Blocks 0 and 3 sit on the diagonal and average both edges; of the
        // other two, block 2 is the one that would rather have the edge beside
        // it than the one above.
        let diagonal = blk == 0 || blk == 3;
        let above_only = (top_sum + 2) >> 2;
        let beside_only = (left_sum + 2) >> 2;
        out[blk] = match (above, beside) {
            (true, true) if diagonal => (top_sum + left_sum + 4) >> 3,
            (true, true) if blk == 2 => beside_only,
            (true, true) => above_only,
            (true, false) => above_only,
            (false, true) => beside_only,
            (false, false) => 128,
        };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(mb_width: usize, mb_height: usize, mbaff: bool) -> CodingOrder {
        CodingOrder {
            mb_width,
            mb_height,
            mbaff,
        }
    }

    #[test]
    fn the_first_block_of_a_picture_predicts_from_nothing() {
        let picture = ReconstructedPicture::new(64, 64);
        let order = order(4, 4, false);
        assert_eq!(luma_8x8_dc(&picture, &order, 0, 0, 0), 128);
        assert_eq!(chroma_dc(&picture.cb, 32, &order, 0, 0), [128; 4]);
    }

    #[test]
    fn a_flat_neighbourhood_predicts_that_value() {
        let mut picture = ReconstructedPicture::new(64, 64);
        picture.luma.fill(70);
        picture.cb.fill(70);
        let order = order(4, 4, false);
        // A macroblock with both neighbours coded, every block of it.
        for blk in 0..4 {
            assert_eq!(luma_8x8_dc(&picture, &order, 1, 1, blk), 70, "block {blk}");
        }
        assert_eq!(chroma_dc(&picture.cb, 32, &order, 1, 1), [70; 4]);
    }

    /// The filter is a [1 2 1] over the reference edge, so a ramp predicts the
    /// mean of the ramp rather than of its filtered ends.
    #[test]
    fn a_ramp_above_averages_to_its_middle() {
        let mut picture = ReconstructedPicture::new(64, 64);
        for x in 0..64 {
            picture.luma[15 * 64 + x] = (x % 16) as u8 * 4;
        }
        let order = order(4, 4, false);
        // Macroblock (0, 1) has the row above but nothing to its left.
        let dc = luma_8x8_dc(&picture, &order, 0, 1, 0);
        assert!((dc - 14).abs() <= 2, "dc {dc}");
    }

    /// The macroblock above and to the right of a bottom macroblock belongs to
    /// the next pair, which is not coded yet.
    #[test]
    fn mbaff_hides_the_above_right_of_a_bottom_macroblock() {
        let order = order(4, 4, true);
        // Top macroblock of pair (1, 0): its above-right is the bottom
        // macroblock of pair (2, ...) -- above the picture here, so use row 2.
        let top = order.index(1, 2);
        let bottom = order.index(1, 3);
        assert!(order.index(2, 1) < top, "above-right of a top macroblock");
        assert!(order.index(2, 2) > bottom, "above-right of a bottom one");
    }

    #[test]
    fn coding_order_visits_every_macroblock_once() {
        for mbaff in [false, true] {
            let order = order(5, 4, mbaff);
            let mut seen: Vec<usize> = (0..4)
                .flat_map(|y| (0..5).map(move |x| (x, y)))
                .map(|(x, y)| order.index(x, y))
                .collect();
            seen.sort_unstable();
            assert_eq!(seen, (0..20).collect::<Vec<_>>(), "mbaff {mbaff}");
        }
    }
}
