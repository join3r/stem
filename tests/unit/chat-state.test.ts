import { describe, expect, it } from 'vitest';
import type { BackendEventEnvelope, MessageMeta, ThreadStatus } from '../../src/shared/types';
import {
  EMPTY_STATE,
  applyBackendEventToThread,
  applyProcessExitToThread,
  backendEventThreadId,
  turnFailureMessage
} from '../../src/renderer/chatState';

function event(method: string, params: unknown): BackendEventEnvelope {
  return { method, params, receivedAt: '2026-06-23T00:00:00.000Z' };
}

describe('chatState reducer', () => {
  it('creates and appends streamed assistant deltas', () => {
    const first = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'Hel' })
    )!;
    const second = applyBackendEventToThread(
      first,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'lo' })
    )!;

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ id: 'assistant-turn1', role: 'assistant', content: 'Hello' });
    expect(second.running).toBe(true);
    expect(second.streamingId).toBe('assistant-turn1');
    expect(second.activeTurnId).toBe('turn1');
    expect(second.status).toBe('running');
  });

  it('makes an agent-message start interruptible before its first delta', () => {
    const next = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', { threadId: 't1', turnId: 'turn1', item: { type: 'agentMessage', id: 'a1' } })
    )!;

    expect(next).toMatchObject({ running: true, activeTurnId: 'turn1', status: 'running' });
  });

  it('uses completed agent text as authoritative and preserves metadata', () => {
    const meta = new Map<string, MessageMeta>([['turn1', { model: 'openai/test', effort: 'high' }]]);
    const streamed = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'draft' }),
      { turnMeta: meta }
    )!;
    const completed = applyBackendEventToThread(
      streamed,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'agentMessage', id: 'turn1', text: 'final' }
      }),
      { turnMeta: meta }
    )!;

    expect(completed.messages[0]).toMatchObject({ content: 'final', meta: { model: 'openai/test', effort: 'high' } });
    expect(completed.streamingId).toBeNull();
  });

  it('sets activity labels before text streams', () => {
    const next = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', { threadId: 't1', turnId: 'turn1', item: { type: 'webSearch', id: 'tool1' } })
    )!;

    expect(next.activity).toBe('Searching the web…');
    expect(next.running).toBe(true);
    expect(next.activeTurnId).toBe('turn1');
    expect(next.status).toBe('running');
  });

  it('carries a loaded skill as its own kind of row, and onto the reply', () => {
    // Skills are announced before the model has said anything, so the row has to
    // survive until the assistant bubble exists to be stamped onto — otherwise a
    // skill is announced to an empty screen and then lost.
    const started = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', { threadId: 't1', turnId: 'turn1', item: { type: 'skill', id: 's1', name: 'brew-coffee' } })
    )!;
    const settled = applyBackendEventToThread(
      started,
      event('item/completed', { threadId: 't1', turnId: 'turn1', item: { type: 'skill', id: 's1', status: 'ok' } })
    )!;
    expect(settled.activities).toMatchObject([{ id: 's1', kind: 'skill', type: 'skill', name: 'brew-coffee', status: 'ok' }]);

    const replying = applyBackendEventToThread(
      settled,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'here you go' })
    )!;
    expect(replying.messages.at(-1)!.activity).toMatchObject([{ id: 's1', kind: 'skill' }]);
  });

  it('marks reasoning-only starts as a live turn before any text delta', () => {
    const next = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', { threadId: 't1', turnId: 'turn1', item: { type: 'reasoning', id: 'r1' } })
    )!;

    expect(next).toMatchObject({ running: true, activeTurnId: 'turn1', status: 'running' });
  });

  it('clears running state for completed, failed, and aborted turns with caller status policy', () => {
    const running = { ...EMPTY_STATE, running: true, streamingId: 'assistant-turn1', activeTurnId: 'turn1', status: 'running' as const };
    const statusFor = (method: string): ThreadStatus => (method === 'turn/failed' ? 'error' : method === 'turn/completed' ? 'done' : 'idle');

    for (const method of ['turn/completed', 'turn/failed', 'turn/aborted'] as const) {
      const next = applyBackendEventToThread(
        running,
        event(method, { threadId: 't1', turn: { id: 'turn1', status: method.slice(5) } }),
        { settledStatus: (m) => statusFor(m) }
      )!;

      expect(next.running).toBe(false);
      expect(next.streamingId).toBeNull();
      expect(next.activity).toBeNull();
      expect(next.activeTurnId).toBeNull();
      expect(next.status).toBe(statusFor(method));
    }
  });

  it('surfaces a failed turn as a system bubble with its error text', () => {
    const running = { ...EMPTY_STATE, running: true, activeTurnId: 'turn1', status: 'running' as const };
    const failed = applyBackendEventToThread(
      running,
      event('turn/failed', { threadId: 't1', turn: { id: 'turn1', status: 'failed' }, error: '401 Unauthorized' })
    )!;
    expect(failed.messages.at(-1)).toMatchObject({ role: 'system', content: '401 Unauthorized' });

    // Without error text a generic message still tells the user what happened.
    const generic = applyBackendEventToThread(
      running,
      event('turn/failed', { threadId: 't1', turn: { id: 'turn1', status: 'failed' } })
    )!;
    expect(generic.messages.at(-1)).toMatchObject({ role: 'system' });
    expect((generic.messages.at(-1)!.content as string).length).toBeGreaterThan(0);

    // A dropped provider connection ("WebSocket error") must not read as a hard
    // failure: the copy reassures that already-committed work (a scheduled task)
    // survived, so a succeeded reminder isn't mistaken for a lost one.
    const dropped = applyBackendEventToThread(
      running,
      event('turn/failed', { threadId: 't1', turn: { id: 'turn1', status: 'failed' }, error: 'WebSocket error' })
    )!;
    const droppedText = dropped.messages.at(-1)!.content as string;
    expect(droppedText).toContain('WebSocket error');
    expect(droppedText).toMatch(/saved|Tasks tab/);

    // Completed/aborted turns do NOT grow a bubble.
    const completed = applyBackendEventToThread(
      running,
      event('turn/completed', { threadId: 't1', turn: { id: 'turn1', status: 'completed' } })
    )!;
    expect(completed.messages).toHaveLength(0);
  });

  it('stamps a post-run compaction row onto the settled bubble', () => {
    // pi's threshold compaction runs AFTER agent_end: the live activity list is
    // already cleared, so the row must land on the turn's message directly.
    const settled = {
      ...EMPTY_STATE,
      messages: [{ id: 'assistant-turn1', role: 'assistant' as const, content: 'done', turnId: 'turn1' }]
    };
    const stamped = applyBackendEventToThread(
      settled,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'compaction', id: 'compaction-turn1-post', status: 'ok' }
      })
    )!;
    expect(stamped.messages[0].activity).toEqual([
      { id: 'compaction-turn1-post', kind: 'tool', type: 'compaction', status: 'ok' }
    ]);
    expect(stamped.running).toBe(false);

    // Replaying the same event must not duplicate the row.
    expect(
      applyBackendEventToThread(
        stamped,
        event('item/completed', {
          threadId: 't1',
          turnId: 'turn1',
          item: { type: 'compaction', id: 'compaction-turn1-post', status: 'ok' }
        })
      )
    ).toBeNull();

    // A compaction for an unknown turn is dropped, not crashed on.
    expect(
      applyBackendEventToThread(
        settled,
        event('item/completed', {
          threadId: 't1',
          turnId: 'ghost',
          item: { type: 'compaction', id: 'compaction-ghost-post', status: 'ok' }
        })
      )
    ).toBeNull();
  });

  it('stamps the failed turn id on the error bubble only when its user message exists', () => {
    // With a user bubble carrying the turn id, the error bubble is retryable.
    const withUser = {
      ...EMPTY_STATE,
      messages: [{ id: 'user-1', role: 'user' as const, content: 'hi', turnId: 'turn1' }],
      running: true,
      activeTurnId: 'turn1',
      status: 'running' as const
    };
    const failed = applyBackendEventToThread(
      withUser,
      event('turn/failed', { threadId: 't1', turn: { id: 'turn1', status: 'failed' }, error: 'boom' })
    )!;
    expect(failed.messages.at(-1)).toMatchObject({ role: 'system', turnId: 'turn1' });

    // A synthetic failure (e.g. Quick Chat hand-off) mints a turn id no user
    // message has — Retry could never map it back, so it must not be offered.
    const synthetic = applyBackendEventToThread(
      withUser,
      event('turn/failed', { threadId: 't1', turn: { id: 'quick-start-99', status: 'failed' }, error: 'boom' })
    )!;
    expect(synthetic.messages.at(-1)!.role).toBe('system');
    expect(synthetic.messages.at(-1)!.turnId).toBeUndefined();
  });

  it('turnFailureMessage rewrites transport drops but passes other errors through', () => {
    expect(turnFailureMessage('WebSocket error')).toMatch(/dropped/i);
    expect(turnFailureMessage('socket hang up')).toMatch(/dropped/i);
    expect(turnFailureMessage('ECONNRESET')).toMatch(/dropped/i);
    // Auth/quota/other errors are already meaningful — keep them verbatim.
    expect(turnFailureMessage('401 Unauthorized')).toBe('401 Unauthorized');
    expect(turnFailureMessage('  ')).toMatch(/Try sending the message again/);
  });

  it('supports main inactive completion and quick-chat idle completion policies', () => {
    const running = { ...EMPTY_STATE, running: true, activeTurnId: 'turn1', status: 'running' as const };
    const completed = event('turn/completed', { threadId: 'background', turn: { id: 'turn1', status: 'completed' } });

    const main = applyBackendEventToThread(running, completed, {
      settledStatus: (_method, threadId) => (threadId === 'active' ? 'idle' : 'done')
    })!;
    const quickChat = applyBackendEventToThread(running, completed, { settledStatus: () => 'idle' })!;

    expect(main.status).toBe('done');
    expect(quickChat.status).toBe('idle');
  });

  it('clears active run state on process exit without dropping existing error/done status', () => {
    const running = { ...EMPTY_STATE, running: true, streamingId: 'assistant-turn1', activity: 'Working…', activeTurnId: 'turn1', status: 'running' as const };
    const done = { ...EMPTY_STATE, status: 'done' as const };

    expect(applyProcessExitToThread(running)).toMatchObject({
      running: false,
      streamingId: null,
      activity: null,
      activeTurnId: null,
      status: 'idle'
    });
    expect(applyProcessExitToThread(done).status).toBe('done');
  });

  it('attaches per-turn usage to the assistant message', () => {
    const completed = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'agentMessage', id: 'turn1', text: 'hi' }
      })
    )!;
    const withUsage = applyBackendEventToThread(
      completed,
      event('turn/usage', {
        threadId: 't1',
        turnId: 'turn1',
        input: 26459,
        output: 1339,
        cacheRead: 1920,
        cacheWrite: 0,
        totalTokens: 29718,
        cost: 0.17
      })
    )!;

    expect(withUsage.messages[0].usage).toEqual({
      input: 26459,
      output: 1339,
      cacheRead: 1920,
      cacheWrite: 0,
      totalTokens: 29718,
      cost: 0.17
    });
  });

  it('ignores usage for a turn with no assistant bubble', () => {
    expect(
      applyBackendEventToThread(
        EMPTY_STATE,
        event('turn/usage', {
          threadId: 't1',
          turnId: 'missing',
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: null
        })
      )
    ).toBeNull();
  });

  it('extracts thread ids from event params', () => {
    expect(backendEventThreadId(event('turn/completed', { threadId: 't1' }))).toBe('t1');
    expect(backendEventThreadId(event('process/exit', { code: 1 }))).toBeUndefined();
  });

  it('accumulates activity rows, survives streaming, and stamps them onto the message at settle', () => {
    let s = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c1', name: 'read', detail: 'a.md' }
      })
    )!;
    expect(s.activities).toEqual([
      { id: 'c1', kind: 'tool', type: 'commandExecution', name: 'read', detail: 'a.md', status: 'running' }
    ]);

    // Text streaming clears the label but keeps (and stamps) the activity rows.
    s = applyBackendEventToThread(
      s,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'Hi' })
    )!;
    expect(s.activity).toBeNull();
    expect(s.activities).toHaveLength(1);
    expect(s.messages[0].activity).toHaveLength(1);

    // Tool completion flips the row's status (and can refresh the detail).
    s = applyBackendEventToThread(
      s,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c1', status: 'ok' }
      })
    )!;
    expect(s.activities[0].status).toBe('ok');

    // Turn settle stamps the final list on the bubble and clears live state.
    s = applyBackendEventToThread(s, event('turn/completed', { threadId: 't1', turn: { id: 'turn1', status: 'completed' } }))!;
    expect(s.activities).toHaveLength(0);
    expect(s.messages[0].activity).toHaveLength(1);
    expect(s.messages[0].activity![0].status).toBe('ok');
  });

  it('labels concurrent tool calls with a count and falls back as they finish', () => {
    // pi executes a turn's tool calls in parallel — two starts before any end.
    let s = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c1', name: 'read', detail: 'a.md' }
      })
    )!;
    expect(s.activity).toBe('Reading a.md…');

    s = applyBackendEventToThread(
      s,
      event('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c2', name: 'grep', detail: 'foo' }
      })
    )!;
    expect(s.activity).toBe('Running 2 tools…');

    // One finishes (out of order) — the label falls back to the still-running tool.
    s = applyBackendEventToThread(
      s,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c1', status: 'ok' }
      })
    )!;
    expect(s.activity).toBe('Searching for foo…');

    // Last one finishes — the label is kept until reasoning/answer overwrites it.
    s = applyBackendEventToThread(
      s,
      event('item/completed', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'commandExecution', id: 'c2', status: 'ok' }
      })
    )!;
    expect(s.activity).toBe('Searching for foo…');
    expect(s.activities.map((a) => a.status)).toEqual(['ok', 'ok']);
  });

  it('dedupes repeated item/started for the same tool call', () => {
    const started = event('item/started', {
      threadId: 't1',
      turnId: 'turn1',
      item: { type: 'webSearch', id: 'ws1', name: 'web_search', detail: 'weather' }
    });
    const once = applyBackendEventToThread(EMPTY_STATE, started)!;
    const twice = applyBackendEventToThread(once, started)!;
    expect(twice.activities).toHaveLength(1);
    expect(twice.activities[0].kind).toBe('webSearch');
  });

  it('attaches web sources to the turn message', () => {
    let s = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/agentMessage/delta', { threadId: 't1', turnId: 'turn1', itemId: 'turn1', delta: 'Hi' })
    )!;
    s = applyBackendEventToThread(
      s,
      event('turn/sources', { threadId: 't1', turnId: 'turn1', sources: [{ url: 'https://example.com', title: 'Example' }] })
    )!;
    expect(s.messages[0].sources).toEqual([{ url: 'https://example.com', title: 'Example' }]);
  });

  it('updates a running coding_agent row live from harness/progress, by id then by type', () => {
    const started = applyBackendEventToThread(
      EMPTY_STATE,
      event('item/started', {
        threadId: 't1',
        turnId: 'turn1',
        item: { type: 'codingAgent', id: 'call-1', name: 'coding_agent', detail: 'claude' }
      })
    )!;
    const byId = applyBackendEventToThread(
      started,
      event('harness/progress', { threadId: 't1', itemId: 'call-1', detail: 'claude: editing src/foo.ts · 3 tool calls' })
    )!;
    expect(byId.activities[0].detail).toBe('claude: editing src/foo.ts · 3 tool calls');
    expect(byId.activity).toContain('claude: editing src/foo.ts');
    // Without an itemId the update lands on the running codingAgent row.
    const byType = applyBackendEventToThread(
      byId,
      event('harness/progress', { threadId: 't1', detail: 'claude: working · $0.10' })
    )!;
    expect(byType.activities[0].detail).toBe('claude: working · $0.10');
    // An update for a row that is gone (turn settled meanwhile) changes nothing.
    expect(
      applyBackendEventToThread(
        EMPTY_STATE,
        event('harness/progress', { threadId: 't1', itemId: 'call-1', detail: 'late' })
      )
    ).toBeNull();
  });
});
