import { useEffect, useState } from 'react';
import type { PlanUsage, PlanUsageWindow } from '../../../../shared/types';
import { ValueRow } from './rows';

/**
 * The ChatGPT subscription's usage windows (5-hour and weekly) on the
 * provider tile and its page. Read from the server, which holds the token.
 * Anything it can't read leaves the tile as it was and says why on the page.
 */
export function usePlanUsage(enabled: boolean): PlanUsage | null {
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      return;
    }
    let live = true;
    void window.stem
      .chatgptPlanUsage()
      .then((u) => live && setUsage(u))
      // quiet: an older server has no such channel; the tile keeps its caption.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled]);
  return usage;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

/** "5-hour", "Weekly", or the length ChatGPT gave when it is neither. */
export function windowName(w: PlanUsageWindow, index: number): { long: string; short: string } {
  const s = w.windowSeconds;
  // Without a length, ChatGPT's order is the guide: primary is 5-hour, secondary weekly.
  if (s === null) return index === 0 ? { long: '5-hour', short: '5h' } : { long: 'Weekly', short: 'week' };
  if (s === 7 * DAY) return { long: 'Weekly', short: 'week' };
  if (s % DAY === 0) return { long: `${s / DAY}-day`, short: `${s / DAY}d` };
  const h = Math.round(s / HOUR);
  return { long: `${h}-hour`, short: `${h}h` };
}

export function percentLeft(w: PlanUsageWindow): number {
  return Math.max(0, Math.round(100 - w.usedPercent));
}

/** The tile's caption: "5h 62% · week 80% left". */
export function planUsageSummary(usage: PlanUsage | null): string | null {
  if (!usage?.ok) return null;
  return `${usage.windows.map((w, i) => `${windowName(w, i).short} ${percentLeft(w)}%`).join(' · ')} left`;
}

function resetText(at: number | null, now = Date.now()): string | undefined {
  if (at === null) return undefined;
  if (at <= now) return 'Resets now';
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at - now < DAY && d.getDate() === new Date(now).getDate()) return `Resets at ${time}`;
  return `Resets ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** One row per window: a bar of what is left, the percentage, and when it resets. */
export function PlanUsageRows({ usage }: { usage: PlanUsage | null }) {
  if (!usage) return <ValueRow label="Plan usage" hint="Reading…" />;
  if (!usage.ok) return <ValueRow label="Plan usage" hint={usage.reason} />;
  return (
    <>
      {usage.windows.map((w, i) => {
        const left = percentLeft(w);
        const tone = left <= 10 ? ' danger' : left <= 25 ? ' warn' : '';
        return (
          <ValueRow key={i} label={`${windowName(w, i).long} limit`} hint={resetText(w.resetsAt)}>
            <span className={`plan-usage${tone}`}>
              <span className="plan-usage-bar">
                <span className="plan-usage-fill" style={{ width: `${left}%` }} />
              </span>
              <span className="plan-usage-text">{left}% left</span>
            </span>
          </ValueRow>
        );
      })}
    </>
  );
}
