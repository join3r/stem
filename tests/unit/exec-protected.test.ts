import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProtected, msysToWindows } from '../../src/server/exec/protected';

// The main-side fail-closed guard for read-only connected folders: any command
// or cwd referencing a protected root is blocked; unreadable gate state blocks
// everything.

let dir: string;
let rootsPath: string;
let vault: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stem-exec-protected-')));
  vault = join(dir, 'vault');
  rootsPath = join(dir, 'protected-roots.json');
  writeFileSync(rootsPath, JSON.stringify({ roots: [vault] }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scanProtected', () => {
  it('allows commands that touch nothing protected', () => {
    expect(scanProtected('ls -la', join(dir, 'elsewhere'), rootsPath).blocked).toBe(false);
  });

  it('blocks a cwd inside a protected root', () => {
    const res = scanProtected('ls', join(vault, 'notes'), rootsPath);
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain(vault);
  });

  it('blocks a path token inside a protected root, quoted or not', () => {
    expect(scanProtected(`cat ${vault}/daily.md`, dir, rootsPath).blocked).toBe(true);
    expect(scanProtected(`rm -rf "${vault}/sub"`, dir, rootsPath).blocked).toBe(true);
  });

  it('does not block sibling paths that merely share a prefix', () => {
    expect(scanProtected(`ls ${vault}-backup`, dir, rootsPath).blocked).toBe(false);
  });

  it('treats a missing gate file as no protected roots', () => {
    expect(scanProtected('ls', dir, join(dir, 'missing.json')).blocked).toBe(false);
  });

  it('fails closed on a corrupt gate file', () => {
    writeFileSync(rootsPath, 'not json');
    expect(scanProtected('ls', dir, rootsPath).blocked).toBe(true);
    writeFileSync(rootsPath, JSON.stringify({ roots: 'nope' }));
    expect(scanProtected('ls', dir, rootsPath).blocked).toBe(true);
  });
});

// Windows path shapes, asserted from any host: the roots file and the commands
// are written the way cmd.exe would see them and the scan is told `win32`.
describe('scanProtected on Windows paths', () => {
  const winVault = 'C:\\Users\\me\\vault';

  beforeEach(() => {
    writeFileSync(rootsPath, JSON.stringify({ roots: [winVault, '\\\\nas\\share\\vault'] }));
  });

  const scan = (command: string, cwd = 'C:\\work') =>
    scanProtected(command, cwd, rootsPath, 'cmd');

  it('blocks drive-absolute paths inside a protected root', () => {
    // `type` and `dir` are tier 1 under cmd, so this is the gate's whole job.
    expect(scan('type C:\\Users\\me\\vault\\secrets.txt').blocked).toBe(true);
    expect(scan('dir "C:\\Users\\me\\vault\\sub"').blocked).toBe(true);
    // Forward slashes are legal separators on Windows too.
    expect(scan('type C:/Users/me/vault/secrets.txt').blocked).toBe(true);
  });

  it('is case-insensitive, as NTFS is', () => {
    expect(scan('type c:\\users\\ME\\Vault\\secrets.txt').blocked).toBe(true);
  });

  it('blocks UNC paths', () => {
    expect(scan('type \\\\nas\\share\\vault\\secrets.txt').blocked).toBe(true);
  });

  it('expands %VAR% the way cmd does before matching', () => {
    process.env.STEM_TEST_VAULT = winVault;
    try {
      expect(scan('type %STEM_TEST_VAULT%\\secrets.txt').blocked).toBe(true);
    } finally {
      delete process.env.STEM_TEST_VAULT;
    }
  });

  it('blocks a cwd inside a protected root', () => {
    expect(scan('dir', 'C:\\Users\\me\\vault\\notes').blocked).toBe(true);
  });

  it('does not mistake cmd flags for paths', () => {
    // A bare `/b` is a flag, not a path — matching it would block on a root the
    // command never named.
    expect(scan('dir /b /s').blocked).toBe(false);
    expect(scan('type notes.txt').blocked).toBe(false);
  });

  it('does not block siblings that merely share a prefix', () => {
    expect(scan('type C:\\Users\\me\\vault-backup\\x.txt').blocked).toBe(false);
  });

  it('is what the POSIX scan misses — the regression this covers', () => {
    // Same command, POSIX rules: no `~` and no leading `/`, so nothing matched
    // and the read-only folder was wide open to `type`.
    expect(scanProtected('type C:\\Users\\me\\vault\\secrets.txt', 'C:\\work', rootsPath, 'zsh').blocked).toBe(
      false
    );
  });
});

describe('scanProtected on Git Bash paths', () => {
  const winVault = 'C:\\Users\\me\\vault';

  beforeEach(() => {
    writeFileSync(rootsPath, JSON.stringify({ roots: [winVault] }));
  });

  const scan = (command: string, cwd = 'C:\\work') =>
    scanProtected(command, cwd, rootsPath, 'git-bash');

  it('blocks MSYS /c/Users/... paths mapped onto a Windows root', () => {
    expect(scan('cat /c/Users/me/vault/secrets.txt').blocked).toBe(true);
  });

  it('still blocks Windows drive paths (the agent may emit either shape)', () => {
    expect(scan('cat C:\\Users\\me\\vault\\secrets.txt').blocked).toBe(true);
  });

  it('does not treat a cmd /b flag as drive B:', () => {
    expect(scan('ls /b').blocked).toBe(false);
  });
});

describe('msysToWindows', () => {
  it('maps /c/Users/foo to C:\\Users\\foo', () => {
    expect(msysToWindows('/c/Users/me/vault')).toBe('C:\\Users\\me\\vault');
    expect(msysToWindows('/b')).toBeNull();
    expect(msysToWindows('/usr/bin')).toBeNull();
  });
});
