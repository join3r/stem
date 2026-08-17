import { log } from '../log';

// The server's handler registry, and the structural validation every call into
// it passes through. registerServer records a channel; dispatchLocal invokes one,
// checking its arguments against the per-channel spec below (arity + shallow
// types) first. TypeScript types vanish at this boundary: a compromised or
// confused client can invoke any channel with anything, so the server re-checks.
// Handlers keep validating domain rules; this layer only rejects calls that are
// structurally not the API.
//
// The registry IS the surface: a channel registered here is one any authenticated
// client may call. There is no per-caller narrowing on top of it and no table of
// who-may-call-what: authentication is the whole authorization decision, made
// once at the transport (see transport/auth.ts).
//
// The Electron half of this — binding each registered channel to ipcMain and
// checking that the sender really is one of our own renderer frames — lives in
// src/desktop/ipc-bridge.ts, which learns the channel list from the server over
// GET /channels rather than reading this map. It has to: the server has no
// windows to trust, on a headless host there is no ipcMain to bind to, and the
// desktop may not be in the same process as this file at all.

export interface ArgSpec {
  label: string;
  ok: (v: unknown) => boolean;
  optional?: boolean;
}

const spec = (label: string, ok: (v: unknown) => boolean): ArgSpec => ({ label, ok });

