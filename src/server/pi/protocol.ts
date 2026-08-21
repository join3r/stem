import type { PiEvent } from './rpc';

// The Stem ⇄ pi side-protocol, in one place.
//
// pi's RPC stream is only half the coupling. The other half is a set of
// conventions shared with the bridge extension (stem-mcp-extension.mjs, which
// runs INSIDE the pi process and cannot import this module):
//
//  - sentinel titles on `extension_ui_request` dialogs the bridge raises so
//    PiRuntime can route them to Stem UI instead of showing a pi dialog;
//  - a JSON payload key on `notify` messages carrying the web-search tee;
//  - mtime-polled JSON gate files under the pi home that main rewrites and the
//    bridge re-reads per turn;
//  - env vars telling the bridge where Stem's config lives.
//
// Every constant here has a hand-written twin in the extension. The drift guard
// in tests/unit/pi-protocol.test.ts parses the extension source and fails if
// either side changes alone — update both together.

/**
 * The exact pi version this protocol was last verified against. package.json
 * pins the dependency to this version, PiRuntime warns at spawn when the
 * resolved pi differs (a system/override pi), and the drift-guard test fails if
 * the pin and this constant fall out of sync. pi's own version check is
 * disabled in the child (PI_SKIP_VERSION_CHECK=1), so this is the only guard:
 * raw-event shapes, hook timing, and extension APIs are all unversioned and
 * have broken on pi minor bumps before.
 */
export const TESTED_PI_VERSION = '0.82.0';

// ---- extension_ui_request sentinel titles ----

/** MCP add/remove approval (`confirm`); the message is a JSON McpAdminProposal. */
export const ADMIN_APPROVAL_TITLE = 'stem-admin-approval';

/**
 * Custom-instructions change approval (`confirm`); the message is a JSON
 * { action, incomingText, surface? } payload.
 */
export const INSTRUCTIONS_APPROVAL_TITLE = 'stem-instructions-approval';

/**
 * Scheduled-task tool round-trip (`input`): schedule_task / notify_user /
 * list_tasks / cancel_task. The op payload rides in `placeholder`; PiRuntime
 * answers with a JSON result string.
 */
export const TASK_BRIDGE_TITLE = 'stem-task-bridge';

/**
 * run_command tool round-trip (`input`): the exec payload (command/cwd/timeout)
 * rides in `placeholder`; PiRuntime routes it to the main-process ExecService
 * (policy tiers + spawn) and answers with a JSON result string.
 */
export const EXEC_BRIDGE_TITLE = 'stem-exec-bridge';

/**
 * Device-located MCP round-trip (`input`): `{ op: 'tools' | 'call', server, tool?,
 * args? }` rides in `placeholder`. PiRuntime resolves which device the server
 * belongs to from mcp.json — never from the payload — and hands the op to the
 * DeviceMcpRouter, which owns the correlation id, the timeouts and the refusal
 * text. Like the exec bridge the answer can be minutes away: the far end is a
 * program running on somebody else's computer.
 */
export const DEVICE_MCP_BRIDGE_TITLE = 'stem-device-mcp-bridge';

/**
 * coding_agent tool round-trip (`input`): the harness payload (agent/prompt/
 * cwd/device/fresh_session) rides in `placeholder`; PiRuntime routes it to the
 * main-process HarnessService (settings gate, session continuity, the blocking
 * harness turn) and answers with a JSON result string. The response can be
 * HOURS away — one external coding-agent turn — and pi holds the elicitation
 * open the whole time (tests/unit/pi-elicitation-hold.test.ts).
 */
export const HARNESS_BRIDGE_TITLE = 'stem-harness-bridge';

/**
 * manage_skill tool round-trip (`input`): the write payload rides in
 * `placeholder`; PiRuntime routes it to the main-process SkillBridge, which owns
 * the contract validator, the Off/Ask/Auto policy, and the approval card. The
 * bridge extension used to write SKILL.md itself with almost no validation —
 * that is why this round-trip exists, and why the answer can take minutes (main
 * may hold it open behind a card).
 */
export const SKILL_BRIDGE_TITLE = 'stem-skill-bridge';

// ---- gate files (basenames under the pi home, mtime-polled by the bridge) ----

/**
 * `{ enabled: boolean }` — are the vendored pi-web-access search tools active this
 * turn? The bridge extension adds/removes them from the session's tool set to match.
 */
export const NATIVE_SEARCH_GATE_FILE = 'native-search.json';
/** `{ tier: string | null }` — OpenAI service_tier for the next request. */
export const SERVICE_TIER_GATE_FILE = 'service-tier.json';
/** `{ roots: string[] }` — absolute roots of read-only connected folders. */
export const PROTECTED_ROOTS_FILE = 'protected-roots.json';
/** OAuth tokens for remote MCP servers, keyed by server name. */
export const MCP_OAUTH_FILE = 'mcp-oauth.json';
/**
 * What each paired device says it is hosting (server/mcp-device/catalog.ts).
 * Main writes it on every announcement; the bridge READS it, which is how a
 * server pinned to a sleeping machine still knows which tools it offers — the
 * whole of ③. Declared here rather than only in workspace/paths.ts because the
 * bridge, which cannot import that module either, opens the same file by name.
 */
export const MCP_DEVICE_CATALOG_FILE = 'mcp-device-catalog.json';
/** Touched by the bridge on any skill write so main reloads at turn end. */
export const SKILLS_REV_FILE = '.skills-rev';

// ---- env vars the bridge reads at load ----

export const ENV_MCP_CONFIG = 'STEM_MCP_CONFIG';
export const ENV_MCP_OAUTH = 'STEM_PI_MCP_OAUTH';
export const ENV_SKILLS_DIR = 'STEM_SKILLS_DIR';
/** Hex AES-256 key for secrets at rest, handed to the pi process at spawn. */
export const ENV_SECRET_KEY = 'STEM_SECRET_KEY';

// ---- secrets at rest (mcp.json fields, mcp-oauth.json) ----

/** Prefix marking one AES-256-GCM-encrypted string: `stemenc:1:<b64(iv|tag|ct)>`. */
export const SECRET_VALUE_PREFIX = 'stemenc:1:';
/** Sole key of an encrypted-envelope JSON document (mcp-oauth.json at rest). */
export const SECRET_ENVELOPE_KEY = '__stemenc__';

// ---- raw-event probing ----

/**
 * The argument object of a raw `tool_execution_start` event. pi's event shape
 * is not formally typed (PiEvent is open) and the args key has moved across
 * versions, so probe the known aliases in order. Single implementation — both
 * the normalizer's activity labels and the memory-taint path check use this.
 */
export function toolArgsOf(ev: PiEvent): Record<string, unknown> | undefined {
  return (ev.toolInput ?? ev.args ?? ev.input ?? ev.arguments ?? ev.params) as
    | Record<string, unknown>
    | undefined;
}
