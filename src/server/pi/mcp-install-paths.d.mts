export interface ShortLivedRoot { root: string; kind: 'scratch' | 'files' }
export interface ShortLivedHit { path: string; kind: 'scratch' | 'files' }
export function shortLivedServerPath(
  command: string | undefined,
  args: readonly string[] | undefined,
  roots: readonly ShortLivedRoot[],
  cwd?: string
): ShortLivedHit | null;
export function shortLivedServerMessage(hit: ShortLivedHit, installRoot: string | undefined, name?: string): string;
