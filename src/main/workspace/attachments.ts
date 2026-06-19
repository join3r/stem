// Turns user-attached files/images into Codex `turn/start` input items.
//
// Codex's UserInput supports images natively (`{ type: 'localImage', path }` —
// the app-server reads/encodes the file itself, so any absolute path works) but
// has NO generic file-attachment input. So non-image files are copied into the
// workspace cwd, where the agent's read tools can reach them, and referenced by
// a note appended to the message text.

import { copyFile, mkdir, writeFile, access } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { codexHome } from './paths';
import type { TurnAttachment } from '../../shared/types';

/** A Codex v2 UserInput item we know how to emit. */
type InputItem = { type: 'localImage'; path: string };

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic']);

function isImage(a: TurnAttachment): boolean {
  if (a.mime?.startsWith('image/')) return true;
  return IMAGE_EXTS.has(extname(a.name).toLowerCase());
}

/** A monotonic suffix so two pastes in the same millisecond don't collide. */
let seq = 0;

/** Return `dest` (or a numbered sibling) that does not yet exist in `dir`. */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let i = 0; ; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    try {
      await access(candidate);
    } catch {
      return candidate; // doesn't exist
    }
  }
}

export interface IngestedAttachments {
  imageItems: InputItem[];
  /** Note to append to the message text listing non-image files (or ''). */
  textNote: string;
}

export async function ingestAttachments(
  attachments: TurnAttachment[],
  workspaceRoot: string
): Promise<IngestedAttachments> {
  const imageItems: InputItem[] = [];
  const fileNotes: string[] = [];

  for (const att of attachments) {
    if (isImage(att)) {
      if (att.path) {
        imageItems.push({ type: 'localImage', path: att.path });
      } else if (att.dataBase64) {
        const dir = join(codexHome(), 'uploads');
        await mkdir(dir, { recursive: true });
        const ext = extname(att.name) || '.png';
        const dest = join(dir, `paste-${Date.now()}-${seq++}${ext}`);
        await writeFile(dest, Buffer.from(att.dataBase64, 'base64'));
        imageItems.push({ type: 'localImage', path: dest });
      }
    } else {
      const dir = join(workspaceRoot, 'attachments');
      await mkdir(dir, { recursive: true });
      const dest = await uniquePath(dir, att.name || `file-${Date.now()}-${seq++}`);
      if (att.path) {
        await copyFile(att.path, dest);
      } else if (att.dataBase64) {
        await writeFile(dest, Buffer.from(att.dataBase64, 'base64'));
      } else {
        continue;
      }
      fileNotes.push(`attachments/${basename(dest)}`);
    }
  }

  const textNote = fileNotes.length ? `\n\n[Attached files: ${fileNotes.join(', ')}]` : '';
  return { imageItems, textNote };
}
