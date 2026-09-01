import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Info } from 'lucide-react';

// Fixed positioning (so the manage panel's scroll pane can't clip the popup),
// centered under the anchor, edge-clamped, flipped above when the window runs
// out — the ModelPicker popup pattern.
function useClampedPop(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popRef: RefObject<HTMLElement | null>
) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current.getBoundingClientRect();
    const pad = 8;
    const pop = popRef.current?.getBoundingClientRect();
    const width = pop?.width ?? 280;
    const height = pop?.height ?? 80;
    let top = anchor.bottom + 6;
    if (top + height + pad > window.innerHeight) top = Math.max(pad, anchor.top - 6 - height);
    const left = Math.max(pad, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - pad));
    setPos({ left, top });
  }, [open, anchorRef, popRef]);

  return pos;
}

function popStyle(pos: { left: number; top: number } | null) {
  return pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' as const };
}

// A quiet ⓘ beside a label that opens a small explainer popover on click.
// Static how-it-works prose lives here so settings panels stay dense and
// scannable; dynamic status lines and pre-action warnings stay inline.
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const pos = useClampedPop(open, btnRef, popRef);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="info-tip"
        aria-label={label}
        aria-expanded={open}
        title={open ? undefined : label}
        onClick={(e) => {
          // Stops a wrapping row/toggle from also handling the click.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Info size={13} />
      </button>
      {open && (
        <span
          ref={popRef}
          className="info-pop"
          role="note"
          style={popStyle(pos)}
          // The tip may sit inside a <label> (the persona capability rows):
          // without this, clicking its text forwards to the labelled checkbox
          // and toggles a setting the user was only reading about.
          onClick={(e) => e.preventDefault()}
        >
          {children}
        </span>
      )}
    </>
  );
}

interface HoverTipProps {
  /** Explainer shown in the popover. */
  tip: ReactNode;
  /** Class for the wrapper span — the anchor itself (e.g. "chip"). */
  className?: string;
  ariaLabel?: string;
  /** Hold-off before the popup shows. 0 (default) explains on approach (chips);
   *  a few hundred ms suits action buttons, where instant popups would flash as
   *  the pointer crosses the row. */
  delayMs?: number;
  children: ReactNode;
}

// Hover variant for content that explains itself on approach (e.g. icon chips):
// same styled popup as InfoTip, but shown on hover instead of the slow native
// title tooltip.
export function HoverTip({ tip, className, ariaLabel, delayMs = 0, children }: HoverTipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const pos = useClampedPop(open, anchorRef, popRef);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <span
      ref={anchorRef}
      className={className}
      aria-label={ariaLabel}
      onMouseEnter={() => {
        if (delayMs <= 0) {
          setOpen(true);
          return;
        }
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setOpen(true), delayMs);
      }}
      onMouseLeave={() => {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        setOpen(false);
      }}
    >
      {children}
      {open && (
        <span ref={popRef} className="info-pop" role="tooltip" style={popStyle(pos)}>
          {tip}
        </span>
      )}
    </span>
  );
}
