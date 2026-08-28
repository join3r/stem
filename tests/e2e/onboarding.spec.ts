// Onboarding wizard — driven hermetically via the STEM_E2E_ONBOARDING seam:
// the faked backend starts unauthenticated, and the fake auth:providerLogin /
// auth:setApiKey handlers emit a scripted auth-url → done sequence and flip the
// status to authenticated (see src/server/index.ts). Exercises the wizard's full
// state machine without a browser, network, or real pi.
import { expect, launchApp, mainWindowOf, removeUserData } from './electron';
import { test as base } from '@playwright/test';

const test = base.extend<{ onboardingApp: Awaited<ReturnType<typeof launchApp>> }>({
  onboardingApp: async ({}, use) => {
    const launched = await launchApp({ env: { STEM_E2E: '1', STEM_E2E_ONBOARDING: '1' } });
    await use(launched);
    await launched.app.close().catch(() => {});
    removeUserData(launched.userDataDir);
  }
});

test('first run: welcome → ChatGPT OAuth → main app', async ({ onboardingApp }) => {
  const win = await mainWindowOf(onboardingApp.app);
  await win.waitForLoadState('domcontentloaded');

  // Welcome step (first run: onboarding.completed is false in the fresh store).
  await expect(win.getByText('Welcome to Stem')).toBeVisible();
  // The pitch is "your data stays on this machine", so it has to name the right
  // machine — calling a Linux box a Mac undercuts the very claim being made.
  await expect(
    win.getByText(process.platform === 'darwin' ? 'lives on your Mac' : 'lives on your computer')
  ).toBeVisible();
  await win.getByRole('button', { name: 'Get started' }).click();

  // Provider choice → fake OAuth (scripted auth-url + done events).
  await expect(win.getByRole('button', { name: 'Continue with Claude' })).toBeVisible();
  await win.getByRole('button', { name: 'Continue with ChatGPT' }).click();

  // The fake completes immediately; the wizard finishes and the app mounts.
  await expect(win.getByPlaceholder(/message/i).or(win.locator('.conversation'))).toBeVisible({ timeout: 15_000 });
});

// Grok is the one flow with no redirect: pi polls a device code while the user
// confirms it in the browser. If the code never reaches the UI the screen is just
// an indefinite "Waiting for your browser…", so assert it is on screen.
test('first run: Grok device-code sign-in shows the code', async ({ onboardingApp }) => {
  const win = await mainWindowOf(onboardingApp.app);
  await win.waitForLoadState('domcontentloaded');

  await win.getByRole('button', { name: 'Get started' }).click();
  await win.getByRole('button', { name: 'Continue with Grok' }).click();

  await expect(win.locator('.gate-code')).toHaveText('STEM-E2E1');
  await expect(win.locator('.conversation')).toBeVisible({ timeout: 15_000 });
});

test('first run: API key path reaches the main app', async ({ onboardingApp }) => {
  const win = await mainWindowOf(onboardingApp.app);
  await win.waitForLoadState('domcontentloaded');

  await win.getByRole('button', { name: 'Get started' }).click();
  await win.getByRole('button', { name: 'Use an API key instead' }).click();

  await expect(win.getByText('Use an API key')).toBeVisible();
  await win.locator('.gate-form input').fill('sk-test-abc');
  await win.getByRole('button', { name: 'Save key' }).click();

  await expect(win.locator('.conversation')).toBeVisible({ timeout: 15_000 });
});

// STEM_E2E_SESSION moves what isWaylandSession() reports without repointing
// Electron at a compositor, so this runs the real Wayland branch on an X11/xvfb
// runner.
test('first run on Wayland: wizard explains the Quick Chat summon command', async () => {
  // isWaylandSession() answers false off Linux before it ever reads the seam, so
  // there is no Wayland branch to exercise on the macOS runner.
  test.skip(process.platform !== 'linux', 'the Wayland summon step is a Linux-session branch');
  const launched = await launchApp({
    env: { STEM_E2E: '1', STEM_E2E_ONBOARDING: '1', STEM_E2E_SESSION: 'wayland' }
  });
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');

    await win.getByRole('button', { name: 'Get started' }).click();
    await win.getByRole('button', { name: 'Continue with ChatGPT' }).click();

    // Auth succeeds, but the wizard stops here instead of dropping straight into
    // the app — otherwise the shortcut silently never fires and Stem looks broken.
    await expect(win.getByText('One last step')).toBeVisible({ timeout: 15_000 });
    await expect(win.locator('.gate-cmd')).toContainText('--quick-chat');

    await win.getByRole('button', { name: 'Start using Stem' }).click();
    await expect(win.locator('.conversation')).toBeVisible({ timeout: 15_000 });
  } finally {
    await launched.app.close().catch(() => {});
    removeUserData(launched.userDataDir);
  }
});

test('plain STEM_E2E (authenticated) skips the wizard entirely', async () => {
  const launched = await launchApp(); // default seam: status ok immediately
  try {
    const win = await mainWindowOf(launched.app);
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('.conversation')).toBeVisible({ timeout: 15_000 });
    await expect(win.getByText('Welcome to Stem')).toHaveCount(0);
  } finally {
    await launched.app.close().catch(() => {});
    removeUserData(launched.userDataDir);
  }
});
