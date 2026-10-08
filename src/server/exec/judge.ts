import type { DefaultsSettings, ExecSettings, HostShell, ModelSummary } from '../../shared/types';
import type { ChatBackend } from '../backend/types';
import { resolveRoleEffort } from '../../shared/modelRoles';
import { log } from '../log';
import { hostShellFromPlatform } from './host-shell';
import { buildJudgePrompt, parseJudgeVerdict, resolveJudgeModel } from './policy';
import type { JudgeContext } from './judge-context';
import type { StageRecord } from './decisions';

// The LLM safety judge, shared by run_command (ExecService) and coding-agent
// permission asks (HarnessService). It is a heuristic, not a security boundary —
// the hard gates are the protected-roots scan and the manual approval tier.

// complete() spawns a throwaway pi process per call and may queue behind Recall
// distillation completes, so cold-start alone can eat >10s — 15s timed out in
// practice and dumped perfectly fine commands onto approval cards. Windows
// Electron-as-Node cold start needs more headroom than 30s (Windows especially).
export const JUDGE_TIMEOUT_MS = 60_000;
/** Stage 2 thinks at High before it answers: more time, on the few commands it sees. */
export const JUDGE_STAGE2_TIMEOUT_MS = 120_000;

/** listModels() is an RPC to the backend; cache it — the judge runs per command. */
const MODELS_CACHE_TTL_MS = 5 * 60_000;

/**
 * Why the safety check couldn't answer, in words the approval card can use.
 * The exception text itself goes to the log — `pi exited (code 1, signal null)`
 * is a cause for us, not for someone deciding whether to run a command. Returns
 * undefined when there is nothing to add beyond "it could not run", which the
 * card already says.
 */
export function judgeFailureReason(detail: string): string | undefined {
  // Lowercase fragments: the card renders these after "…could not run: ".
  const lower = detail.toLowerCase();
  if (lower.includes('timed out')) return 'it did not answer in time';
  if (lower.includes('no api key') || lower.includes('unknown provider') || lower.includes('not found'))
    return 'no model was available to run it';
  if (lower.includes('could not be located')) return 'the pi backend could not start';
  return undefined;
}

export type JudgeResult = {
  verdict: 'safe' | 'unsafe' | 'unsure' | 'failed';
  reason?: string;
  /** The stage-1 prompt as the model read it, for the decision log. */
  prompt?: string;
  stage1?: StageRecord;
  stage2?: StageRecord;
};

export interface JudgeRequest {
  command: string;
  cwd: string;
  settings: Pick<ExecSettings, 'judgeModel' | 'judgeEffort' | 'judgeAllow' | 'judgeDeny' | 'judgeEnvironment'>;
  defaults: DefaultsSettings;
  /** The user's words and the agent's earlier commands (judge-context.ts). */
  context: JudgeContext;
  currentModel?: string | null;
  shell?: HostShell | NodeJS.Platform;
  /**
   * Set for a device-targeted command: the judge must reason about the shell
   * that will actually run it, on the machine it will actually run on.
   */
  shellLabel?: string;
}

export type JudgeFn = SafetyJudge['judge'];

export class SafetyJudge {
  private readonly deps: { runtime: () => ChatBackend };
  private modelsCache: { at: number; models: ModelSummary[] } | null = null;

  constructor(deps: { runtime: () => ChatBackend }) {
    this.deps = deps;
    this.judge = this.judge.bind(this);
  }

