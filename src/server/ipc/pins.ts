import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import { addPin, listPins, removePin, reorderPins, updatePin } from '../pins/store';
import { LABEL_TIMEOUT_MS, queuePinLabel, type PinLabelDeps } from '../pins/label';
import { backgroundRunOf } from '../workspace/settings';
import { reindexChatThread } from '../chatsearch/index-sync';
import type { ChatMessage, ChatPin, ChatPinInput, ChatPinPatch } from '../../shared/types';

/**
 * The chat pinboards (server/pins/store.ts). Every mutator answers with the
 * chat's fresh board, the contract the folder mutators use, and pushes
 * `pins:changed` so another window or device looking at the same chat refetches.
 */
export function registerPinsIpc(deps: IpcDeps): void {
  // Every board change: tell clients looking at the chat, and refresh the
  // chat's search entry, which includes its pins.
  const announce = (threadId: string): void => {
    deps.emit('pins:changed', { threadId });
    void reindexChatThread(deps.runtime(), threadId);
  };
  const changed = (threadId: string): ChatPin[] => {
    announce(threadId);
    return listPins(threadId);
  };
  // Labels are written in the background on the quick-tasks model chat subjects
  // use; the board shows the item's first words until one lands.
  const labeller: PinLabelDeps = {
    complete: async (prompt) =>
      deps.runtime().complete(prompt, {
        ...(await backgroundRunOf('subject', (s) => ({ model: s.chats.subjectModel, effort: s.chats.subjectEffort }))),
        timeoutMs: LABEL_TIMEOUT_MS
      }),
    changed: announce
  };

  registerServer('pins:list', (_e, threadId: string) => listPins(threadId));
  registerServer('pins:add', (_e, threadId: string, input: ChatPinInput) => {
    const pin = addPin(threadId, input);
    if (!pin.label) queuePinLabel(threadId, pin.id, labeller);
    return changed(threadId);
  });
  registerServer('pins:update', (_e, threadId: string, pinId: string, patch: ChatPinPatch) => {
    const pin = updatePin(threadId, pinId, patch);
    // A rewritten note loses a model label that no longer fits; so does a label
    // the user cleared. Either way, ask for a fresh one.
    if (!pin.label) queuePinLabel(threadId, pin.id, labeller);
    return changed(threadId);
  });
  registerServer('pins:remove', (_e, threadId: string, pinId: string) => {
    removePin(threadId, pinId);
    return changed(threadId);
  });
  registerServer('pins:reorder', (_e, threadId: string, pinIds: string[]) => {
    reorderPins(threadId, pinIds);
    return changed(threadId);
  });
}

/**
 * The turn anchors a fork ending at `turnId` keeps: every turn id (both the
 * persisted `turnId` and the runtime one) of the messages up to and including
 * that turn. Read from the ORIGINAL thread: a fork's own file is written lazily,
 * and the fork is by definition the original's prefix.
 */
export function forkAnchors(messages: ChatMessage[], turnId: string): Set<string> {
  const last = messages.map((m) => m.turnId === turnId || m.runtimeTurnId === turnId).lastIndexOf(true);
  const anchors = new Set<string>();
  if (last === -1) return anchors;
  for (const m of messages.slice(0, last + 1)) {
    if (m.turnId) anchors.add(m.turnId);
    if (m.runtimeTurnId) anchors.add(m.runtimeTurnId);
  }
  return anchors;
}
