import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';

// Chats that came from another machine, made resumable here.
//
// pi records the directory a session ran in, in the session file's first line,
// and REFUSES to resume one whose directory no longer exists ("Stored session
// working directory does not exist"). That is every chat carried over by
// `stem-server import`: the path in the file is a folder on the Mac the archive
// was written on, which a Linux server does not have. Such a chat lists fine —
// the list is read off disk — and fails the moment anything opens it. A
// scheduled run is where it hurts most, because nobody is watching when it does.
//
// Rewriting the path is restoring the truth rather than overriding a choice:
// Stem always spawns pi in its own app-owned workspace, so the recorded
// directory was never something a user picked, and OUR workspace is where the
// chat was always meant to run.
//
// The two entry points below differ on purpose. The import knows every chat has
// just changed machines, so it adopts them all — including the ones whose old
// path happens to exist here, which is a real case (a backup restored into a
// second profile on the same Mac) and one where the old path is the WRONG
// workspace rather than a missing one. A resume knows nothing of the sort, so it
// only repairs the file pi is about to refuse: a session whose folder is gone
// cannot be one pi is currently appending to, which is what makes rewriting it
// underneath a running backend safe.

/** The first line of a pi session file. Only `cwd` is ours to correct. */
interface SessionHeader {
  type?: string;
  cwd?: string;
}

/** How far in we look for the header line; it is one short object per file. */
const HEADER_PROBE_BYTES = 4096;

/** The session header, or null when this is not a file with one. */
async function readHeader(file: string): Promise<{ header: SessionHeader; end: number } | null> {
  const handle = await open(file, 'r');
  let head: string;
  try {
    const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  const end = head.indexOf('\n');
  if (end === -1) return null; // no complete header in the probe: not ours to touch
  const header = JSON.parse(head.slice(0, end)) as SessionHeader;
  if (header?.type !== 'session' || typeof header.cwd !== 'string') return null;
  return { header, end };
}

/**
 * Point one session file's stored working directory at `workspace`, when
 * `shouldRewrite` says its current one calls for it.
 *
 * Only the header is read (a session file runs to megabytes) and only a file
 * that needs it is written, temp + rename so a chat cannot be lost to a torn
 * write. Never throws: an unreadable or read-only chat still gets its resume
 * attempt, and pi's own refusal is the better error to show.
 *
 * The file's mtime is put back afterwards. That timestamp is not bookkeeping:
 * it is the ONLY signal Stem has for when a chat last had something happen in
 * it, so the Inbox reads it as activity (see src/shared/inbox.ts) — bumping it
 * would lift the chat out of the archive and paint it unread for a repair
 * nobody did. Opening an old chat from search is where that showed: the first
 * open of a carried-over chat rewrote its header and the chat announced itself
 * as new.
 */
async function rewriteSessionCwd(
  file: string,
  workspace: string,
  shouldRewrite: (cwd: string) => boolean
): Promise<boolean> {
  try {
    const found = await readHeader(file);
    if (!found) return false;
    const { header, end } = found;
    if (header.cwd === workspace || !shouldRewrite(header.cwd!)) return false;
    // quiet: a chat whose original timestamps could not be read is one this
    // rewrite then bumps, and the Inbox reads that bump as activity — the same
    // cost as the utimes below, and unreportable for the same reason as the
    // catch at the end of this function.
    const times = await stat(file).catch(() => null);
    const rest = (await readFile(file, 'utf8')).slice(end + 1);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify({ ...header, cwd: workspace })}\n${rest}`, 'utf8');
      await rename(tmp, file);
      // quiet: a chat whose timestamps could not be restored is still a chat
      // that opens, which is what the rewrite was for. It costs the chat its
      // place in the archive — the Inbox reads the repair as activity — and
      // nothing here can say so; see the catch at the end of this function.
      if (times) await utimes(file, times.atime, times.mtime).catch(() => undefined);
    } finally {
      // quiet: either the rename consumed the temp file or the write never
      // reached it. What can survive is a `.tmp` beside the chat, which nothing
      // reads — both walks here and the chat list take only `.jsonl`.
      await rm(tmp, { force: true }).catch(() => undefined);
    }
    return true;
  } catch {
    // quiet: on a resume, a chat that could not be repaired is one pi then
    // refuses to open, and its refusal is the better error to show. The other
    // caller is `stem-server import`, whose whole point is that the state root
    // comes out of the move without a log file in it — so this cannot be the
    // place that speaks.
    return false;
  }
}

/**
 * Repair a chat pi is about to refuse to resume: one whose recorded folder is
 * not on this machine. A chat whose folder IS here is left alone, whatever it
 * points at — pi will open it, and it may be the very session the backend is
 * appending to right now.
 */
export async function repairMissingSessionCwd(file: string, workspace: string): Promise<boolean> {
  const repaired = await rewriteSessionCwd(file, workspace, (cwd) => !existsSync(cwd));
  if (repaired) log('pi', 'pointed a chat from another machine at this workspace', { file, workspace });
  return repaired;
}

/**
 * Point every chat under `sessionsDir` at `workspace`, answering how many needed
 * it. Run once by the import, so a Stem that has just moved machines arrives
 * resumable rather than repairing itself one chat at a time on first use.
 *
 * Deliberately silent: this runs inside `stem-server import`, whose whole output
 * is the report it prints, and whose state root must not come out of the move
 * with a log file in it.
 */
export async function adoptSessionCwds(sessionsDir: string, workspace: string): Promise<number> {
  let adopted = 0;
  const walk = async (dir: string): Promise<void> => {
    // quiet: a directory that will not list leaves the chats under it
    // unadopted, which costs them the bulk repair, not the repair — each is
    // still fixed by `repairMissingSessionCwd` the first time it is opened. The
    // undercount this returns is the only report the import is allowed to make.
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && (await rewriteSessionCwd(full, workspace, () => true))) {
        adopted += 1;
      }
    }
  };
  await walk(sessionsDir);
  return adopted;
}
