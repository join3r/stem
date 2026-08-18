// Settings → Devices, clicked for real: the list of what can reach this Stem,
// and the only way to admit something new.
//
// The DOM-level facts a unit test cannot reach are the two safety properties.
// The device you are sitting at must not offer to withdraw itself — doing so
// would sign you out of the machine you are using, with no way back in short of
// a pairing code you cannot ask for any more. And a pairing code must actually
// appear on screen: it is said once, so a code that is minted but not displayed
// is a code that is lost.
import { test, expect, openSettings } from './electron';

test('lists this device and refuses to let you withdraw the one you are using', async ({ mainWindow }) => {
  await openSettings(mainWindow, 'Server');

  // The embedded server minted this machine a record at startup, so there is
  // exactly one row and it is us.
  const row = mainWindow.locator('.set-row', { hasText: 'this device' });
  await expect(row).toBeVisible();

  const withdraw = row.getByRole('button', { name: 'Withdraw' });
  await expect(withdraw).toBeVisible();
  await expect(withdraw).toBeDisabled();
});

test('a pairing code is shown, once, with what it is for', async ({ mainWindow }) => {
  await openSettings(mainWindow, 'Server');

  await mainWindow.getByLabel('What to call the new device').fill('Work laptop');
  await mainWindow.getByRole('button', { name: 'Get a code' }).click();

  // Grouped and drawn from an alphabet with no character that can be misheard.
  // Looked for where a code is said — the form that minted it — and matched
  // whole rather than as a substring: a machine's own name is on this screen
  // too, and a hostname like `iad20-fj917-a2b9dc00-9243-8874` holds something
  // code-shaped without being a code.
  const form = mainWindow.locator('form.set-block');
  await expect(form.getByText(/^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/)).toBeVisible();
  // …and the pairing it belongs to is listed as outstanding until it is spent.
  await expect(mainWindow.locator('.set-row', { hasText: 'Work laptop' })).toBeVisible();
});
