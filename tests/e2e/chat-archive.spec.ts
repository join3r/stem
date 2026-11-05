// Chat archive: a chat leaves the tree for the folded Archived section at its
// foot and nothing about it is lost. Real DOM, real IPC, real inbox store, the
// scripted FakeBackend answering turns.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

const SHOTS = process.env.STEM_E2E_SHOTS;

const chatRow = (win: Page, text: string) => win.locator('.chats-group .chat-row').filter({ hasText: text });
const archivedToggle = (win: Page) => win.getByRole('button', { name: /^Archived \(\d+\)$/ });

async function sendChat(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
  await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
    `Echo: ${text}`
  );
}

test('archiving a chat folds it away, and it comes back by menu, by shortcut, or by a new turn', async ({
  mainWindow: win
}) => {
  await win.locator('.chats-modes').getByRole('button', { name: 'Chats', exact: true }).click();
  await sendChat(win, 'old plans');
  await win.getByTitle(/^New thread/).click();
  await sendChat(win, 'current work');
  await expect(chatRow(win, 'old plans')).toBeVisible();
  await expect(archivedToggle(win)).toHaveCount(0);

  // Right-click → Archive: out of the tree, counted under the folded section.
  await chatRow(win, 'old plans').click({ button: 'right' });
  await win.locator('.ctx-menu').getByRole('button', { name: /^Archive/ }).click();
  await expect(chatRow(win, 'old plans')).toHaveCount(0);
  await expect(archivedToggle(win)).toHaveText('Archived (1)');

  // Unfolded, the row is there and still opens; its menu offers the way back.
  await archivedToggle(win).click();
  await expect(chatRow(win, 'old plans')).toBeVisible();
  await chatRow(win, 'old plans').click({ button: 'right' });
  if (SHOTS) await win.screenshot({ path: `${SHOTS}/archived-section.png` });
  await win.locator('.ctx-menu').getByRole('button', { name: /^Move out of archive/ }).click();
  await expect(archivedToggle(win)).toHaveCount(0);
  await expect(chatRow(win, 'old plans')).toBeVisible();

  // ⌘⇧A archives the chat you are reading and opens the next one in the list.
  await chatRow(win, 'current work').click();
  await expect(win.locator('.message-body').filter({ hasText: 'Echo: current work' })).toBeVisible();
  await win.keyboard.press('ControlOrMeta+Shift+A');
  await expect(archivedToggle(win)).toHaveText('Archived (1)');
  await expect(win.locator('.message-body').filter({ hasText: 'Echo: current work' })).toHaveCount(0);
  await expect(win.locator('.message-body').filter({ hasText: 'Echo: old plans' })).toBeVisible();

  // Opened again from the Archived section, it is still whole.
  if ((await chatRow(win, 'current work').count()) === 0) await archivedToggle(win).click();
  await chatRow(win, 'current work').click();
  await expect(win.locator('.message-body').filter({ hasText: 'Echo: current work' })).toBeVisible();

  // The archive is a timestamp: a new turn in the chat lifts it back out.
  // Thread times are whole seconds, so the turn has to land in a later one.
  await win.waitForTimeout(1_100);
  await sendChat(win, 'picking this up again');
  await expect(archivedToggle(win)).toHaveCount(0);
  await expect(chatRow(win, 'current work')).toBeVisible();

  // The server holds it, so a fresh list agrees with the screen.
  const archived = await win.evaluate(async () => {
    const stem = (
      window as unknown as {
        stem: { listChats(): Promise<{ inbox: { entries: Record<string, { archivedAt?: number }> } }> };
      }
    ).stem;
    return Object.values((await stem.listChats()).inbox.entries).filter((e) => e.archivedAt != null).length;
  });
  expect(archived).toBe(1); // the resurrected chat keeps its stamp; only its activity outranks it
});

test('the delete confirmation offers archive instead', async ({ mainWindow: win }) => {
  await win.locator('.chats-modes').getByRole('button', { name: 'Chats', exact: true }).click();
  await sendChat(win, 'maybe keep');
  await win.keyboard.press('Control+Shift+X');
  const dialog = win.getByRole('dialog');
  await expect(dialog).toContainText('Delete this thread?');
  await dialog.getByRole('button', { name: 'Archive instead' }).click();
  await expect(dialog).toBeHidden();
  await expect(archivedToggle(win)).toHaveText('Archived (1)');
  await expect(chatRow(win, 'maybe keep')).toHaveCount(0);
});
