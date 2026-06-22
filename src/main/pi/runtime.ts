import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  BackendEventEnvelope,
  ChatMessage,
  ChatSummary,
  McpAdminProposal,
  McpLoginResult,
  McpServerInput,
  MessageAttachment,
  ModelSummary,
  RuntimeStatus,
  StartTurnInput,
  StartTurnResult
} from '../../shared/types';
import { PLAIN_MD_DIRECTIVE, STEM_ASSISTANT_INSTRUCTIONS } from '../workspace/bootstrap';
import { captureMemoryFromUserInput, isRecallEnabled } from '../workspace/memory';
import { buildRecallContext } from '../recall/inject';
import { buildFilesContext } from '../files/inject';
import { resolveAttachments, type PiImageContent } from './attachments';
import { captureUserMessage } from '../recall/capture';
import type { ChatBackend } from '../backend/types';
import {
  ensureMcpConfig,
  piExtensionPath,
  piMcpStatusPath,
  readMcpConfig,
  saveOAuthToken,
  writeNativeSearchGate
} from './mcp-config';
import { authorizeMcp } from './oauth';
import { piMcpConfigPath } from '../workspace/paths';
import { findPiPath } from './locate';
import { PiProcess, type PiEvent } from './rpc';
import { newTurnContext, normalizePiEvent, type TurnContext } from './normalize';

// Default provider/model. openai-codex is the user's working ChatGPT subscription
// (verified streaming in the Phase-0 spike); Anthropic/Claude Max is selectable
// but currently gated behind claude.ai "extra usage". gpt-5.3-codex-spark is the
// exact model the spike streamed successfully.
const DEFAULT_PROVIDER = 'openai-codex';
const DEFAULT_MODEL = 'gpt-5.3-codex-spark';

// Providers that serve a native (server-side) web-search tool, which the bridge
// extension injects via before_provider_request. Add 'anthropic' once Claude-via-pi
// is ungated and its injection branch is enabled.
const PROVIDER_NATIVE_SEARCH = new Set(['openai-codex']);
// Friendly provider names for the UI (provider picker, web-search toggle).
const PROVIDER_NAMES: Record<string, string> = { 'openai-codex': 'ChatGPT', anthropic: 'Claude' };
const providerName = (p: string): string => PROVIDER_NAMES[p] ?? p;

// Sentinel title the bridge uses for an MCP add/remove approval (see
// stem-mcp-extension.mjs). The message is a JSON McpAdminProposal payload.
const ADMIN_APPROVAL_TITLE = 'stem-admin-approval';

// pi has no per-turn context channel, so recall/files/format context is prepended
// into the user's prompt message — which pi then PERSISTS in the session JSONL. To
// keep that injected scaffolding out of the replayed user bubble (it was showing up
// as "a lot of information before the first question" when reopening a Quick Chat
// thread in the main window), wrap it in HTML-comment sentinels and strip it on
// read. The markers are inert to the model and never occur in real user text.
const CONTEXT_OPEN = '<!--stem:context-->';
const CONTEXT_CLOSE = '<!--/stem:context-->';
const CONTEXT_STRIP_RE = /^<!--stem:context-->[\s\S]*?<!--\/stem:context-->\n+/;

// Max length for an auto-derived chat title; longer first messages are
// truncated (the sidebar ellipsizes anyway).
const MAX_AUTO_TITLE = 80;

/** Derive a chat title from the first user message: its first non-empty line, trimmed and capped. */
function titleFromInput(input: string): string {
  const line = input.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > MAX_AUTO_TITLE ? `${line.slice(0, MAX_AUTO_TITLE - 1).trimEnd()}…` : line;
}

interface RuntimeOptions {
  piHome: string;
  sessionsDir: string;
  workspaceRoot: string;
}

interface PiModel {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  /**
   * Per-model thinking-level capability/override map from pi. A key present with a
   * non-null value means that level is supported (pi maps it to the provider value
   * internally); a key mapped to null means that level is NOT available. Levels not
   * mentioned keep the reasoning-model default. Absent/null => defaults only.
   */
  thinkingLevelMap?: Record<string, string | null> | null;
}

