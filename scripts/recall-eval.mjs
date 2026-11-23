// Scored retrieval eval: runs the golden fixture (tests/fixtures/recall-golden.json)
// through the REAL compiled recall modules with REAL local-model inference
// (transformers.js, same catalog spec as the app), and prints recall@1/3/5 + MRR
// per tier and per language-pair, plus the duplicate-pair cosine distribution that
// calibrates the Phase C write-time dedup threshold. Exits 1 when any fixture
// floor is violated. NOT part of CI — downloads model weights on first run
// (cached in .embed-smoke-cache/, shared with scripts/embed-smoke.mjs).
//
//   npm run eval:retrieval                # builds .recall-build, then runs
//   node scripts/recall-eval.mjs --skip-build --model multilingual-e5-base
//
// Needs node:sqlite (Node ≥ 23.4). On older node, run the same file as
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/recall-eval.mjs
//
// Tiers: fts (today's lexical path) always runs; semantic + hybrid need the
// Phase B modules (embed-episodic.ts, searchMemoryHybrid) in the build, and the
// summaries tiers need the v3 store functions. A tier that does not run is
// reported and skipped here — and then FAILS at the floors, because every tier
// the fixture floors is a tier that must run. A tier quietly dropping out is the
// regression the floors exist to catch (see checkFloors in tests/eval/score.mjs).
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_DIR = join(ROOT, '.recall-build');
const BUILD = join(BUILD_DIR, 'server', 'recall');

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const modelArg = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'multilingual-e5-small';

try {
  await import('node:sqlite');
} catch {
  console.error('node:sqlite unavailable — use Node ≥ 23.4 or run under electron-as-node (see header).');
  process.exit(1);
}

// ---- 1. compile the recall modules to CJS (same mechanism as recall-verify.mjs) ----
if (!skipBuild) {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  const files = [
    'store.ts', 'search.ts', 'search-core.ts', 'inject.ts', 'embeddings.ts', 'rerank.ts', 'retrieval.ts',
    'vector.ts', 'capture.ts', 'distill.ts', 'consolidate.ts', 'embed-catalog.ts', 'embed-episodic.ts',
    // Not used by the eval itself, but keeps the compiled MCP server available
    // to scripts/recall-mcp-probe.mjs, which spawns it from .recall-build.
    'mcp-server-main.ts'
  ].map((f) => `src/server/recall/${f}`);
  console.log('compiling recall modules → .recall-build/ …');
  const tsc = spawnSync(
    'npx',
    [
      'tsc', ...files,
      '--outDir', '.recall-build',
      '--module', 'commonjs', '--moduleResolution', 'node', '--ignoreConfig', '--ignoreDeprecations', '6.0', '--target', 'es2022',
      // noCheck: the graph type-includes the worker-host files, whose
      // import.meta is a TS1343 under commonjs. They are import-type-only, so
      // the emitted JS the eval loads never touches them.
      '--skipLibCheck', '--esModuleInterop', '--rootDir', 'src', '--noCheck'
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  writeFileSync(join(BUILD_DIR, 'package.json'), '{"type":"commonjs"}');
}

// ---- 2. throwaway DB — env must be set BEFORE the store module is required ----
const dbPath = join(BUILD_DIR, 'eval.sqlite');
process.env.STEM_RECALL_DB = dbPath;
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true });

const require = createRequire(import.meta.url);
// The store module exports the RecallStore instance as `recallStore`
// (module-global functions went away in the class refactor).
const storeModule = require(join(BUILD, 'store.js'));
const store = storeModule.recallStore;
const search = require(join(BUILD, 'search.js'));
const inject = require(join(BUILD, 'inject.js'));
const retrieval = require(join(BUILD, 'retrieval.js'));
const catalog = require(join(BUILD, 'embed-catalog.js'));
let embedEpisodic = null;
try {
  embedEpisodic = require(join(BUILD, 'embed-episodic.js')); // Phase B module
} catch {
  // Not built yet — semantic/hybrid tiers are skipped below.
}

const { aggregate, checkFloors, formatViolation, loadFixture, scoreRanking } = await import('../tests/eval/score.mjs');
const { seedCorpus } = await import('../tests/eval/seed.mjs');

const fixture = loadFixture(
  JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'recall-golden.json'), 'utf8'))
);
const lookup = seedCorpus(store, fixture);
console.log(`seeded ${fixture.corpus.messages.length} messages, ${fixture.corpus.facts.length} facts`);

