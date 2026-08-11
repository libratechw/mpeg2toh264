/**
 * The demo page. Everything it does is call the library and write the result
 * into the DOM -- the player itself is in src/ and knows nothing about this.
 */
import {
  Mpeg2TsPlayer,
  requiresManagedMediaSource,
  supportsManagedMediaSource,
  supportsPassthrough,
  supportsWorkerMediaSource,
  type AudioTracks,
  type PlayerState,
} from "@mpeg2toh264/player";
import {
  Deinterlacer,
  probeDecoder,
  supportsDeinterlace,
  type DeinterlaceStats,
} from "@mpeg2toh264/yadif";
import { Controller, MPEGTSFeeder, SVGDOMRenderer } from "aribb24.js";

const video = document.querySelector<HTMLVideoElement>("#video")!;
const picture = document.querySelector<HTMLElement>("#picture")!;
const urlForm = document.querySelector<HTMLFormElement>("#url-form")!;
const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const mirakurunForm =
  document.querySelector<HTMLFormElement>("#mirakurun-form")!;
const mirakurunUrl =
  document.querySelector<HTMLInputElement>("#mirakurun-url")!;
const channelsStatus = document.querySelector<HTMLElement>("#channels-status")!;
const channels = document.querySelector<HTMLUListElement>("#channels")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const unload = document.querySelector<HTMLButtonElement>("#unload")!;
const placement = document.querySelector<HTMLSelectElement>("#placement")!;
const oversample = document.querySelector<HTMLInputElement>("#oversample")!;
const pictureWorkers =
  document.querySelector<HTMLInputElement>("#picture-workers")!;
const recoveryInterval =
  document.querySelector<HTMLInputElement>("#recovery-interval")!;
const playPause = document.querySelector<HTMLButtonElement>("#playpause")!;
const back = document.querySelector<HTMLButtonElement>("#back")!;
const forward = document.querySelector<HTMLButtonElement>("#forward")!;
const seek = document.querySelector<HTMLInputElement>("#seek")!;
const time = document.querySelector<HTMLElement>("#time")!;
const volume = document.querySelector<HTMLInputElement>("#volume")!;
const mute = document.querySelector<HTMLButtonElement>("#mute")!;
const rate = document.querySelector<HTMLSelectElement>("#rate")!;
const captionToggle =
  document.querySelector<HTMLButtonElement>("#caption-toggle")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const fullscreen = document.querySelector<HTMLButtonElement>("#fullscreen")!;
const service = document.querySelector<HTMLSelectElement>("#service")!;
const serviceLabel = document.querySelector<HTMLElement>("#service-label")!;
const audioSelect = document.querySelector<HTMLSelectElement>("#audio")!;
const audioSelectLabel = document.querySelector<HTMLElement>("#audio-label")!;
const passthrough = document.querySelector<HTMLInputElement>("#passthrough")!;
const deinterlace = document.querySelector<HTMLInputElement>("#deinterlace")!;
const doubleRate = document.querySelector<HTMLInputElement>("#double-rate")!;
const splitFieldSamples = document.querySelector<HTMLInputElement>(
  "#split-field-samples",
)!;
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
const DOUBLE_CLICK_DELAY_MS = 300;

const IDLE_FPS = "瞬間: - トータル: -";
const IDLE_DEINTERLACE = "-";
const IDLE_DETAILS = "-";

const STATES: Record<PlayerState, string> = {
  idle: "MPEG-2 TSのURLを指定するかファイルを選択してください",
  loading: "入力を読み込んでいます…",
  converting: "変換中…",
  "buffer-full": "MSEバッファが満杯です。再生が進むまで変換を停止しています…",
  seeking: "シーク先を読み込んでいます…",
  completed: "変換完了",
  error: "",
};

interface MirakurunService {
  id: number;
  serviceId: number;
  networkId: number;
  name: string;
}

interface MirakurunChannel {
  type: string;
  channel: string;
  name: string;
  services: MirakurunService[];
}

function mirakurunEndpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function channelPath(channel: MirakurunChannel): string {
  return `/api/channels/${encodeURIComponent(channel.type)}/${encodeURIComponent(channel.channel)}/stream`;
}

function servicePath(
  channel: MirakurunChannel,
  service: MirakurunService,
): string {
  return `/api/channels/${encodeURIComponent(channel.type)}/${encodeURIComponent(channel.channel)}/services/${encodeURIComponent(service.id)}/stream`;
}

function streamButton(
  text: string,
  base: string,
  path: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", () => {
    const url = mirakurunEndpoint(base, path);
    urlInput.value = url;
    forgetService();
    play(url, text, null, true);
  });
  return button;
}

function showMirakurunChannels(
  available: MirakurunChannel[],
  base: string,
): void {
  channels.replaceChildren(
    ...available.map((channel) => {
      const item = document.createElement("li");
      item.append(
        streamButton(
          `${channel.name} (${channel.type} ${channel.channel})`,
          base,
          channelPath(channel),
        ),
      );
      if (channel.services.length > 0) {
        const services = document.createElement("ul");
        services.append(
          ...channel.services.map((service) => {
            const serviceItem = document.createElement("li");
            serviceItem.append(
              streamButton(
                `${service.name} (service ${service.serviceId})`,
                base,
                servicePath(channel, service),
              ),
            );
            return serviceItem;
          }),
        );
        item.append(services);
      }
      return item;
    }),
  );
}

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
let yadif: Deinterlacer | null = null;
let captions: {
  setCaptionEnabled(enabled: boolean): void;
  destroy(): void;
} | null = null;
let captionsEnabled = true;
/** The blob URL for a picked file, revoked when the next source replaces it. */
let fileUrl: string | null = null;
let label = "";
let progress = "";
let counts = "";
let length = "";
let scan = "";
/** How many workers the conversion ended up spread over, once it says. */
let workers = "";
/** How long the input is, once it turns out to be one that can be seeked. */
let duration: number | null = null;
/** Whether the bar is being dragged, which owns the position until let go. */
let scrubbing = false;

