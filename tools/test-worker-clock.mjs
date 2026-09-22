/**
 * The presentation schedule must not depend on how long a frame took to reach
 * the renderer.
 *
 * The Worker renderer is given each frame over `postMessage`, and the delay
 * between the page's frame callback and the Worker's message task is neither
 * small nor smooth: it competes with the Worker's own animation frame and with
 * the previous frame's filtering. Anchoring the schedule on the arrival time
 * puts that delay into every deadline, and `#schedule` restarts the chain once
 * the frame-to-frame swing reaches one output interval -- which at
 * `doubleRate` is a single refresh of queueing delay. Anchoring on the display
 * time the frame callback reported keeps the deadlines where the compositor
 * put them, and `performance.timeOrigin` is what makes that timestamp mean the
 * same thing in a realm that does not share the page's clock.
 *
 * These cases drive the real `deinterlace.ts` and `worker.ts` through
 * `tools/yadif-clock-harness.mjs`, which gives each realm its own clock, its
 * own `timeOrigin` and its own WebGL2 stub, and makes the transit delay a
 * dial. What is compared is the sequence of refreshes at which the scheduler
 * elected to show a queued picture. That is the scheduler's decision, not
 * evidence that a compositor presented anything: a simulated draw cannot
 * establish physical presentation, and none of this replaces watching a pan on
 * a real display.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildBundles,
  gaps,
  heldRefreshes,
  presentations,
  run,
} from "./yadif-clock-harness.mjs";

const VSYNCS = 200;
/** A swing wider than one output interval: what restarts the chain. */
const ALTERNATING = (id) => (id % 2 ? 0.5 : 20);
const STEADY = () => 0.5;

/** Compare the picture and field, independently of reusable output texture IDs. */
function schedule(result) {
  const decisions = presentations(result.draws);
  for (const entry of decisions) {
    assert.ok(
      Number.isFinite(entry.picture?.mediaTime),
      "presentation has no source picture",
    );
    assert.ok(
      entry.picture.second === 0 || entry.picture.second === 1,
      "presentation has no field identity",
    );
  }
  return (
    decisions
      // Worker startup may miss the first input; both paths need two inputs to measure the period.
      .filter((entry) => entry.refresh >= 10)
      .map(
        (entry) =>
          `${entry.refresh}:${entry.picture?.mediaTime?.toFixed(6)}:${entry.picture?.second}`,
      )
      .join(" ")
  );
}

/** Every refresh in the covered span carried one decision. */
function assertUnbroken(result, label) {
  const decisions = presentations(result.draws);
  assert.ok(
    decisions.length > VSYNCS * 0.9,
    `${label}: only ${decisions.length} presentation decisions in ${VSYNCS} refreshes`,
  );
  assert.deepEqual(
    [...new Set(gaps(decisions))],
    [1],
    `${label}: the schedule skipped refreshes (${heldRefreshes(decisions)} held)`,
  );
  assert.equal(
    result.failures.length,
    0,
    `${label}: ${result.failures[0]?.message}`,
  );
}

const cases = [];
const test = (name, body) => cases.push({ name, body });

test("transit jitter does not move the Worker's schedule", async ({
  fixed,
}) => {
  const steady = await run(fixed, { vsyncs: VSYNCS, transit: STEADY });
  const jittered = await run(fixed, { vsyncs: VSYNCS, transit: ALTERNATING });
  assertUnbroken(steady, "steady transit");
  assertUnbroken(jittered, "alternating transit");
  assert.equal(
    schedule(jittered),
    schedule(steady),
    "a frame that took longer to cross the thread boundary changed when its picture was due",
  );
});

test("the Worker keeps the schedule main-thread rendering would have", async ({
  fixed,
}) => {
  const worker = await run(fixed, { vsyncs: VSYNCS });
  const main = await run(fixed, { vsyncs: VSYNCS, rendering: "main" });
  assertUnbroken(worker, "worker rendering");
  assertUnbroken(main, "main rendering");
  assert.equal(schedule(worker), schedule(main));
});

test("main-thread rendering is unchanged by the clock contract", async ({
  fixed,
  baseline,
}) => {
  if (!baseline) return "no baseline archive";
  const now = await run(fixed, { vsyncs: VSYNCS, rendering: "main" });
  const before = await run(baseline, { vsyncs: VSYNCS, rendering: "main" });
  assert.equal(schedule(now), schedule(before));
  return null;
});

test("the acquisition origin is read per frame, not once at startup", async ({
  fixed,
}) => {
  // A document picture-in-picture window adopts the video node mid-stream, so
  // the clock its frame callback reports on changes while the Worker runs. An
  // origin captured at `initialize` would be stale from here on, and the
  // translated display time would fall outside what can describe the frame --
  // dropping the renderer back to the arrival clock the jitter lives in.
  const move = (index) =>
    index === 50 ? { acquisitionTimeOrigin: 1_777_777 } : undefined;
  for (const transit of [STEADY, ALTERNATING]) {
    const fixedOrigin = await run(fixed, { vsyncs: VSYNCS, transit });
    const movedOrigin = await run(fixed, {
      vsyncs: VSYNCS,
      transit,
      beforeFrame: move,
    });
    assertUnbroken(movedOrigin, "origin change");
    assert.equal(schedule(movedOrigin), schedule(fixedOrigin));
  }
});

