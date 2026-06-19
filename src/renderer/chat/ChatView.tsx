import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Square, ArrowUp, Paperclip, User, Sparkles, AlertTriangle } from 'lucide-react';
import type { ChatMessage } from '../../shared/types';
import { MdxView } from './MdxView';
import { useAutoHideScroll } from '../hooks/useAutoHideScroll';

const AVATAR: Record<ChatMessage['role'], { cls: string; icon: ReactNode; label: string }> = {
  user: { cls: 'you', icon: <User size={15} />, label: 'You' },
  assistant: { cls: 'stem', icon: <Sparkles size={15} />, label: 'Stem' },
  system: { cls: 'sys', icon: <AlertTriangle size={15} />, label: 'Error' }
};

const MAX_COMPOSER_HEIGHT = 180;

interface ChatViewProps {
  messages: ChatMessage[];
  running: boolean;
  streamingId: string | null;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

export function ChatView({ messages, running, streamingId, onSend, onInterrupt }: ChatViewProps) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useAutoHideScroll<HTMLDivElement>();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, running]);

  // Auto-grow the composer from one line up to a max, then scroll internally.
  const resizeComposer = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const needed = el.scrollHeight;
    el.style.height = `${Math.min(needed, MAX_COMPOSER_HEIGHT)}px`;
    // Only show a scrollbar once content exceeds the max height.
    el.style.overflowY = needed > MAX_COMPOSER_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [draft, resizeComposer]);

  function submit() {
    const text = draft.trim();
    if (!text || running) return;
    onSend(text);
    setDraft('');
  }

  return (
    <div className="chat">
      <div className="messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="empty">
            <h2>Stem</h2>
            <p>Ask me to explain something. I can use callouts, steps, and collapsible details.</p>
          </div>
        )}
        {messages.map((m) => {
          const a = AVATAR[m.role];
          return (
            <div key={m.id} className={`message message-${m.role}`}>
              <div className={`msg-avatar ${a.cls}`}>{a.icon}</div>
              <div className="message-body">
                <div className="message-who">{a.label}</div>
                {m.role === 'assistant' && m.id !== streamingId ? (
                  <MdxView text={m.content} />
                ) : (
                  <div className="message-plain">{m.content || (running ? '…' : '')}</div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <div className="composer-field">
          <button type="button" className="composer-attach" title="Attach" tabIndex={-1}>
            <Paperclip size={17} />
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask Stem…"
            rows={1}
          />
          {running ? (
            <button type="button" className="icon-btn stop" onClick={onInterrupt} title="Stop">
              <Square size={16} />
            </button>
          ) : (
            <button type="button" className="icon-btn send" onClick={submit} disabled={!draft.trim()} title="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
