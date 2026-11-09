import { describe, expect, it } from 'vitest';
import { filesPlaceRel, scratchRel } from '../../src/shared/files-links';

// A `files/…` link in a reply names a file in the user's Files place.

describe('filesPlaceRel', () => {
  it('reads the Files-relative path, decoded', () => {
    expect(filesPlaceRel('files/cfk-2012-explainer.html')).toBe('cfk-2012-explainer.html');
    expect(filesPlaceRel('files/reports/Q3%20plan.pdf')).toBe('reports/Q3 plan.pdf');
  });

  it('names nothing outside the Files place, hidden, or not a file', () => {
    for (const href of [
      'files/../secrets.json',
      'files/a/%2E%2E/%2E%2E/x',
      'files/.ssh/id_rsa',
      'files/dir/',
      'files//x',
      'files/a?b',
      'docs/x.html',
      './files/x',
      'https://x/files/a',
      'files/%E0%A4%A',
      undefined
    ]) {
      expect(filesPlaceRel(href)).toBeUndefined();
    }
  });
});

describe('scratchRel', () => {
  it('reads a scratch/ link the same way, and only that prefix', () => {
    expect(scratchRel('scratch/out/report%201.html')).toBe('out/report 1.html');
    expect(scratchRel('scratch/../x')).toBeUndefined();
    expect(scratchRel('scratch/files/a.txt')).toBe('files/a.txt'); // the server refuses it (a link out of scratch)
    expect(scratchRel('files/a.txt')).toBeUndefined();
  });
});

describe('openFilesItem', async () => {
  const { openFilesItem } = await import('../../src/desktop/open-link');
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

  it('opens a document and only shows macro, script or archive types', () => {
    const f = fake();
    openFilesItem(f.shell, '/tmp/stem-files-a/report.html');
    openFilesItem(f.shell, '/tmp/stem-files-b/old.doc');
    openFilesItem(f.shell, '/tmp/stem-files-c/pic.svg');
    openFilesItem(f.shell, '/tmp/stem-files-d/run.sh');
    expect(f.calls).toEqual([
      'open /tmp/stem-files-a/report.html',
      'reveal /tmp/stem-files-b/old.doc',
      'reveal /tmp/stem-files-c/pic.svg',
      'reveal /tmp/stem-files-d/run.sh'
    ]);
  });
});
