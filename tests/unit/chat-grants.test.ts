// Who gets coding_agent / computer / browser in a turn (harness/chat-grants.ts): a
// persona's pin is the whole story for a persona turn; only a chat run as no
// persona follows Settings → Features, and every refusal names its reason so
// Stem can explain it to the user.
import { describe, expect, it } from 'vitest';
import { resolveBrowserGrant, resolveCodingGrant, resolveComputerGrant } from '../../src/server/harness/chat-grants';

const OFF = { allow: false, target: null };

describe('resolveCodingGrant', () => {
  const pin = { agent: 'claude', cwd: '/repo' };

  it('a code persona gets its pin, whatever Settings says', () => {
    expect(resolveCodingGrant({ persona: { harness: pin }, unattended: true }, OFF)).toEqual({
      ok: true,
      grant: { kind: 'pin', pin }
    });
  });

  it('a persona without a coding setup is refused even with chats allowed, and the refusal names it', () => {
    const r = resolveCodingGrant(
      { persona: { name: 'Secretary' }, unattended: false },
      { allow: true, target: { agent: 'claude' } }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toContain('“Secretary”');
      expect(r.refusal).toContain('no coding setup');
      expect(r.refusal).toContain('Settings → Features');
    }
  });

  it('a plain chat follows the switch: off says where to turn it on; on passes the target (null = model chooses)', () => {
    const off = resolveCodingGrant({ unattended: false }, OFF);
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.refusal).toContain('Allow in chats');
    expect(resolveCodingGrant({ unattended: false }, { allow: true, target: null })).toEqual({
      ok: true,
      grant: { kind: 'chat', target: null }
    });
    expect(
      resolveCodingGrant({ unattended: false }, { allow: true, target: { agent: 'codex', device: 'dev-1' } })
    ).toEqual({ ok: true, grant: { kind: 'chat', target: { agent: 'codex', device: 'dev-1' } } });
  });

  it('a scheduled run with no persona never gets one from the chat switch', () => {
    const r = resolveCodingGrant({ unattended: true }, { allow: true, target: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toContain('scheduled');
  });
});

describe('resolveComputerGrant', () => {
  it('a pinned persona gets its Mac; a blank pin is no pin', () => {
    expect(resolveComputerGrant({ persona: { computer: { device: 'mac-1' } }, unattended: true }, OFF)).toEqual({
      ok: true,
      grant: { kind: 'pin', device: 'mac-1' }
    });
    const blank = resolveComputerGrant({ persona: { name: 'X', computer: { device: '  ' } }, unattended: false }, OFF);
    expect(blank.ok).toBe(false);
  });

  it('an unpinned persona is refused with its name and the no-workaround rule', () => {
    const r = resolveComputerGrant(
      { persona: { name: 'Secretary' }, unattended: false },
      { allow: true, target: { device: 'mac-1' } }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toContain('“Secretary”');
      expect(r.refusal).toContain('run_command');
    }
  });

  it('a plain chat: off refuses, on gives the fixed Mac or null for the model to choose', () => {
    expect(resolveComputerGrant({ unattended: false }, OFF).ok).toBe(false);
    expect(resolveComputerGrant({ unattended: false }, { allow: true, target: { device: 'mac-1' } })).toEqual({
      ok: true,
      grant: { kind: 'chat', device: 'mac-1' }
    });
    expect(resolveComputerGrant({ unattended: false }, { allow: true, target: null })).toEqual({
      ok: true,
      grant: { kind: 'chat', device: null }
    });
    expect(resolveComputerGrant({ unattended: true }, { allow: true, target: null }).ok).toBe(false);
  });
});

describe('resolveBrowserGrant', () => {
  it('the browser pin is its own: a computer pin does not grant the browser, nor the reverse', () => {
    expect(resolveBrowserGrant({ persona: { browser: { device: 'mac-1' } }, unattended: true }, OFF)).toEqual({
      ok: true,
      grant: { kind: 'pin', device: 'mac-1' }
    });
    const computerOnly = resolveBrowserGrant(
      { persona: { name: 'MacControl', computer: { device: 'mac-1' } }, unattended: false },
      OFF
    );
    expect(computerOnly.ok).toBe(false);
    if (!computerOnly.ok) {
      expect(computerOnly.refusal).toContain('“MacControl”');
      expect(computerOnly.refusal).toContain('Browser this persona controls');
      expect(computerOnly.refusal).toContain('computer tool');
    }
    expect(resolveComputerGrant({ persona: { browser: { device: 'mac-1' } }, unattended: false }, OFF).ok).toBe(false);
  });

  it('a plain chat follows chatFeatures.browser; an older server without it means off', () => {
    const off = resolveBrowserGrant({ unattended: false }, undefined);
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.refusal).toContain('Settings → Features → Browser control');
    expect(resolveBrowserGrant({ unattended: false }, { allow: true, target: null })).toEqual({
      ok: true,
      grant: { kind: 'chat', device: null }
    });
    expect(resolveBrowserGrant({ unattended: true }, { allow: true, target: null }).ok).toBe(false);
  });
});
