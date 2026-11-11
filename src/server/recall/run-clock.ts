// What one request cost inside the local retrieval worker.
//
// A turn's recall time was one number (turn_timings.recall_ms), and a slow one
// could mean three different things: the model work itself was long, the
// request waited behind other work, or its runs shared the cores with other
// runs. Measured on a 16-core server in 2026-11, recall took 1 to 2 s on most
// turns and over 10 s on one in twenty, with the machine otherwise idle, and
// nothing recorded could say which of the three it was. These numbers can.
//
// Pure: no ONNX, no process state. The worker owns one clock for all its runs.

/** One request's share of the worker, in milliseconds. */
export interface RunStats {
  /** Time inside its own model runs. */
  runMs: number;
  /** The part of `runMs` during which another run was also in flight. */
  sharedMs: number;
}

/** What the worker reports back with a result. */
export interface WorkerRequestStats extends RunStats {
  /** Time between the request's arrival and its result that was not its own runs. */
  waitMs: number;
}

export function newRunStats(): RunStats {
  return { runMs: 0, sharedMs: 0 };
}

export interface RunClock {
  /** Time `fn` as one model run charged to `stats`. */
  run<T>(fn: () => Promise<T>, stats: RunStats): Promise<T>;
}

export function createRunClock(now: () => number = () => performance.now()): RunClock {
  let active = 0;
  let mark = now();
  // Wall time, since the clock started, during which two or more runs were in flight.
  let shared = 0;
  const tick = (): void => {
    const t = now();
    if (active >= 2) shared += t - mark;
    mark = t;
  };
  return {
    async run(fn, stats) {
      tick();
      active += 1;
      const start = now();
      const sharedAtStart = shared;
      try {
        return await fn();
      } finally {
        tick();
        active -= 1;
        stats.runMs += now() - start;
        // This run was in flight the whole time, so every shared millisecond
        // since it started was shared with it.
        stats.sharedMs += shared - sharedAtStart;
      }
    }
  };
}

/** The stats to send back for a request that arrived at `arrivedAt` (same clock as `now`). */
export function finishRunStats(stats: RunStats, arrivedAt: number, now: number): WorkerRequestStats {
  return {
    runMs: Math.round(stats.runMs),
    sharedMs: Math.round(stats.sharedMs),
    waitMs: Math.max(0, Math.round(now - arrivedAt - stats.runMs))
  };
}
