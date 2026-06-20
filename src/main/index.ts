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
import { CodexRuntime } from './codex/runtime';
import { ensureWorkspace } from './workspace/bootstrap';
import { codexHome, workspaceRoot } from './workspace/paths';
import { listSkills, setSkillEnabled } from './workspace/skills';
import { addMcpServer, listMcpServers, removeMcpServer } from './workspace/mcp';
import { getMemorySettings, readMemoryFiles, setMemoryEnabled } from './workspace/memory';
import { readSettings, updateQuickChat } from './workspace/settings';
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
import type {
  ChatListResult,
  McpServerInput,
  QuickChatPrompt,
  QuickChatSettings,
  StartTurnInput
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
let runtime: CodexRuntime | null = null;
/** The currently-registered global accelerator, so we can unregister on change. */
let currentShortcut: string | null = null;
/** Cached "show overlay on all Spaces" setting, applied once per overlay window. */
let overlayOnAllDisplays = true;
/**
 * Whether Stem's main window was the frontmost window the instant the overlay was
 * summoned. Drives dismissal: when the overlay was summoned from *another* app we
 * yield focus back to that app (app.hide) instead of letting macOS surface the
 * main window; when summoned from within Stem we leave the main window be.
 */
let mainFocusedBeforeOverlay = false;

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

const QUICK_CHAT_WIDTH = 640;
const QUICK_CHAT_HEIGHT = 150;

function createQuickChatWindow(): void {
  quickChatWindow = new BrowserWindow({
    width: QUICK_CHAT_WIDTH,
    height: QUICK_CHAT_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false, // shadow is drawn in CSS so it follows the rounded card
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
  // Spotlight-style: dismiss as soon as focus leaves the overlay.
  quickChatWindow.on('blur', () => {
    if (quickChatWindow?.isVisible()) quickChatWindow.hide();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    quickChatWindow.loadURL(`${devUrl}/?quickchat`);
  } else {
    quickChatWindow.loadFile(join(__dirname, '../renderer/index.html'), { search: 'quickchat' });
  }
}

function showQuickChat(): void {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) createQuickChatWindow();
  const win = quickChatWindow!;

  // Remember whether we're summoning from within Stem (main window frontmost) so
  // dismissal knows whether to yield focus back to the previous app.
  mainFocusedBeforeOverlay =
    !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();

  // Center horizontally on the display under the cursor, in the upper third.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [w, h] = win.getSize();
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + workArea.height * 0.22),
    width: w,
    height: h
  });
  // show() already makes the window key on macOS; a separate focus() call just
  // adds activation churn (and can pull the main window forward), so we omit it.
  win.show();
  win.webContents.send('quickchat:focus');
}

/**
 * Hide the overlay on an explicit dismiss (Escape, or the shortcut pressed again).
 * On macOS, hiding the overlay normally makes macOS promote the next window of the
 * active app — Stem's main window — to the foreground, which the user doesn't want.
 * When the overlay was summoned from another app, app.hide() yields focus back to
 * that previous app so the main window stays put. When it was summoned from within
 * Stem, we leave the main window alone.
 */
function dismissQuickChat(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible()) {
    quickChatWindow.hide();
  }
  if (process.platform === 'darwin' && !mainFocusedBeforeOverlay) app.hide();
}

function toggleQuickChat(): void {
  if (quickChatWindow && quickChatWindow.isVisible()) dismissQuickChat();
  else showQuickChat();
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
  ipcMain.handle('codex:startTurn', (_e, input: StartTurnInput) => runtime!.startTurn(input));
  ipcMain.handle('codex:interruptTurn', (_e, turnId: string) => runtime!.interruptTurn(turnId));
  ipcMain.handle('codex:newConversation', () => runtime!.newConversation());
  ipcMain.handle('dialog:openFiles', () =>
    dialog
      .showOpenDialog(mainWindow!, { properties: ['openFile', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths))
  );
  ipcMain.handle('codex:listModels', () => runtime!.listModels());

  ipcMain.handle('skills:list', () => listSkills());
  ipcMain.handle('skills:setEnabled', (_e, slug: string, enabled: boolean) => setSkillEnabled(slug, enabled));

  ipcMain.handle('mcp:list', () => listMcpServers());
  ipcMain.handle('mcp:add', (_e, input: McpServerInput) => addMcpServer(input));
  ipcMain.handle('mcp:remove', (_e, name: string) => removeMcpServer(name));
  ipcMain.handle('mcp:login', (_e, name: string) => runtime!.mcpLogin(name));
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

  // ---- chats + folders ----
  // Chats come from codex's thread store; folders/assignments from the Stem
  // store. We merge them here so the runtime stays codex-only and the store
  // stays codex-unaware.
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
    await runtime!.resumeThread(threadId);
    const { title, messages } = await runtime!.readThread(threadId);
    return { threadId, title, messages };
  });
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
    return next;
  });
  ipcMain.handle('quickchat:submit', (_e, prompt: QuickChatPrompt) => {
    quickChatWindow?.hide();
    revealMainWindow();
    mainWindow?.webContents.send('quickchat:prompt', prompt);
  });
  ipcMain.handle('quickchat:hide', () => {
    dismissQuickChat();
  });
}

app.whenReady().then(async () => {
  await ensureWorkspace();
  runtime = new CodexRuntime({ codexHome: codexHome(), workspaceRoot: workspaceRoot() });

  // Forward codex events to the main window. Registered once (not per-window) so
  // recreating the window can't double-subscribe.
  runtime.on('event', (event) => {
    mainWindow?.webContents.send('codex:event', event);
  });

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
  createQuickChatWindow();
  applyQuickChatShortcut(initialSettings.quickChat.shortcut);

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
}).catch((error) => {
  console.error('Failed to start Stem:', error);
  app.quit();
});

// Shut the app-server down gracefully before quitting. Codex drains its
// background memory jobs on SIGTERM; an abrupt kill orphans their leases and
// silently stalls memory generation. preventDefault + await gives it that
// window, then we exit for real (shutdown has its own SIGKILL backstop).
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
