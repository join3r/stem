// Real UI clicks through the Web search settings. Search moved from an
// openai-codex-only request-body injection to the vendored pi-web-access
// extension, which works on every provider — so the per-context toggles must no
// longer hide themselves, and the backend/key configuration must actually be
// reachable. Both are DOM-level facts a unit test cannot check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, openSettings } from './electron';
import { SEARCH_BACKENDS } from '../../src/renderer/manage/searchBackends';

/**
 * Settings → Models with the Web search group expanded: it folds to a one-line
 * summary ("Backend · Automatic · ✓ ready"), so the picker and key fields these
 * tests drive must be unfolded first.
 */
const openSearchSettings = async (win: Parameters<typeof openSettings>[0]): Promise<void> => {
  await openSettings(win, 'Models');
  await win.getByRole('button', { name: /^Backend/ }).click();
};

test('the Settings tab exposes the web-search backend picker', async ({ mainWindow }) => {
  await openSearchSettings(mainWindow);

  const backend = mainWindow.getByLabel('Search backend', { exact: true });
  await expect(backend).toBeVisible();
  // Defaults to the keyless chain, so a fresh install searches with no setup.
  await expect(backend).toHaveValue('auto');
});

test('picking a keyed backend reveals its key field and persists', async ({ mainWindow }) => {
  await openSearchSettings(mainWindow);

  const backend = mainWindow.getByLabel('Search backend', { exact: true });
  await backend.selectOption('tavily');
  await expect(mainWindow.getByLabel('Tavily key', { exact: true }).first()).toBeVisible();

  // The picker paints optimistically and reconciles from the write, so the key
  // field showing up proves nothing about the store — poll the real settings.
  await expect
    .poll(async () =>
      mainWindow.evaluate(() =>
        (window as unknown as { stem: { getSettings(): Promise<{ webSearch: { provider: string } }> } }).stem
          .getSettings()
          .then((s) => s.webSearch.provider)
      )
    )
    .toBe('tavily');
});

test('SearXNG offers an endpoint field, not an API key', async ({ mainWindow }) => {
  await openSearchSettings(mainWindow);

  await mainWindow.getByLabel('Search backend', { exact: true }).selectOption('searxng');
  await expect(mainWindow.getByLabel('SearXNG endpoint', { exact: true }).first()).toBeVisible();
});

test('every backend is selectable, independent of the chat model', async ({ mainWindow }) => {
  await openSearchSettings(mainWindow);

  const values = await mainWindow.getByLabel('Search backend', { exact: true }).evaluate((el) =>
    [...(el as HTMLSelectElement).options].map((o) => o.value)
  );
  // Against the catalogue rather than a copy of it: a hand-written list here is a
  // second place to remember, and the one time it was forgotten — seven backends
  // added in 0.18.0 — it failed the build on main rather than catching anything.
  // Still a real check, because the picker groups, filters and renders the
  // catalogue on its way to the DOM, and this asserts nothing is lost or invented
  // in between. Order follows the readiness sections, so compare as a set.
  expect([...values].sort()).toEqual(SEARCH_BACKENDS.map((b) => b.id).sort());
});

// Which backends cost you nothing to try is the first thing you need from this
// picker, and it is not derivable from the names — so the list is sectioned by it.
test('the picker groups backends by what they still need', async ({ mainWindow }) => {
  await openSearchSettings(mainWindow);

  const sections = await mainWindow.getByLabel('Search backend', { exact: true }).evaluate((el) =>
    [...(el as HTMLSelectElement).querySelectorAll('optgroup')].map((g) => ({
      label: g.label,
      values: [...g.querySelectorAll('option')].map((o) => o.value)
    }))
  );
  // A fresh profile has no keys and no ChatGPT sign-in, so only two sections.
  expect(sections.map((s) => s.label)).toEqual(['Works with no key', 'Not set up yet']);
  expect(sections[0].values).toEqual(['auto', 'all', 'exa']);
  expect(sections[1].values).toContain('brave');
});

