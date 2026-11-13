import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, unlinkSync } from 'node:fs';
import { degrade } from '../degrade';
import { log } from '../log';
import type { EmbeddingsClient, EmbedKind } from './embeddings';
import type { FactRerankClient } from './retrieval';
import { recallStore } from './store';

// Local embed endpoint: a unix-domain socket in main that lets the stem-recall
// MCP server (a pi-spawned sibling process with no IPC channel to main) embed
// its search queries through the app's embeddings client. Message vectors live
// in the shared recall.sqlite — the query embedding is the only thing the MCP
// process can't produce alone. Unix socket (not TCP): no port, no firewall
// prompt, and filesystem permissions (0600) do the gatekeeping; the per-run
// token is belt-and-suspenders on top.
//
// Protocol: newline-delimited JSON, one request per connection.
//   → {"id":1,"op":"embed","kind":"query","texts":["…"],"token":"<hex>"}
//   ← {"id":1,"ok":true,"model":"local:…","dim":384,"vectors":[[…]]}
//   ← {"id":1,"ok":false,"error":"embeddings unavailable"}
// Failure semantics are the client's fallback contract: ANY error (endpoint down,
// bad token, embeddings off/not-ready) means the caller degrades to FTS-only.
//
// Second op, the fact gate for search_facts: the hits are scored against the
// search query by the same cross-encoder and floor as per-turn injection
// (sensitive facts need the margin too), and only the ids that clear it return.
//   → {"id":1,"op":"factGate","query":"…","ids":[12,40],"token":"<hex>"}
//   ← {"id":1,"ok":true,"pass":[40]}
// Any failure means the caller keeps its hits as they were.

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TEXTS = 8;
/** search_facts returns at most 30 facts. */
const MAX_GATE_IDS = 30;
/** Same margin as per-turn injection (recall/inject.ts SENSITIVE_RERANK_MARGIN); a literal here to keep inject out of this module. */
const SENSITIVE_GATE_MARGIN = 2;

let token: string | null = null;

/**
 * Per-run auth token. Lazy module-level singleton so mcp-config.ts can put it in
 * the spawned server's env at bootstrap regardless of whether/when the endpoint
 * itself came up — a token with no live endpoint just means FTS-only fallback.
 */
export function getEmbedEndpointToken(): string {
  token ??= randomBytes(16).toString('hex');
  return token;
}

export interface EmbedEndpoint {
  close(): Promise<void>;
}

/**
 * The ids of `ids` that clear the fact gate for `query`, or null when there is
 * no calibrated gate to apply (no fact reranker, not ready, no floor).
 */
export async function gateFactIds(
  query: string,
  ids: readonly number[],
  rr: FactRerankClient | null
): Promise<number[] | null> {
  if (!rr || !(await rr.available())) return null;
  const floor = (await rr.factGateScore?.()) ?? null;
  if (floor === null) return null;
  const facts = recallStore.getFactsByIds([...ids]);
  if (facts.length === 0) return [];
  const ranked = await rr.rerank(query, facts.map((f) => f.text), facts.length);
  const pass = new Set<number>();
  for (const r of ranked) {
    const fact = facts[r.index];
    if (fact && r.score >= floor + (fact.sensitivity === 'sensitive' ? SENSITIVE_GATE_MARGIN : 0)) pass.add(fact.id);
  }
  // In the order the search ranked them.
  return ids.filter((id) => pass.has(id));
}

