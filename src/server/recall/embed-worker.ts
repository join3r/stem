import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyPrefixes } from './embed-catalog';
import type { LocalEmbedModelSpec } from './embed-catalog';
import type { LocalRerankModelSpec } from './rerank-catalog';
import { modelPresent, pathAppearsInMessage } from './embed-files';
import type { EmbedKind } from './embeddings';
import type { RerankResult } from './rerank';
import type { LocalEmbedStatus, LocalRerankStatus } from '../../shared/types';

// Utility-process entry hosting the local retrieval models (transformers.js/
// ONNX): the embedding model and, when enabled, the reranker cross-encoder.
// Lives in its own process so CPU inference and model loading never block the
// main process — both sit on the chat-turn hot path. Talks to the manager
// (embed-manager.ts) over process.parentPort with plain structured-clone messages.
// This file must stay free of Electron imports beyond the ambient parentPort.

export type WorkerInMessage =
  | { type: 'load'; spec: LocalEmbedModelSpec; cacheDir: string }
  | { type: 'embed'; id: number; texts: string[]; kind: EmbedKind }
  | { type: 'load-rerank'; spec: LocalRerankModelSpec; cacheDir: string }
  | { type: 'rerank'; id: number; query: string; docs: string[]; topN: number }
  | { type: 'dispose' };

export type WorkerOutMessage =
  | { type: 'status'; status: LocalEmbedStatus }
  | { type: 'result'; id: number; dim: number; vectors: Float32Array[] }
  | { type: 'rerank-status'; status: LocalRerankStatus }
  | { type: 'rerank-result'; id: number; results: RerankResult[] }
  | { type: 'error'; id?: number; message: string }
  | { type: 'disposed' };

// Model runs in batches this size so one huge backfill request can't spike memory.
// Kept small deliberately: MultiHeadAttention allocates O(batch · maxSeqLen²) and
// every item in a batch pads to the longest one (up to the tokenizer's 512-token
// window). At 64, a batch of long episodic messages peaks ~2.7 GB and aborts
// onnxruntime inside the sandboxed utility process (BFCArena::Extend →
// posix_memalign fails → SIGTRAP). CPU inference is compute-bound, not
// batch-amortized — per-item throughput is the same at 8 as at 64 — so a small
// batch costs no speed while keeping the worst-case allocation ~1 GB.
const RUN_BATCH = 8;
// Download progress is per-chunk chatty; cap status posts to ~4/s.
const PROGRESS_THROTTLE_MS = 250;

type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ dims: number[]; data: Float32Array }>;

interface RerankTokenizerOutput extends Record<string, unknown> {
  attention_mask: { data: ArrayLike<number | bigint> };
}

/**
 * Tokenizer + model pair for the reranker. Two shapes share it:
 * - classifier: sequence-classification head, tokenized with text_pair, one
 *   logit per pair at logits[row].
 * - causal-yes-no: a causal LM fed the Qwen3-Reranker chat template as a
 *   single text per pair; the score is read from the vocab logits at each
 *   row's last real token (yesId/noId set only for this kind).
 */
interface Reranker {
  tokenizer: (
    texts: string[],
    opts: { text_pair?: string[]; padding: boolean; truncation: boolean }
  ) => RerankTokenizerOutput;
  model: ((inputs: Record<string, unknown>) => Promise<{ logits: { dims: number[]; data: Float32Array } }>) & {
    dispose?: () => Promise<void>;
  };
  scoring: LocalRerankModelSpec['scoring'];
  yesId?: number;
  noId?: number;
}

// The Qwen3-Reranker scoring contract (model card, "no thinking" form): the
// pair rides a fixed chat template and the instruct line comes from the
// catalog spec, where it was frozen alongside the measured floors.
const QWEN3_RERANK_PREFIX =
  '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. ' +
  'Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n';
const QWEN3_RERANK_SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n';

function formatCausalRerankPair(instruct: string, query: string, doc: string): string {
  return `${QWEN3_RERANK_PREFIX}<Instruct>: ${instruct}\n<Query>: ${query}\n<Document>: ${doc}${QWEN3_RERANK_SUFFIX}`;
}

