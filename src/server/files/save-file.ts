import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { ensureThreadScratch } from '../exec/scratch';
import { filesRoot } from '../workspace/paths';
import { resolveUploadSources, type BrowserSourceDeps, type UploadSource } from './browser-sources';
import { outboxPut } from './outbox';
import type { ConnectedFolder, DeviceExecHostEntry, DeviceExecResult, DeviceSaveRequest } from '../../shared/types';

// save_file: put a picture the assistant made (or any file Stem holds) where
// the user wants it, without a shell. Before it, the only way from a
// generate_image result to a file was a script that dug the bytes out of pi's
// session files — every chat's transcripts — which the judge rightly refused.
//
// Sources are exactly what a browser upload may name (browser-sources.ts):
// `img_…` ids from this conversation, `files/…`, scratch, connected folders.
// Destinations are the places the assistant may already write without asking:
// the Files place, this chat's scratch, and folders the user connected read &
// write. A folder that lives on one of the user's computers is written THERE,
// by the device, over the "accepts commands" rail — the same switch run_command
// needs, re-checked on the device against its own list of writable folders.

export const MAX_SAVE_ITEMS = 20;

export interface SaveItem {
  from: string;
  to: string;
}

export interface SaveDeps extends BrowserSourceDeps {
  folders(): Promise<ConnectedFolder[]>;
  /** The device rail, or null where there is none (tests, a backend without devices). */
  devices: {
    hostFor(deviceId: string): Promise<DeviceExecHostEntry | null>;
    isAvailable(deviceId: string): boolean;
    label(deviceId: string): Promise<string>;
    save(deviceId: string, request: Omit<DeviceSaveRequest, 'requestId'>): Promise<DeviceExecResult>;
  } | null;
}

const WHERE =
  'Save to `files/<name>` (the Files place), a path in this chat\'s scratch folder (relative, e.g. `out/a.png`), ' +
  'or a path inside a folder the user connected read & write — on a computer that folder lives on, either its ' +
  'path there or its mirror path here.';

type Target =
  | { kind: 'server'; root: string; path: string; shown: string }
  | { kind: 'device'; deviceId: string; folder: ConnectedFolder; path: string; mirror: string };

const within = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * `path` under a folder on another computer, '/'-joined ('' for the folder
 * itself), or null when it is not under it. That computer's path rules apply,
 * not this server's: a Mac path resolved on Windows gains a drive letter, and a
 * Windows path is not absolute on Linux at all.
 */
function deviceRelative(path: string, clientRoot: string): string | null {
  const win = WINDOWS_PATH.test(clientRoot);
  const norm = (p: string): string => posix.normalize(win ? p.replace(/\\/g, '/') : p).replace(/(.)\/+$/, '$1');
  const same = (a: string, b: string): boolean => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  const root = norm(clientRoot);
  const p = norm(path);
  if (same(p, root)) return '';
  const head = root.endsWith('/') ? root : root + '/';
  if (p.length <= head.length || !same(p.slice(0, head.length), head)) return null;
  const rel = p.slice(head.length);
  // A backslash is a plain name character on a Mac but a separator here on
  // Windows, where `a\..\..\x` would climb out of the mirror: no such parts.
  return rel.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..') ? null : rel;
}

/**
 * No hidden files or folders: `.git/hooks`, `.github/workflows`, `.envrc`,
 * editor and tool configs are where a written file turns into code that runs,
 * and this tool skips the judge. Pictures and outputs never need to go there;
 * run_command (judged) still can.
 */
export function hiddenPart(rel: string): string | null {
  return rel.split(/[\\/]+/).find((p) => p.startsWith('.') && p !== '.' && p !== '..') ?? null;
}

/**
 * Create `dir` under `root` only after the deepest part of it that already
 * exists resolves inside the root — mkdir before the check would follow a
 * symlinked ancestor and make folders outside it.
 */
export async function mkdirInside(root: string, dir: string): Promise<boolean> {
  const realRoot = await realpath(root);
  let probe = dir;
  for (;;) {
    // quiet: absent means "not created yet" — look one level up.
    const real = await realpath(probe).catch(() => null);
    if (real !== null) {
      if (!within(real, realRoot)) return false;
      break;
    }
    const up = dirname(probe);
    if (up === probe) return false;
    probe = up;
  }
  await mkdir(dir, { recursive: true });
  return within(await realpath(dir), realRoot);
}

