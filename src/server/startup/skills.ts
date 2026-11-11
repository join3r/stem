import { SkillBridge } from '../skills/bridge';
import { authorForTurn, firstExistingSkill, routeReported, settleSkills } from '../skills/settle';
import { readSettings, skillsRunFor } from '../workspace/settings';
import { log } from '../log';
import { degrade } from '../degrade';
import { isChatPrivate } from '../workspace/chats';
import { mailSessionThreadIds, threadsClosedToLearning } from '../workspace/mail';
import { pickLearnTurns } from '../skills/thread-evidence';
import {
  casesFor, correctionsToRoute, failuresSinceRewrite, markRewritten, markRouted, recordSkillCases, skillsDueForRewrite,
  type CaseCorrection
} from '../skills/cases';
import { reviewSkillChange } from '../skills/review';
import { rewriteSkill } from '../skills/rewrite';
import { readSkillRecord } from '../skills/store';
import { CURATED_ORIGINS } from '../skills/curate';
import { isRecallEnabled } from '../workspace/memory';
import { whereSkillsRun } from '../workspace/bootstrap';
import type { PiRuntime } from '../pi/runtime';
import type { SettledTurnTrace } from '../pi/normalize';
import type { ChatBackend } from '../backend';
import type { LlmClient } from '../recall/llm';

/**
 * Skills: the assistant's manage_skill tool, and the pass that runs after a turn
 * did real work.
 *
 * Both funnel into the same SkillBridge, on purpose. The contract validator, the
 * Off/Ask/Auto mode, and the approval card behave identically whether the model
 * asked mid-turn, the end-of-turn pass proposed it, or `/learn` did — so there is
 * one place where "may this be written, and what does the user see" is decided,
 * rather than a rule per surface drifting apart the way the three old writers did.
 *
 * The bridge lives in the server because the pi child cannot reach any of that. The
 * approval hook comes off the runtime because only the runtime knows which turn is
 * live and owns the pending-card bookkeeping a process restart has to tear down.
 */
export function initSkills(deps: {
  runtime: ChatBackend;
  onChanged: () => void;
  /** A create landed (never an update) — see the bridge's onCreated. */
  onCreated?: () => void;
  /** True while a turn is running or the user interacted within `idleMs`. */
  busyWithin: (idleMs: number) => boolean;
}): SkillBridge | null {
  const runtime = deps.runtime as Partial<PiRuntime> & ChatBackend;
  if (typeof runtime.requestSkillApproval !== 'function') {
    // The hermetic E2E fake has no approval plumbing; skills do not run there.
    deps.runtime.setSkillBridge(null);
    return null;
  }
  learnRuntime = runtime;
  learnBusyWithin = deps.busyWithin;

  // The skills model, read fresh per call so a Settings change applies at once.
  const skillsLlm: LlmClient | null =
    typeof runtime.complete === 'function'
      ? { complete: async (prompt) => runtime.complete!(prompt, skillsRunFor(await readSettings())) }
      : null;
  const bridge = new SkillBridge({
    mode: async () => (await readSettings()).skills.mode,
    requestApproval: (proposal, ctx) => runtime.requestSkillApproval!(proposal, ctx),
    onChanged: deps.onChanged,
    onCreated: deps.onCreated,
    // Every change Stem makes to a skill on its own is checked against the
    // skill's recorded uses first (skills/review.ts).
    ...(skillsLlm
      ? { reviewChange: ({ before, after, why }) => reviewSkillChange(skillsLlm, { before, after, why, cases: casesFor(before.slug) }) }
      : {})
  });
  deps.runtime.setSkillBridge(bridge);

  runtime.setTurnSettledHook?.((turn) => {
    // The case comes first and costs no model call: it must exist before the
    // next user message can be captured, or the distill pass could read that
    // message before there is a case to pair it with (skills/cases.ts).
    recordCases(turn);
    scheduleEndOfTurnPass(turn, bridge, runtime, deps.busyWithin);
  });
  learnBridge = bridge;
  return bridge;
}

