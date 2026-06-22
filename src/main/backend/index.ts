import type { AppSettings, BackendKind } from '../../shared/types';
import { codexHome, piHome, piSessionsDir, workspaceRoot } from '../workspace/paths';
import { CodexRuntime } from '../codex/runtime';
import { PiRuntime } from '../pi/runtime';
import type { ChatBackend } from './types';

export type { ChatBackend } from './types';

/**
 * Resolve which backend to run. `STEM_BACKEND` (env) wins for dev/spike work;
 * otherwise the persisted `backend` setting, defaulting to codex.
 */
export function resolveBackendKind(settings: AppSettings): BackendKind {
  const env = process.env.STEM_BACKEND;
  if (env === 'pi' || env === 'codex') return env;
  return settings.backend === 'pi' ? 'pi' : 'codex';
}

/** The isolated home directory for a backend (the CODEX_HOME / PI_CODING_AGENT_DIR analog). */
export function backendHome(kind: BackendKind): string {
  return kind === 'pi' ? piHome() : codexHome();
}

/**
 * Construct the active backend. Both implementations satisfy {@link ChatBackend},
 * so the rest of the app is agnostic to which one is live.
 */
export function createBackend(kind: BackendKind): ChatBackend {
  if (kind === 'pi') {
    return new PiRuntime({
      piHome: piHome(),
      sessionsDir: piSessionsDir(),
      workspaceRoot: workspaceRoot()
    });
  }
  return new CodexRuntime({ codexHome: backendHome('codex'), workspaceRoot: workspaceRoot() });
}
