import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { toChartData, type ChartData } from '../data';
import { barPath, donutSlices, formatCompact, formatValue, niceTicks, textWidth } from './scale';
import { useWidth } from './useSize';

// The model-usable <Chart>: hand-rolled SVG, no dependency. Drawn at the
// container's real pixel width (see useWidth) so text never scales with the
// window. Follows the dataviz conventions: categorical hues in fixed order
// (--series-1..8, validated on Stem's light and dark surfaces), 2px lines,
// bars capped at 24px with a rounded data end, hairline grid, a legend for two
// or more series, a hover/focus tooltip, and a table view — three light-mode
// hues sit under 3:1 against the surface, so the numbers must be reachable
// without the color.

export type ChartKind = 'line' | 'area' | 'bar' | 'stacked' | 'donut' | 'scatter';

const KIND_ALIASES: Record<string, ChartKind> = {
  line: 'line',
  area: 'area',
  bar: 'bar',
  column: 'bar',
  stacked: 'stacked',
  'stacked-bar': 'stacked',
  donut: 'donut',
  pie: 'donut',
  scatter: 'scatter'
};

const MAX_SERIES = 8;
/** Scatter compares every pair of colors on one plot; only the first three slots stay apart. */
const MAX_SCATTER_SERIES = 3;
const FALLBACK_WIDTH = 520;
const PLOT_HEIGHT = 220;
const BAR_MAX = 24;
const GAP = 2;
const FONT = 11;

const seriesColor = (slot: number) => (slot < 0 ? 'var(--series-other)' : `var(--series-${(slot % MAX_SERIES) + 1})`);

interface TooltipState {
  x: number;
  y: number;
  /** `side`: beside the hovered column, inside the plot. `above`: over the point. */
  place: 'side' | 'above';
  title: string;
  rows: Array<{ color: string; name: string; value: string; key: 'line' | 'box' }>;
}

export function Chart({
  type,
  title,
  data,
  unit
}: {
  type?: string;
  title?: string;
  data?: string;
  unit?: string;
}) {
  const parsed = useMemo(() => toChartData(data), [data]);
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref, FALLBACK_WIDTH);
  const [showTable, setShowTable] = useState(false);

  if (!parsed) return <div className="chart-error">Could not read chart data.</div>;
  let kind = KIND_ALIASES[(type ?? 'line').toLowerCase()] ?? 'line';
  // A scatter needs two numeric axes; without them it is a line of categories.
  if (kind === 'scatter' && !parsed.xs && parsed.series.length < 2) kind = 'line';
  const legendKey: 'line' | 'box' = kind === 'line' || kind === 'scatter' ? 'line' : 'box';

  const legend = legendItems(parsed, kind);
  return (
    <figure className="chart">
      <figcaption className="chart-head">
        {title && <span className="chart-title">{title}</span>}
        <button
          type="button"
          className="chart-table-toggle"
          aria-pressed={showTable}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? 'Chart' : 'Table'}
        </button>
      </figcaption>
      {legend.length >= 2 && !showTable && (
        <ul className="chart-legend">
          {legend.map((item) => (
            <li key={`${item.slot}-${item.name}`}>
              <span
                className={`chart-key chart-key-${kind === 'donut' ? 'box' : legendKey}`}
                style={{ background: seriesColor(item.slot) }}
                aria-hidden="true"
              />
              {item.name}
            </li>
          ))}
        </ul>
      )}
      <div ref={ref} className="chart-body">
        {showTable ? (
          <ChartTable data={parsed} unit={unit} />
        ) : kind === 'donut' ? (
          <Donut data={parsed} unit={unit} width={width} title={title} />
        ) : kind === 'scatter' ? (
          <Scatter data={parsed} unit={unit} width={width} title={title} />
        ) : (
          <Cartesian data={parsed} kind={kind} unit={unit} width={width} title={title} />
        )}
      </div>
    </figure>
  );
}

function legendItems(data: ChartData, kind: ChartKind): Array<{ name: string; slot: number }> {
  if (kind === 'donut') {
    return donutSlices(data.labels, data.series[0].values).map((s) => ({ name: s.label, slot: s.slot }));
  }
  if (kind === 'scatter') {
    const ys = data.xs ? data.series : data.series.slice(1);
    return ys.slice(0, MAX_SCATTER_SERIES).map((s, i) => ({ name: s.name, slot: i }));
  }
  return data.series.slice(0, MAX_SERIES).map((s, i) => ({ name: s.name, slot: i }));
}

