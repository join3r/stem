import { useEffect, useState } from 'react';
import { Copy, FolderSearch, Plus, Trash2 } from 'lucide-react';
import type {
  ClientInfo,
  DeviceInfo,
  ModelSummary,
  Persona,
  PersonaHarnessPin,
  PersonaNote
} from '../../../shared/types';
import { InfoTip } from '../../ui/InfoTip';
import { ModelPicker } from '../../ui/ModelPicker';
import { clampEffort, effortsOf, EffortSelect } from '../../ui/EffortSelect';
import { EFFORT_LABELS } from '../../modelLabels';
import { appDefaultModel } from '../../../shared/modelRoles';
import { ServerFolderPicker } from '../ServerFolderPicker';

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

/** "Fable · High · claude on MacBook in ~/src/stem" — the collapsed face of a persona row. */
function summaryLabel(
  p: Persona,
  models: ModelSummary[],
  devices: DeviceInfo[],
  personas: Persona[]
): string {
  const parts: string[] = [];
  if (p.model) {
    const m = models.find((x) => x.id === p.model);
    parts.push(m ? m.displayName : p.model.split('/').pop() ?? p.model);
    if (p.effort) parts.push(EFFORT_LABELS[p.effort] ?? p.effort);
  } else {
    parts.push('App default model');
  }
  if (p.harness) {
    const where = p.harness.device
      ? ` on ${devices.find((d) => d.id === p.harness?.device)?.label ?? p.harness.device}`
      : '';
    parts.push(
      p.harness.cwd
        ? `${p.harness.agent}${where} in ${p.harness.cwd}`
        : `${p.harness.agent}${where}`
    );
  }
  if (p.createdBy) {
    parts.push(`created by ${personas.find((x) => x.id === p.createdBy)?.name ?? p.createdBy}`);
  }
  if (p.memory === false) parts.push('no private memory');
  if (p.recall === false) parts.push('no recall');
  if (p.clients) parts.push('open to chats');
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
    (a.harness?.device ?? '') === (b.harness?.device ?? '') &&
    (a.canManagePersonas ?? false) === (b.canManagePersonas ?? false) &&
    (a.memory ?? true) === (b.memory ?? true) &&
    (a.recall ?? true) === (b.recall ?? true) &&
    (a.sendBudget ?? 0) === (b.sendBudget ?? 0) &&
    (a.clients ?? false) === (b.clients ?? false)
  );
}

/** Why the tab wears a Beta pill; the same words sit on the mail badges. */
const BETA_TITLE = 'Beta: personas work, but how they are set up and what they can do is still changing.';

/** How a note earned its place — shown as a chip beside the title. */
const NOTE_SOURCE_LABELS: Record<PersonaNote['source'], string> = {
  reflection: 'Learned',
  tool: 'Saved by persona',
  user: 'Added by you'
};

/**
 * A persona's memory notes: the browse/edit/delete surface for the store its
 * delivery turns read and write (workspace/persona-memory.ts). Deliberately
 * OUTSIDE the row's draft/Save cycle — notes are a separate store the persona
 * itself also writes, so each note saves explicitly on its own, and a Cancel
 * of the persona form must not throw note edits away with it.
 */
