import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecService, JUDGE_TIMEOUT_MS } from '../../src/server/exec/service';
import { execWorkspaceDir, threadWorkspaceDir } from '../../src/server/workspace/paths';
import type { ChatBackend } from '../../src/server/backend/types';
import type { AppSettings, ExecApprovalRequest, ModelSummary } from '../../src/shared/types';
import { emptyCompleteError } from '../../src/server/pi/complete-errors';
import { insertCompleteWaiter } from '../../src/server/pi/complete-worker';

// ExecService judge wiring: model selection from the live chat, priority complete(),
// and fail-closed escalation when complete() throws.

const PS =
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "1+1"';

function model(id: string, provider: string, isDefault = false): ModelSummary {
  return {
    id,
    displayName: id,
    description: provider,
    provider,
    providerName: provider,
    supportedEfforts: ['medium'],
    defaultEffort: 'medium',
    serviceTiers: [],
    isDefault
  };
}

function baseSettings(): AppSettings {
  return {
    exec: {
      enabled: true,
      approvalMode: 'assisted',
      judgeModel: null,
      judgeEffort: null,
      allowlist: [],
      windowsShell: 'cmd',
      gitBashPath: null
    },
    // The judge reads these too: unpinned, it runs on the shared background model
    // if there is one, else the model of the chat that asked.
    defaults: { model: null, backgroundModel: null, backgroundEffort: 'low' }
  } as unknown as AppSettings;
}

describe('insertCompleteWaiter', () => {
  it('inserts priority waiters ahead of normal ones', () => {
    const waiters: Array<{ priority: boolean; id: string }> = [];
    insertCompleteWaiter(waiters, { priority: false, id: 'n1' });
    insertCompleteWaiter(waiters, { priority: false, id: 'n2' });
    insertCompleteWaiter(waiters, { priority: true, id: 'p1' });
    insertCompleteWaiter(waiters, { priority: true, id: 'p2' });
    insertCompleteWaiter(waiters, { priority: false, id: 'n3' });
    expect(waiters.map((w) => w.id)).toEqual(['p1', 'p2', 'n1', 'n2', 'n3']);
  });
});

describe('emptyCompleteError', () => {
  it('includes stderr when present', () => {
    expect(emptyCompleteError('Unknown provider foo\n').message).toContain('Unknown provider foo');
  });

  it('uses a generic message when stderr is empty', () => {
    expect(emptyCompleteError('').message).toBe('pi completion returned no text.');
  });
});

