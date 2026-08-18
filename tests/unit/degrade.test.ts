import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { degradations, degradationCounts, degrade, resetDegradations } from '../../src/server/degrade';
import { logFlushed } from '../../src/server/log';
import { resetActivity, snapshot } from '../../src/server/activity';
import { logFilePath } from '../../src/server/workspace/paths';

describe('degrade()', () => {
  beforeEach(() => {
    resetDegradations();
    resetActivity();
  });

  it('records what the app did instead, and writes it to the log', async () => {
    degrade('recall.search', 'returned no episodic hits', new Error('no such column: turn_id'));
    await logFlushed();

    expect(degradations()).toEqual([
      {
        scope: 'recall.search',
        what: 'returned no episodic hits',
        error: 'no such column: turn_id',
        at: expect.any(Number)
      }
    ]);
    const text = await readFile(logFilePath(), 'utf8');
    expect(text).toContain('[recall.search] degraded: returned no episodic hits');
    expect(text).toContain('no such column: turn_id');
  });

  it('counts repeats per scope, so a log can show a pattern rather than one line', () => {
    degrade('recall.search', 'no hits', new Error('a'));
    degrade('recall.search', 'no hits', new Error('b'));
    degrade('skills.load', 'skipped one skill', new Error('c'));

    expect(degradationCounts()).toEqual({ 'recall.search': 2, 'skills.load': 1 });
  });

  it('raises the activity failure marker only when asked to', () => {
    degrade('recall.cache', 'recomputed instead of reusing', new Error('stale'));
    expect(snapshot().unseenFailure).toBe(false);

    degrade('memory.distill', 'learned nothing from this turn', new Error('backend down'), {
      activity: 'memory.distill'
    });
    const after = snapshot();
    expect(after.unseenFailure).toBe(true);
    expect(after.history[0]).toMatchObject({
      kind: 'memory.distill',
      state: 'failed',
      error: 'backend down',
      label: 'learned nothing from this turn'
    });
  });

  it('survives anything thrown at it — the caller already failed once', () => {
    const hostile = {
      toString() {
        throw new Error('this error object cannot be described');
      }
    };
    expect(() => degrade('odd', 'carried on', hostile)).not.toThrow();
    expect(() => degrade('odd', 'carried on', undefined)).not.toThrow();
    expect(degradations().at(-1)).toMatchObject({ error: 'no error given' });
  });

  it('keeps the ledger bounded so a failing loop cannot grow it without end', () => {
    for (let i = 0; i < 250; i++) degrade('loop', `attempt ${i}`, new Error('nope'));

    const all = degradations();
    expect(all).toHaveLength(100);
    // Oldest dropped, newest kept: a support log should show the recent shape.
    expect(all[0].what).toBe('attempt 150');
    expect(all.at(-1)?.what).toBe('attempt 249');
    expect(degradationCounts().loop).toBe(250);
  });
});
