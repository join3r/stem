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
export const TESTED_PI_VERSION = '1.6.0';

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
 * list_tasks / update_task / cancel_task. The op payload rides in `placeholder`; PiRuntime
 * answers with a JSON result string.
 */
export const TASK_BRIDGE_TITLE = 'stem-task-bridge';

/**
 * Mail tool round-trip (`input`): send_mail / spawn_agent. The op payload rides
 * in `placeholder`; PiRuntime resolves WHICH conversation and persona is
 * calling from the worker's live turn — never from the payload — and routes the
 * op to the MailRouter, answering with a JSON result string.
 */
export const MAIL_BRIDGE_TITLE = 'stem-mail-bridge';

/**
 * run_command tool round-trip (`input`): the exec payload (command/cwd/timeout)
 * rides in `placeholder`; PiRuntime routes it to the main-process ExecService
 * (policy tiers + spawn) and answers with a JSON result string.
 */
export const EXEC_BRIDGE_TITLE = 'stem-exec-bridge';

/**
 * save_file tool round-trip (`input`): `{ files: [{ from, to }] }` rides in
 * `placeholder`; PiRuntime saves them (files/save-file.ts) for the live turn's
 * thread and answers with a JSON result string.
 */
export const SAVE_BRIDGE_TITLE = 'stem-save-bridge';

/**
 * share_audio tool round-trip (`input`): `{ from, title? }` rides in
 * `placeholder`; PiRuntime copies the sound into the chat's audio store
 * (files/chat-audio.ts) for the live turn's thread and answers
 * `{ ok, audio, text }` or `{ ok: false, error }`.
 */
export const AUDIO_BRIDGE_TITLE = 'stem-audio-bridge';

/**
 * generate_image file-reference round-trip (`input`): `{ refs: string[] }`
 * rides in `placeholder` — the references the session itself could not
 * resolve (files, or `img_…` ids mailed in from another thread). PiRuntime
 * reads them (files/image-refs.ts) for the live turn's thread and answers
 * `{ ok, images: [{ ref, mimeType, data }] }` or `{ ok: false, error }`.
 */
export const IMAGE_REF_BRIDGE_TITLE = 'stem-image-ref-bridge';

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
 * `computer` tool round-trip (`input`): one screen action rides in
 * `placeholder`; PiRuntime resolves the Mac from the persona's computer pin
 * (never from the payload), sends it through the computer-device router and
 * answers with a JSON result carrying the screenshot.
 */
export const COMPUTER_BRIDGE_TITLE = 'stem-computer-bridge';

/**
 * `browser` tool round-trip (`input`): one browser action rides in
 * `placeholder`; PiRuntime resolves the Mac from the turn's browser grant (never
 * from the payload) and sends it through the browser-device router.
 */
export const BROWSER_BRIDGE_TITLE = 'stem-browser-bridge';

/**
 * manage_skill tool round-trip (`input`): the write payload rides in
 * `placeholder`; PiRuntime routes it to the main-process SkillBridge, which owns
 * the contract validator, the Off/Ask/Auto policy, and the approval card. The
 * bridge extension used to write SKILL.md itself with almost no validation —
 * that is why this round-trip exists, and why the answer can take minutes (main
 * may hold it open behind a card).
 */
export const SKILL_BRIDGE_TITLE = 'stem-skill-bridge';

/**
 * `read` on a PDF (`input`): `{ op: 'pdf_text', path }` rides in `placeholder`,
 * sent by the bridge's tool_result hook after pi's own read returned the raw
 * bytes. PiRuntime answers with the extracted text layer (see pdf-read.ts).
 */
export const FILE_BRIDGE_TITLE = 'stem-file-bridge';

/**
 * read_past_chat (`input`): `{ threadId, offset?, images? }` rides in
 * `placeholder`. PiRuntime answers with the transcript page and the user's
 * pictures from that chat (see past-chat.ts), gated like the recall searches.
 */
export const CHAT_BRIDGE_TITLE = 'stem-chat-bridge';

// ---- gate files (basenames under the pi home, mtime-polled by the bridge) ----

/**
 * `{ enabled: boolean }` — are the vendored pi-web-access search tools active this
 * turn? The bridge extension adds/removes them from the session's tool set to match.
 */
export const NATIVE_SEARCH_GATE_FILE = 'native-search.json';
/** `{ tier: string | null }` — OpenAI service_tier for the next request. */
export const SERVICE_TIER_GATE_FILE = 'service-tier.json';
/**
 * `{ mail: boolean, scheduled: boolean }` — is this turn a mail delivery or an
 * autonomous scheduled run? The bridge's approval-raising tools read it to
 * propose by reply instead of raising a card nobody is watching.
 */
export const TURN_CONTEXT_GATE_FILE = 'turn-context.json';
/**
 * `{ turnId, skills: [{ slug, tools, text }] }` — skills to hand over when this
 * turn first calls a tool they govern (skills/inject.ts toolSkillsForTurn).
 * Rewritten before every prompt, empty when there are none.
 */
export const TOOL_SKILLS_GATE_FILE = 'tool-skills.json';
/**
 * Opening tag of a skill handed over at a tool call (the held-back call's
 * result). The `trigger` attribute names the skill by slug: settle credits it
 * from the trace (skills/inject.ts toolSkillsHandedOver), and normalize.ts
 * shows the held call as a skill hold rather than a failure.
 */
export const TOOL_SKILL_MARKER = '<stem_skills version="1" trigger="';
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
/** Where add_mcp_server tells the model to install a server it built (workspace/paths.ts mcpInstallRoot). */
export const ENV_MCP_INSTALL_ROOT = 'STEM_MCP_INSTALL_ROOT';
/** JSON [{ root, kind }]: folders a server may not live in (pi/mcp-install-paths.mjs). */
export const ENV_MCP_SHORT_LIVED_ROOTS = 'STEM_MCP_SHORT_LIVED_ROOTS';
/**
 * Directory this process's PER-TURN gate files live in (native-search.json /
 * service-tier.json, plus the active-tools.json diagnostic). Each worker of the
 * runtime pool gets its own so concurrent turns on different processes can't
 * clobber each other's web-search/tier setting; the bridge falls back to the
 * mcp.json directory when unset (single-process spawns, older mains).
 */
export const ENV_GATE_DIR = 'STEM_GATE_DIR';
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
