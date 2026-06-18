import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRuntime } from './codex/runtime';
import { ensureWorkspace } from './workspace/bootstrap';
import { codexHome, workspaceRoot } from './workspace/paths';
import { listSkills, setSkillEnabled } from './workspace/skills';
import { addMcpServer, listMcpServers, removeMcpServer } from './workspace/mcp';
import { getMemorySettings, setMemoryEnabled } from './workspace/memory';
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
    backgroundColor: '#faf9f6',
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
  ipcMain.handle('memory:setEnabled', (_e, enabled: boolean) => setMemoryEnabled(enabled));
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

app.on('before-quit', () => {
  runtime?.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
