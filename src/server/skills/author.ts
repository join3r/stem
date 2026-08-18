import type { LlmClient } from '../recall/llm';
import type { TraceEntry } from '../pi/normalize';
import { SKILL_CONTRACT_TEXT, formatViolations, validateSkill, type SkillDraft, type SkillViolation } from './contract';

// One-shot skill authoring: given what the assistant actually did in a turn, decide
// whether any of it is worth keeping and, if so, write the SKILL.md.
//
// Judging and authoring are the SAME call. Splitting them would double the latency
// and the token cost for a decision that is mostly "no" — and the judge would have
// to be shown the same evidence the author needs anyway. The model answers with a
// skill or with a reason it declined; declining is the expected outcome and the
// prompt says so, because a judge that must justify a "no" learns to say "yes".
//
// On the create path there is a third answer: name an existing skill this belongs
// in. Stem decides create-vs-patch before the model sees anything (unlike Hermes,
// which forks an agent that browses the library itself), and the only affirmative
// routing signal — the graded-used set — is empty on most turns that fire. So when
// nothing routed, the author is handed the library and asked, and its answer comes
// back as `reason: 'target'` for the caller to load and re-ask. See SKILLS-UPKEEP.md.
//
// This is NOT the path used when the user asks for a skill in conversation. There
// the model authors inline in its own turn, where it holds the live thread rather
// than this serialized trace — strictly more context. `authorSkill` exists for the
// cases with no live turn to author from: the end-of-turn pass and `/learn`.

/** A skill the author is shown in full so it can recognize its own procedure in one. */
export interface AuthorCandidate {
  slug: string;
  name: string;
  description: string;
  body: string;
}

/** What the author is shown: the turn, reduced to evidence. */
export interface AuthorInput {
  /** Tool calls in order, with arguments and (truncated) results. */
  trace: TraceEntry[];
  userText: string;
  assistantText: string;
  /** Set when the turn used an existing skill: improve that one instead of adding another. */
  existing?: { name: string; description: string; body: string };
  /**
   * True when `existing` is the skill the author itself named on a first shot,
   * rather than one this turn was graded as having followed. It changes the
   * question: not "did this skill let you down" but "fold what you just did into
   * it", because the author has already decided that is where it belongs.
   */
  chosenTarget?: boolean;
  /**
   * Create path only: the skills whose bodies were inlined this turn, in full.
   * Injection is not evidence the turn followed them — it is the top-2 of a
   * cosine ranking — so these are shown as candidates, not as a routed target.
   */
  candidates?: AuthorCandidate[];
  /** Create path only: every other skill in the library, name + description. */
  libraryIndex?: { slug: string; description: string }[];
  /** Free-text steer from `/learn <focus>` — what the user wants captured. */
  focus?: string;
  /**
   * Which machine this turn ran on, in a sentence (`whereSkillsRun()` in
   * workspace/bootstrap.ts). Passed in rather than read here so this module stays
   * free of the host shim and the eval can build fixtures for either world.
   *
   * The author needs it because a skill is followed somewhere else later. Stem's
   * own library moved from a Mac to a server intact, and every procedure in it
   * that quietly assumed the Mac — its installed programs, its home network, its
   * IP address — became a set of steps that fail with no explanation.
   */
  machine?: string;
}

/**
 * `reason: 'target'` is not a failure so much as a redirect: the author read the
 * library and answered "this belongs in <slug>" instead of drafting. The caller
 * (skills/settle.ts) loads that skill and comes back for a patch. It only ever
 * reaches an outer caller when the named skill cannot be honoured, and then
 * writing nothing is right — the author said this was not a new skill.
 *
 * `target` on the success variant names the skill a patch is patching, so the
 * caller can set `expect_existing` on the write without inferring it from
 * `patched` plus the draft name.
 */
export type AuthorOutcome =
  | { ok: true; draft: SkillDraft; patched: boolean; attempts: number; target?: string }
  | {
      ok: false;
      reason: 'declined' | 'invalid' | 'unparseable' | 'error' | 'target';
      detail: string;
      attempts: number;
      target?: string;
    };

