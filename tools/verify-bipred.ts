/**
 * Test the central claim of the motion vector mapping.
 *
 * MPEG-2's half-sample prediction is a bilinear average of two adjacent integer
 * samples, (a + b + 1) >> 1. H.264's default bi-prediction averages its two list
 * predictions the same way, (P0 + P1 + 1) >> 1, after clipping. So pointing both
 * lists at the same reference picture, one at integer offset n and the other at
 * n + 1, should reproduce MPEG-2's half-sample filter exactly -- without going
 * anywhere near H.264's own six-tap interpolation.
 *
 * This builds a stream that does precisely that: an IDR of known random samples
 * written as I_PCM, then a bi-predicted picture with no residual. If the claim
 * holds, every decoded sample matches the bilinear average computed here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BitWriter, NalType, toNalUnit } from "../src/h264/bitwriter.ts";
import { frameGeometry, writePps, writeSps } from "../src/h264/params.ts";
import { SliceType, writeSliceHeader } from "../src/h264/slice.ts";

const WIDTH = 64;
const HEIGHT = 64;
const LOG2_MAX_FRAME_NUM = 8;
const LOG2_MAX_POC_LSB = 16;
const QP = 26;

const g = frameGeometry(WIDTH, HEIGHT, true);

/**
 * Deterministic sample content, so a failure can be reproduced. 'harsh' is a
 * worst case for interpolation -- hard edges every four samples plus noise --
 * while 'smooth' is closer to the band-limited content real video carries.
 */
function referenceSamples(kind: "harsh" | "smooth" = "harsh"): {
  luma: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
} {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed >>> 16;
  };
  const luma = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (kind === "harsh") {
        const edge = x % 8 < 4 ? 40 : 210;
        luma[y * WIDTH + x] = ((edge + (rand() & 31) + y * 2) % 220) + 16;
      } else {
        const v =
          128 +
          60 * Math.sin((x / 11) * Math.PI) * Math.cos((y / 13) * Math.PI) +
          25 * Math.sin(((x + y) / 7) * Math.PI) +
          (rand() & 3);
        luma[y * WIDTH + x] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  const cb = new Uint8Array((WIDTH * HEIGHT) / 4).fill(110);
  const cr = new Uint8Array((WIDTH * HEIGHT) / 4).fill(140);
  return { luma, cb, cr };
}

/** An IDR whose macroblocks carry raw samples, giving an exactly known reference. */
function writePcmIdr(s: ReturnType<typeof referenceSamples>): Uint8Array {
  const w = new BitWriter(1 << 16);
  writeSliceHeader(w, {
    firstMbInSlice: 0,
    sliceType: SliceType.I,
    frameNum: 0,
    log2MaxFrameNum: LOG2_MAX_FRAME_NUM,
    picOrderCntLsb: 0,
    log2MaxPocLsb: LOG2_MAX_POC_LSB,
    idr: true,
    idrPicId: 0,
    reference: true,
    longTermReference: false,
    mbaff: false,
    sliceQp: QP,
    ppsInitQp: QP,
    disableDeblockingFilterIdc: 1,
  });

  for (let mbY = 0; mbY < g.mbHeight; mbY++) {
    for (let mbX = 0; mbX < g.mbWidth; mbX++) {
      w.ue(25); // mb_type 25 in an I slice is I_PCM
      while (!w.isByteAligned) w.u(1, 0); // pcm_alignment_zero_bit
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          w.u(8, s.luma[(mbY * 16 + y) * WIDTH + mbX * 16 + x]!);
        }
      }
      for (const plane of [s.cb, s.cr]) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            w.u(8, plane[(mbY * 8 + y) * (WIDTH / 2) + mbX * 8 + x]!);
          }
        }
      }
    }
  }
  w.rbspTrailingBits();
  return toNalUnit(w.bytes(), 3, NalType.SLICE_IDR);
}

/**
 * A B picture where every macroblock is bi-predicted from the one reference,
 * with list 0 at `mv0` and list 1 at `mv1`, both in whole samples.
 */