/**
 * Keep a case for each skill the settled turn followed or reported
 * (skills/cases.ts). Only with memory on: a case holds the user's words, and its
 * outcome is read by the memory distill pass.
 */
function recordCases(turn: SettledTurnTrace): void {
  try {
    if (!isRecallEnabled()) return;
    const slugs = new Set([...turn.skillsGradedUsed, ...(turn.skillsReported ?? []).map((i) => i.slug)]);
    if (slugs.size === 0) return;
    const versions = new Map<string, number>();
    for (const slug of slugs) {
      const record = readSkillRecord(slug);
      if (record) versions.set(slug, record.version);
    }
    recordSkillCases(turn, versions);
  } catch (error) {
    degrade('skills.cases', 'kept no record of one skill use', error);
  }
}

// The pass costs a model call, on a throwaway backend process. `settleTurn` fires
// at agent_end — before pi has finished its own post-run work and before the send
// gate reopens — so running it there would put a spawn and an inference in the
// exact window where the user is most likely to type the next message. Recall's
// passes solve this by yielding to interactive work; this does the same.
const SETTLE_DELAY_MS = 12_000;
const SETTLE_IDLE_MS = 8_000;
/** How many times to wait for quiet before giving up on a turn. */
const SETTLE_MAX_DEFERRALS = 5;

// One at a time. A burst of tool-heavy turns must not stack up N concurrent
// authoring calls, and dropping the older one is right: the newer turn is the one
// the user is still thinking about, and the trace ring keeps only three anyway.
let settleRunning = false;
let settleTimer: NodeJS.Timeout | null = null;

/**
 * Whether the end-of-turn authoring pass is mid-flight. The curate-on-create
 * trigger (startup/recall-tasks.ts) holds off while this is true: a curator merge
 * deletes its losers, and one of those can be the very skill a concurrent settle
 * pass is about to patch — the write refuses cleanly (`expectExisting` on a
 * missing slug), but it refuses silently, and patches are the primary write path
 * now that routing works. Cheaper to sequence the two than to explain the race.
 */
export function isSettlePassRunning(): boolean {
  return settleRunning;
}

function scheduleEndOfTurnPass(
  turn: SettledTurnTrace,
  bridge: SkillBridge,
  runtime: Partial<PiRuntime>,
  busyWithin: (idleMs: number) => boolean,
  deferrals = 0
): void {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    // Still busy — or already authoring the previous turn. Come back, up to a
    // point: a user who never goes quiet should not accumulate a retry loop.
    if ((busyWithin(SETTLE_IDLE_MS) || settleRunning) && deferrals < SETTLE_MAX_DEFERRALS) {
      scheduleEndOfTurnPass(turn, bridge, runtime, busyWithin, deferrals + 1);
      return;
    }
    if (settleRunning) return;
    settleRunning = true;
    void runEndOfTurnPass(turn, bridge, runtime).finally(() => {
      settleRunning = false;
    });
  }, SETTLE_DELAY_MS);
}

// `/learn` arrives on the IPC surface rather than through a turn, so it needs the
// same two objects the end-of-turn pass closes over. Module-level rather than
// threaded through IpcDeps: both are created once at bootstrap and never replaced.
let learnBridge: SkillBridge | null = null;
let learnRuntime: (Partial<PiRuntime> & ChatBackend) | null = null;
let learnBusyWithin: (idleMs: number) => boolean = () => false;

/** The bridge and runtime `/learn` writes through, for the recorder's drafts (startup/record-skills.ts). */
export function userSkillWriter(): { bridge: SkillBridge | null; runtime: (Partial<PiRuntime> & ChatBackend) | null } {
  return { bridge: learnBridge, runtime: learnRuntime };
}

export type LearnResult =
  | { ok: true; slug: string; saved: boolean; message: string }
  | { ok: false; message: string };

