import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  session,
  shell
} from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { installAppMenu } from './app-menu';
import { electronHost } from './host';
import { setHost } from '../server/host';
import { startServer, type ServerHandle } from '../server';
import { log } from '../server/log';
import { resolveProfileOverride } from '../server/workspace/paths';
import { bindServerChannels } from './ipc-bridge';
import { registerLocalIpc } from './local';
import { createMcpHost, type McpHost } from './mcp-host';
import { createExecHost, type ExecHost } from './exec-host';
import { createOAuthCourier, type OAuthCourier } from './oauth-courier';
import { enableGlobalShortcutPortal, isLinux, isMac, mainWindowChromeOptions, requestAttention } from './platform';
import { createPresenceHeartbeat, type PresenceHeartbeat } from './presence';
import { createServerProxy, type ServerProxy } from './proxy';
import { clientCredentials, resolveServerUrl } from './server-endpoint';
import { readClientSettings, seedReleaseNotesMarker } from './settings';
import { createUpdates } from './updates';
import { createQuickChat } from './quickchat';
import { loadRenderer, PRELOAD_SCRIPT } from './renderer-assets';
import { initTray } from './tray';
import { RendererPushQueue } from './ui-lifecycle';
import type { AppSettings } from '../shared/types';

// The Electron main process: windows, tray, the global shortcut, and app
// lifecycle. It owns nothing about chats, memory, skills or settings — it starts
// a server (src/server) and then talks to it over HTTP/SSE like any other client,
// through src/desktop/proxy.ts.
//
// Unless STEM_SERVER_URL says otherwise, in which case it starts nothing and
// connects to whatever is already running there. That the two cases differ by one
// `if` is the whole point of the split; everything past this file is identical.
//
// The dependency runs one way only. This file imports the server; nothing under
// src/server imports anything here. That rule is what makes a headless
// `stem-server` process possible, and the point of the whole split.

// Brand the app rather than inheriting Electron's defaults. setName fixes the
// app/process name and userData path; appIcon drives the dock (and, off macOS,
// the window) icon. Note: in dev the macOS menu-bar title still reads
// "Electron" — that comes from the Electron.app bundle and only changes when
// the app is packaged.
app.setName('Stem');

// Background (E2E) mode: keep a test run out of the way of whoever is using the
// machine. On macOS a launching regular app makes itself frontmost, and when it
// quits AppKit hands activation back to the previously-active app — so a suite
// that launches and closes one instance per spec repeatedly drags the user's
// screen to the Space the run started on. The accessory policy makes the app
// non-activating (and dock-less), so it never takes or hands back activation.
// Windows still open, render, and drive over CDP; they just surface with
// orderFrontRegardless (showInactive) instead of makeKeyAndOrderFront, which
// AppKit refuses for an inactive app.
//
// macOS-only by construction, and set by launchApp() (tests/e2e/electron.ts)
// rather than derived from STEM_E2E: that flag is off in real-backend mode,
// which is exactly when runs are long enough for this to matter.
const BACKGROUND = isMac && !!process.env.STEM_BACKGROUND;
if (BACKGROUND) app.setActivationPolicy('accessory');

// Install the Electron half of the host shim before anything reads a
// userData-derived path, forks a worker, or touches a secret. Everything the
// server needs from its host now goes through this one seam (src/server/host);
// headless it falls back to plain-Node defaults.
setHost(electronHost());

// Alternate profiles: `--fresh` / `--profile=<name>` (or STEM_FRESH=1 / STEM_PROFILE=<name>)
// relocate ALL app state to an isolated userData dir under a sibling "Stem Profiles/"
// container, so the first-run onboarding can be walked as a brand-new user without touching
// the real signed-in profile. Must run before anything reads a userData-derived path (all of
// paths.ts is lazy and only fires after whenReady, so here is early enough). Resolved
// exactly once — `--fresh` mints a timestamped label, so a second call would
// disagree with the first.
const profileOverride = resolveProfileOverride();
const activeProfileLabel = profileOverride?.label ?? null;
if (profileOverride) {
  mkdirSync(profileOverride.userDataDir, { recursive: true });
  app.setPath('userData', profileOverride.userDataDir);
  console.log(
    `[stem] profile "${profileOverride.label}" → userData ${profileOverride.userDataDir}`
  );
}

