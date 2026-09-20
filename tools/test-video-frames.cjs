// Run with: node tools/test-video-frames.cjs
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const source = readFileSync(
  resolve(__dirname, "../packages/yadif/src/video-frame.ts"),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const modulePromise = import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

async function fixture(t, moz = true) {
  const { VideoFrames, supportsVideoFrames } = await modulePromise;
  let next = 1;
  const raf = new Map();
  const native = new Map();
  class Video extends EventTarget {
    readyState = 4;
    videoWidth = 720;
    videoHeight = 480;
    currentTime = 0;
    paused = false;
    ended = false;
    seeking = false;
    playbackRate = 1;
    requestVideoFrameCallback(callback) {
      const id = next++;
      native.set(id, callback);
      return id;
    }
    cancelVideoFrameCallback(id) {
      native.delete(id);
    }
  }
  if (moz) {
    Object.assign(Video.prototype, {
      mozParsedFrames: 10,
      mozDecodedFrames: 5,
      mozPresentedFrames: 0,
      mozPaintedFrames: 0,
    });
  }
  t.mock.method(globalThis, "requestAnimationFrame", (callback) => {
    const id = next++;
    raf.set(id, callback);
    return id;
  });
  t.mock.method(globalThis, "cancelAnimationFrame", (id) => raf.delete(id));
  const previous = globalThis.HTMLVideoElement;
  globalThis.HTMLVideoElement = Video;
  const video = new Video();
  const frames = new VideoFrames(video);
  t.after(() => {
    frames.destroy();
    globalThis.HTMLVideoElement = previous;
  });
  const seen = [];
  const receive = (now, metadata) => {
    seen.push({ now, ...metadata });
    frames.request(receive);
  };
  frames.request(receive);
  const tick = (now) => {
    const callbacks = [...raf.values()];
    raf.clear();
    for (const callback of callbacks) callback(now);
  };
  const paint = (count, now) => {
    video.mozPaintedFrames = count;
    tick(now);
  };
  return { video, frames, seen, tick, paint, raf, native, supportsVideoFrames };
}

// Node has no animation frame globals for mock.method to replace.
globalThis.requestAnimationFrame = () => {};
globalThis.cancelAnimationFrame = () => {};

test("Firefox uses painted frames despite repeated 40 ms media-clock values", async (t) => {
  const f = await fixture(t);
  assert.equal(f.supportsVideoFrames(), true);
  assert.equal(
    f.native.size,
    0,
    "native rVFC must never be requested on Firefox",
  );
  for (let frame = 1; frame <= 61; frame++) {
    const at = ((frame - 1) * 1000) / 30;
    f.video.currentTime = Math.floor(at / 40) * 0.04;
    f.paint(frame, at);
    f.tick(at + 1000 / 60);
  }
  assert.equal(f.seen.length, 61);
  assert.ok(
    f.seen.some((frame, i) => i && frame.mediaTime === f.seen[i - 1].mediaTime),
  );
  assert.ok(Math.abs(f.seen.at(-1).mozTiming.periodMs - 1000 / 30) < 0.01);
  assert.equal(f.raf.size, 1);
});

test("read-ahead and delayed presentation accounting do not duplicate a painted frame", async (t) => {
  const f = await fixture(t);
  f.paint(1, 0);
  f.video.mozParsedFrames += 100;
  f.tick(16);
  f.video.mozDecodedFrames += 20;
  f.tick(33);
  f.video.mozPresentedFrames += 1;
  f.tick(50);
  assert.equal(f.seen.length, 1);
  f.paint(2, 66);
  assert.equal(f.seen.length, 2);
});

test("Firefox works without native rVFC and can initialize a paused unpainted image", async (t) => {
  const f = await fixture(t);
  delete Object.getPrototypeOf(f.video).requestVideoFrameCallback;
  delete Object.getPrototypeOf(f.video).cancelVideoFrameCallback;
  assert.equal(f.supportsVideoFrames(), true);
  f.tick(0);
  assert.equal(
    f.seen.length,
    0,
    "decode read-ahead must not start playback callbacks",
  );
  f.video.paused = true;
  f.tick(16);
  f.tick(33);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].mozTiming.periodMs, 0);
  f.frames.destroy();
  assert.equal(f.raf.size, 0);
});

