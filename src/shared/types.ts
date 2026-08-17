// Shared contracts between main, preload, and renderer. Single source of truth.

import type { InboxState } from './inbox';

export type { InboxEntry, InboxState } from './inbox';

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
 * One tool call (web search included) that ran during a turn, shown as an
 * activity row in the assistant bubble — live while running, collapsed into a
 * "Used N tools" summary once the turn settles. Persisted per turn so rows
 * survive reopen.
 */
export interface ActivityItem {
  /** toolCallId (or the provider's web_search item id). */
  id: string;
  kind: 'tool' | 'webSearch';
  /** Normalized item type (commandExecution/fileChange/mcpToolCall/webSearch). */
  type: string;
  /** Real tool name ('read', 'grep', an MCP tool) when known. */
  name?: string;
  /** Short human target: file basename, command, search query. */
  detail?: string;
  status: 'running' | 'ok' | 'error';
  /**
   * Wall-clock time the tool took, filled in when it settles.
   *
   * Without it `TurnTiming.toolMs` is one opaque number for the whole turn: a
   * two-minute turn could be one slow web search or forty fast file reads, and
   * nothing could tell you which. That is how a ~10x web-search latency
   * regression shipped unnoticed — see tests/unit/web-search-latency.test.ts.
   */
  ms?: number;
}

/** A web source the model consulted, parsed out of a web_search result. */
export interface SourceRef {
  url: string;
  title?: string;
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
  /**
   * User messages only: the original sendable attachment inputs. Kept separately
   * from the display-only `attachments` shape so Retry/Edit can faithfully rerun
   * a live turn (paths for picked files, base64 for pasted images).
   */
  turnAttachments?: TurnAttachment[];
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
  /** Assistant messages only: the tool calls/web searches that ran this turn. */
  activity?: ActivityItem[];
  /** Assistant messages only: web sources consulted by the search tools. */
  sources?: SourceRef[];
  /**
   * ISO timestamp the message was authored. Surfaced as a hover-revealed label on
   * user bubbles (mirroring the assistant model/timing reveal). Read from the pi
   * session entry on replay; stamped optimistically when the user sends.
   */
  createdAt?: string;
  /**
   * User messages only: the send was rejected before a turn existed (startTurn
   * threw — e.g. "agent is already processing"), so this message never reached
   * the backend. Retry/edit/delete on it are local splices + re-send, not the
   * turn-id rollback path (there is no turn to roll back).
   */
  sendFailed?: boolean;
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
  /** Provider ids Stem holds credentials for (keys of the isolated auth.json). */
  providers?: string[];
  /** Copy-pasteable login command, surfaced when not authenticated (diagnostics). */
  loginCommand?: string;
  error?: string;
}

// ---- Provider sign-in (onboarding wizard) ----

/** Providers the wizard can OAuth into (pi's registered OAuth flows, minus Copilot). */
export type AuthProviderId = 'anthropic' | 'openai-codex' | 'xai';

/** Providers accepting a plain API key (written to auth.json as type:'api_key'). */
export type ApiKeyProviderId = 'anthropic' | 'openai' | 'openrouter' | 'xai';

/**
 * OpenAI-compatible model servers Stem can register with the backend (via the
 * isolated pi-home's models.json), as opposed to the providers pi knows about
 * natively. `ollama`/`lmstudio` are the keyless localhost servers — they get a
 * placeholder auth.json entry so the backend and Stem's provider filter treat
 * them as signed in. `custom` is a user-supplied endpoint: any URL, optionally
 * behind an API key, with the model ids typed by hand (see below).
 */
export type LocalProviderId = 'ollama' | 'lmstudio' | 'custom';

/**
 * Which API flavor the custom endpoint speaks. Ollama and LM Studio are always
 * OpenAI-compatible; only `custom` may set this to `anthropic-messages` (for
 * Anthropic's Messages API or a proxy that speaks it). Default (absent) is
 * `openai-completions` — matches the pre-existing single-flavor behavior.
 */
export type LocalProviderApi = 'openai-completions' | 'anthropic-messages';

export interface LocalProviderSettings {
  enabled: boolean;
  /** Server root, e.g. http://localhost:11434 (no path; Stem appends /v1/…). */
  baseUrl: string;
  /**
   * API flavor the server speaks. `custom` only — Ollama/LM Studio always use
   * `openai-completions`. Absent = `openai-completions`.
   */
  api?: LocalProviderApi;
  /**
   * Bearer token for endpoints that require one (`custom`). Absent/empty = the
   * keyless placeholder. Stored here rather than only in auth.json because every
   * step of the enable flow — probe, models.json write, credential write — needs
   * it in the same pass, and re-probing later (the 30s local-model refresh) needs
   * it again without a round-trip through pi.
   */
  apiKey?: string;
  /**
   * Model ids entered by hand, used verbatim instead of probing GET /v1/models.
   * Endpoints behind a gateway often don't serve a listing (or serve one far
   * larger than what the key can actually reach), so `custom` names its models
   * explicitly; empty/absent means "ask the server".
   */
  models?: string[];
  /**
   * Custom endpoint only. When true, Stem writes `modelExtras` / `providerCompat`
   * into models.json instead of `{ id }` stubs, and will not drop those extras
   * on a catalog sync. Cleared on disconnect or when the typed-ID Enable path
   * replaces the overlay.
   */
  preserveModelsConfig?: boolean;
  /**
   * Custom endpoint only. Full Pi model objects (id plus reasoning, maxTokens,
   * thinkingLevelMap, per-model compat, …) copied from a models.json overlay.
   * Authoritative for the custom catalog when `preserveModelsConfig` is set.
   */
  modelExtras?: Record<string, unknown>[];
  /**
   * Custom endpoint only. Provider-level `compat` copied from the overlay
   * (thinkingFormat, supportsReasoningEffort, chatTemplateKwargs, …).
   */
  providerCompat?: Record<string, unknown>;
  /**
   * Custom endpoint only. Optional extra HTTP headers from the overlay, written
   * onto the custom provider block as Pi `headers`.
   */
  providerHeaders?: Record<string, string>;
}

/** One provider listed from a pasted or linked Pi models.json overlay. */
export interface PiModelsOverlayProvider {
  id: string;
  modelIds: string[];
  baseUrl?: string;
}

/** Preview of a Pi models.json (paste or path) before copying onto Custom. */
export interface PiModelsOverlayPreview {
  ok: boolean;
  providers?: PiModelsOverlayProvider[];
  error?: string;
}

/** Result of copying a Pi overlay onto Stem's Custom endpoint. */
export interface PiModelsOverlayCopyResult {
  ok: boolean;
  error?: string;
  status?: RuntimeStatus;
}

export type LocalProvidersSettings = Record<LocalProviderId, LocalProviderSettings>;

/** Result of probing a local server's /v1/models (the "Test" button / onboarding). */
export interface LocalProviderTestResult {
  ok: boolean;
  /** Model ids the server reported (ok only), minus tool-incapable ones. */
  models?: string[];
  /**
   * Which API flavor answered the probe (ok only) — the caller's own pick when
   * one was given, otherwise whatever auto-detect settled on. Renderer uses it
   * to snap the API dropdown to the detected value so Enable writes the same
   * flavor that just tested green.
   */
  api?: LocalProviderApi;
  /**
   * Models hidden because they can't call tools (Ollama reports capabilities and
   * rejects tool-bearing requests outright — and Stem's turns always carry tools).
   */
  skippedNoTools?: number;
  /** Human-readable failure, e.g. ECONNREFUSED (not ok only). */
  error?: string;
}

/**
 * Main → renderer pushes while a provider login is in flight. `input-request`
 * expects the renderer to answer via providerLoginRespond(requestId, value)
 * (e.g. pasting the code manually when the localhost callback can't run).
 */
export type AuthUiEvent =
  | { kind: 'auth-url'; url: string; instructions?: string }
  | { kind: 'device-code'; userCode: string; verificationUri: string }
  | { kind: 'progress'; message: string }
  | { kind: 'input-request'; requestId: string; message: string; placeholder?: string }
  | { kind: 'done'; ok: true; provider: string }
  | { kind: 'done'; ok: false; provider: string; error: string };

/** Result of a providerLogin/setApiKey IPC call; status is fresh when ok. */
export interface ProviderLoginResult {
  ok: boolean;
  error?: string;
  status?: RuntimeStatus;
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
   * Which client surface asked for this turn. The two per-surface settings below
   * are resolved from it by the `backend:startTurn` handler, so a client states
   * where it is rather than reading the user's settings itself. Omitted means
   * 'main' — the main window never sends it, and that is what it would say.
   */
  surface?: 'main' | 'quickChat';
  /**
   * Whether native (server-side) web search is allowed this turn. Resolved from
   * `surface` (main → `webSearch.main`; Quick Chat → `webSearch.quickChat`), so a
   * value arriving on the channel is overwritten. The backend only injects the
   * tool when the selected model's provider actually supports it; otherwise this
   * is a no-op. Defaults to enabled when omitted, which is how the scheduler's
   * headless runs — which call the backend directly — ask for it.
   */
  webSearch?: boolean;
  /**
   * The user's standing custom instructions, resolved from `surface` (main →
   * `customInstructions.main`; Quick Chat → main + quickChat). Injected as an
   * authoritative high-priority block in the turn's context. Empty/omitted → no
   * block. Internal turns (distill/consolidate via `complete()`) and scheduled
   * runs never set this.
   */
  instructions?: string;
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
  // No web-search capability flag: search is served by the vendored pi-web-access
  // extension rather than the provider, so every model in this list has it.
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
  /** Tool items on `item/completed`: how the call ended. */
  status?: 'ok' | 'error';
}

/** `item/started` and `item/completed`. The completed agentMessage item carries authoritative text. */
export interface ItemEventParams {
  item: BackendItem;
  threadId: string;
  turnId: string;
}

/** `turn/completed` and `turn/failed` (the latter carries the failure text). */
export interface TurnCompletedParams {
  threadId: string;
  turn: { id: string; status: string; durationMs?: number | null };
  /** Human-readable failure reason on `turn/failed`. */
  error?: string;
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

/** `turn/sources` — web sources cited by the search tools, emitted at turn end. */
export interface TurnSourcesParams {
  threadId: string;
  turnId: string;
  sources: SourceRef[];
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
  /** Times the assistant consulted this skill (0 = never since tracking began). */
  useCount?: number;
  /** ISO timestamp of the most recent use. */
  lastUsedAt?: string;
}

// ---- Files (the persistent drop-place the assistant can read) ----

/**
 * How many file names the per-turn Files context lists before truncating (see
 * server/files/inject.ts). Shared so the Files tab can warn once the folder grows
 * past the point where the assistant is still told about every file.
 */
export const FILES_CONTEXT_LIMIT = 100;

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
  /**
   * When true, Stem maintains a local search index (FTS + embeddings) over the
   * folder's text files so relevant content surfaces in recall pre-turn injection
   * and semantic search. The folder itself is never modified; disconnecting or
   * toggling this off deletes the index.
   */
  index?: boolean;
  /**
   * How Stem learns durable facts from this folder's indexed content (only
   * effective while `index` and `memorize` are both on). Ordinal — each level
   * includes the ones below it:
   *  'off'  — never learn from this folder;
   *  'use'  — (default when absent) learn only from excerpts that actually
   *           surfaced in conversations, riding the normal conversation distill;
   *  'new'  — additionally distill files added or changed from now on;
   *  'all'  — backlog-sweep every indexed file, then behave like 'new'.
   */
  learnMode?: 'off' | 'use' | 'new' | 'all';
  /** Model for 'new'/'all' distillation; absent = the Settings → Memory model. */
  learnModel?: string;
  /** Computed on list: the path no longer exists on disk. Not persisted. */
  missing?: boolean;
}

