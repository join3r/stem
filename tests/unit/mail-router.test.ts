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
import {
  appendMailItem,
  createConversation,
  readMail,
  setConversationSession,
  setConversationStatus
} from '../../src/server/workspace/mail';
import { listPersonas, savePersona, savePersonaFor } from '../../src/server/workspace/personas';
import { listPersonaNotes, savePersonaNote } from '../../src/server/workspace/persona-memory';
import { updateMailSettings } from '../../src/server/workspace/settings';
import {
  mailDeviceQueuePath,
  mailStorePath,
  personaMemoryDir,
  personasStorePath,
  settingsStorePath
} from '../../src/server/workspace/paths';
import { queueMailForDevice, queuedMailConversationIds } from '../../src/server/workspace/mail-device-queue';
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
const deviceQueuePath = mailDeviceQueuePath();

beforeEach(() => {
  mkdirSync(dirname(mailPath), { recursive: true });
  rmSync(mailPath, { force: true });
  rmSync(personasPath, { force: true });
  rmSync(settingsPath, { force: true });
  rmSync(deviceQueuePath, { force: true });
  resetActivity();
});
afterEach(() => {
  rmSync(mailPath, { force: true });
  rmSync(personasPath, { force: true });
  rmSync(settingsPath, { force: true });
  rmSync(deviceQueuePath, { force: true });
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
    interruptTurn: async (turnId: string) => {
      // Mirrors the real backend closely enough for stop/timeout tests: the
      // interrupted turn settles as aborted.
      emitter.emit('event', {
        method: 'turn/aborted',
        params: { turn: { id: turnId } },
        receivedAt: Date.now()
      });
    }
  });
  return fake;
}

