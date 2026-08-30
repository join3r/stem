import { useEffect, useRef, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import type { ModelSummary, Persona } from '../../../shared/types';
import { ModelPicker } from '../../ui/ModelPicker';
import { clampEffort, effortsOf, EffortSelect } from '../../ui/EffortSelect';
import { EFFORT_LABELS } from '../../modelLabels';

// ---- Personas tab: the named agent configurations mail addresses ----
//
// A persona is a row the user edits in place, exactly like a scheduled task:
// name and role prompt, an optional model/effort pin, and an optional coding-
// harness pin (which agent coding_agent drives for this persona, and in which
// directory — that cwd is the whole meaning of a "code — stem" persona).
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
  if (p.harness) parts.push(`${p.harness.agent} in ${p.harness.cwd}`);
  return parts.join(' · ');
}

/** A name not already taken (case-insensitively): "code copy", "code copy 2", … */
function uniqueName(base: string, personas: Persona[]): string {
  const taken = new Set(personas.map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function PersonasTab({ models }: { models: ModelSummary[] }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Per-persona debounce so typing in the prompt doesn't spam the atomic store.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    void window.stem.listPersonas().then(setPersonas);
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
    };
  }, []);

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Persist one persona, reconciling with the authoritative list it returns. */
  function persist(persona: Persona) {
    window.stem
      .savePersona(persona)
      .then((list) => {
        setPersonas(list);
        setError(null);
      })
      .catch(async (err: unknown) => {
        // A refused save (duplicate name, blank name) leaves the optimistic row
        // wrong — say why and put the stored truth back.
        setError(err instanceof Error ? err.message : String(err));
        setPersonas(await window.stem.listPersonas());
      });
  }

  /** Optimistic edit + debounced save — prompt/name fields call this per keystroke. */
  function mutate(persona: Persona) {
    setPersonas((cur) => cur.map((p) => (p.id === persona.id ? persona : p)));
    const timer = timers.current.get(persona.id);
    if (timer) clearTimeout(timer);
    timers.current.set(
      persona.id,
      setTimeout(() => persist(persona), 400)
    );
  }

  function add(from?: Persona) {
    const persona: Persona = {
      ...from,
      id: crypto.randomUUID(),
      name: uniqueName(from ? `${from.name} copy` : 'New persona', personas),
      prompt: from?.prompt ?? ''
    };
    delete persona.builtin;
    setPersonas((cur) => [...cur, persona]);
    setExpanded((prev) => new Set(prev).add(persona.id));
    persist(persona);
  }

  function remove(persona: Persona) {
    setPersonas((cur) => cur.filter((p) => p.id !== persona.id));
    window.stem
      .deletePersona(persona.id)
      .then(setPersonas)
      .catch(async (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setPersonas(await window.stem.listPersonas());
      });
  }

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
        {personas.map((p) => (
          <div key={p.id} className="task-item">
            <div className="task-head">
              <span className="row-main">
                <strong
                  className="task-title"
                  onClick={() => toggleExpanded(p.id)}
                  title={expanded.has(p.id) ? 'Collapse' : 'Edit this persona'}
                >
                  {p.name}
                </strong>
                <em>{summaryLabel(p, models)}</em>
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
                  title="Delete persona"
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
                  onChange={(e) => mutate({ ...p, name: e.target.value })}
                />
                <textarea
                  className="ci-textarea"
                  aria-label="Role prompt"
                  value={p.prompt}
                  onChange={(e) => mutate({ ...p, prompt: e.target.value })}
                  rows={5}
                  placeholder="What this persona is and how it should behave. Appended to the base system prompt."
                />
                <div className="task-model">
                  <ModelPicker
                    models={models}
                    value={p.model ?? null}
                    onChange={(id) =>
                      mutate({
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
                    onChange={(effort) => mutate({ ...p, effort: effort ?? undefined })}
                  />
                </div>
                <div className="persona-harness">
                  <input
                    className="vfield"
                    aria-label="Coding agent this persona drives"
                    value={p.harness?.agent ?? ''}
                    onChange={(e) => {
                      const agent = e.target.value;
                      mutate({
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
                      mutate({
                        ...p,
                        harness: p.harness ? { ...p.harness, cwd: e.target.value } : undefined
                      })
                    }
                    placeholder="Its working directory (absolute path)"
                    disabled={!p.harness}
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <button className="link-btn" onClick={() => add()}>
        <Plus size={14} /> New persona
      </button>
    </div>
  );
}
