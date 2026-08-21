import { host } from '../host';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MCP_DEVICE_CATALOG_FILE, PROTECTED_ROOTS_FILE } from '../pi/protocol';

// All app state lives under Electron's userData dir, fully isolated from the
// user's global pi config. The backend home and the working dir we launch the
// backend in are both app-owned so no external skills/config can leak in.

export function userDataRoot(): string {
  return host().stateRoot();
}

/** A resolved alternate profile: an isolated userData dir + a human label for it. */
export interface ProfileOverride {
  userDataDir: string;
  label: string;
}

/**
 * Resolve a `--fresh` / `--profile=<name>` (or `STEM_FRESH=1` / `STEM_PROFILE=<name>`)
 * request into an alternate userData directory under a sibling `Stem Profiles/` container,
 * so you can walk the first-run onboarding as a brand-new user without touching the real
 * signed-in profile. Returns null when nothing is requested (the native `--user-data-dir`
 * switch, if any, still applies untouched).
 *
 * Precedence: fresh > named profile > none. Args are injectable so this is unit-testable
 * without Electron and with a deterministic clock.
 */
export function resolveProfileOverride(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  appDataDir: string = host().appDataRoot(),
  now: () => Date = () => new Date()
): ProfileOverride | null {
  const container = join(appDataDir, 'Stem Profiles');
  const hasFlag = (name: string) => argv.includes(`--${name}`);
  const flagValue = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

  if (hasFlag('fresh') || env.STEM_FRESH === '1') {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const label = `fresh-${stamp}`;
    return { userDataDir: join(container, label), label };
  }

  const requested = flagValue('profile') ?? env.STEM_PROFILE;
  if (requested && requested.trim()) {
    // Reduce to a safe basename: no path separators or traversal can escape the container.
    const sanitized = requested.trim().replace(/[^A-Za-z0-9._-]/g, '-');
    // `path.join(container, '..')` still traverses even though `..` contains no
    // separator. Keep dot-only basenames literal by giving them a safe prefix.
    const label = sanitized === '.' || sanitized === '..' ? `profile-${sanitized}` : sanitized;
    return { userDataDir: join(container, label), label };
  }

  return null;
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
  return process.env.STEM_PI_MCP_CONFIG ?? join(piHome(), 'mcp.json');
}

/**
 * Tool catalogs announced by devices hosting their own MCP servers (see
 * server/mcp-device/). Beside mcp.json under the pi home, next to the bridge's
 * own `mcp-catalog.json` (declared in pi/mcp-config.ts, because the bridge
 * writes that one and this process only reads it).
 *
 * Two files rather than one, deliberately: the bridge owns its catalog and
 * rewrites it whenever it reconnects, this one is rewritten on every client
 * announcement, and teaching either to parse the other's format would couple two
 * things whose only relationship is that the same prompt renders both.
 *
 * It survives restarts because that is the point — an unavailable server stays
 * listed and marked rather than vanishing from what the assistant knows it can
 * do (docs/mcp-device-pinning.md, ③).
 */
export function piMcpDeviceCatalogPath(): string {
  return process.env.STEM_MCP_DEVICE_CATALOG ?? join(piHome(), MCP_DEVICE_CATALOG_FILE);
}

/**
 * Which paired computers said they run commands (server/exec-device/router.ts).
 * Survives restarts for the same reason the MCP device catalog does: the
 * assistant should be able to say "your Mac runs commands but is asleep" without
 * waiting for that Mac to reconnect and say so again.
 */
export function execDeviceHostsPath(): string {
  return process.env.STEM_EXEC_DEVICE_HOSTS ?? join(piHome(), 'exec-device-hosts.json');
}

/**
 * Which paired computers said they run coding agents (server/harness/
 * device-host.ts). Survives restarts for the reason its exec sibling does.
 */
export function harnessDeviceHostsPath(): string {
  return process.env.STEM_HARNESS_DEVICE_HOSTS ?? join(piHome(), 'harness-device-hosts.json');
}

