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

/**
 * Per-turn answer-time breakdown shown on an assistant message. `totalMs` is the
 * headline (send→end). `thinkingMs`/`toolMs`/`answerMs` are measured wall-time
 * sub-segments and intentionally do NOT sum to the total — pre-first-token wait
 * and recall/build time sit in no segment. Persisted in recall.sqlite keyed by
 * the final assistant entry id so it survives reopen.
 */
export interface TurnTiming {
  totalMs: number | null;
  thinkingMs: number;
  toolMs: number;
  answerMs: number;
  /** Send → first answer token (time-to-first-token). */
  ttftMs?: number | null;
  /** Pre-send context build (recall + files + attachments). */
  buildMs?: number | null;
  /** Recall context assembly portion of buildMs. */
  recallMs?: number | null;
}

/**
 * Per-turn token usage for an assistant reply, as reported by the backend. `totalTokens`
 * is the headline "context fill" — what the next turn's prompt will roughly carry — and is
 * what the context meter divides by the model's window. `input`/`output`/`cacheRead`/
 * `cacheWrite` are the components; `cost` is the turn's dollar cost (null when unknown).
 * Persisted directly on the session message, so it survives reopen without a separate store.
 */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number | null;
}

/**
 * A user attachment as shown in the chat bubble. Images carry a `dataUrl` for an inline
 * `<img>` thumbnail; non-image files render as a chip with just a `name`. Distinct from
 * the send-time {@link TurnAttachment} — this is the display/replay shape.
 */
export interface MessageAttachment {
  kind: 'image' | 'file';
  name?: string;
  mime?: string;
  /** `data:<mime>;base64,…` for images (live send + rebuilt from session history). */
  dataUrl?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** User messages only: attachments shown as thumbnails/chips in the bubble. */
  attachments?: MessageAttachment[];
  /** Assistant messages only: which model/effort/speed produced the reply. */
  meta?: MessageMeta;
  /**
   * The backend turn this message belongs to (user message + its reply share one
   * turn id). Lets retry/edit/fork map a rendered message back to an authoritative
   * turn for rollback/fork. Absent on optimistic bubbles until their turn resolves.
   */
  turnId?: string;
  /** Assistant messages only: how long the answer took (total + thinking/tools). */
  timing?: TurnTiming;
  /** Assistant messages only: token usage (context fill + cost) for this turn. */
  usage?: TurnUsage;
  /**
   * ISO timestamp the message was authored. Surfaced as a hover-revealed label on
   * user bubbles (mirroring the assistant model/timing reveal). Read from the pi
   * session entry on replay; stamped optimistically when the user sends.
   */
  createdAt?: string;
  /**
   * Set on the user message of a scheduled-task run (and propagated to its reply so
   * the pair renders as one collapsed "Scheduled run — HH:MM" block). `at` is the
   * run's ISO timestamp. Derived live from the tasks:run push and on replay from a
   * persisted marker in the message.
   */
  scheduled?: { at: string };
}

// ---- Runtime status (staged: binary -> health -> auth -> ready) ----

export interface RuntimeStatus {
  ok: boolean;
  backendPath: string | null;
  backendHome: string;
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
  /**
   * Whether native (server-side) web search is allowed this turn. Decided per
   * context by the caller (main window vs Quick Chat). The backend only injects
   * the tool when the selected model's provider actually supports it; otherwise
   * this is a no-op. Defaults to enabled when omitted.
   */
  webSearch?: boolean;
  /** Files/images attached to this turn. */
  attachments?: TurnAttachment[];
  /**
   * Set by the scheduler for a scheduled-task run. The backend prepends an
   * automated-run preamble (so the agent knows it's running headless and should use
   * notify_user) plus a replay-detectable marker, and tags the turn's events so the
   * UI renders the run collapsed. `at` is the run's ISO timestamp.
   */
  scheduled?: { at: string; taskId: string };
}

// ---- Models (backend catalog) ----

export interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
}

