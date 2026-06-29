import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, SquarePen, PanelRight, Globe } from 'lucide-react';
import type {
  BackendEventEnvelope,
  MessageMeta,
  ModelSummary,
  NativeWebSearchSettings,
  QuickChatSettings,
  TurnAttachment
} from '../../shared/types';
import { ChatView } from '../chat/ChatView';
import { toMessageAttachments } from '../attachments';
import { EFFORT_LABELS } from '../modelLabels';
import {
  EMPTY_STATE,
  appendSystemMessage,
  applyBackendEventToThread,
  applyProcessExitToThread,
  backendEventThreadId,
  type ThreadState
} from '../chatState';

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
  // Native web search, toggled independently per context — Quick Chat owns the
  // `quickChat` flag (surfaced here since it can pick a different model than main).
  const [nativeWebSearch, setNativeWebSearch] = useState<NativeWebSearchSettings>({ main: true, quickChat: true });

  // One conversation's state (this overlay only ever holds one thread at a time).
  const [chatState, setChatState] = useState<ThreadState>(EMPTY_STATE);
  const [threadId, setThreadId] = useState<string | null>(null);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Refs so the event subscription (registered once) reads current values.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const turnMetaRef = useRef(new Map<string, MessageMeta>());

  const selectedModel = models.find((m) => m.id === modelId) ?? null;
  const { messages, running, streamingId, activity, activeTurnId } = chatState;

  useEffect(() => {
    window.stem
      .listModels()
      .then(setModels)
      .catch(() => {});
    window.stem
      .getSettings()
      .then((s) => setNativeWebSearch(s.nativeWebSearch))
      .catch(() => {});
  }, []);

  function toggleNativeSearch(enabled: boolean) {
    window.stem
      .updateNativeWebSearch({ quickChat: enabled })
      .then((s) => setNativeWebSearch(s.nativeWebSearch))
      .catch(() => {});
  }

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
    setThreadId(null);
    setChatState(EMPTY_STATE);
    setInput('');
    if (models.length) window.stem.getSettings().then((s) => applyDefaults(s.quickChat, models));
  }, [models, applyDefaults]);

  // Each summon: `reset` => start a fresh thread; otherwise keep showing the
  // existing session (the answer the user re-summoned to read). Always refocus.
  useEffect(() => {
    return window.stem.onQuickChatFocus(({ reset }) => {
      if (reset) resetSession();
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, [resetSession]);

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

  // Stream the overlay-owned thread. The main process only forwards this thread's
  // events to the overlay window, so every event we receive belongs to the current
  // session — we adopt its thread id if we don't have it yet (events can arrive
  // before runQuickChat resolves).
  useEffect(() => {
    return window.stem.onBackendEvent((event: BackendEventEnvelope) => {
      if (event.method === 'process/exit') {
        setChatState((s) => applyProcessExitToThread(s));
        return;
      }

      const eventThreadId = backendEventThreadId(event);
      if (threadIdRef.current && eventThreadId && eventThreadId !== threadIdRef.current) return;
      if (!threadIdRef.current && eventThreadId) setThreadId(eventThreadId);
      setChatState((s) =>
        applyBackendEventToThread(s, event, {
          turnMeta: turnMetaRef.current,
          settledStatus: () => 'idle'
        }) ?? s
      );
    });
  }, []);

  const pushSystem = useCallback((e: unknown) => {
    setChatState((s) => appendSystemMessage(s, e));
  }, []);

  const onSend = useCallback(
    async (text: string, attachments: TurnAttachment[] = []) => {
      const msgAttachments = attachments.length ? await toMessageAttachments(attachments) : undefined;
      const userMsgId = `user-${Date.now()}`;
      setChatState((s) => ({
        ...s,
        messages: [...s.messages, { id: userMsgId, role: 'user', content: text, attachments: msgAttachments }],
        running: true,
        activity: null,
        status: 'running'
      }));
      try {
        const result = await window.stem.runQuickChat({
          input: text,
          model: modelId,
          effort,
          serviceTier,
          format,
          threadId: threadId ?? undefined,
          attachments: attachments.length ? attachments : undefined
        });
        if (result.threadId) setThreadId(result.threadId);
        if (result.turnId) {
          turnMetaRef.current.set(result.turnId, { model: modelId ?? undefined, effort: effort ?? undefined, serviceTier });
          setChatState((s) => ({
            ...s,
            activeTurnId: result.turnId ?? null,
            messages: s.messages.map((m) => (m.id === userMsgId ? { ...m, turnId: result.turnId } : m))
          }));
        }
        if (result.handled) {
          setChatState((s) => ({
            ...s,
            messages: result.assistantMessage
              ? [...s.messages, { id: `assistant-${Date.now()}`, role: 'assistant', content: result.assistantMessage as string }]
              : s.messages,
            running: false,
            activeTurnId: null,
            status: 'idle'
          }));
        }
      } catch (e) {
        pushSystem(e);
      }
    },
    [modelId, effort, serviceTier, format, threadId, pushSystem]
  );

  const onInterrupt = useCallback(async () => {
    if (activeTurnId) await window.stem.interruptTurn(activeTurnId);
    setChatState((s) => ({ ...s, running: false, streamingId: null, activity: null, activeTurnId: null, status: 'idle' }));
  }, [activeTurnId]);

  // Retry/Edit: roll the thread back to a turn and re-send. No-op while running.
  const rerunFromTurn = useCallback(
    async (turnId: string, text: string) => {
      if (!threadId || running) return;
      const userIdx = messages.findIndex((m) => m.turnId === turnId && m.role === 'user');
      if (userIdx === -1) return;
      try {
        await window.stem.rollbackToTurn(threadId, turnId);
      } catch (e) {
        pushSystem(e);
        return;
      }
      setChatState((s) => ({ ...s, messages: s.messages.slice(0, userIdx) }));
      onSend(text, []);
    },
    [threadId, running, messages, onSend, pushSystem]
  );

  const onRetry = useCallback(
    (turnId: string) => {
      const userMsg = messages.find((m) => m.turnId === turnId && m.role === 'user');
      if (userMsg) rerunFromTurn(turnId, userMsg.content);
    },
    [messages, rerunFromTurn]
  );
  const onEdit = useCallback(
    (turnId: string, newText: string) => {
      if (newText.trim()) rerunFromTurn(turnId, newText.trim());
    },
    [rerunFromTurn]
  );
  // Delete this turn and everything after it (truncate, no re-send). First turn →
  // delete the whole thread and reset to a fresh session.
  const onDelete = useCallback(
    async (turnId: string) => {
      if (!threadId || running) return;
      const userIdx = messages.findIndex((m) => m.turnId === turnId && m.role === 'user');
      if (userIdx === -1) return;
      if (userIdx === 0) {
        try {
          await window.stem.deleteChat(threadId);
        } catch (e) {
          pushSystem(e);
          return;
        }
        resetSession();
        return;
      }
      try {
        await window.stem.rollbackToTurn(threadId, turnId);
      } catch (e) {
        pushSystem(e);
        return;
      }
      setChatState((s) => ({ ...s, messages: s.messages.slice(0, userIdx) }));
    },
    [threadId, running, messages, resetSession, pushSystem]
  );
  // Fork: branch the thread and continue the branch in the main app.
  const onFork = useCallback(
    async (turnId: string) => {
      if (!threadId) return;
      try {
        const { threadId: newId } = await window.stem.forkThread(threadId, turnId);
        const history = await window.stem.openChat(newId);
        window.stem.handoffQuickChat({ threadId: newId, messages: history.messages, model: modelId, effort, serviceTier });
        resetSession();
      } catch (e) {
        pushSystem(e);
      }
    },
    [threadId, modelId, effort, serviceTier, resetSession, pushSystem]
  );

  function newThread() {
    window.stem.newQuickChatThread();
    resetSession();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function openInStem() {
    if (!threadId) return;
    window.stem.handoffQuickChat({ threadId, messages, model: modelId, effort, serviceTier });
    resetSession();
  }

  function submitCompact() {
    const text = input.trim();
    if (!text) return;
    setInput('');
    onSend(text, []);
  }

  const efforts =
    selectedModel && selectedModel.supportedEfforts.length ? selectedModel.supportedEfforts : ['low', 'medium', 'high'];
  const hasFast = selectedModel ? selectedModel.serviceTiers.some((t) => t.id === 'priority') : true;

  // Native web search toggle for Quick Chat turns, shown only when the selected
  // model's provider supports native search.
  const showSearch = !!selectedModel?.supportsNativeWebSearch;
  const searchOn = nativeWebSearch.quickChat;
  const searchToggle = (key: string) =>
    showSearch ? (
      <div className="seg-ctl compact" role="group" aria-label="Web search" key={key}>
        <button
          type="button"
          className={searchOn ? 'active' : ''}
          onClick={() => toggleNativeSearch(!searchOn)}
          title={`Native web search ${searchOn ? 'on' : 'off'}`}
        >
          <Globe size={13} /> Web
        </button>
      </div>
    ) : null;

  // Expanded conversation panel once the session has any messages.
  if (messages.length > 0) {
    return (
      <div className="qc-root">
        <div className="qc-card qc-panel">
          <div className="qc-head">
            <Sparkles className="qc-mark" size={18} />
            {searchToggle('head')}
            <span className="qc-spacer" />
            <button className="qc-act" title="New thread" onClick={newThread}>
              <SquarePen size={15} />
            </button>
            <button className="qc-act" title="Open in Stem" onClick={openInStem} disabled={!threadId}>
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
          onSend={onSend}
          onInterrupt={onInterrupt}
          onRetry={onRetry}
          onEdit={onEdit}
          onFork={onFork}
          onDelete={onDelete}
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
          />
        </div>
      </div>
    );
  }

  // Compact spotlight bar for a fresh session.
  return (
    <div className="qc-root">
      <div className="qc-card">
        <div className="qc-row">
          <Sparkles className="qc-mark" size={22} />
          <input
            ref={inputRef}
            className="qc-input"
            value={input}
            placeholder="Ask Stem anything…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitCompact();
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
                title="1.5× speed, increased usage"
              >
                Fast
              </button>
            </div>
          )}
          {searchToggle('foot')}
          <span className="qc-spacer" />
          <span className="qc-hint">
            <kbd>⏎</kbd> send
          </span>
        </div>
      </div>
    </div>
  );
}
