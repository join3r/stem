
import { requestEpisodicMaintenance } from './scan';
import { degrade } from '../degrade';
import type { BackendEventEnvelope, ItemEventParams } from '../../shared/types';
import { agentMessageText } from '../../shared/types';
import { recallStore } from './store';
const { recordMessage } = recallStore;

// Captures conversation into Stem's own store (Level 2). The runtime taps user
// text (in startTurn) and assistant text (from the item/completed event) and
// calls recordMessage — the authoritative, clean path.

// Injected/synthetic blocks ride through as user/developer messages. They are not
// things the user said, so they must never enter recall.
const SYNTHETIC_MARKERS = [
  '<permissions instructions>',
  // pi's own skills preamble (now unused — the backend is spawned --no-skills)
  // and Stem's replacement for it. Both are procedures Stem injected, not
  // anything the user said.
  '<skills_instructions>',
  '<stem_skills',
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

// Pruning the episodic store VACUUMs the db, so we don't want to do it on every
// message. Check the size limit only every Nth capture; the actual prune runs in
// the scan worker (fire-and-forget) so a multi-second VACUUM never blocks the
// main event loop, and is gated behind a cheap size comparison there.
const ENFORCE_EVERY = 20;
let sinceEnforce = 0;
function maybeEnforceEpisodicLimit(): void {
  if (++sinceEnforce < ENFORCE_EVERY) return;
  sinceEnforce = 0;
  try {
    requestEpisodicMaintenance();
  } catch (error) {
    // Pruning must never break capture — but the request is the only thing that
    // ever asks for the size cap, so a swallow here is the store growing without
    // bound, and every later capture skips the check for another ENFORCE_EVERY.
    degrade('recall.capture', 'skipped the episodic size check', error);
  }
}

/** Live tap for assistant replies: record the authoritative completed agentMessage.
 *  `opts.web` marks the row as coming from a turn that used web tools — see
 *  RecordMessageInput.web for what downstream does with it. */
export function captureFromEvent(envelope: BackendEventEnvelope, opts: { web?: boolean } = {}): void {
  if (envelope.method !== 'item/completed') return;
  const params = envelope.params as ItemEventParams | undefined;
  const item = params?.item;
  if (!item || item.type !== 'agentMessage') return;
  const text = agentMessageText(item);
  if (!text.trim()) return;
  try {
    recordMessage({ threadId: params.threadId, turnId: params.turnId, role: 'assistant', text, web: opts.web ?? false });
    maybeEnforceEpisodicLimit();
  } catch (error) {
    // Capture must never break the chat. The reply is still on screen and still
    // in pi's own session file; it is recall that no longer has it, and nothing
    // re-reads a turn, so the loss is permanent and otherwise invisible.
    degrade('recall.capture', 'dropped an assistant reply from recall', error);
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
    maybeEnforceEpisodicLimit();
  } catch (error) {
    // Same as the assistant tap: the turn carries on, but this message will
    // never be distilled, summarized or searchable.
    degrade('recall.capture', 'dropped a user message from recall', error);
  }
}
