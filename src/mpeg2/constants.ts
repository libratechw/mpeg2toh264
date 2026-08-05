/** ITU-T H.262 (MPEG-2 Video) constant tables. */

/** Start code values (the byte following the `00 00 01` prefix). */
export const SC = {
  PICTURE: 0x00,
  /** 0x01..0xAF are slice_start_code, the low byte being slice_vertical_position. */
  SLICE_MIN: 0x01,
  SLICE_MAX: 0xaf,
  USER_DATA: 0xb2,
  SEQUENCE_HEADER: 0xb3,
  SEQUENCE_ERROR: 0xb4,
  EXTENSION: 0xb5,
  SEQUENCE_END: 0xb7,
  GROUP: 0xb8,
} as const;

/** extension_start_code_identifier values (Table 6-2). */
export const EXT = {
  SEQUENCE: 0x1,
  SEQUENCE_DISPLAY: 0x2,
  QUANT_MATRIX: 0x3,
  COPYRIGHT: 0x4,
  SEQUENCE_SCALABLE: 0x5,
  PICTURE_DISPLAY: 0x7,
  PICTURE_CODING: 0x8,
  PICTURE_SPATIAL_SCALABLE: 0x9,
  PICTURE_TEMPORAL_SCALABLE: 0xa,
} as const;

export const PictureType = {
  I: 1,
  P: 2,
  B: 3,
  D: 4,
} as const;
export type PictureTypeValue = (typeof PictureType)[keyof typeof PictureType];

export const PictureStructure = {
  TOP_FIELD: 1,
  BOTTOM_FIELD: 2,
  FRAME: 3,
} as const;

export const ChromaFormat = {
  C420: 1,
  C422: 2,
  C444: 3,
} as const;

/**
 * Zig-zag scan, scan[i] -> raster index (Figure 7-2, alternate_scan = 0).
 * Used to place run-length decoded coefficients into an 8x8 block.
 */
export const ZIGZAG_SCAN: readonly number[] = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];

/**
 * Alternate scan, scan[i] -> raster index (Figure 7-3, alternate_scan = 1).
 * Signalled per picture; favours vertical frequencies for interlaced content.
 */
export const ALTERNATE_SCAN: readonly number[] = [
  0, 8, 16, 24, 1, 9, 2, 10, 17, 25, 32, 40, 48, 56, 57, 49, 41, 33, 26, 18, 3,
  11, 4, 12, 19, 27, 34, 42, 50, 58, 35, 43, 51, 59, 20, 28, 5, 13, 6, 14, 21,
  29, 36, 44, 52, 60, 37, 45, 53, 61, 22, 30, 7, 15, 23, 31, 38, 46, 54, 62, 39,
  47, 55, 63,
];

/** Default intra quantiser matrix in raster order (Table 7-3). */
export const DEFAULT_INTRA_QUANT: readonly number[] = [
  8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27,
  29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40,
  48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29,
  35, 38, 46, 56, 69, 83,
];

/** Default non-intra quantiser matrix: flat 16 (clause 7.4.2.3). */
export const DEFAULT_NON_INTRA_QUANT: readonly number[] = new Array(64).fill(
  16,
);

/**
 * quantiser_scale as a function of quantiser_scale_code (Table 7-6).
 * Index 0 is q_scale_type = 0 (linear, qs = 2 * code), index 1 is the
 * non-linear table. Entry [t][0] is unused: code 0 is forbidden.
 *
 * The linear table is what makes the H.264 mapping clean: doubling
 * quantiser_scale is exactly +6 in H.264 QP, so codes that are powers of two
 * map to a level rescale ratio of exactly 1.0.
 */
export const QUANTISER_SCALE: readonly (readonly number[])[] = [
  // q_scale_type = 0
  [
    0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38,
    40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62,
  ],
  // q_scale_type = 1
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40,
    44, 48, 52, 56, 64, 72, 80, 88, 96, 104, 112,
  ],
];

/** frame_rate_value = FRAME_RATE[code] as [numerator, denominator] (Table 6-4). */
export const FRAME_RATE: readonly (readonly [number, number])[] = [
  [0, 0],
  [24000, 1001],
  [24, 1],
  [25, 1],
  [30000, 1001],
  [30, 1],
  [50, 1],
  [60000, 1001],
  [60, 1],
];

/** Macroblock type flags, decoded from the macroblock_type VLC (Tables B-2..B-4). */
export const MBFlag = {
  QUANT: 1 << 0,
  MOTION_FORWARD: 1 << 1,
  MOTION_BACKWARD: 1 << 2,
  PATTERN: 1 << 3,
  INTRA: 1 << 4,
} as const;
