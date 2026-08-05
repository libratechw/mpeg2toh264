import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IncrementalTranscoder, transcode } from "../src/transcode.ts";
import { Mpeg2GopStream } from "../src/mpeg2/gop-stream.ts";
import { parseElementaryStream } from "../src/mpeg2/headers.ts";
import { h264GopToFmp4, mpeg2VideoTimeline } from "../src/fmp4.ts";

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

  it("can insert a real IDR restart point between incremental GOPs", () => {
    const gop = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, "fixtures/ibbp.m2v")),
    );
    const session = new IncrementalTranscoder();
    session.push(gop);
    session.requestRandomAccessPoint();
    const restarted = session.push(gop).bitstream;
    expect([...restarted.subarray(0, 5)]).toEqual([0, 0, 0, 1, 0x65]);
    const timeline = mpeg2VideoTimeline(gop, { hasReferences: false });
    const fragment = h264GopToFmp4(restarted, timeline, 2, 0, 0);
    expect(fragment.sampleCount).toBe(timeline.presentationIndices.length + 1);
    expect(fragment.duration).toBe(
      timeline.presentationIndices.length * timeline.sampleDuration + 1,
    );
  });

  it("restarts the I_PCM path with a content IDR instead of a grey prefix", () => {
    const gop = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, "fixtures/ibbp.m2v")),
    );
    const session = new IncrementalTranscoder({ pcmIntra: true });
    session.push(gop);
    session.requestRandomAccessPoint();
    const restarted = session.push(gop).bitstream;
    expect([...restarted.subarray(0, 5)]).toEqual([0, 0, 0, 1, 0x65]);
    const timeline = mpeg2VideoTimeline(gop, { hasReferences: false });
    const fragment = h264GopToFmp4(restarted, timeline, 2, 0, 0);
    expect(fragment.sampleCount).toBe(timeline.presentationIndices.length);
    expect(fragment.duration).toBe(
      timeline.presentationIndices.length * timeline.sampleDuration,
    );
  });
});
