function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function starts(data: Uint8Array, code: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 1 &&
      data[i + 3] === code
    ) {
      out.push(i);
      i += 3;
    }
  }
  return out;
}

/** One GOP unit, and when its first coded picture is meant to be shown. */
export interface Mpeg2Gop {
  data: Uint8Array;
  /**
   * The PES presentation timestamp covering the unit's first byte, in 90 kHz
   * units, or null when the caller supplied none.
   *
   * A unit begins at a sequence or GOP header, which a transport stream places
   * at the start of the PES that also carries the I picture, so this is that
   * picture's timestamp. Whatever the splitter discarded before it -- and it
   * discards everything before the first sequence header, which can be several
   * pictures -- is already excluded.
   */
  pts: number | null;
}

/** Where a PES packet's payload landed in the stream, and what time it claimed. */
interface Mark {
  offset: number;
  pts: number;
}

/** Split an MPEG-2 ES into bounded GOP units while carrying sequence headers forward. */
export class Mpeg2GopStream {
  private buffer: Uint8Array = new Uint8Array(0);
  private sequencePrefix: Uint8Array = new Uint8Array(0);
  /**
   * Absolute stream offset of the first byte of `buffer` that came from the
   * stream, which is `buffer[prefixLength]`: a re-injected sequence header is
   * not part of the stream and has no offset of its own.
   */
  private base = 0;
  private prefixLength = 0;
  private marks: Mark[] = [];

  push(chunk: Uint8Array, pts: number | null = null): Mpeg2Gop[] {
    if (pts !== null) {
      this.marks.push({
        offset: this.base + this.buffer.length - this.prefixLength,
        pts,
      });
    }
    this.buffer = concat(this.buffer, chunk);
    return this.extract(false);
  }

  finish(): Mpeg2Gop[] {
    return this.extract(true);
  }

  /** Drop bytes from the front, keeping the offset mapping in step. */
  private consume(count: number): void {
    const fromPrefix = Math.min(count, this.prefixLength);
    this.prefixLength -= fromPrefix;
    this.base += count - fromPrefix;
    this.buffer = this.buffer.slice(count);
  }

  /** The timestamp of the PES packet covering an absolute stream offset. */
  private ptsAt(offset: number): number | null {
    let pts: number | null = null;
    let covering = -1;
    for (
      let i = 0;
      i < this.marks.length && this.marks[i]!.offset <= offset;
      i++
    ) {
      pts = this.marks[i]!.pts;
      covering = i;
    }
    if (covering > 0) this.marks.splice(0, covering);
    return pts;
  }

  private extract(final: boolean): Mpeg2Gop[] {
    const output: Mpeg2Gop[] = [];
    for (;;) {
      const sequences = starts(this.buffer, 0xb3);
      const gops = starts(this.buffer, 0xb8);
      if (gops.length === 0) {
        if (sequences.length > 0 && sequences[0]! > 0)
          this.consume(sequences[0]!);
        break;
      }
      if (gops[0]! > 0) {
        const sequence = sequences.filter((at) => at < gops[0]!).pop();
        if (sequence !== undefined) {
          this.sequencePrefix = this.buffer.slice(sequence, gops[0]);
          if (sequence > 0) this.consume(sequence);
        }
      }
      const currentGops = starts(this.buffer, 0xb8);
      if (currentGops.length < 2) break;
      const secondGop = currentGops[1]!;
      const nextSequence = starts(this.buffer, 0xb3)
        .filter((at) => at > currentGops[0]! && at < secondGop)
        .pop();
      const boundary = nextSequence ?? secondGop;
      output.push({
        data: this.buffer.slice(0, boundary),
        pts: this.ptsAt(this.base),
      });
      this.consume(boundary);
      if (nextSequence === undefined && this.sequencePrefix.length > 0) {
        this.buffer = concat(this.sequencePrefix, this.buffer);
        this.prefixLength += this.sequencePrefix.length;
      }
    }
    if (final && starts(this.buffer, 0x00).length > 0) {
      output.push({ data: this.buffer, pts: this.ptsAt(this.base) });
      this.buffer = new Uint8Array(0);
      this.prefixLength = 0;
    }
    return output;
  }
}