// The effort levels the UI can display, lowest→highest. We deliberately stick to these
// four; pi also has 'off'/'minimal' but Stem doesn't surface them.
const DISPLAY_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
// Levels every reasoning model is assumed to support unless its thinkingLevelMap opts out.
const BASE_EFFORTS = new Set(['low', 'medium', 'high']);

/** Resolve which display efforts a model supports from pi's thinkingLevelMap. */
function effortsFor(m: PiModel): string[] {
  if (!m.reasoning) return [];
  const map = m.thinkingLevelMap ?? {};
  return DISPLAY_EFFORTS.filter((lvl) => (lvl in map ? map[lvl] !== null : BASE_EFFORTS.has(lvl)));
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
  private activeThreadId: string | null = null;
  /**
   * The model of the CURRENTLY active pi session, mirrored so `applyModel` can skip a
   * redundant `set_model` within one session. pi resolves the model per session — a new
   * session resets to the spawn default, switching/forking/rolling back loads that
   * session's own persisted model — so this MUST be invalidated (set null) on every
   * session change, or the next `applyModel` wrongly no-ops and the turn runs on the
   * wrong model (e.g. a vision request silently downgraded to text-only Spark).
   */
  private currentModel: string | null = null;
  /** sessionId → on-disk session file, learned from get_state / dir scans. */
  private sessionFiles = new Map<string, string>();
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
  private activeTurnDone: Promise<void> | null = null;
  private resolveActiveTurn: (() => void) | null = null;
  /** Pending stem-admin approvals, keyed by the bridge's extension_ui_request id. */
  private adminApprovals = new Set<string>();
  /** Set when an admin add/remove was approved; reloads MCP servers at turn end. */
  private pendingMcpReload = false;

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
    const piPath = await findPiPath();
    if (!piPath) return { ...base, error: 'pi was not found on PATH.' };
    base.backendPath = piPath;

    await this.ensurePiHome();
    const authed = await this.fileExists(join(this.options.piHome, 'auth.json'));
    if (!authed) {
      return {
        ...base,
        authenticated: false,
        loginCommand: this.loginCommand(piPath),
        error: 'Stem is not signed in to pi. Run the login command, then retry.'
      };
    }
    return { ...base, ok: true, authenticated: true, loginCommand: this.loginCommand(piPath) };
  }

  async login(): Promise<RuntimeStatus> {
    // pi has no headless `login` subcommand; auth happens in its TUI (`/login`).
    // We seed the isolated home from the user's existing ~/.pi auth when present;
    // otherwise status() surfaces the copy-pasteable command for the TUI flow.
    await this.ensurePiHome();
    return this.status();
  }

  async restart(): Promise<void> {
    await this.shutdown();
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
    this.resolveActiveTurn?.();
    this.resolveActiveTurn = null;
    this.activeTurnDone = null;
    if (proc) await proc.dispose();
  }

  // ---- turns ----

  async createThread(model?: string): Promise<string> {
    await this.ensureStarted();
    // Create the session FIRST: newSession resets the active model, so applying the
    // model before it would be undone. Apply after so the pre-created session is on it.
    const id = await this.newSession();
    if (model) await this.applyModel(model);
    this.unnamedThreads.add(id);
    return id;
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const memory = await captureMemoryFromUserInput(input.input);
    if (memory.shouldAcknowledge) {
      return { handled: true, assistantMessage: "I'll remember that.", rememberedPath: memory.path };
    }

    await this.ensureStarted();
    // Serialize: a single pi process streams one turn at a time, so wait for any
    // in-flight turn to finish before we touch the active session.
    if (this.activeTurnDone) await this.activeTurnDone;

    // First turn of a new chat — either a draft started here (no threadId) or a
    // session pre-created via createThread (Quick Chat) that hasn't been prompted.
    const isNewThread = !input.threadId || this.unnamedThreads.has(input.threadId);
    const threadId = input.threadId ? await this.ensureActive(input.threadId) : await this.newSession();
    if (input.model) await this.applyModel(input.model);
    if (input.effort) await this.setThinking(input.effort);

    const turnId = randomUUID();
    this.currentTurn = newTurnContext(threadId, turnId);
    this.activeTurnDone = new Promise<void>((resolve) => (this.resolveActiveTurn = resolve));

    // Gate native web search for THIS turn (main vs Quick Chat share one process,
    // so the bridge can't tell them apart — we set the gate just before the prompt).
    await writeNativeSearchGate(input.webSearch ?? true).catch(() => undefined);

    const { message, images } = await this.buildMessage(input, threadId);
    const res = await this.proc!.request({
      type: 'prompt',
      message,
      images: images.length ? images : undefined
    });
    if (!res.success) {
      this.finishTurn();
      throw new Error(res.error ?? 'pi rejected the prompt.');
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
      captureUserMessage({ threadId, turnId, text: input.input, cwd: this.options.workspaceRoot });
    }
    return { threadId, turnId };
  }

  async interruptTurn(_turnId: string): Promise<void> {
    if (!this.proc) return;
    if (this.currentTurn) this.currentTurn.aborted = true;
    this.proc.send({ type: 'abort' });
  }

  async listModels(): Promise<ModelSummary[]> {
    await this.ensureStarted();
    const res = await this.proc!.request({ type: 'get_available_models' });
    const models = ((res.data as { models?: PiModel[] } | undefined)?.models ?? []).filter(Boolean);
    const providers = await this.authProviders();
    const visible = providers.size ? models.filter((m) => providers.has(m.provider)) : models;
    return visible.map((m) => {
      const id = `${m.provider}/${m.id}`;
      const efforts = effortsFor(m);
      return {
        id,
        displayName: m.name ?? m.id,
        description: m.provider,
        provider: m.provider,
        providerName: providerName(m.provider),
        supportsNativeWebSearch: PROVIDER_NATIVE_SEARCH.has(m.provider),
        supportedEfforts: efforts,
        defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0] ?? 'medium',
        serviceTiers: [],
        isDefault: m.provider === DEFAULT_PROVIDER && m.id === DEFAULT_MODEL
      };
    });
  }

  isInternalThread(_threadId: string): boolean {
    // complete() runs in a separate ephemeral process, so the foreground stream
    // never carries internal threads — nothing to suppress.
    return false;
  }

  /**
   * One-shot prompt → completion in a throwaway `--no-session` pi process. Backs
   * the LlmClient seam (Stem Recall distillation); isolated from the user's
   * active chat so it can't clobber the foreground session.
   */
  async complete(prompt: string, timeoutMs = 120_000): Promise<string> {
    const piPath = await findPiPath();
    if (!piPath) throw new Error('pi was not found on PATH.');
    await this.ensurePiHome();
    const child = new PiProcess({
      piPath,
      cwd: join(this.options.workspaceRoot, '.stem-internal'),
      env: this.sanitizedEnv(),
      args: [
        '--no-session',
        '--no-builtin-tools',
        '--no-skills',
        '--provider',
        DEFAULT_PROVIDER,
        '--model',
        DEFAULT_MODEL,
        '--system-prompt',
        'You are a precise extraction engine. Follow the instructions exactly and output only what is requested.'
      ]
    });

    let text = '';
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
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
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: {
        type?: string;
        id?: string;
        name?: string;
        message?: { role?: string; content?: unknown };
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
      if (entry.type !== 'message' || !entry.message) continue;
      const role = entry.message.role;
      const { text: content, images } = this.contentToParts(entry.message.content);
      if (role === 'user') {
        lastUserId = entry.id ?? lastUserId;
        if (content.trim() || images.length)
          messages.push({
            id: `user-${entry.id}`,
            role: 'user',
            content,
            turnId: entry.id,
            ...(images.length ? { attachments: images } : {})
          });
      } else if (role === 'assistant') {
        if (content.trim())
          messages.push({ id: `assistant-${entry.id}`, role: 'assistant', content, turnId: lastUserId || entry.id });
      }
    }
    return { title, messages };
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ensureStarted();
    await this.ensureActive(threadId);
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.ensureStarted();
    await this.ensureActive(threadId);
    await this.proc!.request({ type: 'set_session_name', name });
  }

  async deleteThread(threadId: string): Promise<void> {
    const file = await this.resolveSessionFile(threadId);
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
      if (this.proc) await this.proc.request({ type: 'new_session' }).catch(() => undefined);
    }
    this.sessionFiles.delete(threadId);
    this.unnamedThreads.delete(threadId);
    if (file) await unlink(file).catch(() => undefined);
  }

  /**
   * In-place retry/edit: drop the chosen turn and everything after it, keeping the
   * SAME thread id. pi has no rollback RPC, but its sessions are append-only JSONL
   * trees — so we park the process off the file, truncate it at the turn's entry,
   * and `switch_session` back to force a reload at the trimmed leaf (verified
   * id-stable). The renderer then re-sends the prompt as a fresh turn.
   */
  async rollbackToTurn(threadId: string, turnId: string): Promise<void> {
    await this.ensureStarted();
    const file = await this.resolveSessionFile(threadId);
    if (!file) throw new Error('This chat has no saved history to edit yet.');
    const entryId = this.resolveEntryId(turnId);
    const raw = await readFile(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const idx = lines.findIndex((l) => this.entryIdOf(l) === entryId);
    if (idx <= 0) throw new Error('Could not locate that message to edit. Reopen the chat and try again.');
    // Park the foreground off this file so the reload reads our truncated copy.
    await this.proc!.request({ type: 'new_session' }).catch(() => undefined);
    await writeFile(file, lines.slice(0, idx).join('\n') + '\n');
    await this.proc!.request({ type: 'switch_session', sessionPath: file });
    // Both RPCs above swap the active session's model out from under us.
    this.currentModel = null;
    this.activeThreadId = threadId;
  }

  /**
   * Branch the conversation into a NEW chat via pi's native `fork`. Forking from
   * the next user message keeps everything up to and including the chosen turn;
   * for the last turn, fork at it (re-ask). Returns the new session id; the new
   * session is active and read live until its file is written on first append.
   */
  async forkThread(threadId: string, turnId: string): Promise<{ threadId: string }> {
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
    // The fork becomes the active session — invalidate the model mirror.
    this.currentModel = null;
    this.activeThreadId = newId;
    return { threadId: newId };
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
      const token = await authorizeMcp(server.url, {
        onAuthUrl: (url) => this.emitEvent('mcp/login/url', { name, url })
      });
      await saveOAuthToken(name, token);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
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

  resolveAdminApproval(id: number | string, accept: boolean): void {
    const key = String(id);
    if (!this.adminApprovals.has(key)) return;
    this.adminApprovals.delete(key);
    this.proc?.send({ type: 'extension_ui_response', id: key, confirmed: accept });
    // The bridge writes mcp.json on approval; reload at turn end to connect it.
    if (accept) this.pendingMcpReload = true;
  }

  async configMcpServerReload(): Promise<void> {
    await this.restart();
  }

  // ---- internals ----

  private emitEvent(method: string, params?: unknown): void {
    const event: BackendEventEnvelope = { method, params, receivedAt: new Date().toISOString() };
    this.emit('event', event);
  }

  private ensureStarted(): Promise<void> {
    if (this.proc && this.proc.running) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const piPath = await findPiPath();
    if (!piPath) throw new Error('pi was not found on PATH.');
    await this.ensurePiHome();

    const proc = new PiProcess({
      piPath,
      cwd: this.options.workspaceRoot,
      env: this.sanitizedEnv(),
      args: [
        '--no-builtin-tools',
        '-e',
        piExtensionPath(),
        '--provider',
        DEFAULT_PROVIDER,
        '--model',
        DEFAULT_MODEL,
        '--append-system-prompt',
        STEM_ASSISTANT_INSTRUCTIONS
      ]
    });
    this.proc = proc;
    this.currentModel = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;

    proc.on('event', (ev: PiEvent) => this.onPiEvent(ev));
    proc.on('stderr', (text: string) => this.emitEvent('process/stderr', { text }));
    proc.on('exit', (info: { code: number | null; signal: string | null }) => {
      this.proc = null;
      this.activeThreadId = null;
      this.currentTurn = null;
      this.resolveActiveTurn?.();
      this.resolveActiveTurn = null;
      this.activeTurnDone = null;
      this.emitEvent('process/exit', info);
    });

    proc.start();
    // Probe readiness and capture the initial session id/file.
    const state = await proc.request({ type: 'get_state' }, 20_000);
    this.recordState(state.data);
  }

  private onPiEvent(ev: PiEvent): void {
    if (ev.type === 'extension_ui_request') {
      const id = ev.id as string;
      // The bridge's MCP add/remove approval → route to Stem's McpApprovalCard.
      if (ev.method === 'confirm' && ev.title === ADMIN_APPROVAL_TITLE) {
        this.handleAdminApproval(id, ev.message as string | undefined);
        return;
      }
      // No UI for other dialogs yet — dismiss them safely.
      if (ev.method === 'confirm') this.proc?.send({ type: 'extension_ui_response', id, confirmed: false });
      else if (ev.method === 'select' || ev.method === 'input' || ev.method === 'editor')
        this.proc?.send({ type: 'extension_ui_response', id, cancelled: true });
      return;
    }
    if (!this.currentTurn) return;
    const turn = this.currentTurn;
    const { events, done } = normalizePiEvent(ev, turn);
    for (const e of events) this.emitEvent(e.method, e.params);
    if (done) {
      this.finishTurn();
      // Map this live turn's minted id to its persisted user-entry id so a later
      // fork/edit on the just-streamed message can target the right pi entry.
      void this.recordTurnEntry(turn.threadId, turn.turnId);
    }
  }

  private async recordTurnEntry(threadId: string, turnId: string): Promise<void> {
    try {
      if (!this.proc || this.activeThreadId !== threadId) return;
      const fm = await this.proc.request({ type: 'get_fork_messages' });
      const entries = (fm.data as { messages?: { entryId: string }[] } | undefined)?.messages ?? [];
      const last = entries[entries.length - 1];
      if (last) this.turnEntryIds.set(turnId, last.entryId);
    } catch {
      // best-effort; rollback/fork will surface a clear error if unresolved
    }
  }

  /** Resolve a renderer turnId to a pi session entry id (identity for reloaded threads). */
  private resolveEntryId(turnId: string): string {
    return this.turnEntryIds.get(turnId) ?? turnId;
  }

  private finishTurn(): void {
    this.currentTurn = null;
    this.resolveActiveTurn?.();
    this.resolveActiveTurn = null;
    this.activeTurnDone = null;
    // An approved MCP add/remove takes effect by reloading the bridge after the
    // turn (restarting mid-turn would kill the in-flight conversation).
    if (this.pendingMcpReload) {
      this.pendingMcpReload = false;
      void this.configMcpServerReload().catch(() => undefined);
    }
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
    this.emitEvent('mcp/admin/approvalRequest', card);
    setTimeout(() => {
      if (this.adminApprovals.has(id)) {
        this.adminApprovals.delete(id);
        this.proc?.send({ type: 'extension_ui_response', id, confirmed: false });
      }
    }, 120_000);
  }

  /** Start a fresh session on the foreground process; returns its sessionId. */
  private async newSession(): Promise<string> {
    await this.proc!.request({ type: 'new_session' });
    // A fresh pi session resets the active model to the spawn default — invalidate the
    // mirror so the next applyModel re-issues set_model for the caller's chosen model.
    this.currentModel = null;
    const state = await this.proc!.request({ type: 'get_state' });
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
    await this.proc!.request({ type: 'switch_session', sessionPath: file });
    // The loaded session restores its OWN persisted model — invalidate the mirror.
    this.currentModel = null;
    this.activeThreadId = threadId;
    return threadId;
  }

  private async applyModel(model: string): Promise<void> {
    if (model === this.currentModel) return;
    const { provider, modelId } = this.parseModel(model);
    const res = await this.proc!.request({ type: 'set_model', provider, modelId });
    if (res.success) this.currentModel = model;
  }

  private async setThinking(effort: string): Promise<void> {
    const level = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : 'medium';
    await this.proc!.request({ type: 'set_thinking_level', level }).catch(() => undefined);
  }

  private parseModel(model: string): { provider: string; modelId: string } {
    const i = model.indexOf('/');
    if (i === -1) return { provider: DEFAULT_PROVIDER, modelId: model };
    return { provider: model.slice(0, i), modelId: model.slice(i + 1) };
  }

  /** Assemble the prompt: prepend recall/files/format context (pi has no per-turn context field). */
  private async buildMessage(
    input: StartTurnInput,
    threadId: string
  ): Promise<{ message: string; images: PiImageContent[] }> {
    const blocks: string[] = [];
    if (isRecallEnabled()) {
      const recall = buildRecallContext(input.input, { currentThreadId: threadId });
      if (recall) blocks.push(recall);
    }
    const files = await buildFilesContext();
    if (files) blocks.push(files);
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
    const message = blocks.length
      ? `${CONTEXT_OPEN}\n${blocks.join('\n\n')}\n\n---\n${CONTEXT_CLOSE}\n\n${userText}`
      : userText;
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
    const out: SessionFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.jsonl')) {
          const parsed = await this.readSessionMeta(full);
          if (parsed) out.push(parsed);
        }
      }
    };
    await walk(this.options.sessionsDir);
    return out;
  }

  private async readSessionMeta(path: string): Promise<SessionFile | null> {
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
    let updatedAt = createdAt;
    try {
      updatedAt = Math.floor((await stat(path)).mtimeMs);
    } catch {
      // keep createdAt
    }
    return { id, path, name, cwd, createdAt: Math.floor(createdAt), updatedAt };
  }

  /** Read the live foreground session's messages (for active sessions without a file yet). */
  private async readActiveMessages(): Promise<{ title: string; messages: ChatMessage[] }> {
    const res = await this.proc!.request({ type: 'get_messages' });
    const raw = (res.data as { messages?: { role?: string; content?: unknown }[] } | undefined)?.messages ?? [];
    const messages: ChatMessage[] = [];
    for (const m of raw) {
      const { text: content, images } = this.contentToParts(m.content);
      if (!content.trim() && !images.length) continue;
      if (m.role === 'user')
        messages.push({
          id: `user-${messages.length}`,
          role: 'user',
          content,
          ...(images.length ? { attachments: images } : {})
        });
      else if (m.role === 'assistant')
        messages.push({ id: `assistant-${messages.length}`, role: 'assistant', content });
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
  private contentToParts(content: unknown): { text: string; images: MessageAttachment[] } {
    if (typeof content === 'string') return { text: content, images: [] };
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
    // Drop any fenced recall/files/format context we prepended at send time so the
    // replayed user bubble shows only what the user actually typed. No-op on turns
    // with no injection and on assistant messages (markers never appear there).
    return { text: texts.join('').replace(CONTEXT_STRIP_RE, ''), images };
  }

  /** Providers Stem has credentials for (from the isolated auth.json). */
  private async authProviders(): Promise<Set<string>> {
    try {
      const raw = await readFile(join(this.options.piHome, 'auth.json'), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return new Set(Object.keys(parsed));
    } catch {
      return new Set();
    }
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
    if (!(await this.fileExists(dest))) {
      const src = join(homedir(), '.pi', 'agent', 'auth.json');
      if (await this.fileExists(src)) await copyFile(src, dest).catch(() => undefined);
    }
    // Ensure mcp.json (with the reserved stem-recall entry) for the bridge extension.
    await ensureMcpConfig().catch(() => undefined);
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private loginCommand(piPath: string): string {
    return `env PI_CODING_AGENT_DIR="${this.options.piHome}" "${piPath}"`;
  }

  private sanitizedEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    env.PI_CODING_AGENT_DIR = this.options.piHome;
    env.PI_CODING_AGENT_SESSION_DIR = this.options.sessionsDir;
    env.PI_SKIP_VERSION_CHECK = '1';
    // Tell the bridge extension where Stem's MCP config lives.
    env.STEM_MCP_CONFIG = piMcpConfigPath();
    return env;
  }
}
