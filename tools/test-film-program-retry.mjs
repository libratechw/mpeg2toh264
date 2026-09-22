// Runtime CPU-program failures use the same public recovery points as FBO
// failures. The shaders are identified only to inject failure at the GL boundary.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { buildBundles, run } from "./yadif-clock-harness.mjs";

const compiled = await build({
  entryPoints: ["packages/yadif/src/shader.ts"],
  bundle: true,
  format: "esm",
  write: false,
});
const shaders = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const bundles = await buildBundles(process.cwd());
let cases = 0;
for (const rendering of ["main", "worker"]) {
  for (const stage of ["ANALYSIS", "WEAVE", "SAMPLE"]) {
    for (const trigger of ["scan", "timeline", "start", "resize"]) {
      for (const restored of [true, false]) {
        const label = `${rendering}/${stage}/${trigger}/${restored ? "recover" : "re-fail"}`;
        const realm = rendering === "main" ? "page" : "worker";
        let available = false;
        let links = 0;
        let beforeRetry;
        const errors = [];
        const result = await run(bundles, {
          rendering,
          vsyncs: 145,
          deinterlacerOptions: {
            autoFilm: false,
            onFailure: (message) => errors.push(message),
          },
          programAvailable({ realm: current, fragment }) {
            if (
              current !== realm ||
              fragment !== shaders[`FILM_${stage}_FRAGMENT_SHADER`]
            )
              return true;
            links++;
            return available;
          },
          beforeVsync(n, control) {
            if (n === 12)
              control.deinterlacer("__deinterlacer.autoFilm = true");
            if (n === 65) {
              assert.equal(errors.length, 1, `${label}: initial failure`);
              assert.match(errors[0], /autoFilm programs unavailable/);
              available = restored;
              beforeRetry = links;
              if (trigger === "scan")
                control.deinterlacer(
                  "__deinterlacer.scan = { interlaced: true, topFieldFirst: false }",
                );
              if (trigger === "timeline")
                control.deinterlacer(
                  "__deinterlacer.videoTimeline = [{ start: 0, scan: { interlaced: true, topFieldFirst: false } }]",
                );
              if (trigger === "start")
                control.deinterlacer(
                  "__deinterlacer.stop(); __deinterlacer.start()",
                );
              if (trigger === "resize")
                control.deinterlacer(
                  "__deinterlacer.videoTimeline = [{ start: 0, codedSize: { width: 1280, height: 720 }, scan: { interlaced: true, topFieldFirst: true } }]",
                );
            }
          },
        });
        assert.ok(links > beforeRetry, `${label}: program not recreated`);
        assert.equal(
          errors.length,
          restored ? 1 : 2,
          `${label}: episode count`,
        );
        assert.equal(
          result.stats.at(-1).filmError === null,
          restored,
          `${label}: error state`,
        );
        const reads = result.readbacks.filter(
          (x) => x.realm === realm && x.width === 288 && x.height === 162,
        );
        assert.equal(
          reads.length > 5,
          restored,
          `${label}: actual analysis resumed`,
        );
        console.log(`ok ${label}`);
        cases++;
      }
    }
  }
}
console.log(`film program retry: ${cases} cases passed`);