function setStatus(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function setDetails() {
  details.textContent =
    [label, length, scan, workers, progress, counts]
      .filter(Boolean)
      .join(" ") || IDLE_DETAILS;
}

function updateScan(): void {
  const fields = yadif?.scan;
  const next = fields
    ? fields.interlaced
      ? `インターレース (${fields.topFieldFirst ? "TFF" : "BFF"})`
      : "プログレッシブ"
    : "";
  if (next === scan) return;
  scan = next;
  setDetails();
}

/** Whether MPEG-2 can reach the decoder at all, which is for the browser to say. */
const canPassthrough = supportsPassthrough();

/** Whether the managed source is the only one here, as it is on an iPhone. */
const onlyManaged = requiresManagedMediaSource();

/**
 * What each entry of the placement list asks the player for.
 *
 * The two are separate options -- which of the implementations, and which side
 * of the wire runs it -- and this is the pairs worth offering. `auto` names
 * neither and lets the player look at the browser, which is what an iPhone
 * needs: there the managed one is all there is and asking for it is beside the
 * point.
 */
const PLACEMENTS: Record<
  string,
  { mediaSource: "auto" | "worker" | "main"; managed: boolean }
> = {
  auto: { mediaSource: "auto", managed: false },
  worker: { mediaSource: "worker", managed: false },
  main: { mediaSource: "main", managed: false },
  "managed-worker": { mediaSource: "worker", managed: true },
  "managed-main": { mediaSource: "main", managed: true },
};

/**
 * The settings the conversion reads once, as it starts, and never looks at
 * again. Offering them over a player that has already passed that point would
 * be offering a change that does not happen, so they wait for the next load --
 * which is what the unload button is for.
 */
const LOAD_TIME_ONLY = [
  placement,
  oversample,
  pictureWorkers,
  recoveryInterval,
  splitFieldSamples,
  passthrough,
];

function syncSettings() {
  const loaded = player !== null;
  for (const setting of LOAD_TIME_ONLY) setting.disabled = loaded;
  if (!canPassthrough) passthrough.disabled = true;
  unload.disabled = !loaded;
}

/**
 * A player is bound to one MediaSource placement, so switching where MSE runs
 * means building a new one. Each source gets a fresh player for that reason.
 */
function createPlayer(): Mpeg2TsPlayer {
  captions?.destroy();
  captions = null;
  player?.destroy();
  yadif = null;
  const chosen = PLACEMENTS[placement.value] ?? PLACEMENTS["auto"]!;
  const created = new Mpeg2TsPlayer(video, {
    mediaSource: chosen.mediaSource,
    preferManagedMediaSource: chosen.managed,
    oversample: Number(oversample.value),
    // Blank leaves it to the player, which sizes it from the machine.
    pictureWorkers: pictureWorkers.value
      ? Number(pictureWorkers.value)
      : undefined,
    recoveryInterval: Number(recoveryInterval.value),
    splitFieldSamples: splitFieldSamples.checked,
    serviceId: wantedService ?? undefined,
    passthrough: passthrough.checked,
    deinterlace: deinterlace.checked,
    deinterlacer: (element) => {
      yadif = new Deinterlacer(element, {
        doubleRate: doubleRate.checked,
        onStats: showDeinterlaceStats,
      });
      return yadif;
    },
  });
  captions = createCaptionOverlay(created);
  captions.setCaptionEnabled(captionsEnabled);
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
  // A recording of one programme announces one service and the control stays
  // out of the way. One that carries a broadcaster's sub-channel as well is
  // offering a choice nothing but a viewer can make, so it goes on the page.
  created.addEventListener("workers", (event) => {
    const count = event.detail.pictureWorkers;
    // Zero means this browser would not have a pool, and the pictures are
    // being converted in the one worker that runs the conversion.
    workers = count > 0 ? `変換ワーカー ${count}` : "変換ワーカーなし";
    setDetails();
  });

  created.addEventListener("services", (event) => {
    const { available, current } = event.detail;
    if (available.length < 2) {
      service.hidden = true;
      serviceLabel.hidden = true;
      return;
    }
    const wanted = String(wantedService ?? current ?? available[0]);
    service.replaceChildren(
      ...available.map((id) => {
        const option = document.createElement("option");
        option.value = String(id);
        option.textContent = String(id);
        option.selected = String(id) === wanted;
        return option;
      }),
    );
    service.hidden = false;
    serviceLabel.hidden = false;
  });
  // What sound the programme is carrying. Unlike the service, this is a choice
  // a viewer makes while watching: it changes what is converted from here on,
  // and the fragments already in the buffer keep the sound they were made with.
  created.addEventListener("audio", (event) => {
    showAudioChoices(event.detail);
  });
  created.addEventListener("seekable", (event) => {
    duration = event.detail.duration;
    length = `${formatDuration(duration)} (シーク可能)`;
    setDetails();
    setPlayhead();
  });
  created.addEventListener("stats", (event) => {
    const {
      instantFps,
      totalFps,
      videoFrames,
      audioFrames,
      dropped,
      scrambled,
      errors,
    } = event.detail;
    const { convertingMs, readingMs, waitingMs } = event.detail;
    fps.textContent =
      `瞬間: ${instantFps.toFixed(1)} トータル: ${totalFps.toFixed(1)}` +
      ` 変換: ${convertingMs.toFixed(0)}ms 読み込み: ${readingMs.toFixed(0)}ms` +
      ` MSE待ち: ${waitingMs.toFixed(0)}ms`;
    fps.textContent += ` drop: ${dropped} scrambled: ${scrambled} error: ${errors}`;
    counts = `${videoFrames} video frames`;
    if (audioFrames > 0) counts += ` ${audioFrames} AAC frames`;
    setDetails();
  });
  created.addEventListener("error", (event) =>
    setStatus(event.detail.error.message, true),
  );
  player = created;
  syncControls();
  syncSettings();
  return created;
}

/** Render ARIB captions and character superimpose as SVG over the picture. */
function createCaptionOverlay(created: Mpeg2TsPlayer): {
  setCaptionEnabled(enabled: boolean): void;
  destroy(): void;
} {
  const entries = (["Caption", "Superimpose"] as const).map((type) => {
    const feeder = new MPEGTSFeeder({
      recieve: { type },
      tokenizer: {},
      offset: {},
    });
    const renderer = new SVGDOMRenderer();
    const controller = new Controller();
    controller.attachFeeder(feeder);
    controller.attachRenderer(renderer);
    controller.attachMedia(video, picture);
    const overlay = picture.lastElementChild as SVGSVGElement;
    overlay.setAttribute("preserveAspectRatio", "none");
    return { type, controller, feeder, renderer, overlay };
  });

  const feed = (
    event: CustomEvent<import("@mpeg2toh264/player").PrivateStream>,
  ): void => {
    const { data, pts } = event.detail;
    if (pts === null) return;
    for (const { feeder } of entries) feeder.feedB24(data, pts);
  };
  created.addEventListener("private_stream_1", feed);
  created.addEventListener("private_stream_2", feed);

  return {
    setCaptionEnabled(enabled: boolean): void {
      for (const { type, controller, overlay } of entries) {
        if (type !== "Caption") continue;
        if (enabled) {
          overlay.style.removeProperty("display");
          controller.show();
        } else {
          controller.hide();
          overlay.style.display = "none";
        }
      }
    },
    destroy(): void {
      created.removeEventListener("private_stream_1", feed);
      created.removeEventListener("private_stream_2", feed);
      for (const { controller, feeder, renderer } of entries) {
        controller.detachMedia();
        controller.detachFeeder();
        controller.detachRenderer(renderer);
        feeder.destroy();
        renderer.destroy();
      }
    },
  };
}

function showDeinterlaceStats(stats: DeinterlaceStats): void {
  const { filtered, missed, dropped, degraded, discontinuities, late } = stats;
  const { fps: presentedFps, frameMs } = stats;
  deinterlaceStats.textContent =
    `${presentedFps.toFixed(1)} FPS ${frameMs.toFixed(1)} ms/フレーム` +
    ` 適用: ${filtered} 取りこぼし: ${missed} 端: ${degraded}` +
    ` 未表示: ${late}` +
    ` 不連続: ${discontinuities} ドロップ: ${dropped}`;
}

/** The service a viewer picked, which only a fresh load can act on. */
let wantedService: number | null = null;

/**
 * The sound a viewer picked, as the value of the option they picked it with.
 *
 * A switch lands on the next slice of input rather than at once, so for a
 * moment the player still reports the sound being left. Without remembering
 * what was asked for, the redraw that report causes would put the control back
 * on the old choice in front of the viewer.
 */
let wantedAudio: string | null = null;

/** Language codes in the words a viewer would use, and the code otherwise. */
const LANGUAGE_NAMES: Record<string, string> = {
  jpn: "日本語",
  eng: "英語",
  kor: "韓国語",
  zho: "中国語",
  spa: "スペイン語",
  fra: "フランス語",
  deu: "ドイツ語",
  por: "ポルトガル語",
  rus: "ロシア語",
  ita: "イタリア語",
};

/**
 * The sounds a viewer can choose between, which is not the same as the streams
 * on offer: a dual-mono stream is two of them, carried as the two channels of
 * one stream, and a bilingual broadcast is sent either way.
 *
 * Each option is named by the language its descriptors give it, falling back on
 * what a receiver would call it when the broadcast names none.
 */
function audioChoices(audio: AudioTracks): { value: string; text: string }[] {
  const several = audio.available.length > 1;
  const choices: { value: string; text: string }[] = [];
  audio.available.forEach((stream, index) => {
    // The program map does not always say a stream is dual mono. The frames of
    // the one being read do, and that is the one a viewer is listening to.
    const dualMono =
      stream.dualMono || (stream.pid === audio.current && audio.dualMono);
    const language = (at: number, fallback: string): string => {
      const code = stream.languages[at];
      return code ? (LANGUAGE_NAMES[code] ?? code) : fallback;
    };
    const named = (text: string): string =>
      several ? `音声${index + 1} ${text}` : text;
    if (!dualMono) {
      choices.push({
        value: String(stream.pid),
        text: named(language(0, "")).trim() || "音声",
      });
      return;
    }
    choices.push({
      value: String(stream.pid),
      text: named(language(0, "主音声")),
    });
    choices.push({
      value: `${stream.pid}:sub`,
      text: named(language(1, "副音声")),
    });
  });
  return choices;
}

/**
 * Offer the choice, or put it away where there is only one thing to hear.
 */
function showAudioChoices(audio: AudioTracks): void {
  const choices = audioChoices(audio);
  if (choices.length < 2) {
    forgetAudio();
    return;
  }
  // A choice the programme no longer offers is not one to keep showing: a
  // programme boundary can take the stream it named away with it, and a
  // broadcast can stop sending two services in one stream partway through.
  if (wantedAudio !== null && !choices.some((c) => c.value === wantedAudio))
    wantedAudio = null;
  const offered = (value: string): boolean =>
    choices.some((choice) => choice.value === value);
  const sub = `${audio.current}:sub`;
  // The second service of a stream that has stopped carrying one is not
  // something to show as playing: the sound is the stream itself now. Naming
  // it anyway would match no entry, and the control would fall back to
  // whichever comes first -- which is not even the same stream.
  const playing =
    audio.dualMonoSub && offered(sub) ? sub : String(audio.current);
  const selected = wantedAudio ?? playing;
  audioSelect.replaceChildren(
    ...choices.map(({ value, text }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = value === selected;
      return option;
    }),
  );
  audioSelect.hidden = false;
  audioSelectLabel.hidden = false;
}

/** Put the sound picker away, for a load that has not said what it carries. */
function forgetAudio(): void {
  wantedAudio = null;
  audioSelect.hidden = true;
  audioSelectLabel.hidden = true;
  audioSelect.replaceChildren();
}

// The sound is chosen at the head of the conversion rather than at the
// playhead, so the change is heard once playback reaches what is being
// converted now -- moments on a live stream, and as far ahead as the buffer has
// run on a recording.
audioSelect.addEventListener("change", () => {
  const value = audioSelect.value;
  const [pid, service] = value.split(":");
  const chosen = Number(pid);
  if (!Number.isFinite(chosen)) return;
  wantedAudio = value;
  player?.selectAudio(chosen);
  player?.selectDualMono(service === "sub");
});
/** What was last played, so switching service can start it again. */
let playing: { url: string; label: string } | null = null;

function play(
  url: string,
  sourceLabel: string,
  ownedUrl: string | null = null,
  autoplay = false,
) {
  playing = { url, label: sourceLabel };
  // What the last input carried says nothing about this one, and a choice made
  // on it names a stream that may not be there.
  forgetAudio();
  if (fileUrl && fileUrl !== ownedUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = ownedUrl;
  label = sourceLabel;
  progress = "";
  counts = "";
  length = "";
  scan = "";
  workers = "";
  duration = null;
  seek.value = "0";
  fps.textContent = IDLE_FPS;
  deinterlaceStats.textContent = IDLE_DEINTERLACE;
  setDetails();
  setPlayhead();
  syncPlayPause();
  // Failures already arrive as an error event, which is what writes the
  // message; the rejection here is the same one and needs no second report.
  const loading = createPlayer().load(url);
  if (autoplay) void loading.then(() => video.play()).catch(() => {});
  else void loading.catch(() => {});
}

/**
 * Give up the input and everything read from it, and stand as the page did
 * before the first load: the settings that only a load can act on come back,
 * and the picked file is let go of rather than held for a reload that is no
 * longer coming.
 */
function unloadSource() {
  captions?.destroy();
  captions = null;
  player?.destroy();
  player = null;
  yadif = null;
  playing = null;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = null;
  // A file picker that still names the unloaded file would not fire `change`
  // on picking it again, so choosing it a second time would do nothing.
  fileInput.value = "";
  forgetService();
  forgetAudio();
  label = "";
  progress = "";
  counts = "";
  length = "";
  scan = "";
  workers = "";
  duration = null;
  scrubbing = false;
  seek.value = "0";
  fps.textContent = IDLE_FPS;
  deinterlaceStats.textContent = IDLE_DEINTERLACE;
  setDetails();
  setPlayhead();
  syncPlayPause();
  syncControls();
  syncSettings();
  setStatus(STATES.idle);
}

unload.addEventListener("click", unloadSource);

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
  updateScan();
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
    return;
  }
  if (!scrubbing)
    seek.value = String(Math.round((current / total) * SEEK_STEPS));
}

