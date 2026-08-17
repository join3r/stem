import { join } from 'node:path';
import dns from 'node:dns';
import net from 'node:net';
import { createBackend, type ChatBackend } from './backend';
import {
  registerAuthIpc,
  registerChatsIpc,
  registerDevicesIpc,
  registerMcpIpc,
  registerMemoryIpc,
  registerServer,
  registerWorkspaceIpc,
  type IpcDeps
} from './ipc';
import { log } from './log';
import { ensureWorkspace } from './workspace/bootstrap';
import { publishProtectedRootsNow } from './workspace/connected-folders';
import { piHome } from './workspace/paths';
import type { TaskScheduler } from './scheduler';
import { initTaskScheduler } from './startup/scheduler';
import type { ExecService } from './exec/service';
import { detectGitBash } from './exec/git-bash';
import { startScratchSweeper, stopScratchSweeper } from './exec/scratch';
import { initExecService } from './startup/exec';
import { initSkills } from './startup/skills';
import { closeTransport, pushToClients, startTransport, type TransportEndpoint } from './startup/transport';
import { setActivityEmitter } from './activity';
import { foldTurnEvent, liveTurnCount, noteTurnStart } from './live-turns';
import { pushApprovalRequest, pushTurnFinished, type ApprovalPushKind } from './push';
import { closeApns } from './push/apns';
import { closeDeviceMcpRouter } from './mcp-device/router';
import { closeExecDeviceRouter } from './exec-device/router';
import { initRetrieval } from './startup/retrieval';
import { initRecallTasks } from './startup/recall-tasks';
import { ensureUsageTracking } from './skills/usage';
import { initFolderIndexTasks } from './startup/folder-index-tasks';
import { closeFolderIndexes } from './folder-index';
import { ProviderAuth } from './pi/provider-auth';
import { isRecallEnabled } from './workspace/memory';
import { captureFromEvent } from './recall/capture';
import { createHttpEmbeddingsClient } from './recall/embeddings';
import { createHttpRerankClient } from './recall/rerank';
import { EMBED_CATALOG } from './recall/embed-catalog';
import type { EmbedWorkerManager } from './recall/embed-manager';
import { RERANK_CATALOG } from './recall/rerank-catalog';
import type { ScanWorkerManager } from './recall/scan-manager';
import type { RemoteHealthTracker } from './recall/remote-health';
import { backfillChatIndex, reindexChatThread } from './chatsearch/index-sync';
import {
  markOnboardingCompleted,
  readSettings,
  updateChatsSettings,
  updateCustomInstructions,
  updateDefaultModel,
  updateDefaults,
  updateEscapeAction,
  updateExecSettings,
  updateMemorySettings,
  updateWebSearch,
  updateQuickChat,
  updateRetrievalSettings,
  updateSkillsSettings,
  updateTasksSettings
} from './workspace/settings';
import { needsBackendRestart, needsWebSearchConfigWrite, writeWebSearchConfig } from './pi/web-search';
import type {
  ChatsSettings,
  DefaultsSettings,
  CustomInstructionsSettings,
  EscapeAction,
  ExecDecision,
  ExecSettings,
  MemoryModelSettings,
  ModelSummary,
  WebSearchSettings,
  PartialRetrievalSettings,
  RetrievalStage,
  RetrievalTestResult,
  SkillsSettings,
  TasksSettings,
  QuickChatSettings,
  RuntimeStatus,
  StartTurnInput
} from '../shared/types';

// The headless composition root. Everything Stem does that is not a window lives
// under this directory, and startServer() is where the pieces are wired together:
// workspace bootstrap, the pi backend, exec, the scheduler, skills, retrieval,
// Recall's background passes, folder indexing, the ~110 channel handlers, and the
// one tap on the backend's event stream that feeds all of them.
//
// It imports no client code and must never import Electron. startServer() brings
// the transport up with everything else and hands back the URL it is listening on;
// from there the relationship is entirely a socket, and a client's credential is
// its own business (shared disk, or a pairing code). There is no
// direct call path left between the two halves, in either direction — which is
// the property that makes `stem-server` on another machine a deployment question
// rather than a code question.

// Prefer IPv4 for all of the server's outbound networking. auth.openai.com (and
// other OAuth token endpoints) are dual-stack, but many networks have no working
// IPv6 route; fetch would then try an AAAA address and die with a bare
// "fetch failed" (EHOSTUNREACH) instead of falling back — breaking the OAuth token
// exchange right after the browser shows "authentication successful". Ordering
// IPv4 first, plus enabling Happy Eyeballs (parallel v4/v6 with fallback), makes
// the token exchange behave like curl and the system browser. Guarded for older
// runtimes that lack the setters.
dns.setDefaultResultOrder?.('ipv4first');
net.setDefaultAutoSelectFamily?.(true);
net.setDefaultAutoSelectFamilyAttemptTimeout?.(1000);

export interface ServerOptions {
  /**
   * True when the app was launched into an alternate profile (--fresh /
   * --profile). Such a profile must land in the onboarding wizard unauthenticated,
   * so pi's auth is not seeded from the user's global ~/.pi.
   */
  alternateProfile: boolean;
  /** The electron-vite dev server, when one is running; null in production. */
  devUrl: string | null;
}

