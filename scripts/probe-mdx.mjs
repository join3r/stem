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
process.exit(ok ? 0 : 1);
