import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { h264GopToFmp4, h264ToFmp4, mpeg2VideoTimeline } from "../src/fmp4.ts";
import { IncrementalTranscoder, transcode } from "../src/transcode.ts";

function fixture(name: string) {
  return new Uint8Array(
    readFileSync(resolve(import.meta.dirname, `fixtures/${name}`)),
  );
}

function text(data: Uint8Array) {
  return new TextDecoder("latin1").decode(data);
}

describe("fragmented MP4 muxing", () => {
  it("packages SPS/PPS and every H.264 access unit for MSE", () => {
    const mpeg2 = fixture("ibbp.m2v");
    const result = transcode(mpeg2);
    const mp4 = h264ToFmp4(result.bitstream, mpeg2VideoTimeline(mpeg2));
    expect(mp4.sampleCount).toBe(result.picturesConverted + 1);
    expect(mp4.mimeCodec).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6}"$/);
    expect(text(mp4.initSegment)).toContain("ftyp");
    expect(text(mp4.initSegment)).toContain("moov");
    expect(text(mp4.initSegment)).toContain("avcC");
    expect(text(mp4.mediaSegment)).toContain("moof");
    expect(text(mp4.mediaSegment)).toContain("mdat");
  });

  it("derives 30000/1001 timing in the 90 kHz media timescale", () => {
    const timeline = mpeg2VideoTimeline(fixture("hd1080i.m2v"));
    expect(timeline.sampleDuration).toBe(3003);
  });

  it("continues decode and presentation timelines across GOP fragments", () => {
    const gop = fixture("ibbp.m2v");
    const session = new IncrementalTranscoder();
    const firstTimeline = mpeg2VideoTimeline(gop);
    const first = h264GopToFmp4(
      session.push(gop).bitstream,
      firstTimeline,
      1,
      0,
      0,
    );
    const secondTimeline = mpeg2VideoTimeline(gop, { hasReferences: true });
    const second = h264GopToFmp4(
      session.push(gop).bitstream,
      secondTimeline,
      2,
      first.duration,
      Math.max(...firstTimeline.presentationIndices),
    );
    expect(first.initSegment.length).toBeGreaterThan(0);
    expect(second.initSegment.length).toBe(0);
    expect(second.sampleCount).toBe(secondTimeline.presentationIndices.length);
  });
});
