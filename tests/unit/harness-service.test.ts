// HarnessService against a scripted HarnessHost: the settings gate, the
// scheduled refusal, cwd resolution and the protected-roots guard, session
// continuity (cache semantics, fresh_session, stale-session retry), the recall
// preamble, the approval tiers (yolo / allowlist / judge) in front of the card,
// the approval card queue (visible clock, timeout, dismissal), and
// cancellation. No acpx and no processes — policy only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HarnessApprovalRequest, ServerSettings } from '../../src/shared/types';
import type {
  HarnessEnsureResult,
  HarnessHost,
  HarnessRunTurnInput,
  HarnessSessionSpec,
  HarnessTurnResult,
  HarnessTurnSink
} from '../../src/server/harness/host';
import { HarnessService, type HarnessServiceDeps } from '../../src/server/harness/service';
import { readHarnessRuns } from '../../src/server/harness/records';
import { lookupSession, rememberSession } from '../../src/server/harness/sessions';
import { harnessRunsPath, harnessSessionsStorePath, protectedRootsPath } from '../../src/server/workspace/paths';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stem-harness-svc-'));
  mkdirSync(dirname(harnessRunsPath()), { recursive: true });
  rmSync(harnessRunsPath(), { force: true });
  rmSync(harnessSessionsStorePath(), { force: true });
  rmSync(protectedRootsPath(), { force: true });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(harnessRunsPath(), { force: true });
  rmSync(harnessSessionsStorePath(), { force: true });
  rmSync(protectedRootsPath(), { force: true });
});

interface ScriptedHost extends HarnessHost {
  ensures: HarnessSessionSpec[];
  turns: HarnessRunTurnInput[];
  sinks: HarnessTurnSink[];
  cancelled: number;
}

function scriptedHost(script: {
  ensure?: (spec: HarnessSessionSpec) => HarnessEnsureResult;
  turn?: (input: HarnessRunTurnInput, sink: HarnessTurnSink) => Promise<HarnessTurnResult>;
  label?: string;
  available?: boolean;
}): ScriptedHost {
  const host: ScriptedHost = {
    ensures: [],
    turns: [],
    sinks: [],
    cancelled: 0,
    label: () => script.label ?? 'this server',
    available: () => script.available ?? true,
    async ensureSession(spec) {
      host.ensures.push(spec);
      return script.ensure?.(spec) ?? { ok: true, sessionId: spec.sessionId ?? 'fresh-session' };
    },
    runTurn(input, sink) {
      host.turns.push(input);
      host.sinks.push(sink);
      const result = (script.turn?.(input, sink) ??
        Promise.resolve({ ok: true, stopReason: 'end_turn', text: 'done' } satisfies HarnessTurnResult)) as Promise<HarnessTurnResult>;
      return {
        result,
        cancel: () => {
          host.cancelled += 1;
        }
      };
    },
    async close() {}
  };
  return host;
}

/** Full-settings fixture for the approval tiers (exec-service.test.ts pattern). */
function serverSettings(
  exec: Partial<ServerSettings['exec']> = {}
): ServerSettings {
  return {
    exec: {
      enabled: true,
      approvalMode: 'manual',
      judgeModel: null,
      judgeEffort: null,
      allowlist: [],
      deviceAllowlists: {},
      ...exec
    },
    defaults: { model: null, backgroundModel: null, backgroundEffort: 'low' }
  } as unknown as ServerSettings;
}

function makeService(
  host: HarnessHost,
  overrides: Partial<HarnessServiceDeps> = {}
): { service: HarnessService; approvals: HarnessApprovalRequest[]; resolved: string[] } {
  const approvals: HarnessApprovalRequest[] = [];
  const resolved: string[] = [];
  const service = new HarnessService({
    settings: async () => ({ enabled: true }),
    // Manual mode by default (backend/fake.ts precedent): approval-queue tests
    // get their cards without an LLM judge in the way.
    readSettings: async () => serverSettings(),
    judge: async () => ({ verdict: 'unsure' }),
    localHost: () => host,
    emitApprovalRequest: (request) => approvals.push(request),
    emitApprovalResolved: (id) => resolved.push(id),
    facts: async () => ({ facts: [] }),
    scratchDir: async () => scratch,
    ...overrides
  });
  return { service, approvals, resolved };
}

