// The mail router against a scripted fake backend: the property under test is
// the implicit-reply rule — every delivery produces a reply mail, success or
// failure — plus session reuse (a reply resumes the persona's hidden thread),
// the persona plumbing on the turn it starts, and the P2 chain mechanics: a
// turn that used send_mail gets NO implicit reply, hops are cap-bounded, and
// add_persona is gated by the calling persona's capability flag.
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailRouter } from '../../src/server/mail/router';
import { readMail } from '../../src/server/workspace/mail';
import { updateMailSettings } from '../../src/server/workspace/settings';
import { mailStorePath, personasStorePath, settingsStorePath } from '../../src/server/workspace/paths';
import type { ChatBackend, MailBridge, MailBridgeContext } from '../../src/server/backend/types';
import type { StartTurnInput } from '../../src/shared/types';

const mailPath = mailStorePath();
const personasPath = personasStorePath();
const settingsPath = settingsStorePath();

beforeEach(() => {
  mkdirSync(dirname(mailPath), { recursive: true });
  rmSync(mailPath, { force: true });
  rmSync(personasPath, { force: true });
  rmSync(settingsPath, { force: true });
});
afterEach(() => {
  rmSync(mailPath, { force: true });
  rmSync(personasPath, { force: true });
  rmSync(settingsPath, { force: true });
});

/** One scripted delivery turn, consumed in dispatch order. */
interface TurnScript {
  mode: 'ok' | 'failed' | 'reject';
  reply?: string;
  replies?: string[];
  error?: string;
  /** Runs mid-turn with the wired mail bridge — the fake's send_mail/add_persona. */
  bridge?: (bridge: MailBridge, ctx: MailBridgeContext) => Promise<void>;
}

interface FakeBackend {
  backend: ChatBackend;
  starts: StartTurnInput[];
  /** Script the next turn(s); the last entry repeats when the list runs dry. */
  script: TurnScript;
  scripts: TurnScript[];
}

