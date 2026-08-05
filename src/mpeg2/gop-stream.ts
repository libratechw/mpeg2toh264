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

/** Split an MPEG-2 ES into bounded GOP units while carrying sequence headers forward. */
export class Mpeg2GopStream {
  private buffer: Uint8Array = new Uint8Array(0);
  private sequencePrefix: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = concat(this.buffer, chunk);
    return this.extract(false);
  }

  finish(): Uint8Array[] {
    return this.extract(true);
  }

  private extract(final: boolean): Uint8Array[] {
    const output: Uint8Array[] = [];
    for (;;) {
      const sequences = starts(this.buffer, 0xb3);
      const gops = starts(this.buffer, 0xb8);
      if (gops.length === 0) {
        if (sequences.length > 0 && sequences[0]! > 0)
          this.buffer = this.buffer.slice(sequences[0]);
        break;
      }
      if (gops[0]! > 0) {
        const sequence = sequences.filter((at) => at < gops[0]!).pop();
        if (sequence !== undefined) {
          this.sequencePrefix = this.buffer.slice(sequence, gops[0]);
          if (sequence > 0) this.buffer = this.buffer.slice(sequence);
        }
      }
      const currentGops = starts(this.buffer, 0xb8);
      if (currentGops.length < 2) break;
      const secondGop = currentGops[1]!;
      const nextSequence = starts(this.buffer, 0xb3)
        .filter((at) => at > currentGops[0]! && at < secondGop)
        .pop();
      const boundary = nextSequence ?? secondGop;
      output.push(this.buffer.slice(0, boundary));
      let remainder: Uint8Array = this.buffer.slice(boundary);
      if (nextSequence === undefined && this.sequencePrefix.length > 0) {
        remainder = concat(this.sequencePrefix, remainder);
      }
      this.buffer = remainder;
    }
    if (final && starts(this.buffer, 0x00).length > 0) {
      output.push(this.buffer);
      this.buffer = new Uint8Array(0);
    }
    return output;
  }
}
