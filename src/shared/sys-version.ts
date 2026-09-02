// Helpers over SystemVersion (types.ts) shared by main and renderer.
import type { SystemVersion } from './types';

/** Same programming: the three subsystem hashes agree. `build` is informational and ignored. */
export function sameSystem(a: SystemVersion | undefined, b: SystemVersion | undefined): boolean {
  if (!a || !b) return false;
  return a.persona === b.persona && a.skills === b.skills && a.memory === b.memory;
}

/** "persona 073d79fee480 · skills … · memory … · build …" — the hover label and the boot line. */
export function formatSystemVersion(v: SystemVersion): string {
  const parts = [`persona ${v.persona}`, `skills ${v.skills}`, `memory ${v.memory}`];
  if (v.build) parts.push(`build ${v.build}`);
  return parts.join(' · ');
}

/** Parse a stored `sys` blob; null unless all three hashes are non-empty strings. */
export function coerceSystemVersion(raw: unknown): SystemVersion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof r[k] === 'string' && r[k] ? (r[k] as string) : null);
  const persona = str('persona');
  const skills = str('skills');
  const memory = str('memory');
  if (!persona || !skills || !memory) return null;
  const build = str('build');
  return { persona, skills, memory, ...(build ? { build } : {}) };
}
