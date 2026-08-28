// Playwright + Electron harness. Launches the BUILT Stem app with fully isolated
// state (a throwaway userData dir + STEM_* store overrides), so tests never touch
// the real workspace, recall DB, or pi auth. Each test gets its own app instance.
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStemServer, type StemServerProcess } from './stem-server';
import type { ScheduledTask } from '../../src/shared/types';

// Launch via the project ROOT (not dist/main/index.js directly) so Electron
// resolves `main` from package.json AND app.getAppPath() returns the repo root.
// Pointing at the entry file makes getAppPath() = dist/main, which breaks the
// runtime's source-relative paths (e.g. the pi extension under src/server/pi).
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The real app opens three windows (main, Quick Chat overlay, HUD); only the
 *  overlay/HUD carry a `quickchat`/`hud` query flag. Pick the bare main window. */
export async function mainWindowOf(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 50; i++) {
    for (const win of app.windows()) {
      const url = win.url();
      if (url && !url.includes('quickchat') && !url.includes('hud')) return win;
    }
    await app.waitForEvent('window').catch(() => {});
  }
  throw new Error('main window never appeared');
}

/**
 * Open Settings and land on one of its sub-tabs. Settings remembers the last
 * sub-tab in localStorage, so a test that just clicked the rail icon could get
 * whichever pane the previous test left behind — naming the one you want is the
 * only way to be sure of what you are asserting against.
 */
export async function openSettings(
  win: Page,
  sub: 'Chat' | 'App' | 'Server' | 'Models'
): Promise<void> {
  await win.getByRole('button', { name: 'Settings', exact: true }).click();
  await win.getByRole('button', { name: sub, exact: true }).click();
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

export interface LaunchOptions {
  /** Tasks written to the isolated tasks.json BEFORE launch, so the scheduler
   *  loads them at start() — the only way to seed the subsystem (creation is
   *  otherwise driven by the assistant's tool through a live backend turn). */
  seedTasks?: ScheduledTask[];
  /** Partial settings written BEFORE launch, so the app starts as an existing
   *  install would (onboarding already done, a release-notes marker, …). Coerced
   *  by the stores on read, so a partial object is fine.
   *
   *  Written as ONE object even though it lands in two files: Phase 2 moved the
   *  Quick Chat hotkey, the overlay's visibility flags and the "what's new"
   *  marker into the client's own client.json, and splitAcrossStores below is
   *  where a spec stops having to care which is which. */
  seedSettings?: Record<string, unknown>;
  /** Force real/hermetic backend regardless of STEM_E2E_REAL (default: follow env). */
  real?: boolean;
  /** Extra env overrides for the launch. */
  env?: Record<string, string>;
  /** Extra argv for the launch (e.g. `--quick-chat` for the cold summon path). */
  extraArgs?: string[];
  /**
   * Start `stem-server` as a SEPARATE process against the same state dir and
   * point the app at it with STEM_SERVER_URL, instead of the app starting one
   * in-process. Two processes, one machine — the Phase 1 definition of done.
   * See tests/e2e/stem-server.ts and external-server.spec.ts.
   */
  externalServer?: boolean;
  /**
   * Reuse an existing state dir instead of minting a throwaway one — i.e. launch
   * the app AGAIN, as the same install, with everything the previous run wrote
   * still on disk. The offline spec needs it: what a client keeps for the train
   * is only worth anything across a relaunch, and a cache proved by the process
   * that filled it is not proved at all.
   */
  userDataDir?: string;
}

export interface LaunchedApp {
  app: ElectronApplication;
  userDataDir: string;
  tasksStorePath: string;
  settingsStorePath: string;
  /** client.json: this machine's identity and the settings that belong to it. */
  clientStorePath: string;
  /** The separately-started server, when `externalServer` asked for one. */
  server: StemServerProcess | null;
}

/** The Quick Chat fields a machine owns — see ClientSettings in shared/types.ts. */
const CLIENT_QUICK_CHAT_KEYS = ['shortcut', 'showOnAllDisplays', 'followAcrossSpaces'];

/**
 * Sort a seed into the file that will actually be read for each key. Mirrors
 * src/desktop/settings.ts, and deliberately keeps the seed's own shape: a spec
 * says what an install looks like, not where Stem happens to keep it.
 */
function splitAcrossStores(seed: Record<string, unknown>): {
  server: Record<string, unknown>;
  client: Record<string, unknown> | null;
} {
  const { quickChat, releaseNotes, ...rest } = seed as {
    quickChat?: Record<string, unknown>;
    releaseNotes?: unknown;
  };
  const server: Record<string, unknown> = { ...rest };
  const clientQuickChat: Record<string, unknown> = {};
  if (quickChat) {
    const serverQuickChat: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(quickChat)) {
      if (CLIENT_QUICK_CHAT_KEYS.includes(k)) clientQuickChat[k] = v;
      else serverQuickChat[k] = v;
    }
    if (Object.keys(serverQuickChat).length) server.quickChat = serverQuickChat;
  }
  const client: Record<string, unknown> = {};
  if (Object.keys(clientQuickChat).length) client.quickChat = clientQuickChat;
  if (releaseNotes !== undefined) client.releaseNotes = releaseNotes;
  return { server, client: Object.keys(client).length ? client : null };
}

