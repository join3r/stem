// Run bookkeeping in the extension (src/browser-extension/runs.js): current
// tab, who opened and who touched which tab, the shared-tab warning window,
// and downloads pinned on the run working in their tab, reported exactly once.
import { describe, expect, it } from 'vitest';
import { Runs, SHARED_TAB_WINDOW_MS } from '../../src/browser-extension/runs.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('Runs', () => {
  it('keeps a current tab per run and remembers what each run opened', () => {
    const c = clock();
    const runs = new Runs(c.now);
    runs.opened('a', 10);
    runs.touch('a', 10);
    runs.touch('b', 20);
    expect(runs.get('a')!.current).toBe(10);
    expect(runs.get('b')!.current).toBe(20);
    expect(runs.get('a')!.opened.has(10)).toBe(true);
    expect(runs.get('b')!.opened.has(20)).toBe(false);
  });

  it('flags another run in the same tab only within the window', () => {
    const c = clock();
    const runs = new Runs(c.now);
    runs.touch('a', 10);
    c.advance(1_000);
    expect(runs.othersRecentlyIn(10, 'b')).toEqual(['a']);
    expect(runs.othersRecentlyIn(10, 'a')).toEqual([]);
    c.advance(SHARED_TAB_WINDOW_MS);
    expect(runs.othersRecentlyIn(10, 'b')).toEqual([]);
    // Still "using" it for Stop purposes until the run ends.
    expect(runs.usingTab(10)).toEqual(['a']);
    runs.get('a')!.stopped = true;
    runs.touch('a', 10);
    expect(runs.othersRecentlyIn(10, 'b')).toEqual([]);
  });

  it('knows when a tab is still held by another live run', () => {
    const runs = new Runs();
    runs.touch('a', 10);
    runs.touch('b', 10);
    expect(runs.tabHeldByOthers(10, 'a')).toBe(true);
    runs.end('b');
    expect(runs.tabHeldByOthers(10, 'a')).toBe(false);
    expect(runs.end('nobody')).toBeUndefined();
  });

  it('forgets a closed tab everywhere and follows a replaced one', () => {
    const runs = new Runs();
    runs.opened('a', 10);
    runs.touch('a', 10);
    runs.touch('b', 11);
    runs.forgetTab(10);
    expect(runs.get('a')!.current).toBeNull();
    expect(runs.get('a')!.opened.size).toBe(0);
    expect(runs.usingTab(10)).toEqual([]);
    runs.opened('b', 11);
    runs.replaceTab(11, 12);
    expect(runs.get('b')!.current).toBe(12);
    expect(runs.get('b')!.opened.has(12)).toBe(true);
    expect(runs.usingTab(12)).toEqual(['b']);
  });

  it('gives a tab’s download to the run that acted there last, never to a run elsewhere', () => {
    const c = clock();
    const runs = new Runs(c.now);
    runs.touch('a', 10);
    c.advance(1_000);
    runs.touch('b', 20);
    c.advance(1_000);
    runs.touch('b', 10);
    expect(runs.ownerOfTab(10)).toBe('b');
    expect(runs.ownerOfTab(20)).toBe('b');
    // The user's own tab: no run worked there, so a download in it is nobody's.
    expect(runs.ownerOfTab(30)).toBeNull();
    runs.get('b')!.stopped = true;
    expect(runs.ownerOfTab(10)).toBe('a');
    expect(runs.ownerOfTab(20)).toBeNull();
  });

  it('reports a finished download once, with only the protocol fields', () => {
    const runs = new Runs();
    runs.ensure('a');
    runs.updateDownload('a', { id: 7, name: 'report.txt', path: '/Users/x/Downloads/report.txt', size: 0, state: 'in_progress' });
    expect(runs.takeFinished('a')).toEqual([]);
    runs.updateDownload('a', { id: 7, name: 'report.txt', path: '/Users/x/Downloads/report.txt', size: 28, mime: 'text/plain', state: 'complete' });
    runs.updateDownload('a', { id: 7, state: 'complete' });
    expect(runs.takeFinished('a')).toEqual([{ path: '/Users/x/Downloads/report.txt', name: 'report.txt', size: 28, mime: 'text/plain' }]);
    expect(runs.takeFinished('a')).toEqual([]);
    runs.updateDownload('a', { id: 7, state: 'complete' });
    expect(runs.takeFinished('a')).toEqual([]);
    expect(runs.takeFinished('nobody')).toEqual([]);
  });
});