function writeBiPredictedPicture(
  mv0: [number, number],
  mv1: [number, number],
  /** Quarter-sample units, for probing H.264's own interpolation. */
  quarterPel = false,
  /** Predict from list 0 only, so H.264's six-tap filter is what runs. */
  uniPredicted = false,
): Uint8Array {
  const w = new BitWriter(1 << 14);
  writeSliceHeader(w, {
    firstMbInSlice: 0,
    sliceType: SliceType.B,
    frameNum: 1,
    log2MaxFrameNum: LOG2_MAX_FRAME_NUM,
    picOrderCntLsb: 2,
    log2MaxPocLsb: LOG2_MAX_POC_LSB,
    idr: false,
    reference: false,
    mbaff: false,
    sliceQp: QP,
    ppsInitQp: QP,
    disableDeblockingFilterIdc: 1,
  });

  // Motion vectors are in quarter samples, so whole-sample offsets scale by 4.
  const unit = quarterPel ? 1 : 4;
  const q0: [number, number] = [mv0[0] * unit, mv0[1] * unit];
  const q1: [number, number] = [mv1[0] * unit, mv1[1] * unit];

  for (let mb = 0; mb < g.mbWidth * g.mbHeight; mb++) {
    w.ue(0); // mb_skip_run
    w.ue(uniPredicted ? 1 : 3); // 1 is B_L0_16x16, 3 is B_Bi_16x16
    // Every macroblock carries the same vectors, so once a neighbour exists the
    // median predictor already returns them and the difference is zero. Only
    // the first macroblock, which has no neighbours, predicts zero.
    const first = mb === 0;
    w.se(first ? q0[0] : 0);
    w.se(first ? q0[1] : 0);
    if (!uniPredicted) {
      w.se(first ? q1[0] : 0);
      w.se(first ? q1[1] : 0);
    }
    w.ue(0); // coded_block_pattern: codeNum 0 is cbp 0 for inter
  }
  w.rbspTrailingBits();
  return toNalUnit(w.bytes(), 0, NalType.SLICE_NON_IDR);
}

/** MPEG-2's prediction for a half-sample offset, clause 7.6.4. */
function mpeg2Predict(
  ref: Uint8Array,
  width: number,
  height: number,
  intX: number,
  intY: number,
  halfX: boolean,
  halfY: boolean,
): Uint8Array {
  const at = (x: number, y: number) => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    return ref[cy * width + cx]!;
  };
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x + intX;
      const sy = y + intY;
      let v: number;
      if (halfX && halfY)
        v =
          (at(sx, sy) +
            at(sx + 1, sy) +
            at(sx, sy + 1) +
            at(sx + 1, sy + 1) +
            2) >>
          2;
      else if (halfX) v = (at(sx, sy) + at(sx + 1, sy) + 1) >> 1;
      else if (halfY) v = (at(sx, sy) + at(sx, sy + 1) + 1) >> 1;
      else v = at(sx, sy);
      out[y * width + x] = v;
    }
  }
  return out;
}

const samples = referenceSamples();
const sps = writeSps({
  width: WIDTH,
  height: HEIGHT,
  levelIdc: 30,
  frameMbsOnly: true,
  maxNumRefFrames: 2,
  log2MaxFrameNumMinus4: LOG2_MAX_FRAME_NUM - 4,
  log2MaxPocLsbMinus4: LOG2_MAX_POC_LSB - 4,
});
const pps = writePps({
  initQp: QP,
  scaling8x8Intra: null,
  scaling8x8Inter: null,
});

interface Case {
  name: string;
  mv0: [number, number];
  mv1: [number, number];
  intX: number;
  intY: number;
  halfX: boolean;
  halfY: boolean;
}

const cases: Case[] = [
  {
    name: "integer (0,0)",
    mv0: [0, 0],
    mv1: [0, 0],
    intX: 0,
    intY: 0,
    halfX: false,
    halfY: false,
  },
  {
    name: "integer (3,-2)",
    mv0: [3, -2],
    mv1: [3, -2],
    intX: 3,
    intY: -2,
    halfX: false,
    halfY: false,
  },
  {
    name: "half-pel horizontal at 0",
    mv0: [0, 0],
    mv1: [1, 0],
    intX: 0,
    intY: 0,
    halfX: true,
    halfY: false,
  },
  {
    name: "half-pel horizontal at 5",
    mv0: [5, 0],
    mv1: [6, 0],
    intX: 5,
    intY: 0,
    halfX: true,
    halfY: false,
  },
  {
    name: "half-pel horizontal at -4",
    mv0: [-4, 0],
    mv1: [-3, 0],
    intX: -4,
    intY: 0,
    halfX: true,
    halfY: false,
  },
  {
    name: "half-pel vertical at 2",
    mv0: [0, 2],
    mv1: [0, 3],
    intX: 0,
    intY: 2,
    halfX: false,
    halfY: true,
  },
  {
    name: "half-pel vertical at -6",
    mv0: [1, -6],
    mv1: [1, -5],
    intX: 1,
    intY: -6,
    halfX: false,
    halfY: true,
  },
];

