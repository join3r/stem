// Hermetic chat-turn e2e — the full send → stream → settle path through real
// IPC, event routing, and renderer state, against the scripted FakeBackend
// (src/server/backend/fake.ts). No pi process, auth, or network. The scripted
// turn markers ([e2e:hang] / [e2e:fail]) come from the fake's prompt protocol.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

test('sends a message and renders the streamed reply', async ({ mainWindow }) => {
  await send(mainWindow, 'Hello Stem');

  // Optimistic user bubble is immediate; the echoed reply streams in.
  await expect(mainWindow.locator('.message-user').last()).toContainText('Hello Stem');
  const reply = mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last();
  await expect(reply).toContainText('Echo: Hello Stem');

  // The turn settled: the composer is back to Send (no Stop) and the message
  // action row (only rendered when idle) is attached.
  await expect(mainWindow.getByTitle('Stop')).toHaveCount(0);
  await expect(mainWindow.locator('.message-user').last().locator('.message-actions')).toBeAttached();

  // The thread joined the sidebar once its first turn ran.
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
});

test('a second turn continues the same thread', async ({ mainWindow }) => {
  await send(mainWindow, 'first');
  await expect(
    mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last()
  ).toContainText('Echo: first');
  await send(mainWindow, 'second');
  await expect(
    mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last()
  ).toContainText('Echo: second');

  await expect(mainWindow.locator('.message-user')).toHaveCount(2);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
});

test('Stop interrupts a hanging turn and recovers the composer', async ({ mainWindow }) => {
  await send(mainWindow, '[e2e:hang] please wait');

  // The turn streams its first chunk then hangs; Stop is showing.
  const stop = mainWindow.getByTitle('Stop');
  await expect(stop).toBeVisible();
  await stop.click();

  // Stop aborts the turn in place (unlike Escape-retract it does NOT refill the
  // composer): the running state clears and a fresh send works immediately.
  await expect(mainWindow.getByTitle('Stop')).toHaveCount(0);
  await send(mainWindow, 'after stop');
  await expect(
    mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last()
  ).toContainText('Echo: after stop');
});

test('a failed turn surfaces a system error bubble with Retry', async ({ mainWindow }) => {
  await send(mainWindow, '[e2e:fail] break please');

  const systemBubble = mainWindow.locator('.message-system');
  await expect(systemBubble).toContainText('E2E scripted failure');
  await expect(mainWindow.getByTitle('Stop')).toHaveCount(0);

  // The failure is per-turn, not fatal: the next send streams normally.
  await send(mainWindow, 'still alive?');
  await expect(
    mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last()
  ).toContainText('Echo: still alive?');
});

test('a new chat lands with the caret in the composer', async ({ mainWindow }) => {
  const composer = mainWindow.getByPlaceholder('Ask Stem…');
  await send(mainWindow, 'first');
  await expect(
    mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last()
  ).toContainText('Echo: first');

  // Coming from an open thread, ChatView remounts — the focus must land on the
  // composer of the *new* instance, and the user can type straight away.
  await mainWindow.keyboard.press('ControlOrMeta+n');
  await expect(mainWindow.locator('.message-user')).toHaveCount(0);
  await expect(composer).toBeFocused();
  await mainWindow.keyboard.type('typed without clicking');
  await expect(composer).toHaveValue('typed without clicking');

  // ⌘N on a draft that is already open doesn't remount anything, so this is the
  // other half of the fix: focus comes back even from elsewhere in the window.
  await composer.blur();
  await expect(composer).not.toBeFocused();
  await mainWindow.keyboard.press('ControlOrMeta+n');
  await expect(composer).toBeFocused();
  // Nothing is remounted here, so the unsent text stays — ⌘N on an empty draft
  // shouldn't throw away what you were writing.
  await expect(composer).toHaveValue('typed without clicking');
});
