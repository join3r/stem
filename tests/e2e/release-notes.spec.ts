// "What's new" popup, end to end: it opens on the first launch of a build the
// user hasn't seen, it doesn't come back after being dismissed, and it stays
// away when the preference is off. Each case is its own launch — the whole
// feature is a startup decision, so there is nothing to assert mid-session.
import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';
import { expect, launchApp, mainWindowOf, openSettings, type LaunchedApp, removeUserData } from './electron';

const APP_VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

/** An install that is past onboarding — the state every existing user is in. */
const ONBOARDED = { onboarding: { completed: true } };

async function withApp(seedSettings: Record<string, unknown>, fn: (app: LaunchedApp) => Promise<void>) {
  const launched = await launchApp({ seedSettings });
  try {
    await fn(launched);
  } finally {
    await launched.app.close().catch(() => {});
    removeUserData(launched.userDataDir);
  }
}

/**
 * The marker lives in client.json, not settings.json: which build you are
 * running is a fact about the machine you are sitting at, and one server may be
 * answering several of them.
 */
function savedMarker(app: LaunchedApp): string | null {
  const doc = JSON.parse(readFileSync(app.clientStorePath, 'utf8')) as {
    settings?: { releaseNotes?: { lastSeenVersion?: string | null } };
  };
  return doc.settings?.releaseNotes?.lastSeenVersion ?? null;
}

test('an existing install sees this version once, then never again', async () => {
  await withApp(ONBOARDED, async (launched) => {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');

    const dialog = win.getByRole('dialog', { name: `What's new in Stem ${APP_VERSION}` });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // Scoped to the running version: the notes for older releases are one click
    // away, not in your face.
    await expect(dialog.locator('.release-notes-section')).toHaveCount(1);
    await expect(dialog.locator('.release-notes-version')).toContainText(APP_VERSION);

    await dialog.getByRole('button', { name: 'View all release notes' }).click();
    await expect(win.getByRole('dialog', { name: 'Release notes' }).locator('.release-notes-section').first()).toBeVisible();

    await win.getByRole('button', { name: 'Close' }).click();
    await expect(win.locator('.release-notes-card')).toHaveCount(0);

    // Dismissal is what records it — reopening the app must stay quiet.
    await expect
      .poll(() => savedMarker(launched), { timeout: 5000 })
      .toBe(APP_VERSION);
  });
});

test('nothing pops up once this version has been seen', async () => {
  await withApp(
    { ...ONBOARDED, releaseNotes: { showOnUpdate: true, lastSeenVersion: APP_VERSION } },
    async (launched) => {
      const win = await mainWindowOf(launched.app);
      await win.waitForLoadState('domcontentloaded');
      await expect(win.locator('.conversation')).toBeVisible({ timeout: 15_000 });
      await expect(win.locator('.release-notes-card')).toHaveCount(0);
    }
  );
});

test('with the preference off, nothing pops up and the marker still advances', async () => {
  await withApp(
    { ...ONBOARDED, releaseNotes: { showOnUpdate: false, lastSeenVersion: null } },
    async (launched) => {
      const win = await mainWindowOf(launched.app);
      await win.waitForLoadState('domcontentloaded');
      await expect(win.locator('.conversation')).toBeVisible({ timeout: 15_000 });
      await expect(win.locator('.release-notes-card')).toHaveCount(0);
      // Turning it back on later must not replay what was skipped.
      await expect
        .poll(() => savedMarker(launched), { timeout: 5000 })
        .toBe(APP_VERSION);
    }
  );
});

test('Settings → About shows the version and opens the full history', async () => {
  await withApp(
    { ...ONBOARDED, releaseNotes: { showOnUpdate: true, lastSeenVersion: APP_VERSION } },
    async (launched) => {
      const win = await mainWindowOf(launched.app);
      await win.waitForLoadState('domcontentloaded');
      await openSettings(win, 'App');

      await expect(win.getByText(`Stem ${APP_VERSION}`)).toBeVisible();
      await win.getByRole('button', { name: 'View release notes' }).click();

      const dialog = win.getByRole('dialog', { name: 'Release notes' });
      await expect(dialog).toBeVisible();
      // The whole history, not just this version.
      expect(await dialog.locator('.release-notes-section').count()).toBeGreaterThan(1);
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(win.locator('.release-notes-card')).toHaveCount(0);
    }
  );
});