// Under Electron's utilityProcess this is the real parentPort. Under the
// headless server's plain child_process.fork (host/index.ts forkNodeWorker)
// there is no parentPort, only node IPC — wrapped here in the same
// `{ data }` envelope so the rest of the file cannot tell who forked it.
const port = (process.parentPort ??
  ({
    postMessage: (msg: unknown) => process.send?.(msg),
    on(_event: string, cb: (e: { data: unknown }) => void) {
      process.on('message', (msg) => cb({ data: msg }));
      return this;
    }
  } as unknown)) as NonNullable<typeof process.parentPort>;

let spec: LocalEmbedModelSpec | null = null;
let extractor: Extractor | null = null;
let dim = 0;
let rerankSpec: LocalRerankModelSpec | null = null;
let reranker: Reranker | null = null;
let lastProgressPost = 0;

function post(msg: WorkerOutMessage): void {
  port.postMessage(msg);
}

function postStatus(status: Omit<LocalEmbedStatus, 'model'>): void {
  if (!spec) return;
  post({ type: 'status', status: { model: spec.id, ...status } });
}

function postRerankStatus(status: Omit<LocalRerankStatus, 'model'>): void {
  if (!rerankSpec) return;
  post({ type: 'rerank-status', status: { model: rerankSpec.id, ...status } });
}

/**
 * transformers.js progress events → one throttled status callback. Files
 * download in parallel and each reports independently, so per-file
 * {loaded,total} pairs are aggregated into a single percentage. When the
 * weights are already cached on disk the same events fire while streaming them
 * off disk, so `cached` reports those reads as plain loading instead.
 */
function progressAggregator(
  cached: boolean,
  postTo: (status: { state: 'downloading' | 'loading'; progressPct?: number }) => void
): (p: { status: string; file?: string; loaded?: number; total?: number }) => void {
  const files = new Map<string, { loaded: number; total: number }>();
  return (p) => {
    if (p.status !== 'progress' || !p.file || !p.total) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    const done = total > 0 && loaded >= total;
    const now = Date.now();
    if (!done && now - lastProgressPost < PROGRESS_THROTTLE_MS) return;
    lastProgressPost = now;
    postTo(
      cached || done
        ? { state: 'loading' } // bytes are in (or on disk already); ONNX session creation is what remains
        : { state: 'downloading', progressPct: Math.floor((loaded / total) * 100) }
    );
  };
}

/**
 * A cached weights file that ONNX Runtime cannot parse is a truncated download
 * (killed process, full disk) — transformers.js trusts the cache blindly, so
 * without intervention the same corrupt file fails on every restart forever.
 * The remedy: purge that model's cache dir so the bytes get fetched again, and
 * tell the manager (via `purgedCorruptCache`) to restart this process before
 * retrying. Retrying HERE does not work: a failed session load poisons
 * transformers.js module state, and every later load in this process — any
 * model, healthy weights or not — rejects with the first failure's error.
 * That poisoning is also why the path check matters: a load taken down by an
 * EARLIER model's corruption reports the earlier model's file, and purging our
 * own healthy cache over it would throw away good bytes.
 */
function purgeIfCorrupt(message: string, repo: string, cacheDir: string): boolean {
  if (!/protobuf parsing failed/i.test(message) || !pathAppearsInMessage(message, join(cacheDir, repo))) return false;
  rmSync(join(cacheDir, repo), { recursive: true, force: true });
  return true;
}

/**
 * Point transformers.js at our cache and tell it whether the Hub is still needed.
 * A complete model on disk means no request goes out at all — the machines this
 * matters for cannot reach huggingface.co, and a hanging DNS lookup is a worse
 * failure than a missing model. Returns whether the bytes were already there, so
 * progress events read as loading rather than downloading.
 */
function applyHubAccess(
  env: { cacheDir: string; allowRemoteModels?: boolean },
  cacheDir: string,
  repo: string,
  dtype: LocalEmbedModelSpec['dtype']
): boolean {
  env.cacheDir = cacheDir;
  const present = modelPresent(cacheDir, repo, dtype);
  env.allowRemoteModels = !present;
  return present;
}

