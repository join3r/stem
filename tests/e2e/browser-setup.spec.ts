// Settings → Features → Browser control, waiting for Load unpacked: once Set up
// has put the extension in its folder and no browser has loaded it, the row
// spells out the steps, with the folder's path to paste. The folder is seeded
// rather than made by pressing Set up, which would write native-messaging
// manifests into this computer's real browsers.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupBrowsers } from '../../src/desktop/browser-host/install';
import { closeApp, expect, launchApp, mainWindowOf, openSettings, test } from './electron';

// The folder the steps name: a Snap or Flatpak browser on this computer loads
// its own copy, which is the one shown when such a browser comes first (as on
// a Linux box whose only Chrome is the Flatpak).
function expectedFolder(extensionDir: string): string {
  return setupBrowsers()[0]?.extensionPath ?? realpathSync(extensionDir);
}

test('waiting for Load unpacked shows the steps and the folder to paste', async () => {
  test.skip(process.platform !== 'darwin' && process.platform !== 'linux', 'browser control runs on macOS and Linux');
  const launched = await launchApp({
    seedSettings: {
      onboarding: { completed: true },
      releaseNotes: { showOnUpdate: false, lastSeenVersion: null }
    }
  });
  try {
    const extensionDir = join(launched.userDataDir, 'browser-extension');
    mkdirSync(extensionDir, { recursive: true });
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    await openSettings(win, 'Features');

    await win.getByRole('switch', { name: /Let Stem control this (Mac|computer)’s browser/ }).click();
    await expect(win.getByText('Waiting for Load unpacked')).toBeVisible();
    const steps = win.locator('.ext-steps');
    await expect(steps.getByText('Developer mode')).toBeVisible();
    await expect(steps.getByText('Load unpacked')).toBeVisible();
    await expect(steps.locator('.ext-path')).toHaveText(expectedFolder(extensionDir));
    await steps.scrollIntoViewIfNeeded();
    if (process.env.STEM_E2E_SHOT) {
      await steps.screenshot({ path: process.env.STEM_E2E_SHOT });
      await win.screenshot({
        path: process.env.STEM_E2E_SHOT.replace(/\.png$/, '-window.png')
      });
    }
  } finally {
    await closeApp(launched);
  }
});

// Adding another browser or profile once one is connected: Set up again must
// bring the steps back, though the known-browser list never changes for a new
// profile. The Set up and open-page handlers are stubbed — the real ones write
// manifests into this Mac's browsers and open Finder.
test('Set up again shows the steps until Done', async () => {
  test.skip(process.platform !== 'darwin' && process.platform !== 'linux', 'browser control runs on macOS and Linux');
  const userDataDir = mkdtempSync(join(tmpdir(), 'stem-e2e-'));
  const extensionDir = join(userDataDir, 'browser-extension');
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'browser-host.json'),
    JSON.stringify({ enabled: true, known: [{ id: '/Applications/Arc.app', name: 'Arc' }] })
  );
  const launched = await launchApp({
    userDataDir,
    seedSettings: {
      onboarding: { completed: true },
      releaseNotes: { showOnUpdate: false, lastSeenVersion: null }
    }
  });
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    await launched.app.evaluate(({ ipcMain }) => {
      // Set up answers with the state as it stands, which is all the row reads.
      type Handler = (...args: unknown[]) => unknown;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
      const localState = handlers.get('browserHost:localState')!;
      ipcMain.removeHandler('browserHost:setUp');
      ipcMain.handle('browserHost:setUp', (...args) => localState(...args));
      ipcMain.removeHandler('browserHost:openExtensions');
      ipcMain.handle('browserHost:openExtensions', () => undefined);
    });
    await openSettings(win, 'Features');

    await expect(win.getByText('Arc not running')).toBeVisible();
    const steps = win.locator('.ext-steps');
    await expect(steps).toHaveCount(0);
    await win.getByRole('button', { name: 'Set up again' }).click();
    await expect(steps.getByText('Load unpacked')).toBeVisible();
    await expect(steps.getByText('Adding a profile?', { exact: false })).toBeVisible();
    await expect(steps.locator('.ext-path')).toHaveText(expectedFolder(extensionDir));
    if (process.env.STEM_E2E_SHOT) await steps.screenshot({ path: process.env.STEM_E2E_SHOT });
    await steps.getByRole('button', { name: 'Done' }).click();
    await expect(steps).toHaveCount(0);
  } finally {
    await closeApp(launched);
  }
});
