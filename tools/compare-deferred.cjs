#!/usr/bin/env node

// Drive one build both ways -- converting the pictures inside the session, and
// converting them outside it through `pushDeferred` -- and check that the two
// agree.
//
// The deferred path is what a worker pool drives, and this runs it with a
// single encoder in this process: no parallelism, so what it measures is what
// the split itself costs, and what it checks is that taking the pictures out
// of the session does not change what comes out of it.
//
// That check is the point. The video is the same either way whatever happens,
// so a fault here hides in the audio: how many AAC frames a fragment carries
// is worked out from what has arrived by the time its group of pictures goes
// out, so a driver that takes input in at a different rate packs the fragments
// differently and the files diverge with every picture still intact. Give it a
// recording with an audio track; a video-only one cannot fail.
//
// Build the bindings with:
//   cargo build --release --target wasm32-unknown-unknown -p mpeg2toh264-wasm
//   wasm-bindgen --target nodejs --out-dir DIR TARGET/mpeg2toh264_wasm.wasm
const fs = require("node:fs");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");

const [bindings, inputPath, roundsArg = "3"] = process.argv.slice(2);
if (!bindings || !inputPath) {
  console.error(
    "usage: node tools/compare-deferred.cjs BINDINGS INPUT [ROUNDS]",
  );
  process.exit(2);
}

const rounds = Number(roundsArg);
const { Session, PictureEncoder } = require(bindings);
const input = fs.readFileSync(inputPath);

/** How much input one synchronous call takes, as the browser worker splits it. */
const CHUNK = 1 << 20;

function sequential() {
  const session = new Session();
  const hash = crypto.createHash("sha256");
  const started = performance.now();
  const take = (fragments) => {
    for (const fragment of fragments) hash.update(fragment.data);
  };
  for (let at = 0; at < input.length; at += CHUNK) {
    take(session.push(input.subarray(at, at + CHUNK)));
  }
  take(session.finish());
  const ms = performance.now() - started;
  session.free();
  return { ms, digest: hash.digest("hex") };
}

function deferred() {
  const session = new Session();
  const encoder = new PictureEncoder();
  const hash = crypto.createHash("sha256");
  let jobs = 0;
  let jobBytes = 0;
  const started = performance.now();
  // Completing a unit lets the session reach the one behind it, so this runs
  // down everything that is ready rather than one unit per call.
  const drive = (progress) => {
    for (;;) {
      for (const fragment of progress.fragments) hash.update(fragment.data);
      if (progress.jobs.length === 0) return;
      jobs += progress.jobs.length;
      const outputs = progress.jobs.map((job) => {
        jobBytes += job.byteLength;
        return encoder.encode(job);
      });
      progress = session.complete(outputs);
    }
  };
  for (let at = 0; at < input.length; at += CHUNK) {
    drive(session.pushDeferred(input.subarray(at, at + CHUNK)));
  }
  drive(session.finishDeferred());
  const ms = performance.now() - started;
  session.free();
  encoder.free();
  return { ms, digest: hash.digest("hex"), jobs, jobBytes };
}

const results = { sequential: [], deferred: [] };
const digests = {};
let shape = null;
for (let round = 0; round < rounds; round += 1) {
  // Taking turns, so a machine that warms over the run favours neither.
  const order =
    round % 2 === 0 ? ["sequential", "deferred"] : ["deferred", "sequential"];
  for (const which of order) {
    const result = which === "sequential" ? sequential() : deferred();
    results[which].push(result.ms);
    digests[which] ??= result.digest;
    if (which === "deferred") shape ??= result;
    console.log(
      `round ${round} ${which.padEnd(10)} ${result.ms.toFixed(0)} ms`,
    );
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const inside = mean(results.sequential);
const outside = mean(results.deferred);
console.log();
console.log(`inside the session  ${inside.toFixed(0).padStart(7)} ms`);
console.log(`outside it          ${outside.toFixed(0).padStart(7)} ms`);
console.log(
  `the split costs     ${(outside - inside).toFixed(0).padStart(7)} ms ` +
    `(${(((outside - inside) / inside) * 100).toFixed(1)}%) on one thread`,
);
console.log(
  `${shape.jobs} jobs, ${(shape.jobBytes / (1 << 20)).toFixed(1)} MiB of job bytes ` +
    `for a ${(input.length / (1 << 20)).toFixed(1)} MiB input`,
);
const agree = digests.sequential === digests.deferred;
console.log(
  agree
    ? "output identical"
    : "OUTPUT DIFFERS -- the two paths do not produce the same file",
);
process.exit(agree ? 0 : 1);
