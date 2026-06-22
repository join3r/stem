import { piHome, piSessionsDir, workspaceRoot } from '../workspace/paths';
import { PiRuntime } from '../pi/runtime';
import type { ChatBackend } from './types';

export type { ChatBackend } from './types';

/**
 * Construct the active backend. pi is the only backend; it's kept behind the
 * {@link ChatBackend} seam so the rest of the app stays backend-agnostic and a
 * future backend can drop in here.
 */
export function createBackend(): ChatBackend {
  return new PiRuntime({
    piHome: piHome(),
    sessionsDir: piSessionsDir(),
    workspaceRoot: workspaceRoot()
  });
}
