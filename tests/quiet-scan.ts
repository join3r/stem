import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Finds catch blocks that swallow — the raw material for both the "silence is a
 * defect" guard (`tests/unit/quiet-failures.test.ts`) and the mutation probe in
 * `scripts/quiet-mutants.mjs`, which forces each swallowed `try` to throw and
 * reports the ones no test notices. Both need to agree on what counts as a
 * swallow, so they share this rather than each carrying its own regex.
 *
 * Deliberately a brace-matcher and not a parser: the guard runs inside the unit
 * suite, where taking a TypeScript AST dependency to read `src/server` would cost
 * more than the whole rest of the file. Comments and string literals are blanked
 * before matching — this file's own doc comment says `catch { return [] }`, and
 * without that pass the scanner reports itself.
 */
export interface CatchSite {
  file: string;
  /** 1-indexed line of the `catch` keyword, or of the `.catch(` call. */
  line: number;
  /**
   * Which form. `arrow` is `.catch(() => …)`, which reads as a smaller decision
   * than a catch block and was invisible to the first version of this scanner —
   * three separate sweeps of `src/server` found real degradations hiding in one:
   * a failed `runtime.restart()` swallowed by `.catch(() => undefined)` means a
   * credential the user just added never reaches the backend, and the status the
   * wizard shows comes from a process that does not know about it.
   */
  kind: 'catch' | 'arrow';
  /** The handler body, comments included. */
  body: string;
  /** Body says something: throws, logs, degrades, hands an error to a caller. */
  signals: boolean;
  /** The reason given on a `// quiet: …` line, if the body carries one. */
  quiet: string | null;
}

/**
 * What counts as saying something. `throw`/`log`/`degrade` are the direct forms;
 * the rest are the indirect ones this codebase actually uses — an error handed
 * back over RPC, put on an activity row, or set on a status object is not
 * silence, it is just silence-shaped from inside the catch.
 */
const SIGNAL = /\b(throw|log|degrade|console|activity\.fail|reject|replyError|respond|reply|fail|setError|emit|post|notify|report)\b/;

const QUIET = /\/\/\s*quiet:\s*(.+)/;

/** Every .ts/.tsx under `root` — or just `root` itself when it names one file. */
function tsFiles(root: string, out: string[] = []): string[] {
  if (!statSync(root).isDirectory()) {
    if (root.endsWith('.ts') || root.endsWith('.tsx')) out.push(root);
    return out;
  }
  for (const name of readdirSync(root)) tsFiles(join(root, name), out);
  return out;
}

/**
 * A copy of `source` with comments and string/template literals replaced by
 * spaces, so offsets still line up with the original but a `catch` written in
 * prose or in a quoted example is no longer there to be found.
 */
function blankLiterals(source: string): string {
  const out = source.split('');
  let i = 0;
  const blankTo = (end: number) => {
    for (let k = i; k < end && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
    i = end;
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') blankTo(source.indexOf('\n', i) + 1 || source.length);
    else if (c === '/' && next === '*') blankTo(source.indexOf('*/', i) + 2 || source.length);
    else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      blankTo(j + 1);
    } else i++;
  }
  return out.join('');
}

/** Index just past the `}` that closes a block whose `{` was at `open`. */
function closingBrace(source: string, afterOpen: number): number {
  let i = afterOpen;
  let depth = 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return i;
}

/** Index just past the `)` closing a call whose `(` was at `open`. */
function closingParen(source: string, afterOpen: number): number {
  let i = afterOpen;
  let depth = 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    i++;
  }
  return i;
}

/**
 * The run of `//` comment lines immediately above `at`. An arrow handler's body is
 * often a single word — `.catch(() => undefined)` — with nowhere to put a note, so
 * the line above the statement is where a `// quiet:` for it naturally goes. Only
 * consulted for the quiet claim, never for whether the handler signals: a comment
 * that happens to say "log" must not read as logging.
 */
function preamble(source: string, at: number): string {
  const lines = source.slice(0, at).split('\n');
  lines.pop();
  const above: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].trim();
    if (!text.startsWith('//')) break;
    above.unshift(text);
  }
  return above.join('\n');
}

function classify(file: string, source: string, at: number, kind: CatchSite['kind'], body: string) {
  const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const claim = kind === 'arrow' ? `${preamble(source, at)}\n${body}` : body;
  return {
    file,
    line: source.slice(0, at).split('\n').length,
    kind,
    body,
    signals: SIGNAL.test(code),
    quiet: claim.match(QUIET)?.[1]?.trim() ?? null
  };
}

/**
 * Every inline failure handler under `roots` — `catch { … }` blocks and
 * `.catch(… => …)` arrows alike — classified.
 *
 * `.catch(handleIt)` passing a named function is NOT a site: the handler is a
 * function somewhere else, and if that function swallows, its own body is where
 * this scanner should be arguing with it.
 */
export function scanCatches(roots: string[]): CatchSite[] {
  const sites: CatchSite[] = [];
  for (const root of roots) {
    for (const file of tsFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const bare = blankLiterals(source);

      const blocks = /catch\s*(\([^)]*\))?\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = blocks.exec(bare))) {
        const start = m.index + m[0].length;
        sites.push(
          classify(file, source, m.index, 'catch', source.slice(start, closingBrace(bare, start) - 1))
        );
      }

      // `.catch(` + an arrow: optional `async`, then `(params)` or a bare
      // identifier, then `=>`, then either a block or a single expression.
      const arrows = /\.catch\(\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/g;
      while ((m = arrows.exec(bare))) {
        const start = m.index + m[0].length;
        const end =
          bare[start] === '{'
            ? closingBrace(bare, start + 1) - 1
            : closingParen(bare, m.index + '.catch('.length) - 1;
        sites.push(
          classify(file, source, m.index, 'arrow', source.slice(bare[start] === '{' ? start + 1 : start, end))
        );
      }
    }
  }
  return sites;
}

/** The ones that neither say anything nor explain why they don't. */
export function unexplained(roots: string[]): CatchSite[] {
  return scanCatches(roots).filter((s) => !s.signals && !s.quiet);
}
