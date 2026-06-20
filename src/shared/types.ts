// Shared contracts between main, preload, and renderer. Single source of truth.

export type Role = 'user' | 'assistant' | 'system';

/** How an assistant reply was generated, for the avatar tooltip. */
export interface MessageMeta {
  /** Model id (resolved to a display name by the renderer via the catalog). */
  model?: string;
  /** Reasoning effort (low/medium/high/xhigh); absent when the model has none. */
  effort?: string;
  /** 'priority' = Fast; null = Standard; undefined = unknown (e.g. history). */
  serviceTier?: string | null;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Assistant messages only: which model/effort/speed produced the reply. */
  meta?: MessageMeta;
  /**
   * The codex turn this message belongs to (user message + its reply share one
   * turn id). Lets retry/edit/fork map a rendered message back to an authoritative
   * turn for rollback/fork. Absent on optimistic bubbles until their turn resolves.
   */
  turnId?: string;
}

// ---- Runtime status (staged: binary -> health -> auth -> ready) ----

export interface RuntimeStatus {
  ok: boolean;
  codexPath: string | null;
  codexHome: string;
  workspaceRoot: string;
  authenticated?: boolean;
  /** Copy-pasteable login command, surfaced when not authenticated. */
  loginCommand?: string;
  error?: string;
}

// ---- Turn lifecycle ----

/**
 * A file/image the user attached to a turn. Carries either an on-disk `path`
 * (native dialog pick or dropped file) or raw `dataBase64` bytes (clipboard
 * paste, which has no path). The main process ingests these at send time.
 */
export interface TurnAttachment {
  /** Basename — used for display and as the on-disk filename when staging. */
  name: string;
  /** Source path when the file already exists on disk. */
  path?: string;
  /** Base64-encoded bytes for pasted data with no path. */
  dataBase64?: string;
  /** MIME type when known (esp. for pasted images). */
  mime?: string;
}

export interface StartTurnInput {
  input: string;
  threadId?: string;
  model?: string;
  /** Reasoning effort override (low/medium/high/xhigh). */
  effort?: string;
  /** Service tier override: 'priority' = Fast; null = Standard. */
  serviceTier?: string | null;
  /** Output format for this turn: 'mdx' = rich components (default); 'md' = plain Markdown. */
  format?: 'md' | 'mdx';
  /** Files/images attached to this turn. */
  attachments?: TurnAttachment[];
}

// ---- Models (codex catalog) ----

export interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
}

/** A selectable model from codex's catalog (`model/list`), shaped for the UI. */
export interface ModelSummary {
  id: string;
  displayName: string;
  description: string;
  /** e.g. ['low','medium','high','xhigh']. */
  supportedEfforts: string[];
  defaultEffort: string;
  /** Empty => model has no Fast (priority) tier; hide the speed control. */
  serviceTiers: ModelServiceTier[];
  isDefault: boolean;
}

export interface StartTurnResult {
  threadId?: string;
  turnId?: string;
  handled?: boolean;
  assistantMessage?: string;
  rememberedPath?: string;
}

// ---- Codex app-server events (verified against codex-cli 0.141.0) ----
//
// Events arrive as JSON-RPC notifications. We dispatch on `method`. Unknown
// methods are forwarded with the generic envelope and ignored by the UI.

export interface CodexEventEnvelope {
  method: string;
  params: unknown;
  receivedAt: string;
}

/** `item/agentMessage/delta` — a streamed token chunk of the assistant reply. */
export interface AgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface CodexItemContentPart {
  type: string;
  text?: string;
}

export interface CodexItem {
  type: string; // 'userMessage' | 'agentMessage' | 'reasoning' | 'commandExecution' | 'mcpToolCall' | ...
  id: string;
  /** agentMessage carries its text here (a plain string). */
  text?: string;
  /** userMessage carries content as parts. */
  content?: CodexItemContentPart[];
}

/** `item/started` and `item/completed`. The completed agentMessage item carries authoritative text. */
export interface ItemEventParams {
  item: CodexItem;
  threadId: string;
  turnId: string;
}

/** `turn/completed`. */
export interface TurnCompletedParams {
  threadId: string;
  turn: { id: string; status: string; durationMs?: number | null };
}

