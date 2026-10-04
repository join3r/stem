// Real-inference MDX usage evaluation: does the assistant reach for the rich-output
// components when a reply would benefit from one, and leave them out when it
// wouldn't? This is an explicit release gate rather than a unit test because it
// consumes model tokens on the user's own ChatGPT sign-in.
//
// Each labelled prompt in tests/fixtures/mdx-usage-golden.json runs as one headless
// pi turn (`pi -p`, no tools, no session) under a variant of the system prompt, and
// the reply is parsed with the same remark pipeline the renderer uses. Reported:
//   HIT RATE     positives whose reply used one of the expected components
//   FALSE FIRES  negatives (expect: null) whose reply used any component
//   INVALID      unknown capitalised tags or {…} expressions (render as nothing)
//   BAD DATA     a data child (```json inside Chart/DataTable/…) that won't parse
//
// Variants (STEM_MDX_EVAL_VARIANTS, comma-separated; default: all available):
//   shipped  — the prompt as Stem builds it for an MDX chat today (BASE + mdx-card.md)
//   guide    — only while docs/assistant/output-format.md existed (before 0.6.0): the
//              old pointer prompt with that page inlined
//
// Optional:
//   STEM_MDX_EVAL_MODEL=openai-codex/gpt-6.1-sol
//   STEM_MDX_EVAL_PI_DIR=~/.pi/agent      (a pi home holding a working sign-in)
//   STEM_MDX_EVAL_CASES=chart-bills,plain-hi
//   STEM_MDX_EVAL_CONCURRENCY=4
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [provider, ...modelParts] = (process.env.STEM_MDX_EVAL_MODEL ?? 'openai-codex/gpt-6.1-sol').split('/');
const modelId = modelParts.join('/');
const piDir = process.env.STEM_MDX_EVAL_PI_DIR ?? join(homedir(), '.pi', 'agent');
const concurrency = Math.max(1, Number(process.env.STEM_MDX_EVAL_CONCURRENCY ?? 4));
const piBin = join(ROOT, 'node_modules', '.bin', 'pi');

/** Data-carrying components: their first code child must be valid JSON. */
const JSON_DATA = new Set(['Chart', 'DataTable', 'Stats', 'Compare']);
/** Marker children, counted only through their parent. */
const CHILD_TAGS = new Set(['Step', 'Tab', 'Question', 'Choice', 'Field', 'Reply']);

/**
 * The gate has to grade the prompt that actually ships, so the pieces are lifted
 * straight out of bootstrap.ts rather than kept as a paraphrase that drifts. Reading
 * the source beats importing it: the module pulls in the host shim and paths.
 */
function liftTemplate(source, name) {
  const match = source.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;\\n`));
  if (!match) throw new Error(`${name} not found in bootstrap.ts — update mdx-usage-eval.mjs`);
  if (/\$\{/.test(match[1])) throw new Error(`${name} gained an interpolation — mdx-usage-eval.mjs cannot lift it verbatim`);
  return match[1].replace(/\\`/g, '`');
}

function variants() {
  const bootstrap = readFileSync(join(ROOT, 'src/server/workspace/bootstrap.ts'), 'utf8');
  const base = liftTemplate(bootstrap, 'BASE_INSTRUCTIONS');
  const out = {};
  const cardPath = join(ROOT, 'src/server/workspace/mdx-card.md');
  if (existsSync(cardPath)) {
    out.shipped = `${base}\n${readFileSync(cardPath, 'utf8')}`;
  } else {
    out.shipped = `${base}\n${liftTemplate(bootstrap, 'OUTPUT_FORMAT_INSTRUCTIONS')}`;
  }
  const guidePath = join(ROOT, 'docs/assistant/output-format.md');
  if (existsSync(guidePath) && /OUTPUT_FORMAT_INSTRUCTIONS = /.test(bootstrap)) {
    out.guide = `${base}\n${liftTemplate(bootstrap, 'OUTPUT_FORMAT_INSTRUCTIONS')}\n${readFileSync(guidePath, 'utf8')}`;
  }
  return out;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

/** Components used in a reply, plus anything that would render as nothing. */
function analyze(text) {
  let tree;
  try {
    tree = parser.parse(text);
  } catch (err) {
    return { components: [], invalid: [`parse error: ${String(err.message ?? err).slice(0, 80)}`], badData: [] };
  }
  const known = new Set(KNOWN);
  const components = [];
  const invalid = [];
  const badData = [];
  const visit = (node) => {
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      const name = node.name ?? '';
      if (!known.has(name)) invalid.push(`<${name}>`);
      else if (!CHILD_TAGS.has(name)) components.push(name);
      if (JSON_DATA.has(name)) {
        const code = (node.children ?? []).find((c) => c.type === 'code');
        try {
          JSON.parse(code?.value ?? '');
        } catch {
          badData.push(name);
        }
      }
    } else if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression' || node.type === 'mdxjsEsm') {
      invalid.push(node.type);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return { components, invalid, badData };
}

/**
 * Every tag the renderer instantiates, read from componentMap so a new component
 * isn't scored as invalid the moment it ships.
 */
const KNOWN = (() => {
  const source = readFileSync(join(ROOT, 'src/renderer/mdx/components.tsx'), 'utf8');
  const block = source.match(/export const componentMap[^=]*= \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('componentMap not found in components.tsx — update mdx-usage-eval.mjs');
  return [...block[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
})();

function runPi(systemPrompt, prompt) {
  return new Promise((resolve) => {
    const child = spawn(
      piBin,
      [
        '-p', '--no-session', '--no-tools', '--no-skills', '--no-extensions', '--no-prompt-templates',
        '--provider', provider, '--model', modelId,
        '--append-system-prompt', systemPrompt,
        prompt
      ],
      { env: { ...process.env, PI_CODING_AGENT_DIR: piDir }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { text: out.trim() } : { error: (err || out).trim().slice(-300) || `exit ${code}` });
    });
  });
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    })
  );
  return results;
}

