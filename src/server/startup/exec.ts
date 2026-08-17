import { ExecService } from '../exec/service';
import { detectGitBash, isUsableGitBashPath } from '../exec/git-bash';
import { readSettings, updateExecSettings } from '../workspace/settings';
import type { ChatBackend } from '../backend';
import type { ExecApprovalRequest } from '../../shared/types';

/**
 * Command execution: the assistant's run_command tool, routed from the backend
 * to the server's ExecService (tiered auto-approve policy + spawn) via the
 * ExecBridge wired here. Approval cards go straight to the windows through the
 * emit callbacks (the ExecService is server-owned end to end; nothing rides the
 * backend event stream).
 */
export function initExecService(deps: {
  runtime: ChatBackend;
  emitApprovalRequest: (request: ExecApprovalRequest) => void;
  emitApprovalResolved: (id: string) => void;
}): ExecService {
  const service = new ExecService({
    runtime: () => deps.runtime,
    readSettings,
    updateExecSettings,
    emitApprovalRequest: deps.emitApprovalRequest,
    emitApprovalResolved: deps.emitApprovalResolved
  });
  deps.runtime.setExecBridge(service);
  void seedWindowsGitBash();
  return service;
}

/**
 * Fresh Windows installs default to Git Bash with an empty path. Fill it from
 * disk so Settings shows bash.exe and the first command does not have to wait
 * on a later detect. Missing Git → leave the preference; spawn falls back to cmd.
 */
async function seedWindowsGitBash(): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const cur = await readSettings();
    if (cur.exec.windowsShell !== 'git-bash') return;
    if (isUsableGitBashPath(cur.exec.gitBashPath)) return;
    const found = await detectGitBash();
    if (found) await updateExecSettings({ gitBashPath: found, windowsShell: 'git-bash' });
  } catch {
    // Detection is best-effort; resolveHostShell still falls back to cmd.
  }
}
