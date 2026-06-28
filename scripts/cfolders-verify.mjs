// Verification probe for Connected Folders write-protection. Exercises the REAL
// extension helpers (isInside + makeProtectedRootsGate from stem-mcp-extension.mjs)
// that back the `tool_call` write-block hook, against a throwaway protected-roots
// gate file. Pure node — no Electron, no build step.
//
// Run (from repo root):
//   node scripts/cfolders-verify.mjs
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isInside, makeProtectedRootsGate } from '../src/main/pi/stem-mcp-extension.mjs';

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// --- containment (isInside) ---
const vault = '/Users/me/Vaults/Client';
check('file inside protected root → inside', isInside(`${vault}/notes/secret.md`, vault));
check('the root itself → inside', isInside(vault, vault));
check('sibling with shared prefix → NOT inside', !isInside('/Users/me/Vaults/ClientX/a.md', vault));
check('unrelated path → NOT inside', !isInside('/Users/me/workspace/files/a.md', vault));

// --- the write-block decision, replicating the extension's tool_call handler ---
const dir = join(tmpdir(), `cfolders-verify-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const prPath = join(dir, 'protected-roots.json');
const cwd = join(dir, 'workspace');
mkdirSync(cwd, { recursive: true });

writeFileSync(prPath, JSON.stringify({ roots: [vault] }, null, 2));
const roots = makeProtectedRootsGate(prPath);

// Mirror of the handler: block write/edit whose target resolves inside a protected root.
function blocked(toolName, path) {
  if (toolName !== 'write' && toolName !== 'edit') return false;
  if (typeof path !== 'string' || !path) return false;
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return roots().some((r) => isInside(abs, r));
}

check('edit inside protected root → BLOCKED', blocked('edit', `${vault}/a.md`));
check('write inside protected root → BLOCKED', blocked('write', `${vault}/sub/b.md`));
check('read inside protected root → allowed (reads never blocked)', !blocked('read', `${vault}/a.md`));
check('write into the workspace files/ → allowed', !blocked('write', join(cwd, 'files', 'note.md')));
check('relative write (resolves to cwd, not a root) → allowed', !blocked('write', 'files/note.md'));

// --- mtime-cached gate picks up a rewrite ---
writeFileSync(prPath, JSON.stringify({ roots: [] }, null, 2));
// bump mtime to guarantee the cache invalidates even on coarse-resolution clocks
const future = new Date(Date.now() + 2000);
utimesSync(prPath, future, future);
check('after roots cleared → no longer blocked', !blocked('edit', `${vault}/a.md`));

// --- missing/corrupt gate file → nothing protected ---
const missingGate = makeProtectedRootsGate(join(dir, 'does-not-exist.json'));
check('missing gate file → empty roots', missingGate().length === 0);

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL_PASS');
process.exit(failures ? 1 : 0);
