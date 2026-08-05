import { PictureType } from "./mpeg2/constants.ts";
import {
  parseElementaryStream,
  sequenceSampleAspectRatio,
  type SampleAspectRatio,
} from "./mpeg2/headers.ts";
import type { AacConfig } from "./aac/adts.ts";

const TIMESCALE = 90_000;

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value >>> 8, value);
}

function u24(value: number): Uint8Array {
  return Uint8Array.of(value >>> 16, value >>> 8, value);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((sum, part) => sum + part.length, 0);
  return concat([u32(size), ascii(type), ...payload]);
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payload: Uint8Array[]
) {
  return box(type, Uint8Array.of(version), u24(flags), ...payload);
}

function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; length: number }[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    if (data[i + 2] === 1) {
      starts.push({ at: i, length: 3 });
      i += 2;
    } else if (data[i + 2] === 0 && data[i + 3] === 1) {
      starts.push({ at: i, length: 4 });
      i += 3;
    }
  }
  const nals: Uint8Array[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!.at + starts[i]!.length;
    const end = starts[i + 1]?.at ?? data.length;
    if (end > start) nals.push(data.subarray(start, end));
  }
  return nals;
}

const FRAME_RATES: Readonly<Record<number, readonly [number, number]>> = {
  1: [24_000, 1001],
  2: [24, 1],
  3: [25, 1],
  4: [30_000, 1001],
  5: [30, 1],
  6: [50, 1],
  7: [60_000, 1001],
  8: [60, 1],
};

export interface Mpeg2VideoTimeline {
  width: number;
  height: number;
  sampleDuration: number;
  /** Presentation index for each coded picture, excluding the IDR clone. */
  presentationIndices: number[];
  /** Content sync flags; restart points are supplied by actual IDR samples. */
  syncSamples: boolean[];
  sampleAspectRatio?: SampleAspectRatio;
}

/** Reproduce the transcoder's accepted-picture timeline in MP4 timescale units. */
export function mpeg2VideoTimeline(
  data: Uint8Array,
  options: { hasReferences?: boolean } = {},
): Mpeg2VideoTimeline {
  const pictures = parseElementaryStream(data);
  const first = pictures[0];
  if (!first) throw new Error("no MPEG-2 pictures for MP4 timeline");
  const baseRate = FRAME_RATES[first.sequence.frameRateCode];
  if (!baseRate)
    throw new Error(
      `unsupported MPEG-2 frame_rate_code ${first.sequence.frameRateCode}`,
    );
  const numerator = baseRate[0] * (first.sequenceExt.frameRateExtensionN + 1);
  const denominator = baseRate[1] * (first.sequenceExt.frameRateExtensionD + 1);
  const sampleDuration = Math.round((TIMESCALE * denominator) / numerator);

  let references = options.hasReferences ? 2 : 0;
  let gopBase = 0;
  let seenPicture = false;
  let maxTrInGop = 0;
  const presentationIndices: number[] = [];
  const syncSamples: boolean[] = [];
  for (const picture of pictures) {
    const type = picture.header.pictureCodingType;
    if (
      type !== PictureType.I &&
      type !== PictureType.P &&
      type !== PictureType.B
    )
      continue;
    const tr = picture.header.temporalReference;
    if (picture.startsGop && seenPicture) {
      gopBase += maxTrInGop + 1;
      maxTrInGop = 0;
    }
    seenPicture = true;
    maxTrInGop = Math.max(maxTrInGop, tr);
    if (type === PictureType.B && references < 2) continue;
    presentationIndices.push(gopBase + tr + 1);
    syncSamples.push(false);
    if (type !== PictureType.B) references = Math.min(2, references + 1);
  }
  return {
    width: first.sequence.horizontalSize,
    height: first.sequence.verticalSize,
    sampleDuration,
    presentationIndices,
    syncSamples,
    sampleAspectRatio: sequenceSampleAspectRatio(first.sequence),
  };
}

function makeAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  if (sps.length < 4) throw new Error("H.264 SPS is too short for avcC");
  return box(
    "avcC",
    Uint8Array.of(1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1),
    u16(sps.length),
    sps,
    Uint8Array.of(1),
    u16(pps.length),
    pps,
  );
}

function makeEsds(config: AacConfig): Uint8Array {
  const descriptor = (tag: number, payload: Uint8Array) =>
    concat([
      Uint8Array.of(
        tag,
        0x80 | ((payload.length >>> 21) & 0x7f),
        0x80 | ((payload.length >>> 14) & 0x7f),
        0x80 | ((payload.length >>> 7) & 0x7f),
        payload.length & 0x7f,
      ),
      payload,
    ]);
  const decoderSpecific = descriptor(0x05, config.audioSpecificConfig);
  const decoderConfig = descriptor(
    0x04,
    concat([
      Uint8Array.of(0x40, 0x15, 0, 0, 0),
      u32(0),
      u32(0),
      decoderSpecific,
    ]),
  );
  const slConfig = descriptor(0x06, Uint8Array.of(0x02));
  const esDescriptor = descriptor(
    0x03,
    concat([u16(2), Uint8Array.of(0), decoderConfig, slConfig]),
  );
  return fullBox("esds", 0, 0, esDescriptor);
}

function makeInitSegment(
  width: number,
  height: number,
  sps: Uint8Array,
  pps: Uint8Array,
  audio?: AacConfig,
  sampleAspectRatio?: SampleAspectRatio,
) {
  const ftyp = box(
    "ftyp",
    ascii("isom"),
    u32(0x200),
    ascii("isomiso6mp41avc1"),
  );
  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(TIMESCALE),
    u32(0),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    zeros(8),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000),
    zeros(24),
    u32(audio ? 3 : 2),
  );
  const tkhd = fullBox(
    "tkhd",
    0,
    7,
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(0),
    zeros(8),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000),
    u32(width << 16),
    u32(height << 16),
  );
  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(TIMESCALE),
    u32(0),
    u16(0x55c4),
    u16(0),
  );
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    ascii("vide"),
    zeros(12),
    ascii("VideoHandler\0"),
  );
  const vmhd = fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
  const url = fullBox("url ", 0, 1);
  const dref = fullBox("dref", 0, 0, u32(1), url);
  const dinf = box("dinf", dref);
  const compressor = new Uint8Array(32);
  const avc1 = box(
    "avc1",
    zeros(6),
    u16(1),
    zeros(16),
    u16(width),
    u16(height),
    u32(72 << 16),
    u32(72 << 16),
    u32(0),
    u16(1),
    compressor,
    u16(0x18),
    u16(0xffff),
    makeAvcC(sps, pps),
    ...(sampleAspectRatio
      ? [
          box(
            "pasp",
            u32(sampleAspectRatio.width),
            u32(sampleAspectRatio.height),
          ),
        ]
      : []),
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), avc1);
  const stbl = box(
    "stbl",
    stsd,
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0)),
  );
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);
  const trex = fullBox("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0));
  let audioTrak: Uint8Array = new Uint8Array(0);
  let audioTrex: Uint8Array = new Uint8Array(0);
  if (audio) {
    const audioTkhd = fullBox(
      "tkhd",
      0,
      7,
      u32(0),
      u32(0),
      u32(2),
      u32(0),
      u32(0),
      zeros(8),
      u16(0),
      u16(0),
      u16(0x0100),
      u16(0),
      u32(0x00010000),
      u32(0),
      u32(0),
      u32(0),
      u32(0x00010000),
      u32(0),
      u32(0),
      u32(0),
      u32(0x40000000),
      u32(0),
      u32(0),
    );
    const audioMdhd = fullBox(
      "mdhd",
      0,
      0,
      u32(0),
      u32(0),
      u32(audio.sampleRate),
      u32(0),
      u16(0x55c4),
      u16(0),
    );
    const audioHdlr = fullBox(
      "hdlr",
      0,
      0,
      u32(0),
      ascii("soun"),
      zeros(12),
      ascii("SoundHandler\0"),
    );
    const smhd = fullBox("smhd", 0, 0, u16(0), u16(0));
    const mp4a = box(
      "mp4a",
      zeros(6),
      u16(1),
      zeros(8),
      u16(audio.channelCount),
      u16(16),
      u16(0),
      u16(0),
      u32(audio.sampleRate << 16),
      makeEsds(audio),
    );
    const audioStbl = box(
      "stbl",
      fullBox("stsd", 0, 0, u32(1), mp4a),
      fullBox("stts", 0, 0, u32(0)),
      fullBox("stsc", 0, 0, u32(0)),
      fullBox("stsz", 0, 0, u32(0), u32(0)),
      fullBox("stco", 0, 0, u32(0)),
    );
    audioTrak = box(
      "trak",
      audioTkhd,
      box("mdia", audioMdhd, audioHdlr, box("minf", smhd, dinf, audioStbl)),
    );
    audioTrex = fullBox("trex", 0, 0, u32(2), u32(1), u32(0), u32(0), u32(0));
  }
  return concat([
    ftyp,
    box("moov", mvhd, trak, audioTrak, box("mvex", trex, audioTrex)),
  ]);
}

