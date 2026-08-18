import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { EMBED_CATALOG, type LocalEmbedModelSpec } from './embed-catalog';
import { RERANK_CATALOG, type LocalRerankModelSpec } from './rerank-catalog';
import { missingModelFiles, weightsFile, type EmbedDtype } from './embed-files';
import { degrade } from '../degrade';
import type { CustomImportCandidate, ImportedModelInfo, ImportModelResult } from '../../shared/types';

// Bringing model weights in from a folder the user already has — a colleague's
// cache, a `huggingface-cli download`, a USB stick. Stem does not ship or
// redistribute weights; this is how a machine that cannot reach huggingface.co
// gets them anyway.
//
// Three layouts are accepted because those are the three ways people end up
// holding a model, and asking someone to rearrange directories is the friction
// this exists to remove:
//   embed-models/Xenova/multilingual-e5-small/onnx/…      a Stem cache
//   models--Xenova--multilingual-e5-small/snapshots/<sha>/…  a Hub cache
//   multilingual-e5-small/onnx/…                          one model on its own

/** How deep to look for a model root before giving up on a folder. */
const MAX_DEPTH = 6;
/** Guard against being pointed at a home directory: stop after this many dirs. */
const MAX_DIRS_SCANNED = 4000;

export interface ImportCandidate {
  /** The catalog id this folder satisfies. */
  id: string;
  /** Which stage's catalog it came from. */
  stage: 'embed' | 'rerank';
  /** Hugging Face repo id, e.g. Xenova/multilingual-e5-small. */
  repo: string;
  label: string;
  dtype: EmbedDtype;
  /** The directory holding config.json and onnx/ for this model. */
  sourceDir: string;
}

type CatalogSpec = LocalEmbedModelSpec | LocalRerankModelSpec;

/** repo id → the shapes it can appear as in a path, lowercased. */
function repoAliases(repo: string): string[] {
  const [org, name] = repo.split('/');
  return [repo.toLowerCase(), `models--${org}--${name}`.toLowerCase()];
}

function dirsUnder(root: string): string[] {
  const out: string[] = [root];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length && out.length < MAX_DIRS_SCANNED) {
    const { dir, depth } = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // quiet: walking a folder someone picked routinely crosses ones the OS
      // will not list. A directory we cannot read holds nothing importable, and
      // the user is told plainly when the walk as a whole finds no model.
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const child = join(dir, ent.name);
      const isDir = ent.isDirectory() || (ent.isSymbolicLink() && statSync(child, { throwIfNoEntry: false })?.isDirectory());
      if (!isDir) continue;
      out.push(child);
      queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return out;
}

/** The catalog entry whose repo id is written somewhere in this path. */
function specForPath(dir: string, specs: CatalogSpec[]): CatalogSpec | null {
  const hay = dir.toLowerCase().split(sep).join('/');
  for (const spec of specs) {
    if (repoAliases(spec.repo).some((alias) => hay.includes(alias))) return spec;
  }
  return null;
}

/**
 * Every catalogued model found under `dir`. A folder is a model root when it
 * holds the weights file for the catalog entry its path names — the path is what
 * identifies the model, because a bare config.json does not say which repo it
 * came from.
 */
export function findImportableModels(dir: string): ImportCandidate[] {
  const embed = Object.values(EMBED_CATALOG) as CatalogSpec[];
  const rerank = Object.values(RERANK_CATALOG) as CatalogSpec[];
  const found = new Map<string, ImportCandidate>();
  for (const candidate of dirsUnder(dir)) {
    for (const [stage, specs] of [
      ['embed', embed],
      ['rerank', rerank]
    ] as const) {
      const spec = specForPath(candidate, specs);
      if (!spec || found.has(spec.repo)) continue;
      if (!existsSync(join(candidate, 'onnx', weightsFile(spec.dtype)))) continue;
      found.set(spec.repo, {
        id: spec.id,
        stage,
        repo: spec.repo,
        label: spec.label,
        dtype: spec.dtype,
        sourceDir: candidate
      });
    }
  }
  return [...found.values()];
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const dir of dirsUnder(root)) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Unlike the walk above, this list IS the copy list: a folder that will
      // not enumerate drops its files from the import, and the model then fails
      // at load time on the machine that had no way to fetch it in the first
      // place — which is the failure importing is supposed to prevent.
      degrade('recall.embedImport', 'skipped the files in a folder it could not list', err);
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      // A Hugging Face cache stores every file as a symlink into blobs/, so
      // isFile() alone would copy nothing at all. statSync follows the link.
      if (ent.isFile()) out.push(join(dir, ent.name));
      else if (ent.isSymbolicLink() && statSync(join(dir, ent.name), { throwIfNoEntry: false })?.isFile())
        out.push(join(dir, ent.name));
    }
  }
  return out;
}

