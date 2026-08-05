const CHUNK_SIZE = 1024 * 1024;
const QUEUE_HIGH_WATER = 32 * 1024 * 1024;
const KEEP_BEHIND_SECONDS = 10;

const input = document.querySelector<HTMLInputElement>("#file")!;
const video = document.querySelector<HTMLVideoElement>("#video")!;
const status = document.querySelector<HTMLElement>("#status")!;
const details = document.querySelector<HTMLElement>("#details")!;

let worker: Worker | null = null;
let file: File | null = null;
let fileOffset = 0;
let workerWantsChunk = false;
let workerDone = false;
let mediaSource: MediaSource | null = null;
let sourceBuffer: SourceBuffer | null = null;
let initSegment: ArrayBuffer | null = null;
let initAppended = false;
let fragments: ArrayBuffer[] = [];
let queuedBytes = 0;
let operation: "init" | "append" | "remove" | null = null;
let quotaBlocked = false;
let objectUrl: string | null = null;
let sampleCount = 0;
let audioSampleCount = 0;
/** Media times a decoder can start from, in order; see relieveQuota. */
let randomAccessPoints: number[] = [];

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function resetState() {
  worker?.terminate();
  worker = null;
  fileOffset = 0;
  workerWantsChunk = false;
  workerDone = false;
  sourceBuffer = null;
  mediaSource = null;
  initSegment = null;
  initAppended = false;
  fragments = [];
  queuedBytes = 0;
  operation = null;
  quotaBlocked = false;
  sampleCount = 0;
  audioSampleCount = 0;
  randomAccessPoints = [];
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  video.removeAttribute("src");
  video.load();
}

async function maybeFeedWorker() {
  if (
    !worker ||
    !file ||
    !workerWantsChunk ||
    quotaBlocked ||
    queuedBytes >= QUEUE_HIGH_WATER
  )
    return;
  workerWantsChunk = false;
  if (fileOffset >= file.size) {
    worker.postMessage({ type: "end" });
    return;
  }
  const end = Math.min(file.size, fileOffset + CHUNK_SIZE);
  const data = await file.slice(fileOffset, end).arrayBuffer();
  fileOffset = end;
  worker.postMessage({ type: "chunk", data }, [data]);
  setStatus(`変換中… ${((100 * fileOffset) / file.size).toFixed(1)}%`);
}

function maybeFinish() {
  if (
    workerDone &&
    initAppended &&
    fragments.length === 0 &&
    mediaSource?.readyState === "open" &&
    !sourceBuffer?.updating
  ) {
    mediaSource.endOfStream();
    setStatus("変換完了。");
  }
}

function pump() {
  if (!sourceBuffer || sourceBuffer.updating || operation || quotaBlocked)
    return;
  let data: ArrayBuffer | undefined;
  if (!initAppended && initSegment) {
    operation = "init";
    data = initSegment;
  } else if (fragments.length > 0) {
    operation = "append";
    data = fragments[0];
  }
  if (!data) {
    maybeFinish();
    void maybeFeedWorker();
    return;
  }
  try {
    sourceBuffer.appendBuffer(data);
  } catch (error) {
    operation = null;
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      quotaBlocked = true;
      setStatus("MSEバッファが満杯です。再生が進むまで変換を停止しています…");
      // Try at once rather than waiting for playback to raise an event: if the
      // buffer ahead runs out first, nothing will raise one.
      relieveQuota();
    } else
      setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function onUpdateEnd() {
  if (operation === "init") {
    initAppended = true;
    initSegment = null;
  } else if (operation === "append") {
    const appended = fragments.shift();
    if (appended) queuedBytes -= appended.byteLength;
  } else if (operation === "remove") {
    quotaBlocked = false;
    setStatus("バッファに空きができたため変換を再開します…");
  }
  operation = null;
  pump();
  void maybeFeedWorker();
}

function relieveQuota() {
  if (!quotaBlocked || !sourceBuffer || sourceBuffer.updating || operation)
    return;
  if (sourceBuffer.buffered.length === 0) return;
  const removeStart = sourceBuffer.buffered.start(0);
  // Removing a range takes the frames after it as well, up to the next random
  // access point, so that nothing is left behind depending on what went away.
  // Restart points here are several times further apart than the margin kept
  // behind the playhead, so ending a removal at currentTime - KEEP_BEHIND
  // regularly reaches past the playhead and deletes the frames about to be
  // shown -- playback then stalls until the viewer seeks over the hole. Ending
  // exactly on a restart point removes nothing beyond it.
  const limit = video.currentTime - KEEP_BEHIND_SECONDS;
  let removeEnd = 0;
  for (const at of randomAccessPoints) {
    if (at > limit) break;
    removeEnd = at;
  }
  if (removeEnd <= removeStart) return;
  while (randomAccessPoints.length > 0 && randomAccessPoints[0]! < removeEnd) {
    randomAccessPoints.shift();
  }
  operation = "remove";
  sourceBuffer.remove(removeStart, removeEnd);
}

function openMediaSource(mimeCodec: string) {
  if (!MediaSource.isTypeSupported(mimeCodec))
    throw new Error(`未対応のcodecです: ${mimeCodec}`);
  mediaSource = new MediaSource();
  objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  mediaSource.addEventListener(
    "sourceopen",
    () => {
      sourceBuffer = mediaSource!.addSourceBuffer(mimeCodec);
      sourceBuffer.mode = "segments";
      sourceBuffer.addEventListener("updateend", onUpdateEnd);
      sourceBuffer.addEventListener("error", () =>
        setStatus("SourceBufferエラー", true),
      );
      pump();
    },
    { once: true },
  );
}

video.addEventListener("timeupdate", relieveQuota);
video.addEventListener("waiting", relieveQuota);
video.addEventListener("stalled", relieveQuota);

input.addEventListener("change", () => {
  const selected = input.files?.[0];
  if (!selected) return;
  resetState();
  file = selected;
  details.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MiB`;
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent) => {
    const message = event.data;
    if (message.type === "pull") {
      workerWantsChunk = true;
      void maybeFeedWorker();
    } else if (message.type === "init") {
      initSegment = message.data;
      try {
        openMediaSource(message.mimeCodec);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    } else if (message.type === "fragment") {
      if (message.randomAccess) randomAccessPoints.push(message.start);
      fragments.push(message.data);
      queuedBytes += message.data.byteLength;
      sampleCount += message.videoSamples ?? 0;
      audioSampleCount += message.audioSamples ?? 0;
      const audio =
        audioSampleCount > 0 ? ` · ${audioSampleCount} AAC frames` : "";
      details.textContent = `${file!.name} · ${sampleCount} video frames${audio} · queue ${(queuedBytes / 1024 / 1024).toFixed(1)} MiB`;
      pump();
    } else if (message.type === "done") {
      workerDone = true;
      maybeFinish();
    } else if (message.type === "error") setStatus(message.message, true);
  };
  setStatus("ストリーミング変換を開始します…");
  worker.postMessage({ type: "start" });
});
