import { describe, expect, it } from "vitest";
import { aacFrameCountThroughVideoTime, AdtsStream } from "../src/aac/adts.ts";

function adts(
  payload: number[],
  sampleRateIndex = 3,
  channels = 2,
): Uint8Array {
  const length = 7 + payload.length;
  return Uint8Array.of(
    0xff,
    0xf1,
    (1 << 6) | (sampleRateIndex << 2) | (channels >> 2),
    ((channels & 3) << 6) | (length >> 11),
    length >> 3,
    (length << 5) | 0x1f,
    0xfc,
    ...payload,
  );
}

describe("ADTS passthrough", () => {
  it("allocates AAC frames from cumulative video time without per-GOP drift", () => {
    const thirtySeconds = 30 * 90_000;
    expect(aacFrameCountThroughVideoTime(thirtySeconds, 48_000)).toBe(1406);
  });

  it("strips headers across arbitrary input boundaries", () => {
    const input = new Uint8Array([...adts([1, 2, 3]), ...adts([4, 5])]);
    const parser = new AdtsStream();
    const frames = [];
    for (let at = 0; at < input.length; at += 4)
      frames.push(...parser.push(input.subarray(at, at + 4)));
    frames.push(...parser.finish());
    expect(frames.map((frame) => [...frame.data])).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(frames[0]!.config).toMatchObject({
      audioObjectType: 2,
      sampleRate: 48_000,
      channelCount: 2,
    });
    expect([...frames[0]!.config.audioSpecificConfig]).toEqual([0x11, 0x90]);
  });
});
