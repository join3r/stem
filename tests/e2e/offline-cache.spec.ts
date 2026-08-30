// The promise this whole step exists to keep: get on a train, open Stem, read
// your chats.
//
// It is deliberately two app launches rather than one. Everything the offline
// cache is for happens across a restart — you close the lid at the office and
// open it in a tunnel — and a cache proved by the very process that filled it
// proves nothing about the file it wrote. So the first launch chats normally
// against a `stem-server` in its own process, the server is then STOPPED for
// good, and the app is launched again against the same state dir and the same
// dead address.
//
// The second launch is the interesting one, and note how much of it is not
// about chats: the app has to start at all. Fetching the channel list is the
// first thing a launch does, asking for the settings document is nearly the
// second, and before this step both of them took the app down when nothing
// answered. A client whose reason to keep a cache is to be useful with no
// network cannot refuse to open with no network.
import { expect, closeApp, launchApp, mainWindowOf, test, type LaunchedApp } from './electron';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

/** What the client has actually written down, read from outside the app. */
function cachedThreads(userDataDir: string): { threadId: string; payload: string }[] {
  const db = new DatabaseSync(join(userDataDir, 'chat-cache.sqlite'));
  try {
    return db.prepare('SELECT thread_id AS threadId, payload FROM threads').all() as {
      threadId: string;
      payload: string;
    }[];
  } finally {
    db.close();
  }
}

const SEED = {
  onboarding: { completed: true },
  releaseNotes: { showOnUpdate: false, lastSeenVersion: null }
};

test.describe.configure({ mode: 'serial' });

test.describe('with the server stopped', () => {
  let launched: LaunchedApp;
  let win: Page;
  /** The second launch, against the same disk and a server that is gone. */
  let offlineApp: ElectronApplication | null = null;

  test.beforeAll(async () => {
    launched = await launchApp({ externalServer: true, seedSettings: SEED });
    win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await offlineApp?.close().catch(() => undefined);
    await closeApp(launched);
  });

  test('the client fills its cache while the server is there', async () => {
    await send(win, 'what did we decide about the roof');
    await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
      'Echo: what did we decide about the roof',
      { timeout: 30_000 }
    );

    await win.getByTitle('New conversation').click();
    await send(win, 'the reading list for the trip');
    await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
      'Echo: the reading list for the trip',
      { timeout: 30_000 }
    );
    await win.locator('.chats-modes').getByRole('button', { name: 'Chats', exact: true }).click();
    await expect(win.locator('.chat-row')).toHaveCount(2);

    // Nobody asked for this. The catch-up run is triggered by the turn ending
    // and diffs updatedAt against what is already cached, so both transcripts
    // are on this machine's disk without anyone having reopened either thread.
    await expect
      .poll(() => cachedThreads(launched.userDataDir).length, { timeout: 30_000 })
      .toBe(2);
    const payloads = cachedThreads(launched.userDataDir).map((t) => t.payload).join('\n');
    expect(payloads).toContain('what did we decide about the roof');
    expect(payloads).toContain('Echo: the reading list for the trip');
  });

  test('the app opens with the server gone, and its chats are readable', async () => {
    const url = launched.server!.url;
    await launched.app.close();
    // Not a blip and not a cut: the process is stopped and its port is closed,
    // so every attempt this client makes for the rest of the test is refused
    // outright. That is the train.
    await launched.server!.stop();

    const second = await launchApp({
      userDataDir: launched.userDataDir,
      env: { STEM_SERVER_URL: url }
    });
    offlineApp = second.app;
    const offlineWin = await mainWindowOf(second.app);
    await offlineWin.waitForLoadState('domcontentloaded');

    // It started. Before this step, the failed GET /channels took the app down.
    await expect(offlineWin.getByText(/Stem can’t reach its server/)).toBeVisible({ timeout: 60_000 });

    // The sidebar is the cache's, and it is the real list — not an empty one
    // that would read as "you have no chats".
    await expect(offlineWin.locator('.chat-row')).toHaveCount(2, { timeout: 30_000 });

    // And a thread opens. Nothing on the other end answered chats:open; this
    // transcript came off this Mac's own disk.
    // Rows carry the written subject ("About what did we"), so match on that.
    await offlineWin.locator('.chat-row').filter({ hasText: 'what did we' }).click();
    await expect(offlineWin.locator('.message-user').first()).toContainText(
      'what did we decide about the roof'
    );
    await expect(
      offlineWin.locator('.message-assistant:not(.activity-row) .message-body').first()
    ).toContainText('Echo: what did we decide about the roof');

    // …and the answer is honest about being an answer from the past: the API
    // says where it came from, not just the banner.
    const flagged = await offlineWin.evaluate(
      () => (window as any).stem.listChats() as Promise<{ offline?: boolean }>
    );
    expect(flagged.offline).toBe(true);
  });

  test('the composer will not take a message it cannot send', async () => {
    const offlineWin = await mainWindowOf(offlineApp!);
    // Blocked at the field, not at send. There is no local brain to answer with
    // and no outbox to hold what you typed, so a composer that accepted text
    // would be collecting messages it could only throw away.
    const composer = offlineWin.getByPlaceholder('Offline — you can read your chats, but not send');
    await expect(composer).toBeVisible();
    await expect(composer).toBeDisabled();
    await expect(offlineWin.getByPlaceholder('Ask Stem…')).toHaveCount(0);
  });

  test('memory, skills and search say they need the server rather than looking empty', async () => {
    const offlineWin = await mainWindowOf(offlineApp!);

    // The distinction the plan insists on. "No skills yet" and "No memories
    // stored yet" are sentences about YOUR data; rendering them because a fetch
    // failed tells somebody their skills and memories are gone.
    //
    // Search first — the inspector opens on the Chats tab, and the chats are
    // still there. It is the SEARCHING that is unavailable, which is exactly the
    // difference this test is about.
    await offlineWin.getByTitle(/Search chats/).click();
    const box = offlineWin.getByPlaceholder('Search chats…');
    await box.fill('roof');
    await box.press('Enter');
    await expect(offlineWin.getByText(/Search needs Stem’s server/)).toBeVisible({ timeout: 15_000 });
    await expect(offlineWin.getByText('No matching chats.')).toHaveCount(0);
    await box.press('Escape');

    await offlineWin.getByRole('button', { name: 'Memory', exact: true }).click();
    await expect(offlineWin.getByText(/memory lives on Stem’s server/).first()).toBeVisible({
      timeout: 15_000
    });
    await expect(
      offlineWin.getByText('No memories stored yet — Stem builds these as you chat.')
    ).toHaveCount(0);

    await offlineWin.getByRole('button', { name: 'Tools — MCP & skills', exact: true }).click();
    await offlineWin.getByRole('button', { name: 'Skills', exact: true }).click();
    await expect(offlineWin.getByText(/skills live on Stem’s server/)).toBeVisible({ timeout: 15_000 });
    await expect(offlineWin.getByText(/No skills yet/)).toHaveCount(0);
  });
});
