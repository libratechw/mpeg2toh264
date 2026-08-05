#!/usr/bin/env python3
"""
Generate src/mpeg2/vlc-tables.ts from the text extracted out of the H.262 PDF.

Transcribing Annex B by hand is how you get a decoder that desyncs on one stream
in a thousand, so the tables are parsed straight from the spec text and checked
for the properties a Huffman code must have (prefix-free, no duplicates).
"""
import re
import sys
from pathlib import Path

SRC = Path("analysis/annexB.txt")
OUT = Path("src/mpeg2/vlc-tables.ts")

lines = SRC.read_text(encoding="latin-1").splitlines()


def section(start_pat, end_pat, after=0):
    """Lines strictly between the first match of start_pat (at/after `after`) and end_pat."""
    i = next(k for k in range(after, len(lines)) if re.search(start_pat, lines[k]))
    j = next(k for k in range(i + 1, len(lines)) if re.search(end_pat, lines[k]))
    return i, j, lines[i + 1 : j]


def is_bin(tok):
    return tok != "" and all(c in "01" for c in tok)


def norm_minus(s):
    """
    The PDF writes minus as a non-ASCII glyph, which surfaces as the bytes
    C2 96 after a latin-1 decode. Only the two signed tables (B.10 motion_code
    and B.11 dmvector) are affected, but getting a sign wrong there would be
    invisible until motion vectors drifted, so normalise it explicitly.
    """
    return s.replace("\xc2\x96", "-").replace("\x96", "-").replace("–", "-")


# ---------------------------------------------------------------- B.14 / B.15
def parse_coeff_table(title):
    """`<code tokens> s <run> <level>`; the sign bit 's' delimits code from values."""
    out = {}
    escape = None
    eob = None
    for ln in lines:
        toks = ln.split()
        if not toks:
            continue
        if "Escape" in ln and is_bin(toks[0]) and len(toks) <= 3:
            escape = "".join(t for t in toks if is_bin(t))
            continue
        if "End of Block" in ln:
            eob = "".join(t for t in toks if is_bin(t))
            continue
        if "s" not in toks:
            continue
        si = toks.index("s")
        code = "".join(toks[:si])
        rest = toks[si + 1 :]
        if not is_bin(code) or len(rest) != 2 or not all(r.isdigit() for r in rest):
            continue
        run, level = int(rest[0]), int(rest[1])
        out.setdefault(code, (run, level))
    return out, escape, eob


# Both coefficient tables live in the same file; split by their heading lines.
b14_start = next(k for k, l in enumerate(lines) if "Table B.14" in l)
b15_start = next(k for k, l in enumerate(lines) if "Table B.15" in l)
# B.15's final page shares a sheet with the B.16 heading, so the heading is not
# the end of B.15's rows: B.16's own data starts at its "Fixed length code" row.
b15_end = next(k for k, l in enumerate(lines) if l.strip().startswith("Fixed length code"))


NOTE_RE = re.compile(r"\(Note\s*\d+\)")


def parse_coeff_range(lo, hi):
    """
    Rows read `<code groups> s <run> <level>`. The sign bit 's' delimits the code
    from the values, which makes these tables unambiguous to parse.
    """
    out, escape, eob = {}, None, None
    for raw in lines[lo:hi]:
        ln = NOTE_RE.sub(" ", raw)
        toks = ln.split()
        if not toks:
            continue
        if "Escape" in ln:
            b = [t for t in toks if is_bin(t)]
            if b:
                escape = "".join(b)
            continue
        if "End of Block" in ln:
            b = [t for t in toks if is_bin(t)]
            if b:
                eob = "".join(b)
            continue
        # some rows write the sign bit glued to the code, e.g. "10s 0 1"
        if len(toks) >= 3 and toks[-1].isdigit() and toks[-2].isdigit():
            head = toks[:-2]
            if head and head[-1] == "s":
                code = "".join(head[:-1])
            elif head and head[-1].endswith("s") and is_bin(head[-1][:-1]):
                code = "".join(head[:-1]) + head[-1][:-1]
            else:
                continue
            if not is_bin(code):
                continue
            out.setdefault(code, (int(toks[-2]), int(toks[-1])))
    return out, escape, eob


