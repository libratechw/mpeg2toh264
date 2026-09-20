/**
 * The loop and the watchdog belong to the window that composites the canvas.
 *
 * Both were scheduled on the bare global `requestAnimationFrame`, which is the
 * window this module was loaded in -- the opener. A document
 * picture-in-picture window can adopt the element and its canvas while
 * playback runs, and from then on it is that window that composites them. The
 * opener keeps the outstanding requests, and once it is hidden it serves no
 * animation frames at all, so the request is not late: it never runs. Nothing
 * that waits for that callback can notice the move, and cancelling it anywhere
 * but on the window that issued it leaves it outstanding.
 *
 * These cases drive a real `Deinterlacer` through `main -> PiP -> main -> PiP`
 * with the abandoned window suspended, and assert two things the harness can
 * see without reaching inside the class: where the scheduler elected to show a
 * picture, and the ledger of every animation-frame registration and
 * cancellation with the window it was made on. A simulated draw is not
 * evidence that a compositor presented anything -- only that the schedule
 * chose a refresh.
 *
 * Set `YADIF_BASELINE_REF` to a commit to add the counterexample arm, which
 * asserts the same cases fail without the correction.
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

const VSYNCS = 240;
/** Far enough from the opener's that an unconverted timestamp cannot pass. */
const PIP_A_ORIGIN = 1_654_321;
const PIP_B_ORIGIN = 1_222_333;

/** main -> PiP -> main -> PiP, each move abandoning a window that then hides. */
const LIFECYCLE = (vsync, control) => {
  if (vsync === 60) {
    control.adopt("pipA", PIP_A_ORIGIN);
    control.suspend("page");
  }
  if (vsync === 120) {
    control.resume("page");
    control.adopt("page");
    control.suspend("pipA");
  }
  if (vsync === 180) {
    control.adopt("pipB", PIP_B_ORIGIN);
    control.suspend("page");
  }
};
/** The refresh spans between moves, skipping the refresh a move lands on. */
const SEGMENTS = [
  [2, 60],
  [62, 120],
  [122, 180],
  [182, 240],
];

function segments(result) {
  const decisions = presentations(result.draws);
  return SEGMENTS.map(
    ([from, to]) =>
      decisions.filter((entry) => entry.refresh >= from && entry.refresh < to)
        .length,
  );
}

/** Registrations and cancellations, keyed by the window each was made on. */
function ledger(result) {
  const registered = new Set(
    result.requests.map(({ view, handle }) => `${view}#${handle}`),
  );
  return {
    perView: result.requests.reduce((counts, { view }) => {
      counts[view] = (counts[view] ?? 0) + 1;
      return counts;
    }, {}),
    /** Cancels aimed at a window that never issued that handle. */
    misdirected: result.cancels.filter(
      ({ view, handle }) => !registered.has(`${view}#${handle}`),
    ),
    stranded: Object.entries(result.outstanding).filter(
      ([, handles]) => handles.length > 0,
    ),
  };
}

const cases = [];
const test = (name, body) => cases.push({ name, body });

test("main rendering follows the element into and out of PiP", async ({
  fixed,
}) => {
  const result = await run(fixed, {
    vsyncs: VSYNCS,
    rendering: "main",
    beforeVsync: LIFECYCLE,
  });
  const counts = segments(result);
  for (const [index, count] of counts.entries())
    assert.ok(
      count > 50,
      `segment ${index} kept only ${count} presentation decisions (${counts.join("/")})`,
    );
  const decisions = presentations(result.draws);
  assert.deepEqual(
    [...new Set(gaps(decisions))],
    [1],
    `the schedule skipped refreshes across an adoption (${heldRefreshes(decisions)} held)`,
  );
  assert.equal(result.failures.length, 0, result.failures[0]?.message);
});