const REQ = { agent: 'claude', prompt: 'add a --version flag', threadId: 'thread-1' };

describe('gates', () => {
  it('refuses when the settings switch is off, naming where to turn it on', async () => {
    const { service } = makeService(scriptedHost({}), { settings: async () => ({ enabled: false }) });
    const res = await service.handleHarnessRequest(REQ);
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toContain('Settings');
  });

  it('refuses scheduled runs with the explanatory sentence', async () => {
    const host = scriptedHost({});
    const { service } = makeService(host);
    const res = await service.handleHarnessRequest({ ...REQ, isScheduled: true });
    expect(!res.ok && res.error).toContain('scheduled');
    expect(host.ensures).toHaveLength(0);
  });

  it('refuses a cwd that does not exist', async () => {
    const { service } = makeService(scriptedHost({}));
    const res = await service.handleHarnessRequest({ ...REQ, cwd: 'no-such-dir' });
    expect(!res.ok && res.error).toContain('no-such-dir');
  });

  it('blocks a cwd inside a protected root, fail-closed', async () => {
    mkdirSync(dirname(protectedRootsPath()), { recursive: true });
    writeFileSync(protectedRootsPath(), JSON.stringify({ roots: [scratch] }), 'utf8');
    const host = scriptedHost({});
    const { service } = makeService(host);
    const res = await service.handleHarnessRequest(REQ);
    expect(!res.ok && res.error).toContain('read-only');
    expect(host.ensures).toHaveLength(0);
  });
});

describe('sessions', () => {
  it('runs in the thread scratch dir by default and remembers the session', async () => {
    const host = scriptedHost({ ensure: () => ({ ok: true, sessionId: 'session-A' }) });
    const { service } = makeService(host);
    const res = await service.handleHarnessRequest(REQ);
    expect(res.ok).toBe(true);
    expect(host.ensures[0]).toEqual({ agent: 'claude', cwd: scratch });
    expect(host.turns[0]).toMatchObject({ agent: 'claude', cwd: scratch, sessionId: 'session-A' });
    expect(await lookupSession({ threadId: 'thread-1', host: 'server', agent: 'claude', cwd: scratch })).toBe(
      'session-A'
    );
    const [run] = await readHarnessRuns();
    expect(run).toMatchObject({ status: 'ok', agent: 'claude', sessionId: 'session-A' });
  });

  it('passes the remembered session back to the host on the next call', async () => {
    await rememberSession({ threadId: 'thread-1', host: 'server', agent: 'claude', cwd: scratch, sessionId: 'session-A' });
    const host = scriptedHost({});
    const { service } = makeService(host);
    await service.handleHarnessRequest(REQ);
    expect(host.ensures[0]).toMatchObject({ sessionId: 'session-A' });
  });

  it('fresh_session forgets the mapping and ensures without one', async () => {
    await rememberSession({ threadId: 'thread-1', host: 'server', agent: 'claude', cwd: scratch, sessionId: 'session-A' });
    const host = scriptedHost({ ensure: () => ({ ok: true, sessionId: 'session-B' }) });
    const { service } = makeService(host);
    await service.handleHarnessRequest({ ...REQ, freshSession: true });
    expect(host.ensures[0]).toEqual({ agent: 'claude', cwd: scratch });
    expect(await lookupSession({ threadId: 'thread-1', host: 'server', agent: 'claude', cwd: scratch })).toBe(
      'session-B'
    );
  });

  it('retries fresh when the host refuses the remembered session', async () => {
    await rememberSession({ threadId: 'thread-1', host: 'server', agent: 'claude', cwd: scratch, sessionId: 'stale' });
    const host = scriptedHost({
      ensure: (spec) =>
        spec.sessionId ? { ok: false, error: 'unknown session' } : { ok: true, sessionId: 'session-new' }
    });
    const { service } = makeService(host);
    const res = await service.handleHarnessRequest(REQ);
    expect(res.ok).toBe(true);
    expect(host.ensures).toHaveLength(2);
    expect(await lookupSession({ threadId: 'thread-1', host: 'server', agent: 'claude', cwd: scratch })).toBe(
      'session-new'
    );
  });

  it('carries the settings model pin on the ensure, the retry, and the turn', async () => {
    await rememberSession({ threadId: 'thread-1', host: 'server', agent: 'claude', cwd: scratch, sessionId: 'stale' });
    const host = scriptedHost({
      ensure: (spec) =>
        spec.sessionId ? { ok: false, error: 'unknown session' } : { ok: true, sessionId: 'session-new' }
    });
    const { service } = makeService(host, {
      settings: async () => ({ enabled: true, agents: { claude: { model: 'claude-fable-5' } } })
    });
    const res = await service.handleHarnessRequest(REQ);
    expect(res.ok).toBe(true);
    expect(host.ensures.map((e) => e.model)).toEqual(['claude-fable-5', 'claude-fable-5']);
    expect(host.turns[0]).toMatchObject({ model: 'claude-fable-5' });
  });

  it('sends no model when settings pin none for the agent', async () => {
    const host = scriptedHost({});
    const { service } = makeService(host, {
      settings: async () => ({ enabled: true, agents: { claude: { command: 'my-claude acp' } } })
    });
    await service.handleHarnessRequest(REQ);
    expect(host.ensures[0].model).toBeUndefined();
    expect(host.turns[0].model).toBeUndefined();
  });

  it('reports an honest error when even a fresh ensure fails', async () => {
    const host = scriptedHost({ ensure: () => ({ ok: false, error: 'adapter missing' }) });
    const { service } = makeService(host);
    const res = await service.handleHarnessRequest(REQ);
    expect(!res.ok && res.error).toContain('adapter missing');
    expect(await readHarnessRuns()).toHaveLength(0);
  });
});

