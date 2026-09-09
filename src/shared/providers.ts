import type { AuthProviderId, ApiKeyProviderId, LocalProviderId } from './types';

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

export function isLocalProviderId(id: string): id is LocalProviderId {
  return (LOCAL_PROVIDER_IDS as string[]).includes(id) || /^custom-[a-z0-9][a-z0-9-]*$/.test(id);
}

export function isCustomProviderId(id: string): id is LocalProviderId {
  return id === 'custom' || /^custom-[a-z0-9][a-z0-9-]*$/.test(id);
}

/** Build a deterministic provider id; callers resolve collisions before saving. */
export function customProviderId(name: string): LocalProviderId {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `custom-${slug || 'endpoint'}`;
}
