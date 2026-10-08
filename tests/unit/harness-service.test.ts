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
import type { HarnessApprovalRequest, HarnessModelListing, ServerSettings } from '../../src/shared/types';
import type {
  HarnessEnsureResult,
  HarnessPermissionAsk,
  HarnessHost,
  HarnessRunTurnInput,
  HarnessSessionSpec,
  HarnessTurnResult,
  HarnessTurnSink
} from '../../src/server/harness/host';
import { HarnessService, type HarnessServiceDeps } from '../../src/server/harness/service';
import { readHarnessRuns } from '../../src/server/harness/records';
import { readHarnessActivities, type HarnessActivity } from '../../src/server/harness/activities';
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
  cancelReasons: (string | undefined)[];
  modelProbes: string[];
}

function scriptedHost(script: {
  ensure?: (spec: HarnessSessionSpec) => HarnessEnsureResult;
  turn?: (input: HarnessRunTurnInput, sink: HarnessTurnSink) => Promise<HarnessTurnResult>;
  models?: (agent: string) => HarnessModelListing;
  label?: string;
  available?: boolean;
}): ScriptedHost {
  const host: ScriptedHost = {
    ensures: [],
    turns: [],
    sinks: [],
    cancelled: 0,
    cancelReasons: [],
    modelProbes: [],
    label: () => script.label ?? 'this server',
    available: () => script.available ?? true,
    async listModels(agent) {
      host.modelProbes.push(agent);
      return script.models?.(agent) ?? { ok: true, models: ['claude-fable-5-1[1m]', 'claude-sonnet-5'] };
    },
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
        cancel: (reason) => {
          host.cancelled += 1;
          host.cancelReasons.push(reason);
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
    // Card-focused suites: the first refusal goes to the user. The blocking
    // tests pass their own streak.
    blockStreak: 1,
    settings: async () => ({}),
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

describe('inner work history', () => {
  it('makes inner work readable while its long-running coding-agent call is still active', async () => {
    let release!: (result: HarnessTurnResult) => void;
    const held = new Promise<HarnessTurnResult>((resolve) => { release = resolve; });
    const delivered: HarnessActivity[] = [];
    const host = scriptedHost({ turn: (_input, sink) => {
      sink.onEvent([{ type: 'tool_call', toolCallId: 'build', title: 'Build', rawInput: 'npm run build' }]);
      return held;
    } });
    const { service } = makeService(host, { onActivity: (row) => delivered.push(row) });
    const running = service.handleHarnessRequest({ ...REQ, itemId: 'live-outer' });
    try {
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(delivered[0]).toMatchObject({ title: 'Build', status: 'running' });
      expect((await readHarnessActivities({ itemId: 'live-outer' }))[0]).toEqual(delivered[0]);
      expect((await readHarnessRuns())[0].status).toBe('running');
    } finally {
      release({ ok: true, stopReason: 'cancelled', text: '' });
      await running;
    }
    expect((await readHarnessActivities({ itemId: 'live-outer' }))[0].status).toBe('cancelled');
  });

  it('retains streamed work when the host fails, linked to the outer coding-agent call', async () => {
    const delivered: HarnessActivity[] = [];
    const host = scriptedHost({ turn: async (_input, sink) => {
      sink.onEvent([
        { type: 'tool_call', toolCallId: 'build', title: 'Build', rawInput: { command: 'npm run build' } },
        { type: 'tool_call', toolCallId: 'build', status: 'completed', rawOutput: 'Build succeeded' },
        { type: 'text_delta', stream: 'output', text: 'Uploading the build now.' },
        { type: 'tool_call', toolCallId: 'upload', title: 'Upload' }
      ]);
      return { ok: false, error: 'Device disconnected' };
    } });
    const { service } = makeService(host, { onActivity: (row) => delivered.push(row) });
    const result = await service.handleHarnessRequest({ ...REQ, itemId: 'outer-item' });
    expect(result.ok).toBe(false);
    const records = await readHarnessActivities({ threadId: REQ.threadId, itemId: 'outer-item' });
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({ title: 'Build', status: 'completed', output: 'Build succeeded' });
    expect(records[2]).toMatchObject({ title: 'Upload', status: 'failed' });
    expect(delivered).toEqual(records);
    expect((await readHarnessRuns())[0]).toMatchObject({ itemId: 'outer-item', status: 'failed' });
  });
});

describe('gates', () => {
  it('keeps the agent\'s own words per thread for the reply mail, and hands them over once', async () => {
    const host = scriptedHost({ turn: async () => ({ ok: true, stopReason: 'end_turn', text: 'Added the flag.' }) });
    const { service } = makeService(host);
    const res = await service.handleHarnessRequest(REQ);
    // The tool result carries the footer for the persona…
    expect(res.ok && res.text).toContain('This session continues');
    // …the mail gets the agent's reply alone, and only for its own thread.
    expect(service.takeAgentReplies('other-thread')).toEqual([]);
    expect(service.takeAgentReplies(REQ.threadId)).toEqual(['Added the flag.']);
    expect(service.takeAgentReplies(REQ.threadId)).toEqual([]);
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

  it("carries the request's (persona) model pin on the ensure, the retry, and the turn", async () => {
    await rememberSession({ threadId: 'thread-1', host: 'server', agent: 'claude', cwd: scratch, sessionId: 'stale' });
    const host = scriptedHost({
      ensure: (spec) =>
        spec.sessionId ? { ok: false, error: 'unknown session' } : { ok: true, sessionId: 'session-new' }
    });
    const { service } = makeService(host);
    const res = await service.handleHarnessRequest({ ...REQ, model: 'claude-haiku-4-5' });
    expect(res.ok).toBe(true);
    expect(host.ensures.map((e) => e.model)).toEqual(['claude-haiku-4-5', 'claude-haiku-4-5']);
    expect(host.turns[0]).toMatchObject({ model: 'claude-haiku-4-5' });
  });

  it("carries the persona's Auto opt-in on the ensure and the turn, and nothing without it", async () => {
    const host = scriptedHost({});
    const { service } = makeService(host);
    await service.handleHarnessRequest({ ...REQ, autoMode: true });
    expect(host.ensures[0].autoMode).toBe(true);
    expect(host.turns[0].autoMode).toBe(true);
    await service.handleHarnessRequest(REQ);
    expect(host.ensures[1].autoMode).toBeUndefined();
    expect(host.turns[1].autoMode).toBeUndefined();
  });

  it('sends no model when the request carries none (the agent runs its own default)', async () => {
    const host = scriptedHost({});
    const { service } = makeService(host, {
      settings: async () => ({ agents: { claude: { command: 'my-claude acp' } } })
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

  it('an abort with a reason names it instead of blaming the user', async () => {
    // A scheduler timeout, a deleted chat, a dead worker: Stem stopped the
    // run, nobody pressed Stop. The tool text must say which.
    const host = scriptedHost({
      turn: async (_input, sink) => {
        await sink.onPermission({ permissionId: 'perm-1', title: 'xcodebuild archive', options: OPTIONS });
        return { ok: true, stopReason: 'cancelled', text: '' };
      }
    });
    const { service, approvals } = makeService(host);
    const pending = service.handleHarnessRequest(REQ);
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    service.abortThread('thread-1', 'the scheduled run timed out');
    const res = await pending;
    expect(host.cancelReasons).toEqual(['the scheduled run timed out']);
    expect(res.ok && res.text).toContain('stopped by Stem: the scheduled run timed out');
    expect(res.ok && res.text).not.toContain('by the user');
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

  it('a judge-safe command auto-allows, judged against the user’s words, not the brief', async () => {
    let decision: unknown;
    const judge = vi.fn<HarnessServiceDeps['judge']>(async () => ({ verdict: 'safe' }));
    const host = execAskingHost('npm test', (d) => (decision = d));
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'assisted' }),
      judge
    });
    await service.handleHarnessRequest({
      ...REQ,
      judgeContext: { userWords: ['make the tool print its version'], actions: [] }
    });
    expect(decision).toEqual({ optionId: 'allow' });
    expect(approvals).toHaveLength(0);
    // The parent turn's user words — never the brief the persona wrote.
    const call = judge.mock.calls[0][0];
    expect(call.command).toBe('npm test');
    expect(call.context.userWords).toEqual(['make the tool print its version']);
    expect(JSON.stringify(call.context)).not.toContain('add a --version flag');
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
    expect(judge.mock.calls[0][0].command).toBe('git status');
  });

  it('rejects a judged ask back to the agent until the escalation point, then cards', async () => {
    const decisions: unknown[] = [];
    const judge = vi.fn<HarnessServiceDeps['judge']>(async () => ({ verdict: 'unsafe', reason: 'not asked for' }));
    const host = scriptedHost({
      turn: async (_input, sink) => {
        for (const cmd of ['rm -rf a', 'rm -rf b', 'rm -rf c']) {
          decisions.push(
            await sink.onPermission({ permissionId: cmd, title: cmd, toolName: 'execute', command: cmd, options: OPTIONS })
          );
        }
        return { ok: true, stopReason: 'end_turn', text: 'done' };
      }
    });
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'assisted' }),
      judge,
      blockStreak: 3
    });
    const pending = service.handleHarnessRequest(REQ);
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0].title).toBe('rm -rf c');
    service.resolveApproval(approvals[0].id, 'reject');
    await pending;
    const reject = OPTIONS.find((o) => o.kind === 'reject_once')!.optionId;
    expect(decisions.slice(0, 2)).toEqual([{ optionId: reject }, { optionId: reject }]);
  });

  it('parks a mail run at the escalation point instead of carding, and says so in the result', async () => {
    const judge = vi.fn<HarnessServiceDeps['judge']>(async () => ({ verdict: 'unsafe', reason: 'not asked for' }));
    const host = scriptedHost({
      turn: async (_input, sink) => {
        await sink.onPermission({ permissionId: 'p', title: 'npm publish', toolName: 'execute', command: 'npm publish', options: OPTIONS });
        return { ok: true, stopReason: 'cancelled', text: '' };
      }
    });
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'assisted' }),
      judge
    });
    const result = await service.handleHarnessRequest({ ...REQ, isMail: true, isScheduled: true });
    expect(approvals).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, park: { kind: 'harness', command: 'npm publish', reason: 'not asked for' } });
  });

  it('lets a command the user allowed on a parked run through once', async () => {
    const decisions: unknown[] = [];
    const judge = vi.fn<HarnessServiceDeps['judge']>(async () => ({ verdict: 'unsafe' }));
    const host = execAskingHost('npm publish', (d) => decisions.push(d));
    const { service } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'assisted' }),
      judge,
      blockStreak: 3
    });
    // A grant for another machine does not cover this one…
    service.grantOnce(REQ.threadId, { command: 'npm publish', cwd: scratch, deviceId: 'mac-1' });
    // …only the folder and server the user saw.
    service.grantOnce(REQ.threadId, { command: 'npm publish', cwd: scratch });
    await service.handleHarnessRequest(REQ);
    expect(decisions[0]).toEqual({ optionId: 'allow' });
    expect(judge).not.toHaveBeenCalled();
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

