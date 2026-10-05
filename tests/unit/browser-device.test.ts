import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserDeviceRouter,
  memoryBrowserHostStore,
  USER_STOPPED_BROWSER,
  type BrowserDeviceRouter
} from '../../src/server/browser-device/router';
import { BROWSER_END_FRAME, BROWSER_REQUEST_FRAME, type DeviceBrowserRequest } from '../../src/shared/types';

// The server half of the `browser` tool: the addressed frame out, the RPC
// answer back, Stop, and the end frame reaching every Mac a thread used.

interface Sent {
  deviceId: string;
  name: string;
  data: unknown;
}

describe('createBrowserDeviceRouter', () => {
  let sent: Sent[];
  let connected: Set<string>;
  let router: BrowserDeviceRouter;

  beforeEach(() => {
    sent = [];
    connected = new Set(['mac-1', 'mac-2']);
    router = createBrowserDeviceRouter({
      pushTo: (deviceId, name, data) => {
        if (!connected.has(deviceId)) return 0;
        sent.push({ deviceId, name, data });
        return 1;
      },
      connectedDevices: () => connected,
      store: memoryBrowserHostStore()
    });
  });

  afterEach(() => {
    router.close();
    vi.useRealTimers();
  });

  const requestOf = (i: number): DeviceBrowserRequest => sent[i]!.data as DeviceBrowserRequest;

  it('remembers a valid announcement with its browsers and ignores a malformed one', async () => {
    await router.announce('mac-1', {
      enabled: true,
      platform: 'darwin',
      browsers: [
        { id: '/Applications/Arc.app', name: 'Arc', connected: true, version: '0.6.0' },
        { id: '', name: 'nameless' },
        'junk'
      ],
      chosen: '/Applications/Arc.app'
    });
    await router.announce('mac-1', { enabled: true, platform: 'linux', browsers: [] }); // ignored: mac only
    expect(await router.hostFor('mac-1')).toMatchObject({
      enabled: true,
      platform: 'darwin',
      browsers: [{ id: '/Applications/Arc.app', name: 'Arc', connected: true, version: '0.6.0' }],
      chosen: '/Applications/Arc.app'
    });
  });

  it('round-trips one action and answers each id once, only from its device', async () => {
    const promise = router.send('t1', 'mac-1', { kind: 'open', url: 'https://example.com' });
    expect(sent[0]!.name).toBe(BROWSER_REQUEST_FRAME);
    const { requestId, threadId, action } = requestOf(0);
    expect(threadId).toBe('t1');
    expect(action).toEqual({ kind: 'open', url: 'https://example.com' });
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);

    expect(router.settle('mac-2', requestId, { ok: true, text: 'forged' })).toBe(false);
    expect(router.settle('mac-1', requestId, { ok: true, text: 'Opened tab 7', tab: 7 })).toBe(true);
    expect(router.settle('mac-1', requestId, { ok: true, text: 'again' })).toBe(false);
    expect(await promise).toEqual({ ok: true, text: 'Opened tab 7', tab: 7 });
  });

  it('keeps only staging handles among downloads, and a screenshot only when well-formed', async () => {
    const promise = router.send('t1', 'mac-1', { kind: 'downloads', wait: true });
    router.settle('mac-1', requestOf(0).requestId, {
      ok: true,
      downloads: [
        { handle: 'stem-upload:abc', name: 'report.pdf', size: 12 },
        { handle: '/etc/passwd', name: 'passwd', size: 1 }
      ],
      screenshot: { jpegBase64: 'AAAA', width: 'wide' }
    });
    const res = await promise;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.downloads?.map((d) => d.name)).toEqual(['report.pdf']);
      expect(res.screenshot).toBeUndefined();
    }
  });

  it('fails at once when the Mac is not connected', async () => {
    connected.delete('mac-1');
    const res = await router.send('t1', 'mac-1', { kind: 'tabs' });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain('not connected');
    expect(sent).toHaveLength(0);
  });

  it('Stop fails what is in flight and refuses the rest of the turn without a round-trip', async () => {
    const inflight = router.send('t1', 'mac-1', { kind: 'snapshot' });
    router.stopped('mac-2', 't1'); // not a device this thread uses: ignored
    expect(router.isStopped('t1')).toBe(false);
    router.stopped('mac-1', 't1');
    expect(await inflight).toEqual({ ok: false, error: USER_STOPPED_BROWSER, stopped: true });
    const later = await router.send('t1', 'mac-1', { kind: 'tabs' });
    expect(later).toEqual({ ok: false, error: USER_STOPPED_BROWSER, stopped: true });
    expect(sent).toHaveLength(1);
    // Another thread is unaffected.
    void router.send('t2', 'mac-1', { kind: 'tabs' });
    expect(sent).toHaveLength(2);
  });

  it('endThread fails in-flight actions and tells every Mac the thread used', async () => {
    const a = router.send('t1', 'mac-1', { kind: 'tabs' });
    const b = router.send('t1', 'mac-2', { kind: 'tabs' });
    router.stopped('mac-1', 't1');
    router.endThread('t1', 'The turn was stopped.');
    expect((await a).ok).toBe(false);
    expect((await b).ok).toBe(false);
    const ends = sent.filter((s) => s.name === BROWSER_END_FRAME);
    expect(ends.map((s) => s.deviceId).sort()).toEqual(['mac-1', 'mac-2']);
    expect(ends[0]!.data).toEqual({ threadId: 't1' });
    // The stop is per turn: the next turn starts clean.
    expect(router.isStopped('t1')).toBe(false);
  });

  it('times out a vanished device with an "unknown outcome" warning', async () => {
    vi.useFakeTimers();
    const promise = router.send('t1', 'mac-1', { kind: 'click', ref: 'e3' });
    vi.advanceTimersByTime(120_001);
    const res = await promise;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('may or may not have happened');
  });

  it('forget drops the announcement and fails that device’s actions', async () => {
    await router.announce('mac-1', { enabled: true, platform: 'darwin', browsers: [] });
    const promise = router.send('t1', 'mac-1', { kind: 'tabs' });
    await router.forget('mac-1');
    expect((await promise).ok).toBe(false);
    expect(await router.hostFor('mac-1')).toBeNull();
  });
});
