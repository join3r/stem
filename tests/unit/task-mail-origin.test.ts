// schedule_task called from a mail persona's hidden session. Runs used to append
// to the task's chat, so a task made from a hidden session needed a visible chat
// adopted for it (and a boot-time pass to move old ones). Every run now gets a
// thread of its own, so the bridge binds the task to wherever it was called from
// — a chat or a hidden session alike — and adopts nothing.
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
import { createConversation, mailConversationFor, setConversationSession } from '../../src/server/workspace/mail';
import { setChatPrivate } from '../../src/server/workspace/chats';
import { chatStorePath, mailStorePath } from '../../src/server/workspace/paths';
import { readTasks } from '../../src/server/workspace/tasks';

class FakeRuntime extends EventEmitter {
  bridge: TaskBridge | null = null;
  created: string[] = [];
  deleted: string[] = [];
  starts = 0;
  /** Runs inside the turn — after startTurn resolved, before it settles. */
  duringTurn: ((threadId: string) => Promise<void>) | null = null;
  setTaskBridge(bridge: TaskBridge | null) {
    this.bridge = bridge;
  }
  async createThread() {
    const id = `chat-${this.created.length + 1}`;
    this.created.push(id);
    return id;
  }
  async deleteThread(threadId: string) {
    this.deleted.push(threadId);
  }
  async startTurn() {
    const n = ++this.starts;
    const threadId = `run-${n}`;
    const turnId = `turn-${n}`;
    setTimeout(async () => {
      await this.duringTurn?.(threadId);
      this.emit('event', { method: 'turn/completed', params: { threadId, turn: { id: turnId } } });
    }, 0);
    return { threadId, turnId };
  }
}

function wire(
  runtime: FakeRuntime,
  opts: {
    taskRunThreadIds?: (taskId: string) => Promise<string[]>;
    deliverTaskMail?: (input: { taskId: string; conversationId?: string }) => Promise<string | void>;
  } = {}
) {
  return initTaskScheduler({
    runtime: runtime as unknown as ChatBackend,
    emit: () => {},
    isUserActive: () => false,
    revealMainWindow: () => {},
    requestAttention: () => {},
    deliverTaskMail: opts.deliverTaskMail ?? (async () => {}),
    mailConversationFor,
    ...(opts.taskRunThreadIds ? { taskRunThreadIds: opts.taskRunThreadIds } : {})
  });
}

const settled = (runtime: FakeRuntime) => new Promise<void>((r) => setTimeout(r, 30)).then(() => runtime);

const mailPath = mailStorePath();
const chatPath = chatStorePath();
beforeEach(() => {
  mkdirSync(dirname(mailPath), { recursive: true });
  rmSync(mailPath, { force: true });
  rmSync(chatPath, { force: true });
  rmSync(STORE, { force: true });
});
afterEach(() => {
  rmSync(mailPath, { force: true });
  rmSync(chatPath, { force: true });
  rmSync(STORE, { force: true });
});