function Tooltip({ tip, width }: { tip: TooltipState; width: number }) {
  let style: CSSProperties;
  if (tip.place === 'side') {
    // Beside the column, on whichever side has room, so it never covers the
    // title, the legend or the column being read.
    const flip = tip.x > width / 2;
    style = flip
      ? { right: width - tip.x + 14, top: tip.y }
      : { left: tip.x + 14, top: tip.y };
  } else {
    // Over the point, centered, clamped inside the plot.
    const half = 90;
    style = { left: Math.max(half, Math.min(width - half, tip.x)), top: tip.y, transform: 'translate(-50%, -100%)' };
  }
  return (
    <div className="chart-tooltip" style={style} role="status">
      <div className="chart-tooltip-title">{tip.title}</div>
      {tip.rows.map((row, i) => (
        <div className="chart-tooltip-row" key={i}>
          <span className={`chart-key chart-key-${row.key}`} style={{ background: row.color }} aria-hidden="true" />
          <strong>{row.value}</strong>
          {row.name && <span className="chart-tooltip-name">{row.name}</span>}
        </div>
      ))}
    </div>
  );
}

// ---- line / area / bar / stacked -----------------------------------------

function Cartesian({
  data,
  kind,
  unit,
  width,
  title
}: {
  data: ChartData;
  kind: Exclude<ChartKind, 'donut' | 'scatter'>;
  unit?: string;
  width: number;
  title?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const series = data.series.slice(0, MAX_SERIES);
  const n = data.labels.length;
  const isBar = kind === 'bar' || kind === 'stacked';

  // Domain: bars and areas grow from zero; a line may float.
  let lo = Infinity;
  let hi = -Infinity;
  if (kind === 'stacked') {
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of series) {
        const v = s.values[i] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    }
  } else {
    for (const s of series) {
      for (const v of s.values) {
        if (v === null) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (kind !== 'line') {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  const ticks = niceTicks(lo, hi, 4);
  const d0 = ticks[0];
  const d1 = ticks[ticks.length - 1];
  const tickLabels = ticks.map((t) => formatCompact(t, unit));

  // Long category labels don't fit under columns: lay bars on their side.
  const longest = Math.max(...data.labels.map((l) => textWidth(l, FONT)));
  const padR = 12;
  const plotW = width - padR;
  const horizontal = isBar && n <= 40 && longest > Math.min(90, (plotW * 0.8) / n);

  if (horizontal) {
    return (
      <HorizontalBars
        data={data}
        series={series}
        stacked={kind === 'stacked'}
        ticks={ticks}
        tickLabels={tickLabels}
        unit={unit}
        width={width}
        title={title}
      />
    );
  }

  const padL = Math.ceil(Math.max(...tickLabels.map((t) => textWidth(t, FONT)))) + 10;
  const padT = 10;
  const padB = 26;
  const H = PLOT_HEIGHT;
  const iw = Math.max(40, width - padL - padR);
  const ih = H - padT - padB;
  const y = (v: number) => padT + ih * (1 - (v - d0) / (d1 - d0 || 1));
  const baseline = y(Math.max(d0, Math.min(d1, 0)));
  const slot = iw / Math.max(1, n);
  const xAt = (i: number) =>
    isBar ? padL + (i + 0.5) * slot : n === 1 ? padL + iw / 2 : padL + (i / (n - 1)) * iw;

  // X labels: thinned so they never collide, truncated to the room they get.
  const labelW = Math.min(longest, 120) + 10;
  const step = Math.max(1, Math.ceil((labelW * n) / iw));
  const room = slot * step - 6;
  const xLabel = (l: string) => truncate(l, room);

  const marks: ReactNode[] = [];
  if (kind === 'bar') {
    const k = series.length;
    const barW = Math.max(2, Math.min(BAR_MAX, (slot * 0.72 - (k - 1) * GAP) / k));
    const groupW = k * barW + (k - 1) * GAP;
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (v === null) return;
        const x = xAt(i) - groupW / 2 + si * (barW + GAP);
        marks.push(
          <path
            key={`b-${si}-${i}`}
            className="chart-bar"
            d={barPath(x, barW, baseline, y(v))}
            fill={seriesColor(si)}
            opacity={hover === null || hover === i ? 1 : 0.55}
          />
        );
      });
    });
  } else if (kind === 'stacked') {
    const barW = Math.max(4, Math.min(BAR_MAX * 1.5, slot * 0.6));
    for (let i = 0; i < n; i++) {
      const x = xAt(i) - barW / 2;
      let pos = 0;
      let neg = 0;
      const lastPos = lastIndex(series, i, (v) => v > 0);
      const lastNeg = lastIndex(series, i, (v) => v < 0);
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v === null || v === 0) return;
        const from = v > 0 ? pos : neg;
        const to = from + v;
        if (v > 0) pos = to;
        else neg = to;
        // The surface gap between segments: each segment past the first gives
        // up 2px at its baseline end.
        const start = y(from) + (from === 0 ? 0 : v > 0 ? -GAP : GAP);
        const top = si === (v > 0 ? lastPos : lastNeg);
        marks.push(
          <path
            key={`s-${si}-${i}`}
            className="chart-bar"
            d={barPath(x, barW, start, y(to), false, top ? 4 : 0)}
            fill={seriesColor(si)}
            opacity={hover === null || hover === i ? 1 : 0.55}
          />
        );
      });
    }
  } else {
    series.forEach((s, si) => {
      const segments = pathSegments(s.values, xAt, y);
      if (kind === 'area' && segments.length) {
        for (const seg of segments) {
          if (seg.length < 2) continue;
          const d = `M${seg[0][0]},${baseline} ${seg.map(([px, py]) => `L${px},${py}`).join(' ')} L${seg[seg.length - 1][0]},${baseline} Z`;
          marks.push(<path key={`a-${si}-${seg[0][0]}`} className="chart-area" d={d} fill={seriesColor(si)} />);
        }
      }
      for (const seg of segments) {
        marks.push(
          <polyline
            key={`l-${si}-${seg[0][0]}`}
            className="chart-line"
            points={seg.map(([px, py]) => `${px},${py}`).join(' ')}
            stroke={seriesColor(si)}
            fill="none"
          />
        );
      }
      // Markers on short series, where each point is a reading worth seeing.
      if (n <= 16) {
        s.values.forEach((v, i) => {
          if (v === null) return;
          marks.push(
            <circle key={`d-${si}-${i}`} className="chart-dot" cx={xAt(i)} cy={y(v)} r={4} fill={seriesColor(si)} />
          );
        });
      }
    });
  }

  const pick = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left;
    const i = isBar
      ? Math.floor((px - padL) / slot)
      : n === 1
        ? 0
        : Math.round(((px - padL) / iw) * (n - 1));
    return i >= 0 && i < n ? i : null;
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (svg) setHover(pick(e.clientX, svg.getBoundingClientRect()));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHover((h) => (h === null ? 0 : Math.min(n - 1, h + 1)));
    else if (e.key === 'ArrowLeft') setHover((h) => (h === null ? n - 1 : Math.max(0, h - 1)));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const tip: TooltipState | null =
    hover === null
      ? null
      : {
          x: isBar ? xAt(hover) + slot / 2 - 14 : xAt(hover),
          y: padT + 4,
          place: 'side',
          title: data.labels[hover] || `#${hover + 1}`,
          rows: series
            .map((s, si) => ({ s, si, v: s.values[hover] }))
            .filter((r) => r.v !== null)
            .map(({ s, si, v }) => ({
              color: seriesColor(si),
              name: series.length > 1 ? s.name : '',
              value: formatValue(v as number, unit),
              key: isBar ? ('box' as const) : ('line' as const)
            }))
        };

  return (
    <div className="chart-plot">
      <svg
        width={width}
        height={H}
        className="chart-svg"
        role="img"
        aria-label={title ?? 'chart'}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <g key={`t-${t}`}>
            <line className="chart-grid" x1={padL} x2={padL + iw} y1={y(t)} y2={y(t)} />
            <text className="chart-axis" x={padL - 8} y={y(t) + 4} textAnchor="end">
              {tickLabels[i]}
            </text>
          </g>
        ))}
        {hover !== null && isBar && (
          <rect className="chart-band" x={padL + hover * slot} y={padT} width={slot} height={ih} />
        )}
        {marks}
        <line className="chart-baseline" x1={padL} x2={padL + iw} y1={baseline} y2={baseline} />
        {hover !== null && !isBar && (
          <>
            <line className="chart-crosshair" x1={xAt(hover)} x2={xAt(hover)} y1={padT} y2={padT + ih} />
            {series.map((s, si) => {
              const v = s.values[hover];
              return v === null ? null : (
                <circle key={`h-${si}`} className="chart-dot" cx={xAt(hover)} cy={y(v)} r={4.5} fill={seriesColor(si)} />
              );
            })}
          </>
        )}
        {data.labels.map((l, i) =>
          i % step === 0 ? (
            <text
              key={`x-${i}`}
              className="chart-axis"
              x={xAt(i)}
              y={H - 8}
              // Line points reach the plot edges: anchor the end labels inward.
              textAnchor={!isBar && n > 1 && i === 0 ? 'start' : !isBar && n > 1 && i === n - 1 ? 'end' : 'middle'}
            >
              {xLabel(l)}
            </text>
          ) : null
        )}
        <rect
          className="chart-hit"
          x={padL}
          y={padT}
          width={iw}
          height={ih}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {tip && <Tooltip tip={tip} width={width} />}
    </div>
  );
}

