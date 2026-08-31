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
import { resetActivity, snapshot } from '../../src/server/activity';
import { MailRouter } from '../../src/server/mail/router';
import { readMail } from '../../src/server/workspace/mail';
import { listPersonas, savePersona } from '../../src/server/workspace/personas';
import { updateMailSettings } from '../../src/server/workspace/settings';
import { mailStorePath, personasStorePath, settingsStorePath } from '../../src/server/workspace/paths';
import type {
  ChatBackend,
  MailBridge,
  MailBridgeContext,
  SavePersonaRequest
} from '../../src/server/backend/types';
import type { StartTurnInput } from '../../src/shared/types';

const mailPath = mailStorePath();
const personasPath = personasStorePath();
const settingsPath = settingsStorePath();

beforeEach(() => {
  mkdirSync(dirname(mailPath), { recursive: true });
  rmSync(mailPath, { force: true });
  rmSync(personasPath, { force: true });
  rmSync(settingsPath, { force: true });
  resetActivity();
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
  /**
   * Per-persona scripts, consulted before the shared list — parallel branches
   * start in an order the test must not depend on, so key their turns by who
   * runs them instead.
   */
  scriptsByPersona: Record<string, TurnScript[]>;
}

function fakeBackend(): FakeBackend {
  const emitter = new EventEmitter();
  const fake: FakeBackend = {
    backend: emitter as unknown as ChatBackend,
    starts: [],
    script: { mode: 'ok', reply: 'the reply' },
    scripts: [],
    scriptsByPersona: {}
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
      const script =
        (input.persona ? fake.scriptsByPersona[input.persona.id]?.shift() : undefined) ??
        fake.scripts.shift() ??
        fake.script;
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
    addPersona: (personaId, ctx) => router.bridgeAddPersona(personaId, ctx),
    savePersona: (req, ctx) => router.bridgeSavePersona(req, ctx),
    deletePersona: (personaId, ctx) => router.bridgeDeletePersona(personaId, ctx)
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

  it('a working conversation gets one background-activity row, closed with its turn count', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    let midRun: ReturnType<typeof snapshot> | null = null;
    fake.scripts = [
      {
        mode: 'ok',
        reply: 'consulting…',
        bridge: async (bridge, ctx) => {
          midRun = snapshot(); // taken mid-turn 1, while the wave is in flight
          await bridge.send({ to: ['orchestrator'], body: 'check this' }, ctx);
        }
      },
      { mode: 'ok', reply: 'verdict' },
      {
        mode: 'ok',
        reply: 'wrapping up',
        bridge: async (bridge, ctx) => {
          await bridge.send({ to: ['user'], body: 'answer' }, ctx);
        }
      }
    ];
    await router.compose({ to: ['verifier', 'orchestrator'], subject: 'Shoes', body: 'q' });
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items).toHaveLength(4);
      expect(m.conversations[0].status).not.toBe('working');
    });
    // Mid-wave: one running row, named by the conversation's subject.
    const running = midRun!.running.find((e) => e.kind === 'mail.deliver');
    expect(running?.label).toBe('Mail: Shoes');
    expect(running?.detail).toContain('Verifier working · turn 1');
    // Drained: the row moved to history carrying the wave's turn count.
    expect(snapshot().running).toHaveLength(0);
    const done = snapshot().history.find((e) => e.kind === 'mail.deliver');
    expect(done).toMatchObject({ label: 'Mail: Shoes', state: 'done', detail: '3 turns' });
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

// ---- P3: parallel waves, fan-out joins, send budgets, persona bridge ops ----

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('wave concurrency', () => {
  it('runs at most three deliveries at once; the rest start as slots free', async () => {
    for (let i = 1; i <= 4; i++) await savePersona({ id: `w${i}`, name: `w${i}`, prompt: '' });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const holds = Array.from({ length: 4 }, () => deferred());
    for (let i = 1; i <= 4; i++) {
      fake.scriptsByPersona[`w${i}`] = [
        { mode: 'ok', reply: `reply-${i}`, bridge: () => holds[i - 1].promise }
      ];
    }
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'fanning out',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['w1', 'w2', 'w3', 'w4'], body: 'piece' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'assembled' }
    ];
    await router.compose({ to: ['orchestrator', 'w1', 'w2', 'w3', 'w4'], subject: 'wave', body: 'go' });
    // Orchestrator + exactly three branches start; the fourth holds for a slot.
    await vi.waitFor(() => expect(fake.starts.length).toBe(4));
    await new Promise((r) => setTimeout(r, 25));
    expect(fake.starts).toHaveLength(4);
    holds[0].resolve();
    await vi.waitFor(() => expect(fake.starts.length).toBe(5));
    for (const h of holds) h.resolve();
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'assembled' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).toBe('idle');
      return m;
    });
    // One assembly turn carried all four replies.
    const assembly = fake.starts[5];
    expect(assembly.persona?.id).toBe('orchestrator');
    for (let i = 1; i <= 4; i++) expect(assembly.input).toContain(`reply-${i}`);
    expect(mail.conversations[0].exchangeCount).toBe(8); // 4 delegations + 4 replies
  });

  it('two mails to the same persona never run concurrently', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const hold = deferred();
    fake.scriptsByPersona.verifier = [
      { mode: 'ok', reply: 'first', bridge: () => hold.promise },
      { mode: 'ok', reply: 'second' }
    ];
    const { conversations } = await router.compose({ to: ['verifier'], subject: 's', body: 'one' });
    await vi.waitFor(() => expect(fake.starts.length).toBe(1));
    await router.reply(conversations[0].id, 'two');
    await new Promise((r) => setTimeout(r, 25));
    expect(fake.starts).toHaveLength(1); // the second delivery waits on the first
    hold.resolve();
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.map((i) => i.body)).toContain('second');
      expect(m.conversations[0].status).toBe('idle');
    });
    expect(fake.starts).toHaveLength(2);
  });
});