/** Wire a router the way index.ts does: bridge attached at construction. */
function makeRouter(
  fake: FakeBackend,
  onChange: () => void = () => undefined,
  codingDevice?: (deviceRef: string) => Promise<{ deviceId: string; label: string; online: boolean } | null>
): MailRouter {
  const router = new MailRouter({ runtime: fake.backend, onChange, ...(codingDevice ? { codingDevice } : {}) });
  fake.backend.setMailBridge({
    send: (req, ctx) => router.bridgeSend(req, ctx),
    addPersona: (personaId, ctx) => router.bridgeAddPersona(personaId, ctx),
    savePersona: (req, ctx) => router.bridgeSavePersona(req, ctx),
    deletePersona: (personaId, ctx) => router.bridgeDeletePersona(personaId, ctx),
    rememberNote: (req, ctx) => router.bridgeRememberNote(req, ctx),
    readNotes: (ids, ctx) => router.bridgeReadNotes(ids, ctx)
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
    // Mid-wave: one running row, named by the conversation's subject and
    // carrying the conversation id — the popover's open/stop controls need it.
    const running = midRun!.running.find((e) => e.kind === 'mail.deliver');
    expect(running?.label).toBe('Mail: Shoes');
    expect(running?.detail).toContain('Verifier working · turn 1');
    expect(running?.conversationId).toBe((await readMail()).conversations[0].id);
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

  it("a persona's model and effort pins ride its delivery turns", async () => {
    const fake = fakeBackend();
    await savePersona({ id: 'pinned', name: 'Pinned', prompt: 'p', model: 'acme/fast-1', effort: 'high' });
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    await router.compose({ to: ['pinned'], subject: 's', body: 'q' });
    await settledMail();
    expect(fake.starts[0].model).toBe('acme/fast-1');
    expect(fake.starts[0].effort).toBe('high');
    // An unpinned persona leaves both unset — the app default decides.
    const fake2 = fakeBackend();
    const router2 = new MailRouter({ runtime: fake2.backend, onChange: () => undefined });
    await router2.compose({ to: ['verifier'], subject: 's2', body: 'q' });
    await vi.waitFor(async () => {
      expect(fake2.starts).toHaveLength(1);
      expect((await readMail()).conversations.every((c) => c.status !== 'working')).toBe(true);
    });
    expect(fake2.starts[0].model).toBeUndefined();
    expect(fake2.starts[0].effort).toBeUndefined();
  });

  it("attachments ride the user's delivery turn; chain hops carry none", async () => {
    // 1x1 transparent PNG.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const atts = [
      { name: 'shot.png', dataBase64: png, mime: 'image/png' },
      { name: 'notes.txt', dataBase64: Buffer.from('hello').toString('base64'), mime: 'text/plain' }
    ];
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scripts = [
      {
        mode: 'ok',
        reply: 'passing along',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'look' }, ctx)).ok).toBe(true);
        }
      },
      // Orchestrator answers plainly — the hop returns to the driver, which
      // ends the chain ON THE USER so no delivery outlives the test.
      { mode: 'ok', reply: 'seen' },
      {
        mode: 'ok',
        reply: 'wrapping',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'done' }, ctx)).ok).toBe(true);
        }
      }
    ];
    await router.compose({ to: ['verifier', 'orchestrator'], subject: 's', body: 'see attached', attachments: atts });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.to.includes('user') && i.body === 'done')).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });

    // The delivery turn carried the real attachments…
    expect(fake.starts[0].attachments).toEqual(atts);
    // …the chain hop to orchestrator did not…
    expect(fake.starts[1].persona?.id).toBe('orchestrator');
    expect(fake.starts[1].attachments).toBeUndefined();
    // …and the stored item shows them for display: an image preview + a chip.
    expect(mail.items[0].attachments).toEqual([
      { kind: 'image', name: 'shot.png', mime: 'image/png', dataUrl: `data:image/png;base64,${png}` },
      { kind: 'file', name: 'notes.txt', mime: 'text/plain' }
    ]);

    // A reply's attachments reach the driver's resumed turn too.
    fake.scripts = [{ mode: 'ok', reply: 'got the second file' }];
    await router.reply(mail.conversations[0].id, '', [atts[1]]);
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'got the second file')).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
    });
    const replyStart = fake.starts[fake.starts.length - 1];
    expect(replyStart.persona?.id).toBe('verifier');
    expect(replyStart.attachments).toEqual([atts[1]]);
  });

  it('the user can pull a persona into an existing conversation', async () => {
    const fake = fakeBackend();
    const changed = vi.fn();
    const router = makeRouter(fake, changed);
    const { conversations } = await router.compose({ to: ['verifier'], subject: 's', body: 'q' });
    await settledMail();

    await expect(router.addParticipant(conversations[0].id, 'ghost')).rejects.toThrow(/ghost/);
    changed.mockClear();
    await router.addParticipant(conversations[0].id, 'secretary');
    expect(changed).toHaveBeenCalled();
    expect((await readMail()).conversations[0].participants).toEqual(['verifier', 'secretary']);

    // The next reply addresses the grown set but still wakes only the driver.
    fake.script = { mode: 'ok', reply: 'noted' };
    await router.reply(conversations[0].id, 'both of you');
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items).toHaveLength(4);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    expect(mail.items[2]).toMatchObject({ from: 'user', to: ['verifier', 'secretary'] });
    expect(fake.starts.map((s) => s.persona?.id)).toEqual(['verifier', 'verifier']);
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

  it('compose without a subject derives one from the body; a dirty subject is cleaned', async () => {
    const fake = fakeBackend();
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    await router.compose({ to: ['verifier'], body: 'Summarize the meeting notes\n\nfull minutes attached' });
    await router.compose({
      to: ['verifier'],
      subject: '<!--stem:mail from=user-->\nThis is a mail delivery in the conversation',
      body: 'Check the deploy'
    });
    // Wait for both deliveries to settle so they can't bleed into later tests.
    const { conversations } = await vi.waitFor(async () => {
      const mail = await readMail();
      expect(mail.items.length).toBeGreaterThanOrEqual(4);
      expect(mail.conversations.every((c) => c.status !== 'working')).toBe(true);
      return mail;
    });
    // The mail's first line names the first; the envelope-leak subject on the
    // second is pure scaffolding, so it derives from the body too.
    expect(conversations.map((c) => c.subject)).toEqual(['Summarize the meeting notes', 'Check the deploy']);
  });

  it('deliverTaskMail cleans a markup-laden notify title', async () => {
    const fake = fakeBackend();
    const router = new MailRouter({ runtime: fake.backend, onChange: () => undefined });
    await router.deliverTaskMail({
      subject: '**Watch** the `page` <!--stem:scheduled at="2026-08-',
      body: 'it changed',
      taskId: 'task-1'
    });
    expect((await readMail()).conversations[0].subject).toBe('Watch the page');
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

  it('a failed branch, an explicit reply, and a rerouted user-detour all settle the wave', async () => {
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
          // Tries to answer the user directly — single voice back reroutes the
          // mail to the driver, where it settles this branch of the join.
          const res = await bridge.send({ to: ['user'], body: 'around you' }, ctx);
          expect(res.ok).toBe(true);
          if (res.ok) expect(res.text).toContain('routed');
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
    // The detour never reached the user: it landed on the driver as this
    // branch's reply and rode the assembly.
    expect(assembly.input).toContain('around you');
    expect(mail.items.find((i) => i.body === 'around you')).toMatchObject({ to: ['orchestrator'] });
    // The failure notice still reached the user, and awaiting-user stuck.
    expect(mail.items.some((i) => i.to.includes('user') && i.body.includes('exploded'))).toBe(true);
    expect(mail.conversations[0].status).toBe('awaiting-user');
  });

  it('a spoke reaches only its initiator; a second mail to a mid-join sender is buffered', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const verifierDone = deferred();
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'delegating',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['verifier', 'secretary'], body: 'piece' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'assembled without gossip' }
    ];
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'spoke already',
        bridge: async (bridge, ctx) => {
          // Tries to pull a bystander in — hub and spoke refuses the detour.
          const refused = await bridge.send({ to: ['normal'], body: 'psst' }, ctx);
          expect(refused.ok).toBe(false);
          if (!refused.ok) expect(refused.error).toContain('Only the driver');
          // Its explicit reply settles the branch…
          expect((await bridge.send({ to: ['orchestrator'], body: 'v-done' }, ctx)).ok).toBe(true);
          // …so a SECOND mail to the still-joining sender rides the assembly
          // as a labeled extra, never a turn of its own.
          expect((await bridge.send({ to: ['orchestrator'], body: 'ps: extra note' }, ctx)).ok).toBe(true);
          verifierDone.resolve();
        }
      }
    ];
    fake.scriptsByPersona.secretary = [
      { mode: 'ok', reply: 's-reply', bridge: () => verifierDone.promise }
    ];
    await router.compose({
      to: ['orchestrator', 'verifier', 'secretary', 'normal'],
      subject: 'gossipy',
      body: 'go'
    });
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'assembled without gossip' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
    });
    const assembly = fake.starts.find(
      (s) => s.persona?.id === 'orchestrator' && s.input.includes('Replies to your delegations')
    )!;
    expect(assembly.input).toContain('v-done');
    expect(assembly.input).toContain('ps: extra note');
    expect(assembly.input).toContain('not a delegation reply');
    // The bystander was never mailed, and the extra note never started an
    // orchestrator turn of its own.
    expect((await readMail()).items.some((i) => i.from !== 'user' && i.to.includes('normal'))).toBe(false);
    expect(fake.starts.filter((s) => s.persona?.id === 'orchestrator')).toHaveLength(2);
  });

  it("a spoke's own fan-out is refused; the driver runs the sub-work it asks for", async () => {
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
      // The assembly turn reads verifier's request and runs the wider fan-out
      // itself — sub-work always briefed from ONE place, never twice.
      {
        mode: 'ok',
        reply: 'delegating down',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['w1', 'w2'], body: 'subpiece' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'top assembled' }
    ];
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'need w1 and w2 for this',
        bridge: async (bridge, ctx) => {
          const refused = await bridge.send({ to: ['w1', 'w2'], body: 'subpiece' }, ctx);
          expect(refused.ok).toBe(false);
          if (!refused.ok) expect(refused.error).toContain('Only the driver');
        }
      }
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
    const assemblies = fake.starts.filter((s) => s.input.includes('Replies to your delegations'));
    expect(assemblies.map((s) => s.persona?.id)).toEqual(['orchestrator', 'orchestrator']);
    expect(assemblies[0].input).toContain('need w1 and w2 for this');
    expect(assemblies[0].input).toContain('s-reply');
    expect(assemblies[1].input).toContain('w1-reply');
    expect(assemblies[1].input).toContain('w2-reply');
    // Each worker was briefed exactly once, by the driver alone.
    const mail = await readMail();
    expect(mail.items.filter((i) => i.from !== 'user' && i.to.includes('w1'))).toHaveLength(1);
    expect(mail.items.filter((i) => i.from !== 'user' && i.to.includes('w2'))).toHaveLength(1);
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