function lengthPrefixed(nal: Uint8Array): Uint8Array {
  return concat([u32(nal.length), nal]);
}

function makeVideoPayloads(
  samples: Uint8Array[],
  firstSamplePrefixes: Uint8Array[] = [],
): Uint8Array[] {
  return samples.map((sample, index) =>
    index === 0 && firstSamplePrefixes.length > 0
      ? concat([
          ...firstSamplePrefixes.map(lengthPrefixed),
          lengthPrefixed(sample),
        ])
      : lengthPrefixed(sample),
  );
}

function makeMediaSegment(
  samples: Uint8Array[],
  durations: number[],
  compositions: number[],
  syncSamples: boolean[],
  sequenceNumber = 1,
  baseDecodeTime = 0,
  firstSamplePrefixes: Uint8Array[] = [],
) {
  const payloads = makeVideoPayloads(samples, firstSamplePrefixes);
  const entries: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sync = syncSamples[i]!;
    entries.push(
      u32(durations[i]!),
      u32(payloads[i]!.length),
      u32(sync ? 0x02000000 : 0x01010000),
      u32(compositions[i]!),
    );
  }
  const makeMoof = (dataOffset: number) => {
    const mfhd = fullBox("mfhd", 0, 0, u32(sequenceNumber));
    const tfhd = fullBox("tfhd", 0, 0x020000, u32(1));
    const tfdt = fullBox("tfdt", 0, 0, u32(baseDecodeTime));
    const trun = fullBox(
      "trun",
      1,
      0x000f01,
      u32(samples.length),
      u32(dataOffset),
      ...entries,
    );
    return box("moof", mfhd, box("traf", tfhd, tfdt, trun));
  };
  let moof = makeMoof(0);
  moof = makeMoof(moof.length + 8);
  return concat([moof, box("mdat", ...payloads)]);
}

function makeAudioMediaSegment(
  samples: Uint8Array[],
  sequenceNumber: number,
  baseDecodeTime: number,
) {
  const entries = samples.flatMap((sample) => [u32(1024), u32(sample.length)]);
  const makeMoof = (dataOffset: number) => {
    const mfhd = fullBox("mfhd", 0, 0, u32(sequenceNumber));
    const tfhd = fullBox("tfhd", 0, 0x020000, u32(1));
    const tfdt = fullBox("tfdt", 0, 0, u32(baseDecodeTime));
    const trun = fullBox(
      "trun",
      0,
      0x000301,
      u32(samples.length),
      u32(dataOffset),
      ...entries,
    );
    return box("moof", mfhd, box("traf", tfhd, tfdt, trun));
  };
  let moof = makeMoof(0);
  moof = makeMoof(moof.length + 8);
  return concat([moof, box("mdat", ...samples)]);
}

