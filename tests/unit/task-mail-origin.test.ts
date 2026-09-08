// schedule_task called from a mail persona's hidden session. The bridge wired in
// startup/scheduler.ts must not bind the task to that session — the Chats list
// hides it and the Inbox shows only mail, so every run would land where nobody
// can see it. It adopts a fresh chat named after the task instead, remembers the
// origin so list_tasks from the mail conversation still finds it, and at boot
// moves any task that was left on a hidden session before this existed.
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const STORE = join(tmpdir(), `stem-tasks-origin-${process.pid}.json`);
process.env.STEM_TASKS_STORE = STORE;

import type { ChatBackend } from '../../src/server/backend';
import type { TaskBridge } from '../../src/server/backend/types';
import { initTaskScheduler } from '../../src/server/startup/scheduler';
import { createConversation, setConversationSession } from '../../src/server/workspace/mail';
import { mailStorePath } from '../../src/server/workspace/paths';
import { readTasks, saveTasks } from '../../src/server/workspace/tasks';

class FakeRuntime extends EventEmitter {
  bridge: TaskBridge | null = null;
  created: string[] = [];
  names = new Map<string, string>();
  setTaskBridge(bridge: TaskBridge | null) {
    this.bridge = bridge;
  }
  async listThreads() {
    return [];
  }
  async createThread() {
    const id = `chat-${this.created.length + 1}`;
    this.created.push(id);
    return id;
  }
  async renameThread(threadId: string, name: string) {
    this.names.set(threadId, name);
  }
}

function wire(runtime: FakeRuntime) {
  return initTaskScheduler({
    runtime: runtime as unknown as ChatBackend,
    emit: () => {},
    isUserActive: () => false,
    revealMainWindow: () => {},
    requestAttention: () => {},
    deliverTaskMail: async () => {}
  });
}

const mailPath = mailStorePath();
beforeEach(() => {
  mkdirSync(dirname(mailPath), { recursive: true });
  rmSync(mailPath, { force: true });
  rmSync(STORE, { force: true });
});
afterEach(() => {
  rmSync(mailPath, { force: true });
  rmSync(STORE, { force: true });
});

describe('schedule_task from a mail session', () => {
  it('adopts a fresh chat named after the task and keeps the mail session as the origin', async () => {
    const conversation = await createConversation('Create a schedule', ['secretary']);
    await setConversationSession(conversation.id, 'secretary', 'secretary-session');
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);

    const res = await runtime.bridge!.schedule({ prompt: 'Every morning review the latest email and draft replies', cron: '0 8 * * *' }, 'secretary-session');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.threadId).toBe('chat-1');
    expect(res.task.originThreadId).toBe('secretary-session');
    expect(runtime.names.get('chat-1')).toBe(res.task.title);
    // The persona can still list (and so cancel) it from the conversation it scheduled it in.
    expect((await runtime.bridge!.listForThread('secretary-session')).map((t) => t.id)).toEqual([res.task.id]);
    scheduler.stop();
  });

  it('refuses a bad request before adopting anything', async () => {
    const conversation = await createConversation('Create a schedule', ['secretary']);
    await setConversationSession(conversation.id, 'secretary', 'secretary-session');
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    const res = await runtime.bridge!.schedule({ prompt: 'x', cron: 'nope' }, 'secretary-session');
    expect(res.ok).toBe(false);
    expect(runtime.created).toEqual([]);
    scheduler.stop();
  });

  it('an ordinary chat schedules in place, no chat adopted', async () => {
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    const res = await runtime.bridge!.schedule({ prompt: 'watch the build', cron: '0 8 * * *' }, 'plain-chat');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.threadId).toBe('plain-chat');
    expect(res.task.originThreadId).toBeUndefined();
    expect(runtime.created).toEqual([]);
    scheduler.stop();
  });

  it('at boot, a task left on a hidden session moves into a chat of its own', async () => {
    const conversation = await createConversation('Create a schedule', ['secretary']);
    await setConversationSession(conversation.id, 'secretary', 'secretary-session');
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await saveTasks([
      { id: 'a', threadId: 'secretary-session', prompt: 'draft replies', schedule: { kind: 'cron', expr: '0 8 * * *' }, enabled: true, createdAt: future, nextRunAt: future, title: 'draft replies' },
      { id: 'b', threadId: 'plain-chat', prompt: 'watch the build', schedule: { kind: 'cron', expr: '0 8 * * *' }, enabled: true, createdAt: future, nextRunAt: future, title: 'watch the build' }
    ]);
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    await scheduler.start();
    const after = await readTasks();
    expect(after.find((t) => t.id === 'a')).toMatchObject({ threadId: 'chat-1', originThreadId: 'secretary-session' });
    expect(after.find((t) => t.id === 'b')).toMatchObject({ threadId: 'plain-chat' });
    expect(runtime.names.get('chat-1')).toBe('draft replies');
    scheduler.stop();
  });
});
