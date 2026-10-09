// Real UI clicks through the Manage panel — reachable because the STEM_E2E seam
// (tests/e2e/electron.ts) reports a healthy backend, so the renderer mounts past
// the sign-in gate. These drive actual DOM, not the bridge: tab navigation, the
// empty-memory state, and a tidy-up preset that writes through to the store.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, launchApp, mainWindowOf, removeUserData } from './electron';

test('opens the Memory tab and shows the empty state on a fresh workspace', async ({ mainWindow }) => {
  // The inspector is open by default; switch to the Memory tab (a toolbar button,
  // distinct from the Memory on/off switch which is role="switch").
  await mainWindow.getByRole('button', { name: 'Memory', exact: true }).click();

  // "Stored memory" is a collapsible section that starts collapsed; expand it
  // (the toggle button) to reveal the empty state.
  const toggle = mainWindow.getByRole('button', { name: /Stored memory/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(mainWindow.getByText('No memories stored yet', { exact: false })).toBeVisible();
});

test('a tidy-up preset click persists through to the memory settings', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Memory', exact: true }).click();

  // The "Tidy up automatically" segmented control writes via setTidyThreshold
  // (a pure store op — no backend), so the click round-trips through real IPC.
  // Default is "Normal" (5); click "Frequent" (3) so the change is observable.
  // ("Frequent" is unique — the Facts/Recall sub-switcher uses different labels.)
  const frequent = mainWindow.getByRole('button', { name: 'Frequent', exact: true });
  await frequent.click();
  await expect(frequent).toHaveClass(/active/);

  // Confirm it actually persisted in the main process, not just the UI.
  const tidy = await mainWindow.evaluate(() => (window as any).stem.getMemorySettings().then((s: any) => s.tidyThreshold));
  expect(tidy).toBe(3);
});

test('the Sources tab opens on Files and switches to connected folders', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Sources — files & connected folders' }).click();

  // Files is the default sub-tab: on a fresh workspace STEM_FILES_DIR is empty,
  // so the drop-to-add empty state shows rather than a listing.
  const filesSub = mainWindow.getByRole('button', { name: 'Files', exact: true });
  await expect(filesSub).toHaveClass(/active/);
  await expect(mainWindow.getByText('Add to Files', { exact: false })).toBeVisible();

  // The other half of the tab: the connected-folders registry, also empty.
  await mainWindow.getByRole('button', { name: 'Connected folders', exact: true }).click();
  await expect(mainWindow.getByText('Connect a folder', { exact: false })).toBeVisible();
  await expect(mainWindow.getByRole('button', { name: 'Add folder' })).toBeVisible();
});

test('the Files sub-tab lists a seeded Files folder and deletes through to disk', async () => {
  // Its own launch: the shared fixture points STEM_FILES_DIR at an empty dir,
  // and files/ has to exist BEFORE the app reads it (there is no store to seed
  // — the directory itself is the source of truth, see server/files/store.ts).
  const filesDir = mkdtempSync(join(tmpdir(), 'stem-files-'));
  mkdirSync(join(filesDir, 'Recipes'), { recursive: true });
  writeFileSync(join(filesDir, 'notes.txt'), 'top level');
  writeFileSync(join(filesDir, 'Recipes', 'cake.md'), '# cake');
  const { app, userDataDir } = await launchApp({ env: { STEM_FILES_DIR: filesDir } });
  try {
    const win = await mainWindowOf(app);
    await win.waitForLoadState('domcontentloaded');
    await win.getByRole('button', { name: 'Sources — files & connected folders' }).click();

    // Grouped by top-level subfolder: root files under "Top level", the rest
    // under their folder name.
    await expect(win.getByText('Top level', { exact: true })).toBeVisible();
    await expect(win.getByText('Recipes', { exact: true })).toBeVisible();
    await expect(win.getByText('notes.txt', { exact: true })).toBeVisible();
    await expect(win.getByText('cake.md', { exact: true })).toBeVisible();

    // Delete round-trips through files:remove to the real directory. The row
    // action confirms first, so accept the dialog before clicking.
    win.once('dialog', (d) => void d.accept());
    await win.getByRole('button', { name: 'Delete notes.txt' }).click();
    await expect(win.getByText('notes.txt', { exact: true })).toHaveCount(0);
    expect(readdirSync(filesDir).sort()).toEqual(['Recipes']);

    // New subfolder: created on disk and kept on screen while still empty (the
    // sections come from `dirs`, not just from dirs that hold files).
    await win.getByRole('button', { name: 'New subfolder' }).click();
    await win.getByRole('textbox', { name: 'New subfolder name' }).fill('Invoices');
    await win.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(win.getByText('Invoices', { exact: true })).toBeVisible();
    await expect(win.getByText('Empty — drop files here to fill it.')).toBeVisible();
    expect(readdirSync(filesDir).sort()).toEqual(['Invoices', 'Recipes']);

    // And back out again, taking the (empty) folder with it.
    win.once('dialog', (d) => void d.accept());
    await win.getByRole('button', { name: 'Delete subfolder Invoices' }).click();
    await expect(win.getByText('Invoices', { exact: true })).toHaveCount(0);
    expect(readdirSync(filesDir).sort()).toEqual(['Recipes']);
  } finally {
    await app.close().catch(() => {});
    removeUserData(userDataDir);
    removeUserData(filesDir);
  }
});