function makeAvMediaSegment(
  videoSamples: Uint8Array[],
  videoDurations: number[],
  videoCompositions: number[],
  videoSyncSamples: boolean[],
  audioSamples: Uint8Array[],
  sequenceNumber: number,
  videoBaseDecodeTime: number,
  audioBaseDecodeTime: number,
  firstSamplePrefixes: Uint8Array[] = [],
) {
  const videoPayloads = makeVideoPayloads(videoSamples, firstSamplePrefixes);
  const videoEntries: Uint8Array[] = [];
  for (let index = 0; index < videoSamples.length; index++) {
    const sync = videoSyncSamples[index]!;
    videoEntries.push(
      u32(videoDurations[index]!),
      u32(videoPayloads[index]!.length),
      u32(sync ? 0x02000000 : 0x01010000),
      u32(videoCompositions[index]!),
    );
  }
  const audioEntries = audioSamples.flatMap((sample) => [
    u32(1024),
    u32(sample.length),
  ]);
  const videoBytes = videoPayloads.reduce(
    (sum, sample) => sum + sample.length,
    0,
  );
  const makeMoof = (videoOffset: number, audioOffset: number) => {
    const mfhd = fullBox("mfhd", 0, 0, u32(sequenceNumber));
    const videoTraf = box(
      "traf",
      fullBox("tfhd", 0, 0x020000, u32(1)),
      fullBox("tfdt", 0, 0, u32(videoBaseDecodeTime)),
      fullBox(
        "trun",
        1,
        0x000f01,
        u32(videoSamples.length),
        u32(videoOffset),
        ...videoEntries,
      ),
    );
    const audioTraf = box(
      "traf",
      fullBox("tfhd", 0, 0x020000, u32(2)),
      fullBox("tfdt", 0, 0, u32(audioBaseDecodeTime)),
      fullBox(
        "trun",
        0,
        0x000301,
        u32(audioSamples.length),
        u32(audioOffset),
        ...audioEntries,
      ),
    );
    return box("moof", mfhd, videoTraf, audioTraf);
  };
  let moof = makeMoof(0, 0);
  const payloadStart = moof.length + 8;
  moof = makeMoof(payloadStart, payloadStart + videoBytes);
  return concat([moof, box("mdat", ...videoPayloads, ...audioSamples)]);
}

export interface Fmp4Output {
  initSegment: Uint8Array;
  mediaSegment: Uint8Array;
  mimeCodec: string;
  sampleCount: number;
}

/**
 * Sample durations and composition offsets for one unit of coded pictures.
 *
 * Durations are in decode order and composition offsets carry each sample to
 * its display slot.
 *
 * A unit that starts at a random access point carries an IDR plus the skipped
 * copy of it that starts the short-term reference chain, so it holds one more
 * sample than the timeline has pictures. It is also short of pictures at the
 * front: an open GOP's leading B pictures reference an anchor the IDR flushes,
 * so the transcoder cannot code them and the first retained picture sits that
 * many display slots in.
 *
 * Those empty slots go to the IDR, which holds the same picture as the copy
 * that follows it. That leaves no gap to stall on, and -- the reason this
 * matters -- it makes every unit span exactly as many frames as the source did,
 * so units appended end to end cannot creep away from the audio.
 */
export function mpeg2SampleTiming(
  timeline: Mpeg2VideoTimeline,
  startsAtIdr: boolean,
) {
  const indices = timeline.presentationIndices;
  // The slot the unit starts on, which is not the first picture in decode
  // order: an I picture is coded ahead of the B pictures that display before
  // it, and at a random access point those B pictures are missing entirely.
  const firstIndex = indices.length > 0 ? Math.min(...indices) : 1;
  const offsets = indices.map(
    (presentationIndex, decodeIndex) =>
      (presentationIndex - firstIndex - decodeIndex) * timeline.sampleDuration,
  );
  // An anchor picture is coded before the B pictures that display ahead of it,
  // so it reaches its display slot before its decode slot -- a negative
  // composition offset, which asks a decoder to show a picture it has not
  // decoded yet. Holding the whole decode timeline back by the largest such
  // lead keeps every offset at or above zero without moving a single picture
  // relative to the audio.
  const reorderDelay = -Math.min(0, ...offsets);
  const durations = indices.map(() => timeline.sampleDuration);
  const compositions = offsets.map((offset) => offset + reorderDelay);
  if (!startsAtIdr) return { durations, compositions, reorderDelay };
  return {
    durations: [
      Math.max(1, (firstIndex - 1) * timeline.sampleDuration),
      ...durations,
    ],
    compositions: [reorderDelay, ...compositions],
    reorderDelay,
  };
}

