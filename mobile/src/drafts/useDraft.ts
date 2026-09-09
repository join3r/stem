import { useCallback, useState, useSyncExternalStore } from 'react';
import { useTransport } from '../transport/provider';
import {
  addDraftAttachment,
  beginDraftSend,
  isDraftSending,
  draftGeneration,
  draftErrors,
  clearDraft,
  readDraft,
  removeDraftAttachment,
  subscribeDraft,
  updateDraft
} from './store';

export function useDraft(draftKey: string) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const { pairing } = useTransport();
  const id = JSON.stringify([pairing?.serverUrl ?? '', pairing?.deviceId ?? '', draftKey]);
  const generation = draftGeneration();
  const currentAccount = () => {
    if (generation !== draftGeneration() || !pairing)
      throw new Error('This account is no longer paired.');
  };
  const draft = useSyncExternalStore(
    subscribeDraft,
    useCallback(() => readDraft(id), [id])
  );
  const sending = useSyncExternalStore(
    subscribeDraft,
    useCallback(() => isDraftSending(id), [id])
  );
  return {
    sending,
    beginSend: () => {
      currentAccount();
      return beginDraftSend(id);
    },
    draft,
    ready: !!pairing,
    error: saveError ?? draftErrors.get(id) ?? null,
    setBody: (body: string) => {
      currentAccount();
      updateDraft(id, (current) => ({ ...current, body }));
    },
    setMetadata: (metadata: Record<string, string | boolean>) => {
      try {
        currentAccount();
        updateDraft(id, (current) => ({
          ...current,
          metadata: { ...current.metadata, ...metadata }
        }));
        setSaveError(null);
      } catch {
        setSaveError('Draft details could not be saved. Please try again.');
      }
    },
    addAttachment: async (input: Parameters<typeof addDraftAttachment>[1]) => {
      currentAccount();
      await addDraftAttachment(id, input);
      currentAccount();
    },
    removeAttachment: (attachmentId: string) => {
      currentAccount();
      removeDraftAttachment(id, attachmentId);
    },
    clear: () => clearDraft(id)
  };
}
