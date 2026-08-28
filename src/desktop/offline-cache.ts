import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { host } from '../server/host';
import { log } from '../server/log';
import type { ChatHistory, ChatListResult, ChatSummary } from '../shared/types';

// The read-only copy of your chats that this machine keeps for the train.
//
// Phase 2 moves the server to a VPS, and a Mac that can only show your chats
// when it has a network is a Mac that is useless on a plane, in a basement, or
// for the thirty seconds a hotel captive portal takes to let go. So the client
// keeps its own SQLite file beside client.json, written through as the server
// answers, and read back only when the server cannot be reached at all.
//
// READ-ONLY, and that word is doing a lot of work. There is no write queue, no
// outbox and no sync: what you can do offline is READ. Composing is blocked in
// the UI (see the connection banner in the renderer) precisely so this file
// never has to answer the question of what happens when two sides disagree —
// it cannot, because only one side ever writes.
//
// Three rules the rest of this file exists to keep:
//
//   1. THE CACHE IS NEVER THE SOURCE OF TRUTH WHEN THE SERVER IS REACHABLE.
//      replay() is called from exactly one place — the branch of proxy.ts's
//      post() where fetch itself threw, meaning nothing on the other end
//      answered. A server that answers with an error is a server that is up,
//      and its error is what the renderer gets. A stale thread quietly
//      overwriting a live one is the worst thing this file could do, and the
//      only way it stays impossible is that reachable and unreachable are
//      decided by the transport, never by the contents of an answer.
//
//      peek() bends this without breaking it: proxy.ts serves the cached copy
//      of the two whole-document reads (settings:get, chats:list) immediately
//      on a slow-but-working link — but only while a revalidating fetch is on
//      the wire behind it, whose answer is pushed to the renderer the moment it
//      lands. The cache buys the first paint; the server still has the last
//      word, every time.
//
//   2. IT IS AN OPTIMIZATION, SO IT MAY NEVER BREAK A CALL. Every operation
//      here swallows its own errors. A corrupt database, a full disk or a
//      schema from a future build all degrade to "no cache", which is exactly
//      how Stem behaved before this file existed.
//
//   3. IT IS BOUNDED. See MAX_CACHED_THREADS.
//
// ---------------------------------------------------------------------------
//
// EMBEDDED INSTALLS DO NOT RUN THIS AT ALL. When Stem starts the server itself
// (the default), the server is in this very process reading this very disk: it
// cannot be unreachable while there is an app to be unreachable FROM, and the
// JSONL sessions it would serve from are already here. A cache would be a
// second copy of the same bytes, kept current by doubling every list and every
// open, to answer a question that cannot be asked. createOfflineCache() is
// therefore handed `remote` (proxy.ts) and returns an inert object when it is
// false — one branch, made once, at the only place that knows.
//
// SCHEMA POLICY: drop and refill. `PRAGMA user_version` carries SCHEMA_VERSION;
// anything else on disk — older, newer, or unreadable — is deleted and rebuilt
// empty. That is the right answer for a cache and only for a cache: the server
// still has every byte of this, so the cost of being wrong is one prefetch, and
// migration code that runs on a file nobody would miss is code kept alive for
// nothing. client.json, whose contents exist nowhere else, migrates properly.

/** Bump to invalidate every cache on disk. See the schema policy above. */
const SCHEMA_VERSION = 1;

/**
 * How many threads a catch-up run will fetch. The number the plan fixed: enough
 * that the chats you would actually open on a train are there, small enough that
 * a client reconnecting on a phone tether does not spend a minute of somebody's
 * data allowance being helpful.
 */
export const PREFETCH_LIMIT = 25;

/**
 * The size bound, expressed in threads rather than bytes or age.
 *
 * Age is wrong: the thread you want on the train is disproportionately likely
 * to be an old one you went looking for, and a cache that deletes exactly that
 * is worse than no cache. Bytes are right in principle but need every write to
 * measure and re-measure a total to decide something the row count already
 * decides — a hundred chat transcripts is single-digit megabytes, next to a
 * recall database that is allowed to be far larger. So: the hundred most
 * recently updated threads, pruned on write, with the prefetch's twenty-five
 * comfortably inside it so ordinary use never fights the bound.
 */
