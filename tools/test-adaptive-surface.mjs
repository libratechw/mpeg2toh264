#!/usr/bin/env node
// Bounded adaptive 1x1 surface trial: lifecycle and cadence behaviour.
//
// Run with:
//   node --experimental-strip-types tools/test-adaptive-surface.mjs
//
// No dependencies beyond Node itself. The test reads the real
// `packages/yadif/src/*.ts` sources, copies them to a temp dir with only the
// `.js` -> `.ts` specifier rewrite Node's type-stripping needs (bundlers do
// the same), and drives `Deinterlacer` through mocked DOM/rAF/timers.
//
// Each case asserts an observable side effect -- the page-owned surface
// element appearing, toggling, or being removed, and its 250 ms timer being
// armed or cleared -- so a regression in activation, bounded rejection,
// successful latching, or cleanup fails here.

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Load the real implementation sources without a bundler.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "packages", "yadif", "src");
const STAGE = join(tmpdir(), `mpeg2toh264-surface-test-${process.pid}`);
mkdirSync(STAGE, { recursive: true });
for (const file of ["shader.ts", "ivtc.ts", "worker-protocol.ts"]) {
  copyFileSync(join(SRC, file), join(STAGE, file));
}
{
  const source = readFileSync(join(SRC, "deinterlace.ts"), "utf8").replaceAll(
    `"./worker-protocol.js"`,
    `"./worker-protocol.ts"`,
  );
  const rewritten = source
    .replaceAll(`from "./shader.js"`, `from "./shader.ts"`)
    .replaceAll(`from "./ivtc.js"`, `from "./ivtc.ts"`);
  writeFileSync(join(STAGE, "deinterlace.ts"), rewritten);
}

// ---------------------------------------------------------------------------
// Fake clock, rAF, and timers.
// ---------------------------------------------------------------------------

let fakeNow = 1_000_000;
const SLOW_GAP = 1000 / 30; // ~33.3 ms: the stuck page cadence.
const FAST_GAP = 1000 / 60; // ~16.7 ms: recovered ~60 Hz page cadence.

let rafNextId = 1;
const rafQueue = new Map();
const origRaf = globalThis.requestAnimationFrame;
const origCancelRaf = globalThis.cancelAnimationFrame;
globalThis.requestAnimationFrame = (callback) => {
  const id = rafNextId++;
  rafQueue.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue.delete(id);
};

function tickRaf(now) {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  for (const callback of pending) callback(now);
}

function advanceRaf(gapMs, count) {
  for (let i = 0; i < count; i++) {
    fakeNow += gapMs;
    tickRaf(fakeNow);
  }
}

let intervalNextId = 1;
const intervals = new Map();
globalThis.setInterval = (callback, ms, ...args) => {
  const id = intervalNextId++;
  intervals.set(id, { callback: () => callback(...args), ms });
  return id;
};
globalThis.clearInterval = (id) => {
  intervals.delete(id);
};

function fireIntervals() {
  for (const { callback } of [...intervals.values()]) callback();
}

// performance.now drives trial and cooldown timestamps in the implementation.
globalThis.performance.now = () => fakeNow;

// ---------------------------------------------------------------------------
// Fake DOM, GL, Worker, and video.
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.className = "";
    this._attrs = new Map();
    this._listeners = new Map();
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.offsetLeft = 0;
    this.offsetTop = 0;
  }
  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }
  removeAttribute(name) {
    this._attrs.delete(name);
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(node, child) {
    if (child === null || child === undefined) {
      if (node.parentElement) {
        const previous = node.parentElement;
        const at = previous.children.indexOf(node);
        if (at >= 0) previous.children.splice(at, 1);
      }
      node.parentElement = this;
      this.children.push(node);
      return node;
    }
    const index = this.children.indexOf(child);
    if (index < 0) {
      throw new Error("insertBefore: reference child not found");
    }
    if (node === child) return node;
    if (node.parentElement) {
      const previous = node.parentElement;
      const at = previous.children.indexOf(node);
      if (at >= 0) previous.children.splice(at, 1);
    }
    const position = this.children.indexOf(child);
    this.children.splice(position, 0, node);
    node.parentElement = this;
    return node;
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }
  replaceWith(other) {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) {
      parent.children[index] = other;
      other.parentElement = parent;
    }
    this.parentElement = null;
  }
  addEventListener(type, callback) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this._listeners.get(type)?.delete(callback);
  }
}

