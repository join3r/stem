import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { GTE_MODEL_ARTIFACT, type GteModelArtifact } from './gte-model-artifact';

export interface GteDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

/** Factory keeps fixture manifests and fake networks outside the production API. */
export function createGteModelDownloader(deps: {
  artifact: GteModelArtifact;
  fetch?: typeof globalThis.fetch;
  /** Overall deadline per file, including receipt of its response body. */
  timeoutMs?: number;
}): (directory: string, options?: GteDownloadOptions) => Promise<void> {
  const { artifact } = deps;
  const entries = Object.entries(artifact.files);
  for (const [file, expected] of entries) {
    if (!file || file.split('/').some((part) => !part || part === '.' || part === '..')
      || file.includes('\\') || isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expected.sha256)
      || !Number.isSafeInteger(expected.size) || expected.size <= 0) {
      throw new Error(`Invalid GTE model artifact entry: ${file}`);
    }
  }
  const totalBytes = entries.reduce((sum, [, file]) => sum + file.size, 0);
  if (!totalBytes) throw new Error('The GTE model artifact is empty');

  return async (directory, options = {}) => {
    if (!isAbsolute(directory)) throw new Error('The GTE model directory must be absolute');
    options.signal?.throwIfAborted();
    let completedBytes = 0;
    let lastPercent = -1;
    let lastReportAt = 0;
    const report = (bytes: number, complete = false, force = false) => {
      // A full response is not installed until both length and digest match.
      const percent = complete ? 100 : Math.min(99, Math.floor(bytes / totalBytes * 100));
      const now = Date.now();
      if (percent !== lastPercent && (force || complete || now - lastReportAt >= 250)) {
        lastPercent = percent;
        lastReportAt = now;
        options.onProgress?.(percent);
      }
    };
    const missing: typeof entries = [];
    // Check the entire cache before touching the network, crediting verified bytes.
    for (const [file, expected] of entries) {
      options.signal?.throwIfAborted();
      const path = join(directory, file);
      let valid = false;
      try {
        const info = await stat(path);
        if (info.isFile() && info.size === expected.size) {
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(path, { signal: options.signal })) hash.update(chunk);
          valid = hash.digest('hex') === expected.sha256;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (valid) completedBytes += expected.size;
      else missing.push([file, expected]);
    }
    options.signal?.throwIfAborted();
    if (!missing.length) return;
    report(completedBytes, false, true);
    for (const [file, expected] of missing) {
      options.signal?.throwIfAborted();
      const destination = join(directory, file);
      await mkdir(dirname(destination), { recursive: true });
      // Unique siblings make concurrent callers safe; cancellation only removes
      // this caller's partial download, never another caller's verified file.
      const temporary = `${destination}.${randomUUID()}.part`;
      const timeout = AbortSignal.timeout(deps.timeoutMs ?? 15 * 60 * 1000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const url = `https://huggingface.co/${artifact.repo}/resolve/${artifact.revision}/${file.split('/').map(encodeURIComponent).join('/')}`;
        const response = await (deps.fetch ?? globalThis.fetch)(url, { signal });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`Stem GTE Memory download failed for ${file}: HTTP ${response.status}`);
        }
        const hash = createHash('sha256');
        let received = 0;
        const verify = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > expected.size) {
              callback(new Error(`Stem GTE Memory download has an unexpected size: ${file}`));
              return;
            }
            try {
              hash.update(chunk);
              report(completedBytes + received);
              callback(null, chunk);
            } catch (error) {
              callback(error instanceof Error ? error : new Error(String(error)));
            }
          }
        });
        await pipeline(
          Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
          verify,
          createWriteStream(temporary, { flags: 'wx' }),
          { signal }
        );
        if (received !== expected.size || hash.digest('hex') !== expected.sha256) {
          throw new Error(`Stem GTE Memory download failed verification: ${file}`);
        }
        signal.throwIfAborted();
        await rename(temporary, destination);
        completedBytes += expected.size;
        report(completedBytes);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    options.signal?.throwIfAborted();
    report(totalBytes, true);
  };
}

/** Downloads only pinned data files. No repository code is fetched or executed. */
export const ensureGteModel = createGteModelDownloader({ artifact: GTE_MODEL_ARTIFACT });
