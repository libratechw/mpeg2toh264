#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const [
  inputPath,
  start = "0",
  duration = "20",
  requestedFieldOrder,
  requestedWidth = "288",
  requestedHeight = "162",
] = process.argv.slice(2);
if (!inputPath) {
  console.error(
    "usage: node tools/analyze-ivtc.cjs INPUT [START] [DURATION] [tff|bff] [WIDTH] [HEIGHT]",
  );
  process.exit(2);
}

const WIDTH = Number(requestedWidth);
const HEIGHT = Number(requestedHeight);
if (!Number.isInteger(WIDTH) || WIDTH < 32)
  throw new Error("width must be an integer of at least 32");
if (!Number.isInteger(HEIGHT) || HEIGHT < 8)
  throw new Error("height must be an integer of at least 8");
const FRAME_BYTES = WIDTH * HEIGHT * 4;

/** Determine field order from an explicit value or the input stream headers. */
function topFieldFirst() {
  if (requestedFieldOrder === "tff") return true;
  if (requestedFieldOrder === "bff") return false;
  if (requestedFieldOrder !== undefined && requestedFieldOrder !== "auto")
    throw new Error("field order must be auto, tff, or bff");
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=field_order",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ],
    { encoding: "utf8" },
  );
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(probe.stderr.trim());
  const fieldOrders = [
    ...new Set(probe.stdout.split(/\s+/).filter((value) => value.length > 0)),
  ];
  if (fieldOrders.length > 1)
    throw new Error(
      `input has multiple field orders (${fieldOrders.join(", ")}); pass tff or bff explicitly`,
    );
  const fieldOrder = fieldOrders[0] ?? "";
  if (fieldOrder === "tt" || fieldOrder === "tb") return true;
  if (fieldOrder === "bb" || fieldOrder === "bt") return false;
  throw new Error(
    `input field order is ${fieldOrder || "unknown"}; pass tff or bff explicitly`,
  );
}

/**
 * Return the input frame numbers FFmpeg drops over the same interval.
 * @param {boolean} isTopFieldFirst Whether the input video is TFF
 * @returns {number[]} Input frame numbers dropped by FFmpeg
 */
function ffmpegDropIndices(isTopFieldFirst) {
  const reference = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "info",
      "-ss",
      start,
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      `trim=duration=${duration},fieldmatch=mode=pc_n:combmatch=full:mchroma=0:order=${isTopFieldFirst ? "tff" : "bff"},showinfo,decimate=cycle=5:mixed=1,showinfo`,
      "-fps_mode",
      "passthrough",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (reference.error) throw reference.error;
  if (reference.status !== 0) throw new Error(reference.stderr.trim());

  // Collect checksum sequences from before and after decimation separately
  const passes = new Map();
  for (const line of reference.stderr.split("\n")) {
    const parsed = line.match(
      /Parsed_showinfo_(\d+).*? n:\s*(\d+).*? checksum:([0-9A-F]+)/,
    );
    if (!parsed) continue;
    const pass = Number(parsed[1]);
    const frames = passes.get(pass) ?? [];
    frames.push({ index: Number(parsed[2]), checksum: parsed[3] });
    passes.set(pass, frames);
  }
  const passIDs = [...passes.keys()].sort((first, second) => first - second);
  if (passIDs.length !== 2)
    throw new Error(
      `expected two FFmpeg showinfo passes, got ${passIDs.length}`,
    );
  const before = passes.get(passIDs[0]) ?? [];
  const after = passes.get(passIDs[1]) ?? [];
  // Match retained checksums in input order and treat missing positions as drops
  const drops = [];
  let retainedIndex = 0;
  for (const frame of before) {
    if (frame.checksum === after[retainedIndex]?.checksum) retainedIndex++;
    else drops.push(frame.index);
  }
  if (retainedIndex !== after.length)
    throw new Error("FFmpeg showinfo passes could not be aligned by checksum");
  return drops;
}

