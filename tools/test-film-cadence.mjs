#!/usr/bin/env node

// Regression tests for what the `film` option promises on the public
// Deinterlacer path: a 2:3 pulldown is shown as 24 frames a second with the
// repeated frame dropped and the rest evenly spaced, while film off (or not
// yet locked) leaves interlaced and progressive playback as they were.
//
// This replaces the old test:ivtc, which exercised the removed CPU FFmpeg
// IVTC port (`packages/yadif/src/ivtc.ts`) directly. The canvas-scheduler
// yadif detects pulldown on the GPU; these tests call the same decisions the
// Deinterlacer's frame loop calls, so the promise can be checked without a
// display. The GPU detection itself is exercised separately by
// test:film-public-path against a synthetic telecine source.
//
// Run from the repository root:
//   npm run test:film-cadence

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), "yadif-film-cadence-"));
const outFile = join(outDir, "film-cadence.mjs");

await build({
  entryPoints: [join(root, "packages/yadif/src/film-cadence.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: outFile,
  logLevel: "silent",
});

const {
  FILM_FRAMES,
  FILM_LEAD,
  PULLDOWN_FRAMES,
  advancePulldownPhase,
  filmFrameTiming,
  isRepeatedFilmPhase,
  schedulingCadence,
} = await import(pathToFileURL(outFile).href);

test.after(async () => {
  await rm(outDir, { recursive: true, force: true });
});

test("a locked film phase selects the film cadence", () => {
  assert.equal(schedulingCadence(true, false), "film");
  assert.equal(schedulingCadence(true, true), "film");
});

test("film off keeps the interlaced and progressive cadences", () => {
  // The 60i path is a picture for every field; the progressive path one per
  // frame. Neither is touched by the film option.
  assert.equal(schedulingCadence(false, true), "field");
  assert.equal(schedulingCadence(false, false), "frame");
});

test("a phase advances one per frame and wraps every cycle", () => {
  const known = { phase: 3, run: 7 };
  const phases = [0, 1, 2, 3, 4].map(
    (age) => advancePulldownPhase(known, age).phase,
  );
  assert.deepEqual(phases, [3, 4, 5, 1, 2]);
  for (const age of [0, 1, 2, 3, 4]) {
    assert.equal(advancePulldownPhase(known, age).run, 7);
  }
  // A full cycle later the same frame comes round again.
  assert.equal(advancePulldownPhase(known, PULLDOWN_FRAMES).phase, 3);
});

test("a phase reading with nothing behind it is not used", () => {
  // No detection yet, or a reading older than a cycle, says nothing about
  // the frame being filtered, so the deinterlacer keeps its normal cadence.
  assert.equal(advancePulldownPhase({ phase: 0, run: 0 }, 0), null);
  assert.equal(advancePulldownPhase({ phase: 0, run: 9 }, 3), null);
  assert.equal(
    advancePulldownPhase({ phase: 3, run: 7 }, PULLDOWN_FRAMES + 1),
    null,
  );
});

test("exactly one frame in a five-frame cycle is the repeat", () => {
  const repeated = [1, 2, 3, 4, 5].filter(isRepeatedFilmPhase);
  assert.deepEqual(repeated, [1]);
  // The repeat is the only phase with no lead, because it is never shown.
  assert.equal(FILM_LEAD[1], undefined);
});

test("four film frames come out 1.25 frame periods apart", () => {
  const periodMs = 1000 / 30;
  const known = { phase: 1, run: 8 };
  const shown = [];
  for (let index = 0; index < PULLDOWN_FRAMES; index++) {
    const phase = advancePulldownPhase(known, index).phase;
    if (isRepeatedFilmPhase(phase)) continue;
    // The frame arrives one period after the previous broadcast frame.
    const arrival = index * periodMs;
    shown.push(filmFrameTiming(phase, arrival, periodMs));
  }
  assert.equal(shown.length, FILM_FRAMES);
  for (const frame of shown) {
    // A film frame stands for 5/4 of a frame period, which is its share of a
    // 30 fps broadcast when four frames carry the cycle.
    assert.equal(frame.duration, (periodMs * PULLDOWN_FRAMES) / FILM_FRAMES);
  }
  for (let index = 1; index < shown.length; index++) {
    const gap = shown[index].at - shown[index - 1].at;
    assert.ok(
      Math.abs(gap - 1.25 * periodMs) < 1e-9,
      `film frames ${index - 1} and ${index} are ${gap} ms apart`,
    );
  }
  // 0.8 film frames per broadcast frame at 30 fps is 24 a second.
  const outputRate = (FILM_FRAMES / PULLDOWN_FRAMES) * (1000 / periodMs);
  assert.equal(outputRate, 24);
});

test("a cycle that never locks drops nothing", () => {
  // Without a locked phase the loop takes the field or frame cadence, so no
  // broadcast frame is dropped for being a repeat.
  for (const doubleRate of [true, false]) {
    assert.notEqual(schedulingCadence(false, doubleRate), "film");
  }
  for (const phase of [0, 2, 3, 4, 5]) {
    assert.equal(isRepeatedFilmPhase(phase), false);
  }
});