export interface ServerHandle {
  /** Where clients reach this server. Not a credential — see transport/auth.ts. */
  endpoint: TransportEndpoint;
  /**
   * Spawn pi + connect MCP now rather than on the first prompt, and start the
   * scheduler if we are signed in. Fire-and-forget: the client calls it once the
   * UI has painted, to keep the spawn + MCP child processes off that path.
   */
  prewarm(): Promise<void>;
  /** Drain in-flight work and stop everything. Has its own SIGKILL backstop. */
  shutdown(): Promise<void>;
}

// Test seam: when STEM_E2E is set, createBackend() returns the hermetic
// FakeBackend (see backend/fake.ts) — real dispatch, event routing, renderers,
// Recall, and scheduler over deterministic scripted turns. The remaining
// E2E branches below fake only what lives OUTSIDE the backend seam: network
// probes, browser OAuth, and the embedding worker (model downloads).
const E2E = !!process.env.STEM_E2E;

let runtime: ChatBackend | null = null;
let execService: ExecService | null = null;
/** Scheduled-tasks engine (cron/once → autonomous turns). Created in startServer. */
let scheduler: TaskScheduler | null = null;
// In-app provider sign-in (OAuth / API key) for the onboarding wizard; created in
// startServer alongside the runtime.
let providerAuth: ProviderAuth | null = null;
// Local embedding worker manager (created in startServer; null until then and
// under E2E, where downloading model weights would break hermeticity).
let embedManager: EmbedWorkerManager | null = null;
// Recall scan worker manager (cosine scans + episodic VACUUM off the main event
// loop). Created in startServer; the worker itself spawns lazily.
let scanManager: ScanWorkerManager | null = null;
// Verdict cache for the user's remote retrieval endpoints (created in startServer
// with the rest of the retrieval wiring).
let remoteHealth: RemoteHealthTracker | null = null;
// When the user last started/stopped a turn, on any surface. Drives the
// scheduler's isUserActive signal so scheduled runs defer while they're chatting.
let lastInteractiveAt = 0;
// How long after the last interaction the user still counts as "active".
const USER_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
let scheduleMemoryRebuild: () => void = () => {};
let scheduleFolderIndexScan: (delayMs?: number) => void = () => {};
let scheduleFolderLearn: (delayMs?: number) => void = () => {};
// Late-bound by initRecallTasks; initSkills (wired earlier in boot) closes over it.
let scheduleCurateAfterCreate: (() => void) | null = null;

/**
 * The one server → client path (see startup/transport.ts). Every connected client
 * gets it; each one filters by threadId itself, exactly as the main window always
 * did, so there is no per-audience bookkeeping here.
 *
 * Recorded even when nothing is connected: the transport keeps a bounded ring of
 * recent frames behind the monotonic id, so a client whose stream dropped
 * mid-turn is given the gap back when it returns rather than a truncated answer.
 * Past the ring it is told to resync and refetches instead.
 */
function emit(channel: string, payload: unknown): void {
  pushToClients(channel, payload);
}

/**
 * The other half of "something happened": wake a phone that is not looking at
 * the stream. Every call is beside an emit(), never instead of one — the SSE
 * frame is what a client acts on, and the push only asks it to come and look.
 *
 * Off unless APNs is configured, which it is not on an ordinary install, and
 * silent while somebody is at a machine. See server/push/.
 */
function pushApproval(kind: ApprovalPushKind, params: unknown): void {
  // Every one of the four cards carries these two, under these names (see
  // ExecApprovalRequest / McpAdminProposal / InstructionsProposal / SkillProposal).
  const card = params as { id?: string | number; threadId?: string } | undefined;
  if (card?.id === undefined) return;
  pushApprovalRequest(kind, { id: card.id, ...(card.threadId ? { threadId: card.threadId } : {}) });
}

/** Pick a sensible app default from the models the signed-in providers expose. */
function chooseDefaultModel(models: ModelSummary[]): string | null {
  const pick =
    models.find((m) => m.provider === 'openai-codex' && m.id.endsWith('gpt-5.3-codex-spark')) ??
    models.find((m) => m.provider === 'anthropic' && /sonnet/i.test(m.id)) ??
    models.find((m) => m.provider === 'anthropic') ??
    // pi lists xai as 4.3 / build-0.1 / 4.5, so the models[0] fallback would put a
    // Grok-only user on a non-flagship model. 4.5 is pi's own default for xai; the
    // bare-provider rung behind it survives the catalog churn xAI is prone to (pi
    // has already dropped Grok 3 and the 4.20 variants).
    models.find((m) => m.provider === 'xai' && m.id.endsWith('grok-4.5')) ??
    models.find((m) => m.provider === 'xai') ??
    models[0];
  return pick?.id ?? null;
}

/**
 * Post-sign-in sequence: persist a default model matching the new provider,
 * restart pi so it re-reads auth.json (it loads credentials once at spawn),
 * and bring up the scheduler. Returns the fresh status for the renderer.
 */
