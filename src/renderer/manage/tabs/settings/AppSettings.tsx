import { useEffect, useState } from 'react';
import type {
  CustomTheme,
  EscapeAction,
  ReleaseNotesSnapshot,
  TaskNotifyMode,
  UpdateStatus
} from '../../../../shared/types';
import { followsSystem } from '../../../../shared/theme';
import { ReleaseNotesModal } from '../../../ReleaseNotesModal';
import { InfoTip } from '../../../ui/InfoTip';
import { RowSelect, ValueRow } from './rows';
import { AutonomySections } from './AutonomySettings';

/**
 * Settings → App: the shell around the conversation — what the keyboard does,
 * how loudly Stem may interrupt, what the assistant may DO on your machines
 * (commands, coding agents), and which build this is. Everything about TALKING
 * to Stem (the main chat and the Quick Chat overlay alike) lives under Chat;
 * the split is "conversation vs shell" rather than "window vs window", and
 * autonomy sits here because one policy governs every conversation at once.
 *
 * Layout is the settings-row idiom (rows.tsx): one row per setting, current
 * value visible on the right, so the tab reads as an answer sheet.
 */
export function AppSettings() {
  return (
    <div>
      <AppearanceSection />
      <KeyboardSection />
      <NotificationsSection />
      <MailSection />
      <AutonomySections />
      <AboutSection />
    </div>
  );
}

/**
 * Which look this machine renders with: follow the OS, force light/dark, or a
 * custom theme — a JSON file of color-token overrides, either shipped with the
 * app or in this machine's themes folder (see desktop/themes.ts). Selecting
 * applies everywhere at once; the windows repaint off the `client:themeChanged`
 * push, and the same push arrives when a file in the folder changes, which is
 * when the list is re-read — there is no reload button because saving the file
 * is the reload.
 */
function AppearanceSection() {
  const [selected, setSelected] = useState('system');
  const [themes, setThemes] = useState<CustomTheme[]>([]);

  useEffect(() => {
    void window.stem.getSettings().then((s) => setSelected(s.theme.selected));
    void window.stem.listThemes().then(setThemes);
    return window.stem.onThemeChanged((state) => {
      setSelected(state.selected);
      void window.stem.listThemes().then(setThemes);
    });
  }, []);

  function select(value: string) {
    setSelected(value); // optimistic; persist + reconcile from the saved settings
    window.stem.updateThemeSettings({ selected: value }).then((s) => setSelected(s.theme.selected));
  }

  const describe = (t: CustomTheme): string => {
    if (t.problem) return t.problem;
    const where = t.source === 'bundled' ? 'Shipped with Stem' : `Your theme (${t.id}.json)`;
    return followsSystem(t) ? `${where} — light and dark, follows the OS` : where;
  };
  const options = [
    { value: 'system', label: 'System', title: 'Follow the OS appearance' },
    { value: 'light', label: 'Light', title: 'The built-in light palette, whatever the OS says' },
    { value: 'dark', label: 'Dark', title: 'The built-in dark palette, whatever the OS says' },
    ...themes.map((t) => ({
      value: `custom:${t.id}`,
      label: t.problem ? `${t.name} — broken` : t.name,
      title: describe(t)
    }))
  ];
  // A choice whose file is gone still has to show as chosen, or the select goes
  // blank; it reads as what it is until the user picks something else.
  if (!options.some((o) => o.value === selected)) {
    options.push({ value: selected, label: `${selected.replace(/^custom:/, '')} — missing`, title: 'This theme file is gone from the themes folder' });
  }

  return (
    <>
      <div className="grp-head">Appearance</div>
      <div className="group">
        <ValueRow
          label={
            <>
              Theme{' '}
              <InfoTip label="About themes">
                <strong>System</strong> follows the OS appearance. The other themes are small JSON
                files of colors: some ship with Stem, and any you put in the themes folder are
                listed too — open it below and copy <strong>_example.json</strong> to start one.
                Changes to a file show up as soon as you save it.
              </InfoTip>
            </>
          }
        >
          <RowSelect ariaLabel="Theme" value={selected} options={options} onChange={select} />
        </ValueRow>
        <ValueRow label={<span />}>
          <button
            className="link-btn"
            onClick={() => void window.stem.revealThemesFolder()}
            title="Open the themes folder in the file manager"
          >
            Open themes folder
          </button>
        </ValueRow>
      </div>
    </>
  );
}

