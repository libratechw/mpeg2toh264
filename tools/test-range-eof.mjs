import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

// Focused regression test for the iPad Original steady-playback HTTP 416
// stop (reproduced by the range contract below): a high-water reopen answered 416
// at the natural end of the file used to fail the whole load.
//
// The test bundles the real `packages/player/src/source.ts` and executes
// its exported decision against real `openSource` refusals. It never
// reimplements the predicate: every drain/fatal verdict below comes from
// `isRangeExhaustion` itself.
//
// Run from the repository root (node with the workspace dependencies):
//   npm run test:range-eof

function makeFile(totalBytes) {
  const file = new Uint8Array(totalBytes);
  for (let index = 0; index < totalBytes; index++) file[index] = index % 251;
  return file;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? null : headers[key];
}

// Minimal Starlette-like fixture: 206 with Content-Range for satisfiable
// open ranges, 416 once the start reaches the end. The file is read
// through `ref` on every call so tests can shrink or grow it mid-load.
function mockFetch(ref) {
  return async (_url, options = {}) => {
    const file = ref.data;
    const total = file.byteLength;
    const range = headerValue(options.headers, "Range");
    const open =
      range === null || range === undefined
        ? null
        : range.match(/^bytes=(\d+)-$/);
    if (!open) {
      return new Response(file.slice().buffer, {
        status: 200,
        headers: { "Content-Length": String(total) },
      });
    }
    const start = Number(open[1]);
    if (start >= total) {
      return new Response(null, {
        status: 416,
        statusText: "Range Not Satisfiable",
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const body = file.slice(start);
    return new Response(body.buffer, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${total - 1}/${total}`,
        "Content-Length": String(body.byteLength),
      },
    });
  };
}

const output = join(tmpdir(), `mpeg2toh264-range-test-${process.pid}.mjs`);
const realFetch = globalThis.fetch;
const INPUT_URL = "https://example.invalid/v/3/download";

const refuses = (promise) =>
  promise.then(
    () => assert.fail("expected a refusal"),
    (error) => error,
  );

try {
  await build({
    entryPoints: ["packages/player/src/source.ts"],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "browser",
  });
  const {
    openSource,
    isRangeNotSatisfiable,
    isRangeExhaustion,
    withRangeContext,
  } = await import(pathToFileURL(output));
  const signal = new AbortController().signal;

  // 1. EOF 416 at the known total drains instead of failing the load.
  {
    globalThis.fetch = mockFetch({ data: makeFile(4096) });
    const first = await openSource(INPUT_URL, signal, 0);
    assert.equal(first.totalBytes, 4096);
    assert.equal(first.resumable, true);
    first.close();
    const error = await refuses(openSource(INPUT_URL, signal, 4096));
    assert.equal(error.cause?.status, 416);
    assert.equal(isRangeExhaustion(4096, 4096, error), true);
  }

  // 2. A 416 below the known total (shrank file) stays fatal, carrying
  // where reading stood.
  {
    const ref = { data: makeFile(4096) };
    globalThis.fetch = mockFetch(ref);
    ref.data = makeFile(2048);
    const error = await refuses(openSource(INPUT_URL, signal, 3000));
    assert.equal(isRangeNotSatisfiable(error), true);
    assert.equal(isRangeExhaustion(3000, 4096, error), false);
    const fatal = withRangeContext(error, 3000, 4096);
    assert.match(fatal.message, /\(range bytes=3000-, totalBytes=4096\)$/);
    assert.equal(isRangeNotSatisfiable(fatal), true);
  }

  // 3. A 416 with no known total never drains: a live input, or one whose
  // length was never stated, has no end to prove.
  {
    globalThis.fetch = mockFetch({ data: makeFile(4096) });
    const error = await refuses(openSource(INPUT_URL, signal, 4096));
    assert.equal(isRangeExhaustion(5000, null, error), false);
  }

  // 4. Non-range failures never drain, even at an exhausted offset.
  {
    assert.equal(
      isRangeExhaustion(4096, 4096, new TypeError("fetch failed")),
      false,
    );
    assert.equal(isRangeExhaustion(4096, 4096, new Error("boom")), false);
  }

  // 5. Impostors are rejected: message-only 416 (including a longer
  // status like 4160 sharing the prefix), numeric 4160, and
  // foreign/non-Error values never classify as range refusals.
  {
    assert.equal(isRangeNotSatisfiable(new Error("boom HTTP 416 boom")), false);
    assert.equal(
      isRangeNotSatisfiable(
        new Error("could not fetch the input: HTTP 4160 Bad"),
      ),
      false,
    );
    assert.equal(
      isRangeNotSatisfiable(
        new Error("could not fetch the input: HTTP 416 Gone"),
      ),
      false,
    );
    assert.equal(
      isRangeNotSatisfiable(
        Object.assign(new Error("odd"), { cause: { status: 4160 } }),
      ),
      false,
    );
    assert.equal(isRangeNotSatisfiable("HTTP 416"), false);
    assert.equal(isRangeNotSatisfiable(null), false);
    assert.equal(isRangeNotSatisfiable(undefined), false);
    assert.equal(isRangeNotSatisfiable(416), false);
    assert.equal(isRangeNotSatisfiable({}), false);
  }

  // 6. A growing source answers the stale offset with 206 stating the new
  // total, so the worker keeps reading instead of draining.
  {
    const ref = { data: makeFile(4096) };
    globalThis.fetch = mockFetch(ref);
    const first = await openSource(INPUT_URL, signal, 0);
    assert.equal(first.totalBytes, 4096);
    first.close();
    ref.data = makeFile(8192);
    const grown = await openSource(INPUT_URL, signal, 4096);
    assert.equal(grown.offset, 4096);
    assert.equal(grown.totalBytes, 8192);
    assert.equal(grown.resumable, true);
    grown.close();
  }

  // 7. A zero-length initial source stays fail-closed: its open fails,
  // and with no known total the refusal cannot drain.
  {
    globalThis.fetch = mockFetch({ data: makeFile(0) });
    const error = await refuses(openSource(INPUT_URL, signal, 0));
    assert.equal(isRangeNotSatisfiable(error), true);
    assert.equal(isRangeExhaustion(0, null, error), false);
    const fatal = withRangeContext(error, 0, null);
    assert.match(fatal.message, /\(range bytes=0-, totalBytes=unknown\)$/);
  }

  console.log("test-range-eof: ok");
} finally {
  globalThis.fetch = realFetch;
  await unlink(output).catch(() => {});
}