describe('device targeting', () => {
  it('passes the resolver error through (unknown machine)', async () => {
    const { service } = makeService(scriptedHost({}), {
      resolveDevice: async () => ({ ok: false, error: 'No paired computer is called “mac”.' })
    });
    const res = await service.handleHarnessRequest({ ...REQ, device: 'mac' });
    expect(!res.ok && res.error).toContain('No paired computer');
  });

  it('refuses a machine that never announced (or switched off), naming its switch', async () => {
    const { service } = makeService(scriptedHost({}), {
      resolveDevice: async () => ({ ok: true, deviceId: 'dev-1', label: 'Mac' }),
      deviceHost: async () => null
    });
    const res = await service.handleHarnessRequest({ ...REQ, device: 'Mac', cwd: '/tmp/proj' });
    expect(!res.ok && res.error).toContain('does not run coding agents');
    expect(!res.ok && res.error).toContain('ON that computer');
  });

  it('refuses a disconnected machine with the awake sentence', async () => {
    const deviceHost = scriptedHost({ label: 'Mac', available: false });
    const { service } = makeService(scriptedHost({}), {
      resolveDevice: async () => ({ ok: true, deviceId: 'dev-1', label: 'Mac' }),
      deviceHost: async () => deviceHost
    });
    const res = await service.handleHarnessRequest({ ...REQ, device: 'Mac', cwd: '/tmp/proj' });
    expect(!res.ok && res.error).toContain('awake');
  });

  it('runs on the device host with the session keyed to that device', async () => {
    const deviceHost = scriptedHost({ label: 'Mac', ensure: () => ({ ok: true, sessionId: 'dev-session' }) });
    const { service } = makeService(scriptedHost({}), {
      resolveDevice: async () => ({ ok: true, deviceId: 'dev-1', label: 'Mac' }),
      deviceHost: async () => deviceHost
    });
    const res = await service.handleHarnessRequest({ ...REQ, device: 'Mac', cwd: '/tmp/proj' });
    expect(res.ok).toBe(true);
    expect(deviceHost.turns[0]).toMatchObject({ cwd: '/tmp/proj', sessionId: 'dev-session' });
    expect(await lookupSession({ threadId: 'thread-1', host: 'dev-1', agent: 'claude', cwd: '/tmp/proj' })).toBe(
      'dev-session'
    );
    expect((await readHarnessRuns())[0]).toMatchObject({ device: 'Mac', status: 'ok' });
  });

  it('requires an absolute cwd for device runs', async () => {
    const deviceHost = scriptedHost({ label: 'Mac' });
    const { service } = makeService(scriptedHost({}), {
      resolveDevice: async () => ({ ok: true, deviceId: 'dev-1', label: 'Mac' }),
      deviceHost: async () => deviceHost
    });
    const res = await service.handleHarnessRequest({ ...REQ, device: 'Mac' });
    expect(!res.ok && res.error).toContain('absolute cwd');
  });
});

