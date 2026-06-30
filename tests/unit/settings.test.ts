// Settings suite — exercises the REAL settings store against the throwaway
// userData path from the electron stub. Focuses on the escapeAction field:
// persistence round-trip and the coerce fallback for missing/garbage values.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readSettings, updateEscapeAction } from '../../src/main/workspace/settings';
import { settingsStorePath } from '../../src/main/workspace/paths';

const path = settingsStorePath();

beforeEach(() => {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
});
afterEach(() => {
  rmSync(path, { force: true });
});

describe('escapeAction setting', () => {
  it('defaults to off when no file exists', async () => {
    expect((await readSettings()).escapeAction).toBe('off');
  });

  it('round-trips single and twoStage through updateEscapeAction', async () => {
    expect((await updateEscapeAction('single')).escapeAction).toBe('single');
    expect((await readSettings()).escapeAction).toBe('single');
    expect((await updateEscapeAction('twoStage')).escapeAction).toBe('twoStage');
    expect((await readSettings()).escapeAction).toBe('twoStage');
    expect((await updateEscapeAction('off')).escapeAction).toBe('off');
  });

  it('falls back to off for a garbage persisted value', async () => {
    writeFileSync(path, JSON.stringify({ escapeAction: 'bogus' }));
    expect((await readSettings()).escapeAction).toBe('off');
  });

  it('falls back to off when the field is missing', async () => {
    writeFileSync(path, JSON.stringify({ quickChat: {} }));
    expect((await readSettings()).escapeAction).toBe('off');
  });
});