describe('schedule_task through the bridge', () => {
  it('from a mail session: binds to that session, adopts no chat, and list_tasks there finds it', async () => {
    const conversation = await createConversation('Create a schedule', ['secretary']);
    await setConversationSession(conversation.id, 'secretary', 'secretary-session');
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);

    const res = await runtime.bridge!.schedule({ prompt: 'Every morning review the latest email and draft replies', cron: '0 8 * * *' }, 'secretary-session');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.threadId).toBe('secretary-session');
    expect(runtime.created).toEqual([]);
    expect((await runtime.bridge!.listForThread('secretary-session')).map((t) => t.id)).toEqual([res.task.id]);
    expect((await readTasks())[0].threadId).toBe('secretary-session');
    scheduler.stop();
  });

  it('from mail: reports reply in that conversation, and a follow-up a run schedules stays there too', async () => {
    const conversation = await createConversation('Import the audiobooks', ['secretary']);
    await setConversationSession(conversation.id, 'secretary', 'secretary-session');
    const delivered: { taskId: string; conversationId?: string }[] = [];
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime, {
      deliverTaskMail: async (input) => {
        delivered.push({ taskId: input.taskId, conversationId: input.conversationId });
        return input.conversationId ?? 'own-thread';
      }
    });
    const first = await runtime.bridge!.schedule({ prompt: 'check the downloads', at: new Date(Date.now() + 900_000).toISOString() }, 'secretary-session');
    if (!first.ok) throw new Error(first.error);
    expect(first.task.mailConversationId).toBe(conversation.id);

    // The check reports, then schedules the next check from its own run thread.
    let followUp: string | undefined;
    runtime.duringTurn = async (threadId) => {
      await runtime.bridge!.notify({ title: 'Progress', message: '33 of 50' }, threadId);
      const next = await runtime.bridge!.schedule({ prompt: 'check again', at: new Date(Date.now() + 900_000).toISOString() }, threadId);
      if (next.ok) followUp = next.task.id;
    };
    scheduler.runNow(first.task.id);
    await settled(runtime);
    const next = (await readTasks()).find((t) => t.id === followUp);
    expect(next?.mailConversationId).toBe(conversation.id);
    expect(delivered).toEqual([{ taskId: first.task.id, conversationId: conversation.id }]);

    // A task scheduled from a plain chat is bound to no mail.
    const chat = await runtime.bridge!.schedule({ prompt: 'watch', cron: '0 8 * * *' }, 'plain-chat');
    expect(chat.ok && chat.task.mailConversationId).toBeUndefined();
    scheduler.stop();
  });

  it('refuses a bad request and writes nothing', async () => {
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    const res = await runtime.bridge!.schedule({ prompt: 'x', cron: 'nope' }, 'plain-chat');
    expect(res.ok).toBe(false);
    expect(await readTasks()).toEqual([]);
    scheduler.stop();
  });

  it('from a chat: binds to the chat, and the persona asked for runs it', async () => {
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    const res = await runtime.bridge!.schedule({ prompt: 'watch the build', cron: '0 8 * * *', personaId: 'verifier' }, 'plain-chat');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.threadId).toBe('plain-chat');
    expect(res.task.runsAs).toEqual({ kind: 'persona', personaId: 'verifier' });
    scheduler.stop();
  });

  it('cancel_task deletes the task and the threads its mail-sending runs left behind', async () => {
    const runtime = new FakeRuntime();
    const asked: string[] = [];
    const scheduler = wire(runtime, {
      taskRunThreadIds: async (taskId) => {
        asked.push(taskId);
        return ['run-a', 'run-b'];
      }
    });
    const res = await runtime.bridge!.schedule({ prompt: 'watch', cron: '0 8 * * *' }, 'plain-chat');
    if (!res.ok) throw new Error(res.error);
    expect(await runtime.bridge!.cancel(res.task.id, { thread: 'plain-chat', anyThread: true })).toEqual({ ok: true });
    expect(asked).toEqual([res.task.id]);
    expect(runtime.deleted.sort()).toEqual(['run-a', 'run-b']);
    expect(await runtime.bridge!.cancel(res.task.id, ANY)).toMatchObject({ ok: false });
    scheduler.stop();
  });

  it('notify_user keeps the run thread only once its mail has landed; a dropped mail leaves nothing orphaned', async () => {
    for (const landed of [true, false]) {
      const runtime = new FakeRuntime();
      const scheduler = wire(runtime, {
        deliverTaskMail: async () => {
          if (!landed) throw new Error('mail store unwritable');
          return 'conversation-1';
        }
      });
      const res = await runtime.bridge!.schedule({ prompt: 'watch', cron: '0 8 * * *' }, 'plain-chat');
      if (!res.ok) throw new Error(res.error);
      runtime.duringTurn = (threadId) => runtime.bridge!.notify({ title: 'Found', message: 'it' }, threadId);
      scheduler.runNow(res.task.id);
      await settled(runtime);
      // Mail landed → the thread is the mail's now. Mail dropped → the thread
      // would be reachable from nowhere, so it goes like a silent run's.
      expect(runtime.deleted).toEqual(landed ? [] : ['run-1']);
      scheduler.stop();
    }
  });
});

// update_task / cancel_task: a chat the user types in may edit a task scheduled
// from any other chat (null owner); an unattended run is held to its own thread.
const ANY = { thread: 'other-chat', anyThread: true };