function HorizontalBars({
  data,
  series,
  stacked,
  ticks,
  tickLabels,
  unit,
  width,
  title
}: {
  data: ChartData;
  series: ChartData['series'];
  stacked: boolean;
  ticks: number[];
  tickLabels: string[];
  unit?: string;
  width: number;
  title?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = data.labels.length;
  const k = stacked ? 1 : series.length;
  const barW = Math.min(BAR_MAX, k === 1 ? 18 : 12);
  const rowH = k * barW + (k - 1) * GAP + 14;
  const labelCol = Math.min(Math.max(...data.labels.map((l) => textWidth(l, FONT))) + 12, width * 0.4);
  const padR = 16;
  const padT = 6;
  const padB = 22;
  const iw = Math.max(40, width - labelCol - padR);
  const H = padT + n * rowH + padB;
  const d0 = ticks[0];
  const d1 = ticks[ticks.length - 1];
  const x = (v: number) => labelCol + iw * ((v - d0) / (d1 - d0 || 1));
  const base = x(Math.max(d0, Math.min(d1, 0)));

  const marks: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const top = padT + i * rowH + 7;
    if (stacked) {
      let pos = 0;
      let neg = 0;
      const lastPos = lastIndex(series, i, (v) => v > 0);
      const lastNeg = lastIndex(series, i, (v) => v < 0);
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v === null || v === 0) return;
        const from = v > 0 ? pos : neg;
        const to = from + v;
        if (v > 0) pos = to;
        else neg = to;
        const start = x(from) + (from === 0 ? 0 : v > 0 ? GAP : -GAP);
        const end = si === (v > 0 ? lastPos : lastNeg);
        marks.push(
          <path
            key={`s-${si}-${i}`}
            className="chart-bar"
            d={barPath(top, barW, start, x(to), true, end ? 4 : 0)}
            fill={seriesColor(si)}
            opacity={hover === null || hover === i ? 1 : 0.55}
          />
        );
      });
    } else {
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v === null) return;
        marks.push(
          <path
            key={`b-${si}-${i}`}
            className="chart-bar"
            d={barPath(top + si * (barW + GAP), barW, base, x(v), true)}
            fill={seriesColor(si)}
            opacity={hover === null || hover === i ? 1 : 0.55}
          />
        );
      });
    }
  }

  const tip: TooltipState | null =
    hover === null
      ? null
      : {
          x: labelCol + iw / 2,
          y: padT + hover * rowH,
          place: 'above',
          title: data.labels[hover],
          rows: series
            .map((s, si) => ({ s, si, v: s.values[hover] }))
            .filter((r) => r.v !== null)
            .map(({ s, si, v }) => ({
              color: seriesColor(si),
              name: series.length > 1 ? s.name : '',
              value: formatValue(v as number, unit),
              key: 'box' as const
            }))
        };

  return (
    <div className="chart-plot">
      <svg
        width={width}
        height={H}
        className="chart-svg"
        role="img"
        aria-label={title ?? 'chart'}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHover((h) => (h === null ? 0 : Math.min(n - 1, h + 1)));
          else if (e.key === 'ArrowUp') setHover((h) => (h === null ? n - 1 : Math.max(0, h - 1)));
          else if (e.key === 'Escape') setHover(null);
          else return;
          e.preventDefault();
        }}
        onBlur={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <g key={`t-${t}`}>
            <line className="chart-grid" x1={x(t)} x2={x(t)} y1={padT} y2={H - padB} />
            <text
              className="chart-axis"
              x={x(t)}
              y={H - 6}
              textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
            >
              {tickLabels[i]}
            </text>
          </g>
        ))}
        {hover !== null && <rect className="chart-band" x={0} y={padT + hover * rowH} width={width} height={rowH} />}
        {marks}
        <line className="chart-baseline" x1={base} x2={base} y1={padT} y2={H - padB} />
        {data.labels.map((l, i) => (
          <text key={`y-${i}`} className="chart-axis chart-axis-cat" x={labelCol - 10} y={padT + i * rowH + rowH / 2 + 4} textAnchor="end">
            {truncate(l, labelCol - 12)}
          </text>
        ))}
        <rect
          className="chart-hit"
          x={0}
          y={padT}
          width={width}
          height={n * rowH}
          onPointerMove={(e) => {
            const svg = e.currentTarget.ownerSVGElement;
            if (!svg) return;
            const i = Math.floor((e.clientY - svg.getBoundingClientRect().top - padT) / rowH);
            setHover(i >= 0 && i < n ? i : null);
          }}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {tip && <Tooltip tip={tip} width={width} />}
    </div>
  );
}