async function load(nextSpec: LocalEmbedModelSpec, cacheDir: string): Promise<void> {
  spec = nextSpec;
  postStatus({ state: 'loading' });
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    const cached = applyHubAccess(env, cacheDir, nextSpec.repo, nextSpec.dtype);
    const pipe = (await pipeline('feature-extraction', nextSpec.repo, {
      dtype: nextSpec.dtype,
      progress_callback: progressAggregator(cached, postStatus)
    })) as unknown as Extractor;
    // Probe with a tiny input: verifies the model produces vectors, reports the
    // real dimension (not just the catalog's claim), and warms the session so the
    // first user-facing embed doesn't pay first-run graph-optimization cost.
    const probe = await pipe(['ping'], { pooling: 'mean', normalize: true });
    dim = probe.dims[probe.dims.length - 1];
    extractor = pipe;
    postStatus({ state: 'ready', dim });
  } catch (err) {
    // quiet: this process has no app log — parentPort is its only channel, and
    // the error status below is the one the Memory tab reads as a red stage.
    const message = err instanceof Error ? err.message : String(err);
    extractor = null;
    postStatus({
      state: 'error',
      error: message,
      purgedCorruptCache: purgeIfCorrupt(message, nextSpec.repo, cacheDir) || undefined
    });
  }
}

async function loadRerank(nextSpec: LocalRerankModelSpec, cacheDir: string): Promise<void> {
  // Replacing an already-loaded reranker (model switch): release the old ONNX
  // session first so two cross-encoders never sit in memory at once.
  const old = reranker;
  reranker = null;
  try {
    await old?.model.dispose?.();
  } catch {
    // quiet: replaced anyway — the reference is already dropped, and a session
    // that will not close is one this process no longer reaches.
  }
  rerankSpec = nextSpec;
  postRerankStatus({ state: 'loading' });
  try {
    const { AutoTokenizer, AutoModelForSequenceClassification, AutoModelForCausalLM, env } = await import(
      '@huggingface/transformers'
    );
    const cached = applyHubAccess(env, cacheDir, nextSpec.repo, nextSpec.dtype);
    const onProgress = progressAggregator(cached, postRerankStatus);
    const tokenizer = (await AutoTokenizer.from_pretrained(nextSpec.repo, {
      progress_callback: onProgress
    })) as unknown as Reranker['tokenizer'];
    const loader = nextSpec.scoring === 'causal-yes-no' ? AutoModelForCausalLM : AutoModelForSequenceClassification;
    const model = (await loader.from_pretrained(nextSpec.repo, {
      dtype: nextSpec.dtype,
      progress_callback: onProgress
    })) as unknown as Reranker['model'];
    const next: Reranker = { tokenizer, model, scoring: nextSpec.scoring };
    if (nextSpec.scoring === 'causal-yes-no') {
      const enc = tokenizer as unknown as { encode?: (t: string) => number[] };
      next.yesId = enc.encode?.('yes')[0];
      next.noId = enc.encode?.('no')[0];
      if (next.yesId == null || next.noId == null) throw new Error('tokenizer lacks yes/no tokens');
      // Warm-up probe: verifies the causal path end-to-end (template, forward,
      // last-token read) and pays the first-run graph-optimization cost.
      await model(tokenizer([formatCausalRerankPair(nextSpec.instruct ?? '', 'ping', 'pong')], {
        padding: true,
        truncation: true
      }));
    } else {
      // Warm-up probe: verifies the model scores pairs and pays the first-run
      // graph-optimization cost before a user-facing rerank does.
      await model(tokenizer(['ping'], { text_pair: ['pong'], padding: true, truncation: true }));
    }
    reranker = next;
    postRerankStatus({ state: 'ready' });
  } catch (err) {
    // quiet: same as load() — the rerank-status post is what carries this out
    // of the process, to the reranker's own stage marker.
    const message = err instanceof Error ? err.message : String(err);
    reranker = null;
    postRerankStatus({
      state: 'error',
      error: message,
      purgedCorruptCache: purgeIfCorrupt(message, nextSpec.repo, cacheDir) || undefined
    });
  }
}

