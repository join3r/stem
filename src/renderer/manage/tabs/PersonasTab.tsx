import { useEffect, useState } from 'react';
import {
  Code,
  Copy,
  EyeOff,
  FolderSearch,
  MessageSquare,
  Monitor,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users
} from 'lucide-react';
import type {
  ClientInfo,
  DeviceInfo,
  HarnessModelsResult,
  McpServerSummary,
  ModelSummary,
  Persona,
  PersonaHarnessPin,
  PersonaNote
} from '../../../shared/types';
import { InfoTip } from '../../ui/InfoTip';
import { COMPUTER_ALPHA_TITLE } from './settings/ChatFeatureRows';
import { ModelPicker } from '../../ui/ModelPicker';
import { clampEffort, effortsOf, EffortSelect } from '../../ui/EffortSelect';
import { EFFORT_LABELS } from '../../modelLabels';
import { appDefaultModel } from '../../../shared/modelRoles';
import { ServerFolderPicker } from '../ServerFolderPicker';
import {
  ConfirmDelete,
  DetailFooter,
  DetailHeader,
  DetailIdent,
  DetailTabs,
  Field,
  Flag,
  Glyph,
  ListGroup,
  ListHeader,
  ListRow,
  ListSearch,
  ToggleRow,
  shortPath,
  type GlyphTone
} from '../ListDetail';

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

/** Same set of allowed servers, where "absent" (all) differs from every list. */
function sameMcpServers(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((n) => b.includes(n));
}

/**
 * The configured servers grouped the way the MCP tab groups them — by the
 * machine they run on — so the two tabs read alike. The data stays a flat
 * list of names: where a server runs is a label here, never part of the pin.
 * Reserved Stem servers never reach the renderer, so nothing is hidden here.
 */
function groupMcpServers(
  servers: McpServerSummary[],
  client: ClientInfo | null
): { head: string; items: McpServerSummary[] }[] {
  const here = (s: McpServerSummary) => !!client?.deviceId && s.location?.deviceId === client.deviceId;
  const groups: { head: string; items: McpServerSummary[] }[] = [];
  const push = (head: string, items: McpServerSummary[]) => {
    if (items.length > 0) groups.push({ head, items });
  };
  const unpinned = servers.filter((s) => !s.location);
  if (client?.remote) {
    push('On your Stem server', unpinned);
    push('On this computer', servers.filter(here));
  } else {
    push('On this computer', [...unpinned, ...servers.filter(here)]);
  }
  const others = new Map<string, { head: string; items: McpServerSummary[] }>();
  for (const s of servers) {
    if (!s.location || s.location.orphaned || here(s)) continue;
    const group = others.get(s.location.deviceId) ?? { head: `On ${s.location.label}`, items: [] };
    group.items.push(s);
    others.set(s.location.deviceId, group);
  }
  groups.push(...[...others.values()].sort((a, b) => a.head.localeCompare(b.head)));
  // Pinned to a computer that is no longer paired: it runs nowhere, so allowing
  // it does nothing today — listed under the same words the MCP tab uses.
  push('Nowhere — that computer is gone', servers.filter((s) => s.location?.orphaned));
  return groups;
}

/** A name not already taken (case-insensitively): "code copy", "code copy 2", … */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Whether the model this persona will run on accepts images — the whole basis
 * of computer control. Unknown (`input` absent: an older server, or a model pi
 * did not describe) reads as yes: the warning is for a certain miss, not a doubt.
 */
function modelSeesImages(p: Persona, models: ModelSummary[]): boolean {
  const id = p.model ?? appDefaultModel(models);
  const m = models.find((x) => x.id === id);
  return !m?.input || m.input.includes('image');
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
    (a.harness?.model ?? '') === (b.harness?.model ?? '') &&
    (a.harness?.autoMode ?? false) === (b.harness?.autoMode ?? false) &&
    (a.computer?.device ?? '') === (b.computer?.device ?? '') &&
    (a.browser?.device ?? '') === (b.browser?.device ?? '') &&
    (a.canSpawn ?? false) === (b.canSpawn ?? false) &&
    (a.memory ?? true) === (b.memory ?? true) &&
    (a.recall ?? true) === (b.recall ?? true) &&
    (a.sendBudget ?? 0) === (b.sendBudget ?? 0) &&
    (a.clients ?? false) === (b.clients ?? false) &&
    sameMcpServers(a.mcpServers, b.mcpServers)
  );
}