/**
 * Copy one model into the cache. Never overwrites: a file already there is left
 * alone, which is both the right answer for a model that is already installed
 * and the reason this cannot fail on Windows, where the ONNX of a loaded model
 * is held open and cannot be replaced. Returns how many files were new.
 */
function copyModelFiles(sourceDir: string, repo: string, cacheDir: string): number {
  const dest = join(cacheDir, ...repo.split('/'));
  let copied = 0;
  for (const abs of filesUnder(sourceDir)) {
    const target = join(dest, relative(sourceDir, abs));
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(abs, target);
    copied += 1;
  }
  return copied;
}

function copyModel(candidate: ImportCandidate, cacheDir: string): ImportedModelInfo {
  const copied = copyModelFiles(candidate.sourceDir, candidate.repo, cacheDir);
  const { id, stage, repo, label } = candidate;
  return { id, stage, repo, label, copied, alreadyPresent: copied === 0 };
}

// ---- models Stem has no entry for ----
//
// The catalog is a shortlist of models we verified, not a claim about what
// works: a folder holding some other ONNX embedder is a perfectly good model
// that Stem simply cannot name. Everything below is about deriving what CAN be
// derived from such a folder, so the import dialog only has to ask the things a
// directory listing genuinely cannot answer.

/** The dtype implied by which weights file the folder actually has. */
function dtypeInDir(dir: string): EmbedDtype | null {
  for (const dtype of ['q8', 'q4', 'fp32'] as const) {
    if (existsSync(join(dir, 'onnx', weightsFile(dtype)))) return dtype;
  }
  return null;
}

/** One path segment, reduced to what may name a folder under the model cache. */
function safeSegment(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return !cleaned || cleaned === '.' || cleaned === '..' ? fallback : cleaned;
}

/**
 * The repo id a model folder implies. A Hub cache writes it into the path
 * (`models--org--name`) even several levels above the snapshot, so that wins
 * wherever it appears; otherwise the folder and its parent are the two names
 * anyone would read as org and model, which is also the layout the Stem cache
 * and a `huggingface-cli download --local-dir` both produce.
 */
export function repoFromPath(dir: string): string {
  const segments = dir.split(sep).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const hub = /^models--(.+?)--(.+)$/.exec(segments[i]!);
    if (hub) return `${safeSegment(hub[1]!, 'imported')}/${safeSegment(hub[2]!, 'model')}`;
  }
  const name = safeSegment(segments[segments.length - 1] ?? '', 'model');
  const parent = safeSegment(segments[segments.length - 2] ?? '', 'imported');
  return `${parent}/${name}`;
}

