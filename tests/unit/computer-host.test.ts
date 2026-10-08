import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createComputerHost, type ComputerHost, type HelperLike } from '../../src/desktop/computer-host';
import { writeComputerHostEnabled } from '../../src/desktop/computer-host/store';
import type { HelperEvent, HelperReply } from '../../src/desktop/computer-host/helper';
import type { DeviceComputerResult } from '../../src/shared/types';

// The client half: the Mac whose screen is driven. What must hold here is the
// consent gate (the switch on THIS disk, read fresh per request), the run
// lifecycle (helper + watch + banner from the first action, gone at the end),
// and the kill switch: the person's own input fails the in-flight action, tells
// the server, and ends the run.

const mac = process.platform === 'darwin';
const shot = { jpegBase64: 'AAAA', width: 100, height: 50, scale: 2 };

class FakeHelper implements HelperLike {
  calls: Array<{ cmd: string; fields: Record<string, unknown> }> = [];
  listeners = new Set<(e: HelperEvent) => void>();
  killed = false;
  /** Holds the next action reply until released, to test a take-over mid-action. */
  hold: ((reply: HelperReply) => void) | null = null;
  watchFails = false;

  call(cmd: string, fields: Record<string, unknown> = {}): Promise<HelperReply> {
    this.calls.push({ cmd, fields });
    if (cmd === 'watch')
      return Promise.resolve(this.watchFails ? { ok: false, error: 'no Input Monitoring' } : { ok: true });
    if (cmd === 'status')
      return Promise.resolve({
        ok: true,
        status: { screen: true, accessibility: true, inputMonitoring: true }
      });
    if (cmd === 'list-windows') return Promise.resolve({ ok: true, text: '12  Discord  "#test"' });
    if (cmd === 'select-window') {
      const target = fields.windowId === undefined ? null : { app: 'Discord', title: '#test', windowId: 12 };
      return Promise.resolve({ ok: true, screenshot: shot, target });
    }
    if (this.hold === null && cmd !== 'stop') {
      return Promise.resolve({
        ok: true,
        screenshot: shot,
        cursor: { x: 5, y: 6 }
      });
    }
    return new Promise((resolve) => {
      this.hold = resolve;
    });
  }
  onEvent(listener: (e: HelperEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  kill(): void {
    this.killed = true;
  }
  human(): void {
    for (const l of this.listeners) l({ event: 'human-input', kind: 'mouse' });
  }
}

describe.skipIf(!mac)('createComputerHost', () => {
  let dir: string;
  let calls: Array<{ channel: string; args: unknown[] }>;
  let banner: { shown: number; hidden: number; targets: Array<string | null>; stop: (() => void) | null };
  let helper: FakeHelper;
  let host: ComputerHost;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stem-computer-host-'));
    process.env.STEM_COMPUTER_HOST_FILE = join(dir, 'computer-host.json');
    calls = [];
    banner = { shown: 0, hidden: 0, targets: [], stop: null };
    helper = new FakeHelper();
    host = createComputerHost({
      invoke: (channel, args) => {
        calls.push({ channel, args });
        return Promise.resolve(undefined);
      },
      banner: {
        show: () => banner.shown++,
        hide: () => banner.hidden++,
        setTarget: (app) => banner.targets.push(app),
        onStop: (handler) => {
          banner.stop = handler;
        }
      },
      helpers: {
        spawn: () => Promise.resolve(helper),
        oneShot: (cmd) => helper.call(cmd)
      }
    });
  });

  afterEach(() => {
    host.close();
    delete process.env.STEM_COMPUTER_HOST_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  async function results(): Promise<Array<{ id: string; result: DeviceComputerResult }>> {
    for (let i = 0; i < 400; i++) {
      const found = calls.filter((c) => c.channel === 'computerHost:result');
      if (found.length)
        return found.map((c) => ({
          id: c.args[0] as string,
          result: c.args[1] as DeviceComputerResult
        }));
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('no computerHost:result was delivered');
  }

  it('starts switched off and refuses a request without starting a run', async () => {
    expect((await host.localState()).enabled).toBe(false);
    host.onRequest({
      requestId: 'r1',
      threadId: 't1',
      action: { kind: 'screenshot' }
    });
    const [first] = await results();
    expect(first!.id).toBe('r1');
    expect(first!.result.ok).toBe(false);
    if (!first!.result.ok) expect(first!.result.error).toContain('does not let Stem control');
    expect(banner.shown).toBe(0);
    // localState asked the helper's status; no run-time command was sent.
    expect(helper.calls.filter((c) => c.cmd !== 'status')).toHaveLength(0);
  });

  it('announces on start and on toggle, with the grants once enabled', async () => {
    await host.start();
    expect(calls.find((c) => c.channel === 'computerHost:announce')!.args[0]).toMatchObject({
      enabled: false,
      platform: 'darwin'
    });
    await host.setEnabled(true);
    const last = calls.filter((c) => c.channel === 'computerHost:announce').at(-1)!.args[0];
    expect(last).toMatchObject({
      enabled: true,
      access: { screen: true, accessibility: true, inputMonitoring: true }
    });
  });

  it('the first action begins a run (watch on, banner up), answers with the screenshot, and the end frame ends it', async () => {
    await writeComputerHostEnabled(true);
    host.onRequest({
      requestId: 'r1',
      threadId: 't1',
      action: { kind: 'click', x: 1, y: 2, button: 'left', count: 2 }
    });
    const [first] = await results();
    expect(first!.result).toEqual({
      ok: true,
      screenshot: shot,
      cursor: { x: 5, y: 6 }
    });
    expect(helper.calls[0]).toEqual({ cmd: 'watch', fields: { on: true } });
    expect(helper.calls[1]).toEqual({
      cmd: 'click',
      fields: { x: 1, y: 2, button: 'left', count: 2 }
    });
    expect(banner.shown).toBe(1);
    // Another thread cannot share the cursor.
    calls.length = 0;
    host.onRequest({
      requestId: 'r2',
      threadId: 'other',
      action: { kind: 'screenshot' }
    });
    const [other] = await results();
    expect(other!.result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Another conversation')
    });
    host.onEnd({ threadId: 't1' });
    expect(banner.hidden).toBe(1);
    expect(helper.killed).toBe(true);
  });

  it('refuses to start a run whose kill switch cannot be armed', async () => {
    await writeComputerHostEnabled(true);
    helper.watchFails = true;
    host.onRequest({
      requestId: 'r1',
      threadId: 't1',
      action: { kind: 'screenshot' }
    });
    const [first] = await results();
    expect(first!.result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Input Monitoring')
    });
    expect(banner.shown).toBe(0);
    expect(helper.killed).toBe(true);
  });

  it('the person’s input fails the in-flight action as aborted, reports it, and ends the run', async () => {
    await writeComputerHostEnabled(true);
    helper.hold = () => undefined; // hold the next action
    host.onRequest({
      requestId: 'r1',
      threadId: 't1',
      action: { kind: 'type', text: 'hello' }
    });
    // Wait for the run to start (watch answered, type held).
    for (let i = 0; i < 100 && helper.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(banner.shown).toBe(1);
    helper.human();
    const [first] = await results();
    expect(first!.result).toEqual({
      ok: false,
      error: 'The user took over the computer.',
      aborted: true
    });
    expect(calls.find((c) => c.channel === 'computerHost:event')!.args[0]).toEqual({
      threadId: 't1',
      kind: 'human-input'
    });
    expect(banner.hidden).toBe(1);
    expect(helper.killed).toBe(true);
  });

  it('a windows list answers with text alone, selecting a window relabels the banner, clearing it restores it', async () => {
    await writeComputerHostEnabled(true);
    host.onRequest({ requestId: 'r1', threadId: 't1', action: { kind: 'list_windows' } });
    const [list] = await results();
    expect(list!.result).toEqual({ ok: true, text: '12  Discord  "#test"' });
    expect(banner.targets).toEqual([null]); // the run began on the whole screen
    calls.length = 0;
    host.onRequest({ requestId: 'r2', threadId: 't1', action: { kind: 'select_window', windowId: 12 } });
    const [selected] = await results();
    expect(selected!.result).toMatchObject({ ok: true, target: { app: 'Discord', windowId: 12 } });
    expect(banner.targets.at(-1)).toBe('Discord');
    expect(helper.calls.at(-1)).toEqual({ cmd: 'select-window', fields: { windowId: 12 } });
    calls.length = 0;
    host.onRequest({ requestId: 'r3', threadId: 't1', action: { kind: 'set_value', id: 4, text: 'hi' } });
    const [set] = await results();
    expect(set!.result.ok).toBe(true);
    expect(helper.calls.at(-1)).toEqual({ cmd: 'set-value', fields: { element: 4, text: 'hi' } });
    calls.length = 0;
    host.onRequest({ requestId: 'r4', threadId: 't1', action: { kind: 'select_window' } });
    const [cleared] = await results();
    expect(cleared!.result).toMatchObject({ ok: true, target: null });
    expect(banner.targets.at(-1)).toBeNull();
  });

  it('passes shot: false to the helper for a step in the middle of a batch, and accepts its text answer', async () => {
    await writeComputerHostEnabled(true);
    helper.call = function (this: FakeHelper, cmd: string, fields: Record<string, unknown> = {}) {
      this.calls.push({ cmd, fields });
      if (cmd === 'watch') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true, text: 'Done.', target: null });
    };
    host.onRequest({ requestId: 'r1', threadId: 't1', action: { kind: 'key', combo: 'Home' }, shot: false });
    const [step] = await results();
    expect(step!.result).toEqual({ ok: true, text: 'Done.', target: null });
    expect(helper.calls.at(-1)).toEqual({ cmd: 'key', fields: { combo: 'Home', shot: false } });
  });

  it('Stop on the banner fails the in-flight action as aborted, reports it, and ends the run', async () => {
    await writeComputerHostEnabled(true);
    helper.hold = () => undefined;
    host.onRequest({ requestId: 'r1', threadId: 't1', action: { kind: 'press', id: 1 } });
    for (let i = 0; i < 100 && helper.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(banner.stop).toBeTruthy();
    banner.stop!();
    const [first] = await results();
    expect(first!.result).toEqual({ ok: false, error: 'The user pressed Stop.', aborted: true });
    expect(calls.find((c) => c.channel === 'computerHost:event')!.args[0]).toEqual({
      threadId: 't1',
      kind: 'human-input'
    });
    expect(banner.hidden).toBe(1);
    expect(helper.killed).toBe(true);
  });
});
