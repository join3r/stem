import type { ChatMessage, ModelSummary, TurnUsage } from '../../shared/types';

// Compact token count: 30118 → "30k", 1339 → "1.3k", 980 → "980". Keeps the meter
// glanceable; the tooltip carries the exact figures.
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

// Exact figure with thousands separators for the tooltip, e.g. 30,118.
function formatExact(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Context-fill meter shown in the composer controls row. Numerator is the latest assistant
 * turn's `totalTokens` (pi's own "context fill" measure); denominator is the SELECTED
 * model's context window (what the next turn will use). Renders nothing until both exist —
 * a fresh chat, or a model that doesn't report a window. Tooltip carries the exact split
 * plus the cumulative session cost summed over every assistant turn.
 */
export function ContextMeter({
  messages,
  model
}: {
  messages: ChatMessage[];
  model: ModelSummary | null;
}) {
  const max = model?.contextWindow;
  // Latest assistant message that carries usage drives the gauge.
  let latest: TurnUsage | undefined;
  let sessionCost = 0;
  let hasCost = false;
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.usage) continue;
    latest = m.usage;
    if (m.usage.cost != null) {
      sessionCost += m.usage.cost;
      hasCost = true;
    }
  }
  if (!latest || !max) return null;

  const used = latest.totalTokens;
  const ratio = Math.min(1, Math.max(0, used / max));
  const pct = Math.round(ratio * 100);
  const level = ratio >= 0.9 ? 'danger' : ratio >= 0.75 ? 'warn' : '';

  const tooltip = [
    `Context: ${formatExact(used)} / ${formatExact(max)} (${pct}%)`,
    `input ${formatTokens(latest.input)} · output ${formatTokens(latest.output)} · cache ${formatTokens(
      latest.cacheRead
    )}`,
    hasCost ? `session cost: $${sessionCost.toFixed(2)}` : null
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className={`context-meter${level ? ` ${level}` : ''}`} title={tooltip}>
      <span className="context-meter-bar">
        <span className="context-meter-fill" style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="context-meter-text">
        {formatTokens(used)} / {formatTokens(max)}
      </span>
    </div>
  );
}
