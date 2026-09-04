// The permission cards, where they appear. A run_command ask renders INSIDE the
// chat whose turn is waiting (above its composer), every other chat shows a
// notice bar that opens it, and the sidebar row gets a dot. The exec half runs
// through the real ExecService via the fake backend's [e2e:exec] script; the
// coding-agent half is injected on the preload channel, since no scripted turn
// calls coding_agent — its cards are what the adapter's long option names were
// breaking, so the labels are asserted here against a real render.
import type { Page } from '@playwright/test';
import { expect, closeApp, launchApp, mainWindowOf, test, type LaunchedApp } from './electron';

async function send(win: Page, text: string): Promise<void> {
  const box = win.getByPlaceholder('Ask Stem…');
  await box.fill(text);
  await box.press('Enter');
}

test.describe('inline permission cards', () => {
  let launched: LaunchedApp;
  let win: Page;
  test.beforeAll(async () => {
    launched = await launchApp({
      externalServer: true,
      seedSettings: {
        onboarding: { completed: true },
        releaseNotes: { showOnUpdate: false, lastSeenVersion: null },
        exec: { enabled: true, approvalMode: 'manual', judgeModel: null, allowlist: [] }
      }
    });
    win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
  });
  test.afterAll(async () => closeApp(launched));

  test('a card in its chat, a notice elsewhere, short coding-agent labels, and a late answer', async () => {
    // Thread A: a plain exchange.
    await send(win, 'first thread, nothing to approve');
    await expect(win.locator('.message-assistant .message-body').last()).toContainText('Echo');
    await win.locator('.chats-modes').getByRole('button', { name: 'Chats', exact: true }).click();
    const rowA = win.locator('.chat-row.selected');
    await expect(rowA).toBeVisible();
    const threadA = await rowA.getAttribute('data-thread-id');

    // Thread B: the exec card.
    await win.getByTitle('New conversation').click();
    await send(win, '[e2e:exec] run something');
    await expect(win.getByText('Run this command?')).toBeVisible();
    await expect(win.locator('.chat-approval')).toBeVisible();
    await expect(win.locator('.mcp-approval-backdrop')).toHaveCount(0);
    const threadB = await win.locator('.chat-row.selected').getAttribute('data-thread-id');

    // Over in thread A: the notice bar and the amber dot.
    await win.locator(`.chat-row[data-thread-id="${threadA}"]`).click();
    await expect(win.locator('.approval-notice')).toBeVisible();
    await expect(win.locator('.chat-approval')).toHaveCount(0);
    await expect(win.locator(`.chat-row[data-thread-id="${threadB}"] .chat-status.waiting`)).toBeVisible();

    // Open chat brings the card back; answering it runs the command.
    await win.getByRole('button', { name: 'Open chat' }).click();
    await expect(win.locator('.chat-approval')).toBeVisible();
    await win.getByRole('button', { name: 'Allow once' }).click();
    await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText('stem-e2e-approved');
    await expect(win.locator('.chat-approval')).toHaveCount(0);
    await expect(win.locator('.approval-notice')).toHaveCount(0);

    // A coding-agent ask, injected on the preload channel with the adapter's
    // real option names — the formatting the report was about.
    const fakeHarness = (id: string, threadId: string) => ({
      id,
      threadId,
      agent: 'claude',
      hostLabel: 'join3r-macbook',
      title: 'Read /Users/join3r/.npm/_npx/bea277e60a4a7902/node_modules/davinci-resolve-mcp/src/utils/media_analysis.py (4122 – 4144)',
      options: [
        { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
        { optionId: 'always', kind: 'allow_always', name: 'Always Allow Read(//Users/join3r/.npm/_npx/bea277e60a4a7902/node_modules/davinci-resolve-mcp/src/utils/**)' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
      ],
      expiresAt: Date.now() + 90_000
    });
    await launched.app.evaluate(({ BrowserWindow }, req) => {
      BrowserWindow.getAllWindows()
        .find((x) => !/quickchat|hud/.test(x.webContents.getURL()))!
        .webContents.send('harness:approvalRequest', req);
    }, fakeHarness('h-1', threadB!));
    await expect(win.getByText('The claude agent asks for permission')).toBeVisible();
    await expect(win.getByRole('button', { name: 'Always allow', exact: true })).toBeVisible();

    // An ask from a thread the sidebar cannot open: Review → modal.
    await launched.app.evaluate(({ BrowserWindow }, req) => {
      BrowserWindow.getAllWindows()
        .find((x) => !/quickchat|hud/.test(x.webContents.getURL()))!
        .webContents.send('harness:approvalRequest', req);
    }, fakeHarness('h-2', 'mail-thread-xyz'));
    await expect(win.locator('.approval-notice')).toContainText('in another conversation');
    await win.getByRole('button', { name: 'Review' }).click();
    await expect(win.locator('.mcp-approval-backdrop')).toBeVisible();
    // Answering it: the server never had it, so it reports "too late".
    await win.locator('.mcp-approval-backdrop').getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(win.getByText('That answer came too late')).toBeVisible();
    await win.getByRole('button', { name: 'OK' }).click();
    await expect(win.getByText('That answer came too late')).toHaveCount(0);
  });
});
