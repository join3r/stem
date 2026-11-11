// Gate canary: score the synthetic pairs in src/server/recall/gate-canary.json
// with the released gate model (Stem GTE Memory), the way the worker scores a
// pair, and compare against the scores recorded where the gate floors were
// measured. See src/server/recall/gate-canary.ts for why.
//
//   npm run eval:gate-canary                 # check this platform; exits 1 on drift
//   node scripts/gate-canary.mjs --write     # record this platform's scores as its reference
//   node scripts/gate-canary.mjs --model <dir>   # use model files already on disk
//   node scripts/gate-canary.mjs --scores <file> --platform linux-x64 [--write]
//                                            # judge or record scores taken elsewhere
//
// The model (342 MB) is downloaded once into .embed-smoke-cache/, at the
// revision and checksums the app pins (gte-model-artifact.ts).
//
// Run --write only on a platform whose gate floors were measured, after a
// benchmark confirmed them: a new reference is a statement that the floors
// hold for these scores.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(ROOT, '.gate-canary-build');
const DATA = join(ROOT, 'src', 'server', 'recall', 'gate-canary.json');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const write = args.includes('--write');
const platform = flag('--platform', `${process.platform}-${process.arch}`);

// The comparison and the model pin are the app's own modules, compiled as they
// are, so this script can never judge by a copy of the rule.
rmSync(BUILD_DIR, { recursive: true, force: true });
const tsc = spawnSync(
  'npx',
  [
    'tsc', 'src/server/recall/gate-canary.ts', 'src/server/recall/gte-model-artifact.ts',
    '--outDir', BUILD_DIR, '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'es2022',
    '--skipLibCheck', '--esModuleInterop', '--resolveJsonModule', '--rootDir', 'src'
  ],
  { cwd: ROOT, stdio: 'inherit' }
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
writeFileSync(join(BUILD_DIR, 'package.json'), '{"type":"commonjs"}');
const require = createRequire(import.meta.url);
const { GATE_CANARY, gateDrift, scoreGateCanary } = require(join(BUILD_DIR, 'server', 'recall', 'gate-canary.js'));
const { GTE_MODEL_ARTIFACT, GTE_MODEL_VERSION } = require(join(BUILD_DIR, 'server', 'recall', 'gte-model-artifact.js'));

if (GATE_CANARY.model !== GTE_MODEL_VERSION) {
  console.error(`The canary's scores are for ${GATE_CANARY.model}, the app ships ${GTE_MODEL_VERSION}. Measure the floors for the new release, then record new references with --write.`);
  process.exit(1);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Fetch the pinned release into `dir`, skipping files already there and whole. */
async function ensureModel(dir) {
  for (const [file, expected] of Object.entries(GTE_MODEL_ARTIFACT.files)) {
    if (file === 'LICENSE' || file === 'NOTICE') continue;
    const path = join(dir, file);
    if (existsSync(path) && statSync(path).size === expected.size && (await sha256(path)) === expected.sha256) continue;
    const url = `https://huggingface.co/${GTE_MODEL_ARTIFACT.repo}/resolve/${GTE_MODEL_ARTIFACT.revision}/${file}`;
    process.stderr.write(`downloading ${file} (${Math.round(expected.size / 1e6)} MB)\n`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
    mkdirSync(dirname(path), { recursive: true });
    // To disk as it arrives, under another name until the checksum agrees: a
    // run that is cut off must not leave a half file where a whole one is expected.
    const partial = `${path}.partial`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
    if ((await sha256(partial)) !== expected.sha256) {
      rmSync(partial, { force: true });
      throw new Error(`${file} does not match the pinned checksum`);
    }
    renameSync(partial, path);
  }
}

/** The worker's GTE path (embed-worker.ts loadRerank + scoreGtePair), one pair per pass. */
async function scoreWithModel(dir) {
  const { AutoTokenizer, PreTrainedModel, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  const tokenizer = await AutoTokenizer.from_pretrained(dir, { local_files_only: true });
  const model = await PreTrainedModel.from_pretrained(dir, {
    dtype: 'q8',
    local_files_only: true,
    session_options: { enableCpuMemArena: false }
  });
  try {
    return await scoreGateCanary(async (query, doc) => {
      const inputs = tokenizer([query], { text_pair: [doc], padding: true, truncation: false });
      const { logits } = await model(inputs);
      if (logits.data.length !== 1 || !Number.isFinite(logits.data[0])) throw new Error('expected one finite logit');
      return Number(logits.data[0]);
    });
  } finally {
    await model.dispose();
  }
}

let scores;
const scoresFile = flag('--scores');
if (scoresFile) {
  scores = JSON.parse(readFileSync(scoresFile, 'utf8'));
} else {
  const dir = resolve(flag('--model', process.env.STEM_GTE_FACT_MODEL_DIR || join(ROOT, '.embed-smoke-cache', GTE_MODEL_VERSION)));
  if (!flag('--model') && !process.env.STEM_GTE_FACT_MODEL_DIR) await ensureModel(dir);
  scores = await scoreWithModel(dir);
}
if (!Array.isArray(scores) || scores.length !== GATE_CANARY.pairs.length || scores.some((s) => !Number.isFinite(s))) {
  console.error(`Expected ${GATE_CANARY.pairs.length} finite scores.`);
  process.exit(1);
}

const sorted = [...scores].sort((a, b) => a - b);
console.log(`${platform}: ${scores.length} pairs, logits ${sorted[0].toFixed(2)} … ${sorted[sorted.length - 1].toFixed(2)}, median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}`);
for (const name of Object.keys(GATE_CANARY.reference)) {
  const d = gateDrift(scores, name, { ...GATE_CANARY, reference: { [name]: GATE_CANARY.reference[name] } });
  if (d) console.log(`  against ${name}: median ${d.median.toFixed(3)}, max ${d.max.toFixed(2)}, moved ${(d.moved * 100).toFixed(0)}%${d.drifted ? '  DRIFT' : ''}`);
}

if (write) {
  const data = JSON.parse(readFileSync(DATA, 'utf8'));
  data.reference[platform] = scores.map((s) => Math.round(s * 1e4) / 1e4);
  const tf = require(join(ROOT, 'node_modules', '@huggingface', 'transformers', 'package.json')).version;
  data.measured[platform] = `transformers.js ${tf}, ${new Date().toISOString().slice(0, 10)}`;
  writeFileSync(DATA, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`recorded the reference for ${platform}`);
  process.exit(0);
}

const drift = gateDrift(scores, platform);
if (!drift) {
  console.log('No reference to compare against. Record one with --write on a platform whose floors were measured.');
  process.exit(0);
}
if (!drift.ownPlatform) console.log(`No reference for ${platform}; held to the nearest one, ${drift.against}.`);
if (drift.drifted) {
  console.error(`The gate model's scores moved against ${drift.against}. The gate floors (gte-fact-pilot.ts) were measured on those scores: benchmark them again before this ships.`);
  process.exit(1);
}
console.log('The gate model scores as it did when its floors were measured.');