async function onAuthenticated(): Promise<RuntimeStatus> {
  try {
    // listModels spawns pi if needed (doubles as the wizard's prewarm) and is
    // already filtered to providers with credentials.
    const models = await runtime!.listModels();
    const current = (await readSettings()).defaults.model;
    if (!current || !models.some((m) => m.id === current)) {
      // Re-pick when unset or the provider that served the default is gone; an
      // empty list (last provider disconnected) clears it back to the constant.
      await updateDefaultModel(chooseDefaultModel(models));
    }
  } catch {
    // model list unavailable — keep the built-in default
  }
  // Apply fresh credentials + the new default to the running process.
  await runtime!.restart().catch(() => undefined);
  void scheduler?.start();
  return runtime!.status();
}

/**
 * A web-search credential only reaches the search tools on a fresh pi process
 * (see needsBackendRestart), so an edit has to respawn the backend. Debounced
 * because the Settings pane persists keys per keystroke — a restart per character
 * would be absurd — and skipped while a turn is streaming, so pasting a key can
 * never kill a reply in progress. The next spawn picks the file up regardless, so
 * a skipped restart costs correctness nothing beyond the current process.
 */
const WEB_SEARCH_RESTART_DEBOUNCE_MS = 2_000;
let webSearchRestartTimer: NodeJS.Timeout | null = null;

function scheduleWebSearchRestart(): void {
  if (webSearchRestartTimer) clearTimeout(webSearchRestartTimer);
  webSearchRestartTimer = setTimeout(() => {
    webSearchRestartTimer = null;
    if (runtime && !runtime.isTurnRunning()) void runtime.restart().catch(() => undefined);
  }, WEB_SEARCH_RESTART_DEBOUNCE_MS);
}

/**
 * Every channel the server answers. The registry this fills IS the surface any
 * authenticated client may call (see ipc/guard.ts); the client-owned channels —
 * native pickers, reveal-in-file-manager, the Quick Chat windows — are absent by
 * construction, because they are not the server's to answer.
 */
