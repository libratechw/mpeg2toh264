import {
  h264GopToFmp4,
  mpeg2FragmentDuration,
  mpeg2VideoTimeline,
  type Mpeg2VideoTimeline,
} from "../src/fmp4.ts";
import {
  aacFrameCountThroughVideoTime,
  AdtsStream,
  type AacConfig,
  type AacFrame,
} from "../src/aac/adts.ts";
import { Mpeg2GopStream, type Mpeg2Gop } from "../src/mpeg2/gop-stream.ts";
import { MpegTsAvDemuxer, type MpegTsElementaryPacket } from "../src/mpegts.ts";
import { IncrementalTranscoder } from "../src/transcode.ts";

let demuxer: MpegTsAvDemuxer;
let gops: Mpeg2GopStream;
let adts: AdtsStream;
let sequenceNumber: number;
let videoPresentationStart: number;
let audioFramesEmitted: number;
let initialized: boolean;
let transcoder: IncrementalTranscoder;
let pendingGops: Mpeg2Gop[];
let pendingAudio: AacFrame[];
let audioConfig: AacConfig | null;
let gopsEmitted: number;
/** PES timestamp of the first audio packet, in 90 kHz units. */
let audioStartPts: number | null;
/** Where the audio track begins on the shared timeline, once it is fixed. */
let audioOriginTicks: number;
let timelinesAligned: boolean;

const RANDOM_ACCESS_GOP_INTERVAL = 24;
const TIMESCALE = 90_000;

function reset(progressive = false) {
  demuxer = new MpegTsAvDemuxer();
  gops = new Mpeg2GopStream();
  adts = new AdtsStream();
  sequenceNumber = 1;
  videoPresentationStart = 0;
  audioFramesEmitted = 0;
  initialized = false;
  transcoder = new IncrementalTranscoder({ progressive });
  pendingGops = [];
  pendingAudio = [];
  audioConfig = null;
  gopsEmitted = 0;
  audioStartPts = null;
  audioOriginTicks = 0;
  timelinesAligned = false;
}

/**
 * Put the two tracks on one timeline, using the timestamps the transport
 * stream gives them.
 *
 * Video and audio in a broadcast stream do not start at the same PTS -- a few
 * hundred milliseconds apart is normal -- so starting both tracks at zero
 * shifts the audio by exactly that difference. Both are instead placed at
 * their real distance from whichever starts first, which keeps either base
 * time from going negative.
 */
function alignTimelines(gop: Mpeg2Gop, timeline: Mpeg2VideoTimeline) {
  if (timelinesAligned) return;
  // Once a fragment has gone out the origin is fixed, whether or not the
  // timestamps to choose it ever arrived; moving it later would tear the
  // timeline in two.
  if (initialized) {
    timelinesAligned = true;
    return;
  }
  if (gop.pts === null || audioStartPts === null) return;
  timelinesAligned = true;
  // A GOP's timestamp belongs to its I picture, which is coded first but
  // displayed after the B pictures that lead the group. This only ever runs on
  // the opening fragment, where those pictures are missing and the IDR covers
  // their display slots, so the presentation still starts where they would.
  const leadingSlots = (timeline.presentationIndices[0] ?? 1) - 1;
  const videoStart = gop.pts - leadingSlots * timeline.sampleDuration;
  // Decoding leads display by up to one frame, and the muxer needs somewhere
  // to put that, so the timeline starts a frame before the earlier track.
  const origin = Math.min(videoStart - timeline.sampleDuration, audioStartPts);
  videoPresentationStart = videoStart - origin;
  audioOriginTicks = audioStartPts - origin;
}

/** Decode time of the next audio sample, in the audio track's own timescale. */
function audioBaseDecodeTime(rate: number): number {
  return (
    Math.round((audioOriginTicks * rate) / TIMESCALE) +
    audioFramesEmitted * 1024
  );
}

