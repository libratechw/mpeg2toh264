// Exercise the browser input adapter against the codec's actual MP4 output.
// WebCodecs is stubbed only to inspect submitted samples and resource ownership.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "mpeg2toh264-video-input-"));
try {
  const output = join(directory, "video.mp4");
  execFileSync("cargo", [
    "run",
    "--quiet",
    "--release",
    "--bin",
    "mpeg2toh264",
    "--",
    "testdata/hd1080i.m2v",
    output,
  ]);
  const mp4 = await readFile(output);
  const buffer = mp4.buffer.slice(
    mp4.byteOffset,
    mp4.byteOffset + mp4.byteLength,
  );
  const bundle = await build({
    entryPoints: ["packages/yadif/src/encoded-video.ts"],
    bundle: true,
    format: "esm",
    write: false,
  });
  const { EncodedVideoFrames } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const decoders = [];
  const warnings = [];
  let rejectConfiguration = false;
  class Decoder {
    static async isConfigSupported() {
      return { supported: true };
    }
    state = "unconfigured";
    decodeQueueSize = 0;
    chunks = [];
    closes = 0;
    constructor(callbacks) {
      this.callbacks = callbacks;
      decoders.push(this);
    }
    configure(config) {
      if (rejectConfiguration)
        throw new DOMException("Unsupported config", "NotSupportedError");
      assert.match(config.codec, /^avc1\.[0-9a-f]{6}$/);
      assert.ok(config.description.length > 4);
      this.state = "configured";
    }
    decode(chunk) {
      this.chunks.push(chunk);
    }
    async flush() {}
    close() {
      assert.notEqual(this.state, "closed");
      this.state = "closed";
      this.closes++;
    }
  }
  globalThis.VideoDecoder = Decoder;
  globalThis.EncodedVideoChunk = class {
    constructor(sample) {
      Object.assign(this, sample);
    }
  };
  const warn = console.warn;
  console.warn = (...values) => warnings.push(values);
  try {
    const video = Object.assign(new EventTarget(), {
      currentTime: 0,
      playbackRate: 1,
      buffered: { length: 1, start: () => 0, end: () => 1 },
    });
    const input = new EncodedVideoFrames(video);
    input.append(buffer);
    await new Promise((resolve) => setImmediate(resolve));
    for (const rate of [1, 1.1, 1.25]) {
      video.playbackRate = rate;
      video.dispatchEvent(new Event("ratechange"));
      assert.equal(input.take(), undefined);
      assert.equal(
        decoders.length,
        0,
        `${rate} must reuse the element's decoder`,
      );
    }
    video.playbackRate = 1.5;
    video.dispatchEvent(new Event("ratechange"));
    input.take();
    assert.equal(input.active, true);
    assert.equal(decoders.length, 1);
    // Finish draining the compressed input; no synthetic decoder output is needed to check the demuxer.
    video.currentTime = 1;
    input.finish();
    input.take();
    const decoder = decoders[0];
    assert.equal(
      decoder.chunks.filter((chunk) => chunk.duration >= 1000).length,
      15,
    );
    assert.equal(
      decoder.chunks.filter((chunk) => chunk.duration < 1000).length,
      1,
      "the reference-only copy must still be decoded",
    );
    assert.equal(decoder.chunks[0].type, "key");
    assert.ok(
      decoder.chunks.every(
        (chunk) => chunk.data.length > 0 && chunk.duration > 0,
      ),
    );
    assert.ok(
      decoder.chunks.some(
        (chunk, index) =>
          index > 0 && chunk.timestamp < decoder.chunks[index - 1].timestamp,
      ),
      "B pictures must retain their composition offsets",
    );
    input.suspend();
    assert.equal(decoder.closes, 1);
    let frameCloses = 0;
    decoder.callbacks.output({
      timestamp: 1e6,
      close() {
        frameCloses++;
      },
    });
    decoder.callbacks.error(new Error("obsolete decoder"));
    assert.equal(
      frameCloses,
      1,
      "a late frame from a closed decoder must be released",
    );
    assert.equal(
      warnings.length,
      0,
      "a closed decoder must not fail its replacement",
    );
    // A synchronous configure failure must leave ordinary frame acquisition available.
    rejectConfiguration = true;
    video.currentTime = 0;
    assert.equal(input.take(), undefined);
    assert.equal(input.active, false);
    assert.equal(warnings.length, 1);
    rejectConfiguration = false;
    input.reset();
    input.append(buffer);
    await new Promise((resolve) => setImmediate(resolve));
    input.take();
    assert.equal(input.active, true, "a new load must recover the decoder");
    input.destroy();
    assert.ok(decoders.every((decoder) => decoder.closes === 1));
    console.log(
      "encoded video: rate selection, real MP4 samples, stale callbacks and recovery passed",
    );
  } finally {
    console.warn = warn;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
