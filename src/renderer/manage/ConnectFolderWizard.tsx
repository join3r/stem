import { useEffect, useRef, useState } from 'react';
import { Code2, FileText, FolderPlus, FolderSearch, Laptop, Lock, NotebookPen, Server } from 'lucide-react';
import type { ConnectedFolder, ConnectedFolderKind, ConnectedFolderPatch } from '../../shared/types';
import { ServerFolderPicker } from './ServerFolderPicker';

// Connecting a folder, as a short walk instead of a "+" that drops the folder in
// with defaults and leaves its settings for later. Each setting decides
// something the user would otherwise find out the hard way — that Stem may
// edit the files, that a client's private vault went into memory, that search
// finds nothing because the folder was never indexed — so each one is asked,
// with its consequence spelled out, before anything is connected.
//
// Steps: Folder (where it lives on a remote setup, which folder, its name and
// what it holds, and what kind of folder it is) → Access (read-only or
// writable) → Memory (remember, index, learn facts). Picking a kind fills in the
// later steps with what suits it; every choice stays editable. Nothing reaches
// the server until the last step's Connect.

type Place = 'server' | 'client';
type LearnMode = NonNullable<ConnectedFolder['learnMode']>;

export interface Kind {
  value: ConnectedFolderKind;
  label: string;
  /** "Suggested for …" on the later steps. */
  noun: string;
  icon: React.ReactNode;
  body: string;
  notePlaceholder: string;
  settings: { writable: boolean; memorize: boolean; index: boolean; learnMode: LearnMode };
}

export const KINDS: Kind[] = [
  {
    value: 'notes',
    label: 'Notes vault',
    noun: 'a notes vault',
    icon: <NotebookPen size={13} />,
    body: 'Obsidian, Logseq, a folder of Markdown. Remembered, and Stem learns from every note, old and new.',
    notePlaceholder: 'e.g. “My Obsidian vault: meeting notes, project plans, reading notes”',
    settings: { writable: false, memorize: true, index: true, learnMode: 'all' }
  },
  {
    value: 'code',
    label: 'Code project',
    noun: 'a code project',
    icon: <Code2 size={13} />,
    body: 'A repository Stem works in. Writable, and nothing from it is remembered or learned.',
    notePlaceholder: 'e.g. “The billing service: TypeScript API and its tests”',
    settings: { writable: true, memorize: false, index: false, learnMode: 'off' }
  },
  {
    value: 'docs',
    label: 'Documents',
    noun: 'documents',
    icon: <FileText size={13} />,
    body: 'PDFs, contracts, manuals. Searchable, and remembered when they come up in a chat.',
    notePlaceholder: 'e.g. “Contracts, invoices and appliance manuals”',
    settings: { writable: false, memorize: true, index: true, learnMode: 'use' }
  },
  {
    value: 'private',
    label: 'Confidential',
    noun: 'confidential files',
    icon: <Lock size={13} />,
    body: 'A client’s files, medical or legal papers. Searchable, but nothing is kept.',
    notePlaceholder: 'e.g. “Acme Corp’s project files, under NDA”',
    settings: { writable: false, memorize: false, index: true, learnMode: 'off' }
  }
];

const STEPS = ['Folder', 'Access', 'Memory'] as const;

const LEARN_CHOICES: { value: LearnMode; label: string; hint: string }[] = [
  { value: 'use', label: 'On use', hint: 'Learns only from excerpts that come up in your chats. No extra model calls.' },
  {
    value: 'new',
    label: 'New & changed',
    hint: 'Also reads files added or edited from now on, in the background. Existing files are left alone.'
  },
  {
    value: 'all',
    label: 'Full history',
    hint: 'Reads every file already in the folder once it’s indexed, then keeps up with new and edited ones. About one model call per few pages, so a large folder costs many calls.'
  },
  { value: 'off', label: 'Off', hint: 'Never learns facts from this folder. Search still works.' }
];

/** The last path segment, whichever separator the folder's own computer uses. */
function baseName(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path;
}