test('all backend keys are editable at once and survive a backend switch', async ({ mainWindow }) => {
  await openSearchSettings(mainWindow);
  await mainWindow.getByRole('button', { name: /all backend keys/ }).click();

  // Two different backends' keys, entered while a third is selected.
  await mainWindow.getByLabel('Exa key', { exact: true }).fill('exa-key-1');
  await mainWindow.getByLabel('Brave key', { exact: true }).fill('brave-key-1');
  await mainWindow.getByLabel('Search backend', { exact: true }).selectOption('exa');

  const savedCreds = () =>
    mainWindow.evaluate(() =>
      (
        window as unknown as {
          stem: { getSettings(): Promise<{ webSearch: { credentials: Record<string, string> } }> };
        }
      ).stem
        .getSettings()
        .then((s) => s.webSearch.credentials)
    );
  // Same optimistic write as above: wait for the store, don't race it.
  await expect.poll(async () => (await savedCreds()).exaApiKey).toBe('exa-key-1');
  expect((await savedCreds()).braveApiKey).toBe('brave-key-1');
});

// BUG-005. settings.json is not what the search tools read — pi-web-access reads
// <piHome>/web-search.json — and the handler rewrote that file only on a backend
// change. Asserting the store alone is how a credential-only edit could look
// saved while every search kept running on the old key. Deliberately no backend
// switch here: one would rewrite the file for its own reasons and hide the bug.
test('a key edit on its own reaches the config the search tools read', async ({ electronApp, mainWindow }) => {
  const configPath = join(
    await electronApp.evaluate(({ app }) => app.getPath('userData')),
    'pi-home',
    'web-search.json'
  );
  const writtenConfig = (): Record<string, string> | null => {
    try {
      return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, string>;
    } catch {
      return null; // not written yet
    }
  };

  await openSearchSettings(mainWindow);
  await mainWindow.getByRole('button', { name: /all backend keys/ }).click();
  await mainWindow.getByLabel('Brave key', { exact: true }).fill('brave-key-only');

  await expect.poll(() => writtenConfig()?.braveApiKey).toBe('brave-key-only');
});

// The composer button and the Settings checkbox are two views of one saved
// boolean — the one the server reads when a turn starts. So the test that matters
// is not that the button renders, but that a click on either is visible in the
// store and in the other control without a reload.
test('the composer Web button writes the saved switch, and Settings follows it', async ({ mainWindow }) => {
  const webButton = mainWindow.getByRole('group', { name: 'Web search' }).getByRole('button', { name: 'Web' });
  const savedMain = () =>
    mainWindow.evaluate(() =>
      (
        window as unknown as { stem: { getSettings(): Promise<{ webSearch: { main: boolean } }> } }
      ).stem.getSettings().then((s) => s.webSearch.main)
    );

  // A fresh profile ships with search on, and the button says so.
  await expect(webButton).toHaveAttribute('title', /Web search on/);
  await webButton.click();
  await expect(webButton).toHaveAttribute('title', /Web search off/);
  // Painted optimistically, so the store is the assertion that counts.
  await expect.poll(savedMain).toBe(false);

  // Same switch, second view: the checkbox opens already unchecked...
  await openSettings(mainWindow, 'Chat');
  const checkbox = mainWindow.getByRole('checkbox', { name: 'Web search' }).first();
  await expect(checkbox).not.toBeChecked();
  // ...and turning it back on there moves the composer button, which never
  // re-mounted in between.
  await checkbox.check();
  await expect(webButton).toHaveAttribute('title', /Web search on/);
  await expect.poll(savedMain).toBe(true);
});

test('the web-search toggle shows regardless of the selected model', async ({ mainWindow }) => {
  // The toggle rides with the model it applies to (Chat), not with the backend
  // that answers the search (Models).
  await openSettings(mainWindow, 'Chat');

  // Previously gated on selectedModel.supportsNativeWebSearch, which was false for
  // every provider but openai-codex.
  await expect(mainWindow.getByRole('checkbox', { name: 'Web search' }).first()).toBeVisible();
});