/**
 * `/learn [focus]` — save a skill from this chat.
 *
 * Unlike the end-of-turn pass this is the user asking, so it bypasses the gate
 * entirely: a two-tool turn they thought worth keeping is worth keeping, whatever
 * the tool count says. It still goes through the bridge, so `ask` mode still shows
 * the card — the user asked to save *something*, not to skip reading it.
 *
 * The evidence is the whole saved conversation, every argument whole
 * (skills/thread-evidence.ts), not the runtime's ring of the last turn: the
 * procedure is usually spread over several turns, and the ring lost it on the
 * 2026-10-06 invoice chat. It is still what was actually run rather than a
 * summary of it — a procedure invented from a summary is exactly what the old
 * distiller produced. Turns a memorize:false folder touched are left out, and a
 * private chat is refused outright.
 *
 * Every outcome is logged. The user sees the message for a few seconds beside
 * the composer; without a line here, "it learned nothing" has no trace at all.
 */
export async function learnFromChat(threadId: string, focus?: string): Promise<LearnResult> {
  const started = Date.now();
  // quiet: the log line below is the signal; the user gets a plain failure.
  const { result, ...detail } = await learnOutcome(threadId, focus).catch((error: unknown) => ({
    result: { ok: false, message: 'Could not write a skill from this chat.' } as LearnResult,
    reason: 'error',
    detail: error instanceof Error ? error.message : String(error)
  }));
  log('skills', '/learn', { threadId, ok: result.ok, ...detail, ms: Date.now() - started });
  return result;
}

interface LearnOutcome {
  result: LearnResult;
  /** Why it ended where it did, for the log line. */
  reason: string;
  detail?: string;
  turns?: number;
  /** Turns left out: tainted by a private folder, or past the evidence budget. */
  excluded?: number;
  dropped?: number;
  skill?: string;
  patched?: boolean;
}

