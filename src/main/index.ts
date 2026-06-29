import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell
} from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createBackend, type ChatBackend } from './backend';
import { ensureWorkspace } from './workspace/bootstrap';
import { listSkills, setSkillEnabled } from './workspace/skills';
import { addFiles, listFiles, removeFile, revealFiles } from './files/store';
import {
  addConnectedFolders,
  connectedFolderPath,
  listConnectedFolders,
  publishProtectedRootsNow,
  removeConnectedFolder,
  updateConnectedFolder
} from './workspace/connected-folders';
import { workspaceRoot } from './workspace/paths';
import { TaskScheduler } from './scheduler';
import { createE2ESchedulerBackend } from './scheduler/e2e-backend';
import { imagePreviewDataUrl } from './pi/attachments';
import * as piMcp from './pi/mcp';
import {
  clearEpisodicMemory,
  clearFactsMemory,
  forgetFact,
  getMemorySettings,
  isRecallEnabled,
  readMemoryFiles,
  setEpisodicLimit,
  setMemoryEnabled,
  setTidyUpThreshold
} from './workspace/memory';
import { captureFromEvent } from './recall/capture';
import { getEmbeddingCacheStats, getEpisodicStats } from './recall/store';
import { distillNewMessages, shouldConsolidate } from './recall/distill';
import { consolidateFacts } from './recall/consolidate';
import { curateSkills } from './skills/curate';
import { setRetrievalClients } from './recall/retrieval';
import { createHttpEmbeddingsClient } from './recall/embeddings';
import { createHttpRerankClient } from './recall/rerank';
import type { LlmClient } from './recall/llm';
import {
  readSettings,
  updateMemorySettings,
  updateNativeWebSearch,
  updateQuickChat,
  updateRetrievalSettings,
  updateSkillsSettings
} from './workspace/settings';
import {
  createFolder,
  deleteFolder,
  getAssignments,
  listFolders,
  moveFolder,
  removeChat,
  renameFolder,
  setChatFolder
} from './workspace/chats';
import { activityLabel } from '../shared/activity';
import type {
  ChatListResult,
  ConnectedFolderPatch,
  ItemEventParams,
  McpServerInput,
  MemoryModelSettings,
  NativeWebSearchSettings,
  PartialRetrievalSettings,
  RetrievalStage,
  RetrievalTestResult,
  SkillsModelSettings,
  QuickChatHandoff,
  QuickChatPrompt,
  QuickChatSettings,
  QuickChatStatus,
  QuickChatStatusPhase,
  RuntimeStatus,
  ScheduledTask,
  StartTurnInput,
  StartTurnResult,
  TaskSchedulePatch
} from '../shared/types';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Brand the app rather than inheriting Electron's defaults. setName fixes the
// app/process name and userData path; appIcon drives the dock (and, off macOS,
// the window) icon. Note: in dev the macOS menu-bar title still reads
// "Electron" — that comes from the Electron.app bundle and only changes when
// the app is packaged.
app.setName('Stem');
const appIcon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'));

