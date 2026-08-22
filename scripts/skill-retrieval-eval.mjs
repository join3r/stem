// Scored skill-retrieval eval: ranks a synthetic skill library against a set of
// hand-written queries using REAL inference (transformers.js locally, or any
// OpenAI-compatible endpoint) and reports two independent things:
//
//   1. ORDER  — recall@1/3/5 + MRR, overall and per language pair.
//   2. THE CUT — of the ranked list, what actually gets INLINED, scored against
//      positives (the right skill must load) and negatives (nothing may load).
//
// Exits 1 when any fixture floor is violated.
//
// This is a gate, not a unit test. A unit test with a fake embedder can only assert
// that the ranking code sorts what it is given; whether a Slovak sentence about
// lunch actually lands on `scrape-daily-lunch-menu` rather than
// `book-restaurant-table` is a property of the embedding model and of the
// descriptions the contract asks the model to write, and only real inference
// measures it. It is kept out of CI for the same reason recall-eval.mjs is: it
// downloads model weights on first run (cached in .embed-smoke-cache/, shared with
// scripts/embed-smoke.mjs and scripts/recall-eval.mjs).
//
//   npm run eval:skill-retrieval
//   node scripts/skill-retrieval-eval.mjs --skip-build --model multilingual-e5-base
//   node scripts/skill-retrieval-eval.mjs --endpoint http://localhost:11434 --remote-model qwen3-embedding:4b
//   node scripts/skill-retrieval-eval.mjs --rerank --rerank-cache <dir>
//   node scripts/skill-retrieval-eval.mjs --sweep        # threshold grids for both cut families
//   node scripts/skill-retrieval-eval.mjs --dump out.json  # raw score matrix, for offline analysis
//
// WHY SECTION 2 EXISTS. This eval used to measure the order only, and said so:
// "Nor is the SKILL_MIN_COSINE inline gate applied; this scores the ORDER, not
// what survives the cut." That exemption is what let a production regression ship
// green. The shipped cut was an absolute cosine floor calibrated against an
// e5-family model; once the configured embedder became qwen3-embedding:4b — a
// model whose unrelated-pair cosines sit near 0.38 rather than near 0.75 — the
// floor stopped admitting anything, and skill inlining fired exactly once in five
// days over a library of eight. Recall@1 stayed perfect the whole time, because
// the ordering was never the problem. A gate that cannot fail on the thing that
// broke is not a gate.
//
// Negatives are the other half of that fix. Positives alone reward a cut that
// inlines everything; a fixture without them cannot distinguish "loads the right
// skill" from "loads two skills every turn and one happens to be right".
//
// STILL NOT MEASURED: the usage blend (`blended = cosine + SKILL_USAGE_WEIGHT ·
// (usageRate − 0.5)`). It is a function of the user's own history, so including
// it would make the gate move whenever their habits move — and it cannot rescue
// a skill whose description does not match in the first place: a skill that
// never ranks is never injected, so it can never accumulate the usage that would
// lift it.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_DIR = join(ROOT, '.skills-build');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const skipBuild = args.includes('--skip-build');
const runSweep = args.includes('--sweep');
const useRerank = args.includes('--rerank');
const modelArg = flag('--model', 'multilingual-e5-small');
const endpoint = flag('--endpoint');
const remoteModel = flag('--remote-model');
// The cross-encoder is 570 MB at q8. Point this at the app's own model dir to
// reuse an already-downloaded copy instead of pulling a second one.
const rerankCache = flag('--rerank-cache', join(ROOT, '.embed-smoke-cache'));
const rerankRepo = flag('--rerank-repo', 'onnx-community/bge-reranker-v2-m3-ONNX');
// Write the raw per-(item, skill) score matrix so a cut rule can be designed
// against real numbers instead of intuition. Analysis is deliberately outside
// this script: the eval's job is to measure a rule, not to invent one.
const dumpPath = flag('--dump');

if (endpoint && !remoteModel) {
  console.error('--endpoint requires --remote-model');
  process.exit(1);
}

