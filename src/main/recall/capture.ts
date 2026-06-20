import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { codexHome } from '../workspace/paths';
import { getMeta, recordMessage, setMeta, type MessageRole } from './store';
import type { CodexEventEnvelope, ItemEventParams } from '../../shared/types';
import { agentMessageText } from '../../shared/types';

// Captures conversation into Stem's own store (Level 2). Two paths:
//  - live: the runtime taps user text (in startTurn) and assistant text (from the
//    item/completed event) and calls recordMessage — the authoritative, clean path.
//  - backfill: a one-time sweep of existing codex rollouts so chats from before
//    Stem Recall existed are searchable too. Best-effort and guarded by a marker.

const BACKFILL_MARKER = 'backfill_v1_done';

// Injected/synthetic blocks ride through the rollout as user/developer messages.
// They are not things the user said, so they must never enter recall.
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
export function captureFromEvent(envelope: CodexEventEnvelope): void {
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

// ---- one-time backfill from existing rollouts ----

interface RolloutLine {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    cwd?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

async function listRolloutFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (e) => {
        const path = join(dir, e.name);
        if (e.isDirectory()) return listRolloutFiles(path);
        return e.isFile() && e.name.endsWith('.jsonl') ? [path] : [];
      })
    );
    return nested.flat();
  } catch {
    return [];
  }
}

function tsSeconds(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function ingestRollout(content: string): number {
  let threadId = '';
  let cwd: string | null = null;
  let count = 0;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: RolloutLine;
    try {
      entry = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }

    if (entry.type === 'session_meta') {
      threadId = entry.payload?.id ?? threadId;
      cwd = entry.payload?.cwd ?? cwd;
      continue;
    }

    if (entry.type !== 'response_item' || entry.payload?.type !== 'message') continue;
    const role = entry.payload.role;
    if (role !== 'user' && role !== 'assistant') continue; // skip developer/system
    if (!threadId) continue;

    const text = (entry.payload.content ?? [])
      .filter((p) => p.type === 'input_text' || p.type === 'output_text')
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text || isSyntheticText(text)) continue;

    try {
      recordMessage({
        threadId,
        turnId: null,
        role: role as MessageRole,
        text,
        cwd,
        ts: tsSeconds(entry.timestamp)
      });
      count += 1;
    } catch {
      // ignore individual line failures
    }
  }
  return count;
}

/**
 * Seed recall from existing codex rollouts, once. Idempotent at two levels: the
 * marker skips the whole sweep on later runs, and recordMessage's dedup_key makes
 * re-ingestion harmless even if the marker is lost.
 */
export async function backfillOnce(): Promise<number> {
  if (getMeta(BACKFILL_MARKER)) return 0;
  const files = await listRolloutFiles(join(codexHome(), 'sessions'));
  let total = 0;
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    total += ingestRollout(content);
  }
  setMeta(BACKFILL_MARKER, String(Date.now()));
  return total;
}