/** The mutable fields of a connected folder (label/mode/memorize/note/index/learn*). */
export type ConnectedFolderPatch = Partial<
  Pick<ConnectedFolder, 'label' | 'mode' | 'memorize' | 'note' | 'index' | 'learnMode' | 'learnModel'>
>;

/**
 * One directory of the SERVER's filesystem, as the remote folder picker walks
 * it. The native OS picker opens on the client's machine, which is the wrong
 * disk whenever the server is elsewhere — so the picker asks the server for one
 * level at a time and renders this.
 */
export interface ServerFolderListing {
  /** Absolute path listed (resolved on the server). */
  path: string;
  /** Its parent, or null when `path` is the filesystem root. */
  parent: string | null;
  /** The server user's home directory — where browsing starts. */
  home: string;
  /** Sub-directories (dot-directories filtered), sorted by name. */
  dirs: { name: string; path: string }[];
  /** Set when `path` could not be read; `dirs` is empty and navigation stays up. */
  error?: string;
}

/**
 * Index health for one indexed connected folder (computed from its index DB —
 * never persisted in connected-folders.json).
 */
export interface FolderIndexStatus {
  /** Documents currently in the index. */
  indexedCount: number;
  /** Files seen but not indexed, total (sum of skippedByExt). */
  skippedCount: number;
  /** Skip breakdown: extension (or 'too-large' / 'binary') → count. */
  skippedByExt: Record<string, number>;
  /** Indexed docs still waiting for an embedding vector. */
  pendingEmbeds: number;
  /** Unix seconds of the last completed scan, or null before the first one. */
  lastScanTs: number | null;
  /** Total characters of indexed text (drives the "≈N model calls" estimate). */
  totalTextChars: number;
  /** Fact-learning state (the 'new'/'all' distill engine + attribution). */
  learn: {
    /** Docs not yet distilled at their current content (backlog + changed). */
    pending: number;
    /** Active facts attributed to this folder (source `folder:<id>`). */
    facts: number;
    /** Unix seconds of the last successful learn batch, or null. */
    lastTs: number | null;
  };
}

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

/**
 * The model/effort a scheduled run of a thread would use — the thread's last
 * explicitly selected model (`provider/modelId`) and thinking level, resolved
 * from its session file. Either field is absent when the thread never recorded
 * one (the run then stays on the backend's default).
 */
export interface ThreadTurnSettings {
  model?: string;
  effort?: string;
}

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
  /**
   * Why the most recent run failed, cleared by the next run that doesn't. A row
   * that says only "failed" is a row nobody can act on: the reason lived in the
   * log at best, and for a whole class of failures not even there.
   */
  lastError?: string;
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

/**
 * HOW a server is spoken to: stdio = a spawned `command` + `args`; http = a
 * streamable-HTTP `url`. Not WHERE it runs — that is {@link McpServerLocation},
 * a perpendicular axis, and all four combinations are meaningful.
 */
export type McpTransport = 'stdio' | 'http';

/**
 * Which machine a server runs on, as the panel needs to render it. Absent on a
 * summary means the machine hosting stem-server, which is where every server has
 * always run.
 */
export interface McpServerLocation {
  deviceId: string;
  /** The device's label, carried along so a row can name a place without a second call. */
  label: string;
  /** The deviceId is no longer in the registry — that device was unpaired. */
  orphaned?: boolean;
  /**
   * What that device was called when the pin was written, kept in mcp.json
   * beside the id. Pairing mints a NEW id, so re-pairing the same Mac — after
   * the rollback in running-on-a-server.md, after an import, after switching to
   * "this computer's server" and back — orphans every server pinned to it. This
   * is what lets the orphan say which machine it meant instead of showing an id.
   *
   * A display fact and nothing else. Nothing routes on it, nothing matches on it
   * to decide what may run, and it is not in the spec fingerprint: a label is
   * typed by a person and duplicated as easily as it is chosen, and ⑩ refuses to
   * guess which machine an orphan meant precisely because guessing wrong runs
   * somebody's command somewhere they did not put it.
   */
  rememberedLabel?: string;
}

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
  /** Where it runs; absent = on the machine hosting the server. */
  location?: McpServerLocation;
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
  /**
   * Pin the server to a paired desktop instead of running it where stem-server
   * runs. Omitted = the server's own machine, which is what every add has meant
   * so far. The label is NOT supplied here — it is read from the registry, so a
   * caller cannot make a row claim to be a machine it is not.
   */
  location?: { deviceId: string };
}

export interface McpLoginResult {
  ok: boolean;
  error?: string;
}

// ---- Servers pinned to a device (docs/mcp-device-pinning.md) ----
//
// A server with a `location` runs on a paired desktop instead of on the machine
// hosting stem-server, and everything below is what the two ends say to each
// other about one: what a device is asked to host, what it reports back, and the
// single call in flight between them.
//
// The types live here rather than beside the router because both ends need them
// and neither owns them — the desktop reads a request off its event stream and
// answers on a channel the server registered, so a copy on either side would be
// a copy that can drift.

/**
 * The name of the addressed control frame that carries one call to the device
 * hosting a server. A control frame rather than a push because it is addressed:
 * it goes to one device's streams and never enters the replay ring, which every
 * connected device is entitled to read (see transport/server.ts).
 */
export const MCP_REQUEST_FRAME = 'mcp-request';

/**
 * The name of the addressed control frame that tells one device its assignments
 * changed. It carries nothing: the answer to "what do I host now" is
 * `mcpHost:hello`, and a frame that also carried the new list would be a second
 * copy of that answer able to disagree with it.
 *
 * It exists because mcp.json is written centrally and read by whichever machine
 * runs the server. Without it, a pin edited from a phone — or by the assistant,
 * or from a second desktop — reaches the hosting machine only at its next launch
 * or reconnect, which means a removed server keeps its child alive over there
 * and a re-added one keeps running the spec it was approved for last week.
 */
export const MCP_ASSIGNMENTS_FRAME = 'mcp-assignments';

/**
 * The transport half of an entry in mcp.json, as the machine that will actually
 * run the server needs it. Credentials are IN it — decrypted env values, header
 * values — because the spec is what the client connects with; it travels to
 * exactly one device, the one the entry names, over the same authenticated
 * stream everything else rides.
 */
export interface DeviceMcpSpec {
  /** stdio: the command spawned on the hosting machine. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: the URL opened FROM the hosting machine's own network. */
  url?: string;
  headers?: Record<string, string>;
}

/** One server a device is asked to host, and the hash it is approved against. */
export interface DeviceMcpAssignment {
  name: string;
  spec: DeviceMcpSpec;
  /**
   * The whole spec, hashed (src/shared/mcp-fingerprint.ts). Approval is per
   * fingerprint rather than per name, which is what makes editing an already
   * approved entry's `args` or `env` a new approval rather than a silent
   * widening (docs/mcp-device-pinning.md, ④).
   */
  fingerprint: string;
  /**
   * Switched off centrally. Sent rather than withheld, because "not yours any
   * more" and "yours, but off" are different facts and only the first should
   * cost this machine its approval: turning a server off and on again must not
   * ask you to approve a spec you already approved (the entry keeps its config
   * AND its approval — see setMcpServerEnabled). Nothing disabled ever starts
   * here; a host that receives one stops it and says so.
   */
  disabled?: boolean;
  /**
   * Names of `env`/`headers` values that are IN mcp.json and could not be
   * decrypted there — an import with the wrong passphrase, a rotated key. The
   * values are gone from the spec, so its fingerprint moved and the hosting
   * machine will ask for approval again; without this the card would say the
   * spec "changed", which is true and misleading. Nobody edited it, and
   * approving it starts a server missing a credential.
   *
   * Names only, and never the values: this is the same rule McpHostSpecPreview
   * follows, for the same reason.
   */
  lostSecrets?: string[];
}

/** One tool's real input schema, as the machine hosting it knows it. */
export interface DeviceMcpToolSchema {
  name: string;
  description?: string;
  /** The server's own JSON Schema, verbatim. Absent when the tool declares none. */
  inputSchema?: unknown;
  /**
   * Set when this could not be fetched from the hosting machine and was rebuilt
   * from the compact signature instead: what is missing, and why. It is rendered
   * into the schema's own `description` so the model reads it where it reads the
   * arguments, rather than somewhere it may not look.
   */
  partial?: string;
}

/** One tool on a hosted server, as the catalog block renders it. */
export interface DeviceMcpTool {
  name: string;
  description?: string;
  /** Compact argument signature; the full schema is fetched on demand. */
  signature?: string;
}

/**
 * What one hosted server looks like from the machine running it.
 *
 * `unapproved` is not a failure: the spec is sitting in that machine's Manage
 * panel waiting for someone to say yes, and saying so is what lets the assistant
 * tell the difference between a server that is broken and one nobody has agreed
 * to run yet.
 */
export interface DeviceMcpServerReport {
  name: string;
  status: 'ready' | 'failed' | 'unapproved';
  /** Why it is not ready, in the words the hosting machine used. */
  error?: string;
  /**
   * Which spec this report is about. The server already HAS the spec — it sent
   * it — so the fingerprint is enough to say which one, and a stale report from
   * before an edit is recognisable as one.
   */
  fingerprint?: string;
  tools?: DeviceMcpTool[];
}

/** A client's whole account of what it is hosting — `mcpHost:announce`. */
export interface DeviceMcpAnnouncement {
  servers: DeviceMcpServerReport[];
}

/** One device's last announcement, as the server remembers it. */
export interface DeviceMcpCatalogEntry {
  deviceId: string;
  /** ISO timestamp of the announcement, so a stale catalog can say how stale. */
  announcedAt: string;
  servers: DeviceMcpServerReport[];
}

/**
 * Every device's announced catalog, kept across disconnection on purpose: an
 * unavailable server stays listed and marked, so the assistant can say "once
 * your Mac is awake" instead of silently lacking the capability (③).
 */
export interface DeviceMcpCatalog {
  version: 1;
  devices: Record<string, DeviceMcpCatalogEntry>;
}

/** One call, addressed to the device hosting `server`. */
export interface DeviceMcpRequest {
  /**
   * Unguessable and single-use. Every server channel is also bound to ipcMain on
   * the desktop, so a renderer can call `mcpHost:result` — this id is what keeps
   * a forged answer from being able to affect anything but a request that device
   * was legitimately handed.
   */
  requestId: string;
  server: string;
  /**
   * `describe` is the on-demand half of the compact catalog: the per-turn block
   * carries names and a compact signature, and this fetches one tool's real
   * schema from the machine that handshook with it. It is a separate op rather
   * than a fatter `tools` because the whole point of the compact list is not
   * paying for schemas nobody asked for.
   */
  op: 'tools' | 'call' | 'describe';
  /** `call` and `describe` only. */
  tool?: string;
  args?: unknown;
}

/** What the hosting machine answers with — `mcpHost:result`. */
export type DeviceMcpResult =
  | { ok: true; tools?: DeviceMcpTool[]; content?: unknown; schema?: DeviceMcpToolSchema }
  | { ok: false; error: string };

