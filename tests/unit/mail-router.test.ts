// The mail router against a scripted fake backend: the property under test is
// the implicit-reply rule — every delivery produces a reply mail, success or
// failure — plus session reuse (a reply resumes the persona's hidden thread)
// and the persona plumbing on the turn it starts.
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailRouter } from '../../src/server/mail/router';
import { readMail } from '../../src/server/workspace/mail';
import { mailStorePath, personasStorePath } from '../../src/server/workspace/paths';
import type { ChatBackend } from '../../src/server/backend/types';
import type { StartTurnInput } from '../../src/shared/types';

const mailPath = mailStorePath();
const personasPath = personasStorePath();

beforeEach(() => {
  mkdirSync(dirname(mailPath), { recursive: true });
  rmSync(mailPath, { force: true });
  rmSync(personasPath, { force: true });
});
afterEach(() => {
  rmSync(mailPath, { force: true });
  rmSync(personasPath, { force: true });
});

interface FakeBackend {
  backend: ChatBackend;
  starts: StartTurnInput[];
  /** Script the next turn: 'ok' settles with `reply` (or `replies`) as the assistant text. */
  script: { mode: 'ok' | 'failed' | 'reject'; reply?: string; replies?: string[]; error?: string };
}

function fakeBackend(): FakeBackend {
  const emitter = new EventEmitter();
  const fake: FakeBackend = {
    backend: emitter as unknown as ChatBackend,
    starts: [],
    script: { mode: 'ok', reply: 'the reply' }
  };
  let nextThread = 0;
  const transcripts = new Map<string, { role: string; content: string }[]>();
  Object.assign(emitter, {
    startTurn: async (input: StartTurnInput) => {
      fake.starts.push(input);
      if (fake.script.mode === 'reject') throw new Error(fake.script.error ?? 'refused');
      const threadId = input.threadId ?? `thread-${++nextThread}`;
      const turnId = input.turnId ?? `turn-${fake.starts.length}`;
      const log = transcripts.get(threadId) ?? [];
      log.push({ role: 'user', content: input.input });
      if (fake.script.mode === 'ok')
        for (const content of fake.script.replies ?? [fake.script.reply ?? ''])
          log.push({ role: 'assistant', content });
      transcripts.set(threadId, log);
      const outcome = fake.script.mode;
      const error = fake.script.error;
      setTimeout(() => {
        emitter.emit('event', {
          method: outcome === 'ok' ? 'turn/completed' : 'turn/failed',
          params: { threadId, turn: { id: turnId }, ...(error ? { error } : {}) },
          receivedAt: Date.now()
        });
      }, 0);
      return { threadId, turnId };
    },
    readThread: async (threadId: string) => ({
      title: 't',
      messages: (transcripts.get(threadId) ?? []).map((m, i) => ({ id: String(i), ...m }))
    }),
    interruptTurn: async () => undefined
  });
  return fake;
}

async function settledMail() {
  return vi.waitFor(async () => {
    const mail = await readMail();
    const c = mail.conversations[0];
    expect(c).toBeTruthy();
    expect(c.status).not.toBe('working');
    // The delivery has replied once there are ≥ 2 items.
    expect(mail.items.length).toBeGreaterThanOrEqual(2);
    return mail;
  });
}