// In dev, expose a CDP port so tooling (agent-browser) can attach to the UI.
if (process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

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

let mainWindow: BrowserWindow | null = null;
let quickChatWindow: BrowserWindow | null = null;
/** Bottom-left status pill shown while the overlay is hidden and a turn runs. */
let hudWindow: BrowserWindow | null = null;
let runtime: ChatBackend | null = null;
/** Scheduled-tasks engine (cron/once → autonomous turns). Created in whenReady. */
let scheduler: TaskScheduler | null = null;
/** The currently-registered global accelerator, so we can unregister on change. */
let currentShortcut: string | null = null;
/** Cached "show overlay on all Spaces" setting, applied once per overlay window. */
let overlayOnAllDisplays = true;
/** Cached inactivity timeout (ms) after which a summon starts a fresh thread. */
let newThreadTimeoutMs = 5 * 60_000;

// ---- Quick Chat session ownership ----
//
// The overlay owns one live conversation at a time. While it owns a thread, that
// thread's backend events route to the overlay (not the main window) and drive the
// status HUD. Hand-off (button, or opening the thread from the sidebar) flips
// `overlayHandedOff` so events route to the main window from then on.
let overlayThreadId: string | null = null;
let overlayHandedOff = false;
/** Updated on each turn start/finish; drives the new-thread inactivity timeout. */
let overlayLastActivityAt = 0;
/** Whether the overlay's current turn is still running (so an idle-timeout summon
 *  never orphans a mid-stream thread by resetting ownership out from under it). */
let overlayTurnRunning = false;
/** Whether the in-flight overlay turn has started streaming text (HUD phase). */
let hudTextSeen = false;

// ---- Follow-me status pill (main-window threads) ----
//
// The bottom-left pill is shared between Quick Chat and the main app. While the
// main window is unfocused (you switched Spaces/apps) and a main-window thread is
// running, the pill mirrors that progress so you don't lose sight of it.
/** Show the pill for main threads when the main window loses focus. */
let followAcrossSpaces = true;
/** Play a chime when a turn finishes while the pill is visible. */
let finishSound = false;
/** Main-window threads currently running (working/answering), keyed by threadId. */
const runningMainThreads = new Set<string>();
/** Who currently owns the shared pill, so Quick Chat and follow-me never stomp. */
let hudOwner: 'none' | 'quickchat' | 'main' = 'none';
/** Last phase pushed to the pill, so the chime fires only on entering 'finished'. */
let lastHudPhase: QuickChatStatusPhase | null = null;

// True for the brief window around summoning the overlay. Showing the overlay
// activates the app, which fires `app.on('activate')`; without this guard that
// handler would recreate a previously-closed main window (and macOS would surface
// it), so summoning Quick Chat would "also open the main app."
let summoningOverlay = false;

// All-Spaces visibility for the overlay. `skipTransformProcessType: true` is
// critical: without it, macOS flips the app between accessory and foreground
// process types on every call — which briefly hides the dock icon AND all app
// windows, and re-activates the app (pulling the main window forward). We apply
// this exactly once per window (at creation) and on settings change, never per
// show, so summoning the overlay never disturbs the main window or dock.
function applyOverlayWorkspaceVisibility(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.setVisibleOnAllWorkspaces(overlayOnAllDisplays, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    });
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    titleBarStyle: 'hiddenInset',
    icon: appIcon,
    // Vertically center the inset traffic lights within the 52px toolbar.
    trafficLightPosition: { x: 19, y: 20 },
    // Match the toolbar/chrome color so first paint doesn't flash; follows
    // the system appearance (the renderer adapts via prefers-color-scheme).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1916' : '#efece5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  installNavigationGuards(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Follow-me pill: surface a running main-window thread's progress when you leave
  // the main window (switch Spaces/apps), and dismiss it when you return.
  mainWindow.on('blur', syncMainHud);
  mainWindow.on('focus', () => {
    if (hudOwner === 'main') hideHud();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ---- Quick Chat overlay (Spotlight-style) ----
//
// A frameless, always-on-top, transparent panel that loads the same renderer
// with a `?quickchat` flag. Created once at startup and reused (shown/hidden)
// so summoning it is instant and never loses the user's draft mid-stream.

// The window IS the frosted card (native vibrancy + rounded corners + native
// shadow), so these are the card's own dimensions — no extra room reserved for a
// CSS shadow as before.
const QUICK_CHAT_WIDTH = 596;
// Compact spotlight bar (fresh session) vs. expanded conversation panel (resuming
// a session with messages). The overlay window is resized between the two on show.
const QUICK_CHAT_HEIGHT = 108;
const QUICK_CHAT_PANEL_HEIGHT = 518;

// Bottom-left status HUD pill.
const HUD_WIDTH = 320;
const HUD_HEIGHT = 46;

function createQuickChatWindow(): void {
  quickChatWindow = new BrowserWindow({
    width: QUICK_CHAT_WIDTH,
    height: QUICK_CHAT_HEIGHT,
    frame: false,
    // A macOS NSPanel (not a normal window): it can take keyboard focus to type
    // WITHOUT activating Stem, so summoning it never drags the main window forward,
    // and hiding it never promotes the main window to the front. This is the
    // Spotlight/Raycast-style overlay behavior.
    type: 'panel',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    // Native macOS frosting: an NSVisualEffectView blurs the desktop behind the
    // window (real refraction, unlike CSS backdrop-filter on a transparent window).
    // The window itself is the rounded card — corners and the drop shadow are drawn
    // natively (roundedCorners + hasShadow), so no CSS shadow/padding hacks.
    vibrancy: 'under-window',
    visualEffectState: 'active', // keep the material lit even when not key
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  installNavigationGuards(quickChatWindow);

  // Float above full-screen apps. All-Spaces visibility is applied once here
  // (see applyOverlayWorkspaceVisibility) rather than on every show.
  quickChatWindow.setAlwaysOnTop(true, 'screen-saver');
  applyOverlayWorkspaceVisibility();

  quickChatWindow.on('closed', () => {
    quickChatWindow = null;
  });
  // No blur→hide: the overlay now persists a conversation the user re-summons to
  // read, so auto-hiding on focus loss would discard the answer they just opened.
  // Dismissal is explicit only (Escape / shortcut / submit / hand-off).

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    quickChatWindow.loadURL(`${devUrl}/?quickchat`);
  } else {
    quickChatWindow.loadFile(join(__dirname, '../renderer/index.html'), { search: 'quickchat' });
  }
}

// The status HUD: a tiny, non-focusable, always-on-top pill in the bottom-left.
// `focusable: false` is critical — showing it must never steal focus from the app
// the user is working in. Created once and reused like the overlay.
function createHudWindow(): void {
  hudWindow = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  installNavigationGuards(hudWindow);

  // The status pill must float above everything and follow the user across every
  // Space and into full-screen apps — unlike the overlay, this is unconditional
  // (not tied to the `overlayOnAllDisplays` preference): the pill is the only
  // signal that a turn is still running once the overlay is hidden.
  hudWindow.setAlwaysOnTop(true, 'screen-saver');
  hudWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
  hudWindow.on('closed', () => {
    hudWindow = null;
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    hudWindow.loadURL(`${devUrl}/?hud`);
  } else {
    hudWindow.loadFile(join(__dirname, '../renderer/index.html'), { search: 'hud' });
  }
}

/** Play a macOS finish chime (built-in system sound; no bundled asset). */
function playFinishChime(): void {
  if (process.platform !== 'darwin') return;
  try {
    spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], { stdio: 'ignore' }).unref();
  } catch {
    // Sound is best-effort; never let it break the turn lifecycle.
  }
}

/**
 * Show the HUD pill (bottom-left of the display under the cursor) and push status.
 * `owner` records whether Quick Chat or the follow-me path is driving it. The chime
 * fires once, on the transition into 'finished' while the pill is visible.
 */
function showHud(status: QuickChatStatus, owner: 'quickchat' | 'main'): void {
  if (!hudWindow || hudWindow.isDestroyed()) createHudWindow();
  const win = hudWindow!;
  if (!win.isVisible()) {
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds({
      x: Math.round(workArea.x + 16),
      y: Math.round(workArea.y + workArea.height - HUD_HEIGHT - 16),
      width: HUD_WIDTH,
      height: HUD_HEIGHT
    });
    win.showInactive(); // show without stealing focus
  }
  hudOwner = owner;
  // Stamp the live accelerator so the pill prompts the real summon key, not Enter.
  win.webContents.send('quickchat:status', { ...status, shortcut: currentShortcut });
  if (status.phase === 'finished' && lastHudPhase !== 'finished' && finishSound) playFinishChime();
  lastHudPhase = status.phase;
}

function hideHud(): void {
  if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) hudWindow.hide();
  hudOwner = 'none';
  lastHudPhase = null;
}

/**
 * HUD state machine, driven by the overlay-owned thread's event stream. Only runs
 * while the overlay is hidden (when it's visible the user is reading, no HUD):
 *   working  -> "Thinking…" / "Searching the web…" / "Using a tool…"
 *   answering -> once the first answer text streams
 *   finished  -> once the turn completes
 */
function driveHud(event: { method: string; params: unknown }): void {
  if (quickChatWindow?.isVisible()) return;
  switch (event.method) {
    case 'item/started': {
      const item = (event.params as ItemEventParams)?.item;
      const type = item?.type;
      if (type && type !== 'agentMessage' && !hudTextSeen)
        showHud({ phase: 'working', label: activityLabel(type, item?.name, item?.detail) }, 'quickchat');
      break;
    }
    case 'item/agentMessage/delta': {
      if (!hudTextSeen) {
        hudTextSeen = true;
        showHud({ phase: 'answering', label: 'Answering…' }, 'quickchat');
      }
      break;
    }
    case 'turn/completed':
    case 'turn/failed':
    case 'turn/aborted': {
      const label =
        event.method === 'turn/completed'
          ? 'Answer ready'
          : event.method === 'turn/failed'
            ? 'Request failed'
            : 'Stopped';
      overlayTurnRunning = false;
      overlayLastActivityAt = Date.now();
      showHud({ phase: 'finished', label }, 'quickchat');
      break;
    }
    default:
      break;
  }
}

/**
 * Follow-me pill: while the main window is unfocused (you switched Spaces/apps)
 * and a main-window thread is running, mirror its progress in the shared pill.
 * No-ops while Quick Chat owns the pill (it takes priority) or the feature is off.
 */
function syncMainHud(): void {
  if (!followAcrossSpaces) {
    if (hudOwner === 'main') hideHud();
    return;
  }
  if (hudOwner === 'quickchat') return;
  const blurred = !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused();
  const running = runningMainThreads.size > 0;
  if (running && blurred) {
    showHud({ phase: 'working', label: 'Working…', reveal: 'main' }, 'main');
  }
}

/**
 * Track which main-window threads are running and drive the follow-me pill. The
 * 'finished' transition (and its chime) only fires when the pill is already
 * shown for the main app (hudOwner === 'main') — i.e. the user is away.
 */
function noteMainThreadEvent(method: string, threadId: string): void {
  if (method === 'item/started' || method === 'item/agentMessage/delta') {
    runningMainThreads.add(threadId);
    syncMainHud(); // handles a thread that starts while you're already away
  } else if (method === 'turn/completed' || method === 'turn/failed' || method === 'turn/aborted') {
    runningMainThreads.delete(threadId);
    if (hudOwner === 'main' && runningMainThreads.size === 0) {
      const label =
        method === 'turn/completed' ? 'Answer ready' : method === 'turn/failed' ? 'Request failed' : 'Stopped';
      showHud({ phase: 'finished', label, reveal: 'main' }, 'main');
    }
  }
}

/**
 * Show the overlay. `reset` true => start a fresh session (compact spotlight bar);
 * false => resume the existing session (expanded conversation panel, showing the
 * answer the user re-summoned to read). The overlay's React state persists across
 * hide/show, so resuming needs no payload beyond the reset flag.
 */
function showQuickChat(reset: boolean): void {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) createQuickChatWindow();
  const win = quickChatWindow!;
  hideHud();

  // Suppress the activate-driven main-window recreation for this summon (cleared
  // on the next tick, after the activation has been handled).
  summoningOverlay = true;
  setImmediate(() => {
    summoningOverlay = false;
  });

  // Center horizontally on the display under the cursor, in the upper third.
  // Compact when starting fresh; expanded to a panel when resuming a session.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = QUICK_CHAT_WIDTH;
  const h = reset ? QUICK_CHAT_HEIGHT : QUICK_CHAT_PANEL_HEIGHT;
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + workArea.height * 0.22),
    width: w,
    height: h
  });
  // show() orders the panel front; focus() makes it the key window so it actually
  // receives keystrokes (typing, Escape). Because it's a non-activating panel,
  // focus() makes it key WITHOUT activating Stem — the previous app stays active
  // underneath and the main window is never pulled forward.
  win.show();
  win.focus();
  win.webContents.send('quickchat:focus', { reset });
}

