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
import { TOOL_SKILL_MARKER } from '../pi/protocol';

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
      // A skill handed over at a tool call (inject.ts toolSkillsForTurn) is the
      // held call's error result, opening with the marker. Only that shape
      // counts: any tool can return text, and one that quoted a skills block
      // would otherwise keep a skill from loading for the rest of the chat.
      else if (message?.role === 'toolResult' && message.isError === true) {
        const text = messageText(message);
        if (text.startsWith(TOOL_SKILL_MARKER)) inlinedNames(text, names);
      }
    }
    if (keepUntil !== null && id === keepUntil) break;
    id = entry.parentId;
  }
  return names;
}

/**
 * The name-only index lines the chat already holds, exactly as formatSkillsBlock
 * wrote them ("- name — description"). `liveUserTexts` is the chat's live user
 * messages (pi/context-dedupe.ts follows the same projection as above), so a
 * line that a compaction summarised away is not in the set and may be listed
 * again.
 *
 * Every "- " line of a skills block is taken, a bullet in a loaded skill's steps
 * included: the caller asks only whether one exact line is there, and a step
 * that is letter for letter another skill's name and description does not exist.
 * An empty set is the safe answer to any doubt. It lists the index in full, which
 * is what every turn did before this existed.
 */
export function listedSkillLines(liveUserTexts: readonly string[]): Set<string> {
  const lines = new Set<string>();
  for (const text of liveUserTexts) {
    let from = 0;
    for (;;) {
      const open = text.indexOf(SKILLS_OPEN, from);
      if (open < 0) break;
      const close = text.indexOf(SKILLS_CLOSE, open);
      if (close < 0) break;
      for (const line of text.slice(open, close).split('\n')) if (line.startsWith('- ')) lines.add(line);
      from = close + SKILLS_CLOSE.length;
    }
  }
  return lines;
}
