// Public contracts exercised against the actual class; only DOM/WebGL/clock
// boundaries are fake. This does not assert GPU pixels or browser smoothness.
import assert from "node:assert/strict";
import { build } from "esbuild";

let now = 5000;
let graphicsCost = 0;
let chargeDraws = false;
let nextHandle = 0;
const raf = new Map();
class FakeGL {
  FRAMEBUFFER_COMPLETE = 1;
  createTexture() {
    return {};
  }
  createFramebuffer() {
    return {};
  }
  checkFramebufferStatus() {
    return this.FRAMEBUFFER_COMPLETE;
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
  getExtension() {
    return null;
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
const { createWorkerDeinterlacer } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

// A rendering report must account for all filtering and presentation work per
// input picture, regardless of whether one or two outputs are scheduled.
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
console.log("yadif per-input CPU accounting: pass");
