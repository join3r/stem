// The shared turn-lifecycle core both windows (main App and Quick Chat) now run
// on: the external session store, the batched backend-event pipeline with its
// settled-turn race guard, and the optimistic-send skeleton. These used to be two
// hand-maintained copies that had drifted (different settled caps, missing delta
// batching, divergent process-exit handling) — the tests pin the unified behavior.

import { describe, expect, it } from 'vitest';
import type { BackendEventEnvelope, StartTurnResult } from '../../src/shared/types';
import { EMPTY_STATE } from '../../src/renderer/chatState';
import { SessionStore } from '../../src/renderer/session/store';
import {
  SETTLED_TURN_CAP,
  SettledTurns,
  applyLiveTurns,
  attachBackendEvents,
  createSessionCore,
  interruptActiveTurn,
  removeFailedSend,
  rerunFromTurn,
  sendTurn,
  type SessionCore,
  type TurnEventHost
} from '../../src/renderer/session/turns';

// Pass-through batcher: the real one coalesces deltas per animation frame, which
// needs rAF/document. Ordering-under-batching is eventBatcher's own concern.
const passthroughBatcher = (apply: (event: BackendEventEnvelope) => void) => ({
  push: apply,
  flush: () => {}
});

function attach(core: SessionCore, host: Partial<TurnEventHost> = {}) {
  let emit: (event: BackendEventEnvelope) => void = () => {};
  attachBackendEvents(
    core,
    {
      routeEvent: (threadId) => threadId ?? null,
      settledStatus: () => 'idle',
      ...host
    },
    {
      subscribe: (handler) => {
        emit = handler;
        return () => {};
      },
      makeBatcher: passthroughBatcher
    }
  );
  return (method: string, params: unknown) => emit({ method, params, receivedAt: 'now' });
}

const settledEvent = (threadId: string, turnId: string) => ({
  threadId,
  turn: { id: turnId }
});

/** sendTurn invokes `start` on a microtask; flush it before asserting. */
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('session store', () => {
  it('reads synchronously and keeps snapshot identity until a change commits', () => {
    const store = new SessionStore();
    const before = store.snapshot();
    store.update((prev) => prev); // no-op must not notify or change identity
    expect(store.snapshot()).toBe(before);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.patch('t1', () => ({ running: true }));
    expect(notified).toBe(1);
    expect(store.getThread('t1')?.running).toBe(true);
    expect(store.snapshot()).not.toBe(before);
  });

  it('remove is a no-op (no notification) for unknown keys', () => {
    const store = new SessionStore();
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.remove('missing');
    expect(notified).toBe(0);
  });
});

describe('settled-turn race guard', () => {
  it('consumes a noted turn exactly once and caps the set', () => {
    const settled = new SettledTurns();
    settled.note('t-1');
    expect(settled.consume('t-1')).toBe(true);
    expect(settled.consume('t-1')).toBe(false);
    expect(settled.consume(undefined)).toBe(false);
    for (let i = 0; i < SETTLED_TURN_CAP + 10; i += 1) settled.note(`x-${i}`);
    // Oldest entries were evicted; newest survive.
    expect(settled.consume('x-0')).toBe(false);
    expect(settled.consume(`x-${SETTLED_TURN_CAP + 9}`)).toBe(true);
  });
});

