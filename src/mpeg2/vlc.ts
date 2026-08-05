/**
 * Flat lookup decoding for the Annex B variable length codes.
 *
 * Each table is expanded into a direct-indexed array covering the longest code
 * in it: peek `maxLen` bits, read the value and the true code length out of the
 * table, then consume that many bits. Costs one memory read per symbol.
 */
import type { BitReader } from "../bitreader.ts";
import type { VlcEntry } from "./vlc-tables.ts";

export class VlcTable<T extends number | string> {
  readonly name: string;
  readonly maxLen: number;
  private readonly lengths: Uint8Array;
  private readonly values: (T | undefined)[];

  constructor(name: string, entries: readonly VlcEntry<T>[]) {
    this.name = name;
    this.maxLen = entries.reduce((m, [code]) => Math.max(m, code.length), 0);
    const size = 1 << this.maxLen;
    this.lengths = new Uint8Array(size); // 0 means "no code here"
    this.values = new Array(size);

    for (const [code, value] of entries) {
      const len = code.length;
      const prefix = parseInt(code, 2) << (this.maxLen - len);
      const fill = 1 << (this.maxLen - len);
      for (let i = 0; i < fill; i++) {
        const idx = prefix | i;
        if (this.lengths[idx] !== 0) {
          throw new Error(`${name}: code '${code}' collides at index ${idx}`);
        }
        this.lengths[idx] = len;
        this.values[idx] = value;
      }
    }
  }

  /** Decode one symbol, advancing the reader. Throws on an invalid code. */
  decode(r: BitReader): T {
    const idx = r.peek(this.maxLen);
    const len = this.lengths[idx]!;
    if (len === 0) {
      throw new Error(
        `${this.name}: invalid code 0b${idx.toString(2).padStart(this.maxLen, "0")} at bit ${r.bitPos}`,
      );
    }
    r.skip(len);
    return this.values[idx]!;
  }

  /** Peek at the symbol without consuming it; undefined if the code is invalid. */
  peekSymbol(r: BitReader): T | undefined {
    const idx = r.peek(this.maxLen);
    return this.lengths[idx] === 0 ? undefined : this.values[idx];
  }
}
