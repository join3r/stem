// Settings → Features → Browser control, waiting for Load unpacked: once Set up
// has put the extension in its folder and no browser has loaded it, the row
// spells out the steps, with the folder's path to paste. The folder is seeded
// rather than made by pressing Set up, which would write native-messaging
// manifests into this Mac's real browsers.
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { closeApp, expect, launchApp, mainWindowOf, openSettings, test } from './electron';

test('waiting for Load unpacked shows the steps and the folder to paste', async () => {
  test.skip(process.platform !== 'darwin', 'browser control is macOS-only');
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

    await win.getByRole('switch', { name: 'Let Stem control this Mac’s browser' }).click();
    await expect(win.getByText('Waiting for Load unpacked')).toBeVisible();
    const steps = win.locator('.ext-steps');
    await expect(steps.getByText('Developer mode')).toBeVisible();
    await expect(steps.getByText('Load unpacked')).toBeVisible();
    await expect(steps.locator('.ext-path')).toHaveText(realpathSync(extensionDir));
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
