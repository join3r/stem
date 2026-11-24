import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { filePathHref, findFilePaths } from '../../src/shared/file-paths';
import { renderMdx } from '../../src/renderer/mdx/render';

const hrefs = (text: string) => findFilePaths(text).map((m) => [text.slice(m.start, m.end), m.href]);

describe('filePathHref', () => {
  it('links absolute, home and drive-letter paths', () => {
    expect(filePathHref('/Users/me/Downloads/pigs farms.csv')).toBe('file:///Users/me/Downloads/pigs%20farms.csv');
    expect(filePathHref('~/Documents/report.pdf')).toBe('file:///~/Documents/report.pdf');
    expect(filePathHref('C:\\Users\\me\\a b.txt')).toBe('file:///C:/Users/me/a%20b.txt');
    expect(filePathHref('/home/me/src/app.ts:42:7')).toBe('file:///home/me/src/app.ts');
    expect(filePathHref('/Users/me/Downloads/')).toBe('file:///Users/me/Downloads/');
    expect(filePathHref('/Users/me/#1 notes?.md')).toBeUndefined();
  });

  it('leaves relative paths, URL paths and code alone', () => {
    for (const s of ['src/app.ts', './x.csv', '/api/v1/users', '/etc/passwd', 'npm run build', 'https://x.com/Users/a', '~user/x']) {
      expect(filePathHref(s)).toBeUndefined();
    }
  });
});

describe('findFilePaths', () => {
  it('finds paths in prose and drops trailing punctuation', () => {
    expect(hrefs('Saved it to /Users/me/Downloads/out.csv.')).toEqual([
      ['/Users/me/Downloads/out.csv', 'file:///Users/me/Downloads/out.csv'],
    ]);
    expect(hrefs('See ~/notes/todo.md, then /tmp/x/y.log')).toEqual([
      ['~/notes/todo.md', 'file:///~/notes/todo.md'],
      ['/tmp/x/y.log', 'file:///tmp/x/y.log'],
    ]);
  });

  it('ignores bare roots and paths inside URLs', () => {
    expect(hrefs('Look in /tmp/ or ~/ first')).toEqual([]);
    expect(hrefs('https://example.com/Users/me/a.csv')).toEqual([]);
    expect(hrefs('the route /api/home/x')).toEqual([]);
  });
});

describe('rendered replies', () => {
  const html = (md: string) => renderToStaticMarkup(<>{renderMdx(md)}</>);

  it('turns a backticked path into a file link', () => {
    expect(html('Wrote `/Users/me/out.csv`')).toContain('<a href="file:///Users/me/out.csv" title="/Users/me/out.csv" class="file-link"><code class="inline-code">/Users/me/out.csv</code></a>');
  });

  it('turns a prose path into a file link and keeps phone links', () => {
    const out = html('Saved to ~/Downloads/a.pdf, call +421 905 123 456');
    expect(out).toContain('<a href="file:///~/Downloads/a.pdf" title="~/Downloads/a.pdf" class="file-link">~/Downloads/a.pdf</a>');
    expect(out).toContain('href="tel:+421905123456"');
  });

  it('does not nest a file link inside a written link', () => {
    const out = html('[the `/Users/me/out.csv` file](file:///Users/me/out.csv)');
    expect(out.match(/<a /g)).toHaveLength(1);
  });
});
