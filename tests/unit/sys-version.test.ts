// The system version: which persona / skills / memory CODE produced a turn or a
// mail. The hasher is derived from the source tree (no manual bump to forget);
// the runtime accessor degrades to 'unbuilt' where nothing inlined a value.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUBSYSTEMS, computeSystemVersion, hashPaths } from '../../scripts/sys-version.mjs';
import { systemVersion } from '../../src/server/sys-version';
import { coerceSystemVersion, formatSystemVersion, sameSystem } from '../../src/shared/sys-version';

const repoRoot = join(import.meta.dirname, '..', '..');

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'stem-sysver-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('hashPaths', () => {
  it('is 12 hex, stable across runs, and blind to files outside the listed paths', () => {
    const root = tree({ 'a/one.ts': 'one', 'a/two.ts': 'two', 'b/other.ts': 'other' });
    try {
      const first = hashPaths(root, ['a']);
      expect(first).toMatch(/^[0-9a-f]{12}$/);
      expect(hashPaths(root, ['a'])).toBe(first);
      writeFileSync(join(root, 'b/other.ts'), 'changed');
      expect(hashPaths(root, ['a'])).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('moves when a listed file changes, is added, or is renamed', () => {
    const root = tree({ 'a/one.ts': 'one', 'a/two.ts': 'two' });
    try {
      const first = hashPaths(root, ['a']);
      writeFileSync(join(root, 'a/one.ts'), 'one!');
      const edited = hashPaths(root, ['a']);
      expect(edited).not.toBe(first);
      writeFileSync(join(root, 'a/three.ts'), 'three');
      const added = hashPaths(root, ['a']);
      expect(added).not.toBe(edited);
      // Same bytes under another name is a different tree: the path is hashed too.
      rmSync(join(root, 'a/three.ts'));
      writeFileSync(join(root, 'a/tres.ts'), 'three');
      expect(hashPaths(root, ['a'])).not.toBe(added);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts single files alongside directories', () => {
    const root = tree({ 'a/one.ts': 'one', 'lone.ts': 'lone' });
    try {
      expect(hashPaths(root, ['a', 'lone.ts'])).not.toBe(hashPaths(root, ['a']));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('computeSystemVersion on this checkout', () => {
  it('names the three subsystems from real paths and yields three distinct hashes', () => {
    const v = computeSystemVersion(repoRoot);
    for (const key of ['persona', 'skills', 'memory'] as const) {
      expect(v[key]).toMatch(/^[0-9a-f]{12}$/);
      expect(SUBSYSTEMS[key].length).toBeGreaterThan(0);
    }
    expect(new Set([v.persona, v.skills, v.memory]).size).toBe(3);
  });

  it('the persona hash covers the mail preamble (moved out of pi/runtime.ts so it counts)', () => {
    expect(SUBSYSTEMS.persona).toContain('src/server/mail');
  });
});

describe('runtime accessor and shared helpers', () => {
  it('reads unbuilt under vitest (nothing inlined) with the full shape', () => {
    expect(systemVersion()).toEqual({ persona: 'unbuilt', skills: 'unbuilt', memory: 'unbuilt' });
    // A fresh object each call — a caller mutating its stamp cannot leak into the next.
    expect(systemVersion()).not.toBe(systemVersion());
  });

  it('sameSystem compares the three hashes and ignores build', () => {
    const a = { persona: 'p', skills: 's', memory: 'm', build: 'abc' };
    expect(sameSystem(a, { persona: 'p', skills: 's', memory: 'm' })).toBe(true);
    expect(sameSystem(a, { ...a, memory: 'x' })).toBe(false);
    expect(sameSystem(a, undefined)).toBe(false);
  });

  it('coerceSystemVersion keeps a full stamp and drops a partial or foreign one', () => {
    expect(coerceSystemVersion({ persona: 'p', skills: 's', memory: 'm', build: 'b' })).toEqual({
      persona: 'p',
      skills: 's',
      memory: 'm',
      build: 'b'
    });
    expect(coerceSystemVersion({ persona: 'p', skills: 's', memory: 'm', build: 7 })).toEqual({
      persona: 'p',
      skills: 's',
      memory: 'm'
    });
    expect(coerceSystemVersion({ persona: 'p', skills: 's' })).toBeNull();
    expect(coerceSystemVersion('p')).toBeNull();
  });

  it('formats the boot line / hover label', () => {
    expect(formatSystemVersion({ persona: 'p', skills: 's', memory: 'm', build: 'b' })).toBe(
      'persona p · skills s · memory m · build b'
    );
    expect(formatSystemVersion({ persona: 'p', skills: 's', memory: 'm' })).toBe('persona p · skills s · memory m');
  });
});