describe('fan-out joins', () => {
  it('buffers branch replies and starts ONE assembly turn whose reply lands on the user', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    let midJoin: ReturnType<typeof snapshot> | null = null;
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'delegating',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['verifier', 'secretary'], body: 'your piece' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'the assembled answer' }
    ];
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'v-reply',
        bridge: async () => {
          midJoin = snapshot();
        }
      }
    ];
    fake.scriptsByPersona.secretary = [{ mode: 'ok', reply: 's-reply' }];
    await router.compose({ to: ['orchestrator', 'verifier', 'secretary'], subject: 'fan', body: 'go' });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'the assembled answer' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).toBe('idle');
      return m;
    });
    // 4 turns: the fan-out, two branches, one assembly — never a turn per reply.
    expect(fake.starts).toHaveLength(4);
    const assembly = fake.starts[3];
    expect(assembly.persona?.id).toBe('orchestrator');
    expect(assembly.input).toContain('Replies to your delegations');
    expect(assembly.input).toContain('--- from Verifier ---');
    expect(assembly.input).toContain('v-reply');
    expect(assembly.input).toContain('s-reply');
    // The branch replies are ordinary items on the record.
    expect(mail.items.filter((i) => i.to.includes('orchestrator') && i.from !== 'user')).toHaveLength(2);
    // The activity row named the wave's stragglers while it waited.
    expect(midJoin!.running.find((e) => e.kind === 'mail.deliver')?.detail).toContain('waiting on');
    expect(mail.conversations[0].exchangeCount).toBe(4); // 2 delegations + 2 replies
  });

  it('a failed branch, an explicit reply, and a to-user detour all settle the wave', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'delegating',
        bridge: async (bridge, ctx) => {
          expect(
            (await bridge.send({ to: ['verifier', 'secretary', 'normal'], body: 'piece' }, ctx)).ok
          ).toBe(true);
        }
      },
      { mode: 'ok', reply: 'salvaged' }
    ];
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'spoke already',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'explicit reply' }, ctx)).ok).toBe(true);
        }
      }
    ];
    fake.scriptsByPersona.secretary = [{ mode: 'failed', error: 'exploded' }];
    fake.scriptsByPersona.normal = [
      {
        mode: 'ok',
        reply: 'went direct',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'around you' }, ctx)).ok).toBe(true);
        }
      }
    ];
    await router.compose({
      to: ['orchestrator', 'verifier', 'secretary', 'normal'],
      subject: 'edges',
      body: 'go'
    });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'salvaged' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    const assembly = fake.starts.find(
      (s) => s.persona?.id === 'orchestrator' && s.input.includes('Replies to your delegations')
    )!;
    expect(assembly.input).toContain('explicit reply');
    expect(assembly.input).toContain('run failed');
    expect(assembly.input).toContain('mailed the user directly');
    // The failure notice still reached the user, and awaiting-user stuck.
    expect(mail.items.some((i) => i.to.includes('user') && i.body.includes('exploded'))).toBe(true);
    expect(mail.conversations[0].status).toBe('awaiting-user');
  });

  it('mail to a mid-fan-out sender from outside the wave is buffered, not delivered', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const gossipSent = deferred();
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'delegating',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['verifier', 'secretary'], body: 'piece' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'assembled with gossip' }
    ];
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'spoke already',
        bridge: async (bridge, ctx) => {
          // Pulls a bystander in, then answers its own assignment.
          expect((await bridge.send({ to: ['normal'], body: 'psst' }, ctx)).ok).toBe(true);
          expect((await bridge.send({ to: ['orchestrator'], body: 'v-done' }, ctx)).ok).toBe(true);
        }
      }
    ];
    fake.scriptsByPersona.normal = [
      {
        mode: 'ok',
        reply: 'gossiped',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'gossip' }, ctx)).ok).toBe(true);
          gossipSent.resolve();
        }
      }
    ];
    fake.scriptsByPersona.secretary = [
      { mode: 'ok', reply: 's-reply', bridge: () => gossipSent.promise }
    ];
    await router.compose({
      to: ['orchestrator', 'verifier', 'secretary', 'normal'],
      subject: 'gossipy',
      body: 'go'
    });
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'assembled with gossip' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
    });
    const assembly = fake.starts.find(
      (s) => s.persona?.id === 'orchestrator' && s.input.includes('Replies to your delegations')
    )!;
    expect(assembly.input).toContain('v-done');
    expect(assembly.input).toContain('gossip');
    expect(assembly.input).toContain('not a delegation reply');
    // The gossip never started an orchestrator turn of its own.
    expect(fake.starts.filter((s) => s.persona?.id === 'orchestrator')).toHaveLength(2);
  });

  it('a branch that fans out itself assembles bottom-up', async () => {
    await savePersona({ id: 'w1', name: 'w1', prompt: '' });
    await savePersona({ id: 'w2', name: 'w2', prompt: '' });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'delegating',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['verifier', 'secretary'], body: 'piece' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'top assembled' }
    ];
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'delegating down',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['w1', 'w2'], body: 'subpiece' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'verifier assembled' }
    ];
    fake.scriptsByPersona.secretary = [{ mode: 'ok', reply: 's-reply' }];
    fake.scriptsByPersona.w1 = [{ mode: 'ok', reply: 'w1-reply' }];
    fake.scriptsByPersona.w2 = [{ mode: 'ok', reply: 'w2-reply' }];
    await router.compose({
      to: ['orchestrator', 'verifier', 'secretary', 'w1', 'w2'],
      subject: 'nested',
      body: 'go'
    });
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'top assembled' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).toBe('idle');
    });
    const inner = fake.starts.find(
      (s) => s.persona?.id === 'verifier' && s.input.includes('Replies to your delegations')
    )!;
    expect(inner.input).toContain('w1-reply');
    expect(inner.input).toContain('w2-reply');
    const outer = fake.starts.find(
      (s) => s.persona?.id === 'orchestrator' && s.input.includes('Replies to your delegations')
    )!;
    expect(outer.input).toContain('verifier assembled');
    expect(outer.input).toContain('s-reply');
  });

  it('two fan-outs in one turn widen the same join into one assembly', async () => {
    await savePersona({ id: 'w1', name: 'w1', prompt: '' });
    await savePersona({ id: 'w2', name: 'w2', prompt: '' });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'delegating twice',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['verifier', 'secretary'], body: 'piece a' }, ctx)).ok).toBe(true);
          expect((await bridge.send({ to: ['w1', 'w2'], body: 'piece b' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'one assembly' }
    ];
    fake.scriptsByPersona.verifier = [{ mode: 'ok', reply: 'v-reply' }];
    fake.scriptsByPersona.secretary = [{ mode: 'ok', reply: 's-reply' }];
    fake.scriptsByPersona.w1 = [{ mode: 'ok', reply: 'w1-reply' }];
    fake.scriptsByPersona.w2 = [{ mode: 'ok', reply: 'w2-reply' }];
    await router.compose({
      to: ['orchestrator', 'verifier', 'secretary', 'w1', 'w2'],
      subject: 'merged',
      body: 'go'
    });
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'one assembly' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).toBe('idle');
    });
    const assemblies = fake.starts.filter((s) => s.input.includes('Replies to your delegations'));
    expect(assemblies).toHaveLength(1);
    for (const body of ['v-reply', 's-reply', 'w1-reply', 'w2-reply']) {
      expect(assemblies[0].input).toContain(body);
    }
  });
});

