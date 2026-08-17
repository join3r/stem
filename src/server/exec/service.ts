import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  DefaultsSettings,
  ExecApprovalRequest,
  ExecDecision,
  ExecSettings,
  HostShell,
  ModelSummary,
  ServerSettings
} from '../../shared/types';
import type { ChatBackend, ExecBridge, ExecBridgeResult, ExecRequest } from '../backend/types';
import { resolveRoleEffort } from '../../shared/modelRoles';
import { log } from '../log';
import { ensureThreadScratch } from './scratch';
import { clampTimeout, execEnv, resolveLoginPath, runCommand } from './executor';
import { gitBashPathEnv, resolveGitBashExecutable, resolveHostShell } from './git-bash';
import { hostShellFromPlatform } from './host-shell';
import { buildJudgePrompt, classify, deviceShellLabel, parseJudgeVerdict, resolveJudgeModel } from './policy';
import { scanProtected } from './protected';
import { execDeviceRouter, resolveExecTarget } from '../exec-device/router';

// Orchestrates one run_command request end to end: settings gate → cwd resolve →
// protected-roots guard → tiered policy (allowlist / LLM judge / approval card) →
// spawn. Lives in main; the backend routes the tool's round-trip here via the
// ExecBridge seam. NOTE the judge is a heuristic, not a security boundary — the
// hard gates are the protected-roots scan and the manual approval tier.

const APPROVAL_TIMEOUT_MS = 120_000;
// complete() spawns a throwaway pi process per call and may queue behind Recall
// distillation completes, so cold-start alone can eat >10s — 15s timed out in
// practice and dumped perfectly fine commands onto approval cards. Windows
// Electron-as-Node cold start needs more headroom than 30s (Windows especially).
export const JUDGE_TIMEOUT_MS = 60_000;
/**
 * Why the safety check couldn't answer, in words the approval card can use.
 * The exception text itself goes to the log — `pi exited (code 1, signal null)`
 * is a cause for us, not for someone deciding whether to run a command. Returns
 * undefined when there is nothing to add beyond "it could not run", which the
 * card already says.
 */
function judgeFailureReason(detail: string): string | undefined {
  // Lowercase fragments: the card renders these after "…could not run: ".
  const lower = detail.toLowerCase();
  if (lower.includes('timed out')) return 'it did not answer in time';
  if (lower.includes('no api key') || lower.includes('unknown provider') || lower.includes('not found'))
    return 'no model was available to run it';
  if (lower.includes('could not be located')) return 'the pi backend could not start';
  return undefined;
}
/** listModels() is an RPC to the backend; cache it — the judge runs per command. */
const MODELS_CACHE_TTL_MS = 5 * 60_000;
/** Concurrent command cap; further tool calls queue rather than forking shells. */
const MAX_CONCURRENT = 2;

export interface ExecServiceDeps {
  runtime: () => ChatBackend;
  readSettings: () => Promise<ServerSettings>;
  updateExecSettings: (patch: Partial<ExecSettings>) => Promise<ServerSettings>;
  /** Surface a pending approval to the renderer(s). */
  emitApprovalRequest: (request: ExecApprovalRequest) => void;
  /** Tell the renderer(s) a pending approval was answered or expired. */
  emitApprovalResolved: (id: string) => void;
  /** Injection seams for tests; default to the wired exec-device router. */
  deviceRouter?: () => import('../exec-device/router').ExecDeviceRouter;
  resolveDevice?: typeof resolveExecTarget;
}

interface PendingApproval {
  threadId: string;
  resolve: (decision: ExecDecision) => void;
  timer: NodeJS.Timeout;
}

interface RunningExec {
  threadId: string;
  controller: AbortController;
}

export class ExecService implements ExecBridge {
  private readonly deps: ExecServiceDeps;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly running = new Set<RunningExec>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private modelsCache: { at: number; models: ModelSummary[] } | null = null;

  constructor(deps: ExecServiceDeps) {
    this.deps = deps;
  }

