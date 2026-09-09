import { fetch as expoFetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import type { TurnAttachment } from '@shared/types';
import type { DraftAttachment } from '../drafts/store';
import { MAX_ATTACHMENT_BYTES } from '../drafts/store';
import type { StoredPairing } from './credentials';

export async function uploadAttachment(pairing: StoredPairing, attachment: DraftAttachment): Promise<TurnAttachment> {
  const file = new File(attachment.uri);
  if (!file.exists) throw new Error(`${attachment.name} is no longer available. Remove it and attach it again.`);
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Each attachment must be 100 MiB or smaller.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await expoFetch(`${pairing.serverUrl}/upload?name=${encodeURIComponent(attachment.name)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${pairing.token}`, 'Content-Type': attachment.mime ?? 'application/octet-stream' },
      // Expo's File.type can be null and overrides an explicit Content-Type.
      // Raw bytes preserve the attachment MIME header (Expo buffers File bodies too).
      body: await file.bytes(), signal: controller.signal, redirect: 'error'
    });
    if (!response.ok) throw new Error(response.status === 413 ? 'This file is too large to upload.' : 'The attachment could not be uploaded. Your draft is saved.');
    const result = await response.json() as {ok?: boolean; result?: {handle?: string}};
    if (!result.ok || typeof result.result?.handle !== 'string' || !result.result.handle.startsWith('stem-upload:')) throw new Error('The server did not confirm the upload. Your draft is saved.');
    return {name: attachment.name, mime: attachment.mime, path: result.result.handle};
  } finally { clearTimeout(timeout); }
}
