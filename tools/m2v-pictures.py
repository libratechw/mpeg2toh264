#!/usr/bin/env python3
"""
Count the picture types and structures of an MPEG-2 elementary stream.

What a source does with field pictures decides which paths the transcoder takes,
and the awkward ones are rare enough to miss by sampling: a 30-minute broadcast
recording held five field-coded I pictures among 3612, and each one is a random
access point that reaches the transcoder differently from the other 3607.

    ffmpeg -v error -i recording.m2ts -map 0:v:0 -c copy -f data - \\
      | python3 tools/m2v-pictures.py

Every field-coded I picture is reported with the frame it lands on, since those
are the ones worth cutting a test stream at -- take the sequence header in front
of one and the transcoder opens its random access point on a field pair.
"""
import sys
from collections import Counter

TYPES = {1: "I", 2: "P", 3: "B"}
STRUCTURES = {1: "top", 2: "bottom", 3: "frame"}
FRAME_RATE = 30000 / 1001

counts = Counter()
frames = 0
# A field pair is two coded pictures on one frame, so only the first of them
# advances the count.
awaiting_second_field = False
pending_type = None
tail = b""

while True:
    chunk = sys.stdin.buffer.read(1 << 20)
    if not chunk:
        break
    data = tail + chunk
    at = 0
    while True:
        start = data.find(b"\x00\x00\x01", at)
        if start < 0 or start + 10 >= len(data):
            break
        code = data[start + 3]
        if code == 0x00:  # picture_start_code
            pending_type = TYPES.get((data[start + 5] >> 3) & 7, "?")
        elif code == 0xB5 and pending_type is not None and (data[start + 4] >> 4) == 8:
            structure = STRUCTURES.get(data[start + 6] & 3, "?")  # picture_coding_extension
            counts[(pending_type, structure)] += 1
            if structure == "frame":
                frames += 1
                awaiting_second_field = False
            elif awaiting_second_field:
                awaiting_second_field = False
            else:
                frames += 1
                awaiting_second_field = True
                if pending_type == "I":
                    print(f"field-coded I picture on frame {frames}, "
                          f"about {frames / FRAME_RATE:.1f}s in")
            pending_type = None
        at = start + 3
    tail = data[-16:]

print(f"\n{frames} frames, about {frames / FRAME_RATE:.0f}s")
for key in sorted(counts):
    print(f"  {key[0]}/{key[1]:<6} {counts[key]}")
field_intra = sum(n for key, n in counts.items() if key == ("I", "top") or key == ("I", "bottom"))
print(f"field-coded I pictures: {field_intra}")