test('the Personas editor round-trips the spawn flag, the send budget, and the clients flag', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Personas', exact: true }).click();

  // Secretary ships with the spawn capability on; its editor's Access tab
  // shows the switch already on.
  await mainWindow.getByText('Secretary', { exact: true }).click();
  await mainWindow.getByRole('tab', { name: 'Access' }).click();
  const spawnSwitch = mainWindow.getByRole('switch', { name: 'Can start helpers' });
  await expect(spawnSwitch).toBeChecked();

  // Chats-from-clients ships OFF for every persona — opening one up is the
  // user's call, so the switch starts off and the flip must land in the store.
  const clientsSwitch = mainWindow.getByRole('switch', { name: 'Open to chats' });
  await expect(clientsSwitch).not.toBeChecked();
  await clientsSwitch.click();

  // Set a send budget and save — the values must land in the store.
  const budget = mainWindow.getByLabel('Send budget per wave');
  await budget.fill('5');
  await mainWindow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() =>
      mainWindow.evaluate(() =>
        (window as any).stem
          .listPersonas()
          .then((list: any[]) => list.find((p: any) => p.id === 'secretary'))
      )
    )
    .toMatchObject({ sendBudget: 5, canSpawn: true, clients: true });
});

test('an MCP server pasted as JSON fills a draft, saves, reopens and is removed', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Tools — MCP & skills', exact: true }).click();

  await mainWindow.getByRole('button', { name: 'New', exact: true }).click();
  await mainWindow.getByRole('menuitem', { name: /Paste JSON/ }).click();
  await mainWindow
    .getByLabel('Server JSON')
    .fill('"fsdemo": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": { "DEBUG": "1" } },');
  await mainWindow.getByRole('button', { name: 'Fill in', exact: true }).click();

  // The draft opens in the editor with every field filled from the paste.
  await expect(mainWindow.getByLabel('Server name')).toHaveValue('fsdemo');
  await expect(mainWindow.getByLabel('Command', { exact: true })).toHaveValue('npx');
  await expect(mainWindow.getByLabel('Arguments')).toHaveValue('-y @modelcontextprotocol/server-filesystem /tmp');
  await expect(mainWindow.getByLabel('Environment variables')).toHaveValue('DEBUG=1');
  await mainWindow.getByRole('button', { name: 'Add server', exact: true }).click();

  await expect
    .poll(() => mainWindow.evaluate(() => (window as any).stem.listMcpServers().then((l: any[]) => l.map((s) => s.name))))
    .toContain('fsdemo');
  // Saving keeps the editor on the server, now under its fixed name.
  await expect(mainWindow.locator('.ld-name-static')).toHaveText('fsdemo');

  await mainWindow.getByRole('button', { name: 'Back to MCP servers' }).click();
  await mainWindow.getByText('fsdemo', { exact: true }).click();
  await mainWindow.getByRole('button', { name: 'Remove server' }).click();
  await mainWindow.getByRole('button', { name: 'Remove server?' }).click();
  await expect
    .poll(() => mainWindow.evaluate(() => (window as any).stem.listMcpServers().then((l: any[]) => l.map((s) => s.name))))
    .not.toContain('fsdemo');
});
