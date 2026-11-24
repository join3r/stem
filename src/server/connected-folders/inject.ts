import { listConnectedFolders } from '../workspace/connected-folders';
import { enrichConnectedFolders } from './enrich';

// Builds the per-turn context Stem prepends so the assistant knows which external
// folders it may read in place. Roots + labels + notes only — never a file listing
// (a connected Obsidian vault can hold thousands of files). The assistant explores
// on demand with its ls/find/grep/read tools against the absolute paths below.
//
// Client folders (origin set) carry more, because the location axis is invisible
// to the assistant and it diagnoses the wrong computer without it (the lesson
// docs/mcp-device-pinning.md learned): which device owns the folder, the path
// there, whether that device is reachable THIS turn, and how fresh the mirror is.
//
// The block is ambient: it goes out again only when its text changes
// (pi/context-dedupe.ts). So nothing in it may change without a reason the
// assistant needs to know. The exact time of the last sync did: a connected
// computer syncs again and again, and the block came back on 650 of 886 later
// turns on the 2026-11-11 measurement, 3,780 characters each, with the times as
// the only difference in 762 of 779 copies. A mirror that synced a short time
// ago is now reported as that, with no time. The exact time is given when it is
// news: the last sync is older, so the mirror can be behind the folder.

/** A sync this recent is reported without its time. */
export const RECENT_SYNC_MS = 60 * 60_000;

/** How fresh a client folder's mirror is, in words that hold still while it stays fresh. */
function mirrorFreshness(lastSyncedAt: string, now: number): string {
  const at = Date.parse(lastSyncedAt);
  return Number.isFinite(at) && now - at < RECENT_SYNC_MS ? 'synced within the last hour' : `last synced ${lastSyncedAt}`;
}

export async function buildConnectedFoldersContext(now: number = Date.now()): Promise<string | null> {
  const folders = (await enrichConnectedFolders(await listConnectedFolders())).filter((f) => !f.missing);
  if (folders.length === 0) return null;

  const lines = folders.map((f) => {
    const access = f.origin
      ? f.mode === 'readwrite'
        ? 'read here; writable on its computer'
        : 'read-only'
      : f.mode === 'readwrite'
        ? 'read & write'
        : 'read-only';
    const privacy = f.memorize ? '' : ', private — do not store its contents in memory';
    const note = f.note ? ` — ${f.note}` : '';
    if (!f.origin) return `- ${f.label}: \`${f.path}\` (${access}${privacy})${note}`;
    const device = f.orphaned ? 'a computer no longer paired' : f.deviceLabel ?? 'another computer';
    const reach = f.orphaned
      ? 'unpaired — the mirror is all there is'
      : f.deviceConnected
        ? 'connected now'
        : 'offline now — the mirror still reads, commands there will not run';
    const freshness =
      f.syncState === 'root-missing'
        ? 'sync frozen: the folder is unreachable on its computer'
        : f.lastSyncedAt
          ? mirrorFreshness(f.lastSyncedAt, now)
          : 'first sync not finished — the mirror may be empty or still filling, so absence proves nothing yet';
    return (
      `- ${f.label}: \`${f.path}\` (${access}${privacy})${note}` +
      ` — lives on ${device} at \`${f.origin.clientPath}\` (${reach}; ${freshness})`
    );
  });

  const hasReadOnly = folders.some((f) => f.mode === 'read');
  const hasPrivate = folders.some((f) => !f.memorize);
  const hasClient = folders.some((f) => f.origin);

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
      : '') +
    (hasClient
      ? `\n\nFolders that live on one of the user's computers are one-way mirrors: read ` +
        `them at the server path shown, which may lag a few seconds behind that computer. ` +
        `The mirror itself is never writable. To create or change files in one marked ` +
        `writable, run commands on the named computer (run_command's \`device\` parameter) ` +
        `against the folder's path there — and verify a fresh write by reading it back ` +
        `through that computer, not the mirror. To put a picture from this chat or a file ` +
        `Stem holds there, use save_file instead of a command. Mirrors exclude what the folder's \`.gitignore\` ` +
        `files exclude, \`.git\`, \`node_modules\`, ` +
        `OS junk files, symlinks, and files over 25 MB, so those being absent is expected, ` +
        `not a problem with the folder.`
      : '')
  );
}
