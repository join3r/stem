import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SquarePen, PanelRight } from 'lucide-react';
import type {
  AgentMessageDeltaParams,
  ChatListResult,
  ChatMessage,
  CodexEventEnvelope,
  ItemEventParams,
  RuntimeStatus
} from '../shared/types';
import { agentMessageText } from '../shared/types';
import { ChatView } from './chat/ChatView';
import { ManagePanel } from './manage/ManagePanel';
import { useAutoHideScroll } from './hooks/useAutoHideScroll';

export default function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [chatList, setChatList] = useState<ChatListResult>({ chats: [], folders: [] });
  const inspectorRef = useAutoHideScroll<HTMLElement>();

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

  useEffect(() => {
    return window.stem.onCodexEvent((event: CodexEventEnvelope) => {
      switch (event.method) {
        case 'item/agentMessage/delta': {
          const p = event.params as AgentMessageDeltaParams;
          const id = `assistant-${p.turnId}`;
          setStreamingId(id);
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === id);
            if (idx === -1) return [...prev, { id, role: 'assistant', content: p.delta }];
            const next = [...prev];
            next[idx] = { ...next[idx], content: next[idx].content + p.delta };
            return next;
          });
          break;
        }
        case 'item/completed': {
          const p = event.params as ItemEventParams;
          if (p.item?.type !== 'agentMessage') break;
          const id = `assistant-${p.turnId}`;
          const text = agentMessageText(p.item);
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === id);
            if (idx === -1) return [...prev, { id, role: 'assistant', content: text }];
            const next = [...prev];
            // Prefer authoritative text; keep streamed deltas if it's empty.
            next[idx] = { ...next[idx], content: text || next[idx].content };
            return next;
          });
          setStreamingId(null);
          break;
        }
        case 'turn/completed':
          setRunning(false);
          setStreamingId(null);
          break;
        case 'process/exit':
          setRunning(false);
          setStreamingId(null);
          break;
        default:
          // Unknown / unhandled events are ignored on purpose.
          break;
      }
    });
  }, []);

  const onSend = useCallback(
    async (text: string) => {
      setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text }]);
      setRunning(true);
      try {
        const result = await window.stem.startTurn({ input: text, threadId: activeThreadId ?? undefined });
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
    [activeThreadId, refreshChats]
  );

  const onInterrupt = useCallback(async () => {
    if (activeTurnId) await window.stem.interruptTurn(activeTurnId);
    setRunning(false);
    setStreamingId(null);
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
          onSend={onSend}
          onInterrupt={onInterrupt}
        />
      </main>
      {showInspector && (
        <aside className="inspector" ref={inspectorRef}>
          <ManagePanel
            data={chatList}
            activeThreadId={activeThreadId}
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
