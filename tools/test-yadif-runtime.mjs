#!/usr/bin/env node

// Focused regression tests for the browser-boundary decisions the
// deinterlacer makes. This file starts with the rAF loop's window, which was
// seen to matter on a device: Document Picture-in-Picture moves the element to
// another window, whose rAF and rVFC timestamps are a different timebase, and
// comparing across the two stopped the picture. The loop must follow the
// canvas.
//
// This covers the decision that path makes. The loop's actual registration and
// release against a real document is a browser behaviour, verified on-device
// (Windows Document PiP continued after the fix); it is not reimplemented here.
//
// Run from the repository root:
//   npm run test:yadif-runtime

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), "yadif-runtime-"));
const outFile = join(outDir, "runtime.mjs");

await build({
  entryPoints: [join(root, "packages/yadif/src/runtime.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: outFile,
  logLevel: "silent",
});

const { loopWindowFor } = await import(pathToFileURL(outFile).href);

test.after(async () => {
  await rm(outDir, { recursive: true, force: true });
});

test("loopWindowFor follows the canvas into another document and back", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const fallbackWindow = { name: "fallback" };
  try {
    // The fallback the loop returns to is the global window at the time of
    // the call; capture it the way the module would see it.
    globalThis.window = fallbackWindow;

    const mainWindow = { name: "main" };
    const pipWindow = { name: "document-pip" };
    const mainDocument = { defaultView: mainWindow };
    const pipDocument = { defaultView: pipWindow };

    const canvas = { ownerDocument: mainDocument };
    assert.equal(loopWindowFor(canvas), mainWindow);

    // Entering Document Picture-in-Picture: the element is adopted by the PiP
    // document, so its frame callbacks and rAF live in that window.
    canvas.ownerDocument = pipDocument;
    assert.equal(loopWindowFor(canvas), pipWindow);

    // Leaving: adopted back into the page's document.
    canvas.ownerDocument = mainDocument;
    assert.equal(loopWindowFor(canvas), mainWindow);

    // The PiP document going away is the null defaultView case.
    canvas.ownerDocument = { defaultView: null };
    assert.equal(loopWindowFor(canvas), fallbackWindow);

    // A detached canvas has no document to ask.
    canvas.ownerDocument = null;
    assert.equal(loopWindowFor(canvas), fallbackWindow);
    delete canvas.ownerDocument;
    assert.equal(loopWindowFor(canvas), fallbackWindow);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else delete globalThis.window;
  }
});
