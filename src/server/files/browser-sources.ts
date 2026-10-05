import { constants } from 'node:fs';
import { open, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, sep } from 'node:path';
import { ensureThreadScratch } from '../exec/scratch';
import { execReadRoots } from '../exec/protected';
import { workspaceRoot } from '../workspace/paths';
import { snapshotFromBytes, snapshotFromHandle } from './outbox';

// Which files the `browser` tool may attach to a web page: only files Stem
// already holds (the user's choice, 2026-10-05) — never a path on the Mac,
// because a page that talks the model into "upload ~/.ssh/id_rsa" must find
// nothing to upload. Concretely, the files the model can already READ on the
// server: its cwd (Files is `files/` in it), the scratch folders, and the
// connected folders (execReadRoots), plus images by their `img_…` id.
//
// Each accepted file is copied, through the handle the check verified, into a
// private snapshot (files/outbox.ts), and the snapshot is what the Mac fetches.

/** Per file. A browser upload of more than this is not a chat-sized job. */
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 10;

const IMAGE_ID = /^img_[0-9a-f]{6,32}$/;

export interface UploadSource {
  /** The private snapshot to serve. */
  path: string;
  /** What the page will see the file called. */
  name: string;
  size: number;
}

export interface BrowserSourceDeps {
  findThreadImage(threadId: string, imageId: string): Promise<{ mimeType: string; data: string } | null>;
  /** Overridable for tests; defaults to execReadRoots(). */
  readRoots?: () => string[];
}

const FORMS =
  'Name files the way you read them: `files/<name>` for the Files place, a path in your scratch folder or a ' +
  'connected folder, or an attached image’s `img_…` id. Paths on the user’s Mac cannot be uploaded.';

function extFor(mimeType: string): string {
  const sub = mimeType.split('/')[1]?.toLowerCase() ?? '';
  if (sub === 'jpeg') return '.jpg';
  return /^[a-z0-9]+$/.test(sub) ? `.${sub}` : '';
}

async function realRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(await realpath(r));
    } catch {
      // quiet: a root that does not exist (yet) contains nothing to upload.
    }
  }
  return out;
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);

type Checked = { ok: true; file: UploadSource } | { ok: false; error: string };

/**
 * Open the approved real path without following a final symlink, then make
 * sure the handle is still the file at that path — same inode, path still
 * resolving to itself — before copying through it. A folder above it swapped
 * for a link between the check and the open lands the handle on another inode
 * and is refused here.
 */
async function snapshotChecked(ref: string, found: string): Promise<Checked> {
  let fh;
  try {
    fh = await open(found, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    // quiet: refused with the reason the model can act on.
    return { ok: false, error: `“${ref}” could not be opened.` };
  }
  try {
    const held = await fh.stat();
    if (!held.isFile()) return { ok: false, error: `“${ref}” is not a file.` };
    if (held.size > MAX_UPLOAD_FILE_BYTES) {
      return { ok: false, error: `“${ref}” is larger than ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB.` };
    }
    const again = await realpath(found).catch(() => null);
    const there = again === found ? await stat(found).catch(() => null) : null;
    if (!there || there.ino !== held.ino || there.dev !== held.dev) {
      return { ok: false, error: `“${ref}” changed while it was being checked; try again.` };
    }
    const snap = await snapshotFromHandle(fh);
    return { ok: true, file: { path: snap.path, name: basename(found), size: snap.size } };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Resolve the model's file names to private snapshots of checked server files,
 * or say which one cannot be uploaded and why. All or nothing: half an upload
 * is a form the model would then submit with a file missing.
 */
export async function resolveUploadSources(
  threadId: string,
  refs: string[],
  deps: BrowserSourceDeps
): Promise<{ ok: true; files: UploadSource[] } | { ok: false; error: string }> {
  if (!refs.length) return { ok: false, error: `Name at least one file to upload. ${FORMS}` };
  if (refs.length > MAX_FILES) return { ok: false, error: `At most ${MAX_FILES} files per upload.` };
  const files: UploadSource[] = [];
  const res = await collect(threadId, refs, deps, files);
  // A refusal part way through drops the copies already taken for this call.
  if (!res.ok) for (const f of files) await rm(f.path, { force: true }).catch(() => undefined);
  return res.ok ? { ok: true, files } : res;
}

async function collect(
  threadId: string,
  refs: string[],
  deps: BrowserSourceDeps,
  files: UploadSource[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const scratch = await ensureThreadScratch(threadId);
  const roots = await realRoots((deps.readRoots ?? execReadRoots)());
  for (const raw of refs) {
    const ref = typeof raw === 'string' ? raw.trim() : '';
    if (!ref || ref.includes('\0')) return { ok: false, error: `“${String(raw)}” is not a file name. ${FORMS}` };

    if (IMAGE_ID.test(ref)) {
      const image = await deps.findThreadImage(threadId, ref);
      if (!image) return { ok: false, error: `No image ${ref} in this conversation.` };
      const snap = await snapshotFromBytes(Buffer.from(image.data, 'base64'));
      files.push({ path: snap.path, name: `${ref}${extFor(image.mimeType)}`, size: snap.size });
      continue;
    }

    // Relative names resolve the way the model's own read tool does (its cwd,
    // where `files/` lives), then against this chat's scratch folder, where
    // run_command and downloads put things.
    const candidates = isAbsolute(ref) ? [ref] : [join(workspaceRoot(), ref), join(scratch, ref)];
    let found: string | null = null;
    for (const c of candidates) {
      try {
        found = await realpath(c);
        break;
      } catch {
        // quiet: try the next place; none matching is reported below.
      }
    }
    if (!found) return { ok: false, error: `No file “${ref}”. ${FORMS}` };
    if (!roots.some((r) => within(found, r))) {
      return { ok: false, error: `“${ref}” is outside the files Stem may upload. ${FORMS}` };
    }
    const checked = await snapshotChecked(ref, found);
    if (!checked.ok) return checked;
    files.push(checked.file);
  }
  return { ok: true };
}
