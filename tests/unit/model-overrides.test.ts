// The guard on the per-model overrides a custom endpoint carries into
// models.json. Its job is narrow and load-bearing: pi's ModelConfig.load fails
// the WHOLE file on one bad type and hands back an empty provider map, so a
// fragment that slips through here doesn't cost the endpoint being edited — it
// costs Ollama and LM Studio too.
import { describe, expect, it } from 'vitest';
import { parseModelOverrides } from '../../src/server/pi/model-overrides';

/** The shape the feature exists for: a Qwen3 behind an OpenAI-compatible server. */
const QWEN = {
  'qwen3-32b': {
    reasoning: true,
    thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null },
    compat: {
      thinkingFormat: 'qwen-chat-template',
      supportsReasoningEffort: true,
      chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' }, preserve_thinking: true }
    }
  }
};

function errors(raw: unknown): string[] {
  const parsed = parseModelOverrides(raw);
  return parsed.ok ? [] : parsed.errors;
}

describe('parseModelOverrides', () => {
  it('accepts the worked Qwen3 fragment and hands it back unchanged', () => {
    const parsed = parseModelOverrides(QWEN);
    expect(parsed.ok).toBe(true);
    // Written into models.json verbatim — a guard that rewrote its input would
    // make "what you type is what pi gets" untrue.
    if (parsed.ok) expect(parsed.value).toEqual(QWEN);
  });

  it('treats nothing set as valid, not as a failure', () => {
    expect(parseModelOverrides(undefined)).toEqual({ ok: true, value: {} });
    expect(parseModelOverrides(null)).toEqual({ ok: true, value: {} });
    expect(parseModelOverrides({})).toEqual({ ok: true, value: {} });
  });

  it('rejects a non-object at the top, including an array', () => {
    expect(errors([{ id: 'qwen3-32b' }])).toHaveLength(1);
    expect(errors('reasoning')).toHaveLength(1);
  });

  it('names the model and the key of a mistyped value', () => {
    expect(errors({ 'qwen3-32b': { reasoning: 'true' } })).toEqual([
      'qwen3-32b.reasoning must be true or false'
    ]);
    expect(errors({ 'qwen3-32b': { thinkingLevelMap: { high: 3 } } })).toEqual([
      'qwen3-32b.thinkingLevelMap.high must be a string (the value to send) or null (not supported)'
    ]);
    expect(errors({ 'qwen3-32b': { contextWindow: 0 } })).toEqual([
      'qwen3-32b.contextWindow must be a number greater than 0'
    ]);
  });

  it('collects every problem rather than stopping at the first', () => {
    // The box is being corrected by hand; one error per save is one round-trip
    // per typo.
    expect(
      errors({ a: { reasoning: 1 }, b: { name: 2, maxTokens: -1 } }).sort()
    ).toEqual([
      'a.reasoning must be true or false',
      'b.maxTokens must be a number greater than 0',
      'b.name must be a string'
    ]);
  });

  it('rejects a level pi has never heard of, naming the ones that exist', () => {
    // Stricter than pi, which would ignore it — and an ignored level is exactly
    // the setting that reads as chosen and silently isn't.
    const [message] = errors({ 'qwen3-32b': { thinkingLevelMap: { veryhigh: 'high' } } });
    expect(message).toContain('veryhigh is not a thinking level');
    expect(message).toContain('"xhigh"');
  });

  it('accepts the two levels Stem never displays, because pi accepts them', () => {
    expect(parseModelOverrides({ m: { thinkingLevelMap: { minimal: 'low', max: 'max' } } }).ok).toBe(true);
  });

  it('checks compat’s closed sets', () => {
    expect(errors({ m: { compat: { thinkingFormat: 'qwen-chat-templat' } } })[0]).toContain(
      'm.compat.thinkingFormat must be one of'
    );
    expect(errors({ m: { compat: { maxTokensField: 'max_tokens' } } })).toEqual([]);
    expect(errors({ m: { compat: { supportsReasoningEffort: 'yes' } } })).toEqual([
      'm.compat.supportsReasoningEffort must be true or false'
    ]);
  });

  it('checks the $var form chat_template_kwargs uses for pi-controlled thinking', () => {
    expect(errors({ m: { compat: { chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } } } } })).toEqual([]);
    expect(
      errors({ m: { compat: { chatTemplateKwargs: { enable_thinking: { $var: 'thinking' } } } } })[0]
    ).toContain('$var must be one of');
    // Plain scalars are the other legal form.
    expect(errors({ m: { compat: { chatTemplateKwargs: { preserve_thinking: true, n: 1, s: 'x', z: null } } } })).toEqual([]);
  });

  it('passes unknown keys through untouched, at every level', () => {
    // pi's TypeBox objects set no additionalProperties:false, so an unknown key
    // cannot invalidate the file — and refusing one would block whatever pi adds
    // next behind a Stem release.
    const future = {
      'qwen3-32b': {
        reasoning: true,
        somethingPiAddedLater: { deeply: ['nested', 1] },
        compat: { openRouterRouting: { order: ['anthropic'] }, alsoNew: 42 }
      }
    };
    const parsed = parseModelOverrides(future);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(future);
  });

  it('rejects a blank model id', () => {
    expect(errors({ '  ': { reasoning: true } })).toEqual(['A model id cannot be blank']);
  });
});
