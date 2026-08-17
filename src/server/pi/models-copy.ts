import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type {
  LocalProviderApi,
  LocalProviderSettings,
  PiModelsOverlayPreview,
  PiModelsOverlayProvider
} from '../../shared/types';
import { normalizeLocalBaseUrl } from './models-config';

// Copy a Pi models.json overlay onto Stem's Custom endpoint. Stem's isolated
// pi-home stays Stem's: this never points PI_CODING_AGENT_DIR at ~/.pi and never
// replaces auth, Pi settings, or other provider blocks. It only extracts one
// provider's extras (reasoning, thinkingFormat, maxTokens, …) so syncModelsConfig
// can write them onto providers.custom.

/** Settings patch that drops a copied overlay (disconnect / typed-ID Enable). */
export const CLEARED_CUSTOM_OVERLAY: Pick<
  LocalProviderSettings,
  'preserveModelsConfig' | 'modelExtras' | 'providerCompat' | 'providerHeaders'
> = {
  preserveModelsConfig: false,
  modelExtras: [],
  providerCompat: {},
  providerHeaders: {}
};

interface PiProviderBlock {
  baseUrl?: unknown;
  api?: unknown;
  apiKey?: unknown;
  compat?: unknown;
  headers?: unknown;
  models?: unknown;
}

export interface CustomOverlayPatch {
  enabled: true;
  baseUrl: string;
  api?: LocalProviderApi;
  apiKey?: string;
  models: string[];
  preserveModelsConfig: true;
  modelExtras: Record<string, unknown>[];
  providerCompat?: Record<string, unknown>;
  providerHeaders?: Record<string, string>;
}

/**
 * Parse a Pi models.json (or a single provider block) into the providers a
 * Custom-endpoint copy can use. Never throws — failures come back as `{ ok:false }`.
 */
export function previewPiModelsJson(raw: string): PiModelsOverlayPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'That is not valid JSON.' };
  }
  const providers = extractProviderMap(parsed);
  if (!providers) {
    return { ok: false, error: 'No providers with models were found in that JSON.' };
  }
  const list: PiModelsOverlayProvider[] = [];
  for (const [id, block] of Object.entries(providers)) {
    if (!id.trim()) continue;
    const models = modelEntries(block);
    if (!models.length) continue;
    const baseUrl = typeof block.baseUrl === 'string' && block.baseUrl.trim() ? block.baseUrl.trim() : undefined;
    list.push({ id, modelIds: models.map((m) => m.id), ...(baseUrl ? { baseUrl } : {}) });
  }
  if (!list.length) return { ok: false, error: 'No providers with models were found in that JSON.' };
  return { ok: true, providers: list };
}

/**
 * Read a paste or a path (file, Pi home, or `agent/` dir) and preview its
 * providers. Paths never become Stem's Pi home — they are only a source to copy from.
 */
export async function previewPiModelsSource(source: { json?: string; path?: string }): Promise<PiModelsOverlayPreview> {
  const loaded = await loadSource(source);
  if (!loaded.ok) return loaded;
  return previewPiModelsJson(loaded.raw);
}

/**
 * Build the Custom-endpoint settings patch from one provider in the source.
 * Other providers in the file are ignored.
 */
