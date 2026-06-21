import type { ReactElement, ReactNode } from 'react';
import { Children, Fragment, isValidElement, useMemo, useState } from 'react';
import { useMdxActions } from './ActionContext';

// The fixed, vetted component library. The MDX renderer will ONLY instantiate
// components whose tag name appears in `componentMap`; anything else renders as
// inert text. None of these execute model-supplied code.

type CalloutType = 'info' | 'warn' | 'success' | 'danger';

export function Callout({ type, children }: { type?: string; children?: ReactNode }) {
  const kind: CalloutType = (['info', 'warn', 'success', 'danger'] as const).includes(type as CalloutType)
    ? (type as CalloutType)
    : 'info';
  return <div className={`callout callout-${kind}`}>{children}</div>;
}

export function Steps({ children }: { children?: ReactNode }) {
  return <ol className="steps">{children}</ol>;
}

export function Step({ children }: { children?: ReactNode }) {
  return <li className="step">{children}</li>;
}

export function Collapsible({ title, children }: { title?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`collapsible${open ? ' open' : ''}`}>
      <button type="button" className="collapsible-header" onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-caret">{open ? '▾' : '▸'}</span>
        {title ?? 'Details'}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export function CodeBlock({ lang, value }: { lang?: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="code-block-wrap">
      <button
        type="button"
        className="code-copy"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="code-block" data-lang={lang ?? ''}>
        <code>{value}</code>
      </pre>
    </div>
  );
}

// ---- Tabs -----------------------------------------------------------------

// <Tab> renders this marker so <Tabs> can introspect label + content via
// React.Children without coupling to the parser AST. Rendered standalone (no
// parent <Tabs>) it still shows its content.
export function TabPanel({ label, children }: { label?: string; children?: ReactNode }) {
  return <div className="tab-panel" data-label={label}>{children}</div>;
}

// Find all marker children of a given component type. The renderer wraps each
// component result in a keyed <Fragment>, and MDX wraps adjacent inline JSX in a
// host <p>, so markers sit inside Fragment / host-element wrappers. We descend
// through Fragments and host (string-typed) elements — but NOT into other
// components — so collected matches aren't recursed into and nested compound
// components stay isolated.
function collectByType<P>(children: ReactNode, type: unknown): ReactElement<P>[] {
  const out: ReactElement<P>[] = [];
  const visit = (nodes: ReactNode) => {
    Children.toArray(nodes).forEach((c) => {
      if (!isValidElement(c)) return;
      if (c.type === type) {
        out.push(c as ReactElement<P>);
        return;
      }
      if (c.type === Fragment || typeof c.type === 'string') {
        visit((c.props as { children?: ReactNode }).children);
      }
    });
  };
  visit(children);
  return out;
}

export function Tabs({ children }: { children?: ReactNode }) {
  const [active, setActive] = useState(0);
  const panels = collectByType<{ label?: string; children?: ReactNode }>(children, TabPanel);
  if (panels.length === 0) return <div className="tabs">{children}</div>;
  const current = Math.min(active, panels.length - 1);
  return (
    <div className="tabs">
      <div className="tab-bar" role="tablist">
        {panels.map((p, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === current}
            className={`tab${i === current ? ' active' : ''}`}
            onClick={() => setActive(i)}
          >
            {p.props.label ?? `Tab ${i + 1}`}
          </button>
        ))}
      </div>
      <div className="tab-body">{panels[current].props.children}</div>
    </div>
  );
}

// ---- DataTable ------------------------------------------------------------

type Row = Record<string, unknown>;

