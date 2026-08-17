import type { ModelOverride } from './types';

// Turn a pi models.json somebody already has into the per-model overrides
// fragment Settings → Models wants. The strings in a working models.json — the
// thinkingFormat, the thinkingLevelMap a server actually answers to — take real
// debugging to find, and the box added in 5902ca2 asked for them to be
// transcribed by hand into a differently-shaped object. This converts instead.
//
// Pure, and in src/shared/ rather than src/server/, because the renderer is what
// runs it: the importer only FILLS the textarea. Save stays the single write
// path, still validating through server/pi/model-overrides.ts and still refusing
// rather than writing — so an import is a suggestion the user reads and edits,
// not a change to anything. Nothing here does I/O and nothing here throws; a bad
// paste comes back as `{ ok: false }` with a sentence to show.
//
// What it drops matters as much as what it keeps. `id` becomes the key, and
// `api`/`baseUrl` are left behind: pi's ModelOverrideSchema has no such fields,
// so they would ride into models.json as inert noise that READS like it points
// the endpoint somewhere — the one thing this box deliberately cannot do.

/** One provider block out of the paste, as the picker and the fill button need it. */
export interface ImportedProvider {
  /** The provider's key in the file, e.g. `vllm`. */
  id: string;
  /** Models in the block, including the ones that gave nothing — the label says both numbers. */
  modelCount: number;
  /** Exactly what "Fill the box" would put in the textarea. */
  overrides: Record<string, ModelOverride>;
}

export type PiModelsImport =
  | { ok: true; providers: ImportedProvider[] }
  | { ok: false; error: string };

/** One model entry, split into the id that becomes the key and the rest. */
interface ModelEntry {
  id: string;
  fields: Record<string, unknown>;
}

/**
 * Read a pasted pi models.json and convert every provider in it.
 *
 * Three shapes are accepted because all three are what people actually paste: a
 * whole file, the `providers` map with its wrapper key gone, and a single
 * provider's block copied out on its own.
 */
export function parsePiModelsJson(raw: string): PiModelsImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'That isn’t valid JSON.' };
  }
  const blocks = extractProviderMap(parsed);
  if (!blocks) {
    return {
      ok: false,
      error: 'Stem found no providers in that — paste a pi models.json, or one provider’s block out of it.'
    };
  }
  const providers: ImportedProvider[] = [];
  for (const [id, block] of Object.entries(blocks)) {
    if (!id.trim() || !isPlainObject(block)) continue;
    const models = modelEntries(block);
    // A provider that lists no models has nothing to offer and no honest count
    // to show, so it is not listed at all. One that lists models but no extras
    // IS listed — "0 with extras" tells the user the file had nothing to give,
    // where a vanished provider would read as a parse failure.
    if (!models.length) continue;
    providers.push({ id, modelCount: models.length, overrides: overridesFrom(block, models) });
  }
  if (!providers.length) return { ok: false, error: 'No provider in that JSON lists any models.' };
  return { ok: true, providers };
}

/** The picker's text for one provider: `vllm — 3 models, 2 with extras`. */
export function providerLabel(provider: ImportedProvider): string {
  const models = `${provider.modelCount} model${provider.modelCount === 1 ? '' : 's'}`;
  return `${provider.id} — ${models}, ${Object.keys(provider.overrides).length} with extras`;
}

/** Fields that describe the wiring rather than the model. See the header note. */
const DROPPED_FIELDS = ['id', 'api', 'baseUrl'];

function overridesFrom(block: Record<string, unknown>, models: ModelEntry[]): Record<string, ModelOverride> {
  // pi's own composer merges a provider's compat into each of its models
  // (mergeCompat in provider-composer.js), and reads modelOverrides[id].headers
  // straight onto the request (rawModelHeaders, same file). Folding both down
  // per-model is therefore not an approximation — it is what pi would have done
  // with the file — and it is how the provider-wide thinkingFormat a typical
  // vLLM config carries survives a trip through a per-model box.
  const providerCompat = plainObject(block.compat);
  const providerHeaders = plainObject(block.headers);
  const overrides: Record<string, ModelOverride> = {};
  for (const { id, fields } of models) {
    const override: ModelOverride = {};
    for (const [key, value] of Object.entries(fields)) {
      // compat and headers are merged below rather than copied; everything else
      // rides across verbatim, including keys pi grows after this was written —
      // the Save-side guard tolerates what it doesn't know for the same reason.
      if (DROPPED_FIELDS.includes(key) || key === 'compat' || key === 'headers') continue;
      override[key] = value;
    }
    // The model's own value wins the key it names, and inherits the rest. A
    // compat that isn't an object can't be merged and is left out; Save would
    // have refused it anyway, and dropping it keeps the box paste-ready.
    const compat = { ...providerCompat, ...plainObject(fields.compat) };
    if (Object.keys(compat).length) override.compat = compat;
    const headers = { ...providerHeaders, ...plainObject(fields.headers) };
    if (Object.keys(headers).length) override.headers = headers;
    // Nothing to say about this model: a bare `{ id }` under a provider that
    // added nothing either. `{}` is noise in a box the user is about to read.
    // (A bare `{ id }` under a provider that DOES carry compat still lands here
    // with that compat, and should — Stem writes its own provider block, so a
    // model left out is a model that behaves differently under Stem than pi.)
    if (Object.keys(override).length) overrides[id] = override;
  }
  return overrides;
}

function extractProviderMap(parsed: unknown): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) return null;
  if (isPlainObject(parsed.providers)) return parsed.providers;
  // A single block copied out on its own — what you get when you only care about
  // the one endpoint you are setting up. There is no key to take it from, so it
  // is given the name of the endpoint it is going to.
  if (Array.isArray(parsed.models) || typeof parsed.baseUrl === 'string') return { custom: parsed };
  // A bare providers map. Every value has to look like a provider before this
  // will claim it, otherwise a models.json missing its `providers` wrapper and
  // an arbitrary object are indistinguishable.
  const values = Object.values(parsed);
  if (values.length && values.every((v) => isPlainObject(v) && ('models' in v || 'baseUrl' in v))) return parsed;
  return null;
}

function modelEntries(block: Record<string, unknown>): ModelEntry[] {
  if (!Array.isArray(block.models)) return [];
  const entries: ModelEntry[] = [];
  for (const entry of block.models) {
    // pi's short form: the string says the model exists and nothing more, so it
    // counts as a model and contributes no override.
    if (typeof entry === 'string' && entry.trim()) {
      entries.push({ id: entry.trim(), fields: {} });
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) continue;
    entries.push({ id, fields: entry });
  }
  return entries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value usable as a merge source — anything else spreads to nothing. */
function plainObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
