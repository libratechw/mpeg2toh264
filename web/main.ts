interface WorkerResult {
  type: "result";
  initSegment: ArrayBuffer;
  mediaSegment: ArrayBuffer;
  mimeCodec: string;
  sampleCount: number;
}

const input = document.querySelector<HTMLInputElement>("#file")!;
const video = document.querySelector<HTMLVideoElement>("#video")!;
const status = document.querySelector<HTMLElement>("#status")!;
const details = document.querySelector<HTMLElement>("#details")!;
let objectUrl: string | null = null;
let worker: Worker | null = null;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function sourceOpen(mediaSource: MediaSource): Promise<void> {
  if (mediaSource.readyState === "open") return Promise.resolve();
  return new Promise((resolve) =>
    mediaSource.addEventListener("sourceopen", () => resolve(), { once: true }),
  );
}

function append(source: SourceBuffer, data: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      source.removeEventListener("error", failed);
      resolve();
    };
    const failed = () => {
      source.removeEventListener("updateend", done);
      reject(new Error("SourceBufferへのappendに失敗しました"));
    };
    source.addEventListener("updateend", done, { once: true });
    source.addEventListener("error", failed, { once: true });
    source.appendBuffer(data);
  });
}

async function play(result: WorkerResult) {
  if (!("MediaSource" in window))
    throw new Error("このブラウザはMedia Source Extensionsに対応していません");
  if (!MediaSource.isTypeSupported(result.mimeCodec)) {
    throw new Error(
      `このブラウザは ${result.mimeCodec} をサポートしていません`,
    );
  }
  const mediaSource = new MediaSource();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  await sourceOpen(mediaSource);
  const source = mediaSource.addSourceBuffer(result.mimeCodec);
  source.mode = "segments";
  await append(source, result.initSegment);
  await append(source, result.mediaSegment);
  mediaSource.endOfStream();
  details.textContent = `${result.sampleCount} samples · ${result.mimeCodec}`;
  setStatus("変換完了。映像を再生できます。");
  await video.play().catch(() => undefined);
}

input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;
  worker?.terminate();
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  details.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MiB`;
  setStatus("ファイルを読み込んでいます…");
  try {
    const data = await file.arrayBuffer();
    worker.onmessage = (event: MessageEvent) => {
      if (event.data.type === "status") setStatus(event.data.message);
      else if (event.data.type === "error") setStatus(event.data.message, true);
      else if (event.data.type === "result") {
        void play(event.data as WorkerResult).catch((error) =>
          setStatus(error.message, true),
        );
      }
    };
    worker.postMessage(data, [data]);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});