// One Stem per profile. A second launch hands its argv to the running instance
// and exits: `stem --quick-chat` toggles the overlay (the summon path for
// Wayland, where Electron's globalShortcut never fires — users bind a DE
// shortcut to this command), a plain `stem` reveals the main window (the
// reopen path on Linux, where the app keeps running after the main window
// closes and stock GNOME hides the tray). Must run after the profile override
// so the lock keys off the final userData path (isolated E2E/profile runs
// never deflect each other).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
app.on('second-instance', (_event, argv) => {
  // Ignore launches racing the whenReady bootstrap (windows not created yet).
  if (!windowsReady) return;
  if (argv.includes('--quick-chat')) quickChat.toggle();
  else revealMainWindow();
});

const appIcon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'));

// In dev, expose a CDP port so tooling (agent-browser) can attach to the UI.
// 9222 is Chrome's own remote-debugging default — the chrome-cdp skill uses it
// on the user's local Chrome — so binding it here fails with EADDRINUSE and
// stderr-spams the terminal. Use 9224 instead: reserved for Stem's dev CDP,
// no collision with Chrome or Chromium-based tooling that camps 9222/9223.
// The port isn't functionally load-bearing; a stray collision only loses
// attach-for-tooling. Attach with --port=9224 or STEM_DEVTOOLS_PORT.
if (process.env.ELECTRON_RENDERER_URL) {
  const port = process.env.STEM_DEVTOOLS_PORT ?? '9224';
  app.commandLine.appendSwitch('remote-debugging-port', port);
}

// Global shortcuts through the XDG portal on Linux — the only path that works in
// a Wayland session. Must be set here: switches are read at Chromium startup.
enableGlobalShortcutPortal();

// Test seam: when STEM_E2E is set the server swaps in the hermetic FakeBackend.
// On this side it only suppresses the tray, to keep the harness's window/process
// accounting deterministic.
const E2E = !!process.env.STEM_E2E;

// ---- navigation ----

const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function openExternalUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) return;
    void shell.openExternal(parsed.toString()).catch(() => undefined);
  } catch {
    // Ignore malformed renderer-provided URLs.
  }
}

function isAppNavigation(win: BrowserWindow, url: string): boolean {
  const current = win.webContents.getURL();
  if (!current) return false;
  try {
    const next = new URL(url);
    const cur = new URL(current);
    if (next.href === cur.href) return true;
    if (cur.protocol === 'file:' && next.protocol === 'file:' && next.pathname === cur.pathname) return true;
    return !!process.env.ELECTRON_RENDERER_URL && next.origin === cur.origin;
  } catch {
    return false;
  }
}

function installNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppNavigation(win, url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
}

// ---- the main window ----

let mainWindow: BrowserWindow | null = null;
const mainPushQueue = new RendererPushQueue();
/** True once the persistent windows exist — see the second-instance handler. */
let windowsReady = false;

// True for the brief window around summoning the overlay. Showing the overlay
// activates the app, which fires `app.on('activate')`; without this guard that
// handler would recreate a previously-closed main window (and macOS would surface
// it), so summoning Quick Chat would "also open the main app."
let summoningOverlay = false;

/**
 * Create the main window. `hidden` is for a cold `stem --quick-chat` launch (the
 * DE-bound summon path): the window still loads — the backend prewarm and every
 * push destination hang off it — but the user only sees the overlay they asked
 * for. The tray's "Open Stem", a plain `stem`, or activation reveals it.
 */
function createWindow(hidden = false): void {
  mainPushQueue.reset();
  mainWindow = new BrowserWindow({
    // In BACKGROUND mode we surface it ourselves, without activating (below).
    show: !hidden && !BACKGROUND,
    width: 1200,
    height: 820,
    // Surfaces in the macOS Window menu / Mission Control when running an alternate profile.
    title: activeProfileLabel ? `Stem — ${activeProfileLabel}` : 'Stem',
    // Inset traffic lights on macOS; the native frame elsewhere.
    ...mainWindowChromeOptions(),
    icon: appIcon,
    // Match the toolbar/chrome color so first paint doesn't flash; follows
    // the system appearance (the renderer adapts via prefers-color-scheme).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1916' : '#efece5',
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (BACKGROUND && !hidden) mainWindow.showInactive();

  installNavigationGuards(mainWindow);

  // The renderer's HTML <title>Stem</title> otherwise clobbers the window title on
  // load; when running an alternate profile, keep the label pinned so the demo
  // window stays distinguishable in the macOS Window menu / Mission Control.
  if (activeProfileLabel) {
    const titled = mainWindow;
    titled.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      titled.setTitle(`Stem — ${activeProfileLabel}`);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    mainPushQueue.reset();
  });

  // Follow-me pill: surface a running main-window thread's progress when you leave
  // the main window (switch Spaces/apps), and dismiss it when you return.
  mainWindow.on('blur', () => quickChat.syncMainHud());
  mainWindow.on('focus', () => quickChat.hideMainHud());
  // Clear the taskbar/urgency flash raised by requestAttention (no-op on macOS,
  // where attention is a dock bounce that clears itself).
  if (!isMac) {
    const flashed = mainWindow;
    flashed.on('focus', () => {
      if (!flashed.isDestroyed()) flashed.flashFrame(false);
    });
  }

  loadRenderer(mainWindow);
}

/** Send to the main window, deferring until React has registered its IPC
 * subscriptions (a recreated BrowserWindow can finish loading before effects run). */
function sendToMain(channel: string, payload: unknown): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  for (const message of mainPushQueue.push({ channel, payload })) {
    win.webContents.send(message.channel, message.payload);
  }
}

