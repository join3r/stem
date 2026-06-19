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
  newConversation: () => ipcRenderer.invoke('codex:newConversation'),
  listModels: () => ipcRenderer.invoke('codex:listModels'),
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
  setMemoryEnabled: (enabled: boolean) => ipcRenderer.invoke('memory:setEnabled', enabled),
  readMemory: () => ipcRenderer.invoke('memory:read'),

  listChats: () => ipcRenderer.invoke('chats:list'),
  openChat: (threadId: string) => ipcRenderer.invoke('chats:open', threadId),
  renameChat: (threadId: string, name: string) => ipcRenderer.invoke('chats:rename', threadId, name),
  deleteChat: (threadId: string) => ipcRenderer.invoke('chats:delete', threadId),
  createFolder: (name: string, parentId: string | null) => ipcRenderer.invoke('folders:create', name, parentId),
  renameFolder: (folderId: string, name: string) => ipcRenderer.invoke('folders:rename', folderId, name),
  deleteFolder: (folderId: string) => ipcRenderer.invoke('folders:delete', folderId),
  moveFolder: (folderId: string, parentId: string | null) => ipcRenderer.invoke('folders:move', folderId, parentId),
  setChatFolder: (threadId: string, folderId: string | null) =>
    ipcRenderer.invoke('chats:setFolder', threadId, folderId)
};

contextBridge.exposeInMainWorld('stem', api);