describe('single voice back', () => {
  it("a non-driver's mail to the user is rerouted to the driver", async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'consulting',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'check this' }, ctx)).ok).toBe(true);
        }
      },
      // The rerouted mail arrives here; the driver answers the user once.
      {
        mode: 'ok',
        reply: 'folding in',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'the one answer' }, ctx)).ok).toBe(true);
        }
      }
    ];
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'went around',
        bridge: async (bridge, ctx) => {
          const res = await bridge.send({ to: ['user'], body: 'my direct answer' }, ctx);
          expect(res.ok).toBe(true);
          if (res.ok) expect(res.text).toContain('routed');
        }
      }
    ];
    await router.compose({ to: ['verifier', 'orchestrator'], subject: 'one voice', body: 'q' });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'the one answer' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    // The detour became driver material — the user heard exactly one voice.
    expect(mail.items.find((i) => i.body === 'my direct answer')).toMatchObject({
      from: 'orchestrator',
      to: ['verifier']
    });
    expect(mail.items.filter((i) => i.to.includes('user'))).toHaveLength(1);
  });

  it('the reroute yields to the exchange cap: the send still reaches the user', async () => {
    await updateMailSettings({ exchangeCap: 1 });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'consulting',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'check' }, ctx)).ok).toBe(true);
        }
      }
    ];
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'capped out',
        bridge: async (bridge, ctx) => {
          // The cap is spent, so rerouting to the driver would overflow it —
          // the runaway safety valve lets the mail land on the user instead.
          expect((await bridge.send({ to: ['user'], body: 'straight to you' }, ctx)).ok).toBe(true);
        }
      }
    ];
    await router.compose({ to: ['verifier', 'orchestrator'], subject: 'capped', body: 'q' });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'straight to you')).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    expect(mail.items.find((i) => i.body === 'straight to you')).toMatchObject({
      from: 'orchestrator',
      to: ['user']
    });
  });
});

describe('hub and spoke', () => {
  it('a spoke may mail the user and its initiator, never a third persona', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'delegating',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'check this' }, ctx)).ok).toBe(true);
        }
      },
      // The rerouted user-detour and the explicit reply both land here; the
      // driver closes on the user so nothing outlives the test.
      {
        mode: 'ok',
        reply: 'closing',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'done' }, ctx)).ok).toBe(true);
        }
      }
    ];
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'worked',
        bridge: async (bridge, ctx) => {
          // A third participant is out of reach for a spoke…
          const refused = await bridge.send({ to: ['secretary'], body: 'psst' }, ctx);
          expect(refused.ok).toBe(false);
          if (!refused.ok) {
            expect(refused.error).toContain('Only the driver (verifier)');
            expect(refused.error).toContain('secretary');
          }
          // …while its initiator is not (the user path is covered by the
          // single-voice reroute tests).
          expect((await bridge.send({ to: ['verifier'], body: 'for my initiator' }, ctx)).ok).toBe(true);
        }
      }
    ];
    await router.compose({
      to: ['verifier', 'orchestrator', 'secretary'],
      subject: 'spokes',
      body: 'go'
    });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'done' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    expect(mail.items.some((i) => i.from !== 'user' && i.to.includes('secretary'))).toBe(false);
    expect(mail.items.find((i) => i.body === 'for my initiator')).toMatchObject({ to: ['verifier'] });
    expect(fake.starts.filter((s) => s.persona?.id === 'secretary')).toHaveLength(0);
  });
});