  async handleExecRequest(req: ExecRequest): Promise<ExecBridgeResult> {
    const command = (req.command ?? '').trim();
    if (!command) return { ok: false, error: 'Provide a command to run.' };

    const all = await this.deps.readSettings();
    const settings = all.exec;
    if (!settings.enabled) {
      return { ok: false, error: 'Command execution is disabled in Settings → Chat → Command execution.' };
    }
    const shell = resolveHostShell(settings);

    // A command aimed at a paired computer takes its own path: same tiers, but
    // classified against that machine's platform and its own allowlist, and
    // executed over the wire instead of here.
    if (req.device?.trim()) return this.handleDeviceExec(command, req.device.trim(), req, all);

    // Resolve + validate the working directory. The default is this CHAT's own
    // scratch folder (see exec/scratch.ts); an explicit relative cwd is resolved
    // against it rather than against the main process's cwd, which means nothing
    // to the assistant.
    const scratch = await ensureThreadScratch(req.threadId);
    let cwd: string;
    if (req.cwd) {
      cwd = resolve(scratch, req.cwd);
      const info = await stat(cwd).catch(() => null);
      if (!info?.isDirectory()) {
        return { ok: false, error: `The requested cwd "${req.cwd}" does not exist or is not a directory.` };
      }
    } else {
      cwd = scratch;
    }

    // Fail-closed read-only guard: any reference to a protected root blocks.
    const guard = scanProtected(command, cwd, undefined, shell);
    if (guard.blocked) return { ok: false, error: guard.reason ?? 'Blocked by the read-only folder guard.' };

    // Yolo mode: everything runs — the protected-roots guard above is the only gate.
    if (settings.approvalMode === 'yolo') return this.run(command, cwd, req, settings);

    // Tier 1: static + user allowlist (every chained segment must clear it).
    const cls = classify(command, settings, shell);
    if (cls.tier !== 'run') {
      // Tier 2 (assisted mode only): one-word LLM judge classification (intent-aware
      // when the turn's user message is known); errors/timeouts escalate. Manual mode
      // skips straight to the card — judgeVerdict stays null so it can say so.
      let judgeVerdict: 'unsafe' | 'unsure' | 'failed' | null = null;
      let judgeReason: string | undefined;
      if (settings.approvalMode === 'assisted') {
        const verdict = await this.judge(command, cwd, settings, all.defaults, req.userText, req.currentModel, shell);
        if (verdict.verdict === 'safe') return this.run(command, cwd, req, settings);
        judgeVerdict = verdict.verdict;
        judgeReason = verdict.reason;
      }
      // Tier 3: the user decides — unless nobody is there to.
      if (req.isScheduled) {
        return {
          ok: false,
          error:
            `The command "${command}" requires user approval, which is not available in scheduled/autonomous ` +
            'runs. Use a simpler command that clears the approval policy, or leave this step for an interactive chat.'
        };
      }
      const decision = await this.requestApproval({
        threadId: req.threadId ?? '',
        command,
        cwd,
        prefixes: cls.prefixes,
        judgeVerdict,
        judgeReason
      });
      if (decision === 'deny') {
        return { ok: false, error: 'The user declined to run this command.' };
      }
      if (decision === 'alwaysAllow' && cls.prefixes.length) {
        const cur = (await this.deps.readSettings()).exec.allowlist;
        const merged = [...cur, ...cls.prefixes.filter((p) => !cur.includes(p))];
        await this.deps.updateExecSettings({ allowlist: merged }).catch(() => undefined);
      }
    }

    return this.run(command, cwd, req, settings);
  }

  abortThread(threadId: string): void {
    for (const [id, approval] of this.pending) {
      if (approval.threadId === threadId) this.settleApproval(id, 'deny');
    }
    for (const exec of this.running) {
      if (exec.threadId === threadId) exec.controller.abort();
    }
    this.router().abortThread(threadId);
  }

  settleAll(): void {
    for (const id of [...this.pending.keys()]) this.settleApproval(id, 'deny');
    for (const exec of this.running) exec.controller.abort();
  }

  /** Answer a pending approval card (IPC entry point). Returns false for unknown/expired ids. */
  resolveApproval(id: string, decision: ExecDecision): boolean {
    return this.settleApproval(id, decision);
  }