/** A selectable model from the backend's catalog, shaped for the UI. */
export interface ModelSummary {
  id: string;
  displayName: string;
  description: string;
  /** Provider slug, e.g. 'openai-codex' / 'anthropic' (first segment of `id`). */
  provider: string;
  /** Friendly provider name for the UI, e.g. 'ChatGPT' / 'Claude'. */
  providerName: string;
  /** True when this model's provider supports native (server-side) web search. */
  supportsNativeWebSearch: boolean;
  /** e.g. ['low','medium','high','xhigh']. */
  supportedEfforts: string[];
  defaultEffort: string;
  /** Empty => model has no Fast (priority) tier; hide the speed control. */
  serviceTiers: ModelServiceTier[];
  isDefault: boolean;
  /** Context window size in tokens; denominator of the context meter. Absent => hide it. */
  contextWindow?: number;
}

export interface StartTurnResult {
  threadId?: string;
  turnId?: string;
  handled?: boolean;
  assistantMessage?: string;
  rememberedPath?: string;
}

// ---- Backend events (Stem's canonical normalized protocol) ----
//
// Events arrive from the backend as { method, params } envelopes. We dispatch on
// `method`. Unknown methods are forwarded with the generic envelope and ignored
// by the UI.

export interface BackendEventEnvelope {
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

export interface BackendItemContentPart {
  type: string;
  text?: string;
}

export interface BackendItem {
  type: string; // 'userMessage' | 'agentMessage' | 'reasoning' | 'commandExecution' | 'mcpToolCall' | ...
  id: string;
  /** agentMessage carries its text here (a plain string). */
  text?: string;
  /** userMessage carries content as parts. */
  content?: BackendItemContentPart[];
  /** Tool items carry the real tool name (e.g. 'read', 'bash', 'mcp__…'). */
  name?: string;
  /** Tool items carry a short human target (file basename, command, query). */
  detail?: string;
}

/** `item/started` and `item/completed`. The completed agentMessage item carries authoritative text. */
export interface ItemEventParams {
  item: BackendItem;
  threadId: string;
  turnId: string;
}

/** `turn/completed`. */
export interface TurnCompletedParams {
  threadId: string;
  turn: { id: string; status: string; durationMs?: number | null };
}

/** `turn/timing` — per-turn latency breakdown emitted when a turn ends. */
export interface TurnTimingParams {
  threadId: string;
  turnId: string;
  ensureMs: number;
  buildMs: number | null;
  recall: { total: number | null; facts?: number | null; embed?: number | null; rerank?: number | null; search?: number | null };
  thinkingMs: number;
  toolMs: number;
  answerMs: number;
  sendToFirstActivityMs: number | null;
  sendToFirstTokenMs: number | null;
  firstTokenToEndMs: number | null;
  totalMs: number | null;
}

/** `turn/usage` — per-turn token usage emitted when an assistant message completes. */
export interface TurnUsageParams extends TurnUsage {
  threadId: string;
  turnId: string;
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
export function agentMessageText(item: BackendItem): string {
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
  /** 'agent' = auto-authored by Stem via manage_skill; 'user' = dropped in / bundled. */
  source: 'agent' | 'user';
  /** Version bumped on each agent patch/curate (auto-authored skills only). */
  version?: number;
  /** ISO timestamp of the last agent write (auto-authored skills only). */
  updatedAt?: string;
}

// ---- Files (the persistent drop-place the assistant can read) ----

/** One file in the Files folder. `rel` is the path relative to files/ (the id). */
export interface FileEntry {
  /** Path relative to files/, e.g. `Recipes/cake.pdf`. Unique id for removal. */
  rel: string;
  /** Basename, e.g. `cake.pdf`. */
  name: string;
  /** Top-level subfolder it lives in, or '' for the root of files/. */
  dir: string;
  /** Bytes on disk, for display. */
  size: number;
}

/** The Files folder contents: top-level subfolders (drive the drop bands) + files. */
export interface FilesListing {
  /** Absolute on-disk path of the Files folder (for "Open in Finder" + display). */
  root: string;
  /** Sorted top-level subfolder names. */
  dirs: string[];
  files: FileEntry[];
}

// ---- Connected folders (external folders the assistant reads in place) ----

/**
 * One external folder the user has connected so the assistant can read it where
 * it lives on disk (never copied). `mode` governs write protection (read-only is
 * enforced at the tool-call layer), `memorize` whether content read from it may
 * enter Stem's cross-chat memory (off = private; the client vault default).
 */
export interface ConnectedFolder {
  /** Stable id (randomUUID), used for update/remove. */
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** Display name (defaults to the folder's basename). */
  label: string;
  /** 'read' = the assistant may read but not modify; 'readwrite' = may also edit. */
  mode: 'read' | 'readwrite';
  /** When false, content read from this folder is kept out of Stem Recall. */
  memorize: boolean;
  /** Optional one-line description, injected so the assistant knows what it is. */
  note?: string;
  /** Computed on list: the path no longer exists on disk. Not persisted. */
  missing?: boolean;
}

/** The mutable fields of a connected folder (label/mode/memorize/note). */
export type ConnectedFolderPatch = Partial<Pick<ConnectedFolder, 'label' | 'mode' | 'memorize' | 'note'>>;

// ---- Scheduled tasks ----
//
// A scheduled task re-runs a prompt as a full autonomous agent turn on a schedule.
// It is created conversationally (the assistant's `schedule_task` tool) and bound
// to the originating chat: every run appends a turn to that thread. Runs are silent
// by default; the agent calls `notify_user` when a run produces something worth
// surfacing (a prominent in-app modal). Stem-owned (the pi backend has no concept
// of schedules), persisted as tasks.json under userData.

/** When a task fires: a recurring cron expression, or a one-time ISO datetime. */
export type TaskSchedule =
  | { kind: 'cron'; expr: string }
  | { kind: 'once'; at: string };

export interface ScheduledTask {
  /** Stable id (randomUUID). */
  id: string;
  /** The chat this task belongs to; each run appends a turn here. */
  threadId: string;
  /** The prompt re-run on each firing. */
  prompt: string;
  schedule: TaskSchedule;
  /** Paused tasks stay in the list but never fire. */
  enabled: boolean;
  /** ISO timestamp the task was created. */
  createdAt: string;
  /** ISO timestamp of the last completed run (for catch-up + the UI). */
  lastRunAt?: string;
  /** ISO timestamp of the next scheduled firing (computed; null once a `once` task is done). */
  nextRunAt?: string | null;
  /** Outcome of the most recent run. */
  lastStatus?: 'ok' | 'failed' | 'running';
  /** Short human label derived from the prompt, for the list + chat badge. */
  title: string;
}

/** What the assistant's `schedule_task` tool passes (exactly one of cron/at). */
export interface ScheduleTaskRequest {
  prompt: string;
  /** A 5-field cron expression for a recurring task. */
  cron?: string;
  /** An ISO datetime for a one-time task. */
  at?: string;
}

/** Editable fields when updating a task's schedule from the Tasks tab. */
export type TaskSchedulePatch = { schedule: TaskSchedule };

/** Main → renderer: a scheduled run just started (insert a collapsed run row live). */
export interface ScheduledRunPayload {
  threadId: string;
  turnId: string;
  taskId: string;
  /** The prompt being run (shown as the run's user bubble). */
  prompt: string;
  /** ISO timestamp the run started (the "Scheduled run — HH:MM" label). */
  at: string;
}

/** Main → renderer: the agent called notify_user during a run; show the alert modal. */
export interface TaskNotifyPayload {
  threadId: string;
  taskId?: string;
  title?: string;
  message: string;
  /** ISO timestamp the notification fired. */
  at: string;
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
  /** Raw `auth_status` from the backend's MCP listing, when reported (e.g. 'o_auth'). */
  authStatus?: string;
  /**
   * Whether the server is connected on (re)start. A disabled server stays in
   * `mcp.json` (config + OAuth token preserved) but the bridge skips it. Derived
   * from `!def.disabled`.
   */
  enabled: boolean;
}

/**
 * Live connection status of an MCP server in the running app-server, from
 * `mcpServer/startupStatus/updated` notifications. `ready` = tools available;
 * `failed` = the server dropped (for remote OAuth servers, usually a rejected
 * token → needs re-login). Distinct from `authStatus`, which only reflects
 * whether credentials exist on disk, not whether the connection works.
 */
export interface McpServerStatus {
  status: string;
  error: string | null;
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  /** Required for stdio. */
  command?: string;
  args?: string[];
  /** Required for http. */
  url?: string;
  /** Environment variables for the spawned stdio server (e.g. API tokens). */
  env?: Record<string, string>;
  /** HTTP headers for a remote server (e.g. `Authorization: Bearer …`). pi backend. */
  headers?: Record<string, string>;
  /**
   * OAuth (http only) for servers without dynamic client registration — you
   * pre-register an app with the provider and supply its credentials. When
   * `oauthClientId` is set, Stem's sign-in skips DCR and runs the confidential-
   * client code flow. `oauthScope` is the space/comma-separated scope string
   * (must match what you enabled on the provider app).
   */
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScope?: string;
}

export interface McpLoginResult {
  ok: boolean;
  error?: string;
}

// ---- Assistant-initiated MCP changes (the `stem-admin` self-management server) ----
//
// When the chat assistant calls its add/remove MCP tools, the backend gates the
// call through an approval. Stem surfaces that as an in-app confirm card; only on
// approval is the MCP config written and hot-reloaded.

/**
 * A pending assistant-proposed MCP change awaiting the user's approval.
 * `id` is the backend's approval request id — pass it back to approve/decline.
 */
export interface McpAdminProposal {
  id: number | string;
  threadId: string;
  action: 'add' | 'remove';
  /** Present for `add`: the server the assistant wants to configure. */
  input?: McpServerInput;
  /** Present for `remove` (and as a label for `add`): the server name. */
  name?: string;
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
  /** Max on-disk size for the episodic store, in bytes (0 = unlimited). */
  episodicLimitBytes: number;
  /** New-fact count that triggers an automatic tidy-up (0 = manual only). */
  tidyThreshold: number;
}

/** Metadata for the Level-2 episodic store, shown in the Memory → Recall sub-tab. */
export interface EpisodicStats {
  /** Number of captured messages in the episodic store. */
  messageCount: number;
  /** On-disk size of recall.sqlite (+ WAL sidecar) in bytes. */
  sizeBytes: number;
}

/** `note` is a user-provided memory; `native` is a backend-generated technical file. */
export type MemoryFileKind = 'note' | 'native';

/** One on-disk memory markdown file; `exists:false` when not yet written. */
export interface MemoryFile {
  name: string;
  label: string;
  content: string;
  exists: boolean;
  kind: MemoryFileKind;
  /** Notes only: the durable-fact id, for the "forget this" affordance. */
  id?: number;
  /** Notes only: the cleaned fact (boilerplate/blockquote stripped). */
  statement?: string;
  /** Notes only: short human chip for how it was captured. */
  source?: string;
}

export interface MemoryContents {
  files: MemoryFile[];
  /** True when no file has any non-whitespace content. */
  isEmpty: boolean;
}

/** Outcome of a manual consolidation pass, plus the refreshed memory list. */
export interface MemoryConsolidateResult {
  merged: number;
  corrected: number;
  dropped: number;
  contents: MemoryContents;
}

// ---- Chats (backend-backed) + Folders (Stem-owned organization) ----
//
// A "chat" is a backend thread (the backend persists threads on disk in its home).
// Folders are a pure-organization layer Stem owns: the backend has no folder
// concept, so the folder tree and the chat->folder assignment live in a Stem JSON store.

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

/** A chat row in the sidebar — a backend thread merged with its folder assignment. */
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
  /**
   * Inactivity window (ms) after which re-summoning the overlay starts a *fresh*
   * thread instead of continuing the current one. 0 = never auto-reset (always
   * continue the existing session).
   */
  newThreadTimeoutMs: number;
  /**
   * Show the bottom-left progress pill for main-window threads whenever the main
   * window loses focus (you switch Spaces or apps), so an active thread's progress
   * stays visible. Hidden again when the main window regains focus.
   */
  followAcrossSpaces: boolean;
  /** Play a macOS chime when a turn finishes while the progress pill is visible. */
  finishSound: boolean;
}

/**
 * Native (server-side) web search, toggled independently per context. The UI only
 * surfaces a toggle when the relevant model's provider actually supports it; the
 * backend injects the tool per turn based on the originating context.
 */
export interface NativeWebSearchSettings {
  /** Main window turns. */
  main: boolean;
  /** Quick Chat overlay turns. */
  quickChat: boolean;
}

/** Model used for Stem Recall's hidden memory turns (distillation + tidy-up). */
export interface MemoryModelSettings {
  /** `provider/model` id; null = the backend default (gpt-5.3-codex-spark). */
  model: string | null;
}

/** Model used for the background skills curator (merge/patch/archive of auto-created skills). */
export interface SkillsModelSettings {
  /** `provider/model` id; null = the backend default. */
  model: string | null;
}

/**
 * One HTTP retrieval endpoint (embeddings or reranker). Free-text — Stem just
 * makes the call — so it works with Ollama, vLLM, LM Studio, TEI, or a hosted API.
 * Disabled by default; until enabled+configured, fact selection stays recency-based.
 */
export interface RetrievalEndpointSettings {
  /** Base URL, e.g. http://localhost:11434 (no path; Stem appends /v1/embeddings or /rerank). */
  baseUrl: string;
  /** Model id as the server names it, e.g. qwen3-embedding:8b. */
  model: string;
  /** Optional bearer token for hosted/secured endpoints. */
  apiKey: string | null;
  enabled: boolean;
}

/**
 * Reusable two-stage retrieval config: embeddings (candidate ranking) + reranker
 * (precision reorder). Used today to rank durable facts at inject time; the same
 * seam can back episodic semantic search later.
 */
export interface RetrievalSettings {
  embeddings: RetrievalEndpointSettings;
  reranker: RetrievalEndpointSettings;
}

/** A partial retrieval patch — update either stage, any subset of its fields. */
export interface PartialRetrievalSettings {
  embeddings?: Partial<RetrievalEndpointSettings>;
  reranker?: Partial<RetrievalEndpointSettings>;
}

/** Embedding-cache coverage for the configured model — shown in the Manage panel. */
export interface EmbeddingCacheStats {
  /** Total durable facts. */
  factCount: number;
  /** Facts with a cached vector for the current embeddings model. */
  embeddedCount: number;
  /** Vector dimension for the current model, or null when nothing is cached. */
  dim: number | null;
}

export type RetrievalStage = 'embeddings' | 'reranker';

/** Result of a live probe against a retrieval endpoint (the Settings "Test" button). */
export interface RetrievalTestResult {
  ok: boolean;
  /** Human-readable detail: dims/latency on success, or the error (e.g. ECONNREFUSED). */
  detail: string;
}

export interface AppSettings {
  quickChat: QuickChatSettings;
  nativeWebSearch: NativeWebSearchSettings;
  memory: MemoryModelSettings;
  skills: SkillsModelSettings;
  retrieval: RetrievalSettings;
}

/**
 * A prompt the overlay runs itself (via `runQuickChat`). The overlay owns its
 * conversation, so it passes its current `threadId` for follow-up turns; omit it
 * (or after a New-thread / inactivity reset) to start a fresh thread.
 */
export interface QuickChatPrompt {
  input: string;
  /** Model chosen in the overlay; null = use the overlay's default model. */
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  format?: 'md' | 'mdx';
  /** Continue this thread; absent => main pre-creates a fresh one. */
  threadId?: string;
  /** Files/images attached to this turn (ChatView composer). */
  attachments?: TurnAttachment[];
}

/** HUD phases for the bottom-left status pill while the overlay is hidden. */
export type QuickChatStatusPhase = 'working' | 'answering' | 'finished';

/** Main → HUD: the one-line status to display. */
export interface QuickChatStatus {
  phase: QuickChatStatusPhase;
  label: string;
  /**
   * Where clicking the pill should go: 'overlay' (default) re-summons the Quick
   * Chat overlay; 'main' raises the main window (used by the follow-me pill that
   * tracks a main-window thread across Spaces).
   */
  reveal?: 'overlay' | 'main';
  /**
   * The currently-registered global accelerator (e.g. 'Alt+Space'), so the
   * "finished" pill can prompt the user with the real key that re-summons the
   * overlay. Null when no shortcut is bound (the pill is still clickable).
   */
  shortcut?: string | null;
}

/** Main → overlay: sent on each summon; `reset` starts a fresh session. */
export interface QuickChatFocus {
  reset: boolean;
}

/** Overlay → main: hand the live conversation off to the main window. */
export interface QuickChatHandoff {
  threadId: string;
  messages: ChatMessage[];
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
}

/** Main → main window: adopt a handed-off conversation as the active chat. */
export type QuickChatAdopt = QuickChatHandoff;

/** Main → main window: a quickchat thread was created (optimistic sidebar row). */
export interface QuickChatSessionStarted {
  threadId: string;
  title: string;
}

// ---- Preload API surface exposed on window.stem ----

export interface StemApi {
  runtimeStatus(): Promise<RuntimeStatus>;
  login(): Promise<RuntimeStatus>;
  startTurn(input: StartTurnInput): Promise<StartTurnResult>;
  interruptTurn(turnId: string): Promise<void>;
  newConversation(): Promise<void>;
  onBackendEvent(listener: (event: BackendEventEnvelope) => void): () => void;

