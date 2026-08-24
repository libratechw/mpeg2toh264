/**
 * The clip the decoder is asked about, as a data URL.
 *
 * Six frames of 1440x1080 interlaced H.264, top field first, whose two fields
 * are the opposite of each other: one is bright, the other is dark, and which
 * is which swaps every frame. Woven, that is a picture of alternating lines
 * that inverts thirty times a second -- the most combing a frame can hold, and
 * motion in every pixel of it, so that a deinterlacer of any kind has to do
 * something to it and a decoder that leaves it alone leaves the pattern exact.
 *
 * The size is the point of it and not an accident: a decoder picks its path by
 * what it is decoding, and a thumbnail-sized clip could take a different one
 * to the broadcast this player exists for. It is the same shape as one, and it
 * still costs less than five kilobytes, because a pattern this regular is
 * nothing to an encoder.
 *
 * Regenerate with ffmpeg:
 *
 * ```
 * ffmpeg -f lavfi -i "nullsrc=s=1440x1080:r=30000/1001:d=0.2" \
 *   -vf "geq=lum='if(mod(Y+N,2),235,16)':cb=128:cr=128,format=yuv420p,\
 *        setparams=field_mode=tff" \
 *   -c:v libx264 -preset veryslow -crf 8 -flags +ilme+ildct \
 *   -x264-params "interlaced=1:tff=1:keyint=30:level=4.1:ref=4:bframes=3" \
 *   -movflags empty_moov+default_base_moof+frag_keyframe \
 *   -frag_duration 200000 probe.mp4
 * ```
 */
export declare const PROBE_CLIP: string;
//# sourceMappingURL=probe-clip.d.ts.map