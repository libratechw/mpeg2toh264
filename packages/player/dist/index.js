function o() {
  return performance.timeOrigin + performance.now();
}
const T = 48, O = 240, j = 51, N = /^m2h-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/, D = /[^0-9a-z-]/, P = 32, $ = 24, R = 8, B = /^[A-Za-z0-9]/, z = /[^A-Za-z0-9_.:-]/, F = 64, x = 16, U = 64, G = 256;
function C(s) {
  return s === null || typeof s == "string" || typeof s == "boolean" || typeof s == "number" && Number.isFinite(s);
}
function q(s) {
  try {
    if (typeof s != "object" || s === null || Array.isArray(s))
      return null;
    const e = Object.entries(s);
    return e.length > x || !e.every(
      ([t, i]) => t.length > 0 && t.length <= U && C(i) && (typeof i != "string" || i.length <= G)
    ) ? null : Object.freeze(Object.fromEntries(e));
  } catch {
    return null;
  }
}
function V(s, e, t) {
  try {
    if (typeof s != "string" || s.length === 0 || s.length > F || !B.test(s) || z.test(s) || typeof t != "object" || t === null || Array.isArray(t))
      return null;
    const i = q(e);
    if (i === null) return null;
    const { at: r, critical: n } = t;
    return r !== void 0 && !Number.isFinite(r) || n !== void 0 && typeof n != "boolean" ? null : Object.freeze({
      event: s,
      detail: i,
      at: r,
      critical: n === !0
    });
  } catch {
    return null;
  }
}
function y(s) {
  if (typeof s != "object" || s === null || !Object.isFrozen(s))
    return !1;
  const e = s;
  return Number.isInteger(e.sequence) && Number.isFinite(e.at) && (e.scope === "main" || e.scope === "worker" || e.scope === "external") && typeof e.event == "string" && Number.isInteger(e.playerInstance) && Number.isInteger(e.generation) && Number.isInteger(e.videoId) && (e.mediaSourceOwner === "main" || e.mediaSourceOwner === "worker") && (e.mediaSourceClass === null || e.mediaSourceClass === "MediaSource" || e.mediaSourceClass === "ManagedMediaSource") && typeof e.detail == "object" && e.detail !== null && Object.isFrozen(e.detail) && Object.values(e.detail).every(C);
}
class _ {
  #t;
  #l = 0;
  #i = [];
  #u = null;
  #e = /* @__PURE__ */ new Set();
  #s = 0;
  #h = null;
  constructor(e = T) {
    if (!Number.isInteger(e) || e < 1)
      throw new RangeError("lifecycle trace capacity must be an integer >= 1");
    this.#t = e;
  }
  record(e) {
    if (this.#h) return null;
    const t = Object.freeze({
      sequence: ++this.#l,
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
    e.critical === !0 && this.#e.add(t), e.critical === !0 && this.#u === null ? this.#u = t : this.#i.push(t);
    const i = this.#t - (this.#u === null ? 0 : 1);
    for (; this.#i.length > i; )
      this.#e.delete(this.#i.shift()), this.#s++;
    return this.#u === t ? t : null;
  }
  /** Return exactly the held entry to normal ring rotation once it resolves. */
  resolveCritical(e) {
    if (this.#h || this.#u !== e) return !1;
    const t = this.#i.findIndex(
      (n) => n.sequence > e.sequence
    );
    t === -1 ? this.#i.push(e) : this.#i.splice(t, 0, e), this.#e.delete(e), this.#u = null;
    const i = this.#i.find(
      (n) => this.#e.has(n)
    );
    i !== void 0 && (this.#i.splice(this.#i.indexOf(i), 1), this.#u = i);
    const r = this.#t - (this.#u === null ? 0 : 1);
    for (; this.#i.length > r; )
      this.#e.delete(this.#i.shift()), this.#s++;
    return !0;
  }
  freeze(e, t = o()) {
    if (this.#h) return this.#h;
    const i = [
      ...this.#u === null ? [] : [this.#u],
      ...this.#i
    ].sort(
      (r, n) => r.at - n.at || r.sequence - n.sequence
    );
    return this.#h = Object.freeze({
      eventId: e,
      frozenAt: t,
      dropped: this.#s,
      firstCritical: this.#u,
      entries: Object.freeze(i)
    }), this.#h;
  }
}
function S(s, e = P) {
  return s.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, e);
}
function H(s) {
  return S(
    s.replace(/^mediasource-/, "ms.").replace(/^sourcebuffer-/, "sb.").replace(/^dplayer-/, "dp.").replace(/^player-/, "p.").replace(/^worker-/, "w.").replace(/^video-/, "v.").replace(/^object-url-/, "url.").replace(/^source-element-/, "source."),
    $
  );
}
function W(s) {
  const e = s.firstCritical?.event ?? "none", t = s.entries.at(-1)?.event ?? "none", i = [
    `lifecycle=${s.eventId}`,
    `first=${S(e)}`,
    `last=${S(t)}`,
    `entries=${s.entries.length}`,
    `dropped=${s.dropped}`
  ].join(" "), r = O - 2 - i.length - 6;
  let n = [];
  for (let a = s.entries.length - 1; a >= 0 && n.length < R; a--) {
    const c = [
      H(s.entries[a].event),
      ...n
    ];
    if (c.join(">").length > r) break;
    n = c;
  }
  return `[${i}${n.length === 0 ? "" : ` tail=${n.join(">")}`}]`;
}
function d(s, e, t) {
  try {
    const i = s[e];
    return typeof i == "string" ? i : t;
  } catch {
    return t;
  }
}
function f(s, e, t) {
  const i = Object.getOwnPropertyDescriptor(s, e);
  return i === void 0 ? Object.isExtensible(s) : i.configurable ? !0 : "writable" in i && i.writable === !0 && (t === void 0 || i.enumerable === t);
}
function X(s) {
  try {
    return f(s, "message") && f(s, "lifecycleEventId", !0) && f(s, "lifecycleTrace", !0);
  } catch {
    return !1;
  }
}
function p(s, e, t, i) {
  const r = Object.getOwnPropertyDescriptor(s, e);
  if (r !== void 0 && !r.configurable) {
    Object.defineProperty(s, e, { value: t });
    return;
  }
  Object.defineProperty(s, e, {
    value: t,
    writable: e === "message",
    enumerable: i,
    configurable: e === "message"
  });
}
function b(s, e, t) {
  return p(s, "message", e, !1), p(s, "lifecycleEventId", t.eventId, !0), p(s, "lifecycleTrace", t, !0), s;
}
function Y(s, e) {
  const t = W(e), r = `${d(
    s,
    "message",
    "the original error message was unavailable"
  )}
${t}`;
  if (X(s))
    try {
      return b(s, r, e);
    } catch {
    }
  const n = new Error(r, { cause: s });
  n.name = d(s, "name", "Error");
  const a = d(s, "stack", null);
  return a !== null && (n.stack = `${n.name}: ${n.message}
Caused by original error:
${a}`), b(n, r, e);
}
function he(s) {
  try {
    if (typeof s != "object" || s === null) return !1;
    const e = s, t = e.lifecycleEventId, i = e.lifecycleTrace;
    return typeof e.name == "string" && typeof e.message == "string" && typeof t == "string" && t.length <= j && N.test(t) && !D.test(t) && i?.eventId === t && Number.isFinite(i.frozenAt) && Number.isInteger(i.dropped) && i.dropped >= 0 && Object.isFrozen(i) && Array.isArray(i.entries) && i.entries.length > 0 && i.entries.length <= T && Object.isFrozen(i.entries) && i.entries.every(y) && i.entries.every(
      (r, n) => n === 0 || r.at > i.entries[n - 1].at || r.at === i.entries[n - 1].at && r.sequence > i.entries[n - 1].sequence
    ) && (i.firstCritical === null || y(i.firstCritical) && i.entries.includes(i.firstCritical));
  } catch {
    return !1;
  }
}
const E = 32 * 1024 * 1024, K = 2, k = 8, w = 10, Q = 200, Z = 1e-3, h = globalThis.ManagedMediaSource;
function v(s = !1) {
  const e = typeof MediaSource > "u" ? null : MediaSource;
  return s && h ? h : e ?? h ?? null;
}
function J(s, e = !1) {
  return v(e)?.isTypeSupported(s) ?? !1;
}
function ee(s = !1) {
  return v(s)?.canConstructInDedicatedWorker === !0;
}
function ue() {
  return h !== void 0;
}
function le() {
  return typeof MediaSource > "u" && h !== void 0;
}
class te {
  #t = !0;
  #l = [];
  get open() {
    return this.#t;
  }
  /** Returns whether this changed anything. */
  set(e) {
    return e === this.#t ? !1 : (this.#t = e, e && this.#i(), !0);
  }
  wait() {
    return this.#t ? Promise.resolve() : new Promise((e) => {
      this.#l.push(e);
    });
  }
  /** Let everyone through whatever the state is, for teardown. */
  abandon() {
    this.#i();
  }
  #i() {
    const e = this.#l;
    this.#l = [];
    for (const t of e) t();
  }
}
class ie {
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
  #l;
  #i;
  #u;
  #e = null;
  /** What the `SourceBuffer` was opened with, or last changed to. */
  #s = "";
  /** A codec to move the `SourceBuffer` to before the next append. */
  #h = null;
  #c = [];
  #p = 0;
  #o = null;
  #d = !1;
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
  #v = !1;
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
  #A = 0;
  #$ = 0;
  #T = null;
  #N = null;
  #R = new te();
  #D = [];
  constructor(e) {
    this.#i = e;
    const t = v(e.preferManaged);
    if (!t) throw new Error("this browser has no Media Source Extensions");
    this.#t = t, this.mediaSource = new t(), this.managed = t === h, this.#l = this.managed ? "ManagedMediaSource" : "MediaSource", this.mediaSource.addEventListener("sourceopen", this.#F), this.mediaSource.addEventListener("sourceclose", this.#x), this.managed && (this.mediaSource.addEventListener(
      "startstreaming",
      this.#W
    ), this.mediaSource.addEventListener("endstreaming", this.#B)), this.#u = new Promise((i) => {
      this.mediaSource.addEventListener(
        "sourceopen",
        () => {
          e.onMark?.("sourceopen"), i();
        },
        { once: !0 }
      );
    }), this.#a("mse-created", {
      preferManaged: e.preferManaged === !0
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
    if (await this.#u, !this.#r) {
      if (this.#e)
        e !== this.#s && (this.#h = e);
      else try {
        this.#a("sourcebuffer-add-call", {
          mimeCodec: e
        });
        const i = this.mediaSource.addSourceBuffer(e);
        i.mode = "segments", i.addEventListener("updatestart", this.#V), i.addEventListener("update", this.#H), i.addEventListener("updateend", this.#q), i.addEventListener("abort", this.#X), i.addEventListener("error", this.#z), this.#e = i, this.#s = e, this.#a("sourcebuffer-added", {
          mimeCodec: e
        });
      } catch (i) {
        throw this.#j("add or configure SourceBuffer", i);
      }
      this.#C({ data: t, init: !0 }), this.#U();
    }
  }
  push(e, t, i) {
    this.#r || (i && this.#y.push(t), this.#C({ data: e, init: !1 }));
  }
  /**
   * How long the whole presentation is.
   *
   * Without this the media element has no timeline to offer a viewer: it is
   * what turns `seekable` into the length of the file rather than the length
   * of what has been converted so far.
   */
  setDuration(e) {
    this.#m = e, this.#U();
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
    }), this.#f++, this.#c = [], this.#p = 0, this.#y = [], this.#M = !1, this.#b = !1, this.#d = !1, this.#O(), this.#e && (this.#v = !0), this.#G(!0), this.#n(), this.#_());
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
    this.#r || (this.#a("mse-close", { reason: e }), this.#r = !0, this.mediaSource.removeEventListener("sourceopen", this.#F), this.mediaSource.removeEventListener("sourceclose", this.#x), this.managed && (this.mediaSource.removeEventListener(
      "startstreaming",
      this.#W
    ), this.mediaSource.removeEventListener(
      "endstreaming",
      this.#B
    )), this.#e?.removeEventListener("updatestart", this.#V), this.#e?.removeEventListener("update", this.#H), this.#e?.removeEventListener("updateend", this.#q), this.#e?.removeEventListener("abort", this.#X), this.#e?.removeEventListener("error", this.#z), this.#e = null, this.#c = [], this.#p = 0, this.#y = [], this.#R.abandon(), this.#G(!0));
  }
  /** Tell the sink where playback has got to, so it can evict what is behind. */
  setCurrentTime(e) {
    this.#L = e, this.#E(), this.#n(), this.#_();
  }
  #C(e) {
    this.#c.push(e), this.#p += e.data.byteLength, this.#n(), this.#_();
  }
  #_() {
    const e = this.#e;
    if (this.#r || !e || e.updating || this.#o)
      return;
    if (this.#v) {
      this.#o = { type: "clear" };
      try {
        this.#a("sourcebuffer-clear-call"), e.remove(0, Number.POSITIVE_INFINITY);
      } catch (i) {
        this.#o = null, this.#v = !1, this.#k("clear SourceBuffer", i);
      }
      return;
    }
    if (this.#d) return;
    const t = this.#c[0];
    if (!t) {
      this.#G(!1);
      return;
    }
    if (this.#h !== null) {
      const i = this.#h;
      this.#h = null;
      try {
        this.#a("sourcebuffer-change-type-call", { mimeCodec: i }), e.changeType(i), this.#s = i;
      } catch (r) {
        this.#k("change SourceBuffer type", r);
        return;
      }
    }
    this.#o = { type: "append", pending: t, epoch: this.#f };
    try {
      this.#a("sourcebuffer-append-call", {
        appendBytes: t.data.byteLength,
        initSegment: t.init
      }), e.appendBuffer(t.data);
    } catch (i) {
      this.#o = null, i instanceof DOMException && i.name === "QuotaExceededError" ? (this.#d = !0, this.#a("sourcebuffer-quota-exceeded", {
        appendBytes: t.data.byteLength
      }), this.#n(), this.#O(), this.#E()) : this.#k("append SourceBuffer", i);
    }
  }
  #q = () => {
    const e = this.#o;
    if (this.#a("sourcebuffer-updateend"), e?.type === "append") {
      if (e.epoch === this.#f && this.#c[0] === e.pending) {
        const t = this.#c.shift();
        this.#p -= t.data.byteLength, t.init || this.#Y();
      }
    } else e?.type === "remove" ? (this.#d = !1, this.#O()) : e?.type === "clear" && (this.#v = !1);
    this.#o = null, this.#U(), this.#E(), this.#n(), this.#_();
  };
  #V = () => {
    this.#a("sourcebuffer-updatestart");
  };
  #H = () => {
    this.#a("sourcebuffer-update");
  };
  /**
   * The managed source asking for data again, which is the only thing that
   * reopens the door `endstreaming` closed.
   */
  #W = () => {
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
  #B = () => {
    const e = this.#g;
    this.#g = !1, this.#a("mediasource-endstreaming", { previousStreaming: e }), this.#n(), this.#O();
  };
  #X = () => {
    this.#a("sourcebuffer-abort", {}, !0);
  };
  #z = () => {
    this.#a("sourcebuffer-error", {}, !0), this.#k(
      "complete SourceBuffer update",
      new Error("the SourceBuffer rejected what was appended")
    );
  };
  #F = () => {
    this.#A++, this.#T = o(), this.#a(
      "mediasource-sourceopen",
      {},
      !1,
      this.#T
    );
  };
  #x = () => {
    this.#$++, this.#N = o(), this.#a(
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
  #Y() {
    const e = this.#e?.buffered;
    this.#M || !e || e.length === 0 || (this.#M = !0, this.#i.onMark?.("appended"), this.#i.seek(e.start(0)));
  }
  /**
   * Put the length of the file on the MediaSource, once it will take one.
   *
   * The setter only exists while the stream is open and nothing is updating,
   * so this runs again after every operation until it finds its moment. A
   * duration shorter than what is already buffered would evict the difference,
   * so what is buffered wins: it is the file speaking for itself.
   */
  #U() {
    const e = this.#m;
    if (e === null || this.#r || this.mediaSource.readyState !== "open" || this.#o || this.#e?.updating) return;
    const t = this.#e?.buffered, i = t && t.length > 0 ? t.end(t.length - 1) : 0;
    this.#m = null;
    try {
      const r = Math.max(e, i);
      this.#a("mediasource-set-duration-call", { appliedDuration: r }), this.mediaSource.duration = r;
    } catch (r) {
      this.#k("set MediaSource duration", r);
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
    if (!this.#d || !e || e.updating || this.#o || this.#v || e.buffered.length === 0) return;
    const t = this.#L - this.#i.keepBehindSeconds;
    let i = 0;
    for (const n of this.#y) {
      if (n > t) break;
      i = n;
    }
    const r = i - Z;
    if (!(r <= 0)) {
      for (; this.#y.length > 0 && this.#y[0] < i; )
        this.#y.shift();
      this.#o = { type: "remove" };
      try {
        this.#a("sourcebuffer-remove-call", { removeEnd: r }), e.remove(0, r);
      } catch (n) {
        this.#o = null, this.#k("evict SourceBuffer range", n);
      }
    }
  }
  /** How far past the playhead the buffer reaches, in seconds. */
  #K() {
    const e = this.#e?.buffered;
    return !e || e.length === 0 ? 0 : e.end(e.length - 1) - this.#L;
  }
  #n() {
    const e = !this.#d && this.#g && this.#K() < this.#i.maxAheadSeconds && this.#p < this.#i.queueHighWaterMark && this.#c.length < K;
    this.#R.set(e) && this.#i.onReadyChange?.(e);
  }
  /**
   * Say whether conversion is waiting on the buffer, whichever of the two
   * reasons it is: no room left, or a managed source that wants nothing for
   * now. Both look the same from where the conversion sits.
   */
  #O() {
    const e = this.#d || !this.#g;
    e !== this.#w && (this.#w = e, this.#i.onBlocked?.(e));
  }
  /** Wake `finish`, either because everything is appended or because we gave up. */
  #G(e) {
    if (!e && (!this.#b || this.#c.length > 0 || this.#o))
      return;
    const t = this.#D;
    this.#D = [];
    for (const i of t) i();
  }
  #Q() {
    const e = this.#o;
    return {
      mediaSourceReadyState: this.mediaSource.readyState,
      sinkClosed: this.#r,
      sourceOpenCount: this.#A,
      sourceCloseCount: this.#$,
      sourceBufferPresent: this.#e !== null,
      sourceBufferUpdating: this.#e?.updating ?? !1,
      operation: e?.type ?? "none",
      operationEpoch: e?.type === "append" ? e.epoch : null,
      queueLength: this.#c.length,
      queuedBytes: this.#p,
      epoch: this.#f,
      streaming: this.#g,
      clearing: this.#v,
      quotaBlocked: this.#d,
      ending: this.#b
    };
  }
  #a(e, t = {}, i = !1, r = o()) {
    const n = Object.freeze({
      at: r,
      event: e,
      mediaSourceClass: this.#l,
      detail: Object.freeze({ ...this.#Q(), ...t }),
      critical: i
    });
    try {
      this.#i.onLifecycle?.(n);
    } catch {
    }
  }
  #j(e, t) {
    const i = t instanceof Error ? t : new Error(String(t)), r = this.#e, n = o();
    this.#a(
      "mse-error",
      {
        failedOperation: e,
        errorName: i.name
      },
      !0,
      n
    );
    const a = [
      `mediaSource=${this.mediaSource.readyState}`,
      `closed=${this.#r}`,
      `sourceOpens=${this.#A}`,
      `sourceCloses=${this.#$}`,
      `sinceSourceOpenMs=${this.#T === null ? "none" : Math.round(n - this.#T)}`,
      `sinceSourceCloseMs=${this.#N === null ? "none" : Math.round(n - this.#N)}`,
      `sourceBuffer=${r ? "present" : "absent"}`,
      `updating=${r?.updating ?? !1}`,
      `operation=${this.#o?.type ?? "none"}`,
      `queue=${this.#c.length}`,
      `epoch=${this.#f}`
    ].join(", "), c = new Error(
      `MSE ${e} failed (${a}): ${i.name}: ${i.message}`
    );
    return c.name = i.name, c.stack += `
Caused by: ${i.stack ?? i.message}`, c;
  }
  #k(e, t) {
    this.#i.onError?.(this.#j(e, t));
  }
}
const se = "" + new URL("assets/worker-Cy2uYoRF.js", import.meta.url).href, re = se, m = 0.1, M = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "playing",
  "waiting"
], L = [
  "loadstart",
  "emptied",
  "abort",
  "error"
];
let ne = 0, ae = 0;
const A = /* @__PURE__ */ new WeakMap();
let u = new _();
const g = /* @__PURE__ */ new WeakMap();
function oe(s) {
  const e = A.get(s);
  if (e !== void 0) return e;
  const t = ++ae;
  return A.set(s, t), t;
}
function I(s = !1) {
  return ee(s);
}
const ce = 'video/mp4; codecs="mp4v.61"';
function de(s = !1) {
  return J(ce, s);
}
function l(s) {
  return s instanceof Error ? s : new Error(String(s));
}
class fe extends EventTarget {
  video;
  #t;
  #l;
  #i = ++ne;
  #u;
  #e = null;
  /** Which load messages belong to. Bumped by every load and every stop. */
  #s = 0;
  #h = "idle";
  /** The sink, when the page owns the MediaSource. */
  #c = null;
  #p = null;
  #o = null;
  /** The `<source>` child a Managed Media Source needs; see #attachManaged. */
  #d = null;
  /** Whether remote playback was turned off here, and so is ours to turn back. */
  #g = !1;
  #w = null;
  #v = null;
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
  #A = !1;
  #$ = 0;
  constructor(e, t = {}) {
    super(), this.video = e, this.#u = oe(e), this.#t = t;
    const i = t.mediaSource ?? "auto";
    this.#l = i === "auto" ? I(t.preferManagedMediaSource) ? "worker" : "main" : i, this.video.addEventListener("seeking", this.#z);
    for (const r of M)
      this.video.addEventListener(r, this.#F);
    for (const r of L)
      this.video.addEventListener(r, this.#x);
    this.#n("player-created", {
      requestedMediaSource: i
    }), t.deinterlace && (this.deinterlace = !0);
  }
  get state() {
    return this.#h;
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
      id: this.#s,
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
      id: this.#s,
      pid: null,
      dualMonoSub: e
    });
  }
  /** Which side of the wire ended up owning the MediaSource. */
  get mediaSourceOwner() {
    return this.#l;
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
  recordDiagnosticLifecycle(e, t = {}, i = {}) {
    try {
      const r = V(e, t, i);
      if (r === null) return null;
      const n = u, a = this.#n(r.event, r.detail, {
        at: r.at,
        critical: r.critical,
        scope: "external"
      });
      if (a === null) return null;
      const c = Object.freeze({});
      return g.set(c, { journal: n, entry: a }), c;
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
      const t = g.get(e);
      if (t === void 0) return;
      g.delete(e), t.journal.resolveCritical(t.entry);
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
    this.#b = e, this.#T();
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
  #T() {
    if (!this.#A)
      try {
        this.#b && !this.#r && this.#t.deinterlacer && (this.#r = this.#t.deinterlacer(this.video)), this.#r && (this.#r.videoTimeline = this.#m, this.#r.enabled = this.#b);
      } catch (e) {
        this.#S("error", { error: l(e) });
      }
  }
  #N(e, t, i) {
    e <= 0 || t <= 0 || this.#D({ start: i, codedSize: { width: e, height: t } });
  }
  /** Add source metadata now, but apply it only when its picture is shown. */
  #R(e) {
    for (const { start: t, interlaced: i, topFieldFirst: r } of e)
      this.#D({
        start: t,
        scan: { interlaced: i, topFieldFirst: r }
      });
  }
  #D(e) {
    const t = this.#m.at(-1), i = {
      start: e.start,
      codedSize: e.codedSize ?? t?.codedSize,
      scan: e.scan ?? t?.scan
    };
    if (t?.start === i.start) this.#m.pop();
    else if (t?.codedSize?.width === i.codedSize?.width && t?.codedSize?.height === i.codedSize?.height && t?.scan?.interlaced === i.scan?.interlaced && t?.scan?.topFieldFirst === i.scan?.topFieldFirst)
      return;
    if (this.#m.push(i), this.video.buffered.length > 0) {
      const r = this.video.buffered.start(0);
      let n = 0;
      for (; n + 1 < this.#m.length && this.#m[n + 1].start <= r; )
        n++;
      n > 0 && this.#m.splice(0, n);
    }
    this.#r && (this.#r.videoTimeline = this.#m);
  }
  #C() {
    this.#m = [], this.#r && (this.#r.videoTimeline = []);
  }
  load(e) {
    if (this.#A)
      return Promise.reject(new Error("the player has been destroyed"));
    if (this.#l === "worker" && !I(this.#t.preferManagedMediaSource))
      return Promise.reject(
        new Error("this browser cannot construct a MediaSource in a worker")
      );
    this.stop();
    const t = this.#s;
    this.#o = null, this.#n("player-load", {
      passthrough: this.#t.passthrough === !0
    }), this.#f = null, this.#C(), this.#T(), this.#M = o(), this.#L = this.#M;
    const i = this.#_(), r = new Promise((n, a) => {
      this.#v = { resolve: n, reject: a };
    });
    return this.#I("loading"), i.postMessage({
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
      sink: this.#l,
      preferManagedMediaSource: this.#t.preferManagedMediaSource ?? !1,
      queueHighWaterMark: this.#t.queueHighWaterMark ?? E,
      maxAheadSeconds: this.#t.maxAheadSeconds ?? k,
      keepBehindSeconds: this.#t.keepBehindSeconds ?? w
    }), this.#a(), r;
  }
  /** Abandon the current load. The player stays usable. */
  stop() {
    const e = this.#s;
    this.#n("player-stop", { stoppedGeneration: e }), this.#s++, this.#e?.postMessage({ type: "stop", id: e }), this.#k("stop", e), this.#Z(new Error("the load was stopped")), this.#I("idle");
  }
  /** Stop, and give up the worker. The player cannot be loaded again. */
  destroy() {
    if (!this.#A) {
      this.stop(), this.#A = !0, this.video.removeEventListener("seeking", this.#z);
      for (const e of M)
        this.video.removeEventListener(e, this.#F);
      for (const e of L)
        this.video.removeEventListener(e, this.#x);
      this.#r?.destroy(), this.#r = null, this.#e && (this.#n("worker-terminate-call", { reason: "destroy" }), this.#e.terminate()), this.#e = null;
    }
  }
  addEventListener(e, t, i) {
    super.addEventListener(e, t, i);
  }
  removeEventListener(e, t, i) {
    super.removeEventListener(e, t, i);
  }
  #_() {
    if (!this.#e) {
      const e = new Worker(
        this.#t.workerUrl ?? re,
        {
          type: "module"
        }
      );
      e.onmessage = this.#q, e.onerror = (t) => {
        const i = o();
        this.#n(
          "worker-onerror",
          {
            messagePresent: t.message.length > 0,
            line: t.lineno,
            column: t.colno
          },
          { at: i, critical: !0 }
        ), this.#P(new Error(t.message || "the worker failed"));
      }, this.#e = e, this.#n("worker-created");
    }
    return this.#e;
  }
  #q = (e) => {
    const t = e.data;
    if (t.type === "lifecycle") {
      this.#K(t.trace, "worker", t.id);
      return;
    }
    if (t.id === this.#s)
      switch (t.type) {
        case "handle":
          t.managed && this.#B(), this.#o = t.managed ? "ManagedMediaSource" : "MediaSource", this.#n("video-source-attach-call", {
            attachment: "srcObject",
            reason: "worker-media-source-handle"
          }), this.video.srcObject = t.handle, this.#E("attached", o());
          break;
        case "open":
          this.#V(t.mimeCodec, t.data);
          break;
        case "video-config":
          this.#N(
            t.width,
            t.height,
            t.start
          );
          break;
        case "fragment":
          this.#c?.push(
            t.data,
            t.start,
            t.randomAccess
          );
          break;
        case "opened":
          this.#I("converting"), this.#Z(null);
          break;
        case "seekable":
          this.#f = t.duration, this.#c?.setDuration(t.duration), this.#S("seekable", { duration: t.duration });
          break;
        case "reset":
          this.#C(), this.#c?.reset();
          break;
        case "scans":
          this.#R(t.scans);
          break;
        case "workers":
          this.#S("workers", {
            pictureWorkers: t.pictureWorkers
          });
          break;
        case "services":
          this.#S("services", t.services);
          break;
        case "audio":
          this.#y = t.audio, this.#S("audio", t.audio);
          break;
        case "private_stream_1":
        case "private_stream_2":
          this.#S(t.type, t.stream);
          break;
        case "mark":
          this.#E(t.name, t.at);
          break;
        case "seek":
          this.video.currentTime < t.time && (this.video.currentTime = t.time);
          break;
        case "progress":
          this.#S("progress", {
            bytesRead: t.bytesRead,
            totalBytes: t.totalBytes
          });
          break;
        case "stats":
          this.#S("stats", t.stats);
          break;
        case "blocked":
          this.#I(t.blocked ? "buffer-full" : "converting");
          break;
        case "finish":
          this.#X();
          break;
        case "completed":
          this.#I("completed"), this.#l === "worker" && this.#j();
          break;
        case "error":
          this.#n(
            "worker-error",
            { messagePresent: t.message.length > 0 },
            { at: t.at, critical: !0, scope: "worker" }
          ), this.#P(new Error(t.message));
          break;
      }
  };
  /** Open a MediaSource here, for browsers that cannot have one in a worker. */
  #V(e, t) {
    const i = this.#s;
    let r;
    try {
      r = this.#c ?? this.#H(i);
    } catch (n) {
      this.#P(l(n));
      return;
    }
    r.open(e, t).then(
      // The worker is waiting on flow to know the open succeeded. Going
      // through ready() rather than saying true covers the case where the
      // append filled the queue on its own.
      () => r.ready().then(() => this.#Q(i, { type: "flow", id: i, ready: !0 })),
      (n) => {
        i === this.#s && this.#P(this.#J(l(n)));
      }
    );
  }
  #H(e) {
    const t = new ie({
      preferManaged: this.#t.preferManagedMediaSource,
      queueHighWaterMark: this.#t.queueHighWaterMark ?? E,
      maxAheadSeconds: this.#t.maxAheadSeconds ?? k,
      keepBehindSeconds: this.#t.keepBehindSeconds ?? w,
      seek: (i) => {
        this.video.currentTime < i && (this.video.currentTime = i);
      },
      onMark: (i) => this.#E(i, o()),
      onLifecycle: (i) => this.#K(i, "main", e),
      onReadyChange: (i) => this.#Q(e, { type: "flow", id: e, ready: i }),
      onBlocked: (i) => {
        e === this.#s && this.#I(i ? "buffer-full" : "converting");
      },
      onError: (i) => {
        e === this.#s && this.#P(this.#J(i));
      }
    });
    return this.#c = t, this.#p = URL.createObjectURL(t.mediaSource), this.#n(
      "object-url-created",
      { reason: "main-media-source" },
      { generation: e }
    ), t.managed ? this.#W(this.#p) : (this.#n(
      "video-source-attach-call",
      { attachment: "src", reason: "main-media-source" },
      { generation: e }
    ), this.video.src = this.#p), this.#E("attached", o()), this.#f !== null && t.setDuration(this.#f), t;
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
    this.#n("video-source-detach-call", {
      attachment: "src",
      hadAttachment: this.video.hasAttribute("src"),
      reason: "managed-media-source-attach"
    }), this.video.removeAttribute("src"), this.#B();
    const t = document.createElement("source");
    t.type = "video/mp4", t.src = e, this.#n("source-element-attach-call", {
      reason: "managed-media-source-attach"
    }), this.video.append(t), this.#d = t, this.#n("video-load-call", {
      reason: "managed-media-source-attach"
    }), this.video.load();
  }
  /**
   * Rule out AirPlay, which a managed source cannot be sent over and which
   * Safari will not open one until the element has given up. The element
   * belongs to whoever made it, so it is put back on the way out -- unless it
   * was already off, and theirs to keep.
   */
  #B() {
    this.video.disableRemotePlayback || (this.video.disableRemotePlayback = !0, this.#g = !0);
  }
  #X() {
    const e = this.#s, t = this.#c;
    t && t.finish().then(
      () => {
        e === this.#s && this.#j();
      },
      (i) => {
        e === this.#s && this.#P(l(i));
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
  #z = () => {
    if (this.#f === null || this.#h === "idle" || this.#h === "error") return;
    const e = this.video.currentTime;
    this.#O(e) || (this.#I("seeking"), this.#C(), this.#a(), this.#e?.postMessage({
      type: "seek",
      id: this.#s,
      time: e
    }));
  };
  #F = (e) => {
    this.#h !== "idle" && (this.#E(e.type, o()), e.type === "waiting" && this.#U());
  };
  #x = (e) => {
    this.#n(
      `video-${e.type}`,
      this.#Y(e.currentTarget === this.video),
      { critical: e.type === "error" && this.video.error !== null }
    );
  };
  #Y(e) {
    return {
      mediaErrorCode: this.video.error?.code ?? null,
      readyState: this.video.readyState,
      networkState: this.video.networkState,
      currentVideo: e,
      videoConnected: this.video.isConnected,
      videoPaused: this.video.paused,
      srcAttributePresent: this.video.hasAttribute("src"),
      srcObjectPresent: this.video.srcObject !== null,
      sourceElementPresent: this.#d !== null
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
  #U() {
    if (this.video.seeking) return;
    const e = this.video.currentTime, t = this.video.buffered;
    let i = null;
    for (let r = 0; r < t.length; r++) {
      const n = t.start(r);
      if (e >= n - m && e < t.end(r) - m)
        return;
      n > e + m && (i === null || n < i) && (i = n);
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
  #E(e, t) {
    if (this.#M === 0) return;
    const i = t - this.#M, r = Math.max(0, t - this.#L);
    this.#L = Math.max(this.#L, t), this.#S("timing", { name: e, sinceLoad: i, sincePrevious: r });
  }
  #K(e, t, i = this.#s) {
    i === this.#s && (this.#o = e.mediaSourceClass), this.#n(e.event, e.detail, {
      at: e.at,
      critical: e.critical,
      scope: t,
      generation: i,
      mediaSourceClass: e.mediaSourceClass
    });
  }
  #n(e, t = {}, i = {}) {
    return u.record({
      at: i.at ?? o(),
      scope: i.scope ?? "main",
      event: e,
      playerInstance: this.#i,
      generation: i.generation ?? this.#s,
      videoId: this.#u,
      mediaSourceOwner: this.#l,
      mediaSourceClass: i.mediaSourceClass ?? this.#o,
      detail: t,
      critical: i.critical
    });
  }
  #O(e) {
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
  #G = () => {
    const e = this.video.currentTime;
    this.#l === "main" ? this.#c?.setCurrentTime(e) : this.#e?.postMessage({
      type: "time",
      id: this.#s,
      currentTime: e
    });
  };
  #Q(e, t) {
    e === this.#s && this.#e?.postMessage(t);
  }
  #a() {
    this.#w === null && (this.#w = setInterval(
      this.#G,
      Q
    ));
  }
  #j() {
    this.#w !== null && (clearInterval(this.#w), this.#w = null);
  }
  #k(e, t = this.#s) {
    const i = (r, n) => this.#n(r, n, { generation: t });
    i("player-teardown", { reason: e }), this.#j(), this.#C(), this.#c?.close(e), this.#c = null, this.#p && (i("object-url-revoke-call", { reason: e }), URL.revokeObjectURL(this.#p)), this.#p = null, this.#d && (i("source-element-detach-call", { reason: e }), this.#d.remove()), this.#d = null, this.#g && (this.video.disableRemotePlayback = !1, this.#g = !1), i("video-source-detach-call", {
      attachment: "src",
      hadAttachment: this.video.hasAttribute("src"),
      reason: e
    }), this.video.removeAttribute("src"), i("video-source-detach-call", {
      attachment: "srcObject",
      hadAttachment: this.video.srcObject !== null,
      reason: e
    }), this.video.srcObject = null, i("video-load-call", { reason: e }), this.video.load(), this.#o = null;
  }
  #P(e) {
    const t = o();
    this.#n(
      "player-fail",
      { ...this.#Y(!0), errorName: e.name },
      { at: t, critical: !0 }
    );
    const i = [
      "m2h",
      Math.trunc(t * 1e3).toString(36),
      this.#i.toString(36),
      this.#s.toString(36),
      (++this.#$).toString(36)
    ].join("-"), r = u.freeze(i, t);
    u = new _();
    const n = Y(e, r);
    this.#k("fail"), this.#I("error"), this.#Z(n), this.#S("error", { error: n });
  }
  #J(e) {
    const t = this.#d, i = this.#p, r = [
      `videoConnected=${this.video.isConnected}`,
      `videoReadyState=${this.video.readyState}`,
      `videoNetworkState=${this.video.networkState}`,
      `videoPaused=${this.video.paused}`,
      `sourceElement=${t ? "present" : "absent"}`,
      `sourceConnected=${t?.isConnected ?? !1}`,
      `sourceMatchesObjectUrl=${t !== null && i !== null && t.src === i}`,
      `currentSrcMatchesObjectUrl=${i !== null && this.video.currentSrc === i}`
    ].join(", "), n = new Error(`${e.message} (${r})`);
    return n.name = e.name, n.stack += `
Caused by: ${e.stack ?? e.message}`, n;
  }
  #Z(e) {
    const t = this.#v;
    t && (this.#v = null, e ? t.reject(e) : t.resolve());
  }
  #I(e) {
    this.#h !== e && (this.#h = e, this.#S("statechange", { state: e }));
  }
  #S(e, t) {
    this.dispatchEvent(new CustomEvent(e, { detail: t }));
  }
}
export {
  w as DEFAULT_KEEP_BEHIND_SECONDS,
  k as DEFAULT_MAX_AHEAD_SECONDS,
  E as DEFAULT_QUEUE_HIGH_WATER_MARK,
  j as LIFECYCLE_EVENT_ID_MAX_LENGTH,
  T as LIFECYCLE_TRACE_CAPACITY,
  fe as Mpeg2TsPlayer,
  he as isLifecycleError,
  o as lifecycleNow,
  le as requiresManagedMediaSource,
  ue as supportsManagedMediaSource,
  de as supportsPassthrough,
  I as supportsWorkerMediaSource
};
//# sourceMappingURL=index.js.map