function fakeBackend(): FakeBackend {
  const emitter = new EventEmitter();
  const fake: FakeBackend = {
    backend: emitter as unknown as ChatBackend,
    starts: [],
    script: { mode: 'ok', reply: 'the reply' },
    scripts: []
  };
  let nextThread = 0;
  let mailBridge: MailBridge | null = null;
  const transcripts = new Map<string, { role: string; content: string }[]>();
  Object.assign(emitter, {
    setMailBridge: (bridge: MailBridge | null) => {
      mailBridge = bridge;
    },
    startTurn: async (input: StartTurnInput) => {
      fake.starts.push(input);
      const script = fake.scripts.shift() ?? fake.script;
      if (script.mode === 'reject') throw new Error(script.error ?? 'refused');
      const threadId = input.threadId ?? `thread-${++nextThread}`;
      const turnId = input.turnId ?? `turn-${fake.starts.length}`;
      const log = transcripts.get(threadId) ?? [];
      log.push({ role: 'user', content: input.input });
      if (script.mode === 'ok')
        for (const content of script.replies ?? [script.reply ?? ''])
          log.push({ role: 'assistant', content });
      transcripts.set(threadId, log);
      setTimeout(() => {
        void (async () => {
          // The turn's tool phase: bridge calls happen while the turn is live,
          // before it settles — exactly the real ordering.
          if (script.bridge && mailBridge && input.mail && input.persona) {
            await script.bridge(mailBridge, {
              conversationId: input.mail.conversationId,
              participants: input.mail.participants,
              personaId: input.persona.id,
              turnId
            });
          }
          emitter.emit('event', {
            method: script.mode === 'ok' ? 'turn/completed' : 'turn/failed',
            params: { threadId, turn: { id: turnId }, ...(script.error ? { error: script.error } : {}) },
            receivedAt: Date.now()
          });
        })();
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

/** Wire a router the way index.ts does: bridge attached at construction. */
function makeRouter(fake: FakeBackend, onChange: () => void = () => undefined): MailRouter {
  const router = new MailRouter({ runtime: fake.backend, onChange });
  fake.backend.setMailBridge({
    send: (req, ctx) => router.bridgeSend(req, ctx),
    addPersona: (personaId, ctx) => router.bridgeAddPersona(personaId, ctx)
  });
  return router;
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

  it('runs a chain: send_mail suppresses the implicit reply, hops flow, the user gets one answer', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scripts = [
      // 1: verifier (driver, from user) consults orchestrator and ends — its
      //    plain text must NOT come back as a mail (it already spoke).
      {
        mode: 'ok',
        reply: 'consulting…',
        bridge: async (bridge, ctx) => {
          const res = await bridge.send({ to: ['orchestrator'], body: 'please check this' }, ctx);
          expect(res.ok).toBe(true);
        }
      },
      // 2: orchestrator answers plainly — the implicit reply hops back to verifier.
      { mode: 'ok', reply: 'orchestrator verdict' },
      // 3: verifier answers the user explicitly.
      {
        mode: 'ok',
        reply: 'wrapping up',
        bridge: async (bridge, ctx) => {
          const res = await bridge.send({ to: ['user'], body: 'final answer' }, ctx);
          expect(res.ok).toBe(true);
        }
      }
    ];
    await router.compose({ to: ['verifier', 'orchestrator'], subject: 'chain', body: 'question' });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items).toHaveLength(4);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    expect(mail.items.map((i) => ({ from: i.from, to: i.to, body: i.body }))).toEqual([
      { from: 'user', to: ['verifier', 'orchestrator'], body: 'question' },
      { from: 'verifier', to: ['orchestrator'], body: 'please check this' },
      { from: 'orchestrator', to: ['verifier'], body: 'orchestrator verdict' },
      { from: 'verifier', to: ['user'], body: 'final answer' }
    ]);
    // Two persona-addressed mails were spent against the cap…
    expect(mail.conversations[0].exchangeCount).toBe(2);
    // …the chain stopped on the user by explicit send_mail → awaiting-user…
    expect(mail.conversations[0].status).toBe('awaiting-user');
    // …and both personas got their own hidden session.
    expect(Object.keys(mail.conversations[0].sessions).sort()).toEqual(['orchestrator', 'verifier']);
    // Three delivery turns ran: verifier, orchestrator, verifier again — the
    // third resuming the SAME hidden thread the first minted.
    expect(fake.starts).toHaveLength(3);
    expect(fake.starts[0].threadId).toBeUndefined(); // fresh session
    expect(fake.starts[2].threadId).toBe(mail.conversations[0].sessions.verifier);
  });

  it('at the cap, send_mail to a persona is refused and an implicit hop is forced to the user', async () => {
    await updateMailSettings({ exchangeCap: 1 });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scripts = [
      // 1: verifier spends the whole cap on one consultation; a second send is refused.
      {
        mode: 'ok',
        reply: 'consulting…',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'check' }, ctx)).ok).toBe(true);
          const refused = await bridge.send({ to: ['orchestrator'], body: 'and this' }, ctx);
          expect(refused.ok).toBe(false);
          if (!refused.ok) expect(refused.error).toContain('cap');
        }
      },
      // 2: orchestrator answers plainly — the hop back to verifier would exceed
      //    the cap, so the reply is forced to the user instead of looping on.
      { mode: 'ok', reply: 'forced to you' }
    ];
    await router.compose({ to: ['verifier', 'orchestrator'], subject: 'capped', body: 'go' });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items).toHaveLength(3);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    expect(mail.items[2]).toMatchObject({ from: 'orchestrator', to: ['user'], body: 'forced to you' });
    expect(mail.conversations[0].status).toBe('awaiting-user');
    expect(fake.starts).toHaveLength(2); // no third delivery — the wave ended on the user
  });

  it('a user reply resets the exchange window', async () => {
    await updateMailSettings({ exchangeCap: 1 });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const consult: TurnScript = {
      mode: 'ok',
      reply: 'asked',
      bridge: async (bridge, ctx) => {
        expect((await bridge.send({ to: ['orchestrator'], body: 'check' }, ctx)).ok).toBe(true);
      }
    };
    fake.scripts = [consult, { mode: 'ok', reply: 'verdict one' }];
    const { conversations } = await router.compose({ to: ['verifier', 'orchestrator'], subject: 's', body: 'one' });
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.conversations[0].exchangeCount).toBe(1); // the cap is spent
      expect(m.conversations[0].status).not.toBe('working');
    });
    // The user replies: the window resets, so the SAME consultation works again.
    fake.scripts = [consult, { mode: 'ok', reply: 'verdict two' }];
    await router.reply(conversations[0].id, 'again');
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.filter((i) => i.body === 'check')).toHaveLength(2);
      // Fully drained: the second wave's forced-to-user reply has landed too —
      // a chain still running past the test's end would bleed into the next one.
      expect(m.items.filter((i) => i.body === 'verdict two' && i.to.includes('user'))).toHaveLength(1);
      expect(m.conversations[0].status).not.toBe('working');
    });
  });

  it('send_mail refuses recipients outside the participant set', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scripts = [
      {
        mode: 'ok',
        reply: 'done',
        bridge: async (bridge, ctx) => {
          const res = await bridge.send({ to: ['secretary'], body: 'psst' }, ctx);
          expect(res.ok).toBe(false);
          if (!res.ok) expect(res.error).toContain('Not reachable');
        }
      }
    ];
    await router.compose({ to: ['verifier'], subject: 's', body: 'q' });
    await settledMail();
    expect((await readMail()).items.some((i) => i.to.includes('secretary'))).toBe(false);
  });

  it('add_persona is gated by the capability flag and grows the participant set', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scripts = [
      {
        mode: 'ok',
        reply: 'no powers',
        bridge: async (bridge, ctx) => {
          const res = await bridge.addPersona('orchestrator', ctx);
          expect(res.ok).toBe(false);
          if (!res.ok) expect(res.error).toContain('capability');
        }
      }
    ];
    await router.compose({ to: ['verifier'], subject: 'gated', body: 'q' });
    await settledMail();
    expect((await readMail()).conversations[0].participants).toEqual(['verifier']);

    // Secretary ships with the flag on — and may add by NAME, not just id.
    const fake2 = fakeBackend();
    const router2 = makeRouter(fake2);
    fake2.scripts = [
      {
        mode: 'ok',
        reply: 'delegated',
        bridge: async (bridge, ctx) => {
          expect((await bridge.addPersona('Orchestrator', ctx)).ok).toBe(true);
          // Now reachable: a send to the fresh participant is accepted.
          expect((await bridge.send({ to: ['orchestrator'], body: 'take this' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'on it' },
      // The hop back at Secretary: end the chain ON THE USER, so no delivery
      // outlives this test.
      {
        mode: 'ok',
        reply: 'closing',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'delegated and done' }, ctx)).ok).toBe(true);
        }
      }
    ];
    await router2.compose({ to: ['secretary'], subject: 'grown', body: 'delegate' });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      const grown = m.conversations.find((c) => c.subject === 'grown');
      expect(grown).toBeTruthy();
      expect(grown!.status).not.toBe('working');
      expect(m.items.some((i) => i.body === 'delegated and done')).toBe(true);
      return m;
    });
    const grown = mail.conversations.find((c) => c.subject === 'grown')!;
    expect(grown.participants).toEqual(['secretary', 'orchestrator']);
  });

  it('a mid-chain mail to the user does not end the conversation as awaiting-user', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scripts = [
      // The driver CCs the user a progress note AND consults a persona: the
      // conversation must end on the final implicit answer (idle), not flip to
      // awaiting-user because of the note.
      {
        mode: 'ok',
        reply: 'working…',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'progress note' }, ctx)).ok).toBe(true);
          expect((await bridge.send({ to: ['orchestrator'], body: 'crunch this' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'crunched' },
      // Back at the driver, which answers plainly — implicit reply to its
      // initiator (orchestrator)… which would loop; here it ends by mailing the user.
      {
        mode: 'ok',
        reply: 'done',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'the result' }, ctx)).ok).toBe(true);
        }
      }
    ];
    await router.compose({ to: ['verifier', 'orchestrator'], subject: 'notes', body: 'go' });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items).toHaveLength(5);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    expect(mail.items.map((i) => i.body)).toEqual([
      'go',
      'progress note',
      'crunch this',
      'crunched',
      'the result'
    ]);
    expect(mail.conversations[0].status).toBe('awaiting-user');
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