test("an abandoned window keeps nothing, and is what cancels it", async ({
  fixed,
}) => {
  // Sample the ledger every refresh rather than only at the end: a request
  // parked on a window that has stopped serving frames is invisible in a
  // final tally if something later happens to clear it.
  const live = [];
  const result = await run(fixed, {
    vsyncs: VSYNCS,
    rendering: "main",
    beforeVsync: (vsync, control) => {
      LIFECYCLE(vsync, control);
      // One refresh of grace after a move: the observation that notices it
      // has not necessarily arrived within the same refresh.
      if (vsync > 2 && !SEGMENTS.some(([from]) => vsync === from - 1))
        live.push([vsync, control.outstanding()]);
    },
  });
  const { misdirected, stranded, perView } = ledger(result);
  assert.equal(
    misdirected.length,
    0,
    `${misdirected.length} cancellations went to a window that never issued the handle`,
  );
  assert.equal(
    stranded.filter(([view]) => view !== "pipB").length,
    0,
    `requests left outstanding on ${stranded.map(([view]) => view).join(", ")}`,
  );
  for (const view of ["pipA", "pipB"])
    assert.ok(perView[view] > 0, `nothing was ever scheduled on ${view}`);
  // Two at most anywhere: the loop and the watchdog, never a duplicate pair
  // left behind by a re-arm that forgot to cancel.
  for (const [vsync, snapshot] of live)
    for (const [view, handles] of Object.entries(snapshot))
      assert.ok(
        handles.length <= 2,
        `refresh ${vsync}: ${handles.length} requests outstanding on ${view}`,
      );
});

test("the watchdog follows even when the Worker owns the drawing", async ({
  fixed,
}) => {
  // Worker rendering keeps its own animation frames, so the schedule says
  // nothing here. What moves is the page-side watchdog, and the ledger is
  // where that shows.
  const result = await run(fixed, {
    vsyncs: VSYNCS,
    rendering: "worker",
    beforeVsync: LIFECYCLE,
  });
  const { perView, stranded } = ledger(result);
  for (const view of ["pipA", "pipB"])
    assert.ok(
      perView[view] > 0,
      `the watchdog never moved to ${view} (${JSON.stringify(perView)})`,
    );
  assert.deepEqual(
    stranded
      .filter(([view]) => view !== "worker" && view !== "pipB")
      .map(([view]) => view),
    [],
    "a page-side request was left on a window that is no longer the owner",
  );
});

test("adoption is noticed with no frame and no layout to report it", async ({
  fixed,
}) => {
  // On Firefox the frames themselves are found by this module's own animation
  // frames, so a hidden opener stops the acquisition that would otherwise
  // notice the move. Nothing here delivers a frame or a layout after the
  // move: the owner-change signal is all that is left.
  const result = await run(fixed, {
    vsyncs: 140,
    rendering: "main",
    beforeVsync: (vsync, control) => {
      if (vsync === 58) control.frames(false);
      if (vsync === 60) {
        control.adopt("pipA", PIP_A_ORIGIN);
        control.suspend("page");
      }
    },
  });
  const { perView, stranded } = ledger(result);
  assert.ok(
    perView.pipA > 0,
    `nothing re-armed on the adopting window (${JSON.stringify(perView)})`,
  );
  assert.deepEqual(
    stranded.map(([view]) => view),
    ["pipA"],
    "the requests did not end up on the adopting window alone",
  );
});

test("a move the old window could still have reported is handled too", async ({
  fixed,
}) => {
  // Hidden first, then adopted: the owner-change signal arrives before there
  // is anything to change to, so only a later frame can report the move. It
  // should cost the one refresh it takes for that frame to arrive, not the
  // rest of playback.
  const result = await run(fixed, {
    vsyncs: VSYNCS,
    rendering: "main",
    beforeVsync: (vsync, control) => {
      if (vsync === 60) {
        control.suspend("page");
        control.adopt("pipA", PIP_A_ORIGIN);
      }
    },
  });
  const decisions = presentations(result.draws);
  assert.ok(
    heldRefreshes(decisions) <= 2,
    `${heldRefreshes(decisions)} refreshes lost to an adoption the old window could not report`,
  );
  assert.ok(
    decisions.filter((entry) => entry.refresh > 62).length > 160,
    "playback did not resume on the adopting window",
  );
});

test("stopping and destroying leave nothing armed anywhere", async ({
  fixed,
}) => {
  const result = await run(fixed, {
    vsyncs: VSYNCS,
    rendering: "main",
    beforeVsync: (vsync, control) => {
      LIFECYCLE(vsync, control);
      if (vsync === 200) {
        control.deinterlacer("__deinterlacer.stop()");
        // A stopped deinterlacer has cancelled both requests; nothing may be
        // left on the window that was serving them a refresh ago.
        assert.deepEqual(
          Object.entries(control.outstanding()).filter(
            ([view, handles]) => view !== "worker" && handles.length > 0,
          ),
          [],
          "stop() left an animation frame outstanding",
        );
      }
      if (vsync === 210) control.deinterlacer("__deinterlacer.destroy()");
    },
  });
  const { misdirected, stranded } = ledger(result);
  assert.equal(
    misdirected.length,
    0,
    "a cancellation went to the wrong window",
  );
  assert.deepEqual(
    stranded.map(([view]) => view),
    [],
    "destroy() left an animation frame outstanding",
  );
  assert.deepEqual(
    result.control.visibilityListeners(),
    { page: 0, acquire: 0, pipA: 0, pipB: 0 },
    "destroy() left an owner-change listener attached",
  );
});

