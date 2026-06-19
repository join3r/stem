import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, session } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRuntime } from './codex/runtime';
import { ensureWorkspace } from './workspace/bootstrap';
import { codexHome, workspaceRoot } from './workspace/paths';
import { listSkills, setSkillEnabled } from './workspace/skills';
import { addMcpServer, listMcpServers, removeMcpServer } from './workspace/mcp';
import { getMemorySettings, readMemoryFiles, setMemoryEnabled } from './workspace/memory';
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
import type { ChatListResult, McpServerInput, StartTurnInput } from '../shared/types';

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
let runtime: CodexRuntime | null = null;

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

  runtime!.on('event', (event) => {
    mainWindow?.webContents.send('codex:event', event);
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle('runtime:status', () => runtime!.status());
  ipcMain.handle('runtime:login', () => runtime!.login());
  ipcMain.handle('codex:startTurn', (_e, input: StartTurnInput) => runtime!.startTurn(input));
  ipcMain.handle('codex:interruptTurn', (_e, turnId: string) => runtime!.interruptTurn(turnId));
  ipcMain.handle('codex:newConversation', () => runtime!.newConversation());
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
}

app.whenReady().then(async () => {
  await ensureWorkspace();
  runtime = new CodexRuntime({ codexHome: codexHome(), workspaceRoot: workspaceRoot() });

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
