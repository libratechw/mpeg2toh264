/**
 * A deterministic stand-in for the two realms the deinterlacer runs across.
 *
 * The page and the Worker each get their own `vm` context, their own
 * `performance` with its own `timeOrigin`, and their own WebGL2 stub, so the
 * real `deinterlace.ts` and the real `worker.ts` execute unmodified and see two
 * clocks that genuinely do not share an origin. Everything that would be
 * asynchronous in a browser -- vsync, `requestVideoFrameCallback`, and the
 * `postMessage` transit between the realms -- is driven from one virtual clock,
 * so a run is reproducible and the transit delay is a dial rather than a race.
 *
 * What the harness records is which draw calls reached the drawing buffer and
 * when, on the virtual refresh grid. That is the scheduler's presentation
 * decision, not proof that a compositor put anything on a screen: no simulated
 * draw can establish physical presentation. It is what the schedule chooses,
 * and it is what a clock fault moves.
 *
 * The display is 60000/1001 Hz and the input 30000/1001 fps, which is the
 * broadcast case the filter is built for: one input frame lasts exactly two
 * refreshes, so `doubleRate` has exactly one field per refresh to fill and a
 * correct schedule has no gaps to argue about.
 */
import { createContext, runInContext } from "node:vm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";

export const REFRESH_MS = 1001 / 60;
/**
 * Where the virtual wall clock starts. Both realms' time origins sit below it,
 * so `performance.now()` is positive and large on either side -- which is the
 * condition under which an origin translation has to avoid cancellation.
 */
export const BASE_MS = 2_000_000;
export const FRAME_PERIOD_MS = 1001 / 30;

/** A virtual clock with an ordered event queue. Nothing here uses real time. */
export class Clock {
  now = 0;
  #queue = [];
  #seq = 0;

  at(time, fn) {
    this.#queue.push({ time, seq: this.#seq++, fn });
  }

