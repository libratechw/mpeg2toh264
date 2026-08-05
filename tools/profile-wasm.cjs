#!/usr/bin/env node

// Run a transport stream through the wasm-bindgen Node target. This is kept
// deliberately small so Node's --cpu-prof samples the transcoder, not a test
// framework or browser UI.
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");

const [bindingsPath, inputPath, iterationsArg = "1", chunkSizeArg = "1048576"] =
  process.argv.slice(2);
if (!bindingsPath || !inputPath) {
  console.error(
    "usage: node tools/profile-wasm.cjs BINDINGS INPUT [ITERATIONS] [CHUNK_SIZE]",
  );
  process.exit(2);
}

const { Session } = require(bindingsPath);
const input = fs.readFileSync(inputPath);
const iterations = Number(iterationsArg);
const chunkSize = Number(chunkSizeArg);

let outputBytes = 0;
let mediaFragments = 0;
const samples = [];
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const session = new Session();
  const started = performance.now();
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    const fragments = session.push(input.subarray(offset, offset + chunkSize));
    for (const fragment of fragments) {
      outputBytes += fragment.data.byteLength;
      mediaFragments += fragment.kind === "media" ? 1 : 0;
    }
  }
  for (const fragment of session.finish()) {
    outputBytes += fragment.data.byteLength;
    mediaFragments += fragment.kind === "media" ? 1 : 0;
  }
  session.free();
  samples.push(performance.now() - started);
}

const measured = samples.length > 1 ? samples.slice(1) : samples;
const meanMs = measured.reduce((sum, ms) => sum + ms, 0) / measured.length;
console.log(
  JSON.stringify({
    input: inputPath,
    inputBytes: input.byteLength,
    iterations,
    chunkSize,
    samplesMs: samples.map((ms) => Number(ms.toFixed(2))),
    warmMeanMs: Number(meanMs.toFixed(2)),
    warmMiBPerSecond: Number(
      (input.byteLength / 1048576 / (meanMs / 1000)).toFixed(2),
    ),
    outputBytes,
    mediaFragments,
  }),
);
