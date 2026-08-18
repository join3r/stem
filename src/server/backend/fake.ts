import { EventEmitter } from 'node:events';
import type { ApprovalId, ChatBackend, ExecBridge, TaskBridge } from './types';
import type {
  ChatMessage,
  ChatSummary,
  McpAdminProposal,
  McpLoginResult,
  ModelSummary,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';
import { readTasks } from '../workspace/tasks';
import { previewText } from '../chats/preview';
import { autoTitle, KEEP, nameThread, nameThreadIfDue as nameIfDue, type SubjectDeps } from '../chats/subject';
import { setNaming } from '../workspace/chats';

/**
 * The canned model behind the fake's naming pass: "About <the first three words
 * of the conversation's opening message>", so an e2e row still matches the text
 * the thread was started with. A re-check answers KEEP — the fake has no
 * judgement about drift, and a row that holds still is what a spec can assert on.
 */
function cannedSubject(prompt: string): string {
  if (prompt.includes(`the single word ${KEEP}`)) return KEEP;
  const opening = prompt.split('\n').find((l) => l.startsWith('User: '))?.slice('User: '.length) ?? '';
  return `About ${opening.trim().split(/\s+/).slice(0, 3).join(' ')}`;
}

// Hermetic ChatBackend for STEM_E2E runs: the full turn lifecycle — send →
// streamed deltas → completed/failed/aborted, thread CRUD, retry/edit/fork —
// without a pi process, auth, or network. Everything downstream of the seam
// (IPC, event routing, both renderers, Recall capture, chat search indexing,
// the scheduler) runs for real against deterministic scripted turns.
//
// Turn scripting via markers in the prompt text:
//   [e2e:hang] — stream one delta, then stay running until interrupted
//   [e2e:fail] — fail the turn after one delta
//   [e2e:exec] — call run_command mid-turn, through the real ExecService
//   [e2e:burst] — stream BURST_DELTAS deltas back to back, with no pacing
//   [e2e:slow]  — the same script, paced slowly enough that a test can take the
//                 network away underneath it and put it back
//   otherwise  — stream "Echo: <text>" in a few deltas, then complete
//
// STEM_E2E_ONBOARDING starts the fake UNAUTHENTICATED; login() (wired to the
// scripted auth:providerLogin/auth:setApiKey handlers) flips it, mimicking a
// real sign-in.

const MODEL: ModelSummary = {
  id: 'e2e/stem-e2e-model',
  displayName: 'Stem E2E model',
  description: 'e2e',
  provider: 'e2e',
  providerName: 'E2E',
  supportedEfforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium',
  serviceTiers: [],
  isDefault: true
};

/** Interval between scripted stream events — long enough for Playwright to observe streaming. */
const STEP_MS = 15;

/**
 * `[e2e:slow]`: the same script at walking pace. A turn that is over in 75ms
 * cannot have a network failure staged in the middle of it — by the time a test
 * has cut the connection the answer has already arrived — and the middle of a
 * turn is exactly where the replay buffer earns its keep.
 */
const SLOW_STEP_MS = 700;

/**
 * `[e2e:burst]`: how many deltas, and how big. Roughly a long reply's worth of
 * tokens — enough that a per-delta cost is measurable above the noise of one
 * turn, and small enough that the whole thing is over in well under a second.
 */
const BURST_DELTAS = 400;
const BURST_CHUNK = ' token';

interface FakeThread {
  title: string;
  messages: ChatMessage[];
  createdAt: number; // unix seconds, ChatSummary convention
  updatedAt: number;
  /**
   * pi threads join listThreads only once a turn has persisted a session file
   * (createThread/forkThread alone don't). Mirrored here so sidebar-count
   * expectations hold across both backends.
   */
  listed: boolean;
}

interface ActiveTurn {
  turnId: string;
  threadId: string;
  text: string;
  timer: NodeJS.Timeout | null;
  hang: boolean;
  /** Gap between scripted events; longer for `[e2e:slow]`. */
  stepMs: number;
}

export interface FakeBackendOptions {
  piHome: string;
  workspaceRoot: string;
  /** false = the onboarding sub-seam: unauthenticated until login(). */
  startAuthenticated: boolean;
}

export class FakeBackend extends EventEmitter implements ChatBackend {
  private authed: boolean;
  private threads = new Map<string, FakeThread>();
  private seq = 0;
  private activeTurn: ActiveTurn | null = null;
  private execBridge: ExecBridge | null = null;

  constructor(private readonly options: FakeBackendOptions) {
    super();
    this.authed = options.startAuthenticated;
  }

  // ---- lifecycle / auth ----

  async status(): Promise<RuntimeStatus> {
    const base = {
      backendPath: null,
      backendHome: this.options.piHome,
      workspaceRoot: this.options.workspaceRoot
    };
    return this.authed
      ? { ...base, ok: true, authenticated: true }
      : { ...base, ok: false, authenticated: false, providers: [], error: 'Stem is not signed in yet.' };
  }

  async login(): Promise<RuntimeStatus> {
    this.authed = true;
    return this.status();
  }

  async restart(): Promise<void> {}

  isTurnRunning(): boolean {
    return !!this.activeTurn;
  }

  async shutdown(): Promise<void> {
    this.clearActiveTimer();
  }

  async newConversation(): Promise<void> {}

  async prewarm(): Promise<void> {}

  // ---- turns ----

  async createThread(_model?: string): Promise<string> {
    const threadId = `e2e-thread-${++this.seq}`;
    this.ensureThread(threadId);
    return threadId;
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const threadId = input.threadId ?? (await this.createThread(input.model));
    const turnId = `e2e-turn-${++this.seq}`;
    const thread = this.ensureThread(threadId);
    const text = input.input;
    const isNewThread = !thread.title;
    // The same first-line title the pi runtime gives a new session — and the same
    // fingerprint the naming pass checks before it renames anything.
    if (isNewThread) thread.title = autoTitle(text);
    thread.listed = true;
    thread.updatedAt = Math.floor(Date.now() / 1000);
    thread.messages.push({
      id: `user-${turnId}`,
      role: 'user',
      content: text,
      turnId,
      createdAt: new Date().toISOString(),
      ...(input.scheduled ? { scheduled: { at: input.scheduled.at } } : {})
    });

    // Mirrors the pi runtime: a brand-new thread starts at the top of the naming
    // schedule, so it is named once this turn settles rather than re-checked as
    // if it predated the schedule.
    // quiet: this backend exists only under STEM_E2E, and a naming schedule that
    // did not persist costs the fake its rename — which the test that cares about
    // renaming asserts on directly.
    if (isNewThread) void setNaming(threadId, { step: 0, since: 0 }).catch(() => undefined);

    const turn: ActiveTurn = {
      turnId,
      threadId,
      text,
      timer: null,
      hang: text.includes('[e2e:hang]'),
      stepMs: text.includes('[e2e:slow]') ? SLOW_STEP_MS : STEP_MS
    };
    this.activeTurn = turn;
    this.runScript(turn);
    return { threadId, turnId };
  }

  async interruptTurn(turnId: string): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== turnId) return;
    this.clearActiveTimer();
    this.activeTurn = null;
    this.settle(turn, 'aborted');
  }

  async listModels(): Promise<ModelSummary[]> {
    return [MODEL];
  }

  async complete(): Promise<string> {
    return '';
  }

  isInternalThread(): boolean {
    return false;
  }

  isCaptureSuppressed(): boolean {
    return false;
  }

  isWebTainted(): boolean {
    return false;
  }

  flushPendingUserCapture(): void {
    // The fake backend captures nothing.
  }

  // ---- thread CRUD ----

  async listThreads(): Promise<ChatSummary[]> {
    const rows: ChatSummary[] = [...this.threads.entries()]
      .filter(([, t]) => t.listed)
      .map(([threadId, t]) => {
        // Same rule as the pi runtime, through the same stripper: the newest
        // thing said in the thread, as plain text, so Inbox previews render
        // under the E2E seam too.
        const preview = previewText(t.messages[t.messages.length - 1]?.content ?? '');
        return {
          threadId,
          title: t.title || 'New chat',
          ...(preview ? { preview } : {}),
          folderId: null,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt
        };
      });
    // Seeded scheduled tasks reference threads that were never chatted in this
    // run — report them as existing so the scheduler's thread-deleted guard
    // doesn't remove the tasks at startup (specs seed tasks, never sessions).
    for (const task of await readTasks()) {
      if (!rows.some((r) => r.threadId === task.threadId)) {
        rows.push({ threadId: task.threadId, title: task.title ?? '', folderId: null, createdAt: 0, updatedAt: 0 });
      }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async readThread(threadId: string): Promise<{ title: string; messages: ChatMessage[] }> {
    const thread = this.threads.get(threadId);
    return { title: thread?.title ?? '', messages: [...(thread?.messages ?? [])] };
  }

  async threadTurnSettings(_threadId: string): Promise<{ model?: string; effort?: string }> {
    // The fake catalog has exactly one model; every thread "runs on" it.
    return { model: MODEL.id };
  }

  async compactThread(_threadId: string): Promise<void> {
    // Nothing to condense — fake threads carry no real context.
  }

  async resumeThread(_threadId: string): Promise<void> {}

  async renameThread(threadId: string, name: string): Promise<void> {
    this.ensureThread(threadId).title = name;
  }

  /**
   * The real subject policy — the settings gate, the hand-renamed-thread guard,
   * the sanitizer, the store write, the rename — with only the model stubbed out
   * for a canned reply, so a spec can watch a row rename itself without a
   * network call or a nondeterministic answer.
   */
  async writeThreadSubject(threadId: string, force = true): Promise<string | null> {
    const subject = await nameThread(this.subjectDeps(), threadId, { force });
    if (subject) this.emit('chats:changed', threadId);
    return subject;
  }

  /** The naming schedule, run off a settled turn exactly as the pi runtime runs it. */
  private async nameThreadIfDue(threadId: string): Promise<void> {
    const subject = await nameIfDue(this.subjectDeps(), threadId);
    if (subject) this.emit('chats:changed', threadId);
  }

  private subjectDeps(): SubjectDeps {
    return {
      complete: async (prompt) => cannedSubject(prompt),
      currentTitle: async (id) => this.threads.get(id)?.title ?? null,
      rename: (id, name) => this.renameThread(id, name),
      readMessages: async (id) => [...(this.threads.get(id)?.messages ?? [])]
    };
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
  }

  async rollbackToTurn(threadId: string, turnId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const at = thread.messages.findIndex((m) => m.turnId === turnId);
    if (at !== -1) thread.messages = thread.messages.slice(0, at);
  }

  async forkThread(threadId: string, turnId: string): Promise<{ threadId: string }> {
    const source = this.threads.get(threadId);
    if (!source) throw new Error(`No such thread: ${threadId}`);
    const last = source.messages.map((m) => m.turnId).lastIndexOf(turnId);
    if (last === -1) throw new Error(`No such turn in thread: ${turnId}`);
    const forkId = `e2e-thread-${++this.seq}`;
    const now = Math.floor(Date.now() / 1000);
    this.threads.set(forkId, {
      title: source.title,
      messages: source.messages.slice(0, last + 1).map((m) => ({ ...m })),
      createdAt: now,
      updatedAt: now,
      listed: false
    });
    return { threadId: forkId };
  }

  // ---- MCP / skills / tasks (inert) ----

  async mcpLogin(_name: string): Promise<McpLoginResult> {
    return { ok: false, error: 'MCP login is not available in the e2e fake backend.' };
  }

  getMcpStatus(): Record<string, { status: string; error: string | null }> {
    return {};
  }

  async resolveAdminApproval(
    _id: ApprovalId,
    _accept: boolean,
    _beforeAccept?: (proposal: McpAdminProposal) => Promise<void>
  ): Promise<boolean> {
    return false;
  }

  async resolveInstructionsApproval(): Promise<boolean> {
    return false;
  }

  async requestSkillReload(): Promise<void> {}

  resolveSkillApproval(): boolean {
    return false;
  }

  setSkillBridge(): void {}

  setTaskBridge(_bridge: TaskBridge | null): void {}

  /**
   * Held rather than dropped, so `[e2e:exec]` can drive the REAL ExecService —
   * its policy tiers, its approval card, its spawn. The approval path is the one
   * place where a server-owned decision has to reach a window and come back, and
   * with `approvalMode: 'manual'` seeded it does so without an LLM judge in the
   * way, which is what makes it usable as a hermetic test.
   */
  setExecBridge(bridge: ExecBridge | null): void {
    this.execBridge = bridge;
  }

  // ---- scripted turn execution ----

  /** Emit the turn's event script step by step on a timer chain. */
  private runScript(turn: ActiveTurn): void {
    const { threadId, turnId, text } = turn;
    const fail = text.includes('[e2e:fail]');
    const reply = `Echo: ${text.replace(/\[e2e:[a-z]+\]/g, '').trim()}`;
    // A third each, split on word boundaries, so streaming is observable.
    const words = reply.split(' ');
    const third = Math.max(1, Math.ceil(words.length / 3));
    const chunks = [
      words.slice(0, third).join(' '),
      words.slice(third).length ? ' ' + words.slice(third, 2 * third).join(' ') : '',
      words.slice(2 * third).length ? ' ' + words.slice(2 * third).join(' ') : ''
    ].filter(Boolean);

    const steps: Array<() => void | Promise<void>> = [];
    steps.push(() =>
      this.emitEvent('item/started', { item: { type: 'reasoning', id: turnId }, threadId, turnId })
    );
    let streamed = '';
    // What run_command answered, appended to the reply so a test can assert on
    // the rendered turn rather than on the card alone. Empty for every turn that
    // does not ask for a command.
    let execTail = '';
    if (!fail && !turn.hang && text.includes('[e2e:burst]')) {
      // [e2e:burst]: every delta at once, with no pacing between them. The other
      // scripts space their deltas out on STEP_MS so streaming is observable,
      // which means they measure the timer and not the wire. This one exists so
      // a test can put a number on what the transport costs per delta — the SSE
      // hop added a JSON serialize/parse in front of the token render loop, and
      // that is the one performance question the split raised.
      steps.push(() => {
        for (let i = 0; i < BURST_DELTAS; i++) {
          streamed += BURST_CHUNK;
          this.emitEvent('item/agentMessage/delta', { threadId, turnId, itemId: turnId, delta: BURST_CHUNK });
        }
      });
    } else {
      const deltasToEmit = turn.hang || fail ? chunks.slice(0, 1) : chunks;
      for (const chunk of deltasToEmit) {
        steps.push(() => {
          streamed += chunk;
          this.emitEvent('item/agentMessage/delta', { threadId, turnId, itemId: turnId, delta: chunk });
        });
      }
    }
    // [e2e:exec]: a run_command round-trip mid-turn, exactly as pi's tool would
    // make it. Everything past the seam is real — the policy tiers, the approval
    // card that has to reach a window and come back, the spawn. The command is a
    // harmless echo that no allowlist covers, so it lands on the approval tier.
    if (!fail && !turn.hang && text.includes('[e2e:exec]')) {
      steps.push(async () => {
        const bridge = this.execBridge;
        if (!bridge) {
          execTail = '\n\n[exec unavailable]';
          return;
        }
        const result = await bridge.handleExecRequest({
          command: 'echo stem-e2e-approved',
          threadId,
          isScheduled: false,
          userText: text
        });
        execTail = result.ok ? `\n\n[exec ok] ${result.text.trim()}` : `\n\n[exec refused] ${result.error}`;
        this.emitEvent('item/agentMessage/delta', { threadId, turnId, itemId: turnId, delta: execTail });
      });
    }

    if (fail) {
      steps.push(() => {
        if (this.activeTurn?.turnId === turnId) this.activeTurn = null;
        this.recordAssistant(turn, streamed);
        this.emitEvent('turn/failed', {
          threadId,
          turn: { id: turnId, status: 'failed' },
          error: 'E2E scripted failure'
        });
        void this.nameThreadIfDue(threadId);
      });
    } else if (!turn.hang) {
      steps.push(() => {
        if (this.activeTurn?.turnId === turnId) this.activeTurn = null;
        const final = reply + execTail;
        this.recordAssistant(turn, final);
        this.emitEvent('item/completed', {
          item: { type: 'agentMessage', id: turnId, text: final },
          threadId,
          turnId
        });
        this.emitEvent('turn/usage', {
          threadId,
          turnId,
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: null
        });
        this.emitEvent('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
        // The naming schedule runs off a settled turn here too, so an e2e row
        // renames itself through the same path the app uses.
        void this.nameThreadIfDue(threadId);
      });
    }
    // [e2e:hang]: no terminal step — the turn stays running until interruptTurn.

    const step = async (i: number): Promise<void> => {
      if (this.activeTurn?.turnId !== turnId) return; // interrupted/superseded
      await steps[i]();
      // Re-checked after the await: the exec step can sit on an approval card for
      // as long as the user takes, and Stop during that window must not resume
      // the script afterwards.
      if (this.activeTurn?.turnId !== turnId) return;
      if (i + 1 < steps.length) {
        turn.timer = setTimeout(() => void step(i + 1), turn.stepMs);
      }
    };
    turn.timer = setTimeout(() => void step(0), turn.stepMs);
  }

  /** Emit the terminal event for an interrupt, persisting nothing extra. */
  private settle(turn: ActiveTurn, status: 'aborted'): void {
    this.emitEvent('turn/aborted', {
      threadId: turn.threadId,
      turn: { id: turn.turnId, status }
    });
    void this.nameThreadIfDue(turn.threadId);
  }

  private recordAssistant(turn: ActiveTurn, text: string): void {
    const thread = this.ensureThread(turn.threadId);
    thread.updatedAt = Math.floor(Date.now() / 1000);
    thread.messages.push({
      id: `assistant-${turn.turnId}`,
      role: 'assistant',
      content: text,
      turnId: turn.turnId,
      createdAt: new Date().toISOString()
    });
  }

  private ensureThread(threadId: string): FakeThread {
    let thread = this.threads.get(threadId);
    if (!thread) {
      const now = Math.floor(Date.now() / 1000);
      thread = { title: '', messages: [], createdAt: now, updatedAt: now, listed: false };
      this.threads.set(threadId, thread);
    }
    return thread;
  }

  private clearActiveTimer(): void {
    if (this.activeTurn?.timer) clearTimeout(this.activeTurn.timer);
  }

  private emitEvent(method: string, params?: unknown): void {
    this.emit('event', { method, params, receivedAt: new Date().toISOString() });
  }
}
