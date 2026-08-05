#!/usr/bin/env python3
"""
Generate src/h264/cavlc-tables.ts from ITU-T H.264 Tables 9-5 to 9-10.

These tables are wide grids where reading the text alone is ambiguous: a row
like "0000 01 0000 01 0000 1 0000 0000 000 00 0" can be split into codewords
several different ways that all look plausible, and the extraction occasionally
drops a '-' placeholder entirely. So cells are matched to columns by their x
coordinate on the page instead. Column anchors are recovered from the fact that
every cell begins exactly at its column's x, while continuation fragments sit to
the right of one.

Everything is then checked for being prefix-free, complete and duplicate-free
before any code is emitted.
"""
import json
import sys
from collections import Counter
from pathlib import Path

SRC = Path("analysis/h264_cavlc.json")
OUT = Path("src/h264/cavlc-tables.ts")

pages = json.loads(SRC.read_text())


def flat(page):
    return " ".join(t for line in page["lines"] for _, t in line)


def is_code(text):
    t = text.strip()
    return t != "" and all(c in "01 " for c in t) and any(c in "01" for c in t)


def is_cell(text):
    t = text.strip()
    return is_code(t) or t == "-" or t.isdigit()


def data_rows(lines, min_cells):
    """Lines that look like grid rows: a numeric label then codes or placeholders."""
    out = []
    for line in lines:
        if len(line) < min_cells:
            continue
        texts = [t.strip() for _, t in line]
        if not texts[0].isdigit():
            continue
        if not all(is_cell(t) for t in texts):
            continue
        out.append([(float(x), t.strip()) for x, t in line])
    return out


def column_anchors(rows, ncols):
    """
    Recover column x positions. Every cell starts exactly at its column's x, so
    the anchors are the x values shared by the most rows; fragments continuing a
    cell land to the right of an anchor and are rarer.
    """
    counts = Counter(round(x, 1) for row in rows for x, _ in row)
    anchors = sorted(x for x, _ in counts.most_common(ncols))
    if len(anchors) != ncols:
        raise SystemExit(f"expected {ncols} column anchors, found {len(anchors)}")
    return anchors


def row_cells(row, anchors):
    """Assign fragments to columns, concatenating continuations into one cell."""
    cells = [""] * len(anchors)
    for x, text in row:
        col = 0
        for i, a in enumerate(anchors):
            if x >= a - 0.6:
                col = i
        cells[col] += text
    return [c.replace(" ", "") for c in cells]


# ------------------------------------------------------------------ coeff_token
# Six code columns: 0<=nC<2, 2<=nC<4, 4<=nC<8, 8<=nC, nC==-1 (chroma DC 4:2:0),
# nC==-2 (chroma DC 4:2:2), preceded by TrailingOnes and TotalCoeff labels.
COEFF_TOKEN_COLS = 6
coeff_token = [dict() for _ in range(COEFF_TOKEN_COLS)]

ct_pages = [p for p in pages if "coeff_token mapping to TotalCoeff" in flat(p)]
for page in ct_pages:
    rows = data_rows(page["lines"], min_cells=6)
    if not rows:
        continue
    anchors = column_anchors(rows, 2 + COEFF_TOKEN_COLS)
    for row in rows:
        cells = row_cells(row, anchors)
        if not cells[0].isdigit() or not cells[1].isdigit():
            continue
        t1s, tc = int(cells[0]), int(cells[1])
        if tc > 16 or t1s > 3 or t1s > tc:
            continue
        for col in range(COEFF_TOKEN_COLS):
            code = cells[2 + col]
            if code and code != "-":
                coeff_token[col].setdefault((t1s, tc), code)

# ------------------------------------------------------------------ total_zeros
def header_indices(lines, valid_indices):
    """Line positions of column-header rows, i.e. an ascending run of indices."""
    out = []
    for i, line in enumerate(lines):
        texts = [t.strip() for _, t in line]
        if len(texts) < 2 or not all(t.isdigit() for t in texts):
            continue
        header = [int(t) for t in texts]
        if set(header) <= set(valid_indices) and header == sorted(set(header)):
            out.append((i, header))
    return out


