/**
 * The Media Source Extensions globals, for the worker program only.
 *
 * A dedicated worker has them, but `lib.webworker.d.ts` declares only
 * `MediaSourceHandle` -- not `MediaSource`, `SourceBuffer` or `TimeRanges`
 * (checked against TypeScript 5.9). `mse.ts` compiles in both programs, so on
 * the page it gets `lib.dom.d.ts` and here it gets this. They are separate
 * programs, so the two declarations never meet.
 *
 * Only what `mse.ts` touches is here; this is not a transcription of the IDL.
 * Nothing declared below is guaranteed to exist at run time -- MSE in Workers
 * is Chromium-only for now, and `MediaSource.canConstructInDedicatedWorker` on
 * the page is what decides whether this path is taken at all. See player.ts.
 */

interface TimeRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

type AppendMode = "segments" | "sequence";
type EndOfStreamError = "decode" | "network";
type ReadyState = "closed" | "ended" | "open";

interface SourceBuffer extends EventTarget {
  mode: AppendMode;
  readonly updating: boolean;
  readonly buffered: TimeRanges;
  appendBuffer(data: BufferSource): void;
  remove(start: number, end: number): void;
}

interface MediaSource extends EventTarget {
  readonly readyState: ReadyState;
  /** The transferable proxy the page attaches to a media element. */
  readonly handle: MediaSourceHandle;
  addSourceBuffer(type: string): SourceBuffer;
  endOfStream(error?: EndOfStreamError): void;
}

declare var MediaSource: {
  prototype: MediaSource;
  new (): MediaSource;
  isTypeSupported(type: string): boolean;
  readonly canConstructInDedicatedWorker: boolean;
};
