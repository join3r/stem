// A tab the browser replaces while Stem attaches (jbrow wakes a sleeping tab
// under a new ID): Stem's debugger session follows it to the new ID, so the
// next call by that ID reuses the session instead of attaching a second time
// and being refused by Stem's own debugger (2026-11-03).
import { beforeAll, describe, expect, it } from 'vitest';

type Listener = (...args: unknown[]) => void;
const attachCalls: number[] = [];
const commandTabs: number[] = [];
const detachListeners: Listener[] = [];
let cdp: typeof import('../../src/browser-extension/cdp.js');

beforeAll(async () => {
  const event = (list: Listener[] = []) => ({ addListener: (fn: Listener) => list.push(fn) });
  (globalThis as { chrome?: unknown }).chrome = {
    debugger: {
      attach: async ({ tabId }: { tabId: number }) => {
        attachCalls.push(tabId);
        // jbrow announces the new ID while the attach is still running.
        if (tabId === 1000033) cdp.tabReplaced(1000033, 8);
      },
      detach: async () => {},
      sendCommand: async ({ tabId }: { tabId: number }, method: string) => {
        commandTabs.push(tabId);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'l1' } } };
        if (method === 'Runtime.evaluate') return { result: { value: true } };
        return {};
      },
      onEvent: event(),
      onDetach: event(detachListeners)
    },
    runtime: { getURL: (p: string) => `chrome-extension://x/${p}` }
  };
  cdp = await import('../../src/browser-extension/cdp.js');
});

describe('a tab replaced during attach', () => {
  it('files the session under the new ID and reuses it', async () => {
    const s = await cdp.attach(1000033);
    expect(s.tabId).toBe(8);
    expect(cdp.session(8)).toBe(s);
    expect(cdp.session(1000033)).toBe(s);
    expect(await cdp.attach(8)).toBe(s);
    expect(attachCalls).toEqual([1000033]);
    commandTabs.length = 0;
    await s.send('Page.reload');
    expect(commandTabs).toEqual([8]);
  });

  it('lets go of it when the browser detaches by either ID', () => {
    for (const fn of detachListeners) fn({ tabId: 1000033 }, 'target_closed');
    expect(cdp.session(8)).toBeUndefined();
  });
});