async function learnOutcome(threadId: string, focus?: string, conventions?: string[], earlier = false): Promise<LearnOutcome> {
  // The convention pass (learnConventions) runs this same path as Stem's own
  // idea rather than the user's request: the author may decline, the write is
  // initiatedBy 'assistant' (so `ask` shows a card), and mail conversations are
  // in scope, because drafting for the user is where most conventions live.
  const convention = (conventions?.length ?? 0) > 0;
  const bridge = learnBridge;
  const runtime = learnRuntime;
  if (!bridge || !runtime?.learnEvidence) {
    return { result: { ok: false, message: 'Saving skills is unavailable right now.' }, reason: 'unavailable' };
  }
  // A store that will not read counts as private, as it does for the turn itself.
  const isPrivate = await isChatPrivate(threadId).catch((error: unknown) => {
    degrade('skills.learn', 'refused /learn because the chat store could not be read', error);
    return true;
  });
  if (isPrivate) {
    return {
      result: { ok: false, message: 'This is a private chat, so Stem saves nothing from it — skills included.' },
      reason: 'private'
    };
  }
  // A thread behind a mail conversation or a scheduled run is not a chat, and
  // its privacy is not on the chat store: a private mail conversation marks its
  // deliveries, not their threads. /learn is a chat command, so it stays out.
  const mailOwned = await (convention ? threadsClosedToLearning() : mailSessionThreadIds()).catch((error: unknown) => {
    degrade('skills.learn', 'refused /learn because the mail store could not be read', error);
    return null;
  });
  if (!mailOwned || mailOwned.has(threadId)) {
    return { result: { ok: false, message: '/learn works in chats, not in mail or scheduled runs.' }, reason: 'mail' };
  }

  const all = (await runtime.learnEvidence(threadId)) ?? [];
  const clean = all.filter((turn) => !turn.tainted);
  if (clean.length === 0) {
    return all.length > 0
      ? {
          result: { ok: false, message: 'This chat read a folder you asked Stem not to memorise, so nothing was saved from it.' },
          reason: 'tainted',
          turns: all.length
        }
      : { result: { ok: false, message: 'There is nothing in this chat to learn from yet.' }, reason: 'empty' };
  }
  const { kept, dropped } = pickLearnTurns(clean);
  const latest = kept[kept.length - 1];
  const counts = { turns: kept.length, excluded: all.length - clean.length, dropped };

  // Routing still comes off the ring when it holds the newest turn shown here:
  // which skill that turn followed, or reported as wrong. Only that turn — a
  // reported issue is the model's own words, and from a turn left out above they
  // would carry what it read into the prompt. Without it the author reads the
  // library and names its own target, as the end-of-turn pass does.
  const ring = runtime.recentTurnTrace?.(threadId) ?? null;
  const recent = ring && !ring.memoryTainted && ring.turnId === latest.turnId ? ring : null;
  const turn: SettledTurnTrace = {
    threadId,
    turnId: latest.turnId ?? '',
    endedAt: Date.now(),
    userText: latest.userText,
    assistantText: latest.assistantText,
    trace: latest.trace,
    skillsInjected: recent?.skillsInjected ?? [],
    skillsGradedUsed: recent?.skillsGradedUsed ?? [],
    skillsReported: recent?.skillsReported ?? [],
    memoryTainted: false,
    isScheduled: false
  };

  const settings = await readSettings();
  const llm: LlmClient = {
    complete: async (prompt) => runtime.complete!(prompt, skillsRunFor(settings))
  };
  // Same resolution as the end-of-turn pass, through the same helper: patch what
  // the turn was graded as following, and otherwise let the author read the
  // library and name its own target (settle.ts owns both halves).
  const reported = routeReported(turn);
  const existing = reported?.existing ?? firstExistingSkill(turn.skillsGradedUsed);
  const author = await authorForTurn(turn, llm, {
    existing,
    issue: reported?.issue,
    focus,
    earlier: kept.slice(0, -1),
    requested: !convention,
    conventions
  });
  if (!author.ok) {
    return {
      result: {
        ok: false,
        message:
          author.reason === 'declined'
            ? `Nothing reusable in this chat — ${author.detail}.`
            : // A target that could not be honoured is the one non-failure here: the
              // author decided this belonged in a skill that has since gone.
              author.reason === 'target'
              ? `Nothing new to save — that procedure ${author.detail}.`
              : 'Could not write a skill from this chat.'
      },
      reason: author.reason,
      detail: author.detail,
      ...counts
    };
  }

  const result = await bridge.handleRequest(
    {
      op: 'save',
      initiatedBy: convention ? 'assistant' : 'user',
      name: author.draft.name,
      description: author.draft.description,
      body: author.draft.body,
      tools: author.draft.tools,
      // A patch — routed by grading or chosen by the author — writes with
      // `expect_existing`, so a skill that vanished between the model call and the
      // write refuses instead of quietly creating itself from a patch-shaped draft.
      expectExisting: author.patched,
      origin: convention ? 'turn' : 'learn',
      ...(convention && author.patched ? { change: `Added how you want this work done: ${conventions![0]}` } : {})
    },
    { isScheduled: false, ...(convention && !earlier ? { threadId } : {}) }
  );
  return {
    result: { ok: result.ok, slug: author.draft.name, saved: result.ok, message: result.text } as LearnResult,
    reason: result.ok ? 'saved' : 'refused',
    ...(result.ok ? {} : { detail: result.text }),
    skill: author.draft.name,
    patched: author.patched,
    ...counts
  };
}

