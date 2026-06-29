// Scheduled-tasks subsystem, end-to-end through the real store → IPC → preload →
// renderer path. Hermetic: the backend is faked (STEM_E2E), so no turns are
// dispatched — we seed only NON-DUE tasks and exercise the wiring the flood fix
// touched: the tasks load, the Tasks tab renders them, and pause/delete persist
// through real IPC. The flood's exact timing is guarded deterministically by the
// unit test (tests/unit/scheduler.test.ts); this proves the surrounding plumbing.
import { expect, launchApp, mainWindowOf, type LaunchedApp } from './electron';
import { test } from '@playwright/test';
import { rmSync } from 'node:fs';
import type { ScheduledTask } from '../../src/shared/types';

// A far-future daily cron never becomes due during the test, so the scheduler
// loads + arms it without ever dispatching a (faked, would-fail) turn.
function seedTask(id: string, prompt: string): ScheduledTask {
  return {
    id,
    threadId: `thread-${id}`,
    prompt,
    schedule: { kind: 'cron', expr: '0 8 * * *' },
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00').toISOString(),
    title: prompt,
    nextRunAt: new Date('2030-01-01T08:00:00').toISOString()
  };
}

let launched: LaunchedApp | null = null;

async function boot(seedTasks: ScheduledTask[]) {
  launched = await launchApp({ seedTasks, real: false });
  const win = await mainWindowOf(launched.app);
  await win.waitForLoadState('domcontentloaded');
  // The scheduler starts asynchronously on did-finish-load. Wait until it has
  // loaded the seeded tasks into the in-memory snapshot BEFORE opening the Tasks
  // tab — otherwise TasksTab's mount-time listTasks() races start() and renders
  // the empty state (the live tasks:changed push only updates an already-mounted
  // tab). Polling listTasks here makes the test deterministic.
  await expect
    .poll(() => win.evaluate(() => (window as any).stem.listTasks().then((t: unknown[]) => t.length)))
    .toBe(seedTasks.length);
  await win.getByRole('button', { name: 'Tasks' }).click();
  return win;
}

test.afterEach(() => {
  if (launched) {
    rmSync(launched.userDataDir, { recursive: true, force: true });
    launched = null;
  }
});

// Closing happens after cleanup registration so a failed assertion still tears down.
test.afterEach(async () => {
  await launched?.app.close().catch(() => {});
});

test('Tasks tab renders seeded scheduled tasks', async () => {
  const win = await boot([seedTask('a', 'Summarize my unread email'), seedTask('b', 'Check the release page')]);

  // The "Scheduled tasks" group head (exact, to avoid matching the empty-state copy).
  await expect(win.getByText('Scheduled tasks', { exact: true })).toBeVisible();
  await expect(win.getByText('Summarize my unread email')).toBeVisible();
  await expect(win.getByText('Check the release page')).toBeVisible();
});

test('pausing a task persists enabled=false and clears the next run through real IPC', async () => {
  const win = await boot([seedTask('a', 'Summarize my unread email')]);
  await expect(win.getByText('Summarize my unread email')).toBeVisible();

  await win.getByRole('button', { name: 'Pause' }).click();
  // The row flips to a Resume affordance and shows the paused state.
  await expect(win.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(win.getByText('Paused')).toBeVisible();

  // Confirm it round-tripped to the scheduler/store, not just the UI: a paused task
  // has enabled=false and nextRunAt cleared (so it can never be detected as due).
  const task = await win.evaluate(() => (window as any).stem.listTasks().then((t: any[]) => t[0]));
  expect(task.enabled).toBe(false);
  expect(task.nextRunAt).toBeNull();
});

test('deleting a task removes it from the store, leaving the others', async () => {
  const win = await boot([seedTask('a', 'Summarize my unread email'), seedTask('b', 'Check the release page')]);
  await expect(win.getByText('Summarize my unread email')).toBeVisible();

  // Two tasks → two Delete buttons; remove the first.
  await win.getByRole('button', { name: 'Delete task' }).first().click();

  await expect(win.getByText('Summarize my unread email')).toBeHidden();
  await expect(win.getByText('Check the release page')).toBeVisible();
  const remaining = await win.evaluate(() => (window as any).stem.listTasks().then((t: any[]) => t.map((x) => x.title)));
  expect(remaining).toEqual(['Check the release page']);
});
