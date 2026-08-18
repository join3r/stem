import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { degrade } from '../degrade';
import { extractPdfText } from './pdf';
import { DOC_EMBED_MIN_CHARS, type FolderIndexStore } from './store';

// One incremental scan of an indexed connected folder into its index store.
// Mirror semantics: the folder is the source of truth and is never written to —
// we upsert what we see and prune what disappeared (via the store's scan
// generation). Unchanged files are detected by (mtime, size) without reading;
// changed files re-read, and an equal content hash still skips the reindex so
// editor touch-saves don't churn vectors.
//
// Indexes plain text (.txt/.md) and the text layer of PDFs (pdf.js — no OCR,
// so image-only scans are skipped). Everything else is counted per extension so
// the Folders tab can show what was skipped (and hint at what to parse next).
// PDFs that fail extraction are remembered by (mtime, size) in meta so a
// folder of scanned PDFs isn't re-parsed on every rescan.

/** Extensions indexed as plain text (lowercase, with dot). */
export const INDEXED_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text']);

/** Never index a text file larger than this — a giant log would flood the index. */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;

/**
 * Raw-size cap for PDFs — file size is dominated by fonts/images, not text, so
 * the cap is looser; the extracted text itself is still capped at MAX_DOC_BYTES.
 */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Directories skipped silently (not "unsupported" — just not content). */
const IGNORED_DIRS = new Set(['node_modules', '__pycache__']);

/** Skip-count keys for candidates rejected by the content guards. */
export const SKIP_TOO_LARGE = 'too-large';
export const SKIP_BINARY = 'binary';
export const SKIP_PDF_NO_TEXT = 'pdf-no-text';
export const SKIP_PDF_UNREADABLE = 'pdf-unreadable';

/** Meta key remembering PDFs that yielded no text, keyed by rel path. */
const PDF_SKIP_CACHE_KEY = 'pdf_skip_cache';

type PdfSkipCache = Record<string, { mtime: number; size: number; reason: string }>;

export interface ScanResult {
  indexed: number;
  removed: number;
  skippedByExt: Record<string, number>;
}

