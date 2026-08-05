/**
 * Play an MPEG-2 transport stream in a `<video>`.
 *
 * ```ts
 * import { Mpeg2TsPlayer } from './src/index.js';
 *
 * const player = new Mpeg2TsPlayer(document.querySelector('video')!);
 * await player.load('https://example.com/video.ts');
 * ```
 */
export { Mpeg2TsPlayer, supportsWorkerMediaSource } from "./player.js";
export type { Mpeg2TsPlayerEventMap, Mpeg2TsPlayerOptions } from "./player.js";
export {
  DEFAULT_KEEP_BEHIND_SECONDS,
  DEFAULT_QUEUE_HIGH_WATER_MARK,
  type PlayerState,
  type Progress,
  type SinkKind,
  type Stats,
} from "./protocol.js";
