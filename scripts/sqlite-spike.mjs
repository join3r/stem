import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
try {
  db.exec(`CREATE VIRTUAL TABLE m USING fts5(text, thread_id UNINDEXED, tokenize='unicode61');`);
  const ins = db.prepare(`INSERT INTO m(rowid, text, thread_id) VALUES (?,?,?)`);
  ins.run(1, 'My UZ Gent cardiology appointment is on June 30', 'thread-A');
  ins.run(2, 'How do decoder-only LLMs differ from BERT', 'thread-B');
  ins.run(3, 'Mám kardiologické vyšetrenie v Gente', 'thread-C');
  const q = db.prepare(
    `SELECT rowid, thread_id, text, bm25(m) AS score FROM m WHERE m MATCH ? ORDER BY score LIMIT 5`
  );
  const rows = q.all('Gent OR cardiology OR kardiologické');
  console.log('FTS5 OK. matches:', rows.length);
  for (const r of rows) console.log('  ', r.thread_id, r.score.toFixed(3), JSON.stringify(r.text).slice(0, 60));
  const snip = db
    .prepare(`SELECT snippet(m, 0, '[', ']', '…', 8) AS s FROM m WHERE m MATCH ? LIMIT 1`)
    .get('Gent');
  console.log('snippet():', snip.s);
  console.log('SPIKE_PASS');
} catch (e) {
  console.log('SPIKE_FAIL:', e.message);
} finally {
  db.close();
}