function syncPictureAspect(): void {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    const aspect = video.videoWidth / video.videoHeight;
    picture.style.setProperty("--picture-aspect", String(aspect));
    picture.style.setProperty("--picture-width", `${aspect * 100}vh`);
  }
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

/**
 * Say what pressing the button will do, and whether it can be pressed at all.
 *
 * Read from the element rather than set by whichever event last arrived. Media
 * element events are queued rather than delivered on the spot, so tearing one
 * load down and starting another -- which is what changing the service does --
 * leaves the two loads' events interleaved: a stale `emptied` arriving after
 * the new load's `loadeddata` would otherwise disable the button over a
 * playing video, and a stale `pause` would have it offering to play what is
 * already playing.
 */
function syncPlayPause() {
  const action = video.paused ? "再生" : "一時停止";
  playPause.textContent = video.paused ? "▶" : "⏸";
  playPause.ariaLabel = action;
  playPause.title = action;
  playPause.disabled = video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
}

playPause.addEventListener("click", togglePlay);
let stageClickTimer: number | null = null;
stage.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("#playback"))
    return;
  if (!player?.deinterlace && document.fullscreenElement !== stage) return;
  if (event.detail > 1) {
    if (stageClickTimer !== null) window.clearTimeout(stageClickTimer);
    stageClickTimer = null;
    return;
  }
  stageClickTimer = window.setTimeout(() => {
    stageClickTimer = null;
    togglePlay();
  }, DOUBLE_CLICK_DELAY_MS);
});
stage.addEventListener("dblclick", (event) => {
  if (event.target instanceof Element && event.target.closest("#playback"))
    return;
  if (stageClickTimer !== null) window.clearTimeout(stageClickTimer);
  stageClickTimer = null;
  event.preventDefault();
  toggleFullscreen();
});
back.addEventListener("click", () => skip(-SKIP_SECONDS));
forward.addEventListener("click", () => skip(SKIP_SECONDS));
for (const name of [
  "play",
  "pause",
  "loadstart",
  "loadeddata",
  "canplay",
  "emptied",
  "ended",
]) {
  video.addEventListener(name, syncPlayPause);
}
video.addEventListener("emptied", setPlayhead);
video.addEventListener("timeupdate", setPlayhead);
video.addEventListener("seeked", setPlayhead);
video.addEventListener("durationchange", setPlayhead);
video.addEventListener("resize", syncPictureAspect);
// A growing buffer can make a stream seekable before its duration is known.
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

