// The server's half of the harness device wire, tested against the plan's
// failure table: device offline -> immediate honest error; client silent ->
// first-life then rolling idle timeouts, turn lost, session survives; unknown
// turn -> the event ack carries the cancel; late/duplicate results ->
// forget-first; forged results -> refused on deviceId mismatch; stale event
// batches dropped; cancel -> frame plus ack fallback plus wind-down; permission
// retries idempotent (in-flight join + decided replay).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHarnessDeviceRouter,
  memoryHarnessHostStore,
  type HarnessDeviceRouter
} from '../../src/server/harness/device-host';
import type { HarnessPermissionAsk, HarnessTurnSink } from '../../src/server/harness/host';
import { HARNESS_CANCEL_FRAME, HARNESS_REQUEST_FRAME } from '../../src/shared/types';

interface Pushed {
  deviceId: string;
  name: string;
  data: Record<string, unknown>;
}

function makeRouter(opts: { connected?: string[]; reach?: number } = {}) {
  const pushed: Pushed[] = [];
  const connected = new Set(opts.connected ?? ['mac-1']);
  const router = createHarnessDeviceRouter({
    pushTo: (deviceId, name, data) => {
      pushed.push({ deviceId, name, data: data as Record<string, unknown> });
      return opts.reach ?? (connected.has(deviceId) ? 1 : 0);
    },
    connectedDevices: () => connected,
    store: memoryHarnessHostStore()
  });
  return { router, pushed, connected };
}

const SINK: HarnessTurnSink = { onEvent: () => {}, onPermission: async () => ({ expired: true }) };

