// Chat naming — the pipeline behind an Inbox row's name. The sanitizer and the
// auto-title fingerprint are pure; nameThread/nameThreadIfDue run against the REAL
// settings and chat stores (throwaway paths from tests/setup-unit.ts) with only the
// model stubbed, so the mode gate, the hand-renamed-thread guard, the widening
// schedule and the persistence all get exercised the way they run in the app.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage, Role } from '../../src/shared/types';
import {
  autoTitle,
  KEEP,
  MAX_SUBJECT,
  nameThread,
  nameThreadIfDue,
  resubjectPrompt,
  sanitizeSubject,
  hasStrayScript,
  subjectPrompt
} from '../../src/server/chats/subject';
import { getNaming, getSubjects, removeChat, setNaming, setSubject } from '../../src/server/workspace/chats';
import { updateChatsSettings, updateDefaults } from '../../src/server/workspace/settings';
import { chatStorePath, settingsStorePath } from '../../src/server/workspace/paths';

const chatPath = chatStorePath();
const settingsPath = settingsStorePath();

beforeEach(() => {
  mkdirSync(dirname(chatPath), { recursive: true });
  rmSync(chatPath, { force: true });
  rmSync(settingsPath, { force: true });
});
afterEach(() => {
  rmSync(chatPath, { force: true });
  rmSync(settingsPath, { force: true });
});

let seq = 0;
const message = (role: Role, content: string): ChatMessage => ({ id: `m${++seq}`, role, content });
/** One user message and the reply it drew. */
const exchange = (user: string, assistant: string): ChatMessage[] => [
  message('user', user),
  message('assistant', assistant)
];

const OPENING = exchange('pull the Q3 numbers', 'Revenue came in at 4.1M, up 12% on Q2 across all three regions.');

/**
 * A stubbed thread: its messages, the name it currently carries, the model's
 * canned reply, and a record of what happened to it.
 */
function stub(opts: { reply?: string; title?: string | null; messages?: ChatMessage[] } = {}) {
  const state = { title: opts.title === undefined ? '' : opts.title, messages: opts.messages ?? OPENING };
  // Typed the way SubjectDeps declares it, so a test can assert on the run
  // options (model, effort) the writer resolved for this call.
  const complete = vi.fn(
    async (_prompt: string, _opts: { model?: string | null; effort?: string | null; timeoutMs?: number }) =>
      opts.reply ?? 'Quarterly revenue breakdown'
  );
  const rename = vi.fn(async (_id: string, name: string) => {
    state.title = name;
  });
  return {
    state,
    complete,
    rename,
    /** The prompt the model was handed on its last call. */
    prompt: () => complete.mock.calls[complete.mock.calls.length - 1]?.[0] ?? '',
    deps: {
      complete,
      currentTitle: async () => state.title,
      rename,
      readMessages: async () => state.messages
    }
  };
}

/** Settle `n` turns against a thread's schedule, as the runtime does per turn. */
async function turns(deps: ReturnType<typeof stub>['deps'], threadId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await nameThreadIfDue(deps, threadId);
}

