const b = 33554432;
const M = 8, w = 10;
const o = globalThis.ManagedMediaSource;
function l(n = !1) {
  const e = typeof MediaSource > "u" ? null : MediaSource;
  return n && o ? o : e ?? o ?? null;
}
function m(n, e = !1) {
  return l(e)?.isTypeSupported(n) ?? !1;
}
function S(n = !1) {
  return l(n)?.canConstructInDedicatedWorker === !0;
}
function A() {
  return o !== void 0;
}
function _() {
  return typeof MediaSource > "u" && o !== void 0;
}
class g {
  #t = !0;
  #s = [];
  get open() {
    return this.#t;
  }
  /** Returns whether this changed anything. */
  set(e) {
    return e === this.#t ? !1 : (this.#t = e, e && this.#i(), !0);
  }
  wait() {
    return this.#t ? Promise.resolve() : new Promise((e) => {
      this.#s.push(e);
    });
  }
  /** Let everyone through whatever the state is, for teardown. */
  abandon() {
    this.#i();
  }
  #i() {
    const e = this.#s;
    this.#s = [];
    for (const t of e) t();
  }
}
class v {
  /**
   * Made in the constructor rather than in `open`, because a caller needs
   * something to attach before the codec is known: the worker sends
   * `mediaSource.handle` across the moment a load starts, and `sourceopen`
   * does not fire until the page has put it on the element -- long before the
   * first init fragment.
   */
  mediaSource;
  /**
   * Whether that is a Managed Media Source, which a media element takes in its
   * own way. See the player's `#createSink`.
   */
  managed;
  /** The one the source was made from, and the one that answers for codecs. */
  #t;
  #s;
  #i;
  #e = null;
  /** What the `SourceBuffer` was opened with, or last changed to. */
  #f = "";
  /** A codec to move the `SourceBuffer` to before the next append. */
  #d = null;
  #r = [];
  #p = 0;
  #n = null;
  #u = !1;
  /**
   * Whether a managed source wants data at the moment.
   *
   * True until told otherwise, and always true for an unmanaged source, which
   * takes whatever it is given. A managed one starts out not streaming and
   * asks once it is attached and playing, so waiting for permission before the
   * initialization segment would mean waiting for a player that never starts:
   * this holds the door open until `endstreaming` closes it.
   */
  #y = !0;
  /** The last thing said about there being no room, so it is said once. */
  #g = !1;
  /** Whether everything buffered is waiting to be thrown away; see `reset`. */
  #h = !1;
  /** Which stretch of timeline is being filled. Bumped by every `reset`. */
  #v = 0;
  /** A duration to put on the MediaSource as soon as it will take one. */
  #b = null;
  /** Media times a decoder can start from, in order; see #evict. */
  #c = [];
  /** Whether the playhead has been put where the media starts; see #startAtMedia. */
  #o = !1;
  #M = 0;
  #a = !1;
  #L = !1;
  #H = 0;
  #N = 0;
  #R = null;
  #w = null;
  #U = new g();
  #P = [];
  constructor(e) {
    this.#s = e;
    const t = l(e.preferManaged);
    if (!t) throw new Error("this browser has no Media Source Extensions");
    this.#t = t, this.mediaSource = new t(), this.managed = t === o, this.mediaSource.addEventListener("sourceopen", this.#C), this.mediaSource.addEventListener("sourceclose", this.#j), this.managed && (this.mediaSource.addEventListener(
      "startstreaming",
      this.#B
    ), this.mediaSource.addEventListener("endstreaming", this.#F)), this.#i = new Promise((s) => {
      this.mediaSource.addEventListener(
        "sourceopen",
        () => {
          e.onMark?.("sourceopen"), s();
        },
        { once: !0 }
      );
    });
  }
  ready() {
    return this.#U.wait();
  }
  /**
   * Open the stream, or -- for the initialization segment a seek brings with
   * it -- re-open the one already running.
   */
  async open(e, t) {
    if (!this.#t.isTypeSupported(e))
      throw new Error(`unsupported codec: ${e}`);
    if (await this.#i, !this.#a) {
      if (this.#e)
        e !== this.#f && (this.#d = e);
      else try {
        const s = this.mediaSource.addSourceBuffer(e);
        s.mode = "segments", s.addEventListener("updateend", this.#x), s.addEventListener("error", this.#O), this.#e = s, this.#f = e;
      } catch (s) {
        throw this.#S("add or configure SourceBuffer", s);
      }
      this.#W({ data: t, init: !0 }), this.#I();
    }
  }
  push(e, t, s) {
    this.#a || (s && this.#c.push(t), this.#W({ data: e, init: !1 }));
  }
  /**
   * How long the whole presentation is.
   *
   * Without this the media element has no timeline to offer a viewer: it is
   * what turns `seekable` into the length of the file rather than the length
   * of what has been converted so far.
   */
  setDuration(e) {
    this.#b = e, this.#I();
  }
  /**
   * Throw away everything buffered and everything queued.
   *
   * A seek lands somewhere the buffer does not reach, and what follows it is
   * a different part of the file: keeping the old media would leave the
   * timeline with a hole in the middle and the eviction bookkeeping describing
   * bytes that are no longer there.
   */
  reset() {
    this.#a || (this.#v++, this.#r = [], this.#p = 0, this.#c = [], this.#o = !1, this.#L = !1, this.#u = !1, this.#E(), this.#e && (this.#h = !0), this.#D(!0), this.#m(), this.#_());
  }
  async finish() {
    if (this.#L = !0, this.#a || !this.#e) return;
    const e = this.#v;
    if (await new Promise((t) => {
      this.#P.push(t), this.#_();
    }), !(this.#a || this.#v !== e) && this.mediaSource.readyState === "open")
      try {
        this.mediaSource.endOfStream();
      } catch (t) {
        throw this.#S("end MediaSource", t);
      }
  }
  close() {
    this.#a || (this.#a = !0, this.mediaSource.removeEventListener("sourceopen", this.#C), this.mediaSource.removeEventListener("sourceclose", this.#j), this.managed && (this.mediaSource.removeEventListener(
      "startstreaming",
      this.#B
    ), this.mediaSource.removeEventListener(
      "endstreaming",
      this.#F
    )), this.#e?.removeEventListener("updateend", this.#x), this.#e?.removeEventListener("error", this.#O), this.#e = null, this.#r = [], this.#p = 0, this.#c = [], this.#U.abandon(), this.#D(!0));
  }
  /** Tell the sink where playback has got to, so it can evict what is behind. */
  setCurrentTime(e) {
    this.#M = e, this.#$(), this.#m(), this.#_();
  }
  #W(e) {
    this.#r.push(e), this.#p += e.data.byteLength, this.#m(), this.#_();
  }
  #_() {
    const e = this.#e;
    if (this.#a || !e || e.updating || this.#n)
      return;
    if (this.#h) {
      this.#n = { type: "clear" };
      try {
        e.remove(0, Number.POSITIVE_INFINITY);
      } catch (s) {
        this.#n = null, this.#h = !1, this.#k("clear SourceBuffer", s);
      }
      return;
    }
    if (this.#u) return;
    const t = this.#r[0];
    if (!t) {
      this.#D(!1);
      return;
    }
    if (this.#d !== null) {
      const s = this.#d;
      this.#d = null;
      try {
        e.changeType(s), this.#f = s;
      } catch (i) {
        this.#k("change SourceBuffer type", i);
        return;
      }
    }
    this.#n = { type: "append", pending: t, epoch: this.#v };
    try {
      e.appendBuffer(t.data);
    } catch (s) {
      this.#n = null, s instanceof DOMException && s.name === "QuotaExceededError" ? (this.#u = !0, this.#m(), this.#E(), this.#$()) : this.#k("append SourceBuffer", s);
    }
  }
  #x = () => {
    const e = this.#n;
    if (e?.type === "append") {
      if (e.epoch === this.#v && this.#r[0] === e.pending) {
        const t = this.#r.shift();
        this.#p -= t.data.byteLength, t.init || this.#T();
      }
    } else e?.type === "remove" ? (this.#u = !1, this.#E()) : e?.type === "clear" && (this.#h = !1);
    this.#n = null, this.#I(), this.#$(), this.#m(), this.#_();
  };
  /**
   * The managed source asking for data again, which is the only thing that
   * reopens the door `endstreaming` closed.
   */
  #B = () => {
    this.#y = !0, this.#m(), this.#E();
  };
  /**
   * The managed source saying it has enough.
   *
   * What is already queued still goes in -- it was converted, and a few
   * fragments are cheaper to append than to convert again -- but nothing more
   * is taken until it asks. This is the whole point of the managed source: it
   * knows what the radio and the battery are doing and the page does not.
   */
  #F = () => {
    this.#y = !1, this.#m(), this.#E();
  };
  #O = () => {
    this.#k(
      "complete SourceBuffer update",
      new Error("the SourceBuffer rejected what was appended")
    );
  };
  #C = () => {
    this.#H++, this.#R = performance.now();
  };
  #j = () => {
    this.#N++, this.#w = performance.now();
  };
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
  #T() {
    const e = this.#e?.buffered;
    this.#o || !e || e.length === 0 || (this.#o = !0, this.#s.onMark?.("appended"), this.#s.seek(e.start(0)));
  }
  /**
   * Put the length of the file on the MediaSource, once it will take one.
   *
   * The setter only exists while the stream is open and nothing is updating,
   * so this runs again after every operation until it finds its moment. A
   * duration shorter than what is already buffered would evict the difference,
   * so what is buffered wins: it is the file speaking for itself.
   */
  #I() {
    const e = this.#b;
    if (e === null || this.#a || this.mediaSource.readyState !== "open" || this.#n || this.#e?.updating) return;
    const t = this.#e?.buffered, s = t && t.length > 0 ? t.end(t.length - 1) : 0;
    this.#b = null;
    try {
      this.mediaSource.duration = Math.max(e, s);
    } catch (i) {
      this.#k("set MediaSource duration", i);
    }
  }
  /**
   * Drop what is behind the playhead, once a browser has said it is out of
   * room.
   *
   * Only some of them say so. Chrome and Safari throw `QuotaExceededError` and
   * hand the decision back; Firefox keeps its own ceiling and evicts by itself,
   * from its own bookkeeping, and does not need help. Removing anyway would
   * only be another chance to remove the wrong thing.
   */
  #$() {
    const e = this.#e;
    if (!this.#u || !e || e.updating || this.#n || this.#h || e.buffered.length === 0) return;
    const t = this.#M - this.#s.keepBehindSeconds;
    let s = 0;
    for (const r of this.#c) {
      if (r > t) break;
      s = r;
    }
    const i = s - 1e-3;
    if (!(i <= 0)) {
      for (; this.#c.length > 0 && this.#c[0] < s; )
        this.#c.shift();
      this.#n = { type: "remove" };
      try {
        e.remove(0, i);
      } catch (r) {
        this.#n = null, this.#k("evict SourceBuffer range", r);
      }
    }
  }
  /** How far past the playhead the buffer reaches, in seconds. */
  #G() {
    const e = this.#e?.buffered;
    return !e || e.length === 0 ? 0 : e.end(e.length - 1) - this.#M;
  }
  #m() {
    const e = !this.#u && this.#y && this.#G() < this.#s.maxAheadSeconds && this.#p < this.#s.queueHighWaterMark && this.#r.length < 2;
    this.#U.set(e) && this.#s.onReadyChange?.(e);
  }
  /**
   * Say whether conversion is waiting on the buffer, whichever of the two
   * reasons it is: no room left, or a managed source that wants nothing for
   * now. Both look the same from where the conversion sits.
   */
  #E() {
    const e = this.#u || !this.#y;
    e !== this.#g && (this.#g = e, this.#s.onBlocked?.(e));
  }
  /** Wake `finish`, either because everything is appended or because we gave up. */
  #D(e) {
    if (!e && (!this.#L || this.#r.length > 0 || this.#n))
      return;
    const t = this.#P;
    this.#P = [];
    for (const s of t) s();
  }
  #S(e, t) {
    const s = t instanceof Error ? t : new Error(String(t)), i = this.#e, r = performance.now(), d = [
      `mediaSource=${this.mediaSource.readyState}`,
      `closed=${this.#a}`,
      `sourceOpens=${this.#H}`,
      `sourceCloses=${this.#N}`,
      `sinceSourceOpenMs=${this.#R === null ? "none" : Math.round(r - this.#R)}`,
      `sinceSourceCloseMs=${this.#w === null ? "none" : Math.round(r - this.#w)}`,
      `sourceBuffer=${i ? "present" : "absent"}`,
      `updating=${i?.updating ?? !1}`,
      `operation=${this.#n?.type ?? "none"}`,
      `queue=${this.#r.length}`,
      `epoch=${this.#v}`
    ].join(", "), u = new Error(
      `MSE ${e} failed (${d}): ${s.name}: ${s.message}`
    );
    return u.name = s.name, u.stack += `
Caused by: ${s.stack ?? s.message}`, u;
  }
  #k(e, t) {
    this.#s.onError?.(this.#S(e, t));
  }
}
const E = "" + new URL("assets/worker-fyPnL23k.js", import.meta.url).href, k = E, c = 0.1, f = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "playing",
  "waiting"
];
function p(n = !1) {
  return S(n);
}
const y = 'video/mp4; codecs="mp4v.61"';
function T(n = !1) {
  return m(y, n);
}
function a(n) {
  return n instanceof Error ? n : new Error(String(n));
}
function h() {
  return performance.timeOrigin + performance.now();
}
class L extends EventTarget {
  video;
  #t;
  #s;
  #i = null;
  /** Which load messages belong to. Bumped by every load and every stop. */
  #e = 0;
  #f = "idle";
  /** The sink, when the page owns the MediaSource. */
  #d = null;
  #r = null;
  /** The `<source>` child a Managed Media Source needs; see #attachManaged. */
  #p = null;
  /** Whether remote playback was turned off here, and so is ours to turn back. */
  #n = !1;
  #u = null;
  #y = null;
  /** How long the input is, when it turned out to be one that can be seeked. */
  #g = null;
  /** Source video properties indexed by presentation time. */
  #h = [];
  /** What sound the programme last said it was carrying. See `AudioTracks`. */
  #v = null;
  /** When `load()` was called, as epoch milliseconds; every mark counts from it. */
  #b = 0;
  /** When the last mark was, so each one can say what it cost on its own. */
  #c = 0;
  /** Built the first time deinterlacing is turned on, and kept after that. */
  #o = null;
  /** Whether deinterlacing was asked for. */
  #M = !1;
  #a = !1;
  constructor(e, t = {}) {
    super(), this.video = e, this.#t = t;
    const s = t.mediaSource ?? "auto";
    this.#s = s === "auto" ? p(t.preferManagedMediaSource) ? "worker" : "main" : s, this.video.addEventListener("seeking", this.#O);
    for (const i of f)
      this.video.addEventListener(i, this.#C);
    t.deinterlace && (this.deinterlace = !0);
  }
  get state() {
    return this.#f;
  }
  /**
   * How long the input is, or null while it is a stream that plays as it
   * arrives. The same number reaches the media element as its duration.
   */
  get duration() {
    return this.#g;
  }
  /**
   * What sound the programme is carrying and which of it is being taken, or
   * null before its program map has been read. See `AudioTracks`.
   */
  get audio() {
    return this.#v;
  }
  /**
   * Take the sound from another of the service's streams from here on.
   *
   * From here on, and no further back: the fragments already converted carry
   * the sound they were made with and are in the buffer being played, so the
   * change arrives when the playhead reaches what is being converted now --
   * a few seconds on a live stream, and however far ahead the buffer has run
   * on a recording. Emptying the buffer to make it immediate would take the
   * picture with it.
   *
   * The PID is one of `audio.available`. One the program map has yet to name
   * is remembered until it does, so a page restoring a viewer's choice may
   * call this before the map arrives.
   */
  selectAudio(e) {
    this.#i?.postMessage({
      type: "audio",
      id: this.#e,
      pid: e,
      dualMonoSub: null
    });
  }
  /**
   * The same choice inside a dual-mono stream, where the two services are the
   * two channels of one stream rather than two streams.
   *
   * A bilingual broadcast in Japan is carried either way, and which way is not
   * the viewer's business: `audio.dualMono` says which control to offer. This
   * one describes nothing anew, so the change costs no restart point.
   */
  selectDualMono(e) {
    this.#i?.postMessage({
      type: "audio",
      id: this.#e,
      pid: null,
      dualMonoSub: e
    });
  }
  /** Which side of the wire ended up owning the MediaSource. */
  get mediaSourceOwner() {
    return this.#s;
  }
  /**
   * Whether the picture is being deinterlaced, which is not quite the same as
   * having asked for it: a source that says it is progressive is left alone,
   * and starts being filtered again the moment it says otherwise. Assigning
   * turns it on or off where it stands, so the two can be compared on the
   * frame; a browser that cannot run it stays false.
   */
  get deinterlace() {
    return this.#o?.running ?? !1;
  }
  /** Whether deinterlacing was asked for, whatever the source turned out to be. */
  get deinterlaceWanted() {
    return this.#M;
  }
  /**
   * The deinterlacer itself, once there has been one, for the settings that
   * are its own -- the field order, and whether a picture goes up per field
   * or per frame. Null until `deinterlace` has been turned on.
   */
  get deinterlacer() {
    return this.#o;
  }
  set deinterlace(e) {
    this.#M = e, this.#L();
  }
  /**
   * Run the filter where it is both wanted and called for.
   *
   * A progressive source has one moment per frame and nothing to rebuild, so
   * filtering it can only soften it. Until the source has said which it is --
   * before the first fragment of a load -- what was asked for is what happens,
   * since an interlaced picture left unfiltered is the more visible mistake of
   * the two.
   */
  #L() {
    if (!this.#a)
      try {
        this.#M && !this.#o && this.#t.deinterlacer && (this.#o = this.#t.deinterlacer(this.video)), this.#o && (this.#o.videoTimeline = this.#h, this.#o.enabled = this.#M);
      } catch (e) {
        this.#l("error", { error: a(e) });
      }
  }
  #H(e, t, s) {
    e <= 0 || t <= 0 || this.#R({ start: s, codedSize: { width: e, height: t } });
  }
  /** Add source metadata now, but apply it only when its picture is shown. */
  #N(e) {
    for (const { start: t, interlaced: s, topFieldFirst: i } of e)
      this.#R({
        start: t,
        scan: { interlaced: s, topFieldFirst: i }
      });
  }
  #R(e) {
    const t = this.#h.at(-1), s = {
      start: e.start,
      codedSize: e.codedSize ?? t?.codedSize,
      scan: e.scan ?? t?.scan
    };
    if (t?.start === s.start) this.#h.pop();
    else if (t?.codedSize?.width === s.codedSize?.width && t?.codedSize?.height === s.codedSize?.height && t?.scan?.interlaced === s.scan?.interlaced && t?.scan?.topFieldFirst === s.scan?.topFieldFirst)
      return;
    if (this.#h.push(s), this.video.buffered.length > 0) {
      const i = this.video.buffered.start(0);
      let r = 0;
      for (; r + 1 < this.#h.length && this.#h[r + 1].start <= i; )
        r++;
      r > 0 && this.#h.splice(0, r);
    }
    this.#o && (this.#o.videoTimeline = this.#h);
  }
  #w() {
    this.#h = [], this.#o && (this.#o.videoTimeline = []);
  }
  load(e) {
    if (this.#a)
      return Promise.reject(new Error("the player has been destroyed"));
    if (this.#s === "worker" && !p(this.#t.preferManagedMediaSource))
      return Promise.reject(
        new Error("this browser cannot construct a MediaSource in a worker")
      );
    this.stop();
    const t = this.#e;
    this.#g = null, this.#w(), this.#L(), this.#b = h(), this.#c = this.#b;
    const s = this.#U(), i = new Promise((r, d) => {
      this.#y = { resolve: r, reject: d };
    });
    return this.#A("loading"), s.postMessage({
      type: "load",
      id: t,
      url: String(e),
      wasmUrl: this.#t.wasmUrl === void 0 ? null : String(this.#t.wasmUrl),
      oversample: this.#t.oversample,
      recoveryInterval: this.#t.recoveryInterval,
      openGopRecovery: this.#t.openGopRecovery,
      splitFieldSamples: this.#t.splitFieldSamples,
      passthrough: this.#t.passthrough ?? !1,
      pictureWorkers: this.#t.pictureWorkers,
      serviceId: this.#t.serviceId ?? null,
      sink: this.#s,
      preferManagedMediaSource: this.#t.preferManagedMediaSource ?? !1,
      queueHighWaterMark: this.#t.queueHighWaterMark ?? 33554432,
      maxAheadSeconds: this.#t.maxAheadSeconds ?? 8,
      keepBehindSeconds: this.#t.keepBehindSeconds ?? 10
    }), this.#m(), i;
  }
  /** Abandon the current load. The player stays usable. */
  stop() {
    const e = this.#e;
    this.#e++, this.#i?.postMessage({ type: "stop", id: e }), this.#D(), this.#q(new Error("the load was stopped")), this.#A("idle");
  }
  /** Stop, and give up the worker. The player cannot be loaded again. */
  destroy() {
    if (!this.#a) {
      this.stop(), this.#a = !0, this.video.removeEventListener("seeking", this.#O);
      for (const e of f)
        this.video.removeEventListener(e, this.#C);
      this.#o?.destroy(), this.#o = null, this.#i?.terminate(), this.#i = null;
    }
  }
  addEventListener(e, t, s) {
    super.addEventListener(e, t, s);
  }
  removeEventListener(e, t, s) {
    super.removeEventListener(e, t, s);
  }
  #U() {
    if (!this.#i) {
      const e = new Worker(
        this.#t.workerUrl ?? k,
        {
          type: "module"
        }
      );
      e.onmessage = this.#P, e.onerror = (t) => this.#S(new Error(t.message || "the worker failed")), this.#i = e;
    }
    return this.#i;
  }
  #P = (e) => {
    const t = e.data;
    if (t.id === this.#e)
      switch (t.type) {
        case "handle":
          t.managed && this.#B(), this.video.srcObject = t.handle, this.#T("attached", h());
          break;
        case "open":
          this.#W(t.mimeCodec, t.data);
          break;
        case "video-config":
          this.#H(
            t.width,
            t.height,
            t.start
          );
          break;
        case "fragment":
          this.#d?.push(
            t.data,
            t.start,
            t.randomAccess
          );
          break;
        case "opened":
          this.#A("converting"), this.#q(null);
          break;
        case "seekable":
          this.#g = t.duration, this.#d?.setDuration(t.duration), this.#l("seekable", { duration: t.duration });
          break;
        case "reset":
          this.#w(), this.#d?.reset();
          break;
        case "scans":
          this.#N(t.scans);
          break;
        case "workers":
          this.#l("workers", {
            pictureWorkers: t.pictureWorkers
          });
          break;
        case "services":
          this.#l("services", t.services);
          break;
        case "audio":
          this.#v = t.audio, this.#l("audio", t.audio);
          break;
        case "private_stream_1":
        case "private_stream_2":
          this.#l(t.type, t.stream);
          break;
        case "mark":
          this.#T(t.name, t.at);
          break;
        case "seek":
          this.video.currentTime < t.time && (this.video.currentTime = t.time);
          break;
        case "progress":
          this.#l("progress", {
            bytesRead: t.bytesRead,
            totalBytes: t.totalBytes
          });
          break;
        case "stats":
          this.#l("stats", t.stats);
          break;
        case "blocked":
          this.#A(t.blocked ? "buffer-full" : "converting");
          break;
        case "finish":
          this.#F();
          break;
        case "completed":
          this.#A("completed"), this.#s === "worker" && this.#E();
          break;
        case "error":
          this.#S(new Error(t.message));
          break;
      }
  };
  /** Open a MediaSource here, for browsers that cannot have one in a worker. */
  #W(e, t) {
    const s = this.#e;
    let i;
    try {
      i = this.#d ?? this.#_(s);
    } catch (r) {
      this.#S(a(r));
      return;
    }
    i.open(e, t).then(
      // The worker is waiting on flow to know the open succeeded. Going
      // through ready() rather than saying true covers the case where the
      // append filled the queue on its own.
      () => i.ready().then(() => this.#G(s, { type: "flow", id: s, ready: !0 })),
      (r) => {
        s === this.#e && this.#S(this.#k(a(r)));
      }
    );
  }
  #_(e) {
    const t = new v({
      preferManaged: this.#t.preferManagedMediaSource,
      queueHighWaterMark: this.#t.queueHighWaterMark ?? 33554432,
      maxAheadSeconds: this.#t.maxAheadSeconds ?? 8,
      keepBehindSeconds: this.#t.keepBehindSeconds ?? 10,
      seek: (s) => {
        this.video.currentTime < s && (this.video.currentTime = s);
      },
      onMark: (s) => this.#T(s, h()),
      onReadyChange: (s) => this.#G(e, { type: "flow", id: e, ready: s }),
      onBlocked: (s) => {
        e === this.#e && this.#A(s ? "buffer-full" : "converting");
      },
      onError: (s) => {
        e === this.#e && this.#S(this.#k(s));
      }
    });
    return this.#d = t, this.#r = URL.createObjectURL(t.mediaSource), t.managed ? this.#x(this.#r) : this.video.src = this.#r, this.#T("attached", h()), this.#g !== null && t.setDuration(this.#g), t;
  }
  /**
   * Put a Managed Media Source on the element, which takes more than a `src`.
   *
   * Safari leaves one closed until the element has given up remote playback --
   * AirPlay has nowhere to send a source the page is feeding, so the two are
   * mutually exclusive -- and until the URL is on a `<source>` child rather
   * than the attribute. Neither is optional: miss one and `sourceopen` never
   * arrives and the load waits for a stream that has not begun.
   */
  #x(e) {
    this.video.removeAttribute("src"), this.#B();
    const t = document.createElement("source");
    t.type = "video/mp4", t.src = e, this.video.append(t), this.#p = t, this.video.load();
  }
  /**
   * Rule out AirPlay, which a managed source cannot be sent over and which
   * Safari will not open one until the element has given up. The element
   * belongs to whoever made it, so it is put back on the way out -- unless it
   * was already off, and theirs to keep.
   */
  #B() {
    this.video.disableRemotePlayback || (this.video.disableRemotePlayback = !0, this.#n = !0);
  }
  #F() {
    const e = this.#e, t = this.#d;
    t && t.finish().then(
      () => {
        e === this.#e && this.#E();
      },
      (s) => {
        e === this.#e && this.#S(a(s));
      }
    );
  }
  /**
   * Answer the viewer moving the playhead somewhere the buffer does not reach.
   *
   * Everything inside a buffered range is Media Source Extensions' own affair,
   * including the correction #startAtMedia asks for, so those go no further.
   * What is left is a real seek: the worker throws the buffer away and reads
   * the input again from where the viewer asked to be.
   */
  #O = () => {
    if (this.#g === null || this.#f === "idle" || this.#f === "error") return;
    const e = this.video.currentTime;
    this.#I(e) || (this.#A("seeking"), this.#w(), this.#m(), this.#i?.postMessage({
      type: "seek",
      id: this.#e,
      time: e
    }));
  };
  #C = (e) => {
    this.#f !== "idle" && (this.#T(e.type, h()), e.type === "waiting" && this.#j());
  };
  /**
   * Move the playhead over a hole in the media, where playback has stopped at
   * one.
   *
   * The conversion leaves the media where the source put it, so a recording
   * joined from two takes has a real gap between them rather than one closed up
   * -- closing it would move everything after it, and the captions, which carry
   * the source's own timestamps, would be out by the length of the gap for the
   * rest of the stream. A browser stops at a gap and waits, so somebody has to
   * step over it, and it is this side: it is the one that knows the playhead.
   *
   * Only where media is already buffered past the hole, which is what
   * distinguishes a hole from the ordinary wait for the converter to catch up.
   *
   * Read from the media element rather than from the sink: what stops playback
   * is the element's own view, which is the tracks' ranges taken together, and
   * it is the one reading available whether the `MediaSource` is here or in the
   * worker.
   */
  #j() {
    if (this.video.seeking) return;
    const e = this.video.currentTime, t = this.video.buffered;
    let s = null;
    for (let i = 0; i < t.length; i++) {
      const r = t.start(i);
      if (e >= r - c && e < t.end(i) - c)
        return;
      r > e + c && (s === null || r < s) && (s = r);
    }
    s !== null && (this.video.currentTime = s);
  }
  /**
   * Report where a step of the load fell on the clock `load()` started.
   *
   * The worker's marks arrive as epoch milliseconds because that is the only
   * reading the two contexts share; what a caller wants is how long it waited,
   * which is measured from here.
   */
  #T(e, t) {
    if (this.#b === 0) return;
    const s = t - this.#b, i = Math.max(0, t - this.#c);
    this.#c = Math.max(this.#c, t), this.#l("timing", { name: e, sinceLoad: s, sincePrevious: i });
  }
  #I(e) {
    const t = this.video.buffered;
    for (let s = 0; s < t.length; s++)
      if (e >= t.start(s) && e < t.end(s))
        return !0;
    return !1;
  }
  /**
   * Tell whoever holds the buffer where playback is, so it can drop what is
   * behind. This cannot ride on `timeupdate`: that event stops firing exactly
   * when playback stalls, which is when eviction matters most.
   */
  #$ = () => {
    const e = this.video.currentTime;
    this.#s === "main" ? this.#d?.setCurrentTime(e) : this.#i?.postMessage({
      type: "time",
      id: this.#e,
      currentTime: e
    });
  };
  #G(e, t) {
    e === this.#e && this.#i?.postMessage(t);
  }
  #m() {
    this.#u === null && (this.#u = setInterval(
      this.#$,
      200
    ));
  }
  #E() {
    this.#u !== null && (clearInterval(this.#u), this.#u = null);
  }
  #D() {
    this.#E(), this.#w(), this.#d?.close(), this.#d = null, this.#r && URL.revokeObjectURL(this.#r), this.#r = null, this.#p?.remove(), this.#p = null, this.#n && (this.video.disableRemotePlayback = !1, this.#n = !1), this.video.removeAttribute("src"), this.video.srcObject = null, this.video.load();
  }
  #S(e) {
    this.#D(), this.#A("error"), this.#q(e), this.#l("error", { error: e });
  }
  #k(e) {
    const t = this.#p, s = this.#r, i = [
      `videoConnected=${this.video.isConnected}`,
      `videoReadyState=${this.video.readyState}`,
      `videoNetworkState=${this.video.networkState}`,
      `videoPaused=${this.video.paused}`,
      `sourceElement=${t ? "present" : "absent"}`,
      `sourceConnected=${t?.isConnected ?? !1}`,
      `sourceMatchesObjectUrl=${t !== null && s !== null && t.src === s}`,
      `currentSrcMatchesObjectUrl=${s !== null && this.video.currentSrc === s}`
    ].join(", "), r = new Error(`${e.message} (${i})`);
    return r.name = e.name, r.stack += `
Caused by: ${e.stack ?? e.message}`, r;
  }
  #q(e) {
    const t = this.#y;
    t && (this.#y = null, e ? t.reject(e) : t.resolve());
  }
  #A(e) {
    this.#f !== e && (this.#f = e, this.#l("statechange", { state: e }));
  }
  #l(e, t) {
    this.dispatchEvent(new CustomEvent(e, { detail: t }));
  }
}
export {
  w as DEFAULT_KEEP_BEHIND_SECONDS,
  M as DEFAULT_MAX_AHEAD_SECONDS,
  b as DEFAULT_QUEUE_HIGH_WATER_MARK,
  L as Mpeg2TsPlayer,
  _ as requiresManagedMediaSource,
  A as supportsManagedMediaSource,
  T as supportsPassthrough,
  p as supportsWorkerMediaSource
};
//# sourceMappingURL=index.js.map
