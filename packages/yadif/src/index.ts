import bundledWorkerURL from "./worker.ts?worker&url";
import { setBundledWorkerURL } from "./deinterlace.js";

setBundledWorkerURL(bundledWorkerURL);

export { Deinterlacer, supportsDeinterlace } from "./deinterlace.js";
export type {
  DeinterlaceStats,
  DeinterlacerEventMap,
  DeinterlacerOptions,
  Scan,
} from "./deinterlace.js";
export {
  decoderDeinterlaces,
  forgetDecoderProbe,
  probeDecoder,
} from "./probe.js";
export type { DecoderProbe, DecoderProbeOptions } from "./probe.js";
export { YADIF_FRAGMENT_SHADER, YADIF_UNIFORMS } from "./shader.js";
