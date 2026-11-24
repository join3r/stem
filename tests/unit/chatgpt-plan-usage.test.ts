import { describe, expect, it, vi } from 'vitest';
import { PLAN_USAGE_URL, planUsage } from '../../src/server/voice/realtime';
import { planUsageSummary, windowName } from '../../src/renderer/manage/tabs/settings/PlanUsage';

const TOKEN = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })).toString('base64url')}.s`;
const NOW = 1_800_000_000_000;

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

// The shape ChatGPT's wham/usage answers with (as the Codex CLI reads it).
const BODY = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 38, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: 1_800_003_600 },
    secondary_window: { used_percent: 20.4, limit_window_seconds: 604800, reset_after_seconds: 86400 }
  }
};

describe('ChatGPT plan usage', () => {
  it('reads both windows with what is spent and when they reset', async () => {
    const fetchImpl = respond(200, BODY);
    const u = await planUsage(TOKEN, fetchImpl, NOW);
    expect(fetchImpl).toHaveBeenCalledWith(PLAN_USAGE_URL, expect.anything());
    expect(u).toEqual({
      ok: true,
      plan: 'plus',
      limitReached: false,
      windows: [
        { windowSeconds: 18000, usedPercent: 38, resetsAt: 1_800_003_600_000 },
        { windowSeconds: 604800, usedPercent: 20.4, resetsAt: NOW + 86_400_000 }
      ]
    });
    expect(planUsageSummary(u)).toBe('5h 62% · week 80% left');
  });

  it('names windows by length, falling back to their order', () => {
    expect(windowName({ windowSeconds: 18000, usedPercent: 0, resetsAt: null }, 0).long).toBe('5-hour');
    expect(windowName({ windowSeconds: 604800, usedPercent: 0, resetsAt: null }, 1).long).toBe('Weekly');
    expect(windowName({ windowSeconds: null, usedPercent: 0, resetsAt: null }, 1).long).toBe('Weekly');
  });

  it('keeps a lone window and clamps the percentage', async () => {
    const u = await planUsage(TOKEN, respond(200, { rate_limit: { limit_reached: true, primary_window: { used_percent: 130 } } }), NOW);
    expect(u).toMatchObject({ ok: true, limitReached: true, windows: [{ usedPercent: 100, windowSeconds: null, resetsAt: null }] });
    expect(planUsageSummary(u)).toBe('5h 0% left');
  });

  it('says why when the usage cannot be read', async () => {
    expect(await planUsage(TOKEN, respond(401, 'no'))).toMatchObject({ ok: false, reason: expect.stringContaining('401') });
    expect((await planUsage(TOKEN, respond(200, { credits: {} }))).ok).toBe(false);
    expect((await planUsage(TOKEN, respond(200, { rate_limit: { primary_window: {} } }))).ok).toBe(false);
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await planUsage(TOKEN, offline)).toMatchObject({ ok: false, reason: expect.stringContaining('fetch failed') });
    expect(planUsageSummary({ ok: false, reason: 'x' })).toBeNull();
  });
});
