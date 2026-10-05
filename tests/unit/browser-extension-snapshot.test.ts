// The snapshot outline builder (src/browser-extension/snapshot.js), fed a real
// Accessibility.getFullAXTree capture of the live-test fixture form (Chrome
// for Testing 149, recorded by `node scripts/browser-extension-live.mjs
// --record-fixture`) plus a few hand-made trees for the edge cases.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOutline } from '../../src/browser-extension/snapshot.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/browser-extension-axtree.json', import.meta.url), 'utf8'));

function axNode(nodeId: string, role: string, extra: Record<string, unknown> = {}) {
  const { name, parentId, childIds, backend, props, value, ignored } = extra as {
    name?: string;
    parentId?: string;
    childIds?: string[];
    backend?: number;
    props?: Record<string, unknown>;
    value?: string;
    ignored?: boolean;
  };
  return {
    nodeId,
    ignored: !!ignored,
    role: { type: 'role', value: role },
    ...(name !== undefined ? { name: { type: 'computedString', value: name } } : {}),
    ...(value !== undefined ? { value: { type: 'string', value } } : {}),
    properties: Object.entries(props || {}).map(([k, v]) => ({ name: k, value: { type: 'booleanOrUndefined', value: v } })),
    ...(parentId ? { parentId } : {}),
    childIds: childIds || [],
    ...(backend !== undefined ? { backendDOMNodeId: backend } : {})
  };
}

