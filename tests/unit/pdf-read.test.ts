import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPdfText } from '../../src/server/pi/pdf-read';
import { makePdf } from './make-pdf';

// The main half of `read` on a PDF: what the bridge's tool_result hook gets
// back for a path pi's own read just decoded as UTF-8 garbage.

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stem-pdf-read-'));
  cleanup.push(dir);
  return dir;
}

describe('readPdfText', () => {
  it('returns the text layer of every page', async () => {
    const path = join(await tmp(), 'Faktura_20260009.pdf');
    await writeFile(path, makePdf([['FAKTURA 20260009', 'Odberatel Cloudfarms'], ['Spolu 162 h']]));
    const res = await readPdfText(path);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Odberatel Cloudfarms');
    expect(res.text).toContain('Spolu 162 h');
    expect(res.truncated).toBe(false);
  });

  it('re-extracts after the file changes, not from a stale cache', async () => {
    const path = join(await tmp(), 'a.pdf');
    await writeFile(path, makePdf([['first version']]));
    expect(await readPdfText(path)).toMatchObject({ ok: true, text: expect.stringContaining('first version') });
    await writeFile(path, makePdf([['second version, longer']]));
    expect(await readPdfText(path)).toMatchObject({ ok: true, text: expect.stringContaining('second version') });
  });

  it('refuses what is not an absolute .pdf path, and reports an unparseable file', async () => {
    const dir = await tmp();
    expect((await readPdfText('relative.pdf')).ok).toBe(false);
    expect((await readPdfText(join(dir, 'notes.md'))).ok).toBe(false);
    expect((await readPdfText(join(dir, 'missing.pdf'))).ok).toBe(false);
    const broken = join(dir, 'broken.pdf');
    await writeFile(broken, 'not a pdf at all');
    const res = await readPdfText(broken);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('could not extract');
  });
});
