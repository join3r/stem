// Stem Recall — standalone stdio MCP server exposing `search_past_chats`
// (episodic messages), `search_facts` (durable Level-1 facts) and
// `search_chat_summaries` (Level-1.5 rolling thread summaries). It also serves
// `read_stem_guide`, which has nothing to do with recall but everything to do
// with being eager: this is the only server whose tools pi registers natively on
// every turn (see stem-mcp-extension.mjs), so a question about Stem itself can be
// answered without a router round-trip, and the pages ride along in this bundle.
//
// The pi backend spawns this as an MCP server (registered in mcp.json by
// pi/mcp-config.ts). It runs under Electron-as-node (ELECTRON_RUN_AS_NODE=1) so
// it shares the exact node:sqlite runtime as the main process. It opens
// recall.sqlite READ-ONLY at the path given in STEM_RECALL_DB.
//
// Transport: MCP stdio = newline-delimited JSON-RPC 2.0 (one message per line).
//
// Search is HYBRID: the FTS legs run locally against recall.sqlite; the semantic
// legs embed the query through main's unix-socket embed endpoint (STEM_EMBED_SOCK
// + STEM_EMBED_TOKEN, see embed-endpoint.ts) and cosine-rank the cached vectors,
// fused by reciprocal rank fusion. ANY semantic failure (main not running,
// socket gone, embeddings off, old DB without the tables) degrades to FTS-only.
//
// All retrieval mechanics are imported from search-core.ts — the SAME module the
// main process uses — so the two processes cannot drift. This file owns only the
// JSON-RPC plumbing, the socket embed client, tool descriptors and formatting.
// It is bundled to dist/main/recall-mcp-server.js (see electron.vite.config.ts)
// and must never import 'electron'.

import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STEM_GUIDE_SLUGS, stemGuidePage } from './stem-guide';
import {
  hybridSearchDocs,
  hybridSearchFacts,
  hybridSearchMessages,
  hybridSearchSummaries,
  type CoreDocHit,
  type CoreFactHit,
  type CoreSearchHit,
  type CoreSummaryHit,
  type QueryEmbedding,
  setCoreDegradeSink
} from './search-core';

const DB_PATH = process.env.STEM_RECALL_DB;
const EMBED_SOCK = process.env.STEM_EMBED_SOCK;
const EMBED_TOKEN = process.env.STEM_EMBED_TOKEN;
const FOLDER_INDEX_DIR = process.env.STEM_FOLDER_INDEX_DIR;

/**
 * This process's version of degrade(): a failure it survived, said out loud.
 *
 * There is no log file here — main's logger resolves its path through the
 * workspace and host modules this bundle deliberately doesn't carry — and stdout
 * is the JSON-RPC frame stream, so stderr is the one channel left that can't
 * corrupt the protocol. It also takes search-core's leg failures
 * (setCoreDegradeSink below), which is the whole point: `[]` from a broken FTS
 * index and `[]` from a question nothing matches leave this server saying the
 * same "no results found" sentence.
 */
function report(scope: string, what: string, error: unknown): void {
  const detail = error instanceof Error ? error.message || error.name : String(error);
  try {
    process.stderr.write(`[${scope}] degraded: ${what} (${detail})\n`);
  } catch {
    // quiet: same rule as degrade() in main — reporting a degradation must never
    // become one. A closed stderr can't be allowed to fail a tool call.
  }
}

setCoreDegradeSink(report);