const MAX_CACHED_THREADS = 100;

/**
 * Quiet period before a catch-up run. Reconnects arrive in bursts (a flapping
 * link retries on a doubling backoff) and a turn ending is followed immediately
 * by the subject write that ends it again, so every trigger is debounced into
 * whichever one is last.
 */
const PREFETCH_DEBOUNCE_MS = 2_000;

/**
 * Every channel whose answer is the whole chat list. `chats:list` is the read;
 * the rest are the mutators, which return the fresh list as their answer (the
 * contract server/ipc/chats.ts sets). Recording all of them keeps the cached
 * copy current through a triage session, so peek() never serves a list from
 * before an archive the server has long since confirmed.
 */
const CHAT_LIST_CHANNELS = new Set([
  'chats:list',
  'chats:setFolder',
  'chats:writeSubject',
  'inbox:setArchived',
  'inbox:snooze',
  'inbox:setRead',
  'inbox:markAllRead',
  'folders:create',
  'folders:rename',
  'folders:delete',
  'folders:move'
]);

/**
 * Which whole-answer channels are kept, and under what name. Everything here is
 * boot-critical or is the chat list itself:
 *
 *   settings     the renderer will not paint without a settings document, and
 *                the machine's half of it is merged on top afterwards either way
 *                (see mergeSettingsAnswer in proxy.ts)
 *   runtime      App.tsx shows "Starting Stem…" until runtime:status resolves,
 *                so a client that cannot ask is a client stuck on a splash
 *                screen. Replaying the last-known answer is a claim about the
 *                past, which is why the banner saying so is not optional
 *   chats        the sidebar
 *
 * Deliberately NOT here: memory, skills, search, models, files. They are shown
 * as unavailable instead — an empty memory panel reads as "you have no
 * memories", which is a lie, and a cached one would be a different lie.
 *
 * Note the two functions are not each other's inverse, and that asymmetry is
 * load-bearing. EVERY settings channel and EVERY chat-list mutator answers with
 * the whole document, so any of them refreshes the copy a cold start boots from
 * — but only the plain reads (settings:get, chats:list) may be ANSWERED from
 * that copy. Replaying settings:updateMemory would hand the renderer a settings
 * document in reply to a write that never happened, and the pane would show the
 * toggle it just moved as moved.
 */
function documentToKeep(channel: string): string | null {
  if (channel === 'runtime:status') return 'runtime-status';
  if (CHAT_LIST_CHANNELS.has(channel)) return 'chats';
  if (channel === 'settings:get' || channel === 'auth:completeOnboarding') return 'settings';
  return channel.startsWith('settings:update') ? 'settings' : null;
}

function documentToServe(channel: string): string | null {
  if (channel === 'runtime:status') return 'runtime-status';
  if (channel === 'chats:list') return 'chats';
  return channel === 'settings:get' ? 'settings' : null;
}

/** Channels that answer with one thread's transcript, keyed by args[0]. */
const THREAD_CHANNELS = new Set(['chats:open', 'chats:history']);

/** Where the channel list from the last successful connect is filed. */
const CHANNELS_DOCUMENT = 'channels';

/** Runs one call against the server, aborting when `signal` says to. */
export type PrefetchCall = (channel: string, args: unknown[], signal: AbortSignal) => Promise<unknown>;

