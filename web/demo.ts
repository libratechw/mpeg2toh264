/**
 * The demo page. Everything it does is call the library and write the result
 * into the DOM -- the player itself is in src/ and knows nothing about this.
 */
import {
  Mpeg2TsPlayer,
  supportsWorkerMediaSource,
  type PlayerState,
} from "./src/index.js";

const video = document.querySelector<HTMLVideoElement>("#video")!;
const urlForm = document.querySelector<HTMLFormElement>("#url-form")!;
const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const placement = document.querySelector<HTMLSelectElement>("#placement")!;
const status = document.querySelector<HTMLElement>("#status")!;
const details = document.querySelector<HTMLElement>("#details")!;
const fps = document.querySelector<HTMLElement>("#fps")!;

const IDLE_FPS = "変換FPS: 瞬間 — · トータル —";

const STATES: Record<PlayerState, string> = {
  idle: "MPEG-2 TSのURLを指定するか、ファイルを選択してください。",
  loading: "入力を読み込んでいます…",
  converting: "変換中…",
  "buffer-full": "MSEバッファが満杯です。再生が進むまで変換を停止しています…",
  seeking: "シーク先を読み込んでいます…",
  completed: "変換完了。",
  error: "",
};

function formatDuration(seconds: number): string {
  const whole = Math.floor(seconds);
  const parts = [
    Math.floor(whole / 3600),
    Math.floor(whole / 60) % 60,
    whole % 60,
  ];
  return parts
    .slice(parts[0] === 0 ? 1 : 0)
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join(":");
}

let player: Mpeg2TsPlayer | null = null;
/** The blob URL for a picked file, revoked when the next source replaces it. */
let fileUrl: string | null = null;
let label = "";
let progress = "";
let counts = "";
let length = "";

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function setDetails() {
  details.textContent = [label, length, progress, counts]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A player is bound to one MediaSource placement, so switching where MSE runs
 * means building a new one. Each source gets a fresh player for that reason.
 */
function createPlayer(): Mpeg2TsPlayer {
  player?.destroy();
  const mediaSource = placement.value as "auto" | "worker" | "main";
  const created = new Mpeg2TsPlayer(video, { mediaSource });
  created.addEventListener("statechange", (event) => {
    const { state } = event.detail;
    if (state === "converting") setStatus(`${STATES.converting}${progress}`);
    else if (state !== "error") setStatus(STATES[state]);
  });
  created.addEventListener("progress", (event) => {
    const { bytesRead, totalBytes } = event.detail;
    progress = totalBytes
      ? ` ${((100 * bytesRead) / totalBytes).toFixed(1)}%`
      : ` ${(bytesRead / 1024 / 1024).toFixed(1)} MiB`;
    if (created.state === "converting")
      setStatus(`${STATES.converting}${progress}`);
  });
  created.addEventListener("seekable", (event) => {
    length = `${formatDuration(event.detail.duration)}（シーク可能）`;
    setDetails();
  });
  created.addEventListener("stats", (event) => {
    const { instantFps, totalFps, videoFrames, audioFrames } = event.detail;
    fps.textContent = `変換FPS: 瞬間 ${instantFps.toFixed(1)} · トータル ${totalFps.toFixed(1)}`;
    counts = `${videoFrames} video frames`;
    if (audioFrames > 0) counts += ` · ${audioFrames} AAC frames`;
    setDetails();
  });
  created.addEventListener("error", (event) =>
    setStatus(event.detail.error.message, true),
  );
  player = created;
  return created;
}

function play(
  url: string,
  sourceLabel: string,
  ownedUrl: string | null = null,
) {
  if (fileUrl && fileUrl !== ownedUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = ownedUrl;
  label = sourceLabel;
  progress = "";
  counts = "";
  length = "";
  fps.textContent = IDLE_FPS;
  setDetails();
  // Failures already arrive as an error event, which is what writes the
  // message; the rejection here is the same one and needs no second report.
  void createPlayer()
    .load(url)
    .catch(() => {});
}

urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (url) play(url, url);
});

// The library takes a URL, so a picked file becomes one. The worker fetches
// blob URLs the same as any other, and the bytes never leave the page.
fileInput.addEventListener("change", () => {
  const selected = fileInput.files?.[0];
  if (!selected) return;
  const url = URL.createObjectURL(selected);
  play(url, selected.name, url);
});

if (!supportsWorkerMediaSource()) {
  const auto = placement.querySelector<HTMLOptionElement>(
    'option[value="auto"]',
  )!;
  auto.textContent = `${auto.textContent} — このブラウザーはメインスレッド`;
  placement.querySelector<HTMLOptionElement>(
    'option[value="worker"]',
  )!.disabled = true;
}

setStatus(STATES.idle);
