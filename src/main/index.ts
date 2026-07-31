import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell
} from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import net from 'node:net';
import { createBackend, type ChatBackend } from './backend';
import {
  handleIpc,
  registerAuthIpc,
  registerChatsIpc,
  registerMcpIpc,
  registerMemoryIpc,
  registerWorkspaceIpc,
  type IpcDeps
} from './ipc';
import { log } from './log';
import {
  enableGlobalShortcutPortal,
  isLinux,
  isMac,
  isWaylandSession,
  mainWindowChromeOptions,
  overlayOuterBounds,
  overlayWindowOptions,
  playFinishChime as platformFinishChime,
  presentOverlayWindow,
  quickChatSummonCommand,
  requestAttention,
  workspaceVisibilityOptions
} from './platform';
import { initTray } from './startup/tray';
import {
  failQuickChatProcess,
  HudPill,
  OverlaySession,
  QuickChatHandoffBarrier,
  QuickChatResetBarrier,
  RendererPushQueue
} from './ui-lifecycle';
import { ensureWorkspace } from './workspace/bootstrap';
import { publishProtectedRootsNow } from './workspace/connected-folders';
import { piHome, resolveProfileOverride } from './workspace/paths';
import type { TaskScheduler } from './scheduler';
import { initTaskScheduler } from './startup/scheduler';
import type { ExecService } from './exec/service';
import { initExecService } from './startup/exec';
import {
  clearMobileTurns,
  closeMobileBridge,
  initMobileBridge,
  mobileTurnsInFlight,
  noteMobileTurnEvent,
  pushToMobile,
  syncMobileBridge
} from './startup/mobile';
import { setActivityEmitter } from './activity';
import { initRetrieval } from './startup/retrieval';
import { initRecallTasks } from './startup/recall-tasks';
import { ensureUsageTracking } from './skills/usage';
import { initFolderIndexTasks } from './startup/folder-index-tasks';
import { closeFolderIndexes } from './folder-index';
import { ProviderAuth } from './pi/provider-auth';
import { isRecallEnabled } from './workspace/memory';
import { captureFromEvent } from './recall/capture';
import { createHttpEmbeddingsClient } from './recall/embeddings';
import { createHttpRerankClient } from './recall/rerank';
import { EMBED_CATALOG } from './recall/embed-catalog';
import type { EmbedWorkerManager } from './recall/embed-manager';
import { RERANK_CATALOG } from './recall/rerank-catalog';
import type { ScanWorkerManager } from './recall/scan-manager';
import { backfillChatIndex, reindexChatThread } from './chatsearch/index-sync';
import {
  markOnboardingCompleted,
  readSettings,
  updateCustomInstructions,
  updateDefaultModel,
  updateEscapeAction,
  updateExecSettings,
  updateMemorySettings,
  updateWebSearch,
  updateQuickChat,
  updateRetrievalSettings,
  updateSkillsSettings
} from './workspace/settings';
import { needsBackendRestart, needsWebSearchConfigWrite, writeWebSearchConfig } from './pi/web-search';
import { activityLabel } from '../shared/activity';
import type {
  BackendEventEnvelope,
  CustomInstructionsSettings,
  EscapeAction,
  ExecDecision,
  ExecSettings,
  ItemEventParams,
  MemoryModelSettings,
  ModelSummary,
  WebSearchSettings,
  PartialRetrievalSettings,
  RetrievalStage,
  RetrievalTestResult,
  SkillsModelSettings,
  QuickChatHandoff,
  QuickChatPrompt,
  QuickChatSettings,
  QuickChatShortcutStatus,
  QuickChatStatus,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../shared/types';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Prefer IPv4 for all main-process networking. auth.openai.com (and other OAuth
// token endpoints) are dual-stack, but many networks have no working IPv6 route;
// Electron's main-process fetch would then try an AAAA address and die with a bare
// "fetch failed" (EHOSTUNREACH) instead of falling back — breaking the OAuth token
// exchange right after the browser shows "authentication successful". Ordering
// IPv4 first, plus enabling Happy Eyeballs (parallel v4/v6 with fallback), makes
// the token exchange behave like curl and the system browser. Guarded for older
// runtimes that lack the setters.
dns.setDefaultResultOrder?.('ipv4first');
net.setDefaultAutoSelectFamily?.(true);
net.setDefaultAutoSelectFamilyAttemptTimeout?.(1000);

// Brand the app rather than inheriting Electron's defaults. setName fixes the
// app/process name and userData path; appIcon drives the dock (and, off macOS,
// the window) icon. Note: in dev the macOS menu-bar title still reads
// "Electron" — that comes from the Electron.app bundle and only changes when
// the app is packaged.
app.setName('Stem');

// Alternate profiles: `--fresh` / `--profile=<name>` (or STEM_FRESH=1 / STEM_PROFILE=<name>)
// relocate ALL app state to an isolated userData dir under a sibling "Stem Profiles/"
// container, so the first-run onboarding can be walked as a brand-new user without touching
// the real signed-in profile. Must run before anything reads a userData-derived path (all of
// paths.ts is lazy and only fires after whenReady, so here is early enough).
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
  if (!quickChatWindow) return;
  if (argv.includes('--quick-chat')) toggleQuickChat();
  else revealMainWindow();
});

const appIcon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'));

