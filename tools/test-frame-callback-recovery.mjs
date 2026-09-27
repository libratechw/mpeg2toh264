/**
 * A frame callback that stops coming must not change how often pictures are
 * taken in.
 *
 * `requestVideoFrameCallback` is re-armed from inside its own callback, so a
 * callback that never returns normally -- or a registration the browser drops
 * -- leaves the element with none, and only the watchdog's animation-frame
 * fallback keeps the filter fed. In a browser `currentTime` moves on at every
 * animation frame, not once per decoded picture, so treating any change of it
 * as a new picture takes the same picture in twice. The two captures of one
 * picture measure half a frame period, the shorter period lowers the fallback's
 * spacing to one refresh, and from then on every refresh is taken as a frame:
 * 60 a second, which film reconstruction turns into 48 instead of 24. Nothing
 * clears it short of reloading the player.
 *
 * These cases drive the real `deinterlace.ts` through
 * `tools/yadif-clock-harness.mjs` and count the fields the filter produced
 * after the callback stops, with the decoded-frame counter advancing at the
 * source's 30 frames a second.
 */
import assert from "node:assert/strict";

import { buildBundles, REFRESH_MS, run } from "./yadif-clock-harness.mjs";

const VSYNCS = 600;
/** The refresh from which the element stops serving frame callbacks. */
const STOP = 120;
/** Leave the watchdog and the period estimate time to settle before counting. */
const COUNT_FROM = STOP + 120;

/**
 * Stop frame callbacks at `STOP`, then keep the element playing the way a
 * browser does: the clock moves every refresh, the decoded count every other.
 */
function stopFrameCallbacks(vsync, control) {
  if (vsync < STOP) return;
  if (vsync === STOP) control.frames(false);
  control.video.currentTime = (vsync * REFRESH_MS) / 1000;
  control.video.totalVideoFrames = Math.floor(vsync / 2) + 1;
}

/** Fields filtered into the output pool from `COUNT_FROM` on, per source frame. */
function fieldsPerFrame(result) {
  const from = 2_000_000 + COUNT_FROM * REFRESH_MS;
  const filtered = result.draws.filter(
    (draw) => !draw.toCanvas && draw.t >= from,
  ).length;
  const frames = (VSYNCS - COUNT_FROM) / 2;
  return filtered / frames;
}

const bundles = await buildBundles(process.cwd());

const result = await run(bundles, {
  vsyncs: VSYNCS,
  rendering: "main",
  beforeVsync: stopFrameCallbacks,
});
const perFrame = fieldsPerFrame(result);
// Double rate filters two fields from each picture it takes in. Taking each
// picture once gives two per source frame; taking it twice gives four.
assert.ok(
  perFrame > 1.8 && perFrame < 2.2,
  `the fallback filtered ${perFrame.toFixed(2)} fields per source frame after the frame callback stopped; each picture should be taken in once`,
);
assert.equal(result.failures.length, 0, result.failures[0]?.message);
console.log(
  `ok - the fallback takes each picture in once (${perFrame.toFixed(2)} fields per frame)`,
);

// A registration the browser drops leaves the frame callback silent while the
// element goes on presenting frames. The fallback asks again, and the frames
// come back through the callback rather than staying on the fallback.
let delivered = 0;
let current = 0;
await run(bundles, {
  vsyncs: VSYNCS,
  rendering: "main",
  beforeVsync(vsync, control) {
    current = vsync;
    const video = control.video;
    if (vsync === 0) {
      const deliver = video.deliverFrame.bind(video);
      video.deliverFrame = (now, metadata) => {
        const served = deliver(now, metadata);
        if (served && current >= COUNT_FROM) delivered++;
        return served;
      };
    }
    if (vsync === STOP) video.cancelVideoFrameCallback();
  },
});
const expected = (VSYNCS - COUNT_FROM) / 2;
assert.ok(
  delivered > expected * 0.9,
  `only ${delivered} of ${expected} frames came through the frame callback after its registration was dropped`,
);
console.log(
  `ok - a dropped frame callback is asked for again (${delivered} of ${expected} frames delivered)`,
);
