import { listConnectedFolders } from '../workspace/connected-folders';

// Builds the per-turn context Stem prepends so the assistant knows which external
// folders it may read in place. Roots + labels + notes only — never a file listing
// (a connected Obsidian vault can hold thousands of files). The assistant explores
// on demand with its ls/find/grep/read tools against the absolute paths below.

export async function buildConnectedFoldersContext(): Promise<string | null> {
  const folders = (await listConnectedFolders()).filter((f) => !f.missing);
  if (folders.length === 0) return null;

  const lines = folders.map((f) => {
    const access = f.mode === 'readwrite' ? 'read & write' : 'read-only';
    const privacy = f.memorize ? '' : ', private — do not store its contents in memory';
    const note = f.note ? ` — ${f.note}` : '';
    return `- ${f.label}: \`${f.path}\` (${access}${privacy})${note}`;
  });

  const hasReadOnly = folders.some((f) => f.mode === 'read');
  const hasPrivate = folders.some((f) => !f.memorize);

  return (
    `The user has connected these folders for you to read in place (they live on ` +
    `disk where shown, not inside your workspace):\n${lines.join('\n')}\n\n` +
    `Explore them on demand with your file tools — \`ls\`/\`find\`/\`grep\` to locate ` +
    `things, then \`read\` the specific files you need. Use the absolute paths above; ` +
    `do not assume contents from names.` +
    (hasReadOnly
      ? ` Read-only folders must not be modified — never write or edit inside them ` +
        `(such attempts are blocked anyway).`
      : '') +
    (hasPrivate
      ? ` For any folder marked private, treat its contents as confidential: answer ` +
        `from it in this conversation, but do not commit its details to memory.`
      : '')
  );
}
