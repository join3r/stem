import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, SquarePen, PanelRight, Globe, NotebookPen, Check } from 'lucide-react';
import type { ModelSummary, QuickChatSettings, TurnAttachment } from '../../shared/types';
import { ChatView } from '../chat/ChatView';
import { EFFORT_LABELS } from '../modelLabels';
import { McpApprovalCard } from '../manage/McpApprovalCard';
import { InstructionsApprovalCard } from '../manage/InstructionsApprovalCard';
import { SkillApprovalCard } from '../manage/SkillApprovalCard';
import { ExecApprovalCard } from '../manage/ExecApprovalCard';
import { NOTE_CONFIRM_MS, detectNoteTrigger, useNoteMode } from '../noteMode';
import { EMPTY_STATE, appendSystemMessage, type ThreadState } from '../chatState';
import {
  attachBackendEvents,
  createSessionCore,
  deleteFromTurn,
  interruptActiveTurn,
  removeFailedSend,
  rerunFromTurn,
  sendTurn,
  type AttachedEvents,
  type SessionCore
} from '../session/turns';
import { useThreadStates } from '../session/store';
import { useWebSearch } from '../webSearch';

// The overlay only ever shows one conversation, so its slice lives under a single
// fixed key in the shared session store (the real thread id is tracked separately
// — events are routed here by main, and the id may not be known until the first
// event or the start response arrives).
const QC_KEY = '__quickchat__';

