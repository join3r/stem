import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sampleFolder } from '../../src/server/connected-folders/sample';
import { parseSuggestion, suggestFolderSettings } from '../../src/server/connected-folders/suggest';

// "Suggest settings" for a connected folder: the sample a model sees (names,
// counts, one README excerpt — never the files) and how its answer is read.

const root = mkdtempSync(join(tmpdir(), 'stem-suggest-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('sampleFolder', () => {
  it('summarizes a repo: markers, extensions, README excerpt, opaque dirs not walked', async () => {
    const repo = join(root, 'billing');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'package.json'), '{}');
    writeFileSync(join(repo, 'README.md'), '# Billing\nThe billing API.');
    writeFileSync(join(repo, 'src', 'a.ts'), '');
    writeFileSync(join(repo, 'src', 'b.ts'), '');
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), '');

    const s = await sampleFolder(repo);
    expect(s.name).toBe('billing');
    expect(s.markers).toEqual(expect.arrayContaining(['.git', 'node_modules', 'package.json']));
    expect(s.extensions[0]).toEqual(['.ts', 2]);
    expect(s.paths).not.toContain(join('node_modules', 'dep', 'index.js'));
    expect(s.fileCount).toBe(4);
    expect(s.topLevel).toEqual(expect.arrayContaining(['src/', 'README.md', '.git/']));
    expect(s.excerpt).toEqual({ file: 'README.md', text: '# Billing\nThe billing API.' });
  });

  it('throws for a folder that is not there', async () => {
    await expect(sampleFolder(join(root, 'nope'))).rejects.toThrow();
  });
});

describe('parseSuggestion', () => {
  it('reads a fenced JSON answer', () => {
    const s = parseSuggestion(
      'Here:\n```json\n{"kind":"notes","writable":false,"memorize":true,"index":true,"learnMode":"all","note":"My vault","reason":"Has .obsidian"}\n```'
    );
    expect(s).toEqual({
      kind: 'notes',
      writable: false,
      memorize: true,
      index: true,
      learnMode: 'all',
      note: 'My vault',
      reason: 'Has .obsidian'
    });
  });

  it('falls back to the safe side on missing or unknown fields', () => {
    const s = parseSuggestion('{"kind":"music","learnMode":"sometimes"}');
    expect(s).toMatchObject({ kind: null, writable: false, memorize: false, index: true, learnMode: 'use' });
  });

  it('never remembers a folder it calls confidential', () => {
    expect(parseSuggestion('{"kind":"private","memorize":true}').memorize).toBe(false);
  });

  it('refuses an answer with no JSON', () => {
    expect(() => parseSuggestion('I think it is a notes vault.')).toThrow(/did not answer/);
  });
});

describe('suggestFolderSettings', () => {
  it('sends the sample and the user note in the prompt', async () => {
    let seen = '';
    const llm = {
      complete: async (prompt: string) => {
        seen = prompt;
        return '{"kind":"code","writable":true,"memorize":false,"index":false,"learnMode":"off","note":"x","reason":"y"}';
      }
    };
    const s = await suggestFolderSettings(
      llm,
      { name: 'billing', fileCount: 1, truncated: false, extensions: [['.ts', 1]], topLevel: [], markers: ['.git'], paths: [] },
      'The billing service'
    );
    expect(s.kind).toBe('code');
    expect(seen).toContain('"billing"');
    expect(seen).toContain('The user describes the folder as: The billing service');
  });
});
