import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SquarePen, PanelRight } from 'lucide-react';
import type {
  AgentMessageDeltaParams,
  ChatListResult,
  ChatMessage,
  CodexEventEnvelope,
  ItemEventParams,
  MessageMeta,
  ModelSummary,
  RuntimeStatus,
  ThreadStatus,
  TurnAttachment,
  TurnCompletedParams
} from '../shared/types';
import { agentMessageText } from '../shared/types';
import { ChatView } from './chat/ChatView';
import { ManagePanel } from './manage/ManagePanel';
import { useAutoHideScroll } from './hooks/useAutoHideScroll';

// Friendly label for the "working" indicator, derived from the active Codex
// item type. Both camelCase and snake_case are handled defensively since the
// runtime forwards item.type verbatim; anything unmapped falls back to "Working…".
function activityLabel(type: string): string {
  switch (type) {
    case 'reasoning':
      return 'Thinking…';
    case 'webSearch':
    case 'web_search':
      return 'Searching the web…';
    case 'commandExecution':
    case 'command_execution':
    case 'exec':
      return 'Running a command…';
    case 'mcpToolCall':
    case 'mcp_tool_call':
      return 'Using a tool…';
    case 'fileChange':
    case 'file_change':
      return 'Editing files…';
    default:
      return 'Working…';
  }
}

// Sentinel key for a brand-new chat that has no codex thread id yet. Its slice is
// migrated to the real thread id once the first turn returns one.
const DRAFT = '__draft__';

// Everything about one chat's in-flight/visible state. Stored per thread id (plus
// the DRAFT slice) so multiple chats can run and stream at the same time.
interface ThreadState {
  messages: ChatMessage[];
  running: boolean;
  streamingId: string | null;
  /** Label of the in-flight activity (tool/reasoning); null once text streams. */
  activity: string | null;
  activeTurnId: string | null;
  /** Drives the status dot on the chat row. */
  status: ThreadStatus;
}

const EMPTY_STATE: ThreadState = {
  messages: [],
  running: false,
  streamingId: null,
  activity: null,
  activeTurnId: null,
  status: 'idle'
};

// Merge a DRAFT slice into the (possibly already-created) real-thread slice when a
// new chat's first turn returns its id. The draft holds the user bubble; the live
// slice may already hold assistant deltas that arrived before startTurn resolved.
// Keep the user bubble first, then any assistant messages not already present.
function mergeDraftIntoReal(draft: ThreadState, live: ThreadState | undefined): ThreadState {
  if (!live) return draft;
  const ids = new Set(draft.messages.map((m) => m.id));
  const extra = live.messages.filter((m) => !ids.has(m.id));
  return { ...live, messages: [...draft.messages, ...extra] };
}

