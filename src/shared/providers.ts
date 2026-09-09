import type { AuthProviderId, ApiKeyProviderId, CustomProviderId, LocalProviderId } from './types';

// Provider identity shared by main (runtime, models-config) and the renderer
// (settings, onboarding): one place for ids and friendly display names.

/** Friendly provider names for the UI (model picker, provider rows, toggles). */
export const PROVIDER_NAMES: Record<string, string> = {
  'openai-codex': 'ChatGPT',
  anthropic: 'Claude',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  // The product, not the vendor (xAI) — same convention as Claude/ChatGPT above.
  xai: 'Grok',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Custom endpoint'
};

export const providerName = (p: string): string => PROVIDER_NAMES[p] ?? p;

/** Wizard/settings OAuth choices. */
export const AUTH_PROVIDER_IDS: AuthProviderId[] = ['openai-codex', 'anthropic', 'xai'];

/** API-key providers offered in the key form. */
export const API_KEY_PROVIDER_IDS: ApiKeyProviderId[] = ['anthropic', 'openai', 'openrouter', 'xai'];

/** OpenAI-compatible servers Stem registers with the backend itself (models.json). */
export const LOCAL_PROVIDER_IDS: LocalProviderId[] = ['ollama', 'lmstudio', 'custom'];

/**
 * The one shape a named custom endpoint's id may take. It doubles as the key in
 * settings.json and as pi's provider id in models.json, so it stays inside the
 * reserved `custom-` namespace and the lowercase/digit/hyphen set pi is known to
 * accept. Settings coercion, the IPC guard and the renderer all test against
 * this single pattern.
 */
export const CUSTOM_PROVIDER_ID_RE = /^custom-[a-z0-9][a-z0-9-]*$/;

export function isLocalProviderId(id: string): id is LocalProviderId {
  return (LOCAL_PROVIDER_IDS as string[]).includes(id) || CUSTOM_PROVIDER_ID_RE.test(id);
}

export function isCustomProviderId(id: string): id is CustomProviderId {
  return id === 'custom' || CUSTOM_PROVIDER_ID_RE.test(id);
}

/** Build a deterministic provider id from a display name; collisions are the caller's. */
export function customProviderId(name: string): CustomProviderId {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `custom-${slug || 'endpoint'}`;
}

/**
 * The id a named endpoint will be saved under: the slug of its name, suffixed
 * only past ids that are live. A disconnected entry with the same slug is
 * reused on purpose — that is what lets its retained overrides come back — so
 * the add form shows those before Enable rather than applying them unseen.
 */
export function resolveCustomProviderId(name: string, live: (id: CustomProviderId) => boolean): CustomProviderId {
  const base = customProviderId(name);
  let id: CustomProviderId = base;
  for (let suffix = 2; live(id); suffix++) id = `${base}-${suffix}`;
  return id;
}