/**
 * When to save a skill at all. Held apart from the contract (what a saved skill
 * must look like, in contract.ts) because they answer different questions and the
 * eval grades them separately: this one decides the fire rate, that one decides
 * the shape. Both are plain template literals with no interpolation, so
 * scripts/skill-author-eval.mjs can lift them verbatim out of the source and grade
 * the prompt that actually ships — the way memory-eval.mjs lifts
 * DISTILL_INSTRUCTIONS. `buildAuthorPrompt` is the only place they are joined.
 */
export const SKILL_AUTHORING_INSTRUCTIONS = `You are deciding whether an assistant's just-finished turn contains a procedure worth saving as a reusable skill, and if it does, writing that skill.

Save a skill only when ALL of these hold:
- The task will plausibly come up again. A recurring shape of request, not a one-off errand.
- Getting it right took something you would not have known in advance: a specific tool, a particular argument, an order that matters, or a dead end that had to be discovered.
- The procedure is general enough to run again with different particulars. If the steps only make sense for this exact person, this exact file, or this exact date, it is not a skill.

Do NOT save:
- Facts about the user, their preferences, or their data. Those are remembered separately and a skill file is the wrong place for them.
- A retelling of what happened. Nobody will read a transcript. If you find yourself writing "then I searched for", stop and write the instruction instead.
- Anything the assistant already knows how to do without notes. Reading a file is not a skill.
- The obvious restatement of a single tool call.

Declining is the normal answer. Most turns contain nothing durable, and a library full of near-misses is worse than a small one: every skill costs context on every turn, and a bad skill will be followed. Decline freely and without justifying yourself at length.

If you do save one, write it from the evidence — the actual arguments that worked, the actual error text that sent you down a different path — not from the assistant's summary of its own work. The summary is where the detail was already lost.

Reply with ONLY a JSON object, no prose and no markdown fences:
{"skill": {"name": "...", "description": "...", "body": "..."}}
or, to decline:
{"skill": null, "reason": "<one short clause>"}`;

/** Extra framing when the turn used an existing skill: improve it, don't fork it. */
export const SKILL_PATCH_INSTRUCTIONS = `This turn already used the skill shown below, so the question is not whether to add a skill — it is whether that one needs fixing.

Return the FULL corrected skill (same name) when the evidence shows a step that was wrong, missing, or ambiguous enough to cost the assistant a detour. Return null when the skill did its job. Do not rewrite it for style, do not add steps you did not just exercise, and do not broaden its scope — a skill that grows every time it is used stops being followable.`;

/**
 * Extra framing on the create path, where nothing routed this turn to a skill.
 *
 * The author is the only thing in Stem that can notice "we already know how to do
 * this". Retrieval put two bodies in front of the turn by cosine rank and the
 * turn may well have ignored both; the skill that actually matches can be sitting
 * in the index under a name nobody read. That is not hypothetical — it is the
 * 2026-08-11 duplicate, where `extract-youtube-transcript` was in the index and a
 * second copy of it got written anyway. So the whole library is shown here, and
 * naming a target is a first-class answer rather than something the model has to
 * volunteer a tool call for.
 */
export const SKILL_LIBRARY_INSTRUCTIONS = `Before you write anything new, read what is already there. The skills below are the whole library: a few in full, because this turn had them loaded, and the rest by name and description.

If the procedure you would write belongs in one of them — the same job, or the same job with a wrinkle this turn just discovered — do not write a second skill beside it. Name that one instead, with ONLY:
{"target": "<the existing skill's name, spelled exactly as listed>"}

You will then be shown that skill in full and asked to fold this turn into it, so you do not have to write the merged version now.

Two write-ups of one procedure is the failure this question exists to catch: nothing merges them afterwards, retrieval has to choose between them, and whichever loses takes its detail with it. But a procedure that merely happens nearby is not the same procedure — a skill that grows a subsection every time something adjacent happens stops being followable. Same job: name it. Neighbouring job: write the new one. Neither: decline.`;

/** Framing for the second shot, once the author's own named target has been loaded. */
export const SKILL_TARGET_PATCH_INSTRUCTIONS = `You named the skill below as where this turn's procedure belongs. Here it is in full.

Return the FULL skill under the SAME name, with this turn folded in: the step that was missing, the argument that turned out to matter, the dead end worth a warning. Keep what is already there unless the evidence shows it wrong, and do not restructure it to make room. Return null if, now that you can read it, the skill already covers what happened — that is an honest answer and it costs nothing.`;

