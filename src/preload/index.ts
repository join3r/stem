import { contextBridge, ipcRenderer } from 'electron';
import type {
  CodexEventEnvelope,
  McpServerInput,
  StartTurnInput,
  StemApi
} from '../shared/types';

const api: StemApi = {
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  login: () => ipcRenderer.invoke('runtime:login'),
  startTurn: (input: StartTurnInput) => ipcRenderer.invoke('codex:startTurn', input),
  interruptTurn: (turnId: string) => ipcRenderer.invoke('codex:interruptTurn', turnId),
  onCodexEvent: (listener: (event: CodexEventEnvelope) => void) => {
    const handler = (_e: unknown, event: CodexEventEnvelope) => listener(event);
    ipcRenderer.on('codex:event', handler);
    return () => ipcRenderer.removeListener('codex:event', handler);
  },

  listSkills: () => ipcRenderer.invoke('skills:list'),
  setSkillEnabled: (slug: string, enabled: boolean) => ipcRenderer.invoke('skills:setEnabled', slug, enabled),

  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  addMcpServer: (input: McpServerInput) => ipcRenderer.invoke('mcp:add', input),
  removeMcpServer: (name: string) => ipcRenderer.invoke('mcp:remove', name),
  loginMcpServer: (name: string) => ipcRenderer.invoke('mcp:login', name),
  restartRuntime: () => ipcRenderer.invoke('runtime:restart'),

  getMemorySettings: () => ipcRenderer.invoke('memory:get'),
  setMemoryEnabled: (enabled: boolean) => ipcRenderer.invoke('memory:setEnabled', enabled)
};

contextBridge.exposeInMainWorld('stem', api);
