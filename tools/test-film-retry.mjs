// Public retries across the real page and Worker engines. Only WebGL resource
// availability is faked; success means analysis resumes, not pixel correctness.
import assert from "node:assert/strict";
import { BASE_MS, buildBundles, run } from "./yadif-clock-harness.mjs";

const bundles = await buildBundles(process.cwd());
const isTarget = (resource) => resource.format === 0x8814;
let checked = 0;

async function exercise(rendering, trigger, restored) {
  const label = `${rendering}/${trigger}/${restored ? "recovered" : "still broken"}`;
  let available = false;
  let control;
  let retried = false;
  let attemptsAtRetry;
  let targetAttempts = 0;
  let settledAttempts;
  let injected = false;
  const events = [];
  const callbacks = [];
  const realm = rendering === "main" ? "page" : "worker";
  const retry = () => {
    available = restored;
    retried = true;
    attemptsAtRetry = targetAttempts;
    switch (trigger) {
      case "event":
      case "callback":
      case "later":
        control.deinterlacer("__deinterlacer.film = true");
        break;
      case "parity":
        control.deinterlacer(
          "__deinterlacer.scan = { interlaced: true, topFieldFirst: false }",
        );
        break;
      case "interlacing":
        control.deinterlacer(
          "__deinterlacer.scan = { interlaced: false, topFieldFirst: true }",
        );
        break;
      case "timeline":
        control.deinterlacer(
          "__deinterlacer.videoTimeline = [{ start: 0, scan: { interlaced: true, topFieldFirst: false } }]",
        );
        break;
      case "start":
        control.deinterlacer("__deinterlacer.stop(); __deinterlacer.start()");
        break;
      case "resize":
        control.deinterlacer(
          "__deinterlacer.videoTimeline = [{ start: 0, codedSize: { width: 1280, height: 720 }, scan: { interlaced: true, topFieldFirst: true } }]",
        );
        break;
    }
  };
  const result = await run(bundles, {
    rendering,
    vsyncs: 200,
    deinterlacerOptions: {
      film: true,
      onFailure(message) {
        callbacks.push(message);
        if (trigger === "callback" && callbacks.length === 1) retry();
      },
    },
    resourceAvailable(resource) {
      if (resource.realm !== realm || !isTarget(resource)) return true;
      targetAttempts++;
      return available;
    },
    beforeVsync(vsync, current) {
      control = current;
      if (!injected) {
        injected = true;
        control.pageContext.__failure = (message) => {
          events.push(message);
          if (trigger === "event" && events.length === 1) retry();
        };
        control.deinterlacer(
          '__deinterlacer.addEventListener("failure", event => __failure(event.detail))',
        );
      }
      if (vsync === (["event", "callback"].includes(trigger) ? 70 : 110)) {
        assert.ok(
          targetAttempts > attemptsAtRetry,
          `${label}: no resource reallocation after requested retry`,
        );
      }
      if (vsync === 70) {
        control.deinterlacer(
          "__deinterlacer.spatialCheck = false; __deinterlacer.scan = { interlaced: true, topFieldFirst: true }",
        );
      }
      if (vsync === 90 && !["event", "callback"].includes(trigger)) {
        assert.equal(events.length, 1, `${label}: initial failure`);
        retry();
      }
      if (vsync === 94 && trigger === "interlacing")
        control.deinterlacer(
          "__deinterlacer.scan = { interlaced: true, topFieldFirst: true }",
        );
      if (vsync === 120) settledAttempts = targetAttempts;
      // Ordinary snapshots must not re-arm the unchanged failed option.
      if (vsync === 150) {
        control.deinterlacer(
          "__deinterlacer.doubleRate = false; __deinterlacer.spatialCheck = true",
        );
      }
    },
  });
  assert.ok(retried, `${label}: retry was requested`);
  assert.ok(
    targetAttempts > attemptsAtRetry,
    `${label}: no resource reallocation`,
  );
  assert.equal(
    targetAttempts,
    settledAttempts,
    `${label}: unrequested allocation retry`,
  );
  assert.equal(
    events.length,
    restored ? 1 : 2,
    `${label}: failure episodes: ${JSON.stringify(events)}`,
  );
  assert.deepEqual(callbacks, events, `${label}: callback/event parity`);
  assert.equal(
    result.stats.at(-1).filmError === null,
    restored,
    `${label}: final error`,
  );
  const reads = result.readbacks.filter(
    (resource) => resource.realm === realm && isTarget(resource),
  );
  assert.equal(
    reads.length > 10,
    restored,
    `${label}: analysis must really resume`,
  );
  assert.equal(
    control.deinterlacer("__deinterlacer.film"),
    true,
    `${label}: intent changed`,
  );
  assert.ok(
    result.draws.some((draw) => draw.toCanvas && draw.t > BASE_MS + 2500),
    `${label}: YADIF stopped`,
  );
  if (rendering === "worker") {
    assert.equal(
      result.commands.filter((command) => command.type === "initialize").length,
      1,
      `${label}: Worker restarted`,
    );
    if (["event", "callback", "later"].includes(trigger))
      assert.ok(
        result.commands.some(
          (command) => command.type === "settings" && command.options.film,
        ),
        `${label}: retry did not cross Worker boundary`,
      );
    assert.equal(
      result.allocations.filter(
        (resource) => resource.realm === "page" && isTarget(resource),
      ).length,
      0,
      `${label}: page allocated inactive engine`,
    );
  }
  control.deinterlacer("__deinterlacer.destroy()");
  console.log(`ok ${label}`);
  checked++;
}

for (const rendering of ["main", "worker"])
  for (const trigger of [
    "event",
    "callback",
    "later",
    "parity",
    "interlacing",
    "timeline",
    "start",
    "resize",
  ])
    for (const restored of [true, false])
      await exercise(rendering, trigger, restored);
console.log(`film retry: ${checked} cases passed`);