export interface OfflineCache {
  /** Write-through: keep this answer if it is one of the ones worth keeping. */
  record(channel: string, args: unknown[], result: unknown): void;
  /**
   * The cached answer for a call the server could not be reached for, flagged
   * `offline` so the renderer can say where it came from — or undefined when
   * there is nothing, which leaves the caller to fail as it always did.
   */
  replay(channel: string, args: unknown[]): unknown;
  /**
   * The cached answer WITHOUT the offline flag, for serving stale-while-
   * revalidate while the server is up (see the SWR block in proxy.ts). The
   * caller owes the renderer the wire's answer afterwards; this is only what
   * lets it paint something true-as-of-recently in the meantime.
   */
  peek(channel: string, args: unknown[]): unknown;
  /** The channel list from the last connect, so a cold boot offline still binds. */
  rememberChannels(list: readonly string[]): void;
  cachedChannels(): string[] | null;
  /** Ask for a bounded catch-up run, coalescing a burst of triggers into one. */
  schedulePrefetch(call: PrefetchCall): void;
  /** Abandon anything in flight or pending — the link dropped again, or we quit. */
  cancel(): void;
  /** Release the database handle (quit; tests). */
  close(): void;
}

/** Beside client.json. STEM_CHAT_CACHE_FILE points a test run somewhere disposable. */
export function chatCachePath(): string {
  return process.env.STEM_CHAT_CACHE_FILE ?? join(host().stateRoot(), 'chat-cache.sqlite');
}

/** The inert cache an embedded install gets. See the note at the top of the file. */
const DISABLED: OfflineCache = {
  record: () => undefined,
  replay: () => undefined,
  peek: () => undefined,
  rememberChannels: () => undefined,
  cachedChannels: () => null,
  schedulePrefetch: () => undefined,
  cancel: () => undefined,
  close: () => undefined
};

