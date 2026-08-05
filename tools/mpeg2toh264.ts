#!/usr/bin/env -S node --experimental-strip-types

import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { h264ToFmp4, mpeg2VideoTimeline } from "../src/fmp4.ts";
import { extractMpeg2VideoEs, isMpegTransportStream } from "../src/mpegts.ts";
import { transcode, type TranscodeOptions } from "../src/transcode.ts";

const USAGE = `Usage: mpeg2toh264 [options] <input.ts|input.m2v> <output.h264|output.mp4>

Transcode an MPEG transport stream or MPEG-2 video elementary stream to raw
Annex B H.264 or video-only fragmented MP4. The output format is selected from
the output extension. The first MPEG-2 video program in a TS is selected.

Arguments:
  input.ts|input.m2v        MPEG-TS or MPEG-2 video elementary stream
  output.h264|output.mp4    Raw H.264/AVC or timestamped fragmented MP4

Options:
  -o, --oversample <n>      Quantiser search oversampling factor (default: 2)
      --i-frames-only       Convert MPEG-2 I pictures only
  -q, --quiet               Do not print the conversion summary
  -h, --help                Show this help
`;

interface CliOptions extends TranscodeOptions {
  input: string;
  output: string;
  quiet: boolean;
}

function fail(message: string): never {
  process.stderr.write(
    `mpeg2toh264: ${message}\nTry 'mpeg2toh264 --help' for usage.\n`,
  );
  process.exit(2);
}

export function parseArgs(args: string[]): CliOptions {
  const positional: string[] = [];
  let oversample = 2;
  let iFramesOnly = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (arg === "--i-frames-only") {
      iFramesOnly = true;
      continue;
    }
    if (arg === "-q" || arg === "--quiet") {
      quiet = true;
      continue;
    }
    if (arg === "-o" || arg === "--oversample") {
      const value = args[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      oversample = Number(value);
      continue;
    }
    if (arg.startsWith("--oversample=")) {
      oversample = Number(arg.slice("--oversample=".length));
      continue;
    }
    if (arg.startsWith("-")) fail(`unknown option '${arg}'`);
    positional.push(arg);
  }

  if (!Number.isFinite(oversample) || oversample <= 0) {
    fail(`oversample must be a positive number, got '${oversample}'`);
  }
  if (positional.length !== 2) {
    fail(
      `expected input and output paths, got ${positional.length} positional argument(s)`,
    );
  }
  const input = resolve(positional[0]!);
  const output = resolve(positional[1]!);
  if (input === output) fail("input and output must be different files");
  return { input, output, oversample, iFramesOnly, quiet };
}

function main(): void {
  const { input, output, quiet, ...options } = parseArgs(process.argv.slice(2));
  const container = new Uint8Array(readFileSync(input));
  const transportStream = isMpegTransportStream(container);
  const source = transportStream ? extractMpeg2VideoEs(container) : container;
  const started = performance.now();
  const result = transcode(source, options);
  const elapsed = performance.now() - started;
  let outputData = result.bitstream;
  let outputKind = "raw H.264";
  if (extname(output).toLowerCase() === ".mp4") {
    const mp4 = h264ToFmp4(result.bitstream, mpeg2VideoTimeline(source));
    outputData = new Uint8Array(
      mp4.initSegment.length + mp4.mediaSegment.length,
    );
    outputData.set(mp4.initSegment);
    outputData.set(mp4.mediaSegment, mp4.initSegment.length);
    outputKind = "fragmented MP4";
  }
  writeFileSync(output, outputData);

  if (!quiet) {
    const fps = (result.picturesConverted * 1000) / elapsed;
    process.stdout.write(
      `${input} (${transportStream ? "MPEG-TS" : "MPEG-2 ES"}) -> ${output} (${outputKind})\n` +
        `${result.picturesConverted} pictures converted, ` +
        `${result.picturesSkipped} skipped, ${outputData.length} bytes, ` +
        `${elapsed.toFixed(1)} ms (${fps.toFixed(2)} fps)\n`,
    );
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mpeg2toh264: ${message}\n`);
  process.exitCode = 1;
}
