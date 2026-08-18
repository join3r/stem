import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

// Episodic-store maintenance (size-cap pruning + VACUUM), parameterized by a
// DatabaseSync handle and the db path so the SAME logic serves two processes:
//   - the main process (store.ts), as the synchronous fallback
//   - the recall scan worker (scan-worker.ts), where it normally runs so a
//     multi-second VACUUM never blocks the main-process event loop
//
// Like search-core.ts this file must stay electron-free: any state it needs
// (the size limit tunable) is read from the meta table through the handle.

const EPISODIC_MAX_KEY = 'episodic_max_bytes';
/** 100 MB of chat text is effectively a safety ceiling, not a routine cap. */
export const DEFAULT_EPISODIC_MAX_BYTES = 100 * 1024 * 1024;

/** Max on-disk size for the episodic store in bytes; 0 = unlimited. */
export function readEpisodicLimitBytes(db: DatabaseSync): number {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(EPISODIC_MAX_KEY) as
      | { value?: string }
      | undefined;
    const raw = Number.parseInt(row?.value ?? '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_EPISODIC_MAX_BYTES;
  } catch {
    // quiet: an unreadable meta table is the same answer as an unset one — the
    // documented default, which is a safety ceiling nobody configures anyway.
    // This file runs inside the scan worker, which has no log path of its own;
    // reporting belongs to the caller that owns the connection.
    return DEFAULT_EPISODIC_MAX_BYTES;
  }
}

/** On-disk footprint of recall.sqlite + its WAL sidecar (uncheckpointed writes). */
export function dbSizeBytesFor(dbPath: string): number {
  let total = 0;
  for (const p of [dbPath, `${dbPath}-wal`]) {
    try {
      total += statSync(p).size;
    } catch {
      // quiet: sidecar (or db) not on disk yet — counts as 0. The absence IS the
      // measurement; a WAL that isn't there occupies nothing.
    }
  }
  return total;
}

function countMessages(db: DatabaseSync): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
}

/**
 * Trim the episodic store back under its size limit by deleting the oldest
 * messages, then VACUUM to actually reclaim the disk pages (SQLite keeps freed
 * pages otherwise, so the file — and the reported size — wouldn't shrink). Prunes
 * to ~85% of the limit so a steady trickle of new messages doesn't re-trigger a
 * VACUUM on every capture. Returns how many messages were removed.
 *
 * The messages_ad trigger keeps the FTS index in lockstep as rows are deleted.
 */
export function enforceEpisodicLimitCore(db: DatabaseSync, dbPath: string): number {
  const max = readEpisodicLimitBytes(db);
  if (max <= 0) return 0; // unlimited
  if (dbSizeBytesFor(dbPath) <= max) return 0;

  const target = Math.floor(max * 0.85);
  let deleted = 0;
  // Bounded loop: the size estimate can under-shoot (fixed facts/meta overhead),
  // so re-measure after each VACUUM and prune again if still over.
  for (let i = 0; i < 8; i++) {
    const rows = countMessages(db);
    if (rows === 0) break;
    const size = dbSizeBytesFor(dbPath);
    if (size <= target) break;
    const dropFraction = Math.min(0.9, 1 - target / size);
    const dropCount = Math.max(1, Math.ceil(rows * dropFraction));
    const cutoff = db
      .prepare(`SELECT id FROM messages ORDER BY id ASC LIMIT 1 OFFSET ?`)
      .get(dropCount) as { id?: number } | undefined;
    // No FK cascade — drop the pruned messages' cached vectors in the same pass.
    if (cutoff?.id == null) {
      db.prepare(`DELETE FROM message_vectors`).run();
      db.prepare(`DELETE FROM message_chunk_vectors`).run();
      db.prepare(`DELETE FROM message_chunks`).run();
      deleted += db.prepare(`DELETE FROM messages`).run().changes as number;
    } else {
      db.prepare(`DELETE FROM message_vectors WHERE message_id < ?`).run(cutoff.id);
      db.prepare(`DELETE FROM message_chunk_vectors WHERE message_id < ?`).run(cutoff.id);
      db.prepare(`DELETE FROM message_chunks WHERE message_id < ?`).run(cutoff.id);
      deleted += db.prepare(`DELETE FROM messages WHERE id < ?`).run(cutoff.id).changes as number;
    }
    db.exec('VACUUM');
  }
  return deleted;
}
