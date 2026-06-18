import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  AgentMessageDeltaParams,
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
  const inspectorRef = useAutoHideScroll<HTMLElement>();

  const [bridgeError, setBridgeError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!window.stem) {
      setBridgeError('The preload bridge failed to load (window.stem is undefined).');
      return;
    }
    setStatus(await window.stem.runtimeStatus());
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

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

  const onSend = useCallback(async (text: string) => {
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text }]);
    setRunning(true);
    try {
      const result = await window.stem.startTurn({ input: text });
      setActiveTurnId(result.turnId ?? null);
    } catch (e) {
      setRunning(false);
      setMessages((prev) => [
        ...prev,
        { id: `system-${Date.now()}`, role: 'system', content: String(e instanceof Error ? e.message : e) }
      ]);
    }
  }, []);

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

  // Slim draggable titlebar wraps every view (window has no native title bar).
  const shell = (inner: ReactNode) => (
    <div className="root-shell">
      <div className="titlebar" />
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
              <button onClick={refreshStatus}>Retry</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return shell(
    <div className="app">
      <main className="conversation">
        <ChatView
          messages={messages}
          running={running}
          streamingId={streamingId}
          onSend={onSend}
          onInterrupt={onInterrupt}
        />
      </main>
      <aside className="inspector" ref={inspectorRef}>
        <ManagePanel />
      </aside>
    </div>
  );
}
