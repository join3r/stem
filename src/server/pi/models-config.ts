import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  LocalProviderApi,
  LocalProviderHealth,
  LocalProviderId,
  LocalProviderTestResult,
  ModelOverride
} from '../../shared/types';
import { isCustomProviderId, isLocalProviderId } from '../../shared/providers';
import { degrade } from '../degrade';
import { log } from '../log';
import { parseModelOverrides } from './model-overrides';
import { piModelsConfigPath } from '../workspace/paths';
import { readSettings } from '../workspace/settings';
import { replaceFile } from '../replace-file';
import { llmRelay } from '../llm-device/router';

// Stem's custom-providers config for the pi backend (models.json under the
// isolated pi home). OpenAI-compatible servers (Ollama, LM Studio, and a custom
// endpoint) are registered here; pi's model registry reads the file at spawn.
// NOTE: pi's RPC mode never re-reads models.json mid-process (only the TUI's
// /model command refreshes the registry), so every content change must be
// followed by a runtime restart — callers use syncModelsConfig()'s return value
// to decide.

/** Model entry pi accepts in models.json (only `id` is required). */
interface PiModelConfig {
  id: string;
  [key: string]: unknown;
}

interface PiProviderConfig {
  baseUrl: string;
  api: string;
  apiKey?: string;
  compat?: Record<string, unknown>;
  models?: PiModelConfig[];
  [key: string]: unknown;
}

interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>;
}

/** Probe timeout: local servers answer in ms; anything slower is effectively down. */
const PROBE_TIMEOUT_MS = 2_500;
/** The same probe from a paired computer: each request crosses the internet twice. */
const DEVICE_PROBE_TIMEOUT_MS = 10_000;

/**
 * Normalize a user-entered server URL to the server root: no trailing slash, no
 * trailing /v1 (users paste both forms; the API-specific client appends the
 * versioned path itself).
 *
 * All flavors strip trailing /v1. Stem re-appends it for OpenAI Chat
 * Completions and Responses; for anthropic-messages pi hands the root to
 * @anthropic-ai/sdk, which appends /v1/messages verbatim. Leaving /v1 in the
 * Anthropic case would double-version the request.
 */
export function normalizeLocalBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  url = url.replace(/\/v1$/i, '');
  return url;
}

/**
 * The version Anthropic's API requires on every request; @anthropic-ai/sdk sends
 * the same value, so pi's real turns and our probe agree on the wire format.
 */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Auth headers a probe must carry to be answered, in the form the target API
 * expects. OpenAI-flavored servers take a bearer token; Anthropic takes the key
 * in `x-api-key` and demands `anthropic-version` on top — a request missing
 * either is rejected before the endpoint ever looks at the route, so sending
 * only a bearer would make every Anthropic probe fail a server that works fine
 * for real turns.
 */
