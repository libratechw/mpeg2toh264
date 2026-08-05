/**
 * CAVLC residual block encoding (clause 9.2, run in reverse).
 *
 * A block is coded from the highest frequency coefficient downwards: first how
 * many non-zero levels there are and how many of them are trailing +/-1s, then
 * the signs of those ones, then the remaining levels, then how the zeros are
 * distributed between them.
 */
import type { BitWriter } from "./bitwriter.ts";
import {
  COEFF_TOKEN,
  RUN_BEFORE,
  TOTAL_ZEROS_4X4,
  TOTAL_ZEROS_CHROMA_DC,
  coeffTokenTableIndex,
  levelPrefixCode,
} from "./cavlc-tables.ts";

function writeCode(w: BitWriter, code: string): void {
  // Codewords are short; writing them a chunk at a time keeps u() within 32 bits.
  for (let i = 0; i < code.length; i += 24) {
    const part = code.slice(i, i + 24);
    w.u(part.length, parseInt(part, 2));
  }
}

/** Which total_zeros table applies, given the block size being coded. */
function totalZerosCode(
  totalCoeff: number,
  totalZeros: number,
  maxNumCoeff: number,
): string {
  const table =
    maxNumCoeff === 4
      ? TOTAL_ZEROS_CHROMA_DC[totalCoeff - 1]
      : TOTAL_ZEROS_4X4[totalCoeff - 1];
  const code = table?.[totalZeros];
  if (code === undefined) {
    throw new Error(
      `no total_zeros code for totalCoeff=${totalCoeff} totalZeros=${totalZeros} maxNumCoeff=${maxNumCoeff}`,
    );
  }
  return code;
}

/**
 * Encode one level as level_prefix and level_suffix.
 *
 * The prefix/suffix split depends on suffixLength, which adapts as levels are
 * written so that blocks with large coefficients spend fewer bits on them.
 * Clause 9.2.2 defines this as a decode; the boundaries below are that process
 * inverted.
 */
function writeLevel(
  w: BitWriter,
  levelCode: number,
  suffixLength: number,
): void {
  if (levelCode < 0) throw new Error(`negative levelCode ${levelCode}`);

  let prefix: number;
  let suffix = 0;
  let suffixBits = 0;

  if (suffixLength === 0) {
    if (levelCode <= 13) {
      prefix = levelCode;
    } else if (levelCode <= 29) {
      prefix = 14;
      suffix = levelCode - 14;
      suffixBits = 4;
    } else {
      prefix = 15;
      suffix = levelCode - 30;
      suffixBits = 12;
    }
  } else {
    const escape = 15 << suffixLength;
    if (levelCode < escape) {
      prefix = levelCode >> suffixLength;
      suffix = levelCode & ((1 << suffixLength) - 1);
      suffixBits = suffixLength;
    } else {
      prefix = 15;
      suffix = levelCode - escape;
      suffixBits = 12;
    }
  }

  if (suffix >= 1 << suffixBits) {
    // Levels beyond this need level_prefix 16 or more, which only arises at
    // bit depths above 8.
    throw new Error(
      `level ${levelCode} too large for suffixLength ${suffixLength}`,
    );
  }

  writeCode(w, levelPrefixCode(prefix));
  if (suffixBits > 0) w.u(suffixBits, suffix);
}

export interface ResidualBlock {
  /** Coefficient levels in coding scan order, lowest frequency first. */
  levels: Int16Array | number[];
  /** Number of coefficient positions in this block (16, 15, 4 or 8). */
  maxNumCoeff: number;
  /**
   * Predicted number of coefficients from the neighbouring blocks, or -1 for a
   * 4:2:0 chroma DC block (clause 9.2.1).
   */
  nC: number;
}

/**
 * Write one residual block. Returns TotalCoeff, which neighbouring blocks need
 * in order to derive their own nC.
 */
export function writeResidualBlock(w: BitWriter, block: ResidualBlock): number {
  const { levels, maxNumCoeff, nC } = block;

  // Positions of the non-zero levels, lowest frequency first.
  const positions: number[] = [];
  for (let i = 0; i < maxNumCoeff; i++) {
    if (levels[i] !== 0) positions.push(i);
  }
  const totalCoeff = positions.length;

  // Trailing ones are the run of +/-1 at the high frequency end, at most three.
  let trailingOnes = 0;
  for (let k = totalCoeff - 1; k >= 0 && trailingOnes < 3; k--) {
    if (Math.abs(levels[positions[k]!]!) !== 1) break;
    trailingOnes++;
  }

  const table = COEFF_TOKEN[coeffTokenTableIndex(nC)];
  const token = table?.[`${trailingOnes},${totalCoeff}`];
  if (token === undefined) {
    throw new Error(
      `no coeff_token for trailingOnes=${trailingOnes} totalCoeff=${totalCoeff} nC=${nC}`,
    );
  }
  writeCode(w, token);

  if (totalCoeff === 0) return 0;

  // Signs of the trailing ones, highest frequency first.
  for (let i = 0; i < trailingOnes; i++) {
    const level = levels[positions[totalCoeff - 1 - i]!]!;
    w.flag(level < 0); // 1 means negative
  }

  // Remaining levels, still highest frequency first.
  let suffixLength = totalCoeff > 10 && trailingOnes < 3 ? 1 : 0;
  for (let i = trailingOnes; i < totalCoeff; i++) {
    const level = levels[positions[totalCoeff - 1 - i]!]!;
    let levelCode = level > 0 ? 2 * level - 2 : -2 * level - 1;
    // The first level after fewer than three trailing ones cannot be +/-1,
    // since it would have been a trailing one, so the range is shifted down.
    if (i === trailingOnes && trailingOnes < 3) levelCode -= 2;

    writeLevel(w, levelCode, suffixLength);

    if (suffixLength === 0) suffixLength = 1;
    if (Math.abs(level) > 3 << (suffixLength - 1) && suffixLength < 6)
      suffixLength++;
  }

  // How the zeros are distributed. The count before the lowest frequency
  // non-zero coefficient is implied by what is left over.
  if (totalCoeff < maxNumCoeff) {
    const totalZeros = positions[totalCoeff - 1]! - (totalCoeff - 1);
    writeCode(w, totalZerosCode(totalCoeff, totalZeros, maxNumCoeff));

    let zerosLeft = totalZeros;
    for (let i = 0; i < totalCoeff - 1 && zerosLeft > 0; i++) {
      const hi = positions[totalCoeff - 1 - i]!;
      const lo = positions[totalCoeff - 2 - i]!;
      const runBefore = hi - lo - 1;
      const tableIdx = Math.min(zerosLeft, 7) - 1;
      const code = RUN_BEFORE[tableIdx]?.[runBefore];
      if (code === undefined) {
        throw new Error(
          `no run_before code for run=${runBefore} zerosLeft=${zerosLeft}`,
        );
      }
      writeCode(w, code);
      zerosLeft -= runBefore;
    }
  }

  return totalCoeff;
}