describe('stale replies', () => {
  it('a reply landing after a newer user mail is stamped stale; the fresh one is not', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const hold = deferred();
    fake.scriptsByPersona.verifier = [
      { mode: 'ok', reply: 'slow answer', bridge: () => hold.promise },
      { mode: 'ok', reply: 'fresh answer' }
    ];
    const { conversations } = await router.compose({ to: ['verifier'], subject: 's', body: 'first' });
    await vi.waitFor(() => expect(fake.starts.length).toBe(1));
    // The user moves on while the first delivery is still running. The work is
    // NOT aborted — its reply lands, marked as answering the earlier mail.
    await router.reply(conversations[0].id, 'second');
    hold.resolve();
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.filter((i) => i.to.includes('user'))).toHaveLength(2);
      expect(m.conversations[0].status).toBe('idle');
      return m;
    });
    expect(mail.items.find((i) => i.body === 'slow answer')?.stale).toBe(true);
    expect(mail.items.find((i) => i.body === 'fresh answer')?.stale).toBeUndefined();
  });
});

describe('stop control', () => {
  it('stops a working conversation: queued dropped, turns aborted, no failure notice', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const hold = deferred();
    fake.scriptsByPersona.verifier = [
      { mode: 'ok', reply: 'never lands', bridge: () => hold.promise },
      { mode: 'ok', reply: 'must never run' }
    ];
    const { conversations } = await router.compose({ to: ['verifier'], subject: 's', body: 'go' });
    const id = conversations[0].id;
    await vi.waitFor(async () => {
      expect(fake.starts).toHaveLength(1);
      // The live working status is visible while the delivery runs (the store
      // no longer erases it on unrelated round-trips).
      expect((await readMail()).conversations[0].status).toBe('working');
    });
    // A second user mail queues behind the held turn (same-persona serial)…
    await router.reply(id, 'and this');
    // …and the stop drops it before it ever runs, aborting the held turn.
    expect(await router.stopConversation(id)).toEqual({ stopped: true });
    // The stop settles as 'aborted' — the Inbox row is where the stop shows,
    // since no failure mail is written to say it.
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.conversations[0].status).toBe('aborted');
      return m;
    });
    // …and the activity row's history entry says so too.
    const done = snapshot().history.find((e) => e.kind === 'mail.deliver');
    expect(done?.detail).toBe('stopped after 1 turn');
    // Only the two user mails are on the record: the aborted turn produced no
    // "run failed" notice — the stop IS the outcome the user asked for.
    expect(mail.items.map((i) => ({ from: i.from, body: i.body }))).toEqual([
      { from: 'user', body: 'go' },
      { from: 'user', body: 'and this' }
    ]);
    expect(fake.starts).toHaveLength(1);
    hold.resolve();
  });

  it('answers stopped: false when nothing is in flight', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scripts = [{ mode: 'ok', reply: 'done' }];
    const { conversations } = await router.compose({ to: ['verifier'], subject: 's', body: 'q' });
    await settledMail();
    expect(await router.stopConversation(conversations[0].id)).toEqual({ stopped: false });
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
      // The driver ends the chain ON THE USER so no delivery outlives the test.
      {
        mode: 'ok',
        reply: 'closing',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'done' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'fresh window' }
    ];
    fake.scriptsByPersona.orchestrator = [
      { mode: 'ok', reply: 'verdict' },
      { mode: 'ok', reply: 'noted' }
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

// Source-aware delegation: every delivery inherits the ID of the user mail
// that began its wave, and a delivery to a NON-driver persona carries that
// mail's exact body as `mail.source` — model context, never a MailItem. The
// driver never gets the injection (its wave began with the user mail itself),
// and the stored internal mail stays the short assignment.
describe('source-aware delegation', () => {
  it('a spoke delivery quotes the exact user mail as source; the stored item stays the short assignment', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'consulting',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'check the facts' }, ctx)).ok).toBe(true);
        }
      },
      // The hop back at the driver: close ON THE USER so nothing outlives the test.
      {
        mode: 'ok',
        reply: 'closing',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'answered' }, ctx)).ok).toBe(true);
        }
      }
    ];
    fake.scriptsByPersona.orchestrator = [{ mode: 'ok', reply: 'facts hold' }];
    await router.compose({
      to: ['verifier', 'orchestrator'],
      subject: 'src',
      body: 'is the sky green today?'
    });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'answered' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    // The driver's initial delivery IS the user mail: no source injection, and
    // the body arrives exactly once.
    expect(fake.starts[0].persona?.id).toBe('verifier');
    expect(fake.starts[0].mail?.source).toBeUndefined();
    expect(fake.starts[0].input).toBe('is the sky green today?');
    // The spoke's turn carries the exact user item as source, and ONLY the
    // short assignment as its input — the driver never restated anything.
    const spoke = fake.starts[1];
    expect(spoke.persona?.id).toBe('orchestrator');
    expect(spoke.mail?.source).toEqual({ itemId: mail.items[0].id, body: 'is the sky green today?' });
    expect(spoke.input).toBe('check the facts');
    // …and the stored internal mail is exactly the assignment: the source body
    // was never appended to the persisted correspondence.
    expect(mail.items[1]).toMatchObject({ from: 'verifier', to: ['orchestrator'], body: 'check the facts' });
  });

  it('every fan-out branch carries the same source; the assembly (to the driver) carries none', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.orchestrator = [
      {
        mode: 'ok',
        reply: 'delegating',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['verifier', 'secretary'], body: 'your piece' }, ctx)).ok).toBe(true);
        }
      },
      { mode: 'ok', reply: 'assembled' }
    ];
    fake.scriptsByPersona.verifier = [{ mode: 'ok', reply: 'v-reply' }];
    fake.scriptsByPersona.secretary = [{ mode: 'ok', reply: 's-reply' }];
    await router.compose({
      to: ['orchestrator', 'verifier', 'secretary'],
      subject: 'fan',
      body: 'the question'
    });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'assembled' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).toBe('idle');
      return m;
    });
    const branches = fake.starts.filter((s) => s.persona?.id !== 'orchestrator');
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.mail?.source).toEqual({ itemId: mail.items[0].id, body: 'the question' });
      expect(branch.input).toBe('your piece');
    }
    // Still exactly one assembly, back at the driver — which already read the
    // user mail as its own first delivery, so no source rides it.
    const assemblies = fake.starts.filter((s) => s.input.includes('Replies to your delegations'));
    expect(assemblies).toHaveLength(1);
    expect(assemblies[0].persona?.id).toBe('orchestrator');
    expect(assemblies[0].mail?.source).toBeUndefined();
  });

  it('a user reply starts a new wave: its deliveries carry the new item, not the history', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const consult: TurnScript = {
      mode: 'ok',
      reply: 'consulting',
      bridge: async (bridge, ctx) => {
        expect((await bridge.send({ to: ['orchestrator'], body: 'verify' }, ctx)).ok).toBe(true);
      }
    };
    const close: TurnScript = {
      mode: 'ok',
      reply: 'closing',
      bridge: async (bridge, ctx) => {
        expect((await bridge.send({ to: ['user'], body: 'done' }, ctx)).ok).toBe(true);
      }
    };
    fake.scriptsByPersona.verifier = [consult, close, consult, close];
    fake.scriptsByPersona.orchestrator = [
      { mode: 'ok', reply: 'ok one' },
      { mode: 'ok', reply: 'ok two' }
    ];
    const { conversations } = await router.compose({
      to: ['verifier', 'orchestrator'],
      subject: 'waves',
      body: 'first question'
    });
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.filter((i) => i.body === 'done')).toHaveLength(1);
      expect(m.conversations[0].status).not.toBe('working');
    });
    await router.reply(conversations[0].id, 'second question');
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.filter((i) => i.body === 'done')).toHaveLength(2);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    const second = mail.items.find((i) => i.from === 'user' && i.body === 'second question')!;
    const spokes = fake.starts.filter((s) => s.persona?.id === 'orchestrator');
    expect(spokes).toHaveLength(2);
    // The second wave's delegation quotes the second user mail — bounded
    // context, never the conversation's history.
    expect(spokes[1].mail?.source).toEqual({ itemId: second.id, body: 'second question' });
    expect(spokes[1].input).toBe('verify');
  });

  it('a late send from a superseded wave keeps ITS user item, not the newest one', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const userReplied = deferred();
    fake.scriptsByPersona.verifier = [
      // Wave 1's driver turn, held open until the user has already moved on —
      // its delegation must still carry wave 1's source item.
      {
        mode: 'ok',
        reply: 'slow delegating',
        bridge: async (bridge, ctx) => {
          await userReplied.promise;
          expect((await bridge.send({ to: ['orchestrator'], body: 'late piece' }, ctx)).ok).toBe(true);
        }
      },
      // Wave 2's user delivery (queued behind the held turn, same-persona serial).
      {
        mode: 'ok',
        reply: 'closing two',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'second answered' }, ctx)).ok).toBe(true);
        }
      },
      // The late hop back from wave 1: end it on the user.
      {
        mode: 'ok',
        reply: 'closing one',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'late done' }, ctx)).ok).toBe(true);
        }
      }
    ];
    fake.scriptsByPersona.orchestrator = [{ mode: 'ok', reply: 'late reply' }];
    const { conversations } = await router.compose({
      to: ['verifier', 'orchestrator'],
      subject: 'supersede',
      body: 'first question'
    });
    await vi.waitFor(() => expect(fake.starts.length).toBe(1));
    await router.reply(conversations[0].id, 'second question');
    userReplied.resolve();
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'second answered')).toBe(true);
      expect(m.items.some((i) => i.body === 'late done')).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    const first = mail.items.find((i) => i.from === 'user' && i.body === 'first question')!;
    // The held turn's live entry won over the newest-user-item fallback.
    const spoke = fake.starts.find((s) => s.persona?.id === 'orchestrator')!;
    expect(spoke.mail?.source).toEqual({ itemId: first.id, body: 'first question' });
    // And the wave identities kept their stale semantics: wave 1's late answer
    // is stamped, wave 2's fresh one is not.
    expect(mail.items.find((i) => i.body === 'late done')?.stale).toBe(true);
    expect(mail.items.find((i) => i.body === 'second answered')?.stale).toBeUndefined();
  });

  it('chained hops retain the source; the hop back to the driver re-injects nothing', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'first consult',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'piece one' }, ctx)).ok).toBe(true);
        }
      },
      // The hop back (from orchestrator) delegates onward in the same wave.
      {
        mode: 'ok',
        reply: 'second consult',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['secretary'], body: 'piece two' }, ctx)).ok).toBe(true);
        }
      },
      {
        mode: 'ok',
        reply: 'closing',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'all done' }, ctx)).ok).toBe(true);
        }
      }
    ];
    fake.scriptsByPersona.orchestrator = [{ mode: 'ok', reply: 'o-result' }];
    fake.scriptsByPersona.secretary = [{ mode: 'ok', reply: 's-result' }];
    await router.compose({
      to: ['verifier', 'orchestrator', 'secretary'],
      subject: 'chained',
      body: 'the original ask'
    });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'all done' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    // A delegation two hops into the wave still quotes the original user item.
    const late = fake.starts.find((s) => s.persona?.id === 'secretary')!;
    expect(late.mail?.source).toEqual({ itemId: mail.items[0].id, body: 'the original ask' });
    // The driver's hop-back delivery (the implicit reply landing on it) gets no
    // injection: its thread already opened with the user mail.
    const hopBack = fake.starts.find((s) => s.persona?.id === 'verifier' && s.input === 'o-result')!;
    expect(hopBack.mail?.source).toBeUndefined();
  });

  it('a source mail with attachments delegates cleanly: names ride as metadata, bytes do not', async () => {
    // 1x1 transparent PNG.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const atts = [
      { name: 'shot.png', dataBase64: png, mime: 'image/png' },
      { name: 'notes.txt', dataBase64: Buffer.from('hello').toString('base64'), mime: 'text/plain' }
    ];
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.scriptsByPersona.verifier = [
      {
        mode: 'ok',
        reply: 'delegating',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['orchestrator'], body: 'inspect' }, ctx)).ok).toBe(true);
        }
      },
      {
        mode: 'ok',
        reply: 'closing',
        bridge: async (bridge, ctx) => {
          expect((await bridge.send({ to: ['user'], body: 'inspected' }, ctx)).ok).toBe(true);
        }
      }
    ];
    fake.scriptsByPersona.orchestrator = [{ mode: 'ok', reply: 'looks fine' }];
    await router.compose({
      to: ['verifier', 'orchestrator'],
      subject: 'attached',
      body: 'see attached',
      attachments: atts
    });
    const mail = await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items.some((i) => i.body === 'inspected' && i.to.includes('user'))).toBe(true);
      expect(m.conversations[0].status).not.toBe('working');
      return m;
    });
    // The spoke learns the source mail HAD attachments by name — the bytes
    // themselves still ride only the original user delivery.
    const spoke = fake.starts.find((s) => s.persona?.id === 'orchestrator')!;
    expect(spoke.mail?.source).toEqual({
      itemId: mail.items[0].id,
      body: 'see attached',
      attachmentNames: ['shot.png', 'notes.txt']
    });
    expect(spoke.attachments).toBeUndefined();
    expect(fake.starts[0].attachments).toEqual(atts);
  });
});

