import type { SettledTurnTrace } from '../pi/normalize';
import type { LlmClient } from '../recall/llm';
import type { SkillsMode } from '../../shared/types';
import { authorSkill, type AuthorCandidate, type AuthorOutcome, type AuthorTurn } from './author';
import { listSkillRecords, readSkillRecord } from './store';
import { whereSkillsRun } from '../workspace/bootstrap';

// The end-of-turn pass: after a turn that did real work, decide whether it left
// behind a procedure worth keeping.
//
// The gate in front of the model call is deterministic and cheap, and that is the
// whole point. Backtested over 547 turns of local history, 73% of turns call no
// tools at all — so a tool-count gate is free on nearly three turns in four, and
// the model is only asked the expensive question about the ~12% where something
// actually happened. The alternative, asking on every turn, is what the previous
// system did, and it produced 25 skills of which 23 were never used.
//
// One clause the backtest killed: "or the turn recovered from an error". It reads
// well — a procedure someone got right only after a dead end is exactly the kind
// worth saving — but all five recovery turns in the corpus already had four or
// more tool calls, so the clause added no coverage at all. Dead-end-and-recover
// is a coding-agent shape; this is a personal assistant. Recovery still earns its
// keep in ROUTING (a turn that loaded a skill and then failed should patch it),
// just not in firing.

/**
 * Tool calls a turn needs before it is worth a model call. Backtest: >=4 fires on
 * 12.2% of turns, >=6 on 9.0%. Five splits them, and is the number to re-derive
 * against the corpus rather than argue about — the harvester in
 * scripts/skill-fixtures.mjs rebuilds the same sample.
 */
export const SKILL_GATE_MIN_TOOL_CALLS = 5;

export type SettleDecision =
  | { fire: false; reason: 'below-gate' | 'tainted' | 'scheduled' | 'mode-off' }
  | { fire: true; existing?: { name: string; description: string; body: string }; issue?: string };

/**
 * Should this turn be offered to the author, and as a create or a patch?
 *
 * Pure and separately testable on purpose: the reasons a turn is skipped are the
 * part worth pinning, and three of the four are about restraint rather than cost.
 * `tainted` means the turn read inside a folder the user marked do-not-memorize —
 * a skill written from it would launder that content into a file that is injected
 * on later turns, which is exactly what the flag exists to prevent. `scheduled`
 * means nobody is watching, so neither a card nor a silent write is honest.
 */
export function decideSettle(turn: SettledTurnTrace, mode: SkillsMode): SettleDecision {
  if (mode === 'off') return { fire: false, reason: 'mode-off' };
  if (turn.memoryTainted) return { fire: false, reason: 'tainted' };
  if (turn.isScheduled) return { fire: false, reason: 'scheduled' };

  // The model REPORTED a loaded skill as wrong. That is the strongest routing
  // signal there is — its own verdict, naming the skill — and it is worth a
  // patch regardless of how many tools the turn called: the gate exists to keep
  // the author off turns where nothing happened, and a skill that misled the
  // model is something that happened. It also outranks grading below, because a
  // turn can overlap a skill's tools and still have found its steps wrong.
  const reported = routeReported(turn);
  if (reported) return { fire: true, ...reported };

  if (turn.trace.length < SKILL_GATE_MIN_TOOL_CALLS) return { fire: false, reason: 'below-gate' };

  // The turn showed evidence of FOLLOWING a skill: improve that one rather than
  // adding a near-duplicate beside it. Where several graded used, take the first
  // — it ranked highest against this message, so it is the one the turn was most
  // likely working from.
  //
  // Only the graded set routes here, and there is deliberately no fallback to the
  // inlined set. Injection is the top-2 of a cosine ranking against the user's
  // message, not a consult: it says what we offered, not what was followed. A
  // blind fallback mis-targets, and the 2026-08-11 turn in SKILLS-UPKEEP.md is the
  // counterexample — the two inlined skills were both wrong, the right one was
  // name-only in the index, and `authorSkill` force-renames a draft to whatever it
  // was routed at. Falling back would have written the video-transcript procedure
  // into a skill about trailer music. When nothing graded used, the author is
  // shown the library instead and picks its own target (see `authorForTurn`).
  const existing = firstExistingSkill(turn.skillsGradedUsed);
  return existing ? { fire: true, existing } : { fire: true };
}

/**
 * The patch target a turn's own report names, with the reason, or undefined when
 * nothing was reported or the reported skill is gone. Shared by the end-of-turn
 * pass and `/learn` so a report resolves the same way on both surfaces.
 */
export function routeReported(
  turn: Pick<SettledTurnTrace, 'skillsReported'>
): { existing: { name: string; description: string; body: string }; issue: string } | undefined {
  for (const issue of turn.skillsReported ?? []) {
    const existing = firstExistingSkill([issue.slug]);
    if (existing) return { existing, issue: issue.reason };
  }
  return undefined;
}

/**
 * The first of these slugs that still has a file — the skill to improve.
 *
 * `name` is the SLUG, not the front-matter name: the patch path force-renames the
 * draft to it and `saveSkill` uses the name as the directory, so a file whose
 * front-matter drifted from its folder would otherwise turn a patch into a create
 * under a third name — the exact outcome this routing exists to prevent.
 */
