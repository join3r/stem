import { recordMessage } from './store';
import type { BackendEventEnvelope, ItemEventParams } from '../../shared/types';
import { agentMessageText } from '../../shared/types';

// Captures conversation into Stem's own store (Level 2). The runtime taps user
// text (in startTurn) and assistant text (from the item/completed event) and
// calls recordMessage — the authoritative, clean path.

// Injected/synthetic blocks ride through as user/developer messages. They are not
// things the user said, so they must never enter recall.
const SYNTHETIC_MARKERS = [
  '<permissions instructions>',
  '<skills_instructions>',
  '<INSTRUCTIONS>',
  '# AGENTS.md instructions',
  'Stored Stem memory notes',
  'What you know about the user',
  'Possibly relevant from past conversations',
  'Format the entire reply as plain Markdown'
];

function isSyntheticText(text: string): boolean {
  return SYNTHETIC_MARKERS.some((m) => text.includes(m));
}

/** Live tap for assistant replies: record the authoritative completed agentMessage. */
export function captureFromEvent(envelope: BackendEventEnvelope): void {
  if (envelope.method !== 'item/completed') return;
  const params = envelope.params as ItemEventParams | undefined;
  const item = params?.item;
  if (!item || item.type !== 'agentMessage') return;
  const text = agentMessageText(item);
  if (!text.trim()) return;
  try {
    recordMessage({ threadId: params.threadId, turnId: params.turnId, role: 'assistant', text });
  } catch {
    // Capture must never break the chat.
  }
}

/** Live tap for user messages, called once a turn's threadId/turnId are known. */
export function captureUserMessage(input: {
  threadId: string;
  turnId?: string | null;
  text: string;
  cwd?: string | null;
}): void {
  if (!input.text.trim() || isSyntheticText(input.text)) return;
  try {
    recordMessage({
      threadId: input.threadId,
      turnId: input.turnId ?? null,
      role: 'user',
      text: input.text,
      cwd: input.cwd ?? null
    });
  } catch {
    // ignore
  }
}
