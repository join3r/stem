import { readFileSync } from 'node:fs';
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
// The catch, and what Stem's own search order is about: "the search happens in the
// extension" does not have to mean "the search costs a model". The package's own
// `auto` tries its OpenAI backend early (right after SearXNG when the chat model is
// a ChatGPT one), which spends a whole extra inference — 4-12s, plus ChatGPT quota —
// asking a model to run a query and quote the results. The old native trick was
// fast precisely because it had no such second model: the provider's hosted tool
// ran inside the chat model's own request. Nothing about being provider-agnostic
// requires giving that up. So Stem's `auto` is an ordered route (searchRouting,
// see SEARCH_ROUTE) that tries plain index lookups first (self-hosted SearXNG, then
// any keyed backend, then Exa's keyless MCP endpoint at ~0.4s and no credential at
// all), and falls back to an LLM-mediated backend only when every one of them is
// unreachable. Synthesis then happens where it was always going to happen anyway —
// in the chat model, which is mid-inference over the results regardless of who
// fetched them.
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
// Up to 0.18.0 Stem patched the package (patch-package): a concurrent multi-query
// fan-out and a reordered `auto` chain. 0.46.0 needs neither — it runs a call's
// queries three at a time itself, and `searchRouting` expresses the order as
// configuration — so the package now runs unmodified.

const PACKAGE = 'pi-web-access';

/*
 * The OpenAI search backend's model is NOT pinned. pi-web-access picks it from pi's
 * registry for whichever OpenAI credential it finds (`pickSearchModel` in
 * openai-search.ts), and the config's `openaiSearchModel` is a verbatim override
 * with no fallback: a rotated-out id fails every search rather than degrading.
 *
 * Stem used to pin `gpt-5.4-mini` here — measured fastest and cheapest against the
 * API endpoint. A ChatGPT (Codex OAuth) login goes to the Codex endpoint instead,
 * which on 2026-09-09 stopped accepting that id ("not supported when using Codex
 * with a ChatGPT account"), and the pin took every web search on that account
 * down with it for five days. The registry's own choice is a model the account
 * can actually run, and it follows the account when OpenAI rotates ids; the couple
 * of seconds a bigger id may cost per search is the fallback path's problem, not
 * the default one's (see the ordering rule in tests/unit/web-search-latency.test.ts).
 */

/** The version this integration was written against (mirrors TESTED_PI_VERSION). */
export const TESTED_WEB_ACCESS_VERSION = '0.46.0';

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
 * Absolute path to the vendored extension's entry point: the precompiled bundle the
 * package's own `pi.extensions` names, one file instead of ~80 TypeScript modules
 * for pi to transpile on every spawn. Resolved through Node from the package's own
 * package.json (pi-web-access declares no `main`/`exports`, so the bare specifier
 * is not resolvable but a subpath is) — which works both
 * from `src/` under vitest and from the built `dist/main` bundle at runtime, since
 * the package is rollup-external and the app ships unpacked (asar: false).
 */
export async function piWebAccessPath(): Promise<string | null> {
  try {
    const manifest = fileURLToPath(import.meta.resolve(`${PACKAGE}/package.json`));
    const entry = join(manifest, '..', 'dist', 'index.js');
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
 * Stem's `auto`: the order an unpinned search walks, written as the package's
 * `searchRouting`. Index lookups first — whichever of them the user configured —
 * then Exa's keyless MCP endpoint, which is always available, so in practice the
 * chain stops there. The LLM-mediated backends come last, reached only when every
 * index above is unavailable or erroring: `openai` runs a whole model inference
 * per query (and on a ChatGPT login spends the subscription's quota), `gemini` too.
 * Perplexity is an index since 0.37.0 (its Search API, no Sonar answer).
 *
 * Backends without a credential are skipped as `unavailable`, so listing the
 * package's whole `auto` set costs nothing. `gemini` is the exception, added only
 * with an API key: its availability check otherwise reads Chromium cookies for
 * Gemini Web, which on a Mac can raise a keychain prompt in the middle of a search.
 */
export const SEARCH_ROUTE = [
  'searxng',
  'brave',
  'parallel',
  'tinyfish',
  'search1api',
  'searchinfinity',
  'querit',
  'tavily',
  'firecrawl',
  'jina',
  'serpdive',
  'kagi',
  'bocha',
  'ollama',
  'perplexity',
  'exa',
  'openai'
] as const;

/**
 * Failures that move a routed search on to the next backend. The package can only
 * fall back on these kinds; `auth`, `credential`, `config` and `invalid-request`
 * end the search with that backend's error — a dead key the user configured shows
 * up as an error naming it rather than being quietly papered over by Exa.
 */
export const SEARCH_ROUTE_FALLBACK_ON = [
  'transient',
  'quota',
  'network',
  'invalid-response',
  'unsupported',
  'empty'
] as const;

/**
 * Ceiling on one routed query, across every backend it tries. The package runs a
 * call's queries three at a time, so a 4-query call is at most two of these —
 * the 90s whole-call budget Stem's old patch enforced.
 */
export const SEARCH_ROUTE_TIMEOUT_MS = 45_000;

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
    // Since 0.34.0 the package starts a session with only a `web_enable` loader
    // and registers the real tools inactive until the model calls it. Stem gates
    // `web_search`/`fetch_content`/… by name every turn (stem-mcp-extension's
    // enableBrowseTools), so the loader would only hide them behind an extra
    // round trip. Eager: the tools are simply there, and the gate decides.
    toolActivation: 'eager'
  };
  if (settings.provider && settings.provider !== 'auto') file.provider = settings.provider;
  for (const [name, value] of Object.entries(settings.credentials ?? {})) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed && WEB_SEARCH_FIELDS.includes(name)) file[name] = trimmed;
  }
  // The package applies searchRouting only while no `provider` is set, so this is
  // exactly Stem's `auto`; a picked backend or `all` keeps the package's meaning.
  if (!('provider' in file)) {
    file.searchRouting = {
      providers: [...SEARCH_ROUTE, ...('geminiApiKey' in file ? ['gemini'] : [])],
      fallbackOn: [...SEARCH_ROUTE_FALLBACK_ON],
      timeoutMs: SEARCH_ROUTE_TIMEOUT_MS
    };
  }
  await writeFile(webSearchConfigPath(), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

// Fresh read of the backend we wrote into web-search.json. That file — not
// settings.json — is what pi-web-access actually reads, so naming it in the prompt
// can never claim a backend the search tools aren't using.
// Deliberately NOT mtime-cached: the file is a few hundred bytes read once per
// turn, and an mtime key serves the STALE backend when two writes land in the
// same millisecond — a user flipping the setting twice quickly, or the suite on
// a coarse-mtime filesystem, both hit it silently.
function activeBackend(): string {
  try {
    const raw = JSON.parse(readFileSync(webSearchConfigPath(), 'utf8')) as { provider?: unknown };
    // writeWebSearchConfig omits `provider` for `auto`, which is also what an
    // absent/corrupt file should mean — the keyless fallback chain.
    return typeof raw.provider === 'string' ? raw.provider : 'auto';
  } catch {
    // quiet: 'auto' is what an absent or unreadable file means to pi-web-access
    // too — it walks the same keyless fallback chain — so the prompt still names
    // the backend the search tools will actually use.
    return 'auto';
  }
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