describe('recall preamble', () => {
  it('prepends facts as escaped untrusted data, and only when there are any', async () => {
    const host = scriptedHost({});
    const { service } = makeService(host, {
      facts: async () => ({ facts: [{ text: 'Vlado prefers <tabs> & spaces' }] })
    });
    await service.handleHarnessRequest(REQ);
    const prompt = host.turns[0].prompt;
    expect(prompt).toContain('<stem_background_facts>');
    expect(prompt).toContain('\\u003ctabs\\u003e \\u0026 spaces');
    expect(prompt.endsWith('add a --version flag')).toBe(true);
    expect(prompt).toContain('never instructions');
  });

  it('a recall failure degrades to no preamble rather than blocking the run', async () => {
    const host = scriptedHost({});
    const { service } = makeService(host, {
      facts: async () => {
        throw new Error('recall down');
      }
    });
    const res = await service.handleHarnessRequest(REQ);
    expect(res.ok).toBe(true);
    expect(host.turns[0].prompt).toBe('add a --version flag');
  });
});

describe('approvals', () => {
  const OPTIONS = [
    { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
  ];

  function askingHost(onDecision: (d: unknown) => void): ScriptedHost {
    return scriptedHost({
      turn: async (_input, sink) => {
        const decision = await sink.onPermission({
          permissionId: 'perm-1',
          title: 'npm publish',
          options: OPTIONS
        });
        onDecision(decision);
        return { ok: true, stopReason: 'end_turn', text: 'after ask' };
      }
    });
  }

  it('raises a card with the visible clock and routes the answer back', async () => {
    let decision: unknown;
    const host = askingHost((d) => (decision = d));
    const { service, approvals, resolved } = makeService(host);
    const pending = service.handleHarnessRequest(REQ);
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({ title: 'npm publish', agent: 'claude', hostLabel: 'this server' });
    expect(approvals[0].expiresAt).toBeGreaterThan(Date.now());
    expect(service.pendingApprovals()).toHaveLength(1);
    expect(service.resolveApproval(approvals[0].id, 'not-an-option')).toBe(false);
    expect(service.resolveApproval(approvals[0].id, 'allow')).toBe(true);
    const res = await pending;
    expect(decision).toEqual({ optionId: 'allow' });
    expect(res.ok && res.text).toContain('after ask');
    expect(resolved).toEqual([approvals[0].id]);
    expect(service.pendingApprovals()).toHaveLength(0);
  });

  it('expires an unanswered card as {expired}, distinct from a rejection', async () => {
    vi.useFakeTimers();
    let decision: unknown;
    const host = askingHost((d) => (decision = d));
    const { service, approvals, resolved } = makeService(host);
    const pending = service.handleHarnessRequest(REQ);
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(600_001);
    await pending;
    expect(decision).toEqual({ expired: true });
    expect(resolved).toHaveLength(1);
  });

  it('abortThread cancels the turn and dismisses this thread\'s cards', async () => {
    let decision: unknown;
    const host = scriptedHost({
      turn: async (_input, sink) => {
        decision = await sink.onPermission({ permissionId: 'perm-1', title: 'rm -rf', options: OPTIONS });
        return { ok: true, stopReason: 'cancelled', text: '' };
      }
    });
    const { service, approvals } = makeService(host);
    const pending = service.handleHarnessRequest(REQ);
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    service.abortThread('thread-1');
    const res = await pending;
    expect(decision).toEqual({ expired: true });
    expect(host.cancelled).toBe(1);
    expect(res.ok && res.text).toContain('cancelled by the user');
    expect((await readHarnessRuns())[0].status).toBe('cancelled');
  });
});

describe('approval tiers', () => {
  const OPTIONS = [
    { optionId: 'allow_always', kind: 'allow_always', name: 'Always Allow' },
    { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
  ];

  /** A host whose turn raises one execute ask and reports the decision. */
  function execAskingHost(command: string, onDecision: (d: unknown) => void, title = command): ScriptedHost {
    return scriptedHost({
      turn: async (_input, sink) => {
        const decision = await sink.onPermission({
          permissionId: 'perm-1',
          title,
          toolName: 'execute',
          command,
          options: OPTIONS
        });
        onDecision(decision);
        return { ok: true, stopReason: 'end_turn', text: 'after ask' };
      }
    });
  }

  it('yolo auto-allows an execute ask via allow_once, raising no card', async () => {
    let decision: unknown;
    const host = execAskingHost('npm publish', (d) => (decision = d));
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'yolo' })
    });
    const res = await service.handleHarnessRequest(REQ);
    expect(res.ok).toBe(true);
    // The allow_once option, never allow_always — that would teach the agent
    // a permanent rule nobody saw.
    expect(decision).toEqual({ optionId: 'allow' });
    expect(approvals).toHaveLength(0);
  });

  it('yolo auto-allows non-execute asks too', async () => {
    let decision: unknown;
    const host = scriptedHost({
      turn: async (_input, sink) => {
        decision = await sink.onPermission({
          permissionId: 'perm-1',
          title: 'Fetch https://example.com',
          toolName: 'fetch',
          options: OPTIONS
        });
        return { ok: true, stopReason: 'end_turn', text: 'done' };
      }
    });
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'yolo' })
    });
    await service.handleHarnessRequest(REQ);
    expect(decision).toEqual({ optionId: 'allow' });
    expect(approvals).toHaveLength(0);
  });

  it('an allowlisted command clears tier 1 without calling the judge', async () => {
    let decision: unknown;
    const judge = vi.fn();
    const host = execAskingHost('git status', (d) => (decision = d));
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'assisted', allowlist: ['git status'] }),
      judge
    });
    await service.handleHarnessRequest(REQ);
    expect(decision).toEqual({ optionId: 'allow' });
    expect(approvals).toHaveLength(0);
    expect(judge).not.toHaveBeenCalled();
  });

  it('a judge-safe command auto-allows, judged against the harness brief', async () => {
    let decision: unknown;
    const judge = vi.fn<HarnessServiceDeps['judge']>(async () => ({ verdict: 'safe' }));
    const host = execAskingHost('npm test', (d) => (decision = d));
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'assisted' }),
      judge
    });
    await service.handleHarnessRequest(REQ);
    expect(decision).toEqual({ optionId: 'allow' });
    expect(approvals).toHaveLength(0);
    // command, cwd, exec settings, defaults, then the intent: the agent's brief.
    expect(judge.mock.calls[0][0]).toBe('npm test');
    expect(judge.mock.calls[0][4]).toBe('add a --version flag');
  });

  it('a judge-flagged command cards, carrying the verdict and reason', async () => {
    const judge = vi.fn(async () => ({ verdict: 'unsafe' as const, reason: 'publishes a package' }));
    const host = execAskingHost('npm publish', () => undefined);
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'assisted' }),
      judge
    });
    const pending = service.handleHarnessRequest(REQ);
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({ judgeVerdict: 'unsafe', judgeReason: 'publishes a package' });
    service.resolveApproval(approvals[0].id, 'reject');
    await pending;
  });

  it('manual mode cards an execute ask with judgeVerdict null, never calling the judge', async () => {
    const judge = vi.fn();
    const host = execAskingHost('npm test', () => undefined);
    const { service, approvals } = makeService(host, { judge });
    const pending = service.handleHarnessRequest(REQ);
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0].judgeVerdict).toBeNull();
    expect(judge).not.toHaveBeenCalled();
    service.resolveApproval(approvals[0].id, 'allow');
    await pending;
  });

  it('a command referencing a read-only root cards even in yolo, with the guard reason', async () => {
    const protectedDir = mkdtempSync(join(tmpdir(), 'stem-harness-ro-'));
    mkdirSync(dirname(protectedRootsPath()), { recursive: true });
    writeFileSync(protectedRootsPath(), JSON.stringify({ roots: [protectedDir] }), 'utf8');
    try {
      // The dir itself, not a file inside it: only an existing path realpaths on
      // macOS (/var vs /private/var), and the guard matches canonical shapes.
      const host = execAskingHost(`ls ${protectedDir}`, () => undefined);
      const { service, approvals } = makeService(host, {
        readSettings: async () => serverSettings({ approvalMode: 'yolo' })
      });
      const pending = service.handleHarnessRequest(REQ);
      await vi.waitFor(() => expect(approvals).toHaveLength(1));
      expect(approvals[0].guardReason).toContain('read-only');
      service.resolveApproval(approvals[0].id, 'reject');
      await pending;
    } finally {
      rmSync(protectedDir, { recursive: true, force: true });
    }
  });

  it('cards despite a safe verdict when the ask offers no allow_once option', async () => {
    const judge = vi.fn<HarnessServiceDeps['judge']>(async () => ({ verdict: 'safe' }));
    const host = scriptedHost({
      turn: async (_input, sink) => {
        await sink.onPermission({
          permissionId: 'perm-1',
          title: 'npm test',
          toolName: 'execute',
          command: 'npm test',
          options: [{ optionId: 'reject', kind: 'reject_once', name: 'Reject' }]
        });
        return { ok: true, stopReason: 'end_turn', text: 'done' };
      }
    });
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'assisted' }),
      judge
    });
    const pending = service.handleHarnessRequest(REQ);
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    service.resolveApproval(approvals[0].id, 'reject');
    await pending;
  });

  it('device-hosted asks classify against that device\'s bucket, not the shared list', async () => {
    const decisions: unknown[] = [];
    const judge = vi.fn<HarnessServiceDeps['judge']>(async () => ({ verdict: 'unsure' }));
    const deviceHost = scriptedHost({
      label: 'Mac',
      turn: async (_input, sink) => {
        decisions.push(
          await sink.onPermission({
            permissionId: 'perm-1',
            title: 'npm test',
            toolName: 'execute',
            command: 'npm test',
            options: OPTIONS
          })
        );
        decisions.push(
          await sink.onPermission({
            permissionId: 'perm-2',
            title: 'git status',
            toolName: 'execute',
            command: 'git status',
            options: OPTIONS
          })
        );
        return { ok: true, stopReason: 'end_turn', text: 'done' };
      }
    });
    deviceHost.platform = () => 'darwin';
    const { service, approvals } = makeService(scriptedHost({}), {
      resolveDevice: async () => ({ ok: true, deviceId: 'dev-1', label: 'Mac' }),
      deviceHost: async () => deviceHost,
      readSettings: async () =>
        serverSettings({
          approvalMode: 'assisted',
          // 'git status' is trusted only on the SERVER: the device bucket is
          // zero-trust, so on the Mac it must fall through to the judge.
          allowlist: ['git status'],
          deviceAllowlists: { 'dev-1': ['npm test'] }
        }),
      judge,
      clientFolders: async () => []
    });
    const pending = service.handleHarnessRequest({ ...REQ, device: 'Mac', cwd: '/tmp/proj' });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0].title).toBe('git status');
    service.resolveApproval(approvals[0].id, 'allow');
    await pending;
    expect(decisions[0]).toEqual({ optionId: 'allow' });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0]).toBe('git status');
  });
});

