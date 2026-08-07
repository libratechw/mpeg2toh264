/**
 * The bundler's inline-worker import.
 *
 * A worker referenced by URL becomes an asset beside the bundle, and an asset
 * referenced from inside another asset is one level deeper than a consumer's
 * bundler will follow: the demo builds against this package's built output, so
 * it re-emits `worker.js` and leaves whatever that file names behind. Inlining
 * puts the picture worker inside its parent instead, which costs a few
 * kilobytes and nothing else, and leaves one level of asset to carry.
 */
declare module "*?worker&inline" {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
