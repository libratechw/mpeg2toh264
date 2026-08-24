#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const [inputPath, start = "0", duration = "20"] = process.argv.slice(2);
if (!inputPath) {
  console.error("usage: node tools/analyze-ivtc.cjs INPUT [START] [DURATION]");
  process.exit(2);
}

const WIDTH = 160;
const HEIGHT = 90;
const FRAME_BYTES = WIDTH * HEIGHT * 4;

async function main() {
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
        "-t",
        duration,
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `scale=${WIDTH}:${HEIGHT}:interl=1,format=rgba`,
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
              true,
            );
            const decimate = ivtc.decimate(
              ivtc.weave(
                frames[0],
                frames[1],
                frames[2],
                fieldMatch.match,
                true,
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
    const percentile = (part) =>
      combScores[
        Math.min(combScores.length - 1, Math.floor(combScores.length * part))
      ] ?? 0;
    console.log(
      JSON.stringify(
        {
          input: inputPath,
          start: Number(start),
          duration: Number(duration),
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
