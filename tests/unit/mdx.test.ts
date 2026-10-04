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

// GFM task lists feed the interactive checklist rendering: remark-gfm strips
// the `[ ]`/`[x]` marker into listItem.checked, which render.tsx maps to
// <TaskItem> (checkbox) vs a plain <li>.
describe('GFM task lists', () => {
  it('parses [ ] / [x] markers into listItem.checked', () => {
    const tree = proc.parse('- [ ] open\n- [x] done\n- plain');
    const items = findAll(tree, 'listItem');
    expect(items.map((i) => i.checked)).toEqual([false, true, null]);
  });

  it('keeps the marker out of the item text', () => {
    const tree = proc.parse('- [x] buy milk');
    const texts = findAll(tree, 'text');
    expect(texts.map((t) => t.value).join('')).toBe('buy milk');
  });

  it('supports ordered task lists', () => {
    const tree = proc.parse('1. [ ] first\n2. [x] second');
    const items = findAll(tree, 'listItem');
    expect(items.map((i) => i.checked)).toEqual([false, true]);
  });
});

// splitMdBlocks backs StreamingMdxView's incremental streaming parse: blocks
// split on blank lines OUTSIDE fenced code, so stable (already-complete) blocks
// are parsed exactly once while only the trailing block re-parses per delta.
import { splitMdBlocks } from '../../src/renderer/mdx/render';

describe('splitMdBlocks', () => {
  it('splits paragraphs on blank lines', () => {
    expect(splitMdBlocks('one\n\ntwo\n\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('keeps a fenced code block with internal blank lines as one block', () => {
    const text = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\noutro';
    expect(splitMdBlocks(text)).toEqual(['intro', '```ts\nconst a = 1;\n\nconst b = 2;\n```', 'outro']);
  });

  it('supports ~~~ fences and does not close on the other fence char', () => {
    const text = '~~~\na\n\n```\nb\n~~~\n\ntail';
    expect(splitMdBlocks(text)).toEqual(['~~~\na\n\n```\nb\n~~~', 'tail']);
  });

  it('treats an unterminated fence as part of the trailing block (mid-stream)', () => {
    const text = 'para\n\n```py\nprint(1)\n\nprint(2)';
    expect(splitMdBlocks(text)).toEqual(['para', '```py\nprint(1)\n\nprint(2)']);
  });

  it('handles empty and blank-only input', () => {
    expect(splitMdBlocks('')).toEqual([]);
    expect(splitMdBlocks('\n\n\n')).toEqual([]);
  });

  it('is append-stable: earlier blocks never change as text grows', () => {
    const full = '# Title\n\npara one\n\n- a\n- b\n\n```js\ncode()\n```\n\nlast para';
    let prev: string[] = [];
    for (let i = 1; i <= full.length; i++) {
      const blocks = splitMdBlocks(full.slice(0, i));
      // All blocks except the last must be an exact prefix of the final split.
      for (let b = 0; b < blocks.length - 1; b++) {
        if (b < prev.length - 1) expect(blocks[b]).toBe(prev[b]);
      }
      prev = blocks;
    }
    expect(prev).toEqual(splitMdBlocks(full));
  });
});

// Streaming MDX: a component spanning blank lines must stay one block (or the
// half that is parsed alone breaks), and the tail must say which component it
// is still inside so the view shows a placeholder, never half a tag.
import { provisionalTail, splitStreamBlocks } from '../../src/renderer/mdx/render';

describe('splitStreamBlocks', () => {
  const steps = 'Intro line.\n<Steps>\n<Step>**One.** First.</Step>\n\n<Step>**Two.** Second.</Step>\n</Steps>\n\nOutro.';

  it('keeps a component spanning blank lines in one block, split from the prose around it', () => {
    expect(splitMdBlocks(steps)).toEqual([
      'Intro line.',
      '<Steps>\n<Step>**One.** First.</Step>\n\n<Step>**Two.** Second.</Step>\n</Steps>',
      'Outro.'
    ]);
    expect(splitStreamBlocks(steps).every((b) => b.open === null)).toBe(true);
  });

  it('reports the component the tail is still inside, outermost first', () => {
    const blocks = splitStreamBlocks('<Tabs>\n<Tab label="macOS">\n\nbrew install node');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].open).toBe('Tabs');
    expect(blocks[0].stack).toEqual(['Tabs', 'Tab']);
  });

  it('does not count a tag inside a code fence', () => {
    const text = '```mdx\n<Chart type="bar">\n\n```\n\nafter';
    const blocks = splitStreamBlocks(text);
    expect(blocks.map((b) => b.text)).toEqual(['```mdx\n<Chart type="bar">\n\n```', 'after']);
    expect(blocks.every((b) => b.open === null)).toBe(true);
  });

  it('treats a tag still being typed as open, and ignores unknown capitalised words', () => {
    expect(splitStreamBlocks('Here it is:\n\n<Cha').at(-1)!.open).toBe('');
    expect(splitStreamBlocks('Here it is:\n\n<Chart type="li').at(-1)!.open).toBe('Chart');
    expect(splitStreamBlocks('Compare A <B and C').at(-1)!.open).toBeNull();
    expect(splitStreamBlocks('<Marquee>\n\nhi').every((b) => b.open === null)).toBe(true);
  });

  it('keeps self-closing tags and same-line pairs balanced', () => {
    const form = '<Form prompt="x">\n<Field name="a" label="A" />\n\n<Field name="b" label="B" />\n</Form>';
    expect(splitStreamBlocks(form)).toEqual([{ text: form, open: null, stack: [] }]);
  });

  it('is append-stable with components: earlier blocks never change as text grows', () => {
    const full = `${steps}\n\n<Chart type="bar" title="t">\n\`\`\`json\n[{"label":"a","value":1}]\n\`\`\`\n</Chart>\n\nDone.`;
    const final = splitMdBlocks(full);
    for (let i = 1; i <= full.length; i++) {
      const blocks = splitMdBlocks(full.slice(0, i));
      for (let b = 0; b < blocks.length - 1; b++) expect(blocks[b]).toBe(final[b]);
    }
  });
});

describe('provisionalTail', () => {
  it('closes open prose containers so the user can read along', () => {
    const [block] = splitStreamBlocks('<Steps>\n<Step>**One.** Fir');
    expect(provisionalTail(block)).toEqual({ live: '<Steps>\n<Step>**One.** Fir</Step>\n</Steps>', pending: null });
    const [callout] = splitStreamBlocks('<Callout type="warn">\nCareful with');
    expect(provisionalTail(callout).live).toBe('<Callout type="warn">\nCareful with\n\n</Callout>');
  });

  it('holds a data component back behind a placeholder', () => {
    const [block] = splitStreamBlocks('<Chart type="bar">\n```json\n[{"label":"a"');
    expect(provisionalTail(block)).toEqual({ live: '', pending: 'Chart' });
  });

  it('drops a half-typed tag and renders the prose before it', () => {
    const blocks = splitStreamBlocks('Look:\n<Data');
    expect(provisionalTail(blocks.at(-1)!)).toEqual({ live: 'Look:', pending: '' });
  });
});
