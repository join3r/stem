// Message-operation e2e — copy, edit, retry, fork, delete on chat messages.
// Runs ONLY when STEM_E2E_REAL is set (otherwise skipped), because the per-message
// action buttons only appear once a message carries a real backend turnId, and
// edit/retry/delete/fork drive the real thread ops (rollbackToTurn/forkThread)
// through pi. Auth is the global one auto-seeded into the throwaway pi-home (see
// real-backend.spec.ts). Each test sends tiny fixed-token prompts to keep the
// assertions stable and the quota cost minimal. Run with: STEM_E2E_REAL=1 npm run test:e2e
import { test, expect, REAL_BACKEND } from './electron';
import type { Page } from '@playwright/test';

// Type a prompt and send it (Enter sends).
async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

// Wait for the latest turn's assistant reply to render `token`, then for the turn
// to settle — the per-message action row only renders while !running, so we wait
// for the last user bubble's actions to (re)appear before driving any operation.
async function waitForReply(win: Page, token: RegExp): Promise<void> {
  const reply = win.locator('.message-assistant:not(.activity-row) .message-body').last();
  await expect(reply).toContainText(token, { timeout: 100_000 });
  await expect(win.locator('.message-user').last().locator('.message-actions')).toBeAttached({
    timeout: 20_000
  });
}

test.describe('message actions (real backend)', () => {
  test.skip(!REAL_BACKEND, 'set STEM_E2E_REAL=1 to run against real pi');

  // Each test spawns pi and takes one or more real turns.
  test.slow();

  test('copies a message and flips the button to the copied state', async ({ mainWindow }) => {
    test.setTimeout(120_000);
    await send(mainWindow, 'Reply with exactly the single word PONG and nothing else.');
    await waitForReply(mainWindow, /pong/i);

    // The action buttons are opacity:0 until the message is hovered.
    const userMsg = mainWindow.locator('.message-user').last();
    await userMsg.hover();
    await userMsg.getByTitle('Copy message').click();

    // The clipboard write is async; the observable signal is the icon/tooltip
    // flipping to "Copied" (the check icon) for ~1.5s.
    await expect(userMsg.getByTitle('Copied')).toBeVisible();
  });

  test('edits a user message: cancel restores, save & run re-runs the turn', async ({ mainWindow }) => {
    test.setTimeout(180_000);
    await send(mainWindow, 'Reply with exactly the single word RED and nothing else.');
    await waitForReply(mainWindow, /red/i);

    const userMsg = mainWindow.locator('.message-user').last();
    await userMsg.hover();
    await userMsg.getByTitle('Edit & re-run').click();

    // The inline editor opens seeded with the original text.
    const editor = mainWindow.locator('.message-edit textarea');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(/RED/);

    // Cancel closes the editor and leaves the conversation untouched.
    await mainWindow.getByRole('button', { name: 'Cancel' }).click();
    await expect(mainWindow.locator('.message-edit')).toHaveCount(0);
    await expect(mainWindow.locator('.messages')).toContainText('RED');

    // Re-open, change the text, Save & run → the old turn is rolled back and a
    // fresh turn streams a new reply for the edited prompt.
    await userMsg.hover();
    await userMsg.getByTitle('Edit & re-run').click();
    await mainWindow
      .locator('.message-edit textarea')
      .fill('Reply with exactly the single word GREEN and nothing else.');
    await mainWindow.getByRole('button', { name: 'Save & run' }).click();

    await waitForReply(mainWindow, /green/i);
    // The edited prompt replaced the original — the RED turn is gone.
    await expect(mainWindow.locator('.messages')).not.toContainText('RED');
  });

  test('retries an assistant reply without duplicating the turn', async ({ mainWindow }) => {
    test.setTimeout(180_000);
    await send(mainWindow, 'Reply with exactly the single word OKAY and nothing else.');
    await waitForReply(mainWindow, /okay/i);

    const assistant = mainWindow.locator('.message-assistant:not(.activity-row)').last();
    await assistant.hover();
    await assistant.getByTitle('Retry — regenerate this reply').click();

    // Retry truncates the turn and re-sends the SAME prompt, so after it settles
    // there is still exactly one user bubble and one assistant reply (no dup).
    await waitForReply(mainWindow, /okay/i);
    await expect(mainWindow.locator('.message-user')).toHaveCount(1);
    await expect(mainWindow.locator('.message-assistant:not(.activity-row)')).toHaveCount(1);
  });

  test('forks the conversation into a new chat from a turn', async ({ mainWindow }) => {
    test.setTimeout(120_000);
    await send(mainWindow, 'Reply with exactly the single word BLUE and nothing else.');
    await waitForReply(mainWindow, /blue/i);

    // One chat row exists for the conversation we just started.
    await expect(mainWindow.locator('.chat-row')).toHaveCount(1);

    const userMsg = mainWindow.locator('.message-user').last();
    await userMsg.hover();
    await userMsg.getByTitle('Fork into a new chat from here').click();

    // A second chat row appears and becomes the active (selected) one, replaying
    // the forked history (the BLUE exchange). The original is left in place.
    await expect(mainWindow.locator('.chat-row')).toHaveCount(2, { timeout: 20_000 });
    await expect(mainWindow.locator('.chat-row.selected')).toHaveCount(1);
    await expect(mainWindow.locator('.messages')).toContainText('BLUE');
  });

  test('delete-from-here arms on first click and truncates on the second', async ({ mainWindow }) => {
    test.setTimeout(180_000);
    await send(mainWindow, 'Reply with exactly the single word ALPHA and nothing else.');
    await waitForReply(mainWindow, /alpha/i);
    await send(mainWindow, 'Reply with exactly the single word BETA and nothing else.');
    await waitForReply(mainWindow, /beta/i);

    const secondUser = mainWindow.locator('.message-user').last();
    await secondUser.hover();
    await secondUser.getByTitle('Delete from here').click();

    // First click only arms the delete (changed tooltip / red danger state) —
    // nothing is removed yet.
    await expect(
      secondUser.getByTitle('Click again to delete this turn and everything after it')
    ).toBeVisible();
    await expect(mainWindow.locator('.messages')).toContainText('BETA');

    // Second click truncates the second turn and everything after it; the first
    // turn survives.
    await secondUser.getByTitle('Click again to delete this turn and everything after it').click();
    await expect(mainWindow.locator('.messages')).not.toContainText('BETA');
    await expect(mainWindow.locator('.messages')).toContainText('ALPHA');
    await expect(mainWindow.locator('.message-user')).toHaveCount(1);
  });
});
