// Wall-clock budgets for a real turn, against the real backend.
//
// Opt-in (STEM_PERF=1, implies real pi + real network + real quota) because it is
// the one layer here that cannot be hermetic — it exists to catch the class of
// regression that only shows up against a live provider. The deterministic
// guards live in tests/unit/web-search-latency.test.ts; this is the backstop that
// notices when the shape is right and the clock still says otherwise.
//
// It asserts on the app's OWN accounting — the turn_timings rows the runtime
// already writes — rather than on Playwright's stopwatch, so a failure points at
// a phase (build / tool / answer) instead of at "the test was slow". Medians over
// N runs; a single slow sample never fails the build.
//
// Budgets live in tests/perf/budgets.json and are deliberately loose: they are
// there to catch a 3x, not to police a 10% drift. The 2026-07-28 web-search
// regression (median search turn 39.6s -> 99.8s, tool time ~10x) fails them.
//
//   npm run test:perf                    # assert
//   STEM_PERF_UPDATE=1 npm run test:perf # refresh the `measured` notes instead
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { test, expect, launchApp, mainWindowOf, removeUserData } from './electron';

const PERF = !!process.env.STEM_PERF;
const UPDATE = !!process.env.STEM_PERF_UPDATE;
const BUDGETS_PATH = fileURLToPath(new URL('../perf/budgets.json', import.meta.url));

interface Budgets {
  iterations: number;
  cases: Record<
    string,
    { prompt: string; expect: string; requireTools?: boolean; budgetMs: Record<string, number> }
  >;
  measured: Record<string, unknown>;
}

interface Timing {
  total_ms: number | null;
  thinking_ms: number;
  tool_ms: number;
  answer_ms: number;
  ttft_ms: number | null;
}

const budgets = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8')) as Budgets;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Read-only peek into the running app's isolated recall DB. */
function query<T>(recallDb: string, sql: string): T[] {
  const db = new DatabaseSync(recallDb, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown as T[];
  } catch {
    // The table only exists once the app has written its first turn.
    return [];
  } finally {
    db.close();
  }
}

function countTimings(recallDb: string): number {
  const rows = query<{ n: number }>(recallDb, 'SELECT COUNT(*) AS n FROM turn_timings');
  return rows[0]?.n ?? 0;
}

/**
 * Where the last turn's tool time actually went, per tool call. `toolMs` alone
 * cannot tell "one slow backend" from "the model called the tool three times" —
 * and those two need completely different fixes.
 */
function lastToolBreakdown(recallDb: string): string[] {
  const rows = query<{ payload: string }>(
    recallDb,
    'SELECT payload FROM turn_activities ORDER BY created_at DESC, rowid DESC LIMIT 1'
  );
  if (!rows[0]) return [];
  try {
    const payload = JSON.parse(rows[0].payload) as { activity?: { name?: string; type: string; ms?: number }[] };
    return (payload.activity ?? []).map((a) => `${a.name ?? a.type}=${a.ms ?? '?'}ms`);
  } catch {
    return [];
  }
}

/** The turn the app just finished, as the app itself accounted for it. */
function lastTiming(recallDb: string): Timing | null {
  return (
    query<Timing>(
      recallDb,
      'SELECT total_ms, thinking_ms, tool_ms, answer_ms, ttft_ms FROM turn_timings ORDER BY created_at DESC, rowid DESC LIMIT 1'
    )[0] ?? null
  );
}

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

test.describe('turn latency budgets', () => {
  test.skip(!PERF, 'set STEM_PERF=1 (real backend, real quota) to run the perf budgets');

  for (const [name, spec] of Object.entries(budgets.cases)) {
    test(`${name} turns stay inside budget`, async () => {
      // Every iteration is a full real turn plus a cold pi spawn on the first.
      test.setTimeout(60_000 + budgets.iterations * 180_000);

      // Past onboarding, and no "What's new" popup — a modal over the composer
      // would be measured as latency.
      const launched = await launchApp({
        real: true,
        seedSettings: {
          onboarding: { completed: true },
          releaseNotes: { showOnUpdate: false, lastSeenVersion: null }
        }
      });
      const recallDb = join(launched.userDataDir, 'recall.sqlite');
      const samples: Timing[] = [];
      try {
        const win = await mainWindowOf(launched.app);
        await win.waitForLoadState('domcontentloaded');

        for (let i = 0; i < budgets.iterations; i++) {
          // A fresh chat each time: a growing thread means a growing prompt,
          // which would make later iterations slower for the wrong reason.
          if (i > 0) await win.getByTitle('New conversation').click();
          await send(win, spec.prompt);
          // Wait on the timing row, NOT on the reply text: the row is written when
          // the turn settles, whereas a text match resolves on the first streamed
          // token and would leave the rest of the turn unwaited-for.
          await expect
            .poll(() => countTimings(recallDb), { timeout: 200_000, intervals: [1000] })
            .toBe(i + 1);
          const reply = win.locator('.message-assistant:not(.activity-row) .message-body').last();
          await expect(reply).toContainText(new RegExp(spec.expect, 'i'));
          const timing = lastTiming(recallDb);
          if (timing) samples.push(timing);
          const tools = lastToolBreakdown(recallDb);
          if (tools.length) console.log(`[perf] ${name} run ${i + 1} tools: ${tools.join(' ')}`);
        }
      } finally {
        await launched.app.close().catch(() => {});
        removeUserData(launched.userDataDir);
      }

      const medians: Record<string, number> = {
        totalMs: median(samples.map((s) => s.total_ms ?? 0)),
        toolMs: median(samples.map((s) => s.tool_ms)),
        thinkingMs: median(samples.map((s) => s.thinking_ms)),
        answerMs: median(samples.map((s) => s.answer_ms)),
        ttftMs: median(samples.map((s) => s.ttft_ms ?? 0))
      };
      // Printed whether it passes or fails — the number is the point.
      console.log(`[perf] ${name} n=${samples.length}`, medians);

      if (UPDATE) {
        const next = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8')) as Budgets;
        next.measured = { ...next.measured, [name]: medians };
        writeFileSync(BUDGETS_PATH, JSON.stringify(next, null, 2) + '\n');
        return;
      }

      // A search turn where the model never searched measures nothing.
      if (spec.requireTools) {
        expect(medians.toolMs, `${name} recorded no tool time — did the model actually search?`).toBeGreaterThan(0);
      }

      for (const [metric, budget] of Object.entries(spec.budgetMs)) {
        expect(
          medians[metric],
          `${name}.${metric} median ${medians[metric]}ms over budget ${budget}ms — either the path got slower or the budget is wrong. Decide which, in the commit message.`
        ).toBeLessThanOrEqual(budget);
      }
    });
  }
});
