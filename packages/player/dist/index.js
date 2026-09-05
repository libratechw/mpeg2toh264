const y = 33554432;
const b = 8, M = 10;
const h = globalThis.ManagedMediaSource;
function c(n = !1) {
  const e = typeof MediaSource > "u" ? null : MediaSource;
  return n && h ? h : e ?? h ?? null;
}
function p(n, e = !1) {
  return c(e)?.isTypeSupported(n) ?? !1;
}
function m(n = !1) {
  return c(n)?.canConstructInDedicatedWorker === !0;
}
function w() {
  return h !== void 0;
}
function _() {
  return typeof MediaSource > "u" && h !== void 0;
}
class g {
  #t = !0;
  #i = [];
  get open() {
    return this.#t;
  }
  /** Returns whether this changed anything. */
  set(e) {
    return e === this.#t ? !1 : (this.#t = e, e && this.#s(), !0);
  }
  wait() {
    return this.#t ? Promise.resolve() : new Promise((e) => {
      this.#i.push(e);
    });
  }
  /** Let everyone through whatever the state is, for teardown. */
  abandon() {
    this.#s();
  }
  #s() {
    const e = this.#i;
    this.#i = [];
    for (const t of e) t();
  }
}
class S {
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
  #i;
  #s;
  #e = null;
  /** What the `SourceBuffer` was opened with, or last changed to. */
  #f = "";
  /** A codec to move the `SourceBuffer` to before the next append. */
  #d = null;
  #h = [];
  #g = 0;
  #r = null;
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
  #k = !0;
  /** The last thing said about there being no room, so it is said once. */
  #S = !1;
  /** Whether everything buffered is waiting to be thrown away; see `reset`. */
  #a = !1;
  /** Which stretch of timeline is being filled. Bumped by every `reset`. */
  #E = 0;
  /** A duration to put on the MediaSource as soon as it will take one. */
  #y = null;
  /** Media times a decoder can start from, in order; see #evict. */
  #c = [];
  /** Whether the playhead has been put where the media starts; see #startAtMedia. */
  #n = !1;
  #b = 0;
  #o = !1;
  #A = !1;
  #R = new g();
  #D = [];
  constructor(e) {
    this.#i = e;
    const t = c(e.preferManaged);
    if (!t) throw new Error("this browser has no Media Source Extensions");
    this.#t = t, this.mediaSource = new t(), this.managed = t === h, this.managed && (this.mediaSource.addEventListener(
      "startstreaming",
      this.#H
    ), this.mediaSource.addEventListener("endstreaming", this.#O)), this.#s = new Promise((i) => {
      this.mediaSource.addEventListener(
        "sourceopen",
        () => {
          e.onMark?.("sourceopen"), i();
        },
        { once: !0 }
      );
    });
  }
  ready() {
    return this.#R.wait();
  }
  /**
   * Open the stream, or -- for the initialization segment a seek brings with
   * it -- re-open the one already running.
   */
  async open(e, t) {
    if (!this.#t.isTypeSupported(e))
      throw new Error(`unsupported codec: ${e}`);
    if (await this.#s, !this.#o) {
      if (this.#e)
        e !== this.#f && (this.#d = e);
      else try {
        const i = this.mediaSource.addSourceBuffer(e);
        i.mode = "segments", i.addEventListener("updateend", this.#I), i.addEventListener("error", this.#N), this.#e = i, this.#f = e;
      } catch (i) {
        throw this.#P("add or configure SourceBuffer", i);
      }
      this.#U({ data: t, init: !0 }), this.#T();
    }
  }
  push(e, t, i) {
    this.#o || (i && this.#c.push(t), this.#U({ data: e, init: !1 }));
  }
  /**
   * How long the whole presentation is.
   *
   * Without this the media element has no timeline to offer a viewer: it is
   * what turns `seekable` into the length of the file rather than the length
   * of what has been converted so far.
   */
  setDuration(e) {
    this.#y = e, this.#T();
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
    this.#o || (this.#E++, this.#h = [], this.#g = 0, this.#c = [], this.#n = !1, this.#A = !1, this.#u = !1, this.#_(), this.#e && (this.#a = !0), this.#v(!0), this.#m(), this.#p());
  }
  async finish() {
    if (this.#A = !0, this.#o || !this.#e) return;
    const e = this.#E;
    if (await new Promise((t) => {
      this.#D.push(t), this.#p();
    }), !(this.#o || this.#E !== e) && this.mediaSource.readyState === "open")
      try {
        this.mediaSource.endOfStream();
      } catch (t) {
        throw this.#P("end MediaSource", t);
      }
  }
  close() {
    this.#o || (this.#o = !0, this.managed && (this.mediaSource.removeEventListener(
      "startstreaming",
      this.#H
    ), this.mediaSource.removeEventListener(
      "endstreaming",
      this.#O
    )), this.#e?.removeEventListener("updateend", this.#I), this.#e?.removeEventListener("error", this.#N), this.#e = null, this.#h = [], this.#g = 0, this.#c = [], this.#R.abandon(), this.#v(!0));
  }
  /** Tell the sink where playback has got to, so it can evict what is behind. */
  setCurrentTime(e) {
    this.#b = e, this.#B(), this.#m(), this.#p();
  }
  #U(e) {
    this.#h.push(e), this.#g += e.data.byteLength, this.#m(), this.#p();
  }
  #p() {
    const e = this.#e;
    if (this.#o || !e || e.updating || this.#r)
      return;
    if (this.#a) {
      this.#r = { type: "clear" };
      try {
        e.remove(0, Number.POSITIVE_INFINITY);
      } catch (i) {
        this.#r = null, this.#a = !1, this.#M("clear SourceBuffer", i);
      }
      return;
    }
    if (this.#u) return;
    const t = this.#h[0];
    if (!t) {
      this.#v(!1);
      return;
    }
    if (this.#d !== null) {
      const i = this.#d;
      this.#d = null;
      try {
        e.changeType(i), this.#f = i;
      } catch (s) {
        this.#M("change SourceBuffer type", s);
        return;
      }
    }
    this.#r = { type: "append", pending: t, epoch: this.#E };
    try {
      e.appendBuffer(t.data);
    } catch (i) {
      this.#r = null, i instanceof DOMException && i.name === "QuotaExceededError" ? (this.#u = !0, this.#m(), this.#_(), this.#B()) : this.#M("append SourceBuffer", i);
    }
  }
  #I = () => {
    const e = this.#r;
    if (e?.type === "append") {
      if (e.epoch === this.#E && this.#h[0] === e.pending) {
        const t = this.#h.shift();
        this.#g -= t.data.byteLength, t.init || this.#F();
      }
    } else e?.type === "remove" ? (this.#u = !1, this.#_()) : e?.type === "clear" && (this.#a = !1);
    this.#r = null, this.#T(), this.#B(), this.#m(), this.#p();
  };
  /**
   * The managed source asking for data again, which is the only thing that
   * reopens the door `endstreaming` closed.
   */
  #H = () => {
    this.#k = !0, this.#m(), this.#_();
  };
  /**
   * The managed source saying it has enough.
   *
   * What is already queued still goes in -- it was converted, and a few
   * fragments are cheaper to append than to convert again -- but nothing more
   * is taken until it asks. This is the whole point of the managed source: it
   * knows what the radio and the battery are doing and the page does not.
   */
  #O = () => {
    this.#k = !1, this.#m(), this.#_();
  };
  #N = () => {
    this.#M(
      "complete SourceBuffer update",
      new Error("the SourceBuffer rejected what was appended")
    );
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
  #F() {
    const e = this.#e?.buffered;
    this.#n || !e || e.length === 0 || (this.#n = !0, this.#i.onMark?.("appended"), this.#i.seek(e.start(0)));
  }
  /**
   * Put the length of the file on the MediaSource, once it will take one.
   *
   * The setter only exists while the stream is open and nothing is updating,
   * so this runs again after every operation until it finds its moment. A
   * duration shorter than what is already buffered would evict the difference,
   * so what is buffered wins: it is the file speaking for itself.
   */
  #T() {
    const e = this.#y;
    if (e === null || this.#o || this.mediaSource.readyState !== "open" || this.#r || this.#e?.updating) return;
    const t = this.#e?.buffered, i = t && t.length > 0 ? t.end(t.length - 1) : 0;
    this.#y = null;
    try {
      this.mediaSource.duration = Math.max(e, i);
    } catch (s) {
      this.#M("set MediaSource duration", s);
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
  #B() {
    const e = this.#e;
    if (!this.#u || !e || e.updating || this.#r || this.#a || e.buffered.length === 0) return;
    const t = this.#b - this.#i.keepBehindSeconds;
    let i = 0;
    for (const r of this.#c) {
      if (r > t) break;
      i = r;
    }
    const s = i - 1e-3;
    if (!(s <= 0)) {
      for (; this.#c.length > 0 && this.#c[0] < i; )
        this.#c.shift();
      this.#r = { type: "remove" };
      try {
        e.remove(0, s);
      } catch (r) {
        this.#r = null, this.#M("evict SourceBuffer range", r);
      }
    }
  }
  /** How far past the playhead the buffer reaches, in seconds. */
  #W() {
    const e = this.#e?.buffered;
    return !e || e.length === 0 ? 0 : e.end(e.length - 1) - this.#b;
  }
  #m() {
    const e = !this.#u && this.#k && this.#W() < this.#i.maxAheadSeconds && this.#g < this.#i.queueHighWaterMark && this.#h.length < 2;
    this.#R.set(e) && this.#i.onReadyChange?.(e);
  }
  /**
   * Say whether conversion is waiting on the buffer, whichever of the two
   * reasons it is: no room left, or a managed source that wants nothing for
   * now. Both look the same from where the conversion sits.
   */
  #_() {
    const e = this.#u || !this.#k;
    e !== this.#S && (this.#S = e, this.#i.onBlocked?.(e));
  }
  /** Wake `finish`, either because everything is appended or because we gave up. */
  #v(e) {
    if (!e && (!this.#A || this.#h.length > 0 || this.#r))
      return;
    const t = this.#D;
    this.#D = [];
    for (const i of t) i();
  }
  #P(e, t) {
    const i = t instanceof Error ? t : new Error(String(t)), s = this.#e, r = [
      `mediaSource=${this.mediaSource.readyState}`,
      `closed=${this.#o}`,
      `sourceBuffer=${s ? "present" : "absent"}`,
      `updating=${s?.updating ?? !1}`,
      `operation=${this.#r?.type ?? "none"}`,
      `queue=${this.#h.length}`,
      `epoch=${this.#E}`
    ].join(", "), a = new Error(
      `MSE ${e} failed (${r}): ${i.name}: ${i.message}`
    );
    return a.name = i.name, a.stack += `
Caused by: ${i.stack ?? i.message}`, a;
  }
  #M(e, t) {
    this.#i.onError?.(this.#P(e, t));
  }
}
const E = "" + new URL("assets/worker-CpkyDHSk.js", import.meta.url).href, v = E, u = 0.1, l = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "playing",
  "waiting"
];
function f(n = !1) {
  return m(n);
}
const k = 'video/mp4; codecs="mp4v.61"';
function A(n = !1) {
  return p(k, n);
}
function d(n) {
  return n instanceof Error ? n : new Error(String(n));
}
function o() {
  return performance.timeOrigin + performance.now();
}
class T extends EventTarget {
  video;
  #t;
  #i;
  #s = null;
  /** Which load messages belong to. Bumped by every load and every stop. */
  #e = 0;
  #f = "idle";
  /** The sink, when the page owns the MediaSource. */
  #d = null;
  #h = null;
  /** The `<source>` child a Managed Media Source needs; see #attachManaged. */
  #g = null;
  /** Whether remote playback was turned off here, and so is ours to turn back. */
  #r = !1;
  #u = null;
  #k = null;
  /** How long the input is, when it turned out to be one that can be seeked. */
  #S = null;
  /** Source video properties indexed by presentation time. */
  #a = [];
  /** What sound the programme last said it was carrying. See `AudioTracks`. */
  #E = null;
  /** When `load()` was called, as epoch milliseconds; every mark counts from it. */
  #y = 0;
  /** When the last mark was, so each one can say what it cost on its own. */
  #c = 0;
  /** Built the first time deinterlacing is turned on, and kept after that. */
  #n = null;
  /** Whether deinterlacing was asked for. */
  #b = !1;
  #o = !1;
  constructor(e, t = {}) {
    super(), this.video = e, this.#t = t;
    const i = t.mediaSource ?? "auto";
    this.#i = i === "auto" ? f(t.preferManagedMediaSource) ? "worker" : "main" : i, this.video.addEventListener("seeking", this.#W);
    for (const s of l)
      this.video.addEventListener(s, this.#m);
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
    return this.#S;
  }
  /**
   * What sound the programme is carrying and which of it is being taken, or
   * null before its program map has been read. See `AudioTracks`.
   */
  get audio() {
    return this.#E;
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
    this.#s?.postMessage({
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
    this.#s?.postMessage({
      type: "audio",
      id: this.#e,
      pid: null,
      dualMonoSub: e
    });
  }
  /** Which side of the wire ended up owning the MediaSource. */
  get mediaSourceOwner() {
    return this.#i;
  }
  /**
   * Whether the picture is being deinterlaced, which is not quite the same as
   * having asked for it: a source that says it is progressive is left alone,
   * and starts being filtered again the moment it says otherwise. Assigning
   * turns it on or off where it stands, so the two can be compared on the
   * frame; a browser that cannot run it stays false.
   */
  get deinterlace() {
    return this.#n?.running ?? !1;
  }
  /** Whether deinterlacing was asked for, whatever the source turned out to be. */
  get deinterlaceWanted() {
    return this.#b;
  }
  /**
   * The deinterlacer itself, once there has been one, for the settings that
   * are its own -- the field order, and whether a picture goes up per field
   * or per frame. Null until `deinterlace` has been turned on.
   */
  get deinterlacer() {
    return this.#n;
  }
  set deinterlace(e) {
    this.#b = e, this.#A();
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
  #A() {
    if (!this.#o)
      try {
        this.#b && !this.#n && this.#t.deinterlacer && (this.#n = this.#t.deinterlacer(this.video)), this.#n && (this.#n.videoTimeline = this.#a, this.#n.enabled = this.#b);
      } catch (e) {
        this.#l("error", { error: d(e) });
      }
  }
  #R(e, t, i) {
    e <= 0 || t <= 0 || this.#U({ start: i, codedSize: { width: e, height: t } });
  }
  /** Add source metadata now, but apply it only when its picture is shown. */
  #D(e) {
    for (const { start: t, interlaced: i, topFieldFirst: s } of e)
      this.#U({
        start: t,
        scan: { interlaced: i, topFieldFirst: s }
      });
  }
  #U(e) {
    const t = this.#a.at(-1), i = {
      start: e.start,
      codedSize: e.codedSize ?? t?.codedSize,
      scan: e.scan ?? t?.scan
    };
    if (t?.start === i.start) this.#a.pop();
    else if (t?.codedSize?.width === i.codedSize?.width && t?.codedSize?.height === i.codedSize?.height && t?.scan?.interlaced === i.scan?.interlaced && t?.scan?.topFieldFirst === i.scan?.topFieldFirst)
      return;
    if (this.#a.push(i), this.video.buffered.length > 0) {
      const s = this.video.buffered.start(0);
      let r = 0;
      for (; r + 1 < this.#a.length && this.#a[r + 1].start <= s; )
        r++;
      r > 0 && this.#a.splice(0, r);
    }
    this.#n && (this.#n.videoTimeline = this.#a);
  }
  #p() {
    this.#a = [], this.#n && (this.#n.videoTimeline = []);
  }
  load(e) {
    if (this.#o)
      return Promise.reject(new Error("the player has been destroyed"));
    if (this.#i === "worker" && !f(this.#t.preferManagedMediaSource))
      return Promise.reject(
        new Error("this browser cannot construct a MediaSource in a worker")
      );
    this.stop();
    const t = this.#e;
    this.#S = null, this.#p(), this.#A(), this.#y = o(), this.#c = this.#y;
    const i = this.#I(), s = new Promise((r, a) => {
      this.#k = { resolve: r, reject: a };
    });
    return this.#w("loading"), i.postMessage({
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
      sink: this.#i,
      preferManagedMediaSource: this.#t.preferManagedMediaSource ?? !1,
      queueHighWaterMark: this.#t.queueHighWaterMark ?? 33554432,
      maxAheadSeconds: this.#t.maxAheadSeconds ?? 8,
      keepBehindSeconds: this.#t.keepBehindSeconds ?? 10
    }), this.#$(), s;
  }
  /** Abandon the current load. The player stays usable. */
  stop() {
    const e = this.#e;
    this.#e++, this.#s?.postMessage({ type: "stop", id: e }), this.#j(), this.#C(new Error("the load was stopped")), this.#w("idle");
  }
  /** Stop, and give up the worker. The player cannot be loaded again. */
  destroy() {
    if (!this.#o) {
      this.stop(), this.#o = !0, this.video.removeEventListener("seeking", this.#W);
      for (const e of l)
        this.video.removeEventListener(e, this.#m);
      this.#n?.destroy(), this.#n = null, this.#s?.terminate(), this.#s = null;
    }
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #I() {
    if (!this.#s) {
      const e = new Worker(
        this.#t.workerUrl ?? v,
        {
          type: "module"
        }
      );
      e.onmessage = this.#H, e.onerror = (t) => this.#L(new Error(t.message || "the worker failed")), this.#s = e;
    }
    return this.#s;
  }
  #H = (e) => {
    const t = e.data;
    if (t.id === this.#e)
      switch (t.type) {
        case "handle":
          t.managed && this.#T(), this.video.srcObject = t.handle, this.#v("attached", o());
          break;
        case "open":
          this.#O(t.mimeCodec, t.data);
          break;
        case "video-config":
          this.#R(
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
          this.#w("converting"), this.#C(null);
          break;
        case "seekable":
          this.#S = t.duration, this.#d?.setDuration(t.duration), this.#l("seekable", { duration: t.duration });
          break;
        case "reset":
          this.#p(), this.#d?.reset();
          break;
        case "scans":
          this.#D(t.scans);
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
          this.#E = t.audio, this.#l("audio", t.audio);
          break;
        case "private_stream_1":
        case "private_stream_2":
          this.#l(t.type, t.stream);
          break;
        case "mark":
          this.#v(t.name, t.at);
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
          this.#w(t.blocked ? "buffer-full" : "converting");
          break;
        case "finish":
          this.#B();
          break;
        case "completed":
          this.#w("completed"), this.#i === "worker" && this.#x();
          break;
        case "error":
          this.#L(new Error(t.message));
          break;
      }
  };
  /** Open a MediaSource here, for browsers that cannot have one in a worker. */
  #O(e, t) {
    const i = this.#e;
    let s;
    try {
      s = this.#d ?? this.#N(i);
    } catch (r) {
      this.#L(d(r));
      return;
    }
    s.open(e, t).then(
      // The worker is waiting on flow to know the open succeeded. Going
      // through ready() rather than saying true covers the case where the
      // append filled the queue on its own.
      () => s.ready().then(() => this.#G(i, { type: "flow", id: i, ready: !0 })),
      (r) => {
        i === this.#e && this.#L(d(r));
      }
    );
  }
  #N(e) {
    const t = new S({
      preferManaged: this.#t.preferManagedMediaSource,
      queueHighWaterMark: this.#t.queueHighWaterMark ?? 33554432,
      maxAheadSeconds: this.#t.maxAheadSeconds ?? 8,
      keepBehindSeconds: this.#t.keepBehindSeconds ?? 10,
      seek: (i) => {
        this.video.currentTime < i && (this.video.currentTime = i);
      },
      onMark: (i) => this.#v(i, o()),
      onReadyChange: (i) => this.#G(e, { type: "flow", id: e, ready: i }),
      onBlocked: (i) => {
        e === this.#e && this.#w(i ? "buffer-full" : "converting");
      },
      onError: (i) => {
        e === this.#e && this.#L(i);
      }
    });
    return this.#d = t, this.#h = URL.createObjectURL(t.mediaSource), t.managed ? this.#F(this.#h) : this.video.src = this.#h, this.#v("attached", o()), this.#S !== null && t.setDuration(this.#S), t;
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
  #F(e) {
    this.video.removeAttribute("src"), this.#T();
    const t = document.createElement("source");
    t.type = "video/mp4", t.src = e, this.video.append(t), this.#g = t, this.video.load();
  }
  /**
   * Rule out AirPlay, which a managed source cannot be sent over and which
   * Safari will not open one until the element has given up. The element
   * belongs to whoever made it, so it is put back on the way out -- unless it
   * was already off, and theirs to keep.
   */
  #T() {
    this.video.disableRemotePlayback || (this.video.disableRemotePlayback = !0, this.#r = !0);
  }
  #B() {
    const e = this.#e, t = this.#d;
    t && t.finish().then(
      () => {
        e === this.#e && this.#x();
      },
      (i) => {
        e === this.#e && this.#L(d(i));
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
  #W = () => {
    if (this.#S === null || this.#f === "idle" || this.#f === "error") return;
    const e = this.video.currentTime;
    this.#P(e) || (this.#w("seeking"), this.#p(), this.#$(), this.#s?.postMessage({
      type: "seek",
      id: this.#e,
      time: e
    }));
  };
  #m = (e) => {
    this.#f !== "idle" && (this.#v(e.type, o()), e.type === "waiting" && this.#_());
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
  #_() {
    if (this.video.seeking) return;
    const e = this.video.currentTime, t = this.video.buffered;
    let i = null;
    for (let s = 0; s < t.length; s++) {
      const r = t.start(s);
      if (e >= r - u && e < t.end(s) - u)
        return;
      r > e + u && (i === null || r < i) && (i = r);
    }
    i !== null && (this.video.currentTime = i);
  }
  /**
   * Report where a step of the load fell on the clock `load()` started.
   *
   * The worker's marks arrive as epoch milliseconds because that is the only
   * reading the two contexts share; what a caller wants is how long it waited,
   * which is measured from here.
   */
  #v(e, t) {
    if (this.#y === 0) return;
    const i = t - this.#y, s = Math.max(0, t - this.#c);
    this.#c = Math.max(this.#c, t), this.#l("timing", { name: e, sinceLoad: i, sincePrevious: s });
  }
  #P(e) {
    const t = this.video.buffered;
    for (let i = 0; i < t.length; i++)
      if (e >= t.start(i) && e < t.end(i))
        return !0;
    return !1;
  }
  /**
   * Tell whoever holds the buffer where playback is, so it can drop what is
   * behind. This cannot ride on `timeupdate`: that event stops firing exactly
   * when playback stalls, which is when eviction matters most.
   */
  #M = () => {
    const e = this.video.currentTime;
    this.#i === "main" ? this.#d?.setCurrentTime(e) : this.#s?.postMessage({
      type: "time",
      id: this.#e,
      currentTime: e
    });
  };
  #G(e, t) {
    e === this.#e && this.#s?.postMessage(t);
  }
  #$() {
    this.#u === null && (this.#u = setInterval(
      this.#M,
      200
    ));
  }
  #x() {
    this.#u !== null && (clearInterval(this.#u), this.#u = null);
  }
  #j() {
    this.#x(), this.#p(), this.#d?.close(), this.#d = null, this.#h && URL.revokeObjectURL(this.#h), this.#h = null, this.#g?.remove(), this.#g = null, this.#r && (this.video.disableRemotePlayback = !1, this.#r = !1), this.video.removeAttribute("src"), this.video.srcObject = null, this.video.load();
  }
  #L(e) {
    this.#j(), this.#w("error"), this.#C(e), this.#l("error", { error: e });
  }
  #C(e) {
    const t = this.#k;
    t && (this.#k = null, e ? t.reject(e) : t.resolve());
  }
  #w(e) {
    this.#f !== e && (this.#f = e, this.#l("statechange", { state: e }));
  }
  #l(e, t) {
    this.dispatchEvent(new CustomEvent(e, { detail: t }));
  }
}
export {
  M as DEFAULT_KEEP_BEHIND_SECONDS,
  b as DEFAULT_MAX_AHEAD_SECONDS,
  y as DEFAULT_QUEUE_HIGH_WATER_MARK,
  T as Mpeg2TsPlayer,
  _ as requiresManagedMediaSource,
  w as supportsManagedMediaSource,
  A as supportsPassthrough,
  f as supportsWorkerMediaSource
};
//# sourceMappingURL=index.js.map
