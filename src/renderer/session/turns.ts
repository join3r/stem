// Shared turn-lifecycle orchestration for the main window and the Quick Chat
// overlay. Before this module each window hand-maintained its own copy of the
// streaming state machine (event application, settled-turn race guards, pending
// send bookkeeping, interrupt/rerun flows) and the copies had drifted. The parts
// that genuinely differ between the windows — draft→real-thread migration in
// main, thread adoption in the overlay — stay host-side, injected via callbacks.

import type {
  BackendEventEnvelope,
  ChatMessage,
  LiveTurn,
  MessageMeta,
  StartTurnResult,
  ThreadStatus,
  TurnAttachment
} from '../../shared/types';
import {
  EMPTY_STATE,
  appendSystemMessage,
  applyBackendEventToThread,
  applyProcessExitToThread,
  backendEventThreadId,
  type ThreadState
} from '../chatState';
import { createEventBatcher } from '../eventBatcher';
import { optimisticMessageAttachments, resendAttachments, toMessageAttachments } from '../attachments';
import { deletePendingIfCurrent, interruptibleTurnId, pendingStartBlocksSend } from '../pendingTurn';
import { SessionStore, type ThreadStates } from './store';

// The settled-turn guard lives in shared/ because the server needs the same rule
// in a process that cannot import from renderer/. Re-exported here so this module
// stays the one place session code imports turn lifecycle from.
import { SettledTurns, isSettledMethod, type TurnSettledMethod } from '../../shared/settledTurns';

export {
  SETTLED_TURN_CAP,
  SettledTurns,
  isSettledMethod,
  type TurnSettledMethod
} from '../../shared/settledTurns';

/** An in-flight send, kept so Escape-to-retract/Stop can recover the turn id (and
 * the original text/attachments) even before startTurn resolves. Keyed by state
 * key (thread id, the main window's DRAFT sentinel, or the overlay's key). */
export interface PendingSend {
  promise: Promise<StartTurnResult>;
  turnId: string | null;
  /** Real thread id, set on resolution (refs lag a commit behind the await). */
  threadId: string | null;
  /** Marks a send that created the chat, so retract deletes it instead of rolling back. */
  isNewChat: boolean;
  text: string;
  attachments: TurnAttachment[];
  /** DRAFT generation this start belongs to; absent for real threads. */
  draftGeneration?: number;
  /** Sent draft snapshot, retained even if the visible DRAFT is replaced. */
  draftMessages?: ChatMessage[];
}

export interface SessionCore {
  store: SessionStore;
  /** turnId → which model/effort/speed produced that turn's reply (avatar
   * tooltip). Turn ids are unique across threads, so one map serves every slice. */
  turnMeta: Map<string, MessageMeta>;
  settledTurns: SettledTurns;
  pendingSends: Map<string, PendingSend>;
  /**
   * Turns the user stopped that have not settled backend-side yet. The abort is
   * not instantaneous — pi may stream a few more events while it winds down —
   * and without this latch those events would flip the slice back to
   * `running: true`, which reads as "the Stop button didn't work". Ids are
   * removed by the turn's terminal event (or on process exit / interrupt error).
   */
  interruptedTurns: Set<string>;
  nextSendNonce(): number;
}

/** Bound on interruptedTurns: a settled event normally clears the id, this cap
 * only guards against terminal events lost to a reconnect. */
const INTERRUPTED_TURN_CAP = 32;

/** Latch a turn as user-stopped, aging out the oldest id past the cap. */
export function noteInterruptedTurn(core: SessionCore, turnId: string): void {
  core.interruptedTurns.add(turnId);
  while (core.interruptedTurns.size > INTERRUPTED_TURN_CAP) {
    const oldest = core.interruptedTurns.values().next().value as string | undefined;
    if (oldest === undefined) break;
    core.interruptedTurns.delete(oldest);
  }
}

export function createSessionCore(): SessionCore {
  let nonce = 0;
  return {
    store: new SessionStore(),
    turnMeta: new Map(),
    settledTurns: new SettledTurns(),
    pendingSends: new Map(),
    interruptedTurns: new Set(),
    nextSendNonce: () => ++nonce
  };
}

// ---- Backend event pipeline ----