export function createOfflineCache({ enabled }: { enabled: boolean }): OfflineCache {
  if (!enabled) return DISABLED;

  /** undefined = not opened yet; null = tried and failed, never try again. */
  let db: DatabaseSync | null | undefined;

  /**
   * updatedAt per thread as of the last chat list we saw. It is what tells a
   * thread body apart from a stale one, and it arrives on the LIST rather than
   * on the transcript — chats:open answers with messages and a title, and
   * nothing about when the thread last moved.
   */
  const updatedAt = new Map<string, number>();

  function open(): DatabaseSync | null {
    if (db !== undefined) return db;
    db = null;
    try {
      const path = chatCachePath();
      // The state root exists by the time anything gets here, but a
      // STEM_CHAT_CACHE_FILE pointed at a fresh directory need not.
      mkdirSync(dirname(path), { recursive: true });
      const handle = new DatabaseSync(path);
      handle.exec('PRAGMA journal_mode = WAL;');
      const version = (handle.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)
        ?.user_version;
      if (version !== SCHEMA_VERSION) {
        // Drop and refill — the whole migration policy. See the header.
        handle.exec('DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS threads;');
      }
      handle.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          name      TEXT PRIMARY KEY,
          payload   TEXT NOT NULL,
          cached_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS threads (
          thread_id  TEXT PRIMARY KEY,
          updated_at INTEGER NOT NULL,
          payload    TEXT NOT NULL,
          cached_at  INTEGER NOT NULL
        );
      `);
      handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      db = handle;
      seedWatermarks();
    } catch (e) {
      // A corrupt file, a read-only disk, a directory that isn't there yet.
      // "No cache" is a supported state; failing to start is not.
      log('cache', 'the offline chat cache could not be opened', {
        error: String((e as Error)?.message ?? e)
      });
    }
    return db;
  }

  /**
   * Reload the updatedAt map from the chat list already on disk, so the first
   * catch-up run after a relaunch diffs against what this machine really has
   * rather than re-fetching all twenty-five.
   */
  function seedWatermarks(): void {
    const list = readDocument<ChatListResult>('chats');
    for (const chat of list?.chats ?? []) updatedAt.set(chat.threadId, chat.updatedAt);
  }

  function writeDocument(name: string, value: unknown): void {
    const handle = open();
    if (!handle) return;
    try {
      handle
        .prepare(
          `INSERT INTO documents (name, payload, cached_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at`
        )
        .run(name, JSON.stringify(value), Date.now());
    } catch (e) {
      log('cache', 'could not cache a document', { name, error: String((e as Error)?.message ?? e) });
    }
  }

  function readDocument<T>(name: string): T | null {
    const handle = open();
    if (!handle) return null;
    try {
      const row = handle.prepare('SELECT payload FROM documents WHERE name = ?').get(name) as
        | { payload: string }
        | undefined;
      return row ? (JSON.parse(row.payload) as T) : null;
    } catch {
      return null;
    }
  }

  /**
   * Keep one thread's transcript, then enforce the bound. Pruning here rather
   * than on a timer is what makes the bound true at every instant rather than
   * true on average.
   */
  function writeThread(threadId: string, history: unknown): void {
    const handle = open();
    if (!handle) return;
    try {
      handle
        .prepare(
          `INSERT INTO threads (thread_id, updated_at, payload, cached_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at,
                                                payload    = excluded.payload,
                                                cached_at  = excluded.cached_at`
        )
        .run(threadId, updatedAt.get(threadId) ?? 0, JSON.stringify(history), Date.now());
      handle
        .prepare(
          `DELETE FROM threads WHERE thread_id NOT IN
             (SELECT thread_id FROM threads ORDER BY updated_at DESC, cached_at DESC LIMIT ?)`
        )
        .run(MAX_CACHED_THREADS);
    } catch (e) {
      log('cache', 'could not cache a thread', { threadId, error: String((e as Error)?.message ?? e) });
    }
  }

  function readThread(threadId: string): ChatHistory | null {
    const handle = open();
    if (!handle) return null;
    try {
      const row = handle.prepare('SELECT payload FROM threads WHERE thread_id = ?').get(threadId) as
        | { payload: string }
        | undefined;
      return row ? (JSON.parse(row.payload) as ChatHistory) : null;
    } catch {
      return null;
    }
  }

  /**
   * Forget threads the server no longer lists. A chat deleted on the phone that
   * went on showing here would be the cache contradicting a server it can
   * perfectly well reach, which is the one thing it must never do.
   */
  function dropVanished(chats: readonly ChatSummary[]): void {
    const handle = open();
    if (!handle) return;
    try {
      const live = new Set(chats.map((c) => c.threadId));
      const rows = handle.prepare('SELECT thread_id AS id FROM threads').all() as { id: string }[];
      const del = handle.prepare('DELETE FROM threads WHERE thread_id = ?');
      for (const { id } of rows) if (!live.has(id)) del.run(id);
    } catch {
      // Leaving a stale row is survivable; it is bounded and the next list retries.
    }
  }

  /** What this machine already holds, as the staleness rule wants to see it. */
  function cachedWatermarks(): Map<string, number> {
    const handle = open();
    if (!handle) return new Map();
    try {
      const rows = handle.prepare('SELECT thread_id AS id, updated_at AS at FROM threads').all() as {
        id: string;
        at: number;
      }[];
      return new Map(rows.map((r) => [r.id, r.at]));
    } catch {
      return new Map();
    }
  }

  // ---- prefetch ----

  /** The run in flight, so cancel() and the next trigger can both reach it. */
  let inFlight: AbortController | null = null;
  let debounce: NodeJS.Timeout | null = null;

  async function runPrefetch(call: PrefetchCall): Promise<void> {
    const controller = new AbortController();
    inFlight = controller;
    try {
      const list = (await call('chats:list', [], controller.signal)) as ChatListResult | null;
      // record() ran inside the call, so the watermarks and the pruning are
      // already applied by the time the diff below reads them back.
      const wanted = staleByUpdatedAt(list?.chats ?? [], cachedWatermarks(), PREFETCH_LIMIT);
      for (const threadId of wanted) {
        if (controller.signal.aborted) return;
        await call('chats:history', [threadId], controller.signal);
      }
      if (wanted.length) log('cache', 'filled the offline cache', { threads: wanted.length });
    } catch (e) {
      // The link went away again mid-run, or we were cancelled. Either way the
      // next connect schedules another one, and it will pick up where this
      // stopped — every thread it did fetch is already cached.
      if (!controller.signal.aborted) {
        log('cache', 'the catch-up run stopped early', { error: String((e as Error)?.message ?? e) });
      }
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  return {
    record(channel, args, result) {
      if (result === undefined || result === null) return;
      const document = documentToKeep(channel);
      if (document) {
        // Any answer that IS the chat list carries the watermarks, whichever
        // channel it arrived on.
        if (document === 'chats') {
          const list = result as ChatListResult;
          updatedAt.clear();
          for (const chat of list.chats ?? []) updatedAt.set(chat.threadId, chat.updatedAt);
          dropVanished(list.chats ?? []);
        }
        writeDocument(document, result);
        return;
      }
      if (THREAD_CHANNELS.has(channel) && typeof args[0] === 'string') {
        writeThread(args[0], result);
      }
    },

    replay(channel, args) {
      const document = documentToServe(channel);
      if (document) {
        const value = readDocument<Record<string, unknown>>(document);
        if (!value) return undefined;
        // The flag the plan names, on the two answers that are ABOUT chats: an
        // answer that says where it came from, so nothing downstream has to
        // infer it from the shape of what it got. Not on the settings document
        // or the runtime status — those are replayed so the app can start at
        // all, and a stray field on a shape the renderer round-trips back to the
        // server would be a field the server has to be taught to ignore.
        return channel === 'chats:list' ? { ...value, offline: true } : value;
      }
      if (THREAD_CHANNELS.has(channel) && typeof args[0] === 'string') {
        const history = readThread(args[0]);
        return history ? { ...history, offline: true } : undefined;
      }
      return undefined;
    },

    peek(channel, args) {
      const document = documentToServe(channel);
      if (document) return readDocument<Record<string, unknown>>(document) ?? undefined;
      if (THREAD_CHANNELS.has(channel) && typeof args[0] === 'string') {
        return readThread(args[0]) ?? undefined;
      }
      return undefined;
    },

    rememberChannels(list) {
      writeDocument(CHANNELS_DOCUMENT, [...list]);
    },

    cachedChannels() {
      const list = readDocument<string[]>(CHANNELS_DOCUMENT);
      return Array.isArray(list) && list.length ? list : null;
    },

    schedulePrefetch(call) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        // One run at a time. A second trigger while one is running is not lost —
        // the run it would have started is the run already in progress, and
        // whatever changed after it started is picked up by the next connect or
        // the next turn.
        if (inFlight) return;
        void runPrefetch(call);
      }, PREFETCH_DEBOUNCE_MS);
      // Never hold the process open for a cache fill. Quitting mid-prefetch is
      // supposed to cost nothing, and a pending timer that keeps the event loop
      // alive is how a quit turns into a two-second hang.
      debounce.unref?.();
    },

    cancel() {
      if (debounce) clearTimeout(debounce);
      debounce = null;
      inFlight?.abort();
      inFlight = null;
    },

    close() {
      if (debounce) clearTimeout(debounce);
      debounce = null;
      inFlight?.abort();
      inFlight = null;
      try {
        db?.close();
      } catch {
        // Closing a handle we already lost is not worth a line in the log.
      }
      db = undefined;
      updatedAt.clear();
    }
  };
}

/**
 * The threads a catch-up run should fetch: newest first, those never cached or
 * whose cached copy predates the server's `updatedAt`, capped at `limit`. The
 * whole staleness rule, and the reason `updatedAt` is carried around separately
 * from the transcript it describes — chats:open answers with a title and
 * messages and says nothing about when the thread last moved.
 *
 * A free function so it can be tested for what it is: arithmetic on two lists,
 * with no database in the way.
 */
export function staleByUpdatedAt(
  chats: readonly ChatSummary[],
  cached: ReadonlyMap<string, number>,
  limit: number
): string[] {
  const wanted: string[] = [];
  for (const chat of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (wanted.length >= limit) break;
    const have = cached.get(chat.threadId);
    if (have === undefined || have < chat.updatedAt) wanted.push(chat.threadId);
  }
  return wanted;
}
