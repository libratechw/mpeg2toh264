/**
 * Bit reader for MPEG-2 elementary streams.
 *
 * MPEG-2 has no emulation prevention bytes, so the byte stream maps directly to
 * the bit stream. Start codes are byte-aligned `00 00 01 xx` sequences and are
 * guaranteed not to occur inside coded data, which is what lets us scan for them.
 */
export class BitReader {
  readonly data: Uint8Array;
  /** Absolute position in bits from the start of `data`. */
  private pos = 0;

  constructor(data: Uint8Array, startBit = 0) {
    this.data = data;
    this.pos = startBit;
  }

  get bitPos(): number {
    return this.pos;
  }

  set bitPos(v: number) {
    this.pos = v;
  }

  get bytePos(): number {
    return this.pos >>> 3;
  }

  get bitsLeft(): number {
    return this.data.length * 8 - this.pos;
  }

  get atEnd(): boolean {
    return this.pos >= this.data.length * 8;
  }

  /** Read `n` bits (n <= 32) MSB-first as an unsigned integer. */
  u(n: number): number {
    if (n === 0) return 0;
    let v = 0;
    let left = n;
    let p = this.pos;
    while (left > 0) {
      const byte = this.data[p >>> 3] ?? 0;
      const bitOffset = p & 7;
      const avail = 8 - bitOffset;
      const take = Math.min(avail, left);
      // Extract `take` bits starting at bitOffset within the byte.
      const chunk = (byte >>> (avail - take)) & ((1 << take) - 1);
      v = v * (1 << take) + chunk;
      p += take;
      left -= take;
    }
    this.pos = p;
    return v;
  }

  /** Peek `n` bits without consuming them. */
  peek(n: number): number {
    const save = this.pos;
    const v = this.u(n);
    this.pos = save;
    return v;
  }

  /** Read a single bit as a boolean. */
  flag(): boolean {
    return this.u(1) === 1;
  }

  skip(n: number): void {
    this.pos += n;
  }

  /**
   * MPEG-2 marker_bit: a bit that shall be 1, present purely to prevent
   * accidental start code emulation. A zero here means we have lost sync.
   */
  marker(): void {
    if (this.u(1) !== 1) {
      throw new Error(`marker_bit was 0 at bit ${this.pos - 1} (lost sync)`);
    }
  }

  get isByteAligned(): boolean {
    return (this.pos & 7) === 0;
  }

  alignToByte(): void {
    this.pos = (this.pos + 7) & ~7;
  }

  /**
   * MPEG-2 `nextbits() == '0000 0000 0000 0000 0000 0001'`: true when the
   * upcoming (byte-aligned) data is a start code prefix. Used to detect the end
   * of a slice, since slices are terminated by whatever start code follows.
   */
  atStartCode(): boolean {
    const p = (this.pos + 7) & ~7;
    const b = p >>> 3;
    return (
      this.data[b] === 0x00 &&
      this.data[b + 1] === 0x00 &&
      this.data[b + 2] === 0x01
    );
  }
}

/** A `00 00 01 xx` start code located in the stream. */
export interface StartCode {
  /** The `xx` byte following the `00 00 01` prefix. */
  code: number;
  /** Byte offset of the `00` that begins the prefix. */
  offset: number;
  /** Byte offset of the first payload byte (just past the code byte). */
  payloadOffset: number;
}

/**
 * Scan the whole buffer for start codes. MPEG-2 streams are small enough in
 * practice that one up-front pass is simpler than incremental scanning, and it
 * lets the header/slice parsers work on known-bounded ranges.
 */
export function findStartCodes(data: Uint8Array): StartCode[] {
  const out: StartCode[] = [];
  const n = data.length;
  for (let i = 0; i + 3 < n; i++) {
    if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
      out.push({ code: data[i + 3]!, offset: i, payloadOffset: i + 4 });
    }
  }
  return out;
}