let db: DatabaseSync | null = null;
function open(): DatabaseSync {
  if (db) return db;
  if (!DB_PATH) throw new Error('STEM_RECALL_DB is not set');
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  // A scan-worker VACUUM briefly locks even readers out — wait, don't throw.
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/**
 * The Settings memory toggle, read from recall.sqlite meta on every call so a
 * flip takes effect without a pi restart. It gates ALL tools here — "memory
 * off" means Stem's memory surface is off, including explicit search over the
 * (possibly stale) folder indexes, not just proactive injection. Unreadable
 * meta (fresh DB, mid-migration) counts as enabled, matching isRecallEnabled's
 * default in the main process.
 */
function isRecallEnabledFlag(): boolean {
  try {
    const row = open()
      .prepare(`SELECT value FROM meta WHERE key = 'recall_enabled'`)
      .get() as { value?: string } | undefined;
    return row?.value !== 'false';
  } catch {
    // quiet: the doc comment above is the contract — unreadable meta counts as
    // enabled, deliberately, and matches what the main process does.
    return true;
  }
}

/**
 * Embed the query through main's unix-socket endpoint. Returns
 * {vec, model} or null on ANY failure — no retries, the next tool call retries
 * naturally. Deadlines: 2.5 s overall (a slow first embed can take >1 s).
 */
function embedQueryViaSocket(query: string): Promise<QueryEmbedding | null> {
  if (!EMBED_SOCK || !EMBED_TOKEN) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: QueryEmbedding | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(v);
    };
    const deadline = setTimeout(() => done(null), 2500);
    const socket = connect(EMBED_SOCK);
    socket.setTimeout(2500, () => done(null));
    socket.on('error', () => done(null));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        const res = JSON.parse(buf.slice(0, nl)) as {
          ok?: boolean;
          vectors?: number[][];
          model?: string;
        };
        if (res?.ok && Array.isArray(res.vectors) && (res.vectors[0]?.length ?? 0) > 0 && typeof res.model === 'string') {
          done({ vec: Float32Array.from(res.vectors[0]), model: res.model });
        } else {
          done(null);
        }
      } catch {
        // quiet: null here is FTS-only, and it is the same null the timeout, the
        // refused connect and the error handler above all produce. Singling out
        // the malformed-reply case would light up one of five identical outcomes.
        done(null);
      }
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, op: 'embed', kind: 'query', texts: [query], token: EMBED_TOKEN })}\n`);
    });
  });
}

/** One-shot embed thunk for a single tool call (each call embeds at most once). */
function embedOnce(query: string): () => Promise<QueryEmbedding | null> {
  let memo: Promise<QueryEmbedding | null> | null = null;
  return () => (memo ??= embedQueryViaSocket(query));
}

function clampLimit(limit: unknown, fallback: number, max: number): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? limit : fallback;
  return Math.max(1, Math.min(n, max));
}

async function searchPastChats(query: string, limit: unknown): Promise<CoreSearchHit[]> {
  return hybridSearchMessages(open(), query, {
    limit: clampLimit(limit, 8, 20),
    snippetChars: 600,
    embedQuery: embedOnce(query)
  });
}

async function searchFacts(query: string, limit: unknown): Promise<CoreFactHit[]> {
  return hybridSearchFacts(open(), query, {
    limit: clampLimit(limit, 10, 30),
    embedQuery: embedOnce(query)
  });
}

async function searchSummaries(query: string, limit: unknown): Promise<CoreSummaryHit[]> {
  return hybridSearchSummaries(open(), query, {
    limit: clampLimit(limit, 5, 12),
    embedQuery: embedOnce(query)
  });
}

// ---- indexed connected folders ----
//
// Per-folder index DBs are discovered through manifest.json (written atomically
// by main's folder-index module on every registry change), re-read on every
// call — so a freshly indexed folder is searchable without a pi restart.

interface FolderManifestEntry {
  id: string;
  label: string;
  path: string;
  memorize: boolean;
  dbFile: string;
}

function readFolderManifest(): FolderManifestEntry[] {
  if (!FOLDER_INDEX_DIR) return [];
  try {
    const raw = JSON.parse(readFileSync(join(FOLDER_INDEX_DIR, 'manifest.json'), 'utf8')) as {
      folders?: FolderManifestEntry[];
    };
    return Array.isArray(raw.folders) ? raw.folders.filter((f) => f && typeof f.dbFile === 'string') : [];
  } catch (e) {
    // Every indexed folder disappears at once, and search_folder_docs answers
    // with the same sentence it uses when a folder simply had no match.
    report('recall.mcp', 'searched no indexed folders — the manifest was unreadable', e);
    return [];
  }
}

type FolderDocHit = CoreDocHit & { folderLabel: string };

/**
 * True when the folder's directory currently exists. The manifest can outlive
 * the directory (unmounted volume, deleted mirror) — the main process skips
 * missing folders for injection, and this keeps the explicit tool consistent
 * instead of serving hits from a frozen index of a vanished folder.
 */
function folderReachable(path: unknown): boolean {
  if (typeof path !== 'string' || !path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    // quiet: the question is whether the folder is there right now, and a stat
    // that fails has answered it.
    return false;
  }
}

// Folder-index handles, kept warm across calls (page cache + prepared
// statements) — a fresh open/close per folder per call threw both away. Keyed
// by db file; evicted on error or when the manifest no longer lists the file,
// which preserves the deliberate per-call manifest freshness.
const folderDbs = new Map<string, DatabaseSync>();

function folderDbFor(dbFile: string): DatabaseSync {
  let db = folderDbs.get(dbFile);
  if (!db) {
    db = new DatabaseSync(dbFile, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000;');
    folderDbs.set(dbFile, db);
  }
  return db;
}

function evictFolderDb(dbFile: string): void {
  const db = folderDbs.get(dbFile);
  folderDbs.delete(dbFile);
  try {
    db?.close();
  } catch {
    // quiet: already closed or broken. The handle is out of the map either way,
    // which is the only thing eviction owes anyone.
  }
}

/** Which index files are currently held open — the eviction scope, for tests. */
export function cachedFolderDbFiles(): string[] {
  return [...folderDbs.keys()];
}

export async function searchFolderDocs(query: string, limit: unknown, folder: unknown): Promise<FolderDocHit[]> {
  const max = clampLimit(limit, 8, 20);
  const wanted = typeof folder === 'string' && folder.trim() ? folder.trim().toLowerCase() : null;
  const manifest = readFolderManifest();
  const entries = manifest.filter(
    (f) => (!wanted || f.label.toLowerCase().includes(wanted)) && folderReachable(f.path)
  );
  // Drop handles for folders that left the manifest (disconnected, re-indexed).
  // Derived from the WHOLE manifest, not this call's filtered slice: a
  // `folder:`-scoped query must not close every other folder's warm handle.
  const live = new Set(manifest.map((e) => e.dbFile));
  for (const file of [...folderDbs.keys()]) {
    if (!live.has(file)) evictFolderDb(file);
  }
  const embedQuery = embedOnce(query);
  const all: FolderDocHit[] = [];
  for (const entry of entries) {
    try {
      const hits = await hybridSearchDocs(folderDbFor(entry.dbFile), query, {
        limit: max,
        snippetChars: 600,
        embedQuery
      });
      all.push(...hits.map((h) => ({ ...h, folderLabel: entry.label })));
    } catch (e) {
      // A missing/locked index just contributes no hits; reopen fresh next call.
      // The answer still lists every other folder, so nothing about it says one
      // folder was left out.
      report('recall.mcp', `skipped the "${entry.label}" folder index`, e);
      evictFolderDb(entry.dbFile);
    }
  }
  return all.sort((a, b) => b.score - a.score).slice(0, max);
}

function formatFolderDocs(rows: FolderDocHit[]): string {
  if (rows.length === 0) {
    return 'No matching documents found in indexed folders (only folders with the Index option enabled are searchable here).';
  }
  return rows
    .map((r) => {
      const text = (r.snippet || r.text).replace(/\s+/g, ' ').trim().slice(0, 600);
      return `[${isoDate(Math.floor(r.mtime / 1000))}] (${r.folderLabel}) ${r.relPath}: ${text}`;
    })
    .join('\n\n');
}

function formatFacts(rows: CoreFactHit[]): string {
  if (rows.length === 0) return 'No matching stored facts found.';
  return rows.map((r) => `- ${r.text.replace(/\s+/g, ' ').trim()}`).join('\n');
}

function isoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function formatResults(rows: CoreSearchHit[]): string {
  if (rows.length === 0) return 'No matching past conversations found.';
  return rows
    .map((r) => {
      const who = r.role === 'user' ? 'User' : 'Assistant';
      // The full message text, not the «»-marked FTS snippet — tool output
      // stays clean of highlight markers (matches the pre-core behavior).
      const text = r.text.replace(/\s+/g, ' ').trim().slice(0, 600);
      return `[${isoDate(r.ts)}] ${who}${r.role === 'assistant' ? ' claim (untrusted until confirmed)' : ''}: ${text}`;
    })
    .join('\n\n');
}

function formatSummaries(rows: CoreSummaryHit[]): string {
  if (rows.length === 0) {
    return 'No matching conversation summaries found (summaries build as the user chats — try search_past_chats for verbatim messages).';
  }
  return rows
    .map((r) => {
      const range = r.firstTs === r.lastTs || isoDate(r.firstTs) === isoDate(r.lastTs)
        ? isoDate(r.lastTs)
        : `${isoDate(r.firstTs)} → ${isoDate(r.lastTs)}`;
      const text = r.text.replace(/\s+/g, ' ').trim();
      return `[${range}] (thread ${r.threadId}) ${text}`;
    })
    .join('\n\n');
}

// ---- minimal MCP / JSON-RPC plumbing ----

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: { query?: unknown; limit?: unknown; folder?: unknown; page?: unknown };
  };
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: number | string | undefined, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string | undefined, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const FACTS_TOOL = {
  name: 'search_facts',
  description:
    'Search the durable facts Stem has learned about the user (family, vehicles, home, health, preferences, plans). Only the facts most relevant to the current message are pre-injected, so when a request depends on personal context that might not be in view — planning, purchases, recommendations, anything where family members, ages, vehicle, budget or preferences would change the answer — search here first. Matching is keyword plus semantic (multilingual); if a search misses, retry with the key terms in the other language (e.g. add English to a Slovak query).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for — a topic or attribute, e.g. "family children age", "car vehicle", "rodina deti".' },
      limit: { type: 'number', description: 'Max facts to return (default 10, max 30).' }
    },
    required: ['query']
  }
};

const CHATS_TOOL = {
  name: 'search_past_chats',
  description:
    'Search the user\'s past conversations (across all chats) for anything previously said or shown — facts, decisions, details fetched from email/web, prior questions. Use when the user refers to something not in the current chat, or to recall context about them. Returns dated verbatim snippets; for a thread-level overview of what a past conversation covered and decided, search_chat_summaries is usually the better first stop. Matching is hybrid: keyword plus semantic (multilingual) while the Stem app is running, keyword-only otherwise. Semantic matching usually bridges Slovak/English/German, but it is imperfect — when a search misses, retry with key synonyms in the OTHER language (e.g. add English terms to a Slovak query), which also covers the keyword-only fallback.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for — a phrase or keywords. Semantic matching usually bridges Slovak/English/German; if a search misses, retry with the key terms translated into the other language (e.g. "zdravotný stav health diagnosis").' },
      limit: { type: 'number', description: 'Max snippets to return (default 8, max 20).' }
    },
    required: ['query']
  }
};

const SUMMARIES_TOOL = {
  name: 'search_chat_summaries',
  description:
    'Search rolling English summaries of the user\'s past conversation threads — what each chat was about, what was decided, and what stayed open. Use for thread-level questions ("what did we conclude about X?", "which chat discussed Y?") before drilling into verbatim messages with search_past_chats. Summaries are in English regardless of the conversation language, so English query terms work best; matching is keyword plus semantic (multilingual).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Topic, decision or entity to look for, e.g. "kitchen renovation budget decision".' },
      limit: { type: 'number', description: 'Max summaries to return (default 5, max 12).' }
    },
    required: ['query']
  }
};

const FOLDER_DOCS_TOOL = {
  name: 'search_folder_docs',
  description:
    'Search the text files of the user\'s indexed connected folders (folders with the Index option on — e.g. an Obsidian vault or a synced mail/notes mirror). Returns ranked excerpts with folder and file path; read the full file with your file tools at the folder\'s path when an excerpt is not enough. Matching is keyword plus semantic (multilingual) while the Stem app is running, keyword-only otherwise; if a search misses, retry with the key terms in the other language.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for — a topic, phrase or keywords.' },
      folder: { type: 'string', description: 'Optional: only search folders whose label contains this text.' },
      limit: { type: 'number', description: 'Max documents to return (default 8, max 20).' }
    },
    required: ['query']
  }
};

const GUIDE_TOOL = {
  name: 'read_stem_guide',
  description:
    "Read a page of Stem's own user guide — the documentation for the app you are running inside. Use it whenever the user asks how Stem works, how to do something in the app, what a feature does, where a setting lives, which keyboard shortcut to press, or what changed in a recent version: the guide is the authority on all of that, and the app's UI is not something you can see. Returns the page as Markdown. Pages are small, so reading one is cheap; read the `guide` index when unsure which page covers the question, or read two pages together when a question spans both.",
  inputSchema: {
    type: 'object',
    properties: {
      page: {
        type: 'string',
        enum: [...STEM_GUIDE_SLUGS],
        description: 'Which page to read.'
      }
    },
    required: ['page']
  }
};

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
}

/**
 * Everything this server advertises. Exported so a test can check a descriptor
 * against the data behind it — the guide's `page` enum against the page map —
 * without speaking JSON-RPC over a spawned process.
 */
export function toolDescriptors(): ToolDescriptor[] {
  return [CHATS_TOOL, FACTS_TOOL, SUMMARIES_TOOL, FOLDER_DOCS_TOOL, GUIDE_TOOL];
}

function handle(msg: RpcMessage): void {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'stem-recall', version: '0.2.0' }
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no reply
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: toolDescriptors() });
      return;
    case 'tools/call': {
      const name = params?.name;
      // The guide is static text bundled into this file: no DB, no embed socket,
      // nothing to fail. It is answered before the memory gate below on purpose —
      // "how does Stem work?" is not a memory question, and someone who turned
      // memory off in Settings should still get told where that toggle lives.
      if (name === 'read_stem_guide') {
        const page = stemGuidePage(params?.arguments?.page);
        if (!page) {
          reply(id, {
            content: [{
              type: 'text',
              text: `Unknown guide page: ${JSON.stringify(params?.arguments?.page ?? null)}. Valid pages: ${STEM_GUIDE_SLUGS.join(', ')}.`
            }],
            isError: true
          });
          return;
        }
        // The source path rides along so an answer can say which page it came
        // from (and so a wrong page is obvious in the transcript).
        reply(id, {
          content: [{ type: 'text', text: `Stem user guide — page "${page.slug}" (${page.source})\n\n${page.markdown}` }]
        });
        return;
      }
      if (
        name !== 'search_past_chats' &&
        name !== 'search_facts' &&
        name !== 'search_chat_summaries' &&
        name !== 'search_folder_docs'
      ) {
        replyError(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      if (!isRecallEnabledFlag()) {
        // Plain text, not isError — "disabled" is an answer, not a failure to retry.
        reply(id, {
          content: [{
            type: 'text',
            text: 'Stem\'s memory is currently disabled in Settings, so memory and folder-index search are unavailable. Do not retry; tell the user they can re-enable memory in Settings if they want this searched.'
          }]
        });
        return;
      }
      void (async () => {
        try {
          const query = String(params?.arguments?.query ?? '');
          const limit = params?.arguments?.limit;
          const text =
            name === 'search_facts'
              ? formatFacts(await searchFacts(query, limit))
              : name === 'search_chat_summaries'
                ? formatSummaries(await searchSummaries(query, limit))
                : name === 'search_folder_docs'
                  ? formatFolderDocs(await searchFolderDocs(query, limit, params?.arguments?.folder))
                  : formatResults(await searchPastChats(query, limit));
          reply(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          // Surface as a tool error rather than crashing the server.
          reply(id, {
            content: [{ type: 'text', text: `Recall search failed: ${(e as Error).message}` }],
            isError: true
          });
        }
      })();
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
  let msg: RpcMessage;
  try {
    msg = JSON.parse(trimmed) as RpcMessage;
  } catch {
    // quiet: a line that isn't a JSON frame carries no id to answer on, so
    // there is nobody to tell — and pi is the only writer to this stdin.
    return;
  }
  try {
    handle(msg);
  } catch (e) {
    if (msg?.id !== undefined) replyError(msg.id, -32603, (e as Error).message);
  }
});