function probeHeaders(api: LocalProviderApi, key?: string): Record<string, string> {
  if (api === 'anthropic-messages')
    return { 'anthropic-version': ANTHROPIC_VERSION, ...(key ? { 'x-api-key': key } : {}) };
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Ollama rejects tool-bearing requests outright (HTTP 400) for models without
 * tool support — and Stem's turns always carry tools, so such a model can never
 * complete a turn. Ollama reports per-model capabilities via POST /api/show;
 * keep only models listing "tools". Non-Ollama servers (LM Studio, vLLM, …)
 * don't have that endpoint — the check fails and every model is kept.
 */
async function isToolCapable(base: string, id: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      body: JSON.stringify({ model: id }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return true; // not Ollama → no capability info → keep
    const body = (await res.json()) as { capabilities?: unknown };
    return !Array.isArray(body.capabilities) || body.capabilities.includes('tools');
  } catch {
    // quiet: the probe not answering is the answer — /api/show is Ollama's, and
    // every other server reaches here on every model. Keeping them is the point.
    return true;
  }
}

/**
 * Which completion/response/messages routes this endpoint exposes. Called by
 * auto-detect to pick an API flavor: all flavors serve `GET /v1/models` under
 * the same route, so the listing can't tell them apart — the real signal is
 * which request route the proxy implements.
 *
 * Uses OPTIONS to keep the probe cost-free (no completion tokens spent). A
 * 404 = route absent; anything else (200/400/401/405/…) = route present and
 * the server has an opinion about the request. That opinion may be "needs a
 * key" or "wrong method", both of which still prove the route exists.
 *
 * Carries both flavors' auth headers: which one this endpoint speaks is the
 * very thing being classified, and a header the server doesn't recognize is
 * ignored rather than rejected.
 */
async function classifyApiRoutes(
  base: string,
  apiKey: string | undefined,
  timeoutMs: number
): Promise<{ oc: boolean; or: boolean; am: boolean }> {
  const key = apiKey?.trim();
  const headers = { ...probeHeaders('openai-completions', key), ...probeHeaders('anthropic-messages', key) };
  const options = { method: 'OPTIONS', headers, signal: AbortSignal.timeout(timeoutMs) };
  const [oc, or, am] = await Promise.allSettled([
    fetch(`${base}/v1/chat/completions`, options),
    fetch(`${base}/v1/responses`, options),
    fetch(`${base}/v1/messages`, options)
  ]);
  return {
    oc: oc.status === 'fulfilled' && oc.value.status !== 404,
    or: or.status === 'fulfilled' && or.value.status !== 404,
    am: am.status === 'fulfilled' && am.value.status !== 404
  };
}

/**
 * Single-flavor probe: hits GET {base}/v1/models under the flavor's protocol
 * expectations (Ollama capability filter only for openai-completions). Success
 * carries the `api` back so an auto-detect caller can attribute the answer.
 */
async function probeOneFlavor(
  baseUrl: string,
  apiKey: string | undefined,
  api: LocalProviderApi,
  timeoutMs: number
): Promise<LocalProviderTestResult> {
  const base = normalizeLocalBaseUrl(baseUrl);
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Enter a URL like http://localhost:11434.' };
  const key = apiKey?.trim();
  const listUrl = `${base}/v1/models`;
  try {
    const res = await fetch(listUrl, {
      headers: probeHeaders(api, key),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, error: await failureText(res) };
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const all = (body.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id.trim() : ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    // Ollama is keyless and Chat Completions-flavored, so a bearer key or any
    // other API flavor means this isn't Ollama — skip its capability probe.
    const capable =
      key || api !== 'openai-completions'
        ? all.map(() => true)
        : await Promise.all(all.map((id) => isToolCapable(base, id, timeoutMs)));
    const models = all.filter((_, i) => capable[i]);
    const skipped = all.length - models.length;
    return { ok: true, api, models, ...(skipped > 0 ? { skippedNoTools: skipped } : {}) };
  } catch (e) {
    // quiet: this catch IS the report. The error goes back as the result of the
    // Test connection button the user just pressed, in their own words.
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'The server did not answer in time.' : e.message) : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * Ask an OpenAI- or Anthropic-compatible server which models it serves.
 *
 * `api` specified: probe only that flavor. Its GET /v1/models answer is
 * returned as-is; on success the result carries `api` back so a caller can
 * confirm.
 *
 * `api` omitted (auto-detect): first classify which API route the endpoint
 * exposes (OPTIONS on /v1/chat/completions, /v1/responses, and /v1/messages —
 * non-404 counts as present), then probe GET /v1/models if exactly one flavor
 * is detected. Multiple routes require an explicit flavor selection: route
 * presence cannot establish which protocol a particular model supports.
 * If no route resolves, retain the pre-existing openai-completions listing
 * fallback; the user can select another flavor and test in a real turn.
 *
 * Never throws — failures come back as `{ ok:false, error }`.
 */
export async function probeLocalProvider(
  baseUrl: string,
  apiKey?: string,
  api?: LocalProviderApi,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<LocalProviderTestResult> {
  if (api) return probeOneFlavor(baseUrl, apiKey, api, timeoutMs);
  const base = normalizeLocalBaseUrl(baseUrl);
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Enter a URL like http://localhost:11434.' };
  const routes = await classifyApiRoutes(base, apiKey, timeoutMs);
  const detected: LocalProviderApi[] = [];
  if (routes.oc) detected.push('openai-completions');
  if (routes.or) detected.push('openai-responses');
  if (routes.am) detected.push('anthropic-messages');
  if (detected.length > 1) {
    return {
      ok: false,
      error: `The endpoint exposes multiple API routes (${detected.join(', ')}). Select an API flavor explicitly and test again.`
    };
  }
  // Keep the legacy listing fallback when no route can be classified.
  return probeOneFlavor(baseUrl, apiKey, detected[0] ?? 'openai-completions', timeoutMs);
}

/**
 * The status line, plus the server's own message when it sent one. The relay
 * answers a sleeping Mac with a sentence, and "503 Service Unavailable" alone
 * would throw that sentence away.
 */
async function failureText(res: Response): Promise<string> {
  const status = `The server answered ${res.status} ${res.statusText}.`.replace(' .', '.');
  // quiet: a body that won't read leaves the status line, which is still the answer.
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown; type?: unknown } | string } | null;
  const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
  if (typeof message !== 'string' || !message.trim()) return status;
  // The relay's own sentences stand alone; its status line is not the model server's.
  if (typeof body?.error === 'object' && body.error.type === 'stem_relay_error') return message.trim();
  return `${status} ${message.trim()}`;
}

/**
 * {@link probeLocalProvider}, asked from a paired computer: `baseUrl` is read
 * on that machine, so `http://localhost:1234` is its LM Studio. Goes through
 * the same relay pi's turns will, so a green test means the real path works.
 */
export async function probeLocalProviderOn(
  deviceId: string,
  baseUrl: string,
  apiKey?: string,
  api?: LocalProviderApi
): Promise<LocalProviderTestResult> {
  const base = normalizeLocalBaseUrl(baseUrl);
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Enter a URL like http://localhost:1234.' };
  const relay = llmRelay();
  const refusal = await relay.unavailable(deviceId);
  if (refusal) return { ok: false, error: refusal };
  const routeId = `test-${randomUUID()}`;
  relay.setRoute(routeId, { deviceId, baseUrl: base });
  try {
    return await probeLocalProvider(await relay.baseFor(routeId), apiKey, api, DEVICE_PROBE_TIMEOUT_MS);
  } finally {
    relay.clearRoute(routeId);
  }
}

/** The provider block written for an enabled local server. */
function localProviderBlock(
  baseUrl: string,
  models: PiModelConfig[],
  apiKey: string | undefined,
  api: LocalProviderApi,
  modelOverrides: Record<string, ModelOverride>
): PiProviderConfig {
  const normalized = normalizeLocalBaseUrl(baseUrl);
  // OpenAI flavors: append /v1 so pi hits /v1/chat/completions or /v1/responses
  // (matches the Ollama/LM Studio flow that always did it).
  // anthropic-messages: leave the normalized root as-is — pi's Anthropic client
  // (@anthropic-ai/sdk) appends /v1/messages verbatim to whatever baseURL it
  // receives. Appending /v1 here would produce /v1/v1/messages at request time.
  const finalBaseUrl = api === 'anthropic-messages' ? normalized : `${normalized}/v1`;
  // Chat Completions servers get conservative local-server defaults. Responses
  // and Anthropic providers use pi's native protocol defaults; proxy-specific
  // changes can still be supplied through per-model compat overrides.
  const compat: Record<string, unknown> =
    api === 'openai-completions' ? { supportsDeveloperRole: false, supportsReasoningEffort: false } : {};
  return {
    baseUrl: finalBaseUrl,
    api,
    // Keyless servers still need a non-empty key for pi to consider the models
    // available (pi's own docs recommend a dummy value).
    apiKey: apiKey?.trim() || 'local',
    compat,
    models,
    // pi's topmost user-config layer: applied by model id after everything else,
    // merging into thinkingLevelMap and compat rather than replacing them. This
    // is the field that carries "this model reasons" for a server whose /v1/models
    // listing can't say so. Written from settings on EVERY sync — that is what
    // keeps it from being rebuilt away, which is the whole point. Omitted when
    // empty so an endpoint with none round-trips to the shape it always had.
    ...(Object.keys(modelOverrides).length ? { modelOverrides } : {})
  };
}

/**
 * models.json is on disk, intact, and would not open. Unlike the corrupt case
 * there is nothing quarantined and nothing to rebuild from — the providers are
 * still in that file — so the caller must not write over it.
 */
export class ModelsConfigUnreadable extends Error {}

/**
 * Read models.json, tolerating a missing file (fresh install) and quarantining a
 * corrupt one (preserved as `.corrupt`, like mcp-config) so hand-edits are never
 * silently destroyed. Throws {@link ModelsConfigUnreadable} for a file that is
 * there and will not open, which has no quarantine copy to fall back on.
 */
export async function readModelsConfig(): Promise<PiModelsConfig> {
  const path = piModelsConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    // ENOENT is the fresh install this tolerates. A file that IS there and did
    // not open must not read the same way: no providers is what the next sync
    // writes back over every local server the user set up, and unlike the corrupt
    // branch below there are no bytes to quarantine first.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new ModelsConfigUnreadable(`models.json could not be read: ${String(error)}`);
    }
    return { providers: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PiModelsConfig>;
    if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
      return { providers: parsed.providers };
    }
    return { providers: {} };
  } catch (error) {
    // Uniquified like the write below: two readers hitting the same corrupt file
    // must not overwrite each other's quarantine copy mid-write. The user's local
    // providers vanish from the model picker at the same moment, so name the run
    // that did it — the `.corrupt` sibling is only found by someone already
    // looking.
    degrade('pi.modelsConfig', 'quarantined models.json and started from no providers', error);
    await writeFile(`${path}.${process.pid}.${randomUUID()}.corrupt`, raw, 'utf8').catch((e) =>
      // The line above has already claimed the file was quarantined. If the copy
      // did not land, the next sync overwrites the original and the hand-edits
      // this whole path exists to preserve are gone with nothing left to restore.
      degrade('pi.modelsConfig', 'kept no quarantine copy of the corrupt models.json', e)
    );
    return { providers: {} };
  }
}

/**
 * Write via a temp file named per-writer, not per-path. A shared `<path>.tmp` is
 * only atomic for a single writer: two concurrent syncs would share one inode, so
 * one could rename it out from under the other's half-finished write and leave a
 * truncated models.json — which readModelsConfig then quarantines, silently
 * dropping every local provider. The `finally` clears the temp on a failed rename
 * so a crash can't accumulate them.
 */
async function writeModelsConfig(config: PiModelsConfig): Promise<void> {
  const path = piModelsConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
    await replaceFile(tmp, path); // atomic in the same dir
  } finally {
    // quiet: this is the accumulation guard the doc comment describes, not the
    // write. A rename that succeeded already consumed the temp; one that failed
    // leaves a single uniquified `.tmp` that no reader of models.json looks at.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Whether pi will still recognize `provider` when a spawn names it. Only the
 * providers Stem registers itself can go missing — they exist for pi purely as
 * models.json blocks, and a disconnect (or a server that was unreachable when
 * the catalog was last synced) removes them. pi's built-in providers are always
 * part of its registry, so everything else answers true.
 *
 * Callers use this before handing pi `--provider`: an unknown one is fatal at
 * startup, not merely unusable.
 *
 * Reads the file directly rather than through readModelsConfig(): this is a
 * query on a hot path (every listModels), and quarantining a corrupt file per
 * call would litter. Unreadable/unparseable answers false, which is also what
 * pi sees — it drops the whole config when it doesn't parse or validate.
 */
export async function providerIsSpawnable(provider: string): Promise<boolean> {
  if (!isLocalProviderId(provider)) return true;
  try {
    const parsed = JSON.parse(await readFile(piModelsConfigPath(), 'utf8')) as Partial<PiModelsConfig>;
    return !!parsed?.providers?.[provider]?.models?.length;
  } catch {
    // quiet: false is the true answer to what was asked — pi drops a config it
    // cannot read, so a provider in an unreadable file is one a spawn would
    // reject. readModelsConfig reports the file itself; this is a hot-path query
    // on every listModels and has nothing of its own to add.
    return false;
  }
}

// Serialize syncs through a promise chain (see workspace/settings.ts) so two of
// them can't interleave their read-modify-write of models.json. The critical
// section spans the probes, which take seconds — the window this closes is wide.
let chain: Promise<unknown> = Promise.resolve();

/** Each enabled local provider's last check, for the status dot in Settings. */
const health = new Map<string, LocalProviderHealth>();

/** How each enabled local provider's last model check went. */
export function localProviderHealth(): Record<string, LocalProviderHealth> {
  return Object.fromEntries(health);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}


/**
 * Bring models.json in line with the local-provider settings: probe each enabled
 * server for its models and (re)write its provider block; drop blocks for
 * disabled providers; leave any hand-added third-party providers untouched.
 *
 * When a probe fails (server temporarily down), the provider's last-known models
 * are kept so a stopped server doesn't wipe the catalog.
 *
 * Serialized, and it takes no settings argument on purpose: the settings read
 * happens inside the critical section, immediately before the write. A caller
 * that read settings first and handed them over could have that snapshot commit
 * *after* a disconnect that landed while it was probing — restoring the provider
 * block and the API key the user had just removed. Enqueue order is not snapshot
 * order, so serializing alone would not have fixed that.
 *
 * Returns true when the file content actually changed — the caller must then
 * restart the pi process for the registry to pick it up.
 */
export function syncModelsConfig(): Promise<boolean> {
  return enqueue(async () => {
    const settings = (await readSettings()).localProviders;
    let config: PiModelsConfig;
    try {
      config = await readModelsConfig();
    } catch (error) {
      // Only the unreadable case reaches here (a corrupt file quarantines and
      // returns empty). Syncing from an empty config would delete provider blocks
      // that are still on disk, so do nothing at all and let the next sync — after
      // the permission or the disk clears — do the work.
      degrade('pi.modelsConfig', 'skipped the sync and left models.json as it is', error);
      return false;
    }
    const before = JSON.stringify(config);

    for (const id of Object.keys(settings) as LocalProviderId[]) {
      const { enabled, baseUrl, apiKey, models: manual, api: rawApi, location } = settings[id];
      const relay = llmRelay();
      if (!enabled) {
        delete config.providers[id];
        health.delete(id);
        relay.clearRoute(id);
        continue;
      }
      // Backstop for a hand-edited settings.json — the UI refuses a bad fragment
      // before it is ever persisted. Dropping it costs the overrides; writing it
      // would cost the whole file, since pi fails models.json as a unit and would
      // take every other local provider down with it.
      const parsed = parseModelOverrides(settings[id].modelOverrides);
      if (!parsed.ok) log('pi', `ignoring invalid model overrides for ${id}`, { errors: parsed.errors });
      const overrides = parsed.ok ? parsed.value : {};
      // Only custom endpoints may select Responses or Anthropic Messages; the
      // coercion enforces this too, and this is defense in depth against a
      // hand-edited settings.json.
      const api: LocalProviderApi =
        isCustomProviderId(id) && (rawApi === 'openai-responses' || rawApi === 'anthropic-messages')
          ? rawApi
          : 'openai-completions';
      // Hand-entered ids are authoritative: an endpoint that names its models has
      // opted out of discovery, so don't probe it (and don't let a listing endpoint
      // it happens to serve override the user's choice).
      // A server on a paired computer is reached through the relay: pi gets a
      // loopback URL, and the relay carries each request to that machine.
      let base = baseUrl;
      if (location) {
        relay.setRoute(id, { deviceId: location.deviceId, baseUrl: normalizeLocalBaseUrl(baseUrl) });
        base = await relay.baseFor(id);
      } else relay.clearRoute(id);
      if (manual?.length) {
        config.providers[id] = localProviderBlock(base, manual.map((m) => ({ id: m })), apiKey, api, overrides);
        health.set(id, { state: 'manual', models: [...manual], checkedAt: Date.now() });
        continue;
      }
      const refusal = location ? await relay.unavailable(location.deviceId) : null;
      const probe: LocalProviderTestResult = refusal
        ? { ok: false, error: refusal }
        : await probeLocalProvider(base, apiKey, api, location ? DEVICE_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS);
      const lastKnown = config.providers[id]?.models ?? [];
      const models = probe.ok ? probe.models!.map((m) => ({ id: m })) : lastKnown;
      health.set(id, {
        state: probe.ok ? 'ok' : 'down',
        ...(probe.ok ? {} : { error: probe.error ?? 'The server did not answer.' }),
        models: models.map((m) => m.id),
        checkedAt: Date.now()
      });
      // A block with no models is worse than no block: pi builds its provider
      // list from the models it can see, so an empty one leaves the provider
      // *unknown* — and a spawn asking for it (`--provider ollama`) then dies
      // with "Unknown provider", taking every other provider down with it.
      // Nothing is lost by waiting: the next sync writes it once a probe answers.
      if (models.length) config.providers[id] = localProviderBlock(base, models, apiKey, api, overrides);
      else delete config.providers[id];
    }

    const changed = JSON.stringify(config) !== before;
    if (changed) await writeModelsConfig(config);
    return changed;
  });
}