describe('mail router', () => {
  it('composes, delivers to the driver persona, and appends the implicit reply', async () => {
    const fake = fakeBackend();
    const changed = vi.fn();
    const router = new MailRouter({ runtime: fake.backend, onChange: changed });

    const result = await router.compose({ to: ['verifier'], subject: 'Check this', body: 'is it true?' });
    expect(result.conversations).toHaveLength(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ from: 'user', to: ['verifier'] });

    const mail = await settledMail();
    const reply = mail.items[1];
    expect(reply).toMatchObject({ from: 'verifier', to: ['user'], body: 'the reply' });
    expect(mail.conversations[0].status).toBe('idle');
    expect(mail.conversations[0].userUpdatedAt).toBe(reply.at);
    expect(changed).toHaveBeenCalled();

    // The turn ran AS the persona, on its pins, flagged as mail.
    const start = fake.starts[0];
    expect(start.persona?.id).toBe('verifier');
    expect(start.persona?.prompt).toContain('Verifier');
    expect(start.mail?.conversationId).toBe(mail.conversations[0].id);
    // The hidden session was recorded for the next delivery.
    expect(mail.conversations[0].sessions.verifier).toBe('thread-1');
  });

  it('the reply is the WHOLE turn, not its last message: tool-using turns write several', async () => {
    const fake = fakeBackend();
    fake.script = { mode: 'ok', replies: ['I looked it up.', 'Here is the answer.', 'Want prices too?'] };
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    await router.compose({ to: ['verifier'], subject: 's', body: 'question' });
    const mail = await settledMail();
    expect(mail.items[1].body).toBe('I looked it up.\n\nHere is the answer.\n\nWant prices too?');

    // …and a follow-up reply gathers only the NEW turn's messages, not the
    // first turn's answer over again.
    fake.script = { mode: 'ok', replies: ['Second turn.'] };
    await router.reply(mail.conversations[0].id, 'follow-up');
    const after = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items).toHaveLength(4);
      return m;
    });
    expect(after.items[3].body).toBe('Second turn.');
  });

  it('defaults an empty To: to the built-in Normal persona', async () => {
    const fake = fakeBackend();
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    await router.compose({ to: [], subject: 's', body: 'hello' });
    await settledMail();
    expect(fake.starts[0].persona?.id).toBe('normal');
  });

  it('refuses a compose addressed to a persona that does not exist', async () => {
    const fake = fakeBackend();
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    await expect(router.compose({ to: ['ghost'], subject: 's', body: 'x' })).rejects.toThrow(/ghost/);
    expect((await readMail()).conversations).toHaveLength(0);
  });

  it('a reply resumes the SAME hidden thread with the conversation context', async () => {
    const fake = fakeBackend();
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    const { conversations } = await router.compose({ to: ['verifier'], subject: 's', body: 'first' });
    await settledMail();

    fake.script = { mode: 'ok', reply: 'second answer' };
    await router.reply(conversations[0].id, 'follow-up');
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items).toHaveLength(4);
      expect(m.conversations[0].status).toBe('idle');
      return m;
    });
    expect(fake.starts[1].threadId).toBe('thread-1');
    expect(mail.items[3].body).toBe('second answer');
  });

  it('a failed run replies with the failure and marks the conversation awaiting-user', async () => {
    const fake = fakeBackend();
    fake.script = { mode: 'failed', error: 'model exploded' };
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    await router.compose({ to: ['verifier'], subject: 's', body: 'x' });
    const mail = await settledMail();
    expect(mail.items[1].body).toContain('model exploded');
    expect(mail.conversations[0].status).toBe('awaiting-user');
  });

  it('a startTurn that throws still produces a reply mail (nothing vanishes)', async () => {
    const fake = fakeBackend();
    fake.script = { mode: 'reject', error: 'no auth' };
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    await router.compose({ to: ['verifier'], subject: 's', body: 'x' });
    const mail = await settledMail();
    expect(mail.items[1].body).toContain('no auth');
  });

  it('deliverTaskMail groups a task’s firings into one conversation', async () => {
    const fake = fakeBackend();
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    await router.deliverTaskMail({ subject: 'Watch the page', body: 'it changed', taskId: 'task-1' });
    await router.deliverTaskMail({ subject: 'Watch the page', body: 'changed again', taskId: 'task-1' });
    const { conversations, items } = await readMail();
    expect(conversations).toHaveLength(1);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.to.includes('user') && i.taskId === 'task-1')).toBe(true);
    // No delivery turn ran — the scheduled run already did the work.
    expect(fake.starts).toHaveLength(0);
  });
});
