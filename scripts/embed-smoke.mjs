// Real-inference smoke test for the local embedding backend (not part of CI —
// downloads model weights on first run). Verifies the exact configuration the
// app uses (repo, dtype, pooling, prefixes) produces sane multilingual vectors:
// correct dimension, unit norm, and — the point of the feature — a Slovak query
// landing closer to its English paraphrase than to a distractor.
//
//   node scripts/embed-smoke.mjs [model-id]     # default: multilingual-e5-small
//
// Weights cache in .embed-smoke-cache/ (gitignored-style throwaway; delete freely).
import { pipeline, env } from '@huggingface/transformers';

const CATALOG = {
  'multilingual-e5-small': {
    repo: 'Xenova/multilingual-e5-small',
    dim: 384,
    dtype: 'q8',
    prefixes: { query: 'query: ', passage: 'passage: ' }
  }
};

const id = process.argv[2] ?? 'multilingual-e5-small';
const spec = CATALOG[id];
if (!spec) {
  console.error(`unknown model '${id}' — one of: ${Object.keys(CATALOG).join(', ')}`);
  process.exit(1);
}

env.cacheDir = new URL('../.embed-smoke-cache/', import.meta.url).pathname;

console.log(`loading ${spec.repo} (dtype ${spec.dtype})…`);
const started = Date.now();
const extractor = await pipeline('feature-extraction', spec.repo, { dtype: spec.dtype });
console.log(`loaded in ${Date.now() - started} ms`);

const embed = async (texts, kind) => {
  const out = await extractor(texts.map((t) => spec.prefixes[kind] + t), { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  return texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
};
const cos = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

const t0 = Date.now();
const [query] = await embed(['Kde bývam a aké mám zvieratá?'], 'query'); // Slovak: where do I live & what pets do I have
const [match, distractor] = await embed(
  ['The user lives in Bratislava and has a dog named Rex.', 'The user prefers dark mode in code editors.'],
  'passage'
);
console.log(`embedded 3 texts in ${Date.now() - t0} ms`);

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (query.length !== spec.dim) fail(`dim ${query.length}, expected ${spec.dim}`);
const norm = Math.sqrt(cos(query, query));
if (Math.abs(norm - 1) > 1e-3) fail(`query vector not unit-norm (${norm})`);
const simMatch = cos(query, match);
const simDistractor = cos(query, distractor);
console.log(`cos(sk query, en match)      = ${simMatch.toFixed(4)}`);
console.log(`cos(sk query, en distractor) = ${simDistractor.toFixed(4)}`);
if (simMatch <= simDistractor) fail('cross-lingual match did not beat the distractor');

console.log(`OK: ${id} — ${spec.dim}-dim, unit-norm, Slovak→English retrieval works`);
