import { useMemo } from 'react';
import { parseTable, toNumber } from './data';
import { formatCompact, withUnit } from './chart/scale';

// <Stats>: a row of KPI tiles. Each tile is a label, a big value, an optional
// change against before (computed from `previous`, or written as `delta`),
// and an optional sparkline from `trend`. Whether a change is good is the
// tile's `good` ("up" by default; "down" for costs, churn, latency): the
// arrow and the words carry it, color only repeats it.

interface Stat {
  label: string;
  value: string;
  change: { text: string; dir: 'up' | 'down' | 'flat'; good: boolean | null } | null;
  trend: number[];
}

function toStats(raw: string | undefined): Stat[] | null {
  const table = parseTable(raw);
  if (!table || !table.rows.length) return null;
  return table.rows.map((r) => {
    const unit = typeof r.unit === 'string' ? r.unit : undefined;
    const value = toNumber(r.value);
    // A value written as text ("99.98%", "2h 14m") is shown exactly as written.
    const shown = typeof r.value === 'number' ? formatCompact(r.value, unit) : String(r.value ?? '');
    const goodWhen = r.good === 'down' ? 'down' : r.good === 'neither' ? null : 'up';
    let change: Stat['change'] = null;
    const previous = toNumber(r.previous);
    if (value !== null && previous !== null) {
      const diff = value - previous;
      const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
      const text =
        unit === '%'
          ? `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${formatCompact(Math.abs(diff))} pp`
          : previous !== 0
            ? `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${(Math.abs(diff / previous) * 100).toFixed(1).replace(/\.0$/, '')}%`
            : withUnit(formatCompact(diff), unit);
      change = { text, dir, good: dir === 'flat' || goodWhen === null ? null : dir === goodWhen };
    } else if (r.delta !== undefined && r.delta !== null && String(r.delta).trim()) {
      const text = String(r.delta).trim();
      const n = toNumber(text.replace(/^[+−]/, (m) => (m === '−' ? '-' : '')));
      const dir = n === null || n === 0 ? 'flat' : n > 0 ? 'up' : 'down';
      change = { text, dir, good: dir === 'flat' || goodWhen === null ? null : dir === goodWhen };
    }
    const trend = Array.isArray(r.trend) ? r.trend.map(toNumber).filter((v): v is number => v !== null) : [];
    return { label: String(r.label ?? ''), value: shown, change, trend };
  });
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 96;
  const H = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (i: number) => 2 + (i / (values.length - 1)) * (W - 4);
  const y = (v: number) => 2 + (H - 4) * (1 - (v - min) / (max - min || 1));
  const last = values.length - 1;
  return (
    <svg className="stat-spark" width={W} height={H} aria-hidden="true">
      <polyline points={values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} fill="none" />
      <circle cx={x(last)} cy={y(values[last])} r={2.5} />
    </svg>
  );
}

export function Stats({ data }: { data?: string }) {
  const stats = useMemo(() => toStats(data), [data]);
  if (!stats) return <div className="chart-error">Could not read the numbers.</div>;
  return (
    <div className="stats">
      {stats.map((s, i) => (
        <div className="stat" key={i}>
          <div className="stat-label">{s.label}</div>
          <div className="stat-value">{s.value}</div>
          {s.change && (
            <div className={`stat-change${s.change.good === null ? '' : s.change.good ? ' good' : ' bad'}`}>
              <span aria-hidden="true">{s.change.dir === 'up' ? '▲' : s.change.dir === 'down' ? '▼' : '■'}</span>{' '}
              {s.change.text}
              {s.change.good !== null && <span className="sr-only">{s.change.good ? ' (better)' : ' (worse)'}</span>}
            </div>
          )}
          <Sparkline values={s.trend} />
        </div>
      ))}
    </div>
  );
}