export interface TurnEventHost {
  /** Map an event's thread id to the state key it applies to; null drops it.
   * Hosts do their filtering here (deleted threads in main, the ignore set and
   * thread-id adoption in the overlay). `threadId` is undefined for thread-less
   * events (process/exit is handled before routing and never reaches this). */
  routeEvent(threadId: string | undefined, event: BackendEventEnvelope): string | null;
  /** Status the slice settles into (drives the chat row's dot). */
  settledStatus(method: TurnSettledMethod, threadId: string): ThreadStatus;
  /** Every turn/failed, before routing — main classifies auth-looking failures. */
  onTurnFailed?(error: string | undefined, turnId: string | undefined): void;
  /** After process-exit state is applied; wasRunning = some slice was mid-turn. */
  onProcessExit?(wasRunning: boolean): void;
}

export interface AttachedEvents {
  detach(): void;
  /** Synchronously apply buffered deltas (see EventBatcher.flush). */
  flush(): void;
}

interface AttachOptions {
  /** Injectable for tests; defaults to the preload bridge subscription. */
  subscribe?(handler: (event: BackendEventEnvelope) => void): () => void;
  /** Injectable for tests (the real batcher touches rAF/document). */
  makeBatcher?: typeof createEventBatcher;
}

/**
 * Install the batched backend-event subscription: deltas are coalesced to one
 * state update per animation frame; everything else applies immediately, after
 * flushing that thread's buffered delta so ordering is preserved exactly.
 */
export function attachBackendEvents(
  core: SessionCore,
  host: TurnEventHost,
  opts: AttachOptions = {}
): AttachedEvents {
  const { store } = core;

  const applyEvent = (event: BackendEventEnvelope): void => {
    if (event.method === 'process/exit') {
      // The backend died: every in-flight turn is gone. Reset all slices, drop
      // pending sends (their start promises reject, or their turns will never
      // settle), and let the host classify a possible auth-death.
      const wasRunning = Object.values(store.snapshot()).some((s) => s.running);
      store.update((prev) => {
        const next: Record<string, ThreadState> = {};
        for (const [key, s] of Object.entries(prev)) next[key] = applyProcessExitToThread(s);
        return next;
      });
      core.pendingSends.clear();
      core.interruptedTurns.clear();
      host.onProcessExit?.(wasRunning);
      return;
    }

    const threadId = backendEventThreadId(event);
    if (event.method === 'turn/failed') {
      const params = event.params as { error?: string; turn?: { id?: string } } | undefined;
      host.onTurnFailed?.(params?.error, params?.turn?.id);
    }
    if (isSettledMethod(event.method)) {
      const turnId = (event.params as { turn?: { id?: string } } | undefined)?.turn?.id;
      if (turnId) {
        // Global bookkeeping happens before routing so a dropped (deleted/
        // ignored) thread still clears its pending record and the settled-race
        // guard still sees the terminal event.
        core.settledTurns.note(turnId);
        core.interruptedTurns.delete(turnId);
        for (const [key, pending] of core.pendingSends) {
          if (pending.turnId === turnId) core.pendingSends.delete(key);
        }
      }
    }

    const key = host.routeEvent(threadId, event);
    if (!key) return;
    store.update((prev) => {
      const next = applyBackendEventToThread(prev[key] ?? EMPTY_STATE, event, {
        turnMeta: core.turnMeta,
        settledStatus: (method, id) => host.settledStatus(method, id)
      });
      if (!next) return prev;
      // A turn the user stopped keeps streaming briefly while the backend abort
      // takes effect. Its content still applies (the transcript stays truthful),
      // but it must not resurrect the running state Stop just cleared — that
      // reads as the Stop button silently failing. Terminal events are exempt:
      // their id was removed from the latch above, so they settle normally.
      const eventTurn = (event.params as { turnId?: string } | undefined)?.turnId;
      const stopped = eventTurn !== undefined && core.interruptedTurns.has(eventTurn);
      return {
        ...prev,
        [key]: stopped
          ? {
              ...next,
              running: false,
              streamingId: null,
              activeTurnId: null,
              activity: null,
              status: next.status === 'running' ? ('idle' as const) : next.status
            }
          : next
      };
    });
  };

  const batcher = (opts.makeBatcher ?? createEventBatcher)(applyEvent);
  const subscribe = opts.subscribe ?? ((handler) => window.stem.onBackendEvent(handler));
  const unsubscribe = subscribe((event) => batcher.push(event));
  return {
    detach: unsubscribe,
    flush: () => batcher.flush()
  };
}

