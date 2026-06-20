import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  CodexEventEnvelope,
  McpServerInput,
  QuickChatPrompt,
  QuickChatSettings,
  StartTurnInput,
  StemApi
} from '../shared/types';

const api: StemApi = {
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  login: () => ipcRenderer.invoke('runtime:login'),
  startTurn: (input: StartTurnInput) => ipcRenderer.invoke('codex:startTurn', input),
  interruptTurn: (turnId: string) => ipcRenderer.invoke('codex:interruptTurn', turnId),
  newConversation: () => ipcRenderer.invoke('codex:newConversation'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
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
  rollbackToTurn: (threadId: string, turnId: string) =>
    ipcRenderer.invoke('chats:rollbackToTurn', threadId, turnId),
  forkThread: (threadId: string, turnId: string) => ipcRenderer.invoke('chats:forkThread', threadId, turnId),
  renameChat: (threadId: string, name: string) => ipcRenderer.invoke('chats:rename', threadId, name),
  deleteChat: (threadId: string) => ipcRenderer.invoke('chats:delete', threadId),
  createFolder: (name: string, parentId: string | null) => ipcRenderer.invoke('folders:create', name, parentId),
  renameFolder: (folderId: string, name: string) => ipcRenderer.invoke('folders:rename', folderId, name),
  deleteFolder: (folderId: string) => ipcRenderer.invoke('folders:delete', folderId),
  moveFolder: (folderId: string, parentId: string | null) => ipcRenderer.invoke('folders:move', folderId, parentId),
  setChatFolder: (threadId: string, folderId: string | null) =>
    ipcRenderer.invoke('chats:setFolder', threadId, folderId),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateQuickChat: (patch: Partial<QuickChatSettings>) => ipcRenderer.invoke('settings:updateQuickChat', patch),
  submitQuickChat: (prompt: QuickChatPrompt) => ipcRenderer.invoke('quickchat:submit', prompt),
  hideQuickChat: () => ipcRenderer.invoke('quickchat:hide'),
  onQuickChatFocus: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('quickchat:focus', handler);
    return () => ipcRenderer.removeListener('quickchat:focus', handler);
  },
  onQuickChatPrompt: (listener: (prompt: QuickChatPrompt) => void) => {
    const handler = (_e: unknown, prompt: QuickChatPrompt) => listener(prompt);
    ipcRenderer.on('quickchat:prompt', handler);
    return () => ipcRenderer.removeListener('quickchat:prompt', handler);
  }
};

contextBridge.exposeInMainWorld('stem', api);
