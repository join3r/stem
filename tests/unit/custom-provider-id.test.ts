// Named custom endpoints: the id shape is one pattern shared by settings
// coercion, the IPC guard and the renderer, and the id a name resolves to is
// what decides whether a disconnected endpoint's overrides come back.
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PROVIDER_ID_RE,
  customProviderId,
  isCustomProviderId,
  isLocalProviderId,
  resolveCustomProviderId
} from '../../src/shared/providers';

describe('custom provider ids', () => {
  it('slugs a display name into the reserved namespace', () => {
    expect(customProviderId('HAI OpenAI')).toBe('custom-hai-openai');
    expect(customProviderId('  Ünïcode -- proxy!  ')).toBe('custom-n-code-proxy');
    expect(customProviderId('')).toBe('custom-endpoint');
    expect(customProviderId('!!!')).toBe('custom-endpoint');
    expect(customProviderId('x'.repeat(80))).toBe(`custom-${'x'.repeat(48)}`);
  });

  it('every slug it produces passes the shared pattern, and junk keys do not', () => {
    for (const name of ['HAI OpenAI', '', '---', 'A', '9 lives']) {
      expect(CUSTOM_PROVIDER_ID_RE.test(customProviderId(name))).toBe(true);
    }
    for (const bad of ['custom-', 'custom--x', 'Custom-x', 'custom-x y', 'evil', 'custom_x', 'ollama-2']) {
      expect(CUSTOM_PROVIDER_ID_RE.test(bad)).toBe(false);
      expect(isCustomProviderId(bad)).toBe(false);
    }
    expect(isCustomProviderId('custom')).toBe(true);
    expect(isCustomProviderId('custom-hai-anthropic')).toBe(true);
    expect(isLocalProviderId('custom-hai-anthropic')).toBe(true);
    expect(isLocalProviderId('ollama')).toBe(true);
    expect(isLocalProviderId('anthropic')).toBe(false);
  });

  it('reuses a disconnected endpoint with the same slug and steps past live ones', () => {
    const live = new Set(['custom-one', 'custom-one-2']);
    const isLive = (id: string) => live.has(id);
    expect(resolveCustomProviderId('One', isLive)).toBe('custom-one-3');
    expect(resolveCustomProviderId('Two', isLive)).toBe('custom-two');
    // Disconnected entries are not live, so the id (and its retained overrides)
    // is the one a re-add lands on.
    expect(resolveCustomProviderId('Two', () => false)).toBe('custom-two');
  });
});