test("exactly one owner-change listener, on the live document", async ({
  fixed,
}) => {
  const seen = [];
  await run(fixed, {
    vsyncs: VSYNCS,
    rendering: "main",
    beforeVsync: (vsync, control) => {
      LIFECYCLE(vsync, control);
      if (vsync > 2 && vsync % 20 === 0)
        seen.push(control.visibilityListeners());
    },
  });
  for (const snapshot of seen) {
    const total = Object.values(snapshot).reduce((sum, n) => sum + n, 0);
    assert.equal(
      total,
      1,
      `${total} owner-change listeners attached (${JSON.stringify(snapshot)})`,
    );
  }
});

test("owning the loop does not restart the schedule", async ({ fixed }) => {
  // The presentation deadlines are on this module's clock, which no adoption
  // touches. Only the refresh grid starts again. If following the owner were
  // dropping the queue, or re-deciding the chain per frame, `resynced` and
  // `queueResetted` would climb with every move.
  const still = await run(fixed, { vsyncs: VSYNCS, rendering: "main" });
  const moved = await run(fixed, {
    vsyncs: VSYNCS,
    rendering: "main",
    beforeVsync: LIFECYCLE,
  });
  const quiet = still.stats.at(-1);
  const busy = moved.stats.at(-1);
  assert.equal(busy.queueResetted, quiet.queueResetted);
  assert.equal(
    busy.resynced,
    quiet.resynced,
    `three adoptions restarted the chain ${busy.resynced - quiet.resynced} extra times`,
  );
  assert.ok(
    busy.late <= quiet.late + 2,
    `three adoptions retired ${busy.late - quiet.late} extra pictures`,
  );
});

test("the fault this fixes is present without it", async ({ baseline }) => {
  if (!baseline) return "set YADIF_BASELINE_REF to compare";
  const main = await run(baseline, {
    vsyncs: VSYNCS,
    rendering: "main",
    beforeVsync: LIFECYCLE,
  });
  const counts = segments(main);
  // Segments 1 and 3 are the ones spent in a picture-in-picture window with
  // the opener hidden. Without the correction the loop is still waiting on
  // the opener, so nothing is elected at all.
  assert.equal(
    counts[1],
    0,
    `the baseline presented ${counts[1]} times while the opener was hidden; the harness is not exercising it`,
  );
  assert.equal(counts[3], 0, "the baseline presented from a hidden opener");
  assert.ok(
    counts[0] > 50 && counts[2] > 50,
    "the baseline should still run while the opener is visible",
  );
  const stranded = ledger(main).stranded;
  assert.deepEqual(
    stranded.map(([view]) => view),
    ["page"],
    "the baseline should leave its requests on the opener",
  );
  // Worker rendering hides it in the schedule, but the watchdog is stranded
  // just the same, so the frame-callback recovery is dead after the move.
  const worker = await run(baseline, {
    vsyncs: VSYNCS,
    rendering: "worker",
    beforeVsync: LIFECYCLE,
  });
  assert.equal(
    ledger(worker).perView.pipA,
    undefined,
    "the baseline should never schedule on the adopting window",
  );
  return null;
});

/**
 * An archive of a commit to compare against, when one is asked for. Opt-in,
 * and built without handing anything to a shell.
 */
async function archiveBaseline(directory) {
  const ref = process.env.YADIF_BASELINE_REF;
  if (!ref) return null;
  const tar = join(directory, "baseline.tar");
  execFileSync("git", [
    "archive",
    "--format=tar",
    "--output",
    tar,
    ref,
    "packages/yadif/src",
  ]);
  execFileSync("tar", ["-x", "-f", tar, "-C", directory]);
  return directory;
}

const workspace = await mkdtemp(join(tmpdir(), "yadif-pip-"));
let failed = 0;
try {
  const baselineRoot = await archiveBaseline(workspace);
  const fixed = await buildBundles(process.cwd());
  const baseline = baselineRoot ? await buildBundles(baselineRoot) : null;
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