const dir = mkdtempSync(join(tmpdir(), "bipred-"));
let failures = 0;
try {
  for (const c of cases) {
    const parts = [
      sps,
      pps,
      writePcmIdr(samples),
      writeBiPredictedPicture(c.mv0, c.mv1),
    ];
    let total = 0;
    for (const p of parts) total += p.length;
    const stream = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      stream.set(p, at);
      at += p.length;
    }

    const h264 = join(dir, "in.h264");
    const yuv = join(dir, "out.yuv");
    writeFileSync(h264, stream);
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        h264,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuv420p",
        yuv,
      ],
      {
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    const decoded = new Uint8Array(readFileSync(yuv));
    const frameSize = (WIDTH * HEIGHT * 3) / 2;
    const got = decoded.subarray(frameSize, frameSize + WIDTH * HEIGHT);

    const want = mpeg2Predict(
      samples.luma,
      WIDTH,
      HEIGHT,
      c.intX,
      c.intY,
      c.halfX,
      c.halfY,
    );
    let worst = 0;
    let differing = 0;
    for (let i = 0; i < want.length; i++) {
      const d = Math.abs(got[i]! - want[i]!);
      if (d > 0) differing++;
      if (d > worst) worst = d;
    }
    const ok = worst === 0;
    if (!ok) failures++;
    console.log(
      `${ok ? "EXACT" : "DIFFERS"}  ${c.name.padEnd(28)} ` +
        `worst |error| ${worst}, ${differing} of ${want.length} samples differ`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nAll cases reproduce MPEG-2 half-sample prediction bit for bit."
    : `\n${failures} case(s) did not match.`,
);

// ---------------------------------------------------------------------------
// The half-sample position on both axes averages four samples, which two
// predictions cannot express. Measure how close the available approximations
// get, so the mapping can pick the best one.
console.log(
  "\nHalf-sample on both axes, where an exact mapping is impossible:",
);

const INT_X = 2;
const INT_Y = 3;

interface Approx {
  name: string;
  stream: Uint8Array[];
}
const approximations: Approx[] = [
  {
    name: "bi-pred diagonal (x,y)+(x+1,y+1)",
    stream: [writeBiPredictedPicture([INT_X, INT_Y], [INT_X + 1, INT_Y + 1])],
  },
  {
    name: "bi-pred anti-diagonal",
    stream: [writeBiPredictedPicture([INT_X + 1, INT_Y], [INT_X, INT_Y + 1])],
  },
  {
    name: "bi-pred of the two horizontal halves",
    stream: [
      writeBiPredictedPicture(
        [INT_X * 4 + 2, INT_Y * 4],
        [INT_X * 4 + 2, (INT_Y + 1) * 4],
        true,
      ),
    ],
  },
  {
    name: "bi-pred of the two vertical halves",
    stream: [
      writeBiPredictedPicture(
        [INT_X * 4, INT_Y * 4 + 2],
        [(INT_X + 1) * 4, INT_Y * 4 + 2],
        true,
      ),
    ],
  },
  {
    name: "H.264's own six-tap at the half-half position",
    stream: [
      writeBiPredictedPicture(
        [INT_X * 4 + 2, INT_Y * 4 + 2],
        [0, 0],
        true,
        true,
      ),
    ],
  },
];

const dir2 = mkdtempSync(join(tmpdir(), "bipred2-"));
try {
  for (const kind of ["harsh", "smooth"] as const) {
    const content = referenceSamples(kind);
    const target = mpeg2Predict(
      content.luma,
      WIDTH,
      HEIGHT,
      INT_X,
      INT_Y,
      true,
      true,
    );
    console.log(`  -- ${kind} content --`);
    for (const a of approximations) {
      const parts = [sps, pps, writePcmIdr(content), ...a.stream];
      let total = 0;
      for (const p of parts) total += p.length;
      const stream = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        stream.set(p, at);
        at += p.length;
      }
      const h264 = join(dir2, "in.h264");
      const yuv = join(dir2, "out.yuv");
      writeFileSync(h264, stream);
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-i",
          h264,
          "-f",
          "rawvideo",
          "-pix_fmt",
          "yuv420p",
          yuv,
        ],
        {
          stdio: ["ignore", "ignore", "inherit"],
        },
      );
      const decoded = new Uint8Array(readFileSync(yuv));
      const frameSize = (WIDTH * HEIGHT * 3) / 2;
      const got = decoded.subarray(frameSize, frameSize + WIDTH * HEIGHT);

      let sse = 0;
      let worst = 0;
      let exact = 0;
      for (let i = 0; i < target.length; i++) {
        const d = got[i]! - target[i]!;
        sse += d * d;
        if (Math.abs(d) > worst) worst = Math.abs(d);
        if (d === 0) exact++;
      }
      const rmse = Math.sqrt(sse / target.length);
      console.log(
        `     ${a.name.padEnd(44)} rmse ${rmse.toFixed(3).padStart(6)}  ` +
          `worst ${String(worst).padStart(3)}  exact ${((100 * exact) / target.length).toFixed(1)}%`,
      );
    }
  }
} finally {
  rmSync(dir2, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