/** How much of the presentation one fragment covers, needed before its audio is chosen. */
export function mpeg2FragmentDuration(
  timeline: Mpeg2VideoTimeline,
  startsAtIdr: boolean,
): number {
  return mpeg2SampleTiming(timeline, startsAtIdr).durations.reduce(
    (sum, value) => sum + value,
    0,
  );
}

/** Package this transcoder's Annex B output as one video-only MSE presentation. */
export function h264ToFmp4(
  h264: Uint8Array,
  timeline: Mpeg2VideoTimeline,
): Fmp4Output {
  const nals = splitAnnexB(h264);
  const sps = nals.find((nal) => (nal[0]! & 0x1f) === 7);
  const pps = nals.find((nal) => (nal[0]! & 0x1f) === 8);
  const sei = nals.find((nal) => (nal[0]! & 0x1f) === 6);
  const samples = nals.filter((nal) => {
    const type = nal[0]! & 0x1f;
    return type === 1 || type === 5;
  });
  if (!sps || !pps) throw new Error("H.264 stream lacks SPS or PPS");
  const hasIdrClone =
    samples.length === timeline.presentationIndices.length + 1;
  const expected = timeline.presentationIndices.length + (hasIdrClone ? 1 : 0);
  if (samples.length !== expected) {
    throw new Error(
      `H.264 sample count ${samples.length} does not match MPEG-2 timeline ${expected}`,
    );
  }
  const { durations, compositions } = mpeg2SampleTiming(timeline, hasIdrClone);
  const codec = [sps[1]!, sps[2]!, sps[3]!]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  return {
    initSegment: makeInitSegment(
      timeline.width,
      timeline.height,
      sps,
      pps,
      undefined,
      timeline.sampleAspectRatio,
    ),
    mediaSegment: makeMediaSegment(
      samples,
      durations,
      compositions,
      samples.map((sample) => (sample[0]! & 0x1f) === 5),
      1,
      0,
      sei ? [sei] : [],
    ),
    mimeCodec: `video/mp4; codecs="avc1.${codec}"`,
    sampleCount: samples.length,
  };
}

export interface Fmp4FragmentOutput extends Fmp4Output {
  /** Presentation time this fragment covers; see mpeg2SampleTiming. */
  duration: number;
}

export interface Fmp4AudioSamples {
  config: AacConfig;
  samples: Uint8Array[];
  baseDecodeTime: number;
}