describe('listModels', () => {
  it('asks this server when no paired computer runs coding agents', async () => {
    const host = scriptedHost({ models: () => ({ ok: true, models: ['claude-fable-5-1[1m]', 'claude-haiku-4-5'], currentModelId: 'claude-fable-5-1[1m]' }) });
    const { service } = makeService(host);
    const res = await service.listModels({});
    expect(host.modelProbes).toEqual(['claude']);
    expect(res).toEqual({
      ok: true,
      agent: 'claude',
      models: ['claude-fable-5-1[1m]', 'claude-haiku-4-5'],
      currentModelId: 'claude-fable-5-1[1m]',
      hostLabel: 'this server'
    });
  });

  it('auto-picks the first CONNECTED paired computer that announced coding agents', async () => {
    const server = scriptedHost({ label: 'this server' });
    const asleep = scriptedHost({ label: 'sleepy-mac', available: false });
    const mac = scriptedHost({ label: 'join3r-macbook', models: () => ({ ok: true, models: ['claude-sonnet-5'] }) });
    const { service } = makeService(server, {
      announcedHosts: async () => [
        { deviceId: 'dev-off', enabled: false },
        { deviceId: 'dev-asleep', enabled: true },
        { deviceId: 'dev-mac', enabled: true }
      ],
      resolveDevice: async (id) => ({ ok: true, deviceId: id, label: id === 'dev-mac' ? 'join3r-macbook' : 'sleepy-mac' }),
      deviceHost: async (id) => (id === 'dev-mac' ? mac : id === 'dev-asleep' ? asleep : null)
    });
    const res = await service.listModels({});
    expect(res).toMatchObject({ ok: true, hostLabel: 'join3r-macbook', models: ['claude-sonnet-5'] });
    expect(server.modelProbes).toEqual([]);
    expect(asleep.modelProbes).toEqual([]);
    expect(mac.modelProbes).toEqual(['claude']);
  });

  it('a named host is honoured, and a disconnected one is refused rather than substituted', async () => {
    const server = scriptedHost({});
    const asleep = scriptedHost({ label: 'sleepy-mac', available: false });
    const { service } = makeService(server, {
      resolveDevice: async (id) => ({ ok: true, deviceId: id, label: 'sleepy-mac' }),
      deviceHost: async () => asleep
    });
    const res = await service.listModels({ host: 'sleepy-mac' });
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toContain('not connected');
    expect(server.modelProbes).toEqual([]);
    // 'server' pins the local host even when devices exist.
    const local = await service.listModels({ host: 'server' });
    expect(local).toMatchObject({ ok: true, hostLabel: 'this server' });
  });

  it('relays the host\'s own failure text', async () => {
    const host = scriptedHost({ models: () => ({ ok: false, error: 'claude did not advertise any models' }) });
    const { service } = makeService(host);
    const res = await service.listModels({});
    expect(res).toEqual({ ok: false, error: 'claude did not advertise any models' });
  });
});

