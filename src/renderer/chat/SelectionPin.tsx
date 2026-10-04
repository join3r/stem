import { useEffect, useState, type RefObject } from 'react';
import { Pin } from 'lucide-react';
import type { ChatMessage } from '../../shared/types';
import { messageAnchor } from './pins';

// Select text in a message → a small "Pin" button floats over the selection and
// pins exactly that passage (docs/chat-pinboard-plan.md). Only a selection
// inside ONE finished message's body counts: a passage spanning two messages
// has no single source to jump back to, and a streaming reply is still
// changing under the selection.

interface Offer {
  text: string;
  message: ChatMessage;
  top: number;
  left: number;
}

/** Longest passage worth offering; past this the whole message is the better pin. */
const MAX_PASSAGE = 4_000;

export function SelectionPin({
  containerRef,
  messages,
  streamingId,
  onPin
}: {
  containerRef: RefObject<HTMLElement | null>;
  messages: ChatMessage[];
  streamingId: string | null;
  onPin: (text: string, message: ChatMessage) => void;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const read = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setOffer(null);
      const text = sel.toString().trim();
      if (!text || text.length > MAX_PASSAGE) return setOffer(null);
      const range = sel.getRangeAt(0);
      const bodyOf = (node: Node | null) =>
        (node instanceof Element ? node : node?.parentElement)?.closest('.message-body') ?? null;
      const body = bodyOf(range.startContainer);
      if (!body || body !== bodyOf(range.endContainer) || !container.contains(body)) return setOffer(null);
      const id = body.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
      const message = messages.find((m) => m.id === id);
      if (
        !message ||
        message.id === streamingId ||
        (message.role !== 'user' && message.role !== 'assistant') ||
        !messageAnchor(message)
      ) {
        return setOffer(null);
      }
      const rect = range.getBoundingClientRect();
      setOffer({ text, message, top: rect.top, left: rect.left + rect.width / 2 });
    };

    // Offer on release (a drag in progress is not a choice yet); withdraw as
    // soon as the selection collapses or the transcript scrolls under it.
    const onUp = () => window.setTimeout(read, 0);
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setOffer(null);
    };
    const onScroll = () => setOffer(null);
    container.addEventListener('mouseup', onUp);
    container.addEventListener('keyup', onUp);
    container.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      container.removeEventListener('mouseup', onUp);
      container.removeEventListener('keyup', onUp);
      container.removeEventListener('scroll', onScroll);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [containerRef, messages, streamingId]);

  if (!offer) return null;
  return (
    <button
      type="button"
      className="selection-pin"
      style={{ top: offer.top, left: offer.left }}
      // Keep the selection alive through the click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onPin(offer.text, offer.message);
        window.getSelection()?.removeAllRanges();
        setOffer(null);
      }}
    >
      <Pin size={12} /> Pin
    </button>
  );
}