describe('backend event pipeline', () => {
  it('routes events to the host-chosen key and drops rejected ones', () => {
    const core = createSessionCore();
    const emit = attach(core, {
      routeEvent: (threadId) => (threadId === 'ignored' ? null : threadId ?? null)
    });
    emit('item/agentMessage/delta', { threadId: 'a', turnId: 'turn1', itemId: 'i', delta: 'hi' });
    emit('item/agentMessage/delta', { threadId: 'ignored', turnId: 'turn2', itemId: 'i', delta: 'no' });
    expect(core.store.getThread('a')?.messages[0]?.content).toBe('hi');
    expect(core.store.getThread('ignored')).toBeUndefined();
  });

  it('does settled bookkeeping even for events routing drops', () => {
    const core = createSessionCore();
    // Pending send whose turn id is known, registered under a key that is NOT the
    // event's thread id (the overlay's fixed key) — clearing must match by turn id.
    core.pendingSends.set('__overlay__', {
      promise: Promise.resolve({} as StartTurnResult),
      turnId: 'turn9',
      threadId: 'deleted-thread',
      isNewChat: false,
      text: 'x',
      attachments: []
    });
    const emit = attach(core, { routeEvent: () => null });
    emit('turn/completed', settledEvent('deleted-thread', 'turn9'));
    expect(core.pendingSends.size).toBe(0);
    expect(core.settledTurns.consume('turn9')).toBe(true);
  });

  it('reports turn/failed to the host before routing filters apply', () => {
    const core = createSessionCore();
    const failures: Array<[string | undefined, string | undefined]> = [];
    const emit = attach(core, {
      routeEvent: () => null,
      onTurnFailed: (error, turnId) => failures.push([error, turnId])
    });
    emit('turn/failed', { threadId: 'gone', error: 'boom', turn: { id: 't' } });
    expect(failures).toEqual([['boom', 't']]);
  });

  it('process/exit resets every slice, clears pending sends, and reports wasRunning', () => {
    const core = createSessionCore();
    core.store.patch('a', () => ({ running: true, status: 'running', activeTurnId: 't1' }));
    core.store.patch('b', () => ({ running: false }));
    core.pendingSends.set('a', {
      promise: Promise.resolve({} as StartTurnResult),
      turnId: 't1',
      threadId: 'a',
      isNewChat: false,
      text: 'x',
      attachments: []
    });
    let sawRunning: boolean | null = null;
    const emit = attach(core, { onProcessExit: (wasRunning) => (sawRunning = wasRunning) });
    emit('process/exit', undefined);
    expect(sawRunning).toBe(true);
    expect(core.pendingSends.size).toBe(0);
    expect(core.store.getThread('a')).toMatchObject({ running: false, activeTurnId: null, status: 'idle' });
  });
});

// What the window does with the live-turn snapshot it is handed the moment its
// event stream connects. The two failures it exists to prevent are opposites: a
// spinner on a turn that finished while nobody was listening, and a settled-
// looking thread that is in fact still being written to.
describe('applyLiveTurns', () => {
  it('settles a thread the server is no longer running', () => {
    const core = createSessionCore();
    core.store.patch('a', () => ({ running: true, status: 'running', activeTurnId: 'turn1' }));
    applyLiveTurns(core, []);
    expect(core.store.getThread('a')).toMatchObject({
      running: false,
      activeTurnId: null,
      streamingId: null,
      status: 'idle'
    });
  });

  it('marks a thread running again, with the turn id Stop needs', () => {
    const core = createSessionCore();
    core.store.patch('a', () => ({ running: false, status: 'idle', activeTurnId: null }));
    applyLiveTurns(core, [{ threadId: 'a', turnId: 'turn7' }]);
    // Without the turn id the thread would show a Stop button that cannot
    // interrupt anything, which is worse than showing none.
    expect(core.store.getThread('a')).toMatchObject({
      running: true,
      status: 'running',
      activeTurnId: 'turn7'
    });
  });

  it('leaves an optimistic spinner alone — it is early, not stale', () => {
    const core = createSessionCore();
    // A send whose bubble is up but whose first backend event has not arrived:
    // no activeTurnId yet, so the server could not possibly be reporting it.
    core.store.patch('__draft__', () => ({ running: true, status: 'running', activeTurnId: null }));
    applyLiveTurns(core, []);
    expect(core.store.getThread('__draft__')).toMatchObject({ running: true, activeTurnId: null });
  });

  it('keeps a slice keyed by something other than a thread id when its turn is live', () => {
    // The overlay's fixed key and the main window's DRAFT sentinel are not thread
    // ids and can never match by key, so they are settled by turn id instead.
    const core = createSessionCore();
    core.store.patch('__overlay__', () => ({ running: true, status: 'running', activeTurnId: 'turn3' }));
    applyLiveTurns(core, [{ threadId: 'a', turnId: 'turn3' }]);
    expect(core.store.getThread('__overlay__')).toMatchObject({ running: true, activeTurnId: 'turn3' });
  });

  it('never invents a slice for a thread nobody has opened', () => {
    const core = createSessionCore();
    applyLiveTurns(core, [{ threadId: 'never-opened', turnId: 'turn2' }]);
    // An empty running slice would make the next open show a blank conversation:
    // openChat keeps a live slice rather than reading the thread off disk.
    expect(core.store.getThread('never-opened')).toBeUndefined();
  });

  it('does not notify when nothing changed', () => {
    const core = createSessionCore();
    core.store.patch('a', () => ({ running: true, status: 'running', activeTurnId: 'turn1' }));
    const before = core.store.snapshot();
    applyLiveTurns(core, [{ threadId: 'a', turnId: 'turn1' }]);
    // Identity, not equality: every reconnect fires one of these, and a new
    // object each time would re-render every chat for nothing.
    expect(core.store.snapshot()).toBe(before);
  });
});