/** Where `to` lands, or why it may not. `name` fills a destination that ends in `/`. */
export async function resolveSaveTarget(
  threadId: string,
  to: string,
  name: string,
  folders: ConnectedFolder[]
): Promise<{ ok: true; target: Target } | { ok: false; error: string }> {
  const raw = to.trim();
  if (!raw || raw.includes('\0')) return { ok: false, error: `Name where to save it. ${WHERE}` };
  const wanted = /[\\/]$/.test(raw) ? raw + name : raw;

  if (!isAbsolute(wanted) && !WINDOWS_PATH.test(wanted)) {
    const parts = wanted.split(/[\\/]+/);
    if (parts[0] === 'files') {
      const root = filesRoot();
      const path = resolve(root, ...parts.slice(1));
      if (path === root || !within(path, root)) return { ok: false, error: `“${raw}” is not a file inside files/.` };
      return { ok: true, target: { kind: 'server', root, path, shown: `files/${relative(root, path).split(sep).join('/')}` } };
    }
    const root = await ensureThreadScratch(threadId);
    const path = resolve(root, wanted);
    if (path === root || !within(path, root)) return { ok: false, error: `“${raw}” leaves this chat's scratch folder. ${WHERE}` };
    return { ok: true, target: { kind: 'server', root, path, shown: `${path} (this chat's scratch folder)` } };
  }

  const path = resolve(wanted);
  for (const f of folders) {
    if (f.origin) {
      const clientRoot = f.origin.clientPath.replace(/[\\/]+$/, '');
      // The mirror path is what the model reads; the device path is what it
      // was told the folder is on that computer. Either names the same file.
      const rel = within(path, f.path) ? relative(f.path, path).split(sep).join('/') : deviceRelative(wanted, clientRoot);
      if (rel === null) continue;
      if (!rel) return { ok: false, error: `“${raw}” is the folder itself — name a file inside it.` };
      if (f.mode !== 'readwrite') return { ok: false, error: `“${f.label}” is connected read-only, so nothing can be saved in it.` };
      const mirror = resolve(f.path, rel);
      if (!within(mirror, f.path) || mirror === f.path) return { ok: false, error: `“${raw}” is not a file inside “${f.label}”.` };
      return { ok: true, target: { kind: 'device', deviceId: f.origin.deviceId, folder: f, path: clientRoot + '/' + rel, mirror } };
    }
    if (!within(path, f.path)) continue;
    if (path === f.path) return { ok: false, error: `“${raw}” is the folder itself — name a file inside it.` };
    if (f.mode !== 'readwrite') return { ok: false, error: `“${f.label}” is connected read-only, so nothing can be saved in it.` };
    return { ok: true, target: { kind: 'server', root: f.path, path, shown: path } };
  }
  for (const root of [filesRoot(), await ensureThreadScratch(threadId)]) {
    if (path !== root && within(path, root)) return { ok: true, target: { kind: 'server', root, path, shown: path } };
  }
  return { ok: false, error: `“${raw}” is not a place Stem may save to. ${WHERE}` };
}

/**
 * Copy the snapshot to `path` under `root` on this machine. The parent is
 * resolved for real after it is created, so a symlink inside the root cannot
 * carry the write out of it, and the file goes in by rename so a reader never
 * sees half of it.
 */
async function writeHere(snapshot: string, root: string, path: string): Promise<string | null> {
  // Files is Stem's own folder and may not exist yet on a fresh install; a
  // connected folder that is gone stays gone.
  if (root === filesRoot()) await mkdir(root, { recursive: true });
  if (!(await mkdirInside(root, dirname(path)))) return 'that path leads outside its folder';
  const parent = await realpath(dirname(path));
  const dest = join(parent, basename(path));
  // Again on the resolved path: a visible link inside the folder can point
  // into a hidden one (hooks -> .git/hooks).
  if (hiddenPart(relative(await realpath(root), dest))) return 'that path leads into a hidden folder';
  // quiet: absent is the usual case — a new file.
  const existing = await lstat(dest).catch(() => null);
  if (existing && !existing.isFile()) return 'something that is not a file is already there';
  const tmp = join(parent, `.stem-save-${randomBytes(6).toString('hex')}`);
  try {
    await copyFile(snapshot, tmp, constants.COPYFILE_EXCL);
    await rename(tmp, dest);
  } catch (e) {
    // quiet: the half-written temp goes; the reason is returned to the model.
    await rm(tmp, { force: true }).catch(() => undefined);
    return e instanceof Error ? e.message : String(e);
  }
  return null;
}

