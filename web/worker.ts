import { h264GopToFmp4, mpeg2VideoTimeline } from "../src/fmp4.ts";
import {
  aacFrameCountThroughVideoTime,
  AdtsStream,
  type AacConfig,
  type AacFrame,
} from "../src/aac/adts.ts";
import { Mpeg2GopStream } from "../src/mpeg2/gop-stream.ts";
import { MpegTsAvDemuxer, type MpegTsElementaryPacket } from "../src/mpegts.ts";
import { IncrementalTranscoder } from "../src/transcode.ts";

let demuxer: MpegTsAvDemuxer;
let gops: Mpeg2GopStream;
let adts: AdtsStream;
let sequenceNumber: number;
let videoBaseDecodeTime: number;
let audioBaseDecodeTime: number;
let presentationBase: number;
let initialized: boolean;
let transcoder: IncrementalTranscoder;
let pendingGops: Uint8Array[];
let pendingAudio: AacFrame[];
let audioConfig: AacConfig | null;
let gopsEmitted: number;

const RANDOM_ACCESS_GOP_INTERVAL = 24;

function reset() {
  demuxer = new MpegTsAvDemuxer();
  gops = new Mpeg2GopStream();
  adts = new AdtsStream();
  sequenceNumber = 1;
  videoBaseDecodeTime = 0;
  audioBaseDecodeTime = 0;
  presentationBase = 0;
  initialized = false;
  transcoder = new IncrementalTranscoder({ pcmIntra: true });
  pendingGops = [];
  pendingAudio = [];
  audioConfig = null;
  gopsEmitted = 0;
}

function emitGop(mpeg2: Uint8Array, audioFrames: AacFrame[]) {
  const randomAccess =
    gopsEmitted > 0 && gopsEmitted % RANDOM_ACCESS_GOP_INTERVAL === 0;
  if (randomAccess) {
    transcoder.requestRandomAccessPoint();
  }
  const timeline = mpeg2VideoTimeline(mpeg2, {
    hasReferences: initialized && !randomAccess,
  });
  const h264 = transcoder.push(mpeg2);
  const config = audioFrames[0]?.config ?? audioConfig ?? undefined;
  const fragment = h264GopToFmp4(
    h264.bitstream,
    timeline,
    sequenceNumber++,
    videoBaseDecodeTime,
    presentationBase,
    config,
    config
      ? {
          config,
          samples: audioFrames.map((frame) => frame.data),
          baseDecodeTime: audioBaseDecodeTime,
        }
      : undefined,
  );
  videoBaseDecodeTime += fragment.duration;
  audioBaseDecodeTime += audioFrames.length * 1024;
  presentationBase += Math.max(...timeline.presentationIndices);
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
    const timeline = mpeg2VideoTimeline(gop, {
      hasReferences: initialized && !randomAccess,
    });
    const videoDuration =
      timeline.presentationIndices.length * timeline.sampleDuration +
      (initialized ? 0 : 1);
    const desiredAudioFrames = aacFrameCountThroughVideoTime(
      videoBaseDecodeTime + videoDuration,
      audioConfig.sampleRate,
    );
    const wanted = Math.max(0, desiredAudioFrames - audioBaseDecodeTime / 1024);
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
    if (part.kind === "video") pendingGops.push(...gops.push(part.data));
    else {
      const frames = adts.push(part.data);
      audioConfig ??= frames[0]?.config ?? null;
      pendingAudio.push(...frames);
    }
    flushPending();
  }
}

reset();
self.onmessage = (
  event: MessageEvent<{ type: string; data?: ArrayBuffer }>,
) => {
  try {
    if (event.data.type === "start") {
      reset();
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