  // ---- internals ----

  private router(): import('../exec-device/router').ExecDeviceRouter {
    return (this.deps.deviceRouter ?? execDeviceRouter)();
  }

  /**
   * The device-targeted path. The tiers are the same three, with two deliberate
   * differences (both user decisions): the static built-ins do not apply — a
   * remote machine's tier 1 is exactly its own learned allowlist, which starts
   * empty — and "Always allow" learns into that device's bucket, never the
   * shared one. What is absent is absent for a reason, not forgotten: scratch
   * and cwd resolution happen on the device (only it can stat its own disk),
   * and the protected-roots scan guards server-side connected folders, of which
   * the target machine has none.
   */
  private async handleDeviceExec(
    command: string,
    device: string,
    req: ExecRequest,
    all: ServerSettings
  ): Promise<ExecBridgeResult> {
    const settings = all.exec;
    const target = await (this.deps.resolveDevice ?? resolveExecTarget)(device);
    if (!target.ok) return { ok: false, error: target.error };
    const label = `“${target.label}”`;
    const host = await this.router().hostFor(target.deviceId);
    if (!host?.enabled) {
      return {
        ok: false,
        error:
          `${label} does not accept commands from this Stem. Only its owner can change that, in ` +
          `Settings → Chat → Command execution ON that computer — tell them so rather than retrying.`
      };
    }
    if (!this.router().isAvailable(target.deviceId)) {
      return {
        ok: false,
        error:
          `${label} is not connected to Stem right now. The command will work as soon as that computer ` +
          'is awake with Stem running on it.'
      };
    }
    // Absolute paths only: the default is the device's own per-chat scratch
    // folder, and a relative path would resolve against a folder this machine
    // cannot see. The device stats it; refusing a bad one is its answer.
    const cwd = req.cwd?.trim() || undefined;
    const cwdLabel = cwd ?? `this chat's scratch folder on ${label}`;
    const dispatch = (): Promise<ExecBridgeResult> => this.runOnDevice(command, cwd, req, target.deviceId);

    if (settings.approvalMode === 'yolo') return dispatch();

    const cls = classify(
      command,
      { allowlist: (settings.deviceAllowlists ?? {})[target.deviceId] ?? [] },
      host.platform,
      { includeBuiltins: false }
    );
    if (cls.tier !== 'run') {
      let judgeVerdict: 'unsafe' | 'unsure' | 'failed' | null = null;
      let judgeReason: string | undefined;
      if (settings.approvalMode === 'assisted') {
        const verdict = await this.judge(
          command,
          cwdLabel,
          settings,
          all.defaults,
          req.userText,
          req.currentModel,
          host.platform,
          deviceShellLabel(host.platform, label)
        );
        if (verdict.verdict === 'safe') return dispatch();
        judgeVerdict = verdict.verdict;
        judgeReason = verdict.reason;
      }
      if (req.isScheduled) {
        return {
          ok: false,
          error:
            `The command "${command}" requires user approval, which is not available in scheduled/autonomous ` +
            'runs. Use a simpler command that clears the approval policy, or leave this step for an interactive chat.'
        };
      }
      const decision = await this.requestApproval({
        threadId: req.threadId ?? '',
        command,
        cwd: cwdLabel,
        prefixes: cls.prefixes,
        judgeVerdict,
        judgeReason,
        deviceId: target.deviceId,
        deviceLabel: target.label
      });
      if (decision === 'deny') {
        return { ok: false, error: 'The user declined to run this command.' };
      }
      if (decision === 'alwaysAllow' && cls.prefixes.length) {
        // Into THIS device's bucket. Read fresh, like the local path: another
        // card may have written the settings while this one was open.
        const cur = (await this.deps.readSettings()).exec.deviceAllowlists ?? {};
        const existing = cur[target.deviceId] ?? [];
        const merged = {
          ...cur,
          [target.deviceId]: [...existing, ...cls.prefixes.filter((p) => !existing.includes(p))]
        };
        await this.deps.updateExecSettings({ deviceAllowlists: merged }).catch(() => undefined);
      }
    }
    return dispatch();
  }

