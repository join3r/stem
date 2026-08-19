import { watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import { log } from '../../server/log';
import { uploadFile } from '../file-transfer';
import type { ServerCredentials } from '../server-endpoint';
import type { ConnectedFolder, MirrorApplyInput, MirrorDiffResult, MirrorFolderInfo } from '../../shared/types';
import { scanMirrorRoot } from './scan';
import { readMirroredFolders, writeMirroredFolders, type MirroredFolder } from './store';

// The client half of client-connected folders: THIS machine watching the
// folders the person here picked, and pushing their bytes one way up to the
// server's mirror. The store (./store.ts) is the authority over what is read —
// the server's registry is reconciled against, never adopted from, so no
// server, however compromised, can name a path here and have it uploaded.
//
// Freshness is layered exactly like the server's folder index: a recursive
// fs.watch per root buys latency when it works, a debounce keeps a burst of
// saves to one round, and a periodic reconcile scan is the correctness
// backstop when the watcher misses (network drives, editors that swap files,
// platforms where recursive watch is thin ice). The watcher failing entirely
// degrades to reconcile-only, never to broken.

const DEBOUNCE_MS = 2_000;
/** The post-exec kick: a device command touched a mirrored root just now. */
const EXEC_KICK_MS = 500;
/** Retry soon when an apply reported expired staging handles. */
const RETRY_MS = 30_000;
const RECONCILE_INTERVAL_MS = 15 * 60_000;
/** Below the server's MAX_APPLY_ENTRIES, with room to spare. */
const APPLY_BATCH = 400;
const UPLOAD_CONCURRENCY = 4;

export interface MirrorHostDeps {
  /** Call a server channel through the proxy (late-bound, like the exec host's). */
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Address + bearer token for POST /upload, which is not an RPC. */
  creds(): ServerCredentials;
}

export interface MirrorFolderLocalState {
  folderId: string;
  clientPath: string;
  phase: 'idle' | 'syncing' | 'frozen';
  lastError?: string;
}

export interface MirrorHost {
  /** Reconcile with the server, start watchers, scan everything once. */
  start(): Promise<void>;
  /** The stream reconnected (or the panel asked): reconcile and rescan. */
  refresh(): Promise<void>;
  /** Register a folder picked HERE: server registry + the local list + first sync. */
  addFolder(clientPath: string, label?: string): Promise<ConnectedFolder[]>;
  /** Per-folder sync phase for the Folders tab. */
  localState(): MirrorFolderLocalState[];
  /** A device command just ran here; push any mirrored root it touched, now. */
  commandTouched(command: string, cwd?: string): void;
  close(): void;
}

interface Entry {
  folder: MirroredFolder;
  watcher: FSWatcher | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  dirty: boolean;
  frozen: boolean;
  lastError?: string;
  /** Files seen by the last completed scan — the "suddenly empty" tripwire. */
  lastCount: number;
}

export function createMirrorHost(deps: MirrorHostDeps): MirrorHost {
  const entries = new Map<string, Entry>();
  let reconcileTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function ensureEntry(folder: MirroredFolder): Entry {
    let entry = entries.get(folder.folderId);
    if (!entry) {
      entry = { folder, watcher: null, timer: null, running: false, dirty: false, frozen: false, lastCount: 0 };
      entries.set(folder.folderId, entry);
    } else {
      entry.folder = folder;
    }
    ensureWatcher(entry);
    return entry;
  }

  function ensureWatcher(entry: Entry): void {
    if (entry.watcher) return;
    try {
      entry.watcher = watch(entry.folder.clientPath, { recursive: true }, () => {
        scheduleSync(entry.folder.folderId, DEBOUNCE_MS);
      });
      entry.watcher.on('error', () => {
        // The root went away, or the OS gave up on the watch. Either way the
        // reconcile pass is now the freshness mechanism, and the next
        // successful scan re-arms the watcher.
        entry.watcher?.close();
        entry.watcher = null;
        scheduleSync(entry.folder.folderId, DEBOUNCE_MS);
      });
    } catch {
      // quiet: no recursive watch here (or the root is missing). Reconcile-only
      // freshness is the documented degradation, not a failure.
      entry.watcher = null;
    }
  }

  function dropEntry(folderId: string): void {
    const entry = entries.get(folderId);
    if (!entry) return;
    entry.watcher?.close();
    if (entry.timer) clearTimeout(entry.timer);
    entries.delete(folderId);
  }

  function scheduleSync(folderId: string, delayMs: number): void {
    const entry = entries.get(folderId);
    if (!entry || closed) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void syncNow(entry);
    }, delayMs);
    entry.timer.unref?.();
  }

  /** Prune a local entry the server no longer knows (folder disconnected elsewhere). */
  async function pruneLocal(folderId: string): Promise<void> {
    dropEntry(folderId);
    const kept = (await readMirroredFolders()).filter((f) => f.folderId !== folderId);
    await writeMirroredFolders(kept);
    log('mirror-host', 'stopped mirroring a folder the server no longer lists', { folderId });
  }

  async function syncNow(entry: Entry): Promise<void> {
    if (entry.running) {
      entry.dirty = true;
      return;
    }
    entry.running = true;
    try {
      await syncRound(entry);
      entry.lastError = undefined;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      entry.lastError = message;
      // The one refusal that means the folder is GONE server-side, not sick.
      if (message.includes('No connected folder')) {
        await pruneLocal(entry.folder.folderId).catch(() => undefined); // quiet: retried on the next reconcile
        return;
      }
      log('mirror-host', 'a sync round failed', { folderId: entry.folder.folderId, error: message });
    } finally {
      if (entries.has(entry.folder.folderId)) {
        entry.running = false;
        if (entry.dirty) {
          entry.dirty = false;
          scheduleSync(entry.folder.folderId, DEBOUNCE_MS);
        }
      }
    }
  }

  async function syncRound(entry: Entry): Promise<void> {
    const { folderId, clientPath } = entry.folder;
    const scan = await scanMirrorRoot(clientPath);
    // The freeze (decision Q15): a root that vanished — or emptied out from one
    // scan to the next, the unmounted-disk signature — is never propagated as
    // "delete everything". The server marks the folder, the mirror keeps its
    // last good state, and sync resumes when a scan sees files again.
    if (scan.rootMissing || (entry.lastCount > 0 && scan.entries.length === 0)) {
      entry.frozen = true;
      await deps.invoke('mirror:report', [folderId, { state: 'root-missing' }]);
      return;
    }
    ensureWatcher(entry);
    const diff = (await deps.invoke('mirror:diff', [folderId, { files: scan.entries }])) as MirrorDiffResult;

    const bySize = new Map(scan.entries.map((e) => [e.rel, e]));
    const wanted = diff.want.map((rel) => bySize.get(rel)).filter((e): e is NonNullable<typeof e> => !!e);
    let failed = 0;

    for (let i = 0; i < wanted.length; i += APPLY_BATCH) {
      const batch = wanted.slice(i, i + APPLY_BATCH);
      const puts: MirrorApplyInput['puts'] = [];
      // A bounded pool, not Promise.all over the batch: four uploads in flight
      // keeps a big first sync from opening four hundred sockets.
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, batch.length) }, async () => {
          while (next < batch.length) {
            const item = batch[next++]!;
            try {
              const handle = await uploadFile(deps.creds(), join(clientPath, ...item.rel.split('/')));
              puts.push({ rel: item.rel, handle, size: item.size, mtimeMs: item.mtimeMs });
            } catch (e) {
              // A file that changed or vanished mid-round is the next round's
              // problem; one unreadable file must not stop the other 399.
              failed++;
              log('mirror-host', 'could not upload one file', {
                folderId,
                rel: item.rel,
                error: e instanceof Error ? e.message : String(e)
              });
            }
          }
        })
      );
      if (puts.length) {
        const res = (await deps.invoke('mirror:apply', [folderId, { puts, deletes: [] }])) as { failed: string[] };
        failed += res.failed.length;
      }
    }

    for (let i = 0; i < diff.delete.length; i += APPLY_BATCH) {
      await deps.invoke('mirror:apply', [folderId, { puts: [], deletes: diff.delete.slice(i, i + APPLY_BATCH) }]);
    }

    await deps.invoke('mirror:report', [folderId, { state: 'ok', skipped: scan.skipped }]);
    entry.frozen = false;
    entry.lastCount = scan.entries.length;
    if (failed) scheduleSync(folderId, RETRY_MS);
  }

  /**
   * Line the runtime up with both lists: the server's registry says WHICH
   * folders exist and their current mode; this machine's store says which of
   * them this machine actually mirrors. Local entries the server dropped are
   * pruned; server entries this machine never opted into are left alone — that
   * is the authority boundary, not an oversight.
   */
  async function reconcile(): Promise<void> {
    let server: MirrorFolderInfo[];
    try {
      server = (await deps.invoke('mirror:hello', [])) as MirrorFolderInfo[];
    } catch (e) {
      // An older server has no mirror channels; this machine simply cannot
      // mirror folders there yet.
      log('mirror-host', 'could not reconcile with the server', {
        error: e instanceof Error ? e.message : String(e)
      });
      return;
    }
    const byId = new Map(server.map((s) => [s.folderId, s]));
    const local = await readMirroredFolders();
    const kept: MirroredFolder[] = [];
    for (const f of local) {
      const remote = byId.get(f.folderId);
      if (!remote) {
        dropEntry(f.folderId);
        continue;
      }
      kept.push({ ...f, mode: remote.mode });
    }
    if (JSON.stringify(kept) !== JSON.stringify(local)) await writeMirroredFolders(kept);
    for (const f of kept) ensureEntry(f);
  }

  return {
    async start() {
      await reconcile();
      for (const id of entries.keys()) scheduleSync(id, DEBOUNCE_MS);
      reconcileTimer = setInterval(() => {
        void reconcile().then(() => {
          for (const id of entries.keys()) scheduleSync(id, DEBOUNCE_MS);
        });
      }, RECONCILE_INTERVAL_MS);
      reconcileTimer.unref?.();
    },

    async refresh() {
      await reconcile();
      for (const id of entries.keys()) scheduleSync(id, DEBOUNCE_MS);
    },

    async addFolder(clientPath, label) {
      const folders = (await deps.invoke('cfolders:addClient', [clientPath, label ?? null])) as ConnectedFolder[];
      const mine = folders.find((f) => f.origin?.clientPath === clientPath);
      if (mine) {
        const local = await readMirroredFolders();
        if (!local.some((f) => f.folderId === mine.id)) {
          await writeMirroredFolders([...local, { folderId: mine.id, clientPath, mode: mine.mode }]);
        }
        ensureEntry({ folderId: mine.id, clientPath, mode: mine.mode });
        scheduleSync(mine.id, 100); // the first sync, now — an empty mirror is a folder that looks broken
      }
      return folders;
    },

    localState() {
      return [...entries.values()].map((e) => ({
        folderId: e.folder.folderId,
        clientPath: e.folder.clientPath,
        phase: e.frozen ? 'frozen' : e.running ? 'syncing' : 'idle',
        ...(e.lastError ? { lastError: e.lastError } : {})
      }));
    },

    commandTouched(command, cwd) {
      for (const entry of entries.values()) {
        const root = entry.folder.clientPath;
        const inCwd = !!cwd && (cwd === root || cwd.startsWith(root + sep));
        if (inCwd || command.includes(root)) scheduleSync(entry.folder.folderId, EXEC_KICK_MS);
      }
    },

    close() {
      closed = true;
      if (reconcileTimer) clearInterval(reconcileTimer);
      for (const id of [...entries.keys()]) dropEntry(id);
    }
  };
}