/** Why the tab wears a Beta pill; the same words sit on the mail badges. */
const BETA_TITLE = 'Beta: personas work, but how they are set up and what they can do is still changing.';

/** How a note earned its place — shown as a chip beside the title. */
const NOTE_SOURCE_LABELS: Record<PersonaNote['source'], string> = {
  reflection: 'Learned',
  tool: 'Saved by persona',
  user: 'Added by you',
  answer: 'From your reply'
};

/**
 * The two faces of the notes store (workspace/persona-memory.ts): a memory of
 * lessons for an ordinary persona, standing answers for a code persona — same
 * rows, different words, and no Tidy up for answers (nothing automatic wrote
 * them, so there is nothing to merge).
 */
const NOTES_COPY = {
  memory: {
    heading: 'Memory',
    titleLabel: 'Note title',
    bodyLabel: 'Note body',
    titlePlaceholder: 'Title (optional — the body’s first line otherwise)',
    bodyPlaceholder: 'The lesson this persona should keep.',
    add: 'Add note',
    save: 'Save note',
    remove: 'Delete this note',
    tidy: true
  },
  answers: {
    heading: 'Standing answers',
    titleLabel: 'When the coding agent asks',
    bodyLabel: 'Answer',
    titlePlaceholder: 'When the agent asks… (e.g. “Should I deploy this now?”)',
    bodyPlaceholder: 'The answer the persona should give on your behalf.',
    add: 'Add answer',
    save: 'Save answer',
    remove: 'Delete this answer',
    tidy: false
  }
} as const;

/**
 * A persona's memory notes: the browse/edit/delete surface for the store its
 * delivery turns read and write (workspace/persona-memory.ts). Deliberately
 * OUTSIDE the row's draft/Save cycle — notes are a separate store the persona
 * itself also writes, so each note saves explicitly on its own, and a Cancel
 * of the persona form must not throw note edits away with it.
 */
