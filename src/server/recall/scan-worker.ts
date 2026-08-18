import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import {
  semanticSearchDocsCoreOrThrow,
  semanticSearchMessagesCore,
  semanticSearchSummariesCore,
  type CoreDocHit,
  type CoreSearchHit,
  type CoreSummaryHit,
  type DocScanOptions,
  type SemanticScanOptions
} from './search-core';
import { enforceEpisodicLimitCore } from './maintenance-core';

// Utility-process entry hosting the recall brute-force cosine scans and the
// episodic maintenance work (size-cap pruning, VACUUM). Both are O(N) over the
// message store — tens of thousands of rows, or a multi-second VACUUM of a
// ~100 MB file — and both sit on paths the main process must never block on
// (the chat-turn hot path, the capture tap). Lives in its own process with its
// own read-write connection to recall.sqlite; WAL mode makes its reads see the
// main process's committed captures, and busy_timeout on both sides covers the
// brief exclusive window a VACUUM needs. Talks to the manager (scan-manager.ts)
// over process.parentPort with plain structured-clone messages.
// This file must stay free of Electron imports beyond the ambient parentPort.

export type ScanRequestOptions = SemanticScanOptions;

export type ScanWorkerInMessage =
  | { type: 'init'; dbPath: string }
  | ({ type: 'scan-messages'; id: number; vec: Float32Array; model: string } & ScanRequestOptions)
  | ({ type: 'scan-summaries'; id: number; vec: Float32Array; model: string } & ScanRequestOptions)
  | ({ type: 'scan-docs'; id: number; vec: Float32Array; model: string; dbFile: string } & DocScanOptions)
  | { type: 'evict-doc-db'; id: number; dbFile: string }
  | { type: 'maintain'; id: number }
  | { type: 'vacuum'; id: number };

export type ScanWorkerOutMessage =
  | { type: 'message-hits'; id: number; hits: CoreSearchHit[] }
  | { type: 'summary-hits'; id: number; hits: CoreSummaryHit[] }
  | { type: 'doc-hits'; id: number; hits: CoreDocHit[] }
  | { type: 'doc-db-evicted'; id: number }
  | { type: 'maintained'; id: number; deleted: number }
  | { type: 'vacuumed'; id: number }
  | { type: 'error'; id: number; message: string };

// Under Electron's utilityProcess this is the real parentPort. Under the
// headless server's plain child_process.fork (host/index.ts forkNodeWorker)
// there is no parentPort, only node IPC — wrapped here in the same
// `{ data }` envelope so the rest of the file cannot tell who forked it.
const port = (process.parentPort ??
  ({
    postMessage: (msg: unknown) => process.send?.(msg),
    on(_event: string, cb: (e: { data: unknown }) => void) {
      process.on('message', (msg) => cb({ data: msg }));
      return this;
    }
  } as unknown)) as NonNullable<typeof process.parentPort>;

let dbPath: string | null = null;
let db: DatabaseSync | null = null;

function post(msg: ScanWorkerOutMessage): void {
  port.postMessage(msg);
}

function open(): DatabaseSync {
  if (db) return db;
  if (!dbPath) throw new Error('scan worker not initialized');
  const handle = new DatabaseSync(dbPath);
  // The main process owns the schema; this connection only reads/prunes. A write
  // colliding with the main process (or a main write colliding with our VACUUM)
  // waits instead of throwing SQLITE_BUSY.
  // Mirrors the main-process handle (store.ts): must outlast one VACUUM round
  // held by the other side, not just a brief write lock.
  handle.exec('PRAGMA busy_timeout = 60000;');
  db = handle;
  return handle;
}

function fail(id: number, err: unknown): void {
  post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
}

// Folder-index handles, one read-only connection per index file, kept warm
// across requests. Evicted on any scan error (semanticSearchDocsCoreOrThrow
// lets SQLite failures out for exactly this) — the caller falls back in-process
// and the next request reopens. Main sends 'evict-doc-db' before it deletes an
// index, which is what lets Windows unlink the file at all.
interface DocHandle {
  db: DatabaseSync;
  /** File identity at open time — see docFileIdentity. */
  identity: string;
}

const docDbs = new Map<string, DocHandle>();

/**
 * Cheap identity of the file currently at `dbFile`. Folder ids are stable
 * UUIDs, so turning a folder's index off and back on recreates the *same path*
 * over a new file; on POSIX a cached handle would keep reading the unlinked
 * inode forever. dev+ino catches that; birthtime carries the check on
 * filesystems that don't report a usable inode.
 */
function docFileIdentity(dbFile: string): string {
  const s = statSync(dbFile);
  return `${s.dev}:${s.ino}:${s.birthtimeMs}`;
}

function openDocDb(dbFile: string): DatabaseSync {
  const identity = docFileIdentity(dbFile);
  const cached = docDbs.get(dbFile);
  if (cached) {
    if (cached.identity === identity) return cached.db;
    evictDocDb(dbFile); // Same path, different file — the index was recreated.
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  // Mirrors the main-process folder-index handle (folder-index/store.ts): a
  // folder index sees short writes from the scan pass, never a VACUUM round.
  db.exec('PRAGMA busy_timeout = 5000;');
  docDbs.set(dbFile, { db, identity });
  return db;
}

function evictDocDb(dbFile: string): void {
  const cached = docDbs.get(dbFile);
  docDbs.delete(dbFile);
  try {
    cached?.db.close();
  } catch {
    // quiet: the handle is out of the map above either way, which is the whole
    // point of an eviction. A connection that will not close is already broken.
  }
}

port.on('message', (e: { data: ScanWorkerInMessage }) => {
  const msg = e.data;
  if (msg.type === 'init') {
    dbPath = msg.dbPath;
    return;
  }
  try {
    switch (msg.type) {
      case 'scan-messages':
        post({
          type: 'message-hits',
          id: msg.id,
          hits: semanticSearchMessagesCore(open(), msg.vec, msg.model, msg)
        });
        return;
      case 'scan-summaries':
        post({
          type: 'summary-hits',
          id: msg.id,
          hits: semanticSearchSummariesCore(open(), msg.vec, msg.model, msg)
        });
        return;
      case 'scan-docs':
        try {
          post({
            type: 'doc-hits',
            id: msg.id,
            hits: semanticSearchDocsCoreOrThrow(openDocDb(msg.dbFile), msg.vec, msg.model, msg)
          });
        } catch (err) {
          evictDocDb(msg.dbFile);
          fail(msg.id, err);
        }
        return;
      case 'evict-doc-db':
        evictDocDb(msg.dbFile);
        post({ type: 'doc-db-evicted', id: msg.id });
        return;
      case 'maintain':
        post({ type: 'maintained', id: msg.id, deleted: enforceEpisodicLimitCore(open(), dbPath ?? '') });
        return;
      case 'vacuum':
        open().exec('VACUUM');
        post({ type: 'vacuumed', id: msg.id });
        return;
    }
  } catch (err) {
    fail(msg.id, err);
  }
});
