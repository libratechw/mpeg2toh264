import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractMpeg2VideoEs,
  isMpegTransportStream,
  MpegTsAvDemuxer,
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

  it("emits stream_type 0x0f AAC PES without modifying ADTS bytes", () => {
    const es = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, "fixtures/i_only.m2v")),
    );
    const ts = wrapMpeg2EsInTs(es);
    const input = new Uint8Array(ts.length + 188);
    input.set(ts);
    // Extend the fixture PMT with one AAC PID (0x102).
    input[188 + 7] = 0x17;
    input.copyWithin(188 + 27, 188 + 22, 188 + 26);
    input.set([0x0f, 0xe1, 0x02, 0xf0, 0x00, 0, 0, 0, 0], 188 + 22);
    const adts = Uint8Array.of(
      0xff,
      0xf1,
      0x4c,
      0x80,
      0x01,
      0x5f,
      0xfc,
      1,
      2,
      3,
    );
    const pes = Uint8Array.of(0, 0, 1, 0xc0, 0, 13, 0x80, 0, 0, ...adts);
    const packet = new Uint8Array(188).fill(0xff);
    const adaptationLength = 183 - pes.length;
    packet.set([0x47, 0x41, 0x02, 0x30, adaptationLength]);
    packet[5] = 0;
    packet.set(pes, 5 + adaptationLength);
    input.set(packet, ts.length);

    const demuxer = new MpegTsAvDemuxer();
    const packets = [...demuxer.push(input), ...demuxer.finish()];
    expect(packets.find((part) => part.kind === "audio")?.data).toEqual(adts);
  });
});