describe('send budgets', () => {
  it('caps a persona’s own sends but never its reply to its initiator', async () => {
    await savePersona({ id: 'verifier', name: 'Verifier', prompt: 'v', sendBudget: 1 });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'consulting',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'check' }, ctx)).ok).toBe(true);
          const refused = await bridge.send({ to: ['secretary'], body: 'and you' }, ctx);
          expect(refused.ok).toBe(false);
          if (!refused.ok) expect(refused.error).toContain('budget');
        }
      },
      // Budget spent — the implicit reply back to the orchestrator still flows.
      { mode: 'ok', reply: 'exempt reply' },
      { mode: 'ok', reply: 'fresh window' }
    ];
    fake.scriptsByPersona.orchestrator = [
      { mode: 'ok', reply: 'verdict' },
      {
        mode: 'ok',
        reply: 'closing',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'done' }, ctx)).ok).toBe(true);
        }
      }
    ];
    const { conversations } = await router.compose({
      to: ['verifier', 'orchestrator', 'secretary'],
      subject: 'budget',
      body: 'go'
    });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'done' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    expect(
      mail.items.some(
        (i) => i.from === 'verifier' && i.to.includes('orchestrator') && i.body === 'exempt reply'
      )
    ).toBe(true);
    // Only the initiated send counted — the exempt reply spent nothing.
    expect(mail.conversations[0].sendCounts).toEqual({ verifier: 1 });

    // A user reply opens a fresh window: the counts reset.
    await router.reply(conversations[0].id, 'again');
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'fresh window')).toBe(true);
      expect(m.conversations[0].status).toBe('idle');
      expect(m.conversations[0].sendCounts).toEqual({});
    });
  });
});

