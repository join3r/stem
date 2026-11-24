// Models a provider already serves that the pi release Stem ships doesn't list
// yet. pi's registry is bundled at build time, so a model OpenAI launches today
// stays invisible until pi cuts a release and Stem bumps to it. models.json lets
// a built-in provider gain models (an entry with a new id is added, one with an
// existing id replaces the built-in), so Stem writes the missing ones there.
//
// Each entry is copied from pi's own catalog commit for that model, so the
// picker, effort levels and cost match what the next pi release will ship.
// When pi is bumped past these, move their ids to RETIRED_BACKFILL_IDS and
// empty the list: the sync then strips the entries it wrote from users'
// models.json and pi's built-in metadata takes over.

/** One model entry in pi's models.json shape. */
export interface BackfillModel {
  id: string;
  [key: string]: unknown;
}

const CODEX_BASE = {
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text', 'image'],
  maxTokens: 128000,
  // GPT-6.2 rejects reasoning effort "none" and "minimal" (pi: GPT_6_NO_NONE_EFFORT_MODEL_IDS).
  thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  compat: {
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsMidConvoSystemMessages: true
  },
  inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } }
};

/** Long-context tier: OpenAI doubles input and adds half to output above 272k. */
function cost(input: number, output: number, cacheRead: number, cacheWrite: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    tiers: [
      { inputTokensAbove: 272000, input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite: cacheWrite * 2 }
    ]
  };
}

/**
 * Per built-in provider, the models to add. GPT-6.2 Astra and Sol launched
 * 2026-11-17; pi added them on main the same day (earendil-works/pi
 * "feat(ai,coding-agent): add GPT-6.2 Astra and GPT-6.2 Sol"), after 1.5.2.
 */
export const CATALOG_BACKFILL: Record<string, BackfillModel[]> = {
  'openai-codex': [
    { ...CODEX_BASE, id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', cost: cost(8, 40, 0.4, 10), contextWindow: 272000 },
    { ...CODEX_BASE, id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol', cost: cost(2, 10, 0.1, 2.5), contextWindow: 500000 }
  ]
};

/** Ids Stem backfilled in earlier builds and must now remove again. */
export const RETIRED_BACKFILL_IDS: Record<string, string[]> = {};

interface ProviderBlock {
  models?: Array<{ id: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Bring each built-in provider's backfilled models in line with
 * {@link CATALOG_BACKFILL}, in place. Entries the user added by hand keep their
 * place; only ids Stem owns (current or retired) are rewritten or removed. A
 * provider block left with nothing in it is deleted, so models.json goes back
 * to exactly what it was before Stem touched it.
 */
export function applyCatalogBackfill(
  providers: Record<string, ProviderBlock>,
  backfill: Record<string, BackfillModel[]> = CATALOG_BACKFILL,
  retired: Record<string, string[]> = RETIRED_BACKFILL_IDS
): void {
  const touched = new Set([...Object.keys(backfill), ...Object.keys(retired)]);
  for (const provider of touched) {
    const wanted = backfill[provider] ?? [];
    const owned = new Set([...wanted.map((m) => m.id), ...(retired[provider] ?? [])]);
    const block: ProviderBlock = providers[provider] ?? {};
    const kept = (block.models ?? []).filter((m) => !owned.has(m.id));
    const models = [...kept, ...wanted.map((m) => ({ ...m }))];
    if (models.length) block.models = models;
    else delete block.models;
    if (Object.keys(block).length) providers[provider] = block;
    else delete providers[provider];
  }
}
