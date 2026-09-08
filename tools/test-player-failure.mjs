import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

class FakeVideo extends EventTarget {
  buffered = {
    length: 0,
    start: () => 0,
    end: () => 0,
  };
  currentTime = 0;
  disableRemotePlayback = false;
  seeking = false;
  loadCount = 0;
  src = "";
  srcObject = null;

  load() {
    this.loadCount++;
  }

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
}

class FakeWorker {
  static instances = [];

  messages = [];
  onerror = null;
  onmessage = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  notify(notification) {
    this.onmessage?.({ data: notification });
  }

  terminate() {}
}

function loadCommand(worker) {
  return worker.messages.filter(({ type }) => type === "load").at(-1);
}

const output = join(tmpdir(), `mpeg2toh264-player-failure-${process.pid}.mjs`);
const originalWorker = globalThis.Worker;
const originalCustomEvent = globalThis.CustomEvent;
globalThis.Worker = FakeWorker;
if (globalThis.CustomEvent === undefined) {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  };
}

let beforeOpened;
let afterOpened;
try {
  await build({
    entryPoints: ["packages/player/src/player.ts"],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "browser",
    plugins: [
      {
        name: "fake-worker-url",
        setup(build) {
          build.onResolve({ filter: /\?worker&url$/ }, (args) => ({
            path: args.path,
            namespace: "fake-worker-url",
          }));
          build.onLoad({ filter: /.*/, namespace: "fake-worker-url" }, () => ({
            contents: 'export default "fake-worker-url";',
            loader: "js",
          }));
        },
      },
    ],
  });
  const { Mpeg2TsPlayer } = await import(pathToFileURL(output));

  beforeOpened = new Mpeg2TsPlayer(new FakeVideo(), {
    mediaSource: "main",
  });
  const beforeStates = [];
  const beforeErrors = [];
  beforeOpened.addEventListener("statechange", ({ detail }) =>
    beforeStates.push(detail.state),
  );
  beforeOpened.addEventListener("error", ({ detail }) =>
    beforeErrors.push(detail.error),
  );
  const firstLoad = beforeOpened.load("https://example.test/first.ts");
  const firstWorker = FakeWorker.instances.at(-1);
  const firstId = loadCommand(firstWorker).id;

  firstWorker.notify({
    type: "error",
    id: firstId,
    message: "native code 3",
  });
  await assert.rejects(firstLoad, (error) => {
    assert.equal(error.message, "native code 3");
    return true;
  });
  assert.equal(beforeOpened.state, "error");
  assert.deepEqual(beforeStates, ["loading", "error"]);
  assert.equal(beforeErrors.length, 1);
  assert.equal(beforeErrors[0].message, "native code 3");
  assert.deepEqual(firstWorker.messages.at(-1), { type: "stop", id: firstId });

  firstWorker.notify({ type: "opened", id: firstId });
  firstWorker.notify({
    type: "error",
    id: firstId,
    message: "late native error",
  });
  assert.equal(beforeOpened.state, "error");
  assert.equal(beforeErrors.length, 1);

  const reusedLoad = beforeOpened.load("https://example.test/reused.ts");
  const reusedId = loadCommand(firstWorker).id;
  firstWorker.notify({ type: "opened", id: reusedId });
  await reusedLoad;
  assert.equal(beforeOpened.state, "converting");
  firstWorker.notify({
    type: "error",
    id: firstId,
    message: "late old-id error after reuse",
  });
  assert.equal(beforeOpened.state, "converting");
  assert.equal(beforeErrors.length, 1);

  afterOpened = new Mpeg2TsPlayer(new FakeVideo(), {
    mediaSource: "main",
  });
  const afterStates = [];
  const afterErrors = [];
  afterOpened.addEventListener("statechange", ({ detail }) =>
    afterStates.push(detail.state),
  );
  afterOpened.addEventListener("error", ({ detail }) =>
    afterErrors.push(detail.error),
  );
  const openedLoad = afterOpened.load("https://example.test/opened.ts");
  const secondWorker = FakeWorker.instances.at(-1);
  const openedId = loadCommand(secondWorker).id;
  secondWorker.notify({ type: "opened", id: openedId });
  await openedLoad;
  secondWorker.notify({
    type: "error",
    id: openedId,
    message: "failure after opened",
  });
  assert.equal(afterOpened.state, "error");
  assert.deepEqual(afterStates, ["loading", "converting", "error"]);
  assert.equal(afterErrors.length, 1);
  assert.equal(afterErrors[0].message, "failure after opened");
  assert.deepEqual(secondWorker.messages.at(-1), {
    type: "stop",
    id: openedId,
  });
  secondWorker.notify({ type: "opened", id: openedId });
  assert.equal(afterOpened.state, "error");
  assert.equal(afterErrors.length, 1);
} finally {
  beforeOpened?.destroy();
  afterOpened?.destroy();
  if (originalWorker === undefined) delete globalThis.Worker;
  else globalThis.Worker = originalWorker;
  if (originalCustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = originalCustomEvent;
  await unlink(output).catch(() => {});
}
