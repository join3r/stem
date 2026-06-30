// Real UI clicks through the Manage panel — reachable because the STEM_E2E seam
// (tests/e2e/electron.ts) reports a healthy backend, so the renderer mounts past
// the sign-in gate. These drive actual DOM, not the bridge: tab navigation, the
// empty-memory state, and a tidy-up preset that writes through to the store.
import { test, expect } from './electron';

test('opens the Memory tab and shows the empty state on a fresh workspace', async ({ mainWindow }) => {
  // The inspector is open by default; switch to the Memory tab (a toolbar button,
  // distinct from the Memory on/off switch which is role="switch").
  await mainWindow.getByRole('button', { name: 'Memory' }).click();

  // "Stored memory" is a collapsible section that starts collapsed; expand it
  // (the toggle button) to reveal the empty state.
  const toggle = mainWindow.getByRole('button', { name: /Stored memory/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(mainWindow.getByText('No memories stored yet', { exact: false })).toBeVisible();
});

test('a tidy-up preset click persists through to the memory settings', async ({ mainWindow }) => {
  await mainWindow.getByRole('button', { name: 'Memory' }).click();

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
