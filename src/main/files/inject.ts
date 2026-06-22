import { listFiles } from './store';

// Builds the per-turn context Stem prepends to the user's message so the
// assistant always knows which files are available in the Files folder.
// Names only (never contents): the model reads a file on demand with its read
// tools. Returns null when the folder is empty (nothing to inject).

const MAX_LISTED = 100;

export async function buildFilesContext(): Promise<string | null> {
  const { files } = await listFiles();
  if (files.length === 0) return null;

  const shown = files.slice(0, MAX_LISTED);
  const lines = shown.map((f) => `- files/${f.rel}`).join('\n');
  const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more.` : '';

  return (
    `The user keeps files in the \`files/\` folder (their personal "Files" place). ` +
    `Currently available:\n${lines}${more}\n\n` +
    `Read any of them with your file tools when relevant (e.g. read \`files/${shown[0].rel}\`). ` +
    `Only the names are listed here, not the contents — read on demand, and do not ` +
    `assume a file's contents from its name.`
  );
}