const fixture = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/mdx-usage-golden.json'), 'utf8'));
const only = process.env.STEM_MDX_EVAL_CASES?.split(',').map((s) => s.trim()).filter(Boolean);
const cases = only ? fixture.cases.filter((c) => only.includes(c.id)) : fixture.cases;
const all = variants();
const wanted = process.env.STEM_MDX_EVAL_VARIANTS?.split(',').map((s) => s.trim()).filter(Boolean);
const chosen = Object.entries(all).filter(([name]) => !wanted || wanted.includes(name));
if (!chosen.length) {
  console.error(`No variants to run. Available: ${Object.keys(all).join(', ')}`);
  process.exit(2);
}

const outDir = join(tmpdir(), 'stem-mdx-eval', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });
console.log(`model ${provider}/${modelId} · ${cases.length} cases · known tags: ${KNOWN.join(' ')}`);

let failed = false;
for (const [variant, systemPrompt] of chosen) {
  console.log(`\n== ${variant} (system prompt ${systemPrompt.length} chars) ==`);
  const rows = await pool(cases, async (c) => {
    const res = await runPi(systemPrompt, c.prompt);
    if (res.error) return { ...c, error: res.error };
    return { ...c, text: res.text, ...analyze(res.text) };
  });
  let pos = 0, hits = 0, neg = 0, fires = 0, invalid = 0, badData = 0, errors = 0, replies = 0;
  const usage = {};
  for (const r of rows) {
    if (r.error) {
      errors += 1;
      console.log(`  ERROR ${r.id}: ${r.error}`);
      continue;
    }
    for (const name of r.components) usage[name] = (usage[name] ?? 0) + 1;
    if (r.components.includes('Replies')) replies += 1;
    invalid += r.invalid.length;
    badData += r.badData.length;
    const used = [...new Set(r.components)];
    let verdict;
    if (r.expect) {
      pos += 1;
      const hit = r.expect.some((name) => used.includes(name));
      if (hit) hits += 1;
      verdict = hit ? 'hit ' : 'MISS';
    } else {
      neg += 1;
      // Reply chips under a plain answer are an invitation, not a reformatting.
      const fired = used.filter((n) => n !== 'Replies');
      if (fired.length) fires += 1;
      verdict = fired.length ? 'FIRE' : 'ok  ';
    }
    const extra = [
      r.invalid.length ? `invalid ${r.invalid.join(' ')}` : '',
      r.badData.length ? `bad data ${r.badData.join(' ')}` : ''
    ].filter(Boolean).join(' · ');
    console.log(`  ${verdict} ${r.id.padEnd(22)} want ${(r.expect ?? ['none']).join('|').padEnd(24)} got ${used.join(' ') || '-'}${extra ? `  [${extra}]` : ''}`);
  }
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
  console.log(`  hit rate ${hits}/${pos} (${pct(hits, pos)}) · false fires ${fires}/${neg} · invalid ${invalid} · bad data ${badData} · replies ${replies} · errors ${errors}`);
  console.log(`  usage ${Object.entries(usage).map(([k, v]) => `${k}:${v}`).join(' ') || '-'}`);
  writeFileSync(join(outDir, `${variant}.json`), JSON.stringify({ variant, model: `${provider}/${modelId}`, systemPrompt, rows }, null, 2));
  if (errors) failed = true;
}
console.log(`\nreplies saved to ${outDir}`);
process.exit(failed ? 1 : 0);
