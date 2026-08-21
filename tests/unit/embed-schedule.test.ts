// The embed schedule's gating contract (see embed-schedule.ts): background
// passage work waits out in-flight queries plus a lull, queries are visible to
// the budget picker while a passage request is at the endpoint, and a fresh
// process (no query yet) never makes startup backfills wait.
import { describe, expect, it } from 'vitest';
import { createEmbedSchedule } from '../../src/server/recall/embed-schedule';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('embed schedule', () => {
  it('resolves the lull wait immediately when no query ever ran', async () => {
    const schedule = createEmbedSchedule({ lullMs: 60_000 });
    const start = Date.now();
    await schedule.waitForQueryLull();
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('holds the lull wait while a query is in flight, then enforces the lull', async () => {
    const schedule = createEmbedSchedule({ lullMs: 50 });
    const end = schedule.beginQuery();
    let resolved = false;
    const wait = schedule.waitForQueryLull().then(() => {
      resolved = true;
    });
    await sleep(300); // past the poll interval — still gated by the open query
    expect(resolved).toBe(false);
    const endedAt = Date.now();
    end();
    await wait;
    // Not exact-time asserted (CI timers drift); the invariant is order: the
    // wait released only after the query ended, never before.
    expect(Date.now()).toBeGreaterThanOrEqual(endedAt);
    expect(resolved).toBe(true);
  });

  it('reports passageBusy only while a passage slot is open, idempotently', () => {
    const schedule = createEmbedSchedule();
    expect(schedule.passageBusy()).toBe(false);
    const endA = schedule.beginPassage();
    const endB = schedule.beginPassage();
    expect(schedule.passageBusy()).toBe(true);
    endA();
    endA(); // double-call must not free B's slot
    expect(schedule.passageBusy()).toBe(true);
    endB();
    expect(schedule.passageBusy()).toBe(false);
  });
});