/**
 * Hide the overlay on an explicit dismiss (Escape, or the shortcut pressed again).
 * The overlay is a non-activating panel, so hiding it does not promote Stem's main
 * window to the front and the previously-active app keeps focus — we just hide the
 * panel (no app.hide, which would also hide the main window and the HUD).
 */
function dismissQuickChat(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible()) {
    quickChatWindow.hide();
  }
}

/** Hide just the overlay window (without app.hide), so the HUD can stay visible. */
function hideOverlayWindow(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible()) quickChatWindow.hide();
}

function toggleQuickChat(): void {
  if (quickChatWindow && quickChatWindow.isVisible()) {
    dismissQuickChat();
    return;
  }
  // Decide continue-vs-fresh: no live session, already handed off, or idle past
  // the configured timeout => start a new thread. Clear ownership up front so the
  // old thread's events stop routing to the (now reset) overlay.
  const idleMs = Date.now() - overlayLastActivityAt;
  const reset =
    !overlayThreadId ||
    overlayHandedOff ||
    // Only auto-reset once the previous turn has finished — never orphan a
    // mid-stream thread by handing its events off to the main window.
    (!overlayTurnRunning && newThreadTimeoutMs > 0 && idleMs > newThreadTimeoutMs);
  if (reset) {
    overlayThreadId = null;
    overlayHandedOff = false;
    hudTextSeen = false;
  }
  showQuickChat(reset);
}

