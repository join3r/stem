import { open, readdir } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import type { FolderSample } from '../../shared/types';

// A quick look inside a folder for the "suggest settings" button: enough of the
// tree for a model to tell a code repo from a notes vault from a pile of PDFs,
// and nothing else. Names and counts only, plus the first lines of a README —
// file contents never leave beyond that one excerpt, so suggesting settings for
// a confidential folder reads no more of it than a glance in Finder would.
//
// Used on both sides: the server samples its own folders (and client mirrors),
// the desktop samples a folder on this computer before it is connected — the
// server has no copy of that one yet.

/** Files counted before the walk stops; a large vault is judged by its first few thousand. */
const MAX_FILES = 3_000;
/** Directory depth walked below the root. */
const MAX_DEPTH = 5;
const MAX_PATHS = 40;
const MAX_TOP_LEVEL = 40;
const EXCERPT_CHARS = 1_200;

/** Names that say what a folder is. Their directories are noted but not walked into. */
const OPAQUE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', '.next', 'Pods']);
const MARKERS = new Set([
  ...OPAQUE_DIRS,
  '.obsidian',
  '.logseq',
  '.trash',
  'logseq',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  'tsconfig.json',
  '.gitignore',
  'Package.swift',
  'CMakeLists.txt'
]);

/** Walk `root` (an absolute path on this machine) and summarize it. Throws if it is not a readable folder. */
export async function sampleFolder(root: string): Promise<FolderSample> {
  const extensions = new Map<string, number>();
  const markers = new Set<string>();
  const files: string[] = [];
  let fileCount = 0;
  let truncated = false;

  const top = await readdir(root, { withFileTypes: true });
  const topLevel = top
    .filter((d) => !d.name.startsWith('.') || MARKERS.has(d.name))
    .slice(0, MAX_TOP_LEVEL)
    .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));

  // Breadth-first, so a deep tree still shows its upper levels before the cap.
  let level: string[] = [root];
  for (let depth = 0; depth <= MAX_DEPTH && level.length && !truncated; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = dir === root ? top : await readdir(dir, { withFileTypes: true });
      } catch {
        // quiet: an unreadable sub-folder is just absent from the sample.
        continue;
      }
      for (const e of entries) {
        if (MARKERS.has(e.name)) markers.add(e.name);
        if (e.isDirectory()) {
          if (!OPAQUE_DIRS.has(e.name) && !e.name.startsWith('.')) next.push(join(dir, e.name));
          continue;
        }
        if (!e.isFile() || e.name.startsWith('.')) continue;
        if (++fileCount > MAX_FILES) {
          fileCount = MAX_FILES;
          truncated = true;
          break;
        }
        const ext = extname(e.name).toLowerCase();
        extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
        files.push(relative(root, join(dir, e.name)));
      }
      if (truncated) break;
    }
    level = next;
  }

  // A spread rather than the first N, which would all sit in one sub-folder.
  const step = Math.max(1, Math.floor(files.length / MAX_PATHS));
  const paths = files.filter((_, i) => i % step === 0).slice(0, MAX_PATHS);

  const readme =
    files.find((f) => /^readme(\.[a-z]+)?$/i.test(f)) ??
    files.find((f) => /^(readme|index|home)\.md$/i.test(basename(f))) ??
    files.find((f) => /\.(md|txt)$/i.test(f));
  const excerpt = readme ? await readHead(join(root, readme)).then((text) => (text ? { file: readme, text } : undefined)) : undefined;

  return {
    name: basename(root.replace(/[/\\]+$/, '')) || root,
    fileCount,
    truncated,
    extensions: [...extensions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    topLevel,
    markers: [...markers].sort(),
    paths,
    ...(excerpt ? { excerpt } : {})
  };
}

async function readHead(path: string): Promise<string | null> {
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(EXCERPT_CHARS * 2);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8').slice(0, EXCERPT_CHARS).trim() || null;
    } finally {
      await fh.close();
    }
  } catch {
    // quiet: no excerpt is a normal sample.
    return null;
  }
}
