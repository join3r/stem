// Playwright + Electron harness. Launches the BUILT Stem app with fully isolated
// state (a throwaway userData dir + STEM_* store overrides), so tests never touch
// the real workspace, recall DB, or pi auth. Each test gets its own app instance.
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Launch via the project ROOT (not dist/main/index.js directly) so Electron
// resolves `main` from package.json AND app.getAppPath() returns the repo root.
// Pointing at the entry file makes getAppPath() = dist/main, which breaks the
// runtime's source-relative paths (e.g. the pi extension under src/main/pi).
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The real app opens three windows (main, Quick Chat overlay, HUD); only the
 *  overlay/HUD carry a `quickchat`/`hud` query flag. Pick the bare main window. */
async function mainWindowOf(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 50; i++) {
    for (const win of app.windows()) {
      const url = win.url();
      if (url && !url.includes('quickchat') && !url.includes('hud')) return win;
    }
    await app.waitForEvent('window').catch(() => {});
  }
  throw new Error('main window never appeared');
}

type Fixtures = {
  electronApp: ElectronApplication;
  mainWindow: Page;
};

// Real-backend mode: when STEM_E2E_REAL is set, DON'T fake the backend. The
// throwaway pi-home auto-seeds auth.json from the user's global ~/.pi/agent
// (see ensurePiHome in runtime.ts), so pi runs for real with existing auth —
// no separate login. Off by default: real turns hit the network + Claude Max
// quota and are non-deterministic, so CI uses the hermetic STEM_E2E seam.
export const REAL_BACKEND = !!process.env.STEM_E2E_REAL;

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'stem-e2e-'));
    const app = await electron.launch({
      args: [PROJECT_ROOT, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        // Isolate the Stem-owned stores onto throwaway paths (same seam the unit
        // tests and the old probes use).
        STEM_RECALL_DB: join(userDataDir, 'recall.sqlite'),
        STEM_FILES_DIR: join(userDataDir, 'files'),
        // Default: report a healthy backend without spawning pi, so tests reach
        // the real UI past the sign-in gate (see the STEM_E2E seam in
        // src/main/index.ts). In real-backend mode the seam is off and pi runs.
        ...(REAL_BACKEND ? {} : { STEM_E2E: '1' })
      }
    });
    await use(app);
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  },
  mainWindow: async ({ electronApp }, use) => {
    const win = await mainWindowOf(electronApp);
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  }
});

export const expect = test.expect;