B14, B14_ESC, B14_EOB = parse_coeff_range(b14_start, b15_start)
B15, B15_ESC, B15_EOB = parse_coeff_range(b15_start, b15_end)

# Table B.14 lists (run 0, level 1) twice: code '1' for the first (DC) coefficient
# of a non-intra block, '11' everywhere else. They are prefix-incompatible by
# design, so the one-bit form is held out of the table and applied by context.
B14_FIRST = "1"
assert B14.get(B14_FIRST) == (0, 1), f"expected '1' -> (0,1), got {B14.get(B14_FIRST)}"
assert B14.get("11") == (0, 1), f"expected '11' -> (0,1), got {B14.get('11')}"
del B14[B14_FIRST]


# ---------------------------------------------------------------- sequential-value tables
def parse_sequential(lo, hi, values, columns=1, special=None):
    """
    Tables whose value column is a known sequence (B.1, B.10, B.12, B.13).
    Codes are ambiguous with values ("1" is both), so we drive the parse from the
    expected value sequence instead of guessing.
    """
    want = list(values)
    result = {}
    pending = []
    idx = 0
    for ln in lines[lo:hi]:
        for tok in ln.split():
            if idx >= len(want):
                break
            target = want[idx]
            if special and tok == special[0] and pending:
                result["".join(pending)] = special[1]
                pending = []
                idx += 1
                continue
            if pending and tok == str(target):
                result["".join(pending)] = target
                pending = []
                idx += 1
            elif is_bin(tok):
                pending.append(tok)
            else:
                pending = []
    return result


def find(pat, after=0):
    return next(k for k in range(after, len(lines)) if re.search(pat, lines[k]))


# Headings read "Table B.1 <en dash> Variable length codes for ...", so match the
# number with a guard against B.1 also matching B.10 etc.
def find_table(n, after=0):
    return find(rf"Table B\.{n}(?!\d)", after)


# B.1 macroblock_address_increment: left column 1..17, right column 18..33 then escape.
b1_lo = find_table(1)
b1_hi = find(r"stream #148")
b1_rows = [l for l in lines[b1_lo:b1_hi] if l.split() and is_bin(l.split()[0])]
B1 = {}
for r, ln in enumerate(b1_rows):
    toks = ln.split()
    # left entry has value r+1, right entry has value r+18 (or the escape marker)
    for expect, is_last in ((r + 1, False), (r + 18, True)):
        pending = []
        while toks:
            t = toks.pop(0)
            if t == "macroblock_escape":
                B1["".join(pending)] = "ESCAPE"
                pending = []
                break
            if pending and t == str(expect):
                B1["".join(pending)] = expect
                pending = []
                break
            if is_bin(t):
                pending.append(t)
            else:
                pending = []

# B.10 motion_code: -16..-1 then 0 then 1..16, in listed order.
b10_lo = find_table(10)
b10_hi = find(r"stream #155")
b10_rows = [l for l in lines[b10_lo:b10_hi] if l.split() and is_bin(l.split()[0])]
B10 = {}
seq = list(range(-16, 0)) + [0] + list(range(1, 17))
assert len(b10_rows) == len(seq), f"B.10 has {len(b10_rows)} rows, expected {len(seq)}"
for ln, val in zip(b10_rows, seq):
    toks = norm_minus(ln).split()
    # trailing token is the signed value; everything before it is the code
    code = "".join(t for t in toks[:-1]) if len(toks) > 1 else toks[0]
    if val == 0:
        code = toks[0]
    # The value is assigned from listing order (-16..-1, 0, 1..16). Where the
    # printed value survived extraction, check the two agree.
    try:
        printed = int(toks[-1])
    except ValueError:
        printed = None
    if printed is not None and len(toks) > 1 and printed != val:
        raise SystemExit(f"B.10 sign mismatch: row {ln!r} -> positional {val}, printed {printed}")
    B10[code] = val