function PersonaNotes({ personaId, kind }: { personaId: string; kind: keyof typeof NOTES_COPY }) {
  const copy = NOTES_COPY[kind];
  const [notes, setNotes] = useState<PersonaNote[] | null>(null);
  // The note being edited (or the add form when id is ''), as a local draft.
  const [editing, setEditing] = useState<{ id: string; title: string; body: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tidying, setTidying] = useState(false);
  const [tidied, setTidied] = useState<string | null>(null);

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

  function tidy() {
    setTidying(true);
    setTidied(null);
    window.stem
      .consolidatePersonaNotes(personaId)
      .then(({ outcome, notes: list }) => {
        setNotes(list);
        setError(null);
        setTidied(
          outcome.ok
            ? `Tidied: ${outcome.before} → ${outcome.after} notes (${outcome.rewritten} merged or rewritten, ${outcome.dropped} dropped).`
            : `Nothing changed: ${outcome.reason ?? 'no reason given'}.`
        );
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setTidying(false));
  }

  return (
    <div className="persona-notes">
      <div className="grp-head">
        {copy.heading} ({notes ? notes.length : '…'}){' '}
        {kind === 'memory' ? (
          <InfoTip label="About persona memory">
            Lessons this persona keeps from its past work. It learns automatically after each mail
            it handles and can save notes itself; everything here is injected as its note index on
            every delivery. Tidy up asks the memory model to merge overlapping notes and drop the
            ones that are advice rather than knowledge; it also runs by itself every dozen lessons.
          </InfoTip>
        ) : (
          <InfoTip label="About standing answers">
            Questions the coding agent tends to ask, with the answer this persona may give on your
            behalf instead of mailing you. Every time you answer such a question in a mail reply,
            the pair is saved here automatically; you can also add answers yourself. The persona
            asks you whenever nothing here settles the question. Knowledge about the project
            itself belongs in the repository (CLAUDE.md) where the agent reads it.
          </InfoTip>
        )}
        {copy.tidy && (notes?.length ?? 0) >= 3 && (
          <button className="link-btn" onClick={tidy} disabled={tidying}>
            {tidying ? 'Tidying…' : 'Tidy up'}
          </button>
        )}
      </div>
      {tidied && <p className="muted">{tidied}</p>}
      {error && <p className="task-failed">{error}</p>}
      {notes?.map((n) =>
        editing?.id === n.id ? (
          <div key={n.id} className="persona-note-editor">
            <input
              className="vfield"
              aria-label={copy.titleLabel}
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
            <textarea
              className="ci-textarea"
              aria-label={copy.bodyLabel}
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
                {copy.save}
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
                title={copy.remove}
                aria-label={copy.remove}
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
            aria-label={copy.titleLabel}
            placeholder={copy.titlePlaceholder}
            value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
          />
          <textarea
            className="ci-textarea"
            aria-label={copy.bodyLabel}
            rows={4}
            placeholder={copy.bodyPlaceholder}
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
              {copy.save}
            </button>
          </div>
        </div>
      ) : (
        <button className="link-btn" onClick={() => setEditing({ id: '', title: '', body: '' })}>
          <Plus size={14} /> {copy.add}
        </button>
      )}
    </div>
  );
}

/** What a persona runs as — derived from its pins, never stored. */
type PersonaKind = 'assistant' | 'code' | 'computer';

function personaKind(p: Persona): PersonaKind {
  if (p.computer || p.browser) return 'computer';
  if (p.harness) return 'code';
  return 'assistant';
}

const KIND_GROUPS: { kind: PersonaKind; label: string }[] = [
  { kind: 'assistant', label: 'Assistants' },
  { kind: 'code', label: 'Coding agents' },
  { kind: 'computer', label: 'Computer control' }
];

function KindIcon({ kind, size = 14 }: { kind: PersonaKind; size?: number }) {
  if (kind === 'code') return <Code size={size} />;
  if (kind === 'computer') return <Monitor size={size} />;
  return <MessageSquare size={size} />;
}

const KIND_TONE: Record<PersonaKind, GlyphTone> = { assistant: 'plain', code: 'accent', computer: 'warn' };

type EditorTab = 'role' | 'runs' | 'access';

export function PersonasTab({ models }: { models: ModelSummary[] }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  // Unsaved edits, keyed by persona id. A draft whose id is not in `personas`
  // is a brand-new persona that exists nowhere but this screen until Save.
  const [drafts, setDrafts] = useState<Map<string, Persona>>(new Map());
  // The persona whose editor replaces the list (null = the list).
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>('role');
  // "Runs as" picked in the editor before its pin is filled in: a Computer
  // persona with no device chosen yet has nothing to derive the kind from.
  const [kindPick, setKindPick] = useState<Map<string, PersonaKind>>(new Map());
  const [query, setQuery] = useState('');
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
  // Configured MCP servers, for the per-persona allowlist picker. Read once
  // like the devices: a server added while this tab is open shows up on the
  // next visit, which is also when the persona would first be able to use it.
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);

  useEffect(() => {
    void window.stem.listPersonas().then(setPersonas);
    window.stem.listCodingAgents().then(setAgents).catch(() => setAgents([]));
    window.stem
      .listMcpServers()
      .then(setMcpServers)
      .catch(() => setMcpServers([]));
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

  const kindOf = (p: Persona): PersonaKind => kindPick.get(p.id) ?? personaKind(p);

  /** Open a persona's editor, on the tab that matters most for its kind. */
  function open(p: Persona, at?: EditorTab) {
    if (!drafts.has(p.id)) setDraft({ ...p });
    setTab(at ?? (personaKind(p) === 'assistant' ? 'role' : 'runs'));
    setOpenId(p.id);
    setError(null);
  }

  /** Back to the list. A dirty draft survives (its row says "unsaved"). */
  function back() {
    if (openId) {
      const draft = drafts.get(openId);
      const stored = personas.find((x) => x.id === openId);
      if (draft && stored && sameEdit(draft, stored)) dropDraft(openId);
    }
    setOpenId(null);
    setError(null);
  }

  function save(draft: Persona) {
    setSavingId(draft.id);
    window.stem
      .savePersona(draft)
      .then((list) => {
        setPersonas(list);
        // Keep the editor open on the saved values: the draft now matches the
        // store, so the footer goes quiet without bouncing back to the list.
        setDraft({ ...(list.find((x) => x.id === draft.id) ?? draft) });
        setKindPick((cur) => {
          const next = new Map(cur);
          next.delete(draft.id);
          return next;
        });
        setError(null);
      })
      .catch((err: unknown) => {
        // A refused save (duplicate name, blank name) keeps the draft on
        // screen so the user can fix it — nothing was lost.
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSavingId(null));
  }

  /** Discard the draft and return to the list; a never-saved persona disappears with it. */
  function cancel(id: string) {
    dropDraft(id);
    setKindPick((cur) => {
      const next = new Map(cur);
      next.delete(id);
      return next;
    });
    setOpenId(null);
    setError(null);
  }

  /** New persona (blank, a starting point, or a copy) — a draft only, on the server after Save. */
  function add(from?: Partial<Persona>, kind?: PersonaKind) {
    const taken = new Set([
      ...personas.map((p) => p.name.toLowerCase()),
      ...[...drafts.values()].map((p) => p.name.toLowerCase())
    ]);
    const draft: Persona = {
      ...from,
      id: crypto.randomUUID(),
      name: uniqueName(from?.name ? `${from.name} copy` : 'New persona', taken),
      prompt: from?.prompt ?? ''
    };
    delete draft.builtin;
    setDraft(draft);
    if (kind) setKindPick((cur) => new Map(cur).set(draft.id, kind));
    setTab(from?.name ? 'role' : kind && kind !== 'assistant' ? 'runs' : 'role');
    setOpenId(draft.id);
  }

  function remove(persona: Persona) {
    dropDraft(persona.id);
    setOpenId(null);
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

  /** Switch what the persona runs as: keeps the pins that kind uses, drops the rest. */
  function setKind(p: Persona, kind: PersonaKind) {
    setKindPick((cur) => new Map(cur).set(p.id, kind));
    const next: Persona = { ...p };
    if (kind !== 'code') delete next.harness;
    if (kind !== 'computer') {
      delete next.computer;
      delete next.browser;
    }
    if (kind === 'code' && !next.harness) next.harness = { agent: agents.includes('claude') ? 'claude' : agents[0] ?? 'claude', cwd: '' };
    setDraft(next);
  }

  const deviceLabel = (id: string) => devices.find((d) => d.id === id)?.label ?? id;

  /** The row's one line: the pin that defines it, or the role prompt's first line. */
  function rowLine(p: Persona): string {
    const model = p.model
      ? [models.find((x) => x.id === p.model)?.displayName ?? p.model.split('/').pop(), p.effort && (EFFORT_LABELS[p.effort] ?? p.effort)]
          .filter(Boolean)
          .join(' · ')
      : '';
    const kind = personaKind(p);
    if (kind === 'code' && p.harness) {
      const agent = p.harness.model ? `${p.harness.agent} · ${p.harness.model}` : p.harness.agent;
      const where = p.harness.device && devices.length > 1 ? ` on ${deviceLabel(p.harness.device)}` : '';
      // The folder first: it is what tells two code personas apart, and the
      // line truncates from the right in a 300px rail.
      return [p.harness.cwd && shortPath(p.harness.cwd), agent + where].filter(Boolean).join(' · ');
    }
    if (kind === 'computer') {
      const parts = [
        p.computer && `controls ${deviceLabel(p.computer.device)}`,
        p.browser && (p.computer?.device === p.browser.device ? 'and its browser' : `browser on ${deviceLabel(p.browser.device)}`)
      ];
      return parts.filter(Boolean).join(' ');
    }
    return model || p.prompt.split('\n')[0] || 'No role prompt';
  }

  function rowFlags(p: Persona) {
    return (
      <>
        {p.harness?.autoMode && <Flag icon={<ShieldCheck size={12} />} tone="warn" label="Approves its own actions" />}
        {p.clients && <Flag icon={<Smartphone size={12} />} tone="ok" label="Open to chats from your other devices" />}
        {p.canSpawn && <Flag icon={<Users size={12} />} label="Can start helpers" />}
        {(p.memory === false || p.recall === false) && (
          <Flag
            icon={<EyeOff size={12} />}
            label={[p.memory === false && 'No private memory', p.recall === false && 'no recall'].filter(Boolean).join(', ')}
          />
        )}
        {p.mcpServers && (
          <Flag
            icon={<Plug size={12} />}
            label={p.mcpServers.length === 0 ? 'No integrations' : `${p.mcpServers.length} integration${p.mcpServers.length === 1 ? '' : 's'}`}
          />
        )}
      </>
    );
  }

  // Saved personas first, then never-saved drafts in creation order.
  const rows: Persona[] = [
    ...personas.map((p) => drafts.get(p.id) ?? p),
    ...[...drafts.values()].filter((d) => !personas.some((p) => p.id === d.id))
  ];

  const opened = openId ? drafts.get(openId) : undefined;

  const cwdPicker =
    pickingCwdFor &&
    (() => {
      // The editor is open (the Browse button lives in it), so a draft with a
      // harness exists; the guard covers a state race anyway.
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
    })();

  if (opened) {
    const p = opened;
    const saved = personas.find((x) => x.id === p.id);
    const dirty = !saved || !sameEdit(p, saved);
    const kind = kindOf(p);
    return (
      <div className="ld-detail">
        <DetailHeader backLabel="Personas" onBack={back}>
          <button
            type="button"
            className="icon-action sm"
            onClick={() => add(p)}
            title="Duplicate this persona"
            aria-label="Duplicate persona"
          >
            <Copy size={14} />
          </button>
          {!p.builtin && (
            <ConfirmDelete
              label={saved ? 'Delete persona' : 'Discard this draft'}
              icon={<Trash2 size={14} />}
              onConfirm={() => remove(p)}
            />
          )}
        </DetailHeader>
        <DetailIdent
          glyph={<Glyph icon={<KindIcon kind={kind} size={17} />} tone={KIND_TONE[kind]} size="lg" />}
          name={
            <input
              className="ld-name-input"
              aria-label="Persona name"
              value={p.name}
              onChange={(e) => setDraft({ ...p, name: e.target.value })}
            />
          }
          caption={p.builtin ? 'Built-in · can be edited, not deleted' : saved ? `Mail it as “${saved.name}”` : 'Not saved yet'}
        />
        {error && <p className="task-failed">{error}</p>}
        <DetailTabs
          tabs={[
            { key: 'role', label: 'Role' },
            { key: 'runs', label: 'Runs as' },
            { key: 'access', label: 'Access' }
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="ld-body">
          {tab === 'role' && (
            <>
              <Field label="Role prompt" htmlFor="persona-prompt">
                <textarea
                  id="persona-prompt"
                  className="ci-textarea"
                  aria-label="Role prompt"
                  value={p.prompt}
                  onChange={(e) => setDraft({ ...p, prompt: e.target.value })}
                  rows={7}
                  placeholder="What this persona is and how it should behave. Appended to the base system prompt."
                />
              </Field>
              <Field label="Model">
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
              </Field>
              {p.computer && !modelSeesImages(p, models) && (
                <div className="persona-warn" role="status">
                  This persona’s model cannot see images. Computer control works from screenshots, so
                  pick a model that accepts image input.
                </div>
              )}
            </>
          )}
          {tab === 'runs' && (
            <>
              <div className="seg-ctl ld-kind" role="radiogroup" aria-label="What this persona runs as">
                {KIND_GROUPS.map(({ kind: k }) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    className={kind === k ? 'active' : ''}
                    onClick={() => setKind(p, k)}
                  >
                    <KindIcon kind={k} size={13} />
                    {k === 'assistant' ? 'Assistant' : k === 'code' ? 'Coding agent' : 'Computer'}
                  </button>
                ))}
              </div>
              {kind === 'assistant' && (
                <p className="ld-hint">Answers with Stem’s own tools. Nothing else to set up.</p>
              )}
              {kind === 'code' && p.harness && (
                <>
                  <Field label="Agent">
                    {agents.length > 0 ? (
                      <select
                        className="vfield"
                        aria-label="Coding agent this persona drives"
                        value={p.harness.agent}
                        onChange={(e) => setDraft({ ...p, harness: { ...p.harness!, agent: e.target.value } })}
                      >
                        {!agents.includes(p.harness.agent) && (
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
                        value={p.harness.agent}
                        onChange={(e) => setDraft({ ...p, harness: { ...p.harness!, agent: e.target.value } })}
                        placeholder="Coding agent (e.g. claude)"
                      />
                    )}
                  </Field>
                  <Field label="Runs on">
                    <select
                      className="vfield"
                      aria-label="Computer the coding agent runs on"
                      value={p.harness.device ?? ''}
                      onChange={(e) =>
                        setDraft({ ...p, harness: { ...p.harness!, device: e.target.value || undefined } })
                      }
                    >
                      <option value="">Stem’s server</option>
                      {p.harness.device &&
                        !devices.some((d) => d.id === p.harness?.device && d.runsCodingAgents) && (
                          <option value={p.harness.device}>
                            {deviceLabel(p.harness.device)} (not hosting coding agents)
                          </option>
                        )}
                      {devices
                        .filter((d) => d.runsCodingAgents)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Folder">
                    <div className="persona-cwd-row">
                      <input
                        className="vfield persona-cwd"
                        aria-label="Working directory for the coding agent"
                        value={p.harness.cwd}
                        onChange={(e) => setDraft({ ...p, harness: { ...p.harness!, cwd: e.target.value } })}
                        placeholder="Its working directory (absolute path)"
                      />
                      <button
                        type="button"
                        className="icon-action sm"
                        onClick={() => void browseCwd(p)}
                        disabled={!!p.harness.device && !nativeBrowse(p.harness)}
                        title={
                          nativeBrowse(p.harness)
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
                  </Field>
                  <Field label="Agent model">
                    <HarnessModelSelect
                      pin={p.harness}
                      onChange={(model) => setDraft({ ...p, harness: { ...p.harness!, model } })}
                    />
                  </Field>
                  {p.harness.agent.trim().toLowerCase() === 'claude' && (
                    <ToggleRow
                      title="Approves its own actions"
                      hint={
                        <>
                          Claude Code’s own classifier judges each step instead of Stem, so routine work never
                          waits on an approval card.
                        </>
                      }
                      on={p.harness.autoMode === true}
                      tone="warn"
                      onChange={(on) => {
                        const harness = { ...p.harness! };
                        if (on) harness.autoMode = true;
                        else delete harness.autoMode;
                        setDraft({ ...p, harness });
                      }}
                    />
                  )}
                </>
              )}
              {kind === 'computer' && (
                <>
                  {/* Computer control: the Mac whose screen this persona drives. The
                      pin is the capability — no pin, no `computer` tool — and only a Mac
                      that switched on "Let Stem control this Mac" is offered. */}
                  <Field
                    label={
                      <>
                        Screen and apps
                        <span className="beta-pill alpha-pill" title={COMPUTER_ALPHA_TITLE}>
                          Alpha
                        </span>
                      </>
                    }
                  >
                    <select
                      className="vfield"
                      aria-label="Computer this persona controls"
                      value={p.computer?.device ?? ''}
                      onChange={(e) =>
                        setDraft({ ...p, computer: e.target.value ? { device: e.target.value } : undefined })
                      }
                    >
                      <option value="">Controls no computer</option>
                      {p.computer?.device &&
                        !devices.some((d) => d.id === p.computer?.device && d.runsComputer) && (
                          <option value={p.computer.device}>
                            Controls {deviceLabel(p.computer.device)} (not letting Stem control it)
                          </option>
                        )}
                      {devices
                        .filter((d) => d.runsComputer)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            Controls {d.label}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {/* Browser control: its own pin, so a persona can have the browser
                      without the screen. Page outlines are text — no image warning. */}
                  <Field label="Browser">
                    <select
                      className="vfield"
                      aria-label="Browser this persona controls"
                      value={p.browser?.device ?? ''}
                      onChange={(e) =>
                        setDraft({ ...p, browser: e.target.value ? { device: e.target.value } : undefined })
                      }
                    >
                      <option value="">Uses no browser</option>
                      {p.browser?.device &&
                        !devices.some((d) => d.id === p.browser?.device && d.runsBrowser) && (
                          <option value={p.browser.device}>
                            Uses the browser on {deviceLabel(p.browser.device)} (not letting Stem drive it)
                          </option>
                        )}
                      {devices
                        .filter((d) => d.runsBrowser)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            Uses the browser on {d.label}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {!p.computer && !p.browser && (
                    <p className="ld-hint">Pick a computer or a browser. With neither, it saves as an assistant.</p>
                  )}
                  {p.computer && !modelSeesImages(p, models) && (
                    <div className="persona-warn" role="status">
                      This persona’s model cannot see images. Computer control works from screenshots,
                      so pick a model that accepts image input (Role tab).
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {tab === 'access' && (
            <div className="ld-toggles">
              <ToggleRow
                title={p.harness ? 'Standing answers' : 'Private memory'}
                hint={
                  p.harness
                    ? 'Your answers to the coding agent’s recurring questions, so it can answer them for you next time.'
                    : 'Notes it saves from its work and reads on every mail. Off for a fresh outside view.'
                }
                on={p.memory !== false}
                onChange={(on) => setDraft({ ...p, memory: on ? undefined : false })}
              />
              {/* Only SAVED personas with a store: memory-off personas keep
                  none, and a never-saved draft has no id on the server yet. */}
              {saved && p.memory !== false && saved.memory !== false && (
                <PersonaNotes personaId={p.id} kind={p.harness ? 'answers' : 'memory'} />
              )}
              <ToggleRow
                title="Sees your memory"
                hint="Your facts, past chats and indexed folders. Off for a reviewer that should read cold."
                on={p.recall !== false}
                onChange={(on) => setDraft({ ...p, recall: on ? undefined : false })}
              />
              <ToggleRow
                title="Open to chats"
                hint="Offered in the chat composer on your other devices (the phone app)."
                on={p.clients === true}
                onChange={(on) => setDraft({ ...p, clients: on || undefined })}
              />
              <ToggleRow
                title="Can start helpers"
                hint="Starts named copies of your other personas for parts of a job. They keep no memory."
                on={p.canSpawn === true}
                onChange={(on) => setDraft({ ...p, canSpawn: on || undefined })}
              />
              <ToggleRow
                title="Uses every MCP server"
                hint="Off: pick which ones. The rest are hidden from it entirely. Helpers inherit the list."
                on={p.mcpServers === undefined}
                onChange={(on) => setDraft({ ...p, mcpServers: on ? undefined : [] })}
              />
              {p.mcpServers !== undefined && (
                <div className="persona-mcp">
                  {groupMcpServers(mcpServers, client).map((group) => (
                    <div key={group.head} className="persona-mcp-group">
                      <div className="persona-mcp-head">{group.head}</div>
                      {group.items.map((s) => (
                        <label key={s.name} className="persona-cap">
                          <input
                            type="checkbox"
                            checked={p.mcpServers?.includes(s.name) ?? false}
                            onChange={(e) => {
                              const rest = (p.mcpServers ?? []).filter((n) => n !== s.name);
                              setDraft({ ...p, mcpServers: e.target.checked ? [...rest, s.name] : rest });
                            }}
                          />
                          <span>
                            {s.name}
                            {!s.enabled && <span className="persona-mcp-note"> · switched off</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                  ))}
                  {/* Names the list carries that no configured server answers to any
                      more (removed, or renamed by re-adding). They do nothing at run
                      time; shown so they can be cleared rather than silently kept. */}
                  {(p.mcpServers ?? [])
                    .filter((n) => !mcpServers.some((s) => s.name === n))
                    .map((n) => (
                      <label key={`stale-${n}`} className="persona-cap persona-mcp-stale">
                        <input
                          type="checkbox"
                          checked
                          onChange={() => setDraft({ ...p, mcpServers: (p.mcpServers ?? []).filter((x) => x !== n) })}
                        />
                        <span>
                          {n} <span className="persona-mcp-note">· no longer configured</span>
                        </span>
                      </label>
                    ))}
                  {mcpServers.length === 0 && (p.mcpServers ?? []).length === 0 && (
                    <div className="persona-mcp-note">No MCP servers are configured yet.</div>
                  )}
                </div>
              )}
              <div className="ld-toggle">
                <span>
                  <strong>Send budget</strong>
                  <em>
                    Mails it may start between your sends. Its reply to whoever mailed it is always allowed.
                    Blank = unlimited.
                  </em>
                </span>
                <input
                  type="number"
                  className="vfield ld-num"
                  aria-label="Send budget per wave"
                  min={1}
                  max={100}
                  value={p.sendBudget ?? ''}
                  placeholder="∞"
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    setDraft({ ...p, sendBudget: Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : undefined });
                  }}
                />
              </div>
            </div>
          )}
        </div>
        <DetailFooter
          dirty={dirty}
          saving={savingId === p.id}
          onCancel={() => cancel(p.id)}
          onSave={() => save(p)}
        />
        {cwdPicker}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((p) => p.name.toLowerCase().includes(q) || rowLine(p).toLowerCase().includes(q)) : rows;

  return (
    <div className="ld-list">
      <ListHeader
        title="Personas"
        extra={
          <>
            <span className="beta-pill" title={BETA_TITLE}>
              Beta
            </span>{' '}
            <InfoTip label="About personas">
              Named configurations you can address mail to: a role prompt, and optionally a pinned model,
              a coding agent with its own working directory, or a computer to control. Duplicate one to
              make a variant.
            </InfoTip>
          </>
        }
        templates={[
          {
            key: 'assistant',
            icon: <MessageSquare size={12} />,
            label: 'Assistant',
            hint: 'A role prompt and, if you want, a model',
            onPick: () => add(undefined, 'assistant')
          },
          {
            key: 'code',
            icon: <Code size={12} />,
            tone: 'accent',
            label: 'Coding agent',
            hint: 'Claude or Codex working in one folder',
            onPick: () =>
              add({ harness: { agent: agents.includes('claude') ? 'claude' : agents[0] ?? 'claude', cwd: '' } }, 'code')
          },
          {
            key: 'computer',
            icon: <Monitor size={12} />,
            tone: 'warn',
            label: 'Computer control',
            hint: 'Uses the screen or the browser on a Mac',
            onPick: () => add(undefined, 'computer')
          }
        ]}
      />
      <ListSearch value={query} onChange={setQuery} placeholder="Find a persona" />
      {error && <p className="task-failed">{error}</p>}
      {KIND_GROUPS.map(({ kind, label }) => {
        const items = shown.filter((p) => kindOf(p) === kind);
        if (items.length === 0) return null;
        return (
          <ListGroup key={kind} label={label} count={items.length}>
            {items.map((p) => {
              const saved = personas.find((x) => x.id === p.id);
              const dirty = !saved || !sameEdit(p, saved);
              return (
                <ListRow
                  key={p.id}
                  glyph={<Glyph icon={<KindIcon kind={kind} />} tone={KIND_TONE[kind]} />}
                  name={p.name}
                  locked={p.builtin ? 'Built-in: can be edited, not deleted' : undefined}
                  sub={`${rowLine(p)}${dirty ? ' · unsaved' : ''}`}
                  right={rowFlags(p)}
                  onOpen={() => open(saved ?? p)}
                />
              );
            })}
          </ListGroup>
        );
      })}
      {shown.length === 0 && <p className="muted ld-empty">{q ? 'No persona matches.' : 'No personas yet.'}</p>}
      {cwdPicker}
    </div>
  );
}


// One listing per (agent, host) for the life of this window: a probe may
// cold-start the agent on that machine, so rows sharing a pin share the answer
// and Refresh is the only way to ask again.
const modelProbeCache = new Map<string, HarnessModelsResult>();

/**
 * The model a persona's pinned coding agent runs, chosen from what that agent
 * advertises ON THE PINNED HOST (a paired computer's Claude Code lists its
 * own lineup; the server's lists the server's). Empty = the agent's own
 * default there. Disabled until the row has an agent to ask.
 */
function HarnessModelSelect({
  pin,
  onChange
}: {
  pin: PersonaHarnessPin | undefined;
  onChange: (model: string | undefined) => void;
}) {
  const agent = pin?.agent.trim().toLowerCase() ?? '';
  const host = pin?.device?.trim() || 'server';
  const key = `${agent}\n${host}`;
  const [listing, setListing] = useState<HarnessModelsResult | 'loading' | null>(null);

  const probe = () => {
    setListing('loading');
    window.stem
      .listHarnessModels({ agent, host })
      .catch((e: unknown): HarnessModelsResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .then((res) => {
        if (res.ok) modelProbeCache.set(key, res);
        setListing(res);
      });
  };

  useEffect(() => {
    if (!agent) {
      setListing(null);
      return;
    }
    const cached = modelProbeCache.get(key);
    if (cached) setListing(cached);
    else probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- probe when the (agent, host) pair changes
  }, [key]);

  const listed = listing && listing !== 'loading' && listing.ok ? listing : null;
  // Claude Code advertises a literal "default" entry; that is the empty option.
  const offered = listed?.models.filter((id) => id !== 'default') ?? [];
  const current = pin?.model ?? '';
  return (
    <div className="persona-model">
      <select
        className="vfield"
        aria-label="Model the coding agent runs"
        value={current}
        disabled={!pin}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">{pin ? `${pin.agent}’s own default` : 'Agent’s own default'}</option>
        {current && !offered.includes(current) && (
          <option value={current}>{current} (not offered there)</option>
        )}
        {offered.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      {pin && (
        <div className="persona-model-hint">
          {listing === 'loading' && 'Asking which models it offers…'}
          {listed && (
            <>
              Models offered by {listed.agent} on {listed.hostLabel}.{' '}
              <button
                type="button"
                className="link-btn icon-only"
                data-label="Refresh"
                aria-label="Refresh the model list"
                onClick={probe}
              >
                <RefreshCw size={12} />
              </button>
            </>
          )}
          {listing && listing !== 'loading' && !listing.ok && (
            <>
              Could not list models: {listing.error}{' '}
              <button type="button" className="link-btn" onClick={probe}>
                Try again
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
