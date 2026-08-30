#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const [inputPath, start = "0", duration = "20", requestedFieldOrder] =
  process.argv.slice(2);
if (!inputPath) {
  console.error(
    "usage: node tools/analyze-ivtc.cjs INPUT [START] [DURATION] [tff|bff]",
  );
  process.exit(2);
}

const WIDTH = 160;
const HEIGHT = 90;
const FRAME_BYTES = WIDTH * HEIGHT * 4;

/** 明示値または入力ストリームのヘッダーからフィールド順を決定する。 */
function topFieldFirst() {
  if (requestedFieldOrder === "tff") return true;
  if (requestedFieldOrder === "bff") return false;
  if (requestedFieldOrder !== undefined)
    throw new Error("field order must be tff or bff");
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
        "-i",
        inputPath,
        "-ss",
        start,
        "-t",
        duration,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `scale=${WIDTH}:${HEIGHT}:flags=neighbor:interl=1,format=rgba`,
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
    let analysisMs = 0;
    const code = await new Promise((resolve, reject) => {
      ffmpeg.once("error", reject);
      ffmpeg.stdout.on("data", (chunk) => {
        try {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= FRAME_BYTES) {
            frames.push(pending.subarray(0, FRAME_BYTES));
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
            results.push({ fieldMatch, decimate });
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
    console.log(
      JSON.stringify(
        {
          input: inputPath,
          start: Number(start),
          duration: Number(duration),
          fieldOrder: isTopFieldFirst ? "tff" : "bff",
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
          decimatedFrames: results.filter(
            ({ fieldMatch, decimate }) =>
              decimate.shouldDrop && !fieldMatch.isCombed,
          ).length,
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
