import { DatabaseSync } from 'node:sqlite';
import type { FolderIndexStatus } from '../../shared/types';

// Storage layer for ONE indexed connected folder: a dedicated SQLite file
// (userData/folder-index/<folderId>.sqlite) holding the folder's text documents,
// an FTS5 mirror, and per-(doc, model) embedding vectors. Deliberately a
// separate database per folder — recall.sqlite stays small and hot, and
// disconnecting a folder is just deleting its file. Mirrors the proven
// recall/store.ts idioms: node:sqlite, WAL, external-content FTS5 kept in
// lockstep via triggers (unicode61 so Slovak/German/English all tokenize),
// vectors as raw little-endian Float32Array blobs keyed by embedding model.
//
// The folder on disk is the source of truth (mirror semantics): the scanner
// upserts what it sees and prunes rows for files that disappeared. `last_seen`
// carries the scan generation so pruning is one DELETE, not an IN-list.

/** A document to upsert (one text file). */
export interface FolderDoc {
  /** Folder-relative path with '/' separators — the stable identity. */
  relPath: string;
  title: string;
  text: string;
  /** File mtime, Unix milliseconds (change detection fast path with size). */
  mtime: number;
  size: number;
  /** Content hash — unchanged hash skips the reindex (and keeps vectors). */
  hash: string;
}

export interface DocMissingVector {
  id: number;
  title: string;
  text: string;
}

/** Scan-side counters persisted to meta and surfaced in the Folders tab. */
export interface ScanStats {
  skippedByExt: Record<string, number>;
  lastScanTs: number;
}

/** One doc awaiting fact distillation (learned_hash missing or stale). */
export interface PendingLearnDoc {
  id: number;
  relPath: string;
  title: string;
  text: string;
  /** File mtime, Unix milliseconds. */
  mtime: number;
  hash: string;
}

const SCHEMA_VERSION = '1';

/**
 * Documents shorter than this carry no retrievable signal and are excluded from
 * embedding (they stay FTS-searchable). Matches EPISODIC_EMBED_MIN_CHARS.
 */
export const DOC_EMBED_MIN_CHARS = 20;

export class FolderIndexStore {
  private db: DatabaseSync | null = null;

  constructor(private readonly dbPath: () => string) {}

