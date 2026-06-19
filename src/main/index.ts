import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRuntime } from './codex/runtime';
import { ensureWorkspace } from './workspace/bootstrap';
import { codexHome, workspaceRoot } from './workspace/paths';
import { listSkills, setSkillEnabled } from './workspace/skills';
import { addMcpServer, listMcpServers, removeMcpServer } from './workspace/mcp';
import { getMemorySettings, readMemoryFiles, setMemoryEnabled } from './workspace/memory';
import type { McpServerInput, StartTurnInput } from '../shared/types';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

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