describe('persona memory', () => {
  beforeEach(() => {
    rmSync(personaMemoryDir(), { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(personaMemoryDir(), { recursive: true, force: true });
  });

  it('a delivery to a persona with a store carries its note index (empty store included)', async () => {
    const saved = await savePersonaNote('verifier', { title: 'A lesson', body: 'the lesson' }, 'user');
    const fake = fakeBackend();
    const router = makeRouter(fake);
    await router.compose({ to: ['verifier'], subject: 's', body: 'q' });
    await settledMail();
    expect(fake.starts[0].persona?.notes).toEqual([{ id: saved.id, title: 'A lesson' }]);

    // A store that exists but is empty still rides as [] — presence is what
    // tells the preamble to pitch remember_note.
    fake.starts.length = 0;
    await router.compose({ to: ['secretary'], subject: 's2', body: 'q2' });
    await vi.waitFor(async () => {
      expect(fake.starts.length).toBeGreaterThan(0);
    });
    expect(fake.starts[0].persona?.notes).toEqual([]);
  });

  it('remember_note writes into the CALLER’s store with source tool', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    fake.script = {
      mode: 'ok',
      reply: 'done',
      bridge: async (bridge, ctx) => {
        const res = await bridge.rememberNote({ title: 'Gotcha', body: 'clocks are UTC' }, ctx);
        expect(res.ok).toBe(true);
      }
    };
    await router.compose({ to: ['verifier'], subject: 's', body: 'q' });
    await settledMail();
    const notes = await listPersonaNotes('verifier');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: 'Gotcha', body: 'clocks are UTC', source: 'tool' });
  });

  it('an agent-created helper is refused remember_note and told where lessons go instead', async () => {
    const helper = await savePersonaFor('orchestrator', { name: 'researcher-1', prompt: 'r' });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const refusals: string[] = [];
    fake.script = {
      mode: 'ok',
      reply: 'done',
      bridge: async (bridge, ctx) => {
        const res = await bridge.rememberNote({ body: 'a lesson' }, ctx);
        if (!res.ok) refusals.push(res.error);
      }
    };
    await router.compose({ to: [helper.id], subject: 's', body: 'q' });
    await settledMail();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('temporary helper');
    expect(await listPersonaNotes(helper.id)).toEqual([]);
  });

  it('a memory-off persona delivers without a note index and is refused both memory ops', async () => {
    await savePersona({ id: 'cold', name: 'cold', prompt: '', memory: false });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const refusals: string[] = [];
    fake.script = {
      mode: 'ok',
      reply: 'done',
      bridge: async (bridge, ctx) => {
        const res = await bridge.rememberNote({ body: 'a lesson' }, ctx);
        if (!res.ok) refusals.push(res.error);
        const read = await bridge.readNotes(['x'], ctx);
        expect(read.ok).toBe(false);
      }
    };
    await router.compose({ to: ['cold'], subject: 's', body: 'q' });
    await settledMail();
    expect(fake.starts[0].persona?.notes).toBeUndefined();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('keeps no private memory');
    expect(await listPersonaNotes('cold')).toEqual([]);
  });

  it('a private conversation runs every delivery as a private turn and never reflects', async () => {
    // verifier owns a memory, so an ordinary delivery would end in a reflection
    // pass (runtime.complete). Private: the flag rides every startTurn, and the
    // persona's notes are left alone — a lesson from the thread would be a
    // memory of it by another name.
    const fake = fakeBackend();
    const complete = vi.fn(async () => 'NOTHING');
    Object.assign(fake.backend, { complete });
    const router = makeRouter(fake);
    await router.compose({ to: ['verifier'], subject: 's', body: 'q', private: true });
    const mail = await settledMail();
    expect(mail.conversations[0].private).toBe(true);
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0].private).toBe(true);
    expect(fake.starts[0].persona?.notes).toBeDefined();
    // The reply continues the same private conversation: the flag rides again.
    fake.script = { mode: 'ok', reply: 'second answer' };
    await router.reply(mail.conversations[0].id, 'and this?');
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items).toHaveLength(4);
      expect(m.conversations[0].status).toBe('idle');
    });
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1].private).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    // An ordinary compose carries no flag at all.
    await router.compose({ to: ['verifier'], subject: 's2', body: 'q2' });
    await vi.waitFor(async () => {
      const m = await readMail();
      expect(m.items).toHaveLength(6);
      expect(m.conversations.every((c) => c.status === 'idle')).toBe(true);
    });
    expect(fake.starts[2].private).toBeUndefined();
  });

  it('the built-in Critic ships memoryless: no index rides its deliveries', async () => {
    const fake = fakeBackend();
    const router = makeRouter(fake);
    await router.compose({ to: ['critic'], subject: 's', body: 'judge this' });
    await settledMail();
    expect(fake.starts[0].persona?.id).toBe('critic');
    expect(fake.starts[0].persona?.notes).toBeUndefined();
  });

  it('read_notes fetches full bodies by id and names the ids it could not find', async () => {
    const saved = await savePersonaNote('verifier', { title: 'T', body: 'the full body' }, 'user');
    const fake = fakeBackend();
    const router = makeRouter(fake);
    const results: string[] = [];
    fake.script = {
      mode: 'ok',
      reply: 'done',
      bridge: async (bridge, ctx) => {
        const ok = await bridge.readNotes([saved.id, 'missing'], ctx);
        if (ok.ok) results.push(ok.text);
        const none = await bridge.readNotes(['missing'], ctx);
        expect(none.ok).toBe(false);
      }
    };
    await router.compose({ to: ['verifier'], subject: 's', body: 'q' });
    await settledMail();
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('the full body');
    expect(results[0]).toContain('No such note: missing');
  });
});

