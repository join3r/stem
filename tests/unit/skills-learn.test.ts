// `/learn` authors from the whole saved conversation, not the runtime's ring of
// the last turn. The 2026-10-06 invoice chat is the case these pin: the work was
// one turn before the last, done by a 4 KB script the ring had cut to 600
// characters, so the author declined it. The privacy rule the ring enforced per
// turn (memorize:false folders, private chats) must survive the move to the file.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const skillsDir = join(tmpdir(), `stem-skills-learn-${process.pid}`);
process.env.STEM_SKILLS_DIR = skillsDir;

import { PiRuntime } from '../../src/server/pi/runtime';
import {
  LEARN_ARGS_MAX_CHARS,
  parseThreadEvidence,
  pickLearnTurns,
  turnSize,
  type LearnTurn,
  type ThreadEvidenceOptions
} from '../../src/server/skills/thread-evidence';
import { SKILL_LEARN_INSTRUCTIONS, buildAuthorPrompt, renderEvidence } from '../../src/server/skills/author';
import { initSkills, learnFromChat } from '../../src/server/startup/skills';
import { addConnectedFolders, updateConnectedFolder } from '../../src/server/workspace/connected-folders';
import { copyChatPrivacyToFork, isChatPrivate, markTurnTainted, removeChat, setChatPrivate, taintedTurns } from '../../src/server/workspace/chats';
import { createConversation, setConversationSession } from '../../src/server/workspace/mail';
import { newTurnContext, type SettledTurnTrace } from '../../src/server/pi/normalize';
import { logFlushed } from '../../src/server/log';
import type { ChatBackend } from '../../src/server/backend';

afterAll(() => rm(skillsDir, { recursive: true, force: true }));

// pi's session file, one JSON object per line, as a chat writes it.
const line = (message: Record<string, unknown>) => JSON.stringify({ type: 'message', message });
const user = (text: string) => line({ role: 'user', content: [{ type: 'text', text }] });
const call = (id: string, name: string, args: Record<string, unknown>, text = '') =>
  line({ role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), { type: 'toolCall', id, name, arguments: args }] });
const result = (id: string, text: string, isError = false) =>
  line({ role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }], isError });
const reply = (text: string) => line({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });

const CONTEXT = (body: string, extra = '') => `<!--stem:context-->\n${extra}<!--/stem:context-->\n\n${body}`;
const memoryData = (folder: string) =>
  `<stem_memory_data version="3">\n${JSON.stringify({ facts: [], folderDocuments: [{ folder, path: 'a.md', excerpt: 'x' }] })}\n</stem_memory_data>\n`;

const SCRIPT = `python3 - <<'PY'\n${'# patch the invoice fields\n'.repeat(150)}PY`; // ~4 KB
/** The script as it reads inside the JSON arguments the author is shown. */
const SCRIPT_IN_ARGS = JSON.stringify(SCRIPT).slice(1, -1);

const opts = (over: Partial<ThreadEvidenceOptions> = {}): ThreadEvidenceOptions => ({
  cleanUser: (content) =>
    (Array.isArray(content) ? (content as Array<{ text?: string }>).map((c) => c.text ?? '').join('') : String(content)).replace(
      /^<!--stem:context-->[\s\S]*?<!--\/stem:context-->\n+/,
      ''
    ),
  turnIdOf: () => undefined,
  isPrivatePath: () => false,
  privateFolderLabels: new Set(),
  taintedTurnIds: new Set(),
  ...over
});

const invoiceChat = [
  user(CONTEXT('Make the Cloudfarms invoice for 162 hours from last month’s.')),
  call('c1', 'run_command', { command: SCRIPT, device: 'mac' }, 'Creating it now.'),
  result('c1', 'Created: 2026/09/Faktura_20260010.pdf'),
  reply('Done: Faktura_20260010.pdf, 162 hours.'),
  user(CONTEXT('Looks good, but drop the KROS mention.')),
  call('c2', 'run_command', { command: 'python3 strip.py' }),
  result('c2', 'Traceback: AssertionError', true),
  call('c3', 'run_command', { command: 'python3 strip2.py' }),
  result('c3', 'Updated invoice.'),
  reply('Removed the KROS text.')
].join('\n');

