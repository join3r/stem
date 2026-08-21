// The client half of the harness device wire: consent read fresh from this
// disk on every request, requestId dedupe across stream overlap, ensure/run
// round-trips over a scripted acpx runtime, event batching with the ack as the
// cancel fallback, the permission RPC retried with the same permissionId, and
// the cancel frame honored even with the switch off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpRuntime, AcpRuntimeEvent, AcpRuntimeTurnResult } from 'acpx/runtime';
import { createDesktopHarnessHost, type DesktopHarnessHost } from '../../src/desktop/harness-host';
import { writeHarnessHostEnabled } from '../../src/desktop/harness-host/store';
import { LocalHarnessHost } from '../../src/server/harness/local-host';
import type { DeviceHarnessEventBatch, DeviceHarnessRequest } from '../../src/shared/types';

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stem-harness-host-'));
  process.env.STEM_HARNESS_HOST_FILE = join(dir, 'harness-host.json');
  await writeHarnessHostEnabled(true);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.STEM_HARNESS_HOST_FILE;
  rmSync(dir, { recursive: true, force: true });
});

interface FakeAcpxScript {
  events?: AcpRuntimeEvent[];
  result?: AcpRuntimeTurnResult;
  hold?: boolean;
  permission?: boolean;
}

/** A LocalHarnessHost over a scripted runtime (same shape as its own tests). */
function fakeAcpx(script: FakeAcpxScript = {}) {
  const calls = { cancels: 0 };
  let release: (() => void) | null = null;
  let permissionRouter: ((req: unknown) => Promise<unknown> | undefined) | null = null;
  const runtime: AcpRuntime = {
    async ensureSession(input) {
      return { sessionKey: input.sessionKey, backend: 'acpx', runtimeSessionName: 'fake' };
    },
    async setMode() {},
    startTurn(input) {
      let settle: (r: AcpRuntimeTurnResult) => void;
      const result = new Promise<AcpRuntimeTurnResult>((r) => (settle = r));
      const finish = () => settle(script.result ?? { status: 'completed', stopReason: 'end_turn' });
      if (script.hold) release = finish;
      else queueMicrotask(finish);
      return {
        requestId: input.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {
          for (const event of script.events ?? []) yield event;
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
      throw new Error('unused');
    },
    async cancel() {},
    async close() {}
  };
  return {
    calls,
    release: () => release?.(),
    /** Raise a permission ask through acpx's callback, as an adapter would. */
    raisePermission: (sessionId: string) =>
      permissionRouter?.({
        sessionId,
        inferredKind: 'execute',
        raw: {
          sessionId,
          toolCall: { title: 'npm publish', kind: 'execute' },
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }]
        }
      }),
    factory: () =>
      new LocalHarnessHost({
        runtimeFactory: async (config) => {
          permissionRouter = config.onPermissionRequest as (req: unknown) => Promise<unknown> | undefined;
          return runtime;
        }
      })
  };
}

interface InvokeLog {
  channel: string;
  args: unknown[];
}

function makeHost(
  script: FakeAcpxScript = {},
  answer?: (channel: string, args: unknown[]) => unknown
): { host: DesktopHarnessHost; invoked: InvokeLog[]; acpx: ReturnType<typeof fakeAcpx> } {
  const invoked: InvokeLog[] = [];
  const acpx = fakeAcpx(script);
  const host = createDesktopHarnessHost({
    invoke: async (channel, args) => {
      invoked.push({ channel, args });
      return answer ? answer(channel, args) : { action: 'continue' };
    },
    acpxFactory: acpx.factory
  });
  return { host, invoked, acpx };
}

const RUN: DeviceHarnessRequest = {
  requestId: 'turn-1',
  op: 'run',
  agent: 'opencode',
  cwd: '/proj',
  sessionId: 'opencode-s1',
  prompt: 'go'
};

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe('consent', () => {
  it('refuses everything with the switch off, naming where it lives', async () => {
    await writeHarnessHostEnabled(false);
    const { host, invoked } = makeHost();
    host.onRequest({ requestId: 'e1', op: 'ensure', agent: 'claude', cwd: '/proj' });
    await waitFor(() => invoked.some((c) => c.channel === 'harnessHost:result'));
    const [requestId, result] = invoked.find((c) => c.channel === 'harnessHost:result')!.args as [
      string,
      { ok: boolean; error?: string }
    ];
    expect(requestId).toBe('e1');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('on this computer');
  });

  it('announces the switch state, and re-announces after a flip', async () => {
    const { host, invoked } = makeHost();
    await host.start();
    expect(invoked[0]).toMatchObject({ channel: 'harnessHost:announce' });
    expect((invoked[0].args[0] as { enabled: boolean }).enabled).toBe(true);
    await host.setEnabled(false);
    const last = invoked[invoked.length - 1];
    expect(last.channel).toBe('harnessHost:announce');
    expect((last.args[0] as { enabled: boolean }).enabled).toBe(false);
  });
});