/** (Re)register the global accelerator. Returns false when registration fails. */
function applyQuickChatShortcut(accelerator: string | null): boolean {
  if (currentShortcut) {
    globalShortcut.unregister(currentShortcut);
    currentShortcut = null;
  }
  if (!accelerator) return true;
  try {
    const ok = globalShortcut.register(accelerator, toggleQuickChat);
    if (ok) currentShortcut = accelerator;
    return ok;
  } catch {
    return false;
  }
}

/** Send to the main window, deferring until its renderer has loaded (it may have
 *  just been recreated by revealMainWindow, before the listeners are registered). */
function sendToMain(channel: string, payload: unknown): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });
  } else {
    win.webContents.send(channel, payload);
  }
}

/** Bring the main window to the front (recreating it if it was closed). */
function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Test seam: when STEM_E2E is set, report a healthy backend without touching pi,
// so end-to-end UI tests can get past the sign-in gate and drive the real
// renderer hermetically. Only the backend handshake is faked — every store
// (recall, files, settings) still runs for real against the isolated workspace.
const E2E = !!process.env.STEM_E2E;

function registerIpc(): void {
  ipcMain.handle('runtime:status', (): Promise<RuntimeStatus> | RuntimeStatus => {
    if (E2E) {
      return { ok: true, authenticated: true, backendPath: null, backendHome: '', workspaceRoot: '' };
    }
    return runtime!.status();
  });
  ipcMain.handle('runtime:login', async () => {
    const status = await runtime!.login();
    // Signing in mid-session: start the scheduler now (idempotent) so tasks load and
    // catch-up runs without waiting for a restart.
    if (status.ok) void scheduler?.start();
    return status;
  });
  ipcMain.handle('backend:startTurn', async (_e, input: StartTurnInput) => {
    // Main-window turns honor the main native-web-search toggle (the backend no-ops
    // it for providers without native search).
    const settings = await readSettings();
    return runtime!.startTurn({ ...input, webSearch: settings.nativeWebSearch.main });
  });
  ipcMain.handle('backend:interruptTurn', (_e, turnId: string) => runtime!.interruptTurn(turnId));
  ipcMain.handle('backend:newConversation', () => runtime!.newConversation());
  ipcMain.handle('dialog:openFiles', () =>
    dialog
      .showOpenDialog(mainWindow!, { properties: ['openFile', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths))
  );
  ipcMain.handle('backend:listModels', () => runtime!.listModels());

  ipcMain.handle('skills:list', () => listSkills());
  ipcMain.handle('skills:setEnabled', (_e, slug: string, enabled: boolean) => setSkillEnabled(slug, enabled));
  ipcMain.handle('skills:curate', async () => {
    // Same hidden one-shot seam the curator uses; `force` bypasses the size floor
    // so a manual "Tidy up" always runs. Reload so pi rescans the updated skills.
    const llm: LlmClient = {
      complete: async (prompt) => runtime!.complete(prompt, { model: (await readSettings()).skills.model })
    };
    await curateSkills(llm, { force: true });
    await runtime!.requestSkillReload();
    return listSkills();
  });

  ipcMain.handle('files:list', () => listFiles());
  ipcMain.handle('files:add', (_e, paths: string[], subdir?: string) => addFiles(paths, subdir));
  ipcMain.handle('files:remove', (_e, rel: string) => removeFile(rel));
  ipcMain.handle('files:reveal', () => revealFiles());
  ipcMain.handle('files:preview', (_e, path: string) => imagePreviewDataUrl(path));

  // ---- connected folders (external folders the assistant reads in place) ----
  // Distinct `cfolders:*` namespace — `folders:*` is the chat-folder tree above.
  ipcMain.handle('cfolders:list', () => listConnectedFolders());
  ipcMain.handle('cfolders:add', (_e, paths: string[]) => addConnectedFolders(paths));
  ipcMain.handle('cfolders:update', (_e, id: string, patch: ConnectedFolderPatch) =>
    updateConnectedFolder(id, patch)
  );
  ipcMain.handle('cfolders:remove', (_e, id: string) => removeConnectedFolder(id));
  ipcMain.handle('cfolders:reveal', async (_e, id: string) => {
    const path = await connectedFolderPath(id);
    if (path) await shell.openPath(path);
  });
  ipcMain.handle('cfolders:revealWorkspace', () => shell.openPath(workspaceRoot()));

  // Scheduled tasks. Mutations return the fresh list (like the cfolders handlers).
  ipcMain.handle('tasks:list', (): ScheduledTask[] => scheduler?.snapshot() ?? []);
  ipcMain.handle('tasks:setEnabled', (_e, id: string, enabled: boolean) =>
    scheduler ? scheduler.setEnabled(id, enabled) : []
  );
  ipcMain.handle('tasks:runNow', (_e, id: string) => scheduler?.runNow(id) ?? []);
  ipcMain.handle('tasks:delete', (_e, id: string) => (scheduler ? scheduler.remove(id) : []));
  ipcMain.handle('tasks:updateSchedule', (_e, id: string, patch: TaskSchedulePatch) =>
    scheduler ? scheduler.updateSchedule(id, patch.schedule) : []
  );
  ipcMain.handle('dialog:openDirectory', () =>
    dialog
      .showOpenDialog(mainWindow!, { properties: ['openDirectory', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths))
  );

  ipcMain.handle('mcp:list', () => piMcp.listMcpServers());
  ipcMain.handle('mcp:status', () => runtime!.getMcpStatus());
  ipcMain.handle('mcp:add', (_e, input: McpServerInput) => piMcp.addMcpServer(input));
  ipcMain.handle('mcp:remove', (_e, name: string) => piMcp.removeMcpServer(name));
  ipcMain.handle('mcp:setEnabled', (_e, name: string, enabled: boolean) =>
    piMcp.setMcpServerEnabled(name, enabled)
  );
  ipcMain.handle('mcp:login', (_e, name: string) => runtime!.mcpLogin(name));
  ipcMain.handle('mcp:adminDecision', (_e, id: number | string, accept: boolean) => {
    runtime!.resolveAdminApproval(id, accept);
  });
  ipcMain.handle('runtime:restart', async () => {
    await runtime!.restart();
    return runtime!.status();
  });

  ipcMain.handle('memory:get', () => getMemorySettings());
  ipcMain.handle('memory:setEnabled', async (_e, enabled: boolean) => {
    const settings = await setMemoryEnabled(enabled);
    // Restart applies the recall-MCP change to the live backend; skipped under the
    // E2E seam, where there's no real backend to restart.
    if (!E2E) await runtime!.restart();
    return settings;
  });
  ipcMain.handle('memory:read', () => readMemoryFiles());
  ipcMain.handle('memory:forget', async (_e, id: number) => {
    await forgetFact(id);
    return readMemoryFiles();
  });
  ipcMain.handle('memory:resetFacts', () => clearFactsMemory());
  ipcMain.handle('memory:resetEpisodic', () => clearEpisodicMemory());
  ipcMain.handle('memory:episodicStats', () => getEpisodicStats());
  ipcMain.handle('memory:embeddingStats', async () =>
    getEmbeddingCacheStats((await readSettings()).retrieval.embeddings.model)
  );
  ipcMain.handle('memory:setEpisodicLimit', (_e, bytes: number) => setEpisodicLimit(bytes));
  ipcMain.handle('memory:setTidyThreshold', (_e, n: number) => setTidyUpThreshold(n));
  ipcMain.handle('memory:consolidate', async () => {
    // Same hidden one-shot seam distillation uses; `force` bypasses the size floor
    // so a manual run always executes.
    const llm: LlmClient = {
      complete: async (prompt) => runtime!.complete(prompt, { model: (await readSettings()).memory.model })
    };
    const result = await consolidateFacts(llm, { force: true });
    return { ...result, contents: await readMemoryFiles() };
  });

  // ---- chats + folders ----
  // Chats come from the backend's thread store; folders/assignments from the Stem
  // store. We merge them here so the runtime stays backend-only and the store
  // stays backend-unaware.
  const chatList = async (): Promise<ChatListResult> => {
    const [chats, folders, assignments] = await Promise.all([
      runtime!.listThreads(),
      listFolders(),
      getAssignments()
    ]);
    const valid = new Set(folders.map((f) => f.id));
    for (const chat of chats) {
      const folderId = assignments[chat.threadId];
      chat.folderId = folderId && valid.has(folderId) ? folderId : null;
    }
    return { chats, folders };
  };

  ipcMain.handle('chats:list', () => chatList());
  ipcMain.handle('chats:open', async (_e, threadId: string) => {
    // Opening the overlay's live thread from the sidebar is an implicit hand-off:
    // route its events to the main window and drop the overlay/HUD so the two
    // views don't diverge.
    if (threadId === overlayThreadId && !overlayHandedOff) {
      overlayHandedOff = true;
      overlayTurnRunning = false;
      hideHud();
      hideOverlayWindow();
    }
    // Read is a local file read and isn't gated, so the open returns immediately.
    // Pre-warm pi (switch_session) in the background — it's redundant for
    // correctness since startTurn calls ensureActive itself, but it makes the
    // first send faster. Crucially it no longer blocks the open behind the
    // foreground gate / any in-flight turn.
    void runtime!.resumeThread(threadId).catch(() => {});
    const { title, messages } = await runtime!.readThread(threadId);
    return { threadId, title, messages };
  });
  ipcMain.handle('chats:rollbackToTurn', (_e, threadId: string, turnId: string) =>
    runtime!.rollbackToTurn(threadId, turnId)
  );
  ipcMain.handle('chats:forkThread', (_e, threadId: string, turnId: string) =>
    runtime!.forkThread(threadId, turnId)
  );
  ipcMain.handle('chats:rename', (_e, threadId: string, name: string) => runtime!.renameThread(threadId, name));
  ipcMain.handle('chats:delete', async (_e, threadId: string) => {
    // Independent stores (pi session file vs. folder-assignment JSON) — run concurrently.
    // Also drop any scheduled tasks bound to this chat (they'd otherwise run into a
    // missing thread; the scheduler guards against that too, but cleaning up is tidier).
    await Promise.all([
      runtime!.deleteThread(threadId),
      removeChat(threadId),
      scheduler?.removeForThread(threadId) ?? Promise.resolve()
    ]);
  });
  ipcMain.handle('chats:setFolder', async (_e, threadId: string, folderId: string | null) => {
    await setChatFolder(threadId, folderId);
    return chatList();
  });

  ipcMain.handle('folders:create', async (_e, name: string, parentId: string | null) => {
    await createFolder(name, parentId);
    return chatList();
  });
  ipcMain.handle('folders:rename', async (_e, folderId: string, name: string) => {
    await renameFolder(folderId, name);
    return chatList();
  });
  ipcMain.handle('folders:delete', async (_e, folderId: string) => {
    await deleteFolder(folderId);
    return chatList();
  });
  ipcMain.handle('folders:move', async (_e, folderId: string, parentId: string | null) => {
    await moveFolder(folderId, parentId);
    return chatList();
  });

  // ---- settings + quick chat ----
  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:updateQuickChat', async (_e, patch: Partial<QuickChatSettings>) => {
    const next = await updateQuickChat(patch);
    // Apply the side effects the renderer can't: re-bind the global shortcut and
    // re-apply all-displays visibility to the live overlay window.
    if ('shortcut' in patch) applyQuickChatShortcut(next.quickChat.shortcut);
    if ('showOnAllDisplays' in patch) {
      overlayOnAllDisplays = next.quickChat.showOnAllDisplays;
      applyOverlayWorkspaceVisibility();
    }
    if ('newThreadTimeoutMs' in patch) newThreadTimeoutMs = next.quickChat.newThreadTimeoutMs;
    if ('followAcrossSpaces' in patch) {
      followAcrossSpaces = next.quickChat.followAcrossSpaces;
      if (!followAcrossSpaces && hudOwner === 'main') hideHud();
    }
    if ('finishSound' in patch) finishSound = next.quickChat.finishSound;
    return next;
  });
  ipcMain.handle('settings:updateNativeWebSearch', async (_e, patch: Partial<NativeWebSearchSettings>) => {
    // Just persist — the value is applied per turn (the runtime writes the gate the
    // bridge reads, based on the originating context), so no restart/file write here.
    return updateNativeWebSearch(patch);
  });
  ipcMain.handle('settings:updateMemory', async (_e, patch: Partial<MemoryModelSettings>) => {
    // Just persist — the LlmClient closures read the model fresh from settings on
    // each memory turn, so the change applies to the next distill/tidy-up.
    return updateMemorySettings(patch);
  });
  ipcMain.handle('settings:updateSkills', async (_e, patch: Partial<SkillsModelSettings>) => {
    // Just persist — the curator's LlmClient reads the model fresh from settings on
    // each pass, so the change applies to the next curation run.
    return updateSkillsSettings(patch);
  });
  ipcMain.handle('settings:updateRetrieval', async (_e, patch: PartialRetrievalSettings) => {
    // Just persist — the embeddings/rerank clients read their config fresh from
    // settings on each turn, so the change applies to the next fact-ranking pass.
    return updateRetrievalSettings(patch);
  });
  ipcMain.handle('settings:testRetrieval', async (_e, stage: RetrievalStage): Promise<RetrievalTestResult> => {
    // Live one-shot probe of the configured endpoint so the user can confirm it
    // actually responds (the fact-ranking path is otherwise silent). Ignores the
    // `enabled` flag — testing while toggling is the point.
    const cfg = (await readSettings()).retrieval[stage];
    if (!cfg.baseUrl || !cfg.model) return { ok: false, detail: 'Set a base URL and model first.' };
    const getCfg = async () => ({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey });
    const startedAt = Date.now();
    try {
      if (stage === 'embeddings') {
        const [vec] = await createHttpEmbeddingsClient(getCfg, { timeoutMs: 20_000 }).embed(['Stem retrieval test']);
        return { ok: true, detail: `${vec.length}-dim · ${Date.now() - startedAt} ms` };
      }
      const ranked = await createHttpRerankClient(getCfg, { timeoutMs: 20_000 }).rerank(
        'pets',
        ['I have a dog', 'the sky is blue'],
        2
      );
      return { ok: true, detail: `ranked ${ranked.length} · ${Date.now() - startedAt} ms` };
    } catch (err) {
      const e = err as { message?: string; cause?: { code?: string } };
      return { ok: false, detail: e.cause?.code ?? e.message ?? 'request failed' };
    }
  });
  // Run a prompt in the overlay's own thread. For a fresh session we pre-create
  // the thread (so its events route correctly from the very first event), then
  // hide the overlay and raise the HUD — the disappear→HUD half of the cycle.
  ipcMain.handle('quickchat:run', async (_e, prompt: QuickChatPrompt): Promise<StartTurnResult> => {
    // Start the disappear→HUD half of the cycle immediately — before the (async)
    // thread creation — so the overlay never flashes the half-laid-out panel.
    hudTextSeen = false;
    overlayTurnRunning = true;
    overlayLastActivityAt = Date.now();
    // Hide just the overlay (NOT app.hide — that would also hide the HUD we're
    // about to show, and re-showing the HUD would reactivate the app and surface
    // the main window). The overlay is a non-activating panel, so hiding it does
    // not promote the main window. The HUD is non-focusable, so it never steals
    // focus from whatever app the user is in.
    hideOverlayWindow();
    showHud({ phase: 'working', label: 'Working…' }, 'quickchat');

    try {
      const continuing = !!prompt.threadId && prompt.threadId === overlayThreadId && !overlayHandedOff;
      let threadId = continuing ? overlayThreadId! : null;
      if (!threadId) {
        threadId = await runtime!.createThread(prompt.model ?? undefined);
        overlayThreadId = threadId;
        overlayHandedOff = false;
        // Optimistic sidebar row so the quickchat thread shows immediately.
        mainWindow?.webContents.send('quickchat:sessionStarted', {
          threadId,
          title: prompt.input.trim() || 'New chat'
        });
      }

      const result = await runtime!.startTurn({
        input: prompt.input,
        threadId,
        model: prompt.model ?? undefined,
        effort: prompt.effort ?? undefined,
        serviceTier: prompt.serviceTier,
        format: prompt.format,
        // Quick Chat turns honor the Quick Chat native-web-search toggle.
        webSearch: (await readSettings()).nativeWebSearch.quickChat,
        attachments: prompt.attachments
      });
      overlayLastActivityAt = Date.now();
      // The memory shortcut ("remember that …") completes with no stream — jump the
      // HUD straight to finished.
      if (result.handled) {
        overlayTurnRunning = false;
        showHud({ phase: 'finished', label: 'Answer ready' }, 'quickchat');
      }
      return result;
    } catch (e) {
      overlayTurnRunning = false;
      overlayLastActivityAt = Date.now();
      hideHud();
      showQuickChat(false);
      throw e;
    }
  });

  // Forget the current overlay thread so the next prompt opens a fresh one.
  ipcMain.handle('quickchat:newThread', () => {
    overlayThreadId = null;
    overlayHandedOff = false;
    overlayTurnRunning = false;
    hudTextSeen = false;
    hideHud();
  });

  // Hand the conversation off to the main window: route future events there,
  // reveal the main window, and have it adopt the thread as the active chat.
  ipcMain.handle('quickchat:handoff', (_e, payload: QuickChatHandoff) => {
    overlayHandedOff = true;
    overlayTurnRunning = false;
    hideHud();
    hideOverlayWindow();
    revealMainWindow();
    sendToMain('quickchat:adopt', payload);
  });

  // Re-summon the overlay (HUD click). Same path as the shortcut.
  ipcMain.handle('quickchat:reveal', () => {
    if (!quickChatWindow?.isVisible()) toggleQuickChat();
  });

  // Raise the main window (follow-me pill click). Returning focus to the main
  // window fires the 'focus' handler, which hides the pill.
  ipcMain.handle('main:reveal', () => revealMainWindow());

  ipcMain.handle('quickchat:hide', () => {
    dismissQuickChat();
  });
}