describe('parseThreadEvidence', () => {
  it('reads every turn with the arguments whole', () => {
    const turns = parseThreadEvidence(invoiceChat, opts());
    expect(turns).toHaveLength(2);
    expect(turns[0].userText).toBe('Make the Cloudfarms invoice for 162 hours from last month’s.');
    // The script that did the work arrives intact — the ring cut it at 600.
    expect(SCRIPT.length).toBeGreaterThan(3_000);
    expect(turns[0].trace[0].args).toBe(JSON.stringify({ command: SCRIPT, device: 'mac' }));
    expect(turns[0].assistantText).toBe('Creating it now.\n\nDone: Faktura_20260010.pdf, 162 hours.');
    expect(turns[1].trace.map((t) => [t.name, t.isError])).toEqual([
      ['run_command', true],
      ['run_command', false]
    ]);
    expect(turns.every((t) => !t.tainted)).toBe(true);
  });

  it('caps an argument past the /learn limit, and redacts secrets the way the ring does', () => {
    const huge = 'x'.repeat(LEARN_ARGS_MAX_CHARS * 2);
    const turns = parseThreadEvidence(
      [user('go'), call('c1', 'add_mcp_server', { command: huge, env: { API_TOKEN: 'sk-live-123' } })].join('\n'),
      opts()
    );
    const args = turns[0].trace[0].args!;
    expect(args.length).toBeLessThan(LEARN_ARGS_MAX_CHARS + 50);
    expect(args).toContain('…[truncated]');
    const small = parseThreadEvidence(
      [user('go'), call('c1', 'add_mcp_server', { name: 'x', env: { API_TOKEN: 'sk-live-123' } })].join('\n'),
      opts()
    );
    expect(small[0].trace[0].args).toContain('[redacted]');
    expect(small[0].trace[0].args).not.toContain('sk-live-123');
  });

  it('names the real tool behind the MCP router', () => {
    const turns = parseThreadEvidence(
      [user('go'), call('c1', 'invoke_tool', { server: 'ha', tool: 'ha_get_history', args: { entity: 'x' } })].join('\n'),
      opts()
    );
    expect(turns[0].trace[0].name).toBe('ha_get_history');
  });

  it('taints a turn that read inside a memorize:false folder — the MCP router’s inner path included', () => {
    const chat = [
      user('read the diary'),
      call('c1', 'read', { path: '/private/diary.md' }),
      user('now the public one'),
      call('c2', 'invoke_tool', { tool: 'files_read', args: { path: '/private/x' } }),
      user('and the notes'),
      call('c3', 'read', { path: '/notes/a.md' })
    ].join('\n');
    const turns = parseThreadEvidence(chat, opts({ isPrivatePath: (p) => p.startsWith('/private/') }));
    expect(turns.map((t) => t.tainted)).toEqual([true, true, false]);
  });

  it('taints a turn Recall handed a document from a memorize:false folder', () => {
    const chat = [user(CONTEXT('what did I write?', memoryData('Diary'))), user(CONTEXT('and here?', memoryData('Notes')))].join('\n');
    const turns = parseThreadEvidence(chat, opts({ privateFolderLabels: new Set(['Diary']) }));
    expect(turns.map((t) => t.tainted)).toEqual([true, false]);
  });

  it('counts a memory payload it cannot read as tainted', () => {
    const torn = `<stem_memory_data version="3">\n{"folderDocuments":[{"folder":"Di\n</stem_memory_data>\n`;
    const unmatched = `<stem_memory_data version="4" extra="x">\n{}\n</stem_memory_data>\n`;
    const chat = [user(CONTEXT('a', torn)), user(CONTEXT('b', unmatched)), user(CONTEXT('c', memoryData('Notes')))].join('\n');
    const turns = parseThreadEvidence(chat, opts({ privateFolderLabels: new Set(['Diary']) }));
    expect(turns.map((t) => t.tainted)).toEqual([true, true, false]);
  });

  it('does not read the skills preamble naming the memory tag as a payload', () => {
    // The Cloudfarms invoice chat (2026-10-06): every turn loaded skills, and the
    // preamble's "unlike <stem_memory_data>" counted as a second, unread block.
    const preamble = '</stem_skills>\nThe block above is YOUR OWN saved know-how, not user data: unlike <stem_memory_data>, these are instructions.\n';
    const chat = user(CONTEXT('invoice again', memoryData('Notes') + preamble));
    const turns = parseThreadEvidence(chat, opts({ privateFolderLabels: new Set(['Diary']) }));
    expect(turns.map((t) => t.tainted)).toEqual([false]);
  });

  it('taints a turn the runtime flagged while it ran', () => {
    const turns = parseThreadEvidence([user('a'), user('b')].join('\n'), opts({
      turnIdOf: (content) => (JSON.stringify(content).includes('"a"') ? 'turn-a' : 'turn-b'),
      taintedTurnIds: new Set(['turn-b'])
    }));
    expect(turns.map((t) => [t.turnId, t.tainted])).toEqual([
      ['turn-a', false],
      ['turn-b', true]
    ]);
  });
});