/** `account/rateLimits/updated`. */
export interface RateLimitsParams {
  rateLimits: {
    primary?: { usedPercent: number; resetsAt?: number } | null;
    secondary?: { usedPercent: number; resetsAt?: number } | null;
    planType?: string | null;
  };
}

// Helper to pull the authoritative assistant text out of a completed agentMessage item.
// agentMessage stores its text as a plain `text` string; fall back to `content[]` parts.
export function agentMessageText(item: CodexItem): string {
  if (item.type !== 'agentMessage') return '';
  if (typeof item.text === 'string' && item.text.length > 0) return item.text;
  if (item.content) {
    return item.content
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
  }
  return '';
}

// ---- Skills ----

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  path: string;
}

// ---- MCP servers ----

/** stdio = local `command` + `args`; http = remote streamable-HTTP `url`. */
export type McpTransport = 'stdio' | 'http';

export interface McpServerSummary {
  name: string;
  transport: McpTransport;
  /** stdio only (empty string for http). */
  command: string;
  /** stdio only. */
  args: string[];
  /** http only (empty string for stdio). */
  url: string;
  /** Raw `auth_status` from `codex mcp list --json`, when reported (e.g. 'o_auth'). */
  authStatus?: string;
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  /** Required for stdio. */
  command?: string;
  args?: string[];
  /** Required for http. */
  url?: string;
}

export interface McpLoginResult {
  ok: boolean;
  error?: string;
}

/** `mcp/login/url` — the OAuth authorize URL, streamed mid-login as a fallback link. */
export interface McpLoginUrlParams {
  name: string;
  url: string;
}

// ---- Memory ----

export interface MemorySettings {
  enabled: boolean;
  useMemories: boolean;
  generateMemories: boolean;
}

/** `note` is a user-provided memory; `native` is a Codex-generated technical file. */
export type MemoryFileKind = 'note' | 'native';

/** One on-disk memory markdown file; `exists:false` when not yet written. */
export interface MemoryFile {
  name: string;
  label: string;
  content: string;
  exists: boolean;
  kind: MemoryFileKind;
  /** Notes only: the cleaned fact (boilerplate/blockquote stripped). */
  statement?: string;
  /** Notes only: short human chip for how it was captured. */
  source?: string;
}

export interface MemoryContents {
  /** Absolute path to the memories directory on disk. */
  dir: string;
  files: MemoryFile[];
  /** True when no file has any non-whitespace content. */
  isEmpty: boolean;
}

// ---- Chats (codex-backed) + Folders (Stem-owned organization) ----
//
// A "chat" is a codex thread (codex persists threads on disk under CODEX_HOME).
// Folders are a pure-organization layer Stem owns: codex has no folder concept,
// so the folder tree and the chat->folder assignment live in a Stem JSON store.

/** A user-managed folder. `parentId: null` = top level; nesting via `parentId`. */
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  /** Sort order among siblings. */
  order: number;
}

/**
 * Per-thread run state shown as a status dot on each chat row.
 * - `idle`    nothing in flight (no dot)
 * - `running` a turn is generating (pulsing dot)
 * - `done`    finished while you were viewing another chat — unread (solid dot, cleared on open)
 * - `error`   the last turn failed (red dot)
 */
export type ThreadStatus = 'idle' | 'running' | 'done' | 'error';

/** A chat row in the sidebar — a codex thread merged with its folder assignment. */
export interface ChatSummary {
  threadId: string;
  /** Computed main-side as `name ?? preview ?? 'New chat'`. */
  title: string;
  folderId: string | null;
  /** Unix seconds. */
  createdAt: number;
  updatedAt: number;
}

/** Full chat contents for replay when a chat is opened. */
export interface ChatHistory {
  threadId: string;
  title: string;
  messages: ChatMessage[];
}

/** The complete sidebar payload: chats + the folder tree, fetched together. */
export interface ChatListResult {
  chats: ChatSummary[];
  folders: Folder[];
}

// ---- App settings (Stem-owned, persisted by the main process) ----
//
// Renderer per-turn picks (model/effort/format) still live in localStorage; this
// store holds settings the main process itself needs — notably the global
// Quick Chat shortcut, which can only be registered from main.

