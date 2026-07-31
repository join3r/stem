import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  watch,
  type FSWatcher
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActivityItem,
  BackendEventEnvelope,
  ChatMessage,
  ChatSummary,
  InstructionsProposal,
  McpAdminProposal,
  McpLoginResult,
  McpServerInput,
  MessageAttachment,
  MessageMeta,
  ModelServiceTier,
  ModelSummary,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';
import {
  API_KEY_PROVIDER_IDS,
  AUTH_PROVIDER_IDS,
  LOCAL_PROVIDER_IDS,
  providerName
} from '../../shared/providers';
import { stripCiteMarkers } from '../../shared/citations';
import { log } from '../log';
import { isContextOverflowError } from '../backend/overflow';
import { PLAIN_MD_DIRECTIVE, STEM_ASSISTANT_INSTRUCTIONS } from '../workspace/bootstrap';
import { readSettings } from '../workspace/settings';
import { captureMemoryFromUserInput, isRecallEnabled } from '../workspace/memory';
import { buildRecallContext, type RecallTimings } from '../recall/inject';
import { reconcileExplicitFact } from '../recall/reconcile';
import { buildFilesContext } from '../files/inject';
import { buildConnectedFoldersContext } from '../connected-folders/inject';
import { getPrivateRoots } from '../workspace/connected-folders';
import { resolveAttachments, type PiImageContent } from './attachments';
import { captureUserMessage } from '../recall/capture';
import type { ApprovalId, ChatBackend, ExecBridge, TaskBridge } from '../backend/types';
import {
  buildMcpCatalogContext,
  ensureMcpConfig,
  mcpServerAuthIdentity,
  migrateLegacyOAuthTokens,
  piExtensionPath,
  piMcpOAuthPath,
  piMcpStatusPath,
  readMcpConfig,
  saveOAuthTokenIfServerMatches,
  writeNativeSearchGate,
  writeServiceTierGate
} from './mcp-config';
import { authorizeMcp } from './oauth';
import { readModelsConfig, syncModelsConfig } from './models-config';
import { refreshXaiTokenIfNeeded, syncXaiModelsConfig } from './xai-oauth';
import {
  buildWebSearchContext,
  piWebAccessPath,
  TESTED_WEB_ACCESS_VERSION,
  webAccessVersion,
  writeWebSearchConfig
} from './web-search';
import { piMcpConfigPath, skillsRoot } from '../workspace/paths';
import { recordUses } from '../skills/usage';
import { resolvePi, type PiInvocation } from './locate';
import { PiProcess, type PiEvent } from './rpc';
import {
  newTurnContext,
  normalizePiEvent,
  phaseOfEvents,
  toolCallActivity,
  toTurnUsage,
  type NormalizedEvent,
  type PiUsage,
  type TurnContext,
  type TurnTimingBreakdown
} from './normalize';

import { ForegroundSessionGate } from './session-gate';
import { secretKeyHex } from './secrets';
import {
  ADMIN_APPROVAL_TITLE,
  ENV_MCP_CONFIG,
  ENV_MCP_OAUTH,
  ENV_SECRET_KEY,
  ENV_SKILLS_DIR,
  EXEC_BRIDGE_TITLE,
  INSTRUCTIONS_APPROVAL_TITLE,
  SKILLS_REV_FILE,
  TASK_BRIDGE_TITLE,
  toolArgsOf
} from './protocol';
import { recallStore, type Fact, type FactTier, type InjectedDocRef } from '../recall/store';
const { getTurnActivitiesByThread, getTurnTimingsByThread, upsertTurnActivity, upsertTurnTiming, setActiveFacts, recordTurnInjectedFacts, recordTurnInjectedDocs } = recallStore;

// Default provider/model. openai-codex is the user's working ChatGPT subscription
// (verified streaming in the Phase-0 spike); Anthropic/Claude Max is selectable
// but currently gated behind claude.ai "extra usage". gpt-5.3-codex-spark is the
// exact model the spike streamed successfully.
const DEFAULT_PROVIDER = 'openai-codex';
const DEFAULT_MODEL = 'gpt-5.3-codex-spark';

// No provider capability set for web search any more: it is served by the vendored
// pi-web-access extension (see ./web-search), so every model has it.
// Friendly provider names for the UI live in shared/providers.ts (also used by
// the renderer's settings/onboarding surfaces).

// Sentinel titles / tee key / gate-file names shared with the bridge extension
// live in ./protocol (with a drift-guard test against the extension source).

// pi has no per-turn context channel, so recall/files/format context is prepended
// into the user's prompt message — which pi then PERSISTS in the session JSONL. To
// keep that injected scaffolding out of the replayed user bubble (it was showing up
// as "a lot of information before the first question" when reopening a Quick Chat
// thread in the main window), wrap it in HTML-comment sentinels and strip it on
// read. The markers are inert to the model and never occur in real user text.
const CONTEXT_OPEN = '<!--stem:context-->';
const CONTEXT_CLOSE = '<!--/stem:context-->';
const CONTEXT_STRIP_RE = /^<!--stem:context-->[\s\S]*?<!--\/stem:context-->\n+/;

// Scheduled-task runs prepend a fenced preamble (model-visible: it tells the agent
// it's running headless and how to surface results) that doubles as a replay marker.
// Like the context fence it's stripped from the rendered user bubble, but it also
// flags the turn as a scheduled run (with its ISO timestamp) so the UI collapses it.
const SCHED_CLOSE = '<!--/stem:scheduled-->';
const SCHED_STRIP_RE = /^<!--stem:scheduled at="([^"]*)"-->[\s\S]*?<!--\/stem:scheduled-->\n+/;

/** The model-visible scheduled-run preamble, fenced for replay stripping + detection. */
function scheduledPreamble(at: string): string {
  return [
    `<!--stem:scheduled at="${at}"-->`,
    'This is an automated scheduled run — no human is reading the reply live. Carry out the task.',
    'If, and only if, the result is something the user should be told about, call the notify_user tool with a short message.',
    'Otherwise just finish quietly. Do not ask the user questions — there is no one to answer.',
    SCHED_CLOSE
  ].join('\n');
}

// Max length for an auto-derived chat title; longer first messages are
// truncated (the sidebar ellipsizes anyway).
const MAX_AUTO_TITLE = 80;

/** Derive a chat title from the first user message: its first non-empty line, trimmed and capped. */
function titleFromInput(input: string): string {
  const line = input.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > MAX_AUTO_TITLE ? `${line.slice(0, MAX_AUTO_TITLE - 1).trimEnd()}…` : line;
}

// Argument keys a built-in file tool (read/grep/find/ls/edit/write) carries its
// target path under. Probed on the raw pi event for the memory-taint check.
const TOOL_PATH_KEYS = ['path', 'file_path', 'filename'] as const;

// Tools whose touch inside a skill folder counts as CONSULTING that skill for
// usage tracking. An allowlist, not "everything but edit/write": a future tool
// that merely carries a path arg must not count, and edits are authoring, not
// use (agent authoring goes through manage_skill in the bridge anyway).
const SKILL_CONSULT_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

/** Pull the target file/dir path out of a raw pi tool_execution_start event, if any. */
function readToolPath(ev: PiEvent): string | null {
  const nested = toolArgsOf(ev);
  const probe = (src: Record<string, unknown> | undefined): string | null => {
    if (!src) return null;
    for (const key of TOOL_PATH_KEYS) {
      const v = src[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return null;
  };
  return probe(ev as unknown as Record<string, unknown>) ?? probe(nested);
}

/**
 * Resolve a policy-checked path through symlinks. `realpathSync()` handles an
 * existing target directly; for a not-yet-created write target, walk upward to
 * the nearest existing ancestor, canonicalize that, then append the missing
 * suffix. This keeps aliases from bypassing connected-folder policy while still
 * allowing checks before a new file exists.
 */
function resolvePolicyInput(target: string, cwd: string): string {
  // Match pi's resolveToCwd normalization before applying Stem's policy. Without
  // this, pi would expand `~/…`, `file://…`, or a leading `@` to a protected path
  // while the guard checked an unrelated literal path below the workspace.
  let normalized = target.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized === '~') normalized = homedir();
  else if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) {
    normalized = join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // Let the ordinary path resolver handle a malformed URL. pi will reject it
      // too, and the policy check remains deterministic rather than throwing.
    }
  }

  return resolve(cwd, normalized);
}

function canonicalizePolicyAbsolutePath(absolutePath: string): string {
  let candidate = absolutePath;
  // realpath is the cheap/common path for an existing target.
  try {
    return realpathSync(candidate);
  } catch {
    // A write target may not exist yet. Walk each existing component with lstat
    // so a *dangling* symlink is still followed (realpath alone cannot resolve a
    // leaf link whose destination has not been created). Restart after every link
    // to cover chains and relative targets; bound the walk like the OS does.
  }

  for (let symlinks = 0; symlinks < 40; symlinks++) {
    const root = parse(candidate).root;
    const parts = candidate.slice(root.length).split(sep).filter(Boolean);
    let cursor = root;
    let followed = false;
    for (let i = 0; i < parts.length; i++) {
      const next = join(cursor, parts[i]);
      let stat;
      try {
        stat = lstatSync(next);
      } catch {
        return resolve(cursor, ...parts.slice(i));
      }
      if (stat.isSymbolicLink()) {
        const destination = readlinkSync(next);
        candidate = resolve(dirname(next), destination, ...parts.slice(i + 1));
        followed = true;
        break;
      }
      cursor = next;
    }
    if (!followed) return candidate;
  }
  // A symlink cycle cannot lead to a successful write/read. Return the last
  // resolved candidate rather than throwing from an event-policy hook.
  return candidate;
}

export function canonicalPolicyPath(target: string, cwd: string): string {
  return canonicalizePolicyAbsolutePath(resolvePolicyInput(target, cwd));
}

