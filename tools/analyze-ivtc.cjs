#!/usr/bin/env node

// Measure the three field matches a browser IVTC pass can build from the same
// previous/current/next frame ring that the WebGL yadif filter already holds.
//
// ffmpeg only decodes and field-aware-scales the source here. Candidate
// selection below is deliberately independent of ffmpeg's fieldmatch filter,
// so its result can be compared with fieldmatch rather than echoing it.
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const [inputPath, start = "0", duration = "20"] = process.argv.slice(2);
if (!inputPath) {
  console.error("usage: node tools/analyze-ivtc.cjs INPUT [START] [DURATION]");
  process.exit(2);
}

// A small luma image is enough to classify cadence. Keeping both dimensions
// even preserves the two fields as separate sets of lines.
const WIDTH = 160;
const HEIGHT = 90;
const FRAME_BYTES = WIDTH * HEIGHT;
const COMB_THRESHOLD = 9;
const FILM_SCORE_THRESHOLD = 80;
const FILM_DUPLICATE_THRESHOLD = 255 * 0.011;

/** Read one pixel from a top-field-reference p/c/n weave candidate. */
function candidatePixel(previous, current, next, match, x, y) {
  // FFmpeg's top-field match keeps the current even rows and borrows the odd
  // rows from the previous or next frame for the p/n candidates.
  if ((y & 1) === 0 || match === "c") return current[y * WIDTH + x];
  const other = match === "p" ? previous : next;
  return other[y * WIDTH + x];
}

/** Reproduce fieldmatch's comb mask and overlapping 16 by 16 block score. */
function combScore(previous, current, next, match) {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const minus2 = candidatePixel(
        previous,
        current,
        next,
        match,
        x,
        Math.max(0, y - 2),
      );
      const minus1 = candidatePixel(
        previous,
        current,
        next,
        match,
        x,
        Math.max(0, y - 1),
      );
      const pixel = candidatePixel(previous, current, next, match, x, y);
      const plus1 = candidatePixel(
        previous,
        current,
        next,
        match,
        x,
        Math.min(HEIGHT - 1, y + 1),
      );
      const plus2 = candidatePixel(
        previous,
        current,
        next,
        match,
        x,
        Math.min(HEIGHT - 1, y + 2),
      );
      if (
        Math.abs(pixel - minus1) > COMB_THRESHOLD &&
        Math.abs(pixel - plus1) > COMB_THRESHOLD &&
        Math.abs(4 * pixel - 3 * (minus1 + plus1) + minus2 + plus2) >
          COMB_THRESHOLD * 6
      )
        mask[y * WIDTH + x] = 1;
    }
  }

  let score = 0;
  for (const yOffset of [0, 8]) {
    for (const xOffset of [0, 8]) {
      for (let blockY = yOffset; blockY < HEIGHT; blockY += 16) {
        for (let blockX = xOffset; blockX < WIDTH; blockX += 16) {
          let combed = 0;
          for (
            let y = Math.max(1, blockY);
            y < Math.min(HEIGHT - 1, blockY + 16);
            y++
          ) {
            for (let x = blockX; x < Math.min(WIDTH, blockX + 16); x++) {
              if (
                mask[(y - 1) * WIDTH + x] === 1 &&
                mask[y * WIDTH + x] === 1 &&
                mask[(y + 1) * WIDTH + x] === 1
              )
                combed++;
            }
          }
          score = Math.max(score, combed);
        }
      }
    }
  }
  return score;
}

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
    `scale=${WIDTH}:${HEIGHT}:interl=1,format=gray`,
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
const results = [];
const duplicateScores = [];
let previousCandidate = null;
let analysisMs = 0;

