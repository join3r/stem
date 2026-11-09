import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, net: {}, protocol: {}, session: {}, shell: {} }));

const { escapeHtml, splitRow, textPage, viewKind } = await import('../../src/desktop/viewer');
const { openFilesItem, openLink, setFileViewer } = await import('../../src/desktop/open-link');

// Stem's own file viewer (desktop/viewer.ts): which files it shows, and the
// wrapper pages it writes for text and tables.

describe('viewKind', () => {
  it('shows web pages, PDF, pictures, media and text everywhere', () => {
    expect(viewKind('/a/x.HTML', 'linux')).toBe('html');
    expect(viewKind('/a/x.pdf', 'win32')).toBe('pdf');
    expect(viewKind('/a/x.svg', 'linux')).toBe('image');
    expect(viewKind('/a/x.heic', 'darwin')).toBe('heic');
    expect(viewKind('/a/x.mov', 'linux')).toBe('video');
    expect(viewKind('/a/x.m4a', 'linux')).toBe('audio');
    expect(viewKind('/a/x.md', 'linux')).toBe('text');
    expect(viewKind('/a/x.tsv', 'linux')).toBe('table');
  });

  it('sends Office and iWork files to Quick Look on macOS only, and shows no programs', () => {
    expect(viewKind('/a/x.docx', 'darwin')).toBe('quicklook');
    expect(viewKind('/a/x.doc', 'darwin')).toBe('quicklook');
    expect(viewKind('/a/x.docx', 'linux')).toBeUndefined();
    for (const p of ['/a/run.sh', '/a/x.zip', '/a/App.app', '/a/noext', '/a/x.exe']) expect(viewKind(p, 'darwin')).toBeUndefined();
  });
});

describe('wrapper pages', () => {
  it('escapes text so a file cannot become markup', () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
    const page = textPage('a.md', '# <img src=x onerror=alert(1)>', 'text', false);
    expect(page).not.toContain('<img');
    expect(page).toContain('&lt;img');
  });

  it('splits CSV with quoted fields into a table', () => {
    expect(splitRow('a,"b, c","say ""hi""",', ',')).toEqual(['a', 'b, c', 'say "hi"', '']);
    const page = textPage('farms.csv', 'name,pigs\nHolíč,"1,200"\n', 'table', false);
    expect(page).toContain('<td>Holíč</td><td>1,200</td>');
  });
});

describe('links try the viewer first', () => {
  afterEach(() => setFileViewer(null));
  const fake = () => {
    const calls: string[] = [];
    return {
      calls,
      shell: {
        openExternal: async (u: string) => void calls.push(`external ${u}`),
        openPath: async (p: string) => (calls.push(`open ${p}`), ''),
        showItemInFolder: (p: string) => void calls.push(`reveal ${p}`)
      }
    };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('uses the viewer when it shows the file, and the old way when it does not or fails', async () => {
    const viewed: string[] = [];
    setFileViewer(async (p) => {
      if (p.endsWith('.boom')) throw new Error('no');
      viewed.push(p);
      return p.endsWith('.html');
    });
    const f = fake();
    openLink(f.shell, 'file:///tmp/a/page.html');
    openLink(f.shell, 'file:///tmp/a/data.csv');
    openLink(f.shell, 'file:///tmp/a/x.boom');
    openLink(f.shell, 'file:///tmp/a/');
    openLink(f.shell, 'https://example.com/');
    await tick();
    expect(viewed).toEqual(['/tmp/a/page.html', '/tmp/a/data.csv']);
    expect(f.calls.sort()).toEqual(['external https://example.com/', 'open /tmp/a/data.csv', 'reveal /tmp/a/', 'reveal /tmp/a/x.boom'].sort());
  });

  it('a files/ item the viewer does not show keeps the reveal-only rule', async () => {
    setFileViewer(async () => false);
    const f = fake();
    openFilesItem(f.shell, '/tmp/stem-files-a/old.doc');
    await tick();
    expect(f.calls).toEqual(['reveal /tmp/stem-files-a/old.doc']);
  });
});
