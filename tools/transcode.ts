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
import { transcode } from "../src/transcode.ts";

const input = process.argv[2];
const oversample = Number(process.argv[3] ?? 2);
if (!input) throw new Error("usage: transcode.ts <in.m2v> [oversample]");

const data = new Uint8Array(readFileSync(input));
const pics = parseElementaryStream(data);
const width = pics[0]!.sequence.horizontalSize;
const height = pics[0]!.sequence.verticalSize;

const started = Date.now();
const result = transcode(data, { oversample });
const elapsed = Date.now() - started;

console.log(`source      : ${input}  ${width}x${height}`);
console.log(
  `pictures    : ${result.picturesConverted} converted, ` +
    `${result.picturesSkipped} skipped`,
);
const inter = result.interMacroblocks || 1;
const pc = (n: number) => `${((100 * n) / inter).toFixed(1)}%`;
console.log(
  `macroblocks : ${result.intraMacroblocks} intra, ${result.interMacroblocks} inter`,
);
console.log(
  `  integer vectors      ${String(result.integerVectors).padStart(7)}  ${pc(result.integerVectors).padStart(6)}  exact`,
);
console.log(
  `  half sample, 1 axis  ${String(result.singleAxisHalfVectors).padStart(7)}  ${pc(result.singleAxisHalfVectors).padStart(6)}  luma exact, chroma a quarter sample off`,
);
console.log(
  `  half sample, 2 axes  ${String(result.bothAxisHalfVectors).padStart(7)}  ${pc(result.bothAxisHalfVectors).padStart(6)}  both approximate`,
);
console.log(
  `  bidirectional        ${String(result.bidirectionalVectors).padStart(7)}  ${pc(result.bidirectionalVectors).padStart(6)}  both slots used, H.264 interpolates`,
);
console.log(`oversample  : ${oversample}x`);
console.log(`output      : ${result.bitstream.length} bytes in ${elapsed} ms`);

const dir = mkdtempSync(join(tmpdir(), "transcode-"));
try {
  const h264 = join(dir, "out.h264");
  writeFileSync(h264, result.bitstream);

  // Both sides now carry every picture, in display order.
  const srcYuv = join(dir, "src.yuv");
  const outYuv = join(dir, "out.yuv");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      input,
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

  const chromaSize = lumaSize / 4;
  /** Compare one plane across every frame. */
  function plane(offset: number, size: number) {
    let sse = 0;
    let worst = 0;
    for (let f = 0; f < frames; f++) {
      const base = f * frameSize + offset;
      for (let i = 0; i < size; i++) {
        const d = src[base + i]! - out[base + i]!;
        sse += d * d;
        if (Math.abs(d) > worst) worst = Math.abs(d);
      }
    }
    const mse = sse / (size * frames);
    return {
      psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
      worst,
      mse,
    };
  }

  const planes: [string, ReturnType<typeof plane>][] = [
    ["Y", plane(0, lumaSize)],
    ["Cb", plane(lumaSize, chromaSize)],
    ["Cr", plane(lumaSize + chromaSize, chromaSize)],
  ];
  console.log("");
  for (const [name, p] of planes) {
    const psnr = p.psnr === Infinity ? "lossless" : `${p.psnr.toFixed(2)} dB`;
    console.log(
      `${name.padEnd(3)} PSNR ${psnr.padStart(9)}   worst error ${String(p.worst).padStart(3)}   mse ${p.mse.toFixed(4)}`,
    );
  }

  // Per frame, to tell a systematic error apart from drift accumulating down a
  // chain of predicted pictures.
  console.log("\nper frame:            Y                 Cb                Cr");
  for (let f = 0; f < frames; f++) {
    const cells: string[] = [];
    for (const [offset, size] of [
      [0, lumaSize],
      [lumaSize, chromaSize],
      [lumaSize + chromaSize, chromaSize],
    ] as const) {
      let sse = 0;
      let worst = 0;
      const base = f * frameSize + offset;
      for (let i = 0; i < size; i++) {
        const d = src[base + i]! - out[base + i]!;
        sse += d * d;
        if (Math.abs(d) > worst) worst = Math.abs(d);
      }
      const mse = sse / size;
      const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
      cells.push(
        `${(psnr === Infinity ? "lossless" : psnr.toFixed(2)).padStart(8)} w${String(worst).padStart(3)}`,
      );
    }
    console.log(`  ${String(f).padStart(3)}  ${cells.join("  ")}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