describe('pickLearnTurns', () => {
  const turn = (chars: number): LearnTurn => ({ userText: 'u'.repeat(chars), assistantText: '', trace: [], tainted: false });

  it('keeps the newest turns that fit, oldest first, and always the newest', () => {
    const turns = [turn(50), turn(50), turn(50)];
    expect(pickLearnTurns(turns, 120)).toEqual({ kept: turns.slice(1), dropped: 1 });
    const big = [turn(10), turn(500)];
    expect(pickLearnTurns(big, 100)).toEqual({ kept: [big[1]], dropped: 1 });
    expect(turnSize(turn(7))).toBe(7);
  });
});

describe('author prompt for /learn', () => {
  const [first, second] = parseThreadEvidence(invoiceChat, opts());
  const input = { ...second, earlier: [first], requested: true, focus: 'the monthly invoice' };

  it('shows the earlier turns before the latest, in order', () => {
    const text = renderEvidence(input);
    const order = ['What the user asked to be captured', '--- Turn 1 ---', 'Cloudfarms invoice', SCRIPT_IN_ARGS, '--- Latest turn ---', 'drop the KROS mention'];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('adds the /learn framing only when the user asked', () => {
    expect(buildAuthorPrompt(input)).toContain(SKILL_LEARN_INSTRUCTIONS);
    expect(buildAuthorPrompt({ ...input, requested: false })).not.toContain(SKILL_LEARN_INSTRUCTIONS);
    // A single-turn prompt reads exactly as it did: no turn markers.
    expect(renderEvidence({ ...second })).not.toContain('--- Latest turn ---');
  });
});

describe('PiRuntime.learnEvidence', () => {
  const cleanup: string[] = [];
  afterEach(() => Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true }))));

  it('reads the thread’s session file and taints reads inside a memorize:false folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-learn-evidence-'));
    cleanup.push(root);
    const sessions = join(root, 'pi', 'sessions');
    const workspace = join(root, 'workspace');
    const privateDir = join(root, 'Diary');
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(privateDir)]);
    const [folder] = await addConnectedFolders([privateDir]);
    await updateConnectedFolder(folder.id, { memorize: false });

    const threadId = '01a110c9-0000-7000-8000-000000000001';
    const header = JSON.stringify({ type: 'session', version: 3, id: threadId, timestamp: '2026-10-06T10:37:11.058Z', cwd: workspace });
    await writeFile(
      join(sessions, `2026-10-06T10-37-11-058Z_${threadId}.jsonl`),
      [header, user(CONTEXT('read my diary')), call('c1', 'read', { path: join(privateDir, 'today.md') }), reply('ok'), invoiceChat].join('\n')
    );

    const runtime = new PiRuntime({ piHome: join(root, 'pi'), sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false });
    const turns = await runtime.learnEvidence(threadId);
    expect(turns?.map((t) => [t.userText, t.tainted])).toEqual([
      ['read my diary', true],
      ['Make the Cloudfarms invoice for 162 hours from last month’s.', false],
      ['Looks good, but drop the KROS mention.', false]
    ]);
    expect(await runtime.learnEvidence('no-such-thread')).toBeNull();
  });

  it('honours the taint recorded while a turn ran, after the folder that caused it is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-learn-recorded-'));
    cleanup.push(root);
    const sessions = join(root, 'pi', 'sessions');
    const workspace = join(root, 'workspace');
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);
    const threadId = '01a110c9-0000-7000-8000-000000000002';
    const turnId = '6eb69491-3826-47cd-9cbd-89fcd2757495';
    const header = JSON.stringify({ type: 'session', version: 3, id: threadId, timestamp: '2026-10-06T10:37:11.058Z', cwd: workspace });
    await writeFile(
      join(sessions, `2026-10-06T10-37-11-058Z_${threadId}.jsonl`),
      [header, user(`<!--stem:context-->\n<!--stem:turn id="${turnId}"-->\n\n---\n<!--/stem:context-->\n\nread the old diary`), call('c1', 'read', { path: '/gone/diary.md' }), reply('ok'), invoiceChat].join('\n')
    );
    const runtime = new PiRuntime({ piHome: join(root, 'pi'), sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false });

    // What the runtime does the moment a turn reads a memorize:false folder.
    const live = newTurnContext(threadId, turnId);
    (runtime as unknown as { taintTurn(t: typeof live): void }).taintTurn(live);
    expect(live.memoryTainted).toBe(true);
    await expect.poll(async () => (await taintedTurns(threadId)).has(turnId)).toBe(true);

    const turns = await runtime.learnEvidence(threadId);
    expect(turns?.map((t) => [t.turnId ?? null, t.tainted])).toEqual([
      [turnId, true],
      [null, false],
      [null, false]
    ]);
  });
});

