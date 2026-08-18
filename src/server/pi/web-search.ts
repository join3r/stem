import { readFileSync, statSync } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { piHome } from '../workspace/paths';
import type { SourceRef, WebSearchSettings } from '../../shared/types';

// Web search for EVERY provider, via the vendored pi-web-access extension.
//
// Stem used to have web search only on openai-codex, by injecting the provider's
// server-side `web_search` tool into the outgoing request body (a
// before_provider_request hook in the bridge extension). That trick has no analog
// on Claude/OpenRouter/Ollama/LM Studio, so every other model answered from stale
// weights with no way to look anything up.
//
// pi-web-access registers real pi tools (`web_search`, `fetch_content`,
// `get_search_content`) that work the same on every provider, because the search
// happens in the extension rather than inside the provider's own inference.
//
// The catch, and what the patched `auto` chain is about: "the search happens in the
// extension" does not have to mean "the search costs a model". The package's own
// ordering tried its OpenAI backend second, which spends a whole extra inference —
// 4-12s, plus ChatGPT quota — asking a model to run a query and quote the results.
// The old native trick was fast precisely because it had no such second model: the
// provider's hosted tool ran inside the chat model's own request. Nothing about
// being provider-agnostic requires giving that up. So the chain is reordered to try
// plain index lookups first (self-hosted SearXNG, then any keyed backend, then Exa's
// keyless MCP endpoint at ~0.4s and no credential at all), and to fall back to an
// LLM-mediated backend only when every one of them is unreachable. Synthesis then
// happens where it was always going to happen anyway — in the chat model, which is
// mid-inference over the results regardless of who fetched them.
//
// That ordering is what makes this fast for the users the OpenAI backend never
// helped in the first place: on Claude, OpenRouter, Ollama or LM Studio there is no
// Codex subscription to fall back on, so the detour bought them nothing but a place
// in the queue.
//
// The package is a pinned production dependency (never `pi install`ed at runtime:
// a packaged desktop app has no npm and may have no network on first launch). pi
// loads it with a second `-e` alongside Stem's own bridge extension.
//
// The `xai` backend is upstream as of 0.18.0 (PR #196, landed via #209), so it is
// no longer patched in. What patches/pi-web-access+0.18.0.patch still carries is
// Stem's own latency work, which has not been submitted upstream: the concurrent
// multi-query fan-out in search-batch.ts, its wiring in index.ts, and the `auto`
// chain reordering in gemini-search.ts. Until those land, postinstall keeps
// running patch-package.

const PACKAGE = 'pi-web-access';

/**
 * Which model backs the OpenAI search backend — a FALLBACK path, not the default
 * one. That backend answers a query by running a whole separate inference (it posts
 * to the Responses endpoint and lets the provider's hosted web_search run inside
 * that call), which is 4-12s and a subscription's quota to do what an index lookup
 * does in under a second. So the patched `auto` chain reaches it only when every
 * real search engine is unavailable or erroring — see the ordering rule in
 * tests/unit/web-search-latency.test.ts — and it is reachable directly only if the
 * user explicitly picks `openai` in settings.
 *
 * Pinned because the package otherwise picks for itself: `pickSearchModel` in
 * openai-search.ts sorts the registry's OpenAI models and prefers a "terra" id, then
 * the newest bare mainline id. Adding a model to the signed-in account would then
 * silently re-point every search at it: no setting changed, no code changed,
 * searches just get slower or dearer.
 *
 * Since 0.18.0 the pin is upstream (`openaiSearchModel`), and it is a hard override
 * rather than a preference — the registry is consulted only for the credential, and
 * this id is sent verbatim. So unlike the patched version this replaced, a rotated-
 * out id does NOT degrade to the package's own choice; it fails the request. Re-check
 * this constant when OpenAI retires a model.
 *
 * `mini` on measurement, not on reputation — same request, same hosted tool, 3
 * queries x 2 reps: gpt-5.4-mini 4.2s median, gpt-5.6-luna 6.4s (and a 28s tail
 * where it took three search rounds), gpt-5.4 6.3s, and mini is the cheapest of the
 * three per token. What this model is asked to do is "run the query, quote what came
 * back"; the reasoning the bigger ids charge for happens in the chat model
 * afterwards, on the results.
 *
 * Measured WORSE, not worth retrying: `reasoning.effort: low` (8-12s — a smaller
 * thinking budget makes the hosted model take MORE search rounds, and rounds are the
 * unit of cost), and instructing it to search exactly once (no effect; it already
 * does). Re-run `npm run test:perf` if you change it.
 */
