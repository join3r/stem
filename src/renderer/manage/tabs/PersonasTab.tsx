import { useEffect, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import type { ModelSummary, Persona } from '../../../shared/types';
import { ModelPicker } from '../../ui/ModelPicker';
import { clampEffort, effortsOf, EffortSelect } from '../../ui/EffortSelect';
import { EFFORT_LABELS } from '../../modelLabels';

// ---- Personas tab: the named agent configurations mail addresses ----
//
// A persona is a row the user expands and edits as a local draft: name and
// role prompt, an optional model/effort pin, and an optional coding-harness
// pin (which agent coding_agent drives for this persona, and in which
// directory — that cwd is the whole meaning of a "code — stem" persona).
// Nothing reaches the server until Save; Cancel throws the draft away. This
// is deliberately NOT the tasks tab's save-as-you-type pattern: a persona has
// cross-field validation (unique name, agent+cwd pairs) that made per-
// keystroke saves fight the user mid-word.
// Built-ins can be edited but not deleted; "duplicate" is how variants start.

/** "Fable · High · claude in ~/src/stem" — the collapsed face of a persona row. */
function summaryLabel(p: Persona, models: ModelSummary[]): string {
  const parts: string[] = [];
  if (p.model) {
    const m = models.find((x) => x.id === p.model);
    parts.push(m ? m.displayName : p.model.split('/').pop() ?? p.model);
    if (p.effort) parts.push(EFFORT_LABELS[p.effort] ?? p.effort);
  } else {
    parts.push('App default model');
  }
  if (p.harness) {
    parts.push(p.harness.cwd ? `${p.harness.agent} in ${p.harness.cwd}` : p.harness.agent);
  }
  return parts.join(' · ');
}

/** A name not already taken (case-insensitively): "code copy", "code copy 2", … */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Field-by-field equality over everything the editor can change. */
function sameEdit(a: Persona, b: Persona): boolean {
  return (
    a.name === b.name &&
    a.prompt === b.prompt &&
    a.model === b.model &&
    a.effort === b.effort &&
    (a.harness?.agent ?? '') === (b.harness?.agent ?? '') &&
    (a.harness?.cwd ?? '') === (b.harness?.cwd ?? '') &&
    (a.canAddPersonas ?? false) === (b.canAddPersonas ?? false)
  );
}

export function PersonasTab({ models }: { models: ModelSummary[] }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  // Unsaved edits, keyed by persona id. A draft whose id is not in `personas`
  // is a brand-new persona that exists nowhere but this screen until Save.
  const [drafts, setDrafts] = useState<Map<string, Persona>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.stem.listPersonas().then(setPersonas);
  }, []);

  const setDraft = (draft: Persona) =>
    setDrafts((cur) => new Map(cur).set(draft.id, draft));

  const dropDraft = (id: string) =>
    setDrafts((cur) => {
      const next = new Map(cur);
      next.delete(id);
      return next;
    });

  const setRowExpanded = (id: string, on: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Expand ↔ collapse. A dirty draft survives a collapse (marked "unsaved"). */
  function toggleExpanded(p: Persona) {
    const open = expanded.has(p.id);
    if (!open && !drafts.has(p.id)) setDraft({ ...p });
    if (open) {
      const draft = drafts.get(p.id);
      const stored = personas.find((x) => x.id === p.id);
      if (draft && stored && sameEdit(draft, stored)) dropDraft(p.id);
    }
    setRowExpanded(p.id, !open);
  }

  function save(draft: Persona) {
    setSavingId(draft.id);
    window.stem
      .savePersona(draft)
      .then((list) => {
        setPersonas(list);
        dropDraft(draft.id);
        setRowExpanded(draft.id, false);
        setError(null);
      })
      .catch((err: unknown) => {
        // A refused save (duplicate name, blank name) keeps the draft on
        // screen so the user can fix it — nothing was lost.
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSavingId(null));
  }

  /** Discard the draft; a never-saved persona disappears with it. */
  function cancel(id: string) {
    dropDraft(id);
    setRowExpanded(id, false);
  }

  /** New persona (blank, or a copy) — a draft only, on the server after Save. */
  function add(from?: Persona) {
    const taken = new Set([
      ...personas.map((p) => p.name.toLowerCase()),
      ...[...drafts.values()].map((p) => p.name.toLowerCase())
    ]);
    const draft: Persona = {
      ...from,
      id: crypto.randomUUID(),
      name: uniqueName(from ? `${from.name} copy` : 'New persona', taken),
      prompt: from?.prompt ?? ''
    };
    delete draft.builtin;
    setDraft(draft);
    setRowExpanded(draft.id, true);
  }

  function remove(persona: Persona) {
    dropDraft(persona.id);
    if (!personas.some((p) => p.id === persona.id)) return; // draft-only row
    setPersonas((cur) => cur.filter((p) => p.id !== persona.id));
    window.stem
      .deletePersona(persona.id)
      .then(setPersonas)
      .catch(async (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setPersonas(await window.stem.listPersonas());
      });
  }

  // Saved personas first, then never-saved drafts in creation order.
  const rows: Persona[] = [
    ...personas,
    ...[...drafts.values()].filter((d) => !personas.some((p) => p.id === d.id))
  ];

  return (
    <div>
      <div className="grp-head">Personas</div>
      <p className="muted">
        Named configurations you can address mail to: a role prompt, and optionally a pinned model
        and a coding agent with its own working directory. Duplicate one to make a variant — e.g. a
        “code — stem” persona is the coding pin pointed at the stem checkout.
      </p>
      {error && <p className="task-failed">{error}</p>}
      <div className="group">
        {rows.map((stored) => {
          const draft = drafts.get(stored.id);
          const saved = personas.find((x) => x.id === stored.id);
          const dirty = !!draft && (!saved || !sameEdit(draft, saved));
          const p = draft ?? stored;
          return (
            <div key={p.id} className="task-item">
              <div className="task-head">
                <span className="row-main">
                  <strong
                    className="task-title"
                    onClick={() => toggleExpanded(stored)}
                    title={expanded.has(p.id) ? 'Collapse' : 'Edit this persona'}
                  >
                    {p.name}
                  </strong>
                  <em>
                    {summaryLabel(p, models)}
                    {dirty && !expanded.has(p.id) ? ' · unsaved' : ''}
                  </em>
                </span>
                <button
                  className="icon-action sm"
                  onClick={() => add(p)}
                  title="Duplicate this persona"
                  aria-label="Duplicate persona"
                >
                  <Copy size={14} />
                </button>
                {!p.builtin && (
                  <button
                    className="icon-action sm"
                    onClick={() => remove(p)}
                    title={saved ? 'Delete persona' : 'Discard this draft'}
                    aria-label="Delete persona"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {expanded.has(p.id) && (
                <div className="persona-editor">
                  <input
                    className="vfield persona-name"
                    aria-label="Persona name"
                    value={p.name}
                    onChange={(e) => setDraft({ ...p, name: e.target.value })}
                  />
                  <textarea
                    className="ci-textarea"
                    aria-label="Role prompt"
                    value={p.prompt}
                    onChange={(e) => setDraft({ ...p, prompt: e.target.value })}
                    rows={5}
                    placeholder="What this persona is and how it should behave. Appended to the base system prompt."
                  />
                  <div className="task-model">
                    <ModelPicker
                      models={models}
                      value={p.model ?? null}
                      onChange={(id) =>
                        setDraft({
                          ...p,
                          model: id ?? undefined,
                          effort: clampEffort(models, id, p.effort ?? null) ?? undefined
                        })
                      }
                      emptyLabel="App default"
                      ariaLabel="Model this persona runs on"
                    />
                    <EffortSelect
                      label="Effort this persona runs at"
                      value={p.effort ?? null}
                      efforts={effortsOf(models, p.model ?? null)}
                      emptyLabel="Default effort"
                      onChange={(effort) => setDraft({ ...p, effort: effort ?? undefined })}
                    />
                  </div>
                  <div className="persona-harness">
                    <input
                      className="vfield"
                      aria-label="Coding agent this persona drives"
                      value={p.harness?.agent ?? ''}
                      onChange={(e) => {
                        const agent = e.target.value;
                        setDraft({
                          ...p,
                          harness: agent.trim() ? { agent, cwd: p.harness?.cwd ?? '' } : undefined
                        });
                      }}
                      placeholder="Coding agent (e.g. claude)"
                    />
                    <input
                      className="vfield persona-cwd"
                      aria-label="Working directory for the coding agent"
                      value={p.harness?.cwd ?? ''}
                      onChange={(e) =>
                        setDraft({
                          ...p,
                          harness: p.harness ? { ...p.harness, cwd: e.target.value } : undefined
                        })
                      }
                      placeholder="Its working directory (absolute path)"
                      disabled={!p.harness}
                    />
                  </div>
                  <label className="persona-cap">
                    <input
                      type="checkbox"
                      checked={p.canAddPersonas === true}
                      onChange={(e) =>
                        setDraft({ ...p, canAddPersonas: e.target.checked || undefined })
                      }
                    />
                    <span>
                      Can add personas to conversations — lets this persona widen a mail
                      conversation’s To: list with the add_persona tool.
                    </span>
                  </label>
                  <div className="push-row">
                    <button className="link-btn" onClick={() => cancel(p.id)}>
                      Cancel
                    </button>
                    <button
                      className="primary"
                      onClick={() => save(p)}
                      disabled={!dirty || savingId === p.id}
                    >
                      {savingId === p.id ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button className="link-btn" onClick={() => add()}>
        <Plus size={14} /> New persona
      </button>
    </div>
  );
}
