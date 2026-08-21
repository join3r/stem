// LocalHarnessHost against a scripted AcpRuntime (the runtimeFactory seam):
// the sessionId-as-sessionKey scheme, the fail-closed acceptEdits switch for
// claude, event pumping and text authority, cancel-before-start, permission
// routing to the owning turn's sink, and the optionId -> outcome translation.
import { describe, expect, it, vi } from 'vitest';
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeTurnResult
} from 'acpx/runtime';
import { LocalHarnessHost, type HarnessRuntimeConfig } from '../../src/server/harness/local-host';
import type { HarnessPermissionAsk, HarnessPermissionDecision, HarnessTurnSink } from '../../src/server/harness/host';

interface FakeRuntimeScript {
  events?: AcpRuntimeEvent[];
  result?: AcpRuntimeTurnResult;
  ensureError?: string;
  setModeError?: string;
  /** Hold the turn open until the test releases it. */
  hold?: boolean;
}

function fakeRuntime(script: FakeRuntimeScript = {}) {
  const calls = {
    ensures: [] as Array<{ sessionKey: string; agent: string; cwd?: string }>,
    modes: [] as string[],
    cancels: 0,
    closes: 0
  };
  let releaseTurn: (() => void) | null = null;
  let config: HarnessRuntimeConfig | null = null;

  const runtime: AcpRuntime = {
    async ensureSession(input) {
      calls.ensures.push({ sessionKey: input.sessionKey, agent: input.agent, cwd: input.cwd });
      if (script.ensureError) throw new Error(script.ensureError);
      return {
        sessionKey: input.sessionKey,
        backend: 'acpx',
        runtimeSessionName: 'fake',
        backendSessionId: `acp-${input.sessionKey}`
      };
    },
    async setMode(input) {
      calls.modes.push(input.mode);
      if (script.setModeError) throw new Error(script.setModeError);
    },
    startTurn(input) {
      const events = script.events ?? [];
      let settle: (r: AcpRuntimeTurnResult) => void;
      const result = new Promise<AcpRuntimeTurnResult>((r) => (settle = r));
      const finish = () => settle(script.result ?? { status: 'completed', stopReason: 'end_turn' });
      if (script.hold) releaseTurn = finish;
      else queueMicrotask(finish);
      return {
        requestId: input.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {
          for (const event of events) yield event;
        })(),
        result,
        cancel: async () => {
          calls.cancels += 1;
          settle({ status: 'cancelled' });
        },
        closeStream: async () => {}
      };
    },
    runTurn() {
      throw new Error('runTurn is the compat shim; the host must use startTurn');
    },
    async cancel() {},
    async close() {
      calls.closes += 1;
    }
  };

  const factory = async (c: HarnessRuntimeConfig) => {
    config = c;
    return runtime;
  };
  return { factory, calls, release: () => releaseTurn?.(), permission: () => config!.onPermissionRequest };
}

const SINK: HarnessTurnSink = {
  onEvent: () => {},
  onPermission: async () => ({ expired: true })
};

describe('sessions', () => {
  it('mints a fresh sessionId as the acpx key and reuses a passed one', async () => {
    const { factory, calls } = fakeRuntime();
    const host = new LocalHarnessHost({ runtimeFactory: factory });
    const fresh = await host.ensureSession({ agent: 'opencode', cwd: '/tmp/p' });
    expect(fresh.ok && fresh.sessionId).toMatch(/^opencode-/);
    const resumed = await host.ensureSession({ agent: 'opencode', cwd: '/tmp/p', sessionId: 'opencode-abc' });
    expect(resumed).toEqual({ ok: true, sessionId: 'opencode-abc' });
    expect(calls.ensures.map((e) => e.sessionKey)).toEqual([fresh.ok ? fresh.sessionId : '', 'opencode-abc']);
    expect(calls.modes).toEqual([]);
  });

  it('switches claude sessions to acceptEdits, and fails closed when it cannot', async () => {
    const good = fakeRuntime();
    const host = new LocalHarnessHost({ runtimeFactory: good.factory });
    const ensured = await host.ensureSession({ agent: 'claude', cwd: '/tmp/p' });
    expect(ensured.ok).toBe(true);
    expect(good.calls.modes).toEqual(['acceptEdits']);

    const bad = fakeRuntime({ setModeError: 'no such mode' });
    const failing = new LocalHarnessHost({ runtimeFactory: bad.factory });
    const refused = await failing.ensureSession({ agent: 'claude', cwd: '/tmp/p' });
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.error).toContain('no such mode');
  });

  it('reports an ensure failure as words, not a throw', async () => {
    const { factory } = fakeRuntime({ ensureError: 'adapter not installed' });
    const host = new LocalHarnessHost({ runtimeFactory: factory });
    const res = await host.ensureSession({ agent: 'claude', cwd: '/tmp/p' });
    expect(!res.ok && res.error).toContain('adapter not installed');
  });
});