export function firstExistingSkill(slugs: string[]): { name: string; description: string; body: string } | undefined {
  for (const slug of slugs) {
    const record = readSkillRecord(slug);
    if (record) return { name: record.slug, description: record.description, body: record.body };
  }
  return undefined;
}

/**
 * What the author is shown when nothing routed: the bodies this turn had loaded,
 * in rank order, plus every other skill by name and description.
 *
 * Both halves are needed and neither is sufficient. The inlined bodies are the
 * only ones it can judge properly — it can read them and see its own procedure —
 * but retrieval picks them by cosine against the user's message, which on
 * 2026-08-11 meant the two wrong ones. The index is where the right one was.
 *
 * Skills the user wrote by hand are left out, and so are disabled ones. A target
 * is a write: folding this turn into a `source: user` file edits something Stem
 * did not author (store.ts keeps the curator and the model off those), and
 * folding it into a disabled skill files the procedure somewhere retrieval will
 * never look again. Neither is a target worth offering, so neither is listed.
 */
function libraryForAuthor(injectedSlugs: string[]): {
  candidates: AuthorCandidate[];
  libraryIndex: { slug: string; description: string }[];
} {
  const candidates: AuthorCandidate[] = [];
  for (const slug of injectedSlugs) {
    const record = readSkillRecord(slug);
    if (!record || record.source !== 'agent' || !record.enabled) continue;
    candidates.push({ slug: record.slug, name: record.name, description: record.description, body: record.body });
  }
  const libraryIndex = listSkillRecords()
    .filter((r) => r.source === 'agent' && r.enabled)
    .map((r) => ({ slug: r.slug, description: r.description }));
  return { candidates, libraryIndex };
}

/**
 * Author from a settled turn: the patch path when something graded used, and
 * otherwise the create path with the library attached and one second shot.
 *
 * Shared with `/learn` (startup/skills.ts) rather than duplicated there, because
 * the two surfaces disagreeing about how a target is resolved is how the routing
 * bug survived — one of the four sites that read the dead `skillsUsed` field was
 * `/learn`, and it went on reading it after the others were repointed.
 *
 * At most two authoring shots. The second only happens when the first came back
 * with a target, and it is the ordinary patch path entered late: `existing` set,
 * the force-rename in `authorSkill` now correct by construction because the model
 * chose the target itself.
 */
export async function authorForTurn(
  turn: SettledTurnTrace,
  llm: LlmClient,
  opts: {
    existing?: { name: string; description: string; body: string };
    issue?: string;
    focus?: string;
    /** `/learn`: the conversation's earlier turns, oldest first. */
    earlier?: AuthorTurn[];
    /** `/learn`: the user asked, so the author decides what to save, not whether. */
    requested?: boolean;
  } = {}
): Promise<AuthorOutcome> {
  const evidence = {
    trace: turn.trace,
    userText: turn.userText,
    assistantText: turn.assistantText,
    focus: opts.focus,
    earlier: opts.earlier,
    requested: opts.requested,
    issue: opts.issue,
    machine: whereSkillsRun()
  };
  if (opts.existing) return authorSkill(llm, { ...evidence, existing: opts.existing });

  const { candidates, libraryIndex } = libraryForAuthor(turn.skillsInjected);
  const first = await authorSkill(llm, { ...evidence, candidates, libraryIndex });
  if (first.ok || first.reason !== 'target' || !first.target) return first;

  // The named skill is re-read here rather than reused from the candidate list:
  // the first shot cost a model call, and a curator merge or a delete can land in
  // that window. Gone means no write at all — the author said this was not a new
  // skill, and inventing one now would be answering a question nobody asked.
  const record = readSkillRecord(first.target);
  if (!record || record.source !== 'agent') {
    return {
      ok: false,
      reason: 'target',
      detail: `named "${first.target}", which is no longer there to patch`,
      target: first.target,
      attempts: first.attempts
    };
  }
  const second = await authorSkill(llm, {
    ...evidence,
    existing: { name: record.slug, description: record.description, body: record.body },
    chosenTarget: true
  });
  // Both shots' attempts, so a log line reads as the whole cost of the turn.
  const attempts = first.attempts + second.attempts;
  return second.ok ? { ...second, attempts } : { ...second, attempts, target: second.target ?? record.slug };
}

export interface SettleOutcome {
  decision: SettleDecision;
  author?: AuthorOutcome;
}

/**
 * Run the pass for one settled turn. Returns what happened without writing
 * anything: the caller routes the draft through the same SkillBridge the live
 * tool uses, so the mode, the card, and the validator all behave identically
 * whichever surface proposed the skill.
 */
export async function settleSkills(
  turn: SettledTurnTrace,
  mode: SkillsMode,
  llm: LlmClient,
  opts: { focus?: string } = {}
): Promise<SettleOutcome> {
  const decision = decideSettle(turn, mode);
  if (!decision.fire) return { decision };
  const author = await authorForTurn(turn, llm, { existing: decision.existing, issue: decision.issue, focus: opts.focus });
  return { decision, author };
}
