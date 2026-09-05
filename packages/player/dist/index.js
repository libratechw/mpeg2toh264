const b = 33554432;
const y = 8, M = 10;
const h = globalThis.ManagedMediaSource;
function u(n = !1) {
  const e = typeof MediaSource > "u" ? null : MediaSource;
  return n && h ? h : e ?? h ?? null;
}
function p(n, e = !1) {
  return u(e)?.isTypeSupported(n) ?? !1;
}
function m(n = !1) {
  return u(n)?.canConstructInDedicatedWorker === !0;
}
function w() {
  return h !== void 0;
}
function _() {
  return typeof MediaSource > "u" && h !== void 0;
}
class g {
  #e = !0;
  #i = [];
  get open() {
    return this.#e;
  }
  /** Returns whether this changed anything. */
  set(e) {
    return e === this.#e ? !1 : (this.#e = e, e && this.#s(), !0);
  }
  wait() {
    return this.#e ? Promise.resolve() : new Promise((e) => {
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
class E {
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
  #e;
  #i;
  #s;
  #t = null;
  /** What the `SourceBuffer` was opened with, or last changed to. */
  #f = "";
  /** A codec to move the `SourceBuffer` to before the next append. */
  #o = null;
  #n = [];
  #g = 0;
  #h = null;
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
  #S = !0;
  /** The last thing said about there being no room, so it is said once. */
  #E = !1;
  /** Whether everything buffered is waiting to be thrown away; see `reset`. */
  #a = !1;
  /** Which stretch of timeline is being filled. Bumped by every `reset`. */
  #k = 0;
  /** A duration to put on the MediaSource as soon as it will take one. */
  #b = null;
  /** Media times a decoder can start from, in order; see #evict. */
  #c = [];
  /** Whether the playhead has been put where the media starts; see #startAtMedia. */
  #r = !1;
  #y = 0;
  #d = !1;
  #A = !1;
  #R = new g();
  #D = [];
  constructor(e) {
    this.#i = e;
    const t = u(e.preferManaged);
    if (!t) throw new Error("this browser has no Media Source Extensions");
    this.#e = t, this.mediaSource = new t(), this.managed = t === h, this.managed && (this.mediaSource.addEventListener(
      "startstreaming",
      this.#H
    ), this.mediaSource.addEventListener("endstreaming", this.#B)), this.#s = new Promise((i) => {
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
    if (!this.#e.isTypeSupported(e))
      throw new Error(`unsupported codec: ${e}`);
    if (await this.#s, !this.#d) {
      if (this.#t)
        e !== this.#f && (this.#o = e);
      else {
        const i = this.mediaSource.addSourceBuffer(e);
        i.mode = "segments", i.addEventListener("updateend", this.#I), i.addEventListener("error", this.#O), this.#t = i, this.#f = e;
      }
      this.#U({ data: t, init: !0 }), this.#T();
    }
  }
  push(e, t, i) {
    this.#d || (i && this.#c.push(t), this.#U({ data: e, init: !1 }));
  }
  /**
   * How long the whole presentation is.
   *
   * Without this the media element has no timeline to offer a viewer: it is
   * what turns `seekable` into the length of the file rather than the length
   * of what has been converted so far.
   */
  setDuration(e) {
    this.#b = e, this.#T();
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
    this.#d || (this.#k++, this.#n = [], this.#g = 0, this.#c = [], this.#r = !1, this.#A = !1, this.#u = !1, this.#w(), this.#t && (this.#a = !0), this.#v(!0), this.#m(), this.#p());
  }
  async finish() {
    if (this.#A = !0, this.#d || !this.#t) return;
    const e = this.#k;
    await new Promise((t) => {
      this.#D.push(t), this.#p();
    }), !(this.#d || this.#k !== e) && this.mediaSource.readyState === "open" && this.mediaSource.endOfStream();
  }
  close() {
    this.#d || (this.#d = !0, this.managed && (this.mediaSource.removeEventListener(
      "startstreaming",
      this.#H
    ), this.mediaSource.removeEventListener(
      "endstreaming",
      this.#B
    )), this.#t?.removeEventListener("updateend", this.#I), this.#t?.removeEventListener("error", this.#O), this.#t = null, this.#n = [], this.#g = 0, this.#c = [], this.#R.abandon(), this.#v(!0));
  }
  /** Tell the sink where playback has got to, so it can evict what is behind. */
  setCurrentTime(e) {
    this.#y = e, this.#P(), this.#m(), this.#p();
  }
  #U(e) {
    this.#n.push(e), this.#g += e.data.byteLength, this.#m(), this.#p();
  }
  #p() {
    const e = this.#t;
    if (this.#d || !e || e.updating || this.#h)
      return;
    if (this.#a) {
      this.#h = { type: "clear" };
      try {
        e.remove(0, Number.POSITIVE_INFINITY);
      } catch (i) {
        this.#h = null, this.#a = !1, this.#_(i);
      }
      return;
    }
    if (this.#u) return;
    const t = this.#n[0];
    if (!t) {
      this.#v(!1);
      return;
    }
    if (this.#o !== null) {
      const i = this.#o;
      this.#o = null;
      try {
        e.changeType(i), this.#f = i;
      } catch (s) {
        this.#_(s);
        return;
      }
    }
    this.#h = { type: "append", pending: t, epoch: this.#k };
    try {
      e.appendBuffer(t.data);
    } catch (i) {
      this.#h = null, i instanceof DOMException && i.name === "QuotaExceededError" ? (this.#u = !0, this.#m(), this.#w(), this.#P()) : this.#_(i);
    }
  }
  #I = () => {
    const e = this.#h;
    if (e?.type === "append") {
      if (e.epoch === this.#k && this.#n[0] === e.pending) {
        const t = this.#n.shift();
        this.#g -= t.data.byteLength, t.init || this.#W();
      }
    } else e?.type === "remove" ? (this.#u = !1, this.#w()) : e?.type === "clear" && (this.#a = !1);
    this.#h = null, this.#T(), this.#P(), this.#m(), this.#p();
  };
  /**
   * The managed source asking for data again, which is the only thing that
   * reopens the door `endstreaming` closed.
   */
  #H = () => {
    this.#S = !0, this.#m(), this.#w();
  };
  /**
   * The managed source saying it has enough.
   *
   * What is already queued still goes in -- it was converted, and a few
   * fragments are cheaper to append than to convert again -- but nothing more
   * is taken until it asks. This is the whole point of the managed source: it
   * knows what the radio and the battery are doing and the page does not.
   */
  #B = () => {
    this.#S = !1, this.#m(), this.#w();
  };
  #O = () => {
    this.#_(new Error("the SourceBuffer rejected what was appended"));
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
  #W() {
    const e = this.#t?.buffered;
    this.#r || !e || e.length === 0 || (this.#r = !0, this.#i.onMark?.("appended"), this.#i.seek(e.start(0)));
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
    const e = this.#b;
    if (e === null || this.#d || this.mediaSource.readyState !== "open" || this.#h || this.#t?.updating) return;
    const t = this.#t?.buffered, i = t && t.length > 0 ? t.end(t.length - 1) : 0;
    this.#b = null;
    try {
      this.mediaSource.duration = Math.max(e, i);
    } catch (s) {
      this.#_(s);
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
  #P() {
    const e = this.#t;
    if (!this.#u || !e || e.updating || this.#h || this.#a || e.buffered.length === 0) return;
    const t = this.#y - this.#i.keepBehindSeconds;
    let i = 0;
    for (const r of this.#c) {
      if (r > t) break;
      i = r;
    }
    const s = i - 1e-3;
    if (!(s <= 0)) {
      for (; this.#c.length > 0 && this.#c[0] < i; )
        this.#c.shift();
      this.#h = { type: "remove" }, e.remove(0, s);
    }
  }
  /** How far past the playhead the buffer reaches, in seconds. */
  #N() {
    const e = this.#t?.buffered;
    return !e || e.length === 0 ? 0 : e.end(e.length - 1) - this.#y;
  }
  #m() {
    const e = !this.#u && this.#S && this.#N() < this.#i.maxAheadSeconds && this.#g < this.#i.queueHighWaterMark && this.#n.length < 2;
    this.#R.set(e) && this.#i.onReadyChange?.(e);
  }
  /**
   * Say whether conversion is waiting on the buffer, whichever of the two
   * reasons it is: no room left, or a managed source that wants nothing for
   * now. Both look the same from where the conversion sits.
   */
  #w() {
    const e = this.#u || !this.#S;
    e !== this.#E && (this.#E = e, this.#i.onBlocked?.(e));
  }
  /** Wake `finish`, either because everything is appended or because we gave up. */
  #v(e) {
    if (!e && (!this.#A || this.#n.length > 0 || this.#h))
      return;
    const t = this.#D;
    this.#D = [];
    for (const i of t) i();
  }
  #_(e) {
    this.#i.onError?.(
      e instanceof Error ? e : new Error(String(e))
    );
  }
}
const v = "" + new URL("assets/worker-De-0Qxsc.js", import.meta.url).href, S = v, d = 0.1, c = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "playing",
  "waiting"
];
function l(n = !1) {
  return m(n);
}
const k = 'video/mp4; codecs="mp4v.61"';
function A(n = !1) {
  return p(k, n);
}
function o(n) {
  return n instanceof Error ? n : new Error(String(n));
}
function a() {
  return performance.timeOrigin + performance.now();
}
class T extends EventTarget {
  video;
  #e;
  #i;
  #s = null;
  /** Which load messages belong to. Bumped by every load and every stop. */
  #t = 0;
  #f = "idle";
  /** The sink, when the page owns the MediaSource. */
  #o = null;
  #n = null;
  /** The `<source>` child a Managed Media Source needs; see #attachManaged. */
  #g = null;
  /** Whether remote playback was turned off here, and so is ours to turn back. */
  #h = !1;
  #u = null;
  #S = null;
  /** How long the input is, when it turned out to be one that can be seeked. */
  #E = null;
  /** Source video properties indexed by presentation time. */
  #a = [];
  /** What sound the programme last said it was carrying. See `AudioTracks`. */
  #k = null;
  /** When `load()` was called, as epoch milliseconds; every mark counts from it. */
  #b = 0;
  /** When the last mark was, so each one can say what it cost on its own. */
  #c = 0;
  /** Built the first time deinterlacing is turned on, and kept after that. */
  #r = null;
  /** Whether deinterlacing was asked for. */
  #y = !1;
  #d = !1;
  constructor(e, t = {}) {
    super(), this.video = e, this.#e = t;
    const i = t.mediaSource ?? "auto";
    this.#i = i === "auto" ? l(t.preferManagedMediaSource) ? "worker" : "main" : i, this.video.addEventListener("seeking", this.#N);
    for (const s of c)
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
    return this.#E;
  }
  /**
   * What sound the programme is carrying and which of it is being taken, or
   * null before its program map has been read. See `AudioTracks`.
   */
  get audio() {
    return this.#k;
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
      id: this.#t,
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
      id: this.#t,
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
    return this.#r?.running ?? !1;
  }
  /** Whether deinterlacing was asked for, whatever the source turned out to be. */
  get deinterlaceWanted() {
    return this.#y;
  }
  /**
   * The deinterlacer itself, once there has been one, for the settings that
   * are its own -- the field order, and whether a picture goes up per field
   * or per frame. Null until `deinterlace` has been turned on.
   */
  get deinterlacer() {
    return this.#r;
  }
  set deinterlace(e) {
    this.#y = e, this.#A();
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
    if (!this.#d)
      try {
        this.#y && !this.#r && this.#e.deinterlacer && (this.#r = this.#e.deinterlacer(this.video)), this.#r && (this.#r.videoTimeline = this.#a, this.#r.enabled = this.#y);
      } catch (e) {
        this.#l("error", { error: o(e) });
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
    this.#r && (this.#r.videoTimeline = this.#a);
  }
  #p() {
    this.#a = [], this.#r && (this.#r.videoTimeline = []);
  }
  load(e) {
    if (this.#d)
      return Promise.reject(new Error("the player has been destroyed"));
    if (this.#i === "worker" && !l(this.#e.preferManagedMediaSource))
      return Promise.reject(
        new Error("this browser cannot construct a MediaSource in a worker")
      );
    this.stop();
    const t = this.#t;
    this.#E = null, this.#p(), this.#A(), this.#b = a(), this.#c = this.#b;
    const i = this.#I(), s = new Promise((r, f) => {
      this.#S = { resolve: r, reject: f };
    });
    return this.#M("loading"), i.postMessage({
      type: "load",
      id: t,
      url: String(e),
      wasmUrl: this.#e.wasmUrl === void 0 ? null : String(this.#e.wasmUrl),
      oversample: this.#e.oversample,
      recoveryInterval: this.#e.recoveryInterval,
      openGopRecovery: this.#e.openGopRecovery,
      splitFieldSamples: this.#e.splitFieldSamples,
      passthrough: this.#e.passthrough ?? !1,
      pictureWorkers: this.#e.pictureWorkers,
      serviceId: this.#e.serviceId ?? null,
      sink: this.#i,
      preferManagedMediaSource: this.#e.preferManagedMediaSource ?? !1,
      queueHighWaterMark: this.#e.queueHighWaterMark ?? 33554432,
      maxAheadSeconds: this.#e.maxAheadSeconds ?? 8,
      keepBehindSeconds: this.#e.keepBehindSeconds ?? 10
    }), this.#G(), s;
  }
  /** Abandon the current load. The player stays usable. */
  stop() {
    const e = this.#t;
    this.#t++, this.#s?.postMessage({ type: "stop", id: e }), this.#j(), this.#x(new Error("the load was stopped")), this.#M("idle");
  }
  /** Stop, and give up the worker. The player cannot be loaded again. */
  destroy() {
    if (!this.#d) {
      this.stop(), this.#d = !0, this.video.removeEventListener("seeking", this.#N);
      for (const e of c)
        this.video.removeEventListener(e, this.#m);
      this.#r?.destroy(), this.#r = null, this.#s?.terminate(), this.#s = null;
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
        this.#e.workerUrl ?? S,
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
    if (t.id === this.#t)
      switch (t.type) {
        case "handle":
          t.managed && this.#T(), this.video.srcObject = t.handle, this.#v("attached", a());
          break;
        case "open":
          this.#B(t.mimeCodec, t.data);
          break;
        case "video-config":
          this.#R(
            t.width,
            t.height,
            t.start
          );
          break;
        case "fragment":
          this.#o?.push(
            t.data,
            t.start,
            t.randomAccess
          );
          break;
        case "opened":
          this.#M("converting"), this.#x(null);
          break;
        case "seekable":
          this.#E = t.duration, this.#o?.setDuration(t.duration), this.#l("seekable", { duration: t.duration });
          break;
        case "reset":
          this.#p(), this.#o?.reset();
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
          this.#k = t.audio, this.#l("audio", t.audio);
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
          this.#M(t.blocked ? "buffer-full" : "converting");
          break;
        case "finish":
          this.#P();
          break;
        case "completed":
          this.#M("completed"), this.#i === "worker" && this.#F();
          break;
        case "error":
          this.#L(new Error(t.message));
          break;
      }
  };
  /** Open a MediaSource here, for browsers that cannot have one in a worker. */
  #B(e, t) {
    const i = this.#t;
    let s;
    try {
      s = this.#o ?? this.#O(i);
    } catch (r) {
      this.#L(o(r));
      return;
    }
    s.open(e, t).then(
      // The worker is waiting on flow to know the open succeeded. Going
      // through ready() rather than saying true covers the case where the
      // append filled the queue on its own.
      () => s.ready().then(() => this.#C(i, { type: "flow", id: i, ready: !0 })),
      (r) => {
        i === this.#t && this.#L(o(r));
      }
    );
  }
  #O(e) {
    const t = new E({
      preferManaged: this.#e.preferManagedMediaSource,
      queueHighWaterMark: this.#e.queueHighWaterMark ?? 33554432,
      maxAheadSeconds: this.#e.maxAheadSeconds ?? 8,
      keepBehindSeconds: this.#e.keepBehindSeconds ?? 10,
      seek: (i) => {
        this.video.currentTime < i && (this.video.currentTime = i);
      },
      onMark: (i) => this.#v(i, a()),
      onReadyChange: (i) => this.#C(e, { type: "flow", id: e, ready: i }),
      onBlocked: (i) => {
        e === this.#t && this.#M(i ? "buffer-full" : "converting");
      },
      onError: (i) => {
        e === this.#t && this.#L(i);
      }
    });
    return this.#o = t, this.#n = URL.createObjectURL(t.mediaSource), t.managed ? this.#W(this.#n) : this.video.src = this.#n, this.#v("attached", a()), this.#E !== null && t.setDuration(this.#E), t;
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
  #W(e) {
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
    this.video.disableRemotePlayback || (this.video.disableRemotePlayback = !0, this.#h = !0);
  }
  #P() {
    const e = this.#t, t = this.#o;
    t && t.finish().then(
      () => {
        e === this.#t && this.#F();
      },
      (i) => {
        e === this.#t && this.#L(o(i));
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
  #N = () => {
    if (this.#E === null || this.#f === "idle" || this.#f === "error") return;
    const e = this.video.currentTime;
    this.#_(e) || (this.#M("seeking"), this.#p(), this.#G(), this.#s?.postMessage({
      type: "seek",
      id: this.#t,
      time: e
    }));
  };
  #m = (e) => {
    this.#f !== "idle" && (this.#v(e.type, a()), e.type === "waiting" && this.#w());
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
  #w() {
    if (this.video.seeking) return;
    const e = this.video.currentTime, t = this.video.buffered;
    let i = null;
    for (let s = 0; s < t.length; s++) {
      const r = t.start(s);
      if (e >= r - d && e < t.end(s) - d)
        return;
      r > e + d && (i === null || r < i) && (i = r);
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
    if (this.#b === 0) return;
    const i = t - this.#b, s = Math.max(0, t - this.#c);
    this.#c = Math.max(this.#c, t), this.#l("timing", { name: e, sinceLoad: i, sincePrevious: s });
  }
  #_(e) {
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
  #q = () => {
    const e = this.video.currentTime;
    this.#i === "main" ? this.#o?.setCurrentTime(e) : this.#s?.postMessage({
      type: "time",
      id: this.#t,
      currentTime: e
    });
  };
  #C(e, t) {
    e === this.#t && this.#s?.postMessage(t);
  }
  #G() {
    this.#u === null && (this.#u = setInterval(
      this.#q,
      200
    ));
  }
  #F() {
    this.#u !== null && (clearInterval(this.#u), this.#u = null);
  }
  #j() {
    this.#F(), this.#p(), this.#o?.close(), this.#o = null, this.#n && URL.revokeObjectURL(this.#n), this.#n = null, this.#g?.remove(), this.#g = null, this.#h && (this.video.disableRemotePlayback = !1, this.#h = !1), this.video.removeAttribute("src"), this.video.srcObject = null, this.video.load();
  }
  #L(e) {
    this.#j(), this.#M("error"), this.#x(e), this.#l("error", { error: e });
  }
  #x(e) {
    const t = this.#S;
    t && (this.#S = null, e ? t.reject(e) : t.resolve());
  }
  #M(e) {
    this.#f !== e && (this.#f = e, this.#l("statechange", { state: e }));
  }
  #l(e, t) {
    this.dispatchEvent(new CustomEvent(e, { detail: t }));
  }
}
export {
  M as DEFAULT_KEEP_BEHIND_SECONDS,
  y as DEFAULT_MAX_AHEAD_SECONDS,
  b as DEFAULT_QUEUE_HIGH_WATER_MARK,
  T as Mpeg2TsPlayer,
  _ as requiresManagedMediaSource,
  w as supportsManagedMediaSource,
  A as supportsPassthrough,
  l as supportsWorkerMediaSource
};
//# sourceMappingURL=index.js.map
