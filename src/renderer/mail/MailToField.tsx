import { useMemo, useRef, useState } from 'react';
import { Crown, X } from 'lucide-react';
import type { Persona } from '../../shared/types';

// New mail's To: field. Type to add a persona; the first name leads (it gets
// the mail and answers you), the rest join when the lead asks them. Replaces
// the wall of every-persona chips where the lead was "whoever you clicked first".

/** A one-line hint of what a persona is for: its prompt's first line, trimmed. */
function roleHint(p: Persona): string {
  const first = p.prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  // Role prompts open with "You are <Name>." — the name is already on the row.
  const line = first.replace(/^you are [^.]*\.\s*/i, '');
  return line.length > 64 ? `${line.slice(0, 63).trimEnd()}…` : line;
}

export function MailToField({
  personas,
  to,
  onChange
}: {
  personas: Persona[];
  to: string[];
  onChange: (to: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const name = (id: string) => personas.find((p) => p.id === id)?.name ?? 'Deleted persona';

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return personas.filter((p) => !to.includes(p.id) && (!q || p.name.toLowerCase().includes(q)));
  }, [personas, to, query]);
  const highlighted = Math.min(active, Math.max(0, options.length - 1));

  const add = (id: string) => {
    onChange([...to, id]);
    setQuery('');
    setActive(0);
    // Close so the list doesn't cover the form; typing or ↓ opens it again.
    setOpen(false);
    inputRef.current?.focus();
  };
  const remove = (id: string) => onChange(to.filter((t) => t !== id));
  const makeLead = (id: string) => onChange([id, ...to.filter((t) => t !== id)]);

  const lead = to[0];
  const others = to.slice(1).map(name);

  return (
    <div className="mail-to-field">
      <div className="mail-to-box" onClick={() => inputRef.current?.focus()}>
        {to.map((id, i) => (
          <span key={id} className={`mail-to-token${i === 0 ? ' lead' : ''}`}>
            {name(id)}
            {i === 0 && to.length > 1 && <em className="mail-to-lead">leads</em>}
            {i > 0 && (
              <button
                type="button"
                className="mail-to-token-btn"
                title={`Make ${name(id)} lead — it gets your mail and answers you`}
                aria-label={`Make ${name(id)} lead`}
                onClick={(e) => {
                  e.stopPropagation();
                  makeLead(id);
                }}
              >
                <Crown size={11} />
              </button>
            )}
            <button
              type="button"
              className="mail-to-token-btn"
              title={`Remove ${name(id)}`}
              aria-label={`Remove ${name(id)}`}
              onClick={(e) => {
                e.stopPropagation();
                remove(id);
              }}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="mail-to-input"
          value={query}
          aria-label="Add a persona"
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls="mail-to-options"
          placeholder={to.length ? '' : 'Type a persona’s name'}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, options.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
              if (open && options[highlighted]) {
                e.preventDefault();
                add(options[highlighted].id);
              }
            } else if (e.key === 'Backspace' && !query && to.length) {
              remove(to[to.length - 1]);
            } else if (e.key === 'Escape' && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </div>
      {open && options.length > 0 && (
        <div className="mail-to-options" id="mail-to-options" role="listbox" aria-label="Personas">
          {options.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === highlighted}
              className={`mail-to-option${i === highlighted ? ' active' : ''}`}
              // Keep focus in the input so the list stays open for the next pick.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => add(p.id)}
            >
              <strong>{p.name}</strong>
              {roleHint(p) && <span>{roleHint(p)}</span>}
            </button>
          ))}
          <div className="mail-to-options-hint">↑↓ to pick · ↵ to add · the crown makes a name lead</div>
        </div>
      )}
      <p className="mail-to-hint">
        {lead
          ? `${name(lead)} gets your mail and answers you.${
              others.length ? ` ${others.join(', ')} ${others.length === 1 ? 'joins' : 'join'} when ${name(lead)} asks.` : ''
            }`
          : 'Add at least one persona — the first one leads.'}
      </p>
    </div>
  );
}