// ---- Commands run on a paired computer (run_command's `device` target) ----
//
// The same rails as the pinned-MCP types above — an addressed control frame out,
// an ordinary RPC back — carrying one shell command instead of one tool call.
// The POLICY (allowlist / judge / approval card) runs on the server before any
// of this is sent; the machine at the far end holds the one decision the server
// must never make for it: whether it accepts commands at all, a client-local
// switch that is off until its owner turns it on there.

/**
 * The addressed control frame that carries one command to the device that will
 * run it. Addressed like MCP_REQUEST_FRAME and for the same reasons: one
 * device's streams only, never the replay ring.
 */
export const EXEC_REQUEST_FRAME = 'exec-request';

/** One command, addressed to the device that will run it. */
export interface DeviceExecRequest {
  /** Unguessable and single-use — same defence as {@link DeviceMcpRequest.requestId}. */
  requestId: string;
  /** The chat the command belongs to; the device keys its scratch folder off it. */
  threadId: string;
  command: string;
  /**
   * Optional working directory ON THE TARGET machine. Absolute paths only —
   * the default (absent) is the target's own per-chat scratch folder, and a
   * relative path would resolve against a folder the server cannot see.
   */
  cwd?: string;
  /** Already clamped by the server to the same [1s, 300s] the local path uses. */
  timeoutMs: number;
}

/**
 * What the device answers with — `execHost:result`. `text` carries the same
 * exit-code/stdout/stderr block the local executor produces, built on the
 * device, so the model reads one format wherever a command ran.
 */
export type DeviceExecResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * A device's account of whether it runs commands — `execHost:announce`, sent on
 * connect and whenever the switch is flipped. `platform` travels with it because
 * the server's policy (tier-1 grammar, the judge's shell name) is decided
 * against the platform of the machine that will run the command, and the device
 * is the authority on what it is.
 */
export interface DeviceExecAnnouncement {
  enabled: boolean;
  platform: 'darwin' | 'linux' | 'win32';
}

/** One device's last exec announcement, as the server remembers it. */
export interface DeviceExecHostEntry extends DeviceExecAnnouncement {
  deviceId: string;
  announcedAt: string;
}

/**
 * The exec host's account of THIS machine — the answer to `execHost:localState`,
 * a client-owned channel that never goes on the wire (same rule as
 * McpHostLocalState below).
 */
export interface ExecHostLocalState {
  enabled: boolean;
}

// ---- What the MCP host on THIS machine has to say about itself ----
//
// The types below never go on the wire. They are the answer to
// `mcpHost:localState`, a client-owned channel, because approval is a fact about
// one computer: the panel in a window on your Mac is asking your Mac, and a
// server pinned to some other device has nothing to answer with. That is also
// what makes the panel work against a server whose client half is a phone or an
// older build — the question was never sent anywhere.

/**
 * What approving a spec would run, with the credential VALUES left out.
 *
 * The spec itself carries decrypted API keys and bearer headers; it stops in the
 * main process, where the thing that spawns lives. A card needs to show what
 * gets executed, not what it gets executed with, so the names of the variables
 * travel and their values do not — enough to notice `AWS_SECRET_ACCESS_KEY`
 * appearing in something you thought only read your notes.
 */
export interface McpHostSpecPreview {
  command?: string;
  args?: string[];
  url?: string;
  /** Names only. */
  envKeys?: string[];
  /** Names only. */
  headerKeys?: string[];
}

/** One spec pinned to this machine that nobody here has said yes to yet. */
export interface McpHostPendingServer {
  name: string;
  /** The fingerprint being approved; the approval is sent back with it. */
  fingerprint: string;
  preview: McpHostSpecPreview;
  /**
   * True when this machine had approved a DIFFERENT spec under this name. The
   * card says "changed" rather than "new", because the two are answered
   * differently by somebody who knows they did not edit it.
   */
  changed: boolean;
  /**
   * Set when the spec looks like it can run anything, rather than exposing a
   * bounded set of tools. ⑤ removed per-call confirmation on the argument that
   * an MCP server's surface is fixed at approval time — for a shell-like server
   * that argument does not hold, and the card has to say so out loud.
   */
  unbounded?: string;
  /**
   * Names of credentials this spec carries whose values could not be read on the
   * machine holding mcp.json. See DeviceMcpAssignment.lostSecrets — the card says
   * a value was LOST rather than changed, because the two are answered
   * differently and only one of them is somebody's own edit.
   */
  lostSecrets?: string[];
}

/** How one server pinned to this machine is doing, right now, here. */
export interface McpHostServerStatus {
  status: 'starting' | 'ready' | 'failed' | 'unapproved' | 'disabled';
  /** Why it is not ready, in the words the failure used. */
  error?: string;
  /** How many tools it exposed, once it has connected. */
  tools?: number;
}

/** Everything the panel needs about the MCP servers hosted on this computer. */
export interface McpHostLocalState {
  /** server name → the fingerprint this machine approved. */
  approved: Record<string, string>;
  pending: McpHostPendingServer[];
  status: Record<string, McpHostServerStatus>;
  /**
   * Set when the server this client is talking to is older than this build and
   * does not answer the host channels at all. Everything else here is then
   * empty — not because nothing is pinned here, but because there was nobody to
   * ask — and an empty panel that says nothing is the one answer a person cannot
   * act on.
   */
  unsupported?: string;
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

/**
 * The assistant proposed a change to the user's custom instructions (via the
 * `set_custom_instructions` tool). Surfaced as a confirm card where the user edits
 * the resulting text and picks the target surface before it's applied. `id` is the
 * bridge's elicitation id — pass it back to apply/cancel.
 */
export interface InstructionsProposal {
  id: number | string;
  threadId: string;
  /** What the assistant asked for; the card computes the resulting text from it. */
  action: 'append' | 'replace' | 'clear';
  /** The text the assistant wants to append/replace with ('' for clear). */
  incomingText: string;
  /** The surface the assistant hinted at; the card defaults to it but the user decides. */
  suggestedSurface?: 'main' | 'quickChat';
}

/**
 * The assistant wants to save a procedure as a skill and the mode is `ask`, so the
 * write waits on a card. `id` is the bridge's elicitation id — pass it back to
 * apply or cancel.
 *
 * The card shows the whole file because that is the point: a skill is followed on
 * later turns, so an unreviewed one is a standing instruction nobody read. The
 * user can edit the text before accepting.
 */
export interface SkillProposal {
  id: number | string;
  threadId: string;
  /** Slug and heading of the proposed skill; also the folder name. */
  name: string;
  description: string;
  /** The full body, front-matter excluded. */
  body: string;
  /** True when this would overwrite an existing skill rather than add one. */
  isPatch: boolean;
  /** Which surface asked: a live tool call, the end-of-turn pass, or `/learn`. */
  origin: 'assistant' | 'turn' | 'learn';
}

/** Outcome of `/learn`. `message` is written to be shown to the user verbatim. */
export type SkillLearnResult =
  | { ok: true; slug: string; saved: boolean; message: string }
  | { ok: false; message: string };

/** State of the one-time migration off the pre-rebuild skill library. */
export interface SkillsResetStatus {
  needed: boolean;
  count: number;
}

/** What the migration did. `exportFolder` is a subfolder name under Files. */
export interface SkillsResetResult {
  exported: number;
  exportFolder: string;
  removed: number;
}

/**
 * What one curator pass did, alongside the fresh listing. The counts travel with
 * the list because a merge and a no-op leave the panel looking the same from the
 * outside — the list just quietly changes — and the caller cannot tell them apart
 * by diffing it.
 */
export interface SkillsCurateResult {
  skills: SkillSummary[];
  merged: number;
  archived: number;
  /**
   * Skills the deterministic lifecycle clock retired on this run (server/skills/
   * lifecycle.ts) — reported separately from `archived` because it is not the
   * curator's doing: no model saw them, they simply went untouched past the cutoff.
   */
  expired: number;
}

/** Main -> renderer: a pending approval was answered or expired. */
export interface ApprovalResolvedPayload {
  id: string;
}

// ---- Command execution (the `run_command` tool) ----

/**
 * A command that fell through the exec policy's auto-approve tiers (static
 * allowlist → LLM judge) and needs the user's decision. Surfaced as an approval
 * card; `id` is minted by the ExecService — pass it back to resolve.
 */
export interface ExecApprovalRequest {
  id: string;
  threadId: string;
  /** The full shell command awaiting approval. */
  command: string;
  /** The resolved working directory it would run in. */
  cwd: string;
  /**
   * What "Always allow" would persist to the user allowlist: the learnable prefix
   * of every chained segment not already allowlisted. Empty = nothing learnable
   * (the command has shell semantics tier 1 can never match), so the card offers
   * no "Always allow" button.
   */
  prefixes: string[];
  /**
   * The LLM judge's verdict that caused the escalation.
   * null = judge skipped (manual mode); 'failed' = complete() threw before a verdict.
   */
  judgeVerdict: 'unsafe' | 'unsure' | 'failed' | null;
  /**
   * The judge's short reason, or — when the check failed — why it could not run,
   * in the same lowercase-fragment shape. The underlying error goes to the log.
   */
  judgeReason?: string;
  /**
   * Set when the command targets a paired computer instead of the machine Stem
   * runs on. The card must say so — approving a command is approving WHERE it
   * runs as much as what runs — and "Always allow" learns into that device's own
   * allowlist rather than the shared one.
   */
  deviceId?: string;
  /** The device's label at the moment the card was raised, for the card text. */
  deviceLabel?: string;
}

/** The user's answer to an exec approval card. */
export type ExecDecision = 'allowOnce' | 'alwaysAllow' | 'deny';

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
  /** Maximum non-pinned durable facts selected for one turn. */
  maxRelevantFacts: number;
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
  category?: FactCategory;
  sensitivity?: FactSensitivity;
  confidence?: number;
  status?: FactStatus;
  pinned?: boolean;
  validUntil?: number | null;
  evidenceCount?: number;
  /** Notes only: turns this fact was injected into / visibly used by the reply. */
  timesInjected?: number;
  timesUsed?: number;
  lastUsedAt?: number | null;
}

/** One thread's rolling episodic summary (Level 1.5), shown in Memory → Recall. */
export interface ThreadSummary {
  id: number;
  threadId: string;
  text: string;
  firstTs: number;
  lastTs: number;
  messageCount: number;
  updatedAt: number;
}

export interface MemoryContents {
  files: MemoryFile[];
  /** True when no file has any non-whitespace content. */
  isEmpty: boolean;
}

/** Which selection path chose a turn's durable facts (see chooseFacts in recall/inject). */
export type FactTier =
  | 'reranked'
  | 'hybrid'
  | 'embedding'
  | 'lexical'
  | 'pinned-only'
  | 'none'
  // Recall v1 values remain readable on previously recorded active turns.
  | 'all'
  | 'recency';

export type FactCategory =
  | 'identity'
  | 'preference'
  | 'relationship'
  | 'work'
  | 'project'
  | 'health'
  | 'finance'
  | 'location'
  | 'schedule'
  | 'other';
export type FactSensitivity = 'standard' | 'sensitive';
export type FactStatus = 'active' | 'conflicted' | 'superseded';
export type FactSelectionReason = 'pinned' | 'semantic' | 'lexical';

export interface FactEvidence {
  id: number;
  messageId: number | null;
  threadId: string | null;
  role: 'user' | 'assistant' | null;
  timestamp: number;
  excerpt: string;
  /** 'folder_doc' = an indexed connected-folder file (folderId/relPath set).
   *  'assistant_claim_web' = an assistant message from a turn that used web tools,
   *  i.e. the excerpt may restate untrusted public-web content. */
  origin: 'explicit_user' | 'user_message' | 'assistant_claim' | 'assistant_claim_web' | 'legacy' | 'folder_doc' | 'segment_context';
  /** Connected-folder id, for 'folder_doc' evidence. */
  folderId?: string | null;
  /** Folder-relative file path, for 'folder_doc' evidence. */
  relPath?: string | null;
}

