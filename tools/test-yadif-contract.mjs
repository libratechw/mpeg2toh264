// Public contracts exercised against the actual class; only DOM/WebGL/clock
// boundaries are fake. This does not assert GPU pixels or browser smoothness.
import assert from "node:assert/strict";
import { build } from "esbuild";
import ts from "typescript";
import { resolve } from "node:path";

const filename = resolve("tools/legacy-stats-contract.ts");
// The public producer shape at tsukumijima faf1464. New diagnostics must not
// force old wrappers, mocks or producers to invent information they lack.
const contents = `import type { DeinterlaceStats } from '../packages/yadif/src/deinterlace.js';
const legacy: DeinterlaceStats = {
 filtered: 0, missed: 0, dropped: 0, degraded: 0, discontinuities: 0,
 late: 0, queueResetted: 0, fps: 0, frameMs: 0, maxQueuedFields: 0,
 mode: 'video', match: 'c', combScore: 0, outputFps: 0,
 duplicateScore: 0, duplicateRunnerUp: 0,
};`;
const options = {
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};
const host = ts.createCompilerHost(options);
const read = host.readFile.bind(host);
host.readFile = (path) => (path === filename ? contents : read(path));
const diagnostics = ts.getPreEmitDiagnostics(
  ts.createProgram([filename], options, host),
);
assert.deepEqual(
  diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  [],
);