const MAX_ATTEMPTS = 2;

/** One tool call as a line of evidence. Long results are already truncated upstream. */
function renderTraceEntry(entry: TraceEntry, index: number): string {
  const head = `${index + 1}. ${entry.name ?? 'tool'}${entry.isError ? ' → FAILED' : ''}`;
  const lines = [head];
  if (entry.args) lines.push(`   args: ${entry.args}`);
  if (entry.result) lines.push(`   result: ${entry.result.replace(/\n/g, '\n   ')}`);
  return lines.join('\n');
}

/** Assemble the evidence half of the prompt. Exported so the eval can build fixtures. */
export function renderEvidence(input: AuthorInput): string {
  const parts: string[] = [];
  if (input.focus?.trim()) parts.push(`What the user asked to be captured:\n${input.focus.trim()}`);
  // Ahead of the evidence, because it colours how every line of it reads — but
  // behind the /learn focus, which is the user talking and still leads.
  if (input.machine?.trim()) parts.push(`Where this turn ran:\n${input.machine.trim()}`);
  if (input.userText.trim()) parts.push(`The user's message:\n${input.userText.trim()}`);
  parts.push(
    input.trace.length > 0
      ? `What the assistant did, in order:\n${input.trace.map(renderTraceEntry).join('\n')}`
      : 'What the assistant did, in order:\n(no tool calls)'
  );
  if (input.assistantText.trim()) parts.push(`What the assistant replied:\n${input.assistantText.trim()}`);
  if (input.existing) {
    const heading = input.chosenTarget ? 'The skill you named' : 'The skill this turn used';
    parts.push(
      `${heading}:\nname: ${input.existing.name}\ndescription: ${input.existing.description}\n\n${input.existing.body}`
    );
  }
  // The library, when the author is being asked to choose. Bodies first: those
  // are the ones it can judge properly, and a name-and-description line is a
  // weaker claim to be weighed against a body it can read.
  if (input.candidates?.length) {
    parts.push(
      `Skills already loaded in this turn, in full:\n\n${input.candidates
        .map((c) => `name: ${c.slug}\ndescription: ${c.description}\n\n${c.body}`)
        .join('\n\n----\n\n')}`
    );
  }
  if (input.libraryIndex?.length) {
    parts.push(
      `Every skill in the library (name — description):\n${input.libraryIndex
        .map((s) => `- ${s.slug} — ${s.description}`)
        .join('\n')}`
    );
  }
  return parts.join('\n\n');
}

export function buildAuthorPrompt(input: AuthorInput): string {
  const parts = [SKILL_AUTHORING_INSTRUCTIONS];
  if (input.existing) parts.push(input.chosenTarget ? SKILL_TARGET_PATCH_INSTRUCTIONS : SKILL_PATCH_INSTRUCTIONS);
  // Only when there is actually a library to read: an empty list under "read what
  // is already there" invites a target the author cannot have seen.
  else if (input.candidates?.length || input.libraryIndex?.length) parts.push(SKILL_LIBRARY_INSTRUCTIONS);
  parts.push(SKILL_CONTRACT_TEXT, '---', renderEvidence(input));
  return parts.join('\n\n');
}

type ParsedReply =
  | { kind: 'skill'; draft: SkillDraft }
  | { kind: 'target'; slug: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'unparseable' };

/**
 * Read the model's reply. Tolerant of surrounding prose and fences (the JSON is
 * sliced between the outermost braces), strict about the shape inside.
 */
export function parseAuthorReply(output: string): ParsedReply {
  const trimmed = String(output ?? '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return { kind: 'unparseable' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    // quiet: 'unparseable' is carried back through the retry and out as a
    // reason the caller reports — this is the answer, not a lost one.
    return { kind: 'unparseable' };
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'unparseable' };
  // A named target outranks anything else in the reply. A model that answers with
  // both a target and a draft has told us where the procedure belongs and then
  // written it in the wrong place; the second shot writes the right one.
  const target = (parsed as { target?: unknown }).target;
  if (typeof target === 'string' && target.trim()) return { kind: 'target', slug: target.trim() };
  const skill = (parsed as { skill?: unknown }).skill;
  if (skill === null || skill === undefined) {
    const reason = (parsed as { reason?: unknown }).reason;
    return { kind: 'declined', reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'nothing reusable in this turn' };
  }
  if (typeof skill !== 'object') return { kind: 'unparseable' };
  const { name, description, content, body } = skill as Record<string, unknown>;
  // `content` is what manage_skill has always called the body; accept either so a
  // model primed on that tool's schema isn't punished for consistency.
  const text = typeof body === 'string' ? body : typeof content === 'string' ? content : '';
  if (typeof name !== 'string' || typeof description !== 'string' || !text) return { kind: 'unparseable' };
  return { kind: 'skill', draft: { name: name.trim(), description: description.trim(), body: text.trim() } };
}

