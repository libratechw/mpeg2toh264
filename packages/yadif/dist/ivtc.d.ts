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
/** FFmpeg-compatible fieldmatch and mixed-content decimate decisions. */
export declare class FFmpegIVTC {
    #private;
    static readonly CYCLE = 5;
    static readonly COMB_THRESHOLD = 9;
    static readonly COMBED_PIXEL_LIMIT = 80;
    static readonly DECIMATE_BLOCK = 32;
    static readonly DUPLICATE_PERCENT = 1.1;
    constructor(width: number, height: number);
    /**
     * Apply `fieldmatch=mode=pc_n:combmatch=full:mchroma=0` to reduced luma.
     * FFmpeg can retain full decoded frames while it looks ahead. The browser
     * keeps the clean full-resolution textures on the GPU and runs the exact
     * matching arithmetic on this fixed-size luma proxy instead.
     */
    fieldMatch(previous: Uint8Array, current: Uint8Array, next: Uint8Array, isTopFieldFirst: boolean, combedPixelLimit?: number): FieldMatchResult;
    /** Apply `decimate=cycle=5:mixed=1` metrics without delaying live audio. */
    decimate(sample: Uint8Array): DecimateResult;
    /** Weave p, c or n samples exactly as fieldmatch does for any channel count. */
    weave(previous: Uint8Array, current: Uint8Array, next: Uint8Array, match: FilmMatch, isTopFieldFirst: boolean): Uint8Array;
    /** Return all cycle state to the beginning of an FFmpeg decimate window. */
    reset(): void;
}
//# sourceMappingURL=ivtc.d.ts.map