# B.11 dmvector. The minus glyph in the PDF does not survive text extraction --
# the "-1" row comes out as plain "1" -- so the signs are supplied here and the
# code set is checked against the extracted text rather than trusted blindly.
# (B.10 is the only other signed table, and its signs come from listing order.)
B11 = {"0": 0, "10": 1, "11": -1}
# The heading does not survive line splitting, so anchor on the data rows: the
# table is the three lines following its "Code Value" column header.
b11_lo = find(r"^\s*Code Value\s*$", find_table(10))
b11_rows = [norm_minus(lines[b11_lo + k]).strip() for k in (1, 2, 3)]
assert b11_rows == ["11 -1", "0 0", "10 1"], f"B.11 layout changed: {b11_rows}"
for row in b11_rows:
    c, v = row.split()
    assert B11[c] == int(v), f"B.11 mismatch on {row!r}"

# B.12 / B.13 dct_dc_size: values 0..11 in listed order.
b12_lo = find_table(12)
b12_hi = find(r"stream #156")
blk = lines[b12_lo:b12_hi]
lum_start = next(k for k, l in enumerate(blk) if l.strip() == "dct_dc_size_luminance")
chr_start = next(k for k, l in enumerate(blk) if l.strip() == "dct_dc_size_chrominance")


def parse_dc(rows):
    out = {}
    for ln in rows:
        toks = ln.split()
        if len(toks) < 2 or not toks[-1].isdigit():
            continue
        code = "".join(toks[:-1])
        if is_bin(code):
            out[code] = int(toks[-1])
    return out


B12 = parse_dc(blk[lum_start + 1 : chr_start])
B13 = parse_dc(blk[chr_start + 1 :])

# ---------------------------------------------------------------- B.9 coded_block_pattern
# Values are not sequential, so resolve the code/value split with the constraint
# that cbp values form a permutation of 1..63 (plus the 4:2:2/4:4:4-only cbp 0).
b9_lo = find_table(9)
b9_hi = find_table(10)
B9 = {}


def parse_b9_line(toks, want):
    """
    Split a line into exactly `want` (code, cbp) pairs. A greedy split gets this
    wrong -- in "0110 1 52 0001 0001 23" the token '0001' looks like a code
    followed by the value 1. Three facts pin the split down: the spec prints
    codes in 4-bit groups so every group but the last is exactly 4 characters,
    the table is laid out two entries per line, and a correct split consumes the
    whole line. Backtrack until all three hold.
    """
    n = len(toks)

    def rec(i, remaining):
        if i == n:
            return [] if remaining == 0 else None
        if remaining == 0:
            return None
        groups = []
        for k in range(i, n):
            t = toks[k]
            if not is_bin(t):
                break
            groups.append(t)
            nxt = toks[k + 1] if k + 1 < n else None
            if nxt is not None and nxt.isdigit() and all(len(g) == 4 for g in groups[:-1]):
                val = int(nxt)
                if 0 <= val <= 63:
                    rest = rec(k + 2, remaining - 1)
                    if rest is not None:
                        return [("".join(groups), val)] + rest
            if len(t) != 4:
                break  # a short group can only be the last one
        return None

    return rec(0, want)


for ln in lines[b9_lo:b9_hi]:
    toks = [t for t in ln.split() if t != "(Note)"]
    if not toks or not is_bin(toks[0]):
        continue
    pairs = parse_b9_line(toks, 2) or parse_b9_line(toks, 1)
    if pairs is None:
        print(f"  warning: could not split B.9 line: {ln!r}")
        continue
    for code, val in pairs:
        B9[code] = val

# ---------------------------------------------------------------- B.2 / B.3 / B.4 macroblock_type
FLAGS = ["QUANT", "MOTION_FORWARD", "MOTION_BACKWARD", "PATTERN", "INTRA"]


