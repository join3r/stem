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
/**
 * The cap counts chat text only (UTF-8 bytes of captured messages), not the db
 * file. Search vectors, facts and summaries are most of the file — a few MB of
 * chat carries ~60 MB of vectors — and pruning messages can't shrink the fact or
 * summary share at all, so a file-size cap erased history long before 100 MB of
 * chat existed. Against chat text, 100 MB is a safety ceiling, not a routine cap.
 */
export const DEFAULT_EPISODIC_MAX_BYTES = 100 * 1024 * 1024;

/** Max chat text kept in the episodic store, in bytes; 0 = unlimited. */
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

/** UTF-8 bytes of all captured message text — what the episodic limit counts. */
export function chatTextBytes(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS n FROM messages`).get() as { n: number };
  return row.n;
}

/**
 * Trim the episodic store back under its chat-text limit by deleting the oldest
 * messages (and their cached vectors and chunks), then VACUUM so the freed pages
 * leave the file. Prunes to ~85% of the limit so a steady trickle of new
 * messages doesn't re-trigger a VACUUM on every capture. Returns how many
 * messages were removed.
 *
 * The messages_ad trigger keeps the FTS index in lockstep as rows are deleted.
 */
export function enforceEpisodicLimitCore(db: DatabaseSync, dbPath: string): number {
  const max = readEpisodicLimitBytes(db);
  if (max <= 0) return 0; // unlimited
  // Cheap gate first: chat text is part of the file, so a file under the limit
  // can't hold chat text over it — no need to scan the messages table.
  if (dbSizeBytesFor(dbPath) <= max) return 0;
  if (chatTextBytes(db) <= max) return 0;

  const target = Math.floor(max * 0.85);
  // Oldest message that still fits when keeping newest-first up to the target.
  const keep = db
    .prepare(
      `SELECT MIN(id) AS id FROM (
         SELECT id, SUM(length(CAST(text AS BLOB))) OVER (ORDER BY id DESC) AS kept FROM messages
       ) WHERE kept <= ?`
    )
    .get(target) as { id: number | null } | undefined;
  // No FK cascade — drop the pruned messages' cached vectors in the same pass.
  let deleted: number;
  if (keep?.id == null) {
    db.prepare(`DELETE FROM message_vectors`).run();
    db.prepare(`DELETE FROM message_chunk_vectors`).run();
    db.prepare(`DELETE FROM message_chunks`).run();
    deleted = db.prepare(`DELETE FROM messages`).run().changes as number;
  } else {
    db.prepare(`DELETE FROM message_vectors WHERE message_id < ?`).run(keep.id);
    db.prepare(`DELETE FROM message_chunk_vectors WHERE message_id < ?`).run(keep.id);
    db.prepare(`DELETE FROM message_chunks WHERE message_id < ?`).run(keep.id);
    deleted = db.prepare(`DELETE FROM messages WHERE id < ?`).run(keep.id).changes as number;
  }
  if (deleted > 0) db.exec('VACUUM');
  return deleted;
}
