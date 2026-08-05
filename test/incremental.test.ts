import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IncrementalTranscoder, transcode } from "../src/transcode.ts";
import { Mpeg2GopStream } from "../src/mpeg2/gop-stream.ts";
import { parseElementaryStream } from "../src/mpeg2/headers.ts";

function join(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("incremental transcoding", () => {
  it("preserves reference, frame number, POC, and GOP state across pushes", () => {
    const gop = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, "fixtures/ibbp.m2v")),
    );
    const combined = join([gop, gop]);
    const expected = transcode(combined);
    const session = new IncrementalTranscoder();
    const actual = join([
      session.push(gop).bitstream,
      session.push(gop).bitstream,
    ]);
    expect(actual).toEqual(expected.bitstream);
  });

  it("emits complete GOPs while retaining only the unfinished tail", () => {
    const gop = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, "fixtures/ibbp.m2v")),
    );
    const combined = join([gop, gop]);
    const stream = new Mpeg2GopStream();
    const units: Uint8Array[] = [];
    for (let at = 0; at < combined.length; at += 97) {
      units.push(...stream.push(combined.subarray(at, at + 97)));
    }
    units.push(...stream.finish());
    expect(units).toHaveLength(2);
    const picturesPerGop = parseElementaryStream(gop).length;
    expect(units.map((unit) => parseElementaryStream(unit).length)).toEqual([
      picturesPerGop,
      picturesPerGop,
    ]);
  });
});
