// Per-chat scratch folders for the `run_command` tool.
//
// Every chat's commands used to run in ONE folder, so downloads, half-finished
// scripts and build output from every conversation Stem ever had landed in the
// same flat pile with nothing on disk saying which chat produced what. It only
// grew: nothing deleted from it, and after enough months the only honest options
// were "keep it all" or "delete all of it and hope".
//
// So the root (execWorkspaceDir) is now a CONTAINER and each chat gets a folder
// inside it named by its thread id. That gives the pile structure: scratch can be
// sized and listed per chat, deleting a chat takes its files, and abandoned work
// ages out on a clock. The root itself stays meaningful as the "unfiled" bucket —
// it still holds the pile from before per-chat folders, and it is where a command
// with no live thread lands.
//
// Every walk in here uses lstat and never follows a symlink. That is not a
// nicety: each chat folder holds a `files` link into the user's Files place, so a
// walk that followed links would report every chat as weighing as much as the
// whole Files place — and a sweep that followed one could delete the user's
// documents. fs.rm unlinks a symlink rather than following it, and fs.cp with
// verbatimSymlinks copies the link itself, so both stay cheap and safe.

import { cp, lstat, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatSummary } from '../../shared/types';
import { degrade } from '../degrade';
import { log } from '../log';
import { execWorkspaceDir, filesRoot, isScratchId, threadWorkspaceDir } from '../workspace/paths';

/** The row key for everything at the root that does not belong to a chat. */
export const UNFILED_KEY = 'unfiled';

/** How often the sweep runs while the server is up. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

/** Default idle days before a chat's scratch is swept; see ExecSettings.scratchTtlDays. */
export const DEFAULT_SCRATCH_TTL_DAYS = 30;

/** What one row of the usage list weighs, before chat titles are joined on. */
export interface ScratchUsage {
  /** A thread id, or {@link UNFILED_KEY} for the aggregate of loose root entries. */
  key: string;
  bytes: number;
  files: number;
  /** Newest mtime anywhere inside, in ms. The folder's own mtime when it is empty. */
  newestMs: number;
}

/** Running totals while walking one folder. */
interface Measured {
  bytes: number;
  files: number;
  newestMs: number;
}

/**
 * Size, file count and newest mtime under `dir`, following no symlinks. Anything
 * unreadable contributes nothing rather than aborting the walk — a measurement
 * that gives up on the first surprise is a measurement nobody can act on.
 */
async function measure(dir: string): Promise<Measured> {
  const out: Measured = { bytes: 0, files: 0, newestMs: 0 };
  // quiet: the caller listed this folder a moment ago, so a stat that fails now
  // means it was swept or deleted underneath the walk — there is nothing left to
  // weigh. A folder that is there and unreadable fails at the readdir below,
  // which does say so.
  const self = await lstat(dir).catch(() => null);
  if (!self) return out;
  out.newestMs = self.mtimeMs;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    // The row keeps the folder's own mtime, so a folder nobody can read comes
    // back looking empty — and an empty row is what Settings shows to someone
    // trying to work out where their disk went.
    degrade('exec.scratch', 'counted an unreadable folder as empty', e);
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    // quiet: readdir named it, so a stat that fails is an entry that has gone
    // since — a file nobody can find takes up no room in the row either.
    const info = await lstat(full).catch(() => null);
    if (!info) continue;
    // Symlinks (the `files` link, and anything the assistant made) count as the
    // link itself and are never descended into.
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      const child = await measure(full);
      out.bytes += child.bytes;
      out.files += child.files;
      if (child.newestMs > out.newestMs) out.newestMs = child.newestMs;
    } else if (info.isFile()) {
      out.bytes += info.size;
      out.files += 1;
      if (info.mtimeMs > out.newestMs) out.newestMs = info.mtimeMs;
    }
  }
  return out;
}

/**
 * Point `files` inside a chat's scratch folder at the user's Files place, so the
 * shell can `cp report.pdf files/` exactly as the assistant's file tools already
 * describe it. Best-effort by design: an unprivileged Windows account cannot
 * create a link, and a missing convenience must never stop a command from running.
 */
async function linkFilesPlace(dir: string): Promise<void> {
  const link = join(dir, 'files');
  try {
    // 'junction' is the Windows form that works without developer mode; it is
    // ignored on POSIX. The target is absolute, which junctions require.
    await symlink(filesRoot(), link, 'junction');
  } catch {
    // quiet: already there, or not permitted. Either way the shell falls back to
    // the absolute path, which the tool description still names.
  }
}

/**
 * The folder a command should run in, created if needed. `null` (no live turn)
 * and any id that could escape the root fall back to the unfiled bucket, which is
 * the same place the pre-per-chat pile lives and is swept on the same clock.
 */
