import type { DefaultsSettings, ExecSettings, ModelSummary } from './types';

/**
 * Which model actually runs each job, when its own setting is left unset.
 *
 * One chain for the background roles: a role's own pin, else the shared
 * background model, else the model you chat with. Memory takes the short version
 * of it — see {@link resolveMemoryModel}. Shared rather than server-only because
 * the answer is shown as well as used — a picker left unset says underneath what
 * it resolves to today, and the renderer has to reach the same conclusion the
 * server does or the note is a lie the moment the two drift.
 */

/**
 * The app-level default model — what "the model you chat with" resolves to. The
 * backend marks it on the model list it publishes, so this is a read, not a
 * second guess at the rule.
 */
export function appDefaultModel(models: ModelSummary[]): string | null {
  return models.find((m) => m.isDefault)?.id ?? null;
}

/**
 * What memory runs on: its own pin, else the model you chat with — skipping the
 * shared quick-tasks model entirely.
 *
 * The quick-tasks roles are the ones you can safely make cheap. This one reads a
 * whole transcript plus everything already remembered, and a model that cannot
 * hold that doesn't fail loudly; it replies with truncated nonsense and memory
 * stops learning without saying so. Routing it through Quick tasks would
 * mean the one setting whose whole purpose is "make the background cheap" also
 * quietly degrades the one role that can't take it.
 */
export function resolveMemoryModel(pinned: string | null, mainModel: string | null): string | null {
  return pinned ?? mainModel;
}

/**
 * What skills work runs on: its own pin, else the model you chat with — the same
 * short chain as memory, for the same reason.
 *
 * This role used to sit in the shared background group, which inverted the
 * advice printed right above the group picker: "set something small here and
 * stop spending your good model on chat subjects" also silently pointed skill
 * AUTHORING at that small model — the end-of-turn pass, `/learn` and the curator
 * all run on it, and a library written by the cheapest model you own is the
 * failure the skills rebuild exists to prevent. Judgment roles follow the chat
 * model; only extraction roles (subjects, the safety check) belong in the cheap
 * group.
 */
export function resolveSkillsModel(pinned: string | null, mainModel: string | null): string | null {
  return pinned ?? mainModel;
}

/**
 * What a background role runs on: its own pin, else the shared background model,
 * else the model you chat with.
 *
 * This used to guess — it scored model NAMES for "haiku", "mini", "flash" and
 * picked the cheapest-looking one of the current provider. pi's catalog carries
 * no price, tier or size, so that was the only signal available, and it was a
 * bad one: it happily picked a mini variant over a newer small model that was
 * both cheaper and better, and every catalog change was a fresh chance to be
 * wrong. Stem now says what it is doing instead of guessing, and Settings →
 * Models offers one place to point every background job at a cheaper model on
 * purpose.
 */
export function resolveBackgroundModel(
  pinned: string | null,
  backgroundModel: string | null,
  mainModel: string | null
): string | null {
  return pinned ?? backgroundModel ?? mainModel;
}

/**
 * The quick-tasks jobs — the ones that share the cheap model group and carry an
 * effort setting of their own. Just one now: chat subjects, extraction on a
 * latency budget. Skills used to be a member and is not: it is editorial
 * judgment (see {@link resolveSkillsModel}). The safety check is half a member:
 * its quick check runs on Quick tasks, its review does not
 * (see {@link resolveJudgeQuickModel}).
 */
export type BackgroundRole = 'subject';

/**
 * How hard each quick-tasks job thinks when nobody has said anything at all —
 * neither the job nor Quick tasks above it.
 *
 * Not a pin: it is the last rung of the same chain, so setting Quick tasks
 * still moves every job that hasn't been given a level of its own. What it
 * replaces is the old last rung, "whatever pi picks for the model", which for
 * most models is Medium — real reasoning spent on writing three words off your
 * first line, on every new chat, forever.
 *
 * A subject is extraction, not thought: `off` is the honest level for it, and on
 * a model that has no `off` pi clamps up to its lowest instead of failing.
 */
export const ROLE_EFFORT_FLOOR: Record<BackgroundRole, string | null> = {
  subject: 'off'
};

/**
 * How hard a quick-tasks job may think: its own level, else the shared Quick
 * tasks one, else the job's floor above.
 *
 * Shared for the same reason the model chain is: the answer is shown as well as
 * used. An effort select left unset says underneath what it comes out as today,
 * and it has to reach the same conclusion the server does.
 */
export function resolveRoleEffort(
  role: BackgroundRole,
  pinned: string | null,
  backgroundEffort: string | null
): string | null {
  return pinned ?? backgroundEffort ?? ROLE_EFFORT_FLOOR[role];
}

/**
 * How hard the safety check's quick check thinks: its own level, else Low. It
 * answers in front of you on every command it sees, and it only has to clear
 * the obvious ones; the review after a "not safe" thinks at High regardless
 * (judge.ts).
 */
export const JUDGE_EFFORT_DEFAULT = 'low';

export function resolveJudgeEffort(pinned: string | null): string {
  return pinned ?? JUDGE_EFFORT_DEFAULT;
}

/**
 * The model that reviews what the quick check did not clear: the safety
 * check's own pin, else the model running the chat the command came from, else
 * a model we know is signed in. Passing null on to complete() would use its
 * built-in constant, which fails with "No API key" for anyone signed in to a
 * single other provider.
 *
 * This used to be Quick tasks for both passes. 2026-10-09: on gpt-6-luna (a
 * sensible Quick tasks pick) the judge refused "stop devtool, rebuild and start
 * again" because `install.sh` was "not clearly a rebuild script", and ran the
 * user's own retry after "Yes" in 0 of 10 replays. With gpt-6.1-sol reviewing,
 * all three commands ran every time and the same traps stayed blocked
 * (judge-eval). Reading whether a command serves what you meant is judgment.
 */
export function resolveJudgeModel(
  settings: Pick<ExecSettings, 'judgeModel'>,
  models: ModelSummary[],
  currentModel: string | null
): string | null {
  return settings.judgeModel ?? currentModel ?? appDefaultModel(models) ?? models[0]?.id ?? null;
}

/**
 * The model of the quick check: Quick tasks, else the chat's model. A small
 * model is safe here because only its "safe" runs anything, and that errs one
 * way — the same replay had Luna's quick check call none of 85 traps safe. What
 * it wrongly refuses goes to {@link resolveJudgeModel}'s review.
 */
export function resolveJudgeQuickModel(
  defaults: Pick<DefaultsSettings, 'backgroundModel'>,
  models: ModelSummary[],
  currentModel: string | null
): string | null {
  return resolveBackgroundModel(null, defaults.backgroundModel, currentModel) ?? appDefaultModel(models) ?? models[0]?.id ?? null;
}