describe('results', () => {
  it('formats a failed turn as the tool error, and records it', async () => {
    const host = scriptedHost({ turn: async () => ({ ok: false, error: 'adapter crashed' }) });
    const { service } = makeService(host);
    const res = await service.handleHarnessRequest(REQ);
    expect(!res.ok && res.error).toBe('The claude run failed on this server: adapter crashed');
    expect((await readHarnessRuns())[0]).toMatchObject({ status: 'failed', error: 'adapter crashed' });
  });

  it('folds events into the bookkeeping line and settles cost onto the record', async () => {
    const host = scriptedHost({
      turn: async (_input, sink) => {
        sink.onEvent([
          { type: 'tool_call', tag: 'tool_call', toolCallId: 't1', locations: [{ path: 'src/cli.ts' }] },
          { type: 'status', tag: 'usage_update', text: 'usage', cost: { amount: 0.31 } }
        ]);
        return { ok: true, stopReason: 'end_turn', text: 'Added the flag.' };
      }
    });
    const updates: string[] = [];
    const { service } = makeService(host, {
      onProgress: (u) => updates.push(u.detail)
    });
    const res = await service.handleHarnessRequest(REQ);
    expect(res.ok && res.text).toContain('[claude · on this server · 1 tool call · session cost $0.31]');
    expect(res.ok && res.text).toContain('Files touched: src/cli.ts');
    expect((await readHarnessRuns())[0]).toMatchObject({ status: 'ok', costUsd: 0.31 });
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1]).toContain('$0.31');
  });
});
