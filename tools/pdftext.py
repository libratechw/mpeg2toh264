#!/usr/bin/env python3
"""
Extract text from a PDF with layout preserved well enough to read tables.

Splitting on text-positioning operators is too coarse: these specifications
place superscripts, subscripts and individual table cells with their own
operators, so "Table 9-5" arrives as three separate fragments. Instead the text
matrix is tracked, fragments are grouped by their y coordinate into lines, and
sorted by x within each line.
"""
import json
import re
import sys
import zlib

# Text object operators we care about, in one alternation so they are seen in
# stream order.
OPS = re.compile(
    rb"BT|ET"
    rb"|(?P<tm>-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+"
    rb"(?P<tm_x>-?[\d.]+)\s+(?P<tm_y>-?[\d.]+)\s+Tm)"
    rb"|(?P<td>(?P<td_x>-?[\d.]+)\s+(?P<td_y>-?[\d.]+)\s+Td)"
    rb"|(?P<tdd>(?P<tdd_x>-?[\d.]+)\s+(?P<tdd_y>-?[\d.]+)\s+TD)"
    rb"|(?P<tl>(?P<tl_v>-?[\d.]+)\s+TL)"
    rb"|(?P<tstar>T\*)"
    rb"|(?P<tj>\[(?:[^\[\]\\]|\\.)*\]\s*TJ)"
    rb"|(?P<tj1>\((?:[^()\\]|\\.)*\)\s*Tj)"
)

STR = re.compile(rb"\((?:[^()\\]|\\.)*\)")


def decode_strings(chunk: bytes) -> str:
    out = []
    for c in STR.findall(chunk):
        out.append(re.sub(rb"\\([()\\])", rb"\1", c[1:-1]))
    return b"".join(out).decode("latin-1")


def page_fragments(content: bytes, y_tolerance: float = 1.5) -> list[list[tuple[float, str]]]:
    """
    Return the page as lines of (x, text) fragments, ordered top to bottom.

    Keeping the x coordinate is what makes wide tables readable: each cell is
    its own fragment at a column-consistent x, so cells can be assigned to
    columns by position instead of by guessing where one codeword ends and the
    next begins.
    """
    frags: list[tuple[float, float, str]] = []  # (y, x, text)
    x = y = 0.0
    lx = ly = 0.0  # line matrix
    leading = 0.0

    for m in OPS.finditer(content):
        if m.group("tm"):
            x = lx = float(m.group("tm_x"))
            y = ly = float(m.group("tm_y"))
        elif m.group("td"):
            lx += float(m.group("td_x"))
            ly += float(m.group("td_y"))
            x, y = lx, ly
        elif m.group("tdd"):
            tx, ty = float(m.group("tdd_x")), float(m.group("tdd_y"))
            lx += tx
            ly += ty
            x, y = lx, ly
            leading = -ty
        elif m.group("tl"):
            leading = float(m.group("tl_v"))
        elif m.group("tstar"):
            ly -= leading
            x, y = lx, ly
        elif m.group("tj") or m.group("tj1"):
            text = decode_strings(m.group(0))
            if text.strip():
                frags.append((y, x, text))

    if not frags:
        return []

    # Group fragments whose baselines are within a tolerance of each other.
    frags.sort(key=lambda f: (-f[0], f[1]))
    lines: list[list[tuple[float, str]]] = []
    current: list[tuple[float, str]] = []
    current_y = frags[0][0]
    for fy, fx, text in frags:
        if abs(fy - current_y) > y_tolerance:
            lines.append(sorted(current))
            current = []
            current_y = fy
        current.append((fx, text))
    lines.append(sorted(current))
    return lines


def page_lines(content: bytes, y_tolerance: float = 1.5) -> list[str]:
    """Return the page's text as flat lines, ordered top to bottom."""
    return [join_fragments(line) for line in page_fragments(content, y_tolerance)]


def join_fragments(frags: list[tuple[float, str]]) -> str:
    """Join one line's fragments, inserting a gap where the x jump implies one."""
    frags.sort(key=lambda f: f[0])
    out = ""
    prev_end = None
    for fx, text in frags:
        if prev_end is not None and fx - prev_end > 1.0:
            out += " "
        out += text
        # Rough advance estimate; only used to decide whether to insert a space.
        prev_end = fx + len(text) * 4.5
    return out.strip()


def streams(path: str) -> list[bytes]:
    data = open(path, "rb").read()
    out = []
    for m in re.finditer(rb"stream\r?\n", data):
        s = m.end()
        e = data.find(b"endstream", s)
        if e < 0:
            out.append(b"")
            continue
        try:
            out.append(zlib.decompress(data[s:e]))
        except Exception:
            out.append(b"")
    return out


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit(
            "usage: pdftext.py <file.pdf> <first-stream> <last-stream> [--json]"
        )
    path, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    as_json = "--json" in sys.argv
    all_streams = streams(path)

    if as_json:
        # Fragment coordinates are kept so table cells can be matched to columns.
        pages = []
        for i in range(lo, min(hi + 1, len(all_streams))):
            frags = page_fragments(all_streams[i])
            if frags:
                pages.append({"stream": i, "lines": [[[x, t] for x, t in ln] for ln in frags]})
        json.dump(pages, sys.stdout, ensure_ascii=False, indent=0)
        return

    for i in range(lo, min(hi + 1, len(all_streams))):
        lines = page_lines(all_streams[i])
        if not lines:
            continue
        print(f"\n########## stream #{i} ##########")
        for line in lines:
            print(line)


if __name__ == "__main__":
    main()
