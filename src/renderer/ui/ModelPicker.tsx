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
  /** Greyed out and unopenable — for a picker whose feature is switched off. */
  disabled?: boolean;
  /**
   * The model id the empty row currently resolves to. Shown as a small line under
   * the trigger while nothing specific is picked, because "Default" and "Auto"
   * name a rule, not a model — and the rule's answer moves when you sign into a
   * new provider or switch the model you chat with.
   */
  resolvedDefault?: string | null;
  /**
   * Replace the field-styled trigger with custom content (the composer's
   * effort-pill label). The button shell — ref, aria, open/close — stays; only
   * its class and children swap, and the resolved-default note is skipped
   * because a compact trigger has nowhere to hang it.
   */
  triggerClassName?: string;
  triggerContent?: React.ReactNode;
  triggerTitle?: string;
}

// A filterable model picker: a field-styled trigger that opens a searchable popup
// list. Replaces native <select>, which becomes unusable with many models. The
// popup mirrors the context-menu pattern in ChatList.tsx (fixed position,
// edge-clamped, dismissed on outside mousedown / Escape).
export function ModelPicker({
  models,
  value,
  onChange,
  emptyLabel,
  ariaLabel,
  disabled,
  resolvedDefault,
  triggerClassName,
  triggerContent,
  triggerTitle
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = value ? models.find((m) => m.id === value) ?? null : null;
  // Only while nothing specific is picked: once you name a model the trigger
  // already says it, and a second line repeating it is noise.
  const resolved =
    value === null && resolvedDefault ? models.find((m) => m.id === resolvedDefault) ?? null : null;
  const triggerLabel = selected?.displayName ?? emptyLabel ?? 'Select a model';
  // Disambiguate the trigger too — the same model name can come from two
  // providers (e.g. Claude via Anthropic vs via OpenRouter).
  const triggerProvider = selected?.providerName ?? null;

  // Filtered rows, with an optional "empty" row (id = null) pinned first.
  // Each row carries its provider group; the list renders a header whenever the
  // group changes (models arrive from the backend already grouped by provider).
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = models.filter((m) =>
      !q ||
      m.displayName.toLowerCase().includes(q) ||
      m.providerName.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q)
    );
    const opts: { id: string | null; label: string; group: string | null }[] = matched.map((m) => ({
      id: m.id,
      label: m.displayName,
      group: m.providerName
    }));
    if (emptyLabel && (!q || emptyLabel.toLowerCase().includes(q))) {
      opts.unshift({ id: null, label: emptyLabel, group: null });
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
    // Floor, not btn.width verbatim: the composer's compact trigger is far
    // narrower than a readable list. Settings triggers are wider than this
    // anyway, so they keep matching their field exactly.
    const width = Math.max(btn.width, 220);
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
    // Index into option rows only — group headers are interleaved siblings.
    const el = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[active];
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
        className={triggerClassName ?? 'mp-trigger'}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={triggerTitle}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        {triggerContent ?? (
          <>
            <span className="mp-trigger-label" title={triggerProvider ? `${triggerLabel} · ${triggerProvider}` : triggerLabel}>
              {triggerLabel}
              {triggerProvider && <span className="mp-trigger-provider"> · {triggerProvider}</span>}
            </span>
            <ChevronDown size={14} className="mp-trigger-chevron" />
          </>
        )}
      </button>
      {!triggerContent && resolved && (
        <em className="mp-resolved">
          uses {resolved.displayName} · {resolved.providerName}
        </em>
      )}
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
              const header = row.group && row.group !== rows[i - 1]?.group ? row.group : null;
              return (
                <div key={row.id ?? '__empty__'} className="mp-group-wrap">
                  {header && <div className="mp-group">{header}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className={`mp-opt${i === active ? ' active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(row.id)}
                  >
                    <span className="mp-opt-label" title={row.label}>{row.label}</span>
                    {isSel && <Check size={14} className="mp-opt-check" />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
