#!/usr/bin/env python3
"""
Compare what VideoToolbox decoded against what ffmpeg decoded, frame by frame.

Feed it the MP4 and the directory `vtdec` dumped its luma planes into. It
decodes the same file with ffmpeg, lines the two runs up and prints every frame
they disagree about -- which is how each of the VideoToolbox faults this
transcoder works around was found and then shown to be gone.

    swiftc -O -o /tmp/vtdec tools/vtdec.swift
    DUMP_DIR=/tmp/vt /tmp/vtdec out.mp4
    python3 tools/vtdiff.py out.mp4 /tmp/vt

The alignment is done by content: the first VideoToolbox frame is matched
against every ffmpeg frame and the offset that wins is used for the rest.
Arithmetic does not work -- AVAssetReader rebases the track to zero, ffmpeg
sometimes keeps the original start and sometimes normalises it, and an offset
one frame out paints a whole run as broken.

Only the luma plane is compared, so nothing passes through a colour matrix.
Needs numpy and ffmpeg.
"""
import os
import re
import subprocess
import sys
import tempfile

import numpy as np


def read_pgm(path):
    with open(path, "rb") as f:
        assert f.readline().strip() == b"P5", f"{path} is not a binary PGM"
        width, height = map(int, f.readline().split())
        assert int(f.readline()) == 255
        return np.frombuffer(f.read(width * height), dtype=np.uint8).reshape(height, width)


def ffmpeg_frames(path, directory):
    """Decode every frame's luma plane, in display order, without rescaling it."""
    result = subprocess.run(
        # extractplanes rather than a gray pixel format: the latter stretches
        # limited-range luma to full range, which would show up as a difference
        # in every single frame.
        ["ffmpeg", "-v", "info", "-i", path, "-vf", "extractplanes=y,showinfo",
         "-vsync", "0", "-f", "image2", "-start_number", "0",
         os.path.join(directory, "%05d.pgm"), "-y"],
        capture_output=True, text=True,
    )
    times = [float(t) for t in re.findall(r"pts_time:([0-9.]+)", result.stderr)]
    if not times:
        sys.exit(f"ffmpeg decoded nothing from {path}:\n{result.stderr[-2000:]}")
    return [(times[i], os.path.join(directory, f"{i:05d}.pgm")) for i in range(len(times))]


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip().splitlines()[0])
    source, dump = sys.argv[1], sys.argv[2]
    decoded = sorted(f for f in os.listdir(dump) if f.endswith(".pgm"))
    if not decoded:
        sys.exit(f"no PGM files in {dump}; did vtdec run with DUMP_DIR set?")

    with tempfile.TemporaryDirectory() as directory:
        reference = ffmpeg_frames(source, directory)
        first = read_pgm(os.path.join(dump, decoded[0])).astype(np.int16)
        scores = [
            (float(np.abs(first - read_pgm(path).astype(np.int16)).mean()), index)
            for index, (_, path) in enumerate(reference)
        ]
        best, start = min(scores)
        print(f"{decoded[0]} lines up with ffmpeg frame {start} "
              f"at {reference[start][0]:.4f}s (mean |d| {best:.3f})")
        if start + len(decoded) > len(reference):
            print("the dump runs past the end of ffmpeg's decode; comparing what overlaps")

        print(f"\n{'frame':>6} {'ffmpeg pts':>11} {'mean |d|':>9} {'max |d|':>8} {'bad 8x8':>8}")
        worst = 0.0
        differing = 0
        compared = 0
        for offset, name in enumerate(decoded):
            if start + offset >= len(reference):
                break
            pts, path = reference[start + offset]
            a = read_pgm(os.path.join(dump, name)).astype(np.int16)
            b = read_pgm(path).astype(np.int16)
            height, width = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
            d = np.abs(a[:height, :width] - b[:height, :width])
            compared += 1
            worst = max(worst, float(d.mean()))
            if not d.any():
                continue
            differing += 1
            blocks = d[: height // 8 * 8, : width // 8 * 8]
            blocks = blocks.reshape(height // 8, 8, width // 8, 8).max(axis=(1, 3))
            print(f"{start + offset:6d} {pts:11.4f} {d.mean():9.3f} {d.max():8d} "
                  f"{int((blocks > 20).sum()):8d}")
        print(f"\n{compared} frames compared, {differing} differ, worst mean |d| {worst:.3f}")
        return 1 if differing else 0


if __name__ == "__main__":
    sys.exit(main())