describe('sendTurn', () => {
  const spec = (_core: SessionCore, overrides: Record<string, unknown> = {}) => ({
    key: 'thread1',
    text: 'hello',
    attachments: [],
    meta: { model: 'm1' },
    isNewChat: false,
    start: () => Promise.resolve<StartTurnResult>({ threadId: 'thread1', turnId: 'turn1' }),
    ...overrides
  });

  it('appends the optimistic bubble, registers the pending send, and clears stale activities', async () => {
    const core = createSessionCore();
    core.store.patch('thread1', () => ({
      activities: [{ id: 'old', kind: 'tool', type: 'tool', status: 'running' } as never]
    }));
    let startedCtx: { alreadySettled: boolean } | null = null;
    const p = sendTurn(core, spec(core, {
      onStarted: (_r: StartTurnResult, ctx: { alreadySettled: boolean }) => (startedCtx = ctx)
    }) as never);
    // Synchronous effects, before the start promise resolves:
    const slice = core.store.getThread('thread1')!;
    expect(slice.running).toBe(true);
    expect(slice.activities).toEqual([]);
    expect(slice.messages.at(-1)?.content).toBe('hello');
    expect(core.pendingSends.get('thread1')?.text).toBe('hello');
    await p;
    expect(startedCtx).toMatchObject({ alreadySettled: false });
    expect(core.turnMeta.get('turn1')).toEqual({ model: 'm1' });
  });

  it('blocks a double send on the same key while a start is unresolved or running', async () => {
    const core = createSessionCore();
    let starts = 0;
    const slowStart = () => {
      starts += 1;
      return new Promise<StartTurnResult>(() => {});
    };
    void sendTurn(core, spec(core, { start: slowStart }) as never);
    void sendTurn(core, spec(core, { start: slowStart }) as never);
    await flushMicrotasks();
    expect(starts).toBe(1);
    expect(core.store.getThread('thread1')?.messages).toHaveLength(1);
  });

  it('a new draft generation may send while an older generation is still pending', async () => {
    const core = createSessionCore();
    let starts = 0;
    const slowStart = () => {
      starts += 1;
      return new Promise<StartTurnResult>(() => {});
    };
    void sendTurn(core, spec(core, { key: '__draft__', draftGeneration: 1, start: slowStart }) as never);
    core.store.replace('__draft__', EMPTY_STATE); // New chat reset the visible draft
    void sendTurn(core, spec(core, { key: '__draft__', draftGeneration: 2, start: slowStart }) as never);
    await flushMicrotasks();
    expect(starts).toBe(2);
  });

  it('consumes a terminal event that beat the start response (alreadySettled)', async () => {
    const core = createSessionCore();
    core.settledTurns.note('turn1');
    let ctx: { alreadySettled: boolean } | null = null;
    await sendTurn(core, spec(core, {
      onStarted: (_r: StartTurnResult, c: { alreadySettled: boolean }) => (ctx = c)
    }) as never);
    expect(ctx).toMatchObject({ alreadySettled: true });
  });

  it('applies a handled result and stops without onStarted', async () => {
    const core = createSessionCore();
    let onStartedCalled = false;
    let handled: StartTurnResult | null = null;
    await sendTurn(core, spec(core, {
      start: () => Promise.resolve<StartTurnResult>({ handled: true, assistantMessage: 'noted!' }),
      onStarted: () => (onStartedCalled = true),
      onHandled: (r: StartTurnResult) => (handled = r)
    }) as never);
    const slice = core.store.getThread('thread1')!;
    expect(onStartedCalled).toBe(false);
    expect(handled).toMatchObject({ handled: true });
    expect(slice.running).toBe(false);
    expect(slice.messages.at(-1)?.content).toBe('noted!');
    expect(core.pendingSends.size).toBe(0);
  });

  it('a failed stale start cannot write into a newer owner of the key', async () => {
    const core = createSessionCore();
    let reject!: (e: Error) => void;
    const p = sendTurn(core, spec(core, {
      key: '__draft__',
      draftGeneration: 1,
      start: () => new Promise<StartTurnResult>((_res, rej) => (reject = rej))
    }) as never);
    await flushMicrotasks(); // let the queued start() run so `reject` is captured
    // A newer draft send replaced the key (e.g. after a New chat reset).
    core.store.replace('__draft__', EMPTY_STATE);
    void sendTurn(core, spec(core, {
      key: '__draft__',
      draftGeneration: 2,
      start: () => new Promise<StartTurnResult>(() => {})
    }) as never);
    reject(new Error('provider down'));
    await p;
    // The newer send's slice must not get the stale failure bubble, and its
    // pending record must survive.
    const slice = core.store.getThread('__draft__')!;
    expect(slice.messages.some((m) => m.role === 'system')).toBe(false);
    expect(core.pendingSends.get('__draft__')?.draftGeneration).toBe(2);
  });

  it('a failed current start appends the system bubble and clears its pending record', async () => {
    const core = createSessionCore();
    await sendTurn(core, spec(core, {
      start: () => Promise.reject(new Error('boom'))
    }) as never);
    const slice = core.store.getThread('thread1')!;
    expect(slice.messages.at(-1)).toMatchObject({ role: 'system' });
    expect(slice.status).toBe('error');
    expect(core.pendingSends.size).toBe(0);
  });

  it('marks the orphaned user bubble sendFailed when the start rejects', async () => {
    const core = createSessionCore();
    await sendTurn(core, spec(core, {
      start: () => Promise.reject(new Error('Agent is already processing'))
    }) as never);
    const slice = core.store.getThread('thread1')!;
    const user = slice.messages.find((m) => m.role === 'user')!;
    expect(user.sendFailed).toBe(true);
    expect(user.turnId).toBeUndefined();
  });
});

