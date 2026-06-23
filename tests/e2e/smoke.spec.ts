// Smoke: the built app boots, the renderer paints, and the preload bridge is
// wired. Hermetic — works without pi auth (the app may render the sign-in gate,
// but the toolbar shell and `window.stem` bridge are present in every state).
import { test, expect } from './electron';

test('app boots and exposes the preload bridge', async ({ mainWindow }) => {
  // "Stem" renders in every app state (toolbar + gate card), so match the first.
  await expect(mainWindow.getByText('Stem', { exact: true }).first()).toBeVisible();

  // The context-bridge API the renderer talks to the main process through.
  const hasBridge = await mainWindow.evaluate(() => typeof (window as any).stem?.getMemorySettings === 'function');
  expect(hasBridge).toBe(true);
});

// Depend on `mainWindow` so all three windows have opened before we count.
test('exactly one main window (overlay + HUD are separate)', async ({ electronApp, mainWindow }) => {
  await expect(mainWindow).toHaveURL(/index\.html/);
  const urls = electronApp.windows().map((w) => w.url());
  const mainWindows = urls.filter((u) => u && !u.includes('quickchat') && !u.includes('hud'));
  expect(mainWindows.length).toBe(1);
});
