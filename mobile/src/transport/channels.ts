// Which channels the phone calls, typed by the SAME declarations the desktop
// renderer is typed by.
//
// `StemApi` (src/shared/types.ts) is the client contract: one method per thing a
// client may ask for, with the argument and answer types the server actually
// produces. The desktop reaches it through a preload bridge that maps a method
// name to a channel string; the phone has no preload, so the mapping is this
// table — channel string on the left, the StemApi method whose signature it
// carries on the right.
//
// The value of writing it down this way rather than as hand-copied types is that
// the phone cannot drift. Rename a field on ChatSummary and this file's callers
// stop compiling on the same commit that changed it, which is the only kind of
// contract that survives a codebase with two clients in it.
//
// Small on purpose: it carries what the screens that exist actually call.
// Adding one is a line here naming its StemApi method — never a new type. The
// single exception is at the bottom, and it earns its exception by being a
// channel a desktop renderer is structurally unable to call.

import type { StemApi } from '@shared/types';

export interface ChannelSignatures {
  /** All chats, their folders, and the Inbox state that goes with them. */
  'chats:list': StemApi['listChats'];
  /** One thread's transcript. */
  'chats:open': StemApi['openChat'];
  /**
   * The same transcript, without the backend pre-warm the open does — what the
   * offline cache's catch-up run walks a list with (../offline/cache.ts). Its
   * signature IS openChat's; there is no separate StemApi method because no
   * renderer calls it, the desktop reaching it from inside its proxy for the same
   * reason this does.
   */
  'chats:history': StemApi['openChat'];

  // Writing. `backend:startTurn` is the only channel on the phone that causes a
  // model to be paid for, which is why the composer gates it on the connection
  // being live rather than merely paired.
  'backend:startTurn': StemApi['startTurn'];
  'backend:interruptTurn': StemApi['interruptTurn'];
  /** What models exist — the Settings model rows are pickers over this list. */
  'backend:listModels': StemApi['listModels'];

  // Inbox triage. Every mutator returns the fresh ChatListResult, so the list
  // screen replaces its state with the answer instead of re-fetching.
  'inbox:setArchived': StemApi['setInboxArchived'];
  'inbox:snooze': StemApi['snoozeChats'];
  'inbox:setRead': StemApi['setInboxRead'];
  'inbox:markAllRead': StemApi['markInboxAllRead'];

  // Approvals. The requests arrive as pushes (see ../approvals/queue.ts); these
  // are the four ways to answer one. Each holds a backend tool call open until
  // some client calls it, which is why the phone can answer at all — the desk
  // does not have to be the one to say yes.
  'exec:resolveApproval': StemApi['respondExecApproval'];
  'mcp:adminDecision': StemApi['respondMcpAdminApproval'];
  'instructions:resolveApproval': StemApi['respondInstructionsApproval'];
  'skills:resolveApproval': StemApi['respondSkillApproval'];

  // Settings. `settings:get` came first, for the approvals card (an `append`
  // instructions proposal resolves against the current text). The write
  // channels arrived with the Settings tab: the same registry-backed rows the
  // desktop offers, edited from the phone. Each returns the full saved
  // settings, so the screen replaces its state with the server's answer.
  'settings:get': StemApi['getSettings'];
  'settings:updateWebSearch': StemApi['updateWebSearch'];
  'settings:updateChats': StemApi['updateChatsSettings'];
  'settings:updateTasks': StemApi['updateTasksSettings'];
  'settings:updateExec': StemApi['updateExecSettings'];
  'settings:updateHarness': StemApi['updateHarnessSettings'];
  'settings:updateSkills': StemApi['updateSkillsSettings'];
  'settings:updateQuickChat': StemApi['updateQuickChat'];
  'settings:updateEscapeAction': StemApi['updateEscapeAction'];
  'settings:updateDefaults': StemApi['updateDefaults'];
  'settings:updateMemory': StemApi['updateMemorySettings'];

  /**
   * "Wake THIS device at this APNs token." The one channel in this table with a
   * hand-written signature, because it is the one channel no desktop renderer can
   * call: the server reads the caller's device record to decide whose token it is
   * (src/server/ipc/devices.ts), and an Electron window calling over ipcMain has
   * no device record at all — it is refused by name there. So there is no StemApi
   * method to point at, and inventing one would put a method on the desktop's
   * client contract that the desktop must never call.
   */
  'devices:registerPush': (token: string, platform?: 'ios') => Promise<void>;

  /**
   * "Forget this phone." Called with the phone's OWN device id and nowhere else
   * — unpairing is the one thing a client may do to the registry, and it does it
   * to itself (../transport/unpair.ts). The desk is where devices are managed;
   * this app has no Devices screen and is not going to grow one.
   */
  'devices:revoke': StemApi['revokeDevice'];
}

export type ChannelName = keyof ChannelSignatures;
export type ChannelArgs<C extends ChannelName> = Parameters<ChannelSignatures[C]>;
export type ChannelResult<C extends ChannelName> = Awaited<ReturnType<ChannelSignatures[C]>>;