describe('ExecService judge', () => {
  let cwd: string;
  let approvals: ExecApprovalRequest[];
  let completeOpts: Array<{ model?: string | null; effort?: string | null; timeoutMs?: number; priority?: boolean }>;
  let completeImpl: (prompt: string) => Promise<string>;
  let settings: AppSettings;
  let service: ExecService;

  beforeEach(() => {
    settings = baseSettings();
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'stem-exec-svc-')));
    approvals = [];
    completeOpts = [];
    completeImpl = async () => 'safe';
    const runtime = {
      listModels: async () => [
        model('anthropic/claude-opus-4', 'anthropic', true),
        model('anthropic/claude-haiku-4', 'anthropic'),
        model('openai-codex/gpt-5.3-codex-spark', 'openai-codex')
      ],
      complete: async (
        _prompt: string,
        opts?: { model?: string | null; timeoutMs?: number; priority?: boolean }
      ) => {
        completeOpts.push(opts ?? {});
        return completeImpl(_prompt);
      }
    } as unknown as ChatBackend;

    service = new ExecService({
      // These suites are about the card: escalate on the first refusal.
      blockStreak: 1,
      runtime: () => runtime,
      readSettings: async () => settings,
      updateExecSettings: async () => settings,
      emitApprovalRequest: (request) => {
        approvals.push(request);
        // Answer asynchronously so handleExecRequest can await the card.
        queueMicrotask(() => service.resolveApproval(request.id, 'deny'));
      },
      emitApprovalResolved: () => undefined
    });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('passes priority, 60s timeout, and the model of the chat that asked', async () => {
    completeImpl = async () => 'unsure maybe';
    const result = await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      userText: 'check powershell',
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(result.ok).toBe(false);
    // Stage 1, then stage 2 for what stage 1 did not call safe.
    expect(completeOpts).toHaveLength(2);
    expect(completeOpts[1]?.effort).toBe('high');
    expect(completeOpts[0]?.priority).toBe(true);
    expect(completeOpts[0]?.timeoutMs).toBe(JUDGE_TIMEOUT_MS);
    expect(JUDGE_TIMEOUT_MS).toBe(60_000);
    // Not a cheaper-looking sibling: Stem no longer guesses one from names.
    expect(completeOpts[0]?.model).toBe('anthropic/claude-opus-4');
    // The judge sits between the user and every command they run, so the
    // background effort setting has to reach it — this is the role where the
    // difference between thinking and answering is felt as latency.
    expect(completeOpts[0]?.effort).toBe('low');
    expect(approvals[0]?.judgeVerdict).toBe('unsure');
  });

  it("hands the judge the user's words and the agent's earlier commands", async () => {
    const prompts: string[] = [];
    completeImpl = async (p: string) => {
      prompts.push(p);
      return 'unsure';
    };
    await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      userText: 'only this message',
      judgeContext: {
        userWords: ['quit the app, reinstall it and start it'],
        actions: [{ command: 'kill -TERM 4020 && ./scripts/install.sh', refused: false }]
      }
    });
    expect(prompts[0]).toContain('quit the app, reinstall it and start it');
    expect(prompts[0]).not.toContain('only this message');
    expect(prompts[0]).toContain('- kill -TERM 4020 && ./scripts/install.sh');
  });

  it('stage 2 can clear what stage 1 flagged, and the command runs', async () => {
    completeImpl = async (p: string) => (p.includes('Think it through first') ? 'It is the step asked for.\nsafe' : 'unsure');
    const result = await service.handleExecRequest({
      command: 'echo hi',
      cwd,
      threadId: 't1',
      isScheduled: false,
      judgeContext: { userWords: ['say hi'], actions: [] }
    });
    expect(result.ok).toBe(true);
    expect(approvals).toHaveLength(0);
  });

  it('prefers the safety check’s own effort over the shared background one', async () => {
    // The reason this role has a level of its own: it is the one background job
    // whose cost is paid in latency, in front of the user, on every command —
    // so it must be able to answer faster than the rest of the group.
    settings.exec.judgeEffort = 'off';
    completeImpl = async () => 'unsure maybe';
    await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(completeOpts[0]?.effort).toBe('off');
  });

  it('thinks at Low when nobody has set a level at all', async () => {
    // The floor under this role, and the reason it is not `off` like the subject
    // writer's: deciding whether a command serves what the user asked for is a
    // judgement, so it gets a little thinking — just not enough to be felt.
    settings.defaults.backgroundEffort = null;
    completeImpl = async () => 'unsure maybe';
    await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(completeOpts[0]?.effort).toBe('low');
  });

  it('escalates with judgeVerdict failed, saying why in the card\'s voice', async () => {
    completeImpl = async () => {
      throw new Error('pi completion timed out.');
    };
    const result = await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(result.ok).toBe(false);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.judgeVerdict).toBe('failed');
    // Renders as "The automatic safety check could not run: it did not answer in
    // time." — the exception text belongs in the log, not on the card.
    expect(approvals[0]?.judgeReason).toBe('it did not answer in time');
  });

  it('says nothing beyond "could not run" when the cause has no user-facing form', async () => {
    completeImpl = async () => {
      throw new Error('pi exited (code 1, signal null): TypeError: x is not a function');
    };
    await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(approvals[0]?.judgeVerdict).toBe('failed');
    expect(approvals[0]?.judgeReason).toBeUndefined();
  });

  it('names a missing model, the one cause the user can act on', async () => {
    completeImpl = async () => {
      throw new Error('No API key configured for provider "xai".');
    };
    await service.handleExecRequest({
      command: PS,
      cwd,
      threadId: 't1',
      isScheduled: false,
      currentModel: 'xai/grok-4.5'
    });
    expect(approvals[0]?.judgeReason).toBe('no model was available to run it');
  });
});

