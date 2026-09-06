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
    this.dispatchEvent(new Event("updatestart"));
  }

  remove(start, end) {
    assert.equal(this.updating, false);
    this.updating = true;
    this.removed.push([start, end]);
    this.dispatchEvent(new Event("updatestart"));
  }

  complete() {
    assert.equal(this.updating, true);
    this.updating = false;
    this.dispatchEvent(new Event("update"));
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

class FakeManagedMediaSource extends FakeMediaSource {}

const output = join(tmpdir(), `mpeg2toh264-mse-test-${process.pid}.mjs`);
globalThis.MediaSource = FakeMediaSource;
globalThis.ManagedMediaSource = FakeManagedMediaSource;

try {
  await build({
    entryPoints: ["packages/player/src/mse.ts"],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "browser",
  });
  const { MseSink } = await import(pathToFileURL(output));
  assert.doesNotThrow(
    () =>
      new MseSink({
        queueHighWaterMark: 1024,
        maxAheadSeconds: 8,
        keepBehindSeconds: 10,
        seek() {},
        onLifecycle() {
          throw new Error("diagnostic observer failure");
        },
      }),
  );
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
  const lifecycle = [];
  const diagnosticSink = new MseSink({
    queueHighWaterMark: 1024 * 1024,
    maxAheadSeconds: 8,
    keepBehindSeconds: 10,
    seek() {},
    onError(error) {
      diagnosticErrors.push(error);
    },
    onLifecycle(trace) {
      lifecycle.push(trace);
    },
  });
  const invalidState = new Error("The object is in an invalid state.");
  invalidState.name = "InvalidStateError";
  await diagnosticSink.open("video/mp4; codecs=avc1.640028", oldInit);
  diagnosticSink.mediaSource.sourceBuffer.complete();
  diagnosticSink.mediaSource.readyState = "closed";
  diagnosticSink.mediaSource.dispatchEvent(new Event("sourceclose"));
  diagnosticSink.mediaSource.sourceBuffer.appendError = invalidState;
  diagnosticSink.push(oldMedia, 0, true);
  assert.equal(diagnosticErrors.length, 1);
  assert.equal(diagnosticErrors[0].name, "InvalidStateError");
  assert.match(
    diagnosticErrors[0].message,
    /^MSE append SourceBuffer failed \(mediaSource=closed, closed=false, sourceOpens=1, sourceCloses=1, sinceSourceOpenMs=\d+, sinceSourceCloseMs=\d+, sourceBuffer=present, updating=false, operation=none, queue=1, epoch=0\): InvalidStateError: The object is in an invalid state\.$/,
  );
  assert.equal(lifecycle[0].event, "mse-created");
  assert.equal(lifecycle[0].mediaSourceClass, "MediaSource");
  assert.equal(
    lifecycle.find(({ event }) => event === "mediasource-sourceclose").critical,
    true,
  );
  const updateEnd = lifecycle.find(
    ({ event }) => event === "sourcebuffer-updateend",
  );
  assert.equal(updateEnd.detail.operation, "append");
  assert.equal(updateEnd.detail.operationEpoch, 0);
  assert.equal(updateEnd.detail.queueLength, 1);
  const mseError = lifecycle.find(({ event }) => event === "mse-error");
  assert.equal(mseError.critical, true);
  assert.equal(mseError.detail.failedOperation, "append SourceBuffer");
  assert.equal(Object.isFrozen(mseError), true);
  assert.equal(Object.isFrozen(mseError.detail), true);
  assert.equal(
    lifecycle.every(
      (entry, index) => index === 0 || entry.at >= lifecycle[index - 1].at,
    ),
    true,
  );
  assert.equal(lifecycle[0].at >= performance.timeOrigin, true);

  const managedLifecycle = [];
  const managedSink = new MseSink({
    preferManaged: true,
    queueHighWaterMark: 1024 * 1024,
    maxAheadSeconds: 8,
    keepBehindSeconds: 10,
    seek() {},
    onLifecycle(trace) {
      managedLifecycle.push(trace);
    },
  });
  managedSink.mediaSource.dispatchEvent(new Event("endstreaming"));
  managedSink.mediaSource.dispatchEvent(new Event("startstreaming"));
  assert.equal(managedSink.managed, true);
  assert.equal(managedLifecycle[0].mediaSourceClass, "ManagedMediaSource");
  assert.deepEqual(
    managedLifecycle.slice(-2).map(({ event }) => event),
    ["mediasource-endstreaming", "mediasource-startstreaming"],
  );
} finally {
  delete globalThis.MediaSource;
  delete globalThis.ManagedMediaSource;
  await unlink(output).catch(() => {});
}