// ---- 1. compile the modules under test (same mechanism as recall-eval.mjs) ----
// embed-catalog.ts is pure data + string helpers and gate.ts is pure arithmetic;
// both have type-only imports, so they compile in isolation without dragging in
// node:sqlite or the embedder. Lifting the repo/dtype/prefixes from the shipping
// catalog — and the cut from the shipping gate — keeps this measuring the code
// the app actually runs rather than a paraphrase of it.
if (!skipBuild) {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  const tsc = spawnSync(
    'npx',
    [
      'tsc', 'src/server/recall/embed-catalog.ts', 'src/server/recall/rerank-catalog.ts', 'src/server/skills/gate.ts',
      '--outDir', '.skills-build',
      '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'es2022',
      '--skipLibCheck', '--esModuleInterop', '--rootDir', 'src'
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  writeFileSync(join(BUILD_DIR, 'package.json'), '{"type":"commonjs"}');
}

const require = createRequire(import.meta.url);
const catalog = require(join(BUILD_DIR, 'server', 'recall', 'embed-catalog.js'));
const { selectCut, queryHasSignal, DEFAULT_MIN_Z, DEFAULT_MIN_GAP_SIGMA, DEFAULT_SHORTLIST_SIZE, LEGACY_MIN_COSINE } = require(
  join(BUILD_DIR, 'server', 'skills', 'gate.js')
);
// The cross-encoder floor comes from the catalog entry it was measured against,
// never from the gate — that separation is half the fix.
const { RERANK_CATALOG } = require(join(BUILD_DIR, 'server', 'recall', 'rerank-catalog.js'));
const DEFAULT_MIN_RERANK_SCORE = RERANK_CATALOG['bge-reranker-v2-m3'].minRelevantScore;

const { aggregate, checkFloors, formatViolation, scoreRanking } = await import('../tests/eval/score.mjs');

const fixture = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'skill-retrieval-golden.json'), 'utf8'));
const negatives = (fixture.negatives ?? []).filter((n) => n.id);

// ---- 2. real inference ----
// Two backends. Local mirrors the bundled transformers.js path and applies the
// model's training-time prefixes. Remote mirrors createHttpEmbeddingsClient,
// which deliberately does NOT prefix — a remote server runs an arbitrary model
// and blind prefixing would corrupt one that does not expect it. Keeping that
// asymmetry here is the point: it is part of what production does.
let embed;
let dispose = async () => {};
let backendLabel;

