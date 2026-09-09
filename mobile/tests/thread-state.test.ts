// The read path, end to end and without React: a scripted stream of frames goes
// in, a transcript comes out.
//
// The pipeline under test is exactly the one src/hooks/useThread.ts installs —
// filter by threadId, batch the deltas, fold with @shared/chatState — assembled
// here by hand because that is the part worth pinning. The hook itself is
// wiring; this is the behaviour.

import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  mergeHydratedThread,
  type ThreadState
} from '@shared/chatState';
import type { BackendEventEnvelope, ChatMessage } from '@shared/types';
import { type Scheduler } from '../src/transport/eventBatcher';
import { createThreadEvents } from '../src/chat/events';

const event = (method: string, params: unknown): BackendEventEnvelope => ({
  method,
  params,
  receivedAt: '2026-08-14T10:00:00.000Z'
});

/** The screen's own handler, minus React: filter, batch, fold. */
function thread(threadId: string, schedule: Scheduler, initial: ThreadState = EMPTY_STATE) {
  let state = initial;
  let refreshes = 0;
  const events = createThreadEvents({
    threadId,
    read: () => state,
    apply: (update) => { state = update(state); },
    sending: () => false,
    refresh: () => { refreshes++; },
    schedule
  });
  return {
    deliver: events.deliver,
    flush: events.flush,
    get refreshes(): number { return refreshes; },
    get state(): ThreadState {
      return state;
    }
  };
}

function manualScheduler(): { schedule: Scheduler; tick: () => void } {
  let queued: (() => void) | null = null;
  return {
    schedule: (run) => {
      queued = run;
      return () => {
        queued = null;
      };
    },
    tick: () => {
      const run = queued;
      queued = null;
      run?.();
    }
  };
}

const text = (messages: ChatMessage[]): [string, string][] =>
  messages.map((m) => [m.role, m.content] as [string, string]);

describe('folding a live turn', () => {
  it('refreshes the history when another device aborts without an answer', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule, { ...EMPTY_STATE, hydrated: true });
    t.deliver(event('turn/aborted', { threadId: 't1', turn: { id: 'remote-turn' } }));
    expect(t.refreshes).toBe(1);
    expect(t.state.running).toBe(false);
  });

  it('keeps a local turn notice without a redundant history read', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule, {
      ...EMPTY_STATE, running: true,
      messages: [{ id: 'u1', role: 'user', content: 'hello', turnId: 'local-turn' }]
    });
    t.deliver(event('turn/aborted', { threadId: 't1', turn: { id: 'local-turn' } }));
    expect(t.refreshes).toBe(0);
  });

  it('does not treat diagnostics or another worker exit as this turn stopping', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule, { ...EMPTY_STATE, running: true, activeTurnId: 'u1' });
    t.deliver(event('process/stderr', { text: 'diagnostic' }));
    t.deliver(event('process/exit', { threadId: 't2' }));
    t.deliver(event('process/exit', { threadId: null }));
    expect(t.state.running).toBe(true);
    t.deliver(event('process/exit', { threadId: 't1' }));
    expect(t.state.running).toBe(false);
  });

  it('assembles a reply out of deltas and settles it', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule);

    t.deliver(event('item/started', { threadId: 't1', turnId: 'u1', item: { type: 'agentMessage', id: 'm1' } }));
    expect(t.state.running).toBe(true);

    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'u1', itemId: 'm1', delta: 'Hello' }));
    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'u1', itemId: 'm1', delta: ', world' }));
    clock.tick();

    expect(text(t.state.messages)).toEqual([['assistant', 'Hello, world']]);
    expect(t.state.streamingId).toBe('assistant-u1');

    t.deliver(
      event('item/completed', {
        threadId: 't1',
        turnId: 'u1',
        item: { type: 'agentMessage', id: 'm1', text: 'Hello, world!' }
      })
    );
    t.deliver(event('turn/completed', { threadId: 't1', turn: { id: 'u1' } }));

    expect(text(t.state.messages)).toEqual([['assistant', 'Hello, world!']]);
    expect(t.state.running).toBe(false);
    expect(t.state.status).toBe('idle');
    expect(t.state.streamingId).toBeNull();
  });

  it('keeps a turn’s tool calls with its bubble once the turn settles', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule);

    t.deliver(
      event('item/started', {
        threadId: 't1',
        turnId: 'u1',
        item: { type: 'commandExecution', id: 'c1', name: 'bash', detail: 'ls' }
      })
    );
    expect(t.state.activities).toHaveLength(1);
    expect(t.state.activity).not.toBeNull();

    t.deliver(
      event('item/completed', {
        threadId: 't1',
        turnId: 'u1',
        item: { type: 'commandExecution', id: 'c1', status: 'ok' }
      })
    );
    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'u1', itemId: 'm1', delta: 'done' }));
    clock.tick();
    t.deliver(event('turn/completed', { threadId: 't1', turn: { id: 'u1' } }));

    expect(t.state.activities).toEqual([]);
    expect(t.state.messages[0].activity).toHaveLength(1);
    expect(t.state.messages[0].activity?.[0].status).toBe('ok');
  });

  it('turns a failed turn into a system bubble that explains a dropped connection', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule);

    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'u1', itemId: 'm1', delta: 'part' }));
    clock.tick();
    t.deliver(event('turn/failed', { threadId: 't1', turn: { id: 'u1' }, error: 'WebSocket error' }));

    const system = t.state.messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('connection to the model dropped');
    expect(t.state.running).toBe(false);
  });

  it('ignores every frame belonging to another thread — the phone gets them all', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule);

    t.deliver(event('item/agentMessage/delta', { threadId: 't2', turnId: 'u9', itemId: 'm9', delta: 'not mine' }));
    t.deliver(event('turn/completed', { threadId: 't2', turn: { id: 'u9' } }));
    clock.tick();

    expect(t.state).toBe(EMPTY_STATE);
  });

  it('ends the turn when the backend goes away, even though the event names no thread', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule);

    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'u1', itemId: 'm1', delta: 'half' }));
    t.deliver(event('process/exit', {}));

    expect(text(t.state.messages)).toEqual([['assistant', 'half']]);
    expect(t.state.running).toBe(false);
    expect(t.state.activeTurnId).toBeNull();
  });

  it('delivers buffered tokens when the screen goes away rather than dropping them', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule);

    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'u1', itemId: 'm1', delta: 'tail' }));
    t.flush();

    expect(text(t.state.messages)).toEqual([['assistant', 'tail']]);
  });
});

