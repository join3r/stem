// The version of the persona / skills / memory PROGRAMMING a build carries.
//
// Not the user's data (which persona exists, what its prompt says) — the code
// that drives them: how mail fans out between personas, what the delivery
// preamble tells a persona, how reflection writes notes, how skills are picked
// and injected, how recall retrieves and gates. Every mail item and every chat
// turn is stamped with this at the time it was produced, so "look at the mails
// made by the personas we have NOW" is a filter on one field rather than a
// guess from dates.
//
// Derived, never maintained: each subsystem's hash is a sha256 over the source
// files listed below (path + bytes, sorted), cut to 12 hex. A comment edit bumps
// it — the safe direction; a forgotten manual bump would be the harmful one.
// Computed at bundle time in electron.vite.config.ts and inlined as
// __STEM_SYS_VERSION__ (src/server/sys-version.ts reads it); the Docker build
// stage has the same src/ tree, so the container gets the same answer without
// needing .git. Run directly to print the checkout's version:
//
//   node scripts/sys-version.mjs
//
// which is what you compare against a server's boot line or a mail item's `sys`.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// stem-mcp-extension.mjs defines the tools every subsystem exposes to the model
// (send_mail, remember_note, search_facts, the skill tools) and their
// descriptions are as much "programming" as the router is. It is one file, so
// it counts toward all three: a change there makes every hash move, which is
// honest — something all of them share changed. pi/runtime.ts is deliberately
// NOT listed: it changes for chat/perf reasons on most commits, and folding it
// in would make the hashes churn until they said nothing. Subsystem-specific
// pieces that used to live there (the mail preamble) were moved out into their
// subsystem's directory so they count.
const SHARED = ['src/server/pi/stem-mcp-extension.mjs', 'src/server/pi/mcp-discovery.mjs', 'src/server/workspace/bootstrap.ts', 'docs/assistant'];

export const SUBSYSTEMS = {
  persona: ['src/server/mail', 'src/server/workspace/personas.ts', ...SHARED],
  skills: ['src/server/skills', ...SHARED],
  memory: ['src/server/recall', 'src/server/workspace/persona-memory.ts', ...SHARED]
};

function collect(rootDir, rel, out) {
  const abs = join(rootDir, rel);
  const st = statSync(abs);
  if (st.isFile()) {
    out.push(rel.split(sep).join('/'));
    return;
  }
  for (const name of readdirSync(abs).sort()) collect(rootDir, join(rel, name), out);
}

/** sha256 over the listed files and directories (recursive), cut to 12 hex. */
export function hashPaths(rootDir, paths) {
  const files = [];
  for (const p of paths) collect(rootDir, p, files);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(rootDir, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

/**
 * The commit this tree is built from, `-dirty` when uncommitted changes are in
 * it — or undefined when there is no git to ask (the Docker build stage: pass
 * STEM_GIT_SHA as a build arg instead, see docker-compose.yml).
 */
export function gitBuild(rootDir) {
  const env = (process.env.STEM_GIT_SHA ?? '').trim();
  if (env) return env;
  try {
    const git = (args) =>
      execFileSync('git', args, { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    const sha = git(['rev-parse', '--short=12', 'HEAD']);
    if (!sha) return undefined;
    const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return undefined;
  }
}

export function computeSystemVersion(rootDir) {
  const out = {};
  for (const [name, paths] of Object.entries(SUBSYSTEMS)) out[name] = hashPaths(rootDir, paths);
  const build = gitBuild(rootDir);
  if (build) out.build = build;
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDir = join(new URL('.', import.meta.url).pathname, '..');
  console.log(JSON.stringify(computeSystemVersion(rootDir), null, 2));
}