/** Launch the built app with fully isolated state. Seeds the tasks store first
 *  when `seedTasks` is given. Caller is responsible for app.close() + cleanup
 *  (the `electronApp` fixture does this automatically; standalone callers use
 *  the returned dir). */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'stem-e2e-'));
  const tasksStorePath = join(userDataDir, 'tasks.json');
  const settingsStore = join(userDataDir, 'settings.json');
  const clientStore = join(userDataDir, 'client.json');
  if (opts.seedTasks) {
    writeFileSync(tasksStorePath, JSON.stringify({ version: 1, tasks: opts.seedTasks }, null, 2));
  }
  if (opts.seedSettings) {
    const { server: serverSeed, client: clientSeed } = splitAcrossStores(opts.seedSettings);
    writeFileSync(settingsStore, JSON.stringify(serverSeed, null, 2));
    // A `settings` block present is also what tells the client it has nothing to
    // migrate out of settings.json, so a seeded value is never second-guessed.
    if (clientSeed) writeFileSync(clientStore, JSON.stringify({ version: 1, settings: clientSeed }, null, 2));
  }
  const real = opts.real ?? REAL_BACKEND;
  // Isolate the Stem-owned stores onto throwaway paths (same seam the unit tests
  // and the old probes use). Hoisted out of the env literal because an external
  // server has to be given the identical set — the two processes are only one
  // Stem if they agree about where every store lives.
  const storeEnv = {
    STEM_RECALL_DB: join(userDataDir, 'recall.sqlite'),
    STEM_FILES_DIR: join(userDataDir, 'files'),
    STEM_TASKS_STORE: tasksStorePath
  };
  // Started BEFORE the app, which connects as its first act. It prints a pairing
  // code on a fresh state root, and the app is handed that instead of being left
  // to mint itself a record off the shared disk — so this configuration exercises
  // the credential path a genuinely remote client will take.
  const server = opts.externalServer
    ? await startStemServer({ stateDir: userDataDir, storeEnv, real })
    : null;
  const app = await electron.launch({
    args: [PROJECT_ROOT, `--user-data-dir=${userDataDir}`, ...(opts.extraArgs ?? [])],
    env: {
      ...process.env,
      ...storeEnv,
      ...(server ? { STEM_SERVER_URL: server.url } : {}),
      ...(server?.pairingCode ? { STEM_PAIRING_CODE: server.pairingCode } : {}),
      // macOS: run the instance as a non-activating accessory app so a suite
      // that launches one Electron per spec never steals focus or yanks the
      // user to the Space the run started on (see BACKGROUND in desktop/index.ts).
      // Deliberately outside the STEM_E2E branch — real-backend runs need it most.
      STEM_BACKGROUND: '1',
      // Downloads land here rather than in the real ~/Downloads. A suite that
      // litters the machine it runs on is a suite people stop running.
      STEM_DOWNLOADS_DIR: join(userDataDir, 'downloads'),
      // Default: report a healthy backend without spawning pi, so tests reach
      // the real UI past the sign-in gate (see the STEM_E2E seam in
      // src/server/index.ts). In real-backend mode the seam is off and pi runs.
      ...(real ? {} : { STEM_E2E: '1' }),
      // Pin the session type the app *reports*, without touching the env vars
      // Chromium uses to pick its display backend (see isWaylandSession). Wayland
      // drives real UI — the onboarding wizard adds a Quick Chat step there — so
      // leaving this to the developer's desktop would mean the same spec passes
      // on CI and fails on a Wayland machine. Specs wanting the Wayland path
      // override it via opts.env.
      STEM_E2E_SESSION: 'x11',
      ...opts.env
    }
  });
  return {
    app,
    userDataDir,
    tasksStorePath,
    settingsStorePath: settingsStore,
    clientStorePath: clientStore,
    server
  };
}

/**
 * Tear a launched app down: the window, then the server it was talking to (in
 * that order — killing the server first turns every in-flight RPC into an
 * "unreachable" the app would log on its way out), then the state dir. Errors
 * are swallowed: a cleanup that throws replaces a real failure with its own.
 */
/**
 * Delete a test's throwaway userData dir. The app's close() can resolve while
 * the main process is still flushing its stores, so a bare rmSync races those
 * writes and dies with ENOTEMPTY; the retries absorb the last flush.
 */
export function removeUserData(userDataDir: string): void {
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  await launched.app.close().catch(() => {});
  await launched.server?.stop().catch(() => {});
  removeUserData(launched.userDataDir);
}

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    const { app, userDataDir } = await launchApp();
    await use(app);
    await app.close().catch(() => {});
    removeUserData(userDataDir);
  },
  mainWindow: async ({ electronApp }, use) => {
    const win = await mainWindowOf(electronApp);
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  }
});

export const expect = test.expect;