/** Package one independently transcoded GOP for incremental MSE appending. */
export function h264GopToFmp4(
  h264: Uint8Array,
  timeline: Mpeg2VideoTimeline,
  sequenceNumber: number,
  /** Media time of the fragment's first displayed picture. */
  presentationStart: number,
  audio?: AacConfig,
  audioTrack?: Fmp4AudioSamples,
): Fmp4FragmentOutput {
  const nals = splitAnnexB(h264);
  const sps = nals.find((nal) => (nal[0]! & 0x1f) === 7);
  const pps = nals.find((nal) => (nal[0]! & 0x1f) === 8);
  const sei = nals.find((nal) => (nal[0]! & 0x1f) === 6);
  const samples = nals.filter((nal) => {
    const type = nal[0]! & 0x1f;
    return type === 1 || type === 5;
  });
  const hasIdrClone =
    samples.length === timeline.presentationIndices.length + 1;
  const expectedSamples =
    timeline.presentationIndices.length + (hasIdrClone ? 1 : 0);
  if (samples.length !== expectedSamples) {
    throw new Error("H.264 GOP sample count does not match MPEG-2 timeline");
  }
  const { durations, compositions, reorderDelay } = mpeg2SampleTiming(
    timeline,
    hasIdrClone,
  );
  // Decoding runs ahead of display by the reorder delay; a fragment at the very
  // start of the timeline has nowhere to put it and simply displays that much
  // later.
  const baseDecodeTime = Math.max(0, presentationStart - reorderDelay);
  const syncSamples = samples.map((sample) => (sample[0]! & 0x1f) === 5);
  const codec = sps
    ? [sps[1]!, sps[2]!, sps[3]!]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
    : "";
  return {
    initSegment:
      sps && pps
        ? makeInitSegment(
            timeline.width,
            timeline.height,
            sps,
            pps,
            audio,
            timeline.sampleAspectRatio,
          )
        : new Uint8Array(0),
    mediaSegment: audioTrack
      ? makeAvMediaSegment(
          samples,
          durations,
          compositions,
          syncSamples,
          audioTrack.samples,
          sequenceNumber,
          baseDecodeTime,
          audioTrack.baseDecodeTime,
          sei ? [sei] : [],
        )
      : makeMediaSegment(
          samples,
          durations,
          compositions,
          syncSamples,
          sequenceNumber,
          baseDecodeTime,
          sei ? [sei] : [],
        ),
    mimeCodec: codec
      ? `video/mp4; codecs="avc1.${codec}${audio ? ",mp4a.40.2" : ""}"`
      : "",
    sampleCount: samples.length,
    duration: durations.reduce((sum, value) => sum + value, 0),
  };
}

export interface AacFmp4Fragment {
  mediaSegment: Uint8Array;
  duration: number;
  sampleCount: number;
}

/** Build an audio-only fragmented MP4 initialization segment for one AAC-LC track. */
export function aacFmp4Init(config: AacConfig): {
  initSegment: Uint8Array;
  mimeCodec: string;
} {
  const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso6mp41"));
  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(TIMESCALE),
    u32(0),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    zeros(8),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000),
    zeros(24),
    u32(2),
  );
  const tkhd = fullBox(
    "tkhd",
    0,
    7,
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(0),
    zeros(8),
    u16(0),
    u16(0),
    u16(0x0100),
    u16(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000),
    u32(0),
    u32(0),
  );
  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(config.sampleRate),
    u32(0),
    u16(0x55c4),
    u16(0),
  );
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    ascii("soun"),
    zeros(12),
    ascii("SoundHandler\0"),
  );
  const url = fullBox("url ", 0, 1);
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), url));
  const mp4a = box(
    "mp4a",
    zeros(6),
    u16(1),
    zeros(8),
    u16(config.channelCount),
    u16(16),
    u16(0),
    u16(0),
    u32(config.sampleRate << 16),
    makeEsds(config),
  );
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), mp4a),
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0)),
  );
  const trak = box(
    "trak",
    tkhd,
    box(
      "mdia",
      mdhd,
      hdlr,
      box("minf", fullBox("smhd", 0, 0, u16(0), u16(0)), dinf, stbl),
    ),
  );
  const trex = fullBox("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0));
  return {
    initSegment: concat([ftyp, box("moov", mvhd, trak, box("mvex", trex))]),
    mimeCodec: 'audio/mp4; codecs="mp4a.40.2"',
  };
}

/** Package raw AAC access units (ADTS headers already removed) for an audio SourceBuffer. */
export function aacToFmp4Fragment(
  samples: Uint8Array[],
  sequenceNumber: number,
  baseDecodeTime: number,
): AacFmp4Fragment {
  return {
    mediaSegment: makeAudioMediaSegment(
      samples,
      sequenceNumber,
      baseDecodeTime,
    ),
    duration: samples.length * 1024,
    sampleCount: samples.length,
  };
}