export interface FactDetails {
  id: number;
  text: string;
  source: string;
  category: FactCategory;
  sensitivity: FactSensitivity;
  confidence: number;
  status: FactStatus;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  validFrom: number | null;
  validUntil: number | null;
  supersededBy: number | null;
  /** How many turns this fact was injected into (graded turns only). */
  timesInjected: number;
  /** How many of those turns the reply visibly drew on it. */
  timesUsed: number;
  lastUsedAt: number | null;
  /** Last time an injection of this fact was graded (used or not). */
  lastGradedAt: number | null;
  evidence: FactEvidence[];
}

export interface MemoryConflict {
  id: number;
  factA: FactDetails;
  factB: FactDetails;
  reason: string;
  createdAt: number;
}

/** Resolutions the user can pick in the Conflicts card. */
export type ManualConflictResolution = 'keep_newer' | 'keep_older' | 'keep_both';
/** Resolutions the background adjudicator records (never user-selectable). */
export type AutoConflictResolution = 'auto_supersede' | 'auto_keep_both' | 'auto_rewrite';
export type ConflictResolution = ManualConflictResolution | AutoConflictResolution;

/** A conflict the background adjudicator resolved, for the audit list in the Facts tab. */
export interface AutoResolvedConflict {
  id: number;
  factA: FactDetails;
  factB: FactDetails;
  reason: string;
  resolution: AutoConflictResolution;
  resolvedAt: number;
}

export interface MemoryRebuildStatus {
  state: 'available' | 'running' | 'paused' | 'complete' | 'failed';
  processedMessages: number;
  totalMessages: number;
  cursorMessageId: number;
  cursorOffset: number;
  lastError?: string;
}

/**
 * Every background pass that the toolbar activity indicator can report. One id
 * per logical job, not per call site: the folder passes run once per connected
 * folder but share a kind (the folder's label lands in `detail`).
 */
export type ActivityKind =
  | 'memory.distill'
  | 'memory.summaries'
  | 'memory.relationCheck'
  | 'memory.relationSweepBackfill'
  | 'memory.adjudicate'
  | 'memory.consolidate'
  | 'memory.episodicEmbed'
  | 'memory.factEmbed'
  | 'memory.summaryEmbed'
  | 'memory.summaryBackfill'
  | 'memory.rebuild'
  | 'skills.curate'
  | 'folders.scan'
  | 'folders.embed'
  | 'folders.learn'
  | 'chatIndex.backfill'
  | 'models.embed'
  | 'models.rerank'
  | 'tasks.run';

/**
 * One background run — in flight, or finished and kept in the history buffer.
 * `activeMs` accumulates only time actually spent working: the stepped passes
 * (rebuild, folder learn, model download) yield to interactive work and resume
 * minutes later, so wall-clock start→finish would read as hours of "work".
 */
export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  /** Imperative while running ("Distilling facts"); the UI past-tenses history rows. */
  label: string;
  /** What the run actually did ("Learned 3 facts") or which folder it was for. */
  detail?: string;
  startedAt: number;
  activeMs: number;
  state: 'running' | 'done' | 'failed';
  /** Stepped passes only — oneshot runs are too short for a bar to mean anything. */
  progress?: { done: number; total: number };
  error?: string;
}

/** Everything the activity popover renders, pushed on `activity:changed`. */
export interface ActivitySnapshot {
  running: ActivityEntry[];
  /** Newest first, capped at ACTIVITY_HISTORY_LIMIT. Runs that did nothing are omitted. */
  history: ActivityEntry[];
  /** A run has failed since the user last opened the panel — drives the sticky dot. */
  unseenFailure: boolean;
}

/** The durable facts injected on a turn (last turn or a draft preview), plus their tier. */
export interface ActiveFacts {
  facts: Array<{
    id: number;
    text: string;
    source: string;
    sensitivity?: FactSensitivity;
    reason?: FactSelectionReason;
    /** Injected as the representative of an open conflict (see Fact.disputed). */
    disputed?: boolean;
  }>;
  tier: FactTier;
}

/** Outcome of saving a composer quick note (`/note` / `//`) as a durable fact. */
export interface MemoryNoteResult {
  saved: boolean;
  factId?: number;
  /** Why the note was not saved. */
  reason?: 'empty' | 'disabled' | 'secret';
}

/** Outcome of a manual consolidation pass, plus the refreshed memory list. */
export interface MemoryConsolidateResult {
  merged: number;
  corrected: number;
  dropped: number;
  /** Chunks whose model call failed — those facts were never reviewed this pass. */
  failedChunks: number;
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
  /**
   * A short subject written by a model from the thread's conversation, when
   * Settings → Chat → Chats has subjects on. The Inbox shows this in place of `title`.
   * At the `everywhere` setting the thread was also renamed to it, so the two
   * agree; at `inbox` they deliberately differ. Absent = never written.
   */
  subject?: string;
  /**
   * First ~200 characters of the latest message in the thread, whoever wrote it —
   * the two-line preview under an Inbox row. Read off the session file's tail
   * during the same mtime-cached scan that produces the title, so it costs
   * nothing extra; absent for optimistic rows that have no file yet.
   */
  preview?: string;
  folderId: string | null;
  /** Unix seconds. */
  createdAt: number;
  updatedAt: number;
}

/** One chat matched by the sidebar search, with a snippet of why it matched. */
export interface ChatSearchHit {
  threadId: string;
  title: string;
  /** FTS5 snippet of the best-matching message; «…» wrap the matched terms. */
  snippet: string;
  /** bm25 score of the best-matching doc (lower = better). */
  score: number;
  /** Unix seconds of the matched message (0 for a title-only match). */
  ts: number;
}

/** Full chat contents for replay when a chat is opened. */
export interface ChatHistory {
  threadId: string;
  title: string;
  messages: ChatMessage[];
  /**
   * This came out of the client's own read-only cache because the server could
   * not be reached — see src/desktop/offline-cache.ts. Never set by the server,
   * and never set while it is answering.
   */
  offline?: boolean;
}

/**
 * One turn the server still has in flight, as reported to a client the moment
 * its event stream opens.
 *
 * `turnId` is what makes this useful rather than decorative: it is the id Stop
 * interrupts, and a thread marked as running without one would show a button
 * that cannot do anything. Null only for a turn whose first event predates the
 * server learning to record it, which is a restart away from impossible.
 */
export interface LiveTurn {
  threadId: string;
  turnId: string | null;
}

