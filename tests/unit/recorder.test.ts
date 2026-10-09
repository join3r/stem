// The Mac half of the skill recorder: Record starts the helper in record mode
// and shows the pill, steps flow into the pill, Stop turns the recording into
// one example for skills:record (links traced, raw window text kept here),
// and the raw folder is gone once the author has had it.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecorder, type RecorderHelper } from '../../src/desktop/recorder';
import { MAX_STEPS, buildExample, describeStep, tidy } from '../../src/desktop/recorder/bundle';
import { redactSecrets } from '../../src/desktop/recorder/secrets';
import { cleanExample, renderExample } from '../../src/server/skills/record';
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
  let presses: [number, number][];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stem-rec-test-'));
    helper = new FakeHelper();
    states = [];
    views = [];
    invoked = [];
    shown = 0;
    presses = [];
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
      pill: () => ({ show: () => void shown++, hide: () => undefined, render: (v) => void views.push(v), pressAt: (x, y) => void presses.push([x, y]), destroy: () => undefined }),
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

  it('hands the helper\'s presses to the pill, paused or not', async () => {
    const rec = make();
    await rec.start('t', null);
    helper.fire({ event: 'rec-press', x: 700, y: 30 });
    await rec.togglePause();
    helper.fire({ event: 'rec-press', x: 650, y: 30 });
    expect(presses).toEqual([[700, 30], [650, 30]]);
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

  it('keeps a recording Stem quit during, and writes it up on the next connect', async () => {
    const first = make();
    await first.start('thread-q', 'draft-q');
    helper.fire({ event: 'rec-step', step: mailStep(10) });
    helper.fire({ event: 'rec-seen', seen: { t: 20, app: 'Mail', window: 'PO-4411', text: 'Delivery on October 14, 2026.' } });
    helper.fire({ event: 'rec-step', step: { kind: 'type', t: 900, app: 'Arc', window: 'agrisys', field: 'Delivery date', value: '14.10.2026' } });
    first.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(root)).toHaveLength(1);
    expect(invoked).toEqual([]);

    const next = make();
    await next.recover();
    const call = invoked.find((c) => c.channel === 'skills:record');
    expect(call?.args[0]).toBe('thread-q');
    expect(call?.args[2]).toBe('draft-q');
    const example = call?.args[1] as RecordingExample;
    expect(example.steps.map((s) => s.kind)).toEqual(['switch', 'type']);
    expect(example.links).toHaveLength(1);
    expect(example.notes?.join(' ')).toMatch(/quit/);
    expect(readdirSync(root)).toEqual([]);
  });

  it('keeps a left-behind recording when the server cannot take it yet', async () => {
    const first = make();
    await first.start('t', null);
    helper.fire({ event: 'rec-step', step: { kind: 'click', t: 5, app: 'Arc', window: 'w', role: 'button', label: 'Save' } });
    first.close();
    await new Promise((r) => setTimeout(r, 50));
    const next = createRecorder({
      invoke: async () => {
        throw new Error('offline');
      },
      send: () => undefined,
      openSheet: () => undefined,
      hideMain: () => undefined,
      revealMain: () => undefined,
      helpers: { spawn: async () => helper, oneShot: async () => ({ ok: true }) },
      pill: () => ({ show: () => undefined, hide: () => undefined, render: () => undefined, pressAt: () => undefined, destroy: () => undefined }),
      recordingsRoot: () => root
    });
    await next.recover();
    expect(readdirSync(root)).toHaveLength(1);
  });

  it('never writes up the recording still being made', async () => {
    const rec = make();
    await rec.start('t', null);
    helper.fire({ event: 'rec-step', step: { kind: 'click', t: 5, app: 'Arc', window: 'w', role: 'button', label: 'Save' } });
    await rec.recover();
    expect(invoked).toEqual([]);
    expect(readdirSync(root)).toHaveLength(1);
    await rec.cancel();
  });

  it('warns on the pill and tells the author when pictures are off', async () => {
    const rec = make();
    await rec.start('t', null);
    helper.fire({ event: 'rec-note', note: 'Screen Recording is off', code: 'no-shots' });
    expect(views.at(-1)?.warning).toBe('No pictures');
    helper.fire({ event: 'rec-step', step: { kind: 'click', t: 5, app: 'Arc', window: 'w', role: 'button', label: 'Save' } });
    await rec.stop();
    const example = invoked.find((c) => c.channel === 'skills:record')?.args[1] as RecordingExample;
    expect(example.notes?.[0]).toMatch(/Screen Recording was off/);
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

  it('drops the stop shortcut and the click that only focused a field', () => {
    const steps: RecordedStep[] = [
      { kind: 'click', t: 1, app: 'Arc', window: 'w', role: 'textfield', label: 'Delivery date' },
      { kind: 'type', t: 2, app: 'Arc', window: 'w', field: 'Delivery date', value: '14.10.2026' },
      { kind: 'click', t: 3, app: 'Arc', window: 'w', role: 'button', label: 'Save' },
      { kind: 'key', t: 4, app: 'Arc', window: 'w', combo: 'ctrl+alt+r' }
    ];
    expect(tidy(steps).map((s) => s.kind)).toEqual(['type', 'click']);
  });

  it('keeps the end of a long recording, where the save is, and says what was cut', () => {
    const steps: RecordedStep[] = Array.from({ length: MAX_STEPS + 50 }, (_, i) => ({ kind: 'click', t: i, app: 'Arc', window: 'w', role: 'button', label: `b${i}` }));
    const ex = buildExample({ steps, seen: [], shots: [], startedAt: new Date(), durationMs: 1 });
    expect(ex.steps).toHaveLength(MAX_STEPS);
    expect(ex.steps.at(-1)?.label).toBe(`b${MAX_STEPS + 49}`);
    expect(ex.cut).toEqual({ at: 100, steps: 50 });
    expect(ex.notes?.[0]).toMatch(/50 steps/);
    const text = renderExample(ex);
    expect(text).toMatch(/50 steps of the middle were left out/);
    expect(text.split('\n')[100]).toMatch(/left out/);
    const kept = cleanExample(JSON.parse(JSON.stringify(ex)));
    expect(kept?.cut).toEqual(ex.cut);
    expect(kept?.notes).toEqual(ex.notes);
  });

  it('redacts keys and tokens by their shape, not links or ordinary values', () => {
    expect(redactSecrets('key sk-proj-abcdefghijklmnopqrstuvwx1234 here')).toBe('key [secret] here');
    expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('[secret]');
    expect(redactSecrets('Authorization: Bearer abc.def-ghi_jkl123456789xyz')).toBe('Authorization: [secret]');
    expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('[secret]');
    expect(redactSecrets('token Xk9pQ2mZ7vL4nR8tY1wB6cH3jF5gD0sA here')).toBe('token [secret] here');
    const doc = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit';
    expect(redactSecrets(doc)).toBe(doc);
    expect(redactSecrets('https://app.example.com/reset?token=Xk9pQ2mZ7vL4nR8tY1wB6cH3jF5gD0sA&u=1')).toBe('https://app.example.com/reset?token=[secret]&u=1');
    expect(redactSecrets('https://app.example.com/cb#access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop')).toBe('https://app.example.com/cb#access_token=[secret]');
    expect(redactSecrets('PO-4411 · 14.10.2026 · 0123456789abcdef0123456789abcdef01234567')).toBe('PO-4411 · 14.10.2026 · 0123456789abcdef0123456789abcdef01234567');
    const ex = buildExample({ steps: [{ kind: 'paste', t: 1, app: 'Arc', window: 'w', field: 'API key', text: 'sk-ant-abcdefghijklmnopqrstuvwxyz12' }], seen: [], shots: [], startedAt: new Date(), durationMs: 1 });
    expect(ex.steps[0].text).toBe('[secret]');
  });

  it('never shows a password', () => {
    expect(describeStep({ kind: 'type', t: 1, app: 'Arc', window: 'w', field: 'Password', value: '[password]', secure: true })).toBe('Typed a password · not saved');
  });
});
