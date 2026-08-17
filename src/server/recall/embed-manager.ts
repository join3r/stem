import type { LocalEmbedModelSpec } from './embed-catalog';
import type { LocalRerankModelSpec } from './rerank-catalog';
import { DEFAULT_LOCAL_RERANK_MODEL } from './rerank-catalog';
import type { EmbedKind } from './embeddings';
import type { RerankResult } from './rerank';
import type { WorkerOutMessage } from './embed-worker';
import type { WorkerTransport } from './embed-worker-host';
import { log } from '../log';
import type { LocalEmbedStatus, LocalRerankStatus } from '../../shared/types';

// Main-process side of the local retrieval worker: owns the utility-process
// lifecycle (lazy spawn on first demand, respawn on crash, dispose on model
// switch) and multiplexes embed + rerank requests over it. One process hosts
// both models — the embedder and (when enabled) the reranker cross-encoder —
// each with its own spec, status channel, and request queue. Everything here is
// non-blocking: ensure() just kicks the machinery, and callers learn readiness
// via status()/onStatus rather than awaiting a download.
//
// The `embed-worker` log lines cover the lifecycle events that never reach a
// status callback, and so would otherwise exist nowhere a user can send us: a
// process that died (the status goes back to 'loading' while respawns are left)
// and a corrupt-cache purge (deliberately hidden from the UI, since the restart
// is about to fix it). Without them the two failures the UI *can* show —
// "worker exited" and "worker keeps crashing" — name nothing at all.

export interface EmbedWorkerManager {
  /**
   * Make sure the worker is up and loading `spec` (spawns/downloads if needed;
   * returns immediately). After a failure, re-kicks are rate-limited to one per
   * {@link ERROR_RETRY_MS} unless `force` (Test button / settings change).
   */
  ensure(spec: LocalEmbedModelSpec, opts?: { force?: boolean }): void;
  status(): LocalEmbedStatus;
  onStatus(cb: (status: LocalEmbedStatus) => void): () => void;
  /** Embed via the worker. Queued while loading/downloading; rejects on error state. */
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
  /** Model switch or mode left 'local': kill the worker; when a spec is given, start loading it. */
  reconfigure(spec: LocalEmbedModelSpec | null): void;
  /** Same contract as ensure(), for the reranker model co-hosted in the worker. */
  ensureRerank(spec: LocalRerankModelSpec, opts?: { force?: boolean }): void;
  rerankStatus(): LocalRerankStatus;
  onRerankStatus(cb: (status: LocalRerankStatus) => void): () => void;
  /** Rerank via the worker. Queued while loading/downloading; rejects on error state. */
  rerank(query: string, docs: string[], topN: number): Promise<RerankResult[]>;
  /** Reranker model switch or mode left 'local': reload the worker with the new set of models. */
  reconfigureRerank(spec: LocalRerankModelSpec | null): void;
  dispose(): void;
}

