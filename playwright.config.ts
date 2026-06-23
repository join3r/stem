import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// E2E layer: launches the built Electron app (see tests/e2e/electron.ts) and
// drives it through Playwright. globalSetup builds dist/ first. Electron windows
// don't parallelize cleanly, so run serially with a single worker.
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: fileURLToPath(new URL('./tests/e2e/global-setup.ts', import.meta.url)),
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']]
});