describe('buildOutline on a recorded Chrome tree', () => {
  const out = buildOutline(fixture.nodes, { frames: fixture.frames, pageUrl: fixture.pageUrl });

  it('prints controls with refs, values and states', () => {
    expect(out.text).toContain('- heading "Order form" [level=1] [ref=');
    expect(out.text).toMatch(/- textbox "Name" \[ref=e\d+\]: Ada/);
    expect(out.text).toMatch(/- combobox "Colour" \[ref=e\d+\]: Green/);
    expect(out.text).toMatch(/- radio "Small" \[checked\] \[ref=e\d+\]/);
    expect(out.text).toMatch(/- checkbox "Subscribe" \[ref=e\d+\]/);
    expect(out.text).toMatch(/- button "Greet" \[ref=e\d+\]/);
  });

  it('shows same-origin links as paths', () => {
    expect(out.text).toMatch(/- link "Page two" \[ref=e\d+\] → \/page2/);
    expect(out.text).toMatch(/- link "anchor" \[ref=e\d+\] → #t/);
  });

  it('flattens wrappers, merges text, and drops text that repeats a name', () => {
    expect(out.text).toContain('- paragraph: Fill in the form below and press Greet.');
    // The <label> text sits next to its field: printing both would say it twice.
    expect(out.text).not.toContain('- text: Name');
    expect(out.text).not.toContain('- text: Greet');
    expect(out.text).not.toMatch(/generic|LabelText|InlineTextBox|ListMarker/);
  });

  it('lists native select options without refs (fill picks them by text)', () => {
    expect(out.text).toMatch(/\n {4}- option "Red"\n/);
    expect(out.text).toContain('- option "Green" [selected]');
    expect(out.text).not.toMatch(/- option "Red" \[ref=/);
  });

  it('collapses plain table rows to one line', () => {
    expect(out.text).toContain('- row: Item | Price');
    expect(out.text).toContain('- row: Tea | 3');
  });

  it('splices a same-origin frame in under its iframe', () => {
    expect(out.text).toMatch(/- iframe "Same-origin frame":\n {4}- paragraph: Inside the frame\n {4}- button "Frame button" \[ref=e\d+\]/);
    expect(out.iframes).toEqual({ total: 1, missing: 0 });
  });

  it('marks an iframe whose frame it was not given', () => {
    const bare = buildOutline(fixture.nodes, { pageUrl: fixture.pageUrl });
    expect(bare.text).toContain('- iframe "Same-origin frame" (contents not included)');
    expect(bare.iframes).toEqual({ total: 1, missing: 1 });
  });

  it('maps every ref to the backend node of the line it is printed on', () => {
    const byBackend = new Map<number, { role?: { value: string }; name?: { value: string } }>();
    for (const n of [...fixture.nodes, ...fixture.frames.flatMap((f: { nodes: unknown[] }) => f.nodes)]) byBackend.set(n.backendDOMNodeId, n);
    const refs = [...out.refs.entries()];
    expect(refs.length).toBeGreaterThan(15);
    expect(refs.map(([k]) => k)).toEqual(refs.map((_, i) => `e${i + 1}`));
    for (const [ref, info] of refs) {
      const node = byBackend.get(info.backendNodeId);
      expect(node, ref).toBeTruthy();
      expect(out.text).toContain(`[ref=${ref}]`);
      expect((node!.name?.value || '').replace(/\s+/g, ' ').trim()).toBe(info.name);
    }
    const greet = refs.find(([, i]) => i.name === 'Greet' && i.role === 'button');
    expect(greet).toBeTruthy();
  });

  it('cuts at the budget, says so, and hands out refs only for printed lines', () => {
    const small = buildOutline(fixture.nodes, { frames: fixture.frames, pageUrl: fixture.pageUrl, maxChars: 300 });
    expect(small.truncated).toBe(true);
    expect(small.text.length).toBeLessThanOrEqual(300);
    const printed = [...small.text.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]);
    expect([...small.refs.keys()]).toEqual(printed);
    expect(out.truncated).toBe(false);
  });
});

describe('buildOutline edge cases', () => {
  it('gives a focusable custom control a ref even without a role', () => {
    const nodes = [
      axNode('1', 'RootWebArea', { name: 'App', childIds: ['2'], backend: 1, props: { focusable: true } }),
      axNode('2', 'generic', { parentId: '1', childIds: ['3'], backend: 2, props: { focusable: true } }),
      axNode('3', 'StaticText', { parentId: '2', name: 'Archive', backend: 3 })
    ];
    const out = buildOutline(nodes);
    expect(out.text).toBe('- generic [ref=e1]: Archive');
    expect(out.refs.get('e1')).toEqual({ backendNodeId: 2, role: 'generic', name: '' });
  });

  it('walks through ignored nodes and drops empty unnamed containers', () => {
    const nodes = [
      axNode('1', 'RootWebArea', { childIds: ['2', '5'], backend: 1 }),
      axNode('2', 'none', { parentId: '1', childIds: ['3'], ignored: true }),
      axNode('3', 'button', { parentId: '2', name: 'Save', childIds: ['4'], backend: 3 }),
      axNode('4', 'StaticText', { parentId: '3', name: 'Save', backend: 4 }),
      axNode('5', 'paragraph', { parentId: '1', backend: 5 })
    ];
    expect(buildOutline(nodes).text).toBe('- button "Save" [ref=e1]');
  });

  it('caps a long option list', () => {
    const options = Array.from({ length: 40 }, (_, i) => axNode(`o${i}`, 'option', { parentId: 'p', name: `Country ${i}`, backend: 100 + i }));
    const nodes = [
      axNode('1', 'RootWebArea', { childIds: ['c'], backend: 1 }),
      axNode('c', 'combobox', { parentId: '1', name: 'Country', value: 'Country 0', childIds: ['p'], backend: 2 }),
      axNode('p', 'MenuListPopup', { parentId: 'c', childIds: options.map((o) => o.nodeId), backend: 3 }),
      ...options
    ];
    const text = buildOutline(nodes).text;
    expect(text.match(/- option /g)).toHaveLength(30);
    expect(text).toContain('- … 10 more options');
  });

  it('prints a link with an off-site URL in full and skips javascript: ones', () => {
    const nodes = [
      axNode('1', 'RootWebArea', { childIds: ['a', 'b'], backend: 1 }),
      { ...axNode('a', 'link', { parentId: '1', name: 'Docs', backend: 2 }), properties: [{ name: 'url', value: { type: 'string', value: 'https://docs.example.org/x' } }] },
      { ...axNode('b', 'link', { parentId: '1', name: 'Menu', backend: 3 }), properties: [{ name: 'url', value: { type: 'string', value: 'javascript:void(0)' } }] }
    ];
    const text = buildOutline(nodes, { pageUrl: 'https://example.com/' }).text;
    expect(text).toContain('- link "Docs" [ref=e1] → https://docs.example.org/x');
    expect(text).toContain('- link "Menu" [ref=e2]');
    expect(text).not.toContain('javascript:');
  });
});
