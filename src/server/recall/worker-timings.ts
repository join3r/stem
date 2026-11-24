import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkerRequestStats } from './run-clock';

// Collects, for one turn, what its requests to the local retrieval worker
// cost (run-clock.ts explains why). The embeddings and rerank clients are
// called many layers below the turn that wants the numbers, through interfaces
// a remote endpoint implements too, so the sink travels in the async context
// instead of through every signature: the manager reads it when a request is
// made and adds to it when the result comes back.

/** A turn's total over its worker requests, in milliseconds. */
export interface WorkerTimings {
  /** Requests answered by the worker. */
  requests: number;
  /**
   * Wall time the turn spent with a worker request out and none of its own
   * model runs going: queued behind other work, held for a model load, in
   * transit. Wall time, not a sum: a turn sends dozens of requests at once
   * (one per rerank pair for skills), and adding up each one's wait read as
   * 20 s on turns whose whole preparation took 5 s.
   */
  waitMs: number;
  /** Time inside the worker's model runs, summed over requests (two worker processes can run at once). */
  runMs: number;
  /** The part of `runMs` that shared its process with another run. */
  sharedMs: number;
}

/** Where the turn's requests and runs sat in time, caller's clock. Kept off the public shape. */
interface Intervals {
  requests: Array<[number, number]>;
  runs: Array<[number, number]>;
}

const intervals = new WeakMap<WorkerTimings, Intervals>();

export function newWorkerTimings(): WorkerTimings {
  return { requests: 0, waitMs: 0, runMs: 0, sharedMs: 0 };
}

const scope = new AsyncLocalStorage<WorkerTimings>();

/** Run `fn` with `sink` collecting the worker requests made inside it. */
export function withWorkerTimings<T>(sink: WorkerTimings | undefined, fn: () => Promise<T>): Promise<T> {
  return sink ? scope.run(sink, fn) : fn();
}

/** The sink of the turn this call belongs to, if any. Read when a request is made. */
export function currentWorkerTimings(): WorkerTimings | undefined {
  return scope.getStore();
}

/** Sorted, overlapping intervals joined. */
function merge(list: Array<[number, number]>): Array<[number, number]> {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function length(list: Array<[number, number]>): number {
  return list.reduce((sum, [a, b]) => sum + (b - a), 0);
}

/** Total overlap of two merged lists. */
function overlap(xs: Array<[number, number]>, ys: Array<[number, number]>): number {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < xs.length && j < ys.length) {
    const lo = Math.max(xs[i]![0], ys[j]![0]);
    const hi = Math.min(xs[i]![1], ys[j]![1]);
    if (hi > lo) total += hi - lo;
    if (xs[i]![1] < ys[j]![1]) i++;
    else j++;
  }
  return total;
}

/**
 * Charge one answered request to `sink`. `requestedAt` and `answeredAt` are
 * the caller's clock. A worker that sent no stats (an older build of the
 * worker file) counts as a request only: placing its time anywhere would be a
 * guess. One that sent stats without spans gets its runs placed at the end.
 */
export function noteWorkerRequest(
  sink: WorkerTimings | undefined,
  requestedAt: number,
  answeredAt: number,
  stats: WorkerRequestStats | undefined
): void {
  if (!sink) return;
  sink.requests += 1;
  if (!stats) return;
  sink.runMs += stats.runMs;
  sink.sharedMs += stats.sharedMs;
  let iv = intervals.get(sink);
  if (!iv) {
    iv = { requests: [], runs: [] };
    intervals.set(sink, iv);
  }
  iv.requests.push([requestedAt, answeredAt]);
  const spans = stats.spans ?? [stats.runMs, 0];
  for (let k = 0; k + 1 < spans.length; k += 2) {
    // Counted back from the result; clipped to the request, since the two clocks only roughly agree.
    const a = Math.max(requestedAt, answeredAt - spans[k]!);
    const b = Math.min(answeredAt, answeredAt - spans[k + 1]!);
    iv.runs.push([a, b]);
  }
  const requests = merge(iv.requests);
  sink.waitMs = Math.max(0, Math.round(length(requests) - overlap(requests, merge(iv.runs))));
}
