import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractMpeg2VideoEs,
  isMpegTransportStream,
  MpegTsVideoDemuxer,
} from "../src/mpegts.ts";
import { wrapMpeg2EsInTs } from "./ts-fixture.ts";

describe("MPEG-TS demuxing", () => {
  it("selects stream_type 0x02 and reconstructs its PES payload", () => {
    const es = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, "fixtures/i_only.m2v")),
    );
    const ts = wrapMpeg2EsInTs(es);
    expect(isMpegTransportStream(ts)).toBe(true);
    expect(extractMpeg2VideoEs(ts)).toEqual(es);
  });

  it("does not mistake an elementary stream for transport packets", () => {
    const es = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, "fixtures/i_only.m2v")),
    );
    expect(isMpegTransportStream(es)).toBe(false);
  });

  it("streams arbitrarily split TS chunks without retaining the full input", () => {
    const es = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, "fixtures/i_only.m2v")),
    );
    const ts = wrapMpeg2EsInTs(es);
    const demuxer = new MpegTsVideoDemuxer();
    const parts: Uint8Array[] = [];
    for (let at = 0; at < ts.length; at += 137)
      parts.push(...demuxer.push(ts.subarray(at, at + 137)));
    parts.push(...demuxer.finish());
    const joined = new Uint8Array(
      parts.reduce((sum, part) => sum + part.length, 0),
    );
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    expect(joined).toEqual(es);
  });

  it("waits for a PES start when the video PID is discovered mid-PES", () => {
    const es = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, "fixtures/i_only.m2v")),
    );
    const ts = wrapMpeg2EsInTs(es);
    const packets = Array.from({ length: ts.length / 188 }, (_, index) =>
      ts.subarray(index * 188, (index + 1) * 188),
    );
    expect(packets.length).toBeGreaterThan(3);

    // PAT/PMT followed by a continuation packet models tuning in halfway
    // through a broadcast PES. A complete PES follows on the repeated TS.
    const input = new Uint8Array((3 + packets.length - 2) * 188);
    input.set(packets[0]!, 0);
    input.set(packets[1]!, 188);
    input.set(packets[3]!, 376);
    for (let index = 2; index < packets.length; index++) {
      input.set(packets[index]!, (index + 1) * 188);
    }

    const demuxer = new MpegTsVideoDemuxer();
    const parts = [...demuxer.push(input), ...demuxer.finish()];
    expect(parts).toEqual([es]);
  });
});
