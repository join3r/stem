import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

let cached: string | null | undefined;

/**
 * Resolve the `codex` binary. PATH first (via `which`), then portable
 * fallbacks. No machine-specific absolute paths.
 */
export async function findCodexPath(): Promise<string | null> {
  if (cached !== undefined) return cached;

  const fromPath = await which('codex');
  if (fromPath) return (cached = fromPath);

  const home = homedir();
  const candidates = [
    join(home, '.local/bin/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex'
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return (cached = candidate);
    } catch {
      // keep looking
    }
  }
  return (cached = null);
}

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [bin], { timeout: 4000 }, (error, stdout) => {
      if (error) return resolve(null);
      const line = stdout.trim().split('\n')[0]?.trim();
      resolve(line || null);
    });
  });
}