export async function ensureThreadScratch(threadId: string | null | undefined): Promise<string> {
  if (!threadId || !isScratchId(threadId)) {
    const root = execWorkspaceDir();
    await mkdir(root, { recursive: true }).catch((e) => {
      degrade('exec.scratch', 'handed back a scratch folder it could not create', e);
    });
    return root;
  }
  const dir = threadWorkspaceDir(threadId);
  await mkdir(dir, { recursive: true }).catch((e) => {
    // Every command in this chat then spawns into a cwd that is not there, and
    // the shell reports that as its own failure to start — a sentence about the
    // command, for a problem with the folder.
    degrade('exec.scratch', 'handed back a scratch folder it could not create', e);
  });
  await linkFilesPlace(dir);
  return dir;
}

/**
 * What every chat's scratch weighs, plus one aggregate row for everything loose
 * at the root. Unsorted and untitled — the IPC layer joins chat titles on and
 * orders it, because only it knows the chat list.
 */
export async function listScratchUsage(): Promise<ScratchUsage[]> {
  const root = execWorkspaceDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    // A root no command has ever created is an honest empty list. Anything else
    // hands Settings that same "nothing here" over a pile it cannot see.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('exec.scratch', 'listed no scratch folders at all', e);
    }
    return [];
  }

  const rows: ScratchUsage[] = [];
  const unfiled: Measured = { bytes: 0, files: 0, newestMs: 0 };
  let sawUnfiled = false;

  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory() && isScratchId(entry.name)) {
      const m = await measure(full);
      rows.push({ key: entry.name, ...m });
      continue;
    }
    // Anything else at the root — the old flat pile, a stray file, a directory
    // whose name could not be a thread id — is unfiled.
    sawUnfiled = true;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const m = await measure(full);
      unfiled.bytes += m.bytes;
      unfiled.files += m.files;
      if (m.newestMs > unfiled.newestMs) unfiled.newestMs = m.newestMs;
    } else {
      // quiet: same race as the walk — readdir named it and it is gone now, so
      // it weighs nothing.
      const info = await lstat(full).catch(() => null);
      if (!info?.isFile()) continue;
      unfiled.bytes += info.size;
      unfiled.files += 1;
      if (info.mtimeMs > unfiled.newestMs) unfiled.newestMs = info.mtimeMs;
    }
  }

  if (sawUnfiled) rows.push({ key: UNFILED_KEY, ...unfiled });
  return rows;
}

/**
 * Empty one chat's scratch folder, or every loose entry at the root for
 * {@link UNFILED_KEY}. The chat itself is untouched — this is the "free the space,
 * keep the conversation" action.
 */
export async function clearScratch(key: string): Promise<void> {
  const root = execWorkspaceDir();
  if (key === UNFILED_KEY) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (e) {
      // The row was listed a moment ago to be clickable at all, so this is not
      // an empty bucket: someone asked for the space back and did not get it.
      degrade('exec.scratch', 'left the unfiled scratch where it was', e);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && isScratchId(entry.name)) continue; // belongs to a chat
      await rm(join(root, entry.name), { recursive: true, force: true }).catch((e) => {
        // force:true already swallows "gone", so this is a file that is still
        // there — and Clear reports success either way, so the row shrinks in
        // Settings while the disk does not.
        degrade('exec.scratch', 'kept a file the user asked Settings to clear', e);
      });
    }
    return;
  }
  if (!isScratchId(key)) return;
  await rm(join(root, key), { recursive: true, force: true }).catch((e) => {
    degrade('exec.scratch', "kept a chat's scratch the user asked Settings to clear", e);
  });
}

/** Remove a chat's scratch folder outright. Called when the chat is deleted. */
export async function deleteThreadScratch(threadId: string): Promise<void> {
  if (!isScratchId(threadId)) return;
  await rm(threadWorkspaceDir(threadId), { recursive: true, force: true }).catch((e) => {
    // The conversation is gone from the app and its files are not, with no chat
    // left to name them by — only the orphan row in Settings, and the sweep's
    // clock, ever come back for them.
    degrade('exec.scratch', "left a deleted chat's files on disk", e);
  });
}

/**
 * Give a forked chat a copy of the original's scratch, so the fork starts where
 * its own history says it does rather than reading that it created a file it
 * cannot find. Symlinks are copied AS links (verbatimSymlinks), so the `files`
 * link is reproduced instead of duplicating the user's whole Files place.
 */
export async function copyThreadScratch(fromThreadId: string, toThreadId: string): Promise<void> {
  if (!isScratchId(fromThreadId) || !isScratchId(toThreadId)) return;
  const from = threadWorkspaceDir(fromThreadId);
  // quiet: most chats never run a command, so "no folder there" is the ordinary
  // answer and there is nothing to copy. A copy that fails once there IS one is
  // reported by the handler below.
  if (!(await lstat(from).catch(() => null))?.isDirectory()) return;
  await cp(from, threadWorkspaceDir(toThreadId), {
    recursive: true,
    force: true,
    verbatimSymlinks: true
  }).catch((e) => {
    // A fork whose files could not be copied is still a fork worth having.
    log('exec', 'could not copy scratch to the forked chat', {
      error: e instanceof Error ? e.message : String(e)
    });
  });
}

