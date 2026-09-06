const MAX_PREVIOUS_MESSAGES = 2;
const MAX_PREVIOUS_CHARS = 400;
const CONTEXT_OPEN = '<!--stem:context-->';
const CONTEXT_CLOSE = '<!--/stem:context-->';

function boundedMessages(messages: readonly string[]): string[] {
  return messages.filter((text) => typeof text === 'string' && text.trim().length > 0)
    .slice(-MAX_PREVIOUS_MESSAGES)
    .map((text) => {
      // Match Python's character bound without splitting UTF-16 surrogate pairs.
      let clipped = '';
      let count = 0;
      for (const character of text) {
        if (count++ === MAX_PREVIOUS_CHARS) break;
        clipped += character;
      }
      return clipped;
    });
}

/** The contextual query used by the fact-only GTE benchmark. */
export function formatFactQuery(current: string, previous: readonly string[]): string {
  const context = boundedMessages(previous);
  return context.length
    ? `Earlier messages from the user in this conversation:\n${context.map((text) => `- ${text}\n`).join('')}\nCurrent message: ${current}`
    : current;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Only recover text whose persisted form can be separated from Stem scaffolding. */
function rawUserText(message: Record<string, unknown>): string | null {
  if (message.role !== 'user') return null;
  let text: string;
  if (typeof message.content === 'string') text = message.content;
  else if (Array.isArray(message.content)) {
    const blocks: string[] = [];
    for (const value of message.content) {
      const block = record(value);
      // Images and all other attachment/custom blocks make this turn ineligible.
      if (block?.type !== 'text' || typeof block.text !== 'string') return null;
      blocks.push(block.text);
    }
    text = blocks.join('');
  } else return null;

  if (text.startsWith(CONTEXT_OPEN)) {
    const close = text.indexOf(CONTEXT_CLOSE, CONTEXT_OPEN.length);
    if (close < 0) return null;
    const remaining = text.slice(close + CONTEXT_CLOSE.length);
    if (!/^(?:\r?\n)+/.test(remaining)) return null;
    text = remaining.replace(/^(?:\r?\n)+/, '');
  }
  // Scheduled/mail turns are stored as user messages but were not written by
  // the human. Also reject incomplete or otherwise unrecognized leading fences.
  if (/^\s*<!--\/?stem:/.test(text)) return null;
  if (/^\s*This is an automated scheduled run\b/.test(text)) return null;
  // Legacy attachment suffixes have no unambiguous raw-input delimiter. Omit
  // these turns rather than treating document bytes or skip notices as the user.
  if (/(?:^|\r?\n)(?:Attached file:|\(Skipped unsupported attachment:)/.test(text)) return null;
  return text.trim() ? text : null;
}

/**
 * Read a pre-prompt get_entries response's data, following only its active leaf.
 * Validate the whole ancestry before returning anything; never fall back to a
 * flat session scan, compacted model messages, or another worker's history.
 */
export function previousFactUserMessages(snapshot: unknown): string[] {
  const data = record(snapshot);
  if (!data || !Array.isArray(data.entries)) return [];
  if (data.leafId === null) return [];
  if (typeof data.leafId !== 'string' || !data.leafId) return [];

  const entries = new Map<string, Record<string, unknown>>();
  for (const value of data.entries) {
    const entry = record(value);
    if (!entry || typeof entry.id !== 'string' || !entry.id || entries.has(entry.id)
      || (entry.parentId !== null && (typeof entry.parentId !== 'string' || !entry.parentId))) return [];
    entries.set(entry.id, entry);
  }

  const visited = new Set<string>();
  const latest: string[] = [];
  let id: string | null = data.leafId;
  while (id !== null) {
    if (visited.has(id)) return [];
    visited.add(id);
    const entry = entries.get(id);
    if (!entry) return [];
    if (latest.length < MAX_PREVIOUS_MESSAGES && entry.type === 'message') {
      const message = record(entry.message);
      const text = message ? rawUserText(message) : null;
      if (text !== null) latest.push(text);
    }
    id = entry.parentId as string | null;
  }
  return boundedMessages(latest.reverse());
}
