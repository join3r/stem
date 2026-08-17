import { describe, expect, it } from 'vitest';
import { win32 as pathWin32 } from 'node:path';
import {
  bashBesideGit,
  detectGitBashFromDisk,
  gitBashPathEnv,
  isUsableGitBashPath,
  resolveGitBashExecutable,
  resolveHostShell,
  resolveHostShellTarget,
  wellKnownGitBashCandidates
} from '../../src/server/exec/git-bash';
import { unixShell } from '../../src/server/exec/executor';
import { hostShellAgentHint, hostShellFromPlatform } from '../../src/server/exec/host-shell';
import { hostShellLabel } from '../../src/server/exec/policy';

const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
/** WSL's launcher: a real bash.exe that is not a shell we can reason about. */
const WSL_BASH = 'C:\\Windows\\System32\\bash.exe';

/** An `exists` fake listing exactly what is on this imaginary disk. */
const onDisk =
  (...paths: string[]) =>
  (p: string): boolean =>
    paths.includes(p);

describe('isUsableGitBashPath', () => {
  it('requires bash.exe and a file that exists', () => {
    const exists = onDisk(BASH, GIT);
    expect(isUsableGitBashPath(BASH, exists)).toBe(true);
    expect(isUsableGitBashPath('C:\\Program Files\\Git\\cmd\\git.exe', exists)).toBe(false);
    expect(isUsableGitBashPath(null, exists)).toBe(false);
    expect(isUsableGitBashPath('  ', exists)).toBe(false);
    expect(isUsableGitBashPath(BASH, () => false)).toBe(false);
  });

  it('rejects WSL and any other bash.exe with no Git beside it', () => {
    // Everything exists here — the layout is the only thing separating them.
    expect(isUsableGitBashPath(WSL_BASH, () => true)).toBe(false);
    expect(isUsableGitBashPath(BASH, onDisk(BASH))).toBe(false);
    // Git's own MSYS bash: the root gitBashPathEnv would derive is one level off,
    // so the git.exe that proves the install is not where this path implies.
    const usrBash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    expect(isUsableGitBashPath(usrBash, onDisk(usrBash, BASH, GIT))).toBe(false);
  });

  it('accepts an install that proves itself with libexec\\git-core', () => {
    const root = 'C:\\tools\\git';
    const bash = pathWin32.join(root, 'bin', 'bash.exe');
    expect(isUsableGitBashPath(bash, onDisk(bash, pathWin32.join(root, 'libexec', 'git-core')))).toBe(true);
  });
});

describe('detectGitBashFromDisk', () => {
  it('finds a well-known Program Files install without spawning', () => {
    const env = { ProgramFiles: 'C:\\Program Files' };
    expect(detectGitBashFromDisk({ env, exists: onDisk(BASH, GIT) })).toBe(BASH);
  });

  it('finds bash beside git.exe on PATH (Git\\cmd layout)', () => {
    const env = {
      ProgramFiles: 'D:\\none',
      'ProgramFiles(x86)': 'D:\\none86',
      LOCALAPPDATA: 'D:\\local',
      USERPROFILE: 'D:\\home',
      Path: 'C:\\Windows;C:\\Program Files\\Git\\cmd'
    };
    expect(detectGitBashFromDisk({ env, exists: onDisk(GIT, BASH) })).toBe(BASH);
  });

  it('finds bash.exe itself on PATH', () => {
    const env = {
      ProgramFiles: 'D:\\none',
      LOCALAPPDATA: 'D:\\local',
      USERPROFILE: 'D:\\home',
      Path: 'C:\\tools\\git\\bin'
    };
    const bash = pathWin32.join('C:\\tools\\git\\bin', 'bash.exe');
    const git = pathWin32.join('C:\\tools\\git\\cmd', 'git.exe');
    expect(detectGitBashFromDisk({ env, exists: onDisk(bash, git) })).toBe(bash);
  });

  it('walks past WSL on PATH to the real Git install', () => {
    // System32 comes first on every Windows PATH, and on a WSL-enabled machine
    // it holds a bash.exe. Taking it would run commands in the Linux VM, where
    // /mnt/c paths sail straight through the protected-roots guard.
    const env = {
      ProgramFiles: 'D:\\none',
      LOCALAPPDATA: 'D:\\local',
      USERPROFILE: 'D:\\home',
      Path: 'C:\\Windows\\System32;C:\\tools\\git\\bin'
    };
    const bash = pathWin32.join('C:\\tools\\git\\bin', 'bash.exe');
    const git = pathWin32.join('C:\\tools\\git\\cmd', 'git.exe');
    expect(detectGitBashFromDisk({ env, exists: onDisk(WSL_BASH, bash, git) })).toBe(bash);
    // …and with no Git anywhere, WSL is not a fallback — cmd.exe is.
    expect(detectGitBashFromDisk({ env, exists: onDisk(WSL_BASH) })).toBeNull();
  });

  it('returns null when nothing is on disk (no spawn)', () => {
    const env = {
      ProgramFiles: 'D:\\none',
      LOCALAPPDATA: 'D:\\local',
      USERPROFILE: 'D:\\home',
      Path: 'C:\\Windows'
    };
    expect(detectGitBashFromDisk({ env, exists: () => false })).toBeNull();
  });
});