/** The complete sidebar payload: chats + the folder tree, fetched together. */
export interface ChatListResult {
  chats: ChatSummary[];
  folders: Folder[];
  /**
   * Per-thread read/archive/snooze state for the Inbox mode. Carried alongside the
   * chats rather than stamped onto each ChatSummary because a summary is also
   * produced by the backend runtime and by the renderer's optimistic rows, neither
   * of which knows anything about the Inbox. See src/shared/inbox.ts.
   */
  inbox: InboxState;
  /** Served from the client's offline cache; see {@link ChatHistory.offline}. */
  offline?: boolean;
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
 * Whether the configured summon key is actually live, reported by main because the
 * renderer cannot see an OS-level grab. `registered` false means the OS refused the
 * accelerator (another app holds it). `wayland` true means the grab is meaningless
 * even when it succeeds — the compositor never routes the key to Stem — and
 * `summonCommand` is what to bind as a system shortcut there instead.
 */
export interface QuickChatShortcutStatus {
  accelerator: string | null;
  registered: boolean;
  wayland: boolean;
  summonCommand: string;
}

/**
 * The Quick Chat settings that describe a MACHINE rather than Stem.
 *
 * A hotkey is a grab on somebody's keyboard and the two visibility flags are
 * about where a window sits among that machine's Spaces and displays — none of
 * them mean anything on a server, and a second paired Mac must be free to
 * disagree about all three. So they are stored on the client and merged into
 * {@link AppSettings} on the way to the renderer (src/desktop/settings.ts).
 */
export type ClientQuickChatSettings = Pick<
  QuickChatSettings,
  'shortcut' | 'showOnAllDisplays' | 'followAcrossSpaces'
>;

/**
 * Web search, toggled independently per context and available on EVERY provider.
 *
 * Search used to be an openai-codex-only trick (Stem injected the provider's own
 * server-side tool into the outgoing request), so the toggle hid itself for every
 * other model. It is now served by the vendored pi-web-access extension, which
 * registers ordinary pi tools and therefore works identically on Claude,
 * OpenRouter, Ollama and LM Studio — so the toggle is always shown, and the
 * backend enables the tools per turn based on the originating context.
 */
export interface WebSearchSettings {
  /** Main window turns. */
  main: boolean;
  /** Quick Chat overlay turns. */
  quickChat: boolean;
  /**
   * Search backend, INDEPENDENT of the model being chatted with — an Ollama chat
   * can search through Exa, a ChatGPT chat through SearXNG. `auto` walks
   * pi-web-access's fallback chain, which ends at keyless Exa MCP so search works
   * with no configuration at all; `all` fans out across every configured backend.
   * Otherwise one of the ids in SEARCH_BACKENDS (server/pi/web-search.ts).
   */
  provider: string;
  /**
   * Credentials and endpoints, keyed by the exact field name pi-web-access reads
   * (`exaApiKey`, `searxngBaseUrl`, `openaiResponsesUrl`, …). Held as one map so
   * every backend's key can be stored at once and switching backends never means
   * re-entering one. Blank entries are simply not written to its config.
   */
  credentials: Record<string, string>;
}

/** Model used for Stem Recall's hidden memory turns (distillation + tidy-up). */
/**
 * What reads your conversations and decides what is worth remembering.
 *
 * Memory sits outside the Quick tasks deal on purpose (as does skills). The
 * quick-tasks roles are the ones you can safely make cheap; this one works
 * against a whole transcript plus everything already remembered, and a model too
 * small to hold that doesn't fail — it replies with truncated nonsense and
 * memory quietly stops learning. So an unset memory model follows the model you
 * chat with, not the quick-tasks one: the shared cheap-model setting cannot
 * silently take this role with it.
 */
export interface MemoryModelSettings {
  /** `provider/model` id; null = the model you chat with. */
  model: string | null;
  /** Reasoning effort; null = leave the model on its own default. */
  effort: string | null;
}

/**
 * How Stem saves skills of its own accord:
 * - `off`  — never. It may still SUGGEST one in its reply, and if you say yes it
 *            saves it; the mode limits Stem's initiative, not your instructions.
 * - `ask`  — it proposes, you approve in a card. The default.
 * - `auto` — it saves silently and tells you in the Manage panel.
 *
 * None of the three affects a skill the user asks for outright ("save that as a
 * skill"), which always writes once it passes the contract. That request is the
 * highest-precision authoring signal there is, and refusing it in `off` would
 * contradict the mode's own label.
 */
export type SkillsMode = 'off' | 'ask' | 'auto';

/**
 * How much of a thread's name Stem writes for you:
 * - `off`        — never call a model; a thread is named after the first line you typed.
 * - `inbox`      — write a subject and show it in the Inbox, but leave thread names alone.
 * - `everywhere` — the written subject IS the thread's name, so the Inbox, the
 *                  Chats tree, search and the window title all agree. The default.
 *
 * In both writing modes the subject is written once the thread's first reply has
 * landed and then re-checked on a widening schedule (turns 3, 8, 20, 50…), so a
 * thread that drifts onto another subject stops carrying the name of the one it
 * opened with. A re-check keeps the standing name unless the thread has clearly
 * moved on.
 *
 * A name you typed yourself is never overwritten in any mode.
 */
export type ChatSubjectMode = 'off' | 'inbox' | 'everywhere';

/** The Chats panel: how threads get named, and how much of each one the Inbox shows. */
export interface ChatsSettings {
  subjects: ChatSubjectMode;
  /** `provider/model` id for the subject writer; null = the backend default. */
  subjectModel: string | null;
  /** Reasoning effort for the subject writer; null = {@link DefaultsSettings.backgroundEffort}. */
  subjectEffort: string | null;
  /** Lines of the latest message under each Inbox row: 0 (none), 1 or 2. */
  previewLines: 0 | 1 | 2;
}

/**
 * How much a scheduled run is allowed to interrupt you when it calls `notify_user`:
 * - `alert` — raise and focus the main window, nudge at the OS level, and show the
 *             alert modal. The default: what watch-style tasks were built for.
 * - `nudge` — no window raise, no modal; just the OS-level nudge (dock bounce /
 *             taskbar flash) over the unread row the run leaves in the Inbox.
 * - `inbox` — nothing interrupts. The run's chat simply goes bold in the Inbox,
 *             the way any other new message would.
 *
 * The run counts as having found something in all three: the notify is what keeps
 * its turn out of {@link noteSilentRun}, so the chat lifts out of the archive and
 * the row goes unread whatever the user chose here. Only the interruption differs.
 */
export type TaskNotifyMode = 'alert' | 'nudge' | 'inbox';

/** Scheduled tasks: how a run that has something to say reaches you. */
export interface TasksSettings {
  notify: TaskNotifyMode;
}

/** Skills: the automatic-authoring policy plus the model that does the writing. */
export interface SkillsSettings {
  /**
   * `provider/model` id for all skills work — authoring (the end-of-turn pass,
   * `/learn`) and curation. null = the model you chat with, like memory:
   * writing skills is judgment work, so it deliberately does NOT follow the
   * shared quick-tasks model.
   */
  model: string | null;
  /** Reasoning effort for skills work; null = the model's own default. */
  effort: string | null;
  mode: SkillsMode;
}

/**
 * How run_command approvals work:
 * - `manual`   — no LLM judge; anything not allowlisted pauses for the user.
 * - `assisted` — the tiered default: allowlist → LLM safety judge → approval card.
 * - `yolo`     — everything runs immediately (the protected-roots guard still applies).
 */
export type ExecApprovalMode = 'manual' | 'assisted' | 'yolo';

/**
 * Command execution (the `run_command` tool): a tiered auto-approve policy.
 * A static safe allowlist and the user's learned prefixes run immediately; other
 * commands are classified by an LLM judge, and only judge-flagged ones fall back
 * to a manual approval card. The judge is a heuristic, not a security boundary.
 */
export interface ExecSettings {
  /** Master switch for the run_command tool. */
  enabled: boolean;
  /** Approval policy: manual / LLM-assisted (default) / yolo. */
  approvalMode: ExecApprovalMode;
  /** `provider/model` id for the safety judge; null = {@link DefaultsSettings.backgroundModel}. */
  judgeModel: string | null;
  /** Reasoning effort for the safety judge; null = {@link DefaultsSettings.backgroundEffort}. */
  judgeEffort: string | null;
  /** User-approved command prefixes (e.g. "git push", "npm") that auto-run as tier 1. */
  allowlist: string[];
  /**
   * Learned prefixes per TARGET device, for commands that run on a paired
   * computer (`run_command`'s `device`). Kept apart from `allowlist` on purpose:
   * trust in a prefix is granted per machine, and a remote target gets no static
   * built-ins either — its tier 1 is exactly its own entries here, which start
   * empty. Keyed by device id; entries for unpaired devices are inert (the
   * device can no longer be targeted) and are cleaned up when edited.
   */
  deviceAllowlists: Record<string, string[]>;
  /**
   * Days a chat's scratch folder survives without being touched before the sweep
   * removes it; null = never. Idle counts from the NEWER of the folder's newest
   * file and the chat's last message. See server/exec/scratch.ts.
   */
  scratchTtlDays: number | null;
}

/** One chat's scratch folder in Settings → Chat → Command execution → Scratch files. */
export interface ScratchUsageRow {
  /** The thread id, or "unfiled" for the aggregate of everything not owned by a chat. */
  key: string;
  /** The chat's title; absent when no chat matches (an orphan, or the unfiled pile). */
  title?: string;
  bytes: number;
  files: number;
}

/**
 * The user's standing custom instructions (response-style directives, format/tone
 * rules, etc.) — an authoritative channel injected into every user-facing turn,
 * distinct from recalled facts. Quick Chat INHERITS Main and appends its own extra:
 * a Main turn injects `main`; a Quick Chat turn injects `main` + `quickChat`.
 */
export interface CustomInstructionsSettings {
  /** Applies to every surface (main window AND Quick Chat). */
  main: string;
  /** Quick-Chat-only extra, appended on top of `main` for overlay turns. */
  quickChat: string;
}

/**
 * How fact embeddings are produced:
 * - `off`    — no embeddings; fact selection stays lexical/recency-based.
 * - `local`  — bundled in-process model (transformers.js/ONNX in a utility
 *              process); weights download once to userData, nothing leaves the
 *              machine. The out-of-box default.
 * - `remote` — the user's own OpenAI-compatible HTTP endpoint (Ollama, LM
 *              Studio, vLLM, hosted).
 */
export type EmbeddingsMode = 'off' | 'local' | 'remote';

/** Curated local embedding models (specs live in server/recall/embed-catalog.ts). */
export type LocalEmbedModelId = 'multilingual-e5-small' | 'multilingual-e5-base' | 'embeddinggemma-300m';

/**
 * Embeddings-stage settings: an exclusive mode plus the config for both backends
 * (kept side-by-side so switching modes never loses the remote endpoint details).
 */
export interface EmbeddingsSettings {
  mode: EmbeddingsMode;
  /** Which curated local model to run when mode === 'local'. */
  localModel: LocalEmbedModelId;
  /** Remote endpoint (used when mode === 'remote'): any OpenAI-compatible /v1/embeddings server. */
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

/** Live state of the local embedding worker/model — drives the Manage-panel status line. */
export interface LocalEmbedStatus {
  model: LocalEmbedModelId;
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  /** Download progress 0–100 while state === 'downloading'. */
  progressPct?: number;
  /** Vector dimension once ready. */
  dim?: number;
  /** Human-readable failure while state === 'error'. */
  error?: string;
  /**
   * The load failed on unparseable cached weights (truncated download) and the
   * worker purged that model's cache. Signals the manager to restart the worker
   * and re-download — the retry must be a NEW process, because a failed ONNX
   * session load poisons transformers.js state for every later load in it.
   */
  purgedCorruptCache?: boolean;
}

/**
 * How the precision rerank stage runs (same shape as {@link EmbeddingsMode}):
 * - `off`    — no reranking; fact selection is embeddings-cosine only.
 * - `local`  — bundled cross-encoder (transformers.js/ONNX in the same utility
 *              process as local embeddings); weights download once to userData.
 * - `remote` — the user's own Cohere/Jina-style /rerank endpoint (llama.cpp
 *              --reranking, vLLM, Infinity, TEI).
 */
export type RerankerMode = 'off' | 'local' | 'remote';

/** Curated local reranker models (specs live in server/recall/rerank-catalog.ts). */
export type LocalRerankModelId = 'bge-reranker-v2-m3' | 'qwen3-reranker-0.6b';

/**
 * Reranker-stage settings: an exclusive mode plus the config for both backends
 * (kept side-by-side so switching modes never loses the remote endpoint details).
 */
export interface RerankerSettings {
  mode: RerankerMode;
  /** Which curated local model to run when mode === 'local'. */
  localModel: LocalRerankModelId;
  /** Remote-endpoint fields (used when mode === 'remote'). */
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

/** Live state of the local reranker model — drives the Manage-panel status line. */
export interface LocalRerankStatus {
  model: LocalRerankModelId;
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  /** Download progress 0–100 while state === 'downloading'. */
  progressPct?: number;
  /** Human-readable failure while state === 'error'. */
  error?: string;
  /** See LocalEmbedStatus.purgedCorruptCache. */
  purgedCorruptCache?: boolean;
}

/**
 * Last known verdict on a user-configured remote retrieval endpoint (mode ===
 * 'remote'), per stage. Unlike the local statuses there is no lifecycle to
 * stream — just the outcome of the most recent real request: 'unknown' until
 * one has been made (or after a settings change wipes a stale verdict), then
 * 'ok'/'error'. An 'error' here means recall is silently degrading on every
 * pass, which is why it feeds the same red markers the local statuses do.
 */
export interface RemoteEndpointHealth {
  state: 'unknown' | 'ok' | 'error';
  /** Human-readable failure while state === 'error'. */
  error?: string;
}

/** Both stages' remote-endpoint verdicts, as pushed on 'retrieval:remoteHealth'. */
export interface RemoteRetrievalHealth {
  embeddings: RemoteEndpointHealth;
  reranker: RemoteEndpointHealth;
}

/**
 * Reusable two-stage retrieval config: embeddings (candidate ranking) + reranker
 * (precision reorder). Used today to rank durable facts at inject time; the same
 * seam can back episodic semantic search later.
 */
export interface RetrievalSettings {
  embeddings: EmbeddingsSettings;
  reranker: RerankerSettings;
}

/** A partial retrieval patch — update either stage, any subset of its fields. */
export interface PartialRetrievalSettings {
  embeddings?: Partial<EmbeddingsSettings>;
  reranker?: Partial<RerankerSettings>;
}

export type RetrievalStage = 'embeddings' | 'reranker';

/** Result of a live probe against a retrieval endpoint (the Settings "Test" button). */
export interface RetrievalTestResult {
  ok: boolean;
  /** Human-readable detail: dims/latency on success, or the error (e.g. ECONNREFUSED). */
  detail: string;
}

/**
 * What the Escape key does in the main composer while a turn is running:
 * - `off`      — nothing (default; legacy behavior).
 * - `single`   — one Escape stops the turn AND retracts the just-sent message
 *                (text + attachments) back into the composer, dropping it from
 *                the chat and pi's session, as if it was never sent.
 * - `twoStage` — first Escape stops the turn (message stays, like ⌘.); a second
 *                Escape then retracts it. Armed only until the user acts.
 */
export type EscapeAction = 'off' | 'single' | 'twoStage';

/** First-run state: whether the user has been through (or past) the welcome wizard. */
export interface OnboardingSettings {
  completed: boolean;
}

/**
 * "What's new" popup state.
 *
 * `lastSeenVersion` is the newest release the user has already been shown (null
 * = nothing recorded yet, which for an already-onboarded install means "show
 * only the version they're running"). It keeps advancing even while
 * `showOnUpdate` is off, so turning the popup back on doesn't dump a backlog.
 */
export interface ReleaseNotesSettings {
  showOnUpdate: boolean;
  lastSeenVersion: string | null;
}

/** One `## <version> — <date>` section of RELEASE_NOTES.md. */
export interface ReleaseNoteEntry {
  /** Dotted numeric version, e.g. "0.3.0". */
  version: string;
  /** Whatever followed the dash in the heading ("2026-07-29", "Unreleased"), or ''. */
  label: string;
  /** The section's Markdown body, heading excluded. */
  body: string;
}

/**
 * What the renderer needs to decide whether to raise the "what's new" popup.
 * `entries` is already clamped to versions at or below `appVersion`, so notes
 * written ahead of a release never leak into a build that predates them.
 */
export interface ReleaseNotesSnapshot {
  appVersion: string;
  entries: ReleaseNoteEntry[];
  /** Versions of the entries the user hasn't been shown yet, newest first. */
  unseen: string[];
}

/** Whether this machine looks for new Stem releases on its own. */
export interface UpdatesSettings {
  checkAutomatically: boolean;
}

/**
 * How a new release reaches this install.
 *
 * `auto` — the AppImage: Stem downloads the new build itself and swaps it in on
 * restart. `manual` — the mac and deb builds, which can only be told: Stem
 * points at the release page and the user installs the way they installed the
 * first time. `none` — a dev run or a test, where there is nothing to update.
 */
export type UpdateMode = 'auto' | 'manual' | 'none';

/**
 * Where the updater stands, pushed on every change and askable on mount. One
 * shape for both modes; `state: 'ready'` only ever happens under `auto`.
 */
export interface UpdateStatus {
  /** The version running here — the thing every comparison is against. */
  appVersion: string;
  mode: UpdateMode;
  /** `idle` covers both "never checked" and "checked, nothing newer". */
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  /** The newer version, once one is known. Null while current or unchecked. */
  available: string | null;
  /** The release page for `available` — where a `manual` install goes to get it. */
  downloadUrl: string | null;
  /** When the last check finished, ms epoch; null before the first. */
  checkedAt: number | null;
  /** What went wrong, in words a person can act on. Only under `state: 'error'`. */
  error: string | null;
}

/**
 * App-level backend defaults. `model` is 'provider/modelId' (same shape as
 * ModelSummary.id); null = the built-in constant. Set after onboarding so the
 * default matches the provider the user actually signed in with.
 */
export interface DefaultsSettings {
  /**
   * The model you chat with — written whenever you change it, so the background
   * jobs can see what you actually use. Null only before the first sign-in has
   * picked one.
   */
  model: string | null;
  /**
   * What the quick-tasks roles (chat subjects and the command safety check) run
   * on when they aren't pinned to a model of their own. Null = the same model
   * you chat with, which is the honest default: Stem has no price or size data
   * to guess a cheaper one from, so it says what it is doing rather than picking
   * for you.
   *
   * Memory and skills are deliberately NOT on this list — both are judgment
   * work; see {@link MemoryModelSettings} and {@link SkillsSettings}.
   */
  backgroundModel: string | null;
  /**
   * How hard those same roles are allowed to think. Null = leave the model on
   * its own default, which is what every background job did before this setting
   * existed — nobody chose it, pi did.
   */
  backgroundEffort: string | null;
}

export interface AppSettings {
  quickChat: QuickChatSettings;
  webSearch: WebSearchSettings;
  memory: MemoryModelSettings;
  skills: SkillsSettings;
  /** The Chats panel: subject writing (mode + model) and Inbox preview lines. */
  chats: ChatsSettings;
  /** Scheduled tasks: how prominently a run's notify_user is allowed to interrupt. */
  tasks: TasksSettings;
  /** Command execution (run_command) policy: enable switch, judge model, learned allowlist. */
  exec: ExecSettings;
  retrieval: RetrievalSettings;
  /** Escape-to-retract behavior in the main composer. */
  escapeAction: EscapeAction;
  /** Standing custom instructions, separate for Main and Quick Chat (QC inherits Main). */
  customInstructions: CustomInstructionsSettings;
  /** First-run wizard state. */
  onboarding: OnboardingSettings;
  /** "What's new" popup: whether to raise it after an update, and what's been seen. */
  releaseNotes: ReleaseNotesSettings;
  /** Whether this machine checks for new releases on its own. */
  updates: UpdatesSettings;
  /** App-level backend defaults (default model). */
  defaults: DefaultsSettings;
  /** Local model servers (Ollama, LM Studio) registered with the chat backend. */
  localProviders: LocalProvidersSettings;
}

/**
 * The half of {@link AppSettings} a SERVER keeps — which is all of it except the
 * parts that describe a machine. This is the shape of settings.json now, and the
 * shape every `settings:*` channel answers with on the wire.
 *
 * The renderer never sees it: the client merges its own half back in before the
 * document reaches a window, so `window.stem.getSettings()` still resolves to a
 * whole {@link AppSettings} and no call site knows the split happened.
 */
export interface ServerSettings extends Omit<AppSettings, 'quickChat' | 'releaseNotes' | 'updates'> {
  quickChat: Omit<QuickChatSettings, keyof ClientQuickChatSettings>;
}

/**
 * The other half: what THIS machine keeps for itself, in client.json beside its
 * device token.
 *
 * Both entries are here for the same reason. The hotkey and the overlay's
 * visibility flags act on this machine's keyboard and displays; the "what's new"
 * marker tracks the version of the app *installed here*, which two clients of one
 * server are free to differ on — a Mac still on 0.3.0 must not be told it has
 * already seen 0.4.0's notes because another one has.
 */
export interface ClientSettings {
  quickChat: ClientQuickChatSettings;
  releaseNotes: ReleaseNotesSettings;
  /**
   * Here for the reason the other two are: the version that could be updated is
   * the one installed on THIS machine, and two clients of one server are free to
   * differ on whether they want to hear about it.
   */
  updates: UpdatesSettings;
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

/** Main → overlay: capture an atomic state snapshot for an implicit handoff. */
export interface QuickChatHandoffRequest {
  id: string;
  threadId: string;
}

/** Overlay → main: hand the live conversation off to the main window. */
export interface QuickChatHandoff {
  threadId: string;
  messages: ChatMessage[];
  /** Complete live state, transferred atomically when handing off mid-turn. */
  running: boolean;
  streamingId: string | null;
  activity: string | null;
  activities: ActivityItem[];
  activeTurnId: string | null;
  status: ThreadStatus;
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

// ---- Devices: who may reach this server ----

/**
 * One registered client, as Settings → Server → Devices shows it. No credential appears
 * here and none exists to show — the server keeps only a hash of each device's
 * token (see server/transport/auth.ts).
 */
export interface DeviceInfo {
  id: string;
  label: string;
  createdAt: string;
  /** Last successful authentication, or null if it has never connected. */
  lastSeenAt: string | null;
  /**
   * What the device said it was when it paired, defaulting to `desktop` for
   * every record written before the field existed. Surfaced because only a
   * desktop may host an MCP server (docs/mcp-device-pinning.md, ⑦).
   */
  kind: DeviceKind;
  /**
   * Whether this computer said it runs commands (`execHost:announce`). Absent
   * for a device that never announced — an older build, or a phone. Surfaced so
   * the Devices list can say which machines accept commands.
   */
  runsCommands?: boolean;
}

/**
 * A paired client's own account of what it is. Self-asserted at pairing and
 * never verified — it decides what Stem OFFERS a device, not what it may do, so
 * a client that lied about it would only be volunteering itself for work it is
 * bad at. See DeviceRecord in server/transport/auth.ts.
 */
export type DeviceKind = 'desktop' | 'mobile';

/** A pairing code that has been issued but not yet spent. */
export interface PendingPairing {
  label: string;
  expiresAt: string;
}

/** Everything Settings → Server → Devices renders: what is paired, and what is pending. */
export interface DevicesSnapshot {
  devices: DeviceInfo[];
  pending: PendingPairing[];
}

/** A freshly minted pairing code, shown once so it can be carried to a device. */
export interface PairingCodeInfo {
  /** Grouped for reading aloud, e.g. `ABCD-EFGH`. Case and dashes don't matter. */
  code: string;
  label: string;
  expiresAt: string;
}

/** What became of the data key that opens saved tool credentials, on export. */
export type SecretsState =
  /** Unwrapped through this machine's keychain, re-wrapped under the passphrase. */
  | 'rewrapped'
  /** There was no key: this install was already keeping tool secrets unencrypted. */
  | 'none'
  /** A key file exists but this machine can no longer open it (a keychain reset). */
  | 'unreadable';

/** One top-level member of an export, rolled up. */
export interface TransferGroup {
  name: string;
  files: number;
  bytes: number;
}

/** What an export produced — shown once, in Settings → Server, after it is written. */
export interface StateExportReport {
  path: string;
  bytes: number;
  files: number;
  /** What made it in, largest first. */
  included: TransferGroup[];
  /** What was deliberately left behind, and why. */
  omitted: Array<{ name: string; reason: string }>;
  secrets: SecretsState;
}

/**
 * What this client knows about its own connection — answered locally, never by
 * the server, because every one of these facts is about THIS machine.
 */
export interface ClientInfo {
  /** This client's row in the device registry, so it can mark itself in the list. */
  deviceId: string | null;
  /** The server it is talking to. */
  serverUrl: string;
  /** False when the server runs in this very process (the default install). */
  remote: boolean;
  /**
   * The server this client is CONFIGURED to use; null = the one it starts itself.
   * Differs from `serverUrl` exactly when the address was changed since launch —
   * which is what Settings → Server reads to say "restart to apply".
   */
  configuredUrl: string | null;
  /**
   * True when STEM_SERVER_URL pinned the address for this launch. The override
   * outranks anything stored, so the Server pane shows what is in force and
   * declines to write a setting that would not be read.
   */
  pinnedByEnv: boolean;
}

/**
 * Whether the server is answering right now. Unlike {@link ClientInfo.remote},
 * which is settled at launch and never moves, this changes under the app's feet
 * — so it is asked once on mount and pushed on every change afterwards.
 *
 * False means the client is running on its offline cache: chats can be read,
 * nothing can be sent, and anything that lives only on the server (memory,
 * skills, search) is unavailable rather than empty.
 */
export interface ConnectionState {
  reachable: boolean;
}

// ---- Preload API surface exposed on window.stem ----

export interface StemApi {
  /** The OS the main process runs on; drives per-platform UI (mod key, glyphs, CSS). */
  platform: 'darwin' | 'linux' | 'win32';
  /** Signal that the main renderer has installed all push-event listeners. */
  rendererReady(): void;
  runtimeStatus(): Promise<RuntimeStatus>;
  login(): Promise<RuntimeStatus>;
  /** Start an in-app OAuth sign-in for a provider (opens the system browser). */
  providerLogin(provider: AuthProviderId): Promise<ProviderLoginResult>;
  /** Answer an `input-request` auth event (manual code paste). */
  providerLoginRespond(requestId: string, value: string): Promise<void>;
  /** Abort the in-flight provider login. */
  providerLoginCancel(): Promise<void>;
  /** Save an API key for a provider (auth.json type:'api_key'). */
  setApiKey(provider: ApiKeyProviderId, key: string): Promise<ProviderLoginResult>;
  /**
   * Enable/disable or repoint a local model server (Ollama / LM Studio). On enable,
   * main probes the server, registers its models with the backend, and restarts it.
   */
  updateLocalProvider(id: LocalProviderId, patch: Partial<LocalProviderSettings>): Promise<ProviderLoginResult>;
  /**
   * Probe a local server's /v1/models without persisting anything. `api` omitted
   * = auto-detect the flavor from the routes the endpoint exposes.
   */
  testLocalProvider(
    id: LocalProviderId,
    baseUrl: string,
    apiKey?: string,
    api?: LocalProviderApi
  ): Promise<LocalProviderTestResult>;
  /**
   * List providers in a pasted Pi models.json or a path to one, so Settings can
   * copy extras onto Custom. Does not write Stem's Pi home.
   */
  previewPiModels(source: { json?: string; path?: string }): Promise<PiModelsOverlayPreview>;
  /**
   * Copy one provider from that overlay onto Stem's Custom endpoint (reasoning,
   * thinkingFormat, maxTokens, …). Stem's Pi home stays Stem's.
   */
  copyPiModels(
    source: { json?: string; path?: string },
    providerId: string,
    hints?: { baseUrl?: string; apiKey?: string; api?: LocalProviderApi }
  ): Promise<PiModelsOverlayCopyResult>;
  /** Remove a provider's credentials (or disable a local provider) and refresh the backend. */
  disconnectProvider(providerId: string): Promise<ProviderLoginResult>;
  /**
   * Authoritative liveness probe for a stored credential: refreshes an expired
   * OAuth token and reports whether it can still produce a usable key. `false` =
   * signed out (refresh token dead). Used to classify a failed turn.
   */
  checkAuth(provider: string): Promise<{ alive: boolean }>;
  /** Mark the first-run wizard as finished. */
  completeOnboarding(): Promise<AppSettings>;
  /** Provider-login progress pushes (auth-url opened, device code, done, …). */
  onAuthEvent(listener: (event: AuthUiEvent) => void): () => void;
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
  /**
   * Delete one skill's folder for good. Rejects if it isn't there. Unlike the
   * model's own retire path this covers skills the user wrote by hand — on a
   * server install the folder lives on the server, so nobody can reach it with a
   * file manager.
   */
  removeSkill(slug: string): Promise<SkillSummary[]>;
  /**
   * `/learn [focus]` — save a skill from the turn that just finished on this
   * thread. Bypasses the automatic gate (the user asked), but still respects the
   * mode: on `ask` the approval card appears as usual.
   */
  learnFromLastTurn(threadId: string, focus?: string): Promise<SkillLearnResult>;
  /**
   * Whether the one-time skills migration still needs asking about, and how many
   * skills it would affect. `needed: false` on a fresh install — the question only
   * makes sense to someone with a library to lose.
   */
  skillsResetStatus(): Promise<SkillsResetStatus>;
  /**
   * Carry out the migration: optionally copy the old skills into Files as plain
   * Markdown, delete them, and record the automatic-skills mode the user picked in
   * the same dialog.
   */
  resetSkills(exportFirst: boolean, mode: SkillsMode): Promise<SkillsResetResult>;
  /** Run the skills curator now (merge duplicates, archive stale ones). Returns fresh list plus what changed. */
  curateSkills(): Promise<SkillsCurateResult>;
  /** Fired after skills change (auto-create/patch by the assistant, or the curator). */
  onSkillsChanged(listener: () => void): () => void;

