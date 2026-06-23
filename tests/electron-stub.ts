// Minimal `electron` stand-in for Vitest. The main-process modules under test
// (workspace/paths, files/store, …) import a couple of Electron symbols at load
// time, but the code paths the unit tests exercise never actually touch them —
// paths.ts only calls app.getPath() when the STEM_* env overrides are unset (the
// setup file always sets them), and shell is only used by revealFiles().
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const app = {
  getPath: (name: string) => join(tmpdir(), 'stem-vitest-userdata', name),
  getAppPath: () => process.cwd()
};

export const shell = {
  showItemInFolder: () => {},
  openPath: async () => ''
};

export default { app, shell };
