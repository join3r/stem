// The Mac half of the skill recorder: Record starts the helper in record mode
// and shows the pill, steps flow into the pill, Stop turns the recording into
// one example for skills:record (links traced, raw window text kept here),
// and the raw folder is gone once the author has had it.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecorder, type RecorderHelper } from '../../src/desktop/recorder';
import { describeStep, tidy } from '../../src/desktop/recorder/bundle';
import type { HelperEvent, HelperReply } from '../../src/desktop/computer-host/helper';
import type { RecordedStep, RecorderState, RecordingExample } from '../../src/shared/types';
import type { PillView } from '../../src/desktop/recorder/pill';

const mac = process.platform === 'darwin';

class FakeHelper implements RecorderHelper {
  calls: string[] = [];
  listeners = new Set<(e: HelperEvent) => void>();
  killed = false;
  startFails = false;
  call(cmd: string): Promise<HelperReply> {
    this.calls.push(cmd);
    if (cmd === 'record-start' && this.startFails) return Promise.resolve({ ok: false, error: 'Input Monitoring is off' });
    return Promise.resolve({ ok: true });
  }
  onEvent(l: (e: HelperEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  kill(): void {
    this.killed = true;
  }
  fire(e: HelperEvent): void {
    for (const l of this.listeners) l(e);
  }
}

const mailStep = (t: number): RecordedStep => ({ kind: 'switch', t, app: 'Mail', window: 'PO-4411' });

describe.runIf(mac)('recorder', () => {
  let root: string;
  let helper: FakeHelper;
  let states: RecorderState[];
  let views: PillView[];
  let invoked: { channel: string; args: unknown[] }[];
  let shown: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stem-rec-test-'));
    helper = new FakeHelper();
    states = [];
    views = [];
    invoked = [];
    shown = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function make() {
    return createRecorder({
      invoke: async (channel, args) => {
        invoked.push({ channel, args });
        return {};
      },
      send: (s) => states.push(s),
      openSheet: () => undefined,
      hideMain: () => undefined,
      revealMain: () => undefined,
      helpers: { spawn: async () => helper, oneShot: async () => ({ ok: true }) },
      pill: () => ({ show: () => void shown++, hide: () => undefined, render: (v) => void views.push(v), destroy: () => undefined }),
      recordingsRoot: () => root
    });
  }

  it('records, shows the traced value in the pill, and sends one example on Stop', async () => {
    const rec = make();
    await rec.start('thread-1', null);
    expect(helper.calls).toContain('record-start');
    expect(shown).toBe(1);
    expect(rec.state().phase).toBe('recording');
    helper.fire({ event: 'rec-step', step: mailStep(10) });
    helper.fire({ event: 'rec-seen', seen: { t: 20, app: 'Mail', window: 'PO-4411', text: 'Delivery on October 14, 2026.' } });
    helper.fire({ event: 'rec-step', step: { kind: 'type', t: 900, app: 'Arc', window: 'agrisys', field: 'Delivery date', value: '14.10.2026' } });
    expect(views.at(-1)?.tag).toBe('← Mail');
    expect(views.at(-1)?.text).toContain('Delivery date');
    await rec.stop();
    expect(helper.calls).toContain('record-stop');
    expect(helper.killed).toBe(true);
    const call = invoked.find((c) => c.channel === 'skills:record');
    expect(call?.args[0]).toBe('thread-1');
    const example = call?.args[1] as RecordingExample;
    expect(example.links).toHaveLength(1);
    expect(JSON.stringify(example)).not.toContain('"text":"Delivery on October 14, 2026."');
    expect(rec.state().phase).toBe('idle');
    expect(readdirSync(root)).toEqual([]);
  });

  it('pauses and resumes through the helper', async () => {
    const rec = make();
    await rec.start('t', null);
    expect((await rec.togglePause()).phase).toBe('paused');
    expect(views.at(-1)?.paused).toBe(true);
    expect((await rec.togglePause()).phase).toBe('recording');
    expect(helper.calls.filter((c) => c === 'record-pause')).toHaveLength(2);
    await rec.cancel();
  });

  it('says so and sends nothing when nothing was done', async () => {
    const rec = make();
    await rec.start('t', null);
    helper.fire({ event: 'rec-step', step: mailStep(10) });
    const end = await rec.stop();
    expect(end.error).toMatch(/Nothing was recorded/);
    expect(invoked).toEqual([]);
  });

  it('does not start without the grants, and leaves no folder', async () => {
    helper.startFails = true;
    const rec = make();
    await expect(rec.start('t', null)).rejects.toThrow(/Input Monitoring/);
    expect(rec.state().phase).toBe('idle');
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });
});

describe('bundle', () => {
  it('drops window flicking', () => {
    const steps: RecordedStep[] = [mailStep(1), { ...mailStep(2), app: 'Finder', window: 'Downloads' }, { ...mailStep(3), app: 'Arc', window: 'agrisys' }];
    expect(tidy(steps).map((s) => s.app)).toEqual(['Arc']);
  });

  it('never shows a password', () => {
    expect(describeStep({ kind: 'type', t: 1, app: 'Arc', window: 'w', field: 'Password', value: '[password]', secure: true })).toBe('Typed a password · not saved');
  });
});