// H-01: the tier-1 readers are confined to the readable roots at the service
// level too — a `cat` aimed outside them reaches the judge, one inside runs.
describe('ExecService read confinement (H-01)', () => {
  let approvals: ExecApprovalRequest[];
  let judged: string[];
  let settings: AppSettings;
  let service: ExecService;

  beforeEach(() => {
    rmSync(execWorkspaceDir(), { recursive: true, force: true });
    settings = baseSettings();
    approvals = [];
    judged = [];
    service = new ExecService({
      // These suites are about the card: escalate on the first refusal.
      blockStreak: 1,
      runtime: () =>
        ({
          listModels: async () => [model('anthropic/claude-opus-4', 'anthropic', true)],
          complete: async (prompt: string) => {
            judged.push(prompt);
            return 'unsafe';
          }
        }) as unknown as ChatBackend,
      readSettings: async () => settings,
      updateExecSettings: async () => settings,
      emitApprovalRequest: (request) => {
        approvals.push(request);
        queueMicrotask(() => service.resolveApproval(request.id, 'deny'));
      },
      emitApprovalResolved: () => undefined
    });
  });

  afterEach(() => {
    rmSync(execWorkspaceDir(), { recursive: true, force: true });
  });

  it('a read outside the roots goes to the judge and then the card, never straight to the shell', async () => {
    const result = await service.handleExecRequest({
      command: 'cat /etc/hosts',
      threadId: 'chat-h01',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(result.ok).toBe(false);
    // Both stages saw it; neither cleared it.
    expect(judged).toHaveLength(2);
    expect(approvals).toHaveLength(1);
  });

  it("find -exec is judged even though find's output would be harmless", async () => {
    settings.exec.allowlist = ['find'];
    await service.handleExecRequest({
      command: "find . -maxdepth 0 -exec sh -c id ';'",
      threadId: 'chat-h01',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(judged).toHaveLength(2);
  });

  it('a read inside the chat\'s scratch runs without judge or card', async () => {
    mkdirSync(threadWorkspaceDir('chat-h01'), { recursive: true });
    const result = await service.handleExecRequest({
      // cmd.exe is the Windows default, and `ls` is not one of its reads.
      command: process.platform === 'win32' ? 'dir' : 'ls -la',
      threadId: 'chat-h01',
      isScheduled: false,
      currentModel: 'anthropic/claude-opus-4'
    });
    expect(result.ok).toBe(true);
    expect(judged).toHaveLength(0);
    expect(approvals).toHaveLength(0);
  });
});

// Where a command actually runs. The default is no longer one folder shared by
// every chat — it is the chat's own scratch folder (see server/exec/scratch.ts),
// which is what makes scratch attributable, sizable and deletable per chat.
describe('ExecService working directory', () => {
  let approvals: ExecApprovalRequest[];
  let settings: AppSettings;
  let service: ExecService;

  beforeEach(() => {
    rmSync(execWorkspaceDir(), { recursive: true, force: true });
    settings = baseSettings();
    // Manual mode with an unlisted command: the request stops at the approval
    // card, so the resolved cwd can be read off it without running anything.
    settings.exec.approvalMode = 'manual';
    approvals = [];
    service = new ExecService({
      // These suites are about the card: escalate on the first refusal.
      blockStreak: 1,
      runtime: () => ({}) as unknown as ChatBackend,
      readSettings: async () => settings,
      updateExecSettings: async () => settings,
      emitApprovalRequest: (request) => {
        approvals.push(request);
        queueMicrotask(() => service.resolveApproval(request.id, 'deny'));
      },
      emitApprovalResolved: () => undefined
    });
  });

  afterEach(() => {
    rmSync(execWorkspaceDir(), { recursive: true, force: true });
  });

  /** Run one request to the card and hand back the cwd it resolved. */
  async function cwdFor(req: { threadId: string | null; cwd?: string }): Promise<string> {
    await service.handleExecRequest({ command: PS, isScheduled: false, ...req });
    return approvals[0]!.cwd;
  }

  it('defaults to the asking chat’s own folder', async () => {
    expect(await cwdFor({ threadId: 'chat-a' })).toBe(threadWorkspaceDir('chat-a'));
  });

  it('keeps two chats apart', async () => {
    const a = await cwdFor({ threadId: 'chat-a' });
    approvals = [];
    expect(await cwdFor({ threadId: 'chat-b' })).not.toBe(a);
  });

  it('falls back to the unfiled root when no turn owns the command', async () => {
    expect(await cwdFor({ threadId: null })).toBe(execWorkspaceDir());
  });

  it('resolves a relative cwd inside the chat’s folder, not the app’s', async () => {
    mkdirSync(join(threadWorkspaceDir('chat-a'), 'build'), { recursive: true });
    expect(await cwdFor({ threadId: 'chat-a', cwd: 'build' })).toBe(
      join(threadWorkspaceDir('chat-a'), 'build')
    );
  });

  it('leaves an absolute cwd exactly where the assistant pointed it', async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'stem-exec-cwd-')));
    try {
      expect(await cwdFor({ threadId: 'chat-a', cwd: elsewhere })).toBe(elsewhere);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses a cwd that does not exist rather than inventing one', async () => {
    const result = await service.handleExecRequest({
      command: PS,
      cwd: 'no-such-folder',
      threadId: 'chat-a',
      isScheduled: false
    });
    expect(result).toMatchObject({ ok: false });
    expect(approvals).toHaveLength(0);
  });
});

describe('ExecService device targeting', () => {
  let approvals: ExecApprovalRequest[];
  let decision: 'allowOnce' | 'alwaysAllow' | 'deny';
  let judgeCalls: string[];
  let settings: AppSettings;
  let patches: Array<Record<string, unknown>>;
  let service: ExecService;
  let ran: Array<{ deviceId: string; command: string; cwd?: string; threadId: string }>;
  let hostEntry: { deviceId: string; announcedAt: string; enabled: boolean; platform: 'darwin' } | null;
  let available: boolean;
  let pinned: string[];

  beforeEach(() => {
    settings = baseSettings();
    (settings.exec as unknown as { deviceAllowlists: Record<string, string[]> }).deviceAllowlists = {};
    approvals = [];
    decision = 'deny';
    judgeCalls = [];
    patches = [];
    ran = [];
    available = true;
    pinned = [];
    hostEntry = { deviceId: 'mac-1', announcedAt: new Date().toISOString(), enabled: true, platform: 'darwin' };
    const runtime = {
      listModels: async () => [model('anthropic/claude-opus-4', 'anthropic', true)],
      complete: async (prompt: string) => {
        judgeCalls.push(prompt);
        return 'unsure';
      }
    } as unknown as ChatBackend;
    service = new ExecService({
      // These suites are about the card: escalate on the first refusal.
      blockStreak: 1,
      runtime: () => runtime,
      readSettings: async () => settings,
      updateExecSettings: async (patch) => {
        patches.push(patch as Record<string, unknown>);
        Object.assign(settings.exec, patch);
        return settings as never;
      },
      emitApprovalRequest: (request) => {
        approvals.push(request);
        queueMicrotask(() => service.resolveApproval(request.id, decision));
      },
      emitApprovalResolved: () => undefined,
      resolveDevice: async (nameOrId) =>
        nameOrId === "Vlado's MacBook" || nameOrId === 'mac-1'
          ? { ok: true, deviceId: 'mac-1', label: "Vlado's MacBook" }
          : { ok: false, error: `No paired computer is called “${nameOrId}”.` },
      clientFolders: async () => [],
      computerPersonas: async (deviceId: string) => (deviceId === 'mac-1' ? pinned : []),
      deviceRouter: () => ({
        announce: async () => undefined,
        hosts: async () => (hostEntry ? { 'mac-1': hostEntry } : {}),
        hostFor: async (id: string) => (id === 'mac-1' ? hostEntry : null),
        isAvailable: () => available,
        run: async (deviceId: string, req: { command: string; cwd?: string; threadId: string }) => {
          ran.push({ deviceId, command: req.command, cwd: req.cwd, threadId: req.threadId });
          return { ok: true as const, text: 'Exit code: 0\n\nstdout:\nhi\n\nstderr:\n(no output)' };
        },
        settle: () => false,
        abortThread: () => undefined,
        forget: async () => undefined,
        close: () => undefined
      }) as never
    });
  });

  const request = (over: Record<string, unknown> = {}) =>
    service.handleExecRequest({
      command: 'ls -la',
      device: "Vlado's MacBook",
      threadId: 'chat-a',
      isScheduled: false,
      ...over
    } as never);

  it('zero trust: even a built-in-safe command is judged on a remote machine', async () => {
    decision = 'allowOnce';
    const result = await request();
    expect(result.ok).toBe(true);
    // Locally `ls -la` is tier 1; on the device it went to the judge (who said
    // unsure) and then to a card.
    expect(judgeCalls).toHaveLength(2);
    // The judge prompt names the machine that will run it, not this one.
    expect(judgeCalls[0]).toContain("Vlado's MacBook");
    expect(judgeCalls[0]).toContain('under zsh');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ deviceId: 'mac-1', deviceLabel: "Vlado's MacBook" });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ deviceId: 'mac-1', command: 'ls -la' });
  });

  it("always allow learns into the device's own bucket, not the shared allowlist", async () => {
    decision = 'alwaysAllow';
    await request();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({ deviceAllowlists: { 'mac-1': ['ls'] } });
    // And from then on the same command is tier 1 for that device only.
    judgeCalls = [];
    approvals = [];
    const again = await request();
    expect(again.ok).toBe(true);
    expect(judgeCalls).toHaveLength(0);
    expect(approvals).toHaveLength(0);
  });

  it('refuses when the computer has not switched commands on, naming the switch', async () => {
    hostEntry = { ...hostEntry!, enabled: false };
    const result = await request();
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('does not accept commands');
    expect(judgeCalls).toHaveLength(0);
    expect(ran).toHaveLength(0);
  });

  it('refuses a sleeping computer immediately, naming it', async () => {
    available = false;
    const result = await request();
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("“Vlado's MacBook” is not connected");
    expect(ran).toHaveLength(0);
  });

  it('refuses an unknown device with the resolver’s own sentence', async () => {
    const result = await request({ device: 'Basement PC' });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('Basement PC');
  });

  // 2026-09-21: `computer` refused the Secretary (no pin), so it drove the Mac's
  // System Settings with osascript over run_command instead — past the consent
  // switch and the banner the pinned persona would have had. GUI scripting at a
  // computer that has a pinned persona is that persona's job.
  const DARK_MODE =
    `open -a "System Settings" && osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true'`;

  it('hands GUI scripting off to the persona pinned to that computer', async () => {
    pinned = ['MacControl'];
    decision = 'allowOnce';
    const result = await request({ command: DARK_MODE, personaComputerDevice: null });
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('“MacControl”');
    expect(error).toContain("“Vlado's MacBook”");
    expect(error).toContain('computer');
    // Refused before the judge and the card, and nothing reached the device.
    expect(judgeCalls).toHaveLength(0);
    expect(approvals).toHaveLength(0);
    expect(ran).toHaveLength(0);
  });

  it('lets the pinned persona itself script the GUI over the shell', async () => {
    pinned = ['MacControl'];
    decision = 'allowOnce';
    const result = await request({ command: DARK_MODE, personaComputerDevice: 'mac-1' });
    expect(result.ok).toBe(true);
    expect(ran).toHaveLength(1);
  });

  it('lets a plain chat allowed to drive any Mac script the GUI too (Settings → Features)', async () => {
    pinned = ['MacControl'];
    decision = 'allowOnce';
    const result = await request({ command: DARK_MODE, personaComputerDevice: null, computerAnyDevice: true });
    expect(result.ok).toBe(true);
    expect(ran).toHaveLength(1);
  });

  it('keeps the escape hatch when nobody is pinned to that computer', async () => {
    pinned = [];
    decision = 'allowOnce';
    const result = await request({ command: DARK_MODE, personaComputerDevice: null });
    expect(result.ok).toBe(true);
    expect(ran).toHaveLength(1);
  });

  it('a persona pinned to a different computer is still an outsider here', async () => {
    pinned = ['MacControl'];
    decision = 'allowOnce';
    const result = await request({ command: DARK_MODE, personaComputerDevice: 'mac-2' });
    expect(result.ok).toBe(false);
    expect(ran).toHaveLength(0);
  });

  it('shell work on a computer with a pinned persona is untouched', async () => {
    pinned = ['MacControl'];
    decision = 'allowOnce';
    const result = await request({ command: 'open -a Discord', personaComputerDevice: null });
    expect(result.ok).toBe(true);
    expect(ran).toHaveLength(1);
  });

  it('scheduled runs never get a card: past the escalation point they park for the user', async () => {
    const result = await request({ isScheduled: true });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('paused this task');
    expect((result as { park?: { command: string; deviceId?: string } }).park).toMatchObject({
      kind: 'exec',
      deviceId: 'mac-1'
    });
    expect(approvals).toHaveLength(0);
    expect(ran).toHaveLength(0);
  });

  it('a device-allowlisted command dispatches without judge or card, and carries cwd', async () => {
    (settings.exec as unknown as { deviceAllowlists: Record<string, string[]> }).deviceAllowlists = {
      'mac-1': ['yt-dlp']
    };
    const result = await request({ command: 'yt-dlp https://x.test', cwd: '/Users/vlado/Downloads' });
    expect(result.ok).toBe(true);
    expect(judgeCalls).toHaveLength(0);
    expect(approvals).toHaveLength(0);
    expect(ran[0]).toMatchObject({ command: 'yt-dlp https://x.test', cwd: '/Users/vlado/Downloads' });
  });

  // Read-only client folders on the target device (docs: client-connected
  // folders). The scan runs BEFORE the Yolo branch: Yolo skips approval, never
  // the user's read-only decision — the same rule the local gate holds to.
  describe('read-only client folders on the device', () => {
    const notesFolder = (mode: 'read' | 'readwrite', deviceId = 'mac-1') => ({
      id: 'f1',
      path: '/srv/mirrors/f1',
      label: 'notes',
      mode,
      memorize: true,
      origin: { deviceId, clientPath: '/Users/vlado/notes' }
    });

    it('blocks a command touching one, even in yolo, naming folder and device', async () => {
      (settings.exec as unknown as { approvalMode: string }).approvalMode = 'yolo';
      (service as unknown as { deps: { clientFolders: unknown } }).deps.clientFolders = async () => [
        notesFolder('read')
      ];
      const result = await request({ command: 'echo pwned > /Users/vlado/notes/plan.md' });
      expect(result.ok).toBe(false);
      const error = (result as { error: string }).error;
      expect(error).toContain('notes');
      expect(error).toContain("Vlado's MacBook");
      expect(error).toContain('read-only');
      expect(ran).toHaveLength(0);
    });

    it('blocks by cwd too, and lets the same command run once the folder is writable', async () => {
      (settings.exec as unknown as { approvalMode: string }).approvalMode = 'yolo';
      const deps = (service as unknown as { deps: { clientFolders: unknown } }).deps;
      deps.clientFolders = async () => [notesFolder('read')];
      const blocked = await request({ command: 'touch plan.md', cwd: '/Users/vlado/notes' });
      expect(blocked.ok).toBe(false);
      deps.clientFolders = async () => [notesFolder('readwrite')];
      const allowed = await request({ command: 'touch plan.md', cwd: '/Users/vlado/notes' });
      expect(allowed.ok).toBe(true);
      expect(ran).toHaveLength(1);
    });

    it("another device's read-only folder never blocks this one", async () => {
      (settings.exec as unknown as { approvalMode: string }).approvalMode = 'yolo';
      (service as unknown as { deps: { clientFolders: unknown } }).deps.clientFolders = async (
        deviceId: string
      ) => (deviceId === 'mac-1' ? [] : [notesFolder('read', 'other')]);
      const result = await request({ command: 'touch /Users/vlado/notes/plan.md' });
      expect(result.ok).toBe(true);
    });
  });
});

