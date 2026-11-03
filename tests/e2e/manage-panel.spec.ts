// Real UI clicks through the Manage panel — reachable because the STEM_E2E seam
// (tests/e2e/electron.ts) reports a healthy backend, so the renderer mounts past
// the sign-in gate. These drive actual DOM, not the bridge: tab navigation, the
// empty-memory state, and a tidy-up cadence that writes through to the store.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, expect, launchApp, mainWindowOf, removeUserData } from './electron';

test('opens the Memory tab and shows the empty state on a fresh workspace', async ({ mainWindow }) => {
  // The inspector is open by default; switch to the Memory tab (a toolbar button,
  // distinct from the Memory on/off switch which is role="switch").
  await mainWindow.getByRole('button', { name: 'Memory', exact: true }).click();

  // The facts list is open by default, so the empty state shows straight away.
  await expect(mainWindow.getByText('No memories stored yet', { exact: false })).toBeVisible();
});

test('the tidy-up cadence persists through to the memory settings', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Memory', exact: true }).click();

  // The cadence lives under Housekeeping (collapsed: tidy-up runs by itself) and
  // writes via setTidyThreshold (a pure store op — no backend), so the change
  // round-trips through real IPC. Default is Normal (5); pick Frequent (3).
  await mainWindow.getByRole('button', { name: /Housekeeping/ }).click();
  const cadence = mainWindow.getByRole('combobox', { name: 'Automatic tidy-up' });
  await cadence.selectOption({ label: 'Frequent' });
  await expect(cadence).toHaveValue('3');

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
  await mainWindow.getByRole('button', { name: 'Personas & people', exact: true }).click();
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

test('People shares the Personas icon; a new person saves, lists and is deleted', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Personas & people', exact: true }).click();
  await mainWindow.getByRole('button', { name: 'People', exact: true }).click();
  await expect(mainWindow.getByText('No people yet', { exact: false })).toBeVisible();

  await mainWindow.getByRole('button', { name: 'New person' }).click();
  await mainWindow.getByLabel('Name').fill('Peter Novák');
  await mainWindow.getByLabel('Who they are to you').fill('colleague');
  await mainWindow.getByLabel('Also called').fill('Peťo, Novák');
  await mainWindow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => mainWindow.evaluate(() => (window as any).stem.listPeople()))
    .toMatchObject([{ name: 'Peter Novák', relation: 'colleague', aliases: ['Peťo', 'Novák'], status: 'active' }]);

  await mainWindow.getByRole('button', { name: 'Back to People' }).click();
  await expect(mainWindow.getByText('Peter Novák', { exact: true })).toBeVisible();
  await mainWindow.getByText('Peter Novák', { exact: true }).click();
  await mainWindow.getByRole('button', { name: 'Delete person' }).click();
  await mainWindow.getByRole('button', { name: 'Delete person?' }).click();
  await expect(mainWindow.getByText('No people yet', { exact: false })).toBeVisible();
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

test('a connected folder saves its edits on Save, and New opens the wizard with the kind picked', async ({ mainWindow }) => {
  const dir = mkdtempSync(join(tmpdir(), 'stem-e2e-vault-'));
  try {
    await mainWindow.evaluate((p) => (window as any).stem.addConnectedFolders([p]), dir);
    await mainWindow.getByRole('button', { name: 'Sources — files & connected folders' }).click();
    await mainWindow.getByRole('button', { name: 'Connected folders', exact: true }).click();

    const label = basename(dir);
    await mainWindow.getByText(label, { exact: true }).click();
    await mainWindow.getByLabel('Kind').selectOption('notes');
    await mainWindow.getByRole('tab', { name: 'Access' }).click();
    await mainWindow.getByRole('switch', { name: 'Writable' }).click();
    // Nothing is written before Save.
    const stored = () =>
      mainWindow.evaluate(() => (window as any).stem.listConnectedFolders().then((l: any[]) => l[0]));
    expect(await stored()).toMatchObject({ mode: 'read' });
    await mainWindow.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(stored).toMatchObject({ mode: 'readwrite', kind: 'notes' });

    await mainWindow.getByRole('button', { name: 'Back to Connected folders' }).click();
    await mainWindow.getByRole('button', { name: 'Add folder' }).click();
    await mainWindow.getByRole('menuitem', { name: /Documents/ }).click();
    const wizard = mainWindow.getByRole('dialog', { name: 'Connect a folder' });
    await expect(wizard.getByRole('button', { name: /Documents/ })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    removeUserData(dir);
  }
});

test('Claude Code connects from the wizard without a path and fills the folder', async () => {
  // A fixture ~/.claude: one session and one memory note. Cowork is pointed at
  // nothing so the run never reads this machine's real Claude app data.
  const claudeDir = mkdtempSync(join(tmpdir(), 'stem-e2e-claude-'));
  const project = join(claudeDir, 'projects', '-work-app');
  mkdirSync(join(project, 'memory'), { recursive: true });
  writeFileSync(
    join(project, 'aaaaaaaa-1111.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Plan the release' }, timestamp: '2026-10-19T15:07:00Z', cwd: '/work/app' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] }, timestamp: '2026-10-19T15:08:00Z' })
    ].join('\n')
  );
  writeFileSync(join(project, 'memory', 'tabs.md'), '---\nname: tabs\ntype: user\n---\nThe user prefers tabs.');
  const { app, userDataDir } = await launchApp({
    env: { CLAUDE_CONFIG_DIR: claudeDir, STEM_CLAUDE_COWORK_DIR: join(claudeDir, 'no-cowork') }
  });
  try {
    const win = await mainWindowOf(app);
    await win.waitForLoadState('domcontentloaded');
    await win.getByRole('button', { name: 'Sources — files & connected folders' }).click();
    await win.getByRole('button', { name: 'Connected folders', exact: true }).click();
    await win.getByRole('button', { name: 'Add folder' }).click();
    await win.getByRole('menuitem', { name: /Claude Code/ }).click();

    const wizard = win.getByRole('dialog', { name: 'Connect a folder' });
    await expect(wizard.getByLabel('Folder path')).toHaveCount(0);
    await expect(wizard.getByLabel('Folder name')).toHaveValue('Claude Code');
    await wizard.getByRole('button', { name: 'Next' }).click();
    // Access is skipped: the copy is always read-only.
    await expect(wizard.getByText('Should Stem remember what it reads here?')).toBeVisible();
    await wizard.getByRole('button', { name: 'Connect' }).click();
    await expect(wizard).toHaveCount(0);

    const folder = () =>
      win.evaluate(() => (window as any).stem.listConnectedFolders().then((l: any[]) => l.find((f) => f.kind === 'claude')));
    await expect.poll(folder).toMatchObject({ label: 'Claude Code', mode: 'read', memorize: true, index: true, kind: 'claude' });
    const path = (await folder()).path as string;
    const written = (readdirSync(path, { recursive: true }) as string[]).map((f) => f.split('\\').join('/')).sort();
    expect(written).toContain('memory/user/work-app/tabs.md');
    expect(written).toContain('sessions/work-app/2026-10-19-plan-the-release-aaaaaaaa.md');
  } finally {
    await app.close();
    removeUserData(userDataDir);
    removeUserData(claudeDir);
  }
});