app.whenReady().then(async () => {
  await ensureWorkspace();
  // Publish the read-only connected-folder roots so the backend extension enforces
  // them from the first turn (also rewritten on every Folders-tab mutation).
  await publishProtectedRootsNow().catch(() => undefined);
  // pi is the only backend; it satisfies ChatBackend so everything below is
  // backend-agnostic.
  runtime = createBackend();

  // Scheduled tasks: re-run a chat's prompt as an autonomous turn on a cron/once
  // schedule. The scheduler owns timing + execution; the backend routes the
  // assistant's schedule_task/notify_user tools to it via the TaskBridge below.
  scheduler = new TaskScheduler({
    // Under STEM_E2E the real pi backend can't dispatch a turn, so the scheduler
    // gets a hermetic shim that settles turns instantly — letting e2e specs seed a
    // due task and observe it fire + clean up (see scheduler/e2e-backend.ts).
    runtime: E2E ? createE2ESchedulerBackend() : runtime,
    onChange: (tasks) => mainWindow?.webContents.send('tasks:changed', tasks),
    onRun: (run) => mainWindow?.webContents.send('tasks:run', run)
  });
  runtime.setTaskBridge({
    schedule: (req, threadId) => scheduler!.create(req, threadId),
    listForThread: async (threadId) => scheduler!.listForThread(threadId),
    cancel: async (taskId) => {
      const before = scheduler!.snapshot().length;
      await scheduler!.remove(taskId);
      return scheduler!.snapshot().length < before ? { ok: true } : { ok: false, error: 'No such task.' };
    },
    // notify_user: surface a prominent in-app alert — raise + focus the main window,
    // bounce the dock, and show the alert modal. Native OS notifications were judged
    // not prominent enough for watch-style tasks.
    notify: async ({ title, message }, threadId) => {
      revealMainWindow();
      app.dock?.bounce('critical');
      mainWindow?.webContents.send('tasks:notify', {
        threadId,
        title,
        message,
        at: new Date().toISOString()
      });
    }
  });

  // Stem Recall: distill durable facts via a hidden backend turn (the swappable
  // LlmClient seam). Debounced so it runs ~after the user goes idle.
  const recallLlm: LlmClient = {
    complete: async (prompt) => runtime!.complete(prompt, { model: (await readSettings()).memory.model })
  };

  // The skills curator gets its OWN model setting (separate from memory) — curation
  // can be a harder task than fact distillation, so it can be pointed at a stronger
  // model. Read fresh each pass so a Settings change applies to the next run.
  const skillsLlm: LlmClient = {
    complete: async (prompt) => runtime!.complete(prompt, { model: (await readSettings()).skills.model })
  };

  // Stem Recall relevance ranking: embeddings + reranker HTTP endpoints (e.g. a
  // local Ollama + a /rerank server). Config is read fresh each turn, so toggling
  // or repointing them in Settings takes effect on the next fact-ranking pass with
  // no restart. Disabled config → the clients report unavailable and inject falls
  // back to recency selection.
  setRetrievalClients({
    embeddings: createHttpEmbeddingsClient(async () => {
      const e = (await readSettings()).retrieval.embeddings;
      return e.enabled && e.baseUrl && e.model ? { baseUrl: e.baseUrl, model: e.model, apiKey: e.apiKey } : null;
    }),
    // Reranker is intentionally not wired to the live ranking path: it has no UI and
    // a verified /rerank server is hard to host (Ollama can't serve one). Fact ranking
    // runs embeddings → cosine only. The seam (rerank.ts, the optional rerank step in
    // inject, the Test handler below) stays intact, so re-enable here once you run a
    // real /rerank endpoint (llama.cpp --reranking, Infinity, …).
    rerank: null
  });
  let distilling = false;
  let distillTimer: NodeJS.Timeout | null = null;
  const scheduleDistill = (delayMs = 15_000): void => {
    if (!isRecallEnabled()) return;
    if (distillTimer) clearTimeout(distillTimer);
    distillTimer = setTimeout(async () => {
      if (distilling) return;
      distilling = true;
      try {
        await distillNewMessages(recallLlm);
        // Once enough new facts have piled up, clean the set: merge reworded
        // duplicates, apply corrections, drop superseded facts. Same hidden
        // LlmClient seam, so it's invisible to the user like distillation.
        if (shouldConsolidate()) await consolidateFacts(recallLlm);
      } catch {
        // non-fatal
      } finally {
        distilling = false;
      }
    }, delayMs);
  };

  // Skills curator: the Level-2 cleanup of self-authored skills (merge duplicates,
  // patch sloppy bodies, archive stale ones), mirroring fact consolidation. Uses the
  // same hidden LlmClient seam, and is gated by the memory toggle since it's the same
  // kind of background self-improvement pass. On any change, reload so pi rescans skills.
  let curating = false;
  const runCurate = async (): Promise<void> => {
    if (curating || !isRecallEnabled()) return;
    curating = true;
    try {
      const res = await curateSkills(skillsLlm);
      if (res.merged || res.patched || res.archived) await runtime!.requestSkillReload();
    } catch {
      // non-fatal
    } finally {
      curating = false;
    }
  };
  // A pass shortly after startup, then a low-frequency recurring pass while idle.
  setTimeout(() => void runCurate(), 90_000);
  setInterval(() => void runCurate(), 24 * 60 * 60_000);

  // Forward backend events to the main window. Registered once (not per-window) so
  // recreating the window can't double-subscribe.
  runtime.on('event', (event) => {
    // Stem-internal MCP self-management signals: deliver to the windows on their
    // own channels (never as a backend thread event, and never captured into recall).
    if (event.method === 'mcp/admin/approvalRequest') {
      mainWindow?.webContents.send('mcp:adminApproval', event.params);
      quickChatWindow?.webContents.send('mcp:adminApproval', event.params);
      return;
    }
    if (event.method === 'mcp/changed') {
      mainWindow?.webContents.send('mcp:changed');
      quickChatWindow?.webContents.send('mcp:changed');
      return;
    }
    if (event.method === 'skills/changed') {
      mainWindow?.webContents.send('skills:changed');
      quickChatWindow?.webContents.send('skills:changed');
      return;
    }
    if (event.method === 'mcp/status') {
      mainWindow?.webContents.send('mcp:status', event.params);
      quickChatWindow?.webContents.send('mcp:status', event.params);
      return;
    }
    const threadId = (event.params as { threadId?: string } | undefined)?.threadId;
    // Hidden internal threads (distillation) are neither shown nor captured.
    if (threadId && runtime!.isInternalThread(threadId)) return;
    // The overlay owns its live thread until hand-off: route its events to the
    // overlay window (which renders the conversation) and the status HUD, NOT the
    // main window — otherwise the main window would build a phantom user-less slice.
    const overlayOwned = !!threadId && threadId === overlayThreadId && !overlayHandedOff;
    if (overlayOwned) {
      quickChatWindow?.webContents.send('backend:event', event);
      driveHud(event);
    } else if (!threadId) {
      // Process-level events (e.g. process/exit) carry no threadId — let both
      // windows clear their run state, and clear the follow-me pill so a backend
      // crash never leaves a stuck "Working…" pill.
      mainWindow?.webContents.send('backend:event', event);
      quickChatWindow?.webContents.send('backend:event', event);
      runningMainThreads.clear();
      if (hudOwner === 'main') hideHud();
    } else {
      mainWindow?.webContents.send('backend:event', event);
      noteMainThreadEvent(event.method, threadId);
    }
    if (isRecallEnabled()) {
      // Skip capture when the turn read inside a memorize:false connected folder, so
      // its (potentially confidential) reply never enters Recall. scheduleDistill still
      // runs — it only processes already-captured messages.
      if (!(threadId && runtime!.isCaptureSuppressed(threadId))) {
        captureFromEvent(event); // tap assistant replies into Stem Recall (all threads)
      }
      if (event.method === 'turn/completed') scheduleDistill();
    }
  });

  // Kick off a distillation pass shortly after startup so any messages captured
  // before the app last quit get turned into durable facts.
  scheduleDistill(20_000);

  // Strict CSP for the renderer in production: only self, no remote/inline
  // script. Skipped in dev so the Vite dev server / HMR can run.
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

  registerIpc();
  createWindow();
  // Eagerly spawn pi + connect MCP once the window has painted, so the first prompt
  // doesn't pay backend cold-start. Skipped in E2E (the backend is faked) and when
  // not signed in (status() is cheap and never spawns). did-finish-load keeps the
  // spawn + MCP child processes off the first-paint path. Fire-and-forget; races
  // harmlessly with the renderer's listModels warm (ensureStarted is idempotent).
  if (E2E) {
    // The backend is faked, so there's no prewarm and no sign-in gate — but the
    // scheduler subsystem (store → IPC → renderer) is still real and worth
    // exercising end-to-end. Start it so seeded tasks load and the Tasks tab is
    // reachable. (E2E specs seed only non-due tasks, so no turns are dispatched.)
    mainWindow?.webContents.once('did-finish-load', () => void scheduler?.start());
  } else {
    mainWindow?.webContents.once('did-finish-load', () => {
      void runtime!
        .status()
        .then((s) => {
          if (!s.ok) return;
          // Start the scheduler only once signed in — runs are turns, which need a
          // working backend. This also runs any tasks missed while Stem was closed
          // (catch-up), exactly once each.
          void scheduler?.start();
          return runtime!.prewarm();
        })
        .catch(() => {});
    });
  }
  // Pre-create the overlay (hidden) so the shortcut summons it instantly, and
  // bind the global accelerator from the saved settings. Seed the all-Spaces
  // flag before creating the overlay so it's applied once, at creation.
  const initialSettings = await readSettings();
  overlayOnAllDisplays = initialSettings.quickChat.showOnAllDisplays;
  newThreadTimeoutMs = initialSettings.quickChat.newThreadTimeoutMs;
  followAcrossSpaces = initialSettings.quickChat.followAcrossSpaces;
  finishSound = initialSettings.quickChat.finishSound;
  createQuickChatWindow();
  createHudWindow();
  applyQuickChatShortcut(initialSettings.quickChat.shortcut);

  app.on('activate', () => {
    // Don't recreate the main window when the activation was triggered by summoning
    // the Quick Chat overlay — that would reopen a closed main window unbidden.
    if (summoningOverlay || quickChatWindow?.isVisible()) return;
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
}).catch((error) => {
  console.error('Failed to start Stem:', error);
  app.quit();
});

// Shut the backend down gracefully before quitting. preventDefault + await gives
// it a window to drain in-flight work, then we exit for real (shutdown has its
// own SIGKILL backstop).
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !runtime) return;
  event.preventDefault();
  quitting = true;
  scheduler?.stop();
  runtime.shutdown().finally(() => app.exit(0));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
