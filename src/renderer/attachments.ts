// Turn send-time TurnAttachments into display MessageAttachments for the optimistic
// bubble. Images become inline thumbnails: pasted images already carry base64; on-disk
// images are previewed via the main process (the renderer never holds their bytes).
// Everything else renders as a file chip. Replayed history is rebuilt separately from
// the session JSONL (see runtime.contentToParts).

import type { ChatMessage, MessageAttachment, TurnAttachment } from '../shared/types';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|hif)$/i;

function isHeic(att: TurnAttachment): boolean {
  const mime = att.mime?.toLowerCase() ?? '';
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp') {
    return false;
  }
  if (
    mime === 'image/heic' ||
    mime === 'image/heif' ||
    mime === 'image/heic-sequence' ||
    mime === 'image/heif-sequence'
  ) {
    return true;
  }
  return /\.(heic|heif|hif)$/i.test(att.name || att.path || '');
}

function isImage(att: TurnAttachment): boolean {
  if (att.mime?.toLowerCase().startsWith('image/')) return true;
  return IMAGE_EXT.test(att.name || att.path || '');
}

/**
 * Synchronous attachment shape for the optimistic bubble. On-disk images need an
 * IPC read before their thumbnail is available, so they begin as ordinary chips
 * and are upgraded by `toMessageAttachments()` without delaying the send itself.
 * Pasted HEIC is the same: Chromium cannot paint `image/heic`, so it starts as a
 * chip until the main process has decoded it to JPEG.
 */
export function optimisticMessageAttachments(atts: TurnAttachment[]): MessageAttachment[] {
  return atts.map((att) => {
    if (isImage(att) && att.dataBase64 && !isHeic(att)) {
      const mime = att.mime || 'image/png';
      return { kind: 'image', name: att.name, mime, dataUrl: `data:${mime};base64,${att.dataBase64}` };
    }
    return { kind: 'file', name: att.name };
  });
}

export async function toMessageAttachments(atts: TurnAttachment[]): Promise<MessageAttachment[]> {
  return Promise.all(
    atts.map(async (att): Promise<MessageAttachment> => {
      if (isImage(att)) {
        if (att.dataBase64) {
          if (isHeic(att)) {
            const dataUrl = await window.stem.previewImageData(att.dataBase64, att.mime, att.name);
            if (dataUrl) return { kind: 'image', name: att.name, mime: 'image/jpeg', dataUrl };
          } else {
            const mime = att.mime || 'image/png';
            return { kind: 'image', name: att.name, mime, dataUrl: `data:${mime};base64,${att.dataBase64}` };
          }
        }
        if (att.path) {
          const dataUrl = await window.stem.previewImage(att.path);
          if (dataUrl) {
            const mime = isHeic(att) ? 'image/jpeg' : att.mime || 'image/png';
            return { kind: 'image', name: att.name, mime, dataUrl };
          }
        }
      }
      return { kind: 'file', name: att.name };
    })
  );
}

/** Parse an inline image data URL back into a sendable attachment. */
function attachmentFromDataUrl(att: MessageAttachment): TurnAttachment | null {
  if (att.kind !== 'image' || !att.dataUrl) return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(att.dataUrl);
  if (!match) return null;
  return {
    name: att.name || 'image',
    mime: att.mime || match[1],
    dataBase64: match[2]
  };
}

/**
 * Recover the complete inputs for Retry/Edit. Live messages retain the original
 * paths/base64 in `turnAttachments`; replayed history can reconstruct native pi
 * image blocks from their data URLs. Text-file history already contains the
 * inlined file block in message.content, so there is no second file to attach.
 */
export function resendAttachments(message: ChatMessage): TurnAttachment[] {
  if (message.turnAttachments?.length) return message.turnAttachments.map((att) => ({ ...att }));
  return (message.attachments ?? [])
    .map(attachmentFromDataUrl)
    .filter((att): att is TurnAttachment => att !== null);
}