// In dev, expose a CDP port so tooling (agent-browser) can attach to the UI.
if (process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

// Global shortcuts through the XDG portal on Linux — the only path that works in
// a Wayland session. Must be set here: switches are read at Chromium startup.
enableGlobalShortcutPortal();

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
const mainPushQueue = new RendererPushQueue();
let quickChatWindow: BrowserWindow | null = null;
/** Bottom-left status pill shown while the overlay is hidden and a turn runs. */
let hudWindow: BrowserWindow | null = null;
let runtime: ChatBackend | null = null;
let execService: ExecService | null = null;
/** Scheduled-tasks engine (cron/once → autonomous turns). Created in whenReady. */
let scheduler: TaskScheduler | null = null;
/** The currently-registered global accelerator, so we can unregister on change. */
let currentShortcut: string | null = null;
/**
 * The accelerator the user configured, registered or not. Kept apart from
 * `currentShortcut` (which only ever holds a grab the OS accepted) so Settings can
 * tell "your key is live" from "the OS refused it" instead of showing a shortcut
 * that does nothing.
 */
let desiredShortcut: string | null = null;
/** Cached "show overlay on all Spaces" setting, applied once per overlay window. */
let overlayOnAllDisplays = true;
/** Cached inactivity timeout (ms) after which a summon starts a fresh thread. */
let newThreadTimeoutMs = 5 * 60_000;

// ---- Quick Chat session ownership ----
//
// The overlay owns one live conversation at a time. While it owns a thread, that
// thread's backend events route to the overlay (not the main window) and drive the
// status HUD. Hand-off (button, or opening the thread from the sidebar) routes
// events to the main window from then on. All of that state lives in `overlay`
// (see OverlaySession) — every mutation is a named transition, never a bare flag.
const overlay = new OverlaySession();
const overlayHandoffBarrier = new QuickChatHandoffBarrier();
/** A manual reset requested while the old overlay turn was still settling. Keep
 * ownership long enough to route that turn's terminal event, then release it. */
const overlayResetBarrier = new QuickChatResetBarrier();

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
// When the user last started/stopped a turn (main or Quick Chat). Drives the
// scheduler's isUserActive signal so scheduled runs defer while they're chatting.
let lastInteractiveAt = 0;
let scheduleMemoryRebuild: () => void = () => {};
let scheduleFolderIndexScan: (delayMs?: number) => void = () => {};
let scheduleFolderLearn: (delayMs?: number) => void = () => {};
// How long after the last interaction the user still counts as "active".
const USER_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
/** Ownership + last phase of the shared pill (chime edge detection) — see HudPill. */
const hud = new HudPill();

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
//
// Three macOS caveats worth knowing before debugging this again:
//  - Setting the collection behavior is NOT what puts the overlay on the Space you
//    are looking at; the ordering call is (see presentOverlayWindow).
//  - Electron's NSPanel subclass force-ORs CanJoinAllSpaces|FullScreenAuxiliary into
//    every setCollectionBehavior:, so `false` here cannot actually take the overlay
//    off other Spaces on macOS — the preference only bites on Linux.
//  - `skipTransformProcessType` keeps Stem a regular (dock-icon) app, and since
//    10.14 a regular app's window cannot float over ANOTHER app's full-screen
//    Space. Ordinary Desktop Spaces are unaffected; full-screen ones need an
//    accessory-app policy we deliberately don't adopt.
function applyOverlayWorkspaceVisibility(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.setVisibleOnAllWorkspaces(overlayOnAllDisplays, workspaceVisibilityOptions());
  }
}

/**
 * Create the main window. `hidden` is for a cold `stem --quick-chat` launch (the
 * DE-bound summon path): the window still loads — the backend prewarm and every
 * push destination hang off it — but the user only sees the overlay they asked
 * for. The tray's "Open Stem", a plain `stem`, or activation reveals it.
 */