describe('removeFailedSend', () => {
  const failSend = async (core: SessionCore, key = 'thread1', text = 'hello') => {
    await sendTurn(core, {
      key,
      text,
      attachments: [],
      meta: { model: 'm1' },
      isNewChat: false,
      start: () => Promise.reject(new Error('Agent is already processing'))
    } as never);
    return core.store.getThread(key)!.messages.find((m) => m.role === 'user' && m.sendFailed)!;
  };

  it('splices the orphan and its error bubble, returns the payload, and clears the error status', async () => {
    const core = createSessionCore();
    const user = await failSend(core);
    const restore = removeFailedSend(core, 'thread1', user.id);
    expect(restore).toEqual({ text: 'hello', attachments: [] });
    const slice = core.store.getThread('thread1')!;
    expect(slice.messages).toHaveLength(0);
    expect(slice.status).toBe('idle');
  });

  it('leaves earlier messages and turn-level error bubbles untouched', async () => {
    const core = createSessionCore();
    core.store.patch('thread1', () => ({
      messages: [
        { id: 'u0', role: 'user' as const, content: 'earlier', turnId: 't0' },
        { id: 'a0', role: 'assistant' as const, content: 'reply', turnId: 't0' }
      ]
    }));
    const user = await failSend(core);
    // A later turn-owned error bubble must survive the splice.
    core.store.patch('thread1', (s) => ({
      messages: [...s.messages, { id: 'sys-t9', role: 'system' as const, content: 'turn died', turnId: 't9' }]
    }));
    removeFailedSend(core, 'thread1', user.id);
    expect(core.store.getThread('thread1')!.messages.map((m) => m.id)).toEqual(['u0', 'a0', 'sys-t9']);
  });

  it('no-ops while the slice is running or for a non-failed message', async () => {
    const core = createSessionCore();
    const user = await failSend(core);
    core.store.patch('thread1', () => ({ running: true }));
    expect(removeFailedSend(core, 'thread1', user.id)).toBeNull();
    core.store.patch('thread1', () => ({ running: false }));
    expect(removeFailedSend(core, 'thread1', 'unknown-id')).toBeNull();
    expect(core.store.getThread('thread1')!.messages.length).toBeGreaterThan(0);
  });
});