if (endpoint) {
  backendLabel = `${remoteModel} @ ${endpoint}`;
  console.log(`using remote embeddings: ${backendLabel}`);
  embed = async (texts) => {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: remoteModel, input: texts })
    });
    if (!res.ok) throw new Error(`embeddings: HTTP ${res.status} ${await res.text()}`);
    const json = await res.json();
    const out = new Array(texts.length);
    json.data.forEach((row, i) => {
      out[typeof row.index === 'number' ? row.index : i] = Float32Array.from(row.embedding);
    });
    return out;
  };
} else {
  const spec = catalog.EMBED_CATALOG[modelArg];
  if (!spec) {
    console.error(`unknown model '${modelArg}' — one of: ${Object.keys(catalog.EMBED_CATALOG).join(', ')}`);
    process.exit(1);
  }
  backendLabel = `${spec.repo} (${spec.dtype})`;
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = join(ROOT, '.embed-smoke-cache');
  console.log(`loading ${spec.repo} (dtype ${spec.dtype})…`);
  const t0 = Date.now();
  const extractor = await pipeline('feature-extraction', spec.repo, { dtype: spec.dtype });
  console.log(`model ready in ${Date.now() - t0} ms`);
  embed = async (texts, kind) => {
    const out = await extractor(catalog.applyPrefixes(spec, kind, texts), { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1];
    return texts.map((_, i) => Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
  };
  dispose = () => extractor.dispose();
}

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

// ---- 3. index the library ----
// The indexed text is `${name}\n${description}` — the same string `skillVectorText`
// builds in src/server/skills/vectors.ts, which is what the shipped ranker actually
// embeds. The name carries signal of its own precisely because the contract forbids
// the description from restating it (`restatesName` in skills/contract.ts), so the
// two are complementary rather than redundant.
const skills = fixture.skills;
const skillText = skills.map((s) => `${s.name}\n${s.description}`);
const skillVecs = await embed(skillText, 'passage');
console.log(`indexed ${skills.length} skills`);

// ---- 3b. optional cross-encoder ----
// Same model, dtype, tokenization and logit extraction as the shipping worker
// (src/server/recall/embed-worker.ts rerank()) — raw logits, no sigmoid, because
// the useful range for skill descriptions sits near −8 where a sigmoid underflows
// to ~3e-4 and destroys the resolution the cut needs.
//
// ONE PAIR PER FORWARD PASS, deliberately, and this is not an optimisation
// oversight. Batched, this model's logits move with the batch's composition —
// the identical (query, doc) pair scores −7.890 alone, −8.090 in a batch of two
// and −8.289 in a batch of six, because padding to the batch's longest sequence
// leaks into the result. Ordering survives that; an absolute threshold does not,
// and a 0.4-logit drift straddles the −8 cut. So the score has to be a stable
// function of the pair alone, which costs N forward passes (~22 ms each) instead
// of one batched pass. That is the price of being allowed to say yes or no.
let rerankPairs = null;
if (useRerank) {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
  env.cacheDir = rerankCache;
  console.log(`loading reranker ${rerankRepo} (q8) from ${rerankCache}…`);
  const t0 = Date.now();
  const tokenizer = await AutoTokenizer.from_pretrained(rerankRepo);
  const model = await AutoModelForSequenceClassification.from_pretrained(rerankRepo, { dtype: 'q8' });
  console.log(`reranker ready in ${Date.now() - t0} ms`);
  rerankPairs = async (query) => {
    const scores = [];
    for (const doc of skillText) {
      const { logits } = await model(tokenizer([query], { text_pair: [doc], truncation: true }));
      scores.push(logits.data[0]);
    }
    return scores;
  };
  const priorDispose = dispose;
  dispose = async () => {
    await priorDispose();
    await model.dispose?.();
  };
}

/** Rank the whole library against one text; returns [{slug, cosine, relevance?}] best first. */
async function rank(text) {
  const [qVec] = await embed([text], 'query');
  const rel = rerankPairs ? await rerankPairs(text) : null;
  return skills
    .map((s, i) => ({
      slug: s.name,
      cosine: cosine(qVec, skillVecs[i]),
      ...(rel ? { rerankScore: rel[i] } : {})
    }))
    .sort((a, b) => b.cosine - a.cosine);
}

// ---- 4. rank (order metrics) ----
const rows = [];
const misses = [];
const positiveRankings = [];
for (const q of fixture.queries) {
  const ranked = await rank(q.text);
  positiveRankings.push({ q, ranked });
  const rankedNames = ranked.map((r) => r.slug);
  const metrics = scoreRanking(rankedNames, [q.expectSlug]);
  rows.push({ tier: 'skills-description', langPair: q.langPair ?? 'en->en', metrics });
  if (metrics['recall@5'] === 0) misses.push({ q, got: ranked.slice(0, 3) });
  const at = rankedNames.indexOf(q.expectSlug);
  console.log(
    `${q.id.padEnd(4)} ${(q.langPair ?? 'en->en').padEnd(7)} rank ${String(at + 1).padStart(2)}  ` +
      `top="${ranked[0].slug}" (${ranked[0].cosine.toFixed(4)})  margin ${(ranked[0].cosine - ranked[1].cosine).toFixed(4)}`
  );
}

const negativeRankings = [];
for (const n of negatives) {
  negativeRankings.push({ n, ranked: await rank(n.text) });
}

if (dumpPath) {
  writeFileSync(
    dumpPath,
    JSON.stringify(
      {
        backend: endpoint ? `${remoteModel}@${endpoint}` : modelArg,
        reranker: useRerank ? rerankRepo : null,
        positives: positiveRankings.map(({ q, ranked }) => ({ ...q, ranked })),
        negatives: negativeRankings.map(({ n, ranked }) => ({ ...n, ranked }))
      },
      null,
      1
    )
  );
  console.log(`\nwrote score matrix → ${dumpPath}`);
}

// ---- 5. report order (same shape as recall-eval.mjs) ----
const agg = aggregate(rows);
const METRICS = ['recall@1', 'recall@3', 'recall@5', 'mrr'];
const fmt = (v) => v.toFixed(3);

console.log('\n== per tier ==');
console.log(['tier'.padEnd(20), 'n'.padStart(3), ...METRICS.map((m) => m.padStart(9))].join(' '));
for (const [tier, a] of Object.entries(agg.byTier)) {
  console.log([tier.padEnd(20), String(a.n).padStart(3), ...METRICS.map((m) => fmt(a[m]).padStart(9))].join(' '));
}

console.log('\n== per (tier, langPair) ==');
for (const [tier, pairs] of Object.entries(agg.byTierLangPair)) {
  for (const [lp, a] of Object.entries(pairs)) {
    console.log(
      [`${tier}/${lp}`.padEnd(28), String(a.n).padStart(3), ...METRICS.map((m) => fmt(a[m]).padStart(9))].join(' ')
    );
  }
}

if (misses.length > 0) {
  console.log('\n== misses (recall@5 = 0) ==');
  for (const { q, got } of misses) {
    console.log(`${q.id.padEnd(4)} "${q.text}" → expected ${q.expectSlug}, got [${got.map((g) => g.slug).join(', ')}]`);
  }
}

// ---- 6. score the cut ----
// Four numbers per strategy, and they trade against each other — a cut is only
// describable by the pair, never by one side:
//   loaded      positives where the EXPECTED skill was inlined.       higher better
//   noise       positives that also inlined a skill nobody asked for. lower better
//   false-load  negatives where ANYTHING was inlined.                 lower better
//   hard-false  false-load restricted to the deliberately adjacent negatives.
function scoreCut(opts) {
  let loaded = 0;
  let noise = 0;
  let falseLoad = 0;
  let hardFalse = 0;
  let hardCount = 0;
  const detail = [];
  // The low-signal gate runs before any strategy in production (inject.ts), so
  // it runs before every strategy here — a near-empty message never reaches the
  // cut, whatever the cut is.
  const gatedCut = (text, ranked) =>
    queryHasSignal(text) ? selectCut(ranked, opts) : { inlined: [], reason: 'low-signal' };
  for (const { q, ranked } of positiveRankings) {
    const cut = gatedCut(q.text, ranked);
    const hit = cut.inlined.includes(q.expectSlug);
    if (hit) loaded++;
    if (cut.inlined.some((s) => s !== q.expectSlug)) noise++;
    detail.push({ id: q.id, kind: 'pos', ok: hit, cut });
  }
  for (const { n, ranked } of negativeRankings) {
    const cut = gatedCut(n.text, ranked);
    const fired = cut.inlined.length > 0;
    if (fired) falseLoad++;
    if (n.hard) {
      hardCount++;
      if (fired) hardFalse++;
    }
    detail.push({ id: n.id, kind: 'neg', ok: !fired, cut });
  }
  const P = positiveRankings.length;
  const N = negativeRankings.length || 1;
  return {
    loaded: loaded / P,
    noise: noise / P,
    falseLoad: falseLoad / N,
    hardFalse: hardCount ? hardFalse / hardCount : 0,
    detail
  };
}

const RERANK_LABEL = `rerank@${DEFAULT_MIN_RERANK_SCORE} shortlist ${DEFAULT_SHORTLIST_SIZE}`;
const RELATIVE_LABEL = `relative z${DEFAULT_MIN_Z} g${DEFAULT_MIN_GAP_SIGMA}`;
const CUT_CONFIGS = [
  ['fixed@0.72 (shipped)', { strategy: 'fixed', minCosine: LEGACY_MIN_COSINE }],
  ['fixed@0.60', { strategy: 'fixed', minCosine: 0.6 }],
  ['fixed@0.50', { strategy: 'fixed', minCosine: 0.5 }],
  [RELATIVE_LABEL, { strategy: 'relative' }],
  [`${RELATIVE_LABEL} k=1`, { strategy: 'relative', maxInlined: 1 }],
  ...(useRerank
    ? [
        [RERANK_LABEL, { strategy: 'rerank', minRerankScore: DEFAULT_MIN_RERANK_SCORE }],
        ['rerank@-8 shortlist 4', { strategy: 'rerank', minRerankScore: -8 }],
        ['rerank@-9 no shortlist', { strategy: 'rerank', minRerankScore: DEFAULT_MIN_RERANK_SCORE, shortlistSize: 99 }]
      ]
    : []),
  ['topk (no gate)', { strategy: 'topk' }]
];

console.log(`\n== the cut ==   backend: ${backendLabel}`);
console.log(`${positiveRankings.length} positives, ${negativeRankings.length} negatives ` +
  `(${negatives.filter((n) => n.hard).length} hard)`);
console.log(
  ['strategy'.padEnd(30), 'loaded'.padStart(8), 'noise'.padStart(8), 'false-load'.padStart(11), 'hard-false'.padStart(11)].join(' ')
);
const cutResults = new Map();
for (const [label, opts] of CUT_CONFIGS) {
  const r = scoreCut(opts);
  cutResults.set(label, r);
  console.log(
    [
      label.padEnd(30),
      fmt(r.loaded).padStart(8),
      fmt(r.noise).padStart(8),
      fmt(r.falseLoad).padStart(11),
      fmt(r.hardFalse).padStart(11)
    ].join(' ')
  );
}

// The strategy the floors judge: the cross-encoder when one is available, the
// cosine-only fallback otherwise.
const PRIMARY_LABEL = useRerank ? RERANK_LABEL : RELATIVE_LABEL;

// Per-query detail for the primary cut — the reason codes are the point. A miss
// reading `no-separation` is a threshold problem; a miss reading `below-floor`
// is a calibration problem; they are fixed differently.
const dflt = cutResults.get(PRIMARY_LABEL);
const wrong = dflt.detail.filter((d) => !d.ok);
if (wrong.length > 0) {
  console.log(`\n== cut errors (${PRIMARY_LABEL}) ==`);
  for (const d of wrong) {
    const s = d.cut.stats;
    const where = s ? `z=${s.topZ.toFixed(2)} gap=[${s.gapSigma.map((g) => g.toFixed(2)).join(', ')}]` : '';
    console.log(
      `  ${d.id.padEnd(4)} ${d.kind}  ${d.cut.reason.padEnd(14)} inlined=[${d.cut.inlined.join(', ')}]  ${where}`
    );
  }
}

// ---- 7. threshold sweep ----
// Prints the operating curve rather than a single verdict, because picking the
// thresholds from the same 32 items they are scored on is fitting, not
// validation — the grid is here so the choice is made with the trade-off visible
// and can be re-run whenever the backend changes.
if (runSweep) {
  console.log('\n== relative-cut sweep (loaded / false-load) ==');
  const ZS = [1.5, 2.0, 2.5, 3.0];
  const GS = [0.8, 1.0, 1.2, 1.5, 2.0];
  console.log(['minZ \\ gapσ'.padEnd(12), ...GS.map((g) => String(g).padStart(14))].join(' '));
  let best = null;
  for (const z of ZS) {
    const cells = [];
    for (const g of GS) {
      const r = scoreCut({ strategy: 'relative', minZ: z, minGapSigma: g });
      cells.push(`${fmt(r.loaded)}/${fmt(r.falseLoad)}`.padStart(14));
      const youden = r.loaded - r.falseLoad;
      if (!best || youden > best.youden) best = { z, g, youden, r };
    }
    console.log([String(z).padEnd(12), ...cells].join(' '));
  }
  console.log(
    `\nbest by (loaded − false-load): minZ=${best.z} minGapSigma=${best.g} → ` +
      `loaded ${fmt(best.r.loaded)}, false-load ${fmt(best.r.falseLoad)}, hard-false ${fmt(best.r.hardFalse)}`
  );
  console.log('NOTE: chosen on the same fixture it is scored on. Treat as a starting point, not a result.');

  if (useRerank) {
    console.log('\n== rerank-cut sweep (shortlist 4) ==');
    console.log(
      ['minRerankScore'.padEnd(16), 'loaded'.padStart(8), 'noise'.padStart(8), 'false-load'.padStart(11), 'hard-false'.padStart(11)].join(' ')
    );
    for (const t of [-6, -7, -8, -9, -10, -10.5, -11]) {
      const r = scoreCut({ strategy: 'rerank', minRerankScore: t });
      console.log(
        [
          String(t).padEnd(16),
          fmt(r.loaded).padStart(8),
          fmt(r.noise).padStart(8),
          fmt(r.falseLoad).padStart(11),
          fmt(r.hardFalse).padStart(11)
        ].join(' ')
      );
    }
  }
}

// ---- 8. floors ----
const violations = checkFloors(agg, fixture.floors);

// Cut floors are checked separately: they are not per-(tier, langPair) means, so
// they do not fit the `aggregate` shape that checkFloors consumes.
// Rendered separately from the ranking floors rather than pushed into the same
// list: `loaded` is a minimum and every error rate is a maximum, and
// formatViolation only knows how to say "below floor".
const cutViolations = [];
const cutFloors = (fixture.cutFloors ?? {})[useRerank ? 'rerank' : 'relative'] ?? null;
if (cutFloors) {
  const r = cutResults.get(PRIMARY_LABEL);
  for (const [metric, bound] of Object.entries(cutFloors)) {
    if (metric.startsWith('_')) continue;
    const isMinimum = metric === 'loaded';
    const actual = r[metric];
    if (isMinimum ? actual < bound : actual > bound) {
      cutViolations.push(
        `cut/${metric} (${PRIMARY_LABEL}): ${fmt(actual)} ${isMinimum ? `< min ${bound}` : `> max ${bound}`}`
      );
    }
  }
}

if (violations.length + cutViolations.length > 0) {
  console.error('\nFLOOR VIOLATIONS:');
  for (const v of violations) console.error(`  ${formatViolation(v, fmt)}`);
  for (const v of cutViolations) console.error(`  ${v}`);
} else {
  console.log('\nALL FLOORS PASS');
}

// Release the ORT session before the process ends. Left to garbage collection it
// aborts on teardown ("mutex lock failed") — the same ORT fragility documented in
// embed-catalog.ts — and a SIGABRT would replace this run's verdict with exit 134,
// making a passing gate look like a crash and a failing one indistinguishable.
// `process.exitCode` rather than `process.exit()`: exiting immediately cuts the
// dispose short and the abort comes back.
await dispose();
process.exitCode = violations.length + cutViolations.length > 0 ? 1 : 0;
