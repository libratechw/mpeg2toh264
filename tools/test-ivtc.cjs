#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const WIDTH = 160;
const HEIGHT = 90;
const LUMA_BYTES = WIDTH * HEIGHT;
const YUV420_BYTES = (LUMA_BYTES * 3) / 2;

/** Build a moving progressive picture with enough structure to match fields. */
function makeFilmFrame(index) {
  const frame = new Uint8Array(LUMA_BYTES);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const bar = (x + index * 7) % 48 < 19 ? 180 : 35;
      frame[y * WIDTH + x] = (bar + ((y * 3 + index * 11) % 41)) & 255;
    }
  }
  return frame;
}

/** Pair film fields into two 3:2 pulldown cycles in the requested field order. */
function makeTelecineFrames(isTopFieldFirst) {
  const filmFrames = Array.from({ length: 8 }, (_, index) =>
    makeFilmFrame(index),
  );
  const pairs = [
    [0, 0],
    [1, 1],
    [1, 2],
    [2, 3],
    [3, 3],
    [4, 4],
    [5, 5],
    [5, 6],
    [6, 7],
    [7, 7],
  ];
  return pairs.map(([first, second]) => {
    const frame = new Uint8Array(LUMA_BYTES);
    for (let y = 0; y < HEIGHT; y++) {
      const isFirstField = (y % 2 === 0) === isTopFieldFirst;
      const source = filmFrames[isFirstField ? first : second];
      frame.set(source.subarray(y * WIDTH, (y + 1) * WIDTH), y * WIDTH);
    }
    return frame;
  });
}

/** Run FFmpeg fieldmatch over neutral-chroma YUV and return output luma. */
function fieldmatchWithFFmpeg(frames, isTopFieldFirst) {
  const input = Buffer.concat(
    frames.map((luma) =>
      Buffer.concat([Buffer.from(luma), Buffer.alloc(LUMA_BYTES / 2, 128)]),
    ),
  );
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "rawvideo",
      "-pixel_format",
      "yuv420p",
      "-video_size",
      `${WIDTH}x${HEIGHT}`,
      "-framerate",
      "30000/1001",
      "-i",
      "pipe:0",
      "-vf",
      `fieldmatch=order=${isTopFieldFirst ? "tff" : "bff"}:mode=pc_n:combmatch=full:mchroma=0`,
      "-pix_fmt",
      "yuv420p",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { input, maxBuffer: input.length * 2 },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.toString());
  return frames.map((_, index) =>
    result.stdout.subarray(
      index * YUV420_BYTES,
      index * YUV420_BYTES + LUMA_BYTES,
    ),
  );
}

