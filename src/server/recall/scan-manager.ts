import { degrade } from '../degrade';
import type { WorkerTransport } from './embed-worker-host';
import type { ScanRequestOptions, ScanWorkerOutMessage } from './scan-worker';
import type { CoreDocHit, CoreSearchHit, CoreSummaryHit, DocScanOptions } from './search-core';

// Main-process side of the recall scan worker: owns the utility-process
// lifecycle (lazy spawn on first request, respawn on crash with a strike cap)
// and multiplexes scan/maintenance requests over it. Deliberately simpler than
// the embed manager — there is no model to download, so there are no status
// states: a request either round-trips or rejects, and every caller has a
// synchronous in-process fallback (see scan.ts), so rejections degrade to
// exactly the pre-worker behavior.

export interface ScanWorkerManager {
  /** Cosine top-N over message vectors, off the main event loop. */
  scanMessages(vec: Float32Array, model: string, opts: ScanRequestOptions): Promise<CoreSearchHit[]>;
  /** Cosine top-N over thread-summary vectors, off the main event loop. */
  scanSummaries(vec: Float32Array, model: string, opts: ScanRequestOptions): Promise<CoreSummaryHit[]>;
  /** Cosine top-N over one folder index's doc vectors (its own db file), off the main event loop. */
  scanDocs(dbFile: string, vec: Float32Array, model: string, opts: DocScanOptions): Promise<CoreDocHit[]>;
  /**
   * Close the worker's cached handle on one folder index, awaited before main
   * deletes the file — Windows can't unlink a file the worker still holds open.
   * Resolves immediately when no worker is running (it holds nothing then).
   */
  evictDocDb(dbFile: string): Promise<void>;
  /** Episodic size-cap enforcement (prune + VACUUM). Resolves with rows deleted. */
  maintain(): Promise<number>;
  /** Plain VACUUM (disk reclaim after an episodic reset). */
  vacuum(): Promise<void>;
  dispose(): void;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SCAN_TIMEOUT_MS = 10_000;
// Pruning can chain several DELETE+VACUUM rounds over a ~100 MB file.
const MAINTAIN_TIMEOUT_MS = 120_000;
// After MAX_STRIKES consecutive spawn failures/crashes, stop respawning for this
// long — callers fail fast into their in-process fallback instead of paying a
// spawn attempt per turn against a broken worker.
const RETRY_AFTER_MS = 60_000;
const MAX_STRIKES = 3;

export function createScanWorkerManager(deps: {
  spawn: () => WorkerTransport;
  dbPath: () => string;
  scanTimeoutMs?: number;
  maintainTimeoutMs?: number;
}): ScanWorkerManager {
  const scanTimeoutMs = deps.scanTimeoutMs ?? SCAN_TIMEOUT_MS;
  const maintainTimeoutMs = deps.maintainTimeoutMs ?? MAINTAIN_TIMEOUT_MS;

  let transport: WorkerTransport | null = null;
  let disposed = false;
  let strikes = 0;
  let lastStrikeAt = 0;
  let nextId = 1;
  const inflight = new Map<number, Pending>();

  function failInflight(message: string): void {
    const err = new Error(message);
    for (const p of inflight.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    inflight.clear();
  }

  function handleMessage(raw: unknown): void {
    const msg = raw as ScanWorkerOutMessage;
    const p = inflight.get(msg.id);
    if (!p) return; // timed out already
    inflight.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === 'error') {
      p.reject(new Error(`recall scan worker: ${msg.message}`));
      return;
    }
    // A successful round-trip proves the worker healthy — refund the strike
    // budget so a long-lived worker that eventually crashes gets fresh respawns.
    strikes = 0;
    const value =
      msg.type === 'message-hits' || msg.type === 'summary-hits' || msg.type === 'doc-hits'
        ? msg.hits
        : msg.type === 'maintained'
          ? msg.deleted
          : undefined;
    p.resolve(value as never);
  }

  /** Spawn (or reuse) the worker; null when disposed or striked out. */
  function ensure(): WorkerTransport | null {
    if (disposed) return null;
    if (transport) return transport;
    if (strikes >= MAX_STRIKES && Date.now() - lastStrikeAt < RETRY_AFTER_MS) return null;
    if (strikes >= MAX_STRIKES) strikes = 0; // retry window elapsed — fresh budget
    let t: WorkerTransport;
    try {
      t = deps.spawn();
    } catch (err) {
      // Callers only ever see 'not running'; the reason the spawn failed — a
      // missing worker bundle, a sandbox refusing the process — lives here and
      // nowhere else.
      degrade('recall.scan', 'left the scan worker down and counted a strike', err);
      strikes += 1;
      lastStrikeAt = Date.now();
      return null;
    }
    transport = t;
    // Identity-guarded: a superseded worker's late messages must not resolve the
    // replacement's requests.
    t.onMessage((msg) => {
      if (transport === t) handleMessage(msg);
    });
    t.onExit(() => {
      if (transport !== t) return; // superseded by dispose
      transport = null;
      strikes += 1;
      lastStrikeAt = Date.now();
      failInflight('recall scan worker exited');
    });
    t.send({ type: 'init', dbPath: deps.dbPath() });
    return t;
  }

  function request<T>(
    build: (id: number) => Record<string, unknown>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = ensure();
      if (!t) {
        reject(new Error('recall scan worker not running'));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error(`recall scan worker: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      inflight.set(id, { resolve: resolve as (value: never) => void, reject, timer });
      t.send(build(id));
    });
  }

  return {
    scanMessages(vec, model, opts) {
      return request<CoreSearchHit[]>(
        (id) => ({ type: 'scan-messages', id, vec, model, ...opts }),
        scanTimeoutMs
      );
    },
    scanSummaries(vec, model, opts) {
      return request<CoreSummaryHit[]>(
        (id) => ({ type: 'scan-summaries', id, vec, model, ...opts }),
        scanTimeoutMs
      );
    },
    scanDocs(dbFile, vec, model, opts) {
      return request<CoreDocHit[]>(
        (id) => ({ type: 'scan-docs', id, vec, model, dbFile, ...opts }),
        scanTimeoutMs
      );
    },
    evictDocDb(dbFile) {
      // Deliberately does not go through ensure(): dropping an index must never
      // be the thing that spawns a worker.
      if (!transport) return Promise.resolve();
      return request<void>((id) => ({ type: 'evict-doc-db', id, dbFile }), scanTimeoutMs);
    },
    maintain() {
      return request<number>((id) => ({ type: 'maintain', id }), maintainTimeoutMs);
    },
    vacuum() {
      return request<void>((id) => ({ type: 'vacuum', id }), maintainTimeoutMs);
    },
    dispose() {
      disposed = true;
      const t = transport;
      transport = null; // cleared first so onExit doesn't count a strike
      t?.kill();
      failInflight('recall scan worker disposed');
    }
  };
}
