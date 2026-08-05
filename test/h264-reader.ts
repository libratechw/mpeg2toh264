/**
 * Reading H.264 syntax back, written against the spec rather than reusing the
 * writer, so a test can disagree with src/h264 rather than echo it.
 */

/** Strip the Annex B start code, NAL header and emulation prevention bytes. */
export function rbspOf(nal: Uint8Array): Uint8Array {
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

/** Minimal RBSP reader. */
export class Reader {
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

/** Every Annex B NAL unit in a bitstream, start codes included. */
export function annexBNalUnits(bitstream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 < bitstream.length; i++) {
    if (
      bitstream[i] === 0 &&
      bitstream[i + 1] === 0 &&
      bitstream[i + 2] === 0 &&
      bitstream[i + 3] === 1
    ) {
      starts.push(i);
      i += 3;
    }
  }
  return starts.map((at, index) =>
    bitstream.subarray(at, starts[index + 1] ?? bitstream.length),
  );
}

/**
 * frame_mbs_only_flag, clause 7.3.2.1.1. Only the path this transcoder emits
 * is walked: High profile, no scaling matrix in the SPS, pic_order_cnt_type 0.
 */
export function frameMbsOnlyFlag(sps: Uint8Array): boolean {
  const r = new Reader(rbspOf(sps));
  const profileIdc = r.u(8);
  if (profileIdc !== 100)
    throw new Error(`expected High profile, got ${profileIdc}`);
  r.u(8); // constraint flags and reserved bits
  r.u(8); // level_idc
  r.ue(); // seq_parameter_set_id
  r.ue(); // chroma_format_idc, which is never 3 here
  r.ue(); // bit_depth_luma_minus8
  r.ue(); // bit_depth_chroma_minus8
  r.u1(); // qpprime_y_zero_transform_bypass_flag
  if (r.u1() !== 0) throw new Error("SPS scaling matrix is not handled here");
  r.ue(); // log2_max_frame_num_minus4
  if (r.ue() !== 0) throw new Error("expected pic_order_cnt_type 0");
  r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  r.ue(); // max_num_ref_frames
  r.u1(); // gaps_in_frame_num_value_allowed_flag
  r.ue(); // pic_width_in_mbs_minus1
  r.ue(); // pic_height_in_map_units_minus1
  return r.u1() === 1;
}
