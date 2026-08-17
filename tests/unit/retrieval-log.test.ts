// The stem.log side of the retrieval lifecycle. Its whole reason to exist is a
// failure that happened on someone else's machine, so the property under test is
// not "does it write" but "does it write ONE line per real transition": the
// statuses feeding it repeat (download progress ~4/s, a failed model re-kicked
// every 5 minutes for as long as the app runs), and a log that repeats with them
// buries the line somebody has to find.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { logFlushed } from '../../src/server/log';
import { logFilePath } from '../../src/server/workspace/paths';
import { logModelStatus, logRemoteHealth } from '../../src/server/startup/retrieval';

/** Lines written so far that contain `needle`. */
async function lines(needle: string): Promise<string[]> {
  await logFlushed();
  const text = await readFile(logFilePath(), 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.includes(needle));
}

describe('local retrieval model status → stem.log', () => {
  it('writes one line per transition and collapses repeats of the same status', async () => {
    const status = { model: 'multilingual-e5-small', state: 'downloading' };
    logModelStatus('embeddings', status);
    logModelStatus('embeddings', status); // a progress tick: same state, no news
    logModelStatus('embeddings', status);
    expect(await lines('local embeddings model downloading')).toHaveLength(1);

    logModelStatus('embeddings', { model: 'multilingual-e5-small', state: 'ready', dim: 384 });
    const ready = await lines('local embeddings model ready');
    expect(ready).toHaveLength(1);
    expect(ready[0]).toContain('"dim":384');
  });

  it('carries the error message, and repeats it only when the failure changes', async () => {
    const failing = (error: string) => ({ model: 'bge-reranker-v2-m3', state: 'error', error });
    logModelStatus('reranker', failing('Protobuf parsing failed'));
    // What available() does on the turn hot path: re-kick, fail the same way,
    // post the same status — every ERROR_RETRY_MS, indefinitely.
    logModelStatus('reranker', failing('Protobuf parsing failed'));
    logModelStatus('reranker', failing('Protobuf parsing failed'));
    const first = await lines('Protobuf parsing failed');
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('local reranker model error');

    // A different message is a different failure and earns its own line.
    logModelStatus('reranker', failing('worker keeps crashing'));
    expect(await lines('worker keeps crashing')).toHaveLength(1);
  });

  it('keeps the two stages independent', async () => {
    const state = { state: 'loading' };
    logModelStatus('embeddings', { ...state, model: 'multilingual-e5-base' });
    logModelStatus('reranker', { ...state, model: 'bge-reranker-v2-m3' });
    expect(await lines('local embeddings model loading')).toHaveLength(1);
    expect(await lines('local reranker model loading')).toHaveLength(1);
  });

  it('says nothing when a model is unloaded', async () => {
    logModelStatus('embeddings', { model: 'multilingual-e5-small', state: 'idle' });
    expect(await lines('model idle')).toHaveLength(0);
  });
});

describe('remote retrieval endpoint health → stem.log', () => {
  it('logs failures only, and re-logs one that recovered and broke again', async () => {
    logRemoteHealth('embeddings', { state: 'ok' });
    logRemoteHealth('embeddings', { state: 'unknown' });
    expect(await lines('remote embeddings endpoint failing')).toHaveLength(0);

    logRemoteHealth('embeddings', { state: 'error', error: 'ECONNREFUSED' });
    // onChange carries BOTH stages whenever either moves, so a stage whose
    // verdict never changed is handed over again on every neighbouring change.
    logRemoteHealth('embeddings', { state: 'error', error: 'ECONNREFUSED' });
    expect(await lines('remote embeddings endpoint failing')).toHaveLength(1);

    // Recovered, then broke the same way: two real events, two lines.
    logRemoteHealth('embeddings', { state: 'ok' });
    logRemoteHealth('embeddings', { state: 'error', error: 'ECONNREFUSED' });
    expect(await lines('remote embeddings endpoint failing')).toHaveLength(2);
  });
});