  /** Open a native file picker; returns chosen absolute paths ([] if canceled). */
  openFiles(): Promise<string[]>;
  /** Resolve the on-disk path of a dropped File (empty string if unavailable). */
  getPathForFile(file: File): string;

  listModels(): Promise<ModelSummary[]>;

  listSkills(): Promise<SkillSummary[]>;
  setSkillEnabled(slug: string, enabled: boolean): Promise<SkillSummary[]>;
  /** Run the skills curator now (merge duplicates, patch, archive). Returns fresh list. */
  curateSkills(): Promise<SkillSummary[]>;
  /** Fired after skills change (auto-create/patch by the assistant, or the curator). */
  onSkillsChanged(listener: () => void): () => void;

  // Files: the persistent drop-place. Mutations return the fresh listing.
  listFiles(): Promise<FilesListing>;
  /** Copy files into files/<subdir> (subdir '' = root). Returns fresh listing. */
  addFiles(paths: string[], subdir?: string): Promise<FilesListing>;
  /** Delete a file by its rel path. Returns fresh listing. */
  removeFile(rel: string): Promise<FilesListing>;
  /** Open the Files folder in the OS file manager. */
  revealFiles(): Promise<void>;
  /** Read an on-disk image → `data:` URL for a bubble thumbnail (null if not an image). */
  previewImage(path: string): Promise<string | null>;