describe('review only', () => {
  const OPTIONS = [
    { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
  ];
  const ack = (spec: HarnessSessionSpec): HarnessEnsureResult => ({
    ok: true,
    sessionId: spec.sessionId ?? 'fresh-session',
    ...(spec.reviewOnly ? { reviewOnly: true as const } : {})
  });

  /** A turn raising each ask in order, collecting the decisions. */
  function askingHost(asks: Omit<HarnessPermissionAsk, 'permissionId' | 'options'>[], out: unknown[]): ScriptedHost {
    return scriptedHost({
      ensure: ack,
      turn: async (_input, sink) => {
        for (const [i, ask] of asks.entries()) {
          out.push(await sink.onPermission({ permissionId: `p${i}`, options: OPTIONS, ...ask }));
        }
        return { ok: true, stopReason: 'end_turn', text: 'reviewed' };
      }
    });
  }

  it('runs reads inside the folder and refuses every write, even in yolo, never carding', async () => {
    const decisions: unknown[] = [];
    const host = askingHost(
      [
        { title: 'git diff', toolName: 'execute', command: 'git diff' },
        { title: 'rm -rf src', toolName: 'execute', command: 'rm -rf src' },
        { title: 'cat /etc/passwd', toolName: 'execute', command: 'cat /etc/passwd' },
        { title: 'Edit src/a.ts', toolName: 'edit' },
        // The user's own allowlist is not a reviewer's.
        { title: 'npm install', toolName: 'execute', command: 'npm install' }
      ],
      decisions
    );
    const judge = vi.fn();
    const { service, approvals } = makeService(host, {
      readSettings: async () => serverSettings({ approvalMode: 'yolo', allowlist: ['npm install'] }),
      judge
    });
    const res = await service.handleHarnessRequest({ ...REQ, agent: 'codex', reviewOnly: true, autoMode: true });
    expect(res.ok).toBe(true);
    expect(decisions).toEqual([
      { optionId: 'allow' },
      { optionId: 'reject' },
      { optionId: 'reject' },
      { optionId: 'reject' },
      { optionId: 'reject' }
    ]);
    expect(approvals).toHaveLength(0);
    expect(judge).not.toHaveBeenCalled();
    // Review only wins over Auto on the way to the host.
    expect(host.ensures[0]).toMatchObject({ reviewOnly: true });
    expect(host.ensures[0].autoMode).toBeUndefined();
    expect(host.turns[0].reviewOnly).toBe(true);
  });

  it('refuses to run when the host did not confirm review-only (an older Stem on the Mac)', async () => {
    const host = scriptedHost({ label: 'Studio' });
    const { service } = makeService(host);
    const res = await service.handleHarnessRequest({ ...REQ, agent: 'codex', reviewOnly: true });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('cannot run review-only coding agents yet');
    expect(host.turns).toHaveLength(0);
  });

  it('a recall-off delegation gets no background facts', async () => {
    const host = scriptedHost({});
    const facts = vi.fn(async () => ({ facts: [{ text: 'secret fact' }] }));
    const { service } = makeService(host, { facts });
    await service.handleHarnessRequest({ ...REQ, noRecall: true });
    expect(host.turns[0].prompt).toBe('add a --version flag');
    expect(facts).not.toHaveBeenCalled();
  });
});