describe('hydrating from chats:open', () => {
  const history: ChatMessage[] = [
    { id: 'h1', role: 'user', content: 'earlier question' },
    { id: 'h2', role: 'assistant', content: 'earlier answer' }
  ];

  it('takes the disk transcript when nothing streamed during the read', () => {
    const merged = mergeHydratedThread(history, EMPTY_STATE, EMPTY_STATE);
    expect(text(merged.messages)).toEqual([
      ['user', 'earlier question'],
      ['assistant', 'earlier answer']
    ]);
    expect(merged.running).toBe(false);
  });

  it('keeps a turn that started while the transcript was being read', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule);
    const stateAtRequest = t.state;

    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'u2', itemId: 'm2', delta: 'racing' }));
    clock.tick();

    const merged = mergeHydratedThread(history, t.state, stateAtRequest);
    expect(text(merged.messages)).toEqual([
      ['user', 'earlier question'],
      ['assistant', 'earlier answer'],
      ['assistant', 'racing']
    ]);
    expect(merged.running).toBe(true);
  });
});

describe('persisted runtime identity', () => {
  const user: ChatMessage = { id: 'user-entry', role: 'user', content: 'Test', turnId: 'entry', runtimeTurnId: 'run' };
  const answer: ChatMessage = { id: 'assistant-run', role: 'assistant', content: 'Accepted', turnId: 'entry', runtimeTurnId: 'run' };
  it('keeps one answer when completion follows hydration', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule, mergeHydratedThread([user, answer], EMPTY_STATE, EMPTY_STATE));
    t.deliver(event('item/completed', { threadId: 't1', turnId: 'run', item: { type: 'agentMessage', id: 'run', text: 'Accepted' } }));
    expect(t.state.messages).toHaveLength(2);
    expect(t.state.messages[1].turnId).toBe('entry');
  });
  it('reconciles partial streaming text against a full persisted reply', () => {
    const live: ThreadState = { ...EMPTY_STATE, running: true, messages: [{ ...answer, turnId: 'run', content: 'Ac' }] };
    expect(mergeHydratedThread([user, answer], live, EMPTY_STATE).messages).toEqual([user, expect.objectContaining({ content: 'Accepted', turnId: 'entry' })]);
  });
  it('keeps an unacknowledged prompt but allows a later rollback to remove it', () => {
    const pending: ThreadState = { ...EMPTY_STATE, messages: [{ ...user, id: 'optimistic', pendingHistory: true }] };
    const absent = mergeHydratedThread([], pending, pending);
    expect(absent.messages).toHaveLength(1);
    const acknowledged = mergeHydratedThread([user], absent, absent);
    expect(acknowledged.messages[0].pendingHistory).toBeUndefined();
    expect(mergeHydratedThread([], acknowledged, acknowledged).messages).toEqual([]);
  });
  it('does not acknowledge a prompt from an incomplete response', () => {
    const pending: ThreadState = { ...EMPTY_STATE, messages: [{ ...user, pendingHistory: true }] };
    expect(mergeHydratedThread([user], pending, pending, false).messages[0].pendingHistory).toBe(true);
  });
  it('does not collapse equal text belonging to different known turns', () => {
    const live: ThreadState = { ...EMPTY_STATE, running: true, messages: [{ ...user, id: 'second', runtimeTurnId: 'run2', pendingHistory: true }] };
    expect(mergeHydratedThread([user, answer], live, EMPTY_STATE).messages).toHaveLength(3);
  });
});

