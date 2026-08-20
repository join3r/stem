import { useEffect, useRef, useState } from 'react';
import { X, Check, Copy, TriangleAlert } from 'lucide-react';
import type {
  CustomInstructionsSettings,
  EscapeAction,
  ModelSummary,
  ReleaseNotesSnapshot,
  TaskNotifyMode,
  UpdateStatus,
  WebSearchSettings,
  QuickChatSettings,
  QuickChatShortcutStatus
} from '../../../../shared/types';
import { appDefaultModel } from '../../../../shared/modelRoles';
import { ReleaseNotesModal } from '../../../ReleaseNotesModal';
import { InfoTip } from '../../../ui/InfoTip';
import { ModelPicker } from '../../../ui/ModelPicker';
import { EFFORT_LABELS } from '../../../modelLabels';
import { broadcastWebSearch } from '../../../webSearch';
import { ShortcutRecorder } from './shortcut';

// Inactivity presets for starting a fresh Quick Chat thread on re-summon.
// 0 = never (always continue the current session).
const NEW_THREAD_PRESETS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 }
];

/**
 * Settings → App: the parts of Stem that aren't the conversation — what the
 * keyboard does, the overlay that floats over everything else, and which build
 * this is.
 */
export function AppSettings({ models }: { models: ModelSummary[] }) {
  return (
    <div>
      <InputSection />
      <NotificationsSection />
      <QuickChatSection models={models} />
      <AboutSection />
    </div>
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
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            When a scheduled task has something to say{' '}
            <InfoTip label="How scheduled tasks reach you">
              A scheduled run only speaks up when it found what it was watching for.{' '}
              <strong>Pop-up</strong> brings Stem to the front and shows the message in a dialog.{' '}
              <strong>Nudge</strong> bounces the dock and leaves it at that. <strong>Inbox only</strong>{' '}
              does nothing at all while you work. In every case the chat shows up unread in your
              Inbox, so nothing is ever lost — the choice is only how much it interrupts.
            </InfoTip>
          </span>
          <div className="seg-ctl">
            <button
              className={notify === 'alert' ? 'active' : ''}
              onClick={() => select('alert')}
              title="Bring Stem to the front and show the message in a dialog"
            >
              Pop-up
            </button>
            <button
              className={notify === 'nudge' ? 'active' : ''}
              onClick={() => select('nudge')}
              title="Bounce the dock (flash the taskbar), but don't take focus"
            >
              Nudge
            </button>
            <button
              className={notify === 'inbox' ? 'active' : ''}
              onClick={() => select('inbox')}
              title="Don't interrupt — the chat just goes unread in the Inbox"
            >
              Inbox only
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** What the Escape key does mid-reply. One setting, but a loaded one. */
function InputSection() {
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
      <div className="grp-head">Input</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Escape key{' '}
            <InfoTip label="What Escape does while streaming">
              While a reply is streaming, Escape can stop it and return your just-sent message to
              the composer to edit — as if you never sent it.
            </InfoTip>
          </span>
          <div className="seg-ctl">
            <button
              className={escapeAction === 'off' ? 'active' : ''}
              onClick={() => selectEscapeAction('off')}
              title="Escape does nothing in the composer"
            >
              Off
            </button>
            <button
              className={escapeAction === 'single' ? 'active' : ''}
              onClick={() => selectEscapeAction('single')}
              title="One Escape stops the turn and pulls your message back into the composer"
            >
              Single
            </button>
            <button
              className={escapeAction === 'twoStage' ? 'active' : ''}
              onClick={() => selectEscapeAction('twoStage')}
              title="First Escape stops the turn; a second Escape retracts your message"
            >
              Two-stage
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The overlay you summon from anywhere: its key, its model defaults, and the
 * instructions layered on top of your main ones while you are in it.
 */
function QuickChatSection({ models }: { models: ModelSummary[] }) {
  const [qc, setQc] = useState<QuickChatSettings | null>(null);
  const [ws, setWs] = useState<WebSearchSettings>({
    main: true,
    quickChat: true,
    provider: 'auto',
    credentials: {}
  });
  const [ci, setCi] = useState<CustomInstructionsSettings>({ main: '', quickChat: '' });
  const [shortcutStatus, setShortcutStatus] = useState<QuickChatShortcutStatus | null>(null);
  const [copiedSummon, setCopiedSummon] = useState(false);
  // Per-field debounce so typing doesn't spam the atomic settings writer.
  const ciQuickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The Quick Chat overlay carries the same switch on its own bar — a different
  // window, so no in-window event reaches here. Re-read the flags whenever this
  // window comes forward, which is the first moment the stale box could be seen.
  useEffect(() => {
    const reload = () =>
      void window.stem
        .getSettings()
        .then((s) => setWs(s.webSearch))
        .catch(() => undefined);
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, []);

  useEffect(() => {
    void window.stem.getSettings().then((s) => {
      setQc(s.quickChat);
      setWs(s.webSearch);
      setCi(s.customInstructions);
    });
    void window.stem.getQuickChatShortcutStatus().then(setShortcutStatus);
  }, []);

  function update(patch: Partial<QuickChatSettings>) {
    window.stem.updateQuickChat(patch).then((s) => setQc(s.quickChat));
  }

  /** Re-bind, then re-read whether the OS actually granted the new accelerator. */
  function updateShortcut(accel: string | null) {
    window.stem.updateQuickChat({ shortcut: accel }).then(async (s) => {
      setQc(s.quickChat);
      setShortcutStatus(await window.stem.getQuickChatShortcutStatus());
    });
  }

  function copySummonCommand() {
    if (!shortcutStatus) return;
    void navigator.clipboard.writeText(shortcutStatus.summonCommand).then(() => {
      setCopiedSummon(true);
      setTimeout(() => setCopiedSummon(false), 1600);
    });
  }

  function updateWebSearch(patch: Partial<WebSearchSettings>) {
    setWs((cur) => ({ ...cur, ...patch })); // optimistic; reconcile below
    window.stem.updateWebSearch(patch).then((s) => {
      setWs(s.webSearch);
      broadcastWebSearch(s.webSearch);
    });
  }

  function saveCiQuick(value: string) {
    setCi((c) => ({ ...c, quickChat: value }));
    if (ciQuickTimer.current) clearTimeout(ciQuickTimer.current);
    ciQuickTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ quickChat: value }), 400);
  }

  if (!qc) return <p className="muted">Loading…</p>;

  // The Quick Chat default-effort options follow the chosen default model's capabilities.
  // "Same as main" (empty) has no concrete model here, so offer all levels.
  const qcModel = qc.defaultModel ? models.find((m) => m.id === qc.defaultModel) : undefined;
  const qcEfforts = qcModel?.supportedEfforts.length ? qcModel.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
  // Only models with a priority (Fast) tier can default to Fast. With no concrete model
  // ("Same as main"), offer it — the runtime ignores Fast on models that don't support it.
  const qcFastTier = qcModel?.serviceTiers.find((t) => t.id === 'priority');
  const qcHasFast = qcModel ? !!qcFastTier : true;

  // Switch the default model, clamping a now-unsupported saved effort/speed into range.
  function selectQcModel(id: string | null) {
    const m = id ? models.find((x) => x.id === id) : undefined;
    const efforts = m?.supportedEfforts.length ? m.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
    const patch: Partial<QuickChatSettings> = { defaultModel: id };
    if (qc && !efforts.includes(qc.defaultEffort)) patch.defaultEffort = m?.defaultEffort ?? efforts[0];
    // Drop a saved Fast default when the new model has no priority tier.
    if (qc?.defaultServiceTier === 'priority' && m && !m.serviceTiers.some((t) => t.id === 'priority')) {
      patch.defaultServiceTier = null;
    }
    update(patch);
  }

  return (
    <>
      <div className="grp-head">Quick Chat</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Global shortcut</strong>
            <em>Summon the quick-chat overlay from anywhere</em>
          </span>
          <ShortcutRecorder value={qc.shortcut} onChange={updateShortcut} />
        </div>
        {/* The recorder can't tell whether the key is live: the grab happens in the OS.
            Main reports that back, so a shortcut that will never fire says so here
            instead of looking configured and doing nothing. */}
        {qc.shortcut && shortcutStatus && !shortcutStatus.registered && (
          <div className="set-block">
            <span className="retrieval-test-status err">
              <X size={12} />
              The system refused this combination — another app is probably holding it. Record a
              different one.
            </span>
          </div>
        )}
        {/* A granted grab is not the same as a delivered key: most Linux desktops keep
            Super for themselves and swallow it before Stem sees it. */}
        {window.stem.platform === 'linux' &&
          !shortcutStatus?.wayland &&
          qc.shortcut?.includes('Super') &&
          shortcutStatus?.registered && (
            <div className="set-block">
              <span className="set-sub">
                Most Linux desktops reserve the Super key for themselves. If nothing happens when
                you press this, record a combination with Ctrl or Alt instead.
              </span>
            </div>
          )}
        {shortcutStatus?.wayland && (
          <div className="set-block fg-divider">
            <p className="pair-warn">
              <TriangleAlert size={13} />
              <span>
                This is a Wayland session, where an app can't grab a key for itself — the
                shortcut above stays silent no matter what you record. Add a custom keyboard
                shortcut in your system settings that runs this command instead:
              </span>
            </p>
            <code className="pair-cmd">{shortcutStatus.summonCommand}</code>
            <div className="pair-actions">
              <button
                className="retrieval-test-btn"
                onClick={copySummonCommand}
                title="Copy the summon command"
              >
                <Copy size={14} />
                <span>Copy command</span>
              </button>
              {copiedSummon && (
                <span className="retrieval-test-status ok">
                  <Check size={12} />
                  Copied
                </span>
              )}
            </div>
          </div>
        )}

        <div className="set-block">
          <span className="set-sub">Default model</span>
          <ModelPicker
            models={models}
            value={qc.defaultModel}
            onChange={selectQcModel}
            emptyLabel="Same as main"
            ariaLabel="Quick Chat default model"
            resolvedDefault={appDefaultModel(models)}
          />
          <label className="set-check" title="Search the live web for current info, with citations">
            <input
              type="checkbox"
              checked={ws.quickChat}
              onChange={(e) => updateWebSearch({ quickChat: e.target.checked })}
            />
            Web search
          </label>
        </div>

        <div className="set-block">
          <span className="set-sub">Default effort</span>
          <div className="seg-ctl">
            {qcEfforts.map((e) => (
              <button key={e} className={qc.defaultEffort === e ? 'active' : ''} onClick={() => update({ defaultEffort: e })}>
                {EFFORT_LABELS[e] ?? e}
              </button>
            ))}
          </div>
        </div>

        {qcHasFast && (
          <div className="set-block">
            <span className="set-sub">Default speed</span>
            <div className="seg-ctl">
              <button
                className={qc.defaultServiceTier === 'priority' ? '' : 'active'}
                onClick={() => update({ defaultServiceTier: null })}
              >
                Standard
              </button>
              <button
                className={qc.defaultServiceTier === 'priority' ? 'active' : ''}
                onClick={() => update({ defaultServiceTier: 'priority' })}
                title={qcFastTier?.description ?? '1.5× speed, increased usage'}
              >
                Fast
              </button>
            </div>
          </div>
        )}

        <div className="set-row">
          <span className="set-label">
            <strong>Show on all displays</strong>
            <em>Float above every Space &amp; the active display</em>
          </span>
          <button
            className={`switch${qc.showOnAllDisplays ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.showOnAllDisplays}
            aria-label="Show on all displays"
            onClick={() => update({ showOnAllDisplays: !qc.showOnAllDisplays })}
          />
        </div>

        <div className="set-row">
          <span className="set-label">
            <strong>Show progress on other Spaces</strong>
            <em>Float the progress pill when the main window loses focus &amp; a thread is running</em>
          </span>
          <button
            className={`switch${qc.followAcrossSpaces ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.followAcrossSpaces}
            aria-label="Show progress on other Spaces"
            onClick={() => update({ followAcrossSpaces: !qc.followAcrossSpaces })}
          />
        </div>

        <div className="set-row">
          <span className="set-label">
            <strong>Sound when finished</strong>
            <em>Play a chime when a turn finishes while the progress pill is visible</em>
          </span>
          <button
            className={`switch${qc.finishSound ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.finishSound}
            aria-label="Sound when finished"
            onClick={() => update({ finishSound: !qc.finishSound })}
          />
        </div>

        <div className="set-row">
          <span className="set-label">
            <strong>Skip the Inbox</strong>
            <em>Quick chats go straight to Archived once answered — opening one in Stem brings it back</em>
          </span>
          <button
            className={`switch${qc.skipInbox ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.skipInbox}
            aria-label="Skip the Inbox"
            onClick={() => update({ skipInbox: !qc.skipInbox })}
          />
        </div>

        <div className="set-block">
          <span className="set-sub">New thread after idle</span>
          <div className="seg-ctl">
            {NEW_THREAD_PRESETS.map((p) => (
              <button
                key={p.label}
                className={qc.newThreadTimeoutMs === p.ms ? 'active' : ''}
                onClick={() => update({ newThreadTimeoutMs: p.ms })}
                title="Re-summoning the overlay after this idle time starts a fresh thread"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="set-block">
          <span className="set-sub">Extra instructions</span>
          <textarea
            className="ci-textarea"
            value={ci.quickChat}
            onChange={(e) => saveCiQuick(e.target.value)}
            rows={4}
            placeholder="e.g. Be even more terse here — one or two sentences."
          />
          <p className="muted">Layered on top of your main custom instructions, only in the Quick Chat overlay.</p>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 'var(--sp-5)' }}>
        Press the shortcut to open the overlay; Escape or the shortcut again hides it.
      </p>
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
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Stem {notes?.appVersion ?? '—'}</strong>
            <em>The version you're running</em>
          </span>
        </div>

        {updatable && (
          <>
            <div className="set-row">
              <span className="set-label">
                <strong>Updates</strong>
                <em>{updateLine(update)}</em>
              </span>
              {update.state === 'ready' ? (
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
              )}
            </div>

            <div className="set-row">
              <span className="set-label">
                <strong>Check for updates automatically</strong>
                <em>
                  {update.mode === 'auto'
                    ? 'New releases download in the background and install on the next restart'
                    : "A few times a day; you'll be told here and pointed at the download"}
                </em>
              </span>
              <button
                className={`switch${checkAuto ? ' on' : ''}`}
                role="switch"
                aria-checked={checkAuto}
                aria-label="Check for updates automatically"
                onClick={toggleCheckAuto}
              />
            </div>
          </>
        )}

        <div className="set-row">
          <span className="set-label">
            <strong>Show what's new after an update</strong>
            <em>Open the release notes once, the first time you run a new version</em>
          </span>
          <button
            className={`switch${showOnUpdate ? ' on' : ''}`}
            role="switch"
            aria-checked={showOnUpdate}
            aria-label="Show what's new after an update"
            onClick={toggle}
          />
        </div>

        <div className="memory-view-actions">
          <button className="link-btn" onClick={() => setOpen(true)} disabled={!notes}>
            View release notes
          </button>
        </div>
      </div>
      {open && notes && (
        <ReleaseNotesModal title="Release notes" entries={notes.entries} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