  // Connected folders: external folders the assistant reads in place. Mutations
  // return the fresh list.
  listConnectedFolders(): Promise<ConnectedFolder[]>;
  /** Register one or more external folders (absolute paths). Returns fresh list. */
  addConnectedFolders(paths: string[]): Promise<ConnectedFolder[]>;
  /** Patch a folder's label/mode/memorize/note. Returns fresh list. */
  updateConnectedFolder(id: string, patch: ConnectedFolderPatch): Promise<ConnectedFolder[]>;
  /** Forget a connected folder (does not touch the folder on disk). Returns fresh list. */
  removeConnectedFolder(id: string): Promise<ConnectedFolder[]>;
  /** Open a connected folder in the OS file manager. */
  revealConnectedFolder(id: string): Promise<void>;
  /** Open Stem's own workspace folder (containing the Files place) in the OS file manager. */
  openWorkspaceFolder(): Promise<void>;
  /** Open a native directory picker; returns chosen absolute paths ([] if canceled). */
  pickDirectory(): Promise<string[]>;

  // Scheduled tasks. Mutations return the fresh list (like the folders APIs).
  listTasks(): Promise<ScheduledTask[]>;
  /** Pause/resume a task without deleting it. Returns the fresh list. */
  setTaskEnabled(id: string, enabled: boolean): Promise<ScheduledTask[]>;
  /** Run a task immediately (off-schedule). Returns the fresh list. */
  runTaskNow(id: string): Promise<ScheduledTask[]>;
  /** Delete a task. Returns the fresh list. */
  deleteTask(id: string): Promise<ScheduledTask[]>;
  /** Replace a task's schedule (cron/once). Returns the fresh list. */
  updateTaskSchedule(id: string, patch: TaskSchedulePatch): Promise<ScheduledTask[]>;
  /** Fired whenever the task list changes (created/updated/run/deleted). */
  onTasksChanged(listener: (tasks: ScheduledTask[]) => void): () => void;
  /** Fired when a scheduled run starts, so the open thread can show a collapsed run row. */
  onScheduledRun(listener: (run: ScheduledRunPayload) => void): () => void;
  /** Fired when the agent calls notify_user during a run — show the prominent alert modal. */
  onTaskNotify(listener: (payload: TaskNotifyPayload) => void): () => void;