/**
 * Reconcile every slice against what the server says is running, which is what a
 * client is handed the moment its event stream (re)connects.
 *
 * A window that missed part of the stream has no way to tell "this turn is still
 * going" from "this turn finished without me": both look like a thread that
 * stopped producing deltas, and they need opposite things on screen — a spinner
 * that never resolves, or an answer that never appears. The server knows, so it
 * says, and this is where being told turns into state.
 *
 * The list is authoritative in both directions, with one exception that matters:
 * a slice is only settled if the backend had already acknowledged a turn in it
 * (`activeTurnId`). A send whose optimistic spinner is up but whose first event
 * has not arrived yet is not stale — it is early — and clearing it would take the
 * Stop button away from a turn that is about to start.
 *
 * Slices are never created here. A thread nobody has opened has no state to
 * correct, and inventing an empty running one would make the next open show a
 * blank conversation (it would look like a live slice worth keeping).
 */
export function applyLiveTurns(core: SessionCore, turns: LiveTurn[]): void {
  const liveByThread = new Map(turns.map((t) => [t.threadId, t.turnId]));
  const liveTurnIds = new Set(turns.map((t) => t.turnId).filter((id): id is string => !!id));
  core.store.update((prev) => {
    let changed = false;
    const next: ThreadStates = { ...prev };
    for (const [key, slice] of Object.entries(prev)) {
      if (liveByThread.has(key)) {
        const turnId = liveByThread.get(key) ?? slice.activeTurnId;
        if (slice.running && slice.activeTurnId === turnId) continue;
        next[key] = { ...slice, running: true, status: 'running', activeTurnId: turnId };
        changed = true;
        continue;
      }
      // The overlay's key and the main window's DRAFT sentinel are not thread
      // ids, so they can never match above — they are settled here by turn id
      // instead, which is the same test and the one that is actually correct.
      if (slice.running && slice.activeTurnId && !liveTurnIds.has(slice.activeTurnId)) {
        next[key] = applyProcessExitToThread(slice);
        changed = true;
      }
    }
    return changed ? next : prev;
  });
}

// ---- Sending a turn ----

export interface SendSpec {
  /** State key the optimistic bubble and run state live under. */
  key: string;
  text: string;
  attachments: TurnAttachment[];
  /** Stamped into turnMeta so the reply's avatar tooltip knows what produced it. */
  meta: MessageMeta;
  /** This send creates the chat (retract must delete it, not roll back). */
  isNewChat: boolean;
  /** DRAFT generation this send belongs to (main-window drafts only). Presence
   * also switches the double-send guard to per-generation blocking. */
  draftGeneration?: number;
  /** Capture the sent slice for a later draft→real migration (main window). */
  captureDraftMessages?: boolean;
  /** `turnId` is minted here, before the call, and must be forwarded into
   * StartTurnInput — it is what lets Stop cancel this send while the start is
   * still in flight. */
  start(input: { text: string; attachments: TurnAttachment[]; turnId: string }): Promise<StartTurnResult>;
  /** Host continuation for a real (non-handled) start: draft→real migration in
   * main, thread adoption in the overlay. Runs regardless of ownership — hosts
   * do their own ownership checks (main still migrates a superseded draft's turn
   * under its real id; the overlay bails out). */
  onStarted?(
    result: StartTurnResult,
    ctx: { pending: PendingSend; alreadySettled: boolean; userMsgId: string }
  ): void;
  /** After a handled (no-turn) result is applied; only called for the key's owner. */
  onHandled?(result: StartTurnResult): void;
}

/**
 * The shared optimistic-send skeleton: double-send guard, optimistic user bubble,
 * pending-send registration, async attachment-thumbnail upgrade, settled-race
 * handling, handled-result application, and the ownership-guarded error path.
 */
/** Client-side turn id. crypto.randomUUID exists in Chromium and Node; the
 * fallback only serves exotic test environments — the backend re-mints any id it
 * cannot validate as a UUID, so a fallback id merely loses pre-start Stop. */
