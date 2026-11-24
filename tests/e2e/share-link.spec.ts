// Share links e2e (docs/public-share-design.md): the dialog opens from an
// answer's hover actions, offers the three scopes, previews exactly what would
// be published, and without a verified address explains why instead of
// publishing. The upload itself is covered by tests/unit/share.test.ts and the
// relay's share_test.go.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './electron';
import { closeApp, launchApp, mainWindowOf, openSettings } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

test('previews an answer and asks for a verified address before sharing', async ({ mainWindow }) => {
  test.setTimeout(120_000);
  await send(mainWindow, 'Reply with exactly the single word SHAREME and nothing else.');
  const reply = mainWindow.locator('.message-assistant:not(.activity-row)').last();
  await expect(reply.locator('.message-body')).toContainText(/shareme/i, { timeout: 60_000 });

  await reply.hover();
  await reply.getByLabel('Share this answer as a link').click();
  const dialog = mainWindow.getByRole('dialog', { name: 'Share as a link' });
  await expect(dialog).toBeVisible();
  const preview = dialog.locator('.share-preview');
  // Question and answer is the default.
  await expect(dialog.getByRole('radio', { name: 'Question and answer' })).toHaveAttribute('aria-checked', 'true');
  await expect(preview).toContainText(/shareme/i);
  await expect(preview.locator('.message-user')).toHaveCount(1);
  await dialog.getByRole('radio', { name: 'Answer only' }).click();
  await expect(preview.locator('.message-user')).toHaveCount(0);
  await expect(preview.locator('.message-assistant')).toHaveCount(1);
  await dialog.getByRole('radio', { name: 'Whole chat' }).click();
  await expect(preview.locator('.message-user')).toHaveCount(1);
  await expect(dialog.getByLabel('Expiry')).toHaveValue('30');
  // The link preview is on, filled from the chat, and editable.
  await expect(dialog.getByLabel('Preview title')).toHaveValue(/Reply with exactly/);
  await expect(dialog.getByLabel('Preview description')).toHaveValue(/SHAREME/);
  await dialog.getByLabel('Preview title').fill('Môj nadpis');
  await expect(dialog.getByLabel('Preview title')).toHaveValue('Môj nadpis');
  await expect(dialog).toContainText('Sharing needs a verified email address');
  await expect(dialog.getByRole('button', { name: 'Verify an address in Settings' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create link' })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Question and answer' }).click();
  await mainWindow.screenshot({ path: test.info().outputPath('share-dialog.png') });

  // Only people I choose: the card turns off (it is not encrypted), and a bad address says so.
  await dialog.getByRole('radio', { name: 'Only people I choose' }).click();
  await expect(dialog.getByLabel('Preview title')).toHaveCount(0);
  await dialog.getByLabel('Email addresses').fill('martin@gmail.com, nope');
  await expect(dialog).toContainText('Not an email address: nope');
  await dialog.getByLabel('Email addresses').fill('martin@gmail.com, eva@company.sk');
  await expect(dialog).toContainText('a person enters a code that Stem mails to their address');
  await expect(dialog).toContainText('Only the people above can read');
  await mainWindow.screenshot({ path: test.info().outputPath('share-dialog-locked.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('lists shared links on their own page and opens one', async () => {
  // shares.json with plain keys: decryptSecretValue passes a plain value through.
  const dir = mkdtempSync(join(tmpdir(), 'stem-e2e-shares-'));
  const store = join(dir, 'shares.json');
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const share = (id: string, title: string, scope: string, created: number, expires: number, extra = {}) => ({
    id,
    base: `https://share.heystem.app/s/${id}`,
    key: `key-${id}`,
    source: { kind: 'chat', threadId: `t-${id}` },
    scope,
    kind: scope === 'thread' ? 'thread' : 'answer',
    title,
    createdAt: created,
    expiresAt: expires,
    size: 1000,
    ...extra
  });
  writeFileSync(
    store,
    JSON.stringify({
      version: 1,
      shares: [
        share('aaa', 'Garden plan', 'pair', now - 3 * day, now + 27 * day),
        share('bbb', 'Tax questions', 'thread', now - day, now + day, {
          recipients: ['martin@gmail.com', 'eva@company.sk'],
          opens: [{ address: 'martin@gmail.com', firstAt: now - 3600_000, lastAt: now - 600_000, count: 3 }]
        }),
        share('ccc', 'Old recipe', 'answer', now - 40 * day, now - day)
      ]
    })
  );
  const launched = await launchApp({
    env: { STEM_SHARES_STORE: store },
    seedSettings: {
      onboarding: { completed: true },
      releaseNotes: { showOnUpdate: false, lastSeenVersion: null }
    }
  });
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    await openSettings(win, 'Features');

    // Features shows one row with the count of working links (the expired one is gone).
    const row = win.getByRole('button', { name: /Links you shared/ });
    await expect(row).toContainText('2');
    await row.click();

    // The page replaces Features: newest first, a clock on the one that ends soon.
    await expect(win.getByRole('button', { name: 'Back to Features' })).toBeVisible();
    await expect(win.getByText('Mail', { exact: true })).toHaveCount(0);
    const names = win.locator('.ld-row-name strong');
    await expect(names).toHaveText(['Tax questions', 'Garden plan']);
    await expect(win.getByRole('img', { name: /^Stops on/ })).toHaveCount(1);

    await expect(win.getByRole('button', { name: /Tax questions/ })).toContainText('Only 2 people · opened by 1');
    await win.getByRole('button', { name: /Tax questions/ }).click();
    await expect(win.getByText('Who can open it')).toBeVisible();
    await expect(win.locator('.set-vrow', { hasText: 'martin@gmail.com' })).toContainText('3 times');
    await expect(win.locator('.set-vrow', { hasText: 'eva@company.sk' })).toContainText('Not opened yet');
    await win.screenshot({ path: test.info().outputPath('shared-link-locked.png') });
    await win.getByRole('button', { name: 'Back to Shared links' }).click();

    await win.getByPlaceholder('Find a link or a person').fill('eva@');
    await expect(names).toHaveText(['Tax questions']);
    await win.getByPlaceholder('Find a link or a person').fill('garden');
    await expect(names).toHaveText(['Garden plan']);
    await win.screenshot({ path: test.info().outputPath('shared-links-list.png') });

    // A link opens its own page with the full link, Copy and Revoke.
    await win.getByRole('button', { name: /Garden plan/ }).click();
    await expect(win.getByRole('textbox', { name: 'Link' })).toHaveValue('https://share.heystem.app/s/aaa#key-aaa');
    await expect(win.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect(win.getByRole('button', { name: 'Revoke link' })).toBeVisible();
    await win.screenshot({ path: test.info().outputPath('shared-link-detail.png') });

    await win.getByRole('button', { name: 'Back to Shared links' }).click();
    await win.getByRole('button', { name: 'Back to Features' }).click();
    await expect(win.getByRole('button', { name: /Links you shared/ })).toBeVisible();
  } finally {
    await closeApp(launched);
  }
});
