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
  /** Time the requests were not being computed: queued, held for a model load, in transit. */
  waitMs: number;
  /** Time inside the worker's model runs. */
  runMs: number;
  /** The part of `runMs` that shared the cores with another run. */
  sharedMs: number;
}

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

/**
 * Charge one answered request to `sink`. `wallMs` is the caller's wait for it.
 * A worker that sent no stats (an older build of the worker file) counts as a
 * request only: adding its wall time to either side would be a guess.
 */
export function noteWorkerRequest(sink: WorkerTimings | undefined, wallMs: number, stats: WorkerRequestStats | undefined): void {
  if (!sink) return;
  sink.requests += 1;
  if (!stats) return;
  sink.runMs += stats.runMs;
  sink.sharedMs += stats.sharedMs;
  sink.waitMs += Math.max(0, Math.round(wallMs) - stats.runMs);
}