export const OPENAI_SEARCH_MODEL = 'gpt-5.4-mini';

/** The version this integration was written against (mirrors TESTED_PI_VERSION). */
export const TESTED_WEB_ACCESS_VERSION = '0.18.0';

/**
 * `<piHome>/web-search.json` — pi-web-access reads its whole configuration from
 * here, because its getWebSearchConfigDir() honors PI_CODING_AGENT_DIR before
 * falling back to `~/.pi`. Stem points that at its isolated pi home, so this file
 * is ours end-to-end and the user's real `~/.pi` is never touched.
 */
export function webSearchConfigPath(): string {
  return join(piHome(), 'web-search.json');
}

/**
 * Absolute path to the vendored extension's entry point. Resolved through Node
 * from the package's own package.json (pi-web-access declares no `main`/`exports`,
 * so the bare specifier is not resolvable but a subpath is) — which works both
 * from `src/` under vitest and from the built `dist/main` bundle at runtime, since
 * the package is rollup-external and the app ships unpacked (asar: false).
 */
export async function piWebAccessPath(): Promise<string | null> {
  try {
    const manifest = fileURLToPath(import.meta.resolve(`${PACKAGE}/package.json`));
    const entry = join(manifest, '..', 'index.ts');
    await access(entry);
    return entry;
  } catch {
    // quiet: missing dependency — pi still starts, just without the search tools.
    // Logged by the caller (resolveWebAccessExtension); a hard failure here would
    // cost the user the whole backend.
    return null;
  }
}

