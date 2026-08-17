// Converting somebody's pi models.json into the per-model overrides box. Two
// things are pinned here and they are different in kind: that the extras survive
// the trip intact (a thinkingFormat lost on the way is a model that silently
// stops thinking, which is the bug the box exists for), and that the wiring
// fields do NOT — `id` is the key, and `api`/`baseUrl` have no business in an
// override.
//
// The last test is the one that matters most: the converter's output is fed to
// the guard the Save button runs. An import Save would then refuse is a bug, and
// nothing in the importer itself would ever notice.
import { describe, expect, it } from 'vitest';
import { parsePiModelsJson, providerLabel } from '../../src/shared/piModelsImport';
import { parseModelOverrides } from '../../src/server/pi/model-overrides';

/** A vLLM box as one is actually configured: the thinking wiring is provider-wide. */
const VLLM_BLOCK = {
  baseUrl: 'http://gpu.lan:8000',
  api: 'openai-completions',
  compat: { thinkingFormat: 'qwen-chat-template', supportsReasoningEffort: true },
  models: [
    {
      id: 'qwen3-32b',
      name: 'Qwen3 32B',
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null },
      contextWindow: 131072
    },
    { id: 'qwen3-8b', reasoning: true },
    { id: 'embed-only' }
  ]
};

const FILE = { providers: { vllm: VLLM_BLOCK } };

function overridesOf(raw: unknown, id = 'vllm') {
  const parsed = parsePiModelsJson(JSON.stringify(raw));
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.error}`);
  const provider = parsed.providers.find((p) => p.id === id);
  if (!provider) throw new Error(`no provider ${id} in ${parsed.providers.map((p) => p.id).join(', ')}`);
  return provider.overrides;
}

describe('parsePiModelsJson', () => {
  it('keys by model id and keeps the extras, dropping only the wiring', () => {
    expect(overridesOf(FILE)).toEqual({
      'qwen3-32b': {
        name: 'Qwen3 32B',
        reasoning: true,
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null },
        contextWindow: 131072,
        compat: { thinkingFormat: 'qwen-chat-template', supportsReasoningEffort: true }
      },
      // The provider-level compat is what makes this one worth importing at all:
      // on its own the entry says only that it reasons, with no way to ask it to.
      'qwen3-8b': {
        reasoning: true,
        compat: { thinkingFormat: 'qwen-chat-template', supportsReasoningEffort: true }
      },
      // Bare `{ id }`, and still an entry — because the provider block said
      // something about it. Stem writes its own provider compat into models.json
      // (supportsReasoningEffort pinned false), so a model left out here is a
      // model that behaves differently under Stem than it does under pi.
      'embed-only': { compat: { thinkingFormat: 'qwen-chat-template', supportsReasoningEffort: true } }
    });
  });

  it('leaves id, api and baseUrl out of every value', () => {
    const overrides = overridesOf({
      providers: { vllm: { ...VLLM_BLOCK, models: [{ id: 'm', api: 'openai-completions', baseUrl: 'http://elsewhere', reasoning: true }] } }
    });
    // Not merely inert — a fragment carrying these would read as though the box
    // could repoint the endpoint, which is precisely what it must not do.
    expect(Object.keys(overrides.m)).toEqual(['reasoning', 'compat']);
  });

  it('lets a model’s own compat win the key it names, and inherit the rest', () => {
    const overrides = overridesOf({
      providers: {
        vllm: {
          compat: { thinkingFormat: 'qwen-chat-template', supportsReasoningEffort: true },
          models: [{ id: 'm', compat: { thinkingFormat: 'openai' } }]
        }
      }
    });
    expect(overrides.m.compat).toEqual({ thinkingFormat: 'openai', supportsReasoningEffort: true });
  });

  it('folds provider headers down the same way as compat', () => {
    // pi reads modelOverrides[id].headers onto the request, so this is the only
    // way a gateway's tenant header reaches the wire from Stem's settings.
    const overrides = overridesOf(
      {
        providers: {
          gw: {
            headers: { 'X-Tenant': 'research', 'X-Trace': 'off' },
            models: [{ id: 'm', headers: { 'X-Trace': 'on' } }]
          }
        }
      },
      'gw'
    );
    expect(overrides.m.headers).toEqual({ 'X-Tenant': 'research', 'X-Trace': 'on' });
  });

  it('reads a whole file, a bare providers map and a lone block the same way', () => {
    const fromFile = overridesOf(FILE);
    expect(overridesOf({ vllm: VLLM_BLOCK })).toEqual(fromFile);
    // A lone block has no key to be named by, so it takes the endpoint's own.
    expect(overridesOf(VLLM_BLOCK, 'custom')).toEqual(fromFile);
  });

  it('gives nothing for models that are only an id, in either form', () => {
    // pi's short form and its long form both say "this model exists" and no
    // more, and this block adds nothing provider-wide either, so there is
    // genuinely nothing to copy. The provider is still offered — with a count
    // that says why it came back empty rather than vanishing.
    for (const models of [['a', 'b'], [{ id: 'a' }, { id: 'b' }]]) {
      const parsed = parsePiModelsJson(JSON.stringify({ providers: { ollama: { models } } }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.providers).toEqual([{ id: 'ollama', modelCount: 2, overrides: {} }]);
      expect(providerLabel(parsed.providers[0])).toBe('ollama — 2 models, 0 with extras');
    }
  });

  it('explains itself rather than throwing on input that is not a models.json', () => {
    expect(parsePiModelsJson('{ nope')).toEqual({ ok: false, error: expect.stringContaining('valid JSON') });
    expect(parsePiModelsJson('[{ "id": "m" }]').ok).toBe(false);
    expect(parsePiModelsJson('{ "theme": "dark" }').ok).toBe(false);
    expect(parsePiModelsJson('{ "providers": { "vllm": { "models": [] } } }')).toEqual({
      ok: false,
      error: expect.stringContaining('lists any models')
    });
  });

  it('produces overrides the Save button’s guard accepts', () => {
    // The join with what already exists. Every field here is written into
    // models.json verbatim, and pi's loader fails that file as a UNIT — so an
    // import the guard would refuse is not a cosmetic bug, it is the difference
    // between a filled box and a save that can never succeed.
    expect(parseModelOverrides(overridesOf(FILE)).ok).toBe(true);
    expect(
      parseModelOverrides(
        overridesOf({
          providers: {
            vllm: {
              compat: { thinkingFormat: 'qwen-chat-template', chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } } },
              models: [{ id: 'm', reasoning: true, maxTokens: 8192, input: ['text'], thinkingLevelMap: { high: 'high' } }]
            }
          }
        })
      ).ok
    ).toBe(true);
  });
});
