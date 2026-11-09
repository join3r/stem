import type { ReactNode } from 'react';
import { Check, Columns2, Copy, Rows2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseDiff, toSplitRows, wordMarks, type DiffLine, type Segment } from './diff';

// A ```diff fence drawn as a diff: tinted rows for removed and added lines, a
// +/− gutter, line numbers when @@ headers give them, and word marks on the
// part of a line that changed. The reader can switch between one column
// (unified) and two columns (old on the left, new on the right).

type View = 'unified' | 'split';
const VIEW_KEY = 'stem.diffView';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

function writeView(view: View): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // The choice is a convenience; without storage it lasts until the block unmounts.
  }
}

// The leading whitespace goes in its own box, so a long line that wraps
// continues under its own text and not at the left edge of the cell.
function Text({ line, marks }: { line: DiffLine; marks: Map<DiffLine, Segment[]> }): ReactNode {
  const indent = /^[ \t]*/.exec(line.text)?.[0] ?? '';
  let skip = indent.length;
  const segs = (marks.get(line) ?? [{ text: line.text, changed: false }])
    .map((s) => {
      const cut = Math.min(skip, s.text.length);
      skip -= cut;
      return { ...s, text: s.text.slice(cut) };
    })
    .filter((s) => s.text.length);
  return (
    <div className="diff-text-row">
      {indent && <span className="diff-indent">{indent}</span>}
      <span className="diff-body">
        {segs.length
          ? segs.map((s, i) => (s.changed ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))
          : ' '}
      </span>
    </div>
  );
}

const MARK: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: '' };

function fileLabel(oldPath?: string, newPath?: string): string {
  if (oldPath && newPath && oldPath !== newPath) return `${oldPath} → ${newPath}`;
  return newPath ?? oldPath ?? '';
}

export function DiffBlock({ value }: { value: string }) {
  const [view, setView] = useState<View>(readView);
  const [copied, setCopied] = useState(false);
  const parsed = useMemo(() => parseDiff(value), [value]);
  const split = useMemo(() => toSplitRows(parsed.rows), [parsed]);
  const marks = useMemo(() => wordMarks(split), [split]);
  const { numbered } = parsed;

  const choose = (next: View) => {
    setView(next);
    writeView(next);
  };
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  // One file header for the whole block goes in the toolbar; more than one
  // stay as rows between their hunks.
  const files = parsed.rows.filter((r) => r.type === 'file');
  const single = files.length === 1 ? files[0] : undefined;
  const title = single?.type === 'file' ? fileLabel(single.oldPath, single.newPath) : '';

  const unifiedCols = numbered ? 4 : 2;
  const splitCols = numbered ? 6 : 4;

  return (
    <div className={`diff-block diff-${view}${numbered ? ' diff-numbered' : ''}`}>
      <div className="diff-toolbar">
        <span className="diff-title" title={title || undefined}>
          {title || 'Changes'}
        </span>
        <span className="diff-stats">
          <span className="diff-stat-add">+{parsed.added}</span>
          <span className="diff-stat-del">−{parsed.removed}</span>
        </span>
        <span className="diff-views" role="group" aria-label="Diff view">
          <button
            type="button"
            className={view === 'unified' ? 'active' : ''}
            aria-pressed={view === 'unified'}
            onClick={() => choose('unified')}
            title="One column"
            aria-label="One column"
          >
            <Rows2 size={13} />
          </button>
          <button
            type="button"
            className={view === 'split' ? 'active' : ''}
            aria-pressed={view === 'split'}
            onClick={() => choose('split')}
            title="Side by side"
            aria-label="Side by side"
          >
            <Columns2 size={13} />
          </button>
        </span>
        <button type="button" className="diff-copy" onClick={copy} title={copied ? 'Copied' : 'Copy diff'} aria-label={copied ? 'Copied' : 'Copy diff'}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>

      <div className="diff-scroll">
        <table className="diff-table">
          {view === 'split' && (
            <colgroup>
              {numbered && <col className="diff-col-no" />}
              <col className="diff-col-mark" />
              <col className="diff-col-text" />
              {numbered && <col className="diff-col-no" />}
              <col className="diff-col-mark" />
              <col className="diff-col-text" />
            </colgroup>
          )}
          <tbody>
            {view === 'unified'
              ? parsed.rows.map((row, i) => {
                  if (row.type === 'file') {
                    if (single) return null;
                    return (
                      <tr key={i} className="diff-file">
                        <td colSpan={unifiedCols}>{fileLabel(row.oldPath, row.newPath)}</td>
                      </tr>
                    );
                  }
                  if (row.type === 'hunk' || row.type === 'note') {
                    return (
                      <tr key={i} className={`diff-${row.type}`}>
                        <td colSpan={unifiedCols}>{row.text || ' '}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={i} className={`diff-line diff-${row.kind}`}>
                      {numbered && <td className="diff-no">{row.oldNo ?? ''}</td>}
                      {numbered && <td className="diff-no">{row.newNo ?? ''}</td>}
                      <td className="diff-mark">{MARK[row.kind]}</td>
                      <td className="diff-text">
                        <Text line={row} marks={marks} />
                      </td>
                    </tr>
                  );
                })
              : split.map((row, i) => {
                  if (row.type === 'file') {
                    if (single) return null;
                    return (
                      <tr key={i} className="diff-file">
                        <td colSpan={splitCols}>{fileLabel(row.oldPath, row.newPath)}</td>
                      </tr>
                    );
                  }
                  if (row.type === 'hunk' || row.type === 'note') {
                    return (
                      <tr key={i} className={`diff-${row.type}`}>
                        <td colSpan={splitCols}>{row.text || ' '}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={i} className="diff-line">
                      <Side line={row.left} side="old" numbered={numbered} marks={marks} />
                      <Side line={row.right} side="new" numbered={numbered} marks={marks} />
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Side({
  line,
  side,
  numbered,
  marks
}: {
  line?: DiffLine;
  side: 'old' | 'new';
  numbered: boolean;
  marks: Map<DiffLine, Segment[]>;
}) {
  const kind = line ? line.kind : 'empty';
  const no = line ? (side === 'old' ? line.oldNo : line.newNo) : undefined;
  const cls = `diff-${kind} diff-side-${side}`;
  return (
    <>
      {numbered && <td className={`diff-no ${cls}`}>{no ?? ''}</td>}
      <td className={`diff-mark ${cls}`}>{line ? MARK[line.kind] : ''}</td>
      <td className={`diff-text ${cls}`}>{line ? <Text line={line} marks={marks} /> : null}</td>
    </>
  );
}