/** Installed version of the vendored package, for the startup drift warning. */
export async function webAccessVersion(): Promise<string | null> {
  try {
    const manifest = fileURLToPath(import.meta.resolve(`${PACKAGE}/package.json`));
    const version = (JSON.parse(await readFile(manifest, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    // quiet: the caller resolves the same manifest one line earlier and only
    // reads this to compare against the tested version, so null costs a drift
    // warning and nothing a user would feel.
    return null;
  }
}

/**
 * Every search backend pi-web-access can use, with the config field that unlocks
 * it. `SearchProvider` in the package's gemini-search.ts is the source of truth
 * for the ids; `field` is the exact key each backend's own loader reads (they are
 * NOT uniformly `<name>ApiKey` — SearXNG wants a base URL).
 *
 * Backends with `field: null` need no credential: `auto` walks the chain, `all`
 * fans out across everything configured, and Exa additionally works keyless
 * through its public MCP endpoint (a key just upgrades it to the direct API).
 *
 * Four backends are explicit-only in the package — neither `auto` nor `all` will
 * reach for them, so they answer only when picked by name. `xai` because its
 * searches run inside Grok's own inference and are metered against the signed-in
 * account; `anysearch`, `brightdata` and `serpbase` because the package keeps them
 * out of ALL_SEARCH_PROVIDERS and the fallback chain. Picking one has to be a
 * decision.
 *
 * `brightdata` is also the one backend a key alone does not configure: it needs a
 * SERP-type zone as well, and its own availability check tests the zone first.
 */
export const SEARCH_BACKENDS = [
  { id: 'auto', field: null },
  { id: 'all', field: null },
  { id: 'openai', field: 'openaiApiKey' },
  { id: 'exa', field: 'exaApiKey', optional: true },
  { id: 'brave', field: 'braveApiKey' },
  { id: 'tavily', field: 'tavilyApiKey' },
  { id: 'perplexity', field: 'perplexityApiKey' },
  { id: 'gemini', field: 'geminiApiKey' },
  { id: 'parallel', field: 'parallelApiKey' },
  { id: 'tinyfish', field: 'tinyfishApiKey' },
  { id: 'serpdive', field: 'serpdiveApiKey' },
  { id: 'kagi', field: 'kagiApiKey' },
  { id: 'ollama', field: 'ollamaApiKey' },
  { id: 'search1api', field: 'search1apiApiKey' },
  { id: 'searchinfinity', field: 'searchinfinityApiKey' },
  { id: 'querit', field: 'queritApiKey' },
  { id: 'brightdata', field: 'brightdataApiKey', alsoField: 'brightdataSerpZone' },
  { id: 'serpbase', field: 'serpbaseApiKey' },
  { id: 'anysearch', field: 'anysearchApiKey' },
  { id: 'xai', field: 'xaiApiKey', optional: true },
  { id: 'searxng', field: 'searxngBaseUrl' }
] as const;

/**
 * Every config field Stem will pass through to web-search.json. An allowlist
 * rather than a free-for-all: an unrecognized name would sit in a file the user
 * may well open, doing nothing.
 *
 * Beyond the per-backend fields above:
 * - `openaiResponsesUrl` repoints the OpenAI backend at a Responses-compatible
 *   gateway (the package defaults to api.openai.com).
 * - `firecrawlBaseUrl`/`firecrawlApiKey` supply a self-hosted Firecrawl, first in
 *   the chain that `fetch_content` falls back to when a page blocks plain fetching.
 * - `cloudflareApiKey` backs the Gemini-via-Cloudflare path.
 * - `brightdataUnlockerZone` is the other half of Bright Data's Web Unlocker, a
 *   paid `fetch_content` fallback. It reuses `brightdataApiKey` but is a different
 *   zone type from the SERP zone the search backend wants.
 */
export const WEB_SEARCH_FIELDS: readonly string[] = [
  ...SEARCH_BACKENDS.flatMap((b) => [
    ...(b.field ? [b.field as string] : []),
    ...('alsoField' in b && b.alsoField ? [b.alsoField as string] : [])
  ]),
  'cloudflareApiKey',
  'openaiResponsesUrl',
  'firecrawlBaseUrl',
  'firecrawlApiKey',
  'brightdataUnlockerZone'
];

/** Fields holding a secret (masked in the UI); the rest are endpoints. */
export const WEB_SEARCH_SECRET_FIELDS: readonly string[] = WEB_SEARCH_FIELDS.filter((f) =>
  f.endsWith('ApiKey')
);

/**
 * Which settings patches have to reach `<piHome>/web-search.json`. Only two
 * fields of WebSearchSettings live in that file; `main`/`quickChat` are applied
 * per turn by the runtime. Split out of the IPC handler so the rule is testable —
 * it used to name `searxngUrl`/`apiKeys`, which the migration reader renamed years
 * of settings ago, and missed `credentials` entirely, so a key edit was persisted
 * to settings.json and never reached the search extension at all.
 */
export function needsWebSearchConfigWrite(patch: Partial<WebSearchSettings>): boolean {
  return 'provider' in patch || 'credentials' in patch;
}

/**
 * Whether the change also needs a fresh pi process to take effect.
 *
 * pi-web-access caches its config per backend module for the life of the process
 * (`brave.ts`, `exa.ts`, `tavily.ts`, … all do `if (cachedConfig) return cachedConfig`
 * with no invalidation), so a credential that a running backend has already read
 * is frozen until the next spawn. `provider` is the exception: the tool handler
 * re-reads it per call, which is why switching backends has always worked live.
 */
export function needsBackendRestart(patch: Partial<WebSearchSettings>): boolean {
  return 'credentials' in patch;
}

/**
 * Rewrite `<piHome>/web-search.json` from Stem's settings. Called on startup and
 * whenever the user changes the backend or a credential — see
 * needsBackendRestart for what the running process does and does not pick up.
 *
 * Credentials are written in the clear, matching how the package reads them. They
 * are the user's own keys under the app's private data dir — the same trust
 * boundary as `<piHome>/auth.json`, which holds their OAuth tokens.
 */
export async function writeWebSearchConfig(settings: WebSearchSettings): Promise<void> {
  const file: Record<string, unknown> = {
    // `none` keeps the tools headless. The package's default workflow
    // ("summary-review") starts a local HTTP server and opens a BROWSER window to
    // curate results — right for a terminal agent, wrong for Stem, which drives pi
    // over RPC and renders its own activity rows. It does check `ctx.hasUI`, but
    // relying on that inference would put a stray localhost server one upstream
    // refactor away, so pin it explicitly.
    workflow: 'none',
    openaiSearchModel: OPENAI_SEARCH_MODEL
  };
  if (settings.provider && settings.provider !== 'auto') file.provider = settings.provider;
  for (const [name, value] of Object.entries(settings.credentials ?? {})) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed && WEB_SEARCH_FIELDS.includes(name)) file[name] = trimmed;
  }
  await writeFile(webSearchConfigPath(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

// mtime-cached read of the backend we wrote into web-search.json. That file — not
// settings.json — is what pi-web-access actually reads, so naming it in the prompt
// can never claim a backend the search tools aren't using.
// Keyed on path as well as mtime: the path is fixed in the app, but not under a
// test that repoints piHome, and a stale hit there would be silent.
let backendCache: { key: string; provider: string } = { key: '', provider: 'auto' };

function activeBackend(): string {
  const path = webSearchConfigPath();
  try {
    const key = `${path}:${statSync(path).mtimeMs}`;
    if (key !== backendCache.key) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { provider?: unknown };
      // writeWebSearchConfig omits `provider` for `auto`, which is also what an
      // absent/corrupt file should mean — the keyless fallback chain.
      backendCache = { key, provider: typeof raw.provider === 'string' ? raw.provider : 'auto' };
    }
  } catch {
    // quiet: 'auto' is what an absent or unreadable file means to pi-web-access
    // too — it walks the same keyless fallback chain — so the prompt still names
    // the backend the search tools will actually use.
    backendCache = { key: '', provider: 'auto' };
  }
  return backendCache.provider;
}

/** How the backend reads in the prompt; the meta-values need spelling out. */
function backendDescription(provider: string): string {
  if (provider === 'auto') return 'automatic — tries each configured backend, ending at one that needs no key';
  if (provider === 'all') return 'every configured backend at once';
  return provider;
}

/**
 * The per-turn "Web access" block, injected next to the MCP tool catalog.
 *
 * The catalog block enumerates every routed MCP tool by name — often hundreds of
 * them, including browser-automation servers — right before the user's message,
 * while the search tools appeared only in the raw tool schemas and in a paragraph
 * of the appended system prompt far above. A model reading that menu had no local
 * reason to believe web search existed at all, and reached for a browser to open a
 * link. Naming these four alongside the catalog puts them back in view.
 *
 * Returns null when this turn's gate is off (the tools are deactivated then, so
 * advertising them would be a lie).
 */
export function buildWebSearchContext(enabled: boolean): string | null {
  if (!enabled) return null;
  return (
    `Web access (built-in tools — call these directly, NOT through \`invoke_tool\`):\n` +
    `  - web_search — search the live web (backend: ${backendDescription(activeBackend())}); ` +
    `prefer \`queries\` with 2-4 differently-phrased angles over a single query.\n` +
    `  - fetch_content — fetch one or more URLs and return their readable text ` +
    `(also YouTube transcripts and GitHub repositories); pass ALL the URLs you want ` +
    `in one call's \`urls\` array — they are fetched in parallel, whereas one call ` +
    `per URL costs a full round trip each.\n` +
    `  - source_check — check a claim against web sources, with passage-level citations.\n` +
    `  - get_search_content — retrieve fuller content from an earlier web_search/fetch_content result.`
  );
}

// `web_search` returns one markdown blob: a synthesized answer with inline
// [title](url) citations, then a trailing numbered "**Sources:**" list. Stem's
// sources panel wants {url, title} pairs, so recover them from the text — the
// tee that used to supply them only ever existed for the codex stream.
const SOURCES_HEADING = /^\s*\*\*Sources:\*\*\s*$/m;
const MARKDOWN_LINK = /\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s)<>"']+/g;

/**
 * Pull deduped web sources out of a `web_search` tool result.
 *
 * Inline `[title](url)` citations come first and carry a human title, so they win
 * on the dedupe; the numbered tail list fills in whatever they missed as bare
 * URLs. Anything unparseable yields an empty list rather than throwing — a
 * malformed result must never cost the user their answer.
 */
export function extractSources(text: string): SourceRef[] {
  if (!text) return [];
  const byUrl = new Map<string, SourceRef>();
  const add = (url: string, title?: string): void => {
    // Trailing punctuation clings to bare URLs in prose.
    const clean = url.replace(/[.,;:]+$/, '');
    const existing = byUrl.get(clean);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      return;
    }
    byUrl.set(clean, title ? { url: clean, title } : { url: clean });
  };

  for (const m of text.matchAll(MARKDOWN_LINK)) add(m[2], m[1].trim() || undefined);

  const headingAt = text.search(SOURCES_HEADING);
  if (headingAt !== -1) {
    for (const m of text.slice(headingAt).matchAll(BARE_URL)) add(m[0]);
  }
  return [...byUrl.values()];
}
