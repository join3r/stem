import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isScratchId, userDataRoot } from '../workspace/paths';
import { resolveUploadSources, MAX_UPLOAD_FILE_BYTES, type BrowserSourceDeps } from './browser-sources';
import type { ChatAudioRef } from '../../shared/types';
import { CHAT_AUDIO_ID, cleanAudioTitle } from '../pi/normalize';

// Sounds the assistant puts in a chat (share_audio): a clip it cut from a
// podcast, a recording a script made. The chat shows a player card for each,
// the way it shows a picture generate_image made.
//
// Pictures keep their bytes in the session file, because the model sees them.
// Sounds do not go to the model, and megabytes of base64 in a session file make
// every history read slow. So each sound is a COPY in Stem's private store,
// outside the folders the assistant can write: a script that changes the source
// file later does not change what the chat plays.
//
// Layout: <state>/chat-audio/<threadId>/<aud_id><ext> + <aud_id>.json (the ref).

/** One sound in a chat. A longer recording is not a chat-sized job. */
export const MAX_CHAT_AUDIO_BYTES = MAX_UPLOAD_FILE_BYTES;


export function chatAudioRoot(): string {
  return process.env.STEM_CHAT_AUDIO_DIR ?? join(userDataRoot(), 'chat-audio');
}

function threadDir(threadId: string): string | null {
  return isScratchId(threadId) ? join(chatAudioRoot(), threadId) : null;
}

/** Every format the store keeps, with the extension its file gets. */
export const CHAT_AUDIO_EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/webm': '.webm'
};

/** The audio format by its first bytes; null for anything that is not a sound file the chat can play. */
export function sniffAudioMime(b: Buffer): string | null {
  const ascii = (from: number, to: number) => (b.length >= to ? b.toString('ascii', from, to) : '');
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(4, 8) === 'ftyp') {
    // MP4 boxes hold video too; only the audio brands pass.
    const brand = ascii(8, 12);
    return /^(M4A |M4B |mp42|isom|iso[2-6]|dash)$/.test(brand) ? 'audio/mp4' : null;
  }
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) {
    // A frame sync: layer bits 00 is ADTS AAC, anything else is MPEG audio.
    return (b[1]! & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  }
  return null;
}


export type ShareAudioResult = { ok: true; audio: ChatAudioRef; text: string } | { ok: false; error: string };

/**
 * Copy one sound file Stem holds (scratch, `files/…`, a connected folder) into
 * the chat's audio store and answer its ref. The source is read through the
 * same checked snapshot a browser upload uses (files/browser-sources.ts).
 */
export async function shareAudio(
  threadId: string,
  input: { from?: unknown; title?: unknown },
  deps: BrowserSourceDeps
): Promise<ShareAudioResult> {
  const dir = threadDir(threadId);
  if (!dir) return { ok: false, error: 'This conversation cannot hold sounds.' };
  const from = typeof input.from === 'string' ? input.from.trim() : '';
  if (!from) return { ok: false, error: 'Pass `from`: the sound file, for example a path in your scratch folder.' };
  const src = await resolveUploadSources(threadId, [from], deps);
  if (!src.ok) return { ok: false, error: src.error.replace(/\bupload(ed)?\b/g, (_m, ed) => (ed ? 'shared' : 'share')) };
  const file = src.files[0]!;
  try {
    if (file.size > MAX_CHAT_AUDIO_BYTES) {
      return { ok: false, error: `“${from}” is larger than ${MAX_CHAT_AUDIO_BYTES / 1024 / 1024} MB; cut it shorter or encode it at a lower bitrate first.` };
    }
    const head = Buffer.alloc(16);
    const fh = await open(file.path, 'r');
    try {
      await fh.read(head, 0, 16, 0);
    } finally {
      await fh.close();
    }
    const mime = sniffAudioMime(head);
    if (!mime) {
      return {
        ok: false,
        error: `“${from}” is not an audio file the chat can play (MP3, M4A/AAC, WAV, OGG/Opus, FLAC or WebM). Convert it first, for example with ffmpeg.`
      };
    }
    const audio = await storeChatAudio(threadId, mime, file.size, input.title, (dest) => copyFile(file.path, dest));
    const title = audio.title;
    return { ok: true, audio, text: `The chat now shows a player for “${title ?? file.name}” (${audio.id}). Do not link or repeat the file in your reply.` };
  } finally {
    // quiet: a snapshot that will not delete is swept with the outbox folder on the next start.
    await rm(file.path, { force: true }).catch(() => undefined);
  }
}

/**
 * Put one sound into a chat's store: `write` puts the bytes at the path it is
 * given, then the ref is written beside them. Answers the ref.
 */
export async function storeChatAudio(
  threadId: string,
  mime: string,
  bytes: number,
  title: unknown,
  write: (dest: string) => Promise<void>
): Promise<ChatAudioRef> {
  const dir = threadDir(threadId);
  const ext = CHAT_AUDIO_EXT[mime];
  if (!dir || !ext) throw new Error('This sound cannot be stored.');
  const id = `aud_${randomBytes(5).toString('hex')}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await write(join(dir, `${id}${ext}`));
  const clean = cleanAudioTitle(title);
  const audio: ChatAudioRef = { id, threadId, mime, bytes, ...(clean ? { title: clean } : {}) };
  await writeFile(join(dir, `${id}.json`), JSON.stringify(audio));
  return audio;
}

/** The bytes of one stored sound, or null when it is gone (or the ids are not ours). */
export async function readChatAudio(threadId: string, audioId: string): Promise<{ mime: string; data: Buffer } | null> {
  const dir = threadDir(threadId);
  if (!dir || !CHAT_AUDIO_ID.test(audioId)) return null;
  try {
    const ref = JSON.parse(await readFile(join(dir, `${audioId}.json`), 'utf8')) as Partial<ChatAudioRef>;
    const mime = typeof ref.mime === 'string' && CHAT_AUDIO_EXT[ref.mime] ? ref.mime : null;
    if (!mime) return null;
    const path = join(dir, `${audioId}${CHAT_AUDIO_EXT[mime]}`);
    if (!(await stat(path)).isFile()) return null;
    return { mime, data: await readFile(path) };
  } catch {
    // quiet: a missing or torn file reads as "no longer available" on the card.
    return null;
  }
}

/** Forget every sound of a deleted chat. */
export async function deleteChatAudio(threadId: string): Promise<void> {
  const dir = threadDir(threadId);
  if (dir) await rm(dir, { recursive: true, force: true });
}
