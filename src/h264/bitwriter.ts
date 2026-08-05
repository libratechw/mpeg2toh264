/**
 * H.264 bitstream writing: RBSP construction, Exp-Golomb coding, and the
 * byte stream NAL unit wrapping from Annex B.
 */

/** Writes an RBSP (raw byte sequence payload) bit by bit. */
export class BitWriter {
  private buf: Uint8Array;
  private len = 0; // bytes fully or partially written
  private bitsInLast = 0; // bits used in buf[len - 1]

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private grow(needed: number): void {
    if (this.len + needed <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Total bits written so far. */
  get bitLength(): number {
    return this.len === 0 ? 0 : (this.len - 1) * 8 + this.bitsInLast;
  }

  get isByteAligned(): boolean {
    return this.bitsInLast === 0 || this.bitsInLast === 8;
  }

  /** Write the low `n` bits of `value`, most significant first. */
  u(n: number, value: number): void {
    if (n === 0) return;
    if (n > 32) throw new Error(`u(${n}) exceeds 32 bits`);
    this.grow(((n + 15) >> 3) + 1);
    let left = n;
    while (left > 0) {
      if (this.bitsInLast === 0 || this.bitsInLast === 8) {
        this.buf[this.len++] = 0;
        this.bitsInLast = 0;
      }
      const room = 8 - this.bitsInLast;
      const take = Math.min(room, left);
      // The `take` bits of `value` starting at bit (left - 1).
      const chunk = (value >>> (left - take)) & ((1 << take) - 1);
      const at = this.len - 1;
      this.buf[at] = (this.buf[at] ?? 0) | (chunk << (room - take));
      this.bitsInLast += take;
      left -= take;
    }
  }

  flag(v: boolean | number): void {
    this.u(1, v ? 1 : 0);
  }

  /** ue(v): unsigned Exp-Golomb (clause 9.1). */
  ue(value: number): void {
    if (value < 0) throw new Error(`ue(v) is unsigned, got ${value}`);
    // codeNum + 1 written as a 1 followed by (bits-1) zeros then the remainder.
    const v = value + 1;
    let bits = 32 - Math.clz32(v);
    this.u(bits - 1, 0);
    this.u(bits, v);
  }

  /** se(v): signed Exp-Golomb (clause 9.1.1). */
  se(value: number): void {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /** rbsp_trailing_bits(): a stop bit then zeros to the byte boundary. */
  rbspTrailingBits(): void {
    this.u(1, 1);
    while (!this.isByteAligned) this.u(1, 0);
  }

  /** The bytes written. Must be byte aligned. */
  bytes(): Uint8Array {
    if (!this.isByteAligned) {
      throw new Error(`RBSP is not byte aligned (${this.bitLength} bits)`);
    }
    return this.buf.subarray(0, this.len);
  }
}

/**
 * Wrap an RBSP as a NAL unit with a 4-byte Annex B start code.
 *
 * Emulation prevention: a third byte of 0x00..0x03 following two zero bytes
 * would otherwise let payload data imitate a start code, so a 0x03 is inserted
 * between them (clause 7.4.1.1).
 */
export function toNalUnit(
  rbsp: Uint8Array,
  nalRefIdc: number,
  nalUnitType: number,
): Uint8Array {
  const out: number[] = [
    0x00,
    0x00,
    0x00,
    0x01,
    (nalRefIdc << 5) | nalUnitType,
  ];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 0x03) {
      out.push(0x03);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0x00 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/** NAL unit types used by this encoder (Table 7-1). */
export const NalType = {
  SLICE_NON_IDR: 1,
  SLICE_IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
} as const;
