import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access } from 'node:fs/promises';

// Resolve the `pi` (pi.dev coding agent) binary.
// Memoized: PATH lookup first, then the common install locations Homebrew/npm use.

let cached: string | null | undefined;

export async function findPiPath(): Promise<string | null> {
  if (cached !== undefined) return cached;
  const fromPath = await which('pi');
  if (fromPath) return (cached = fromPath);
  const candidates = [
    join(homedir(), '.local', 'bin', 'pi'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi'
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
    execFile('/usr/bin/which', [bin], (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}
