import { describe, expect, it, vi } from 'vitest';
import type { BackendEventEnvelope, ChatHistory, ChatMessage } from '../../src/shared/types';
import { EMPTY_STATE } from '../../src/renderer/chatState';
import { createHistoryRefresher, mergeRefreshedThread } from '../../src/renderer/session/history';
import { SessionStore } from '../../src/renderer/session/store';
import { attachBackendEvents, createSessionCore } from '../../src/renderer/session/turns';

const old: ChatMessage = { id: 'old', role: 'user', content: 'Earlier question' };
const phone: ChatMessage = { id: 'phone', role: 'user', content: 'Sent from the phone', turnId: 'remote' };
const history = (messages: ChatMessage[]): ChatHistory => ({ threadId: 't', title: 'Chat', messages });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function loaded() {
  const store = new SessionStore();
  store.replace('t', { ...EMPTY_STATE, hydrated: true, messages: [old], status: 'done' });
  return store;
}

describe('background transcript refresh', () => {
  it('adds the remote user message after an empty aborted turn settles', async () => {
    const core = createSessionCore();
    core.store.replace('t', { ...EMPTY_STATE, hydrated: true, messages: [old] });
    const read = vi.fn(async () => history([
      old, phone, { id: 'abort', role: 'system', content: 'Response interrupted', turnId: 'remote' }
    ]));
    const refresh = createHistoryRefresher(core.store, read, () => false);
    let emit!: (event: BackendEventEnvelope) => void;
    const events = attachBackendEvents(core, {
      routeEvent: (id) => id ?? null,
      settledStatus: (_method, id) => {
        queueMicrotask(() => void refresh(id));
        return 'done';
      }
    }, {
      subscribe: (handler) => { emit = handler; return () => {}; },
      makeBatcher: (apply) => ({ push: apply, flush: () => {} })
    });
    emit({ method: 'item/started', params: {
      threadId: 't', turnId: 'remote', item: { id: 'reasoning', type: 'reasoning' }
    }, receivedAt: 'now' });
    expect(core.store.getThread('t')?.running).toBe(true);
    emit({ method: 'turn/aborted', params: { threadId: 't', turn: { id: 'remote' } }, receivedAt: 'now' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(read).toHaveBeenCalledOnce();
    expect(core.store.getThread('t')).toMatchObject({
      running: false, hydrated: true, status: 'done', messages: [old, phone, { id: 'abort' }]
    });
    events.detach();
  });

  it('refreshes an already hydrated transcript without consuming its unread dot', async () => {
    const store = loaded();
    const refresh = createHistoryRefresher(store, async () => history([old, phone]), () => false);
    await refresh('t');
    expect(store.getThread('t')).toMatchObject({ messages: [old, phone], status: 'done' });
  });

  it('keeps rejected local sends and their retry errors when refreshing or reopening', async () => {
    const store = loaded();
    const failed: ChatMessage = { id: 'failed', role: 'user', content: 'Unsent', sendFailed: true };
    const error: ChatMessage = { id: 'error', role: 'system', content: 'Connection unavailable' };
    store.patch('t', () => ({ messages: [old, failed, error], status: 'error' }));
    const before = store.getThread('t')!;
    expect(mergeRefreshedThread(history([old, phone]), before, before).messages)
      .toEqual([old, phone, failed, error]);
    const refresh = createHistoryRefresher(store, async () => history([old, phone]), () => false);
    await refresh('t');
    expect(store.getThread('t')).toMatchObject({ messages: [old, phone, failed, error], status: 'error' });
  });

  it('reopening offline keeps a newer hydrated transcript', () => {
    const store = loaded();
    store.patch('t', () => ({ messages: [old, phone] }));
    const before = store.getThread('t')!;
    expect(mergeRefreshedThread({ ...history([old]), offline: true }, before, before)).toBe(before);
  });

  it('keeps a local send and streaming answer that arrive during the history read', async () => {
    const store = loaded();
    const pending = deferred<ChatHistory>();
    const refresh = createHistoryRefresher(store, () => pending.promise, () => false);
    const done = refresh('t');
    const local: ChatMessage = { id: 'local', role: 'user', content: 'A new local question' };
    const answer: ChatMessage = { id: 'answer', role: 'assistant', content: 'Streaming', turnId: 'local-turn' };
    store.patch('t', () => ({
      messages: [old, local, answer], running: true, streamingId: 'answer',
      activeTurnId: 'local-turn', status: 'running'
    }));
    pending.resolve(history([old, phone]));
    await done;
    expect(store.getThread('t')).toMatchObject({
      messages: [old, phone, local, answer], running: true, streamingId: 'answer',
      activeTurnId: 'local-turn', status: 'running'
    });
  });

  it('ignores an older response after a newer refresh completed', async () => {
    const store = loaded();
    const first = deferred<ChatHistory>();
    const second = deferred<ChatHistory>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const refresh = createHistoryRefresher(store, read, () => false);
    const firstDone = refresh('t');
    const secondDone = refresh('t');
    second.resolve(history([old, phone]));
    await secondDone;
    first.resolve(history([old]));
    await firstDone;
    expect(store.getThread('t')?.messages).toEqual([old, phone]);
  });

  it('does not resurrect a thread deleted while its read was pending', async () => {
    const store = loaded();
    const pending = deferred<ChatHistory>();
    let deleted = false;
    const refresh = createHistoryRefresher(store, () => pending.promise, () => deleted);
    const done = refresh('t');
    deleted = true;
    store.remove('t');
    pending.resolve(history([old, phone]));
    await done;
    expect(store.getThread('t')).toBeUndefined();
  });

  it('does not resurrect a turn removed by rollback while a read was pending', async () => {
    const store = loaded();
    store.patch('t', () => ({ messages: [old, phone] }));
    const pending = deferred<ChatHistory>();
    const refresh = createHistoryRefresher(store, () => pending.promise, () => false);
    const done = refresh('t');
    store.patch('t', () => ({ messages: [old] }));
    pending.resolve(history([old, phone]));
    await done;
    expect(store.getThread('t')?.messages).toEqual([old]);
  });

  it('does not load absent threads or read over an already running turn', async () => {
    const store = loaded();
    const read = vi.fn(async () => history([old]));
    const refresh = createHistoryRefresher(store, read, () => false);
    await refresh('absent');
    store.patch('t', () => ({ running: true }));
    await refresh('t');
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves displayed messages on network failure and stale offline replay', async () => {
    const store = loaded();
    store.patch('t', () => ({ messages: [old, phone] }));
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...history([old]), offline: true });
    const refresh = createHistoryRefresher(store, read, () => false);
    await refresh('t');
    await refresh('t');
    expect(store.getThread('t')?.messages).toEqual([old, phone]);
  });
});

it('keeps an authoritative transcript when an incomplete desktop refresh omits its tail', () => {
  const before = { ...EMPTY_STATE, hydrated: true, messages: [old, phone] };
  expect(mergeRefreshedThread({ ...history([old]), complete: false }, before, before).messages).toMatchObject([old, phone]);
  expect(mergeRefreshedThread({ ...history([old]), complete: true }, before, before).messages).toEqual([old]);
});

it('does not acknowledge a desktop pending prompt from an offline initial snapshot', () => {
  const pending = { ...phone, pendingHistory: true };
  const before = { ...EMPTY_STATE, messages: [pending] };
  expect(mergeRefreshedThread({ ...history([phone]), offline: true }, before, before).messages[0].pendingHistory).toBe(true);
});
