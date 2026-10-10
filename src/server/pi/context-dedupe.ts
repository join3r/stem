// Ambient context blocks the model already has.
//
// Every turn's user message carries Stem's ambient context: the workspace
// files, connected folders, the MCP tool catalogue, the web-access tools, the
// shell hint, the Inbox formatting note. pi keeps each user message in the
// session, so a thread of N turns used to carry N identical copies — about
// 28k characters per mail delivery in the 2026-10-10 audit conversation, eight
// times over in one agent's thread, most of it for one-line acknowledgements.
//
// A block is sent again only when its exact text is not already in front of
// the model. "In front of" follows pi's own projection, as skills/
// thread-history.ts does: the active branch only, and after a compaction only
// the entries from its firstKeptEntryId onward — a block that was summarised
// away is sent again. Any change to a block (a device went offline, a server
// was added) changes its text, so the new version goes out in full.

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((value) => {
      const block = record(value);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

/**
 * The text of every user message the model will see this turn, from a pre-
 * prompt `get_entries` snapshot. Any doubt about the snapshot returns an empty
 * list: the worst that does is send a block again, which is what every turn did
 * before this existed.
 */
export function liveUserTexts(snapshot: unknown): string[] {
  const data = record(snapshot);
  if (!data || !Array.isArray(data.entries) || typeof data.leafId !== 'string') return [];

  const entries = new Map<string, Record<string, unknown>>();
  for (const value of data.entries) {
    const entry = record(value);
    if (entry && typeof entry.id === 'string') entries.set(entry.id, entry);
  }

  const texts: string[] = [];
  const visited = new Set<string>();
  let keepUntil: string | null = null;
  let id: unknown = data.leafId;
  while (typeof id === 'string' && !visited.has(id)) {
    visited.add(id);
    const entry = entries.get(id);
    if (!entry) return [];
    if (entry.type === 'compaction' && keepUntil === null) {
      if (typeof entry.firstKeptEntryId !== 'string') break;
      keepUntil = entry.firstKeptEntryId;
    } else if (entry.type === 'message') {
      const message = record(entry.message);
      if (message?.role === 'user') texts.push(messageText(message));
    }
    if (keepUntil !== null && id === keepUntil) break;
    id = entry.parentId;
  }
  return texts;
}

/**
 * Collects a turn's ambient blocks, dropping the ones the live context already
 * holds verbatim, and names what was dropped so the model knows it still
 * applies.
 */
export class AmbientBlocks {
  private readonly kept: string[] = [];
  private readonly reused: string[] = [];

  constructor(private readonly live: string[]) {}

  /** `label` names the block in the "still in force" line when it is dropped. */
  add(block: string, label: string): void {
    if (this.live.some((text) => text.includes(block))) this.reused.push(label);
    else this.kept.push(block);
  }

  /** The blocks to send, plus one line naming those the model already has. */
  blocks(): string[] {
    if (!this.reused.length) return this.kept;
    return [
      ...this.kept,
      `Unchanged from earlier in this chat and still in force (not repeated here): ${this.reused.join('; ')}.`
    ];
  }
}
