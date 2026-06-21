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

/**
 * The persistent "Files" place: a user-facing folder inside the codex cwd where
 * the user drops files (optionally organized into subfolders) that the assistant
 * can read on demand. Inside workspaceRoot() so the agent's read tools reach it.
 */
export function filesRoot(): string {
  // STEM_FILES_DIR lets probe/verification scripts point at a throwaway folder
  // (and avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_FILES_DIR ?? join(workspaceRoot(), 'files');
}

/**
 * Stem-owned chat-organization store: the user's folder tree and the
 * chat->folder assignments. Chats themselves are codex threads on disk; this
 * file only holds the organization layer codex has no concept of.
 */
export function chatStorePath(): string {
  return join(userDataRoot(), 'folders.json');
}

/**
 * Stem-owned app settings (e.g. the global Quick Chat shortcut + its defaults).
 * Held in the main process because some of it — the global accelerator — can
 * only be registered from main, not the renderer.
 */
export function settingsStorePath(): string {
  return join(userDataRoot(), 'settings.json');
}

/**
 * Stem-owned recall database (the custom memory layer): every user+assistant
 * message (Level 2, FTS5-searchable) plus distilled durable facts (Level 1).
 * Stem owns this end-to-end so memory is decoupled from the chat backend.
 */
export function recallDbPath(): string {
  // STEM_RECALL_DB lets probe/verification scripts point at a throwaway database
  // (and avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_RECALL_DB ?? join(userDataRoot(), 'recall.sqlite');
}