  // Files: the persistent drop-place. Mutations return the fresh listing.
  listFiles(): Promise<FilesListing>;
  /** Copy files into files/<subdir> (subdir '' = root). Returns fresh listing. */
  addFiles(paths: string[], subdir?: string): Promise<FilesListing>;
  /** Delete a file by its rel path. Returns fresh listing. */
  removeFile(rel: string): Promise<FilesListing>;
  /** Create a top-level subfolder (one level only). Rejects unsafe/dotted names. */
  createFilesSubdir(name: string): Promise<FilesListing>;
  /** Delete a top-level subfolder and its contents. Returns fresh listing. */
  removeFilesSubdir(name: string): Promise<FilesListing>;
  /**
   * Open the Files folder in the OS file manager. Only meaningful when the
   * server shares this machine's disk — it rejects when it doesn't, and the
   * button is hidden in that case (see hooks/useRemoteServer.ts).
   */
  revealFiles(): Promise<void>;
  /**
   * Fetch one file out of the Files folder into this machine's Downloads folder
   * and show it there. Answers with where it landed.
   */
  downloadFile(rel: string): Promise<string>;
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
  /** Delete the facts learned from a folder (pinned survive). Returns the count deleted. */
  forgetConnectedFolderFacts(id: string): Promise<number>;
  /** Index health per indexed folder id (indexed/skipped counts, pending embeds). */
  folderIndexStatus(): Promise<Record<string, FolderIndexStatus>>;
  /** Open a connected folder in the OS file manager. */
  revealConnectedFolder(id: string): Promise<void>;
  /** Open Stem's own workspace folder (containing the Files place) in the OS file manager. */
  openWorkspaceFolder(): Promise<void>;
  /** Open a native directory picker; returns chosen absolute paths ([] if canceled). */
  pickDirectory(): Promise<string[]>;
  /**
   * List one directory of the SERVER's filesystem (omit `path` for the server
   * user's home). Backs the remote folder picker, where the native dialog above
   * would browse the wrong machine.
   */
  browseServerFolders(path?: string): Promise<ServerFolderListing>;

