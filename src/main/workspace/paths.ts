import { app } from 'electron';
import { join } from 'node:path';

// All app state lives under Electron's userData dir, fully isolated from the
// user's global pi config. The backend home and the working dir we launch the
// backend in are both app-owned so no external skills/config can leak in.

export function userDataRoot(): string {
  return app.getPath('userData');
}

/** The legacy codex backend home, removed on startup (see bootstrap cleanup). */
export function legacyCodexHome(): string {
  return join(userDataRoot(), 'codex-home');
}

/**
 * PI_CODING_AGENT_DIR for the isolated pi backend (auth.json, skills, settings).
 * Sessions live under {@link piSessionsDir}.
 */
export function piHome(): string {
  return join(userDataRoot(), 'pi-home');
}

/** PI_CODING_AGENT_SESSION_DIR — where the pi backend stores session JSONL trees. */
export function piSessionsDir(): string {
  return join(piHome(), 'sessions');
}

/** The pi-mcp-adapter config (mcp.json) under the pi home; the config.toml analog. */
export function piMcpConfigPath(): string {
  return join(piHome(), 'mcp.json');
}

export function skillsRoot(): string {
  // STEM_SKILLS_DIR lets probe/verification scripts and unit tests point at a
  // throwaway folder (and avoids touching Electron's `app` when run outside the
  // app). In the running app this is unset in the main process, so it resolves to
  // the pi-home skills dir; the bridge subprocess is handed the resolved path.
  return process.env.STEM_SKILLS_DIR ?? join(piHome(), 'skills');
}

/** The controlled cwd we spawn the backend in — empty/app-owned. */
export function workspaceRoot(): string {
  return join(userDataRoot(), 'workspace');
}

export function agentsMdPath(): string {
  return join(workspaceRoot(), 'AGENTS.md');
}

/**
 * The persistent "Files" place: a user-facing folder inside the backend cwd where
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
 * chat->folder assignments. Chats themselves are backend threads on disk; this
 * file only holds the organization layer the backend has no concept of.
 */
export function chatStorePath(): string {
  return join(userDataRoot(), 'folders.json');
}

/**
 * Stem-owned registry of external "connected folders" the assistant may read in
 * place (e.g. an Obsidian vault). Holds only absolute paths + per-folder mode and
 * memorize flags — the folders themselves stay where they live on disk.
 */
export function connectedFoldersStorePath(): string {
  return join(userDataRoot(), 'connected-folders.json');
}

/**
 * Gate file the bridge extension reads to enforce read-only connected folders:
 * the absolute paths of folders connected in 'read' mode. Lives next to mcp.json
 * under the pi home so the extension can read it (mtime-cached) like the other
 * per-turn gate files. Rewritten by the main process whenever the registry changes.
 */
export function protectedRootsPath(): string {
  return join(piHome(), 'protected-roots.json');
}

/**
 * Stem-owned registry of scheduled tasks: prompts re-run as autonomous agent turns
 * on a cron/once schedule, each bound to its originating chat. Holds the task
 * definitions plus last/next-run bookkeeping; the runs themselves land in the
 * backend thread like any other turn.
 */
export function tasksStorePath(): string {
  // STEM_TASKS_STORE lets unit tests point at a throwaway file (and avoids touching
  // Electron's `app` when run outside the app), like the other store path helpers.
  return process.env.STEM_TASKS_STORE ?? join(userDataRoot(), 'tasks.json');
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
