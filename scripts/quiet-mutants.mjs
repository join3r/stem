#!/usr/bin/env node
// Mutation probe for swallowed failures. For each catch block in src/server that
// carries no signal, force the `try` it guards to throw and run the unit suite.
//
// Runs against a COPY of the repo under the OS temp dir, with node_modules
// symlinked in — the working tree is never written to. That is not tidiness: an
// earlier version mutated the real files and restored them per mutant, which meant
// the tree held a `throw new Error('MUTANT')` for the whole run, and a Ctrl-C
// landing between the write and the restore left one behind. A tool you cannot
// interrupt safely is a tool nobody runs.
//
// How to read the result depends on what the site claims.
//
//   Untriaged site (says nothing, explains nothing) — SURVIVING is the finding: a
//   failure path the app can take with nothing to show for it and no test that
//   notices. That is the shape of the 0.4.x bugs that reached a release, and the
//   first run over src/server found 10 of 26 sampled sites like that.
//
//   `// quiet:` site — read the two outcomes as a partition, not a pass/fail. The
//   probe breaks the guarded WORK, not the silence, so being killed only means some
//   test watches that work; it does not by itself prove the note wrong. SURVIVING is
//   the one that matters: nothing in the suite notices this failing at all, so if
//   the note's claim is wrong, nothing will ever tell you. Those are the claims
//   carrying their weight unaided, and the list worth re-reading by hand.
//
//   `degrade()` site — signals, so it is never probed. Its reporting is not asserted
//   by this tool; assert it with a test that reads degradations(), as
//   tests/unit/quiet-signals.test.ts does.
//
// Not part of `npm test`: one mutant costs a full suite run, so a sweep of ~160
// sites is hours. Run it against a subsystem you touched, or nightly.
//
//   node scripts/quiet-mutants.mjs [--roots src/server/recall] [--sample 30] [--list]
//
// Survivors are printed to stdout, newline-separated, so the list can go straight
// into a work queue.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const roots = flag('roots', 'src/server').split(',');
const sampleSize = Number(flag('sample', '0'));

// The scanner is shared with the guard test so the two always mean the same thing
// by "swallows"; it is TypeScript, so run this under a Node that strips types (24+,
// which package.json already requires).
const { scanCatches } = await import(join(repo, 'tests/quiet-scan.ts'));

/** Offset just after the `{` opening the `try` that this catch closes, or -1. */
function tryBodyStart(source, catchIndex) {
  const closes = source.lastIndexOf('}', catchIndex);
  if (closes < 0) return -1;
  let i = closes;
  let depth = 1;
  while (i > 0 && depth > 0) {
    i--;
    if (source[i] === '}') depth++;
    else if (source[i] === '{') depth--;
  }
  return /\btry\s*$/.test(source.slice(Math.max(0, i - 12), i)) ? i + 1 : -1;
}

const sites = [];
let arrowsSkipped = 0;
for (const site of scanCatches(roots)) {
  if (site.signals) continue;
  // Arrow handlers have no `try` to break: making `foo().catch(() => null)` fire
  // means making foo() reject, which is per-call-site work a text mutation cannot
  // do. The guard still covers them; the probe does not, and says so rather than
  // quietly reporting a smaller denominator.
  if (site.kind === 'arrow') {
    arrowsSkipped++;
    continue;
  }
  const source = readFileSync(site.file, 'utf8');
  // Re-find this catch by line, since scanCatches hands back a line not an offset.
  const offset = source.split('\n').slice(0, site.line - 1).join('\n').length;
  const catchIndex = source.indexOf('catch', offset);
  const insertAt = tryBodyStart(source, catchIndex);
  if (insertAt > 0) sites.push({ file: site.file, line: site.line, insertAt, quiet: site.quiet });
}

// --list is the triage worklist: what still says nothing AND has not explained why.
// The probe itself deliberately covers the `// quiet:` sites too — the note is a
// claim, and breaking the try is how much of that claim gets checked — but a site
// that has been triaged is not work left to do.
if (args.includes('--list')) {
  const todo = sites.filter((s) => !s.quiet);
  for (const site of todo) console.log(`${site.file}:${site.line}`);
  console.error(
    `${todo.length} untriaged (of ${sites.length} swallowed) under ${roots.join(', ')}` +
      (arrowsSkipped ? `; ${arrowsSkipped} arrow handler(s) not probeable, see the guard` : '')
  );
  process.exit(0);
}

