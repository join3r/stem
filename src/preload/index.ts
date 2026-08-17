import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ActivitySnapshot,
  ApprovalResolvedPayload,
  ApiKeyProviderId,
  AuthProviderId,
  AuthUiEvent,
  BackendEventEnvelope,
  ChatsSettings,
  DefaultsSettings,
  ConnectedFolderPatch,
  CustomInstructionsSettings,
  EscapeAction,
  ExecApprovalRequest,
  ExecDecision,
  ExecSettings,
  InstructionsProposal,
  LiveTurn,
  LocalEmbedStatus,
  LocalProviderApi,
  LocalProviderId,
  LocalProviderSettings,
  LocalRerankStatus,
  RemoteRetrievalHealth,
  McpAdminProposal,
  McpHostLocalState,
  McpServerInput,
  McpServerStatus,
  MemoryModelSettings,
  MemoryRebuildStatus,
  WebSearchSettings,
  PartialRetrievalSettings,
  ReleaseNotesSettings,
  RetrievalStage,
  QuickChatAdopt,
  QuickChatFocus,
  QuickChatHandoff,
  QuickChatHandoffRequest,
  QuickChatPrompt,
  QuickChatSettings,
  QuickChatSessionStarted,
  QuickChatStatus,
  ScheduledRunPayload,
  ScheduledTask,
  SkillProposal,
  SkillsMode,
  SkillsSettings,
  StartTurnInput,
  StemApi,
  TaskNotifyPayload,
  TaskSchedulePatch,
  TasksSettings,
  UpdateStatus,
  UpdatesSettings
} from '../shared/types';

