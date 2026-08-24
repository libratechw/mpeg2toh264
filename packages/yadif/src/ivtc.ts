/*!
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The field matching and decimation metrics in this file are ports of
 * FFmpeg's libavfilter/vf_fieldmatch.c and libavfilter/vf_decimate.c.
 */

/** A field pair selected by FFmpeg fieldmatch's `pc_n` strategy. */
export type FilmMatch = "p" | "c" | "n";

/** The fieldmatch result consumed by rendering and decimation. */
export interface FieldMatchResult {
  match: FilmMatch;
  combScore: number;
  isCombed: boolean;
  luma: Uint8Array;
}

/** The decimate result for the frame currently being analysed. */
export interface DecimateResult {
  cycleIndex: number;
  maxBlockDifference: number;
  totalDifference: number;
  shouldDrop: boolean;
  dropIndex: number | null;
  nextDropIndex: number | null;
  lowestCycleDifference: number;
  runnerUpCycleDifference: number;
}

interface DifferenceMetric {
  maxBlockDifference: number;
  totalDifference: number;
}

/** FFmpeg-compatible fieldmatch and mixed-content decimate decisions. */
export class FFmpegIVTC {
  static readonly CYCLE = 5;
  static readonly COMB_THRESHOLD = 9;
  static readonly COMBED_PIXEL_LIMIT = 80;
  static readonly DECIMATE_BLOCK = 32;
  static readonly DUPLICATE_PERCENT = 1.1;

  readonly #width: number;
  readonly #height: number;
  readonly #duplicateThreshold: number;
  #cycleIndex = 0;
  #activeDropIndex: number | null = null;
  #metrics: DifferenceMetric[] = [];
  #previousSample: Uint8Array | null = null;
  #lowestCycleDifference = Infinity;
  #runnerUpCycleDifference = Infinity;

  constructor(width: number, height: number) {
    // FFmpeg's 8-bit duplicate threshold is expressed for one 32 by 32 block,
    // independently of the reduced frame dimensions used by the browser
    this.#width = width;
    this.#height = height;
    this.#duplicateThreshold =
      (255 * FFmpegIVTC.DECIMATE_BLOCK ** 2 * FFmpegIVTC.DUPLICATE_PERCENT) /
      100;
  }

  /**
   * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
   * FFmpeg can retain full decoded frames while it looks ahead. The browser
   * keeps the clean full-resolution textures on the GPU and runs the exact
   * matching arithmetic on this fixed-size luma proxy instead.
   */
  fieldMatch(
    previous: Uint8Array,
    current: Uint8Array,
    next: Uint8Array,
    isTopFieldFirst: boolean,
    combedPixelLimit = FFmpegIVTC.COMBED_PIXEL_LIMIT,
  ): FieldMatchResult {
    const field = isTopFieldFirst ? 1 : 0;
    const frames = { p: previous, c: current, n: next } as const;

    // pc_n first chooses p or c with FFmpeg's motion-aware comparison, then
    // lets n replace it only through the full comb-matching check
    let match = this.#compareFields("c", "p", field, frames);
    // checkmm calculates only the candidates it visits, so the port keeps the
    // same lazy score cache around its p/c result and n rescue candidate
    const combScores = new Map<FilmMatch, number>();
    const score = (candidate: FilmMatch): number => {
      const cached = combScores.get(candidate);
      if (cached !== undefined) return cached;
      const value = FFmpegIVTC.#combedScore(
        this.weave(previous, current, next, candidate, isTopFieldFirst),
        this.#width,
        this.#height,
      );
      combScores.set(candidate, value);
      return value;
    };
    const firstScore = score(match);
    const nextScore = score("n");
    if (
      (nextScore * 3 < firstScore ||
        (nextScore * 2 < firstScore && firstScore > combedPixelLimit)) &&
      Math.abs(nextScore - firstScore) >= 30 &&
      nextScore < combedPixelLimit
    )
      match = "n";

