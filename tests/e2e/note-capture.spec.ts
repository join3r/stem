// Quick memory notes (`/note` / `//`), end-to-end through the real UI: typing in
// the actual composer flips it into note mode, Enter writes a durable explicit
// fact through the preload bridge → ipcMain → recall store, and the transient
// "Saved to memory" flash confirms. Hermetic: the save path never needs pi (the
// background canonicalization pass is best-effort and simply no-ops here).
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

const composer = (w: Page) => w.getByPlaceholder(/Ask Stem…|Save a note to memory…/);
const readNotes = (w: Page) =>
  w.evaluate(() =>
    (window as any).stem.readMemory().then((c: any) => (c.files ?? []).filter((f: any) => f.kind === 'note'))
  );

test('typing // flips the main composer into note mode and Enter saves a fact', async ({ mainWindow }) => {
  const input = composer(mainWindow);
  await input.pressSequentially('//prefers tabs over spaces');

  // The chip replaces the typed prefix and the placeholder switches.
  await expect(mainWindow.getByText('Note to memory')).toBeVisible();
  await expect(input).toHaveValue('prefers tabs over spaces');

  await input.press('Enter');
  await expect(mainWindow.getByText('Saved to memory')).toBeVisible();
  // Mode + draft reset for the next message.
  await expect(mainWindow.getByText('Note to memory')).not.toBeVisible();
  await expect(input).toHaveValue('');

  // The fact is durable in the real store, marked as user-requested + unpinned.
  const notes = await readNotes(mainWindow);
  expect(notes).toHaveLength(1);
  expect(notes[0].statement).toBe('prefers tabs over spaces');
  expect(notes[0].source).toBe('On request');
  expect(notes[0].pinned).toBe(false);
});

test('the /note prefix triggers too, but /notes and mid-message // do not', async ({ mainWindow }) => {
  const input = composer(mainWindow);
  await input.pressSequentially('/note staging DB is pg16');
  await expect(mainWindow.getByText('Note to memory')).toBeVisible();
  await input.press('Enter');
  await expect(mainWindow.getByText('Saved to memory')).toBeVisible();
  expect((await readNotes(mainWindow)).map((n: any) => n.statement)).toContain('staging DB is pg16');

  // `/notes …` must stay an ordinary draft (no trigger without the space).
  await input.pressSequentially('/notes are great');
  await expect(mainWindow.getByText('Note to memory')).not.toBeVisible();
  await expect(input).toHaveValue('/notes are great');
  await input.fill('');

  // `//` mid-message must not trigger either.
  await input.pressSequentially('see https://example.com');
  await expect(mainWindow.getByText('Note to memory')).not.toBeVisible();
  await input.fill('');
});

test('Escape exits note mode without saving; the / menu enters it', async ({ mainWindow }) => {
  const input = composer(mainWindow);
  await input.pressSequentially('//not worth keeping');
  await expect(mainWindow.getByText('Note to memory')).toBeVisible();

  await input.press('Escape');
  await expect(mainWindow.getByText('Note to memory')).not.toBeVisible();
  // The body survives mode exit; nothing was written.
  await expect(input).toHaveValue('not worth keeping');
  expect(await readNotes(mainWindow)).toHaveLength(0);
  await input.fill('');

  // The discoverable route: pick it from the `/` menu, no prefix to remember.
  await input.pressSequentially('/no');
  await input.press('Enter');
  await expect(mainWindow.getByText('Note to memory')).toBeVisible();
  await expect(input).toHaveValue('');
  await input.press('Escape');
  await expect(mainWindow.getByText('Note to memory')).not.toBeVisible();
});

test('an empty note cannot be saved and credential-looking notes are refused', async ({ mainWindow }) => {
  const input = composer(mainWindow);
  // Bare prefix: note mode engages with an empty body; Enter must be a no-op.
  await input.pressSequentially('//');
  await expect(mainWindow.getByText('Note to memory')).toBeVisible();
  await input.press('Enter');
  await expect(mainWindow.getByText('Saved to memory')).not.toBeVisible();
  expect(await readNotes(mainWindow)).toHaveLength(0);

  // Credentials never reach the store; the mode + draft stay for rewording.
  await input.pressSequentially('my password is hunter2');
  await input.press('Enter');
  await expect(mainWindow.getByText('Looks like a credential — not saved')).toBeVisible();
  await expect(mainWindow.getByText('Note to memory')).toBeVisible();
  expect(await readNotes(mainWindow)).toHaveLength(0);
  await input.press('Escape');
  await input.fill('');
});

test('Quick Chat compact bar saves a note without starting a turn', async ({ electronApp, mainWindow }) => {
  const overlay = electronApp.windows().find((w) => w.url().includes('quickchat'));
  expect(overlay).toBeTruthy();
  const qcInput = overlay!.getByPlaceholder(/Ask Stem anything…|Save a note to memory…/);

  await qcInput.pressSequentially('/note quick chat note works');
  await expect(qcInput).toHaveValue('quick chat note works');
  await expect(overlay!.getByPlaceholder('Save a note to memory…')).toBeVisible();

  // First Escape leaves note mode (the overlay must NOT be dismissed logic-side:
  // the input keeps its body and reverts to the ask placeholder).
  await qcInput.press('Escape');
  await expect(overlay!.getByPlaceholder('Ask Stem anything…')).toBeVisible();
  await expect(qcInput).toHaveValue('quick chat note works');

  // Re-enter via the pill and save.
  await overlay!.getByRole('button', { name: 'Note', exact: true }).click();
  await qcInput.press('Enter');
  await expect(overlay!.getByText('Saved to memory')).toBeVisible();

  const notes = await readNotes(mainWindow);
  expect(notes.map((n: any) => n.statement)).toContain('quick chat note works');
  // No turn ran: the overlay is still the compact bar, not a conversation panel.
  await expect(overlay!.getByPlaceholder('Ask Stem anything…')).toBeVisible();
});