// The Spotlight-style overlay. It now owns its own conversation: it runs turns in
// its own backend thread and streams the answer in place (the main process hides it
// on submit and re-summons it via the shortcut). A compact bar captures the first
// prompt; once there are messages it expands into a conversation panel.
export function QuickChat() {
  // Model / effort / speed / format — seeded from the saved Quick Chat defaults.
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [serviceTier, setServiceTier] = useState<string | null>(null);
  const [format, setFormat] = useState<'md' | 'mdx'>('mdx');
  // Web search, toggled independently per context — Quick Chat owns the
  // `quickChat` flag, so it can be left off here while main keeps it on.
  const { enabled: searchOn, toggle: toggleWebSearch, reload: reloadWebSearch } = useWebSearch('quickChat');

  // One conversation's state, owned by the shared session core. Store reads are
  // synchronous, which is what main's handoff barrier relies on.
  const coreRef = useRef<SessionCore | null>(null);
  if (!coreRef.current) coreRef.current = createSessionCore();
  const core = coreRef.current;
  const chatState = useThreadStates(core.store)[QC_KEY] ?? EMPTY_STATE;
  const [threadId, setThreadId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // `/note` / `//` quick-note capture in the compact bar (the expanded panel gets
  // its own instance inside ChatView).
  const { noteMode, flash: noteFlash, enterNoteMode, exitNoteMode, toggleNoteMode, saveNote } = useNoteMode();

  // Ref so the event subscription (registered once) reads the current thread id.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  // A manual New Thread aborts the old session while its final events are still
  // routed here. Ignore those events so they cannot resurrect the cleared panel.
  const ignoredThreadIdsRef = useRef(new Set<string>());
  // Handle to the attached event pipeline, so handoff snapshots can flush any
  // frame-buffered deltas before reading the store.
  const eventsRef = useRef<AttachedEvents | null>(null);

  const readChatState = useCallback(
    (): ThreadState => core.store.getThread(QC_KEY) ?? EMPTY_STATE,
    [core]
  );

  const updateChatState = useCallback(
    (update: ThreadState | ((state: ThreadState) => ThreadState)) => {
      core.store.update((prev) => {
        const base = prev[QC_KEY] ?? EMPTY_STATE;
        const next = typeof update === 'function' ? update(base) : update;
        return { ...prev, [QC_KEY]: next };
      });
    },
    [core]
  );

  const selectedModel = models.find((m) => m.id === modelId) ?? null;
  const { messages, running, streamingId, activity } = chatState;

  useEffect(() => {
    return window.stem.onQuickChatHandoffRequest(({ id, threadId: requestedThreadId }) => {
      void (async () => {
        const ownedThreadId = threadIdRef.current;
        if (ownedThreadId && ownedThreadId !== requestedThreadId) return;
        // A sidebar row appears as soon as main creates the Quick Chat thread,
        // potentially before startTurn returns its interruptible id. Do not hand
        // main an un-cancellable `running:true, activeTurnId:null` slice: wait for
        // that already-running start promise, whose own continuation updates the
        // synchronous store before this continuation runs.
        const pending = core.pendingSends.get(QC_KEY);
        if (pending && !pending.turnId) await pending.promise.catch(() => undefined);
        // Deltas may sit frame-buffered in the event batcher — apply them so the
        // snapshot main adopts contains every token already delivered here.
        eventsRef.current?.flush();
        const state = readChatState();
        window.stem.respondQuickChatHandoffRequest(id, {
          threadId: requestedThreadId,
          messages: state.messages,
          running: state.running,
          streamingId: state.streamingId,
          activity: state.activity,
          activities: state.activities,
          activeTurnId: state.activeTurnId,
          status: state.status,
          model: modelId,
          effort,
          serviceTier
        });
      })();
    });
  }, [core, readChatState, modelId, effort, serviceTier]);

  useEffect(() => {
    window.stem
      .listModels()
      .then(setModels)
      .catch(() => {});
  }, []);

  // Seed model/effort/speed from the saved Quick Chat defaults (default model
  // falls back to the backend's default when unset).
  const applyDefaults = useCallback((qc: QuickChatSettings, list: ModelSummary[]) => {
    const fallback = list.find((m) => m.isDefault) ?? list[0] ?? null;
    const wanted = qc.defaultModel && list.some((m) => m.id === qc.defaultModel) ? qc.defaultModel : fallback?.id ?? null;
    setModelId(wanted);
    setEffort(qc.defaultEffort);
    setServiceTier(qc.defaultServiceTier);
  }, []);

  useEffect(() => {
    if (!models.length) return;
    window.stem.getSettings().then((s) => applyDefaults(s.quickChat, models));
  }, [models, applyDefaults]);

  // Clear the live session and return to a fresh compact bar (New thread, or an
  // inactivity reset). Re-seed the pickers from the saved defaults.
  const resetSession = useCallback(() => {
    core.pendingSends.delete(QC_KEY);
    ignoredThreadIdsRef.current.clear();
    threadIdRef.current = null;
    setThreadId(null);
    updateChatState(EMPTY_STATE);
    setInput('');
    exitNoteMode();
    if (models.length) window.stem.getSettings().then((s) => applyDefaults(s.quickChat, models));
  }, [core, models, applyDefaults, updateChatState, exitNoteMode]);

  // Each summon: `reset` => start a fresh thread; otherwise keep showing the
  // existing session (the answer the user re-summoned to read). Always refocus.
  useEffect(() => {
    return window.stem.onQuickChatFocus(({ reset }) => {
      if (reset) resetSession();
      // The overlay window is only hidden between summons, so a Quick Chat web
      // search change made over in Settings has to be picked up here — the usual
      // `focus` event doesn't fire on show.
      reloadWebSearch();
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, [resetSession, reloadWebSearch]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Window-level Escape => dismiss the overlay, for every mode. The compact bar
  // wires Escape on its own input, but the expanded panel's ChatView composer does
  // not — so without this, Escape stops working once a session has messages. We
  // skip it when an inner handler already consumed the Escape (e.g. cancelling an
  // inline message edit calls preventDefault), so that behavior still wins.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        window.stem.hideQuickChat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Stream the overlay-owned thread through the shared pipeline. The main process
  // only forwards this thread's events to the overlay window, so every event we
  // receive belongs to the current session — we adopt its thread id if we don't
  // have it yet (events can arrive before runQuickChat resolves).
  useEffect(() => {
    const events = attachBackendEvents(core, {
      routeEvent: (eventThreadId, event) => {
        if (eventThreadId && ignoredThreadIdsRef.current.has(eventThreadId)) {
          // The abandoned session's terminal event is the last one main routes
          // here — consume it and stop ignoring that id.
          if (
            event.method === 'turn/completed' ||
            event.method === 'turn/failed' ||
            event.method === 'turn/aborted'
          ) {
            ignoredThreadIdsRef.current.delete(eventThreadId);
          }
          return null;
        }
        if (threadIdRef.current && eventThreadId && eventThreadId !== threadIdRef.current) return null;
        if (!threadIdRef.current && eventThreadId) {
          threadIdRef.current = eventThreadId;
          setThreadId(eventThreadId);
        }
        return QC_KEY;
      },
      settledStatus: () => 'idle'
    });
    eventsRef.current = events;
    return () => {
      eventsRef.current = null;
      events.detach();
    };
  }, [core]);

  const pushSystem = useCallback((e: unknown) => {
    updateChatState((s) => appendSystemMessage(s, e));
  }, [updateChatState]);

  const onSend = useCallback(
    async (text: string, attachments: TurnAttachment[] = []) => {
      await sendTurn(core, {
        key: QC_KEY,
        text,
        attachments,
        meta: { model: modelId ?? undefined, effort: effort ?? undefined, serviceTier },
        isNewChat: !threadId,
        start: (input) =>
          window.stem.runQuickChat({
            input: input.text,
            turnId: input.turnId,
            model: modelId,
            effort,
            serviceTier,
            format,
            threadId: threadId ?? undefined,
            attachments: input.attachments.length ? input.attachments : undefined
          }),
        onStarted: (result, { pending, alreadySettled, userMsgId }) => {
          // New Thread / handoff may have reset this session while start was still
          // pending. Never let the stale callback resurrect the cleared overlay.
          if (core.pendingSends.get(QC_KEY) !== pending) return;
          if (result.threadId) {
            threadIdRef.current = result.threadId;
            setThreadId(result.threadId);
          }
          if (result.turnId) {
            updateChatState((s) => ({
              ...s,
              activeTurnId: alreadySettled ? null : result.turnId ?? null,
              messages: s.messages.map((m) => (m.id === userMsgId ? { ...m, turnId: result.turnId } : m))
            }));
          }
          if (alreadySettled) core.pendingSends.delete(QC_KEY);
        },
        onHandled: (result) => {
          if (result.threadId) {
            threadIdRef.current = result.threadId;
            setThreadId(result.threadId);
          }
        }
      });
    },
    [core, modelId, effort, serviceTier, format, threadId, updateChatState]
  );

  const onInterrupt = useCallback(async () => {
    await interruptActiveTurn(core, { pendingKey: QC_KEY });
  }, [core]);

  const onRetry = useCallback(
    (turnId: string) => {
      if (!threadId) return;
      const userMsg = messages.find((m) => m.turnId === turnId && m.role === 'user');
      if (userMsg) void rerunFromTurn(core, { key: QC_KEY, threadId, turnId, text: userMsg.content, send: onSend });
    },
    [core, threadId, messages, onSend]
  );
  const onEdit = useCallback(
    (turnId: string, newText: string) => {
      if (!threadId || !newText.trim()) return;
      void rerunFromTurn(core, { key: QC_KEY, threadId, turnId, text: newText.trim(), send: onSend });
    },
    [core, threadId, onSend]
  );
  // Delete this turn and everything after it (truncate, no re-send). First turn →
  // delete the whole thread and reset to a fresh session.
  const onDelete = useCallback(
    async (turnId: string) => {
      if (!threadId) return;
      await deleteFromTurn(core, {
        key: QC_KEY,
        threadId,
        turnId,
        onDeleteFirstTurn: async () => {
          try {
            await window.stem.deleteChat(threadId);
          } catch (e) {
            pushSystem(e);
            return;
          }
          resetSession();
        }
      });
    },
    [core, threadId, resetSession, pushSystem]
  );
  // A send the backend rejected before any turn existed: its bubble and error are
  // local-only, so acting on them splices the slice and (for retry/edit) re-sends.
  const onRetryFailedSend = useCallback(
    (messageId: string) => {
      const restore = removeFailedSend(core, QC_KEY, messageId);
      if (restore) void onSend(restore.text, restore.attachments);
    },
    [core, onSend]
  );
  const onEditFailedSend = useCallback(
    (messageId: string, newText: string) => {
      const restore = removeFailedSend(core, QC_KEY, messageId);
      if (restore) void onSend(newText, restore.attachments);
    },
    [core, onSend]
  );
  const onDeleteFailedSend = useCallback(
    (messageId: string) => {
      removeFailedSend(core, QC_KEY, messageId);
    },
    [core]
  );
  // Fork: branch the thread and continue the branch in the main app.
  const onFork = useCallback(
    async (turnId: string) => {
      if (!threadId) return;
      try {
        const { threadId: newId } = await window.stem.forkThread(threadId, turnId);
        const history = await window.stem.openChat(newId);
        await window.stem.handoffQuickChat({
          threadId: newId,
          messages: history.messages,
          running: false,
          streamingId: null,
          activity: null,
          activities: [],
          activeTurnId: null,
          status: 'idle',
          model: modelId,
          effort,
          serviceTier
        });
        resetSession();
      } catch (e) {
        pushSystem(e);
      }
    },
    [threadId, modelId, effort, serviceTier, resetSession, pushSystem]
  );

  async function newThread() {
    if (resetting) return;
    setResetting(true);
    const pending = core.pendingSends.get(QC_KEY);
    const oldThreadId = threadIdRef.current;
    if (oldThreadId) ignoredThreadIdsRef.current.add(oldThreadId);
    let resolvedOldId: string | null = oldThreadId;
    try {
      if (running) await onInterrupt();
      resolvedOldId = oldThreadId ?? pending?.threadId ?? threadIdRef.current;
      if (resolvedOldId) ignoredThreadIdsRef.current.add(resolvedOldId);
      await window.stem.newQuickChatThread();
      resetSession();
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (e) {
      if (oldThreadId) ignoredThreadIdsRef.current.delete(oldThreadId);
      if (resolvedOldId) ignoredThreadIdsRef.current.delete(resolvedOldId);
      pushSystem(e);
    } finally {
      setResetting(false);
    }
  }

  async function openInStem() {
    if (!threadId) return;
    try {
      // Flush frame-buffered deltas so the adopted snapshot is complete.
      eventsRef.current?.flush();
      const state = readChatState();
      await window.stem.handoffQuickChat({
        threadId,
        messages: state.messages,
        running: state.running,
        streamingId: state.streamingId,
        activity: state.activity,
        activities: state.activities,
        activeTurnId: state.activeTurnId,
        status: state.status,
        model: modelId,
        effort,
        serviceTier
      });
      resetSession();
    } catch (e) {
      pushSystem(e);
    }
  }

  function submitCompact() {
    const text = input.trim();
    if (!text) return;
    if (noteMode) {
      // Saved locally, no turn — so don't go through quickchat:run (it would hide
      // the overlay and flash the HUD). Show the ✓ here, then collapse ourselves.
      void saveNote(text).then((saved) => {
        if (!saved) return;
        setInput('');
        window.setTimeout(() => window.stem.hideQuickChat(), NOTE_CONFIRM_MS);
      });
      return;
    }
    setInput('');
    onSend(text, []);
  }

  const efforts =
    selectedModel && selectedModel.supportedEfforts.length ? selectedModel.supportedEfforts : ['low', 'medium', 'high'];
  const fastTier = selectedModel?.serviceTiers.find((t) => t.id === 'priority');
  const hasFast = selectedModel ? !!fastTier : true;

  // Web-search toggle for the compact bar. Search is served by the vendored
  // pi-web-access extension rather than the provider, so unlike before there is no
  // model for which this control has to hide itself — it renders unconditionally.
  // The expanded panel doesn't repeat it here: there it is one of the composer's
  // controls, next to Note, exactly as in the main window.
  const searchToggle = (
    <div className="seg-ctl compact" role="group" aria-label="Web search">
      <button
        type="button"
        className={searchOn ? 'active' : ''}
        onClick={() => toggleWebSearch(!searchOn)}
        title={
          searchOn
            ? 'Web search on — Stem may search the live web, with citations'
            : 'Web search off — Stem answers from what it already knows'
        }
      >
        <Globe size={13} /> Web
      </button>
    </div>
  );

  // Expanded conversation panel once the session has any messages.
  if (messages.length > 0) {
    return (
      <div className="qc-root">
        <div className="qc-card qc-panel">
          <div className="qc-head">
            <Sparkles className="qc-mark" size={18} />
            <span className="qc-spacer" />
            <button className="qc-act" title="New thread" onClick={() => void newThread()} disabled={resetting}>
              <SquarePen size={15} />
            </button>
            <button className="qc-act" title="Open in Stem" onClick={() => void openInStem()} disabled={!threadId}>
              <PanelRight size={15} />
            </button>
            <span className="qc-esc" onClick={() => window.stem.hideQuickChat()}>
              esc
            </span>
          </div>
          <ChatView
          messages={messages}
          running={running}
          streamingId={streamingId}
          activity={activity}
          activities={chatState.activities}
          onSend={onSend}
          onInterrupt={onInterrupt}
          escapeAction="off"
          onRetractActiveTurn={() => {}}
          pendingRestore={null}
          onRestoreConsumed={() => {}}
          onRetry={onRetry}
          onEdit={onEdit}
          onFork={onFork}
          onDelete={onDelete}
          onRetryFailedSend={onRetryFailedSend}
          onEditFailedSend={onEditFailedSend}
          onDeleteFailedSend={onDeleteFailedSend}
          models={models}
          model={selectedModel}
          effort={effort}
          serviceTier={serviceTier}
          format={format}
          draftFolderName={null}
          showContextMeter={false}
            onChangeEffort={setEffort}
            onChangeSpeed={setServiceTier}
            onChangeFormat={setFormat}
            webSearch={searchOn}
            onToggleWebSearch={toggleWebSearch}
            onNoteSaved={() => window.stem.hideQuickChat()}
          />
        </div>
        <McpApprovalCard />
        <InstructionsApprovalCard />
        <SkillApprovalCard />
        <ExecApprovalCard />
      </div>
    );
  }

  // Compact spotlight bar for a fresh session.
  return (
    <div className="qc-root">
      <div className="qc-card">
        <div className="qc-row">
          {noteMode ? <NotebookPen className="qc-mark" size={22} /> : <Sparkles className="qc-mark" size={22} />}
          <input
            ref={inputRef}
            className="qc-input"
            value={input}
            placeholder={noteMode ? 'Save a note to memory…' : 'Ask Stem anything…'}
            onChange={(e) => {
              const value = e.target.value;
              const trigger = noteMode ? null : detectNoteTrigger(value);
              if (trigger) {
                enterNoteMode();
                setInput(trigger.body);
              } else {
                setInput(value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitCompact();
              } else if (e.key === 'Escape' && noteMode) {
                // First Escape leaves note mode; the preventDefault keeps the
                // window-level handler from hiding the overlay on this press.
                e.preventDefault();
                exitNoteMode();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                window.stem.hideQuickChat();
              }
            }}
          />
          <span className="qc-esc">esc</span>
        </div>
        <div className="qc-foot">
          <div className="seg-ctl compact" role="group" aria-label="Reasoning effort">
            {efforts.map((e) => (
              <button key={e} type="button" className={effort === e ? 'active' : ''} onClick={() => setEffort(e)}>
                {EFFORT_LABELS[e] ?? e}
              </button>
            ))}
          </div>
          {hasFast && (
            <div className="seg-ctl compact" role="group" aria-label="Speed">
              <button type="button" className={serviceTier === 'priority' ? '' : 'active'} onClick={() => setServiceTier(null)}>
                Standard
              </button>
              <button
                type="button"
                className={serviceTier === 'priority' ? 'active' : ''}
                onClick={() => setServiceTier('priority')}
                title={fastTier?.description ?? '1.5× speed, increased usage'}
              >
                Fast
              </button>
            </div>
          )}
          {searchToggle}
          <div className="seg-ctl compact" role="group" aria-label="Memory note">
            <button
              type="button"
              className={noteMode ? 'active' : ''}
              onClick={toggleNoteMode}
              title="Save a note to memory — or type /note or //"
            >
              <NotebookPen size={13} /> Note
            </button>
          </div>
          <span className="qc-spacer" />
          {noteFlash ? (
            <span className={`note-flash${noteFlash === 'saved' ? ' ok' : ''}`} role="status" aria-live="polite">
              {noteFlash === 'saved' && <><Check size={13} /> Saved to memory</>}
              {noteFlash === 'off' && 'Memory is off — note not saved'}
              {noteFlash === 'secret' && 'Looks like a credential — not saved'}
              {noteFlash === 'error' && 'Couldn’t save the note — try restarting Stem'}
            </span>
          ) : (
            <span className="qc-hint">
              <kbd>⏎</kbd> {noteMode ? 'save note' : 'send'}
            </span>
          )}
        </div>
      </div>
      <McpApprovalCard />
      <InstructionsApprovalCard />
      <SkillApprovalCard />
      <ExecApprovalCard />
    </div>
  );
}
