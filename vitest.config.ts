import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit/integration layer: runs the REAL main-process modules under Node, with a
// tiny `electron` stub so they import cleanly outside the Electron runtime.
// `forks` pool gives each test file its own process — needed for node:sqlite and
// for the per-process throwaway DB path in setup-unit.ts.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup-unit.ts'],
    pool: 'forks',
    environment: 'node'
  },
  resolve: {
    alias: {
      electron: fileURLToPath(new URL('./tests/electron-stub.ts', import.meta.url))
    }
  }
});