describe('interrupt and rerun', () => {
  it('waits for an unresolved start to learn the interruptible turn id', async () => {
    const core = createSessionCore();
    let resolveStart!: (r: StartTurnResult) => void;
    const promise = new Promise<StartTurnResult>((res) => (resolveStart = res));
    const pending = {
      promise,
      turnId: null as string | null,
      threadId: null as string | null,
      isNewChat: false,
      text: 'x',
      attachments: []
    };
    core.pendingSends.set('k', pending);
    core.store.patch('k', () => ({ running: true, status: 'running' }));
    const interrupted: string[] = [];
    const done = interruptActiveTurn(core, {
      pendingKey: 'k',
      interrupt: async (id) => {
        interrupted.push(id);
      }
    });
    pending.turnId = 'turn7';
    resolveStart({ turnId: 'turn7' });
    await done;
    expect(interrupted).toEqual(['turn7']);
    expect(core.store.getThread('k')).toMatchObject({ running: false, activeTurnId: null, activities: [] });
  });

  it('interrupts a pending start immediately via its client-minted turn id', async () => {
    // The old behavior parked Stop on the start promise — which could sit behind
    // another turn's foreground gate for minutes. The minted id lets the
    // interrupt go out while the start is still in flight.
    const core = createSessionCore();
    let mintedId: string | null = null;
    void sendTurn(core, {
      key: 'k',
      text: 'x',
      attachments: [],
      meta: {},
      isNewChat: false,
      start: (input: { turnId: string }) => {
        mintedId = input.turnId;
        return new Promise<StartTurnResult>(() => {}); // never resolves
      }
    } as never);
    await flushMicrotasks();
    expect(mintedId).toBeTruthy();
    expect(core.pendingSends.get('k')?.turnId).toBe(mintedId);

    const interrupted: string[] = [];
    await interruptActiveTurn(core, {
      pendingKey: 'k',
      interrupt: async (id) => {
        interrupted.push(id);
      }
    });
    expect(interrupted).toEqual([mintedId]);
    expect(core.store.getThread('k')).toMatchObject({ running: false, status: 'idle' });
  });

  it('events from a stopped turn cannot flip the slice back to running', async () => {
    // The backend abort is not instantaneous; the turn may stream a few more
    // events while it winds down. Content still applies (truthful transcript),
    // but reviving the spinner reads as the Stop button silently failing.
    const core = createSessionCore();
    const emit = attach(core);
    emit('item/started', { threadId: 't1', turnId: 'turn1', item: { id: 'r1', type: 'reasoning' } });
    expect(core.store.getThread('t1')?.running).toBe(true);

    await interruptActiveTurn(core, { pendingKey: 't1', interrupt: async () => {} });
    expect(core.store.getThread('t1')?.running).toBe(false);

    emit('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'a', delta: 'late' });
    const slice = core.store.getThread('t1')!;
    expect(slice.running).toBe(false);
    expect(slice.activeTurnId).toBeNull();
    expect(slice.messages.at(-1)?.content).toBe('late');

    // The terminal event clears the latch so the id doesn't linger.
    emit('turn/completed', settledEvent('t1', 'turn1'));
    expect(core.interruptedTurns.has('turn1')).toBe(false);
  });

  it('a failed interrupt un-latches the turn so live events resume', async () => {
    const core = createSessionCore();
    const emit = attach(core);
    emit('item/started', { threadId: 't1', turnId: 'turn1', item: { id: 'r1', type: 'reasoning' } });

    await interruptActiveTurn(core, {
      pendingKey: 't1',
      interrupt: async () => {
        throw new Error('offline');
      }
    });
    expect(core.interruptedTurns.has('turn1')).toBe(false);

    emit('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'a', delta: 'x' });
    expect(core.store.getThread('t1')?.running).toBe(true);
  });

  it('rerunFromTurn rolls back, truncates to before the turn, and re-sends with original attachments', async () => {
    const core = createSessionCore();
    core.store.patch('t', () => ({
      messages: [
        { id: 'u1', role: 'user', content: 'first', turnId: 'turn1' },
        { id: 'a1', role: 'assistant', content: 'reply', turnId: 'turn1' },
        {
          id: 'u2',
          role: 'user',
          content: 'second',
          turnId: 'turn2',
          turnAttachments: [{ name: 'f.png', dataBase64: 'zz', mime: 'image/png' }]
        }
      ] as never
    }));
    const rolledBack: string[] = [];
    const sent: Array<[string, number]> = [];
    await rerunFromTurn(core, {
      key: 't',
      threadId: 't',
      turnId: 'turn2',
      text: 'second (edited)',
      rollback: async (_tid, turnId) => {
        rolledBack.push(turnId);
      },
      send: (text, attachments) => sent.push([text, attachments.length])
    });
    expect(rolledBack).toEqual(['turn2']);
    expect(sent).toEqual([['second (edited)', 1]]);
    expect(core.store.getThread('t')?.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('rerunFromTurn surfaces a rollback failure and leaves the slice intact', async () => {
    const core = createSessionCore();
    core.store.patch('t', () => ({
      messages: [{ id: 'u1', role: 'user', content: 'first', turnId: 'turn1' }] as never
    }));
    let sent = false;
    await rerunFromTurn(core, {
      key: 't',
      threadId: 't',
      turnId: 'turn1',
      text: 'first',
      rollback: () => Promise.reject(new Error('no earlier history')),
      send: () => (sent = true)
    });
    expect(sent).toBe(false);
    const messages = core.store.getThread('t')!.messages;
    expect(messages[0].content).toBe('first');
    expect(messages.at(-1)).toMatchObject({ role: 'system' });
  });
});
