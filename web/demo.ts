/**
 * The demo page. Everything it does is call the library and write the result
 * into the DOM -- the player itself is in src/ and knows nothing about this.
 */
import {
  Mpeg2TsPlayer,
  probeDecoder,
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
const back = document.querySelector<HTMLButtonElement>("#back")!;
const forward = document.querySelector<HTMLButtonElement>("#forward")!;
const seek = document.querySelector<HTMLInputElement>("#seek")!;
const bufferedBar = document.querySelector<HTMLProgressElement>("#buffered")!;
const time = document.querySelector<HTMLElement>("#time")!;
const volume = document.querySelector<HTMLInputElement>("#volume")!;
const mute = document.querySelector<HTMLButtonElement>("#mute")!;
const rate = document.querySelector<HTMLSelectElement>("#rate")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const fullscreen = document.querySelector<HTMLButtonElement>("#fullscreen")!;
const deinterlace = document.querySelector<HTMLInputElement>("#deinterlace")!;
const doubleRate = document.querySelector<HTMLInputElement>("#double-rate")!;
const status = document.querySelector<HTMLElement>("#status")!;
const details = document.querySelector<HTMLElement>("#details")!;
const fps = document.querySelector<HTMLElement>("#fps")!;
const deinterlaceStats =
  document.querySelector<HTMLElement>("#deinterlace-stats")!;
const probe = document.querySelector<HTMLElement>("#probe")!;

/** How many steps the seek bar divides the video into. */
const SEEK_STEPS = 1000;

/** What the arrow keys and the buttons move by, in seconds. */
const ARROW_SECONDS = 5;
const SKIP_SECONDS = 10;

const IDLE_FPS = "瞬間 — · トータル —";
const IDLE_DEINTERLACE = "—";

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
let scan = "";
/** How long the input is, once it turns out to be one that can be seeked. */
let duration: number | null = null;
/** Whether the bar is being dragged, which owns the position until let go. */
let scrubbing = false;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function setDetails() {
  details.textContent = [label, length, scan, progress, counts]
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
  // What the MPEG-2 headers said about the fields. The player has already
  // pointed the filter at the right ones by the time this arrives; showing it
  // is how a viewer can tell a stream that is worth filtering from one that
  // is not.
  created.addEventListener("scan", (event) => {
    const { interlaced, topFieldFirst } = event.detail;
    scan = interlaced
      ? `インターレース（${topFieldFirst ? "TFF" : "BFF"}）`
      : "プログレッシブ";
    setDetails();
  });
  created.addEventListener("seekable", (event) => {
    duration = event.detail.duration;
    length = `${formatDuration(duration)}（シーク可能）`;
    setDetails();
    setPlayhead();
  });
  created.addEventListener("stats", (event) => {
    const { instantFps, totalFps, videoFrames, audioFrames } = event.detail;
    const { convertingMs, readingMs, waitingMs } = event.detail;
    fps.textContent =
      `瞬間 ${instantFps.toFixed(1)} · トータル ${totalFps.toFixed(1)}` +
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
    const { fps: presentedFps, frameMs } = event.detail;
    deinterlaceStats.textContent =
      `${presentedFps.toFixed(1)}fps · ${frameMs.toFixed(1)}ms/フレーム` +
      ` · 適用 ${filtered} · 取りこぼし ${missed} · 端 ${degraded}` +
      ` · 不連続 ${discontinuities} · デコーダー落ち ${dropped}`;
  });
  created.addEventListener("error", (event) =>
    setStatus(event.detail.error.message, true),
  );
  player = created;
  syncControls();
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
  scan = "";
  duration = null;
  seek.value = "0";
  bufferedBar.value = 0;
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

/** How far playback can be moved: the whole input, or as much as there is. */
function reach(): number {
  if (duration !== null) return duration;
  const ranges = video.buffered;
  return ranges.length ? ranges.end(ranges.length - 1) : 0;
}

/** Where the bar is pointing, in seconds. */
function scrubbedTime(): number {
  return (Number(seek.value) / SEEK_STEPS) * reach();
}

function setPlayhead() {
  const total = reach();
  const current = scrubbing ? scrubbedTime() : video.currentTime;
  // An input whose length is not known -- a live stream, a server that will
  // not serve ranges -- has nothing to count down from, so the clock says
  // only where playback is and the bar covers what has been converted.
  time.textContent =
    duration === null
      ? formatDuration(current)
      : `${formatDuration(current)} / ${formatDuration(duration)}`;
  const movable = total > 0 && Number.isFinite(total);
  seek.disabled = !movable;
  back.disabled = !movable;
  forward.disabled = !movable;
  if (!movable) {
    seek.value = "0";
    bufferedBar.value = 0;
    return;
  }
  if (!scrubbing)
    seek.value = String(Math.round((current / total) * SEEK_STEPS));
  const ranges = video.buffered;
  const buffered = ranges.length ? ranges.end(ranges.length - 1) : 0;
  bufferedBar.value = Math.min(
    SEEK_STEPS,
    Math.round((buffered / total) * SEEK_STEPS),
  );
}

function togglePlay() {
  if (video.paused) void video.play().catch(() => {});
  else video.pause();
}

/** Move by a few seconds, without leaving what there is to play. */
function skip(seconds: number) {
  const total = reach();
  if (total <= 0) return;
  video.currentTime = Math.min(total, Math.max(0, video.currentTime + seconds));
}

function setVolume(level: number) {
  video.volume = Math.min(1, Math.max(0, level));
  video.muted = false;
}

playPause.addEventListener("click", togglePlay);
back.addEventListener("click", () => skip(-SKIP_SECONDS));
forward.addEventListener("click", () => skip(SKIP_SECONDS));
video.addEventListener("play", () => (playPause.textContent = "一時停止"));
video.addEventListener("pause", () => (playPause.textContent = "再生"));
video.addEventListener("loadeddata", () => (playPause.disabled = false));
video.addEventListener("emptied", () => {
  playPause.disabled = true;
  setPlayhead();
});
video.addEventListener("timeupdate", setPlayhead);
video.addEventListener("seeked", setPlayhead);
video.addEventListener("durationchange", setPlayhead);
// What has been converted keeps growing behind the playhead, and this is the
// event that says so.
video.addEventListener("progress", setPlayhead);

// Dragging moves the clock only. Seeking on every step of it would have the
// worker reading the input again from a place the viewer has already left.
seek.addEventListener("input", () => {
  scrubbing = true;
  setPlayhead();
});
seek.addEventListener("change", () => {
  scrubbing = false;
  if (reach() > 0) video.currentTime = scrubbedTime();
});

volume.addEventListener("input", () => setVolume(Number(volume.value) / 100));
mute.addEventListener("click", () => (video.muted = !video.muted));
video.addEventListener("volumechange", () => {
  volume.value = String(Math.round(video.volume * 100));
  mute.textContent = video.muted ? "消音を解除" : "消音";
});
rate.addEventListener(
  "change",
  () => (video.playbackRate = Number(rate.value)),
);

/**
 * The whole stage goes on the screen, controls and all. The element on its own
 * would be the wrong thing twice over: the deinterlaced picture is on a canvas
 * beside it, and everything that drives playback is under it.
 */
function toggleFullscreen() {
  if (document.fullscreenElement)
    void document.exitFullscreen().catch(() => {});
  else void stage.requestFullscreen().catch(() => {});
}

fullscreen.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  fullscreen.textContent = document.fullscreenElement
    ? "全画面を解除"
    : "全画面";
});

