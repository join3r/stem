import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  DefaultsSettings,
  ExecApprovalArmed,
  ExecApprovalRequest,
  ExecDecision,
  ExecSettings,
  HostShell,
  ModelSummary,
  ServerSettings
} from '../../shared/types';
import type { ChatBackend, ExecBridge, ExecBridgeResult, ExecRequest } from '../backend/types';
import { resolveRoleEffort } from '../../shared/modelRoles';
import { degrade } from '../degrade';
import { log } from '../log';
import { ensureThreadScratch } from './scratch';
import { clampTimeout, execEnv, resolveLoginPath, runCommand } from './executor';
import { gitBashPathEnv, resolveHostShellTarget, type HostShellTarget } from './git-bash';
import { hostShellFromPlatform } from './host-shell';
import { buildJudgePrompt, classify, deviceShellLabel, parseJudgeVerdict, resolveJudgeModel } from './policy';
import { scanProtected } from './protected';
import { execDeviceRouter, resolveExecTarget } from '../exec-device/router';

// Orchestrates one run_command request end to end: settings gate → cwd resolve →
// protected-roots guard → tiered policy (allowlist / LLM judge / approval card) →
// spawn. Lives in main; the backend routes the tool's round-trip here via the
// ExecBridge seam. NOTE the judge is a heuristic, not a security boundary — the
// hard gates are the protected-roots scan and the manual approval tier.

// How long a VISIBLE card waits for an answer. Two minutes was a chat-app
// reflex and it was wrong for this: the person it asks may be reading the
// command, be on the other side of the room, or be answering on a phone that
// has to be unlocked first — and running out of time here used to be reported
// to the assistant as "the user declined", a sentence nobody said. Ten minutes
// is long enough that expiry means "nobody is there", which is what it should
// have meant all along; the clock only starts once the card is actually the one
// on screen (see armHead).
const APPROVAL_TIMEOUT_MS = 600_000;
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
/**
 * What the assistant is told when the card expired. It says who did not answer
 * (nobody) rather than who refused (no one did), because the assistant repeats
 * this to the user in its own words — and "you declined" about a command they
 * never saw an answer to is how a bug becomes an argument.
 */
const APPROVAL_TIMEOUT_ERROR =
  `Nobody answered the approval prompt for this command within ${Math.round(APPROVAL_TIMEOUT_MS / 60_000)} ` +
  'minutes, so it did not run. This is not a refusal — the user may simply have been away. Ask whether ' +
  'they still want it before running anything else.';

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
  /** Tell the renderer(s) a queued card is now the visible one, and until when. */
  emitApprovalArmed?: (armed: ExecApprovalArmed) => void;
  /** Injection seams for tests; default to the wired exec-device router. */
  deviceRouter?: () => import('../exec-device/router').ExecDeviceRouter;
  resolveDevice?: typeof resolveExecTarget;
}

/**
 * What a card can end as. 'timeout' is deliberately not an {@link ExecDecision}:
 * a decision is something a person made, and the whole point of separating them
 * is that the assistant is never again told "the user declined" about a card
 * nobody answered.
 */
type ApprovalOutcome = ExecDecision | 'timeout';

