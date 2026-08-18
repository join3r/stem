import type { DatabaseSync } from 'node:sqlite';
import type { ScanWorkerManager } from './scan-manager';
import type { ScanRequestOptions } from './scan-worker';
import {
  semanticSearchDocsCore,
  semanticSearchMessagesCore,
  semanticSearchSummariesCore,
  type CoreDocHit,
  type CoreSearchHit,
  type CoreSummaryHit,
  type DocScanOptions,
  type QueryEmbedding
} from './search-core';
import { degrade } from '../degrade';
import { recallStore } from './store';
const { dbHandle, enforceEpisodicLimit } = recallStore;

// App-global registry for the recall scan worker (mirrors retrieval.ts for the
// embedding clients). Set once from main at startup; read by the episodic
// search paths (search.ts, inject.ts) and the capture maintenance tap. Every
// entry point degrades to the synchronous in-process implementation when the
// worker is unset (unit tests) or failing — behavior is then byte-identical to
// the pre-worker code, just back on the main event loop. Identical results are
// exactly why a dead worker is invisible: nothing is wrong with the answers,
// every scan is simply back on the hot path. So each fallback reports itself.

let manager: ScanWorkerManager | null = null;

export function setScanWorkerManager(m: ScanWorkerManager | null): void {
  manager = m;
}

/** Cosine leg of the episodic message search, off-thread when possible. */
export async function scanMessagesOffThread(
  qe: QueryEmbedding,
  opts: ScanRequestOptions
): Promise<CoreSearchHit[]> {
  if (manager) {
    try {
      return await manager.scanMessages(qe.vec, qe.model, opts);
    } catch (err) {
      degrade('recall.scan', 'scanned messages in-process instead of on the worker', err);
    }
  }
  return semanticSearchMessagesCore(dbHandle(), qe.vec, qe.model, opts);
}

/** Cosine leg of the thread-summary search, off-thread when possible. */
export async function scanSummariesOffThread(
  qe: QueryEmbedding,
  opts: ScanRequestOptions
): Promise<CoreSummaryHit[]> {
  if (manager) {
    try {
      return await manager.scanSummaries(qe.vec, qe.model, opts);
    } catch (err) {
      degrade('recall.scan', 'scanned thread summaries in-process instead of on the worker', err);
    }
  }
  return semanticSearchSummariesCore(dbHandle(), qe.vec, qe.model, opts);
}

/**
 * Cosine leg of a folder-index document search, off-thread when possible. The
 * folder index is its own db file, so the worker gets its path; the in-process
 * fallback uses the caller's live handle (same degrade rule as messages).
 */
export async function scanDocsOffThread(
  dbFile: string,
  fallbackHandle: () => DatabaseSync,
  qe: QueryEmbedding,
  opts: DocScanOptions
): Promise<CoreDocHit[]> {
  if (manager) {
    try {
      return await manager.scanDocs(dbFile, qe.vec, qe.model, opts);
    } catch (err) {
      degrade('recall.scan', 'scanned folder-index docs in-process instead of on the worker', err);
    }
  }
  return semanticSearchDocsCore(fallbackHandle(), qe.vec, qe.model, opts);
}

// A healthy worker acknowledges an eviction in microseconds; this cap is only
// about a wedged one, whose request would otherwise sit for the full scan
// timeout. Deleting the index is the user-visible operation and must not wait
// on the worker to be well.
const EVICT_WAIT_MS = 2_000;

/**
 * Tell the worker to drop its cached handle on one folder index, before the
 * file is deleted. Briefly awaited — on Windows the delete fails outright while
 * the worker still holds the file open — but it can neither fail nor stall the
 * caller: a worker that is down, wedged or absent gives up its turn after
 * EVICT_WAIT_MS, and the worker re-checks file identity on reuse regardless, so
 * a missed eviction still self-heals.
 */
export async function evictDocScanHandle(dbFile: string): Promise<void> {
  if (!manager) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    // quiet: the timeout below is the real contract — a worker that is down or
    // wedged never answers at all, and that path is already silent by design.
    // The worker re-checks file identity on reuse, so a missed eviction heals.
    manager.evictDocDb(dbFile).catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, EVICT_WAIT_MS);
    })
  ]);
  clearTimeout(timer);
}

/**
 * Episodic size-cap enforcement (prune + VACUUM), fire-and-forget. Runs in the
 * worker when available; only a worker failure falls back to the synchronous
 * in-process pass — disk hygiene must not silently stop when the worker breaks.
 */
export function requestEpisodicMaintenance(): void {
  if (manager) {
    manager.maintain().catch(() => {
      try {
        enforceEpisodicLimit();
      } catch (err) {
        // Pruning must never break capture — but the worker and this fallback
        // both failing means the store keeps growing against a cap the user
        // set and no pass will notice on its own.
        degrade('recall.maintenance', 'left the episodic store over its size cap', err);
      }
    });
    return;
  }
  enforceEpisodicLimit();
}

/** VACUUM recall.sqlite (disk reclaim after an episodic reset), off-thread when possible. */
export async function vacuumRecallDb(): Promise<void> {
  if (manager) {
    try {
      await manager.vacuum();
      return;
    } catch (err) {
      degrade('recall.scan', 'vacuumed recall.sqlite on the main thread instead of on the worker', err);
    }
  }
  dbHandle().exec('VACUUM');
}