export default function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  // Per-thread run/conversation state, keyed by thread id (or DRAFT for a new,
  // uncreated chat). This is what lets several chats run concurrently — each has
  // its own messages/running/streaming slice that events route into by threadId.
  const [threadStates, setThreadStates] = useState<Record<string, ThreadState>>({});
  const [signingIn, setSigningIn] = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [chatList, setChatList] = useState<ChatListResult>({ chats: [], folders: [] });
  const inspectorRef = useAutoHideScroll<HTMLElement>();
  // turnId -> which model/effort/speed produced that turn's reply (for the
  // avatar tooltip). Populated at send time; read when the message is built.
  // Global on purpose: turn ids are unique across threads.
  const turnMetaRef = useRef(new Map<string, MessageMeta>());

  // Ref mirrors so async callbacks (startTurn resolution, openChat, events) read
  // the latest values without being re-created on every state change.
  const threadStatesRef = useRef(threadStates);
  threadStatesRef.current = threadStates;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  // Threads deleted this session — late codex events for them are ignored so a
  // dying turn can't resurrect a removed chat's slice.
  const deletedThreadsRef = useRef(new Set<string>());

  // The currently visible slice. DRAFT when no real thread is open yet.
  const activeKey = activeThreadId ?? DRAFT;
  const cur = threadStates[activeKey] ?? EMPTY_STATE;

  // Patch one thread's slice (functional, so concurrent updates never clobber).
  const setThread = useCallback(
    (key: string, patch: (s: ThreadState) => Partial<ThreadState>) => {
      setThreadStates((prev) => {
        const base = prev[key] ?? EMPTY_STATE;
        return { ...prev, [key]: { ...base, ...patch(base) } };
      });
    },
    []
  );

  // Status-dot map for the chat rows, derived from the per-thread slices.
  const threadStatuses = useMemo(() => {
    const out: Record<string, ThreadStatus> = {};
    for (const [tid, s] of Object.entries(threadStates)) {
      if (tid === DRAFT) continue;
      out[tid] = s.status;
    }
    return out;
  }, [threadStates]);

  // Model / effort / speed — per-turn overrides, remembered across launches.
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelId, setModelId] = useState<string | null>(() => localStorage.getItem('stem.modelId'));
  const [effort, setEffort] = useState<string | null>(() => localStorage.getItem('stem.effort'));
  const [serviceTier, setServiceTier] = useState<string | null>(
    () => localStorage.getItem('stem.serviceTier')
  );
  // Output format for the AI's reply — 'mdx' (rich components, default) or 'md' (plain Markdown).
  const [format, setFormat] = useState<'md' | 'mdx'>(
    () => (localStorage.getItem('stem.format') === 'md' ? 'md' : 'mdx')
  );
  const selectedModel = models.find((m) => m.id === modelId) ?? null;

  const [bridgeError, setBridgeError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!window.stem) {
      setBridgeError('The preload bridge failed to load (window.stem is undefined).');
      return;
    }
    setStatus(await window.stem.runtimeStatus());
  }, []);

  const refreshChats = useCallback(async () => {
    if (!window.stem) return;
    setChatList(await window.stem.listChats());
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Load the chat list once the runtime is ready (thread/list needs the server up).
  useEffect(() => {
    if (status?.ok) refreshChats();
  }, [status?.ok, refreshChats]);

  // Fetch the model catalog once the runtime is ready; seed defaults from codex
  // (the `isDefault` model + its default effort) when nothing is remembered yet.
  useEffect(() => {
    if (!status?.ok) return;
    window.stem.listModels().then((list) => {
      setModels(list);
      setModelId((cur) => {
        if (cur && list.some((m) => m.id === cur)) return cur;
        const fallback = list.find((m) => m.isDefault) ?? list[0];
        if (fallback) {
          setEffort((e) => e ?? fallback.defaultEffort);
          return fallback.id;
        }
        return cur;
      });
    });
  }, [status?.ok]);

  // Persist the remembered selections.
  useEffect(() => {
    if (modelId) localStorage.setItem('stem.modelId', modelId);
  }, [modelId]);
  useEffect(() => {
    if (effort) localStorage.setItem('stem.effort', effort);
  }, [effort]);
  useEffect(() => {
    if (serviceTier) localStorage.setItem('stem.serviceTier', serviceTier);
    else localStorage.removeItem('stem.serviceTier');
  }, [serviceTier]);
  useEffect(() => {
    localStorage.setItem('stem.format', format);
  }, [format]);

  // Switching models: clamp effort to what the new model supports, and drop a
  // Fast selection when the new model has no priority (Fast) tier.
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
    // Apply a slice update for one thread, lazily creating its entry. Late events
    // for a deleted thread are dropped so they can't resurrect it.
    const applyTo = (threadId: string | undefined, fn: (s: ThreadState) => ThreadState) => {
      if (!threadId || deletedThreadsRef.current.has(threadId)) return;
      setThreadStates((prev) => ({ ...prev, [threadId]: fn(prev[threadId] ?? EMPTY_STATE) }));
    };
    return window.stem.onCodexEvent((event: CodexEventEnvelope) => {
      switch (event.method) {
        case 'item/agentMessage/delta': {
          const p = event.params as AgentMessageDeltaParams;
          const id = `assistant-${p.turnId}`;
          applyTo(p.threadId, (s) => {
            const idx = s.messages.findIndex((m) => m.id === id);
            const meta = turnMetaRef.current.get(p.turnId);
            const messages =
              idx === -1
                ? [...s.messages, { id, role: 'assistant', content: p.delta, meta } as ChatMessage]
                : s.messages.map((m, i) => (i === idx ? { ...m, content: m.content + p.delta } : m));
            return { ...s, messages, running: true, streamingId: id, activity: null, status: 'running' };
          });
          break;
        }
        case 'item/started': {
          const p = event.params as ItemEventParams;
          const type = p.item?.type;
          // A non-message item (reasoning, web search, command, MCP tool…) is
          // running. Surface it as the activity label until text starts streaming.
          if (type && type !== 'agentMessage') applyTo(p.threadId, (s) => ({ ...s, activity: activityLabel(type) }));
          break;
        }
        case 'item/completed': {
          const p = event.params as ItemEventParams;
          if (p.item?.type !== 'agentMessage') break;
          const id = `assistant-${p.turnId}`;
          const text = agentMessageText(p.item);
          applyTo(p.threadId, (s) => {
            const meta = turnMetaRef.current.get(p.turnId);
            const idx = s.messages.findIndex((m) => m.id === id);
            const messages =
              idx === -1
                ? [...s.messages, { id, role: 'assistant', content: text, meta } as ChatMessage]
                // Prefer authoritative text; keep streamed deltas if it's empty.
                : s.messages.map((m, i) => (i === idx ? { ...m, content: text || m.content, meta: m.meta ?? meta } : m));
            return { ...s, messages, streamingId: null };
          });
          break;
        }
        case 'turn/completed': {
          const p = event.params as TurnCompletedParams;
          applyTo(p.threadId, (s) => ({
            ...s,
            running: false,
            streamingId: null,
            activity: null,
            activeTurnId: null,
            // Mark unread (a solid dot) if it finished while another chat was open.
            status: p.threadId === activeThreadIdRef.current ? 'idle' : 'done'
          }));
          break;
        }
        case 'process/exit':
          // No threadId — the server died, so clear every thread's run state.
          setThreadStates((prev) => {
            const next: Record<string, ThreadState> = {};
            for (const [tid, s] of Object.entries(prev)) {
              next[tid] = {
                ...s,
                running: false,
                streamingId: null,
                activity: null,
                activeTurnId: null,
                status: s.status === 'running' ? 'idle' : s.status
              };
            }
            return next;
          });
          break;
        default:
          // Unknown / unhandled events are ignored on purpose.
          break;
      }
    });
  }, []);

  const onSend = useCallback(
    async (text: string, attachments: TurnAttachment[] = []) => {
      const bubble = attachments.length
        ? `${text}${text ? '\n\n' : ''}📎 ${attachments.map((a) => a.name).join(', ')}`
        : text;
      // Where this turn's state lives: the open thread, or DRAFT for a new chat.
      const sendKey = activeThreadId ?? DRAFT;
      setThread(sendKey, (s) => ({
        messages: [...s.messages, { id: `user-${Date.now()}`, role: 'user', content: bubble }],
        running: true,
        activity: null,
        status: 'running'
      }));
      try {
        const result = await window.stem.startTurn({
          input: text,
          threadId: activeThreadId ?? undefined,
          model: modelId ?? undefined,
          effort: effort ?? undefined,
          serviceTier,
          format,
          attachments: attachments.length ? attachments : undefined
        });
        if (result.handled) {
          setThread(sendKey, (s) => ({
            messages: result.assistantMessage
              ? [...s.messages, { id: `assistant-${Date.now()}`, role: 'assistant', content: result.assistantMessage as string }]
              : s.messages,
            running: false,
            activeTurnId: null,
            status: 'idle'
          }));
          return;
        }
        if (result.turnId) {
          turnMetaRef.current.set(result.turnId, { model: modelId ?? undefined, effort: effort ?? undefined, serviceTier });
        }
        if (sendKey === DRAFT && result.threadId) {
          // First turn of a new chat: migrate the DRAFT slice onto the real id,
          // merging any deltas that already arrived under it, then adopt the id.
          const realId = result.threadId;
          setThreadStates((prev) => {
            const draft = prev[DRAFT] ?? EMPTY_STATE;
            const merged = mergeDraftIntoReal(draft, prev[realId]);
            const next = { ...prev };
            delete next[DRAFT];
            next[realId] = { ...merged, running: true, activeTurnId: result.turnId ?? null, status: 'running' };
            return next;
          });
          // Don't steal focus if the user already switched to another chat.
          if (activeThreadIdRef.current === null) setActiveThreadId(realId);
          refreshChats();
        } else {
          setThread(sendKey, () => ({ activeTurnId: result.turnId ?? null }));
        }
      } catch (e) {
        setThread(sendKey, (s) => ({
          messages: [
            ...s.messages,
            { id: `system-${Date.now()}`, role: 'system', content: String(e instanceof Error ? e.message : e) }
          ],
          running: false,
          activeTurnId: null,
          status: 'error'
        }));
      }
    },
    [activeThreadId, refreshChats, modelId, effort, serviceTier, format, setThread]
  );

  // Quick Chat overlay → main window: run the relayed prompt as a fresh
  // conversation, honoring the overlay's ad-hoc effort/speed (clamped to the
  // current model). Mirrors onSend's streaming/threading flow.
  useEffect(() => {
    return window.stem.onQuickChatPrompt(async ({ input, model: qModel, effort: qEffort, serviceTier: qTier }) => {
      // Quick Chat always starts a fresh conversation. If a chat is already
      // running it keeps going in the background; this new draft becomes active.
      setThreadStates((prev) => ({
        ...prev,
        [DRAFT]: { ...EMPTY_STATE, messages: [{ id: `user-${Date.now()}`, role: 'user', content: input }], running: true, status: 'running' }
      }));
      setActiveThreadId(null);

      // Adopt the overlay's model/effort/speed for THIS turn only, clamped to
      // what the model supports. We deliberately do NOT call setModelId/setEffort/
      // setServiceTier here — the overlay's ad-hoc picks must not overwrite the
      // main app's persisted model/effort/speed (Settings + composer).
      const useModelId = qModel ?? modelId;
      const useModel = models.find((m) => m.id === useModelId) ?? selectedModel;
      let useEffort = qEffort ?? effort ?? undefined;
      let useTier = qTier;
      if (useModel) {
        if (useEffort && !useModel.supportedEfforts.includes(useEffort)) useEffort = useModel.defaultEffort;
        if (!useModel.serviceTiers.some((t) => t.id === 'priority')) useTier = null;
      }

      try {
        const result = await window.stem.startTurn({
          input,
          model: useModelId ?? undefined,
          effort: useEffort,
          serviceTier: useTier,
          format
        });
        if (result.handled) {
          setThread(DRAFT, (s) => ({
            messages: result.assistantMessage
              ? [...s.messages, { id: `assistant-${Date.now()}`, role: 'assistant', content: result.assistantMessage as string }]
              : s.messages,
            running: false,
            activeTurnId: null,
            status: 'idle'
          }));
          return;
        }
        if (result.turnId) {
          turnMetaRef.current.set(result.turnId, { model: useModelId ?? undefined, effort: useEffort, serviceTier: useTier });
        }
        if (result.threadId) {
          const realId = result.threadId;
          setThreadStates((prev) => {
            const draft = prev[DRAFT] ?? EMPTY_STATE;
            const merged = mergeDraftIntoReal(draft, prev[realId]);
            const next = { ...prev };
            delete next[DRAFT];
            next[realId] = { ...merged, running: true, activeTurnId: result.turnId ?? null, status: 'running' };
            return next;
          });
          if (activeThreadIdRef.current === null) setActiveThreadId(realId);
          refreshChats();
        }
      } catch (e) {
        setThread(DRAFT, (s) => ({
          messages: [
            ...s.messages,
            { id: `system-${Date.now()}`, role: 'system', content: String(e instanceof Error ? e.message : e) }
          ],
          running: false,
          activeTurnId: null,
          status: 'error'
        }));
      }
    });
  }, [models, selectedModel, modelId, effort, format, refreshChats, setThread]);

  const onInterrupt = useCallback(async () => {
    // Stops only the chat you're viewing; background chats keep running.
    const key = activeThreadIdRef.current ?? DRAFT;
    const turnId = threadStatesRef.current[key]?.activeTurnId;
    if (turnId) await window.stem.interruptTurn(turnId);
    setThread(key, () => ({ running: false, streamingId: null, activity: null, activeTurnId: null, status: 'idle' }));
  }, [setThread]);

  async function signIn() {
    setSigningIn(true);
    try {
      setStatus(await window.stem.login());
    } finally {
      setSigningIn(false);
    }
  }

  const newConversation = useCallback(async () => {
    // Reset only the draft slice and switch to it — any chats running in the
    // background are left untouched and keep streaming.
    setThreadStates((prev) => ({ ...prev, [DRAFT]: EMPTY_STATE }));
    setActiveThreadId(null);
  }, []);

  const openChat = useCallback(
    async (threadId: string) => {
      const existing = threadStatesRef.current[threadId];
      // If we already hold a live or hydrated slice (e.g. a chat that ran in the
      // background), just switch to it — reloading from disk would clobber the
      // in-flight stream. Opening clears the unread (done) dot.
      if (existing && (existing.running || existing.messages.length > 0)) {
        setActiveThreadId(threadId);
        setThread(threadId, (s) => ({ status: s.status === 'done' ? 'idle' : s.status }));
        return;
      }
      const history = await window.stem.openChat(threadId);
      setThreadStates((prev) => ({
        ...prev,
        [history.threadId]: { ...EMPTY_STATE, messages: history.messages }
      }));
      setActiveThreadId(history.threadId);
    },
    [setThread]
  );

  // Folder mutations return the fresh list; apply it directly.
  const onCreateFolder = useCallback((name: string, parentId: string | null) => {
    window.stem.createFolder(name, parentId).then(setChatList);
  }, []);
  const onRenameFolder = useCallback((folderId: string, name: string) => {
    window.stem.renameFolder(folderId, name).then(setChatList);
  }, []);
  const onDeleteFolder = useCallback((folderId: string) => {
    window.stem.deleteFolder(folderId).then(setChatList);
  }, []);
  const onMoveFolder = useCallback((folderId: string, parentId: string | null) => {
    window.stem.moveFolder(folderId, parentId).then(setChatList);
  }, []);
  const onMoveChat = useCallback((threadId: string, folderId: string | null) => {
    window.stem.setChatFolder(threadId, folderId).then(setChatList);
  }, []);
  const onRenameChat = useCallback(
    async (threadId: string, name: string) => {
      await window.stem.renameChat(threadId, name);
      refreshChats();
    },
    [refreshChats]
  );
  const onDeleteChat = useCallback(
    async (threadId: string) => {
      // Guard against late events from this thread's in-flight turn resurrecting it.
      deletedThreadsRef.current.add(threadId);
      await window.stem.deleteChat(threadId);
      setThreadStates((prev) => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
      if (threadId === activeThreadIdRef.current) setActiveThreadId(null);
      refreshChats();
    },
    [refreshChats]
  );

  // Unified draggable toolbar wraps every view (window has no native title bar).
  // `toolbar` lets each view supply its own controls; gate/loading show just the title.
  const titleOnly = (
    <div className="toolbar-title">
      <strong>Stem</strong>
    </div>
  );
  const shell = (inner: ReactNode, toolbar: ReactNode = titleOnly) => (
    <div className="root-shell">
      <div className="toolbar">{toolbar}</div>
      {inner}
    </div>
  );

  if (bridgeError) {
    return shell(
      <div className="app gate">
        <div className="gate-card">
          <h1>Stem</h1>
          <p className="error">{bridgeError}</p>
        </div>
      </div>
    );
  }

  if (!status) {
    return shell(<div className="app loading">Starting Stem…</div>);
  }

  if (!status.ok) {
    return shell(
      <div className="app gate">
        <div className="gate-card">
          <h1>Stem</h1>
          {status.authenticated === false ? (
            <>
              <p>Sign in with your ChatGPT subscription to continue.</p>
              <button className="primary" onClick={signIn} disabled={signingIn}>
                {signingIn ? 'Waiting for browser…' : 'Sign in with ChatGPT'}
              </button>
              {status.loginCommand && <code className="login-cmd">{status.loginCommand}</code>}
            </>
          ) : (
            <>
              <p className="error">{status.error}</p>
              <button className="push" onClick={refreshStatus}>Retry</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return shell(
    <div className={`app${showInspector ? '' : ' no-inspector'}`}>
      <main className="conversation">
        <ChatView
          key={activeKey}
          messages={cur.messages}
          running={cur.running}
          streamingId={cur.streamingId}
          activity={cur.activity}
          onSend={onSend}
          onInterrupt={onInterrupt}
          models={models}
          model={selectedModel}
          effort={effort}
          serviceTier={serviceTier}
          format={format}
          onChangeEffort={setEffort}
          onChangeSpeed={setServiceTier}
          onChangeFormat={setFormat}
        />
      </main>
      {showInspector && (
        <aside className="inspector" ref={inspectorRef}>
          <ManagePanel
            data={chatList}
            activeThreadId={activeThreadId}
            statuses={threadStatuses}
            models={models}
            modelId={modelId}
            onSelectModel={onSelectModel}
            onOpen={openChat}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            onMoveFolder={onMoveFolder}
            onRenameChat={onRenameChat}
            onDeleteChat={onDeleteChat}
            onMoveChat={onMoveChat}
          />
        </aside>
      )}
    </div>,
    <>
      <button
        className="tbtn"
        title="New conversation"
        onClick={newConversation}
        // Allow a new chat even while another runs in the background. Only block
        // when the visible chat is empty, or its first turn hasn't yet produced a
        // thread id (DRAFT still running) — switching away would orphan it.
        disabled={cur.messages.length === 0 || (activeThreadId === null && cur.running)}
      >
        <SquarePen size={17} />
      </button>
      <div className="toolbar-title">
        <strong>Stem</strong>
        <span>ChatGPT subscription</span>
      </div>
      <div className="toolbar-spacer" />
      <button
        className={`tbtn${showInspector ? ' active' : ''}`}
        title="Toggle inspector"
        onClick={() => setShowInspector((v) => !v)}
      >
        <PanelRight size={17} />
      </button>
    </>
  );
}
