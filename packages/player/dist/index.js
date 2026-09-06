function a() {
  return performance.timeOrigin + performance.now();
}
const M = 48, A = 240, C = 51, T = /^m2h-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/, _ = /[^0-9a-z-]/, O = /^[A-Za-z0-9]/, j = /[^A-Za-z0-9_.:-]/, N = 64, D = 16, R = 64, P = 256;
function L(n) {
  return n === null || typeof n == "string" || typeof n == "boolean" || typeof n == "number" && Number.isFinite(n);
}
function $(n) {
  try {
    if (typeof n != "object" || n === null || Array.isArray(n))
      return null;
    const e = Object.entries(n);
    return e.length > D || !e.every(
      ([t, s]) => t.length > 0 && t.length <= R && L(s) && (typeof s != "string" || s.length <= P)
    ) ? null : Object.freeze(Object.fromEntries(e));
  } catch {
    return null;
  }
}
function z(n, e, t) {
  try {
    if (typeof n != "string" || n.length === 0 || n.length > N || !O.test(n) || j.test(n) || typeof t != "object" || t === null || Array.isArray(t))
      return null;
    const s = $(e);
    if (s === null) return null;
    const { at: i, critical: r } = t;
    return i !== void 0 && !Number.isFinite(i) || r !== void 0 && typeof r != "boolean" ? null : Object.freeze({
      event: n,
      detail: s,
      at: i,
      critical: r === !0
    });
  } catch {
    return null;
  }
}
function m(n) {
  if (typeof n != "object" || n === null || !Object.isFrozen(n))
    return !1;
  const e = n;
  return Number.isInteger(e.sequence) && Number.isFinite(e.at) && (e.scope === "main" || e.scope === "worker" || e.scope === "external") && typeof e.event == "string" && Number.isInteger(e.playerInstance) && Number.isInteger(e.generation) && Number.isInteger(e.videoId) && (e.mediaSourceOwner === "main" || e.mediaSourceOwner === "worker") && (e.mediaSourceClass === null || e.mediaSourceClass === "MediaSource" || e.mediaSourceClass === "ManagedMediaSource") && typeof e.detail == "object" && e.detail !== null && Object.isFrozen(e.detail) && Object.values(e.detail).every(L);
}
class I {
  #t;
  #d = 0;
  #s = [];
  #u = null;
  #e = /* @__PURE__ */ new Set();
  #i = 0;
  #c = null;
  constructor(e = M) {
    if (!Number.isInteger(e) || e < 1)
      throw new RangeError("lifecycle trace capacity must be an integer >= 1");
    this.#t = e;
  }
  record(e) {
    if (this.#c) return null;
    const t = Object.freeze({
      sequence: ++this.#d,
      at: e.at,
      scope: e.scope,
      event: e.event,
      playerInstance: e.playerInstance,
      generation: e.generation,
      videoId: e.videoId,
      mediaSourceOwner: e.mediaSourceOwner,
      mediaSourceClass: e.mediaSourceClass,
      detail: Object.freeze({ ...e.detail ?? {} })
    });
    e.critical === !0 && this.#e.add(t), e.critical === !0 && this.#u === null ? this.#u = t : this.#s.push(t);
    const s = this.#t - (this.#u === null ? 0 : 1);
    for (; this.#s.length > s; )
      this.#e.delete(this.#s.shift()), this.#i++;
    return this.#u === t ? t : null;
  }
  /** Return exactly the held entry to normal ring rotation once it resolves. */
  resolveCritical(e) {
    if (this.#c || this.#u !== e) return !1;
    const t = this.#s.findIndex(
      (r) => r.sequence > e.sequence
    );
    t === -1 ? this.#s.push(e) : this.#s.splice(t, 0, e), this.#e.delete(e), this.#u = null;
    const s = this.#s.find(
      (r) => this.#e.has(r)
    );
    s !== void 0 && (this.#s.splice(this.#s.indexOf(s), 1), this.#u = s);
    const i = this.#t - (this.#u === null ? 0 : 1);
    for (; this.#s.length > i; )
      this.#e.delete(this.#s.shift()), this.#i++;
    return !0;
  }
  freeze(e, t = a()) {
    if (this.#c) return this.#c;
    const s = [
      ...this.#u === null ? [] : [this.#u],
      ...this.#s
    ].sort(
      (i, r) => i.at - r.at || i.sequence - r.sequence
    );
    return this.#c = Object.freeze({
      eventId: e,
      frozenAt: t,
      dropped: this.#i,
      firstCritical: this.#u,
      entries: Object.freeze(s)
    }), this.#c;
  }
}
function g(n) {
  return n.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48);
}
function B(n, e) {
  const t = e.firstCritical?.event ?? "none", s = e.entries.at(-1)?.event ?? "none", r = `[${[
    `lifecycle=${e.eventId}`,
    `first=${g(t)}`,
    `last=${g(s)}`,
    `entries=${e.entries.length}`,
    `dropped=${e.dropped}`
  ].join(" ").slice(0, A - 2)}]`;
  return n.message = `${n.message}
${r}`, Object.defineProperties(n, {
    lifecycleEventId: {
      value: e.eventId,
      enumerable: !0
    },
    lifecycleTrace: {
      value: e,
      enumerable: !0
    }
  }), n;
}
function J(n) {
  try {
    if (typeof n != "object" || n === null) return !1;
    const e = n, t = e.lifecycleEventId, s = e.lifecycleTrace;
    return typeof t == "string" && t.length <= C && T.test(t) && !_.test(t) && s?.eventId === t && Number.isFinite(s.frozenAt) && Number.isInteger(s.dropped) && s.dropped >= 0 && Object.isFrozen(s) && Array.isArray(s.entries) && s.entries.length > 0 && s.entries.length <= M && Object.isFrozen(s.entries) && s.entries.every(m) && s.entries.every(
      (i, r) => r === 0 || i.at > s.entries[r - 1].at || i.at === s.entries[r - 1].at && i.sequence > s.entries[r - 1].sequence
    ) && (s.firstCritical === null || m(s.firstCritical) && s.entries.includes(s.firstCritical));
  } catch {
    return !1;
  }
}
const v = 32 * 1024 * 1024, F = 2, S = 8, y = 10, U = 200, x = 1e-3, c = globalThis.ManagedMediaSource;
function p(n = !1) {
  const e = typeof MediaSource > "u" ? null : MediaSource;
  return n && c ? c : e ?? c ?? null;
}
function q(n, e = !1) {
  return p(e)?.isTypeSupported(n) ?? !1;
}
function G(n = !1) {
  return p(n)?.canConstructInDedicatedWorker === !0;
}
function ee() {
  return c !== void 0;
}
function te() {
  return typeof MediaSource > "u" && c !== void 0;
}
class H {
  #t = !0;
  #d = [];
  get open() {
    return this.#t;
  }
  /** Returns whether this changed anything. */
  set(e) {
    return e === this.#t ? !1 : (this.#t = e, e && this.#s(), !0);
  }
  wait() {
    return this.#t ? Promise.resolve() : new Promise((e) => {
      this.#d.push(e);
    });
  }
  /** Let everyone through whatever the state is, for teardown. */
  abandon() {
    this.#s();
  }
  #s() {
    const e = this.#d;
    this.#d = [];
    for (const t of e) t();
  }
}
class W {
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
  #d;
  #s;
  #u;
  #e = null;
  /** What the `SourceBuffer` was opened with, or last changed to. */
  #i = "";
  /** A codec to move the `SourceBuffer` to before the next append. */
  #c = null;
  #h = [];
  #p = 0;
  #o = null;
  #l = !1;
  /**
   * Whether a managed source wants data at the moment.
   *
   * True until told otherwise, and always true for an unmanaged source, which
   * takes whatever it is given. A managed one starts out not streaming and
   * asks once it is attached and playing, so waiting for permission before the
   * initialization segment would mean waiting for a player that never starts:
   * this holds the door open until `endstreaming` closes it.
   */
  #g = !0;
  /** The last thing said about there being no room, so it is said once. */
  #w = !1;
  /** Whether everything buffered is waiting to be thrown away; see `reset`. */
  #S = !1;
  /** Which stretch of timeline is being filled. Bumped by every `reset`. */
  #f = 0;
  /** A duration to put on the MediaSource as soon as it will take one. */
  #m = null;
  /** Media times a decoder can start from, in order; see #evict. */
  #y = [];
  /** Whether the playhead has been put where the media starts; see #startAtMedia. */
  #M = !1;
  #L = 0;
  #r = !1;
  #b = !1;
  #I = 0;
  #P = 0;
  #C = null;
  #N = null;
  #$ = new H();
  #D = [];
  constructor(e) {
    this.#s = e;
    const t = p(e.preferManaged);
    if (!t) throw new Error("this browser has no Media Source Extensions");
    this.#t = t, this.mediaSource = new t(), this.managed = t === c, this.#d = this.managed ? "ManagedMediaSource" : "MediaSource", this.mediaSource.addEventListener("sourceopen", this.#F), this.mediaSource.addEventListener("sourceclose", this.#U), this.managed && (this.mediaSource.addEventListener(
      "startstreaming",
      this.#V
    ), this.mediaSource.addEventListener("endstreaming", this.#z)), this.#u = new Promise((s) => {
      this.mediaSource.addEventListener(
        "sourceopen",
        () => {
          e.onMark?.("sourceopen"), s();
        },
        { once: !0 }
      );
    }), this.#a("mse-created", {
      preferManaged: e.preferManaged === !0
    });
  }
  ready() {
    return this.#$.wait();
  }
  /**
   * Open the stream, or -- for the initialization segment a seek brings with
   * it -- re-open the one already running.
   */
  async open(e, t) {
    if (!this.#t.isTypeSupported(e))
      throw new Error(`unsupported codec: ${e}`);
    if (await this.#u, !this.#r) {
      if (this.#e)
        e !== this.#i && (this.#c = e);
      else try {
        this.#a("sourcebuffer-add-call", {
          mimeCodec: e
        });
        const s = this.mediaSource.addSourceBuffer(e);
        s.mode = "segments", s.addEventListener("updatestart", this.#H), s.addEventListener("update", this.#W), s.addEventListener("updateend", this.#G), s.addEventListener("abort", this.#Y), s.addEventListener("error", this.#B), this.#e = s, this.#i = e, this.#a("sourcebuffer-added", {
          mimeCodec: e
        });
      } catch (s) {
        throw this.#j("add or configure SourceBuffer", s);
      }
      this.#T({ data: t, init: !0 }), this.#x();
    }
  }
  push(e, t, s) {
    this.#r || (s && this.#y.push(t), this.#T({ data: e, init: !1 }));
  }
  /**
   * How long the whole presentation is.
   *
   * Without this the media element has no timeline to offer a viewer: it is
   * what turns `seekable` into the length of the file rather than the length
   * of what has been converted so far.
   */
  setDuration(e) {
    this.#m = e, this.#x();
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
    this.#r || (this.#a("mse-reset", {
      nextEpoch: this.#f + 1
    }), this.#f++, this.#h = [], this.#p = 0, this.#y = [], this.#M = !1, this.#b = !1, this.#l = !1, this.#O(), this.#e && (this.#S = !0), this.#q(!0), this.#n(), this.#_());
  }
  async finish() {
    if (this.#a("mse-finish"), this.#b = !0, this.#r || !this.#e) return;
    const e = this.#f;
    if (await new Promise((t) => {
      this.#D.push(t), this.#_();
    }), !(this.#r || this.#f !== e) && this.mediaSource.readyState === "open")
      try {
        this.#a("mediasource-end-of-stream-call"), this.mediaSource.endOfStream();
      } catch (t) {
        throw this.#j("end MediaSource", t);
      }
  }
  close(e = "close") {
    this.#r || (this.#a("mse-close", { reason: e }), this.#r = !0, this.mediaSource.removeEventListener("sourceopen", this.#F), this.mediaSource.removeEventListener("sourceclose", this.#U), this.managed && (this.mediaSource.removeEventListener(
      "startstreaming",
      this.#V
    ), this.mediaSource.removeEventListener(
      "endstreaming",
      this.#z
    )), this.#e?.removeEventListener("updatestart", this.#H), this.#e?.removeEventListener("update", this.#W), this.#e?.removeEventListener("updateend", this.#G), this.#e?.removeEventListener("abort", this.#Y), this.#e?.removeEventListener("error", this.#B), this.#e = null, this.#h = [], this.#p = 0, this.#y = [], this.#$.abandon(), this.#q(!0));
  }
  /** Tell the sink where playback has got to, so it can evict what is behind. */
  setCurrentTime(e) {
    this.#L = e, this.#E(), this.#n(), this.#_();
  }
  #T(e) {
    this.#h.push(e), this.#p += e.data.byteLength, this.#n(), this.#_();
  }
  #_() {
    const e = this.#e;
    if (this.#r || !e || e.updating || this.#o)
      return;
    if (this.#S) {
      this.#o = { type: "clear" };
      try {
        this.#a("sourcebuffer-clear-call"), e.remove(0, Number.POSITIVE_INFINITY);
      } catch (s) {
        this.#o = null, this.#S = !1, this.#k("clear SourceBuffer", s);
      }
      return;
    }
    if (this.#l) return;
    const t = this.#h[0];
    if (!t) {
      this.#q(!1);
      return;
    }
    if (this.#c !== null) {
      const s = this.#c;
      this.#c = null;
      try {
        this.#a("sourcebuffer-change-type-call", { mimeCodec: s }), e.changeType(s), this.#i = s;
      } catch (i) {
        this.#k("change SourceBuffer type", i);
        return;
      }
    }
    this.#o = { type: "append", pending: t, epoch: this.#f };
    try {
      this.#a("sourcebuffer-append-call", {
        appendBytes: t.data.byteLength,
        initSegment: t.init
      }), e.appendBuffer(t.data);
    } catch (s) {
      this.#o = null, s instanceof DOMException && s.name === "QuotaExceededError" ? (this.#l = !0, this.#a("sourcebuffer-quota-exceeded", {
        appendBytes: t.data.byteLength
      }), this.#n(), this.#O(), this.#E()) : this.#k("append SourceBuffer", s);
    }
  }
  #G = () => {
    const e = this.#o;
    if (this.#a("sourcebuffer-updateend"), e?.type === "append") {
      if (e.epoch === this.#f && this.#h[0] === e.pending) {
        const t = this.#h.shift();
        this.#p -= t.data.byteLength, t.init || this.#X();
      }
    } else e?.type === "remove" ? (this.#l = !1, this.#O()) : e?.type === "clear" && (this.#S = !1);
    this.#o = null, this.#x(), this.#E(), this.#n(), this.#_();
  };
  #H = () => {
    this.#a("sourcebuffer-updatestart");
  };
  #W = () => {
    this.#a("sourcebuffer-update");
  };
  /**
   * The managed source asking for data again, which is the only thing that
   * reopens the door `endstreaming` closed.
   */
  #V = () => {
    const e = this.#g;
    this.#g = !0, this.#a("mediasource-startstreaming", { previousStreaming: e }), this.#n(), this.#O();
  };
  /**
   * The managed source saying it has enough.
   *
   * What is already queued still goes in -- it was converted, and a few
   * fragments are cheaper to append than to convert again -- but nothing more
   * is taken until it asks. This is the whole point of the managed source: it
   * knows what the radio and the battery are doing and the page does not.
   */
  #z = () => {
    const e = this.#g;
    this.#g = !1, this.#a("mediasource-endstreaming", { previousStreaming: e }), this.#n(), this.#O();
  };
  #Y = () => {
    this.#a("sourcebuffer-abort", {}, !0);
  };
  #B = () => {
    this.#a("sourcebuffer-error", {}, !0), this.#k(
      "complete SourceBuffer update",
      new Error("the SourceBuffer rejected what was appended")
    );
  };
  #F = () => {
    this.#I++, this.#C = a(), this.#a(
      "mediasource-sourceopen",
      {},
      !1,
      this.#C
    );
  };
  #U = () => {
    this.#P++, this.#N = a(), this.#a(
      "mediasource-sourceclose",
      {},
      !this.#r,
      this.#N
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
  #X() {
    const e = this.#e?.buffered;
    this.#M || !e || e.length === 0 || (this.#M = !0, this.#s.onMark?.("appended"), this.#s.seek(e.start(0)));
  }
  /**
   * Put the length of the file on the MediaSource, once it will take one.
   *
   * The setter only exists while the stream is open and nothing is updating,
   * so this runs again after every operation until it finds its moment. A
   * duration shorter than what is already buffered would evict the difference,
   * so what is buffered wins: it is the file speaking for itself.
   */
  #x() {
    const e = this.#m;
    if (e === null || this.#r || this.mediaSource.readyState !== "open" || this.#o || this.#e?.updating) return;
    const t = this.#e?.buffered, s = t && t.length > 0 ? t.end(t.length - 1) : 0;
    this.#m = null;
    try {
      const i = Math.max(e, s);
      this.#a("mediasource-set-duration-call", { appliedDuration: i }), this.mediaSource.duration = i;
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
  #E() {
    const e = this.#e;
    if (!this.#l || !e || e.updating || this.#o || this.#S || e.buffered.length === 0) return;
    const t = this.#L - this.#s.keepBehindSeconds;
    let s = 0;
    for (const r of this.#y) {
      if (r > t) break;
      s = r;
    }
    const i = s - x;
    if (!(i <= 0)) {
      for (; this.#y.length > 0 && this.#y[0] < s; )
        this.#y.shift();
      this.#o = { type: "remove" };
      try {
        this.#a("sourcebuffer-remove-call", { removeEnd: i }), e.remove(0, i);
      } catch (r) {
        this.#o = null, this.#k("evict SourceBuffer range", r);
      }
    }
  }
  /** How far past the playhead the buffer reaches, in seconds. */
  #K() {
    const e = this.#e?.buffered;
    return !e || e.length === 0 ? 0 : e.end(e.length - 1) - this.#L;
  }
  #n() {
    const e = !this.#l && this.#g && this.#K() < this.#s.maxAheadSeconds && this.#p < this.#s.queueHighWaterMark && this.#h.length < F;
    this.#$.set(e) && this.#s.onReadyChange?.(e);
  }
  /**
   * Say whether conversion is waiting on the buffer, whichever of the two
   * reasons it is: no room left, or a managed source that wants nothing for
   * now. Both look the same from where the conversion sits.
   */
  #O() {
    const e = this.#l || !this.#g;
    e !== this.#w && (this.#w = e, this.#s.onBlocked?.(e));
  }
  /** Wake `finish`, either because everything is appended or because we gave up. */
  #q(e) {
    if (!e && (!this.#b || this.#h.length > 0 || this.#o))
      return;
    const t = this.#D;
    this.#D = [];
    for (const s of t) s();
  }
  #Q() {
    const e = this.#o;
    return {
      mediaSourceReadyState: this.mediaSource.readyState,
      sinkClosed: this.#r,
      sourceOpenCount: this.#I,
      sourceCloseCount: this.#P,
      sourceBufferPresent: this.#e !== null,
      sourceBufferUpdating: this.#e?.updating ?? !1,
      operation: e?.type ?? "none",
      operationEpoch: e?.type === "append" ? e.epoch : null,
      queueLength: this.#h.length,
      queuedBytes: this.#p,
      epoch: this.#f,
      streaming: this.#g,
      clearing: this.#S,
      quotaBlocked: this.#l,
      ending: this.#b
    };
  }
  #a(e, t = {}, s = !1, i = a()) {
    const r = Object.freeze({
      at: i,
      event: e,
      mediaSourceClass: this.#d,
      detail: Object.freeze({ ...this.#Q(), ...t }),
      critical: s
    });
    try {
      this.#s.onLifecycle?.(r);
    } catch {
    }
  }
  #j(e, t) {
    const s = t instanceof Error ? t : new Error(String(t)), i = this.#e, r = a();
    this.#a(
      "mse-error",
      {
        failedOperation: e,
        errorName: s.name
      },
      !0,
      r
    );
    const o = [
      `mediaSource=${this.mediaSource.readyState}`,
      `closed=${this.#r}`,
      `sourceOpens=${this.#I}`,
      `sourceCloses=${this.#P}`,
      `sinceSourceOpenMs=${this.#C === null ? "none" : Math.round(r - this.#C)}`,
      `sinceSourceCloseMs=${this.#N === null ? "none" : Math.round(r - this.#N)}`,
      `sourceBuffer=${i ? "present" : "absent"}`,
      `updating=${i?.updating ?? !1}`,
      `operation=${this.#o?.type ?? "none"}`,
      `queue=${this.#h.length}`,
      `epoch=${this.#f}`
    ].join(", "), h = new Error(
      `MSE ${e} failed (${o}): ${s.name}: ${s.message}`
    );
    return h.name = s.name, h.stack += `
Caused by: ${s.stack ?? s.message}`, h;
  }
  #k(e, t) {
    this.#s.onError?.(this.#j(e, t));
  }
}
const V = "" + new URL("assets/worker-Cy2uYoRF.js", import.meta.url).href, Y = V, l = 0.1, b = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "playing",
  "waiting"
], E = [
  "loadstart",
  "emptied",
  "abort",
  "error"
];
let X = 0, K = 0;
const k = /* @__PURE__ */ new WeakMap();
let u = new I();
const f = /* @__PURE__ */ new WeakMap();
function Q(n) {
  const e = k.get(n);
  if (e !== void 0) return e;
  const t = ++K;
  return k.set(n, t), t;
}
function w(n = !1) {
  return G(n);
}
const Z = 'video/mp4; codecs="mp4v.61"';
function se(n = !1) {
  return q(Z, n);
}
function d(n) {
  return n instanceof Error ? n : new Error(String(n));
}
class ie extends EventTarget {
  video;
  #t;
  #d;
  #s = ++X;
  #u;
  #e = null;
  /** Which load messages belong to. Bumped by every load and every stop. */
  #i = 0;
  #c = "idle";
  /** The sink, when the page owns the MediaSource. */
  #h = null;
  #p = null;
  #o = null;
  /** The `<source>` child a Managed Media Source needs; see #attachManaged. */
  #l = null;
  /** Whether remote playback was turned off here, and so is ours to turn back. */
  #g = !1;
  #w = null;
  #S = null;
  /** How long the input is, when it turned out to be one that can be seeked. */
  #f = null;
  /** Source video properties indexed by presentation time. */
  #m = [];
  /** What sound the programme last said it was carrying. See `AudioTracks`. */
  #y = null;
  /** When `load()` was called, as epoch milliseconds; every mark counts from it. */
  #M = 0;
  /** When the last mark was, so each one can say what it cost on its own. */
  #L = 0;
  /** Built the first time deinterlacing is turned on, and kept after that. */
  #r = null;
  /** Whether deinterlacing was asked for. */
  #b = !1;
  #I = !1;
  #P = 0;
  constructor(e, t = {}) {
    super(), this.video = e, this.#u = Q(e), this.#t = t;
    const s = t.mediaSource ?? "auto";
    this.#d = s === "auto" ? w(t.preferManagedMediaSource) ? "worker" : "main" : s, this.video.addEventListener("seeking", this.#B);
    for (const i of b)
      this.video.addEventListener(i, this.#F);
    for (const i of E)
      this.video.addEventListener(i, this.#U);
    this.#n("player-created", {
      requestedMediaSource: s
    }), t.deinterlace && (this.deinterlace = !0);
  }
  get state() {
    return this.#c;
  }
  /**
   * How long the input is, or null while it is a stream that plays as it
   * arrives. The same number reaches the media element as its duration.
   */
  get duration() {
    return this.#f;
  }
  /**
   * What sound the programme is carrying and which of it is being taken, or
   * null before its program map has been read. See `AudioTracks`.
   */
  get audio() {
    return this.#y;
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
    this.#e?.postMessage({
      type: "audio",
      id: this.#i,
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
    this.#e?.postMessage({
      type: "audio",
      id: this.#i,
      pid: null,
      dualMonoSub: e
    });
  }
  /** Which side of the wire ended up owning the MediaSource. */
  get mediaSourceOwner() {
    return this.#d;
  }
  /** The constructor actually opened for this load, once MSE exists. */
  get mediaSourceClass() {
    return this.#o;
  }
  /**
   * Add a page-owner event to the diagnostic chronology.
   *
   * `at` must use `performance.timeOrigin + performance.now()` so it can be
   * ordered beside worker events. Details are primitives by contract, which
   * keeps the fatal snapshot cloneable and serializable. A malformed event,
   * timestamp, detail, or options object is ignored without affecting playback.
   */
  recordDiagnosticLifecycle(e, t = {}, s = {}) {
    try {
      const i = z(e, t, s);
      if (i === null) return null;
      const r = u, o = this.#n(i.event, i.detail, {
        at: i.at,
        critical: i.critical,
        scope: "external"
      });
      if (o === null) return null;
      const h = Object.freeze({});
      return f.set(h, { journal: r, entry: o }), h;
    } catch {
      return null;
    }
  }
  /**
   * Release one integration-owned critical entry after its causal operation
   * succeeds. Only the opaque token returned for that exact entry can do so.
   */
  resolveDiagnosticLifecycle(e) {
    try {
      const t = f.get(e);
      if (t === void 0) return;
      f.delete(e), t.journal.resolveCritical(t.entry);
    } catch {
    }
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
    return this.#b;
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
    this.#b = e, this.#C();
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
  #C() {
    if (!this.#I)
      try {
        this.#b && !this.#r && this.#t.deinterlacer && (this.#r = this.#t.deinterlacer(this.video)), this.#r && (this.#r.videoTimeline = this.#m, this.#r.enabled = this.#b);
      } catch (e) {
        this.#v("error", { error: d(e) });
      }
  }
  #N(e, t, s) {
    e <= 0 || t <= 0 || this.#D({ start: s, codedSize: { width: e, height: t } });
  }
  /** Add source metadata now, but apply it only when its picture is shown. */
  #$(e) {
    for (const { start: t, interlaced: s, topFieldFirst: i } of e)
      this.#D({
        start: t,
        scan: { interlaced: s, topFieldFirst: i }
      });
  }
  #D(e) {
    const t = this.#m.at(-1), s = {
      start: e.start,
      codedSize: e.codedSize ?? t?.codedSize,
      scan: e.scan ?? t?.scan
    };
    if (t?.start === s.start) this.#m.pop();
    else if (t?.codedSize?.width === s.codedSize?.width && t?.codedSize?.height === s.codedSize?.height && t?.scan?.interlaced === s.scan?.interlaced && t?.scan?.topFieldFirst === s.scan?.topFieldFirst)
      return;
    if (this.#m.push(s), this.video.buffered.length > 0) {
      const i = this.video.buffered.start(0);
      let r = 0;
      for (; r + 1 < this.#m.length && this.#m[r + 1].start <= i; )
        r++;
      r > 0 && this.#m.splice(0, r);
    }
    this.#r && (this.#r.videoTimeline = this.#m);
  }
  #T() {
    this.#m = [], this.#r && (this.#r.videoTimeline = []);
  }
  load(e) {
    if (this.#I)
      return Promise.reject(new Error("the player has been destroyed"));
    if (this.#d === "worker" && !w(this.#t.preferManagedMediaSource))
      return Promise.reject(
        new Error("this browser cannot construct a MediaSource in a worker")
      );
    this.stop();
    const t = this.#i;
    this.#o = null, this.#n("player-load", {
      passthrough: this.#t.passthrough === !0
    }), this.#f = null, this.#T(), this.#C(), this.#M = a(), this.#L = this.#M;
    const s = this.#_(), i = new Promise((r, o) => {
      this.#S = { resolve: r, reject: o };
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
      sink: this.#d,
      preferManagedMediaSource: this.#t.preferManagedMediaSource ?? !1,
      queueHighWaterMark: this.#t.queueHighWaterMark ?? v,
      maxAheadSeconds: this.#t.maxAheadSeconds ?? S,
      keepBehindSeconds: this.#t.keepBehindSeconds ?? y
    }), this.#a(), i;
  }
  /** Abandon the current load. The player stays usable. */
  stop() {
    const e = this.#i;
    this.#n("player-stop", { stoppedGeneration: e }), this.#i++, this.#e?.postMessage({ type: "stop", id: e }), this.#k("stop", e), this.#Z(new Error("the load was stopped")), this.#A("idle");
  }
  /** Stop, and give up the worker. The player cannot be loaded again. */
  destroy() {
    if (!this.#I) {
      this.stop(), this.#I = !0, this.video.removeEventListener("seeking", this.#B);
      for (const e of b)
        this.video.removeEventListener(e, this.#F);
      for (const e of E)
        this.video.removeEventListener(e, this.#U);
      this.#r?.destroy(), this.#r = null, this.#e && (this.#n("worker-terminate-call", { reason: "destroy" }), this.#e.terminate()), this.#e = null;
    }
  }
  addEventListener(e, t, s) {
    super.addEventListener(e, t, s);
  }
  removeEventListener(e, t, s) {
    super.removeEventListener(e, t, s);
  }
  #_() {
    if (!this.#e) {
      const e = new Worker(
        this.#t.workerUrl ?? Y,
        {
          type: "module"
        }
      );
      e.onmessage = this.#G, e.onerror = (t) => {
        const s = a();
        this.#n(
          "worker-onerror",
          {
            messagePresent: t.message.length > 0,
            line: t.lineno,
            column: t.colno
          },
          { at: s, critical: !0 }
        ), this.#R(new Error(t.message || "the worker failed"));
      }, this.#e = e, this.#n("worker-created");
    }
    return this.#e;
  }
  #G = (e) => {
    const t = e.data;
    if (t.id === this.#i)
      switch (t.type) {
        case "handle":
          t.managed && this.#z(), this.#o = t.managed ? "ManagedMediaSource" : "MediaSource", this.#n("video-source-attach-call", {
            attachment: "srcObject",
            reason: "worker-media-source-handle"
          }), this.video.srcObject = t.handle, this.#E("attached", a());
          break;
        case "open":
          this.#H(t.mimeCodec, t.data);
          break;
        case "video-config":
          this.#N(
            t.width,
            t.height,
            t.start
          );
          break;
        case "fragment":
          this.#h?.push(
            t.data,
            t.start,
            t.randomAccess
          );
          break;
        case "opened":
          this.#A("converting"), this.#Z(null);
          break;
        case "seekable":
          this.#f = t.duration, this.#h?.setDuration(t.duration), this.#v("seekable", { duration: t.duration });
          break;
        case "reset":
          this.#T(), this.#h?.reset();
          break;
        case "scans":
          this.#$(t.scans);
          break;
        case "workers":
          this.#v("workers", {
            pictureWorkers: t.pictureWorkers
          });
          break;
        case "services":
          this.#v("services", t.services);
          break;
        case "audio":
          this.#y = t.audio, this.#v("audio", t.audio);
          break;
        case "private_stream_1":
        case "private_stream_2":
          this.#v(t.type, t.stream);
          break;
        case "mark":
          this.#E(t.name, t.at);
          break;
        case "lifecycle":
          this.#K(t.trace, "worker");
          break;
        case "seek":
          this.video.currentTime < t.time && (this.video.currentTime = t.time);
          break;
        case "progress":
          this.#v("progress", {
            bytesRead: t.bytesRead,
            totalBytes: t.totalBytes
          });
          break;
        case "stats":
          this.#v("stats", t.stats);
          break;
        case "blocked":
          this.#A(t.blocked ? "buffer-full" : "converting");
          break;
        case "finish":
          this.#Y();
          break;
        case "completed":
          this.#A("completed"), this.#d === "worker" && this.#j();
          break;
        case "error":
          this.#n(
            "worker-error",
            { messagePresent: t.message.length > 0 },
            { at: t.at, critical: !0, scope: "worker" }
          ), this.#R(new Error(t.message));
          break;
      }
  };
  /** Open a MediaSource here, for browsers that cannot have one in a worker. */
  #H(e, t) {
    const s = this.#i;
    let i;
    try {
      i = this.#h ?? this.#W(s);
    } catch (r) {
      this.#R(d(r));
      return;
    }
    i.open(e, t).then(
      // The worker is waiting on flow to know the open succeeded. Going
      // through ready() rather than saying true covers the case where the
      // append filled the queue on its own.
      () => i.ready().then(() => this.#Q(s, { type: "flow", id: s, ready: !0 })),
      (r) => {
        s === this.#i && this.#R(this.#J(d(r)));
      }
    );
  }
  #W(e) {
    const t = new W({
      preferManaged: this.#t.preferManagedMediaSource,
      queueHighWaterMark: this.#t.queueHighWaterMark ?? v,
      maxAheadSeconds: this.#t.maxAheadSeconds ?? S,
      keepBehindSeconds: this.#t.keepBehindSeconds ?? y,
      seek: (s) => {
        this.video.currentTime < s && (this.video.currentTime = s);
      },
      onMark: (s) => this.#E(s, a()),
      onLifecycle: (s) => this.#K(s, "main", e),
      onReadyChange: (s) => this.#Q(e, { type: "flow", id: e, ready: s }),
      onBlocked: (s) => {
        e === this.#i && this.#A(s ? "buffer-full" : "converting");
      },
      onError: (s) => {
        e === this.#i && this.#R(this.#J(s));
      }
    });
    return this.#h = t, this.#p = URL.createObjectURL(t.mediaSource), this.#n(
      "object-url-created",
      { reason: "main-media-source" },
      { generation: e }
    ), t.managed ? this.#V(this.#p) : (this.#n(
      "video-source-attach-call",
      { attachment: "src", reason: "main-media-source" },
      { generation: e }
    ), this.video.src = this.#p), this.#E("attached", a()), this.#f !== null && t.setDuration(this.#f), t;
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
  #V(e) {
    this.#n("video-source-detach-call", {
      attachment: "src",
      hadAttachment: this.video.hasAttribute("src"),
      reason: "managed-media-source-attach"
    }), this.video.removeAttribute("src"), this.#z();
    const t = document.createElement("source");
    t.type = "video/mp4", t.src = e, this.#n("source-element-attach-call", {
      reason: "managed-media-source-attach"
    }), this.video.append(t), this.#l = t, this.#n("video-load-call", {
      reason: "managed-media-source-attach"
    }), this.video.load();
  }
  /**
   * Rule out AirPlay, which a managed source cannot be sent over and which
   * Safari will not open one until the element has given up. The element
   * belongs to whoever made it, so it is put back on the way out -- unless it
   * was already off, and theirs to keep.
   */
  #z() {
    this.video.disableRemotePlayback || (this.video.disableRemotePlayback = !0, this.#g = !0);
  }
  #Y() {
    const e = this.#i, t = this.#h;
    t && t.finish().then(
      () => {
        e === this.#i && this.#j();
      },
      (s) => {
        e === this.#i && this.#R(d(s));
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
  #B = () => {
    if (this.#f === null || this.#c === "idle" || this.#c === "error") return;
    const e = this.video.currentTime;
    this.#O(e) || (this.#A("seeking"), this.#T(), this.#a(), this.#e?.postMessage({
      type: "seek",
      id: this.#i,
      time: e
    }));
  };
  #F = (e) => {
    this.#c !== "idle" && (this.#E(e.type, a()), e.type === "waiting" && this.#x());
  };
  #U = (e) => {
    this.#n(
      `video-${e.type}`,
      this.#X(e.currentTarget === this.video),
      { critical: e.type === "error" && this.video.error !== null }
    );
  };
  #X(e) {
    return {
      mediaErrorCode: this.video.error?.code ?? null,
      readyState: this.video.readyState,
      networkState: this.video.networkState,
      currentVideo: e,
      videoConnected: this.video.isConnected,
      videoPaused: this.video.paused,
      srcAttributePresent: this.video.hasAttribute("src"),
      srcObjectPresent: this.video.srcObject !== null,
      sourceElementPresent: this.#l !== null
    };
  }
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
  #x() {
    if (this.video.seeking) return;
    const e = this.video.currentTime, t = this.video.buffered;
    let s = null;
    for (let i = 0; i < t.length; i++) {
      const r = t.start(i);
      if (e >= r - l && e < t.end(i) - l)
        return;
      r > e + l && (s === null || r < s) && (s = r);
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
  #E(e, t) {
    if (this.#M === 0) return;
    const s = t - this.#M, i = Math.max(0, t - this.#L);
    this.#L = Math.max(this.#L, t), this.#v("timing", { name: e, sinceLoad: s, sincePrevious: i });
  }
  #K(e, t, s = this.#i) {
    this.#o = e.mediaSourceClass, this.#n(e.event, e.detail, {
      at: e.at,
      critical: e.critical,
      scope: t,
      generation: s
    });
  }
  #n(e, t = {}, s = {}) {
    return u.record({
      at: s.at ?? a(),
      scope: s.scope ?? "main",
      event: e,
      playerInstance: this.#s,
      generation: s.generation ?? this.#i,
      videoId: this.#u,
      mediaSourceOwner: this.#d,
      mediaSourceClass: this.#o,
      detail: t,
      critical: s.critical
    });
  }
  #O(e) {
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
  #q = () => {
    const e = this.video.currentTime;
    this.#d === "main" ? this.#h?.setCurrentTime(e) : this.#e?.postMessage({
      type: "time",
      id: this.#i,
      currentTime: e
    });
  };
  #Q(e, t) {
    e === this.#i && this.#e?.postMessage(t);
  }
  #a() {
    this.#w === null && (this.#w = setInterval(
      this.#q,
      U
    ));
  }
  #j() {
    this.#w !== null && (clearInterval(this.#w), this.#w = null);
  }
  #k(e, t = this.#i) {
    const s = (i, r) => this.#n(i, r, { generation: t });
    s("player-teardown", { reason: e }), this.#j(), this.#T(), this.#h?.close(e), this.#h = null, this.#p && (s("object-url-revoke-call", { reason: e }), URL.revokeObjectURL(this.#p)), this.#p = null, this.#l && (s("source-element-detach-call", { reason: e }), this.#l.remove()), this.#l = null, this.#g && (this.video.disableRemotePlayback = !1, this.#g = !1), s("video-source-detach-call", {
      attachment: "src",
      hadAttachment: this.video.hasAttribute("src"),
      reason: e
    }), this.video.removeAttribute("src"), s("video-source-detach-call", {
      attachment: "srcObject",
      hadAttachment: this.video.srcObject !== null,
      reason: e
    }), this.video.srcObject = null, s("video-load-call", { reason: e }), this.video.load(), this.#o = null;
  }
  #R(e) {
    const t = a();
    this.#n(
      "player-fail",
      { ...this.#X(!0), errorName: e.name },
      { at: t, critical: !0 }
    );
    const s = [
      "m2h",
      Math.trunc(t * 1e3).toString(36),
      this.#s.toString(36),
      this.#i.toString(36),
      (++this.#P).toString(36)
    ].join("-"), i = u.freeze(s, t);
    u = new I();
    const r = B(e, i);
    this.#k("fail"), this.#A("error"), this.#Z(r), this.#v("error", { error: r });
  }
  #J(e) {
    const t = this.#l, s = this.#p, i = [
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
  #Z(e) {
    const t = this.#S;
    t && (this.#S = null, e ? t.reject(e) : t.resolve());
  }
  #A(e) {
    this.#c !== e && (this.#c = e, this.#v("statechange", { state: e }));
  }
  #v(e, t) {
    this.dispatchEvent(new CustomEvent(e, { detail: t }));
  }
}
export {
  y as DEFAULT_KEEP_BEHIND_SECONDS,
  S as DEFAULT_MAX_AHEAD_SECONDS,
  v as DEFAULT_QUEUE_HIGH_WATER_MARK,
  C as LIFECYCLE_EVENT_ID_MAX_LENGTH,
  M as LIFECYCLE_TRACE_CAPACITY,
  ie as Mpeg2TsPlayer,
  J as isLifecycleError,
  a as lifecycleNow,
  te as requiresManagedMediaSource,
  ee as supportsManagedMediaSource,
  se as supportsPassthrough,
  w as supportsWorkerMediaSource
};
//# sourceMappingURL=index.js.map