function createWindow(hidden = false): void {
  mainPushQueue.reset();
  mainWindow = new BrowserWindow({
    show: !hidden,
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
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

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
  mainWindow.on('blur', syncMainHud);
  mainWindow.on('focus', () => {
    if (hud.owner === 'main') hideHud();
  });
  // Clear the taskbar/urgency flash raised by requestAttention (no-op on macOS,
  // where attention is a dock bounce that clears itself).
  if (!isMac) {
    const flashed = mainWindow;
    flashed.on('focus', () => {
      if (!flashed.isDestroyed()) flashed.flashFrame(false);
    });
  }

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
  // On macOS the window IS the card (native shadow drawn outside); elsewhere the
  // window is grown by OVERLAY_SHADOW_INSET so the CSS shadow has room inside it.
  const outer = overlayOuterBounds({ x: 0, y: 0, width: QUICK_CHAT_WIDTH, height: QUICK_CHAT_HEIGHT });
  quickChatWindow = new BrowserWindow({
    width: outer.width,
    height: outer.height,
    frame: false,
    // macOS: an NSPanel with native vibrancy — keyboard focus WITHOUT activating
    // Stem (the Spotlight/Raycast overlay contract), frosting, rounded corners and
    // the drop shadow all drawn natively. Elsewhere: a plain transparent frameless
    // window; the renderer draws the card in CSS and summoning activates the app.
    // See overlayWindowOptions.
    ...overlayWindowOptions(),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
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
  hudWindow.setVisibleOnAllWorkspaces(true, workspaceVisibilityOptions());
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

/** Play the finish chime: macOS system sound, or the HUD window's bundled asset. */
function playFinishChime(): void {
  platformFinishChime(hudWindow);
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
  const enteredFinished = hud.notePush(owner, status.phase);
  // Stamp the live accelerator so the pill prompts the real summon key, not Enter.
  win.webContents.send('quickchat:status', { ...status, shortcut: currentShortcut });
  if (enteredFinished && finishSound) playFinishChime();
}

function hideHud(): void {
  if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) hudWindow.hide();
  hud.noteHidden();
}

function finishOverlayReset(): void {
  overlay.releaseThread();
  overlayResetBarrier.settle();
}

/**
 * HUD state machine, driven by the overlay-owned thread's event stream. Only runs
 * while the overlay is hidden (when it's visible the user is reading, no HUD):
 *   working  -> "Thinking…" / "Searching the web…" / "Using a tool…"
 *   answering -> once the first answer text streams
 *   finished  -> once the turn completes
 */
function driveHud(event: { method: string; params: unknown }): void {
  const overlayVisible = quickChatWindow?.isVisible() ?? false;
  switch (event.method) {
    case 'item/started': {
      if (overlayVisible) break;
      const item = (event.params as ItemEventParams)?.item;
      const type = item?.type;
      // Always update — tool calls and teed web searches mid-answer keep the
      // pill live instead of freezing at 'Answering…' after the first token.
      if (type && type !== 'agentMessage')
        showHud({ phase: 'working', label: activityLabel(type, item?.name, item?.detail) }, 'quickchat');
      break;
    }
    case 'item/agentMessage/delta': {
      if (overlayVisible) break;
      // Deltas arrive per token; only push when the label actually changes
      // (first token, or resuming the answer after a mid-answer tool call).
      if (!overlay.hudTextSeen || hud.lastPhase !== 'answering') {
        overlay.noteAnswerText();
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
      overlay.settleTurn(Date.now());
      // A reset must not release the old thread until this terminal event has
      // been routed. Otherwise its trailing deltas can be mistaken for the next
      // Quick Chat session.
      if (overlayResetBarrier.pending) {
        overlay.resetHudText();
        if (hud.owner === 'quickchat') hideHud();
        finishOverlayReset();
      } else if (!overlayVisible) {
        showHud({ phase: 'finished', label }, 'quickchat');
      }
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
    if (hud.owner === 'main') hideHud();
    return;
  }
  if (hud.owner === 'quickchat') return;
  const blurred = !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused();
  const running = runningMainThreads.size > 0;
  if (running && blurred) {
    showHud({ phase: 'working', label: 'Working…', reveal: 'main' }, 'main');
  }
}

/**
 * Track which main-window threads are running and drive the follow-me pill. The
 * 'finished' transition (and its chime) only fires when the pill is already
 * shown for the main app (hud.owner === 'main') — i.e. the user is away.
 */
function noteMainThreadEvent(method: string, threadId: string): void {
  if (method === 'item/started' || method === 'item/agentMessage/delta') {
    runningMainThreads.add(threadId);
    syncMainHud(); // handles a thread that starts while you're already away
  } else if (method === 'turn/completed' || method === 'turn/failed' || method === 'turn/aborted') {
    runningMainThreads.delete(threadId);
    if (hud.owner === 'main' && runningMainThreads.size === 0) {
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
  // Card bounds → window bounds (identical on macOS; grown by the CSS-shadow
  // inset elsewhere, keeping the visible card in the same place on every OS).
  win.setBounds(
    overlayOuterBounds({
      x: Math.round(workArea.x + (workArea.width - w) / 2),
      y: Math.round(workArea.y + workArea.height * 0.22),
      width: w,
      height: h
    })
  );
  // Surface the panel on whatever Space the user is on and make it the key window
  // so it receives keystrokes (typing, Escape) — without activating Stem, so the
  // previous app stays active underneath and the main window is never pulled
  // forward. The macOS ordering is subtle; see presentOverlayWindow.
  presentOverlayWindow(win);
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
  const reset = overlay.shouldStartFresh(Date.now(), newThreadTimeoutMs);
  if (reset) overlay.clearForFreshSession();
  showQuickChat(reset);
}

/** (Re)register the global accelerator. Returns false when registration fails. */
function applyQuickChatShortcut(accelerator: string | null): boolean {
  desiredShortcut = accelerator;
  if (currentShortcut) {
    globalShortcut.unregister(currentShortcut);
    currentShortcut = null;
  }
  if (!accelerator) return true;
  try {
    const ok = globalShortcut.register(accelerator, toggleQuickChat);
    if (ok) currentShortcut = accelerator;
    else log('main', 'global shortcut refused by the OS', { accelerator });
    return ok;
  } catch (error) {
    log('main', 'global shortcut registration failed', { accelerator, error: String(error) });
    return false;
  }
}

/**
 * What Settings needs to tell the truth about the summon key: the configured
 * accelerator, whether the OS actually granted the grab, and — on Wayland, where
 * a granted grab still never fires — the command to bind in the DE instead.
 */
function quickChatShortcutStatus(): QuickChatShortcutStatus {
  return {
    accelerator: desiredShortcut,
    registered: !!desiredShortcut && currentShortcut === desiredShortcut,
    wayland: isWaylandSession(),
    summonCommand: quickChatSummonCommand()
  };
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

/**
 * Send to every phone connected to the bridge (see startup/mobile.ts). The
 * third push destination alongside the main window and the overlay: a no-op when
 * the bridge is off or nothing is connected, and silently dropped for any
 * channel not on the mobile push allowlist.
 */
function sendToMobile(channel: string, payload: unknown): void {
  pushToMobile(channel, payload);
}

async function captureQuickChatHandoff(threadId: string): Promise<{
  id: string;
  snapshot: QuickChatHandoff;
} | null> {
  const win = quickChatWindow;
  if (!win || win.isDestroyed()) return null;
  const ticket = overlayHandoffBarrier.begin(threadId);
  if (ticket.fresh) win.webContents.send('quickchat:handoffRequest', { id: ticket.id, threadId });
  const timer = setTimeout(() => {
    const buffered = overlayHandoffBarrier.cancel(ticket.id);
    for (const event of buffered) {
      if (!win.isDestroyed()) win.webContents.send('backend:event', event);
      driveHud(event);
    }
  }, 30_000);
  const snapshot = await ticket.promise;
  clearTimeout(timer);
  if (!snapshot) return null;
  // Keep the barrier installed until the caller flips ownership. Otherwise an
  // event can arrive between this await and chats:open marking the overlay as
  // handed off, and be routed back to Quick Chat after its snapshot was taken.
  return { id: ticket.id, snapshot };
}

/** Bring the main window to the front (recreating it if it was closed). */
function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow!;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Test seam: when STEM_E2E is set, createBackend() returns the hermetic
// FakeBackend (see backend/fake.ts) — real IPC, event routing, renderers,
// Recall, and scheduler over deterministic scripted turns. The remaining
// E2E branches below fake only what lives OUTSIDE the backend seam: network
// probes, browser OAuth, and the embedding worker (model downloads).
const E2E = !!process.env.STEM_E2E;

// In-app provider sign-in (OAuth / API key) for the onboarding wizard; created in
// the whenReady bootstrap alongside the runtime.
let providerAuth: ProviderAuth | null = null;

/** Pick a sensible app default from the models the signed-in providers expose. */
function chooseDefaultModel(models: ModelSummary[]): string | null {
  const pick =
    models.find((m) => m.provider === 'openai-codex' && m.id.endsWith('gpt-5.3-codex-spark')) ??
    models.find((m) => m.provider === 'anthropic' && /sonnet/i.test(m.id)) ??
    models.find((m) => m.provider === 'anthropic') ??
    models.find((m) => m.provider === 'xai' && /grok-4/.test(m.id)) ??
    models.find((m) => m.provider === 'xai') ??
    models[0];
  return pick?.id ?? null;
}

/**
 * Post-sign-in sequence: persist a default model matching the new provider,
 * restart pi so it re-reads auth.json (it loads credentials once at spawn),
 * and bring up the scheduler. Returns the fresh status for the renderer.
 */
async function onAuthenticated(): Promise<RuntimeStatus> {
  try {
    // listModels spawns pi if needed (doubles as the wizard's prewarm) and is
    // already filtered to providers with credentials.
    const models = await runtime!.listModels();
    const current = (await readSettings()).defaults.model;
    if (!current || !models.some((m) => m.id === current)) {
      // Re-pick when unset or the provider that served the default is gone; an
      // empty list (last provider disconnected) clears it back to the constant.
      await updateDefaultModel(chooseDefaultModel(models));
    }
  } catch {
    // model list unavailable — keep the built-in default
  }
  // Apply fresh credentials + the new default to the running process.
  await runtime!.restart().catch(() => undefined);
  void scheduler?.start();
  return runtime!.status();
}

// Local embedding worker manager (created in the whenReady bootstrap; null until
// then and under E2E, where downloading model weights would break hermeticity).
let embedManager: EmbedWorkerManager | null = null;
// Recall scan worker manager (cosine scans + episodic VACUUM off the main event
// loop). Created in the whenReady bootstrap; the worker itself spawns lazily.
let scanManager: ScanWorkerManager | null = null;

/**
 * A web-search credential only reaches the search tools on a fresh pi process
 * (see needsBackendRestart), so an edit has to respawn the backend. Debounced
 * because the Settings pane persists keys per keystroke — a restart per character
 * would be absurd — and skipped while a turn is streaming, so pasting a key can
 * never kill a reply in progress. The next spawn picks the file up regardless, so
 * a skipped restart costs correctness nothing beyond the current process.
 */
const WEB_SEARCH_RESTART_DEBOUNCE_MS = 2_000;
let webSearchRestartTimer: NodeJS.Timeout | null = null;

function scheduleWebSearchRestart(): void {
  if (webSearchRestartTimer) clearTimeout(webSearchRestartTimer);
  webSearchRestartTimer = setTimeout(() => {
    webSearchRestartTimer = null;
    if (runtime && !runtime.isTurnRunning()) void runtime.restart().catch(() => undefined);
  }, WEB_SEARCH_RESTART_DEBOUNCE_MS);
}

function registerIpc(): void {
  ipcMain.on('renderer:ready', (event) => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    for (const { channel, payload } of mainPushQueue.markReady()) win.webContents.send(channel, payload);
  });

  ipcMain.on('quickchat:handoffSnapshot', (event, id: string, payload: QuickChatHandoff) => {
    const win = quickChatWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    overlayHandoffBarrier.supply(id, payload);
  });

  handleIpc('runtime:status', (): Promise<RuntimeStatus> => runtime!.status());
  handleIpc('runtime:login', async () => {
    const status = await runtime!.login();
    // Signing in mid-session: start the scheduler now (idempotent) so tasks load and
    // catch-up runs without waiting for a restart.
    if (status.ok) void scheduler?.start();
    return status;
  });

  // Per-domain IPC surfaces (auth/providers, skills/files/cfolders/tasks/dialogs,
  // MCP + approvals, memory, chats/folders) live in ./ipc/*; they reach the
  // late-bound singletons through getters so registration can happen up front.
  const deps: IpcDeps = {
    e2e: E2E,
    runtime: () => runtime!,
    scheduler: () => scheduler,
    providerAuth: () => providerAuth,
    embedManager: () => embedManager,
    mainWindow: () => mainWindow,
    sendToMain,
    onAuthenticated,
    scheduleMemoryRebuild: () => scheduleMemoryRebuild(),
    scheduleFolderIndexScan: (delayMs) => scheduleFolderIndexScan(delayMs),
    scheduleFolderLearn: (delayMs) => scheduleFolderLearn(delayMs)
  };
  registerAuthIpc(deps);
  registerWorkspaceIpc(deps);
  registerMcpIpc(deps);
  registerMemoryIpc(deps);
  registerChatsIpc(deps);

  handleIpc('backend:startTurn', async (_e, input: StartTurnInput) => {
    // The user is actively chatting: yield any scheduler-owned turn (frees the
    // foreground gate) and hold scheduled runs off for a while.
    lastInteractiveAt = Date.now();
    scheduler?.preemptForUser();
    // Main-window turns honor the main web-search toggle (the bridge extension
    // activates/deactivates the search tools for the turn to match).
    const settings = await readSettings();
    // Main-window turns get the Main custom instructions (which also cover Quick Chat
    // by inheritance; Quick Chat's own turns add their extra on top — see quickchat:run).
    return runtime!.startTurn({
      ...input,
      webSearch: settings.webSearch.main,
      instructions: settings.customInstructions.main
    });
  });
  handleIpc('backend:interruptTurn', (_e, turnId: string) => {
    lastInteractiveAt = Date.now();
    return runtime!.interruptTurn(turnId);
  });
  handleIpc('backend:newConversation', () => runtime!.newConversation());
  handleIpc('backend:listModels', () => runtime!.listModels());

  handleIpc('runtime:restart', async () => {
    await runtime!.restart();
    return runtime!.status();
  });

  handleIpc('chats:open', async (_e, threadId: string) => {
    // Opening the overlay's live thread from the sidebar is an implicit hand-off:
    // route its events to the main window and drop the overlay/HUD so the two
    // views don't diverge.
    if (overlay.owns(threadId)) {
      const captured = await captureQuickChatHandoff(threadId);
      if (!captured) {
        // A simultaneous explicit Open-in-Stem action may already have completed
        // the same transition and cancelled this sidebar request.
        if (!overlay.handedOff) {
          showQuickChat(false);
          throw new Error('Quick Chat did not return a handoff snapshot. Try Open in Stem again.');
        }
      } else {
        // Flip ownership before removing the event barrier. Events arriving
        // before commit stay buffered; events arriving after it route directly
        // to the main renderer.
        const flippedHere = overlay.claimHandoff();
        const transition = overlayHandoffBarrier.commit(captured.id);
        if (!transition) {
          // An explicit handoff may have won while this handler was awaiting the
          // snapshot. Only restore ownership when no other path completed it.
          if (flippedHere) {
            overlay.revertHandoff();
            showQuickChat(false);
            throw new Error('Quick Chat handoff was interrupted. Try Open in Stem again.');
          }
        } else {
          overlay.stopTurn();
          hideHud();
          hideOverlayWindow();
          sendToMain('quickchat:adopt', transition.snapshot);
          for (const bufferedEvent of transition.events) {
            sendToMain('backend:event', bufferedEvent);
            noteMainThreadEvent(bufferedEvent.method, threadId);
          }
        }
      }
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

  // ---- settings + quick chat ----
  handleIpc('settings:get', () => readSettings());
  handleIpc('quickchat:shortcutStatus', () => quickChatShortcutStatus());
  handleIpc('settings:updateQuickChat', async (_e, patch: Partial<QuickChatSettings>) => {
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
      if (!followAcrossSpaces && hud.owner === 'main') hideHud();
    }
    if ('finishSound' in patch) finishSound = next.quickChat.finishSound;
    return next;
  });
  handleIpc('settings:updateWebSearch', async (_e, patch: Partial<WebSearchSettings>) => {
    const next = await updateWebSearch(patch);
    // The per-context on/off booleans are applied per turn (the runtime writes the
    // gate the bridge reads, based on the originating context) — nothing to do here.
    // A backend/key change is different: it lives in <piHome>/web-search.json, which
    // pi-web-access reads, so rewrite that file whenever those fields move.
    if (needsWebSearchConfigWrite(patch)) {
      await writeWebSearchConfig(next.webSearch).catch((err: unknown) =>
        log('websearch', 'failed to write web-search.json', { error: String(err) })
      );
      if (needsBackendRestart(patch)) scheduleWebSearchRestart();
    }
    return next;
  });
  handleIpc('settings:updateEscapeAction', async (_e, action: EscapeAction) => {
    // Just persist — the renderer reads escapeAction fresh from settings (mount +
    // window focus) and acts on it locally in the composer.
    return updateEscapeAction(action);
  });
  handleIpc('settings:updateMemory', async (_e, patch: Partial<MemoryModelSettings>) => {
    // Just persist — the LlmClient closures read the model fresh from settings on
    // each memory turn, so the change applies to the next distill/tidy-up.
    return updateMemorySettings(patch);
  });
  handleIpc('settings:updateSkills', async (_e, patch: Partial<SkillsModelSettings>) => {
    // Just persist — the curator's LlmClient reads the model fresh from settings on
    // each pass, so the change applies to the next curation run.
    return updateSkillsSettings(patch);
  });
  handleIpc('settings:updateExec', async (_e, patch: Partial<ExecSettings>) => {
    // Just persist — the ExecService reads the policy fresh from settings on each
    // run_command request, so the change applies to the next command.
    return updateExecSettings(patch);
  });
  handleIpc('exec:resolveApproval', async (_e, id: string, decision: ExecDecision) => {
    execService?.resolveApproval(id, decision);
  });
  handleIpc('settings:updateCustomInstructions', async (_e, patch: Partial<CustomInstructionsSettings>) => {
    // Just persist — startTurn/quickchat:run read the instructions fresh per turn, so
    // the change applies to the next turn with no restart.
    return updateCustomInstructions(patch);
  });
  handleIpc('settings:updateRetrieval', async (_e, patch: PartialRetrievalSettings) => {
    // Persist — the embeddings/rerank clients read their config fresh from settings
    // on each turn, so the change applies to the next fact-ranking pass. The local
    // worker is the one stateful piece: kick it immediately on a mode/model change
    // so the download/load starts now rather than on the next turn.
    const before = (await readSettings()).retrieval;
    const next = await updateRetrievalSettings(patch);
    const after = next.retrieval;
    if (
      embedManager &&
      (before.embeddings.mode !== after.embeddings.mode ||
        before.embeddings.localModel !== after.embeddings.localModel)
    ) {
      if (after.embeddings.mode === 'local') embedManager.reconfigure(EMBED_CATALOG[after.embeddings.localModel]);
      else if (before.embeddings.mode === 'local') embedManager.reconfigure(null);
    }
    if (
      embedManager &&
      (before.reranker.mode !== after.reranker.mode || before.reranker.localModel !== after.reranker.localModel)
    ) {
      if (after.reranker.mode === 'local') embedManager.reconfigureRerank(RERANK_CATALOG[after.reranker.localModel]);
      else if (before.reranker.mode === 'local') embedManager.reconfigureRerank(null);
    }
    return next;
  });
  handleIpc('settings:testRetrieval', async (_e, stage: RetrievalStage): Promise<RetrievalTestResult> => {
    // Live one-shot probe of the configured backend so the user can confirm it
    // actually responds (the fact-ranking path is otherwise silent).
    const retrieval = (await readSettings()).retrieval;
    const startedAt = Date.now();
    if (stage === 'embeddings' && retrieval.embeddings.mode !== 'remote') {
      const emb = retrieval.embeddings;
      if (emb.mode === 'off') return { ok: false, detail: 'Embeddings are off.' };
      // Local mode: Test doubles as the "start/retry the download" button — force
      // past the error-retry gate, then report where the worker is right now.
      if (!embedManager) return { ok: false, detail: 'Embedding worker not started yet.' };
      const spec = EMBED_CATALOG[emb.localModel];
      embedManager.ensure(spec, { force: true });
      const st = embedManager.status();
      if (st.state === 'error') return { ok: false, detail: st.error ?? 'model failed to load' };
      if (st.state !== 'ready' || st.model !== spec.id) {
        return {
          ok: true,
          detail: st.state === 'downloading' ? `downloading model — ${st.progressPct ?? 0}%` : 'loading model…'
        };
      }
      try {
        const [vec] = await embedManager.embed(['Stem retrieval test'], 'query');
        return { ok: true, detail: `${vec.length}-dim · ${Date.now() - startedAt} ms · local` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'embed failed' };
      }
    }
    if (stage === 'reranker' && retrieval.reranker.mode !== 'remote') {
      const rr = retrieval.reranker;
      if (rr.mode === 'off') return { ok: false, detail: 'Reranker is off.' };
      // Local mode: Test doubles as the "start/retry the download" button, same
      // contract as the embeddings branch above.
      if (!embedManager) return { ok: false, detail: 'Embedding worker not started yet.' };
      const spec = RERANK_CATALOG[rr.localModel];
      embedManager.ensureRerank(spec, { force: true });
      const st = embedManager.rerankStatus();
      if (st.state === 'error') return { ok: false, detail: st.error ?? 'model failed to load' };
      if (st.state !== 'ready' || st.model !== spec.id) {
        return {
          ok: true,
          detail: st.state === 'downloading' ? `downloading model — ${st.progressPct ?? 0}%` : 'loading model…'
        };
      }
      try {
        const ranked = await embedManager.rerank('pets', ['I have a dog', 'the sky is blue'], 2);
        return { ok: true, detail: `ranked ${ranked.length} · ${Date.now() - startedAt} ms · local` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'rerank failed' };
      }
    }
    const cfg = stage === 'embeddings' ? retrieval.embeddings : retrieval.reranker;
    if (!cfg.baseUrl || !cfg.model) return { ok: false, detail: 'Set a base URL and model first.' };
    const getCfg = async () => ({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey });
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
  handleIpc('quickchat:run', async (_e, prompt: QuickChatPrompt): Promise<StartTurnResult> => {
    // Quick Chat is the latency-sensitive surface — yield any scheduler-owned turn.
    lastInteractiveAt = Date.now();
    scheduler?.preemptForUser();
    // Start the disappear→HUD half of the cycle immediately — before the (async)
    // thread creation — so the overlay never flashes the half-laid-out panel.
    overlay.beginTurn(Date.now());
    // Hide just the overlay (NOT app.hide — that would also hide the HUD we're
    // about to show, and re-showing the HUD would reactivate the app and surface
    // the main window). The overlay is a non-activating panel, so hiding it does
    // not promote the main window. The HUD is non-focusable, so it never steals
    // focus from whatever app the user is in.
    hideOverlayWindow();
    showHud({ phase: 'working', label: 'Working…' }, 'quickchat');

    try {
      const continuing = overlay.owns(prompt.threadId);
      let threadId = continuing ? overlay.threadId! : null;
      if (!threadId) {
        threadId = await runtime!.createThread(prompt.model ?? undefined);
        overlay.adoptThread(threadId);
        // Optimistic sidebar row so the quickchat thread shows immediately.
        sendToMain('quickchat:sessionStarted', {
          threadId,
          title: prompt.input.trim() || 'New chat'
        });
      }

      const qcSettings = await readSettings();
      const ci = qcSettings.customInstructions;
      const result = await runtime!.startTurn({
        input: prompt.input,
        threadId,
        model: prompt.model ?? undefined,
        effort: prompt.effort ?? undefined,
        serviceTier: prompt.serviceTier,
        format: prompt.format,
        // Quick Chat turns honor the Quick Chat native-web-search toggle.
        webSearch: qcSettings.webSearch.quickChat,
        // Quick Chat inherits the Main instructions and appends its own extra.
        instructions: [ci.main, ci.quickChat].map((s) => s.trim()).filter(Boolean).join('\n'),
        attachments: prompt.attachments
      });
      overlay.noteActivity(Date.now());
      if (overlay.handedOff && result.threadId && result.turnId) {
        // The snapshot can be captured while startTurn is still preparing Recall.
        // Publish the minted id as soon as prompt acceptance returns so Stop is
        // interruptible even before the first real item event.
        sendToMain('backend:event', {
          method: 'item/started',
          params: {
            threadId: result.threadId,
            turnId: result.turnId,
            item: { id: `agent-${result.turnId}`, type: 'agentMessage' }
          },
          receivedAt: new Date().toISOString()
        } satisfies BackendEventEnvelope);
      }
      // The memory shortcut ("remember that …") completes with no stream — jump the
      // HUD straight to finished.
      if (result.handled) {
        overlay.stopTurn();
        showHud({ phase: 'finished', label: 'Answer ready' }, 'quickchat');
      }
      return result;
    } catch (e) {
      overlay.settleTurn(Date.now());
      hideHud();
      if (overlayResetBarrier.pending) finishOverlayReset();
      if (overlay.handedOff && overlay.threadId) {
        sendToMain('backend:event', {
          method: 'turn/failed',
          params: {
            threadId: overlay.threadId,
            turn: { id: `quick-start-${Date.now()}`, status: 'failed' },
            error: e instanceof Error ? e.message : String(e)
          },
          receivedAt: new Date().toISOString()
        } satisfies BackendEventEnvelope);
      } else {
        showQuickChat(false);
      }
      throw e;
    }
  });

  // Forget the current overlay thread so the next prompt opens a fresh one.
  handleIpc('quickchat:newThread', () => {
    overlay.prepareManualReset();
    hideHud();
    if (overlay.turnRunning) {
      return overlayResetBarrier.wait();
    } else {
      finishOverlayReset();
    }
  });

  // Hand the conversation off to the main window: route future events there,
  // reveal the main window, and have it adopt the thread as the active chat.
  handleIpc('quickchat:handoff', (_e, payload: QuickChatHandoff) => {
    const bufferedEvents = overlayHandoffBarrier.cancelCurrent();
    overlay.claimHandoff();
    overlay.stopTurn();
    if (overlayResetBarrier.pending) finishOverlayReset();
    hideHud();
    hideOverlayWindow();
    revealMainWindow();
    sendToMain('quickchat:adopt', payload);
    for (const bufferedEvent of bufferedEvents) {
      sendToMain('backend:event', bufferedEvent);
      noteMainThreadEvent(bufferedEvent.method, payload.threadId);
    }
  });

  // Re-summon the overlay (HUD click). Same path as the shortcut.
  handleIpc('quickchat:reveal', () => {
    if (!quickChatWindow?.isVisible()) toggleQuickChat();
  });

  // Raise the main window (follow-me pill click). Returning focus to the main
  // window fires the 'focus' handler, which hides the pill.
  handleIpc('main:reveal', () => revealMainWindow());

  handleIpc('quickchat:hide', () => {
    dismissQuickChat();
  });
}

// Last-resort diagnostics: an uncaught throw or rejection in main otherwise
// vanishes with the console. Log-and-continue — Electron's default for
// unhandledRejection is a warning, and killing main over a background hiccup
// (a failed distill, a dropped watcher) would take the whole app down.
process.on('uncaughtException', (e) => {
  log('main', 'uncaughtException', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
});
process.on('unhandledRejection', (reason) => {
  log('main', 'unhandledRejection', {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  });
});

app.whenReady().then(async () => {
  await ensureWorkspace();
  // Publish the read-only connected-folder roots so the backend extension enforces
  // them from the first turn (also rewritten on every Folders-tab mutation).
  await publishProtectedRootsNow().catch(() => undefined);
  // pi is the only backend; it satisfies ChatBackend so everything below is
  // backend-agnostic. Alternate profiles (--fresh / --profile) skip seeding auth
  // from the user's global ~/.pi so they start unauthenticated in the onboarding wizard.
  runtime = createBackend({ seedGlobalAuth: !profileOverride });

  // In-app provider sign-in for the onboarding wizard. Writes the same isolated
  // auth.json the pi subprocess reads; progress is pushed to the renderer.
  providerAuth = new ProviderAuth(join(piHome(), 'auth.json'), (event) => sendToMain('auth:event', event));

  // True while a turn runs on any surface — main window, overlay, or a phone on
  // the bridge — or the user interacted within `idleMs`. Drives the scheduler's
  // defer/preempt signal and lets the recall background passes yield to
  // interactive work. The phone counts even though nobody is at the Mac: a live
  // conversation is a live conversation.
  const busyWithin = (idleMs: number): boolean =>
    runningMainThreads.size > 0 ||
    overlay.turnRunning ||
    mobileTurnsInFlight() > 0 ||
    Date.now() - lastInteractiveAt < idleMs;

  scheduler = initTaskScheduler({
    runtime,
    sendToMain,
    isUserActive: () => busyWithin(USER_ACTIVE_WINDOW_MS),
    revealMainWindow,
    requestAttention: () => requestAttention(mainWindow)
  });

  // Command execution (the run_command tool): the ExecService owns the tiered
  // policy + spawn; approval cards go straight to the windows (both surfaces mount
  // the card), revealing Quick Chat when it owns the originating thread — same
  // pattern as the MCP-admin/instructions approvals.
  execService = initExecService({
    runtime,
    emitApprovalRequest: (request) => {
      if (request.threadId && overlay.owns(request.threadId)) showQuickChat(false);
      sendToMain('exec:approvalRequest', request);
      quickChatWindow?.webContents.send('exec:approvalRequest', request);
      sendToMobile('exec:approvalRequest', request);
    },
    emitApprovalResolved: (id) => {
      sendToMain('exec:approvalResolved', { id });
      quickChatWindow?.webContents.send('exec:approvalResolved', { id });
      sendToMobile('exec:approvalResolved', { id });
    }
  });

  // Background-activity feed for the toolbar indicator. Wired before the passes
  // below start reporting; main window only, since that is where the icon lives.
  setActivityEmitter((snapshot) => mainWindow?.webContents.send('activity:changed', snapshot));

  // Stem Recall relevance ranking + background workers: embed/scan utility
  // processes, retrieval clients (settings-mode routed), and the MCP embed
  // endpoint. See startup/retrieval.ts.
  const retrieval = initRetrieval({
    e2e: E2E,
    sendToMainWindow: (channel, payload) => mainWindow?.webContents.send(channel, payload)
  });
  embedManager = retrieval.embedManager;
  scanManager = retrieval.scanManager;

  // Skill usage tracking: anchor trackingSince and prune entries for deleted
  // skills. Unconditional — usage feeds the Manage panel regardless of the
  // recall toggle that gates the distill/curate passes below.
  ensureUsageTracking();

  // Stem Recall's background passes (distillation, summaries, consolidation,
  // skills, confirmed rebuild, dormant backfill) — see startup/recall-tasks.ts.
  // They yield to interactive work via busyWithin.
  const recallTasks = initRecallTasks({
    runtime: () => runtime!,
    busyWithin,
    sendToMainWindow: (channel, payload) => mainWindow?.webContents.send(channel, payload)
  });
  scheduleMemoryRebuild = recallTasks.scheduleMemoryRebuild;
  const { scheduleDistill, scheduleEpisodicEmbed } = recallTasks;

  // Indexed connected folders: startup kick + periodic incremental rescan
  // (mirror folders change from outside the app). See startup/folder-index-tasks.ts.
  const folderIndexTasks = initFolderIndexTasks({ runtime: () => runtime!, busyWithin });
  scheduleFolderIndexScan = folderIndexTasks.scheduleFolderIndexScan;
  scheduleFolderLearn = folderIndexTasks.scheduleFolderLearn;

  // Forward backend events to the main window. Registered once (not per-window) so
  // recreating the window can't double-subscribe.
  runtime.on('event', (event) => {
    // Stem-internal MCP self-management signals: deliver to the windows on their
    // own channels (never as a backend thread event, and never captured into recall).
    if (event.method === 'mcp/admin/approvalRequest') {
      const approvalThreadId = (event.params as { threadId?: string } | undefined)?.threadId;
      // Quick Chat hides itself while a turn runs. Bring the originating surface
      // back so mounting the card actually makes the confirmation visible.
      if (approvalThreadId && overlay.owns(approvalThreadId)) showQuickChat(false);
      sendToMain('mcp:adminApproval', event.params);
      quickChatWindow?.webContents.send('mcp:adminApproval', event.params);
      sendToMobile('mcp:adminApproval', event.params);
      return;
    }
    if (event.method === 'mcp/admin/approvalResolved') {
      sendToMain('mcp:adminApprovalResolved', event.params);
      quickChatWindow?.webContents.send('mcp:adminApprovalResolved', event.params);
      sendToMobile('mcp:adminApprovalResolved', event.params);
      return;
    }
    if (event.method === 'instructions/approvalRequest') {
      const approvalThreadId = (event.params as { threadId?: string } | undefined)?.threadId;
      if (approvalThreadId && overlay.owns(approvalThreadId)) showQuickChat(false);
      sendToMain('instructions:approvalRequest', event.params);
      quickChatWindow?.webContents.send('instructions:approvalRequest', event.params);
      sendToMobile('instructions:approvalRequest', event.params);
      return;
    }
    if (event.method === 'instructions/approvalResolved') {
      sendToMain('instructions:approvalResolved', event.params);
      quickChatWindow?.webContents.send('instructions:approvalResolved', event.params);
      sendToMobile('instructions:approvalResolved', event.params);
      return;
    }
    if (event.method === 'mcp/changed') {
      sendToMain('mcp:changed', undefined);
      quickChatWindow?.webContents.send('mcp:changed');
      return;
    }
    if (event.method === 'skills/changed') {
      sendToMain('skills:changed', undefined);
      quickChatWindow?.webContents.send('skills:changed');
      return;
    }
    if (event.method === 'mcp/status') {
      sendToMain('mcp:status', event.params);
      quickChatWindow?.webContents.send('mcp:status', event.params);
      sendToMobile('mcp:status', event.params);
      return;
    }
    const threadId = (event.params as { threadId?: string } | undefined)?.threadId;
    // Hidden internal threads (distillation) are neither shown nor captured.
    if (threadId && runtime!.isInternalThread(threadId)) return;
    // The overlay owns its live thread until hand-off: route its events to the
    // overlay window (which renders the conversation) and the status HUD, NOT the
    // main window — otherwise the main window would build a phantom user-less slice.
    const overlayOwned = overlay.owns(threadId);
    const handoffBuffered = !!threadId && overlayHandoffBarrier.buffer(threadId, event);
    if (handoffBuffered) {
      // captureQuickChatHandoff replays these immediately after the atomic snapshot.
    } else if (overlayOwned) {
      // Not mirrored to the phone: the overlay's live thread is a conversation
      // happening at the desk, and the phone would build the same phantom
      // user-less slice the main window would.
      quickChatWindow?.webContents.send('backend:event', event);
      driveHud(event);
    } else if (!threadId) {
      // Process-level events (e.g. process/exit) carry no threadId — let both
      // windows clear their run state, and clear the follow-me pill so a backend
      // crash never leaves a stuck "Working…" pill.
      const abandonedHandoffEvents = overlayHandoffBarrier.cancelCurrent();
      for (const bufferedEvent of abandonedHandoffEvents) {
        quickChatWindow?.webContents.send('backend:event', bufferedEvent);
        driveHud(bufferedEvent);
      }
      sendToMain('backend:event', event);
      quickChatWindow?.webContents.send('backend:event', event);
      // The phone needs these too, or a backend crash leaves it streaming
      // forever with no way to learn the turn is never coming.
      sendToMobile('backend:event', event);
      runningMainThreads.clear();
      clearMobileTurns();
      if (event.method === 'process/exit' && (overlay.turnRunning || overlayResetBarrier.pending)) {
        overlay.restore(failQuickChatProcess(Date.now(), overlay.threadId));
        if (hud.owner === 'quickchat') showHud({ phase: 'finished', label: 'Request failed' }, 'quickchat');
        if (overlayResetBarrier.pending) finishOverlayReset();
      }
      if (hud.owner === 'main') hideHud();
    } else {
      sendToMain('backend:event', event);
      noteMainThreadEvent(event.method, threadId);
      // Third destination: any non-internal thread the overlay doesn't own is
      // one the phone may be showing. It filters by threadId itself, exactly as
      // the main window does — the bridge doesn't track which thread is open.
      sendToMobile('backend:event', event);
      noteMobileTurnEvent(event.method, threadId, (event.params as { turn?: { id?: string } } | undefined)?.turn?.id);
    }
    if (isRecallEnabled()) {
      // Skip capture when the turn read inside a memorize:false connected folder, so
      // its (potentially confidential) reply never enters Recall. scheduleDistill still
      // runs — it only processes already-captured messages.
      if (!(threadId && runtime!.isCaptureSuppressed(threadId))) {
        captureFromEvent(event); // tap assistant replies into Stem Recall (all threads)
      }
      if (event.method === 'turn/completed') {
        scheduleDistill();
        scheduleEpisodicEmbed();
      }
    }
    // Chat search indexes the user's own chats in full — independent of the memory
    // toggle and of recall's memorize:false/taint gating (you must be able to find a
    // chat even if it was marked don't-remember). Re-index this thread once its turn
    // lands so the new messages are searchable without a relaunch.
    if (threadId && event.method === 'turn/completed') {
      void reindexChatThread(runtime!, threadId);
    }
  });

  // Backfill the chat-search index in the background a little after startup (never
  // blocking it). The per-thread watermark makes this a near no-op on every relaunch —
  // only chats changed since they were last indexed (or edited externally) get reread.
  setTimeout(() => void backfillChatIndex(runtime!), 8_000);

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
  // The phone bridge dispatches into the handlers registerIpc just installed, so
  // it can only be wired after it. Serving the mobile bundle out of the same
  // place the desktop renderer is loaded from keeps the two builds together.
  initMobileBridge({
    rendererDir: join(__dirname, '../renderer'),
    devUrl: process.env.ELECTRON_RENDERER_URL ?? null
  });
  void syncMobileBridge();
  // A cold `stem --quick-chat` must land on the overlay, not the main window:
  // that command IS the shortcut on Wayland (see the second-instance handler),
  // and pressing it with Stem closed should feel the same as pressing it with
  // Stem running. The overlay is summoned once it exists, below.
  const coldSummon = process.argv.includes('--quick-chat');
  createWindow(coldSummon);
  // Eagerly spawn pi + connect MCP once the window has painted, so the first prompt
  // doesn't pay backend cold-start. Skipped when not signed in (status() is cheap
  // and never spawns). did-finish-load keeps the spawn + MCP child processes off
  // the first-paint path. Fire-and-forget; races harmlessly with the renderer's
  // listModels warm (ensureStarted is idempotent). Under STEM_E2E the fake backend
  // reports authenticated (unless the onboarding sub-seam), so this same path
  // starts the scheduler for seeded tasks; prewarm/restart are no-ops on the fake.
  mainWindow?.webContents.once('did-finish-load', () => {
    void runtime!
      .status()
      .then(async (s) => {
        if (!s.ok) return;
        // Already authenticated (e.g. auth seeded from an existing ~/.pi): count
        // onboarding as done, so a LATER auth loss shows the compact re-sign-in
        // screen instead of the first-run welcome.
        const settings = await readSettings();
        if (!settings.onboarding.completed) await markOnboardingCompleted();
        // Start the scheduler only once signed in — runs are turns, which need a
        // working backend. This also runs any tasks missed while Stem was closed
        // (catch-up), exactly once each.
        void scheduler?.start();
        return runtime!.prewarm();
      })
      .catch(() => {});
  });
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
  if (coldSummon) toggleQuickChat();
  // Linux-only for now: the tray is the discoverable summon/quit affordance where
  // there's no dock and (on Wayland) no working global shortcut. Skipped under
  // STEM_E2E to keep the harness's window/process accounting deterministic.
  if (isLinux && !E2E) {
    initTray({
      icon: appIcon,
      onToggleQuickChat: toggleQuickChat,
      onOpenStem: revealMainWindow
    });
  }

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
  if (webSearchRestartTimer) clearTimeout(webSearchRestartTimer);
  scheduler?.stop();
  embedManager?.dispose();
  scanManager?.dispose();
  closeFolderIndexes();
  // Destroys any open SSE stream before closing the listener — without that,
  // close() waits for a connection that by design never ends.
  void closeMobileBridge();
  runtime.shutdown().finally(() => app.exit(0));
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
