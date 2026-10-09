import { BrowserWindow } from 'electron';
import { log } from '../server/log';
import { HelperProcess, resolveHelperPath } from './computer-host/helper';
import type { DictationLanguages, DictationUpdate } from '../shared/types';

// Dictation into the composers, on this Mac's microphone through Apple's
// on-device SpeechAnalyzer (native/mac/stem-computer/Dictate.swift). Nothing
// leaves the machine and nothing is bundled: the helper the computer-control
// persona already ships gains dictate-* commands, and a process of its own is
// spawned per dictation so a computer-control run and a dictation never share
// one. Client-owned like the recorder: the microphone is this machine's.
//
// Updates go to every window ('dictation:update'), tagged with the session
// they belong to; the composer that started it keeps its own and ignores the
// rest (Quick Chat and the main window both have a composer).

let helper: HelperProcess | null = null;
let session = 0;

function broadcast(update: DictationUpdate): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('dictation:update', update);
  }
}

function release(): void {
  helper?.kill();
  helper = null;
}

export async function dictationLanguages(): Promise<DictationLanguages> {
  if (process.platform !== 'darwin') return { available: false, reason: 'Dictation is only available on macOS.', languages: [], current: '' };
  const proc = new HelperProcess(await resolveHelperPath());
  try {
    const reply = await proc.call('dictate-languages');
    if (!reply.ok) return { available: false, reason: reply.error ?? 'Dictation is unavailable.', languages: [], current: '' };
    return { available: true, languages: reply.languages ?? [], current: reply.current ?? '' };
  } finally {
    proc.kill();
  }
}

/** Starts listening; resolves with the session id once the model is ready. Rejects with the reason. */
export async function startDictation(locale: string | null): Promise<{ session: number; locale: string }> {
  release();
  const id = ++session;
  const proc = new HelperProcess(await resolveHelperPath());
  helper = proc;
  proc.onEvent((e) => {
    if (e.event === 'dictate-update') broadcast({ session: id, final: e.final, volatile: e.volatile });
    else if (e.event === 'dictate-downloading') broadcast({ session: id, final: '', volatile: '', downloading: true });
  });
  // A first use of a language downloads its model, which can take a while.
  const reply = await proc.call('dictate-start', { locale }, 5 * 60_000);
  if (!reply.ok) {
    if (helper === proc) release();
    log('dictation', 'start failed', { error: reply.error });
    throw new Error(reply.error ?? 'Dictation could not start.');
  }
  return { session: id, locale: reply.locale ?? locale ?? '' };
}

/** Stops listening and answers with everything heard. */
export async function stopDictation(): Promise<string> {
  const proc = helper;
  if (!proc) return '';
  try {
    const reply = await proc.call('dictate-stop', {}, 15_000);
    if (!reply.ok) throw new Error(reply.error ?? 'Dictation failed.');
    return reply.text ?? '';
  } finally {
    if (helper === proc) release();
  }
}

export function cancelDictation(): void {
  release();
}