function mintTurnId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function sendTurn(core: SessionCore, spec: SendSpec): Promise<void> {
  const { store, pendingSends } = core;
  const { key } = spec;
  // Registration below is synchronous, so this closes the double-click window
  // before the store commits `running`. A key — especially the main window's
  // shared DRAFT sentinel — must never own two unresolved starts.
  if (
    pendingStartBlocksSend(pendingSends.get(key), spec.draftGeneration !== undefined, spec.draftGeneration ?? 0) ||
    store.getThread(key)?.running
  ) {
    return;
  }

  const sentAttachments = spec.attachments.map((att) => ({ ...att }));
  const userMsgId = `user-${Date.now()}-${core.nextSendNonce()}`;
  const optimisticMessage: ChatMessage = {
    id: userMsgId,
    role: 'user',
    content: spec.text,
    attachments: sentAttachments.length ? optimisticMessageAttachments(sentAttachments) : undefined,
    turnAttachments: sentAttachments,
    createdAt: new Date().toISOString()
  };
  const draftMessages = spec.captureDraftMessages
    ? [...(store.getThread(key)?.messages ?? []), optimisticMessage]
    : undefined;
  store.patch(key, (s) => ({
    messages: [...s.messages, optimisticMessage],
    running: true,
    activity: null,
    activities: [],
    status: 'running'
  }));

  // Minted client-side so Stop can name this turn from the very first moment —
  // the backend adopts the id, and can cancel the start it identifies even
  // while the RPC is still queued behind another turn.
  const turnId = mintTurnId();
  const startPromise = Promise.resolve().then(() =>
    spec.start({ text: spec.text, attachments: sentAttachments, turnId })
  );
  const pending: PendingSend = {
    promise: startPromise,
    turnId,
    threadId: null,
    isNewChat: spec.isNewChat,
    text: spec.text,
    attachments: sentAttachments,
    ...(spec.draftGeneration !== undefined ? { draftGeneration: spec.draftGeneration } : {}),
    ...(draftMessages ? { draftMessages } : {})
  };
  pendingSends.set(key, pending);

  // Upgrade on-disk image chips to thumbnails independently of turn startup.
  // Failure is display-only; the backend still receives the original inputs. The
  // bubble is looked up across every slice because a draft may migrate to its
  // real thread while the preview read is in flight.
  if (sentAttachments.length) {
    void toMessageAttachments(sentAttachments)
      .then((displayAttachments) => {
        store.update((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [k, state] of Object.entries(prev)) {
            if (!state.messages.some((m) => m.id === userMsgId)) continue;
            next[k] = {
              ...state,
              messages: state.messages.map((m) =>
                m.id === userMsgId ? { ...m, attachments: displayAttachments } : m
              )
            };
            changed = true;
          }
          return changed ? next : prev;
        });
      })
      .catch(() => undefined);
  }

  try {
    const result = await startPromise;
    pending.turnId = result.turnId ?? null;
    pending.threadId = result.threadId ?? null;
    const alreadySettled = core.settledTurns.consume(result.turnId);
    if (result.turnId) core.turnMeta.set(result.turnId, spec.meta);
    if (result.handled) {
      // An older abandoned start may finish after a newer one replaced it. Only
      // the key's current owner may settle this slice.
      if (!deletePendingIfCurrent(pendingSends, key, pending)) return;
      store.patch(key, (s) => ({
        messages: result.assistantMessage
          ? [
              ...s.messages,
              {
                id: `assistant-${Date.now()}`,
                role: 'assistant' as const,
                content: result.assistantMessage
              }
            ]
          : s.messages,
        running: false,
        activeTurnId: null,
        status: 'idle'
      }));
      spec.onHandled?.(result);
      return;
    }
    spec.onStarted?.(result, { pending, alreadySettled, userMsgId });
  } catch (e) {
    // A stale failure belongs to the abandoned send, not to whichever newer send
    // now occupies the key.
    if (deletePendingIfCurrent(pendingSends, key, pending)) {
      // Mark the orphaned bubble: no turn exists for it, so the message actions
      // must take the local failed-send path (see removeFailedSend).
      store.patch(key, (s) =>
        appendSystemMessage(
          {
            ...s,
            messages: s.messages.map((m) => (m.id === userMsgId ? { ...m, sendFailed: true } : m))
          },
          e
        )
      );
    }
  }
}

/**
 * Retract a failed send from the slice: the orphaned user bubble plus the error
 * bubble(s) right after it. The send never reached the backend (startTurn
 * rejected), so this is a pure local splice — no rollback. Returns the original
 * text/attachments so retry/edit can re-send; delete ignores them. Returns null
 * (no-op) while the slice is running or when the message isn't a failed send.
 */
export function removeFailedSend(
  core: SessionCore,
  key: string,
  userMsgId: string
): { text: string; attachments: TurnAttachment[] } | null {
  const slice = core.store.getThread(key);
  if (!slice || slice.running) return null;
  const idx = slice.messages.findIndex((m) => m.id === userMsgId && m.role === 'user' && m.sendFailed);
  if (idx === -1) return null;
  const msg = slice.messages[idx];
  // The failure bubble(s) directly after the message go with it. Turn-level error
  // bubbles carry a turnId and are left alone — they belong to a real turn.
  let end = idx + 1;
  while (end < slice.messages.length && slice.messages[end].role === 'system' && !slice.messages[end].turnId) {
    end += 1;
  }
  core.store.patch(key, (s) => ({
    messages: [...s.messages.slice(0, idx), ...s.messages.slice(end)],
    status: s.status === 'error' ? ('idle' as const) : s.status
  }));
  return { text: msg.content, attachments: resendAttachments(msg) };
}

