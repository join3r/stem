import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';

// Cmd shortcuts + the "hold ⌘ to reveal" helper. macOS-only app, so ⌘ === metaKey.
//
// Two behaviors share one keydown listener:
//   1. A bound combo (e.g. ⌘N) fires its handler immediately, on any press.
//   2. ⌘ held *alone* for HINT_DELAY ms flips on `hintMode`, which makes each
//      <ShortcutHint> render a keycap next to its control. A real shortcut press,
//      any other key, ⌘-up, or window blur cancels it — so a quick combo never
//      flashes the hints.
//
// `ChatView` is reused in the Quick Chat window, which has no provider; the default
// context is a no-op so the hook/components degrade silently there (no badges).

export type ShortcutId =
  | 'new-conversation'
  | 'toggle-inspector'
  | 'cycle-effort'
  | 'toggle-format'
  | 'attach'
  | 'stop'
  | 'send';

interface Binding {
  id: ShortcutId;
  /** Keycap glyphs shown in the hint. */
  glyphs: string;
  /** Predicate over a keydown, or null for display-only bindings (e.g. Enter/Send). */
  match: ((e: KeyboardEvent) => boolean) | null;
}

const mod = (e: KeyboardEvent) => e.metaKey && !e.ctrlKey && !e.altKey;
const isKey = (e: KeyboardEvent, k: string) => e.key.toLowerCase() === k;

// Single source of truth for every Cmd shortcut and its hint glyphs.
export const BINDINGS: Binding[] = [
  { id: 'new-conversation', glyphs: '⌘N', match: (e) => mod(e) && !e.shiftKey && isKey(e, 'n') },
  { id: 'toggle-inspector', glyphs: '⌘\\', match: (e) => mod(e) && isKey(e, '\\') },
  { id: 'cycle-effort', glyphs: '⌘E', match: (e) => mod(e) && !e.shiftKey && isKey(e, 'e') },
  { id: 'toggle-format', glyphs: '⌘⇧M', match: (e) => mod(e) && e.shiftKey && isKey(e, 'm') },
  { id: 'attach', glyphs: '⌘U', match: (e) => mod(e) && !e.shiftKey && isKey(e, 'u') },
  { id: 'stop', glyphs: '⌘.', match: (e) => mod(e) && isKey(e, '.') },
  { id: 'send', glyphs: '⏎', match: null }
];

type Handler = () => void;

interface ShortcutsCtx {
  hintMode: boolean;
  register: (id: ShortcutId, handler: Handler) => void;
  unregister: (id: ShortcutId) => void;
}

const NOOP: ShortcutsCtx = {
  hintMode: false,
  register: () => {},
  unregister: () => {}
};

const Ctx = createContext<ShortcutsCtx>(NOOP);

const HINT_DELAY = 1200;

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [hintMode, setHintMode] = useState(false);
  const handlers = useRef(new Map<ShortcutId, Handler>());
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    const dismiss = () => {
      clearTimer();
      setHintMode(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // A full combo fires its handler regardless of hint state, and cancels any
      // pending reveal so the badges don't flash after the action.
      for (const b of BINDINGS) {
        if (b.match && b.match(e)) {
          const h = handlers.current.get(b.id);
          if (h) {
            e.preventDefault();
            h();
          }
          dismiss();
          return;
        }
      }
      if (e.key === 'Meta') {
        // ⌘ down alone — arm the delayed reveal once (ignore auto-repeat).
        if (!e.repeat && timer.current === null) {
          timer.current = window.setTimeout(() => setHintMode(true), HINT_DELAY);
        }
      } else {
        // Any other key means the user is committing to something — hide hints.
        dismiss();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', dismiss);
      clearTimer();
    };
  }, [clearTimer]);

  const register = useCallback((id: ShortcutId, h: Handler) => {
    handlers.current.set(id, h);
  }, []);
  const unregister = useCallback((id: ShortcutId) => {
    handlers.current.delete(id);
  }, []);

  const api = useMemo<ShortcutsCtx>(
    () => ({ hintMode, register, unregister }),
    [hintMode, register, unregister]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** Register a handler for a bound shortcut. The latest closure is always called. */
export function useShortcut(id: ShortcutId, handler: Handler) {
  const { register, unregister } = useContext(Ctx);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    register(id, () => ref.current());
    return () => unregister(id);
  }, [id, register, unregister]);
}

/** A keycap, e.g. ⌘N. */
export function Kbd({ glyphs }: { glyphs: string }) {
  return <span className="kbd">{glyphs}</span>;
}

/**
 * A floating keycap anchored to its (position: relative) host control, shown only
 * while ⌘ is held long enough to enter hint mode.
 */
export function ShortcutHint({ id, placement = 'tr' }: { id: ShortcutId; placement?: 'tr' | 'br' }) {
  const { hintMode } = useContext(Ctx);
  const binding = BINDINGS.find((b) => b.id === id);
  if (!hintMode || !binding) return null;
  return (
    <span className={`sc-hint sc-${placement}`} aria-hidden="true">
      <Kbd glyphs={binding.glyphs} />
    </span>
  );
}
