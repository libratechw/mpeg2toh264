#!/usr/bin/env node

// Focused regression tests for the browser-boundary decisions the
// deinterlacer makes. Each case stands for something that was seen on a
// device:
//  - Document Picture-in-Picture moves the element to another window, whose
//    rAF and rVFC timestamps are a different timebase; comparing across the
//    two stopped the picture. The loop must follow the canvas.
//  - Safari reports a large negative expectedDisplayTime. Believing it put
//    every scheduled moment in the distant past, so the second field of every
//    pair was dropped as late (30 fps instead of 60).
//
// These cover the decisions those paths make. The loop's actual registration
// and release against a real document is a browser behaviour, verified
// on-device (Windows Document PiP continued after the fix); it is not
// reimplemented here.
//
// Run from the repository root:
//   npm run test:yadif-runtime

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), "yadif-runtime-"));
const outFile = join(outDir, "runtime.mjs");

await build({
  entryPoints: [join(root, "packages/yadif/src/runtime.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: outFile,
  logLevel: "silent",
});

const {
  EXPECTED_DISPLAY_TIME_TOLERANCE_MS,
  loopWindowFor,
  usableExpectedDisplayTime,
} = await import(pathToFileURL(outFile).href);

test.after(async () => {
  await rm(outDir, { recursive: true, force: true });
});

test("usableExpectedDisplayTime keeps a real moment near now", () => {
  // The callback can run slightly before or after the moment it reports.
  assert.equal(usableExpectedDisplayTime(1050, 1000), 1050);
  assert.equal(usableExpectedDisplayTime(900, 1000), 900);
  assert.equal(usableExpectedDisplayTime(1000, 1000), 1000);
});

test("usableExpectedDisplayTime keeps a value right up to the tolerance", () => {
  const now = 5000;
  const inside = now - (EXPECTED_DISPLAY_TIME_TOLERANCE_MS - 1);
  const outside = now - EXPECTED_DISPLAY_TIME_TOLERANCE_MS;
  assert.equal(usableExpectedDisplayTime(inside, now), inside);
  assert.equal(usableExpectedDisplayTime(outside, now), now);
});

test("usableExpectedDisplayTime falls back when the value cannot be used", () => {
  const now = 1234.5;
  // Zero and negatives are not moments: the old `|| now` treated zero this way.
  assert.equal(usableExpectedDisplayTime(0, now), now);
  // Safari returns a large negative number (seen: -1009688640).
  assert.equal(usableExpectedDisplayTime(-1009688640, now), now);
  assert.equal(usableExpectedDisplayTime(-1, now), now);
  // Values that are not finite numbers at all.
  assert.equal(usableExpectedDisplayTime(Number.NaN, now), now);
  assert.equal(usableExpectedDisplayTime(Number.POSITIVE_INFINITY, now), now);
  assert.equal(usableExpectedDisplayTime(Number.NEGATIVE_INFINITY, now), now);
  // A future value the clock has not reached is not this callback's moment.
  assert.equal(usableExpectedDisplayTime(now + 60_000, now), now);
  // Never trust a non-number; the metadata field is untrusted input.
  assert.equal(usableExpectedDisplayTime("1000", now), now);
  assert.equal(usableExpectedDisplayTime(undefined, now), now);
  assert.equal(usableExpectedDisplayTime(null, now), now);
  assert.equal(usableExpectedDisplayTime({}, now), now);
});

test("loopWindowFor follows the canvas into another document and back", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const fallbackWindow = { name: "fallback" };
  try {
    // The fallback the loop returns to is the global window at the time of
    // the call; capture it the way the module would see it.
    globalThis.window = fallbackWindow;

    const mainWindow = { name: "main" };
    const pipWindow = { name: "document-pip" };
    const mainDocument = { defaultView: mainWindow };
    const pipDocument = { defaultView: pipWindow };

    const canvas = { ownerDocument: mainDocument };
    assert.equal(loopWindowFor(canvas), mainWindow);

    // Entering Document Picture-in-Picture: the element is adopted by the PiP
    // document, so its frame callbacks and rAF live in that window.
    canvas.ownerDocument = pipDocument;
    assert.equal(loopWindowFor(canvas), pipWindow);

    // Leaving: adopted back into the page's document.
    canvas.ownerDocument = mainDocument;
    assert.equal(loopWindowFor(canvas), mainWindow);

    // The PiP document going away is the null defaultView case.
    canvas.ownerDocument = { defaultView: null };
    assert.equal(loopWindowFor(canvas), fallbackWindow);

    // A detached canvas has no document to ask.
    canvas.ownerDocument = null;
    assert.equal(loopWindowFor(canvas), fallbackWindow);
    delete canvas.ownerDocument;
    assert.equal(loopWindowFor(canvas), fallbackWindow);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else delete globalThis.window;
  }
});
