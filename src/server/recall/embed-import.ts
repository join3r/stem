import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { EMBED_CATALOG, type LocalEmbedModelSpec } from './embed-catalog';
import { RERANK_CATALOG, type LocalRerankModelSpec } from './rerank-catalog';
import { missingModelFiles, weightsFile, type EmbedDtype } from './embed-files';
import type { ImportedModelInfo, ImportModelResult } from '../../shared/types';

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
    } catch {
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
 * is held open and cannot be replaced.
 */
function copyModel(candidate: ImportCandidate, cacheDir: string): ImportedModelInfo {
  const dest = join(cacheDir, ...candidate.repo.split('/'));
  let copied = 0;
  for (const abs of filesUnder(candidate.sourceDir)) {
    const target = join(dest, relative(candidate.sourceDir, abs));
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(abs, target);
    copied += 1;
  }
  const { id, stage, repo, label } = candidate;
  return { id, stage, repo, label, copied, alreadyPresent: copied === 0 };
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
    return { ok: false, error: `There is nothing at ${dir}.` };
  }
  if (!stats.isDirectory()) return { ok: false, error: `${dir} is a file — choose the folder holding the model.` };

  const candidates = findImportableModels(dir);
  if (!candidates.length) {
    return {
      ok: false,
      error: `No model Stem knows about is in that folder. ${describeCatalog()}`
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

  return { ok: true, models: candidates.map((c) => copyModel(c, cacheDir)) };
}