describe('persona management from the bridge', () => {
  it('save_persona creates with createdBy, drops smuggled fields, and edits only its own', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'staffed',
        bridge: async (bridge, ctx) => {
          const smuggled = {
            name: 'helper',
            prompt: 'dig',
            harness: { agent: 'claude', cwd: '/' },
            canManagePersonas: true,
            sendBudget: 99
          } as SavePersonaRequest;
          expect((await bridge.savePersona(smuggled, ctx)).ok).toBe(true);
          // Edit its own creation, resolved by name.
          expect((await bridge.savePersona({ id: 'helper', prompt: 'dig deeper' }, ctx)).ok).toBe(true);
          const notOwn = await bridge.savePersona({ id: 'verifier', prompt: 'hijack' }, ctx);
          expect(notOwn.ok).toBe(false);
          if (!notOwn.ok) expect(notOwn.error).toContain('you created');
          expect((await bridge.send({ to: ['user'], body: 'staffed up' }, ctx)).ok).toBe(true);
        }
      }
    ];
    await router.compose({ to: ['orchestrator'], subject: 'staffing', body: 'go' });
    await settledMail();
    const helper = (await listPersonas()).find((p) => p.name === 'helper')!;
    expect(helper).toMatchObject({ prompt: 'dig deeper', createdBy: 'orchestrator' });
    expect(helper.harness).toBeUndefined();
    expect(helper.canManagePersonas).toBeUndefined();
    expect(helper.sendBudget).toBeUndefined();
  });

  it('both ops are gated by the manage-personas capability', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'powerless',
        bridge: async (bridge, ctx) => {
          const save = await bridge.savePersona({ name: 'rogue', prompt: '' }, ctx);
          expect(save.ok).toBe(false);
          if (!save.ok) expect(save.error).toContain('capability');
          const del = await bridge.deletePersona('normal', ctx);
          expect(del.ok).toBe(false);
          if (!del.ok) expect(del.error).toContain('capability');
        }
      }
    ];
    await router.compose({ to: ['verifier'], subject: 'gated', body: 'go' });
    await settledMail();
    expect((await listPersonas()).some((p) => p.name === 'rogue')).toBe(false);
  });

  it('delete_persona is scoped to own creations and refused while the target works', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'staffing',
        bridge: async (bridge, ctx) => {
          const notOwn = await bridge.deletePersona('verifier', ctx);
          expect(notOwn.ok).toBe(false);
          if (!notOwn.ok) expect(notOwn.error).toContain('you created');
          expect((await bridge.savePersona({ name: 'helper2', prompt: '' }, ctx)).ok).toBe(true);
          expect((await bridge.addPersona('helper2', ctx)).ok).toBe(true);
          const helperId = (await listPersonas()).find((p) => p.name === 'helper2')!.id;
          expect((await bridge.send({ to: [helperId], body: 'work' }, ctx)).ok).toBe(true);
          // In flight (the delivery just queued): the delete must refuse.
          const busy = await bridge.deletePersona('helper2', ctx);
          expect(busy.ok).toBe(false);
          if (!busy.ok) expect(busy.error).toContain('in flight');
        }
      },
      // helper2's implicit reply comes back — now the cleanup succeeds.
      {
        mode: 'ok',
        reply: 'cleanup',
        bridge: async (bridge, ctx) => {
          expect((await bridge.deletePersona('helper2', ctx)).ok).toBe(true);
          expect((await bridge.send({ to: ['user'], body: 'cleaned up' }, ctx)).ok).toBe(true);
        }
      }
    ];
    await router.compose({ to: ['orchestrator'], subject: 'lifecycle', body: 'go' });
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'cleaned up')).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
    });
    expect((await listPersonas()).some((p) => p.name === 'helper2')).toBe(false);
  });
});

