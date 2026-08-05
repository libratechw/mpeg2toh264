import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aacFmp4Init,
  aacToFmp4Fragment,
  h264GopToFmp4,
  h264ToFmp4,
  mpeg2FragmentDuration,
  mpeg2SampleTiming,
  mpeg2VideoTimeline,
  type Mpeg2VideoTimeline,
} from "../src/fmp4.ts";
import { IncrementalTranscoder, transcode } from "../src/transcode.ts";
import { sequenceSampleAspectRatio } from "../src/mpeg2/headers.ts";

function fixture(name: string) {
  return new Uint8Array(
    readFileSync(resolve(import.meta.dirname, `../testdata/${name}`)),
  );
}

function text(data: Uint8Array) {
  return new TextDecoder("latin1").decode(data);
}

describe("fragmented MP4 muxing", () => {
  it("derives 4:3 SAR for 1440x1080 MPEG-2 signalled as 16:9", () => {
    expect(
      sequenceSampleAspectRatio({
        horizontalSize: 1440,
        verticalSize: 1080,
        aspectRatioInformation: 3,
      }),
    ).toEqual({ width: 4, height: 3 });
  });

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

  it("writes pixel aspect ratio into the MP4 sample entry", () => {
    const mpeg2 = fixture("ibbp.m2v");
    const result = transcode(mpeg2);
    const timeline = {
      ...mpeg2VideoTimeline(mpeg2),
      sampleAspectRatio: { width: 4, height: 3 },
    };
    const mp4 = h264ToFmp4(result.bitstream, timeline);
    expect(text(mp4.initSegment)).toContain("pasp");
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
    );
    const secondTimeline = mpeg2VideoTimeline(gop, { hasReferences: true });
    const second = h264GopToFmp4(
      session.push(gop).bitstream,
      secondTimeline,
      2,
      first.duration,
    );
    expect(first.initSegment.length).toBeGreaterThan(0);
    expect(second.initSegment.length).toBe(0);
    expect(second.sampleCount).toBe(secondTimeline.presentationIndices.length);
    expect(first.duration).toBe(
      firstTimeline.presentationIndices.length * firstTimeline.sampleDuration +
        1,
    );
  });

  it("spans the source frames a random access point could not code", () => {
    // An open GOP's two leading B pictures reference the previous anchor, which
    // an IDR flushes, so a fragment restarting there starts at display slot 3.
    // Its duration still has to cover all fifteen source frames or the video
    // creeps ahead of the audio by two frames at every random access point.
    const timeline: Mpeg2VideoTimeline = {
      width: 720,
      height: 480,
      sampleDuration: 3003,
      presentationIndices: [3, 6, 4, 5, 9, 7, 8, 12, 10, 11, 15, 13, 14],
      syncSamples: [],
    };
    expect(mpeg2FragmentDuration(timeline, true)).toBe(15 * 3003);
    // A closed GOP leaves no slot for the IDR, so it takes a single tick.
    const closed = { ...timeline, presentationIndices: [1, 2, 3] };
    expect(mpeg2FragmentDuration(closed, true)).toBe(3 * 3003 + 1);
    expect(mpeg2FragmentDuration(closed, false)).toBe(3 * 3003);
  });

  it("never asks for a picture to be displayed before it is decoded", () => {
    const gop = fixture("ibbp.m2v");
    const timeline = mpeg2VideoTimeline(gop);
    for (const startsAtIdr of [false, true]) {
      const { durations, compositions, reorderDelay } = mpeg2SampleTiming(
        timeline,
        startsAtIdr,
      );
      expect(Math.min(...compositions)).toBeGreaterThanOrEqual(0);
      // The delay is real time the decoder gets, not padding: display order
      // still runs one slot per frame with no repeats or gaps.
      let decodeTime = 0;
      const displayed = durations
        .map((duration, index) => {
          const at = decodeTime + compositions[index]!;
          decodeTime += duration;
          return at;
        })
        .sort((a, b) => a - b);
      expect(displayed[0]).toBe(reorderDelay);
      expect(new Set(displayed).size).toBe(displayed.length);
    }
  });

  it("packages raw AAC-LC frames in an audio track without ADTS headers", () => {
    const config = {
      audioObjectType: 2,
      sampleRate: 48_000,
      samplingFrequencyIndex: 3,
      channelCount: 2,
      audioSpecificConfig: Uint8Array.of(0x11, 0x90),
    };
    const init = aacFmp4Init(config);
    const samples = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)];
    const fragment = aacToFmp4Fragment(samples, 1, 0);
    expect(init.mimeCodec).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(text(init.initSegment)).toContain("mp4a");
    expect(text(init.initSegment)).toContain("esds");
    expect(fragment.sampleCount).toBe(2);
    expect(fragment.duration).toBe(2048);
    expect(fragment.mediaSegment.subarray(-5)).toEqual(
      Uint8Array.of(1, 2, 3, 4, 5),
    );

    const mpeg2 = fixture("ibbp.m2v");
    const h264 = transcode(mpeg2);
    const combined = h264GopToFmp4(
      h264.bitstream,
      mpeg2VideoTimeline(mpeg2),
      1,
      0,
      config,
      { config, samples, baseDecodeTime: 0 },
    );
    expect(combined.mimeCodec).toContain("mp4a.40.2");
    expect(text(combined.initSegment).match(/trak/g)).toHaveLength(2);
    expect(text(combined.mediaSegment).match(/traf/g)).toHaveLength(2);
  });
});
