import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mdxToMarkdown } from '../../src/renderer/mdx/copy';
import { replyHtml } from '../../src/renderer/mdx/copyReply';

// "Copy message" on a reply. The phone's port (ios/StemTests/MdxCopyTests)
// checks the same *.copy.md files, so a change here has to land there too.
const dir = join(__dirname, '../fixtures/mdx');
const names = readdirSync(dir)
  .filter((f) => f.endsWith('.mdx'))
  .map((f) => f.replace(/\.mdx$/, ''));

describe('mdxToMarkdown', () => {
  for (const name of names) {
    it(name, () => {
      const mdx = readFileSync(join(dir, `${name}.mdx`), 'utf8');
      const expected = readFileSync(join(dir, `${name}.copy.md`), 'utf8');
      expect(mdxToMarkdown(mdx) + '\n').toBe(expected);
    });
  }

  it('leaves no component tag in any fixture outside code', () => {
    for (const name of names) {
      const out = mdxToMarkdown(readFileSync(join(dir, `${name}.mdx`), 'utf8'));
      const prose = out.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, '');
      expect(prose, name).not.toMatch(/<\/?[A-Z]\w*/);
    }
  });

  it('strips the tags of a reply that is not valid MDX, keeping its words', () => {
    expect(mdxToMarkdown('<Callout type="warn">\nCareful {here\n</Callout>')).toBe('Careful {here');
  });

  it('keeps tags written inside code', () => {
    expect(mdxToMarkdown('Use `<Callout>` like this.')).toBe('Use `<Callout>` like this.');
  });

  it('closes a data component the model forgot to close', () => {
    const out = mdxToMarkdown('<DataTable>\n```json\n[{"a":1}]\n```\nAfter.');
    expect(out).toBe('| a |\n| --- |\n| 1 |\n\nAfter.');
  });

  it('draws the Markdown as HTML without controls', async () => {
    const html = await replyHtml(mdxToMarkdown(readFileSync(join(dir, 'steps-block.mdx'), 'utf8')));
    expect(html).toContain('<ol>');
    expect(html).toContain('stem pair --show');
    expect(html).not.toMatch(/<button|<input/);
  });
});
