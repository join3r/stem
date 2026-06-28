import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  BackendEventEnvelope,
  McpAdminProposal,
  McpServerInput,
  McpServerStatus,
  MemoryModelSettings,
  NativeWebSearchSettings,
  PartialRetrievalSettings,
  RetrievalStage,
  QuickChatAdopt,
  QuickChatFocus,
  QuickChatHandoff,
  QuickChatPrompt,
  QuickChatSettings,
  QuickChatSessionStarted,
  QuickChatStatus,
  SkillsModelSettings,
  StartTurnInput,
  StemApi
} from '../shared/types';

const api: StemApi = {
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  login: () => ipcRenderer.invoke('runtime:login'),
  startTurn: (input: StartTurnInput) => ipcRenderer.invoke('backend:startTurn', input),
  interruptTurn: (turnId: string) => ipcRenderer.invoke('backend:interruptTurn', turnId),
  newConversation: () => ipcRenderer.invoke('backend:newConversation'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  listModels: () => ipcRenderer.invoke('backend:listModels'),
  onBackendEvent: (listener: (event: BackendEventEnvelope) => void) => {
    const handler = (_e: unknown, event: BackendEventEnvelope) => listener(event);
    ipcRenderer.on('backend:event', handler);
    return () => ipcRenderer.removeListener('backend:event', handler);
  },

  listSkills: () => ipcRenderer.invoke('skills:list'),
  setSkillEnabled: (slug: string, enabled: boolean) => ipcRenderer.invoke('skills:setEnabled', slug, enabled),
  curateSkills: () => ipcRenderer.invoke('skills:curate'),
  onSkillsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('skills:changed', handler);
    return () => ipcRenderer.removeListener('skills:changed', handler);
  },

  listFiles: () => ipcRenderer.invoke('files:list'),
  addFiles: (paths: string[], subdir?: string) => ipcRenderer.invoke('files:add', paths, subdir),
  removeFile: (rel: string) => ipcRenderer.invoke('files:remove', rel),
  revealFiles: () => ipcRenderer.invoke('files:reveal'),
  previewImage: (path: string) => ipcRenderer.invoke('files:preview', path),

  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  getMcpStatus: () => ipcRenderer.invoke('mcp:status'),
  addMcpServer: (input: McpServerInput) => ipcRenderer.invoke('mcp:add', input),
  removeMcpServer: (name: string) => ipcRenderer.invoke('mcp:remove', name),
  setMcpServerEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:setEnabled', name, enabled),
  loginMcpServer: (name: string) => ipcRenderer.invoke('mcp:login', name),
  restartRuntime: () => ipcRenderer.invoke('runtime:restart'),
  onMcpAdminApproval: (listener: (proposal: McpAdminProposal) => void) => {
    const handler = (_e: unknown, proposal: McpAdminProposal) => listener(proposal);
    ipcRenderer.on('mcp:adminApproval', handler);
    return () => ipcRenderer.removeListener('mcp:adminApproval', handler);
  },
  respondMcpAdminApproval: (id: number | string, accept: boolean) =>
    ipcRenderer.invoke('mcp:adminDecision', id, accept),
  onMcpChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('mcp:changed', handler);
    return () => ipcRenderer.removeListener('mcp:changed', handler);
  },
  onMcpStatus: (listener: (status: Record<string, McpServerStatus>) => void) => {
    const handler = (_e: unknown, status: Record<string, McpServerStatus>) => listener(status);
    ipcRenderer.on('mcp:status', handler);
    return () => ipcRenderer.removeListener('mcp:status', handler);
  },

  getMemorySettings: () => ipcRenderer.invoke('memory:get'),
  setMemoryEnabled: (enabled: boolean) => ipcRenderer.invoke('memory:setEnabled', enabled),
  readMemory: () => ipcRenderer.invoke('memory:read'),
  forgetMemory: (id: number) => ipcRenderer.invoke('memory:forget', id),
  resetFactsMemory: () => ipcRenderer.invoke('memory:resetFacts'),
  resetEpisodicMemory: () => ipcRenderer.invoke('memory:resetEpisodic'),
  consolidateMemory: () => ipcRenderer.invoke('memory:consolidate'),
  getEpisodicStats: () => ipcRenderer.invoke('memory:episodicStats'),
  setEpisodicLimit: (bytes: number) => ipcRenderer.invoke('memory:setEpisodicLimit', bytes),
  setTidyThreshold: (n: number) => ipcRenderer.invoke('memory:setTidyThreshold', n),

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
  updateNativeWebSearch: (patch: Partial<NativeWebSearchSettings>) =>
    ipcRenderer.invoke('settings:updateNativeWebSearch', patch),
  updateMemorySettings: (patch: Partial<MemoryModelSettings>) =>
    ipcRenderer.invoke('settings:updateMemory', patch),
  updateSkillsSettings: (patch: Partial<SkillsModelSettings>) =>
    ipcRenderer.invoke('settings:updateSkills', patch),
  updateRetrievalSettings: (patch: PartialRetrievalSettings) =>
    ipcRenderer.invoke('settings:updateRetrieval', patch),
  testRetrievalEndpoint: (stage: RetrievalStage) => ipcRenderer.invoke('settings:testRetrieval', stage),
  getEmbeddingStats: () => ipcRenderer.invoke('memory:embeddingStats'),
  runQuickChat: (prompt: QuickChatPrompt) => ipcRenderer.invoke('quickchat:run', prompt),
  newQuickChatThread: () => ipcRenderer.invoke('quickchat:newThread'),
  handoffQuickChat: (payload: QuickChatHandoff) => ipcRenderer.invoke('quickchat:handoff', payload),
  revealQuickChat: () => ipcRenderer.invoke('quickchat:reveal'),
  hideQuickChat: () => ipcRenderer.invoke('quickchat:hide'),
  onQuickChatFocus: (listener: (focus: QuickChatFocus) => void) => {
    const handler = (_e: unknown, focus: QuickChatFocus) => listener(focus);
    ipcRenderer.on('quickchat:focus', handler);
    return () => ipcRenderer.removeListener('quickchat:focus', handler);
  },
  onQuickChatStatus: (listener: (status: QuickChatStatus) => void) => {
    const handler = (_e: unknown, status: QuickChatStatus) => listener(status);
    ipcRenderer.on('quickchat:status', handler);
    return () => ipcRenderer.removeListener('quickchat:status', handler);
  },
  onQuickChatAdopt: (listener: (payload: QuickChatAdopt) => void) => {
    const handler = (_e: unknown, payload: QuickChatAdopt) => listener(payload);
    ipcRenderer.on('quickchat:adopt', handler);
    return () => ipcRenderer.removeListener('quickchat:adopt', handler);
  },
  onQuickChatSessionStarted: (listener: (payload: QuickChatSessionStarted) => void) => {
    const handler = (_e: unknown, payload: QuickChatSessionStarted) => listener(payload);
    ipcRenderer.on('quickchat:sessionStarted', handler);
    return () => ipcRenderer.removeListener('quickchat:sessionStarted', handler);
  }
};

contextBridge.exposeInMainWorld('stem', api);