// With the worker pool, process/exit events are attributed: their params carry
// the threadId of the turn the dying child held (null when it sat idle). The
// regression this pins: an idle extra worker's routine retirement mid-delivery
// used to fail the delivery — the user got "run failed: the backend process
// exited" while the real reply, completed minutes later, was silently dropped.
describe('mail delivery vs pool worker exits', () => {
  const exitEvent = (params: Record<string, unknown>) => ({
    method: 'process/exit',
    params,
    receivedAt: Date.now()
  });

  it("survives another worker's exit and an idle worker's retirement mid-turn", async () => {
    const fake = fakeBackend();
    fake.script = {
      mode: 'ok',
      reply: 'the real reply',
      bridge: async () => {
        // Mid-turn: a DIFFERENT worker dies carrying its own thread, and an
        // idle extra worker is reaped (attributed, null thread).
        fake.backend.emit('event', exitEvent({ code: 1, signal: null, threadId: 'someone-elses-thread' }));
        fake.backend.emit('event', exitEvent({ code: 0, signal: null, threadId: null }));
      }
    };
    const router = makeRouter(fake);
    await router.compose({ to: ['verifier'], subject: 's', body: 'q' });
    const mail = await settledMail();
    expect(mail.items[1].body).toBe('the real reply');
    expect(mail.conversations[0].status).toBe('idle');
  });

  it('fails promptly when the worker carrying THIS delivery dies', async () => {
    const fake = fakeBackend();
    fake.script = {
      mode: 'ok',
      reply: 'never mailed',
      bridge: async () => {
        // thread-1 is the thread this delivery's turn runs on (first startTurn).
        fake.backend.emit('event', exitEvent({ code: 1, signal: null, threadId: 'thread-1' }));
      }
    };
    const router = makeRouter(fake);
    await router.compose({ to: ['verifier'], subject: 's', body: 'q' });
    const mail = await settledMail();
    expect(mail.items[1].body).toBe("The persona's run failed: the backend process exited");
    expect(mail.conversations[0].status).toBe('awaiting-user');
  });

  it('an unattributed exit (older backend) still fails conservatively', async () => {
    const fake = fakeBackend();
    fake.script = {
      mode: 'ok',
      reply: 'never mailed',
      bridge: async () => {
        fake.backend.emit('event', exitEvent({ code: 1, signal: null }));
      }
    };
    const router = makeRouter(fake);
    await router.compose({ to: ['verifier'], subject: 's', body: 'q' });
    const mail = await settledMail();
    expect(mail.items[1].body).toBe("The persona's run failed: the backend process exited");
  });
});