  // Scheduled tasks. Mutations return the fresh list (like the folders APIs).
  listTasks(): Promise<ScheduledTask[]>;
  /** The model/effort a scheduled run of this thread would use (Tasks tab "runs on" chip). */
  taskThreadSettings(threadId: string): Promise<ThreadTurnSettings>;
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
  /**
   * Move one server to a paired desktop, or back to the machine hosting the
   * server with `null`. Only the location changes: the command, the credentials
   * and the OAuth token stay exactly as they were, and the machine it moves TO
   * still approves it there before anything runs.
   */
  setMcpServerLocation(name: string, deviceId: string | null): Promise<McpServerSummary[]>;
  loginMcpServer(name: string): Promise<McpLoginResult>;
  restartRuntime(): Promise<RuntimeStatus>;
  /** Assistant proposed an MCP change; fired so the UI can show a confirm card. */
  onMcpAdminApproval(listener: (proposal: McpAdminProposal) => void): () => void;
  /** Fired when an MCP approval is answered or expires, on every renderer surface. */
  onMcpAdminApprovalResolved(listener: (payload: ApprovalResolvedPayload) => void): () => void;
  /** Approve/decline an assistant-proposed MCP change by its elicitation id. */
  respondMcpAdminApproval(id: number | string, accept: boolean): Promise<void>;
  /** Fired after an assistant-initiated MCP change is applied + hot-reloaded. */
  onMcpChanged(listener: () => void): () => void;
  /** Live MCP connection-status updates (keyed by server name). */
  onMcpStatus(listener: (status: Record<string, McpServerStatus>) => void): () => void;

  // The MCP servers pinned to THIS computer. Answered by the desktop itself, not
  // by the server (see desktop/local/index.ts): approval is a fact about the
  // machine a server would run on, so these six keep working whatever the
  // machine at the other end of the wire happens to be.
  /** What this machine hosts, what it has approved, and what is waiting. */
  mcpHostState(): Promise<McpHostLocalState>;
  /** Agree to run one pinned server's current spec; the fingerprint is the one shown. */
  approveMcpHostServer(name: string, fingerprint: string): Promise<McpHostLocalState>;
  /** Withdraw agreement to run one pinned server, stopping it. */
  rejectMcpHostServer(name: string): Promise<McpHostLocalState>;
  /** Connect one pinned server now and report what actually happened. */
  testMcpHostServer(name: string): Promise<McpHostLocalState>;
  /** Re-ask the server which servers are pinned here — after moving one. */
  refreshMcpHost(): Promise<McpHostLocalState>;
  /** Fired when a server hosted here settles, fails or is re-synced. */
  onMcpHostChanged(listener: (state: McpHostLocalState) => void): () => void;

  // Whether THIS computer accepts commands from its Stem server (run_command's
  // `device` target). Client-owned for the same reason the mcpHost family is,
  // sharpened: the switch IS the consent, so the channel that flips it exists
  // only on the machine consenting. The server just hears the announcement.
  /** Whether this computer accepts commands. */
  execHostState(): Promise<ExecHostLocalState>;
  /** Flip the switch, persist it here, and tell the server. */
  setExecHostEnabled(enabled: boolean): Promise<ExecHostLocalState>;

  getMemorySettings(): Promise<MemorySettings>;
  setMemoryEnabled(enabled: boolean): Promise<MemorySettings>;
  readMemory(): Promise<MemoryContents>;
  /** Durable facts injected on `threadId`'s last turn, or null if none recorded. */
  getActiveFacts(threadId: string | null): Promise<ActiveFacts | null>;
  /** Facts that WOULD be injected for `text` right now (draft preview; no side effects). */
  previewFacts(text: string): Promise<ActiveFacts>;
  /** Save a composer quick note as a durable explicit fact — instant, no chat turn.
   *  A background pass canonicalizes + reconciles it when the model is reachable. */
  addMemoryNote(text: string): Promise<MemoryNoteResult>;
  /** Delete one durable fact; returns the refreshed memory list. */
  forgetMemory(id: number): Promise<MemoryContents>;
  setFactPinned(id: number, pinned: boolean): Promise<MemoryContents>;
  confirmFact(id: number): Promise<MemoryContents>;
  getFactDetails(id: number): Promise<FactDetails | null>;
  resolveMemoryConflict(id: number, resolution: ManualConflictResolution): Promise<MemoryContents>;
  restoreSupersededFact(id: number): Promise<MemoryContents>;
  getMemoryConflicts(): Promise<MemoryConflict[]>;
  /** Conflicts the background adjudicator resolved, newest first. */
  getAutoResolvedConflicts(): Promise<AutoResolvedConflict[]>;
  getMemoryRebuildStatus(): Promise<MemoryRebuildStatus>;
  startMemoryRebuild(): Promise<MemoryRebuildStatus>;
  pauseMemoryRebuild(): Promise<MemoryRebuildStatus>;
  resumeMemoryRebuild(): Promise<MemoryRebuildStatus>;
  /** Fired after each rebuild step persists progress — the panel never polls. */
  onMemoryRebuildStatus(listener: (status: MemoryRebuildStatus) => void): () => void;
  /** Wipe durable facts (Level 1); keeps episodic + toggle. Returns the empty fact list. */
  resetFactsMemory(): Promise<MemoryContents>;
  /** Wipe the episodic store (Level 2); keeps facts + toggle. Returns refreshed stats. */
  resetEpisodicMemory(): Promise<EpisodicStats>;
  /** Run a consolidation pass now (merge/correct/drop duplicates + stale facts). */
  consolidateMemory(): Promise<MemoryConsolidateResult>;
  /** Episodic-store metadata for the Memory → Recall sub-tab (count + size only). */
  getEpisodicStats(): Promise<EpisodicStats>;
  /** Rolling thread summaries (Level 1.5) for the Memory → Recall sub-tab. */
  getThreadSummaries(): Promise<ThreadSummary[]>;
  /** Delete one thread summary; returns the refreshed list. */
  deleteThreadSummary(id: number): Promise<ThreadSummary[]>;
  /** Set the episodic-store size cap (bytes; 0 = unlimited); returns refreshed settings. */
  setEpisodicLimit(bytes: number): Promise<MemorySettings>;
  /** Set the auto-tidy-up fact threshold (0 = manual only); returns refreshed settings. */
  setTidyThreshold(n: number): Promise<MemorySettings>;
  /** Cap on relevance-ranked facts injected per turn (pinned facts are extra). */
  setMaxRelevantFacts(n: number): Promise<MemorySettings>;