  listMcpServers(): Promise<McpServerSummary[]>;
  /** Live per-server connection status (keyed by name) from the running app-server. */
  getMcpStatus(): Promise<Record<string, McpServerStatus>>;
  addMcpServer(input: McpServerInput): Promise<McpServerSummary[]>;
  removeMcpServer(name: string): Promise<McpServerSummary[]>;
  /** Enable/disable a server without removing it (preserves config + OAuth token). */
  setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServerSummary[]>;
  loginMcpServer(name: string): Promise<McpLoginResult>;
  restartRuntime(): Promise<RuntimeStatus>;
  /** Assistant proposed an MCP change; fired so the UI can show a confirm card. */
  onMcpAdminApproval(listener: (proposal: McpAdminProposal) => void): () => void;
  /** Approve/decline an assistant-proposed MCP change by its elicitation id. */
  respondMcpAdminApproval(id: number | string, accept: boolean): Promise<void>;
  /** Fired after an assistant-initiated MCP change is applied + hot-reloaded. */
  onMcpChanged(listener: () => void): () => void;
  /** Live MCP connection-status updates (keyed by server name). */
  onMcpStatus(listener: (status: Record<string, McpServerStatus>) => void): () => void;

  getMemorySettings(): Promise<MemorySettings>;
  setMemoryEnabled(enabled: boolean): Promise<MemorySettings>;
  readMemory(): Promise<MemoryContents>;
  /** Delete one durable fact; returns the refreshed memory list. */
  forgetMemory(id: number): Promise<MemoryContents>;
  /** Wipe durable facts (Level 1); keeps episodic + toggle. Returns the empty fact list. */
  resetFactsMemory(): Promise<MemoryContents>;
  /** Wipe the episodic store (Level 2); keeps facts + toggle. Returns refreshed stats. */
  resetEpisodicMemory(): Promise<EpisodicStats>;
  /** Run a consolidation pass now (merge/correct/drop duplicates + stale facts). */
  consolidateMemory(): Promise<MemoryConsolidateResult>;
  /** Episodic-store metadata for the Memory → Recall sub-tab (count + size only). */
  getEpisodicStats(): Promise<EpisodicStats>;
  /** Set the episodic-store size cap (bytes; 0 = unlimited); returns refreshed settings. */
  setEpisodicLimit(bytes: number): Promise<MemorySettings>;
  /** Set the auto-tidy-up fact threshold (0 = manual only); returns refreshed settings. */
  setTidyThreshold(n: number): Promise<MemorySettings>;

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
  /** Enable/disable native web search per context (e.g. { quickChat: false }). */
  updateNativeWebSearch(patch: Partial<NativeWebSearchSettings>): Promise<AppSettings>;
  /** Set the model used for memory distillation/tidy-up ({ model: null } = default). */
  updateMemorySettings(patch: Partial<MemoryModelSettings>): Promise<AppSettings>;
  updateSkillsSettings(patch: Partial<SkillsModelSettings>): Promise<AppSettings>;
  /** Update the embeddings/reranker retrieval endpoints (deep-merged per stage). */
  updateRetrievalSettings(patch: PartialRetrievalSettings): Promise<AppSettings>;
  /** Live-probe a retrieval endpoint with the current settings (Settings "Test" button). */
  testRetrievalEndpoint(stage: RetrievalStage): Promise<RetrievalTestResult>;
  /** Embedding-cache coverage for the configured model (how many facts are embedded). */
  getEmbeddingStats(): Promise<EmbeddingCacheStats>;
  /** Overlay → main: run a prompt in the overlay's own thread (main hides the
   *  overlay + raises the HUD, pre-creating a thread for a fresh session). */
  runQuickChat(prompt: QuickChatPrompt): Promise<StartTurnResult>;
  /** Overlay → main: forget the current overlay thread so the next prompt is fresh. */
  newQuickChatThread(): Promise<void>;
  /** Overlay → main: hand the conversation off to the main window. */
  handoffQuickChat(payload: QuickChatHandoff): Promise<void>;
  /** Re-summon the overlay (same path as the global shortcut); used by the HUD. */
  revealQuickChat(): Promise<void>;
  /** Raise the main window; used by the follow-me HUD pill (reveal === 'main'). */
  revealMain(): Promise<void>;
  /** Hide the overlay (Escape from within it). */
  hideQuickChat(): Promise<void>;
  /** Overlay: fired each time the overlay is summoned; `reset` => fresh session. */
  onQuickChatFocus(listener: (focus: QuickChatFocus) => void): () => void;
  /** HUD: fired with the current one-line status while the overlay is hidden. */
  onQuickChatStatus(listener: (status: QuickChatStatus) => void): () => void;
  /** Main window: fired when the overlay hands a conversation off to adopt it. */
  onQuickChatAdopt(listener: (payload: QuickChatAdopt) => void): () => void;
  /** Main window: fired when a quickchat thread is created (optimistic sidebar row). */
  onQuickChatSessionStarted(listener: (payload: QuickChatSessionStarted) => void): () => void;
}