  /** Run every event due up to `limit`, draining microtasks between them. */
  async runUntil(limit) {
    for (;;) {
      this.#queue.sort((a, b) => a.time - b.time || a.seq - b.seq);
      const next = this.#queue[0];
      if (!next || next.time > limit) {
        this.now = limit;
        return;
      }
      this.#queue.shift();
      this.now = next.time;
      next.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * Structured-clone semantics for the mock transport: plain data is copied so
 * the realms cannot alias it, while the transferables the protocol carries
 * (`VideoFrame`, `OffscreenCanvas`, `ImageBitmap`) cross by reference.
 */
function cloneMessage(value) {
  if (value === null || typeof value !== "object") return value;
  if (value.__transferable) return value;
  if (Array.isArray(value)) return value.map(cloneMessage);
  const copy = {};
  for (const [key, entry] of Object.entries(value))
    copy[key] = cloneMessage(entry);
  return copy;
}

const ENV_BOOTSTRAP = `
"use strict";
const __blitMark = "uniform bool uFlip";

class WebGL2RenderingContext {
  FRAMEBUFFER = 0x8d40;
  COLOR_ATTACHMENT0 = 0x8ce0;
  TEXTURE_2D = 0x0de1;
  TEXTURE0 = 0x84c0;
  RGBA = 0x1908;
  UNSIGNED_BYTE = 0x1401;
  RGBA32F = 0x8814;
  FLOAT = 0x1406;
  ALREADY_SIGNALED = 0x911a;
  TRIANGLES = 0x0004;
  NEAREST = 0x2600;
  CLAMP_TO_EDGE = 0x812f;
  TEXTURE_MIN_FILTER = 0x2801;
  TEXTURE_MAG_FILTER = 0x2800;
  TEXTURE_WRAP_S = 0x2802;
  TEXTURE_WRAP_T = 0x2803;
  FRAMEBUFFER_COMPLETE = 0x8cd5;
  VERTEX_SHADER = 0x8b31;
  FRAGMENT_SHADER = 0x8b30;
  COMPILE_STATUS = 0x8b81;
  LINK_STATUS = 0x8b82;
  QUERY_RESULT = 0x8866;
  QUERY_RESULT_AVAILABLE = 0x8867;

  #program = null;
  #framebuffer = null;
  #texture = null;
  #nextId = 1;

  getExtension(name) { return name === "EXT_color_buffer_float" ? {} : null; }
  createShader(kind) { return { kind, source: "" }; }
  shaderSource(shader, source) { shader.source = source; }
  compileShader() {}
  getShaderParameter() { return true; }
  getShaderInfoLog() { return ""; }
  deleteShader() {}
  createProgram() { return { id: this.#nextId++, fragment: "" }; }
  attachShader(program, shader) {
    if (shader.kind === this.FRAGMENT_SHADER) program.fragment = shader.source;
  }
  linkProgram() {}
  getProgramParameter(program) { return __host.programAvailable(__realm, program.fragment); }
  getProgramInfoLog() { return ""; }
  deleteProgram() {}
  getUniformLocation(program, name) { return { program: program.id, name }; }
  createTexture() { return { id: this.#nextId++ }; }
  bindTexture(target, texture) { this.#texture = texture; }
  texParameteri() {}
  texImage2D(target, level, format, width, height) {
    if (this.#texture) Object.assign(this.#texture, { format, width, height });
  }
  texSubImage2D() {}
  deleteTexture() {}
  createFramebuffer() { return { id: this.#nextId++ }; }
  bindFramebuffer(target, framebuffer) { this.#framebuffer = framebuffer; }
  framebufferTexture2D(target, attachment, textureTarget, texture) {
    this.#framebuffer.texture = texture;
  }
  checkFramebufferStatus() {
    return __host.framebufferComplete(__realm, this.#framebuffer.texture)
      ? this.FRAMEBUFFER_COMPLETE : 0;
  }
  deleteFramebuffer() {}
  useProgram(program) { this.#program = program; }
  activeTexture() {}
  uniform1i() {}
  uniform2i() {}
  viewport() {}
  readPixels() { __host.readback(__realm, this.#framebuffer.texture); }
  drawBuffers() {}
  createBuffer() { return { id: this.#nextId++ }; }
  bindBuffer() {}
  bufferData() {}
  deleteBuffer() {}
  fenceSync() { return {}; }
  deleteSync() {}
  clientWaitSync() { return this.ALREADY_SIGNALED; }
  getBufferSubData() {}
  flush() {}
  createQuery() { return { id: this.#nextId++ }; }
  deleteQuery() {}
  beginQuery() {}
  endQuery() {}
  getQueryParameter() { return false; }
  drawArrays() {
    __host.draw(__realm, {
      t: __host.now(),
      blit: (this.#program && this.#program.fragment || "").includes(__blitMark),
      toCanvas: this.#framebuffer === null,
      texture: this.#texture ? this.#texture.id : null,
    });
  }
}

class OffscreenCanvas {
  __transferable = true;
  #gl = null;
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
  }
  getContext(kind) {
    if (kind !== "webgl2") return null;
    this.#gl ??= new WebGL2RenderingContext();
    return this.#gl;
  }
  addEventListener() {}
  removeEventListener() {}
}

class VideoFrame {
  __transferable = true;
  static created = 0;
  static closed = 0;
  constructor(source, init) {
    this.timestamp = (init && init.timestamp) || 0;
    this.closes = 0;
    this.id = ++VideoFrame.created;
  }
  close() {
    this.closes++;
    VideoFrame.closed++;
    __host.frameClosed(this.id, this.closes);
  }
}

const performance = {
  timeOrigin: __timeOrigin,
  now: () => __host.now() - __timeOrigin,
};

function requestAnimationFrame(callback) {
  return __host.requestAnimationFrame(__realm, callback);
}
function cancelAnimationFrame(handle) {
  __host.cancelAnimationFrame(__realm, handle);
}
function createImageBitmap() {
  return Promise.resolve({ __transferable: true, close() {} });
}

Object.assign(globalThis, {
  WebGL2RenderingContext, OffscreenCanvas, VideoFrame, performance,
  requestAnimationFrame, cancelAnimationFrame, createImageBitmap,
});
`;

const PAGE_BOOTSTRAP = `
class FakeElement extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.className = "";
    this.children = [];
    this.parentElement = null;
    this.style = { cssText: "", visibility: "" };
    this.attributes = new Map();
    this.offsetWidth = 1920;
    this.offsetHeight = 1080;
    this.offsetLeft = 0;
    this.offsetTop = 0;
  }
  appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
  insertBefore(node, child) {
    node.parentElement = this;
    const index = child === null ? -1 : this.children.indexOf(child);
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    return node;
  }
  replaceWith(node) {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children[index] = node;
    node.parentElement = parent;
    this.parentElement = null;
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

class HTMLCanvasElement extends FakeElement {
  #gl = null;
  #offscreen = null;
  constructor() {
    super("canvas");
    this.width = 0;
    this.height = 0;
  }
  getContext(kind) {
    if (kind !== "webgl2") return null;
    this.#gl ??= new WebGL2RenderingContext();
    return this.#gl;
  }
  transferControlToOffscreen() {
    this.#offscreen ??= new OffscreenCanvas(this.width, this.height);
    return this.#offscreen;
  }
}

/**
 * A document, and the window that owns it.
 *
 * There is more than one of each: a document picture-in-picture window is a
 * second one, with its own animation frames and its own time origin, and the
 * point of the exercise is that an element can move between them while the
 * deinterlacer is running.
 */
class FakeDocument {
  #listeners = new Set();
  constructor(view) {
    this.defaultView = view;
    this.visibilityState = "visible";
  }
  addEventListener(type, listener) {
    if (type === "visibilitychange") this.#listeners.add(listener);
  }
  removeEventListener(type, listener) {
    if (type === "visibilitychange") this.#listeners.delete(listener);
  }
  /** How many listeners are attached, so a test can see them come and go. */
  get visibilityListeners() { return this.#listeners.size; }
  notifyVisibility() {
    for (const listener of [...this.#listeners]) listener();
  }
  createElement(tag) {
    const node = tag === "canvas" ? new HTMLCanvasElement() : new FakeElement(tag);
    node.ownerDocument = this;
    return node;
  }
}

class FakeWindow {
  constructor(name, clock) {
    this.name = name;
    this.performance = clock;
    this.document = new FakeDocument(this);
  }
  requestAnimationFrame(callback) {
    return __host.requestAnimationFrame(this.name, callback);
  }
  cancelAnimationFrame(handle) {
    __host.cancelAnimationFrame(this.name, handle);
  }
}

// The realm this module was loaded in: the opener. Its animation frames are
// the ones the bare global functions reach, which is what an implementation
// that never looks at the element's document is left holding.
const window0 = new FakeWindow("page", performance);
const document = window0.document;

/** Re-point a subtree at another document, as adoption does. */
function adoptSubtree(node, target) {
  node.ownerDocument = target;
  for (const child of node.children) adoptSubtree(child, target);
}

class ResizeObserver {
  constructor(callback) { this.callback = callback; __host.observer(this); }
  observe() {}
  disconnect() { this.callback = null; }
}

class FakeVideo extends FakeElement {
  #callback = null;
  #handle = 0;
  constructor() {
    super("video");
    this.currentTime = 0;
    this.playbackRate = 1;
    this.seeking = false;
    this.paused = false;
    this.ended = false;
    this.readyState = 4;
    this.videoWidth = 1440;
    this.videoHeight = 1080;
    this.totalVideoFrames = 0;
    // The document whose window's clock rVFC timestamps belong to. Adoption
    // replaces it, and the harness does the same.
    this.ownerDocument = document;
  }
  get buffered() { return { length: 1, start: () => 0, end: () => 3600 }; }
  getVideoPlaybackQuality() {
    return {
      creationTime: performance.now(),
      droppedVideoFrames: 0,
      totalVideoFrames: this.totalVideoFrames,
      corruptedVideoFrames: 0,
    };
  }
  requestVideoFrameCallback(callback) {
    this.#callback = callback;
    return ++this.#handle;
  }
  cancelVideoFrameCallback() { this.#callback = null; }
  /** Deliver one presented frame, as the browser's rVFC step would. */
  deliverFrame(now, metadata) {
    const callback = this.#callback;
    if (!callback) return false;
    this.#callback = null;
    callback(now, metadata);
    return true;
  }
}

class Worker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.id = __host.createWorker(this);
  }
  postMessage(data, transfer) { __host.pageToWorker(this.id, data, transfer || []); }
  terminate() { __host.terminateWorker(this.id); }
}

Object.assign(globalThis, {
  FakeElement, HTMLCanvasElement, document, ResizeObserver, FakeVideo, Worker,
  FakeWindow, FakeDocument, adoptSubtree, window0,
  makeView: (name, timeOrigin) =>
    new FakeWindow(name, { timeOrigin, now: () => __host.now() - timeOrigin }),
});
`;

const WORKER_BOOTSTRAP = `
const self = {
  onmessage: null,
  postMessage(data, transfer) { __host.workerToPage(data, transfer || []); },
  requestAnimationFrame(callback) { return __host.requestAnimationFrame(__realm, callback); },
  cancelAnimationFrame(handle) { __host.cancelAnimationFrame(__realm, handle); },
  close() { __host.closeWorker(); },
};
globalThis.self = self;
`;

async function bundleOne(entry, globalName) {
  const directory = await mkdtemp(join(tmpdir(), "yadif-clock-"));
  const outfile = join(directory, "bundle.js");
  try {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: "iife",
      globalName,
      platform: "neutral",
      target: "es2022",
      logLevel: "silent",
    });
    return await readFile(outfile, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Build the page and Worker bundles from one source tree. The same harness
 * runs against an archive of an earlier commit by pointing `root` at it.
 */
export async function buildBundles(root) {
  const source = join(root, "packages", "yadif", "src");
  const [page, worker] = await Promise.all([
    bundleOne(join(source, "deinterlace.ts"), "Yadif"),
    bundleOne(join(source, "worker.ts"), "YadifWorker"),
  ]);
  return { page, worker };
}

/**
 * One run: two realms, one virtual clock, a programmable transit delay.
 *
 * `transit(id)` gives the page->Worker delay in milliseconds for that frame
 * message. Every other message uses `CONTROL_TRANSIT_MS`, so the delay under
 * test is the only variable between runs.
 */
export async function run(bundles, options = {}) {
  const {
    vsyncs = 400,
    transit = () => 0.5,
    rendering = "worker",
    pageTimeOrigin = 1_000_000,
    workerTimeOrigin = 1_031_017,
    acquisitionTimeOrigin = null,
    displayTime = null,
    beforeFrame = null,
    beforeVsync = null,
    resourceAvailable = () => true,
    programAvailable = () => true,
    deinterlacerOptions = {},
    consoleOutput = console,
  } = options;

  const CONTROL_TRANSIT_MS = 0.2;
  const clock = new Clock();
  clock.now = BASE_MS;
  const draws = { page: [], worker: [] };
  const frameCloses = new Map();
  const stats = [];
  const failures = [];
  const sent = [];
  const acked = [];
  const commands = [];
  const allocations = [];
  const readbacks = [];
  let workerContext = null;
  let workerAlive = false;
  let pageWorker = null;
  let frameIndex = 0;
  let acquisitionOrigin = acquisitionTimeOrigin ?? pageTimeOrigin;

  /**
   * One animation-frame queue per window, plus the Worker's.
   *
   * A suspended queue keeps its callbacks rather than dropping them: a window
   * that has gone hidden does not run what was asked of it, and it does not
   * forget it either -- which is why the request has to be cancelled on that
   * same window, and why waiting for it to fire waits forever.
   */
  const raf = new Map();
  // Handles are unique across windows, so a cancellation aimed at the wrong
  // one cannot be mistaken for a correct one that happens to share a number.
  let nextHandle = 0;
  const queueFor = (name) => {
    let queue = raf.get(name);
    if (!queue)
      raf.set(name, (queue = { pending: new Map(), suspended: false }));
    return queue;
  };
  /** Every registration and cancellation, with the window it was made on. */
  const requests = [];
  const cancels = [];
  let observer = null;

  const host = {
    now: () => clock.now,
    programAvailable: (realm, fragment) =>
      programAvailable({ realm, fragment }),
    framebufferComplete(realm, texture) {
      const record = { realm, t: clock.now, ...texture };
      const complete = resourceAvailable(record);
      allocations.push({ ...record, complete });
      return complete;
    },
    readback(realm, texture) {
      readbacks.push({ realm, t: clock.now, ...texture });
    },
    draw(realm, record) {
      draws[realm].push(record);
    },
    frameClosed(id, count) {
      frameCloses.set(id, count);
    },
    observer(instance) {
      observer = instance;
    },
    requestAnimationFrame(realm, callback) {
      const queue = queueFor(realm);
      const handle = ++nextHandle;
      queue.pending.set(handle, callback);
      requests.push({ view: realm, handle, at: clock.now });
      return handle;
    },
    cancelAnimationFrame(realm, handle) {
      cancels.push({
        view: realm,
        handle,
        at: clock.now,
        known: queueFor(realm).pending.has(handle),
      });
      queueFor(realm).pending.delete(handle);
    },
    createWorker(worker) {
      pageWorker = worker;
      workerAlive = true;
      runInContext(bundles.worker, workerContext);
      return 1;
    },
    terminateWorker() {
      workerAlive = false;
    },
    closeWorker() {
      workerAlive = false;
    },
    pageToWorker(id, data) {
      const payload = cloneMessage(data);
      if (data.type !== "frame") commands.push({ t: clock.now, ...payload });
      // A transferred OffscreenCanvas belongs to the receiving realm, and the
      // Worker checks `gl instanceof WebGL2RenderingContext` against its own
      // class. Mint the canvas there rather than aliasing the page's.
      if (payload.type === "initialize")
        payload.canvas = runInContext(
          "new OffscreenCanvas(0, 0)",
          workerContext,
        );
      const delay =
        data.type === "frame" ? transit(data.id) : CONTROL_TRANSIT_MS;
      if (data.type === "frame")
        sent.push({ id: data.id, at: clock.now, delay });
      clock.at(clock.now + delay, () => {
        if (!workerAlive) return;
        workerContext.self.onmessage?.({ data: payload });
      });
    },
    workerToPage(data) {
      const payload = cloneMessage(data);
      if (data.type === "consumed") acked.push({ id: data.id, at: clock.now });
      clock.at(clock.now + CONTROL_TRANSIT_MS, () => {
        pageWorker?.onmessage?.({ data: payload });
      });
    },
  };

  const makeContext = (realm, timeOrigin, extra) => {
    const context = createContext({
      __host: host,
      __realm: realm,
      __timeOrigin: timeOrigin,
      console: consoleOutput,
      EventTarget,
      Event,
      CustomEvent,
      DOMException,
      queueMicrotask,
    });
    runInContext(ENV_BOOTSTRAP + extra, context);
    return context;
  };

  const pageContext = makeContext("page", pageTimeOrigin, PAGE_BOOTSTRAP);
  workerContext = makeContext("worker", workerTimeOrigin, WORKER_BOOTSTRAP);
  runInContext(bundles.page, pageContext);

  // The window the element is in. When only the acquisition clock is under
  // test the canvas stays with the opener and just the element's window
  // differs, which isolates the reported display time from the loop's owner;
  // the picture-in-picture cases below move both together, as adoption does.
  const views = new Map([["page", pageContext.window0]]);
  const view = (name, timeOrigin) => {
    let existing = views.get(name);
    if (!existing) {
      existing = pageContext.makeView(name, timeOrigin);
      views.set(name, existing);
    }
    return existing;
  };
  // Always its own window, even when the origins agree: a test that moves the
  // acquisition clock must not move the module's along with it.
  const acquisitionView = view("acquire", acquisitionOrigin);
  pageContext.__acquisitionDocument = acquisitionView.document;
  runInContext(
    `globalThis.__video = new FakeVideo();
     __video.ownerDocument = __acquisitionDocument;
     globalThis.__parent = new FakeElement("div");
     __parent.appendChild(__video);`,
    pageContext,
  );

  pageContext.__options = {
    rendering,
    workerUrl: "mock://worker",
    doubleRate: true,
    onStats: (snapshot) => stats.push({ t: clock.now, ...snapshot }),
    onFailure: (message) => failures.push({ t: clock.now, message }),
    ...deinterlacerOptions,
  };
  runInContext(
    `globalThis.__deinterlacer = new Yadif.Deinterlacer(__video, __options);
     __deinterlacer.scan = { interlaced: true, topFieldFirst: true };
     __deinterlacer.enabled = true;`,
    pageContext,
  );

  const video = pageContext.__video;
  /** Serve one animation frame from a window, unless it is suspended. */
  const serve = (name, timeOrigin) => {
    const queue = queueFor(name);
    if (queue.suspended) return;
    const pending = [...queue.pending.values()];
    queue.pending.clear();
    for (const callback of pending) callback(clock.now - timeOrigin);
  };

  /** Where each window's outstanding requests are, by window name. */
  const outstanding = () =>
    Object.fromEntries(
      [...raf].map(([name, queue]) => [name, [...queue.pending.keys()]]),
    );

  /** What the test drives: adoption, suspension, layout, frame delivery. */
  let deliverFrames = true;
  const control = {
    video,
    pageContext,
    views,
    outstanding,
    requests,
    cancels,
    view,
    /** Move the wrapper, the element and the canvas into another window. */
    adopt(name, timeOrigin) {
      const target = view(name, timeOrigin);
      pageContext.__target = target.document;
      runInContext(
        `adoptSubtree(__deinterlacer.container, __target);
         __video.ownerDocument = __target;
         __deinterlacer.canvas.ownerDocument = __target;`,
        pageContext,
      );
      acquisitionOrigin = target.performance.timeOrigin;
      return target;
    },
    /** A window that goes hidden stops serving frames and says so. */
    suspend(name) {
      queueFor(name).suspended = true;
      const target = views.get(name);
      if (!target) return;
      target.document.visibilityState = "hidden";
      target.document.notifyVisibility();
    },
    resume(name) {
      queueFor(name).suspended = false;
      const target = views.get(name);
      if (!target) return;
      target.document.visibilityState = "visible";
      target.document.notifyVisibility();
    },
    /** The layout observation the element's new box would produce. */
    layout() {
      observer?.callback?.();
    },
    frames(on) {
      deliverFrames = on;
    },
    /** Drive the deinterlacer's own lifecycle from inside its realm. */
    deinterlacer(script) {
      return runInContext(script, pageContext);
    },
    /** How many owner-change listeners each window's document carries. */
    visibilityListeners() {
      return Object.fromEntries(
        [...views].map(([name, window]) => [
          name,
          window.document.visibilityListeners,
        ]),
      );
    },
  };

  for (let vsync = 0; vsync < vsyncs; vsync++) {
    const at = BASE_MS + vsync * REFRESH_MS;
    clock.at(at, () => {
      beforeVsync?.(vsync, control);
      serve("worker", workerTimeOrigin);
      for (const [name, window] of views)
        serve(name, window.performance.timeOrigin);
      if (vsync % 2 !== 0 || !deliverFrames) return;
      const index = frameIndex++;
      const step = beforeFrame?.(index, control) ?? undefined;
      if (step?.acquisitionTimeOrigin !== undefined) {
        acquisitionOrigin = step.acquisitionTimeOrigin;
        acquisitionView.performance.timeOrigin = acquisitionOrigin;
      }
      const now = clock.now - acquisitionOrigin;
      video.currentTime = (index * FRAME_PERIOD_MS) / 1000;
      video.totalVideoFrames = index + 1;
      const expected = now + REFRESH_MS;
      video.deliverFrame(now, {
        width: 1440,
        height: 1080,
        mediaTime: (index * FRAME_PERIOD_MS) / 1000,
        presentedFrames: index + 1,
        expectedDisplayTime: displayTime
          ? displayTime(index, expected)
          : expected,
      });
    });
    await clock.runUntil(at + REFRESH_MS - 1e-6);
  }

  const realm = rendering === "main" ? "page" : "worker";
  return {
    draws: draws[realm],
    stats,
    failures,
    sent,
    acked,
    frameCloses,
    commands,
    allocations,
    readbacks,
    frames: frameIndex,
    videoFrames: {
      created: pageContext.VideoFrame.created,
      closed: pageContext.VideoFrame.closed,
    },
    /** Animation-frame bookkeeping, for the owner-change cases. */
    requests,
    cancels,
    outstanding: outstanding(),
    control,
    pageContext,
  };
}

/**
 * The scheduler's presentation decisions, as refresh indices.
 *
 * A blit to the drawing buffer is the scheduler electing to show a queued
 * picture at that refresh; a direct draw to the drawing buffer is the
 * unscheduled path. Neither is evidence that a compositor presented anything.
 */
export function presentations(draws) {
  return draws
    .filter((draw) => draw.toCanvas && draw.blit)
    .map((draw) => ({
      refresh: Math.round((draw.t - BASE_MS) / REFRESH_MS),
      texture: draw.texture,
    }));
}

export function directDraws(draws) {
  return draws.filter((draw) => draw.toCanvas && !draw.blit);
}

/** Refreshes between consecutive presentation decisions. */
export function gaps(schedule) {
  const out = [];
  for (let index = 1; index < schedule.length; index++)
    out.push(schedule[index].refresh - schedule[index - 1].refresh);
  return out;
}

/** How many refreshes in the covered span held no presentation decision. */
export function heldRefreshes(schedule) {
  return gaps(schedule).reduce((total, gap) => total + (gap - 1), 0);
}