describe('history overlaps buffered absolute deltas', () => {
  it.each([
    ['Accepted', 'cep', 2, 'ted', 5],
    ['Checking\n\nDone', '\n\nDo', 8, 'ne', 12]
  ] as const)('does not append replayed suffixes to %s', (content, first, offset, second, nextOffset) => {
    const clock = manualScheduler();
    const initial: ThreadState = { ...EMPTY_STATE, hydrated: true, messages: [{ id: 'assistant-run', role: 'assistant', content, runtimeTurnId: 'run', turnId: 'entry' }] };
    const t = thread('t1', clock.schedule, initial);
    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'run', itemId: 'run', delta: first, offset }));
    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'run', itemId: 'run', delta: second, offset: nextOffset }));
    t.flush();
    expect(t.state.messages[0].content).toBe(content);
  });
  it('restores a missed stream prefix before applying later deltas', () => {
    const clock = manualScheduler();
    const t = thread('t1', clock.schedule);
    t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'run', itemId: 'run', delta: 'cept', offset: 2 }));
    t.flush();
    const state = mergeHydratedThread([{ id: 'assistant-run', role: 'assistant', content: 'Accepted', runtimeTurnId: 'run' }], t.state, EMPTY_STATE);
    expect(state.messages[0].content).toBe('Accepted');
    const resumed = thread('t1', clock.schedule, state);
    resumed.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'run', itemId: 'run', delta: 'ed', offset: 6 }));
    resumed.flush();
    expect(resumed.state.messages[0].content).toBe('Accepted');
  });
});

it('does not acknowledge a new repeated prompt against legacy history', () => {
  const legacy: ChatMessage[] = [{ id: 'old-user', role: 'user', content: 'Again' }, { id: 'old-answer', role: 'assistant', content: 'Done' }];
  const live: ThreadState = { ...EMPTY_STATE, messages: [
    { id: 'new-user', role: 'user', content: 'Again', runtimeTurnId: 'new-run', pendingHistory: true },
    { id: 'assistant-new-run', role: 'assistant', content: 'Done', runtimeTurnId: 'new-run' }
  ] };
  const result = mergeHydratedThread(legacy, live, EMPTY_STATE);
  expect(result.messages).toHaveLength(4);
  expect(result.messages[2].pendingHistory).toBe(true);
});

it('holds ambiguous citation offsets until a completed reply establishes the baseline', () => {
  const clock = manualScheduler();
  const hydrated = mergeHydratedThread([{ id: 'assistant-run', role: 'assistant', content: 'Found it', runtimeTurnId: 'run' }], EMPTY_STATE, EMPTY_STATE);
  const t = thread('t1', clock.schedule, hydrated);
  t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'run', itemId: 'run', delta: 'it', offset: 50 }));
  t.flush();
  expect(t.state.messages[0].content).toBe('Found it');
  t.deliver(event('item/completed', { threadId: 't1', turnId: 'run', item: { type: 'agentMessage', id: 'run', text: 'Found it' } }));
  t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'run', itemId: 'run', delta: '\n\nDetails', offset: 8 }));
  t.flush();
  expect(t.state.messages[0].content).toBe('Found it\n\nDetails');
});

it('does not regress a hydrated multipart reply on an older completed part', () => {
  const clock = manualScheduler();
  const t = thread('t1', clock.schedule, mergeHydratedThread([{ id: 'assistant-run', role: 'assistant', content: 'Checking\n\nDone', runtimeTurnId: 'run' }], EMPTY_STATE, EMPTY_STATE));
  t.deliver(event('item/completed', { threadId: 't1', turnId: 'run', item: { type: 'agentMessage', id: 'run', text: 'Checking' } }));
  t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'run', itemId: 'run', delta: '\n\nDone', offset: 8 }));
  t.flush();
  expect(t.state.messages[0].content).toBe('Checking\n\nDone');
});

it('does not splice a raw mid-answer suffix into citation-sanitized history', () => {
  const clock = manualScheduler();
  const t = thread('t1', clock.schedule);
  t.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'run', itemId: 'run', delta: 'it', offset: 50 }));
  t.flush();
  const hydrated = mergeHydratedThread([{ id: 'assistant-run', role: 'assistant', content: 'Found it', runtimeTurnId: 'run' }], t.state, EMPTY_STATE);
  expect(hydrated.messages[0].content).toBe('Found it');
  const resumed = thread('t1', clock.schedule, hydrated);
  resumed.deliver(event('item/agentMessage/delta', { threadId: 't1', turnId: 'run', itemId: 'run', delta: '.', offset: 52 }));
  resumed.flush();
  expect(resumed.state.messages[0].content).toBe('Found it');
  resumed.deliver(event('item/completed', { threadId: 't1', turnId: 'run', item: { type: 'agentMessage', id: 'run', text: 'Found it.' } }));
  expect(resumed.state.messages[0].content).toBe('Found it.');
});