function startTurn(router: HarnessDeviceRouter, sink: HarnessTurnSink = SINK) {
  return router.runTurn(
    'mac-1',
    'Mac',
    { turnId: 'turn-1', agent: 'claude', cwd: '/proj', sessionId: 's1', prompt: 'go' },
    sink
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('announcements', () => {
  it('remembers a valid announcement and drops a malformed one', async () => {
    const { router } = makeRouter();
    await router.announce('mac-1', { enabled: true, platform: 'darwin' });
    await router.announce('mac-2', { enabled: 'yes', platform: 'darwin' });
    expect(await router.hostFor('mac-1')).toMatchObject({ enabled: true, platform: 'darwin' });
    expect(await router.hostFor('mac-2')).toBeNull();
  });
});

describe('ensure', () => {
  it('a device the push cannot reach is refused immediately, naming the machine', async () => {
    const { router } = makeRouter({ reach: 0 });
    const res = await router.ensure('mac-1', 'Mac', { agent: 'claude', cwd: '/proj' });
    expect(!res.ok && res.error).toContain('Mac');
  });

  it('round-trips a sessionId, refusing an answer from the wrong device', async () => {
    const { router, pushed } = makeRouter();
    const promise = router.ensure('mac-1', 'Mac', { agent: 'claude', cwd: '/proj', sessionId: 'old' });
    const frame = pushed[0];
    expect(frame.name).toBe(HARNESS_REQUEST_FRAME);
    expect(frame.data).toMatchObject({ op: 'ensure', agent: 'claude', sessionId: 'old' });
    const requestId = frame.data.requestId as string;
    expect(router.settle('intruder', requestId, { ok: true, sessionId: 'stolen' })).toBe(false);
    expect(router.settle('mac-1', requestId, { ok: true, sessionId: 'fresh' })).toBe(true);
    await expect(promise).resolves.toEqual({ ok: true, sessionId: 'fresh' });
    // Spent: the same id settles nothing twice.
    expect(router.settle('mac-1', requestId, { ok: true, sessionId: 'again' })).toBe(false);
  });

  it('times out after 30s of silence', async () => {
    vi.useFakeTimers();
    const { router } = makeRouter();
    const promise = router.ensure('mac-1', 'Mac', { agent: 'claude', cwd: '/proj' });
    await vi.advanceTimersByTimeAsync(30_001);
    const res = await promise;
    expect(!res.ok && res.error).toContain('did not answer');
  });
});

describe('turns', () => {
  it('fails a turn that never shows a first sign of life, promising the session survives', async () => {
    vi.useFakeTimers();
    const { router } = makeRouter();
    const handle = startTurn(router);
    await vi.advanceTimersByTimeAsync(30_001);
    const res = await handle.result;
    expect(!res.ok && res.error).toContain('session survives');
  });

  it('heartbeats keep the turn alive; 90s of silence loses it', async () => {
    vi.useFakeTimers();
    const { router } = makeRouter();
    const handle = startTurn(router);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(router.onEvent('mac-1', { turnId: 'turn-1', firstSeq: 0, events: [], state: 'running' })).toEqual({
        action: 'continue'
      });
    }
    await vi.advanceTimersByTimeAsync(90_001);
    const res = await handle.result;
    expect(res.ok).toBe(false);
  });

  it('delivers events in order, dropping stale batches and surviving gaps', async () => {
    const { router } = makeRouter();
    const seen: unknown[] = [];
    const handle = startTurn(router, { ...SINK, onEvent: (events) => seen.push(...events) });
    router.onEvent('mac-1', {
      turnId: 'turn-1',
      firstSeq: 1,
      events: [{ type: 'text_delta', text: 'a' }],
      state: 'running'
    });
    // A retried POST re-sends the same batch: dropped, not double-counted.
    router.onEvent('mac-1', {
      turnId: 'turn-1',
      firstSeq: 1,
      events: [{ type: 'text_delta', text: 'a' }],
      state: 'running'
    });
    // A gap (2 was lost): still delivered — the result is the authority.
    router.onEvent('mac-1', {
      turnId: 'turn-1',
      firstSeq: 3,
      events: [{ type: 'text_delta', text: 'c' }],
      state: 'running'
    });
    expect(seen).toHaveLength(2);
    router.settle('mac-1', 'turn-1', { ok: true, stopReason: 'end_turn', text: 'done', finalSeq: 3 });
    await expect(handle.result).resolves.toEqual({ ok: true, stopReason: 'end_turn', text: 'done' });
  });

  it('answers an unknown turn (server restarted) and a forged device with cancel', () => {
    const { router } = makeRouter();
    expect(router.onEvent('mac-1', { turnId: 'nobody', firstSeq: 0, events: [], state: 'running' })).toEqual({
      action: 'cancel'
    });
    startTurn(router);
    expect(router.onEvent('intruder', { turnId: 'turn-1', firstSeq: 0, events: [], state: 'running' })).toEqual({
      action: 'cancel'
    });
  });

  it('cancel pushes the frame, falls back to the event ack, and winds down', async () => {
    vi.useFakeTimers();
    const { router, pushed } = makeRouter();
    const handle = startTurn(router);
    handle.cancel();
    expect(pushed.some((p) => p.name === HARNESS_CANCEL_FRAME && p.data.turnId === 'turn-1')).toBe(true);
    // The lost-frame fallback: the next event POST is told to cancel.
    expect(router.onEvent('mac-1', { turnId: 'turn-1', firstSeq: 0, events: [], state: 'running' })).toEqual({
      action: 'cancel'
    });
    // A client that never confirms is settled by the wind-down clock.
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(handle.result).resolves.toEqual({ ok: true, stopReason: 'cancelled', text: '' });
  });

  it('a confirmed cancel settles with the device text, beating the wind-down', async () => {
    const { router } = makeRouter();
    const handle = startTurn(router);
    handle.cancel();
    router.settle('mac-1', 'turn-1', { ok: true, stopReason: 'cancelled', text: 'partial', finalSeq: 2 });
    await expect(handle.result).resolves.toEqual({ ok: true, stopReason: 'cancelled', text: 'partial' });
  });

  it('forgetting an unpaired device fails its in-flight turn now', async () => {
    const { router } = makeRouter();
    await router.announce('mac-1', { enabled: true, platform: 'darwin' });
    const handle = startTurn(router);
    await router.forget('mac-1');
    const res = await handle.result;
    expect(!res.ok && res.error).toContain('unpaired');
    expect(await router.hostFor('mac-1')).toBeNull();
  });
});

describe('permissions', () => {
  const ASK = {
    turnId: 'turn-1',
    permissionId: 'perm-1',
    title: 'npm publish',
    command: 'npm publish --tag beta',
    options: [{ optionId: 'allow', kind: 'allow_once' }]
  };

  it('routes to the turn sink once, joining retries to the same in-flight ask', async () => {
    const { router } = makeRouter();
    let asked = 0;
    let release: ((d: { optionId: string }) => void) | null = null;
    startTurn(router, {
      ...SINK,
      onPermission: (ask: HarnessPermissionAsk) => {
        asked += 1;
        expect(ask.permissionId).toBe('perm-1');
        // The wire's command survives ingress — the server's tiers key off it.
        expect(ask.command).toBe('npm publish --tag beta');
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    });
    const first = router.onPermission('mac-1', ASK);
    const retry = router.onPermission('mac-1', ASK);
    release!({ optionId: 'allow' });
    await expect(first).resolves.toEqual({ optionId: 'allow' });
    await expect(retry).resolves.toEqual({ optionId: 'allow' });
    expect(asked).toBe(1);
    // Decided replay: a retry after the card settled still gets the answer.
    await expect(router.onPermission('mac-1', ASK)).resolves.toEqual({ optionId: 'allow' });
  });

  it('answers expired for an unknown turn, a forged device, and a malformed ask', async () => {
    const { router } = makeRouter();
    await expect(router.onPermission('mac-1', ASK)).resolves.toEqual({ expired: true });
    startTurn(router);
    await expect(router.onPermission('intruder', ASK)).resolves.toEqual({ expired: true });
    await expect(router.onPermission('mac-1', { turnId: 'turn-1' })).resolves.toEqual({ expired: true });
  });
});
