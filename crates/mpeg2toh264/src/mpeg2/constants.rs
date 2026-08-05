//! ITU-T H.262 (MPEG-2 Video) constant tables.

/// Start code values (the byte following the `00 00 01` prefix).
pub mod start_code {
    pub const PICTURE: u8 = 0x00;
    /// 0x01..0xAF are slice_start_code, the low byte being slice_vertical_position.
    pub const SLICE_MIN: u8 = 0x01;
    pub const SLICE_MAX: u8 = 0xaf;
    pub const USER_DATA: u8 = 0xb2;
    pub const SEQUENCE_HEADER: u8 = 0xb3;
    pub const SEQUENCE_ERROR: u8 = 0xb4;
    pub const EXTENSION: u8 = 0xb5;
    pub const SEQUENCE_END: u8 = 0xb7;
    pub const GROUP: u8 = 0xb8;
}

/// `extension_start_code_identifier` values (Table 6-2).
pub mod extension {
    pub const SEQUENCE: u32 = 0x1;
    pub const SEQUENCE_DISPLAY: u32 = 0x2;
    pub const QUANT_MATRIX: u32 = 0x3;
    pub const COPYRIGHT: u32 = 0x4;
    pub const SEQUENCE_SCALABLE: u32 = 0x5;
    pub const PICTURE_DISPLAY: u32 = 0x7;
    pub const PICTURE_CODING: u32 = 0x8;
    pub const PICTURE_SPATIAL_SCALABLE: u32 = 0x9;
    pub const PICTURE_TEMPORAL_SCALABLE: u32 = 0xa;
}

/// `picture_coding_type` (Table 6-12). The values outside I/P/B/D are not
/// assigned, and pictures carrying them are skipped rather than rejected.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PictureType {
    I,
    P,
    B,
    D,
    Unassigned(u32),
}

impl PictureType {
    pub fn from_code(code: u32) -> Self {
        match code {
            1 => Self::I,
            2 => Self::P,
            3 => Self::B,
            4 => Self::D,
            other => Self::Unassigned(other),
        }
    }

    /// True for the picture types this transcoder converts.
    pub fn is_ipb(self) -> bool {
        matches!(self, Self::I | Self::P | Self::B)
    }
}

/// `picture_structure` (Table 6-14).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PictureStructure {
    TopField,
    BottomField,
    Frame,
    Reserved,
}

impl PictureStructure {
    pub fn from_code(code: u32) -> Self {
        match code {
            1 => Self::TopField,
            2 => Self::BottomField,
            3 => Self::Frame,
            _ => Self::Reserved,
        }
    }

    pub fn code(self) -> u32 {
        match self {
            Self::TopField => 1,
            Self::BottomField => 2,
            Self::Frame => 3,
            Self::Reserved => 0,
        }
    }
}

/// `chroma_format` (Table 6-5).
pub mod chroma_format {
    pub const C420: u32 = 1;
    pub const C422: u32 = 2;
    pub const C444: u32 = 3;
}

/// Zig-zag scan, `ZIGZAG_SCAN[i]` -> raster index (Figure 7-2, alternate_scan = 0).
/// Used to place run-length decoded coefficients into an 8x8 block.
pub static ZIGZAG_SCAN: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/// Alternate scan, `ALTERNATE_SCAN[i]` -> raster index (Figure 7-3, alternate_scan = 1).
/// Signalled per picture; favours vertical frequencies for interlaced content.
pub static ALTERNATE_SCAN: [usize; 64] = [
    0, 8, 16, 24, 1, 9, 2, 10, 17, 25, 32, 40, 48, 56, 57, 49, 41, 33, 26, 18, 3, 11, 4, 12, 19,
    27, 34, 42, 50, 58, 35, 43, 51, 59, 20, 28, 5, 13, 6, 14, 21, 29, 36, 44, 52, 60, 37, 45, 53,
    61, 22, 30, 7, 15, 23, 31, 38, 46, 54, 62, 39, 47, 55, 63,
];

/// Default intra quantiser matrix in raster order (Table 7-3).
pub static DEFAULT_INTRA_QUANT: [i32; 64] = [
    8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38,
    22, 22, 26, 27, 29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58,
    26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83,
];

/// Default non-intra quantiser matrix: flat 16 (clause 7.4.2.3).
pub static DEFAULT_NON_INTRA_QUANT: [i32; 64] = [16; 64];

/// `quantiser_scale` as a function of `quantiser_scale_code` (Table 7-6).
/// Index 0 is q_scale_type = 0 (linear, qs = 2 * code), index 1 is the
/// non-linear table. Entry `[t][0]` is unused: code 0 is forbidden.
///
/// The linear table is what makes the H.264 mapping clean: doubling
/// quantiser_scale is exactly +6 in H.264 QP, so codes that are powers of two
/// map to a level rescale ratio of exactly 1.0.
pub static QUANTISER_SCALE: [[i32; 32]; 2] = [
    // q_scale_type = 0
    [
        0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46,
        48, 50, 52, 54, 56, 58, 60, 62,
    ],
    // q_scale_type = 1
    [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56,
        64, 72, 80, 88, 96, 104, 112,
    ],
];

/// `frame_rate_value = FRAME_RATE[code]` as (numerator, denominator) (Table 6-4).
pub static FRAME_RATE: [(u32, u32); 9] = [
    (0, 0),
    (24000, 1001),
    (24, 1),
    (25, 1),
    (30000, 1001),
    (30, 1),
    (50, 1),
    (60000, 1001),
    (60, 1),
];

/// Macroblock type flags, decoded from the `macroblock_type` VLC (Tables B-2..B-4).
pub mod mb_flag {
    pub const QUANT: i32 = 1 << 0;
    pub const MOTION_FORWARD: i32 = 1 << 1;
    pub const MOTION_BACKWARD: i32 = 1 << 2;
    pub const PATTERN: i32 = 1 << 3;
    pub const INTRA: i32 = 1 << 4;
}
