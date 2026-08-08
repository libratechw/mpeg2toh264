#!/usr/bin/env node

// Compare two or more wasm-bindgen Node builds over the same input, and check
// that they wrote the same thing.
//
// A change meant to be faster and not different is two claims, and this is
// what measures both at once: it hashes every fragment each build produced, so
// a speedup bought by accident -- a picture dropped, a fragment packed
// differently -- shows up as a hash that does not match rather than as a
// number that looks good.
//
// The builds take turns, rotating which goes first each round, because a
// machine that warms or throttles over a run would otherwise favour whichever
// was measured last. Report the mean and the best; on a machine with both
// performance and efficiency cores the best is the steadier of the two.
//
// Build the bindings to compare with:
//   cargo build --release --target wasm32-unknown-unknown -p mpeg2toh264-wasm
//   wasm-bindgen --target nodejs --out-dir DIR TARGET/mpeg2toh264_wasm.wasm
//
// and for a build to compare against, do the same in a worktree of the commit
// it should be measured against.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");

const [inputPath, roundsArg, ...specs] = process.argv.slice(2);
if (!inputPath || !roundsArg || specs.length < 1) {
  console.error(
    "usage: node tools/compare-wasm.cjs INPUT ROUNDS NAME=BINDINGS [NAME=BINDINGS ...]",
  );
  process.exit(2);
}

const rounds = Number(roundsArg);
const builds = specs.map((spec) => {
  const at = spec.indexOf("=");
  if (at < 0) {
    console.error(`expected NAME=BINDINGS, got '${spec}'`);
    process.exit(2);
  }
  return { name: spec.slice(0, at), bindings: spec.slice(at + 1) };
});
const input = fs.readFileSync(inputPath);

/** How much input one synchronous call takes, as the browser worker splits it. */
const CHUNK = 1 << 20;

function run(bindings) {
  const { Session } = require(bindings);
  const session = new Session();
  const hash = crypto.createHash("sha256");
  let videoSamples = 0;
  const started = performance.now();
  const take = (fragments) => {
    for (const fragment of fragments) {
      hash.update(fragment.data);
      if (fragment.kind === "media") videoSamples += fragment.videoSamples;
    }
  };
  for (let at = 0; at < input.length; at += CHUNK) {
    take(session.push(input.subarray(at, at + CHUNK)));
  }
  take(session.finish());
  const ms = performance.now() - started;
  session.free();
  return { ms, videoSamples, digest: hash.digest("hex") };
}

const times = new Map(builds.map((build) => [build.name, []]));
const digests = new Map();
let videoSamples = 0;
for (let round = 0; round < rounds; round += 1) {
  for (let index = 0; index < builds.length; index += 1) {
    const build = builds[(index + round) % builds.length];
    const result = run(build.bindings);
    times.get(build.name).push(result.ms);
    videoSamples = result.videoSamples;
    if (!digests.has(build.name)) digests.set(build.name, result.digest);
    else if (digests.get(build.name) !== result.digest) {
      console.error(`${build.name} did not produce the same output twice`);
      process.exit(1);
    }
    console.log(
      `round ${round} ${build.name}: ${result.ms.toFixed(0)} ms`.padEnd(40) +
        `${(result.videoSamples / (result.ms / 1000)).toFixed(0)} fps`,
    );
  }
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const base = mean(times.get(builds[0].name));
console.log();
console.log(`${input.length} bytes, ${videoSamples} video samples`);
for (const build of builds) {
  const ms = mean(times.get(build.name));
  console.log(
    `${build.name.padEnd(22)} mean ${ms.toFixed(0).padStart(7)} ms  ` +
      `best ${Math.min(...times.get(build.name))
        .toFixed(0)
        .padStart(7)} ms  ` +
      `${(((base - ms) / base) * 100).toFixed(1).padStart(6)}% vs ${builds[0].name}`,
  );
}

console.log();
for (const [name, digest] of digests) {
  console.log(`${name.padEnd(22)} ${digest.slice(0, 32)}`);
}
const distinct = new Set(digests.values()).size;
console.log(
  distinct === 1
    ? "output identical"
    : `OUTPUT DIFFERS -- ${distinct} distinct results, so the times are not comparable`,
);
process.exit(distinct === 1 ? 0 : 1);