/** Roughly how much disk this model takes, for the line under its name in the picker. */
function approxSizeMB(dir: string): number {
  let bytes = 0;
  for (const file of filesUnder(dir)) bytes += statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

/**
 * Model folders under `dir` that no catalog entry claims. A folder qualifies on
 * the same evidence transformers.js needs to load one at all — a config.json
 * beside an `onnx/` with weights in it — because there is no other honest test:
 * nothing in the files says "I am an embedder" or names the repo it came from.
 */
export function findCustomImportables(dir: string): CustomImportCandidate[] {
  const catalog = [...Object.values(EMBED_CATALOG), ...Object.values(RERANK_CATALOG)] as CatalogSpec[];
  const found = new Map<string, CustomImportCandidate>();
  for (const candidate of dirsUnder(dir)) {
    // A folder the catalog recognises belongs to the zero-question path, even
    // when it turns out to be incomplete — that refusal names the missing file,
    // which is far more use than being asked to describe it from scratch.
    if (specForPath(candidate, catalog)) continue;
    if (!existsSync(join(candidate, 'config.json'))) continue;
    const dtype = dtypeInDir(candidate);
    if (!dtype) continue;
    const repo = repoFromPath(candidate);
    if (found.has(repo)) continue;
    found.set(repo, {
      repo,
      label: basename(candidate) || repo,
      dtype,
      approxSizeMB: approxSizeMB(candidate),
      sourceDir: candidate
    });
  }
  return [...found.values()];
}

/**
 * Copy in a model Stem has no entry for. Same completeness check and same
 * never-overwrite rule as the catalog path — the description the user gave says
 * nothing about whether the files are all there, and a load that fails offline
 * is exactly what import exists to prevent.
 */
export function importCustomModel(
  sourceDir: string,
  repo: string,
  dtype: EmbedDtype,
  cacheDir: string
): { ok: true; copied: number } | { ok: false; error: string } {
  if (!statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
    return { ok: false, error: `There is nothing at ${sourceDir}.` };
  }
  const missing = missingModelFiles(sourceDir, '', dtype);
  if (missing.length) {
    return {
      ok: false,
      error: `That folder is missing ${missing.join(', ')}. Copy the whole model folder, not just the weights.`
    };
  }
  const copied = copyModelFiles(sourceDir, repo, cacheDir);
  const short = missingModelFiles(cacheDir, repo, dtype);
  if (short.length) {
    return {
      ok: false,
      error: `That model did not copy completely — ${short.join(', ')} did not arrive in the model cache. Check the folder is readable and try again.`
    };
  }
  return { ok: true, copied };
}

function describeCatalog(): string {
  const embed = Object.values(EMBED_CATALOG).map((s) => s.label);
  const rerank = Object.values(RERANK_CATALOG).map((s) => s.label);
  return `Stem can use ${embed.join(', ')} for embeddings and ${rerank.join(', ')} for reranking.`;
}

/**
 * Validate and copy every model in `dir` into the model cache. Refuses by name
 * when a model is incomplete — that is the whole value of doing this at import
 * time, because the same gap discovered at load time is an ONNX error nobody
 * can act on, on a machine with no way to fetch the missing piece.
 */
export function importLocalModels(dir: string, cacheDir: string): ImportModelResult {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    // quiet: the refusal below IS the report — it goes back to the import
    // dialog as the line the user reads.
    return { ok: false, error: `There is nothing at ${dir}.` };
  }
  if (!stats.isDirectory()) return { ok: false, error: `${dir} is a file — choose the folder holding the model.` };

  const candidates = findImportableModels(dir);
  if (!candidates.length) {
    // Not necessarily a dead end: the folder may hold a perfectly good model
    // that is simply not one of ours, and the caller can offer to describe it
    // rather than send the user away to find a model from the list instead.
    const unknown = findCustomImportables(dir);
    return {
      ok: false,
      error: `No model Stem knows about is in that folder. ${describeCatalog()}`,
      ...(unknown.length ? { unknown } : {})
    };
  }

  const incomplete = candidates
    .map((c) => ({ c, missing: missingModelFiles(c.sourceDir, '', c.dtype) }))
    .filter((x) => x.missing.length);
  if (incomplete.length) {
    const { c, missing } = incomplete[0]!;
    return {
      ok: false,
      error: `${c.label} is missing ${missing.join(', ')}. Copy the whole model folder, not just the weights.`
    };
  }

  const models = candidates.map((c) => copyModel(c, cacheDir));
  // The SOURCE was checked above; this checks what actually landed. filesUnder()
  // drops a directory it cannot enumerate, so a copy can come out short with
  // every step reporting success — and that gap surfaces as an ONNX error at
  // load time, on the machine that had no way to fetch the missing piece, which
  // is the exact failure importing exists to prevent.
  const short = candidates
    .map((c) => ({ c, missing: missingModelFiles(cacheDir, c.repo, c.dtype) }))
    .filter((x) => x.missing.length);
  if (short.length) {
    const { c, missing } = short[0]!;
    return {
      ok: false,
      error: `${c.label} did not copy completely — ${missing.join(', ')} did not arrive in the model cache. Check the folder is readable and try again.`
    };
  }
  return { ok: true, models };
}
