import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Lock, Plus, Search } from 'lucide-react';

// ---- The list → editor shell the Manage tabs share ----
//
// A tab is a searchable, grouped list of one-line rows; opening a row REPLACES
// the list with that item's editor (back arrow top left), so a 300px rail never
// has to hold a list and a form at once. Whole-item actions (duplicate, delete,
// run now…) live in the editor's header, never on the row, and every editor
// ends in the same Cancel / Save footer. Personas was first; MCP, folders and
// tasks follow the same pieces.

/** Glyph tones: plain, accent (code), warn (controls a computer / needs care). */
export type GlyphTone = 'plain' | 'accent' | 'warn' | 'danger';

export function Glyph({ icon, tone = 'plain', size = 'md' }: { icon: ReactNode; tone?: GlyphTone; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`ld-glyph ${tone} ${size}`} aria-hidden="true">
      {icon}
    </span>
  );
}

/** Tab title, optional pills/tips, and the New button (with its starting points). */
export function ListHeader({
  title,
  extra,
  newLabel = 'New',
  templates,
  onNew
}: {
  title: string;
  extra?: ReactNode;
  newLabel?: string;
  /** Starting points the New button offers; absent → New acts at once. */
  templates?: { key: string; icon: ReactNode; tone?: GlyphTone; label: string; hint: string; onPick: () => void }[];
  onNew?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="ld-head" ref={ref}>
      <span className="ld-title">
        {title}
        {extra}
      </span>
      {(templates || onNew) && (
        <button
          type="button"
          className="ld-new"
          aria-expanded={templates ? open : undefined}
          onClick={() => (templates ? setOpen((v) => !v) : onNew?.())}
        >
          <Plus size={12} /> {newLabel}
        </button>
      )}
      {open && templates && (
        <div className="ld-menu" role="menu">
          <div className="ld-menu-cap">Start from</div>
          {templates.map((t) => (
            <button
              key={t.key}
              type="button"
              role="menuitem"
              className="ld-menu-item"
              onClick={() => {
                setOpen(false);
                t.onPick();
              }}
            >
              <Glyph icon={t.icon} tone={t.tone} size="sm" />
              <span>
                <strong>{t.label}</strong>
                <em>{t.hint}</em>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ListSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="ld-search">
      <Search size={13} aria-hidden="true" />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** The amber "something needs you" bar; clicking it opens the item. */
export function AttentionBar({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="ld-attn" onClick={onClick}>
      <AlertTriangle size={13} aria-hidden="true" />
      <span>{children}</span>
      <ChevronRight size={13} aria-hidden="true" />
    </button>
  );
}

export function ListGroup({ label, count, children }: { label: ReactNode; count: number; children: ReactNode }) {
  return (
    <div className="ld-group">
      <div className="ld-group-head">
        <span>{label}</span>
        <span>{count}</span>
      </div>
      {children}
    </div>
  );
}

/** One item: glyph, name (+ lock for built-ins), one mono line, flags on the right. */
export function ListRow({
  glyph,
  name,
  locked,
  sub,
  right,
  dim,
  selected,
  onOpen
}: {
  glyph: ReactNode;
  name: string;
  locked?: string;
  sub?: string;
  right?: ReactNode;
  dim?: boolean;
  selected?: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className={`ld-row${dim ? ' dim' : ''}${selected ? ' selected' : ''}`} onClick={onOpen}>
      {glyph}
      <span className="ld-row-main">
        <span className="ld-row-name">
          <strong>{name}</strong>
          {locked && (
            <span className="ld-lock" title={locked}>
              <Lock size={10} aria-label={locked} />
            </span>
          )}
        </span>
        {sub && <em title={sub}>{sub}</em>}
      </span>
      {right && <span className="ld-flags">{right}</span>}
    </button>
  );
}

/** A small state icon on a row; `tone` says how much it matters. */
export function Flag({ icon, tone = 'off', label }: { icon: ReactNode; tone?: 'ok' | 'warn' | 'off' | 'danger'; label: string }) {
  return (
    <span className={`ld-flag ${tone}`} title={label} aria-label={label} role="img">
      {icon}
    </span>
  );
}

/** The editor's top bar: back to the list, then whole-item actions. */
export function DetailHeader({ backLabel, onBack, children }: { backLabel: string; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="ld-detail-bar">
      <button type="button" className="ld-back" onClick={onBack} aria-label={`Back to ${backLabel}`}>
        <ChevronLeft size={15} aria-hidden="true" />
        {backLabel}
      </button>
      <span className="ld-detail-acts">{children}</span>
    </div>
  );
}

/** Glyph + the item's (editable) name + a caption under it. */
export function DetailIdent({ glyph, name, caption }: { glyph: ReactNode; name: ReactNode; caption?: ReactNode }) {
  return (
    <div className="ld-ident">
      {glyph}
      <span className="ld-ident-main">
        {name}
        {caption && <em>{caption}</em>}
      </span>
    </div>
  );
}

export function DetailTabs<K extends string>({
  tabs,
  value,
  onChange
}: {
  tabs: { key: K; label: string }[];
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div className="ld-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          className={value === t.key ? 'on' : ''}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Cancel / Save, with a note while there is something to lose. */
export function DetailFooter({
  dirty,
  saving,
  canSave = true,
  saveLabel = 'Save',
  onCancel,
  onSave
}: {
  dirty: boolean;
  saving?: boolean;
  canSave?: boolean;
  saveLabel?: string;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="ld-foot">
      {dirty && <span className="ld-dirty">Unsaved changes</span>}
      <button type="button" className="link-btn" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="primary" onClick={onSave} disabled={!dirty || !canSave || saving}>
        {saving ? 'Saving…' : saveLabel}
      </button>
    </div>
  );
}

/** One on/off setting: title and a line of help left, a switch right. */
export function ToggleRow({
  title,
  hint,
  on,
  tone,
  disabled,
  onChange
}: {
  title: ReactNode;
  hint?: ReactNode;
  on: boolean;
  tone?: 'warn';
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="ld-toggle">
      <span>
        <strong>{title}</strong>
        {hint && <em>{hint}</em>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={typeof title === 'string' ? title : undefined}
        disabled={disabled}
        className={`switch${on ? ' on' : ''}${tone === 'warn' ? ' warn' : ''}`}
        onClick={() => onChange(!on)}
      />
    </div>
  );
}

/** A labelled field in an editor tab. */
export function Field({ label, htmlFor, children }: { label: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="ld-field">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="ld-field-label">{label}</span>}
      {children}
    </div>
  );
}

/** A delete that asks once, in place: the first click arms it, the second acts. */
export function ConfirmDelete({ label, icon, onConfirm }: { label: string; icon: ReactNode; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed ? (
    <button type="button" className="ld-confirm" onClick={onConfirm}>
      {label}?
    </button>
  ) : (
    <button type="button" className="icon-action sm danger" title={label} aria-label={label} onClick={() => setArmed(true)}>
      {icon}
    </button>
  );
}

/** "/Users/vlado/src/x" → "~/src/x" — for display only; the stored path stays absolute. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}