def parse_total_zeros(caption, valid_indices, max_num_coeff):
    """
    Both the tzVlcIndex 1-7 and 8-15 grids live on one page, and their columns
    sit at different x positions, so each header is handled with only the rows
    that follow it and before the next header.
    """
    tables = {t: {} for t in valid_indices}
    for page in pages:
        if caption not in flat(page):
            continue
        lines = page["lines"]
        heads = header_indices(lines, valid_indices)
        for n, (start, header) in enumerate(heads):
            stop = heads[n + 1][0] if n + 1 < len(heads) else len(lines)
            rows = data_rows(lines[start + 1 : stop], min_cells=2)
            if not rows:
                continue
            anchors = column_anchors(rows, len(header) + 1)
            for row in rows:
                cells = row_cells(row, anchors)
                if not cells[0].isdigit():
                    continue
                z = int(cells[0])
                for t, code in zip(header, cells[1:]):
                    if not code or code == "-":
                        continue
                    if z > max_num_coeff - t:
                        continue
                    tables[t].setdefault(z, code)
    return tables


total_zeros_4x4 = parse_total_zeros("total_zeros tables for 4x4 blocks", range(1, 16), 16)
total_zeros_cdc = parse_total_zeros("Chroma DC 2x2 block", [1, 2, 3], 4)

# ------------------------------------------------------------------ run_before
# Columns are zerosLeft 1..6 then "greater than 6".
run_before = {k: {} for k in list(range(1, 7)) + [7]}
for page in pages:
    if "Tables for run_before" not in flat(page):
        continue
    # The header row carries a '>6' label, which data_rows already rejects
    # because '>' is neither a codeword nor a placeholder.
    rows = data_rows(page["lines"], min_cells=2)
    anchors = column_anchors(rows, 8)
    for row in rows:
        cells = row_cells(row, anchors)
        if not cells[0].isdigit():
            continue
        r = int(cells[0])
        for col, code in enumerate(cells[1:]):
            if not code or code == "-":
                continue
            key = col + 1 if col < 6 else 7
            limit = key if key < 7 else 14
            if r > limit:
                continue
            run_before[key].setdefault(r, code)

# ------------------------------------------------------------------ Table 9-4
# coded_block_pattern is coded as me(v): a mapped Exp-Golomb, where the mapping
# differs between intra and inter macroblocks. pdftotext renders this one
# cleanly, so it is read from a plain layout dump rather than the geometry.
CBP_SRC = Path("analysis/h264_cbp.txt")
cbp_section = None
cbp_rows = {"a": {}, "b": {}}
for ln in CBP_SRC.read_text().splitlines():
    if "ChromaArrayType is equal to 1 or 2" in ln:
        cbp_section = "a"
    elif "ChromaArrayType is equal to 0 or 3" in ln:
        cbp_section = "b"
    parts = ln.split()
    if cbp_section and len(parts) == 3 and all(p.isdigit() for p in parts):
        code_num, intra, inter = (int(p) for p in parts)
        cbp_rows[cbp_section][code_num] = (intra, inter)

# 4:2:0 and 4:2:2 use section (a): 48 patterns, since chroma contributes.
cbp420 = cbp_rows["a"]
if sorted(cbp420) != list(range(48)):
    raise SystemExit(f"Table 9-4(a) is incomplete: {len(cbp420)} rows")
cbp_intra_to_code = {v[0]: k for k, v in cbp420.items()}
cbp_inter_to_code = {v[1]: k for k, v in cbp420.items()}
if sorted(cbp_intra_to_code) != list(range(48)) or sorted(cbp_inter_to_code) != list(range(48)):
    raise SystemExit("Table 9-4(a) columns are not permutations of 0..47")

# ------------------------------------------------------------------ validation
ok = True


def check(name, codes, expected):
    global ok
    errs = []
    s = sorted(codes)
    for i, a in enumerate(s):
        for b in s[i + 1 :]:
            if b.startswith(a):
                errs.append(f"'{a}' is a prefix of '{b}'")
            elif b[0] != a[0]:
                break
    if len(codes) != expected:
        errs.append(f"expected {expected} entries, got {len(codes)}")
    if len(set(codes)) != len(codes):
        errs.append("duplicate codewords")
    kraft = sum(2.0 ** -len(c) for c in codes)
    if kraft > 1.0000001:
        errs.append(f"kraft sum {kraft:.4f} exceeds 1")
    status = "OK " if not errs else "BAD"
    print(f"  [{status}] {name:36s} entries={len(codes):3d} kraft={kraft:.6f}")
    for e in errs[:3]:
        print(f"          {e}")
    if errs:
        ok = False


def coeff_token_rows(max_tc):
    return sum(1 for tc in range(max_tc + 1) for t1 in range(min(3, tc) + 1))


print("validating CAVLC tables parsed from the spec:")
names = ["0<=nC<2", "2<=nC<4", "4<=nC<8", "8<=nC", "nC==-1", "nC==-2"]
limits = [16, 16, 16, 16, 4, 8]
for col, (nm, lim) in enumerate(zip(names, limits)):
    check(f"coeff_token {nm}", list(coeff_token[col].values()), coeff_token_rows(lim))