interface PendingApproval {
  threadId: string;
  resolve: (outcome: ApprovalOutcome) => void;
  /** The card as the clients have it, replayed to one that reconnects. */
  request: ExecApprovalRequest;
  /** Null while queued behind an older card: only the visible one is on a clock. */
  timer: NodeJS.Timeout | null;
  /**
   * True once the request frame has gone out. Until it has, a deadline set on
   * the card needs no announcement — it rides on the frame itself.
   */
  announced: boolean;
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
    // Decide the host shell ONCE, here, and carry it all the way to spawn. The
    // parser, the allowlist, the protected-roots scan and the judge are all
    // decided against it, and an approval card can sit for minutes — long enough
    // for a Git upgrade to move bash.exe. Re-resolving at spawn time could hand a
    // command parsed under bash quoting to cmd.exe, where `'` is not a quote.
    const host = resolveHostShellTarget(settings);

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
      // quiet: the stat failing IS the check — the branch below turns it into
      // the error the assistant reads, naming the cwd it asked for.
      const info = await stat(cwd).catch(() => null);
      if (!info?.isDirectory()) {
        return { ok: false, error: `The requested cwd "${req.cwd}" does not exist or is not a directory.` };
      }
    } else {
      cwd = scratch;
    }

    // Fail-closed read-only guard: any reference to a protected root blocks.
    const guard = scanProtected(command, cwd, undefined, host.shell);
    if (guard.blocked) return { ok: false, error: guard.reason ?? 'Blocked by the read-only folder guard.' };

    // Yolo mode: everything runs — the protected-roots guard above is the only gate.
    if (settings.approvalMode === 'yolo') return this.run(command, cwd, req, host);

    // Tier 1: static + user allowlist (every chained segment must clear it).
    const cls = classify(command, settings, host.shell);
    if (cls.tier !== 'run') {
      // Tier 2 (assisted mode only): one-word LLM judge classification (intent-aware
      // when the turn's user message is known); errors/timeouts escalate. Manual mode
      // skips straight to the card — judgeVerdict stays null so it can say so.
      let judgeVerdict: 'unsafe' | 'unsure' | 'failed' | null = null;
      let judgeReason: string | undefined;
      if (settings.approvalMode === 'assisted') {
        const verdict = await this.judge(
          command,
          cwd,
          settings,
          all.defaults,
          req.userText,
          req.currentModel,
          host.shell
        );
        if (verdict.verdict === 'safe') return this.run(command, cwd, req, host);
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
      if (decision === 'timeout') return { ok: false, error: APPROVAL_TIMEOUT_ERROR };
      if (decision === 'alwaysAllow' && cls.prefixes.length) {
        const cur = (await this.deps.readSettings()).exec.allowlist;
        const merged = [...cur, ...cls.prefixes.filter((p) => !cur.includes(p))];
        await this.deps.updateExecSettings({ allowlist: merged }).catch((e) => {
          // This command runs either way, so nothing looks wrong now — the user
          // is simply asked again next time for a prefix they were told they had
          // allowed for good.
          degrade('exec.allowlist', 'ran the command without remembering "always allow"', e);
        });
      }
    }

    return this.run(command, cwd, req, host);
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

  /**
   * The cards still waiting, oldest first — replayed to a client the instant it
   * connects. A card raised while a client was away (or during a stream gap)
   * otherwise exists only as a push nobody caught, and the tool call behind it
   * sits there until it expires against an empty room.
   */
  pendingApprovals(): ExecApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
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
      if (decision === 'timeout') return { ok: false, error: APPROVAL_TIMEOUT_ERROR };
      if (decision === 'alwaysAllow' && cls.prefixes.length) {
        // Into THIS device's bucket. Read fresh, like the local path: another
        // card may have written the settings while this one was open.
        const cur = (await this.deps.readSettings()).exec.deviceAllowlists ?? {};
        const existing = cur[target.deviceId] ?? [];
        const merged = {
          ...cur,
          [target.deviceId]: [...existing, ...cls.prefixes.filter((p) => !existing.includes(p))]
        };
        await this.deps.updateExecSettings({ deviceAllowlists: merged }).catch((e) => {
          degrade('exec.allowlist', 'ran the command without remembering "always allow" for that computer', e);
        });
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
    // quiet: an empty list is not an empty answer here. resolveJudgeModel returns
    // null for it and complete() then picks its own default, which is the same
    // model it would have chosen; the cache is left unset so the next judge
    // asks again. A backend that is properly down fails at complete(), where the
    // judge's own catch escalates to an approval card.
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

  private requestApproval(request: Omit<ExecApprovalRequest, 'id'>): Promise<ApprovalOutcome> {
    const id = randomUUID();
    return new Promise<ApprovalOutcome>((resolveDecision) => {
      const entry: PendingApproval = {
        threadId: request.threadId,
        resolve: resolveDecision,
        request: { id, ...request },
        timer: null,
        announced: false
      };
      this.pending.set(id, entry);
      // Arm BEFORE emitting, so the card goes out with its deadline already on
      // it when it is the one that will be shown — one frame, not a frame and a
      // correction. A card queued behind an older one goes out without one and
      // is armed later, by the settle that promotes it.
      this.armHead();
      this.deps.emitApprovalRequest(entry.request);
      entry.announced = true;
    });
  }

  /**
   * Put the oldest unanswered card on the clock, and nothing else.
   *
   * Every surface shows one card at a time, oldest first (the renderer's queue[0],
   * the phone's sheet). A timer on a card behind it counts down time the user was
   * never given the chance to use: two parallel run_command calls used to raise
   * two cards at once, and the second could expire — reported as a refusal —
   * while it was still invisible behind the first. So the clock and the screen
   * agree here: a card is answerable from the moment it can be seen.
   */
  private armHead(): void {
    const head = this.pending.values().next().value as PendingApproval | undefined;
    if (!head || head.timer) return;
    const id = head.request.id;
    head.timer = setTimeout(() => {
      log('exec', 'approval expired unanswered', { command: head.request.command });
      this.settleApproval(id, 'timeout');
    }, APPROVAL_TIMEOUT_MS);
    head.request.expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;
    // Only for a card the clients already have: a fresh one carries its own
    // deadline on the request frame that follows this call.
    if (head.announced) this.deps.emitApprovalArmed?.({ id, expiresAt: head.request.expiresAt });
  }

  private settleApproval(id: string, outcome: ApprovalOutcome): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(outcome);
    this.deps.emitApprovalResolved(id);
    // Whatever was behind it is now the card on screen, so start its clock.
    this.armHead();
    return true;
  }

  private async run(
    command: string,
    cwd: string,
    req: ExecRequest,
    host: HostShellTarget
  ): Promise<ExecBridgeResult> {
    await this.acquireSlot();
    const controller = new AbortController();
    const entry: RunningExec = { threadId: req.threadId ?? '', controller };
    this.running.add(entry);
    try {
      const { shell, gitBashPath } = host;
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
      // quiet: the message is the tool result — the assistant is told in the same
      // breath that the command never ran, and why.
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
