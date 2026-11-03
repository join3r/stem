import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, SquarePen, PanelRight, Globe, NotebookPen, Check, Zap, X, Plug, PlugZap, AppWindow, Plus } from 'lucide-react';
import type { ModelSummary, QuickChatSettings, QuickChatTabs, QuickChatWindow, TurnAttachment, WindowMcpSuggestion } from '../../shared/types';
import { ChatView } from '../chat/ChatView';
import { EffortModelControl } from '../ui/EffortModelControl';
import { McpApprovalCard } from '../manage/McpApprovalCard';
import { InstructionsApprovalCard } from '../manage/InstructionsApprovalCard';
import { SkillApprovalCard } from '../manage/SkillApprovalCard';
import { ApprovalCard, MissedApprovalDialog } from '../manage/ApprovalCard';
import { approvalKey, approvalsElsewhere, approvalsForThread } from '../manage/approvalQueue';
import { useApprovals } from '../manage/approvalStore';
import { NOTE_CONFIRM_MS, NOTE_FLASH_TEXT, detectNoteTrigger, pasteLandsInCommand, useNoteMode } from '../noteMode';
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
  // "Ask about this window" panels hold several conversations about the same
  // window as tabs; this overlay is one of them. Null for the plain panel.
  const [tabs, setTabs] = useState<QuickChatTabs | null>(null);
  useEffect(() => window.stem.onQuickChatTabs(setTabs), []);

  // Permission asks. This thread's own ride inside the expanded ChatView like in
  // the main window; an ask from any other thread has no chat here to sit in and
  // stays a dialog — the overlay is opened for one question and dismissed, so a
  // notice bar pointing at a chat it cannot open would be no help.
  const { pending: pendingApprovals } = useApprovals();
  const ownApprovals = approvalsForThread(pendingApprovals, threadId);
  const otherApprovals = approvalsElsewhere(pendingApprovals, threadId);

  const [input, setInput] = useState('');
  // "Ask about this window": the window the user summoned from, shown as a chip
  // until it goes out with the first prompt or the user removes it.
  const [windowChip, setWindowChip] = useState<QuickChatWindow | null>(null);
  // The window this overlay session was summoned for, kept after the chip goes
  // out with a prompt: ⌘N starts a fresh question about the same window, the
  // way main keeps the panel docked beside it. A plain summon that resets forgets it.
  const summonedWindowRef = useRef<QuickChatWindow | null>(null);
  // The MCP servers that cover the chip's app (Manage → MCP → Works with apps),
  // the app's official server when none does yet, and — over a browser —
  // whether chats may use browser control at all.
  const [windowServers, setWindowServers] = useState<string[]>([]);
  const [suggestion, setSuggestion] = useState<WindowMcpSuggestion | null>(null);
  const [browserAllowed, setBrowserAllowed] = useState<boolean | null>(null);
  const [matchRound, setMatchRound] = useState(0);
  useEffect(() => {
    setWindowServers([]);
    setSuggestion(null);
    if (!windowChip) return;
    let live = true;
    const { app, bundleId, url } = windowChip;
    // quiet: an older server cannot match; the chip then just shows no server.
    window.stem
      .mcpServersForApp(app, bundleId, url)
      .then((names) => live && setWindowServers(names))
      .catch(() => undefined);
    // quiet: an older server has no catalog; the chip offers nothing.
    window.stem
      .mcpWindowSuggestion(app, bundleId, url)
      .then((s) => live && setSuggestion(s && !offerDismissed(s.entry.id) ? s : null))
      .catch(() => undefined);
    if (windowChip.browserReady !== undefined) {
      window.stem
        .getSettings()
        .then((s) => live && setBrowserAllowed(!!s.chatFeatures?.browser?.allow))
        // quiet: unknown reads as allowed, so the chip says what the extension says.
        .catch(() => live && setBrowserAllowed(true));
    }
    return () => {
      live = false;
    };
  }, [windowChip, matchRound]);
  const inputRef = useRef<HTMLInputElement>(null);
  // `/note` / `//` quick-note capture in the compact bar (the expanded panel gets
  // its own instance inside ChatView).
  const { noteMode, flash: noteFlash, enterNoteMode, exitNoteMode, toggleNoteMode, saveNote } = useNoteMode();
  // Pasted `//…` or `/note …` is text, not a switch into note mode (same rule
  // as the Composer): the flag lasts while the input still starts with `/`.
  const pasteRef = useRef(false);
  const literalRef = useRef(false);

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

  // Switching models mid-overlay: clamp effort to what the new model supports and
  // drop a Fast selection its provider doesn't offer — the same rule as main.
  const onSelectModel = useCallback(
    (id: string) => {
      const m = models.find((x) => x.id === id);
      setModelId(id);
      if (m) {
        setEffort((e) => (e && m.supportedEfforts.includes(e) ? e : m.defaultEffort));
        if (!m.serviceTiers.some((t) => t.id === 'priority')) setServiceTier(null);
      }
    },
    [models]
  );

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
    setWindowChip(null);
    exitNoteMode();
    if (models.length) window.stem.getSettings().then((s) => applyDefaults(s.quickChat, models));
  }, [core, models, applyDefaults, updateChatState, exitNoteMode]);

  // Each summon: `reset` => start a fresh thread; otherwise keep showing the
  // existing session (the answer the user re-summoned to read). Always refocus.
  useEffect(() => {
    return window.stem.onQuickChatFocus(({ reset, window: summonedFor }) => {
      if (reset) resetSession();
      if (summonedFor) {
        summonedWindowRef.current = summonedFor;
        setWindowChip(summonedFor);
      } else if (reset) {
        summonedWindowRef.current = null;
      }
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
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void newThreadRef.current();
      } else if (tabKeyRef.current(e)) {
        e.preventDefault();
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

  // Before the first turn the toggle only picks the new chat's format; once the
  // session has a thread it switches that chat on the server too, so its next
  // turn runs on a worker of the other kind (see chats:setFormat).
  const onChangeFormat = useCallback((next: 'md' | 'mdx') => {
    setFormat(next);
    const id = threadIdRef.current;
    // quiet: a failed switch leaves the chat in its stored format; the next
    // turn still runs, just in the old one.
    if (id) void window.stem.setChatFormat(id, next).catch(() => undefined);
  }, []);

  const onSend = useCallback(
    async (text: string, attachments: TurnAttachment[] = [], windowId?: number) => {
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
            attachments: input.attachments.length ? input.attachments : undefined,
            windowId
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
              messages: s.messages.map((m) => (m.id === userMsgId ? { ...m, turnId: m.turnId ?? result.turnId, runtimeTurnId: result.turnId } : m))
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

  // The panel emptied while on screen (New thread, deleted thread, or the
  // window shortcut starting a fresh session): shrink the window back to the
  // compact bar. Only on the >0 → 0 edge — sending from the bar hides the
  // overlay, so the opposite edge never happens on screen. The bar keeps room
  // for a window chip, or the chip pushes the model row out of sight.
  const hadMessagesRef = useRef(messages.length > 0);
  useEffect(() => {
    const has = messages.length > 0;
    if (hadMessagesRef.current && !has) void window.stem.compactQuickChat(!!windowChip);
    hadMessagesRef.current = has;
    // windowChip is read, not watched: removing the chip must not shrink the bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

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
      const fresh = await window.stem.newQuickChatThread();
      resetSession();
      // A fresh picture of the same window; a closed window drops the chip.
      if (fresh) summonedWindowRef.current = fresh.window;
      if (summonedWindowRef.current) setWindowChip(summonedWindowRef.current);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (e) {
      if (oldThreadId) ignoredThreadIdsRef.current.delete(oldThreadId);
      if (resolvedOldId) ignoredThreadIdsRef.current.delete(resolvedOldId);
      pushSystem(e);
    } finally {
      setResetting(false);
    }
  }

  // ⌘N reaches newThread through a ref: the key listener is registered once.
  const newThreadRef = useRef(newThread);
  newThreadRef.current = newThread;

  // Closing this tab: stop its answer first (only this overlay holds the
  // turn's ids), then main lets the tab go once the turn has wound down.
  async function closeSelf() {
    if (!tabs) return;
    if (running) await onInterrupt();
    await window.stem.closeQuickChatTab(tabs.self);
  }
  const closeSelfRef = useRef(closeSelf);
  closeSelfRef.current = closeSelf;
  useEffect(() => window.stem.onQuickChatCloseTab(() => void closeSelfRef.current()), []);

  function closeTab(id: string) {
    if (tabs && id === tabs.self) void closeSelf();
    else void window.stem.closeQuickChatTab(id);
  }

  // ⌘T new tab, ⌘W close this one, ⌘⇧[ / ⌘⇧] the tab before / after. True when the key was one of them.
  function tabKey(e: KeyboardEvent): boolean {
    if (!tabs || !(e.metaKey || e.ctrlKey) || e.altKey) return false;
    const key = e.key.toLowerCase();
    if (!e.shiftKey && key === 't') {
      if (tabs.canAdd) void window.stem.newQuickChatTab();
      return true;
    }
    if (!e.shiftKey && key === 'w') {
      void closeSelf();
      return true;
    }
    if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      const list = tabs.tabs;
      const at = list.findIndex((t) => t.id === tabs.self);
      const next = list[(at + (e.code === 'BracketRight' ? 1 : -1) + list.length) % list.length];
      if (next && next.id !== tabs.self) void window.stem.switchQuickChatTab(next.id);
      return true;
    }
    return false;
  }
  const tabKeyRef = useRef(tabKey);
  tabKeyRef.current = tabKey;

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
    const chip = windowChip;
    setWindowChip(null);
    if (!chip) {
      onSend(text, []);
      return;
    }
    // The picture goes as an ordinary image attachment (so the chat shows what
    // was asked about); main adds the window's text by its id.
    const picture: TurnAttachment[] = chip.imageBase64
      ? [{ name: `${chip.app} window.jpg`, dataBase64: chip.imageBase64, mime: 'image/jpeg' }]
      : [];
    onSend(text, picture, chip.windowId);
  }

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
            {tabs ? <TabStrip tabs={tabs} onClose={closeTab} /> : <span className="qc-spacer" />}
            <button className="qc-act" title="New thread (⌘N)" onClick={() => void newThread()} disabled={resetting}>
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
          activeTurnId={chatState.activeTurnId}
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
          approvals={ownApprovals}
          showContextMeter={false}
            onChangeEffort={setEffort}
            onSelectModel={onSelectModel}
            onChangeSpeed={setServiceTier}
            onChangeFormat={onChangeFormat}
            webSearch={searchOn}
            onToggleWebSearch={toggleWebSearch}
            onNoteSaved={() => window.stem.hideQuickChat()}
          />
        </div>
        <McpApprovalCard />
        <InstructionsApprovalCard />
        <SkillApprovalCard />
        {otherApprovals[0] && (
          <ApprovalCard
            key={approvalKey(otherApprovals[0])}
            approval={otherApprovals[0]}
            variant="modal"
            queued={otherApprovals.length - 1}
          />
        )}
        <MissedApprovalDialog />
      </div>
    );
  }

  // Compact spotlight bar for a fresh session.
  return (
    <div className="qc-root">
      <div className="qc-card">
        {tabs && tabs.tabs.length > 1 && (
          <div className="qc-head qc-tabrow">
            <TabStrip tabs={tabs} onClose={closeTab} />
          </div>
        )}
        {windowChip && (
          <WindowChip
            chip={windowChip}
            servers={windowServers}
            suggestion={suggestion}
            browserAllowed={browserAllowed}
            onRemove={() => setWindowChip(null)}
            onDismissOffer={(id) => {
              dismissOffer(id);
              setSuggestion(null);
            }}
            onServersChanged={() => setMatchRound((n) => n + 1)}
          />
        )}
        <div className="qc-row">
          {noteMode ? <NotebookPen className="qc-mark" size={22} /> : <Sparkles className="qc-mark" size={22} />}
          <input
            ref={inputRef}
            className="qc-input"
            value={input}
            placeholder={noteMode ? 'Save a note to memory…' : windowChip ? `Ask about this ${windowChip.app} window…` : 'Ask Stem anything…'}
            onChange={(e) => {
              const value = e.target.value;
              const pasted = pasteRef.current;
              pasteRef.current = false;
              // Checked against the previous input too, so a cleared input never keeps a stale flag.
              literalRef.current = (pasted || (literalRef.current && input.startsWith('/'))) && value.startsWith('/');
              const trigger = noteMode || literalRef.current ? null : detectNoteTrigger(value);
              if (trigger) {
                enterNoteMode();
                setInput(trigger.body);
              } else {
                setInput(value);
              }
            }}
            onPaste={(e) => {
              const el = e.currentTarget;
              pasteRef.current = pasteLandsInCommand(el.value, el.selectionStart ?? 0);
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
          <EffortModelControl
            models={models}
            model={selectedModel}
            effort={effort}
            onChangeEffort={setEffort}
            onSelectModel={onSelectModel}
          />
          {hasFast && (
            <div className="seg-ctl compact" role="group" aria-label="Speed">
              <button
                type="button"
                className={serviceTier === 'priority' ? 'active' : ''}
                onClick={() => setServiceTier(serviceTier === 'priority' ? null : 'priority')}
                title={`${fastTier?.description ?? '1.5× speed, increased usage'} — off means standard speed`}
              >
                <Zap size={13} /> Fast
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
              {noteFlash === 'saved' && <Check size={13} />} {NOTE_FLASH_TEXT[noteFlash]}
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
      {/* The compact bar has no chat pane, so even this thread's ask is a dialog here. */}
      {pendingApprovals[0] && (
        <ApprovalCard
          key={approvalKey(pendingApprovals[0])}
          approval={pendingApprovals[0]}
          variant="modal"
          queued={pendingApprovals.length - 1}
        />
      )}
      <MissedApprovalDialog />
    </div>
  );
}

/**
 * The conversations open about one window, and a + that opens another with a
 * fresh picture of it. A single conversation shows only the +.
 */
function TabStrip({ tabs, onClose }: { tabs: QuickChatTabs; onClose(id: string): void }) {
  const several = tabs.tabs.length > 1;
  return (
    <div className="qc-tabs" role="tablist" aria-label="Conversations about this window">
      {several &&
        tabs.tabs.map((tab) => {
          const label = tab.label ?? 'New question';
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.active}
              className={`qc-tab${tab.active ? ' active' : ''}`}
              title={label}
              onClick={() => !tab.active && void window.stem.switchQuickChatTab(tab.id)}
              onAuxClick={(e) => e.button === 1 && onClose(tab.id)}
            >
              {tab.running ? (
                <span className="qc-tab-dot running" aria-label="Answering" />
              ) : tab.unread ? (
                <span className="qc-tab-dot" aria-label="New answer" />
              ) : null}
              <span className="qc-tab-label">{label}</span>
              <button
                type="button"
                className="qc-tab-close"
                title={tab.running ? 'Stop and close (⌘W)' : 'Close (⌘W)'}
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      <button
        type="button"
        className="qc-act"
        title={tabs.canAdd ? 'New tab about this window (⌘T)' : 'This window has as many tabs as it can hold'}
        aria-label="New tab"
        disabled={!tabs.canAdd}
        onClick={() => void window.stem.newQuickChatTab()}
      >
        <Plus size={15} />
      </button>
    </div>
  );
}

/** Apps whose "Connect its MCP server" offer was put away with "Not now" (per computer). */
const DISMISSED_KEY = 'stem.quickchat.mcpOffersDismissed';

function dismissedOffers(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function offerDismissed(entryId: string): boolean {
  return dismissedOffers().includes(entryId);
}

function dismissOffer(entryId: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...dismissedOffers(), entryId])]));
  } catch {
    // Storage blocked: the offer comes back next time, which is all that is lost.
  }
}

/**
 * The window "Ask about this window" captured: a thumbnail, which window it is,
 * and what goes with the question. A missing grant says which and opens its
 * System Settings pane; the question can still be sent without it. Beside it:
 * the MCP server that will be used for the app, or the app's official one to
 * connect (or turn back on), and over a browser, whether browser control can
 * read and act in the page.
 */
function WindowChip({
  chip,
  servers,
  suggestion,
  browserAllowed,
  onRemove,
  onDismissOffer,
  onServersChanged
}: {
  chip: QuickChatWindow;
  servers: string[];
  suggestion: WindowMcpSuggestion | null;
  browserAllowed: boolean | null;
  onRemove(): void;
  onDismissOffer(entryId: string): void;
  onServersChanged(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  const noScreen = chip.missing.includes('screen');
  const noText = chip.missing.includes('accessibility');
  const name = chip.title && chip.title !== chip.app ? `${chip.app} — ${chip.title}` : chip.app;
  const what = noScreen
    ? 'Turn on Screen Recording to attach a picture of this window'
    : noText
      ? 'Picture attached. Turn on Accessibility to add its text'
      : 'Picture and text attached';
  const grant: 'screen' | 'accessibility' | null = noScreen ? 'screen' : noText ? 'accessibility' : null;
  const isBrowser = chip.browserReady !== undefined;
  const browserOn = isBrowser && chip.browserReady && browserAllowed !== false;

  async function turnOn(server: string) {
    setBusy(true);
    setOfferError(null);
    try {
      await window.stem.setMcpServerEnabled(server, true);
      onServersChanged();
    } catch (e) {
      setOfferError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="qc-chips">
      <div className={`qc-chip${grant ? ' warn' : ''}`}>
        {chip.imageBase64 ? (
          <img className="qc-chip-thumb" src={`data:image/jpeg;base64,${chip.imageBase64}`} alt="" />
        ) : (
          <span className="qc-chip-thumb empty" />
        )}
        <span className="qc-chip-text">
          <strong title={name}>{name}</strong>
          <small>{what}</small>
        </span>
        {grant && (
          <button type="button" className="qc-chip-btn" onClick={() => void window.stem.openQuickChatPrivacy(grant)}>
            Open Settings
          </button>
        )}
        <button type="button" className="qc-act" title="Don't attach this window" aria-label="Remove window" onClick={onRemove}>
          <X size={14} />
        </button>
      </div>
      {servers.length > 0 && (
        <div className="qc-chip mcp" title={`Stem will use ${servers.join(' or ')} to read and act in ${chip.app}`}>
          <Plug size={13} />
          <span className="qc-chip-text">
            <strong>{servers.join(', ')}</strong>
            <small>MCP server for {chip.app}</small>
          </span>
        </div>
      )}
      {servers.length === 0 && suggestion && (
        <div
          className="qc-chip offer"
          title={
            offerError ??
            (suggestion.kind === 'enable'
              ? `Your ${suggestion.server} server covers ${suggestion.entry.name} but is turned off`
              : `${suggestion.entry.name} publishes an official MCP server. Connected, Stem can read and act in ${suggestion.entry.name} beyond this window.`)
          }
        >
          <PlugZap size={13} />
          <span className="qc-chip-text">
            <strong>{suggestion.entry.name}</strong>
            <small>{suggestion.kind === 'enable' ? 'MCP server is off' : 'Official MCP server'}</small>
          </span>
          {suggestion.kind === 'enable' ? (
            <button type="button" className="qc-chip-btn" disabled={busy} onClick={() => void turnOn(suggestion.server)}>
              Turn on
            </button>
          ) : (
            <button
              type="button"
              className="qc-chip-btn"
              onClick={() => void window.stem.openManageFromQuickChat('mcp', { kind: 'mcp-connect', entryId: suggestion.entry.id })}
            >
              Connect
            </button>
          )}
          <button
            type="button"
            className="qc-act"
            title="Not now — don't offer this again"
            aria-label="Not now"
            onClick={() => onDismissOffer(suggestion.entry.id)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {isBrowser && browserAllowed !== null && (
        <div
          className={`qc-chip ${browserOn ? 'mcp' : 'offer'}`}
          title={
            browserOn
              ? `Stem can read and act in this ${chip.app} tab`
              : browserAllowed === false
                ? 'Browser control is off for chats'
                : `The Stem extension is not connected in ${chip.app}`
          }
        >
          <AppWindow size={13} />
          <span className="qc-chip-text">
            <strong>Browser control</strong>
            <small>{browserOn ? 'Reads and acts in this tab' : browserAllowed === false ? 'Off for chats' : 'Not set up here'}</small>
          </span>
          {!browserOn && (
            <button
              type="button"
              className="qc-chip-btn"
              onClick={() => void window.stem.openManageFromQuickChat('settings', { kind: 'browser-control' })}
            >
              {browserAllowed === false ? 'Turn on' : 'Set up'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