/** One item's result line, and the path it wrote when it did. */
interface SaveOutcome {
  line: string;
  written?: string;
}

async function saveOne(threadId: string, item: SaveItem, folders: ConnectedFolder[], deps: SaveDeps): Promise<SaveOutcome> {
  const outcome = await saveOneLine(threadId, item, folders, deps);
  return typeof outcome === 'string' ? { line: outcome } : outcome;
}

async function saveOneLine(threadId: string, item: SaveItem, folders: ConnectedFolder[], deps: SaveDeps): Promise<string | SaveOutcome> {
  const from = typeof item.from === 'string' ? item.from.trim() : '';
  const to = typeof item.to === 'string' ? item.to : '';
  const src = await resolveUploadSources(threadId, [from], deps);
  if (!src.ok) return `Not saved “${from}”: ${src.error}`;
  const file: UploadSource = src.files[0]!;
  let handedOff = false;
  try {
    const target = await resolveSaveTarget(threadId, to, file.name, folders);
    if (!target.ok) return `Not saved “${from}”: ${target.error}`;
    const t = target.target;
    const rel = t.kind === 'server' ? relative(t.root, t.path) : relative(t.folder.path, t.mirror);
    const hidden = hiddenPart(rel);
    if (hidden) return `Not saved “${from}”: “${hidden}” is hidden — save_file does not write into hidden files or folders.`;
    if (t.kind === 'server') {
      const problem = await writeHere(file.path, t.root, t.path);
      return problem
        ? `Not saved “${from}” to ${t.shown}: ${problem}.`
        : { line: `Saved “${from}” to ${t.shown} (${file.size} bytes).`, written: t.path };
    }
    const devices = deps.devices;
    const label = devices ? `“${await devices.label(t.deviceId)}”` : 'its computer';
    const host = devices ? await devices.hostFor(t.deviceId) : null;
    if (!devices || !host?.enabled) {
      return (
        `Not saved “${from}”: “${t.folder.label}” lives on ${label}, which does not accept commands from Stem. ` +
        'Its owner can turn that on in Settings → Features → Commands on that computer.'
      );
    }
    if (!host.saves) return `Not saved “${from}”: Stem on ${label} is too old to receive files — it needs updating.`;
    if (!devices.isAvailable(t.deviceId)) {
      return `Not saved “${from}”: ${label} is not connected right now. It works once that computer is awake with Stem running.`;
    }
    const entry = outboxPut(t.deviceId, file);
    // The outbox owns the snapshot now: it serves it once and deletes it.
    handedOff = true;
    const res = await devices.save(t.deviceId, { threadId, outboxId: entry.id, path: t.path });
    if (!res.ok) return `Not saved “${from}” to ${t.path} on ${label}: ${res.error}`;
    return {
      line: `Saved “${from}” to ${t.path} on ${label} (${file.size} bytes). The mirror at ${t.mirror} catches up within seconds.`,
      written: t.path
    };
  } finally {
    // quiet: a copy that will not delete is swept with the outbox folder on the next start.
    if (!handedOff) await rm(file.path, { force: true }).catch(() => undefined);
  }
}

/** Save each item, in order; one line per item. Ok when at least one was saved. */
export async function saveFiles(
  threadId: string,
  items: SaveItem[],
  deps: SaveDeps
): Promise<{ ok: true; text: string; written: string[] } | { ok: false; error: string }> {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: `Name at least one file to save. ${WHERE}` };
  if (items.length > MAX_SAVE_ITEMS) return { ok: false, error: `At most ${MAX_SAVE_ITEMS} files per call.` };
  const folders = (await deps.folders()).filter((f) => !f.missing || f.origin);
  const lines: string[] = [];
  // The paths written, kept apart from the text: the text quotes the model's
  // own `from` and `to`, so it is no record of what Stem wrote (the judge reads
  // this list, exec/judge-context.ts savedFilesAction).
  const written: string[] = [];
  for (const item of items) {
    const outcome = await saveOne(threadId, item ?? { from: '', to: '' }, folders, deps);
    lines.push(outcome.line);
    if (outcome.written) written.push(outcome.written);
  }
  const text = lines.join('\n');
  return written.length ? { ok: true, text, written } : { ok: false, error: text };
}
