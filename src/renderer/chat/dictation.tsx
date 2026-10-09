import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import type { DictationLanguages } from '../../shared/types';

// Dictation into a text field, on the Mac's own on-device speech model (see
// desktop/dictation.ts). The words land in the field as they are heard: what
// was there before stays, and the live tail is rewritten in place until the
// model settles it. Typing in the field while dictating stops the dictation,
// so a hand edit is never overwritten by the next update.

const LOCALE_KEY = 'stem.dictationLocale';

/** The chosen language, or null for the Mac's own. A per-machine choice, so localStorage. */
export function dictationLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY) || null;
  } catch {
    return null;
  }
}

export function setDictationLocale(locale: string | null): void {
  try {
    if (locale) localStorage.setItem(LOCALE_KEY, locale);
    else localStorage.removeItem(LOCALE_KEY);
  } catch {
    // Unsaved; the next dictation uses the Mac's language.
  }
}

let languages: Promise<DictationLanguages> | null = null;

/** Asked once per window: it spawns the helper, and the answer only changes with an OS update. */
export function loadDictationLanguages(): Promise<DictationLanguages> {
  languages ??= window.stem.dictationLanguages().catch(
    (e: unknown): DictationLanguages => ({
      available: false,
      reason: e instanceof Error ? e.message : String(e),
      languages: [],
      current: ''
    })
  );
  return languages;
}

export type DictationPhase = 'idle' | 'starting' | 'downloading' | 'listening' | 'stopping';

export interface Dictation {
  available: boolean;
  phase: DictationPhase;
  error: string | null;
  toggle(): void;
  /**
   * Drop the microphone and leave the field exactly as it reads now. For a send
   * or a hand edit mid-dictation, where a late update must not rewrite the field.
   */
  freeze(): void;
}

/** Dictation into one field: `value` is its text, `setValue` replaces it. */
export function useDictation(value: string, setValue: (text: string) => void): Dictation {
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const session = useRef<number | null>(null);
  const base = useRef('');
  const phaseRef = useRef<DictationPhase>('idle');
  const latest = useRef({ value, setValue });
  latest.current = { value, setValue };

  const move = (next: DictationPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  useEffect(() => {
    let live = true;
    void loadDictationLanguages().then((l) => live && setAvailable(l.available));
    return () => {
      live = false;
    };
  }, []);

  const write = useCallback((heard: string) => {
    latest.current.setValue(base.current + heard.trimStart());
  }, []);

  useEffect(
    () =>
      window.stem.onDictationUpdate((u) => {
        // The download notice comes before start() resolves with the session id.
        if (u.downloading) {
          if (phaseRef.current === 'starting') move('downloading');
          return;
        }
        if (u.session === session.current && phaseRef.current === 'listening') write(u.final + u.volatile);
      }),
    [write]
  );

  // A composer that goes away (chat switched, window closed) frees the microphone.
  useEffect(
    () => () => {
      if (phaseRef.current !== 'idle') void window.stem.cancelDictation();
    },
    []
  );

  const stop = useCallback(() => {
    const was = phaseRef.current;
    if (was === 'idle' || was === 'stopping') return;
    move('stopping');
    window.stem
      .stopDictation()
      .then((text) => {
        // A freeze in the meantime already settled the field.
        if (was === 'listening' && text && phaseRef.current === 'stopping') write(text);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (phaseRef.current !== 'stopping') return;
        session.current = null;
        move('idle');
      });
  }, [write]);

  const start = useCallback(() => {
    const current = latest.current.value;
    base.current = current && !/\s$/.test(current) ? `${current} ` : current;
    setError(null);
    move('starting');
    window.stem
      .startDictation(dictationLocale())
      .then((s) => {
        if (phaseRef.current !== 'starting' && phaseRef.current !== 'downloading') return;
        session.current = s.session;
        move('listening');
      })
      .catch((e: unknown) => {
        // A stop pressed while the model was loading rejects the start; that is not an error.
        if (phaseRef.current === 'stopping' || phaseRef.current === 'idle') return;
        setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
        move('idle');
      });
  }, []);

  const toggle = useCallback(() => (phaseRef.current === 'idle' ? start() : stop()), [start, stop]);

  const freeze = useCallback(() => {
    if (phaseRef.current === 'idle') return;
    session.current = null;
    move('idle');
    void window.stem.cancelDictation();
  }, []);

  return { available, phase, error, toggle, freeze };
}

/** The mic button. Renders nothing where dictation is unavailable (Linux, macOS before 26). */
export function DictateButton({
  dictation,
  className = 'composer-attach',
  size = 17,
  disabled
}: {
  dictation: Dictation;
  className?: string;
  size?: number;
  disabled?: boolean;
}) {
  if (!dictation.available) return null;
  const { phase, error } = dictation;
  const busy = phase === 'starting' || phase === 'downloading' || phase === 'stopping';
  const title = error
    ? `Dictation: ${error}`
    : phase === 'downloading'
      ? 'Downloading the speech model for this language…'
      : phase === 'listening'
        ? 'Stop dictating'
        : busy
          ? 'Getting ready…'
          : 'Dictate';
  return (
    <button
      type="button"
      className={`${className} dictate${phase === 'listening' ? ' listening' : ''}${error ? ' failed' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={phase === 'listening'}
      // mousedown, not click: the field keeps focus and the caret.
      onMouseDown={(e) => e.preventDefault()}
      onClick={dictation.toggle}
      disabled={disabled}
    >
      {busy ? <Loader2 size={size} className="spin" /> : phase === 'listening' ? <Square size={size - 3} /> : <Mic size={size} />}
    </button>
  );
}
