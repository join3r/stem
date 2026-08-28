// The client's read-only copy of your chats — the thing that makes Stem worth
// opening on a train once the server lives on a VPS.
//
// Four properties, and every one of them is a way this could go wrong rather
// than a way it works:
//
//   - it answers ONLY for a server that could not be reached, never for one that
//     answered badly. A stale thread overwriting a live one is the worst failure
//     available here, and the guard against it is that the caller never consults
//     the cache except in the branch where fetch itself threw.
//   - it knows what is stale, by updatedAt, so a catch-up run fetches what
//     changed and not twenty-five threads it already has.
//   - it is bounded, cancellable, and drops what the server has dropped.
//   - a schema it does not recognise is thrown away rather than migrated.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { rmSync, writeFileSync } from 'node:fs';
import {
  chatCachePath,
  createOfflineCache,
  staleByUpdatedAt,
  type OfflineCache
} from '../../src/desktop/offline-cache';
import { emptyInboxState } from '../../src/shared/inbox';
import type { ChatHistory, ChatListResult, ChatSummary } from '../../src/shared/types';

const path = chatCachePath();

function wipe(): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true });
}

function summary(threadId: string, updatedAt: number): ChatSummary {
  return { threadId, title: threadId, folderId: null, createdAt: updatedAt, updatedAt };
}

function list(...chats: ChatSummary[]): ChatListResult {
  return { chats, folders: [], inbox: emptyInboxState() };
}

function history(threadId: string, text: string): ChatHistory {
  return { threadId, title: threadId, messages: [{ id: 'm1', role: 'user', content: text }] };
}

let cache: OfflineCache;

beforeEach(() => {
  wipe();
  cache = createOfflineCache({ enabled: true });
});

afterEach(() => {
  cache.close();
  wipe();
});

describe('what the cache will and will not answer', () => {
  it('replays the chat list and a thread, flagged as coming from the cache', () => {
    cache.record('chats:list', [], list(summary('t1', 100)));
    cache.record('chats:open', ['t1'], history('t1', 'hello from the train'));

    expect(cache.replay('chats:list', [])).toMatchObject({
      chats: [{ threadId: 't1' }],
      offline: true
    });
    const replayed = cache.replay('chats:open', ['t1']) as ChatHistory;
    expect(replayed.messages[0].content).toBe('hello from the train');
    // The flag the renderer's banner and disabled composer hang off. Without it
    // a cached answer is indistinguishable from a live one, which is the state
    // in which somebody types into a window that cannot send.
    expect(replayed.offline).toBe(true);
  });

  it('has nothing to say about a thread it has never seen', () => {
    cache.record('chats:list', [], list(summary('t1', 100)));
    expect(cache.replay('chats:open', ['never-opened'])).toBeUndefined();
  });

  it('keeps every settings answer but only ever replays settings:get', () => {
    // Every settings:* channel answers with the whole document, so any of them
    // refreshes the copy a cold start boots from…
    cache.record('settings:updateMemory', [{}], { memory: { model: 'from-the-update' } });
    // Returned as it was stored, with no `offline` marker: the settings document
    // is round-tripped back to the server by the panes that edit it, and a field
    // this side invented would be a field the far side has to learn to ignore.
    expect(cache.replay('settings:get', [])).toEqual({ memory: { model: 'from-the-update' } });
    // …but replaying the WRITE would tell the renderer a setting was saved when
    // nothing on the other end ever heard about it.
    expect(cache.replay('settings:updateMemory', [{}])).toBeUndefined();
  });

  it('peeks the cached documents without the offline flag, for stale-while-revalidate', () => {
    cache.record('chats:list', [], list(summary('t1', 100)));
    cache.record('settings:get', [], { memory: { model: 'remembered' } });
    // Served while the server is UP (a revalidating fetch is on the wire behind
    // it), so the flag that raises the offline banner must not be on it.
    expect(cache.peek('chats:list', [])).toEqual(list(summary('t1', 100)));
    expect(cache.peek('settings:get', [])).toEqual({ memory: { model: 'remembered' } });
    // Cold cache: nothing to serve, the caller goes to the wire as always.
    expect(cache.peek('runtime:status', [])).toBeUndefined();
    // A write is never answered from a cache, peeked or replayed.
    expect(cache.peek('inbox:setRead', [['t1'], true])).toBeUndefined();
  });

  it('keeps the chat list current through a triage session', () => {
    // Every inbox/folder mutator answers with the whole fresh list, so each one
    // refreshes the cached copy — without this, a peek right after an archive
    // would serve a list from before it, and the row would visibly come back.
    cache.record('chats:list', [], list(summary('t1', 100)));
    const triaged: ChatListResult = {
      ...list(summary('t1', 100)),
      inbox: { baseline: 0, entries: { t1: { readAt: 200 } } }
    };
    cache.record('inbox:setRead', [['t1'], true], triaged);
    expect(cache.peek('chats:list', [])).toEqual(triaged);
  });

  it('says nothing at all about memory, skills or search', () => {
    // The plan's "unavailable rather than empty": these have no cached form on
    // purpose, so the call fails and the panel says it needs the server. A
    // cached memory list would be a different lie from an empty one.
    cache.record('memory:read', [], { files: [{ kind: 'note', content: 'remembered' }] });
    cache.record('skills:list', [], [{ slug: 'a' }]);
    expect(cache.replay('memory:read', [])).toBeUndefined();
    expect(cache.replay('skills:list', [])).toBeUndefined();
  });

  it('does nothing whatsoever when the server is embedded', () => {
    // The explicit branch: a server running in this process cannot be
    // unreachable from it, and its sessions are already on this disk. Doubling
    // every list and open to cache them would be work with nothing on the other
    // side of it.
    const inert = createOfflineCache({ enabled: false });
    inert.record('chats:list', [], list(summary('t1', 100)));
    expect(inert.replay('chats:list', [])).toBeUndefined();
    expect(inert.peek('chats:list', [])).toBeUndefined();
    expect(inert.cachedChannels()).toBeNull();
  });
});