/**
 * The convention pass: memory just learned how the user wants something done
 * (preference facts from a distill pass), so offer each conversation's new
 * preferences to the skill author, which folds a way-of-working into the skill
 * for that work and declines tastes and one-offs (author.ts
 * SKILL_CONVENTION_INSTRUCTIONS).
 *
 * This is how corrections become skills on turns the end-of-turn pass never
 * sees: "sign it as Stem, on behalf of me" arrives with no tool calls at all.
 * Detection is the distiller's, which already reads every turn and was already
 * told to record exactly these ("a stated correction like 'you didn't check X;
 * I want that included in the future'"), so it costs no extra call per turn,
 * only one authoring call per conversation that produced a preference.
 *
 * One conversation at a time, after the end-of-turn pass and while the user is
 * quiet, for the same reasons that pass waits (see scheduleEndOfTurnPass).
 */
export function learnConventions(byThread: Map<string, string[]>, opts: { earlier?: boolean } = {}): Promise<void> {
  for (const [threadId, texts] of byThread) {
    const pending = conventionQueue.get(threadId);
    // `earlier`: preferences from before this pass existed (the backfill). Their
    // card, in ask mode, is not tied to that old chat, where nobody would see it.
    conventionQueue.set(threadId, { texts: [...(pending?.texts ?? []), ...texts], earlier: (pending?.earlier ?? true) && opts.earlier === true });
  }
  conventionsDrain ??= drainConventions().finally(() => {
    conventionsDrain = null;
    // Queued after the loop's last look: start again rather than strand it.
    if (conventionQueue.size > 0) void learnConventions(new Map());
  });
  return conventionsDrain;
}

const conventionQueue = new Map<string, { texts: string[]; earlier: boolean }>();
let conventionsDrain: Promise<void> | null = null;
const CONVENTION_IDLE_MS = 8_000;
const CONVENTION_WAIT_MS = 10_000;
/** How long to wait for quiet before running anyway; a convention is never dropped for being busy. */
const CONVENTION_MAX_WAITS = 30;

async function drainConventions(): Promise<void> {
  while (conventionQueue.size > 0) {
    if ((await readSettings()).skills.mode === 'off') {
      conventionQueue.clear();
      return;
    }
    // Never alongside the end-of-turn pass (they share its flag below, taken with
    // no await after this check); past the cap, a user who never goes quiet no
    // longer holds it back.
    for (let waits = 0; settleRunning || (learnBusyWithin(CONVENTION_IDLE_MS) && waits < CONVENTION_MAX_WAITS); waits++) {
      await new Promise((resolve) => setTimeout(resolve, CONVENTION_WAIT_MS));
    }
    // Taken only now, so preferences learned while it waited join the same call.
    const [threadId, { texts, earlier }] = conventionQueue.entries().next().value as [string, { texts: string[]; earlier: boolean }];
    conventionQueue.delete(threadId);
    const started = Date.now();
    // Holding the settle flag keeps the curator from merging away a skill
    // this pass is about to patch (see isSettlePassRunning).
    settleRunning = true;
    try {
      // quiet: the log line below is the signal; nobody is waiting on this.
      const { result, ...detail } = await learnOutcome(threadId, undefined, texts, earlier).catch((error: unknown) => ({
        result: { ok: false, message: '' } as LearnResult,
        reason: 'error',
        detail: error instanceof Error ? error.message : String(error)
      }));
      log('skills', 'convention pass', { threadId, conventions: texts.length, ok: result.ok, ...detail, ms: Date.now() - started });
    } finally {
      settleRunning = false;
    }
  }
}

/**
 * Judge and author from one settled turn, then route the draft through the bridge
 * as the assistant's own idea — so a user on `ask` sees a card and a user on `off`
 * never gets here at all (the gate checks the mode first, to avoid paying for a
 * model call whose answer is already "no").
 *
 * Every failure is swallowed after a log line. This runs behind the user's back
 * on a turn they have already read; there is no reply to attach an error to, and
 * nothing here is worth a visible failure.
 *
 * Which is exactly why every outcome is logged and not just the save. A pass that
 * declined, one whose draft failed the contract twice, one whose model call timed
 * out, and one that never ran at all are four different problems, and without a
 * line each they are one indistinguishable silence — the fire rate this whole
 * design is tuned around becomes unobservable in the only place it is real. So:
 * one line per turn that reaches here, except the two that carry no information
 * (mode `off`, and below the gate with no tool calls at all).
 */
