import { useEffect, useState } from 'react';
import { History, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import type {
  DefaultsSettings,
  ModelSummary,
  SkillsMode,
  SkillSummary,
  SkillVersionSummary
} from '../../../shared/types';
import { useOffline } from '../../hooks/useServerReachable';
import { InfoTip } from '../../ui/InfoTip';
import { appDefaultModel, resolveSkillsModel } from '../../../shared/modelRoles';
import { ModelPicker } from '../../ui/ModelPicker';
import { createJobStore, holdFullSpin, useJob } from './shared';
import { plainLine } from '../../../shared/plain-text';

// Module-level so a running tidy pass survives the tab unmounting: leave for
// another tab mid-run and come back, and the button is still spinning — and the
// outcome message still lands — instead of the pass silently vanishing.
const tidyJob = createJobStore();

export function SkillsTab({ models }: { models: ModelSummary[] }) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  // Skills live on the server. With it unreachable this list is empty because we
  // could not ask, which is not the same thing as having none — and "No skills
  // yet" is a sentence that would quietly tell someone their skills are gone.
  const offline = useOffline();
  const { running: tidying, msg: tidyMsg } = useJob(tidyJob);
  // null => skills work follows the model you chat with (see Settings → Models).
  const [skillsModel, setSkillsModel] = useState<string | null>(null);
  const [mode, setMode] = useState<SkillsMode>('auto');
  // Select a row, then act on it from the gutter below the list — the same
  // vocabulary as the MCP servers tab one segment to the left. The row itself
  // carries no delete button: it is already carrying a name, an origin label, a
  // usage line, a description and a switch, in a panel narrow enough that the
  // description clips, and a permanent icon costs that space on every row to
  // serve an action taken once in a skill's life.
  const [selected, setSelected] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Earlier versions of the selected skill (server/skills/store.ts keeps the
  // text each change replaced). Loaded only when the history is opened.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<SkillVersionSummary[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  // What "Same as main" resolves to — the model you chat with.
  const [defaults, setDefaults] = useState<DefaultsSettings>({
    model: null,
    backgroundModel: null,
    backgroundEffort: null
  });
  useEffect(() => {
    window.stem.getSettings().then((s) => {
      setSkillsModel(s.skills.model);
      setMode(s.skills.mode);
      setDefaults(s.defaults);
    });
    // Refresh when the assistant auto-creates/patches a skill or the curator runs.
    return window.stem.onSkillsChanged(() => {
      window.stem.listSkills().then(setSkills);
    });
  }, []);
  // The list load rides the tidy flag rather than mount alone: a pass that ends
  // while this tab is away has no component to hand its result to, so re-read
  // when the flag drops. (Runs on mount too, whatever the flag says — that is
  // the initial load.)
  useEffect(() => {
    window.stem.listSkills().then(setSkills);
  }, [tidying]);

  const selectedSkill = skills.find((s) => s.slug === selected) ?? null;
  // Reload when the selection changes, or when the skill itself changed (a new
  // version means one more earlier version to show).
  useEffect(() => {
    if (!historyOpen || !selected) {
      setVersions([]);
      setPicked(null);
      return;
    }
    let live = true;
    window.stem.listSkillVersions(selected).then((list) => {
      if (!live) return;
      setVersions(list);
      setPicked(list[0]?.version ?? null);
    }).catch(() => {
      // quiet: an empty list reads as "no earlier versions", and Restore stays off.
      if (live) setVersions([]);
    });
    return () => {
      live = false;
    };
  }, [historyOpen, selected, selectedSkill?.version]);

  async function restore(slug: string, version: number) {
    const name = skills.find((s) => s.slug === slug)?.name ?? slug;
    if (!window.confirm(`Put version ${version} of “${name}” back?\n\nThe current text is kept as an earlier version, so you can undo this.`)) return;
    setRemoveError(null);
    try {
      setSkills(await window.stem.restoreSkillVersion(slug, version));
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Could not restore that version.');
    }
  }

  function selectSkillsModel(id: string | null) {
    setSkillsModel(id);
    window.stem.updateSkillsSettings({ model: id }).then((s) => setSkillsModel(s.skills.model));
  }

  function selectMode(next: SkillsMode) {
    setMode(next);
    window.stem.updateSkillsSettings({ mode: next }).then((s) => setMode(s.skills.mode));
  }

  async function toggle(slug: string, enabled: boolean) {
    setSkills(await window.stem.setSkillEnabled(slug, enabled));
  }

  async function remove(slug: string) {
    const name = skills.find((s) => s.slug === slug)?.name ?? slug;
    // The system's own dialog, as in Files. An earlier attempt asked in the row
    // itself and it was the wrong shape twice over: the question appeared under
    // the row that raised it, so the list moved under the pointer on the way to
    // answering it, and both answers were link-sized text in a list of switches.
    if (
      !window.confirm(
        `Delete the skill “${name}”?\n\nIt is removed from disk and Stem stops using it. To stop it being used without deleting it, switch it off instead.`
      )
    ) {
      return;
    }
    setRemoveError(null);
    try {
      setSkills(await window.stem.removeSkill(slug));
      setSelected(null);
    } catch (error) {
      // The skills folder is on the server, so this can fail for reasons nobody
      // in front of the app can see — say so rather than leaving the row sitting
      // there looking ignored.
      setRemoveError(error instanceof Error ? error.message : 'Could not delete that skill.');
    }
  }

  function tidy() {
    tidyJob.start(async () => {
      try {
        const r = await holdFullSpin(window.stem.curateSkills());
        // A pass that merged nothing and one that merged three both end with the
        // list simply redrawn, so say which happened — otherwise the only way to
        // tell is to have memorised the library beforehand.
        // "90 days" is ARCHIVE_AFTER_DAYS in server/skills/lifecycle.ts, spelled out
        // here rather than plumbed through IPC: it is a sentence, not a setting.
        const retired = r.expired ? `, retired ${r.expired} unused >90 days` : '';
        const split = r.split ?? 0;
        const splitText = split ? `Split ${split} into one skill per job, ` : '';
        return split + r.merged + r.archived + r.expired === 0
          ? 'No duplicate, mixed or stale skills found'
          : `${splitText}${split ? 'merged' : 'Merged'} ${r.merged}, archived ${r.archived}${retired} — archived skills stay on disk and can be switched back on above.`;
      } catch {
        return 'Tidy up failed — try again.';
      }
    });
  }

  // There is no "Collect now" button: nothing accumulates to collect. Skills are
  // written at the end of the turn that earned them, so the only manual action
  // left here is the curator's "Tidy up".
  const hasAgentSkills = skills.some((s) => s.source === 'agent');

  // "Jun 12", with the year added once it isn't this year's date.
  function formatDay(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  // `fastmail.draft_email` → "fastmail · draft_email", `busycal.*` → "any busycal tool".
  function toolLabel(tool: string): string {
    if (tool.endsWith('.*')) return `any ${tool.slice(0, -2)} tool`;
    const dot = tool.indexOf('.');
    return dot > 0 ? `${tool.slice(0, dot)} · ${tool.slice(dot + 1)}` : tool;
  }

  function usageLabel(s: SkillSummary): string {
    const used = s.useCount
      ? `used ${s.useCount}×${s.lastUsedAt ? ` · last ${formatDay(s.lastUsedAt)}` : ''}`
      : 'never used';
    // How the uses ended, read off the next message (server/skills/cases.ts):
    // the verdict on the skill rather than a count of it being around. Before
    // any use has an outcome, the model's own reports are all there is.
    if (s.outcomes) return `${used} · ${s.outcomes.accepted} accepted · ${s.outcomes.failed} needed a fix`;
    return s.failCount ? `${used} · reported wrong ${s.failCount}×` : used;
  }

  return (
    <div>
      <div className="grp-head with-actions">
        Skills
        <span className="memory-view-actions">
          {hasAgentSkills && (
            <button
              className="link-btn icon-only"
              onClick={tidy}
              disabled={tidying}
              data-label={tidying ? 'Tidying…' : 'Tidy up'}
              aria-label="Tidy up: merge duplicates and archive stale auto-created skills"
            >
              <Wand2 size={15} className={tidying ? 'spin' : undefined} />
            </button>
          )}
        </span>
      </div>
      {tidyMsg && <p className="muted">{tidyMsg}</p>}
      {skills.length === 0 && offline ? (
        <p className="muted">Your skills live on Stem’s server, which can’t be reached right now.</p>
      ) : skills.length === 0 ? (
        <p className="muted">No skills yet. Stem saves reusable procedures it works out, or you can drop a SKILL.md folder into the skills directory.</p>
      ) : (
        <div className="group">
          {skills.map((s) => (
            <div
              key={s.slug}
              className={`group-row skill-row${selected === s.slug ? ' selected' : ''}`}
              onClick={() => {
                setRemoveError(null);
                setSelected(selected === s.slug ? null : s.slug);
              }}
            >
              <span className="row-main">
                <strong>
                  {s.name}
                  {s.source === 'agent' && (
                    <span
                      className="muted"
                      style={{ marginLeft: 6, fontWeight: 400, fontSize: '0.8em' }}
                      title={s.change ? plainLine(s.change) : undefined}
                    >
                      auto{s.version && s.version > 1 ? ` · v${s.version}` : ''}
                    </span>
                  )}
                  <span
                    className="muted"
                    style={{ marginLeft: 6, fontWeight: 400, fontSize: '0.8em' }}
                    title={s.lastFailure ? `Last report: ${plainLine(s.lastFailure.reason)}` : undefined}
                  >
                    {usageLabel(s)}
                  </span>
                </strong>
                <em>{plainLine(s.description)}</em>
                {/* Why this skill can show up even when the request is worded nothing like it. */}
                {s.tools?.length ? <em>Read before {s.tools.map(toolLabel).join(', ')}</em> : null}
              </span>
              <button
                className={`switch${s.enabled ? ' on' : ''}`}
                role="switch"
                aria-checked={s.enabled}
                aria-label={s.name}
                title={s.enabled ? 'Stop Stem using this skill' : 'Let Stem use this skill again'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(s.slug, !s.enabled);
                }}
              />
            </div>
          ))}
        </div>
      )}
      {skills.length > 0 && (
        <div className="gutter">
          <button
            title={selected ? 'Delete the selected skill' : 'Select a skill to delete it'}
            aria-label="Delete the selected skill"
            onClick={() => selected && remove(selected)}
            disabled={!selected}
          >
            <Trash2 size={15} />
          </button>
          <button
            title={
              !selectedSkill
                ? 'Select a skill to see its earlier versions'
                : selectedSkill.versions
                  ? 'Earlier versions of the selected skill'
                  : 'This skill has no earlier versions'
            }
            aria-label="Earlier versions of the selected skill"
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen(!historyOpen)}
            disabled={!selectedSkill?.versions}
          >
            <History size={15} />
          </button>
        </div>
      )}
      {historyOpen && selectedSkill && versions.length > 0 && (
        <div className="formgroup">
          <p className="muted">
            Now v{selectedSkill.version ?? 1}
            {selectedSkill.change ? ` — ${plainLine(selectedSkill.change)}` : ''}
          </p>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              className="vfield"
              aria-label="Earlier version"
              value={picked ?? ''}
              onChange={(e) => setPicked(Number(e.target.value))}
              style={{ flex: 1, minWidth: 0 }}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                  {v.updated ? ` · ${formatDay(v.updated)}` : ''}
                  {v.change ? ` · ${plainLine(v.change)}` : ''}
                </option>
              ))}
            </select>
            <button
              className="link-btn icon-only"
              data-label="Restore"
              aria-label="Restore this version"
              title="Restore this version"
              disabled={picked === null}
              onClick={() => picked !== null && restore(selectedSkill.slug, picked)}
            >
              <RotateCcw size={15} />
            </button>
          </div>
        </div>
      )}
      {removeError && <p className="error">{removeError}</p>}

      <div className="grp-head grp-head-row">
        Saving skills
        <InfoTip label="About saving skills">
          <strong>Only when I ask</strong> — Stem never saves a skill on its own. It can still
          suggest one in its reply, and it saves it if you say yes. <strong>Ask first</strong> —
          Stem proposes a skill and you approve it in a card. <strong>Save automatically</strong> —
          Stem saves what it learns and tells you here.
        </InfoTip>
      </div>
      <div className="formgroup">
        <div className="seg-ctl">
          <button className={mode === 'off' ? 'active' : ''} onClick={() => selectMode('off')}>
            Only when I ask
          </button>
          <button className={mode === 'ask' ? 'active' : ''} onClick={() => selectMode('ask')}>
            Ask first
          </button>
          <button className={mode === 'auto' ? 'active' : ''} onClick={() => selectMode('auto')}>
            Save automatically
          </button>
        </div>
        {/* The part people read the wrong way round: all three values constrain
            Stem's own initiative, never a request the user made out loud. */}
        <p className="muted">
          Asking Stem to save a skill always works, whichever of these you pick — the setting only
          limits what Stem does unprompted.
        </p>
      </div>

      <div className="grp-head grp-head-row">
        Skills model
        <InfoTip label="About the skills model">
          Does all the model-driven skills work: writes a new skill (or improves an existing one)
          after a turn that earned it, handles /learn, and runs the tidy-up pass that merges
          duplicates. Writing a skill is judgment work, so left unset it follows the model you chat
          with — never the cheap Quick tasks model. Retiring skills unused for 90 days is a plain
          clock and uses no model.
        </InfoTip>
      </div>
      <div className="formgroup">
        <ModelPicker
          models={models}
          value={skillsModel}
          onChange={selectSkillsModel}
          emptyLabel="Same as main"
          ariaLabel="Skills model"
          resolvedDefault={resolveSkillsModel(null, defaults.model ?? appDefaultModel(models))}
        />
      </div>
    </div>
  );
}
