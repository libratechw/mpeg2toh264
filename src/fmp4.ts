import { PictureType } from "./mpeg2/constants.ts";
import { parseElementaryStream } from "./mpeg2/headers.ts";

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
  /** Presentation index for each coded picture, after the leading grey IDR. */
  presentationIndices: number[];
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
    if (type !== PictureType.B) references = Math.min(2, references + 1);
  }
  return {
    width: first.sequence.horizontalSize,
    height: first.sequence.verticalSize,
    sampleDuration,
    presentationIndices,
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

function makeInitSegment(
  width: number,
  height: number,
  sps: Uint8Array,
  pps: Uint8Array,
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
  return concat([ftyp, box("moov", mvhd, trak, box("mvex", trex))]);
}

function lengthPrefixed(nal: Uint8Array): Uint8Array {
  return concat([u32(nal.length), nal]);
}

function makeMediaSegment(
  samples: Uint8Array[],
  durations: number[],
  compositions: number[],
  sequenceNumber = 1,
  baseDecodeTime = 0,
) {
  const payloads = samples.map(lengthPrefixed);
  const entries: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sync = (samples[i]![0]! & 0x1f) === 5;
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

export interface Fmp4Output {
  initSegment: Uint8Array;
  mediaSegment: Uint8Array;
  mimeCodec: string;
  sampleCount: number;
}

/** Package this transcoder's Annex B output as one video-only MSE presentation. */
export function h264ToFmp4(
  h264: Uint8Array,
  timeline: Mpeg2VideoTimeline,
): Fmp4Output {
  const nals = splitAnnexB(h264);
  const sps = nals.find((nal) => (nal[0]! & 0x1f) === 7);
  const pps = nals.find((nal) => (nal[0]! & 0x1f) === 8);
  const samples = nals.filter((nal) => {
    const type = nal[0]! & 0x1f;
    return type === 1 || type === 5;
  });
  if (!sps || !pps) throw new Error("H.264 stream lacks SPS or PPS");
  const presentation = [0, ...timeline.presentationIndices];
  if (samples.length !== presentation.length) {
    throw new Error(
      `H.264 sample count ${samples.length} does not match MPEG-2 timeline ${presentation.length}`,
    );
  }
  const codec = [sps[1]!, sps[2]!, sps[3]!]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  return {
    initSegment: makeInitSegment(timeline.width, timeline.height, sps, pps),
    mediaSegment: makeMediaSegment(
      samples,
      samples.map(() => timeline.sampleDuration),
      presentation.map(
        (value, index) => (value - index) * timeline.sampleDuration,
      ),
    ),
    mimeCodec: `video/mp4; codecs="avc1.${codec}"`,
    sampleCount: samples.length,
  };
}

export interface Fmp4FragmentOutput extends Fmp4Output {
  /** Decode timeline consumed by content pictures; the zero-duration grey IDR is excluded. */
  duration: number;
}

/** Package one independently transcoded GOP for incremental MSE appending. */
export function h264GopToFmp4(
  h264: Uint8Array,
  timeline: Mpeg2VideoTimeline,
  sequenceNumber: number,
  baseDecodeTime: number,
  presentationBase = 0,
): Fmp4FragmentOutput {
  const nals = splitAnnexB(h264);
  const sps = nals.find((nal) => (nal[0]! & 0x1f) === 7);
  const pps = nals.find((nal) => (nal[0]! & 0x1f) === 8);
  const samples = nals.filter((nal) => {
    const type = nal[0]! & 0x1f;
    return type === 1 || type === 5;
  });
  const hasGreyIdr = Boolean(sps && pps);
  const expectedSamples =
    timeline.presentationIndices.length + (hasGreyIdr ? 1 : 0);
  if (samples.length !== expectedSamples) {
    throw new Error("H.264 GOP sample count does not match MPEG-2 timeline");
  }
  const contentDurations = timeline.presentationIndices.map(
    () => timeline.sampleDuration,
  );
  const contentCompositions = timeline.presentationIndices.map(
    (presentationIndex, decodeIndex) => {
      const desired =
        (presentationBase + presentationIndex) * timeline.sampleDuration;
      const decoded =
        baseDecodeTime +
        (hasGreyIdr ? timeline.sampleDuration : 0) +
        decodeIndex * timeline.sampleDuration;
      return desired - decoded;
    },
  );
  const durations = hasGreyIdr
    ? [timeline.sampleDuration, ...contentDurations]
    : contentDurations;
  const compositions = hasGreyIdr
    ? [0, ...contentCompositions]
    : contentCompositions;
  const codec = sps
    ? [sps[1]!, sps[2]!, sps[3]!]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
    : "";
  return {
    initSegment:
      sps && pps
        ? makeInitSegment(timeline.width, timeline.height, sps, pps)
        : new Uint8Array(0),
    mediaSegment: makeMediaSegment(
      samples,
      durations,
      compositions,
      sequenceNumber,
      baseDecodeTime,
    ),
    mimeCodec: codec ? `video/mp4; codecs="avc1.${codec}"` : "",
    sampleCount: samples.length,
    duration: durations.reduce((sum, value) => sum + value, 0),
  };
}
