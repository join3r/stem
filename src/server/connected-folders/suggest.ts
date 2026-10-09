import type { LlmClient } from '../recall/llm';
import type { ConnectedFolderKind, FolderSample, FolderSuggestion } from '../../shared/types';

// "Suggest settings" for a connected folder: one hidden memory-model call that
// reads a FolderSample (names, counts, a README excerpt — see ./sample.ts) and
// answers with the same fields the wizard asks for. The defaults per kind are
// the wizard's own presets (renderer/manage/ConnectFolderWizard.tsx KINDS), so a
// suggestion and a hand-picked kind agree unless the folder gives a reason not
// to. Nothing is applied here: the caller fills the form and the user saves.

const KINDS: ConnectedFolderKind[] = ['notes', 'code', 'docs', 'private'];
const LEARN = ['off', 'use', 'new', 'all'] as const;

export function suggestPrompt(sample: FolderSample, note?: string): string {
  return [
    'You choose settings for a folder a user is connecting to Stem, their personal AI assistant.',
    'Look at the folder summary and pick what suits it.',
    '',
    'Settings:',
    '- kind: "notes" (Obsidian/Logseq vault, Markdown notes), "code" (a software project or repository),',
    '  "docs" (PDFs, contracts, manuals, invoices, papers), "private" (a client\'s files, medical, legal,',
    '  HR or anything under NDA), or null when none fits.',
    '- writable: may Stem create, edit and delete files here? True for code projects it works in;',
    '  false for notes, documents and anything precious.',
    '- memorize: may what Stem reads here come back in later chats? False for confidential folders',
    '  and for code (its contents are not personal knowledge).',
    '- index: build a search index over its text, PDF and Word files? True when the folder holds',
    '  prose worth searching; false for code.',
    '- learnMode (only matters when memorize and index are both true): "all" reads every file once',
    '  then keeps up (costs a model call per few pages; good for a personal notes vault of modest size),',
    '  "new" learns only from files added or changed from now on (a large vault, or one that grows),',
    '  "use" learns only from excerpts that come up in chats (documents), "off" never.',
    '',
    'Usual answers: notes → writable false, memorize true, index true, learnMode "all"',
    '(or "new" past a couple of thousand files); code → writable true, memorize false, index false,',
    'learnMode "off"; docs → writable false, memorize true, index true, learnMode "use";',
    'private → writable false, memorize false, index true, learnMode "off".',
    'Depart from these only when the summary gives a reason.',
    '',
    'Also write "note": one short line saying what the folder holds, in the user\'s terms (what a person',
    'would write in a "What\'s in it" field, e.g. "Meeting notes, project plans and reading notes"),',
    'and "reason": one sentence on why these settings, naming the evidence.',
    '',
    'Answer with JSON only:',
    '{"kind": ..., "writable": ..., "memorize": ..., "index": ..., "learnMode": ..., "note": "...", "reason": "..."}',
    '',
    note?.trim() ? `The user describes the folder as: ${note.trim()}\n` : '',
    'Folder summary:',
    JSON.stringify(sample, null, 1)
  ].join('\n');
}

/** Read the model's answer; anything missing falls back to the safe side (read-only, private). */
export function parseSuggestion(raw: string): FolderSuggestion {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not answer with settings. Try again.');
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('The model did not answer with settings. Try again.');
  }
  const kind = KINDS.includes(o.kind as ConnectedFolderKind) ? (o.kind as ConnectedFolderKind) : null;
  const learnMode = LEARN.includes(o.learnMode as (typeof LEARN)[number]) ? (o.learnMode as (typeof LEARN)[number]) : 'use';
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    kind,
    writable: o.writable === true,
    memorize: o.memorize === true && kind !== 'private',
    index: o.index !== false,
    learnMode,
    note: text(o.note, 200),
    reason: text(o.reason, 400)
  };
}

export async function suggestFolderSettings(llm: LlmClient, sample: FolderSample, note?: string): Promise<FolderSuggestion> {
  return parseSuggestion(await llm.complete(suggestPrompt(sample, note)));
}