/** What the Escape key does mid-reply. One setting, but a loaded one. */
function KeyboardSection() {
  const [escapeAction, setEscapeAction] = useState<EscapeAction>('off');

  useEffect(() => {
    void window.stem.getSettings().then((s) => setEscapeAction(s.escapeAction));
  }, []);

  function selectEscapeAction(action: EscapeAction) {
    setEscapeAction(action); // optimistic; persist + reconcile from the saved settings
    // Notify the main window's composer (App) so the new mode applies immediately,
    // without waiting for a window focus cycle.
    window.dispatchEvent(new CustomEvent('stem:escape-action', { detail: action }));
    window.stem.updateEscapeAction(action).then((s) => setEscapeAction(s.escapeAction));
  }

  return (
    <>
      <div className="grp-head">Keyboard</div>
      <div className="group">
        <ValueRow
          label={
            <>
              Escape while streaming{' '}
              <InfoTip label="What Escape does while streaming">
                While a reply is streaming, Escape can stop it and return your just-sent message to
                the composer to edit — as if you never sent it. <strong>Single</strong> does both on
                one press; <strong>Two-stage</strong> stops first and retracts on a second press.
              </InfoTip>
            </>
          }
        >
          <RowSelect
            ariaLabel="Escape while streaming"
            value={escapeAction}
            options={[
              { value: 'off', label: 'Off', title: 'Escape does nothing in the composer' },
              { value: 'single', label: 'Single', title: 'One Escape stops the turn and pulls your message back' },
              { value: 'twoStage', label: 'Two-stage', title: 'First Escape stops; a second retracts your message' }
            ]}
            onChange={(v) => selectEscapeAction(v as EscapeAction)}
          />
        </ValueRow>
      </div>
    </>
  );
}

/** How loudly a scheduled run is allowed to reach you when it finds something. */
function NotificationsSection() {
  const [notify, setNotify] = useState<TaskNotifyMode>('alert');

  useEffect(() => {
    void window.stem.getSettings().then((s) => setNotify(s.tasks.notify));
  }, []);

  function select(mode: TaskNotifyMode) {
    setNotify(mode); // optimistic; persist + reconcile from the saved settings
    window.stem.updateTasksSettings({ notify: mode }).then((s) => setNotify(s.tasks.notify));
  }

  return (
    <>
      <div className="grp-head">Notifications</div>
      <div className="group">
        <ValueRow
          label="Scheduled tasks"
          hint={
            <>
              The chat always waits unread in your Inbox — this only sets how much it interrupts{' '}
              <InfoTip label="How scheduled tasks reach you">
                A scheduled run only speaks up when it found what it was watching for.{' '}
                <strong>Pop-up</strong> brings Stem to the front and shows the message in a dialog.{' '}
                <strong>Nudge</strong> bounces the dock and leaves it at that. <strong>Inbox only</strong>{' '}
                does nothing at all while you work.
              </InfoTip>
            </>
          }
        >
          <RowSelect
            ariaLabel="Scheduled task notifications"
            value={notify}
            options={[
              { value: 'alert', label: 'Pop-up', title: 'Bring Stem to the front and show the message' },
              { value: 'nudge', label: 'Nudge', title: "Bounce the dock (flash the taskbar), but don't take focus" },
              { value: 'inbox', label: 'Inbox only', title: "Don't interrupt — the chat just goes unread" }
            ]}
            onChange={(v) => select(v as TaskNotifyMode)}
          />
        </ValueRow>
      </div>
    </>
  );
}

/** The one mail guard rail: how far personas may talk among themselves per wave. */
function MailSection() {
  const [cap, setCap] = useState(10);

  useEffect(() => {
    void window.stem.getSettings().then((s) => setCap(s.mail.exchangeCap));
  }, []);

  function select(value: number) {
    setCap(value); // optimistic; persist + reconcile from the saved settings
    window.stem.updateMailSettings({ exchangeCap: value }).then((s) => setCap(s.mail.exchangeCap));
  }

  const options = [5, 10, 20, 50].map((n) => ({
    value: String(n),
    label: String(n),
    title: `${n} inter-persona mails per wave`
  }));
  // A hand-edited settings file may hold a value off the menu — show it as-is
  // rather than letting the select go blank.
  if (!options.some((o) => o.value === String(cap))) {
    options.push({ value: String(cap), label: String(cap), title: 'Set outside this menu' });
  }

  return (
    <>
      <div className="grp-head">Mail</div>
      <div className="group">
        <ValueRow
          label="Persona exchange limit"
          hint={
            <>
              Mails personas may send each other per wave{' '}
              <InfoTip label="About the exchange limit">
                When a mail conversation has several personas, they consult each other by mail. Each
                mail you send resets this budget; when a wave of persona-to-persona mail uses it up,
                the next reply is forced back to you instead of looping on.
              </InfoTip>
            </>
          }
        >
          <RowSelect
            ariaLabel="Persona exchange limit"
            value={String(cap)}
            options={options}
            onChange={(v) => select(Number(v))}
          />
        </ValueRow>
      </div>
    </>
  );
}

