import type { ReactElement, ReactNode } from 'react';
import { Check, Copy, MessageCircleQuestion } from 'lucide-react';
import { Children, Fragment, isValidElement, useEffect, useMemo, useRef, useState } from 'react';
import { useMdxActions } from './ActionContext';
import { readFormDraft, useFormHost, useMdxSource, writeFormDraft, type FieldValue, type FormDraft } from './FormHost';
import { FactChange } from './FactChange';
import { parseTable } from './data';
import { Chart } from './chart/Chart';
import { Stats } from './Stats';
import { Compare } from './Compare';
import { Diagram } from './Diagram';
import { Replies, Reply } from './Replies';
import { highlightCode } from './highlight';
import { DiffBlock } from './DiffBlock';
export { Chart };

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

// What a component still being streamed shows in its place. Keyed by tag name;
// a name not listed (or one still being typed) gets the generic line.
const PLACEHOLDER_LABELS: Record<string, string> = {
  Chart: 'Drawing chart…',
  DataTable: 'Building table…',
  Quiz: 'Writing quiz…',
  Form: 'Preparing form…',
  Stats: 'Adding up…',
  Compare: 'Lining up the options…',
  Diagram: 'Drawing diagram…',
  Tabs: 'Writing…',
  Collapsible: 'Writing…'
};