/**
 * The safeStorage-wrapped AES key that encrypts MCP secrets at rest (see
 * pi/secrets.ts). The env override lets unit tests use a throwaway key file.
 */
export function secretKeyPath(): string {
  return process.env.STEM_SECRET_KEY_FILE ?? join(piHome(), 'secret.key');
}

/**
 * pi's custom-providers config (models.json) under the isolated pi home. Stem
 * writes local providers (Ollama, LM Studio) here; pi reads it at spawn.
 */
export function piModelsConfigPath(): string {
  return process.env.STEM_PI_MODELS_CONFIG ?? join(piHome(), 'models.json');
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

/**
 * Where pi would pick up a project-instructions file from its cwd. Stem no longer
 * writes one — the instructions go in as --append-system-prompt — so this exists
 * only so bootstrap can delete the copy older installs were seeded with.
 */
export function agentsMdPath(): string {
  return join(workspaceRoot(), 'AGENTS.md');
}

/**
 * Root of the assistant's `run_command` scratch space: an isolated, app-owned
 * folder under the pi home. Commands may target real user paths explicitly (via
 * absolute arguments or an explicit cwd), but by default their side effects land
 * here.
 *
 * A CONTAINER, not a working directory: each chat gets its own folder inside it
 * (see {@link threadWorkspaceDir}) so scratch belongs to the conversation that
 * made it and can be sized, listed and deleted per chat. The root itself is the
 * "unfiled" bucket — where the pile from before per-chat folders still sits, and
 * where a command with no live thread lands.
 */
export function execWorkspaceDir(): string {
  return process.env.STEM_EXEC_WORKSPACE ?? join(piHome(), 'exec-workspace');
}

/**
 * True when `id` is safe to use as a single path segment under the scratch root.
 * pi names its session files by these ids, so in practice they already are; this
 * is the guard that keeps a surprising one from escaping the root, not a
 * formatting step. Anything rejected falls back to the unfiled bucket.
 */
export function isScratchId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return false;
  if (id === '.' || id === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

/** One chat's own scratch folder. Created on demand by the exec service. */
export function threadWorkspaceDir(threadId: string): string {
  return join(execWorkspaceDir(), threadId);
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
 * Where bytes uploaded by a client wait until something uses them (see
 * files/staging.ts). A client whose server is on another machine cannot hand it a
 * path — the path means nothing there — so it streams the file to POST /upload
 * and passes a handle to this directory instead.
 *
 * Deliberately NOT inside workspaceRoot(): the agent's read tools reach anything
 * in its cwd, and an upload the user has not decided to keep is not something the
 * assistant should be able to find by listing a folder. Swept on a TTL.
 */
export function uploadStagingRoot(): string {
  // STEM_UPLOADS_DIR lets unit tests point at a throwaway directory (and avoids
  // touching Electron's `app` when run outside the app), like its neighbours.
  return process.env.STEM_UPLOADS_DIR ?? join(userDataRoot(), 'uploads');
}

/**
 * Server-side mirrors of client-connected folders (folders that live on a paired
 * desktop and sync one-way up; see workspace/connected-folders.ts). One directory
 * per folder id — that directory IS the connected folder's `path`, so everything
 * downstream (indexing, injection, the protected-roots gate) treats it like any
 * other connected folder.
 */
export function mirrorsDir(): string {
  // STEM_MIRRORS_DIR lets unit tests point at a throwaway directory (and avoids
  // touching Electron's `app` when run outside the app), like its neighbours.
  return process.env.STEM_MIRRORS_DIR ?? join(userDataRoot(), 'mirrors');
}

/** The mirror tree of one client-connected folder. */
export function mirrorRoot(folderId: string): string {
  return join(mirrorsDir(), folderId);
}

/**
 * The sync manifest of one client-connected folder: rel → {size, client mtime}
 * as of the last applied sync. A sibling of the mirror tree, deliberately NOT
 * inside it — the agent reads the tree, and the manifest is bookkeeping.
 */
export function mirrorManifestPath(folderId: string): string {
  return join(mirrorsDir(), `${folderId}.manifest.json`);
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
 * Stem-owned inbox store: per-thread read/archive/snooze state for the Chats
 * panel's Inbox mode. Deliberately its own file rather than a section of
 * folders.json — the Inbox is a separate namespace from the chat folder tree
 * (it will grow its own folders), and keeping them apart means a corrupt or
 * hand-edited file only costs one of the two.
 */
export function inboxStorePath(): string {
  // STEM_INBOX_STORE lets unit tests point at a throwaway file, like the other
  // store path helpers.
  return process.env.STEM_INBOX_STORE ?? join(userDataRoot(), 'inbox.json');
}

/**
 * Stem-owned registry of external "connected folders" the assistant may read in
 * place (e.g. an Obsidian vault). Holds only absolute paths + per-folder mode and
 * memorize flags — the folders themselves stay where they live on disk.
 */
export function connectedFoldersStorePath(): string {
  // STEM_CONNECTED_FOLDERS_STORE lets unit tests point at a throwaway file (and
  // avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_CONNECTED_FOLDERS_STORE ?? join(userDataRoot(), 'connected-folders.json');
}

/**
 * Gate file the bridge extension reads to enforce read-only connected folders:
 * the absolute paths of folders connected in 'read' mode. Lives next to mcp.json
 * under the pi home so the extension can read it (mtime-cached) like the other
 * per-turn gate files. Rewritten by the main process whenever the registry changes.
 */
export function protectedRootsPath(): string {
  return join(piHome(), PROTECTED_ROOTS_FILE);
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
 * State dir for the embedded acpx runtime's FileSessionStore: the harness
 * session records (one JSON per external coding-agent session) that let a
 * later coding_agent call resume the same conversation. Server-side runs only;
 * a device hosting its own harness keeps an equivalent dir under its own
 * state root.
 */
export function harnessSessionsDir(): string {
  // STEM_HARNESS_SESSIONS_DIR lets unit tests point at a throwaway directory
  // (and avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_HARNESS_SESSIONS_DIR ?? join(userDataRoot(), 'harness-sessions');
}

/**
 * Stem-owned mapping of (thread, host, agent, cwd) -> harness sessionId, so a
 * repeated coding_agent call continues one conversation. A cache of each
 * host's own session store, not the truth: when a host lost its session, the
 * fresh id from the next ensure simply overwrites the record here.
 */
export function harnessSessionsStorePath(): string {
  return process.env.STEM_HARNESS_SESSIONS_STORE ?? join(userDataRoot(), 'harness-sessions.json');
}

/**
 * Run log for coding_agent turns: one record per harness turn (agent, cwd,
 * status, usage, cost). Bookkeeping for the user's benefit, not state any
 * code path depends on.
 */
export function harnessRunsPath(): string {
  return process.env.STEM_HARNESS_RUNS ?? join(userDataRoot(), 'harness-runs.json');
}

/**
 * Cache dir for the bundled local embedding models (transformers.js `env.cacheDir`).
 * Weights download here once per model on first use; safe to delete — they just
 * re-download on next need.
 */
export function embedModelsDir(): string {
  // STEM_EMBED_MODELS_DIR lets probe/verification scripts point at a throwaway
  // cache (and avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_EMBED_MODELS_DIR ?? join(userDataRoot(), 'embed-models');
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
 * Where this server can be reached: the loopback port it bound, written on every
 * boot. The port is ephemeral by default, so a client that did not start the
 * server itself has no other way to find it — this file is the discovery
 * mechanism, and the device registry beside it is the credential.
 *
 * Not a secret (the token is what gates the socket), so it is written with
 * ordinary permissions.
 */
export function serverEndpointPath(): string {
  return process.env.STEM_SERVER_ENDPOINT_FILE ?? join(userDataRoot(), 'server.json');
}

/**
 * Every device allowed to talk to the transport: its id, label and the SHA-256 of
 * its bearer token (see server/transport/auth.ts). Written 0600. Deliberately NOT
 * in settings.json — settings are read and rewritten wholesale by several code
 * paths, and keeping the registry in its own file makes revoking a device a
 * single atomic write.
 */
export function devicesStorePath(): string {
  // STEM_DEVICES_FILE lets unit tests point at a throwaway file (and avoids
  // touching Electron's `app` when run outside the app), like its neighbours.
  return process.env.STEM_DEVICES_FILE ?? join(userDataRoot(), 'devices.json');
}

/**
 * Outstanding pairing codes, as hashes (see server/transport/pairing.ts). On disk
 * rather than in memory because `stem-server pair` is a second process with no
 * credential to ask the running one with — that file IS the channel between them.
 */
export function pairingStorePath(): string {
  return process.env.STEM_PAIRING_FILE ?? join(userDataRoot(), 'pairing.json');
}


/**
 * The main-process log file (see server/log.ts): pi lifecycle, crash-loop
 * cooldowns, and other diagnostics that would otherwise vanish with the
 * console. Rotated once at ~5MB to `stem.log.1`.
 */
export function logFilePath(): string {
  // STEM_LOG_FILE lets unit tests point at a throwaway file (and avoids touching
  // Electron's `app` when run outside the app).
  return process.env.STEM_LOG_FILE ?? join(userDataRoot(), 'stem.log');
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

/**
 * Local IPC endpoint where main serves query embeddings to the stem-recall MCP
 * server (see recall/embed-endpoint.ts). On POSIX a Unix socket in userData —
 * comfortably under the 104-byte sun_path limit at the default location; the
 * endpoint logs-and-skips if an exotic profile path ever pushes past it. On
 * Windows a named pipe (the filesystem path form doesn't exist there); the
 * userData hash keeps profiles/instances apart. Listen/close skip unlink/chmod
 * for pipes (see recall/embed-endpoint.ts). Verified on Windows as part of the
 * terminal-first port; MCP clients connect with net.connect(pipeName).
 */
export function embedSocketPath(): string {
  if (process.env.STEM_EMBED_SOCK) return process.env.STEM_EMBED_SOCK;
  if (process.platform === 'win32') {
    const id = createHash('sha256').update(userDataRoot()).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\stem-embed-${id}`;
  }
  return join(userDataRoot(), 'stem-embed.sock');
}

/**
 * Per-folder search indexes for indexed connected folders: one SQLite file per
 * folder id, physically separate from recall.sqlite so a huge indexed folder
 * never bloats the hot recall DB and "disconnect" is just deleting one file.
 * The manifest.json inside (written by folder-index/index.ts) tells the
 * stem-recall MCP server which indexes exist without a pi restart.
 */
export function folderIndexDir(): string {
  // STEM_FOLDER_INDEX_DIR lets unit tests point at a throwaway directory (and
  // avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_FOLDER_INDEX_DIR ?? join(userDataRoot(), 'folder-index');
}

/** The index database for one indexed connected folder. */
export function folderIndexDbPath(folderId: string): string {
  return join(folderIndexDir(), `${folderId}.sqlite`);
}

/**
 * Stem-owned chat-search index (FTS5 over every chat's title + messages). Kept in
 * its OWN database, physically separate from recall.sqlite, because "search my own
 * chats" deliberately does NOT obey the AI's memorize/taint rules — you must be able
 * to find a chat even if it was marked don't-remember. Backfilled from the JSONL
 * session files, so its coverage is complete and independent of when recall started.
 */
export function chatSearchDbPath(): string {
  // STEM_CHAT_SEARCH_DB lets probe/verification scripts point at a throwaway database
  // (and avoids touching Electron's `app` when run outside the app).
  return process.env.STEM_CHAT_SEARCH_DB ?? join(userDataRoot(), 'chat_search.sqlite');
}