  /** The index's on-disk file — the recall scan worker opens its own connection to it. */
  file(): string {
    return this.dbPath();
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    const handle = new DatabaseSync(this.dbPath());
    handle.exec('PRAGMA journal_mode = WAL;');
    handle.exec('PRAGMA busy_timeout = 5000;');
    handle.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id           INTEGER PRIMARY KEY,
        rel_path     TEXT NOT NULL UNIQUE,
        title        TEXT NOT NULL,
        text         TEXT NOT NULL,
        mtime        INTEGER NOT NULL,
        size         INTEGER NOT NULL,
        hash         TEXT NOT NULL,
        indexed_at   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL DEFAULT 0,
        learned_hash TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        text,
        content='docs',
        content_rowid='id',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, old.text);
        DELETE FROM doc_vectors WHERE doc_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE OF text ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO docs_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TABLE IF NOT EXISTS doc_vectors (
        doc_id     INTEGER NOT NULL,
        model      TEXT NOT NULL,
        dim        INTEGER NOT NULL,
        vec        BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (doc_id, model)
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Column added after v1 index DBs shipped; ALTER is a no-op error when the
    // CREATE above already included it.
    try {
      handle.exec(`ALTER TABLE docs ADD COLUMN learned_hash TEXT`);
    } catch {
      // quiet: the column is already there — the error IS the check.
    }
    handle
      .prepare(`INSERT INTO meta (key, value) VALUES ('folder_index_schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(SCHEMA_VERSION);
    this.db = handle;
    return handle;
  }

  /** The raw handle, for the shared search-core legs. */
  handle(): DatabaseSync {
    return this.open();
  }

  /**
   * The (mtime, size, hash) of every known doc, keyed by rel path — the
   * scanner's change-detection map, loaded once per scan.
   */
  knownDocs(): Map<string, { id: number; mtime: number; size: number; hash: string }> {
    const rows = this.open()
      .prepare(`SELECT id, rel_path AS relPath, mtime, size, hash FROM docs`)
      .all() as Array<{ id: number; relPath: string; mtime: number; size: number; hash: string }>;
    return new Map(rows.map((r) => [r.relPath, { id: r.id, mtime: r.mtime, size: r.size, hash: r.hash }]));
  }

  /** Insert or replace a doc; a changed hash drops its stale vectors. */
  upsertDoc(doc: FolderDoc, scanGen: number): void {
    const db = this.open();
    const prior = db.prepare(`SELECT id, hash FROM docs WHERE rel_path = ?`).get(doc.relPath) as
      | { id: number; hash: string }
      | undefined;
    const now = Math.floor(Date.now() / 1000);
    if (!prior) {
      db.prepare(
        `INSERT INTO docs (rel_path, title, text, mtime, size, hash, indexed_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(doc.relPath, doc.title, doc.text, doc.mtime, doc.size, doc.hash, now, scanGen);
      return;
    }
    db.prepare(
      `UPDATE docs SET title = ?, text = ?, mtime = ?, size = ?, hash = ?, indexed_at = ?, last_seen = ?
       WHERE id = ?`
    ).run(doc.title, doc.text, doc.mtime, doc.size, doc.hash, now, scanGen, prior.id);
    // Content changed → the cached vectors describe the old text.
    if (prior.hash !== doc.hash) {
      db.prepare(`DELETE FROM doc_vectors WHERE doc_id = ?`).run(prior.id);
    }
  }

  /** Mark an unchanged doc as still present (metadata refresh only). */
  touchDoc(id: number, mtime: number, size: number, scanGen: number): void {
    this.open()
      .prepare(`UPDATE docs SET mtime = ?, size = ?, last_seen = ? WHERE id = ?`)
      .run(mtime, size, scanGen, id);
  }

  /**
   * Drop every doc the scan generation didn't touch — files deleted or renamed
   * since the last scan. The delete trigger cleans FTS and vectors.
   */
  pruneNotSeen(scanGen: number): number {
    const db = this.open();
    const gone = (db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE last_seen <> ?`).get(scanGen) as { n: number }).n;
    if (gone > 0) db.prepare(`DELETE FROM docs WHERE last_seen <> ?`).run(scanGen);
    return gone;
  }

  /** Run `mutate` inside one transaction (a whole scan's writes commit atomically). */
  transaction<T>(mutate: () => T): T {
    const db = this.open();
    db.exec('BEGIN');
    try {
      const result = mutate();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The next scan generation (monotonic, persisted in meta). */
  nextScanGeneration(): number {
    const db = this.open();
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'scan_generation'`).get() as
      | { value: string }
      | undefined;
    const next = (Number.parseInt(row?.value ?? '0', 10) || 0) + 1;
    db.prepare(`INSERT INTO meta (key, value) VALUES ('scan_generation', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
    return next;
  }

  writeScanStats(stats: ScanStats): void {
    this.open()
      .prepare(`INSERT INTO meta (key, value) VALUES ('scan_stats', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(stats));
  }

  /** Index health for the Folders tab; safe defaults on a fresh/empty DB. */
  readStatus(): FolderIndexStatus {
    const db = this.open();
    const indexedCount = (db.prepare(`SELECT COUNT(*) AS n FROM docs`).get() as { n: number }).n;
    const pendingEmbeds = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM docs d
         WHERE LENGTH(d.text) >= ${DOC_EMBED_MIN_CHARS}
           AND NOT EXISTS (SELECT 1 FROM doc_vectors v WHERE v.doc_id = d.id)`
      )
      .get() as { n: number }).n;
    let skippedByExt: Record<string, number> = {};
    let lastScanTs: number | null = null;
    try {
      const raw = db.prepare(`SELECT value FROM meta WHERE key = 'scan_stats'`).get() as
        | { value: string }
        | undefined;
      if (raw) {
        const stats = JSON.parse(raw.value) as ScanStats;
        if (stats && typeof stats === 'object') {
          skippedByExt = stats.skippedByExt ?? {};
          lastScanTs = typeof stats.lastScanTs === 'number' ? stats.lastScanTs : null;
        }
      }
    } catch {
      // quiet: corrupt stats read as zeros, and the next scan rewrites them.
    }
    const skippedCount = Object.values(skippedByExt).reduce((s, n) => s + n, 0);
    return {
      indexedCount,
      skippedCount,
      skippedByExt,
      pendingEmbeds,
      lastScanTs,
      totalTextChars: this.totalTextChars(),
      // `facts` counts live in recall.sqlite; the orchestrator fills them in.
      learn: { pending: this.pendingLearnCount(), facts: 0, lastTs: this.readLearnTs() }
    };
  }

  /** Docs (≥ min length) lacking a vector for `model`, oldest first. */
  getDocsMissingVector(model: string, limit: number): DocMissingVector[] {
    return this.open()
      .prepare(
        `SELECT d.id AS id, d.title AS title, d.text AS text
         FROM docs d
         WHERE LENGTH(d.text) >= ${DOC_EMBED_MIN_CHARS}
           AND NOT EXISTS (SELECT 1 FROM doc_vectors v WHERE v.doc_id = d.id AND v.model = ?)
         ORDER BY d.id
         LIMIT ?`
      )
      .all(model, limit) as unknown as DocMissingVector[];
  }

  upsertDocVector(docId: number, model: string, vec: Float32Array): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.open()
      .prepare(
        `INSERT INTO doc_vectors (doc_id, model, dim, vec, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(doc_id, model) DO UPDATE SET
           dim = excluded.dim, vec = excluded.vec, updated_at = excluded.updated_at`
      )
      .run(docId, model, vec.length, buf, Math.floor(Date.now() / 1000));
  }

  /** Vector hygiene on a model switch: stale-model rows are never read again. */
  pruneVectorsExceptModel(model: string): void {
    this.open().prepare(`DELETE FROM doc_vectors WHERE model <> ?`).run(model);
  }

  // ---- fact learning ('new'/'all' modes) ----
  //
  // learned_hash marks the content each doc was last distilled at. Pending =
  // never distilled (NULL, the 'all' backlog) or edited since (hash mismatch).
  // Mode seeding is just stamping: 'new' stamps everything ("start from now"),
  // 'all' stamps nothing. Oldest-first ordering matters: the supersede/conflict
  // machinery assumes newer information arrives later, mirroring chat chronology.

  /** Docs awaiting distillation, oldest mtime first. */
  pendingLearnDocs(limit: number): PendingLearnDoc[] {
    return this.open()
      .prepare(
        `SELECT id, rel_path AS relPath, title, text, mtime, hash
         FROM docs
         WHERE learned_hash IS NULL OR learned_hash <> hash
         ORDER BY mtime ASC, id ASC
         LIMIT ?`
      )
      .all(limit) as unknown as PendingLearnDoc[];
  }

  pendingLearnCount(): number {
    return (this.open()
      .prepare(`SELECT COUNT(*) AS n FROM docs WHERE learned_hash IS NULL OR learned_hash <> hash`)
      .get() as { n: number }).n;
  }

  /** Mark docs as distilled at their current content. */
  stampLearned(ids: number[]): void {
    if (ids.length === 0) return;
    const marks = ids.map(() => '?').join(', ');
    this.open().prepare(`UPDATE docs SET learned_hash = hash WHERE id IN (${marks})`).run(...ids);
  }

  /** Seed for 'new' mode: everything currently indexed counts as already learned. */
  stampAllLearned(): void {
    this.open().prepare(`UPDATE docs SET learned_hash = hash`).run();
  }

  /** Total indexed text volume — the "≈N model calls" estimate's numerator. */
  totalTextChars(): number {
    return (this.open()
      .prepare(`SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM docs`)
      .get() as { n: number }).n;
  }

  /** Generic meta accessors (learn strikes etc.). */
  readMeta(key: string): string | null {
    const row = this.open().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  writeMeta(key: string, value: string): void {
    this.open()
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  writeLearnTs(ts: number): void {
    this.open()
      .prepare(`INSERT INTO meta (key, value) VALUES ('last_learn_ts', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(ts));
  }

  readLearnTs(): number | null {
    const row = this.open().prepare(`SELECT value FROM meta WHERE key = 'last_learn_ts'`).get() as
      | { value: string }
      | undefined;
    const ts = Number.parseInt(row?.value ?? '', 10);
    return Number.isFinite(ts) ? ts : null;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // quiet: already closed, or never opened.
    }
    this.db = null;
  }
}
