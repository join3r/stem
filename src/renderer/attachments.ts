// Turn send-time TurnAttachments into display MessageAttachments for the optimistic
// bubble. Images become inline thumbnails: pasted images already carry base64; on-disk
// images are previewed via the main process (the renderer never holds their bytes).
// Everything else renders as a file chip. Replayed history is rebuilt separately from
// the session JSONL (see runtime.contentToParts).

import type { MessageAttachment, TurnAttachment } from '../shared/types';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function isImage(att: TurnAttachment): boolean {
  if (att.mime?.toLowerCase().startsWith('image/')) return true;
  return IMAGE_EXT.test(att.name || att.path || '');
}

export async function toMessageAttachments(atts: TurnAttachment[]): Promise<MessageAttachment[]> {
  return Promise.all(
    atts.map(async (att): Promise<MessageAttachment> => {
      if (isImage(att)) {
        const mime = att.mime || 'image/png';
        if (att.dataBase64) {
          return { kind: 'image', name: att.name, mime, dataUrl: `data:${mime};base64,${att.dataBase64}` };
        }
        if (att.path) {
          const dataUrl = await window.stem.previewImage(att.path);
          if (dataUrl) return { kind: 'image', name: att.name, mime, dataUrl };
        }
      }
      return { kind: 'file', name: att.name };
    })
  );
}