function policyPathExists(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror pi's resolveReadPath fallback order after resolveToCwd. Pi tolerates
 * common macOS filename spelling variants; policy must check the same concrete
 * path or an alias spelled with a straight quote/NFC/ordinary space can resolve
 * into a private root only after Stem has authorized the wrong missing path.
 */
function canonicalPolicyReadPath(target: string, cwd: string): string {
  const resolved = resolvePolicyInput(target, cwd);
  if (policyPathExists(resolved)) return canonicalizePolicyAbsolutePath(resolved);
  const narrowSpace = '\u202F';
  const amPm = resolved.replace(/ (AM|PM)\./gi, `${narrowSpace}$1.`);
  const nfd = resolved.normalize('NFD');
  const curly = resolved.replace(/'/g, '\u2019');
  const nfdCurly = nfd.replace(/'/g, '\u2019');
  for (const candidate of [amPm, nfd, curly, nfdCurly]) {
    if (candidate !== resolved && policyPathExists(candidate)) {
      return canonicalizePolicyAbsolutePath(candidate);
    }
  }
  return canonicalizePolicyAbsolutePath(resolved);
}

/**
 * Slug (first path segment under `root`) named by a tool-target path, or null
 * when the path is the root itself or outside it. Canonicalizes both sides like
 * pathInsideAny so relative/`~`/symlinked spellings resolve to the same skill.
 */
export function skillSlugForPath(target: string, root: string, cwd: string): string | null {
  const abs = canonicalPolicyReadPath(target, cwd);
  const r = canonicalPolicyPath(root, cwd);
  if (abs === r || !abs.startsWith(r + sep)) return null;
  return abs.slice(r.length + 1).split(sep)[0] || null;
}

/** True when `target` (resolved against cwd if relative) is at/inside any of `roots`. */
export function pathInsideAny(target: string, roots: string[], cwd: string): boolean {
  const abs = canonicalPolicyReadPath(target, cwd);
  return roots.some((root) => {
    const r = canonicalPolicyPath(root, cwd);
    return abs === r || abs.startsWith(r + sep);
  });
}

interface RuntimeOptions {
  piHome: string;
  sessionsDir: string;
  workspaceRoot: string;
  /**
   * Seed auth.json from the user's global ~/.pi/agent on first run (default true).
   * Set false for alternate profiles (--fresh / --profile) so they start genuinely
   * unauthenticated and land in the first-run onboarding wizard.
   */
  seedGlobalAuth?: boolean;
}

interface PiModel {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  /** Context window size in tokens (pi defaults to 128000 when a model omits it). */
  contextWindow?: number;
  /**
   * Per-model thinking-level capability/override map from pi. A key present with a
   * non-null value means that level is supported (pi maps it to the provider value
   * internally); a key mapped to null means that level is NOT available. Levels not
   * mentioned keep the reasoning-model default. Absent/null => defaults only.
   */
  thinkingLevelMap?: Record<string, string | null> | null;
}

// The effort levels the UI can display, lowest→highest. 'off' disables reasoning
// entirely; 'xhigh' is opt-in per model via thinkingLevelMap. (pi also has 'minimal',
// which Stem doesn't surface.)
const DISPLAY_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'] as const;
// Levels every reasoning model is assumed to support unless its thinkingLevelMap opts out.
const BASE_EFFORTS = new Set(['off', 'low', 'medium', 'high']);

/** Resolve which display efforts a model supports from pi's thinkingLevelMap. */
function effortsFor(m: PiModel): string[] {
  if (!m.reasoning) return [];
  const map = m.thinkingLevelMap ?? {};
  return DISPLAY_EFFORTS.filter((lvl) => (lvl in map ? map[lvl] !== null : BASE_EFFORTS.has(lvl)));
}

// openai-codex models accept service_tier:'priority' (1.5× speed); other providers have none.
function serviceTiersFor(m: PiModel): ModelServiceTier[] {
  if (m.provider !== 'openai-codex') return [];
  return [{ id: 'priority', name: 'Fast', description: '1.5× speed, increased usage' }];
}

interface SessionFile {
  id: string;
  path: string;
  name: string | null;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Refresh the xAI OAuth token if stored and near-expiry, then update models.json.
 * Safe to call unconditionally — a no-op when xAI isn't configured.
 */
async function refreshXaiAccessToken(): Promise<void> {
  try {
    const token = await refreshXaiTokenIfNeeded();
    if (token) await syncXaiModelsConfig(token.accessToken);
  } catch {
    // Non-fatal: xAI models simply won't be available until the next refresh.
  }
}

/**
 * The pi (pi.dev) backend, run in RPC mode as a long-lived subprocess.
 * Normalizes pi's command/event protocol into Stem's canonical backend events
 * and satisfies {@link ChatBackend}.
 *
 * Architectural note: pi RPC holds ONE active session per process. So the
 * foreground process tracks the active thread (switch_session/new_session),
 * and `complete()` uses a separate ephemeral `--no-session` process so recall
 * distillation never clobbers the user's active chat.
 */
export class PiRuntime extends EventEmitter implements ChatBackend {
  private proc: PiProcess | null = null;
  private starting: Promise<void> | null = null;
  private foreground = new ForegroundSessionGate();
  private activeThreadId: string | null = null;
  private mcpStatusWatcher: FSWatcher | null = null;
  private mcpStatusDebounce: NodeJS.Timeout | null = null;
  /**
   * The model of the CURRENTLY active pi session, mirrored so `applyModel` can skip a
   * redundant `set_model` within one session. pi resolves the model per session — a new
   * session resets to the spawn default, switching/forking/rolling back loads that
   * session's own persisted model — so this MUST be invalidated (set null) on every
   * session change, or the next `applyModel` wrongly no-ops and the turn runs on the
   * wrong model (e.g. a vision request silently downgraded to text-only Spark).
   */
  private currentModel: string | null = null;
  /**
   * The thinking level of the CURRENTLY active pi session, mirrored like
   * `currentModel` so `setThinking` can skip the redundant `set_thinking_level`
   * round-trip issued on every turn. Sessions persist their own level, so this
   * follows the exact same invalidation discipline: null on every session change.
   */
  private currentThinking: string | null = null;
  /** sessionId → on-disk session file, learned from get_state / dir scans. */
  private sessionFiles = new Map<string, string>();
  /**
   * path → parsed metadata, keyed so an unchanged file (same mtime) is reused on
   * the next scan instead of being re-read and re-parsed. Reading a whole JSONL
   * file (incl. inlined base64 images) just to extract its title is the dominant
   * list/delete cost, so this keeps repeated `listThreads` refreshes cheap.
   */
  private metaCache = new Map<string, { mtimeMs: number; meta: SessionFile }>();
  /**
   * Sessions pre-created via createThread (e.g. Quick Chat) that haven't had a
   * turn yet, so their first turn still gets an auto-derived title — matching the
   * no-threadId path. Drained on first prompt.
   */
  private unnamedThreads = new Set<string>();
  /**
   * Live-turn turnId (a minted uuid) → pi's 8-hex session entry id of that turn's
   * user message. Populated after each turn so fork/rollback can target the right
   * entry. Reloaded threads already use entry ids as turnIds (identity).
   */
  private turnEntryIds = new Map<string, string>();
  /** The turn currently streaming on the foreground process (one at a time). */
  private currentTurn: TurnContext | null = null;
  /**
   * The last turn that settled, so post-run auto-compaction (which pi runs AFTER
   * agent_end, when no live turn exists) can still be surfaced on its bubble.
   */
  private lastSettledTurn: { threadId: string; turnId: string } | null = null;
  /** Pending stem-admin approvals, keyed by the bridge's extension_ui_request id. */
  private adminApprovals = new Set<string>();
  /** Immutable proposal snapshot paired with each pending admin approval. */
  private adminApprovalProposals = new Map<
    string,
    { proposal: McpAdminProposal; process: PiProcess | null }
  >();
  /** Pending custom-instructions approvals, keyed by the bridge's extension_ui_request id. */
  private instructionsApprovals = new Set<string>();
  /** Originating process for each held instructions request. */
  private instructionsApprovalProcesses = new Map<string, PiProcess | null>();
  /** Wired by main to route the assistant's schedule_task/notify_user tools. */
  private taskBridge: TaskBridge | null = null;
  /** Wired by main to route the assistant's run_command tool. */
  private execBridge: ExecBridge | null = null;
  /** Set when an admin add/remove was approved; reloads MCP servers at turn end. */
  private pendingMcpReload = false;
  /** Set when a skill was written this turn (or by the curator); reloads at turn end. */
  private pendingSkillReload = false;
  /** The skills revision marker captured at turn start, to detect in-turn skill writes. */
  private skillsRevAtTurnStart = '';

  // ---- crash-loop breaker ----
  // An exit under RAPID_EXIT_MS counts a strike; SPAWN_STRIKE_LIMIT strikes pause
  // respawns for an escalating cooldown so a broken install can't spawn-crash in a
  // tight loop on every turn attempt. A long-lived process resets the count, and a
  // user-initiated restart() clears the breaker outright.
  private static readonly RAPID_EXIT_MS = 15_000;
  private static readonly SPAWN_STRIKE_LIMIT = 3;
  private static readonly COOLDOWN_BASE_MS = 30_000;
  private static readonly COOLDOWN_MAX_MS = 300_000;
  /** Monotonic spawn counter, so one failed spawn never counts two strikes. */
  private spawnGen = 0;
  private strikedGen = 0;
  private spawnStrikes = 0;
  private cooldownUntil = 0;
  /** Memoized pi-web-access entry point: undefined = unresolved, null = absent. */
  private webAccessPath: string | null | undefined = undefined;

  /** complete() spawns a throwaway pi process per call; cap them (queue the rest). */
  private static readonly MAX_COMPLETE_PROCS = 2;
  private completeActive = 0;
  private completeWaiters: Array<() => void> = [];

  constructor(private readonly options: RuntimeOptions) {
    super();
  }

  // ---- lifecycle / auth ----

  async status(): Promise<RuntimeStatus> {
    const base: RuntimeStatus = {
      ok: false,
      backendPath: null,
      backendHome: this.options.piHome,
      workspaceRoot: this.options.workspaceRoot
    };
    const pi = await resolvePi();
    if (!pi) return { ...base, error: 'The pi backend could not be located (bundled copy missing and no system pi).' };
    base.backendPath = pi.displayPath;

    await this.ensurePiHome();
    const providers = [...(await this.authProviders())];
    const authed = providers.length > 0;
    if (!authed) {
      return {
        ...base,
        authenticated: false,
        providers,
        loginCommand: this.loginCommand(pi),
        error: 'Stem is not signed in yet.'
      };
    }
    return { ...base, ok: true, authenticated: true, providers, loginCommand: this.loginCommand(pi) };
  }

  async login(): Promise<RuntimeStatus> {
    // pi has no headless `login` subcommand; auth happens in its TUI (`/login`).
    // We seed the isolated home from the user's existing ~/.pi auth when present;
    // otherwise status() surfaces the copy-pasteable command for the TUI flow.
    await this.ensurePiHome();
    return this.status();
  }

  async restart(): Promise<void> {
    // A deliberate restart is the manual breaker reset: the user (or a config
    // change) asked for a fresh spawn, so it always gets one immediately.
    this.spawnStrikes = 0;
    this.cooldownUntil = 0;
    await this.shutdown();
    await this.ensureStarted();
  }

  async prewarm(): Promise<void> {
    await this.ensureStarted();
  }

  async newConversation(): Promise<void> {
    // no-op: the next startTurn with no threadId starts a fresh session.
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.activeThreadId = null;
    this.currentTurn = null;
    this.foreground.reset();
    if (proc) await proc.dispose();
  }

  // ---- turns ----

  async createThread(model?: string): Promise<string> {
    return this.foreground.run(async () => {
      await this.ensureStarted();
      // Create the session FIRST: newSession resets the active model, so applying the
      // model before it would be undone. Apply after so the pre-created session is on it.
      const id = await this.newSession();
      if (model) await this.applyModel(model);
      this.unnamedThreads.add(id);
      return id;
    });
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const memory = await captureMemoryFromUserInput(input.input);
    if (memory.shouldAcknowledge) {
      if (memory.factId != null) {
        // Reconciliation is deliberately off the acknowledgement path: the fact is
        // durable the moment it's written, so a slow model never delays the reply
        // and a failed one costs only the supersede/conflict links, not the memory.
        setTimeout(() => void reconcileExplicitFact(memory.factId!, this), 0);
      }
      return { handled: true, assistantMessage: "I'll remember that.", rememberedPath: memory.path };
    }

    return this.foreground.run(async () => {
      const startedAt = Date.now();
      await this.ensureStarted();
      const ensureMs = Date.now() - startedAt;

      // First turn of a new chat — either a draft started here (no threadId) or a
      // session pre-created via createThread (Quick Chat) that hasn't been prompted.
      const isNewThread = !input.threadId || this.unnamedThreads.has(input.threadId);
      const threadId = input.threadId ? await this.ensureActive(input.threadId) : await this.newSession();
      if (input.model) {
        await this.applyModel(input.model);
      } else if (input.scheduled) {
        // Scheduled runs carry no renderer-selected model, and pi does NOT restore
        // the session's own model on switch_session (the spawn-time --model pins
        // every runtime rebuild) — without an explicit re-apply the run would
        // execute on the app default, not the model the user chose for this
        // thread. Best-effort: a model that has since vanished from the registry
        // must degrade to the default, not skip the run.
        const persisted = await this.threadTurnSettings(threadId).catch(() => null);
        if (persisted?.model) {
          try {
            await this.applyModel(persisted.model);
          } catch (error) {
            log('pi', 'scheduled run: could not apply thread model', {
              model: persisted.model,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        if (!input.effort && persisted?.effort) await this.setThinking(persisted.effort);
        await this.maybeCompactBeforeScheduledRun(threadId, persisted?.contextTokens).catch(() => undefined);
      }
      if (input.effort) await this.setThinking(input.effort);

      const turnId = randomUUID();
      const turn = newTurnContext(threadId, turnId);
      turn.startedAt = startedAt;
      turn.ensureMs = ensureMs;
      turn.recall = {};
      // Autonomous scheduled run: run_command's manual-approval tier is rejected
      // (nobody is present to answer the card) — see handleExecBridgeRequest.
      turn.isScheduled = !!input.scheduled;
      // The exec safety judge classifies commands relative to this request.
      turn.userText = input.input;
      // Folders connected memorize:false: if the assistant reads inside one this turn,
      // we suppress capturing its reply into Recall (see onPiEvent / isCaptureSuppressed).
      turn.privateRoots = await getPrivateRoots().catch(() => []);
      this.currentTurn = turn;
      this.skillsRevAtTurnStart = this.readSkillsRev();
      this.foreground.claimTurn();

      try {
        // Gate native web search for THIS turn (main vs Quick Chat share one process,
        // so the bridge can't tell them apart — we set the gate just before the prompt).
        await writeNativeSearchGate(input.webSearch ?? true).catch(() => undefined);
        await writeServiceTierGate(input.serviceTier ?? null).catch(() => undefined);

        const buildStart = Date.now();
        const { message, images } = await this.buildMessage(input, threadId, turn.recall, turnId);
        turn.buildMs = Date.now() - buildStart;
        // Anchor "send" at the write itself so send→firstToken is independent of how
        // pi acks the prompt command. The pre-first-event wait is attributed to no
        // phase bucket (it's TTFT, not thinking) — see advancePhase.
        turn.promptSentAt = Date.now();
        turn.lastEventAt = turn.promptSentAt;
        const res = await this.proc!.request({
          type: 'prompt',
          message,
          images: images.length ? images : undefined
        });
        if (!res.success) throw new Error(res.error ?? 'pi rejected the prompt.');
      } catch (e) {
        this.finishTurn();
        throw e;
      }

      // Persist a title for a brand-new chat. pi never auto-names sessions, so
      // without this the session_info `name` stays empty and the sidebar reverts
      // to "New chat" the moment the backend lists the thread (on restart, refresh,
      // or a folder move) — replacing the renderer's optimistic first-message title.
      this.unnamedThreads.delete(threadId);
      if (isNewThread) {
        const name = titleFromInput(input.input);
        if (name) await this.proc!.request({ type: 'set_session_name', name }).catch(() => undefined);
      }

      if (isRecallEnabled()) {
        try {
          captureUserMessage({ threadId, turnId, text: input.input, cwd: this.options.workspaceRoot });
        } catch {
          // non-fatal; the live turn is already streaming
        }
      }
      return { threadId, turnId };
    });
  }

  async interruptTurn(turnId: string): Promise<void> {
    // Ignore stale cancellation requests. In particular, the scheduler's timeout
    // cleanup must never abort a newer interactive turn if its original turn has
    // already settled without the scheduler observing the terminal event.
    if (!this.proc || !this.currentTurn || this.currentTurn.turnId !== turnId) return;
    this.currentTurn.aborted = true;
    // Interrupting the turn must also stop any command it is running: pi's abort
    // reaches the extension tool, but the actual child process lives in main.
    this.execBridge?.abortThread(this.currentTurn.threadId);
    this.proc.send({ type: 'abort' });
  }

  async listModels(): Promise<ModelSummary[]> {
    await this.maybeRefreshLocalModels();
    await this.ensureStarted();
    const res = await this.proc!.request({ type: 'get_available_models' });
    const models = ((res.data as { models?: PiModel[] } | undefined)?.models ?? []).filter(Boolean);
    const providers = await this.authProviders();
    const visible = providers.size ? models.filter((m) => providers.has(m.provider)) : models;
    const def = await this.resolveDefaultModel();
    return visible.map((m) => {
      const id = `${m.provider}/${m.id}`;
      const efforts = effortsFor(m);
      return {
        id,
        displayName: m.name ?? m.id,
        description: m.provider,
        provider: m.provider,
        providerName: providerName(m.provider),
        supportedEfforts: efforts,
        defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0] ?? 'medium',
        serviceTiers: serviceTiersFor(m),
        isDefault: m.provider === def.provider && m.id === def.modelId,
        ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {})
      };
    });
  }

  isInternalThread(_threadId: string): boolean {
    // complete() runs in a separate ephemeral process, so the foreground stream
    // never carries internal threads — nothing to suppress.
    return false;
  }

  /**
   * Whether a turn is streaming right now. Callers that need to restart the
   * process to apply a config change (models.json, web-search.json — pi reads
   * both only at spawn) use this to avoid killing a reply in progress.
   */
  isTurnRunning(): boolean {
    return !!this.currentTurn;
  }

  /**
   * True when the active turn read inside a memorize:false connected folder, so its
   * assistant reply must be kept out of Recall. The `item/completed` agentMessage is
   * emitted before agent_end clears currentTurn, so the flag is still live at capture.
   */
  isCaptureSuppressed(threadId: string): boolean {
    return this.currentTurn?.threadId === threadId && this.currentTurn.memoryTainted === true;
  }

  /**
   * One-shot prompt → completion in a throwaway `--no-session` pi process. Backs
   * the LlmClient seam (Stem Recall distillation); isolated from the user's
   * active chat so it can't clobber the foreground session.
   */
  async complete(prompt: string, opts?: { model?: string | null; timeoutMs?: number }): Promise<string> {
    // Every call spawns its own pi process; a burst (distill + consolidation +
    // summary backfill + scheduled runs) must queue instead of forking a pile of
    // concurrent children.
    await this.acquireCompleteSlot();
    try {
      return await this.completeNow(prompt, opts);
    } finally {
      this.releaseCompleteSlot();
    }
  }

  private acquireCompleteSlot(): Promise<void> {
    if (this.completeActive < PiRuntime.MAX_COMPLETE_PROCS) {
      this.completeActive += 1;
      return Promise.resolve();
    }
    // The slot is handed over directly in releaseCompleteSlot, so completeActive
    // stays constant across the transfer.
    return new Promise((resolve) => this.completeWaiters.push(resolve));
  }

  private releaseCompleteSlot(): void {
    const next = this.completeWaiters.shift();
    if (next) next();
    else this.completeActive -= 1;
  }

  private async completeNow(prompt: string, opts?: { model?: string | null; timeoutMs?: number }): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pi = await resolvePi();
    if (!pi) throw new Error('The pi backend could not be located.');
    await this.ensurePiHome();
    // Memory distillation/consolidation can run on a user-configured model
    // (Manage → Memory); fall back to the backend default when unset.
    const { provider, modelId } = opts?.model
      ? this.parseModel(opts.model)
      : await this.resolveDefaultModel();
    const child = new PiProcess({
      command: pi.command,
      prefixArgs: pi.prefixArgs,
      cwd: join(this.options.workspaceRoot, '.stem-internal'),
      env: this.sanitizedEnv(pi),
      args: [
        '--no-session',
        '--no-builtin-tools',
        '--no-skills',
        '--provider',
        provider,
        '--model',
        modelId,
        '--system-prompt',
        'You are a precise extraction engine. Follow the instructions exactly and output only what is requested.'
      ]
    });

    let text = '';
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        log('pi.complete', 'one-shot completion timed out', { timeoutMs, provider, model: modelId });
        reject(new Error('pi completion timed out.'));
      }, timeoutMs);
      const onEvent = (ev: PiEvent): void => {
        if (ev.type === 'message_end') {
          const msg = ev.message as { role?: string; content?: { type?: string; text?: string }[] } | undefined;
          if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
            const t = msg.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
            if (t) text = t;
          }
        } else if (ev.type === 'agent_end') {
          cleanup();
          resolve(text);
        }
      };
      const onExit = (): void => {
        cleanup();
        resolve(text);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off('event', onEvent);
        child.off('exit', onExit);
      };
      child.on('event', onEvent);
      child.on('exit', onExit);
    });

    try {
      child.start();
      child.send({ type: 'prompt', message: prompt });
      return await done;
    } finally {
      void child.dispose().catch(() => {});
    }
  }

  // ---- thread CRUD ----

  async listThreads(): Promise<ChatSummary[]> {
    // The pi session dir is Stem-owned and isolated (PI_CODING_AGENT_SESSION_DIR),
    // so every session in it is ours — no cwd filtering needed (and cwd is stored
    // as a realpath, which would make an equality filter brittle anyway).
    const files = await this.scanSessions();
    return files
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((f) => ({
        threadId: f.id,
        title: (f.name || 'New chat').trim() || 'New chat',
        folderId: null,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt
      }));
  }

  async readThread(threadId: string): Promise<{ title: string; messages: ChatMessage[] }> {
    const file = await this.resolveSessionFile(threadId);
    if (!file) {
      // No persisted file yet (a freshly forked/created session writes lazily on
      // first append). If it's the live active session, read its in-memory state.
      if (this.proc?.running && this.activeThreadId === threadId) return this.readActiveMessages();
      return { title: 'New chat', messages: [] };
    }
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return { title: 'New chat', messages: [] };
    }
    let title = 'New chat';
    const messages: ChatMessage[] = [];
    let lastUserId = '';
    // Persisted answer-time breakdowns + tool activity, keyed by the final
    // assistant entry id.
    const timings = getTurnTimingsByThread(threadId);
    const activities = getTurnActivitiesByThread(threadId);
    // Fallback for turns predating the sqlite activity rows: synthesize activity
    // items from the session's own persisted toolCall blocks + toolResult entries.
    let pendingActivity: ActivityItem[] = [];
    // Which model/effort produced each reply (the hover label next to "Stem").
    // Assistant entries persist provider+model directly; effort comes from the
    // thinking_level_change entry in force when the reply was written, and
    // model_change covers assistant entries predating the per-message fields.
    // Service tier is not persisted (same as the old codex rollout format).
    let effortNow: string | undefined;
    let modelNow: string | undefined;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: {
        type?: string;
        id?: string;
        name?: string;
        timestamp?: string;
        provider?: string;
        modelId?: string;
        thinkingLevel?: string;
        message?: {
          role?: string;
          content?: unknown;
          usage?: PiUsage;
          toolCallId?: string;
          isError?: boolean;
          provider?: string;
          model?: string;
        };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === 'session_info' && typeof entry.name === 'string') {
        title = entry.name.trim() || title;
        continue;
      }
      if (entry.type === 'model_change' && entry.provider && entry.modelId) {
        modelNow = `${entry.provider}/${entry.modelId}`;
        continue;
      }
      if (entry.type === 'thinking_level_change' && entry.thinkingLevel) {
        effortNow = entry.thinkingLevel;
        continue;
      }
      if (entry.type === 'compaction') {
        // Replay the condense as an activity row where it happened: after a settled
        // reply → stamp that bubble (post-run threshold compaction); mid-turn →
        // ride with the upcoming reply. When the turn's sqlite activity exists it
        // wins below and already carries the live-captured row, so no duplicate.
        const row: ActivityItem = {
          id: `compaction-${entry.id ?? messages.length}`,
          kind: 'tool',
          type: 'compaction',
          status: 'ok'
        };
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') last.activity = [...(last.activity ?? []), row];
        else pendingActivity.push(row);
        continue;
      }
      if (entry.type !== 'message' || !entry.message) continue;
      const role = entry.message.role;
      if (role === 'toolResult') {
        const hit = pendingActivity.find((a) => a.id === entry.message?.toolCallId);
        if (hit && entry.message.isError === true) hit.status = 'error';
        continue;
      }
      const { text: content, images, scheduled } = this.contentToParts(entry.message.content);
      if (role === 'user') {
        lastUserId = entry.id ?? lastUserId;
        pendingActivity = [];
        if (content.trim() || images.length)
          messages.push({
            id: `user-${entry.id}`,
            role: 'user',
            content,
            turnId: entry.id,
            ...(entry.timestamp ? { createdAt: entry.timestamp } : {}),
            ...(images.length ? { attachments: images } : {}),
            ...(scheduled ? { scheduled } : {})
          });
      } else if (role === 'assistant') {
        if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content as Array<Record<string, unknown>>) {
            if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
            if (pendingActivity.some((a) => a.id === block.id)) continue;
            const item = toolCallActivity(
              block.id,
              typeof block.name === 'string' ? block.name : undefined,
              block.arguments as Record<string, unknown> | undefined
            );
            // History has no live spinner — assume ok until a toolResult says error.
            item.status = 'ok';
            pendingActivity.push(item);
          }
        }
        if (content.trim()) {
          const timing = entry.id ? timings.get(entry.id) : undefined;
          const usage = toTurnUsage(entry.message.usage);
          const persisted = entry.id ? activities.get(entry.id) : undefined;
          const activity = persisted?.activity?.length
            ? persisted.activity
            : pendingActivity.length
              ? [...pendingActivity]
              : undefined;
          const sources = persisted?.sources?.length ? persisted.sources : undefined;
          const model =
            entry.message.provider && entry.message.model
              ? `${entry.message.provider}/${entry.message.model}`
              : modelNow;
          const meta: MessageMeta | undefined =
            model || effortNow
              ? { ...(model ? { model } : {}), ...(effortNow ? { effort: effortNow } : {}) }
              : undefined;
          messages.push({
            id: `assistant-${entry.id}`,
            role: 'assistant',
            content,
            turnId: lastUserId || entry.id,
            ...(meta ? { meta } : {}),
            ...(timing ? { timing } : {}),
            ...(usage ? { usage } : {}),
            ...(activity ? { activity } : {}),
            ...(sources ? { sources } : {})
          });
        }
      }
    }
    return { title, messages };
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.foreground.run(async () => {
      await this.ensureStarted();
      await this.ensureActive(threadId);
    });
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.foreground.run(async () => {
      await this.ensureStarted();
      await this.ensureActive(threadId);
      const renamed = await this.proc!.request({ type: 'set_session_name', name });
      if (!renamed.success) throw new Error(renamed.error ?? `pi could not rename chat "${threadId}".`);
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    // If the thread being deleted is mid-stream, abort its turn first: the gated
    // body below waits on activeTurnDone, so without this the unlink/new_session
    // would stall until the whole LLM turn finishes. pi emits `done` on abort,
    // which resolves the gate and lets the delete proceed promptly.
    if (this.activeThreadId === threadId && this.currentTurn) {
      await this.interruptTurn(this.currentTurn.turnId);
    }
    await this.foreground.run(async () => {
      const file = await this.resolveSessionFile(threadId);
      if (this.activeThreadId === threadId) {
        if (this.proc) {
          const parked = await this.proc.request({ type: 'new_session' });
          if (!parked.success) throw new Error(parked.error ?? 'pi could not leave the chat before deleting it.');
          // A successful new_session resets all active-session mirrors.
          this.currentModel = null;
          this.currentThinking = null;
        }
        this.activeThreadId = null;
      }
      this.sessionFiles.delete(threadId);
      this.unnamedThreads.delete(threadId);
      if (file) await unlink(file).catch(() => undefined);
    });
  }

  /**
   * In-place retry/edit: drop the chosen turn and everything after it, keeping the
   * SAME thread id. pi has no rollback RPC, but its sessions are append-only JSONL
   * trees — so we park the process off the file, truncate it at the turn's entry,
   * and `switch_session` back to force a reload at the trimmed leaf (verified
   * id-stable). The renderer then re-sends the prompt as a fresh turn.
   */
  async rollbackToTurn(threadId: string, turnId: string): Promise<void> {
    await this.foreground.run(async () => {
      await this.ensureStarted();
      const file = await this.resolveSessionFile(threadId);
      if (!file) throw new Error('This chat has no saved history to edit yet.');
      const entryId = this.resolveEntryId(turnId);
      const raw = await readFile(file, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      const idx = lines.findIndex((l) => this.entryIdOf(l) === entryId);
      if (idx <= 0) throw new Error('Could not locate that message to edit. Reopen the chat and try again.');
      // Park the foreground off this file so the reload reads our truncated copy.
      const parked = await this.proc!.request({ type: 'new_session' });
      if (!parked.success) throw new Error(parked.error ?? 'pi could not park the active chat for editing.');
      // The backend is now on a fresh parking session. Clear mirrors immediately;
      // if truncation/reload fails, never claim that it is still on either chat.
      this.currentModel = null;
      this.currentThinking = null;
      this.activeThreadId = null;
      await writeFile(file, lines.slice(0, idx).join('\n') + '\n');
      const switched = await this.proc!.request({ type: 'switch_session', sessionPath: file });
      if (!switched.success) throw new Error(switched.error ?? `pi could not reload chat "${threadId}" after editing.`);
      // Both RPCs above swap the active session's model/thinking out from under us.
      this.currentModel = null;
      this.currentThinking = null;
      this.activeThreadId = threadId;
    });
  }

  /**
   * Branch the conversation into a NEW chat via pi's native `fork`. Forking from
   * the next user message keeps everything up to and including the chosen turn;
   * for the last turn, fork at it (re-ask). Returns the new session id; the new
   * session is active and read live until its file is written on first append.
   */
  async forkThread(threadId: string, turnId: string): Promise<{ threadId: string }> {
    return this.foreground.run(async () => {
      await this.ensureStarted();
      await this.ensureActive(threadId);
      const entryId = this.resolveEntryId(turnId);
      const fm = await this.proc!.request({ type: 'get_fork_messages' });
      const entries = (fm.data as { messages?: { entryId: string }[] } | undefined)?.messages ?? [];
      const i = entries.findIndex((e) => e.entryId === entryId);
      if (i === -1) throw new Error('Reopen this chat to fork from an earlier message.');
      const forkEntry = entries[i + 1]?.entryId ?? entries[i].entryId;
      const res = await this.proc!.request({ type: 'fork', entryId: forkEntry });
      if (!res.success) throw new Error(res.error ?? 'pi could not fork this chat.');
      const state = await this.proc!.request({ type: 'get_state' });
      const newId = this.recordState(state.data);
      if (!newId) throw new Error('pi did not return a forked session id.');
      // The fork becomes the active session — invalidate the model/thinking mirrors.
      this.currentModel = null;
      this.currentThinking = null;
      this.activeThreadId = newId;
      return { threadId: newId };
    });
  }

  // ---- MCP (Phase 3) ----

  /**
   * OAuth browser sign-in for a remote (http) MCP server that requires it
   * (e.g. Fastmail). Discovers the authorization server, dynamically registers a
   * public client, runs the PKCE authorization-code flow against a loopback
   * redirect, and persists the resulting token. The renderer respawns pi after
   * `ok` (reconnect → restart), so the bridge picks up the token and connects.
   */
  async mcpLogin(name: string): Promise<McpLoginResult> {
    // Defense-in-depth: names are validated on add, but this value is keyed into
    // a token file and used to look up a URL — guard here too.
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('-')) {
      return { ok: false, error: 'Invalid MCP server name.' };
    }
    try {
      const config = await readMcpConfig();
      const server = config.servers[name];
      if (!server) return { ok: false, error: `No MCP server named "${name}".` };
      if (!server.url) return { ok: false, error: 'Only remote (http) servers use OAuth sign-in.' };
      const authIdentity = mcpServerAuthIdentity(server)!;
      const token = await authorizeMcp(server.url, {
        onAuthUrl: (url) => this.emitEvent('mcp/login/url', { name, url }),
        // Static confidential-client credentials, when the server was configured
        // with them (providers without dynamic client registration, e.g. Slack).
        clientId: server.oauthClientId,
        clientSecret: server.oauthClientSecret,
        scope: server.oauthScope
      });
      // The browser flow can take minutes. Check and persist under the same
      // cross-process state lock used by server replacement/removal, so a login
      // can neither land on a new identity nor be deleted by a stale snapshot.
      if (!(await saveOAuthTokenIfServerMatches(name, authIdentity, token))) {
        return { ok: false, error: `MCP server "${name}" changed during sign-in. Start sign-in again.` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Push live MCP connection status to the renderer (`mcp/status`). The bridge
   * connects routed servers in the BACKGROUND (pi readiness no longer waits for
   * them) and rewrites mcp-status.json as each settles, so an open Manage panel
   * must hear about starting→ready/failed transitions landing after startup.
   */
  private ensureMcpStatusWatcher(): void {
    if (this.mcpStatusWatcher) return;
    try {
      // Watch the directory, not the file: the bridge may recreate the file, and a
      // directory watch survives inode replacement.
      this.mcpStatusWatcher = watch(this.options.piHome, (_event, filename) => {
        if (filename !== 'mcp-status.json') return;
        if (this.mcpStatusDebounce) clearTimeout(this.mcpStatusDebounce);
        this.mcpStatusDebounce = setTimeout(() => {
          this.mcpStatusDebounce = null;
          this.emitEvent('mcp/status', this.getMcpStatus());
        }, 50);
      });
    } catch {
      // best-effort: the panel still fetches on open
    }
  }

  getMcpStatus(): Record<string, { status: string; error: string | null }> {
    // The bridge extension writes live connection status next to mcp.json.
    try {
      const parsed = JSON.parse(readFileSync(piMcpStatusPath(), 'utf8')) as Record<
        string,
        { status?: string; error?: string | null }
      >;
      const out: Record<string, { status: string; error: string | null }> = {};
      for (const [name, s] of Object.entries(parsed)) {
        out[name] = { status: s.status ?? 'unknown', error: s.error ?? null };
      }
      return out;
    } catch {
      return {};
    }
  }

  async resolveAdminApproval(
    id: ApprovalId,
    accept: boolean,
    beforeAccept?: (proposal: McpAdminProposal) => Promise<void>
  ): Promise<boolean> {
    const key = String(id);
    const pending = this.adminApprovalProposals.get(key);
    // Claim the id before awaiting the config write. This keeps an expired or
    // double-clicked card from mutating config, and makes the timeout harmless
    // while the accepted write is in flight.
    if (!pending || !this.adminApprovals.delete(key)) return false;
    this.adminApprovalProposals.delete(key);
    try {
      if (accept && beforeAccept) await beforeAccept(pending.proposal);
      pending.process?.send({ type: 'extension_ui_response', id: key, confirmed: accept });
      if (accept) {
        this.pendingMcpReload = true;
        // A concurrent process exit/restart can settle the originating turn while
        // main writes config. If idle now, reload immediately; otherwise the
        // current turn's normal finish barrier will apply it safely.
        if (!this.currentTurn) {
          this.pendingMcpReload = false;
          void this.configMcpServerReload().catch(() => undefined);
        }
      }
      this.emitEvent('mcp/admin/approvalResolved', { id: key });
      return true;
    } catch (error) {
      pending.process?.send({ type: 'extension_ui_response', id: key, confirmed: false });
      this.emitEvent('mcp/admin/approvalResolved', { id: key });
      throw error;
    }
  }

  /**
   * Release a held custom-instructions approval. Unlike the admin path, MAIN has
   * already written settings.json (the IPC handler does it before calling this), so
   * there's nothing to reload — the next turn reads the instructions fresh.
   */
  async resolveInstructionsApproval(
    id: ApprovalId,
    accept: boolean,
    beforeAccept?: () => Promise<void>
  ): Promise<boolean> {
    const key = String(id);
    const requestProcess = this.instructionsApprovalProcesses.get(key);
    // Claim the id before awaiting the settings write. This is the final
    // authorization boundary: a proposal that already expired cannot mutate
    // settings, and its timeout cannot race the accepted write.
    if (!this.instructionsApprovals.delete(key)) return false;
    this.instructionsApprovalProcesses.delete(key);
    try {
      if (accept && beforeAccept) await beforeAccept();
      requestProcess?.send({ type: 'extension_ui_response', id: key, confirmed: accept });
      this.emitEvent('instructions/approvalResolved', { id: key });
      return true;
    } catch (error) {
      requestProcess?.send({ type: 'extension_ui_response', id: key, confirmed: false });
      this.emitEvent('instructions/approvalResolved', { id: key });
      throw error;
    }
  }

  private settleAdminApproval(id: string): boolean {
    if (!this.adminApprovals.delete(id)) return false;
    this.adminApprovalProposals.delete(id);
    this.emitEvent('mcp/admin/approvalResolved', { id });
    return true;
  }

  private settleInstructionsApproval(id: string): boolean {
    if (!this.instructionsApprovals.delete(id)) return false;
    this.instructionsApprovalProcesses.delete(id);
    this.emitEvent('instructions/approvalResolved', { id });
    return true;
  }

  private settleAllApprovals(): void {
    for (const id of [...this.adminApprovals]) this.settleAdminApproval(id);
    for (const id of [...this.instructionsApprovals]) this.settleInstructionsApproval(id);
    // Exec: deny pending approval cards and kill running commands — the pi child
    // that asked is gone, so their results could never be delivered anyway.
    this.execBridge?.settleAll();
  }

  private async configMcpServerReload(): Promise<void> {
    // A reload is a full pi restart. Pay the cold-start cost HERE (spawn + MCP
    // connect + re-activating the previous thread/model) instead of lazily on the
    // next user turn — a user turn queued behind this gate then starts warm.
    const prevThread = this.activeThreadId;
    const prevModel = this.currentModel;
    await this.shutdown();
    await this.foreground.run(async () => {
      await this.ensureStarted();
      try {
        if (prevThread) await this.ensureActive(prevThread);
        if (prevModel) await this.applyModel(prevModel);
      } catch {
        // Best-effort warm-up; the next turn re-establishes state on the normal path.
      }
    });
  }

  setTaskBridge(bridge: TaskBridge | null): void {
    this.taskBridge = bridge;
  }

  setExecBridge(bridge: ExecBridge | null): void {
    this.execBridge = bridge;
  }

  /**
   * Handle the run_command tool's ctx.ui.input round-trip (sentinel EXEC_BRIDGE_TITLE).
   * The placeholder is a JSON { command, cwd, timeout_ms } payload; we run it through
   * the wired ExecBridge with the CURRENT turn's threadId + scheduled flag (only main
   * knows both) and answer with a JSON result string the tool returns. The response
   * can be minutes away (approval + spawn) — pi holds the elicitation open, same as
   * the admin/instructions approvals.
   */
  private handleExecBridgeRequest(id: string, payload: string | undefined): void {
    const respond = (value: unknown): void =>
      this.proc?.send({ type: 'extension_ui_response', id, value: JSON.stringify(value) });
    const turn = this.currentTurn;
    void (async () => {
      try {
        const bridge = this.execBridge;
        if (!bridge) return respond({ ok: false, error: 'Command execution is unavailable.' });
        const req = JSON.parse(payload ?? '{}') as { command?: string; cwd?: string; timeout_ms?: number };
        const result = await bridge.handleExecRequest({
          command: req.command ?? '',
          cwd: typeof req.cwd === 'string' && req.cwd.trim() ? req.cwd : undefined,
          timeoutMs: typeof req.timeout_ms === 'number' ? req.timeout_ms : undefined,
          threadId: turn?.threadId ?? null,
          isScheduled: turn?.isScheduled === true,
          userText: turn?.userText
        });
        respond(result);
      } catch (e) {
        respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }

  /**
   * Handle a scheduled-task tool's ctx.ui.input round-trip (sentinel TASK_BRIDGE_TITLE).
   * The placeholder is a JSON op payload; we run it against the wired TaskBridge using
   * the CURRENT turn's threadId (the only authoritative source — the extension can't
   * know Stem's thread id) and answer with a JSON result string the tool returns.
   */
  private handleTaskBridgeRequest(id: string, payload: string | undefined): void {
    const respond = (value: unknown): void =>
      this.proc?.send({ type: 'extension_ui_response', id, value: JSON.stringify(value) });
    const threadId = this.currentTurn?.threadId;
    void (async () => {
      try {
        const bridge = this.taskBridge;
        if (!bridge) return respond({ ok: false, error: 'Scheduled tasks are unavailable.' });
        if (!threadId) return respond({ ok: false, error: 'No active conversation to attach the task to.' });
        const req = JSON.parse(payload ?? '{}') as {
          op?: string;
          prompt?: string;
          cron?: string;
          at?: string;
          taskId?: string;
          title?: string;
          message?: string;
        };
        switch (req.op) {
          case 'schedule': {
            const res = await bridge.schedule({ prompt: req.prompt ?? '', cron: req.cron, at: req.at }, threadId);
            return respond(res);
          }
          case 'list': {
            const tasks = await bridge.listForThread(threadId);
            return respond({ ok: true, tasks });
          }
          case 'cancel': {
            const res = await bridge.cancel(req.taskId ?? '');
            return respond(res);
          }
          case 'notify': {
            await bridge.notify({ title: req.title, message: req.message ?? '' }, threadId);
            return respond({ ok: true });
          }
          default:
            return respond({ ok: false, error: `Unknown task op "${req.op}".` });
        }
      } catch (e) {
        respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }

  // ---- internals ----

  private emitEvent(method: string, params?: unknown): void {
    const event: BackendEventEnvelope = { method, params, receivedAt: new Date().toISOString() };
    this.emit('event', event);
  }

  private ensureStarted(): Promise<void> {
    if (this.proc && this.proc.running) return Promise.resolve();
    if (this.starting) return this.starting;
    const cooldownLeft = this.cooldownUntil - Date.now();
    if (cooldownLeft > 0) {
      return Promise.reject(new Error(
        `The pi backend keeps exiting right after startup; waiting ${Math.ceil(cooldownLeft / 1000)}s before ` +
        `trying again. Restarting the backend from Settings retries immediately.`
      ));
    }
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Crash-loop accounting for one spawn generation (deduped: an exit event and a
   * failed startup probe for the same spawn count once). Rapid exits accumulate
   * strikes toward a cooldown; a process that lived a while resets them.
   */
  private noteProcessExit(gen: number, uptimeMs: number): void {
    if (this.strikedGen === gen) return;
    this.strikedGen = gen;
    if (uptimeMs >= PiRuntime.RAPID_EXIT_MS) {
      this.spawnStrikes = 0;
      return;
    }
    this.spawnStrikes += 1;
    if (this.spawnStrikes >= PiRuntime.SPAWN_STRIKE_LIMIT) {
      const backoffMs = Math.min(
        PiRuntime.COOLDOWN_MAX_MS,
        PiRuntime.COOLDOWN_BASE_MS * 2 ** (this.spawnStrikes - PiRuntime.SPAWN_STRIKE_LIMIT)
      );
      this.cooldownUntil = Date.now() + backoffMs;
      log('pi', `crash loop: ${this.spawnStrikes} rapid exits, pausing respawns`, { backoffMs });
      this.emitEvent('process/cooldown', { until: this.cooldownUntil, strikes: this.spawnStrikes });
    }
  }

  private async start(): Promise<void> {
    const pi = await resolvePi();
    if (!pi) throw new Error('The pi backend could not be located.');
    await this.ensurePiHome();
    this.ensureMcpStatusWatcher();
    // Refresh the local-provider catalog (models.json) before the spawn: pi's RPC
    // mode reads the file once at startup and never again.
    this.lastLocalSyncAt = Date.now();
    await syncModelsConfig().catch(() => undefined);
    // Keep xAI's access token current in models.json (short-lived OAuth tokens).
    await refreshXaiAccessToken();
    // Same deal for web search: pi-web-access reads its workflow setting once at
    // extension-init, so the config file has to be correct BEFORE the spawn.
    const settings = await readSettings().catch(() => null);
    if (settings) await writeWebSearchConfig(settings.webSearch).catch(() => undefined);
    const webAccess = await this.resolveWebAccessExtension();
    const { provider, modelId } = await this.resolveDefaultModel();

    const proc = new PiProcess({
      command: pi.command,
      prefixArgs: pi.prefixArgs,
      cwd: this.options.workspaceRoot,
      env: this.sanitizedEnv(pi),
      args: [
        // Filesystem access: keep pi's read/edit/write built-ins (so the assistant can
        // open AND create/modify files in the Files folder). Exclude only `bash`
        // (arbitrary shell — a much larger surface, not needed for a chat assistant).
        // `--exclude-tools` (a denylist) is deliberate over a `--tools` allowlist: pi's
        // allowlist gates EXTENSION/custom tools too (verified in pi's agent-session.js
        // isAllowedTool), so `--tools` would silently drop stem-recall, the MCP router,
        // web_search, and the skills/admin tools. The browse tools grep/find/ls (which
        // pi leaves OFF by default, needed to explore connected folders) are instead
        // turned on at session_start via pi.setActiveTools in the bridge extension —
        // they stay registered under the denylist, just inactive until activated.
        '--exclude-tools',
        'bash',
        '-e',
        piExtensionPath(),
        // Web search for every provider (web_search / source_check /
        // fetch_content / get_search_content), loaded as a second extension
        // alongside Stem's own bridge. Omitted entirely when
        // the vendored package can't be resolved — pi still runs, just without the
        // search tools, which beats failing the whole backend over a missing dep.
        ...(webAccess ? ['-e', webAccess] : []),
        '--provider',
        provider,
        '--model',
        modelId,
        '--append-system-prompt',
        STEM_ASSISTANT_INSTRUCTIONS
      ]
    });
    this.proc = proc;
    this.currentModel = `${provider}/${modelId}`;
    // A fresh process starts a fresh session whose thinking level is unknown to us.
    this.currentThinking = null;
    const gen = ++this.spawnGen;
    const spawnedAt = Date.now();
    log('pi', 'spawning backend', { provider, model: modelId, gen });

    proc.on('event', (ev: PiEvent) => this.onPiEvent(ev));
    proc.on('stderr', (text: string) => {
      this.emitEvent('process/stderr', { text });
      log('pi.stderr', text.trim());
    });
    proc.on('exit', (info: { code: number | null; signal: string | null }) => {
      // shutdown()/restart() detach the process before disposing it — only an
      // exit of the CURRENT process is unexpected and feeds the breaker.
      const unexpected = this.proc === proc;
      this.proc = null;
      this.activeThreadId = null;
      this.currentTurn = null;
      this.settleAllApprovals();
      this.foreground.finishTurn();
      this.emitEvent('process/exit', info);
      const uptimeMs = Date.now() - spawnedAt;
      log('pi', unexpected ? 'backend exited unexpectedly' : 'backend stopped', { ...info, uptimeMs, gen });
      if (unexpected) this.noteProcessExit(gen, uptimeMs);
    });

    try {
      proc.start();
      // Probe readiness and capture the initial session id/file.
      const state = await proc.request({ type: 'get_state' }, 20_000);
      this.recordState(state.data);
    } catch (e) {
      // A spawn that never became ready must not linger half-alive: detach it so
      // ensureStarted() doesn't mistake it for a running backend, and count it
      // toward the crash-loop breaker (deduped with the exit handler above).
      if (this.proc === proc) this.proc = null;
      void proc.dispose().catch(() => undefined);
      log('pi', 'backend failed to become ready', { error: e instanceof Error ? e.message : String(e), gen });
      this.noteProcessExit(gen, Date.now() - spawnedAt);
      throw e;
    }
  }

  private onPiEvent(ev: PiEvent): void {
    if (ev.type === 'extension_ui_request') {
      const id = ev.id as string;
      // Bridge notifications are fire-and-forget (no response needed). Nothing
      // consumes them since the web-search tee was retired — kept as an explicit
      // no-op so a notify never falls through to the approval routing below.
      if (ev.method === 'notify') return;
      // The bridge's MCP add/remove approval → route to Stem's McpApprovalCard.
      if (ev.method === 'confirm' && ev.title === ADMIN_APPROVAL_TITLE) {
        this.handleAdminApproval(id, ev.message as string | undefined);
        return;
      }
      // The bridge's custom-instructions approval → route to the InstructionsApprovalCard.
      if (ev.method === 'confirm' && ev.title === INSTRUCTIONS_APPROVAL_TITLE) {
        this.handleInstructionsApproval(id, ev.message as string | undefined);
        return;
      }
      // A scheduled-task tool round-trip (schedule_task / notify_user / …). The op
      // payload rides in `placeholder` (ctx.ui.input's second arg); we never show UI.
      if (ev.method === 'input' && ev.title === TASK_BRIDGE_TITLE) {
        this.handleTaskBridgeRequest(id, ev.placeholder as string | undefined);
        return;
      }
      // The run_command tool round-trip: policy + spawn happen in main (ExecService);
      // the held elicitation is answered when the command settles.
      if (ev.method === 'input' && ev.title === EXEC_BRIDGE_TITLE) {
        this.handleExecBridgeRequest(id, ev.placeholder as string | undefined);
        return;
      }
      // No UI for other dialogs yet — dismiss them safely.
      if (ev.method === 'confirm') this.proc?.send({ type: 'extension_ui_response', id, confirmed: false });
      else if (ev.method === 'select' || ev.method === 'input' || ev.method === 'editor')
        this.proc?.send({ type: 'extension_ui_response', id, cancelled: true });
      return;
    }
    if (ev.type === 'agent_settled') {
      // pi is only NOW truly idle. agent_end can be followed by post-run work that
      // keeps its agent busy (auto-retry of transient provider errors, context
      // auto-compaction, extension-queued continuations) — a prompt sent in that
      // window is rejected with "Agent is already processing". So the send gate is
      // released HERE, not at agent_end (which stays the renderer's turn end).
      // A turn still live here announced a retry (agent_end willRetry) that never
      // materialized — settle it with its latched outcome so the renderer isn't
      // left on a forever-running turn.
      const leftover = this.currentTurn;
      if (leftover) {
        const { events } = normalizePiEvent({ type: 'agent_end' }, leftover);
        for (const e of events) this.emitEvent(e.method, e.params);
        this.settleTurn(leftover, Date.now());
      }
      this.releaseForeground();
      return;
    }
    // Post-run threshold compaction: pi checks context size AFTER agent_end (which
    // settled the turn here), so these events arrive with no live TurnContext.
    // Stamp a settled "condensed" row onto the just-finished bubble so the condense
    // is visible; compaction_start is skipped (nothing to animate on a settled turn).
    if (!this.currentTurn && ev.type === 'compaction_end' && this.lastSettledTurn) {
      const { threadId, turnId } = this.lastSettledTurn;
      const failed = ev.aborted === true || typeof ev.errorMessage === 'string';
      this.emitEvent('item/completed', {
        item: { type: 'compaction', id: `compaction-${turnId}-post`, status: failed ? 'error' : 'ok' },
        threadId,
        turnId
      });
      return;
    }
    if (!this.currentTurn) return;
    const turn = this.currentTurn;
    // Path-carrying tool calls feed two checks off the RAW event (the normalizer
    // truncates the path to a basename, losing the dir for matching):
    // - memory privacy: a read inside a memorize:false connected folder taints
    //   the turn so its assistant reply never enters Recall;
    // - skill usage: a consultative tool inside a skill's folder marks that
    //   skill used this turn (deduped by the Set; flushed in settleTurn).
    if (ev.type === 'tool_execution_start') {
      const p = readToolPath(ev);
      if (p) {
        if (!turn.memoryTainted && turn.privateRoots?.length && pathInsideAny(p, turn.privateRoots, this.options.workspaceRoot)) {
          turn.memoryTainted = true;
        }
        if (SKILL_CONSULT_TOOLS.has(String(ev.toolName ?? '').toLowerCase())) {
          const slug = skillSlugForPath(p, skillsRoot(), this.options.workspaceRoot);
          if (slug) (turn.skillsUsed ??= new Set()).add(slug);
        }
      }
    }
    const { events, done } = normalizePiEvent(ev, turn);
    const now = Date.now();
    if (events.length) {
      if (turn.firstActivityAt === undefined) turn.firstActivityAt = now;
      if (turn.firstTokenAt === undefined && events.some((e) => e.method === 'item/agentMessage/delta')) {
        turn.firstTokenAt = now;
      }
      this.advancePhase(turn, events, now);
    }
    for (const e of events) this.emitEvent(e.method, e.params);
    if (done) this.settleTurn(turn, now);
  }

  /** The turn's stream is over (its terminal event just went out): flush timing,
   * ride out tee-recovered sources, and drop per-turn state. The foreground gate
   * is deliberately NOT released here — pi may still be busy with post-run work
   * until agent_settled (see onPiEvent). */
  private settleTurn(turn: TurnContext, now: number): void {
    turn.endedAt = now;
    this.advancePhase(turn, [], now); // flush the trailing segment
    this.reportTurnTiming(turn);
    // Web sources recovered by the tee ride out at turn end (the assistant
    // bubble exists by now, so the renderer can attach them).
    if (turn.sources.length) {
      this.emitEvent('turn/sources', { threadId: turn.threadId, turnId: turn.turnId, sources: turn.sources });
    }
    // The assistant may have created/patched a skill via manage_skill this turn;
    // detect it (the bridge bumps the rev marker) and reload after agent_settled.
    if (this.readSkillsRev() !== this.skillsRevAtTurnStart) {
      this.pendingSkillReload = true;
      this.emitEvent('skills/changed');
    }
    // Flush this turn's skill consultations (once per skill per turn) to the
    // usage sidecar. Sidecar-only: refresh an open Skills tab, but no
    // pendingSkillReload — pi ignores non-skill files, nothing to reload.
    if (turn.skillsUsed?.size && recordUses([...turn.skillsUsed]) > 0) {
      this.emitEvent('skills/changed');
    }
    this.currentTurn = null;
    this.lastSettledTurn = { threadId: turn.threadId, turnId: turn.turnId };
    // Map this live turn's minted id to its persisted entry id so a later
    // fork/edit targets the right pi entry — and persist the turn's timing.
    void this.recordTurnEntry(turn);
    // Interactive overflow self-heal: a turn that died because the context
    // outgrew the model's window leaves a thread where EVERY next send would
    // overflow again (pi's own compact-and-retry has been seen to fail
    // silently, and Stem has no manual condense control). Condense in the
    // background so the user's next message starts from a shrunken thread.
    // Queued behind the foreground gate, so a send the user fires first still
    // serializes correctly; the condense surfaces via the settled-turn
    // compaction activity row. Scheduled runs are excluded — the scheduler owns
    // their condense-and-retry, and a second condense here would make its
    // compact call fail ("already compacted") and cancel the retry.
    if (turn.errored && !turn.isScheduled && isContextOverflowError(turn.errorMessage)) {
      log('pi', 'turn died on context overflow; condensing thread', { threadId: turn.threadId });
      void this.compactThread(turn.threadId).catch((error) =>
        log('pi', 'post-overflow condense failed', {
          threadId: turn.threadId,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  /**
   * Attribute the interval since the last event to the phase that was active, then
   * switch to the phase the new events represent. The first interval (promptSent →
   * first event) is skipped because phase starts 'pending' — that wait is TTFT, not
   * thinking. Approximate: a tool's idle gap until the next event counts as tool time.
   */
  private advancePhase(turn: TurnContext, events: NormalizedEvent[], now: number): void {
    if (turn.phase !== 'pending' && turn.lastEventAt !== undefined) {
      const dt = now - turn.lastEventAt;
      if (turn.phase === 'thinking') turn.thinkingMs += dt;
      else if (turn.phase === 'tool') turn.toolMs += dt;
      else if (turn.phase === 'answer') turn.answerMs += dt;
    }
    const next = phaseOfEvents(events);
    if (next) turn.phase = next;
    turn.lastEventAt = now;
  }

  /**
   * Log a one-line latency breakdown for a finished turn and emit it as a
   * `turn/timing` event. Splits the wall time into pre-send work (build/recall,
   * which is dead time the user waits through before any response) vs. the model's
   * own time-to-first-token and generation, so a slow turn can be attributed.
   */
  private reportTurnTiming(turn: TurnContext): void {
    const { startedAt, promptSentAt, firstActivityAt, firstTokenAt, endedAt } = turn;
    if (startedAt === undefined || endedAt === undefined) return;
    const ms = (a?: number, b?: number): number | null =>
      a === undefined || b === undefined ? null : Math.round(b - a);
    const r = turn.recall ?? {};
    const breakdown: TurnTimingBreakdown = {
      threadId: turn.threadId,
      turnId: turn.turnId,
      ensureMs: turn.ensureMs ?? 0,
      buildMs: turn.buildMs ?? null,
      recall: {
        total: r.total ?? null,
        facts: r.facts ?? null,
        embed: r.embed ?? null,
        rerank: r.rerank ?? null,
        search: r.search ?? null
      },
      thinkingMs: turn.thinkingMs,
      toolMs: turn.toolMs,
      answerMs: turn.answerMs,
      sendToFirstActivityMs: ms(promptSentAt, firstActivityAt),
      sendToFirstTokenMs: ms(promptSentAt, firstTokenAt),
      firstTokenToEndMs: ms(firstTokenAt, endedAt),
      totalMs: ms(startedAt, endedAt)
    };
    const fmt = (n: number | null): string => (n === null ? '—' : `${n}ms`);
    const recallStr =
      r.total === undefined
        ? ''
        : ` recall=${fmt(r.total ?? null)}[facts=${fmt(r.facts ?? null)} embed=${fmt(r.embed ?? null)}` +
          ` rerank=${fmt(r.rerank ?? null)} search=${fmt(r.search ?? null)}]`;
    console.log(
      `[turn timing] build=${fmt(breakdown.buildMs)}${recallStr} ` +
        `think=${fmt(breakdown.thinkingMs)} tools=${fmt(breakdown.toolMs)} answer=${fmt(breakdown.answerMs)} ` +
        `send→first=${fmt(breakdown.sendToFirstTokenMs)} ` +
        `first→end=${fmt(breakdown.firstTokenToEndMs)} total=${fmt(breakdown.totalMs)}` +
        (breakdown.ensureMs ? ` (ensure=${breakdown.ensureMs}ms)` : '')
    );
    // Stash for recordTurnEntry to persist once the assistant entry id resolves.
    turn.timing = breakdown;
    this.emitEvent('turn/timing', breakdown);
  }

  private async recordTurnEntry(turn: TurnContext): Promise<void> {
    try {
      if (!this.proc || this.activeThreadId !== turn.threadId) return;
      const fm = await this.proc.request({ type: 'get_fork_messages' });
      const entries = (fm.data as { messages?: { entryId: string }[] } | undefined)?.messages ?? [];
      const last = entries[entries.length - 1];
      if (!last) return;
      this.turnEntryIds.set(turn.turnId, last.entryId);
      // Persist timing keyed by the FINAL assistant entry id — readThread rebuilds
      // that same bubble from entry.id on reopen, so the lookup matches.
      const b = turn.timing;
      if (b) {
        upsertTurnTiming({
          turnEntryId: last.entryId,
          threadId: turn.threadId,
          totalMs: b.totalMs,
          thinkingMs: b.thinkingMs,
          toolMs: b.toolMs,
          answerMs: b.answerMs,
          ttftMs: b.sendToFirstTokenMs,
          buildMs: b.buildMs,
          recallMs: b.recall.total
        });
      }
      // Persist the turn's tool activity + web sources next to the timing (same
      // entry-id keying) so activity rows survive reopen.
      if (turn.activity.length || turn.sources.length) {
        upsertTurnActivity({
          turnEntryId: last.entryId,
          threadId: turn.threadId,
          payload: { activity: turn.activity, sources: turn.sources }
        });
      }
    } catch {
      // best-effort; rollback/fork will surface a clear error if unresolved
    }
  }

  /** Resolve a renderer turnId to a pi session entry id (identity for reloaded threads). */
  private resolveEntryId(turnId: string): string {
    return this.turnEntryIds.get(turnId) ?? turnId;
  }

  /** pi is idle again (agent_settled, or a prompt that never started): release the
   * send gate and apply any deferred bridge reload. Reloading here — after pi's
   * post-run continuations — means the restart can no longer kill an in-flight
   * auto-retry or auto-compaction. */
  private releaseForeground(): void {
    this.foreground.finishTurn();
    // An approved MCP add/remove, or a skill written this turn, takes effect by
    // reloading the bridge after the turn (restarting mid-turn would kill the
    // in-flight conversation, and deferring keeps the prompt cache valid).
    if (this.pendingMcpReload || this.pendingSkillReload) {
      this.pendingMcpReload = false;
      this.pendingSkillReload = false;
      void this.configMcpServerReload().catch(() => undefined);
    }
  }

  /** A turn that failed before pi accepted the prompt: no agent run started, so no
   * agent_settled will come — drop the turn AND release the gate right away. */
  private finishTurn(): void {
    this.currentTurn = null;
    this.releaseForeground();
  }

  /** Read the skills revision marker the bridge bumps on every skill write. */
  private readSkillsRev(): string {
    try {
      return readFileSync(join(skillsRoot(), SKILLS_REV_FILE), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Apply skill changes made out-of-band (the background curator writes SKILL.md
   * files directly). Reloads now when idle, or defers to turn end if a turn is
   * mid-flight. Also notifies the UI so the skills list refreshes.
   */
  async requestSkillReload(): Promise<void> {
    this.emitEvent('skills/changed');
    if (this.currentTurn) {
      this.pendingSkillReload = true;
      return;
    }
    await this.restart();
  }

  /**
   * The bridge asked (via a sentinel confirm) to apply an assistant-proposed MCP
   * add/remove. Hold the request open and surface it as Stem's McpApprovalCard;
   * resolveAdminApproval answers it once the user decides (or a timeout declines).
   */
  private handleAdminApproval(id: string, message: string | undefined): void {
    let proposal: { action?: string; name?: string; input?: McpServerInput } | null = null;
    try {
      proposal = JSON.parse(message ?? '{}');
    } catch {
      // malformed
    }
    if (!proposal || (proposal.action !== 'add' && proposal.action !== 'remove')) {
      this.proc?.send({ type: 'extension_ui_response', id, confirmed: false });
      return;
    }
    this.adminApprovals.add(id);
    const card: McpAdminProposal = {
      id,
      threadId: this.currentTurn?.threadId ?? '',
      action: proposal.action,
      input: proposal.input,
      name: proposal.name
    };
    // Keep the full mutation (including credentials) only in main-memory for the
    // accepted writer. Renderer approval cards need presence/keys, never values.
    const requestProcess = this.proc;
    this.adminApprovalProposals.set(id, { proposal: card, process: requestProcess });
    const displayInput = card.input
      ? {
          ...card.input,
          ...(card.input.oauthClientSecret ? { oauthClientSecret: '********' } : {}),
          ...(card.input.headers
            ? { headers: Object.fromEntries(Object.keys(card.input.headers).map((key) => [key, '********'])) }
            : {}),
          ...(card.input.env
            ? { env: Object.fromEntries(Object.keys(card.input.env).map((key) => [key, '********'])) }
            : {})
        }
      : undefined;
    this.emitEvent('mcp/admin/approvalRequest', { ...card, input: displayInput });
    setTimeout(() => {
      if (this.settleAdminApproval(id)) {
        requestProcess?.send({ type: 'extension_ui_response', id, confirmed: false });
      }
    }, 120_000);
  }

  /**
   * The bridge asked (via a sentinel confirm) to apply an assistant-proposed
   * custom-instructions change. Hold the request open and surface it as the
   * InstructionsApprovalCard; resolveInstructionsApproval answers once the user
   * decides (or a timeout declines). Main writes settings.json on accept.
   */
  private handleInstructionsApproval(id: string, message: string | undefined): void {
    let proposal: { action?: string; incomingText?: string; surface?: string } | null = null;
    try {
      proposal = JSON.parse(message ?? '{}');
    } catch {
      // malformed
    }
    const action = proposal?.action;
    if (action !== 'append' && action !== 'replace' && action !== 'clear') {
      this.proc?.send({ type: 'extension_ui_response', id, confirmed: false });
      return;
    }
    this.instructionsApprovals.add(id);
    const requestProcess = this.proc;
    this.instructionsApprovalProcesses.set(id, requestProcess);
    const card: InstructionsProposal = {
      id,
      threadId: this.currentTurn?.threadId ?? '',
      action,
      incomingText: typeof proposal?.incomingText === 'string' ? proposal.incomingText : '',
      suggestedSurface: proposal?.surface === 'quickChat' ? 'quickChat' : proposal?.surface === 'main' ? 'main' : undefined
    };
    this.emitEvent('instructions/approvalRequest', card);
    setTimeout(() => {
      if (this.settleInstructionsApproval(id)) {
        requestProcess?.send({ type: 'extension_ui_response', id, confirmed: false });
      }
    }, 120_000);
  }

  /** Start a fresh session on the foreground process; returns its sessionId. */
  private async newSession(): Promise<string> {
    const created = await this.proc!.request({ type: 'new_session' });
    if (!created.success) throw new Error(created.error ?? 'pi could not start a new chat.');
    // A fresh pi session resets the active model to the spawn default — invalidate the
    // mirrors so the next applyModel/setThinking re-issue their RPCs.
    this.currentModel = null;
    this.currentThinking = null;
    this.activeThreadId = null;
    const state = await this.proc!.request({ type: 'get_state' });
    if (!state.success) throw new Error(state.error ?? 'pi could not read the new chat state.');
    const id = this.recordState(state.data);
    if (!id) throw new Error('pi did not return a session id.');
    this.activeThreadId = id;
    return id;
  }

  /** Make `threadId` the active session, switching to its file if needed. */
  private async ensureActive(threadId: string): Promise<string> {
    if (this.activeThreadId === threadId) return threadId;
    const file = await this.resolveSessionFile(threadId);
    if (!file) {
      // Unknown/empty thread (e.g. pre-created, no messages yet): start fresh and
      // adopt the id the caller expects by treating the new session as active.
      const id = await this.newSession();
      return id;
    }
    const switched = await this.proc!.request({ type: 'switch_session', sessionPath: file });
    if (!switched.success) throw new Error(switched.error ?? `pi could not switch to chat "${threadId}".`);
    // The switch does NOT restore the session's persisted model/thinking: pi only
    // restores them when no CLI --model was given, and we always spawn with one, so
    // every rebuild resets to the spawn default. Invalidate the mirrors; callers
    // needing the thread's model must re-apply it (interactive turns pass
    // input.model, scheduled runs resolve threadTurnSettings in startTurn).
    this.currentModel = null;
    this.currentThinking = null;
    this.activeThreadId = threadId;
    return threadId;
  }

  /**
   * The model/effort the user last chose for a thread, read from its session file.
   * Model comes from model_change entries ONLY — assistant messages also persist a
   * model, but a past scheduled run that executed on the wrong model would poison
   * that signal, while model_change is only written by an explicit set_model.
   * Used by startTurn to pin scheduled runs and by the Tasks tab to show what a
   * task will run on. Also returns a rough context-size estimate (`contextTokens`)
   * for the scheduled pre-run compaction guard: the last settled assistant usage
   * (pi's own accounting basis) plus ~chars/4 for anything after it; a compaction
   * entry resets the usage anchor (pre-compaction usage no longer describes the
   * live context).
   */
  async threadTurnSettings(
    threadId: string
  ): Promise<{ model?: string; effort?: string; contextTokens?: number }> {
    const file = await this.resolveSessionFile(threadId);
    if (!file) return {};
    const text = await readFile(file, 'utf8').catch(() => '');
    let model: string | undefined;
    let effort: string | undefined;
    let usageTokens: number | undefined;
    let charsSinceUsage = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: {
        type?: string;
        provider?: string;
        modelId?: string;
        thinkingLevel?: string;
        message?: { role?: string; stopReason?: string; usage?: PiUsage };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === 'model_change' && entry.provider && entry.modelId) {
        model = `${entry.provider}/${entry.modelId}`;
      } else if (entry.type === 'thinking_level_change' && entry.thinkingLevel) {
        effort = entry.thinkingLevel;
      } else if (entry.type === 'compaction') {
        usageTokens = undefined;
        charsSinceUsage = line.length;
      } else if (entry.type === 'message' && entry.message) {
        charsSinceUsage += line.length;
        const m = entry.message;
        if (m.role === 'assistant' && m.stopReason !== 'error' && m.stopReason !== 'aborted' && m.usage) {
          const tokens =
            m.usage.totalTokens ||
            (m.usage.input ?? 0) + (m.usage.output ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
          if (tokens > 0) {
            usageTokens = tokens;
            charsSinceUsage = 0;
          }
        }
      }
    }
    const contextTokens = (usageTokens ?? 0) + Math.ceil(charsSinceUsage / 4);
    return { model, effort, ...(contextTokens > 0 ? { contextTokens } : {}) };
  }

  /**
   * Pre-run guard for autonomous turns. pi's threshold compaction uses ONE global
   * reserve (seeded in ensurePiSettingsDefaults) that cannot scale with the active
   * model's window, and inside a run context grows with no compaction opportunity —
   * a scheduled run on a small-window model can sail from "fine" to a provider
   * overflow with nobody watching. Before prompting, condense the thread when its
   * estimated context exceeds the active model's window minus a window-proportional
   * reserve (a quarter of the window, clamped to [16384, 65536]). Best-effort: a
   * failed condense must not stop the run.
   */
  private async maybeCompactBeforeScheduledRun(threadId: string, contextTokens?: number): Promise<void> {
    if (!contextTokens) return;
    const window = await this.activeModelContextWindow();
    const reserve = Math.max(16384, Math.min(65536, Math.floor(window / 4)));
    if (contextTokens <= window - reserve) return;
    log('pi', 'scheduled run: condensing thread before run', { threadId, contextTokens, window, reserve });
    const res = await this.proc!.request({ type: 'compact' });
    if (!res.success) log('pi', 'scheduled run: pre-run condense failed', { threadId, error: res.error });
  }

  /** The active model's context window per pi's catalog (pi's own default when unknown). */
  private async activeModelContextWindow(): Promise<number> {
    const current = this.currentModel ? this.parseModel(this.currentModel) : null;
    if (current) {
      const res = await this.proc!.request({ type: 'get_available_models' }).catch(() => null);
      const models = ((res?.data as { models?: PiModel[] } | undefined)?.models ?? []).filter(Boolean);
      const m = models.find((x) => x.provider === current.provider && x.id === current.modelId);
      if (typeof m?.contextWindow === 'number' && m.contextWindow > 0) return m.contextWindow;
    }
    return 128_000;
  }

  /**
   * Condense a thread's context via pi's manual compact. Used by the scheduler's
   * overflow self-heal: a run that died on a context-overflow error is retried
   * once after this succeeds. Serialized behind the foreground gate like a turn.
   */
  async compactThread(threadId: string): Promise<void> {
    return this.foreground.run(async () => {
      await this.ensureStarted();
      await this.ensureActive(threadId);
      const res = await this.proc!.request({ type: 'compact' });
      if (!res.success) throw new Error(res.error ?? 'pi could not condense the chat.');
    });
  }

  private async applyModel(model: string): Promise<void> {
    if (model === this.currentModel) return;
    const { provider, modelId } = this.parseModel(model);
    const res = await this.proc!.request({ type: 'set_model', provider, modelId });
    if (!res.success) throw new Error(res.error ?? `pi could not select model "${model}".`);
    this.currentModel = model;
  }

  private async setThinking(effort: string): Promise<void> {
    const level = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : 'medium';
    if (level === this.currentThinking) return;
    const res = await this.proc!.request({ type: 'set_thinking_level', level }).catch(() => null);
    if (res?.success) this.currentThinking = level;
  }

  private parseModel(model: string): { provider: string; modelId: string } {
    const i = model.indexOf('/');
    if (i === -1) return { provider: DEFAULT_PROVIDER, modelId: model };
    return { provider: model.slice(0, i), modelId: model.slice(i + 1) };
  }

  /**
   * The app-level default model: the persisted post-onboarding choice (matched to
   * the provider the user signed in with), else the built-in codex constant.
   * Validates that a stored model's provider is still available — a stale default
   * from a disconnected/removed provider would crash pi at startup.
   */
  private async resolveDefaultModel(): Promise<{ provider: string; modelId: string }> {
    try {
      const { defaults } = await readSettings();
      if (defaults.model) {
        const parsed = this.parseModel(defaults.model);
        const valid = await this.isProviderAvailable(parsed.provider);
        if (valid) return parsed;
      }
    } catch {
      // settings unreadable → constant
    }
    return { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL };
  }

  /** True when pi will recognise this provider (builtin or present in models.json). */
  private async isProviderAvailable(provider: string): Promise<boolean> {
    const builtins = new Set(['openai-codex', 'anthropic', 'openai', 'openrouter']);
    if (builtins.has(provider)) return true;
    try {
      const config = await readModelsConfig();
      return provider in config.providers;
    } catch {
      return false;
    }
  }

  /** Assemble the prompt: prepend recall/files/format context (pi has no per-turn context field). */
  private async buildMessage(
    input: StartTurnInput,
    threadId: string,
    recallTimings?: RecallTimings,
    turnId?: string
  ): Promise<{ message: string; images: PiImageContent[] }> {
    const blocks: string[] = [];
    // The user's standing custom instructions — an AUTHORITATIVE block, first and
    // distinct from recall (which is explicitly "not instructions"). Already resolved
    // per surface by the caller (main vs Quick Chat). Empty → no block.
    const standing = input.instructions?.trim();
    if (standing) {
      blocks.push(
        `Standing instructions from the user (high-priority directives — follow them in every reply; ` +
          `they override your default behavior for verbosity, output format, and component usage; only the ` +
          `user's current message and safety take precedence):\n${standing}`
      );
    }
    if (isRecallEnabled()) {
      const chosen: { facts: Fact[]; tier: FactTier } = { facts: [], tier: 'all' };
      const flags: { privateDocsInjected?: boolean } = {};
      const injectedDocs: InjectedDocRef[] = [];
      const recall = await buildRecallContext(input.input, {
        currentThreadId: threadId,
        timings: recallTimings,
        chosen,
        flags,
        injectedDocs
      });
      if (recall) blocks.push(recall);
      // Documents from a memorize:false folder were injected: taint the turn the
      // same way reading such a folder does, so the reply stays out of Recall.
      if (flags.privateDocsInjected && this.currentTurn?.threadId === threadId) {
        this.currentTurn.memoryTainted = true;
      }
      // Record what was injected so the Memory UI can show this chat's active facts.
      try {
        setActiveFacts(
          threadId,
          chosen.facts.map((f) => ({ id: f.id, reason: f.selectionReason })),
          chosen.tier
        );
        // Also log this turn's injected set for the distill pass to grade
        // ("which of these facts did the reply actually use?") — the feedback
        // signal behind usage-aware fact ranking. The captured user/assistant
        // messages carry the same turnId, which is the join key.
        if (turnId && chosen.facts.length > 0) {
          recordTurnInjectedFacts(threadId, turnId, chosen.facts.map((f) => f.id));
        }
        // Same log for learn-eligible folder-doc excerpts (learn-on-use): the
        // distill pass folds them into its transcript as citable evidence.
        if (turnId && injectedDocs.length > 0) {
          recordTurnInjectedDocs(threadId, turnId, injectedDocs);
        }
      } catch {
        // Debug surface only — never let it break a turn.
      }
    }
    const files = await buildFilesContext();
    if (files) blocks.push(files);
    const connected = await buildConnectedFoldersContext();
    if (connected) blocks.push(connected);
    // Cheap names+signatures catalog of routed MCP tools (schemas fetched on demand
    // via describe_tool). Keeps the prompt floor flat as more servers are added.
    const catalog = buildMcpCatalogContext();
    if (catalog) blocks.push(catalog);
    // Right after the catalog, and gated the same way as the tools themselves: the
    // MCP list can run to hundreds of entries (browser automation among them), and
    // without this the search tools are the only capability the model can't see
    // from here. Mirrors the gate written above for this turn.
    const web = buildWebSearchContext(input.webSearch ?? true);
    if (web) blocks.push(web);
    if (input.format === 'md') blocks.push(PLAIN_MD_DIRECTIVE);

    // Images go to pi natively; text-like files are inlined, binaries noted and dropped.
    const { images, textBlocks, rejected } = await resolveAttachments(input.attachments ?? []);

    // The user's text comes last; context blocks precede it across a `---` rule, while
    // inlined files and skip notes attach to the user turn just after their message.
    const tail: string[] = [];
    if (textBlocks.length) tail.push(textBlocks.join('\n\n'));
    if (rejected.length) tail.push(`(Skipped unsupported attachment: ${rejected.join(', ')})`);
    const userText = tail.length ? `${input.input}\n\n${tail.join('\n\n')}` : input.input;

    // Fence the injected context so replay can strip it (see CONTEXT_* above): the
    // model still sees it inline, but the stored user bubble renders only userText.
    const body = blocks.length
      ? `${CONTEXT_OPEN}\n${blocks.join('\n\n')}\n\n---\n${CONTEXT_CLOSE}\n\n${userText}`
      : userText;
    // A scheduled run prepends its fenced preamble (before the context fence) so the
    // model knows it's running headless and the persisted message carries the marker.
    const message = input.scheduled ? `${scheduledPreamble(input.scheduled.at)}\n\n${body}` : body;
    return { message, images };
  }

  private recordState(data: unknown): string | null {
    const s = data as { sessionId?: string; sessionFile?: string } | undefined;
    const id = s?.sessionId ?? null;
    if (id && s?.sessionFile) this.sessionFiles.set(id, s.sessionFile);
    if (id) this.activeThreadId = this.activeThreadId ?? id;
    return id;
  }

  private async resolveSessionFile(threadId: string): Promise<string | null> {
    const cached = this.sessionFiles.get(threadId);
    if (cached && (await this.fileExists(cached))) return cached;
    const files = await this.scanSessions();
    for (const f of files) this.sessionFiles.set(f.id, f.path);
    return this.sessionFiles.get(threadId) ?? null;
  }

  /** Walk the session dir and read each JSONL header + name for the chat list. */
  private async scanSessions(): Promise<SessionFile[]> {
    const seen = new Set<string>();
    const walk = async (dir: string): Promise<SessionFile[]> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const results = await Promise.all(
        entries.map(async (entry): Promise<SessionFile[]> => {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) return walk(full);
          if (!entry.name.endsWith('.jsonl')) return [];
          seen.add(full);
          // stat first (cheap); reuse cached metadata when the file is unchanged.
          let mtimeMs: number | null = null;
          try {
            mtimeMs = Math.floor((await stat(full)).mtimeMs);
          } catch {
            return [];
          }
          const cached = this.metaCache.get(full);
          if (cached && cached.mtimeMs === mtimeMs) return [cached.meta];
          const meta = await this.readSessionMeta(full, mtimeMs);
          if (!meta) return [];
          this.metaCache.set(full, { mtimeMs, meta });
          return [meta];
        })
      );
      return results.flat();
    };
    const out = await walk(this.options.sessionsDir);
    // Drop cache entries for files that disappeared (deleted/moved threads).
    for (const path of this.metaCache.keys()) if (!seen.has(path)) this.metaCache.delete(path);
    return out;
  }

  private async readSessionMeta(path: string, mtimeMs: number): Promise<SessionFile | null> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    const lines = text.split('\n').filter((l) => l.trim());
    if (!lines.length) return null;
    let id = '';
    let cwd: string | null = null;
    let createdAt = 0;
    let name: string | null = null;
    try {
      const header = JSON.parse(lines[0]) as { id?: string; cwd?: string; timestamp?: string };
      id = header.id ?? '';
      cwd = header.cwd ?? null;
      createdAt = header.timestamp ? Date.parse(header.timestamp) || 0 : 0;
    } catch {
      return null;
    }
    if (!id) return null;
    // Latest session_info name wins (mirrors pi's getSessionName).
    for (const line of lines) {
      if (!line.includes('"session_info"')) continue;
      try {
        const e = JSON.parse(line) as { type?: string; name?: string };
        if (e.type === 'session_info' && typeof e.name === 'string') name = e.name;
      } catch {
        // ignore
      }
    }
    return { id, path, name, cwd, createdAt: Math.floor(createdAt), updatedAt: mtimeMs };
  }

  /** Read the live foreground session's messages (for active sessions without a file yet). */
  private async readActiveMessages(): Promise<{ title: string; messages: ChatMessage[] }> {
    const res = await this.proc!.request({ type: 'get_messages' });
    const raw =
      (res.data as { messages?: { role?: string; content?: unknown; provider?: string; model?: string }[] } | undefined)
        ?.messages ?? [];
    const messages: ChatMessage[] = [];
    for (const m of raw) {
      const { text: content, images, scheduled } = this.contentToParts(m.content);
      if (!content.trim() && !images.length) continue;
      if (m.role === 'user')
        messages.push({
          id: `user-${messages.length}`,
          role: 'user',
          content,
          ...(images.length ? { attachments: images } : {}),
          ...(scheduled ? { scheduled } : {})
        });
      else if (m.role === 'assistant') {
        // Same hover label as readThread: pi's message objects carry provider+model;
        // effort mirrors the live session's current thinking level (no per-message
        // record here, but this path only serves the just-created active session).
        const model = m.provider && m.model ? `${m.provider}/${m.model}` : undefined;
        const meta: MessageMeta | undefined =
          model || this.currentThinking
            ? { ...(model ? { model } : {}), ...(this.currentThinking ? { effort: this.currentThinking } : {}) }
            : undefined;
        messages.push({
          id: `assistant-${messages.length}`,
          role: 'assistant',
          content,
          ...(meta ? { meta } : {})
        });
      }
    }
    const state = await this.proc!.request({ type: 'get_state' });
    const title = ((state.data as { sessionName?: string } | undefined)?.sessionName || 'New chat').trim() || 'New chat';
    return { title, messages };
  }

  /** Parse a JSONL session line's entry id (null if not a tree entry). */
  private entryIdOf(line: string): string | null {
    try {
      return (JSON.parse(line) as { id?: string }).id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Split a persisted message `content` into rendered text and image attachments. pi
   * stores images as `{type:'image', data, mimeType}` blocks alongside text blocks, so
   * replay rebuilds thumbnails straight from the session JSONL.
   */
  private contentToParts(content: unknown): {
    text: string;
    images: MessageAttachment[];
    scheduled?: { at: string };
  } {
    if (typeof content === 'string') return this.stripMarkers(content, []);
    if (!Array.isArray(content)) return { text: '', images: [] };
    const texts: string[] = [];
    const images: MessageAttachment[] = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const part = c as { type?: string; text?: string; data?: string; mimeType?: string };
      if (part.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text);
      } else if (part.type === 'image' && typeof part.data === 'string') {
        const mime = part.mimeType || 'image/png';
        images.push({ kind: 'image', mime, dataUrl: `data:${mime};base64,${part.data}` });
      }
    }
    return this.stripMarkers(texts.join(''), images);
  }

  /**
   * Strip the fenced scheduled-run preamble and recall/files/format context we
   * prepended at send time so the replayed user bubble shows only what was actually
   * asked. The scheduled fence also flags the turn (with its timestamp) so the UI
   * renders it collapsed. No-op on turns with no injection and on assistant messages.
   * Also drops leaked web-search citation markers (see shared/citations.ts) — the
   * session JSONL stores them verbatim, so history reads clean them retroactively.
   */
  private stripMarkers(raw: string, images: MessageAttachment[]): {
    text: string;
    images: MessageAttachment[];
    scheduled?: { at: string };
  } {
    const sched = raw.match(SCHED_STRIP_RE);
    const text = stripCiteMarkers(raw.replace(SCHED_STRIP_RE, '').replace(CONTEXT_STRIP_RE, ''));
    return sched ? { text, images, scheduled: { at: sched[1] } } : { text, images };
  }

  // Last local-provider catalog sync (models.json); throttles listModels re-probes.
  private lastLocalSyncAt = 0;

  /**
   * Keep the local-provider catalog fresh: re-probe enabled Ollama/LM Studio
   * servers at most every 30s so newly pulled models appear without an app
   * restart. (A provider whose model ids were typed by hand isn't probed — see
   * syncModelsConfig.) pi's RPC mode loads models.json once at spawn, so a change
   * needs a process restart — done only when no turn is streaming; otherwise the
   * next sync (or any restart) catches up.
   */
  private async maybeRefreshLocalModels(): Promise<void> {
    if (Date.now() - this.lastLocalSyncAt < 30_000) return;
    this.lastLocalSyncAt = Date.now();
    try {
      const { localProviders } = await readSettings();
      if (!Object.values(localProviders).some((p) => p.enabled)) return;
      const changed = await syncModelsConfig();
      if (changed && this.proc?.running && !this.currentTurn) await this.restart();
    } catch {
      // non-fatal: the model list just stays as pi last loaded it
    }
  }

  /** Providers Stem has credentials for (from the isolated auth.json + xAI store). */
  private async authProviders(): Promise<Set<string>> {
    const providers = new Set<string>();
    try {
      const raw = await readFile(join(this.options.piHome, 'auth.json'), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const apiKeyProviders = new Set<string>([...API_KEY_PROVIDER_IDS, ...LOCAL_PROVIDER_IDS]);
        const oauthProviders = new Set<string>(AUTH_PROVIDER_IDS);
        for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const credential = value as {
            type?: unknown;
            key?: unknown;
            access?: unknown;
            refresh?: unknown;
            expires?: unknown;
          };
          const hasApiKey =
            apiKeyProviders.has(provider) &&
            credential.type === 'api_key' &&
            typeof credential.key === 'string' &&
            credential.key.trim().length > 0;
          const accessUsable = typeof credential.access === 'string' && credential.access.trim().length > 0;
          const refreshUsable = typeof credential.refresh === 'string' && credential.refresh.trim().length > 0;
          const expiry = typeof credential.expires === 'number' && Number.isFinite(credential.expires)
            ? credential.expires
            : null;
          const hasOAuth =
            oauthProviders.has(provider) &&
            credential.type === 'oauth' &&
            accessUsable &&
            typeof credential.refresh === 'string' &&
            expiry !== null &&
            (expiry > Date.now() || refreshUsable);
          if (hasApiKey || hasOAuth) providers.add(provider);
        }
      }
    } catch {
      // auth.json missing or corrupt — fall through
    }
    // xAI credentials live in a separate store (not pi's auth.json).
    try {
      const { readXaiToken } = await import('./xai-oauth');
      const xaiToken = await readXaiToken();
      if (xaiToken?.accessToken) providers.add('xai');
    } catch {
      // non-fatal
    }
    return providers;
  }

  /**
   * Ensure the isolated pi home exists and is authenticated. Seeds auth.json from
   * the user's global ~/.pi/agent the first time so the backend works without a
   * separate login, while keeping skills/config/sessions sandboxed under piHome.
   */
  private async ensurePiHome(): Promise<void> {
    await mkdir(this.options.piHome, { recursive: true });
    await mkdir(this.options.sessionsDir, { recursive: true });
    await mkdir(join(this.options.workspaceRoot, '.stem-internal'), { recursive: true });
    const dest = join(this.options.piHome, 'auth.json');
    if (this.options.seedGlobalAuth !== false && !(await this.fileExists(dest))) {
      const src = join(homedir(), '.pi', 'agent', 'auth.json');
      if (await this.fileExists(src)) await copyFile(src, dest).catch(() => undefined);
    }
    // Ensure mcp.json (with the reserved stem-recall entry) for the bridge extension.
    await ensureMcpConfig().catch(() => undefined);
    // Stamp pre-identity-migration OAuth tokens before the bridge reads them, or
    // every previously-signed-in remote server connects unauthenticated (401).
    await migrateLegacyOAuthTokens().catch(() => undefined);
    // Prefer pi's SSE transport over its default WebSocket-first "auto", and give
    // auto-compaction enough headroom for Stem's heavy turns.
    await this.ensurePiSettingsDefaults().catch(() => undefined);
  }

  /**
   * Seed defaults into pi's settings.json (read once at spawn — see the pi RPC
   * no-hot-reload note). Each key is only seeded when unset — an explicit value in
   * the file wins — and hand-authored settings are never clobbered.
   *
   * `transport: "sse"`: pi's codex/ChatGPT transport is WebSocket-first, but a
   * WebSocket that drops MID-stream cannot be retried (replaying would re-run
   * tools it already executed — openai-codex-responses throws once websocketStarted),
   * so a transient disconnect hard-fails the whole turn even though its side effects
   * (e.g. a scheduled reminder) already committed. The SSE fetch path instead retries
   * transient errors with backoff and is sturdier through network filters (Little
   * Snitch).
   *
   * `compaction.reserveTokens`: pi's default reserve (16384) only leaves that much
   * room between the compaction threshold and the model's context window, and the
   * threshold is only checked between prompts/runs — a single agent run's tool
   * results land unchecked. Stem's turns routinely add far more than 16k tokens in
   * one run (each prompt carries ~38k chars of recall/instructions injection, and
   * one MCP result can be 100k+ chars), which is how a gpt-5.6-sol session went
   * from 327k straight past its 372k window and got a provider overflow error.
   * 64k of reserve makes compaction fire a turn earlier instead. This reserve is
   * GLOBAL (pi cannot scale it per model), so small-window models get a
   * window-proportional guard elsewhere: scheduled runs pre-condense via
   * maybeCompactBeforeScheduledRun, and the scheduler compact-and-retries a run
   * that still dies on a provider overflow (see TaskScheduler.runTask).
   */
  /**
   * Locate the vendored pi-web-access entry point once per process, warning if the
   * installed version drifted from the one this integration was written against
   * (mirroring locate.ts's pi version tripwire — Stem depends on the shape of the
   * package's tool names and result text, neither of which is a stable API).
   * Returns null when the dependency is absent, which downgrades to "no search"
   * rather than "no backend".
   */
  private async resolveWebAccessExtension(): Promise<string | null> {
    if (this.webAccessPath !== undefined) return this.webAccessPath;
    const path = await piWebAccessPath();
    if (!path) {
      log('pi', 'pi-web-access not found — web search tools will be unavailable');
    } else {
      const version = await webAccessVersion();
      if (version && version !== TESTED_WEB_ACCESS_VERSION) {
        log('pi', `pi-web-access ${version} differs from the tested ${TESTED_WEB_ACCESS_VERSION}`);
      }
    }
    return (this.webAccessPath = path);
  }

  private async ensurePiSettingsDefaults(): Promise<void> {
    const file = join(this.options.piHome, 'settings.json');
    let raw: string | null = null;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      raw = null; // absent — we create it
    }
    let settings: Record<string, unknown>;
    if (raw === null) {
      settings = {};
    } else {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return; // unexpected shape — leave it
        settings = parsed as Record<string, unknown>;
      } catch {
        return; // present but malformed — never destroy hand-authored content
      }
    }
    let changed = false;
    if (!('transport' in settings)) {
      settings.transport = 'sse';
      changed = true;
    }
    if (!('compaction' in settings)) {
      settings.compaction = { reserveTokens: 65536 };
      changed = true;
    }
    if (changed) await writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Diagnostics-only: how to reach this exact pi + home from a terminal. */
  private loginCommand(pi: PiInvocation): string {
    const extra = pi.env.ELECTRON_RUN_AS_NODE ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
    const argv = [pi.command, ...pi.prefixArgs].map((a) => `"${a}"`).join(' ');
    return `env PI_CODING_AGENT_DIR="${this.options.piHome}" ${extra}${argv}`;
  }

  private sanitizedEnv(pi?: PiInvocation): NodeJS.ProcessEnv {
    const env = { ...process.env, ...(pi?.env ?? {}) };
    env.PI_CODING_AGENT_DIR = this.options.piHome;
    env.PI_CODING_AGENT_SESSION_DIR = this.options.sessionsDir;
    env.PI_SKIP_VERSION_CHECK = '1';
    // Tell the bridge extension where Stem's MCP config lives.
    env[ENV_MCP_CONFIG] = piMcpConfigPath();
    env[ENV_MCP_OAUTH] = piMcpOAuthPath();
    // The bridge decrypts/re-encrypts MCP secrets with the same key main uses
    // (safeStorage is main-process-only). Unset in plaintext mode.
    const secretKey = secretKeyHex();
    if (secretKey) env[ENV_SECRET_KEY] = secretKey;
    // Tell the bridge extension where the assistant's self-authored skills live.
    env[ENV_SKILLS_DIR] = skillsRoot();
    return env;
  }
}
