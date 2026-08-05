import { h264GopToFmp4, mpeg2VideoTimeline } from "../src/fmp4.ts";
import { AdtsStream, type AacConfig, type AacFrame } from "../src/aac/adts.ts";
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

function reset() {
  demuxer = new MpegTsAvDemuxer();
  gops = new Mpeg2GopStream();
  adts = new AdtsStream();
  sequenceNumber = 1;
  videoBaseDecodeTime = 0;
  audioBaseDecodeTime = 0;
  presentationBase = 0;
  initialized = false;
  transcoder = new IncrementalTranscoder();
  pendingGops = [];
  pendingAudio = [];
  audioConfig = null;
}

function emitGop(mpeg2: Uint8Array, audioFrames: AacFrame[]) {
  const firstFragment = !initialized;
  const timeline = mpeg2VideoTimeline(mpeg2, { hasReferences: initialized });
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
      samples: fragment.sampleCount - (firstFragment ? 1 : 0),
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
    const gop = pendingGops.shift()!;
    const timeline = mpeg2VideoTimeline(gop, { hasReferences: initialized });
    const videoDuration =
      timeline.presentationIndices.length * timeline.sampleDuration;
    const wanted = Math.max(
      1,
      Math.round((videoDuration * audioConfig.sampleRate) / (90_000 * 1024)),
    );
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