test("an acquisition realm that is neither the page nor the Worker", async ({
  fixed,
}) => {
  const same = await run(fixed, { vsyncs: VSYNCS });
  for (const rendering of ["worker", "main"]) {
    const apart = await run(fixed, {
      vsyncs: VSYNCS,
      rendering,
      acquisitionTimeOrigin: 1_500_000,
    });
    assertUnbroken(apart, `three clocks, ${rendering}`);
    assert.equal(schedule(apart), schedule(same));
  }
});

test("a display time that cannot describe the frame falls back", async ({
  fixed,
}) => {
  // 0 and NaN have both been reported; WebKit has reported times already
  // past. A translated time is only as good as the origin the other side
  // stamped, so one far outside this frame is rejected the same way. The
  // fallback is the ingestion clock, which is this renderer's own.
  const shapes = {
    NaN: () => Number.NaN,
    zero: () => 0,
    negative: () => -1,
    "ten seconds ahead": (index, expected) => expected + 10_000,
    "ten seconds behind": (index, expected) => expected - 10_000,
    "one bad report in ten": (index, expected) =>
      index % 10 === 0 ? Number.NaN : expected,
  };
  for (const [shape, displayTime] of Object.entries(shapes)) {
    const result = await run(fixed, { vsyncs: VSYNCS, displayTime });
    assertUnbroken(result, `expectedDisplayTime ${shape}`);
    const last = result.stats.at(-1);
    assert.equal(
      last?.queueResetted,
      0,
      `expectedDisplayTime ${shape}: the queue was reset, so the value was scheduled from`,
    );
  }
});

test("frames are acknowledged once and closed once", async ({ fixed }) => {
  for (const [label, transit, drains] of [
    ["steady", STEADY, true],
    ["back-pressured", () => 40, false],
  ]) {
    const result = await run(fixed, { vsyncs: VSYNCS, transit });
    const { created, closed } = result.videoFrames;
    assert.ok(created > 0, `${label}: no frames were sent`);
    // Closed exactly once each: never twice, and never left to the collector.
    for (const [id, closes] of result.frameCloses)
      assert.equal(
        closes,
        1,
        `${label}: frame ${id} was closed ${closes} times`,
      );
    if (drains)
      assert.equal(closed, created, `${label}: ${created - closed} unclosed`);
    // Back-pressure leaves at most the one in flight and the one held back.
    else
      assert.ok(
        created - closed <= 2,
        `${label}: ${created - closed} unclosed`,
      );
    assert.deepEqual(
      result.acked.map(({ id }) => id),
      result.sent.slice(0, result.acked.length).map(({ id }) => id),
      `${label}: acknowledgements did not follow the frames sent`,
    );
    assert.ok(
      result.sent.length - result.acked.length <= 1,
      `${label}: more than one frame was in flight`,
    );
    for (let index = 1; index < result.sent.length; index++)
      assert.ok(
        result.sent[index].at >= result.acked[index - 1].at,
        `${label}: frame ${result.sent[index].id} was sent before the previous was released`,
      );
  }
});

test("the fault this fixes is present without it", async ({ baseline }) => {
  if (!baseline) return "no baseline archive";
  const steady = await run(baseline, { vsyncs: VSYNCS, transit: STEADY });
  const jittered = await run(baseline, {
    vsyncs: VSYNCS,
    transit: ALTERNATING,
  });
  // Steady transit hides it: the arrival clock is then a fixed offset from the
  // display clock, and a fixed offset is what a chained schedule absorbs.
  assertUnbroken(steady, "baseline, steady transit");
  assert.notEqual(
    schedule(jittered),
    schedule(steady),
    "the baseline should have followed the arrival clock; the harness is not exercising it",
  );
  const decisions = presentations(jittered.draws);
  assert.ok(
    heldRefreshes(decisions) > VSYNCS / 8,
    `baseline lost only ${heldRefreshes(decisions)} refreshes to jitter`,
  );
  assert.ok(
    (jittered.stats.at(-1)?.resynced ?? 0) > VSYNCS / 8,
    "the baseline chain did not restart under jitter",
  );
  return null;
});

/** An archive of the commit before the fix, for the counterexample above. */
async function archiveBaseline(directory) {
  // Historical comparison is opt-in: the ordinary regression suite must run
  // from a source archive without requiring an unpublished local commit.
  const ref = process.env.YADIF_BASELINE_REF;
  if (!ref) return null;
  const commit = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    { encoding: "utf8" },
  ).trim();
  const archive = execFileSync("git", [
    "archive",
    commit,
    "packages/yadif/src",
  ]);
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  return directory;
}

const workspace = await mkdtemp(join(tmpdir(), "yadif-baseline-"));
let failed = 0;
try {
  const baselineRoot = await archiveBaseline(workspace);
  const fixed = await buildBundles(process.cwd());
  const baseline = baselineRoot ? await buildBundles(baselineRoot) : null;
  if (!baseline)
    console.log(
      "! historical comparison not requested (set YADIF_BASELINE_REF to run it); current-source regression cases remain mandatory",
    );
  for (const { name, body } of cases) {
    try {
      const skipped = await body({ fixed, baseline });
      console.log(
        `${skipped ? "-" : "ok"} ${name}${skipped ? ` (${skipped})` : ""}`,
      );
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}\n    ${error.message}`);
    }
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
if (failed > 0) {
  console.log(`${failed} failed`);
  process.exitCode = 1;
}