describe('staleness by updatedAt', () => {
  it('wants threads it has never seen and threads that have moved since', () => {
    const chats = [summary('fresh', 300), summary('moved', 200), summary('unchanged', 100)];
    const cached = new Map([
      ['moved', 150],
      ['unchanged', 100]
    ]);
    expect(staleByUpdatedAt(chats, cached, 25)).toEqual(['fresh', 'moved']);
  });

  it('takes the most recent first when there are more than the bound allows', () => {
    const chats = Array.from({ length: 60 }, (_, i) => summary(`t${i}`, i));
    // Newest first, cut at the bound — the threads somebody is actually likely
    // to open, rather than the first twenty-five the server happened to list.
    expect(staleByUpdatedAt(chats, new Map(), 25)).toEqual(
      Array.from({ length: 25 }, (_, i) => `t${59 - i}`)
    );
  });

  it('wants nothing when every cached copy is current', () => {
    const chats = [summary('a', 10), summary('b', 20)];
    expect(staleByUpdatedAt(chats, new Map([['a', 10], ['b', 20]]), 25)).toEqual([]);
  });

  it('re-fetches a thread whose body was cached before any list named it', () => {
    // A thread cached straight off a chats:open with no list to date it lands at
    // watermark 0, which is deliberately stale: better one redundant fetch than
    // a transcript that is never refreshed because nothing knows how old it is.
    cache.record('chats:open', ['orphan'], history('orphan', 'cached with no watermark'));
    expect(staleByUpdatedAt([summary('orphan', 500)], new Map([['orphan', 0]]), 25)).toEqual(['orphan']);
  });
});

describe('the bounds it keeps', () => {
  it('holds at most a hundred threads, dropping the least recently updated', () => {
    const chats = Array.from({ length: 120 }, (_, i) => summary(`t${i}`, i));
    cache.record('chats:list', [], list(...chats));
    for (const chat of chats) cache.record('chats:open', [chat.threadId], history(chat.threadId, 'x'));

    // The newest hundred survive; the twenty oldest are gone.
    expect(cache.replay('chats:open', ['t119'])).toBeTruthy();
    expect(cache.replay('chats:open', ['t20'])).toBeTruthy();
    expect(cache.replay('chats:open', ['t19'])).toBeUndefined();
    expect(cache.replay('chats:open', ['t0'])).toBeUndefined();
  });

  it('forgets a thread the server has stopped listing', () => {
    cache.record('chats:list', [], list(summary('kept', 10), summary('deleted', 20)));
    cache.record('chats:open', ['kept'], history('kept', 'still here'));
    cache.record('chats:open', ['deleted'], history('deleted', 'gone on the server'));

    // A chat deleted from another device. Going on showing it here would be the
    // cache contradicting a server it can perfectly well reach.
    cache.record('chats:list', [], list(summary('kept', 10)));
    expect(cache.replay('chats:open', ['kept'])).toBeTruthy();
    expect(cache.replay('chats:open', ['deleted'])).toBeUndefined();
  });
});

