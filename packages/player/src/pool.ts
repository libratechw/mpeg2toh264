/**
 * A handful of workers converting one group of pictures at once.
 *
 * The conversion is most of what the transcoder costs and it divides cleanly:
 * a picture carries everything it is coded against, so where it is converted
 * cannot reach the output. What cannot be divided -- demuxing, splitting the
 * stream into groups, the plan that decides what each picture is coded against,
 * and the muxing -- stays in the worker that owns the session, and is under a
 * tenth of the work.
 *
 * There is no shared memory here. Without cross-origin isolation there is no
 * `SharedArrayBuffer`, so each worker holds a WebAssembly instance of its own
 * and jobs and results cross as transferred `ArrayBuffer`s, which move rather
 * than copy. The compiled module is shared instead, which is what stops each
 * worker fetching and compiling the same bytes over again.
 */
import PictureWorker from "./picture-worker.js?worker&inline";
import type {
  PictureWorkerRequest,
  PictureWorkerResponse,
} from "./picture-worker.js";

/**
 * How many pictures to convert at once when the caller does not say.
 *
 * One less than the machine has, because the worker that owns the session is
 * itself busy between units and would otherwise be competing with the pool for
 * the core it needs to plan the next one. Capped because the gain flattens --
 * a group of pictures is only fifteen or so frames, and each worker costs its
 * own scratch, which at an HD macroblock count is tens of megabytes.
 */
export function defaultPoolSize(): number {
  const cores = self.navigator?.hardwareConcurrency ?? 1;
  return Math.max(1, Math.min(4, cores - 1));
}

/** How long to wait for the workers to come up before giving up on them. */
const READY_TIMEOUT_MS = 10_000;

/** What a cancelled run rejects with. See `cancel`. */
const CANCELLED = "the group of pictures was abandoned";

interface Pending {
  /** Which run this is, so that a result of an earlier one is recognised. */
  run: number;
  outputs: (Uint8Array | null)[];
  /** Jobs not yet handed to a worker, with the slot each belongs in. */
  queued: { index: number; job: Uint8Array }[];
  remaining: number;
  resolve: (outputs: Uint8Array[]) => void;
  reject: (error: unknown) => void;
}

export class PicturePool {
  #workers: Worker[];
  #idle: Worker[] = [];
  #pending: Pending | null = null;
  #runs = 0;
  #broken: string | null = null;

  private constructor(workers: Worker[]) {
    this.#workers = workers;
    this.#idle = [...workers];
  }

  get size(): number {
    return this.#workers.length;
  }

  /**
   * Bring up a pool, or return null if this browser will not have one.
   *
   * A worker cannot always spawn a worker, and a page that is not being served
   * the way the module expects will fail to load it. Neither is worth failing
   * the playback over: the session converts the pictures itself when there is
   * no pool, which is what it did before there was one. So everything that
   * could go wrong is made to go wrong here, before any picture depends on it.
   */
  static async create(
    module: WebAssembly.Module,
    size: number,
  ): Promise<PicturePool | null> {
    const workers: Worker[] = [];
    try {
      for (let index = 0; index < size; index += 1)
        workers.push(new PictureWorker());
      await Promise.all(workers.map((worker) => start(worker, module)));
    } catch {
      for (const worker of workers) worker.terminate();
      return null;
    }
    const pool = new PicturePool(workers);
    for (const worker of workers) {
      worker.onmessage = ({ data }: MessageEvent<PictureWorkerResponse>) =>
        pool.#took(worker, data);
      worker.onerror = () => pool.#break("a picture worker stopped");
    }
    return pool;
  }

  /**
   * Convert one unit's pictures, giving them back in the order they came.
   *
   * The queue is shared rather than dealt out a share each, because the
   * pictures of one unit are not the same size of job: the one that opens a
   * random access point is the only one that reconstructs samples, and costs
   * several times what the rest do.
   */
  run(jobs: Uint8Array[]): Promise<Uint8Array[]> {
    if (this.#broken) return Promise.reject(new Error(this.#broken));
    if (this.#pending) {
      return Promise.reject(
        new Error("the pool is already converting a group of pictures"),
      );
    }
    if (jobs.length === 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this.#pending = {
        run: ++this.#runs,
        outputs: jobs.map(() => null),
        queued: jobs.map((job, index) => ({ index, job })),
        remaining: jobs.length,
        resolve,
        reject,
      };
      this.#fill();
    });
  }

  /**
   * Give up on the run in hand, because nobody wants what it is making.
   *
   * A seek abandons the leg being read, and the group of pictures halfway
   * through conversion belongs to it. A worker cannot be interrupted -- coding
   * a picture is one synchronous call into WebAssembly -- so this does not stop
   * the work; it stops waiting for it. The pictures still in flight come back
   * marked with the run they were sent for, are recognised as answering nothing
   * and dropped, and each worker joins the run that follows as it comes free.
   *
   * Without this the seek's first group meets a pool that is still busy, and
   * `run` refuses it.
   */
  cancel(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    pending.reject(new Error(CANCELLED));
  }

  terminate(): void {
    for (const worker of this.#workers) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    this.#workers = [];
    this.#idle = [];
    this.#break("the pool was shut down");
  }

  /** Hand out as much of the queue as there are workers free for. */
  #fill(): void {
    const pending = this.#pending;
    if (!pending) return;
    for (;;) {
      const worker = this.#idle.pop();
      if (!worker) return;
      const next = pending.queued.shift();
      if (!next) {
        this.#idle.push(worker);
        return;
      }
      const request: PictureWorkerRequest = {
        type: "encode",
        run: pending.run,
        ...next,
      };
      // Nobody here holds the job once it has gone, so it moves rather than
      // being copied a third time.
      worker.postMessage(request, [next.job.buffer as ArrayBuffer]);
    }
  }

  #took(worker: Worker, message: PictureWorkerResponse): void {
    if (message.type === "ready") return;
    this.#idle.push(worker);
    const pending = this.#pending;
    if (!pending) return;
    if (message.run !== pending.run) {
      // A picture of a run that was cancelled. The output goes nowhere; the
      // worker that made it is what the run in hand wants.
      this.#fill();
      return;
    }
    if (message.type === "failed") {
      this.#pending = null;
      pending.reject(new Error(message.message));
      return;
    }
    pending.outputs[message.index] = message.output;
    pending.remaining -= 1;
    if (pending.remaining > 0) {
      this.#fill();
      return;
    }
    this.#pending = null;
    pending.resolve(pending.outputs as Uint8Array[]);
  }

  #break(reason: string): void {
    this.#broken ??= reason;
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    pending.reject(new Error(reason));
  }
}

/** Hand a worker its module and wait for it to say it is up. */
function start(worker: Worker, module: WebAssembly.Module): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = self.setTimeout(
      () => reject(new Error("a picture worker did not start")),
      READY_TIMEOUT_MS,
    );
    worker.onerror = (event) => {
      self.clearTimeout(timer);
      reject(new Error(event.message || "a picture worker failed to load"));
    };
    worker.onmessage = ({ data }: MessageEvent<PictureWorkerResponse>) => {
      if (data.type !== "ready") return;
      self.clearTimeout(timer);
      resolve();
    };
    const request: PictureWorkerRequest = { type: "start", module };
    worker.postMessage(request);
  });
}