describe('autoTitle', () => {
  it('takes the first non-empty line', () => {
    expect(autoTitle('\n\n  pull the Q3 numbers  \nand compare')).toBe('pull the Q3 numbers');
  });

  it('caps a long line with an ellipsis', () => {
    const title = autoTitle('x'.repeat(200));
    expect(title.length).toBe(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('is empty for a message with nothing in it', () => {
    expect(autoTitle('   \n \n')).toBe('');
  });

  it('strips Markdown, and skips a line that is only markup', () => {
    expect(autoTitle('# Fix the **retry** bug\nbody')).toBe('Fix the retry bug');
    expect(autoTitle('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });
});

describe('sanitizeSubject', () => {
  it('keeps a well-formed reply as-is', () => {
    expect(sanitizeSubject('Quarterly revenue breakdown')).toBe('Quarterly revenue breakdown');
  });

  it('takes only the first line — models like to explain themselves', () => {
    expect(sanitizeSubject('CI flake in the retry path\n\nI chose this because…')).toBe('CI flake in the retry path');
  });

  it('strips the shape of the question back out', () => {
    expect(sanitizeSubject('Subject: CI flake')).toBe('CI flake');
    expect(sanitizeSubject('Title – CI flake')).toBe('CI flake');
  });

  it('strips wrapping quotes, backticks and asterisks, including nested ones', () => {
    expect(sanitizeSubject('"CI flake"')).toBe('CI flake');
    expect(sanitizeSubject('“CI flake”')).toBe('CI flake');
    expect(sanitizeSubject('**`CI flake`**')).toBe('CI flake');
    expect(sanitizeSubject('CI flake in the **retry** path')).toBe('CI flake in the retry path');
  });

  it('drops trailing punctuation and collapses inner whitespace', () => {
    expect(sanitizeSubject('CI   flake  in   retries.')).toBe('CI flake in retries');
  });

  it('truncates a slightly-too-long subject and rejects a wildly long one', () => {
    const long = sanitizeSubject('word '.repeat(20).trim());
    expect(long.length).toBe(MAX_SUBJECT);
    expect(long.endsWith('…')).toBe(true);
    // A reply this far past the brief isn't a subject line at all — better no
    // subject than a paragraph as the thread's name.
    expect(sanitizeSubject('x'.repeat(MAX_SUBJECT * 3 + 1))).toBe('');
  });

  it('is empty for an empty or whitespace-only reply', () => {
    expect(sanitizeSubject('')).toBe('');
    expect(sanitizeSubject('\n  \n')).toBe('');
  });
});

describe('the prompts', () => {
  it('the opening one carries the conversation and caps how much the model sees', () => {
    const prompt = subjectPrompt(`short one${'x'.repeat(5000)}`);
    expect(prompt).toContain('short one');
    expect(prompt.length).toBeLessThan(3500);
  });

  it('a re-check carries the standing name and an escape hatch for leaving it alone', () => {
    const prompt = resubjectPrompt('Quarterly revenue breakdown', 'User: now about the deploy pipeline');
    expect(prompt).toContain('"Quarterly revenue breakdown"');
    expect(prompt).toContain(KEEP);
    expect(prompt).toContain('deploy pipeline');
  });
});

describe('hasStrayScript', () => {
  it('flags letters of a script the conversation has none of', () => {
    const slovak = 'Nájdi mi zdroj tohoto grafu o sandbaggingu';
    expect(hasStrayScript('Zdroj grafu o sandbagginguтипақ', slovak)).toBe(true);
    expect(hasStrayScript('Telefóny na ambulancie Ružinovская', slovak)).toBe(true);
    expect(hasStrayScript('OpenJDK Image Replacement തീരുമാനം', 'replace the OpenJDK image')).toBe(true);
    expect(hasStrayScript('Discord #test message_久久爱', 'send a Discord test message')).toBe(true);
  });

  it('accepts a subject in the scripts of the conversation', () => {
    expect(hasStrayScript('Zdroj grafu o sandbaggingu', 'Nájdi mi zdroj')).toBe(false);
    expect(hasStrayScript('Перевод письма', 'Переведи это письмо')).toBe(false);
    expect(hasStrayScript('東京 trip プラン', 'Plan my 東京 trip, ホテル included')).toBe(false);
    expect(hasStrayScript('Q3 2026 — 12%', 'numbers')).toBe(false);
  });
});

describe('naming a new thread', () => {
  it('writes the subject and renames the thread at the everywhere default', async () => {
    const s = stub({ title: 'pull the Q3 numbers' });
    await setNaming('a', { step: 0, since: 0 });
    const subject = await nameThreadIfDue(s.deps, 'a');
    expect(subject).toBe('Quarterly revenue breakdown');
    expect(s.rename).toHaveBeenCalledWith('a', 'Quarterly revenue breakdown');
    expect((await getSubjects()).a).toBe('Quarterly revenue breakdown');
  });

  it('asks again when the subject has a stray script, and keeps the name if it stays bad', async () => {
    const s = stub({ title: 'pull the Q3 numbers' });
    s.complete.mockResolvedValueOnce('Quarterly revenueтипақ');
    await setNaming('a', { step: 0, since: 0 });
    expect(await nameThreadIfDue(s.deps, 'a')).toBe('Quarterly revenue breakdown');
    expect(s.complete).toHaveBeenCalledTimes(2);

    const bad = stub({ title: 'pull the Q3 numbers', reply: 'Quarterly revenueтипақ' });
    await setNaming('b', { step: 0, since: 0 });
    expect(await nameThreadIfDue(bad.deps, 'b')).toBeNull();
    expect(bad.complete).toHaveBeenCalledTimes(2);
    expect(bad.state.title).toBe('pull the Q3 numbers');
  });

  it('shows the model the reply, not just the message that opened the thread', async () => {
    const s = stub({ title: 'pull the Q3 numbers' });
    await setNaming('a', { step: 0, since: 0 });
    await nameThreadIfDue(s.deps, 'a');
    // The whole point of naming at settle rather than at send: a thread that
    // opens with "look at this" has its topic in the answer, not the question.
    expect(s.prompt()).toContain('pull the Q3 numbers');
    expect(s.prompt()).toContain('up 12% on Q2');
  });

  it('runs on the subject role’s own model and effort, else the Quick tasks ones', async () => {
    // The seam that swallowed this before: SubjectDeps.complete took `{ model,
    // timeoutMs }` and the effort rode in on a spread, so it type-checked either
    // way and a destructure at the other end would have dropped it silently.
    // Nothing set anywhere: a subject is extraction, so it runs with reasoning
    // off rather than at whatever pi picks for the model.
    const bare = stub({ title: '' });
    await nameThread(bare.deps, 'a', { state: { step: 0, since: 1 } });
    expect(bare.complete.mock.calls[0][1]).toMatchObject({ model: null, effort: 'off' });

    await updateDefaults({ backgroundModel: 'x/bg', backgroundEffort: 'low' });
    const shared = stub({ title: '' });
    await nameThread(shared.deps, 'a', { state: { step: 0, since: 1 } });
    expect(shared.complete.mock.calls[0][1]).toMatchObject({ model: 'x/bg', effort: 'low' });

    await updateChatsSettings({ subjectModel: 'x/tiny', subjectEffort: 'off' });
    const pinned = stub({ title: '' });
    await nameThread(pinned.deps, 'b', { state: { step: 0, since: 1 } });
    expect(pinned.complete.mock.calls[0][1]).toMatchObject({ model: 'x/tiny', effort: 'off' });
  });

  it('at `inbox` it stores the subject but leaves the thread’s name alone', async () => {
    await updateChatsSettings({ subjects: 'inbox' });
    const s = stub({ title: 'pull the Q3 numbers' });
    await setNaming('a', { step: 0, since: 0 });
    expect(await nameThreadIfDue(s.deps, 'a')).toBe('Quarterly revenue breakdown');
    expect(s.rename).not.toHaveBeenCalled();
    // The whole point of the mode: the two names deliberately differ.
    expect(s.state.title).toBe('pull the Q3 numbers');
    expect((await getSubjects()).a).toBe('Quarterly revenue breakdown');
  });

  it('at `off` it never calls the model, and doesn’t even keep count', async () => {
    await updateChatsSettings({ subjects: 'off' });
    const s = stub({ title: 'pull the Q3 numbers' });
    await setNaming('a', { step: 0, since: 0 });
    expect(await nameThreadIfDue(s.deps, 'a')).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
    expect((await getSubjects()).a).toBeUndefined();
    // Turning subjects back on later starts counting from then, rather than
    // firing at once on every thread chatted in while the mode was off.
    expect(await getNaming('a')).toEqual({ step: 0, since: 0 });
  });

  it('leaves a thread the user has renamed alone, without spending a model call', async () => {
    const s = stub({ title: 'Numbers for the board' });
    await setNaming('a', { step: 0, since: 0 });
    expect(await nameThreadIfDue(s.deps, 'a')).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
    expect(s.rename).not.toHaveBeenCalled();
  });

  it('treats an empty name and pi’s "New chat" as ours to replace', async () => {
    for (const title of ['', 'New chat']) {
      const s = stub({ title });
      await setNaming('a', { step: 0, since: 0 });
      expect(await nameThreadIfDue(s.deps, 'a')).toBe('Quarterly revenue breakdown');
      expect(s.rename).toHaveBeenCalled();
    }
  });

  it('does not rename when the user renames the thread while the model is thinking', async () => {
    const s = stub({ title: 'pull the Q3 numbers' });
    // The completion is where the window is: rename mid-flight, as a user would.
    s.complete.mockImplementation(async () => {
      s.state.title = 'Numbers for the board';
      return 'Quarterly revenue breakdown';
    });
    await setNaming('a', { step: 0, since: 0 });
    const subject = await nameThreadIfDue(s.deps, 'a');
    // The subject is still worth keeping — it just doesn't get to win the name.
    expect(subject).toBe('Quarterly revenue breakdown');
    expect(s.rename).not.toHaveBeenCalled();
    expect((await getSubjects()).a).toBe('Quarterly revenue breakdown');
  });

  it('writes nothing when the model answers with nothing usable', async () => {
    const s = stub({ reply: '   ', title: '' });
    await setNaming('a', { step: 0, since: 0 });
    expect(await nameThreadIfDue(s.deps, 'a')).toBeNull();
    expect(s.rename).not.toHaveBeenCalled();
    expect((await getSubjects()).a).toBeUndefined();
  });

  it('swallows a failing model rather than breaking the turn it rode in on', async () => {
    const s = stub({ title: '' });
    s.complete.mockRejectedValue(new Error('the worker is wedged'));
    await setNaming('a', { step: 0, since: 0 });
    await expect(nameThreadIfDue(s.deps, 'a')).resolves.toBeNull();
  });

  it('skips a thread whose first message is empty', async () => {
    const s = stub({ title: '', messages: [message('user', '   ')] });
    await setNaming('a', { step: 0, since: 0 });
    expect(await nameThreadIfDue(s.deps, 'a')).toBeNull();
    expect(s.complete).not.toHaveBeenCalled();
  });
});

describe('the naming schedule', () => {
  /** A thread that opened on the numbers and has since moved onto something else. */
  const drifted = [
    ...OPENING,
    ...exchange(
      'forget the numbers — the deploy pipeline is timing out on the staging push again',
      'The staging push times out because the image layer cache misses on every run; pinning the base image fixes it.'
    ),
    ...exchange(
      'pinning it did not help, the push still hangs after the third layer',
      'Then it is the registry handshake, not the cache — the third layer is where the token expires.'
    )
  ];

  it('names a new thread on its first settled turn, then goes quiet for two', async () => {
    const s = stub({ title: 'pull the Q3 numbers', messages: drifted });
    await setNaming('a', { step: 0, since: 0 });

    await turns(s.deps, 'a', 1);
    expect(s.complete).toHaveBeenCalledTimes(1);
    // Turn 2 is inside the first gap: counted, but nothing is read or spent.
    await turns(s.deps, 'a', 1);
    expect(s.complete).toHaveBeenCalledTimes(1);
    // Turn 3 comes due.
    await turns(s.deps, 'a', 1);
    expect(s.complete).toHaveBeenCalledTimes(2);
  });

  it('widens: after the re-check at turn 3, the next is at turn 8', async () => {
    const s = stub({ title: 'pull the Q3 numbers', messages: drifted });
    await setNaming('a', { step: 0, since: 0 });
    await turns(s.deps, 'a', 3);
    expect(s.complete).toHaveBeenCalledTimes(2);
    await turns(s.deps, 'a', 4); // turns 4–7
    expect(s.complete).toHaveBeenCalledTimes(2);
    await turns(s.deps, 'a', 1); // turn 8
    expect(s.complete).toHaveBeenCalledTimes(3);
  });

  it('re-checks against the standing name, showing only what is new', async () => {
    const s = stub({ title: 'pull the Q3 numbers', messages: drifted });
    await setNaming('a', { step: 0, since: 0 });
    await turns(s.deps, 'a', 3);
    expect(s.prompt()).toContain('"Quarterly revenue breakdown"');
    expect(s.prompt()).toContain('deploy pipeline');
    // Only the turns since the naming — the opening exchange is carried by the
    // name itself rather than re-read every time.
    expect(s.prompt()).not.toContain('pull the Q3 numbers');
  });

  it('renames the thread when the re-check says the name has stopped fitting', async () => {
    const s = stub({ title: 'pull the Q3 numbers', messages: drifted });
    await setNaming('a', { step: 0, since: 0 });
    await turns(s.deps, 'a', 1);
    expect(s.state.title).toBe('Quarterly revenue breakdown');

    s.complete.mockResolvedValue('Staging deploy timeouts');
    await turns(s.deps, 'a', 2);
    expect(s.state.title).toBe('Staging deploy timeouts');
    expect((await getSubjects()).a).toBe('Staging deploy timeouts');
  });

  it('leaves the name alone when the re-check answers KEEP', async () => {
    const s = stub({ title: 'pull the Q3 numbers', messages: drifted });
    await setNaming('a', { step: 0, since: 0 });
    await turns(s.deps, 'a', 1);
    s.complete.mockResolvedValue(KEEP);
    await turns(s.deps, 'a', 2);
    expect(s.state.title).toBe('Quarterly revenue breakdown');
    expect(s.rename).toHaveBeenCalledTimes(1);
    // The check still counts, so the next one is a full gap away.
    expect(await getNaming('a')).toEqual({ step: 2, since: 0 });
  });

  it('treats a re-check that just re-words the same name as a KEEP', async () => {
    const s = stub({ title: 'pull the Q3 numbers', messages: drifted });
    await setNaming('a', { step: 0, since: 0 });
    await turns(s.deps, 'a', 1);
    s.complete.mockResolvedValue('quarterly revenue BREAKDOWN');
    await turns(s.deps, 'a', 2);
    expect(s.rename).toHaveBeenCalledTimes(1);
  });

  it('a re-check with nothing new to read waits instead of spending a call', async () => {
    const s = stub({ title: 'pull the Q3 numbers', messages: [...OPENING, ...exchange('thanks', 'Any time.')] });
    await setNaming('a', { step: 0, since: 0 });
    await turns(s.deps, 'a', 3);
    expect(s.complete).toHaveBeenCalledTimes(1);
    // Held at the same step, and due again shortly rather than at the next gap.
    expect(await getNaming('a')).toMatchObject({ step: 1 });
  });

  it('a thread that predates the schedule joins it as re-checkable, not as new', async () => {
    // No naming record at all: written by a version that named threads once, at
    // their first turn. Naming it from scratch off one exchange would throw its
    // history away, so it joins one step in — due for a re-check.
    await setSubject('a', 'Quarterly revenue breakdown');
    const s = stub({ title: 'Quarterly revenue breakdown', messages: drifted });
    await turns(s.deps, 'a', 2);
    expect(s.complete).toHaveBeenCalledTimes(1);
    expect(s.prompt()).toContain('"Quarterly revenue breakdown"');
  });

  it('recognises the subject it wrote as its own, so a re-check may replace it', async () => {
    // The guard that would otherwise stop this: after the first naming the
    // thread's name is no longer the first line the user typed, and a re-check
    // must not read its own work as a name the user chose.
    await setSubject('a', 'Quarterly revenue breakdown');
    const s = stub({ title: 'Quarterly revenue breakdown', messages: drifted, reply: 'Staging deploy timeouts' });
    await turns(s.deps, 'a', 2);
    expect(s.rename).toHaveBeenCalledWith('a', 'Staging deploy timeouts');
  });

  it('still recognises its own subject when it was stored with Markdown', async () => {
    // Listed titles are stripped; subjects written before the stripping are not.
    await setSubject('a', 'Quarterly **revenue** breakdown');
    const s = stub({ title: 'Quarterly revenue breakdown', messages: drifted, reply: 'Staging deploy timeouts' });
    await turns(s.deps, 'a', 2);
    expect(s.rename).toHaveBeenCalledWith('a', 'Staging deploy timeouts');
  });

  it('stops re-checking a thread the user renamed, and stops re-reading it every turn', async () => {
    await setSubject('a', 'Quarterly revenue breakdown');
    const s = stub({ title: 'Numbers for the board', messages: drifted });
    await turns(s.deps, 'a', 2);
    expect(s.complete).not.toHaveBeenCalled();
    // Advanced rather than left due, so the widening gaps keep a thread that is
    // no longer ours from being read on every single turn from here on.
    expect(await getNaming('a')).toEqual({ step: 2, since: 0 });
  });
});

describe('the "Write a subject" row action', () => {
  it('runs whatever the mode is, and may replace a name the user typed', async () => {
    await updateChatsSettings({ subjects: 'off' });
    const s = stub({ title: 'Numbers for the board' });
    expect(await nameThread(s.deps, 'a', { force: true })).toBe('Quarterly revenue breakdown');
    // `off` still means "don't rename" — force overrides the initiative, not the mode.
    expect(s.rename).not.toHaveBeenCalled();

    await updateChatsSettings({ subjects: 'everywhere' });
    const s2 = stub({ title: 'Numbers for the board' });
    await nameThread(s2.deps, 'a', { force: true });
    expect(s2.rename).toHaveBeenCalledWith('a', 'Quarterly revenue breakdown');
  });

  it('writes from the whole thread, not just what is new', async () => {
    const s = stub({
      title: 'Numbers for the board',
      messages: [...OPENING, ...exchange('and the deploy pipeline?', 'Still timing out on the staging push.')]
    });
    await setNaming('a', { step: 3, since: 0 });
    await nameThread(s.deps, 'a', { force: true });
    expect(s.prompt()).toContain('pull the Q3 numbers');
    expect(s.prompt()).toContain('staging push');
    // Asked outright, not asked whether to keep what it had.
    expect(s.prompt()).not.toContain(`the single word ${KEEP}`);
  });

  it('buys the name it wrote a full gap of quiet before anything re-checks it', async () => {
    const s = stub({ title: 'Numbers for the board' });
    await setNaming('a', { step: 3, since: 2 });
    await nameThread(s.deps, 'a', { force: true });
    expect(await getNaming('a')).toEqual({ step: 4, since: 0 });
  });
});

describe('the subject store', () => {
  it('round-trips, and an empty subject clears the entry', async () => {
    await setSubject('a', '  Quarterly revenue  ');
    expect((await getSubjects()).a).toBe('Quarterly revenue');
    await setSubject('a', '');
    expect((await getSubjects()).a).toBeUndefined();
  });

  it('is dropped when the chat is deleted, schedule and all', async () => {
    await setSubject('a', 'Quarterly revenue');
    await setNaming('a', { step: 2, since: 1 });
    await setSubject('b', 'CI flake');
    await removeChat('a');
    const subjects = await getSubjects();
    expect(subjects.a).toBeUndefined();
    expect(subjects.b).toBe('CI flake');
    expect(await getNaming('a')).toBeNull();
  });
});
