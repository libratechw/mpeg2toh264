// Owner callbacks run synchronously. A recovery must not outlive the stop or
// destruction requested by that callback, including in the frame watchdog.
import assert from "node:assert/strict";
import { buildBundles, run } from "./yadif-clock-harness.mjs";

const bundles = await buildBundles(process.cwd());
let cases = 0;
for (const listener of ["event", "callback"])
  for (const action of ["stop", "destroy", "withdraw"])
    for (const trigger of [
      "setter",
      "start",
      "scan",
      "timeline",
      "resize",
      "watchdog",
    ]) {
      const label = `${listener}/${action}/${trigger}`;
      let control;
      let armed = false;
      let handled = false;
      let allocations = 0;
      let atAction;
      let requestsAtAction;
      let actionTime;
      const errors = [];
      const onFailure = (message) => {
        errors.push(message);
        if (!armed || handled) return;
        handled = true;
        actionTime = control.deinterlacer(
          "performance.now() + performance.timeOrigin",
        );
        control.deinterlacer(
          action === "withdraw"
            ? "__deinterlacer.film = false"
            : `__deinterlacer.${action}()`,
        );
        atAction = allocations;
        requestsAtAction = control.requests.length;
      };
      const result = await run(bundles, {
        rendering: "main",
        vsyncs: 145,
        deinterlacerOptions: {
          film: false,
          doubleRate: action !== "withdraw",
          onFailure: listener === "callback" ? onFailure : undefined,
        },
        resourceAvailable(resource) {
          allocations++;
          return resource.format !== 0x8814;
        },
        beforeVsync(n, current) {
          control = current;
          if (trigger === "watchdog" && n > 65 && n % 2 === 0) {
            current.video.currentTime += 1 / 30;
            current.video.totalVideoFrames++;
          }
          if (n === 0 && listener === "event") {
            current.pageContext.__onFailure = onFailure;
            current.deinterlacer(
              '__deinterlacer.addEventListener("failure", e => __onFailure(e.detail))',
            );
          }
          if (n === 12) current.deinterlacer("__deinterlacer.film = true");
          if (n !== 65) return;
          armed = true;
          if (trigger === "watchdog") current.frames(false);
          if (trigger === "setter")
            current.deinterlacer("__deinterlacer.film = true");
          if (trigger === "start" || trigger === "watchdog")
            current.deinterlacer(
              "__deinterlacer.stop(); __deinterlacer.start()",
            );
          if (trigger === "scan")
            current.deinterlacer(
              "__deinterlacer.scan = {interlaced:true,topFieldFirst:false}",
            );
          if (trigger === "timeline")
            current.deinterlacer(
              "__deinterlacer.videoTimeline = [{start:0,scan:{interlaced:true,topFieldFirst:false}}]",
            );
          if (trigger === "resize")
            current.deinterlacer(
              "__deinterlacer.videoTimeline = [{start:0,codedSize:{width:1280,height:720},scan:{interlaced:true,topFieldFirst:true}}]",
            );
        },
      });
      assert.ok(handled, `${label}: failure did not reach the owner`);
      if (action === "withdraw") {
        assert.equal(
          control.deinterlacer("__deinterlacer.running"),
          true,
          label,
        );
        assert.equal(control.deinterlacer("__deinterlacer.film"), false, label);
        assert.ok(
          result.draws.some(
            (draw) => draw.toCanvas && draw.t > actionTime + 300,
          ),
          `${label}: plain YADIF did not resume`,
        );
        control.deinterlacer("__deinterlacer.destroy()");
        console.log(`ok ${label}`);
        cases++;
        continue;
      }
      assert.equal(
        allocations,
        atAction,
        `${label}: allocated after owner cleanup`,
      );
      assert.equal(
        result.requests.length,
        requestsAtAction,
        `${label}: re-armed after owner cleanup`,
      );
      for (const pending of Object.values(result.outstanding))
        assert.equal(pending.length, 0, `${label}: pending animation frame`);
      assert.equal(
        control.deinterlacer("__deinterlacer.running"),
        false,
        label,
      );
      if (action === "destroy") {
        assert.equal(
          control.deinterlacer("__deinterlacer.canvas.parentElement"),
          null,
          `${label}: remounted canvas`,
        );
        for (const count of Object.values(control.visibilityListeners()))
          assert.equal(count, 0, `${label}: listener left behind`);
      }
      control.deinterlacer("__deinterlacer.destroy()");
      console.log(`ok ${label}`);
      cases++;
    }
console.log(`film failure lifecycle: ${cases} cases passed`);
