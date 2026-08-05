/**
 * Transcode an MPEG-2 stream's I pictures and measure the result against the
 * source, by decoding both with ffmpeg and comparing samples.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseElementaryStream } from "../src/mpeg2/headers.ts";
import { PictureType } from "../src/mpeg2/constants.ts";
import { transcodeIntraOnly } from "../src/transcode.ts";

const input = process.argv[2];
const oversample = Number(process.argv[3] ?? 2);
if (!input) throw new Error("usage: transcode.ts <in.m2v> [oversample]");

const data = new Uint8Array(readFileSync(input));
const pics = parseElementaryStream(data);
const width = pics[0]!.sequence.horizontalSize;
const height = pics[0]!.sequence.verticalSize;

const started = Date.now();
const result = transcodeIntraOnly(data, { oversample });
const elapsed = Date.now() - started;

console.log(`source      : ${input}  ${width}x${height}`);
console.log(
  `pictures    : ${result.picturesConverted} converted, ${result.picturesSkipped} skipped (not I)`,
);
console.log(`oversample  : ${oversample}x`);
console.log(`output      : ${result.bitstream.length} bytes in ${elapsed} ms`);
console.log(
  `worst coeff error: ${result.worstCoefficientError.toFixed(3)} (orthonormal DCT units)`,
);

const dir = mkdtempSync(join(tmpdir(), "transcode-"));
try {
  const h264 = join(dir, "out.h264");
  writeFileSync(h264, result.bitstream);

  // Decode both, keeping only the I pictures of the source so the frames line up.
  const srcYuv = join(dir, "src.yuv");
  const outYuv = join(dir, "out.yuv");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      input,
      "-vf",
      "select='eq(pict_type\\,I)'",
      "-vsync",
      "0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "yuv420p",
      srcYuv,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      h264,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "yuv420p",
      outYuv,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  const src = new Uint8Array(readFileSync(srcYuv));
  const outAll = new Uint8Array(readFileSync(outYuv));
  const frameSize = (width * height * 3) / 2;
  const lumaSize = width * height;
  // The first decoded picture is the all-grey reference frame, which exists
  // only to stand in for intra prediction and is not part of the content.
  const out = outAll.subarray(frameSize);
  const frames = Math.min(src.length, out.length) / frameSize;
  console.log(
    `decoded     : source ${src.length / frameSize} frames, ` +
      `output ${outAll.length / frameSize} frames (1 is the grey reference)`,
  );

  if (frames < 1) throw new Error("nothing decoded to compare");

  let sse = 0;
  let worst = 0;
  let count = 0;
  for (let f = 0; f < frames; f++) {
    const base = f * frameSize;
    for (let i = 0; i < lumaSize; i++) {
      const d = src[base + i]! - out[base + i]!;
      sse += d * d;
      if (Math.abs(d) > worst) worst = Math.abs(d);
      count++;
    }
  }
  const mse = sse / count;
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  console.log(
    `\nluma PSNR   : ${psnr === Infinity ? "lossless" : psnr.toFixed(2) + " dB"}`,
  );
  console.log(`worst sample error: ${worst}`);
  console.log(`mean squared error: ${mse.toFixed(4)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
