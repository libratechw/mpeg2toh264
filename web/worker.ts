import { h264GopToFmp4, mpeg2VideoTimeline } from "../src/fmp4.ts";
import { Mpeg2GopStream } from "../src/mpeg2/gop-stream.ts";
import { MpegTsVideoDemuxer } from "../src/mpegts.ts";
import { IncrementalTranscoder } from "../src/transcode.ts";

let demuxer: MpegTsVideoDemuxer;
let gops: Mpeg2GopStream;
let sequenceNumber: number;
let baseDecodeTime: number;
let presentationBase: number;
let initialized: boolean;
let transcoder: IncrementalTranscoder;

function reset() {
  demuxer = new MpegTsVideoDemuxer();
  gops = new Mpeg2GopStream();
  sequenceNumber = 1;
  baseDecodeTime = 0;
  presentationBase = 0;
  initialized = false;
  transcoder = new IncrementalTranscoder();
}

function emitGop(mpeg2: Uint8Array) {
  const firstFragment = !initialized;
  const timeline = mpeg2VideoTimeline(mpeg2, { hasReferences: initialized });
  const h264 = transcoder.push(mpeg2);
  const fragment = h264GopToFmp4(
    h264.bitstream,
    timeline,
    sequenceNumber++,
    baseDecodeTime,
    presentationBase,
  );
  baseDecodeTime += fragment.duration;
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
    },
    [fragment.mediaSegment.buffer],
  );
}

function consumeElementary(parts: Uint8Array[]) {
  for (const part of parts) for (const gop of gops.push(part)) emitGop(gop);
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
      for (const gop of gops.finish()) emitGop(gop);
      self.postMessage({ type: "done" });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
