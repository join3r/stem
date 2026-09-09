import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBackend } from '../../src/server/backend/types';
import type { MailWorkGroup, StartTurnInput } from '../../src/shared/types';
import { TaskScheduler } from '../../src/server/scheduler';
import { attachScheduledWork, readRecordedWork } from '../../src/server/mail/work';
import { readTasks } from '../../src/server/workspace/tasks';

let directory: string;
let scheduler: TaskScheduler | undefined;
let runtime: ScheduledRuntime | undefined;

class ScheduledRuntime extends EventEmitter {
  started: StartTurnInput | undefined;
  beforeStart: MailWorkGroup[] = [];

  async listThreads() {
    return [{ threadId: 'scheduled-thread', title: 'Fictional news', folderId: null, createdAt: 0, updatedAt: 0 }];
  }

  event(method: string, extra: Record<string, unknown> = {}) {
    this.emit('event', { method, params: { threadId: 'scheduled-thread', turnId: this.started?.turnId, ...extra } });
  }

  async startTurn(input: StartTurnInput) {
    this.started = input;
    // The scheduler must persist and subscribe before calling the backend: work
    // emitted inside startTurn must survive even before startTurn resolves.
    this.beforeStart = await readRecordedWork('');
    this.event('item/agentMessage/delta', { delta: 'Checking sources.' });
    this.event('mail/work/activity', { activity: {
      id: 'search', kind: 'tool', label: 'Search sources', at: 1, status: 'running', input: 'Fictional product news'
    } });
    this.event('mail/work/activity', { activity: {
      id: 'search', kind: 'tool', label: 'Search sources', at: 1, endedAt: 2, status: 'ok', output: 'Found a release'
    } });
    scheduler?.noteNotify('scheduled-thread');
    await attachScheduledWork('scheduled-thread', 'scheduled-conversation', 'notification-one', 'normal');
    this.event('mail/work/activity', { activity: {
      id: 'verify', kind: 'tool', label: 'Verify release', at: 3, status: 'running', input: 'Open release notes'
    } });
    this.event('mail/work/activity', { activity: {
      id: 'verify', kind: 'tool', label: 'Verify release', at: 3, endedAt: 4, status: 'ok', output: 'Release confirmed'
    } });
    this.event('item/agentMessage/delta', { delta: 'Sources checked; follow-up ready.' });
    return { threadId: 'scheduled-thread', turnId: input.turnId! };
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stem-work-scheduler-'));
  vi.stubEnv('STEM_TASKS_STORE', join(directory, 'tasks.json'));
  vi.stubEnv('STEM_MAIL_WORK_DIR', join(directory, 'work'));
});

afterEach(async () => {
  scheduler?.stop();
  if (scheduler?.runningTask('scheduled-thread')) {
    runtime?.event('turn/failed', { error: 'Test cleanup' });
    await vi.waitFor(() => expect(scheduler?.runningTask('scheduled-thread')).toBeNull());
  }
  await readRecordedWork('scheduled-conversation');
  runtime?.removeAllListeners();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  scheduler = undefined;
  runtime = undefined;
});

describe('scheduled mail work integration', () => {
  it.each(['ok', 'failed'] as const)('retains activity before and after notification when a scheduled run ends %s', async (status) => {
    runtime = new ScheduledRuntime();
    const silent = vi.fn();
    const result = vi.fn(async () => {});
    scheduler = new TaskScheduler({
      runtime: runtime as unknown as ChatBackend,
      onChange: () => {}, onRun: () => {}, onSilentRun: silent, onResult: result
    });
    const created = await scheduler.create({ prompt: 'Check fictional product news', cron: '0 8 * * *' }, 'scheduled-thread');
    if (!created.ok) throw new Error(created.error);
    scheduler.runNow(created.task.id);
    await vi.waitFor(() => {
      // Both the recorder and scheduler's settle listener must be attached.
      expect(runtime?.listenerCount('event')).toBe(2);
    });
    const turnId = runtime.started?.turnId;
    expect(turnId).toBeTruthy();
    expect(runtime.beforeStart).toHaveLength(1);
    expect(runtime.beforeStart[0].runs[0]).toMatchObject({ id: turnId, status: 'running', activities: [] });
    const [active] = await readRecordedWork('scheduled-conversation');
    expect(active).toMatchObject({ id: turnId, notificationItemId: 'notification-one', conversationId: 'scheduled-conversation' });
    expect(active.runs).toHaveLength(1);
    expect(active.runs[0]).toMatchObject({ status: 'running', personaId: 'normal', turnId });
    expect(active.runs[0].activities.filter((row) => row.kind === 'tool').map((row) => row.id)).toEqual(['search', 'verify']);
    expect(await readRecordedWork('')).toEqual([]);

    runtime.event(status === 'ok' ? 'turn/completed' : 'turn/failed', status === 'failed' ? { error: 'Connection lost after verification' } : {});
    await vi.waitFor(async () => expect((await readTasks())[0]?.lastStatus).toBe(status));
    expect(scheduler.runningTask('scheduled-thread')).toBeNull();
    const groups = await readRecordedWork('scheduled-conversation');
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(active.id);
    const run = groups[0].runs[0];
    expect(run.status).toBe(status);
    expect(run.endedAt).toBeGreaterThanOrEqual(run.startedAt);
    expect(run.activities.filter((row) => row.kind === 'tool')).toMatchObject([
      { id: 'search', input: 'Fictional product news', output: 'Found a release', status: 'ok' },
      { id: 'verify', input: 'Open release notes', output: 'Release confirmed', status: 'ok' }
    ]);
    expect(run.activities.filter((row) => row.kind === 'progress').map((row) => row.output)).toEqual(
      status === 'ok' ? ['Checking sources.'] : ['Checking sources.', 'Sources checked; follow-up ready.']
    );
    if (status === 'failed') expect(run.error).toBe('Connection lost after verification');
    expect(runtime.listenerCount('event')).toBe(0);
    expect(silent).not.toHaveBeenCalled();
    // The final text block is the run's reply: it joins the mail the notify
    // opened — but only for a clean settle. A failed run's partial text stays
    // in Work as progress, never dressed up as the result.
    if (status === 'ok') {
      expect(result).toHaveBeenCalledWith({
        taskId: created.task.id, threadId: 'scheduled-thread', itemId: 'notification-one', result: 'Sources checked; follow-up ready.'
      });
    } else expect(result).not.toHaveBeenCalled();
  });
});