// ---- donut ------------------------------------------------------------------

function Donut({ data, unit, width, title }: { data: ChartData; unit?: string; width: number; title?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const slices = donutSlices(data.labels, data.series[0].values);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (!slices.length || total <= 0) return <div className="chart-error">Nothing to chart: every value is zero or negative.</div>;
  const size = Math.min(200, Math.max(140, width * 0.45));
  const R = size / 2;
  const r = R * 0.62;
  const cx = R;
  const cy = R;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    return { s, i, d: arcPath(cx, cy, R, r, a0, a1), mid: (a0 + a1) / 2 };
  });
  const hovered = hover === null ? null : arcs[hover];
  const pct = (v: number) => `${Math.round((v / total) * 1000) / 10}%`;

  return (
    <div className="chart-donut">
      <div className="chart-plot" style={{ width: size }}>
        <svg width={size} height={size} className="chart-svg" role="img" aria-label={title ?? 'chart'}>
          {arcs.map(({ s, i, d }) => (
            <path
              key={i}
              className="chart-slice"
              d={d}
              fill={seriesColor(s.slot)}
              opacity={hover === null || hover === i ? 1 : 0.55}
              tabIndex={0}
              aria-label={`${s.label}: ${formatValue(s.value, unit)} (${pct(s.value)})`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
          ))}
          <text className="chart-donut-total" x={cx} y={cy + 2} textAnchor="middle">
            {formatCompact(hovered ? hovered.s.value : total, unit)}
          </text>
          <text className="chart-axis" x={cx} y={cy + 18} textAnchor="middle">
            {hovered ? pct(hovered.s.value) : 'Total'}
          </text>
        </svg>
      </div>
      <ul className="chart-donut-list">
        {slices.map((s, i) => (
          <li key={i} className={hover === i ? 'active' : undefined} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <span className="chart-key chart-key-box" style={{ background: seriesColor(s.slot) }} aria-hidden="true" />
            <span className="chart-donut-label">{s.label}</span>
            <strong>{formatValue(s.value, unit)}</strong>
            <span className="chart-donut-pct">{pct(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function arcPath(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  // A full circle can't be one arc: split it in two.
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    const mid = a0 + Math.PI;
    return `${arcPath(cx, cy, R, r, a0, mid)} ${arcPath(cx, cy, R, r, mid, a1)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (rad: number, a: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
  return `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
}

// ---- scatter ----------------------------------------------------------------

function Scatter({ data, unit, width, title }: { data: ChartData; unit?: string; width: number; title?: string }) {
  const [hover, setHover] = useState<{ si: number; i: number } | null>(null);
  // x is the first column when it's numeric; with a text column first (point
  // names), x is the first numeric column and the names label the points.
  const xs = data.xs ?? data.series[0].values;
  const xName = data.xs ? data.xName : data.series[0].name;
  const ys = (data.xs ? data.series : data.series.slice(1)).slice(0, MAX_SCATTER_SERIES);
  const named = !data.xs;

  const finite = (vals: Array<number | null>) => vals.filter((v): v is number => v !== null);
  const xVals = finite(xs);
  const yVals = ys.flatMap((s) => finite(s.values));
  if (!xVals.length || !yVals.length) return <div className="chart-error">Could not read chart data.</div>;
  const xt = niceTicks(Math.min(...xVals), Math.max(...xVals), 5);
  const yt = niceTicks(Math.min(...yVals), Math.max(...yVals), 4);
  const yLabels = yt.map((t) => formatCompact(t, unit));
  const padL = Math.ceil(Math.max(...yLabels.map((t) => textWidth(t, FONT)))) + 10;
  const padR = 14;
  const padT = 10;
  const padB = 38;
  const H = PLOT_HEIGHT + 12;
  const iw = Math.max(40, width - padL - padR);
  const ih = H - padT - padB;
  const x = (v: number) => padL + iw * ((v - xt[0]) / (xt[xt.length - 1] - xt[0] || 1));
  const y = (v: number) => padT + ih * (1 - (v - yt[0]) / (yt[yt.length - 1] - yt[0] || 1));

  const points = ys.flatMap((s, si) =>
    s.values.flatMap((v, i) => (v === null || xs[i] === null ? [] : [{ si, i, px: x(xs[i] as number), py: y(v), v }]))
  );
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Nearest point within 24px: the reader only has to be closest.
    let best: (typeof points)[number] | null = null;
    let bestD = 24 * 24;
    for (const p of points) {
      const d = (p.px - mx) ** 2 + (p.py - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    setHover(best ? { si: best.si, i: best.i } : null);
  };
  const hp = hover ? points.find((p) => p.si === hover.si && p.i === hover.i) : null;
  const tip: TooltipState | null = hp
    ? {
        x: hp.px,
        y: hp.py - 10,
        place: 'above',
        title: named ? data.labels[hp.i] : ys.length > 1 ? ys[hp.si].name : '',
        rows: [
          { color: seriesColor(hp.si), name: ys[hp.si].name, value: formatValue(hp.v, unit), key: 'line' },
          { color: 'transparent', name: xName, value: formatValue(xs[hp.i] as number), key: 'line' }
        ]
      }
    : null;

  return (
    <div className="chart-plot">
      <svg width={width} height={H} className="chart-svg" role="img" aria-label={title ?? 'chart'}>
        {yt.map((t, i) => (
          <g key={`y-${t}`}>
            <line className="chart-grid" x1={padL} x2={padL + iw} y1={y(t)} y2={y(t)} />
            <text className="chart-axis" x={padL - 8} y={y(t) + 4} textAnchor="end">
              {yLabels[i]}
            </text>
          </g>
        ))}
        {xt.map((t, i) => (
          <text
            key={`x-${t}`}
            className="chart-axis"
            x={x(t)}
            y={padT + ih + 16}
            textAnchor={i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle'}
          >
            {formatCompact(t)}
          </text>
        ))}
        <text className="chart-axis chart-axis-title" x={padL + iw / 2} y={H - 4} textAnchor="middle">
          {xName}
        </text>
        {points.map((p) => (
          <circle
            key={`p-${p.si}-${p.i}`}
            className="chart-dot"
            cx={p.px}
            cy={p.py}
            r={hp === p ? 5.5 : 4}
            fill={seriesColor(p.si)}
          />
        ))}
        <rect
          className="chart-hit"
          x={padL}
          y={padT}
          width={iw}
          height={ih}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {tip && <Tooltip tip={tip} width={width} />}
    </div>
  );
}

// ---- table view ---------------------------------------------------------------

function ChartTable({ data, unit }: { data: ChartData; unit?: string }) {
  return (
    <div className="data-table-scroll chart-table">
      <table>
        <thead>
          <tr>
            <th>{data.xName}</th>
            {data.series.map((s) => (
              <th key={s.name}>{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.labels.map((l, i) => (
            <tr key={i}>
              <td>{l}</td>
              {data.series.map((s) => (
                <td key={s.name} className="num">
                  {s.values[i] === null ? '' : formatValue(s.values[i] as number, unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- helpers ------------------------------------------------------------------

function pathSegments(
  values: Array<number | null>,
  xAt: (i: number) => number,
  y: (v: number) => number
): Array<Array<[number, number]>> {
  // A missing value breaks the line rather than drawing it through zero.
  const out: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) out.push(cur);
      cur = [];
      return;
    }
    cur.push([xAt(i), y(v)]);
  });
  if (cur.length) out.push(cur);
  return out;
}

function lastIndex(series: ChartData['series'], i: number, test: (v: number) => boolean): number {
  for (let si = series.length - 1; si >= 0; si--) {
    const v = series[si].values[i];
    if (v !== null && test(v)) return si;
  }
  return -1;
}

function truncate(label: string, room: number): string {
  if (textWidth(label, FONT) <= room) return label;
  const chars = Math.max(1, Math.floor(room / (FONT * 0.58)) - 1);
  return `${label.slice(0, chars)}…`;
}
