import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractMpeg2VideoEs, isMpegTransportStream } from "../src/mpegts.ts";
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
});