// ---- 3. real inference via transformers.js, wrapped as an EmbeddingsClient ----
const spec = catalog.EMBED_CATALOG[modelArg];
if (!spec) {
  console.error(`unknown model '${modelArg}' — one of: ${Object.keys(catalog.EMBED_CATALOG).join(', ')}`);
  process.exit(1);
}
const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = join(ROOT, '.embed-smoke-cache');
console.log(`loading ${spec.repo} (dtype ${spec.dtype})…`);
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', spec.repo, { dtype: spec.dtype });
console.log(`model ready in ${Date.now() - t0} ms`);

async function embed(texts, kind = 'passage') {
  const out = await extractor(catalog.applyPrefixes(spec, kind, texts), { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  return texts.map((_, i) => Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
}
const client = {
  available: async () => true,
  modelId: async () => catalog.localModelCacheKey(spec),
  embed
};
retrieval.setRetrievalClients({ embeddings: client, rerank: null });

function cosine(a, b) {
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  const m = Math.sqrt(ma) * Math.sqrt(mb);
  return m === 0 ? 0 : dot / m;
}

// ---- 4. run tiers ----
const episodicQueries = fixture.queries.filter((q) => q.target === 'episodic');
const factQueries = fixture.queries.filter((q) => q.target === 'facts');
const rows = [];
const misses = [];

function record(tier, q, rankedIds) {
  const metrics = scoreRanking(rankedIds, q.expected);
  rows.push({ tier, langPair: q.langPair, metrics });
  if (metrics['recall@5'] === 0) misses.push({ tier, q, got: rankedIds.slice(0, 3) });
}

// fts — today's lexical episodic path.
for (const q of episodicQueries) {
  const ranked = search.searchMemory(q.text, { limit: 5 }).map((h) => lookup.messageFixtureId(h) ?? `?${h.id}`);
  record('fts', q, ranked);
}

// semantic + hybrid — Phase B tiers, skipped until the modules exist.
const phaseB =
  embedEpisodic &&
  typeof embedEpisodic.embedNewMessages === 'function' &&
  typeof search.searchMemoryHybrid === 'function' &&
  typeof store.semanticSearchMessages === 'function';
if (phaseB) {
  const embedded = await embedEpisodic.embedNewMessages(client);
  console.log(`embedded ${embedded} corpus messages for the semantic tier`);
  const model = await client.modelId();
  for (const q of episodicQueries) {
    const [qVec] = await embed([q.text], 'query');
    const sem = store
      .semanticSearchMessages(qVec, model, { limit: 5, minCosine: store.getSemanticMinCosine?.() ?? 0.82 })
      .map((h) => lookup.messageFixtureId(h) ?? `?${h.id}`);
    record('semantic', q, sem);
    const hyb = await search.searchMemoryHybrid(q.text, {
      limit: 5,
      getQueryEmbedding: async () => ({ vec: qVec, model })
    });
    record('hybrid', q, hyb.map((h) => lookup.messageFixtureId(h) ?? `?${h.id}`));
  }
} else {
  console.log('semantic/hybrid tiers skipped (Phase B modules not present in the build)');
}

// facts — the embedding-ranked fact tier (previewFacts). (The v1 inject-all
// threshold is gone; v2+ always relevance-ranks, so no knob needs forcing.)
for (const q of factQueries) {
  const r = await inject.previewFacts(q.text);
  const ranked = r.facts.map((f) => lookup.factFixtureId(f.text) ?? `?${f.id}`);
  record(`facts-${r.tier}`, q, ranked);
}

// summaries — Recall v3 tier: fixture-authored English thread summaries searched
// hybrid (FTS + cosine over summary_vectors, RRF-fused). This is the tier that
// carries the sk->en gate: English-canonical summaries remove the passage-side
// language penalty that capped raw-message hybrid at ~0.50 recall@5.
const summaryQueries = fixture.queries.filter((q) => q.target === 'summaries');
if (summaryQueries.length > 0 && typeof store.upsertSummaryVector === 'function') {
  const core = require(join(BUILD, 'search-core.js'));
  const model = await client.modelId();
  const missingSummaries = store.getSummariesMissingVector(model);
  for (const s of missingSummaries) {
    const [vec] = await embed([s.text], 'passage');
    store.upsertSummaryVector(s.id, model, vec);
  }
  console.log(`embedded ${missingSummaries.length} corpus summaries for the summaries tier`);
  const db = store.dbHandle();
  for (const q of summaryQueries) {
    const fts = core.ftsSearchSummaries(db, q.text, { limit: 5 })
      .map((h) => lookup.summaryFixtureId(h) ?? `?${h.id}`);
    record('summaries-fts', q, fts);
    const [qVec] = await embed([q.text], 'query');
    const hyb = await core.hybridSearchSummaries(db, q.text, {
      limit: 5,
      embedQuery: async () => ({ vec: qVec, model })
    });
    record('summaries-hybrid', q, hyb.map((h) => lookup.summaryFixtureId(h) ?? `?${h.id}`));
  }
} else if (summaryQueries.length > 0) {
  console.log('summaries tier skipped (v3 store functions not present in the build)');
}

// ---- 5. report ----
const agg = aggregate(rows);
const METRICS = ['recall@1', 'recall@3', 'recall@5', 'mrr'];
const fmt = (v) => v.toFixed(3);

console.log('\n== per tier ==');
console.log(['tier'.padEnd(18), 'n'.padStart(3), ...METRICS.map((m) => m.padStart(9))].join(' '));
for (const [tier, a] of Object.entries(agg.byTier)) {
  console.log([tier.padEnd(18), String(a.n).padStart(3), ...METRICS.map((m) => fmt(a[m]).padStart(9))].join(' '));
}

console.log('\n== per (tier, langPair) ==');
for (const [tier, pairs] of Object.entries(agg.byTierLangPair)) {
  for (const [lp, a] of Object.entries(pairs)) {
    console.log(
      [`${tier}/${lp}`.padEnd(24), String(a.n).padStart(3), ...METRICS.map((m) => fmt(a[m]).padStart(9))].join(' ')
    );
  }
}

if (misses.length > 0) {
  console.log('\n== misses (recall@5 = 0) ==');
  for (const { tier, q, got } of misses) {
    console.log(`${tier.padEnd(12)} ${q.id.padEnd(4)} "${q.text}" → expected ${q.expected.join('|')}, got [${got.join(', ')}]`);
  }
}

// ---- 6. duplicate-pair cosine distribution (Phase C threshold calibration) ----
console.log('\n== duplicate-pair cosine distribution (passage↔passage) ==');
const pairSims = [];
for (const p of fixture.duplicatePairs) {
  const [va, vb] = await embed([p.a, p.b], 'passage');
  pairSims.push({ ...p, sim: cosine(va, vb) });
}
for (const p of [...pairSims].sort((x, y) => y.sim - x.sim)) {
  console.log(`${p.duplicate ? 'DUP     ' : 'DISTINCT'} ${p.sim.toFixed(4)}  ${p.a.slice(0, 44).padEnd(46)} | ${p.b.slice(0, 44)}`);
}
// The write-time threshold targets the SAME-LANGUAGE gap only: cross-language
// duplicates score in the same band as same-language distinct-but-related pairs
// (e5 squash), so catching them would over-trigger — they're flagged
// crossLanguage in the fixture and left to the regular consolidation pass.
const sameLang = pairSims.filter((p) => !p.crossLanguage);
const minDup = Math.min(...sameLang.filter((p) => p.duplicate).map((p) => p.sim));
const maxDistinct = Math.max(...sameLang.filter((p) => !p.duplicate).map((p) => p.sim));
const crossDup = pairSims.filter((p) => p.crossLanguage && p.duplicate).map((p) => p.sim);
const threshold = store.getDupCosine?.() ?? 0.94;
console.log(`\nsame-language min duplicate sim = ${minDup.toFixed(4)}`);
console.log(`same-language max distinct sim  = ${maxDistinct.toFixed(4)}`);
console.log(`same-language gap               = ${(minDup - maxDistinct).toFixed(4)} ${minDup > maxDistinct ? '(clean separation)' : '(OVERLAP — no clean threshold)'}`);
if (crossDup.length > 0) {
  console.log(`cross-language duplicate sims   = ${crossDup.map((s) => s.toFixed(4)).join(', ')} (below threshold BY DESIGN — consolidation handles these)`);
}
console.log(`configured threshold            = ${threshold.toFixed(2)} ${threshold > maxDistinct && threshold <= minDup ? '→ sits inside the gap ✓' : '→ OUTSIDE the same-language gap — recalibrate'}`);

// ---- 7. floors ----
const violations = checkFloors(agg, fixture.floors);
if (violations.length > 0) {
  console.error('\nFLOOR VIOLATIONS:');
  for (const v of violations) {
    console.error(`  ${formatViolation(v, fmt)}`);
  }
} else {
  console.log('\nALL FLOORS PASS');
}
storeModule.closeForTest();
// Release the ORT session before the process ends. Left to garbage collection it
// aborts on teardown ("mutex lock failed") — the same ORT fragility documented in
// embed-catalog.ts — and the SIGABRT replaced the old `process.exit(1)` verdict
// with exit 134, making a failed floor indistinguishable from a crash. That path
// used to be near-unreachable; now that an absent tier fails, it is the normal
// way this script reports. `process.exitCode` rather than `process.exit()`:
// exiting immediately cuts the dispose short and the abort comes back.
await extractor.dispose();
process.exitCode = violations.length > 0 ? 1 : 0;
