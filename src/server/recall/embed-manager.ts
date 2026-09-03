import type { LocalEmbedModelSpec } from './embed-catalog';
import type { LocalRerankModelSpec } from './rerank-catalog';
import { DEFAULT_LOCAL_RERANK_MODEL } from './rerank-catalog';
import { EmbeddingsTimeoutError, type EmbedKind } from './embeddings';
import type { RerankResult } from './rerank';
import type { WorkerOutMessage } from './embed-worker';
import type { WorkerTransport } from './embed-worker-host';
import { log } from '../log';
import type { LocalEmbedStatus, LocalRerankStatus } from '../../shared/types';

// Main-process side of the local retrieval workers: owns utility-process
// lifecycle (lazy spawn, respawn on crash, dispose on model switch) and
// multiplexes requests. Embedder and reranker each get their own process —
// co-hosting them in one ONNX runtime is what aborted Qwen3-Reranker-0.6B
// (exit 5 / SIGTRAP) after the embedder had already loaded. Callers learn
// readiness via status()/onStatus; ensure() never blocks the turn.
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
  /**
   * Embed via the worker. Queued while loading/downloading; rejects on error
   * state; rejects with {@link EmbeddingsTimeoutError} when the worker does not
   * answer within `timeoutMs` (default {@link EMBED_TIMEOUT_MS}), telling the
   * worker to drop the request. Passage requests go to the worker one at a
   * time, so a budget measures the worker's work on that request and not its
   * wait behind other backfills; queries go straight through.
   */
  embed(texts: string[], kind: EmbedKind, opts?: { timeoutMs?: number }): Promise<Float32Array[]>;
  /** Model switch or mode left 'local': kill the embed worker; when a spec is given, start loading it. */
  reconfigure(spec: LocalEmbedModelSpec | null): void;
  /** Same contract as ensure(), for the reranker in its own worker. */
  ensureRerank(spec: LocalRerankModelSpec, opts?: { force?: boolean }): void;
  rerankStatus(): LocalRerankStatus;
  onRerankStatus(cb: (status: LocalRerankStatus) => void): () => void;
  /** Rerank via the worker. Queued while loading/downloading; rejects on error state. */
  rerank(query: string, docs: string[], topN: number): Promise<RerankResult[]>;
  /** Reranker model switch or mode left 'local': reload only the rerank worker. */
  reconfigureRerank(spec: LocalRerankModelSpec | null): void;
  dispose(): void;
}

interface PendingEmbed {
  texts: string[];
  kind: EmbedKind;
  /** Per-request budget: the local client hands passages a longer one than queries. */
  timeoutMs: number;
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
// budget is 2 so a re-download that comes back corrupt again settles into
// 'error' instead of looping the download forever. Each stage has its own count.
const MAX_CORRUPT_RESPAWNS = 2;
// A worker that survives this long before dying is treated as a genuine one-off
// crash (fresh respawn budget), not a crash loop. Shorter than this counts toward
// MAX_RESPAWNS so a worker that aborts moments after loading — e.g. an ONNX OOM on
// the first backfill batch — settles into a visible 'error' instead of respawning
// forever. Must exceed a load+first-embed cycle (a few seconds) comfortably.
const STABLE_UPTIME_MS = 60_000;

/** Settled crash-loop copy. Qwen3's ~1.2 GB causal LM is named because that is
 *  the model the 0.5.0 default puts here, and the one that aborts on machines
 *  that load the embedder fine — BGE is the smaller catalog alternative. */
function stageCrashError(
  kind: 'embed' | 'rerank',
  model: { id: string; label: string; approxSizeMB: number }
): string {
  if (kind === 'rerank' && model.id === 'qwen3-reranker-0.6b') {
    return `${model.label} (~${model.approxSizeMB} MB) is too large for this machine — pick BGE or turn the stage off`;
  }
  return 'worker keeps crashing — try a smaller model or turn the stage off';
}

export function createEmbedWorkerManager(deps: {
  spawn: () => WorkerTransport;
  cacheDir: () => string;
  embedTimeoutMs?: number;
  rerankTimeoutMs?: number;
}): EmbedWorkerManager {
  const embedTimeoutMs = deps.embedTimeoutMs ?? EMBED_TIMEOUT_MS;
  const rerankTimeoutMs = deps.rerankTimeoutMs ?? RERANK_TIMEOUT_MS;

  let embedTransport: WorkerTransport | null = null;
  let rerankTransport: WorkerTransport | null = null;
  let spec: LocalEmbedModelSpec | null = null;
  let rerankSpec: LocalRerankModelSpec | null = null;
  let status: LocalEmbedStatus = { model: 'multilingual-e5-small', state: 'idle' };
  let rrStatus: LocalRerankStatus = { model: DEFAULT_LOCAL_RERANK_MODEL, state: 'idle' };
  let lastErrorAt = 0;
  let lastRerankErrorAt = 0;
  let embedRespawns = 0;
  let rerankRespawns = 0;
  let embedCorruptRespawns = 0;
  let rerankCorruptRespawns = 0;
  let embedSpawnedAt = 0;
  let rerankSpawnedAt = 0;
  let nextId = 1;
  const inflight = new Map<number, PendingEmbed>();
  const rerankInflight = new Map<number, PendingRerank>();
  const queued: PendingEmbed[] = []; // held until 'ready', then flushed
  // One passage request at the worker at a time; the rest wait here with their
  // timers not yet started. Queries bypass this — the worker runs them first.
  let passageActive: PendingEmbed | null = null;
  const passageWaiting: PendingEmbed[] = [];
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
    passageActive = null;
    for (const p of passageWaiting.splice(0)) p.reject(err);
    for (const p of queued.splice(0)) p.reject(err);
  }

