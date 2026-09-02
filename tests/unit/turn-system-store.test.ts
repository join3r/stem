// turn_system: the per-turn system-version stamp in recall.sqlite, keyed like
// turn_timings by the final assistant entry id so readThread can hang it on the
// rebuilt assistant bubble.
import { describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/server/recall/store';

describe('turn_system', () => {
  it('round-trips a stamp per entry, replaces on conflict, and keeps build optional', () => {
    const sys = { persona: 'aaaaaaaaaaaa', skills: 'bbbbbbbbbbbb', memory: 'cccccccccccc', build: 'deadbeef' };
    store.upsertTurnSystem({ turnEntryId: 'e1', threadId: 't1', sys });
    store.upsertTurnSystem({ turnEntryId: 'e2', threadId: 't1', sys: { ...sys, build: undefined } });
    store.upsertTurnSystem({ turnEntryId: 'e3', threadId: 'other', sys });

    const byEntry = store.getTurnSystemsByThread('t1');
    expect(byEntry.get('e1')).toEqual(sys);
    expect(byEntry.get('e2')).toEqual({ persona: sys.persona, skills: sys.skills, memory: sys.memory });
    expect(byEntry.has('e3')).toBe(false);

    store.upsertTurnSystem({ turnEntryId: 'e1', threadId: 't1', sys: { ...sys, persona: 'dddddddddddd' } });
    expect(store.getTurnSystemsByThread('t1').get('e1')?.persona).toBe('dddddddddddd');
    expect(store.getTurnSystemsByThread('nothing').size).toBe(0);
  });
});
