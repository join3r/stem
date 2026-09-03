import { describe, expect, it } from 'vitest';
import { describeConnection } from '../src/ui/connection';
import { relativeTime } from '../src/ui/time';

const status = (patch: Partial<Parameters<typeof describeConnection>[0]> = {}): Parameters<typeof describeConnection>[0] => ({
  paired: true,
  reachable: true,
  streaming: true,
  unauthorized: false,
  reconnecting: false,
  ...patch
});

describe('describeConnection', () => {
  it('reads the four flags in the order that matters to a person', () => {
    expect(describeConnection(status({ paired: false, reachable: true, streaming: true }))).toEqual({
      label: 'Not paired',
      tone: 'dim'
    });
    expect(describeConnection(status({ unauthorized: true, streaming: false }))).toEqual({
      label: 'Pairing rejected',
      tone: 'bad'
    });
    expect(describeConnection(status())).toEqual({ label: 'Live', tone: 'live' });
    expect(describeConnection(status({ streaming: false }))).toEqual({ label: 'Connecting', tone: 'warn' });
    expect(describeConnection(status({ streaming: false, reachable: false }))).toEqual({ label: 'Offline', tone: 'bad' });
  });

  it('puts a dead pairing ahead of being offline: waiting will not fix it', () => {
    expect(describeConnection(status({ reachable: false, streaming: false, unauthorized: true })).label).toBe(
      'Pairing rejected'
    );
  });
});

describe('relativeTime', () => {
  const now = Date.UTC(2026, 7, 14, 12, 0, 0);
  const secondsAgo = (n: number): number => Math.floor(now / 1000) - n;

  it('shortens with age', () => {
    expect(relativeTime(secondsAgo(5), now)).toBe('now');
    expect(relativeTime(secondsAgo(300), now)).toBe('5m');
    expect(relativeTime(secondsAgo(3 * 3600), now)).toBe('3h');
    expect(relativeTime(secondsAgo(3 * 86_400), now)).toMatch(/^[A-Z][a-z]{2}$/);
    expect(relativeTime(secondsAgo(30 * 86_400), now)).toMatch(/^\d+\/\d+$/);
  });

  it('does not render a future timestamp as the future', () => {
    // Server and phone clocks disagree by a second or two all the time.
    expect(relativeTime(secondsAgo(-4), now)).toBe('now');
  });
});

// The dim state between Live and Offline — see the grace in
// ../src/transport/connection.ts. It exists so the first second after an unlock
// is not painted as an outage.
describe('describeConnection while reconnecting', () => {
  it('is dim, and says whether the server has ever answered', () => {
    expect(describeConnection(status({ streaming: false, reconnecting: true }))).toEqual({
      label: 'Reconnecting',
      tone: 'dim'
    });
    expect(describeConnection(status({ streaming: false, reconnecting: true, reachable: false }))).toEqual({
      label: 'Connecting',
      tone: 'dim'
    });
  });

  it('is outranked by a live stream and by a dead pairing', () => {
    expect(describeConnection(status({ reconnecting: true })).label).toBe('Live');
    expect(describeConnection(status({ streaming: false, reconnecting: true, unauthorized: true })).label).toBe(
      'Pairing rejected'
    );
  });
});
