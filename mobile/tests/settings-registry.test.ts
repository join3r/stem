import { describe, expect, it } from 'vitest';
import { SETTINGS_GROUPS, mobileGroups } from '../src/settings/registry';

describe('mobileGroups', () => {
  it('keeps every setting that did not opt out — available-on-phone is the default', () => {
    const offered = new Set(mobileGroups().flatMap((g) => g.settings.map((s) => s.key)));
    for (const group of SETTINGS_GROUPS) {
      for (const setting of group.settings) {
        expect(offered.has(setting.key)).toBe(setting.mobile !== false);
      }
    }
  });

  it('drops desk-only settings, and any group they leave empty', () => {
    const titles = mobileGroups().map((g) => g.title);
    // Escape is a key the phone does not have; Quick Chat is the desktop overlay.
    expect(titles).not.toContain('Keyboard');
    expect(titles).not.toContain('Quick Chat');
    expect(mobileGroups().flatMap((g) => g.settings).some((s) => s.mobile === false)).toBe(false);
  });

  it('offers the server settings a phone can meaningfully change', () => {
    const offered = new Set(mobileGroups().flatMap((g) => g.settings.map((s) => s.key)));
    for (const key of ['web-search', 'subjects', 'tasks-notify', 'exec-enabled', 'exec-approval']) {
      expect(offered.has(key)).toBe(true);
    }
  });

  it('gives every setting a unique key, because the list is a list of rows', () => {
    const keys = SETTINGS_GROUPS.flatMap((g) => g.settings.map((s) => s.key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