describe('bashBesideGit', () => {
  it('walks Git\\cmd\\git.exe up to Git\\bin\\bash.exe', () => {
    expect(bashBesideGit(GIT, onDisk(BASH, GIT))).toBe(BASH);
  });
});

describe('wellKnownGitBashCandidates', () => {
  it('uses win32 joins so Mac CI sees Windows paths', () => {
    const list = wellKnownGitBashCandidates({
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\me'
    });
    expect(list[0]).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(list.some((p) => p.includes('scoop'))).toBe(true);
  });
});

describe('gitBashPathEnv', () => {
  it('prepends Git usr\\bin, bin, cmd, and mingw dirs', () => {
    const path = gitBashPathEnv(BASH, 'C:\\Windows');
    expect(path.startsWith('C:\\Program Files\\Git\\usr\\bin;')).toBe(true);
    expect(path).toContain('C:\\Program Files\\Git\\mingw64\\bin');
    expect(path.endsWith('C:\\Windows')).toBe(true);
  });
});

describe('resolveHostShell', () => {
  it('is zsh off Windows, cmd on Windows when Settings asked for cmd', () => {
    expect(resolveHostShell({ windowsShell: 'cmd', gitBashPath: null }, 'darwin')).toBe('zsh');
    expect(resolveHostShell({ windowsShell: 'cmd', gitBashPath: null }, 'win32')).toBe('cmd');
  });

  it('uses Git Bash when opted in and bash.exe exists at the saved path', () => {
    const exists = onDisk(BASH, GIT);
    expect(resolveHostShell({ windowsShell: 'git-bash', gitBashPath: BASH }, 'win32', exists)).toBe('git-bash');
    expect(resolveHostShell({ windowsShell: 'git-bash', gitBashPath: BASH }, 'darwin', exists)).toBe('zsh');
  });

  it('falls back to cmd when Git Bash is selected but bash.exe is not on disk', () => {
    expect(resolveHostShell({ windowsShell: 'git-bash', gitBashPath: BASH }, 'win32', () => false)).toBe('cmd');
  });

  it('auto-detects bash.exe when git-bash is selected with no saved path', () => {
    const exists = onDisk(BASH, GIT);
    expect(resolveHostShell({ windowsShell: 'git-bash', gitBashPath: null }, 'win32', exists)).toBe('git-bash');
    expect(resolveGitBashExecutable({ gitBashPath: null }, exists)).toBe(BASH);
  });
});

describe('resolveHostShellTarget', () => {
  it('carries the executable the decision was made with', () => {
    const target = resolveHostShellTarget({ windowsShell: 'git-bash', gitBashPath: null }, 'win32', onDisk(BASH, GIT));
    // One answer, decided once: exec/service.ts hands this whole object to spawn
    // rather than asking the disk again after an approval card.
    expect(target).toEqual({ shell: 'git-bash', gitBashPath: BASH });
  });

  it('reports no path for the shells that do not have one', () => {
    expect(resolveHostShellTarget({ windowsShell: 'cmd', gitBashPath: BASH }, 'win32')).toEqual({
      shell: 'cmd',
      gitBashPath: null
    });
    expect(resolveHostShellTarget({ windowsShell: 'git-bash', gitBashPath: BASH }, 'darwin')).toEqual({
      shell: 'zsh',
      gitBashPath: null
    });
    expect(resolveHostShellTarget({ windowsShell: 'git-bash', gitBashPath: BASH }, 'win32', () => false)).toEqual({
      shell: 'cmd',
      gitBashPath: null
    });
  });
});

describe('hostShellLabel / hint', () => {
  it('names one shell, never both', () => {
    expect(hostShellLabel('cmd')).toContain('cmd.exe');
    expect(hostShellLabel('cmd')).not.toContain('Git Bash');
    expect(hostShellLabel('git-bash')).toContain('Git Bash');
    expect(hostShellLabel('git-bash')).not.toContain('cmd.exe');
    expect(hostShellLabel('zsh')).toContain(unixShell().path.split('/').pop());
  });

  it('hints only on Windows shells (zsh is already in the tool description)', () => {
    expect(hostShellAgentHint('zsh')).toBe('');
    expect(hostShellAgentHint('cmd')).toContain('cmd.exe');
    expect(hostShellAgentHint('git-bash')).toContain('Git Bash');
    expect(hostShellFromPlatform('linux')).toBe('zsh');
    expect(hostShellFromPlatform('win32')).toBe('cmd');
  });
});