async function main() {
  const isTopFieldFirst = topFieldFirst();
  // Load the package's implementation through Vite so this diagnostic cannot
  // drift into a second cadence classifier with its own thresholds
  const { createServer } = await import("vite");
  const server = await createServer({
    root: "packages/yadif",
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const { FFmpegIVTC } = await server.ssrLoadModule("/src/ivtc.ts");
    const ivtc = new FFmpegIVTC(WIDTH, HEIGHT);
    // Decode the same field-aware reduced RGB frames used by the browser's
    // luma matching and colour-sensitive decimate passes
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        start,
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `trim=duration=${duration},scale=${WIDTH}:${HEIGHT}:flags=neighbor:interl=1,format=rgba`,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let pending = Buffer.alloc(0);
    const frames = [];
    const lumaFrames = [];
    const results = [];
    let decodedFrames = 0;
    let analysisMs = 0;
    const code = await new Promise((resolve, reject) => {
      ffmpeg.once("error", reject);
      ffmpeg.stdout.on("data", (chunk) => {
        try {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= FRAME_BYTES) {
            frames.push(pending.subarray(0, FRAME_BYTES));
            decodedFrames++;
            // The shader stores this Rec. 709 luma in its three analysis channels
            const rgba = frames.at(-1);
            const luma = new Uint8Array(WIDTH * HEIGHT);
            for (let pixel = 0; pixel < luma.length; pixel++) {
              const offset = pixel * 4;
              luma[pixel] = Math.round(
                (rgba[offset] ?? 0) * 0.2126 +
                  (rgba[offset + 1] ?? 0) * 0.7152 +
                  (rgba[offset + 2] ?? 0) * 0.0722,
              );
            }
            lumaFrames.push(luma);
            pending = pending.subarray(FRAME_BYTES);
            if (frames.length < 3) continue;
            const analysisStarted = performance.now();
            const fieldMatch = ivtc.fieldMatch(
              lumaFrames[0],
              lumaFrames[1],
              lumaFrames[2],
              isTopFieldFirst,
            );
            const decimate = ivtc.decimate(
              ivtc.weave(
                frames[0],
                frames[1],
                frames[2],
                fieldMatch.match,
                isTopFieldFirst,
              ),
            );
            results.push({
              sourceIndex: decodedFrames - 2,
              fieldMatch,
              decimate,
            });
            analysisMs += performance.now() - analysisStarted;
            frames.shift();
            lumaFrames.shift();
          }
        } catch (error) {
          // Stopping the producer lets the rejected analysis close promptly
          ffmpeg.kill();
          reject(error);
        }
      });
      ffmpeg.once("close", resolve);
    });
    if (code !== 0) throw new Error(`ffmpeg exited with status ${code}`);
    if (pending.length !== 0)
      throw new Error(
        `ffmpeg left ${pending.length} bytes of an incomplete frame`,
      );
    if (results.length === 0)
      throw new Error("input produced fewer than three complete video frames");

    // Report the same decisions the browser consumes, including cycles where
    // mixed=1 keeps all five frames and combed frames delegated to YADIF
    const combScores = results
      .map(({ fieldMatch }) => fieldMatch.combScore)
      .sort((first, second) => first - second);
    const duplicateScores = results
      .filter(({ decimate }) => decimate.cycleIndex === FFmpegIVTC.CYCLE - 1)
      .map(({ decimate }) => decimate.lowestCycleDifference)
      .sort((first, second) => first - second);
    const percentile = (part) =>
      combScores[
        Math.min(combScores.length - 1, Math.floor(combScores.length * part))
      ] ?? 0;
    const duplicatePercentile = (part) =>
      duplicateScores[
        Math.min(
          duplicateScores.length - 1,
          Math.floor(duplicateScores.length * part),
        )
      ] ?? 0;
    const predictedDrops = results
      .filter(
        ({ fieldMatch, decimate }) =>
          decimate.shouldDrop && !fieldMatch.isCombed,
      )
      .map(({ sourceIndex }) => sourceIndex);
    const predictedDropScores = results
      .filter(
        ({ fieldMatch, decimate }) =>
          decimate.shouldDrop && !fieldMatch.isCombed,
      )
      .map(({ decimate }) => ({
        max: decimate.maxBlockDifference,
        total: decimate.totalDifference,
      }))
      .sort((first, second) => first.max - second.max);
    // Compare the causal prediction with the minimum-difference frame available
    // to a path that can wait for all five frames
    const cycleMinimumDrops = [];
    let proxyCycle = [];
    for (const result of results) {
      proxyCycle.push(result);
      if (result.decimate.cycleIndex !== FFmpegIVTC.CYCLE - 1) continue;
      const dropIndex = result.decimate.nextDropIndex;
      const dropped = dropIndex === null ? undefined : proxyCycle[dropIndex];
      if (dropped && !dropped.fieldMatch.isCombed)
        cycleMinimumDrops.push(dropped.sourceIndex);
      proxyCycle = [];
    }
    const ffmpegDrops = ffmpegDropIndices(isTopFieldFirst);
    const predictedSet = new Set(predictedDrops);
    const cycleMinimumSet = new Set(cycleMinimumDrops);
    console.log(
      JSON.stringify(
        {
          input: inputPath,
          start: Number(start),
          duration: Number(duration),
          fieldOrder: isTopFieldFirst ? "tff" : "bff",
          analysisSize: { width: WIDTH, height: HEIGHT },
          analyzedFrames: results.length,
          analysisFrameMs: analysisMs / results.length,
          matches: Object.fromEntries(
            ["p", "c", "n"].map((match) => [
              match,
              results.filter(({ fieldMatch }) => fieldMatch.match === match)
                .length,
            ]),
          ),
          combScore: {
            median: percentile(0.5),
            p90: percentile(0.9),
            p99: percentile(0.99),
          },
          combedFrames: results.filter(({ fieldMatch }) => fieldMatch.isCombed)
            .length,
          duplicateScore: {
            p10: duplicatePercentile(0.1),
            p25: duplicatePercentile(0.25),
            median: duplicatePercentile(0.5),
            p75: duplicatePercentile(0.75),
            p90: duplicatePercentile(0.9),
            p99: duplicatePercentile(0.99),
          },
          decimatedFrames: predictedDrops.length,
          decimatedCycles: results.filter(
            ({ decimate }) =>
              decimate.cycleIndex === FFmpegIVTC.CYCLE - 1 &&
              decimate.nextDropIndex !== null,
          ).length,
          passedCycles: results.filter(
            ({ decimate }) =>
              decimate.cycleIndex === FFmpegIVTC.CYCLE - 1 &&
              decimate.nextDropIndex === null,
          ).length,
          comparison: {
            ffmpegDrops: ffmpegDrops.length,
            cycleMinimumDrops: cycleMinimumDrops.length,
            matchingCycleMinimumDrops: predictedDrops.filter((index) =>
              cycleMinimumSet.has(index),
            ).length,
            predictedAtDifferentPhase: predictedDrops.filter(
              (index) => !cycleMinimumSet.has(index),
            ),
            retainedByPrediction: cycleMinimumDrops.filter(
              (index) => !predictedSet.has(index),
            ),
            predictedDropScores,
            predictedDrops,
          },
          firstMatches: results
            .slice(0, 60)
            .map(({ fieldMatch }) => fieldMatch.match)
            .join(""),
        },
        null,
        2,
      ),
    );
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