function makeFakeGL() {
  const target = {
    createProgram: () => ({}),
    createShader: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => null,
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    checkFramebufferStatus: () => 1,
    getExtension: () => null,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
  };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      // Numeric GL constants are SCREAMING_CASE; everything else is a method.
      if (typeof p === "string" && /^[A-Z][A-Z0-9_]*$/.test(p)) return 1;
      return (..._args) => ({});
    },
  });
}

class FakeCanvas extends FakeElement {
  constructor() {
    super("canvas");
    this.width = 0;
    this.height = 0;
  }
  getContext(_kind, _attrs) {
    return makeFakeGL();
  }
  transferControlToOffscreen() {
    return { fakeOffscreen: true };
  }
}

class FakeDocument {
  constructor() {
    this.hidden = false;
    this.visibilityState = "visible";
    this.body = new FakeElement("body");
    this._listeners = new Map();
  }
  createElement(tag) {
    if (tag === "canvas") return new FakeCanvas();
    return new FakeElement(tag);
  }
  addEventListener(type, callback) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this._listeners.get(type)?.delete(callback);
  }
  dispatchEvent(event) {
    for (const callback of [...(this._listeners.get(event.type) ?? [])]) {
      callback(event);
    }
    return true;
  }
  setHidden(hidden) {
    this.hidden = hidden;
    this.visibilityState = hidden ? "hidden" : "visible";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const fakeWorkers = [];
class FakeWorker {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    fakeWorkers.push(this);
  }
  postMessage(message, transfer) {
    this.posted.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
}

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.paused = false;
    this.ended = false;
    this.seeking = false;
    this.currentTime = 0;
    this.playbackRate = 1;
    this.readyState = 4;
    this.videoWidth = 640;
    this.videoHeight = 480;
    this.offsetWidth = 640;
    this.offsetHeight = 480;
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.parentElement = null;
    this.buffered = {
      length: 0,
      start: () => {
        throw new Error("empty");
      },
      end: () => {
        throw new Error("empty");
      },
    };
    this._rvfcNext = 1;
    this._rvfc = new Map();
  }
  getVideoPlaybackQuality() {
    return {
      creationTime: fakeNow,
      droppedVideoFrames: 0,
      totalVideoFrames: 0,
      corruptedVideoFrames: 0,
    };
  }
  requestVideoFrameCallback(callback) {
    const id = this._rvfcNext++;
    this._rvfc.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id) {
    this._rvfc.delete(id);
  }
}

globalThis.document = new FakeDocument();
globalThis.Worker = FakeWorker;
globalThis.VideoFrame = class {
  close() {}
};
globalThis.OffscreenCanvas = class {};
globalThis.HTMLCanvasElement = class {};
globalThis.HTMLCanvasElement.prototype.transferControlToOffscreen =
  function () {
    return { fake: true };
  };