let now = 5000;
let floatAvailable = true;
let failFloatTarget = false;
let cpuReadbacks = 0;
let graphicsCost = 0;
let chargeDraws = false;
let lastTextureFormat;
let nextHandle = 0;
const raf = new Map();
class FakeGL {
  FRAMEBUFFER_COMPLETE = 1;
  RGBA32F = 34836;
  createTexture() {
    return {};
  }
  createFramebuffer() {
    return {};
  }
  texImage2D(...args) {
    lastTextureFormat = args[2];
  }
  checkFramebufferStatus() {
    return failFloatTarget && lastTextureFormat === this.RGBA32F ? 0 : 1;
  }
  readPixels() {
    cpuReadbacks++;
  }
  createProgram() {
    return {};
  }
  createShader() {
    return {};
  }
  getShaderParameter() {
    return true;
  }
  getProgramParameter() {
    return true;
  }
  getExtension(name) {
    return name === "EXT_color_buffer_float" && floatAvailable ? {} : null;
  }
  getUniformLocation() {
    return {};
  }
  getParameter() {
    return null;
  }
  drawArrays() {
    if (chargeDraws) {
      now += 0.1;
      graphicsCost += 0.1;
    }
  }
}
const gl = new Proxy(new FakeGL(), {
  get(target, key) {
    return key in target ? Reflect.get(target, key) : () => {};
  },
});
class FakeCanvas extends EventTarget {
  style = {};
  width = 0;
  height = 0;
  getContext() {
    return gl;
  }
  remove() {}
}
class FakeVideo extends EventTarget {
  paused = true;
  ended = false;
  seeking = false;
  readyState = 0;
  currentTime = 0;
  playbackRate = 1;
  videoWidth = 0;
  videoHeight = 0;
  buffered = { length: 0 };
  getVideoPlaybackQuality() {
    return { droppedVideoFrames: 0, totalVideoFrames: 0 };
  }
  requestVideoFrameCallback() {
    return 1;
  }
  cancelVideoFrameCallback() {}
}
globalThis.WebGL2RenderingContext = FakeGL;
globalThis.document = { createElement: () => new FakeCanvas() };
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (callback) => {
  const id = ++nextHandle;
  raf.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => raf.delete(id);
globalThis.CustomEvent ??= class extends Event {
  constructor(type, options) {
    super(type);
    this.detail = options?.detail;
  }
};
Object.defineProperty(globalThis, "performance", {
  configurable: true,
  value: { now: () => now },
});
const bundle = await build({
  entryPoints: ["packages/yadif/src/deinterlace.ts"],
  bundle: true,
  format: "esm",
  write: false,
});
const { Deinterlacer, createWorkerDeinterlacer } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

function frames(renderer, count = 80) {
  renderer.start();
  for (let i = 1; i <= count; i++) {
    now += 1000 / 30;
    renderer.ingestExternalFrame(
      now,
      {
        mediaTime: i / 30,
        presentedFrames: i,
        expectedDisplayTime: now,
        width: 64,
        height: 64,
      },
      {},
    );
  }
}

// An explicit caller-selected CPU fallback must survive later frames. A float
// target failure breaks GPU film detection while the RGBA8 CPU path works.
failFloatTarget = true;
const renderer = new Deinterlacer(new FakeVideo(), {
  rendering: "main",
  doubleRate: true,
  film: true,
});
const failures = [];
const reports = [];
renderer.addEventListener("failure", (event) => {
  failures.push(event.detail);
  if (
    /^(film detector unavailable|film detection failed)/.test(event.detail) &&
    renderer.film
  ) {
    renderer.film = false;
    renderer.autoFilm = true;
  }
});
renderer.addEventListener("stats", (event) => reports.push(event.detail));
frames(renderer);
assert.equal(failures.length, 1);
assert.equal(renderer.film, false);
assert.equal(renderer.autoFilm, true);
assert.ok(
  cpuReadbacks > 100,
  `CPU recovery stopped after ${cpuReadbacks} readbacks`,
);
assert.equal(reports.at(-1).filmError, null);
renderer.destroy();

// Both options preserve their requested values, but only CPU autoFilm runs.
// Inactive GPU capability must not become a requirement for the old API.
floatAvailable = false;
cpuReadbacks = 0;
const both = new Deinterlacer(new FakeVideo(), {
  rendering: "main",
  doubleRate: true,
  film: true,
  autoFilm: true,
});
const bothFailures = [];
both.addEventListener("failure", (event) => bothFailures.push(event.detail));
frames(both);
assert.equal(both.film, true);
assert.equal(both.autoFilm, true);
assert.ok(cpuReadbacks > 100);
assert.deepEqual(bothFailures, []);
// Withdrawing CPU selection activates the still-requested GPU engine; its
// real unavailability is reported, not silently swallowed.
both.autoFilm = false;
frames(both);
assert.ok(
  bothFailures.some((message) =>
    message.startsWith("film detector unavailable"),
  ),
);
const failureCount = bothFailures.length;
cpuReadbacks = 0;
both.autoFilm = true;
frames(both);
assert.ok(cpuReadbacks > 100);
assert.equal(bothFailures.length, failureCount);
both.destroy();
floatAvailable = true;

// A rendering report must account for all filtering and presentation work per
// input picture, regardless of whether one or two outputs are scheduled.
failFloatTarget = false;
for (const doubleRate of [false, true]) {
  const video = new FakeVideo();
  const renderer = createWorkerDeinterlacer(
    video,
    new FakeCanvas(),
    { doubleRate },
    assert.fail,
    () => {},
    requestAnimationFrame,
    cancelAnimationFrame,
  );
  let previousInput = 0;
  let previousCost = 0;
  let input = 0;
  let checked = 0;
  renderer.addEventListener("stats", (event) => {
    const expected = (graphicsCost - previousCost) / (input - previousInput);
    assert.ok(
      Math.abs(event.detail.frameMs - expected) < 1e-8,
      `${doubleRate}: ${event.detail.frameMs} != ${expected}`,
    );
    previousInput = input;
    previousCost = graphicsCost;
    checked++;
  });
  chargeDraws = true;
  graphicsCost = 0;
  renderer.start();
  const start = now;
  for (let tick = 0; tick < 180; tick++) {
    now = start + tick * (1000 / 60);
    for (const [id, callback] of [...raf]) {
      raf.delete(id);
      callback(now);
    }
    if (tick % 2 === 0) {
      input++;
      renderer.ingestExternalFrame(
        now,
        {
          mediaTime: input / 30,
          presentedFrames: input,
          expectedDisplayTime: now,
          width: 64,
          height: 64,
        },
        {},
      );
    }
  }
  assert.ok(checked >= 2);
  chargeDraws = false;
  renderer.destroy();
  assert.equal(raf.size, 0);
}
console.log(
  "yadif public stats, CPU recovery and per-input CPU accounting: pass",
);
