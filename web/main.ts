const QUEUE_HIGH_WATER = 32 * 1024 * 1024;
const KEEP_BEHIND_SECONDS = 10;

const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const urlForm = document.querySelector<HTMLFormElement>("#url-form")!;
const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const video = document.querySelector<HTMLVideoElement>("#video")!;
const status = document.querySelector<HTMLElement>("#status")!;
const details = document.querySelector<HTMLElement>("#details")!;
const fps = document.querySelector<HTMLElement>("#fps")!;

let worker: Worker | null = null;
let inputReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let inputAbortController: AbortController | null = null;
let inputObjectUrl: string | null = null;
let inputLabel = "";
let inputLength: number | null = null;
let inputBytesRead = 0;
let sourceGeneration = 0;
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
/** Whether the playhead has been put where the media starts; see startAtMedia. */
let playheadPlaced = false;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function resetState() {
  sourceGeneration++;
  worker?.terminate();
  worker = null;
  void inputReader?.cancel();
  inputReader = null;
  inputAbortController?.abort();
  inputAbortController = null;
  if (inputObjectUrl) URL.revokeObjectURL(inputObjectUrl);
  inputObjectUrl = null;
  inputLabel = "";
  inputLength = null;
  inputBytesRead = 0;
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
  fps.textContent = "変換FPS: 瞬間 — · トータル —";
  randomAccessPoints = [];
  playheadPlaced = false;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  video.removeAttribute("src");
  video.load();
}

async function maybeFeedWorker() {
  if (
    !worker ||
    !inputReader ||
    !workerWantsChunk ||
    quotaBlocked ||
    queuedBytes >= QUEUE_HIGH_WATER
  )
    return;
  const activeWorker = worker;
  const activeReader = inputReader;
  const generation = sourceGeneration;
  workerWantsChunk = false;
  let result: ReadableStreamReadResult<Uint8Array>;
  try {
    result = await activeReader.read();
  } catch (error) {
    if (generation !== sourceGeneration || inputAbortController?.signal.aborted)
      return;
    setStatus(
      `入力の読み込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
    return;
  }
  if (
    generation !== sourceGeneration ||
    worker !== activeWorker ||
    inputReader !== activeReader
  )
    return;
  if (result.done) {
    inputReader = null;
    activeWorker.postMessage({ type: "end" });
    return;
  }
  const chunk = result.value;
  inputBytesRead += chunk.byteLength;
  const data = chunk.buffer.slice(
    chunk.byteOffset,
    chunk.byteOffset + chunk.byteLength,
  ) as ArrayBuffer;
  activeWorker.postMessage({ type: "chunk", data }, [data]);
  const progress = inputLength
    ? ` ${((100 * inputBytesRead) / inputLength).toFixed(1)}%`
    : ` ${(inputBytesRead / 1024 / 1024).toFixed(1)} MiB`;
  setStatus(`変換中…${progress}`);
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

/**
 * Put the playhead where the media begins, which is not zero.
 *
 * The timeline keeps the distance the transport stream put between the two
 * tracks, so it opens with only the earlier one on it -- audio alone for over
 * 0.7 s where a recording starts mid-GOP, and at least one frame even when
 * they start together, because the muxer needs somewhere to put the first
 * decode time. buffered is the intersection of the two track buffers, so it
 * begins after that, and nothing is ever appended at zero. Chrome moves the
 * playhead into the first buffered range by itself; Firefox waits at zero for
 * data that is not coming.
 */
function startAtMedia() {
  if (playheadPlaced || !sourceBuffer || sourceBuffer.buffered.length === 0)
    return;
  playheadPlaced = true;
  const start = sourceBuffer.buffered.start(0);
  if (video.currentTime < start) video.currentTime = start;
}

function onUpdateEnd() {
  if (operation === "init") {
    initAppended = true;
    initSegment = null;
  } else if (operation === "append") {
    const appended = fragments.shift();
    if (appended) queuedBytes -= appended.byteLength;
    startAtMedia();
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

async function startSource(
  url: string,
  label: string,
  objectUrl: string | null = null,
) {
  resetState();
  const generation = sourceGeneration;
  inputObjectUrl = objectUrl;
  inputLabel = label;
  const abortController = new AbortController();
  inputAbortController = abortController;
  setStatus("入力を読み込んでいます…");

  let response: Response;
  try {
    response = await fetch(url, { signal: abortController.signal });
  } catch (error) {
    if (abortController.signal.aborted || generation !== sourceGeneration)
      return;
    setStatus(
      `URLを取得できません: ${error instanceof Error ? error.message : String(error)}（配信元のCORS設定も確認してください）`,
      true,
    );
    return;
  }
  if (generation !== sourceGeneration) return;
  if (!response.ok) {
    setStatus(
      `URLを取得できません: HTTP ${response.status} ${response.statusText}`,
      true,
    );
    return;
  }
  if (!response.body) {
    setStatus(
      "このURLのレスポンスはストリーミング読み込みに対応していません。",
      true,
    );
    return;
  }

  const contentLength = Number(response.headers.get("content-length"));
  inputLength =
    Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  inputReader = response.body.getReader();
  details.textContent = inputLength
    ? `${inputLabel} · ${(inputLength / 1024 / 1024).toFixed(1)} MiB`
    : inputLabel;
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
      details.textContent = `${inputLabel} · ${sampleCount} video frames${audio} · queue ${(queuedBytes / 1024 / 1024).toFixed(1)} MiB`;
      pump();
    } else if (message.type === "performance") {
      fps.textContent = `変換FPS: 瞬間 ${message.instantFps.toFixed(1)} · トータル ${message.totalFps.toFixed(1)}`;
    } else if (message.type === "done") {
      workerDone = true;
      maybeFinish();
    } else if (message.type === "error") setStatus(message.message, true);
  };
  setStatus("ストリーミング変換を開始します…");
  worker.postMessage({ type: "start" });
}

fileInput.addEventListener("change", () => {
  const selected = fileInput.files?.[0];
  if (!selected) return;
  const url = URL.createObjectURL(selected);
  void startSource(url, selected.name, url);
});

urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  void startSource(url, url);
});
