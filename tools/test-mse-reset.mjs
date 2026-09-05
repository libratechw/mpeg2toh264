import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

class FakeSourceBuffer extends EventTarget {
  mode = "segments";
  updating = false;
  appendError = null;
  appended = [];
  removed = [];
  buffered = {
    length: 0,
    start: () => 0,
    end: () => 0,
  };

  appendBuffer(data) {
    if (this.appendError) throw this.appendError;
    assert.equal(this.updating, false);
    this.updating = true;
    this.appended.push(data);
  }

  remove(start, end) {
    assert.equal(this.updating, false);
    this.updating = true;
    this.removed.push([start, end]);
  }

  complete() {
    assert.equal(this.updating, true);
    this.updating = false;
    this.dispatchEvent(new Event("updateend"));
  }

  changeType() {}
}

class FakeMediaSource extends EventTarget {
  static isTypeSupported() {
    return true;
  }

  readyState = "open";
  duration = Number.NaN;
  sourceBuffer = new FakeSourceBuffer();

  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
  }

  addSourceBuffer() {
    return this.sourceBuffer;
  }

  endOfStream() {}
}

const output = join(tmpdir(), `mpeg2toh264-mse-test-${process.pid}.mjs`);
globalThis.MediaSource = FakeMediaSource;

try {
  await build({
    entryPoints: ["packages/player/src/mse.ts"],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "browser",
  });
  const { MseSink } = await import(pathToFileURL(output));
  const sink = new MseSink({
    queueHighWaterMark: 1024 * 1024,
    maxAheadSeconds: 8,
    keepBehindSeconds: 10,
    seek() {},
  });
  const oldInit = new Uint8Array([1]).buffer;
  const oldMedia = new Uint8Array([2]).buffer;
  const newInit = new Uint8Array([3]).buffer;
  const newMedia = new Uint8Array([4]).buffer;

  await sink.open("video/mp4; codecs=avc1.640028", oldInit);
  const sourceBuffer = sink.mediaSource.sourceBuffer;
  sink.push(oldMedia, 0, true);
  sink.reset();
  await sink.open("video/mp4; codecs=avc1.640028", newInit);
  sink.push(newMedia, 10, true);

  sourceBuffer.complete();
  assert.deepEqual(sourceBuffer.removed, [[0, Number.POSITIVE_INFINITY]]);
  sourceBuffer.complete();
  assert.equal(sourceBuffer.appended[1], newInit);
  sourceBuffer.complete();
  assert.equal(sourceBuffer.appended[2], newMedia);

  const diagnosticErrors = [];
  const diagnosticSink = new MseSink({
    queueHighWaterMark: 1024 * 1024,
    maxAheadSeconds: 8,
    keepBehindSeconds: 10,
    seek() {},
    onError(error) {
      diagnosticErrors.push(error);
    },
  });
  const invalidState = new Error("The object is in an invalid state.");
  invalidState.name = "InvalidStateError";
  diagnosticSink.mediaSource.sourceBuffer.appendError = invalidState;
  await diagnosticSink.open("video/mp4; codecs=avc1.640028", oldInit);
  assert.equal(diagnosticErrors.length, 1);
  assert.equal(diagnosticErrors[0].name, "InvalidStateError");
  assert.match(
    diagnosticErrors[0].message,
    /^MSE append SourceBuffer failed \(mediaSource=open, closed=false, sourceBuffer=present, updating=false, operation=none, queue=1, epoch=0\): InvalidStateError: The object is in an invalid state\.$/,
  );
} finally {
  delete globalThis.MediaSource;
  await unlink(output).catch(() => {});
}