function registerIpc(): void {
  registerServer('runtime:status', (): Promise<RuntimeStatus> => runtime!.status());
  registerServer('runtime:login', async () => {
    const status = await runtime!.login();
    // Signing in mid-session: start the scheduler now (idempotent) so tasks load and
    // catch-up runs without waiting for a restart.
    if (status.ok) void scheduler?.start();
    return status;
  });

  // Per-domain surfaces (auth/providers, skills/files/cfolders/tasks, MCP +
  // approvals, memory, chats/folders) live in ./ipc/*; they reach the late-bound
  // singletons through getters so registration can happen up front.
  const deps: IpcDeps = {
    e2e: E2E,
    runtime: () => runtime!,
    scheduler: () => scheduler,
    providerAuth: () => providerAuth,
    embedManager: () => embedManager,
    remoteHealth: () => remoteHealth,
    emit,
    onAuthenticated,
    scheduleMemoryRebuild: () => scheduleMemoryRebuild(),
    scheduleFolderIndexScan: (delayMs) => scheduleFolderIndexScan(delayMs),
    scheduleFolderLearn: (delayMs) => scheduleFolderLearn(delayMs)
  };
  registerAuthIpc(deps);
  registerWorkspaceIpc(deps);
  registerMcpIpc(deps);
  registerMemoryIpc(deps);
  registerChatsIpc(deps);
  registerDevicesIpc();

  registerServer('backend:startTurn', async (_e, input: StartTurnInput) => {
    // The user is actively chatting: yield any scheduler-owned turn (frees the
    // foreground gate) and hold scheduled runs off for a while.
    lastInteractiveAt = Date.now();
    scheduler?.preemptForUser();
    // The two per-surface settings are resolved HERE rather than by the caller:
    // the client says which surface it is and the server reads the user's
    // settings for it. Main gets the Main web-search toggle and the Main custom
    // instructions (the bridge extension activates/deactivates the search tools
    // for the turn to match); Quick Chat honors its own toggle and inherits the
    // Main instructions with its own extra appended.
    const settings = await readSettings();
    const ci = settings.customInstructions;
    const quickChat = input.surface === 'quickChat';
    const started = await runtime!.startTurn({
      ...input,
      webSearch: quickChat ? settings.webSearch.quickChat : settings.webSearch.main,
      instructions: quickChat
        ? [ci.main, ci.quickChat].map((s) => s.trim()).filter(Boolean).join('\n')
        : ci.main
    });
    // Start the turn's clock the moment there is a turn. Waiting for its first
    // event (which is where the fold otherwise learns of it) means a turn that
    // hangs without ever streaming anything has no start time at all, and its
    // eventual failure is measured as "unknown" and pushes nothing — silence for
    // precisely the turns worth a notification. An input the backend answered
    // itself (a remembered fact) has no turn and no clock.
    //
    // Internal threads are skipped for the same reason the event handler below
    // ignores them: their events never reach the fold, so a mark made here would
    // have nothing to clear it.
    if (started.threadId && started.turnId && !runtime!.isInternalThread(started.threadId)) {
      noteTurnStart(started.threadId, started.turnId);
    }
    return started;
  });
  registerServer('backend:interruptTurn', (_e, turnId: string) => {
    lastInteractiveAt = Date.now();
    return runtime!.interruptTurn(turnId);
  });
  // Mint an empty thread up front. Quick Chat is the only caller: it pre-creates
  // the thread before its first prompt so the turn's events route to the overlay
  // from the very first event. The main window never needs this — startTurn opens
  // a thread implicitly when it has no threadId.
  registerServer('backend:createThread', (_e, model?: string) => {
    // createThread enters the backend's foreground gate, exactly as startTurn
    // does, so it has to yield a scheduler-owned turn the same way — otherwise a
    // Quick Chat prompt typed during a scheduled run would sit behind it.
    lastInteractiveAt = Date.now();
    scheduler?.preemptForUser();
    return runtime!.createThread(model);
  });
  registerServer('backend:newConversation', () => runtime!.newConversation());
  registerServer('backend:listModels', () => runtime!.listModels());

  registerServer('runtime:restart', async () => {
    await runtime!.restart();
    return runtime!.status();
  });

  registerServer('chats:open', async (_e, threadId: string) => {
    // Nothing here about the Quick Chat hand-off. Opening a thread the overlay is
    // showing is an implicit hand-off, but that transition is entirely client
    // state, so the client runs it BEFORE forwarding the open — see the wrapped
    // channels in desktop/proxy.ts. A client that refuses the transition never
    // sends the call at all, which is how its throw still reaches the renderer.
    //
    // Read is a local file read and isn't gated, so the open returns immediately.
    // Pre-warm pi (switch_session) in the background — it's redundant for
    // correctness since startTurn calls ensureActive itself, but it makes the
    // first send faster. Crucially it no longer blocks the open behind the
    // foreground gate / any in-flight turn.
    void runtime!.resumeThread(threadId).catch(() => {});
    const { title, messages } = await runtime!.readThread(threadId);
    return { threadId, title, messages };
  });

  // The same transcript, without the pre-warm — a pure read, which is what a
  // caller that is not a person opening a chat wants. The pre-warm above enters
  // the backend's foreground gate, so a client walking a list of threads through
  // chats:open would queue a session switch per thread behind whatever the user
  // is actually doing. Nothing about the reader is the server's business; this
  // is just "read a thread and change nothing".
  registerServer('chats:history', async (_e, threadId: string) => {
    const { title, messages } = await runtime!.readThread(threadId);
    return { threadId, title, messages };
  });

  // ---- settings ----
  registerServer('settings:get', () => readSettings());
  registerServer('settings:updateQuickChat', async (_e, patch: Partial<QuickChatSettings>) => {
    // Persisting is all this side does. The global accelerator, the overlay's
    // all-Spaces flag and the pill's cached preferences are not settings at all
    // once they leave the file — they are grabs on somebody's machine — so the
    // client applies them the moment this returns (a wrapped channel, see
    // desktop/proxy.ts).
    return updateQuickChat(patch);
  });
  registerServer('settings:updateWebSearch', async (_e, patch: Partial<WebSearchSettings>) => {
    const next = await updateWebSearch(patch);
    // The per-context on/off booleans are applied per turn (the runtime writes the
    // gate the bridge reads, based on the originating context) — nothing to do here.
    // A backend/key change is different: it lives in <piHome>/web-search.json, which
    // pi-web-access reads, so rewrite that file whenever those fields move.
    if (needsWebSearchConfigWrite(patch)) {
      await writeWebSearchConfig(next.webSearch).catch((err: unknown) =>
        log('websearch', 'failed to write web-search.json', { error: String(err) })
      );
      if (needsBackendRestart(patch)) scheduleWebSearchRestart();
    }
    return next;
  });
  // No "what's new" channels here: the popup is decided from the version
  // installed on a CLIENT and the RELEASE_NOTES.md shipped beside it, so
  // `releaseNotes:get`, `releaseNotes:markSeen` and `settings:updateReleaseNotes`
  // are answered by the desktop (src/desktop/local/index.ts). A server with two
  // Macs on two builds has no single correct answer to give.
  registerServer('settings:updateEscapeAction', async (_e, action: EscapeAction) => {
    // Just persist — the renderer reads escapeAction fresh from settings (mount +
    // window focus) and acts on it locally in the composer.
    return updateEscapeAction(action);
  });
  registerServer('settings:updateMemory', async (_e, patch: Partial<MemoryModelSettings>) => {
    // Just persist — the LlmClient closures read the model fresh from settings on
    // each memory turn, so the change applies to the next distill/tidy-up.
    return updateMemorySettings(patch);
  });
  registerServer('settings:updateSkills', async (_e, patch: Partial<SkillsSettings>) => {
    // Just persist — the curator's LlmClient reads the model fresh from settings on
    // each pass, so the change applies to the next curation run.
    return updateSkillsSettings(patch);
  });
  registerServer('settings:updateDefaults', async (_e, patch: Partial<DefaultsSettings>) => {
    // Just persist. Every background role reads defaults fresh on each call, and
    // the model you chat with is re-read by the next spawn — nothing to restart.
    return updateDefaults(patch);
  });
  registerServer('settings:updateChats', async (_e, patch: Partial<ChatsSettings>) => {
    // Just persist — the subject writer reads mode and model fresh on every new
    // thread, and the renderer reads previewLines back for itself.
    return updateChatsSettings(patch);
  });
  registerServer('settings:updateTasks', async (_e, patch: Partial<TasksSettings>) => {
    // Just persist — the scheduler's notify bridge reads the mode fresh on every
    // notify_user, so the change applies to the very next run.
    return updateTasksSettings(patch);
  });
  registerServer('settings:updateExec', async (_e, patch: Partial<ExecSettings>) => {
    // Just persist — the ExecService reads the policy fresh from settings on each
    // run_command request, so the change applies to the next command.
    return updateExecSettings(patch);
  });
  registerServer('exec:resolveApproval', async (_e, id: string, decision: ExecDecision) => {
    execService?.resolveApproval(id, decision);
  });
  registerServer('exec:detectGitBash', async () => detectGitBash());
  registerServer('settings:updateCustomInstructions', async (_e, patch: Partial<CustomInstructionsSettings>) => {
    // Just persist — backend:startTurn reads the instructions fresh per turn (for
    // both surfaces), so the change applies to the next turn with no restart.
    return updateCustomInstructions(patch);
  });
  registerServer('settings:updateRetrieval', async (_e, patch: PartialRetrievalSettings) => {
    // Persist — the embeddings/rerank clients read their config fresh from settings
    // on each turn, so the change applies to the next fact-ranking pass. The local
    // worker is the one stateful piece: kick it immediately on a mode/model change
    // so the download/load starts now rather than on the next turn.
    const before = (await readSettings()).retrieval;
    const next = await updateRetrievalSettings(patch);
    const after = next.retrieval;
    if (
      embedManager &&
      (before.embeddings.mode !== after.embeddings.mode ||
        before.embeddings.localModel !== after.embeddings.localModel)
    ) {
      if (after.embeddings.mode === 'local') embedManager.reconfigure(EMBED_CATALOG[after.embeddings.localModel]);
      else if (before.embeddings.mode === 'local') embedManager.reconfigure(null);
    }
    if (
      embedManager &&
      (before.reranker.mode !== after.reranker.mode || before.reranker.localModel !== after.reranker.localModel)
    ) {
      if (after.reranker.mode === 'local') embedManager.reconfigureRerank(RERANK_CATALOG[after.reranker.localModel]);
      else if (before.reranker.mode === 'local') embedManager.reconfigureRerank(null);
    }
    // A touched stage gets its remote-endpoint verdict wiped: it described the
    // OLD config (a mode that's no longer remote, a URL the user just fixed),
    // and a stale red marker would say "still broken" about a change the next
    // real request hasn't judged yet.
    if (patch.embeddings) remoteHealth?.reset('embeddings');
    if (patch.reranker) remoteHealth?.reset('reranker');
    return next;
  });
  registerServer('settings:testRetrieval', async (_e, stage: RetrievalStage): Promise<RetrievalTestResult> => {
    // Live one-shot probe of the configured backend so the user can confirm it
    // actually responds (the fact-ranking path is otherwise silent).
    const retrieval = (await readSettings()).retrieval;
    const startedAt = Date.now();
    if (stage === 'embeddings' && retrieval.embeddings.mode !== 'remote') {
      const emb = retrieval.embeddings;
      if (emb.mode === 'off') return { ok: false, detail: 'Embeddings are off.' };
      // Local mode: Test doubles as the "start/retry the download" button — force
      // past the error-retry gate, then report where the worker is right now.
      if (!embedManager) return { ok: false, detail: 'Embedding worker not started yet.' };
      const spec = EMBED_CATALOG[emb.localModel];
      embedManager.ensure(spec, { force: true });
      const st = embedManager.status();
      if (st.state === 'error') return { ok: false, detail: st.error ?? 'model failed to load' };
      if (st.state !== 'ready' || st.model !== spec.id) {
        return {
          ok: true,
          detail: st.state === 'downloading' ? `downloading model — ${st.progressPct ?? 0}%` : 'loading model…'
        };
      }
      try {
        const [vec] = await embedManager.embed(['Stem retrieval test'], 'query');
        return { ok: true, detail: `${vec.length}-dim · ${Date.now() - startedAt} ms · local` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'embed failed' };
      }
    }
    if (stage === 'reranker' && retrieval.reranker.mode !== 'remote') {
      const rr = retrieval.reranker;
      if (rr.mode === 'off') return { ok: false, detail: 'Reranker is off.' };
      // Local mode: Test doubles as the "start/retry the download" button, same
      // contract as the embeddings branch above.
      if (!embedManager) return { ok: false, detail: 'Embedding worker not started yet.' };
      const spec = RERANK_CATALOG[rr.localModel];
      embedManager.ensureRerank(spec, { force: true });
      const st = embedManager.rerankStatus();
      if (st.state === 'error') return { ok: false, detail: st.error ?? 'model failed to load' };
      if (st.state !== 'ready' || st.model !== spec.id) {
        return {
          ok: true,
          detail: st.state === 'downloading' ? `downloading model — ${st.progressPct ?? 0}%` : 'loading model…'
        };
      }
      try {
        const ranked = await embedManager.rerank('pets', ['I have a dog', 'the sky is blue'], 2);
        return { ok: true, detail: `ranked ${ranked.length} · ${Date.now() - startedAt} ms · local` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'rerank failed' };
      }
    }
    const cfg = stage === 'embeddings' ? retrieval.embeddings : retrieval.reranker;
    if (!cfg.baseUrl || !cfg.model) return { ok: false, detail: 'Set a base URL and model first.' };
    const getCfg = async () => ({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey });
    try {
      if (stage === 'embeddings') {
        const [vec] = await createHttpEmbeddingsClient(getCfg, { timeoutMs: 20_000 }).embed(['Stem retrieval test']);
        remoteHealth?.recordOk(stage);
        return { ok: true, detail: `${vec.length}-dim · ${Date.now() - startedAt} ms` };
      }
      const ranked = await createHttpRerankClient(getCfg, { timeoutMs: 20_000 }).rerank(
        'pets',
        ['I have a dog', 'the sky is blue'],
        2
      );
      remoteHealth?.recordOk(stage);
      return { ok: true, detail: `ranked ${ranked.length} · ${Date.now() - startedAt} ms` };
    } catch (err) {
      const e = err as { message?: string; cause?: { code?: string } };
      const detail = e.cause?.code ?? e.message ?? 'request failed';
      // Test outcomes feed the verdict cache both ways: a passing test clears
      // the red markers immediately (the fix shouldn't wait for the next recall
      // pass to be believed), and a failing one raises them without waiting for
      // a pass to trip over the endpoint.
      remoteHealth?.recordError(stage, detail);
      return { ok: false, detail };
    }
  });
}