def parse_mbtype(lo, hi):
    out = {}
    for ln in lines[lo:hi]:
        toks = ln.split()
        if not toks or not is_bin(toks[0]):
            continue
        ai = next((k for k, t in enumerate(toks) if re.search(r"[A-Za-z]", t)), None)
        if ai is None or ai < 7:
            continue
        flags = toks[ai - 6 : ai]
        if not all(f in ("0", "1") for f in flags):
            continue
        code = "".join(toks[: ai - 6])
        if not is_bin(code):
            continue
        desc = " ".join(toks[ai:-1]) if toks[-1].isdigit() else " ".join(toks[ai:])
        bits = 0
        for k, name in enumerate(FLAGS):
            if flags[k] == "1":
                bits |= 1 << k
        # flags[5] is spatial_temporal_weight_code_flag: scalable profiles only
        out[code] = (bits, desc)
    return out


# B.2 and B.3 share a page; split them by their two column-header blocks.
base = find_table(2)
p = lines[base : find(r"stream #149")]
hdr_idx = [k for k, l in enumerate(p) if l.strip() == "macroblock_type VLC code"]
B2 = parse_mbtype(base + hdr_idx[0], base + hdr_idx[1])
B3 = parse_mbtype(base + hdr_idx[1], find(r"stream #149"))
p4 = find_table(4)
h4 = [k for k, l in enumerate(lines[p4 : find(r"stream #150")]) if l.strip() == "macroblock_type VLC code"]
B4 = parse_mbtype(p4 + h4[0], p4 + h4[1])


# ---------------------------------------------------------------- validation
def check_prefix_free(name, codes, expect=None):
    errs = []
    s = sorted(codes)
    for i, a in enumerate(s):
        for b in s[i + 1 :]:
            if b.startswith(a):
                errs.append(f"{name}: '{a}' is a prefix of '{b}'")
            elif not b.startswith(a[:1]):
                break
    kraft = sum(2.0 ** -len(c) for c in codes)
    status = "OK " if not errs else "BAD"
    extra = f" entries={len(codes)} kraft={kraft:.6f}"
    if expect is not None and len(codes) != expect:
        errs.append(f"{name}: expected {expect} entries, got {len(codes)}")
        status = "BAD"
    print(f"  [{status}] {name}{extra}")
    for e in errs[:5]:
        print(f"          {e}")
    return not errs


print("validating tables parsed from the spec:")
ok = True
ok &= check_prefix_free("B.1  mb_address_increment", list(B1) , 34)
ok &= check_prefix_free("B.2  mb_type I", list(B2), 2)
ok &= check_prefix_free("B.3  mb_type P", list(B3), 7)
ok &= check_prefix_free("B.4  mb_type B", list(B4), 11)
ok &= check_prefix_free("B.9  coded_block_pattern", list(B9), 64)
ok &= check_prefix_free("B.10 motion_code", list(B10), 33)
ok &= check_prefix_free("B.11 dmvector", list(B11), 3)
ok &= check_prefix_free("B.12 dct_dc_size_luma", list(B12), 12)
ok &= check_prefix_free("B.13 dct_dc_size_chroma", list(B13), 12)
ok &= check_prefix_free("B.14 coeff table zero", list(B14) + [B14_ESC, B14_EOB], 113)
ok &= check_prefix_free("B.15 coeff table one", list(B15) + [B15_ESC, B15_EOB], 113)

vals = sorted(B9.values())
print(f"  B.9 cbp values cover 0..63 exactly once: {vals == list(range(64))}")
print(f"  B.14 escape={B14_ESC!r} eob={B14_EOB!r}")
print(f"  B.15 escape={B15_ESC!r} eob={B15_EOB!r}")

if not ok:
    print("\nrefusing to emit: table validation failed")
    sys.exit(1)


