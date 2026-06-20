import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
  TurnAttachment
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

export default function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  // Label of the in-flight activity (tool call / reasoning) shown by the working
  // indicator. Null when nothing is running or once answer text starts streaming.
  const [activity, setActivity] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [chatList, setChatList] = useState<ChatListResult>({ chats: [], folders: [] });
  const inspectorRef = useAutoHideScroll<HTMLElement>();
  // turnId -> which model/effort/speed produced that turn's reply (for the
  // avatar tooltip). Populated at send time; read when the message is built.
  const turnMetaRef = useRef(new Map<string, MessageMeta>());

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
    return window.stem.onCodexEvent((event: CodexEventEnvelope) => {
      switch (event.method) {
        case 'item/agentMessage/delta': {
          const p = event.params as AgentMessageDeltaParams;
          const id = `assistant-${p.turnId}`;
          setStreamingId(id);
          setActivity(null);
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === id);
            const meta = turnMetaRef.current.get(p.turnId);
            if (idx === -1) return [...prev, { id, role: 'assistant', content: p.delta, meta }];
            const next = [...prev];
            next[idx] = { ...next[idx], content: next[idx].content + p.delta };
            return next;
          });
          break;
        }
        case 'item/started': {
          const p = event.params as ItemEventParams;
          const type = p.item?.type;
          // A non-message item (reasoning, web search, command, MCP tool…) is
          // running. Surface it as the activity label until text starts streaming.
          if (type && type !== 'agentMessage') setActivity(activityLabel(type));
          break;
        }
        case 'item/completed': {
          const p = event.params as ItemEventParams;
          if (p.item?.type !== 'agentMessage') break;
          const id = `assistant-${p.turnId}`;
          const text = agentMessageText(p.item);
          const meta = turnMetaRef.current.get(p.turnId);
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === id);
            if (idx === -1) return [...prev, { id, role: 'assistant', content: text, meta }];
            const next = [...prev];
            // Prefer authoritative text; keep streamed deltas if it's empty.
            next[idx] = { ...next[idx], content: text || next[idx].content, meta: next[idx].meta ?? meta };
            return next;
          });
          setStreamingId(null);
          break;
        }
        case 'turn/completed':
          setRunning(false);
          setStreamingId(null);
          setActivity(null);
          break;
        case 'process/exit':
          setRunning(false);
          setStreamingId(null);
          setActivity(null);
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
      setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: bubble }]);
      setRunning(true);
      setActivity(null);
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
          if (result.assistantMessage) {
            setMessages((prev) => [
              ...prev,
              { id: `assistant-${Date.now()}`, role: 'assistant', content: result.assistantMessage as string }
            ]);
          }
          setRunning(false);
          setActiveTurnId(null);
          return;
        }
        setActiveTurnId(result.turnId ?? null);
        if (result.turnId) {
          turnMetaRef.current.set(result.turnId, { model: modelId ?? undefined, effort: effort ?? undefined, serviceTier });
        }
        // First turn of a new chat creates the codex thread — adopt its id and
        // surface the freshly-created chat (with its preview title) in the list.
        if (result.threadId && result.threadId !== activeThreadId) {
          setActiveThreadId(result.threadId);
          refreshChats();
        }
      } catch (e) {
        setRunning(false);
        setMessages((prev) => [
          ...prev,
          { id: `system-${Date.now()}`, role: 'system', content: String(e instanceof Error ? e.message : e) }
        ]);
      }
    },
    [activeThreadId, refreshChats, modelId, effort, serviceTier, format]
  );

  // Quick Chat overlay → main window: run the relayed prompt as a fresh
  // conversation, honoring the overlay's ad-hoc effort/speed (clamped to the
  // current model). Mirrors onSend's streaming/threading flow.
  useEffect(() => {
    return window.stem.onQuickChatPrompt(async ({ input, model: qModel, effort: qEffort, serviceTier: qTier }) => {
      await window.stem.newConversation();
      setActiveThreadId(null);
      setActiveTurnId(null);

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

      setMessages([{ id: `user-${Date.now()}`, role: 'user', content: input }]);
      setRunning(true);
      setActivity(null);
      try {
        const result = await window.stem.startTurn({
          input,
          model: useModelId ?? undefined,
          effort: useEffort,
          serviceTier: useTier,
          format
        });
        if (result.handled) {
          if (result.assistantMessage) {
            setMessages((prev) => [
              ...prev,
              { id: `assistant-${Date.now()}`, role: 'assistant', content: result.assistantMessage as string }
            ]);
          }
          setRunning(false);
          return;
        }
        setActiveTurnId(result.turnId ?? null);
        if (result.turnId) {
          turnMetaRef.current.set(result.turnId, { model: useModelId ?? undefined, effort: useEffort, serviceTier: useTier });
        }
        if (result.threadId) {
          setActiveThreadId(result.threadId);
          refreshChats();
        }
      } catch (e) {
        setRunning(false);
        setMessages((prev) => [
          ...prev,
          { id: `system-${Date.now()}`, role: 'system', content: String(e instanceof Error ? e.message : e) }
        ]);
      }
    });
  }, [models, selectedModel, modelId, effort, format, refreshChats]);

  const onInterrupt = useCallback(async () => {
    if (activeTurnId) await window.stem.interruptTurn(activeTurnId);
    setRunning(false);
    setStreamingId(null);
    setActivity(null);
  }, [activeTurnId]);

  async function signIn() {
    setSigningIn(true);
    try {
      setStatus(await window.stem.login());
    } finally {
      setSigningIn(false);
    }
  }

  const newConversation = useCallback(async () => {
    await window.stem.newConversation();
    setMessages([]);
    setStreamingId(null);
    setActiveTurnId(null);
    setActiveThreadId(null);
  }, []);

  const openChat = useCallback(async (threadId: string) => {
    const history = await window.stem.openChat(threadId);
    setMessages(history.messages);
    setActiveThreadId(history.threadId);
    setStreamingId(null);
    setActiveTurnId(null);
    setRunning(false);
  }, []);

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
      await window.stem.deleteChat(threadId);
      if (threadId === activeThreadId) {
        setActiveThreadId(null);
        setMessages([]);
      }
      refreshChats();
    },
    [activeThreadId, refreshChats]
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
          messages={messages}
          running={running}
          streamingId={streamingId}
          activity={activity}
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
        disabled={running || messages.length === 0}
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
