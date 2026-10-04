import { useMemo } from 'react';
import { parseTable } from './data';

// <Compare>: two to four options side by side, each with a one-line summary
// and its pros and cons, and the assistant's pick marked. The reasoning for
// the pick stays in the prose around it; the cards are for scanning.

interface Option {
  name: string;
  summary: string;
  pros: string[];
  cons: string[];
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : typeof v === 'string' && v ? [v] : [];

function toOptions(raw: string | undefined): Option[] | null {
  const table = parseTable(raw);
  if (!table || !table.rows.length) return null;
  return table.rows.slice(0, 4).map((r) => ({
    name: String(r.name ?? r.option ?? ''),
    summary: String(r.summary ?? r.bestFor ?? r.best_for ?? ''),
    pros: list(r.pros),
    cons: list(r.cons)
  }));
}

export function Compare({ data, recommend }: { data?: string; recommend?: string }) {
  const options = useMemo(() => toOptions(data), [data]);
  if (!options) return <div className="chart-error">Could not read the options.</div>;
  const pick = recommend?.trim().toLowerCase();
  return (
    <div className="compare" style={{ ['--compare-cols' as string]: String(options.length) }}>
      {options.map((o, i) => {
        const picked = !!pick && o.name.trim().toLowerCase() === pick;
        return (
          <section className={`compare-card${picked ? ' picked' : ''}`} key={i}>
            <header>
              <h4>{o.name}</h4>
              {picked && <span className="compare-badge">Recommended</span>}
            </header>
            {o.summary && <p className="compare-summary">{o.summary}</p>}
            {o.pros.length > 0 && (
              <ul className="compare-pros" aria-label="Pros">
                {o.pros.map((p, j) => (
                  <li key={j}>{p}</li>
                ))}
              </ul>
            )}
            {o.cons.length > 0 && (
              <ul className="compare-cons" aria-label="Cons">
                {o.cons.map((c, j) => (
                  <li key={j}>{c}</li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
