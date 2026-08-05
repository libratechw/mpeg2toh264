import { describe, expect, it } from "vitest";
import {
  writePps,
  writeSps,
  ZIGZAG_4X4,
  ZIGZAG_8X8,
  frameGeometry,
} from "../src/h264/params.ts";
import {
  DEFAULT_INTRA_QUANT,
  DEFAULT_NON_INTRA_QUANT,
} from "../src/mpeg2/constants.ts";

/** Strip the Annex B start code, NAL header and emulation prevention bytes. */
function rbspOf(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 5; i < nal.length; i++) {
    const b = nal[i]!;
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out.push(b);
    zeros = b === 0x00 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/** Minimal RBSP reader, written against the spec rather than reusing the writer. */
class Reader {
  private pos = 0;
  constructor(private readonly d: Uint8Array) {}
  u1(): number {
    const b = (this.d[this.pos >> 3]! >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.u1();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.u1() === 0) zeros++;
    return (1 << zeros) - 1 + (zeros === 0 ? 0 : this.u(zeros));
  }
  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }
}

/** Reconstruct a scaling list exactly as clause 7.3.2.1.1.1 specifies. */
function readScalingList(r: Reader, size: 16 | 64 = 64): number[] {
  const list = new Array<number>(size).fill(0);
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      nextScale = (lastScale + r.se() + 256) % 256;
    }
    list[j] = nextScale === 0 ? lastScale : nextScale;
    lastScale = list[j]!;
  }
  // Transmitted in zig-zag order; return raster.
  const scan = size === 16 ? ZIGZAG_4X4 : ZIGZAG_8X8;
  const raster = new Array<number>(size).fill(0);
  for (let j = 0; j < size; j++) raster[scan[j]!] = list[j]!;
  return raster;
}

/** Read back the two 8x8 luma scaling lists from a PPS. */
function ppsScalingLists(pps: Uint8Array): {
  intra: number[];
  inter: number[];
} {
  const r = new Reader(rbspOf(pps));
  r.ue(); // pic_parameter_set_id
  r.ue(); // seq_parameter_set_id
  r.u1(); // entropy_coding_mode_flag
  r.u1(); // bottom_field_pic_order_in_frame_present_flag
  r.ue(); // num_slice_groups_minus1
  r.ue(); // num_ref_idx_l0_default_active_minus1
  r.ue(); // num_ref_idx_l1_default_active_minus1
  r.u1(); // weighted_pred_flag
  r.u(2); // weighted_bipred_idc
  r.se(); // pic_init_qp_minus26
  r.se(); // pic_init_qs_minus26
  r.se(); // chroma_qp_index_offset
  r.u1(); // deblocking_filter_control_present_flag
  r.u1(); // constrained_intra_pred_flag
  r.u1(); // redundant_pic_cnt_present_flag
  const transform8x8 = r.u1();
  expect(transform8x8).toBe(1);
  expect(r.u1()).toBe(1); // pic_scaling_matrix_present_flag
  // The six 4x4 lists must be sent explicitly. Omitting them does not leave
  // chroma unweighted: fall-back rule set A substitutes H.264's default 4x4
  // matrices, which are far from flat.
  const flat = new Array(16).fill(16);
  for (let i = 0; i < 6; i++) {
    expect(r.u1(), `pic_scaling_list_present_flag[${i}]`).toBe(1);
    expect(readScalingList(r, 16), `4x4 list ${i}`).toEqual(flat);
  }
  expect(r.u1()).toBe(1);
  const intra = readScalingList(r);
  expect(r.u1()).toBe(1);
  const inter = readScalingList(r);
  return { intra, inter };
}

describe("PPS scaling lists carry the MPEG-2 quantiser matrices", () => {
  it("round-trips the default intra matrix and a flat inter matrix", () => {
    const pps = writePps({
      initQp: 26,
      scaling8x8Intra: DEFAULT_INTRA_QUANT,
      scaling8x8Inter: DEFAULT_NON_INTRA_QUANT,
    });
    const { intra, inter } = ppsScalingLists(pps);
    expect(intra).toEqual([...DEFAULT_INTRA_QUANT]);
    expect(inter).toEqual([...DEFAULT_NON_INTRA_QUANT]);
  });

  it("round-trips the custom inter matrix a real broadcaster sends", () => {
    // Taken from a terrestrial recording: the intra matrix is left at the
    // default but the non-intra matrix is customised. This is the case the
    // whole design rests on, so it is pinned here.
    const broadcast = [
      16, 16, 16, 17, 20, 20, 22, 25, 16, 16, 17, 18, 20, 22, 25, 27, 16, 17,
      20, 20, 22, 25, 25, 27, 17, 17, 20, 20, 22, 25, 27, 28, 17, 20, 20, 22,
      23, 25, 28, 33, 20, 20, 22, 23, 25, 28, 33, 40, 20, 20, 22, 25, 27, 32,
      38, 47, 20, 22, 25, 27, 32, 38, 47, 55,
    ];
    const pps = writePps({
      initQp: 26,
      scaling8x8Intra: DEFAULT_INTRA_QUANT,
      scaling8x8Inter: broadcast,
    });
    expect(ppsScalingLists(pps).inter).toEqual(broadcast);
  });

  it("round-trips matrices at the extremes of the valid range", () => {
    const edge = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 1 : 255));
    const pps = writePps({
      initQp: 26,
      scaling8x8Intra: edge,
      scaling8x8Inter: edge,
    });
    const { intra, inter } = ppsScalingLists(pps);
    expect(intra).toEqual(edge);
    expect(inter).toEqual(edge);
  });

  it("rejects a scaling weight outside 1..255", () => {
    const bad = [...DEFAULT_NON_INTRA_QUANT];
    bad[7] = 0;
    expect(() =>
      writePps({ initQp: 26, scaling8x8Intra: null, scaling8x8Inter: bad }),
    ).toThrow(/out of range/);
  });
});

describe("SPS geometry", () => {
  it("derives macroblock counts and cropping for 1440x1080 interlaced", () => {
    const g = frameGeometry(1440, 1080, false);
    expect(g.mbWidth).toBe(90);
    expect(g.mbHeight).toBe(68); // 1088 coded lines
    expect(g.mapUnits).toBe(34); // macroblock pairs under MBAFF
    // 1088 - 1080 = 8 lines, cropped in units of 4.
    expect(g.cropBottom).toBe(2);
    expect(g.cropRight).toBe(0);
  });

  it("needs no cropping for a progressive size that tiles exactly", () => {
    const g = frameGeometry(352, 288, true);
    expect(g.mbWidth).toBe(22);
    expect(g.mbHeight).toBe(18);
    expect(g.mapUnits).toBe(18);
    expect(g.cropBottom).toBe(0);
  });

  it("emits a parsable SPS", () => {
    const sps = writeSps({
      width: 1440,
      height: 1080,
      levelIdc: 40,
      frameMbsOnly: false,
      maxNumRefFrames: 4,
      log2MaxFrameNumMinus4: 4,
      log2MaxPocLsbMinus4: 4,
    });
    expect([...sps.slice(0, 5)]).toEqual([0x00, 0x00, 0x00, 0x01, 0x67]);
    const r = new Reader(rbspOf(sps));
    expect(r.u(8)).toBe(100); // profile_idc High
    r.u(8); // constraint flags and reserved bits
    expect(r.u(8)).toBe(40); // level_idc
    expect(r.ue()).toBe(0); // seq_parameter_set_id
    expect(r.ue()).toBe(1); // chroma_format_idc 4:2:0
  });
});
