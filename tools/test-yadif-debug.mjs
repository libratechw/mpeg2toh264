import assert from "node:assert/strict";
import { buildBundles, run } from "./yadif-clock-harness.mjs";

const bundles = await buildBundles(process.cwd());
for (const rendering of ["main", "worker"]) {
  const logs = [];
  const options = {
    rendering,
    vsyncs: 100,
    consoleOutput: { ...console, log: (...args) => logs.push(args.join(" ")) },
  };
  await run(bundles, options);
  assert.equal(logs.length, 0, "debug logging must remain opt-in");
  await run(bundles, { ...options, deinterlacerOptions: { debug: true } });
  assert.ok(
    logs.length > 80,
    `${rendering}: actual queued presentations were not logged`,
  );
  assert.ok(logs.some((line) => /field field 1, due/.test(line)));
  assert.ok(logs.some((line) => /field field 2, due/.test(line)));
  assert.ok(
    logs.every((line) =>
      /^yadif: \+[\d.]+ ms \([\d.]+ refreshes\).* due -?[\d.]+ ms/.test(line),
    ),
  );
  console.log(
    `PASS ${rendering}: opt-in presentation timing and field identity`,
  );
}
