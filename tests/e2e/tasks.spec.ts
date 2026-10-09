// Scheduled-tasks subsystem, end-to-end through the real store → IPC → preload →
// renderer path. Hermetic: the backend is faked (STEM_E2E), so no turns are
// dispatched — we seed only NON-DUE tasks and exercise the wiring the flood fix
// touched: the tasks load, the Tasks tab renders them, and pause/delete persist
// through real IPC. The flood's exact timing is guarded deterministically by the
// unit test (tests/unit/scheduler.test.ts); this proves the surrounding plumbing.
import { expect, launchApp, mainWindowOf, removeUserData, type LaunchedApp } from './electron';
import { test } from '@playwright/test';
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
    runsAs: { kind: 'default' },
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
    removeUserData(launched.userDataDir);
    launched = null;
  }
});

// Closing happens after cleanup registration so a failed assertion still tears down.
test.afterEach(async () => {
  await launched?.app.close().catch(() => {});
});

test('Tasks tab renders seeded scheduled tasks', async () => {
  const win = await boot([seedTask('a', 'Summarize my unread email'), seedTask('b', 'Check the release page')]);

  // The "Scheduled tasks" group head (scoped to the panel body — the Tasks tab's
  // tooltip in the icon rail carries the same text).
  await expect(win.locator('.manage-body').getByText('Scheduled tasks', { exact: true })).toBeVisible();
  await expect(win.getByText('Summarize my unread email')).toBeVisible();
  await expect(win.getByText('Check the release page')).toBeVisible();
  // Each row shows its schedule in words and who/what its runs execute as — unpinned, the app default.
  await expect(win.getByText('Daily at 08:00 · App default').first()).toBeVisible();
});

test('pausing a task persists enabled=false and clears the next run through real IPC', async () => {
  const win = await boot([seedTask('a', 'Summarize my unread email')]);
  await expect(win.getByText('Summarize my unread email')).toBeVisible();

  // Pausing is the editor header's switch, and it acts at once (not on Save).
  await win.getByText('Summarize my unread email').click();
  const active = win.getByRole('switch', { name: 'Active' });
  await expect(active).toBeChecked();
  await active.click();
  await expect(active).not.toBeChecked();
  await expect(win.locator('.ld-ident').getByText('Paused')).toBeVisible();

  // Confirm it round-tripped to the scheduler/store, not just the UI: a paused task
  // has enabled=false and nextRunAt cleared (so it can never be detected as due).
  const task = await win.evaluate(() => (window as any).stem.listTasks().then((t: any[]) => t[0]));
  expect(task.enabled).toBe(false);
  expect(task.nextRunAt).toBeNull();
});

// A one-time task armed in the past: the scheduler runs it once on start() (the
// catch-up path) and, now that it has fired, removes it from the list entirely —
// so it stops showing in the Tasks tab and clears the owning chat's scheduled
// badge (which is derived from the task list). The hermetic E2E backend settles
// the catch-up turn instantly (see src/server/scheduler/e2e-backend.ts).
function seedDueOnce(id: string, prompt: string): ScheduledTask {
  const past = new Date('2020-01-01T00:00:00').toISOString();
  return {
    id,
    threadId: `thread-${id}`,
    prompt,
    schedule: { kind: 'once', at: past },
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00').toISOString(),
    title: prompt,
    runsAs: { kind: 'default' },
    nextRunAt: past
  };
}

test('a fired one-time task removes itself, leaving the recurring task', async () => {
  // Seed a due once-task alongside a far-future recurring one. boot()'s
  // poll-to-length doesn't fit here (the once-task self-removes), so launch directly.
  launched = await launchApp({
    seedTasks: [seedDueOnce('once', 'One-time ping'), seedTask('keep', 'Daily standup')],
    real: false
  });
  const win = await mainWindowOf(launched.app);
  await win.waitForLoadState('domcontentloaded');

  // The once-task fires on start() and drops out; only the recurring task remains.
  await expect
    .poll(() => win.evaluate(() => (window as any).stem.listTasks().then((t: any[]) => t.map((x) => x.id))))
    .toEqual(['keep']);

  await win.getByRole('button', { name: 'Tasks' }).click();
  await expect(win.getByText('Daily standup')).toBeVisible();
  await expect(win.getByText('One-time ping')).toBeHidden();
});

test('deleting a task removes it from the store, leaving the others', async () => {
  const win = await boot([seedTask('a', 'Summarize my unread email'), seedTask('b', 'Check the release page')]);
  await expect(win.getByText('Summarize my unread email')).toBeVisible();

  // Delete lives in the task's editor and asks once, in place.
  await win.getByText('Summarize my unread email').click();
  await win.getByRole('button', { name: 'Delete task' }).click();
  await win.getByRole('button', { name: 'Delete task?' }).click();

  // Back on the list (the editor's prompt box would also match the text).
  await expect(win.locator('.ld-detail')).toHaveCount(0);
  await expect(win.getByText('Summarize my unread email')).toBeHidden();
  await expect(win.getByText('Check the release page')).toBeVisible();
  const remaining = await win.evaluate(() => (window as any).stem.listTasks().then((t: any[]) => t.map((x) => x.title)));
  expect(remaining).toEqual(['Check the release page']);
});

test('a schedule edit reads back in words and is written only on Save', async () => {
  const win = await boot([seedTask('a', 'Summarize my unread email')]);
  await win.getByText('Summarize my unread email').click();
  await win.getByRole('tab', { name: 'Schedule' }).click();
  await win.getByLabel('Cron schedule').fill('0 9 * * 1-5');
  await expect(win.getByText('Weekdays at 09:00, in the Stem server’s time.')).toBeVisible();
  const expr = () => win.evaluate(() => (window as any).stem.listTasks().then((t: any[]) => t[0].schedule.expr));
  expect(await expr()).toBe('0 8 * * *');
  await win.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(expr).toBe('0 9 * * 1-5');
});
