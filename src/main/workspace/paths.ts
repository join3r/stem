import { app } from 'electron';
import { join } from 'node:path';

// All app state lives under Electron's userData dir, fully isolated from the
// user's global ~/.codex. CODEX_HOME and the working dir we launch Codex in are
// both app-owned so no external skills/config can leak in.

export function userDataRoot(): string {
  return app.getPath('userData');
}

/** CODEX_HOME for the isolated runtime (config, auth, skills, memory). */
export function codexHome(): string {
  return join(userDataRoot(), 'codex-home');
}

export function codexConfigPath(): string {
  return join(codexHome(), 'config.toml');
}

export function skillsRoot(): string {
  return join(codexHome(), 'skills');
}

/** Where Codex stores its native cross-conversation memory (markdown + SQLite). */
export function memoriesRoot(): string {
  return join(codexHome(), 'memories');
}

/** The controlled cwd we spawn `codex app-server` in — empty/app-owned. */
export function workspaceRoot(): string {
  return join(userDataRoot(), 'workspace');
}

export function agentsMdPath(): string {
  return join(workspaceRoot(), 'AGENTS.md');
}
