import { FILES_CONTEXT_LIMIT, type FileEntry } from '../../shared/types';
import { listFiles } from './store';

// Builds the per-turn context Stem prepends to the user's message so the
// assistant always knows which files are available in the Files folder.
// Names only (never contents): the model reads a file on demand with its read
// tools. Returns null when the folder is empty (nothing to inject).
//
// A small folder is listed file by file. A big one used to be cut at the first
// 100 names in path order, which meant one large subfolder could take every
// slot and hide everything after it in the alphabet. So past the limit, each
// subfolder with more than SUMMARIZE_OVER files becomes one line with a count
// and a few names: every top-level entry is still named, and the assistant can
// list a folder when it needs the rest. Tool folders (bulky.ts) are named once
// either way.

/** A subfolder with more files than this is summarized once the folder is over the limit. */
const SUMMARIZE_OVER = 10;
/** Example names on a summarized folder's line. */
const EXAMPLES = 3;

export async function buildFilesContext(): Promise<string | null> {
  const { files, skipped = [], truncated } = await listFiles();
  if (files.length === 0 && skipped.length === 0) return null;

  const lines: string[] = [];
  if (files.length <= FILES_CONTEXT_LIMIT) {
    for (const f of files) lines.push(`- files/${f.rel}`);
  } else {
    const groups = new Map<string, FileEntry[]>();
    for (const f of files) {
      const list = groups.get(f.dir);
      if (list) list.push(f);
      else groups.set(f.dir, [f]);
    }
    for (const [dir, entries] of groups) {
      if (dir === '' || entries.length <= SUMMARIZE_OVER) {
        for (const f of entries) lines.push(`- files/${f.rel}`);
      } else {
        const names = entries.slice(0, EXAMPLES).map((f) => f.rel.slice(dir.length + 1));
        lines.push(`- files/${dir}/ — ${entries.length}${truncated ? '+' : ''} files, e.g. ${names.join(', ')}`);
      }
    }
  }
  for (const s of skipped) lines.push(`- files/${s.rel}/ — ${s.kind} (tooling, contents not listed)`);

  const shown = lines.slice(0, FILES_CONTEXT_LIMIT);
  const more = lines.length > shown.length ? `\n…and ${lines.length - shown.length} more entries.` : '';
  const example = files[0]?.rel ?? `${skipped[0].rel}/`;

  return (
    `The user keeps files in the \`files/\` folder (their personal "Files" place). ` +
    `Currently available:\n${shown.join('\n')}${more}\n\n` +
    `Read any of them with your file tools when relevant (e.g. read \`files/${example}\`). ` +
    `Only the names are listed here, not the contents — read on demand, and do not ` +
    `assume a file's contents from its name. To link one in a reply, use its \`files/\` path, ` +
    `e.g. \`[report](files/report.html)\`: a click opens it on the user's computer.`
  );
}