describe('repo lock', () => {
  it('deliveries pinned inside one repo tree run one at a time; a disjoint tree runs in parallel', async () => {
    await savePersona({
      id: 'coder-a',
      name: 'coder-a',
      prompt: '',
      harness: { agent: 'claude', cwd: '/nonexistent/repo' }
    });
    await savePersona({
      id: 'coder-b',
      name: 'coder-b',
      prompt: '',
      harness: { agent: 'claude', cwd: '/nonexistent/repo/packages/x' }
    });
    await savePersona({
      id: 'coder-c',
      name: 'coder-c',
      prompt: '',
      harness: { agent: 'claude', cwd: '/nonexistent/elsewhere' }
    });
    const fake = fakeBackend();
    const router = makeRouter(fake);
    // coder-a's turn stays live until the gate opens — the bridge hook runs
    // before the fake settles the turn.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    fake.scriptsByPersona['coder-a'] = [{ mode: 'ok', reply: 'a done', bridge: () => gate }];
    await router.compose({ to: ['coder-a'], subject: 'a', body: 'work the repo' });
    await vi.waitFor(() => expect(fake.starts).toHaveLength(1));
    await router.compose({ to: ['coder-b'], subject: 'b', body: 'work a subdirectory' });
    await router.compose({ to: ['coder-c'], subject: 'c', body: 'work elsewhere' });
    // The disjoint tree starts immediately; the same-tree delivery waits.
    await vi.waitFor(() =>
      expect(fake.starts.map((s) => s.persona?.id).sort()).toEqual(['coder-a', 'coder-c'])
    );
    openGate();
    await vi.waitFor(async () => {
      expect(fake.starts.map((s) => s.persona?.id)).toContain('coder-b');
      const mail = await readMail();
      expect(mail.conversations).toHaveLength(3);
      expect(mail.conversations.every((c) => c.status !== 'working')).toBe(true);
    });
    // coder-b only ever started AFTER coder-a's turn settled.
    expect(fake.starts.map((s) => s.persona?.id).indexOf('coder-b')).toBe(2);
  });
});