// Parse the JSON data child into columns + rows. Accepts either an array of
// objects, or { columns: [...], rows: [[...], ...] }. Pure JSON.parse — no eval.
function parseTable(raw: string | undefined): { columns: string[]; rows: Row[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const columns: string[] = [];
      for (const r of parsed) {
        if (r && typeof r === 'object') {
          for (const k of Object.keys(r as Row)) if (!columns.includes(k)) columns.push(k);
        }
      }
      return { columns, rows: parsed as Row[] };
    }
    if (parsed && Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      const columns = parsed.columns.map(String);
      const rows = (parsed.rows as unknown[][]).map((arr) => {
        const o: Row = {};
        columns.forEach((c: string, i: number) => (o[c] = arr[i]));
        return o;
      });
      return { columns, rows };
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// Numeric-aware comparison: sort as numbers when both sides parse, else as text.
function compareCells(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && cellText(a) !== '' && cellText(b) !== '') {
    return na - nb;
  }
  return cellText(a).localeCompare(cellText(b));
}

export function DataTable({ data, caption }: { data?: string; caption?: string }) {
  const table = useMemo(() => parseTable(data), [data]);
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');

  if (!table || table.columns.length === 0) {
    return <div className="data-table-error">Could not read table data.</div>;
  }

  const needle = filter.trim().toLowerCase();
  let rows = needle
    ? table.rows.filter((r) =>
        table.columns.some((c) => cellText(r[c]).toLowerCase().includes(needle))
      )
    : table.rows.slice();
  if (sort) {
    rows = rows.slice().sort((a, b) => sort.dir * compareCells(a[sort.col], b[sort.col]));
  }

  const toggleSort = (col: string) =>
    setSort((prev) =>
      prev && prev.col === col ? { col, dir: prev.dir === 1 ? -1 : 1 } : { col, dir: 1 }
    );

  return (
    <div className="data-table">
      <div className="data-table-tools">
        <input
          className="data-table-filter"
          type="text"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {caption && <span className="data-table-caption">{caption}</span>}
      </div>
      <div className="data-table-scroll">
        <table>
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c}>
                  <button type="button" className="data-table-sort" onClick={() => toggleSort(c)}>
                    {c}
                    <span className="data-table-caret">
                      {sort && sort.col === c ? (sort.dir === 1 ? '▲' : '▼') : '↕'}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {table.columns.map((c) => (
                  <td key={c}>{cellText(r[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Chart (hand-rolled SVG, no dependency) -------------------------------

type Point = { label: string; value: number };

function parseSeries(raw: string | undefined): Point[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const pts = parsed
        .map((d) => ({ label: String((d as Point)?.label ?? ''), value: Number((d as Point)?.value) }))
        .filter((d) => Number.isFinite(d.value));
      return pts.length ? pts : null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function Chart({ type, title, data }: { type?: string; title?: string; data?: string }) {
  const series = useMemo(() => parseSeries(data), [data]);
  if (!series) return <div className="chart-error">Could not read chart data.</div>;

  const kind = type === 'bar' ? 'bar' : type === 'area' ? 'area' : 'line';
  const W = 520;
  const H = 200;
  const padL = 40;
  const padR = 14;
  const padT = 12;
  const padB = 30;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const n = series.length;

  const max = Math.max(0, ...series.map((d) => d.value));
  const min = Math.min(0, ...series.map((d) => d.value));
  const span = max - min || 1;
  const y = (v: number) => padT + ih - ((v - min) / span) * ih;
  const baseline = y(min);

  // Line/area: points spread across the full width. Bars: centered in slots.
  const lineX = (i: number) => (n === 1 ? padL + iw / 2 : padL + (i / (n - 1)) * iw);
  const slot = iw / n;
  const barW = slot * 0.62;
  const labelStep = Math.max(1, Math.ceil(n / 9));

  const linePoints = series.map((d, i) => `${lineX(i)},${y(d.value)}`).join(' ');
  const areaPath = `M ${lineX(0)},${baseline} ` +
    series.map((d, i) => `L ${lineX(i)},${y(d.value)}`).join(' ') +
    ` L ${lineX(n - 1)},${baseline} Z`;

  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

  return (
    <figure className="chart">
      {title && <figcaption className="chart-title">{title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={title ?? 'chart'}>
        {/* y-axis range labels + baseline */}
        <text className="chart-axis" x={padL - 6} y={y(max) + 4} textAnchor="end">{fmt(max)}</text>
        <text className="chart-axis" x={padL - 6} y={y(min) + 4} textAnchor="end">{fmt(min)}</text>
        <line className="chart-baseline" x1={padL} y1={baseline} x2={W - padR} y2={baseline} />

        {kind === 'area' && <path className="chart-area" d={areaPath} />}
        {(kind === 'line' || kind === 'area') && (
          <>
            <polyline className="chart-line" points={linePoints} fill="none" />
            {series.map((d, i) => (
              <circle key={i} className="chart-dot" cx={lineX(i)} cy={y(d.value)} r={2.5}>
                <title>{`${d.label}: ${fmt(d.value)}`}</title>
              </circle>
            ))}
          </>
        )}
        {kind === 'bar' &&
          series.map((d, i) => {
            const x = padL + i * slot + (slot - barW) / 2;
            const top = Math.min(y(d.value), baseline);
            const h = Math.abs(baseline - y(d.value));
            return (
              <rect key={i} className="chart-bar" x={x} y={top} width={barW} height={h} rx={2}>
                <title>{`${d.label}: ${fmt(d.value)}`}</title>
              </rect>
            );
          })}

        {/* x labels (thinned when crowded) */}
        {series.map((d, i) =>
          i % labelStep === 0 ? (
            <text
              key={i}
              className="chart-axis"
              x={kind === 'bar' ? padL + (i + 0.5) * slot : lineX(i)}
              y={H - 10}
              textAnchor="middle"
            >
              {d.label}
            </text>
          ) : null
        )}
      </svg>
    </figure>
  );
}

// ---- Interactive: Quiz (feeds results back to the assistant) --------------

// Recursively flatten a ReactNode to its plain text — used to read a choice's
// label and compare it against the question's `answer`.
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

// Marker components: the parent (<Quiz>) introspects these via React.Children.
export function QuizChoice({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
export function QuizQuestion(props: { prompt?: string; answer?: string; children?: ReactNode }) {
  return <>{props.children}</>;
}

export function Quiz({ topic, children }: { topic?: string; children?: ReactNode }) {
  const actions = useMdxActions();
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState(false);
  const [sent, setSent] = useState(false);

  const questions = collectByType<{ prompt?: string; answer?: string; children?: ReactNode }>(
    children,
    QuizQuestion
  );
  if (questions.length === 0) return <div className="quiz">{children}</div>;

  const choicesOf = (q: ReactElement<{ children?: ReactNode }>) =>
    collectByType<{ children?: ReactNode }>(q.props.children, QuizChoice);
  const correctAnswer = (q: ReactElement<{ answer?: string }>) => (q.props.answer ?? '').trim().toLowerCase();
  const isCorrect = (qi: number, q: ReactElement<{ answer?: string; children?: ReactNode }>) => {
    const sel = selected[qi];
    if (sel === undefined) return false;
    return nodeText(choicesOf(q)[sel]).trim().toLowerCase() === correctAnswer(q);
  };

  const allAnswered = questions.every((_, qi) => selected[qi] !== undefined);
  const score = questions.reduce((acc, q, qi) => acc + (isCorrect(qi, q) ? 1 : 0), 0);

  // Only ever fires from the user's click — never on render — so the assistant
  // cannot trigger its own follow-up turns.
  const explain = () => {
    if (!actions || actions.running || sent) return;
    const wrong = questions
      .map((q, qi) => ({ q, qi }))
      .filter(({ q, qi }) => !isCorrect(qi, q))
      .map(({ q, qi }) => {
        const sel = selected[qi];
        const chosen = sel === undefined ? '(no answer)' : nodeText(choicesOf(q)[sel]).trim();
        return `- "${q.props.prompt ?? `Question ${qi + 1}`}" — I answered "${chosen}" (correct: "${q.props.answer ?? ''}").`;
      });
    const head = `I took the ${topic ? `${topic} ` : ''}quiz and scored ${score}/${questions.length}.`;
    const body = wrong.length
      ? `\nI got these wrong:\n${wrong.join('\n')}\nPlease explain the ones I missed.`
      : `\nI got them all right — anything else worth knowing about ${topic ?? 'this topic'}?`;
    actions.submit(`${head}${body}`);
    setSent(true);
  };

  return (
    <div className="quiz">
      {topic && <div className="quiz-topic">{topic}</div>}
      {questions.map((q, qi) => (
        <div className="quiz-q" key={qi}>
          <div className="quiz-prompt">{q.props.prompt ?? `Question ${qi + 1}`}</div>
          <div className="quiz-choices">
            {choicesOf(q).map((c, ci) => {
              const picked = selected[qi] === ci;
              const correct = checked && nodeText(c).trim().toLowerCase() === correctAnswer(q);
              const wrongPick = checked && picked && !correct;
              const cls = ['quiz-choice', picked ? 'picked' : '', correct ? 'correct' : '', wrongPick ? 'wrong' : '']
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={ci}
                  type="button"
                  className={cls}
                  disabled={checked}
                  onClick={() => setSelected((s) => ({ ...s, [qi]: ci }))}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="quiz-actions">
        {!checked ? (
          <button
            type="button"
            className="quiz-btn primary"
            onClick={() => setChecked(true)}
            disabled={!allAnswered}
          >
            Check answers
          </button>
        ) : (
          <>
            <span className="quiz-score">Score: {score}/{questions.length}</span>
            {actions && (
              <button
                type="button"
                className="quiz-btn"
                onClick={explain}
                disabled={actions.running || sent}
              >
                {sent ? 'Sent to Stem' : 'Explain what I missed'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---- Interactive: Form (collects fields, sends them to the assistant) ------

// Marker: <Form> reads these and renders the real inputs itself.
export function FormField(_props: {
  name?: string;
  label?: string;
  placeholder?: string;
  type?: string;
}) {
  return null;
}

export function Form({
  prompt,
  submitLabel,
  children
}: {
  prompt?: string;
  submitLabel?: string;
  children?: ReactNode;
}) {
  const actions = useMdxActions();
  const [values, setValues] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  const fields = collectByType<{ name?: string; label?: string; placeholder?: string; type?: string }>(
    children,
    FormField
  );
  if (fields.length === 0) return <div className="mdx-form">{children}</div>;

  const keyOf = (f: ReactElement<{ name?: string; label?: string }>, i: number) =>
    f.props.name ?? f.props.label ?? `field-${i}`;

  const submit = () => {
    if (!actions || actions.running || sent) return;
    const lines = fields.map((f, i) => {
      const key = keyOf(f, i);
      const label = f.props.label ?? f.props.name ?? key;
      return `- ${label}: ${values[key] ?? ''}`;
    });
    actions.submit(`${prompt ? `${prompt}\n` : ''}${lines.join('\n')}`);
    setSent(true);
  };

  return (
    <div className="mdx-form">
      {prompt && <div className="mdx-form-prompt">{prompt}</div>}
      {fields.map((f, i) => {
        const key = keyOf(f, i);
        const label = f.props.label ?? f.props.name ?? key;
        const type = f.props.type ?? 'text';
        return (
          <label className="mdx-field" key={key}>
            <span className="mdx-field-label">{label}</span>
            {type === 'textarea' ? (
              <textarea
                value={values[key] ?? ''}
                placeholder={f.props.placeholder}
                rows={3}
                disabled={sent}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              />
            ) : (
              <input
                type={type === 'number' ? 'number' : 'text'}
                value={values[key] ?? ''}
                placeholder={f.props.placeholder}
                disabled={sent}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              />
            )}
          </label>
        );
      })}
      {actions && (
        <button
          type="button"
          className="mdx-form-submit"
          onClick={submit}
          disabled={actions.running || sent}
        >
          {sent ? 'Sent' : submitLabel ?? 'Submit'}
        </button>
      )}
    </div>
  );
}

type DataChild = { lang?: string; value: string };
type ComponentEntry = (
  props: Record<string, string>,
  children: ReactNode,
  data?: DataChild
) => ReactNode;

/** Allow-list of model-usable components, keyed by tag name. */
export const componentMap: Record<string, ComponentEntry> = {
  Callout: (props, children) => <Callout type={props.type}>{children}</Callout>,
  Steps: (_props, children) => <Steps>{children}</Steps>,
  Step: (_props, children) => <Step>{children}</Step>,
  Collapsible: (props, children) => <Collapsible title={props.title}>{children}</Collapsible>,
  Tabs: (_props, children) => <Tabs>{children}</Tabs>,
  Tab: (props, children) => <TabPanel label={props.label}>{children}</TabPanel>,
  DataTable: (props, _children, data) => <DataTable data={data?.value} caption={props.caption} />,
  Chart: (props, _children, data) => <Chart type={props.type} title={props.title} data={data?.value} />,
  Quiz: (props, children) => <Quiz topic={props.topic}>{children}</Quiz>,
  Question: (props, children) => (
    <QuizQuestion prompt={props.prompt} answer={props.answer}>{children}</QuizQuestion>
  ),
  Choice: (_props, children) => <QuizChoice>{children}</QuizChoice>,
  Form: (props, children) => (
    <Form prompt={props.prompt} submitLabel={props.submitLabel}>{children}</Form>
  ),
  Field: (props) => (
    <FormField name={props.name} label={props.label} placeholder={props.placeholder} type={props.type} />
  )
};
