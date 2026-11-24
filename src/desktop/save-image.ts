import { app } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, basename, join } from 'node:path';

/**
 * Where a downloaded file lands. STEM_DOWNLOADS_DIR keeps a test run out of the
 * real Downloads folder; everywhere else this is the OS's own answer.
 */
export function downloadsDir(): string {
  return process.env.STEM_DOWNLOADS_DIR?.trim() || app.getPath('downloads');
}

/** A short file name from an image's prompt or alt text: its first six words. */
export function imageFileBase(hint: string | undefined): string {
  const words = (hint ?? '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ');
  return (words || 'Stem image').slice(0, 80);
}

/**
 * Write an image data URL straight into Downloads, next to (never over) a file
 * of the same name. Answers the path it landed at. Only image data URLs pass.
 */
export async function saveImageToDownloads(dataUrl: string, hint?: string): Promise<string> {
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error('Not an image.');
  return writeNextTo(`.${m[2] === 'jpeg' ? 'jpg' : m[2]}`, imageFileBase(hint), Buffer.from(m[3], 'base64'));
}

const AUDIO_EXT: Record<string, string> = {
  mpeg: '.mp3',
  mp4: '.m4a',
  aac: '.aac',
  wav: '.wav',
  ogg: '.ogg',
  flac: '.flac',
  webm: '.webm'
};

/** Write a sound data URL (share_audio) into Downloads, like saveImageToDownloads. */
export async function saveAudioToDownloads(dataUrl: string, hint?: string): Promise<string> {
  const m = /^data:audio\/([a-z0-9]+);base64,(.+)$/s.exec(dataUrl);
  const ext = m ? AUDIO_EXT[m[1]] : undefined;
  if (!m || !ext) throw new Error('Not a sound file.');
  return writeNextTo(ext, imageFileBase(hint || 'Stem audio'), Buffer.from(m[2], 'base64'));
}

async function writeNextTo(ext: string, base: string, bytes: Buffer): Promise<string> {
  const dir = downloadsDir();
  await mkdir(dir, { recursive: true });
  const name = basename(`${base}${ext}`);
  const stem = basename(name, extname(name));
  for (let i = 0; ; i++) {
    const path = join(dir, i === 0 ? name : `${stem} ${i + 1}${ext}`);
    try {
      await writeFile(path, bytes, { flag: 'wx' });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
}
