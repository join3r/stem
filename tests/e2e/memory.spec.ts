// Memory stack integration, end-to-end through the REAL wiring:
// renderer preload bridge (window.stem) → ipcMain handlers → workspace/memory →
// recall store (node:sqlite), against the isolated throwaway DB. This exercises
// the same path the Manage panel uses, but drives it via the bridge so it runs
// hermetically without pi auth (the memory IPC handlers don't need the backend).
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

// Thin typed wrappers around the context-bridge calls evaluated in the renderer.
// Only hermetic memory ops are driven here. `setMemoryEnabled` is deliberately
// NOT exercised: its IPC handler calls runtime.restart(), which spawns pi and
// needs auth — so that one belongs in an auth-gated UI test, not this suite.
const stem = {
  getSettings: (w: Page) => w.evaluate(() => (window as any).stem.getMemorySettings()),
  setTidy: (w: Page, n: number) => w.evaluate((v) => (window as any).stem.setTidyThreshold(v), n),
  setEpisodicLimit: (w: Page, bytes: number) => w.evaluate((v) => (window as any).stem.setEpisodicLimit(v), bytes),
  read: (w: Page) => w.evaluate(() => (window as any).stem.readMemory()),
  episodicStats: (w: Page) => w.evaluate(() => (window as any).stem.getEpisodicStats())
};

test('memory settings expose the expected shape and the episodic limit round-trips', async ({ mainWindow }) => {
  const settings = await stem.getSettings(mainWindow);
  expect(typeof settings.enabled).toBe('boolean');
  expect(typeof settings.tidyThreshold).toBe('number');
  expect(typeof settings.episodicLimitBytes).toBe('number');

  // A pure store-backed setting (no backend involved) persists + echoes back.
  const updated = await stem.setEpisodicLimit(mainWindow, 50 * 1024 * 1024);
  expect(updated.episodicLimitBytes).toBe(50 * 1024 * 1024);
  const reread = await stem.getSettings(mainWindow);
  expect(reread.episodicLimitBytes).toBe(50 * 1024 * 1024);
});

test('tidy-up threshold round-trips', async ({ mainWindow }) => {
  const updated = await stem.setTidy(mainWindow, 10);
  expect(updated.tidyThreshold).toBe(10);
  const reread = await stem.getSettings(mainWindow);
  expect(reread.tidyThreshold).toBe(10);
});

test('a fresh workspace reports empty stored memory', async ({ mainWindow }) => {
  const contents = await stem.read(mainWindow);
  const notes = (contents.files ?? []).filter((f: any) => f.kind === 'note' && f.content?.trim());
  expect(notes.length).toBe(0);

  const stats = await stem.episodicStats(mainWindow);
  expect(stats.messageCount).toBe(0);
});