async function runEndOfTurnPass(turn: SettledTurnTrace, bridge: SkillBridge, runtime: Partial<PiRuntime>): Promise<void> {
  try {
    const settings = await readSettings();
    if (settings.skills.mode === 'off') return;
    const llm: LlmClient = {
      complete: async (prompt) => runtime.complete!(prompt, skillsRunFor(settings))
    };
    const outcome = await settleSkills(turn, settings.skills.mode, llm);
    if (!outcome.decision.fire) {
      // Below the gate on a turn that called nothing is the overwhelming majority
      // of turns and says nothing anyone would read; every other skip is a
      // decision worth being able to see afterwards.
      if (turn.trace.length > 0) {
        log('skills', 'end-of-turn pass skipped', {
          threadId: turn.threadId,
          reason: outcome.decision.reason,
          tools: turn.trace.length
        });
      }
      return;
    }
    if (!outcome.author?.ok) {
      log('skills', 'end-of-turn pass wrote nothing', {
        threadId: turn.threadId,
        reason: outcome.author?.reason ?? 'no-outcome',
        detail: outcome.author?.detail,
        attempts: outcome.author?.attempts,
        tools: turn.trace.length,
        // Whichever was true: routed at a skill by grading, or aimed at one the
        // author named and could not be given. Both are worth telling apart from a
        // plain decline when the fire rate is read back off these lines.
        patching: outcome.decision.existing?.name ?? outcome.author?.target
      });
      return;
    }

    const result = await bridge.handleRequest(
      {
        op: 'save',
        initiatedBy: 'assistant',
        name: outcome.author.draft.name,
        description: outcome.author.draft.description,
        body: outcome.author.draft.body,
        tools: outcome.author.draft.tools,
        // See `/learn` above: every patch write is guarded, so a skill deleted or
        // merged away while the author was thinking degrades to a refusal rather
        // than reappearing as a create. After this step patches are the primary
        // write path, so that window is no longer a rare one.
        expectExisting: outcome.author.patched,
        origin: 'turn',
        ...(outcome.author.patched ? { change: endOfTurnChange(outcome.decision) } : {})
      },
      { isScheduled: false }
    );
    log('skills', 'end-of-turn pass', {
      threadId: turn.threadId,
      skill: outcome.author.draft.name,
      patched: outcome.author.patched,
      // Set when the author chose its own target rather than being routed at one.
      chosen: outcome.author.patched && !outcome.decision.existing,
      saved: result.ok,
      ...(result.rejected ? { rejected: result.text } : {})
    });
  } catch (error) {
    log('skills', 'end-of-turn pass failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** The one-line reason kept with a version the end-of-turn pass wrote. */
function endOfTurnChange(decision: Awaited<ReturnType<typeof settleSkills>>['decision']): string {
  if (!decision.fire) return '';
  if (decision.issue) return `Fixed after Stem reported a wrong step: ${decision.issue}`;
  return decision.existing ? 'Improved from a turn that used it' : 'Added what a later turn showed';
}

// ---- revisions from the case file (skills/cases.ts) ----
//
// After each distill pass reads outcomes, two kinds of work can be waiting:
//
//   - a correction: the user said what was wrong with a result of a skill, so
//     that skill gets a patch, with the conversation as evidence;
//   - a rewrite: a skill went wrong REWRITE_AFTER_FAILURES times since its last
//     rewrite, so it is diagnosed and rewritten from all of its cases at once.
//
// Both write through the bridge as Stem's own idea: Off writes nothing, Ask
// shows a card, Auto writes. Both are checked against the cases first
// (review.ts). One at a time, never beside the end-of-turn pass or the
// convention pass (they share `settleRunning`), and only while the user is quiet.

let revisionsDrain: Promise<void> | null = null;

/** Start the revisions drain, or join the one running. Called after each distill pass. */
export function queueSkillRevisions(): Promise<void> {
  revisionsDrain ??= drainRevisions()
    .catch((error: unknown) => degrade('skills.revise', 'stopped revising skills from their uses', error))
    .finally(() => {
      revisionsDrain = null;
    });
  return revisionsDrain;
}

async function drainRevisions(): Promise<void> {
  // Each job is tried once per drain. A job marks itself done in the cases
  // file before its model call; if that write fails, this set is what stops
  // the loop from paying for the same job again and again.
  const tried = new Set<string>();
  for (;;) {
    const bridge = learnBridge;
    const runtime = learnRuntime;
    if (!bridge || !runtime?.complete) return;
    const corrections = correctionsToRoute().filter((c) => !tried.has(`fix:${c.slug}:${c.turnId}`));
    // Rewrites only for Stem's own ideas, the same lock the curator keeps: the
    // user's own skills change by the corrections they made, one at a time.
    const due = skillsDueForRewrite().filter((slug) => {
      if (tried.has(`rewrite:${slug}`)) return false;
      const r = readSkillRecord(slug);
      return !!r && r.enabled && r.source === 'agent' && CURATED_ORIGINS.includes(r.origin);
    });
    if (corrections.length === 0 && due.length === 0) return;
    if ((await readSettings()).skills.mode === 'off') {
      // Stem takes no initiative in this mode. The corrections are spent rather
      // than kept for later: a correction from weeks ago is not news.
      markRouted(corrections);
      return;
    }
    for (let waits = 0; settleRunning || (learnBusyWithin(CONVENTION_IDLE_MS) && waits < CONVENTION_MAX_WAITS); waits++) {
      await new Promise((resolve) => setTimeout(resolve, CONVENTION_WAIT_MS));
    }
    const settings = await readSettings();
    const llm: LlmClient = { complete: async (prompt) => runtime.complete!(prompt, skillsRunFor(settings)) };
    const started = Date.now();
    settleRunning = true;
    try {
      // A rewrite first: it reads every case, the uncorrected ones included.
      if (due.length > 0) {
        const slug = due[0];
        tried.add(`rewrite:${slug}`);
        for (const c of corrections) if (c.slug === slug) tried.add(`fix:${c.slug}:${c.turnId}`);
        const detail = await rewriteFromCases(slug, bridge, llm);
        log('skills', 'rewrite pass', { skill: slug, ...detail, ms: Date.now() - started });
      } else {
        const c = corrections[0];
        tried.add(`fix:${c.slug}:${c.turnId}`);
        // Spent before the model call, so a crash or an error cannot repeat it.
        markRouted([c]);
        // quiet: the log line below carries the error; the correction is spent.
        const detail = await reviseFromCorrection(c, bridge, runtime, llm).catch((error: unknown) => ({
          reason: 'error',
          detail: error instanceof Error ? error.message : String(error)
        }));
        log('skills', 'correction pass', { skill: c.slug, threadId: c.threadId, outcome: c.outcome, ...detail, ms: Date.now() - started });
      }
    } finally {
      settleRunning = false;
    }
  }
}

/** The line a correction leaves with the new version, and the reason shown to the check. */
function correctionText(c: CaseCorrection): string {
  return c.feedback || (c.outcome === 'redone' ? 'The user asked for the same thing again because the result did not work.' : 'The user corrected the result.');
}

/**
 * Patch the corrected skill. The evidence is the conversation from the turn
 * that used the skill to the end: the use, the correction, and what the
 * assistant did after it. Same privacy rules as the convention pass.
 */
async function reviseFromCorrection(
  c: CaseCorrection,
  bridge: SkillBridge,
  runtime: Partial<PiRuntime> & ChatBackend,
  llm: LlmClient
): Promise<{ reason: string; detail?: string; turns?: number }> {
  const record = readSkillRecord(c.slug);
  // An import is the user's file as they installed it: its fixes come from
  // upstream or from the user asking, never from here.
  if (!record || !record.enabled || record.origin === 'imported') return { reason: 'not-patchable' };
  const isPrivate = await isChatPrivate(c.threadId).catch((error: unknown) => {
    degrade('skills.revise', 'skipped a correction because the chat store could not be read', error);
    return true;
  });
  if (isPrivate) return { reason: 'private' };
  const closed = await threadsClosedToLearning().catch((error: unknown) => {
    degrade('skills.revise', 'skipped a correction because the mail store could not be read', error);
    return null;
  });
  if (!closed || closed.has(c.threadId)) return { reason: 'closed' };
  const turns = (await runtime.learnEvidence?.(c.threadId)) ?? [];
  const at = turns.findIndex((t) => t.turnId === c.turnId);
  if (at < 0) return { reason: 'turn-gone' };
  const { kept } = pickLearnTurns(turns.slice(at).filter((t) => !t.tainted));
  if (kept.length === 0) return { reason: 'tainted' };
  const latest = kept[kept.length - 1];
  const turn: SettledTurnTrace = {
    threadId: c.threadId,
    turnId: latest.turnId ?? '',
    endedAt: Date.now(),
    userText: latest.userText,
    assistantText: latest.assistantText,
    trace: latest.trace,
    skillsInjected: [],
    skillsGradedUsed: [],
    skillsReported: [],
    memoryTainted: false,
    isScheduled: false
  };
  const correction = correctionText(c);
  const author = await authorForTurn(turn, llm, {
    existing: { name: record.slug, description: record.description, body: record.body },
    correction,
    earlier: kept.slice(0, -1)
  });
  if (!author.ok) return { reason: author.reason, detail: author.detail, turns: kept.length };
  const result = await bridge.handleRequest(
    {
      op: 'save',
      initiatedBy: 'assistant',
      name: author.draft.name,
      description: author.draft.description,
      body: author.draft.body,
      tools: author.draft.tools,
      expectExisting: true,
      origin: 'turn',
      change: `Changed after your correction: ${correction}`
    },
    { isScheduled: false, threadId: c.threadId }
  );
  return { reason: result.ok ? 'saved' : result.rejected ? 'rejected' : 'refused', ...(result.ok ? {} : { detail: result.text }), turns: kept.length };
}

/** Diagnose and rewrite one skill from all of its cases. */
async function rewriteFromCases(slug: string, bridge: SkillBridge, llm: LlmClient): Promise<{ reason: string; detail?: string; failures?: number }> {
  const record = readSkillRecord(slug);
  const cases = casesFor(slug);
  const failures = failuresSinceRewrite(slug).length;
  // Spent whatever happens next: a declined or rejected rewrite is a verdict on
  // these failures too, and asking again needs new ones. The corrections among
  // them are read by the rewrite, so they are not also patched one by one.
  markRewritten(slug);
  markRouted(correctionsToRoute().filter((c) => c.slug === slug));
  if (!record) return { reason: 'gone' };
  const outcome = await rewriteSkill(llm, record, cases, whereSkillsRun());
  if (!outcome.ok) return { reason: outcome.reason, detail: outcome.detail, failures };
  const result = await bridge.handleRequest(
    {
      op: 'save',
      initiatedBy: 'assistant',
      name: outcome.draft.name,
      description: outcome.draft.description,
      body: outcome.draft.body,
      tools: outcome.draft.tools,
      expectExisting: true,
      origin: 'turn',
      change: `Rewritten from ${cases.length} recorded uses, ${failures} of which went wrong`
    },
    { isScheduled: false }
  );
  return { reason: result.ok ? 'saved' : result.rejected ? 'rejected' : 'refused', ...(result.ok ? {} : { detail: result.text }), failures };
}