describe('requests', () => {
  it('answers an ensure with the minted sessionId', async () => {
    const { host, invoked } = makeHost();
    host.onRequest({ requestId: 'e1', op: 'ensure', agent: 'claude', cwd: '/proj' });
    await waitFor(() => invoked.some((c) => c.channel === 'harnessHost:result'));
    const result = invoked.find((c) => c.channel === 'harnessHost:result')!.args[1] as {
      ok: boolean;
      sessionId?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.sessionId).toMatch(/^claude-/);
  });

  it('dedupes a frame delivered on two overlapping streams', async () => {
    const { host, invoked } = makeHost();
    host.onRequest({ requestId: 'e1', op: 'ensure', agent: 'claude', cwd: '/proj' });
    host.onRequest({ requestId: 'e1', op: 'ensure', agent: 'claude', cwd: '/proj' });
    await waitFor(() => invoked.some((c) => c.channel === 'harnessHost:result'));
    await new Promise((r) => setTimeout(r, 20));
    expect(invoked.filter((c) => c.channel === 'harnessHost:result')).toHaveLength(1);
  });

  it('streams events with honest sequences and settles with finalSeq', async () => {
    const { host, invoked } = makeHost({
      events: [
        { type: 'text_delta', text: 'All ' },
        { type: 'text_delta', text: 'done.' }
      ]
    });
    host.onRequest(RUN);
    await waitFor(() => invoked.some((c) => c.channel === 'harnessHost:result'));
    const batches = invoked
      .filter((c) => c.channel === 'harnessHost:event')
      .map((c) => c.args[0] as DeviceHarnessEventBatch);
    const eventsSent = batches.reduce((n, b) => n + b.events.length, 0);
    expect(eventsSent).toBe(2);
    expect(batches[0].firstSeq).toBe(1);
    const result = invoked.find((c) => c.channel === 'harnessHost:result')!.args[1] as {
      ok: boolean;
      text?: string;
      finalSeq?: number;
    };
    expect(result).toMatchObject({ ok: true, text: 'All done.', finalSeq: 2 });
  });

  it('a cancel ack on the event POST cancels the turn (server-restart fallback)', async () => {
    const { host, invoked, acpx } = makeHost(
      { hold: true, events: [{ type: 'text_delta', text: 'working' }] },
      (channel) => (channel === 'harnessHost:event' ? { action: 'cancel' } : { action: 'continue' })
    );
    host.onRequest(RUN);
    await waitFor(() => acpx.calls.cancels > 0);
    await waitFor(() => invoked.some((c) => c.channel === 'harnessHost:result'));
    const result = invoked.find((c) => c.channel === 'harnessHost:result')!.args[1] as { stopReason?: string };
    expect(result.stopReason).toBe('cancelled');
  });

  it('the cancel frame is honored even with the switch off', async () => {
    const { host, acpx } = makeHost({ hold: true });
    host.onRequest(RUN);
    await writeHarnessHostEnabled(false);
    // The turn goes live a few microtasks after the frame; keep asking.
    await waitFor(() => {
      host.onCancel({ turnId: 'turn-1' });
      return acpx.calls.cancels > 0;
    });
  });
});

describe('permissions', () => {
  it('retries the blocking RPC with the SAME permissionId after a transport drop', async () => {
    const permissionAsks: Array<{ turnId: string; permissionId: string }> = [];
    const { host, invoked, acpx } = makeHost({ hold: true }, (channel, args) => {
      if (channel === 'harnessHost:permission') {
        const ask = args[0] as { turnId: string; permissionId: string };
        permissionAsks.push(ask);
        if (permissionAsks.length === 1) throw new Error('stream dropped');
        return { optionId: 'allow' };
      }
      return { action: 'continue' };
    });
    host.onRequest(RUN);
    // The ask can only be routed once the turn is live; keep raising until it is.
    let decisionPromise: Promise<unknown> | undefined;
    await waitFor(() => {
      decisionPromise ??= acpx.raisePermission(RUN.sessionId) as Promise<unknown> | undefined;
      return decisionPromise !== undefined;
    });
    const decision = await decisionPromise;
    expect(decision).toEqual({ outcome: 'allow_once' });
    expect(permissionAsks).toHaveLength(2);
    expect(permissionAsks[1].permissionId).toBe(permissionAsks[0].permissionId);
    expect(permissionAsks[0].turnId).toBe('turn-1');
    acpx.release();
    await waitFor(() => invoked.some((c) => c.channel === 'harnessHost:result'));
  });
});
