import { h264ToFmp4, mpeg2VideoTimeline } from "../src/fmp4.ts";
import { extractMpeg2VideoEs, isMpegTransportStream } from "../src/mpegts.ts";
import { transcode } from "../src/transcode.ts";

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const transport = new Uint8Array(event.data);
    if (!isMpegTransportStream(transport))
      throw new Error("選択されたファイルはMPEG-TSではありません");
    self.postMessage({ type: "status", message: "MPEG-TSをdemuxしています…" });
    const mpeg2 = extractMpeg2VideoEs(transport);
    const timeline = mpeg2VideoTimeline(mpeg2);
    self.postMessage({
      type: "status",
      message: "MPEG-2映像をH.264へ変換しています…",
    });
    const result = transcode(mpeg2);
    self.postMessage({
      type: "status",
      message: "fragmented MP4を構築しています…",
    });
    const mp4 = h264ToFmp4(result.bitstream, timeline);
    self.postMessage(
      {
        type: "result",
        initSegment: mp4.initSegment.buffer,
        mediaSegment: mp4.mediaSegment.buffer,
        mimeCodec: mp4.mimeCodec,
        sampleCount: mp4.sampleCount,
      },
      [mp4.initSegment.buffer, mp4.mediaSegment.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