function PersonaNotes({ personaId }: { personaId: string }) {
  const [notes, setNotes] = useState<PersonaNote[] | null>(null);
  // The note being edited (or the add form when id is ''), as a local draft.
  const [editing, setEditing] = useState<{ id: string; title: string; body: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    window.stem
      .listPersonaNotes(personaId)
      .then((list) => {
        if (!stale) setNotes(list);
      })
      .catch(() => {
        if (!stale) setNotes([]);
      });
    return () => {
      stale = true;
    };
  }, [personaId]);

  function saveNote(draft: { id: string; title: string; body: string }) {
    window.stem
      .savePersonaNote(personaId, {
        ...(draft.id ? { id: draft.id } : {}),
        title: draft.title,
        body: draft.body
      })
      .then((list) => {
        setNotes(list);
        setEditing(null);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  function removeNote(noteId: string) {
    window.stem
      .deletePersonaNote(personaId, noteId)
      .then((list) => {
        setNotes(list);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  return (
    <div className="persona-notes">
      <div className="grp-head">
        Memory ({notes ? notes.length : '…'}){' '}
        <InfoTip label="About persona memory">
          Lessons this persona keeps from its past work. It learns automatically after each mail
          it handles and can save notes itself; everything here is injected as its note index on
          every delivery.
        </InfoTip>
      </div>
      {error && <p className="task-failed">{error}</p>}
      {notes?.map((n) =>
        editing?.id === n.id ? (
          <div key={n.id} className="persona-note-editor">
            <input
              className="vfield"
              aria-label="Note title"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
            <textarea
              className="ci-textarea"
              aria-label="Note body"
              rows={4}
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            />
            <div className="push-row">
              <button className="link-btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => saveNote(editing)}
                disabled={!editing.body.trim()}
              >
                Save note
              </button>
            </div>
          </div>
        ) : (
          <div key={n.id} className="task-item">
            <div className="task-head">
              <span className="row-main">
                <strong
                  className="task-title"
                  onClick={() => setOpenId(openId === n.id ? null : n.id)}
                  title={openId === n.id ? 'Collapse' : 'Show this note'}
                >
                  {n.title}
                </strong>
                <em>
                  {NOTE_SOURCE_LABELS[n.source]} · {new Date(n.at).toLocaleDateString()}
                </em>
              </span>
              <button
                className="icon-action sm"
                onClick={() => removeNote(n.id)}
                title="Delete this note"
                aria-label="Delete note"
              >
                <Trash2 size={14} />
              </button>
            </div>
            {openId === n.id && (
              <p
                className="muted"
                style={{ whiteSpace: 'pre-wrap', cursor: 'pointer' }}
                onClick={() => setEditing({ id: n.id, title: n.title, body: n.body })}
                title="Edit this note"
              >
                {n.body}
              </p>
            )}
          </div>
        )
      )}
      {editing && !editing.id ? (
        <div className="persona-note-editor">
          <input
            className="vfield"
            aria-label="Note title"
            placeholder="Title (optional — the body’s first line otherwise)"
            value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
          />
          <textarea
            className="ci-textarea"
            aria-label="Note body"
            rows={4}
            placeholder="The lesson this persona should keep."
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
          />
          <div className="push-row">
            <button className="link-btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={() => saveNote(editing)}
              disabled={!editing.body.trim()}
            >
              Save note
            </button>
          </div>
        </div>
      ) : (
        <button className="link-btn" onClick={() => setEditing({ id: '', title: '', body: '' })}>
          <Plus size={14} /> Add note
        </button>
      )}
    </div>
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
  // Agent names the coding-agent select offers (acpx registry + custom entries
  // from harness settings). Empty on a server too old to answer — the editor
  // falls back to a plain text field there.
  const [agents, setAgents] = useState<string[]>([]);
  // Paired devices, for the "runs on" picker (filtered to coding-agent hosts
  // there) and for naming a pinned device in the row summary.
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // Persona id whose cwd is being picked in the server-folder browser.
  const [pickingCwdFor, setPickingCwdFor] = useState<string | null>(null);
  // Who THIS client is: its device id (to spot a pin targeting this very
  // computer) and whether the server runs in-process (its disk = this disk).
  const [client, setClient] = useState<ClientInfo | null>(null);

  useEffect(() => {
    void window.stem.listPersonas().then(setPersonas);
    window.stem.listCodingAgents().then(setAgents).catch(() => setAgents([]));
    window.stem
      .listDevices()
      .then((s) => setDevices(s.devices))
      .catch(() => setDevices([]));
    window.stem
      .clientInfo()
      .then(setClient)
      .catch(() => setClient(null));
  }, []);

  // Edits from another client (or another panel) land here live. Drafts are an
  // overlay keyed by id, so refreshing the stored list never touches them.
  useEffect(
    () =>
      window.stem.onPersonasChanged(() => {
        void window.stem.listPersonas().then(setPersonas);
      }),
    []
  );

  /** Whether this pin's folders live on THIS computer's disk — the native dialog applies. */
  const nativeBrowse = (h: PersonaHarnessPin) =>
    h.device ? h.device === client?.deviceId : client !== null && !client.remote;

  /** Browse for a pin's cwd: the native dialog for this computer's disk, the server picker otherwise. */
  async function browseCwd(p: Persona) {
    if (!p.harness) return;
    if (!nativeBrowse(p.harness)) {
      setPickingCwdFor(p.id);
      return;
    }
    const [path] = await window.stem.pickDirectory();
    if (path) setDraft({ ...p, harness: { ...p.harness, cwd: path } });
  }

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
    delete draft.createdBy;
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
      <div className="grp-head">
        Personas
        <span className="beta-pill" title={BETA_TITLE}>
          Beta
        </span>{' '}
        <InfoTip label="About personas">
          Named configurations you can address mail to: a role prompt, and optionally a pinned
          model and a coding agent with its own working directory. Duplicate one to make a variant
          — e.g. a “code — stem” persona is the coding pin pointed at the stem checkout.
        </InfoTip>
      </div>
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
                    {summaryLabel(p, models, devices, personas)}
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
                      resolvedDefault={appDefaultModel(models)}
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
                    {agents.length > 0 ? (
                      <select
                        className="vfield"
                        aria-label="Coding agent this persona drives"
                        value={p.harness?.agent ?? ''}
                        onChange={(e) => {
                          const agent = e.target.value;
                          setDraft({
                            ...p,
                            harness: agent ? { agent, cwd: p.harness?.cwd ?? '' } : undefined
                          });
                        }}
                      >
                        <option value="">No coding agent</option>
                        {p.harness?.agent && !agents.includes(p.harness.agent) && (
                          <option value={p.harness.agent}>{p.harness.agent} (custom)</option>
                        )}
                        {agents.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    ) : (
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
                    )}
                    <select
                      className="vfield"
                      aria-label="Computer the coding agent runs on"
                      value={p.harness?.device ?? ''}
                      disabled={!p.harness}
                      onChange={(e) =>
                        setDraft({
                          ...p,
                          harness: p.harness
                            ? { ...p.harness, device: e.target.value || undefined }
                            : undefined
                        })
                      }
                    >
                      <option value="">On Stem’s server</option>
                      {p.harness?.device &&
                        !devices.some((d) => d.id === p.harness?.device && d.runsCodingAgents) && (
                          <option value={p.harness.device}>
                            On {devices.find((d) => d.id === p.harness?.device)?.label ??
                              p.harness.device}{' '}
                            (not hosting coding agents)
                          </option>
                        )}
                      {devices
                        .filter((d) => d.runsCodingAgents)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            On {d.label}
                          </option>
                        ))}
                    </select>
                    <div className="persona-cwd-row">
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
                      <button
                        className="icon-action sm"
                        onClick={() => void browseCwd(p)}
                        disabled={
                          !p.harness || (!!p.harness.device && !nativeBrowse(p.harness))
                        }
                        title={
                          !p.harness || nativeBrowse(p.harness)
                            ? 'Choose a folder on this computer'
                            : p.harness.device
                              ? 'Another computer’s folders can’t be browsed from here — type the path as that computer sees it.'
                              : 'Browse the server’s folders'
                        }
                        aria-label="Browse for a working directory"
                      >
                        <FolderSearch size={14} />
                      </button>
                    </div>
                  </div>
                  <label className="persona-cap">
                    <input
                      type="checkbox"
                      checked={p.canManagePersonas === true}
                      onChange={(e) =>
                        setDraft({ ...p, canManagePersonas: e.target.checked || undefined })
                      }
                    />
                    <span>
                      Can manage personas{' '}
                      <InfoTip label="About managing personas">
                        Lets this persona widen a mail conversation’s To: list (add_persona) and
                        create, edit, and delete its own helper personas (save_persona /
                        delete_persona).
                      </InfoTip>
                    </span>
                  </label>
                  <label className="persona-cap">
                    <input
                      type="checkbox"
                      checked={p.memory !== false}
                      onChange={(e) => setDraft({ ...p, memory: e.target.checked ? undefined : false })}
                      disabled={!!p.createdBy}
                    />
                    <span>
                      Keeps private memory{' '}
                      <InfoTip label="About private memory">
                        Expertise notes this persona saves from its work and reads on every mail.
                        Turn it off for personas whose value is a fresh outside view (the built-in
                        Critic ships without one).
                      </InfoTip>
                    </span>
                  </label>
                  <label className="persona-cap">
                    <input
                      type="checkbox"
                      checked={p.recall !== false}
                      onChange={(e) => setDraft({ ...p, recall: e.target.checked ? undefined : false })}
                    />
                    <span>
                      Sees your memory{' '}
                      <InfoTip label="About recall for this persona">
                        Injects Stem Recall — your facts, past conversations, indexed folders —
                        into this persona’s turns, as in your own chats. Turn it off for a persona
                        that should judge material cold: a reviewer handed the author’s facts
                        alongside the draft stops being an outside reader, and asking it to ignore
                        who wrote it works less well than never showing it. (Critic ships with this
                        off.)
                      </InfoTip>
                    </span>
                  </label>
                  <label className="persona-cap">
                    <input
                      type="checkbox"
                      checked={p.clients === true}
                      onChange={(e) => setDraft({ ...p, clients: e.target.checked || undefined })}
                    />
                    <span>
                      Usable in chats from other devices{' '}
                      <InfoTip label="About chats as this persona">
                        Offers this persona in the chat composer on your other devices (the phone
                        app). A chat sent as it runs with its role prompt, pinned model, and coding
                        setup — off, it stays a mail-and-tasks persona only.
                      </InfoTip>
                    </span>
                  </label>
                  <label className="persona-cap">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={p.sendBudget ?? ''}
                      placeholder="∞"
                      style={{ width: '4.5em' }}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        setDraft({
                          ...p,
                          sendBudget: Number.isFinite(n)
                            ? Math.min(100, Math.max(1, n))
                            : undefined
                        });
                      }}
                    />
                    <span>
                      Send budget per wave{' '}
                      <InfoTip label="About the send budget">
                        The most mails this persona may start between your sends in one
                        conversation. Its reply to whoever mailed it is always allowed. Blank =
                        unlimited (the global exchange cap still applies).
                      </InfoTip>
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
                  {/* Only SAVED personas with a store: agent-created helpers and
                      memory-off personas keep none, and a never-saved draft has no
                      id on the server yet. */}
                  {saved && !p.createdBy && p.memory !== false && <PersonaNotes personaId={p.id} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button className="link-btn" onClick={() => add()}>
        <Plus size={14} /> New persona
      </button>
      {pickingCwdFor &&
        (() => {
          // The row is expanded (the Browse button lives in the editor), so a
          // draft with a harness exists; the guard covers a state race anyway.
          const target = drafts.get(pickingCwdFor);
          if (!target?.harness) return null;
          const harness = target.harness;
          return (
            <ServerFolderPicker
              title="Choose the agent’s working directory"
              hint="The coding agent runs on Stem’s server, so this browses the server’s folders — pick where it should work, or paste a path the server knows."
              confirmLabel="Use this folder"
              onConnect={(path) => {
                setDraft({ ...target, harness: { ...harness, cwd: path } });
                setPickingCwdFor(null);
              }}
              onClose={() => setPickingCwdFor(null)}
            />
          );
        })()}
    </div>
  );
}
