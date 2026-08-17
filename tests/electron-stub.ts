// Minimal `electron` stand-in for Vitest, now covering only what is left on the
// CLIENT side of the split. The server's own Electron needs — state paths, app
// version, the secret-key wrapper, worker forking, opening a browser — went
// through this stub until they became src/server/host, whose headless default IS
// the production implementation; tests/setup-unit.ts installs the couple of
// overrides (a reversible key wrapper, a pinned version) the suite wants.
//
// Nothing under src/server imports electron any more, so what remains here is
// exactly the src/desktop modules the unit suite exercises: platform.ts's `app`
// bookkeeping, the ipcMain registration in ipc-bridge.ts, and the application
// menu app-menu.ts installs.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const app = {
  // Per-process, like the STEM_* paths in setup-unit.ts: test files run in their
  // own forks, and a store two suites can delete under each other is a flake.
  getPath: (name: string) => join(tmpdir(), `stem-vitest-userdata-${process.pid}`, name),
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0',
  isPackaged: false,
  // platform.ts opts into Chromium's Linux global-shortcuts portal at startup.
  // `switches` is stub-only bookkeeping so tests can assert what was appended.
  commandLine: {
    switches: [] as Array<[string, string]>,
    appendSwitch(name: string, value?: string) {
      app.commandLine.switches.push([name, value ?? '']);
    }
  }
};

// ipc-bridge.ts registers invoke handlers through this fake; tests drive them via
// _invoke to exercise the sender/args guard end-to-end.
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const ipcHandlers = new Map<string, IpcHandler>();
export const ipcMain = {
  handle: (channel: string, handler: IpcHandler) => {
    ipcHandlers.set(channel, handler);
  },
  removeHandler: (channel: string) => {
    ipcHandlers.delete(channel);
  },
  on: (_channel: string, _handler: IpcHandler) => {},
  _invoke: (channel: string, event: unknown, ...args: unknown[]): unknown => {
    const handler = ipcHandlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(event, ...args);
  }
};

// app-menu.ts builds and installs the application menu through this fake; tests
// read _applicationMenu back to assert what Stem installed (notably: no close item).
type MenuTemplate = unknown[];
export const Menu = {
  _applicationMenu: null as MenuTemplate | null,
  buildFromTemplate: (template: MenuTemplate) => template,
  setApplicationMenu: (menu: MenuTemplate | null) => {
    Menu._applicationMenu = menu;
  }
};

export default { app, ipcMain, Menu };
