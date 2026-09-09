import { describe, expect, it } from 'vitest';
import { PillTurns } from '../../src/desktop/quickchat/pill-turns';
import type { LiveTurnInfo } from '../../src/shared/types';

const chat = (turnId = 'turn-1', deviceId = 'mac', threadId = 'chat'): LiveTurnInfo => ({
  threadId, turnId, origin: { kind: 'interactive', deviceId }
});
const params = (turnId = 'turn-1', deviceId = 'mac', threadId = 'chat') => ({
  ...chat(turnId, deviceId, threadId), turnId
});
const connected = () => {
  const state = new PillTurns();
  state.reconcile('mac', []);
  return state;
};

describe('local interactive pill activity', () => {
  it('ignores other devices, mail, scheduled work, and unclassified background events', () => {
    const state = connected();
    for (const p of [params('phone', 'phone'), { ...params('mail'), origin: { kind: 'mail' as const } },
      { ...params('task'), origin: { kind: 'background' as const } },
      { threadId: 'internal', turnId: 'unknown' }, { ...params(), mail: true }, { ...params(), scheduled: true }]) {
      expect(state.event('item/started', p)).toBe(false);
      expect(state.event('turn/completed', p)).toBe(false);
    }
    expect(state.turns).toEqual([]);
  });

  it('tracks local chat and Quick Chat submissions before the start response', () => {
    const state = connected();
    state.submit({ input: 'hello', threadId: 'chat', turnId: 'local' });
    expect(state.event('item/started', { threadId: 'chat', turnId: 'local' })).toBe(true);
    state.accepted('local');
    expect(state.event('item/agentMessage/delta', { threadId: 'chat', turnId: 'local' })).toBe(true);
    expect(state.event('turn/completed', { threadId: 'chat', turn: { id: 'local' } })).toBe(true);
    expect(state.turns).toEqual([]);
  });

  it('does not resurrect a turn whose completion beat the start response', () => {
    const state = connected();
    state.submit({ input: 'hello', turnId: 'turn-1' });
    state.event('turn/completed', { threadId: 'chat', turn: { id: 'turn-1' } });
    state.accepted('turn-1');
    expect(state.event('item/agentMessage/delta', params())).toBe(false);
    expect(state.turns).toEqual([]);
  });

  it('does not revive a previous chat when a scheduled task reuses its conversation', () => {
    const state = connected();
    state.event('item/started', params());
    state.event('turn/completed', params());
    const task = { ...params('task'), origin: { kind: 'background' as const } };
    expect(state.event('item/started', task)).toBe(false);
    expect(state.event('turn/completed', task)).toBe(false);
    expect(state.turns).toEqual([]);
    expect(state.event('item/started', params('next'))).toBe(true);
  });

  it('keeps another local turn running when a turn completes, fails, or is stopped', () => {
    for (const end of ['turn/completed', 'turn/failed', 'turn/aborted']) {
      const state = connected();
      state.event('item/started', params('first'));
      state.event('item/started', params('second', 'mac', 'another-chat'));
      state.event(end, params('first'));
      expect(state.turns.map(t => t.turnId)).toEqual(['second']);
    }
  });

  it('does not let an old terminal event clear a newer turn in the same chat', () => {
    const state = connected();
    state.event('item/started', params('new'));
    expect(state.event('turn/completed', params('old'))).toBe(false);
    expect(state.turns.map(t => t.turnId)).toEqual(['new']);
  });

  it('hides immediately on disconnect and silently removes a missed completion', () => {
    const state = connected();
    state.event('item/started', params());
    state.disconnect();
    expect(state.turns).toEqual([]);
    expect(state.event('item/started', params())).toBe(false);
    expect(state.event('turn/completed', params())).toBe(false);
    state.reconcile('mac', []);
    expect(state.turns).toEqual([]);
    expect(state.event('item/agentMessage/delta', params())).toBe(false);
  });

  it('restores only verified local interactive turns after an app restart', () => {
    const state = new PillTurns();
    state.reconcile('mac', [chat(), chat('phone', 'phone'),
      { ...chat('mail'), origin: { kind: 'mail' } },
      { ...chat('task'), origin: { kind: 'background' } },
      { threadId: 'unknown', turnId: 'unknown' }]);
    expect(state.turns).toEqual([chat()]);
    state.disconnect();
    state.reconcile('mac', [chat()]);
    expect(state.turns).toEqual([chat()]);
  });

  it('keeps pending submissions eligible if a snapshot arrives before the server starts them', () => {
    const state = connected();
    state.submit({ input: 'hello', turnId: 'turn-1' });
    state.disconnect();
    state.reconcile('mac', []);
    expect(state.event('item/started', params())).toBe(true);
  });

  it('retires an accepted silent turn missing from the reconnect snapshot', () => {
    const state = connected();
    state.submit({ input: 'hello', turnId: 'turn-1' });
    state.accepted('turn-1');
    state.disconnect();
    state.reconcile('mac', []);
    expect(state.event('item/started', { threadId: 'chat', turnId: 'turn-1' })).toBe(false);
  });

  it('scopes worker exits and ignores idle-worker retirement', () => {
    const state = connected();
    state.event('item/started', params('one'));
    state.event('item/started', params('two', 'mac', 'second-chat'));
    expect(state.event('process/exit', { threadId: null })).toBe(false);
    expect(state.event('process/exit', { threadId: 'chat', turnId: 'old' })).toBe(false);
    state.event('process/exit', { threadId: 'chat', turnId: 'one' });
    expect(state.turns.map(t => t.turnId)).toEqual(['two']);
    state.event('process/exit', {});
    expect(state.turns).toEqual([]);
  });

  it('cleans up handled and rejected starts', () => {
    const state = connected();
    state.submit({ input: 'hello', turnId: 'turn-1' });
    state.event('item/started', params());
    state.abandon('turn-1');
    expect(state.event('item/started', params())).toBe(false);
    expect(state.turns).toEqual([]);
  });
});
