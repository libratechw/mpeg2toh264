/**
 * What the deinterlacer needs from the browser around it.
 *
 * These decisions are kept apart from the filter so they can be exercised
 * without a display or a clock: which window drives the loop, which
 * presentation times are worth believing, and what size a captured picture
 * should come back at.
 */

/**
 * How far `expectedDisplayTime` may sit from `now` and still describe the frame
 * the callback is for, in milliseconds.
 *
 * The callback runs at or just after the moment it reports, so a usable value
 * is near `now`; a late callback pushes it into the past by a few refreshes at
 * most. A whole second is far past any real notification delay, so a value
 * further away is not about this frame at all -- Safari returns a large
 * negative number, and trusting it would put every scheduled moment in the
 * distant past and drop the second field of every pair.
 */
export const EXPECTED_DISPLAY_TIME_TOLERANCE_MS = 1000;

/**
 * The moment to time a frame from.
 *
 * Returns `expected` only when it is a real, positive moment near `now`;
 * otherwise the frame's own callback time (`now`) is used, which is what the
 * filter did before it had any expected time to trust.
 */
export function usableExpectedDisplayTime(
  expected: unknown,
  now: number,
): number {
  if (
    typeof expected !== "number" ||
    !(expected > 0) ||
    !Number.isFinite(expected) ||
    Math.abs(expected - now) >= EXPECTED_DISPLAY_TIME_TOLERANCE_MS
  ) {
    return now;
  }
  return expected;
}

/**
 * The window whose `requestAnimationFrame` should drive the loop.
 *
 * The rAF grid and the `requestVideoFrameCallback` moments are only comparable
 * within one window. When the element moves to another document (Document
 * Picture-in-Picture), its frame callbacks move to that window's timebase too,
 * so the loop has to follow the canvas rather than keep its first window.
 */
export function loopWindowFor(canvas: HTMLCanvasElement): Window {
  return canvas.ownerDocument?.defaultView ?? window;
}

/**
 * The size a captured picture should come back at.
 *
 * The canvas holds coded pixels; the element's picture is those stretched to
 * its display shape (the sample aspect ratio). Returning the element's size
 * keeps the ratio the viewer sees in the saved image. Falls back to the coded
 * size when the element has not reported one.
 */
export function captureSize(
  videoWidth: number,
  videoHeight: number,
  codedWidth: number,
  codedHeight: number,
): { width: number; height: number } {
  return {
    width: videoWidth || codedWidth,
    height: videoHeight || codedHeight,
  };
}