export function ConnectFolderWizard({
  remote,
  existing,
  initialKind,
  onDone,
  onCancel
}: {
  /** The server is another machine: ask where the folder lives. */
  remote: boolean;
  /** Already connected folders, for the duplicate and name checks. */
  existing: ConnectedFolder[];
  /** A kind picked before the wizard opened (the tab's New menu): preselected, settings filled in. */
  initialKind?: ConnectedFolderKind;
  /** The fresh folder list and the new folder's id. */
  onDone: (folders: ConnectedFolder[], id: string) => void;
  onCancel: () => void;
}) {
  const preset = KINDS.find((k) => k.value === initialKind) ?? null;
  const [step, setStep] = useState(0);
  const [place, setPlace] = useState<Place>(remote ? 'client' : 'server');
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [writable, setWritable] = useState(preset?.settings.writable ?? false);
  const [memorize, setMemorize] = useState(preset?.settings.memorize ?? true);
  const [index, setIndex] = useState(preset?.settings.index ?? true);
  const [learnMode, setLearnMode] = useState<LearnMode>(preset?.settings.learnMode ?? 'use');
  const [kind, setKind] = useState<Kind | null>(preset);
  const [serverPicker, setServerPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cardRef.current?.focus();
  }, [step]);

  const choose = (picked: string) => {
    setPath(picked);
    setLabel(baseName(picked));
    setError(null);
  };

  const browse = async () => {
    // A folder on the server is browsed on the server; anything else (a local
    // install, or a folder on this computer) through the native dialog.
    if (remote && place === 'server') {
      setServerPicker(true);
      return;
    }
    const picked = await window.stem.pickDirectory();
    if (picked[0]) choose(picked[0]);
  };

  const pickKind = (k: Kind) => {
    setKind(k);
    setWritable(k.settings.writable);
    setMemorize(k.settings.memorize);
    setIndex(k.settings.index);
    setLearnMode(k.settings.learnMode);
  };

  const suggested = kind && <p className="muted folder-dialog-hint wizard-suggested">Suggested for {kind.noun}. Change anything.</p>;

  const name = label.trim();
  const absolute = /^([/\\~]|[A-Za-z]:[/\\])/.test(path.trim());
  const duplicatePath = existing.some((f) => (place === 'client' ? f.origin?.clientPath : f.path) === path);
  const nameTaken = existing.some((f) => f.label.toLowerCase() === name.toLowerCase());
  const folderProblem = !path.trim()
    ? null
    : !absolute
      ? 'Use the folder’s full path, starting with /.'
      : duplicatePath
      ? 'This folder is already connected.'
      : !name
        ? 'Give the folder a name.'
        : nameTaken
          ? `A connected folder is already called “${name}”.`
          : null;
  const canNext = step === 0 ? !!path.trim() && !folderProblem : true;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const before = new Set(existing.map((f) => f.id));
      const target = path.trim();
      const added =
        place === 'client' ? await window.stem.addClientFolders([target]) : await window.stem.addConnectedFolders([target]);
      const fresh = added.find((f) => !before.has(f.id));
      if (!fresh) throw new Error('This folder is already connected.');
      const patch: ConnectedFolderPatch = {
        mode: writable ? 'readwrite' : 'read',
        memorize,
        index,
        ...(index && memorize ? { learnMode } : {}),
        ...(name !== fresh.label ? { label: name } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(kind ? { kind: kind.value } : {})
      };
      onDone(await window.stem.updateConnectedFolder(fresh.id, patch), fresh.id);
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^(Error:\s*)?(Error invoking remote method '[^']+':\s*)?(Error:\s*)?/, ''));
      setBusy(false);
    }
  };

  const next = () => {
    if (!canNext) return;
    if (step < STEPS.length - 1) setStep(step + 1);
    else void connect();
  };

  if (serverPicker) {
    return (
      <ServerFolderPicker
        confirmLabel="Choose this folder"
        onConnect={(picked) => {
          setServerPicker(false);
          choose(picked);
        }}
        onClose={() => setServerPicker(false)}
      />
    );
  }

  const option = (selected: boolean, onPick: () => void, title: string, body: string, icon?: React.ReactNode) => (
    <button type="button" className={`cfolder-add-option wizard-option${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={onPick}>
      <strong>
        {icon}
        {title}
      </strong>
      <span className="muted">{body}</span>
    </button>
  );

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Connect a folder"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel();
      }}
    >
      <div className="mcp-approval-card folder-dialog cfolder-wizard" ref={cardRef} tabIndex={-1}>
        <div className="mcp-approval-head">
          <span className="row-icon">
            <FolderPlus size={15} />
          </span>
          <strong>Connect a folder</strong>
        </div>
        <ol className="wizard-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="wizard-step-num">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            {remote && (
              <div className="cfolder-add-choice">
                <span className="muted">Where does the folder live?</span>
                {option(
                  place === 'client',
                  () => {
                    if (place !== 'client') setPath('');
                    setPlace('client');
                  },
                  'On this computer',
                  'Mirrored one way up to the server, so Stem can read it when this computer is off.',
                  <Laptop size={13} />
                )}
                {option(
                  place === 'server',
                  () => {
                    if (place !== 'server') setPath('');
                    setPlace('server');
                  },
                  'On the server',
                  'A folder on the server’s own disk. Read in place.',
                  <Server size={13} />
                )}
              </div>
            )}
            <div className="folder-dialog-field">
              <span>Folder</span>
              <div className="wizard-path">
                <input
                  className="skill-approval-input"
                  aria-label="Folder path"
                  placeholder="Choose a folder, or paste its path"
                  spellCheck={false}
                  value={path}
                  onChange={(e) => {
                    const typed = e.target.value;
                    // Typing a path names the folder too, until the name is edited by hand.
                    if (!label || label === baseName(path)) setLabel(baseName(typed));
                    setPath(typed);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') next();
                  }}
                />
                <button type="button" className="icon-action sm" onClick={() => void browse()} title="Choose a folder" aria-label="Choose a folder">
                  <FolderSearch size={14} />
                </button>
              </div>
            </div>
            {absolute && (
              <>
                <label className="folder-dialog-field">
                  <span>Name</span>
                  <input
                    className="skill-approval-input"
                    aria-label="Folder name"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') next();
                    }}
                  />
                </label>
                <label className="folder-dialog-field">
                  <span>
                    What’s in it <em>optional</em>
                  </span>
                  <textarea
                    className="ci-textarea"
                    aria-label="What the folder holds"
                    rows={2}
                    placeholder={(kind ?? KINDS[0]).notePlaceholder}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <p className="muted folder-dialog-hint">Stem is told this, so it knows when the folder is worth a look.</p>
              </>
            )}
            {folderProblem && <p className="error folder-dialog-hint">{folderProblem}</p>}
            <div className="folder-dialog-field">
              <span>What kind of folder is it?</span>
              <div className="wizard-kinds">
                {KINDS.map((k) => (
                  <span key={k.value}>{option(kind?.value === k.value, () => pickKind(k), k.label, k.body, k.icon)}</span>
                ))}
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <div className="cfolder-add-choice">
            {suggested}
            <span className="muted">May Stem change the files in “{name}”?</span>
            {option(
              !writable,
              () => setWritable(false),
              'Read-only',
              'Stem reads and searches the files but cannot create, edit or delete anything. Best for notes, documents and anything you can’t afford to lose.'
            )}
            {option(
              writable,
              () => setWritable(true),
              'Writable',
              place === 'client'
                ? 'Stem may also edit files, by running commands on this computer. Changes reach the server’s copy at the next sync.'
                : 'Stem may also create, edit and delete files here. Best for a project folder you want it to work in.'
            )}
          </div>
        )}

        {step === 2 && (
          <>
            {suggested}
            <div className="cfolder-add-choice">
              <span className="muted">Should Stem remember what it reads here?</span>
              {option(
                memorize,
                () => setMemorize(true),
                'Remember',
                'What Stem reads can come back in later chats, like anything else it knows.'
              )}
              {option(
                !memorize,
                () => setMemorize(false),
                'Keep private',
                'Stem reads the files when asked but never keeps what it read. For a client’s files or anything confidential.'
              )}
            </div>
            <label className="set-check">
              <input type="checkbox" checked={index} onChange={(e) => setIndex(e.target.checked)} />
              Build a search index
            </label>
            <p className="muted folder-dialog-hint">
              Lets Stem search the folder’s text, PDF and Word files and bring up relevant notes on its own. A large
              folder takes a while to index the first time.
            </p>
            {index && memorize && (
              <label className="folder-dialog-field wizard-learn">
                <span>Learn facts from it</span>
                <select
                  className="ifield"
                  aria-label="Learn facts mode"
                  value={learnMode}
                  onChange={(e) => setLearnMode(e.target.value as LearnMode)}
                >
                  {LEARN_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <span className="muted">
                  {LEARN_CHOICES.find((c) => c.value === learnMode)?.hint}
                </span>
              </label>
            )}
          </>
        )}

        {error && <p className="error folder-dialog-hint">{error}</p>}
        <div className="mcp-approval-actions">
          <button type="button" className="push" disabled={busy} onClick={step === 0 ? onCancel : () => setStep(step - 1)}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          <button type="button" className="push default" disabled={!canNext || busy} onClick={next}>
            {step < STEPS.length - 1 ? 'Next' : busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
