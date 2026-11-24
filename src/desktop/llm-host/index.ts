import { log } from '../../server/log';
import type { DeviceLlmAck, DeviceLlmChunk, DeviceLlmRequest } from '../../shared/types';

// The model servers the Stem server reaches through THIS computer
// (server/llm-device/router.ts has the other half). A request arrives off the
// event stream, is made against this machine's own network, and the answer
// goes back in ordered batches over ordinary RPCs.
//
// The server picks the URL, so this end decides what it will fetch: an address
// on this computer or its local network, and only the model-API paths. A
// server that was taken over gets no proxy onto the internet out of this, and
// no route to anything on the LAN that is not shaped like a model server.

/** How long output may gather before it goes out: short enough to read as streaming. */
const FLUSH_MS = 40;
/** And how much: a big non-streamed answer goes in pieces, not one huge RPC. */
const FLUSH_BYTES = 256 * 1024;
/** An empty batch while nothing arrives, so the server can tell slow from gone. */
const HEARTBEAT_MS = 10_000;
/** The endpoints pi and the model probe use, matched as the end of the path (a base URL may carry a prefix). */
const MODEL_API_PATHS = [
  '/v1/models',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/completions',
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/embeddings',
  '/api/show'
];
/** The only request headers a model server needs; nothing else the server sends goes out. */
const ALLOWED_HEADERS = ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type', 'accept'];

export interface LlmHostDeps {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  fetch?: typeof fetch;
}

export interface LlmHost {
  onRequest(request: DeviceLlmRequest): void;
  onCancel(cancel: { requestId: string }): void;
  close(): void;
}

/** Whether `host` is this machine or its local network. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan')) return true;
  // A bare name ("gpubox") resolves on the local network or not at all.
  if (/^[a-z0-9-]+$/.test(h) && !/^\d+$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      // Tailscale and other CGNAT overlays: a model box on the tailnet.
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // Link-local (169.254/16, fe80::/10) is left out on purpose: it is where
  // cloud metadata services answer, and no model server lives there.
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h);
}

/** Why this end refuses `request`, or null when it may go out. */
export function refusal(request: DeviceLlmRequest): string | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'That is not a URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https model servers can be reached.';
  if (!isLocalHost(url.hostname)) {
    return `${url.hostname} is not on this computer or its local network, so Stem will not reach it from here.`;
  }
  // The endpoint, after an optional prefix of plain segments (a gateway's
  // "/lmstudio"). Nothing with a dot, semicolon or escape gets through, so a
  // path like "/admin.php/v1/models" is not a model API that happens to match.
  const endpoint = MODEL_API_PATHS.find((p) => url.pathname.endsWith(p));
  const prefix = endpoint ? url.pathname.slice(0, -endpoint.length) : null;
  if (prefix === null || !/^(\/[A-Za-z0-9_-]+)*$/.test(prefix)) return 'Only model API paths are relayed.';
  return null;
}

export function createLlmHost(deps: LlmHostDeps): LlmHost {
  const doFetch = deps.fetch ?? fetch;
  const live = new Map<string, AbortController>();

  async function run(request: DeviceLlmRequest): Promise<void> {
    const controller = new AbortController();
    live.set(request.requestId, controller);
    let seq = 0;
    // Batches go out one at a time: the server reorders anyway, but a chain
    // keeps a slow link from opening dozens of connections at once.
    let chain: Promise<void> = Promise.resolve();
    const send = (chunk: Omit<DeviceLlmChunk, 'requestId' | 'seq'>): Promise<void> => {
      const batch: DeviceLlmChunk = { requestId: request.requestId, seq: seq++, ...chunk };
      chain = chain.then(async () => {
        if (controller.signal.aborted && !batch.done && !batch.error) return;
        try {
          const ack = (await deps.invoke('llmHost:chunk', [batch])) as DeviceLlmAck | undefined;
          if (ack && ack.live === false) controller.abort();
        } catch (e) {
          // The server is gone or restarted; nobody is reading this answer.
          log('llm-host', 'could not send a response batch', { error: String(e) });
          controller.abort();
        }
      });
      return chain;
    };
    const heartbeat = setInterval(() => void send({}), HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const refused = refusal(request);
      if (refused) {
        await send({ error: refused });
        return;
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (ALLOWED_HEADERS.includes(name.toLowerCase())) headers[name] = value;
      }
      const res = await doFetch(request.url, {
        method: request.method,
        headers,
        // A redirect would take the request somewhere refusal() never looked at.
        redirect: 'error',
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: controller.signal
      });
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((value, name) => (resHeaders[name] = value));
      let pending = '';
      let first = true;
      let timer: NodeJS.Timeout | null = null;
      const flush = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!pending && !first) return;
        const data = pending;
        pending = '';
        void send({ ...(first ? { status: res.status, headers: resHeaders } : {}), ...(data ? { data } : {}) });
        first = false;
      };
      // The head goes now: a model that is still loading should not look dead.
      flush();
      if (res.body) {
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length >= FLUSH_BYTES) flush();
          else timer ??= setTimeout(flush, FLUSH_MS);
        }
        pending += decoder.decode();
      }
      flush();
      await send({ done: true });
    } catch (e) {
      if (controller.signal.aborted) return;
      const message = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e);
      await send({ error: `Nothing answered at ${new URL(request.url).origin} on that computer (${message}).` });
    } finally {
      clearInterval(heartbeat);
      live.delete(request.requestId);
    }
  }

  return {
    onRequest(request) {
      void run(request);
    },
    onCancel({ requestId }) {
      live.get(requestId)?.abort();
    },
    close() {
      for (const controller of live.values()) controller.abort();
      live.clear();
    }
  };
}
