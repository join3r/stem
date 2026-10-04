import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toComponentTree } from '../../src/renderer/mdx/tree';

// The shared MDX corpus: the phone's parser (ios/StemTests) checks the same
// pairs, so a tree that changes here has to change there too.
const dir = join(__dirname, '../fixtures/mdx');
const names = readdirSync(dir)
  .filter((f) => f.endsWith('.mdx'))
  .map((f) => f.replace(/\.mdx$/, ''));

describe('MDX component tree fixtures', () => {
  it('has a tree for every fixture', () => {
    expect(names.length).toBeGreaterThanOrEqual(12);
    for (const n of names) expect(readdirSync(dir)).toContain(`${n}.tree.json`);
  });

  for (const name of names) {
    it(name, () => {
      const mdx = readFileSync(join(dir, `${name}.mdx`), 'utf8');
      const expected = JSON.parse(readFileSync(join(dir, `${name}.tree.json`), 'utf8'));
      expect(toComponentTree(mdx)).toEqual(expected);
    });
  }

  it('reads an invalid reply as one Markdown run', () => {
    expect(toComponentTree('a </Chart> b')).toEqual({ blocks: [{ kind: 'md', text: 'a </Chart> b' }] });
  });
});
