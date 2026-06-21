// Verification probe for the Files place (src/main/files). Exercises the REAL
// compiled store + inject modules against a throwaway folder: listing/grouping by
// subfolder, add (with collisions + subdir), remove (+ traversal guard), and the
// per-turn context builder.
//
// Run (from repo root):
//   rm -rf .files-build
//   npx tsc src/main/files/store.ts src/main/files/inject.ts src/main/workspace/paths.ts \
//     --outDir .files-build --module commonjs --moduleResolution node --target es2022 \
//     --skipLibCheck --esModuleInterop --rootDir src
//   printf '{"type":"commonjs"}' > .files-build/package.json
//   STEM_FILES_DIR="$(mktemp -d)/files" ELECTRON_RUN_AS_NODE=1 \
//     ./node_modules/.bin/electron scripts/files-verify.mjs
// (.files-build must live inside the repo so Node resolves `electron`; gitignored.)
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const BUILD = fileURLToPath(new URL('../.files-build/main/files/', import.meta.url));
const store = require(`${BUILD}/store.js`);
const inject = require(`${BUILD}/inject.js`);

const root = process.env.STEM_FILES_DIR;
if (!root) {
  console.log('FAIL: set STEM_FILES_DIR to a throwaway path');
  process.exit(1);
}
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const stage = join(root, '..', 'stage');
mkdirSync(stage, { recursive: true });
const srcA = join(stage, 'a.txt');
const srcCake = join(stage, 'cake.pdf');
writeFileSync(srcA, 'hello');
writeFileSync(srcCake, 'PASSPHRASE-7731 chocolate');

// empty folder
let listing = await store.listFiles();
check('empty: no files', listing.files.length === 0 && listing.dirs.length === 0);
check('empty: context is null', (await inject.buildFilesContext()) === null);

// add at root
listing = await store.addFiles([srcA]);
check('root add: a.txt present', listing.files.some((f) => f.rel === 'a.txt' && f.dir === ''));

// add into a subfolder (created on demand)
listing = await store.addFiles([srcCake], 'Recipes');
check('subdir add: Recipes/cake.pdf present', listing.files.some((f) => f.rel === 'Recipes/cake.pdf' && f.dir === 'Recipes'));
check('subdir add: Recipes listed as a dir', listing.dirs.includes('Recipes'));

// collision → numbered sibling
listing = await store.addFiles([srcA]);
check('collision: a-1.txt created', listing.files.some((f) => f.rel === 'a-1.txt'));

// context lists names with files/ prefix, not contents
const ctx = await inject.buildFilesContext();
check('context: mentions files/Recipes/cake.pdf', !!ctx && ctx.includes('files/Recipes/cake.pdf'));
check('context: does NOT leak file contents', !!ctx && !ctx.includes('PASSPHRASE-7731'));

// traversal guard: removing an escaping path is a no-op
const before = (await store.listFiles()).files.length;
await store.removeFile('../stage/a.txt');
check('traversal: escaping remove is a no-op', (await store.listFiles()).files.length === before);

// remove a real file
listing = await store.removeFile('Recipes/cake.pdf');
check('remove: cake.pdf gone', !listing.files.some((f) => f.rel === 'Recipes/cake.pdf'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