/** Dotfiles/dot-dirs (.git, .obsidian, .DS_Store) are never content. */
function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/** A doc title: the first markdown heading, else the filename without extension. */
export function docTitle(relPath: string, text: string): string {
  const heading = text.match(/^#{1,6}[ \t]+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.slice(0, 200);
  const name = basename(relPath);
  return basename(name, extname(name)) || name;
}

/** Null byte in the lead bytes → mislabeled binary, not text. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

interface Candidate {
  abs: string;
  rel: string;
  kind: 'text' | 'pdf';
  mtime: number;
  size: number;
}

/**
 * Scan `root` into `store`. Walks the tree, classifies every file, indexes
 * changed .txt/.md/.pdf content and prunes vanished docs — all writes in one
 * transaction so a reader never sees a half-scanned folder. Throws on a
 * vanished/unreadable root (the caller decides what a missing folder means).
 */
export async function scanFolder(store: FolderIndexStore, root: string): Promise<ScanResult> {
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const skippedByExt: Record<string, number> = {};
  const skip = (key: string): void => {
    skippedByExt[key] = (skippedByExt[key] ?? 0) + 1;
  };

  // Pass 1 (I/O): walk and classify, collecting candidate text files.
  const candidates: Candidate[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      // The scan is a mirror: what it does not see, it prunes. A subtree that
      // will not list takes every doc under it out of the index, and the pass
      // reports that as a clean "N removed".
      degrade('folder-index.scan', 'pruned the docs under an unreadable subfolder', e);
      return;
    }
    for (const e of entries) {
      if (isHidden(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = extname(e.name).toLowerCase();
      const kind = INDEXED_EXTENSIONS.has(ext) ? 'text' : ext === '.pdf' ? 'pdf' : null;
      if (!kind) {
        skip(ext || '(no extension)');
        continue;
      }
      let s;
      try {
        s = await stat(abs);
      } catch {
        // quiet: listed moments ago and gone now — it vanished mid-scan, and the
        // next scan indexes it if it comes back.
        continue;
      }
      if (s.size > (kind === 'pdf' ? MAX_PDF_BYTES : MAX_DOC_BYTES)) {
        skip(SKIP_TOO_LARGE);
        continue;
      }
      candidates.push({
        abs,
        rel: relative(root, abs).split(sep).join('/'),
        kind,
        mtime: Math.floor(s.mtimeMs),
        size: s.size
      });
    }
  }
  await walk(root);

  // Pass 2 (I/O): read only files whose (mtime, size) changed since last scan.
  // PDFs that previously yielded no text are also change-detected (via the meta
  // skip cache) so they aren't re-parsed every rescan.
  let priorPdfSkips: PdfSkipCache = {};
  try {
    priorPdfSkips = JSON.parse(store.readMeta(PDF_SKIP_CACHE_KEY) ?? '{}') as PdfSkipCache;
  } catch {
    // quiet: corrupt cache — re-extract everything once and rewrite it.
  }
  const nextPdfSkips: PdfSkipCache = {};
  const known = store.knownDocs();
  const unchanged: Array<{ id: number; mtime: number; size: number }> = [];
  const changed: Array<Candidate & { text: string; title: string; hash: string }> = [];
  for (const c of candidates) {
    const prior = known.get(c.rel);
    if (prior && prior.mtime === c.mtime && prior.size === c.size) {
      unchanged.push({ id: prior.id, mtime: c.mtime, size: c.size });
      continue;
    }
    if (c.kind === 'pdf') {
      const cached = priorPdfSkips[c.rel];
      if (cached && cached.mtime === c.mtime && cached.size === c.size) {
        skip(cached.reason);
        nextPdfSkips[c.rel] = cached;
        continue;
      }
    }
    let buf: Buffer;
    try {
      buf = await readFile(c.abs);
    } catch {
      // quiet: statted moments ago and unreadable now, so it moved. Absent this
      // scan, pruned if it stays gone, indexed again when it comes back.
      continue;
    }
    if (c.kind === 'pdf') {
      const pdf = await extractPdfText(buf, MAX_DOC_BYTES);
      if (pdf === null || !pdf.text) {
        const reason = pdf === null ? SKIP_PDF_UNREADABLE : SKIP_PDF_NO_TEXT;
        skip(reason);
        nextPdfSkips[c.rel] = { mtime: c.mtime, size: c.size, reason };
        continue;
      }
      changed.push({
        ...c,
        text: pdf.text,
        title: pdf.title ?? docTitle(c.rel, ''),
        hash: createHash('sha1').update(buf).digest('hex')
      });
      continue;
    }
    if (looksBinary(buf)) {
      skip(SKIP_BINARY);
      continue;
    }
    const text = buf.toString('utf8').trim();
    changed.push({ ...c, text, title: docTitle(c.rel, text), hash: createHash('sha1').update(buf).digest('hex') });
  }

  // Pass 3 (DB, synchronous): commit the whole scan atomically.
  const removed = store.transaction(() => {
    const scanGen = store.nextScanGeneration();
    for (const u of unchanged) store.touchDoc(u.id, u.mtime, u.size, scanGen);
    for (const c of changed) {
      store.upsertDoc(
        { relPath: c.rel, title: c.title, text: c.text, mtime: c.mtime, size: c.size, hash: c.hash },
        scanGen
      );
    }
    const pruned = store.pruneNotSeen(scanGen);
    store.writeScanStats({ skippedByExt, lastScanTs: Math.floor(Date.now() / 1000) });
    store.writeMeta(PDF_SKIP_CACHE_KEY, JSON.stringify(nextPdfSkips));
    return pruned;
  });

  return { indexed: unchanged.length + changed.length, removed, skippedByExt };
}

/**
 * The embedding input for a doc: title + lead text, bounded to e5's useful
 * window (~1500 chars). One vector per doc — thin by design; FTS covers the
 * long tail verbatim. Null = too short to carry signal.
 */
export function docEmbedText(title: string, text: string): string | null {
  if (text.length < DOC_EMBED_MIN_CHARS) return null;
  return `${title}\n${text}`.slice(0, 1500);
}