  private async listModelsCached(): Promise<ModelSummary[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_CACHE_TTL_MS) {
      return this.modelsCache.models;
    }
    // quiet: an empty list is not an empty answer here. resolveJudgeModel returns
    // null for it and complete() then picks its own default, which is the same
    // model it would have chosen; the cache is left unset so the next judge
    // asks again. A backend that is properly down fails at complete(), where the
    // judge's own catch escalates to an approval card.
    const models = await this.deps.runtime().listModels().catch(() => []);
    if (models.length) this.modelsCache = { at: Date.now(), models };
    return models;
  }

  /**
   * Two stages, after Claude Code's auto-mode classifier. Stage 1 answers in
   * one word at the judge's own effort and clears most commands. Only what it
   * does not call safe goes to stage 2: the same prompt, thinking at High, the
   * verdict on its last line. A small model reading fast blocks too much;
   * reasoning undoes most of that without telling it to trust the agent.
   */
  async judge(req: JudgeRequest): Promise<JudgeResult> {
    const promptInput = {
      command: req.command,
      cwd: req.cwd,
      shell: req.shell ?? hostShellFromPlatform(),
      shellLabel: req.shellLabel,
      userWords: req.context.userWords,
      actions: req.context.actions,
      rules: { allow: req.settings.judgeAllow, deny: req.settings.judgeDeny, environment: req.settings.judgeEnvironment }
    };
    const prompt = buildJudgePrompt(promptInput, 1);
    let model: string | null;
    const started = Date.now();
    let stage1: StageRecord;
    try {
      // The shared background model if one is set, else the live chat's own —
      // resolveJudgeModel only answers null when it was handed no models at all,
      // and complete() then uses its own default, which is the best available
      // answer anyway.
      model = resolveJudgeModel(req.settings, req.defaults, await this.listModelsCached(), req.currentModel ?? null);
      const reply = await this.deps.runtime().complete(prompt, {
        model,
        // The judge sits between you and every command you run, so it feels the
        // effort setting more than any other role does — its own if it has been
        // given one, else the shared Quick tasks level, else Low.
        effort: resolveRoleEffort('judge', req.settings.judgeEffort, req.defaults.backgroundEffort),
        timeoutMs: JUDGE_TIMEOUT_MS,
        priority: true
      });
      stage1 = { ...parseJudgeVerdict(reply), ms: Date.now() - started };
    } catch (e) {
      // quiet: failure() logs it, and the 'failed' verdict hands the command to the user.
      return { ...failure(e), prompt, stage1: { verdict: 'failed', ms: Date.now() - started } };
    }
    if (stage1.verdict === 'safe') return { verdict: 'safe', reason: stage1.reason, prompt, stage1 };

    // Stage 2 is a vote of up to three: one sample of a small model swung the
    // same command between safe and unsafe across runs (2026-10-08 eval: 10 of
    // 595 commands blocked in only one run of three). Two run at once; a third
    // breaks a tie. Two safe votes run the command.
    const started2 = Date.now();
    const sample = async (): Promise<StageRecord> => {
      const t = Date.now();
      try {
        const reply = await this.deps.runtime().complete(buildJudgePrompt(promptInput, 2), {
          model,
          effort: 'high',
          timeoutMs: JUDGE_STAGE2_TIMEOUT_MS,
          priority: true
        });
        return { ...parseJudgeVerdict(reply, 'last'), ms: Date.now() - t };
      } catch (e) {
        // quiet: logged here and counted as a vote that cleared nothing — stage 2
        // only ever widens what runs, so a lost sample keeps the command with the user.
        log('exec', 'judge stage 2 sample failed', { error: (e instanceof Error ? e.message : String(e)).trim() });
        return { verdict: 'failed', ms: Date.now() - t };
      }
    };
    const votes = await Promise.all([sample(), sample()]);
    if ((votes[0]!.verdict === 'safe') !== (votes[1]!.verdict === 'safe')) votes.push(await sample());
    const safe = votes.filter((v) => v.verdict === 'safe').length >= 2;
    const answered = votes.filter((v) => v.verdict !== 'failed');
    const stage2: StageRecord = {
      ...(safe
        ? votes.find((v) => v.verdict === 'safe')!
        : (answered.find((v) => v.verdict !== 'safe') ?? { verdict: 'failed' as const })),
      ms: Date.now() - started2,
      votes: votes.map((v) => v.verdict)
    };
    if (safe) return { verdict: 'safe', reason: stage2.reason, prompt, stage1, stage2 };
    // Every sample failed: stage 1's answer stands.
    if (!answered.length) return { verdict: stage1.verdict, reason: stage1.reason, prompt, stage1, stage2 };
    return { verdict: stage2.verdict, reason: stage2.reason, prompt, stage1, stage2 };
  }
}

function failure(e: unknown): JudgeResult {
  const detail = (e instanceof Error ? e.message : String(e)).trim() || 'unknown error';
  log('exec', 'judge failed — escalating to approval', { error: detail });
  const reason = judgeFailureReason(detail);
  return reason ? { verdict: 'failed', reason } : { verdict: 'failed' };
}
