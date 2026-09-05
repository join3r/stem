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