for t in range(1, 16):
    check(f"total_zeros 4x4 tzVlcIndex={t}", list(total_zeros_4x4[t].values()), 17 - t)
for t in (1, 2, 3):
    check(f"total_zeros chromaDC tz={t}", list(total_zeros_cdc[t].values()), 5 - t)
for k in range(1, 7):
    check(f"run_before zerosLeft={k}", list(run_before[k].values()), k + 1)
check("run_before zerosLeft>6", list(run_before[7].values()), 15)

if not ok:
    print("\nrefusing to emit: table validation failed")
    sys.exit(1)


# ------------------------------------------------------------------ emit
def fmt_num_map(d):
    return ", ".join(f"{k}: '{v}'" for k, v in sorted(d.items()))


ct_rows = ",\n".join(
    "  { "
    + ", ".join(f"'{a},{b}': '{c}'" for (a, b), c in sorted(coeff_token[col].items()))
    + " }"
    for col in range(COEFF_TOKEN_COLS)
)
tz4 = ",\n".join(f"  /* {t:2d} */ {{ {fmt_num_map(total_zeros_4x4[t])} }}" for t in range(1, 16))
tzc = ",\n".join(f"  /* {t} */ {{ {fmt_num_map(total_zeros_cdc[t])} }}" for t in (1, 2, 3))
rb = ",\n".join(
    f"  /* {k if k < 7 else '>6'} */ {{ {fmt_num_map(run_before[k])} }}"
    for k in list(range(1, 7)) + [7]
)

ts = f'''/**
 * H.264 CAVLC codeword tables (Tables 9-5 to 9-10).
 *
 * GENERATED by tools/gen-cavlc.py from the text of ITU-T H.264 (08/2021).
 * Do not edit by hand; regenerate instead. Every table is checked at generation
 * time for being prefix-free, complete, and free of duplicate codewords.
 *
 * These map values to codewords, since this side of the project only encodes.
 */

/** Codewords keyed by `${{trailingOnes}},${{totalCoeff}}`. */
export type CoeffTokenTable = Readonly<Record<string, string>>;

/**
 * coeff_token, one table per nC range; index with coeffTokenTableIndex(). The
 * two chroma DC tables cover fewer coefficient counts because their blocks are
 * smaller.
 */
export const COEFF_TOKEN: readonly CoeffTokenTable[] = [
{ct_rows},
];

/** Select the coeff_token table for a given nC (clause 9.2.1). */
export function coeffTokenTableIndex(nC: number): number {{
  if (nC === -1) return 4; // chroma DC, 4:2:0
  if (nC === -2) return 5; // chroma DC, 4:2:2
  if (nC < 2) return 0;
  if (nC < 4) return 1;
  if (nC < 8) return 2;
  return 3;
}}

/** total_zeros for 4x4 blocks, indexed by tzVlcIndex - 1, then by total_zeros. */
export const TOTAL_ZEROS_4X4: readonly Readonly<Record<number, string>>[] = [
{tz4},
];

/** total_zeros for the 2x2 chroma DC block of 4:2:0, indexed by tzVlcIndex - 1. */
export const TOTAL_ZEROS_CHROMA_DC: readonly Readonly<Record<number, string>>[] = [
{tzc},
];

/**
 * run_before, indexed by min(zerosLeft, 7) - 1, then by run_before. The last
 * entry serves every zerosLeft above 6.
 */
export const RUN_BEFORE: readonly Readonly<Record<number, string>>[] = [
{rb},
];

/**
 * level_prefix is n zeros followed by a one, so it is computed rather than
 * tabulated (Table 9-9 is informative only).
 */
export function levelPrefixCode(n: number): string {{
  return '0'.repeat(n) + '1';
}}

/**
 * Table 9-4(a): coded_block_pattern to codeNum, for 4:2:0 and 4:2:2. The value
 * is coded as ue(codeNum), and intra and inter macroblocks use different
 * orderings. Indexed by coded_block_pattern, which runs 0..47.
 */
export const CBP_TO_CODE_NUM_INTRA: readonly number[] = [
  {", ".join(str(cbp_intra_to_code[c]) for c in range(48))},
];
export const CBP_TO_CODE_NUM_INTER: readonly number[] = [
  {", ".join(str(cbp_inter_to_code[c]) for c in range(48))},
];
'''

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(ts)
print(f"\nwrote {OUT} ({len(ts)} bytes)")