captionToggle.addEventListener("click", () => {
  captionsEnabled = !captionsEnabled;
  captions?.setCaptionEnabled(captionsEnabled);
  captionToggle.textContent = captionsEnabled ? "字幕を隠す" : "字幕を表示";
  captionToggle.ariaPressed = String(captionsEnabled);
});

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

fullscreen.addEventListener("click", (event) => {
  toggleFullscreen();
  // Pointer clicks leave focus on the button and would keep the fullscreen
  // controls visible through :focus-within. Keyboard activation keeps focus
  // so the controls remain operable without a pointer.
  if (event.detail > 0) fullscreen.blur();
});
document.addEventListener("fullscreenchange", () => {
  fullscreen.textContent = document.fullscreenElement
    ? "全画面を解除"
    : "全画面";
  syncControls();
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
  if (yadif) yadif.doubleRate = doubleRate.checked;
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
  video.controls =
    document.fullscreenElement !== stage &&
    !(player?.deinterlaceWanted && player.deinterlacer);
}
/**
 * Put the service picker away and stop asking for what was picked.
 *
 * A choice belongs to the recording it was made on: carried to another one it
 * names a service that may not be there, and the conversion would wait for a
 * program map that never comes.
 */
function forgetService(): void {
  wantedService = null;
  service.hidden = true;
  serviceLabel.hidden = true;
  service.replaceChildren();
}

// A service is chosen at the head of the conversion, so changing it means
// converting the input again from the beginning.
service.addEventListener("change", () => {
  const chosen = Number(service.value);
  if (!Number.isFinite(chosen) || chosen === wantedService) return;
  wantedService = chosen;
  if (playing) play(playing.url, playing.label, fileUrl, true);
});

deinterlace.addEventListener("change", applyDeinterlace);
doubleRate.addEventListener("change", applyDeinterlace);

if (!canPassthrough) {
  passthrough.checked = false;
  passthrough.labels?.[0]?.append(" (このブラウザーはMPEG-2を再生できません)");
}

mirakurunForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const base = mirakurunUrl.value.trim();
  if (!base) return;

  const submit = mirakurunForm.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  submit.disabled = true;
  channelsStatus.textContent = "チャンネル一覧を取得しています…";
  channels.replaceChildren();
  try {
    const response = await fetch(mirakurunEndpoint(base, "/api/channels"));
    if (!response.ok)
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    const available = (await response.json()) as MirakurunChannel[];
    if (!Array.isArray(available))
      throw new Error("チャンネル一覧の形式が正しくありません");
    showMirakurunChannels(available, base);
    channelsStatus.textContent = `${available.length}チャンネルを取得しました`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    channelsStatus.textContent = `チャンネル一覧を取得できませんでした: ${message}`;
  } finally {
    submit.disabled = false;
  }
});

urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (url) {
    forgetService();
    play(url, url, null, true);
  }
});

// The library takes a URL, so a picked file becomes one. The worker fetches
// blob URLs the same as any other, and the bytes never leave the page.
fileInput.addEventListener("change", () => {
  const selected = fileInput.files?.[0];
  if (!selected) return;
  const url = URL.createObjectURL(selected);
  forgetService();
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
  probe.textContent = "判定せず (このブラウザーではデインタレースできません)";
  disableDeinterlace(" (このブラウザーでは使えません)");
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
    const detail = ` (${left} ${tookMs.toFixed(0)}ms)`;
    if (error) {
      probe.textContent = `判定できず: ${error}${detail} yadifは無効のまま`;
    } else if (deinterlaces) {
      probe.textContent = `デコーダーが自動でデインタレース${detail} yadifは無効`;
      disableDeinterlace(" (デコーダーが自動でデインタレースします)");
    } else {
      probe.textContent = `自動デインタレースなし${detail} 必要ならyadifを有効にできます`;
    }
  });
}

// Which pairs this browser can actually run. Chromium has MSE in Workers and
// no managed source; Safari has the managed one and no MSE in Workers; an
// iPhone has nothing but the managed one. So most of the list is greyed out
// wherever it is read, and which parts tells you where you are.
{
  const option = (value: string) =>
    placement.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!;
  const hasManaged = supportsManagedMediaSource();
  option("worker").disabled = !supportsWorkerMediaSource();
  option("main").disabled = onlyManaged;
  option("managed-worker").disabled =
    !hasManaged || !supportsWorkerMediaSource(true);
  option("managed-main").disabled = !hasManaged;
  // 自動 is the browser's own answer, so it says what the answer turned out
  // to be rather than leaving it to be guessed at.
  const auto = option("auto");
  const implementation = onlyManaged ? "ManagedMediaSource" : "MediaSource";
  const side = supportsWorkerMediaSource(onlyManaged) ? "Worker" : "メイン";
  auto.textContent = `${auto.textContent} (このブラウザーでは${implementation} (${side}))`;
}

syncSettings();
setStatus(STATES.idle);
