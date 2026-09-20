// After building from Rust, ensure the worker really ships those bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const expected = await readFile(
  "packages/player/wasm/mpeg2toh264_wasm_bg.wasm",
);
let copies = 0;
for (const name of await readdir("packages/player/dist/assets")) {
  if (!name.endsWith(".js")) continue;
  const text = await readFile(`packages/player/dist/assets/${name}`, "utf8");
  for (const match of text.matchAll(
    /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/g,
  )) {
    assert.deepEqual(
      Buffer.from(match[1], "base64"),
      expected,
      `stale WASM in ${name}`,
    );
    copies++;
  }
}
assert.ok(copies > 0, "no embedded WASM found in the player build");
console.log(
  `player WASM: ${copies} embedded copies match ${createHash("sha256").update(expected).digest("hex")}`,
);