export const a = {
  string: spec('a string', (v) => typeof v === 'string'),
  number: spec('a finite number', (v) => typeof v === 'number' && Number.isFinite(v)),
  boolean: spec('a boolean', (v) => typeof v === 'boolean'),
  /** A plain object payload (StartTurnInput, settings patches, …); shallow check. */
  object: spec('an object', (v) => !!v && typeof v === 'object' && !Array.isArray(v)),
  stringArray: spec('an array of strings', (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')),
  /** Approval ids arrive as the bridge's string id or a numeric card id. */
  id: spec('a string or number id', (v) => typeof v === 'string' || typeof v === 'number'),
  oneOf: (values: readonly string[]): ArgSpec =>
    spec(`one of ${values.join('|')}`, (v) => typeof v === 'string' && values.includes(v)),
  /** Also accepts null/undefined (renderer state that may legitimately be empty). */
  nullish: (s: ArgSpec): ArgSpec => ({ ...s, label: `${s.label} or null`, ok: (v) => v == null || s.ok(v) }),
  /** May be omitted entirely (trailing optional parameter). */
  optional: (s: ArgSpec): ArgSpec => ({ ...s, optional: true })
};

/**
 * Expected argument shapes per channel. A channel absent from this table takes
 * NO arguments — that is the default contract, not a gap; every argument a
 * handler reads must be declared here or the call is rejected.
 */
const IPC_ARGS: Record<string, ArgSpec[]> = {
  'auth:providerLogin': [a.string],
  'auth:setApiKey': [a.string, a.string],
  'auth:respond': [a.string, a.string],
  // The redirect the callback was addressed to, and the query the browser
  // brought with it — whatever the provider put there, checked in the handler.
  'auth:deliverCallback': [a.string, a.object],
  'auth:check': [a.string],
  // baseUrl, apiKey?, api? — api is undefined for auto-detect.
  'providers:testLocal': [
    a.string,
    a.string,
    a.optional(a.nullish(a.string)),
    a.optional(a.nullish(a.oneOf(['openai-completions', 'anthropic-messages'])))
  ],
  'providers:previewPiModels': [a.object],
  'providers:copyPiModels': [a.object, a.string, a.optional(a.object)],
  'providers:updateLocal': [a.string, a.object],
  'providers:disconnect': [a.string],
  'backend:startTurn': [a.object],
  'backend:interruptTurn': [a.string],
  'backend:createThread': [a.optional(a.nullish(a.string))],
  'skills:setEnabled': [a.string, a.boolean],
  'skills:remove': [a.string],
  'files:add': [a.stringArray, a.optional(a.nullish(a.string))],
  'files:remove': [a.string],
  'files:mkdir': [a.string],
  'files:rmdir': [a.string],
  'cfolders:browse': [a.optional(a.nullish(a.string))],
  'cfolders:add': [a.stringArray],
  'cfolders:update': [a.string, a.object],
  'cfolders:remove': [a.string],
  'cfolders:forgetFacts': [a.string],
  'tasks:setEnabled': [a.string, a.boolean],
  'tasks:threadSettings': [a.string],
  'tasks:runNow': [a.string],
  'tasks:delete': [a.string],
  'tasks:updateSchedule': [a.string, a.object],
  'mcp:add': [a.object],
  'mcp:remove': [a.string],
  'mcp:setEnabled': [a.string, a.boolean],
  // The device id, or null for "the machine hosting stem-server". Whether that
  // id names a paired desktop is decided in pi/mcp.ts, where the registry is.
  'mcp:setLocation': [a.string, a.nullish(a.string)],
  'mcp:login': [a.string],
  'mcp:adminDecision': [a.id, a.boolean],
  // The MCP host channels. No device id on any of them: the caller IS the
  // device, the transport already knows which one, and taking it as an argument
  // would let one paired machine claim another's servers, credentials and
  // answers. ('mcpHost:hello' takes no arguments at all, so it is absent.)
  //
  // The shapes below are as far as a structural check goes — an announcement is
  // a tree of names and descriptions that ends up in a prompt, and a result is
  // whatever an MCP server returned. Both are bounded and reshaped where they
  // land (see mcp-device/catalog.ts and the router's asResult), because that is
  // where there is enough context to say what they may contain.
  'mcpHost:announce': [a.object],
  'mcpHost:result': [a.string, a.object],
  // The exec host channels follow the mcpHost rule exactly: no device id, the
  // caller is the device. The announcement and result are reshaped where they
  // land (exec-device/router.ts asAnnouncement/asResult).
  'execHost:announce': [a.object],
  'execHost:result': [a.string, a.object],
  'instructions:resolveApproval': [a.id, a.boolean, a.oneOf(['main', 'quickChat']), a.string],
  'skills:resolveApproval': [a.id, a.boolean, a.nullish(a.object)],
  'skills:reset': [a.boolean, a.oneOf(['off', 'ask', 'auto'])],
  'skills:learn': [a.string, a.nullish(a.string)],
  'memory:setEnabled': [a.boolean],
  'memory:addNote': [a.string],
  'memory:forget': [a.number],
  'memory:setPinned': [a.number, a.boolean],
  'memory:confirmFact': [a.number],
  'memory:factDetails': [a.number],
  'memory:resolveConflict': [a.number, a.oneOf(['keep_newer', 'keep_older', 'keep_both'])],
  'memory:restoreFact': [a.number],
  'memory:deleteSummary': [a.number],
  'memory:activeFacts': [a.nullish(a.string)],
  'memory:previewFacts': [a.string],
  'memory:setEpisodicLimit': [a.number],
  'memory:setTidyThreshold': [a.number],
  'memory:setMaxRelevantFacts': [a.number],
  'chats:searchFast': [a.string],
  'chats:search': [a.string],
  'chats:open': [a.string],
  'chats:history': [a.string],
  'chats:rollbackToTurn': [a.string, a.string],
  'chats:forkThread': [a.string, a.string],
  'chats:rename': [a.string, a.string],
  'chats:delete': [a.string],
  'chats:setFolder': [a.string, a.nullish(a.string)],
  'chats:writeSubject': [a.string],
  // Inbox mutators take a list of thread ids so bulk selection and a single row
  // are one code path. ('inbox:markAllRead' takes no arguments, so it is absent.)
  'inbox:setArchived': [a.stringArray, a.boolean],
  'inbox:snooze': [a.stringArray, a.nullish(a.number)],
  'inbox:setRead': [a.stringArray, a.boolean],
  'folders:create': [a.string, a.nullish(a.string)],
  'folders:rename': [a.string, a.string],
  'folders:delete': [a.string],
  'folders:move': [a.string, a.nullish(a.string)],
  'devices:revoke': [a.string],
  'devices:createPairingCode': [a.string],
  // The APNs token, and the push network it belongs to. No device id: the caller
  // is the device, and the transport already knows which one (see Caller below).
  'devices:registerPush': [a.string, a.optional(a.oneOf(['ios']))],
  // How long the caller's machine has been idle. Declared, and required, because
  // the argument is what makes the heartbeat readable in a log and leaves room to
  // act on it later — the handler does not read it today, and the contract says
  // it never has to (see ipc/devices.ts).
  'devices:presence': [a.number],
  'settings:updateQuickChat': [a.object],
  'settings:updateWebSearch': [a.object],
  'settings:updateEscapeAction': [a.oneOf(['off', 'single', 'twoStage'])],
  'settings:updateMemory': [a.object],
  'settings:updateSkills': [a.object],
  'settings:updateChats': [a.object],
  'settings:updateDefaults': [a.object],
  'settings:updateTasks': [a.object],
  'settings:updateExec': [a.object],
  'exec:resolveApproval': [a.string, a.oneOf(['allowOnce', 'alwaysAllow', 'deny'])],
  // A thread id or the literal 'unfiled'. The handler validates the id shape
  // itself before it reaches a path (see workspace/paths.ts isScratchId).
  'exec:clearScratch': [a.string],
  'settings:updateCustomInstructions': [a.object],
  'settings:updateRetrieval': [a.object],
  'settings:testRetrieval': [a.oneOf(['embeddings', 'reranker'])]
};

/** The declared argument shapes for `channel` (empty = the channel takes none). */
export function ipcArgSpecs(channel: string): ArgSpec[] {
  return IPC_ARGS[channel] ?? [];
}

/** Why `args` don't fit `specs`, or null when they do. */
export function argsProblem(specs: ArgSpec[], args: unknown[]): string | null {
  if (args.length > specs.length) return `expected at most ${specs.length} argument(s), got ${args.length}`;
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const v = args[i];
    if (v === undefined && s.optional) continue;
    if (!s.ok(v)) return `argument ${i + 1} must be ${s.label}`;
  }
  return null;
}

// ---- the registry ----
//
// Every caller reaches a handler the same way: through dispatchLocal. Every caller
// is now literally the same caller — the transport, answering a POST /rpc over
// loopback — so there is no BrowserWindow, no frame, and nothing that could be an
// Electron event, whether the request came from a paired laptop across the
// internet or from the Electron app in this very process. One registry, the SAME
// per-channel argument validation, the SAME handler.
//
// The first parameter is what used to be Electron's IpcMainInvokeEvent. For years
// it was always `undefined`, and it survived typed as that nothing precisely so a
// handler that reached for a sender would have to acknowledge the server does not
// have one. `devices:registerPush` is the first handler that genuinely needs to
// know which device is calling — a push token belongs to the device that offered
// it and to no other — so the parameter now carries the identity the transport
// already resolved from the bearer token, and nothing else.
//
// It is a NARROW thing on purpose. It is not an authorization input: the registry
// is still the whole surface, every authenticated device may still call every
// channel, and no handler is allowed to start deciding what a caller may do from
// it (see the header comment). It is an argument the caller cannot forge — which
// is the entire reason it is not simply a deviceId parameter on the channel.
// A handler that needs it must cope with it being absent, because the desktop
// binds these same handlers to its own client-owned channels with no device on
// the other end (src/desktop/ipc-bridge.ts).

/** The device a call arrived from, as the transport authenticated it. */
export interface Caller {
  /** The registry id from devices.json — never the token. */
  deviceId: string;
}

/**
 * The first parameter of every registered handler: who is calling, when anyone
 * knows. Undefined for a call that did not come over the transport. See above.
 */
export type CallerContext = Caller | undefined;

/** A registered invoke handler, viewed without knowing its argument types. */
type LocalHandler = (event: CallerContext, ...args: unknown[]) => unknown;

const localHandlers = new Map<string, LocalHandler>();

/**
 * Record a channel the server answers. Nothing is bound to a transport here —
 * the desktop binds the registry to ipcMain (src/desktop/ipc-bridge.ts), and the
 * transport dispatches into it on behalf of whoever posted to /rpc.
 */
export function registerServer(
  channel: string,
  handler: (event: CallerContext, ...args: never[]) => unknown
): void {
  localHandlers.set(channel, handler as LocalHandler);
}

/** Every channel registered so far — the server's whole callable surface. */
export function serverChannels(): string[] {
  return [...localHandlers.keys()];
}

/** Whether `channel` has a handler registered, i.e. dispatchLocal can run it. */
export function hasLocalHandler(channel: string): boolean {
  return localHandlers.has(channel);
}

/**
 * Invoke a registered channel: argument validation first, then the handler.
 * Rejects when the channel has no handler or the arguments don't fit.
 *
 * `caller` is the transport's answer to "whose token was this", passed through
 * untouched. Omitting it is not a way to call as somebody else — nothing here
 * reads it — it is what an in-process caller with no device honestly has.
 */
export async function dispatchLocal(channel: string, args: unknown[], caller?: Caller): Promise<unknown> {
  const handler = localHandlers.get(channel);
  if (!handler) throw new Error(`Rejected local call to ${channel}: no handler registered.`);
  const problem = argsProblem(IPC_ARGS[channel] ?? [], args);
  if (problem) {
    log('ipc', `rejected local ${channel}`, { problem });
    throw new Error(`Rejected local call to ${channel}: ${problem}.`);
  }
  return handler(caller, ...args);
}
