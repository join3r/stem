import type { ModelOverride } from '../../shared/types';

// Guard for the per-model overrides a custom endpoint carries (settings →
// models.json `modelOverrides`). Pure and I/O-free so both the write path
// (ipc/auth.ts, before anything is persisted) and the sync backstop
// (models-config.ts, for a hand-edited settings.json) can share it.
//
// Why a guard at all, when pi validates models.json itself: pi's ModelConfig.load
// fails the WHOLE FILE on one bad type and returns an empty provider map, so a
// stray `"reasoning": "true"` would take out Ollama and LM Studio along with the
// endpoint being edited. Stem must never write a file pi can't load.
//
// Why Stem's own copy rather than pi's schema: `ModelOverrideSchema` exists in
// pi's dist types but is not re-exported from the package entry, and the exports
// map blocks the deep import. Mirrored from pi 0.82 — re-check on a pi upgrade.

export type ParsedOverrides =
  | { ok: true; value: Record<string, ModelOverride> }
  | { ok: false; errors: string[] };

/**
 * pi's thinking levels. Stem's picker shows off/low/medium/high/xhigh
 * (DISPLAY_EFFORTS in runtime.ts); `minimal` and `max` are accepted here because
 * pi accepts them, and simply never offered.
 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const THINKING_FORMATS = [
  'openai',
  'openrouter',
  'together',
  'deepseek',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling'
];

/** `compat` keys pi declares as plain booleans, across both API flavors. */
const COMPAT_BOOLEANS = [
  'supportsStore',
  'supportsDeveloperRole',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'requiresToolResultName',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages',
  'supportsOpenAIGrammarTools',
  'supportsStrictMode',
  'supportsStrictTools',
  'sendSessionAffinityHeaders',
  'supportsLongCacheRetention',
  'supportsCacheControlOnTools',
  'supportsEagerToolInputStreaming',
  'supportsTemperature',
  'supportsToolReferences',
  'forceAdaptiveThinking',
  'allowEmptySignature'
];

/** `compat` keys pi declares as a closed set of strings. */
const COMPAT_ENUMS: Record<string, string[]> = {
  thinkingFormat: THINKING_FORMATS,
  maxTokensField: ['max_completion_tokens', 'max_tokens'],
  cacheControlFormat: ['anthropic'],
  sessionAffinityFormat: ['openai', 'openai-nosession', 'openrouter'],
  deferredToolsMode: ['kimi']
};

const CHAT_TEMPLATE_VARS = ['thinking.enabled', 'thinking.effort'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(values: string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}

/**
 * One `chat_template_kwargs` value: a scalar the server wants verbatim, or the
 * `{ "$var": … }` form that asks pi to fill the current thinking state in.
 */
function checkChatTemplateValue(path: string, value: unknown, errors: string[]): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (!isPlainObject(value)) {
    errors.push(`${path} must be a string, number, boolean, null, or a { "$var": … } object`);
    return;
  }
  if (typeof value.$var !== 'string' || !CHAT_TEMPLATE_VARS.includes(value.$var)) {
    errors.push(`${path}.$var must be one of ${list(CHAT_TEMPLATE_VARS)}`);
  }
  if ('omitWhenOff' in value && typeof value.omitWhenOff !== 'boolean') {
    errors.push(`${path}.omitWhenOff must be true or false`);
  }
}

function checkCompat(path: string, compat: unknown, errors: string[]): void {
  if (!isPlainObject(compat)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(compat)) {
    if (COMPAT_BOOLEANS.includes(key)) {
      if (typeof value !== 'boolean') errors.push(`${path}.${key} must be true or false`);
      continue;
    }
    const options = COMPAT_ENUMS[key];
    if (options) {
      if (typeof value !== 'string' || !options.includes(value)) {
        errors.push(`${path}.${key} must be one of ${list(options)}`);
      }
      continue;
    }
    if (key === 'chatTemplateKwargs') {
      if (!isPlainObject(value)) {
        errors.push(`${path}.chatTemplateKwargs must be an object`);
        continue;
      }
      for (const [k, v] of Object.entries(value)) checkChatTemplateValue(`${path}.chatTemplateKwargs.${k}`, v, errors);
      continue;
    }
    // Anything else (routing blocks, whatever pi adds next) rides along
    // unchecked — pi's schema tolerates unknown keys, so it cannot invalidate
    // the file, and refusing it would block a field Stem hasn't heard of yet.
  }
}

function checkThinkingLevelMap(path: string, map: unknown, errors: string[]): void {
  if (!isPlainObject(map)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [level, value] of Object.entries(map)) {
    // Stricter than pi, which ignores a level it doesn't know. A typo'd level is
    // the failure this whole feature exists to end — a setting that reads as
    // chosen and silently isn't — so it gets refused rather than dropped.
    if (!THINKING_LEVELS.includes(level)) {
      errors.push(`${path}.${level} is not a thinking level — use one of ${list(THINKING_LEVELS)}`);
      continue;
    }
    if (value !== null && typeof value !== 'string') {
      errors.push(`${path}.${level} must be a string (the value to send) or null (not supported)`);
    }
  }
}

function checkPositive(path: string, value: unknown, errors: string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${path} must be a number greater than 0`);
  }
}

function checkOverride(id: string, override: unknown, errors: string[]): void {
  if (!isPlainObject(override)) {
    errors.push(`${id} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(override)) {
    switch (key) {
      case 'name':
        if (typeof value !== 'string') errors.push(`${id}.name must be a string`);
        break;
      case 'reasoning':
        if (typeof value !== 'boolean') errors.push(`${id}.reasoning must be true or false`);
        break;
      case 'thinkingLevelMap':
        checkThinkingLevelMap(`${id}.thinkingLevelMap`, value, errors);
        break;
      case 'input':
        if (!Array.isArray(value) || !value.every((v) => v === 'text' || v === 'image')) {
          errors.push(`${id}.input must be an array of "text" and/or "image"`);
        }
        break;
      case 'contextWindow':
      case 'maxTokens':
        checkPositive(`${id}.${key}`, value, errors);
        break;
      case 'compat':
        checkCompat(`${id}.compat`, value, errors);
        break;
      default:
        // Unknown key: kept. See checkCompat's note — pi tolerates these.
        break;
    }
  }
}

/**
 * Validate a `modelOverrides` object, collecting every problem rather than
 * stopping at the first: this is read back into a text box the user is fixing,
 * and one error per save is one round-trip per typo.
 *
 * `undefined`/`null` is "none set", not a failure — the field is optional
 * everywhere it appears.
 */
export function parseModelOverrides(raw: unknown): ParsedOverrides {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return { ok: false, errors: ['Overrides must be an object keyed by model id'] };
  const errors: string[] = [];
  for (const [id, override] of Object.entries(raw)) {
    if (!id.trim()) {
      errors.push('A model id cannot be blank');
      continue;
    }
    checkOverride(id, override, errors);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: raw as Record<string, ModelOverride> };
}