describe('boot-time redelivery', () => {
  it('redelivers a user mail a restart dropped, resuming the persona thread', async () => {
    // The store exactly as a killed process leaves it: the user's item
    // appended, no reply, no failure notice, the hidden thread recorded —
    // the delivery died with the process, not as a run error.
    const conversation = await createConversation('dropped', ['verifier']);
    await appendMailItem({
      conversationId: conversation.id,
      from: 'user',
      to: ['verifier'],
      body: 'still there?'
    });
    await setConversationSession(conversation.id, 'verifier', 'thread-from-before');
    const fake = fakeBackend();
    fake.script = { mode: 'ok', reply: 'recovered answer' };
    const router = makeRouter(fake);
    expect(await router.recoverDroppedDeliveries()).toBe(1);
    const mail = await settledMail();
    expect(mail.items[1]).toMatchObject({ from: 'verifier', to: ['user'], body: 'recovered answer' });
    // The redelivery resumed the killed turn's thread — its work is context.
    expect(fake.starts[0].threadId).toBe('thread-from-before');
    // Answered now: the next pass (a later sign-in) has nothing to redeliver.
    expect(await router.recoverDroppedDeliveries()).toBe(0);
  });

  it('leaves answered and user-stopped conversations alone', async () => {
    const answered = await createConversation('answered', ['verifier']);
    await appendMailItem({ conversationId: answered.id, from: 'user', to: ['verifier'], body: 'q' });
    await appendMailItem({ conversationId: answered.id, from: 'verifier', to: ['user'], body: 'a' });
    const stopped = await createConversation('stopped', ['verifier']);
    await appendMailItem({ conversationId: stopped.id, from: 'user', to: ['verifier'], body: 'q' });
    await setConversationStatus(stopped.id, 'aborted');
    const fake = fakeBackend();
    const router = makeRouter(fake);
    expect(await router.recoverDroppedDeliveries()).toBe(0);
    expect(fake.starts).toHaveLength(0);
  });
});

