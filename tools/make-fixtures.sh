#!/bin/bash
# Regenerate the synthetic MPEG-2 test streams in test/fixtures.
#
# The committed .m2v files are the authority -- byte-identical output is not
# guaranteed across ffmpeg versions. This script records how they were produced
# and what each one is meant to exercise.
set -euo pipefail
cd "$(dirname "$0")/../test/fixtures"

# Intra only. Exercises the DC size tables (B.12/B.13) and coefficient table
# zero (B.14) without any motion syntax at all.
ffmpeg -y -v error -f lavfi -i testsrc2=size=352x288:rate=25 -frames:v 3 \
  -c:v mpeg2video -g 1 -bf 0 -qscale:v 4 -f mpeg2video i_only.m2v

# I+P. Adds macroblock_type for P pictures, motion vectors and skipped
# macroblocks.
ffmpeg -y -v error -f lavfi -i testsrc2=size=352x288:rate=25 -frames:v 10 \
  -c:v mpeg2video -g 5 -bf 0 -qscale:v 4 -f mpeg2video ip.m2v

# I+B+B+P, the classic broadcast GOP. Adds backward and interpolated prediction.
ffmpeg -y -v error -f lavfi -i testsrc2=size=352x288:rate=25 -frames:v 15 \
  -c:v mpeg2video -g 15 -bf 2 -qscale:v 4 -f mpeg2video ibbp.m2v

# 1440x1080 interlaced, shaped like a terrestrial broadcast. Exercises field
# motion types, field DCT and macroblock_escape.
ffmpeg -y -v error -f lavfi -i testsrc2=size=1440x1080:rate=30000/1001 -frames:v 15 \
  -c:v mpeg2video -g 15 -bf 2 -b:v 16M -flags +ildct+ilme -top 1 \
  -f mpeg2video hd1080i.m2v

# The only fixture that reaches coefficient table one (B.15). Also covers
# alternate scan, the non-linear quantiser and a custom intra matrix.
# non_linear_quant requires qmax <= 28 in ffmpeg.
IM=$(python3 -c "print(','.join(str(v) for v in [8,17,18,19,21,23,25,27,17,18,19,21,23,25,27,28,20,21,22,23,24,26,28,30,21,22,23,24,26,28,30,32,22,23,24,26,28,30,32,35,23,24,26,28,30,32,35,38,25,26,28,30,32,35,38,41,27,28,30,32,35,38,41,45]))")
ffmpeg -y -v error -f lavfi -i testsrc2=size=352x288:rate=25 -frames:v 8 \
  -c:v mpeg2video -g 4 -bf 1 -qscale:v 2 -qmax 28 \
  -intra_vlc 1 -alternate_scan 1 -non_linear_quant 1 -intra_matrix "$IM" \
  -f mpeg2video altscan.m2v

# Near-lossless, to push levels high enough to need the escape code often.
ffmpeg -y -v error -f lavfi -i testsrc2=size=352x288:rate=25 -frames:v 6 \
  -c:v mpeg2video -g 3 -bf 1 -qscale:v 1 -intra_vlc 1 -f mpeg2video escape.m2v

ls -l ./*.m2v