  private async runOnDevice(
    command: string,
    cwd: string | undefined,
    req: ExecRequest,
    deviceId: string
  ): Promise<ExecBridgeResult> {
    // No concurrency slot: MAX_CONCURRENT guards THIS machine's shells, and a
    // command running on another computer occupies nothing here but a promise.
    const result = await this.router().run(deviceId, {
      threadId: req.threadId ?? '',
      command,
      ...(cwd ? { cwd } : {}),
      timeoutMs: clampTimeout(req.timeoutMs)
    });
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error };
  }

  private async listModelsCached(): Promise<ModelSummary[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_CACHE_TTL_MS) {
      return this.modelsCache.models;
    }
    const models = await this.deps.runtime().listModels().catch(() => []);
    if (models.length) this.modelsCache = { at: Date.now(), models };
    return models;
  }

  private async judge(
    command: string,
    cwd: string,
    settings: ExecSettings,
    defaults: DefaultsSettings,
    userText?: string,
    currentModel?: string | null,
    shell: HostShell | NodeJS.Platform = hostShellFromPlatform(),
    // Set for a device-targeted command: the judge must reason about the shell
    // that will actually run it, on the machine it will actually run on.
    shellLabel?: string
  ): Promise<{ verdict: 'safe' | 'unsafe' | 'unsure' | 'failed'; reason?: string }> {
    try {
      const runtime = this.deps.runtime();
      const models = await this.listModelsCached();
      // The shared background model if one is set, else the live chat's own —
      // resolveJudgeModel only answers null when it was handed no models at all,
      // and complete() then uses its own default, which is the best available
      // answer anyway.
      const model = resolveJudgeModel(settings, defaults, models, currentModel ?? null);
      const reply = await runtime.complete(buildJudgePrompt(command, cwd, userText, shell, shellLabel), {
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

  private requestApproval(request: Omit<ExecApprovalRequest, 'id'>): Promise<ExecDecision> {
    const id = randomUUID();
    return new Promise<ExecDecision>((resolveDecision) => {
      const timer = setTimeout(() => this.settleApproval(id, 'deny'), APPROVAL_TIMEOUT_MS);
      this.pending.set(id, { threadId: request.threadId, resolve: resolveDecision, timer });
      this.deps.emitApprovalRequest({ id, ...request });
    });
  }

  private settleApproval(id: string, decision: ExecDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    this.deps.emitApprovalResolved(id);
    return true;
  }

  private async run(
    command: string,
    cwd: string,
    req: ExecRequest,
    settings: ExecSettings
  ): Promise<ExecBridgeResult> {
    await this.acquireSlot();
    const controller = new AbortController();
    const entry: RunningExec = { threadId: req.threadId ?? '', controller };
    this.running.add(entry);
    try {
      const shell = resolveHostShell(settings);
      const gitBashPath = shell === 'git-bash' ? resolveGitBashExecutable(settings) : settings.gitBashPath;
      const loginPath = await resolveLoginPath();
      const pathForChild =
        shell === 'git-bash' && gitBashPath ? gitBashPathEnv(gitBashPath, loginPath) : loginPath;
      const outcome = await runCommand({
        command,
        cwd,
        timeoutMs: clampTimeout(req.timeoutMs),
        env: execEnv(pathForChild),
        signal: controller.signal,
        shell,
        gitBashPath
      });
      if (controller.signal.aborted && !outcome.timedOut) {
        return { ok: false, error: 'The command was cancelled.' };
      }
      const parts = [
        outcome.timedOut
          ? `Timed out after ${clampTimeout(req.timeoutMs)} ms (process group killed).`
          : `Exit code: ${outcome.exitCode ?? `signal ${outcome.signal ?? 'unknown'}`}`,
        `stdout:\n${outcome.stdout.trim() || '(no output)'}`,
        `stderr:\n${outcome.stderr.trim() || '(no output)'}`
      ];
      return { ok: true, text: parts.join('\n\n') };
    } catch (e) {
      return { ok: false, error: `The command could not be started: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      this.running.delete(entry);
      this.releaseSlot();
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolveSlot) => this.waiters.push(resolveSlot));
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}
