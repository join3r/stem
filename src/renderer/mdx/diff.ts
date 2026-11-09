// Parse the text of a ```diff fence into rows that DiffBlock can draw as a
// unified view or as a side-by-side view. The parser accepts a full git diff
// (file headers + @@ hunks) and also the loose form a model often writes: only
// lines that start with "+", "-" or " ", with no headers.

export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old file; set only when a @@ header gave a start. */
  oldNo?: number;
  /** Line number in the new file; set only when a @@ header gave a start. */
  newNo?: number;
}

export type DiffRow =
  | { type: 'file'; oldPath?: string; newPath?: string }
  | { type: 'hunk'; text: string }
  | ({ type: 'line' } & DiffLine)
  | { type: 'note'; text: string };

export interface ParsedDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** True when some line numbers are known, so the gutter can show them. */
  numbered: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function stripPrefix(path: string): string | undefined {
  const p = path.replace(/\t.*$/, '').trim();
  if (p === '/dev/null') return undefined;
  return p.replace(/^[ab]\//, '');
}

export function parseDiff(value: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let numbered = false;
  let oldNo: number | undefined;
  let newNo: number | undefined;
  let pendingOld: string | undefined;

  const lines = value.replace(/\n$/, '').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    if (line.startsWith('diff --git ') || line.startsWith('index ') || /^(new|deleted) file mode /.test(line)) {
      continue; // the --- / +++ pair that follows names the file
    }
    if (line.startsWith('--- ') && pendingOld === undefined) {
      pendingOld = line.slice(4);
      continue;
    }
    if (line.startsWith('+++ ') && pendingOld !== undefined) {
      rows.push({ type: 'file', oldPath: stripPrefix(pendingOld), newPath: stripPrefix(line.slice(4)) });
      pendingOld = undefined;
      oldNo = newNo = undefined;
      continue;
    }
    if (pendingOld !== undefined) {
      // A lone "--- " line was a removed line that starts with "-- ".
      rows.push({ type: 'line', kind: 'del', text: `-- ${pendingOld}`, oldNo });
      removed++;
      if (oldNo !== undefined) oldNo++;
      pendingOld = undefined;
    }

    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      numbered = true;
      rows.push({ type: 'hunk', text: hunk[3].trim() });
      continue;
    }
    if (line.startsWith('@@')) {
      oldNo = newNo = undefined;
      rows.push({ type: 'hunk', text: line.replace(/^@@+\s*/, '').replace(/\s*@@+.*$/, '') });
      continue;
    }
    if (line.startsWith('\\')) {
      rows.push({ type: 'note', text: line.slice(1).trim() });
      continue;
    }

    const mark = line[0];
    if (mark === '+') {
      rows.push({ type: 'line', kind: 'add', text: line.slice(1), newNo });
      added++;
      if (newNo !== undefined) newNo++;
    } else if (mark === '-') {
      rows.push({ type: 'line', kind: 'del', text: line.slice(1), oldNo });
      removed++;
      if (oldNo !== undefined) oldNo++;
    } else {
      // " " context, or a line the model wrote without a marker.
      rows.push({ type: 'line', kind: 'ctx', text: mark === ' ' ? line.slice(1) : line, oldNo, newNo });
      if (oldNo !== undefined) oldNo++;
      if (newNo !== undefined) newNo++;
    }
  }
  if (pendingOld !== undefined) {
    rows.push({ type: 'line', kind: 'del', text: `-- ${pendingOld}`, oldNo });
    removed++;
  }
  return { rows, added, removed, numbered };
}

// ---- Side-by-side pairing -------------------------------------------------

export type SplitRow =
  | { type: 'file'; oldPath?: string; newPath?: string }
  | { type: 'hunk'; text: string }
  | { type: 'note'; text: string }
  | { type: 'pair'; left?: DiffLine; right?: DiffLine };

/** Put each run of removed lines next to the run of added lines that follows it. */
export function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) out.push({ type: 'pair', left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.type === 'line' && row.kind === 'del') {
      if (adds.length) flush(); // a removal after additions starts a new change
      dels.push(row);
    } else if (row.type === 'line' && row.kind === 'add') {
      adds.push(row);
    } else {
      flush();
      if (row.type === 'line') out.push({ type: 'pair', left: row, right: row });
      else out.push(row);
    }
  }
  flush();
  return out;
}

// ---- Word-level changes ---------------------------------------------------

export interface Segment {
  text: string;
  changed: boolean;
}

const MAX_TOKENS = 400;

function tokenize(s: string): string[] {
  return s.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/**
 * Mark the words that differ between a removed line and the added line that
 * replaced it. Returns null when the lines share too little for the marks to
 * help (a full rewrite), or when they are too long to compare cheaply.
 */
export function wordDiff(oldText: string, newText: string): { old: Segment[]; new: Segment[] } | null {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (!a.length || !b.length || a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  // Longest common subsequence over tokens.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const oldSegs: Segment[] = [];
  const newSegs: Segment[] = [];
  const push = (segs: Segment[], text: string, changed: boolean) => {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += text;
    else segs.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  let same = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(oldSegs, a[i], false);
      push(newSegs, b[j], false);
      if (a[i].trim()) same += a[i].length;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(oldSegs, a[i++], true);
    } else {
      push(newSegs, b[j++], true);
    }
  }
  while (i < a.length) push(oldSegs, a[i++], true);
  while (j < b.length) push(newSegs, b[j++], true);

  const visible = Math.max(oldText.trim().length, newText.trim().length);
  if (!visible || same / visible < 0.3) return null;
  return { old: oldSegs, new: newSegs };
}

/** Word marks for every removed/added line that has a partner in the split pairing. */
export function wordMarks(split: SplitRow[]): Map<DiffLine, Segment[]> {
  const marks = new Map<DiffLine, Segment[]>();
  for (const row of split) {
    if (row.type !== 'pair' || !row.left || !row.right || row.left === row.right) continue;
    const words = wordDiff(row.left.text, row.right.text);
    if (!words) continue;
    marks.set(row.left, words.old);
    marks.set(row.right, words.new);
  }
  return marks;
}
