import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useSearchHarvest } from '../../../ui/searchHarvest';

/**
 * The settings-row idioms the Chat and App tabs are built from, and the
 * collapsible groups Models is built from. One row = one setting: what it's
 * called on the left, its current value or control on the right. The tab
 * doubles as an overview — every value is readable without opening anything —
 * and the bulky editors (pill lists, textareas, path pickers) live behind a
 * DisclosureRow so they stop swallowing the 320px panel.
 */

/**
 * One setting as a row: label (and optional second line) left, control right.
 * `stacked` puts the control on its own full-width line under the label, for a
 * text field too wide to share the 320px panel with a two-line label.
 */
export function ValueRow({
  label,
  hint,
  stacked,
  children
}: {
  label: ReactNode;
  hint?: ReactNode;
  stacked?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={stacked ? 'set-vrow stacked' : 'set-vrow'}>
      <span className="vlab">
        {label}
        {hint && <em>{hint}</em>}
      </span>
      {children}
    </div>
  );
}

/** The right-aligned borderless select a ValueRow carries as its control. */
export function RowSelect({
  ariaLabel,
  value,
  options,
  onChange
}: {
  ariaLabel: string;
  value: string;
  options: { value: string; label: string; title?: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <select className="vfield" aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value} title={o.title}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A row that opens in place. Closed it reads as an answer (`value` on the
 * right); open it grows a body holding the actual editor. The chevron is the
 * only state indicator, matching the memory-view toggle elsewhere.
 */
export function DisclosureRow({
  label,
  hint,
  value,
  defaultOpen,
  children
}: {
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [openState, setOpen] = useState(!!defaultOpen);
  // The settings search's hidden copy opens every row so it can read the rows inside.
  const open = useSearchHarvest() || openState;
  return (
    <>
      <button type="button" className="set-vrow" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="vlab">
          {label}
          {hint && <em>{hint}</em>}
        </span>
        {value != null && <span className="vval">{value}</span>}
        <ChevronRight size={13} className={`vchev${open ? ' open' : ''}`} />
      </button>
      {open && <div className="set-vbody">{children}</div>}
    </>
  );
}

/**
 * A collapsible settings group (Models): the header answers "what runs on
 * what" while closed — title left, the resolved summary right — so opening one
 * is only ever about changing something, never about finding out.
 */
export function SettingSection({
  title,
  summary,
  defaultOpen,
  open: openProp,
  onOpenChange,
  children
}: {
  title: string;
  summary: ReactNode;
  defaultOpen?: boolean;
  /** Controlled open state, for a group something else can open (a deep link). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [openState, setOpenState] = useState(!!defaultOpen);
  const harvest = useSearchHarvest();
  const open = harvest || (openProp ?? openState);
  const setOpen = (next: (v: boolean) => boolean) => {
    const value = next(open);
    setOpenState(value);
    onOpenChange?.(value);
  };
  return (
    <div className="role-group">
      <button type="button" className="role-group-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className={`vchev${open ? ' open' : ''}`} />
        <strong>{title}</strong>
        <em>{summary}</em>
      </button>
      {open && <div className="role-group-body">{children}</div>}
    </div>
  );
}