export async function overlayPatchFromSource(
  source: { json?: string; path?: string },
  providerId: string,
  current: LocalProviderSettings
): Promise<{ ok: true; patch: CustomOverlayPatch } | { ok: false; error: string }> {
  const loaded = await loadSource(source);
  if (!loaded.ok) return loaded;
  let parsed: unknown;
  try {
    parsed = JSON.parse(loaded.raw);
  } catch {
    return { ok: false, error: 'That is not valid JSON.' };
  }
  const providers = extractProviderMap(parsed);
  if (!providers) return { ok: false, error: 'No providers with models were found in that JSON.' };
  const wanted = providerId.trim();
  const block = providers[wanted];
  if (!block) return { ok: false, error: `There is no provider named "${wanted}" in that JSON.` };
  const extras = modelEntries(block);
  if (!extras.length) return { ok: false, error: `Provider "${wanted}" has no models.` };

  const sourceUrl = typeof block.baseUrl === 'string' ? normalizeLocalBaseUrl(block.baseUrl) : '';
  const baseUrl = sourceUrl || current.baseUrl.trim();
  if (!baseUrl) return { ok: false, error: 'Set a URL on the Custom endpoint, or include baseUrl in the JSON.' };

  const api: LocalProviderApi =
    block.api === 'anthropic-messages' || block.api === 'openai-completions'
      ? block.api
      : current.api === 'anthropic-messages' || current.api === 'openai-completions'
        ? current.api
        : 'openai-completions';

  const sourceKey = typeof block.apiKey === 'string' ? block.apiKey.trim() : '';
  // `$ENV` / `!command` forms stay out of settings.json — Pi resolves those in
  // models.json, and Stem's auth.json needs a non-empty literal. The Enable
  // path still writes a placeholder when the form key is empty.
  const literalKey = sourceKey && !sourceKey.startsWith('$') && !sourceKey.startsWith('!') ? sourceKey : '';
  const apiKey = literalKey || current.apiKey?.trim() || '';

  const providerCompat = asPlainObject(block.compat);
  const providerHeaders = asStringRecord(block.headers);

  return {
    ok: true,
    patch: {
      enabled: true,
      baseUrl,
      api,
      ...(apiKey ? { apiKey } : { apiKey: '' }),
      models: extras.map((m) => m.id),
      preserveModelsConfig: true,
      modelExtras: extras,
      ...(providerCompat ? { providerCompat } : { providerCompat: {} }),
      ...(providerHeaders ? { providerHeaders } : { providerHeaders: {} })
    }
  };
}

async function loadSource(source: { json?: string; path?: string }): Promise<{ ok: true; raw: string } | { ok: false; error: string }> {
  const json = source.json?.trim();
  const path = source.path?.trim();
  if (json && path) return { ok: false, error: 'Paste JSON or give a path, not both.' };
  if (json) return { ok: true, raw: json };
  if (!path) return { ok: false, error: 'Paste a models.json or give a path to one.' };
  const resolved = await resolveModelsPath(path);
  if (!resolved.ok) return resolved;
  try {
    return { ok: true, raw: await readFile(resolved.path, 'utf8') };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Could not read that file. ${msg}` };
  }
}

/**
 * Accept a models.json file, a Pi home (`…/agent/models.json`), or `~` paths.
 * Does not write, and does not treat the path as Stem's pi-home.
 */
export async function resolveModelsPath(raw: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const expanded = raw.trim().replace(/^~(?=$|[\\/])/, homedir());
  if (!expanded) return { ok: false, error: 'Give a path to a models.json file.' };
  const abs = resolve(expanded);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return { ok: false, error: 'That path does not exist.' };
  }
  if (st.isFile()) return { ok: true, path: abs };
  if (!st.isDirectory()) return { ok: false, error: 'That path is not a models.json file.' };
  const candidates = [join(abs, 'models.json'), join(abs, 'agent', 'models.json')];
  for (const c of candidates) {
    try {
      const cs = await stat(c);
      if (cs.isFile()) return { ok: true, path: c };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: 'No models.json was found in that folder.' };
}

function extractProviderMap(parsed: unknown): Record<string, PiProviderBlock> | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.providers && typeof rec.providers === 'object' && !Array.isArray(rec.providers)) {
    return rec.providers as Record<string, PiProviderBlock>;
  }
  // A single provider block pasted on its own (has models and/or baseUrl).
  if (Array.isArray(rec.models) || typeof rec.baseUrl === 'string') {
    return { custom: rec as PiProviderBlock };
  }
  // Bare providers map: { "vllm": { models: [...] }, … }.
  const values = Object.values(rec);
  if (
    values.length &&
    values.every((v) => v && typeof v === 'object' && !Array.isArray(v) && ('models' in v || 'baseUrl' in v))
  ) {
    return rec as Record<string, PiProviderBlock>;
  }
  return null;
}

function modelEntries(block: PiProviderBlock): Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(block.models)) return [];
  const out: Array<Record<string, unknown> & { id: string }> = [];
  for (const entry of block.models) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ id: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!id) continue;
    out.push({ ...rec, id });
  }
  return out;
}

function asPlainObject(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  return Object.keys(rec).length ? rec : undefined;
}

function asStringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.trim() && typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