test("cadence averages refresh jitter and preserves gaps in painted counts", async (t) => {
  const f = await fixture(t);
  // 25 fps sampled at 60 Hz alternates two and three refreshes per picture.
  for (let frame = 1; frame <= 80; frame++) {
    if (frame === 20 || frame === 21) continue;
    const at = Math.ceil(((frame - 1) * 40) / (1000 / 60)) * (1000 / 60);
    f.paint(frame, at);
  }
  assert.equal(f.seen.length, 78);
  assert.equal(f.seen[19].presentedFrames - f.seen[18].presentedFrames, 3);
  assert.ok(Math.abs(f.seen.at(-1).mozTiming.periodMs - 40) < 1);
});

test("a paused seek inside one media-clock tick delivers the new still once", async (t) => {
  const f = await fixture(t);
  f.video.paused = true;
  f.paint(1, 0);
  f.video.seeking = true;
  f.video.dispatchEvent(new Event("seeking"));
  f.tick(16);
  assert.equal(f.seen.length, 1);
  f.video.seeking = false;
  f.video.dispatchEvent(new Event("seeked"));
  f.tick(33);
  f.tick(50);
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen[1].mediaTime, f.seen[0].mediaTime);
  assert.equal(f.seen[1].mozTiming.discontinuity, true);
  assert.equal(f.seen[1].mozTiming.periodMs, 0);
});

test("pause/resume and playback-rate changes exclude idle time from cadence", async (t) => {
  const f = await fixture(t);
  for (let i = 1; i <= 12; i++) f.paint(i, (i * 1000) / 30);
  f.video.paused = true;
  f.video.dispatchEvent(new Event("pause"));
  f.tick(3000);
  assert.equal(f.seen.length, 12);
  f.video.paused = false;
  f.video.playbackRate = 2;
  f.video.dispatchEvent(new Event("ratechange"));
  f.video.dispatchEvent(new Event("playing"));
  for (let i = 13; i <= 50; i++) f.paint(i, 3000 + ((i - 13) * 1000) / 60);
  assert.ok(Math.abs(f.seen.at(-1).mozTiming.periodMs - 1000 / 60) < 0.01);
});

test("counter resets, stalls and source replacement break frame history", async (t) => {
  const f = await fixture(t);
  f.paint(10, 0);
  f.paint(11, 33);
  assert.equal(f.seen.at(-1).mozTiming.discontinuity, false);
  f.paint(1, 66);
  assert.equal(f.seen.at(-1).mozTiming.discontinuity, true);
  f.paint(2, 1000);
  assert.equal(f.seen.at(-1).mozTiming.discontinuity, true);
  f.video.dispatchEvent(new Event("emptied"));
  f.video.readyState = 0;
  f.paint(0, 1033);
  assert.equal(f.seen.length, 4);
  f.video.readyState = 4;
  f.paint(1, 1066);
  assert.equal(f.seen.at(-1).mozTiming.discontinuity, true);
});

test("cancelling a pending poll stops it, and restart accepts the current picture", async (t) => {
  const f = await fixture(t);
  f.tick(0);
  f.tick(16);
  f.frames.cancel();
  assert.equal(f.raf.size, 0);
  f.paint(1, 33);
  assert.equal(f.seen.length, 0);
  f.frames.request((now, metadata) => f.seen.push({ now, ...metadata }));
  f.tick(50);
  assert.equal(f.seen.length, 1);
  assert.equal(f.raf.size, 0, "a frame request fires only once");
});

test("other browsers retain native frame metadata and cancellation", async (t) => {
  const f = await fixture(t, false);
  assert.equal(f.supportsVideoFrames(), true);
  assert.equal(f.raf.size, 0);
  const [id, callback] = [...f.native][0];
  f.native.delete(id);
  callback(20, {
    width: 720,
    height: 480,
    mediaTime: 1 / 30,
    presentedFrames: 1,
    expectedDisplayTime: 25,
  });
  assert.equal(f.seen[0].mediaTime, 1 / 30);
  assert.equal(f.seen[0].expectedDisplayTime, 25);
  assert.equal(f.seen[0].mozTiming, undefined);
  f.frames.cancel();
  assert.equal(f.native.size, 0);
});