  /** Route a ready-state request: queries go now, passages one at a time. */
  function dispatch(p: PendingEmbed): void {
    if (p.kind !== 'passage') {
      sendEmbed(p);
      return;
    }
    if (passageActive) {
      passageWaiting.push(p);
      return;
    }
    passageActive = p;
    sendEmbed(p);
  }

  /** An in-flight request finished (any way): let the next passage in. */
  function settled(p: PendingEmbed): void {
    if (passageActive !== p) return;
    passageActive = null;
    const next = passageWaiting.shift();
    if (next) {
      passageActive = next;
      sendEmbed(next);
    }
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

  function sendEmbed(p: PendingEmbed): void {
    if (!embedTransport) return;
    const id = nextId++;
    inflight.set(id, p);
    p.timer = setTimeout(() => {
      inflight.delete(id);
      // Tell the worker to stop: without this the abandoned run keeps the
      // cores for as long as the request would have taken, and every request
      // behind it inherits the wait (the 2026-09-03 incident).
      embedTransport?.send({ type: 'cancel', id });
      p.reject(new EmbeddingsTimeoutError(`local embeddings: timed out after ${p.timeoutMs}ms`));
      settled(p);
    }, p.timeoutMs);
    embedTransport.send({ type: 'embed', id, texts: p.texts, kind: p.kind });
  }

  function sendRerank(p: PendingRerank): void {
    if (!rerankTransport) return;
    const id = nextId++;
    rerankInflight.set(id, p);
    p.timer = setTimeout(() => {
      rerankInflight.delete(id);
      p.reject(new Error(`local reranker: timed out after ${rerankTimeoutMs}ms`));
    }, rerankTimeoutMs);
    rerankTransport.send({ type: 'rerank', id, query: p.query, docs: p.docs, topN: p.topN });
  }

  /**
   * Ask a worker to drop its ONNX session, then SIGTERM it. The worker never
   * exits itself — process.exit() with a live ORT thread pool aborts
   * ("mutex lock failed"), while SIGTERM skips C++ static destructors and can't.
   * The timer is the backstop for a hung worker. Clearing `slot` first stops
   * onExit from treating this as a crash.
   */
  function shutdown(slot: { current: WorkerTransport | null }): void {
    const t = slot.current;
    slot.current = null;
    if (!t) return;
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

  const embedSlot = { get current() { return embedTransport; }, set current(v) { embedTransport = v; } };
  const rerankSlot = { get current() { return rerankTransport; }, set current(v) { rerankTransport = v; } };

  /**
   * The worker found and purged a corrupt weights cache: restart THAT stage's
   * process so the re-download happens clean, silently. The other stage is
   * left running — a truncated embedder download must not bounce the reranker.
   */
  function restartAfterCorruptPurge(
    kind: 'embed' | 'rerank',
    next: { state: string; error?: string; purgedCorruptCache?: boolean }
  ): boolean {
    if (next.state !== 'error' || !next.purgedCorruptCache) return false;
    const used = kind === 'embed' ? embedCorruptRespawns : rerankCorruptRespawns;
    if (used >= MAX_CORRUPT_RESPAWNS) return false;
    if (kind === 'embed') embedCorruptRespawns += 1;
    else rerankCorruptRespawns += 1;
    log('embed-worker', 'purged corrupt weights cache, restarting to re-download', {
      attempt: kind === 'embed' ? embedCorruptRespawns : rerankCorruptRespawns,
      of: MAX_CORRUPT_RESPAWNS,
      error: next.error,
      kind
    });
    if (kind === 'embed') {
      failEmbeds('local embeddings: worker stopped');
      shutdown(embedSlot);
      spawnEmbed();
    } else {
      failReranks('local reranker: worker stopped');
      shutdown(rerankSlot);
      spawnRerank();
    }
    return true;
  }

  function handleEmbedMessage(raw: unknown): void {
    const msg = raw as WorkerOutMessage;
    if (msg.type === 'status') {
      if (restartAfterCorruptPurge('embed', msg.status)) return;
      setStatus(msg.status);
      if (msg.status.state === 'ready') {
        // Reaching 'ready' does NOT reset the respawn budget: a worker can load
        // fine and then abort on the first embed (ONNX OOM), and resetting here
        // would let that crash loop forever. The budget is refreshed instead when
        // a worker proves stable by living past STABLE_UPTIME_MS (see onExit).
        for (const p of queued.splice(0)) dispatch(p);
      } else if (msg.status.state === 'error') {
        failEmbeds(`local embeddings: ${msg.status.error ?? 'model failed to load'}`);
      }
      return;
    }
    if (msg.type === 'result') {
      const p = inflight.get(msg.id);
      if (!p) return; // timed out already
      inflight.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(msg.vectors);
      settled(p);
      return;
    }
    if (msg.type === 'error' && typeof msg.id === 'number') {
      const pe = inflight.get(msg.id);
      if (!pe) return;
      inflight.delete(msg.id);
      if (pe.timer) clearTimeout(pe.timer);
      pe.reject(new Error(`local embeddings: ${msg.message}`));
      settled(pe);
    }
  }

  function handleRerankMessage(raw: unknown): void {
    const msg = raw as WorkerOutMessage;
    if (msg.type === 'rerank-status') {
      if (restartAfterCorruptPurge('rerank', msg.status)) return;
      setRerankStatus(msg.status);
      if (msg.status.state === 'ready') {
        for (const p of rerankQueued.splice(0)) sendRerank(p);
      } else if (msg.status.state === 'error') {
        failReranks(`local reranker: ${msg.status.error ?? 'model failed to load'}`);
      }
      return;
    }
    if (msg.type === 'rerank-result') {
      const p = rerankInflight.get(msg.id);
      if (!p) return;
      rerankInflight.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      p.resolve(msg.results);
      return;
    }
    if (msg.type === 'error' && typeof msg.id === 'number') {
      const pr = rerankInflight.get(msg.id);
      if (!pr) return;
      rerankInflight.delete(msg.id);
      if (pr.timer) clearTimeout(pr.timer);
      pr.reject(new Error(`local reranker: ${msg.message}`));
    }
  }

  function onUnexpectedExit(
    kind: 'embed' | 'rerank',
    code: number | undefined,
    uptimeMs: number
  ): void {
    if (uptimeMs >= STABLE_UPTIME_MS) {
      if (kind === 'embed') embedRespawns = 0;
      else rerankRespawns = 0;
    }
    const respawns = kind === 'embed' ? embedRespawns : rerankRespawns;
    const want = kind === 'embed' ? spec : rerankSpec;
    const respawning = respawns < MAX_RESPAWNS && !!want;
    log('embed-worker', 'worker exited unexpectedly', {
      code: code ?? null,
      uptimeMs,
      kind,
      embed: spec?.id ?? null,
      rerank: rerankSpec?.id ?? null,
      respawning,
      respawns
    });
    if (respawning) {
      if (kind === 'embed') {
        embedRespawns += 1;
        spawnEmbed();
      } else {
        rerankRespawns += 1;
        spawnRerank();
      }
      return;
    }
    const error = kind === 'embed' && spec
      ? stageCrashError('embed', spec)
      : kind === 'rerank' && rerankSpec
        ? stageCrashError('rerank', rerankSpec)
        : 'worker keeps crashing — try a smaller model or turn the stage off';
    if (kind === 'embed' && spec) setStatus({ model: spec.id, state: 'error', error });
    if (kind === 'rerank' && rerankSpec) setRerankStatus({ model: rerankSpec.id, state: 'error', error });
  }

  function spawnEmbed(): void {
    if (!spec) return;
    let t: WorkerTransport;
    try {
      t = deps.spawn();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to start embedding worker';
      log('embed-worker', 'fork failed', { error: message, kind: 'embed' });
      setStatus({ model: spec.id, state: 'error', error: message });
      return;
    }
    embedTransport = t;
    embedSpawnedAt = Date.now();
    log('embed-worker', 'spawned', { embed: spec.id, rerank: null });
    setStatus({ model: spec.id, state: 'loading' });
    t.onMessage((msg) => {
      if (embedTransport === t) handleEmbedMessage(msg);
    });
    t.onExit((code) => {
      if (embedTransport !== t) return;
      embedTransport = null;
      failEmbeds('local embeddings: worker exited');
      onUnexpectedExit('embed', code, Date.now() - embedSpawnedAt);
    });
    t.send({ type: 'load', spec, cacheDir: deps.cacheDir() });
  }

  function spawnRerank(): void {
    if (!rerankSpec) return;
    let t: WorkerTransport;
    try {
      t = deps.spawn();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to start embedding worker';
      log('embed-worker', 'fork failed', { error: message, kind: 'rerank' });
      setRerankStatus({ model: rerankSpec.id, state: 'error', error: message });
      return;
    }
    rerankTransport = t;
    rerankSpawnedAt = Date.now();
    log('embed-worker', 'spawned', { embed: null, rerank: rerankSpec.id });
    setRerankStatus({ model: rerankSpec.id, state: 'loading' });
    t.onMessage((msg) => {
      if (rerankTransport === t) handleRerankMessage(msg);
    });
    t.onExit((code) => {
      if (rerankTransport !== t) return;
      rerankTransport = null;
      failReranks('local reranker: worker exited');
      onUnexpectedExit('rerank', code, Date.now() - rerankSpawnedAt);
    });
    t.send({ type: 'load-rerank', spec: rerankSpec, cacheDir: deps.cacheDir() });
  }

  return {
    ensure(target, opts = {}) {
      const sameModel = spec?.id === target.id;
      if (sameModel && embedTransport && status.state !== 'error') return;
      if (sameModel && status.state === 'error' && !opts.force && Date.now() - lastErrorAt < ERROR_RETRY_MS)
        return;
      if (embedTransport) {
        failEmbeds('local embeddings: worker stopped');
        shutdown(embedSlot);
      }
      spec = target;
      embedRespawns = 0;
      embedCorruptRespawns = 0;
      spawnEmbed();
    },
    status: () => status,
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    embed(texts, kind, opts = {}) {
      return new Promise<Float32Array[]>((resolve, reject) => {
        const p: PendingEmbed = { texts, kind, timeoutMs: opts.timeoutMs ?? embedTimeoutMs, resolve, reject };
        if (status.state === 'ready' && embedTransport) dispatch(p);
        else if (embedTransport && (status.state === 'loading' || status.state === 'downloading')) queued.push(p);
        else reject(new Error('local embeddings: worker not running'));
      });
    },
    reconfigure(target) {
      failEmbeds('local embeddings: worker stopped');
      shutdown(embedSlot);
      spec = target;
      if (!target) setStatus({ model: status.model, state: 'idle' });
      if (target) {
        embedRespawns = 0;
        embedCorruptRespawns = 0;
        spawnEmbed();
      }
    },
    ensureRerank(target, opts = {}) {
      const sameModel = rerankSpec?.id === target.id;
      if (sameModel && rerankTransport && rrStatus.state !== 'error') return;
      if (
        sameModel &&
        rrStatus.state === 'error' &&
        !opts.force &&
        Date.now() - lastRerankErrorAt < ERROR_RETRY_MS
      )
        return;
      // Same process, different weights: the worker disposes the old session
      // before loading the new one. A live crash-looping worker is restarted.
      if (rerankTransport && rrStatus.state !== 'error') {
        rerankSpec = target;
        setRerankStatus({ model: target.id, state: 'loading' });
        rerankTransport.send({ type: 'load-rerank', spec: target, cacheDir: deps.cacheDir() });
        return;
      }
      if (rerankTransport) {
        failReranks('local reranker: worker stopped');
        shutdown(rerankSlot);
      }
      rerankSpec = target;
      rerankRespawns = 0;
      rerankCorruptRespawns = 0;
      spawnRerank();
    },
    rerankStatus: () => rrStatus,
    onRerankStatus(cb) {
      rerankListeners.add(cb);
      return () => rerankListeners.delete(cb);
    },
    rerank(query, docs, topN) {
      return new Promise<RerankResult[]>((resolve, reject) => {
        const p: PendingRerank = { query, docs, topN, resolve, reject };
        if (rrStatus.state === 'ready' && rerankTransport) sendRerank(p);
        else if (rerankTransport && (rrStatus.state === 'loading' || rrStatus.state === 'downloading'))
          rerankQueued.push(p);
        else reject(new Error('local reranker: worker not running'));
      });
    },
    reconfigureRerank(target) {
      if (target && rerankTransport) {
        this.ensureRerank(target, { force: true });
        return;
      }
      failReranks('local reranker: worker stopped');
      shutdown(rerankSlot);
      rerankSpec = target;
      if (!target) setRerankStatus({ model: rrStatus.model, state: 'idle' });
      if (target) {
        rerankRespawns = 0;
        rerankCorruptRespawns = 0;
        spawnRerank();
      }
    },
    dispose() {
      failEmbeds('local embeddings: worker stopped');
      failReranks('local reranker: worker stopped');
      shutdown(embedSlot);
      shutdown(rerankSlot);
      spec = null;
      rerankSpec = null;
    }
  };
}