// ---- Turn actions shared by both windows ----

interface InterruptOptions {
  /** Key the pending send and activeTurnId are looked up under. */
  pendingKey: string;
  /** Where the stopped patch lands; defaults to pendingKey. Main resolves the
   * real thread id here (a draft's send may have migrated mid-flight). */
  resolveTargetKey?(pending: PendingSend | undefined): string;
  /** Injectable for tests; defaults to the preload bridge. */
  interrupt?(turnId: string): Promise<void>;
}

/** Stop the visible chat's running turn. Sends carry a client-minted turn id, so
 * this can interrupt (or cancel) a turn whose start IPC is still in flight. */
export async function interruptActiveTurn(core: SessionCore, opts: InterruptOptions): Promise<void> {
  const pending = core.pendingSends.get(opts.pendingKey);
  const turnId = await interruptibleTurnId(core.store.getThread(opts.pendingKey)?.activeTurnId, pending);
  if (!turnId) return; // handled/rejected starts settle through their own send path
  const targetKey = opts.resolveTargetKey?.(pending) ?? opts.pendingKey;
  const doInterrupt = opts.interrupt ?? ((id: string) => window.stem.interruptTurn(id));
  // Latched before the call: the backend abort is not instantaneous, and events
  // it still emits while winding down must not flip the slice back to running.
  noteInterruptedTurn(core, turnId);
  try {
    await doInterrupt(turnId);
    core.store.patch(targetKey, () => ({
      running: false,
      streamingId: null,
      activity: null,
      activities: [],
      activeTurnId: null,
      status: 'idle' as const
    }));
  } catch (e) {
    // The stop never reached the backend — the turn is genuinely still running,
    // so let its events keep the slice live again.
    core.interruptedTurns.delete(turnId);
    core.store.patch(targetKey, (s) => appendSystemMessage(s, e));
  }
}

interface RerunOptions {
  key: string;
  /** Backend thread the rollback applies to (the overlay's key isn't a thread id). */
  threadId: string;
  turnId: string;
  text: string;
  send(text: string, attachments: TurnAttachment[]): void;
  rollback?(threadId: string, turnId: string): Promise<void>;
}

/** Roll back to (and including) a turn on the backend, drop that turn and
 * everything after it from the visible slice, then re-send `text` as a fresh
 * turn. Shared by retry (same text) and edit (new text). No-op while running. */
export async function rerunFromTurn(core: SessionCore, opts: RerunOptions): Promise<void> {
  const slice = core.store.getThread(opts.key);
  if (!slice || slice.running) return;
  const userIdx = slice.messages.findIndex((m) => m.turnId === opts.turnId && m.role === 'user');
  if (userIdx === -1) return;
  const originalAttachments = resendAttachments(slice.messages[userIdx]);
  const doRollback = opts.rollback ?? ((t: string, id: string) => window.stem.rollbackToTurn(t, id));
  try {
    await doRollback(opts.threadId, opts.turnId);
  } catch (e) {
    core.store.patch(opts.key, (s) => appendSystemMessage(s, e));
    return;
  }
  // Truncate to before this turn's user message; `send` re-appends + streams.
  core.store.patch(opts.key, (s) => ({ messages: s.messages.slice(0, userIdx) }));
  opts.send(opts.text, originalAttachments);
}

interface DeleteFromTurnOptions {
  key: string;
  threadId: string;
  turnId: string;
  /** Deleting the first turn would hit rollback's "no earlier history" guard, so
   * that case removes the whole chat — how is host-specific. */
  onDeleteFirstTurn(): void | Promise<void>;
  rollback?(threadId: string, turnId: string): Promise<void>;
}

/** Delete this turn and everything after it (same JSONL trim as retry, no re-send). */
export async function deleteFromTurn(core: SessionCore, opts: DeleteFromTurnOptions): Promise<void> {
  const slice = core.store.getThread(opts.key);
  if (!slice || slice.running) return;
  const userIdx = slice.messages.findIndex((m) => m.turnId === opts.turnId && m.role === 'user');
  if (userIdx === -1) return;
  if (userIdx === 0) {
    await opts.onDeleteFirstTurn();
    return;
  }
  const doRollback = opts.rollback ?? ((t: string, id: string) => window.stem.rollbackToTurn(t, id));
  try {
    await doRollback(opts.threadId, opts.turnId);
  } catch (e) {
    core.store.patch(opts.key, (s) => appendSystemMessage(s, e));
    return;
  }
  core.store.patch(opts.key, (s) => ({ messages: s.messages.slice(0, userIdx) }));
}
