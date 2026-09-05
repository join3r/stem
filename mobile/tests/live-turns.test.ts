import { describe, expect, it } from 'vitest';
import type { BackendEventEnvelope } from '@shared/types';
import { applyLiveTurnEvent, liveTurnList, liveTurnsFromSnapshot } from '../src/transport/live-turns';

const event = (method: string, params: unknown): BackendEventEnvelope => ({
  method,
  params,
  receivedAt: '2026-08-14T10:00:00.000Z'
});

describe('liveTurnsFromSnapshot', () => {
  it('replaces what the client believed, because the frame is the whole answer', () => {
    const live = liveTurnsFromSnapshot([{ threadId: 't1', turnId: 'u1' }, { threadId: 't2', turnId: null }]);
    expect([...live]).toEqual([
      ['t1', 'u1'],
      ['t2', '']
    ]);
    expect(liveTurnList(live)).toEqual([
      { threadId: 't1', turnId: 'u1' },
      { threadId: 't2', turnId: null }
    ]);
  });
});

describe('applyLiveTurnEvent', () => {
  it('marks a thread working on the first item or the first token', () => {
    let live = new Map<string, string>();
    live = applyLiveTurnEvent(live, event('item/started', { threadId: 't1', turnId: 'u1' }));
    expect(live.get('t1')).toBe('u1');
    live = applyLiveTurnEvent(live, event('item/agentMessage/delta', { threadId: 't2', turnId: 'u2', delta: 'hi' }));
    expect(live.get('t2')).toBe('u2');
  });

  it('returns the same map when nothing changed, so a token stream re-renders nothing', () => {
    const first = applyLiveTurnEvent(new Map(), event('item/started', { threadId: 't1', turnId: 'u1' }));
    const second = applyLiveTurnEvent(first, event('item/agentMessage/delta', { threadId: 't1', turnId: 'u1' }));
    expect(second).toBe(first);
    expect(applyLiveTurnEvent(first, event('item/completed', { threadId: 't1' }))).toBe(first);
  });

  it('lets a new turn in the same thread replace the id Stop would interrupt', () => {
    let live = applyLiveTurnEvent(new Map(), event('item/started', { threadId: 't1', turnId: 'u1' }));
    live = applyLiveTurnEvent(live, event('item/started', { threadId: 't1', turnId: 'u2' }));
    expect(live.get('t1')).toBe('u2');
  });

  it('clears a thread however its turn ended', () => {
    for (const method of ['turn/completed', 'turn/failed', 'turn/aborted']) {
      const live = applyLiveTurnEvent(
        new Map([['t1', 'u1']]),
        event(method, { threadId: 't1', turnId: 'u1' })
      );
      expect(live.has('t1')).toBe(false);
    }
  });

  it('clears everything for an unattributed backend exit', () => {
    const live = applyLiveTurnEvent(new Map([['t1', 'u1']]), event('process/exit', {}));
    expect(live.size).toBe(0);
  });

  it('preserves live turns on diagnostics and exits of idle workers', () => {
    const live = new Map([['t1', 'u1']]);
    expect(applyLiveTurnEvent(live, event('process/stderr', { text: 'diagnostic' }))).toBe(live);
    expect(applyLiveTurnEvent(live, event('process/exit', { threadId: null, code: 0 }))).toBe(live);
  });

  it('clears only the turn carried by the worker that exited', () => {
    const live = new Map([['t1', 'u1'], ['t2', 'u2']]);
    const next = applyLiveTurnEvent(live, event('process/exit', { threadId: 't1', code: 1 }));
    expect([...next]).toEqual([['t2', 'u2']]);
    expect(applyLiveTurnEvent(next, event('process/exit', { threadId: 'other' }))).toBe(next);
  });
});
