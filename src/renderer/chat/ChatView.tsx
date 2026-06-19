import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Square, ArrowUp, Paperclip, User, Sparkles, AlertTriangle, File, X } from 'lucide-react';
import type { ChatMessage, ModelSummary, TurnAttachment } from '../../shared/types';
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
  onSend: (text: string, attachments: TurnAttachment[]) => void;
  onInterrupt: () => void;
  model: ModelSummary | null;
  effort: string | null;
  serviceTier: string | null;
  format: 'md' | 'mdx';
  onChangeEffort: (effort: string) => void;
  onChangeSpeed: (serviceTier: string | null) => void;
  onChangeFormat: (format: 'md' | 'mdx') => void;
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High'
};

export function ChatView({
  messages,
  running,
  streamingId,
  onSend,
  onInterrupt,
  model,
  effort,
  serviceTier,
  format,
  onChangeEffort,
  onChangeSpeed,
  onChangeFormat
}: ChatViewProps) {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<TurnAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
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
    if ((!text && attachments.length === 0) || running) return;
    onSend(text, attachments);
    setDraft('');
    setAttachments([]);
  }

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Pick files via the native dialog (paperclip button).
  const pickFiles = useCallback(async () => {
    const paths = await window.stem.openFiles();
    if (!paths.length) return;
    setAttachments((prev) => [
      ...prev,
      ...paths.map((p) => ({ name: p.split('/').pop() || p, path: p }))
    ]);
  }, []);

  // Read a File's bytes into a base64 TurnAttachment (for clipboard/dropped data
  // with no on-disk path).
  function fileToAttachment(file: File): Promise<TurnAttachment> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const result = reader.result as string; // data:<mime>;base64,<data>
        resolve({ name: file.name, dataBase64: result.split(',')[1] ?? '', mime: file.type });
      };
      reader.readAsDataURL(file);
    });
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return; // let plain-text paste through untouched
    e.preventDefault();
    const next = await Promise.all(images.map(fileToAttachment));
    setAttachments((prev) => [...prev, ...next]);
  }

  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const next = await Promise.all(
      files.map(async (f) => {
        const path = window.stem.getPathForFile(f);
        return path ? { name: f.name, path } : await fileToAttachment(f);
      })
    );
    setAttachments((prev) => [...prev, ...next]);
  }

  const hasFast = !!model?.serviceTiers.some((t) => t.id === 'priority');

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
          // Render finalized assistant replies via the MDX renderer. Plain Markdown
          // (.md) is safe to render live while streaming — it has no JSX to break
          // mid-tag — so we render it progressively too (once there's content to show).
          // MDX stays plain-text until complete to avoid flickering half-written tags.
          const isStreaming = m.id === streamingId;
          const renderRich =
            m.role === 'assistant' && (!isStreaming || (format === 'md' && !!m.content));
          return (
            <div key={m.id} className={`message message-${m.role}`}>
              <div className={`msg-avatar ${a.cls}`}>{a.icon}</div>
              <div className="message-body">
                <div className="message-who">{a.label}</div>
                {renderRich ? (
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
        <div className="composer-controls">
          {model && model.supportedEfforts.length > 0 && (
            <div className="seg-ctl compact" role="group" aria-label="Reasoning effort">
              {model.supportedEfforts.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={effort === e ? 'active' : ''}
                  onClick={() => onChangeEffort(e)}
                  disabled={running}
                >
                  {EFFORT_LABELS[e] ?? e}
                </button>
              ))}
            </div>
          )}
          {hasFast && (
            <div className="seg-ctl compact" role="group" aria-label="Speed">
              <button
                type="button"
                className={serviceTier === 'priority' ? '' : 'active'}
                onClick={() => onChangeSpeed(null)}
                disabled={running}
              >
                Standard
              </button>
              <button
                type="button"
                className={serviceTier === 'priority' ? 'active' : ''}
                onClick={() => onChangeSpeed('priority')}
                disabled={running}
                title="1.5× speed, increased usage"
              >
                Fast
              </button>
            </div>
          )}
          <div className="seg-ctl compact" role="group" aria-label="Output format">
            <button
              type="button"
              className={format === 'mdx' ? 'active' : ''}
              onClick={() => onChangeFormat('mdx')}
              disabled={running}
              title="Rich components (callouts, steps, collapsibles)"
            >
              MDX
            </button>
            <button
              type="button"
              className={format === 'md' ? 'active' : ''}
              onClick={() => onChangeFormat('md')}
              disabled={running}
              title="Plain Markdown only"
            >
              MD
            </button>
          </div>
        </div>
        <div
          className={`composer-field${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((att, i) => (
                <span className="attachment-chip" key={`${att.name}-${i}`}>
                  <File size={13} />
                  <span className="attachment-name">{att.name}</span>
                  <button
                    type="button"
                    className="attachment-remove"
                    title="Remove"
                    onClick={() => removeAttachment(i)}
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-row">
            <button type="button" className="composer-attach" title="Attach" onClick={pickFiles}>
              <Paperclip size={17} />
            </button>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={onPaste}
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
              <button
                type="button"
                className="icon-btn send"
                onClick={submit}
                disabled={!draft.trim() && attachments.length === 0}
                title="Send"
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