describe('device-pinned code personas (offline hold)', () => {
  const offline = { deviceId: 'dev-1', label: 'MacBook', online: false };
  const online = { deviceId: 'dev-1', label: 'MacBook', online: true };

  async function saveMacCoder(): Promise<void> {
    await savePersona({
      id: 'mac-coder',
      name: 'mac-coder',
      prompt: '',
      harness: { agent: 'claude', cwd: '/repo', device: 'dev-1' }
    });
  }

  it('holds a user mail while the pinned computer is offline, then delivers on flush', async () => {
    await saveMacCoder();
    const fake = fakeBackend();
    let device = offline;
    const router = makeRouter(fake, undefined, async () => device);
    await router.compose({ to: ['mac-coder'], subject: 'build', body: 'build it' });
    const held = await settledMail();
    // No turn ran; the notice mail is what the user sees instead.
    expect(fake.starts).toHaveLength(0);
    expect(held.conversations[0].status).toBe('awaiting-user');
    expect(held.items[1].from).toBe('mac-coder');
    expect(held.items[1].body).toContain('MacBook');
    expect(held.items[1].body).toContain('queued');
    expect(await queuedMailConversationIds()).toEqual(new Set([held.conversations[0].id]));
    // The device announces itself: the wait flushes into a real delivery.
    device = online;
    fake.script = { mode: 'ok', reply: 'built' };
    expect(await router.flushDeviceQueue('dev-1')).toBe(1);
    await vi.waitFor(async () => {
      const after = await readMail();
      expect(after.items.map((i) => i.body)).toContain('built');
      expect(after.conversations[0].status).toBe('idle');
    });
    expect(fake.starts[0].input).toBe('build it');
    // The wait was consumed — a second announce delivers nothing.
    expect(await router.flushDeviceQueue('dev-1')).toBe(0);
  });

  it('a stop while waiting drops the wait — the device coming back delivers nothing', async () => {
    await saveMacCoder();
    const fake = fakeBackend();
    const router = makeRouter(fake, undefined, async () => offline);
    await router.compose({ to: ['mac-coder'], subject: 'build', body: 'build it' });
    const held = await settledMail();
    const id = held.conversations[0].id;
    expect((await router.stopConversation(id)).stopped).toBe(true);
    expect((await readMail()).conversations[0].status).toBe('aborted');
    expect(await router.flushDeviceQueue('dev-1')).toBe(0);
    expect(fake.starts).toHaveLength(0);
  });

  it('boot redelivery leaves conversations waiting for a computer alone', async () => {
    // A wait persisted by a previous process, whose conversation still reads
    // "user spoke last" — redelivering it would just re-trip the hold and
    // write a duplicate notice.
    await saveMacCoder();
    const conversation = await createConversation('waiting', ['mac-coder']);
    await appendMailItem({ conversationId: conversation.id, from: 'user', to: ['mac-coder'], body: 'build it' });
    await queueMailForDevice({
      conversationId: conversation.id,
      personaId: 'mac-coder',
      deviceId: 'dev-1',
      deviceLabel: 'MacBook'
    });
    const fake = fakeBackend();
    const router = makeRouter(fake, undefined, async () => offline);
    expect(await router.recoverDroppedDeliveries()).toBe(0);
    // The boot sweep also holds while the device stays offline.
    expect(await router.flushDeviceQueuesAtBoot()).toBe(0);
    expect(fake.starts).toHaveLength(0);
  });

  it('the boot sweep delivers waits whose device is already online', async () => {
    await saveMacCoder();
    const conversation = await createConversation('waiting', ['mac-coder']);
    await appendMailItem({ conversationId: conversation.id, from: 'user', to: ['mac-coder'], body: 'build it' });
    await queueMailForDevice({
      conversationId: conversation.id,
      personaId: 'mac-coder',
      deviceId: 'dev-1',
      deviceLabel: 'MacBook'
    });
    const fake = fakeBackend();
    fake.script = { mode: 'ok', reply: 'built' };
    const router = makeRouter(fake, undefined, async () => online);
    expect(await router.flushDeviceQueuesAtBoot()).toBe(1);
    const mail = await settledMail();
    expect(mail.items[1]).toMatchObject({ from: 'mac-coder', to: ['user'], body: 'built' });
  });

  it('a delivery that runs while the device is online clears a stale wait', async () => {
    await saveMacCoder();
    const fake = fakeBackend();
    const router = makeRouter(fake, undefined, async () => online);
    await router.compose({ to: ['mac-coder'], subject: 'build', body: 'build it' });
    const mail = await settledMail();
    const id = mail.conversations[0].id;
    // A wait left over from a flap: the next online delivery supersedes it.
    await queueMailForDevice({ conversationId: id, personaId: 'mac-coder', deviceId: 'dev-1', deviceLabel: 'MacBook' });
    await router.reply(id, 'and again');
    await vi.waitFor(async () => {
      const after = await readMail();
      expect(after.items.length).toBeGreaterThanOrEqual(4);
      expect(after.conversations[0].status).toBe('idle');
    });
    expect(await queuedMailConversationIds()).toEqual(new Set());
    expect(await router.flushDeviceQueue('dev-1')).toBe(0);
  });
});
