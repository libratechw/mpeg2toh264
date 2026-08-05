/**
 * The demo page. Everything it does is call the library and write the result
 * into the DOM -- the player itself is in src/ and knows nothing about this.
 */
import {
  Mpeg2TsPlayer,
  supportsDeinterlace,
  supportsWorkerMediaSource,
  type PlayerState,
} from "./src/index.js";

const video = document.querySelector<HTMLVideoElement>("#video")!;
const urlForm = document.querySelector<HTMLFormElement>("#url-form")!;
const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const placement = document.querySelector<HTMLSelectElement>("#placement")!;
const playPause = document.querySelector<HTMLButtonElement>("#playpause")!;
const seek = document.querySelector<HTMLInputElement>("#seek")!;
const time = document.querySelector<HTMLElement>("#time")!;
const deinterlace = document.querySelector<HTMLInputElement>("#deinterlace")!;
const doubleRate = document.querySelector<HTMLInputElement>("#double-rate")!;
const status = document.querySelector<HTMLElement>("#status")!;
const details = document.querySelector<HTMLElement>("#details")!;
const fps = document.querySelector<HTMLElement>("#fps")!;
const deinterlaceStats =
  document.querySelector<HTMLElement>("#deinterlace-stats")!;

/** How many steps the seek bar divides the video into. */
const SEEK_STEPS = 1000;

const IDLE_FPS = "変換FPS: 瞬間 — · トータル —";
const IDLE_DEINTERLACE = "デインタレース: —";

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
/** How long the input is, once it turns out to be one that can be seeked. */
let duration: number | null = null;
/** Whether the bar is being dragged, which owns the position until let go. */
let scrubbing = false;

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
  const created = new Mpeg2TsPlayer(video, {
    mediaSource,
    deinterlace: deinterlace.checked && { doubleRate: doubleRate.checked },
  });
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
  // Where the time before the first frame went. The console is the right place
  // for it: it is a measurement, not something a viewer is meant to read.
  created.addEventListener("timing", (event) => {
    const { name, sinceLoad, sincePrevious } = event.detail;
    console.log(
      `[timing] ${sinceLoad.toFixed(0).padStart(6)}ms  ${name.padEnd(14)} ` +
        `(+${sincePrevious.toFixed(0)}ms)`,
    );
  });
  created.addEventListener("seekable", (event) => {
    duration = event.detail.duration;
    seek.disabled = false;
    length = `${formatDuration(duration)}（シーク可能）`;
    setDetails();
    setPlayhead();
  });
  created.addEventListener("stats", (event) => {
    const { instantFps, totalFps, videoFrames, audioFrames } = event.detail;
    const { convertingMs, readingMs, waitingMs } = event.detail;
    fps.textContent =
      `変換FPS: 瞬間 ${instantFps.toFixed(1)} · トータル ${totalFps.toFixed(1)}` +
      ` · 変換 ${convertingMs.toFixed(0)}ms / 読み込み ${readingMs.toFixed(0)}ms` +
      ` / MSE待ち ${waitingMs.toFixed(0)}ms`;
    counts = `${videoFrames} video frames`;
    if (audioFrames > 0) counts += ` · ${audioFrames} AAC frames`;
    setDetails();
  });
  // The counts that are not `filtered` are the filter working on frames whose
  // neighbours are not what it takes them for, which is what combing that
  // comes and goes looks like from here.
  created.addEventListener("deinterlace", (event) => {
    const { filtered, missed, dropped, degraded, discontinuities } =
      event.detail;
    const { fps: rate, frameMs } = event.detail;
    deinterlaceStats.textContent =
      `デインタレース: ${rate.toFixed(1)}fps · ${frameMs.toFixed(1)}ms/フレーム` +
      ` · 適用 ${filtered} · 取りこぼし ${missed} · 端 ${degraded}` +
      ` · 不連続 ${discontinuities} · デコーダー落ち ${dropped}`;
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
  duration = null;
  seek.disabled = true;
  seek.value = "0";
  fps.textContent = IDLE_FPS;
  deinterlaceStats.textContent = IDLE_DEINTERLACE;
  setDetails();
  setPlayhead();
  // Failures already arrive as an error event, which is what writes the
  // message; the rejection here is the same one and needs no second report.
  void createPlayer()
    .load(url)
    .catch(() => {});
}

/** Where the bar is pointing, in seconds. Only ever called with a duration. */
function scrubbedTime(): number {
  return (Number(seek.value) / SEEK_STEPS) * (duration ?? 0);
}

function setPlayhead() {
  const current = scrubbing ? scrubbedTime() : video.currentTime;
  time.textContent =
    duration === null
      ? formatDuration(current)
      : `${formatDuration(current)} / ${formatDuration(duration)}`;
  if (!scrubbing && duration)
    seek.value = String(Math.round((current / duration) * SEEK_STEPS));
}

playPause.addEventListener("click", () => {
  if (video.paused) void video.play().catch(() => {});
  else video.pause();
});
video.addEventListener("play", () => (playPause.textContent = "一時停止"));
video.addEventListener("pause", () => (playPause.textContent = "再生"));
video.addEventListener("loadeddata", () => (playPause.disabled = false));
video.addEventListener("emptied", () => (playPause.disabled = true));
video.addEventListener("timeupdate", setPlayhead);
video.addEventListener("seeked", setPlayhead);

// Dragging moves the label only. Seeking on every step of it would have the
// worker reading the input again from a place the viewer has already left.
seek.addEventListener("input", () => {
  scrubbing = true;
  setPlayhead();
});
seek.addEventListener("change", () => {
  scrubbing = false;
  if (duration !== null) video.currentTime = scrubbedTime();
});

// Both settings take effect where they stand, which is the point of them:
// the difference between a field at a time and a frame at a time is a thing
// to be seen on the same motion, not on two loads of it.
function applyDeinterlace() {
  if (!player) return;
  player.deinterlace = deinterlace.checked;
  if (player.deinterlacer) player.deinterlacer.doubleRate = doubleRate.checked;
}
deinterlace.addEventListener("change", applyDeinterlace);
doubleRate.addEventListener("change", applyDeinterlace);

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

if (!supportsDeinterlace()) {
  deinterlace.checked = false;
  deinterlace.disabled = true;
  doubleRate.checked = false;
  doubleRate.disabled = true;
  deinterlace.labels?.[0]?.append("（このブラウザーでは使えません）");
}

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
