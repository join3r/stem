// Verify the MDX parser categorizes dangerous constructs into node types that
// the renderer (src/renderer/mdx/render.tsx) maps to inert output.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';

const proc = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

function types(text) {
  const tree = proc.parse(text);
  const found = new Set();
  (function walk(n) {
    found.add(n.type);
    if (n.name) found.add(`name:${n.name}`);
    (n.children ?? []).forEach(walk);
  })(tree);
  return found;
}

const cases = {
  'JS expression': 'Hello {alert(1)} world',
  'flow expression': '{globalThis.fetch("http://evil")}',
  'script tag': '<script>alert(1)</script>',
  'import': 'import x from "y"\n\ntext',
  'export': 'export const x = 1\n\ntext',
  'allowed Callout': '<Callout type="info">Note</Callout>',
  'allowed Steps': '<Steps><Step>One</Step></Steps>'
};

const INERT = new Set(['mdxFlowExpression', 'mdxTextExpression', 'mdxjsEsm']);
let ok = true;
for (const [label, text] of Object.entries(cases)) {
  const t = types(text);
  const list = [...t].filter((x) => !x.startsWith('name:'));
  console.log(`\n${label}: ${list.join(', ')}`);
  if (label.startsWith('JS') || label.includes('expression')) {
    const inert = [...t].some((x) => INERT.has(x));
    console.log('  -> JS expression isolated as inert node?', inert);
    ok = ok && inert;
  }
  if (label === 'script tag') {
    const isJsx = t.has('mdxJsxFlowElement') || t.has('mdxJsxTextElement');
    const named = t.has('name:script');
    console.log('  -> <script> is a JSX element named "script" (dropped, not allow-listed)?', isJsx && named);
    ok = ok && isJsx && named;
  }
  if (label === 'import' || label === 'export') {
    console.log('  -> becomes mdxjsEsm (stripped)?', t.has('mdxjsEsm'));
    ok = ok && t.has('mdxjsEsm');
  }
  if (label.startsWith('allowed')) {
    const isJsx = t.has('mdxJsxFlowElement') || t.has('mdxJsxTextElement');
    console.log('  -> recognized as JSX component (allow-listed -> rendered)?', isJsx);
    ok = ok && isJsx;
  }
}
console.log('\n=== SECURITY GATE', ok ? 'PASS' : 'FAIL', '===');

// ---- Interactive-component coverage --------------------------------------
// These parse-level checks mirror what src/renderer/mdx/render.tsx relies on:
// the new tags must surface as JSX flow elements (so componentMap can dispatch
// them), and data-heavy tags must expose a fenced `code` child the renderer
// extracts and hands to the component as a `data` arg (JSON.parse, never eval).

function findAll(n, type, out = []) {
  if (n.type === type) out.push(n);
  (n.children ?? []).forEach((c) => findAll(c, type, out));
  return out;
}
function jsxNamed(text, name) {
  const tree = proc.parse(text);
  // render.tsx handles both flow (block) and text (inline) JSX elements.
  return [...findAll(tree, 'mdxJsxFlowElement'), ...findAll(tree, 'mdxJsxTextElement')].find(
    (n) => n.name === name
  );
}

let ck = true;
const expect = (label, cond) => {
  console.log(`  ${cond ? 'ok ' : 'XX '} ${label}`);
  ck = ck && cond;
};

console.log('\nInteractive components:');

// New tags parse as dispatchable JSX flow elements.
for (const name of ['Tabs', 'Tab', 'Chart', 'DataTable', 'Quiz', 'Question', 'Choice', 'Form', 'Field']) {
  expect(`<${name}> parses as a JSX element`, !!jsxNamed(`<${name}>x</${name}>`, name));
}

// Data-child extraction: a ```json block inside <Chart>/<DataTable> becomes a
// `code` child with lang "json" holding valid JSON.
const chart = jsxNamed(
  '<Chart type="line" title="T">\n```json\n[{"label":"Jan","value":3}]\n```\n</Chart>',
  'Chart'
);
const chartCode = (chart?.children ?? []).find((c) => c.type === 'code');
expect('Chart exposes a json code child', chartCode?.lang === 'json');
expect('Chart data is valid JSON', (() => { try { return JSON.parse(chartCode.value).length === 1; } catch { return false; } })());

// Malformed data still parses to a code child (component degrades gracefully).
const badTable = jsxNamed('<DataTable>\n```json\n{ not json\n```\n</DataTable>', 'DataTable');
const badCode = (badTable?.children ?? []).find((c) => c.type === 'code');
expect('DataTable with bad JSON still yields a code child (component shows fallback)', !!badCode);
expect('bad JSON does NOT parse (so component renders the error path)', (() => { try { JSON.parse(badCode.value); return false; } catch { return true; } })());

// Unknown tag is still dropped (not in the allow-list).
expect('unknown <Marquee> is a JSX element (dropped at render, children kept)', !!jsxNamed('<Marquee>hi</Marquee>', 'Marquee'));

console.log('\n=== COMPONENT COVERAGE', ck ? 'PASS' : 'FAIL', '===');

process.exit(ok && ck ? 0 : 1);