interface PendingEmbed {
  texts: string[];
  kind: EmbedKind;
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingRerank {
  query: string;
  docs: string[];
  topN: number;
  resolve: (results: RerankResult[]) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const EMBED_TIMEOUT_MS = 60_000;
const RERANK_TIMEOUT_MS = 30_000;
const ERROR_RETRY_MS = 5 * 60_000;
const MAX_RESPAWNS = 3;
// Restarts granted when the worker reports it purged a corrupt weights cache
// (truncated download). The retry MUST be a new process — a failed ONNX load
// poisons transformers.js state for every later load in the same one — and the
// budget is 2 so the embedder and the reranker can each self-heal once per
// kick; a re-download that comes back corrupt again settles into 'error'
// instead of looping the download forever.
const MAX_CORRUPT_RESPAWNS = 2;
// A worker that survives this long before dying is treated as a genuine one-off
// crash (fresh respawn budget), not a crash loop. Shorter than this counts toward
// MAX_RESPAWNS so a worker that aborts moments after loading — e.g. an ONNX OOM on
// the first backfill batch — settles into a visible 'error' instead of respawning
// forever. Must exceed a load+first-embed cycle (a few seconds) comfortably.
const STABLE_UPTIME_MS = 60_000;

export function createEmbedWorkerManager(deps: {
  spawn: () => WorkerTransport;
  cacheDir: () => string;
  embedTimeoutMs?: number;
  rerankTimeoutMs?: number;
}): EmbedWorkerManager {
  const embedTimeoutMs = deps.embedTimeoutMs ?? EMBED_TIMEOUT_MS;
  const rerankTimeoutMs = deps.rerankTimeoutMs ?? RERANK_TIMEOUT_MS;

  let transport: WorkerTransport | null = null;
  let spec: LocalEmbedModelSpec | null = null;
  let rerankSpec: LocalRerankModelSpec | null = null;
  let status: LocalEmbedStatus = { model: 'multilingual-e5-small', state: 'idle' };
  let rrStatus: LocalRerankStatus = { model: DEFAULT_LOCAL_RERANK_MODEL, state: 'idle' };
  let lastErrorAt = 0;
  let lastRerankErrorAt = 0;
  let respawns = 0;
  let corruptRespawns = 0;
  let spawnedAt = 0;
  let nextId = 1;
  const inflight = new Map<number, PendingEmbed>();
  const rerankInflight = new Map<number, PendingRerank>();
  const queued: PendingEmbed[] = []; // held until 'ready', then flushed
  const rerankQueued: PendingRerank[] = [];
  const listeners = new Set<(s: LocalEmbedStatus) => void>();
  const rerankListeners = new Set<(s: LocalRerankStatus) => void>();

  function setStatus(next: LocalEmbedStatus): void {
    status = next;
    if (next.state === 'error') lastErrorAt = Date.now();
    for (const cb of listeners) cb(next);
  }

  function setRerankStatus(next: LocalRerankStatus): void {
    rrStatus = next;
    if (next.state === 'error') lastRerankErrorAt = Date.now();
    for (const cb of rerankListeners) cb(next);
  }

  function failEmbeds(message: string): void {
    const err = new Error(message);
    for (const p of inflight.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    inflight.clear();
    for (const p of queued.splice(0)) p.reject(err);
  }

  function failReranks(message: string): void {
    const err = new Error(message);
    for (const p of rerankInflight.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    rerankInflight.clear();
    for (const p of rerankQueued.splice(0)) p.reject(err);
  }

  function failAll(embedMessage: string, rerankMessage: string): void {
    failEmbeds(embedMessage);
    failReranks(rerankMessage);
  }

  function sendEmbed(p: PendingEmbed): void {
    if (!transport) return;
    const id = nextId++;
    inflight.set(id, p);
    p.timer = setTimeout(() => {
      inflight.delete(id);
      p.reject(new Error(`local embeddings: timed out after ${embedTimeoutMs}ms`));
    }, embedTimeoutMs);
    transport.send({ type: 'embed', id, texts: p.texts, kind: p.kind });
  }

  function sendRerank(p: PendingRerank): void {
    if (!transport) return;
    const id = nextId++;
    rerankInflight.set(id, p);
    p.timer = setTimeout(() => {
      rerankInflight.delete(id);
      p.reject(new Error(`local reranker: timed out after ${rerankTimeoutMs}ms`));
    }, rerankTimeoutMs);
    transport.send({ type: 'rerank', id, query: p.query, docs: p.docs, topN: p.topN });
  }

  /**
   * The worker found and purged a corrupt weights cache: restart it so the
   * re-download happens in a clean process, silently (statuses go back to
   * 'loading' rather than surfacing an error the restart is about to fix).
   * Within budget only; past it the error status flows through as usual.
   */
  function restartAfterCorruptPurge(status: {
    state: string;
    error?: string;
    purgedCorruptCache?: boolean;
  }): boolean {
    if (status.state !== 'error' || !status.purgedCorruptCache) return false;
    if (corruptRespawns >= MAX_CORRUPT_RESPAWNS) return false;
    corruptRespawns += 1;
    // The one failure the UI never shows: a re-download that keeps coming back
    // corrupt reads as a slow first load until the budget runs out.
    log('embed-worker', 'purged corrupt weights cache, restarting to re-download', {
      attempt: corruptRespawns,
      of: MAX_CORRUPT_RESPAWNS,
      error: status.error
    });
    stop();
    spawnProcess();
    return true;
  }

  function handleMessage(raw: unknown): void {
    const msg = raw as WorkerOutMessage;
    if (msg.type === 'status') {
      if (restartAfterCorruptPurge(msg.status)) return;
      setStatus(msg.status);
      if (msg.status.state === 'ready') {
        // Reaching 'ready' does NOT reset the respawn budget: a worker can load
        // fine and then abort on the first embed (ONNX OOM), and resetting here
        // would let that crash loop forever. The budget is refreshed instead when
        // a worker proves stable by living past STABLE_UPTIME_MS (see onExit).
        for (const p of queued.splice(0)) sendEmbed(p);
      } else if (msg.status.state === 'error') {
        failEmbeds(`local embeddings: ${msg.status.error ?? 'model failed to load'}`);
      }
      return;
    }
    if (msg.type === 'rerank-status') {
      if (restartAfterCorruptPurge(msg.status)) return;
      setRerankStatus(msg.status);
      if (msg.status.state === 'ready') {
        for (const p of rerankQueued.splice(0)) sendRerank(p);
      } else if (msg.status.state === 'error') {
        failReranks(`local reranker: ${msg.status.error ?? 'model failed to load'}`);
      }
      return;
    }
    if (msg.type === 'result') {
      const p = inflight.get(msg.id);
      if (!p) return; // timed out already
      inflight.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(msg.vectors);
      return;
    }
    if (msg.type === 'rerank-result') {
      const p = rerankInflight.get(msg.id);
      if (!p) return; // timed out already
      rerankInflight.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(msg.results);
      return;
    }
    if (msg.type === 'error') {
      if (typeof msg.id !== 'number') return; // load errors arrive as status
      const pe = inflight.get(msg.id);
      if (pe) {
        inflight.delete(msg.id);
        if (pe.timer) clearTimeout(pe.timer);
        pe.reject(new Error(`local embeddings: ${msg.message}`));
        return;
      }
      const pr = rerankInflight.get(msg.id);
      if (pr) {
        rerankInflight.delete(msg.id);
        if (pr.timer) clearTimeout(pr.timer);
        pr.reject(new Error(`local reranker: ${msg.message}`));
      }
    }
  }

  /** Start the worker process and kick loads for whichever specs are set. */
  function spawnProcess(): void {
    let t: WorkerTransport;
    try {
      t = deps.spawn();
    } catch (err) {
      // Never throws out of ensure(): callers (available() on the turn hot path)
      // must fall back, not break the turn.
      const message = err instanceof Error ? err.message : 'failed to start embedding worker';
      log('embed-worker', 'fork failed', { error: message });
      if (spec) setStatus({ model: spec.id, state: 'error', error: message });
      if (rerankSpec) setRerankStatus({ model: rerankSpec.id, state: 'error', error: message });
      return;
    }
    transport = t;
    spawnedAt = Date.now();
    // Anchors the story a failure log has to tell: "never even forked" and
    // "forked and then died" are the same silence without this line.
    log('embed-worker', 'spawned', { embed: spec?.id ?? null, rerank: rerankSpec?.id ?? null });
    if (spec) setStatus({ model: spec.id, state: 'loading' });
    if (rerankSpec) setRerankStatus({ model: rerankSpec.id, state: 'loading' });
    // Identity-guarded: a superseded worker lives up to 2 s after stop() and its
    // late messages must not clobber the replacement's status or requests.
    t.onMessage((msg) => {
      if (transport === t) handleMessage(msg);
    });
    t.onExit((code) => {
      if (transport !== t) return; // superseded by reconfigure
      transport = null;
      const uptimeMs = Date.now() - spawnedAt;
      failAll('local embeddings: worker exited', 'local reranker: worker exited');
      // A worker that ran past STABLE_UPTIME_MS before dying is a one-off crash,
      // not a loop — refund its respawn budget so a long-lived worker that finally
      // trips over one bad input gets a fresh start.
      if (uptimeMs >= STABLE_UPTIME_MS) respawns = 0;
      // Unexpected exit (dispose/reconfigure clear `transport` first): respawn
      // with a cap so a crash-looping model settles into 'error' instead of
      // burning CPU forever; the next settings change or Test resets the count.
      const respawning = respawns < MAX_RESPAWNS && !!(spec || rerankSpec);
      // A process that ABORTS (ONNX OOM, an ORT mutex abort on load) never posts
      // an error status, so this exit is the only record that it ran at all. The
      // reason itself died with the child's stderr; the code and the uptime are
      // what separate "aborted mid-load" from "aborted on the first embed".
      log('embed-worker', 'worker exited unexpectedly', {
        code: code ?? null,
        uptimeMs,
        embed: spec?.id ?? null,
        rerank: rerankSpec?.id ?? null,
        respawning,
        respawns
      });
      if (respawning) {
        respawns += 1;
        spawnProcess();
      } else {
        const error = 'worker keeps crashing — try a smaller model or turn the stage off';
        if (spec) setStatus({ model: spec.id, state: 'error', error });
        if (rerankSpec) setRerankStatus({ model: rerankSpec.id, state: 'error', error });
      }
    });
    if (spec) t.send({ type: 'load', spec, cacheDir: deps.cacheDir() });
    if (rerankSpec) t.send({ type: 'load-rerank', spec: rerankSpec, cacheDir: deps.cacheDir() });
  }

  function stop(): void {
    const t = transport;
    transport = null; // cleared first so onExit doesn't respawn
    if (t) {
      // Ask the worker to release its ONNX sessions, then SIGTERM it on ack. The
      // worker never exits itself — process.exit() with a live ORT thread pool
      // aborts ("mutex lock failed"), while SIGTERM skips C++ static destructors
      // and can't. The timer is the backstop for a hung worker.
      t.send({ type: 'dispose' });
      const killTimer = setTimeout(() => t.kill(), 2000);
      killTimer.unref?.();
      t.onMessage((raw) => {
        if ((raw as WorkerOutMessage).type === 'disposed') {
          clearTimeout(killTimer);
          t.kill();
        }
      });
    }
    failAll('local embeddings: worker stopped', 'local reranker: worker stopped');
  }

  return {
    ensure(target, opts = {}) {
      const sameModel = spec?.id === target.id;
      // Healthy (or still loading) worker on the right model → nothing to do.
      if (sameModel && transport && status.state !== 'error') return;
      // After a failure the worker may still be alive but useless; retries are
      // rate-limited so the turn-hot-path available() probe can't hammer a dead
      // endpoint, while force (Test button / settings change) restarts now.
      if (sameModel && status.state === 'error' && !opts.force && Date.now() - lastErrorAt < ERROR_RETRY_MS) return;
      // A live worker that just isn't running THIS model yet (e.g. spawned for
      // the reranker alone) can load it in place — no process restart needed.
      if (transport && !spec) {
        spec = target;
        setStatus({ model: target.id, state: 'loading' });
        transport.send({ type: 'load', spec: target, cacheDir: deps.cacheDir() });
        return;
      }
      if (transport) stop();
      spec = target;
      respawns = 0;
      corruptRespawns = 0;
      spawnProcess();
    },
    status: () => status,
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    embed(texts, kind) {
      return new Promise<Float32Array[]>((resolve, reject) => {
        const p: PendingEmbed = { texts, kind, resolve, reject };
        if (status.state === 'ready' && transport) sendEmbed(p);
        else if (transport && (status.state === 'loading' || status.state === 'downloading')) queued.push(p);
        else reject(new Error('local embeddings: worker not running'));
      });
    },
    reconfigure(target) {
      stop();
      spec = target;
      if (!target) setStatus({ model: status.model, state: 'idle' });
      if (target || rerankSpec) {
        respawns = 0;
        corruptRespawns = 0;
        spawnProcess();
      }
    },
    ensureRerank(target, opts = {}) {
      const sameModel = rerankSpec?.id === target.id;
      if (sameModel && transport && rrStatus.state !== 'error') return;
      if (
        sameModel &&
        rrStatus.state === 'error' &&
        !opts.force &&
        Date.now() - lastRerankErrorAt < ERROR_RETRY_MS
      )
        return;
      // The worker replaces its reranker in place (disposing the old session),
      // so a live process never needs a restart for a rerank load/switch.
      if (transport) {
        rerankSpec = target;
        setRerankStatus({ model: target.id, state: 'loading' });
        transport.send({ type: 'load-rerank', spec: target, cacheDir: deps.cacheDir() });
        return;
      }
      rerankSpec = target;
      respawns = 0;
      corruptRespawns = 0;
      spawnProcess();
    },
    rerankStatus: () => rrStatus,
    onRerankStatus(cb) {
      rerankListeners.add(cb);
      return () => rerankListeners.delete(cb);
    },
    rerank(query, docs, topN) {
      return new Promise<RerankResult[]>((resolve, reject) => {
        const p: PendingRerank = { query, docs, topN, resolve, reject };
        if (rrStatus.state === 'ready' && transport) sendRerank(p);
        else if (transport && (rrStatus.state === 'loading' || rrStatus.state === 'downloading'))
          rerankQueued.push(p);
        else reject(new Error('local reranker: worker not running'));
      });
    },
    reconfigureRerank(target) {
      // Unlike an embed-model switch, the reranker can be swapped in place; a
      // full restart is only needed to UNLOAD it (freeing its ONNX session).
      if (target && transport) {
        this.ensureRerank(target, { force: true });
        return;
      }
      stop();
      rerankSpec = target;
      if (!target) setRerankStatus({ model: rrStatus.model, state: 'idle' });
      if (target || spec) {
        respawns = 0;
        corruptRespawns = 0;
        spawnProcess();
      }
    },
    dispose() {
      stop();
      spec = null;
      rerankSpec = null;
    }
  };
}
