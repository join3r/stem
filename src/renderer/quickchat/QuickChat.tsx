import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, SquarePen, PanelRight } from 'lucide-react';
import type {
  AgentMessageDeltaParams,
  ChatMessage,
  BackendEventEnvelope,
  ItemEventParams,
  MessageMeta,
  ModelSummary,
  QuickChatSettings,
  TurnAttachment,
  TurnCompletedParams
} from '../../shared/types';
import { agentMessageText } from '../../shared/types';
import { activityLabel } from '../../shared/activity';
import { ChatView } from '../chat/ChatView';

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High'
};

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

  // One conversation's state (this overlay only ever holds one thread at a time).
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);

  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Refs so the event subscription (registered once) reads current values.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const turnMetaRef = useRef(new Map<string, MessageMeta>());

  const selectedModel = models.find((m) => m.id === modelId) ?? null;

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
    setMessages([]);
    setThreadId(null);
    setActiveTurnId(null);
    setRunning(false);
    setStreamingId(null);
    setActivity(null);
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

  // Stream the overlay-owned thread. The main process only forwards this thread's
  // events to the overlay window, so every event we receive belongs to the current
  // session — we adopt its thread id if we don't have it yet (events can arrive
  // before runQuickChat resolves).
  useEffect(() => {
    return window.stem.onBackendEvent((event: BackendEventEnvelope) => {
      switch (event.method) {
        case 'item/agentMessage/delta': {
          const p = event.params as AgentMessageDeltaParams;
          if (!threadIdRef.current) setThreadId(p.threadId);
          const id = `assistant-${p.turnId}`;
          setMessages((ms) => {
            const idx = ms.findIndex((m) => m.id === id);
            const meta = turnMetaRef.current.get(p.turnId);
            return idx === -1
              ? [...ms, { id, role: 'assistant', content: p.delta, meta, turnId: p.turnId } as ChatMessage]
              : ms.map((m, i) => (i === idx ? { ...m, content: m.content + p.delta } : m));
          });
          setRunning(true);
          setStreamingId(id);
          setActivity(null);
          break;
        }
        case 'item/started': {
          const p = event.params as ItemEventParams;
          const type = p.item?.type;
          if (type && type !== 'agentMessage') setActivity(activityLabel(type));
          break;
        }
        case 'item/completed': {
          const p = event.params as ItemEventParams;
          if (p.item?.type !== 'agentMessage') break;
          const id = `assistant-${p.turnId}`;
          const text = agentMessageText(p.item);
          setMessages((ms) => {
            const meta = turnMetaRef.current.get(p.turnId);
            const idx = ms.findIndex((m) => m.id === id);
            return idx === -1
              ? [...ms, { id, role: 'assistant', content: text, meta, turnId: p.turnId } as ChatMessage]
              : ms.map((m, i) => (i === idx ? { ...m, content: text || m.content, meta: m.meta ?? meta } : m));
          });
          setStreamingId(null);
          break;
        }
        case 'turn/completed':
        case 'turn/failed':
        case 'turn/aborted': {
          const p = event.params as TurnCompletedParams;
          if (threadIdRef.current && p.threadId !== threadIdRef.current) break;
          setRunning(false);
          setStreamingId(null);
          setActivity(null);
          setActiveTurnId(null);
          break;
        }
        case 'process/exit': {
          setRunning(false);
          setStreamingId(null);
          setActivity(null);
          setActiveTurnId(null);
          break;
        }
        default:
          break;
      }
    });
  }, []);

  // Switching models clamps effort + drops an unsupported Fast pick.
  function onSelectModel(id: string) {
    const m = models.find((x) => x.id === id);
    setModelId(id);
    if (m) {
      setEffort((e) => (e && m.supportedEfforts.includes(e) ? e : m.defaultEffort));
      if (!m.serviceTiers.some((t) => t.id === 'priority')) setServiceTier(null);
    }
  }

  const pushSystem = useCallback((e: unknown) => {
    setMessages((ms) => [
      ...ms,
      { id: `system-${Date.now()}`, role: 'system', content: String(e instanceof Error ? e.message : e) }
    ]);
    setRunning(false);
  }, []);

  const onSend = useCallback(
    async (text: string, attachments: TurnAttachment[] = []) => {
      const bubble = attachments.length
        ? `${text}${text ? '\n\n' : ''}📎 ${attachments.map((a) => a.name).join(', ')}`
        : text;
      const userMsgId = `user-${Date.now()}`;
      setMessages((ms) => [...ms, { id: userMsgId, role: 'user', content: bubble }]);
      setRunning(true);
      setActivity(null);
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
          setActiveTurnId(result.turnId);
          setMessages((ms) => ms.map((m) => (m.id === userMsgId ? { ...m, turnId: result.turnId } : m)));
        }
        if (result.handled) {
          setMessages((ms) =>
            result.assistantMessage
              ? [...ms, { id: `assistant-${Date.now()}`, role: 'assistant', content: result.assistantMessage as string }]
              : ms
          );
          setRunning(false);
          setActiveTurnId(null);
        }
      } catch (e) {
        pushSystem(e);
      }
    },
    [modelId, effort, serviceTier, format, threadId, pushSystem]
  );

  const onInterrupt = useCallback(async () => {
    if (activeTurnId) await window.stem.interruptTurn(activeTurnId);
    setRunning(false);
    setStreamingId(null);
    setActivity(null);
    setActiveTurnId(null);
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
      setMessages((ms) => ms.slice(0, userIdx));
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
    selectedModel && selectedModel.supportedEfforts.length ? selectedModel.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
  const hasFast = selectedModel ? selectedModel.serviceTiers.some((t) => t.id === 'priority') : true;

  // Expanded conversation panel once the session has any messages.
  if (messages.length > 0) {
    return (
      <div className="qc-root">
        <div className="qc-card qc-panel">
          <div className="qc-head">
            <Sparkles className="qc-mark" size={18} />
            {models.length > 0 && (
              <select className="qc-model" value={modelId ?? ''} onChange={(e) => onSelectModel(e.target.value)} aria-label="Model">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            )}
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
          models={models}
          model={selectedModel}
          effort={effort}
          serviceTier={serviceTier}
          format={format}
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
          {models.length > 0 && (
            <select className="qc-model" value={modelId ?? ''} onChange={(e) => onSelectModel(e.target.value)} aria-label="Model">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          )}
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
          <span className="qc-spacer" />
          <span className="qc-hint">
            <kbd>⏎</kbd> send
          </span>
        </div>
      </div>
    </div>
  );
}
