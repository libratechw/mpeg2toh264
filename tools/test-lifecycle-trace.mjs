import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const output = join(tmpdir(), `mpeg2toh264-lifecycle-test-${process.pid}.mjs`);

function entry(at, event, critical = false) {
  return {
    at,
    scope: "main",
    event,
    playerInstance: 7,
    generation: 11,
    videoId: 13,
    mediaSourceOwner: "main",
    mediaSourceClass: "ManagedMediaSource",
    detail: { operation: "append", epoch: 3 },
    critical,
  };
}

try {
  await build({
    entryPoints: ["packages/player/src/lifecycle.ts"],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "browser",
  });
  const {
    LifecycleTrace,
    LIFECYCLE_EVENT_ID_MAX_LENGTH,
    LIFECYCLE_TRACE_CAPACITY,
    isLifecycleError,
    lifecycleNow,
    readErrorName,
    sanitizeDiagnosticLifecycleInput,
    sanitizeLifecycleDetail,
    withLifecycleTrace,
  } = await import(pathToFileURL(output));
  assert.equal(LIFECYCLE_EVENT_ID_MAX_LENGTH, 51);
  assert.equal(LIFECYCLE_TRACE_CAPACITY, 48);

  for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new LifecycleTrace(capacity), RangeError);
  }

  const trace = new LifecycleTrace(4);
  trace.record(entry(30, "recent-a"));
  trace.record(entry(10, "first-cause", true));
  trace.record(entry(20, "recent-b"));
  trace.record(entry(40, "recent-c"));
  trace.record(entry(50, "recent-d"));
  const snapshot = trace.freeze("m2h-abc-7-b-1", 60);

  assert.equal(snapshot.dropped, 1);
  assert.equal(snapshot.firstCritical.event, "first-cause");
  assert.deepEqual(
    snapshot.entries.map(({ event }) => event),
    ["first-cause", "recent-b", "recent-c", "recent-d"],
  );
  assert.equal(trace.freeze("ignored", 100), snapshot);
  trace.record(entry(70, "after-freeze"));
  assert.equal(
    snapshot.entries.some(({ event }) => event === "after-freeze"),
    false,
  );

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.entries), true);
  for (const frozenEntry of snapshot.entries) {
    assert.equal(Object.isFrozen(frozenEntry), true);
    assert.equal(Object.isFrozen(frozenEntry.detail), true);
  }
  assert.throws(() => {
    snapshot.entries[0].detail.epoch = 99;
  }, TypeError);
  assert.throws(() => snapshot.entries.push(entry(80, "mutate")), TypeError);

  const serialized = JSON.stringify(snapshot);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.eventId, "m2h-abc-7-b-1");
  assert.deepEqual(
    parsed.entries.map(({ at }) => at),
    [10, 20, 40, 50],
  );

  const tied = new LifecycleTrace(2);
  tied.record(entry(5, "tie-first"));
  tied.record(entry(5, "tie-second"));
  assert.deepEqual(
    tied.freeze("tied", 6).entries.map(({ event }) => event),
    ["tie-first", "tie-second"],
  );

  const one = new LifecycleTrace(1);
  one.record(entry(1, "before"));
  one.record(entry(2, "only-cause", true));
  one.record(entry(3, "after"));
  assert.deepEqual(
    one.freeze("one", 4).entries.map(({ event }) => event),
    ["only-cause"],
  );

  const resolved = new LifecycleTrace(4);
  resolved.record(entry(0, "before-first-switch"));
  const firstSwitch = resolved.record({
    ...entry(1, "dplayer-quality-switch-start", true),
    detail: { qualitySwitchGeneration: 1 },
  });
  assert.notEqual(firstSwitch, null);
  resolved.record(entry(2, "dplayer-quality-switch-end"));
  assert.equal(resolved.resolveCritical({ ...firstSwitch }), false);
  assert.equal(resolved.resolveCritical(firstSwitch), true);
  const secondSwitch = resolved.record({
    ...entry(3, "dplayer-quality-switch-start", true),
    detail: { qualitySwitchGeneration: 2 },
  });
  assert.notEqual(secondSwitch, null);
  resolved.record(entry(4, "failure"));
  resolved.record(entry(4.5, "after-failure"));
  const resolvedSnapshot = resolved.freeze("m2h-def-7-b-1", 5);
  assert.equal(
    resolvedSnapshot.firstCritical.detail.qualitySwitchGeneration,
    2,
  );
  assert.equal(
    resolvedSnapshot.entries.some(
      ({ detail }) => detail.qualitySwitchGeneration === 1,
    ),
    false,
  );
  assert.deepEqual(
    resolvedSnapshot.entries.map(({ event }) => event),
    [
      "dplayer-quality-switch-end",
      "dplayer-quality-switch-start",
      "failure",
      "after-failure",
    ],
  );

  const promoted = new LifecycleTrace(3);
  const resolvedTrigger = promoted.record(entry(1, "resolved-trigger", true));
  promoted.record(entry(2, "independent-error", true));
  assert.equal(promoted.resolveCritical(resolvedTrigger), true);
  assert.equal(
    promoted.freeze("m2h-ghi-7-b-1", 3).firstCritical.event,
    "independent-error",
  );

  const original = new Error("original failure");
  const decorated = withLifecycleTrace(original, snapshot);
  assert.equal(decorated, original);
  assert.equal(decorated.lifecycleEventId, "m2h-abc-7-b-1");
  assert.equal(decorated.lifecycleTrace, snapshot);
  assert.equal(isLifecycleError(decorated), true);
  assert.equal(
    isLifecycleError({
      lifecycleEventId: snapshot.eventId,
      lifecycleTrace: snapshot,
    }),
    false,
  );
  assert.equal(
    isLifecycleError({
      name: "Error",
      message: "cross-realm structural error",
      lifecycleEventId: snapshot.eventId,
      lifecycleTrace: snapshot,
    }),
    true,
  );
  assert.equal(decorated.message.includes(serialized), false);
  assert.equal(
    decorated.message.slice("original failure\n".length).length <= 240,
    true,
  );
  const screenshotTrace = new LifecycleTrace(8);
  screenshotTrace.record(entry(1, "dplayer-quality-switch-start", true));
  screenshotTrace.record(entry(2, "mediasource-sourceclose"));
  screenshotTrace.record(entry(3, "sourcebuffer-append-call"));
  screenshotTrace.record(entry(4, "mse-error"));
  screenshotTrace.record(entry(5, "worker-error"));
  screenshotTrace.record(entry(6, "player-fail"));
  const screenshotSnapshot = screenshotTrace.freeze(
    "m2h-zzzzzzzzzz-zzzzzzzzzzz-zzzzzzzzzzz-zzzzzzzzzzz",
    7,
  );
  const screenshotError = withLifecycleTrace(
    new Error("screenshot failure"),
    screenshotSnapshot,
  );
  const screenshotSuffix = screenshotError.message.slice(
    "screenshot failure\n".length,
  );
  assert.equal(screenshotSuffix.length <= 240, true);
  assert.match(
    screenshotSuffix,
    /tail=.*ms\.sourceclose>sb\.append-call>mse-error>w\.error>p\.fail/,
  );
  assert.equal(
    screenshotError.message.includes(JSON.stringify(screenshotSnapshot)),
    false,
  );
  const serializedError = JSON.parse(JSON.stringify(decorated));
  assert.equal(serializedError.lifecycleEventId, "m2h-abc-7-b-1");
  assert.deepEqual(
    serializedError.lifecycleTrace.entries.map(({ at }) => at),
    [10, 20, 40, 50],
  );

  const domException = new DOMException(
    "the MediaSource is closed",
    "InvalidStateError",
  );
  const tracedDomException = withLifecycleTrace(domException, snapshot);
  assert.equal(tracedDomException, domException);
  assert.equal(tracedDomException.name, "InvalidStateError");
  assert.match(tracedDomException.message, /the MediaSource is closed/);
  assert.equal(isLifecycleError(tracedDomException), true);

  const readonlyMessage = new Error("placeholder");
  Object.defineProperty(readonlyMessage, "message", {
    get: () => "readonly DOMException-like message",
    configurable: false,
  });
  readonlyMessage.name = "InvalidStateError";
  readonlyMessage.stack =
    "InvalidStateError: readonly DOMException-like message";
  const tracedReadonlyMessage = withLifecycleTrace(readonlyMessage, snapshot);
  assert.notEqual(tracedReadonlyMessage, readonlyMessage);
  assert.equal(tracedReadonlyMessage.cause, readonlyMessage);
  assert.equal(tracedReadonlyMessage.name, "InvalidStateError");
  assert.match(
    tracedReadonlyMessage.message,
    /readonly DOMException-like message/,
  );
  assert.match(tracedReadonlyMessage.stack, /Caused by original error/);
  assert.equal(isLifecycleError(tracedReadonlyMessage), true);

  const nonExtensible = Object.preventExtensions(
    new Error("non-extensible failure"),
  );
  const tracedNonExtensible = withLifecycleTrace(nonExtensible, snapshot);
  assert.notEqual(tracedNonExtensible, nonExtensible);
  assert.equal(tracedNonExtensible.cause, nonExtensible);
  assert.match(tracedNonExtensible.message, /non-extensible failure/);
  assert.equal(isLifecycleError(tracedNonExtensible), true);

  const frozen = Object.freeze(new Error("frozen failure"));
  const tracedFrozen = withLifecycleTrace(frozen, snapshot);
  assert.notEqual(tracedFrozen, frozen);
  assert.equal(tracedFrozen.cause, frozen);
  assert.match(tracedFrozen.message, /frozen failure/);
  assert.equal(isLifecycleError(tracedFrozen), true);
  assert.equal(Object.isFrozen(frozen), true);

  const throwingName = new Error("throwing name failure");
  Object.defineProperty(throwingName, "name", {
    get() {
      throw new Error("name getter failed");
    },
    configurable: false,
  });
  assert.equal(readErrorName(throwingName), "Error");
  const tracedThrowingName = withLifecycleTrace(throwingName, snapshot);
  assert.notEqual(tracedThrowingName, throwingName);
  assert.equal(tracedThrowingName.cause, throwingName);
  assert.equal(tracedThrowingName.name, "Error");
  assert.equal(isLifecycleError(tracedThrowingName), true);

  assert.equal(isLifecycleError(new Error("plain")), false);
  assert.equal(
    isLifecycleError({
      name: "Error",
      message: "unfrozen trace",
      lifecycleEventId: "m2h-abc-7-b-1",
      lifecycleTrace: { ...snapshot },
    }),
    false,
  );
  const newlineEventId = `${snapshot.eventId}\n`;
  assert.equal(
    isLifecycleError({
      name: "Error",
      message: "invalid event ID",
      lifecycleEventId: newlineEventId,
      lifecycleTrace: Object.freeze({
        ...snapshot,
        eventId: newlineEventId,
      }),
    }),
    false,
  );
  assert.equal(
    isLifecycleError({
      name: "Error",
      message: "empty trace",
      lifecycleEventId: "m2h-abc-7-b-1",
      lifecycleTrace: Object.freeze({
        eventId: "m2h-abc-7-b-1",
        frozenAt: 10,
        dropped: 0,
        firstCritical: null,
        entries: Object.freeze([]),
      }),
    }),
    false,
  );
  assert.equal(
    isLifecycleError(
      new Proxy(
        {},
        {
          get() {
            throw new Error("malformed error access");
          },
        },
      ),
    ),
    false,
  );
  const nonFiniteEntry = Object.freeze({
    ...snapshot.entries[0],
    detail: Object.freeze({ invalid: Number.POSITIVE_INFINITY }),
  });
  const nonFiniteEntries = Object.freeze([
    nonFiniteEntry,
    ...snapshot.entries.slice(1),
  ]);
  const nonFiniteTrace = Object.freeze({
    ...snapshot,
    firstCritical: nonFiniteEntry,
    entries: nonFiniteEntries,
  });
  assert.equal(
    isLifecycleError({
      name: "Error",
      message: "non-finite detail",
      lifecycleEventId: snapshot.eventId,
      lifecycleTrace: nonFiniteTrace,
    }),
    false,
  );

  assert.deepEqual(sanitizeLifecycleDetail({ finite: 1, nullable: null }), {
    finite: 1,
    nullable: null,
  });
  assert.equal(sanitizeLifecycleDetail({ invalid: Number.NaN }), null);
  assert.equal(
    sanitizeLifecycleDetail({ invalid: Number.NEGATIVE_INFINITY }),
    null,
  );
  assert.equal(sanitizeLifecycleDetail({ invalid: 1n }), null);
  assert.equal(sanitizeLifecycleDetail({ oversized: "x".repeat(257) }), null);
  assert.equal(
    sanitizeLifecycleDetail({ ["x".repeat(65)]: "oversized-key" }),
    null,
  );
  assert.equal(
    sanitizeLifecycleDetail(
      Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`field${index}`, index]),
      ),
    ),
    null,
  );
  assert.equal(
    sanitizeLifecycleDetail(
      Object.defineProperty({}, "broken", {
        enumerable: true,
        get() {
          throw new Error("getter must stay inside the diagnostic boundary");
        },
      }),
    ),
    null,
  );
  assert.deepEqual(
    sanitizeDiagnosticLifecycleInput(
      "dplayer-quality-switch-start",
      { generation: 2 },
      { at: 10, critical: true },
    ),
    {
      event: "dplayer-quality-switch-start",
      detail: { generation: 2 },
      at: 10,
      critical: true,
    },
  );
  assert.equal(sanitizeDiagnosticLifecycleInput("x".repeat(65), {}, {}), null);
  assert.equal(sanitizeDiagnosticLifecycleInput("line\nbreak", {}, {}), null);
  assert.equal(sanitizeDiagnosticLifecycleInput("trailing\n", {}, {}), null);
  assert.equal(
    sanitizeDiagnosticLifecycleInput("valid-event", {}, { at: Number.NaN }),
    null,
  );
  assert.equal(
    sanitizeDiagnosticLifecycleInput(
      "valid-event",
      {},
      new Proxy(
        {},
        {
          get() {
            throw new Error("options access must stay diagnostic-only");
          },
        },
      ),
    ),
    null,
  );

  const before = lifecycleNow();
  const after = lifecycleNow();
  assert.equal(Number.isFinite(before), true);
  assert.equal(before >= performance.timeOrigin, true);
  assert.equal(after >= before, true);

  const playerSource = await readFile("packages/player/src/player.ts", "utf8");
  const onMessageSource = playerSource.slice(
    playerSource.indexOf("  #onMessage ="),
    playerSource.indexOf(
      "  /** Open a MediaSource here",
      playerSource.indexOf("  #onMessage ="),
    ),
  );
  const staleFilterAt = onMessageSource.indexOf(
    "if (notification.id !== this.#generation) return",
  );
  const lifecycleAt = onMessageSource.indexOf(
    'if (notification.type === "lifecycle")',
  );
  assert.equal(lifecycleAt >= 0, true);
  assert.equal(lifecycleAt < staleFilterAt, true);
  assert.match(
    onMessageSource,
    /this\.#recordMseLifecycle\(\s*notification\.trace,\s*"worker",\s*notification\.id,?\s*\);\s*return;/,
  );
  assert.equal(
    onMessageSource.slice(staleFilterAt).includes('case "lifecycle":'),
    false,
  );

  const recordMseSource = playerSource.slice(
    playerSource.indexOf("  #recordMseLifecycle("),
    playerSource.indexOf(
      "  #recordLifecycle(",
      playerSource.indexOf("  #recordMseLifecycle("),
    ),
  );
  assert.match(
    recordMseSource,
    /if \(generation === this\.#generation\)\s*this\.#mediaSourceClass = trace\.mediaSourceClass;/,
  );
  assert.match(recordMseSource, /mediaSourceClass: trace\.mediaSourceClass/);

  const failSource = playerSource.slice(
    playerSource.indexOf("  #fail(error: Error"),
    playerSource.indexOf(
      "  #withMseAttachmentContext",
      playerSource.indexOf("  #fail(error: Error"),
    ),
  );
  const freezeAt = failSource.indexOf("lifecycleJournal.freeze");
  const replaceAt = failSource.indexOf("lifecycleJournal = new LifecycleTrace");
  const teardownAt = failSource.indexOf('this.#teardown("fail")');
  assert.equal(freezeAt >= 0, true);
  assert.equal(failSource.includes("error.name"), false);
  assert.match(failSource, /errorName: readErrorName\(error\)/);
  assert.equal(freezeAt < replaceAt, true);
  assert.equal(replaceAt < teardownAt, true);

  const teardownSource = playerSource.slice(
    playerSource.indexOf("  #teardown(reason:"),
    playerSource.indexOf("  #fail(error: Error"),
  );
  for (const [traceCall, ownedCall] of [
    ['record("object-url-revoke-call"', "URL.revokeObjectURL"],
    ['record("source-element-detach-call"', "this.#source.remove()"],
    ['attachment: "src"', 'this.video.removeAttribute("src")'],
    ['attachment: "srcObject"', "this.video.srcObject = null"],
    ['record("video-load-call"', "this.video.load()"],
  ]) {
    assert.equal(teardownSource.indexOf(traceCall) >= 0, true);
    assert.equal(
      teardownSource.indexOf(traceCall) < teardownSource.indexOf(ownedCall),
      true,
    );
  }
} finally {
  await unlink(output).catch(() => {});
}
