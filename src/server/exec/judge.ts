import type { DefaultsSettings, ExecSettings, HostShell, ModelSummary } from '../../shared/types';
import type { ChatBackend } from '../backend/types';
import { resolveRoleEffort } from '../../shared/modelRoles';
import { log } from '../log';
import { hostShellFromPlatform } from './host-shell';
import { buildJudgePrompt, parseJudgeVerdict, resolveJudgeModel } from './policy';

// The LLM safety judge, shared by run_command (ExecService) and coding-agent
// permission asks (HarnessService). It is a heuristic, not a security boundary —
// the hard gates are the protected-roots scan and the manual approval tier.

// complete() spawns a throwaway pi process per call and may queue behind Recall
// distillation completes, so cold-start alone can eat >10s — 15s timed out in
// practice and dumped perfectly fine commands onto approval cards. Windows
// Electron-as-Node cold start needs more headroom than 30s (Windows especially).
export const JUDGE_TIMEOUT_MS = 60_000;

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

export type JudgeResult = { verdict: 'safe' | 'unsafe' | 'unsure' | 'failed'; reason?: string };

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

  async judge(
    command: string,
    cwd: string,
    settings: Pick<ExecSettings, 'judgeModel' | 'judgeEffort'>,
    defaults: DefaultsSettings,
    userIntent?: string,
    currentModel?: string | null,
    shell: HostShell | NodeJS.Platform = hostShellFromPlatform(),
    // Set for a device-targeted command: the judge must reason about the shell
    // that will actually run it, on the machine it will actually run on.
    shellLabel?: string
  ): Promise<JudgeResult> {
    try {
      const runtime = this.deps.runtime();
      const models = await this.listModelsCached();
      // The shared background model if one is set, else the live chat's own —
      // resolveJudgeModel only answers null when it was handed no models at all,
      // and complete() then uses its own default, which is the best available
      // answer anyway.
      const model = resolveJudgeModel(settings, defaults, models, currentModel ?? null);
      const reply = await runtime.complete(buildJudgePrompt(command, cwd, userIntent, shell, shellLabel), {
        model,
        // The judge sits between you and every command you run, so it feels the
        // effort setting more than any other role does — its own if it has been
        // given one, else the shared Quick tasks level, else Low.
        effort: resolveRoleEffort('judge', settings.judgeEffort, defaults.backgroundEffort),
        timeoutMs: JUDGE_TIMEOUT_MS,
        priority: true
      });
      return parseJudgeVerdict(reply);
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).trim() || 'unknown error';
      log('exec', 'judge failed — escalating to approval', { error: detail });
      const reason = judgeFailureReason(detail);
      return reason ? { verdict: 'failed', reason } : { verdict: 'failed' };
    }
  }
}