/**
 * Settings → App → About: which build this is, and the "what's new" popup that rides
 * on it. Also the only place the version is shown at all, which is what you want
 * a user to read back to you when they report something.
 */
/** What the Updates row says about where the updater stands. */
function updateLine(u: UpdateStatus): string {
  switch (u.state) {
    case 'checking':
      return 'Checking…';
    case 'downloading':
      return `Downloading Stem ${u.available}…`;
    case 'ready':
      return `Stem ${u.available} is downloaded — it installs when you restart`;
    case 'error':
      return `The last check didn't get through — it'll try again later`;
    default:
      if (u.available) return `Stem ${u.available} is available`;
      return u.checkedAt ? "You're up to date" : 'Not checked yet';
  }
}

function AboutSection() {
  const [notes, setNotes] = useState<ReleaseNotesSnapshot | null>(null);
  const [showOnUpdate, setShowOnUpdate] = useState(true);
  const [open, setOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checkAuto, setCheckAuto] = useState(true);

  useEffect(() => {
    void window.stem.getReleaseNotes().then(setNotes);
    void window.stem.getSettings().then((s) => {
      setShowOnUpdate(s.releaseNotes.showOnUpdate);
      setCheckAuto(s.updates.checkAutomatically);
    });
    void window.stem.getUpdateStatus().then(setUpdate);
    return window.stem.onUpdateStatus(setUpdate);
  }, []);

  function toggle() {
    const next = !showOnUpdate;
    setShowOnUpdate(next); // optimistic; reconcile from the saved settings
    window.stem.updateReleaseNotesSettings({ showOnUpdate: next }).then((s) =>
      setShowOnUpdate(s.releaseNotes.showOnUpdate)
    );
  }

  function toggleCheckAuto() {
    const next = !checkAuto;
    setCheckAuto(next); // optimistic; reconcile from the saved settings
    window.stem.updateUpdatesSettings({ checkAutomatically: next }).then((s) =>
      setCheckAuto(s.updates.checkAutomatically)
    );
  }

  // `none` is a dev run or a test — there is nothing a release could replace,
  // so the whole updates block stays out of the pane.
  const updatable = update !== null && update.mode !== 'none';
  const busy = update?.state === 'checking' || update?.state === 'downloading';

  return (
    <>
      <div className="grp-head">About</div>
      <div className="group">
        <ValueRow
          label={<strong>Stem {notes?.appVersion ?? '—'}</strong>}
          hint={updatable ? updateLine(update) : 'The version you’re running'}
        >
          {updatable &&
            (update.state === 'ready' ? (
              <button className="retrieval-test-btn" onClick={() => void window.stem.installUpdate()}>
                Restart now
              </button>
            ) : update.available && update.mode === 'manual' ? (
              <button
                className="retrieval-test-btn"
                onClick={() => void window.stem.installUpdate()}
                title="Open the release page to download it"
              >
                Get the update
              </button>
            ) : (
              <button
                className="retrieval-test-btn"
                onClick={() => void window.stem.checkForUpdates()}
                disabled={busy}
              >
                Check now
              </button>
            ))}
        </ValueRow>

        {updatable && (
          <ValueRow
            label="Check for updates automatically"
            hint={
              update.mode === 'auto'
                ? 'New releases download in the background and install on the next restart'
                : "A few times a day; you'll be told here and pointed at the download"
            }
          >
            <button
              className={`switch${checkAuto ? ' on' : ''}`}
              role="switch"
              aria-checked={checkAuto}
              aria-label="Check for updates automatically"
              onClick={toggleCheckAuto}
            />
          </ValueRow>
        )}

        <ValueRow
          label="Show what's new after an update"
          hint="Open the release notes once, the first time you run a new version"
        >
          <button
            className={`switch${showOnUpdate ? ' on' : ''}`}
            role="switch"
            aria-checked={showOnUpdate}
            aria-label="Show what's new after an update"
            onClick={toggle}
          />
        </ValueRow>

        <ValueRow label={<span />}>
          <button className="link-btn" onClick={() => setOpen(true)} disabled={!notes}>
            View release notes
          </button>
        </ValueRow>
      </div>
      {open && notes && (
        <ReleaseNotesModal title="Release notes" entries={notes.entries} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
