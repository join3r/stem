// MDX parse-level security + component-coverage suite — ported from
// scripts/probe-mdx.mjs. Asserts that the parser (which feeds
// src/renderer/mdx/render.tsx) categorizes dangerous constructs into the inert
// node types the renderer drops, and that interactive components surface as
// dispatchable JSX with extractable data children. Pure parsing — no DOM.
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';

const proc = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

function types(text: string): Set<string> {
  const tree = proc.parse(text);
  const found = new Set<string>();
  (function walk(n: any) {
    found.add(n.type);
    if (n.name) found.add(`name:${n.name}`);
    (n.children ?? []).forEach(walk);
  })(tree);
  return found;
}

function findAll(n: any, type: string, out: any[] = []): any[] {
  if (n.type === type) out.push(n);
  (n.children ?? []).forEach((c: any) => findAll(c, type, out));
  return out;
}

function jsxNamed(text: string, name: string): any {
  const tree = proc.parse(text);
  return [...findAll(tree, 'mdxJsxFlowElement'), ...findAll(tree, 'mdxJsxTextElement')].find((n) => n.name === name);
}

const INERT = new Set(['mdxFlowExpression', 'mdxTextExpression', 'mdxjsEsm']);

describe('MDX security gate', () => {
  it.each([
    ['JS expression', 'Hello {alert(1)} world'],
    ['flow expression', '{globalThis.fetch("http://evil")}']
  ])('isolates %s as an inert expression node', (_label, text) => {
    expect([...types(text)].some((t) => INERT.has(t))).toBe(true);
  });

  it('parses <script> as a non-allow-listed JSX element (dropped)', () => {
    const t = types('<script>alert(1)</script>');
    expect(t.has('mdxJsxFlowElement') || t.has('mdxJsxTextElement')).toBe(true);
    expect(t.has('name:script')).toBe(true);
  });

  it.each([
    ['import', 'import x from "y"\n\ntext'],
    ['export', 'export const x = 1\n\ntext']
  ])('strips %s as mdxjsEsm', (_label, text) => {
    expect(types(text).has('mdxjsEsm')).toBe(true);
  });

  it.each([
    ['Callout', '<Callout type="info">Note</Callout>'],
    ['Steps', '<Steps><Step>One</Step></Steps>']
  ])('keeps allow-listed <%s> as a JSX element', (_label, text) => {
    const t = types(text);
    expect(t.has('mdxJsxFlowElement') || t.has('mdxJsxTextElement')).toBe(true);
  });
});

describe('MDX interactive components', () => {
  it.each(['Tabs', 'Tab', 'Chart', 'DataTable', 'Quiz', 'Question', 'Choice', 'Form', 'Field'])(
    '<%s> parses as a dispatchable JSX element',
    (name) => {
      expect(jsxNamed(`<${name}>x</${name}>`, name)).toBeTruthy();
    }
  );

  it('extracts a valid json data child from <Chart>', () => {
    const chart = jsxNamed('<Chart type="line" title="T">\n```json\n[{"label":"Jan","value":3}]\n```\n</Chart>', 'Chart');
    const code = (chart?.children ?? []).find((c: any) => c.type === 'code');
    expect(code?.lang).toBe('json');
    expect(JSON.parse(code.value).length).toBe(1);
  });

  it('still yields a code child for malformed data so the component shows its fallback', () => {
    const badTable = jsxNamed('<DataTable>\n```json\n{ not json\n```\n</DataTable>', 'DataTable');
    const code = (badTable?.children ?? []).find((c: any) => c.type === 'code');
    expect(code).toBeTruthy();
    expect(() => JSON.parse(code.value)).toThrow();
  });

  it('keeps an unknown <Marquee> as a JSX element (dropped at render)', () => {
    expect(jsxNamed('<Marquee>hi</Marquee>', 'Marquee')).toBeTruthy();
  });
});
