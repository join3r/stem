// Settings search, clicked for real: the field takes the focus when Settings is
// opened by hand, results come from the rendered rows (also the ⓘ text), and a
// result opens its sub-tab and any closed group around the row.
import { test, expect } from './electron';

test('opening Settings focuses the search, and a result jumps to its row', async ({ mainWindow: win }) => {
  await win.getByRole('button', { name: 'Settings', exact: true }).click();
  const field = win.getByRole('textbox', { name: 'Search settings' });
  await expect(field).toBeFocused();

  // A plain label match, on another sub-tab than the one open.
  await win.getByRole('button', { name: 'Server', exact: true }).click();
  await field.fill('chat width');
  const hit = win.locator('.set-search-hit', { hasText: 'Chat width' });
  await expect(hit).toBeVisible();
  await expect(hit.locator('.hit-place')).toHaveText('App › Appearance');
  await field.press('Enter');
  await expect(field).toHaveValue('');
  await expect(win.getByRole('button', { name: 'App', exact: true })).toHaveClass(/active/);
  await expect(win.locator('.set-vrow', { hasText: 'Chat width' })).toBeInViewport();
});

test('a match in the ⓘ text opens the closed group the row is in', async ({ mainWindow: win }) => {
  await win.getByRole('button', { name: 'Settings', exact: true }).click();
  const field = win.getByRole('textbox', { name: 'Search settings' });
  await field.fill('biggest saving');
  await expect(win.locator('.set-search-results .grp-head', { hasText: 'In explanations' })).toBeVisible();
  const hit = win.locator('.set-search-hit', { hasText: 'Quick tasks' }).first();
  await expect(hit.locator('.hit-place')).toHaveText('Models › Model roles › Quick tasks');
  await hit.click();

  await expect(win.getByRole('button', { name: 'Models', exact: true })).toHaveClass(/active/);
  const group = win.locator('.role-group-head', { hasText: 'Quick tasks' });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(win.locator('.role-group-body .set-sub', { hasText: 'Quick tasks' })).toBeInViewport();
});

test('Escape clears the search, then leaves the field', async ({ mainWindow: win }) => {
  await win.getByRole('button', { name: 'Settings', exact: true }).click();
  const field = win.getByRole('textbox', { name: 'Search settings' });
  await field.fill('zzzz-no-such-setting');
  await expect(win.getByText('No settings match', { exact: false })).toBeVisible({ timeout: 5000 });
  await field.press('Escape');
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  await field.press('Escape');
  await expect(field).not.toBeFocused();
});