async function handleRequest(
  line: string,
  socket: Socket,
  getClient: () => EmbeddingsClient | null,
  getFactGate: () => Promise<FactRerankClient | null>
): Promise<void> {
  let req: {
    id?: unknown;
    op?: unknown;
    kind?: unknown;
    texts?: unknown;
    token?: unknown;
    query?: unknown;
    ids?: unknown;
  };
  try {
    req = JSON.parse(line) as typeof req;
  } catch {
    // quiet: a line that is not JSON carries no id to answer, so there is no
    // reply to send. The peer reads any failure — a closed socket included — as
    // its FTS-only fallback, which is the same thing it would have been told.
    socket.destroy();
    return;
  }
  const id = req?.id ?? null;
  const respond = (body: Record<string, unknown>): void => {
    try {
      socket.end(`${JSON.stringify({ id, ...body })}\n`);
    } catch {
      // quiet: the peer vanished mid-reply — there is no one left to tell.
    }
  };

  if (req?.token !== getEmbedEndpointToken()) {
    respond({ ok: false, error: 'bad token' });
    return;
  }
  if (req?.op === 'factGate') {
    const ids = req.ids;
    if (
      typeof req.query !== 'string' || !req.query.trim() ||
      !Array.isArray(ids) || ids.length > MAX_GATE_IDS ||
      !ids.every((v): v is number => Number.isInteger(v))
    ) {
      respond({ ok: false, error: 'bad request' });
      return;
    }
    try {
      const pass = await gateFactIds(req.query, ids, await getFactGate());
      respond(pass === null ? { ok: false, error: 'fact gate unavailable' } : { ok: true, pass });
    } catch (e) {
      respond({ ok: false, error: String((e as Error)?.message ?? e) });
    }
    return;
  }
  const texts = req?.texts;
  if (
    req?.op !== 'embed' ||
    !Array.isArray(texts) ||
    texts.length === 0 ||
    texts.length > MAX_TEXTS ||
    !texts.every((t): t is string => typeof t === 'string')
  ) {
    respond({ ok: false, error: 'bad request' });
    return;
  }
  const kind: EmbedKind = req.kind === 'passage' ? 'passage' : 'query';

  try {
    const client = getClient();
    // available() never awaits readiness (that's its contract), so a not-ready
    // local model answers fast with unavailable rather than hanging the caller.
    if (!client || !(await client.available())) {
      respond({ ok: false, error: 'embeddings unavailable' });
      return;
    }
    const model = await client.modelId();
    if (!model) {
      respond({ ok: false, error: 'embeddings unavailable' });
      return;
    }
    const vectors = await client.embed(texts, kind);
    respond({ ok: true, model, dim: vectors[0]?.length ?? 0, vectors: vectors.map((v) => Array.from(v)) });
  } catch (e) {
    respond({ ok: false, error: String((e as Error)?.message ?? e) });
  }
}

/**
 * Start the endpoint. Listening failures (e.g. the userData path exceeds the
 * 104-byte sun_path limit under an exotic profile name) are logged and swallowed
 * — the app must keep running; the MCP server just stays FTS-only.
 */
export function startEmbedEndpoint(opts: {
  socketPath: string;
  getClient: () => EmbeddingsClient | null;
  /** The per-turn fact gate's client, for search_facts (op factGate). */
  getFactGate?: () => Promise<FactRerankClient | null>;
}): EmbedEndpoint {
  const getFactGate = opts.getFactGate ?? (async () => null);
  // Windows named pipes are not filesystem entries: nothing stale to unlink,
  // nothing to chmod (access is gated by the request token either way).
  const isPipe = process.platform === 'win32';
  if (!isPipe) {
    try {
      unlinkSync(opts.socketPath); // stale socket from a crashed previous run
    } catch {
      // quiet: nothing stale to remove is the normal case, and a socket that
      // really could not be removed takes down listen() below, which is logged.
    }
  }

  const server = createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      void handleRequest(line, socket, opts.getClient, getFactGate);
    });
    socket.on('error', () => {
      // Client-side aborts are routine; never let them bubble to the process.
    });
  });

  server.on('error', (err) => {
    // Fires async after listen() — no throw path out of here by design. Goes to
    // the app log rather than the console because the whole symptom is silent:
    // search_past_chats quietly drops to FTS-only, and a console line is gone
    // the moment the app was started from anything but a terminal.
    log('embed-endpoint', 'disabled — search_past_chats stays FTS-only', {
      path: opts.socketPath,
      error: String(err)
    });
  });
  server.listen(opts.socketPath, () => {
    if (isPipe) return;
    try {
      chmodSync(opts.socketPath, 0o600);
    } catch (err) {
      // The token still gates access, so this is not an open door — but the
      // filesystem is the layer that holds even if the token leaks, and losing
      // it leaves no other mark.
      degrade('embed-endpoint', 'left the embed socket at its default permissions', err);
    }
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          // Named pipes are not filesystem entries — unlink would throw or
          // target the wrong thing. Unix sockets still need cleanup.
          if (!isPipe) {
            try {
              unlinkSync(opts.socketPath);
            } catch {
              // quiet: already gone. One that survives is unlinked at the next
              // startup, and one that survives that fails listen() — logged there.
            }
          }
          resolve();
        });
      })
  };
}
