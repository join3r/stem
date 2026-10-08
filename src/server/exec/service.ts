import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ExecApprovalArmed,
  ExecApprovalRequest,
  ExecDecision,
  ExecSettings,
  HostShell,
  ServerSettings
} from '../../shared/types';
import type { ChatBackend, ExecBridge, ExecBridgeResult, ExecRequest } from '../backend/types';
import { recordDecision, type DecisionOutcome } from './decisions';
import { degrade } from '../degrade';
import { log } from '../log';
import { ensureThreadScratch } from './scratch';
import { clampTimeout, execEnv, resolveLoginPath, runCommand } from './executor';
import { gitBashPathEnv, resolveHostShellTarget, type HostShellTarget } from './git-bash';
import { SafetyJudge } from './judge';
import { classify, deviceShellLabel, drivesGui, type Classification } from './policy';
import { execReadRoots, scanCommandAgainstRoots, scanProtected } from './protected';
import { execDeviceRouter, resolveExecTarget } from '../exec-device/router';
import { clientFoldersForDevice } from '../workspace/connected-folders';
import { listPersonas } from '../workspace/personas';

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
// The judge lives in judge.ts (shared with HarnessService); re-exported so the
// timeout stays importable from here.
export { JUDGE_TIMEOUT_MS } from './judge';
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

/**
 * Claude Code's escalation point: a judged command is refused back to the
 * agent until this many in a row (or BLOCK_TOTAL in all) were refused in one
 * thread; from there the user decides — a card in a chat, a parked run when
 * nobody is watching. An Allow from the user resets both counts.
 */
export const BLOCK_STREAK = 3;
export const BLOCK_TOTAL = 20;

/** What the agent reads when the safety check refuses a command it may not escalate yet. */
export function blockedError(reason?: string): string {
  return (
    `Stem's safety check blocked this command${reason ? ` (${reason})` : ''}: it does not see the user asking ` +
    'for it. Treat that boundary in good faith. Find a safer way to do the step that clearly stays within what ' +
    'the user asked, or skip it and say so. Do not reach the same effect another way — a different tool, a ' +
    'script, an encoding, another computer. If the step is really needed, say why in your reply; after repeated ' +
    'blocks Stem asks the user.'
  );
}

/** What the agent reads when its unattended run was parked for the user's decision. */
export const PARKED_ERROR =
  'Stem has asked the user to approve this command and paused this task until they answer. End your turn ' +
  'now: do not reply, retry or work around it — Stem resumes you with their answer.';

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
  /** Test seam for the per-device read-only client-folder roots. */
  clientFolders?: typeof clientFoldersForDevice;
  /** Test seam: the names of the personas pinned (computer pin) to a device. */
  computerPersonas?: (deviceId: string) => Promise<string[]>;
  /** Test seam: refusals in a row before the user decides (default BLOCK_STREAK). */
  blockStreak?: number;
}

/**
 * What a card can end as. 'timeout' is deliberately not an {@link ExecDecision}:
 * a decision is something a person made, and the whole point of separating them
 * is that the assistant is never again told "the user declined" about a card
 * nobody answered.
 */