/** Configuration for the global Quick Chat overlay. */
export interface QuickChatSettings {
  /** Electron global accelerator (e.g. 'Alt+Space'); null = shortcut disabled. */
  shortcut: string | null;
  /** Model the overlay opens with; null = follow the app's default model. */
  defaultModel: string | null;
  /** Reasoning effort the overlay opens with (low/medium/high/xhigh). */
  defaultEffort: string;
  /** Service tier the overlay opens with: 'priority' = Fast; null = Standard. */
  defaultServiceTier: string | null;
  /** Float the overlay across every Space and on whichever display is active. */
  showOnAllDisplays: boolean;
}

export interface AppSettings {
  quickChat: QuickChatSettings;
}

/** A prompt relayed from the overlay to the main window to run as a fresh turn. */
export interface QuickChatPrompt {
  input: string;
  /** Model chosen in the overlay; null = use the main window's current model. */
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
}

// ---- Preload API surface exposed on window.stem ----

export interface StemApi {
  runtimeStatus(): Promise<RuntimeStatus>;
  login(): Promise<RuntimeStatus>;
  startTurn(input: StartTurnInput): Promise<StartTurnResult>;
  interruptTurn(turnId: string): Promise<void>;
  newConversation(): Promise<void>;
  onCodexEvent(listener: (event: CodexEventEnvelope) => void): () => void;

  /** Open a native file picker; returns chosen absolute paths ([] if canceled). */
  openFiles(): Promise<string[]>;
  /** Resolve the on-disk path of a dropped File (empty string if unavailable). */
  getPathForFile(file: File): string;

  listModels(): Promise<ModelSummary[]>;

  listSkills(): Promise<SkillSummary[]>;
  setSkillEnabled(slug: string, enabled: boolean): Promise<SkillSummary[]>;

  listMcpServers(): Promise<McpServerSummary[]>;
  addMcpServer(input: McpServerInput): Promise<McpServerSummary[]>;
  removeMcpServer(name: string): Promise<McpServerSummary[]>;
  loginMcpServer(name: string): Promise<McpLoginResult>;
  restartRuntime(): Promise<RuntimeStatus>;

  getMemorySettings(): Promise<MemorySettings>;
  setMemoryEnabled(enabled: boolean): Promise<MemorySettings>;
  readMemory(): Promise<MemoryContents>;

  // Chats + folders. Folder mutations return the fresh list (like addMcpServer);
  // chat rename/delete return void and the renderer re-fetches.
  listChats(): Promise<ChatListResult>;
  openChat(threadId: string): Promise<ChatHistory>;
  /** Drop the given turn and every later turn from the thread (retry/edit re-run). */
  rollbackToTurn(threadId: string, turnId: string): Promise<void>;
  /** Branch the thread into a new chat, trimmed to end at the given turn. */
  forkThread(threadId: string, turnId: string): Promise<{ threadId: string }>;
  renameChat(threadId: string, name: string): Promise<void>;
  deleteChat(threadId: string): Promise<void>;
  createFolder(name: string, parentId: string | null): Promise<ChatListResult>;
  renameFolder(folderId: string, name: string): Promise<ChatListResult>;
  deleteFolder(folderId: string): Promise<ChatListResult>;
  moveFolder(folderId: string, parentId: string | null): Promise<ChatListResult>;
  setChatFolder(threadId: string, folderId: string | null): Promise<ChatListResult>;

  // App settings + Quick Chat overlay.
  getSettings(): Promise<AppSettings>;
  updateQuickChat(patch: Partial<QuickChatSettings>): Promise<AppSettings>;
  /** Overlay → main: relay a prompt, reveal the main window, hide the overlay. */
  submitQuickChat(prompt: QuickChatPrompt): Promise<void>;
  /** Hide the overlay (Escape from within it). */
  hideQuickChat(): Promise<void>;
  /** Overlay: fired each time the overlay is summoned (refocus + reset). */
  onQuickChatFocus(listener: () => void): () => void;
  /** Main window: fired when the overlay submits a prompt to run. */
  onQuickChatPrompt(listener: (prompt: QuickChatPrompt) => void): () => void;
}
