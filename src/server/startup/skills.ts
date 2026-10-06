import { SkillBridge } from '../skills/bridge';
import { authorForTurn, firstExistingSkill, routeReported, settleSkills } from '../skills/settle';
import { readSettings, skillsRunFor } from '../workspace/settings';
import { log } from '../log';
import { degrade } from '../degrade';
import { isChatPrivate } from '../workspace/chats';
import { mailSessionThreadIds } from '../workspace/mail';
import { pickLearnTurns } from '../skills/thread-evidence';
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

  const bridge = new SkillBridge({
    mode: async () => (await readSettings()).skills.mode,
    requestApproval: (proposal, ctx) => runtime.requestSkillApproval!(proposal, ctx),
    onChanged: deps.onChanged,
    onCreated: deps.onCreated
  });
  deps.runtime.setSkillBridge(bridge);

  runtime.setTurnSettledHook?.((turn) => scheduleEndOfTurnPass(turn, bridge, runtime, deps.busyWithin));
  learnBridge = bridge;
  return bridge;
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

async function learnOutcome(threadId: string, focus?: string): Promise<LearnOutcome> {
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
  const mailOwned = await mailSessionThreadIds().catch((error: unknown) => {
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
    requested: true
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
      initiatedBy: 'user',
      name: author.draft.name,
      description: author.draft.description,
      body: author.draft.body,
      // A patch — routed by grading or chosen by the author — writes with
      // `expect_existing`, so a skill that vanished between the model call and the
      // write refuses instead of quietly creating itself from a patch-shaped draft.
      expectExisting: author.patched,
      origin: 'learn'
    },
    { isScheduled: false }
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
        // See `/learn` above: every patch write is guarded, so a skill deleted or
        // merged away while the author was thinking degrades to a refusal rather
        // than reappearing as a create. After this step patches are the primary
        // write path, so that window is no longer a rare one.
        expectExisting: outcome.author.patched,
        origin: 'turn'
      },
      { isScheduled: false }
    );
    log('skills', 'end-of-turn pass', {
      threadId: turn.threadId,
      skill: outcome.author.draft.name,
      patched: outcome.author.patched,
      // Set when the author chose its own target rather than being routed at one.
      chosen: outcome.author.patched && !outcome.decision.existing,
      saved: result.ok
    });
  } catch (error) {
    log('skills', 'end-of-turn pass failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