describe('update_task and cancel_task through the bridge', () => {
  it('edits the prompt, schedule and paused state in place, keeping the id', async () => {
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    const res = await runtime.bridge!.schedule({ prompt: 'Draft replies. Sign as Vladimír.', cron: '0 6 * * *' }, 'morning-chat');
    if (!res.ok) throw new Error(res.error);

    const upd = await runtime.bridge!.update(
      res.task.id,
      { prompt: 'Draft replies. Sign as Stem on behalf of Vladimír.', cron: '30 6 * * *', enabled: false },
      ANY
    );
    expect(upd.ok).toBe(true);
    const [task] = await readTasks();
    expect(task.id).toBe(res.task.id);
    expect(task.threadId).toBe('morning-chat');
    expect(task.prompt).toBe('Draft replies. Sign as Stem on behalf of Vladimír.');
    expect(task.schedule).toEqual({ kind: 'cron', expr: '30 6 * * *' });
    expect(task.enabled).toBe(false);
    // Not the user's words: the old prompt stays behind Revert in the Tasks tab.
    expect(task.rewritten).toMatchObject({ kind: 'edit', original: 'Draft replies. Sign as Vladimír.' });
    expect((await runtime.bridge!.listReachable(ANY)).map((t) => t.id)).toEqual([res.task.id]);
    scheduler.stop();
  });

  it('applies nothing when any part is invalid', async () => {
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    const res = await runtime.bridge!.schedule({ prompt: 'original', cron: '0 6 * * *' }, 'morning-chat');
    if (!res.ok) throw new Error(res.error);
    expect((await runtime.bridge!.update(res.task.id, { prompt: 'changed', cron: 'nope' }, ANY)).ok).toBe(false);
    expect((await runtime.bridge!.update(res.task.id, { prompt: '   ' }, ANY)).ok).toBe(false);
    expect((await runtime.bridge!.update(res.task.id, {}, ANY)).ok).toBe(false);
    expect((await readTasks())[0].prompt).toBe('original');
    scheduler.stop();
  });

  it("holds an owner-scoped caller to its own thread's tasks", async () => {
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    const res = await runtime.bridge!.schedule({ prompt: 'original', cron: '0 6 * * *' }, 'morning-chat');
    if (!res.ok) throw new Error(res.error);
    expect((await runtime.bridge!.update(res.task.id, { prompt: 'hijacked' }, { thread: 'run-7', anyThread: false })).ok).toBe(false);
    expect((await runtime.bridge!.cancel(res.task.id, { thread: 'run-7', anyThread: false })).ok).toBe(false);
    expect((await readTasks())[0].prompt).toBe('original');
    expect((await runtime.bridge!.cancel(res.task.id, ANY)).ok).toBe(true);
    expect(await readTasks()).toEqual([]);
    scheduler.stop();
  });

  it("keeps a private chat's or private mail's tasks out of every other chat", async () => {
    const runtime = new FakeRuntime();
    const scheduler = wire(runtime);
    await setChatPrivate('secret-chat');
    const fromChat = await runtime.bridge!.schedule({ prompt: 'private chat task', cron: '0 6 * * *' }, 'secret-chat');
    const conversation = await createConversation('Private errand', ['secretary'], '', { private: true });
    await setConversationSession(conversation.id, 'secretary', 'private-session');
    const fromMail = await runtime.bridge!.schedule({ prompt: 'private mail task', cron: '0 7 * * *' }, 'private-session');
    const open = await runtime.bridge!.schedule({ prompt: 'ordinary task', cron: '0 8 * * *' }, 'morning-chat');
    if (!fromChat.ok || !fromMail.ok || !open.ok) throw new Error('schedule failed');
    expect(fromMail.task.mailConversationId).toBe(conversation.id);

    expect((await runtime.bridge!.listReachable(ANY)).map((t) => t.id)).toEqual([open.task.id]);
    expect((await runtime.bridge!.update(fromChat.task.id, { enabled: false }, ANY)).ok).toBe(false);
    expect((await runtime.bridge!.cancel(fromMail.task.id, ANY)).ok).toBe(false);
    // The private chat itself still reaches its own task.
    const own = { thread: 'secret-chat', anyThread: true };
    expect((await runtime.bridge!.listReachable(own)).map((t) => t.id)).toContain(fromChat.task.id);
    expect((await runtime.bridge!.update(fromChat.task.id, { enabled: false }, own)).ok).toBe(true);
    scheduler.stop();
  });
});
