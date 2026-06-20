// Stem Recall — standalone stdio MCP server exposing `search_past_chats`.
//
// Codex spawns this as an MCP server (registered in config.toml by
// register-mcp.ts). It runs under Electron-as-node (ELECTRON_RUN_AS_NODE=1) so it
// shares the exact node:sqlite runtime as the main process. It opens recall.sqlite
// READ-ONLY at the path given in STEM_RECALL_DB.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per line).
// The search query/ranking here intentionally mirrors src/main/recall/{store,search}.ts;
// keep them in sync (a separate process can't import the TS modules directly).

import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';

const DB_PATH = process.env.STEM_RECALL_DB;

let db = null;
function open() {
  if (db) return db;
  if (!DB_PATH) throw new Error('STEM_RECALL_DB is not set');
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  return db;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'for',
  'with', 'that', 'this', 'it', 'i', 'you', 'we', 'my', 'me', 'do', 'does', 'did', 'what', 'who',
  'when', 'where', 'why', 'how', 'about',
  'aby', 'ako', 'ale', 'som', 'si', 'sa', 'na', 'je', 'co', 'čo', 'ktorý', 'kde',
  'der', 'die', 'das', 'und', 'ich', 'ist', 'für', 'mit', 'wie'
]);

function buildMatchQuery(raw) {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length >= 2 && !STOPWORDS.has(t)
  );
  const seen = new Set();
  const terms = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    terms.push(`"${t.replace(/"/g, '""')}"`);
  }
  return terms.length ? terms.join(' OR ') : null;
}

function searchPastChats(query, limit) {
  const match = buildMatchQuery(query);
  if (!match) return [];
  const handle = open();
  const rows = handle
    .prepare(
      `SELECT m.thread_id AS threadId, m.role AS role, m.ts AS ts, m.text AS text,
              bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY score
       LIMIT ?`
    )
    .all(match, Math.max(1, Math.min(limit ?? 8, 20)));
  return rows;
}

function formatResults(rows) {
  if (rows.length === 0) return 'No matching past conversations found.';
  return rows
    .map((r) => {
      const date = new Date(r.ts * 1000).toISOString().slice(0, 10);
      const who = r.role === 'user' ? 'User' : 'Assistant';
      const text = r.text.replace(/\s+/g, ' ').trim().slice(0, 600);
      return `[${date}] ${who}: ${text}`;
    })
    .join('\n\n');
}

// ---- minimal MCP / JSON-RPC plumbing ----

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOL = {
  name: 'search_past_chats',
  description:
    'Search the user\'s past conversations (across all chats) for anything previously said or shown — facts, decisions, details fetched from email/web, prior questions. Use when the user refers to something not in the current chat, or to recall context about them. Returns dated snippets. Matching is keyword-based (not semantic): the user mixes Slovak, English, and German, and past content is stored in whatever language it was originally written, so a query in one language will MISS content stored in another. Always include synonyms in BOTH Slovak and English (and German when relevant) in the same query.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to look for. Include the key terms in BOTH Slovak and English (e.g. "zdravotný stav health diagnóza diagnosis") so language-specific content is not missed — matching is keyword-based, not semantic.' },
      limit: { type: 'number', description: 'Max snippets to return (default 8, max 20).' }
    },
    required: ['query']
  }
};

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stem-recall', version: '0.1.0' }
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no reply
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: [TOOL] });
      return;
    case 'tools/call': {
      if (params?.name !== 'search_past_chats') {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        const rows = searchPastChats(String(params?.arguments?.query ?? ''), params?.arguments?.limit);
        reply(id, { content: [{ type: 'text', text: formatResults(rows) }] });
      } catch (e) {
        // Surface as a tool error rather than crashing the server.
        reply(id, { content: [{ type: 'text', text: `Recall search failed: ${e.message}` }], isError: true });
      }
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  try {
    handle(msg);
  } catch (e) {
    if (msg?.id !== undefined) replyError(msg.id, -32603, e.message);
  }
});