const step = sampleSize > 0 ? Math.max(1, Math.floor(sites.length / sampleSize)) : 1;
const chosen = sites.filter((_, i) => i % step === 0).slice(0, sampleSize || sites.length);

// The repo minus what a `vitest run` cannot use: node_modules is symlinked (it is
// gigabytes), and the caches, the mobile app and the build outputs are excluded by
// size. Copying a hand-picked list instead is what the first attempt did, and it
// silently broke the whole tool — 14 test files read docs/, RELEASE_NOTES.md and
// .external, so they failed for want of a file and EVERY mutant came back "killed".
const EXCLUDE = new Set([
  'node_modules', '.git', 'dist', 'release', 'test-results', 'build',
  '.recall-build', '.skills-build', '.embed-smoke-cache', 'mobile'
]);
const sandbox = mkdtempSync(join(tmpdir(), 'stem-quiet-probe-'));
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
for (const entry of readdirSync(repo)) {
  if (EXCLUDE.has(entry)) continue;
  cpSync(join(repo, entry), join(sandbox, entry), { recursive: true });
}
symlinkSync(join(repo, 'node_modules'), join(sandbox, 'node_modules'), 'dir');

const suite = () =>
  execFileSync('npx', ['vitest', 'run', '--silent', '--exclude', 'tests/unit/quiet-failures.test.ts'], {
    cwd: sandbox,
    stdio: 'ignore',
    timeout: 600_000
  });

// Prove the sandbox before trusting a single result out of it. Without this the
// tool degrades exactly the way this whole project is about: a suite that is red for
// its own reasons reports every mutant as caught, and the run looks like good news.
try {
  suite();
} catch {
  console.error(
    `The unmutated suite does not pass in ${sandbox}.\n` +
      'Every mutant would report as killed, so the run would be meaningless. Either the\n' +
      'suite is red in the working tree too, or the copy is missing something a test\n' +
      'reads — reproduce with: cd ' + sandbox + ' && npx vitest run'
  );
  process.exit(2);
}

console.error(
  `${sites.length} swallowed try blocks; probing ${chosen.length} in ${sandbox}\n` +
    '(the working tree is not touched — interrupt this whenever you like)'
);

const backup = join(sandbox, 'mutant.bak');
const survivors = [];
for (const [n, site] of chosen.entries()) {
  const target = join(sandbox, site.file);
  const original = readFileSync(target, 'utf8');
  copyFileSync(target, backup);
  writeFileSync(
    target,
    `${original.slice(0, site.insertAt)}\nif (1 as number) throw new Error('MUTANT');${original.slice(site.insertAt)}`
  );
  let noticed = false;
  try {
    // suite() excludes the guard test, which reads the source rather than running
    // it — a mutant makes it red for the wrong reason, and every probe would then
    // report a false "killed".
    suite();
  } catch {
    noticed = true;
  } finally {
    copyFileSync(backup, target);
  }
  if (!noticed) survivors.push(`${site.file}:${site.line}`);
  console.error(
    `[${n + 1}/${chosen.length}] ${noticed ? 'killed  ' : 'SURVIVED'} ${site.file}:${site.line}`
  );
}

const survived = new Set(survivors);
const untriagedSurvivors = chosen.filter((s) => !s.quiet && survived.has(`${s.file}:${s.line}`));
const unwatchedClaims = chosen.filter((s) => s.quiet && survived.has(`${s.file}:${s.line}`));
console.error(
  `\n${survivors.length}/${chosen.length} survived.\n` +
    `  ${untriagedSurvivors.length} untriaged site(s) nothing noticed — findings, triage them.\n` +
    `  ${unwatchedClaims.length} "// quiet:" claim(s) no test would contradict — re-read those notes by hand.`
);
console.log(survivors.join('\n'));

// Exit non-zero only on the unambiguous finding: a site that neither says anything
// nor explains itself, and that nothing in the suite noticed. A surviving `// quiet:`
// site is information, not a failure — the note may well be right, and this tool
// cannot tell which.
process.exit(untriagedSurvivors.length > 0 ? 1 : 0);
