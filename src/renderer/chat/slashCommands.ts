// The composer's `/` menu: typing `/` at the start of an empty-ish draft lists
// the commands the composer understands, narrowed as the name is typed. Pure
// parts only, so they are tested without React; Composer.tsx owns the keys.
//
// The commands themselves are still matched where they always were (note mode
// in noteMode.ts, `/learn`, `/pin` and `/record` at submit in Composer.tsx) — this list
// only offers them, so a command typed by hand behaves exactly as before.

export type SlashCommandName = 'pin' | 'note' | 'learn' | 'record';

export interface SlashCommand {
  name: SlashCommandName;
  /** What follows the name, as the menu shows it. */
  args: string;
  description: string;
}

const COMMANDS: readonly SlashCommand[] = [
  { name: 'pin', args: '<text>', description: 'Pin a note to this chat' },
  { name: 'note', args: '<text>', description: 'Save a note to memory' },
  { name: 'learn', args: '[focus]', description: 'Save a skill from this chat' },
  { name: 'record', args: '', description: 'Show Stem a task on your Mac; it writes the skill' }
];

/**
 * The commands to offer for `draft`, or null when the menu should not show.
 * It shows while the draft is a `/` and the start of a name — no space yet, one
 * line — and `available` drops the commands this composer cannot run (no board
 * to pin to, no thread to learn from). `//` is note mode's own shortcut, not a
 * command being named.
 */
export function slashMatches(draft: string, available: ReadonlySet<SlashCommandName>): SlashCommand[] | null {
  if (!draft.startsWith('/') || draft.startsWith('//') || /\s/.test(draft)) return null;
  const typed = draft.slice(1).toLowerCase();
  const hits = COMMANDS.filter((c) => available.has(c.name) && c.name.startsWith(typed));
  return hits.length > 0 ? hits : null;
}
