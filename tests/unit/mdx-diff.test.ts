import { describe, expect, it } from 'vitest';
import { parseDiff, toSplitRows, wordDiff, wordMarks } from '../../src/renderer/mdx/diff';

const LOOSE = `   - address: cloudfarms.us, www.cloudfarms.us
     config: |
-      @www host www.cloudfarms.us
-      redir @www https://cloudfarms.us{uri} 301
+      @apex host cloudfarms.us
+      redir @apex https://www.cloudfarms.us{uri} 301
       reverse_proxy 127.0.0.1:8080
`;

const GIT = `diff --git a/a.yml b/a.yml
index 1111..2222 100644
--- a/a.yml
+++ b/a.yml
@@ -10,3 +10,3 @@ servers:
 keep
-old
+new
\\ No newline at end of file
`;

describe('parseDiff', () => {
  it('reads a diff without headers as written by a model', () => {
    const d = parseDiff(LOOSE);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(2);
    expect(d.numbered).toBe(false);
    expect(d.rows[0]).toMatchObject({ type: 'line', kind: 'ctx', text: '  - address: cloudfarms.us, www.cloudfarms.us' });
    expect(d.rows[2]).toMatchObject({ kind: 'del', text: '      @www host www.cloudfarms.us' });
  });

  it('reads file headers, hunks with line numbers and notes', () => {
    const d = parseDiff(GIT);
    expect(d.numbered).toBe(true);
    expect(d.rows[0]).toEqual({ type: 'file', oldPath: 'a.yml', newPath: 'a.yml' });
    expect(d.rows[1]).toEqual({ type: 'hunk', text: 'servers:' });
    expect(d.rows[2]).toMatchObject({ kind: 'ctx', oldNo: 10, newNo: 10 });
    expect(d.rows[3]).toMatchObject({ kind: 'del', text: 'old', oldNo: 11 });
    expect(d.rows[4]).toMatchObject({ kind: 'add', text: 'new', newNo: 11 });
    expect(d.rows[5]).toEqual({ type: 'note', text: 'No newline at end of file' });
  });

  it('keeps a removed line that starts with "--" when no "+++" follows', () => {
    const d = parseDiff('--- comment\n+x\n');
    expect(d.rows[0]).toMatchObject({ kind: 'del', text: '-- comment' });
    expect(d.removed).toBe(1);
    expect(d.added).toBe(1);
  });
});

describe('toSplitRows', () => {
  it('puts removed lines next to the added lines that replace them', () => {
    const split = toSplitRows(parseDiff(LOOSE).rows);
    const pairs = split.filter((r) => r.type === 'pair');
    expect(pairs).toHaveLength(5);
    const changed = pairs[2];
    expect(changed.type === 'pair' && changed.left?.kind).toBe('del');
    expect(changed.type === 'pair' && changed.right?.kind).toBe('add');
  });

  it('leaves the other side empty when a run has no partner', () => {
    const split = toSplitRows(parseDiff('-a\n-b\n+c\n').rows);
    expect(split[1]).toMatchObject({ type: 'pair', right: undefined });
  });
});

describe('wordDiff', () => {
  it('marks only the changed words', () => {
    const w = wordDiff('@www host www.cloudfarms.us', '@apex host cloudfarms.us');
    expect(w).not.toBeNull();
    expect(w!.old.filter((s) => s.changed).map((s) => s.text).join('|')).toBe('www|www.');
    expect(w!.new.filter((s) => s.changed).map((s) => s.text)).toEqual(['apex']);
  });

  it('gives up on a full rewrite', () => {
    expect(wordDiff('alpha beta', 'gamma delta')).toBeNull();
  });

  it('feeds marks for paired lines', () => {
    const marks = wordMarks(toSplitRows(parseDiff(LOOSE).rows));
    expect(marks.size).toBe(4);
  });
});
