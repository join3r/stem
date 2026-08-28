import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ModelSummary } from '../../shared/types';
import { EFFORT_LABELS } from '../modelLabels';
import { effectiveEffort } from './EffortSelect';
import { ModelPicker } from './ModelPicker';

/**
 * The composer's effort + model control: a slider whose stops are the model's
 * reasoning levels, next to a label reading "High · Claude Opus". Clicking the
 * label opens the same searchable model picker Settings uses — this is how the
 * model is changed mid-chat, replacing the trip to Settings.
 *
 * One control where there were two: it replaced a segmented button per level
 * (up to five) that said nothing about which model would do the thinking.
 *
 * For a model with no reasoning levels the slider disappears and the label
 * carries the model name alone — the picker is then the whole control.
 */
export function EffortModelControl({
  models,
  model,
  effort,
  disabled,
  onChangeEffort,
  onSelectModel,
  sliderTitle,
  children
}: {
  models: ModelSummary[];
  model: ModelSummary | null;
  effort: string | null;
  disabled?: boolean;
  onChangeEffort: (effort: string) => void;
  onSelectModel: (id: string) => void;
  /** Tooltip for the slider (the composer hangs its ⌘E hint here). */
  sliderTitle?: string;
  /** Extra chrome rendered inside the pill (the composer's ShortcutHint). */
  children?: ReactNode;
}) {
  // Quick Chat renders this before its model catalog loads — fall back to the
  // common levels so the control doesn't blink in after the fetch.
  const efforts = model ? model.supportedEfforts : ['low', 'medium', 'high'];
  // What the backend will actually do when asked for `effort` — pi clamps to
  // the nearest level the model has, so the thumb sits where the turn will run.
  // With nothing chosen yet, the turn runs at the model's own default.
  const shown =
    effectiveEffort(efforts, effort) ??
    (model?.defaultEffort && efforts.includes(model.defaultEffort) ? model.defaultEffort : null) ??
    (efforts.length ? efforts[efforts.length - 1] : null);
  const idx = shown ? efforts.indexOf(shown) : -1;
  const fillPct = efforts.length > 1 && idx >= 0 ? (idx / (efforts.length - 1)) * 100 : 100;

  const effortText = shown ? EFFORT_LABELS[shown] ?? shown : null;

  return (
    <div className="eff-ctl" role="group" aria-label="Reasoning effort and model">
      {children}
      {efforts.length > 0 && (
        <div className="eff-slider" title={sliderTitle}>
          <div className="eff-rail" aria-hidden="true">
            <div className="eff-fill" style={{ width: `${fillPct}%` }} />
            <div className="eff-thumb" style={{ left: `calc(${fillPct}% - 4.5px)` }} />
          </div>
          {efforts.map((e, i) => (
            <button
              key={e}
              type="button"
              className={`eff-stop${i <= idx ? ' on' : ''}`}
              title={EFFORT_LABELS[e] ?? e}
              aria-label={`Effort: ${EFFORT_LABELS[e] ?? e}`}
              aria-pressed={e === shown}
              disabled={disabled}
              onClick={() => onChangeEffort(e)}
            >
              <i />
            </button>
          ))}
        </div>
      )}
      <ModelPicker
        models={models}
        value={model?.id ?? null}
        onChange={(id) => id && onSelectModel(id)}
        ariaLabel="Model for this chat"
        disabled={disabled}
        triggerClassName="eff-model"
        triggerTitle="Model for this chat — click to change"
        triggerContent={
          <>
            {effortText && <span className="eff-model-effort">{effortText}</span>}
            <span className="eff-model-name">
              {effortText && '· '}
              {model?.displayName ?? 'Model'}
            </span>
            <ChevronDown size={12} className="eff-model-chevron" />
          </>
        }
      />
    </div>
  );
}