/**
 * Delete scratch that has been idle longer than the TTL. Idle is the NEWER of the
 * folder's newest file and the chat's last message: a conversation you are still
 * having keeps its files even when no command has run in weeks, and files you
 * edited yourself keep themselves.
 *
 * Rows with no chat behind them (an orphan, the unfiled pile) fall back to file
 * age alone. Returns the keys removed, so a caller — or a test — can see what it
 * did. Errors on one entry never stop the rest.
 */
export async function sweepScratch(opts: {
  ttlDays: number | null;
  chats: ChatSummary[];
  now?: number;
}): Promise<string[]> {
  const { ttlDays, chats } = opts;
  if (!ttlDays || ttlDays <= 0) return []; // "Never"
  const now = opts.now ?? Date.now();
  const ttlMs = ttlDays * 24 * 60 * 60_000;
  // ChatSummary.updatedAt is unix SECONDS; everything else here is ms.
  const lastMessageMs = new Map(chats.map((c) => [c.threadId, c.updatedAt * 1000]));

  const removed: string[] = [];
  for (const row of await listScratchUsage()) {
    const touchedMs = Math.max(row.newestMs, lastMessageMs.get(row.key) ?? 0);
    if (now - touchedMs <= ttlMs) continue;
    try {
      // clearScratch removes a chat's folder outright and empties the unfiled
      // bucket in place — the root itself has to survive, it is the container.
      await clearScratch(row.key);
      removed.push(row.key);
    } catch {
      // quiet: gone already, or locked. The key stays out of `removed`, and the
      // next sweep can have it.
    }
  }
  if (removed.length) log('exec', 'swept idle scratch folders', { removed: removed.length, ttlDays });
  return removed;
}

let sweeper: NodeJS.Timeout | null = null;

export interface ScratchSweeperDeps {
  /** The chat list. Throwing skips the pass entirely — see below. */
  listChats: () => Promise<ChatSummary[]>;
  /** Read fresh each pass, so changing the setting takes effect without a restart. */
  ttlDays: () => Promise<number | null>;
}

/**
 * Run one pass, fail-closed on the chat list. The sweep's protection for work you
 * are still doing comes entirely from being able to match a folder to a live
 * chat — so if that matching is not trustworthy, nothing is swept.
 *
 * Two ways it can be untrustworthy, and both skip the pass: the list throws, or
 * it comes back EMPTY while chat-shaped folders exist on disk. The second is the
 * quiet one — a session directory that failed to read is not an error, it is an
 * empty array, and taking it at face value would age out every folder at once.
 * The cost of being wrong the other way is some orphans surviving until the next
 * chat exists, which the Settings list makes easy to clear by hand.
 */
export async function sweepScratchOnce(deps: ScratchSweeperDeps): Promise<string[]> {
  const chats = await deps.listChats().catch((e) => {
    degrade('exec.scratch', 'skipped the sweep rather than age folders it could not match to a chat', e);
    return null;
  });
  if (!chats) return [];
  if (chats.length === 0 && (await listScratchUsage()).some((r) => r.key !== UNFILED_KEY)) return [];
  const ttlDays = await deps.ttlDays().catch((e) => {
    // The fallback is a DELETING default: someone who chose "Never", or 90 days,
    // gets their scratch aged out at 30 on a settings read nobody saw fail.
    degrade('exec.scratch', `swept on the default ${DEFAULT_SCRATCH_TTL_DAYS}-day TTL instead of the configured one`, e);
    return DEFAULT_SCRATCH_TTL_DAYS;
  });
  return sweepScratch({ ttlDays, chats });
}

/**
 * Sweep once now, then daily. The daily timer is not decoration: the desktop app
 * is quit most nights, but the headless server can run for a quarter, and that is
 * exactly the machine where disk creeping up goes unnoticed.
 */
export function startScratchSweeper(deps: ScratchSweeperDeps): void {
  if (sweeper) return;
  // Nothing inside sweepScratchOnce is expected to reject — every failure it can
  // survive it reports itself — so a rejection here is the whole housekeeping
  // pass gone, and on a desktop quit each night the boot pass is the only one
  // that ever runs.
  void sweepScratchOnce(deps).catch((e) => degrade('exec.scratch', 'skipped the sweep pass at startup', e));
  sweeper = setInterval(
    () => void sweepScratchOnce(deps).catch((e) => degrade('exec.scratch', 'skipped a daily sweep pass', e)),
    SWEEP_INTERVAL_MS
  );
  // Never hold the process open for housekeeping.
  sweeper.unref?.();
}

export function stopScratchSweeper(): void {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}