describe('chat privacy marks', () => {
  it('a fork keeps the original’s private mark and recorded turns; deleting a chat drops its own', async () => {
    await setChatPrivate('chat-orig');
    await markTurnTainted('chat-orig', 'turn-1');
    await markTurnTainted('chat-orig', 'turn-1');
    await copyChatPrivacyToFork('chat-orig', 'chat-fork');
    expect(await isChatPrivate('chat-fork')).toBe(true);
    expect([...(await taintedTurns('chat-fork'))]).toEqual(['turn-1']);
    await removeChat('chat-orig');
    expect((await taintedTurns('chat-orig')).size).toBe(0);
    expect((await taintedTurns('chat-fork')).has('turn-1')).toBe(true);
  });

  it('a fork of an ordinary chat stays ordinary', async () => {
    await copyChatPrivacyToFork('chat-plain', 'chat-plain-fork');
    expect(await isChatPrivate('chat-plain-fork')).toBe(false);
    expect((await taintedTurns('chat-plain-fork')).size).toBe(0);
  });
});

describe('learnFromChat', () => {
  const BODY = `## When to use
When the user asks for the monthly Cloudfarms invoice.

## Steps
1. Copy last month's invoice and change the hours.

## Verification
The new PDF shows the hours and the total.`;

  let evidence: LearnTurn[] | null;
  let ring: SettledTurnTrace | null;
  let prompts: string[];
  let answer: string;
  let approvals: unknown[];

  beforeEach(() => {
    evidence = parseThreadEvidence(invoiceChat, opts()).map((t, i) => ({ ...t, turnId: `turn-${i}` }));
    ring = null;
    prompts = [];
    approvals = [];
    answer = JSON.stringify({ skill: { name: 'monthly-cloudfarms-invoice', description: 'Make the monthly Cloudfarms invoice when the user gives the hours.', body: BODY } });
    const runtime = {
      setSkillBridge: () => undefined,
      setTurnSettledHook: () => undefined,
      requestSkillApproval: async (proposal: unknown) => {
        approvals.push(proposal);
        return { approved: true };
      },
      learnEvidence: async () => evidence,
      recentTurnTrace: () => ring,
      complete: async (prompt: string) => {
        prompts.push(prompt);
        return answer;
      }
    } as unknown as ChatBackend;
    initSkills({ runtime, onChanged: () => undefined, busyWithin: () => false });
  });

  it('authors from every turn and saves the skill', async () => {
    const result = await learnFromChat('thread-invoice', 'the monthly invoice');
    expect(result).toMatchObject({ ok: true, slug: 'monthly-cloudfarms-invoice' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(SCRIPT_IN_ARGS);
    expect(prompts[0]).toContain('--- Latest turn ---');
    expect(prompts[0]).toContain(SKILL_LEARN_INSTRUCTIONS);
    const saved = await readFile(join(skillsDir, 'monthly-cloudfarms-invoice', 'SKILL.md'), 'utf8');
    expect(saved).toContain('Copy last month');
    await logFlushed();
    const log = await readFile(process.env.STEM_LOG_FILE!, 'utf8');
    expect(log).toMatch(/\[skills\] \/learn \{"threadId":"thread-invoice","ok":true,"reason":"saved".*"turns":2/);
  });

  it('says why when the author declines, and logs it', async () => {
    answer = JSON.stringify({ skill: null, reason: 'no procedure here' });
    const result = await learnFromChat('thread-declined');
    expect(result).toEqual({ ok: false, message: 'Nothing reusable in this chat — no procedure here.' });
    await logFlushed();
    expect(await readFile(process.env.STEM_LOG_FILE!, 'utf8')).toContain('"threadId":"thread-declined","ok":false,"reason":"declined"');
  });

  it('leaves out tainted turns, and refuses when nothing else is left', async () => {
    evidence = evidence!.map((t, i) => ({ ...t, tainted: i === 0 }));
    await learnFromChat('thread-partly-private');
    expect(prompts[0]).not.toContain(SCRIPT_IN_ARGS);
    expect(prompts[0]).not.toContain('--- Latest turn ---');

    evidence = evidence.map((t) => ({ ...t, tainted: true }));
    prompts = [];
    expect(await learnFromChat('thread-all-private')).toMatchObject({ ok: false, message: expect.stringMatching(/not to memorise/) });
    expect(prompts).toHaveLength(0);
  });

  it('takes a reported skill issue only from the newest clean turn', async () => {
    const issue = 'the diary entry says the client is leaving';
    const reported = (over: Partial<SettledTurnTrace>): SettledTurnTrace => ({
      threadId: 'thread-ring', turnId: 'turn-1', endedAt: 0, userText: '', assistantText: '', trace: [],
      skillsInjected: [], skillsGradedUsed: [], skillsReported: [{ slug: 'monthly-cloudfarms-invoice', reason: issue }],
      memoryTainted: false, isScheduled: false, ...over
    });
    // The skill saved by the first test is there to be routed at.
    ring = reported({ memoryTainted: true });
    await learnFromChat('thread-ring');
    ring = reported({ turnId: 'some-older-turn' });
    await learnFromChat('thread-ring');
    expect(prompts.some((p) => p.includes(issue))).toBe(false);
    ring = reported({});
    await learnFromChat('thread-ring');
    expect(prompts[prompts.length - 1]).toContain(issue);
  });

  it('stays out of threads that belong to mail', async () => {
    const conversation = await createConversation('Invoice', ['persona-a'], '', { private: true });
    await setConversationSession(conversation.id, 'persona-a', 'thread-mail');
    expect(await learnFromChat('thread-mail')).toMatchObject({ ok: false, message: expect.stringMatching(/not in mail/) });
    expect(prompts).toHaveLength(0);
  });

  it('refuses a private chat without reading it', async () => {
    await setChatPrivate('thread-private');
    expect(await learnFromChat('thread-private')).toMatchObject({ ok: false, message: expect.stringMatching(/private chat/) });
    expect(prompts).toHaveLength(0);
  });

  it('answers plainly for a chat with nothing in it yet', async () => {
    evidence = null;
    expect(await learnFromChat('thread-empty')).toEqual({ ok: false, message: 'There is nothing in this chat to learn from yet.' });
  });
});
