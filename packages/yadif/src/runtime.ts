/**
 * What the deinterlacer needs from the browser around it.
 *
 * These decisions are kept apart from the filter so they can be exercised
 * without a display or a clock: which window drives the loop, which
 * presentation times are worth believing, and what size a captured picture
 * should come back at.
 */

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