/** Bring the main window to the front (recreating it if it was closed). */
function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  // Never activate in background mode — revealing is what the specs exercise;
  // stealing the user's Space is not.
  if (BACKGROUND) {
    win.showInactive();
    return;
  }
  win.show();
  win.focus();
}

// Whether a newer release exists and what this install can do about it — see
// desktop/updates.ts for the auto/manual/none split. Status changes ride the
// main window's push queue like any server event, so one arriving during
// bootstrap waits for React rather than falling on the floor.
const updates = createUpdates({
  send: (status) => sendToMain('updates:status', status),
  openExternal: openExternalUrl
});

const quickChat = createQuickChat({
  mainWindow: () => mainWindow,
  sendToMain,
  revealMainWindow,
  installNavigationGuards,
  // Late-bound: the proxy only exists once the server (embedded or external) has
  // answered, and Quick Chat is created before any of that.
  invoke: (channel, args) => proxy!.invoke(channel, args),
  beginSummon: () => {
    // Cleared on the next tick, after the activation has been handled.
    summoningOverlay = true;
    setImmediate(() => {
      summoningOverlay = false;
    });
  }
});

// Last-resort diagnostics: an uncaught throw or rejection otherwise vanishes with
// the console. Log-and-continue — Electron's default for unhandledRejection is a
// warning, and killing the process over a background hiccup (a failed distill, a
// dropped watcher) would take the whole app down.
process.on('uncaughtException', (e) => {
  log('main', 'uncaughtException', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
});
process.on('unhandledRejection', (reason) => {
  log('main', 'unhandledRejection', {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  });
});

let server: ServerHandle | null = null;
let proxy: ServerProxy | null = null;
let oauthCourier: OAuthCourier | null = null;
let presence: PresenceHeartbeat | null = null;
let mcpHost: McpHost | null = null;
let execHost: ExecHost | null = null;

/**
 * Whether the server is answering, as last reported by the proxy. Kept here
 * rather than only pushed because the first transition can happen before there
 * is a window to push to — a launch on a train discovers it is offline while
 * fetching the channel list, which is the very first thing a launch does. So the
 * windows ask (`client:connection`) and are then told (`client:connectionChanged`).
 */
let serverReachable = true;

app.whenReady().then(async () => {
  // Strict CSP for the renderer in production: only self, no remote/inline
  // script. Skipped in dev so the Vite dev server / HMR can run. Installed
  // before any window is created, so nothing can load without it.
  if (!process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"]
        }
      });
    });
  }

  if (process.platform === 'darwin' && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon);
  }

  // Stem's own menu, which is the stock one minus Close Window — no ⌘W closing
  // the app's only window (or the Quick Chat overlay, which never comes back).
  // See app-menu.ts.
  installAppMenu();

  // Take this machine's own settings out of settings.json before anything can
  // rewrite that file without them. The migration runs exactly once and this is
  // the moment it has to happen by: the server sheds those keys on its next
  // write, and its next write can be triggered by anything from here on.
  await readClientSettings();

  // Embedded by default: the server runs in this process, on its own loopback
  // socket, and we are its first client. An address from STEM_SERVER_URL or from
  // Settings → Server points at one that is already running instead, and then we
  // start nothing — same client code from the next line on, one fewer process to
  // own.
  const configured = await resolveServerUrl();
  let serverUrl: string;
  if (configured.url) {
    serverUrl = configured.url;
  } else {
    server = await startServer({
      alternateProfile: !!profileOverride,
      devUrl: process.env.ELECTRON_RENDERER_URL ?? null
    });
    // A server we started ourselves always takes a loopback port; the socket
    // bind exists for the container, where the only client is a reverse proxy.
    // Saying so beats a null dereference three frames later.
    if (!server.endpoint.url) {
      throw new Error(
        'STEM_SERVER_SOCKET makes the server listen on a Unix socket, which only a proxy can reach — ' +
          'the app cannot use its own embedded server that way. Unset it, or point Stem at a server ' +
          'in Settings → Server.'
      );
    }
    serverUrl = server.endpoint.url;
  }
  // The server publishes where it listens, never a credential — this client
  // holds its own (client.json), minting or pairing for one on first run.
  const endpoint = await clientCredentials(serverUrl, { external: !!configured.url });

  // A sign-in that ends in a browser ends in a browser HERE. When the server is
  // somebody else's process the loopback address it redirects to is this
  // machine's, not its own, so the callback has to be caught here and carried
  // back; when Stem started the server itself there is nothing to carry, and the
  // courier stays out of the way (src/desktop/oauth-courier.ts).
  oauthCourier = createOAuthCourier({
    enabled: !!configured.url,
    deliver: (redirectUri, params) => proxy!.invoke('auth:deliverCallback', [redirectUri, params]),
    openExternal: openExternalUrl
  });

  // The MCP servers pinned to THIS machine (docs/mcp-device-pinning.md). It
  // talks to the server through the proxy, and the proxy hands it every
  // addressed request off the event stream — so each is constructed with a
  // late-bound reference to the other, which is why `invoke` is a closure and
  // not the proxy itself.
  mcpHost = createMcpHost({
    invoke: (channel, args) => proxy!.invoke(channel, args),
    changed: (state) => sendToMain('mcpHost:changed', state)
  });

  // The commands the server addresses to THIS machine (run_command's `device`
  // target). Same late-bound relationship with the proxy as the MCP host's, and
  // the same off-by-default posture: until the switch in Settings is flipped on
  // this computer, every request is refused here whatever the server believes.
  execHost = createExecHost({
    invoke: (channel, args) => proxy!.invoke(channel, args)
  });

  proxy = createServerProxy({
    ...endpoint,
    // The one `if` above decides this too: a server we did not start is a server
    // that may not share this disk, and paths stop meaning anything to it.
    remote: !server,
    oauthCourier,
    mcpHost,
    execHost,
    sendToMain,
    sendToOverlay: (channel, payload) => quickChat.sendToOverlay(channel, payload),
    revealIfOwns: (threadId) => quickChat.revealIfOwns(threadId),
    routeBackendEvent: (event) => void quickChat.routeBackendEvent(event),
    revealMainWindow,
    requestAttention: () => requestAttention(mainWindow),
    threadOpened: (threadId) => quickChat.threadOpened(threadId),
    applyQuickChatSettings: (patch, next) => quickChat.applySettings(patch, next),
    // Both of these are decided in the window, not here: the main process does
    // not know which thread is open, and has no state of its own to correct.
    // They go through the push queue like any other server event, so one arriving
    // during bootstrap waits for React rather than falling on the floor.
    resync: () => sendToMain('client:resync', undefined),
    liveTurns: (turns) => sendToMain('client:liveTurns', turns),
    // Both windows compose, so both have to stop composing. The overlay is not
    // on the push queue's path (it is created up front and only ever hidden), so
    // it is sent to directly.
    connection: (reachable) => {
      serverReachable = reachable;
      sendToMain('client:connectionChanged', reachable);
      quickChat.sendToOverlay('client:connectionChanged', reachable);
      // A server that went away and came back may have gained, lost or edited a
      // server pinned here while we could not hear about it. Asking again is
      // cheap — a spec that has not moved keeps the connection it already has.
      if (reachable) void mcpHost?.refresh();
      // Re-announce whether this machine runs commands: the server may have
      // restarted and an announcement is the only way it learns.
      if (reachable) void execHost?.refresh();
    }
  });
  // Subscribe before any window exists, so nothing the server pushes during
  // bootstrap falls on the floor — there is no replay to recover it with.
  const channels = await proxy.start();

  // Everything the renderer can invoke, bound to ipcMain: every channel the
  // server says it answers, plus this machine's own handlers. Before any window
  // exists, so no renderer can race a missing channel.
  registerLocalIpc({
    mainWindow: () => mainWindow,
    connection: () => ({ serverUrl, remote: !server, pinnedByEnv: configured.pinnedByEnv }),
    reachable: () => serverReachable,
    credentials: () => endpoint,
    settings: () => proxy!.invoke('settings:get', []) as Promise<AppSettings>,
    updates,
    mcpHost,
    execHost
  });
  quickChat.registerIpc();
  ipcMain.on('renderer:ready', (event) => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    for (const { channel, payload } of mainPushQueue.markReady()) win.webContents.send(channel, payload);
  });
  bindServerChannels(channels, (channel, args) => proxy!.invoke(channel, args));

  const settings = (await proxy.invoke('settings:get', [])) as AppSettings;
  // An install that has not been set up yet is owed no release notes: whatever
  // it is running is the first version this person has ever had here. Done now,
  // before any window can ask, and NOT when the wizard finishes — the wizard is
  // not the only way onboarding completes (auth adopted from an existing ~/.pi
  // counts it done during prewarm, with nobody clicking anything).
  if (!settings.onboarding.completed) await seedReleaseNotesMarker();

  // A cold `stem --quick-chat` must land on the overlay, not the main window:
  // that command IS the shortcut on Wayland (see the second-instance handler),
  // and pressing it with Stem closed should feel the same as pressing it with
  // Stem running. The overlay is summoned once it exists, below.
  const coldSummon = process.argv.includes('--quick-chat');
  createWindow(coldSummon);
  // Eagerly spawn pi + connect MCP once the window has painted, so the first prompt
  // doesn't pay backend cold-start. did-finish-load keeps the spawn + MCP child
  // processes off the first-paint path. Fire-and-forget; races harmlessly with the
  // renderer's listModels warm.
  // Only for a server we started: an external one warms itself when it feels
  // like it, and there is no channel to ask (prewarm is a lever for a host, not
  // something an authenticated client should be able to trigger).
  mainWindow?.webContents.once('did-finish-load', () => {
    void server?.prewarm();
    // The same bargain, for the MCP servers pinned to this machine: everything
    // already approved here connects now rather than on first use (⑥), and it
    // waits for the first paint for the same reason the prewarm does — these are
    // child processes too. Unapproved specs start nothing and raise nothing;
    // they wait in the Manage panel.
    void mcpHost?.start();
    void execHost?.start();
  });

  quickChat.start(settings.quickChat);
  // After the windows exist and the first prompt's warm-up is on its way; the
  // first check waits a further beat inside (FIRST_CHECK_DELAY_MS).
  updates.start();

  // Tell the server somebody is at this machine, so it doesn't wake a phone for
  // something already on screen here. Over the proxy like every other call, which
  // is what makes it work identically against the server in this process and one
  // across the internet — and what makes the report carry this client's identity,
  // since the far side takes the device from the bearer token and not from us.
  presence = createPresenceHeartbeat({
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    report: (idleSeconds) => proxy!.invoke('devices:presence', [idleSeconds])
  });
  presence.start();
  windowsReady = true;
  if (coldSummon) quickChat.toggle();
  // Linux-only for now: the tray is the discoverable summon/quit affordance where
  // there's no dock and (on Wayland) no working global shortcut. Skipped under
  // STEM_E2E to keep the harness's window/process accounting deterministic.
  if (isLinux && !E2E) {
    initTray({
      icon: appIcon,
      onToggleQuickChat: () => quickChat.toggle(),
      onOpenStem: revealMainWindow
    });
  }

  app.on('activate', () => {
    // Don't recreate the main window when the activation was triggered by summoning
    // the Quick Chat overlay — that would reopen a closed main window unbidden.
    if (summoningOverlay || quickChat.overlayVisible()) return;
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
}).catch((error) => {
  console.error('Failed to start Stem:', error);
  app.quit();
});

// Shut the server down gracefully before quitting. preventDefault + await gives
// it a window to drain in-flight work, then we exit for real (shutdown has its
// own SIGKILL backstop).
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  updates.close();
  presence?.close();
  proxy?.close();
  oauthCourier?.close();
  // Before the early return below: an MCP server pinned here is a child of THIS
  // process whether or not Stem also runs the server, and quitting without
  // killing it leaves somebody's filesystem server running with no parent.
  mcpHost?.close();
  // Nothing to drain when the server is somebody else's process.
  if (!server) return;
  event.preventDefault();
  quitting = true;
  server.shutdown().finally(() => app.exit(0));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Dead-in-practice by design: the overlay + HUD windows are created at startup
  // and only ever hidden, so this event can't fire while they exist. Closing the
  // main window therefore leaves Stem running on every platform — on Linux the
  // way back in is the tray, `stem` (second-instance reveal), or `stem
  // --quick-chat`; quitting is the tray's Quit item. Kept as the standard idiom
  // for the day the persistent windows become closable.
  if (process.platform !== 'darwin') app.quit();
});