/** The retry prompt: the original, the rejected draft, and exactly what was wrong. */
export function buildRetryPrompt(base: string, draft: SkillDraft, violations: SkillViolation[]): string {
  return (
    `${base}\n\n---\n\nYour previous answer was rejected. You returned:\n` +
    `name: ${draft.name}\ndescription: ${draft.description}\n\n${draft.body}\n\n` +
    `It broke the contract:\n${formatViolations(violations)}\n\n` +
    'Fix every point above and reply again with the same JSON shape. If the problems are not worth fixing, decline instead.'
  );
}

/**
 * Judge and author in one call, validate, and retry once with the violations.
 *
 * A second failure gives up rather than looping: the retry already showed the
 * model the exact rule it broke, and a model that cannot satisfy the contract
 * twice is not going to on the third pass — it is going to spend tokens producing
 * a skill nobody should keep.
 */
export async function authorSkill(llm: LlmClient, input: AuthorInput): Promise<AuthorOutcome> {
  const base = buildAuthorPrompt(input);
  let prompt = base;
  // What the author was actually shown. A target outside this set is a slug it
  // invented or half-remembered, and honouring one would patch a skill nobody
  // put in front of it — including, if it guessed a name, a file the user wrote
  // by hand. Checked here rather than at the caller so the model gets the one
  // retry that can fix it.
  const offered = new Set([
    ...(input.candidates ?? []).map((c) => c.slug),
    ...(input.libraryIndex ?? []).map((s) => s.slug)
  ]);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let reply: string;
    try {
      reply = await llm.complete(prompt);
    } catch (error) {
      // quiet: the message goes back as the outcome's `detail`, which is what
      // the end-of-turn pass and `/learn` both report.
      return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error), attempts: attempt };
    }

    const parsed = parseAuthorReply(reply);
    if (parsed.kind === 'declined') return { ok: false, reason: 'declined', detail: parsed.reason, attempts: attempt };
    if (parsed.kind === 'target') {
      if (offered.has(parsed.slug)) {
        return { ok: false, reason: 'target', detail: `belongs in "${parsed.slug}"`, target: parsed.slug, attempts: attempt };
      }
      if (attempt === MAX_ATTEMPTS) {
        return { ok: false, reason: 'target', detail: `named "${parsed.slug}", which is not in the library`, attempts: attempt };
      }
      prompt = `${base}\n\n---\n\nYou named "${parsed.slug}", which is not one of the skills listed above. Name one exactly as it is listed, or write the new skill, or decline.`;
      continue;
    }
    if (parsed.kind === 'unparseable') {
      if (attempt === MAX_ATTEMPTS) return { ok: false, reason: 'unparseable', detail: 'the model did not return the JSON shape', attempts: attempt };
      prompt = `${base}\n\n---\n\nYour previous answer was not valid JSON in the required shape. Reply with ONLY the JSON object.`;
      continue;
    }

    // A patch must stay the skill it is patching; a renamed "patch" is a new skill
    // by another name, which is exactly the duplication this path exists to avoid.
    const draft = input.existing ? { ...parsed.draft, name: input.existing.name } : parsed.draft;
    const violations = validateSkill(draft);
    if (violations.length === 0) {
      return { ok: true, draft, patched: !!input.existing, target: input.existing?.name, attempts: attempt };
    }
    if (attempt === MAX_ATTEMPTS) {
      return { ok: false, reason: 'invalid', detail: formatViolations(violations), attempts: attempt };
    }
    prompt = buildRetryPrompt(base, draft, violations);
  }

  // Unreachable: every branch above returns. Kept for the exhaustiveness checker.
  return { ok: false, reason: 'error', detail: 'author loop fell through', attempts: MAX_ATTEMPTS };
}
