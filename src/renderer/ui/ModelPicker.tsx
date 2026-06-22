import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import type { ModelSummary } from '../../shared/types';

interface ModelPickerProps {
  models: ModelSummary[];
  /** Selected model id, or null for "no specific model". */
  value: string | null;
  onChange: (id: string | null) => void;
  /** When set, render a clearable first row meaning "no specific model" (id = null). */
  emptyLabel?: string;
  ariaLabel?: string;
}

// A filterable model picker: a field-styled trigger that opens a searchable popup
// list. Replaces native <select>, which becomes unusable with many models. The
// popup mirrors the context-menu pattern in ChatList.tsx (fixed position,
// edge-clamped, dismissed on outside mousedown / Escape).
export function ModelPicker({ models, value, onChange, emptyLabel, ariaLabel }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = value ? models.find((m) => m.id === value) ?? null : null;
  const triggerLabel = selected?.displayName ?? emptyLabel ?? 'Select a model';

  // Filtered rows, with an optional "empty" row (id = null) pinned first.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = models.filter((m) =>
      !q ||
      m.displayName.toLowerCase().includes(q) ||
      m.providerName.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q)
    );
    const opts: { id: string | null; label: string }[] = matched.map((m) => ({ id: m.id, label: m.displayName }));
    if (emptyLabel && (!q || emptyLabel.toLowerCase().includes(q))) {
      opts.unshift({ id: null, label: emptyLabel });
    }
    return opts;
  }, [models, query, emptyLabel]);

  function openMenu() {
    setQuery('');
    const i = rows.findIndex((r) => r.id === value);
    setActive(i >= 0 ? i : 0);
    setOpen(true);
  }

  function commit(id: string | null) {
    onChange(id);
    setOpen(false);
  }

  // Position the popup under the trigger, clamped inside the window.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const btn = triggerRef.current.getBoundingClientRect();
    const pad = 8;
    const width = btn.width;
    const popH = popRef.current?.getBoundingClientRect().height ?? 240;
    let top = btn.bottom + 4;
    if (top + popH + pad > window.innerHeight) top = Math.max(pad, btn.top - 4 - popH);
    const left = Math.max(pad, Math.min(btn.left, window.innerWidth - width - pad));
    setPos({ left, top, width });
  }, [open, rows.length]);

  // Dismiss on outside mousedown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the active row clamped and scrolled into view.
  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(0, rows.length - 1));
  }, [rows.length, active]);
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) commit(row.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="mp-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className="mp-trigger-label">{triggerLabel}</span>
        <ChevronDown size={14} className="mp-trigger-chevron" />
      </button>
      {open && (
        <div
          ref={popRef}
          className="mp-pop"
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: pos?.width }}
          role="listbox"
        >
          <input
            className="ifield mp-search"
            autoFocus
            placeholder="Filter models…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div ref={listRef} className="mp-list">
            {rows.length === 0 && <div className="mp-empty">No matches</div>}
            {rows.map((row, i) => {
              const isSel = row.id === value;
              return (
                <button
                  key={row.id ?? '__empty__'}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  className={`mp-opt${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(row.id)}
                >
                  <span className="mp-opt-label">{row.label}</span>
                  {isSel && <Check size={14} className="mp-opt-check" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
