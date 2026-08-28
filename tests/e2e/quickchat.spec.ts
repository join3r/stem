// Quick Chat overlay lifecycle, end-to-end against the FakeBackend: summon →
// prompt → disappear-to-HUD → "Answer ready" → re-summon shows the streamed
// answer. Window visibility is asserted in the MAIN process (BrowserWindow),
// so this exercises the real per-platform overlay path — the NSPanel on macOS
// and the transparent CSS-card window on Linux (under xvfb in CI).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import type { ElectronApplication } from '@playwright/test';
import { test, expect, launchApp, mainWindowOf, removeUserData } from './electron';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const windowState = (app: ElectronApplication, flag: 'quickchat' | 'hud') =>
  app.evaluate(({ BrowserWindow }, needle) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(needle));
    return { exists: !!win, visible: win?.isVisible() ?? false };
  }, flag);

test('summon → prompt → HUD → re-summon shows the answer', async ({ electronApp, mainWindow }) => {
  // Pre-created hidden at startup — but the prewarm hangs off the whenReady tail,
  // so on a loaded runner the first window may not exist the instant the main
  // window is up. Poll for it rather than racing the tail (same wait as the CLI
  // toggle test below).
  await expect.poll(async () => (await windowState(electronApp, 'quickchat')).exists).toBe(true);
  expect((await windowState(electronApp, 'quickchat')).visible).toBe(false);

  // Summon (same main-process path as the global shortcut / tray / HUD click).
  await mainWindow.evaluate(() => (window as any).stem.revealQuickChat());
  await expect.poll(async () => (await windowState(electronApp, 'quickchat')).visible).toBe(true);

  // Type a prompt into the compact bar. Running it starts the disappear→pill
  // cycle: the overlay hides and the status HUD tracks the turn.
  const overlay = electronApp.windows().find((w) => w.url().includes('quickchat'))!;
  const input = overlay.getByPlaceholder('Ask Stem anything…');
  await input.fill('Hello overlay');
  await input.press('Enter');
  await expect.poll(async () => (await windowState(electronApp, 'quickchat')).visible).toBe(false);
  await expect.poll(async () => (await windowState(electronApp, 'hud')).visible).toBe(true);

  const hud = electronApp.windows().find((w) => w.url().includes('hud'))!;
  await expect(hud.getByText('Answer ready')).toBeVisible();

  // Re-summoning resumes the session as the expanded panel with the answer,
  // and dismisses the HUD.
  await mainWindow.evaluate(() => (window as any).stem.revealQuickChat());
  await expect(overlay.getByText('Echo: Hello overlay')).toBeVisible();
  await expect.poll(async () => (await windowState(electronApp, 'hud')).visible).toBe(false);

  // Explicit dismissal hides the overlay again.
  await overlay.evaluate(() => (window as any).stem.hideQuickChat());
  await expect.poll(async () => (await windowState(electronApp, 'quickchat')).visible).toBe(false);
});

test('a cold `--quick-chat` launch opens the overlay, not the main window', async () => {
  // The command a Wayland user binds to a system shortcut. With Stem closed it has
  // to feel like the shortcut does when Stem is running: overlay up front, main
  // window loaded (the backend prewarm hangs off it) but not shown.
  const { app, userDataDir } = await launchApp({ extraArgs: ['--quick-chat'] });
  try {
    await expect.poll(async () => (await windowState(app, 'quickchat')).visible, { timeout: 15_000 }).toBe(true);
    const main = await mainWindowOf(app);
    const mainVisible = await app.evaluate(({ BrowserWindow }, url) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url);
      return win?.isVisible() ?? null;
    }, main.url());
    expect(mainVisible).toBe(false);
  } finally {
    await app.close().catch(() => {});
    removeUserData(userDataDir);
  }
});

test('a second `--quick-chat` launch toggles the running instance (Linux CLI summon path)', async () => {
  test.skip(process.platform !== 'linux', 'the second-instance CLI toggle ships for Linux (Wayland summon path)');

  const { app, userDataDir } = await launchApp();
  try {
    await mainWindowOf(app);
    // The toggle is dropped until the overlay window exists (whenReady tail).
    await expect.poll(async () => (await windowState(app, 'quickchat')).exists).toBe(true);

    // Same userData dir → same single-instance lock → argv handed to the first
    // instance, which toggles the overlay; the second launch exits immediately.
    const second = spawn(
      electronPath as unknown as string,
      [PROJECT_ROOT, `--user-data-dir=${userDataDir}`, '--quick-chat'],
      { env: { ...process.env, STEM_E2E: '1' }, stdio: 'ignore' }
    );
    const exited = new Promise<number | null>((resolve) => second.on('exit', resolve));

    await expect.poll(async () => (await windowState(app, 'quickchat')).visible, { timeout: 15_000 }).toBe(true);
    expect(await exited).toBe(0);
  } finally {
    await app.close().catch(() => {});
    removeUserData(userDataDir);
  }
});