function emitGop(gop: Mpeg2Gop, audioFrames: AacFrame[]) {
  const randomAccess =
    gopsEmitted > 0 && gopsEmitted % RANDOM_ACCESS_GOP_INTERVAL === 0;
  if (randomAccess) {
    transcoder.requestRandomAccessPoint();
  }
  const startsAtIdr = !initialized || randomAccess;
  const timeline = mpeg2VideoTimeline(gop.data, {
    hasReferences: !startsAtIdr,
  });
  // Aligning can still move the origin, so read the start after it.
  alignTimelines(gop, timeline);
  const start = videoPresentationStart / TIMESCALE;
  const h264 = transcoder.push(gop.data);
  const config = audioFrames[0]?.config ?? audioConfig ?? undefined;
  const fragment = h264GopToFmp4(
    h264.bitstream,
    timeline,
    sequenceNumber++,
    videoPresentationStart,
    config,
    config
      ? {
          config,
          samples: audioFrames.map((frame) => frame.data),
          baseDecodeTime: audioBaseDecodeTime(config.sampleRate),
        }
      : undefined,
  );
  videoPresentationStart += fragment.duration;
  audioFramesEmitted += audioFrames.length;
  gopsEmitted++;
  if (!initialized) {
    initialized = true;
    self.postMessage(
      {
        type: "init",
        data: fragment.initSegment.buffer,
        mimeCodec: fragment.mimeCodec,
      },
      [fragment.initSegment.buffer],
    );
  }
  self.postMessage(
    {
      type: "fragment",
      data: fragment.mediaSegment.buffer,
      samples: fragment.sampleCount,
      audioSamples: audioFrames.length,
      // Where this fragment starts, and whether it can be decoded from. The
      // page needs both to evict buffered media without cutting into what is
      // about to be played; see relieveQuota in main.ts.
      start,
      randomAccess: startsAtIdr,
    },
    [fragment.mediaSegment.buffer],
  );
}

function flushPending(final = false) {
  if (!demuxer.hasAacAudio) {
    for (const gop of pendingGops) emitGop(gop, []);
    pendingGops = [];
    return;
  }
  // Keep one GOP pending so all AAC packets up to the next GOP boundary can
  // share the same moof. MSE implementations then see both trafs per fragment.
  while (
    pendingGops.length > (final ? 0 : 1) &&
    audioConfig &&
    (final || pendingAudio.length > 0)
  ) {
    const gop = pendingGops[0]!;
    const randomAccess =
      gopsEmitted > 0 && gopsEmitted % RANDOM_ACCESS_GOP_INTERVAL === 0;
    const startsAtIdr = !initialized || randomAccess;
    const timeline = mpeg2VideoTimeline(gop.data, {
      hasReferences: !startsAtIdr,
    });
    alignTimelines(gop, timeline);
    const videoDuration = mpeg2FragmentDuration(timeline, startsAtIdr);
    // Audio is measured from where the audio track itself starts, not from
    // where the video does.
    const desiredAudioFrames = aacFrameCountThroughVideoTime(
      videoPresentationStart + videoDuration - audioOriginTicks,
      audioConfig.sampleRate,
    );
    const wanted = Math.max(0, desiredAudioFrames - audioFramesEmitted);
    if (!final && pendingAudio.length < wanted) break;
    pendingGops.shift();
    const take =
      final && pendingGops.length === 0
        ? pendingAudio.length
        : Math.min(wanted, pendingAudio.length);
    emitGop(gop, pendingAudio.splice(0, take));
  }
}

function consumeElementary(parts: MpegTsElementaryPacket[]) {
  for (const part of parts) {
    if (part.kind === "video") {
      pendingGops.push(...gops.push(part.data, part.pts));
    } else {
      if (part.pts !== null) audioStartPts ??= part.pts;
      const frames = adts.push(part.data);
      audioConfig ??= frames[0]?.config ?? null;
      pendingAudio.push(...frames);
    }
    flushPending();
  }
}

reset();
self.onmessage = (
  event: MessageEvent<{
    type: string;
    data?: ArrayBuffer;
    progressive?: boolean;
  }>,
) => {
  try {
    if (event.data.type === "start") {
      reset(event.data.progressive);
      self.postMessage({ type: "pull" });
    } else if (event.data.type === "chunk") {
      consumeElementary(demuxer.push(new Uint8Array(event.data.data!)));
      self.postMessage({ type: "pull" });
    } else if (event.data.type === "end") {
      consumeElementary(demuxer.finish());
      pendingGops.push(...gops.finish());
      const finalAudio = adts.finish();
      audioConfig ??= finalAudio[0]?.config ?? null;
      pendingAudio.push(...finalAudio);
      flushPending(true);
      self.postMessage({ type: "done" });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