describe('the catch-up run', () => {
  /**
   * A server that answers, counting what it was asked and honouring aborts. It
   * write-throughs what it answers because that is where the write-through
   * lives in the real thing too — proxy.ts's post() records every answer, and
   * the catch-up run is just more calls through it.
   */
  function fakeServer(chats: ChatSummary[], perCallMs = 5) {
    const asked: string[] = [];
    const call = async (channel: string, args: unknown[], signal: AbortSignal): Promise<unknown> => {
      asked.push(`${channel}${args.length ? ` ${String(args[0])}` : ''}`);
      await new Promise((resolve) => setTimeout(resolve, perCallMs));
      if (signal.aborted) throw new Error('aborted');
      const result =
        channel === 'chats:list' ? list(...chats) : history(String(args[0]), 'fetched by the catch-up run');
      cache.record(channel, args, result);
      return result;
    };
    return { asked, call };
  }

  /** Poll rather than sleep a fixed time: the debounce is the module's business. */
  async function waitFor(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('the catch-up run never got there');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const quiet = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('fetches only what changed, newest first, and never more than the bound', async () => {
    const chats = Array.from({ length: 40 }, (_, i) => summary(`t${i}`, i));
    cache.record('chats:list', [], list(...chats));
    // Pretend the ten newest are already cached and current.
    for (const chat of chats.slice(30)) {
      cache.record('chats:open', [chat.threadId], history(chat.threadId, 'x'));
    }

    const server = fakeServer(chats, 1);
    cache.schedulePrefetch(server.call);
    await waitFor(() => server.asked.filter((a) => a.startsWith('chats:history')).length >= 25);
    await quiet();

    const fetched = server.asked.filter((a) => a.startsWith('chats:history'));
    // The bound, and not one more: t29 down to t5, newest first — the threads
    // somebody is actually likely to open, not the first the server listed.
    expect(fetched).toHaveLength(25);
    expect(fetched[0]).toBe('chats:history t29');
    expect(fetched.at(-1)).toBe('chats:history t5');
    // …and it read the list exactly once to work that out.
    expect(server.asked.filter((a) => a === 'chats:list')).toHaveLength(1);
  }, 20_000);

  it('coalesces a burst of triggers into one run', async () => {
    const server = fakeServer([summary('t1', 1)], 1);
    for (let i = 0; i < 10; i++) cache.schedulePrefetch(server.call);
    await waitFor(() => server.asked.length >= 2);
    await quiet();
    expect(server.asked.filter((a) => a === 'chats:list')).toHaveLength(1);
  }, 20_000);

  it('stops where it is when it is cancelled, and keeps what it already fetched', async () => {
    const chats = Array.from({ length: 25 }, (_, i) => summary(`t${i}`, i));
    const server = fakeServer(chats, 60);
    cache.schedulePrefetch(server.call);
    await waitFor(() => server.asked.length >= 3);
    const partway = server.asked.length;
    // Quitting, or the link dropping again. Neither may leave a run grinding on
    // against a server nobody is waiting for.
    cache.cancel();
    await quiet(600);
    // At most the one already in flight when the abort landed.
    expect(server.asked.length).toBeLessThanOrEqual(partway + 1);
    expect(server.asked.length).toBeLessThan(26);
    // What it did fetch before it stopped is kept — the next run resumes rather
    // than starting the twenty-five over.
    expect(cache.replay('chats:open', ['t24'])).toBeTruthy();
  }, 20_000);

  it('never starts a run that was cancelled during its debounce', async () => {
    const server = fakeServer([summary('t1', 1)], 1);
    cache.schedulePrefetch(server.call);
    cache.cancel();
    await quiet(2_600);
    expect(server.asked).toEqual([]);
  }, 20_000);
});

describe('the schema, and what happens when it changes', () => {
  it('remembers the channel list so a cold start with no network still binds', () => {
    cache.rememberChannels(['chats:list', 'chats:open', 'settings:get']);
    expect(cache.cachedChannels()).toEqual(['chats:list', 'chats:open', 'settings:get']);
  });

  it('stamps its version on the file', () => {
    cache.record('chats:list', [], list(summary('t1', 1)));
    cache.close();
    const db = new DatabaseSync(path);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    db.close();
  });

  it('throws away a database written by a different version rather than migrating it', () => {
    cache.record('chats:list', [], list(summary('t1', 1)));
    cache.record('chats:open', ['t1'], history('t1', 'from the old schema'));
    cache.close();

    // What a downgrade, or an upgrade that changed the tables, leaves behind.
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99;');
    db.close();

    // Drop and refill is the whole policy: the server still has every byte of
    // this, so the cost of being wrong is one catch-up run, and migration code
    // for a file nobody would miss is code kept alive for nothing.
    const reopened = createOfflineCache({ enabled: true });
    expect(reopened.replay('chats:list', [])).toBeUndefined();
    expect(reopened.replay('chats:open', ['t1'])).toBeUndefined();
    // …and it is usable straight away rather than wedged on the old file.
    reopened.record('chats:list', [], list(summary('t2', 2)));
    expect(reopened.replay('chats:list', [])).toMatchObject({ chats: [{ threadId: 't2' }] });
    reopened.close();
  });

  it('survives a file that is not a database at all', () => {
    cache.close();
    wipe();
    // A truncated write, a file synced over, a disk that lied. "No cache" is a
    // supported state; failing to start is not — which is why every operation
    // here swallows its own errors instead of taking a call down with it.
    writeFileSync(path, 'this is not a SQLite database');
    const broken = createOfflineCache({ enabled: true });
    expect(() => broken.record('chats:list', [], list(summary('t1', 1)))).not.toThrow();
    expect(broken.replay('chats:list', [])).toBeUndefined();
    expect(broken.cachedChannels()).toBeNull();
    broken.close();
  });
});