// The page's keys, not a control's: a focused button already takes the space
// bar as a click, and a text field takes every key there is.
document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (
    target &&
    ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)
  )
    return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  switch (event.key) {
    case " ":
    case "k":
      togglePlay();
      break;
    case "ArrowLeft":
      skip(-ARROW_SECONDS);
      break;
    case "ArrowRight":
      skip(ARROW_SECONDS);
      break;
    case "j":
      skip(-SKIP_SECONDS);
      break;
    case "l":
      skip(SKIP_SECONDS);
      break;
    case "ArrowUp":
      setVolume(video.volume + 0.1);
      break;
    case "ArrowDown":
      setVolume(video.volume - 0.1);
      break;
    case "m":
      video.muted = !video.muted;
      break;
    case "f":
      toggleFullscreen();
      break;
    default:
      return;
  }
  event.preventDefault();
});

// Both settings take effect where they stand, which is the point of them:
// the difference between a field at a time and a frame at a time is a thing
// to be seen on the same motion, not on two loads of it.
function applyDeinterlace() {
  if (!player) return;
  player.deinterlace = deinterlace.checked;
  if (player.deinterlacer) player.deinterlacer.doubleRate = doubleRate.checked;
  syncControls();
}

/**
 * The element's own controls, for as long as they can be seen and used. A
 * running deinterlacer covers them with its canvas -- and on the screen the
 * browser draws them over the top of it instead, which is worse -- so they go
 * while it runs. Whether it is running is the thing to ask: a browser that
 * cannot run it keeps them, which is the fallback that matters.
 */
function syncControls() {
  video.controls = !(player?.deinterlace ?? false);
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

function disableDeinterlace(reason: string) {
  deinterlace.checked = false;
  deinterlace.disabled = true;
  doubleRate.checked = false;
  doubleRate.disabled = true;
  deinterlace.labels?.[0]?.append(reason);
  if (player) applyDeinterlace();
}

if (!supportsDeinterlace()) {
  probe.textContent = "判定せず（このブラウザーではデインタレースできません）";
  disableDeinterlace("（このブラウザーでは使えません）");
} else {
  // Ask the machine before offering to do what it may already be doing. Some
  // hardware decoders -- Android's especially -- hand back frames that have
  // been deinterlaced for us, and filtering those again only softens them.
  // The measurement goes on the page whichever way it comes out: it is the
  // only sign of what was decided, and on a device nobody can attach a
  // debugger to it is the only way to see why.
  void probeDecoder().then(({ deinterlaces, survives, tookMs, error }) => {
    const left =
      survives === null ? "測定不能" : `残存率 ${survives.toFixed(2)}`;
    const detail = `（${left} · ${tookMs.toFixed(0)}ms）`;
    if (error) {
      probe.textContent = `判定できず: ${error}${detail} — yadifは有効のまま`;
    } else if (deinterlaces) {
      probe.textContent = `デコーダーが自動でデインタレース${detail} — yadifは無効`;
      disableDeinterlace("（デコーダーが自動でデインタレースします）");
    } else {
      probe.textContent = `自動デインタレースなし${detail} — yadifを使います`;
    }
  });
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