globalThis.HTMLVideoElement = class {};
globalThis.WebGL2RenderingContext = class {};
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { Deinterlacer } = await import(
  pathToFileURL(join(STAGE, "deinterlace.ts")).href
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function surfaceElements(root = globalThis.document.body) {
  const found = [];
  const visit = (node) => {
    if (node.getAttribute?.("data-mpeg2toh264-surface") === "true") {
      found.push(node);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return found;
}

/**
 * Parent the fake video in the page like KonomiTV does, so Deinterlacer takes
 * the real wrapper path instead of the parentless body fallback.
 */
function attachVideo(video) {
  const host = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(host);
  host.appendChild(video);
  return host;
}

function resetHarness() {
  rafQueue.clear();
  intervals.clear();
  fakeWorkers.length = 0;
  globalThis.document.body.children.length = 0;
  globalThis.document.hidden = false;
  globalThis.document.visibilityState = "visible";
  fakeNow = 1_000_000;
}

/**
 * Eligible shape: running, visible, interlaced, double-rate, Worker active.
 * The video is parented in the page, so every case exercises the real
 * mounted-wrapper path (and the surface's fullscreen container), not only
 * the parentless body fallback.
 */
function createEligible(options = {}) {
  const video = new FakeVideo();
  const host = attachVideo(video);
  const deinterlacer = new Deinterlacer(video, {
    rendering: options.rendering ?? "auto",
    workerUrl: "fake-worker.js",
    doubleRate: options.doubleRate ?? true,
    autoFilm: options.autoFilm ?? false,
  });
  deinterlacer.scan = options.scan ?? {
    interlaced: true,
    topFieldFirst: true,
  };
  if (options.paused) video.paused = true;
  if (options.ended) video.ended = true;
  deinterlacer.enabled = true;
  // The main-thread renderer never creates a Worker, and progressive content
  // never starts playback, so neither has a Worker to ready. Every other
  // shape must reach the active Worker backend the trial requires.
  const scan = options.scan ?? { interlaced: true, topFieldFirst: true };
  const expectWorker =
    (options.rendering ?? "auto") !== "main" && scan.interlaced !== false;
  if (!expectWorker) {
    assert.equal(fakeWorkers.length, 0, "expected no Worker to be created");
  } else {
    assert.ok(fakeWorkers.length > 0, "expected a Worker to be created");
    fakeWorkers.at(-1).onmessage({ data: { type: "ready" } });
    // Worker cadence is unknown until the first stats notification, and the
    // trial requires confirmed video cadence, so report it here. Cases that
    // need a different cadence history send their own stats afterwards.
    fakeWorkers.at(-1).onmessage({ data: workerStats("video") });
  }
  return { video, deinterlacer, host };
}

/** Normal Player shape: scan metadata arrives only through videoTimeline. */
function createTimelineEligible(timeline, currentTime = 0) {
  const video = new FakeVideo();
  video.currentTime = currentTime;
  const host = attachVideo(video);
  const deinterlacer = new Deinterlacer(video, {
    rendering: "auto",
    workerUrl: "fake-worker.js",
    doubleRate: true,
  });
  assert.equal(deinterlacer.scan, null, "direct scan must remain unset");
  deinterlacer.videoTimeline = timeline;
  deinterlacer.enabled = true;
  assert.ok(fakeWorkers.length > 0, "timeline playback must create a Worker");
  fakeWorkers.at(-1).onmessage({ data: { type: "ready" } });
  fakeWorkers.at(-1).onmessage({ data: workerStats("video") });
  return { video, deinterlacer, host };
}

function workerStats(mode) {
  return {
    type: "stats",
    stats: {
      filtered: 0,
      missed: 0,
      degraded: 0,
      discontinuities: 0,
      late: 0,
      queueResetted: 0,
      fps: 60,
      frameMs: 1,
      maxQueuedFields: 0,
      mode,
      match: "c",
      combScore: 0,
      outputFps: 60,
      duplicateScore: Infinity,
      duplicateRunnerUp: Infinity,
    },
  };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

// 1. A short slow spell does nothing; a stable ~30 Hz spell starts a trial
// with a real 250 ms surface toggle.
resetHarness();
{
  const { deinterlacer } = createEligible();
  advanceRaf(SLOW_GAP, 10);
  assert.equal(
    surfaceElements().length,
    0,
    "a transient slow spell must not start a trial",
  );
  advanceRaf(SLOW_GAP, 40);
  const surfaces = surfaceElements();
  assert.equal(surfaces.length, 1, "stable 30 Hz cadence must start a trial");
  assert.equal(intervals.size, 1, "trial must arm its toggle timer");
  assert.equal(
    [...intervals.values()][0].ms,
    250,
    "trial must toggle every 250 ms",
  );
  const element = surfaces[0];
  assert.ok(
    element.style.cssText.includes("1px"),
    "surface must be a 1x1 pixel element",
  );
  assert.ok(
    element.style.cssText.includes("pointer-events:none"),
    "surface must not intercept input",
  );
  assert.ok(
    !element.style.cssText.includes("display:none") &&
      !element.style.cssText.includes("visibility:hidden"),
    "surface must actually reach composition",
  );
  const before = `${element.style.backgroundColor}|${element.style.transform}`;
  fireIntervals();
  const after = `${element.style.backgroundColor}|${element.style.transform}`;
  assert.notEqual(
    before,
    after,
    "the 250 ms timer must visibly update the surface, not no-op",
  );
  deinterlacer.destroy();
}

// 1c. Mounted-wrapper path used by KonomiTV: with the video parented, the
// surface must live inside deinterlacer.container so fullscreen includes it,
// and destroy must remove both surface and wrapper cleanly.
resetHarness();
{
  const { video, deinterlacer, host } = createEligible();
  assert.notEqual(
    deinterlacer.container,
    video,
    "a parented video must be wrapped on start",
  );
  assert.equal(
    deinterlacer.container.parentElement,
    host,
    "the wrapper must sit where the video was",
  );
  advanceRaf(SLOW_GAP, 50);
  const surfaces = surfaceElements();
  assert.equal(surfaces.length, 1, "trial must have started");
  assert.equal(
    surfaces[0].parentElement,
    deinterlacer.container,
    "the surface must live inside the fullscreen container",
  );
  const wrapper = deinterlacer.container;
  deinterlacer.destroy();
  assert.equal(surfaceElements().length, 0, "destroy must remove the surface");
  assert.equal(intervals.size, 0, "destroy must clear the toggle timer");
  assert.equal(wrapper.parentElement, null, "destroy must remove the wrapper");
  assert.ok(
    host.children.includes(video) && !host.children.includes(wrapper),
    "destroy must restore the video to its host",
  );
}

// 1b. Worker cadence is unknown until the first stats notification, so even a
// long slow spell -- e.g. a 24 fps film section -- must not start a trial
// before any stats; after a video confirmation the same spell may start one.
resetHarness();
{
  const video = new FakeVideo();
  attachVideo(video);
  const deinterlacer = new Deinterlacer(video, {
    rendering: "auto",
    workerUrl: "fake-worker.js",
    doubleRate: true,
  });
  deinterlacer.scan = { interlaced: true, topFieldFirst: true };
  deinterlacer.enabled = true;
  assert.ok(fakeWorkers.length > 0, "expected a Worker to be created");
  fakeWorkers.at(-1).onmessage({ data: { type: "ready" } });
  advanceRaf(SLOW_GAP, 80);
  assert.equal(
    surfaceElements().length,
    0,
    "no trial before the first Worker stats notification",
  );
  assert.equal(
    intervals.size,
    0,
    "no toggle timer before cadence is confirmed",
  );
  fakeWorkers.at(-1).onmessage({ data: workerStats("video") });
  advanceRaf(SLOW_GAP, 50);
  assert.equal(
    surfaceElements().length,
    1,
    "confirmed video cadence may start a trial",
  );
  deinterlacer.destroy();
}

// 1d. Normal Player integration supplies scan metadata only through the video
// timeline. The page-side surface decision must select the same current state
// as the Worker without requiring the standalone scan setter.
resetHarness();
{
  const { deinterlacer } = createTimelineEligible([
    { start: 0, scan: { interlaced: true, topFieldFirst: true } },
  ]);
  advanceRaf(SLOW_GAP, 50);
  assert.equal(
    surfaceElements().length,
    1,
    "timeline-only interlaced playback must start a trial",
  );
  deinterlacer.destroy();
}

resetHarness();
{
  const { deinterlacer } = createTimelineEligible([
    { start: 0, scan: { interlaced: false, topFieldFirst: true } },
  ]);
  advanceRaf(SLOW_GAP, 60);
  assert.equal(
    surfaceElements().length,
    0,
    "timeline-only progressive playback must not start a trial",
  );
  deinterlacer.destroy();
}

resetHarness();
{
  const { video, deinterlacer } = createTimelineEligible(
    [
      { start: 0, scan: { interlaced: true, topFieldFirst: true } },
      { start: 10, scan: { interlaced: false, topFieldFirst: true } },
    ],
    9.5,
  );
  advanceRaf(SLOW_GAP, 50);
  assert.equal(
    surfaceElements().length,
    1,
    "pre-boundary interlaced state must be eligible",
  );
  video.currentTime = 10;
  advanceRaf(SLOW_GAP, 1);
  assert.equal(
    surfaceElements().length,
    0,
    "boundary progressive state must stop the trial",
  );
  deinterlacer.destroy();
}

for (const timeline of [
  [{ start: 10, scan: { interlaced: true, topFieldFirst: true } }],
  [{ start: 0 }],
]) {
  resetHarness();
  const { deinterlacer } = createTimelineEligible(timeline, 0);
  advanceRaf(SLOW_GAP, 60);
  assert.equal(
    surfaceElements().length,
    0,
    "unknown timeline scan must not start a trial",
  );
  deinterlacer.destroy();
}

// 2. Without recovery the bounded trial is removed and cools down; after the
// cooldown a new stable spell may try again. A later natural recovery cannot
// retroactively make the rejected trial look successful.
resetHarness();
{
  const { deinterlacer } = createEligible();
  advanceRaf(SLOW_GAP, 50);
  assert.equal(surfaceElements().length, 1, "trial must have started");
  advanceRaf(SLOW_GAP, 100);
  assert.equal(
    surfaceElements().length,
    0,
    "a trial with no 60 Hz recovery must be removed",
  );
  assert.equal(intervals.size, 0, "rejected trial must clear its timer");
  advanceRaf(FAST_GAP, 60);
  assert.equal(
    surfaceElements().length,
    0,
    "fast cadence after the deadline must not latch a removed surface",
  );
  advanceRaf(SLOW_GAP, 50);
  assert.equal(
    surfaceElements().length,
    0,
    "cooldown must suppress an immediate retry on a true 30 Hz cadence",
  );
  fakeNow += 5 * 60 * 1000 + 1000;
  advanceRaf(SLOW_GAP, 50);
  assert.equal(
    surfaceElements().length,
    1,
    "bounded cooldown must eventually allow a fresh trial",
  );
  deinterlacer.destroy();
}

// 3. Sustained ~60 Hz during the trial latches the surface past its bound;
// a brief fast blip followed by slow cadence does not latch.
resetHarness();
{
  const { deinterlacer } = createEligible();
  advanceRaf(SLOW_GAP, 50);
  assert.equal(surfaceElements().length, 1, "trial must have started");
  advanceRaf(FAST_GAP, 60);
  assert.equal(
    surfaceElements().length,
    1,
    "sustained 60 Hz must keep the surface",
  );
  advanceRaf(FAST_GAP, 400);
  assert.equal(
    surfaceElements().length,
    1,
    "a latched surface must survive past the trial bound",
  );
  assert.equal(intervals.size, 1, "latched surface must keep its timer");
  deinterlacer.destroy();
}
resetHarness();
{
  const { deinterlacer } = createEligible();
  advanceRaf(SLOW_GAP, 50);
  advanceRaf(FAST_GAP, 10);
  advanceRaf(SLOW_GAP, 200);
  assert.equal(
    surfaceElements().length,
    0,
    "a brief fast blip must not latch the surface",
  );
  deinterlacer.destroy();
}

// 3c. Seeking is a transient pipeline transition, not evidence of a stuck
// compositor cadence. It must neither start nor complete a trial. A surface
// already proven in this playback session stays active across the seek.
resetHarness();
{
  const { video, deinterlacer } = createEligible();
  video.seeking = true;
  video.dispatchEvent(new Event("seeking"));
  advanceRaf(SLOW_GAP, 60);
  assert.equal(
    surfaceElements().length,
    0,
    "slow page cadence during a seek must not start a trial",
  );
  video.seeking = false;
  video.dispatchEvent(new Event("seeked"));
  advanceRaf(SLOW_GAP, 50);
  assert.equal(
    surfaceElements().length,
    1,
    "post-seek playback must prove a fresh slow window",
  );
  deinterlacer.destroy();
}

resetHarness();
{
  const { video, deinterlacer } = createEligible();
  advanceRaf(SLOW_GAP, 50);
  assert.equal(surfaceElements().length, 1, "trial must have started");
  video.seeking = true;
  video.dispatchEvent(new Event("seeking"));
  assert.equal(
    surfaceElements().length,
    0,
    "seeking must abort an unproven trial immediately",
  );
  assert.equal(intervals.size, 0, "aborted trial must clear its timer");
  video.seeking = false;
  video.dispatchEvent(new Event("seeked"));
  advanceRaf(SLOW_GAP, 50);
  assert.equal(
    surfaceElements().length,
    1,
    "an aborted seek trial must not impose a cooldown",
  );
  deinterlacer.destroy();
}

resetHarness();
{
  const { video, deinterlacer } = createEligible();
  advanceRaf(SLOW_GAP, 50);
  advanceRaf(FAST_GAP, 60);
  assert.equal(surfaceElements().length, 1, "surface must be latched");
  video.seeking = true;
  video.dispatchEvent(new Event("seeking"));
  advanceRaf(SLOW_GAP, 60);
  assert.equal(
    surfaceElements().length,
    1,
    "a proven surface must remain active across the seek",
  );
  assert.equal(intervals.size, 1, "latched surface must keep its timer");
  video.seeking = false;
  video.dispatchEvent(new Event("seeked"));
  deinterlacer.destroy();
}

// 3b. A film report arriving mid-trial aborts it without a cooldown penalty:
// surface and timer go away on the next page frame, and a later video report
// may start a fresh trial.
resetHarness();
{
  const { deinterlacer } = createEligible();
  advanceRaf(SLOW_GAP, 50);
  assert.equal(surfaceElements().length, 1, "trial must have started");
  fakeWorkers.at(-1).onmessage({ data: workerStats("film") });
  advanceRaf(SLOW_GAP, 1);
  assert.equal(
    surfaceElements().length,
    0,
    "film stats must abort a running trial on the next frame",
  );
  assert.equal(intervals.size, 0, "aborted trial must clear its timer");
  fakeWorkers.at(-1).onmessage({ data: workerStats("video") });
  advanceRaf(SLOW_GAP, 50);
  assert.equal(
    surfaceElements().length,
    1,
    "an aborted trial sets no cooldown: video may retry",
  );
  deinterlacer.destroy();
}

// 4. Teardown: stop, destroy, pause, hide, progressive scan, single-rate, and
// Worker failure must all remove the surface and its timer.
for (const teardown of [
  "stop",
  "destroy",
  "pause",
  "hidden",
  "progressive",
  "singleRate",
  "workerFailed",
]) {
  resetHarness();
  const { video, deinterlacer } = createEligible();
  advanceRaf(SLOW_GAP, 50);
  assert.equal(surfaceElements().length, 1, `${teardown}: trial must start`);
  if (teardown === "stop") deinterlacer.stop();
  else if (teardown === "destroy") deinterlacer.destroy();
  else if (teardown === "pause") {
    video.paused = true;
    video.dispatchEvent(new Event("pause"));
  } else if (teardown === "hidden") {
    globalThis.document.setHidden(true);
  } else if (teardown === "progressive") {
    deinterlacer.scan = { interlaced: false, topFieldFirst: true };
  } else if (teardown === "singleRate") {
    deinterlacer.doubleRate = false;
  } else {
    fakeWorkers.at(-1).onmessage({
      data: { type: "failed", message: "boom" },
    });
  }
  advanceRaf(SLOW_GAP, 3);
  assert.equal(
    surfaceElements().length,
    0,
    `${teardown} must remove the surface`,
  );
  assert.equal(intervals.size, 0, `${teardown} must clear the toggle timer`);
  if (teardown !== "destroy") deinterlacer.destroy();
  globalThis.document.setHidden(false);
}

// 5. Never eligible, never a surface: main-thread renderer, film cadence,
// progressive content, paused/ended video, and hidden pages.
resetHarness();
{
  const { deinterlacer } = createEligible({ rendering: "main" });
  advanceRaf(SLOW_GAP, 60);
  assert.equal(
    surfaceElements().length,
    0,
    "main-thread rendering must never start a trial",
  );
  deinterlacer.destroy();
}
resetHarness();
{
  const { deinterlacer } = createEligible();
  fakeWorkers.at(-1).onmessage({ data: workerStats("film") });
  advanceRaf(SLOW_GAP, 60);
  assert.equal(
    surfaceElements().length,
    0,
    "film cadence must never start a trial",
  );
  deinterlacer.destroy();
}
resetHarness();
{
  const { deinterlacer } = createEligible({
    scan: { interlaced: false, topFieldFirst: true },
  });
  advanceRaf(SLOW_GAP, 60);
  assert.equal(
    surfaceElements().length,
    0,
    "progressive content must never start a trial",
  );
  deinterlacer.destroy();
}
resetHarness();
{
  const video = new FakeVideo();
  video.paused = true;
  attachVideo(video);
  const deinterlacer = new Deinterlacer(video, {
    rendering: "auto",
    workerUrl: "fake-worker.js",
    doubleRate: true,
  });
  deinterlacer.scan = { interlaced: true, topFieldFirst: true };
  deinterlacer.enabled = true;
  fakeWorkers.at(-1).onmessage({ data: { type: "ready" } });
  advanceRaf(SLOW_GAP, 60);
  assert.equal(
    surfaceElements().length,
    0,
    "paused video must never start a trial",
  );
  deinterlacer.destroy();
}
resetHarness();
{
  globalThis.document.setHidden(true);
  const { deinterlacer } = createEligible();
  advanceRaf(SLOW_GAP, 60);
  assert.equal(
    surfaceElements().length,
    0,
    "hidden pages must never start a trial",
  );
  deinterlacer.destroy();
  globalThis.document.setHidden(false);
}

globalThis.requestAnimationFrame = origRaf;
globalThis.cancelAnimationFrame = origCancelRaf;

console.log("adaptive surface: all cases passed");
