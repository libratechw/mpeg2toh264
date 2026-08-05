import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { transcode } from "../src/transcode.ts";

const input = process.argv[2];
const oversample = Number(process.argv[3] ?? 2);
if (!input || !Number.isFinite(oversample) || oversample <= 0) {
  throw new Error("usage: bench.ts <in.m2v> [oversample]");
}

const source = new Uint8Array(readFileSync(input));
const started = performance.now();
const result = transcode(source, { oversample });
const elapsed = performance.now() - started;
const fps = (result.picturesConverted * 1000) / elapsed;

console.log(
  `${result.picturesConverted} pictures, ${result.bitstream.length} bytes, ` +
    `${elapsed.toFixed(1)} ms, ${fps.toFixed(2)} fps`,
);