async function embed(id: number, texts: string[], kind: EmbedKind): Promise<void> {
  if (!extractor || !spec) {
    post({ type: 'error', id, message: 'model not loaded' });
    return;
  }
  try {
    const prefixed = applyPrefixes(spec, kind, texts);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < prefixed.length; i += RUN_BATCH) {
      const batch = prefixed.slice(i, i + RUN_BATCH);
      const out = await extractor(batch, { pooling: 'mean', normalize: true });
      const d = out.dims[out.dims.length - 1];
      for (let row = 0; row < batch.length; row++) {
        // Copy each row out of the batch tensor so rows are independent buffers.
        vectors.push(out.data.slice(row * d, (row + 1) * d));
      }
    }
    post({ type: 'result', id, dim, vectors });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

async function rerank(id: number, query: string, docs: string[], topN: number): Promise<void> {
  if (!reranker) {
    post({ type: 'error', id, message: 'reranker not loaded' });
    return;
  }
  try {
    // Cross-encode (query, doc) pairs in small batches for the same memory
    // reason as embed(): attention allocation scales with batch · maxSeqLen².
    const scores: number[] = [];
    for (let i = 0; i < docs.length; i += RUN_BATCH) {
      const batch = docs.slice(i, i + RUN_BATCH);
      if (reranker.scoring === 'causal-yes-no') {
        // ONE PAIR PER FORWARD PASS, not an oversight: this ONNX export (GQA
        // fused for transformers.js v4) mis-attends across padding on the
        // bundled 3.8.1 runtime — a mixed-length batch shifts EVERY row's
        // logits by whole logit units (measured: identical-length batches
        // reproduce single-pair scores exactly, mixed-length batches do not).
        // Unbatched scoring is also what makes the catalog floors stable
        // numbers at all; the bge notes document the same padding-drift class.
        const instruct = rerankSpec?.instruct ?? '';
        for (const doc of batch) {
          const inputs = reranker.tokenizer([formatCausalRerankPair(instruct, query, doc)], {
            padding: true,
            truncation: true
          });
          const { logits } = await reranker.model(inputs);
          const [, seq, vocab] = logits.dims;
          const base = (seq - 1) * vocab;
          // log-odds of "yes" — the raw-logit scale the catalog floors use.
          scores.push(logits.data[base + reranker.yesId!] - logits.data[base + reranker.noId!]);
        }
      } else {
        const inputs = reranker.tokenizer(new Array<string>(batch.length).fill(query), {
          text_pair: batch,
          padding: true,
          truncation: true
        });
        const { logits } = await reranker.model(inputs);
        for (let row = 0; row < batch.length; row++) scores.push(logits.data[row]);
      }
    }
    const results = scores
      .map((score, index) => ({ index, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    post({ type: 'rerank-result', id, results });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

async function dispose(): Promise<void> {
  // Release the ONNX sessions, then let the MANAGER kill this process. Never
  // process.exit() here: exit() runs C++ static destructors while ORT's thread
  // pool may still be winding down, which aborts with "mutex lock failed"
  // (std::terminate) in the terminal. A SIGTERM kill skips that teardown
  // entirely, so it can't abort.
  const pipe = extractor as unknown as { dispose?: () => Promise<void> } | null;
  extractor = null;
  const rr = reranker;
  reranker = null;
  try {
    await pipe?.dispose?.();
    await rr?.model.dispose?.();
  } catch {
    // quiet: being killed anyway — the manager's SIGTERM frees the sessions
    // whether or not ORT let go of them first.
  }
  post({ type: 'disposed' });
}

// Model loads run ONE AT A TIME. Not just politeness: concurrent
// InferenceSession creations in onnxruntime-node cross-contaminate — with a
// corrupt e5-base cache, a simultaneous bge reranker load rejects with the E5
// file's "Protobuf parsing failed" error (reproduced on the bundled 3.8.1),
// which both takes down a healthy model and defeats purgeIfCorrupt's own-path
// check. Serialized, the corrupt model fails alone with its own file named.
// load()/loadRerank() never reject, so the chain can't wedge.
let loadChain: Promise<void> = Promise.resolve();

port.on('message', (e: { data: WorkerInMessage }) => {
  const msg = e.data;
  if (msg.type === 'load') loadChain = loadChain.then(() => load(msg.spec, msg.cacheDir));
  else if (msg.type === 'embed') void embed(msg.id, msg.texts, msg.kind);
  else if (msg.type === 'load-rerank') loadChain = loadChain.then(() => loadRerank(msg.spec, msg.cacheDir));
  else if (msg.type === 'rerank') void rerank(msg.id, msg.query, msg.docs, msg.topN);
  else if (msg.type === 'dispose') void dispose();
});