export function MdxPlaceholder({ name }: { name: string }) {
  // Suggested replies appear once the reply is done, or not at all.
  if (name === 'Replies' || name === 'Reply') return null;
  return (
    <div className="mdx-placeholder" role="status" aria-live="polite">
      <span className="mdx-placeholder-bar" aria-hidden="true" />
      <span className="mdx-placeholder-label">{PLACEHOLDER_LABELS[name] ?? 'Writing…'}</span>
    </div>
  );
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

const DIFF_LANGS = new Set(['diff', 'patch', 'udiff']);
/** Past this size a diff renders as a plain code block: one table row per line gets slow. */
const MAX_DIFF_CHARS = 60_000;

export function CodeBlock({ lang, value }: { lang?: string; value: string }) {
  const name = lang?.trim().toLowerCase();
  if (name && DIFF_LANGS.has(name) && value.length <= MAX_DIFF_CHARS) return <DiffBlock value={value} />;
  return <PlainCodeBlock lang={lang} value={value} />;
}

function PlainCodeBlock({ lang, value }: { lang?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const colored = useMemo(() => highlightCode(lang, value), [lang, value]);

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
        title={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <pre className="code-block" data-lang={lang ?? ''}>
        <code>{colored ?? value}</code>
      </pre>
    </div>
  );
}

// ---- Task list item (GFM `- [ ]` / `- [x]`) -------------------------------

// Interactive checklist item rendered for GFM task-list markdown. The marker in
// the text sets the initial state; ticking is local UI state so the user can
// track progress while reading — nothing is sent back to the assistant.
export function TaskItem({ checked, children }: { checked?: boolean; children?: ReactNode }) {
  const [done, setDone] = useState(checked ?? false);
  return (
    <li className={`task-item${done ? ' done' : ''}`}>
      <input
        type="checkbox"
        className="task-check"
        checked={done}
        aria-label={done ? 'Mark as not done' : 'Mark as done'}
        onChange={(e) => setDone(e.target.checked)}
      />
      <div className="task-item-body">{children}</div>
    </li>
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
export function collectByType<P>(children: ReactNode, type: unknown): ReactElement<P>[] {
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

// Markers: <Form> reads these and renders the real inputs itself.
export function FormField(_props: {
  name?: string;
  label?: string;
  placeholder?: string;
  type?: string;
  hint?: string;
  multiple?: string;
  other?: string;
  children?: ReactNode;
}) {
  return null;
}

export function FormOption({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

type FieldProps = Parameters<typeof FormField>[0];

interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'choice';
  placeholder?: string;
  hint?: string;
  options: string[];
  multiple: boolean;
  other: boolean;
}

function fieldSpecs(children: ReactNode): FieldSpec[] {
  return collectByType<FieldProps>(children, FormField).map((f, i) => {
    const p = f.props;
    const key = p.name ?? p.label ?? `field-${i}`;
    const options = collectByType<{ children?: ReactNode }>(p.children, FormOption)
      .map((o) => nodeText(o.props.children).trim())
      .filter(Boolean);
    const type = p.type === 'textarea' || p.type === 'number' ? p.type : p.type === 'choice' || options.length ? 'choice' : 'text';
    return {
      key,
      label: p.label ?? p.name ?? key,
      type,
      placeholder: p.placeholder,
      hint: p.hint,
      options,
      multiple: p.multiple === 'true',
      other: p.other === 'true'
    };
  });
}

const OTHER = '__other';

function answerOf(f: FieldSpec, draft: FormDraft): string {
  const v = draft.values[f.key];
  if (f.type !== 'choice') return typeof v === 'string' ? v.trim() : '';
  const picked = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
  return picked
    .map((x) => (x === OTHER ? (draft.others[f.key] ?? '').trim() : x))
    .filter(Boolean)
    .join(', ');
}

/** The answers as one readable message: the prompt, then a line per field. */
export function formAnswerText(prompt: string | undefined, fields: FieldSpec[], draft: FormDraft): string {
  const lines = fields.map((f) => `- ${f.label}: ${answerOf(f, draft) || '(skipped)'}`);
  return `${prompt ? `${prompt}\n` : ''}${lines.join('\n')}`;
}

const ASK_TITLE = 'Ask about this question. Your answers so far are kept.';

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
  const host = useFormHost();
  const source = useMdxSource();
  const fields = fieldSpecs(children);
  const key = `${source}|${prompt ?? ''}|${fields.map((f) => f.key).join(',')}`;
  const [draft, setDraftState] = useState<FormDraft>(() => readFormDraft(key));
  const rootRef = useRef<HTMLDivElement>(null);
  const setDraft = (next: FormDraft) => {
    setDraftState(next);
    if (source) writeFormDraft(key, next);
  };
  const answered = fields.filter((f) => answerOf(f, draft)).length;
  const live = !!actions && !draft.sent;

  const submit = () => {
    if (!actions || actions.running || draft.sent || answered === 0) return;
    actions.submit(formAnswerText(prompt, fields, draft));
    setDraft({ ...draft, sent: true });
  };
  // Latest closures for the host: it calls send() from the answer bar.
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    if (!host || !live || fields.length === 0) return;
    return host.register({
      key,
      answered,
      total: fields.length,
      send: () => submitRef.current(),
      reveal: () => {
        const el = rootRef.current;
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.remove('mdx-form-flash');
        void el.offsetWidth;
        el.classList.add('mdx-form-flash');
      },
      el: () => rootRef.current
    });
  }, [host, live, key, answered, fields.length]);

  if (fields.length === 0) return <div className="mdx-form">{children}</div>;
  // Read where nothing can be sent back (a fact's source): show what is being
  // asked, and how to answer, instead of inputs that go nowhere.
  if (!actions) {
    return (
      <div className="mdx-form mdx-form-readonly">
        {prompt && <div className="mdx-form-prompt">{prompt}</div>}
        <ul>
          {fields.map((f) => (
            <li key={f.key}>
              {f.label}
              {f.options.length > 0 && <span className="mdx-field-hint"> ({f.options.join(' / ')})</span>}
            </li>
          ))}
        </ul>
        <div className="mdx-form-note">Reply with these to answer.</div>
      </div>
    );
  }

  const setValue = (f: FieldSpec, value: FieldValue) =>
    setDraft({ ...draft, values: { ...draft.values, [f.key]: value } });
  const pick = (f: FieldSpec, option: string) => {
    const cur = draft.values[f.key];
    if (f.multiple) {
      const list = Array.isArray(cur) ? cur : [];
      setValue(f, list.includes(option) ? list.filter((x) => x !== option) : [...list, option]);
    } else {
      setValue(f, cur === option ? '' : option);
    }
  };
  const isPicked = (f: FieldSpec, option: string) => {
    const cur = draft.values[f.key];
    return Array.isArray(cur) ? cur.includes(option) : cur === option;
  };
  const locked = draft.sent;

  return (
    <div className={`mdx-form${locked ? ' sent' : ''}`} ref={rootRef}>
      {prompt && <div className="mdx-form-prompt">{prompt}</div>}
      {fields.map((f) => (
        <div className="mdx-field" key={f.key}>
          <div className="mdx-field-head">
            <span className="mdx-field-label">{f.label}</span>
            {host && !locked && (
              <button type="button" className="mdx-field-ask" title={ASK_TITLE} onClick={() => host.ask(f.label)}>
                <MessageCircleQuestion size={13} /> Ask
              </button>
            )}
          </div>
          {f.hint && <div className="mdx-field-hint">{f.hint}</div>}
          {f.type === 'choice' ? (
            <>
              <div className="mdx-choices" role="group" aria-label={f.label}>
                {f.options.map((o) => (
                  <button
                    key={o}
                    type="button"
                    className="mdx-choice"
                    aria-pressed={isPicked(f, o)}
                    disabled={locked}
                    onClick={() => pick(f, o)}
                  >
                    {o}
                  </button>
                ))}
                {f.other && (
                  <button
                    type="button"
                    className="mdx-choice"
                    aria-pressed={isPicked(f, OTHER)}
                    disabled={locked}
                    onClick={() => pick(f, OTHER)}
                  >
                    Other…
                  </button>
                )}
              </div>
              {f.other && isPicked(f, OTHER) && (
                <input
                  className="mdx-choice-other"
                  value={draft.others[f.key] ?? ''}
                  placeholder="Your answer"
                  disabled={locked}
                  autoFocus={!locked}
                  onChange={(e) => setDraft({ ...draft, others: { ...draft.others, [f.key]: e.target.value } })}
                />
              )}
            </>
          ) : f.type === 'textarea' ? (
            <textarea
              value={typeof draft.values[f.key] === 'string' ? (draft.values[f.key] as string) : ''}
              placeholder={f.placeholder}
              rows={3}
              disabled={locked}
              onChange={(e) => setValue(f, e.target.value)}
            />
          ) : (
            <input
              type={f.type === 'number' ? 'number' : 'text'}
              value={typeof draft.values[f.key] === 'string' ? (draft.values[f.key] as string) : ''}
              placeholder={f.placeholder}
              disabled={locked}
              onChange={(e) => setValue(f, e.target.value)}
            />
          )}
        </div>
      ))}
      {locked ? (
        <div className="mdx-form-foot sent">
          <Check size={13} /> Answers sent
        </div>
      ) : host ? (
        <div className="mdx-form-foot">
          {answered} of {fields.length} answered · skip any you are unsure about · send from the bar{' '}
          {host.place === 'below' ? 'below' : 'above'}
        </div>
      ) : (
        <button
          type="button"
          className="mdx-form-submit"
          onClick={submit}
          disabled={actions.running || answered === 0}
        >
          {submitLabel ?? 'Submit'}
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
  Chart: (props, _children, data) => (
    <Chart type={props.type} title={props.title} unit={props.unit} data={data?.value} />
  ),
  Quiz: (props, children) => <Quiz topic={props.topic}>{children}</Quiz>,
  Question: (props, children) => (
    <QuizQuestion prompt={props.prompt} answer={props.answer}>{children}</QuizQuestion>
  ),
  Choice: (_props, children) => <QuizChoice>{children}</QuizChoice>,
  Form: (props, children) => (
    <Form prompt={props.prompt} submitLabel={props.submitLabel}>{children}</Form>
  ),
  Field: (props, children) => (
    <FormField
      name={props.name}
      label={props.label}
      placeholder={props.placeholder}
      type={props.type}
      hint={props.hint}
      multiple={props.multiple}
      other={props.other}
    >
      {children}
    </FormField>
  ),
  Option: (_props, children) => <FormOption>{children}</FormOption>,
  FactChange: (props) => <FactChange {...props} />,
  Stats: (_props, _children, data) => <Stats data={data?.value} />,
  Compare: (props, _children, data) => <Compare recommend={props.recommend} data={data?.value} />,
  Diagram: (props, _children, data) => <Diagram title={props.title} source={data?.value} />,
  Replies: (_props, children) => <Replies>{children}</Replies>,
  Reply: (_props, children) => <Reply>{children}</Reply>
};

/** User-facing names of the top-level MDX features, in display order.
 * Keep in sync with componentMap when adding/removing a top-level component. */
export const mdxFeatureLabels = [
  'callouts', 'steps', 'checklists', 'collapsibles', 'tabs', 'tables', 'charts', 'quizzes', 'forms',
  'stats', 'comparisons', 'diagrams', 'suggested replies',
];
