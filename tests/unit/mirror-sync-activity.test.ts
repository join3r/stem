import { afterEach, describe, expect, it } from 'vitest';
import { resetActivity, snapshot } from '../../src/server/activity';
import { mirrorSyncApplied, mirrorSyncEnded, mirrorSyncPlanned } from '../../src/server/mirror/sync-activity';

// The activity-indicator face of a mirror sync (server/mirror/sync-activity.ts):
// opened by a diff that names work, advanced by apply batches, closed by the
// round's report. The registry itself is tested in activity.test.ts; this pins
// the mirror-specific choreography on top of it.

describe('mirror sync activity', () => {
  afterEach(() => {
    // Close anything a test left open before wiping the registry, so no stall
    // timer from one test can touch another's entries.
    for (const id of ['f1', 'f2']) mirrorSyncEnded(id);
    resetActivity();
  });

  it('a round shows up as one running row with file progress, then one history row', () => {
    mirrorSyncPlanned('f1', 'cloudfarms', 1000);
    let running = snapshot().running;
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      kind: 'mirror.sync',
      label: 'Syncing cloudfarms',
      progress: { done: 0, total: 1000 }
    });

    mirrorSyncApplied('f1', 400);
    mirrorSyncApplied('f1', 400);
    running = snapshot().running;
    expect(running[0]!.progress).toEqual({ done: 800, total: 1000 });

    mirrorSyncEnded('f1');
    const snap = snapshot();
    expect(snap.running).toHaveLength(0);
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0]).toMatchObject({ state: 'done', detail: '800 files' });
  });

  it('a quiet diff opens nothing, and closes what a dead round left behind', () => {
    mirrorSyncPlanned('f1', 'cloudfarms', 0);
    expect(snapshot().running).toHaveLength(0);

    mirrorSyncPlanned('f1', 'cloudfarms', 10);
    mirrorSyncApplied('f1', 10);
    // The round died before its report; the next (clean) diff closes the row.
    mirrorSyncPlanned('f1', 'cloudfarms', 0);
    const snap = snapshot();
    expect(snap.running).toHaveLength(0);
    expect(snap.history[0]).toMatchObject({ state: 'done', detail: '10 files' });
  });

  it('a re-diff mid-round retargets the total instead of stacking a second row', () => {
    mirrorSyncPlanned('f1', 'cloudfarms', 1000);
    mirrorSyncApplied('f1', 400);
    // Client restarted mid-round: it re-diffs and 600 files remain.
    mirrorSyncPlanned('f1', 'cloudfarms', 600);
    const running = snapshot().running;
    expect(running).toHaveLength(1);
    expect(running[0]!.progress).toEqual({ done: 400, total: 1000 });
  });

  it('two folders syncing at once are two rows, not one shared entry', () => {
    mirrorSyncPlanned('f1', 'notes', 10);
    mirrorSyncPlanned('f2', 'photos', 20);
    expect(snapshot().running).toHaveLength(2);
    mirrorSyncEnded('f1');
    const snap = snapshot();
    expect(snap.running).toHaveLength(1);
    expect(snap.running[0]!.label).toBe('Syncing photos');
  });

  it('a round that moved nothing earns no history row', () => {
    mirrorSyncPlanned('f1', 'cloudfarms', 5);
    mirrorSyncEnded('f1'); // report arrived, but no apply ever landed
    const snap = snapshot();
    expect(snap.running).toHaveLength(0);
    expect(snap.history).toHaveLength(0);
  });
});