/**
 * Bring the whole server up, in the order the pieces depend on each other, and
 * hand back the two levers a host needs. Resolves once everything is wired; the
 * expensive parts (the pi spawn, the chat-search backfill) are deliberately not
 * awaited here.
 */
export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  await ensureWorkspace();
  // Publish the read-only connected-folder roots so the backend extension enforces
  // them from the first turn (also rewritten on every Folders-tab mutation).
  await publishProtectedRootsNow().catch(() => undefined);
  // pi is the only backend; it satisfies ChatBackend so everything below is
  // backend-agnostic. Alternate profiles (--fresh / --profile) skip seeding auth
  // from the user's global ~/.pi so they start unauthenticated in the onboarding wizard.
  runtime = createBackend({ seedGlobalAuth: !opts.alternateProfile });

  // In-app provider sign-in for the onboarding wizard. Writes the same isolated
  // auth.json the pi subprocess reads; progress is pushed to the client.
  providerAuth = new ProviderAuth(join(piHome(), 'auth.json'), (event) => emit('auth:event', event));

  // True while a turn runs on any surface — a desktop window, a phone — or the
  // user interacted within `idleMs`. Drives the scheduler's defer/preempt signal
  // and lets the recall background passes yield to interactive work. A phone
  // counts even though nobody is at the Mac: a live conversation is a live
  // conversation.
  const busyWithin = (idleMs: number): boolean =>
    liveTurnCount() > 0 || Date.now() - lastInteractiveAt < idleMs;

  scheduler = initTaskScheduler({
    runtime,
    emit,
    isUserActive: () => busyWithin(USER_ACTIVE_WINDOW_MS),
    // Raising a window and bouncing a dock are things only a machine with a
    // screen can do, so they leave as pushes rather than calls. There is no
    // allowlist deciding who hears them — every SSE client gets every channel
    // (see transport/server.ts) — so these reach a paired phone too and are
    // ignored there, because nothing on the phone subscribes to them. Waking a
    // phone for a task is a separate, deliberate act: an APNs push, sent by
    // push/index.ts under its own suppression rules.
    revealMainWindow: () => emit('client:revealMainWindow', null),
    requestAttention: () => emit('client:requestAttention', null)
  });

  // Command execution (the run_command tool): the ExecService owns the tiered
  // policy + spawn; approval cards go straight out to the client (both of its
  // surfaces mount the card) and to any connected phone — same pattern as the
  // MCP-admin/instructions approvals.
  execService = initExecService({
    runtime,
    emitApprovalRequest: (request) => {
      emit('exec:approvalRequest', request);
      // The agent is blocked on this one until somebody answers it.
      pushApproval('exec', request);
    },
    emitApprovalResolved: (id) => {
      emit('exec:approvalResolved', { id });
    }
  });

  // Scratch housekeeping: each chat's run_command folder is removed when the chat
  // is deleted, and idle ones age out on the TTL (Settings → Chat → Command
  // execution). Swept once now and then daily — the desktop app is quit most
  // nights, but a headless server can run for a quarter, and that is exactly the
  // machine where disk creeping up goes unnoticed.
  startScratchSweeper({
    listChats: () => runtime!.listThreads(),
    ttlDays: async () => (await readSettings()).exec.scratchTtlDays
  });

  // Skills (the manage_skill tool): the write, the contract validator, and the
  // Off/Ask/Auto policy all live here. The approval card rides the backend event
  // stream (unlike exec's, which is server-owned end to end), so there is nothing
  // to emit here — see the skills/approval* cases in the event router.
  initSkills({
    runtime,
    busyWithin,
    onChanged: () => {
      void runtime?.requestSkillReload();
      emit('skills:changed', undefined);
    },
    // Late-bound: the recall tasks (which own the curator) are wired a few lines
    // below this call. A create before that assignment simply doesn't schedule,
    // which cannot happen outside boot and is covered by the startup pass anyway.
    onCreated: () => scheduleCurateAfterCreate?.()
  });

  // Background-activity feed for the toolbar indicator. Wired before the passes
  // below start reporting.
  setActivityEmitter((snapshot) => emit('activity:changed', snapshot));

  // Stem Recall relevance ranking + background workers: embed/scan utility
  // processes, retrieval clients (settings-mode routed), and the MCP embed
  // endpoint. See startup/retrieval.ts.
  const retrieval = initRetrieval({
    e2e: E2E,
    emit
  });
  embedManager = retrieval.embedManager;
  scanManager = retrieval.scanManager;
  remoteHealth = retrieval.remoteHealth;

  // Skill usage tracking: anchor trackingSince and prune entries for deleted
  // skills. Unconditional — usage feeds the Manage panel regardless of the
  // recall toggle that gates the distill/curate passes below.
  ensureUsageTracking();

  // Stem Recall's background passes (distillation, summaries, consolidation,
  // skills, confirmed rebuild, dormant backfill) — see startup/recall-tasks.ts.
  // They yield to interactive work via busyWithin.
  const recallTasks = initRecallTasks({
    runtime: () => runtime!,
    busyWithin,
    emit
  });
  scheduleMemoryRebuild = recallTasks.scheduleMemoryRebuild;
  scheduleCurateAfterCreate = recallTasks.scheduleCurateAfterCreate;
  const { scheduleDistill, scheduleEpisodicEmbed } = recallTasks;

  // Indexed connected folders: startup kick + periodic incremental rescan
  // (mirror folders change from outside the app). See startup/folder-index-tasks.ts.
  const folderIndexTasks = initFolderIndexTasks({ runtime: () => runtime!, busyWithin });
  scheduleFolderIndexScan = folderIndexTasks.scheduleFolderIndexScan;
  scheduleFolderLearn = folderIndexTasks.scheduleFolderLearn;

  // A background subject write finished and renamed a thread. Its own channel
  // rather than a backend event: nothing about it belongs to a turn, and the
  // only sensible response is "ask for the list again".
  runtime.on('chats:changed', (threadId: string) => {
    // The rename went round the backend, not through chats:rename, so the search
    // index needs the same nudge that handler gives it.
    void reindexChatThread(runtime!, threadId);
    emit('chats:changed', undefined);
  });

  // The one tap on the backend's event stream. Registered once (not per client)
  // so nothing can double-subscribe. Two audiences hang off it: the client that
  // started us (through its bridge) and any connected phone; everything below
  // that is Recall and chat-search bookkeeping.
  runtime.on('event', (event) => {
    // Stem-internal MCP self-management signals: deliver on their own channels
    // (never as a backend thread event, and never captured into recall).
    if (event.method === 'mcp/admin/approvalRequest') {
      emit('mcp:adminApproval', event.params);
      pushApproval('mcp', event.params);
      return;
    }
    if (event.method === 'mcp/admin/approvalResolved') {
      emit('mcp:adminApprovalResolved', event.params);
      return;
    }
    if (event.method === 'instructions/approvalRequest') {
      emit('instructions:approvalRequest', event.params);
      pushApproval('instructions', event.params);
      return;
    }
    if (event.method === 'skills/approvalRequest') {
      emit('skills:approvalRequest', event.params);
      pushApproval('skill', event.params);
      return;
    }
    if (event.method === 'skills/approvalResolved') {
      emit('skills:approvalResolved', event.params);
      return;
    }
    if (event.method === 'instructions/approvalResolved') {
      emit('instructions:approvalResolved', event.params);
      return;
    }
    if (event.method === 'mcp/changed') {
      emit('mcp:changed', undefined);
      return;
    }
    if (event.method === 'skills/changed') {
      emit('skills:changed', undefined);
      return;
    }
    if (event.method === 'mcp/status') {
      emit('mcp:status', event.params);
      return;
    }
    const threadId = (event.params as { threadId?: string } | undefined)?.threadId;
    // Hidden internal threads (distillation) are neither shown nor captured.
    if (threadId && runtime!.isInternalThread(threadId)) return;
    // Folding and measuring in one call: the fold is what forgets the turn, so
    // the age has to be read first — see foldTurnEvent, where that ordering lives
    // with its test.
    const { ranForMs } = foldTurnEvent(
      event.method,
      threadId,
      (event.params as { turnId?: string } | undefined)?.turnId
    );
    // Out to every client, which filters by threadId itself exactly as the main
    // window always did — the server does not track which thread anyone has open.
    //
    // There used to be an exception here: a thread the Quick Chat overlay had
    // claimed was narrowed to the `desktop` role, so a phone would not build a
    // phantom user-less slice of a conversation being held at the desk. With the
    // phone role gone the narrowing selected every connected client anyway, and
    // the claim it read (`client:claimThread`) had no other reader — so both went.
    emit('backend:event', event);
    // A long turn ending is the second thing worth a phone buzzing for: whoever
    // started it has had half a minute to walk away, and the answer is now
    // sitting there. Short turns push nothing — see MIN_TURN_PUSH_MS, which is
    // where that rule lives. The title is a thunk so the lookup only happens if
    // the push is actually going out.
    //
    // A scheduled run is excluded, and not as an optimization: nobody is waiting
    // on it, it fires on a cron, and most of its runs find nothing. Whether one
    // was worth interrupting anybody is a question its own notify_user answers
    // (see startup/scheduler.ts) — treating "it finished" as news would put a
    // notification on the phone every time a watch task ticked.
    if (threadId && ranForMs !== null && !scheduler?.runningTask(threadId)) {
      pushTurnFinished({
        threadId,
        failed: event.method === 'turn/failed',
        ranForMs,
        label: async () => (await runtime!.listThreads()).find((c) => c.threadId === threadId)?.title ?? null
      });
    }
    if (isRecallEnabled()) {
      // Skip capture when the turn read inside a memorize:false connected folder, so
      // its (potentially confidential) reply never enters Recall. scheduleDistill still
      // runs — it only processes already-captured messages.
      if (!(threadId && runtime!.isCaptureSuppressed(threadId))) {
        // The user message is held back until the turn's suppression verdict is
        // knowable; flushing it here keeps its row id below its reply's.
        if (threadId) runtime!.flushPendingUserCapture(threadId);
        // Assistant replies from a web-using turn are captured flagged `web`, so
        // distillation never treats restated page content as trusted provenance.
        captureFromEvent(event, { web: !!threadId && runtime!.isWebTainted(threadId) });
      }
      if (event.method === 'turn/completed') {
        scheduleDistill();
        scheduleEpisodicEmbed();
      }
    }
    // Chat search indexes the user's own chats in full — independent of the memory
    // toggle and of recall's memorize:false/taint gating (you must be able to find a
    // chat even if it was marked don't-remember). Re-index this thread once its turn
    // lands so the new messages are searchable without a relaunch.
    if (threadId && event.method === 'turn/completed') {
      void reindexChatThread(runtime!, threadId);
    }
  });

  // Backfill the chat-search index in the background a little after startup (never
  // blocking it). The per-thread watermark makes this a near no-op on every relaunch —
  // only chats changed since they were last indexed (or edited externally) get reread.
  setTimeout(() => void backfillChatIndex(runtime!), 8_000);

  registerIpc();
  // Last: the transport dispatches into the handlers registerIpc just installed
  // and answers GET /channels out of the same registry, so anything registered
  // after this point would be invisible to every client.
  const endpoint = await startTransport({ devUrl: opts.devUrl });

  return {
    endpoint,
    async prewarm() {
      // Skipped when not signed in (status() is cheap and never spawns). Under
      // STEM_E2E the fake backend reports authenticated (unless the onboarding
      // sub-seam), so this same path starts the scheduler for seeded tasks;
      // prewarm/restart are no-ops on the fake.
      await runtime!
        .status()
        .then(async (s) => {
          if (!s.ok) return;
          // Already authenticated (e.g. auth seeded from an existing ~/.pi): count
          // onboarding as done, so a LATER auth loss shows the compact re-sign-in
          // screen instead of the first-run welcome.
          const settings = await readSettings();
          if (!settings.onboarding.completed) await markOnboardingCompleted();
          // Start the scheduler only once signed in — runs are turns, which need a
          // working backend. This also runs any tasks missed while Stem was closed
          // (catch-up), exactly once each.
          void scheduler?.start();
          return runtime!.prewarm();
        })
        .catch(() => {});
    },

    shutdown() {
      if (webSearchRestartTimer) clearTimeout(webSearchRestartTimer);
      scheduler?.stop();
      stopScratchSweeper();
      embedManager?.dispose();
      scanManager?.dispose();
      closeFolderIndexes();
      // Before the transport goes: every held MCP call is waiting on a control
      // frame's answer coming back over a socket that is about to be destroyed,
      // and failing them with a sentence beats each one waiting out two minutes
      // for a reply that can no longer arrive.
      closeDeviceMcpRouter();
      // And every held device command, for the same reason.
      closeExecDeviceRouter();
      // Destroys any open SSE stream before closing the listener — without that,
      // close() waits for a connection that by design never ends.
      void closeTransport();
      // The APNs connection is unref'd and would not hold the process open, but
      // a half-open HTTP/2 session outliving the server it belonged to is the
      // kind of thing that only shows up as a mystery in a long-lived host.
      closeApns();
      return runtime!.shutdown();
    }
  };
}
