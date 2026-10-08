import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createComputerDeviceRouter,
  HUMAN_TOOK_OVER,
  memoryComputerHostStore,
  type ComputerDeviceRouter
} from '../../src/server/computer-device/router';
import {
  COMPUTER_END_FRAME,
  COMPUTER_REQUEST_FRAME,
  type DeviceComputerRequest
} from '../../src/shared/types';

// The server half of the `computer` tool: the addressed frame out, the RPC
// answer back, and the two things that make a run end — the person at the Mac
// taking over, and the turn being over.

interface Sent {
  deviceId: string;
  name: string;
  data: unknown;
}

const shot = { jpegBase64: 'AAAA', width: 100, height: 50, scale: 2 };

describe('createComputerDeviceRouter', () => {
  let sent: Sent[];
  let connected: Set<string>;
  let router: ComputerDeviceRouter;

  beforeEach(() => {
    sent = [];
    connected = new Set(['mac-1']);
    router = createComputerDeviceRouter({
      pushTo: (deviceId, name, data) => {
        if (!connected.has(deviceId)) return 0;
        sent.push({ deviceId, name, data });
        return 1;
      },
      connectedDevices: () => connected,
      store: memoryComputerHostStore()
    });
  });

  afterEach(() => router.close());

  it('remembers a valid announcement (with access) and ignores a malformed one', async () => {
    await router.announce('mac-1', {
      enabled: true,
      platform: 'darwin',
      access: { screen: true, accessibility: false, inputMonitoring: 'yes' }
    });
    await router.announce('mac-1', { enabled: true, platform: 'linux' }); // ignored: mac only
    const host = await router.hostFor('mac-1');
    expect(host).toMatchObject({
      enabled: true,
      platform: 'darwin',
      access: { screen: true, accessibility: false, inputMonitoring: false }
    });
  });

  it('round-trips one action: frame out, screenshot back, single-use id', async () => {
    const promise = router.send('t1', 'mac-1', {
      kind: 'click',
      x: 10,
      y: 20,
      button: 'left',
      count: 1
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe(COMPUTER_REQUEST_FRAME);
    const frame = sent[0]!.data as DeviceComputerRequest;
    expect(frame.threadId).toBe('t1');
    expect(frame.action).toEqual({
      kind: 'click',
      x: 10,
      y: 20,
      button: 'left',
      count: 1
    });
    expect(frame.requestId).toMatch(/^[0-9a-f]{32}$/);
    // The wrong device cannot answer for it.
    expect(
      router.settle('mac-2', frame.requestId, {
        ok: true,
        screenshot: shot,
        cursor: { x: 1, y: 1 }
      })
    ).toBe(false);
    expect(
      router.settle('mac-1', frame.requestId, {
        ok: true,
        screenshot: shot,
        cursor: { x: 1, y: 1 }
      })
    ).toBe(true);
    expect(await promise).toEqual({
      ok: true,
      screenshot: shot,
      cursor: { x: 1, y: 1 }
    });
    expect(router.settle('mac-1', frame.requestId, { ok: true, screenshot: shot })).toBe(false);
  });

  it('answers a disconnected Mac at once, and reshapes an answer without a screenshot as a failure', async () => {
    connected.clear();
    const gone = await router.send('t1', 'mac-1', { kind: 'screenshot' });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error).toContain('not connected');
    connected.add('mac-1');
    const promise = router.send('t1', 'mac-1', { kind: 'screenshot' });
    const frame = sent.at(-1)!.data as DeviceComputerRequest;
    router.settle('mac-1', frame.requestId, { ok: true });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('without a screenshot');
  });

  it('accepts a text-only answer (the windows list) and carries the target through', async () => {
    const listing = router.send('t1', 'mac-1', { kind: 'list_windows' });
    let frame = sent.at(-1)!.data as DeviceComputerRequest;
    router.settle('mac-1', frame.requestId, { ok: true, text: '12  Discord  "#test"' });
    expect(await listing).toEqual({ ok: true, text: '12  Discord  "#test"' });
    const selected = router.send('t1', 'mac-1', { kind: 'select_window', windowId: 12 });
    frame = sent.at(-1)!.data as DeviceComputerRequest;
    router.settle('mac-1', frame.requestId, {
      ok: true,
      screenshot: shot,
      target: { app: 'Discord', title: '#test', windowId: 12, extra: 'dropped' }
    });
    expect(await selected).toEqual({
      ok: true,
      screenshot: shot,
      cursor: { x: 0, y: 0 },
      target: { app: 'Discord', title: '#test', windowId: 12 }
    });
    const cleared = router.send('t1', 'mac-1', { kind: 'select_window' });
    frame = sent.at(-1)!.data as DeviceComputerRequest;
    router.settle('mac-1', frame.requestId, { ok: true, screenshot: shot, cursor: { x: 1, y: 1 }, target: null });
    expect(await cleared).toMatchObject({ ok: true, target: null });
    // Blank text is not an answer either.
    const blank = router.send('t1', 'mac-1', { kind: 'snapshot' });
    frame = sent.at(-1)!.data as DeviceComputerRequest;
    router.settle('mac-1', frame.requestId, { ok: true, text: '   ' });
    expect((await blank).ok).toBe(false);
  });

  it('carries shot: false on the frame only when asked, and accepts the text-only answer', async () => {
    const step = router.send('t1', 'mac-1', { kind: 'key', combo: 'Home' }, { shot: false });
    let frame = sent.at(-1)!.data as DeviceComputerRequest;
    expect(frame.shot).toBe(false);
    router.settle('mac-1', frame.requestId, { ok: true, text: 'Done.', target: null });
    expect(await step).toEqual({ ok: true, text: 'Done.', target: null });
    const plain = router.send('t1', 'mac-1', { kind: 'key', combo: 'F9' });
    frame = sent.at(-1)!.data as DeviceComputerRequest;
    expect('shot' in frame).toBe(false);
    router.settle('mac-1', frame.requestId, { ok: true, screenshot: shot });
    expect((await plain).ok).toBe(true);
  });

  it('the person taking over fails the in-flight action, refuses the rest of the turn, and endThread clears it', async () => {
    const promise = router.send('t1', 'mac-1', { kind: 'type', text: 'hi' });
    // Another Mac cannot end a run it never had.
    expect(router.humanInput('mac-2', 't1')).toBe(false);
    expect(router.isAborted('t1')).toBe(false);
    expect(router.humanInput('mac-1', 't1')).toBe(true);
    expect(await promise).toEqual({
      ok: false,
      error: HUMAN_TOOK_OVER,
      aborted: true
    });
    expect(router.isAborted('t1')).toBe(true);
    // No round-trip for the next action this turn.
    const before = sent.length;
    const refused = await router.send('t1', 'mac-1', { kind: 'screenshot' });
    expect(refused).toMatchObject({ ok: false, aborted: true });
    expect(sent).toHaveLength(before);
    // The turn ends: the device is told, and the next turn starts clean.
    router.endThread('t1');
    expect(sent.at(-1)).toMatchObject({
      deviceId: 'mac-1',
      name: COMPUTER_END_FRAME,
      data: { threadId: 't1' }
    });
    expect(router.isAborted('t1')).toBe(false);
  });

  it('endThread fails what is in flight with the reason and pushes the end frame to the running Mac', async () => {
    const promise = router.send('t2', 'mac-1', { kind: 'wait', ms: 1000 });
    router.endThread('t2', 'The turn was stopped.');
    expect(await promise).toEqual({
      ok: false,
      error: 'The turn was stopped.'
    });
    expect(sent.at(-1)).toMatchObject({
      name: COMPUTER_END_FRAME,
      data: { threadId: 't2' }
    });
    // A thread that never ran sends nothing.
    const n = sent.length;
    router.endThread('never');
    expect(sent).toHaveLength(n);
  });

  it('forget drops the announcement and fails that device’s in-flight action', async () => {
    await router.announce('mac-1', { enabled: true, platform: 'darwin' });
    const promise = router.send('t3', 'mac-1', { kind: 'screenshot' });
    await router.forget('mac-1');
    expect(await promise).toMatchObject({
      ok: false,
      error: expect.stringContaining('unpaired')
    });
    expect(await router.hostFor('mac-1')).toBeNull();
  });
});