type ApprovalOutcome = ExecDecision | 'timeout' | 'aborted';

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
  private readonly safetyJudge: SafetyJudge;
  /** Per thread: judged commands refused in a row, and in all (Claude Code's 3 / 20). */
  private readonly blocks = new Map<string, { streak: number; total: number }>();
  /** Per thread: exactly what the user allowed on a parked run (command, folder, machine), each good for one run. */
  private readonly grants = new Map<string, Grant[]>();

  constructor(deps: ExecServiceDeps) {
    this.deps = deps;
    this.safetyJudge = new SafetyJudge({ runtime: () => this.deps.runtime() });
  }

  async handleExecRequest(req: ExecRequest): Promise<ExecBridgeResult> {
    const command = (req.command ?? '').trim();
    if (!command) return { ok: false, error: 'Provide a command to run.' };

    const all = await this.deps.readSettings();
    const settings = all.exec;
    if (!settings.enabled) {
      return { ok: false, error: 'Command execution is disabled in Settings → Features → Commands.' };
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

    const base = { kind: 'exec' as const, threadId: req.threadId ?? null, command, cwd };
    // Yolo mode: everything runs — the protected-roots guard above is the only gate.
    if (settings.approvalMode === 'yolo') {
      recordDecision({ ...base, outcome: 'ran-yolo' });
      return this.run(command, cwd, req, host);
    }

    // Tier 1: static + user allowlist (every chained segment must clear it), and
    // a read-only probe only inside the folders the file tools may read (H-01).
    const cls = classify(command, settings, host.shell, {
      confine: { cwd, roots: execReadRoots(host.shell) }
    });
    if (cls.tier === 'run') {
      this.noteRan(req.threadId);
      recordDecision({ ...base, outcome: 'ran-allowlist' });
      return this.run(command, cwd, req, host);
    }
    const gate = await this.gate({ command, cwdLabel: cwd, req, all, cls, shell: host.shell });
    if (!gate.run) return gate.result;
    if (gate.alwaysAllow && cls.prefixes.length) {
      const cur = (await this.deps.readSettings()).exec.allowlist;
      const merged = [...cur, ...cls.prefixes.filter((p) => !cur.includes(p))];
      await this.deps.updateExecSettings({ allowlist: merged }).catch((e) => {
        // This command runs either way, so nothing looks wrong now — the user
        // is simply asked again next time for a prefix they were told they had
        // allowed for good.
        degrade('exec.allowlist', 'ran the command without remembering "always allow"', e);
      });
    }
    return this.run(command, cwd, req, host);
  }

  /**
   * Tiers 2 and 3 for a command the allowlist did not clear, on this host or a
   * paired computer. In order: a one-shot grant from a parked run the user
   * allowed; the two-stage judge (assisted mode); then, for what it will not
   * call safe, Claude Code's escalation — refused back to the agent with the
   * reason until BLOCK_STREAK in a row or BLOCK_TOTAL in all, after that the
   * user decides: a card in a chat, a parked run when nobody is watching.
   * Manual mode asks the user every time, as before.
   */
  private async gate(p: {
    command: string;
    cwdLabel: string;
    req: ExecRequest;
    all: ServerSettings;
    cls: Classification;
    shell: HostShell | NodeJS.Platform;
    shellLabel?: string;
    device?: { id: string; label: string };
  }): Promise<{ run: true; alwaysAllow?: boolean } | { run: false; result: ExecBridgeResult }> {
    const { command, req, all } = p;
    const threadId = req.threadId ?? '';
    const base = {
      kind: 'exec' as const,
      threadId: req.threadId ?? null,
      command,
      cwd: p.cwdLabel,
      ...(p.device ? { device: p.device.id } : {})
    };
    if (this.takeGrant(threadId, { command, cwd: p.cwdLabel, deviceId: p.device?.id ?? null })) {
      recordDecision({ ...base, outcome: 'ran-granted' });
      return { run: true };
    }
    let judged: Awaited<ReturnType<SafetyJudge['judge']>> | null = null;
    if (all.exec.approvalMode === 'assisted') {
      judged = await this.safetyJudge.judge({
        command,
        cwd: p.cwdLabel,
        settings: all.exec,
        defaults: all.defaults,
        context: req.judgeContext ?? { userWords: req.userText ? [req.userText] : [], actions: [] },
        currentModel: req.currentModel,
        shell: p.shell,
        ...(p.shellLabel ? { shellLabel: p.shellLabel } : {})
      });
      if (judged.verdict === 'safe') {
        this.noteRan(threadId);
        recordDecision({ ...base, ...judgeFields(judged), outcome: 'ran-judge' });
        return { run: true };
      }
    }
    const verdict = judged ? (judged.verdict as 'unsafe' | 'unsure' | 'failed') : null;
    const record = (outcome: DecisionOutcome, approvalId?: string): void =>
      recordDecision({ ...base, ...(judged ? judgeFields(judged) : {}), outcome, ...(approvalId ? { approvalId } : {}) });

    // Assisted mode refuses back to the agent until the escalation point. A
    // judge that could not run says nothing about the command, so that one
    // goes straight to the user, as it always has.
    if (judged && judged.verdict !== 'failed' && !this.escalates(threadId)) {
      record('blocked');
      return { run: false, result: { ok: false, error: blockedError(judged.reason), blocked: true } };
    }
    // The user decides — and when nobody is watching, the run parks for them.
    if (req.isScheduled) {
      record('parked');
      return {
        run: false,
        result: {
          ok: false,
          error: PARKED_ERROR,
          park: {
            kind: 'exec',
            command,
            cwd: p.cwdLabel,
            ...(p.device ? { deviceId: p.device.id, deviceLabel: p.device.label } : {}),
            ...(judged?.reason ? { reason: judged.reason } : {})
          }
        }
      };
    }
    const approvalId = randomUUID();
    const decision = await this.requestApproval(
      {
        threadId,
        command,
        cwd: p.cwdLabel,
        prefixes: p.cls.prefixes,
        judgeVerdict: verdict,
        judgeReason: judged?.reason,
        ...(p.device ? { deviceId: p.device.id, deviceLabel: p.device.label } : {})
      },
      approvalId
    );
    if (decision === 'deny') {
      record('user-deny', approvalId);
      return { run: false, result: { ok: false, error: 'The user declined to run this command.', blocked: true } };
    }
    if (decision === 'aborted') {
      record('aborted', approvalId);
      return { run: false, result: { ok: false, error: 'The command was cancelled.' } };
    }
    if (decision === 'timeout') {
      record('timeout', approvalId);
      return { run: false, result: { ok: false, error: APPROVAL_TIMEOUT_ERROR } };
    }
    record(decision === 'alwaysAllow' ? 'user-always' : 'user-allow', approvalId);
    this.blocks.delete(threadId);
    return { run: true, alwaysAllow: decision === 'alwaysAllow' };
  }

  /**
   * Count a judged refusal and say whether the user should now decide. The
   * refusal that reaches the threshold is itself escalated, so the third block
   * in a row is a card (or a park), not a third silent refusal.
   */
  private escalates(threadId: string): boolean {
    const count = this.blocks.get(threadId) ?? { streak: 0, total: 0 };
    count.streak += 1;
    count.total += 1;
    this.blocks.set(threadId, count);
    return count.streak >= (this.deps.blockStreak ?? BLOCK_STREAK) || count.total >= BLOCK_TOTAL;
  }

  /** A command ran without the user: the refusals are no longer in a row. */
  private noteRan(threadId: string | null | undefined): void {
    const count = this.blocks.get(threadId ?? '');
    if (count) count.streak = 0;
  }

  /**
   * Let exactly this command run once on this thread without the judge: the
   * user allowed it on a parked run, and the resumed turn re-issues it. Bound
   * to the folder and machine the user saw on the approval, so the same text
   * aimed elsewhere — or a second time — is judged as usual.
   */
  grantOnce(threadId: string, grant: Grant): void {
    const list = this.grants.get(threadId) ?? [];
    list.push(normalizeGrant(grant));
    this.grants.set(threadId, list);
    this.blocks.delete(threadId);
  }

  private takeGrant(threadId: string, wanted: Grant): boolean {
    const list = this.grants.get(threadId);
    const w = normalizeGrant(wanted);
    const at = list?.findIndex((g) => g.command === w.command && g.cwd === w.cwd && g.deviceId === w.deviceId) ?? -1;
    if (!list || at < 0) return false;
    list.splice(at, 1);
    if (!list.length) this.grants.delete(threadId);
    return true;
  }


  abortThread(threadId: string): void {
    for (const [id, approval] of this.pending) {
      if (approval.threadId === threadId) this.settleApproval(id, 'aborted');
    }
    for (const exec of this.running) {
      if (exec.threadId === threadId) exec.controller.abort();
    }
    this.router().abortThread(threadId);
  }

  settleAll(): void {
    for (const id of [...this.pending.keys()]) this.settleApproval(id, 'aborted');
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

  private async computerPersonasFor(deviceId: string): Promise<string[]> {
    if (this.deps.computerPersonas) return this.deps.computerPersonas(deviceId);
    try {
      return (await listPersonas()).filter((p) => p.computer?.device === deviceId).map((p) => p.name);
    } catch (err) {
      // quiet-ish: an unreadable registry means "nobody pinned", which keeps
      // the escape hatch open rather than blocking every device command.
      degrade('exec', 'could not read personas for the GUI hand-off gate', err);
      return [];
    }
  }

  /**
   * The device-targeted path. The tiers are the same three, with two deliberate
   * differences (both user decisions): the static built-ins do not apply — a
   * remote machine's tier 1 is exactly its own learned allowlist, which starts
   * empty — and "Always allow" learns into that device's bucket, never the
   * shared one. What is absent is absent for a reason, not forgotten: scratch
   * and cwd resolution happen on the device (only it can stat its own disk).
   * The protected-roots GATE FILE guards server-side folders and stays out of
   * this path — but the target machine can own client-connected folders, and
   * the read-only ones among them are scanned below, BEFORE the Yolo branch,
   * because read-only holds in Yolo for local folders and must hold the same
   * way here. The device re-checks against its own list too (exec-host).
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
    // GUI work on a computer belongs to the persona pinned to it: it has the
    // `computer` tool, the consent switch and the banner. Another persona
    // scripting that GUI over run_command (osascript at System Events, cliclick,
    // SendKeys) slips past all three, so when someone IS pinned the command is
    // refused with a hand-off. Nobody pinned → the escape hatch stays open. A
    // plain chat allowed to drive that Mac (Settings → Features) counts as its
    // owner, as the pinned persona itself does.
    if (!req.computerAnyDevice && req.personaComputerDevice !== target.deviceId && drivesGui(command)) {
      const owners = await this.computerPersonasFor(target.deviceId);
      if (owners.length) {
        const names = owners.map((n) => `“${n}”`).join(' or ');
        return {
          ok: false,
          error:
            `Driving the screen of ${label} — clicking, typing, scripting its apps or System Settings — is the ` +
            `job of the persona pinned to that computer, ${names}: it has the \`computer\` tool and the user's ` +
            `consent for it. Hand the task to ${names} (spawn_agent with it as the role in a mail thread, or tell the ` +
            `user to ask ${names}) rather than scripting the GUI from here. run_command on ${label} stays for ` +
            'shell work: files, git, scripts, `open -a`.'
        };
      }
    }
    const host = await this.router().hostFor(target.deviceId);
    if (!host?.enabled) {
      return {
        ok: false,
        error:
          `${label} does not accept commands from this Stem. Only its owner can change that, in ` +
          `Settings → Features → Commands ON that computer — tell them so rather than retrying.`
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

    // Read-only client folders on the target device, scanned fail-closed like
    // the local protected-roots guard — and like it, ahead of Yolo: Yolo skips
    // the approval tiers, never the user's read-only decision.
    const clientFolders = await (this.deps.clientFolders ?? clientFoldersForDevice)(target.deviceId);
    const readOnly = clientFolders.filter((f) => f.mode === 'read' && f.origin);
    if (readOnly.length) {
      // Windows scans both native and MSYS path shapes; everything else POSIX.
      const shell: HostShell = host.platform === 'win32' ? 'git-bash' : 'zsh';
      const scan = scanCommandAgainstRoots(
        command,
        cwd ?? null,
        readOnly.map((f) => f.origin!.clientPath),
        shell
      );
      if (scan.blocked) {
        const folder = readOnly.find((f) => f.origin!.clientPath === scan.root);
        return {
          ok: false,
          error:
            `The command touches "${scan.root}" on ${label} — the folder “${folder?.label ?? scan.root}” is ` +
            'connected to Stem read-only, and commands cannot run against read-only folders (Stem cannot ' +
            'tell reads from writes). Read it through the server-side mirror instead, or ask the user to ' +
            'switch the folder to read & write in the Folders tab.'
        };
      }
    }

    const base = { kind: 'exec' as const, threadId: req.threadId ?? null, command, cwd: cwdLabel, device: target.deviceId };
    if (settings.approvalMode === 'yolo') {
      recordDecision({ ...base, outcome: 'ran-yolo' });
      return dispatch();
    }

    // A learned reader on that machine still only auto-runs inside its own
    // scratch (cwd unknown here) and the folders it connected read & write.
    const cls = classify(
      command,
      { allowlist: (settings.deviceAllowlists ?? {})[target.deviceId] ?? [] },
      host.platform,
      {
        includeBuiltins: false,
        confine: {
          cwd: cwd ?? null,
          roots: clientFolders.filter((f) => f.mode === 'readwrite' && f.origin).map((f) => f.origin!.clientPath)
        }
      }
    );
    if (cls.tier === 'run') {
      this.noteRan(req.threadId);
      recordDecision({ ...base, outcome: 'ran-allowlist' });
      return dispatch();
    }
    const gate = await this.gate({
      command,
      cwdLabel,
      req,
      all,
      cls,
      shell: host.platform,
      shellLabel: deviceShellLabel(host.platform, label),
      device: { id: target.deviceId, label: target.label }
    });
    if (!gate.run) return gate.result;
    if (gate.alwaysAllow && cls.prefixes.length) {
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

  private requestApproval(request: Omit<ExecApprovalRequest, 'id'>, id: string = randomUUID()): Promise<ApprovalOutcome> {
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

/** The judge's side of a decision-log record. */
function judgeFields(judged: Awaited<ReturnType<SafetyJudge['judge']>>) {
  return {
    ...(judged.prompt ? { prompt: judged.prompt } : {}),
    ...(judged.stage1 ? { stage1: judged.stage1 } : {}),
    ...(judged.stage2 ? { stage2: judged.stage2 } : {})
  };
}

/** What the user allowed on a parked run: the command, where, and on which machine (null = this server). */
export interface Grant {
  command: string;
  cwd?: string | null;
  deviceId?: string | null;
}

function normalizeGrant(g: Grant): Required<Grant> {
  return { command: g.command.trim(), cwd: g.cwd?.trim() || null, deviceId: g.deviceId || null };
}