const api: StemApi = {
  // Sandboxed preloads still see process.platform; exotic platforms never ship.
  platform: process.platform as StemApi['platform'],
  rendererReady: () => ipcRenderer.send('renderer:ready'),
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  login: () => ipcRenderer.invoke('runtime:login'),
  providerLogin: (provider: AuthProviderId) => ipcRenderer.invoke('auth:providerLogin', provider),
  providerLoginRespond: (requestId: string, value: string) =>
    ipcRenderer.invoke('auth:respond', requestId, value),
  providerLoginCancel: () => ipcRenderer.invoke('auth:cancel'),
  setApiKey: (provider: ApiKeyProviderId, key: string) => ipcRenderer.invoke('auth:setApiKey', provider, key),
  updateLocalProvider: (id: LocalProviderId, patch: Partial<LocalProviderSettings>) =>
    ipcRenderer.invoke('providers:updateLocal', id, patch),
  testLocalProvider: (id: LocalProviderId, baseUrl: string, apiKey?: string, api?: LocalProviderApi) =>
    ipcRenderer.invoke('providers:testLocal', id, baseUrl, apiKey, api),
  previewPiModels: (source: { json?: string; path?: string }) => ipcRenderer.invoke('providers:previewPiModels', source),
  copyPiModels: (
    source: { json?: string; path?: string },
    providerId: string,
    hints?: { baseUrl?: string; apiKey?: string; api?: LocalProviderApi }
  ) => ipcRenderer.invoke('providers:copyPiModels', source, providerId, hints),
  disconnectProvider: (providerId: string) => ipcRenderer.invoke('providers:disconnect', providerId),
  checkAuth: (provider: string) => ipcRenderer.invoke('auth:check', provider),
  completeOnboarding: () => ipcRenderer.invoke('auth:completeOnboarding'),
  onAuthEvent: (listener: (event: AuthUiEvent) => void) => {
    const handler = (_e: unknown, event: AuthUiEvent) => listener(event);
    ipcRenderer.on('auth:event', handler);
    return () => ipcRenderer.removeListener('auth:event', handler);
  },
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
  removeSkill: (slug: string) => ipcRenderer.invoke('skills:remove', slug),
  curateSkills: () => ipcRenderer.invoke('skills:curate'),
  learnFromLastTurn: (threadId: string, focus?: string) => ipcRenderer.invoke('skills:learn', threadId, focus),
  skillsResetStatus: () => ipcRenderer.invoke('skills:resetStatus'),
  resetSkills: (exportFirst: boolean, mode: SkillsMode) => ipcRenderer.invoke('skills:reset', exportFirst, mode),
  onSkillsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('skills:changed', handler);
    return () => ipcRenderer.removeListener('skills:changed', handler);
  },

  listFiles: () => ipcRenderer.invoke('files:list'),
  addFiles: (paths: string[], subdir?: string) => ipcRenderer.invoke('files:add', paths, subdir),
  removeFile: (rel: string) => ipcRenderer.invoke('files:remove', rel),
  createFilesSubdir: (name: string) => ipcRenderer.invoke('files:mkdir', name),
  removeFilesSubdir: (name: string) => ipcRenderer.invoke('files:rmdir', name),
  revealFiles: () => ipcRenderer.invoke('files:reveal'),
  downloadFile: (rel: string) => ipcRenderer.invoke('files:download', rel),
  previewImage: (path: string) => ipcRenderer.invoke('files:preview', path),

  listConnectedFolders: () => ipcRenderer.invoke('cfolders:list'),
  addConnectedFolders: (paths: string[]) => ipcRenderer.invoke('cfolders:add', paths),
  updateConnectedFolder: (id: string, patch: ConnectedFolderPatch) =>
    ipcRenderer.invoke('cfolders:update', id, patch),
  removeConnectedFolder: (id: string) => ipcRenderer.invoke('cfolders:remove', id),
  forgetConnectedFolderFacts: (id: string) => ipcRenderer.invoke('cfolders:forgetFacts', id),
  folderIndexStatus: () => ipcRenderer.invoke('cfolders:indexStatus'),
  revealConnectedFolder: (id: string) => ipcRenderer.invoke('cfolders:reveal', id),
  openWorkspaceFolder: () => ipcRenderer.invoke('cfolders:revealWorkspace'),
  pickDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  browseServerFolders: (path?: string) => ipcRenderer.invoke('cfolders:browse', path),

  listTasks: () => ipcRenderer.invoke('tasks:list'),
  taskThreadSettings: (threadId: string) => ipcRenderer.invoke('tasks:threadSettings', threadId),
  setTaskEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('tasks:setEnabled', id, enabled),
  runTaskNow: (id: string) => ipcRenderer.invoke('tasks:runNow', id),
  deleteTask: (id: string) => ipcRenderer.invoke('tasks:delete', id),
  updateTaskSchedule: (id: string, patch: TaskSchedulePatch) =>
    ipcRenderer.invoke('tasks:updateSchedule', id, patch),
  onTasksChanged: (listener: (tasks: ScheduledTask[]) => void) => {
    const handler = (_e: unknown, tasks: ScheduledTask[]) => listener(tasks);
    ipcRenderer.on('tasks:changed', handler);
    return () => ipcRenderer.removeListener('tasks:changed', handler);
  },
  onScheduledRun: (listener: (run: ScheduledRunPayload) => void) => {
    const handler = (_e: unknown, run: ScheduledRunPayload) => listener(run);
    ipcRenderer.on('tasks:run', handler);
    return () => ipcRenderer.removeListener('tasks:run', handler);
  },
  onTaskNotify: (listener: (payload: TaskNotifyPayload) => void) => {
    const handler = (_e: unknown, payload: TaskNotifyPayload) => listener(payload);
    ipcRenderer.on('tasks:notify', handler);
    return () => ipcRenderer.removeListener('tasks:notify', handler);
  },

  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  getMcpStatus: () => ipcRenderer.invoke('mcp:status'),
  addMcpServer: (input: McpServerInput) => ipcRenderer.invoke('mcp:add', input),
  removeMcpServer: (name: string) => ipcRenderer.invoke('mcp:remove', name),
  setMcpServerEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke('mcp:setEnabled', name, enabled),
  setMcpServerLocation: (name: string, deviceId: string | null) =>
    ipcRenderer.invoke('mcp:setLocation', name, deviceId),
  loginMcpServer: (name: string) => ipcRenderer.invoke('mcp:login', name),
  restartRuntime: () => ipcRenderer.invoke('runtime:restart'),

  mcpHostState: () => ipcRenderer.invoke('mcpHost:localState'),
  approveMcpHostServer: (name: string, fingerprint: string) =>
    ipcRenderer.invoke('mcpHost:approve', name, fingerprint),
  rejectMcpHostServer: (name: string) => ipcRenderer.invoke('mcpHost:reject', name),
  testMcpHostServer: (name: string) => ipcRenderer.invoke('mcpHost:test', name),
  refreshMcpHost: () => ipcRenderer.invoke('mcpHost:refresh'),
  onMcpHostChanged: (listener: (state: McpHostLocalState) => void) => {
    const handler = (_e: unknown, state: McpHostLocalState) => listener(state);
    ipcRenderer.on('mcpHost:changed', handler);
    return () => ipcRenderer.removeListener('mcpHost:changed', handler);
  },
  execHostState: () => ipcRenderer.invoke('execHost:localState'),
  setExecHostEnabled: (enabled: boolean) => ipcRenderer.invoke('execHost:setEnabled', enabled),
  onMcpAdminApproval: (listener: (proposal: McpAdminProposal) => void) => {
    const handler = (_e: unknown, proposal: McpAdminProposal) => listener(proposal);
    ipcRenderer.on('mcp:adminApproval', handler);
    return () => ipcRenderer.removeListener('mcp:adminApproval', handler);
  },
  onMcpAdminApprovalResolved: (listener: (payload: ApprovalResolvedPayload) => void) => {
    const handler = (_e: unknown, payload: ApprovalResolvedPayload) => listener(payload);
    ipcRenderer.on('mcp:adminApprovalResolved', handler);
    return () => ipcRenderer.removeListener('mcp:adminApprovalResolved', handler);
  },
  respondMcpAdminApproval: (id: number | string, accept: boolean) =>
    ipcRenderer.invoke('mcp:adminDecision', id, accept),
  onInstructionsApproval: (listener: (proposal: InstructionsProposal) => void) => {
    const handler = (_e: unknown, proposal: InstructionsProposal) => listener(proposal);
    ipcRenderer.on('instructions:approvalRequest', handler);
    return () => ipcRenderer.removeListener('instructions:approvalRequest', handler);
  },
  onInstructionsApprovalResolved: (listener: (payload: ApprovalResolvedPayload) => void) => {
    const handler = (_e: unknown, payload: ApprovalResolvedPayload) => listener(payload);
    ipcRenderer.on('instructions:approvalResolved', handler);
    return () => ipcRenderer.removeListener('instructions:approvalResolved', handler);
  },
  respondInstructionsApproval: (id: number | string, accept: boolean, surface: 'main' | 'quickChat', text: string) =>
    ipcRenderer.invoke('instructions:resolveApproval', id, accept, surface, text),
  onSkillApproval: (listener: (proposal: SkillProposal) => void) => {
    const handler = (_e: unknown, proposal: SkillProposal) => listener(proposal);
    ipcRenderer.on('skills:approvalRequest', handler);
    return () => ipcRenderer.removeListener('skills:approvalRequest', handler);
  },
  onSkillApprovalResolved: (listener: (payload: ApprovalResolvedPayload) => void) => {
    const handler = (_e: unknown, payload: ApprovalResolvedPayload) => listener(payload);
    ipcRenderer.on('skills:approvalResolved', handler);
    return () => ipcRenderer.removeListener('skills:approvalResolved', handler);
  },
  respondSkillApproval: (id: number | string, accept: boolean, skill: { name: string; description: string; body: string }) =>
    ipcRenderer.invoke('skills:resolveApproval', id, accept, skill),
  updateExecSettings: (patch: Partial<ExecSettings>) => ipcRenderer.invoke('settings:updateExec', patch),
  onExecApproval: (listener: (request: ExecApprovalRequest) => void) => {
    const handler = (_e: unknown, request: ExecApprovalRequest) => listener(request);
    ipcRenderer.on('exec:approvalRequest', handler);
    return () => ipcRenderer.removeListener('exec:approvalRequest', handler);
  },
  onExecApprovalResolved: (listener: (payload: ApprovalResolvedPayload) => void) => {
    const handler = (_e: unknown, payload: ApprovalResolvedPayload) => listener(payload);
    ipcRenderer.on('exec:approvalResolved', handler);
    return () => ipcRenderer.removeListener('exec:approvalResolved', handler);
  },
  respondExecApproval: (id: string, decision: ExecDecision) =>
    ipcRenderer.invoke('exec:resolveApproval', id, decision),
  getScratchUsage: () => ipcRenderer.invoke('exec:scratchUsage'),
  clearScratch: (key: string) => ipcRenderer.invoke('exec:clearScratch', key),
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
  getActiveFacts: (threadId: string | null) => ipcRenderer.invoke('memory:activeFacts', threadId),
  previewFacts: (text: string) => ipcRenderer.invoke('memory:previewFacts', text),
  addMemoryNote: (text: string) => ipcRenderer.invoke('memory:addNote', text),
  forgetMemory: (id: number) => ipcRenderer.invoke('memory:forget', id),
  setFactPinned: (id: number, pinned: boolean) => ipcRenderer.invoke('memory:setPinned', id, pinned),
  confirmFact: (id: number) => ipcRenderer.invoke('memory:confirmFact', id),
  getFactDetails: (id: number) => ipcRenderer.invoke('memory:factDetails', id),
  getMemoryConflicts: () => ipcRenderer.invoke('memory:conflicts'),
  getAutoResolvedConflicts: () => ipcRenderer.invoke('memory:autoResolvedConflicts'),
  resolveMemoryConflict: (id: number, resolution) => ipcRenderer.invoke('memory:resolveConflict', id, resolution),
  restoreSupersededFact: (id: number) => ipcRenderer.invoke('memory:restoreFact', id),
  getMemoryRebuildStatus: () => ipcRenderer.invoke('memory:rebuildStatus'),
  startMemoryRebuild: () => ipcRenderer.invoke('memory:startRebuild'),
  pauseMemoryRebuild: () => ipcRenderer.invoke('memory:pauseRebuild'),
  resumeMemoryRebuild: () => ipcRenderer.invoke('memory:resumeRebuild'),
  onMemoryRebuildStatus: (listener: (status: MemoryRebuildStatus) => void) => {
    const handler = (_e: unknown, status: MemoryRebuildStatus): void => listener(status);
    ipcRenderer.on('memory:rebuildStatus', handler);
    return () => ipcRenderer.removeListener('memory:rebuildStatus', handler);
  },
  resetFactsMemory: () => ipcRenderer.invoke('memory:resetFacts'),
  resetEpisodicMemory: () => ipcRenderer.invoke('memory:resetEpisodic'),
  consolidateMemory: () => ipcRenderer.invoke('memory:consolidate'),
  getEpisodicStats: () => ipcRenderer.invoke('memory:episodicStats'),
  getThreadSummaries: () => ipcRenderer.invoke('memory:summaries'),
  deleteThreadSummary: (id: number) => ipcRenderer.invoke('memory:deleteSummary', id),
  setEpisodicLimit: (bytes: number) => ipcRenderer.invoke('memory:setEpisodicLimit', bytes),
  setTidyThreshold: (n: number) => ipcRenderer.invoke('memory:setTidyThreshold', n),
  setMaxRelevantFacts: (n: number) => ipcRenderer.invoke('memory:setMaxRelevantFacts', n),

  listChats: () => ipcRenderer.invoke('chats:list'),
  searchChatsFast: (query: string) => ipcRenderer.invoke('chats:searchFast', query),
  searchChats: (query: string) => ipcRenderer.invoke('chats:search', query),
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

  setInboxArchived: (threadIds: string[], archived: boolean) =>
    ipcRenderer.invoke('inbox:setArchived', threadIds, archived),
  snoozeChats: (threadIds: string[], until: number | null) =>
    ipcRenderer.invoke('inbox:snooze', threadIds, until),
  setInboxRead: (threadIds: string[], read: boolean) =>
    ipcRenderer.invoke('inbox:setRead', threadIds, read),
  markInboxAllRead: () => ipcRenderer.invoke('inbox:markAllRead'),
  writeChatSubject: (threadId: string) => ipcRenderer.invoke('chats:writeSubject', threadId),
  onChatsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('chats:changed', handler);
    return () => ipcRenderer.removeListener('chats:changed', handler);
  },
  onResync: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('client:resync', handler);
    return () => ipcRenderer.removeListener('client:resync', handler);
  },
  onLiveTurns: (listener: (turns: LiveTurn[]) => void) => {
    const handler = (_e: unknown, turns: LiveTurn[]) => listener(turns);
    ipcRenderer.on('client:liveTurns', handler);
    return () => ipcRenderer.removeListener('client:liveTurns', handler);
  },
  connectionState: () => ipcRenderer.invoke('client:connection'),
  onConnectionChanged: (listener: (reachable: boolean) => void) => {
    const handler = (_e: unknown, reachable: boolean) => listener(reachable);
    ipcRenderer.on('client:connectionChanged', handler);
    return () => ipcRenderer.removeListener('client:connectionChanged', handler);
  },

  listDevices: () => ipcRenderer.invoke('devices:list'),
  revokeDevice: (id: string) => ipcRenderer.invoke('devices:revoke', id),
  createPairingCode: (label: string) => ipcRenderer.invoke('devices:createPairingCode', label),
  clientInfo: () => ipcRenderer.invoke('client:info'),
  pairWithServer: (url: string, code: string) => ipcRenderer.invoke('client:pair', url, code),
  useBuiltInServer: () => ipcRenderer.invoke('client:useBuiltIn'),
  exportState: (passphrase: string) => ipcRenderer.invoke('stem:exportState', { passphrase }),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateQuickChat: (patch: Partial<QuickChatSettings>) => ipcRenderer.invoke('settings:updateQuickChat', patch),
  getQuickChatShortcutStatus: () => ipcRenderer.invoke('quickchat:shortcutStatus'),
  updateWebSearch: (patch: Partial<WebSearchSettings>) =>
    ipcRenderer.invoke('settings:updateWebSearch', patch),
  updateEscapeAction: (action: EscapeAction) => ipcRenderer.invoke('settings:updateEscapeAction', action),
  getReleaseNotes: () => ipcRenderer.invoke('releaseNotes:get'),
  markReleaseNotesSeen: () => ipcRenderer.invoke('releaseNotes:markSeen'),
  updateReleaseNotesSettings: (patch: Partial<ReleaseNotesSettings>) =>
    ipcRenderer.invoke('settings:updateReleaseNotes', patch),
  getUpdateStatus: () => ipcRenderer.invoke('updates:get'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  updateUpdatesSettings: (patch: Partial<UpdatesSettings>) =>
    ipcRenderer.invoke('settings:updateUpdates', patch),
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => {
    const handler = (_e: unknown, status: UpdateStatus) => listener(status);
    ipcRenderer.on('updates:status', handler);
    return () => ipcRenderer.removeListener('updates:status', handler);
  },
  updateMemorySettings: (patch: Partial<MemoryModelSettings>) =>
    ipcRenderer.invoke('settings:updateMemory', patch),
  updateCustomInstructions: (patch: Partial<CustomInstructionsSettings>) =>
    ipcRenderer.invoke('settings:updateCustomInstructions', patch),
  updateSkillsSettings: (patch: Partial<SkillsSettings>) =>
    ipcRenderer.invoke('settings:updateSkills', patch),
  updateChatsSettings: (patch: Partial<ChatsSettings>) => ipcRenderer.invoke('settings:updateChats', patch),
  updateTasksSettings: (patch: Partial<TasksSettings>) => ipcRenderer.invoke('settings:updateTasks', patch),
  updateDefaults: (patch: Partial<DefaultsSettings>) => ipcRenderer.invoke('settings:updateDefaults', patch),
  updateRetrievalSettings: (patch: PartialRetrievalSettings) =>
    ipcRenderer.invoke('settings:updateRetrieval', patch),
  testRetrievalEndpoint: (stage: RetrievalStage) => ipcRenderer.invoke('settings:testRetrieval', stage),
  getActivity: () => ipcRenderer.invoke('activity:snapshot'),
  onActivity: (listener: (snapshot: ActivitySnapshot) => void) => {
    const handler = (_e: unknown, snapshot: ActivitySnapshot) => listener(snapshot);
    ipcRenderer.on('activity:changed', handler);
    return () => ipcRenderer.removeListener('activity:changed', handler);
  },
  markActivitySeen: () => ipcRenderer.invoke('activity:markSeen'),
  getLocalEmbedStatus: () => ipcRenderer.invoke('embeddings:localStatus'),
  onLocalEmbedStatus: (listener: (status: LocalEmbedStatus) => void) => {
    const handler = (_e: unknown, status: LocalEmbedStatus) => listener(status);
    ipcRenderer.on('embeddings:localStatus', handler);
    return () => ipcRenderer.removeListener('embeddings:localStatus', handler);
  },
  getLocalRerankStatus: () => ipcRenderer.invoke('reranker:localStatus'),
  onLocalRerankStatus: (listener: (status: LocalRerankStatus) => void) => {
    const handler = (_e: unknown, status: LocalRerankStatus) => listener(status);
    ipcRenderer.on('reranker:localStatus', handler);
    return () => ipcRenderer.removeListener('reranker:localStatus', handler);
  },
  getRemoteRetrievalHealth: () => ipcRenderer.invoke('retrieval:remoteHealth'),
  onRemoteRetrievalHealth: (listener: (health: RemoteRetrievalHealth) => void) => {
    const handler = (_e: unknown, health: RemoteRetrievalHealth) => listener(health);
    ipcRenderer.on('retrieval:remoteHealth', handler);
    return () => ipcRenderer.removeListener('retrieval:remoteHealth', handler);
  },
  runQuickChat: (prompt: QuickChatPrompt) => ipcRenderer.invoke('quickchat:run', prompt),
  newQuickChatThread: () => ipcRenderer.invoke('quickchat:newThread'),
  handoffQuickChat: (payload: QuickChatHandoff) => ipcRenderer.invoke('quickchat:handoff', payload),
  onQuickChatHandoffRequest: (listener: (request: QuickChatHandoffRequest) => void) => {
    const handler = (_e: unknown, request: QuickChatHandoffRequest) => listener(request);
    ipcRenderer.on('quickchat:handoffRequest', handler);
    return () => ipcRenderer.removeListener('quickchat:handoffRequest', handler);
  },
  respondQuickChatHandoffRequest: (id: string, payload: QuickChatHandoff) =>
    ipcRenderer.send('quickchat:handoffSnapshot', id, payload),
  revealQuickChat: () => ipcRenderer.invoke('quickchat:reveal'),
  revealMain: () => ipcRenderer.invoke('main:reveal'),
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
  },
  onHudPlayChime: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('hud:playChime', handler);
    return () => ipcRenderer.removeListener('hud:playChime', handler);
  }
};

contextBridge.exposeInMainWorld('stem', api);