# ---------------------------------------------------------------- emit TypeScript
# Inside an f-string expression `{{` is not an escape, so build these first.
B2F = {k: v[0] for k, v in B2.items()}
B3F = {k: v[0] for k, v in B3.items()}
B4F = {k: v[0] for k, v in B4.items()}


def fmt_pairs(d, valfmt=str):
    return ",\n  ".join(f"['{k}', {valfmt(v)}]" for k, v in sorted(d.items(), key=lambda kv: (len(kv[0]), kv[0])))


ts = f'''/**
 * MPEG-2 (H.262) Annex B variable length code tables.
 *
 * GENERATED by tools/gen-tables.py from the text of ITU-T H.262 (2000).
 * Do not edit by hand; regenerate instead. Every table below is checked at
 * generation time for being prefix-free and complete.
 */

/** A VLC entry: the code as a bit string, and the value it decodes to. */
export type VlcEntry<T> = readonly [string, T];

// ---- Table B.1: macroblock_address_increment. 'ESCAPE' adds 33 and repeats.
export const MB_ADDR_INCREMENT: readonly VlcEntry<number | 'ESCAPE'>[] = [
  {fmt_pairs(B1, lambda v: "'ESCAPE'" if v == 'ESCAPE' else str(v))},
];

// ---- Tables B.2/B.3/B.4: macroblock_type, as MBFlag bit sets.
export const MB_TYPE_I: readonly VlcEntry<number>[] = [
  {fmt_pairs(B2F)},
];
export const MB_TYPE_P: readonly VlcEntry<number>[] = [
  {fmt_pairs(B3F)},
];
export const MB_TYPE_B: readonly VlcEntry<number>[] = [
  {fmt_pairs(B4F)},
];

// ---- Table B.9: coded_block_pattern. cbp 0 is not valid for 4:2:0.
export const CODED_BLOCK_PATTERN: readonly VlcEntry<number>[] = [
  {fmt_pairs(B9)},
];

// ---- Table B.10: motion_code, signed.
export const MOTION_CODE: readonly VlcEntry<number>[] = [
  {fmt_pairs(B10)},
];

// ---- Table B.11: dmvector, used only by dual-prime prediction. Values are -1, 0, 1.
export const DMVECTOR: readonly VlcEntry<number>[] = [
  {fmt_pairs(B11)},
];

// ---- Tables B.12/B.13: dct_dc_size (number of additional bits for the DC differential).
export const DCT_DC_SIZE_LUMA: readonly VlcEntry<number>[] = [
  {fmt_pairs(B12)},
];
export const DCT_DC_SIZE_CHROMA: readonly VlcEntry<number>[] = [
  {fmt_pairs(B13)},
];

/** A run/level pair from the coefficient tables, or a control code. */
export const EOB = -1;
export const ESCAPE = -2;

/**
 * Tables B.14 (intra_vlc_format = 0, and all non-intra blocks) and B.15
 * (intra_vlc_format = 1). Value is `run * 256 + level`, or EOB / ESCAPE.
 * The sign bit follows every run/level code and is read separately.
 */
export const DCT_COEFF_TABLE0: readonly VlcEntry<number>[] = [
  ['{B14_EOB}', EOB],
  ['{B14_ESC}', ESCAPE],
  {fmt_pairs(B14, lambda v: f"{v[0]} * 256 + {v[1]}")},
];
export const DCT_COEFF_TABLE1: readonly VlcEntry<number>[] = [
  ['{B15_EOB}', EOB],
  ['{B15_ESC}', ESCAPE],
  {fmt_pairs(B15, lambda v: f"{v[0]} * 256 + {v[1]}")},
];

/**
 * In non-intra blocks the first coefficient uses a one-bit code '1' meaning
 * (run 0, level 1); elsewhere '11' carries that meaning. Table B.14 lists both,
 * so the decoder selects which is active via this flag rather than the table.
 */
export const DCT_COEFF_FIRST_NONINTRA_CODE = '1';
'''

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(ts)
print(f"\nwrote {OUT} ({len(ts)} bytes)")
