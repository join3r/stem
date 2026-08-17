import type { HostShell } from '../../shared/types';

/**
 * Default host shell from the OS when there are no ExecSettings (tests, a
 * remote device's platform). Windows is cmd.exe here; the real Windows default
 * in Settings is Git Bash, applied through resolveHostShell.
 */
export function hostShellFromPlatform(platform: NodeJS.Platform = process.platform): HostShell {
  return platform === 'win32' ? 'cmd' : 'zsh';
}

/** True for cmd.exe's quoting rules (`'` is not a quote, `%` expands, `^` escapes). */
export function isCmdShell(shell: HostShell): boolean {
  return shell === 'cmd';
}

/**
 * Per-turn hint so the model writes commands for the one shell that will run.
 * Empty on zsh: the run_command tool description already covers that.
 */
export function hostShellAgentHint(shell: HostShell): string {
  if (shell === 'cmd') {
    return (
      'run_command on this machine uses cmd.exe (/d /s /c, no AutoRun). Quote with double quotes: ' +
      "cmd does not treat a single quote as a quote character. POSIX names like ls, cat, and grep " +
      'are not commands here — use dir, type, findstr. A bare | is a cmd pipe. If you need PowerShell, ' +
      'invoke powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "..." and put pipelines inside -Command.'
    );
  }
  if (shell === 'git-bash') {
    return (
      'run_command on this machine uses Git Bash (bash --noprofile --norc). POSIX quoting and commands ' +
      '(ls, cat, grep) work. Paths may be Windows (C:\\Users\\...) or Git Bash (/c/Users/...).'
    );
  }
  return '';
}
