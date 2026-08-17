import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(completeOpts).toHaveLength(1);
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

  beforeEach(() => {
    settings = baseSettings();
    (settings.exec as unknown as { deviceAllowlists: Record<string, string[]> }).deviceAllowlists = {};
    approvals = [];
    decision = 'deny';
    judgeCalls = [];
    patches = [];
    ran = [];
    available = true;
    hostEntry = { deviceId: 'mac-1', announcedAt: new Date().toISOString(), enabled: true, platform: 'darwin' };
    const runtime = {
      listModels: async () => [model('anthropic/claude-opus-4', 'anthropic', true)],
      complete: async (prompt: string) => {
        judgeCalls.push(prompt);
        return 'unsure';
      }
    } as unknown as ChatBackend;
    service = new ExecService({
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
    expect(judgeCalls).toHaveLength(1);
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

  it('scheduled runs still never get a card', async () => {
    const result = await request({ isScheduled: true });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('scheduled');
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
});