  // Chats + folders. Folder mutations return the fresh list (like addMcpServer);
  // chat rename/delete return void and the renderer re-fetches.
  listChats(): Promise<ChatListResult>;
  /** Same-language (no-LLM) full-text search — instant; shown first by the renderer. */
  searchChatsFast(query: string): Promise<ChatSearchHit[]>;
  /** Cross-language (Slovak/English) search — expands the query, then matches. */
  searchChats(query: string): Promise<ChatSearchHit[]>;
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

  // Inbox: read/archive/snooze state for the Chats panel's Inbox mode. Every
  // mutator takes a list of thread ids so a bulk selection is the same call as a
  // single row, and returns the fresh list the way the folder mutators do.
  setInboxArchived(threadIds: string[], archived: boolean): Promise<ChatListResult>;
  /** Snooze until an epoch-ms instant, or pass null to wake the threads now. */
  snoozeChats(threadIds: string[], until: number | null): Promise<ChatListResult>;
  setInboxRead(threadIds: string[], read: boolean): Promise<ChatListResult>;
  markInboxAllRead(): Promise<ChatListResult>;
  /**
   * Write (or rewrite) one thread's subject from its first message, right now —
   * the "Write a subject" row action. New threads get one on their own; this is
   * how a chat that predates the setting, or one whose subject missed the point,
   * gets a fresh one. Resolves once the model has answered and the list is settled.
   */
  writeChatSubject(threadId: string): Promise<ChatListResult>;
  /**
   * The chat list changed underneath the renderer — today, a subject that a
   * background model call has just finished writing. Payload-free on purpose:
   * the answer is always "call listChats again".
   */
  onChatsChanged(listener: () => void): () => void;
  /**
   * The event stream came back after a gap the server could no longer replay, so
   * nothing this window is showing can be assumed current. Payload-free for the
   * same reason as onChatsChanged: the answer is always "ask again".
   */
  onResync(listener: () => void): () => void;
  /**
   * Which turns the server has running, as of the moment the event stream
   * connected. The whole truth, not an addition to it — a thread that is not in
   * the list finished while this window was not listening, and the only way to
   * learn that is to be told.
   */
  onLiveTurns(listener: (turns: LiveTurn[]) => void): () => void;
  /**
   * Whether the server is answering, right now. Asked on mount because the first
   * answer can predate this window; see {@link onConnectionChanged}.
   */
  connectionState(): Promise<ConnectionState>;
  /**
   * The server started or stopped answering. Together with the initial
   * {@link connectionState} this is what raises the offline banner, disables the
   * composer, and turns the memory / skills / search empty states into
   * "unavailable".
   */
  onConnectionChanged(listener: (reachable: boolean) => void): () => void;

  // App settings + Quick Chat overlay.
  getSettings(): Promise<AppSettings>;
  updateQuickChat(patch: Partial<QuickChatSettings>): Promise<AppSettings>;
  /** Is the configured summon key actually live? (See QuickChatShortcutStatus.) */
  getQuickChatShortcutStatus(): Promise<QuickChatShortcutStatus>;
  /** Enable/disable web search per context, or repoint its backend. */
  updateWebSearch(patch: Partial<WebSearchSettings>): Promise<AppSettings>;
  /** Set the main-composer Escape-to-retract behavior. */
  updateEscapeAction(action: EscapeAction): Promise<AppSettings>;
  /**
   * Release notes for this build, plus which sections the user hasn't seen. Has
   * side effects in main (see releaseNotesSnapshot) — call it once on startup and
   * when the About block mounts, not on a timer.
   */
  getReleaseNotes(): Promise<ReleaseNotesSnapshot>;
  /** Record this build's notes as read (called when the popup is dismissed). */
  markReleaseNotesSeen(): Promise<void>;
  /** Turn the after-update popup on or off. */
  updateReleaseNotesSettings(patch: Partial<ReleaseNotesSettings>): Promise<AppSettings>;
  /** Where the updater stands right now — asked on mount, then pushed. */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** Look for a new release now. Resolves with where things stand afterwards. */
  checkForUpdates(): Promise<UpdateStatus>;
  /**
   * Act on a found update: restart into the downloaded build (`auto`), or open
   * the release page to get it (`manual`). A no-op unless one is waiting.
   */
  installUpdate(): Promise<void>;
  /** Turn the automatic check on or off. */
  updateUpdatesSettings(patch: Partial<UpdatesSettings>): Promise<AppSettings>;
  /** The updater moved — checking, found something, finished a download, failed. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  // Devices: which clients may reach the server, and how a new one is admitted.
  /** Every registered device plus any pairing code still outstanding. */
  listDevices(): Promise<DevicesSnapshot>;
  /** Remove a device's credential and cut any event stream it has open. */
  revokeDevice(id: string): Promise<DevicesSnapshot>;
  /** Mint a one-shot pairing code for a device that will be called `label`. */
  createPairingCode(label: string): Promise<PairingCodeInfo>;
  /** This client's own identity and connection — answered without the wire. */
  clientInfo(): Promise<ClientInfo>;
  /**
   * Point this client at `url`, spending `code` to get a credential for it.
   * Takes effect on the next launch: the event stream, the bound channel list and
   * every cached surface hang off the connection made at startup, so there is
   * nothing honest to do with a new address until Stem restarts.
   */
  pairWithServer(url: string, code: string): Promise<ClientInfo>;
  /** Forget the configured server (and its credential) and go back to the built-in one. */
  useBuiltInServer(): Promise<ClientInfo>;
  /**
   * Write this Stem — chats, memory, skills, settings, connected tools — to one
   * archive, with saved tool credentials re-wrapped so `passphrase` opens them
   * wherever it lands. Opens a save dialog; resolves null if that is cancelled.
   * Refuses when the server is somewhere else, because then its state is too.
   */
  exportState(passphrase: string): Promise<StateExportReport | null>;

  /** Set the model used for memory distillation/tidy-up ({ model: null } = default). */
  updateMemorySettings(patch: Partial<MemoryModelSettings>): Promise<AppSettings>;
  updateSkillsSettings(patch: Partial<SkillsSettings>): Promise<AppSettings>;
  /** Patch the Chats panel settings (subject mode/model, Inbox preview lines). */
  updateChatsSettings(patch: Partial<ChatsSettings>): Promise<AppSettings>;
  /** Patch the scheduled-task settings (how loudly a run's notify_user arrives). */
  updateTasksSettings(patch: Partial<TasksSettings>): Promise<AppSettings>;
  /** The model you chat with, and the fallback every background role inherits. */
  updateDefaults(patch: Partial<DefaultsSettings>): Promise<AppSettings>;
  /** Patch the standing custom instructions (e.g. { main } or { quickChat }). */
  updateCustomInstructions(patch: Partial<CustomInstructionsSettings>): Promise<AppSettings>;
  /** Assistant proposed a custom-instructions change; fired so the UI can show a card. */
  onInstructionsApproval(listener: (proposal: InstructionsProposal) => void): () => void;
  /** Fired when an instructions approval is answered or expires. */
  onInstructionsApprovalResolved(listener: (payload: ApprovalResolvedPayload) => void): () => void;
  /**
   * Apply/cancel an assistant-proposed custom-instructions change. On accept, main
   * writes `{ [surface]: text }` (the card's final full text) before releasing the tool.
   */
  respondInstructionsApproval(
    id: number | string,
    accept: boolean,
    surface: 'main' | 'quickChat',
    text: string
  ): Promise<void>;
  /** Stem wants to save a skill and the mode is `ask`; fired so the UI can show a card. */
  onSkillApproval(listener: (proposal: SkillProposal) => void): () => void;
  /** Fired when a skill approval is answered or expires. */
  onSkillApprovalResolved(listener: (payload: ApprovalResolvedPayload) => void): () => void;
  /**
   * Apply/cancel a proposed skill. On accept, main writes the card's final text
   * (the user may have edited it) through the same validator every other path
   * uses, then releases the tool.
   */
  respondSkillApproval(
    id: number | string,
    accept: boolean,
    skill: { name: string; description: string; body: string }
  ): Promise<void>;
  /** Patch the command-execution policy (enable switch, judge model, allowlist). */
  updateExecSettings(patch: Partial<ExecSettings>): Promise<AppSettings>;
  /** A command needs the user's decision; fired so the UI can show the exec approval card. */
  onExecApproval(listener: (request: ExecApprovalRequest) => void): () => void;
  /** Fired when an exec approval is answered or expires. */
  onExecApprovalResolved(listener: (payload: ApprovalResolvedPayload) => void): () => void;
  /** Answer a pending exec approval ("Allow once" / "Always allow prefix" / "Deny"). */
  respondExecApproval(id: string, decision: ExecDecision): Promise<void>;
  /** What each chat's shell commands have left on disk, biggest first. */
  getScratchUsage(): Promise<ScratchUsageRow[]>;
  /** Empty one chat's scratch folder (or the unfiled pile); the chat itself stays. */
  clearScratch(key: string): Promise<void>;
  /** Update the embeddings/reranker retrieval endpoints (deep-merged per stage). */
  updateRetrievalSettings(patch: PartialRetrievalSettings): Promise<AppSettings>;
  /** Live-probe a retrieval endpoint with the current settings (Settings "Test" button). */
  testRetrievalEndpoint(stage: RetrievalStage): Promise<RetrievalTestResult>;
  /** Everything the toolbar activity indicator shows: in-flight runs plus recent history. */
  getActivity(): Promise<ActivitySnapshot>;
  /** Fired whenever a background pass starts, progresses or finishes. */
  onActivity(listener: (snapshot: ActivitySnapshot) => void): () => void;
  /** Panel opened — clear the sticky "something failed" marker on the icon. */
  markActivitySeen(): Promise<void>;
  /** Current local embedding worker state (download/load/ready) for the Manage panel. */
  getLocalEmbedStatus(): Promise<LocalEmbedStatus>;
  /** Fired whenever the local embedding worker's status changes (incl. download progress). */
  onLocalEmbedStatus(listener: (status: LocalEmbedStatus) => void): () => void;
  /** Current local reranker model state (download/load/ready) for the Manage panel. */
  getLocalRerankStatus(): Promise<LocalRerankStatus>;
  /** Fired whenever the local reranker model's status changes (incl. download progress). */
  onLocalRerankStatus(listener: (status: LocalRerankStatus) => void): () => void;
  /** Last known verdicts on the remote retrieval endpoints (mode === 'remote'). */
  getRemoteRetrievalHealth(): Promise<RemoteRetrievalHealth>;
  /** Fired whenever a remote retrieval endpoint's verdict changes. */
  onRemoteRetrievalHealth(listener: (health: RemoteRetrievalHealth) => void): () => void;
  /** Overlay → main: run a prompt in the overlay's own thread (main hides the
   *  overlay + raises the HUD, pre-creating a thread for a fresh session). */
  runQuickChat(prompt: QuickChatPrompt): Promise<StartTurnResult>;
  /** Overlay → main: forget the current overlay thread so the next prompt is fresh. */
  newQuickChatThread(): Promise<void>;
  /** Overlay → main: hand the conversation off to the main window. */
  handoffQuickChat(payload: QuickChatHandoff): Promise<void>;
  /** Overlay: main requests an atomic snapshot before changing event ownership. */
  onQuickChatHandoffRequest(listener: (request: QuickChatHandoffRequest) => void): () => void;
  /** Overlay → main: answer an atomic implicit-handoff snapshot request. */
  respondQuickChatHandoffRequest(id: string, payload: QuickChatHandoff): void;
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
  /** HUD window only: play the bundled finish chime (used where there's no system sound to spawn). */
  onHudPlayChime(listener: () => void): () => void;
}