    // combmatch=full marks an unresolved weave as interlaced and returns the
    // original current frame so the following YADIF stage receives it intact
    const combScore = score(match);
    const isCombed = combScore >= combedPixelLimit;
    if (isCombed) match = "c";
    return {
      match,
      combScore,
      isCombed,
      luma: this.weave(previous, current, next, match, isTopFieldFirst),
    };
  }

  /** Apply `decimate=cycle=5:mixed=1` metrics without delaying live audio. */
  decimate(sample: Uint8Array): DecimateResult {
    const cycleIndex = this.#cycleIndex;
    const metric = this.#previousSample
      ? FFmpegIVTC.#difference(
          this.#previousSample,
          sample,
          this.#width,
          this.#height,
        )
      : {
          maxBlockDifference: Infinity,
          totalDifference: Infinity,
        };
    this.#metrics.push(metric);

    // The completed preceding cycle supplies the candidate phase, but the
    // current pair must still pass FFmpeg's duplicate threshold before it is
    // discarded, so a cadence transition never drops a distinct picture
    const isPredictedDuplicate = this.#activeDropIndex === cycleIndex;
    const shouldDrop =
      isPredictedDuplicate &&
      metric.maxBlockDifference < this.#duplicateThreshold;
    // A phase shift is known as soon as the predicted pair exceeds FFmpeg's
    // own threshold. Retiring that phase immediately keeps the remainder of
    // this live cycle at input rate while its metrics establish the new one
    if (isPredictedDuplicate && !shouldDrop) this.#activeDropIndex = null;
    const dropIndex = this.#activeDropIndex;
    this.#previousSample = sample.slice();
    this.#cycleIndex++;

    let nextDropIndex = this.#activeDropIndex;
    if (this.#cycleIndex === FFmpegIVTC.CYCLE) {
      let lowest = 0;
      let runnerUp: number | null = null;
      for (let index = 1; index < this.#metrics.length; index++) {
        if (
          (this.#metrics[index]?.maxBlockDifference ?? Infinity) <
          (this.#metrics[lowest]?.maxBlockDifference ?? Infinity)
        ) {
          runnerUp = lowest;
          lowest = index;
        } else if (
          runnerUp === null ||
          (this.#metrics[index]?.maxBlockDifference ?? Infinity) <
            (this.#metrics[runnerUp]?.maxBlockDifference ?? Infinity)
        ) {
          runnerUp = index;
        }
      }
      // These two values preserve the existing public diagnostics without
      // feeding a second cadence heuristic back into FFmpeg's drop decision
      this.#lowestCycleDifference =
        this.#metrics[lowest]?.maxBlockDifference ?? Infinity;
      this.#runnerUpCycleDifference =
        runnerUp === null
          ? Infinity
          : (this.#metrics[runnerUp]?.maxBlockDifference ?? Infinity);
      // mixed=1 passes all five frames when no frame is below dupthresh;
      // scene-change selection is consequently irrelevant in that branch
      nextDropIndex =
        (this.#metrics[lowest]?.maxBlockDifference ?? Infinity) <
        this.#duplicateThreshold
          ? lowest
          : null;
      this.#activeDropIndex = nextDropIndex;
      this.#metrics = [];
      this.#cycleIndex = 0;
    }

    return {
      cycleIndex,
      maxBlockDifference: metric.maxBlockDifference,
      totalDifference: metric.totalDifference,
      shouldDrop,
      dropIndex,
      nextDropIndex,
      lowestCycleDifference: this.#lowestCycleDifference,
      runnerUpCycleDifference: this.#runnerUpCycleDifference,
    };
  }

  /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
  weave(
    previous: Uint8Array,
    current: Uint8Array,
    next: Uint8Array,
    match: FilmMatch,
    isTopFieldFirst: boolean,
  ): Uint8Array {
    if (match === "c") return current.slice();
    const output = current.slice();
    const borrowed = match === "p" ? previous : next;
    const rowBytes = output.length / this.#height;
    const field = isTopFieldFirst ? 1 : 0;
    for (let y = field; y < this.#height; y += 2)
      output.set(
        borrowed.subarray(y * rowBytes, (y + 1) * rowBytes),
        y * rowBytes,
      );
    return output;
  }

  /** Return all cycle state to the beginning of an FFmpeg decimate window. */
  reset(): void {
    this.#cycleIndex = 0;
    this.#activeDropIndex = null;
    this.#metrics = [];
    this.#previousSample = null;
    this.#lowestCycleDifference = Infinity;
    this.#runnerUpCycleDifference = Infinity;
  }

  /** Compare two candidates with vf_fieldmatch.c's motion masks and weights. */
  #compareFields(
    first: FilmMatch,
    second: FilmMatch,
    field: number,
    frames: Readonly<Record<FilmMatch, Uint8Array>>,
  ): FilmMatch {
    const width = this.#width;
    const height = this.#height;
    const firstBase = 2 - field;
    const secondBase = 2 - field;
    const firstFrame = frames[first];
    const secondFrame = frames[second];
    const map = FFmpegIVTC.#differenceMap(
      firstFrame,
      secondFrame,
      width,
      height,
      field,
    );
    let firstNormal = 0;
    let firstMotion = 0;
    let firstMotionLarge = 0;
    let secondNormal = 0;
    let secondMotion = 0;
    let secondMotionLarge = 0;

    // The eight-pixel side exclusion and every numeric cutoff below are the
    // literal 8-bit luma defaults used by FFmpeg's compare_fields()
    for (let y = 2; y < height - 2; y += 2) {
      const step = (y - 2) / 2;
      const sourcePreviousLine = firstBase - 1 + step * 2;
      const sourceLine = firstBase + 1 + step * 2;
      const sourceNextLine = firstBase + 3 + step * 2;
      const firstPreviousLine = firstBase + step * 2;
      const firstNextLine = firstPreviousLine + 2;
      const secondPreviousLine = secondBase + step * 2;
      const secondNextLine = secondPreviousLine + 2;
      const mapLine = firstBase + step * 2;
      for (let x = 8; x < width - 8; x++) {
        const mapValue =
          (map[mapLine * width + x] ?? 0) |
          (map[(mapLine + 2) * width + x] ?? 0);
        if (mapValue === 0) continue;
        const sourceWeighted =
          (frames.c[sourcePreviousLine * width + x] ?? 0) +
          ((frames.c[sourceLine * width + x] ?? 0) << 2) +
          (frames.c[sourceNextLine * width + x] ?? 0);
        const firstDifference = Math.abs(
          3 *
            ((firstFrame[firstPreviousLine * width + x] ?? 0) +
              (firstFrame[firstNextLine * width + x] ?? 0)) -
            sourceWeighted,
        );
        const secondDifference = Math.abs(
          3 *
            ((secondFrame[secondPreviousLine * width + x] ?? 0) +
              (secondFrame[secondNextLine * width + x] ?? 0)) -
            sourceWeighted,
        );
        if (firstDifference > 23 && (mapValue & 1) !== 0)
          firstNormal += firstDifference;
        if (secondDifference > 23 && (mapValue & 1) !== 0)
          secondNormal += secondDifference;
        if (firstDifference > 42 && (mapValue & 2) !== 0)
          firstMotion += firstDifference;
        if (secondDifference > 42 && (mapValue & 2) !== 0)
          secondMotion += secondDifference;
        if (firstDifference > 42 && (mapValue & 4) !== 0)
          firstMotionLarge += firstDifference;
        if (secondDifference > 42 && (mapValue & 4) !== 0)
          secondMotionLarge += secondDifference;
      }
    }

    if (
      firstMotion < 500 &&
      secondMotion < 500 &&
      (firstMotionLarge >= 500 || secondMotionLarge >= 500) &&
      Math.max(firstMotionLarge, secondMotionLarge) >
        3 * Math.min(firstMotionLarge, secondMotionLarge)
    ) {
      firstMotion = firstMotionLarge;
      secondMotion = secondMotionLarge;
    }
    // FFmpeg rounds each accumulated score before applying its tiered motion
    // ratios, which can change the winner close to a threshold
    const normal1 = Math.floor(firstNormal / 6 + 0.5);
    const normal2 = Math.floor(secondNormal / 6 + 0.5);
    const motion1 = Math.floor(firstMotion / 6 + 0.5);
    const motion2 = Math.floor(secondMotion / 6 + 0.5);
    const normalRatio =
      Math.max(normal1, normal2) / Math.max(Math.min(normal1, normal2), 1);
    const motionRatio =
      Math.max(motion1, motion2) / Math.max(Math.min(motion1, motion2), 1);
    const motionToNormal =
      Math.max(motion1, motion2) / Math.max(Math.max(normal1, normal2), 1);
    if (
      ((motion1 >= 500 || motion2 >= 500) &&
        (motion1 * 2 < motion2 || motion2 * 2 < motion1)) ||
      ((motion1 >= 1000 || motion2 >= 1000) &&
        (motion1 * 3 < motion2 * 2 || motion2 * 3 < motion1 * 2)) ||
      ((motion1 >= 2000 || motion2 >= 2000) &&
        (motion1 * 5 < motion2 * 4 || motion2 * 5 < motion1 * 4)) ||
      ((motion1 >= 4000 || motion2 >= 4000) && motionRatio > normalRatio) ||
      (motionToNormal > 0.005 &&
        Math.max(motion1, motion2) > 150 &&
        (motion1 * 2 < motion2 || motion2 * 2 < motion1))
    )
      return motion1 > motion2 ? second : first;
    return normal1 > normal2 ? second : first;
  }

  /** Build vf_fieldmatch.c's three-level motion map for one field. */
  static #differenceMap(
    first: Uint8Array,
    second: Uint8Array,
    width: number,
    height: number,
    field: number,
  ): Uint8Array {
    // The absolute differences are stored at field spacing, matching the
    // interlaced subset used as vf_fieldmatch.c's temporary buffer
    const rows = Array.from(
      { length: Math.ceil(height / 2) },
      () => new Uint8Array(width),
    );
    const sourceStart = field === 1 ? 1 : 0;
    for (let row = 0; row < rows.length; row++) {
      const y = Math.min(height - 1, sourceStart + row * 2);
      const output = rows[row];
      if (!output) continue;
      for (let x = 0; x < width; x++)
        output[x] = Math.abs(
          (first[y * width + x] ?? 0) - (second[y * width + x] ?? 0),
        );
    }
    // Each destination bit records increasingly strong local motion evidence
    // for the normal, motion and large-motion accumulators
    const map = new Uint8Array(width * height);
    const destinationStart = field === 1 ? 3 : 2;
    for (let row = 1; row < rows.length - 1; row++) {
      const destinationY = destinationStart + (row - 1) * 2;
      if (destinationY >= height) break;
      const current = rows[row];
      if (!current) continue;
      for (let x = 1; x < width - 1; x++) {
        const difference = current[x] ?? 0;
        if (difference <= 3) continue;
        let count = 0;
        for (let horizontal = x - 1; horizontal <= x + 1; horizontal++) {
          count += (rows[row - 1]?.[horizontal] ?? 0) > 3 ? 1 : 0;
          count += (rows[row]?.[horizontal] ?? 0) > 3 ? 1 : 0;
          count += (rows[row + 1]?.[horizontal] ?? 0) > 3 ? 1 : 0;
        }
        if (count <= 1) continue;
        const offset = destinationY * width + x;
        map[offset] = 1;
        if (difference <= 19) continue;
        count = 0;
        let hasUpper = false;
        let hasLower = false;
        for (let horizontal = x - 1; horizontal <= x + 1; horizontal++) {
          if ((rows[row - 1]?.[horizontal] ?? 0) > 19) {
            count++;
            hasUpper = true;
          }
          if ((rows[row]?.[horizontal] ?? 0) > 19) count++;
          if ((rows[row + 1]?.[horizontal] ?? 0) > 19) {
            count++;
            hasLower = true;
          }
        }
        if (count <= 3) continue;
        if (hasUpper && hasLower) {
          map[offset] |= 2;
          continue;
        }
        let hasUpper2 = false;
        let hasLower2 = false;
        for (
          let horizontal = Math.max(x - 4, 0);
          horizontal < Math.min(x + 5, width);
          horizontal++
        ) {
          if (row !== 1 && (rows[row - 2]?.[horizontal] ?? 0) > 19)
            hasUpper2 = true;
          if ((rows[row - 1]?.[horizontal] ?? 0) > 19) hasUpper = true;
          if ((rows[row + 1]?.[horizontal] ?? 0) > 19) hasLower = true;
          if (
            row !== rows.length - 2 &&
            (rows[row + 2]?.[horizontal] ?? 0) > 19
          )
            hasLower2 = true;
        }
        if (
          (hasUpper && (hasLower || hasUpper2)) ||
          (hasLower && (hasUpper || hasLower2))
        )
          map[offset] |= 2;
        else if (count > 5) map[offset] |= 4;
      }
    }
    return map;
  }

  /** Calculate fieldmatch's vertical comb mask and overlapping 16x16 score. */
  static #combedScore(luma: Uint8Array, width: number, height: number): number {
    const mask = new Uint8Array(width * height);
    const sample = (x: number, y: number): number =>
      luma[Math.max(0, Math.min(height - 1, y)) * width + x] ?? 0;
    // The five-tap vertical filter marks pixels whose alternating-line energy
    // exceeds FFmpeg's default cthresh on both adjacent lines
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const current = sample(x, y);
        const previous = sample(x, y === 0 ? 1 : y - 1);
        const next = sample(x, y === height - 1 ? height - 2 : y + 1);
        const farPrevious =
          y < 2 ? sample(x, y === 0 ? 2 : 3) : sample(x, y - 2);
        const farNext =
          y + 2 >= height
            ? sample(x, y === height - 1 ? height - 3 : height - 4)
            : sample(x, y + 2);
        const hasAdjacentDifference =
          y === 0
            ? Math.abs(current - next) > FFmpegIVTC.COMB_THRESHOLD
            : y === height - 1
              ? Math.abs(current - previous) > FFmpegIVTC.COMB_THRESHOLD
              : Math.abs(current - previous) > FFmpegIVTC.COMB_THRESHOLD &&
                Math.abs(current - next) > FFmpegIVTC.COMB_THRESHOLD;
        if (
          hasAdjacentDifference &&
          Math.abs(
            4 * current - 3 * (previous + next) + farPrevious + farNext,
          ) >
            FFmpegIVTC.COMB_THRESHOLD * 6
        )
          mask[y * width + x] = 255;
      }
    }
    // Half-block offsets make every marked pixel contribute to each 16 by 16
    // window that can contain it, then the densest window becomes combpel
    let maximum = 0;
    for (const yOffset of [0, 8]) {
      for (const xOffset of [0, 8]) {
        for (let blockY = yOffset; blockY < height; blockY += 16) {
          for (let blockX = xOffset; blockX < width; blockX += 16) {
            let combed = 0;
            for (
              let y = Math.max(1, blockY);
              y < Math.min(height - 1, blockY + 16);
              y++
            ) {
              for (let x = blockX; x < Math.min(width, blockX + 16); x++) {
                const offset = y * width + x;
                if (
                  mask[offset - width] === 255 &&
                  mask[offset] === 255 &&
                  mask[offset + width] === 255
                )
                  combed++;
              }
            }
            maximum = Math.max(maximum, combed);
          }
        }
      }
    }
    return maximum;
  }

  /** Calculate decimate's overlapping 32x32 maximum and total differences. */
  static #difference(
    first: Uint8Array,
    second: Uint8Array,
    width: number,
    height: number,
  ): DifferenceMetric {
    const halfBlock = FFmpegIVTC.DECIMATE_BLOCK / 2;
    const columns = Math.ceil(width / halfBlock);
    const rows = Math.ceil(height / halfBlock);
    const blocks = new Float64Array(columns * rows);
    const channels = first.length / (width * height);
    // FFmpeg measures one full-resolution luma plane and two quarter-resolution
    // chroma planes for ordinary YUV 4:2:0 input. Browser frames arrive as RGB,
    // so converting the metric back to that layout preserves dupthresh's scale.
    for (let y = 0; y < height; y++) {
      const blockY = Math.floor(y / halfBlock);
      for (let x = 0; x < width; x++) {
        const blockX = Math.floor(x / halfBlock);
        const block = blockY * columns + blockX;
        const offset = (y * width + x) * channels;
        if (channels === 1) {
          blocks[block] =
            (blocks[block] ?? 0) +
            Math.abs((first[offset] ?? 0) - (second[offset] ?? 0));
          continue;
        }

        // BT.709 is also used by the reduced fieldmatch luma pass. Keeping the
        // same conversion here makes neutral RGB noise count once as luma.
        const firstLuma = Math.round(
          (first[offset] ?? 0) * 0.2126 +
            (first[offset + 1] ?? 0) * 0.7152 +
            (first[offset + 2] ?? 0) * 0.0722,
        );
        const secondLuma = Math.round(
          (second[offset] ?? 0) * 0.2126 +
            (second[offset + 1] ?? 0) * 0.7152 +
            (second[offset + 2] ?? 0) * 0.0722,
        );
        blocks[block] = (blocks[block] ?? 0) + Math.abs(firstLuma - secondLuma);

        // One averaged chroma sample represents each 2 by 2 luma area, matching
        // the sample count that FFmpeg adds to the corresponding half-block.
        if ((x & 1) !== 0 || (y & 1) !== 0) continue;
        let firstRed = 0;
        let firstGreen = 0;
        let firstBlue = 0;
        let secondRed = 0;
        let secondGreen = 0;
        let secondBlue = 0;
        let sampleCount = 0;
        for (let sampleY = y; sampleY < Math.min(y + 2, height); sampleY++) {
          for (let sampleX = x; sampleX < Math.min(x + 2, width); sampleX++) {
            const sampleOffset = (sampleY * width + sampleX) * channels;
            firstRed += first[sampleOffset] ?? 0;
            firstGreen += first[sampleOffset + 1] ?? 0;
            firstBlue += first[sampleOffset + 2] ?? 0;
            secondRed += second[sampleOffset] ?? 0;
            secondGreen += second[sampleOffset + 1] ?? 0;
            secondBlue += second[sampleOffset + 2] ?? 0;
            sampleCount++;
          }
        }
        const firstChromaBlue = Math.round(
          (-0.114572 * firstRed - 0.385428 * firstGreen + 0.5 * firstBlue) /
            sampleCount,
        );
        const secondChromaBlue = Math.round(
          (-0.114572 * secondRed - 0.385428 * secondGreen + 0.5 * secondBlue) /
            sampleCount,
        );
        const firstChromaRed = Math.round(
          (0.5 * firstRed - 0.454153 * firstGreen - 0.045847 * firstBlue) /
            sampleCount,
        );
        const secondChromaRed = Math.round(
          (0.5 * secondRed - 0.454153 * secondGreen - 0.045847 * secondBlue) /
            sampleCount,
        );
        blocks[block] =
          (blocks[block] ?? 0) +
          Math.abs(firstChromaBlue - secondChromaBlue) +
          Math.abs(firstChromaRed - secondChromaRed);
      }
    }
    // The largest four-half-block window is decimate's duplicate metric
    let maxBlockDifference = -1;
    for (let y = 0; y < rows - 1; y++) {
      for (let x = 0; x < columns - 1; x++) {
        maxBlockDifference = Math.max(
          maxBlockDifference,
          (blocks[y * columns + x] ?? 0) +
            (blocks[y * columns + x + 1] ?? 0) +
            (blocks[(y + 1) * columns + x] ?? 0) +
            (blocks[(y + 1) * columns + x + 1] ?? 0),
        );
      }
    }
    // Scene-change accounting uses the sum of the same half-block array
    let totalDifference = 0;
    for (const difference of blocks) totalDifference += difference;
    return { maxBlockDifference, totalDifference };
  }
}