describe('turns', () => {
  it('pumps events to the sink and answers with the output text', async () => {
    const { factory } = fakeRuntime({
      events: [
        { type: 'text_delta', text: 'thinking...', stream: 'thought' },
        { type: 'text_delta', text: 'All done.' },
        { type: 'tool_call', text: '', tag: 'tool_call', toolCallId: 't1', title: 'npm test' }
      ]
    });
    const host = new LocalHarnessHost({ runtimeFactory: factory });
    const ensured = await host.ensureSession({ agent: 'opencode', cwd: '/tmp/p' });
    const seen: unknown[] = [];
    const handle = host.runTurn(
      { turnId: 'turn-1', agent: 'opencode', cwd: '/tmp/p', sessionId: ensured.ok ? ensured.sessionId : '', prompt: 'go' },
      { ...SINK, onEvent: (events) => seen.push(...events) }
    );
    const result = await handle.result;
    expect(result).toEqual({ ok: true, stopReason: 'end_turn', text: 'All done.' });
    expect(seen).toHaveLength(3);
  });

  it('re-ensures a session the process no longer holds (cold resume)', async () => {
    const { factory, calls } = fakeRuntime();
    const host = new LocalHarnessHost({ runtimeFactory: factory });
    const handle = host.runTurn(
      { turnId: 'turn-1', agent: 'claude', cwd: '/tmp/p', sessionId: 'claude-cold', prompt: 'go' },
      SINK
    );
    const result = await handle.result;
    expect(result.ok).toBe(true);
    expect(calls.ensures).toEqual([{ sessionKey: 'claude-cold', agent: 'claude', cwd: '/tmp/p' }]);
  });

  it('cancel lands even when called before the turn exists, and is idempotent', async () => {
    const { factory, calls } = fakeRuntime({ hold: true });
    const host = new LocalHarnessHost({ runtimeFactory: factory });
    const ensured = await host.ensureSession({ agent: 'opencode', cwd: '/tmp/p' });
    const handle = host.runTurn(
      { turnId: 'turn-1', agent: 'opencode', cwd: '/tmp/p', sessionId: ensured.ok ? ensured.sessionId : '', prompt: 'go' },
      SINK
    );
    handle.cancel();
    handle.cancel();
    const result = await handle.result;
    expect(result).toMatchObject({ ok: true, stopReason: 'cancelled' });
    expect(calls.cancels).toBeGreaterThanOrEqual(1);
  });

  it('maps a failed acpx result to {ok: false} without rejecting', async () => {
    const { factory } = fakeRuntime({ result: { status: 'failed', error: { message: 'adapter died' } } });
    const host = new LocalHarnessHost({ runtimeFactory: factory });
    const ensured = await host.ensureSession({ agent: 'opencode', cwd: '/tmp/p' });
    const handle = host.runTurn(
      { turnId: 'turn-1', agent: 'opencode', cwd: '/tmp/p', sessionId: ensured.ok ? ensured.sessionId : '', prompt: 'go' },
      SINK
    );
    await expect(handle.result).resolves.toEqual({ ok: false, error: 'adapter died' });
  });
});

describe('permission routing', () => {
  function ask(sessionId: string): AcpPermissionRequest {
    return {
      sessionId,
      inferredKind: 'execute',
      raw: {
        sessionId,
        toolCall: {
          title: 'npm publish',
          kind: 'execute',
          content: [
            { type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' },
            { type: 'content', content: { type: 'text', text: 'a note' } }
          ]
        },
        options: [
          { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
        ]
      } as AcpPermissionRequest['raw']
    };
  }

  async function routed(
    decision: HarnessPermissionDecision
  ): Promise<{ decision: AcpPermissionDecision | undefined; asked: HarnessPermissionAsk[] }> {
    const { factory, permission, release } = fakeRuntime({ hold: true });
    const host = new LocalHarnessHost({ runtimeFactory: factory });
    const ensured = await host.ensureSession({ agent: 'opencode', cwd: '/tmp/p' });
    const sessionId = ensured.ok ? ensured.sessionId : '';
    const asked: HarnessPermissionAsk[] = [];
    const handle = host.runTurn(
      { turnId: 'turn-1', agent: 'opencode', cwd: '/tmp/p', sessionId, prompt: 'go' },
      {
        onEvent: () => {},
        onPermission: async (a) => {
          asked.push(a);
          return decision;
        }
      }
    );
    // acpx cites its own backendSessionId, which the host learned from ensure.
    const result = await permission()(ask(`acp-${sessionId}`));
    release();
    await handle.result;
    return { decision: result, asked };
  }

  it('translates the chosen option kind into the acpx outcome', async () => {
    const { decision, asked } = await routed({ optionId: 'allow' });
    expect(decision).toEqual({ outcome: 'allow_once' });
    expect(asked[0]).toMatchObject({
      title: 'npm publish',
      toolName: 'execute',
      content: [
        { type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' },
        { type: 'text', text: 'a note' }
      ]
    });
  });

  it('a timeout answers cancel, not a rejection somebody made', async () => {
    const { decision } = await routed({ expired: true });
    expect(decision).toEqual({ outcome: 'cancel' });
  });

  it('leaves an ask no live turn claims to the mode resolver', async () => {
    const { factory, permission } = fakeRuntime();
    const host = new LocalHarnessHost({ runtimeFactory: factory });
    await host.ensureSession({ agent: 'opencode', cwd: '/tmp/p' });
    const onPermission = vi.fn();
    void onPermission;
    expect(permission()(ask('nobody'))).toBeUndefined();
  });
});
