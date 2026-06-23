// Real-backend smoke — runs ONLY when STEM_E2E_REAL is set (otherwise skipped).
// Proves the full pi path works with the existing global auth (auto-seeded into
// the throwaway pi-home), using cheap RPCs — no model completion, so no quota
// burn. Run with: STEM_E2E_REAL=1 npm run test:e2e
import { test, expect, REAL_BACKEND } from './electron';

test.describe('real pi backend', () => {
  test.skip(!REAL_BACKEND, 'set STEM_E2E_REAL=1 to run against real pi');

  // Spawning + handshaking a real pi process is slower than the faked path.
  test.slow();

  test('reports authenticated via the seeded global auth', async ({ mainWindow }) => {
    const status = await mainWindow.evaluate(() => (window as any).stem.runtimeStatus());
    expect(status.ok).toBe(true);
    expect(status.authenticated).toBe(true);
  });

  test('lists models over a real pi RPC', async ({ mainWindow }) => {
    const models = await mainWindow.evaluate(() => (window as any).stem.listModels());
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  // Full turn-taking path: type → send → backend spawns pi → model streams a
  // reply → it renders. Asks for a fixed token so the assertion is stable. This
  // one DOES cost a (tiny) model completion, hence real-mode-only + long timeout.
  test('completes a real turn and renders a streamed reply', async ({ mainWindow }) => {
    test.setTimeout(120_000);

    const composer = mainWindow.getByPlaceholder('Ask Stem…');
    await composer.click();
    await composer.fill('Reply with exactly the single word PONG in uppercase and nothing else.');
    await composer.press('Enter');

    // The user bubble lands immediately (Enter sends).
    await expect(mainWindow.locator('.message-user').last()).toBeVisible();

    // The assistant reply bubble (not the thinking activity-row) streams in and
    // renders the requested token. Generous timeout: first turn also spawns pi.
    const reply = mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last();
    await expect(reply).toContainText(/pong/i, { timeout: 100_000 });
  });
});
