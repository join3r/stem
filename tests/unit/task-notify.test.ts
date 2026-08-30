// How a scheduled run's notify_user reaches the user — the one thing the
// settings.tasks.notify mode changes. The scheduler itself is exercised in
// scheduler.test.ts; what matters here is the bridge wired in startup/scheduler.ts:
// which of reveal / attention / the alert push each mode fires, and that all three
// still mark the run as having found something (the Inbox's only signal).
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const STORE = join(tmpdir(), `stem-tasks-notify-${process.pid}.json`);
process.env.STEM_TASKS_STORE = STORE;

import type { ChatBackend } from '../../src/server/backend';
import type { TaskBridge } from '../../src/server/backend/types';
import { initTaskScheduler } from '../../src/server/startup/scheduler';
import { settingsStorePath } from '../../src/server/workspace/paths';
import { updateTasksSettings } from '../../src/server/workspace/settings';
import type { TaskNotifyMode } from '../../src/shared/types';

/** Enough of a backend to hand the bridge over and answer the thread lookup. */
class FakeRuntime extends EventEmitter {
  bridge: TaskBridge | null = null;
  setTaskBridge(bridge: TaskBridge | null) {
    this.bridge = bridge;
  }
  async listThreads() {
    return [];
  }
}

/** Wire the real bridge over fake pushes and return what each mode did. */
async function notifyUnder(mode: TaskNotifyMode) {
  await updateTasksSettings({ notify: mode });
  const runtime = new FakeRuntime();
  const emitted: string[] = [];
  let revealed = 0;
  let attention = 0;
  const mails: { subject: string; body: string; taskId: string }[] = [];
  const scheduler = initTaskScheduler({
    runtime: runtime as unknown as ChatBackend,
    emit: (channel) => emitted.push(channel),
    isUserActive: () => false,
    revealMainWindow: () => revealed++,
    requestAttention: () => attention++,
    deliverTaskMail: async (input) => {
      mails.push(input);
    }
  });
  await runtime.bridge!.notify({ title: 'Build', message: 'main went red' }, 't1');
  scheduler.stop();
  return { revealed, attention, alerts: emitted.filter((c) => c === 'tasks:notify').length, mails };
}

beforeEach(() => {
  mkdirSync(dirname(settingsStorePath()), { recursive: true });
  rmSync(settingsStorePath(), { force: true });
  rmSync(STORE, { force: true });
});
afterEach(() => {
  rmSync(settingsStorePath(), { force: true });
  rmSync(STORE, { force: true });
});

describe('notify_user prominence', () => {
  it('alert (the default) raises the window, nudges the OS and pushes the modal', async () => {
    expect(await notifyUnder('alert')).toEqual({ revealed: 1, attention: 1, alerts: 1, mails: [] });
  });

  it('nudge bounces the dock without stealing focus or popping the modal', async () => {
    expect(await notifyUnder('nudge')).toEqual({ revealed: 0, attention: 1, alerts: 0, mails: [] });
  });

  it('inbox interrupts in no way at all', async () => {
    expect(await notifyUnder('inbox')).toEqual({ revealed: 0, attention: 0, alerts: 0, mails: [] });
  });

  it('reads the mode per notification, so a change applies to the very next run', async () => {
    // The bridge is wired once at startup and a task fires hours later; caching
    // the mode there would leave the toggle waiting for a restart.
    const runtime = new FakeRuntime();
    let revealed = 0;
    const scheduler = initTaskScheduler({
      runtime: runtime as unknown as ChatBackend,
      emit: () => undefined,
      isUserActive: () => false,
      revealMainWindow: () => revealed++,
      requestAttention: () => undefined,
      deliverTaskMail: async () => undefined
    });
    await runtime.bridge!.notify({ message: 'first' }, 't1');
    expect(revealed).toBe(1);
    await updateTasksSettings({ notify: 'inbox' });
    await runtime.bridge!.notify({ message: 'second' }, 't1');
    expect(revealed).toBe(1);
    scheduler.stop();
  });
});
