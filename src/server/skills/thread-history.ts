// Which skills are already in this chat's context.
//
// A skill's body is inlined into the user message of the turn that loaded it,
// and pi keeps that message in the session, so every later turn of the chat
// still carries the steps. Loading the skill again would only paste a second
// copy into the context. This reads the pre-prompt `get_entries` snapshot — the
// same one fact retrieval uses — and returns the names of the skills whose
// bodies the model will see this turn.
//
// "Will see" follows pi's own projection (buildContextEntries in its
// session-manager): the active branch only, and after a compaction only the
// entries from the compaction's firstKeptEntryId onward. A skill that was
// summarised away is no longer in front of the model and may load again.

const SKILLS_OPEN = '<stem_skills';
const SKILLS_CLOSE = '</stem_skills>';
// The heading formatSkillsBlock writes for an inlined body. Index entries are
// "- name — description" lines and never match.
const INLINED_HEADING = /^### (.+) \((?:saved at the user’s request|auto-saved, never reviewed)\)$/gm;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
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

function inlinedNames(text: string, into: Set<string>): void {
  let from = 0;
  for (;;) {
    const open = text.indexOf(SKILLS_OPEN, from);
    if (open < 0) return;
    const close = text.indexOf(SKILLS_CLOSE, open);
    if (close < 0) return;
    for (const match of text.slice(open, close).matchAll(INLINED_HEADING)) into.add(match[1]);
    from = close + SKILLS_CLOSE.length;
  }
}

/**
 * Names of the skills inlined somewhere in the chat's live context. Any doubt
 * about the snapshot returns an empty set: the worst that does is load a skill
 * twice, which is the behaviour before this existed.
 */
export function loadedSkillNames(snapshot: unknown): Set<string> {
  const names = new Set<string>();
  const data = record(snapshot);
  if (!data || !Array.isArray(data.entries) || typeof data.leafId !== 'string') return names;

  const entries = new Map<string, Record<string, unknown>>();
  for (const value of data.entries) {
    const entry = record(value);
    if (entry && typeof entry.id === 'string') entries.set(entry.id, entry);
  }

  const visited = new Set<string>();
  // Set by the newest compaction on the branch: older entries count only down
  // to (and including) the first one it kept.
  let keepUntil: string | null = null;
  let id: unknown = data.leafId;
  while (typeof id === 'string' && !visited.has(id)) {
    visited.add(id);
    const entry = entries.get(id);
    if (!entry) return new Set();
    if (entry.type === 'compaction' && keepUntil === null) {
      if (typeof entry.firstKeptEntryId !== 'string') break;
      keepUntil = entry.firstKeptEntryId;
    } else if (entry.type === 'message') {
      const message = record(entry.message);
      if (message?.role === 'user') inlinedNames(messageText(message), names);
    }
    if (keepUntil !== null && id === keepUntil) break;
    id = entry.parentId;
  }
  return names;
}