ffmpeg.stdout.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= FRAME_BYTES) {
    frames.push(pending.subarray(0, FRAME_BYTES));
    pending = pending.subarray(FRAME_BYTES);
    if (frames.length < 3) continue;

    const [previous, current, next] = frames;
    const analysisStarted = performance.now();
    const scores = Object.fromEntries(
      ["p", "c", "n"].map((match) => [
        match,
        combScore(previous, current, next, match),
      ]),
    );
    // Match FFmpeg's pc_n ordering: choose p/c first and use n only as a
    // substantially cleaner rescue for an otherwise combed match.
    let match = scores.p < scores.c ? "p" : "c";
    if (scores.n * 3 < scores[match] && scores.n <= FILM_SCORE_THRESHOLD)
      match = "n";
    const candidate = Buffer.allocUnsafe(FRAME_BYTES);
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        candidate[y * WIDTH + x] = candidatePixel(
          previous,
          current,
          next,
          match,
          x,
          y,
        );
      }
    }
    if (previousCandidate) {
      let difference = 0;
      for (let offset = 0; offset < FRAME_BYTES; offset += 1)
        difference += Math.abs(candidate[offset] - previousCandidate[offset]);
      duplicateScores.push({
        phase: results.length % 5,
        score: difference / FRAME_BYTES,
      });
    }
    previousCandidate = candidate;
    results.push({ match, score: scores[match], scores });
    analysisMs += performance.now() - analysisStarted;
    frames.shift();
  }
});

ffmpeg.on("close", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  if (pending.length !== 0) {
    console.error(`ffmpeg left ${pending.length} bytes of an incomplete frame`);
    process.exit(1);
  }

  const sortedScores = results
    .map((result) => result.score)
    .sort((a, b) => a - b);
  const percentile = (part) =>
    sortedScores[
      Math.min(sortedScores.length - 1, Math.floor(sortedScores.length * part))
    ] ?? 0;
  const matches = Object.fromEntries(
    ["p", "c", "n"].map((match) => [
      match,
      results.filter((result) => result.match === match).length,
    ]),
  );
  let longestVideoRun = 0;
  let videoRun = 0;
  let videoRunStart = 0;
  const videoRuns = [];
  for (const [index, result] of results.entries()) {
    // A moving real-interlaced section leaves comb energy in every weave.
    // Consecutive results matter more than an isolated edit or damaged frame.
    if (result.score > FILM_SCORE_THRESHOLD) {
      if (videoRun === 0) videoRunStart = index;
      videoRun += 1;
      longestVideoRun = Math.max(longestVideoRun, videoRun);
    } else {
      if (videoRun > 0)
        videoRuns.push({ startFrame: videoRunStart, frames: videoRun });
      videoRun = 0;
    }
  }
  if (videoRun > 0)
    videoRuns.push({ startFrame: videoRunStart, frames: videoRun });
  const duplicatePhaseAverage = Array.from({ length: 5 }, (_, phase) => {
    const scores = duplicateScores.filter((sample) => sample.phase === phase);
    if (scores.length === 0) return Infinity;
    return (
      scores.reduce((total, sample) => total + sample.score, 0) / scores.length
    );
  });
  const sortedDuplicatePhases = duplicatePhaseAverage.toSorted(
    (first, second) => first - second,
  );
  const duplicate = sortedDuplicatePhases[0] ?? Infinity;
  const runnerUp = sortedDuplicatePhases[1] ?? Infinity;
  const classification =
    duplicate <= FILM_DUPLICATE_THRESHOLD &&
    runnerUp >= Math.max(1, duplicate * 2)
      ? "film"
      : "video";
  console.log(
    JSON.stringify(
      {
        input: inputPath,
        start: Number(start),
        duration: Number(duration),
        analyzedFrames: results.length,
        analysisFrameMs: results.length === 0 ? 0 : analysisMs / results.length,
        matches,
        score: {
          median: percentile(0.5),
          p90: percentile(0.9),
          p99: percentile(0.99),
        },
        filmScoreThreshold: FILM_SCORE_THRESHOLD,
        filmLikeFrames: results.filter(
          (result) => result.score <= FILM_SCORE_THRESHOLD,
        ).length,
        longestVideoRun,
        longestVideoRuns: videoRuns
          .sort((first, second) => second.frames - first.frames)
          .slice(0, 5),
        firstMatches: results
          .slice(0, 60)
          .map((result) => result.match)
          .join(""),
        duplicatePhaseAverage,
        classification,
      },
      null,
      2,
    ),
  );
});