async function main() {
  // Vite loads the TypeScript source in memory, so the test exercises the
  // implementation shipped in the package without a second test-only port
  const { createServer } = await import("vite");
  const server = await createServer({
    root: "packages/yadif",
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const { FFmpegIVTC } = await server.ssrLoadModule("/src/ivtc.ts");
    const { FILM_ANALYSIS_WIDTH, FILM_ANALYSIS_HEIGHT } =
      await server.ssrLoadModule("/src/shader.ts");
    assert.equal(FILM_ANALYSIS_WIDTH, 288);
    assert.equal(FILM_ANALYSIS_HEIGHT, 162);
    for (const isTopFieldFirst of [true, false]) {
      const telecine = makeTelecineFrames(isTopFieldFirst);
      const ffmpegMatches = fieldmatchWithFFmpeg(telecine, isTopFieldFirst);
      const fieldMatcher = new FFmpegIVTC(WIDTH, HEIGHT);
      for (let index = 0; index < telecine.length; index++) {
        const result = fieldMatcher.fieldMatch(
          telecine[Math.max(0, index - 1)],
          telecine[index],
          telecine[Math.min(telecine.length - 1, index + 1)],
          isTopFieldFirst,
        );
        assert.deepEqual(
          result.luma,
          new Uint8Array(ffmpegMatches[index]),
          `fieldmatch output differs at frame ${index}`,
        );
        assert.equal(result.isCombed, false);
      }
    }

    // The first complete cycle establishes FFmpeg decimate's lowest duplicate
    // phase; the live path then drops that phase in the following cycle only
    // when its current block metric remains below dupthresh
    const decimator = new FFmpegIVTC(WIDTH, HEIGHT);
    const levels = [20, 60, 100, 140, 140, 20, 60, 100, 140, 140];
    const decisions = levels.map((level) =>
      decimator.decimate(new Uint8Array(LUMA_BYTES).fill(level)),
    );
    assert.equal(decisions[4].nextDropIndex, 4);
    assert.equal(decisions[4].lowestCycleDifference, 0);
    assert.equal(decisions[4].runnerUpCycleDifference, 40960);
    assert.equal(decisions[9].shouldDrop, true);
    assert.equal(decisions.filter(({ shouldDrop }) => shouldDrop).length, 1);

    // FFmpeg counts neutral RGB noise once through luma. A two-level change in
    // a 32 by 32 area remains below the default 1.1 percent duplicate boundary.
    const noisyDecimator = new FFmpegIVTC(WIDTH, HEIGHT);
    const noisyLevels = [20, 80, 140, 200, 202, 20, 80, 140, 200, 202];
    const noisyDecisions = noisyLevels.map((level) =>
      noisyDecimator.decimate(
        new Uint8Array(LUMA_BYTES * 4).map((_, offset) =>
          offset % 4 === 3 ? 255 : level,
        ),
      ),
    );
    assert.equal(noisyDecisions[4].maxBlockDifference, 2048);
    assert.equal(noisyDecisions[4].nextDropIndex, 4);
    assert.equal(noisyDecisions[9].maxBlockDifference, 2048);
    assert.equal(noisyDecisions[9].shouldDrop, true);

    // Three luma levels across one complete block exceed dupthresh, retaining
    // the distinct-frame side of the same FFmpeg decision boundary
    const changedDecimator = new FFmpegIVTC(WIDTH, HEIGHT);
    const changedLevels = [20, 80, 140, 200, 203];
    const changedDecisions = changedLevels.map((level) =>
      changedDecimator.decimate(
        new Uint8Array(LUMA_BYTES * 4).map((_, offset) =>
          offset % 4 === 3 ? 255 : level,
        ),
      ),
    );
    assert.equal(changedDecisions[4].maxBlockDifference, 3072);
    assert.equal(changedDecisions[4].nextDropIndex, null);

    // A stale phase recommendation cannot discard a distinct frame after a
    // content transition, even before the new mixed cycle is complete
    decimator.reset();
    for (const level of [20, 60, 100, 140, 140])
      decimator.decimate(new Uint8Array(LUMA_BYTES).fill(level));
    const transitioned = [20, 60, 100, 140, 200].map((level) =>
      decimator.decimate(new Uint8Array(LUMA_BYTES).fill(level)),
    );
    assert.equal(transitioned[4].shouldDrop, false);
    assert.equal(transitioned[4].nextDropIndex, null);

    // Preserve a shifted cadence and relock when that phase repeats next cycle
    decimator.reset();
    for (const level of [20, 60, 100, 140, 140])
      decimator.decimate(new Uint8Array(LUMA_BYTES).fill(level));
    const shifted = [20, 60, 100, 100, 140].map((level) =>
      decimator.decimate(new Uint8Array(LUMA_BYTES).fill(level)),
    );
    assert.equal(
      shifted.some(({ shouldDrop }) => shouldDrop),
      false,
    );
    assert.equal(shifted[4].nextDropIndex, 3);
    const relocked = [20, 60, 100, 100, 140].map((level) =>
      decimator.decimate(new Uint8Array(LUMA_BYTES).fill(level)),
    );
    assert.deepEqual(
      relocked.flatMap(({ shouldDrop }, index) => (shouldDrop ? [index] : [])),
      [3],
    );

    // Continuously distinct 60i-like frames establish no phase and all survive
    const videoDecimator = new FFmpegIVTC(WIDTH, HEIGHT);
    const videoDecisions = Array.from({ length: 20 }, (_, index) =>
      videoDecimator.decimate(
        new Uint8Array(LUMA_BYTES).fill((index * 47) & 255),
      ),
    );
    assert.equal(
      videoDecisions.some(({ shouldDrop }) => shouldDrop),
      false,
    );
    assert.equal(videoDecisions.at(-1).nextDropIndex, null);

    // Browser decimation receives the selected RGB weave, retaining FFmpeg's
    // chroma-sensitive intent for colour-only animation changes
    const colourDecimator = new FFmpegIVTC(WIDTH, HEIGHT);
    const rgba = (red, green, blue) => {
      const sample = new Uint8Array(LUMA_BYTES * 4);
      for (let pixel = 0; pixel < LUMA_BYTES; pixel++) {
        const offset = pixel * 4;
        sample[offset] = red;
        sample[offset + 1] = green;
        sample[offset + 2] = blue;
        sample[offset + 3] = 255;
      }
      return sample;
    };
    for (const colour of [
      [20, 20, 20],
      [60, 60, 60],
      [100, 100, 100],
      [140, 20, 20],
      [140, 20, 20],
    ])
      colourDecimator.decimate(rgba(...colour));
    const colourCycle = [
      [20, 20, 20],
      [60, 60, 60],
      [100, 100, 100],
      [140, 20, 20],
      [20, 140, 20],
    ].map((colour) => colourDecimator.decimate(rgba(...colour)));
    assert.equal(colourCycle[4].shouldDrop, false);

    // combmatch=full returns an unresolved combed picture as c so the caller
    // can send the untouched frame to yadif=deint=interlaced
    const combed = new Uint8Array(LUMA_BYTES);
    for (let y = 0; y < HEIGHT; y++)
      combed.fill(y % 2 === 0 ? 0 : 255, y * WIDTH, (y + 1) * WIDTH);
    const fieldMatcher = new FFmpegIVTC(WIDTH, HEIGHT);
    const combedResult = fieldMatcher.fieldMatch(combed, combed, combed, true);
    assert.equal(combedResult.match, "c");
    assert.equal(combedResult.isCombed, true);
    assert.deepEqual(combedResult.luma, combed);

    // The public comb threshold is inclusive: crossing it changes the
    // externally visible fieldmatch decision without changing the input.
    assert.equal(FFmpegIVTC.COMBED_PIXEL_LIMIT, 80);
    assert.equal(combedResult.combScore, 256);
    const thresholdBoundary = new FFmpegIVTC(WIDTH, HEIGHT);
    const atLimit = thresholdBoundary.fieldMatch(
      combed,
      combed,
      combed,
      true,
      combedResult.combScore,
    );
    const aboveLimit = thresholdBoundary.fieldMatch(
      combed,
      combed,
      combed,
      true,
      combedResult.combScore + 1,
    );
    assert.equal(atLimit.isCombed, true);
    assert.equal(aboveLimit.isCombed, false);
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
