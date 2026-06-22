import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session
} from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend, type ChatBackend } from './backend';
import { ensureWorkspace } from './workspace/bootstrap';
import { listSkills, setSkillEnabled } from './workspace/skills';
import { addFiles, listFiles, removeFile, revealFiles } from './files/store';
import { imagePreviewDataUrl } from './pi/attachments';
import * as piMcp from './pi/mcp';
import { forgetFact, getMemorySettings, isRecallEnabled, readMemoryFiles, setMemoryEnabled } from './workspace/memory';
import { captureFromEvent } from './recall/capture';
import { distillNewMessages, shouldConsolidate } from './recall/distill';
import { consolidateFacts } from './recall/consolidate';
import type { LlmClient } from './recall/llm';
import { readSettings, updateMemorySettings, updateNativeWebSearch, updateQuickChat } from './workspace/settings';
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
  ItemEventParams,
  McpServerInput,
  MemoryModelSettings,
  NativeWebSearchSettings,
  QuickChatHandoff,
  QuickChatPrompt,
  QuickChatSettings,
  QuickChatStatus,
  StartTurnInput,
  StartTurnResult
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

let mainWindow: BrowserWindow | null = null;
let quickChatWindow: BrowserWindow | null = null;
/** Bottom-left status pill shown while the overlay is hidden and a turn runs. */
let hudWindow: BrowserWindow | null = null;
let runtime: ChatBackend | null = null;
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
  for (const win of [quickChatWindow, hudWindow]) {
    if (win && !win.isDestroyed()) {
      win.setVisibleOnAllWorkspaces(overlayOnAllDisplays, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true
      });
    }
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

  mainWindow.on('closed', () => {
    mainWindow = null;
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

  hudWindow.setAlwaysOnTop(true, 'screen-saver');
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

/** Show the HUD pill (bottom-left of the display under the cursor) and push status. */
function showHud(status: QuickChatStatus): void {
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
  // Stamp the live accelerator so the pill prompts the real summon key, not Enter.
  win.webContents.send('quickchat:status', { ...status, shortcut: currentShortcut });
}

function hideHud(): void {
  if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) hudWindow.hide();
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
      const type = (event.params as ItemEventParams)?.item?.type;
      if (type && type !== 'agentMessage' && !hudTextSeen) showHud({ phase: 'working', label: activityLabel(type) });
      break;
    }
    case 'item/agentMessage/delta': {
      if (!hudTextSeen) {
        hudTextSeen = true;
        showHud({ phase: 'answering', label: 'Answering…' });
      }
      break;
    }
    case 'turn/completed':
    case 'turn/failed':
    case 'turn/aborted': {
      overlayTurnRunning = false;
      overlayLastActivityAt = Date.now();
      showHud({ phase: 'finished', label: 'Answer ready' });
      break;
    }
    default:
      break;
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

function registerIpc(): void {
  ipcMain.handle('runtime:status', () => runtime!.status());
  ipcMain.handle('runtime:login', () => runtime!.login());
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

  ipcMain.handle('files:list', () => listFiles());
  ipcMain.handle('files:add', (_e, paths: string[], subdir?: string) => addFiles(paths, subdir));
  ipcMain.handle('files:remove', (_e, rel: string) => removeFile(rel));
  ipcMain.handle('files:reveal', () => revealFiles());
  ipcMain.handle('files:preview', (_e, path: string) => imagePreviewDataUrl(path));

  ipcMain.handle('mcp:list', () => piMcp.listMcpServers());
  ipcMain.handle('mcp:status', () => runtime!.getMcpStatus());
  ipcMain.handle('mcp:add', (_e, input: McpServerInput) => piMcp.addMcpServer(input));
  ipcMain.handle('mcp:remove', (_e, name: string) => piMcp.removeMcpServer(name));
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
    await runtime!.restart();
    return settings;
  });
  ipcMain.handle('memory:read', () => readMemoryFiles());
  ipcMain.handle('memory:forget', async (_e, id: number) => {
    await forgetFact(id);
    return readMemoryFiles();
  });
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
    await runtime!.resumeThread(threadId);
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
    await runtime!.deleteThread(threadId);
    await removeChat(threadId);
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
    showHud({ phase: 'working', label: 'Working…' });

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
      showHud({ phase: 'finished', label: 'Answer ready' });
    }
    return result;
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

  ipcMain.handle('quickchat:hide', () => {
    dismissQuickChat();
  });
}

app.whenReady().then(async () => {
  await ensureWorkspace();
  // pi is the only backend; it satisfies ChatBackend so everything below is
  // backend-agnostic.
  runtime = createBackend();

  // Stem Recall: distill durable facts via a hidden backend turn (the swappable
  // LlmClient seam). Debounced so it runs ~after the user goes idle.
  const recallLlm: LlmClient = {
    complete: async (prompt) => runtime!.complete(prompt, { model: (await readSettings()).memory.model })
  };
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
      // windows clear their run state.
      mainWindow?.webContents.send('backend:event', event);
      quickChatWindow?.webContents.send('backend:event', event);
    } else {
      mainWindow?.webContents.send('backend:event', event);
    }
    if (isRecallEnabled()) {
      captureFromEvent(event); // tap assistant replies into Stem Recall (all threads)
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
  // Pre-create the overlay (hidden) so the shortcut summons it instantly, and
  // bind the global accelerator from the saved settings. Seed the all-Spaces
  // flag before creating the overlay so it's applied once, at creation.
  const initialSettings = await readSettings();
  overlayOnAllDisplays = initialSettings.quickChat.showOnAllDisplays;
  newThreadTimeoutMs = initialSettings.quickChat.newThreadTimeoutMs;
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
  runtime.shutdown().finally(() => app.exit(0));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
