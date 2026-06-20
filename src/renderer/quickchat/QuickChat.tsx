import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { ModelSummary, QuickChatSettings } from '../../shared/types';

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High'
};

// The Spotlight-style overlay rendered in its own frameless window. It captures
// a single prompt with ad-hoc model/effort/speed (seeded from the saved
// defaults), then hands it to the main window to run as a fresh conversation.
export function QuickChat() {
  const [input, setInput] = useState('');
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [serviceTier, setServiceTier] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedModel = models.find((m) => m.id === modelId) ?? null;

  useEffect(() => {
    window.stem
      .listModels()
      .then(setModels)
      .catch(() => {});
  }, []);

  // Seed model/effort/speed from the saved Quick Chat defaults. The default
  // model falls back to codex's default (`isDefault`) when unset; effort/speed
  // come straight from settings.
  const applyDefaults = useCallback(
    (qc: QuickChatSettings, list: ModelSummary[]) => {
      const fallback = list.find((m) => m.isDefault) ?? list[0] ?? null;
      const wanted = qc.defaultModel && list.some((m) => m.id === qc.defaultModel) ? qc.defaultModel : fallback?.id ?? null;
      setModelId(wanted);
      setEffort(qc.defaultEffort);
      setServiceTier(qc.defaultServiceTier);
    },
    []
  );

  useEffect(() => {
    if (!models.length) return;
    window.stem.getSettings().then((s) => applyDefaults(s.quickChat, models));
  }, [models, applyDefaults]);

  // Each time the overlay is summoned: clear the draft, reset to the saved
  // defaults, and refocus the field.
  useEffect(() => {
    return window.stem.onQuickChatFocus(() => {
      setInput('');
      window.stem.getSettings().then((s) => applyDefaults(s.quickChat, models));
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, [models, applyDefaults]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Switching models clamps effort to what it supports and drops a Fast pick the
  // new model can't honor (mirrors App.onSelectModel).
  function onSelectModel(id: string) {
    const m = models.find((x) => x.id === id);
    setModelId(id);
    if (m) {
      setEffort((e) => (e && m.supportedEfforts.includes(e) ? e : m.defaultEffort));
      if (!m.serviceTiers.some((t) => t.id === 'priority')) setServiceTier(null);
    }
  }

  const efforts = selectedModel && selectedModel.supportedEfforts.length ? selectedModel.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
  const hasFast = selectedModel ? selectedModel.serviceTiers.some((t) => t.id === 'priority') : true;

  function submit() {
    const text = input.trim();
    if (!text) return;
    window.stem.submitQuickChat({ input: text, model: modelId, effort, serviceTier });
    setInput('');
  }

  return (
    <div className="qc-root">
      <div className="qc-card">
        <div className="qc-row">
          <Sparkles className="qc-mark" size={22} />
          <input
            ref={inputRef}
            className="qc-input"
            value={input}
            placeholder="Ask Stem anything…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                window.stem.hideQuickChat();
              }
            }}
          />
          <span className="qc-esc">esc</span>
        </div>
        <div className="qc-foot">
          {models.length > 0 && (
            <select
              className="qc-model"
              value={modelId ?? ''}
              onChange={(e) => onSelectModel(e.target.value)}
              aria-label="Model"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          )}
          <div className="seg-ctl compact" role="group" aria-label="Reasoning effort">
            {efforts.map((e) => (
              <button key={e} type="button" className={effort === e ? 'active' : ''} onClick={() => setEffort(e)}>
                {EFFORT_LABELS[e] ?? e}
              </button>
            ))}
          </div>
          {hasFast && (
            <div className="seg-ctl compact" role="group" aria-label="Speed">
              <button type="button" className={serviceTier === 'priority' ? '' : 'active'} onClick={() => setServiceTier(null)}>
                Standard
              </button>
              <button
                type="button"
                className={serviceTier === 'priority' ? 'active' : ''}
                onClick={() => setServiceTier('priority')}
                title="1.5× speed, increased usage"
              >
                Fast
              </button>
            </div>
          )}
          <span className="qc-spacer" />
          <span className="qc-hint">
            <kbd>⏎</kbd> send
          </span>
        </div>
      </div>
    </div>
  );
}