// The approval queue itself: what a card that nobody answers means, when its
// clock starts, and what an answer that arrives too late does. All three used to
// have the same wrong answer — "the user declined".
//
// Device-targeted on purpose: it is the path with no filesystem in it, so the
// only thing these tests have to wait for is the queue.
describe('ExecService approval queue', () => {
  let approvals: ExecApprovalRequest[];
  let armed: Array<{ id: string; expiresAt: number }>;
  let resolved: string[];
  let settings: AppSettings;
  let service: ExecService;

  beforeEach(() => {
    vi.useFakeTimers();
    settings = baseSettings();
    // Manual: straight to the card, so nothing here waits on a judge.
    settings.exec.approvalMode = 'manual';
    (settings.exec as unknown as { deviceAllowlists: Record<string, string[]> }).deviceAllowlists = {};
    approvals = [];
    armed = [];
    resolved = [];
    service = new ExecService({
      // These suites are about the card: escalate on the first refusal.
      blockStreak: 1,
      runtime: () => ({ listModels: async () => [], complete: async () => 'unsure' }) as unknown as ChatBackend,
      readSettings: async () => settings,
      updateExecSettings: async () => settings,
      emitApprovalRequest: (request) => approvals.push(request),
      emitApprovalResolved: (id) => resolved.push(id),
      emitApprovalArmed: (a) => armed.push(a),
      resolveDevice: async () => ({ ok: true, deviceId: 'mac-1', label: "Vlado's MacBook" }),
      // Stubbed so the device path stays filesystem-free (see the header note):
      // the real one reads the connected-folders store, and real I/O under fake
      // timers is exactly the nondeterminism these tests exist to avoid.
      clientFolders: async () => [],
      deviceRouter: () => ({
        announce: async () => undefined,
        hosts: async () => ({}),
        hostFor: async () => ({
          deviceId: 'mac-1',
          announcedAt: new Date().toISOString(),
          enabled: true,
          platform: 'darwin'
        }),
        isAvailable: () => true,
        run: async () => ({ ok: true as const, text: 'Exit code: 0' }),
        settle: () => false,
        abortThread: () => undefined,
        forget: async () => undefined,
        close: () => undefined
      }) as never
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const ask = (command: string) =>
    service.handleExecRequest({
      command,
      device: 'mac-1',
      threadId: 'chat-a',
      isScheduled: false
    } as never);

  /** Let the request reach its card; nothing here takes more than a few ticks. */
  const untilCards = async (n: number): Promise<void> => {
    for (let i = 0; i < 20 && approvals.length < n; i++) await vi.advanceTimersByTimeAsync(1);
  };

  it('says nobody answered when a card expires — never that the user declined', async () => {
    const pending = ask('ls -la');
    await untilCards(1);
    await vi.advanceTimersByTimeAsync(600_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('Nobody answered');
    expect((result as { error: string }).error).not.toContain('declined');
    // And the card is taken off every surface, not left on screen to be clicked.
    expect(resolved).toEqual([approvals[0].id]);
  });

  it('does not run a queued card’s clock while it is behind another one', async () => {
    const first = ask('ls -la');
    const second = ask('df -h');
    await untilCards(2);
    // Only the visible one carries a deadline.
    expect(approvals[0].expiresAt).toBeGreaterThan(Date.now());
    expect(approvals[1].expiresAt).toBeUndefined();

    // Nine minutes of the user reading the first card is not time taken from the
    // second: it has not started counting at all.
    await vi.advanceTimersByTimeAsync(540_000);
    expect(resolved).toEqual([]);

    expect(service.resolveApproval(approvals[0].id, 'deny')).toBe(true);
    await first;
    // Promoted, and the clients are told when it now expires.
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ id: approvals[1].id });
    expect(armed[0].expiresAt).toBe(Date.now() + 600_000);

    // Its full window starts from there.
    await vi.advanceTimersByTimeAsync(599_000);
    expect(resolved).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(((await second) as { error?: string }).error).toContain('Nobody answered');
  });

  it('refuses a late answer instead of swallowing it', async () => {
    const pending = ask('ls -la');
    await untilCards(1);
    const id = approvals[0].id;
    expect(service.resolveApproval(id, 'allowOnce')).toBe(true);
    await pending;
    // The same click a second time — or any click after the card expired — is
    // answered with false, which is what the card turns into "that came too late".
    expect(service.resolveApproval(id, 'allowOnce')).toBe(false);
  });

  it('lists what is still waiting, for a client that has just connected', async () => {
    void ask('ls -la');
    void ask('df -h');
    await untilCards(2);
    expect(service.pendingApprovals().map((r) => r.command)).toEqual(['ls -la', 'df -h']);
    service.settleAll();
    expect(service.pendingApprovals()).toEqual([]);
  });
});

// Claude Code's escalation: a command the judge will not clear goes back to the
// agent with the reason until three in a row (or twenty in all) were refused on
// one thread; from there the user decides — a card in a chat, a park when
// nobody is watching. An Allow from the user starts the count over.
describe('ExecService blocking and escalation', () => {
  let cwd: string;
  let approvals: ExecApprovalRequest[];
  let answer: 'allowOnce' | 'deny';
  let verdict: string;
  let service: ExecService;
  let settings: AppSettings;

  const send = (command: string, extra: Partial<Parameters<ExecService['handleExecRequest']>[0]> = {}) =>
    service.handleExecRequest({ command, cwd, threadId: 't1', isScheduled: false, ...extra });

  beforeEach(() => {
    settings = baseSettings();
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'stem-exec-block-')));
    approvals = [];
    answer = 'deny';
    verdict = 'unsafe — not asked for';
    const runtime = {
      listModels: async () => [model('anthropic/claude-opus-4', 'anthropic', true)],
      complete: async (prompt: string) => (prompt.includes('Think it through first') ? `reasoning\n${verdict}` : verdict)
    } as unknown as ChatBackend;
    service = new ExecService({
      runtime: () => runtime,
      readSettings: async () => settings,
      updateExecSettings: async () => settings,
      emitApprovalRequest: (request) => {
        approvals.push(request);
        queueMicrotask(() => service.resolveApproval(request.id, answer));
      },
      emitApprovalResolved: () => undefined
    });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('refuses back to the agent with the reason, then asks the user on the third in a row', async () => {
    const first = await send('echo one');
    expect(first).toMatchObject({ ok: false, blocked: true });
    expect((first as { error: string }).error).toContain('not asked for');
    expect((first as { error: string }).error).toMatch(/Do not reach the same effect another way/);
    await send('echo two');
    expect(approvals).toHaveLength(0);
    await send('echo three');
    expect(approvals).toHaveLength(1);
  });

  it('counts per thread', async () => {
    await send('echo one');
    await send('echo two');
    await send('echo three', { threadId: 't2' });
    expect(approvals).toHaveLength(0);
  });

  it('a command that runs breaks the streak', async () => {
    await send('echo one');
    await send('echo two');
    verdict = 'safe';
    expect((await send('echo fine')).ok).toBe(true);
    verdict = 'unsafe';
    await send('echo three');
    expect(approvals).toHaveLength(0);
  });

  it('an Allow on the card starts the count over', async () => {
    answer = 'allowOnce';
    await send('echo one');
    await send('echo two');
    expect((await send('echo three')).ok).toBe(true);
    expect(approvals).toHaveLength(1);
    await send('echo four');
    expect(approvals).toHaveLength(1);
  });

  it('keeps asking after a deny until the user allows something', async () => {
    await send('echo one');
    await send('echo two');
    await send('echo three');
    await send('echo four');
    expect(approvals).toHaveLength(2);
  });

  it('parks an unattended run at the escalation point instead of a card', async () => {
    expect(await send('echo one', { isScheduled: true })).toMatchObject({ ok: false, blocked: true });
    await send('echo two', { isScheduled: true });
    const third = await send('echo three', { isScheduled: true });
    expect(third).toMatchObject({ ok: false, park: { kind: 'exec', command: 'echo three', reason: 'not asked for' } });
    expect(approvals).toHaveLength(0);
  });

  it('sends a judge that could not run straight to the user', async () => {
    const runtime = {
      listModels: async () => [model('anthropic/claude-opus-4', 'anthropic', true)],
      complete: async () => {
        throw new Error('pi completion timed out.');
      }
    } as unknown as ChatBackend;
    (service as unknown as { deps: { runtime: () => ChatBackend } }).deps.runtime = () => runtime;
    await send('echo one');
    // The first refusal, yet a card: a judge that failed said nothing about the command.
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.judgeVerdict).toBe('failed');
  });

  it('runs a command the user allowed on a parked run once, without the judge', async () => {
    service.grantOnce('t1', 'echo granted');
    expect((await send('echo granted')).ok).toBe(true);
    // Once: the same command again is judged as usual.
    expect(await send('echo granted')).toMatchObject({ ok: false, blocked: true });
    // Exactly that command: another one never rides the grant.
    service.grantOnce('t1', 'echo granted');
    expect(await send('echo other')).toMatchObject({ ok: false, blocked: true });
  });

  it('a Stop on the thread cancels its card — never reported as the user declining', async () => {
    answer = 'deny';
    (service as unknown as { deps: { emitApprovalRequest: (r: ExecApprovalRequest) => void } }).deps.emitApprovalRequest = (r) => {
      approvals.push(r);
      queueMicrotask(() => service.abortThread('t1'));
    };
    await send('echo one');
    await send('echo two');
    const result = await send('echo three');
    expect((result as { error: string }).error).toBe('The command was cancelled.');
  });
});
